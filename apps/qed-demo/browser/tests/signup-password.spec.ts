/**
 * Ordinary sign-up (D-094): an account opened with a handle and a password reaches its household without a passkey,
 * signs out and back in with the password, and still cannot approve anything that moves money: the approval route
 * has no password path, so the signing sheet says a passkey is needed and its button stays disabled. Adding a passkey
 * later, under Security with the password typed again, is what gives it authority: the same payment can then be
 * approved. The password is made here and never leaves the test.
 */
import { randomBytes } from 'node:crypto'
import { expect, test } from '../support/test.ts'
import { answered } from '../support/answer.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend, choosePayeeOnSpend } from '../support/payee.ts'
import { allowSignups, query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

test('a password account sets up, signs in again, and can approve nothing until it adds a passkey', async ({ page }) => {
  test.setTimeout(120_000)
  allowSignups()
  const handle = unique('pw'), password = `${randomBytes(9).toString('base64url')} phrase`
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByText('Choose your handle (optional)').click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Test')
  // R14: the ordinary sign-up is an email address and a password
  await page.getByLabel('Email', { exact: true }).fill(`${handle}@example.in`)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()

  // the first-run step offers the passkey that approves payments; "Not now" is allowed and says what it leaves out
  await expect(page.getByRole('heading', { name: 'Faster, more secure access' })).toBeVisible()
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Finish setting up/ })).toBeVisible()
  const [user] = query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)
  expect(user!.pw_hash.startsWith('scrypt$')).toBe(true)
  expect(query('SELECT 1 FROM webauthn_credentials c JOIN users u ON u.id = c.person_id WHERE u.handle = ?', handle)).toHaveLength(0)

  // signs out and back in with the password
  await page.getByRole('button', { name: /account menu$/ }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Password', { exact: true }).fill(password)
  // the server checks the password with scrypt (slow on purpose): what follows is checked once it has answered
  await answered(page, 'POST', '/api/auth/login', () => page.getByRole('button', { name: 'Sign in with your password' }).click())
  await expect(page.getByRole('heading', { level: 1, name: 'Your money' })).toBeVisible()

  // a payment can be prepared and reviewed, but not approved: there is no passkey to sign its terms
  await page.goto('/pay')
  // with no payee yet, the form to add one is already open
  // exact: Spend's abroad section, loaded a moment later, has its own "Add a payee abroad"
  const open = page.getByRole('button', { name: 'Add a payee', exact: true })
  if (await open.isVisible()) await open.click()
  await addPayeeOnSpend(page, 'Corner Shop', 'corner@okbank')
  await page.getByLabel('How much').fill('120')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('This account has no passkey yet')).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeDisabled()
  await sheet.getByRole('button', { name: 'Not now' }).click()
  expect(query(`SELECT 1 FROM actions a JOIN users u ON u.id = a.user_id WHERE u.handle = ? AND a.kind = 'payment'`, handle)).toHaveLength(0)

  // adding a passkey (here, a virtual platform authenticator) is what gives the account authority: Security asks for
  // the password again, the passkey is made, and the same payment can now be approved
  await addAuthenticator(page)
  await page.goto('/security')
  const note = page.locator('.note').filter({ hasText: 'This account has no passkey' })
  await note.getByLabel('Password').fill(password)
  await note.getByRole('button', { name: 'Create a passkey' }).click()
  await expect(page.getByText('This account has no passkey')).toHaveCount(0)
  expect(query('SELECT 1 FROM webauthn_credentials c JOIN users u ON u.id = c.person_id WHERE u.handle = ?', handle)).toHaveLength(1)
  await page.goto('/pay')
  await choosePayeeOnSpend(page, 'corner@okbank')
  await page.getByLabel('How much').fill('120')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const again = page.getByRole('dialog')
  await expect(again.getByText('This account has no passkey yet')).toHaveCount(0)
  await expect(again.getByRole('button', { name: 'Approve and send with your passkey' })).toBeEnabled()
  await again.getByRole('button', { name: 'Not now' }).click()
})
