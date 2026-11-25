/**
 * The execution path for one economic action:
 *
 *   planned -> authority check -> reserve money or holdings -> submitting -> working -> outcome
 *           -> ledger entries -> reconciliation against the venue's own record -> receipt
 *
 * Every step is written to the database before the next begins, and every external effect carries the action's
 * economic id as its idempotency reference. If the process stops at any point, running the same step again finds
 * the earlier result and continues; it cannot submit, book or pay twice.
 */
import { pausedFor } from './dispute-pause.ts'
import { AppError, audit, type Db, emit, j, newId, parse, whenIst } from './core.ts'
import { InsufficientFunds, available, consumeLots, ensureAccount, openLot, placeHold, post, releaseHold } from './ledger.ts'
import { DUPLICATE_CONFIRM_BY_MS, repeatOf, repeatWords } from './duplicates.ts'
import { decide } from './policy.ts'
import { type Instrument, instrument } from './registry.ts'
import { issueReceipt } from './receipts.ts'
import { type ActionRow, type ActionState, actionFromRow, type Ctx, type Decision, type OrderParams, type PaymentParams, TERMINAL_ACTION } from './types.ts'
import { ensureGoalAccount, goalAccount } from './setaside.ts'
import { isSecurity } from './securities.ts'
import { type OrderRequest, PaperDebtVenue, PaperExchangeVenue, TERMINAL_ORDER, TERMINAL_PAYMENT, type VenueFill, type VenueOrder } from './venues.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { floorToStep, fraction, mulDiv, notional, parseDec, parsePrice, pow10 } from '../shared/fixed.ts'
import { withHome } from './home-currency.ts'
import { homeMoney, homeMoneyExact } from '../shared/home-money.ts'
import { canonical } from '../shared/sha256.ts'

const big = (s: string | undefined | null): bigint => BigInt(s ?? '0')

export function notice(db: Db, userId: string, n: { level: 'action' | 'warning' | 'info'; kind: string; title: string; body: string; subject?: string; dedupe?: string; rolling?: boolean }, now: number): void {
  const dedupe = n.dedupe ?? `${n.kind}:${n.subject ?? ''}:${now}`
  // A rolling notice is one line that is kept current: a later event of the same kind rewrites it and brings it back
  // if it had been dismissed. Without this, a night of missed runs would leave one notice for each.
  const ins = n.rolling
    ? db.run(`INSERT INTO notices (id, user_id, ts, level, kind, title, body, subject, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, dedupe) DO UPDATE SET ts = excluded.ts, level = excluded.level, title = excluded.title, body = excluded.body, subject = excluded.subject, read_at = NULL, resolved_at = NULL`,
        newId('ntc', now), userId, now, n.level, n.kind, n.title, n.body, n.subject ?? null, dedupe)
    : db.run('INSERT OR IGNORE INTO notices (id, user_id, ts, level, kind, title, body, subject, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('ntc', now), userId, now, n.level, n.kind, n.title, n.body, n.subject ?? null, dedupe)
  if (ins.changes > 0) emit(db, now, userId, 'notice', { kind: n.kind, level: n.level, title: n.title })
}
export function resolveNotices(db: Db, userId: string, dedupePrefix: string, now: number): void {
  db.run('UPDATE notices SET resolved_at = ? WHERE user_id = ? AND resolved_at IS NULL AND dedupe LIKE ?', now, userId, `${dedupePrefix}%`)
}

/** The owner dismisses a notice. Open notices that say exactly the same thing go with it: the list shows them as one. A notice that needs an answer cannot be dismissed. */
export function dismissNotice(db: Db, userId: string, id: string, now: number): number {
  const n = db.get<{ kind: string; title: string; body: string; subject: string | null }>(`SELECT kind, title, body, subject FROM notices WHERE id = ? AND user_id = ? AND level != 'action'`, id, userId)
  if (!n) return 0
  return Number(db.run(`UPDATE notices SET resolved_at = ? WHERE user_id = ? AND level != 'action' AND resolved_at IS NULL AND kind = ? AND title = ? AND body = ? AND COALESCE(subject, '') = ?`, now, userId, n.kind, n.title, n.body, n.subject ?? '').changes)
}

export interface NewAction { userId: string; runId?: string | null; programId?: string | null; origin: 'program' | 'owner' | 'commerce'; kind: 'order' | 'payment'; venue: string; economicId: string; params: OrderParams | PaymentParams; approvalId?: string | null }

/** Record the intent. Idempotent on the economic id: asking twice returns the action that already exists. */
export function createAction(ctx: Ctx, n: NewAction): ActionRow {
  const { db } = ctx
  const now = ctx.clock.now()
  const have = db.get<Record<string, unknown>>('SELECT * FROM actions WHERE user_id = ? AND economic_id = ?', n.userId, n.economicId)
  if (have) {
    // The same request again returns the action that exists. The same id with other details is a different request
    // wearing the first one's name: for an owner's action that is refused outright. An instruction's run is planned
    // again after a restart, when prices and balances may differ; there the first plan stands and is returned.
    const existing = actionFromRow(have)
    if (n.origin === 'owner' && (existing.kind !== n.kind || existing.venue !== n.venue || canonical(existing.params) !== canonical(n.params))) throw new AppError(409, 'idempotency_conflict', 'An action with this reference already exists with different details. Nothing was done.')
    return existing
  }
  const id = newId('act', now)
  db.run(`INSERT INTO actions (id, user_id, run_id, program_id, origin, kind, venue, economic_id, state, params_json, times_json, approval_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
    id, n.userId, n.runId ?? null, n.programId ?? null, n.origin, n.kind, n.venue, n.economicId, j(n.params), j({ created: now }), n.approvalId ?? null, now, now)
  emit(db, now, n.userId, 'action', { id, state: 'planned' })
  return getAction(db, id)!
}

export function getAction(db: Db, id: string): ActionRow | undefined {
  const r = db.get<Record<string, unknown>>('SELECT * FROM actions WHERE id = ?', id)
  return r ? actionFromRow(r) : undefined
}

function save(ctx: Ctx, a: ActionRow, patch: { state?: ActionState; params?: unknown; policy?: unknown; result?: Record<string, unknown>; time?: string; error?: string | null; attempt?: number }): ActionRow {
  const now = ctx.clock.now()
  const times = patch.time ? { ...a.times, [patch.time]: now } : a.times
  const result = patch.result ? { ...a.result, ...patch.result } : a.result
  ctx.db.run('UPDATE actions SET state = ?, params_json = ?, policy_json = ?, result_json = ?, times_json = ?, error = ?, attempt = ?, updated_at = ? WHERE id = ?',
    patch.state ?? a.state, j(patch.params ?? a.params), j(patch.policy ?? a.policy), j(result), j(times), patch.error === undefined ? a.error : patch.error, patch.attempt ?? a.attempt, now, a.id)
  if (patch.state && patch.state !== a.state) emit(ctx.db, now, a.user_id, 'action', { id: a.id, state: patch.state, runId: a.run_id })
  return getAction(ctx.db, a.id)!
}

const posCode = (inst: Instrument) => `pos:${inst.id}`
/** The venue an instrument trades on: the fund registrar, the paper exchange (ETFs, shares), the government-securities desk (a bill, a bond), or the crypto venue. */
export function venueFor(ctx: Ctx, inst: Instrument): { get(ref: string): VenueOrder | undefined; submit(r: OrderRequest): VenueOrder; cancel(ref: string): VenueOrder | undefined } {
  if (inst.kind === 'mutual_fund') return ctx.venues.funds
  if (inst.kind === 'etf' || inst.kind === 'equity') return (ctx.venues.exchange ??= new PaperExchangeVenue(ctx.db, ctx.market, ctx.clock))
  if (inst.kind === 'tbill' || inst.kind === 'gsec') return (ctx.venues.debt ??= new PaperDebtVenue(ctx.db, ctx.market, ctx.clock))
  return ctx.venues.crypto
}
const unitWord = (inst: Instrument): string => (inst.kind === 'equity' ? 'shares' : 'units')
function ensurePosition(db: Db, userId: string, inst: Instrument): void {
  ensureAccount(db, userId, posCode(inst), 'asset', inst.base_asset, inst.name, true, { instrumentId: inst.id })
  ensureAccount(db, userId, `trade:${inst.base_asset}`, 'trading', inst.base_asset, `${inst.base_asset} exchanged for rupees`, false)
}

/** Worst-case rupees a buy by quantity could cost, so that the hold covers it: price bound plus the fee. */
function buyCeiling(ctx: Ctx, inst: Instrument, p: OrderParams, qty: bigint): bigint | null {
  const ask = ctx.market.get(inst.id, 'ask')
  const ref = p.limitPrice ? parsePrice(p.limitPrice) : ask ? parsePrice(ask.price) : null
  if (ref === null) return null
  const bound = p.limitPrice ? ref : ref + mulDiv(ref, BigInt(p.maxSlippageBps ?? 100), 10_000n, 'up')
  const gross = notional(qty, inst.baseScale, bound, inst.quoteScale, 'up')
  return gross + fraction(gross, ctx.venues.crypto.rules(inst).feeRate, 'up')
}

/** How long an action may wait for data that is only stale, such as a price feed reconnecting. Then it is refused. */
export const DATA_WAIT_MS = 45_000

function refuse(ctx: Ctx, a: ActionRow, decision: Partial<Decision> | null, why: string): ActionRow {
  const next = save(ctx, a, { state: 'blocked', policy: decision ?? a.policy, error: why, time: 'decided' })
  ctx.db.run(`UPDATE actions SET recon_state = 'not_applicable' WHERE id = ?`, a.id)
  return finishWithReceipt(ctx, getAction(ctx.db, next.id)!)
}

/** Advance one action as far as it can go right now. Safe to call repeatedly and after a restart. */
/** One action, one step further, with every sentence it writes in the home currency of the household it belongs to. */
export async function stepAction(ctx: Ctx, id: string): Promise<ActionRow> {
  const owner = ctx.db.get<{ user_id: string }>('SELECT user_id FROM actions WHERE id = ?', id)?.user_id
  return owner ? withHome(ctx.db, owner, () => stepActionInHome(ctx, id)) : stepActionInHome(ctx, id)
}
async function stepActionInHome(ctx: Ctx, id: string): Promise<ActionRow> {
  let a = getAction(ctx.db, id)
  if (!a) throw new Error(`action ${id} not found`)
  // A reported problem holds what QED does on its own on that rail, until the person releases the pause (dispute-pause.ts).
  // The person's own approved payments are never held by it.
  if (a.kind === 'payment' && a.origin !== 'owner' && ['planned', 'held', 'awaiting_approval'].includes(a.state) && pausedFor(ctx.db, a.user_id, a.venue)) return a
  // a payment waiting until its terms' time: released and decided in one transaction, so its money is never free between.
  // Read again under the write lock: the owner may have cancelled it from the API (another process) since it was read.
  if (a.state === 'held') a = ctx.db.tx(() => { const held = getAction(ctx.db, id)!; if (held.state !== 'held') return held; const r = release(ctx, held); return r.state === 'planned' ? plan(ctx, r) : r })
  if (a.state === 'planned' || a.state === 'awaiting_approval') a = plan(ctx, a)
  if (a.state === 'submitting') a = submit(ctx, a)
  if (a.state === 'working') a = a.kind === 'order' ? settleOrder(ctx, a) : settlePayment(ctx, a)
  if (TERMINAL_ACTION.has(a.state) && !a.receipt_id) a = finishWithReceipt(ctx, a)
  return a
}

function plan(ctx: Ctx, a: ActionRow): ActionRow {
  const { db } = ctx
  const now = ctx.clock.now()
  const d = decide(ctx, a, now)
  if (!d.allowed) {
    if (d.needsApproval) return a.state === 'awaiting_approval' ? a : save(ctx, a, { state: 'awaiting_approval', policy: d })
    const failing = d.checks.filter((c) => !c.ok)
    // A payment to a new payee whose signed terms say it waits, and every other check passed: its money is set aside and
    // it waits until that time (new-payee.ts). Any other failing check refuses it as before.
    const h = holdOf(a)
    // a payment that repeats an earlier one waits for the person (duplicates.ts), together with any wait its terms give it
    if (a.state === 'planned' && failing.some((c) => c.name === 'duplicate-payment') && failing.every((c) => c.name === 'duplicate-payment' || (c.name === 'new-payee-wait' && h && now < h.until))) return holdRepeat(ctx, a, d, failing.find((c) => c.name === 'duplicate-payment')!.detail)
    if (a.state === 'planned' && h && now < h.until && failing.every((c) => c.name === 'new-payee-wait')) return hold(ctx, a, d, h)
    // A feed that has just reconnected delivers a fresh price within seconds. If stale data is the only thing in the
    // way, wait for it for a bounded time rather than refuse at once. Nothing is reserved or sent while waiting.
    if (a.state === 'planned' && failing.every((c) => c.transient) && now - startedAt(a) < DATA_WAIT_MS) {
      return a.result.waitingFor ? a : save(ctx, a, { result: { waitingFor: failing[0]!.detail, waitingSince: now } })
    }
    return refuse(ctx, a, d, failing[0]?.detail ?? 'Refused by policy.')
  }
  try {
    return db.tx(() => {
      // Read again under the write lock: a cancel from the API (another process) may have landed since it was decided.
      const current = getAction(db, a.id)!
      if (current.state !== a.state) return current
      // a payment another process asked for since it was decided counts as an earlier one (duplicates.ts)
      if (current.kind === 'payment' && current.origin === 'owner' && typeof current.result.duplicateConfirmedAt !== 'number') {
        const rep = repeatOf(db, current.user_id, current.params as PaymentParams, { id: current.id, createdAt: current.created_at })
        if (rep) return holdRepeat(ctx, current, d, repeatWords(rep, (current.params as PaymentParams).payeeName, whenIst(rep.askedAt)))
      }
      let params = a.params
      if (a.kind === 'order') {
        const p = { ...(a.params as OrderParams) }
        const inst = instrument(db, p.instrumentId)!
        ensurePosition(db, a.user_id, inst)
        if (p.side === 'sell') {
          let qty = p.sellAll ? available(db, a.user_id, posCode(inst)) : big(p.qty)
          if (inst.kind === 'crypto_spot') qty = floorToStep(qty, ctx.venues.crypto.rules(inst).step)
          else if (isSecurity(inst)) qty = floorToStep(qty, BigInt(inst.meta.qtyStep ?? '1'))
          if (qty <= 0n) throw new InsufficientFunds('Nothing is free to sell.')
          p.qty = qty.toString(); p.sellAll = false
          placeHold(db, a.user_id, posCode(inst), qty, 'Sale in progress', `act:${a.id}`, now)
        } else if (inst.kind === 'mutual_fund') {
          post(db, { userId: a.user_id, ts: now, kind: 'fund-purchase-paid', ref: `mf:${a.economic_id}:pay`, memo: `To buy ${inst.name}`, meta: { actionId: a.id, paper: true },
            lines: [{ account: 'clear:mf', amount: big(p.amount) }, { account: 'bank', amount: -big(p.amount) }] })
        } else {
          const need = p.amount ? big(p.amount) : buyCeiling(ctx, inst, p, big(p.qty))
          if (need === null) throw new AppError(409, 'no_price', 'No current price to size the order.')
          placeHold(db, a.user_id, 'bank', need, 'Purchase in progress', `act:${a.id}`, now)
        }
        params = p
      } else {
        const p = a.params as PaymentParams
        const total = big(p.amount) + big(p.charge)
        post(db, { userId: a.user_id, ts: now, kind: 'payment-sent', ref: `pay:${a.economic_id}:out`, memo: p.purpose === 'goal' ? `Set aside for ${p.payeeName}` : `To ${p.payeeName}${p.memo ? `: ${p.memo}` : ''}`, meta: { actionId: a.id, payee: p.payeeHandle, paper: true },
          lines: [{ account: 'clear:pay', amount: total }, { account: 'bank', amount: -total }] })
      }
      // An approval is spent the moment the action it covers starts. It cannot authorise anything else afterwards.
      if (a.origin === 'owner' && a.approval_id) db.run('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, a.approval_id)
      const s = save(ctx, a, { state: 'submitting', policy: d, params, time: 'decided' })
      return save(ctx, s, { time: 'submitting' })
    })
  } catch (e) {
    if (e instanceof AppError) return refuse(ctx, a, d, e.message)
    throw e
  }
}

/** When an action was asked for, for the checks on lateness: a payment that waited counts from when its wait ended. */
export const startedAt = (a: Pick<ActionRow, 'created_at' | 'times'>): number => a.times.released ?? a.created_at

/** The wait a payment's signed terms give it; only an owner's terms can (an instruction's payment never waits). */
export function holdOf(a: Pick<ActionRow, 'kind' | 'origin' | 'params'>): { until: number; why: string } | null {
  if (a.kind !== 'payment' || a.origin !== 'owner') return null
  const h = (a.params as PaymentParams).hold
  return h && typeof h.until === 'number' && Number.isFinite(h.until) ? h : null
}

/**
 * Start a payment's wait: its money set aside in the bank (a hold, so neither an instruction nor another payment can use
 * it), the approval spent (the action has started), the owner told with the way to cancel. Everything else was checked.
 */
function hold(ctx: Ctx, a: ActionRow, d: Decision, h: { until: number; why: string }): ActionRow {
  const { db } = ctx
  const now = ctx.clock.now()
  const p = a.params as PaymentParams
  const total = big(p.amount) + big(p.charge)
  try {
    return db.tx(() => {
      const current = getAction(db, a.id)!
      if (current.state !== a.state) return current
      placeHold(db, a.user_id, 'bank', total, `Payment to ${p.payeeName}, waiting until ${whenIst(h.until)}`, `act:${a.id}`, now)
      if (a.approval_id) db.run('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, a.approval_id)
      // the wait is what its terms say, so the check is met by waiting: recorded as passed, never read as a refusal
      const waiting: Decision = { ...d, checks: d.checks.map((c) => (c.name === 'new-payee-wait' ? { ...c, ok: true } : c)) }
      const s = save(ctx, a, { state: 'held', policy: waiting, time: 'held' })
      notice(db, a.user_id, { level: 'info', kind: 'payment-held', title: `${homeMoneyExact(total)} to ${p.payeeName} waits until ${whenIst(h.until)}`, body: `${h.why} The money is set aside until then. If you did not mean it, or anyone pressed you to pay, cancel it on its record.`, subject: a.id, dedupe: `held:${a.id}` }, now)
      audit(db, now, a.user_id, 'owner', 'action.held', a.id, { until: h.until })
      return s
    })
  } catch (e) {
    if (e instanceof AppError) return refuse(ctx, a, d, e.message)
    throw e
  }
}

/**
 * A payment that repeats an earlier one: its money set aside, its approval spent, the person told, and nothing sent until the
 * person confirms it (confirmRepeat) or cancels it. Every other check passed, or the caller would have refused it.
 */
function holdRepeat(ctx: Ctx, a: ActionRow, d: Decision, why: string): ActionRow {
  const { db } = ctx
  const now = ctx.clock.now()
  const p = a.params as PaymentParams
  const total = big(p.amount) + big(p.charge)
  try {
    return db.tx(() => {
      const current = getAction(db, a.id)!
      if (current.state !== a.state) return current
      placeHold(db, a.user_id, 'bank', total, `Payment to ${p.payeeName}, waiting for your confirmation`, `act:${a.id}`, now)
      if (a.approval_id) db.run('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, a.approval_id)
      const waiting: Decision = { ...d, checks: d.checks.map((c) => (c.name === 'duplicate-payment' || c.name === 'new-payee-wait' ? { ...c, ok: true } : c)) }
      const s = save(ctx, a, { state: 'held', policy: waiting, time: 'held', result: { awaitingConfirmation: { since: now, why, expiresAt: now + DUPLICATE_CONFIRM_BY_MS } } })
      notice(db, a.user_id, { level: 'info', kind: 'payment-held', title: `${homeMoneyExact(total)} to ${p.payeeName} waits for your confirmation`, body: `${why} The money is set aside until you decide.`, subject: a.id, dedupe: `held:${a.id}` }, now)
      audit(db, now, a.user_id, 'owner', 'action.held', a.id, { awaitingConfirmation: true })
      return s
    })
  } catch (e) {
    if (e instanceof AppError) return refuse(ctx, a, d, e.message)
    throw e
  }
}

/** The 48 hours passed with no answer: nothing was sent, and the money set aside is free again. */
function expireRepeat(ctx: Ctx, a: ActionRow): ActionRow {
  const now = ctx.clock.now()
  releaseHold(ctx.db, a.user_id, `act:${a.id}`, now)
  const s = save(ctx, a, { state: 'cancelled', error: 'It repeated an earlier payment and was not confirmed within 48 hours, so it was cancelled. Nothing was sent, and the money set aside for it is free again.', time: 'finished' })
  ctx.db.run(`UPDATE actions SET recon_state = 'not_applicable' WHERE id = ?`, a.id)
  resolveNotices(ctx.db, a.user_id, `held:${a.id}`, now)
  audit(ctx.db, now, a.user_id, 'owner', 'action.cancel', a.id, { unconfirmedRepeat: true })
  return s
}

/**
 * The person confirms a payment held as a repeat, from a session the caller has checked holds a fresh passkey confirmation.
 * It is sent at the next step, which the caller takes. Confirming twice, or a payment not held for this, is refused.
 */
export function confirmRepeat(ctx: Ctx, userId: string, id: string): ActionRow {
  return ctx.db.tx(() => {
    const a = getAction(ctx.db, id)
    if (!a || a.user_id !== userId) throw new AppError(404, 'not_found', 'That payment was not found.')
    if (a.state !== 'held' || !a.result.awaitingConfirmation) throw new AppError(409, 'not_waiting', 'That payment is not waiting for your confirmation.')
    if (typeof a.result.duplicateConfirmedAt === 'number') return a
    const now = ctx.clock.now()
    audit(ctx.db, now, userId, 'owner', 'action.confirm-repeat', id, {})
    return save(ctx, a, { result: { duplicateConfirmedAt: now } })
  })
}

/**
 * End a payment's wait when its time has come: the money set aside is released for the payment itself, which is then
 * decided and sent at once (the caller does both in one transaction). While QED is paused it keeps waiting, past its time,
 * until the owner resumes or cancels it: the pause holds it. Never before its time, whatever asks.
 */
function release(ctx: Ctx, a: ActionRow): ActionRow {
  const now = ctx.clock.now()
  const h = holdOf(a)
  if (h && now < h.until) return a
  // waiting for the person's confirmation of a repeat: never released unconfirmed while the earlier payment stands; cancelled
  // with nothing sent when 48 hours pass; sent on, with no wait, when the earlier payment ended unsent meanwhile
  const w = a.result.awaitingConfirmation as { expiresAt: number } | undefined
  if (w && typeof a.result.duplicateConfirmedAt !== 'number' && repeatOf(ctx.db, a.user_id, a.params as PaymentParams, { id: a.id, createdAt: a.created_at })) {
    return now >= w.expiresAt ? expireRepeat(ctx, a) : a
  }
  const paused = ctx.db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', a.user_id)?.stop_at
  if (paused) return a.result.pausedWhenDue ? a : save(ctx, a, { result: { pausedWhenDue: now } })
  releaseHold(ctx.db, a.user_id, `act:${a.id}`, now)
  resolveNotices(ctx.db, a.user_id, `held:${a.id}`, now)
  return save(ctx, a, { state: 'planned', time: 'released' })
}

function submit(ctx: Ctx, a: ActionRow): ActionRow {
  if (a.kind === 'order') {
    const p = a.params as OrderParams
    const inst = instrument(ctx.db, p.instrumentId)!
    const req: OrderRequest = {
      clientRef: a.economic_id, userId: a.user_id, instrumentId: p.instrumentId, side: p.side, type: p.type,
      ...(p.qty ? { qty: big(p.qty) } : {}), ...(p.amount ? { amount: big(p.amount) } : {}),
      ...(p.limitPrice ? { limitPrice: p.limitPrice } : {}), ...(p.stopPrice ? { stopPrice: p.stopPrice } : {}), ...(p.maxSlippageBps !== undefined ? { maxSlippageBps: p.maxSlippageBps } : {}),
      // a resting order's time, read from the signed terms; an order whose terms carry none (placed before expiry existed) stands until cancelled
      ...(p.validity && p.validity.kind !== 'gtc' ? { expiresAt: p.validity.expiresAt } : {}),
    }
    const vo = venueFor(ctx, inst).submit(req)
    return save(ctx, a, { state: 'working', result: { venueOrderId: vo.id, venueState: vo.state, ...(inst.kind === 'mutual_fund' ? { registrarAt: vo.createdAt } : {}) }, time: 'submitted', attempt: a.attempt + 1 })
  }
  const p = a.params as PaymentParams
  const vp = ctx.venues.rail.submit({ clientRef: a.economic_id, userId: a.user_id, payeeHandle: p.payeeHandle, amount: big(p.amount) + big(p.charge), ...(p.rail ? { rail: p.rail } : {}) })
  // the rail's bound, kept with the payment so its card can say by when an answer comes (R12 task comparison, gap 11)
  return save(ctx, a, { state: 'working', result: { railPaymentId: vp.id, rail: vp.rail, railState: vp.state, railReference: vp.reference, answerBy: ctx.venues.rail.answerBy(vp.rail, vp.createdAt) }, time: 'submitted', attempt: a.attempt + 1 })
}

const entryExists = (db: Db, userId: string, ref: string): boolean => !!db.get('SELECT 1 FROM entries WHERE user_id = ? AND ref = ?', userId, ref)
const qtyText = (qty: bigint, inst: Instrument): string => (Number(qty) / 10 ** inst.baseScale).toLocaleString('en-IN', { maximumFractionDigits: inst.baseScale })
const priceText = (price: string): string => `₹${Number(price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** Post one venue fill to the ledger, exactly once. */
function bookFill(ctx: Ctx, a: ActionRow, inst: Instrument, vo: VenueOrder, f: VenueFill): void {
  const { db } = ctx
  const ref = `fill:${f.id}`
  if (entryExists(db, a.user_id, ref)) return
  const now = ctx.clock.now()
  const pos = posCode(inst), tradeBase = `trade:${inst.base_asset}`
  const meta = { actionId: a.id, venue: vo.venue, venueOrderId: vo.id, fillId: f.id, price: f.price, snapshotId: f.snapshotId, navDate: f.effectiveDate, paper: true }
  db.tx(() => {
    if (vo.side === 'buy' && inst.kind === 'mutual_fund') {
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'fund-units-allotted', ref, memo: `${qtyText(f.qty, inst)} units of ${inst.name} at NAV ₹${f.price} of ${f.effectiveDate}`, meta,
        lines: [{ account: pos, amount: f.qty }, { account: tradeBase, amount: -f.qty }, { account: 'trade:INR', amount: f.amount }, { account: 'exp:stamp', amount: f.tax }, { account: 'clear:mf', amount: -(f.amount + f.tax) }] })
      openLot(db, a.user_id, inst.id, f.qty, f.amount + f.tax, f.ts, e.id)
    } else if (vo.side === 'buy' && isSecurity(inst)) {
      // a share, an ETF unit, a bill or a bond: price, then the fee and the stamp duty, all out of the bank now
      const cash = f.amount + f.fee + f.tax
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'buy', ref, memo: `Bought ${qtyText(f.qty, inst)} ${unitWord(inst)} of ${inst.name} at ${priceText(f.price)}`, meta, consumeHolds: [{ ref: `act:${a.id}`, amount: cash }],
        lines: [{ account: pos, amount: f.qty }, { account: tradeBase, amount: -f.qty }, { account: 'trade:INR', amount: f.amount }, { account: 'exp:fees', amount: f.fee }, { account: 'exp:stamp', amount: f.tax }, { account: 'bank', amount: -cash }] })
      openLot(db, a.user_id, inst.id, f.qty, cash, f.ts, e.id)
    } else if (vo.side === 'buy') {
      const cash = f.amount + f.fee
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'buy', ref, memo: `Bought ${qtyText(f.qty, inst)} ${inst.base_asset} at ${priceText(f.price)}`, meta, consumeHolds: [{ ref: `act:${a.id}`, amount: cash }],
        lines: [{ account: pos, amount: f.qty }, { account: tradeBase, amount: -f.qty }, { account: 'trade:INR', amount: f.amount }, { account: 'exp:fees', amount: f.fee }, { account: 'bank', amount: -cash }] })
      openLot(db, a.user_id, inst.id, f.qty, cash, f.ts, e.id)
    } else if (inst.kind === 'mutual_fund') {
      const net = f.amount - f.fee
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'fund-units-redeemed', ref, memo: `Redeemed ${qtyText(f.qty, inst)} units of ${inst.name} at NAV ₹${f.price} of ${f.effectiveDate}`, meta, consumeHolds: [{ ref: `act:${a.id}`, amount: f.qty }],
        lines: [{ account: tradeBase, amount: f.qty }, { account: pos, amount: -f.qty }, { account: 'recv:mf', amount: net }, { account: 'exp:fees', amount: f.fee }, { account: 'trade:INR', amount: -f.amount }] })
      consumeLots(db, a.user_id, inst.id, f.qty, net, f.ts, e.id)
    } else if (isSecurity(inst)) {
      // proceeds are due from the desk until the settlement day (recv:mf, "on their way"), as a fund redemption's are
      const net = f.amount - f.fee
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'sell', ref, memo: `Sold ${qtyText(f.qty, inst)} ${unitWord(inst)} of ${inst.name} at ${priceText(f.price)}`, meta, consumeHolds: [{ ref: `act:${a.id}`, amount: f.qty }],
        lines: [{ account: tradeBase, amount: f.qty }, { account: pos, amount: -f.qty }, { account: 'recv:mf', amount: net }, { account: 'exp:fees', amount: f.fee }, { account: 'trade:INR', amount: -f.amount }] })
      consumeLots(db, a.user_id, inst.id, f.qty, net, f.ts, e.id)
    } else {
      const net = f.amount - f.fee - f.tax
      const e = post(db, { userId: a.user_id, ts: now, effectiveTs: f.ts, kind: 'sell', ref, memo: `Sold ${qtyText(f.qty, inst)} ${inst.base_asset} at ${priceText(f.price)}`, meta, consumeHolds: [{ ref: `act:${a.id}`, amount: f.qty }],
        lines: [{ account: tradeBase, amount: f.qty }, { account: pos, amount: -f.qty }, { account: 'bank', amount: net }, { account: 'exp:fees', amount: f.fee }, { account: 'tds', amount: f.tax }, { account: 'trade:INR', amount: -f.amount }] })
      consumeLots(db, a.user_id, inst.id, f.qty, f.amount - f.fee, f.ts, e.id)
    }
  })
}

const paiseText = (p: bigint): string => homeMoney(Number(p), undefined, { paise: true })

/** An expired order, in plain words: what stood until when, what had filled before, and what is free again. */
function expiryNotice(ctx: Ctx, a: ActionRow, inst: Instrument, vo: VenueOrder, moved: bigint, remaining: bigint, expiredAt: number): void {
  const filled = vo.filledQty > 0n
  const before = filled ? `Before then ${qtyText(vo.filledQty, inst)} ${inst.base_asset} filled${vo.side === 'buy' ? `, which cost ${paiseText(moved)}` : `, which brought in ${paiseText(moved)}`}.` : 'Nothing had filled.'
  const freed = vo.side === 'buy' ? `${paiseText(remaining)} that was set aside for it is free again.` : `${qtyText(remaining, inst)} ${inst.base_asset} that was set aside for it is free to use again.`
  notice(ctx.db, a.user_id, { level: 'info', kind: 'order-expired', title: `${describe(ctx, a)}: expired`, body: `It stood until ${whenIst(expiredAt)}. ${before} ${freed}`, subject: a.id, dedupe: `expired:${a.id}` }, ctx.clock.now())
}

export function settleOrder(ctx: Ctx, a: ActionRow): ActionRow {
  const { db } = ctx
  const p = a.params as OrderParams
  const inst = instrument(db, p.instrumentId)!
  const vo = venueFor(ctx, inst).get(a.economic_id)
  if (!vo) return save(ctx, a, { state: 'submitting', error: 'The venue has no record of the order; submitting again with the same reference.' })
  for (const f of vo.fills) bookFill(ctx, a, inst, vo, f)
  const now = ctx.clock.now()
  let payoutPending = false
  if ((inst.kind === 'mutual_fund' || isSecurity(inst)) && vo.side === 'sell') {
    for (const f of vo.fills) {
      if (!f.cashDone) { payoutPending = true; continue }
      const ref = `cash:${f.id}`
      if (!entryExists(db, a.user_id, ref)) post(db, { userId: a.user_id, ts: now, effectiveTs: f.cashAt ?? now, kind: inst.kind === 'mutual_fund' ? 'fund-redemption-paid' : 'sale-settled', ref, memo: inst.kind === 'mutual_fund' ? `Redemption of ${inst.name} paid out` : `Sale of ${inst.name} settled`, meta: { actionId: a.id, fillId: f.id, paper: true },
        lines: [{ account: 'bank', amount: f.amount - f.fee }, { account: 'recv:mf', amount: -(f.amount - f.fee) }] })
    }
  }
  const moved = vo.side === 'buy' ? (inst.kind === 'mutual_fund' ? vo.filledAmount + vo.taxes : isSecurity(inst) ? vo.filledAmount + vo.fees + vo.taxes : vo.filledAmount + vo.fees) : vo.filledAmount - vo.fees - vo.taxes
  const result = {
    venueState: vo.state, filledQty: vo.filledQty.toString(), filledAmount: vo.filledAmount.toString(), fees: vo.fees.toString(), taxes: vo.taxes.toString(), movedPaise: moved.toString(),
    fills: vo.fills.length, rejectReason: vo.rejectReason, navEntitledFrom: vo.meta.minNavDate ?? null, venueNote: vo.meta.lastNote ?? null,
    payoutAt: vo.fills.find((f) => !f.cashDone)?.cashAt ?? null,
    // a fund order's states with the registrar's own times: with the registrar, money received (a purchase), and the
    // units allotted or redeemed at the NAV for a day (R12 task comparison, T4-d)
    // (and the cut-off the money or the request met, which is why its NAV is for the day it is)
    ...(inst.kind === 'mutual_fund' ? { registrarAt: vo.createdAt, fundsAt: vo.fundsAt, allottedAt: vo.fills[0]?.ts ?? null, navDate: vo.fills[0]?.effectiveDate ?? null, navPrice: vo.fills[0]?.price ?? null, cutoff: vo.meta.cutoff ?? null, beforeCutoff: vo.meta.beforeCutoff ?? null } : {}),
  }
  if (!TERMINAL_ORDER.has(vo.state) || payoutPending) {
    const changed = j(result) !== j(Object.fromEntries(Object.keys(result).map((k) => [k, a.result[k]])))
    const next = vo.fills.length && !a.times.executed ? save(ctx, a, { result, time: 'executed' }) : changed ? save(ctx, a, { result }) : a
    // the registrar's record moved while the action is still working (the money arrived; units were redeemed and the
    // money is on its way): say so, so the record and Home follow it as it happens, not at the next unrelated change
    if (a.result.venueState !== vo.state) emit(db, now, a.user_id, 'action', { id: a.id, state: next.state, venueState: vo.state })
    return next
  }
  return db.tx(() => {
    // Read the action again under the write lock: the engine and an API cancel may settle it at the same moment. The one that
    // comes second finds it finished and changes nothing, so it can neither strip what the first recorded nor audit a second ending.
    const current = getAction(db, a.id)
    if (!current || TERMINAL_ACTION.has(current.state)) return current ?? a
    a = current
    // What the order still had reserved, read just before it is freed: after an expiry that is the unfilled remainder only
    // (every fill used up its own part of the reservation when it was booked), and it is freed, and said, exactly once.
    const open = db.get<{ t: string }>('SELECT amount_text t FROM holds WHERE user_id = ? AND ref = ? AND released_at IS NULL', a.user_id, `act:${a.id}`)
    const remaining = open ? fromAmountText(open.t, `the reservation act:${a.id}`) : 0n
    releaseHold(db, a.user_id, `act:${a.id}`, now)
    if (vo.state === 'expired') {
      const expiredAt = typeof vo.meta.expiredAt === 'number' ? vo.meta.expiredAt : now
      Object.assign(result, { expired: true, expiredAt, ...(vo.side === 'buy' ? { releasedPaise: remaining.toString() } : { releasedQty: remaining.toString() }) })
      expiryNotice(ctx, a, inst, vo, moved, remaining, expiredAt)
    }
    if (inst.kind === 'mutual_fund' && vo.side === 'buy' && vo.filledQty === 0n) {
      post(db, { userId: a.user_id, ts: now, kind: 'fund-purchase-returned', ref: `mf:${a.economic_id}:refund`, memo: `Money returned: ${inst.name} order was not accepted`, meta: { actionId: a.id, paper: true },
        lines: [{ account: 'bank', amount: big(p.amount) }, { account: 'clear:mf', amount: -big(p.amount) }] })
    }
    // an expiry after a part fill is a partly done order, as a cancel after one is (money moved; `result.expired` says why it ended)
    const state: ActionState = vo.state === 'filled' ? 'done' : vo.state === 'partially_filled' ? 'partial' : vo.state === 'rejected' ? 'rejected' : vo.state === 'expired' ? (vo.filledQty > 0n ? 'partial' : 'expired') : 'cancelled'
    const withTime = a.times.executed || vo.fills.length === 0 ? a : save(ctx, a, { time: 'executed' })
    return save(ctx, withTime, { state, result, error: vo.rejectReason, time: 'finished' })
  })
}

/** Where a settled payment lands in the books. */
export function paymentLines(p: PaymentParams): { account: string; amount: bigint }[] {
  const amount = big(p.amount), charge = big(p.charge)
  const dest = p.purpose === 'card' ? 'card' : p.purpose === 'loan:personal' ? 'loan:personal' : p.purpose === 'loan:home' ? 'loan:home' : p.purpose === 'fd' ? 'fd' : p.purpose === 'goal' && p.goalId ? goalAccount(p.goalId) : 'exp:spend'
  const lines = [{ account: dest, amount }, { account: 'clear:pay', amount: -(amount + charge) }]
  if (charge > 0n) lines.push({ account: 'exp:fees', amount: charge })
  return lines
}

function settlePayment(ctx: Ctx, a: ActionRow): ActionRow {
  const { db } = ctx
  const p = a.params as PaymentParams
  const vp = ctx.venues.rail.get(a.economic_id)
  if (!vp) return save(ctx, a, { state: 'submitting', error: 'The rail has no record of the payment; submitting again with the same reference.' })
  const now = ctx.clock.now()
  const result = { rail: vp.rail, railState: vp.state, railReference: vp.reference, railReason: vp.reason, movedPaise: (big(p.amount) + big(p.charge)).toString(), railNote: vp.meta.test ?? vp.meta.batch ?? null }
  if (vp.state === 'settled' || vp.state === 'reversed') {
    return db.tx(() => {
      // a contribution lands in its goal's set-aside, opened on the first one (server/setaside.ts)
      if (p.purpose === 'goal' && p.goalId) ensureGoalAccount(db, a.user_id, p.goalId, p.payeeName)
      post(db, { userId: a.user_id, ts: now, effectiveTs: vp.updatedAt, kind: 'payment-settled', ref: `pay:${a.economic_id}:settle`, memo: p.purpose === 'goal' ? `Set aside for ${p.payeeName}` : `Paid ${p.payeeName}${p.memo ? `: ${p.memo}` : ''}`, meta: { actionId: a.id, payee: p.payeeHandle, purpose: p.purpose, rail: vp.rail, railReference: vp.reference, paper: true }, lines: paymentLines(p) })
      if (p.billId) db.run(`UPDATE bills SET state = 'paid', action_id = ? WHERE id = ? AND user_id = ?`, a.id, p.billId, a.user_id)
      const s = save(ctx, a, { result, time: 'executed' })
      return save(ctx, s, { state: 'done', time: 'finished' })
    })
  }
  if (vp.state === 'failed') {
    return db.tx(() => {
      const total = big(p.amount) + big(p.charge)
      post(db, { userId: a.user_id, ts: now, effectiveTs: vp.updatedAt, kind: 'payment-returned', ref: `pay:${a.economic_id}:return`, memo: `Returned: payment to ${p.payeeName} did not go through`, meta: { actionId: a.id, reason: vp.reason, paper: true },
        lines: [{ account: 'bank', amount: total }, { account: 'clear:pay', amount: -total }] })
      if (p.billId) db.run(`UPDATE bills SET state = 'due', action_id = NULL WHERE id = ? AND user_id = ?`, p.billId, a.user_id)
      return save(ctx, a, { state: 'failed', result, error: vp.reason, time: 'finished' })
    })
  }
  return a.result.railState === vp.state ? a : save(ctx, a, { result })
}

/** Compare one finished action with the venue's own record. Anything that does not match is a break. */
/**
 * What an order cost against its reference (R7-096): the best price on the side it filled, on the book it filled against
 * (or the NAV it executed at), with that book's source and age; the mid and spread; the average fill and how far it was
 * from the reference (positive = worse for the owner); the fee and tax; what was delivered; and the money the ledger
 * moved for these fills, against what the fills and their fees and tax come to.
 */
export interface Costs {
  reference: { kind: 'book' | 'nav'; price: number; mid: number | null; spreadBps: number | null; source: string | null; receivedAt: number | null; ageMsAtExecution: number | null; navDate: string | null }
  averagePrice: number; slippageBps: number | null; fee: string; tax: string; deliveredQty: string; filledAmount: string
  cashAccount: string; cashExpected: string; cashBooked: string; feeBooked: string; taxBooked: string; ledgerAgrees: boolean
}
export function costsOf(db: Db, userId: string, inst: Instrument, vo: VenueOrder): Costs | null {
  if (!vo.fills.length) return null
  const sum = (k: 'qty' | 'amount' | 'fee' | 'tax'): bigint => vo.fills.reduce((s, f) => s + f[k], 0n)
  const qty = sum('qty'), amount = sum('amount'), fee = sum('fee'), tax = sum('tax')
  const snap = parse<Record<string, unknown>>(vo.fills[0]!.snapshotId ? db.get<{ body_json: string }>('SELECT body_json FROM snapshots WHERE id = ?', vo.fills[0]!.snapshotId)?.body_json : undefined, {})
  const fund = inst.kind === 'mutual_fund'
  const avg = qty > 0n ? Number(amount) / 100 / (Number(qty) / 10 ** inst.baseScale) : 0
  let reference: Costs['reference']
  if (fund) reference = { kind: 'nav', price: Number(snap.nav ?? vo.fills[0]!.price), mid: null, spreadBps: null, source: (snap.source as string | undefined) ?? null, receivedAt: (snap.receivedAt as number | undefined) ?? null, ageMsAtExecution: null, navDate: (snap.navDate as string | undefined) ?? null }
  else {
    const top = (side: unknown): number | null => (Array.isArray(side) && side[0] ? Number((side[0] as { price: string }).price) : null)
    const bid = top(snap.bids), ask = top(snap.asks)
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null
    reference = { kind: 'book', price: (vo.side === 'buy' ? ask : bid) ?? 0, mid, spreadBps: mid && bid !== null && ask !== null ? Math.round(((ask - bid) / mid) * 100_000) / 10 : null, source: (snap.provider as string | undefined) ?? null, receivedAt: (snap.recvTs as number | undefined) ?? null, ageMsAtExecution: (snap.ageMsAtExecution as number | undefined) ?? null, navDate: null }
  }
  const slippageBps = reference.price > 0 ? Math.round(((vo.side === 'buy' ? avg - reference.price : reference.price - avg) / reference.price) * 100_000) / 10 : null
  // The money each kind of fill moves, as the fills say it should (the bookings in bookFill), and what the ledger moved.
  const sec = isSecurity(inst)
  const cashAccount = fund ? (vo.side === 'buy' ? 'clear:mf' : 'recv:mf') : sec ? (vo.side === 'buy' ? 'bank' : 'recv:mf') : 'bank'
  const cashExpected = fund ? (vo.side === 'buy' ? -(amount + tax) : amount - fee) : sec ? (vo.side === 'buy' ? -(amount + fee + tax) : amount - fee) : (vo.side === 'buy' ? -(amount + fee) : amount - fee - tax)
  const taxAccount = fund || sec ? 'exp:stamp' : 'tds'
  const refs = vo.fills.map((f) => `fill:${f.id}`)
  const booked = (code: string): bigint => fromAmountText(db.get<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts ac ON ac.id = p.account_id WHERE e.user_id = ? AND ac.code = ? AND e.ref IN (${refs.map(() => '?').join(',')})`, userId, code, ...refs)?.s, `what the ledger booked to ${code}`)
  const cashBooked = booked(cashAccount), feeBooked = booked('exp:fees'), taxBooked = (fund || sec) && vo.side === 'sell' ? 0n : booked(taxAccount)
  const taxExpected = (fund || sec) && vo.side === 'sell' ? 0n : tax
  const feeExpected = fund && vo.side === 'buy' ? 0n : fee
  return {
    reference, averagePrice: Math.round(avg * 100) / 100, slippageBps, fee: fee.toString(), tax: tax.toString(), deliveredQty: qty.toString(), filledAmount: amount.toString(),
    cashAccount, cashExpected: cashExpected.toString(), cashBooked: cashBooked.toString(), feeBooked: feeBooked.toString(), taxBooked: taxBooked.toString(),
    ledgerAgrees: cashBooked === cashExpected && feeBooked === feeExpected && taxBooked === taxExpected,
  }
}

export function reconcileAction(ctx: Ctx, a: ActionRow): { state: 'reconciled' | 'break' | 'not_applicable'; breaks: string[]; entries: number[] } {
  const { db } = ctx
  const breaks: string[] = []
  const entrySeqs = (refs: string[]): number[] => refs.map((r) => db.get<{ seq: number }>('SELECT seq FROM entries WHERE user_id = ? AND ref = ?', a.user_id, r)?.seq).filter((x): x is number => typeof x === 'number')
  // Nothing reached a venue, so there is no venue record to compare with.
  if (a.state === 'blocked' || !a.times.submitted) return { state: 'not_applicable', breaks, entries: [] }
  if (a.kind === 'order') {
    const p = a.params as OrderParams
    const inst = instrument(db, p.instrumentId)!
    const vo = venueFor(ctx, inst).get(a.economic_id)
    if (!vo) return { state: 'break', breaks: ['The venue has no record of this order.'], entries: [] }
    const refs = vo.fills.map((f) => `fill:${f.id}`)
    for (const f of vo.fills) if (!entryExists(db, a.user_id, `fill:${f.id}`)) breaks.push(`Venue fill ${f.id} is not in the ledger.`)
    // ltrim(…, '-') is the absolute value of canonical integer text, exactly.
    const booked = fromAmountText(db.get<{ s: string }>(
      `SELECT amount_sum(ltrim(p.amount_text, '-')) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts ac ON ac.id = p.account_id WHERE e.user_id = ? AND ac.code = ? AND e.ref IN (${refs.map(() => '?').join(',') || "''"})`,
      a.user_id, posCode(inst), ...refs)?.s, `the quantity booked for ${a.id}`)
    if (booked !== vo.filledQty) breaks.push(`The ledger shows ${booked} atoms for this order; the venue shows ${vo.filledQty}.`)
    if (db.get('SELECT 1 FROM holds WHERE user_id = ? AND ref = ? AND released_at IS NULL', a.user_id, `act:${a.id}`)) breaks.push('A reservation for this order is still open.')
    // The money, fee and tax the ledger moved for these fills, against what the fills come to (R7-096).
    const c = vo.fills.every((f) => entryExists(db, a.user_id, `fill:${f.id}`)) ? costsOf(db, a.user_id, inst, vo) : null
    if (c && !c.ledgerAgrees) breaks.push(`For this order the ledger moved ${c.cashBooked} paise in ${c.cashAccount}, ${c.feeBooked} in fees and ${c.taxBooked} in tax; its fills come to ${c.cashExpected}, ${c.fee} and ${c.tax}.`)
    const extra = inst.kind === 'mutual_fund' ? [`mf:${a.economic_id}:pay`, `mf:${a.economic_id}:refund`, ...vo.fills.map((f) => `cash:${f.id}`)] : isSecurity(inst) ? vo.fills.map((f) => `cash:${f.id}`) : []
    if (inst.kind === 'mutual_fund' && vo.side === 'buy') {
      const clr = fromAmountText(db.get<{ s: string }>(
        `SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts ac ON ac.id = p.account_id WHERE e.user_id = ? AND ac.code = 'clear:mf' AND e.ref IN (${[...refs, ...extra].map(() => '?').join(',')})`,
        a.user_id, ...refs, ...extra)?.s, `fund clearing for ${a.id}`)
      if (clr !== 0n) breaks.push(`Fund clearing for this order is off by ${clr} paise.`)
    }
    return { state: breaks.length ? 'break' : 'reconciled', breaks, entries: entrySeqs([...refs, ...extra]) }
  }
  const vp = ctx.venues.rail.get(a.economic_id)
  if (!vp) return { state: 'break', breaks: ['The rail has no record of this payment.'], entries: [] }
  const refs = [`pay:${a.economic_id}:out`, `pay:${a.economic_id}:settle`, `pay:${a.economic_id}:return`, `pay:${a.economic_id}:reversal`]
  const has = (suffix: string) => entryExists(db, a.user_id, `pay:${a.economic_id}:${suffix}`)
  if (!has('out')) breaks.push('The payment was sent but the ledger has no outgoing entry.')
  if ((vp.state === 'settled' || vp.state === 'reversed') && !has('settle')) breaks.push('The rail shows the payment settled; the ledger does not.')
  if (vp.state === 'failed' && !has('return')) breaks.push('The rail shows the payment failed; the money has not been returned in the ledger.')
  if (vp.state === 'reversed' && !has('reversal')) breaks.push('The rail reversed this payment; the ledger has not recorded the money coming back.')
  const clr = fromAmountText(db.get<{ s: string }>(
    `SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts ac ON ac.id = p.account_id WHERE e.user_id = ? AND ac.code = 'clear:pay' AND e.ref IN (?, ?, ?, ?)`, a.user_id, ...refs)?.s, `payment clearing for ${a.id}`)
  if (TERMINAL_PAYMENT.has(vp.state) && clr !== 0n) breaks.push(`Payment clearing for this payment is off by ${clr} paise.`)
  return { state: breaks.length ? 'break' : 'reconciled', breaks, entries: entrySeqs(refs) }
}

function describe(ctx: Ctx, a: ActionRow): string {
  if (a.kind === 'payment') { const p = a.params as PaymentParams; return p.purpose === 'goal' ? `Set aside ${homeMoneyExact(big(p.amount))} for ${p.payeeName}` : `Pay ${p.payeeName} ${homeMoneyExact(big(p.amount))}` }
  const p = a.params as OrderParams
  const inst = instrument(ctx.db, p.instrumentId)
  const size = p.amount ? `${homeMoneyExact(big(p.amount))} of` : `${p.qty ? (Number(p.qty) / 10 ** (inst?.baseScale ?? 0)).toString() : 'all'} ${inst?.base_asset.startsWith('MF:') ? 'units of' : inst?.base_asset ?? ''}`
  return `${p.side === 'buy' ? 'Buy' : 'Sell'} ${size} ${inst?.name ?? p.instrumentId}`.replace(/\s+/g, ' ')
}

/** Reconcile a finished action, then issue its receipt. A break is recorded and surfaced; it never blocks the receipt. */
function finishWithReceipt(ctx: Ctx, a: ActionRow): ActionRow {
  const { db } = ctx
  const now = ctx.clock.now()
  const rec = reconcileAction(ctx, a)
  const prog = a.program_id ? db.get<{ title: string; kind: string }>('SELECT title, kind FROM programs WHERE id = ?', a.program_id) : undefined
  const run = a.run_id ? db.get<{ version: number; occurrence: string }>('SELECT version, occurrence FROM runs WHERE id = ?', a.run_id) : undefined
  const ver = a.program_id && run ? db.get<{ content_hash: string }>('SELECT content_hash FROM program_versions WHERE program_id = ? AND version = ?', a.program_id, run.version) : undefined
  const approval = a.approval_id ? db.get<{ id: string; doc_hash: string; method: string | null; confirmed_at: number | null }>('SELECT id, doc_hash, method, confirmed_at FROM approvals WHERE id = ?', a.approval_id) : undefined
  let venue: Record<string, unknown> = {}
  let instrumentInfo: Record<string, unknown> | null = null
  let costs: Costs | null = null
  if (a.kind === 'order') {
    const p = a.params as OrderParams
    const inst = instrument(db, p.instrumentId)!
    instrumentInfo = { id: inst.id, name: inst.name, unit: inst.kind === 'mutual_fund' || isSecurity(inst) ? unitWord(inst) : inst.base_asset, scale: inst.baseScale }
    const vo = venueFor(ctx, inst).get(a.economic_id)
    costs = vo ? costsOf(db, a.user_id, inst, vo) : null
    venue = vo ? {
      name: vo.venue, clientRef: vo.clientRef, state: vo.state, rejectReason: vo.rejectReason,
      fills: vo.fills.map((f) => {
        const snap = f.snapshotId ? db.get<{ body_json: string }>('SELECT body_json FROM snapshots WHERE id = ?', f.snapshotId) : undefined
        const sb = snap ? (JSON.parse(snap.body_json) as Record<string, unknown>) : {}
        return { id: f.id, executedAt: f.ts, navDate: f.effectiveDate, qty: f.qty.toString(), price: f.price, amount: f.amount.toString(), fee: f.fee.toString(), tax: f.tax.toString(), cashAt: f.cashAt,
          evidence: { snapshotId: f.snapshotId, provider: sb.provider ?? sb.source ?? null, sourceTs: sb.sourceTs ?? null, receivedAt: sb.recvTs ?? sb.receivedAt ?? null, ageMsAtExecution: sb.ageMsAtExecution ?? null } }
      }),
    } : { name: a.venue, state: 'not submitted' }
  } else {
    const vp = ctx.venues.rail.get(a.economic_id)
    venue = vp ? { name: 'paper-rail', rail: vp.rail, clientRef: vp.clientRef, state: vp.state, reference: vp.reference, reason: vp.reason } : { name: a.venue, state: 'not submitted' }
  }
  const body = {
    what: describe(ctx, a), outcome: a.state, reason: a.error,
    origin: a.origin, program: prog && run ? { id: a.program_id, title: prog.title, kind: prog.kind, version: run.version, contentHash: ver?.content_hash ?? null, occurrence: run.occurrence, runId: a.run_id } : null,
    approval: approval ? { id: approval.id, documentHash: approval.doc_hash, method: approval.method, confirmedAt: approval.confirmed_at } : null,
    decision: { decidedAt: a.policy.decidedAt ?? null, checks: a.policy.checks ?? [] },
    ...(instrumentInfo ? { instrument: instrumentInfo } : {}), venue, ...(costs ? { costs } : {}), ledgerEntries: rec.entries, reconciliation: { state: rec.state, breaks: rec.breaks, checkedAt: now },
    times: { ...a.times, reconciled: now }, economicId: a.economic_id, params: a.params,
    ...(a.result.expired ? { expiry: { expiredAt: a.result.expiredAt, filledQty: a.result.filledQty, movedPaise: a.result.movedPaise, releasedPaise: a.result.releasedPaise ?? null, releasedQty: a.result.releasedQty ?? null } } : {}),
  }
  return db.tx(() => {
    const r = issueReceipt(db, a.user_id, a.state === 'blocked' ? 'refusal' : a.kind, a.id, body, now)
    db.run('UPDATE actions SET recon_state = ?, receipt_id = ?, times_json = ?, updated_at = ? WHERE id = ?', rec.state, r.id, j({ ...a.times, reconciled: now }), now, a.id)
    if (rec.state === 'break') notice(db, a.user_id, { level: 'action', kind: 'recon-break', title: 'A record does not match the venue', body: rec.breaks.join(' '), subject: a.id, dedupe: `recon:${a.id}` }, now)
    if ((a.state === 'failed' || a.state === 'rejected' || a.state === 'blocked') && a.origin === 'owner') {
      notice(db, a.user_id, { level: 'info', kind: `action-${a.state}`, title: `${describe(ctx, a)}: ${a.state === 'blocked' ? 'refused' : a.state}`, body: a.error ?? '', subject: a.id, dedupe: `action:${a.id}` }, now)
    }
    audit(db, now, a.user_id, a.origin === 'owner' ? 'owner' : 'engine', `action.${a.state}`, a.id, { receipt: r.id, recon: rec.state })
    return getAction(db, a.id)!
  })
}

/** Progress every unfinished action. One failure never stops the others. */
/** `keepGoing`: asked before each action; false (the engine is stopping) leaves the rest for the next pass. */
export async function stepAllActions(ctx: Ctx, keepGoing: () => boolean = () => true): Promise<number> {
  const rows = ctx.db.all<{ id: string }>(`SELECT id FROM actions WHERE state IN ('planned', 'submitting', 'working') OR (receipt_id IS NULL AND state NOT IN ('awaiting_approval')) ORDER BY created_at LIMIT 200`)
  let n = 0
  for (const r of rows) {
    if (!keepGoing()) break
    try { await stepAction(ctx, r.id); n++ }
    catch (e) {
      const a = getAction(ctx.db, r.id)
      if (a) ctx.db.run('UPDATE actions SET error = ?, updated_at = ? WHERE id = ?', `Step failed and will be retried: ${e instanceof Error ? e.message : String(e)}`, ctx.clock.now(), a.id)
    }
  }
  return n
}

/** The owner cancels something still in flight. Fills that already happened stay; the remainder is cancelled. */
export function cancelAction(ctx: Ctx, userId: string, id: string): ActionRow {
  // Read and cancel under the write lock (R13 section 4): the engine, another process, may release, send or cancel it
  // between a read outside the transaction and the write, and a payment on the rail must never be recorded as cancelled.
  const stopped = ctx.db.tx((): ActionRow | null => {
    const a = getAction(ctx.db, id)
    if (!a || a.user_id !== userId) throw new AppError(404, 'not_found', 'That action was not found.')
    if (TERMINAL_ACTION.has(a.state)) throw new AppError(409, 'already_finished', 'That action has already finished.')
    // a payment waiting until its terms' time: nothing has been sent, so it stops here and its money is free again
    if (a.state === 'held') {
      const now = ctx.clock.now()
      releaseHold(ctx.db, userId, `act:${a.id}`, now)
      save(ctx, a, { state: 'cancelled', error: 'Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.', time: 'finished' })
      ctx.db.run(`UPDATE actions SET recon_state = 'not_applicable' WHERE id = ?`, a.id)
      resolveNotices(ctx.db, userId, `held:${a.id}`, now)
      audit(ctx.db, now, userId, 'owner', 'action.cancel', id, { whileHeld: true })
      return getAction(ctx.db, a.id)!
    }
    if (a.state === 'planned' || a.state === 'awaiting_approval') {
      const s = save(ctx, a, { state: 'cancelled', error: 'Cancelled by you before it was submitted.', time: 'finished' })
      ctx.db.run(`UPDATE actions SET recon_state = 'not_applicable' WHERE id = ?`, a.id)
      return s
    }
    return null
  })
  if (stopped) return stopped
  const a = getAction(ctx.db, id)!
  if (a.kind === 'payment') throw new AppError(409, 'cannot_cancel', 'A payment that has reached the rail cannot be recalled. If it settles wrongly, raise a dispute.')
  const p = a.params as OrderParams
  const inst = instrument(ctx.db, p.instrumentId)!
  if (inst.kind === 'mutual_fund') throw new AppError(409, 'cannot_cancel', 'A fund order cannot be withdrawn after it reaches the registrar; it executes at the next applicable NAV.')
  venueFor(ctx, inst).cancel(a.economic_id)
  audit(ctx.db, ctx.clock.now(), userId, 'owner', 'action.cancel', id)
  return settleOrder(ctx, getAction(ctx.db, id)!)
}

export { parseDec, pow10 }
