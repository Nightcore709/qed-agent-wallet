/**
 * Every request that changes something is one transaction (R13 hardening brief item 2): a failure part-way, a full disk
 * included, leaves nothing of the request. Before, a handler outside the ledger and approval paths committed each of its
 * steps on its own: PATCH /api/profile saved the profile, then wrote its audit entry; a disk that filled between the two
 * kept the change without its record.
 *
 * The failure is made by a trigger that refuses the request's last write (its audit entry) with SQLite's own "database or
 * disk is full" message, so the API answers as it does for a full disk (507). The seeded twin runs the same two writes
 * without one transaction and shows the change kept without its audit entry: the invariant can fail, and the trigger works.
 *
 * Rate-limit counters are kept apart (Db.keep): a request that is counted and then fails rolls back whole, and its
 * attempt still counts, so a burst of refused attempts uses its allowance up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { rateLimit } from './auth.ts'
import { audit, loadConfig, openDb } from './core.ts'
import { DEFAULT_OPENING, getProfile, openHousehold } from './household.ts'
import { changeProfile } from './loosening.ts'
import { seedRegistry } from './registry.ts'

const T0 = Date.UTC(2026, 10, 24, 6, 0)
const FAIL_PROFILE_AUDIT = `CREATE TRIGGER fail_profile_audit BEFORE INSERT ON audit WHEN NEW.action = 'profile.update' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`

describe('rate-limit counts are kept apart from the request\'s transaction (Db.keep)', () => {
  it('a count made in a transaction that rolls back is written again after it; plain writes are not', () => {
    const db = openDb(':memory:')
    expect(() => db.tx(() => { rateLimit(db, 'k', 3, 60_000, T0); db.run(`INSERT INTO meta (key, value) VALUES ('plain', 'x')`); throw new Error('a later step failed') })).toThrow(/later step/)
    expect(db.get('SELECT count FROM rate_limits WHERE key = ?', 'k')).toEqual({ count: 1 })
    expect(db.get(`SELECT 1 FROM meta WHERE key = 'plain'`)).toBeUndefined()
    // inside a savepoint that rolls back while the request goes on and commits: kept once, not twice
    db.tx(() => { try { db.tx(() => { rateLimit(db, 'k', 3, 60_000, T0); throw new Error('inner') }) } catch { /* the request carries on */ } })
    expect(db.get('SELECT count FROM rate_limits WHERE key = ?', 'k')).toEqual({ count: 2 })
    // a burst of attempts that each fail after being counted uses the allowance up
    for (let i = 0; i < 3; i++) { try { db.tx(() => { if (!rateLimit(db, 'k', 3, 60_000, T0)) throw new Error('refused'); throw new Error('failed after counting') }) } catch { /* each attempt fails */ } }
    expect(rateLimit(db, 'k', 3, 60_000, T0)).toBe(false)
  })

  it('the seeded twin: without the request transaction, a refused last write leaves the first one (the profile changed, no audit)', () => {
    const db = openDb(':memory:')
    seedRegistry(db, { presentation: true })
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_twin', 'twin', 'Twin', '!', ?, 'person')`, T0)
    openHousehold(db, 'usr_twin', DEFAULT_OPENING, {}, T0)
    db.exec(FAIL_PROFILE_AUDIT)
    const before = getProfile(db, 'usr_twin').line
    changeProfile(db, { personId: 'usr_twin', workspaceId: 'usr_twin', fresh: true }, { line: before + 100_000 }, T0)
    expect(() => audit(db, T0, 'usr_twin', 'owner', 'profile.update', null, {})).toThrow(/disk is full/)
    expect(getProfile(db, 'usr_twin').line).toBe(before + 100_000)
    expect(db.get(`SELECT 1 FROM audit WHERE action = 'profile.update'`)).toBeUndefined()
  })
})

describe('over HTTP, a changing request is one transaction', () => {
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const dir = mkdtempSync(join(tmpdir(), 'qed-request-tx-'))
  const dbPath = join(dir, 'qed.db')
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: dbPath, QED_API_PORT: String(PORT), QED_PRESENTATION: '1' })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  let cookie = '', csrf = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }

  it('PATCH /api/profile refused at its audit entry (a full disk) changes nothing: 507, the profile as it was, no entry', async () => {
    expect((await call('POST', '/api/auth/signup', { handle: 'txowner', password: 'a long enough pass phrase', displayName: 'Tx Owner' })).status).toBe(200)
    const { json: { profile } } = await call('POST', '/api/household', {})
    const side = new DatabaseSync(dbPath)
    try { side.exec('PRAGMA busy_timeout = 5000'); side.exec(FAIL_PROFILE_AUDIT) } finally { side.close() }
    const r = await call('PATCH', '/api/profile', { line: profile.line + 100_000 })
    expect([r.status, r.json.error?.code]).toEqual([507, 'storage_full'])
    const me = await call('GET', '/api/session')
    expect(me.json.profile.line).toBe(profile.line)
    expect(api.ctx.db.get(`SELECT 1 FROM audit WHERE action = 'profile.update'`)).toBeUndefined()
    // with the trigger gone the same request succeeds: the refusal was the failed write, nothing else
    const side2 = new DatabaseSync(dbPath)
    try { side2.exec('PRAGMA busy_timeout = 5000'); side2.exec('DROP TRIGGER fail_profile_audit') } finally { side2.close() }
    expect((await call('PATCH', '/api/profile', { line: profile.line + 100_000 })).status).toBe(200)
    expect((await call('GET', '/api/session')).json.profile.line).toBe(profile.line + 100_000)
  })
})
