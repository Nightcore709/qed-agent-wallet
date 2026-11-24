/**
 * Stage S3 of the global money model (ADR-0012; docs/research/qed-systems-architect/20261123-global-money-model.md,
 * section 11): schema v6 keeps every amount of postings, balances and holds as canonical integer text in amount_text,
 * beside the INTEGER amount, which stays as a copy (NULL only past 64 bits). The v5 to v6 step rebuilds the three tables
 * in openDb's transaction, after the encrypted copy openDb seals first (server/migration-copy.ts). These tests run it on
 * books the wallet's own paths wrote, with keys made for this run (server/key-fixture.ts), never the owner's.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { listManifests, restoreBackup, verifyDatabase } from './backup.ts'
import { type Db, openDb, SCHEMA_VERSION } from './core.ts'
import { createAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { consumeHold, placeHold, post, verifyLedger } from './ledger.ts'
import { sealMigrationCopy } from './migration-copy.ts'
import { verifyChain } from './receipts.ts'
import { AMOUNT_TABLES, type AmountTable, toSchemaV5, V5_COLUMNS } from './schema-fixture.ts'
import { makeKit, settle, T0 } from './testkit.ts'

type Row = Record<string, unknown>
const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
// A migration first seals an encrypted copy under the migration-copy key: keys made for this run, never the owner's (~/.qed).
const keys = testKeys(tempFolder('qed-v6-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })
// The seal step, as openDb calls it: the real one, unless a test replaces one call (the two-process test below).
vi.mock('./migration-copy.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./migration-copy.ts')>()
  return { ...real, sealMigrationCopy: vi.fn(real.sealMigrationCopy) }
})
const KEY: Record<AmountTable, string> = { postings: 'id', balances: 'account_id', holds: 'id' }
const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }))

/** Everything a migration could change, read on a read-only connection. */
function snapshot(path: string): { version: unknown; columns: Record<string, string[]>; rows: Record<string, Row[]>; receipts: Row[]; schema: Row[] } {
  const d = new DatabaseSync(path, { readOnly: true })
  try {
    const columns: Record<string, string[]> = {}, rows: Record<string, Row[]> = {}
    for (const t of AMOUNT_TABLES) {
      columns[t] = (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      rows[t] = plain(d.prepare(`SELECT * FROM ${t} ORDER BY ${KEY[t]}`).all())
    }
    return {
      version: (d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value,
      columns, rows,
      receipts: plain(d.prepare('SELECT id, user_id, seq, hash FROM receipts ORDER BY id').all()),
      schema: plain(d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('postings', 'balances', 'holds') ORDER BY type, name`).all()),
    }
  } finally { d.close() }
}

/**
 * Two households' books written through the wallet's own paths (opening balances; a bitcoin buy and a fund purchase,
 * settled; a reservation still open and one partly used), saved in the shape schema v5 left them.
 */
async function v5Database(): Promise<{ path: string; users: string[] }> {
  const k = makeKit()
  k.btc(6_600_000)
  createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: 'buy-1', params: { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', maxSlippageBps: 100, purpose: 'manual' }, approvalId: k.approveOwner('action:buy-1') })
  await settle(k)
  k.nav('amfi:120716', '2026-11-17', '178.8713')
  createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: 'mf-1', params: { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: '500000', purpose: 'manual' }, approvalId: k.approveOwner('action:mf-1') })
  await settle(k)
  k.clock.advance(12 * 3600_000)
  k.nav('amfi:120716', '2026-11-18', '180.0000')
  await settle(k)
  placeHold(k.db, k.userId, 'bank', 123_456n, 'Purchase in progress', 'held-open', k.clock.now())
  placeHold(k.db, k.userId, 'bank', 50_000n, 'Purchase in progress', 'held-part', k.clock.now())
  consumeHold(k.db, k.userId, 'held-part', 20_000n, k.clock.now())
  const second = 'usr_second'
  k.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', second, 'second', 'Second Owner', 'x', k.clock.now())
  openHousehold(k.db, second, DEFAULT_OPENING, {}, k.clock.now())
  post(k.db, { userId: second, ts: k.clock.now(), kind: 'spend', ref: 'rent', memo: 'Rent', lines: [{ account: 'exp:spend', amount: 2_500_000n }, { account: 'bank', amount: -2_500_000n }] })
  const path = join(tempFolder('qed-v6-'), 'qed.db')
  k.db.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  k.db.close()
  toSchemaV5(path)
  return { path, users: [k.userId, second] }
}

/** The sealed copies taken before migrating the database at path. */
const sealedCopies = (path: string): string[] => listManifests(join(dirname(path), 'migration-copies'))
/** Restore a sealed copy into a new private folder (it is verified on the way, read-only), and return its path. */
function restoredCopy(manifest: string): string {
  const target = join(tempFolder('qed-v6-copy-'), 'qed.db')
  const r = restoreBackup({ manifest, keyring: openKeyring('migration-copy'), target })
  expect(r.manifest.migration).toEqual({ from: '5', to: SCHEMA_VERSION })
  return target
}

describe('schema v6: amounts as canonical integer text beside the INTEGER', () => {
  it('a v5 database with two households\' books moves to v6: every v5 column row for row as it was, the text beside each amount, receipts and verification unchanged', async () => {
    const { path, users } = await v5Database()
    const before = snapshot(path)
    expect(before.version).toBe('5')
    for (const t of AMOUNT_TABLES) expect(before.columns[t], t).toEqual(V5_COLUMNS[t])
    expect(before.rows.holds!.filter((h) => h.released_at === null).map((h) => h.amount)).toEqual(expect.arrayContaining([123_456, 30_000]))

    // v6 is this file's step; the build migrates on past it (v7, R12 recovery), so the version it ends at is SCHEMA_VERSION.
    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(6)
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      for (const t of AMOUNT_TABLES) {
        const rows = plain(db.all(`SELECT * FROM ${t} ORDER BY ${KEY[t]}`))
        expect(rows.length, t).toBe(before.rows[t]!.length)
        expect(rows.map(({ amount_text: _, ...v5 }) => v5), t).toEqual(before.rows[t])
        for (const r of rows) expect(r.amount_text, `${t} ${String(r[KEY[t]])}`).toBe(String(r.amount))
      }
      expect(plain(db.all('SELECT id, user_id, seq, hash FROM receipts ORDER BY id'))).toEqual(before.receipts)
      expect(before.receipts.length).toBeGreaterThan(0)
      for (const u of users) {
        expect(verifyLedger(db, u), u).toEqual([])
        expect(verifyChain(db, u).ok, u).toBe(true)
      }
      // Still append-only, the new column included; and the two columns cannot be made to disagree.
      expect(() => db.run(`UPDATE postings SET amount_text = '1'`)).toThrow(/append-only/)
      expect(() => db.run('DELETE FROM postings')).toThrow(/append-only/)
      expect(() => db.run(`UPDATE balances SET amount = amount + 1`)).toThrow(/CHECK constraint failed/)
      expect(() => db.run(`UPDATE holds SET amount_text = '05' WHERE ref = 'held-open'`)).toThrow(/CHECK constraint failed/)
    } finally { db.close() }
    // The copy taken before the change is the v5 database, untouched: sealed under the migration-copy key, no plaintext left.
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith('.bak'))).toEqual([])
    const copies = sealedCopies(path)
    expect(copies).toHaveLength(1)
    expect(snapshot(restoredCopy(copies[0]!))).toEqual(before)
  })

  it('the copy taken before the change restores: this build verifies it read-only as a restore does, and migrating it again gives the same books', async () => {
    const { path, users } = await v5Database()
    const first = openDb(path)
    const migrated = Object.fromEntries(AMOUNT_TABLES.map((t) => [t, plain(first.all(`SELECT * FROM ${t} ORDER BY ${KEY[t]}`))]))
    first.close()
    const restored = restoredCopy(sealedCopies(path)[0]!)
    // As server/backup.ts restoreBackup checks a restored file: read-only, nothing changed, at the copy's own version.
    expect(verifyDatabase(restored)).toMatchObject({ ok: true, integrity: 'ok', foreignKeyIssues: 0, schemaVersion: '5', users: users.length, ledgerBreaks: 0, chainsBroken: 0, firstFailure: null })
    expect(snapshot(restored).version).toBe('5')
    const again = openDb(restored)
    try {
      for (const t of AMOUNT_TABLES) expect(plain(again.all(`SELECT * FROM ${t} ORDER BY ${KEY[t]}`)), t).toEqual(migrated[t])
      for (const u of users) expect(verifyLedger(again, u), u).toEqual([])
    } finally { again.close() }
  })

  it('a pre-v6 file with a broken balance is reported by this build\'s read-only verification, not passed', async () => {
    const { path } = await v5Database()
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE balances SET amount = amount + 500 WHERE account_id = (SELECT id FROM accounts WHERE code = 'bank' LIMIT 1)`)
    raw.close()
    expect(verifyDatabase(path)).toMatchObject({ ok: false, schemaVersion: '5', ledgerBreaks: 1 })
  })

  it('migrates once: opening the database again changes nothing and takes no second copy', async () => {
    const { path } = await v5Database()
    openDb(path).close()
    const once = snapshot(path)
    expect(once.version).toBe(SCHEMA_VERSION)
    openDb(path).close()
    openDb(path).close()
    expect(snapshot(path)).toEqual(once)
    expect(sealedCopies(path)).toHaveLength(1)
  })

  it('a step that cannot complete changes nothing: the database stays at v5, row for row', async () => {
    const { path } = await v5Database()
    // A posting whose entry and account do not exist (foreign keys were off when it was written): the rebuild refuses it.
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(`INSERT INTO postings (entry_id, account_id, asset_id, amount, instrument_id) VALUES ('ent_missing', 'acc_missing', 'INR', 5, 'iso4217:INR')`)
    raw.close()
    const before = snapshot(path)
    expect(() => openDb(path)).toThrow(/FOREIGN KEY constraint failed/)
    expect(snapshot(path)).toEqual(before)
  })

  it('a migrated database refuses amount text holding a NUL byte in all three tables (the step\'s own copy of the definitions)', async () => {
    const { path, users } = await v5Database()
    const owner = users[0]!
    const db = openDb(path)
    try {
      const acc = db.get<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ? AND code = 'bank'`, owner)!.id
      const entry = db.get<{ id: string }>('SELECT id FROM entries WHERE user_id = ? LIMIT 1', owner)!.id
      for (const t of ['1\u0000x', '7\u0000-1', `5\u0000${'9'.repeat(200)}`]) {
        expect(() => db.run('INSERT INTO postings (entry_id, account_id, asset_id, instrument_id, amount, amount_text) VALUES (?, ?, ?, ?, NULL, ?)', entry, acc, 'INR', 'iso4217:INR', t)).toThrow(/CHECK constraint failed/)
        expect(() => db.run('UPDATE balances SET amount = NULL, amount_text = ? WHERE account_id = ?', t, acc)).toThrow(/CHECK constraint failed/)
        expect(() => db.run(`INSERT INTO holds (id, user_id, account_id, amount, amount_text, reason, ref, created_at) VALUES ('h_nul', ?, ?, NULL, ?, 'x', 'nul', 0)`, owner, acc, t)).toThrow(/CHECK constraint failed/)
      }
      for (const u of users) expect(verifyLedger(db, u), u).toEqual([])
    } finally { db.close() }
  })

  it('two processes opening a v5 file together migrate it once: the one that waited for the write lock finds v6 and runs no step', async () => {
    // The API and the engine start together. Process B (the openDb below) reads v5, plans the step and seals its copy of the
    // v5 file. Before B gets the write lock, process A opens the same file: its seal reuses B's copy (the file is unchanged),
    // it migrates, commits, and books an amount past 64 bits. Then B gets the lock. Before the fix B ran the step again on
    // the v6 tables: silently, or, as here, with a misleading "NOT NULL constraint failed: postings.amount_text" (review of
    // 8e9929b). The interleaving is forced inside B's seal step, not timed.
    const { path, users } = await v5Database()
    const owner = users[0]!
    const huge = 1n << 64n
    let cookieAfterA = -1
    const { sealMigrationCopy: realSeal } = await vi.importActual<typeof import('./migration-copy.ts')>('./migration-copy.ts')
    vi.mocked(sealMigrationCopy).mockImplementationOnce((db, from, to, o) => {
      const sealedByB = realSeal(db, from, to, o)
      const a = openDb(path)
      try {
        post(a, { userId: owner, ts: T0, kind: 'income', ref: 'past-64-bits', memo: 'An amount no INTEGER holds', lines: [{ account: 'bank', amount: huge }, { account: 'inc:salary', amount: -huge }] })
        cookieAfterA = a.get<{ schema_version: number }>('PRAGMA schema_version')!.schema_version
      } finally { a.close() }
      return sealedByB
    })
    const b = openDb(path)
    try {
      expect(vi.mocked(sealMigrationCopy)).toHaveBeenCalledTimes(2) // B's (which ran A) and A's
      expect(b.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      // No step ran in B: SQLite's schema cookie is where A left it (reopening a current file does not move it either).
      expect(cookieAfterA).toBeGreaterThan(0)
      expect(b.get<{ schema_version: number }>('PRAGMA schema_version')!.schema_version).toBe(cookieAfterA)
      expect(b.all(`SELECT CAST(p.amount AS TEXT) a, p.amount_text t FROM postings p JOIN entries e ON e.id = p.entry_id WHERE e.ref = 'past-64-bits' ORDER BY p.id`))
        .toEqual([{ a: null, t: huge.toString() }, { a: null, t: (-huge).toString() }])
      for (const u of users) expect(verifyLedger(b, u), u).toEqual([])
      expect(sealedCopies(path)).toHaveLength(1) // B's copy; A reused it, the file being unchanged
    } finally { b.close(); vi.mocked(sealMigrationCopy).mockClear() }
  })

  it('a writer that does not know amount_text (the previous build, still running after the migration) cannot post or reserve: its writes fail rather than diverge', async () => {
    const { path, users } = await v5Database()
    const owner = users[0]!
    const db = openDb(path)
    try {
      const acc = db.get<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ? AND code = 'bank'`, owner)!.id
      const entry = db.get<{ id: string }>('SELECT id FROM entries WHERE user_id = ? LIMIT 1', owner)!.id
      // The previous build's own statements (server/ledger.ts at a198bcf), verbatim.
      expect(() => db.run('INSERT INTO postings (entry_id, account_id, asset_id, instrument_id, amount) VALUES (?, ?, ?, ?, ?)', entry, acc, 'INR', 'iso4217:INR', 5)).toThrow(/NOT NULL constraint failed: postings.amount_text/)
      expect(() => db.run('INSERT INTO holds (id, user_id, account_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'hold_old', owner, acc, 5, 'x', 'old-build', 0)).toThrow(/NOT NULL constraint failed: holds.amount_text/)
      expect(() => db.run('UPDATE balances SET amount = amount + ? WHERE account_id = ?', 5, acc)).toThrow(/CHECK constraint failed/)
      expect(() => db.run('UPDATE holds SET amount = amount - ? WHERE ref = ?', 1, 'held-part')).toThrow(/CHECK constraint failed/)
      for (const u of users) expect(verifyLedger(db, u), u).toEqual([])
    } finally { db.close() }
  })

  it('a new database is made at v6 with the three tables, their indexes and triggers stored exactly as a migrated one\'s', async () => {
    const created = openDb(join(tempFolder('qed-v6-new-'), 'qed.db'))
    const { path } = await v5Database()
    const migrated = openDb(path)
    try {
      const schema = (d: Db) => plain(d.all(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('postings', 'balances', 'holds') ORDER BY type, name`))
      expect(schema(migrated)).toEqual(schema(created))
      expect(schema(created).map((o) => o.name)).toEqual(expect.arrayContaining(['postings_no_update', 'postings_no_delete', 'postings_account', 'postings_entry']))
      for (const t of AMOUNT_TABLES) {
        const info = (d: Db) => plain(d.all(`PRAGMA table_info(${t})`))
        expect(info(created).map((c) => c.name), t).toEqual([...V5_COLUMNS[t], 'amount_text'])
        expect(info(created).find((c) => c.name === 'amount'), t).toMatchObject({ type: 'INTEGER', notnull: 0 })
        expect(info(created).find((c) => c.name === 'amount_text'), t).toMatchObject({ type: 'TEXT', notnull: 1 })
      }
    } finally { created.close(); migrated.close() }
  })
})
