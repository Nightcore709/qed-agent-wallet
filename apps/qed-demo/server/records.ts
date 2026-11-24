/**
 * The person's data rights (register N-007): export of everything QED holds about them, deletion of the account with a stated
 * retention schedule, and a year of access logs they can read. Written for a paper build: nothing here claims a licence or a
 * legal opinion.
 *
 * What deletion does, and does not do:
 *  - The person asks with a fresh passkey confirmation; the request waits DELETION_DELAY_MS and can be cancelled until then.
 *    It is refused while money is in flight, at the request and again when the delay ends.
 *  - Then: the person's sign-in material, sessions, contact points, messages and notices are deleted; free-text personal
 *    fields in records that are kept are overwritten; the access log's sealed details are made unreadable by destroying the
 *    person's key (person_keys). The financial and audit records are KEPT, under a pseudonymous id, for the period in
 *    RETENTION, and are named in the schedule the person is shown.
 *  - It never claims physical erasure. SQLite may leave earlier bytes in free pages and the write-ahead log, and every copy
 *    of the database made before (a backup, a migration copy) keeps what it held, key included, until its data key is
 *    destroyed (server/sealed-expiry.ts: SEALED_WINDOW_DAYS plus KEY_ROTATION_DAYS, run by the operator).
 *  - It is refused while the person's on-chain wallet holds funds or has a job in flight (moneyInFlight).
 *
 * The purge (purgeCandidates, runPurge): after a person's retention period (erasures.retain_until) the financial records
 * kept for them can be removed, but only in a run an approver named by QED_PURGE_APPROVERS approves with a fresh passkey,
 * person by person, against the preview they were shown. It is never run by the engine. Each removal is one transaction that
 * writes the closing summary (purge_runs, append-only) with a digest of every row removed; the person's ledger and receipt
 * chain are verified first and the run is refused if either is already broken.
 *
 * TABLES lists every table of the schema. server/records.test.ts reads the live schema and fails when a table is missing
 * from it, so that a new table that names a person cannot be left out of the export or the deletion without a decision.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AppError, audit, type Db, j, newId, parse } from './core.ts'
import { verifyLedger } from './ledger.ts'
import { verifyChain } from './receipts.ts'
import { KEY_ROTATION_DAYS, SEALED_WINDOW_DAYS } from './sealed-expiry.ts'

const DAY = 86_400_000
const seconds = (name: string, fallback: number): number => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v * 1000 : fallback }
/** How long a deletion request waits, and can be cancelled. Seven days; a test installation may set QED_DELETION_DELAY_SEC. */
export const DELETION_DELAY_MS = seconds('QED_DELETION_DELAY_SEC', 7 * DAY)
/** The access log is kept and shown for a year; rows older than this are removed when a new one is written. */
export const ACCESS_LOG_SHOWN_MS = 365 * DAY
const ACCESS_LOG_KEPT_MS = 400 * DAY

export const RETENTION = {
  financialYears: 5,
  logDays: 365,
  sources: [
    { id: 'R1', claim: 'Transaction records are kept five years from the date of the transaction, and identity records five years after the relationship ends (Prevention of Money-laundering Act 2002, section 12(3) and (4); RBI Commercial Banks KYC Directions 2025, paragraph 50). Binding on a reporting entity such as a bank; QED holds no such status and follows the period as its own', where: 'docs/research/qed-fin-infra-compliance/20261124-r13-primary-sources.md, rows PRV-05a and PRV-05b', status: 'verified 24 Nov 2026 against FIU-IND\'s copy of the Act and RBI\'s page' },
    { id: 'R2', claim: 'Personal data, traffic data and logs are kept at least one year from the processing, then erased unless another law requires longer (Digital Personal Data Protection Rules 2025, rule 8(3); rule 6(1)(e) for the logs that detect unauthorised access). The rule takes effect eighteen months after the Gazette of 13 Nov 2025 (rule 1(4)): it is not yet in force', where: 'the same file, rows PRV-05c and PRV-05d', status: 'verified 24 Nov 2026 against the Gazette text' },
    { id: 'R3', claim: 'Erase when consent is withdrawn or the purpose is no longer served, unless a law requires keeping (Digital Personal Data Protection Act 2023, section 8(7))', where: 'the same file, row PRV-05e', status: 'verified 24 Nov 2026 against the Gazette text' },
    { id: 'R4', claim: 'Logs of ICT systems are kept securely for a rolling 180 days, within India (CERT-In Directions of 28 Apr 2022, direction (iv)). A floor below the year QED keeps its access log for', where: 'the same file, row PRV-13b', status: 'verified 24 Nov 2026 against CERT-In\'s PDF' },
  ],
  backups: `A sealed copy of the database taken before a deletion (a backup, a migration copy) keeps what it held, including the key that opens the person's sealed log details. Sealed copies are kept ${SEALED_WINDOW_DAYS} days from the data they hold, and their data key is replaced every ${KEY_ROTATION_DAYS} days; a key whose newest copy is past that window is destroyed (that is what makes its copies unreadable; the files may remain), so a deletion reaches a sealed copy within ${SEALED_WINDOW_DAYS + KEY_ROTATION_DAYS} days of the copy being taken, provided the operator runs the expiry (npm run backup:expire). Copies kept elsewhere (plaintext archives, copies taken by hand, copies off this computer) are not reached.`,
  physical: 'Deleted and overwritten values may remain in the database file\'s free pages and write-ahead log until SQLite reuses them. QED does not claim physical erasure.',
} as const

// ------------------------------------------------------------------------------------------------ per-person key

function keyOf(db: Db, personId: string, now: number, create: boolean): Buffer | null {
  const row = db.get<{ key: Uint8Array | null; destroyed_at: number | null }>('SELECT key, destroyed_at FROM person_keys WHERE person_id = ?', personId)
  if (row) return row.destroyed_at !== null || !row.key ? null : Buffer.from(row.key)
  if (!create) return null
  const key = randomBytes(32)
  db.run('INSERT INTO person_keys (person_id, key, created_at) VALUES (?, ?, ?)', personId, key, now)
  return key
}
/** Seal text under the person's own key (AES-256-GCM; the person's id is authenticated). */
export function sealFor(db: Db, personId: string, text: string, now: number): string {
  const key = keyOf(db, personId, now, true)
  if (!key) throw new AppError(409, 'key_destroyed', 'This person\'s key has been destroyed.')
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(personId))
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')
}
/** The sealed text, or null when the person's key is destroyed (or the text was altered). */
export function openFor(db: Db, personId: string, sealed: string): string | null {
  const key = keyOf(db, personId, 0, false)
  if (!key) return null
  try {
    const b = Buffer.from(sealed, 'base64url'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
    d.setAAD(Buffer.from(personId)); d.setAuthTag(b.subarray(12, 28))
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
  } catch { return null }
}
/** Overwrite the key with zeros, then clear it: what was sealed under it can no longer be read by anyone holding this database. */
function destroyKey(db: Db, personId: string, now: number): boolean {
  db.run('UPDATE person_keys SET key = zeroblob(32) WHERE person_id = ? AND key IS NOT NULL', personId)
  return db.run('UPDATE person_keys SET key = NULL, destroyed_at = ? WHERE person_id = ? AND destroyed_at IS NULL', now, personId).changes > 0
}

// ------------------------------------------------------------------------------------------------ the access log

/** Record that the person's account was used: when, how, and (sealed under their key) from where. */
export function logAccess(db: Db, personId: string, kind: string, detail: { ip?: string | null; ua?: string | null; [k: string]: unknown }, now: number): void {
  if (db.get('SELECT 1 FROM erasures WHERE person_id = ?', personId)) return
  db.run('INSERT INTO access_log (person_id, ts, kind, detail_sealed) VALUES (?, ?, ?, ?)', personId, now, kind, sealFor(db, personId, j(detail), now))
  db.run('DELETE FROM access_log WHERE person_id = ? AND ts < ?', personId, now - ACCESS_LOG_KEPT_MS)
}
/**
 * A member of a workspace reads it (the signed-in person is not the workspace itself): the workspace's owners are told in their
 * own access log, who read and in which role, so that a person can see who else looked at records that are theirs. One entry
 * for a reader, an owner and a workspace in each quarter hour. Never logs the reader's own reads of their own workspace.
 */
const lastMemberRead = new Map<string, number>()
export const MEMBER_READ_SPACING_MS = 15 * 60_000
export function logMemberRead(db: Db, workspaceId: string, readerId: string, role: string, path: string, now: number): number {
  if (workspaceId === readerId) return 0
  const reader = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', readerId)
  if (!reader) return 0
  const owners = db.all<{ person_id: string }>(`SELECT person_id FROM memberships WHERE workspace_id = ? AND role = 'owner' AND removed_at IS NULL AND person_id <> ?`, workspaceId, readerId).map((r) => r.person_id)
  if (!owners.length && db.get('SELECT 1 FROM users WHERE id = ? AND kind = ?', workspaceId, 'person')) owners.push(workspaceId)
  let n = 0
  for (const owner of owners) {
    const key = `${readerId}|${workspaceId}|${owner}`
    const last = lastMemberRead.get(key)
    if (last !== undefined && now - last < MEMBER_READ_SPACING_MS && now >= last) continue
    lastMemberRead.set(key, now)
    logAccess(db, owner, 'member-read', { workspace: workspaceId, by: reader.display_name, handle: reader.handle, role, path: path.slice(0, 120) }, now)
    n++
  }
  return n
}

export interface AccessEntry { ts: number; kind: string; ip: string | null; device: string | null; method: string | null; by: string | null; workspace: string | null; role: string | null; path: string | null }
export function accessLog(db: Db, personId: string, now: number): AccessEntry[] {
  return db.all<{ ts: number; kind: string; detail_sealed: string | null }>('SELECT ts, kind, detail_sealed FROM access_log WHERE person_id = ? AND ts >= ? ORDER BY ts DESC, id DESC', personId, now - ACCESS_LOG_SHOWN_MS)
    .map((r) => { const d = r.detail_sealed ? parse<Record<string, unknown>>(openFor(db, personId, r.detail_sealed), {}) : {}; const t = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null); return { ts: r.ts, kind: r.kind, ip: t('ip'), device: t('ua'), method: t('method'), by: t('by'), workspace: t('workspace'), role: t('role'), path: t('path') } })
}

// ------------------------------------------------------------------------------------------------ the tables

type OnDelete = 'delete' | 'scrub' | 'keep'
interface Rule {
  /** 'person': rows that name the person; 'shared': market data, terms and service state, about nobody; 'secret': never exported. */
  scope: 'person' | 'shared' | 'secret'
  /** SQL naming the person's rows; every ? is bound to the person's id. */
  where?: string
  /** Columns left out of the export: secrets (hashes, keys, challenges) that are not the person's data to carry away. */
  withhold?: string[]
  onDelete?: OnDelete
  /** For 'scrub': column and the SQL value that replaces it. */
  scrub?: Record<string, string>
  /** For 'keep': the retention that applies, and why. */
  keep?: { period: 'financial' | 'log'; why: string }
  note?: string
  /**
   * For the purge (runPurge): the rows to remove when `where` also names rows that belong to other people's records (a row
   * the person only signed, or accepted), or a reason to leave the table out because other workspaces' records point at it.
   * Required wherever `where` has an OR and the table is purged.
   */
  purge?: { where: string } | { skip: string }
}
const OWN_WS = 'user_id = ?'
const via = (col: string, table: string, parentKey = 'id'): string => `${col} IN (SELECT ${parentKey} FROM ${table} WHERE user_id = ?)`
const FIN = (why: string) => ({ period: 'financial' as const, why })
const LOG = (why: string) => ({ period: 'log' as const, why })

export const TABLES: Record<string, Rule> = {
  // identity and sign-in
  users: { scope: 'person', where: 'id = ?', withhold: ['pw_hash'], onDelete: 'scrub', scrub: { handle: `'erased-' || id`, display_name: `'Erased account'`, pw_hash: `'!'`, profile_json: `'{}'`, stop_reason: 'NULL' }, note: 'The row stays, under a pseudonymous id, because the records kept point to it' },
  sessions: { scope: 'person', where: OWN_WS, withhold: ['id_hash', 'csrf'], onDelete: 'delete' },
  webauthn_credentials: { scope: 'person', where: 'person_id = ?', withhold: ['public_key', 'x', 'y'], onDelete: 'delete' },
  webauthn_challenges: { scope: 'person', where: 'person_id = ?', withhold: ['challenge'], onDelete: 'delete' },
  recovery_codes: { scope: 'person', where: 'person_id = ?', withhold: ['salt', 'code_hash'], onDelete: 'delete' },
  recovery_requests: { scope: 'person', where: 'person_id = ?', withhold: ['secret_hash'], onDelete: 'delete' },
  recovery_contacts: { scope: 'person', where: 'person_id = ? OR contact_id = ?', onDelete: 'delete' },
  contact_codes: { scope: 'person', where: 'person_id = ? OR contact_id = ?', withhold: ['salt', 'code_hash'], onDelete: 'delete' },
  contact_points: { scope: 'person', where: 'person_id = ?', onDelete: 'delete' },
  one_time_tokens: { scope: 'person', where: 'person_id = ?', withhold: ['token_hash', 'code_salt', 'code_hash'], onDelete: 'delete' },
  outbound_messages: { scope: 'person', where: 'person_id = ?', onDelete: 'delete' },
  scheduled_changes: { scope: 'person', where: 'person_id = ? OR workspace_id = ?', onDelete: 'delete' },
  security_events: { scope: 'person', where: 'person_id = ?', onDelete: 'keep', keep: LOG('A log of changes to who can act: kept a year at least') },
  memberships: { scope: 'person', where: 'person_id = ?', onDelete: 'delete' },
  audit: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: LOG('The audit record is append-only and holds addresses of requests: kept for the log period, then it can be removed only by a decision, not by this build') },
  // the books
  accounts: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Ledger accounts') },
  entries: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Ledger entries are append-only; their memos stay as written') },
  postings: { scope: 'person', where: via('entry_id', 'entries'), onDelete: 'keep', keep: FIN('Ledger postings are append-only') },
  balances: { scope: 'person', where: via('account_id', 'accounts'), onDelete: 'keep', keep: FIN('Balances derived from the postings') },
  holds: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Reservations on the books') },
  lots: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Tax lots') },
  realised: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Realised gains and losses') },
  receipts: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The hash-chained receipts of what was done') },
  chain_books: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Where the on-chain wallet\'s books have been read to') },
  chain_movements: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The on-chain wallet\'s movements as entered in the books') },
  chain_recon: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Append-only reconciliation with the wallet service') },
  chain_closings: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The owner-approved closing of a replaced chain\'s books: append-only') },
  recon_runs: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Reconciliation results') },
  // money moved and decided
  payees: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { name: `'[erased]'`, handle: `'[erased-' || id || ']'`, registered_name: 'NULL', name_check: 'NULL' }, note: 'The payee row stays for the payments that point to it; its name and address are overwritten' },
  bills: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { memo: `'[erased]'` } },
  // R13: other currencies and payments abroad (fx.ts, abroad.ts, fx-goals.ts)
  fx_fills: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Conversions as filled, with their rate, spread and fee: append-only') },
  xb_payments: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Payments abroad as sent on paper, with their route and value date') },
  xb_payees: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { name: `'[erased]'`, account: `'[erased-' || id || ']'`, bank: 'NULL' }, note: 'The payee row stays for the payments abroad that point to it; its name and account are overwritten' },
  fx_goals: { scope: 'person', where: OWN_WS, onDelete: 'delete' },
  actions: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Orders and payments, with what checked them') },
  runs: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Runs of the person\'s instructions') },
  pv_orders: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The paper venue\'s orders') },
  pv_fills: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The paper venue\'s fills') },
  pv_payments: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The paper rail\'s payments') },
  disputes: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { reason: `'[erased]'` } },
  approvals: { scope: 'person', where: 'user_id = ? OR approver_id = ?', onDelete: 'keep', keep: FIN('What the person signed, exactly as shown'), purge: { where: 'user_id = ?' } },
  approval_signatures: { scope: 'person', where: `person_id = ? OR ${via('approval_id', 'approvals')}`, onDelete: 'keep', keep: FIN('Signatures on approvals'), purge: { where: via('approval_id', 'approvals') } },
  prepared: { scope: 'person', where: 'person_id = ? OR workspace_id = ?', onDelete: 'keep', keep: FIN('Append-only record of work prepared for approval'), purge: { where: 'workspace_id = ?' } },
  // instructions
  programs: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { title: `'[erased]'`, state: `CASE WHEN state IN ('active', 'paused') THEN 'revoked' ELSE state END` }, note: 'Live instructions are revoked so that nothing runs for an erased account' },
  program_versions: { scope: 'person', where: via('program_id', 'programs'), onDelete: 'keep', keep: FIN('The signed terms of each instruction') },
  program_events: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('What happened to each instruction') },
  // earning
  earn_jobs: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { title: `'[erased]'`, client: `'[erased]'` } },
  earn_milestones: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { title: `'[erased]'` } },
  earn_disputes: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { reason: `'[erased]'` } },
  earn_terms: { scope: 'person', where: 'user_id = ? OR person_id = ?', onDelete: 'keep', keep: FIN('The terms each side proposed, append-only'), purge: { skip: 'the other side of the work keeps the same terms' } },
  // R13 E4: the work directory. A listing is the person's own text; a quote binds two households and may have become a job
  directory_listings: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { title: `'[erased]'`, detail: `'[erased]'` } },
  directory_quotes: { scope: 'person', where: 'user_id = ? OR client_id = ?', onDelete: 'scrub', scrub: { note: `'[erased]'` }, purge: { skip: 'a quote binds two households, and the other side keeps it' } },
  earn_terms_accepts: { scope: 'person', where: `person_id = ? OR ${via('terms_id', 'earn_terms')}`, onDelete: 'keep', keep: FIN('Who accepted which terms, append-only'), purge: { skip: 'the other side of the work keeps the same terms' } },
  earn_steps: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Append-only record of each step of paid work') },
  // asking
  ai_calls: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { question: `'[erased]'`, output_json: 'NULL', sent_json: 'NULL' } },
  // R13 (part (w)): each request to the Anthropic API with its model, tokens and cost; no words of the question or reply
  ai_attempts: { scope: 'person', where: 'user_id = ? OR person_id = ?', withhold: ['session_key'], onDelete: 'keep', keep: LOG('What each model request cost: the installation\'s spending limits are counted from these rows, so erasing them would let the same money be spent again'), purge: { skip: 'the installation\'s model spending is counted from these rows; removing them would let QED spend the same money twice' } },
  proposals: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { title: `'[erased]'`, rationale: `'[erased]'` } },
  adviser_reviews: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('A reviewer\'s decision on a proposal') },
  conversations: { scope: 'person', where: 'user_id = ? OR person_id = ?', onDelete: 'scrub', scrub: { title: `'[erased]'` }, purge: { where: 'user_id = ?' } },
  conversation_turns: { scope: 'person', where: `conversation_id IN (SELECT id FROM conversations WHERE user_id = ? OR person_id = ?)`, onDelete: 'scrub', scrub: { question: `'[erased]'`, answer: 'NULL', refusal: 'NULL', clarify_json: `'[]'` }, purge: { where: via('conversation_id', 'conversations') } },
  // telling the person
  events: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: LOG('The event stream, a log') },
  notices: { scope: 'person', where: OWN_WS, onDelete: 'delete' },
  notice_delivery: { scope: 'person', where: OWN_WS, onDelete: 'delete' },
  notify_prefs: { scope: 'person', where: 'user_id = ?', onDelete: 'delete' },
  digests: { scope: 'person', where: OWN_WS, onDelete: 'delete' },
  // this feature
  access_log: { scope: 'person', where: 'person_id = ?', onDelete: 'keep', keep: LOG('The log itself: its sealed details become unreadable when the key is destroyed'), note: 'Exported with the sealed details opened' },
  erasures: { scope: 'person', where: 'person_id = ?', onDelete: 'keep', keep: FIN('The record that the person was erased, and when') },
  purge_runs: { scope: 'person', where: 'person_id = ?', onDelete: 'keep', keep: FIN('The closing summary of records purged after their retention period: append-only, the proof of what was removed') },
  person_keys: { scope: 'secret', note: 'The person\'s key itself: never exported, destroyed on deletion' },
  // about nobody
  // Grow's ideas (R13): the idea's words are the person's own and are erased; the investigation and decision stay with the books
  ideas: { scope: 'person', where: OWN_WS, onDelete: 'scrub', scrub: { text: `'[erased]'`, title: `'[erased]'`, reason: 'NULL' } },
  idea_events: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The steps of an idea that led to an order or an instruction') },
  // Spend (R13): a person's review of a recurring payment is theirs; mandates and revocations are financial records
  subscription_reviews: { scope: 'person', where: OWN_WS, onDelete: 'delete' },
  // agent commerce (R13): what the person signed QED may buy, and each purchase with its receipt
  commerce_mandates: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('What the person signed QED may buy, append-only') },
  commerce_purchases: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Each purchase QED made or refused, with the quotes compared and the receipt') },
  paper_mandates: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The paper bank\'s mandates for instructions that pay bills') },
  dispute_pauses: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Each pause a reported problem put on QED\'s activity, when it began and when it was released') },
  channel_terms: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('The terms a channel at an institution was given for an instruction') },
  institution_setups: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('A workspace\'s set-up of an institution: the terms shown, the bank entitlements and the acknowledged disclosure') },
  revocations: { scope: 'person', where: OWN_WS, onDelete: 'keep', keep: FIN('Each revocation of an instruction') },
  revocation_channels: { scope: 'person', where: via('revocation_id', 'revocations'), onDelete: 'keep', keep: FIN('Where each revocation reached, and each answer') },
  // The institutional desk (R13): claims, cycles, quotes and model offers are financial records of the workspaces they concern
  netting_claims: { scope: 'person', where: 'creditor_ws = ? OR debtor_ws = ?', onDelete: 'keep', keep: FIN('What one workspace said another owes, and each side\'s agreement'), purge: { skip: "another workspace holds the same claim" } },
  netting_cycles: { scope: 'person', where: 'proposed_by_ws = ? OR id IN (SELECT cycle_id FROM netting_participants WHERE workspace_id = ?)', onDelete: 'keep', keep: FIN('The fixed terms of each netting cycle'), purge: { skip: "other workspaces agreed to the same cycle" } },
  netting_participants: { scope: 'person', where: 'workspace_id = ?', onDelete: 'keep', keep: FIN('Who agreed to each cycle, and the approval that signed each payment'), purge: { skip: "other workspaces agreed to the same cycle" } },
  rfqs: { scope: 'person', where: OWN_WS.replace('user_id', 'workspace_id'), onDelete: 'keep', keep: FIN('Each request for quotes and every answer'), purge: { skip: "the dealers' answers are other parties' records" } },
  model_portfolios: { scope: 'person', where: 'owner_ws = ?', onDelete: 'keep', keep: FIN('Each version of a model offered to clients, append-only'), purge: { skip: "clients' offers point to each version" } },
  model_offers: { scope: 'person', where: 'offered_by_ws = ? OR client_ws = ?', onDelete: 'keep', keep: FIN('Each offer of a model and what its client decided'), purge: { skip: "the other workspace holds the same offer" } },
  // Incidents (R13, RE6) concern the installation, not a person
  incidents: { scope: 'shared' }, incident_events: { scope: 'shared' },
  meta: { scope: 'shared' }, assets: { scope: 'shared' }, instruments: { scope: 'shared' }, quotes: { scope: 'shared' }, quote_history: { scope: 'shared' }, daily_values: { scope: 'shared' },
  snapshots: { scope: 'shared' }, provider_status: { scope: 'shared' }, clock_checks: { scope: 'shared' }, terms: { scope: 'shared' }, heartbeats: { scope: 'shared' }, downtime: { scope: 'shared' }, rate_limits: { scope: 'shared' },
}

/** Every table in the database file (SQLite's own excluded). */
export const liveTables = (db: Db): string[] => db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name)

const bindAll = (where: string, id: string): string[] => Array.from({ length: (where.match(/\?/g) ?? []).length }, () => id)
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? undefined : v)

/** What a business workspace holds that is not about anyone's sign-in, security or notices: the tables a member reads in it. */
const NOT_IN_A_WORKSPACE = new Set(['users', 'sessions', 'webauthn_credentials', 'webauthn_challenges', 'recovery_codes', 'recovery_requests', 'recovery_contacts', 'contact_codes', 'contact_points', 'one_time_tokens', 'outbound_messages', 'scheduled_changes', 'security_events', 'memberships', 'audit', 'access_log', 'erasures', 'purge_runs', 'person_keys', 'notify_prefs', 'notices', 'notice_delivery', 'digests', 'events'])
export interface WorkspaceExport { id: string; name: string; kind: string; role: string; members: { handle: string; name: string; role: string }[]; tables: Record<string, Record<string, unknown>[]> }
/**
 * The business workspaces the person belongs to (their own is the export's main part): each with their role, the members' names
 * and roles, and the workspace's records, in the tables whose rows are found by the workspace's id alone. Nothing of any
 * member's sign-in, recovery, contact points or notices; nothing of a workspace the person has left.
 */
function exportWorkspaces(db: Db, personId: string): WorkspaceExport[] {
  const out: WorkspaceExport[] = []
  for (const w of db.all<{ id: string; name: string; kind: string; role: string }>(`SELECT u.id, u.display_name name, u.kind, m.role FROM memberships m JOIN users u ON u.id = m.workspace_id WHERE m.person_id = ? AND m.removed_at IS NULL AND m.workspace_id <> ? ORDER BY u.created_at`, personId, personId)) {
    const tables: Record<string, Record<string, unknown>[]> = {}
    for (const t of liveTables(db)) {
      const rule = TABLES[t]
      if (!rule || rule.scope !== 'person' || NOT_IN_A_WORKSPACE.has(t)) continue
      const where = rule.purge && 'where' in rule.purge ? rule.purge.where : rule.where!
      if (/ OR /i.test(where) && !(rule.purge && 'where' in rule.purge)) continue
      let rows = db.all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE ${where}`, ...bindAll(where, w.id))
      if (!rows.length) continue
      if (rule.withhold?.length) rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !rule.withhold!.includes(k))))
      tables[t] = JSON.parse(JSON.stringify(rows, jsonSafe)) as Record<string, unknown>[]
    }
    const members = db.all<{ handle: string; name: string; role: string }>(`SELECT u.handle, u.display_name name, m.role FROM memberships m JOIN users u ON u.id = m.person_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at`, w.id)
    out.push({ ...w, members, tables })
  }
  return out
}

export interface PersonExport { format: 'qed-export/1'; exportedAt: number; personId: string; tables: Record<string, Record<string, unknown>[]>; workspaces: WorkspaceExport[]; counts: Record<string, number>; notIncluded: { table: string; why: string }[]; notes: string[] }
/** Everything QED holds that names the person, from every table that does, as plain JSON. Secrets are left out and listed. */
export function exportPerson(db: Db, personId: string, now: number): PersonExport {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', personId)) throw new AppError(404, 'not_found', 'No such person.')
  const tables: PersonExport['tables'] = {}, notIncluded: PersonExport['notIncluded'] = []
  for (const name of liveTables(db)) {
    const rule = TABLES[name]
    if (!rule) throw new Error(`table ${name} is not classified in server/records.ts TABLES`)
    if (rule.scope === 'shared') continue
    if (rule.scope === 'secret') { notIncluded.push({ table: name, why: rule.note ?? 'a secret' }); continue }
    let rows = db.all<Record<string, unknown>>(`SELECT * FROM ${name} WHERE ${rule.where}`, ...bindAll(rule.where!, personId))
    if (rule.withhold?.length) { notIncluded.push({ table: name, why: `columns ${rule.withhold.join(', ')} are secrets, not data to carry away` }); rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !rule.withhold!.includes(k)))) }
    if (name === 'access_log') rows = accessLog(db, personId, ACCESS_LOG_SHOWN_MS).map((a) => ({ ...a }))
    tables[name] = JSON.parse(JSON.stringify(rows, jsonSafe)) as Record<string, unknown>[]
  }
  const workspaces = exportWorkspaces(db, personId)
  return {
    format: 'qed-export/1', exportedAt: now, personId, tables, workspaces, counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), notIncluded,
    notes: ['Amounts are paise. Business workspaces you belong to are in "workspaces": the records you can read there, with your role. Another person\'s own workspace is not included, and no other member\'s sign-in details are in any workspace.', 'Market data, terms and service state name nobody and are not included.', 'This is a paper build: the balances and trades are simulated.'],
  }
}

// ------------------------------------------------------------------------------------------------ money in flight

/** Why money is in flight for this person right now: each reason in words. Empty means none. */
export function moneyInFlight(db: Db, personId: string): string[] {
  const out: string[] = []
  const n = (sql: string, ...p: string[]): number => db.get<{ n: number }>(sql, ...p)?.n ?? 0
  const a = n(`SELECT COUNT(*) n FROM actions WHERE user_id = ? AND state IN ('submitting', 'working')`, personId)
  if (a) out.push(`${a} order or payment is being carried out`)
  const o = n(`SELECT COUNT(*) n FROM pv_orders WHERE user_id = ? AND state IN ('new', 'accepted', 'funded')`, personId)
  if (o) out.push(`${o} order at a venue has not finished`)
  const p = n(`SELECT COUNT(*) n FROM pv_payments WHERE user_id = ? AND state IN ('pending', 'unknown')`, personId)
  if (p) out.push(`${p} payment has not settled`)
  const m = n(`SELECT COUNT(*) n FROM earn_milestones WHERE user_id = ? AND state IN ('funded', 'submitted', 'refund-asked', 'disputed')`, personId)
  if (m) out.push(`${m} paid-work milestone holds money that has not been released or returned`)
  // The on-chain wallet (test tokens on a local chain: valueless, but the books treat them as held): a job in the escrow, an
  // offer waiting to be funded, and any balance in the wallet's three holders. A deletion would leave them with no owner.
  const cj = n(`SELECT COUNT(*) n FROM earn_milestones WHERE user_id = ? AND state IN ('chain-funded', 'chain-offered')`, personId)
  if (cj) out.push(`${cj} on-chain job is in flight (funded in the escrow, or offered and waiting to be funded)`)
  // the wallet's holders, chosen in code here, not by a LIKE pattern: nothing in the server may select accounts by a pattern a chain account matches (server/test-tokens.test.ts)
  const held = db.all<{ code: string; t: string }>(`SELECT a.code code, b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND substr(a.code, 1, 6) = 'chain:' AND b.amount_text <> '0'`, personId).filter((r) => /^chain:(treasury|reserve|owner):/.test(r.code))
  if (held.length) out.push(`your on-chain wallet holds test tokens in ${held.length} of its accounts; move them out first`)
  if (db.get(`SELECT 1 FROM chain_books WHERE user_id = ? AND backfill = 'needed'`, personId) && db.get('SELECT 1 FROM meta WHERE key = ?', `vault.workspace:${personId}`)) out.push('your on-chain wallet\'s history has not been read into your books yet, so what it holds is not known')
  const b = n(`SELECT COUNT(*) n FROM bills WHERE user_id = ? AND state = 'paying'`, personId)
  if (b) out.push(`${b} bill is being paid`)
  const h = n('SELECT COUNT(*) n FROM holds WHERE user_id = ? AND released_at IS NULL', personId)
  if (h) out.push(`${h} reservation is held for something in progress`)
  for (const [code, what] of [['clear:pay', 'payments on their way'], ['clear:mf', 'fund purchases awaiting units'], ['recv:mf', 'fund redemptions on their way']] as const) {
    const t = db.get<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = ?`, personId, code)?.t
    if (t && t !== '0') out.push(`money is in ${what}`)
  }
  return out
}

// ------------------------------------------------------------------------------------------------ deletion

export interface DeletionState {
  pending: { id: string; requestedAt: number; effectiveAt: number } | null
  erased: { erasedAt: number; retainUntil: number } | null
}
export function deletionState(db: Db, personId: string): DeletionState {
  const p = db.get<{ id: string; requested_at: number; effective_at: number }>(`SELECT id, requested_at, effective_at FROM scheduled_changes WHERE person_id = ? AND kind = 'delete-account' AND cancelled_at IS NULL AND applied_at IS NULL`, personId)
  const e = db.get<{ erased_at: number; retain_until: number }>('SELECT erased_at, retain_until FROM erasures WHERE person_id = ?', personId)
  return { pending: p ? { id: p.id, requestedAt: p.requested_at, effectiveAt: p.effective_at } : null, erased: e ? { erasedAt: e.erased_at, retainUntil: e.retain_until } : null }
}

/** Ask for the account to be deleted after the delay. The caller has already required a fresh passkey confirmation. */
export function requestDeletion(db: Db, personId: string, confirm: unknown, now: number): { id: string; effectiveAt: number } {
  if (confirm !== 'delete my account') throw new AppError(400, 'confirm_needed', 'Type "delete my account" to confirm.')
  if (deletionState(db, personId).pending) throw new AppError(409, 'already_scheduled', 'Deleting this account is already scheduled.')
  const flight = moneyInFlight(db, personId)
  if (flight.length) throw new AppError(409, 'money_in_flight', `Not while money is in flight: ${flight.join('; ')}. Try again when it has settled.`)
  const id = newId('chg', now), effectiveAt = now + DELETION_DELAY_MS
  db.tx(() => {
    db.run(`INSERT INTO scheduled_changes (id, person_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, 'delete-account', ?, ?, ?, NULL, ?)`, id, personId, personId, j({ delayMs: DELETION_DELAY_MS }), now, effectiveAt)
    db.run(`INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, 'deletion-requested', ?)`, personId, now, j({ effectiveAt }))
    audit(db, now, personId, 'owner', 'account.deletion-requested', id, { effectiveAt })
  })
  logAccess(db, personId, 'deletion-requested', {}, now)
  return { id, effectiveAt }
}
export function cancelDeletion(db: Db, personId: string, now: number): void {
  const p = deletionState(db, personId).pending
  if (!p) throw new AppError(404, 'not_found', 'No deletion is scheduled.')
  db.tx(() => {
    db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'owner' WHERE id = ?`, now, p.id)
    db.run(`INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, 'deletion-cancelled', '{}')`, personId, now)
    audit(db, now, personId, 'owner', 'account.deletion-cancelled', p.id, {})
  })
  logAccess(db, personId, 'deletion-cancelled', {}, now)
}

/** The order the delete-tables are cleared in, children before the rows they point to. */
const DELETE_ORDER = ['outbound_messages', 'one_time_tokens', 'contact_codes', 'recovery_requests', 'recovery_contacts', 'recovery_codes', 'contact_points', 'sessions', 'webauthn_challenges', 'webauthn_credentials', 'memberships', 'notice_delivery', 'notices', 'notify_prefs', 'digests', 'scheduled_changes']

/** Erase now, in one transaction. Returns what was done, by table. */
export function eraseAccount(db: Db, personId: string, requestedAt: number, now: number): Record<string, number> {
  const counts: Record<string, number> = {}
  db.tx(() => {
    const name = (t: string): Rule => TABLES[t]!
    for (const t of DELETE_ORDER) {
      const rule = name(t)
      if (t === 'scheduled_changes') { counts[t] = db.run(`DELETE FROM scheduled_changes WHERE (${rule.where}) AND NOT (kind = 'delete-account')`, ...bindAll(rule.where!, personId)).changes; continue }
      counts[t] = db.run(`DELETE FROM ${t} WHERE ${rule.where}`, ...bindAll(rule.where!, personId)).changes
    }
    for (const [t, rule] of Object.entries(TABLES)) {
      if (rule.onDelete !== 'scrub' || !rule.scrub) continue
      const set = Object.entries(rule.scrub).map(([c, v]) => `${c} = ${v}`).join(', ')
      counts[t] = db.run(`UPDATE ${t} SET ${set} WHERE ${rule.where}`, ...bindAll(rule.where!, personId)).changes
    }
    destroyKey(db, personId, now)
    // a person who is gone cannot sign in: the password is '!' and no credential is left; nothing may run for them
    db.run('UPDATE users SET stop_at = COALESCE(stop_at, ?), stop_reason = ? WHERE id = ?', now, 'Account deleted', personId)
    const retainUntil = new Date(now).setUTCFullYear(new Date(now).getUTCFullYear() + RETENTION.financialYears)
    db.run('INSERT INTO erasures (person_id, requested_at, erased_at, retain_until, schedule_json, counts_json) VALUES (?, ?, ?, ?, ?, ?)', personId, requestedAt, now, retainUntil, j(retentionSchedule()), j(counts))
    db.run(`UPDATE scheduled_changes SET applied_at = ? WHERE person_id = ? AND kind = 'delete-account' AND applied_at IS NULL`, now, personId)
    audit(db, now, personId, 'system', 'account.erased', personId, { counts })
  })
  return counts
}

/** Apply every deletion whose delay has ended; refuse (and cancel, with a security event) one that finds money in flight. */
export function applyDueDeletions(db: Db, now: number): number {
  let n = 0
  for (const c of db.all<{ id: string; person_id: string; requested_at: number }>(`SELECT id, person_id, requested_at FROM scheduled_changes WHERE kind = 'delete-account' AND cancelled_at IS NULL AND applied_at IS NULL AND effective_at <= ?`, now)) {
    const flight = moneyInFlight(db, c.person_id)
    if (flight.length) {
      db.tx(() => {
        db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'money-in-flight' WHERE id = ?`, now, c.id)
        db.run(`INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, 'deletion-refused', ?)`, c.person_id, now, j({ why: flight }))
      })
      continue
    }
    eraseAccount(db, c.person_id, c.requested_at, now); n++
  }
  return n
}

export interface ScheduleRow { table: string; what: 'deleted' | 'overwritten' | 'kept'; detail: string; period: string | null }
/** What deletion does to each table that names a person: the schedule shown to the person and stored with the erasure. */
export function retentionSchedule(): ScheduleRow[] {
  return Object.entries(TABLES).filter(([, r]) => r.scope === 'person' || r.scope === 'secret').map(([table, r]): ScheduleRow => {
    if (r.scope === 'secret') return { table, what: 'deleted', detail: 'The key is overwritten and cleared', period: null }
    if (r.onDelete === 'delete') return { table, what: 'deleted', detail: r.note ?? '', period: null }
    if (r.onDelete === 'scrub') return { table, what: 'overwritten', detail: `${Object.keys(r.scrub!).join(', ')}${r.note ? `. ${r.note}` : ''}`, period: `row kept ${RETENTION.financialYears} years` }
    return { table, what: 'kept', detail: r.keep!.why, period: r.keep!.period === 'financial' ? `${RETENTION.financialYears} years from deletion` : `${RETENTION.logDays} days at least` }
  })
}

export function dataRightsView(db: Db, personId: string, now: number): unknown {
  return {
    now, delayMs: DELETION_DELAY_MS, deletion: deletionState(db, personId), inFlight: moneyInFlight(db, personId),
    schedule: retentionSchedule(), retention: RETENTION, accessLog: accessLog(db, personId, now), accessLogDays: RETENTION.logDays,
    export: { format: 'qed-export/1', tables: liveTables(db).filter((t) => TABLES[t]?.scope === 'person').length },
  }
}

// ------------------------------------------------------------------------------------------------ the purge

/** Tables the purge never touches: the pseudonymous user row the rest point to, the proofs of erasure and purge, and the logs. */
const NEVER_PURGED = new Set(['users', 'erasures', 'purge_runs'])
/** The handles of the people who may approve a purge: QED_PURGE_APPROVERS, comma separated. Empty means nobody: a purge cannot run. */
export const purgeApprovers = (): string[] => (process.env.QED_PURGE_APPROVERS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)

interface PurgeTable { table: string; where: string; rows: number }
/** The tables of the person's financial records that a purge removes, with the SQL that finds each one's rows, and those it leaves. */
function purgePlan(db: Db, personId: string): { tables: PurgeTable[]; left: { table: string; why: string }[] } {
  const tables: PurgeTable[] = [], left: { table: string; why: string }[] = []
  for (const t of liveTables(db)) {
    const rule = TABLES[t]
    if (!rule || rule.scope !== 'person' || NEVER_PURGED.has(t) || rule.onDelete === 'delete') continue
    const financial = rule.onDelete === 'scrub' || rule.keep?.period === 'financial'
    if (!financial) { left.push({ table: t, why: `a log, kept at least ${RETENTION.logDays} days and removed only by a separate decision` }); continue }
    if (rule.purge && 'skip' in rule.purge) { left.push({ table: t, why: rule.purge.skip }); continue }
    const where = rule.purge && 'where' in rule.purge ? rule.purge.where : rule.where!
    if (/ OR /i.test(where)) throw new Error(`table ${t} has a where clause with OR and no purge rule in server/records.ts TABLES`)
    const rows = db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`, ...bindAll(where, personId))?.n ?? 0
    tables.push({ table: t, where, rows })
  }
  return { tables, left }
}
const sha = (x: string): string => createHash('sha256').update(x).digest('hex')
const rowsDigest = (db: Db, t: PurgeTable, personId: string): string => sha(JSON.stringify(db.all(`SELECT * FROM ${t.table} WHERE ${t.where} ORDER BY rowid`, ...bindAll(t.where, personId)), jsonSafe))

export interface PurgeCandidate { personId: string; erasedAt: number; retainUntil: number; rows: number; tables: { table: string; rows: number }[]; left: { table: string; why: string }[]; ledgerOk: boolean; receiptsOk: boolean; previewDigest: string }
/** Erased people whose retention period has ended and whose records have not been purged: what a run would remove, nothing changed. */
export function purgeCandidates(db: Db, now: number): PurgeCandidate[] {
  return db.all<{ person_id: string; erased_at: number; retain_until: number }>(`SELECT person_id, erased_at, retain_until FROM erasures e WHERE retain_until <= ? AND NOT EXISTS (SELECT 1 FROM purge_runs p WHERE p.person_id = e.person_id) ORDER BY retain_until, person_id`, now).map((e) => {
    const plan = purgePlan(db, e.person_id)
    const tables = plan.tables.filter((t) => t.rows > 0).map((t) => ({ table: t.table, rows: t.rows }))
    const ledgerOk = verifyLedger(db, e.person_id).length === 0, receiptsOk = verifyChain(db, e.person_id).ok
    return { personId: e.person_id, erasedAt: e.erased_at, retainUntil: e.retain_until, rows: tables.reduce((n, t) => n + t.rows, 0), tables, left: plan.left, ledgerOk, receiptsOk, previewDigest: sha(j({ person: e.person_id, retainUntil: e.retain_until, tables })) }
  })
}

export interface PurgeResult { personId: string; runId: string; removed: Record<string, number>; digest: string }
/**
 * Remove one erased person's financial records after their retention period, as the closing summary says. The caller has
 * already required a fresh passkey confirmation of `approver` (api.ts requireStepUp). Refused unless the approver is named in
 * QED_PURGE_APPROVERS, the person is erased and past retain_until, nothing was purged for them before, the preview the approver
 * saw is still what would be removed, and the person's ledger and receipt chain verify. One transaction: all of it or none.
 *
 * The append-only triggers on the removed tables are dropped and put back, in that transaction, from the SQL SQLite holds for
 * them: if anything fails the transaction rolls back and they were never gone. Rows other records still point at make the
 * commit fail on the foreign key and nothing is removed.
 */
export function runPurge(db: Db, approverId: string, personId: string, previewDigest: unknown, now: number): PurgeResult {
  const approver = db.get<{ handle: string }>(`SELECT handle FROM users u WHERE id = ? AND kind = 'person' AND NOT EXISTS (SELECT 1 FROM erasures e WHERE e.person_id = u.id)`, approverId)
  if (!approver || !purgeApprovers().includes(approver.handle.toLowerCase())) throw new AppError(403, 'not_permitted', 'Only a person named by the installation as a purge approver may approve a purge.')
  const e = db.get<{ erased_at: number; retain_until: number }>('SELECT erased_at, retain_until FROM erasures WHERE person_id = ?', personId)
  if (!e) throw new AppError(404, 'not_found', 'That person has not been erased.')
  if (e.retain_until > now) throw new AppError(409, 'retention_not_ended', `Their records are kept until ${new Date(e.retain_until).toISOString().slice(0, 10)}.`)
  if (db.get('SELECT 1 FROM purge_runs WHERE person_id = ?', personId)) throw new AppError(409, 'already_purged', 'Their records were purged already.')
  const cand = purgeCandidates(db, now).find((c) => c.personId === personId)
  if (!cand || cand.previewDigest !== previewDigest) throw new AppError(409, 'preview_changed', 'What would be removed is not what you were shown. Look at the preview again.')
  if (!cand.ledgerOk) throw new AppError(409, 'ledger_broken', 'Their ledger does not verify, so it is not purged. Find out why first.')
  if (!cand.receiptsOk) throw new AppError(409, 'receipts_broken', 'Their receipt chain does not verify, so it is not purged. Find out why first.')
  const plan = purgePlan(db, personId).tables
  const runId = newId('prg', now)
  return db.tx(() => {
    // the closing summary, taken before anything is removed
    const chain = verifyChain(db, personId)
    const closing = db.all<{ code: string; asset: string; amount_text: string }>(`SELECT a.code, a.asset_id asset, b.amount_text FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND b.amount_text <> '0' ORDER BY a.code`, personId)
    const ledger = { entries: db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', personId)!.n, postings: db.get<{ n: number }>(`SELECT COUNT(*) n FROM postings WHERE ${via('entry_id', 'entries')}`, personId)!.n, first: db.get<{ t: number | null }>('SELECT MIN(ts) t FROM entries WHERE user_id = ?', personId)?.t ?? null, last: db.get<{ t: number | null }>('SELECT MAX(ts) t FROM entries WHERE user_id = ?', personId)?.t ?? null, closingBalances: closing }
    const perTable = plan.filter((t) => t.rows > 0).map((t) => ({ table: t.table, rows: t.rows, sha256: rowsDigest(db, t, personId) }))
    const digest = sha(j(perTable))
    const removed: Record<string, number> = {}
    const triggers = db.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${plan.map(() => '?').join(', ')}) AND sql IS NOT NULL`, ...plan.map((t) => t.table))
    db.exec('PRAGMA defer_foreign_keys = ON')
    for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`)
    // children first: a table found through a parent's rows (postings through entries) is cleared before the parent is
    for (const t of [...plan].sort((a, b) => Number(/SELECT/.test(b.where)) - Number(/SELECT/.test(a.where)))) if (t.rows > 0) removed[t.table] = db.run(`DELETE FROM ${t.table} WHERE ${t.where}`, ...bindAll(t.where, personId)).changes
    for (const t of triggers) db.exec(t.sql)
    const summary = { person: personId, erasedAt: e.erased_at, retainUntil: e.retain_until, ledger, receipts: { count: chain.count, head: chain.head }, tables: perTable, left: purgePlan(db, personId).left, note: 'Rows were removed from this database. Copies of it made earlier keep what they held until their keys are destroyed (server/sealed-expiry.ts); QED does not claim physical erasure.' }
    db.run('INSERT INTO purge_runs (id, person_id, approved_by, approved_at, approval_method, retain_until, summary_json, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', runId, personId, approverId, now, 'passkey', e.retain_until, j(summary), digest)
    audit(db, now, approverId, 'owner', 'records.purged', personId, { runId, digest, removed })
    return { personId, runId, removed, digest }
  })
}
