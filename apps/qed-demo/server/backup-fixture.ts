/**
 * A realistic database for the backup tests and the restore drill, built in an isolated folder with the application's
 * own code: households opened by openHousehold, entries posted through the ledger (salary in, spending out), a receipt
 * on each household's hash chain per entry, and the identity, recovery, payee, conversation and audit rows the inventory
 * in docs/ENCRYPTION.md calls sensitive. No network, a fixed clock, paper money; never the review database.
 * Sensitive values carry markers, so a test can search any output (logs, temporary files, manifests) for plaintext.
 */
import { createHash, randomBytes } from 'node:crypto'
import { openDb, type Db } from './core.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { post } from './ledger.ts'
import { issueReceipt } from './receipts.ts'
import { seedRegistry } from './registry.ts'

export const MARKERS = {
  displayName: 'Marker Household Sensitive Name',
  payeeName: 'Marker Payee Anjali Sensitive',
  payeeHandle: 'marker.payee.sensitive@paperupi',
  memo: 'MARKER-MEMO pharmacy for a sensitive condition',
  question: 'MARKER-QUESTION should I move my emergency fund into bitcoin',
  answer: 'MARKER-ANSWER keep six months of spending in the bank first',
  sentToModel: 'MARKER-SENT-TO-MODEL tokens for the snapshot',
  client: 'Marker Client Sensitive Pvt Ltd',
  ip: '203.0.113.77',
} as const
/** Every marker: none may appear in a log, a temporary file left behind, a manifest or a ciphertext. */
export const SENSITIVE: string[] = Object.values(MARKERS)

/** 2026-11-18 10:30 IST, the test kit's T0. */
export const FIXTURE_T0 = Date.parse('2026-11-18T05:00:00Z')

export interface FixtureOptions { households?: number; entries?: number; start?: number }
export interface Fixture { path: string; users: string[]; entries: number; receipts: number }

const hex = (n: number): string => randomBytes(n).toString('hex')
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function household(db: Db, i: number, entries: number, t0: number): number {
  const id = `usr_fx${i}`
  const at = t0 + i * 1000
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, `household${i}`, `${MARKERS.displayName} ${i}`, `scrypt$16384$8$1$${hex(16)}$${hex(32)}`, at)
  openHousehold(db, id, DEFAULT_OPENING, { income: 18_000_000 }, at)
  db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, 'fixture')`, id, id, at)
  // A passkey (its P-256 public key also controls the on-chain account), a session, recovery codes (hashed) and a contact.
  db.run(`INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, 0, '["internal"]', 'multiDevice', 1, 'MacBook passkey', ?)`, `cred_fx${i}`, id, randomBytes(77), hex(32), hex(32), at)
  db.run('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, csrf, ua, auth_method, credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', sha(hex(32)), id, at, at, at + 86_400_000, hex(16), 'Mozilla/5.0 (Macintosh) fixture', 'passkey', `cred_fx${i}`)
  const salt = hex(16)
  for (let c = 0; c < 10; c++) db.run(`INSERT INTO recovery_codes (id, person_id, salt, code_hash, created_at, algo) VALUES (?, ?, ?, ?, ?, 'scrypt')`, `rcv_fx${i}_${c}`, id, salt, hex(32), at)
  db.run(`INSERT INTO audit (ts, user_id, actor, action, subject, detail_json, ip) VALUES (?, ?, 'owner', 'signin', ?, '{}', ?)`, at, id, id, MARKERS.ip)
  // A payee and a bill; a job for a client.
  db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `pay_fx${i}`, id, MARKERS.payeeName, `${i}.${MARKERS.payeeHandle}`, 'family', at, at)
  db.run(`INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, 250000, ?, ?, 'due', ?)`, `bil_fx${i}`, id, `pay_fx${i}`, at + 7 * 86_400_000, MARKERS.memo, at)
  db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at) VALUES (?, ?, 'Translation', ?, 'open', ?)`, `job_fx${i}`, id, MARKERS.client, at)
  // Ask as a conversation: the owner's words, what was sent to the model, and the answer shown.
  db.run('INSERT INTO conversations (id, user_id, person_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `cnv_fx${i}`, id, id, 'Emergency fund', at, at)
  db.run(`INSERT INTO ai_calls (id, user_id, ts, provider, model, question, context_hash, output_json, ok, latency_ms, conversation_id, sent_json) VALUES (?, ?, ?, 'scripted', 'fixture', ?, ?, ?, 1, 900, ?, ?)`, `aic_fx${i}`, id, at, MARKERS.question, sha('ctx'), JSON.stringify({ answer: MARKERS.answer }), `cnv_fx${i}`, JSON.stringify({ turns: [], question: MARKERS.sentToModel }))
  db.run(`INSERT INTO conversation_turns (id, conversation_id, ts, question, kind, ai_call_id, answer) VALUES (?, ?, ?, ?, 'model', ?, ?)`, `trn_fx${i}`, `cnv_fx${i}`, at, MARKERS.question, `aic_fx${i}`, MARKERS.answer)
  // The books: a salary every 30th entry, spending otherwise; one receipt per entry on the hash chain.
  for (let k = 1; k <= entries; k++) {
    const ts = at + k * 60_000
    const salary = k % 30 === 1
    const amount = salary ? 18_000_000n : BigInt(10_000 + ((k * 7919) % 40_000))
    const ref = `fx-${i}-${k}`
    post(db, { userId: id, ts, kind: salary ? 'income' : 'spend', ref, memo: k % 50 === 2 ? MARKERS.memo : salary ? 'Salary (paper)' : 'Spending (paper)', lines: salary ? [{ account: 'bank', amount }, { account: 'inc:salary', amount: -amount }] : [{ account: 'exp:spend', amount }, { account: 'bank', amount: -amount }] })
    issueReceipt(db, id, salary ? 'income' : 'payment', ref, { amount: Number(amount), payee: salary ? 'Employer' : MARKERS.payeeName, memo: 'paper' }, ts)
  }
  return entries
}

/** Build the fixture database at path (which must not exist yet). */
export function buildFixture(path: string, o: FixtureOptions = {}): Fixture {
  const n = o.households ?? 2, entries = o.entries ?? 12, t0 = o.start ?? FIXTURE_T0
  const db = openDb(path)
  try {
    seedRegistry(db)
    const users: string[] = []
    let total = 0
    // One transaction per household: the nested ledger and receipt transactions join it through savepoints.
    for (let i = 0; i < n; i++) { total += db.tx(() => household(db, i, entries, t0)); users.push(`usr_fx${i}`) }
    // Each household names the next as its recovery contact (who trusts whom is itself sensitive).
    for (let i = 0; i < n && n > 1; i++) db.run('INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?)', `rct_fx${i}`, `usr_fx${i}`, `usr_fx${(i + 1) % n}`, t0, t0, t0)
    return { path, users, entries: total, receipts: total }
  } finally { db.close() }
}

/** One more entry and receipt in a household, as if the service kept running after a backup (data a restore will lack). */
export function lateWrite(db: Db, userId: string, at: number, ref: string): void {
  db.tx(() => {
    post(db, { userId, ts: at, kind: 'spend', ref, memo: 'Spending after the backup (paper)', lines: [{ account: 'exp:spend', amount: 12_345n }, { account: 'bank', amount: -12_345n }] })
    issueReceipt(db, userId, 'payment', ref, { amount: 12_345, memo: 'paper' }, at)
  })
}
