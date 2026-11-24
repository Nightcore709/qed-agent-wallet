/**
 * Schema v8, the step for payee name checks (R12 task comparison, gap 4): a v7 database gains, on each payee, what the
 * paper bank's name check answered when it was added and the name the bank holds. A payee added before the check existed
 * keeps NULL, which every screen and every payment's terms read as "Not checked: added before QED checked names"; nothing
 * is made up for it. As every migration, it runs only after an encrypted, verified copy is sealed under the
 * migration-copy key: keys made for this run (server/key-fixture.ts), never the owner's (~/.qed).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listManifests } from './backup.ts'
import { openDb, SCHEMA_VERSION } from './core.ts'
import { testKeys } from './key-fixture.ts'
import { toSchemaV7, V8_PAYEE_CHECK_COLUMNS } from './schema-fixture.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v8-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const columns = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

/** A database as schema v7 left it: made by this build, the name-check columns taken out, with a payee in it. */
function v7Database(): string {
  const path = join(tempFolder('qed-v8-'), 'qed.db')
  const db = openDb(path)
  db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_a', 'asha', 'Asha', '!', 1, 'person')`)
  db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pye_a', 'usr_a', 'Meera Nair', 'meera.nair@upi', 'rent', 1)`)
  db.close()
  toSchemaV7(path)
  return path
}

describe('schema v8: each payee keeps what the paper bank\'s name check answered', () => {
  it('a v7 database migrates after its copy is sealed: payees gain the check, and one added before it reads as not checked', () => {
    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(8)
    const path = v7Database()
    const before = new DatabaseSync(path, { readOnly: true })
    try {
      for (const [, c] of V8_PAYEE_CHECK_COLUMNS) expect(columns(before, 'payees')).not.toContain(c)
      expect((before.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('7')
    } finally { before.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      expect(db.get(`SELECT name, handle, name_check, registered_name FROM payees WHERE id = 'pye_a'`)).toEqual({ name: 'Meera Nair', handle: 'meera.nair@upi', name_check: null, registered_name: null })
    } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('migrates once: opening it again changes nothing and seals no second copy', () => {
    const path = v7Database()
    openDb(path).close()
    const db = openDb(path)
    try { expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION }) } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('a new database is made with the same payee columns a migrated one has', () => {
    const created = openDb(join(tempFolder('qed-v8-new-'), 'qed.db'))
    const migrated = openDb(v7Database())
    try {
      const cols = (d: typeof created) => d.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(payees)').map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`).sort()
      expect(cols(migrated)).toEqual(cols(created))
      expect(cols(created).join(' ')).toMatch(/name_check TEXT 0 null.*registered_name TEXT 0 null/)
    } finally { created.close(); migrated.close() }
  })
})
