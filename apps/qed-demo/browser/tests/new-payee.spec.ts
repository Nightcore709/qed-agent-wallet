/**
 * A new payee from start to finish (R12 task comparison, gap 4). Safeguards sets the household's amount for a payee's first
 * day, confirmed with the passkey. Spend chooses nobody on arrival. Adding a payee runs the paper bank's name check before
 * it is saved: a close match shows the name typed beside the name the paper bank holds, and the registered name is taken.
 * A payment above the amount waits: it is said before the terms are asked for, and the sheet and the record give the time
 * it is sent and why. One is cancelled while it waits (nothing is sent, its money is free again); another is sent by the
 * engine when its wait ends, not before. The stack is this file's own, with the wait shortened (a test stack's
 * QED_NEW_PAYEE_HOLD_SEC, which every sentence labels as such), so nothing sleeps for hours. The database is read to check
 * what the screens say.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { choosePayeeOnSpend } from '../support/payee.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_NEW_PAYEE_PORT ?? extraPort(28))
const HOLD_SEC = 40
let s: Awaited<ReturnType<typeof startExtraStack>>
// one stack on one port for the file, so its tests run one after the other in one worker (the suite is fully parallel)
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_NEW_PAYEE_HOLD_SEC: String(HOLD_SEC) }) })
test.afterAll(async () => { await s?.stop() })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
/** "24 Nov, 17:05", as the interface writes a day and a time (India time). */
const dayTime = (ms: number): string => { const d = new Date(ms + 19_800_000); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }

async function newOwner(page: Page): Promise<string> {
  const handle = unique('npy')
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

test('a close match takes the registered name; a payment above the amount waits, is cancelled; another is sent when its wait ends', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const profile = () => JSON.parse(s.query<{ p: string }>('SELECT profile_json p FROM users WHERE id = ?', person!.id)[0]!.p) as { newPayeeHoldAbove?: number }
  type Act = { id: string; economic_id: string; state: string; params_json: string }
  const payments = () => s.query<Act>(`SELECT id, economic_id, state, params_json FROM actions WHERE user_id = ? AND kind = 'payment' ORDER BY created_at`, person!.id)
  const holdOf = (a: Act) => (JSON.parse(a.params_json) as { hold: { until: number } }).hold.until

  // the household's amount for a payee's first day, set in Safeguards and confirmed with the passkey
  await page.goto(`${s.base}/safeguards#new-payees`)
  const row = page.getByRole('region', { name: 'Payments to new payees' })
  await expect(row.getByText(`Test mode: on this installation every such wait lasts ${HOLD_SEC} seconds, whatever is set here.`)).toBeVisible()
  await row.getByRole('button', { name: 'Change the amount or the wait' }).click()
  await row.getByLabel('Payments wait above').fill('5000')
  await row.getByRole('button', { name: /^(Save|Confirm with your passkey and save)$/ }).click()
  await expect.poll(() => profile().newPayeeHoldAbove).toBe(500_000)
  await expect(row.getByText(/a payment that takes what you send it above ₹5,000 waits 24 hours before it is sent/)).toBeVisible()

  // adding the payee: the paper bank holds a slightly different name, shown beside the one typed; the registered name is taken
  await page.goto(`${s.base}/pay`)
  await page.getByLabel('Name', { exact: true }).fill('Ravi Kumaar')
  await page.getByLabel('Payment address').fill('ravi.kumar@upi')
  await page.getByRole('button', { name: 'Add this payee' }).click()
  await expect(page.getByText('The paper bank holds a slightly different name', { exact: true })).toBeVisible()
  const names = page.locator('.pay-names')
  await expect(names).toContainText('You gave')
  await expect(names).toContainText('Ravi Kumaar')
  await expect(names).toContainText('The paper bank holdsRavi Kumar')
  expect(s.query('SELECT 1 FROM payees WHERE user_id = ?', person!.id)).toEqual([])
  await page.getByRole('button', { name: 'Use the registered name' }).click()
  const to = page.getByRole('radiogroup', { name: 'To' })
  await expect(to.getByRole('radio', { name: 'Ravi Kumar (ravi.kumar@upi)' })).toBeChecked()
  expect(s.query('SELECT name, name_check, registered_name FROM payees WHERE user_id = ?', person!.id)).toEqual([{ name: 'Ravi Kumar', name_check: 'match', registered_name: 'Ravi Kumar' }])
  // the answer is shown with the payee before any payment
  // with where the answer comes from and what it cannot tell (R13 section 4)
  await expect(page.getByText(/^Name check: Matches the name the paper bank holds for this address: Ravi Kumar\. Made when the payee was added, against the paper bank's own directory on this computer; no real bank or NPCI was asked\. It can say only whether a name matches the one held for the address, not who controls the account or whether someone is pressing you to pay\.$/)).toBeVisible()

  /** Pay the chosen payee; the wait is said before the terms are asked for, and the sheet gives its time and reason. */
  async function payAndApprove(amount: string): Promise<void> {
    await page.getByLabel('How much').fill(amount)
    await expect(page.locator('#pay-review').getByText(`After a wait of ${HOLD_SEC} seconds: a new payee's first day, above ₹5,000`)).toBeVisible()
    await page.getByRole('button', { name: 'See what this would do' }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByText('Added today, and never paid before. Check the address with them yourself before you send.')).toBeVisible()
    await expect(sheet.getByText(new RegExp(`^It is sent at \\d+ \\w{3} \\d{4}, \\d\\d:\\d\\d IST, not before: Ravi Kumar was added today at \\d\\d:\\d\\d, and in a payee's first 24 hours what you send it above ₹5,000 waits ${HOLD_SEC} seconds \\(shortened on this test installation; set to 24 hours\\) before it is sent, as set in Safeguards\\. Until then you can cancel it on its record\\.$`))).toBeVisible()
    await expect(sheet.getByText(/^Not before \d+ \w{3} \d{4}, \d\d:\d\d IST$/)).toBeVisible()
    await expect(sheet.getByText('Matches the name the paper bank holds for this address: Ravi Kumar', { exact: true })).toBeVisible()
    await expect(sheet.getByText(/against the paper bank's own directory on this computer; no real bank or NPCI was asked\./)).toBeVisible()
    await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
    await expect(sheet).toBeHidden()
  }

  // the first: it waits, its money set aside, and the card says when it is sent and offers to cancel it
  await payAndApprove('6000')
  const card = page.locator('.ps-sent')
  await expect(card.getByText(/^Signed, and on hold\. It is sent at \d\d:\d\d, not before\. Its money is set aside until then, and you can cancel it\.$/)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Cancel this payment' })).toBeVisible()
  await expect.poll(() => payments().map((p) => p.state)).toEqual(['held'])
  const first = payments()[0]!
  expect(s.query('SELECT released_at FROM holds WHERE user_id = ? AND ref = ?', person!.id, `act:${first.id}`)).toEqual([{ released_at: null }])

  // its record gives the time it is sent and why; cancelled there, nothing is sent and the money is free again
  await card.getByRole('link', { name: 'Its record and receipt' }).click()
  await expect(page.getByText('Approved and set aside: it leaves your bank when its wait ends')).toBeVisible()
  await expect(page.getByText(/^You approved it, and it waits before it is sent\. It is sent at \d\d:\d\d, not before\./)).toBeVisible()
  await expect(page.locator('.ac-hold-why')).toContainText('Ravi Kumar was added today at')
  await expect(page.getByText(`Waits until ${dayTime(holdOf(first))}`, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel this payment' }).click()
  await expect.poll(() => payments()[0]!.state).toBe('cancelled')
  await expect(page.getByText('Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.').first()).toBeVisible()
  expect(s.query('SELECT released_at IS NOT NULL r FROM holds WHERE ref = ?', `act:${first.id}`)).toEqual([{ r: 1 }])
  expect(s.query('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', first.economic_id)).toEqual([{ n: 0 }])

  // Spend again: nobody is chosen on arrival, so nothing can be reviewed until the person chooses
  await page.goto(`${s.base}/pay`)
  await expect(to.getByRole('radio', { name: 'Ravi Kumar (ravi.kumar@upi)' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'See what this would do' })).toBeDisabled()
  await choosePayeeOnSpend(page, 'ravi.kumar@upi')

  // the second: it waits too, and the engine sends it when its wait ends, not before
  await payAndApprove('7000')
  await expect.poll(() => payments()[1]?.state, { timeout: 15_000 }).toBe('held')
  const second = payments()[1]!
  expect(s.query('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', second.economic_id)).toEqual([{ n: 0 }])
  await expect.poll(() => payments()[1]!.state, { timeout: (HOLD_SEC + 40) * 1000 }).toBe('done')
  const [onRail] = s.query<{ created_at: number }>('SELECT created_at FROM pv_payments WHERE client_ref = ?', second.economic_id)
  expect(onRail!.created_at).toBeGreaterThanOrEqual(holdOf(second))
  // its money stayed set aside for the whole wait, through the engine's reconciliation every half minute
  const [setAside] = s.query<{ released_at: number }>('SELECT released_at FROM holds WHERE ref = ?', `act:${second.id}`)
  expect(setAside!.released_at).toBeGreaterThanOrEqual(holdOf(second))
  await page.goto(`${s.base}/record/${second.id}`)
  await expect(page.getByText('Its wait ended', { exact: true })).toBeVisible()
  await expect(page.getByText('Set aside to wait', { exact: true })).toBeVisible()
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
})

test('loosening the wait waits out the protection delay, announced, and a passkey cancels it; tightening is at once', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const profile = () => JSON.parse(s.query<{ p: string }>('SELECT profile_json p FROM users WHERE id = ?', person!.id)[0]!.p) as { newPayeeHoldAbove: number; newPayeeHoldHours: number }
  const waiting = () => s.query<{ id: string; cancelled_at: number | null; applied_at: number | null }>(`SELECT id, cancelled_at, applied_at FROM scheduled_changes WHERE person_id = ? AND kind = 'loosen-profile' ORDER BY requested_at`, person!.id)
  await page.goto(`${s.base}/safeguards#new-payees`)
  const row = page.getByRole('region', { name: 'Payments to new payees' })

  // a higher amount is looser: the form says it waits, and once saved nothing changes yet
  await row.getByRole('button', { name: 'Change the amount or the wait' }).click()
  await row.getByLabel('Payments wait above').fill('50000')
  await expect(row.getByText(/so it takes effect only after 6 seconds here \(72 hours normally\); until then any of your passkeys can cancel it, and you, and any recovery contacts you have, are told in QED\./)).toBeVisible()
  await row.getByRole('button', { name: /^(Save|Confirm with your passkey and save)$/ }).click()
  const top = page.getByRole('region', { name: /^Waiting until .+: a change that loosens your protections$/ })
  await expect(top).toBeVisible()
  await expect(top.getByText('New payees: payments wait above: ₹10,000 becomes ₹50,000', { exact: true })).toBeVisible()
  await expect(row.getByText(/^Waiting until .+, unless cancelled\. New payees: payments wait above: ₹10,000 becomes ₹50,000\. See the change$/)).toBeVisible()
  expect(profile().newPayeeHoldAbove).toBe(1_000_000)
  // announced at once, in the person's notices
  expect(s.query(`SELECT title FROM notices WHERE user_id = ? AND kind = 'security-change' AND title = 'A change that loosens your protections is scheduled'`, person!.id)).toHaveLength(1)
  // when the delay ends the engine applies it, and the page says what is in force
  await expect.poll(() => profile().newPayeeHoldAbove, { timeout: 60_000 }).toBe(5_000_000)
  await page.reload()
  await expect(row.getByText(/a payment that takes what you send it above ₹50,000 waits 24 hours before it is sent/)).toBeVisible()
  await expect(page.getByRole('region', { name: /a change that loosens your protections$/ })).toHaveCount(0)
  expect(s.query(`SELECT title FROM notices WHERE user_id = ? AND title = 'A change that loosens your protections took effect'`, person!.id)).toHaveLength(1)

  // switching the wait off is looser too; a passkey cancels it before it takes effect
  await row.getByRole('button', { name: 'Change the amount or the wait' }).click()
  await row.getByLabel('For how long').selectOption({ label: 'No wait (off)' })
  await row.getByRole('button', { name: /^(Save|Confirm with your passkey and save)$/ }).click()
  await expect(top.getByText('New payees: the wait: 24 hours becomes no wait', { exact: true })).toBeVisible()
  await top.getByRole('button', { name: /^(Cancel this change|Confirm with your passkey and cancel this change)$/ }).click()
  await expect(top).toBeHidden()
  await expect.poll(() => waiting().at(-1)?.cancelled_at ?? null).not.toBeNull()
  await page.waitForTimeout(8000)
  expect(profile().newPayeeHoldHours).toBe(24)
  expect(waiting().at(-1)?.applied_at).toBeNull()

  // a lower amount is tighter: at once, nothing waits
  await row.getByRole('button', { name: 'Change the amount or the wait' }).click()
  await row.getByLabel('Payments wait above').fill('2000')
  await row.getByRole('button', { name: /^(Save|Confirm with your passkey and save)$/ }).click()
  await expect.poll(() => profile().newPayeeHoldAbove).toBe(200_000)
  await expect(page.getByRole('region', { name: /a change that loosens your protections$/ })).toHaveCount(0)
})
