/**
 * Ordinary account access (R14, Priority 1): an account opened with an email address and a password, signed in to with
 * that address or its handle, and the address's confirmation.
 *
 *   - The address reserves nothing until it is confirmed, so opening an account never says whether an address is in use,
 *     and nobody can take an address away from its owner by typing it first.
 *   - A sign-in by address costs one password derivation whether no account, one or several use that address, and answers
 *     the same for an address nobody uses as for a wrong password, a lock included.
 *   - No saved recovery codes are made at sign-up (the forced codes step is gone); the password session it opens is not a
 *     passkey confirmation.
 *   - With no way to send email the account still works: its address is plainly not confirmed, and nothing is said to be sent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { emailState, signUpWithEmail } from './access.ts'
import { login, sessionFor, STEPUP_MS, work } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { configureDelivery } from './delivery.ts'
import { changePassword, PROTECTION_DELAY_MS, removePassword, type RelyingParty, beginAddPasskey, finishAddPasskey, regenerateRecoveryCodes } from './passkeys.ts'
import { addAddress, confirmAddressByLink, requestPasswordReset, resetPassword, usableEmails } from './recovery.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 25, 10, 0)
const PW = 'a long and private phrase 7', OTHER = 'quite another long phrase 9'
const outbox = (): void => configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5174' })
afterEach(outbox)
/** The link token of the newest message of a purpose in the test outbox. */
const tokenIn = (db: Db, purpose: string): string => /#token=([A-Za-z0-9_-]+)/.exec(db.get<{ body: string }>('SELECT body FROM outbound_messages WHERE purpose = ? ORDER BY created_at DESC, id DESC LIMIT 1', purpose)!.body)![1]!
const codesOf = (db: Db, id: string): number => db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ?', id)!.n

describe('opening an account with an email address and a password', () => {
  it('opens the account with its own workspace and a handle made from the name, keeps the address as typed, and makes no saved codes', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: ' Meera.Nair@Example.in ', password: PW, displayName: 'Meera Nair' }, META, T0)
    const u = db.get<{ handle: string; display_name: string; pw_hash: string; kind: string; email: string; email_key: string }>('SELECT handle, display_name, pw_hash, kind, email, email_key FROM users WHERE id = ?', r.personId)!
    expect(u).toMatchObject({ handle: 'meera.nair', display_name: 'Meera Nair', kind: 'person', email: 'Meera.Nair@example.in', email_key: 'meera.nair@example.in' })
    expect(r.handle).toBe('meera.nair')
    expect(u.pw_hash.startsWith('scrypt$')).toBe(true)
    expect(db.get('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ?', r.personId, r.personId)).toEqual({ role: 'owner' })
    // the forced codes step is gone: none is made, and the answer carries none
    expect(codesOf(db, r.personId)).toBe(0)
    expect(r).not.toHaveProperty('recoveryCodes')
    // the session is a password session whose fresh password unlocks the first device only; it is not a passkey confirmation
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    expect(s).toMatchObject({ authMethod: 'password', stepUpFresh: false, passwordStepUpFresh: true })
    expect(sessionFor(db, r.session.token, T0 + STEPUP_MS + 1000)).toMatchObject({ passwordStepUpFresh: false })
  }, 30_000)

  it('never says whether an address is in use: a second account with the same address opens the same way, with its own handle', async () => {
    const db = openDb(':memory:')
    const a = await signUpWithEmail(db, { email: 'shared@example.in', password: PW, displayName: 'Asha Rao' }, META, T0)
    const b = await signUpWithEmail(db, { email: 'Shared@Example.in', password: OTHER, displayName: 'Asha Rao' }, META, T0 + 1000)
    expect(b.personId).not.toBe(a.personId)
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    expect(a.handle).toBe('asha.rao')
    expect(b.handle).toMatch(/^asha\.rao\.\d{4}$/)
    // the address and each password name each account
    expect((await login(db, { handle: 'shared@example.in', password: PW }, META, T0 + 2000)).userId).toBe(a.personId)
    expect((await login(db, { handle: 'SHARED@example.in', password: OTHER }, META, T0 + 3000)).userId).toBe(b.personId)
  }, 60_000)

  it('refuses a malformed address, a weak password, and a password made from the address or the name', async () => {
    const db = openDb(':memory:')
    await expect(signUpWithEmail(db, { email: 'not-an-address', password: PW }, META, T0)).rejects.toMatchObject({ code: 'invalid', fields: { email: expect.any(String) } })
    await expect(signUpWithEmail(db, { email: 'a@example.in', password: 'short' }, META, T0)).rejects.toMatchObject({ fields: { password: 'Use at least 10 characters.' } })
    await expect(signUpWithEmail(db, { email: 'a@example.in', password: 'password1234' }, META, T0)).rejects.toMatchObject({ fields: { password: 'That password is too easy to guess.' } })
    await expect(signUpWithEmail(db, { email: 'meenakshi@example.in', password: 'Meenakshi2026!' }, META, T0)).rejects.toMatchObject({ fields: { password: expect.stringMatching(/easy to guess|made from/) } })
    await expect(signUpWithEmail(db, { email: 'a@example.in', password: 'Lakshmanan#2026', displayName: 'Lakshmanan' }, META, T0)).rejects.toMatchObject({ fields: { password: expect.stringMatching(/made from/) } })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(0)
  })

  it('a handle of the person\'s own choosing is kept, and one in use is said to be (handles are public names)', async () => {
    const db = openDb(':memory:')
    const a = await signUpWithEmail(db, { email: 'a@example.in', password: PW, displayName: 'A Person', handle: 'Chosen-One' }, META, T0)
    expect(a.handle).toBe('chosen-one')
    await expect(signUpWithEmail(db, { email: 'b@example.in', password: PW, handle: 'chosen-one' }, META, T0)).rejects.toMatchObject({ code: 'handle_taken' })
    // with no name and no handle, a neutral handle: never the address's own name, which is private
    const c = await signUpWithEmail(db, { email: 'very.private.name@example.in', password: PW }, META, T0)
    expect(c.handle).toMatch(/^member\.\d{4}$/)
  }, 60_000)

  it('limits new accounts from one address of the network', async () => {
    const db = openDb(':memory:')
    db.run(`INSERT INTO rate_limits (key, window_start, count) VALUES ('signup:127.0.0.1', ?, 20)`, T0)
    await expect(signUpWithEmail(db, { email: 'a@example.in', password: PW }, META, T0 + 1000)).rejects.toMatchObject({ status: 429 })
  })
})

describe('signing in with an email address and a password', () => {
  it('answers a wrong password and an address nobody uses alike, and each costs exactly one derivation', async () => {
    const db = openDb(':memory:')
    await signUpWithEmail(db, { email: 'meera@example.in', password: PW, displayName: 'Meera' }, META, T0)
    await signUpWithEmail(db, { email: 'meera@example.in', password: OTHER, displayName: 'Meera' }, META, T0)
    const outcome = async (email: string, password: string) => {
      const before = work.emailDerivations
      const e = await login(db, { handle: email, password }, META, T0 + 5000).then(() => null, (x: unknown) => x as { status: number; code: string; message: string })
      return { e: e && { status: e.status, code: e.code, message: e.message }, derivations: work.emailDerivations - before }
    }
    const wrong = await outcome('meera@example.in', 'not the password at all')
    const unknown = await outcome('nobody@example.in', 'not the password at all')
    expect(wrong.e).toEqual({ status: 401, code: 'bad_credentials', message: 'That email and password do not match.' })
    expect(unknown.e).toEqual(wrong.e)
    // two accounts use the first address and none the second: one derivation each, and one for a success
    expect(wrong.derivations).toBe(1)
    expect(unknown.derivations).toBe(1)
    expect((await outcome('meera@example.in', PW)).derivations).toBe(1)
  }, 60_000)

  it('locks after five wrong passwords for an address nobody uses exactly as for one in use, and a lock is answered before any password is checked', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const tries = async (email: string): Promise<number[]> => {
      const out: number[] = []
      for (let i = 0; i < 7; i++) out.push(await login(db, { handle: email, password: `wrong password ${i}` }, { ...META, ip: `10.0.0.${i}` }, T0 + 1000 + i).then(() => 200, (e: { status: number }) => e.status))
      return out
    }
    const known = await tries('meera@example.in'), unknown = await tries('nobody@example.in')
    expect(known).toEqual([401, 401, 401, 401, 401, 429, 429])
    expect(unknown).toEqual(known)
    // the account itself is locked too, so the handle gives no further guesses, and its owner is told
    const u = db.get<{ locked_until: number | null }>('SELECT locked_until FROM users WHERE id = ?', r.personId)!
    expect(u.locked_until).toBeGreaterThan(T0)
    expect(db.get(`SELECT kind FROM security_events WHERE person_id = ? AND kind = 'signin-locked'`, r.personId)).toEqual({ kind: 'signin-locked' })
    await expect(login(db, { handle: r.handle, password: PW }, META, T0 + 5000)).rejects.toMatchObject({ status: 429 })
    // while locked, the right password with the address opens nothing either
    await expect(login(db, { handle: 'meera@example.in', password: PW }, { ...META, ip: '10.0.1.1' }, T0 + 6000)).rejects.toMatchObject({ status: 429 })
    // and when the lock has passed, it signs in
    expect((await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 16 * 60_000)).userId).toBe(r.personId)
  }, 120_000)

  it('the right password clears the count, so an owner who mistypes now and then is never locked', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) await expect(login(db, { handle: 'meera@example.in', password: 'a mistyped password' }, META, T0 + round * 100 + i)).rejects.toMatchObject({ status: 401 })
      expect((await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + round * 100 + 50)).userId).toBe(r.personId)
    }
  }, 120_000)

  it('signs in with the handle as before, and a session opened either way is a password session', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW, displayName: 'Meera Nair' }, META, T0)
    const byHandle = await login(db, { handle: 'meera.nair', password: PW }, META, T0 + 1000)
    const byEmail = await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 2000)
    for (const s of [byHandle, byEmail]) expect(sessionFor(db, s.token, T0 + 3000)).toMatchObject({ userId: r.personId, authMethod: 'password', stepUpFresh: false, passwordStepUpFresh: false })
  }, 60_000)

  it('follows the password: a changed one signs in with the address, the old one does not, and a removed one opens nothing', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    await changePassword(db, s, { current: PW, password: OTHER }, '127.0.0.1', T0 + 2000)
    await expect(login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 3000)).rejects.toMatchObject({ code: 'bad_credentials' })
    expect((await login(db, { handle: 'meera@example.in', password: OTHER }, META, T0 + 4000)).userId).toBe(r.personId)
    // a tag is bound to the password hash it was made for: if the hash changes by any path that forgot it, the old tag matches nothing
    const hash = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', r.personId)!.pw_hash
    db.run('UPDATE users SET pw_hash = ? WHERE id = ?', `${hash.slice(0, -4)}AAAA`, r.personId)
    await expect(login(db, { handle: 'meera@example.in', password: OTHER }, META, T0 + 5000)).rejects.toMatchObject({ code: 'bad_credentials' })
    db.run('UPDATE users SET pw_hash = ?, failed_logins = 0 WHERE id = ?', hash, r.personId)
    // with a passkey, the password can be removed; from then the address and the old password open nothing
    const late = await login(db, { handle: r.handle, password: OTHER }, META, T0 + 6000)
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'password' WHERE id_hash = (SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1)`, T0 + 6000, r.personId)
    const typed = sessionFor(db, late.token, T0 + 6500)!
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const b = await beginAddPasskey(db, RP, typed, T0 + 6500)
    const cred = await finishAddPasskey(db, RP, typed, { challengeId: b.challengeId, response: device.create(b.options as never) }, META.ua, T0 + 6500)
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'passkey', stepup_credential_id = ? WHERE user_id = ?`, T0 + 7000, cred.id, r.personId)
    // a way back in without the password (removePassword asks for one): an active recovery contact with a passkey, and saved codes
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_c', 'contact', 'Contact', '!', ?, 'person')`, T0)
    db.run(`INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, name, created_at, authority) VALUES ('cred_c', 'usr_c', x'00', '00', '00', 'Passkey', ?, 'full')`, T0)
    db.run(`INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at, accepted_at) VALUES ('rcl_1', ?, 'usr_c', ?, ?, ?)`, r.personId, T0, T0, T0)
    // (the first device brought its saved codes, F1)
    expect(cred.recoveryCodes).toHaveLength(10)
    removePassword(db, sessionFor(db, late.token, T0 + 7000)!, '127.0.0.1', T0 + 7500)
    await expect(login(db, { handle: 'meera@example.in', password: OTHER }, META, T0 + 8000)).rejects.toMatchObject({ code: 'bad_credentials' })
    expect(db.get('SELECT 1 x FROM email_logins WHERE person_id = ?', r.personId)).toBeUndefined()
  }, 120_000)

  it('a password reset by email is followed too: the new password signs in with the address', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    confirmAddressByLink(db, tokenIn(db, 'verify-email'), '127.0.0.1', T0 + 1000)
    const D = PROTECTION_DELAY_MS // F4: the opening address waits the protection delay after its confirmation
    requestPasswordReset(db, 'meera@example.in', '127.0.0.1', T0 + D + 2000)
    await resetPassword(db, { token: tokenIn(db, 'password-reset'), password: OTHER, confirm: OTHER }, '127.0.0.1', T0 + D + 3000)
    await expect(login(db, { handle: 'meera@example.in', password: PW }, META, T0 + D + 4000)).rejects.toMatchObject({ code: 'bad_credentials' })
    expect((await login(db, { handle: 'meera@example.in', password: OTHER }, META, T0 + D + 5000)).userId).toBe(r.personId)
  }, 120_000)

  it('an account whose tag is missing gets it back at its next sign-in with the handle', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW, displayName: 'Meera Nair' }, META, T0)
    db.run('DELETE FROM email_logins WHERE person_id = ?', r.personId)
    await expect(login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 1000)).rejects.toMatchObject({ code: 'bad_credentials' })
    await login(db, { handle: 'meera.nair', password: PW }, META, T0 + 2000)
    expect((await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 3000)).userId).toBe(r.personId)
  }, 120_000)
})

describe('confirming the address an account was opened with', () => {
  it('with the local test outbox, a confirmation is kept there at sign-up, and the address is not confirmed until its link is used', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    expect(r.email).toEqual({ address: 'meera@example.in', verified: false, pending: true, canVerify: true, simulated: true })
    const m = db.get<{ to_address: string; status: string; purpose: string }>(`SELECT to_address, status, purpose FROM outbound_messages WHERE person_id = ?`, r.personId)!
    expect(m).toEqual({ to_address: 'meera@example.in', status: 'simulated', purpose: 'verify-email' })
    // unconfirmed, it receives nothing and starts nothing
    expect(usableEmails(db, r.personId, T0 + 1000)).toHaveLength(0)
    expect(requestPasswordReset(db, 'meera@example.in', '127.0.0.1', T0 + 1000)).toEqual({ ok: true })
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbound_messages WHERE purpose = 'password-reset'`)!.n).toBe(0)
    confirmAddressByLink(db, tokenIn(db, 'verify-email'), '127.0.0.1', T0 + 2000)
    expect(emailState(db, r.personId, T0 + 3000)).toEqual({ address: 'meera@example.in', verified: true, pending: false, canVerify: true, simulated: true })
  }, 60_000)

  it('F11: a password change and a reset apply the same rules as sign-up: nothing made from the address, the handle or the name', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'm.rao@example.in', password: PW, displayName: 'Meera Nair' }, META, T0)
    const s = sessionFor(db, r.session.token, T0 + 1000)!
    // sign-up refuses one made from the address's own name; so must a change
    await expect(changePassword(db, s, { current: PW, password: 'tulip m.rao 2026' }, '127.0.0.1', T0 + 2000)).rejects.toMatchObject({ fields: { password: expect.any(String) } })
    // and a reset, once the address is usable
    confirmAddressByLink(db, tokenIn(db, 'verify-email'), '127.0.0.1', T0 + 1000)
    const at = T0 + 1000 + PROTECTION_DELAY_MS + 1
    requestPasswordReset(db, 'm.rao@example.in', '127.0.0.1', at)
    await expect(resetPassword(db, { token: tokenIn(db, 'password-reset'), password: 'tulip m.rao 2026', confirm: 'tulip m.rao 2026' }, '127.0.0.1', at + 1000)).rejects.toMatchObject({ fields: { password: expect.any(String) } })
    // a fresh phrase is accepted
    await resetPassword(db, { token: tokenIn(db, 'password-reset'), password: OTHER, confirm: OTHER }, '127.0.0.1', at + 2000)
  }, 120_000)

  it('F4: the address the account was opened with waits the protection delay after its confirmation, as one added later does; the link needs no session', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const done = confirmAddressByLink(db, tokenIn(db, 'verify-email'), '127.0.0.1', T0 + 1000)
    expect(done.usableFrom).toBe(T0 + 1000 + PROTECTION_DELAY_MS)
    // confirmed, but it starts nothing yet: a reset asked for with it sends nothing, so a mailbox alone resets nothing at once
    expect(usableEmails(db, r.personId, T0 + 2000)).toHaveLength(0)
    expect(requestPasswordReset(db, 'meera@example.in', '127.0.0.1', T0 + 2000)).toEqual({ ok: true })
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbound_messages WHERE purpose = 'password-reset'`)!.n).toBe(0)
    // the owner's devices are told when it is confirmed
    expect(db.get(`SELECT 1 FROM security_events WHERE person_id = ? AND kind = 'email-confirmed'`, r.personId)).toBeTruthy()
    // after the delay it is usable
    expect(usableEmails(db, r.personId, T0 + 1000 + PROTECTION_DELAY_MS + 1).map((p) => p.address)).toEqual(['meera@example.in'])
    requestPasswordReset(db, 'meera@example.in', '127.0.0.1', T0 + 1000 + PROTECTION_DELAY_MS + 1)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbound_messages WHERE purpose = 'password-reset'`)!.n).toBe(1)
  }, 60_000)

  it('someone else who opens an account with the same address gains nothing from the owner\'s confirmation of their own', async () => {
    const db = openDb(':memory:')
    const squatter = await signUpWithEmail(db, { email: 'meera@example.in', password: OTHER, displayName: 'Squatter' }, META, T0)
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW, displayName: 'Meera' }, META, T0 + 1000)
    // each account has its own confirmation; the owner uses the one that names their own account (the newest)
    confirmAddressByLink(db, tokenIn(db, 'verify-email'), '127.0.0.1', T0 + 2000)
    expect(emailState(db, owner.personId, T0 + 3000)).toMatchObject({ verified: true })
    expect(emailState(db, squatter.personId, T0 + 3000)).toMatchObject({ verified: false })
    // a reset asked for with the address reaches only the account that confirmed it
    requestPasswordReset(db, 'meera@example.in', '127.0.0.1', T0 + 4000 + PROTECTION_DELAY_MS)
    expect(db.all<{ person_id: string }>(`SELECT person_id FROM outbound_messages WHERE purpose = 'password-reset'`)).toEqual([{ person_id: owner.personId }])
  }, 60_000)

  it('with no way to send email, the account still opens and works: the address is plainly not confirmed and nothing is said to be sent', async () => {
    configureDelivery({ delivery: 'none', linkOrigin: 'https://qed.example' })
    const db = openDb(':memory:')
    const r = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    expect(r.email).toEqual({ address: 'meera@example.in', verified: false, pending: false, canVerify: false, simulated: false })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM outbound_messages')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_points')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM one_time_tokens')!.n).toBe(0)
    expect((await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 1000)).userId).toBe(r.personId)
    expect(emailState(db, r.personId, T0 + 2000)).toEqual({ address: 'meera@example.in', verified: false, pending: false, canVerify: false, simulated: false })
  }, 60_000)

  it('an account opened without an address (a handle and a passkey, or one from before) has none to confirm', () => {
    const db = openDb(':memory:')
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_a', 'asha', 'Asha', '!', ?, 'person')`, T0)
    expect(emailState(db, 'usr_a', T0)).toEqual({ address: null, verified: false, pending: false, canVerify: true, simulated: true })
  })
})
