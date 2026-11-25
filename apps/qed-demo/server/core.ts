/**
 * Core plumbing for the QED local backend: database access, clock, identifiers, typed errors, events.
 * Runs on Node's built-in SQLite (no native add-on) and Node's built-in TypeScript support (no build step).
 */
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { registerAmountSql } from './amount-sql.ts'
import { migrateToV6 } from './migrate-v6.ts'
import { closeAsFound, MigrationRefused, sealMigrationCopy } from './migration-copy.ts'
import { type GoogleConfig, googleConfig } from './google-config.ts'
import { type PostmarkConfig, postmarkConfig } from './postmark-config.ts'
import { MICROS, PRICES } from './model-prices.ts'

export const SCHEMA_VERSION = '10'
const HERE = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = join(HERE, '..')

export type Row = Record<string, unknown>

/** A refusal the caller caused (bad input, not permitted, conflict). Carries an HTTP-style status and a code. */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: Record<string, string> | undefined
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}
export const bad = (message: string, fields?: Record<string, string>) => new AppError(400, 'invalid', message, fields)
export const refused = (code: string, message: string) => new AppError(409, code, message)
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} was not found.`)

export interface Clock { now(): number }
/**
 * On an isolated test stack only (QED_TEST_STACK=1): the whole number of milliseconds the file named by
 * QED_TEST_CLOCK_FILE holds is added to the services' clock, so a browser journey can bring a day forward (a goal's
 * contribution day, a request lapsing) instead of waiting for it (browser/tests/goals.spec.ts). The engine sees the jump
 * as a gap and says so, as after a machine slept. The file is read at most every quarter second, so the engine and the
 * API, two processes, agree within that; it can only move the clock forward. Without QED_TEST_STACK=1 the variable is
 * ignored, as the synthetic feed's pause file is (server/synthetic.ts), and the clock is the computer's.
 */
let offsetReadAt = -Infinity, offsetMs = 0
export function testClockOffset(env: NodeJS.ProcessEnv = process.env, at: number = Date.now()): number {
  const file = env.QED_TEST_STACK === '1' ? env.QED_TEST_CLOCK_FILE : undefined
  if (!file) return 0
  if (at - offsetReadAt < 250) return offsetMs
  offsetReadAt = at
  let v = Number.NaN
  try { const t = readFileSync(file, 'utf8').trim(); v = /^\d+$/.test(t) ? Number(t) : Number.NaN } catch { /* no file: no offset */ }
  offsetMs = Number.isSafeInteger(v) && v >= 0 ? v : 0
  return offsetMs
}
export const systemClock: Clock = { now: () => { const t = Date.now(); return t + testClockOffset(process.env, t) } }
/** The month given and the eleven before it, oldest first, as YYYY-MM: the months whose instalment may still be owed. */
export function instalmentMonths(ym: string): string[] {
  let [y, m] = ym.split('-').map(Number) as [number, number]
  const out: string[] = []
  for (let i = 0; i < 12; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y-- } }
  return out
}

export class FakeClock implements Clock {
  t: number
  constructor(start: number) { this.t = start }
  now(): number { return this.t }
  advance(ms: number): number { this.t += ms; return this.t }
  set(t: number): number { this.t = t; return t }
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
/** Time-sortable identifier: prefix, 9 characters of millisecond time, 10 random characters. */
export function newId(prefix: string, now: number = Date.now()): string {
  let t = ''
  let n = Math.floor(now)
  for (let i = 0; i < 9; i++) { t = ALPHABET[n % 32]! + t; n = Math.floor(n / 32) }
  const r = randomBytes(10)
  let s = ''
  for (let i = 0; i < 10; i++) s += ALPHABET[r[i]! % 32]
  return `${prefix}_${t}${s}`
}

export class Db {
  readonly raw: DatabaseSync
  readonly path: string
  private readonly statements = new Map<string, StatementSync>()
  private depth = 0

  constructor(path: string) {
    this.path = path
    // A new data folder is private (mode 700); an existing one is left as it is (docs/ENCRYPTION.md, section 7).
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.raw = new DatabaseSync(path)
    // busy_timeout first; and switching a new database to WAL takes an exclusive lock for which SQLite does not always
    // wait, so a second process opening it at the same moment (the engine and the API start together; two engines in
    // engine-lock.test.ts) failed at once with "database is locked". That one error is retried for up to 8 s.
    for (let attempt = 0; ; attempt++) {
      try { this.raw.exec('PRAGMA busy_timeout = 8000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;'); break }
      catch (e) {
        if (attempt >= 80 || !/database is locked/i.test((e as Error).message)) throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
    try { this.raw.enableDefensive(true) } catch { /* older runtimes */ }
    // amount_sum, the exact sum every SQL sum over an amount uses (stage S3, server/amount-sql.ts). A runtime without it stops here.
    registerAmountSql(this.raw)
  }

  private prep(sql: string): StatementSync {
    let s = this.statements.get(sql)
    if (!s) { s = this.raw.prepare(sql); this.statements.set(sql, s) }
    return s
  }
  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.prep(sql).run(...params)
    return { changes: Number(r.changes) }
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prep(sql).get(...params) as T | undefined
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prep(sql).all(...params) as T[]
  }
  exec(sql: string): void { this.raw.exec(sql) }

  /** Whether a transaction is open on this connection (a request's, or one a function opened). */
  get inTransaction(): boolean { return this.depth > 0 }

  /**
   * Writes that record that something was attempted, kept apart from the transaction they run in (R13 hardening, brief
   * item 2: every changing request is one transaction, server/api.ts). A rate limit's count is the one kind: a request
   * that is counted and then refused, or fails half-way, rolls back whole, and its attempt must still count, or a burst of
   * refused attempts would never use up its allowance. `fn` runs now; if the transaction it ran in is rolled back, it runs
   * again after the rollback (at the outermost level in a transaction of its own; inside a rolled-back savepoint, at once
   * in the enclosing transaction, and is kept again there). A store that refuses even that (a full disk) loses the count:
   * the request has failed anyway.
   */
  keep(fn: () => void): void {
    fn()
    if (this.depth > 0) this.kept.push({ depth: this.depth, fn })
  }
  private kept: { depth: number; fn: () => void }[] = []
  private replayKept(level: number): void {
    const lost = this.kept.filter((k) => k.depth > level)
    if (!lost.length) return
    this.kept = this.kept.filter((k) => k.depth <= level)
    for (const k of lost) {
      try {
        if (level === 0) this.tx(k.fn)
        else { k.fn(); this.kept.push({ depth: level, fn: k.fn }) }
      } catch { /* the store refused the count too (a full disk): the request has failed, and says so */ }
    }
  }

  /** Run fn in one write transaction. Nested calls join the outer transaction through savepoints. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      const level = this.depth, sp = `sp${level}`
      this.raw.exec(`SAVEPOINT ${sp}`)
      this.depth = level + 1
      try { const r = fn(); this.raw.exec(`RELEASE ${sp}`); return r }
      catch (e) { this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); this.depth = level; this.replayKept(level); throw e }
      finally { this.depth = level }
    }
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try { const r = fn(); this.raw.exec('COMMIT'); this.depth = 0; this.kept = []; return r }
    catch (e) { try { this.raw.exec('ROLLBACK') } catch { /* already rolled back */ } this.depth = 0; this.replayKept(0); throw e }
    finally { this.depth = 0 }
  }

  close(): void { this.statements.clear(); this.raw.close() }
}

/**
 * Migrations from one schema version to the next. `alter` runs before schema.sql (columns added to tables that already
 * exist, so that schema.sql's indexes find them); `fill` runs after it (rows for the tables schema.sql has just
 * created). Before anything changes, a file database's copy is sealed under the migration-copy key (migration-copy.ts).
 */
const MIGRATIONS: Record<string, { to: string; alter: (db: Db) => void; fill: (db: Db) => void }> = {
  // R7: passkeys, recovery, scheduled changes, security events and workspace memberships.
  '1': {
    to: '2',
    alter: (db) => {
      db.exec(`ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person'`)
      // Before R7 a stop always let protective selling continue; a stop in force keeps that meaning.
      db.exec('ALTER TABLE users ADD COLUMN stop_protective INTEGER NOT NULL DEFAULT 0')
      db.exec('UPDATE users SET stop_protective = 1 WHERE stop_at IS NOT NULL')
      db.exec(`ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'`)
      db.exec('ALTER TABLE sessions ADD COLUMN credential_id TEXT')
      db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT')
      db.exec('ALTER TABLE sessions ADD COLUMN stepup_method TEXT')
      db.exec('ALTER TABLE approvals ADD COLUMN approver_id TEXT')
      db.exec('ALTER TABLE approvals ADD COLUMN created_by TEXT')
      db.exec('ALTER TABLE approvals ADD COLUMN required_signers INTEGER NOT NULL DEFAULT 1')
      db.exec(`ALTER TABLE users ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'`)
      // The R5 passkeys table was never written to; it is replaced by webauthn_credentials.
      const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'passkeys'`)?.n ?? 0
      if (n && (db.get<{ n: number }>('SELECT COUNT(*) n FROM passkeys')?.n ?? 0) === 0) db.exec('DROP TABLE passkeys')
    },
    fill: (db) => {
      // Every existing person owns their personal workspace, which is their own users row.
      db.run(`INSERT OR IGNORE INTO memberships (workspace_id, person_id, role, created_at, added_by) SELECT id, id, 'owner', created_at, 'migration-2' FROM users WHERE kind = 'person'`)
    },
  },
  // R7: recovery at NIST AAL2 (a saved code and a code from a recovery contact), passkey suspension, recovery codes
  // hashed with scrypt; Ask as conversations whose later turns can correct or withdraw earlier proposals.
  '2': {
    to: '3',
    alter: (db) => {
      db.exec('ALTER TABLE webauthn_credentials ADD COLUMN suspended_at INTEGER')
      db.exec('ALTER TABLE webauthn_credentials ADD COLUMN suspended_by TEXT')
      // Codes made before v3 were hashed with salted SHA-256; they keep working until used or replaced.
      db.exec(`ALTER TABLE recovery_codes ADD COLUMN algo TEXT NOT NULL DEFAULT 'sha256'`)
      db.exec('ALTER TABLE recovery_requests ADD COLUMN contact_code_id TEXT')
      db.exec(`ALTER TABLE recovery_requests ADD COLUMN method TEXT NOT NULL DEFAULT 'saved-code'`)
      db.exec('ALTER TABLE ai_calls ADD COLUMN conversation_id TEXT')
      db.exec('ALTER TABLE ai_calls ADD COLUMN sent_json TEXT')
      db.exec('ALTER TABLE proposals ADD COLUMN conversation_id TEXT')
      db.exec('ALTER TABLE proposals ADD COLUMN turn_id TEXT')
      db.exec('ALTER TABLE proposals ADD COLUMN supersedes TEXT')
      db.exec('ALTER TABLE proposals ADD COLUMN superseded_by TEXT')
    },
    fill: () => {},
  },
  // 23 Nov 2026: a recovery is completed with a reference only its starter was given (the D-094 review, H1). A recovery
  // still open from before has no secret and cannot be completed: it is started again.
  '3': {
    to: '4',
    alter: (db) => { db.exec('ALTER TABLE recovery_requests ADD COLUMN secret_hash TEXT') },
    fill: () => {},
  },
  // 23 Nov 2026, stage S2 of the global money model (ADR-0012): the books name each asset by its canonical instrument id
  // beside asset_id, which readers keep using. Rows already there get the ids of V5_INSTRUMENT_IDS. The fill is done here
  // rather than in `fill` because postings are append-only: their update trigger is dropped for this one fill, inside the
  // migration's transaction, and schema.sql, which runs next in the same transaction, creates it again.
  '4': {
    to: '5',
    alter: (db) => {
      db.exec('ALTER TABLE accounts ADD COLUMN instrument_id TEXT')
      db.exec('ALTER TABLE postings ADD COLUMN instrument_id TEXT')
      db.exec('DROP TRIGGER IF EXISTS postings_no_update')
      for (const { asset_id } of db.all<{ asset_id: string }>('SELECT asset_id FROM accounts UNION SELECT asset_id FROM postings')) {
        const id = V5_INSTRUMENT_IDS.get(asset_id)
        if (id === undefined) continue // an asset with no canonical id keeps NULL: nothing is guessed
        db.run('UPDATE accounts SET instrument_id = ? WHERE asset_id = ?', id, asset_id)
        db.run('UPDATE postings SET instrument_id = ? WHERE asset_id = ?', id, asset_id)
      }
    },
    fill: () => {},
  },
  // 24 Nov 2026, stage S3 of the global money model (ADR-0012): postings, balances and holds keep every amount as canonical
  // integer text beside the INTEGER, which stays as a copy (NULL past 64 bits). The three tables are rebuilt; the step is in
  // its own module, server/migrate-v6.ts.
  '5': { to: '6', alter: migrateToV6, fill: () => {} },
  // 24 Nov 2026, R12 recovery (server/recovery.ts): a passkey's approval authority ('full', or 'signin' after a recovery
  // until a delayed restoration), the hold a password reset or recovery leaves, how a recovery started and whether its
  // ready message went; the new tables (addresses, one-time tokens, outbound messages) are made by schema.sql. Every
  // passkey that exists keeps the authority it had: 'full'.
  // Each column is added only where it is missing: a test that makes an older database from today's schema (by taking out
  // only what its own step adds back) finds these columns there already.
  // Then (the review of R12, 24 Nov): a passkey a v6 recovery registered less than the protection delay ago would have
  // approved at once under v6; it signs in only now, as one registered by a v7 recovery does, and its person is told in
  // their security history (L3). And a recovery still open from before v4, which has no reference secret, can be finished
  // by no way at all now (an email link finishes only what the email way started): it is closed (H1).
  '6': {
    to: '7',
    alter: (db) => {
      addColumn(db, 'webauthn_credentials', 'authority', `TEXT NOT NULL DEFAULT 'full'`)
      addColumn(db, 'webauthn_credentials', 'authority_reason', 'TEXT')
      addColumn(db, 'users', 'authority_hold_at', 'INTEGER')
      addColumn(db, 'users', 'password_reset_at', 'INTEGER')
      addColumn(db, 'recovery_requests', 'via', `TEXT NOT NULL DEFAULT 'codes'`)
      addColumn(db, 'recovery_requests', 'ready_sent_at', 'INTEGER')
    },
    fill: (db) => {
      const now = Date.now()
      const recent = db.all<{ person_id: string; credential_id: string; completed_at: number; name: string }>(`SELECT r.person_id, r.credential_id, r.completed_at, c.name FROM recovery_requests r JOIN webauthn_credentials c ON c.id = r.credential_id
        WHERE r.completed_at IS NOT NULL AND r.completed_at > ? AND c.authority = 'full' AND c.removed_at IS NULL`, now - V7_PROTECTION_DELAY_MS)
      for (const r of recent) {
        db.run(`UPDATE webauthn_credentials SET authority = 'signin', authority_reason = 'recovery' WHERE id = ?`, r.credential_id)
        db.run('UPDATE users SET authority_hold_at = MAX(COALESCE(authority_hold_at, 0), ?) WHERE id = ?', r.completed_at, r.person_id)
        db.run('INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, ?, ?)', r.person_id, now, 'authority-limited-by-upgrade', j({ passkey: r.name, recoveredAt: r.completed_at }))
      }
      db.run(`UPDATE recovery_requests SET cancelled_at = ?, cancelled_by = 'closed at schema v7: no reference secret' WHERE secret_hash IS NULL AND cancelled_at IS NULL AND completed_at IS NULL`, now)
    },
  },
  // 24 Nov 2026, R12: one v7 to v8 step for the round's schema changes, each part self-contained and idempotent.
  // (c) 24 Nov 2026, R12 task comparison gap 4 (server/name-check.ts): each payee keeps what the paper bank's name check
  // answered when it was added, and the name the bank holds for its address on a match or a close match. A payee added
  // before the check existed keeps NULL, read as "not checked": nothing is made up for it. Columns only; the first-payment
  // hold needs no schema (its settings are in the household's profile, its release time in the signed terms).
  // (a) 24 Nov 2026, R12 task comparison gap 17 (T4-d): a fund purchase's money reaching the fund house is a state of the paper
  // registrar's own, 'funded', with its time in pv_orders.funds_at, between the order reaching the registrar ('accepted')
  // and the units being allotted ('filled'). Before v8 the registrar treated the money as arriving with the order: its NAV
  // day was worked out from the order's own time (minNavDate in meta_json). So that is when an older purchase's money is
  // recorded as received: an allotted one gains funds_at = created_at; one still waiting for its NAV becomes 'funded' at
  // that time and keeps its NAV day. Nothing is sent again: an action in flight reads the registrar's record as before,
  // and its next pass finds the order funded. Rows a v8 build wrote carry fundsDueAt in their meta and are left alone, so
  // the step changes nothing if it is ever run twice. Rejected purchases (money returned) and redemptions keep NULL.
  // (b) 24 Nov 2026, R13 section 2 (paper escrow under accepted terms, server/escrow.ts): each milestone's next deadline
  // (earn_milestones.due_at) and the terms it runs under (terms_id); the terms (earn_terms, earn_terms_accepts), the
  // disputes (earn_disputes) and the record of every step (earn_steps) are tables schema.sql makes. Nothing is filled: a
  // milestone from before keeps the terms it was opened on, which had no deadline and no default, so a migration, a
  // restart or silence never gives it new financial terms (an earlier draft gave work in review a seven-day release; the
  // owner refused it). Until its two sides agree terms, nothing happens to it on its own. The chain's milestones are
  // untouched. Idempotent: the columns are added only where they are missing.
  // (d) 24 Nov 2026, R13 (RISK-084, server/chain-books.ts): the on-chain wallet's movements are booked in the ledger. The
  // tables (chain_books, chain_movements, chain_recon) are made by schema.sql. A household that already has a vault has a
  // history on the chain the books never saw: it is marked here ('needed'), and the next sync with the wallet service books
  // that history from the service's own records, once. This step cannot reach the service, so it books nothing, moves no
  // money and attaches no terms. Idempotent: a household already marked keeps its row.
  // (e) 24 Nov 2026, R13 RE6 (server/incidents.ts): the incident log, two new tables (incidents, incident_events) made by
  // schema.sql. No column changes and nothing to fill: a database from before has no incidents. toSchemaV7 drops them.
  // (f) 24 Nov 2026, R13 Spend (server/subscriptions.ts, revocation.ts): four tables of their own, made by schema.sql: a person's
  // review of a recurring payment, the paper bank's mandates, and each revocation with its channels' answers. No existing row
  // is changed and none is made: an instruction that went live before has no mandate on record at the paper bank, because
  // nobody asked for one, so revoking it reaches the channels it has and says so.
  // (g) 24 Nov 2026, R13 (the person's data rights, server/records.ts): three new tables made by schema.sql, person_keys,
  // access_log and erasures. No column is added and no row is written: nobody has a key, a log entry or an erasure until they
  // use the feature, and nothing is scheduled, accepted or deleted for anyone by this step.
  // (i) 24 Nov 2026, R13 Ask and agent commerce (server/ask-kinds.ts, server/commerce.ts): a column for the structured questions
  // Ask puts to the person (offered choices and a typed answer), and two tables made by schema.sql, commerce_mandates and
  // commerce_purchases. No row is written and no mandate exists for anyone until they sign one with their passkey: nothing
  // may be bought for a household by this step, and no existing record changes meaning. The column defaults to no questions.
  // (h) 24 Nov 2026, R13 (server/fx.ts, server/abroad.ts, server/fx-goals.ts): the paper bank's foreign-currency side. Its
  // four tables (fx_fills, xb_payees, xb_payments, fx_goals) are made by schema.sql, and its accounts are opened only when the owner first changes money into
  // another currency. Nothing of a v7 household is written: its rupee books keep their meaning, and its profile reads the
  // new time zone and jurisdiction as Asia/Kolkata and India (household.ts zoneOf, jurisdictionOf) without a stored value,
  // so no term, deadline or permission is attached that the owner did not accept. Hence no alter and no fill here.
  // (l) 24 Nov 2026, R13 institutional (server/netting.ts, rfq.ts, institutional.ts): six new tables made by schema.sql, for claims
  // between workspaces and the cycles that net them, requests for quotes, and model portfolios with their offers. The approval
  // policy's new fields (amount bands, each member's limit) live in the workspace's existing policy_json and need no column; a
  // policy without them reads as no bands and no limits. No row is written, nothing is offered, agreed, signed or limited for anyone.
  // (m) 24 Nov 2026, R13 E4 (the work directory, server/directory.ts): two new tables made by schema.sql,
  // directory_listings and directory_quotes. No column is added and no row is written: nobody is listed, quoted or hired
  // by this step, and no existing job, milestone or record changes meaning. (The dispute step of R13 E3 adds no column:
  // a milestone's terms live in its own record, and its states are new values of the existing state column.)
  // (k) 24 Nov 2026, the R13 review's lead L-09 (docs/SECURITY-REVIEW-R13.md): three indexes made by schema.sql,
  // programs(user_id), actions(program_id) and bills(user_id), so that one tenant's rows are found without reading every
  // tenant's. Indexes only: no row is written or changed, and no record means anything new.
  // (p) 24 Nov 2026, R13 (server/records.ts, the purge): one new table made by schema.sql, purge_runs, the append-only closing
  // summary of an owner-approved removal of an erased person's financial records. No row is written and nothing is removed by this
  // step: nobody's records are purged until the owner approves a run with a passkey, after the person's retention period has ended.
  // (q) 24 Nov 2026, R13 (server/chain-books.ts, closing the books of a replaced chain): one new table made by schema.sql,
  // chain_closings, append-only. No row is written and no entry is posted by this step: the books of a chain the wallet service
  // no longer runs are closed only when the owner approves that closing with a passkey, never automatically.
  // (v) 24 Nov 2026, R13 not-met rows (server/dispute-pause.ts, channel-terms.ts, institution-setup.ts): three new tables made by
  // schema.sql, dispute_pauses, channel_terms and institution_setups, and one index. No column is added and no row is written: nobody is
  // paused, no channel has terms and no institution is set up for anyone by this step, and no existing record changes meaning.
  // (r) 24 Nov 2026, R13 hardening (ASVS 5.0 pass; RISK-068, Q-062): three columns and one change of how old codes are kept.
  // webauthn_credentials.cool_off_until: until when a passkey added to an account is limited (server/passkeys.ts COOL_OFF_MS);
  // NULL for every passkey that exists, so none is limited by the step. sessions.stepup_credential_id: which passkey gave a
  // session its latest confirmation; NULL for sessions from before, read as "not known", which only ever asks for a new
  // confirmation. approvals.size_paise: the size a request was measured at when it was made (it was worked out and not kept);
  // NULL for requests from before, which are measured from their document as before. And the saved recovery codes made before
  // v3, kept as a salted SHA-256, are put under scrypt (algo 'scrypt-sha256': scrypt of that very digest), so a copied
  // database no longer lets them be guessed at SHA-256 speed (ASVS 5.0 V6.5.2; OWASP Password Storage Cheat Sheet, "Upgrading
  // legacy hashes"). The same codes keep working, for the same person, until used or replaced: nothing changes meaning.
  // (w) 25 Nov 2026, R13 Ask on the Anthropic API (server/ask-models.ts): one new table made by schema.sql, ai_attempts, the
  // record of every request to the API with its model, tokens and cost, which the spending limits count, and its indexes.
  // No column is added and no row is written: no model was asked through it before, nothing is spent, charged or limited
  // for anyone by this step, and ai_calls keeps its meaning (the question, and the model that answered it).
  '7': {
    to: '8',
    alter: (db) => {
      addColumn(db, 'conversation_turns', 'clarify_json', `TEXT NOT NULL DEFAULT '[]'`)
      addColumn(db, 'pv_orders', 'funds_at', 'INTEGER')
      addColumn(db, 'earn_milestones', 'due_at', 'INTEGER')
      addColumn(db, 'payees', 'name_check', 'TEXT')
      addColumn(db, 'payees', 'registered_name', 'TEXT')
      addColumn(db, 'earn_milestones', 'terms_id', 'TEXT')
      // (r)
      addColumn(db, 'webauthn_credentials', 'cool_off_until', 'INTEGER')
      addColumn(db, 'sessions', 'stepup_credential_id', 'TEXT')
      addColumn(db, 'approvals', 'size_paise', 'INTEGER')
    },
    fill: (db) => {
      // (a) fund purchases: when their money reached the fund house
      const before = `venue = 'paper-mf' AND side = 'buy' AND json_extract(meta_json, '$.fundsDueAt') IS NULL`
      db.run(`UPDATE pv_orders SET funds_at = created_at WHERE ${before} AND funds_at IS NULL AND state IN ('accepted', 'filled', 'partially_filled')`)
      db.run(`UPDATE pv_orders SET state = 'funded' WHERE ${before} AND state = 'accepted' AND funds_at IS NOT NULL`)
      // (b) the paper escrow: nothing to fill. Milestones from before keep the terms they were opened on (see above).
      // (d) the on-chain wallet's history, booked at the next sync
      for (const r of db.all<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'vault.workspace:%'`)) {
        db.run(`INSERT OR IGNORE INTO chain_books (user_id, network, backfill) VALUES (?, 'eip155:31337', 'needed')`, r.key.slice('vault.workspace:'.length))
      }
      // (r) the saved codes made before v3, put under scrypt
      layerLegacyCodes(db)
    },
  },
  // The v8 to v9 step is one step with lettered parts, shared by the R14 work (each part is its own block):
  // (d) 25 Nov 2026, R14 Grow (server/watchlist.ts): one new table made by schema.sql, watchlist_items, a household's list of the
  // names it watches. No column is added and no row is written: nobody watches anything, and nothing is bought, sold, limited or
  // approved for anyone by this step. Every existing household, its books and its records keep their meaning.
  '8': {
    to: '9',
    alter: () => { /* (d) nothing to alter: the table is made by schema.sql */ },
    fill: () => { /* (d) nothing to fill: the list starts empty for every household */ },
  },
  // 25 Nov 2026, R14 account access: its own step, v9 to v10 (the v8 to v9 step is the watchlist's, part (d), released first).
  // (a) Account access (Priority 1; server/access.ts, server/google.ts). Two nullable columns on users: the address an
  // account is created with, and its lower-cased form for lookup (not unique: an address nobody has confirmed proves
  // nothing, so it reserves nothing). Three tables made by schema.sql: email_logins (what lets that address and the
  // password sign in, at one fixed cost whoever else uses the address), federated_identities (a Google account that signs
  // in to a QED account) and oauth_states (the ten-minute state of one OpenID Connect sign-in). Nothing is filled: every
  // account that exists keeps its handle, its password, its passkeys with the authority they had, its saved codes and
  // its addresses, and gains no sign-in address, no Google identity and no permission it did not have. Saved codes are no
  // longer made at sign-up from this version on; the ones that exist keep working and keep their meaning (H2).
  '9': {
    to: '10',
    alter: (db) => {
      // (a)
      addColumn(db, 'users', 'email', 'TEXT')
      addColumn(db, 'users', 'email_key', 'TEXT')
    },
    fill: () => {
      // (a) nothing to fill
    },
  },
}

/**
 * The scrypt this module puts over a pre-v3 code's SHA-256 digest (part (r) of the v7 to v8 step), kept here as the step's
 * own copy, as V5_INSTRUMENT_IDS is: server/passkeys.ts checks a code against it with the same figures (LEGACY_LAYER), and
 * server/passkeys.test.ts holds the two equal.
 */
export const LEGACY_LAYER = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 32 } as const
/** The scrypt salt of a layered code: derived from the row's own random salt, so it is unique to the batch as that one is. */
export const legacyLayerSalt = (salt: string): Buffer => createHash('sha256').update(`qed/recovery-code-layer/v1\n${salt}`).digest().subarray(0, 16)
/** A pre-v3 code's stored SHA-256 digest (hex), put under scrypt; the result is what a layered row stores. */
export const layerDigest = (digestHex: string, salt: string): string => scryptSync(digestHex, legacyLayerSalt(salt), LEGACY_LAYER.keylen, { N: LEGACY_LAYER.N, r: LEGACY_LAYER.r, p: LEGACY_LAYER.p, maxmem: LEGACY_LAYER.maxmem }).toString('hex')
/**
 * Puts every saved recovery code still kept as a bare salted SHA-256 (made before schema v3) under scrypt, in place. Used and
 * replaced codes too: none of them opens anything, but a digest at SHA-256 speed is what this removes. Idempotent: a layered
 * row is 'scrypt-sha256' and is not touched again. Returns how many rows it layered.
 */
export function layerLegacyCodes(db: Db): number {
  const rows = db.all<{ id: string; salt: string; code_hash: string }>(`SELECT id, salt, code_hash FROM recovery_codes WHERE algo = 'sha256'`)
  for (const r of rows) db.run(`UPDATE recovery_codes SET code_hash = ?, algo = 'scrypt-sha256' WHERE id = ? AND algo = 'sha256'`, layerDigest(r.code_hash, r.salt), r.id)
  return rows.length
}
/**
 * The protection delay of a real installation (passkeys.ts PROTECTION_DELAY_MS, 72 hours), copied here as the v5 step
 * copies its ids: the v6 to v7 step must not change with a later setting, and this module imports nothing from the rest of
 * the server. A test installation's shorter delay would only downgrade fewer passkeys; the full one is the careful side.
 */
const V7_PROTECTION_DELAY_MS = 72 * 3600_000

/**
 * The canonical instrument ids server/registry.ts gives the books' assets at schema v5 (ADR-0012, stage S2). The v4 to v5
 * step keeps its own copy, so that a later change to the registry cannot change what the step does to an old database,
 * and this module imports nothing from the rest of the server. server/canonical-ids.test.ts checks that a migrated row
 * holds the id a new row is written with. PCT, the unit rates are quoted in, has none.
 */
const V5_INSTRUMENT_IDS: ReadonlyMap<string, string> = new Map([
  ['INR', 'iso4217:INR'], ['USD', 'iso4217:USD'], ['EUR', 'iso4217:EUR'],
  ['BTC', 'claim:paper-crypto/BTC'], ['ETH', 'claim:paper-crypto/ETH'], ['USDT', 'claim:paper-crypto/USDT'], ['PAXG', 'claim:binance/PAXG'],
  ...['120716', '120684', '122639', '148381', '119788', '118701', '119110', '119771'].map((code): [string, string] => [`MF:${code}`, `claim:paper-mf/${code}`]),
])

type Step = { to: string; alter: (db: Db) => void; fill: (db: Db) => void }

/** ALTER TABLE ... ADD COLUMN, unless the table has that column already. */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/** The schema version a database records; undefined for a new file, which has no meta table yet. */
function recordedVersion(db: Db): string | undefined {
  try { return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version')?.value } catch { return undefined }
}

/**
 * The steps from a recorded version to SCHEMA_VERSION, in order. A version this build has no step from is refused. A
 * version above this build's was written by a newer build (a rollback of the code without its data): refused with the
 * way back, never "reset", which would seal the newer data away (docs/DEPLOY.md, "Rollback").
 */
function migrationPlan(have: string | undefined, path: string): Step[] {
  if (have !== undefined && /^\d{1,6}$/.test(have) && Number(have) > Number(SCHEMA_VERSION)) {
    throw new MigrationRefused('newer_schema', `Database ${path} is at schema version ${have}, written by a newer build of QED; this build is at version ${SCHEMA_VERSION} and cannot read it. Nothing was changed. Run the newer build again, or, to go back to this build, restore the copy sealed before that migration (migration-copies/ beside the database; docs/DEPLOY.md, "Rollback"), which loses what was written after it.`)
  }
  const plan: Step[] = []
  for (let v = have; v && v !== SCHEMA_VERSION;) {
    const m = MIGRATIONS[v]
    if (!m) throw new Error(`Database ${path} has schema version ${have}; this build needs ${SCHEMA_VERSION} and has no migration from ${v}. Move the file aside or run "npm run reset".`)
    plan.push(m); v = m.to
  }
  return plan
}

/**
 * A database file, its journal files and its backups are readable by this user only (mode 600): they hold every
 * account's records (standards gap: they were created 644, readable by every user of the machine).
 */
export function restrictFile(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) { try { chmodSync(p, 0o600) } catch { /* not ours to change */ } }
}

export function openDb(path: string): Db {
  const db = new Db(path)
  if (path !== ':memory:') restrictFile(path)
  const have = recordedVersion(db)
  let plan: Step[]
  // decides whether a copy is sealed; what runs is decided again under the write lock. A refused plan closes the file as found.
  try { plan = migrationPlan(have, path) } catch (e) { if (path === ':memory:') db.close(); else closeAsFound(db, path); throw e }
  // Before anything changes: an encrypted, verified copy under the migration-copy key, or no migration (migration-copy.ts).
  if (plan.length && path !== ':memory:') { try { sealMigrationCopy(path, have!, SCHEMA_VERSION) } catch (e) { closeAsFound(db, path); throw e } }
  db.tx(() => {
    // Planned again from the version read here, under the write lock (BEGIN IMMEDIATE). The API and the engine start
    // together: the other one may have migrated the file while this one sealed its copy (or reused the other's, the file
    // being unchanged) and waited for the lock, and the step must not run twice (the later process used to rebuild the v6
    // tables again; review of 8e9929b). A seal that starts after the other's commit is refused instead (snapshot_changed).
    const steps = migrationPlan(recordedVersion(db), path)
    for (const m of steps) m.alter(db)
    db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'))
    for (const m of steps) m.fill(db)
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'schema_version', SCHEMA_VERSION)
  })
  return db
}

export const j = (v: unknown): string => JSON.stringify(v)
export function parse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** Append a row the interface can stream to the browser. userId null means every signed-in user may see it. */
export function emit(db: Db, now: number, userId: string | null, type: string, payload: unknown = {}): void {
  db.run('INSERT INTO events (ts, user_id, type, payload_json) VALUES (?, ?, ?, ?)', now, userId, type, j(payload))
}

export function audit(db: Db, now: number, userId: string | null, actor: string, action: string, subject: string | null, detail: unknown = {}, ip: string | null = null): void {
  db.run('INSERT INTO audit (ts, user_id, actor, action, subject, detail_json, ip) VALUES (?, ?, ?, ?, ?, ?, ?)', now, userId, actor, action, subject, j(detail), ip)
}

export interface Config {
  dbPath: string
  host: string
  apiPort: number
  webDist: string
  allowedHosts: string[]
  aiProvider: 'auto' | 'anthropic' | 'claude-cli' | 'none' | 'scripted'
  /** The model the command-line client is started with (QED_AI_MODEL). The API path chooses among askModels.order. */
  aiModel: string
  /** A scripted test double's replies (QED_AI_SCRIPT); honoured only on an isolated test stack (QED_TEST_STACK=1). */
  aiScript: string | null
  /** Ask on the Anthropic API (server/ask-models.ts): the models in order of preference, the spending limits, the retries. */
  askModels: AskModelsConfig
  /** Presentation mode (N-003): synthetic market data only, on a database of its own (server/synthetic.ts). */
  presentation: boolean
  secureCookies: boolean
  /**
   * N-006, a production setting: a model's investment proposals wait for a registered investment adviser's review
   * before they can be opened or signed (server/adviser.ts). Off in this build (QED_ADVISER_REVIEW unset).
   */
  adviserReview: boolean
  /** The reviewer's credential for the review queue (QED_ADVISER_TOKEN, at least 32 characters); null: no reviewer. */
  adviserToken: string | null
  /**
   * The most API requests one address may make in a minute: 1,500, which one person never reaches. QED_REQUESTS_PER_MINUTE
   * can lower it anywhere, and raise it only on an isolated test stack (QED_TEST_STACK=1), where the browser suite's
   * parallel journeys are several people behind one address.
   */
  requestsPerMinute: number
  // ---- production conversion (apps/qed-demo/docs/PRODUCTION.md). Unset, every one keeps the local build's behaviour.
  /** The one origin the interface is served at (QED_PUBLIC_ORIGIN, e.g. https://wallet.example.in); null in the local build. */
  publicOrigin: string | null
  /** The passkeys' relying-party id under a public origin: QED_RP_ID or the origin's host name. Null: server/passkeys.ts's local rule. */
  rpId: string | null
  /** The Origin header values accepted. Local build: http:// and each allowed host; with a public origin: that origin only. */
  allowedOrigins: string[]
  /** The session cookie's name: `__Host-qed_session` under HTTPS (bound to this host only, Secure, Path=/), else `qed_session`. */
  cookieName: string
  /** The Strict-Transport-Security value sent on every response (QED_HSTS), or null: the local build is plain HTTP. */
  hsts: string | null
  /** Serve HTTPS directly from these PEM files (QED_TLS_CERT_FILE, QED_TLS_KEY_FILE); null: plain HTTP, or TLS ends at a proxy. */
  tls: { certFile: string; keyFile: string } | null
  /** Reverse proxies in front of the API (QED_TRUST_PROXY_HOPS, 0 to 5). 0: the socket's address is the client's. */
  trustProxyHops: number
  /**
   * How email and text messages leave QED (server/delivery.ts). 'outbox': the local test outbox, the local build's
   * default: nothing is sent, every message is shown on the developer page /dev/outbox as simulated. 'none': no adapter
   * (the default with a public origin, where the outbox is refused): features that need a message say so. 'postmark':
   * email through Postmark (server/postmark.ts), switched on by QED_DELIVERY=postmark with its token and sender address.
   */
  delivery: 'outbox' | 'none' | 'postmark'
  /** The Postmark settings with QED_DELIVERY=postmark (server/postmark-config.ts); null otherwise. */
  postmark: PostmarkConfig | null
  /**
   * The one origin links in messages point to (OWASP: never built from the request's Host header): the public origin,
   * else QED_LINK_ORIGIN when it is one of the allowed origins, else http://localhost:<web port>, where passkeys work.
   */
  linkOrigin: string
  /**
   * Host names named only for a platform's health check (QED_EXTRA_HOSTS under a public origin; Railway's is
   * healthcheck.railway.app): answered on the probes (/api/live, /api/ready, /api/health) and refused (421) everywhere
   * else, so the name cannot reach a page or an account (docs/DEPLOY.md).
   */
  probeHosts: string[]
  /**
   * Sign-in with Google (R14, server/google.ts): set only when QED_GOOGLE_CLIENT_ID and QED_GOOGLE_CLIENT_SECRET are both
   * set; null otherwise, and then its routes answer "not found" and the interface renders no button.
   */
  google: GoogleConfig | null
  /** Whether /api/ready also needs the wallet service to answer (QED_READY_REQUIRES_WALLET=1); off: it is reported only. */
  readyRequiresWallet: boolean
}

/**
 * Ask on the Anthropic API (server/ask-models.ts, docs/DEPLOY.md "Ask's models and spending limits"). Amounts are US$
 * millionths. Every default is sized there against the published prices; each can be set in the environment.
 */
export interface AskModelsConfig {
  /** QED_AI_MODELS: the models Ask may use, best first. A demanding question starts at the first; the last is the economical model, which answers routine questions and is the last fallback. */
  order: string[]
  /** QED_AI_BUDGET_USD: all Ask may ever spend on this installation, counted from every attempt recorded in its database. */
  budget: number
  /** QED_AI_HOURLY_USD: what everyone together may spend in any 60 minutes. */
  hourly: number
  /** QED_AI_PERSON_DAILY_USD: what one person may spend in any 24 hours. */
  personDay: number
  /** QED_AI_SESSION_USD: what one sign-in session may spend. */
  session: number
  /** QED_AI_RESERVE_USD: the end of the budget kept for the economical model; a dearer model is chosen only while it would leave this much. */
  reserve: number
  /** QED_AI_MAX_OUTPUT_TOKENS: the output allowance of one request (its max_tokens, thinking included). */
  maxOutputTokens: number
  /** QED_AI_MAX_INPUT_TOKENS: the largest prompt sent, as estimated before the call (model-prices.ts estimateInputTokens). */
  maxInputTokens: number
  /** QED_AI_MAX_ATTEMPTS: API requests for one question at most, retries and fallbacks included. */
  maxAttempts: number
  /** QED_AI_TIMEOUT_MS: one request's time limit. All the attempts for one question together get twice this. */
  timeoutMs: number
  /** QED_AI_SERVER_FALLBACK=1: send the API's own refusal fallback ("fallbacks": "default"), reserving what its run could cost. Off by default. */
  serverFallback: boolean
  /** QED_AI_MODELS_REFRESH_MIN: how often the models the key may use are read again (GET /v1/models). */
  refreshMs: number
}
export const DEFAULT_ASK_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5'] as const
function askModelsConfig(env: NodeJS.ProcessEnv): AskModelsConfig {
  const fail = (why: string): never => { throw new Error(`Configuration: ${why}`) }
  const order = (env.QED_AI_MODELS || DEFAULT_ASK_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean)
  if (!order.length) fail('QED_AI_MODELS must name at least one model.')
  for (const m of order) if (!PRICES[m]) fail(`QED_AI_MODELS names ${m}, which has no verified price in server/model-prices.ts, so QED could not bound what it costs. Choose from ${Object.keys(PRICES).join(', ')}.`)
  if (new Set(order).size !== order.length) fail('QED_AI_MODELS names a model twice.')
  const usd = (name: string, dflt: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return Math.round(dflt * MICROS)
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 0 || v > 10_000) fail(`${name} must be an amount in US dollars from 0 to 10000 (it was ${raw}).`)
    return Math.round(v * MICROS)
  }
  const whole = (name: string, dflt: number, min: number, max: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return dflt
    const v = Number(raw)
    if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number from ${min} to ${max} (it was ${raw}).`)
    return v
  }
  const c: AskModelsConfig = {
    order, budget: usd('QED_AI_BUDGET_USD', 12.5), hourly: usd('QED_AI_HOURLY_USD', 3), personDay: usd('QED_AI_PERSON_DAILY_USD', 2), session: usd('QED_AI_SESSION_USD', 1),
    reserve: usd('QED_AI_RESERVE_USD', 1), maxOutputTokens: whole('QED_AI_MAX_OUTPUT_TOKENS', 8_000, 1_024, 128_000), maxInputTokens: whole('QED_AI_MAX_INPUT_TOKENS', 40_000, 4_000, 1_000_000),
    maxAttempts: whole('QED_AI_MAX_ATTEMPTS', 3, 1, 5), timeoutMs: whole('QED_AI_TIMEOUT_MS', 180_000, 10_000, 600_000),
    serverFallback: env.QED_AI_SERVER_FALLBACK === '1', refreshMs: whole('QED_AI_MODELS_REFRESH_MIN', 30, 1, 1440) * 60_000,
  }
  if (c.reserve > c.budget) fail('QED_AI_RESERVE_USD cannot be more than QED_AI_BUDGET_USD: it is the part of the budget kept for the economical model.')
  return c
}

/** A host name that is an IP address, which browsers refuse as a passkey relying-party id. */
const isIp = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[')
/** Host names that only ever mean this computer; plain HTTP is accepted for them (a secure context in browsers). */
const isLoopbackName = (h: string): boolean => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'

/**
 * The production settings of loadConfig, checked when the process starts: a wrong origin, relying-party id or TLS setting
 * stops it with the reason rather than serving with a weaker one. Nothing here is read when QED_PUBLIC_ORIGIN is unset,
 * except QED_TRUST_PROXY_HOPS and the TLS files (which then need it).
 */
function productionSettings(env: NodeJS.ProcessEnv): Pick<Config, 'publicOrigin' | 'rpId' | 'tls' | 'trustProxyHops' | 'hsts'> & { host: string | null; https: boolean } {
  const fail = (why: string): never => { throw new Error(`Configuration: ${why}`) }
  const hops = env.QED_TRUST_PROXY_HOPS === undefined || env.QED_TRUST_PROXY_HOPS === '' ? 0 : Number(env.QED_TRUST_PROXY_HOPS)
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) fail('QED_TRUST_PROXY_HOPS must be a whole number from 0 to 5: how many reverse proxies stand in front of the API.')
  const certFile = env.QED_TLS_CERT_FILE || null, keyFile = env.QED_TLS_KEY_FILE || null
  if (!!certFile !== !!keyFile) fail('QED_TLS_CERT_FILE and QED_TLS_KEY_FILE are set together or not at all.')
  const tls = certFile && keyFile ? { certFile, keyFile } : null
  const raw = env.QED_PUBLIC_ORIGIN
  if (!raw) {
    if (tls) fail('QED_TLS_CERT_FILE needs QED_PUBLIC_ORIGIN: the https:// origin the certificate is for.')
    return { publicOrigin: null, rpId: null, tls: null, trustProxyHops: hops, hsts: null, host: null, https: false }
  }
  let u: URL
  try { u = new URL(raw) } catch { return fail(`QED_PUBLIC_ORIGIN (${raw}) is not a URL.`) }
  if (u.origin !== raw.replace(/\/$/, '') || u.username || u.password) fail(`QED_PUBLIC_ORIGIN must be an origin only, scheme, host and port, such as https://wallet.example.in (it was ${raw}).`)
  const https = u.protocol === 'https:'
  if (!https && !(u.protocol === 'http:' && isLoopbackName(u.hostname))) fail('QED_PUBLIC_ORIGIN must use https://; plain http:// is accepted only for a name that means this computer (localhost, *.localhost).')
  if (tls && !https) fail('QED_TLS_CERT_FILE is set, so QED_PUBLIC_ORIGIN must be https://.')
  if (isIp(u.hostname)) fail('QED_PUBLIC_ORIGIN must use a host name, not an IP address: passkeys need a domain as their relying-party id.')
  const rpId = (env.QED_RP_ID || u.hostname).toLowerCase()
  if (isIp(rpId) || !(u.hostname === rpId || u.hostname.endsWith(`.${rpId}`))) fail(`QED_RP_ID (${rpId}) must be the origin's host name (${u.hostname}) or a domain it belongs to.`)
  const hsts = !https ? null : env.QED_HSTS === 'off' ? null : env.QED_HSTS || 'max-age=31536000; includeSubDomains'
  if (hsts !== null && !/^max-age=\d+(; ?includeSubDomains)?(; ?preload)?$/.test(hsts)) fail(`QED_HSTS must be "off" or a Strict-Transport-Security value such as "max-age=31536000; includeSubDomains" (it was ${hsts}).`)
  return { publicOrigin: u.origin, rpId, tls, trustProxyHops: hops, hsts, host: u.host, https }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiPort = Number(env.QED_API_PORT ?? 5175)
  const host = env.QED_HOST ?? '127.0.0.1'
  const uiPorts = [apiPort, Number(env.QED_WEB_PORT ?? 5174)]
  const prod = productionSettings(env)
  // Secure by default when reachable (NIST SSDF PW.9): the local build's settings (plain HTTP, localhost names) are only
  // safe on this computer, because its Host check stops browsers, not a client that sends "Host: localhost" itself.
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !prod.publicOrigin) {
    throw new Error(`Configuration: QED_HOST=${host} makes the API reachable from other computers, which needs the production settings: set QED_PUBLIC_ORIGIN to its https:// origin (docs/PRODUCTION.md), or listen on 127.0.0.1.`)
  }
  // With a public origin the API answers to that host only (and to any named for a platform's health check), and accepts
  // requests from that origin only. Without one, the local build's names, as before.
  const extraHosts = (env.QED_EXTRA_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  const allowedHosts = prod.host ? [prod.host, ...extraHosts] : uiPorts.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`])
  const provider = (env.QED_AI_PROVIDER ?? 'auto') as Config['aiProvider']
  return {
    dbPath: env.QED_DB ?? join(APP_ROOT, 'data', 'qed.db'),
    host,
    apiPort,
    webDist: env.QED_WEB_DIST ?? join(APP_ROOT, 'dist'),
    allowedHosts,
    aiProvider: provider,
    aiModel: env.QED_AI_MODEL ?? 'claude-opus-5-5',
    aiScript: env.QED_AI_SCRIPT ?? null,
    askModels: askModelsConfig(env),
    presentation: env.QED_PRESENTATION === '1',
    secureCookies: env.QED_SECURE_COOKIES === '1' || prod.https,
    publicOrigin: prod.publicOrigin,
    rpId: prod.rpId,
    allowedOrigins: prod.publicOrigin ? [prod.publicOrigin] : allowedHosts.map((h) => `http://${h}`),
    // The __Host- prefix makes the browser refuse the cookie unless it is Secure, has Path=/ and no Domain: a sibling
    // subdomain or a plain-HTTP page cannot set or overwrite it (RFC 6265bis, "Cookie Name Prefixes").
    cookieName: prod.https ? '__Host-qed_session' : 'qed_session',
    hsts: prod.hsts,
    tls: prod.tls,
    trustProxyHops: prod.trustProxyHops,
    adviserReview: env.QED_ADVISER_REVIEW === '1',
    adviserToken: (env.QED_ADVISER_TOKEN ?? '').length >= 32 ? env.QED_ADVISER_TOKEN! : null,
    requestsPerMinute: ((asked) => (env.QED_TEST_STACK === '1' ? asked : Math.min(1500, asked)))(Math.max(60, Number(env.QED_REQUESTS_PER_MINUTE) || 1500)),
    delivery: deliveryMode(env, prod.publicOrigin),
    postmark: env.QED_DELIVERY === 'postmark' ? postmarkConfig(env, prod.publicOrigin) : null,
    linkOrigin: linkOriginOf(env, prod.publicOrigin, uiPorts[1]!, prod.publicOrigin ? [prod.publicOrigin] : allowedHosts.map((h) => `http://${h}`)),
    probeHosts: prod.host ? extraHosts.filter((h) => h !== prod.host) : [],
    readyRequiresWallet: env.QED_READY_REQUIRES_WALLET === '1',
    google: googleConfig(env, linkOriginOf(env, prod.publicOrigin, uiPorts[1]!, prod.publicOrigin ? [prod.publicOrigin] : allowedHosts.map((h) => `http://${h}`)), prod.publicOrigin),
  }
}

/**
 * The delivery adapter's mode. The local test outbox shows every message (reset links included) to whoever can open the
 * developer page, so it is refused when QED is served at a public origin; there the default is no adapter.
 */
function deliveryMode(env: NodeJS.ProcessEnv, publicOrigin: string | null): Config['delivery'] {
  const asked = env.QED_DELIVERY ?? (publicOrigin ? 'none' : 'outbox')
  if (asked !== 'outbox' && asked !== 'none' && asked !== 'postmark') throw new Error(`Configuration: QED_DELIVERY must be "outbox" (the local test outbox), "none" (no adapter) or "postmark" (email through Postmark; it was "${asked}"). No text-message provider is configured in this build.`)
  if (asked === 'outbox' && publicOrigin) throw new Error('Configuration: QED_DELIVERY=outbox shows every message, reset links included, on a developer page; it is for this computer only and cannot be used with QED_PUBLIC_ORIGIN.')
  return asked
}
function linkOriginOf(env: NodeJS.ProcessEnv, publicOrigin: string | null, webPort: number, allowed: string[]): string {
  if (publicOrigin) return publicOrigin
  const asked = env.QED_LINK_ORIGIN?.replace(/\/$/, '')
  if (asked) {
    if (!allowed.includes(asked)) throw new Error(`Configuration: QED_LINK_ORIGIN (${asked}) must be one of the origins QED accepts: ${allowed.join(', ')}.`)
    return asked
  }
  return `http://localhost:${webPort}`
}

export const IST_OFFSET_MS = 5.5 * 3600_000
/** Calendar parts of an instant in India Standard Time (UTC+05:30, no daylight saving). */
/** "20 Nov 2026, 09:24 IST": how a moment is written for the owner. */
export const whenIst = (ms: number): string => { const t = ist(ms); return `${t.d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.m - 1]} ${t.y}, ${t.hm} IST` }
export function ist(ms: number): { date: string; hm: string; minutes: number; weekday: number; y: number; m: number; d: number } {
  const t = new Date(ms + IST_OFFSET_MS)
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate()
  const hh = t.getUTCHours(), mm = t.getUTCMinutes()
  const p = (n: number) => String(n).padStart(2, '0')
  return { date: `${y}-${p(m)}-${p(d)}`, hm: `${p(hh)}:${p(mm)}`, minutes: hh * 60 + mm, weekday: t.getUTCDay(), y, m, d }
}
/** The instant of a given IST calendar date and time. */
export function istInstant(date: string, hm: string): number {
  return Date.parse(`${date}T${hm}:00.000Z`) - IST_OFFSET_MS
}
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}
