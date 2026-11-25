/**
 * The independent review of R12's recovery (24 Nov 2026), finding by finding, at the functions the routes call. Each test
 * was written to fail on the reviewed revision (7888c1b) and pass with its fix:
 *   H1  an email link finishes only a recovery the email path started, with the key the starting browser kept, within
 *       a finishing window; a recovery started with saved codes is never finished by an email link
 *   M1  after a password reset, the password confirms no change to how the account is recovered; an account whose only
 *       passkeys sign in only can still reset its password, and a reset stops a pending request for authority
 *   M2  a recovery contact still inside its protection delay cannot stop anything
 *   M4  with no delivery adapter, nothing that needs a message is offered as if it had been sent
 *   L1  a link and a code leave the stored message once they are used, replaced or lapsed
 *   L5  wrong proofs sent together are each counted
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { login, sessionFor, stepUp } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { configureDelivery } from './delivery.ts'
import {
  acceptContact, applyDueChanges, beginAddPasskey, beginLogin, beginReauth, beginRecoveryPasskey, beginSignup, cancelRecovery, finishAddPasskey, finishLogin, finishReauth, finishSignup,
  nominateContact, PROTECTION_DELAY_MS, RECOVERY_DELAY_MS, RECOVERY_FINISH_WINDOW_MS, regenerateRecoveryCodes, type RelyingParty, signUpWithPassword as openWithPassword, startRecovery, makeRecoveryCodes,
} from './passkeys.ts'
import {
  addAddress, beginAuthorityRequest, beginRecoveryFromLink, confirmAddressByLink, contactCancel, finishAuthorityRequest, finishRecoveryFromLink, recoveryLinkState, recoveryTick,
  removeAddress, requestPasswordReset, requestRecoveryLink, resetPassword, startRecoveryFromLink,
} from './recovery.ts'
import { SoftAuthenticator } from './softauthn.ts'

// R14: sign-up makes no saved recovery codes any more. These tests are about what the codes do, so each account makes its set right after it opens.
const signUpWithPassword = async (db: Db, input: Parameters<typeof openWithPassword>[1], meta: Parameters<typeof openWithPassword>[2], now: number) => { const r = await openWithPassword(db, input, meta, now); return { ...r, recoveryCodes: makeRecoveryCodes(db, r.personId, now) } }

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const H = 3600_000
configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' })

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const lastTo = (db: Db, to: string) => db.get<{ subject: string; body: string; purpose: string }>('SELECT subject, body, purpose FROM outbound_messages WHERE to_address = ? ORDER BY rowid DESC LIMIT 1', to)
function linkIn(db: Db, to: string, page: string): string {
  const m = new RegExp(`${page.replace('/', '\\/')}#token=([A-Za-z0-9_-]+)`).exec(lastTo(db, to)?.body ?? '')
  if (!m) throw new Error(`no ${page} link to ${to}`)
  return m[1]!
}
const count = (db: Db, sql: string, ...p: (string | number)[]) => db.get<{ n: number }>(sql, ...p)!.n

async function passkeyAccount(db: Db, handle: string, now = T0) {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, `10.1.0.${handle.length}`, now)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META, now)
  return { auth, ...r, recoveryCodes: makeRecoveryCodes(db, r.personId, now), s: (t = now + 1000) => sessionFor(db, r.session.token, t)! }
}
function confirmedEmail(db: Db, s: ReturnType<typeof sessionFor>, address: string, now: number) {
  addAddress(db, s!, 'email', address, now)
  confirmAddressByLink(db, linkIn(db, address, '/verify-email'), META.ip, now + 1)
  db.run('UPDATE contact_points SET usable_from = ? WHERE address_key = ?', now, address.toLowerCase())
}
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
/** A password account with a usable email address, reset by its link: the hold a reset leaves is in force. */
async function resetAccount(db: Db, handle: string) {
  const made = await signUpWithPassword(db, { handle, password: 'the first long phrase', displayName: handle }, META, T0)
  confirmedEmail(db, sessionFor(db, made.session.token, T0 + 1000), `${handle}@gmail.com`, T0 + 1000)
  requestPasswordReset(db, handle, '198.18.0.1', T0 + 10_000)
  await resetPassword(db, { token: linkIn(db, `${handle}@gmail.com`, '/reset-password'), password: 'the reset long phrase', confirm: 'the reset long phrase' }, META.ip, T0 + 11_000)
  const tok = (await login(db, { handle, password: 'the reset long phrase' }, META, T0 + 12_000)).token
  await stepUp(db, sessionFor(db, tok, T0 + 12_000)!, 'the reset long phrase', META.ip, T0 + 12_000)
  return { ...made, token: tok, s: (t = T0 + 13_000) => sessionFor(db, tok, t)! }
}

describe('H1: an email link finishes only what the email path started, with the starting browser\'s key, in time', () => {
  it('a via=\'codes\' recovery finished by an email link is refused', async () => {
    const db = openDb(':memory:')
    const made = await signUpWithPassword(db, { handle: 'codesonly', password: 'the account phrase here', displayName: 'C' }, META, T0)
    confirmedEmail(db, sessionFor(db, made.session.token, T0 + 1000), 'codesonly@gmail.com', T0 + 1000)
    // the backup path: a saved code and the account's password, no email
    const r = await startRecovery(db, { handle: 'codesonly', code: made.recoveryCodes[0]!, password: 'the account phrase here' }, '198.18.1.1', T0 + 10_000)
    expect(db.get('SELECT via FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ via: 'codes' })
    const after = r.availableAt + 1
    requestRecoveryLink(db, 'codesonly', '198.18.1.2', after)
    const token = linkIn(db, 'codesonly@gmail.com', '/recover')
    // the link says what is under way, and finishes nothing
    expect(recoveryLinkState(db, token, after)).toMatchObject({ state: 'codes' })
    await expect(beginRecoveryFromLink(db, RP, { token, finishKey: 'x'.repeat(24) }, after)).rejects.toMatchObject({ code: 'recovery_not_by_email' })
    expect(count(db, 'SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ?', made.personId)).toBe(0)
  })

  it('finishing needs the key the starting browser was given: without it, or with another, nothing is registered', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'keyed')
    confirmedEmail(db, a.s(), 'keyed@gmail.com', T0 + 1000)
    requestRecoveryLink(db, 'keyed', '198.18.2.1', T0 + 10_000)
    const started = await startRecoveryFromLink(db, { token: linkIn(db, 'keyed@gmail.com', '/recover'), code: a.recoveryCodes[0]! }, META.ip, T0 + 11_000)
    expect(started.finishKey).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(db.get<{ secret_hash: string }>('SELECT secret_hash FROM recovery_requests WHERE id = ?', started.requestId)!.secret_hash).toBe(sha(started.finishKey))
    expect(recoveryTick(db, started.availableAt)).toBe(1)
    const ready = linkIn(db, 'keyed@gmail.com', '/recover')
    expect(recoveryLinkState(db, ready, started.availableAt + 1)).toMatchObject({ state: 'ready', requestId: started.requestId })
    // someone else who reads the same mailbox has the link but not the key
    await expect(beginRecoveryFromLink(db, RP, { token: ready, finishKey: '' }, started.availableAt + 2)).rejects.toMatchObject({ code: 'finish_key_needed' })
    await expect(beginRecoveryFromLink(db, RP, { token: ready, finishKey: 'A'.repeat(24) }, started.availableAt + 3)).rejects.toMatchObject({ code: 'finish_key_wrong' })
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginRecoveryFromLink(db, RP, { token: ready, finishKey: started.finishKey }, started.availableAt + 4)
    const done = await finishRecoveryFromLink(db, RP, { challengeId: b.challengeId, response: device.create(b.options as never) }, META, started.availableAt + 4)
    expect(done.authority).toBe('signin')
  })

  it('a recovery not finished within its window lapses: it can no longer be finished, and a new one may start', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'lapses')
    confirmedEmail(db, a.s(), 'lapses@gmail.com', T0 + 1000)
    requestRecoveryLink(db, 'lapses', '198.18.3.1', T0 + 10_000)
    const started = await startRecoveryFromLink(db, { token: linkIn(db, 'lapses@gmail.com', '/recover'), code: a.recoveryCodes[0]! }, META.ip, T0 + 11_000)
    const late = started.availableAt + RECOVERY_FINISH_WINDOW_MS + 1
    applyDueChanges(db, late)
    expect(db.get<{ cancelled_by: string }>('SELECT cancelled_by FROM recovery_requests WHERE id = ?', started.requestId)!.cancelled_by).toBe('expired')
    requestRecoveryLink(db, 'lapses', '198.18.3.2', late + 1)
    expect(recoveryLinkState(db, linkIn(db, 'lapses@gmail.com', '/recover'), late + 2)).toMatchObject({ state: 'start' })
  })

  it('a backup recovery past its window is refused by its reference even before the tick closes it', async () => {
    const db = openDb(':memory:')
    const made = await signUpWithPassword(db, { handle: 'oldref', password: 'the account phrase here', displayName: 'O' }, META, T0)
    const r = await startRecovery(db, { handle: 'oldref', code: made.recoveryCodes[0]!, password: 'the account phrase here' }, '198.18.3.9', T0 + 10_000)
    await expect(beginRecoveryPasskey(db, RP, r.reference, r.availableAt + RECOVERY_FINISH_WINDOW_MS)).rejects.toMatchObject({ code: 'recovery_lapsed' })
    expect((await beginRecoveryPasskey(db, RP, r.reference, r.availableAt + RECOVERY_FINISH_WINDOW_MS - 1)).challengeId).toBeTruthy()
  })
})

describe('M1: after a password reset, the password confirms no change to how the account is recovered', () => {
  it('new codes, an address added or removed, and a recovery cancelled are refused with a password confirmation while the hold stands', async () => {
    const db = openDb(':memory:')
    const x = await resetAccount(db, 'heldpw')
    const email = db.get<{ id: string }>(`SELECT id FROM contact_points WHERE address = 'heldpw@gmail.com'`)!.id
    expect(() => regenerateRecoveryCodes(db, x.s(), T0 + 13_000)).toThrow(expect.objectContaining({ code: 'authority_restricted' }))
    expect(() => removeAddress(db, x.s(), email, T0 + 13_000)).toThrow(expect.objectContaining({ code: 'authority_restricted' }))
    expect(() => addAddress(db, x.s(), 'email', 'someone.else@gmail.com', T0 + 13_000)).toThrow(expect.objectContaining({ code: 'authority_restricted' }))
    // a password set by an emailed link is no second proof beside a link to the same mailbox: it is not offered, and refused
    requestRecoveryLink(db, 'heldpw', '198.18.4.1', T0 + 14_000)
    const token = linkIn(db, 'heldpw@gmail.com', '/recover')
    expect(recoveryLinkState(db, token, T0 + 14_500)).toMatchObject({ state: 'start', proofs: { password: false, savedCode: true } })
    await expect(startRecoveryFromLink(db, { token, password: 'the reset long phrase' }, META.ip, T0 + 14_600)).rejects.toMatchObject({ code: 'password_reset_recently' })
    // a recovery under way (started with the link and a saved code) cannot be cancelled with the reset password
    const started = await startRecoveryFromLink(db, { token, code: x.recoveryCodes[0]! }, META.ip, T0 + 15_000)
    await stepUp(db, x.s(T0 + 16_000), 'the reset long phrase', META.ip, T0 + 16_000)
    expect(() => cancelRecovery(db, x.s(T0 + 16_000), started.requestId, T0 + 16_000)).toThrow(expect.objectContaining({ code: 'authority_restricted' }))
    // once the protection delay after the reset has passed, the password confirms as before
    const later = T0 + 11_000 + PROTECTION_DELAY_MS + 1
    const tok = (await login(db, { handle: 'heldpw', password: 'the reset long phrase' }, META, later)).token
    await stepUp(db, sessionFor(db, tok, later)!, 'the reset long phrase', META.ip, later)
    { const ss = sessionFor(db, tok, later)!; expect(regenerateRecoveryCodes(db, ss, later, unusedCodeId(db, ss.userId))).toHaveLength(10) }
  })

  it('an account whose only passkeys sign in only can still reset its password, and the reset stops a pending request for authority', async () => {
    const db = openDb(':memory:')
    const x = await resetAccount(db, 'onlysignin')
    // a passkey added with the reset password signs in only; it asks for authority
    const key = new SoftAuthenticator({ origin: RP.origins[0]! })
    const ab = await beginAddPasskey(db, RP, x.s(), T0 + 13_000)
    await finishAddPasskey(db, RP, x.s(), { challengeId: ab.challengeId, response: key.create(ab.options as never) }, META.ua, T0 + 13_000)
    const tok = await signinAt(db, key, T0 + 14_000)
    const rb = await beginAuthorityRequest(db, RP, sessionFor(db, tok, T0 + 14_000)!, T0 + 14_000)
    const asked = await finishAuthorityRequest(db, RP, sessionFor(db, tok, T0 + 14_000)!, { challengeId: rb.challengeId, response: key.get(rb.options as never) }, T0 + 14_000)
    // the owner, who lost the password, resets it by email: a link is sent, not "sign in with your passkey"
    requestPasswordReset(db, 'onlysignin', '198.18.5.1', T0 + 2 * H)
    expect(lastTo(db, 'onlysignin@gmail.com')!.purpose).toBe('password-reset')
    await resetPassword(db, { token: linkIn(db, 'onlysignin@gmail.com', '/reset-password'), password: 'the owner new phrase', confirm: 'the owner new phrase' }, META.ip, T0 + 2 * H + 1)
    expect(db.get<{ cancelled_by: string }>('SELECT cancelled_by FROM scheduled_changes WHERE id = ?', asked.changeId)!.cancelled_by).toBe('password-reset')
    applyDueChanges(db, T0 + 14_000 + PROTECTION_DELAY_MS + 1)
    expect(count(db, `SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND authority = 'full'`, x.personId)).toBe(0)
  })
})

describe('M2: a recovery contact inside its protection delay stops nothing', () => {
  it('refuses a contact whose naming has not yet taken effect', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'trusting')
    const c = await passkeyAccount(db, 'tooearly')
    const { linkId } = nominateContact(db, a.s(), 'tooearly', T0 + 2000)
    acceptContact(db, c.s(), linkId, T0 + 2000)
    confirmedEmail(db, sessionFor(db, a.session.token, T0 + 3000), 'trusting@gmail.com', T0 + 3000)
    requestRecoveryLink(db, 'trusting', '198.18.6.1', T0 + 10_000)
    await startRecoveryFromLink(db, { token: linkIn(db, 'trusting@gmail.com', '/recover'), code: a.recoveryCodes[0]! }, META.ip, T0 + 11_000)
    // still inside the contact's protection delay (72 hours from its naming)
    const cs = await fresh(db, c.auth, await signinAt(db, c.auth, T0 + 20_000), T0 + 20_000)
    expect(() => contactCancel(db, cs, linkId, T0 + 20_000)).toThrow(expect.objectContaining({ status: 404 }))
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL', a.personId)).toBe(1)
  })
})

describe('M4: with no delivery adapter, nothing that needs a message pretends to send one', () => {
  it('a reset, a recovery link and an address to confirm are refused, saying why and what to use instead', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db, 'nodelivery')
    configureDelivery({ delivery: 'none', linkOrigin: 'https://wallet.example.in' })
    try {
      for (const f of [() => requestPasswordReset(db, 'nodelivery', '198.18.7.1', T0 + 10_000), () => requestRecoveryLink(db, 'nodelivery', '198.18.7.2', T0 + 10_000), () => addAddress(db, a.s(), 'email', 'nodelivery@gmail.com', T0 + 10_000)]) {
        expect(f).toThrow(expect.objectContaining({ code: 'delivery_unavailable', message: expect.stringMatching(/cannot send email or text messages.*saved recovery code/) }))
      }
    } finally { configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' }) }
  })
})

describe('L1: a link or a code leaves the stored message once it is used, replaced or lapsed', () => {
  it('redacts the reset link when used, an earlier link when replaced, a recovery link when it lapses, and a confirmation code when used', async () => {
    const db = openDb(':memory:')
    const made = await signUpWithPassword(db, { handle: 'redacts', password: 'the account phrase here', displayName: 'R' }, META, T0)
    addAddress(db, sessionFor(db, made.session.token, T0 + 1000)!, 'email', 'redacts@gmail.com', T0 + 1000)
    const confirmMsg = lastTo(db, 'redacts@gmail.com')!.body
    const code = /page: (\d{6})/.exec(confirmMsg)![1]!
    confirmAddressByLink(db, linkIn(db, 'redacts@gmail.com', '/verify-email'), META.ip, T0 + 2000)
    const stored = () => db.all<{ body: string }>('SELECT body FROM outbound_messages').map((m) => m.body).join('\n')
    expect(stored()).not.toContain(code)
    db.run('UPDATE contact_points SET usable_from = ? WHERE address_key = ?', T0, 'redacts@gmail.com')
    requestPasswordReset(db, 'redacts', '198.18.8.1', T0 + 10_000)
    const first = linkIn(db, 'redacts@gmail.com', '/reset-password')
    requestPasswordReset(db, 'redacts', '198.18.8.1', T0 + 11_000)
    const second = linkIn(db, 'redacts@gmail.com', '/reset-password')
    expect(stored()).not.toContain(first)
    await resetPassword(db, { token: second, password: 'another long phrase ok', confirm: 'another long phrase ok' }, META.ip, T0 + 12_000)
    expect(stored()).not.toContain(second)
    requestRecoveryLink(db, 'redacts', '198.18.8.2', T0 + 13_000)
    const rec = linkIn(db, 'redacts@gmail.com', '/recover')
    recoveryTick(db, T0 + 13_000 + 2 * H)
    expect(stored()).not.toContain(rec)
  })
})

describe('L5: wrong proofs sent together are each counted', () => {
  it('eight wrong passwords sent at once leave the link dead after five, as one at a time would', async () => {
    const db = openDb(':memory:')
    const made = await signUpWithPassword(db, { handle: 'burst', password: 'the account phrase here', displayName: 'B' }, META, T0)
    confirmedEmail(db, sessionFor(db, made.session.token, T0 + 1000), 'burst@gmail.com', T0 + 1000)
    requestRecoveryLink(db, 'burst', '198.18.9.1', T0 + 10_000)
    const token = linkIn(db, 'burst@gmail.com', '/recover')
    const tries = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => startRecoveryFromLink(db, { token, password: `wrong phrase number ${i}` }, META.ip, T0 + 11_000 + i)))
    expect(tries.every((t) => t.status === 'rejected')).toBe(true)
    const row = db.get<{ attempts: number; replaced_at: number | null }>(`SELECT attempts, replaced_at FROM one_time_tokens WHERE purpose = 'recovery-email' AND person_id = ?`, made.personId)!
    expect(row.attempts).toBe(5)
    expect(row.replaced_at).not.toBeNull()
    await expect(startRecoveryFromLink(db, { token, password: 'the account phrase here' }, META.ip, T0 + 12_000)).rejects.toMatchObject({ code: 'link_replaced' })
    expect(RECOVERY_DELAY_MS).toBeGreaterThan(0)
  })
})

// The R13 security review's lead L-11 (docs/SECURITY-REVIEW-R13.md section 4); scripts/security.ts runs this by its check
// id and records it as one of its checks.
describe('R13 lead checks: a recovery by email is not hidden by one the backup path started', () => {
  it('R26 (L-11): with a recovery started by email under way, a backup one may start too, and the email one is still shown and finished with its own link and key', async () => {
    const db = openDb(':memory:')
    const made = await signUpWithPassword(db, { handle: 'twoways', password: 'the account phrase here', displayName: 'T' }, META, T0)
    confirmedEmail(db, sessionFor(db, made.session.token, T0 + 1000), 'twoways@gmail.com', T0 + 1000)
    requestRecoveryLink(db, 'twoways', '198.18.2.1', T0 + 10_000)
    const byEmail = await startRecoveryFromLink(db, { token: linkIn(db, 'twoways@gmail.com', '/recover'), code: made.recoveryCodes[0]! }, '198.18.2.1', T0 + 11_000)
    // the backup path with another saved code and the password, later: it opens its own (finished by its own reference)
    const byCodes = await startRecovery(db, { handle: 'twoways', code: made.recoveryCodes[1]!, password: 'the account phrase here' }, '198.18.2.2', T0 + 12_000)
    expect(count(db, 'SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', made.personId)).toBe(2)
    // when the email one's wait is over, a link shows it (not the newer backup one) and finishes it with its own key
    const after = Math.max(byEmail.availableAt, byCodes.availableAt) + 1
    requestRecoveryLink(db, 'twoways', '198.18.2.3', after)
    const token = linkIn(db, 'twoways@gmail.com', '/recover')
    expect(recoveryLinkState(db, token, after)).toMatchObject({ state: 'ready', requestId: byEmail.requestId })
    await expect(beginRecoveryFromLink(db, RP, { token, finishKey: byEmail.finishKey }, after)).resolves.toMatchObject({ challengeId: expect.any(String) })
  })
})
