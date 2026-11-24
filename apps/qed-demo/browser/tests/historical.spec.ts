/**
 * The release's recorded evidence is browsable before any wallet is set up, and labelled historical (R7-098): a fresh
 * account with no on-chain wallet opens Activity › Evidence and reads the transactions the QED team recorded on 19 and
 * 20 October, counted exactly as the vendored manifests count them, each linked to the public explorer, nothing
 * presented as made by this build.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'

const APP = join(import.meta.dirname, '..', '..')
const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(unique('his'))
  await page.getByLabel('Name to sign with').fill('History Reader')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('the recorded evidence of the approved release is readable without a wallet, labelled historical, counted as the manifests count it, and linked to the public explorer', async ({ page }) => {
  await addAuthenticator(page)
  await newOwner(page)
  const files = ['manifest.json', 'clearing/manifest.json', 'private/manifest.json', 'execution/manifest.json']
  const steps = files.flatMap((f) => (JSON.parse(readFileSync(join(APP, 'chain', 'vendor', 'evidence', 'ethereum-sepolia', f), 'utf8')) as { steps?: { tx?: { hash: string; status: string } }[] }).steps ?? []).filter((s) => s.tx)
  await page.goto('/evidence')
  const section = page.getByRole('region', { name: 'Recorded before this build: 19 and 20 October' })
  await expect(section).toBeVisible({ timeout: 20_000 })
  await expect(section.getByText('Historical, not made by this build')).toBeVisible()
  const totals = files.map((f) => (JSON.parse(readFileSync(join(APP, 'chain', 'vendor', 'evidence', 'ethereum-sepolia', f), 'utf8')) as { sepolia: { transactions: number; reverted: number } }).sepolia)
  const total = totals.reduce((a, t) => a + t.transactions, 0), reverted = totals.reduce((a, t) => a + t.reverted, 0)
  expect(total).toBe(196)
  await expect(section.getByText(new RegExp(`^${total} transactions in 4 runs, as the runs' own manifests count them \\(${reverted} reverted\\); ${steps.length} of them are named steps`))).toBeVisible()
  // one run opened: its transactions link to the public explorer by their hash
  await section.locator('summary').first().click()
  const link = section.locator('table a').first()
  await expect(link).toHaveAttribute('href', new RegExp(`^https://sepolia\\.etherscan\\.io/tx/${steps[0]!.tx!.hash}$`))
  await expect(link).toHaveAttribute('rel', /noopener/)
})
