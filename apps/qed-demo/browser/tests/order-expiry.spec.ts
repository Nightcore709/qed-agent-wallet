/**
 * A resting order that stands until a time (R14, capability 13): the owner chooses how long it stands on the order form, the
 * sheet says it in words and the approval carries it, the order rests with its money set aside, and when its time comes the
 * engine ends it, frees the money once, and Grow and Activity say what filled before and what was released, in the household's
 * currency. On a presentation-mode stack whose clock is brought forward (never back) past the order's time.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_ORDER_EXPIRY_PORT ?? extraPort(112))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let dir = ''
let clockFile = ''
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qed-order-expiry-'))
  clockFile = join(dir, 'clock-offset')
  writeFileSync(clockFile, '0')
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_CLOCK_FILE: clockFile, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
test.afterAll(async () => { await s?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })
/** The stack's own time: the real time plus the offset an earlier journey of this file moved it by. */
const stackNow = (): number => Date.now() + Number(readFileSync(clockFile, 'utf8'))
const moveClockTo = (at: number): void => { writeFileSync(clockFile, String(Math.max(0, Math.round(at - Date.now())))) }

test('a limit order placed to stand a few minutes expires, its money is freed once, and Grow and Activity say so', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  const handle = `exp${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Expiry Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10) // R14: made with the first device, shown once, no box to tick
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const bank = () => Number(s.query<{ v: string }>(`SELECT b.amount_text v FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, u!.id)[0]!.v)
  const held = () => s.query<{ n: number }>(`SELECT COUNT(*) n FROM holds WHERE user_id = ? AND released_at IS NULL`, u!.id)[0]!.n
  const bank0 = bank()

  // the order form: a resting order, standing until a time three minutes ahead, India time
  const ahead = new Date(stackNow() + 19_800_000 + 3 * 60_000)
  const date = ahead.toISOString().slice(0, 10), time = ahead.toISOString().slice(11, 16)
  const expiresAt = Date.parse(`${date}T${time}:00+05:30`)
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption('coindcx:BTCINR')
  await page.getByLabel('With how much').fill('1000')
  await page.getByLabel('How', { exact: true }).selectOption('limit')
  await page.getByLabel('My price, in rupees').fill('1000')
  await expect(page.getByLabel('How long it stands')).toHaveValue('gtc')
  await page.getByLabel('How long it stands').selectOption('until')
  await page.getByLabel('Stands until this date, India time').fill(date)
  await page.getByLabel('At this time, India time').fill(time)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Stands until', { exact: true })).toBeVisible()
  await expect(sheet.getByText(/IST/).first()).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(page).toHaveURL(/\/record\/act_/)
  const id = page.url().split('/record/')[1]!
  const state = () => s.query<{ state: string; error: string | null }>('SELECT state, error FROM actions WHERE id = ?', id)[0]
  await expect.poll(() => state()?.state, { timeout: 40_000 }).toBe('working')
  expect(held()).toBe(1)
  await expect(page.getByText(/Stands until \d+ \w+ \d{4}, \d\d:\d\d IST/).first()).toBeVisible()
  // what it was approved for carries the time
  const [ap] = s.query<{ document: string }>(`SELECT document FROM approvals WHERE id = (SELECT approval_id FROM actions WHERE id = ?)`, id)
  expect((JSON.parse(ap!.document) as { action: { params: { validity: unknown } } }).action.params.validity).toEqual({ kind: 'until', expiresAt })

  // its time comes
  moveClockTo(expiresAt + 3000)
  await expect.poll(() => state()?.state, { timeout: 60_000 }).toBe('expired')
  expect(held()).toBe(0)
  expect(bank()).toBe(bank0)
  const [released] = s.query<{ n: number }>(`SELECT COUNT(*) n FROM holds WHERE user_id = ? AND released_at IS NOT NULL`, u!.id)
  expect(released!.n).toBe(1)
  const [notice] = s.query<{ body: string }>(`SELECT body FROM notices WHERE user_id = ? AND kind = 'order-expired'`, u!.id)
  expect(notice!.body).toMatch(/Nothing had filled\. ₹1,000\.00 that was set aside for it is free again\./)

  // Grow and Activity say it, with the date, in the household's currency
  const words = /Expired at \d+ \w+ \d{4}, \d\d:\d\d IST, ₹0\.00 filled before, ₹1,000\.00 released/
  await page.goto(`${s.base}/holdings`)
  await expect(page.locator('.gr-fills').getByText(words)).toBeVisible()
  await page.goto(`${s.base}/activity`)
  await expect(page.getByText(words).first()).toBeVisible()
  await page.goto(`${s.base}/record/${id}`)
  await expect(page.getByText(words).first()).toBeVisible()
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE id = ? AND recon_state = 'reconciled'`, id)[0]!.n).toBe(1)
})

test('a limit order that part-filled and then expired is a partly done order: the money that moved is shown, the rest is released', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  const handle = `exq${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Part Fill Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10) // R14: made with the first device, shown once, no box to tick
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const USDT = 'coindcx:USDTINR'
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id = ? AND price_type = 'ask'`, USDT)[0]!.n, { timeout: 30_000 }).toBeGreaterThan(0)
  // the synthetic book offers 500 USDT a level, each level 0.05% above the last: a limit a hair above the best ask reaches one level only
  const ask = Number(s.query<{ price: string }>(`SELECT price FROM quotes WHERE instrument_id = ? AND price_type = 'ask' ORDER BY recv_ts DESC LIMIT 1`, USDT)[0]!.price)
  const ahead = new Date(stackNow() + 19_800_000 + 3 * 60_000)
  const date = ahead.toISOString().slice(0, 10), time = ahead.toISOString().slice(11, 16)
  const expiresAt = Date.parse(`${date}T${time}:00+05:30`)
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption(USDT)
  await page.getByLabel('With how much').fill('90000')
  await page.getByLabel('How', { exact: true }).selectOption('limit')
  await page.getByLabel('My price, in rupees').fill((ask * 1.0002).toFixed(2))
  await page.getByLabel('How long it stands').selectOption('until')
  await page.getByLabel('Stands until this date, India time').fill(date)
  await page.getByLabel('At this time, India time').fill(time)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(page).toHaveURL(/\/record\/act_/)
  const id = page.url().split('/record/')[1]!
  const state = () => s.query<{ state: string }>('SELECT state FROM actions WHERE id = ?', id)[0]?.state
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, id)[0]!.n, { timeout: 40_000 }).toBeGreaterThan(0)
  moveClockTo(expiresAt + 3000)
  await expect.poll(state, { timeout: 60_000 }).toBe('partial')
  const [r] = s.query<{ result_json: string }>('SELECT result_json FROM actions WHERE id = ?', id)
  const res = JSON.parse(r!.result_json) as Record<string, unknown>
  expect(res.expired).toBe(true)
  expect(Number(res.movedPaise)).toBeGreaterThan(0)
  expect(Number(res.movedPaise) + Number(res.releasedPaise)).toBe(9_000_000)
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM holds WHERE user_id = ? AND released_at IS NULL`, u!.id)[0]!.n).toBe(0)

  const words = /Expired at \d+ \w+ \d{4}, \d\d:\d\d IST, ₹[\d,]+\.\d\d filled before, ₹[\d,]+\.\d\d released/
  await page.goto(`${s.base}/record/${id}`)
  await expect(page.getByText('Asked for; nothing moved')).toHaveCount(0)
  await expect(page.getByText('Left your bank account').first()).toBeVisible()
  await expect(page.getByText(words).first()).toBeVisible()
  await page.goto(`${s.base}/activity`)
  await expect(page.getByText(/Bought .+, in part/).first()).toBeVisible()
  await expect(page.getByText(words).first()).toBeVisible()
})
