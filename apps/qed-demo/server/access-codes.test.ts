/**
 * Saved recovery codes and the first device (R14, Priority 1; independent review F1).
 *
 * Saved codes are what tells two holders of one person's devices apart (H2, SECURITY.md 8j): suspending another passkey,
 * replacing codes and removing a passkey at once each need an unused one. R14 first made them optional, so the first
 * holder of a device could mint the tie-breaker and lock the owner out. So now the account's codes are made in the same
 * transaction as its FIRST device, whichever way that comes: sign-up with a passkey, the first passkey of an account opened
 * with an address, a password or Google, and the one made inside the wallet's set-up. They are shown once to that session.
 * No forced step follows (no checkbox). A second device and a completed recovery make none, as before R14.
 */
import { describe, expect, it } from 'vitest'
import { signUpWithEmail } from './access.ts'
import { configureDelivery } from './delivery.ts'
import { beginRecoveryFromLink, confirmAddressByLink, finishRecoveryFromLink, recoveryTick, requestRecoveryLink, startRecoveryFromLink } from './recovery.ts'
import { sessionFor } from './auth.ts'
import { type Db, openDb } from './core.ts'
import {
  beginAddPasskey, beginLogin, beginSignup, finishAddPasskey, finishLogin, finishSignup, regenerateRecoveryCodes, JUST_MADE_WINDOW_MS, PROTECTION_DELAY_MS, regenerateJustMadeCodes, regenerateRecoveryCodesWithCode, type RelyingParty, signUpWithPassword,
  suspendPasskeyWithCode, usableCredentials,
} from './passkeys.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 25, 10, 0)
const PW = 'a long and private phrase 7'
const unused = (db: Db, id: string): number => db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', id)!.n
const device = (): SoftAuthenticator => new SoftAuthenticator({ origin: RP.origins[0]! })

async function passkeyAccount(db: Db, handle = 'asha') {
  const auth = device()
  const b = await beginSignup(db, RP, { handle, displayName: 'Asha' }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META, T0)
  return { auth, ...r }
}
/** A second session of the same credential, as a thief with a synced passkey (or the same passkey on a second machine) opens. */
async function signInAgain(db: Db, auth: SoftAuthenticator, now: number): Promise<string> {
  const b = await beginLogin(db, RP, now)
  return (await finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never) }, META, now)).token
}
async function add(db: Db, token: string, now: number, name = 'Second device') {
  const s = sessionFor(db, token, now)!
  const b = await beginAddPasskey(db, RP, s, now)
  return finishAddPasskey(db, RP, s, { challengeId: b.challengeId, response: device().create(b.options as never), passkeyName: name }, META.ua, now)
}

describe('the account\'s codes are made with its first device, in the same change (F1)', () => {
  it('sign-up with a passkey makes ten and shows them once; an address or a password alone makes none, there being no device yet', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    expect(a.recoveryCodes).toHaveLength(10)
    expect(unused(db, a.personId)).toBe(10)
    const b = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    const c = await signUpWithEmail(db, { email: 'c@example.in', password: PW }, META, T0)
    for (const r of [b, c]) { expect(unused(db, r.personId)).toBe(0); expect(r).not.toHaveProperty('recoveryCodes') }
  }, 60_000)

  it('the first passkey of an address or password account brings the codes, with no cool-off, in the same change', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const cred = await add(db, r.session.token, T0 + 1000, 'First device')
    expect(cred.recoveryCodes).toHaveLength(10)
    expect(new Set(cred.recoveryCodes).size).toBe(10)
    expect(unused(db, r.personId)).toBe(10)
    expect(cred.cool_off_until ?? null).toBeNull()
    expect(db.get(`SELECT detail_json FROM security_events WHERE person_id = ? AND kind = 'recovery-codes-made'`, r.personId)).toEqual({ detail_json: JSON.stringify({ reason: 'first-device' }) })
    for (const row of db.all<{ code_hash: string; algo: string }>('SELECT code_hash, algo FROM recovery_codes WHERE person_id = ?', r.personId)) { expect(row.algo).toBe('scrypt'); expect(cred.recoveryCodes).not.toContain(row.code_hash) }
  }, 60_000)

  it('the first passkey with a handle-and-password account (the one made inside the wallet set-up) brings them too', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    const cred = await add(db, r.session.token, T0 + 1000, 'First device')
    expect(cred.recoveryCodes).toHaveLength(10)
    expect(unused(db, r.personId)).toBe(10)
  }, 60_000)

  it('the codes and the first device are one change: a registration that fails leaves neither', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    const b = await beginAddPasskey(db, RP, s, T0 + 1000)
    const other = new SoftAuthenticator({ origin: 'http://evil.example' })
    await expect(finishAddPasskey(db, RP, s, { challengeId: b.challengeId, response: other.create(b.options as never) }, META.ua, T0 + 1000)).rejects.toMatchObject({ code: 'passkey_failed' })
    expect(unused(db, r.personId)).toBe(0)
    expect(usableCredentials(db, r.personId)).toHaveLength(0)
  }, 60_000)

  it('a first passkey added after a password reset signs in only and gets no codes: a reset proves the mailbox, not the owner', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    db.run('UPDATE users SET authority_hold_at = ? WHERE id = ?', T0 + 500, r.personId)
    const cred = await add(db, r.session.token, T0 + 1000, 'First device')
    expect(cred.recoveryCodes).toBeUndefined()
    expect(unused(db, r.personId)).toBe(0)
  }, 60_000)
})

describe('a second device makes none, and the H2 rules hold (F1)', () => {
  it('an account that holds codes keeps them: a second device makes none and replaces none', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    const before = db.all('SELECT id, code_hash FROM recovery_codes WHERE person_id = ? ORDER BY id', a.personId)
    const cred = await add(db, a.session.token, T0 + 1000)
    expect(cred.recoveryCodes).toBeUndefined()
    expect(db.all('SELECT id, code_hash FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL ORDER BY id', a.personId)).toEqual(before)
  }, 60_000)

  it('REGRESSION F1: one passkey held by two people. The second holder gets no codes and cannot suspend the other or lock the owner out while the account\'s codes exist', async () => {
    const db = openDb(':memory:')
    const owner = await passkeyAccount(db)               // the owner holds the codes, shown once at sign-up
    // the thief holds the same credential (a synced passkey): a second session the same passkey signs in
    const stolen = await signInAgain(db, owner.auth, T0 + 1000)
    const thief = sessionFor(db, stolen, T0 + 1000)!
    // new codes while unused ones remain need one of them; he has none
    await expect(regenerateRecoveryCodesWithCode(db, thief, undefined, T0 + 1000)).rejects.toMatchObject({ code: 'code_needed' })
    expect(() => regenerateRecoveryCodes(db, thief, T0 + 1000)).toThrow(/saved recovery code/)
    // a second passkey of his own brings him no codes (he is no longer the "only usable passkey" minting the tie-breaker)
    const hisKey = await add(db, stolen, T0 + 2000, 'Thief device')
    expect(hisKey.recoveryCodes).toBeUndefined()
    expect(unused(db, owner.personId)).toBe(10)
    // and he cannot suspend the owner's passkey: that needs a code, and a code he does not have
    const hers = usableCredentials(db, owner.personId).find((c) => c.id !== hisKey.id)!
    const asHis = sessionFor(db, stolen, T0 + 3000)!
    await expect(suspendPasskeyWithCode(db, { ...asHis, credentialId: hisKey.id }, hers.id, undefined, T0 + 3000)).rejects.toMatchObject({ code: 'code_needed' })
    await expect(suspendPasskeyWithCode(db, { ...asHis, credentialId: hisKey.id }, hers.id, 'AAAA-BBBB-CCCC-DDDD', T0 + 3000)).rejects.toMatchObject({ code: 'code_wrong' })
    expect(usableCredentials(db, owner.personId)).toHaveLength(2)
    // the owner, with a code, can suspend his
    const s = sessionFor(db, owner.session.token, T0 + 4000)!
    await suspendPasskeyWithCode(db, s, hisKey.id, owner.recoveryCodes[0], T0 + 4000)
    expect(usableCredentials(db, owner.personId)).toHaveLength(1)
  }, 60_000)

  it('with two usable passkeys and no unused code (an older account that spent them), no path makes codes at once: a third device makes none', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    await add(db, a.session.token, T0 + 1000)
    db.run('UPDATE recovery_codes SET used_at = ? WHERE person_id = ?', T0 + 1500, a.personId)
    const third = await add(db, a.session.token, T0 + 2000, 'Third device')
    expect(third.recoveryCodes).toBeUndefined()
    expect(unused(db, a.personId)).toBe(0)
    expect(() => regenerateRecoveryCodes(db, sessionFor(db, a.session.token, T0 + 3000)!, T0 + 3000)).toThrow(/more than one usable passkey/)
  }, 60_000)

  it('a session opened with a password never adds a second device, so it is never shown the codes', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    await add(db, r.session.token, T0 + 1000, 'First device')
    // the password session's freshness is still inside its five minutes; it unlocked the first device only
    await expect(beginAddPasskey(db, RP, sessionFor(db, r.session.token, T0 + 2000)!, T0 + 2000)).rejects.toMatchObject({ code: 'stepup_required' })
  }, 60_000)
})

describe('R1: the first device always makes a fresh set, whatever was made before it', () => {
  it('a password holder makes codes before any device; the owner then adds the first passkey: the earlier codes are refused for every H2 act and only the new set works', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    // someone who knows the password makes the ten codes while the account has no device
    const early = regenerateRecoveryCodes(db, sessionFor(db, r.session.token, T0 + 500)!, T0 + 500)
    expect(early).toHaveLength(10)
    // the owner sets up the first device
    const auth1 = device()
    const s1 = sessionFor(db, r.session.token, T0 + 1000)!
    const b1 = await beginAddPasskey(db, RP, s1, T0 + 1000)
    const first = await finishAddPasskey(db, RP, s1, { challengeId: b1.challengeId, response: auth1.create(b1.options as never) }, META.ua, T0 + 1000)
    expect(first.recoveryCodes).toHaveLength(10)
    expect(first.replacedEarlier).toBe(true)
    expect(unused(db, r.personId)).toBe(10)
    expect(first.recoveryCodes!.some((c) => early.includes(c))).toBe(false)
    // a second device, from a passkey session
    const login = await signInAgain(db, auth1, T0 + 2000)
    const second = await add(db, login, T0 + 2500, 'Second device')
    const s = sessionFor(db, login, T0 + 3000)!
    // every H2 act refuses an early code
    await expect(suspendPasskeyWithCode(db, s, second.id, early[0], T0 + 3000)).rejects.toMatchObject({ code: 'code_wrong' })
    await expect(regenerateRecoveryCodesWithCode(db, s, early[1], T0 + 3000)).rejects.toMatchObject({ code: 'code_wrong' })
    // the new set works
    await suspendPasskeyWithCode(db, s, second.id, first.recoveryCodes![0], T0 + 3500)
    expect(usableCredentials(db, r.personId)).toHaveLength(1)
  }, 60_000)
  it('with no earlier codes there is nothing to say was replaced', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'a@example.in', password: PW }, META, T0)
    expect((await add(db, r.session.token, T0 + 1000)).replacedEarlier).toBeUndefined()
  }, 60_000)
})

describe('R3: a set that was not saved can be made again by the session that was shown it, for 30 minutes', () => {
  it('works in the window: a fresh set, the old one refused, and the window moves to the new one', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    const s = sessionFor(db, a.session.token, T0 + 1000)!
    const again = regenerateJustMadeCodes(db, s, T0 + 1000)
    expect(again).toHaveLength(10)
    expect(again.some((c) => a.recoveryCodes.includes(c))).toBe(false)
    expect(unused(db, a.personId)).toBe(10)
    // the old set no longer works
    await expect(regenerateRecoveryCodesWithCode(db, s, a.recoveryCodes[0], T0 + 2000)).rejects.toMatchObject({ code: 'code_wrong' })
    // the new one is itself in the window (it may also be lost)
    expect(regenerateJustMadeCodes(db, s, T0 + 3000)).toHaveLength(10)
  }, 60_000)
  it('is refused from another session, after a second passkey exists, after a code is used, and after 30 minutes; and needs the session\'s fresh passkey confirmation', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    const closed = { code: 'codes_window_closed' }
    // another session of the same passkey
    const other = sessionFor(db, await signInAgain(db, a.auth, T0 + 1000), T0 + 1000)!
    expect(() => regenerateJustMadeCodes(db, other, T0 + 1000)).toThrow(expect.objectContaining(closed))
    // no fresh passkey confirmation: a stale session of the receiver
    const s = sessionFor(db, a.session.token, T0 + 1000)!
    expect(() => regenerateJustMadeCodes(db, { ...s, stepUpFresh: false }, T0 + 1000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    // after 30 minutes
    expect(() => regenerateJustMadeCodes(db, s, T0 + JUST_MADE_WINDOW_MS)).toThrow(expect.objectContaining(closed))
    // after a code of the set is used
    db.run('UPDATE recovery_codes SET used_at = ? WHERE id = (SELECT id FROM recovery_codes WHERE person_id = ? LIMIT 1)', T0 + 1500, a.personId)
    expect(() => regenerateJustMadeCodes(db, s, T0 + 2000)).toThrow(expect.objectContaining(closed))
  }, 60_000)
  it('is refused once a second passkey exists', async () => {
    const db = openDb(':memory:')
    const a = await passkeyAccount(db)
    await add(db, a.session.token, T0 + 1000)
    expect(() => regenerateJustMadeCodes(db, sessionFor(db, a.session.token, T0 + 2000)!, T0 + 2000)).toThrow(expect.objectContaining({ code: 'codes_window_closed' }))
  }, 60_000)
})

describe('a completed recovery hands the recoverer no codes unless it spent one (back to the base behaviour; F3)', () => {
  configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5174' })
  const tokenIn = (db: Db, purpose: string): string => /#token=([A-Za-z0-9_-]+)/.exec(db.get<{ body: string }>('SELECT body FROM outbound_messages WHERE purpose = ? ORDER BY created_at DESC, id DESC LIMIT 1', purpose)!.body)![1]!
  /** An account opened with an address and a password, the address confirmed, one device set up (which brought its codes). */
  async function account(db: Db) {
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    confirmAddressByLink(db, tokenIn(db, 'verify-email'), META.ip, T0 + 500)
    const first = await add(db, r.session.token, T0 + 1000, 'First device')
    expect(unused(db, r.personId)).toBe(10)
    return { ...r, codes: first.recoveryCodes! }
  }
  /** The device is lost: the email link and the password start a recovery; after its wait the new passkey is made. */
  async function recover(db: Db, at: number) {
    requestRecoveryLink(db, 'meera@example.in', '198.51.100.9', at)
    const started = await startRecoveryFromLink(db, { token: tokenIn(db, 'recovery-link'), password: PW }, META.ip, at + 1000)
    expect(recoveryTick(db, started.availableAt)).toBe(1)
    const b = await beginRecoveryFromLink(db, RP, { token: tokenIn(db, 'recovery-ready'), finishKey: started.finishKey }, started.availableAt + 1)
    return finishRecoveryFromLink(db, RP, { challengeId: b.challengeId, response: device().create(b.options as never) }, META, started.availableAt + 1)
  }

  it('a recovery that spent no saved code makes none and shows none: the codes the account holds stay as they are', async () => {
    const db = openDb(':memory:')
    const r = await account(db)
    const before = db.all('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL ORDER BY id', r.personId)
    const done = await recover(db, T0 + 500 + PROTECTION_DELAY_MS + 10)
    expect(done.authority).toBe('signin')
    expect(done.recoveryCodes).toEqual([])
    expect(db.all('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL ORDER BY id', r.personId)).toEqual(before)
    expect(db.get(`SELECT 1 FROM security_events WHERE person_id = ? AND kind = 'recovery-codes-made' AND detail_json LIKE '%recovery%'`, r.personId)).toBeUndefined()
  }, 60_000)
})
