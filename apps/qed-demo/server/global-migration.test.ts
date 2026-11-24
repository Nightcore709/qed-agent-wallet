/**
 * Migration (R13 section 8): the existing household's rupee data keeps its meaning. A v7 database, written by the wallet's
 * own paths (opening, salary, instalments, interest, a payment), migrates to this build's schema with its balances, its
 * statements and its passbook identical, its stored profile byte for byte the same, and reads its new time zone and
 * jurisdiction as Asia/Kolkata and India without anything being written for them. The migration runs only after a sealed
 * copy is made under keys made for this run (server/key-fixture.ts), never the owner's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bankTick } from './bank.ts'
import { type Db, FakeClock, openDb, SCHEMA_VERSION } from './core.ts'
import { balancesByCurrency, moneyView } from './fx.ts'
import { DEFAULT_OPENING, getProfile, householdZone, jurisdictionOf, openHousehold } from './household.ts'
import { testKeys } from './key-fixture.ts'
import { post, verifyLedger } from './ledger.ts'
import { Market } from './market.ts'
import { seedRegistry } from './registry.ts'
import { toSchemaV7, V8_TABLES } from './schema-fixture.ts'
import { statement } from './statement.ts'
import type { Ctx } from './types.ts'
import { passbook } from './views.ts'
import { periodOf } from '../shared/period.ts'

const folders: string[] = []
const tempFolder = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); folders.push(d); return d }
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const keys = testKeys(tempFolder('qed-r13-keys-'))
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(() => { process.env.QED_KEY_DIR = keys.dir })
afterAll(() => { if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore })

const USER = 'usr_v7'
const OPENED = Date.parse('2026-10-20T05:00:00Z')
const NOW = Date.parse('2026-12-02T06:00:00Z') // 2 Dec 2026, 11:30 IST: November's interest and December's salary are due

const ctxOf = (db: Db, now: number): Ctx => { const clock = new FakeClock(now); return { db, clock, market: new Market(db, clock), venues: {} as Ctx['venues'] } }

/** A household's books as the wallet writes them: opening, salary, instalments, interest, a payment. */
function household(path: string): void {
  const db = openDb(path)
  try {
    seedRegistry(db)
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, 'meera', 'Meera', '!', ?, 'person')`, USER, OPENED)
    openHousehold(db, USER, DEFAULT_OPENING, {}, OPENED)
    for (const t of [Date.parse('2026-11-01T06:00:00Z'), Date.parse('2026-11-05T06:00:00Z'), NOW]) bankTick(ctxOf(db, t))
    post(db, { userId: USER, ts: Date.parse('2026-11-20T08:00:00Z'), kind: 'payment', ref: 'pay:rent:2026-11', memo: 'Rent (paper)', meta: { paper: true }, lines: [{ account: 'bank', amount: -2_500_000n }, { account: 'exp:spend', amount: 2_500_000n }] })
  } finally { db.close() }
}

/** Everything the owner reads about their rupees: every balance, three statements and the passbook. */
function snapshot(db: Db): string {
  const balances = db.all('SELECT a.code, a.asset_id, a.instrument_id, b.amount_text FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? ORDER BY a.code', USER)
  const statements = (['month', 'last-month', 'all'] as const).map((k) => statement(db, USER, NOW, periodOf(k, NOW), 500))
  return JSON.stringify({ balances, statements, passbook: passbook(db, USER, NOW, 500) })
}

/** The rows themselves, read without this build's code: entries, postings, balances and the profile. */
function rows(path: string): string {
  const d = new DatabaseSync(path, { readOnly: true })
  try {
    const q = (sql: string) => d.prepare(sql).all()
    return JSON.stringify([q('SELECT * FROM entries ORDER BY seq'), q('SELECT id, entry_id, account_id, asset_id, instrument_id, amount, amount_text FROM postings ORDER BY id'), q('SELECT * FROM balances ORDER BY account_id'), q('SELECT * FROM accounts ORDER BY id'), q('SELECT id, profile_json FROM users ORDER BY id')])
  } finally { d.close() }
}

describe('R13 migration: a v7 household\'s rupee data keeps its meaning', () => {
  it('on a v7 fixture, balances, statements, the passbook and every row are identical after the migration; nothing is written for the new settings', () => {
    const path = join(tempFolder('qed-r13-v7-'), 'qed.db')
    household(path)
    const read = (): string => { const db = openDb(path); try { return snapshot(db) } finally { db.close() } }
    const before = read()
    toSchemaV7(path)
    const raw = new DatabaseSync(path, { readOnly: true })
    try {
      expect((raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('7')
      for (const t of ['fx_fills', 'xb_payees', 'xb_payments']) expect(raw.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t)).toBeUndefined()
      expect((raw.prepare('SELECT COUNT(*) n FROM postings').get() as { n: number }).n).toBeGreaterThan(10)
    } finally { raw.close() }
    const v7Rows = rows(path)

    const db = openDb(path) // migrates, after sealing a copy under the test keys
    try {
      expect(db.get(`SELECT value FROM meta WHERE key = 'schema_version'`)).toEqual({ value: SCHEMA_VERSION })
      for (const t of ['fx_fills', 'xb_payees', 'xb_payments']) { expect(V8_TABLES).toContain(t); expect(db.get('SELECT 1 FROM sqlite_master WHERE name = ?', t)).toBeDefined() }
      expect(householdZone(db, USER)).toBe('Asia/Kolkata')
      expect(jurisdictionOf(getProfile(db, USER))).toBe('IN')
      expect(balancesByCurrency(db, USER).map((b) => b.currency)).toEqual(['INR'])
      expect(verifyLedger(db, USER)).toEqual([])
      expect(snapshot(db)).toBe(before)
      const view = moneyView(ctxOf(db, NOW), USER) as { balances: { currency: string; minor: string }[]; total: { minor: string | null } }
      expect(view.balances).toHaveLength(1)
      expect(view.total.minor).toBe(view.balances[0]!.minor) // rupees alone: the total is the rupee balance, and no rate is used
    } finally { db.close() }
    expect(rows(path)).toBe(v7Rows) // reading it, and the money view, wrote nothing to the books or the profile
  })
})
