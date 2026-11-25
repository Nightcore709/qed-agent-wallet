/**
 * A reconciliation discrepancy never appears as a successful completion (R7-095). A real payment is made through the
 * interface and settles; then the test forces the state reconciliation records when the rail's record differs from the
 * ledger (named below), and reads every place the payment appears: the payments list, the activity list and the record.
 * None may say "done"; each says it needs attention. Detecting a discrepancy is covered by the reconciliation tests.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { force, query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('rec')
  await page.goto('/')
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

test('a finished payment whose rail record differs is shown as needing attention wherever it appears, never as done', async ({ page }) => {
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto('/pay')
  await addPayeeOnSpend(page, 'Corner Shop', 'cornershop@okbank')
  await page.getByLabel('How much').fill('500')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  // the payment settles on the paper rail and is reconciled
  await expect.poll(() => query<{ state: string; recon_state: string }>(`SELECT state, recon_state FROM actions WHERE user_id = ? AND kind = 'payment'`, person!.id)[0], { timeout: 30_000 }).toEqual({ state: 'done', recon_state: 'reconciled' })
  const [a] = query<{ id: string }>(`SELECT id FROM actions WHERE user_id = ? AND kind = 'payment'`, person!.id)
  // forced: the state reconciliation records when the rail's record and the ledger disagree
  expect(force(`UPDATE actions SET recon_state = 'break' WHERE id = ?`, a!.id)).toBe(1)

  await page.goto('/pay')
  const row = page.getByRole('link', { name: /Pay ₹500 to Corner Shop/ }).locator('xpath=ancestor::li[1]')
  await expect(row).toContainText('Needs attention: the venue\'s record differs')
  await expect(row.getByText('Completed', { exact: true })).toHaveCount(0)
  await page.goto('/activity?view=list') // R14: Activity opens on its folders; the day book is the list
  await expect(page.getByText('Needs attention: the venue\'s record differs').first()).toBeVisible()
  await page.goto(`/record/${a!.id}`)
  await expect(page.getByText('Needs attention: the venue\'s record differs').first()).toBeVisible()
  await expect(page.getByText(/Finished, but it needs attention/)).toBeVisible()
  await expect(page.getByText(/^Finished: done$/)).toHaveCount(0)
})
