/**
 * Getting back in, through the built interface (R12 section 4): a forgotten password reset by a link read from the test
 * outbox; a lost passkey recovered by an email link and a saved code, ending signed in with a passkey that signs in only;
 * that recovered passkey refused an approval, by the sheet and by the server, until its separate, delayed restoration
 * completes; a recovery cancelled from a signed-in device and by a recovery contact; an expired link; and a suspected
 * compromise (every session ended, a stolen passkey suspended). Messages are read from the developer outbox, which says
 * on every message that nothing was sent. Delays are the test stack's (6 s). Since the review of 24 Nov: the link that
 * finishes a recovery, opened in a browser that did not start it, asks for the finishing key and finishes nothing (H1).
 *
 * With QED_SHOTS=<folder>, each state is photographed at 1440 and 390 wide in light and dark.
 */
import { createHash, randomBytes } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import { type Browser, expect, type Page, test } from '../support/test.ts'
import { addAuthenticator, type VirtualAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend, choosePayeeOnSpend } from '../support/payee.ts'
import { force, query } from '../support/stack.ts'
import { shot } from '../support/vault.ts'

// Each journey opens browsers of its own (owner, contact, a new device); they are closed when it ends, so that their pages'
// live connections do not pile up on the stack while the next journeys run (one worker runs them all in turn).
test.afterEach(async ({ browser, context }) => { for (const c of browser.contexts()) if (c !== context) await c.close().catch(() => {}) })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const WAIT = 6500 // the test stack's recovery and protection delays (6 s), and a little more
/** Each journey waits out one to three 6 s delays and makes several accounts; photographing every state (QED_SHOTS) at
 * two widths in two themes takes minutes more on a machine running other suites. */
const LIMIT = process.env.QED_SHOTS ? 900_000 : 300_000

/** Photograph a state at both widths in both themes (only with QED_SHOTS), then put the page back as it was. */
async function shots(page: Page, name: string): Promise<void> {
  if (!process.env.QED_SHOTS) return
  for (const [w, h, scheme] of [[1440, 900, 'light'], [390, 844, 'light'], [1440, 900, 'dark'], [390, 844, 'dark']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(250)
    await shot(page, `${name}-${w}-${scheme}`)
  }
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
}

/**
 * The link in the newest simulated message to an address with this subject, read from the developer outbox page, opened
 * beside `back`. `back` is brought to the front again afterwards: a page that is not in front cannot ask for a passkey.
 */
async function fromOutbox(back: Page, to: string, subject: string | RegExp, name?: string): Promise<string> {
  const p = await back.context().newPage()
  await p.goto('/dev/outbox')
  await expect(p.getByText('Simulated delivery: no email or text message was sent.')).toBeVisible()
  await p.getByLabel('Filter by address').fill(to)
  const msg = p.getByRole('article').filter({ has: p.getByRole('heading', { name: subject }) }).first()
  await expect(msg).toBeVisible({ timeout: 20_000 })
  // every message says it was not sent
  await expect(msg.getByText('Not sent')).toBeVisible()
  if (name) await shots(p, name)
  const href = await msg.getByRole('link').first().getAttribute('href')
  await p.close()
  await back.bringToFront()
  return href!
}
/** Whether a simulated message to this address with this subject exists (read through the API, no page opened). */
const has = async (back: Page, to: string, subject: string): Promise<boolean> =>
  ((await (await back.request.get('/api/dev/outbox?limit=200')).json()) as { messages: { to: string; subject: string }[] }).messages.some((m) => m.to === to && m.subject === subject)

/**
 * A new account whose email address is confirmed by its link. With a password: the ordinary sign-up (R14), with the
 * address itself, whose confirmation is kept in the simulated outbox at once. Without: an account made with a passkey,
 * which saves its recovery codes when offered them and adds the address under Security.
 */
async function accountWithEmail(page: Page, handle: string, email: string, opts: { password?: string; household?: boolean } = {}): Promise<string[]> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  let codes: string[] = []
  if (opts.password) {
    await page.getByLabel('Name to sign with').fill(`Test ${handle}`)
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(opts.password)
    await page.getByText('Choose your handle (optional)').click()
    await page.getByLabel('Handle').fill(handle)
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    // the confirmation is kept in the simulated outbox and is not said to be sent (R13)
    await expect(page.getByText(`Kept in the simulated outbox, not sent to ${email}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(`Confirmation sent to ${email}`)).toHaveCount(0)
    await page.getByRole('button', { name: 'Not now' }).click()
  } else {
    await page.getByRole('button', { name: 'Use a passkey instead' }).click()
    await page.getByLabel('Handle').fill(handle)
    await page.getByLabel('Name to sign with').fill(`Test ${handle}`)
    await page.getByRole('button', { name: 'Create account with a passkey' }).click()
    await expect(page.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
    codes = await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
    await page.getByRole('button', { name: 'Continue' }).click()
    // the address, added under Security: sending its confirmation is enough to go on
    await page.goto('/security')
    await page.getByLabel('Add an email address').fill(email)
    await page.getByRole('button', { name: 'Send a confirmation' }).click()
    // kept in the simulated outbox, never said to be sent (R13): the address waits to be confirmed, and the history says where the message is
    await expect(page.getByRole('button', { name: `Withdraw ${email}` })).toBeVisible()
    await expect(page.getByText(/A confirmation for an email address was kept in the simulated outbox, not sent/).first()).toBeVisible()
    await page.goto('/')
  }
  if (opts.household) { await page.getByRole('button', { name: 'Open the household' }).click(); await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible() }
  // the confirmation link, from the outbox, opened in this browser
  const link = await fromOutbox(page, email, 'Confirm your email address for QED')
  const v = await page.context().newPage()
  await v.goto(link)
  await v.getByRole('button', { name: 'Confirm the address' }).click()
  await expect(v.getByRole('heading', { name: 'Email address confirmed' })).toBeVisible()
  await v.close()
  await page.bringToFront()
  return codes
}

/** On a device with no passkey of the account: the recovery link by email, a saved code, the wait, the new passkey. */
async function recoverByEmail(browser: Browser, email: string, savedCode: string, name = ''): Promise<{ page: Page; auth: VirtualAuthenticator }> {
  const page = await (await browser.newContext()).newPage()
  const auth = await addAuthenticator(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Recover your account' }).click()
  if (name) await shots(page, `${name}-ask`)
  await page.getByLabel('Handle or email address').fill(email)
  await page.getByRole('button', { name: 'Email me a recovery link' }).click()
  // kept in the simulated outbox, never said to be on its way (R13)
  await expect(page.getByText('Kept in the simulated outbox, not sent')).toBeVisible()
  await expect(page.getByText(/on its way/)).toHaveCount(0)
  if (name) await shots(page, `${name}-sent`)
  await page.goto(await fromOutbox(page, email, 'Get back in to your QED account', name ? `${name}-outbox` : undefined))
  await expect(page.getByRole('heading', { name: /^Recover @/ })).toBeVisible()
  expect(page.url()).not.toContain('token=')
  if (name) await shots(page, `${name}-start`)
  await page.getByRole('textbox', { name: 'Saved recovery code' }).fill(savedCode)
  await page.getByRole('button', { name: 'Start the recovery' }).click()
  await expect(page.getByRole('heading', { name: 'Your recovery is waiting' })).toBeVisible()
  if (name) await shots(page, `${name}-waiting`)
  await page.waitForTimeout(WAIT)
  // the engine sends the "ready" link when the wait ends
  const ready = await fromOutbox(page, email, 'Your QED recovery can be finished')
  if (name) {
    // the link alone finishes nothing (review H1): a browser that did not start the recovery is asked for its finishing
    // key, and cannot make a passkey without it
    const elsewhere = await (await browser.newContext()).newPage()
    await elsewhere.goto(ready)
    await expect(elsewhere.getByRole('heading', { name: 'Make your new passkey' })).toBeVisible()
    await expect(elsewhere.getByText('This browser did not start this recovery')).toBeVisible()
    await expect(elsewhere.getByRole('button', { name: 'Create a new passkey on this device' })).toBeDisabled()
    await shots(elsewhere, `${name}-other-browser`)
    await elsewhere.context().close()
    await page.bringToFront()
  }
  await page.goto(ready)
  await expect(page.getByRole('heading', { name: 'Make your new passkey' })).toBeVisible()
  if (name) await shots(page, `${name}-ready`)
  await page.getByRole('button', { name: 'Create a new passkey on this device' }).click()
  await expect(page.getByRole('heading', { name: 'You are back in' })).toBeVisible()
  if (name) await shots(page, `${name}-back-in`)
  return { page, auth }
}

test('forgot password: a link from the outbox sets a new password, ends every session, signs nobody in, and works once', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const handle = unique('fp'), email = `${handle}@gmail.com`, password = `${randomBytes(9).toString('base64url')} phrase`, next = `${randomBytes(9).toString('base64url')} new phrase`
  await accountWithEmail(page, handle, email, { password })
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // another device signed in with the password
  const other = await (await browser.newContext()).newPage()
  await other.goto('/')
  await other.getByLabel('Handle').fill(handle)
  await other.getByLabel('Password', { exact: true }).fill(password)
  await other.getByRole('button', { name: 'Sign in with your password' }).click()
  await expect(other.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  // the address the account was opened with waits the protection delay after its confirmation, like any other (review F4,
  // server/access.test.ts; 6 seconds on this stack): the reset is asked for once it has passed
  await expect.poll(() => (query<{ u: number | null }>(`SELECT usable_from u FROM contact_points WHERE person_id = ? AND kind = 'email' AND verified_at IS NOT NULL AND removed_at IS NULL`, u!.id)[0]?.u ?? Infinity) <= Date.now(), { timeout: 30_000 }).toBe(true)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: 'Reset your password' }).click()
  await shots(page, 'forgot-ask')
  await page.getByLabel('Handle or email address').fill(email)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  await expect(page.getByText('Kept in the simulated outbox, not sent')).toBeVisible()
  await expect(page.getByText(/on its way/)).toHaveCount(0)
  await expect(page.getByText('Simulated delivery in this build')).toBeVisible()
  await shots(page, 'forgot-sent')
  const link = await fromOutbox(page, email, 'Reset your QED password', 'forgot-outbox')
  expect(link).toMatch(/^http:\/\/localhost:\d+\/reset-password#token=[A-Za-z0-9_-]{43}$/)
  const token = link.split('#token=')[1]!
  // only the token's hash is kept
  expect(query(`SELECT token_hash FROM one_time_tokens WHERE purpose = 'password-reset' AND person_id = ? AND replaced_at IS NULL`, u!.id)).toEqual([{ token_hash: sha(token) }])
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
  expect(page.url()).not.toContain('token=')
  await shots(page, 'reset-form')
  await page.getByLabel('New password', { exact: true }).fill(next)
  await page.getByLabel('Type it again', { exact: true }).fill(`${next}x`)
  await page.getByRole('button', { name: 'Set the new password' }).click()
  await expect(page.getByText('The two passwords are not the same.')).toBeVisible()
  await page.getByLabel('Type it again', { exact: true }).fill(next)
  await page.getByRole('button', { name: 'Set the new password' }).click()
  await expect(page.getByRole('heading', { name: 'Your password was changed' })).toBeVisible()
  await shots(page, 'reset-done')
  const axe = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(axe.violations.map((v) => v.id)).toEqual([])
  // every session ended, the other device's too; nobody was signed in by the link; every address was told
  expect(query('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', u!.id)).toEqual([{ n: 0 }])
  await other.reload()
  await expect(other.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible()
  expect(await has(page, email, 'QED: Your password was reset')).toBe(true)
  // the old password no longer opens it; the new one does
  await page.getByRole('button', { name: 'Go to sign in' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in with your password' }).click()
  await expect(page.getByText('That handle and password do not match.')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(next)
  await page.getByRole('button', { name: 'Sign in with your password' }).click()
  await expect(page.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  // the link works once
  const again = await ctx.newPage()
  await again.bringToFront()
  await again.goto(link)
  await expect(again.getByRole('heading', { name: 'This link was already used' })).toBeVisible()
  await again.close()

  // R2 (SECURITY.md 8k): the first passkey added after the reset signs in only and brings no codes; its codes come with its
  // request for approval authority, shown once there, and are the account's only from the end of that wait
  await page.bringToFront()
  await page.goto('/security')
  const none = page.locator('.note').filter({ hasText: 'This account has no passkey' })
  await none.getByLabel('Password').fill(next)
  await none.getByRole('button', { name: 'Create a passkey' }).click()
  await expect(page.getByText('This account has no passkey')).toHaveCount(0)
  await expect(page.locator('.note').filter({ hasText: 'Save these recovery codes now' })).toHaveCount(0)
  const unused = () => query<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', u!.id)[0]!.n
  expect(unused()).toBe(0)
  const authority = page.getByRole('region', { name: 'Approving payments again' })
  await authority.getByRole('button', { name: 'Ask for approval authority' }).click()
  const shown = page.locator('.note').filter({ hasText: 'Save these recovery codes now' })
  await expect(shown.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  await expect(shown.getByText(/They were made with your request for approval authority\. They work from .*, when the passkey can approve/)).toBeVisible()
  await expect(shown.getByRole('button', { name: 'Download as a text file' })).toBeVisible()
  await shots(page, 'reset-authority-codes')
  expect(unused()).toBe(0) // kept apart: nothing accepts them until the authority is given
  await shown.getByRole('button', { name: 'Continue' }).click()
  await expect(shown).toHaveCount(0)
  // the wait ends (6 s on this stack): the passkey can approve, and the codes it brought are the account's
  await expect.poll(unused, { timeout: 30_000 }).toBe(10)
  await page.reload()
  await expect(page.getByRole('region', { name: 'What happened' }).getByText('The saved recovery codes made with the request for approval authority now work')).toBeVisible()
})

test('an expired link says so plainly and leads to a new one', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const handle = unique('ex'), email = `${handle}@gmail.com`, password = `${randomBytes(9).toString('base64url')} phrase`
  await accountWithEmail(page, handle, email, { password })
  await page.waitForTimeout(WAIT)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: 'Reset your password' }).click()
  await page.getByLabel('Handle or email address').fill(handle)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  await expect(page.getByText('Kept in the simulated outbox, not sent')).toBeVisible()
  const link = await fromOutbox(page, email, 'Reset your QED password')
  // 30 minutes pass: the one state the interface cannot reach in a test, written to the stack's database (named here)
  expect(force(`UPDATE one_time_tokens SET expires_at = ? WHERE token_hash = ?`, Date.now() - 1000, sha(link.split('#token=')[1]!))).toBe(1)
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
  await expect(page.getByText(/links from QED work for 30 minutes/)).toBeVisible()
  await shots(page, 'link-expired')
  await page.getByRole('button', { name: 'Ask for a new link' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
  await page.getByLabel('Handle or email address').fill(handle)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  const fresh = await fromOutbox(page, email, 'Reset your QED password')
  expect(fresh).not.toBe(link)
  await page.goto(fresh)
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
})

test('a lost passkey: an email link and a saved code start a recovery that waits; a new link finishes it, and the new passkey signs in', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('lp'), email = `${handle}@gmail.com`
  const codes = await accountWithEmail(owner, handle, email)
  await owner.waitForTimeout(WAIT)
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // every device of the owner is lost; on a new one:
  await owner.context().close()
  const { page, auth } = await recoverByEmail(browser, email, codes[4]!, 'recover')
  expect(query('SELECT via, method, completed_at IS NOT NULL done FROM recovery_requests WHERE person_id = ?', u!.id)).toEqual([{ via: 'email', method: 'email+saved', done: 1 }])
  expect(query(`SELECT authority, authority_reason FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at`, u!.id)).toEqual([{ authority: 'full', authority_reason: null }, { authority: 'signin', authority_reason: 'recovery' }])
  // the recovery spent a saved code: a new set is offered, not imposed
  await page.getByRole('button', { name: 'Show the new codes' }).click()
  const fresh = await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  expect(fresh).toHaveLength(10)
  expect(fresh.filter((c) => codes.includes(c))).toEqual([])
  await page.getByRole('button', { name: 'Later' }).click()
  await expect(page.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  // signed out and in again with the new passkey
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(page.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  const session = await page.evaluate(async () => (await fetch('/api/session')).json()) as Record<string, unknown>
  expect(session).toMatchObject({ authenticated: true, authMethod: 'passkey', passkeyAuthority: 'signin', stepUpFresh: false })
  expect((await auth.credentials())).toHaveLength(1)
  // the account's address heard of each step
  for (const s of ['QED: A recovery of your account has started', 'QED: A recovery of your account was completed']) expect(await has(page, email, s), s).toBe(true)
})

test('the recovered passkey is refused an approval, by the sheet and by the server, until its separate delayed restoration completes', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('ra'), email = `${handle}@gmail.com`
  const codes = await accountWithEmail(owner, handle, email, { household: true })
  await owner.waitForTimeout(WAIT)
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await owner.context().close()
  const { page } = await recoverByEmail(browser, email, codes[1]!)
  await page.getByRole('button', { name: 'Later' }).click()
  const banner = page.getByRole('status').filter({ hasText: 'Your passkey signs you in, but cannot approve payments yet.' })
  await expect(banner).toBeVisible()
  // a payment prepared on the recovered device: the sheet says why it cannot be approved, and offers no approval
  await page.goto('/pay')
  await addPayeeOnSpend(page, 'Corner Shop', 'corner.shop@upi')
  await page.getByLabel('How much').fill('250')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Your passkey cannot approve this yet')).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeDisabled()
  await shots(page, 'approval-refused')
  // and the server refuses the recovered passkey's own signature over the exact terms
  const [a] = query<{ id: string; doc_hash: string }>(`SELECT id, doc_hash FROM approvals WHERE user_id = ? AND confirmed_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`, u!.id)
  const refused = await page.evaluate(async ({ id, docHash }) => {
    const s = await (await fetch('/api/session')).json() as { csrf: string }
    const h = { 'Content-Type': 'application/json', 'X-QED-Client': 'web', 'X-QED-CSRF': s.csrf }
    const b = await (await fetch(`/api/approvals/${id}/passkey`, { method: 'POST', headers: h, body: '{}' })).json() as { challengeId: string; options: { challenge: string; rpId: string } }
    const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((x.length + 3) % 4)), (c) => c.charCodeAt(0))
    const enc = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    // the device's own passkey answers (no list of allowed passkeys: the one this device holds)
    const cred = await navigator.credentials.get({ publicKey: { challenge: dec(b.options.challenge), rpId: b.options.rpId, userVerification: 'required' } }) as PublicKeyCredential
    const r = cred.response as AuthenticatorAssertionResponse
    const response = { id: cred.id, rawId: enc(cred.rawId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), ...(r.userHandle ? { userHandle: enc(r.userHandle) } : {}) } }
    const c = await fetch(`/api/approvals/${id}/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ challengeId: b.challengeId, response, docHash }) })
    return { status: c.status, code: ((await c.json()) as { error?: { code?: string } }).error?.code }
  }, { id: a!.id, docHash: a!.doc_hash })
  expect(refused).toEqual({ status: 409, code: 'authority_restricted' })
  expect(query(`SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL`, u!.id)).toEqual([{ n: 0 }])
  await sheet.getByRole('button', { name: 'Not now' }).click()
  // the separate restoration: asked with the recovered passkey, it waits, and everyone is told
  await banner.getByRole('link', { name: 'Ask for approval authority' }).click()
  const part = page.getByRole('region', { name: 'Approving payments again' })
  await expect(part).toBeVisible()
  await part.getByRole('button', { name: 'Ask for approval authority' }).click()
  await expect(part.getByText(/Asked: it can approve from/)).toBeVisible()
  await shots(page, 'authority-asked')
  expect(await has(page, email, 'QED: A passkey of your account asked for approval authority')).toBe(true)
  // while it waits, still nothing approves
  await page.goto('/pay')
  await choosePayeeOnSpend(page, 'corner.shop@upi')
  await page.getByLabel('How much').fill('250')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeDisabled()
  await sheet.getByRole('button', { name: 'Not now' }).click()
  // when the wait ends the engine applies it; the same passkey then approves
  await page.waitForTimeout(WAIT)
  await expect.poll(() => query<{ authority: string }>(`SELECT authority FROM webauthn_credentials WHERE person_id = ? AND authority_reason IS NULL AND created_at = (SELECT MAX(created_at) FROM webauthn_credentials WHERE person_id = ?)`, u!.id, u!.id)[0]?.authority, { timeout: 15_000 }).toBe('full')
  await page.reload()
  await expect(page.getByText('Your passkey signs you in, but cannot approve payments yet.')).toHaveCount(0)
  await page.goto('/pay')
  await choosePayeeOnSpend(page, 'corner.shop@upi')
  await page.getByLabel('How much').fill('250')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await expect(sheet.getByText('Your passkey cannot approve this yet')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => query<{ n: number }>(`SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL`, u!.id)[0]!.n, { timeout: 20_000 }).toBe(1)
  expect(await has(page, email, 'QED: A passkey of your account can now approve')).toBe(true)
})

test('a recovery is cancelled from a signed-in device, and again by a recovery contact; each time the account hears of it and nothing completes', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('rc'), email = `${handle}@gmail.com`
  const codes = await accountWithEmail(owner, handle, email)
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // a recovery contact, accepted and active after the protection delay
  const helper = await (await browser.newContext()).newPage()
  await addAuthenticator(helper)
  const helperHandle = unique('hc')
  await helper.goto('/')
  await helper.getByRole('button', { name: 'Create an account' }).click()
  await helper.getByRole('button', { name: 'Use a passkey instead' }).click()
  await helper.getByLabel('Handle').fill(helperHandle)
  await helper.getByLabel('Name to sign with').fill(`Test ${helperHandle}`)
  await helper.getByRole('button', { name: 'Create account with a passkey' }).click()
  await helper.getByRole('button', { name: 'Continue' }).click()
  await owner.goto('/security')
  await owner.getByLabel('Their handle').fill(helperHandle)
  await owner.getByRole('button', { name: 'Name as recovery contact' }).click()
  await expect(owner.getByText(/waiting for them to accept/)).toBeVisible()
  await helper.goto('/security')
  await helper.getByRole('button', { name: 'Accept' }).click()
  await owner.waitForTimeout(WAIT)

  // someone with the mailbox and one saved code starts a recovery
  const other = await (await browser.newContext()).newPage()
  await addAuthenticator(other)
  await other.goto('/')
  await other.getByRole('button', { name: 'Recover your account' }).click()
  await other.getByLabel('Handle or email address').fill(email)
  await other.getByRole('button', { name: 'Email me a recovery link' }).click()
  await other.goto(await fromOutbox(other, email, 'Get back in to your QED account'))
  await other.getByRole('textbox', { name: 'Saved recovery code' }).fill(codes[0]!)
  await other.getByRole('button', { name: 'Start the recovery' }).click()
  await expect(other.getByRole('heading', { name: 'Your recovery is waiting' })).toBeVisible()
  // the owner's signed-in device is told on every page, and cancels it
  await owner.goto('/')
  await expect(owner.getByRole('alert').filter({ hasText: 'Someone started a recovery of this account' })).toBeVisible()
  await owner.getByRole('link', { name: 'cancel it on the security page' }).click()
  await shots(owner, 'cancel-needs-you')
  await owner.getByRole('button', { name: 'Cancel this recovery' }).click()
  await expect(owner.getByRole('button', { name: 'Cancel this recovery' })).toHaveCount(0)
  // no new set is handed to the session that cancels (H2); the owner is told one code was used and to make new ones
  await expect(owner.getByText('One of your saved codes was used', { exact: true })).toBeVisible()
  await expect(owner.getByRole('list', { name: 'New recovery codes' })).toHaveCount(0)
  expect(await has(owner, email, 'QED: A recovery of your account was stopped')).toBe(true)
  // nothing can finish it now. If its wait had already ended before the owner stopped it (a slow machine), its "ready"
  // link went out then; that link now says the recovery was stopped. Either way no passkey is added.
  await other.waitForTimeout(WAIT)
  if (await has(other, email, 'Your QED recovery can be finished')) {
    await other.goto(await fromOutbox(other, email, 'Your QED recovery can be finished'))
    await expect(other.getByRole('heading', { name: 'This recovery was stopped' })).toBeVisible()
  }
  expect(query('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ?', u!.id)).toEqual([{ n: 1 }])

  // a second attempt, stopped this time by the recovery contact
  await other.goto('/?help=recover')
  await other.getByLabel('Handle or email address').fill(handle)
  await other.getByRole('button', { name: 'Email me a recovery link' }).click()
  await other.goto(await fromOutbox(other, email, 'Get back in to your QED account'))
  await other.getByRole('textbox', { name: 'Saved recovery code' }).fill(codes[1]!) // one of the printed codes still unused (the first was spent)
  await other.getByRole('button', { name: 'Start the recovery' }).click()
  await expect(other.getByRole('heading', { name: 'Your recovery is waiting' })).toBeVisible()
  await helper.goto('/security')
  await helper.getByRole('button', { name: 'Stop their recovery' }).click()
  await expect(helper.getByText(/Do this if they did not tell you about it themselves/)).toBeVisible()
  await shots(helper, 'contact-stop')
  await helper.getByRole('button', { name: 'Stop it', exact: true }).click()
  await expect(helper.getByRole('button', { name: 'Stop their recovery' })).toHaveCount(0)
  const reqs = query<{ cancelled_by: string | null; completed_at: number | null }>('SELECT cancelled_by, completed_at FROM recovery_requests WHERE person_id = ? ORDER BY started_at', u!.id)
  expect(reqs).toEqual([{ cancelled_by: expect.stringMatching(/^session:/), completed_at: null }, { cancelled_by: `contact:${helperHandle}`, completed_at: null }])
  await owner.goto('/security')
  await expect(owner.getByRole('region', { name: 'What happened' }).getByText('Recovery stopped').first()).toBeVisible()
  expect(query('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ?', u!.id)).toEqual([{ n: 1 }])
})

test('ending a recovery contact waits (8j (c)): shown pending with its time, cancelled with the passkey, then with a saved code; a third request applies after the delay', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('ec')
  await owner.goto('/')
  await owner.getByRole('button', { name: 'Create an account' }).click()
  await owner.getByRole('button', { name: 'Use a passkey instead' }).click()
  await owner.getByLabel('Handle').fill(handle)
  await owner.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await owner.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(owner.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  const codes = await owner.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  await owner.getByRole('button', { name: 'Continue' }).click()
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // a recovery contact, accepted and active after the protection delay
  const helper = await (await browser.newContext()).newPage()
  await addAuthenticator(helper)
  const helperHandle = unique('eh')
  await helper.goto('/')
  await helper.getByRole('button', { name: 'Create an account' }).click()
  await helper.getByRole('button', { name: 'Use a passkey instead' }).click()
  await helper.getByLabel('Handle').fill(helperHandle)
  await helper.getByLabel('Name to sign with').fill(`Test ${helperHandle}`)
  await helper.getByRole('button', { name: 'Create account with a passkey' }).click()
  await helper.getByRole('button', { name: 'Continue' }).click()
  await owner.goto('/security')
  await owner.getByLabel('Their handle').fill(helperHandle)
  await owner.getByRole('button', { name: 'Name as recovery contact' }).click()
  await expect(owner.getByText(/waiting for them to accept/)).toBeVisible()
  await helper.goto('/security')
  await helper.getByRole('button', { name: 'Accept' }).click()
  await expect(helper.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  await owner.waitForTimeout(WAIT)
  await owner.goto('/security')
  const contacts = owner.locator('.sy-sub').filter({ has: owner.getByRole('heading', { name: 'Recovery contacts' }) })
  await expect(contacts.getByText(/^Active since/)).toBeVisible()
  const ending = () => query<{ id: string }>(`SELECT id FROM scheduled_changes WHERE person_id = ? AND kind = 'remove-contact' AND cancelled_at IS NULL AND applied_at IS NULL`, u!.id)
  // The test stack's delay is 6 s. Where this journey reads and acts on the waiting removal, it is given five minutes
  // (a labelled harness write); the third request below is left to the stack's own delay and its engine.
  const give = async (): Promise<void> => { await expect.poll(() => ending().length).toBe(1); force('UPDATE scheduled_changes SET effective_at = ? WHERE id = ?', Date.now() + 300_000, ending()[0]!.id); await owner.reload() }
  const end = contacts.getByRole('button', { name: `End @${helperHandle}` })
  const needs = owner.getByRole('region', { name: 'Needs you' })
  const item = needs.getByRole('listitem').filter({ hasText: `End @${helperHandle} as your recovery contact` })

  // 1. ending the contact is scheduled, not done: the page says it waits, until when, and how to cancel it; both are told
  await end.click()
  await give()
  await expect(item.getByText(/takes effect .*Until then they stay your recovery contact and can still issue you a code\. To keep it, cancel this with any of your passkeys, or with one of your saved recovery codes\./)).toBeVisible()
  await expect(contacts.getByText(/^Ends .*Until then they stay your recovery contact\./)).toBeVisible()
  await expect(end).toHaveCount(0)
  expect(query('SELECT COUNT(*) n FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL', u!.id)).toEqual([{ n: 1 }])
  await expect(owner.getByRole('region', { name: 'What happened' }).getByText('Ending a recovery contact was asked for; it waits before it takes effect')).toBeVisible()
  await helper.goto('/security')
  await expect(helper.getByText(/they asked to end you as their recovery contact, which takes effect .*: if they did not tell you, call them/)).toBeVisible()
  await owner.bringToFront()
  await shots(owner, 'contact-ending-pending')
  expect((await new AxeBuilder({ page: owner as never }).include('.sy-needs').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => v.id)).toEqual([])

  // 2. cancelled with the passkey
  await item.getByRole('button', { name: 'Cancel it' }).click()
  await expect(item).toHaveCount(0)
  expect(ending()).toEqual([])
  await expect(end).toBeVisible()

  // 3. asked again, and cancelled with a saved code, which is not used up
  await end.click()
  await give()
  await item.getByRole('button', { name: 'Use a saved code instead' }).click()
  await item.getByLabel('One of your saved recovery codes').fill(codes[0]!)
  await shots(owner, 'contact-ending-code')
  await item.getByRole('button', { name: 'Cancel with this code' }).click()
  await expect(item).toHaveCount(0)
  expect(ending()).toEqual([])
  expect(query('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', u!.id)).toEqual([{ n: 10 }])
  await expect(owner.getByRole('region', { name: 'What happened' }).getByText('A scheduled change was cancelled with a saved recovery code')).toBeVisible()

  // 4. asked a third time and left alone: it takes effect when the delay ends, once, and the contact is gone
  await end.click()
  await expect.poll(() => ending().length).toBe(1)
  await expect.poll(() => query<{ n: number }>('SELECT COUNT(*) n FROM recovery_contacts WHERE person_id = ? AND removed_at IS NOT NULL', u!.id)[0]!.n, { timeout: 30_000 }).toBe(1)
  await owner.reload()
  await expect(contacts.getByText('None yet.')).toBeVisible()
  await expect(owner.getByRole('region', { name: 'What happened' }).getByText('Recovery contact ended')).toBeVisible()
})

test('suspected compromise: every session ends from "If something is wrong", and a stolen passkey is suspended', async ({ browser }) => {
  test.setTimeout(LIMIT)
  const owner = await (await browser.newContext()).newPage()
  const laptop = await addAuthenticator(owner)
  const handle = unique('sc')
  await owner.goto('/')
  await owner.getByRole('button', { name: 'Create an account' }).click()
  await owner.getByRole('button', { name: 'Use a passkey instead' }).click()
  await owner.getByLabel('Handle').fill(handle)
  await owner.getByLabel('Name to sign with').fill(`Test ${handle}`)
  await owner.getByRole('button', { name: 'Create account with a passkey' }).click()
  // R14 (F1): the codes come with the first device and are shown once
  await expect(owner.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  const codes = await owner.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  await owner.getByRole('button', { name: 'Continue' }).click()
  // a second passkey on another authenticator; the first one's key is copied to a thief
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
  // the owner, on the device with the other passkey: "If something is wrong", then end every session
  await owner.goto('/security')
  const wrong = owner.getByRole('region', { name: 'If something is wrong' })
  await expect(wrong.getByText('You think someone else is in')).toBeVisible()
  await shots(owner, 'if-wrong')
  await wrong.getByRole('button', { name: 'End every session' }).click()
  await owner.getByRole('button', { name: 'End every session, this one too' }).click()
  await expect(owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible()
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  expect(query('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', u!.id)).toEqual([{ n: 0 }])
  await thief.reload()
  await expect(thief.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible()
  // back in with the passkey still held; the stolen one suspended at once
  await owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(owner.getByText(`Signed in as Test ${handle}`)).toBeVisible()
  await owner.goto('/security')
  // it leaves a single usable passkey, so it needs one of the saved codes, which the thief does not have (H2)
  await owner.getByRole('textbox', { name: 'A saved recovery code, to suspend' }).fill(codes[0]!)
  await owner.getByRole('button', { name: 'Suspend now' }).click()
  await expect(owner.getByText(/Suspended .*: it cannot sign in, confirm or approve/)).toBeVisible()
  await thief.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(thief.getByText(/could not be verified|could not be used/)).toBeVisible()
})
