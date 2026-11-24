/**
 * Schema v7 (R12 recovery): a v6 database gains each passkey's approval authority (every existing passkey keeps 'full'),
 * the hold a reset or recovery leaves, how a recovery started and whether its ready message went, and the tables for
 * addresses, one-time tokens and outbound messages. As every migration, it runs only after an encrypted, verified copy
 * is sealed under the migration-copy key: keys made for this run (server/key-fixture.ts), never the owner's (~/.qed).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listManifests, restoreBackup } from './backup.ts'
import { openDb, SCHEMA_VERSION } from './core.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { toSchemaV6 } from './schema-fixture.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v7-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const columns = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
const tables = (d: DatabaseSync): string[] => (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)

/** A database as schema v6 left it: made by this build, then the v7 columns and tables taken out, with a passkey and a recovery in it. */
function v6Database(): string {
  const path = join(tempFolder('qed-v7-'), 'qed.db')
  const db = openDb(path)
  db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_a', 'asha', 'Asha', '!', 1, 'person')`)
  db.run(`INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, name, created_at) VALUES ('cred_a', 'usr_a', X'00', 'aa', 'bb', 'Passkey on a Mac', 1)`)
  db.run(`INSERT INTO recovery_requests (id, person_id, code_id, started_at, available_at, method) VALUES ('rec_a', 'usr_a', 'rcv_1', 1, 2, 'saved+contact')`)
  db.close()
  toSchemaV6(path)
  return path
}

describe('schema v7: approval authority, addresses, one-time tokens, outbound messages', () => {
  it('a v6 database migrates after its copy is sealed: every existing passkey keeps full authority, a recovery keeps its method', () => {
    // v7 is this file's step; the build migrates on past it (v8: a fund purchase's money received, the paper escrow, payee name checks), so the version it ends at is SCHEMA_VERSION.
    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(7)
    const path = v6Database()
    const before = new DatabaseSync(path, { readOnly: true })
    try { expect(columns(before, 'webauthn_credentials')).not.toContain('authority'); expect(tables(before)).not.toContain('contact_points') } finally { before.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      expect(db.get(`SELECT authority, authority_reason FROM webauthn_credentials WHERE id = 'cred_a'`)).toEqual({ authority: 'full', authority_reason: null })
      expect(db.get(`SELECT authority_hold_at FROM users WHERE id = 'usr_a'`)).toEqual({ authority_hold_at: null })
      expect(db.get(`SELECT via, ready_sent_at, method FROM recovery_requests WHERE id = 'rec_a'`)).toEqual({ via: 'codes', ready_sent_at: null, method: 'saved+contact' })
      for (const t of ['contact_points', 'one_time_tokens', 'outbound_messages']) expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)).toEqual({ n: 0 })
    } finally { db.close() }
    // the copy sealed first restores to the v6 database as it was
    const manifests = listManifests(join(dirname(path), 'migration-copies'))
    expect(manifests).toHaveLength(1)
    const target = join(tempFolder('qed-v7-restored-'), 'qed.db')
    const r = restoreBackup({ manifest: manifests[0]!, keyring: openKeyring('migration-copy'), target })
    expect(r.manifest.migration).toEqual({ from: '6', to: SCHEMA_VERSION })
    const restored = new DatabaseSync(target, { readOnly: true })
    try {
      expect((restored.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('6')
      expect(columns(restored, 'webauthn_credentials')).not.toContain('authority')
    } finally { restored.close() }
  })

  it('migrates once: opening it again changes nothing and seals no second copy', () => {
    const path = v6Database()
    openDb(path).close()
    const db = openDb(path)
    try { expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION }) } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('review L3: a passkey a v6 recovery registered within the protection delay signs in only after the migration; an older one keeps its authority', () => {
    const path = join(tempFolder('qed-v7-l3-'), 'qed.db')
    const db0 = openDb(path), now = Date.now(), H = 3600_000
    db0.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_r', 'recent', 'Recent', '!', 1, 'person'), ('usr_o', 'older', 'Older', '!', 1, 'person')`)
    db0.run(`INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, name, created_at) VALUES ('cred_r', 'usr_r', X'00', 'aa', 'bb', 'Recovered phone', ?), ('cred_o', 'usr_o', X'00', 'aa', 'bb', 'Recovered long ago', ?), ('cred_r0', 'usr_r', X'00', 'aa', 'bb', 'Lost laptop', 1)`, now - 2 * H, now - 30 * 24 * H)
    db0.run(`INSERT INTO recovery_requests (id, person_id, code_id, started_at, available_at, completed_at, credential_id, method, secret_hash) VALUES ('rec_r', 'usr_r', 'rcv_r', ?, ?, ?, 'cred_r', 'saved+contact', 'ab'), ('rec_o', 'usr_o', 'rcv_o', ?, ?, ?, 'cred_o', 'saved+contact', 'cd')`,
      now - 80 * H, now - 8 * H, now - 2 * H, now - 33 * 24 * H, now - 30 * 24 * H, now - 30 * 24 * H)
    db0.close()
    toSchemaV6(path)
    const db = openDb(path)
    try {
      expect(db.get(`SELECT authority, authority_reason FROM webauthn_credentials WHERE id = 'cred_r'`)).toEqual({ authority: 'signin', authority_reason: 'recovery' })
      expect(db.get(`SELECT authority_hold_at FROM users WHERE id = 'usr_r'`)).toEqual({ authority_hold_at: now - 2 * H })
      expect(db.get(`SELECT authority FROM webauthn_credentials WHERE id = 'cred_r0'`)).toEqual({ authority: 'full' })
      expect(db.get(`SELECT authority, authority_reason FROM webauthn_credentials WHERE id = 'cred_o'`)).toEqual({ authority: 'full', authority_reason: null })
      expect(db.get(`SELECT authority_hold_at FROM users WHERE id = 'usr_o'`)).toEqual({ authority_hold_at: null })
      // the person is told, in their security history, why the passkey now signs in only
      expect(db.get<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = 'usr_r' ORDER BY id DESC LIMIT 1`)).toEqual({ kind: 'authority-limited-by-upgrade' })
    } finally { db.close() }
  })

  it('review H1: an open v6 recovery with no reference secret, which nothing can finish, is closed by the migration', () => {
    const path = v6Database()
    const db = openDb(path)
    try {
      const r = db.get<{ cancelled_at: number | null; cancelled_by: string | null }>(`SELECT cancelled_at, cancelled_by FROM recovery_requests WHERE id = 'rec_a'`)!
      expect(r.cancelled_at).not.toBeNull()
      expect(r.cancelled_by).toBe('closed at schema v7: no reference secret')
    } finally { db.close() }
  })

  it('a new database is made at v7 with the same columns a migrated one has', () => {
    const created = openDb(join(tempFolder('qed-v7-new-'), 'qed.db'))
    const migrated = openDb(v6Database())
    try {
      for (const t of ['webauthn_credentials', 'users', 'recovery_requests', 'contact_points', 'one_time_tokens', 'outbound_messages']) {
        const cols = (d: typeof created) => d.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(${t})`).map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`).sort()
        expect(cols(migrated), t).toEqual(cols(created))
      }
    } finally { created.close(); migrated.close() }
  })
})
