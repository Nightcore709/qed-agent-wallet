/**
 * Schema v10, part (a) (R14, Priority 1: account access). Production holds real accounts at schema 9 (the watchlist's v9 step
 * is released first; v8 databases step through both). This step adds two
 * nullable columns to users (the address an account is created with, and its lower-cased form) and three tables made by
 * schema.sql (the per-address sign-in tags, Google identities, and the short-lived states of an OpenID Connect sign-in).
 * It writes nothing: every account that exists keeps its handle, its password hash, its passkeys with the authority they
 * had, its saved codes, its sessions and its addresses, and gains no email sign-in, no Google identity and no new
 * permission. As every migration, it runs only after an encrypted, verified copy is sealed (keys made for this run).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { login, sessionFor } from './auth.ts'
import { listManifests } from './backup.ts'
import { openDb, SCHEMA_VERSION } from './core.ts'
import { testKeys } from './key-fixture.ts'
import { seedRegistry } from './registry.ts'
import { makeRecoveryCodes, signUpWithPassword, startRecovery } from './passkeys.ts'
import { toSchemaV9, V10_COLUMNS, V10_TABLES, V9_TABLES } from './schema-fixture.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v9-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 20, 10, 0)
const PW = 'a long and private phrase 7'
const columns = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
const tables = (d: DatabaseSync): string[] => (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)

/**
 * A database as schema v9 left it (with a watchlist row), with the accounts production has: one opened with a handle and a password (with its
 * ten saved codes and a confirmed email address, as v8 and v9 made and kept them), and one opened with a passkey and no password.
 */
async function v9Database(): Promise<{ path: string; meera: string; codes: string[]; session: string }> {
  const path = join(tempFolder('qed-v9-'), 'qed.db')
  const db = openDb(path)
  const m = await signUpWithPassword(db, { handle: 'meera', password: PW, displayName: 'Meera Nair' }, META, T0)
  const codes = makeRecoveryCodes(db, m.personId, T0) // v8 made them at sign-up
  db.run(`INSERT INTO contact_points (id, person_id, kind, address, address_key, created_at, verified_at, usable_from) VALUES ('cpt_m', ?, 'email', 'Meera@Example.in', 'meera@example.in', ?, ?, ?)`, m.personId, T0, T0, T0)
  db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_p', 'asha', 'Asha', '!', ?, 'person')`, T0)
  db.run(`INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, name, created_at, authority) VALUES ('cred_p', 'usr_p', x'00', '00', '00', 'Passkey on a Mac', ?, 'full')`, T0)
  seedRegistry(db)
  const instrument = db.get<{ id: string }>('SELECT id FROM instruments ORDER BY id LIMIT 1')!.id
  db.run(`INSERT INTO watchlist_items (user_id, instrument_id, added_at, added_role, price_type) VALUES (?, ?, ?, 'owner', 'nav')`, m.personId, instrument, T0)
  db.close()
  toSchemaV9(path)
  return { path, meera: m.personId, codes, session: m.session.token }
}

describe('schema v10 (a): account access, on a v9 database', () => {
  it('a v9 database has none of what the step adds, keeps its watchlist, and says it is at 9', async () => {
    expect(SCHEMA_VERSION).toBe('10')
    const { path } = await v9Database()
    const raw = new DatabaseSync(path, { readOnly: true })
    try {
      for (const [t, c] of V10_COLUMNS) expect(columns(raw, t)).not.toContain(c)
      for (const t of V10_TABLES) expect(tables(raw)).not.toContain(t)
      expect((raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('9')
      expect(tables(raw)).toEqual(expect.arrayContaining([...V9_TABLES]))
    } finally { raw.close() }
  }, 30_000)

  it('migrates after its copy is sealed; every account keeps its credentials, codes, addresses and session, and gains nothing', async () => {
    const { path, meera, codes, session } = await v9Database()
    const before = new DatabaseSync(path, { readOnly: true })
    const users = before.prepare('SELECT id, handle, display_name, pw_hash, created_at, kind, failed_logins, locked_until, authority_hold_at, password_reset_at FROM users ORDER BY id').all()
    const creds = before.prepare('SELECT id, person_id, authority, cool_off_until, removed_at, suspended_at FROM webauthn_credentials ORDER BY id').all()
    const saved = before.prepare('SELECT id, person_id, salt, code_hash, algo, used_at, replaced_at FROM recovery_codes ORDER BY id').all()
    const points = before.prepare('SELECT * FROM contact_points ORDER BY id').all()
    before.close()

    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      expect(db.all('SELECT id, handle, display_name, pw_hash, created_at, kind, failed_logins, locked_until, authority_hold_at, password_reset_at FROM users ORDER BY id')).toEqual(users)
      expect(db.all('SELECT id, person_id, authority, cool_off_until, removed_at, suspended_at FROM webauthn_credentials ORDER BY id')).toEqual(creds)
      expect(db.all('SELECT id, person_id, salt, code_hash, algo, used_at, replaced_at FROM recovery_codes ORDER BY id')).toEqual(saved)
      expect(db.all('SELECT * FROM contact_points ORDER BY id')).toEqual(points)
      // the watchlist row the v9 step left is untouched
      expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM watchlist_items')).toEqual({ n: 1 })
      // nothing is attached to anyone: no sign-in address, no tag, no Google identity
      expect(db.all('SELECT id FROM users WHERE email IS NOT NULL OR email_key IS NOT NULL')).toEqual([])
      for (const t of V10_TABLES) expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)).toEqual({ n: 0 })
      // the session opened before the migration is still that person's, and still a password session
      expect(sessionFor(db, session, T0 + 60_000)).toMatchObject({ userId: meera, authMethod: 'password', stepUpFresh: false })
      // the handle and password sign in as before
      expect((await login(db, { handle: 'meera', password: PW }, META, T0 + 120_000)).userId).toBe(meera)
      // a confirmed address of an existing account is not made a sign-in name by the migration: the same password with it opens nothing
      await expect(login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 130_000)).rejects.toMatchObject({ code: 'bad_credentials' })
      // a saved code made under v8 still starts a recovery with the password beside it
      const r = await startRecovery(db, { handle: 'meera', code: codes[0], password: PW }, '127.0.0.1', T0 + 140_000)
      expect(db.get('SELECT person_id, method FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ person_id: meera, method: 'saved+password' })
    } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  }, 60_000)

  it('migrates once: opening it again changes nothing and seals no second copy', async () => {
    const { path } = await v9Database()
    openDb(path).close()
    const db = openDb(path)
    try { expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION }) } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  }, 30_000)

  it('a new database has the same users columns and the same new tables as a migrated one', async () => {
    const created = openDb(join(tempFolder('qed-v9-new-'), 'qed.db'))
    const migrated = openDb((await v9Database()).path)
    try {
      const cols = (d: typeof created, t: string) => d.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(${t})`).map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`).sort()
      for (const t of ['users', ...V10_TABLES]) expect(cols(migrated, t)).toEqual(cols(created, t))
      const idx = (d: typeof created) => d.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((i) => i.name)
      expect(idx(migrated)).toEqual(idx(created))
    } finally { created.close(); migrated.close() }
  }, 30_000)

  it('a v8 database steps through both v9 (the watchlist) and v10 (account access) after one sealed copy, and keeps every account', async () => {
    const { path, meera, codes } = await v9Database()
    // the file is at v9 (toSchemaV9 ran): take the watchlist's table out and set 8, the shape production has today
    const down = new DatabaseSync(path)
    try { for (const t of V9_TABLES) down.exec(`DROP TABLE IF EXISTS ${t}`); down.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`) } finally { down.close() }
    const raw = new DatabaseSync(path, { readOnly: true })
    try {
      expect((raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('8')
      for (const t of [...V9_TABLES, ...V10_TABLES]) expect(tables(raw)).not.toContain(t)
    } finally { raw.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM watchlist_items')).toEqual({ n: 0 })
      for (const t of V10_TABLES) expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)).toEqual({ n: 0 })
      expect(db.all('SELECT id FROM users WHERE email IS NOT NULL OR email_key IS NOT NULL')).toEqual([])
      expect((await login(db, { handle: 'meera', password: PW }, META, T0 + 120_000)).userId).toBe(meera)
      const r = await startRecovery(db, { handle: 'meera', code: codes[0], password: PW }, '127.0.0.1', T0 + 140_000)
      expect(db.get('SELECT person_id FROM recovery_requests WHERE id = ?', r.requestId)).toEqual({ person_id: meera })
    } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  }, 60_000)
})
