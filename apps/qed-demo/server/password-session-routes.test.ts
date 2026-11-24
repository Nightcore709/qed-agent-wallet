/**
 * What a session opened with a password cannot do, over HTTP against the real API server (D-094, RISK-076). A
 * password can be phished and a passkey cannot, so a password session reads and sets up, but everything that
 * weakens a protection or restores spending authority asks for a fresh passkey confirmation, which a password never
 * gives: lowering the floor, clearing a pause of QED, opening a business, and resuming a paused instruction. A
 * session opened with a passkey still resumes an instruction directly, as before.
 *
 * Added after the review of D-094 (23 Nov): a recovery is finished only with the reference its starter was given, not
 * with the id every session of the account can see (H1); cancelling a recovery needs the strongest confirmation the
 * account can give (M1); a password re-entry unlocks one passkey, the first, even when two ceremonies race (M2); and a
 * password session cannot switch protective selling off (M3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (a fixed port let one run's
// requests reach another's server). Was 9411.
const PORT = 20000 + Math.floor(Math.random() * 20000)

describe('a session opened with a password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-password-routes-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }

  it('sets up a household, but lowering the floor, clearing a pause, opening a business and resuming an instruction all ask for a passkey', async () => {
    const a = client()
    await a.ok('POST', '/api/auth/signup', { handle: 'pwroutes', password: 'a long enough pass phrase', displayName: 'Password Person' })
    const me = await a.ok('GET', '/api/session')
    expect(me).toMatchObject({ authenticated: true, authMethod: 'password', stepUpFresh: false, hasPasskey: false })
    const { profile } = await a.ok('POST', '/api/household', {})
    // strengthening is allowed
    await a.ok('PATCH', '/api/profile', { line: profile.line + 1000 })
    const refused = async (m: string, p: string, b?: unknown) => { const r = await a.call(m, p, b); return [r.status, r.json.error?.code] }
    expect(await refused('PATCH', '/api/profile', { line: Math.max(0, profile.line - 5000) })).toEqual([401, 'stepup_required'])
    await a.ok('POST', '/api/stop', { reason: 'testing' })
    expect(await refused('POST', '/api/stop/clear')).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/workspaces', { name: 'A shop' })).toEqual([401, 'stepup_required'])
    // the guard comes before the instruction is looked up, so it answers the same for any instruction
    expect(await refused('POST', '/api/programs/prg_none/resume')).toEqual([401, 'stepup_required'])
  })

  it('a session opened with a passkey also confirms afresh to resume (Q-059); confirmed, it reaches the instruction itself (and is told it does not exist)', async () => {
    const b = client(), kb = authenticatorFor(PORT)
    await signUp(b.ok, kb, 'pkroutes', 'Passkey Person')
    api.ctx.db.run('UPDATE sessions SET stepup_at = 0')
    // never a passkey session alone (the R13 hardening brief, item 4): a confirmation older than five minutes is refused
    expect(await b.call('POST', '/api/programs/prg_none/resume').then((r) => [r.status, (r.json as { error?: { code?: string } })?.error?.code])).toEqual([401, 'stepup_required'])
    api.ctx.db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'passkey', stepup_credential_id = credential_id`, Date.now())
    const r = await b.call('POST', '/api/programs/prg_none/resume')
    expect(r.status).not.toBe(401)
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('H1: a recovery is finished only with the reference its starter was given, never with the id a session can see', async () => {
    const owner = client(), PW = 'a long enough pass phrase'
    const made = await owner.ok('POST', '/api/auth/signup', { handle: 'rec-h1', password: PW, displayName: 'Recovering Person' })
    // someone holding the password signs in elsewhere, as a phished password would let them
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'rec-h1', password: PW })
    const started = await client().ok('POST', '/api/auth/recovery/start', { handle: 'rec-h1', code: made.recoveryCodes[0], password: PW })
    expect(started.reference).toMatch(/^rec_[a-z0-9]+\.[A-Za-z0-9_-]{24}$/)
    const seen = await thief.ok('GET', '/api/security')
    const id = seen.recoveries[0].id as string
    expect(id).toBe(started.requestId)
    // the id, the id with a made-up secret, and nothing at all are refused alike; the real reference is accepted (and
    // told to wait out the delay)
    for (const body of [{ requestId: id }, { reference: id }, { reference: `${id}.${'A'.repeat(24)}` }, {}]) {
      const r = await thief.call('POST', '/api/auth/recovery/passkey/begin', body)
      expect([r.status, r.json.error?.code]).toEqual([409, 'recovery_unavailable'])
    }
    const right = await client().call('POST', '/api/auth/recovery/passkey/begin', { reference: started.reference })
    expect([right.status, right.json.error?.code]).toEqual([409, 'recovery_waiting'])
    // a failed start answers in the same shape, with a reference that finishes nothing
    const failed = await client().ok('POST', '/api/auth/recovery/start', { handle: 'rec-h1', code: made.recoveryCodes[1], password: 'not the password at all' })
    expect(Object.keys(failed).sort()).toEqual(Object.keys(started).sort())
    const nothing = await client().call('POST', '/api/auth/recovery/passkey/begin', { reference: failed.reference })
    expect(nothing.json.error?.code).toBe('recovery_unavailable')
  })

  it('M1: on an account with a passkey, a password session cannot cancel a recovery or take the new codes; a passkey can', async () => {
    const owner = client(), key = authenticatorFor(PORT), PW = 'another long pass phrase'
    const made = await owner.ok('POST', '/api/auth/signup', { handle: 'rec-m1', password: PW, displayName: 'Careful Person' })
    // the sign-up session is fresh from the password: it adds the account's first passkey
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const started = await client().ok('POST', '/api/auth/recovery/start', { handle: 'rec-m1', code: made.recoveryCodes[0], password: PW })
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'rec-m1', password: PW })
    await thief.ok('POST', '/api/auth/stepup', { password: PW })
    const refused = await thief.call('POST', `/api/security/recoveries/${started.requestId}/cancel`)
    expect([refused.status, refused.json.error?.code, refused.json.codes]).toEqual([401, 'stepup_required', undefined])
    expect(refused.json.error?.message).toMatch(/passkey/)
    // nor can it make new codes
    expect((await thief.call('POST', '/api/security/recovery-codes')).status).toBe(401)
    // the owner confirms with the passkey and cancels; the new codes come back to the owner alone
    await stepUp(owner.ok, key)
    const done = await owner.ok('POST', `/api/security/recoveries/${started.requestId}/cancel`)
    expect(done).toMatchObject({ codes: [], codeSpent: true }) // H2 re-check: no new set handed to the canceller
  })

  it('M1: on an account with no passkey, cancelling needs the password typed again (the password is its only credential)', async () => {
    const owner = client(), PW = 'a third long pass phrase'
    const made = await owner.ok('POST', '/api/auth/signup', { handle: 'rec-m1b', password: PW, displayName: 'Password Only' })
    const started = await client().ok('POST', '/api/auth/recovery/start', { handle: 'rec-m1b', code: made.recoveryCodes[0], password: PW })
    const later = client()
    await later.ok('POST', '/api/auth/login', { handle: 'rec-m1b', password: PW })
    const stale = await later.call('POST', `/api/security/recoveries/${started.requestId}/cancel`)
    expect([stale.status, stale.json.error?.message]).toEqual([401, 'Enter your password again to cancel the recovery.'])
    await later.ok('POST', '/api/auth/stepup', { password: PW })
    expect((await later.ok('POST', `/api/security/recoveries/${started.requestId}/cancel`)).codes).toEqual([])
  })

  it('M2: a password re-entry unlocks one passkey, the first, even when two ceremonies were begun together', async () => {
    const owner = client(), PW = 'a fourth long pass phrase'
    await owner.ok('POST', '/api/auth/signup', { handle: 'race-m2', password: PW, displayName: 'Racing Person' })
    const mine = authenticatorFor(PORT), theirs = authenticatorFor(PORT)
    const a = await owner.ok('POST', '/api/security/passkeys/begin')
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: a.challengeId, response: mine.create(a.options) })
    const second = await owner.call('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: theirs.create(b.options) })
    expect([second.status, second.json.error?.code]).toEqual([409, 'not_first'])
    const keys = api.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM webauthn_credentials c JOIN users u ON u.id = c.person_id WHERE u.handle = 'race-m2'")
    expect(keys?.n).toBe(1)
  })

  it('M3: a password session pauses everything but protective selling, and cannot pause or revoke a floor or exit instruction', async () => {
    const owner = client(), key = authenticatorFor(PORT), PW = 'a fifth long pass phrase'
    const made = await owner.ok('POST', '/api/auth/signup', { handle: 'guard-m3', password: PW, displayName: 'Guarded Person' })
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    await owner.ok('POST', '/api/household', {})
    // an instruction that holds the floor, as signed earlier with the passkey (written here directly: signing one is
    // covered by the instruction journeys)
    const now = Date.now()
    api.ctx.db.run(`INSERT INTO programs (id, user_id, kind, pillar, title, state, live_version, origin, created_at, updated_at) VALUES ('prg_floor_m3', ?, 'floor', 'protect', 'Hold my floor', 'active', 1, 'owner', ?, ?)`, made.userId, now, now)
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'guard-m3', password: PW })
    for (const path of ['/api/programs/prg_floor_m3/pause', '/api/programs/prg_floor_m3/revoke']) {
      const r = await thief.call('POST', path)
      expect([path, r.status, r.json.error?.code]).toEqual([path, 401, 'stepup_required'])
    }
    expect(api.ctx.db.get<{ state: string }>("SELECT state FROM programs WHERE id = 'prg_floor_m3'")?.state).toBe('active')
    const stop = await thief.ok('POST', '/api/stop', { reason: 'testing', keepProtective: false })
    expect(stop.keptProtective).toBe(true)
    expect(api.ctx.db.get<{ stop_protective: number }>('SELECT stop_protective FROM users WHERE id = ?', made.userId)?.stop_protective).toBe(1)
    // the owner, with the passkey, may pause the floor instruction
    await stepUp(owner.ok, key)
    expect((await owner.ok('POST', '/api/programs/prg_floor_m3/pause')).program.state).toBe('paused')
  })
})
