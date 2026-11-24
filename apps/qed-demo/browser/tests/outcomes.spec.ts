/**
 * Outcomes other than success, read where a person reads them (R7-101): a payment the rail never answers is shown as
 * unanswered, with the instruction not to send it again, never as done or failed; a payment the rail declines says so
 * and says the money came back. The paper rail's test payees produce each outcome (README, "What to try"); the
 * database is read to check that what the screens say is what was recorded.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('out')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}
async function pay(page: Page, name: string, address: string, amount: string): Promise<void> {
  await page.goto('/pay')
  // the add form opens if needed; the paper bank's name check answers first; the payee just added is the one selected
  // (it once stayed on the previous payee)
  await addPayeeOnSpend(page, name, address)
  await page.getByLabel('How much').fill(amount)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('button', { name: 'Approve and send with your passkey' }).click()
}

test('a payment the rail never answers is shown as unanswered, not done or failed, with the money held; a declined one says so and that the money came back', async ({ page }) => {
  test.setTimeout(120_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  type Row = { id: string; state: string; result_json: string }
  const payment = (handle: string) => query<Row>(`SELECT id, state, result_json FROM actions WHERE user_id = ? AND kind = 'payment' AND params_json LIKE ?`, person!.id, `%${handle}%`)[0]

  // unanswered: the rail takes it and never says what happened
  await pay(page, 'Silent Shop', 'timeout@paper', '500')
  await expect.poll(() => { const r = payment('timeout@paper'); return r ? [r.state, (JSON.parse(r.result_json) as { railState?: string }).railState] : null }, { timeout: 30_000 }).toEqual(['working', 'unknown'])
  const silent = payment('timeout@paper')!
  await page.goto(`/record/${silent.id}`)
  await expect(page.getByText(/The rail has not answered\. Do not send it again/).first()).toBeVisible()
  await expect(page.getByText(/^Finished: done$/)).toHaveCount(0)
  await expect(page.getByText(/did not go through/)).toHaveCount(0)
  await page.goto('/pay')
  const row = page.getByRole('link', { name: /Pay ₹500 to Silent Shop/ }).locator('xpath=ancestor::li[1]')
  await expect(row.getByText('Completed', { exact: true })).toHaveCount(0)

  // declined: the rail refuses it; the money comes back and the screens say so
  await pay(page, 'Closed Shop', 'decline@paper', '300')
  await expect.poll(() => payment('decline@paper')?.state, { timeout: 30_000 }).toBe('failed')
  await page.goto(`/record/${payment('decline@paper')!.id}`)
  await expect(page.getByText(/The payment did not go through: .+ The money was returned to your bank account\./).first()).toBeVisible()
})
