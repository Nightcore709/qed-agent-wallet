/**
 * Savings automation, a payment by hand and a wallet operation, together, under the aggregate limit and the reserve
 * (R7-047; audit SV4). One household with a wallet signs a goal that runs by itself, pays a payee from its bank, and pays
 * from its on-chain wallet; then the clock moves to the goal's first contribution day and the instruction runs on its own.
 * Read against the server: the wallet payment moved no rupee figure (the reserve, what is free, the bank); the table of
 * "the most your instructions could take" on Safeguards is the server's envelope; the contribution that ran is within
 * the monthly limit that was signed; and the household is not short afterwards. The property test of the same name
 * (server/aggregate-limits.test.ts) covers random interleavings; this is one journey through the interface.
 * Runs on a stack of its own, with a vault service and a clock the journey moves.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '../support/test.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { household } from '../support/vault.ts'

const PORT = Number(process.env.QED_TOGETHER_PORT ?? extraPort(76))
const dir = mkdtempSync(join(tmpdir(), 'qed-together-clock-'))
const CLOCK = join(dir, 'offset')
writeFileSync(CLOCK, '0')
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => {
  test.setTimeout(180_000)
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_CLOCK_FILE: CLOCK, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' }, { rail: true })
})
test.afterAll(async () => { await s?.stop() })

const moveClockTo = (at: number): void => { writeFileSync(CLOCK, String(Math.max(0, Math.round(at - Date.now())))) }
const paise = (text: string): number => { const m = /₹\s*([\d,]+)(?:\.(\d{1,2}))?/.exec(text); if (!m) throw new Error(`no rupee figure in "${text}"`); return Number(m[1]!.replace(/,/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) }
interface Liq { liquidity: { need: number; free: number; short: number; available: number }; envelope: { windows: { days: number; most: number }[]; instructions: { id: string; title: string; most: number[] }[] } }
const api = async <T,>(page: Page, path: string): Promise<T> => (await (await page.request.get(`${s.base}${path}`)).json()) as T
const figures = async (page: Page) => { const l = await api<Liq>(page, '/api/liquidity'); const h = await api<{ overview: { bank: number; bankAvailable: number; netWorth: number } }>(page, '/api/home'); return { need: l.liquidity.need, free: l.liquidity.free, short: l.liquidity.short, bank: h.overview.bank, bankAvailable: h.overview.bankAvailable, net: h.overview.netWorth } }

test('a goal that runs by itself, a payment from the bank and a payment from the wallet, together: each within its limit, the wallet moving no rupee figure, the reserve held', async ({ browser }) => {
  test.setTimeout(420_000)
  const a = await household(browser, s.base, s.query)
  const page = a.page
  const me = a.personId

  // ---- a goal that runs by itself, signed with the passkey
  await page.goto(`${s.base}/save`)
  await page.locator('#goals').getByRole('link', { name: 'Save for a goal' }).click()
  const today = new Date(Date.now() + 19_800_000)
  const by = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 5, 0)).toISOString().slice(0, 10)
  await page.getByLabel('What it is for').fill('Holiday in March')
  await page.getByLabel('How much').fill('50000')
  await page.getByLabel('By', { exact: true }).fill(by)
  await page.getByRole('radio', { name: /^On its own/ }).check()
  await page.getByRole('button', { name: 'Review and sign' }).click()
  const sheet = page.getByRole('dialog', { name: 'Sign this instruction' })
  await sheet.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [prog] = s.query<{ id: string; next_due_at: number; authority_json: string }>(`SELECT p.id, p.next_due_at, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ?`, me)
  const signed = JSON.parse(prog!.authority_json) as { runMode: string; maxPerMonth: number; maxPerRun: number }
  expect(signed.runMode).toBe('auto')

  // ---- a payment by hand from the bank
  await page.goto(`${s.base}/pay`)
  // the payee, as a person adds one on Spend (support/payee.ts, exact names): the payee abroad has its own button,
  // "Add a payee abroad", and its own form, opened only by that button
  await addPayeeOnSpend(page, 'Corner Shop', 'cornershop@okbank')
  await page.getByLabel('How much').fill('500')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => s.query<{ state: string }>(`SELECT state FROM actions WHERE user_id = ? AND kind = 'payment' AND origin = 'owner'`, me)[0]?.state, { timeout: 40_000 }).toBe('done')

  // ---- a wallet operation: the mandate, then a payment from the wallet, each signed with the passkey
  const signInSheet = async (): Promise<void> => {
    const d = page.getByRole('dialog')
    await expect(d.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
    await d.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  }
  await page.goto(`${s.base}/protect`)
  await page.getByRole('button', { name: 'Write a mandate' }).click()
  const mandate = page.getByRole('form', { name: 'A new mandate for your on-chain wallet' })
  await mandate.getByLabel('Most in one payment, in test rupees').fill('2500')
  await mandate.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet()
  await expect(page.getByText('Signed: the new mandate is in force on the chain.')).toBeVisible({ timeout: 60_000 })
  const before = await figures(page)
  await page.goto(`${s.base}/pay`)
  await page.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
  const pay = page.getByRole('form', { name: 'Pay from your on-chain wallet' })
  await expect(pay.getByText(/Most that can be paid now/)).toBeVisible({ timeout: 20_000 })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet()
  await expect(pay.getByText('Paid ₹3.00 in test rupees to CloudCo from your on-chain wallet.')).toBeVisible({ timeout: 60_000 })
  // the wallet payment moved no rupee figure: the reserve, what is free, the bank, the net position
  const afterWallet = await figures(page)
  expect(afterWallet).toEqual(before)

  // ---- the aggregate: Safeguards' table of the most the instructions could take is the server's envelope
  await page.goto(`${s.base}/safeguards`)
  const env = (await api<Liq>(page, '/api/liquidity')).envelope
  const row = page.locator('table.env-table tbody tr').filter({ has: page.getByRole('link', { name: /Holiday in March/ }) }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('td.num')).toHaveCount(3)
  const cells = await row.locator('td.num').allTextContents()
  expect(cells.map(paise)).toEqual(env.instructions.find((i) => i.id === prog!.id)!.most.map((m) => Math.round(m / 100) * 100))
  const thirty = env.windows.find((w) => w.days === 30)!.most
  expect(thirty).toBeLessThanOrEqual(2 * signed.maxPerMonth)   // a monthly limit can allow two months' limits across a month's end

  // ---- the first contribution day: the instruction runs by itself, inside its signed monthly limit
  moveClockTo(prog!.next_due_at + 3_000)
  await expect.poll(() => s.query<{ state: string }>(`SELECT state FROM actions WHERE program_id = ?`, prog!.id).map((r) => r.state), { timeout: 40_000 }).toEqual(['done'])
  const moved = s.query<{ params_json: string }>(`SELECT params_json FROM actions WHERE program_id = ? AND state = 'done'`, prog!.id).reduce((t, r) => t + Number((JSON.parse(r.params_json) as { amount: string }).amount), 0)
  expect(moved).toBeGreaterThan(0)
  expect(moved).toBeLessThanOrEqual(signed.maxPerMonth)
  const end = await figures(page)
  expect(end.short).toBe(0)                                       // the reserve held: nobody was taken into a shortfall
  expect(end.bankAvailable).toBeGreaterThanOrEqual(end.need)
  // the contribution is in the goal's own set-aside, as the books hold it (the bank itself also took the month's salary and instalments)
  expect(Number(s.query<{ t: string }>(`SELECT b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code = ?`, me, `goal:${prog!.id}`)[0]?.t ?? 0)).toBe(moved)
  await page.goto(`${s.base}/`)
  await expect(page.locator('[data-reserve="kept"]')).toContainText('₹')
  expect(paise((await page.locator('[data-reserve="kept"]').textContent()) ?? '')).toBe(Math.min(end.bankAvailable, end.need))
})
