/**
 * The readiness view (R7-088, R7-098) in the browser: it names the revision and the release this build derives from,
 * says it is not ready for real money and why, lists the open critical and high risks from the risk register, and
 * points to the release's own historical record.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { newOwner, shot } from '../support/vault.ts'

test('the readiness view names the build and its release, and is never ready while a blocker remains', async ({ page }) => {
  await addAuthenticator(page)
  await newOwner(page)
  await page.goto('/safeguards')
  await page.getByRole('link', { name: 'Readiness' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Readiness' })).toBeVisible()
  await expect(page.getByText('Not ready for real money', { exact: true })).toBeVisible()
  const build = page.getByRole('region', { name: 'This build' })
  await expect(build.getByText(/^[0-9a-f]{12}$/)).toBeVisible()
  await expect(build.getByText('qed-20261023-health-gate-v3')).toBeVisible()
  await expect(build.getByRole('link', { name: 'Vault, Records' })).toBeVisible()
  const standing = page.getByRole('region', { name: 'What it is' })
  await expect(standing.getByText('No one outside this work has reviewed it')).toBeVisible()
  const risks = page.getByRole('region', { name: 'Open risks, critical and high' })
  await expect(risks.getByRole('listitem').first()).toContainText('RISK-')
  // nothing on the page claims readiness
  await expect(page.getByText(/^Ready( for real money)?$/)).toHaveCount(0)
  await shot(page, 'readiness')
})
