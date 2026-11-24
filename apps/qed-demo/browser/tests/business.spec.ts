/**
 * A business workspace with two members and a policy of two signatures (R7-043, R7-056): the owner prepares and signs
 * an instruction, which does not take effect; the second member finds it waiting, reviews the same document and
 * signs; only then is it in force. Each person has their own browser, session and passkey. The database is the judge
 * of what took effect.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function createAccount(page: Page, handle: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Member ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
}
async function openHousehold(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Sections' }).first()).toBeVisible()
}

test('an instruction in a two-signature business takes effect only when a second member signs the same document', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  const second = await (await browser.newContext()).newPage()
  await addAuthenticator(owner); await addAuthenticator(second)
  const a = unique('own'), b = unique('two'), business = `Traders ${a}`
  await createAccount(owner, a); await openHousehold(owner)
  await createAccount(second, b); await openHousehold(second)

  // the owner starts a business, opens its books, adds the second person as an approver and asks for two signatures
  await owner.goto('/workspace')
  await owner.getByLabel('Business name').fill(business)
  await owner.getByRole('button', { name: 'Create' }).click()
  await openHousehold(owner)
  await owner.goto('/workspace')
  await owner.getByLabel('Their handle').fill(b)
  await owner.getByLabel('Role').selectOption('approver')
  await owner.getByRole('button', { name: 'Add member' }).click()
  // giving a member authority waits out the protection delay (Q-048: 6 s on this stack, 72 hours in the product), then
  // the member is listed; meanwhile the grant waits, cancellable
  await expect(owner.getByText('Waiting to be given authority')).toBeVisible()
  await expect(owner.getByText(`@${b}`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await owner.getByLabel('Signatures for every request').fill('2')
  await owner.getByRole('button', { name: 'Save who must sign' }).click()
  await expect(owner.getByText('In force now')).toBeVisible()
  const [ws] = query<{ id: string; policy_json: string }>('SELECT id, policy_json FROM users WHERE display_name = ?', business)
  expect(JSON.parse(ws!.policy_json)).toMatchObject({ signers: 2 })

  // the owner writes and signs an instruction: one of two signatures, nothing in force
  await owner.goto('/instructions/new?kind=invest')
  await owner.getByLabel('Buy').selectOption('coindcx:BTCINR')
  await owner.getByLabel('With this much each time').fill('200')
  await owner.getByRole('radio', { name: /On its own/ }).check()
  await owner.getByRole('button', { name: 'Review and sign' }).click()
  await owner.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await expect(owner.getByText('Signed: 1 of 2')).toBeVisible()
  const pending = query<{ id: string; confirmed_at: number | null; required_signers: number }>('SELECT id, confirmed_at, required_signers FROM approvals WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1', ws!.id, 'program-version')
  expect(pending[0]).toMatchObject({ confirmed_at: null, required_signers: 2 })
  expect(query('SELECT COUNT(*) n FROM programs WHERE user_id = ? AND state = ?', ws!.id, 'active')[0]).toEqual({ n: 0 })

  // the second member switches to the business, finds the request and signs it
  await second.reload()
  await second.getByRole('button', { name: /account menu$/ }).click()
  await second.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: `${business} (approver)` })
  await second.goto('/workspace')
  await expect(second.getByText('1 of 2 signatures')).toBeVisible()
  await second.getByRole('button', { name: 'Review and sign' }).click()
  await second.getByRole('button', { name: 'Sign with your passkey' }).click()
  await expect(second.getByText('Nothing is waiting for a signature.')).toBeVisible()

  // now, and only now, the instruction is in force, with both signatures on record
  const signers = query<{ person_id: string }>('SELECT person_id FROM approval_signatures WHERE approval_id = ?', pending[0]!.id)
  expect(signers).toHaveLength(2)
  expect(query<{ confirmed_at: number | null }>('SELECT confirmed_at FROM approvals WHERE id = ?', pending[0]!.id)[0]!.confirmed_at).not.toBeNull()
  expect(query('SELECT COUNT(*) n FROM programs WHERE user_id = ? AND state = ?', ws!.id, 'active')[0]).toEqual({ n: 1 })
  // and the personal workspaces of both people are untouched
  for (const h of [a, b]) {
    const [p] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', h)
    expect(query('SELECT COUNT(*) n FROM programs WHERE user_id = ?', p!.id)[0]).toEqual({ n: 0 })
  }
})

test('a lowering of who must sign waits, every member who may sign sees it on the workspace page, and one of them cancels it', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  const second = await (await browser.newContext()).newPage()
  await addAuthenticator(owner); await addAuthenticator(second)
  const a = unique('low'), b = unique('can'), business = `Lowering ${a}`
  await createAccount(owner, a); await openHousehold(owner)
  await createAccount(second, b); await openHousehold(second)
  await owner.goto('/workspace')
  await owner.getByLabel('Business name').fill(business)
  await owner.getByRole('button', { name: 'Create' }).click()
  await openHousehold(owner)
  await owner.goto('/workspace')
  await owner.getByLabel('Their handle').fill(b)
  await owner.getByLabel('Role').selectOption('approver')
  await owner.getByRole('button', { name: 'Add member' }).click()
  // the grant applies when its delay ends (Q-048), and only then can two of two members sign
  await expect(owner.getByText(`@${b}`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await owner.getByLabel('Signatures for every request').fill('2')
  await owner.getByRole('button', { name: 'Save who must sign' }).click()
  await expect(owner.getByText('In force now')).toBeVisible()
  // the second member is already looking at the business when the owner lowers it
  await second.reload()
  await second.getByRole('button', { name: /account menu$/ }).click()
  await second.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: `${business} (approver)` })
  await second.goto('/workspace')
  await owner.getByLabel('Signatures for every request').fill('1')
  await owner.getByRole('button', { name: 'Save who must sign' }).click()
  await expect(owner.getByText('Scheduled', { exact: true })).toBeVisible()
  await second.reload()
  await expect(second.getByText('A lowering is waiting to take effect')).toBeVisible()
  await expect(second.getByText(/2 signatures for every request become 1/)).toBeVisible()
  await second.getByRole('button', { name: 'Cancel this lowering' }).click()
  await expect(second.getByText('A lowering is waiting to take effect')).toHaveCount(0)
  const [ws] = query<{ id: string; policy_json: string }>('SELECT id, policy_json FROM users WHERE display_name = ?', business)
  const [c] = query<{ cancelled_at: number | null; applied_at: number | null }>(`SELECT cancelled_at, applied_at FROM scheduled_changes WHERE workspace_id = ? AND kind = 'lower-policy'`, ws!.id)
  expect(c!.cancelled_at).not.toBeNull()
  expect(c!.applied_at).toBeNull()
  // after the delay has passed, the policy is still two signatures
  await second.waitForTimeout(6500)
  await second.reload()
  expect(JSON.parse(query<{ policy_json: string }>('SELECT policy_json FROM users WHERE id = ?', ws!.id)[0]!.policy_json)).toMatchObject({ signers: 2 })
})
