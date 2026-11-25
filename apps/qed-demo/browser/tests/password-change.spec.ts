/**
 * Changing and removing a password under Security (RISK-076's next step). An account opened with a password changes it
 * with the current one typed again: a wrong current password and a guessable new one are refused on their own fields,
 * and a second browser signed in with the old password is signed out at once; there the old password then fails and the
 * new one signs in. Once the account has a passkey, the change no longer asks for the current password (the passkey
 * confirms it), and removing the password lists what a recovery would need without it, offering nothing until an active
 * recovery contact exists. Then the passkey confirms the removal, the other browser is signed out again, and the
 * password is answered as for a handle that does not exist. The passwords are made here and never leave the test.
 */
import { randomBytes } from 'node:crypto'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { answered } from '../support/answer.ts'
import { allowSignups, query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function signInWithPassword(page: Page, handle: string, password: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Password', { exact: true }).fill(password)
  // the server checks the password with scrypt (slow on purpose): what follows is checked once it has answered
  await answered(page, 'POST', '/api/auth/login', () => page.getByRole('button', { name: 'Sign in with your password' }).click())
}

test('a password account changes its password, then removes it once it has a passkey and an active recovery contact', async ({ browser }) => {
  test.setTimeout(180_000)
  allowSignups()
  const handle = unique('pc'), first = `${randomBytes(9).toString('base64url')} phrase`, second = `${randomBytes(9).toString('base64url')} words`
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  // opened with a password; the first run's passkey step is put off, and the household opened
  await owner.goto('/')
  await owner.getByRole('button', { name: 'Create an account' }).click()
  await owner.getByText('Choose your handle (optional)').click()
  await owner.getByLabel('Handle').fill(handle)
  await owner.getByLabel('Name to sign with').fill('Pass Changer')
  // R14: the ordinary sign-up is an email address and a password
  await owner.getByLabel('Email', { exact: true }).fill(`${handle}@example.in`)
  await owner.getByLabel('Password', { exact: true }).fill(first)
  await owner.getByRole('button', { name: 'Create account', exact: true }).click()
  await owner.getByRole('button', { name: 'Not now' }).click()
  await owner.getByRole('button', { name: 'Open the household' }).click()
  await expect(owner.getByRole('heading', { name: /Finish setting up/ })).toBeVisible()

  // a second browser signs in with the same password
  const elsewhere = await (await browser.newContext()).newPage()
  await signInWithPassword(elsewhere, handle, first)
  await expect(elsewhere.getByRole('heading', { level: 1, name: 'Your money' })).toBeVisible()

  // with no passkey, changing it asks for the current password; mistakes are said on their fields
  await owner.goto('/security')
  const panel = owner.getByRole('region', { name: 'Password', exact: true })
  await expect(panel.getByText('As set when the account was made')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Remove password' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Change password' }).click()
  const sheet = owner.getByRole('dialog', { name: 'Change your password' })
  await sheet.getByLabel('Current password', { exact: true }).fill('not the password at all')
  await sheet.getByLabel('New password', { exact: true }).fill(second)
  await answered(owner, 'POST', '/api/security/password', () => sheet.getByRole('button', { name: 'Change password' }).click())
  await expect(sheet.getByText('That is not the password this account has now.')).toBeVisible()
  await sheet.getByLabel('Current password', { exact: true }).fill(first)
  await sheet.getByLabel('New password', { exact: true }).fill('qwerty12345')
  await answered(owner, 'POST', '/api/security/password', () => sheet.getByRole('button', { name: 'Change password' }).click())
  await expect(sheet.getByText('That password is too easy to guess.')).toBeVisible()
  const before = query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)[0]!.pw_hash
  await sheet.getByLabel('New password', { exact: true }).fill(second)
  await answered(owner, 'POST', '/api/security/password', () => sheet.getByRole('button', { name: 'Change password' }).click())
  await expect(owner.getByRole('dialog')).toHaveCount(0)
  await expect(panel.getByText('Password changed', { exact: true })).toBeVisible()
  await expect(panel.getByText('The one other session signed in to this account was signed out.')).toBeVisible()
  const after = query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)[0]!.pw_hash
  expect(after).not.toBe(before)
  expect(after.startsWith('scrypt$')).toBe(true)

  // the other browser was signed out at once; there the old password fails and the new one signs in
  await elsewhere.reload()
  await expect(elsewhere.getByRole('button', { name: 'Sign in with your password' })).toBeVisible()
  await signInWithPassword(elsewhere, handle, first)
  await expect(elsewhere.getByText('That handle and password do not match.')).toBeVisible()
  await signInWithPassword(elsewhere, handle, second)
  await expect(elsewhere.getByRole('heading', { level: 1, name: 'Your money' })).toBeVisible()

  // a passkey, made after typing the new password again
  const note = owner.locator('.note').filter({ hasText: 'This account has no passkey' })
  await note.getByLabel('Password').fill(second)
  await note.getByRole('button', { name: 'Create a passkey' }).click()
  await expect(owner.getByText('This account has no passkey')).toHaveCount(0)
  // F1: the first passkey brought the saved codes, shown once, here
  const made = owner.locator('.note').filter({ hasText: 'Save these recovery codes now' })
  await expect(made.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  await made.getByRole('button', { name: 'Continue' }).click()
  // the passkey confirms a change now: the sheet no longer asks for the current password
  await panel.getByRole('button', { name: 'Change password' }).click()
  await expect(sheet.getByText('Your passkey is asked for first, unless you confirmed with it here in the last five minutes.', { exact: false })).toBeVisible()
  await expect(sheet.getByLabel('Current password', { exact: true })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Cancel' }).click()

  // removing it: with no recovery contact the sheet says what is missing and offers no removal
  await panel.getByRole('button', { name: 'Remove password' }).click()
  const rm = owner.getByRole('dialog', { name: 'Remove your password' })
  const needs = rm.getByRole('list', { name: 'What removing the password needs' })
  await expect(needs.getByText('None yet: name one under "If you lose every passkey".')).toBeVisible()
  // the codes came with the first passkey; a recovery without the password needs one of them beside a contact's code
  await expect(needs.getByText('10 of 10 unused.')).toBeVisible()
  await expect(rm.getByRole('button', { name: 'Remove password' })).toHaveCount(0)
  await rm.getByRole('button', { name: 'Keep the password' }).click()

  // a recovery contact: a second person, with a passkey, accepts; on the test stack the delay is 6 seconds
  const contact = await (await browser.newContext()).newPage()
  await addAuthenticator(contact)
  const contactHandle = unique('pcc')
  await contact.goto('/')
  await contact.getByRole('button', { name: 'Create an account' }).click()
  await contact.getByRole('button', { name: 'Use a passkey instead' }).click()
  await contact.getByLabel('Handle').fill(contactHandle)
  await contact.getByLabel('Name to sign with').fill('Trusted Helper')
  await contact.getByRole('button', { name: 'Create account with a passkey' }).click()
  await contact.getByRole('button', { name: 'Continue' }).click()
  await owner.getByLabel('Their handle').fill(contactHandle)
  await owner.getByRole('button', { name: 'Name as recovery contact' }).click()
  await expect(owner.getByText(/waiting for them to accept/)).toBeVisible()
  await contact.goto('/security')
  await contact.getByRole('button', { name: 'Accept' }).click()
  await expect(contact.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  await owner.waitForTimeout(6500)

  // everything a recovery needs is in place: the passkey confirms the removal, which waits the protection delay
  // (SECURITY.md 8j (c)): the sheet says so before, and the panel says until when and how to cancel it after
  await owner.goto('/security')
  await panel.getByRole('button', { name: 'Remove password' }).click()
  await expect(needs.getByText(`@${contactHandle} is active and can issue you a recovery code.`)).toBeVisible()
  await expect(needs.getByText('10 of 10 unused.')).toBeVisible()
  await expect(rm.getByText(/Removing it waits .*: the password keeps working until then, every address of yours is told now, and any of your passkeys, or one of your saved recovery codes, can cancel it/)).toBeVisible()
  await rm.getByRole('button', { name: 'Remove password' }).click()
  await expect(owner.getByRole('dialog')).toHaveCount(0)
  const waiting = panel.locator('.note').filter({ hasText: /^Your password is to be removed / })
  await expect(waiting).toBeVisible()
  await expect(waiting).toContainText(/It keeps working until then\..*cancel the removal under Needs you/)
  await expect(panel.getByRole('heading', { name: 'Password' })).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Remove password' })).toHaveCount(0)
  await expect(owner.getByRole('region', { name: 'Needs you' }).getByRole('heading', { name: 'Remove your password' })).toBeVisible()
  expect(query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)[0]!.pw_hash.startsWith('scrypt$')).toBe(true)
  // it takes effect when the delay ends (6 s on the test stack): this session was opened with the password, so it ends
  // with it, and the owner signs in again with the passkey
  await expect.poll(() => query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)[0]!.pw_hash, { timeout: 30_000 }).toBe('!')
  await owner.reload()
  await owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toHaveCount(0)
  await owner.goto('/security')
  // signed in (the page's parts are there), and the password panel is gone with the password
  await expect(owner.getByRole('region', { name: 'Signing in' })).toBeVisible()
  await expect(owner.getByRole('region', { name: 'Password', exact: true })).toHaveCount(0)
  // the recovery path no longer offers the password as its second proof (R12: "One more proof" lists what remains)
  const path = owner.getByRole('list', { name: 'What a recovery takes' })
  await expect(path.getByText(`a code from @${contactHandle}.`, { exact: false })).toBeVisible()
  await expect(path.getByText(/or your password/)).toHaveCount(0)
  // the history says what happened, in order
  const history = owner.getByRole('region', { name: 'What happened' })
  await expect(history.getByText('Password removed; the account signs in only with passkeys')).toBeVisible()
  await expect(history.getByText('Removing your password was asked for; it waits before it takes effect')).toBeVisible()
  await expect(history.getByText('Password changed; every other session was signed out')).toBeVisible()
  await expect(history.getByText('Account created with a password')).toBeVisible()

  // the other browser is signed out again, and the password is answered as for a handle that does not exist
  await elsewhere.reload()
  await signInWithPassword(elsewhere, handle, second)
  await expect(elsewhere.getByText('That handle and password do not match.')).toBeVisible()
  await signInWithPassword(elsewhere, unique('nobody'), second)
  await expect(elsewhere.getByText('That handle and password do not match.')).toBeVisible()
})
