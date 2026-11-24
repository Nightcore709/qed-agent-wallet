/**
 * Discovery to escrow, in the browser (R13, audit item E4): two fresh households, each with its own wallet owned by its
 * own passkey. The client publishes a request in the work directory; the provider finds it there and quotes; the client
 * compares the quotes (two of them simulated, labelled as workspaces beyond this installation, which cannot be chosen)
 * and chooses the provider's. The job then appears on the provider's side under the work paid through the escrow: the
 * provider offers it with its passkey, and the client funds it from its own wallet into the escrow on the chain. The
 * escrow's job is read back from the chain at the price the client chose.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { query } from '../support/stack.ts'
import { household, railGet, shot } from '../support/vault.ts'

async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await shot(page, `directory-sheet-${Date.now()}`)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/**
 * WCAG 2.0 to 2.2 A and AA over one section. With reduced motion nothing waits to arrive (DESIGN.md M5), so no block is
 * measured halfway through its arrival out of blur: a block scrolled into view by a fill arrives then, and axe once
 * read a button mid-arrival as low contrast (directory journey, second run, 24 Nov).
 */
async function accessible(page: Page, selector: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test('discovery to escrow: a request published in the directory, quotes compared (the simulated ones labelled and not choosable), one chosen; the provider offers the job with its passkey and the client funds it into the escrow on the chain', async ({ browser }) => {
  test.setTimeout(360_000)
  const C = await household(browser), P = await household(browser)
  const errors: string[] = []
  for (const x of [P, C]) x.page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const [client] = query<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', C.personId)
  const [provider] = query<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', P.personId)
  const TITLE = 'Lowest-risk sleeve, two funds'

  // 1 · the client publishes a request: the work, its budget and its delivery time
  await C.page.goto('/earn')
  const cdir = C.page.getByRole('region', { name: 'Find work, or someone to do it' })
  await expect(cdir.getByText('Some of this is simulated', { exact: true })).toBeVisible({ timeout: 30_000 })
  await cdir.getByRole('button', { name: 'Publish an offer or a request' }).click()
  const form = cdir.getByRole('form', { name: 'Publish in the directory' })
  await form.getByLabel('The work, in a few words').fill(TITLE)
  await form.getByLabel('Asset 1').fill('Gilt fund')
  await form.getByLabel('Yearly swing, %').nth(0).fill('6')
  await form.getByLabel('Asset 2').fill('Equity fund')
  await form.getByLabel('Yearly swing, %').nth(1).fill('18')
  await form.getByLabel('Your budget').fill('300')
  await form.getByLabel('Delivery within, hours').fill('24')
  await accessible(C.page, 'section.er-dir')
  await form.getByRole('button', { name: 'Publish it' }).click()
  const mine = cdir.getByRole('article', { name: TITLE })
  await expect(mine.getByText('Your request: Open')).toBeVisible({ timeout: 20_000 })
  // the two simulated quotes: labelled, and never offered as a choice
  await expect(mine.getByText('Simulated', { exact: true })).toHaveCount(2)
  await expect(mine.getByText('Cannot be chosen', { exact: true })).toHaveCount(2)
  await expect(mine.getByRole('button', { name: /^Choose / })).toHaveCount(0)

  // 2 · the provider finds it in the directory, by the client's handle, and quotes; it signs nothing and nothing moves
  await P.page.goto('/earn')
  const pdir = P.page.getByRole('region', { name: 'Find work, or someone to do it' })
  const listing = pdir.getByRole('article', { name: TITLE })
  await expect(listing.getByText(`@${client!.handle}`, { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(listing.getByText(client!.display_name, { exact: false })).toHaveCount(0) // the handle only (RISK-071)
  // the simulated listings are labelled and cannot be acted on
  const simulated = pdir.getByRole('article').filter({ hasText: 'Another QED installation (simulated)' })
  expect(await simulated.count()).toBeGreaterThanOrEqual(3)
  await expect(simulated.getByRole('button')).toHaveCount(0)
  await listing.getByRole('button', { name: 'Send a quote' }).click()
  const qf = listing.getByRole('form', { name: `Quote on ${TITLE}` })
  await qf.getByLabel('Your price').fill('275.50')
  await qf.getByLabel('Deliver within, hours').fill('12')
  await qf.getByLabel('A note for them').fill('Certified weights within half a day.')
  await qf.getByRole('button', { name: 'Send the quote' }).click()
  await expect(listing.getByText('You quoted ₹275.50, within 12 hours.', { exact: false })).toBeVisible({ timeout: 20_000 })
  await shot(P.page, 'directory-quoted')

  // 3 · the client compares the quotes and chooses the provider's
  await C.page.reload()
  const quotes = mine.getByRole('list', { name: `Quotes on ${TITLE}` })
  await expect(quotes.getByRole('listitem')).toHaveCount(3, { timeout: 30_000 })
  await expect(quotes.getByText(`₹275.50, within 12 hours, from @${provider!.handle}`, { exact: false })).toBeVisible()
  await shot(C.page, 'directory-compare')
  await mine.getByRole('button', { name: `Choose @${provider!.handle}'s quote` }).click()
  await expect(mine.getByText(`You chose @${provider!.handle}'s quote.`, { exact: false })).toBeVisible({ timeout: 20_000 })
  await expect(mine.getByText('Your request: Closed')).toBeVisible()
  const [job] = query<{ id: string; user_id: string; client: string }>(`SELECT id, user_id, client FROM earn_jobs WHERE user_id = ? AND title = ?`, P.personId, TITLE)
  expect(job).toMatchObject({ user_id: P.personId, client: `@${client!.handle}` })
  expect(query<{ amount: number; state: string }>('SELECT amount, state FROM earn_milestones WHERE job_id = ?', job!.id)).toEqual([{ amount: 27550, state: 'chain-draft' }])

  // 4 · the job is on the provider's side: its passkey signs the offer; nothing moves
  await P.page.reload()
  const pwork = P.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  const pjob = pwork.getByRole('article', { name: TITLE })
  await expect(pjob.getByText('Not offered yet', { exact: true })).toBeVisible({ timeout: 30_000 })
  await pjob.getByRole('button', { name: `Offer it to @${client!.handle}` }).click()
  await approveHere(P.page, /The offer above/)
  await expect(pjob.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })

  // 5 · the client funds it from its own wallet: the escrow on the chain holds the chosen price
  await C.page.reload()
  const cjob = C.page.getByRole('region', { name: 'Work paid through escrow on the chain' }).getByRole('article', { name: TITLE })
  await cjob.getByRole('button', { name: 'Fund it from your wallet' }).click()
  await approveHere(C.page, /withdraw.*approve.*ProofEscrow\.open/)
  await expect(cjob.getByText('In escrow', { exact: true })).toBeVisible({ timeout: 60_000 })
  const jobs = (await railGet(`/workspaces/${C.railId}/escrow/jobs`)).jobs as { status: string; price: string; roles: string[] }[]
  expect(jobs.map((j) => [j.status, j.price, j.roles])).toEqual([['open', '27550', ['client']]])
  await shot(C.page, 'directory-funded')
  await accessible(C.page, 'section.er-dir')
  expect(errors).toEqual([])
})
