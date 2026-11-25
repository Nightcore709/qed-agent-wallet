/**
 * Passkeys through the interface (R7-073, R7-074, R7-062, R7-130): a fresh account with no password, recovery codes
 * shown once, sign-out and sign-in with the passkey, a sign-in refused without user verification, the security
 * screen against the database; recovery at NIST AAL2 (a saved code and a code a recovery contact issues) that waits,
 * can be cancelled from a signed-in session, and when completed replaces every saved code; a stolen passkey suspended
 * at once from another.
 */
import { type Browser, expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

// Each journey opens browsers of its own (owner, contact, a new device); they are closed when it ends, so that their pages'
// live connections do not pile up on the stack while the next journeys run (one worker runs them all in turn).
test.afterEach(async ({ browser, context }) => { for (const c of browser.contexts()) if (c !== context) await c.close().catch(() => {}) })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function createAccount(page: Page, handle: string): Promise<string[]> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  // R14 (F1): no box to tick, but the codes are made with the first device and shown once, with Copy, Download and Continue
  await expect(page.getByRole('heading', { name: 'Device sign-in is set up' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible()
  await expect(page.getByText('settle a dispute between two of your devices')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy them' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download as a text file' })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  const codes = await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  await page.getByRole('button', { name: 'Continue' }).click()
  return codes
}

test('a fresh account is created with a passkey and no password, shows ten recovery codes once, and the database agrees', async ({ page }) => {
  const auth = await addAuthenticator(page)
  const handle = unique('pk')
  const codes = await createAccount(page, handle)
  expect(codes).toHaveLength(10)
  for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
  // the authenticator holds one resident credential, and the server holds the same credential for this person
  const held = await auth.credentials()
  expect(held).toHaveLength(1)
  const [user] = query<{ id: string; pw_hash: string; kind: string }>('SELECT id, pw_hash, kind FROM users WHERE handle = ?', handle)
  expect(user).toMatchObject({ pw_hash: '!', kind: 'person' })
  const creds = query<{ id: string }>('SELECT id FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', user!.id)
  expect(creds.map((c) => Buffer.from(c.id, 'base64url').toString('base64'))).toEqual([held[0]!.credentialId])
  expect(query('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', user!.id)[0]).toEqual({ n: 10 })
  const session = await page.evaluate(async () => (await fetch('/api/session')).json())
  expect(session).toMatchObject({ authenticated: true, authMethod: 'passkey', hasPasskey: true })
})

test('signs out and back in with the passkey; a sign-in without user verification is refused', async ({ page }) => {
  const auth = await addAuthenticator(page)
  const handle = unique('si')
  await createAccount(page, handle)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible()
  await auth.setVerified(false)
  await page.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(page.getByText(/could not be verified|could not be used|closed before it finished/)).toBeVisible()
  await auth.setVerified(true)
  await page.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(page.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  const session = await page.evaluate(async () => (await fetch('/api/session')).json())
  expect(session).toMatchObject({ authenticated: true, authMethod: 'passkey', user: { handle } })
})

/** The owner names a second person as recovery contact; the contact accepts; after the (test) delay, issues a code. */
async function contactFor(browser: Browser, ownerHandle: string, owner: Page): Promise<{ contact: Page; contactHandle: string; issue: () => Promise<string> }> {
  const contact = await (await browser.newContext()).newPage()
  await addAuthenticator(contact)
  const contactHandle = unique('ct')
  await createAccount(contact, contactHandle)
  await owner.goto('/security')
  await owner.getByLabel('Their handle').fill(contactHandle)
  await owner.getByRole('button', { name: 'Name as recovery contact' }).click()
  await expect(owner.getByText(/waiting for them to accept/)).toBeVisible()
  await contact.goto('/security')
  await contact.getByRole('button', { name: 'Accept' }).click()
  await expect(contact.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  // the contact becomes active only after the protection delay (6 s on the test stack)
  await contact.waitForTimeout(6500)
  return {
    contact, contactHandle,
    issue: async () => {
      await contact.goto('/security')
      await contact.getByRole('button', { name: 'Issue a recovery code' }).click()
      await expect(contact.getByText(/Issue a code only if they asked you in person/)).toBeVisible()
      await contact.getByRole('button', { name: 'Issue the code' }).click()
      const code = (await contact.getByLabel('Recovery code for them').innerText()).trim()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
      expect(query<{ n: number }>('SELECT COUNT(*) n FROM contact_codes c JOIN users u ON u.id = c.person_id WHERE u.handle = ? AND c.used_at IS NULL AND c.replaced_at IS NULL', ownerHandle)[0]).toEqual({ n: 1 })
      return code
    },
  }
}
async function startRecoveryAs(page: Page, handle: string, saved: string, contactCode: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Recover your account' }).click()
  // the email link comes first (R12); without access to the email, the saved codes are the backup way
  await expect(page.getByRole('button', { name: 'Email me a recovery link' })).toBeVisible()
  await page.getByRole('button', { name: 'Use your saved codes instead' }).click()
  // the recovery form's own fields: the folded "pause QED with a saved code" form on the same page has a Handle and a
  // saved code too (8d0ecc1), so a label match found two of each; the visible textbox named exactly so is this form's
  await page.getByRole('textbox', { name: 'Handle', exact: true }).fill(handle)
  await page.getByRole('textbox', { name: 'Saved recovery code', exact: true }).fill(saved)
  await page.getByLabel('Code from your recovery contact').fill(contactCode)
  await page.getByRole('button', { name: 'Start recovery' }).click()
  await expect(page.getByText('If the handle and both codes were right, a recovery has started')).toBeVisible()
}

test('a saved code and a contact’s code start a recovery that the signed-in owner sees and cancels; it can then not be completed', async ({ browser }) => {
  // three accounts, a contact's delay and a recovery's (6 s each): over two minutes on a machine running other suites
  test.setTimeout(240_000)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('rc')
  const codes = await createAccount(owner, handle)
  const { contact, issue } = await contactFor(browser, handle, owner)
  const code = await issue()
  // the owner's account is told that a code was issued for it
  await owner.goto('/security')
  await expect(owner.getByText('Your recovery contact issued a recovery code for this account')).toBeVisible()
  // someone else, on another device, uses a saved code with the contact's code
  const other = await (await browser.newContext()).newPage()
  await addAuthenticator(other)
  await startRecoveryAs(other, handle, codes[3]!, code)
  expect(query('SELECT r.method FROM recovery_requests r JOIN users u ON u.id = r.person_id WHERE u.handle = ?', handle)).toEqual([{ method: 'saved+contact' }])
  // every page of the owner's warns; the owner cancels from the security page
  await owner.goto('/')
  await expect(owner.getByRole('alert').filter({ hasText: 'Someone started a recovery of this account' })).toBeVisible()
  await owner.getByRole('link', { name: 'cancel it on the security page' }).click()
  await owner.getByRole('button', { name: 'Cancel this recovery' }).click()
  await expect(owner.getByRole('button', { name: 'Cancel this recovery' })).toHaveCount(0)
  // the code that recovery used is spent; no new set is handed to the session that cancels (a thief could be the one
  // cancelling, H2): the owner is told to make new codes, which needs one of the nine left
  await expect(owner.getByText('One of your saved codes was used', { exact: true })).toBeVisible()
  await expect(owner.getByRole('list', { name: 'New recovery codes' })).toHaveCount(0)
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes c JOIN users u ON u.id = c.person_id WHERE u.handle = ? AND c.used_at IS NULL AND c.replaced_at IS NULL', handle)[0]!.n).toBe(9)
  const [r] = query<{ cancelled_at: number | null }>('SELECT r.cancelled_at FROM recovery_requests r JOIN users u ON u.id = r.person_id WHERE u.handle = ?', handle)
  expect(r!.cancelled_at).not.toBeNull()
  // the contact saw the recovery start and end
  await contact.goto('/security')
  await expect(contact.getByText('A recovery started for someone who trusts you')).toBeVisible()
  await expect(contact.getByText('A recovery was cancelled for someone who trusts you')).toBeVisible()
  // after the delay the other device still cannot finish it
  await other.waitForTimeout(6500)
  await other.getByRole('button', { name: 'Create a new passkey now' }).click()
  await expect(other.getByText(/not open|cancelled/)).toBeVisible()
})

test('a recovery left alone completes after the delay with a new passkey, and shows a new set of saved codes once; the old ones stop working', async ({ browser }) => {
  // three accounts, a contact's delay and a recovery's (6 s each): over two minutes on a machine running other suites
  test.setTimeout(240_000)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('rd')
  const codes = await createAccount(owner, handle)
  const { issue } = await contactFor(browser, handle, owner)
  const code = await issue()
  // every device with the passkey is lost; on a new device, with a fresh authenticator
  const device = await (await browser.newContext()).newPage()
  await addAuthenticator(device)
  await startRecoveryAs(device, handle, codes[0]!, code)
  await device.waitForTimeout(6500)
  await device.getByRole('button', { name: 'Create a new passkey now' }).click()
  // R12: back in with a passkey that signs in only; the new codes are offered, not imposed
  await expect(device.getByRole('heading', { name: 'You are back in' })).toBeVisible()
  await device.getByRole('button', { name: 'Show the new codes' }).click()
  const fresh = await device.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  expect(fresh).toHaveLength(10)
  expect(fresh.filter((c) => codes.includes(c))).toEqual([])
  await device.getByRole('button', { name: 'Later' }).click()
  await expect(device.getByText(/Signed in as Test /)).toBeVisible()
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  expect(query('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', u!.id)[0]).toEqual({ n: 2 })
  expect(query('SELECT algo, COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL GROUP BY algo', u!.id)).toEqual([{ algo: 'scrypt', n: 10 }])
  expect(query<{ completed_at: number | null }>('SELECT completed_at FROM recovery_requests WHERE person_id = ?', u!.id)[0]!.completed_at).not.toBeNull()
  // the recovered passkey signs in only (R12): the other one keeps full authority
  expect(query('SELECT authority, COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL GROUP BY authority ORDER BY authority', u!.id)).toEqual([{ authority: 'full', n: 1 }, { authority: 'signin', n: 1 }])
})

test('a stolen passkey is suspended at once from another: its session ends and it can no longer sign in', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  const laptop = await addAuthenticator(owner)
  const handle = unique('su')
  const codes = await createAccount(owner, handle)
  // a second passkey, made on another authenticator; the first one's key is copied to a thief's browser
  const stolen = await laptop.credentials()
  await laptop.remove()
  await addAuthenticator(owner)
  await owner.goto('/security')
  await owner.getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect(owner.getByRole('button', { name: 'Remove' })).toHaveCount(2)
  const thief = await (await browser.newContext()).newPage()
  const t = await addAuthenticator(thief)
  await t.load(stolen)
  await thief.goto('/')
  await thief.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(thief.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  // the owner signs in with the passkey they still hold and suspends the stolen one
  await owner.getByRole('button', { name: 'Sign out' }).click()
  await owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(owner.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  await owner.goto('/security')
  // it leaves a single usable passkey, so it needs one of the saved codes, which the thief does not have (H2)
  await owner.getByRole('textbox', { name: 'A saved recovery code, to suspend' }).fill(codes[0]!)
  await owner.getByRole('button', { name: 'Suspend now' }).click()
  await expect(owner.getByText(/Suspended .*: it cannot sign in, confirm or approve/)).toBeVisible()
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND suspended_at IS NOT NULL', u!.id)[0]).toEqual({ n: 1 })
  // the thief's session has ended, and the stolen passkey no longer signs in
  await thief.reload()
  await expect(thief.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible()
  await thief.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(thief.getByText(/could not be verified|could not be used/)).toBeVisible()
})
