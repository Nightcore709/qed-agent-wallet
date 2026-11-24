/**
 * The account menu by keyboard (R7-111 walkthrough F30): opened from its button, it closes when focus leaves it, by
 * Tab past its last item or Shift+Tab before its button, as it already did on Escape and on a click outside. A menu
 * left open over the page after focus has moved on hides what the person is now on.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<void> {
  const handle = unique('mnu')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('the account menu closes when focus leaves it by Tab or Shift+Tab', async ({ page }) => {
  await addAuthenticator(page)
  await newOwner(page)
  const button = page.getByRole('button', { name: /account menu$/ }), menu = page.locator('#account-menu')

  await button.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  let presses = 0
  while ((await menu.count()) > 0 && presses < 15) { await page.keyboard.press('Tab'); presses++ }
  await expect(menu).toHaveCount(0)
  expect(presses).toBeGreaterThan(1) // it stayed open while focus was on its items
  await expect(button).toHaveAttribute('aria-expanded', 'false')

  await button.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Shift+Tab')
  await expect(menu).toHaveCount(0)
})
