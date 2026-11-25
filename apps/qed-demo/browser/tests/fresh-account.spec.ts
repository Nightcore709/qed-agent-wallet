/**
 * R7-041: a fresh account is a usable test environment with no developer intervention. On a stack of its own that nothing has
 * touched (no seed, no review credentials, no database write by the test), a person creates an account with a passkey, opens the
 * household, and, using nothing but the interface, adds a payee, pays it with the passkey, sees the payment settle, reports a problem
 * with it and downloads the dispute pack, then visits every main place without an error. The database is read only to prove that
 * nothing was put there for the account: the only user is the one this test created.
 * The other journeys on a fresh account have their own specs, each starting from sign-up: a goal (goals.spec.ts), the on-chain vault
 * (two-households.spec.ts), earning (earn-chain.spec.ts), an instruction (instructions.spec.ts), recovery (recovery.spec.ts).
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_FRESH_ACCOUNT_PORT ?? extraPort(108))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

test('a fresh account on an untouched stack opens, pays, reports a problem and reaches every main place with no seeded data and no review credentials', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await addAuthenticator(page)

  // nothing exists before the person arrives: no user, no review account to sign in with
  expect(s.query('SELECT COUNT(*) n FROM users')).toEqual([{ n: 0 }])
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  const handle = `fresh${Date.now().toString(36)}`
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [me] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  expect(s.query('SELECT COUNT(*) n FROM users')).toEqual([{ n: 1 }])
  // no payee, payment, instruction or bill was put there for the account
  for (const t of ['payees', 'actions', 'programs', 'bills', 'disputes']) expect(s.query(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, me!.id), t).toEqual([{ n: 0 }])

  // pay: add a payee, approve with the passkey, settled
  await page.goto(`${s.base}/pay`)
  await addPayeeOnSpend(page, 'Ravi Kumar', 'ravi.kumar@upi')
  await page.getByLabel('How much').fill('500')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(sheet).toBeHidden()
  await expect.poll(() => s.query<{ state: string }>(`SELECT state FROM actions WHERE user_id = ? AND kind = 'payment'`, me!.id)[0]?.state, { timeout: 30_000 }).toBe('done')

  // report a problem with it: QED's own payments on that rail are paused, and the pack and its draft notice are there
  const [pay] = s.query<{ id: string }>(`SELECT id FROM actions WHERE user_id = ? AND kind = 'payment'`, me!.id)
  await page.goto(`${s.base}/record/${pay!.id}`)
  await page.getByRole('button', { name: 'Dispute this payment' }).click()
  await page.getByLabel('What went wrong').fill('The payee says they never received it')
  await page.getByRole('button', { name: 'Raise the dispute' }).click()
  await page.getByRole('link', { name: 'Open the dispute pack' }).click()
  await expect(page.getByRole('heading', { name: 'Draft notice to your bank' })).toBeVisible()
  await expect(page.getByText(/QED does not make payments on its own on this account until you release the pause/)).toBeVisible()

  // every main place opens without an error
  for (const [path, heading] of [['/', null], ['/pay', null], ['/save', null], ['/earn', null], ['/ask', null], ['/activity', null], ['/protect', null], ['/instructions', null], ['/security', null], ['/vault', null]] as const) {
    const r = await page.goto(`${s.base}${path}`)
    expect(r?.status() ?? 200, path).toBeLessThan(500)
    await expect(page.locator('main, #root').first(), path).toBeVisible()
    void heading
  }
  expect(errors).toEqual([])
})
