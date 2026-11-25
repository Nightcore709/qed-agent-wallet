/**
 * Ending another session from the security screen (R7-077): the owner is signed in on a laptop and on a phone (the
 * same passkey, synced); from the laptop, "Where you are signed in" lists both, and ending the phone's session signs
 * the phone out at once while the laptop stays signed in. The database records which session ended.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

test('one session ends another from the security screen: the other is signed out at once, this one stays', async ({ browser }) => {
  const laptop = await (await browser.newContext()).newPage()
  const key = await addAuthenticator(laptop)
  const handle = unique('ses')
  await laptop.goto('/')
  await laptop.getByRole('button', { name: 'Create an account' }).click()
  await laptop.getByRole('button', { name: 'Use a passkey instead' }).click()
  await laptop.getByLabel('Handle').fill(handle)
  await laptop.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await laptop.getByRole('button', { name: 'Create account with a passkey' }).click()
  await laptop.getByRole('button', { name: 'Continue' }).click()
  await laptop.getByRole('button', { name: 'Open the household' }).click()
  await expect(laptop.getByRole('button', { name: 'Open the household' })).toHaveCount(0)

  // the same passkey, synced to a phone, signs in there
  const phone = await (await browser.newContext()).newPage()
  const synced = await addAuthenticator(phone)
  await synced.load(await key.credentials())
  await phone.goto('/')
  await phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toHaveCount(0, { timeout: 20_000 })
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const open = () => query<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', person!.id)[0]!.n
  expect(open()).toBe(2)

  await laptop.goto('/security')
  // the part itself: the section around it ("Signing in") also holds the five separate things and the ways in (R14), which are lists too
  const where = laptop.locator('#sessions')
  await expect(where.getByRole('listitem')).toHaveCount(2)
  await where.getByRole('button', { name: 'End it' }).click()
  await expect(where.getByRole('listitem')).toHaveCount(1)
  expect(open()).toBe(1)

  // the phone is signed out at once; the laptop is not
  await phone.reload()
  await expect(phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible({ timeout: 20_000 })
  await laptop.reload()
  await expect(laptop.getByRole('heading', { level: 1 })).toHaveText('Security and recovery')
})
