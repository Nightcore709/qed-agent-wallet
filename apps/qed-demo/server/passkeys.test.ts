import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { login, register, sessionFor, STEPUP_MS } from './auth.ts'
import { openDb } from './core.ts'
import {
  acceptContact, approvalChallenge, applyDueChanges, beginAddPasskey, beginLogin, beginRecoveryPasskey, beginReauth, beginSignup, cancelRecovery, COOL_OFF_MS,
  cancelScheduledChange, finishAddPasskey, finishLogin, finishReauth, finishRecoveryPasskey, finishSignup, issueContactCode, makeRecoveryCodes,
  nominateContact, PROTECTION_DELAY_MS, RECOVERY_DELAY_MS, relyingParty, type RelyingParty, removeContact, scheduleRemovePasskey,
  scheduleUnsuspend, securityView, startRecovery, suspendPasskey,
  regenerateRecoveryCodesWithCode, removePasskeyWithCode, suspendPasskeyWithCode, usableCredentials,
} from './passkeys.ts'
import { SoftAuthenticator } from './softauthn.ts'

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 20, 10, 0)

async function signup(db: ReturnType<typeof openDb>, handle = 'asha', now = T0) {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: 'Asha' }, META.ip, now)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META, now)
  // R14 (F1): the sign-up makes the account's saved codes with its first device, and returns them
  return { auth, ...r }
}
async function signin(db: ReturnType<typeof openDb>, auth: SoftAuthenticator, now: number, overrides: { origin?: string } = {}) {
  const b = await beginLogin(db, RP, now)
  return finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never, overrides) }, META, now)
}

describe('passkeys: sign-up and sign-in', () => {
  it('allows 20 new accounts an hour from one address and refuses the next until the hour has passed', async () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 20; i++) await beginSignup(db, RP, { handle: `person${i}x`, displayName: 'P' }, '203.0.113.7', T0 + i)
    await expect(beginSignup(db, RP, { handle: 'oneTooMany', displayName: 'P' }, '203.0.113.7', T0 + 30)).rejects.toMatchObject({ status: 429, code: 'too_many' })
    // another address is not affected, and the same one may again after the hour
    await beginSignup(db, RP, { handle: 'elsewhere', displayName: 'P' }, '198.51.100.9', T0 + 31)
    await beginSignup(db, RP, { handle: 'nexthour', displayName: 'P' }, '203.0.113.7', T0 + 3600_000)
  })

  it('creates an account only from a verified passkey, with no password and its own workspace; saved codes, once made, are ten and single-use in form', async () => {
    const db = openDb(':memory:')
    const { personId, recoveryCodes, session } = await signup(db)
    // R14 (F1): the ten are made with the first device, in the sign-up's own transaction (server/access-codes.test.ts)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ?', personId)!.n).toBe(10)
    expect(db.get<{ kind: string; pw_hash: string }>('SELECT kind, pw_hash FROM users WHERE id = ?', personId)).toEqual({ kind: 'person', pw_hash: '!' })
    expect(db.get('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ?', personId, personId)).toEqual({ role: 'owner' })
    expect(recoveryCodes).toHaveLength(10)
    expect(new Set(recoveryCodes).size).toBe(10)
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
    expect(sessionFor(db, session.token, T0)).toMatchObject({ userId: personId, stepUpFresh: true })
    // There is no password to guess: a password sign-in fails like any wrong password.
    await expect(login(db, { handle: 'asha', password: 'anything at all' }, META, T0)).rejects.toMatchObject({ code: 'bad_credentials' })
  })

  it('signs in with the passkey, and refuses another origin, a missing user verification and a replayed challenge', async () => {
    const db = openDb(':memory:')
    const { auth, personId } = await signup(db)
    const s = await signin(db, auth, T0 + 1000)
    expect(s.userId).toBe(personId)
    await expect(signin(db, auth, T0 + 2000, { origin: 'http://evil.example' })).rejects.toMatchObject({ code: 'passkey_failed' })
    const noUv = new SoftAuthenticator({ origin: RP.origins[0]!, userVerified: false })
    const b = await beginLogin(db, RP, T0 + 3000)
    await expect(finishLogin(db, RP, { challengeId: b.challengeId, response: noUv.get(b.options as never) }, META, T0 + 3000)).rejects.toMatchObject({ code: 'passkey_failed' })
    const again = await beginLogin(db, RP, T0 + 4000)
    const response = auth.get(again.options as never)
    await finishLogin(db, RP, { challengeId: again.challengeId, response }, META, T0 + 4000)
    await expect(finishLogin(db, RP, { challengeId: again.challengeId, response }, META, T0 + 4001)).rejects.toMatchObject({ code: 'passkey_failed' })
  })

  it('accepts only ES256 keys, because the same key must verify on chain', async () => {
    const db = openDb(':memory:')
    const b = await beginSignup(db, RP, { handle: 'ravi' }, META.ip, T0)
    expect((b.options as { pubKeyCredParams: { alg: number }[] }).pubKeyCredParams.map((p) => p.alg)).toEqual([-7])
    expect((b.options as { authenticatorSelection: { userVerification: string; residentKey: string } }).authenticatorSelection).toMatchObject({ userVerification: 'required', residentKey: 'required' })
  })
})

describe('passkeys: approving exact terms', () => {
  it('a signature over the terms of one approval cannot confirm another, and the challenge is the hash of id and terms', async () => {
    const db = openDb(':memory:')
    const { auth, session } = await signup(db)
    const s = sessionFor(db, session.token, T0)!
    const a = approvalChallenge('apr_1', 'sha256:aaaa'), b = approvalChallenge('apr_2', 'sha256:aaaa')
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(Buffer.from(a).equals(Buffer.from(approvalChallenge('apr_1', 'sha256:aaab')))).toBe(false)
    const first = await beginReauth(db, RP, s.userId, 'approval', a, { approvalId: 'apr_1' }, T0)
    const second = await beginReauth(db, RP, s.userId, 'approval', b, { approvalId: 'apr_2' }, T0)
    const signedFirst = auth.get(first.options as never)
    // presented under the second approval's challenge id: the signed challenge does not match
    await expect(finishReauth(db, RP, s, 'approval', { challengeId: second.challengeId, response: signedFirst }, T0)).rejects.toMatchObject({ code: 'passkey_failed' })
    const ok = await finishReauth(db, RP, s, 'approval', { challengeId: first.challengeId, response: signedFirst }, T0)
    expect(ok.context).toEqual({ approvalId: 'apr_1' })
    expect(Buffer.from(ok.challenge, 'base64url').equals(Buffer.from(a))).toBe(true)
  })

  it('an assertion made to approve a document does not refresh the session\'s re-authentication; a step-up does (claims review F1)', async () => {
    const db = openDb(':memory:')
    const asha = await signup(db, 'asha')
    const later = T0 + STEPUP_MS + 60_000
    const s = sessionFor(db, asha.session.token, later)!
    expect(s.stepUpFresh).toBe(false)
    const c = await beginReauth(db, RP, s.userId, 'approval', approvalChallenge('apr_1', 'sha256:x'), {}, later)
    await finishReauth(db, RP, s, 'approval', { challengeId: c.challengeId, response: asha.auth.get(c.options as never) }, later)
    expect(sessionFor(db, asha.session.token, later + 1000)!.stepUpFresh).toBe(false)
    const st = await beginReauth(db, RP, s.userId, 'stepup', null, {}, later + 2000)
    await finishReauth(db, RP, s, 'stepup', { challengeId: st.challengeId, response: asha.auth.get(st.options as never) }, later + 2000)
    expect(sessionFor(db, asha.session.token, later + 3000)!.stepUpFresh).toBe(true)
  })

  it('a passkey of another person cannot approve in this session', async () => {
    const db = openDb(':memory:')
    const asha = await signup(db, 'asha')
    const ravi = await signup(db, 'ravi')
    const s = sessionFor(db, asha.session.token, T0)!
    const c = await beginReauth(db, RP, s.userId, 'approval', approvalChallenge('apr_1', 'sha256:x'), {}, T0)
    await expect(finishReauth(db, RP, s, 'approval', { challengeId: c.challengeId, response: ravi.auth.get(c.options as never) }, T0)).rejects.toMatchObject({ code: 'passkey_failed' })
  })
})

/** Ravi becomes Asha's recovery contact: Asha names him with a fresh passkey confirmation, and he accepts. */
async function withContact(db: ReturnType<typeof openDb>, now = T0) {
  const asha = await signup(db, 'asha', now)
  const ravi = await signup(db, 'ravi', now)
  const { linkId, effectiveAt } = nominateContact(db, sessionFor(db, asha.session.token, now)!, 'ravi', now)
  acceptContact(db, sessionFor(db, ravi.session.token, now)!, linkId, now)
  return { asha, ravi, linkId, effectiveAt }
}
/** Ravi signs in and, with that fresh passkey confirmation, issues a code for Asha's recovery. */
async function contactCode(db: ReturnType<typeof openDb>, ravi: Awaited<ReturnType<typeof signup>>, linkId: string, now: number) {
  const rs = await signin(db, ravi.auth, now)
  return issueContactCode(db, sessionFor(db, rs.token, now)!, linkId, now)
}
const requests = (db: ReturnType<typeof openDb>) => db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_requests')?.n
const eventsOf = (db: ReturnType<typeof openDb>, handle: string) => db.all<{ kind: string }>('SELECT e.kind FROM security_events e JOIN users u ON u.id = e.person_id WHERE u.handle = ? ORDER BY e.id', handle).map((e) => e.kind)

describe('passkeys: recovery at AAL2 needs two codes from different methods (NIST SP 800-63B-4 §4.2.2.2)', () => {
  it('a saved code alone starts nothing; a saved code with a code from an active contact starts a delayed recovery that the owner can cancel', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId, effectiveAt } = await withContact(db)
    // before the protection delay has passed, the contact cannot issue anything
    await expect(contactCode(db, ravi, linkId, T0 + 1000)).rejects.toMatchObject({ code: 'contact_inactive' })
    const t = effectiveAt + 1
    const { code: issued } = await contactCode(db, ravi, linkId, t)
    expect(eventsOf(db, 'asha')).toContain('contact-issued-recovery-code')
    const saved = asha.recoveryCodes
    // one saved code alone, a wrong contact code, and an unknown handle all look the same and record nothing
    const alone = await startRecovery(db, { handle: 'asha', code: saved[0] }, META.ip, t)
    const wrongSecond = await startRecovery(db, { handle: 'asha', code: saved[0], contactCode: 'AAAA-AAAA-AAAA-AAAA' }, META.ip, t)
    const nobody = await startRecovery(db, { handle: 'nobody', code: saved[0], contactCode: issued }, META.ip, t)
    for (const x of [wrongSecond, nobody]) expect(Object.keys(x)).toEqual(Object.keys(alone))
    expect(requests(db)).toBe(0)
    // nothing was used up by the failed attempts
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM recovery_codes c JOIN users u ON u.id = c.person_id WHERE u.handle = 'asha' AND c.used_at IS NULL AND c.replaced_at IS NULL`)?.n).toBe(10)
    // both codes, written any way round in case and dashes: a recovery starts, and both codes are spent
    const r = await startRecovery(db, { handle: 'asha', code: saved[0]!.toLowerCase().replace(/-/g, ''), contactCode: issued.toLowerCase() }, META.ip, t)
    expect(r.availableAt).toBe(t + RECOVERY_DELAY_MS)
    expect(db.get('SELECT method FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ method: 'saved+contact' })
    expect(eventsOf(db, 'ravi')).toContain('contact-recovery-started')
    await expect(beginRecoveryPasskey(db, RP, r.reference, t + 1000)).rejects.toMatchObject({ code: 'recovery_waiting' })
    const reuse = await startRecovery(db, { handle: 'asha', code: saved[0], contactCode: issued }, META.ip, t + 2000)
    expect(db.get('SELECT 1 FROM recovery_requests WHERE id = ?', reuse.requestId)).toBeUndefined()
    // the owner, signed in on a device that still has the passkey, sees it and cancels it; the contact is told
    const s = sessionFor(db, (await signin(db, asha.auth, t + 3000)).token, t + 3000)!
    expect((securityView(db, s, t + 3000) as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('recovery-started')
    const out = cancelRecovery(db, s, r.requestId, t + 3000)
    // H2 (re-check): the code the recovery used stays spent, and no new set is handed to the session that cancels (a
    // thief holding a device would be given it); the person is told to make new codes, which needs one of the others
    expect(out).toEqual({ codes: [], codeSpent: true })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', asha.personId)?.n).toBe(9)
    expect(eventsOf(db, 'ravi')).toContain('contact-recovery-cancelled')
    await expect(beginRecoveryPasskey(db, RP, r.reference, t + RECOVERY_DELAY_MS + 1)).rejects.toMatchObject({ code: 'recovery_unavailable' })
  })

  it('a recovery left alone completes after the delay with a new passkey, and replaces every saved code with a new set', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId, effectiveAt } = await withContact(db)
    const t = effectiveAt + 1
    const { code } = await contactCode(db, ravi, linkId, t)
    const r = await startRecovery(db, { handle: 'asha', code: asha.recoveryCodes[1], contactCode: code }, META.ip, t)
    const later = t + RECOVERY_DELAY_MS
    const fresh = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginRecoveryPasskey(db, RP, r.reference, later)
    const done = await finishRecoveryPasskey(db, RP, { challengeId: b.challengeId, response: fresh.create(b.options as never) }, META, later)
    expect(done.session.userId).toBe(asha.personId)
    expect(done.recoveryCodes).toHaveLength(10)
    // the old codes no longer work; the new ones are stored with scrypt, one salt for the batch
    const live = db.all<{ algo: string; salt: string }>('SELECT algo, salt FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', asha.personId)
    expect(live).toHaveLength(10)
    expect(new Set(live.map((x) => x.algo))).toEqual(new Set(['scrypt']))
    expect(new Set(live.map((x) => x.salt)).size).toBe(1)
    expect(eventsOf(db, 'asha')).toEqual(expect.arrayContaining(['recovery-completed', 'recovery-codes-replaced']))
    expect(eventsOf(db, 'ravi')).toContain('contact-recovery-completed')
    await expect(beginRecoveryPasskey(db, RP, r.reference, later + 1)).rejects.toMatchObject({ code: 'recovery_unavailable' })
    expect((await signin(db, fresh, later + 2)).userId).toBe(asha.personId)
  })

  it('a contact code is replaced by a newer one, lapses after a day, and stops working when the contact steps down', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId, effectiveAt } = await withContact(db)
    const t = effectiveAt + 1
    const first = (await contactCode(db, ravi, linkId, t)).code
    const second = (await contactCode(db, ravi, linkId, t + 1)).code
    await startRecovery(db, { handle: 'asha', code: asha.recoveryCodes[0], contactCode: first }, META.ip, t + 2)
    expect(requests(db)).toBe(0)
    await startRecovery(db, { handle: 'asha', code: asha.recoveryCodes[0], contactCode: second }, META.ip, t + 24 * 3600_000 + 2)
    expect(requests(db)).toBe(0)
    const third = (await contactCode(db, ravi, linkId, t + 24 * 3600_000 + 3)).code
    removeContact(db, sessionFor(db, (await signin(db, ravi.auth, t + 24 * 3600_000 + 4)).token, t + 24 * 3600_000 + 4)!, linkId, t + 24 * 3600_000 + 4)
    await startRecovery(db, { handle: 'asha', code: asha.recoveryCodes[0], contactCode: third }, META.ip, t + 24 * 3600_000 + 5)
    expect(requests(db)).toBe(0)
    expect(eventsOf(db, 'asha')).toContain('recovery-contact-ended')
  })

  it('naming a contact needs a fresh passkey confirmation, someone else who exists, their acceptance and the protection delay', async () => {
    const db = openDb(':memory:')
    const asha = await signup(db, 'asha')
    await signup(db, 'ravi')
    const stale = sessionFor(db, asha.session.token, T0 + STEPUP_MS + 1)!
    expect(() => nominateContact(db, stale, 'ravi', T0 + STEPUP_MS + 1)).toThrow(/Confirm with one of your passkeys/)
    const s = sessionFor(db, asha.session.token, T0)!
    expect(() => nominateContact(db, s, 'asha', T0)).toThrow(/highlighted/)
    expect(() => nominateContact(db, s, 'nobody', T0)).toThrow(/highlighted/)
    const { linkId, effectiveAt } = nominateContact(db, s, '@Ravi', T0)
    expect(effectiveAt).toBe(T0 + PROTECTION_DELAY_MS)
    const view = (at: number) => securityView(db, sessionFor(db, asha.session.token, Math.min(at, T0 + 1))!, at) as { contacts: { active: boolean }[]; secondMethod: { contacts: number; password: boolean } }
    expect(view(T0)).toMatchObject({ contacts: [{ active: false }], secondMethod: { contacts: 0, password: false } })
    const ravi = db.get<{ id: string }>(`SELECT id FROM users WHERE handle = 'ravi'`)!
    expect(db.get('SELECT accepted_at FROM recovery_contacts WHERE id = ? AND contact_id = ?', linkId, ravi.id)).toEqual({ accepted_at: null })
    expect(view(effectiveAt + 1).secondMethod.contacts).toBe(0) // not accepted yet
  })

  it('an account made before passkeys may use its password as the second proof', async () => {
    const db = openDb(':memory:')
    const id = await register(db, { handle: 'old', password: 'a long legacy password' }, META.ip, T0)
    const codes = makeRecoveryCodes(db, id, T0)
    await startRecovery(db, { handle: 'old', code: codes[0], password: 'not the password' }, META.ip, T0)
    expect(requests(db)).toBe(0)
    const r = await startRecovery(db, { handle: 'old', code: codes[0], password: 'a long legacy password' }, META.ip, T0 + 1)
    expect(db.get('SELECT method FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ method: 'saved+password' })
  })

  it('codes made before v3 (salted SHA-256) still verify until they are used or replaced', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId, effectiveAt } = await withContact(db)
    const salt = 'abcdef0123456789'
    db.run(`INSERT INTO recovery_codes (id, person_id, salt, code_hash, created_at, algo) VALUES ('rcv_legacy', ?, ?, ?, ?, 'sha256')`, asha.personId, salt, createHash('sha256').update(`${salt}:LEGACY2CODE3ABCD`).digest('hex'), T0)
    const { code } = await contactCode(db, ravi, linkId, effectiveAt + 1)
    const r = await startRecovery(db, { handle: 'asha', code: 'LEGA-CY2C-ODE3-ABCD', contactCode: code }, META.ip, effectiveAt + 2)
    expect(db.get('SELECT code_id FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ code_id: 'rcv_legacy' })
  })
})

describe('passkeys: a suspected passkey is suspended at once (§4.3)', () => {
  it('another passkey suspends it: it cannot sign in, its sessions end, what it scheduled is cancelled; allowing it again waits', async () => {
    const db = openDb(':memory:')
    const { auth: laptop, session, personId } = await signup(db)
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
    const s0 = sessionFor(db, session.token, T0)!
    const add = await beginAddPasskey(db, RP, s0, T0)
    await finishAddPasskey(db, RP, s0, { challengeId: add.challengeId, response: phone.create(add.options as never), passkeyName: 'Phone' }, META.ua, T0)
    // in its first 24 hours the phone's passkey cannot schedule the removal of an older one (its cool-off, RISK-068)
    const early = await signin(db, phone, T0 + 1000)
    expect(() => scheduleRemovePasskey(db, sessionFor(db, early.token, T0 + 1000)!, laptop.id, T0 + 1000)).toThrow(/cannot remove another passkey/)
    // after it, the phone is stolen: its holder schedules removal of the laptop's passkey
    const C = T0 + COOL_OFF_MS
    const thief = await signin(db, phone, C + 1000)
    const laptopId = laptop.id
    const removal = scheduleRemovePasskey(db, sessionFor(db, thief.token, C + 1000)!, laptopId, C + 1000)
    // the owner, on the laptop, suspends the phone's passkey
    const owner = sessionFor(db, (await signin(db, laptop, C + 2000)).token, C + 2000)!
    expect(() => suspendPasskey(db, owner, laptopId, C + 2000)).toThrow(/opened with that passkey/)
    suspendPasskey(db, owner, phone.id, C + 2000, unusedCodeId(db, owner.userId))
    expect(sessionFor(db, thief.token, C + 2001)).toBeNull()
    await expect(signin(db, phone, C + 2002)).rejects.toMatchObject({ code: 'passkey_failed' })
    expect(applyDueChanges(db, removal.effectiveAt + 1)).toBe(0)
    expect((await signin(db, laptop, removal.effectiveAt + 2)).userId).toBe(personId)
    // allowing the phone again is a change that restores authority: it waits out the delay
    const again = sessionFor(db, (await signin(db, laptop, removal.effectiveAt + 3)).token, removal.effectiveAt + 3)!
    const un = scheduleUnsuspend(db, again, phone.id, removal.effectiveAt + 3)
    await expect(signin(db, phone, removal.effectiveAt + 4)).rejects.toMatchObject({ code: 'passkey_failed' })
    expect(applyDueChanges(db, un.effectiveAt + 1)).toBe(1)
    expect((await signin(db, phone, un.effectiveAt + 2)).userId).toBe(personId)
  })

  it('accepts the development server origin only when it is named', () => {
    expect(relyingParty({ apiPort: 5175 }, {}).origins).toEqual(['http://localhost:5175'])
    expect(relyingParty({ apiPort: 5175 }, { QED_WEB_PORT: '5174' }).origins).toEqual(['http://localhost:5175', 'http://localhost:5174'])
  })
})

describe('passkeys: removing one waits, and another can cancel it', () => {
  it('cannot remove the last passkey; a scheduled removal keeps the passkey working until it applies, and ends its sessions', async () => {
    const db = openDb(':memory:')
    const { auth, session, personId } = await signup(db)
    let s = sessionFor(db, session.token, T0)!
    const first = db.get<{ id: string }>('SELECT id FROM webauthn_credentials WHERE person_id = ?', personId)!.id
    expect(() => scheduleRemovePasskey(db, s, first, T0)).toThrow(/only usable passkey/)
    // adding a second passkey needs a fresh re-authentication
    const stale = sessionFor(db, session.token, T0 + STEPUP_MS + 1000)!
    await expect(beginAddPasskey(db, RP, stale, T0 + STEPUP_MS + 1000)).rejects.toMatchObject({ code: 'stepup_required' })
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
    const add = await beginAddPasskey(db, RP, s, T0)
    await finishAddPasskey(db, RP, s, { challengeId: add.challengeId, response: phone.create(add.options as never), passkeyName: 'Phone' }, META.ua, T0)

    // past the phone's cool-off (in it, it could not ask: see the cool-off tests), the phone schedules the first's removal
    const C = T0 + COOL_OFF_MS
    const phoneSession = await signin(db, phone, C + 1000)
    s = sessionFor(db, phoneSession.token, C + 1000)!
    const { changeId, effectiveAt } = scheduleRemovePasskey(db, s, first, C + 1000)
    expect(effectiveAt).toBe(C + 1000 + PROTECTION_DELAY_MS)
    // still works during the delay, and from it the owner cancels the removal
    const laptop = await signin(db, auth, C + 2000)
    const ls = sessionFor(db, laptop.token, C + 2000)!
    cancelScheduledChange(db, ls, changeId!, C + 2000)
    expect(applyDueChanges(db, effectiveAt + 1)).toBe(0)
    expect((await signin(db, auth, effectiveAt + 2)).userId).toBe(personId)

    // scheduled again and left alone: it applies, and the laptop's sessions end
    // sessions end after twelve idle hours; sign in on the phone again first
    const phoneAgain = await signin(db, phone, effectiveAt + 3)
    const laptopAgain = await signin(db, auth, effectiveAt + 3)
    const again = scheduleRemovePasskey(db, sessionFor(db, phoneAgain.token, effectiveAt + 3)!, first, effectiveAt + 3)
    expect(applyDueChanges(db, again.effectiveAt + 1)).toBe(1)
    expect(sessionFor(db, laptopAgain.token, again.effectiveAt + 2)).toBeNull()
    // the phone's passkey is untouched (its session simply idled out over the delay)
    expect(db.get<{ removed_at: number | null }>('SELECT removed_at FROM webauthn_credentials WHERE id = ?', phone.id)?.removed_at).toBeNull()
    expect((await signin(db, phone, again.effectiveAt + 4)).userId).toBe(personId)
    await expect(signin(db, auth, again.effectiveAt + 3)).rejects.toMatchObject({ code: 'passkey_failed' })
  })
})

describe('independent review of the R13 fixes, H2: one passkey cannot make itself the only usable one, nor replace the codes, without a saved code', () => {
  it('a thief holding one of two passkeys can neither suspend the other nor make new codes; the owner can, spending a saved code once', async () => {
    const db = openDb(':memory:')
    const { auth: laptop, session, personId } = await signup(db)
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
    const s0 = sessionFor(db, session.token, T0)!
    const add = await beginAddPasskey(db, RP, s0, T0)
    await finishAddPasskey(db, RP, s0, { challengeId: add.challengeId, response: phone.create(add.options as never), passkeyName: 'Phone' }, META.ua, T0)
    const codes = makeRecoveryCodes(db, personId, T0)
    const C = T0 + COOL_OFF_MS
    // the phone is stolen and unlocked: its holder confirms with it, past its cool-off
    const thief = sessionFor(db, (await signin(db, phone, C + 1000)).token, C + 1000)!
    await expect(suspendPasskeyWithCode(db, thief, laptop.id, undefined, C + 1000)).rejects.toMatchObject({ code: 'code_needed' })
    await expect(suspendPasskeyWithCode(db, thief, laptop.id, 'ABCD-EFGH-JKLM', C + 1000)).rejects.toMatchObject({ code: 'code_wrong' })
    expect(() => suspendPasskey(db, thief, laptop.id, C + 1000)).toThrow(/saved recovery codes/) // the direct call refuses too
    await expect(regenerateRecoveryCodesWithCode(db, thief, undefined, C + 1000)).rejects.toMatchObject({ code: 'code_needed' })
    expect(usableCredentials(db, personId)).toHaveLength(2)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', personId)!.n).toBe(10)
    // the owner, on the laptop, with one of the printed codes: the phone is suspended at once and the code is spent
    const owner = sessionFor(db, (await signin(db, laptop, C + 2000)).token, C + 2000)!
    await suspendPasskeyWithCode(db, owner, phone.id, codes[0], C + 2000)
    expect(usableCredentials(db, personId).map((c) => c.id)).toEqual([laptop.id])
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', personId)!.n).toBe(1)
    // a spent code proves nothing again; another one makes new codes
    await expect(regenerateRecoveryCodesWithCode(db, owner, codes[0], C + 2100)).rejects.toMatchObject({ code: 'code_wrong' })
    expect(await regenerateRecoveryCodesWithCode(db, owner, codes[1], C + 2100)).toHaveLength(10)
  })
  it('a passkey in its cool-off is removed at once only with a saved code; without one its removal is scheduled and can be cancelled', async () => {
    const db = openDb(':memory:')
    const { auth: laptop, session, personId } = await signup(db)
    const s0 = sessionFor(db, session.token, T0)!
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! }), tablet = new SoftAuthenticator({ origin: RP.origins[0]! })
    for (const [a, name] of [[phone, 'Phone'], [tablet, 'Tablet']] as const) {
      const add = await beginAddPasskey(db, RP, s0, T0 + 1000) // added after the laptop, so the laptop is the older one
      await finishAddPasskey(db, RP, s0, { challengeId: add.challengeId, response: a.create(add.options as never), passkeyName: name }, META.ua, T0 + 1000)
    }
    const codes = makeRecoveryCodes(db, personId, T0)
    const owner = sessionFor(db, (await signin(db, laptop, T0 + 2000)).token, T0 + 2000)!
    const scheduled = await removePasskeyWithCode(db, owner, phone.id, undefined, T0 + 2000)
    expect(scheduled.removed).toBeUndefined()
    expect(scheduled.changeId).not.toBeNull()
    expect(usableCredentials(db, personId).map((c) => c.id)).toContain(phone.id)
    await expect(removePasskeyWithCode(db, owner, tablet.id, 'ABCD-EFGH-JKLM', T0 + 2000)).rejects.toMatchObject({ code: 'code_wrong' })
    expect(await removePasskeyWithCode(db, owner, tablet.id, codes[2], T0 + 2000)).toMatchObject({ removed: true, changeId: null })
    expect(usableCredentials(db, personId).map((c) => c.id)).not.toContain(tablet.id)
  })
  it('with three usable passkeys a suspension still needs a code (a thief could add one first); with no unused codes, new codes wait until one passkey is left', async () => {
    const db = openDb(':memory:')
    const { auth: laptop, session, personId } = await signup(db)
    const s0 = sessionFor(db, session.token, T0)!
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! }), tablet = new SoftAuthenticator({ origin: RP.origins[0]! })
    for (const [a, name] of [[phone, 'Phone'], [tablet, 'Tablet']] as const) {
      const add = await beginAddPasskey(db, RP, s0, T0)
      await finishAddPasskey(db, RP, s0, { challengeId: add.challengeId, response: a.create(add.options as never), passkeyName: name }, META.ua, T0)
    }
    const C = T0 + COOL_OFF_MS
    const owner = sessionFor(db, (await signin(db, laptop, C + 1000)).token, C + 1000)!
    await expect(suspendPasskeyWithCode(db, owner, tablet.id, undefined, C + 1000)).rejects.toMatchObject({ code: 'code_needed' })
    const codes = makeRecoveryCodes(db, personId, C + 1000)
    await suspendPasskeyWithCode(db, owner, tablet.id, codes[0], C + 1000)
    expect(usableCredentials(db, personId)).toHaveLength(2)
    db.run('UPDATE recovery_codes SET used_at = ? WHERE person_id = ? AND used_at IS NULL', C, personId)
    await expect(regenerateRecoveryCodesWithCode(db, owner, undefined, C + 1500)).rejects.toMatchObject({ code: 'codes_none' })
  })
})

