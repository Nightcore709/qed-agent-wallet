/**
 * A model's proposal opened in the editor does not bring the model's run mode with it (A3, D2 of the adversarial Ask
 * corpus): it asks the owner each time until the owner chooses otherwise, whatever the model asked for. The proposal
 * here comes from the suite's scripted test double, which the interface labels as not a model.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(unique('adr'))
  await page.getByLabel('Name to sign with').fill('Draft Reader')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('a proposal from Ask opened in the editor asks the owner each time, whatever run mode was proposed', async ({ page }) => {
  await addAuthenticator(page)
  await newOwner(page)
  await page.goto('/ask')
  await page.getByLabel('Your question').fill('Invest ₹2,000 every month in the Nifty 50 index fund, and park my idle cash.')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await page.waitForURL(/\/ask\?c=cnv_/)
  const open = page.getByRole('link', { name: /^Open/ }).filter({ hasNotText: 'all' }).first()
  await expect(open).toBeVisible({ timeout: 30_000 })
  await open.click()
  await page.waitForURL(/\/instructions\/new\?proposal=/)
  await expect(page.getByRole('radio', { name: /Ask me each time/ })).toBeChecked({ timeout: 20_000 })
  await expect(page.getByRole('radio', { name: /On its own/ })).not.toBeChecked()
})
