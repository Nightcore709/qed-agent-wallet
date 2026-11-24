/**
 * Money-model S5 in the browser: a fresh household chooses test euros, test yen and test dinars for its wallet when it
 * sets it up. The usual tokens are selected until the owner changes them; another choice goes out only with the owner's
 * passkey signature over it (a second prompt), and the vault service checks that signature before it creates anything.
 * Once accepted, the wallet names every figure in those tokens' own units and lists its balances by currency. All of it
 * is valueless test tokens on the stack's own chain.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { approve, newOwner, railGet, shot, treasury, vaultRecord } from '../support/vault.ts'

test('a household chooses test euros, yen and dinars at setup under its passkey, and its wallet shows its balances by currency', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [me] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto('/vault')
  await expect(page.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  // the usual tokens until the owner chooses others; nothing is chosen for them
  await expect(page.getByText('Test tokens: test rupees, test dollars and test euros, the usual ones')).toBeVisible()
  await page.getByText('Test tokens: test rupees, test dollars and test euros, the usual ones').click()
  await page.getByLabel('The treasury holds').selectOption('EUR')
  await page.getByLabel('The reserve holds').selectOption('JPY')
  await page.getByLabel('Conversions may pass through').selectOption('BHD')
  await shot(page, 's5-01-choose-tokens')
  await page.getByRole('button', { name: 'Confirm with your passkey, sign the test tokens and set it up' }).click()
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  const rec = vaultRecord(me!.id) as { railId: string; request: { currencies?: unknown } }
  expect(rec.request.currencies).toEqual({ treasury: 'EUR', reserve: 'JPY', route: 'BHD' })
  expect(await railGet(`/workspaces/${rec.railId}`)).toMatchObject({ asset: { symbol: 'tEUR', decimals: 6 }, reserveAsset: { symbol: 'tJPY', decimals: 0 }, currencies: { treasury: 'EUR', reserve: 'JPY', route: 'BHD', default: false } })
  // accept: the passkey signs the account's digest of the two acceptOwnership calls; the grant then arrives in test euros
  await page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
  await approve(page, /Your owner account runs these 2 calls.*acceptOwnership/)
  await page.goto('/vault')
  await expect(treasury(page).locator('.lead')).toHaveText('€1,095.24')
  // every figure in the wallet's own tokens: the page's words, and the amount fields' sign (never the rupee's)
  await expect(page.locator('.vt-head')).toContainText('Test euros and test yen on a chain that runs on this computer')
  const perPayment = page.getByLabel('Most in one payment, in test euros')
  await expect(perPayment).toBeVisible()
  await expect(page.locator('.money', { has: perPayment })).toHaveAttribute('data-sign', '€')
  const byCurrency = page.locator('.vt-bycur')
  await byCurrency.scrollIntoViewIfNeeded()
  await expect(byCurrency).toBeVisible()
  await expect(byCurrency.locator('dt')).toHaveText(['Test euros', 'Test yen'])
  await expect(byCurrency).toContainText('€1,204.76')
  await expect(byCurrency).toContainText('0 test yen')
  await shot(page, 's5-02-wallet-in-euros')
  if (process.env.QED_SHOTS) await page.locator('.vt-hold').screenshot({ path: `${process.env.QED_SHOTS}/s5-03-balances-by-currency.png`, animations: 'disabled' })
})
