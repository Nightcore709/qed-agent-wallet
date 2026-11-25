/**
 * R2 of the second review of the F1 fix (SECURITY.md 8k): the password-reset path recreated F1. A first passkey added
 * after a reset signs in only and brings no saved codes (a reset proves the mailbox, not the owner); once its approval
 * authority was restored by the wait, the account had one usable passkey and no codes, so whoever first opened a fresh
 * session with it (the owner, or someone holding a synced copy) could mint the H2 tie-breaker. Now the codes are made
 * when that passkey asks for its authority, shown once to the session that asked, kept usable for nothing until the
 * authority is restored (when they replace every earlier code), and lost with the request if it is stopped, whoever stops it.
 */
import { describe, expect, it } from 'vitest'
import { login, sessionFor, stepUp } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { configureDelivery } from './delivery.ts'
import {
  applyDueChanges, beginAddPasskey, beginLogin, beginSignup, finishAddPasskey, finishLogin, finishSignup, regenerateJustMadeCodes, regenerateRecoveryCodes,
  regenerateRecoveryCodesWithCode, type RelyingParty, savedCodeFor, securityView, signUpWithPassword,
} from './passkeys.ts'
import {
  addAddress, beginAuthorityRequest, cancelAuthorityRequest, confirmAddressByLink, contactCancel, finishAuthorityRequest, requestPasswordReset, resetPassword,
} from './recovery.ts'
import { SoftAuthenticator } from './softauthn.ts'

configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' })

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 26, 8, 0)
const PW = 'the first long phrase here', RESET = 'the phrase the reset set'
const device = () => new SoftAuthenticator({ origin: RP.origins[0]! })
const unused = (db: Db, id: string) => db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', id)!.n
const kinds = (db: Db, id: string) => db.all<{ kind: string; detail_json: string }>('SELECT kind, detail_json FROM security_events WHERE person_id = ? ORDER BY id', id)
const pendingSets = (db: Db) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM meta WHERE key LIKE 'pending-codes:%'`)!.n
function linkIn(db: Db, to: string, page: string): string {
  const body = db.get<{ body: string }>(`SELECT body FROM outbound_messages WHERE to_address = ? AND body LIKE ? ORDER BY rowid DESC LIMIT 1`, to, `%${page}#token=%`)?.body ?? ''
  return new RegExp(`${page}#token=([A-Za-z0-9_-]+)`).exec(body)![1]!
}
async function signIn(db: Db, auth: SoftAuthenticator, now: number): Promise<string> {
  const b = await beginLogin(db, RP, now)
  return (await finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never) }, META, now)).token
}
let resets = 0
/** The mailbox resets the password (a reset link from the outbox), and the new password is typed again. */
async function reset(db: Db, now: number): Promise<void> {
  requestPasswordReset(db, 'meera', `198.18.9.${++resets}`, now)
  await resetPassword(db, { token: linkIn(db, 'meera@gmail.com', '/reset-password'), password: RESET, confirm: RESET }, META.ip, now + 1)
}
/**
 * Meera's account: a password and a confirmed address (its delay written past, so it can start a reset); `earlier`: codes
 * that a holder of the password made before any device. The mailbox then resets the password, and the first passkey is
 * added with the reset password: it signs in only and brings no codes (R14).
 */
async function afterReset(db: Db, opts: { earlier: boolean }) {
  const made = await signUpWithPassword(db, { handle: 'meera', password: PW, displayName: 'Meera' }, META, T0)
  const s0 = sessionFor(db, made.session.token, T0)! // the sign-up's own password entry is fresh
  const early = opts.earlier ? regenerateRecoveryCodes(db, s0, T0) : []
  addAddress(db, s0, 'email', 'meera@gmail.com', T0)
  confirmAddressByLink(db, linkIn(db, 'meera@gmail.com', '/verify-email'), META.ip, T0 + 1)
  db.run('UPDATE contact_points SET usable_from = ? WHERE person_id = ?', T0 + 2, made.personId)
  await reset(db, T0 + 10)
  const n = await login(db, { handle: 'meera', password: RESET }, META, T0 + 30)
  await stepUp(db, sessionFor(db, n.token, T0 + 30)!, RESET, META.ip, T0 + 30)
  const typed = sessionFor(db, n.token, T0 + 40)!
  const auth = device()
  const b = await beginAddPasskey(db, RP, typed, T0 + 40)
  const cred = await finishAddPasskey(db, RP, typed, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META.ua, T0 + 40)
  return { id: made.personId, auth, cred, early }
}
/** The passkey that signs in only asks for approval authority, from a session it opens. */
async function ask(db: Db, auth: SoftAuthenticator, now: number) {
  const tok = await signIn(db, auth, now)
  const s = sessionFor(db, tok, now)!
  const b = await beginAuthorityRequest(db, RP, s, now)
  const r = await finishAuthorityRequest(db, RP, s, { challengeId: b.challengeId, response: auth.get(b.options as never) }, now)
  return { ...r, token: tok }
}
const refused = async (db: Db, id: string, codes: string[]) => { for (const c of codes) await expect(savedCodeFor(db, id, c, 'test it'), c).rejects.toMatchObject({ code: 'code_wrong' }) }

describe('R2: the passkey added after a password reset gets its codes with its request for authority', { timeout: 120_000 }, () => {
  it('they are shown once at the request, usable for nothing until the authority is restored, and then replace every earlier code', async () => {
    const db = openDb(':memory:')
    const a = await afterReset(db, { earlier: true })
    expect(a.cred).toMatchObject({ authority: 'signin', authority_reason: 'after-password-reset' })
    expect(a.cred.recoveryCodes).toBeUndefined()
    const T1 = T0 + 1000
    const r = await ask(db, a.auth, T1)
    expect(r.recoveryCodes).toHaveLength(10)
    expect(new Set(r.recoveryCodes).size).toBe(10)
    expect(r.recoveryCodes!.some((c) => a.early.includes(c))).toBe(false)
    // until the authority is restored the new set is none of the account's codes: every act that takes a code refuses it
    await refused(db, a.id, r.recoveryCodes!)
    expect(unused(db, a.id)).toBe(10) // the earlier set, still the account's
    await expect(savedCodeFor(db, a.id, a.early[0], 'test it')).resolves.toMatchObject({ id: expect.any(String) })
    // the screen says when the new set works
    const view = securityView(db, sessionFor(db, r.token, T1 + 1)!, T1 + 1) as { codesFrom: number | null }
    expect(view.codesFrom).toBe(r.effectiveAt)
    // the restoration makes them the account's codes, and every earlier one stops working
    expect(applyDueChanges(db, r.effectiveAt - 1)).toBe(0)
    await refused(db, a.id, r.recoveryCodes!.slice(0, 1))
    expect(applyDueChanges(db, r.effectiveAt)).toBe(1)
    expect(db.get('SELECT authority FROM webauthn_credentials WHERE id = ?', a.cred.id)).toEqual({ authority: 'full' })
    await refused(db, a.id, a.early)
    expect(unused(db, a.id)).toBe(10)
    await expect(savedCodeFor(db, a.id, r.recoveryCodes![0], 'test it')).resolves.toMatchObject({ id: expect.any(String) })
    expect(kinds(db, a.id).filter((e) => e.kind === 'recovery-codes-replaced').map((e) => JSON.parse(e.detail_json))).toEqual([{ reason: 'authority-restored' }])
    expect(pendingSets(db)).toBe(0)
    // the H2 rules apply as for any account: new codes need one of these, and one of these makes them
    const later = r.effectiveAt + 1000
    const s = sessionFor(db, await signIn(db, a.auth, later), later)!
    expect(() => regenerateRecoveryCodes(db, s, later)).toThrow(expect.objectContaining({ code: 'code_needed' }))
    expect(await regenerateRecoveryCodesWithCode(db, s, r.recoveryCodes![1], later)).toHaveLength(10)
  })

  it('REGRESSION R2: after a reset, the restoration and a fresh session, nobody can mint a set of their own', async () => {
    const db = openDb(':memory:')
    const a = await afterReset(db, { earlier: false })
    expect(unused(db, a.id)).toBe(0) // the precondition of the original F1: one passkey and no codes
    const r = await ask(db, a.auth, T0 + 1000)
    applyDueChanges(db, r.effectiveAt)
    expect(unused(db, a.id)).toBe(10)
    // the owner signs in, and so does someone holding a synced copy of the same passkey: two fresh sessions
    const later = r.effectiveAt + 1000
    for (const tok of [await signIn(db, a.auth, later), await signIn(db, a.auth, later + 1)]) {
      const s = sessionFor(db, tok, later + 2)!
      expect(s.stepUpFresh).toBe(true)
      expect(() => regenerateRecoveryCodes(db, s, later + 2)).toThrow(expect.objectContaining({ code: 'code_needed' }))
      await expect(regenerateRecoveryCodesWithCode(db, s, undefined, later + 2)).rejects.toMatchObject({ code: 'code_needed' })
      expect(() => regenerateJustMadeCodes(db, s, later + 2)).toThrow(expect.objectContaining({ code: 'codes_window_closed' }))
    }
    expect(unused(db, a.id)).toBe(10)
    await expect(savedCodeFor(db, a.id, r.recoveryCodes![2], 'test it')).resolves.toMatchObject({ id: expect.any(String) })
  })

  it('a request that is stopped takes its codes with it: by the passkey itself, by a recovery contact, by a second reset', async () => {
    const db = openDb(':memory:')
    const a = await afterReset(db, { earlier: false })
    // a recovery contact, named while the account still had a device it has since lost (written here; it cannot be named without one)
    const ravi = device()
    const rb = await beginSignup(db, RP, { handle: 'ravi', displayName: 'Ravi' }, '10.79.0.1', T0)
    const rv = await finishSignup(db, RP, { challengeId: rb.challengeId, response: ravi.create(rb.options as never) }, META, T0)
    db.run('INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?)', 'rcl_r2', a.id, rv.personId, T0, T0, T0)
    const stopped: string[] = []
    // 1. the passkey that asked stops its own request
    const first = await ask(db, a.auth, T0 + 1000)
    cancelAuthorityRequest(db, sessionFor(db, first.token, T0 + 1100)!, first.changeId, T0 + 1100)
    stopped.push(...first.recoveryCodes!)
    // 2. the recovery contact stops it
    const second = await ask(db, a.auth, T0 + 2000)
    contactCancel(db, sessionFor(db, await signIn(db, ravi, T0 + 2100), T0 + 2100)!, 'rcl_r2', T0 + 2100)
    stopped.push(...second.recoveryCodes!)
    // 3. the mailbox resets the password again
    const third = await ask(db, a.auth, T0 + 3000)
    await reset(db, T0 + 3100)
    stopped.push(...third.recoveryCodes!)
    for (const id of [first.changeId, second.changeId, third.changeId]) expect(db.get<{ cancelled_at: number | null }>('SELECT cancelled_at FROM scheduled_changes WHERE id = ?', id)!.cancelled_at).not.toBeNull()
    await refused(db, a.id, stopped)
    expect(unused(db, a.id)).toBe(0)
    // the next look at the account leaves none of them kept anywhere
    applyDueChanges(db, T0 + 3200)
    expect(pendingSets(db)).toBe(0)
    // asked once more and let through: only that last set works, never one from a request that was stopped
    const last = await ask(db, a.auth, T0 + 4000)
    expect(pendingSets(db)).toBe(1)
    applyDueChanges(db, last.effectiveAt)
    await refused(db, a.id, stopped)
    expect(unused(db, a.id)).toBe(10)
    await expect(savedCodeFor(db, a.id, last.recoveryCodes![0], 'test it')).resolves.toMatchObject({ id: expect.any(String) })
    expect(pendingSets(db)).toBe(0)
  })

  it('a passkey a recovery registered asks as before: no codes come with its request', async () => {
    const db = openDb(':memory:')
    const a = await afterReset(db, { earlier: false })
    db.run(`UPDATE webauthn_credentials SET authority_reason = 'recovery' WHERE id = ?`, a.cred.id)
    const r = await ask(db, a.auth, T0 + 1000)
    expect(r).not.toHaveProperty('recoveryCodes')
    expect(pendingSets(db)).toBe(0)
  })
})
