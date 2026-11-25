/**
 * Email through Postmark, end to end on a stack of its own (R14, Priority 1): QED_DELIVERY=postmark, pointed at a local
 * stand-in for Postmark's API (server/postmark-standin.ts), which records each message so this test can read the link in it.
 * Nothing leaves this computer, and the stand-in is not presented as Postmark anywhere in the interface.
 *
 *   1. Sign-up with an email address: the verification message arrives at the stand-in (sent by the engine's mail loop, not
 *      by the request), the page does not call it simulated, the database keeps the provider's MessageID and no text; its
 *      link verifies the address. The address is usable for recovery only after the protection delay (F4): a reset asked for
 *      before sends nothing, and the same request after it sends the reset message.
 *   2. The reset link sets a new password, ends the sessions, the notice of it arrives, and the new password signs in. The
 *      first device added after a reset signs in only: no approval authority and no saved codes (RISK-123 is open).
 *   3. A failure that may pass (Postmark answering 503) is tried again and the message arrives; an address Postmark refuses
 *      (406) is marked failed with its reason, and nothing breaks.
 *   4. No developer outbox, no phone-number form.
 *
 * Passwords are made here and never leave the test.
 */
import { randomBytes } from 'node:crypto'
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { type PostmarkStandIn, startPostmarkStandIn } from '../../server/postmark-standin.ts'
import { RETRY_EVERY_MS } from '../../server/delivery.ts'

const PORT = extraPort(62), PM_PORT = extraPort(68)
const TOKEN = `qed-test-${randomBytes(12).toString('hex')}`
const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const pass = (): string => `${randomBytes(9).toString('base64url')} phrase`

test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>, pm: PostmarkStandIn

test.beforeAll(async () => {
  pm = await startPostmarkStandIn({ port: PM_PORT, token: TOKEN })
  s = await startExtraStack(PORT, { QED_DELIVERY: 'postmark', QED_POSTMARK_TOKEN: TOKEN, QED_MAIL_FROM: 'QED <no-reply@mail.example.com>', QED_POSTMARK_URL: pm.url })
})
test.afterAll(async () => { await s?.stop(); await pm?.close() })

async function signUp(page: import('@playwright/test').Page, o: { name: string; email: string; password: string; handle: string }): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Name to sign with').fill(o.name)
  await page.getByLabel('Email', { exact: true }).fill(o.email)
  await page.getByLabel('Password', { exact: true }).fill(o.password)
  await page.getByText('Choose your handle (optional)').click()
  await page.getByLabel('Handle').fill(o.handle)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Faster, more secure access' })).toBeVisible({ timeout: 30_000 })
}
const arrived = (to: string, subject: string | RegExp, timeout = 20_000) => expect.poll(() => pm.last(to, subject)?.messageId, { timeout }).toBeTruthy()

test('sign-up sends a verification message through the provider; its link verifies the address, which waits the protection delay; the reset message arrives only after it', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const handle = unique('pm'), email = `${handle}@example.in`, password = pass(), next = pass()
  await signUp(page, { name: 'Priya Menon', email, password, handle })
  // the page does not call a real message simulated, nor claim it was delivered
  await expect(page.getByText(`Confirm ${email}`)).toBeVisible()
  await expect(page.getByText(/simulated|Kept in the/i)).toHaveCount(0)
  // it arrives at the provider, from the configured sender and stream, with the link as written
  await arrived(email, 'Confirm your email address for QED')
  const m = pm.last(email, 'Confirm your email address for QED')!
  expect(m).toMatchObject({ from: 'QED <no-reply@mail.example.com>', stream: 'outbound', trackLinks: 'None', trackOpens: false })
  const verifyLink = pm.linkIn(m)
  expect(verifyLink).toMatch(new RegExp(`^http://localhost:${PORT}/verify-email#token=[A-Za-z0-9_-]{43}`))
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // sent by the mail loop: the provider's MessageID is kept and the text is not
  await expect.poll(() => s.query<{ status: string }>(`SELECT status FROM outbound_messages WHERE person_id = ? AND purpose = 'verify-email'`, u!.id)[0]?.status).toBe('sent')
  expect(s.query(`SELECT adapter, provider_ref, body FROM outbound_messages WHERE person_id = ? AND purpose = 'verify-email'`, u!.id)).toEqual([{ adapter: 'postmark', provider_ref: m.messageId, body: '(sent; the text is not kept)' }])
  expect(pm.requests.every((r) => r.headers.token === TOKEN)).toBe(true)

  // the link verifies the address
  const v = await page.context().newPage()
  await v.goto(verifyLink)
  await v.getByRole('button', { name: 'Confirm the address' }).click()
  await expect(v.getByRole('heading', { name: 'Email address confirmed' })).toBeVisible()
  await v.close()
  await page.bringToFront()
  await page.getByRole('button', { name: 'Not now' }).click()
  const [cp] = s.query<{ verified_at: number; usable_from: number }>(`SELECT verified_at, usable_from FROM contact_points WHERE person_id = ? AND kind = 'email' AND removed_at IS NULL`, u!.id)
  expect(cp!.verified_at).toBeGreaterThan(0)
  // F4: usable for recovery only after the protection delay (6 seconds on this stack)
  expect(cp!.usable_from - cp!.verified_at).toBeGreaterThanOrEqual(6000)

  // a reset asked for inside the delay is answered alike and sends nothing
  const ask = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('button', { name: 'Reset your password' }).click()
    await page.getByLabel('Handle or email address').fill(email)
    await page.getByRole('button', { name: 'Email me a reset link' }).click()
    await expect(page.getByText('Check your email')).toBeVisible()
    await expect(page.getByText(/simulated outbox|Simulated delivery/)).toHaveCount(0)
  }
  const inside = Date.now() < cp!.usable_from - 1500
  test.info().annotations.push({ type: 'reset asked inside the protection delay', description: String(inside) })
  if (inside) {
    await ask()
    expect(s.query(`SELECT 1 FROM outbound_messages WHERE person_id = ? AND purpose = 'password-reset'`, u!.id)).toHaveLength(0)
    await page.goto(`${s.base}/`)
    await page.getByLabel('Handle').fill(handle)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in with your password' }).click()
    await expect(page.getByText('Signed in as Priya Menon')).toBeVisible()
  }
  await expect.poll(() => cp!.usable_from <= Date.now(), { timeout: 30_000 }).toBe(true)
  await ask()
  await arrived(email, 'Reset your QED password')
  const resetLink = pm.linkIn(pm.last(email, 'Reset your QED password')!)
  expect(resetLink).toMatch(new RegExp(`^http://localhost:${PORT}/reset-password#token=[A-Za-z0-9_-]{43}`))

  // the link sets a new password; every session ends; the notice of it arrives; the new password signs in
  await page.goto(resetLink)
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
  await page.getByLabel('New password', { exact: true }).fill(next)
  await page.getByLabel('Type it again', { exact: true }).fill(next)
  await page.getByRole('button', { name: 'Set the new password' }).click()
  await expect(page.getByRole('heading', { name: 'Your password was changed' })).toBeVisible()
  await arrived(email, 'QED: Your password was reset')
  expect(s.query('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', u!.id)).toEqual([{ n: 0 }])
  const again = await page.context().newPage()
  await again.goto(resetLink)
  await expect(again.getByRole('heading', { name: 'This link was already used' })).toBeVisible()
  await again.close()
  await page.getByRole('button', { name: 'Go to sign in' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in with your password' }).click()
  await expect(page.getByText('That handle and password do not match.')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(next)
  await page.getByRole('button', { name: 'Sign in with your password' }).click()
  await expect(page.getByText('Signed in as Priya Menon')).toBeVisible()

  // a first device added after the reset signs in only, and makes no saved codes
  await page.goto(`${s.base}/security`)
  const note = page.locator('.note').filter({ hasText: 'This account has no passkey' })
  await note.getByLabel('Password').fill(next)
  await note.getByRole('button', { name: 'Create a passkey' }).click()
  await expect.poll(() => s.query<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', u!.id)[0]!.n).toBe(1)
  expect(s.query('SELECT authority, authority_reason FROM webauthn_credentials WHERE person_id = ?', u!.id)).toEqual([{ authority: 'signin', authority_reason: 'after-password-reset' }])
  expect(s.query('SELECT 1 FROM recovery_codes WHERE person_id = ?', u!.id)).toHaveLength(0)
  // the whole of it left the stack as messages to one address and no other
  expect(new Set(pm.messages.map((x) => x.to))).toEqual(new Set([email]))
})

test('a failure that may pass is tried again and the message arrives; an address the provider refuses is marked failed, and the account still works', async ({ page }) => {
  test.setTimeout(120_000)
  await addAuthenticator(page)
  const handle = unique('rt'), email = `${handle}@example.in`
  // the earlier journey's last notices have gone out: the 503 below is for this message and no other
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM outbound_messages WHERE status IN ('queued', 'sending')`)[0]!.n, { timeout: 30_000 }).toBe(0)
  pm.failNext.push({ status: 503, errorCode: 100 })
  const before = pm.requests.length
  await signUp(page, { name: 'Ravi Shah', email, password: pass(), handle })
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  // the first try met a 503: the message is back in the queue with the reason, and nothing is sent yet
  await expect.poll(() => s.query<{ status: string; error: string | null }>(`SELECT status, error FROM outbound_messages WHERE person_id = ? AND purpose = 'verify-email'`, u!.id)[0], { timeout: 10_000 })
    .toMatchObject({ status: 'queued', error: expect.stringMatching(/^Trying again: Postmark could not take it now \(HTTP 503, error 100\)/) })
  expect(pm.messages.some((x) => x.to === email)).toBe(false)
  await arrived(email, 'Confirm your email address for QED', RETRY_EVERY_MS + 15_000)
  expect(pm.requests.length - before).toBe(2)
  await expect.poll(() => s.query<{ status: string }>(`SELECT status FROM outbound_messages WHERE person_id = ?`, u!.id)[0]?.status).toBe('sent')

  // an address the provider calls inactive: failed, with its reason, no retry, no text of it kept in the reason
  const bad = `${unique('bn')}@example.in`
  pm.inactive.add(bad)
  const page2 = await (await page.context().browser()!.newContext()).newPage()
  await signUp(page2, { name: 'Bina Nair', email: bad, password: pass(), handle: unique('bn') })
  await expect.poll(() => s.query<{ status: string }>(`SELECT status FROM outbound_messages WHERE to_address = ?`, bad)[0]?.status, { timeout: 15_000 }).toBe('failed')
  const [f] = s.query<{ error: string; provider_ref: string | null }>(`SELECT error, provider_ref FROM outbound_messages WHERE to_address = ?`, bad)
  expect(f!.error).toMatch(/error 406/)
  expect(f!.error).not.toContain(bad)
  expect(f!.provider_ref).toBeNull()
  await page2.context().close()
})

test('there is no developer outbox and no phone-number form where email goes through a provider', async ({ page }) => {
  test.setTimeout(90_000)
  await addAuthenticator(page)
  const handle = unique('np'), email = `${handle}@example.in`
  await signUp(page, { name: 'Nina Paul', email, password: pass(), handle })
  expect((await page.request.get(`${s.base}/api/dev/outbox`)).status()).toBe(404)
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.goto(`${s.base}/security`)
  await expect(page.getByRole('heading', { name: /Security/ }).first()).toBeVisible()
  await expect(page.getByLabel('Add an email address')).toBeVisible()
  await expect(page.getByText('Add a phone number for security notices')).toHaveCount(0)
  await expect(page.getByText(/simulated outbox/i)).toHaveCount(0)
})
