/**
 * Changing and removing a password, over HTTP against the real API server (RISK-076's next step, D-094).
 *
 * Changing it needs the strongest confirmation the account can give: a fresh passkey confirmation when it has a passkey
 * (a password, which can be phished, never changes it then), or, on an account with no passkey, the current password
 * typed again in the same request (the sign-up's five-minute freshness is not enough: that password is the very thing
 * changed). The new one passes the sign-up rules, and every other session of the account ends.
 *
 * Removing it needs a passkey that can sign in, a fresh confirmation with one, and a way back in without it: a recovery
 * then needs one of the saved codes and a code from a recovery contact, so an unused saved code and an active contact
 * must both exist. Since R14 (SECURITY.md 8j (c)) the removal is scheduled: it waits the protection delay (written past
 * here, as activeContact writes a contact's), and any passkey, or a saved code from any session, cancels it. When it
 * applies, the sessions the password opened end and the password then opens nothing. Both routes are limited like sign-in.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { authenticatorFor, signIn, signUp, stepUp } from '../scripts/lib/passkey-client.ts'
import { applyDueChanges, makeRecoveryCodes, PROTECTION_DELAY_MS } from './passkeys.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (a fixed port let one run's
// requests reach another's server). Was 9413.
const PORT = 20000 + Math.floor(Math.random() * 20000)
// The API thread's time budget (server/guard.ts, lead L-14) is kept per address in memory for the server's life, and every
// request here comes from 127.0.0.1, so with the default (20 s a minute) the whole file shared one budget: on a slower
// machine (GitHub's ubuntu-24.04 runner) the tests before M4 used it up, M4 met 429 too_costly before too_many, and the
// tests after it failed in the same minute. This file tests the password routes' own limits, not that throttle
// (server/guard.test.ts does), so this isolated test stack's budget is set above what one thread can spend in a minute
// (QED_TEST_STACK=1 allows raising it, guard.ts costBudget): however slow the machine, it is never reached. Both
// variables are set only while startApi reads the budget, so no other part of the server sees them.
const COST_BUDGET_ENV = { QED_TEST_STACK: '1', QED_COST_MS_PER_MINUTE: String(10 * 60_000) }
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return fn() } finally { for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
}

describe('changing and removing a password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-password-change-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = withEnv(COST_BUDGET_ENV, () => startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) }))) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  // Every test comes from 127.0.0.1: the per-address limits (and sign-up's and sign-in's) start afresh for each, so one
  // test's calls never end another's. The limits stay in the product; the tests that are about them set them up.
  beforeEach(() => { api.ctx.db.run(`DELETE FROM rate_limits WHERE key LIKE 'password-%' OR key LIKE 'stepup-fail:%' OR key LIKE 'signup:%' OR key LIKE 'login:%'`) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json }, cookie: () => cookie }
  }
  const answer = (r: { status: number; json: J }) => [r.status, r.json.error?.code ?? null, r.json.error?.fields ?? null]
  const hashOf = (handle: string) => api.ctx.db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE handle = ?', handle)!.pw_hash
  /** A password account that adds its first passkey in the sign-up's own five-minute window, as the first run offers. */
  async function passwordAccountWithPasskey(handle: string, password: string) {
    const owner = client(), key = authenticatorFor(PORT)
    const made = await owner.ok('POST', '/api/auth/signup', { handle, password, displayName: `Person ${handle}` })
    // R14: sign-up makes no saved codes; this account makes its set first (the password just typed confirms it), as these tests rely on them
    await owner.ok('POST', '/api/security/recovery-codes', {})
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    // the first device brings the account's saved codes (R1: a fresh set, replacing those made before it)
    const codes = (await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })).recoveryCodes as string[]
    return { owner, key, made, codes }
  }
  /** The scheduled removal of this account's password, written due (as activeContact writes a contact's delay past) and applied, as the engine's tick would. */
  function removalApplies(handle: string): void {
    expect(api.ctx.db.run(`UPDATE scheduled_changes SET effective_at = ? WHERE kind = 'remove-password' AND cancelled_at IS NULL AND applied_at IS NULL AND person_id = (SELECT id FROM users WHERE handle = ?)`, Date.now() - 1000, handle).changes).toBe(1)
    applyDueChanges(api.ctx.db, Date.now())
  }
  /**
   * A recovery contact who has accepted, made active at once (the protection delay is written past here, as M3 of
   * password-session-routes.test.ts writes a signed instruction). With a passkey unless `passkey` is false.
   */
  async function activeContact(owner: ReturnType<typeof client>, key: ReturnType<typeof authenticatorFor>, handle: string, opts: { passkey: boolean }) {
    const helper = client()
    if (opts.passkey) await signUp(helper.ok, authenticatorFor(PORT), handle, `Helper ${handle}`)
    else await helper.ok('POST', '/api/auth/signup', { handle, password: 'the helper own long phrase', displayName: `Helper ${handle}` })
    await stepUp(owner.ok, key)
    const { linkId } = await owner.ok('POST', '/api/security/contacts', { handle })
    await helper.ok('POST', `/api/security/contacts/${linkId}/accept`)
    api.ctx.db.run('UPDATE recovery_contacts SET effective_at = ? WHERE id = ?', Date.now() - 1000, linkId)
    return { helper, linkId: linkId as string }
  }

  it('with no passkey, the current password typed again changes it; the new one passes the sign-up rules; every other session ends', async () => {
    const owner = client(), elsewhere = client(), PW = 'the first long pass phrase', NEW = 'a second long pass phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'pw-change', password: PW, displayName: 'Changing Person' })
    await elsewhere.ok('POST', '/api/auth/login', { handle: 'pw-change', password: PW })
    const before = hashOf('pw-change')
    const change = (body: unknown) => owner.call('POST', '/api/security/password', body)
    // the sign-up session is fresh from the password, and still the current password must come with the change
    const bare = await change({ password: NEW })
    expect([...answer(bare), bare.json.error?.message]).toEqual([401, 'stepup_required', null, 'Enter your password again to change your password.'])
    expect(answer(await change({ current: 'not the password at all', password: NEW }))).toEqual([401, 'bad_credentials', { current: 'That is not the password this account has now.' }])
    // the sign-up rules, each on the new password's own field
    expect(answer(await change({ current: PW, password: 'short' }))).toEqual([400, 'invalid', { password: 'Use at least 10 characters.' }])
    expect(answer(await change({ current: PW, password: 'qwerty12345' }))).toEqual([400, 'invalid', { password: 'That password is too easy to guess.' }])
    expect(answer(await change({ current: PW, password: 'my handle pw-change here' }))).toEqual([400, 'invalid', { password: 'That password is too easy to guess.' }])
    expect(answer(await change({ current: PW, password: PW }))).toEqual([400, 'invalid', { password: 'That is the password this account has now. Choose a different one.' }])
    expect(hashOf('pw-change')).toBe(before)
    // a session that had already lapsed weeks ago is not counted as one signed out now (review L4)
    api.ctx.db.run(`INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, csrf, ua) SELECT ?, id, 1, 1, 2, 'x', 'an old browser' FROM users WHERE handle = 'pw-change'`, 'f'.repeat(64))
    // the change: the other session ends, this one stays
    expect((await owner.ok('POST', '/api/security/password', { current: PW, password: NEW }))).toEqual({ ok: true, ended: 1 })
    expect(hashOf('pw-change')).not.toBe(before)
    expect(hashOf('pw-change').startsWith('scrypt$')).toBe(true)
    expect(answer(await elsewhere.call('GET', '/api/security'))).toEqual([401, 'signed_out', null])
    const view = await owner.ok('GET', '/api/security')
    expect(view.sessions).toHaveLength(1)
    expect(view.password).toMatchObject({ set: true, changedAt: expect.any(Number) })
    expect(view.events.map((e: J) => e.kind)).toContain('password-changed')
    // the old password no longer signs in; the new one does
    expect(answer(await client().call('POST', '/api/auth/login', { handle: 'pw-change', password: PW }))).toEqual([401, 'bad_credentials', null])
    expect((await client().ok('POST', '/api/auth/login', { handle: 'pw-change', password: NEW })).csrf).toEqual(expect.any(String))
    expect(api.ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit a JOIN users u ON u.id = a.user_id WHERE u.handle = 'pw-change' AND a.action = 'password.change'`)?.n).toBe(1)
  }, 60_000)

  it('wrong current passwords share the step-up limit: after eight in fifteen minutes even the right one waits, on either route', async () => {
    const owner = client(), PW = 'a guarded long pass phrase', NEW = 'a replacement long phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'pw-guess', password: PW, displayName: 'Guarded Person' })
    const before = hashOf('pw-guess')
    for (let i = 0; i < 8; i++) expect(answer(await owner.call('POST', '/api/security/password', { current: `wrong guess number ${i}`, password: NEW }))[0]).toBe(401)
    expect(answer(await owner.call('POST', '/api/security/password', { current: PW, password: NEW })).slice(0, 2)).toEqual([429, 'too_many'])
    expect(answer(await owner.call('POST', '/api/auth/stepup', { password: PW })).slice(0, 2)).toEqual([429, 'too_many'])
    expect(hashOf('pw-guess')).toBe(before)
    expect(answer(await client().call('POST', '/api/auth/login', { handle: 'pw-guess', password: NEW }))[0]).toBe(401)
  }, 60_000)

  it('on an account with a passkey, a password session cannot change it, even with the current password; a fresh passkey confirmation can, without it', async () => {
    const PW = 'phished long pass phrase', NEW = 'the owner chose this one'
    const { owner, key } = await passwordAccountWithPasskey('pw-phished', PW)
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'pw-phished', password: PW })
    await thief.ok('POST', '/api/auth/stepup', { password: PW })
    const refused = await thief.call('POST', '/api/security/password', { current: PW, password: 'the thief chose this one' })
    expect([...answer(refused), refused.json.error?.message]).toEqual([401, 'stepup_required', null, 'Confirm with one of your passkeys to change your password.'])
    // the owner's session, opened with the password too: not fresh from a passkey, so asked the same
    api.ctx.db.run(`UPDATE sessions SET stepup_at = 0 WHERE user_id = (SELECT id FROM users WHERE handle = 'pw-phished')`)
    expect(answer(await owner.call('POST', '/api/security/password', { password: NEW })).slice(0, 2)).toEqual([401, 'stepup_required'])
    await stepUp(owner.ok, key)
    expect(await owner.ok('POST', '/api/security/password', { password: NEW })).toEqual({ ok: true, ended: 1 })
    expect(answer(await thief.call('GET', '/api/security'))).toEqual([401, 'signed_out', null])
    expect(answer(await client().call('POST', '/api/auth/login', { handle: 'pw-phished', password: PW }))[0]).toBe(401)
    await client().ok('POST', '/api/auth/login', { handle: 'pw-phished', password: NEW })
  }, 60_000)

  it('removing it needs a passkey, a way back in without it (an unused saved code and an active recovery contact) and a fresh passkey confirmation', async () => {
    const PW = 'a removable long phrase'
    // with no passkey the password is the only key: it cannot be removed
    const alone = client()
    await alone.ok('POST', '/api/auth/signup', { handle: 'pw-alone', password: PW, displayName: 'Alone' })
    expect(answer(await alone.call('POST', '/api/security/password/remove'))).toEqual([409, 'passkey_needed', null])
    expect(hashOf('pw-alone')).not.toBe('!')

    const { owner, key, made } = await passwordAccountWithPasskey('pw-remove', PW)
    const remove = () => owner.call('POST', '/api/security/password/remove')
    // a session not fresh from a passkey is asked for one first (the sign-up's password freshness is not one)
    const stale = await remove()
    expect([...answer(stale), stale.json.error?.message]).toEqual([401, 'stepup_required', null, 'Confirm with one of your passkeys to remove your password.'])
    // and a password session never gets one
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'pw-remove', password: PW })
    await thief.ok('POST', '/api/auth/stepup', { password: PW })
    expect(answer(await thief.call('POST', '/api/security/password/remove')).slice(0, 2)).toEqual([401, 'stepup_required'])
    // confirmed, with no recovery contact: without the password, losing every passkey would lose the account
    await stepUp(owner.ok, key)
    const noContact = await remove()
    expect(answer(noContact)).toEqual([409, 'no_way_back', null])
    expect(noContact.json.error.message).toMatch(/recovery contact/)
    // a contact named and accepted, but not active until the protection delay has passed
    const helper = client(), helperKey = authenticatorFor(PORT)
    await signUp(helper.ok, helperKey, 'pw-helper', 'Helper')
    const { linkId } = await owner.ok('POST', '/api/security/contacts', { handle: 'pw-helper' })
    await helper.ok('POST', `/api/security/contacts/${linkId}/accept`)
    expect(answer(await remove())).toEqual([409, 'no_way_back', null])
    api.ctx.db.run('UPDATE recovery_contacts SET effective_at = ? WHERE id = ?', Date.now() - 1000, linkId)
    // no unused saved code: a recovery needs one
    api.ctx.db.run(`UPDATE recovery_codes SET replaced_at = ? WHERE person_id = ? AND replaced_at IS NULL`, Date.now(), made.userId)
    const noCodes = await remove()
    expect(answer(noCodes)).toEqual([409, 'no_way_back', null])
    expect(noCodes.json.error.message).toMatch(/saved codes/)
    const made10 = (await owner.ok('POST', '/api/security/recovery-codes')).codes as string[] // none unused, one passkey: at once
    expect(made10).toHaveLength(10)

    // the way back exists and the confirmation is fresh: the removal is scheduled (8j (c)); the password works until then
    const asked = await owner.ok('POST', '/api/security/password/remove')
    expect(asked).toEqual({ ok: true, scheduled: true, changeId: expect.stringMatching(/^chg_/), effectiveAt: expect.any(Number) })
    expect(asked.effectiveAt - Date.now()).toBeGreaterThan(PROTECTION_DELAY_MS - 60_000)
    expect(hashOf('pw-remove')).not.toBe('!')
    expect((await thief.ok('GET', '/api/security')).password).toMatchObject({ set: true, removalScheduledFor: asked.effectiveAt, removalChangeId: asked.changeId })
    // asked again meanwhile: the same request
    expect(answer(await owner.call('POST', '/api/security/password/remove'))).toEqual([409, 'already_scheduled', null])
    // when it applies, the password is gone and every session it opened ends: the thief's, and this one (opened with it at sign-up)
    removalApplies('pw-remove')
    expect(hashOf('pw-remove')).toBe('!')
    expect(answer(await thief.call('GET', '/api/security'))).toEqual([401, 'signed_out', null])
    expect(answer(await owner.call('GET', '/api/security'))).toEqual([401, 'signed_out', null])
    await signIn(owner.ok, key) // back in with the passkey
    // the password now opens nothing: sign-in answers as for an unknown handle, a step-up is refused, and a recovery
    // started with a saved code and the password records nothing
    const login = await client().call('POST', '/api/auth/login', { handle: 'pw-remove', password: PW })
    const unknown = await client().call('POST', '/api/auth/login', { handle: 'nobody-here', password: PW })
    expect([login.status, login.json]).toEqual([unknown.status, unknown.json])
    expect(answer(await owner.call('POST', '/api/auth/stepup', { password: PW })).slice(0, 2)).toEqual([401, 'bad_credentials'])
    const view = await owner.ok('GET', '/api/security')
    expect(view.password).toEqual({ set: false, changedAt: null })
    expect(view.secondMethod).toEqual({ contacts: 1, password: false })
    expect(view.events.map((e: J) => e.kind)).toContain('password-removed')
    const codes = (await owner.ok('POST', '/api/security/recovery-codes', { code: made10[0] })).codes as string[] // unused ones remain: one of them (H2)
    const started = await client().ok('POST', '/api/auth/recovery/start', { handle: 'pw-remove', code: codes[0], password: PW })
    expect(api.ctx.db.get('SELECT 1 FROM recovery_requests WHERE id = ?', started.requestId)).toBeUndefined()
    // nothing left to change or remove
    expect(answer(await remove())).toEqual([409, 'no_password', null])
    expect(answer(await owner.call('POST', '/api/security/password', { password: 'a brand new long phrase' }))).toEqual([409, 'no_password', null])
  }, 90_000)

  it('M3: attempts refused for want of a confirmation are not counted, so a phished password cannot use up the owner\'s; confirmed ones count, ten per person and thirty per address', async () => {
    const PW = 'a limited long pass phrase'
    const { owner, key } = await passwordAccountWithPasskey('pw-limit', PW)
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'pw-limit', password: PW })
    for (let i = 0; i < 12; i++) {
      expect(answer(await thief.call('POST', '/api/security/password', { password: 'the thief wants this one' }))[0]).toBe(401)
      expect(answer(await thief.call('POST', '/api/security/password/remove'))[0]).toBe(401)
    }
    // the owner, confirmed with the passkey, is not held up; each confirmed attempt counts, ten in fifteen minutes
    await stepUp(owner.ok, key)
    for (let i = 0; i < 10; i++) expect(answer(await owner.call('POST', '/api/security/password', { password: PW }))[0]).toBe(400) // the same password
    expect(answer(await owner.call('POST', '/api/security/password', { password: PW })).slice(0, 2)).toEqual([429, 'too_many'])
    for (let i = 0; i < 10; i++) expect(answer(await owner.call('POST', '/api/security/password/remove'))[0]).toBe(409) // no recovery contact
    expect(answer(await owner.call('POST', '/api/security/password/remove')).slice(0, 2)).toEqual([429, 'too_many'])
    // thirty from one address, whoever asks: with the address's count at thirty, another person's confirmed attempt waits
    const atAddress = api.ctx.db.get<{ key: string }>(`SELECT key FROM rate_limits WHERE key LIKE 'password-change:%'`)!.key
    api.ctx.db.run('UPDATE rate_limits SET count = 30 WHERE key = ?', atAddress)
    const other = await passwordAccountWithPasskey('pw-limit-b', PW)
    await stepUp(other.owner.ok, other.key)
    expect(answer(await other.owner.call('POST', '/api/security/password', { password: 'another brand new phrase' })).slice(0, 2)).toEqual([429, 'too_many'])
  }, 60_000)

  it('M4: wrong passwords sent together are each counted before any is checked: eight are tried, the rest refused, and the change route shares the count', async () => {
    const owner = client(), PW = 'a burst guarded phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'pw-burst', password: PW, displayName: 'Burst' })
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => owner.call('POST', '/api/auth/stepup', { password: `wrong burst guess ${i}` })))
    expect(burst.filter((r) => r.status === 401)).toHaveLength(8)
    expect(burst.filter((r) => r.status === 429)).toHaveLength(4)
    expect(answer(await owner.call('POST', '/api/security/password', { current: PW, password: 'a fresh new long phrase' })).slice(0, 2)).toEqual([429, 'too_many'])
    // a right password is given back: an owner who confirms many times in a row is never held up by it
    const calm = client()
    await calm.ok('POST', '/api/auth/signup', { handle: 'pw-calm', password: PW, displayName: 'Calm' })
    for (let i = 0; i < 10; i++) await calm.ok('POST', '/api/auth/stepup', { password: PW })
  }, 60_000)

  it('M1: a recovery contact with no passkey cannot issue a code, so does not count as a way back in until they add one', async () => {
    const PW = 'a careful long pass phrase'
    const { owner, key } = await passwordAccountWithPasskey('pw-m1', PW)
    const { helper, linkId } = await activeContact(owner, key, 'pw-m1-helper', { passkey: false })
    // the contact, with only a password, cannot issue the code a recovery would need
    expect(answer(await helper.call('POST', `/api/security/contacts/${linkId}/code`)).slice(0, 2)).toEqual([401, 'stepup_required'])
    const refused = await owner.call('POST', '/api/security/password/remove')
    expect(answer(refused)).toEqual([409, 'no_way_back', null])
    expect(refused.json.error.message).toMatch(/no passkey/)
    expect((await owner.ok('GET', '/api/security')).contacts[0]).toMatchObject({ active: true, hasPasskey: false })
    // the contact adds a passkey (their sign-up's password freshness allows the first): now they count
    const b = await helper.ok('POST', '/api/security/passkeys/begin')
    await helper.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: authenticatorFor(PORT).create(b.options) })
    expect((await owner.ok('GET', '/api/security')).contacts[0]).toMatchObject({ active: true, hasPasskey: true })
    expect(await owner.ok('POST', '/api/security/password/remove')).toMatchObject({ ok: true, scheduled: true })
  }, 60_000)

  it('8j (c): the scheduled removal is cancelled from a session opened with the password only with a saved code, which is not used up', async () => {
    const PW = 'a cancellable long phrase'
    const { owner, key, codes } = await passwordAccountWithPasskey('pw-cancel', PW)
    await activeContact(owner, key, 'pw-cancel-helper', { passkey: true })
    await stepUp(owner.ok, key)
    const asked = await owner.ok('POST', '/api/security/password/remove')
    // the owner, without the device, signs in with the password elsewhere
    const laptop = client()
    await laptop.ok('POST', '/api/auth/login', { handle: 'pw-cancel', password: PW })
    await laptop.ok('POST', '/api/auth/stepup', { password: PW })
    const bare = await laptop.call('POST', `/api/security/changes/${asked.changeId}/cancel`)
    expect([...answer(bare), bare.json.error?.message]).toEqual([401, 'stepup_required', null, 'Confirm with one of your passkeys, or enter one of your saved recovery codes, to cancel it.'])
    expect(answer(await laptop.call('POST', `/api/security/changes/${asked.changeId}/cancel`, { code: 'AAAA-BBBB-CCCC-DDDD' })).slice(0, 2)).toEqual([403, 'code_wrong'])
    expect(await laptop.ok('POST', `/api/security/changes/${asked.changeId}/cancel`, { code: codes[0] })).toEqual({ ok: true, cancelled: true, with: 'saved-code' })
    const view = await owner.ok('GET', '/api/security')
    expect(view.recoveryCodesLeft).toBe(10)
    expect(view.password).toMatchObject({ set: true, removalScheduledFor: null, removalChangeId: null })
    expect(view.events.find((e: J) => e.kind === 'change-cancelled')?.detail).toMatchObject({ kind: 'remove-password', with: 'saved-code' })
    applyDueChanges(api.ctx.db, asked.effectiveAt + 1)
    expect(hashOf('pw-cancel')).not.toBe('!')
  }, 60_000)

  it('M2: suspending a passkey also withdraws the confirmation it gave a session it did not open', async () => {
    const PW = 'a twice keyed long phrase'
    const { owner, key } = await passwordAccountWithPasskey('pw-suspend', PW)
    // a second passkey, as on a second device, which the thief has
    await stepUp(owner.ok, key)
    const stolen = authenticatorFor(PORT)
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    const p2 = (await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: stolen.create(b.options) })).passkey as { id: string }
    // the thief signs in with the phished password and confirms with the stolen passkey
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'pw-suspend', password: PW })
    await stepUp(thief.ok, stolen)
    // the owner sees it and suspends that passkey at once, from a session confirmed with the first
    // it leaves a single usable passkey, so it needs a saved code (H2); known codes are made here for the test
    const saved = makeRecoveryCodes(api.ctx.db, api.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', 'pw-suspend')!.id, Date.now())
    await owner.ok('POST', `/api/security/passkeys/${p2.id}/suspend`, { code: saved[0] })
    const before = hashOf('pw-suspend')
    const r = await thief.call('POST', '/api/security/password', { password: 'the thief chose this one' })
    expect(answer(r).slice(0, 2)).toEqual([401, 'stepup_required'])
    expect(answer(await thief.call('POST', '/api/security/recovery-codes')).slice(0, 2)).toEqual([401, 'stepup_required'])
    expect(hashOf('pw-suspend')).toBe(before)
    // the owner's own session keeps its confirmation
    expect(await owner.ok('POST', '/api/security/password', { password: 'the owner chose this one' })).toMatchObject({ ok: true })
  }, 60_000)

  it('L1: the live event stream of a session the change ends closes at once', async () => {
    const owner = client(), elsewhere = client(), PW = 'a streaming long phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'pw-stream', password: PW, displayName: 'Streaming' })
    await elsewhere.ok('POST', '/api/auth/login', { handle: 'pw-stream', password: PW })
    const res = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { cookie: elsewhere.cookie() } })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read() // the hello frame
    await owner.ok('POST', '/api/security/password', { current: PW, password: 'a new streaming phrase' })
    const closed = await Promise.race([(async () => { for (;;) if ((await reader.read()).done) return true })(), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))])
    await reader.cancel().catch(() => {})
    expect(closed).toBe(true)
  }, 30_000)

  it('L2: a session ended while its change is being checked changes nothing', async () => {
    const owner = client(), elsewhere = client(), PW = 'a racing long pass phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'pw-race', password: PW, displayName: 'Racing' })
    await elsewhere.ok('POST', '/api/auth/login', { handle: 'pw-race', password: PW })
    const before = hashOf('pw-race')
    const mine = ((await owner.ok('GET', '/api/security')).sessions as J[]).find((x) => x.current)!.id as string
    // the change takes three password hashes (about half a second); the other session ends this one meanwhile
    const [changed, ended] = await Promise.all([owner.call('POST', '/api/security/password', { current: PW, password: 'a racing new long phrase' }), elsewhere.call('POST', `/api/security/sessions/${mine}/revoke`)])
    expect(ended.status).toBe(200)
    expect(answer(changed).slice(0, 2)).toEqual([401, 'signed_out'])
    expect(hashOf('pw-race')).toBe(before)
  }, 30_000)

  it('L5: removing the password also clears a sign-in lock, so the handle answers as an unknown one at once', async () => {
    const PW = 'a locked long pass phrase'
    const { owner, key } = await passwordAccountWithPasskey('pw-locked', PW)
    await activeContact(owner, key, 'pw-locked-helper', { passkey: true })
    for (let i = 0; i < 5; i++) await client().call('POST', '/api/auth/login', { handle: 'pw-locked', password: `a wrong guess ${i}` })
    expect(answer(await client().call('POST', '/api/auth/login', { handle: 'pw-locked', password: PW })).slice(0, 2)).toEqual([429, 'locked'])
    await stepUp(owner.ok, key)
    await owner.ok('POST', '/api/security/password/remove')
    removalApplies('pw-locked') // scheduled since R14 (8j (c)); the lock is cleared when it applies
    const login = await client().call('POST', '/api/auth/login', { handle: 'pw-locked', password: PW })
    const unknown = await client().call('POST', '/api/auth/login', { handle: 'nobody-at-all', password: PW })
    expect([login.status, login.json]).toEqual([unknown.status, unknown.json])
  }, 60_000)
})
