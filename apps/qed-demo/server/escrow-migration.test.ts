/**
 * Schema v8 on a database shaped like the review database (R13 sections 1, 2 and 4): v7 books with paper work from before
 * terms were recorded (work in review, as "Books closed for the quarter" is there; work funded; a dispute; work paid), a
 * job through the escrow on the chain, and a fund purchase waiting for its money (the v8 step's part (a)).
 *
 * The paper escrow's part of the step adds columns and tables and fills nothing: a migration gives no existing milestone
 * a deadline or a default it never had. Checked on the first execution, a repeated execution, an execution killed part-way
 * through the fill, and a restoration from the copy sealed before it: no money moves and no terms change. Keys are made
 * for this run (server/key-fixture.ts), never the owner's (~/.qed).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listManifests, restoreBackup } from './backup.ts'
import { APP_ROOT, FakeClock, openDb, SCHEMA_VERSION } from './core.ts'
import { escrowTick, paperView } from './escrow.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { seedRegistry } from './registry.ts'
import { toSchemaV7, V8_COLUMNS, V8_TABLES } from './schema-fixture.ts'
import type { Ctx } from './types.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-v8-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const columns = (d: DatabaseSync, t: string): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
const tables = (d: DatabaseSync): string[] => (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)
const DAY = 86_400_000
const LONG_AGO = Date.parse('2026-10-01T05:00:00Z')
const MS = ['mil_review', 'mil_filing', 'mil_dispute', 'mil_paid', 'mil_chain']

/** The records whose meaning must not change: every milestone as it stands, and how much money and how many receipts there are. */
function money(d: ReturnType<typeof openDb>) {
  return {
    milestones: d.all('SELECT id, job_id, title, amount, state, evidence_hash, updated_at FROM earn_milestones ORDER BY id'),
    entries: d.all('SELECT COUNT(*) n, amount_sum(p.amount_text) total FROM entries e JOIN postings p ON p.entry_id = e.id'),
    receipts: d.all('SELECT COUNT(*) n FROM receipts'),
  }
}

/** A database as schema v7 left it, shaped like the review database: made by this build, then what v8 added taken out. */
function reviewShapedV7(): string {
  const path = join(tempFolder('qed-v8-'), 'qed.db')
  const db = openDb(path)
  seedRegistry(db)
  db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES ('usr_a', 'asha', 'Asha', '!', ?, 'person')`, LONG_AGO)
  openHousehold(db, 'usr_a', DEFAULT_OPENING, {}, LONG_AGO)
  db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES ('job_p', 'usr_a', 'Quarterly accounts for Lakeview Studio', 'Lakeview Studio', 'open', ?, '{"paperClient":true}'), ('job_c', 'usr_a', 'Mix', '@rohan', 'open', ?, '{"chain":{"v":1}}')`, LONG_AGO, LONG_AGO)
  const rows: [string, string, string, string, number, string | null][] = [
    ['mil_review', 'job_p', 'Books closed for the quarter', 'submitted', 1_800_000, 'aa'], ['mil_filing', 'job_p', 'Filing prepared', 'funded', 1_200_000, null],
    ['mil_dispute', 'job_p', 'Tax workpapers', 'disputed', 500_001, 'bb'], ['mil_paid', 'job_p', 'Engagement letter', 'released', 100_000, 'cc'], ['mil_chain', 'job_c', 'Certified weights', 'chain-funded', 25_075, null],
  ]
  for (const [id, job, title, state, amount, hash] of rows) db.run('INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, evidence_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, job, 'usr_a', title, amount, state, hash, LONG_AGO)
  // a fund purchase whose money has not been recorded as received: the step's part (a) has work to do
  db.run(`INSERT INTO pv_orders (id, venue, client_ref, user_id, instrument_id, side, type, amount, state, created_at, updated_at) VALUES ('pvo_1', 'paper-mf', 'ref-1', 'usr_a', 'amfi:120716', 'buy', 'nav', 500000, 'accepted', ?, ?)`, LONG_AGO, LONG_AGO)
  db.close()
  toSchemaV7(path)
  return path
}
const ro = (path: string): DatabaseSync => { const d = new DatabaseSync(path, { readOnly: true }); return d }
function snapshotV7(path: string) {
  const d = ro(path)
  try {
    return { version: (d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value, milestones: d.prepare('SELECT id, job_id, title, amount, state, evidence_hash, updated_at FROM earn_milestones ORDER BY id').all(), entries: d.prepare('SELECT COUNT(*) n FROM entries').get(), receipts: d.prepare('SELECT COUNT(*) n FROM receipts').get(), order: d.prepare(`SELECT state FROM pv_orders WHERE id = 'pvo_1'`).get() }
  } finally { d.close() }
}

/** The paper escrow after the step: no milestone has a deadline, a default, terms, a dispute record or a step it did not have. */
function expectTermsUnchanged(db: ReturnType<typeof openDb>): void {
  expect(db.all('SELECT id, due_at, terms_id FROM earn_milestones ORDER BY id')).toEqual(MS.slice().sort().map((id) => ({ id, due_at: null, terms_id: null })))
  for (const t of ['earn_terms', 'earn_terms_accepts', 'earn_disputes', 'earn_steps']) expect(db.get(`SELECT COUNT(*) n FROM ${t}`), t).toEqual({ n: 0 })
}

describe('schema v8 on books shaped like the review database: no new terms by migration', () => {
  it('the first execution seals a copy, then adds the columns and tables and gives no milestone a deadline, a default or terms; no money moves', () => {
    expect(SCHEMA_VERSION).toBe('8')
    const path = reviewShapedV7()
    const before = snapshotV7(path)
    expect(before.version).toBe('7')
    const d0 = ro(path)
    try {
      expect(columns(d0, 'earn_milestones')).not.toContain('terms_id')
      for (const t of V8_TABLES) expect(tables(d0)).not.toContain(t)
    } finally { d0.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: '8' })
      for (const [t, c] of V8_COLUMNS) expect(db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((x) => x.name), `${t}.${c}`).toContain(c)
      expectTermsUnchanged(db)
      expect(db.all('SELECT id, job_id, title, amount, state, evidence_hash, updated_at FROM earn_milestones ORDER BY id')).toEqual(before.milestones)
      expect(db.get('SELECT COUNT(*) n FROM entries')).toEqual(before.entries)
      expect(db.get('SELECT COUNT(*) n FROM receipts')).toEqual(before.receipts)
      // part (a), the fund purchase, is the funds' own change and happened as before
      expect(db.get(`SELECT state FROM pv_orders WHERE id = 'pvo_1'`)).toEqual({ state: 'funded' })
      // on the page: no agreed deadline, nothing happens on its own until both sides agree terms
      const v = paperView(db, 'usr_a', Date.now()) as { jobs: { id: string; terms?: unknown; milestones: Record<string, any>[] }[] }
      const books = v.jobs.find((j) => j.id === 'job_p')!.milestones.find((m) => m.id === 'mil_review')!
      expect(v.jobs.find((j) => j.id === 'job_p')!.terms).toBeNull()
      expect(books).toMatchObject({ title: 'Books closed for the quarter', state: 'submitted', legacy: true, dueAt: null, next: { actor: 'both', step: 'agree-terms', by: null, then: { kind: 'nothing' } } })
      // a year on, the engine has still done nothing to it
      expect(escrowTick({ db, clock: new FakeClock(Date.now() + 365 * DAY) } as unknown as Ctx)).toBe(0)
      expect(db.get(`SELECT state FROM earn_milestones WHERE id = 'mil_review'`)).toEqual({ state: 'submitted' })
    } finally { db.close() }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('a repeated execution changes nothing and seals no second copy', () => {
    const path = reviewShapedV7()
    const first = openDb(path)
    const after = { m: money(first), schema: first.all(`SELECT type, name, sql FROM sqlite_master ORDER BY name`) }
    first.close()
    for (let i = 0; i < 2; i++) {
      const db = openDb(path)
      try {
        expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: '8' })
        expect({ m: money(db), schema: db.all(`SELECT type, name, sql FROM sqlite_master ORDER BY name`) }).toEqual(after)
        expectTermsUnchanged(db)
      } finally { db.close() }
    }
    expect(listManifests(join(dirname(path), 'migration-copies'))).toHaveLength(1)
  })

  it('an execution killed part-way through the fill leaves the v7 books exactly as they were; the next start migrates them once', async () => {
    const path = reviewShapedV7()
    const before = snapshotV7(path)
    // the process dies inside the step's fill (its first write), after the copy was sealed and the columns added
    const src = `import { Db, openDb } from ${JSON.stringify(join(APP_ROOT, 'server', 'core.ts'))};
      const run = Db.prototype.run; Db.prototype.run = function (sql, ...p) { if (sql.startsWith('UPDATE pv_orders SET funds_at')) process.kill(process.pid, 'SIGKILL'); return run.call(this, sql, ...p) };
      openDb(${JSON.stringify(path)})`
    const signal = await new Promise<string | null>((done) => spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'ignore', env: process.env }).on('exit', (_c, s) => done(s)))
    expect(signal).toBe('SIGKILL')
    expect(snapshotV7(path)).toEqual(before)
    const d0 = ro(path)
    try { expect(columns(d0, 'earn_milestones')).not.toContain('due_at') } finally { d0.close() }
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: '8' })
      expectTermsUnchanged(db)
      expect(db.all('SELECT id, job_id, title, amount, state, evidence_hash, updated_at FROM earn_milestones ORDER BY id')).toEqual(before.milestones)
      expect(db.get('SELECT COUNT(*) n FROM entries')).toEqual(before.entries)
    } finally { db.close() }
  }, 60_000)

  it('the copy sealed before the step restores the v7 books exactly as they were', () => {
    const path = reviewShapedV7()
    const before = snapshotV7(path)
    openDb(path).close()
    const manifests = listManifests(join(dirname(path), 'migration-copies'))
    expect(manifests).toHaveLength(1)
    const target = join(tempFolder('qed-v8-restored-'), 'qed.db')
    const r = restoreBackup({ manifest: manifests[0]!, keyring: openKeyring('migration-copy'), target })
    expect(r.manifest.migration).toEqual({ from: '7', to: '8' })
    expect(snapshotV7(target)).toEqual(before)
    const d = ro(target)
    try {
      expect(columns(d, 'earn_milestones')).not.toContain('terms_id')
      for (const t of V8_TABLES) expect(tables(d)).not.toContain(t)
    } finally { d.close() }
  })

  it('a new database is made at v8 with the same columns, and the same trigger on a milestone\'s terms, as a migrated one', () => {
    const created = openDb(join(tempFolder('qed-v8-new-'), 'qed.db'))
    const migrated = openDb(reviewShapedV7())
    try {
      for (const t of ['earn_milestones', ...V8_TABLES]) {
        const cols = (d: typeof created) => d.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(${t})`).map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`).sort()
        expect(cols(migrated), t).toEqual(cols(created))
      }
      const triggers = (d: typeof created) => d.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'earn_%' ORDER BY name`).map((x) => x.name)
      expect(triggers(migrated)).toEqual(triggers(created))
      expect(triggers(created)).toContain('earn_milestones_terms_fixed')
    } finally { created.close(); migrated.close() }
  })
})
