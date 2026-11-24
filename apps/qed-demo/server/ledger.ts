/**
 * Double-entry ledger. Every entry balances to zero in each asset it touches; entries and postings are append-only
 * (enforced by database triggers); every entry carries an idempotency reference, so posting the same economic event
 * twice changes nothing. Balances are a cache maintained in the same transaction and re-derived by verifyLedger.
 *
 * Amounts (since schema v6, stage S3 of the global money model, ADR-0012) are bigints from end to end. Each is read from
 * and written to amount_text, canonical integer text (shared/amount-text.ts); the INTEGER amount beside it is written as a
 * copy (NULL past 64 bits) and never read here. SQL sums go through amount_sum (server/amount-sql.ts). No JavaScript number
 * carries an amount in this file, so an 18-decimal token is booked exactly above 2^53 and above 2^63.
 */
import { fromAmountText, int64OrNull, numberOrNull, toAmountText } from '../shared/amount-text.ts'
import { AppError, type Db, j, newId, parse } from './core.ts'
import { assetInstrumentId } from './registry.ts'

export type AccountKind = 'asset' | 'liability' | 'income' | 'expense' | 'equity' | 'clearing' | 'trading'

/** instrument_id (schema v5): the asset's canonical instrument id, written beside asset_id; readers still use asset_id. */
export interface Account { id: string; user_id: string; code: string; kind: AccountKind; asset_id: string; name: string; nonneg: number; meta_json: string; instrument_id: string | null }
export interface Line { account: string; amount: bigint }
export interface EntryInput {
  userId: string
  ts: number
  effectiveTs?: number
  kind: string
  ref: string
  memo: string
  meta?: unknown
  lines: Line[]
  /** Holds released in the same transaction, before the non-negative check (the entry spends what they reserved). */
  releaseHolds?: string[]
  /** Holds reduced by an amount in the same transaction, before the non-negative check. */
  consumeHolds?: { ref: string; amount: bigint }[]
}

const DEBIT_NORMAL: Record<AccountKind, boolean> = { asset: true, expense: true, clearing: true, trading: true, liability: false, income: false, equity: false }

export class InsufficientFunds extends AppError {
  constructor(what: string) { super(409, 'insufficient_funds', what) }
}

export function ensureAccount(db: Db, userId: string, code: string, kind: AccountKind, assetId: string, name: string, nonneg = false, meta: unknown = {}): Account {
  const have = db.get<Account>('SELECT * FROM accounts WHERE user_id = ? AND code = ?', userId, code)
  if (have) {
    if (have.asset_id !== assetId || have.kind !== kind) throw new Error(`account ${code} exists with a different asset or kind`)
    return have
  }
  // Both ids of the asset are written (ADR-0012, stage S2). An asset the registry gives no canonical id is not booked.
  const instrumentId = assetInstrumentId(assetId)
  if (instrumentId === null) throw new Error(`asset ${assetId} has no canonical instrument id, so no account is opened in it`)
  const id = newId('acc')
  db.run('INSERT INTO accounts (id, user_id, code, kind, asset_id, instrument_id, name, nonneg, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, userId, code, kind, assetId, instrumentId, name, nonneg ? 1 : 0, j(meta))
  db.run(`INSERT INTO balances (account_id, amount, amount_text) VALUES (?, 0, '0')`, id)
  return db.get<Account>('SELECT * FROM accounts WHERE id = ?', id)!
}

export function account(db: Db, userId: string, code: string): Account | undefined {
  return db.get<Account>('SELECT * FROM accounts WHERE user_id = ? AND code = ?', userId, code)
}

/** The stored balance of one account, by its id (positive means a net debit). A missing row is a broken book, not zero. */
function storedBalance(db: Db, accountId: string, code: string): bigint {
  return fromAmountText(db.get<{ t: string }>('SELECT amount_text t FROM balances WHERE account_id = ?', accountId)?.t, `the balance of ${code}`)
}

/** What is reserved and not yet released in one account, by its id. */
function reservedIn(db: Db, accountId: string, code: string): bigint {
  return fromAmountText(db.get<{ s: string }>('SELECT amount_sum(amount_text) s FROM holds WHERE account_id = ? AND released_at IS NULL', accountId)?.s, `what is reserved in ${code}`)
}

/** Signed balance as stored: positive means a net debit. */
export function rawBalance(db: Db, userId: string, code: string): bigint {
  const a = account(db, userId, code)
  return a ? storedBalance(db, a.id, code) : 0n
}

/** Balance in the account's natural direction: what you hold (assets) or what you owe (liabilities). */
export function balance(db: Db, userId: string, code: string): bigint {
  const a = account(db, userId, code)
  if (!a) return 0n
  const raw = storedBalance(db, a.id, code)
  return DEBIT_NORMAL[a.kind] ? raw : -raw
}

export function heldAmount(db: Db, userId: string, code: string): bigint {
  const a = account(db, userId, code)
  return a ? reservedIn(db, a.id, code) : 0n
}

export const available = (db: Db, userId: string, code: string): bigint => balance(db, userId, code) - heldAmount(db, userId, code)

/** Reserve part of an asset balance for something in flight. Idempotent on ref. */
export function placeHold(db: Db, userId: string, code: string, amount: bigint, reason: string, ref: string, now: number): string {
  return db.tx(() => {
    const have = db.get<{ id: string }>('SELECT id FROM holds WHERE user_id = ? AND ref = ?', userId, ref)
    if (have) return have.id
    const a = account(db, userId, code)
    if (!a) throw new InsufficientFunds(`No ${code} account.`)
    if (amount <= 0n) throw new AppError(400, 'invalid', 'A hold must be positive.')
    if (available(db, userId, code) < amount) throw new InsufficientFunds(`Not enough available in ${a.name}.`)
    const id = newId('hold', now)
    db.run('INSERT INTO holds (id, user_id, account_id, amount, amount_text, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, userId, a.id, int64OrNull(amount), toAmountText(amount), reason, ref, now)
    return id
  })
}

export function releaseHold(db: Db, userId: string, ref: string, now: number): boolean {
  return db.run('UPDATE holds SET released_at = ? WHERE user_id = ? AND ref = ? AND released_at IS NULL', now, userId, ref).changes > 0
}

/** Use up part of a hold as the thing it reserved actually happens. The hold is released when nothing is left. */
export function consumeHold(db: Db, userId: string, ref: string, amount: bigint, now: number): void {
  // Read and write in one transaction (a savepoint inside post's): the remainder is computed here, not by SQL arithmetic.
  db.tx(() => {
    const h = db.get<{ id: string; t: string }>('SELECT id, amount_text t FROM holds WHERE user_id = ? AND ref = ? AND released_at IS NULL', userId, ref)
    if (!h || amount <= 0n) return
    const held = fromAmountText(h.t, `the reservation ${ref}`)
    if (amount >= held) db.run('UPDATE holds SET released_at = ? WHERE id = ?', now, h.id)
    else db.run('UPDATE holds SET amount = ?, amount_text = ? WHERE id = ?', int64OrNull(held - amount), toAmountText(held - amount), h.id)
  })
}

/** Post one entry. Returns the existing entry when the reference was already posted (duplicate: true). */
export function post(db: Db, e: EntryInput): { id: string; duplicate: boolean; seq: number } {
  return db.tx(() => {
    const dup = db.get<{ id: string; seq: number }>('SELECT id, seq FROM entries WHERE user_id = ? AND ref = ?', e.userId, e.ref)
    if (dup) return { id: dup.id, duplicate: true, seq: dup.seq }
    if (e.lines.length < 2) throw new Error(`entry ${e.ref}: needs at least two lines`)

    const sums = new Map<string, bigint>()
    const resolved: { acc: Account; amount: bigint }[] = []
    for (const l of e.lines) {
      if (l.amount === 0n) continue
      const acc = account(db, e.userId, l.account)
      if (!acc) throw new Error(`entry ${e.ref}: unknown account ${l.account}`)
      sums.set(acc.asset_id, (sums.get(acc.asset_id) ?? 0n) + l.amount)
      resolved.push({ acc, amount: l.amount })
    }
    if (resolved.length < 2) throw new Error(`entry ${e.ref}: nothing to post`)
    for (const [asset, s] of sums) if (s !== 0n) throw new Error(`entry ${e.ref}: does not balance in ${asset} (off by ${s})`)

    for (const ref of e.releaseHolds ?? []) releaseHold(db, e.userId, ref, e.ts)
    for (const c of e.consumeHolds ?? []) consumeHold(db, e.userId, c.ref, c.amount, e.ts)

    const seq = (db.get<{ m: number | null }>('SELECT MAX(seq) m FROM entries WHERE user_id = ?', e.userId)?.m ?? 0) + 1
    const id = newId('ent', e.ts)
    db.run('INSERT INTO entries (id, user_id, seq, ts, effective_ts, kind, ref, memo, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, e.userId, seq, e.ts, e.effectiveTs ?? e.ts, e.kind, e.ref, e.memo, j(e.meta ?? {}))
    const touched = new Map<string, Account>()
    for (const r of resolved) {
      db.run('INSERT INTO postings (entry_id, account_id, asset_id, instrument_id, amount, amount_text) VALUES (?, ?, ?, ?, ?, ?)',
        id, r.acc.id, r.acc.asset_id, r.acc.instrument_id, int64OrNull(r.amount), toAmountText(r.amount))
      // The new balance is computed here in bigint and written as text and copy, in this transaction (BEGIN IMMEDIATE).
      const next = storedBalance(db, r.acc.id, r.acc.code) + r.amount
      db.run('UPDATE balances SET amount = ?, amount_text = ? WHERE account_id = ?', int64OrNull(next), toAmountText(next), r.acc.id)
      touched.set(r.acc.id, r.acc)
    }
    for (const acc of touched.values()) {
      if (!acc.nonneg) continue
      const raw = storedBalance(db, acc.id, acc.code)
      const natural = DEBIT_NORMAL[acc.kind] ? raw : -raw
      if (natural < 0n) throw new InsufficientFunds(`${acc.name} would go below zero.`)
      if (acc.kind === 'asset' && natural < reservedIn(db, acc.id, acc.code)) throw new InsufficientFunds(`${acc.name} would go below what is reserved for payments and orders in progress.`)
    }
    return { id, duplicate: false, seq }
  })
}

// ------------------------------------------------------------------------------------------------ tax lots
// lots and realised keep INTEGER columns (64 bits): values are bound and read as bigints, exact up to 2^63 - 1, and a larger
// one is refused by the driver ("BigInt value is too large to bind") rather than rounded. Their instrument_id is a market
// line ('coindcx:BTCINR'), not a canonical instrument id (schema.sql; D-110).

const lotInt = (v: unknown, what: string): bigint => fromAmountText(v, what)

export function openLot(db: Db, userId: string, instrumentId: string, qty: bigint, cost: bigint, ts: number, entryId: string): void {
  db.run('INSERT INTO lots (id, user_id, instrument_id, opened_at, qty, remaining, cost, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId('lot', ts), userId, instrumentId, ts, qty, qty, cost, entryId)
}

/** Consume open lots first in, first out. Returns the cost of what was sold. Proceeds are split pro rata by quantity. */
export function consumeLots(db: Db, userId: string, instrumentId: string, qty: bigint, proceeds: bigint, ts: number, entryId: string): bigint {
  let left = qty
  let costOut = 0n
  let proceedsLeft = proceeds
  const lots = db.all<{ id: string; opened_at: number; qty: string; remaining: string; cost: string }>(
    'SELECT id, opened_at, CAST(qty AS TEXT) qty, CAST(remaining AS TEXT) remaining, CAST(cost AS TEXT) cost FROM lots WHERE user_id = ? AND instrument_id = ? AND remaining > 0 ORDER BY opened_at, id', userId, instrumentId)
  for (const lot of lots) {
    if (left <= 0n) break
    const rem = lotInt(lot.remaining, `lot ${lot.id}`), lotQty = lotInt(lot.qty, `lot ${lot.id}`), lotCost = lotInt(lot.cost, `lot ${lot.id}`)
    const take = rem < left ? rem : left
    // Cost of the part sold: proportional to the lot's original quantity; the last slice of a lot takes the remainder.
    const lotCostLeft = lotCost * rem / lotQty
    const cost = take === rem ? lotCostLeft : lotCost * take / lotQty
    const share = take === left ? proceedsLeft : proceeds * take / qty
    proceedsLeft -= share
    db.run('UPDATE lots SET remaining = remaining - ? WHERE id = ?', take, lot.id) // 64-bit integer arithmetic, exact: 0 <= take <= remaining
    db.run('INSERT INTO realised (user_id, instrument_id, ts, qty, proceeds, cost, opened_at, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      userId, instrumentId, ts, take, share, cost, lot.opened_at, entryId)
    costOut += cost
    left -= take
  }
  if (left > 0n) throw new Error(`lots for ${instrumentId} do not cover the quantity sold (short by ${left})`)
  return costOut
}

export function openCost(db: Db, userId: string, instrumentId: string): { qty: bigint; cost: bigint } {
  const rows = db.all<{ id: string; qty: string; remaining: string; cost: string }>('SELECT id, CAST(qty AS TEXT) qty, CAST(remaining AS TEXT) remaining, CAST(cost AS TEXT) cost FROM lots WHERE user_id = ? AND instrument_id = ? AND remaining > 0', userId, instrumentId)
  let qty = 0n, cost = 0n
  for (const r of rows) {
    const rem = lotInt(r.remaining, `lot ${r.id}`)
    qty += rem
    cost += lotInt(r.cost, `lot ${r.id}`) * rem / lotInt(r.qty, `lot ${r.id}`)
  }
  return { qty, cost }
}

// ------------------------------------------------------------------------------------------------ verification

export interface LedgerBreak { check: string; detail: string }

/**
 * Whether the books keep amounts as text (schema v6). verifyLedger also checks an older file read-only, as server/backup.ts
 * does to a restored backup taken before v6: there it reads the INTEGER column, as text, through the same sums.
 */
const keepsAmountText = (db: Db): boolean => !!db.get(`SELECT 1 x FROM pragma_table_info('postings') WHERE name = 'amount_text'`)

/** Re-derive every invariant from the postings. An empty list means the books are internally consistent. */
export function verifyLedger(db: Db, userId: string): LedgerBreak[] {
  const out: LedgerBreak[] = []
  const v6 = keepsAmountText(db)
  const amt = (alias: string): string => (v6 ? `${alias}.amount_text` : `CAST(${alias}.amount AS TEXT)`)

  // Every amount is canonical text and its INTEGER copy agrees with it. The database's CHECKs make this so unless they were
  // switched off (PRAGMA ignore_check_constraints); then the sums below cannot be trusted, so nothing else is checked.
  if (v6) {
    const rows = db.all<{ what: string; code: string; ref: string; t: unknown; c: string | null }>(
      `SELECT 'posting' what, a.code, CAST(p.id AS TEXT) ref, p.amount_text t, CAST(p.amount AS TEXT) c FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ?
       UNION ALL SELECT 'balance', a.code, a.code, b.amount_text, CAST(b.amount AS TEXT) FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ?
       UNION ALL SELECT 'reservation', a.code, h.ref, h.amount_text, CAST(h.amount AS TEXT) FROM holds h JOIN accounts a ON a.id = h.account_id WHERE a.user_id = ?`, userId, userId, userId)
    for (const r of rows) {
      const where = r.what === 'balance' ? `the balance of ${r.code}` : `${r.what} ${r.ref} in ${r.code}`
      let v: bigint
      try { v = fromAmountText(r.t, where) } catch (e) { out.push({ check: 'amount-text', detail: (e as Error).message }); continue }
      if (r.c !== (int64OrNull(v)?.toString() ?? null)) out.push({ check: 'amount-text', detail: `${where}: amount_text ${String(r.t)} but its 64-bit copy is ${r.c ?? 'NULL'}` })
    }
    if (out.length) return out
  }

  const unbalanced = db.all<{ entry_id: string; asset_id: string; s: string }>(
    `SELECT p.entry_id, p.asset_id, amount_sum(${amt('p')}) s FROM postings p JOIN entries e ON e.id = p.entry_id
     WHERE e.user_id = ? GROUP BY p.entry_id, p.asset_id HAVING amount_sum(${amt('p')}) != '0'`, userId)
  for (const u of unbalanced) out.push({ check: 'entry-balances', detail: `entry ${u.entry_id} is off by ${fromAmountText(u.s, `entry ${u.entry_id}`)} in ${u.asset_id}` })

  const cache = db.all<{ code: string; name: string; kind: AccountKind; nonneg: number; cached: string; derived: string; held: string }>(
    `SELECT a.code, a.name, a.kind, a.nonneg, ${amt('b')} cached,
            (SELECT amount_sum(${amt('p')}) FROM postings p WHERE p.account_id = a.id) derived,
            (SELECT amount_sum(${amt('h')}) FROM holds h WHERE h.account_id = a.id AND h.released_at IS NULL) held
     FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ?`, userId)
  for (const c of cache) {
    const derived = fromAmountText(c.derived, `the postings of ${c.code}`), cached = fromAmountText(c.cached, `the balance of ${c.code}`)
    const held = fromAmountText(c.held, `what is reserved in ${c.code}`)
    if (derived !== cached) out.push({ check: 'balance-cache', detail: `${c.code}: cached ${cached}, postings sum to ${derived}` })
    const natural = DEBIT_NORMAL[c.kind] ? derived : -derived
    if (c.nonneg && natural < 0n) out.push({ check: 'non-negative', detail: `${c.code} is ${natural}` })
    if (c.kind === 'asset' && held > natural) out.push({ check: 'holds-covered', detail: `${c.code}: ${held} reserved against ${natural}` })
  }

  const assetsTotal = db.all<{ asset_id: string; s: string }>(
    `SELECT p.asset_id, amount_sum(${amt('p')}) s FROM postings p JOIN entries e ON e.id = p.entry_id WHERE e.user_id = ? GROUP BY p.asset_id HAVING amount_sum(${amt('p')}) != '0'`, userId)
  for (const a of assetsTotal) out.push({ check: 'books-balance', detail: `all postings in ${a.asset_id} sum to ${fromAmountText(a.s, `the postings in ${a.asset_id}`)}, not zero` })

  const seq = db.get<{ n: number; mx: number | null; mn: number | null }>('SELECT COUNT(*) n, MAX(seq) mx, MIN(seq) mn FROM entries WHERE user_id = ?', userId)!
  if (seq.n > 0 && (seq.mn !== 1 || seq.mx !== seq.n)) out.push({ check: 'sequence', detail: `entries run ${seq.mn}..${seq.mx} but there are ${seq.n}` })

  // lots.instrument_id is a market line; the holding's account is named after it ('pos:coindcx:BTCINR').
  const lots = db.all<{ instrument_id: string; lots: string; bal: string | null }>(
    `SELECT l.instrument_id, amount_sum(l.remaining) lots,
            (SELECT ${amt('b')} FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = l.user_id AND a.code = 'pos:' || l.instrument_id) bal
     FROM lots l WHERE l.user_id = ? GROUP BY l.instrument_id`, userId)
  for (const l of lots) {
    const inLots = fromAmountText(l.lots, `the lots of ${l.instrument_id}`), held = l.bal === null ? 0n : fromAmountText(l.bal, `the holding of ${l.instrument_id}`)
    if (inLots !== held) out.push({ check: 'lots-match-holdings', detail: `${l.instrument_id}: lots hold ${inLots}, the ledger holds ${held}` })
  }
  return out
}

/** One line of an entry: amount is the JSON number when a JavaScript number holds it exactly, else null; amount_text is always exact. */
export interface EntryLineView { code: string; name: string; asset: string; amount: number | null; amount_text: string }
export interface EntryView { id: string; seq: number; ts: number; effective_ts: number; kind: string; ref: string; memo: string; meta: Record<string, unknown>; lines: EntryLineView[] }

export function listEntries(db: Db, userId: string, opts: { limit?: number; beforeSeq?: number; account?: string } = {}): EntryView[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const rows = opts.account
    ? db.all<Row>(`SELECT DISTINCT e.* FROM entries e JOIN postings p ON p.entry_id = e.id JOIN accounts a ON a.id = p.account_id
                   WHERE e.user_id = ? AND a.code = ? AND e.seq < ? ORDER BY e.seq DESC LIMIT ?`, userId, opts.account, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
    : db.all<Row>('SELECT * FROM entries WHERE user_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', userId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
  return rows.map((r) => ({
    id: String(r.id), seq: Number(r.seq), ts: Number(r.ts), effective_ts: Number(r.effective_ts), kind: String(r.kind), ref: String(r.ref), memo: String(r.memo),
    meta: parse<Record<string, unknown>>(r.meta_json, {}),
    lines: db.all<{ code: string; name: string; asset: string; t: string }>(
      'SELECT a.code, a.name, p.asset_id asset, p.amount_text t FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = ? ORDER BY p.id', String(r.id))
      .map(({ t, ...l }) => { const v = fromAmountText(t, `a line of entry ${String(r.seq)}`); return { ...l, amount: numberOrNull(v), amount_text: t } }),
  }))
}

/** One account as GET /api/accounts lists it. raw is the stored balance (positive means a net debit) as a number when exact, else null. */
export interface AccountView { code: string; kind: string; asset: string; name: string; raw: number | null; raw_text: string }

export function listAccounts(db: Db, userId: string): AccountView[] {
  return db.all<{ code: string; kind: string; asset: string; name: string; t: string }>(
    'SELECT a.code, a.kind, a.asset_id asset, a.name, b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? ORDER BY a.kind, a.code', userId)
    .map(({ t, ...a }) => ({ ...a, raw: numberOrNull(fromAmountText(t, `the balance of ${a.code}`)), raw_text: t }))
}
type Row = Record<string, unknown>
