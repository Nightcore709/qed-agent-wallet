/**
 * Earning on the chain, in the browser (R7-054): two fresh households, each with its own wallet owned by its own
 * passkey. The provider prepares a job for the client on the Earn page and offers it (its passkey signs the quote);
 * the client funds it from its own wallet (its passkey signs one transaction: withdraw, approve, open); the provider
 * delivers the certified work, which the verifier on the chain checks before the escrow pays the provider's wallet in
 * the same step. The authority the payment earned is shown as the vault service computes it: pending until the chain
 * has confirmed it, then half the price. A second milestone takes the refund path: funded, then released by the
 * provider before its deadline, the escrow returns the money to the client's own account on the chain. Every figure on
 * screen is compared with the chain and with the database.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { query } from '../support/stack.ts'
import { approve, chainCall, household, railGet, shot } from '../support/vault.ts'

async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await shot(page, `earn-sheet-${Date.now()}`)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/**
 * WCAG 2.0 to 2.2 level A and AA rules over one section, as scripts/a11y.ts runs them over whole screens. With reduced
 * motion nothing waits to arrive (DESIGN.md M5), so axe measures the settled colours, as earn-dispute and the directory
 * journey do: in the full run of 25 Nov on 5ef737b, axe read the pressed "Assets you name" button of the form that had
 * just arrived as low contrast, 11.8 s into the journey; two runs of this spec alone and the full run of 24 Nov had
 * passed the same check.
 */
async function accessible(page: Page, selector: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
/** A full-page photograph at a width, from the top once the layout has settled (taken scrolled, fixed bars land mid-page). */
async function photo(page: Page, width: number, name: string): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(() => { window.scrollTo(0, 0); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
  await shot(page, name)
}
/** What the section says outside its closed "Technical details": rupees and plain words, no token symbols or raw identifiers (DESIGN.md C2). */
async function saysPlainly(region: ReturnType<Page['getByRole']>): Promise<void> {
  const text = await region.innerText()
  expect(text).not.toMatch(/\btINR\b|0x[0-9a-fA-F]{8,}|\bvault\b/i)
}
const balance = async (railId: string) => BigInt((await railGet(`/workspaces/${railId}/state`)).treasury.balance as string)
/** A token balance read from the chain itself (ERC-20 balanceOf through the stack's own local chain, over its socket). */
async function onChain(token: string, who: string): Promise<bigint> {
  const data = `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}`
  return BigInt(await chainCall('eth_call', [{ to: token, data }, 'latest']) as string)
}

test('an earning job between two fresh households through the screens: offered, funded from the client\'s wallet, delivered and verified on the chain, the provider paid, the authority it earned shown honestly, and a second milestone released back to the client', async ({ browser }) => {
  test.setTimeout(360_000)
  const P = await household(browser), C = await household(browser)
  const errors: string[] = []
  for (const x of [P, C]) x.page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const [client] = query<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', C.personId)
  const [provider] = query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', P.personId)
  const before = { p: await balance(P.railId), c: await balance(C.railId) }

  // the provider prepares the job for the client's handle: two assets, two milestones of ₹250.75 and ₹40
  await P.page.goto('/earn')
  const work = P.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  await expect(work.getByText('No work through the escrow yet.', { exact: false })).toBeVisible()
  await work.getByRole('button', { name: 'Prepare a job for another account' }).click()
  const form = work.getByRole('form', { name: 'Prepare a job paid through the escrow' })
  await form.getByLabel('The work', { exact: true }).fill('Lowest-risk sleeve <b>not markup</b>')
  await form.getByLabel('The client\'s handle').fill(client!.handle)
  await form.getByLabel('Asset 1').fill('Alpha')
  await form.getByLabel('Yearly swing, %').nth(0).fill('15')
  await form.getByLabel('Asset 2').fill('Beta')
  await form.getByLabel('Yearly swing, %').nth(1).fill('30')
  await form.getByLabel('Milestone 1').fill('Certified weights')
  await form.getByLabel('Paid when the work checks out').nth(0).fill('250.75')
  await form.getByLabel('Deliver within, hours').nth(0).fill('2')
  await form.getByRole('button', { name: 'Add a milestone' }).click()
  await form.getByLabel('Milestone 2').fill('Second opinion')
  await form.getByLabel('Paid when the work checks out').nth(1).fill('40')
  await form.getByLabel('Deliver within, hours').nth(1).fill('2')
  await accessible(P.page, 'section.chain-work')
  await form.getByRole('button', { name: 'Prepare the job' }).click()
  const pjob = work.getByRole('article', { name: 'Lowest-risk sleeve <b>not markup</b>' })
  await expect(pjob.getByText('Not offered yet', { exact: true })).toHaveCount(2)
  const first = (x: typeof pjob) => x.getByRole('listitem').filter({ hasText: 'Certified weights' })
  const second = (x: typeof pjob) => x.getByRole('listitem').filter({ hasText: 'Second opinion' })
  // the paper section does not list it
  await expect(P.page.getByRole('region', { name: 'Work held in escrow' }).getByText('Lowest-risk sleeve', { exact: false })).toHaveCount(0)

  // 1 · the offers: the provider's passkey signs each quote; nothing moves. The provider knows the client by the handle
  // it typed; the client's name appears only once they fund a milestone (RISK-071)
  await expect(pjob.getByText(`For @${client!.handle}; their name shows once they fund a milestone`)).toBeVisible()
  await expect(pjob.getByText(client!.display_name, { exact: false })).toHaveCount(0)
  for (const ms of [first(pjob), second(pjob)]) {
    await ms.getByRole('button', { name: `Offer it to @${client!.handle}` }).click()
    await approveHere(P.page, /The offer above/)
    await expect(ms.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })
  }
  expect(await balance(P.railId)).toBe(before.p)
  expect(await balance(C.railId)).toBe(before.c)
  await shot(P.page, 'earn-offered')

  // 2 · the client sees it, as the provider wrote it, and funds it from its own wallet
  await C.page.goto('/earn')
  const cwork = C.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  const cjob = cwork.getByRole('article', { name: 'Lowest-risk sleeve <b>not markup</b>' })
  await expect(cjob.getByText(`Offered by ${provider!.display_name} (@`, { exact: false })).toBeVisible({ timeout: 30_000 })
  expect(await C.page.locator('.chain-work b').count()).toBe(0) // the title is text, never markup
  for (const ms of [first(cjob), second(cjob)]) {
    await ms.getByRole('button', { name: 'Fund it from your wallet' }).click()
    await approveHere(C.page, /withdraw.*approve.*open/)
    await expect(ms.getByText('In escrow', { exact: true })).toBeVisible({ timeout: 60_000 })
  }
  expect(before.c - (await balance(C.railId))).toBe(25075n + 4000n)
  await expect(cwork.getByText(`₹40.00 left your wallet and is held by the escrow. It is paid to ${provider!.display_name} only for work the verifier on the chain accepts by`, { exact: false })).toBeVisible()
  await saysPlainly(cwork)
  await accessible(C.page, 'section.chain-work')
  await photo(C.page, 390, 'earn-390-client-funded'); await C.page.setViewportSize({ width: 1280, height: 860 })

  // 3 · the provider delivers: the verifier on the chain checks the certificate, and the escrow pays in the same step
  await P.page.reload()
  await expect(pjob.getByText('In escrow', { exact: true })).toHaveCount(2, { timeout: 30_000 })
  await expect(pjob.getByText(`For ${client!.display_name} (@${client!.handle})`)).toBeVisible()
  await first(pjob).getByRole('button', { name: 'Deliver the work' }).click()
  await approveHere(P.page, /deliver/)
  await expect(first(pjob).getByText('Paid, verified', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(work.getByText('The verifier on the chain accepted the certificate, and the escrow paid ₹250.75 into your wallet.', { exact: false })).toBeVisible()
  expect((await balance(P.railId)) - before.p).toBe(25075n)
  const settledJob = async () => ((await railGet(`/workspaces/${P.railId}/escrow/jobs`)).jobs as { jobId: string; status: string; authority: { status: string; credit: string; confirmations: number } }[]).find((j) => j.status === 'settled')!
  const auth = async () => (await settledJob()).authority
  // the authority it earned, honestly pending while the chain has confirmed the payment once. Other tests share this
  // chain, and any block of theirs is a second confirmation: the page then says credited, which is also true.
  if ((await auth()).status === 'pending') {
    const line = first(pjob).getByText(/once the chain has confirmed it \(\d of 2 confirmations so far\)|Adds ₹125\.37 to what QED may pay out on its own/)
    await expect(line).toBeVisible({ timeout: 15_000 })
    const said = await line.innerText()
    if (/once the chain has confirmed it/.test(said)) {
      expect(said).toContain('(1 of 2 confirmations so far)')
      await shot(P.page, 'earn-authority-pending')
    }
  }

  // 4 · the refund path: the provider releases the second milestone before its deadline; the escrow returns ₹40 to the client
  const state = await railGet(`/workspaces/${C.railId}/state`)
  const clientAccount = state.contracts.ownerAccount as string, token = state.contracts.asset as string
  const ownBefore = await onChain(token, clientAccount)
  await second(pjob).getByRole('button', { name: `Release ${client!.display_name} instead` }).click()
  await approveHere(P.page, /refund/)
  await expect(second(pjob).getByText('Refunded', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(work.getByText(`The escrow returned ₹40.00 to ${client!.display_name}. Nothing was paid to your wallet.`, { exact: false })).toBeVisible()
  await saysPlainly(work)
  await accessible(P.page, 'section.chain-work')
  expect((await onChain(token, clientAccount)) - ownBefore).toBe(4000n)
  expect((await balance(P.railId)) - before.p).toBe(25075n)
  const rows = query<{ title: string; state: string; evidence_hash: string | null }>(`SELECT m.title, m.state, m.evidence_hash FROM earn_milestones m JOIN earn_jobs j ON j.id = m.job_id WHERE j.user_id = ? ORDER BY m.title`, P.personId)
  expect(rows.map((r) => [r.title, r.state])).toEqual([['Certified weights', 'chain-released'], ['Second opinion', 'chain-refunded']])
  const jobs = (await railGet(`/workspaces/${P.railId}/escrow/jobs`)).jobs as { jobId: string; status: string; price: string; solutionHash: string; authority: { status: string; credit: string } }[]
  const paid = jobs.find((j) => j.status === 'settled')!
  expect(jobs.map((j) => [j.status, j.price]).sort()).toEqual([['refunded', '4000'], ['settled', '25075']])
  expect(rows[0]!.evidence_hash).toBe(paid.solutionHash)
  const back = jobs.find((j) => j.status === 'refunded')!
  expect([back.authority.status, back.authority.credit]).toEqual(['not-settled', '0'])

  // 5 · the authority it earned, as the vault service computes it: half the price once the chain has confirmed the payment
  //     twice (the refund's transaction is a later block); the refunded milestone earns nothing
  await expect.poll(async () => (await auth()).status, { timeout: 20_000 }).toBe('credited')
  expect((await auth()).credit).toBe('12537')
  await P.page.reload()
  await expect(first(pjob).getByText('₹125.37', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(first(pjob).getByText(/to what QED may pay out on its own: half the price, earned from a client outside this workspace/)).toBeVisible()
  await expect(second(pjob).getByText(/to what QED may pay out on its own/)).toHaveCount(0)
  await photo(P.page, 1440, 'earn-1440-provider-paid'); await photo(P.page, 390, 'earn-390-provider-paid')
  expect(await P.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  // the client's view: paid to the provider, nothing left to do
  await C.page.reload()
  await expect(first(cjob).getByText('Paid, verified', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(second(cjob).getByText('Refunded', { exact: true })).toBeVisible()
  await expect(cjob.getByRole('button', { name: /Fund it|Take the money back|Deliver|Offer|Release|Refund/ })).toHaveCount(0)

  // 6 · the household's books (R13, server/chain-books.ts): a payment from the provider's wallet and the escrow earning are
  //     entered in the ledger once their block has two confirmations, each with its block's time and the time QED entered
  //     it, as valueless test tokens; Activity shows both times and the label, and the books agree with the chain
  await P.page.setViewportSize({ width: 1280, height: 900 })
  await P.page.goto('/vault')
  await P.page.getByLabel('Most in one payment, in test rupees').fill('2500')
  await P.page.getByRole('button', { name: 'See the exact mandate' }).click()
  await approve(P.page, /The mandate above/)
  await P.page.goto('/vault/treasury')
  const pay = P.page.getByRole('region', { name: 'Pay CloudCo' })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'See the exact terms' }).click()
  await approve(P.page, /The exact text above/)
  await expect(P.page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')
  // the payment's block already has its second confirmation: since R7-036 the vault service reports a job completed only
  // at two confirmations and mines the empty block that needs on this quiet chain (chain/rail/service.ts depth)
  type Books = { entries: { kind: string; effectiveTs: number; entryTs: number }[]; comparison: { state: string } | null; words: string }
  const books = async (): Promise<Books> => (await (await P.page.request.get('/api/chain-books')).json()) as Books
  // the engine books and compares every half minute
  await expect.poll(async () => (await books()).entries.map((e) => e.kind), { timeout: 120_000, intervals: [2_000] }).toEqual(expect.arrayContaining(['chain-grant', 'chain-escrow-earning', 'chain-payment']))
  await expect.poll(async () => (await books()).comparison?.state, { timeout: 60_000, intervals: [2_000] }).toBe('agrees')
  const b = await books()
  expect(b.words).toBe('valueless test tokens on a local chain')
  for (const e of b.entries) expect(e.effectiveTs).toBeLessThanOrEqual(e.entryTs)
  expect(query<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE user_id = ? AND kind = 'chain-payment'`, P.personId)[0]!.n).toBe(1)
  await P.page.goto('/activity?view=list') // R14: the day book is the list; each row's every time and chain fact is behind its own button
  const detailOf = (what: RegExp) => P.page.locator('tr').filter({ has: P.page.getByRole('link', { name: what }) }).locator('.ac-detail')
  for (const what of [/^Paid CloudCo/, /^Delivered work to the escrow/]) await P.page.locator('tr').filter({ has: P.page.getByRole('link', { name: what }) }).getByRole('button', { name: 'Every detail and time' }).click()
  const paidRow = detailOf(/^Paid CloudCo/), earned = detailOf(/^Delivered work to the escrow/)
  await expect(paidRow).toContainText(/Paid CloudCo \(3\.00 test rupees out\): took effect \d{1,2} \w{3} \d{4}, [\d:]+ IST on the chain/, { timeout: 30_000 })
  await expect(paidRow).toContainText(/Entered in your books \d{1,2} \w{3} \d{4}, [\d:]+ IST/)
  await expect(paidRow).toContainText('Test rupees: valueless test tokens on a local chain')
  await expect(earned).toContainText(/Received for work: escrow job #\d+ \(250\.75 test rupees in\): took effect \d{1,2} \w{3} \d{4}, [\d:]+ IST on the chain/)
  await expect(earned).toContainText(/Entered in your books \d{1,2} \w{3} \d{4}, [\d:]+ IST/)
  await expect(earned).toContainText('Test rupees: valueless test tokens on a local chain')
  // the wallet's summary counts the payment as paid out and the earning not at all as money out (an earlier draft did)
  expect(await P.page.getByText(/^−3\.00$/).count()).toBeGreaterThan(0)
  expect(await P.page.getByText(/^−253\.75$/).count()).toBe(0)
  await shot(P.page, 'activity-chain-books')
  expect(errors).toEqual([])
})
