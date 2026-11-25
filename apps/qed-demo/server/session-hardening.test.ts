/**
 * R13 hardening of accounts and sessions (ASVS 5.0 V6.1.2, V6.2.11, V6.3.5, V6.5.2, V7.1.2, V7.2.4, V11.2.4, V14.3.1):
 *   - passwords built from the service's name or the person's own name or handle are refused (context-specific words);
 *   - a person keeps at most MAX_SESSIONS sessions: a sign-in beyond it ends the least recently used, said in the history;
 *   - a sign-in ends the session the browser presented (a planted or copied token opens nothing after it);
 *   - five wrong passwords lock the password and tell the person at once;
 *   - saved recovery codes made before schema v3 (salted SHA-256) are put under scrypt by the v8 step, part (r), and still
 *     work, for the same person, until used or replaced;
 *   - signing out asks the browser to clear its cache (Clear-Site-Data) and is recorded.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { capSessions, contextual, login, MAX_SESSIONS, register, sessionFor, validateCredentials } from './auth.ts'
import { layerLegacyCodes, loadConfig, openDb } from './core.ts'
import { testKeys } from './key-fixture.ts'
import { matchCode, matchCodeAsync } from './passkeys.ts'
import { toSchemaV7 } from './schema-fixture.ts'

const T0 = Date.UTC(2026, 10, 24, 6, 0)
const META = { ip: '127.0.0.1', ua: 'test' }

describe('passwords: context-specific words (V6.1.2, V6.2.11)', () => {
  it('refuses a password built from the service\'s name or the person\'s own, and accepts one that only contains them', () => {
    for (const pw of ['QedWallet2026!', 'paperbank-1234', 'w4ll3t-qed-99', 'Meridian!!2026']) expect(contextual(pw), pw).toBe(true)
    expect(contextual('asha-sharma-1990', ['asha', 'Asha Sharma'])).toBe(true)
    for (const pw of ['qed is not my friend at all', 'correct horse battery staple', 'Tr0ub4dor&3-elephant']) expect(contextual(pw), pw).toBe(false)
    expect(() => validateCredentials('asha', 'QedWallet2026!')).toThrow(/Check the highlighted fields/)
    expect(() => validateCredentials('ravi', 'Ravi Kumar 2026!', 'Ravi Kumar')).toThrow()
    expect(validateCredentials('ravi', 'a long enough pass phrase', 'Ravi Kumar').password).toBe('a long enough pass phrase')
  })
})

describe('sessions (V7.1.2)', () => {
  it('keeps at most MAX_SESSIONS: the least recently used end, and the history says how many', async () => {
    const db = openDb(':memory:')
    const id = await register(db, { handle: 'many', password: 'a long enough pass phrase' }, META.ip, T0)
    const tokens: string[] = []
    for (let i = 0; i < MAX_SESSIONS + 2; i++) tokens.push((await login(db, { handle: 'many', password: 'a long enough pass phrase' }, META, T0 + i * 1000)).token)
    const live = tokens.filter((t) => sessionFor(db, t, T0 + 20_000) !== null)
    expect(live).toHaveLength(MAX_SESSIONS)
    expect(sessionFor(db, tokens[0], T0 + 20_000)).toBeNull()
    expect(sessionFor(db, tokens[1], T0 + 20_000)).toBeNull()
    expect(db.all<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? AND kind = 'sessions-ended-limit'`, id)).toHaveLength(2)
    expect(capSessions(db, id, T0 + 21_000)).toBe(0)
  })

  it('five wrong passwords lock the password and tell the person at once (V6.3.5)', async () => {
    const db = openDb(':memory:')
    const id = await register(db, { handle: 'guessed', password: 'a long enough pass phrase' }, META.ip, T0)
    for (let i = 0; i < 6; i++) await login(db, { handle: 'guessed', password: `wrong guess ${i}` }, META, T0 + i).catch(() => null)
    expect(db.get(`SELECT 1 FROM security_events WHERE person_id = ? AND kind = 'signin-locked'`, id)).toBeTruthy()
    expect(db.get<{ title: string }>(`SELECT title FROM notices WHERE user_id = ? AND kind = 'security-change'`, id)?.title).toMatch(/Wrong passwords were typed/)
  })
})

describe('saved codes made before v3 are put under scrypt (V6.5.2; part r of the v8 step)', () => {
  // Opening the v7 file migrates it, after sealing a copy under the migration-copy key: scratch keys in a folder of their
  // own, as the other migration suites have (without them the test used ~/.qed/keys, and a fresh GitHub runner has none).
  const keys = testKeys(mkdtempSync(join(tmpdir(), 'qed-layer-keys-')))
  const keyDirBefore = process.env.QED_KEY_DIR
  beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
  afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore; rmSync(dirname(keys.dir), { recursive: true, force: true }) })
  const sha = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`).digest('hex')

  it('layers every bare SHA-256 code when a v7 database is opened, and the same code still matches, sync and async', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-layer-'))
    try {
      const path = join(dir, 'qed.db')
      const db = openDb(path)
      db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_old', 'old', 'Old', '!', ?, 'person')`, T0)
      db.close()
      toSchemaV7(path)
      const raw = new DatabaseSync(path)
      raw.prepare(`INSERT INTO recovery_codes (id, person_id, salt, code_hash, created_at, algo) VALUES ('rcv_old', 'usr_old', 'abcdef0123456789', ?, ?, 'sha256')`).run(sha('abcdef0123456789', 'LEGA-CY2C-ODE3-ABCD'), T0)
      raw.close()
      const keepCopy = join(dir, 'before.db'); copyFileSync(path, keepCopy)
      const db2 = openDb(path)
      const row = db2.get<{ id: string; salt: string; code_hash: string; algo: string }>(`SELECT id, salt, code_hash, algo FROM recovery_codes WHERE id = 'rcv_old'`)!
      expect(row.algo).toBe('scrypt-sha256')
      expect(row.code_hash).not.toBe(sha('abcdef0123456789', 'LEGA-CY2C-ODE3-ABCD'))
      expect(db2.get<{ n: number }>(`SELECT COUNT(*) n FROM recovery_codes WHERE algo = 'sha256'`)!.n).toBe(0)
      expect(matchCode([row], 'LEGA-CY2C-ODE3-ABCD')?.id).toBe('rcv_old')
      expect((await matchCodeAsync([row], 'lega cy2c ode3 abcd'))?.id).toBe('rcv_old')
      expect(matchCode([row], 'LEGA-CY2C-ODE3-ABCE')).toBeUndefined()
      // idempotent
      expect(layerLegacyCodes(db2)).toBe(0)
      db2.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('over HTTP: sign-in ends the presented session; sign-out clears and is recorded (V7.2.4, V14.3.1, V16.3.1)', () => {
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const dir = mkdtempSync(join(tmpdir(), 'qed-session-hardening-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_PRESENTATION: '1' })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  const post = (path: string, body: unknown, cookie = '', csrf = '') => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qed-client': 'web', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-qed-csrf': csrf } : {}) }, body: JSON.stringify(body) })
  const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!

  it('a sign-in in a browser that presents a session ends that session; signing out sends Clear-Site-Data and is audited', async () => {
    const first = await post('/api/auth/signup', { handle: 'rotator', password: 'a long enough pass phrase', displayName: 'Rotator' })
    const before = cookieOf(first)
    const again = await post('/api/auth/login', { handle: 'rotator', password: 'a long enough pass phrase' }, before)
    expect(again.status).toBe(200)
    const after = cookieOf(again), csrf = ((await again.json()) as { csrf: string }).csrf
    expect(after).not.toBe(before)
    expect((await fetch(`http://127.0.0.1:${PORT}/api/home`, { headers: { cookie: before } })).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { cookie: after } }).then((r) => r.json()) as { authenticated: boolean }).authenticated).toBe(true)
    // a wrong CSRF token of the right length is refused like any other (compared in constant time)
    expect((await post('/api/stop', {}, after, 'x'.repeat(csrf.length))).status).toBe(403)
    const out = await post('/api/auth/logout', {}, after, csrf)
    expect(out.status).toBe(200)
    expect(out.headers.get('clear-site-data')).toBe('"cache"')
    expect(api.ctx.db.get(`SELECT 1 FROM audit WHERE action = 'logout'`)).toBeTruthy()
    expect(api.ctx.db.get(`SELECT 1 FROM audit WHERE action = 'session.replaced-by-sign-in'`)).toBeTruthy()
  })
})
