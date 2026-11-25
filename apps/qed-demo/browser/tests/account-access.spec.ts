/**
 * Account access as a familiar financial app does it (R14, Priority 1), through the built interface:
 *
 *   1. an account opened with an email address and a password, then the device ("Use your fingerprint, Face ID or
 *      device PIN for faster, more secure access"), sign-out, and sign-in with the device; no saved codes are forced;
 *   2. signing in with the address or the handle and the password; a wrong password and an unknown address read alike;
 *   3. a device with no fingerprint, face or PIN check of its own: the page says so, and a security key works;
 *   4. recovery: the first device brought the saved codes, shown once; one of them, beside the email link, starts a
 *      recovery that waits and that the owner's device is told of;
 *   5. Google, against a local stand-in issuer on a stack of its own: the round trip, a new account, the device, and an
 *      address that matches an existing account linking nothing; with Google not configured, no button at all;
 *   6. an installation that cannot send email (production today): the account works, its address is plainly not
 *      verified, verifying is said to be unavailable, and nothing is said to be sent.
 *
 * Passwords are made here and never leave the test. With QED_SHOTS=<folder> the screens are saved at 1440, 1024, 768 and
 * 390 px for reading.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { allowSignups, extraPort, query, startExtraStack } from '../support/stack.ts'
import { type StandIn, startOidcStandIn } from '../../server/oidc-standin.ts'
import { DEVICE_SIGN_IN, ENROL_WORDS, NO_DEVICE_CHECK, ORDINARY_SIGN_IN_LIMIT } from '../../shared/access-operations.ts'

test.afterEach(async ({ browser, context }) => { for (const c of browser.contexts()) if (c !== context) await c.close().catch(() => {}) })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const pass = (): string => `${randomBytes(9).toString('base64url')} phrase`
const WIDTHS = [1440, 1024, 768, 390]
/** With QED_SHOTS set: this screen at the four widths the mandate names, whole page. */
async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.QED_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const before = page.viewportSize()
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 })
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(dir, `${name}-${w}.png`), fullPage: true, animations: 'disabled' })
  }
  if (before) await page.setViewportSize(before)
}
const session = (page: Page): Promise<Record<string, any>> => page.evaluate(async () => (await fetch('/api/session')).json())

/** Open an account with an email address and a password, on the sign-up form; lands on the device step. */
async function signUpWithEmail(page: Page, o: { name: string; email: string; password: string; handle?: string }, base = ''): Promise<void> {
  allowSignups()
  await page.goto(`${base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Name to sign with').fill(o.name)
  await page.getByLabel('Email', { exact: true }).fill(o.email)
  await page.getByLabel('Password', { exact: true }).fill(o.password)
  if (o.handle) { await page.getByText('Choose your handle (optional)').click(); await page.getByLabel('Handle').fill(o.handle) }
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Faster, more secure access' })).toBeVisible({ timeout: 30_000 })
}

test('an account is opened with an email and a password, the device is set up in one step, and after signing out the device signs in; no saved codes are forced', async ({ page }) => {
  test.setTimeout(120_000)
  await addAuthenticator(page)
  const email = `${unique('meera')}@example.in`, password = pass()
  await page.goto('/')
  // the sign-in page: the ordinary way first, the device beside it, and no Google or phone option where none is configured
  await expect(page.getByRole('heading', { name: 'Sign in to QED' })).toBeVisible()
  await expect(page.getByLabel('Email or handle')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with your password' })).toBeVisible()
  await expect(page.getByRole('button', { name: DEVICE_SIGN_IN })).toBeVisible()
  await expect(page.getByRole('button', { name: /Google/ })).toHaveCount(0)
  await expect(page.getByText(/phone number|text message|SMS/i)).toHaveCount(0)
  await expect(page.getByText(ORDINARY_SIGN_IN_LIMIT)).toBeVisible()
  await shots(page, '1-sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await shots(page, '2-create-account')

  await signUpWithEmail(page, { name: 'Meera Nair', email, password })
  // the step after sign-up, in the owner's words; it can be left for later
  await expect(page.getByText(ENROL_WORDS)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible()
  // the confirmation is kept in the simulated outbox, and is not said to be sent
  await expect(page.getByText(`Kept in the simulated outbox, not sent to ${email}`)).toBeVisible()
  await expect(page.getByText(/Check your email|is on its way|Confirmation sent/)).toHaveCount(0)
  // no codes step stood in the way, and none was made
  const [u] = query<{ id: string; handle: string; email: string; pw_hash: string }>('SELECT id, handle, email, pw_hash FROM users WHERE email_key = ?', email.toLowerCase())
  expect(u).toMatchObject({ email, handle: expect.stringMatching(/^meera\.nair/) })
  expect(u!.pw_hash.startsWith('scrypt$')).toBe(true)
  expect(query('SELECT 1 FROM recovery_codes WHERE person_id = ?', u!.id)).toHaveLength(0)
  expect(await session(page)).toMatchObject({ authenticated: true, authMethod: 'password', stepUpFresh: false, hasPasskey: false, email: { address: email, verified: false, pending: true } })
  await shots(page, '3-device-step')

  // one step: the device asks for its own check, and the account has its passkey
  await page.getByRole('button', { name: 'Set up device sign-in' }).click()
  await expect(page.getByRole('heading', { name: 'Device sign-in is set up' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible()
  // F1: the codes come with the first device, shown once, with Copy, Download and Continue and no box to tick
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  await expect(page.getByText('settle a dispute between two of your devices')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy them' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download as a text file' })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await shots(page, '4-device-ready')
  expect(query<{ authority: string; cool_off_until: number | null }>('SELECT authority, cool_off_until FROM webauthn_credentials WHERE person_id = ?', u!.id)).toEqual([{ authority: 'full', cool_off_until: null }])
  expect(query('SELECT 1 FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', u!.id)).toHaveLength(10)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toBeVisible()

  // sign out, and sign in with the device: a passkey session, which is what approves
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: DEVICE_SIGN_IN }).click()
  await expect(page.getByText('Signed in as Meera Nair')).toBeVisible()
  expect(await session(page)).toMatchObject({ authenticated: true, authMethod: 'passkey', stepUpFresh: true, hasPasskey: true, user: { handle: u!.handle } })
})

test('the address or the handle signs in with the password; a wrong password and an address nobody uses read alike; the password session approves nothing', async ({ page }) => {
  test.setTimeout(120_000)
  const handle = unique('pw'), email = `${handle}@example.in`, password = pass()
  await signUpWithEmail(page, { name: 'Ravi Kumar', email, password, handle })
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()

  const signIn = async (id: string, pw: string) => {
    await page.getByLabel('Email or handle').fill(id)
    await page.getByLabel('Password', { exact: true }).fill(pw)
    await page.getByRole('button', { name: 'Sign in with your password' }).click()
  }
  await signIn(email, 'not the password at all')
  await expect(page.getByText('That email and password do not match.')).toBeVisible({ timeout: 20_000 })
  await signIn(`nobody-${handle}@example.in`, 'not the password at all')
  await expect(page.getByText('That email and password do not match.')).toBeVisible({ timeout: 20_000 })
  await signIn(email.toUpperCase(), password)
  await expect(page.getByText('Signed in as Ravi Kumar')).toBeVisible({ timeout: 20_000 })
  expect(await session(page)).toMatchObject({ authMethod: 'password', stepUpFresh: false, hasPasskey: false, user: { handle } })
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signIn(handle, password)
  await expect(page.getByText('Signed in as Ravi Kumar')).toBeVisible({ timeout: 20_000 })
  // nothing that needs the device is open to it: asking for a passkey confirmation is refused, there being no passkey
  const refused = await page.evaluate(async () => {
    const s = (await (await fetch('/api/session')).json()) as { csrf: string }
    const r = await fetch('/api/auth/passkey/stepup/begin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': s.csrf }, body: '{}' })
    return [r.status, ((await r.json()) as { error: { code: string } }).error.code]
  })
  expect(refused).toEqual([409, 'passkey_needed'])
})

test('a device with no fingerprint, face or PIN check of its own is told so plainly, and a security key sets it up', async ({ page }) => {
  test.setTimeout(120_000)
  // a roaming security key only (USB): the browser then answers that this device has no user-verifying check of its own
  await page.addInitScript(() => { (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable', { enableUI: false })
  await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto('/')
  expect(await page.evaluate(() => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())).toBe(false)
  await expect(page.getByText(NO_DEVICE_CHECK)).toBeVisible()
  const email = `${unique('nokey')}@example.in`
  await signUpWithEmail(page, { name: 'Asha Rao', email, password: pass() })
  const note = page.locator('.note').filter({ hasText: 'No fingerprint, face or PIN check on this device' })
  await expect(note).toBeVisible()
  await expect(note).toContainText('a phone nearby, or a security key')
  await expect(page.getByRole('button', { name: 'Set up device sign-in' })).toHaveCount(0)
  await shots(page, '5-no-device-check')
  await page.getByRole('button', { name: 'Use a phone or a security key' }).click()
  await expect(page.getByRole('heading', { name: 'Device sign-in is set up' })).toBeVisible()
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE email_key = ?', email.toLowerCase())
  expect(query<{ transports: string }>('SELECT transports FROM webauthn_credentials WHERE person_id = ?', u!.id)[0]!.transports).toContain('usb')
})

/** The link in the newest simulated message to an address with this subject, from the developer outbox. */
async function fromOutbox(back: Page, to: string, subject: string | RegExp): Promise<string> {
  const p = await back.context().newPage()
  await p.goto('/dev/outbox')
  await expect(p.getByText('Simulated delivery: no email or text message was sent.')).toBeVisible()
  await p.getByLabel('Filter by address').fill(to)
  const msg = p.getByRole('article').filter({ has: p.getByRole('heading', { name: subject }) }).first()
  await expect(msg).toBeVisible({ timeout: 20_000 })
  const href = await msg.getByRole('link').first().getAttribute('href')
  await p.close()
  await back.bringToFront()
  return href!
}

test('recovery: the address is confirmed by its link and waits, the first device brought the saved codes, and a code beside the email link starts a recovery that waits and that the device is told of', async ({ browser }) => {
  test.setTimeout(180_000)
  const owner = await (await browser.newContext()).newPage()
  const first = await addAuthenticator(owner)
  const handle = unique('rc'), email = `${handle}@example.in`
  await signUpWithEmail(owner, { name: 'Lakshmi Iyer', email, password: pass(), handle })
  await owner.getByRole('button', { name: 'Set up device sign-in' }).click()
  // F1: the first device brings the saved codes, shown once on the screen that follows
  await expect(owner.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
  const codes = await owner.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByRole('button', { name: 'Open the household' }).click()
  await expect(owner.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [u] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // the address the account was opened with, confirmed by the link kept in the simulated outbox; like any address it waits the protection delay (F4)
  const v = await owner.context().newPage()
  await v.goto(await fromOutbox(owner, email, 'Confirm your email address for QED'))
  await v.getByRole('button', { name: 'Confirm the address' }).click()
  await expect(v.getByRole('heading', { name: 'Email address confirmed' })).toBeVisible()
  await v.close()
  await owner.bringToFront()
  await owner.goto('/security')
  await expect(owner.locator('#ordinary').getByText(email)).toBeVisible()
  await expect(owner.locator('#ordinary').getByText('verified', { exact: true })).toBeVisible()
  // the five separate things, said on the page
  await expect(owner.getByRole('heading', { name: 'Five separate things' })).toBeVisible()
  for (const t of ['Signing in', 'Setting up a device', 'Approving money', 'Getting back in', 'Getting back authority over your wallet']) await expect(owner.locator('.sy-ops').getByText(t, { exact: true })).toBeVisible()
  await expect(owner.getByText(/10 of 10 unused/).first()).toBeVisible()
  await shots(owner, '6-security')

  // a second device brings no codes (F1: they came with the first). Adding it is confirmed by the first device (the session
  // was opened with the password, which confirms nothing here), so that happens before the devices swap.
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', u!.id)[0]).toEqual({ n: 10 })
  await owner.getByRole('button', { name: /account menu$/ }).click()
  await owner.getByRole('button', { name: 'Sign out' }).click()
  await owner.getByRole('button', { name: DEVICE_SIGN_IN }).click()
  await expect(owner.getByRole('heading', { level: 1, name: 'Your money' })).toBeVisible()
  await first.remove()
  await addAuthenticator(owner)
  await owner.goto('/security')
  await owner.getByRole('region', { name: 'Passkeys' }).getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect.poll(() => query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', u!.id)[0]!.n).toBe(2)
  await expect(owner.getByText('Save these recovery codes now')).toHaveCount(0)
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', u!.id)[0]).toEqual({ n: 10 })
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', u!.id)[0]).toEqual({ n: 2 })
  await shots(owner, '7-second-device')

  // the opening address is usable only after the protection delay (6 seconds on this stack)
  await expect.poll(() => query<{ usable_from: number }>(`SELECT usable_from FROM contact_points WHERE person_id = ? AND kind = 'email' AND removed_at IS NULL`, u!.id)[0]!.usable_from <= Date.now(), { timeout: 30_000 }).toBe(true)

  // every device lost: on another browser, the email link and one saved code start a recovery, which waits
  const elsewhere = await (await browser.newContext()).newPage()
  await addAuthenticator(elsewhere)
  await elsewhere.goto('/')
  await elsewhere.getByRole('button', { name: 'Recover your account' }).click()
  await elsewhere.getByLabel('Handle or email address').fill(email)
  await elsewhere.getByRole('button', { name: 'Email me a recovery link' }).click()
  await expect(elsewhere.getByText('Kept in the simulated outbox, not sent')).toBeVisible()
  await elsewhere.goto(await fromOutbox(elsewhere, email, 'Get back in to your QED account'))
  await expect(elsewhere.getByRole('heading', { name: /^Recover @/ })).toBeVisible()
  await elsewhere.getByRole('textbox', { name: 'Saved recovery code' }).fill(codes[0]!)
  await elsewhere.getByRole('button', { name: 'Start the recovery' }).click()
  await expect(elsewhere.getByRole('heading', { name: 'Your recovery is waiting' })).toBeVisible({ timeout: 20_000 })
  expect(query<{ method: string; via: string }>('SELECT method, via FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', u!.id)).toEqual([{ method: 'email+saved', via: 'email' }])
  // nothing was granted: nobody new is signed in, and the owner's device is told
  expect(query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', u!.id)[0]).toEqual({ n: 2 })
  await owner.reload()
  await expect(owner.getByText('Someone started a recovery of this account.')).toBeVisible()
})

test.describe('Google, with a local stand-in issuer', () => {
  const PORT = extraPort(52), IDP_PORT = extraPort(54)
  const CLIENT = 'qed-browser-suite.apps.example', SECRET = randomBytes(18).toString('base64url')
  // one stack and one stand-in issuer for the three tests, so one worker runs them (two workers would meet on these ports)
  test.describe.configure({ mode: 'serial' })
  let s: Awaited<ReturnType<typeof startExtraStack>>, idp: StandIn
  test.beforeAll(async () => {
    idp = await startOidcStandIn({ port: IDP_PORT, clientId: CLIENT, clientSecret: SECRET, redirectUris: [`http://localhost:${PORT}/auth/google/callback`] })
    idp.auto = false
    s = await startExtraStack(PORT, { QED_GOOGLE_CLIENT_ID: CLIENT, QED_GOOGLE_CLIENT_SECRET: SECRET, QED_GOOGLE_ISSUER: idp.issuer })
  })
  test.afterAll(async () => { await s?.stop(); await idp?.close() })

  /** Press the Google button and choose the stand-in's account; lands back in QED. */
  async function throughGoogle(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Continue with Google (test stand-in)' }).click()
    await expect(page.getByText('Stand-in issuer for tests. This is not Google.')).toBeVisible()
    await page.getByRole('link', { name: /^Continue as / }).click()
  }

  test('the round trip opens a new account that looks and prepares; the device is then set up; the same Google account signs in to the same account again', async ({ page }) => {
    test.setTimeout(120_000)
    await addAuthenticator(page)
    const sub = unique('g'), email = `${sub}@example.in`
    idp.user = { sub, email, email_verified: true, name: 'Kavya Iyer' }
    await page.goto(`${s.base}/`)
    await expect(page.getByRole('button', { name: 'Continue with Google (test stand-in)' })).toBeVisible()
    await shots(page, '8-sign-in-with-google')
    await throughGoogle(page)
    await expect(page.getByRole('heading', { name: 'Faster, more secure access' })).toBeVisible({ timeout: 20_000 })
    // the code and the state are gone from the address bar
    expect(new URL(page.url()).search).toBe('')
    expect(new URL(page.url()).pathname).toBe('/')
    const me = await session(page)
    expect(me).toMatchObject({ authenticated: true, authMethod: 'google', stepUpFresh: false, hasPasskey: false, hasPassword: false, email: { address: email, verified: true } })
    const [u] = s.query<{ id: string; pw_hash: string; handle: string }>('SELECT id, pw_hash, handle FROM users WHERE email_key = ?', email)
    expect(u).toMatchObject({ pw_hash: '!', handle: expect.stringMatching(/^kavya\.iyer/) })
    expect(s.query<{ subject: string }>('SELECT subject FROM federated_identities WHERE person_id = ?', u!.id)).toEqual([{ subject: sub }])
    // the device, set up right after the Google sign-in
    await page.getByRole('button', { name: 'Set up device sign-in' }).click()
    await expect(page.getByRole('heading', { name: 'Device sign-in is set up' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    // signed out and in again with Google: the same account, by Google's subject
    await page.getByRole('button', { name: 'Sign out' }).click()
    await throughGoogle(page)
    await expect(page.getByText('Signed in as Kavya Iyer')).toBeVisible({ timeout: 20_000 })
    expect((await session(page)).user.id).toBe(u!.id)
    expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM users WHERE email_key = ?', email)[0]).toEqual({ n: 1 })
  })

  test('a Google account whose address matches an existing account does not get into it: it opens an account of its own', async ({ page }) => {
    test.setTimeout(120_000)
    const handle = unique('own'), email = `${handle}@example.in`, password = pass()
    await signUpWithEmail(page, { name: 'Owner Person', email, password, handle }, s.base)
    await page.getByRole('button', { name: 'Not now' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    const [owner] = s.query<{ id: string; pw_hash: string }>('SELECT id, pw_hash FROM users WHERE handle = ?', handle)
    // someone else's Google account, saying the same address
    idp.user = { sub: unique('g-other'), email, email_verified: true, name: 'Owner Person' }
    await throughGoogle(page)
    await expect(page.getByRole('heading', { name: 'Faster, more secure access' })).toBeVisible({ timeout: 20_000 })
    const me = await session(page)
    expect(me.user.id).not.toBe(owner!.id)
    expect(me.user.handle).not.toBe(handle)
    expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM users WHERE email_key = ?', email)[0]).toEqual({ n: 2 })
    expect(s.query('SELECT 1 FROM federated_identities WHERE person_id = ?', owner!.id)).toHaveLength(0)
    expect(s.query<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', owner!.id)[0]!.pw_hash).toBe(owner!.pw_hash)
    expect(s.query('SELECT 1 FROM sessions WHERE user_id = ? AND auth_method = ? AND revoked_at IS NULL', owner!.id, 'google')).toHaveLength(0)
  })

  test('a Google account whose address Google has not confirmed is refused in plain words, and nothing is opened', async ({ page }) => {
    const sub = unique('g-unv')
    idp.user = { sub, email: `${sub}@example.in`, email_verified: false, name: 'Unverified' }
    await page.goto(`${s.base}/`)
    await throughGoogle(page)
    await expect(page.getByRole('heading', { name: 'That sign-in did not finish' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Google has not confirmed the email address/)).toBeVisible()
    expect(s.query('SELECT 1 FROM users WHERE email_key = ?', `${sub}@example.in`)).toHaveLength(0)
    expect((await session(page)).authenticated).toBe(false)
  })
})

test.describe('an installation that cannot send email (production today)', () => {
  const PORT = extraPort(56)
  let s: Awaited<ReturnType<typeof startExtraStack>>
  test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_DELIVERY: 'none' }) })
  test.afterAll(async () => { await s?.stop() })

  test('the account opens and works; its address is plainly not verified, verifying is said to be unavailable, and nothing is said to be sent', async ({ page }) => {
    test.setTimeout(120_000)
    await addAuthenticator(page)
    const handle = unique('nd'), email = `${handle}@example.in`
    await signUpWithEmail(page, { name: 'Nisha Rao', email, password: pass(), handle }, s.base)
    const note = page.locator('.note').filter({ hasText: `${email} is not verified` })
    await expect(note).toBeVisible()
    await expect(note).toContainText('cannot send email')
    await expect(note).toContainText('Nothing was sent to it')
    await expect(page.getByText(/Check your email|is on its way|Confirmation sent|simulated outbox/)).toHaveCount(0)
    await shots(page, '9-no-email-device-step')
    const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
    expect(s.query('SELECT 1 FROM outbound_messages')).toHaveLength(0)
    expect(s.query('SELECT 1 FROM contact_points WHERE person_id = ?', u!.id)).toHaveLength(0)
    expect(s.query('SELECT 1 FROM recovery_codes WHERE person_id = ?', u!.id)).toHaveLength(0) // no device yet, so none yet
    // the device, then the way back in: here the saved codes are the way back, and the page says why
    await page.getByRole('button', { name: 'Set up device sign-in' }).click()
    await expect(page.getByRole('heading', { name: 'Device sign-in is set up' })).toBeVisible()
    await expect(page.getByText(/This installation cannot send email, so the codes are the way back/)).toBeVisible()
    await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10)
    await shots(page, '10-no-email-codes')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Open the household' }).click()
    await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
    await page.goto(`${s.base}/security`)
    const row = page.locator('#ordinary')
    await expect(row.getByText('not verified', { exact: true })).toBeVisible()
    await expect(row.getByText(/cannot send email, so verifying is unavailable here; nothing was sent/)).toBeVisible()
    await expect(row.getByRole('button', { name: /Send/ })).toHaveCount(0)
    await shots(page, '11-no-email-security')
    // the developer outbox does not exist here
    expect((await page.request.get(`${s.base}/api/dev/outbox`)).status()).toBe(404)
  })
})
