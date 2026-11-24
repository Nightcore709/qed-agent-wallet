/**
 * Notifications through the interface (R10-006, R10 section 7): a change to who can act for the account is told on
 * Home at once as an urgent notice, with what to do if it was not the person; it is acknowledged there; the
 * Notifications page then lists it as acknowledged, with nothing left waiting. Delivery is inside QED only.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function createAccount(page: Page, handle: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('a passkey added to the account is told on Home at once, acknowledged there, and listed as acknowledged', async ({ page }) => {
  const first = await addAuthenticator(page)
  await createAccount(page, unique('nt'))
  await page.goto('/notifications')
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible()
  await expect(page.getByText(/Nothing urgent is waiting/)).toBeVisible()
  await expect(page.getByText(/Nothing leaves this computer in this build/)).toBeVisible()

  // a second passkey, made on another authenticator (the account was just created, so its confirmation is fresh)
  await first.remove()
  await addAuthenticator(page)
  await page.goto('/security')
  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(2)

  // Home tells of it at once, says what to do if it was not you, and takes the acknowledgement
  await page.goto('/')
  const told = page.getByRole('article').filter({ hasText: 'A passkey was added to your account' })
  await expect(told).toBeVisible()
  await expect(told).toContainText('If this was not you, open Security and recovery now')
  await told.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByRole('article').filter({ hasText: 'A passkey was added to your account' })).toHaveCount(0)

  // Notifications: nothing waiting, and the notice listed as acknowledged
  await page.goto('/notifications')
  await expect(page.getByText(/Nothing urgent is waiting/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Acknowledged' })).toContainText('A passkey was added to your account')
})
