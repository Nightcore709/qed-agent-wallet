/**
 * Stage S2 of the global money model (ADR-0012; docs/research/qed-systems-architect/20261123-global-money-model.md,
 * section 11): the books name each asset by its canonical instrument id beside asset_id. Schema v5 adds instrument_id to
 * accounts and postings and fills it for the rows already there; every writer writes both ids; readers keep reading
 * asset_id in this stage. Since S3 a v4 database moves on through v5 to v6 in the same opening (amount_text, tested in
 * server/amount-text-migration.test.ts); these tests check what the v4 to v5 step does within that chain.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listManifests, restoreBackup } from './backup.ts'
import { APP_ROOT, type Db, openDb, SCHEMA_VERSION } from './core.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { createAction } from './execute.ts'
import { ensureAccount, post, verifyLedger } from './ledger.ts'
import { verifyChain } from './receipts.ts'
import { assetInstrumentId, INSTRUMENTS } from './registry.ts'
import { toSchemaV5 } from './schema-fixture.ts'
import { type Kit, makeKit, settle } from './testkit.ts'

type Row = Record<string, unknown>
type Table = 'accounts' | 'postings'

/** The columns schema v4 gave the two tables (server/schema.sql at c4bbfa4). */
const V4: Record<Table, string[]> = {
  accounts: ['id', 'user_id', 'code', 'kind', 'asset_id', 'name', 'nonneg', 'meta_json'],
  postings: ['id', 'entry_id', 'account_id', 'asset_id', 'amount'],
}
const tableInfo = (db: Db, t: Table): Row[] => db.all<Row>(`PRAGMA table_info(${t})`)
const rawColumns = (d: DatabaseSync, t: Table): string[] => (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
const rawVersion = (d: DatabaseSync): unknown => d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()
const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }))
const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
// A migration first seals an encrypted copy under the migration-copy key (server/migration-copy.ts): keys made for this run.
const keys = testKeys(tempFolder('qed-v5-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })
/** The sealed copies taken before migrating the database at path. */
const sealedCopies = (path: string): string[] => listManifests(join(dirname(path), 'migration-copies'))
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

/** A household's books written through the wallet's own paths: opening balances, then a bitcoin buy and a fund purchase, both settled. */
async function tradedBooks(): Promise<Kit> {
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
  return k
}

/**
 * The books above, plus a position in every other asset a venue trades (one balanced entry each, through the ledger's
 * own writer), saved as schema v4 left them: the two v5 columns dropped and the version set back to 4. One more account,
 * in PCT, is added by hand: the wallet never opens one, and it shows what the fill does with an asset that has no id.
 */
/** Only what existed at schema v4: the money-market fund and the securities desks' instruments came later (R13), and the v5 step keeps its own frozen list. */
const LATER = (x: { base: string }): boolean => x.base.startsWith('EQ:') || x.base.startsWith('GS:') || x.base === 'MF:118719'
async function v4Database(): Promise<{ path: string; userId: string }> {
  const k = await tradedBooks()
  for (const i of INSTRUMENTS.filter((x) => x.tradable && !LATER(x) && x.id !== 'coindcx:BTCINR' && x.id !== 'amfi:120716')) {
    ensureAccount(k.db, k.userId, `pos:${i.id}`, 'asset', i.base, i.name, true, { instrumentId: i.id })
    ensureAccount(k.db, k.userId, `trade:${i.base}`, 'trading', i.base, `${i.base} exchanged for rupees`, false)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'test', ref: `seed:${i.id}`, memo: `A position in ${i.name}`, lines: [{ account: `pos:${i.id}`, amount: 1000n }, { account: `trade:${i.base}`, amount: -1000n }] })
  }
  const path = join(tempFolder('qed-v5-'), 'qed.db')
  k.db.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  k.db.close()
  toSchemaV5(path) // the amount tables as v5 had them (S3), then back to v4 below
  const raw = new DatabaseSync(path)
  raw.exec(`ALTER TABLE accounts DROP COLUMN instrument_id;
            ALTER TABLE postings DROP COLUMN instrument_id;
            UPDATE meta SET value = '4' WHERE key = 'schema_version';
            INSERT INTO accounts (id, user_id, code, kind, asset_id, name, nonneg, meta_json) VALUES ('acc_pct', '${k.userId}', 'test:pct', 'asset', 'PCT', 'Not an instrument', 0, '{}');
            INSERT INTO balances (account_id, amount) VALUES ('acc_pct', 0);`)
  raw.close()
  return { path, userId: k.userId }
}

describe('schema v5: instrument_id beside asset_id in the books', () => {
  it('a database at v4, with a household\'s books, moves through v5 with each row given its asset\'s canonical id and nothing else changed', async () => {
    const { path, userId } = await v4Database()
    const before = new DatabaseSync(path, { readOnly: true })
    expect(rawVersion(before)).toEqual({ value: '4' })
    expect(rawColumns(before, 'accounts')).toEqual(V4.accounts)
    expect(rawColumns(before, 'postings')).toEqual(V4.postings)
    const accountsBefore = plain(before.prepare('SELECT * FROM accounts ORDER BY id').all())
    const postingsBefore = plain(before.prepare('SELECT * FROM postings ORDER BY id').all())
    const balancesBefore = plain(before.prepare('SELECT * FROM balances ORDER BY account_id').all())
    const receiptsBefore = plain(before.prepare('SELECT id, hash FROM receipts ORDER BY id').all())
    before.close()

    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(5)
    const db = openDb(path)
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      const accounts = plain(db.all('SELECT * FROM accounts ORDER BY id'))
      const postings = plain(db.all('SELECT * FROM postings ORDER BY id'))
      // Every column v4 had is as it was, row for row; so are the balances and the receipts' hashes.
      expect(accounts.map(({ instrument_id: _, ...v4 }) => v4)).toEqual(accountsBefore)
      // (amount_text, added by v6, is set aside here: server/amount-text-migration.test.ts checks it.)
      expect(postings.map(({ instrument_id: _, amount_text: __, ...v4 }) => v4)).toEqual(postingsBefore)
      expect(plain(db.all('SELECT * FROM balances ORDER BY account_id')).map(({ amount_text: _, ...v5 }) => v5)).toEqual(balancesBefore)
      expect(plain(db.all('SELECT id, hash FROM receipts ORDER BY id'))).toEqual(receiptsBefore)
      // The new column holds the asset's canonical id, the one a new row would be written with.
      for (const a of accounts) expect(a.instrument_id, String(a.code)).toBe(assetInstrumentId(String(a.asset_id)))
      expect(Object.fromEntries(accounts.map((a) => [a.code, a.instrument_id]))).toMatchObject({
        bank: 'iso4217:INR', 'trade:INR': 'iso4217:INR', 'eq:opening': 'iso4217:INR',
        'pos:coindcx:BTCINR': 'claim:paper-crypto/BTC', 'trade:BTC': 'claim:paper-crypto/BTC',
        'pos:coindcx:ETHINR': 'claim:paper-crypto/ETH', 'pos:coindcx:USDTINR': 'claim:paper-crypto/USDT',
        'pos:amfi:120716': 'claim:paper-mf/120716', 'trade:MF:120716': 'claim:paper-mf/120716', 'pos:amfi:119771': 'claim:paper-mf/119771',
        'test:pct': null,
      })
      // Every posting carries its account's id. Only the hand-made PCT account is left without one; it has no postings.
      const ofAccount = new Map(accounts.map((a) => [a.id, a.instrument_id]))
      for (const p of postings) {
        expect(p.instrument_id).toBe(ofAccount.get(p.account_id))
        expect(p.instrument_id).toBe(assetInstrumentId(String(p.asset_id)))
      }
      expect(db.all('SELECT code FROM accounts WHERE instrument_id IS NULL')).toEqual([{ code: 'test:pct' }])
      expect(db.get('SELECT COUNT(*) n FROM postings WHERE instrument_id IS NULL')).toEqual({ n: 0 })
      const assets = new Set(postings.map((p) => p.asset_id))
      for (const i of INSTRUMENTS.filter((x) => x.tradable && !LATER(x))) expect(assets.has(i.base), i.base).toBe(true)
      expect(verifyLedger(db, userId)).toEqual([])
      expect(verifyChain(db, userId).ok).toBe(true)
      // The ledger is still append-only, the new column included.
      expect(() => db.run(`UPDATE postings SET instrument_id = 'iso4217:USD'`)).toThrow(/append-only/)
      expect(() => db.run('UPDATE postings SET amount = amount + 1')).toThrow(/append-only/)
      expect(() => db.run('DELETE FROM postings')).toThrow(/append-only/)
    } finally { db.close() }
    // The copy taken before the change is the v4 database, sealed under the migration-copy key; no plaintext copy is left.
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith('.bak'))).toEqual([])
    const copies = sealedCopies(path)
    expect(copies).toHaveLength(1)
    const restored = join(tempFolder('qed-v5-copy-'), 'qed.db')
    expect(restoreBackup({ manifest: copies[0]!, keyring: openKeyring('migration-copy'), target: restored }).manifest.migration).toEqual({ from: '4', to: SCHEMA_VERSION })
    const copy = new DatabaseSync(restored, { readOnly: true })
    expect(rawVersion(copy)).toEqual({ value: '4' })
    expect(rawColumns(copy, 'postings')).toEqual(V4.postings)
    copy.close()
  })

  it('migrates once: opening the database again changes nothing and takes no second copy', async () => {
    const { path } = await v4Database()
    const state = () => {
      const d = new DatabaseSync(path, { readOnly: true })
      try {
        return {
          version: rawVersion(d),
          schema: plain(d.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()),
          accounts: plain(d.prepare('SELECT * FROM accounts ORDER BY id').all()),
          postings: plain(d.prepare('SELECT * FROM postings ORDER BY id').all()),
        }
      } finally { d.close() }
    }
    openDb(path).close()
    const once = state()
    expect(once.version).toEqual({ value: SCHEMA_VERSION })
    openDb(path).close()
    openDb(path).close()
    expect(state()).toEqual(once)
    expect(sealedCopies(path)).toHaveLength(1)
  })

  it('without the migration-copy key a start refuses and changes nothing; the next start with it (a separate process) migrates once, under one sealed copy', async () => {
    const { path } = await v4Database()
    const start = (keyDir: string) => spawnSync(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dirname(path), QED_DB: path, QED_KEY_DIR: keyDir } })
    // In WAL mode, as every earlier start of QED leaves a database (VACUUM INTO made this one in rollback mode, and any
    // open switches a file to WAL, which rewrites four header bytes): then a refused start leaves it byte for byte.
    const wal = new DatabaseSync(path)
    wal.exec('PRAGMA journal_mode = WAL')
    wal.close()
    const before = sha256(path)
    const refused = start(join(dirname(path), 'no-keys-here'))
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('Nothing was changed')
    expect(sha256(path)).toBe(before)
    expect(sealedCopies(path)).toEqual([])
    const started = start(keys.dir)
    expect([started.status, started.stderr]).toEqual([0, ''])
    expect(started.stdout).toContain('ledger consistent')
    const after = new DatabaseSync(path, { readOnly: true })
    expect(rawVersion(after)).toEqual({ value: SCHEMA_VERSION })
    after.close()
    expect(sealedCopies(path)).toHaveLength(1)
  }, 30_000)

  it('a new database is made at the current version, its two tables shaped exactly as a migrated one\'s, with the same append-only triggers', async () => {
    const created = openDb(join(tempFolder('qed-v5-new-'), 'qed.db'))
    const { path } = await v4Database()
    const migrated = openDb(path)
    try {
      expect(created.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      const since: Record<Table, string[]> = { accounts: ['instrument_id'], postings: ['instrument_id', 'amount_text'] } // v5, then v6
      for (const t of ['accounts', 'postings'] as const) {
        expect(tableInfo(created, t).map((c) => c.name)).toEqual([...V4[t], ...since[t]])
        expect(tableInfo(created, t)).toEqual(tableInfo(migrated, t))
      }
      const triggers = (d: Db) => d.all(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      expect(triggers(migrated)).toEqual(triggers(created))
      expect(triggers(created).map((t) => (t as Row).name)).toEqual(expect.arrayContaining(['postings_no_update', 'postings_no_delete']))
    } finally { created.close(); migrated.close() }
  })
})

describe('every writer of the books writes both ids', () => {
  it('a new household\'s accounts and opening entries carry asset_id INR and iso4217:INR', () => {
    const k = makeKit()
    const accounts = k.db.all<Row>('SELECT asset_id, instrument_id FROM accounts WHERE user_id = ?', k.userId)
    expect(accounts).toHaveLength(19)
    for (const a of accounts) expect(a).toEqual({ asset_id: 'INR', instrument_id: 'iso4217:INR' })
    const postings = k.db.all<Row>('SELECT p.asset_id, p.instrument_id FROM postings p JOIN entries e ON e.id = p.entry_id WHERE e.user_id = ?', k.userId)
    expect(postings.length).toBeGreaterThan(0)
    for (const p of postings) expect(p).toEqual({ asset_id: 'INR', instrument_id: 'iso4217:INR' })
  })

  it('a bitcoin buy and a fund purchase open their holdings and post every line with both ids, each posting as its account', async () => {
    const k = await tradedBooks()
    const account = (code: string) => k.db.get<Row>('SELECT asset_id, instrument_id FROM accounts WHERE user_id = ? AND code = ?', k.userId, code)
    expect(account('pos:coindcx:BTCINR')).toEqual({ asset_id: 'BTC', instrument_id: 'claim:paper-crypto/BTC' })
    expect(account('trade:BTC')).toEqual({ asset_id: 'BTC', instrument_id: 'claim:paper-crypto/BTC' })
    expect(account('pos:amfi:120716')).toEqual({ asset_id: 'MF:120716', instrument_id: 'claim:paper-mf/120716' })
    expect(account('trade:MF:120716')).toEqual({ asset_id: 'MF:120716', instrument_id: 'claim:paper-mf/120716' })
    const lines = k.db.all<Row>(`SELECT p.asset_id, p.instrument_id, a.instrument_id of_account FROM postings p JOIN accounts a ON a.id = p.account_id
                                 JOIN entries e ON e.id = p.entry_id WHERE e.user_id = ?`, k.userId)
    for (const l of lines) {
      expect(l.instrument_id).toBe(assetInstrumentId(String(l.asset_id)))
      expect(l.instrument_id).toBe(l.of_account)
    }
    const count = (asset: string) => lines.filter((l) => l.asset_id === asset).length
    expect(count('BTC')).toBeGreaterThanOrEqual(2)
    expect(count('MF:120716')).toBeGreaterThanOrEqual(2)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('no account is opened in an asset without a canonical id, and nothing is written', () => {
    const k = makeKit()
    const rows = () => k.db.get<{ a: number; b: number }>('SELECT (SELECT COUNT(*) FROM accounts) a, (SELECT COUNT(*) FROM balances) b')
    const before = rows()
    expect(() => ensureAccount(k.db, k.userId, 'test:pct', 'asset', 'PCT', 'Percent a year', false)).toThrow(/no canonical instrument id/)
    expect(rows()).toEqual(before)
  })
})
