/**
 * A look-alike payee, where a person meets it (adversarial corpus X01, RISK-073): "BЕSCOМ Electricity" written with
 * Cyrillic Е and М at bescom.power@okaxls, beside the real BESCOM Electricity at bescom.power@okaxis. Adding it shows
 * which payee it imitates and why, and is possible only once the owner says they checked it; editing the address
 * withdraws that. A payment to it then says what it looks like before the passkey signs, and the signed document
 * carries the same words. The database is read to check what was added and what was signed.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('lka')
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

test('a look-alike payee is named as one before it is added and before a payment to it is signed', async ({ page }) => {
  test.setTimeout(120_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const payees = () => query<{ handle: string }>('SELECT handle FROM payees WHERE user_id = ? ORDER BY created_at', person!.id).map((p) => p.handle)

  await page.goto('/pay')
  const name = page.getByLabel('Name', { exact: true }), address = page.getByLabel('Payment address')
  await name.fill('BESCOM Electricity')
  await address.fill('bescom.power@okaxis')
  await page.getByRole('button', { name: 'Add this payee', exact: true }).click()
  await expect(page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: /^BESCOM Electricity \(/ })).toBeChecked()

  // adding another payee is one press away once there is one
  await page.getByRole('button', { name: 'Add a payee', exact: true }).click()

  // the look-alike: QED names the payee it imitates and why, and will not add it unconfirmed
  await name.fill('BЕSCOМ Electricity')
  await address.fill('bescom.power@okaxls')
  await page.getByRole('button', { name: 'Add this payee', exact: true }).click()
  const warning = page.getByText(/This payee looks like one you already have: BESCOM Electricity \(bescom\.power@okaxis\)/)
  await expect(warning).toBeVisible()
  await expect(warning).toContainText(/letters from another alphabet/)
  await expect(warning).toContainText(/looks the same, written with look-alike characters \(bescom\.power@okaxls, not bescom\.power@okaxis\)/)
  const anyway = page.getByRole('button', { name: 'Add it anyway' })
  await expect(anyway).toBeDisabled()
  expect(payees()).toEqual(['bescom.power@okaxis'])

  // a confirmation covers only the payee it was given for: editing the address withdraws it
  const box = page.getByLabel('I checked this address with the payee myself, not from a message or a call')
  await box.check()
  await expect(anyway).toBeEnabled()
  await address.fill('bescom.power@okaxls ')
  await expect(warning).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add this payee', exact: true })).toBeEnabled()
  await address.fill('bescom.power@okaxls')
  await page.getByRole('button', { name: 'Add this payee', exact: true }).click()
  await expect(warning).toBeVisible()
  await expect(box).not.toBeChecked()
  await box.check()
  await anyway.click()
  await expect(page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: /bescom\.power@okaxls/ })).toBeChecked()
  expect(payees()).toEqual(['bescom.power@okaxis', 'bescom.power@okaxls'])

  // a payment to it says what it looks like before the passkey signs, and the signed document says the same
  await page.getByLabel('How much').fill('2450')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText(/looks like BESCOM Electricity \(bescom\.power@okaxis\), another of your payees/)).toBeVisible()
  await expect(sheet.getByText('Pay ₹2,450 to BЕSCOМ Electricity (bescom.power@okaxls).')).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'action' AND confirmed_at IS NOT NULL`, person!.id).length, { timeout: 20_000 }).toBe(1)
  const [signed] = query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'action' AND confirmed_at IS NOT NULL`, person!.id)
  const doc = JSON.parse(signed!.document) as { action: { params: { payeeHandle: string } }; warnings: string[] }
  expect(doc.action.params.payeeHandle).toBe('bescom.power@okaxls')
  expect(doc.warnings.join(' ')).toMatch(/looks like BESCOM Electricity \(bescom\.power@okaxis\)/)
})
