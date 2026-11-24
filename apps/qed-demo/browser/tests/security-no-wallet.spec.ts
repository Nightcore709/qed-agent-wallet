/**
 * Security for an account without an on-chain wallet (EV-071, item 1). The page used to ask for the signers of a wallet
 * that did not exist (GET /api/vault/signers, answered 409), and the browser logged each answer as an error. Now it
 * says the wallet is not set up, and offers the way to set it up, without asking: no request fails and nothing is
 * logged. A wallet that exists is never hidden: once it is set up, the same section lists who signs for it.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { allowSignups } from '../support/stack.ts'
import { newOwner, setUpVault } from '../support/vault.ts'

test('an account without an on-chain wallet loads Security with no failed request and no console error, is told how to set the wallet up, and sees its signers once it is', async ({ page }) => {
  test.setTimeout(150_000)
  allowSignups()
  await addAuthenticator(page)
  const errors: string[] = [], failed: string[] = [], asked: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`) })
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/vault/signers') asked.push(r.method()) })
  await newOwner(page)

  await page.goto('/security')
  const signers = page.getByRole('region', { name: 'Who can sign for your on-chain wallet' })
  await expect(signers.getByText('Your on-chain wallet is not set up yet.', { exact: false })).toBeVisible()
  const setUp = signers.getByRole('link', { name: 'Set it up' })
  await expect(setUp).toHaveAttribute('href', '/vault')
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1)
  // anything the page asks on loading has been answered by now
  await page.waitForTimeout(1500)
  expect({ asked, failed, errors }).toEqual({ asked: [], failed: [], errors: [] })

  // the way it offers leads to setting the wallet up; then the wallet's signers are read and listed
  await setUp.click()
  await expect(page).toHaveURL(/\/vault$/)
  await setUpVault(page)
  await page.goto('/security')
  await expect(signers.getByText('Signs', { exact: true })).toHaveCount(1, { timeout: 30_000 })
  expect(asked.length).toBeGreaterThan(0)
  expect({ failed, errors }).toEqual({ failed: [], errors: [] })
})
