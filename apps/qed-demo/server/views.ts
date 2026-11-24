/**
 * Read models for the interface. Everything here is derived from recorded state at the moment of the request;
 * nothing is cached in the API process, so two devices always see the same thing.
 */
import { packReason } from './dispute-pack.ts'
import { fromAmountText, numberOrNull } from '../shared/amount-text.ts'
import { homeMoneyExact } from '../shared/home-money.ts'
import { type Db, parse } from './core.ts'
import { engineStatus } from './engine.ts'
import { escrowNeeds } from './escrow.ts'
import { heldIds } from './notify.ts'
import { getProfile, nextMonthly, recordedSpending } from './household.ts'
import { freshness, type Market, rowToTick } from './market.ts'
import { ceilingPaise, describeSchedule, kindSpec, nextDue } from './programs.ts'
import { monthStart, programUsage } from './liquidity.ts'
import { lastRecon } from './recon.ts'
import { lastChainComparison, TEST_TOKEN_WORDS } from './chain-books.ts'
import { instrument, instruments } from './registry.ts'
import { verifyChain } from './receipts.ts'
import { type Authority, type OrderParams, type PaymentParams, type Schedule } from './types.ts'
import { withStories } from './performance.ts'
import { billCover, commitments, overview } from './valuation.ts'
import { goalNeeds } from './goals.ts'
import { NOT_OFFERED } from './securities.ts'

type Row = Record<string, unknown>

export function describeAction(db: Db, kind: string, params: OrderParams | PaymentParams): string {
  const money = (s?: string) => homeMoneyExact(Number(s ?? 0))
  if (kind === 'payment') { const p = params as PaymentParams; return p.purpose === 'goal' ? `Set aside ${money(p.amount)} for ${p.payeeName}` : `Pay ${money(p.amount)} to ${p.payeeName}` }
  const p = params as OrderParams
  const inst = instrument(db, p.instrumentId)
  const name = inst?.name ?? p.instrumentId
  if (p.side === 'buy') return `Buy ${p.amount ? money(p.amount) + ' of' : ''} ${name}`.replace(/\s+/g, ' ')
  const qty = p.qty && inst ? `${Number(p.qty) / 10 ** inst.baseScale} ${inst.kind === 'mutual_fund' ? 'units of' : inst.base_asset}` : 'all'
  return inst?.kind === 'mutual_fund' ? `Redeem ${qty} ${name}` : `Sell ${qty}${p.type === 'stop' ? ` if the price falls to ${Number(p.stopPrice).toLocaleString('en-IN')}` : ''}`
}

export function actionView(db: Db, r: Row): Row {
  const params = parse<OrderParams | PaymentParams>(r.params_json, {} as OrderParams)
  const inst = r.kind === 'order' ? instrument(db, (params as OrderParams).instrumentId) : undefined
  return {
    id: r.id, kind: r.kind, origin: r.origin, venue: r.venue, state: r.state, runId: r.run_id, programId: r.program_id, economicId: r.economic_id,
    what: describeAction(db, String(r.kind), params), params, instrument: inst ? { id: inst.id, name: inst.name, kind: inst.kind, baseAsset: inst.base_asset, baseScale: inst.baseScale } : null,
    decision: parse<Row>(r.policy_json, {}), result: parse<Row>(r.result_json, {}), times: parse<Row>(r.times_json, {}), reconState: r.recon_state, receiptId: r.receipt_id, approvalId: r.approval_id, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

/** One action with what it ran under: the instruction and run, the approval that authorised it, and any dispute. */
export function recordView(db: Db, userId: string, id: string): Row | null {
  const a = db.get<Row>('SELECT * FROM actions WHERE id = ? AND user_id = ?', id, userId)
  if (!a) return null
  const run = a.run_id ? db.get<Row>('SELECT id, version, occurrence, due_at, state FROM runs WHERE id = ? AND user_id = ?', String(a.run_id), userId) : undefined
  const prog = a.program_id ? db.get<Row>('SELECT id, title, kind, state FROM programs WHERE id = ? AND user_id = ?', String(a.program_id), userId) : undefined
  const ver = prog && run ? db.get<Row>('SELECT content_hash, approved_at FROM program_versions WHERE program_id = ? AND version = ?', String(prog.id), Number(run.version)) : undefined
  const ap = a.approval_id ? db.get<Row>('SELECT id, purpose, doc_hash, method, confirmed_at FROM approvals WHERE id = ? AND user_id = ?', String(a.approval_id), userId) : undefined
  return {
    ...actionView(db, a),
    program: prog ? { id: prog.id, title: prog.title, kind: prog.kind, state: prog.state, version: run?.version ?? null, contentHash: ver?.content_hash ?? null, signedAt: ver?.approved_at ?? null } : null,
    run: run ? { id: run.id, occurrence: run.occurrence, dueAt: run.due_at, state: run.state } : null,
    approval: ap ? { id: ap.id, purpose: ap.purpose, docHash: ap.doc_hash, method: ap.method, confirmedAt: ap.confirmed_at } : null,
    disputes: db.all<Row>('SELECT id, state, reason, resolution, created_at, updated_at FROM disputes WHERE action_id = ? AND user_id = ? ORDER BY created_at DESC', id, userId),
    packReason: a.kind === 'payment' ? packReason(db, userId, id, Date.now()) : null,
  }
}

/** Actions newest first; `from` (inclusive) and `to` (exclusive) keep those made in a span, as Activity's dates ask. */
export function listActions(db: Db, userId: string, opts: { limit?: number; before?: number; open?: boolean; from?: number; to?: number; now?: number } = {}): Row[] {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300)
  const rows = opts.open
    ? db.all<Row>(`SELECT * FROM actions WHERE user_id = ? AND state IN ('planned', 'held', 'awaiting_approval', 'submitting', 'working') ORDER BY created_at DESC LIMIT ?`, userId, limit)
    : db.all<Row>('SELECT * FROM actions WHERE user_id = ? AND created_at < ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', userId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER, limit)
  // a payment's dispute, and whether a dispute pack can be made for it (dispute-pack.ts): shown in Activity beside its state
  return rows.map((r) => {
    const v = actionView(db, r)
    if (r.kind !== 'payment') return v
    const dispute = db.get<Row>('SELECT id, state, reason, resolution, created_at, updated_at FROM disputes WHERE action_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1', String(r.id), userId)
    return { ...v, dispute: dispute ?? null, packReason: packReason(db, userId, String(r.id), opts.now ?? Date.now()) }
  })
}

export function runView(db: Db, r: Row, withActions = true): Row {
  const decision = parse<{ summary?: string[]; plannedAt?: number }>(r.decision_json, {})
  return {
    id: r.id, programId: r.program_id, version: r.version, occurrence: r.occurrence, state: r.state, trigger: parse<Row>(r.trigger_json, {}), dueAt: r.due_at, createdAt: r.created_at,
    startedAt: r.started_at, finishedAt: r.finished_at, deadlineAt: r.deadline_at, reason: r.reason, willDo: decision.summary ?? [],
    actions: withActions ? db.all<Row>('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at', String(r.id)).map((a) => actionView(db, a)) : undefined,
  }
}

export function programSummary(db: Db, r: Row, now: number): Row {
  const version = (r.live_version as number | null) ?? db.get<{ v: number | null }>(`SELECT MAX(version) v FROM program_versions WHERE program_id = ? AND state = 'draft'`, String(r.id))?.v ?? null
  const v = version ? db.get<{ params_json: string; authority_json: string; analysis_json: string; content_hash: string; state: string; approved_at: number | null }>('SELECT params_json, authority_json, analysis_json, content_hash, state, approved_at FROM program_versions WHERE program_id = ? AND version = ?', String(r.id), version) : undefined
  const authority = v ? parse<Authority | null>(v.authority_json, null) : null
  const params = v ? parse<Row>(v.params_json, {}) : {}
  let schedule: Schedule | null = null
  try { schedule = v ? kindSpec(String(r.kind)).schedule(params) : null } catch { schedule = null }
  const analysis = v ? parse<{ tier?: string; tierReason?: string; headline?: string }>(v.analysis_json, {}) : {}
  const lastRun = db.get<Row>('SELECT * FROM runs WHERE program_id = ? ORDER BY created_at DESC LIMIT 1', String(r.id))
  const counts = db.get<{ done: number; missed: number; refused: number; waiting: number }>(
    `SELECT SUM(state IN ('done', 'partial')) done, SUM(state = 'missed') missed, SUM(state IN ('blocked', 'failed')) refused, SUM(state IN ('awaiting_approval', 'objection_window')) waiting FROM runs WHERE program_id = ?`, String(r.id))
  const memo = parse<Row>(r.memo_json, {})
  return {
    id: r.id, kind: r.kind, pillar: r.pillar, title: r.title, state: r.state, liveVersion: r.live_version, hasDraft: !!db.get(`SELECT 1 FROM program_versions WHERE program_id = ? AND state = 'draft'`, String(r.id)),
    nextDueAt: r.next_due_at, pausedReason: r.paused_reason, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at,
    authority, params, schedule, scheduleText: schedule ? describeSchedule(schedule) : null, following: schedule && typeof r.next_due_at === 'number' ? [r.next_due_at, ...(() => { const out: number[] = []; let t = r.next_due_at as number; for (let i = 0; i < 2; i++) { const n = nextDue(schedule!, t); if (n === null) break; out.push(n); t = n } return out })()] : [],
    ceiling: authority && r.kind !== 'exit' && r.kind !== 'floor' ? ceilingPaise(authority, now) : null,
    // What this instruction has used of its monthly limit: the figure the policy check itself counts (policy.ts, within-month-limit).
    usedThisMonth: authority && r.kind !== 'exit' && r.kind !== 'floor' ? Number(programUsage(db, String(r.id), monthStart(now))) : null,
    tier: analysis.tier ?? null, tierReason: analysis.tierReason ?? null, headline: analysis.headline ?? null, contentHash: v?.content_hash ?? null, approvedAt: v?.approved_at ?? null,
    lastRun: lastRun ? runView(db, lastRun, false) : null, counts: { done: counts?.done ?? 0, missed: counts?.missed ?? 0, refused: counts?.refused ?? 0, waiting: counts?.waiting ?? 0 },
    watching: memo.blindSince ? { since: memo.blindSince, why: memo.blindWhy } : null, lastChecked: memo.lastChecked ?? null, lastBid: memo.lastBid ?? null, high: memo.high ?? null,
  }
}

export function listPrograms(db: Db, userId: string, now: number): Row[] {
  return db.all<Row>(`SELECT * FROM programs WHERE user_id = ? ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, updated_at DESC`, userId).map((r) => programSummary(db, r, now))
}

export function programDetail(db: Db, userId: string, id: string, now: number): Row | null {
  const r = db.get<Row>('SELECT * FROM programs WHERE id = ? AND user_id = ?', id, userId)
  if (!r) return null
  const versions = db.all<Row>('SELECT * FROM program_versions WHERE program_id = ? ORDER BY version DESC', id).map((v) => ({
    version: v.version, state: v.state, createdAt: v.created_at, approvedAt: v.approved_at, approvalId: v.approval_id, contentHash: v.content_hash,
    // how the owner signed this version, as the approval recorded it (a passkey today; a password on accounts made before passkeys)
    approvalMethod: v.approval_id ? db.get<{ method: string | null }>('SELECT method FROM approvals WHERE id = ?', String(v.approval_id))?.method ?? null : null,
    params: parse<Row>(v.params_json, {}), authority: parse<Row>(v.authority_json, {}), analysis: parse<Row>(v.analysis_json, {}), doc: parse<Row>(v.document, {}), document: v.document,
  }))
  return {
    ...programSummary(db, r, now), versions,
    events: db.all<Row>('SELECT id, ts, kind, actor, detail_json FROM program_events WHERE program_id = ? ORDER BY id DESC LIMIT 100', id).map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, actor: e.actor, detail: parse<Row>(e.detail_json, {}) })),
    runs: db.all<Row>('SELECT * FROM runs WHERE program_id = ? ORDER BY created_at DESC LIMIT 60', id).map((x) => runView(db, x)),
  }
}

export function marketView(db: Db, market: Market, now: number): Row {
  const quotes = db.all<Row>('SELECT * FROM quotes').map(rowToTick)
  return {
    asOf: now,
    instruments: instruments(db).map((i) => {
      const mine = quotes.filter((q) => q.instrumentId === i.id)
      const q = Object.fromEntries(mine.map((t) => [t.type, { price: t.price, size: t.size ?? null, sourceTs: t.sourceTs, precision: t.precision, recvTs: t.recvTs, provider: t.provider, ...freshness(t, i, now) }]))
      return { id: i.id, kind: i.kind, name: i.name, base: i.base_asset, quote: i.quote_asset, provider: i.provider, venue: i.venue, tradable: i.tradable === 1, baseScale: i.baseScale, meta: i.meta, quotes: q }
    }),
    providers: db.all<Row>('SELECT provider, state, since, last_ok, last_error, last_error_at, messages, reconnects FROM provider_status ORDER BY provider'),
    clock: db.get<Row>('SELECT ts, reference, offset_ms, uncertainty_ms FROM clock_checks ORDER BY id DESC LIMIT 1') ?? null,
    terms: db.all<Row>('SELECT id, kind, name, value_json, source, source_url, as_of, status FROM terms ORDER BY kind, id').map((t) => ({ ...t, value: parse<Row>(t.value_json, {}), value_json: undefined })),
    // what the mandate names that QED does not trade yet, each with its reason (securities.ts)
    notOffered: NOT_OFFERED,
  }
  void market
}

/**
 * Most published values a daily series sends before it is thinned. A published value (a fund's NAV, a reference rate)
 * holds until the next one, and the chart draws it so (a step for each day it was published); a series thinned to
 * every second value would draw each NAV holding for two days, a value that was never true. 2,000 is over seven years
 * of business days, and the interface asks for three at most; were a series ever longer, `step` says how it was thinned
 * and the chart says so (R12, the owner: daily NAVs as steps, never interpolated).
 */
export const DAILY_POINTS = 2000
/** Most recorded samples a streamed series sends; a denser record is thinned evenly (every `step`-th sample, and the last). */
export const RECORDED_POINTS = 600

/** A price series for a chart. Daily instruments return published values; streamed ones return recorded samples. */
export function history(db: Db, id: string, opts: { days?: number; hours?: number }): Row {
  const inst = instrument(db, id)
  if (!inst) return { id, points: [], kind: 'none' }
  if (inst.kind === 'mutual_fund' || inst.kind === 'fx_reference' || inst.kind === 'rate') {
    const days = Math.min(Math.max(opts.days ?? 365, 5), 5000)
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    const rows = db.all<{ value_date: string; value: string; source: string }>('SELECT value_date, value, source FROM daily_values WHERE instrument_id = ? AND value_date >= ? ORDER BY value_date', id, from)
    const step = Math.max(1, Math.ceil(rows.length / DAILY_POINTS))
    const pts = rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
    return { id, kind: 'daily', priceType: inst.kind === 'mutual_fund' ? 'nav' : inst.kind === 'rate' ? 'rate' : 'reference', points: pts.map((r) => ({ t: r.value_date, v: Number(r.value) })), observations: rows.length, step, from: rows[0]?.value_date ?? null, to: rows[rows.length - 1]?.value_date ?? null, note: 'Published values. History before this engine first ran was back-filled from the publisher\'s record and is historical, not live.' }
  }
  const hours = Math.min(Math.max(opts.hours ?? 6, 1), 24 * 14)
  const type = inst.kind === 'crypto_spot' ? 'bid' : 'last'
  const rows = db.all<{ recv_ts: number; price: string }>('SELECT recv_ts, price FROM quote_history WHERE instrument_id = ? AND price_type = ? AND recv_ts >= ? ORDER BY recv_ts', id, type, Date.now() - hours * 3600_000)
  const step = Math.max(1, Math.ceil(rows.length / RECORDED_POINTS))
  return { id, kind: 'recorded', priceType: type, points: rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ t: r.recv_ts, v: Number(r.price) })), observations: rows.length, step, from: rows[0]?.recv_ts ?? null, to: rows[rows.length - 1]?.recv_ts ?? null, note: 'Samples this engine recorded while it was running. Gaps are times it was not running or the source was silent.' }
}

/** Open notices, most pressing first. Notices that say exactly the same thing are shown once, with how often it was said. */
export function noticesView(db: Db, userId: string, now = Date.now()): Row[] {
  // Held notices (a warning in the owner's quiet hours, info waiting for the digest) are left out until due (notify.ts).
  const held = heldIds(db, userId, now)
  const rows = db.all<Row>(`SELECT id, ts, level, kind, title, body, subject, read_at FROM notices WHERE user_id = ? AND resolved_at IS NULL ORDER BY CASE level WHEN 'action' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, ts DESC LIMIT 300`, userId).filter((r) => !held.has(String(r.id)))
  const once = new Map<string, Row>()
  for (const r of rows) {
    const key = [r.level, r.kind, r.title, r.body, r.subject ?? ''].join('\u0000')
    const have = once.get(key)
    if (have) { have.count = Number(have.count) + 1; have.firstTs = r.ts } // newest first within a level, so the one kept is the latest
    else once.set(key, { ...r, count: 1, firstTs: r.ts })
  }
  return [...once.values()].slice(0, 60)
}

/**
 * What happened between two moments, from the records alone: what QED carried out and under which instruction,
 * what was missed, refused or failed, and how long the engine was not running. No model writes any of it.
 */
export function sinceView(db: Db, userId: string, since: number, now: number): Row {
  const created = db.get<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', userId)?.created_at ?? 0
  const from = Math.min(Math.max(Number.isFinite(since) ? since : now, created, now - 30 * 86_400_000), now)
  const runs = db.all<{ state: string; n: number }>('SELECT state, COUNT(*) n FROM runs WHERE user_id = ? AND COALESCE(finished_at, created_at) > ? AND COALESCE(finished_at, created_at) <= ? GROUP BY state', userId, from, now)
  const count = (s: string): number => runs.find((r) => r.state === s)?.n ?? 0
  const acts = db.all<Row>(`SELECT a.origin, a.program_id, a.result_json, p.title FROM actions a LEFT JOIN programs p ON p.id = a.program_id WHERE a.user_id = ? AND a.updated_at > ? AND a.updated_at <= ? AND a.state IN ('done', 'partial')`, userId, from, now)
  const by = new Map<string, { id: string; title: string; n: number; moved: number }>()
  let byHand = 0
  for (const a of acts) {
    // a purchase within the commerce mandate is neither by hand nor under an instruction: it is shown in Spend and Activity under its own name
    if (a.origin === 'commerce') continue
    if (a.origin !== 'program') { byHand++; continue }
    const e = by.get(String(a.program_id)) ?? { id: String(a.program_id), title: String(a.title ?? ''), n: 0, moved: 0 }
    e.n++; e.moved += Number(parse<{ movedPaise?: string }>(a.result_json, {}).movedPaise ?? 0)
    by.set(e.id, e)
  }
  const gaps = db.get<{ n: number; ms: number | null }>('SELECT COUNT(*) n, SUM(MIN(to_ts, ?) - MAX(from_ts, ?)) ms FROM downtime WHERE to_ts > ? AND from_ts < ?', now, from, from, now)
  const refused = db.all<{ reason: string | null; title: string }>(`SELECT r.reason, p.title FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.user_id = ? AND r.state = 'blocked' AND r.finished_at > ? AND r.finished_at <= ? ORDER BY r.finished_at DESC LIMIT 3`, userId, from, now)
  return {
    from, to: now, done: count('done') + count('partial'), missed: count('missed'), refused: count('blocked'), failed: count('failed'), lapsed: count('expired'),
    byInstruction: [...by.values()].sort((a, b) => b.moved - a.moved), byHand, downtime: { gaps: gaps?.n ?? 0, ms: gaps?.ms ?? 0 }, refusedWhy: refused,
  }
}

/** What is waiting on the owner: each item says why, by when, and what happens if they do nothing. */
export function needsYou(db: Db, userId: string, now: number): Row[] {
  const out: Row[] = []
  for (const r of db.all<Row>(`SELECT r.*, p.title FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.user_id = ? AND r.state IN ('awaiting_approval', 'objection_window') ORDER BY r.deadline_at`, userId)) {
    const d = parse<{ summary?: string[] }>(r.decision_json, {})
    out.push(r.state === 'awaiting_approval'
      ? { type: 'approve-run', runId: r.id, programId: r.program_id, title: `${r.title}: approve this run?`, detail: (d.summary ?? []).join('; '), deadline: r.deadline_at, ifNothing: 'If you do nothing it lapses and nothing is done.' }
      : { type: 'object-run', runId: r.id, programId: r.program_id, title: `${r.title} is about to run`, detail: (d.summary ?? []).join('; '), deadline: r.deadline_at, ifNothing: 'If you do nothing it goes ahead at that time.' })
  }
  // a bill with a payment under way or made is not offered again (R12 task comparison: one bill was paid twice)
  for (const b of db.all<Row>(`SELECT b.id, b.amount, b.due_at, y.name, y.handle FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND b.state = 'due' AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.user_id = b.user_id AND a.kind = 'payment' AND json_extract(a.params_json, '$.billId') = b.id AND a.state NOT IN ('rejected', 'failed', 'cancelled', 'expired', 'blocked')) ORDER BY b.due_at`, userId)) {
    const cover = billCover(db, userId, String(b.handle), Number(b.amount))
    const covered = 'id' in cover
    const overdue = Number(b.due_at) < now
    if (!covered || overdue) out.push({ type: 'pay-bill', billId: b.id, title: `${b.name}: ${homeMoneyExact(Number(b.amount))} ${overdue ? 'was due' : 'is due'}`, detail: covered ? 'An instruction covers this bill but has not paid it.' : cover.reason, deadline: b.due_at, ifNothing: 'If you do nothing it stays unpaid.' })
  }
  // R7-111 F2: an account that one lost device would lose, said where the owner looks first, not only under Security
  const keys = db.get<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL AND suspended_at IS NULL', userId)!.n
  const contacts = db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL AND accepted_at IS NOT NULL AND effective_at <= ?', userId, now)!.n
  // An account with no passkey and no recovery contact (a password account, D-094): its password is its only key, so a
  // forgotten one cannot be recovered and a learned one could add someone else's passkey (RISK-076; the finish review)
  const pw = keys === 0 && contacts === 0 ? db.get<{ pw_hash: string; kind: string }>('SELECT pw_hash, kind FROM users WHERE id = ?', userId) : undefined
  if (pw?.kind === 'person' && pw.pw_hash !== '!') out.push({ type: 'account-safety', title: 'Your password is this account\'s only key', detail: 'There is no passkey and no recovery contact. If the password is forgotten, your saved codes cannot get you back in on their own; if someone learns it, they could add a passkey of their own.', deadline: null, ifNothing: 'Add a passkey on this device, then name a recovery contact.' })
  if (keys === 1 && contacts === 0) out.push({ type: 'account-safety', title: 'One lost device would lose this account', detail: 'Only one passkey can sign for you, and no recovery contact is named. A saved code alone cannot recover the account.', deadline: null, ifNothing: 'If this device is lost, nobody can get you back in, and nothing QED does for you can be changed or stopped from a new device.' })
  // paper escrow (server/escrow.ts): a refund to answer, a dispute, money a timeout left locked: each with its deadline and
  // what happens without an answer, by the milestone's accepted terms
  out.push(...escrowNeeds(db, userId, now))
  // a savings goal is asked about only when it falls behind: what brings it back, and what happens if nothing is done (goals.ts)
  out.push(...goalNeeds(db, userId, now))
  return out
}

export function systemView(db: Db, userId: string, now: number): Row {
  const dayAgo = now - 86_400_000
  // A run counts as missed only if it was recorded as missed. One that fell due in a gap but was started within its
  // window after the engine returned is not missed, whatever became of it.
  const missedIn = (from: number, to: number): number => db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE user_id = ? AND state = 'missed' AND due_at >= ? AND due_at <= ?`, userId, from, to)!.n
  const day = db.get<{ gaps: number; ms: number | null }>('SELECT COUNT(*) gaps, SUM(to_ts - MAX(from_ts, ?)) ms FROM downtime WHERE to_ts > ?', dayAgo, dayAgo)!
  return {
    now, engine: engineStatus(db, now),
    providers: db.all<Row>('SELECT provider, state, since, last_ok, last_error, last_error_at, messages, reconnects FROM provider_status ORDER BY provider'),
    clock: db.all<Row>('SELECT ts, reference, offset_ms, uncertainty_ms FROM clock_checks ORDER BY id DESC LIMIT 5'),
    downtime: db.all<{ id: number; service: string; from_ts: number; to_ts: number; note: string | null }>('SELECT id, service, from_ts, to_ts, note FROM downtime ORDER BY id DESC LIMIT 40').map((d) => ({ ...d, missed_runs: missedIn(d.from_ts, d.to_ts) })),
    downtimeDay: { gaps: day.gaps, ms: day.ms ?? 0, missed: db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE user_id = ? AND state = 'missed' AND due_at > ?`, userId, dayAgo)!.n },
    counts: db.get<Row>(`SELECT (SELECT COUNT(*) FROM quotes) quotes, (SELECT COUNT(*) FROM quote_history) samples, (SELECT COUNT(*) FROM daily_values) dailyValues, (SELECT COUNT(*) FROM entries WHERE user_id = ?) entries, (SELECT COUNT(*) FROM receipts WHERE user_id = ?) receipts`, userId, userId),
  }
}

export function homeView(db: Db, market: Market, userId: string, now: number): Row {
  const profile = getProfile(db, userId)
  const valued = overview(db, market, userId, now)
  // each holding with what it was bought at and why it changed (R12 task comparison, gap 17), for Grow
  const o = { ...valued, holdings: withStories(db, userId, valued.holdings, now) }
  const user = db.get<{ stop_at: number | null; stop_reason: string | null; stop_protective: number }>('SELECT stop_at, stop_reason, stop_protective FROM users WHERE id = ?', userId)
  const spent30 = recordedSpending(db, userId, now)
  return {
    overview: o, profile, needsYou: needsYou(db, userId, now), notices: noticesView(db, userId, now),
    programs: listPrograms(db, userId, now).filter((p) => p.state === 'active' || p.state === 'paused' || p.state === 'draft'),
    inFlight: listActions(db, userId, { open: true }),
    recon: lastRecon(db, userId), receipts: verifyChain(db, userId), engine: engineStatus(db, now), stop: user?.stop_at ? { at: user.stop_at, reason: user.stop_reason, protectiveContinues: user.stop_protective === 1 } : null,
    // the on-chain wallet in the books: test tokens, kept apart from every rupee figure above (server/chain-books.ts)
    chainBooks: { comparison: lastChainComparison(db, userId), words: TEST_TOKEN_WORDS },
    spending: { recorded30d: spent30, assumedMonthly: profile.spending, exceeds: spent30 > profile.spending },
    downtime: db.all<Row>('SELECT from_ts, to_ts, missed_runs FROM downtime ORDER BY id DESC LIMIT 3'),
  }
}

const ACTOR_BY_KIND: Record<string, string> = { opening: 'bank', 'income-salary': 'employer', 'loan-instalment': 'bank', 'card-interest': 'bank', 'savings-interest': 'bank', 'paper-topup': 'you', 'payment-reversed': 'rail', 'dispute-refund': 'payee', 'payment-returned': 'rail', 'fund-redemption-paid': 'fund house', 'sale-settled': 'the paper desk', coupon: 'the government' }

/** The bank account's id and its balance now (stage S3: a bigint from the ledger's text), or null before it is opened. */
export function bankAccount(db: Db, userId: string): { id: string; balance: bigint } | null {
  const acc = db.get<{ id: string; t: string }>(`SELECT a.id, b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code = 'bank'`, userId)
  return acc ? { id: acc.id, balance: fromAmountText(acc.t, 'the bank balance') } : null
}

/**
 * The entries on the bank account, each with `delta`, its net on the account as exact text. Bound: the account's id,
 * the user's id, the account's id; the caller adds its conditions on `e` and its order.
 */
export const BANK_ENTRIES = `SELECT e.id, e.seq, e.ts, e.effective_ts, e.kind, e.memo, e.meta_json, (SELECT amount_sum(p.amount_text) FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?) delta
     FROM entries e WHERE e.user_id = ? AND EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.account_id = ?)`

/** An entry's net on the bank account, exact. */
export const bankDelta = (e: Row): bigint => fromAmountText(e.delta, `entry ${String(e.seq)} in the bank account`)

/**
 * One passbook line: the entry's words, who caused it and under which instruction, its record and receipt, its amount on
 * the bank account, and `after`, the ledger's balance after it. Each figure is a number when a JavaScript number holds it
 * exactly (else null), with its exact text beside it (stage S3).
 */
export function passbookLine(db: Db, e: Row, after: bigint): Row {
  const meta = parse<{ actionId?: string; recordedLate?: boolean; takenLate?: boolean; scheduledAt?: number; note?: string; enteredByOwner?: boolean; milestoneId?: string }>(e.meta_json, {})
  const act = meta.actionId ? db.get<{ origin: string; program_id: string | null; receipt_id: string | null; state: string }>('SELECT origin, program_id, receipt_id, state FROM actions WHERE id = ?', meta.actionId) : undefined
  const prog = act?.program_id ? db.get<{ title: string }>('SELECT title FROM programs WHERE id = ?', act.program_id) : undefined
  const actor = act ? (act.origin === 'owner' ? 'you' : 'qed') : meta.enteredByOwner ? 'you' : meta.milestoneId ? 'client' : ACTOR_BY_KIND[String(e.kind)] ?? 'bank'
  const delta = bankDelta(e)
  // why a line is late, as the ledger recorded it (R13): recorded late (QED was not running when it took effect, so its
  // effective time is earlier), or taken late (an instalment refused on its day for want of money and taken when the money
  // came, so it is dated then); with the time it was due. Until R13 a line taken late carried no word of it.
  const late = meta.recordedLate || meta.takenLate
  return {
    seq: e.seq, ts: e.ts, effectiveTs: e.effective_ts, kind: e.kind, memo: e.memo, amount: numberOrNull(delta), amount_text: delta.toString(), balance: numberOrNull(after), balance_text: after.toString(), actor, actionId: meta.actionId ?? null, receiptId: act?.receipt_id ?? null, programId: act?.program_id ?? null, programTitle: prog?.title ?? null,
    recordedLate: !!meta.recordedLate, takenLate: !!meta.takenLate, scheduledAt: late && typeof meta.scheduledAt === 'number' ? meta.scheduledAt : null, lateReason: late && typeof meta.note === 'string' ? meta.note : null,
  }
}

/** What is expected in the next 30 days, soonest first: promises and estimates, not entries; they carry no balance of record. */
export function expectedLines(db: Db, userId: string, now: number): Row[] {
  const profile = getProfile(db, userId)
  const expected: Row[] = commitments(db, userId, now, 30 * 86_400_000).map((c) => ({ dueAt: c.dueAt, label: c.label, amount: -c.amount, kind: c.kind, certain: c.certain, subject: c.subject ?? null, by: c.by ?? null, unpaid: c.unpaid ?? null, runMode: c.runMode ?? null }))
  if (profile.income > 0) { const at = nextMonthly(now, profile.incomeDay, '09:30'); if (at <= now + 30 * 86_400_000) expected.push({ dueAt: at, label: 'Salary', amount: profile.income, kind: 'income', certain: false, subject: null }) }
  expected.sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
  return expected
}

/**
 * The bank account as a passbook: what happened, newest first, each line with its running balance and who caused
 * it, followed by what is expected next. Expected lines are promises and estimates, not entries; they carry no
 * balance of record. A chosen period is read by server/statement.ts.
 */
export function passbook(db: Db, userId: string, now: number, limit = 80): Row {
  // Amounts are bigints from the ledger's text (stage S3). Each figure is sent as a number when a JavaScript number holds it
  // exactly (else null) with its exact text beside it: balance_text, and each line's amount_text and balance_text.
  const acc = bankAccount(db, userId)
  if (!acc) return { balance: 0, balance_text: '0', lines: [], expected: [] }
  const rows = db.all<Row>(`${BANK_ENTRIES} ORDER BY e.seq DESC LIMIT ?`, acc.id, userId, acc.id, Math.min(Math.max(limit, 1), 100_000))
  let after = acc.balance
  const lines = rows.map((e) => {
    const line = passbookLine(db, e, after)
    after -= bankDelta(e)
    return line
  })
  return { balance: numberOrNull(acc.balance), balance_text: acc.balance.toString(), lines, expected: expectedLines(db, userId, now) }
}
