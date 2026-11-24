/**
 * Security, recovery and workspaces by keyboard alone (D2), and the passkey actions that had no journey (RC3): naming
 * a passkey when it is added, removing a passkey (which waits, and any other passkey can cancel it), and getting new
 * recovery codes. Same checks as keyboard-journeys.spec.ts: visible focus, order, no trap. The passkey prompt is
 * answered by the virtual authenticator.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { newOwner, signupCodes } from '../support/vault.ts'
import { choose, press, tabTo, type, walkPage } from '../support/keys.ts'

test.use({ actionTimeout: 30_000 })
const userOf = (handle: string): string => query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id

test('keyboard only: Security and recovery, naming a second passkey, new recovery codes, and scheduling a passkey\'s removal', async ({ page }) => {
  test.setTimeout(180_000)
  const first = await addAuthenticator(page)
  const handle = await newOwner(page)
  const userId = userOf(handle)
  await page.goto('/security')
  await expect(page.getByRole('heading', { level: 1, name: 'Security and recovery' })).toBeVisible()
  await walkPage(page)

  // a second passkey on another authenticator, named by typing; the first is kept to be removed later
  await first.remove()
  const second = await addAuthenticator(page)
  await type(page, page.getByLabel('Name it, if you like'), 'Work laptop')
  await press(page, page.getByRole('button', { name: 'Add a passkey', exact: true }))
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(2)
  expect(query<{ name: string }>('SELECT name FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL ORDER BY created_at', userId).map((c) => c.name)).toContain('Work laptop')
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByText('Work laptop', { exact: true })).toBeVisible()
  expect((await second.credentials()).length).toBe(1)

  // new recovery codes: shown once, ten of them, replacing the earlier set
  const before = query<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', userId).map((r) => r.id)
  expect(before).toHaveLength(10)
  // new codes need one of the current ones (H2): typed into its field
  await page.getByRole('textbox', { name: 'A saved recovery code, for new codes' }).focus()
  await page.keyboard.type(signupCodes.get(handle)![0]!)
  await press(page, page.getByRole('button', { name: 'Make new codes' }))
  const codes = page.getByRole('list', { name: 'New recovery codes' }).getByRole('listitem')
  await expect(codes).toHaveCount(10)
  for (const c of await codes.allInnerTexts()) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
  const after = query<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', userId).map((r) => r.id)
  expect(after).toHaveLength(10)
  expect(after.filter((id) => before.includes(id))).toEqual([])
  await expect(page.getByText('New codes, shown once')).toBeVisible()

  // removing the first passkey (the one not named): it waits, still works until then, and is then removed
  const row = page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem').filter({ hasNot: page.getByText('Work laptop', { exact: true }) }).first()
  await press(page, row.getByRole('button', { name: /^Remove/ }))
  await expect(page.getByText(/Will be removed .*Until then it still works/)).toBeVisible()
  expect(query<{ n: number }>("SELECT COUNT(*) n FROM scheduled_changes WHERE person_id = ? AND kind = 'remove-passkey' AND applied_at IS NULL AND cancelled_at IS NULL", userId)[0]!.n).toBe(1)
  await expect.poll(() => query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NOT NULL', userId)[0]!.n, { timeout: 30_000 }).toBe(1)
  // the removed passkey opened this session, so its removal ends the session: sign in again with the one that remains, by keyboard
  await page.goto('/')
  await press(page, page.getByRole('button', { name: 'Sign in with a passkey' }))
  await expect(page.getByRole('button', { name: /account menu$/ })).toBeVisible()
  await page.goto('/security')
  await expect(page.getByText(/^Removed /).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  await walkPage(page)
})

test('keyboard only: a business workspace is created; a signing rule it cannot meet and a member who does not exist are refused in words; the person switches back', async ({ page }) => {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const userId = userOf(await newOwner(page))
  await page.goto('/workspace')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await walkPage(page)
  await type(page, page.getByLabel('Business name'), 'Kitchen Works')
  await press(page, page.getByRole('button', { name: 'Create', exact: true }))
  await expect.poll(() => query<{ n: number }>("SELECT COUNT(*) n FROM users WHERE kind = 'business' AND display_name = 'Kitchen Works'")[0]!.n).toBe(1)
  // the new workspace opens at its own set-up step, as a new household does
  await press(page, page.getByRole('button', { name: 'Open the household' }))
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await page.goto('/workspace')
  await type(page, page.getByLabel('Signatures for every request'), '2')
  await press(page, page.getByRole('button', { name: 'Save who must sign' }))
  // a rule for two signatures in a workspace of one is refused, said in an alert, and nothing is saved
  await expect(page.getByRole('alert').filter({ hasText: 'That needs more signers than this workspace has' })).toBeVisible()
  expect(query<{ policy_json: string }>("SELECT policy_json FROM users WHERE display_name = 'Kitchen Works'")[0]!.policy_json).toMatch(/"signers":1/)
  // adding a member who does not exist is refused in words too, and the field keeps what was typed
  await type(page, page.getByLabel('Their handle'), 'nobody-here')
  await choose(page, page.getByLabel('Role'), /^Approver/)
  await press(page, page.getByRole('button', { name: 'Add member' }))
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(page.getByLabel('Their handle')).toHaveValue('nobody-here')
  await walkPage(page)
  await press(page, page.getByRole('button', { name: /^Switch to it/ }))
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(userId.length).toBeGreaterThan(0)
})
