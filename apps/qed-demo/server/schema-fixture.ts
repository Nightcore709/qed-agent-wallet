/**
 * Test support for the schema migrations: turn a database file this build made back into the shape schema v5 left, so the
 * v5 to v6 step (stage S3 of the global money model, server/migrate-v6.ts) is tested on books written by the wallet's own
 * paths. Used by tests only; it never opens the review database.
 */
import { DatabaseSync } from 'node:sqlite'

export type AmountTable = 'postings' | 'balances' | 'holds'
export const AMOUNT_TABLES: readonly AmountTable[] = ['postings', 'balances', 'holds']

/** The columns schema v5 gave the three tables (server/schema.sql at a198bcf, main before S3). */
export const V5_COLUMNS: Record<AmountTable, string[]> = {
  postings: ['id', 'entry_id', 'account_id', 'asset_id', 'amount', 'instrument_id'],
  balances: ['account_id', 'amount'],
  holds: ['id', 'user_id', 'account_id', 'amount', 'reason', 'ref', 'created_at', 'released_at'],
}

/** The three tables as schema v5 created them (server/schema.sql at a198bcf), then their indexes and triggers. */
const V5_TABLES_SQL = `
CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL,
  amount INTEGER NOT NULL,      -- signed; positive = debit
  instrument_id TEXT            -- since v5: the account's canonical instrument id, beside asset_id (see accounts)
) STRICT;
CREATE TABLE balances (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  amount INTEGER NOT NULL
) STRICT;
CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  UNIQUE (user_id, ref)
) STRICT;`
const V5_OBJECTS_SQL = `
CREATE INDEX postings_account ON postings(account_id);
CREATE INDEX postings_entry ON postings(entry_id);
CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings BEGIN SELECT RAISE(ABORT, 'ledger postings are append-only'); END;
CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings BEGIN SELECT RAISE(ABORT, 'ledger postings are append-only'); END;`

/**
 * Rebuild the three tables of a closed v6 database file in their v5 shape, every row kept, and set the version to 5. Refuses
 * an amount that v5 cannot hold (one past 64 bits): such books cannot go back to v5.
 */
export function toSchemaV5(path: string): void {
  const raw = new DatabaseSync(path)
  try {
    raw.exec('PRAGMA foreign_keys = ON')
    const tooBig = (raw.prepare('SELECT (SELECT COUNT(*) FROM postings WHERE amount IS NULL) + (SELECT COUNT(*) FROM balances WHERE amount IS NULL) + (SELECT COUNT(*) FROM holds WHERE amount IS NULL) n').get() as { n: number }).n
    if (tooBig) throw new Error(`${tooBig} amounts do not fit 64 bits; schema v5 cannot hold them`)
    raw.exec('BEGIN IMMEDIATE')
    for (const t of AMOUNT_TABLES) raw.exec(`ALTER TABLE ${t} RENAME TO ${t}_v6`)
    raw.exec(V5_TABLES_SQL)
    for (const t of AMOUNT_TABLES) raw.exec(`INSERT INTO ${t} (${V5_COLUMNS[t].join(', ')}) SELECT ${V5_COLUMNS[t].join(', ')} FROM ${t}_v6`)
    for (const t of AMOUNT_TABLES) raw.exec(`DROP TABLE ${t}_v6`)
    raw.exec(V5_OBJECTS_SQL)
    raw.exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } catch (e) { if (raw.isTransaction) raw.exec('ROLLBACK'); throw e } finally { raw.close() }
}

/** What schema v7 added (R12 recovery, server/core.ts): five columns on three tables, and three tables of its own. */
export const V7_COLUMNS: readonly [string, string][] = [['webauthn_credentials', 'authority'], ['webauthn_credentials', 'authority_reason'], ['users', 'authority_hold_at'], ['users', 'password_reset_at'], ['recovery_requests', 'via'], ['recovery_requests', 'ready_sent_at']]
export const V7_TABLES: readonly string[] = ['contact_points', 'one_time_tokens', 'outbound_messages']

/**
 * What schema v8 added (R12, server/core.ts): the time a fund purchase's money reached the fund house (task comparison
 * gap 17); a payee's name check (gap 4); for the paper escrow (gap 16, R13 section 2) two columns on earn_milestones with an
 * index and a trigger, and four tables of its own (their indexes and triggers go with them); and (R13, part d) the
 * on-chain wallet's books: chain_books, chain_movements, chain_recon (their indexes and triggers go with them); (part e) the
 * incident log, incident_events before incidents because it refers to it; and Grow's ideas (ideas, idea_events), which
 * schema.sql makes at every open.
 */
export const V8_COLUMNS: readonly [string, string][] = [['pv_orders', 'funds_at'], ['earn_milestones', 'due_at'], ['earn_milestones', 'terms_id'], ['payees', 'name_check'], ['payees', 'registered_name'], ['conversation_turns', 'clarify_json'],
  // R13 hardening (part (r) of the v8 step): a new passkey's cool-off, the passkey behind a session's confirmation, a request's size
  ['webauthn_credentials', 'cool_off_until'], ['sessions', 'stepup_credential_id'], ['approvals', 'size_paise']]
/** The payee name-check columns alone (R12 task comparison, gap 4), for tests that name them. */
export const V8_PAYEE_CHECK_COLUMNS: readonly [string, string][] = [['payees', 'name_check'], ['payees', 'registered_name']]
export const V8_INDEXES: readonly string[] = ['earn_milestones_due', 'chain_movements_live', 'chain_movements_block', 'chain_recon_user', 'access_log_person', 'commerce_mandates_user', 'commerce_purchases_user', 'netting_claims_ws', 'directory_listings_open', 'directory_quotes_listing', 'dispute_pauses_user', 'programs_user', 'actions_program', 'bills_user', 'purge_runs_person', 'chain_closings_user', 'ai_attempts_started', 'ai_attempts_person', 'ai_attempts_session', 'ai_attempts_call']
/** Triggers on a table that is older than v8 (they go before its v8 columns can). */
export const V8_TRIGGERS: readonly string[] = ['earn_milestones_terms_fixed', 'purge_runs_no_update', 'purge_runs_no_delete', 'chain_closings_no_update', 'chain_closings_no_delete']
/**
 * In an order that drops a table before the one it refers to. And (R13, part f) Spend's subscription reviews, the paper bank's
 * mandates and revocations with their channels (channels first: they refer to the revocation); (part g) the
 * person's key, access log and erasures; and (part m) the work directory, quotes before the listings they refer to.
 */
export const V8_TABLES: readonly string[] = ['dispute_pauses', 'channel_terms', 'institution_setups', 'earn_disputes', 'earn_steps', 'earn_terms_accepts', 'earn_terms', 'chain_books', 'chain_movements', 'chain_recon', 'incident_events', 'incidents', 'idea_events', 'ideas', 'subscription_reviews', 'paper_mandates', 'revocation_channels', 'revocations', 'person_keys', 'access_log', 'erasures',
  // R13 (part (h) of the v8 step): the paper bank's foreign-currency side; their indexes and triggers go with them
  'xb_payments', 'xb_payees', 'fx_fills', 'fx_goals',
  // R13 Ask and agent commerce (part (i))
  'commerce_purchases', 'commerce_mandates',
  // R13 institutional (part (l) of the v8 step): claims, cycles, quotes and models; offers and participants before what they refer to
  'model_offers', 'model_portfolios', 'rfqs', 'netting_participants', 'netting_cycles', 'netting_claims',
  // R13 E4 (part (m)): the work directory, quotes before the listings they refer to
  'directory_quotes', 'directory_listings',
  // R13 (part (p) of the v8 step): the closing summaries of purged records
  'purge_runs',
  // R13 (part (q)): owner-approved closings of a replaced chain's books
  'chain_closings',
  // R13 (part (w)): every request Ask made to the Anthropic API, with its model, tokens and cost
  'ai_attempts']

/** What schema v9 added (R14, server/core.ts): part (d), Grow's watchlist, made by schema.sql at every open. */
export const V9_TABLES: readonly string[] = ['watchlist_items']

/**
 * What schema v10 added (R14 account access, part (a); server/core.ts): two columns on users with their index, and three
 * tables of their own (their indexes go with them).
 */
export const V10_COLUMNS: readonly [string, string][] = [['users', 'email'], ['users', 'email_key']]
export const V10_INDEXES: readonly string[] = ['users_email_key']
export const V10_TABLES: readonly string[] = ['email_logins', 'federated_identities', 'oauth_states']

/** Take what schema v10 added out of a closed database file this build made, and set the version to 9: the shape production has after the watchlist's release. */
export function toSchemaV9(path: string): void {
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    for (const t of V10_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`)
    for (const i of V10_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${i}`)
    for (const [t, c] of V10_COLUMNS) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`)
    raw.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } catch (e) { if (raw.isTransaction) raw.exec('ROLLBACK'); throw e } finally { raw.close() }
}

/** Take what schemas v9 and v10 added out of a closed database file this build made, and set the version to 8: the shape v8 left. */
export function toSchemaV8(path: string): void {
  toSchemaV9(path)
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    for (const t of V9_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`)
    raw.exec(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } catch (e) { if (raw.isTransaction) raw.exec('ROLLBACK'); throw e } finally { raw.close() }
}

/** Take what schemas v8, v9 and v10 added out of a closed database file this build made, and set the version to 7: the shape v7 left. */
export function toSchemaV7(path: string): void {
  toSchemaV8(path)
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    for (const t of V8_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`)
    for (const g of V8_TRIGGERS) raw.exec(`DROP TRIGGER IF EXISTS ${g}`)
    for (const i of V8_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${i}`)
    for (const [t, c] of V8_COLUMNS) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`)
    raw.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } catch (e) { if (raw.isTransaction) raw.exec('ROLLBACK'); throw e } finally { raw.close() }
}

/** Take what schemas v7 and v8 added out of a closed database file this build made, and set the version to 6: the shape v6 left. */
export function toSchemaV6(path: string): void {
  toSchemaV7(path)
  const raw = new DatabaseSync(path)
  try {
    raw.exec('BEGIN IMMEDIATE')
    for (const t of V7_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`)
    for (const [t, c] of V7_COLUMNS) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`)
    raw.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`)
    raw.exec('COMMIT')
  } catch (e) { if (raw.isTransaction) raw.exec('ROLLBACK'); throw e } finally { raw.close() }
}
