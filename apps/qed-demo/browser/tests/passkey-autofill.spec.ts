/**
 * Passkey autofill (conditional mediation, R10 section 7): on the sign-in form the handle field offers this device's
 * passkeys for QED, and choosing one signs in with no further step. A person chooses from the browser's suggestions;
 * the suite's virtual authenticator answers the pending request at once, which stands in for that choice. The app keeps
 * the request off under automation unless a journey asks for it (`qedTestAutofill`), so other journeys are unaffected.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

test('a passkey offered in the handle field signs in with a passkey session, and the explicit button still works', async ({ page }) => {
  const auth = await addAuthenticator(page)
  const handle = unique('af')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()

  // the sign-in form's handle field is marked for passkey suggestions
  await expect(page.getByLabel('Handle')).toHaveAttribute('autocomplete', 'username webauthn')
  expect(await auth.credentials()).toHaveLength(1)

  // with autofill allowed, the pending request is answered by the authenticator: the account opens with a passkey session
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = true })
  await page.reload()
  await expect(page.getByText(`Signed in as Test ${handle}`)).toBeVisible({ timeout: 15_000 })
  const session = await page.evaluate(async () => (await fetch('/api/session')).json())
  expect(session).toMatchObject({ authenticated: true, authMethod: 'passkey', user: { handle } })
})
