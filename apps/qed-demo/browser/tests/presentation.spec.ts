/**
 * Presentation mode (N-003): a separate installation for showing the wallet to people other than the account holder.
 * Every screen says its values are synthetic; no source on screen is a market data provider; the database holds no
 * quote, NAV history or limit from a live provider, and the API refuses to start on one that does.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { fromAmountText } from '../../shared/amount-text.ts'
import { toNum } from '../../shared/fixed.ts'

const PORT = Number(process.env.QED_PRESENTATION_PORT ?? extraPort(12))
// Both tests share one stack on one port, so they run in one worker, one after the other.
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_QUOTE_TTL_SEC: '6' }) })
test.afterAll(async () => { await s?.stop() })

test('presentation mode: every screen says its values are synthetic, and nothing from a live provider is in the database or named as a source', async ({ page }) => {
  await addAuthenticator(page)
  const banner = page.getByRole('note').filter({ hasText: 'Presentation mode: market prices, NAVs, rates and their history are synthetic' })
  await page.goto(`${s.base}/`)
  await expect(banner).toBeVisible()
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`demo${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Demo Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  // the synthetic provider has produced values for the screens to show
  await expect.poll(() => s.query<{ n: number }>('SELECT COUNT(*) n FROM quotes')[0]!.n, { timeout: 15_000 }).toBeGreaterThan(10)
  for (const path of ['/', '/holdings', '/pay', '/save', '/instructions', '/instructions/new?kind=invest', '/earn', '/protect', '/safeguards', '/security', '/workspace', '/workspace/desk', '/holdings/lab', '/holdings/idea', '/tax', '/vault', '/ask', '/activity', '/passbook', '/evidence', '/readiness', '/more']) {
    await page.goto(`${s.base}${path}`)
    await expect(banner, path).toBeVisible()
    await page.locator('main').first().waitFor()
    const text = await page.locator('main').first().innerText()
    expect(text, path).not.toMatch(/(?:from|by|on|through) (?:CoinDCX|AMFI|Binance|Coinbase|the ECB|the New York Fed|mfapi\.in)/)
    expect(text, path).not.toMatch(/\((?:Binance|Coinbase|ECB reference)\)/)
  }
  // two providers, both generated on this computer: 'synthetic' (crypto, funds, rates) and 'synthetic-markets' (the paper
  // exchange's shares, ETFs, bills and bonds, whose label on screen reads "Synthetic prices ... not market data")
  expect(s.query('SELECT DISTINCT provider FROM quotes ORDER BY provider')).toEqual([{ provider: 'synthetic' }, { provider: 'synthetic-markets' }])
  expect(s.query('SELECT DISTINCT source FROM daily_values ORDER BY source')).toEqual([{ source: 'synthetic' }, { source: 'synthetic-markets' }])
  expect(s.query(`SELECT COUNT(*) n FROM terms WHERE status = 'calibrated'`)).toEqual([{ n: 0 }])
})

test('an order estimate says when and where it was priced, counts down, and cannot be signed once it has lapsed (R7-094)', async ({ page }) => {
  await addAuthenticator(page)
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`quote${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Quote Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id = 'coindcx:BTCINR'`)[0]!.n, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption('coindcx:BTCINR')
  await page.getByLabel('With how much').fill('2000')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet.getByText(/Priced on synthetic values generated on this computer \(presentation mode\)'s order book at \d\d:\d\d:\d\d\. This estimate holds for \d+ more seconds/)).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeEnabled()
  // the test stack's quotes hold for 6 seconds (60 normally)
  await expect(sheet.getByText(/This estimate has lapsed: close this and see what it would do again/)).toBeVisible({ timeout: 10_000 })
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeDisabled()
  const [ap] = s.query<{ expires_at: number; created_at: number; document: string }>(`SELECT expires_at, created_at, document FROM approvals WHERE purpose = 'action' ORDER BY created_at DESC LIMIT 1`)
  expect(ap!.expires_at - ap!.created_at).toBe(6000)
  expect((JSON.parse(ap!.document) as { quote?: { source: string } }).quote?.source).toBe('synthetic')
})

test('an order’s receipt states its reference price, spread, average, fee and what was delivered, and that the ledger moved exactly that (R7-096)', async ({ page }) => {
  await addAuthenticator(page)
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  const handle = `cost${Date.now().toString(36)}`
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Cost Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption('coindcx:BTCINR')
  await page.getByLabel('With how much').fill('2000')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('dialog', { name: 'Approve this order' }).getByRole('button', { name: 'Approve and send with your passkey' }).click()
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await expect.poll(() => s.query<{ state: string; recon_state: string; receipt_id: string | null }>(`SELECT state, recon_state, receipt_id FROM actions WHERE user_id = ? AND kind = 'order'`, u!.id)[0], { timeout: 30_000 }).toMatchObject({ state: 'done', recon_state: 'reconciled' })
  const [a] = s.query<{ receipt_id: string }>(`SELECT receipt_id FROM actions WHERE user_id = ? AND kind = 'order'`, u!.id)
  const [r] = s.query<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', a!.receipt_id)
  const costs = (JSON.parse(r!.body_json) as { costs: { cashBooked: string; ledgerAgrees: boolean } }).costs
  expect(costs.ledgerAgrees).toBe(true)
  await page.goto(`${s.base}/receipts/${a!.receipt_id}`)
  await expect(page.getByText(/^The best ask, ₹[\d,]+\.\d\d, on synthetic values generated on this computer \(presentation mode\)'s order book it filled against/)).toBeVisible()
  await expect(page.getByText(/between the best bid and ask/)).toBeVisible()
  const ledgerText = await page.getByText(/^Agrees: it moved exactly ₹/).innerText()
  expect(Math.round(Number(ledgerText.match(/₹([\d,]+\.\d\d)/)![1]!.replace(/,/g, '')) * 100)).toBe(-Number(costs.cashBooked))
})

test('an order larger than the book fills in part: the estimate says so first, the record says what filled and that the rest was cancelled, and the ledger moved only what filled (R7-101)', async ({ page }) => {
  await addAuthenticator(page)
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  const handle = `part${Date.now().toString(36)}`
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Partial Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id = 'coindcx:USDTINR'`)[0]!.n, { timeout: 15_000 }).toBeGreaterThan(0)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const bank = () => toNum(fromAmountText(s.query<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts c ON c.id = b.account_id WHERE c.user_id = ? AND c.code = 'bank'`, u!.id)[0]?.t, 'the bank balance'))
  const before = bank()

  // the synthetic book shows ten levels of 500 USDT a side, about ₹4.4 lakh in all: ₹6,00,000 cannot all fill
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption('coindcx:USDTINR')
  await page.getByLabel('With how much').fill('600000')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet.getByText('The book does not show enough size for all of this right now; it would fill in part.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  // the engine commits the final state, then issues the receipt in its next transaction (server/execute.ts stepAction,
  // finishWithReceipt): wait for both, as the test above waits for its order's receipt (24 Nov: read between the two)
  await expect.poll(() => s.query<{ state: string; receipted: number }>(`SELECT state, receipt_id IS NOT NULL AS receipted FROM actions WHERE user_id = ? AND kind = 'order'`, u!.id)[0], { timeout: 30_000 }).toEqual({ state: 'partial', receipted: 1 })
  const [a] = s.query<{ id: string; receipt_id: string | null }>(`SELECT id, receipt_id FROM actions WHERE user_id = ? AND kind = 'order'`, u!.id)

  // the record says it was partly done and why, never "done"
  await page.goto(`${s.base}/record/${a!.id}`)
  await expect(page.getByText('Partly completed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Filled what the book offered; the rest was cancelled\./).first()).toBeVisible()

  // the bank moved only what filled, and the receipt agrees with the ledger
  const moved = before - bank()
  expect(moved).toBeGreaterThan(0)
  expect(moved).toBeLessThan(60_000_000)
  expect(a!.receipt_id).not.toBeNull()
  const [r] = s.query<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', a!.receipt_id!)
  const costs = (JSON.parse(r!.body_json) as { costs: { cashBooked: string; ledgerAgrees: boolean } }).costs
  expect(costs.ledgerAgrees).toBe(true)
  expect(-Number(costs.cashBooked)).toBe(moved)
})
