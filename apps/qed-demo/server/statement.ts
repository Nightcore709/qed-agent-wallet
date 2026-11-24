/**
 * The bank statement for a chosen period (R12 task comparison, gap 9; T5-a and T5-d): the balance at the period's start,
 * every line entered in it with the ledger's balance after each, and the balance at its end.
 *
 * A period is a run of the ledger's own order. It starts at the first bank entry entered at or after its first moment
 * (00:00 IST of its first day, shared/period.ts) and ends before the first entered at or after its end. Hence, exactly
 * and in integer paise: the start plus money in, less money out, is the end; every line's balance is the ledger's
 * balance after it (the running balance the passbook has always shown); one period's end is the next one's start; and a
 * period that has closed never changes. A line entered late (QED was not running when the bank event happened) is on
 * the statement of the day it was entered and says when it took effect (`effectiveTs`). Ordering by the time each
 * event took effect was weighed and refused: an instalment taken late for want of money keeps its scheduled time
 * (server/bank.ts), so a balance run in that order would show amounts the account never held, below zero included.
 *
 * Entry times are not assumed to run forwards (QA hand-back, R13): a period's edges are read from the latest entry time
 * so far, so a line stamped earlier than one before it (a clock set back) stays where it was entered and the periods
 * still follow one another exactly (the first entry at or after a moment is also the first whose latest-so-far time reaches it). `backdated` counts such lines in the period, and the screen says so.
 */
import { numberOrNull } from '../shared/amount-text.ts'
import { checkDates, dayStartIn, isDate, nextDay, type Period, PeriodError, type PeriodKind, periodOf, running } from '../shared/period.ts'
import { DEFAULT_ZONE } from '../shared/zone.ts'
import { AppError, type Db } from './core.ts'
import { BANK_ENTRIES, bankAccount, bankDelta, expectedLines, passbookLine } from './views.ts'

type Row = Record<string, unknown>
const KINDS: PeriodKind[] = ['all', 'week', 'month', 'last-month', 'dates']
const ALL_SEQ = Number.MAX_SAFE_INTEGER

/** The period a request asks for (?period=week, month, last-month, all; or dates with ?first= and ?last=), refused in words when wrong. */
export function periodFromQuery(q: URLSearchParams, now: number, zone: string = DEFAULT_ZONE): Period {
  const kind = q.get('period') as PeriodKind
  if (!KINDS.includes(kind)) throw new AppError(400, 'invalid', 'Choose a period: since opening, this week, this month, last month, or dates.')
  try {
    return kind === 'dates' ? periodOf('dates', now, { first: q.get('first') ?? '', last: q.get('last') ?? '' }, zone) : periodOf(kind, now, undefined, zone)
  } catch (e) {
    if (e instanceof PeriodError) throw new AppError(400, 'invalid', e.message, e.fields)
    throw e
  }
}

/**
 * Activity's dates (?first= and ?last=, India days, either end may be left open) as a span of instants, `from` inclusive
 * and `to` exclusive; null when neither is given. Refused in words when a day is not a date or the last is before the first.
 */
export function spanFromQuery(q: URLSearchParams, zone: string = DEFAULT_ZONE): { from: number; to: number } | null {
  const first = q.get('first'), last = q.get('last')
  if (first === null && last === null) return null
  const wrong = first !== null && !isDate(first) ? { first: 'Give the first day as a date.' } : last !== null && !isDate(last) ? { last: 'Give the last day as a date.' } : first !== null && last !== null ? checkDates(first, last) : null
  if (wrong) throw new AppError(400, 'invalid', wrong.first ?? wrong.last ?? 'Check the dates.', wrong)
  return { from: first !== null ? dayStartIn(first, zone) : 0, to: last !== null ? dayStartIn(nextDay(last), zone) : Number.MAX_SAFE_INTEGER }
}

/** Exact text with its number beside it when a JavaScript number holds it (stage S3). */
const both = (name: string, v: bigint): Row => ({ [name]: numberOrNull(v), [`${name}_text`]: v.toString() })

/**
 * The statement for a period. The figures (opening, money in and out with their line counts, closing) cover the whole
 * period; `lines` are its latest `limit` lines, newest first, and `more` says whether earlier ones were left out.
 * `opened` is when the account's first line was entered. What is expected next is given only while the period runs.
 */
export function statement(db: Db, userId: string, now: number, period: Period, limit = 80): Row {
  const acc = bankAccount(db, userId)
  const base = { period, ...both('balance', acc?.balance ?? 0n) }
  if (!acc) return { ...base, opened: null, ...both('opening', 0n), ...both('moneyIn', 0n), ...both('moneyOut', 0n), ...both('closing', 0n), linesIn: 0, linesOut: 0, backdated: 0, count: 0, more: false, lines: [], expected: [] }

  // where the period starts and ends in the ledger's order: the first bank entry entered at or after each moment. This
  // is the same as reading the latest entry time so far (never running backwards), so a line stamped earlier than one
  // before it (a clock set back) stays where it was entered; periods still follow one another with no gap or overlap.
  const firstAtOrAfter = (t: number | null, none: number): number => (t === null ? none : db.get<{ s: number | null }>(
    'SELECT MIN(e.seq) s FROM entries e WHERE e.user_id = ? AND e.ts >= ? AND EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?)', userId, t, acc.id)?.s ?? ALL_SEQ)
  const lo = firstAtOrAfter(period.from, 0), hi = firstAtOrAfter(period.to, ALL_SEQ)
  const sumBefore = (seq: number): bigint => { const t = db.get<{ s: string }>('SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id WHERE p.account_id = ? AND e.seq < ?', acc.id, seq)?.s; return t ? BigInt(t) : 0n }

  const opening = sumBefore(lo)
  const deltas = db.all<{ seq: number; delta: string }>('SELECT e.seq, (SELECT amount_sum(p.amount_text) FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?) delta FROM entries e WHERE e.user_id = ? AND e.seq >= ? AND e.seq < ? AND EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?)', acc.id, userId, lo, hi, acc.id)
    .map((r) => bankDelta(r))
  // lines of this period stamped earlier than a line entered before them: placed by the order they were entered in
  const priorMax = db.get<{ m: number | null }>('SELECT MAX(e.ts) m FROM entries e WHERE e.user_id = ? AND e.seq < ? AND EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?)', userId, lo, acc.id)?.m ?? 0
  let latest = priorMax, backdated = 0
  for (const r of db.all<{ ts: number }>('SELECT e.ts FROM entries e WHERE e.user_id = ? AND e.seq >= ? AND e.seq < ? AND EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?) ORDER BY e.seq', userId, lo, hi, acc.id)) { if (r.ts < latest) backdated++; else latest = r.ts }
  let moneyIn = 0n, moneyOut = 0n, linesIn = 0, linesOut = 0
  for (const d of deltas) { if (d > 0n) { moneyIn += d; linesIn++ } else if (d < 0n) { moneyOut -= d; linesOut++ } }
  const closing = opening + moneyIn - moneyOut
  // the same end read from the ledger directly: the two agree unless the book itself is broken, and then nothing is shown as if it added up
  const ledgerClosing = sumBefore(hi)
  if (ledgerClosing !== closing) throw new AppError(500, 'ledger_broken', `This statement does not add up: its lines come to ${closing} paise and the ledger to ${ledgerClosing}. Nothing is shown as if it did.`)

  const take = Math.min(Math.max(limit, 1), 100_000)
  const rows = db.all<Row>(`${BANK_ENTRIES} AND e.seq >= ? AND e.seq < ? ORDER BY e.seq DESC LIMIT ?`, acc.id, userId, acc.id, lo, hi, take)
  let after = closing
  const lines = rows.map((e) => { const line = passbookLine(db, e, after); after -= bankDelta(e); return line })
  const opened = db.get<{ ts: number }>(`${BANK_ENTRIES.replace('SELECT e.id, e.seq, e.ts,', 'SELECT e.ts,')} ORDER BY e.seq LIMIT 1`, acc.id, userId, acc.id)?.ts ?? null

  return {
    ...base, opened, ...both('opening', opening), ...both('moneyIn', moneyIn), ...both('moneyOut', moneyOut), ...both('closing', closing),
    // a line that moved nothing (a zero net) is counted in neither direction but is a line of the period
    linesIn, linesOut, backdated, count: deltas.length, more: deltas.length > lines.length, lines,
    expected: running(period, now) ? expectedLines(db, userId, now) : [],
  }
}
