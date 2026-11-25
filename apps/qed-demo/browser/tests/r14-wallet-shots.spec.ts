/**
 * Photographs of the wallet's tabs, its job records, the approval states and a business's waiting request, in rupees and
 * in US dollars (R14, the wallet pass). It checks nothing: it runs only with QED_SHOTS=<folder> (and QED_SHOT_LABEL).
 *
 *   npm run build && QED_BROWSER_PORT=14400 QED_SHOTS=evidence/design/r14-ux-wallet QED_SHOT_LABEL=before npx playwright test -c browser/playwright.config.ts r14-wallet-shots --workers=1
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { allowSignups } from '../support/stack.ts'
import { accept, approve, setUpVault, signupCodes } from '../support/vault.ts'

const out = process.env.QED_SHOTS ? join(process.cwd(), process.env.QED_SHOTS, process.env.QED_SHOT_LABEL ?? 'shots') : ''
const WIDTHS = (process.env.QED_SHOT_WIDTHS ?? '1440,1024,768,390').split(',').map(Number)
const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function owner(page: Page, currency: string): Promise<string> {
  const handle = uniq('r14w')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  signupCodes.set(handle, await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts())
  await page.getByRole('button', { name: 'Continue' }).click()
  if (currency !== 'INR') { await page.getByLabel('Home currency').selectOption(currency); await page.waitForTimeout(500) }
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}
async function sheet(page: Page): Promise<void> {
  const s = page.getByRole('dialog')
  await expect(s.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await s.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
}
async function photo(page: Page, route: string, name: string, widths = WIDTHS): Promise<void> {
  mkdirSync(out, { recursive: true })
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 })
    if (route) await page.goto(route)
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.waitForTimeout(700)
    await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) } window.scrollTo(0, 0) })
    await page.waitForTimeout(300)
    const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight }))
    await page.screenshot({ path: join(out, `${name}-${w}.png`), fullPage: true, animations: 'disabled' })
    console.log(`${name}-${w} height=${ov.h}${ov.sw > ov.iw ? ` OVERFLOW ${ov.sw}>${ov.iw}` : ''}`)
  }
}

for (const ccy of ['INR', 'USD']) {
  test(`wallet pages, ${ccy}`, async ({ page }) => {
    test.skip(!process.env.QED_SHOTS, 'photographs only')
    test.setTimeout(400_000)
    await addAuthenticator(page)
    await owner(page, ccy)
    if (ccy !== 'INR') {
      // the on-chain wallet and Earn are test-rupee only (server/home-currency.ts): a household in another currency sees them closed
      for (const [r, n] of [['/vault', 'overview'], ['/vault/mandate', 'mandate'], ['/vault/treasury', 'treasury'], ['/vault/convert', 'convert'], ['/vault/policy', 'policy'], ['/vault/records', 'records'], ['/earn', 'earn'], ['/pay', 'pay']] as const) await photo(page, r, `${ccy.toLowerCase()}-${n}`)
      return
    }
    await setUpVault(page)
    await accept(page).catch(async () => { /* the treasury figure differs by currency */ })
    await page.goto('/protect')
    await page.getByRole('button', { name: 'Write a mandate' }).click()
    const mandate = page.getByRole('form', { name: 'A new mandate for your on-chain wallet' })
    await mandate.getByLabel('Most in one payment, in test rupees').fill('2500')
    await mandate.getByRole('button', { name: 'Review and sign' }).click()
    await sheet(page)
    await expect(page.getByText('Signed: the new mandate is in force on the chain.')).toBeVisible({ timeout: 60_000 })
    await page.goto('/pay')
    await page.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
    const pay = page.getByRole('form', { name: 'Pay from your on-chain wallet' })
    await pay.getByLabel('How much, in test rupees').fill('3')
    await pay.getByRole('button', { name: 'Review and sign' }).click()
    await sheet(page)
    await expect(pay.getByText(/^Paid /)).toBeVisible({ timeout: 60_000 })
    await page.goto('/holdings')
    const convert = page.getByRole('form', { name: 'Convert into your dollar reserve' })
    await convert.getByLabel('Convert how much, in test rupees').fill('10')
    await convert.getByRole('button', { name: 'Check the limits and the price' }).click()
    await expect(convert.getByText(/You would receive about \$/)).toBeVisible({ timeout: 20_000 })
    await convert.getByRole('button', { name: 'Review and sign' }).click()
    await sheet(page)
    await expect(convert.getByText(/^Converted /)).toBeVisible({ timeout: 60_000 })
    const policy = page.getByRole('form', { name: 'Keep a dollar reserve topped up' })
    await policy.getByLabel('Keep this much free in the reserve, in test dollars').fill('5')
    await policy.getByRole('button', { name: 'Review and sign' }).click()
    await sheet(page)
    await expect(page.getByText(/^In force:/)).toBeVisible({ timeout: 60_000 })
    const c = ccy.toLowerCase()
    for (const [r, n] of [['/vault', 'overview'], ['/vault/mandate', 'mandate'], ['/vault/treasury', 'treasury'], ['/vault/convert', 'convert'], ['/vault/policy', 'policy'], ['/vault/records', 'records'], ['/earn', 'earn'], ['/pay', 'pay']] as const) await photo(page, r, `${c}-${n}`)
    // job records: the completed ones, then a refused one (more than the mandate's most in one payment) if the page lets it be asked
    const jobs = (await (await page.request.get('/api/vault/jobs?limit=30')).json()) as { jobs: { id: string; outcome?: string; status?: string }[] }
    console.log('jobs', JSON.stringify(jobs.jobs.map((j) => [j.id, j.outcome ?? j.status])))
    if (jobs.jobs[0]) await photo(page, `/vault/job/${jobs.jobs[0].id}`, `${c}-job-done`)
    // refused / reverted / running: the same page with the server's answer changed in the browser only
    for (const outcome of ['refused', 'reverted', 'running']) {
      const id = jobs.jobs[0]?.id
      if (!id) break
      await page.route(`**/api/vault/jobs/${id}`, async (route) => {
        const r = await route.fetch(); const j = (await r.json()) as Record<string, unknown>
        const res = (j.result ?? {}) as Record<string, unknown>
        const next = outcome === 'running' ? { ...j, status: 'running', result: null, finishedAt: null }
          : outcome === 'reverted' ? { ...j, result: { ...res, outcome: 'reverted', tx: { ...(res.tx as object ?? { hash: '0x' + 'ab'.repeat(32), block: 12, gasUsed: '90000' }), status: 'reverted', error: 'execution reverted' } } }
          : { ...j, result: { ...res, outcome: 'refused', tx: null, summary: 'Co-signer refused: C5 not met: per-conversion: the amount is above the most the mandate allows in one conversion.' } }
        await route.fulfill({ response: r, json: next })
      })
      await photo(page, `/vault/job/${id}`, `${c}-job-${outcome}`)
      await page.unroute(`**/api/vault/jobs/${id}`)
    }
    await photo(page, '/notifications', `${c}-notifications`, [1440, 390])
  })
}

async function member(browser: Browser): Promise<{ page: Page; handle: string }> {
  const page = await (await browser.newContext()).newPage()
  await addAuthenticator(page)
  return { page, handle: await owner(page, 'INR') }
}
for (const ccy of ['INR']) {
  test(`business request waiting, ${ccy}`, async ({ browser }) => {
    test.skip(!process.env.QED_SHOTS, 'photographs only')
    test.setTimeout(400_000)
    const a = await member(browser), b = await member(browser)
    await a.page.goto('/workspace')
    await a.page.getByLabel('Business name').fill(`Vault Traders ${a.handle}`)
    await a.page.getByRole('button', { name: 'Create' }).click()
    await a.page.getByRole('button', { name: 'Open the household' }).click()
    await a.page.goto('/workspace')
    await a.page.getByLabel('Their handle').fill(b.handle)
    await a.page.getByLabel('Role').selectOption('approver')
    await a.page.getByRole('button', { name: 'Add member' }).click()
    await expect(a.page.getByText(`@${b.handle}`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await a.page.getByLabel('Signatures for every request').fill('2')
    await a.page.getByRole('button', { name: 'Save who must sign' }).click()
    await expect(a.page.getByText('In force now')).toBeVisible()
    await a.page.goto('/vault')
    await a.page.getByRole('button', { name: 'Confirm with your passkey and set it up' }).click()
    await expect(a.page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
    await a.page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
    const s = a.page.getByRole('dialog')
    await s.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
    await expect(s.getByText('Signed: 1 of 2')).toBeVisible()
    await photo(a.page, '', `biz-sheet-one-of-two`, [1440, 390])
    await s.getByRole('button', { name: 'Close', exact: true }).last().click()
    await photo(a.page, '/workspace', 'biz-owner-workspace')
    await photo(a.page, '/vault', 'biz-owner-vault')
    await b.page.reload()
    await b.page.getByRole('button', { name: /account menu$/ }).click()
    await b.page.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: `Vault Traders ${a.handle} (approver)` })
    await photo(b.page, '/workspace', 'biz-member-workspace')
    await b.page.getByRole('button', { name: 'Review and sign' }).click()
    await photo(b.page, '', 'biz-member-review', [1440, 390])
  })
}
void approve; void allowSignups
