/**
 * R12 section 4: password reset, account recovery by email, and the approval authority a recovered passkey must ask
 * for, kept apart. Every control the mandate names is checked here against the functions the routes call: expiry, single
 * use, hashing, rate limits, enumeration resistance, notices on every channel, delays, cancellation (by a signed-in
 * device and by a recovery contact), no authority after a recovery until the separate restoration completes, duplicate
 * and replayed requests, and one person's links, codes and addresses never reaching another's account.
 */
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
// These journeys run for days of the test clock with the same sessions: they keep the earlier session lifetimes (12 hours
// idle, 7 days in all), set before server/auth.ts reads them and unset after this file, so no other file in the same
// worker inherits them; the product's are NIST's AAL2 values (1 hour, 24 hours).
vi.hoisted(() => { process.env.QED_SESSION_IDLE_MINUTES = '720'; process.env.QED_SESSION_MAX_MINUTES = '10080' })
afterAll(() => { delete process.env.QED_SESSION_IDLE_MINUTES; delete process.env.QED_SESSION_MAX_MINUTES })
import { login, sessionFor, stepUp } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { configureDelivery, dispatchQueued, maskAddress, outboxView, providerAdapter, PROVIDER_DEPENDENCY } from './delivery.ts'
import {
  acceptContact, applyDueChanges, approvingCredentials, beginAddPasskey, beginLogin, beginReauth, beginSignup, cancelRecovery, finishAddPasskey, finishLogin, finishReauth,
  finishSignup, issueContactCode, nominateContact, PROTECTION_DELAY_MS, RECOVERY_DELAY_MS, type RelyingParty, signUpWithPassword as openWithPassword, suspendPasskey,
  makeRecoveryCodes,
} from './passkeys.ts'
import {
  addAddress, beginAuthorityRequest, beginRecoveryFromLink, cancelAuthorityRequest, confirmAddressByCode, confirmAddressByLink, contactCancel, contactCancelLoosening, contactPause, finishAuthorityRequest,
  finishRecoveryFromLink, grantAuthorityNow, linkToken, normaliseEmail, normalisePhone, recoveryLinkState, recoveryTick, removeAddress, requestPasswordReset, requestRecoveryLink,
  RESET_TTL_MS, resetPassword, startRecoveryFromLink,
} from './recovery.ts'
import { SoftAuthenticator } from './softauthn.ts'

// R14: sign-up makes no saved recovery codes any more. These tests are about what the codes do, so each account makes its set right after it opens.
const signUpWithPassword = async (db: Db, input: Parameters<typeof openWithPassword>[1], meta: Parameters<typeof openWithPassword>[2], now: number) => { const r = await openWithPassword(db, input, meta, now); return { ...r, recoveryCodes: makeRecoveryCodes(db, r.personId, now) } }

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 24, 6, 0)
const H = 3600_000
configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' })

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
/** The newest simulated message to an address, and the token of the link it carries for a page, if any. */
function lastTo(db: Db, to: string): { subject: string; body: string; purpose: string } | undefined {
  return db.get('SELECT subject, body, purpose FROM outbound_messages WHERE to_address = ? ORDER BY rowid DESC LIMIT 1', to)
}
function linkIn(db: Db, to: string, page: string): string {
  const m = new RegExp(`${page.replace('/', '\\/')}#token=([A-Za-z0-9_-]+)`).exec(lastTo(db, to)?.body ?? '')
  if (!m) throw new Error(`no ${page} link to ${to}`)
  return m[1]!
}
const count = (db: Db, sql: string, ...p: (string | number)[]) => db.get<{ n: number }>(sql, ...p)!.n

async function passkeyAccount(db: Db, handle: string, now = T0) {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, `10.0.0.${handle.length}`, now)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META, now)
  return { auth, ...r, recoveryCodes: makeRecoveryCodes(db, r.personId, now), s: () => sessionFor(db, r.session.token, now + 1000)! }
}
/** An email address confirmed by its link, and made usable for a reset or a recovery (its delay written past). */
function confirmedEmail(db: Db, s: ReturnType<typeof sessionFor>, address: string, now: number, usable = true) {
  addAddress(db, s!, 'email', address, now)
  const r = confirmAddressByLink(db, linkIn(db, address, '/verify-email'), META.ip, now + 1)
  if (usable) db.run(`UPDATE contact_points SET usable_from = ? WHERE address_key = ?`, now, address.toLowerCase())
  return r
}
/** Sign in again with a passkey: sessions end after twelve idle hours, and these tests cross a 72-hour wait. */
async function signinAt(db: Db, auth: SoftAuthenticator, now: number): Promise<string> {
  const b = await beginLogin(db, RP, now)
  return (await finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never) }, META, now)).token
}
async function fresh(db: Db, auth: SoftAuthenticator, token: string, now: number) {
  const s = sessionFor(db, token, now)!
  const b = await beginReauth(db, RP, s.userId, 'stepup', null, {}, now)
  await finishReauth(db, RP, s, 'stepup', { challengeId: b.challengeId, response: auth.get(b.options as never) }, now)
  return sessionFor(db, token, now)!
}

describe('addresses: email confirmed by a link or a code; a phone for notices only', () => {
  it('needs the account\'s strongest confirmation, sends a link and a code, keeps only hashes, and waits the protection delay before it can start anything', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'asha')
    // a session whose confirmation has lapsed cannot add one
    expect(() => addAddress(db, sessionFor(db, a.session.token, T0 + 10 * 60_000)!, 'email', 'asha@gmail.com', T0 + 10 * 60_000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    const { id } = addAddress(db, a.s(), 'email', ' Asha.Rao@Gmail.COM ', T0 + 1000)
    const msg = lastTo(db, 'Asha.Rao@gmail.com')!
    expect(msg.purpose).toBe('verify-email')
    // kept in the simulated outbox, and the person's history says so rather than that it was sent (R13)
    expect(db.get<{ status: string }>(`SELECT status FROM outbound_messages WHERE to_address = ? AND purpose = 'verify-email'`, 'Asha.Rao@gmail.com')!.status).toBe('simulated')
    expect(JSON.parse(db.get<{ d: string }>(`SELECT detail_json d FROM security_events WHERE person_id = ? AND kind = 'email-confirmation-sent'`, a.personId)!.d)).toMatchObject({ simulated: true })
    const token = linkIn(db, 'Asha.Rao@gmail.com', '/verify-email'), code = /code on the Security and recovery page: (\d{6})/.exec(msg.body)![1]!
    const t = db.get<{ token_hash: string; code_hash: string; expires_at: number }>('SELECT token_hash, code_hash, expires_at FROM one_time_tokens WHERE subject = ?', id)!
    expect(t.token_hash).toBe(sha(token))
    expect(t.code_hash).not.toContain(code)
    expect(JSON.stringify(db.all('SELECT * FROM one_time_tokens'))).not.toContain(token)
    expect(t.expires_at).toBe(T0 + 1000 + 30 * 60_000)
    // not used until confirmed: a reset request now sends nothing to it
    requestPasswordReset(db, 'asha.rao@gmail.com', '198.51.100.1', T0 + 2000)
    expect(lastTo(db, 'Asha.Rao@gmail.com')!.purpose).toBe('verify-email')
    const r = confirmAddressByLink(db, token, META.ip, T0 + 3000)
    expect(r).toEqual({ kind: 'email', address: 'Asha.Rao@gmail.com', usableFrom: T0 + 3000 + PROTECTION_DELAY_MS })
    expect(() => confirmAddressByLink(db, token, META.ip, T0 + 4000)).toThrow(expect.objectContaining({ code: 'link_used' }))
    // the person is told inside QED and at the address itself
    expect(db.get<{ title: string }>(`SELECT title FROM notices WHERE user_id = ? AND subject = 'email-added'`, a.personId)!.title).toBe('An email address was confirmed for your account')
    expect(lastTo(db, 'Asha.Rao@gmail.com')!.subject).toBe('QED: An email address was confirmed for your account')
    // inside its delay it tells, and starts nothing
    requestRecoveryLink(db, 'asha', '198.51.100.2', T0 + 5000)
    expect(lastTo(db, 'Asha.Rao@gmail.com')!.purpose).toBe('recovery-not-yet')
    expect(count(db, `SELECT COUNT(*) n FROM one_time_tokens WHERE purpose = 'recovery-email'`)).toBe(0)
  })

  it('a typed code: five wrong ones end it, wrong codes are counted across new codes, and it expires', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'ravi')
    const { id } = addAddress(db, a.s(), 'phone', '+91 98765 43210', T0 + 1000)
    expect(lastTo(db, '+919876543210')!.body).toMatch(/your code to confirm this number for security notices is \d{6}\. It works for 10 minutes/)
    const right = /is (\d{6})\./.exec(lastTo(db, '+919876543210')!.body)![1]!
    const s = sessionFor(db, a.session.token, T0 + 2000)!
    for (let i = 1; i <= 4; i++) expect(() => confirmAddressByCode(db, s, id, '000000', T0 + 2000 + i)).toThrow(expect.objectContaining({ fields: { code: expect.stringContaining(`${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left`) } }))
    expect(() => confirmAddressByCode(db, s, id, '000000', T0 + 2010)).toThrow(expect.objectContaining({ fields: { code: expect.stringContaining('no longer valid') } }))
    // the code that ended stays out of the kept message (review L1), and the right one no longer works
    expect(lastTo(db, '+919876543210')!.body).not.toContain(right)
    expect(() => confirmAddressByCode(db, s, id, right, T0 + 2020)).toThrow(expect.objectContaining({ code: 'link_replaced' }))
    // a new code: the earlier wrong ones still count towards the hour's limit of ten
    const again = addAddress(db, sessionFor(db, a.session.token, T0 + 3000)!, 'phone', '+919876543210', T0 + 3000)
    const code2 = /is (\d{6})\./.exec(lastTo(db, '+919876543210')!.body)![1]!
    for (let i = 0; i < 5; i++) expect(() => confirmAddressByCode(db, s, again.id, code2 === '111111' ? '222222' : '111111', T0 + 3001 + i)).toThrow(expect.objectContaining({ code: 'invalid' }))
    const third = addAddress(db, sessionFor(db, a.session.token, T0 + 3100)!, 'phone', '+919876543210', T0 + 3100)
    expect(() => confirmAddressByCode(db, s, third.id, '333333', T0 + 3101)).toThrow(expect.objectContaining({ code: 'too_many' }))
    // and a code past its ten minutes is refused whatever it is
    const later = addAddress(db, await fresh(db, a.auth, a.session.token, T0 + 2 * H), 'phone', '+919876543210', T0 + 2 * H)
    const code3 = /is (\d{6})\./.exec(lastTo(db, '+919876543210')!.body)![1]!
    expect(() => confirmAddressByCode(db, sessionFor(db, a.session.token, T0 + 2 * H + 11 * 60_000)!, later.id, code3, T0 + 2 * H + 11 * 60_000)).toThrow(expect.objectContaining({ code: 'link_expired' }))
  })

  it('a change keeps the old address until the new one is confirmed and then for the protection delay, telling it at once and again when it goes; a removal waits too, and tells the removed one', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'mira')
    confirmedEmail(db, a.s(), 'mira@example.in', T0 + 1000)
    const old = db.get<{ id: string }>(`SELECT id FROM contact_points WHERE address = 'mira@example.in'`)!.id
    addAddress(db, sessionFor(db, a.session.token, T0 + 2000)!, 'email', 'mira.new@gmail.com', T0 + 2000, old)
    expect(db.get(`SELECT removed_at FROM contact_points WHERE id = ?`, old)).toEqual({ removed_at: null })
    confirmAddressByLink(db, linkIn(db, 'mira.new@gmail.com', '/verify-email'), META.ip, T0 + 3000)
    // R14 (SECURITY.md 8j (c)): a confirmed address is a way back in, so the old one goes only after the protection delay;
    // it is told now that it is to go, and again, with what the address is now, when it does
    expect(db.get(`SELECT removed_at FROM contact_points WHERE id = ?`, old)).toEqual({ removed_at: null })
    expect(lastTo(db, 'mira@example.in')).toMatchObject({ purpose: 'notice:email-removal-scheduled' })
    applyDueChanges(db, T0 + 3000 + PROTECTION_DELAY_MS)
    expect(db.get<{ removed_reason: string }>(`SELECT removed_reason FROM contact_points WHERE id = ?`, old)!.removed_reason).toBe('replaced')
    expect(lastTo(db, 'mira@example.in')).toMatchObject({ purpose: 'notice:email-changed', subject: 'QED: The email address of your QED account was changed' })
    expect(lastTo(db, 'mira@example.in')!.body).toContain('m•••@gmail.com')
    const nw = db.get<{ id: string }>(`SELECT id FROM contact_points WHERE address = 'mira.new@gmail.com'`)!.id
    const at = T0 + 3000 + PROTECTION_DELAY_MS + 60_000, tok = await signinAt(db, a.auth, at)
    expect(() => removeAddress(db, sessionFor(db, tok, at + 6 * 60_000)!, nw, at + 6 * 60_000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(removeAddress(db, await fresh(db, a.auth, tok, at + 7 * 60_000), nw, at + 7 * 60_000)).toMatchObject({ scheduled: true })
    expect(lastTo(db, 'mira.new@gmail.com')).toMatchObject({ purpose: 'notice:email-removal-scheduled' })
    applyDueChanges(db, at + 7 * 60_000 + PROTECTION_DELAY_MS)
    expect(lastTo(db, 'mira.new@gmail.com')).toMatchObject({ purpose: 'notice:email-removed' })
  })

  it('accepts ordinary addresses (Gmail included) and international numbers, and refuses what is not one', () => {
    expect(normaliseEmail('First.Last+qed@GMAIL.com')).toEqual({ address: 'First.Last+qed@gmail.com', key: 'first.last+qed@gmail.com' })
    for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.in', 'a@@b.in', 'a..b@c.in', 'x'.repeat(250) + '@g.in']) expect(() => normaliseEmail(bad), bad).toThrow()
    expect(normalisePhone('+91 98765-43210')).toEqual({ address: '+919876543210', key: '+919876543210' })
    for (const bad of ['9876543210', '+0123456789', '+91', 'call me']) expect(() => normalisePhone(bad), bad).toThrow()
  })

  it('one person\'s pending address cannot be confirmed or removed from another\'s session, and at most three emails', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'owner1'), b = await passkeyAccount(db, 'other1')
    const { id } = addAddress(db, a.s(), 'email', 'owner1@gmail.com', T0 + 1000)
    const code = /code on the Security and recovery page: (\d{6})/.exec(lastTo(db, 'owner1@gmail.com')!.body)![1]!
    expect(() => confirmAddressByCode(db, b.s(), id, code, T0 + 2000)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => removeAddress(db, b.s(), id, T0 + 2000)).toThrow(expect.objectContaining({ status: 404 }))
    for (const x of ['a1@gmail.com', 'a2@gmail.com', 'a3@gmail.com']) confirmedEmail(db, sessionFor(db, a.session.token, T0 + 3000)!, x, T0 + 3000)
    expect(() => addAddress(db, sessionFor(db, a.session.token, T0 + 4000)!, 'email', 'a4@gmail.com', T0 + 4000)).toThrow(expect.objectContaining({ code: 'too_many_addresses' }))
  })
})

// Passwords are hashed with scrypt at N = 2^17 (auth.ts): on a busy machine a test that hashes a dozen takes a while.
describe('password reset: for an account whose way in is a password', { timeout: 90_000 }, () => {
  async function passwordAccount(db: Db, handle: string, email: string) {
    const r = await signUpWithPassword(db, { handle, password: 'a long enough phrase here', displayName: handle }, META, T0)
    confirmedEmail(db, sessionFor(db, r.session.token, T0 + 1000), email, T0 + 1000)
    return r
  }

  it('answers every identifier the same way; only the account with a password and no passkey gets a link, and only by email', async () => {
    const db = openDb(':memory:')
    const pw = await passwordAccount(db, 'pwuser', 'pw@gmail.com')
    const pk = await passkeyAccount(db, 'pkuser')
    confirmedEmail(db, pk.s(), 'pk@gmail.com', T0 + 1000)
    const answers = ['pwuser', 'pw@gmail.com', 'pkuser', 'pk@gmail.com', 'nobody', 'nobody@gmail.com', '', 42].map((id, i) => requestPasswordReset(db, id, `203.0.113.${i}`, T0 + 10_000))
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify({ ok: true })]))
    // the password account: one link, sent to its address; asked twice (by handle and by address), the second replaces the first
    expect(count(db, `SELECT COUNT(*) n FROM one_time_tokens WHERE person_id = ? AND purpose = 'password-reset'`, pw.personId)).toBe(2)
    expect(count(db, `SELECT COUNT(*) n FROM one_time_tokens WHERE person_id = ? AND purpose = 'password-reset' AND replaced_at IS NULL`, pw.personId)).toBe(1)
    expect(lastTo(db, 'pw@gmail.com')!.purpose).toBe('password-reset')
    // the passkey account: told to sign in with its passkey; no token exists for it
    expect(lastTo(db, 'pk@gmail.com')).toMatchObject({ purpose: 'reset-has-passkey', subject: 'QED: sign in with your passkey' })
    expect(count(db, `SELECT COUNT(*) n FROM one_time_tokens WHERE person_id = ? AND purpose = 'password-reset'`, pk.personId)).toBe(0)
    // nothing names an unknown identifier anywhere
    expect(count(db, `SELECT COUNT(*) n FROM outbound_messages WHERE to_address LIKE 'nobody%'`)).toBe(0)
  })

  it('the link is stored as a hash, works once, expires after 30 minutes, and a newer one replaces it', async () => {
    const db = openDb(':memory:')
    const pw = await passwordAccount(db, 'pwonce', 'once@gmail.com')
    requestPasswordReset(db, 'pwonce', '203.0.113.9', T0 + 10_000)
    const first = linkIn(db, 'once@gmail.com', '/reset-password')
    expect(db.get<{ token_hash: string }>(`SELECT token_hash FROM one_time_tokens WHERE purpose = 'password-reset'`)!.token_hash).toBe(sha(first))
    expect(JSON.stringify(db.all('SELECT * FROM one_time_tokens'))).not.toContain(first)
    requestPasswordReset(db, 'pwonce', '203.0.113.9', T0 + 20_000)
    const second = linkIn(db, 'once@gmail.com', '/reset-password')
    await expect(resetPassword(db, { token: first, password: 'another long phrase ok', confirm: 'another long phrase ok' }, META.ip, T0 + 30_000)).rejects.toMatchObject({ code: 'link_replaced' })
    await expect(resetPassword(db, { token: second, password: 'another long phrase ok', confirm: 'another long phrase ok' }, META.ip, T0 + 20_000 + RESET_TTL_MS + 1)).rejects.toMatchObject({ code: 'link_expired' })
    requestPasswordReset(db, 'pwonce', '203.0.113.9', T0 + 40_000)
    const third = linkIn(db, 'once@gmail.com', '/reset-password')
    await expect(resetPassword(db, { token: third, password: 'another long phrase ok', confirm: 'not the same' }, META.ip, T0 + 41_000)).rejects.toMatchObject({ fields: { confirm: expect.any(String) } })
    await expect(resetPassword(db, { token: third, password: 'password1234', confirm: 'password1234' }, META.ip, T0 + 41_000)).rejects.toMatchObject({ fields: { password: expect.any(String) } })
    await resetPassword(db, { token: third, password: 'another long phrase ok', confirm: 'another long phrase ok' }, META.ip, T0 + 42_000)
    await expect(resetPassword(db, { token: third, password: 'yet another long phrase', confirm: 'yet another long phrase' }, META.ip, T0 + 43_000)).rejects.toMatchObject({ code: 'link_used' })
    await expect(resetPassword(db, { token: 'x'.repeat(43), password: 'yet another long phrase', confirm: 'yet another long phrase' }, META.ip, T0 + 43_000)).rejects.toMatchObject({ code: 'link_invalid' })
    // the new password signs in; the old one does not
    await expect(login(db, { handle: 'pwonce', password: 'a long enough phrase here' }, META, T0 + 50_000)).rejects.toMatchObject({ code: 'bad_credentials' })
    expect((await login(db, { handle: 'pwonce', password: 'another long phrase ok' }, META, T0 + 50_000)).userId).toBe(pw.personId)
  })

  it('ends every session, clears a sign-in lock, tells every address and the account, signs nobody in, and leaves a hold', async () => {
    const db = openDb(':memory:')
    const pw = await passwordAccount(db, 'pwends', 'ends@gmail.com')
    const other = await login(db, { handle: 'pwends', password: 'a long enough phrase here' }, META, T0 + 2000)
    for (let i = 0; i < 5; i++) await login(db, { handle: 'pwends', password: 'wrong password!!' }, META, T0 + 3000 + i).catch(() => {})
    expect(db.get<{ locked_until: number | null }>('SELECT locked_until FROM users WHERE id = ?', pw.personId)!.locked_until).not.toBeNull()
    requestPasswordReset(db, 'ends@gmail.com', '203.0.113.10', T0 + 10_000)
    const r = await resetPassword(db, { token: linkIn(db, 'ends@gmail.com', '/reset-password'), password: 'the brand new phrase', confirm: 'the brand new phrase' }, META.ip, T0 + 11_000)
    expect(r).toEqual({ ok: true, ended: 2 })
    expect(sessionFor(db, other.token, T0 + 11_001)).toBeNull()
    expect(sessionFor(db, pw.session.token, T0 + 11_001)).toBeNull()
    expect(db.get('SELECT failed_logins, locked_until, authority_hold_at FROM users WHERE id = ?', pw.personId)).toEqual({ failed_logins: 0, locked_until: null, authority_hold_at: T0 + 11_000 })
    expect(lastTo(db, 'ends@gmail.com')).toMatchObject({ purpose: 'notice:password-reset', subject: 'QED: Your password was reset' })
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND subject = 'password-reset'`, pw.personId)!.n).toBe(1)
  })

  it('after a reset, a passkey added with the password signs in only: it cannot confirm or approve until a restoration completes', async () => {
    const db = openDb(':memory:')
    const pw = await passwordAccount(db, 'pwhold', 'hold@gmail.com')
    requestPasswordReset(db, 'pwhold', '203.0.113.11', T0 + 10_000)
    await resetPassword(db, { token: linkIn(db, 'hold@gmail.com', '/reset-password'), password: 'the reset phrase here', confirm: 'the reset phrase here' }, META.ip, T0 + 11_000)
    const s0 = await login(db, { handle: 'pwhold', password: 'the reset phrase here' }, META, T0 + 12_000)
    await stepUp(db, sessionFor(db, s0.token, T0 + 12_000)!, 'the reset phrase here', META.ip, T0 + 12_000)
    const key = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginAddPasskey(db, RP, sessionFor(db, s0.token, T0 + 13_000)!, T0 + 13_000)
    const cred = await finishAddPasskey(db, RP, sessionFor(db, s0.token, T0 + 13_000)!, { challengeId: b.challengeId, response: key.create(b.options as never) }, META.ua, T0 + 13_000)
    expect(cred).toMatchObject({ authority: 'signin', authority_reason: 'after-password-reset' })
    await expect(beginReauth(db, RP, pw.personId, 'approval', new Uint8Array(32), {}, T0 + 14_000)).rejects.toMatchObject({ code: 'authority_restricted' })
    await expect(beginReauth(db, RP, pw.personId, 'stepup', null, {}, T0 + 14_000)).rejects.toMatchObject({ code: 'authority_restricted' })
    expect(approvingCredentials(db, pw.personId)).toEqual([])
    // its sign-in opens a session with no confirmation in it
    const lb = await beginLogin(db, RP, T0 + 15_000)
    const ls = await finishLogin(db, RP, { challengeId: lb.challengeId, response: key.get(lb.options as never) }, META, T0 + 15_000)
    expect(sessionFor(db, ls.token, T0 + 15_001)).toMatchObject({ stepUpFresh: false, passwordStepUpFresh: false })
  })

  it('limits requests: ten per requester address in fifteen minutes (refused), three messages per account an hour (dropped silently)', async () => {
    const db = openDb(':memory:')
    await passwordAccount(db, 'pwrate', 'rate@gmail.com')
    for (let i = 0; i < 10; i++) requestPasswordReset(db, `someone${i}`, '192.0.2.50', T0 + 10_000 + i)
    expect(() => requestPasswordReset(db, 'pwrate', '192.0.2.50', T0 + 10_011)).toThrow(expect.objectContaining({ status: 429 }))
    for (let i = 0; i < 6; i++) expect(requestPasswordReset(db, 'pwrate', `192.0.2.${60 + i}`, T0 + 20_000 + i)).toEqual({ ok: true })
    expect(count(db, `SELECT COUNT(*) n FROM outbound_messages WHERE to_address = 'rate@gmail.com' AND purpose = 'password-reset'`)).toBe(3)
    requestPasswordReset(db, 'pwrate', '192.0.2.70', T0 + 20_000 + H)
    expect(count(db, `SELECT COUNT(*) n FROM outbound_messages WHERE to_address = 'rate@gmail.com' AND purpose = 'password-reset'`)).toBe(4)
  })
})

describe('account recovery by email: a link, a second proof, a wait, a passkey that signs in only', () => {
  async function owner(db: Db, handle = 'owner') {
    const a = await passkeyAccount(db, handle)
    confirmedEmail(db, a.s(), `${handle}@gmail.com`, T0 + 1000)
    return a
  }
  /** A recovery contact with a passkey, accepted and active at once (its delay written past). */
  async function contact(db: Db, ownerAcct: Awaited<ReturnType<typeof owner>>, handle: string) {
    const c = await passkeyAccount(db, handle)
    const { linkId } = nominateContact(db, ownerAcct.s(), handle, T0 + 2000)
    acceptContact(db, c.s(), linkId, T0 + 2000)
    db.run('UPDATE recovery_contacts SET effective_at = ? WHERE id = ?', T0, linkId)
    return { ...c, linkId }
  }
  const linkFor = (db: Db, handle: string, now: number, ip = '198.51.100.20') => { requestRecoveryLink(db, handle, ip, now); return linkIn(db, `${handle}@gmail.com`, '/recover') }

  it('starts with the email link and a saved code: the code and the link are spent, nothing is granted, and everyone is told', async () => {
    const db = openDb(':memory:')
    const a = await owner(db)
    const c = await contact(db, a, 'helper')
    confirmedEmail(db, c.s(), 'helper@gmail.com', T0 + 3000)
    const token = linkFor(db, 'owner', T0 + 10_000)
    expect(recoveryLinkState(db, token, T0 + 10_001)).toMatchObject({ state: 'start', handle: 'owner', proofs: { savedCode: true, contact: true, password: false } })
    const r = await startRecoveryFromLink(db, { token, code: a.recoveryCodes[2]! }, META.ip, T0 + 11_000)
    expect(r.availableAt).toBe(T0 + 11_000 + RECOVERY_DELAY_MS)
    expect(db.get('SELECT via, method, code_id != \'none\' spent FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ via: 'email', method: 'email+saved', spent: 1 })
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', a.personId)).toBe(1)
    // the same link again is a replay: refused; a new link while one is open is a duplicate: refused too
    await expect(startRecoveryFromLink(db, { token, code: a.recoveryCodes[3]! }, META.ip, T0 + 12_000)).rejects.toMatchObject({ code: 'link_used' })
    await expect(startRecoveryFromLink(db, { token: linkFor(db, 'owner', T0 + 12_500, '198.51.100.22'), code: a.recoveryCodes[3]! }, META.ip, T0 + 12_600)).rejects.toMatchObject({ code: 'recovery_open' })
    // told: the account inside QED, its address, the contact inside QED and at the contact's own address
    expect(count(db, `SELECT COUNT(*) n FROM outbound_messages WHERE to_address = 'owner@gmail.com' AND purpose = 'notice:recovery-started'`)).toBe(1)
    expect(lastTo(db, 'helper@gmail.com')).toMatchObject({ purpose: 'notice:contact-recovery-started' })
    expect(count(db, `SELECT COUNT(*) n FROM notices WHERE user_id = ? AND subject = 'recovery-started'`, a.personId)).toBe(1)
    // nothing granted: the credentials of the account are as they were
    expect(count(db, 'SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ?', a.personId)).toBe(1)
  })

  it('a wrong proof is counted on the link and five end it; a replayed link is refused; a duplicate request is refused', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'tries')
    const token = linkFor(db, 'tries', T0 + 10_000)
    for (let i = 1; i <= 4; i++) await expect(startRecoveryFromLink(db, { token, code: 'AAAA-BBBB-CCCC-DDDD' }, META.ip, T0 + 11_000 + i)).rejects.toMatchObject({ code: 'proof_failed', message: expect.stringContaining(`${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left`) })
    await expect(startRecoveryFromLink(db, { token, code: 'AAAA-BBBB-CCCC-DDDD' }, META.ip, T0 + 11_010)).rejects.toMatchObject({ code: 'proof_failed', message: expect.stringContaining('stopped working') })
    await expect(startRecoveryFromLink(db, { token, code: a.recoveryCodes[0]! }, META.ip, T0 + 11_020)).rejects.toMatchObject({ code: 'link_replaced' })
    // one proof at a time
    const t2 = linkFor(db, 'tries', T0 + 12_000)
    await expect(startRecoveryFromLink(db, { token: t2, code: a.recoveryCodes[0]!, password: 'x' }, META.ip, T0 + 12_001)).rejects.toMatchObject({ code: 'invalid' })
    await startRecoveryFromLink(db, { token: t2, code: a.recoveryCodes[0]! }, META.ip, T0 + 12_002)
    await expect(startRecoveryFromLink(db, { token: t2, code: a.recoveryCodes[1]! }, META.ip, T0 + 12_003)).rejects.toMatchObject({ code: 'link_used' })
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ?', a.personId)).toBe(1)
    // the link expires after an hour
    const t3 = linkFor(db, 'tries', T0 + 13_000)
    expect(() => recoveryLinkState(db, t3, T0 + 13_000 + H + 1)).toThrow(expect.objectContaining({ code: 'link_expired' }))
  })

  it('waits; its "ready" link goes out once when the wait ends; the new passkey signs in only and the spent code set is replaced', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'waits')
    const { requestId, availableAt, finishKey } = await startRecoveryFromLink(db, { token: linkFor(db, 'waits', T0 + 10_000), code: a.recoveryCodes[5]! }, META.ip, T0 + 11_000)
    const early = linkFor(db, 'waits', T0 + 12_000, '198.51.100.21')
    expect(recoveryLinkState(db, early, T0 + 12_001)).toMatchObject({ state: 'waiting', availableAt })
    await expect(beginRecoveryFromLink(db, RP, { token: early, finishKey }, T0 + 12_002)).rejects.toMatchObject({ code: 'recovery_waiting' })
    expect(recoveryTick(db, availableAt - 1)).toBe(0)
    expect(recoveryTick(db, availableAt)).toBe(1)
    expect(recoveryTick(db, availableAt + 1000)).toBe(0)
    expect(lastTo(db, 'waits@gmail.com')).toMatchObject({ purpose: 'recovery-ready', subject: 'Your QED recovery can be finished' })
    const ready = linkIn(db, 'waits@gmail.com', '/recover')
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginRecoveryFromLink(db, RP, { token: ready, finishKey }, availableAt + 2000)
    const done = await finishRecoveryFromLink(db, RP, { challengeId: b.challengeId, response: device.create(b.options as never) }, META, availableAt + 2000)
    expect(done.authority).toBe('signin')
    expect(done.recoveryCodes).toHaveLength(10)
    expect(db.get('SELECT completed_at IS NOT NULL done FROM recovery_requests WHERE id = ?', requestId)).toEqual({ done: 1 })
    const cred = db.get<{ authority: string; authority_reason: string }>('SELECT authority, authority_reason FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at DESC LIMIT 1', a.personId)!
    expect(cred).toEqual({ authority: 'signin', authority_reason: 'recovery' })
    expect(sessionFor(db, done.session.token, availableAt + 2001)).toMatchObject({ stepUpFresh: false })
    // the link was spent with it
    expect(() => linkToken(db, ready, 'recovery-email', availableAt + 3000)).toThrow(expect.objectContaining({ code: 'link_used' }))
    expect(lastTo(db, 'waits@gmail.com')).toMatchObject({ purpose: 'notice:recovery-completed' })
  })

  it('a recovery with a contact\'s code or the password spends no saved code, and replaces none', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'nocode')
    const c = await contact(db, a, 'nocodehelper')
    const { code } = issueContactCode(db, await fresh(db, c.auth, c.session.token, T0 + 3000), c.linkId, T0 + 3000)
    const r = await startRecoveryFromLink(db, { token: linkFor(db, 'nocode', T0 + 10_000), contactCode: code }, META.ip, T0 + 11_000)
    expect(db.get('SELECT method, code_id FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ method: 'email+contact', code_id: 'none' })
    expect(recoveryTick(db, r.availableAt)).toBe(1)
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginRecoveryFromLink(db, RP, { token: linkIn(db, 'nocode@gmail.com', '/recover'), finishKey: r.finishKey }, r.availableAt + 1)
    const done = await finishRecoveryFromLink(db, RP, { challengeId: b.challengeId, response: device.create(b.options as never) }, META, r.availableAt + 1)
    expect(done.recoveryCodes).toEqual([])
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', a.personId)).toBe(10)
    // the password path, on an account that has one
    const pwa = await signUpWithPassword(db, { handle: 'haspw', password: 'the password phrase ok', displayName: 'P' }, META, T0)
    confirmedEmail(db, sessionFor(db, pwa.session.token, T0 + 1000), 'haspw@gmail.com', T0 + 1000)
    const t = linkFor(db, 'haspw', T0 + 20_000)
    await expect(startRecoveryFromLink(db, { token: t, password: 'not the password' }, META.ip, T0 + 20_001)).rejects.toMatchObject({ code: 'proof_failed' })
    const pr = await startRecoveryFromLink(db, { token: t, password: 'the password phrase ok' }, META.ip, T0 + 20_002)
    expect(db.get('SELECT method FROM recovery_requests WHERE id = ?', pr.requestId)).toEqual({ method: 'email+password' })
  })

  it('cancelled from a signed-in device (with its strongest confirmation), or by a recovery contact: the link then says so and nothing completes', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'stopme')
    const c = await contact(db, a, 'stopper')
    const r1 = await startRecoveryFromLink(db, { token: linkFor(db, 'stopme', T0 + 10_000), code: a.recoveryCodes[0]! }, META.ip, T0 + 11_000)
    // the owner's stale session cannot; a fresh passkey confirmation can, and the spent code's set is replaced
    expect(() => cancelRecovery(db, sessionFor(db, a.session.token, T0 + 20 * 60_000)!, r1.requestId, T0 + 20 * 60_000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    const out = cancelRecovery(db, await fresh(db, a.auth, a.session.token, T0 + 21 * 60_000), r1.requestId, T0 + 21 * 60_000)
    expect(out).toEqual({ codes: [], codeSpent: true }) // H2 re-check: no new set handed to the canceller
    const remaining = makeRecoveryCodes(db, a.personId, T0 + 21 * 60_000 + 1) // the owner makes new codes (one of theirs, in the app)
    expect(count(db, `SELECT COUNT(*) n FROM outbound_messages WHERE to_address = 'stopme@gmail.com' AND purpose = 'notice:recovery-cancelled'`)).toBe(1)
    // a new one, stopped by the recovery contact; someone who is not a contact cannot
    const t2 = linkFor(db, 'stopme', T0 + 2 * H, '198.51.100.30')
    const r2 = await startRecoveryFromLink(db, { token: t2, code: remaining[0]! }, META.ip, T0 + 2 * H + 1)
    const stranger = await passkeyAccount(db, 'stranger')
    const strangerSession = await fresh(db, stranger.auth, stranger.session.token, T0 + 2 * H + 2)
    expect(() => contactCancel(db, strangerSession, c.linkId, T0 + 2 * H + 2)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => contactCancel(db, sessionFor(db, c.session.token, T0 + 2 * H + 3)!, c.linkId, T0 + 2 * H + 3)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(contactCancel(db, await fresh(db, c.auth, c.session.token, T0 + 2 * H + 4), c.linkId, T0 + 2 * H + 4)).toEqual({ recoveries: 1, authority: 0 })
    expect(db.get<{ cancelled_by: string }>('SELECT cancelled_by FROM recovery_requests WHERE id = ?', r2.requestId)!.cancelled_by).toBe('contact:stopper')
    expect(() => recoveryLinkState(db, linkFor(db, 'stopme', T0 + 3 * H, '198.51.100.31'), T0 + 3 * H)).not.toThrow()
    // the "ready" link of the cancelled one never goes out, and nothing can complete it
    expect(recoveryTick(db, r2.availableAt + 1)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ?', a.personId)).toBe(1)
  })

  it('a recovery contact in force stops a loosening that waits its delay: with their own fresh passkey, only a loosening, never applying anything, and the person is told', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'loosener')
    const c = await contact(db, a, 'guardian')
    const effective = T0 + 80 * H
    const ask = (id: string, kind: string, subject: string, detail: object, at: number): void => { db.run('INSERT INTO scheduled_changes (id, person_id, workspace_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, a.personId, a.personId, kind, subject, JSON.stringify(detail), at, a.personId, effective) }
    const stranger = await passkeyAccount(db, 'stranger3')
    const strangerSession = await fresh(db, stranger.auth, stranger.session.token, T0 + 2 * H)
    expect(() => contactCancelLoosening(db, strangerSession, c.linkId, T0 + 2 * H)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => contactCancelLoosening(db, sessionFor(db, c.session.token, T0 + 2 * H + 1)!, c.linkId, T0 + 2 * H + 1)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    const cs = await fresh(db, c.auth, c.session.token, T0 + 2 * H + 2)
    // nothing waiting: said so, nothing changed
    expect(() => contactCancelLoosening(db, cs, c.linkId, T0 + 2 * H + 2)).toThrow(expect.objectContaining({ code: 'nothing_open' }))
    // a loosening, and an unrelated change of the same person (a request for approval authority), wait
    ask('chg_loose', 'loosen-profile', a.personId, { after: { lostSalaries: 0 }, before: { lostSalaries: 1 } }, T0 + 3 * H)
    ask('chg_auth', 'restore-authority', 'cred_x', {}, T0 + 3 * H)
    expect(contactCancelLoosening(db, cs, c.linkId, T0 + 3 * H + 1)).toEqual({ loosenings: 1 })
    expect(db.get('SELECT cancelled_by, applied_at FROM scheduled_changes WHERE id = ?', 'chg_loose')).toEqual({ cancelled_by: 'contact:guardian', applied_at: null })
    // it never touches what is not a loosening
    expect(db.get('SELECT cancelled_at FROM scheduled_changes WHERE id = ?', 'chg_auth')).toEqual({ cancelled_at: null })
    // the person and the contact are told; the audit says so
    expect(db.all<{ d: string }>(`SELECT detail_json d FROM security_events WHERE person_id = ? AND kind = 'loosening-cancelled'`, a.personId).map((r) => JSON.parse(r.d))).toEqual([{ by: 'your recovery contact', contact: 'guardian', loosenings: 1 }])
    expect(count(db, `SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'you-stopped-loosening'`, c.personId)).toBe(1)
    expect(count(db, `SELECT COUNT(*) n FROM audit WHERE action = 'recovery-contact.cancel-loosening' AND user_id = ?`, c.personId)).toBe(1)
    // when the delay ends it is not applied
    applyDueChanges(db, effective + 1)
    expect(db.get('SELECT applied_at FROM scheduled_changes WHERE id = ?', 'chg_loose')).toEqual({ applied_at: null })
    // one that already took effect cannot be reached, and a contact who stepped down cannot stop anything
    ask('chg_done', 'loosen-profile', a.personId, { after: { lostSalaries: 0 }, before: {} }, T0 + 4 * H)
    db.run('UPDATE scheduled_changes SET applied_at = ? WHERE id = ?', effective + 2, 'chg_done')
    expect(() => contactCancelLoosening(db, cs, c.linkId, effective + 3)).toThrow(expect.objectContaining({ code: 'nothing_open' }))
    ask('chg_again', 'loosen-profile', a.personId, { after: { lostSalaries: 0 }, before: {} }, T0 + 5 * H)
    db.run('UPDATE recovery_contacts SET removed_at = ? WHERE id = ?', T0 + 5 * H + 1, c.linkId)
    expect(() => contactCancelLoosening(db, cs, c.linkId, T0 + 5 * H + 2)).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('a recovery contact pauses QED for the person who trusts them, with their own fresh passkey; protective selling that runs without asking carries on and only that person resumes it', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'pauseme')
    const c = await contact(db, a, 'pauser')
    const at = (t: number) => ({ db, clock: { now: () => t } }) as unknown as Parameters<typeof contactPause>[0]
    const stranger = await passkeyAccount(db, 'stranger2')
    const strangerSession = await fresh(db, stranger.auth, stranger.session.token, T0 + 2 * H)
    expect(() => contactPause(at(T0 + 2 * H), strangerSession, c.linkId)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => contactPause(at(T0 + 2 * H + 1), sessionFor(db, c.session.token, T0 + 2 * H + 1)!, c.linkId)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    const contactSession = await fresh(db, c.auth, c.session.token, T0 + 2 * H + 2)
    expect(contactPause(at(T0 + 2 * H + 2), contactSession, c.linkId)).toEqual({ ok: true })
    expect(db.get('SELECT stop_protective, stop_reason FROM users WHERE id = ?', a.personId)).toEqual({ stop_protective: 1, stop_reason: 'Paused by your recovery contact @pauser' })
    // a second time changes nothing and answers the same; both histories say who paused it; a third is the last of the day
    expect(contactPause(at(T0 + 2 * H + 3), contactSession, c.linkId)).toEqual({ ok: true })
    expect(contactPause(at(T0 + 2 * H + 3), contactSession, c.linkId)).toEqual({ ok: true })
    expect(() => contactPause(at(T0 + 2 * H + 3), contactSession, c.linkId)).toThrow(expect.objectContaining({ code: 'too_many' }))
    expect(count(db, `SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'paused-by-contact'`, a.personId)).toBe(3)
    // each says whether it was already paused and whether protective selling kept running (R13: said truly)
    expect(db.all<{ d: string }>(`SELECT detail_json d FROM security_events WHERE person_id = ? AND kind = 'paused-by-contact' ORDER BY id`, a.personId).map((r) => JSON.parse(r.d))).toEqual([
      { contact: 'pauser', already: false, protectiveContinues: true }, { contact: 'pauser', already: true, protectiveContinues: true }, { contact: 'pauser', already: true, protectiveContinues: true },
    ])
    expect(count(db, `SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'you-paused-for-them'`, c.personId)).toBe(3)
    // a contact who stepped down can no longer
    db.run('UPDATE recovery_contacts SET removed_at = ? WHERE id = ?', T0 + 2 * H + 4, c.linkId)
    expect(() => contactPause(at(T0 + 2 * H + 5), contactSession, c.linkId)).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('one account\'s link never reaches another account', async () => {
    const db = openDb(':memory:')
    const a = await owner(db, 'alpha'), b = await owner(db, 'beta')
    const ta = linkFor(db, 'alpha', T0 + 10_000)
    // beta's saved code with alpha's link does not match: the codes checked are alpha's own
    await expect(startRecoveryFromLink(db, { token: ta, code: b.recoveryCodes[0]! }, META.ip, T0 + 11_000)).rejects.toMatchObject({ code: 'proof_failed' })
    await startRecoveryFromLink(db, { token: ta, code: a.recoveryCodes[0]! }, META.ip, T0 + 11_001)
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ?', b.personId)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', b.personId)).toBe(0)
  })
})

describe('approval authority after a recovery: asked separately, delayed, told everywhere, stoppable', () => {
  /** An owner with a confirmed email, one contact, and a passkey a recovery has just registered (it signs in only). */
  async function recovered(db: Db) {
    const a = await passkeyAccount(db, 'rec')
    confirmedEmail(db, a.s(), 'rec@gmail.com', T0 + 1000)
    const c = await passkeyAccount(db, 'recfriend')
    const { linkId } = nominateContact(db, a.s(), 'recfriend', T0 + 2000)
    acceptContact(db, c.s(), linkId, T0 + 2000)
    db.run('UPDATE recovery_contacts SET effective_at = ? WHERE id = ?', T0, linkId)
    requestRecoveryLink(db, 'rec', '198.51.100.40', T0 + 10_000)
    const r = await startRecoveryFromLink(db, { token: linkIn(db, 'rec@gmail.com', '/recover'), code: a.recoveryCodes[0]! }, META.ip, T0 + 11_000)
    recoveryTick(db, r.availableAt)
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginRecoveryFromLink(db, RP, { token: linkIn(db, 'rec@gmail.com', '/recover'), finishKey: r.finishKey }, r.availableAt + 1)
    const done = await finishRecoveryFromLink(db, RP, { challengeId: b.challengeId, response: device.create(b.options as never) }, META, r.availableAt + 1)
    const now = r.availableAt + 10
    // the owner's old device was not lost after all, and the contact is signed in: both sign in again after the wait
    const ownerToken = await signinAt(db, a.auth, now), contactToken = await signinAt(db, c.auth, now)
    return { a, c, linkId, device, token: done.session.token, ownerToken, contactToken, now, s: (t = now) => sessionFor(db, done.session.token, t)! }
  }
  async function ask(db: Db, x: Awaited<ReturnType<typeof recovered>>, now: number) {
    const b = await beginAuthorityRequest(db, RP, x.s(now), now)
    return finishAuthorityRequest(db, RP, x.s(now), { challengeId: b.challengeId, response: x.device.get(b.options as never) }, now)
  }

  it('the recovered passkey approves nothing and confirms nothing; the vault offers it nowhere', async () => {
    const db = openDb(':memory:')
    const x = await recovered(db)
    const recId = db.get<{ id: string }>(`SELECT id FROM webauthn_credentials WHERE authority = 'signin'`)!.id
    // an approval offered to it alone has no passkey that may sign
    await expect(beginReauth(db, RP, x.a.personId, 'approval', new Uint8Array(32), {}, x.now, [recId])).rejects.toMatchObject({ code: 'passkey_not_allowed' })
    // the owner's old passkey (not lost after all) still approves: the restriction is the recovered one's alone
    expect(approvingCredentials(db, x.a.personId).map((c) => c.authority)).toEqual(['full'])
    // a challenge made for the old passkey, answered by the recovered one, is refused at the finish too
    const b = await beginReauth(db, RP, x.a.personId, 'approval', new Uint8Array(32).fill(7), {}, x.now)
    await expect(finishReauth(db, RP, x.s(), 'approval', { challengeId: b.challengeId, response: x.device.get(b.options as never) }, x.now)).rejects.toMatchObject({ code: 'authority_restricted' })
    const st = await beginReauth(db, RP, x.a.personId, 'stepup', null, {}, x.now)
    await expect(finishReauth(db, RP, x.s(), 'stepup', { challengeId: st.challengeId, response: x.device.get(st.options as never) }, x.now)).rejects.toMatchObject({ code: 'authority_restricted' })
    expect(x.s()).toMatchObject({ stepUpFresh: false })
  })

  it('asking schedules it after the protection delay and tells the account, its addresses and its contacts; asking twice is refused', async () => {
    const db = openDb(':memory:')
    const x = await recovered(db)
    const r = await ask(db, x, x.now)
    expect(r.effectiveAt).toBe(x.now + PROTECTION_DELAY_MS)
    await expect(ask(db, x, x.now + 1)).rejects.toMatchObject({ code: 'already_scheduled' })
    expect(lastTo(db, 'rec@gmail.com')).toMatchObject({ purpose: 'notice:authority-restore-requested' })
    expect(count(db, `SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'contact-authority-requested'`, x.c.personId)).toBe(1)
    // a passkey that already approves cannot use this ceremony
    const st = await beginReauth(db, RP, x.a.personId, 'stepup', null, {}, x.now)
    const owner = sessionFor(db, x.ownerToken, x.now)!
    await finishReauth(db, RP, owner, 'stepup', { challengeId: st.challengeId, response: x.a.auth.get(st.options as never) }, x.now)
    const b = await beginAuthorityRequest(db, RP, owner, x.now)
    await expect(finishAuthorityRequest(db, RP, owner, { challengeId: b.challengeId, response: x.a.auth.get(b.options as never) }, x.now)).rejects.toMatchObject({ code: 'authority_full' })
    // after the delay the engine's tick applies it, and the passkey approves
    applyDueChanges(db, x.now + PROTECTION_DELAY_MS - 1)
    await expect(beginReauth(db, RP, x.a.personId, 'approval', new Uint8Array(32), {}, x.now + PROTECTION_DELAY_MS - 1, [db.get<{ id: string }>(`SELECT id FROM webauthn_credentials WHERE authority = 'signin'`)!.id])).rejects.toMatchObject({ code: 'passkey_not_allowed' })
    applyDueChanges(db, x.now + PROTECTION_DELAY_MS)
    expect(count(db, `SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND authority = 'full'`, x.a.personId)).toBe(2)
    const later = x.now + PROTECTION_DELAY_MS + 1
    const back = sessionFor(db, await signinAt(db, x.device, later), later)!
    expect(back.stepUpFresh).toBe(true) // a passkey with authority opens a confirmed session, as any does
    const ab = await beginReauth(db, RP, x.a.personId, 'approval', new Uint8Array(32).fill(1), { approvalId: 'apr_x' }, later)
    expect((await finishReauth(db, RP, back, 'approval', { challengeId: ab.challengeId, response: x.device.get(ab.options as never) }, later)).credential.authority).toBe('full')
    expect(lastTo(db, 'rec@gmail.com')).toMatchObject({ purpose: 'notice:authority-restored' })
  })

  it('stopped by the passkey that asked, by any passkey with authority after a confirmation, or by a recovery contact; never by a password session', async () => {
    const db = openDb(':memory:')
    const x = await recovered(db)
    const r1 = await ask(db, x, x.now)
    // its own session stops it without a confirmation
    cancelAuthorityRequest(db, x.s(), r1.changeId, x.now + 1)
    expect(lastTo(db, 'rec@gmail.com')).toMatchObject({ purpose: 'notice:authority-restore-cancelled' })
    // the owner's other passkey, once it confirms
    const r2 = await ask(db, x, x.now + 2)
    // (a session opened with the passkey that approves is confirmed for five minutes: one opened earlier is not)
    db.run('UPDATE sessions SET stepup_at = NULL WHERE id_hash = ?', sessionFor(db, x.ownerToken, x.now)!.sessionHash)
    const stale = sessionFor(db, x.ownerToken, x.now + 3)!
    expect(() => cancelAuthorityRequest(db, stale, r2.changeId, x.now + 3)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    cancelAuthorityRequest(db, await fresh(db, x.a.auth, x.ownerToken, x.now + 4), r2.changeId, x.now + 4)
    // the recovery contact
    const r3 = await ask(db, x, x.now + 5)
    const cs = await fresh(db, x.c.auth, x.contactToken, x.now + 6)
    expect(contactCancel(db, cs, x.linkId, x.now + 6)).toEqual({ recoveries: 0, authority: 1 })
    expect(db.get<{ cancelled_by: string }>('SELECT cancelled_by FROM scheduled_changes WHERE id = ?', r3.changeId)!.cancelled_by).toBe('contact:recfriend')
    // a session opened with a password (here: the person has none, so a password account stands in) cannot stop another's
    expect(() => cancelAuthorityRequest(db, { ...x.s(), credentialId: null, stepUpFresh: false }, r3.changeId, x.now + 7)).toThrow()
    // nothing of these applies later
    applyDueChanges(db, x.now + PROTECTION_DELAY_MS + 10)
    expect(count(db, `SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND authority = 'signin'`, x.a.personId)).toBe(1)
  })

  it('a passkey with authority can grant it at once, after a confirmation; a suspended passkey\'s request lapses', async () => {
    const db = openDb(':memory:')
    const x = await recovered(db)
    const r = await ask(db, x, x.now)
    // the recovered passkey's own session cannot grant itself anything
    expect(() => grantAuthorityNow(db, x.s(), r.changeId, x.now + 1)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    grantAuthorityNow(db, await fresh(db, x.a.auth, x.ownerToken, x.now + 2), r.changeId, x.now + 2)
    expect(count(db, `SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND authority = 'full'`, x.a.personId)).toBe(2)

    const db2 = openDb(':memory:')
    const y = await recovered(db2)
    await ask(db2, y, y.now)
    const recId = db2.get<{ id: string }>(`SELECT id FROM webauthn_credentials WHERE authority = 'signin'`)!.id
    { const ss = await fresh(db2, y.a.auth, y.ownerToken, y.now + 1); suspendPasskey(db2, ss, recId, y.now + 1, unusedCodeId(db2, ss.userId)) }
    // suspending it cancels what it asked for at once, as it does any change a suspended passkey scheduled
    expect(db2.get(`SELECT cancelled_by FROM scheduled_changes WHERE kind = 'restore-authority'`)).toEqual({ cancelled_by: 'requester-suspended' })
    applyDueChanges(db2, y.now + PROTECTION_DELAY_MS + 1)
    expect(db2.get(`SELECT authority FROM webauthn_credentials WHERE id = ?`, recId)).toEqual({ authority: 'signin' })
  })
})

describe('delivery: the local test outbox sends nothing and says so; a provider is prepared, not configured', () => {
  it('stores every message as simulated, and the developer page says that nothing was sent', () => {
    const db = openDb(':memory:')
    configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' })
    requestPasswordReset(db, 'nobody', '192.0.2.1', T0)
    db.run(`INSERT INTO outbound_messages (id, person_id, channel, to_address, purpose, subject, body, created_at, status, adapter) VALUES ('m1', NULL, 'sms', '+911234567890', 'test', 's', 'b', 1, 'simulated', 'local-test-outbox')`)
    const v = outboxView(db)
    expect(v.notice).toBe('Simulated delivery: no email or text message was sent.')
    expect(v.messages.every((m) => m.status === 'simulated')).toBe(true)
    expect(maskAddress('email', 'someone@gmail.com')).toBe('s•••@gmail.com')
    expect(maskAddress('phone', '+919876543210')).toBe('•••••••••3210')
  })

  it('with no adapter nothing is stored, and what needs a message is refused alike for every account, saying so (review M4)', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'quiet')
    configureDelivery({ delivery: 'none', linkOrigin: 'https://wallet.example.in' })
    try {
      expect(() => addAddress(db, a.s(), 'email', 'quiet@gmail.com', T0 + 1000)).toThrow(expect.objectContaining({ code: 'delivery_unavailable' }))
      // the same refusal for an account that exists and one that does not: it is decided before anything is looked up
      for (const who of ['quiet', 'nobody-at-all']) expect(() => requestPasswordReset(db, who, '192.0.2.2', T0 + 2000)).toThrow(expect.objectContaining({ code: 'delivery_unavailable', status: 503 }))
      expect(count(db, 'SELECT COUNT(*) n FROM outbound_messages')).toBe(0)
    } finally { configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' }) }
  })

  it('the provider adapter refuses and names what it needs; a dispatcher sends queued messages once, keeping no text of a sent one', async () => {
    await expect(providerAdapter('email').send({ id: 'x', channel: 'email', to: 'a@b.in', personId: null, purpose: 'p', subject: 's', body: 'b' })).rejects.toThrow(PROVIDER_DEPENDENCY.email)
    expect(PROVIDER_DEPENDENCY.sms).toContain('DLT')
    const db = openDb(':memory:')
    for (const id of ['q1', 'q2']) db.run(`INSERT INTO outbound_messages (id, channel, to_address, purpose, subject, body, created_at, status, adapter) VALUES (?, 'email', 'a@b.in', 'p', 's', 'link http://x/#token=abc', 1, 'queued', 'none')`, id)
    let calls = 0
    const fake = { name: 'fake', simulated: false, send: async (m: { id: string }) => { calls++; if (m.id === 'q2') throw new Error('refused by the fake'); return { providerRef: `ref-${m.id}` } } }
    expect(await dispatchQueued(db, fake, 5)).toEqual({ sent: 1, failed: 1, retrying: 0 })
    expect(await dispatchQueued(db, fake, 6)).toEqual({ sent: 0, failed: 0, retrying: 0 })
    expect(calls).toBe(2)
    expect(db.get(`SELECT status, provider_ref, body FROM outbound_messages WHERE id = 'q1'`)).toEqual({ status: 'sent', provider_ref: 'ref-q1', body: '(sent; the text is not kept)' })
    expect(db.get(`SELECT status, error FROM outbound_messages WHERE id = 'q2'`)).toEqual({ status: 'failed', error: 'refused by the fake' })
  })
})
