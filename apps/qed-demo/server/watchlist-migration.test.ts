/**
 * Schema v9 part (d) (R14, Grow's watchlist): a v8 database with households, books and records gets one new empty table and
 * nothing else changes. Every row of every older table is the same after; nobody watches anything; the copy sealed first
 * restores the v8 file; opening again changes nothing. Keys are made for this run (server/key-fixture.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listManifests, restoreBackup } from './backup.ts'
import { openDb, SCHEMA_VERSION } from './core.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { seedRegistry } from './registry.ts'
import { toSchemaV8, V9_TABLES, V10_COLUMNS, V10_TABLES } from './schema-fixture.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v9-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const THEN = Date.parse('2026-11-01T05:00:00Z')
const tablesOf = (d: DatabaseSync): string[] => (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)
/** Every row of every table the v8 file had, except the version marker: what must not change meaning. */
function everything(path: string): Record<string, unknown[]> {
  const d = new DatabaseSync(path, { readOnly: true })
  try {
    const out: Record<string, unknown[]> = {}
    // the build migrates on past v9 (v10, R14 account access): what it adds, columns and tables, is not what v9 must leave alone
    for (const t of tablesOf(d)) {
      if (V9_TABLES.includes(t) || V10_TABLES.includes(t) || t === 'meta') continue
      const cols = (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).filter((c) => !V10_COLUMNS.some(([vt, vc]) => vt === t && vc === c))
      out[t] = d.prepare(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY rowid`).all()
    }
    return out
  } finally { d.close() }
}
const versionOf = (path: string): string => { const d = new DatabaseSync(path, { readOnly: true }); try { return (d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value } finally { d.close() } }

/** A v8 database with two households (one in dollars), each with a bank, a payee and a bill, as the previous build left it. */
function v8Database(): string {
  const path = join(tempFolder('qed-v9-'), 'qed.db')
  const db = openDb(path)
  seedRegistry(db)
  for (const [id, handle] of [['usr_a', 'asha'], ['usr_b', 'ben']] as const) {
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, handle, handle, THEN)
    openHousehold(db, id, DEFAULT_OPENING, id === 'usr_b' ? { homeCurrency: 'USD' } : {}, THEN)
    db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES (?, ?, 'Ravi', ?, 'family', ?)`, `pay_${id}`, id, `ravi.${id}@upi`, THEN)
  }
  db.close()
  toSchemaV8(path)
  return path
}

describe('schema v9 part (d): the watchlist table on a v8 database', () => {
  it('this build is at or past v9, and a v8 file lacks the table', () => {
    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(9)
    const path = v8Database()
    expect(versionOf(path)).toBe('8')
    const d = new DatabaseSync(path, { readOnly: true })
    try { for (const t of V9_TABLES) expect(tablesOf(d)).not.toContain(t) } finally { d.close() }
  })

  it('opening it seals a copy, adds the empty table, and leaves every existing household, book and record exactly as it was', () => {
    const path = v8Database()
    const before = everything(path)
    expect(Object.keys(before).length).toBeGreaterThan(20)
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      expect(db.get('SELECT COUNT(*) n FROM watchlist_items')).toEqual({ n: 0 })
    } finally { db.close() }
    expect(everything(path)).toEqual(before)
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('opening it again changes nothing and seals no second copy', () => {
    const path = v8Database()
    openDb(path).close()
    const once = everything(path)
    openDb(path).close()
    expect(everything(path)).toEqual(once)
    expect(versionOf(path)).toBe(SCHEMA_VERSION)
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('the copy sealed before the step restores the v8 file exactly', () => {
    const path = v8Database()
    const before = everything(path)
    openDb(path).close()
    const [m] = listManifests(join(dirname(path), 'migration-copies'))
    const target = join(tempFolder('qed-v9-restored-'), 'qed.db')
    expect(restoreBackup({ manifest: m!, keyring: openKeyring('migration-copy'), target }).manifest.migration).toEqual({ from: '8', to: SCHEMA_VERSION })
    expect(versionOf(target)).toBe('8')
    expect(everything(target)).toEqual(before)
  })
})
