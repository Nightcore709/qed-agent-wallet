/**
 * The securities desks, the withdrawal plan, the benchmark and the risk estimates, in one journey (R13, audit G2, G3, G5,
 * G9): an ETF bought on the paper exchange and a Treasury bill on the paper government-securities desk, each through its
 * sheet, its approval, its fill and its holding; a fund bought so that a systematic withdrawal plan has units, and the plan
 * written and signed with its exit load and tax on the screen; an order out of hours refused with its reason; what is not
 * offered yet, each with why; and the benchmark choice that QED leaves empty, with the risk estimates drawn as estimates.
 *
 * On a presentation-mode stack. The stack's clock is brought forward (never back) to a weekday at 11:00 India time, when
 * both desks are open, and later to that evening, when they are closed; the fund's NAV for the day is published by the test
 * stack's own control (as in fund-states.spec.ts). Every price is synthetic and the screen says so.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_SECURITIES_PORT ?? extraPort(46))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let dir = ''
let navFile = ''
let clockFile = ''
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qed-securities-'))
  navFile = join(dir, 'nav-through')
  clockFile = join(dir, 'clock-offset')
  writeFileSync(clockFile, '0')
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_SYNTHETIC_NAV_FILE: navFile, QED_TEST_CLOCK_FILE: clockFile, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
test.afterAll(async () => { await s?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

const moveClockTo = (at: number): void => { writeFileSync(clockFile, String(Math.max(0, Math.round(at - Date.now())))) }
/** The next weekday after today (India time), as an ISO day. */
function nextWeekday(): string {
  let t = Date.now() + 19_800_000 + 86_400_000
  for (;;) { const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d.toISOString().slice(0, 10); t += 86_400_000 }
}
const ETF = 'xchg:NIFTYBEES', BILL = 'gsec:TB91', FUND = 'amfi:120716'

async function newOwner(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Securities Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}
/** Choose what to trade, preview its sheet, and return the sheet. */
async function preview(page: Page, id: string, rupees: string): Promise<ReturnType<Page['getByRole']>> {
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption(id)
  await page.getByLabel('With how much').fill(rupees)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet).toBeVisible()
  return sheet
}
async function approve(page: Page, sheet: ReturnType<Page['getByRole']>): Promise<string> {
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(page).toHaveURL(/\/record\/act_/)
  return page.url().split('/record/')[1]!
}
const state = (id: string) => s.query<{ state: string; error: string | null }>('SELECT state, error FROM actions WHERE id = ?', id)[0]

test('an ETF and a Treasury bill bought through their sheets, a fund for a withdrawal plan, the plan signed, an order refused out of hours, and the choices left to the owner', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const handle = `sec${Date.now().toString(36)}`
  await newOwner(page, handle)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // both desks are open at 11:00 India time on a weekday: the stack's clock is brought to the next one
  const day = nextWeekday()
  moveClockTo(Date.parse(`${day}T11:00:00+05:30`))
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id IN (?, ?) AND price_type = 'ask' AND recv_ts >= ?`, ETF, BILL, Date.parse(`${day}T11:00:00+05:30`))[0]!.n, { timeout: 30_000 }).toBe(2)
  const [bank0] = s.query<{ v: string }>(`SELECT b.amount_text v FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, u!.id)

  // 1. the ETF: the sheet says whose prices these are, the costs, the hours and the settlement, before anything is signed
  let sheet = await preview(page, ETF, '10000')
  await expect(sheet.getByText('a paper exchange, on paper')).toBeVisible()
  await expect(sheet.getByText(/Synthetic prices generated on this computer, not market data/).first()).toBeVisible()
  await expect(sheet.getByText('Stamp duty', { exact: true })).toBeVisible()
  await expect(sheet.getByText('Brokerage', { exact: true })).toBeVisible()
  await expect(sheet.getByText(/Settlement is T\+1/)).toBeVisible()
  await expect(sheet.getByText('09:15 to 15:30 India time, Monday to Friday')).toBeVisible()
  const etfAction = await approve(page, sheet)
  await expect.poll(() => state(etfAction)?.state, { timeout: 40_000 }).toBe('done')
  const [etf] = s.query<{ qty: number; price: string; fee: number; tax: number; amount: number }>(`SELECT f.qty, f.price, f.fee, f.tax, f.amount FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, etfAction)
  expect(etf!.qty).toBeGreaterThan(0)
  expect(etf!.amount + etf!.fee + etf!.tax).toBeLessThanOrEqual(1_000_000)
  expect(etf!.tax).toBeGreaterThan(0) // stamp duty
  expect(etf!.fee).toBeGreaterThan(0)

  // 2. the Treasury bill: lots of 100 units, no brokerage, the cost is the gap
  sheet = await preview(page, BILL, '50000')
  await expect(sheet.getByText('a paper government-securities desk, on paper')).toBeVisible()
  await expect(sheet.getByText('No brokerage or tax; the gap between the two prices')).toBeVisible()
  await expect(sheet.getByText(/A bill pays no interest/)).toBeVisible()
  const billAction = await approve(page, sheet)
  await expect.poll(() => state(billAction)?.state, { timeout: 40_000 }).toBe('done')
  const [bill] = s.query<{ qty: number; fee: number; tax: number }>(`SELECT f.qty, f.fee, f.tax FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, billAction)
  expect(bill!.qty % 100).toBe(0)
  expect(bill!.qty).toBeGreaterThan(0)
  expect(bill!.fee + bill!.tax).toBe(0)

  // both are in Grow as holdings, in units, with the books in agreement
  await page.goto(`${s.base}/holdings`)
  await expect(page.locator('tr.gr-h-row').filter({ hasText: 'Nifty 50 BeES' })).toContainText(/\d[\d,]* units/)
  await expect(page.locator('tr.gr-h-row').filter({ hasText: '91-day Treasury bill' })).toContainText(/\d[\d,]* units/)
  const [pos] = s.query<{ v: string }>(`SELECT b.amount_text v FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = ?`, u!.id, `pos:${ETF}`)
  expect(Number(pos!.v)).toBe(etf!.qty)
  const [bank1] = s.query<{ v: string }>(`SELECT b.amount_text v FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, u!.id)
  const billRow = s.query<{ amount: number }>(`SELECT f.amount FROM pv_fills f WHERE f.user_id = ? AND f.instrument_id = ?`, u!.id, BILL)[0]!
  expect(Number(bank0!.v) - Number(bank1!.v)).toBe(etf!.amount + etf!.fee + etf!.tax + billRow.amount)

  // 3. a fund, so that a withdrawal plan has units: its NAV for the day is published by the stack's control, that evening
  sheet = await preview(page, FUND, '30000')
  const fundAction = await approve(page, sheet)
  // the order must reach the registrar before the clock moves: an approval is for the minutes after it is given
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders o JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, fundAction)[0]!.n, { timeout: 30_000 }).toBe(1)
  writeFileSync(navFile, day)
  moveClockTo(Date.parse(`${day}T21:00:00+05:30`))
  await expect.poll(() => state(fundAction)?.state, { timeout: 60_000 }).toBe('done')

  // 4. the withdrawal plan: its exit load and its tax on the screen before it is signed, then signed with the passkey
  await page.goto(`${s.base}/instructions/new?kind=swp`)
  await page.getByLabel('Withdraw from').selectOption(FUND)
  await page.getByLabel('Each time', { exact: true }).fill('1000')
  await expect(page.getByLabel('How often').locator('option')).toHaveText(['Every month', 'Every week']) // a daily plan is not offered
  await expect(page.getByText('Exit load', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Tax on the gain in a withdrawal').first()).toBeVisible()
  await expect(page.getByText(/not a limit this plan can stop/)).toBeVisible()
  await page.getByRole('button', { name: 'Review and sign' }).click()
  await page.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [prog] = s.query<{ kind: string; state: string; live_version: number | null; next_due_at: number | null }>(`SELECT kind, state, live_version, next_due_at FROM programs WHERE user_id = ?`, u!.id)
  expect(prog).toMatchObject({ kind: 'swp', state: 'active', live_version: 1 })
  expect(prog!.next_due_at).not.toBeNull()
  const [doc] = s.query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, u!.id)
  expect(doc!.document).toMatch(/Redeem units of UTI Nifty 50 Index Fund/)
  expect(doc!.document).toMatch(/Send money anywhere except into your own bank account/)

  // 5. out of hours (it is 21:00 now): the sheet says so, and an order sent anyway is refused before anything is held
  sheet = await preview(page, ETF, '10000')
  await expect(sheet.getByText(/The exchange is closed\. It trades 9:15 am to 3:30 pm India time, Monday to Friday/).first()).toBeVisible()
  await expect(sheet.getByText('It is refused: the market is closed')).toBeVisible()
  const lateAction = await approve(page, sheet)
  await expect.poll(() => state(lateAction)?.state, { timeout: 30_000 }).toBe('blocked')
  expect(state(lateAction)!.error).toMatch(/closed/)
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders o JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, lateAction)[0]!.n).toBe(0)

  // 6. Grow: what is not offered yet, each with its reason; the benchmark left to the owner; the risk drawn as an estimate
  await page.goto(`${s.base}/holdings`)
  await page.locator('#not-offered > summary').click()
  for (const name of ['US shares', 'Currency trades', 'Futures and options', 'REITs and InvITs']) await expect(page.locator('#not-offered').getByText(name, { exact: true })).toBeVisible()
  await expect(page.locator('#not-offered').getByText(/a paper trade would show a cost and a delivery that nothing here can honestly work out/)).toBeVisible()
  const compare = page.locator('#compare')
  await expect(compare.getByText(/QED does not choose a benchmark for you/)).toBeVisible()
  await expect(compare.getByLabel('Compare my holdings with')).toHaveValue('')
  await expect(compare.getByText('Nothing is compared until you choose a benchmark.')).toBeVisible()
  await compare.getByLabel('Compare my holdings with').selectOption('equal-weight')
  await expect(compare.locator('article.gc-win').first()).toBeVisible({ timeout: 20_000 })
  await expect(compare.getByText(/An estimate, not a limit and not a protection\./)).toBeVisible()
  await expect(compare.getByText(/not limits and not protections/)).toBeVisible()
  // a pressed toggle's text and background ease in at different speeds, and live prices re-render the toggles, so a scan can
  // land on a frame of the transition (25 Nov: 1.1 and 1.41 mid-way): axe measures the settled colours, under the reduced
  // motion a person can ask for (base.css then shortens every transition to 0.01 ms; the CSP rightly refuses injected styles)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect((await new AxeBuilder({ page: page as never }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
})
