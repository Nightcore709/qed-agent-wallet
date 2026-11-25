/**
 * A withdrawal plan across two holdings (R14, capability 8), in one journey: two funds bought, the plan written with both,
 * its breakdown read before anything is signed (which holding, how many units, how much, the settlement day of each, the
 * costs, and why that order), the plan approved with the passkey, a run at its time selling from both, and the run settling
 * with a record for each sale. On a presentation-mode stack with the test clock and the test NAV control, as securities.spec.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_SWP_PORT ?? extraPort(64))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let dir = ''
let navFile = ''
let clockFile = ''
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qed-swp-'))
  navFile = join(dir, 'nav-through')
  clockFile = join(dir, 'clock-offset')
  writeFileSync(clockFile, '0')
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_SYNTHETIC_NAV_FILE: navFile, QED_TEST_CLOCK_FILE: clockFile, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
test.afterAll(async () => { await s?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

const moveClockTo = (at: number): void => { writeFileSync(clockFile, String(Math.max(0, Math.round(at - Date.now())))) }
function nextWeekday(): string {
  let t = Date.now() + 19_800_000 + 86_400_000
  for (;;) { const d = new Date(t); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d.toISOString().slice(0, 10); t += 86_400_000 }
}
const INDEX = 'amfi:120716', OVER = 'amfi:119110'

async function newOwner(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Withdrawal Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}
async function buy(page: Page, id: string, rupees: string): Promise<string> {
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption(id)
  await page.getByLabel('With how much').fill(rupees)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(page).toHaveURL(/\/record\/act_/)
  const action = page.url().split('/record/')[1]!
  // the order must reach the registrar before the clock moves: an approval is for the minutes after it is given
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders o JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, action)[0]!.n, { timeout: 30_000 }).toBe(1)
  return action
}
const state = (id: string) => s.query<{ state: string }>('SELECT state FROM actions WHERE id = ?', id)[0]?.state

test('a withdrawal plan across two funds: the breakdown before approval, the passkey, and a run that sells from both and settles', async ({ page }) => {
  test.setTimeout(300_000)
  await addAuthenticator(page)
  const handle = `swp${Date.now().toString(36)}`
  await newOwner(page, handle)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const day = nextWeekday()
  moveClockTo(Date.parse(`${day}T11:00:00+05:30`))

  // 1. two holdings: an index fund and an overnight fund, their NAVs for the day published that evening
  const a1 = await buy(page, INDEX, '30000')
  const a2 = await buy(page, OVER, '3000')
  writeFileSync(navFile, day)
  moveClockTo(Date.parse(`${day}T21:00:00+05:30`))
  await expect.poll(() => [state(a1), state(a2)], { timeout: 60_000 }).toEqual(['done', 'done'])

  // 2. the plan: ₹5,000 a month from the index fund, allowed also to sell the overnight fund, which holds less than that
  await page.goto(`${s.base}/instructions/new?kind=swp`)
  await page.getByLabel('Withdraw from').selectOption(INDEX)
  await page.getByLabel('HDFC Overnight Fund (Direct, Growth)').check()
  await page.getByLabel('Each time', { exact: true }).fill('5000')
  const breakdown = page.getByTestId('withdrawal-breakdown')
  await expect(breakdown).toBeVisible({ timeout: 20_000 })
  await expect(breakdown.getByText('1. HDFC Overnight Fund (Direct, Growth)')).toBeVisible() // its money arrives first
  await expect(breakdown.getByText('2. UTI Nifty 50 Index Fund (Direct, Growth)')).toBeVisible()
  await expect(breakdown.getByText('Money reaches your bank').first()).toBeVisible()
  await expect(breakdown.getByText(/all you hold/)).toBeVisible()
  await expect(breakdown.getByText('Exit load').first()).toBeVisible()
  await expect(breakdown.getByText(/none is deducted at source/).first()).toBeVisible()
  await expect(breakdown.getByText(/no exit load on the units to be sold/).first()).toBeVisible()
  await expect(breakdown.getByText(/Paper; the registrar prices it at a later NAV/).first()).toBeVisible()
  await breakdown.getByText('The rule, in words').click()
  await expect(breakdown.getByText(/never sells so much that less than your reserve is left/)).toBeVisible()
  await page.getByLabel('On its own').check()

  // 3. signed with the passkey: the signed document names both funds and the rule
  await page.getByRole('button', { name: 'Review and sign' }).click()
  await page.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [doc] = s.query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, u!.id)
  expect(doc!.document).toMatch(/UTI Nifty 50 Index Fund.*HDFC Overnight Fund|HDFC Overnight Fund.*UTI Nifty 50 Index Fund/s)
  expect(doc!.document).toMatch(/Order of sale/)
  const [prog] = s.query<{ id: string; state: string; next_due_at: number }>(`SELECT id, state, next_due_at FROM programs WHERE user_id = ?`, u!.id)
  expect(prog!.state).toBe('active')

  // 4. its day comes: the run sells from both, and each sale has its own record
  moveClockTo(prog!.next_due_at - 8_000) // just before its time: a run the engine did not see at its time is missed, never run late
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE program_id = ?`, prog!.id)[0]!.n, { timeout: 60_000 }).toBe(2)
  const legs = s.query<{ i: string; swp: string }>(`SELECT json_extract(params_json, '$.instrumentId') i, json_extract(params_json, '$.swpPaise') swp FROM actions WHERE program_id = ? ORDER BY economic_id`, prog!.id)
  expect(legs.map((l) => l.i)).toEqual([OVER, INDEX])
  const asked = legs.reduce((t, l) => t + Number(l.swp), 0)
  expect(asked).toBeLessThanOrEqual(500_000) // never more than the amount; a few paise less from rounding units down
  expect(asked).toBeGreaterThan(499_000)

  // 5. the redemptions are priced at the NAV of the day the registrar entitles them to (a weekend due day takes Monday's), and
  // each fund pays on its own day after it; the run settles when the last has
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders WHERE user_id = ? AND side = 'sell'`, u!.id)[0]!.n, { timeout: 60_000 }).toBe(2)
  const navDay = s.query<{ m: string }>(`SELECT meta_json m FROM pv_orders WHERE user_id = ? AND side = 'sell'`, u!.id).map((r) => (JSON.parse(r.m) as { minNavDate: string }).minNavDate).sort().at(-1)!
  writeFileSync(navFile, navDay)
  moveClockTo(Date.parse(`${navDay}T21:00:00+05:30`))
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_fills WHERE user_id = ? AND side = 'sell'`, u!.id)[0]!.n, { timeout: 60_000 }).toBe(2)
  moveClockTo(Date.parse(`${navDay}T21:00:00+05:30`) + 5 * 86_400_000)
  await expect.poll(() => s.query<{ state: string }>(`SELECT state FROM runs WHERE program_id = ?`, prog!.id)[0]?.state, { timeout: 120_000 }).toBe('done')
  const paid = s.query<{ cash_done: number }>(`SELECT f.cash_done FROM pv_fills f WHERE f.user_id = ? AND f.side = 'sell'`, u!.id)
  expect(paid.length).toBe(2); expect(paid.every((f) => f.cash_done === 1)).toBe(true)
  const receipts = s.query<{ n: number }>(`SELECT COUNT(*) n FROM receipts r WHERE r.user_id = ? AND r.kind = 'order' AND r.body_json LIKE '%"kind":"swp"%'`, u!.id)[0]!.n
  expect(receipts).toBe(2)

  // 6. the instruction's page lists the run with a link to each sale; each record says when its money arrived
  await page.goto(`${s.base}/instructions/${prog!.id}`)
  await expect(page.getByRole('link', { name: /Sell .*HDFC Overnight|HDFC Overnight/ }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('main').getByText('UTI Nifty 50 Index Fund').first()).toBeVisible()
})
