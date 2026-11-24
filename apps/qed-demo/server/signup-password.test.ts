/**
 * Opening an account with a handle and a password (D-094). The account can read and set up everything; it approves
 * nothing until it holds a passkey, and the new session's password freshness unlocks only adding that first passkey.
 */
import { describe, expect, it } from 'vitest'
import { login, sessionFor, STEPUP_MS, stepUp } from './auth.ts'
import { openDb } from './core.ts'
import { beginAddPasskey, beginReauth, beginRecoveryPasskey, cancelRecovery, finishAddPasskey, RECOVERY_DELAY_MS, regenerateRecoveryCodes, type RelyingParty, signUpWithPassword, startRecovery } from './passkeys.ts'
import { SoftAuthenticator } from './softauthn.ts'
import { needsYou } from './views.ts'

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 22, 10, 0)
const PW = 'a long and private phrase 7'

describe('sign-up with a password', () => {
  it('opens an account with its own workspace, a hashed password and ten recovery codes, and signs in with the password', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'Meera', password: PW, displayName: 'Meera Nair' }, META, T0)
    const u = db.get<{ handle: string; display_name: string; pw_hash: string; kind: string }>('SELECT handle, display_name, pw_hash, kind FROM users WHERE id = ?', r.personId)!
    expect(u).toMatchObject({ handle: 'meera', display_name: 'Meera Nair', kind: 'person' })
    expect(u.pw_hash.startsWith('scrypt$')).toBe(true)
    expect(u.pw_hash).not.toContain(PW)
    expect(db.get('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ?', r.personId, r.personId)).toEqual({ role: 'owner' })
    expect(r.recoveryCodes).toHaveLength(10)
    expect(new Set(r.recoveryCodes).size).toBe(10)
    const s = await login(db, { handle: 'meera', password: PW }, META, T0 + 1000)
    expect(s.userId).toBe(r.personId)
  }, 20_000)

  it('gives the new session a password freshness that is not a passkey step-up', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    expect(s).toMatchObject({ authMethod: 'password', stepUpFresh: false, passwordStepUpFresh: true })
    // the freshness lapses like any re-authentication
    expect(sessionFor(db, r.session.token, T0 + STEPUP_MS + 1000)).toMatchObject({ passwordStepUpFresh: false })
    // new saved codes need the strongest confirmation the account can give: with no passkey yet that is its freshly
    // typed password (then its only credential, RISK-076), and not a lapsed one; once it has a passkey, only the
    // passkey (password-session-routes.test.ts, M1)
    expect(regenerateRecoveryCodes(db, s, T0 + 1000, unusedCodeId(db, s.userId))).toHaveLength(10)
    expect(() => regenerateRecoveryCodes(db, sessionFor(db, r.session.token, T0 + STEPUP_MS + 1000)!, T0 + STEPUP_MS + 1000)).toThrow(/password again/)
  }, 20_000)

  it('cannot be asked to approve anything: an approval needs a passkey and the account has none', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    await expect(beginReauth(db, RP, r.personId, 'approval', new Uint8Array(32), { approvalId: 'apr_x', docHash: 'h' }, T0 + 1000)).rejects.toBeTruthy()
  }, 20_000)

  it('adds its first passkey inside the freshness window, and not after it', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    const late = sessionFor(db, r.session.token, T0 + STEPUP_MS + 1000)!
    await expect(beginAddPasskey(db, RP, late, T0 + STEPUP_MS + 1000)).rejects.toMatchObject({ code: 'stepup_required' })
    const fresh = sessionFor(db, r.session.token, T0 + 1000)!
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginAddPasskey(db, RP, fresh, T0 + 1000)
    const cred = await finishAddPasskey(db, RP, fresh, { challengeId: b.challengeId, response: phone.create(b.options as never), passkeyName: 'Phone' }, META.ua, T0 + 1000)
    expect(cred.name).toBe('Phone')
    // a second passkey needs a passkey confirmation, not the password
    const after = sessionFor(db, r.session.token, T0 + 2000)!
    await expect(beginAddPasskey(db, RP, after, T0 + 2000)).rejects.toMatchObject({ code: 'stepup_required' })
  }, 20_000)

  it('refuses weak passwords, a taken handle in either form, and more than twenty accounts an hour from one address', async () => {
    const db = openDb(':memory:')
    await expect(signUpWithPassword(db, { handle: 'meera', password: 'short' }, META, T0)).rejects.toMatchObject({ fields: { password: expect.any(String) } })
    await expect(signUpWithPassword(db, { handle: 'meera', password: 'meera-meera-meera' }, META, T0)).rejects.toMatchObject({ fields: { password: expect.stringMatching(/easy to guess/) } })
    await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    await expect(signUpWithPassword(db, { handle: 'MEERA', password: PW }, META, T0)).rejects.toMatchObject({ code: 'handle_taken' })
    const busy = openDb(':memory:')
    for (let i = 0; i < 20; i++) await signUpWithPassword(busy, { handle: `person${i}x`, password: PW }, { ...META, ip: '203.0.113.9' }, T0 + i)
    await expect(signUpWithPassword(busy, { handle: 'onetoomany', password: PW }, { ...META, ip: '203.0.113.9' }, T0 + 40)).rejects.toMatchObject({ status: 429 })
  }, 180_000) // 21 sign-ups at scrypt N = 2^17 (128 MB each): 22 s alone, over 60 s at load average 46 with other worktrees running (RISK-078)

  it('starts a recovery with a saved code and the password, which then waits out its delay and can be cancelled', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    // a wrong password starts nothing (and answers alike)
    const wrong = await startRecovery(db, { handle: 'meera', code: r.recoveryCodes[1], password: 'not the password at all' }, META.ip, T0 + 500)
    expect(db.get('SELECT 1 FROM recovery_requests WHERE id = ?', wrong.requestId)).toBeUndefined()
    const rec = await startRecovery(db, { handle: 'meera', code: r.recoveryCodes[0], password: PW }, META.ip, T0 + 1000)
    // the request is recorded with its method and its delay, and the saved code it used is spent
    expect(db.get('SELECT person_id, method, available_at, cancelled_at, completed_at FROM recovery_requests WHERE id = ?', rec.requestId))
      .toEqual({ person_id: r.personId, method: 'saved+password', available_at: rec.availableAt, cancelled_at: null, completed_at: null })
    expect(rec.availableAt).toBe(T0 + 1000 + RECOVERY_DELAY_MS)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', r.personId)?.n).toBe(1)
    // before the delay it cannot be finished, even with its own reference
    await expect(beginRecoveryPasskey(db, RP, rec.reference, T0 + 2000)).rejects.toMatchObject({ code: 'recovery_waiting' })
    // a later password session cancels it only after typing the password again (no passkey: the password is the
    // account's only credential), and is shown the new codes
    const later = await login(db, { handle: 'meera', password: PW }, META, T0 + 3000)
    const stale = sessionFor(db, later.token, T0 + 3000)!
    expect(() => cancelRecovery(db, stale, rec.requestId, T0 + 3000)).toThrow(/password again/)
    await stepUp(db, stale, PW, META.ip, T0 + 4000)
    const fresh = sessionFor(db, later.token, T0 + 4000)!
    expect(cancelRecovery(db, fresh, rec.requestId, T0 + 4000)).toEqual({ codes: [], codeSpent: true }) // H2 re-check: no new set
    expect(db.get<{ cancelled_at: number }>('SELECT cancelled_at FROM recovery_requests WHERE id = ?', rec.requestId)?.cancelled_at).toBe(T0 + 4000)
    await expect(beginRecoveryPasskey(db, RP, rec.reference, T0 + RECOVERY_DELAY_MS + 5000)).rejects.toMatchObject({ code: 'recovery_unavailable' })
  }, 30_000)

  it('starts no recovery, and spends no saved code, when the password changes while it is being checked (review of RISK-076\'s change, L3)', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    // the password is checked with an asynchronous hash; meanwhile the owner removes it (written here directly: the
    // route itself is tested over HTTP in password-change-routes.test.ts)
    const pending = startRecovery(db, { handle: 'meera', code: r.recoveryCodes[0], password: PW }, META.ip, T0 + 1000)
    db.run(`UPDATE users SET pw_hash = '!' WHERE id = ?`, r.personId)
    const rec = await pending
    expect(db.get('SELECT 1 FROM recovery_requests WHERE id = ?', rec.requestId)).toBeUndefined()
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', r.personId)?.n).toBe(0)
  }, 20_000)
})

describe('Home tells a password account its password is its only key', () => {
  it('shows the card while there is no passkey and no recovery contact, and the one-device card once a passkey exists', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PW }, META, T0)
    const kinds = () => needsYou(db, r.personId, T0 + 2000).filter((n) => n.type === 'account-safety').map((n) => n.title)
    expect(kinds()).toEqual(['Your password is this account\'s only key'])
    // a passkey added in the sign-up window: now one lost device would lose it, which is the card it gets
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    const key = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginAddPasskey(db, RP, s, T0 + 1000)
    await finishAddPasskey(db, RP, s, { challengeId: b.challengeId, response: key.create(b.options as never) }, META.ua, T0 + 1000)
    expect(kinds()).toEqual(['One lost device would lose this account'])
  }, 30_000)
})
