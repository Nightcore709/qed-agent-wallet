/**
 * Schema v5 to v6, stage S3 of the global money model (ADR-0012; docs/research/qed-systems-architect/20261123-global-money-model.md,
 * sections 5 and 11): postings, balances and holds keep each amount as canonical integer text in amount_text, beside the
 * INTEGER amount, which every writer keeps as a copy (NULL past 64 bits). SQLite cannot drop NOT NULL from a column in
 * place, so each table is rebuilt: the old one renamed aside, the v6 one created under the real name, every row copied with
 * its text made by SQLite itself (CAST of an INTEGER to TEXT is canonical), the copy checked row for row against the old
 * table, and the old table dropped with its indexes and triggers. schema.sql, which openDb runs next in the same
 * transaction, creates the indexes and the append-only triggers again.
 *
 * It runs in openDb's transaction, after the copy openDb takes before any migration (server/core.ts): if anything here
 * fails, nothing is changed. The definitions are this step's own frozen copy, as V5_INSTRUMENT_IDS is the v4 to v5 step's,
 * so that a later change to schema.sql cannot change what this step does to an old database; they are byte for byte the
 * v6 definitions in schema.sql (server/amount-text-migration.test.ts compares a migrated database with a new one).
 * Kept in its own module so that the migration block in core.ts stays one line.
 */
import type { Db } from './core.ts'

/** The three tables as schema v6 defines them (server/schema.sql), with the columns schema v5 had, in order. */
const V6: { table: 'postings' | 'balances' | 'holds'; v5Columns: string[]; create: string }[] = [
  {
    table: 'postings',
    v5Columns: ['id', 'entry_id', 'account_id', 'asset_id', 'amount', 'instrument_id'],
    create: `CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL,
  amount INTEGER,               -- signed; positive = debit. Since v6 a copy of amount_text, NULL past 64 bits
  instrument_id TEXT,           -- since v5: the account's canonical instrument id, beside asset_id (see accounts)
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(ltrim(amount_text, '-')) <= 78 AND (amount_text = '0' OR ((amount_text GLOB '[1-9]*' OR amount_text GLOB '-[1-9]*') AND NOT (substr(amount_text, 2) GLOB '*[^0-9]*')))),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END)
) STRICT;`,
  },
  {
    table: 'balances',
    v5Columns: ['account_id', 'amount'],
    create: `CREATE TABLE balances (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  amount INTEGER,               -- since v6 a copy of amount_text, NULL past 64 bits
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(ltrim(amount_text, '-')) <= 78 AND (amount_text = '0' OR ((amount_text GLOB '[1-9]*' OR amount_text GLOB '-[1-9]*') AND NOT (substr(amount_text, 2) GLOB '*[^0-9]*')))),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END)
) STRICT;`,
  },
  {
    table: 'holds',
    v5Columns: ['id', 'user_id', 'account_id', 'amount', 'reason', 'ref', 'created_at', 'released_at'],
    create: `CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER CHECK (amount > 0), -- since v6 a copy of amount_text, NULL past 64 bits
  reason TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(amount_text) <= 78 AND amount_text GLOB '[1-9]*' AND NOT (amount_text GLOB '*[^0-9]*')),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END),
  UNIQUE (user_id, ref)
) STRICT;`,
  },
]

export function migrateToV6(db: Db): void {
  for (const { table, v5Columns, create } of V6) {
    const old = `${table}_v5`
    const cols = v5Columns.join(', ')
    db.exec(`ALTER TABLE ${table} RENAME TO ${old}`)
    db.exec(create)
    // amount_text is made from the INTEGER by SQLite (canonical for any 64-bit integer); the CHECKs refuse a row otherwise.
    db.exec(`INSERT INTO ${table} (${cols}, amount_text) SELECT ${cols}, CAST(amount AS TEXT) FROM ${old}`)
    // Every v5 column of every row is in the new table, and nothing else is: compared both ways, NULLs included.
    const differ = db.get<{ n: number }>(`SELECT (SELECT COUNT(*) FROM (SELECT ${cols} FROM ${old} EXCEPT SELECT ${cols} FROM ${table}))
      + (SELECT COUNT(*) FROM (SELECT ${cols} FROM ${table} EXCEPT SELECT ${cols} FROM ${old})) n`)!.n
    const counts = db.get<{ a: number; b: number }>(`SELECT (SELECT COUNT(*) FROM ${old}) a, (SELECT COUNT(*) FROM ${table}) b`)!
    if (differ !== 0 || counts.a !== counts.b) throw new Error(`schema v6: the rebuilt ${table} differs from the old one (${counts.a} rows before, ${counts.b} after, ${differ} rows not matched); nothing was changed`)
    db.exec(`DROP TABLE ${old}`)
  }
}
