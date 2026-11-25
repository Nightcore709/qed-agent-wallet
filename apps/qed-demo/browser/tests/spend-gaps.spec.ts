/**
 * Spend's remaining gaps from the mandate omissions audit, in one journey (R13): a subscription found in the payment
 * history and reviewed, a payment that repeats an earlier one held for the person's confirmation and then confirmed with
 * the passkey, and a dispute pack for a disputed payment, downloaded as JSON and shown on a page that prints. The screen
 * is compared with the stack's own database. The two older payments the subscription rests on are written into this
 * stack's database as a fixture (a test cannot wait two months); the third is paid through the interface. Every
 * institution is simulated, and the page says so.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_SPEND_GAPS_PORT ?? extraPort(34))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const DAY = 86_400_000

async function newOwner(page: Page): Promise<string> {
  const handle = unique('spg')
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

/** Two earlier payments to a payee, written as the history a subscription rests on: settled, with their ledger entries. */
function seedHistory(userId: string, handle: string, name: string, paise: number, agesInDays: number[]): void {
  const d = new DatabaseSync(s.db)
  d.exec('PRAGMA busy_timeout = 10000')
  try {
    agesInDays.forEach((age, i) => {
      const at = Date.now() - age * DAY, eco = `seed-${i}-${Date.now()}`
      const m = (d.prepare('SELECT COALESCE(MAX(seq), 0) m FROM entries WHERE user_id = ?').get(userId) as { m: number }).m
      d.prepare(`INSERT INTO actions (id, user_id, origin, kind, venue, economic_id, state, params_json, created_at, updated_at) VALUES (?, ?, 'owner', 'payment', 'paper-rail', ?, 'done', ?, ?, ?)`)
        .run(`act_seed${i}${Date.now()}`, userId, eco, JSON.stringify({ payeeHandle: handle, payeeName: name, amount: String(paise), purpose: 'spend' }), at, at)
      d.prepare(`INSERT INTO entries (id, user_id, seq, ts, effective_ts, kind, ref, memo) VALUES (?, ?, ?, ?, ?, 'payment-sent', ?, 'Earlier payment (test fixture)')`).run(`ent_seed${i}${Date.now()}`, userId, m + 1, at, at, `pay:${eco}:out`)
    })
  } finally { d.close() }
}

async function payFromSpend(page: Page, amount: string): Promise<void> {
  await page.goto(`${s.base}/pay`)
  const to = page.getByRole('radiogroup', { name: 'To' })
  await to.locator('label').filter({ has: page.getByRole('radio', { name: /\(ravi\.kumar@upi\)$/ }) }).getByText('ravi.kumar@upi', { exact: true }).click()
  await page.getByLabel('How much').fill(amount)
  await page.getByRole('button', { name: 'See what this would do' }).click()
}

test('a subscription is found and reviewed; a repeat is held and confirmed; a disputed payment has a pack, downloaded and printable', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto(`${s.base}/pay`)
  await addPayeeOnSpend(page, 'Ravi Kumar', 'ravi.kumar@upi')
  seedHistory(person!.id, 'ravi.kumar@upi', 'Ravi Kumar', 50_000, [60, 30])
  type Act = { id: string; economic_id: string; state: string; result_json: string }
  const payments = () => s.query<Act>(`SELECT id, economic_id, state, result_json FROM actions WHERE user_id = ? AND kind = 'payment' AND id NOT LIKE 'act_seed%' ORDER BY created_at`, person!.id)

  // 1. the third monthly payment, through the interface: it settles
  await payFromSpend(page, '500')
  let sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Repeat of an earlier payment')).toHaveCount(0) // the older two are months ago, not within 24 hours
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(sheet).toBeHidden()
  await expect.poll(() => payments()[0]?.state, { timeout: 30_000 }).toBe('done')

  // 2. the subscription: found, with its cost, its next date and its evidence; reviewed as one the person must cancel
  await page.goto(`${s.base}/pay`)
  const subs = page.getByRole('region', { name: 'Subscriptions' })
  await expect(subs.getByText('Ravi Kumar', { exact: true })).toBeVisible()
  await expect(subs.getByText('ravi.kumar@upi, monthly')).toBeVisible()
  await expect(subs.locator('.sub-cost')).toContainText('₹500.00')
  await expect(subs.locator('.sub-cost')).toContainText('₹6,000.00 a year')
  await expect(subs.getByText(/^Next payment expected \d+ \w{3}\. Last paid \d+ \w{3}\.$/)).toBeVisible()
  await subs.getByText('The 3 payments this rests on').click()
  await expect(subs.locator('.sub-evidence li')).toHaveCount(3)
  await expect(subs.getByText('QED holds no instruction or mandate for this payee.')).toBeVisible()
  await expect(subs.getByRole('button', { name: /^Stop QED.s instruction for it/ })).toBeDisabled()
  await subs.getByText('How a subscription is found').click()
  await expect(subs.getByText(/at least 3 times, every gap between payments fits one cadence/)).toBeVisible()
  await subs.getByRole('button', { name: /^I must cancel it with them/ }).click()
  await expect(subs.getByText('You are cancelling this one yourself')).toBeVisible()
  await expect(subs.getByText(/QED cannot cancel a subscription with the merchant/).first()).toBeVisible()
  expect(s.query('SELECT state FROM subscription_reviews WHERE user_id = ? AND payee_handle = ?', person!.id, 'ravi.kumar@upi')).toEqual([{ state: 'cancel-myself' }])

  // 3. a second, separately approved payment of the same amount to the same payee: the rule is on the page (R14: behind the
  // disclosure under Payments so far, every word kept) and on the sheet, and it is held
  await page.getByRole('region', { name: 'Payments so far' }).getByText('When a payment that repeats an earlier one is held').click()
  await expect(page.getByText(/the same bill, or the same payee and the same amount within 24 hours/).first()).toBeVisible()
  await payFromSpend(page, '500')
  sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Repeat of an earlier payment', { exact: true })).toBeVisible()
  await expect(sheet.getByText('Held for your confirmation before it is sent', { exact: true })).toBeVisible()
  await expect(sheet.getByText(/You already sent ₹500 to Ravi Kumar/).first()).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(sheet).toBeHidden()
  const card = page.locator('.ps-sent')
  await expect(card.getByText(/It waits for your confirmation, because it repeats an earlier payment/)).toBeVisible()
  await expect.poll(() => payments()[1]?.state).toBe('held')
  const second = payments()[1]!
  expect(JSON.parse(second.result_json).awaitingConfirmation).toMatchObject({ expiresAt: expect.any(Number) })
  expect(s.query('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', second.economic_id)).toEqual([{ n: 0 }])
  expect(s.query('SELECT released_at FROM holds WHERE ref = ?', `act:${second.id}`)).toEqual([{ released_at: null }])
  // confirmed with a fresh passkey confirmation: then it is sent
  await card.getByRole('button', { name: 'Send it anyway, I meant to pay twice' }).click()
  // the server asks for a fresh passkey confirmation when the session has none; it goes ahead by itself when it has
  const again = card.getByRole('button', { name: 'Confirm with your passkey' })
  await again.waitFor({ state: 'visible', timeout: 3_000 }).then(() => again.click()).catch(() => undefined)
  await expect.poll(() => payments()[1]!.state, { timeout: 30_000 }).toBe('done')
  expect(s.query('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', second.economic_id)).toEqual([{ n: 1 }])

  // 4. a dispute on the first payment, and its pack
  const first = payments()[0]!
  await page.goto(`${s.base}/record/${first.id}`)
  await page.getByRole('button', { name: 'Dispute this payment' }).click()
  await page.getByLabel('What went wrong').fill('The payee says they never received it')
  await page.getByRole('button', { name: 'Raise the dispute' }).click()
  await expect(page.getByRole('heading', { name: 'Dispute open' })).toBeVisible()
  await page.getByRole('link', { name: 'Open the dispute pack' }).click()
  await expect(page.getByRole('heading', { name: 'Dispute pack' })).toBeVisible()
  await expect(page.getByText(/Simulated: the paper bank, the paper rail and every reference below are QED's local simulation/)).toBeVisible()

  const [approval] = s.query<{ doc_hash: string }>('SELECT doc_hash FROM approvals WHERE id = (SELECT approval_id FROM actions WHERE id = ?)', first.id)
  const [rail] = s.query<{ reference: string }>('SELECT reference FROM pv_payments WHERE client_ref = ?', first.economic_id)
  await expect(page.getByText(approval!.doc_hash)).toBeVisible()
  await expect(page.getByText(rail!.reference, { exact: true })).toBeVisible()
  for (const step of ['requested', 'approved', 'sent', 'bank reference', 'settled', 'dispute opened']) await expect(page.locator('.dp-timeline b', { hasText: new RegExp(`^${step}$`) })).toBeVisible()
  const receipts = s.query<{ hash: string }>(`SELECT hash FROM receipts WHERE user_id = ? AND subject = ? ORDER BY seq`, person!.id, first.id)
  expect(receipts.length).toBeGreaterThan(0)
  for (const r of receipts) await expect(page.getByText(`hash ${r.hash}`)).toBeVisible()
  await expect(page.getByText(/Your whole receipt chain \(\d+\) verifies\./)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print this page' })).toBeVisible()
  // the JSON download carries the same approval, receipts and bank reference
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download as JSON' }).click()
  const file = await (await download).path()
  const pack = JSON.parse(readFileSync(file!, 'utf8')) as { simulated: boolean; approval: { docHash: string }; bank: { reference: string; simulated: boolean }; receipts: { hash: string }[]; receiptChain: { verified: boolean } }
  expect(pack).toMatchObject({ simulated: true, approval: { docHash: approval!.doc_hash }, bank: { reference: rail!.reference, simulated: true }, receiptChain: { verified: true } })
  expect(pack.receipts.map((r) => r.hash)).toEqual(receipts.map((r) => r.hash))
  // N-018: the pack is verifiable offline (the script reads only the file), and a changed copy is caught
  const verify = (f: string) => spawnSync(process.execPath, ['scripts/verify-dispute-pack.ts', f], { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8' })
  expect(verify(file!).status).toBe(0)
  const tampered = join(dirname(file!), 'tampered-pack.json'); writeFileSync(tampered, readFileSync(file!, 'utf8').replace(/"amount":"(\d+)"/, '"amount":"1"'))
  expect(verify(tampered).status).toBe(1)
  // N-018: reporting the problem paused QED's own payments on the rail; the page says so, shows the deadline, the draft notice
  // (labelled a draft the person sends) and the escalation route; releasing the pause needs the passkey and is timestamped
  expect(s.query('SELECT scope, released_at FROM dispute_pauses WHERE user_id = ?', person!.id)).toEqual([{ scope: 'payments:paper-rail', released_at: null }])
  await expect(page.getByRole('heading', { name: 'What QED is doing on this account' })).toBeVisible()
  await expect(page.getByText(/QED does not make payments on its own on this account until you release the pause/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Deadlines and where to escalate' })).toBeVisible()
  await expect(page.getByText(/Your bank decides; QED does not and cannot/).first()).toBeVisible()
  await expect(page.getByText(/RBI Ombudsman/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Draft notice to your bank' })).toBeVisible()
  await expect(page.getByText(/QED sends nothing to your bank: you send it yourself/)).toBeVisible()
  await expect(page.locator('.dp-notice')).toContainText('The payee says they never received it')
  await page.getByRole('button', { name: 'Release the pause' }).click()
  await expect(page.getByText('The pause has been released.')).toBeVisible()
  expect(s.query<{ released_at: number | null }>('SELECT released_at FROM dispute_pauses WHERE user_id = ?', person!.id)[0]!.released_at).not.toBeNull()
  // on paper the page keeps its content and drops the controls
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('button', { name: 'Print this page' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  await page.emulateMedia({ media: 'screen' })

  // 5. Activity shows the dispute's state
  await page.goto(`${s.base}/activity?view=list`)
  await expect(page.getByText('Dispute open').first()).toBeVisible()
})
