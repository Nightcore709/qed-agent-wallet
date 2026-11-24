/**
 * Paper venues. Each keeps its own book (the pv_* tables) and is reached only through the functions below, the way
 * a broker, a fund registrar or a payment rail would be reached through its API. Nothing here touches the wallet's
 * ledger. No fill produced here was executed by an exchange, a fund house or a bank: every record is labelled paper.
 *
 *   PaperCryptoVenue  fills against the real INR order book fetched at the moment of execution: walks real depth,
 *                     applies the venue's own lot rules, a taker fee, and 1% TDS on sales; partial fills and
 *                     rejections follow from the book, not from chance.
 *   PaperFundVenue    a purchase is with the registrar at once; its money reaches the fund house a paper instant
 *                     transfer later (FUND_PAY_IN_MS), and the day it arrives, against the cut-off, sets the NAV day;
 *                     units are allotted at the first NAV the fund house actually publishes for that day. Redemptions
 *                     are with the registrar until their NAV, then pay out on a later business day.
 *   PaperRail         a payment rail model with per-rail limits and timings. Failure paths are reached by naming a
 *                     test payee (decline@paper, slow@paper, timeout@paper, reverse@paper), as provider sandboxes do.
 */
import { withAgentIdentity } from './agent-identity.ts'
import { addDays, type Clock, type Db, ist, istInstant, j, newId, parse } from './core.ts'
import { type Book, fetchCoindcxBook, type Market } from './market.ts'
import { type Instrument, instrument, term, termValue } from './registry.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { closedText, matured, securityCosts, sessionOf, settlementInstant } from './securities.ts'
import { floorToStep, fraction, mulDiv, notional, parseDec, parsePrice, pow10, PRICE_SCALE, quantityFor, toNum } from '../shared/fixed.ts'

export type Side = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop' | 'nav'
/** 'funded' (since schema v8) is a fund purchase whose money the fund house has received, waiting for its NAV. */
export type OrderState = 'new' | 'accepted' | 'funded' | 'filled' | 'partially_filled' | 'rejected' | 'cancelled' | 'expired'

export interface OrderRequest {
  clientRef: string; userId: string; instrumentId: string; side: Side; type: OrderType
  qty?: bigint; amount?: bigint; limitPrice?: string; stopPrice?: string; maxSlippageBps?: number; sellAll?: boolean
}
export interface VenueFill { id: string; ts: number; effectiveDate: string | null; qty: bigint; price: string; amount: bigint; fee: bigint; tax: bigint; cashAt: number | null; cashDone: boolean; snapshotId: string | null; note: string | null }
export interface VenueOrder {
  id: string; venue: string; clientRef: string; userId: string; instrumentId: string; side: Side; type: OrderType; qty: bigint | null; amount: bigint | null
  limitPrice: string | null; stopPrice: string | null; maxSlippageBps: number | null; state: OrderState; rejectReason: string | null
  filledQty: bigint; filledAmount: bigint; fees: bigint; taxes: bigint; createdAt: number; updatedAt: number; meta: Record<string, unknown>; fills: VenueFill[]
  /** When the fund house received a purchase's money (paper-mf buys); null before then, and for everything else. */
  fundsAt: number | null
}
export const TERMINAL_ORDER: ReadonlySet<OrderState> = new Set(['filled', 'partially_filled', 'rejected', 'cancelled', 'expired'])

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v ?? 0))))

function loadOrder(db: Db, row: Record<string, unknown>): VenueOrder {
  const fills = db.all<Record<string, unknown>>('SELECT * FROM pv_fills WHERE order_id = ? ORDER BY ts, id', String(row.id)).map((f): VenueFill => ({
    id: String(f.id), ts: Number(f.ts), effectiveDate: (f.effective_date as string | null) ?? null, qty: big(f.qty), price: String(f.price), amount: big(f.amount), fee: big(f.fee), tax: big(f.tax),
    cashAt: (f.cash_at as number | null) ?? null, cashDone: Number(f.cash_done) === 1, snapshotId: (f.snapshot_id as string | null) ?? null, note: (f.note as string | null) ?? null,
  }))
  return {
    id: String(row.id), venue: String(row.venue), clientRef: String(row.client_ref), userId: String(row.user_id), instrumentId: String(row.instrument_id), side: row.side as Side, type: row.type as OrderType,
    qty: row.qty === null ? null : big(row.qty), amount: row.amount === null ? null : big(row.amount), limitPrice: (row.limit_price as string | null) ?? null, stopPrice: (row.stop_price as string | null) ?? null,
    maxSlippageBps: (row.max_slippage_bps as number | null) ?? null, state: row.state as OrderState, rejectReason: (row.reject_reason as string | null) ?? null,
    filledQty: big(row.filled_qty), filledAmount: big(row.filled_amount), fees: big(row.fees), taxes: big(row.taxes), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    meta: parse<Record<string, unknown>>(row.meta_json, {}), fills, fundsAt: row.funds_at === null || row.funds_at === undefined ? null : Number(row.funds_at),
  }
}

/** What the venue's own book says the customer holds: fills only, independent of the wallet's ledger. */
export function venueHolding(db: Db, userId: string, instrumentId: string): bigint {
  const r = db.get<{ b: string; s: string }>(
    `SELECT amount_sum(CASE WHEN side = 'buy' THEN qty ELSE 0 END) b, amount_sum(CASE WHEN side = 'sell' THEN qty ELSE 0 END) s FROM pv_fills WHERE user_id = ? AND instrument_id = ?`, userId, instrumentId)
  return fromAmountText(r?.b, `the venue's bought ${instrumentId}`) - fromAmountText(r?.s, `the venue's sold ${instrumentId}`)
}
/** Quantity already promised to open sell orders at the venue. */
function venueOpenSells(db: Db, userId: string, instrumentId: string): bigint {
  const r = db.get<{ q: string }>(`SELECT amount_sum(qty - filled_qty) q FROM pv_orders WHERE user_id = ? AND instrument_id = ? AND side = 'sell' AND state IN ('new', 'accepted') AND qty IS NOT NULL`, userId, instrumentId)
  return fromAmountText(r?.q, `the open sells of ${instrumentId}`)
}

export abstract class OrderVenue {
  abstract name: string
  protected readonly db: Db
  protected readonly clock: Clock
  constructor(db: Db, clock: Clock) { this.db = db; this.clock = clock }

  get(clientRef: string): VenueOrder | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM pv_orders WHERE venue = ? AND client_ref = ?', this.name, clientRef)
    return row ? loadOrder(this.db, row) : undefined
  }
  /** `now`: the moment of acceptance, when the caller has already used it for something the order records (a pay-in's due time). */
  protected insert(req: OrderRequest, state: OrderState, rejectReason: string | null, meta: Record<string, unknown>, qty: bigint | null = req.qty ?? null, now: number = this.clock.now()): VenueOrder {
    this.db.run(`INSERT INTO pv_orders (id, venue, client_ref, user_id, instrument_id, side, type, qty, amount, limit_price, stop_price, max_slippage_bps, state, reject_reason, created_at, updated_at, meta_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('pvo', now), this.name, req.clientRef, req.userId, req.instrumentId, req.side, req.type, qty === null ? null : toNum(qty), req.amount === undefined ? null : toNum(req.amount),
      req.limitPrice ?? null, req.stopPrice ?? null, req.maxSlippageBps ?? null, state, rejectReason, now, now, j(meta))
    return this.get(req.clientRef)!
  }
  protected setState(id: string, state: OrderState, rejectReason: string | null = null, meta?: Record<string, unknown>): void {
    if (meta) this.db.run('UPDATE pv_orders SET state = ?, reject_reason = ?, updated_at = ?, meta_json = ? WHERE id = ?', state, rejectReason, this.clock.now(), j(meta), id)
    else this.db.run('UPDATE pv_orders SET state = ?, reject_reason = ?, updated_at = ? WHERE id = ?', state, rejectReason, this.clock.now(), id)
  }
  protected addFill(o: VenueOrder, f: Omit<VenueFill, 'id' | 'cashDone'>): void {
    this.db.run(`INSERT INTO pv_fills (id, order_id, user_id, instrument_id, side, ts, effective_date, qty, price, amount, fee, tax, cash_at, cash_done, snapshot_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('pvf', f.ts), o.id, o.userId, o.instrumentId, o.side, f.ts, f.effectiveDate, toNum(f.qty), f.price, toNum(f.amount), toNum(f.fee), toNum(f.tax), f.cashAt, f.cashAt === null ? 1 : 0, f.snapshotId, f.note)
    this.db.run('UPDATE pv_orders SET filled_qty = filled_qty + ?, filled_amount = filled_amount + ?, fees = fees + ?, taxes = taxes + ?, updated_at = ? WHERE id = ?',
      toNum(f.qty), toNum(f.amount), toNum(f.fee), toNum(f.tax), f.ts, o.id)
  }
  cancel(clientRef: string): VenueOrder | undefined {
    const o = this.get(clientRef)
    if (!o) return undefined
    if (!TERMINAL_ORDER.has(o.state)) this.setState(o.id, o.filledQty > 0n ? 'partially_filled' : 'cancelled', o.filledQty > 0n ? 'Cancelled after a partial fill' : 'Cancelled before any fill')
    return this.get(clientRef)
  }
  protected snapshot(instrumentId: string, kind: string, body: unknown): string {
    const id = newId('snap', this.clock.now())
    this.db.run('INSERT INTO snapshots (id, ts, instrument_id, kind, body_json) VALUES (?, ?, ?, ?, ?)', id, this.clock.now(), instrumentId, kind, j(body))
    return id
  }
}

// ---------------------------------------------------------------------------------------------- crypto spot

export interface MatchPiece { price: string; qty: bigint; amount: bigint }
export interface MatchResult { pieces: MatchPiece[]; filledQty: bigint; filledAmount: bigint; complete: boolean; stoppedBy: 'done' | 'price_limit' | 'depth' | 'no_liquidity' }

/**
 * Walk one side of a real order book. Buys take asks from the lowest price up, sells take bids from the highest
 * down, never beyond `bound` (the limit price or the slippage cap). Quantities respect the venue's step size.
 * `used` is depth this venue's own recent paper fills already took at a price, so the same displayed size is not sold twice.
 */
/**
 * The smallest rupee amount, in paise, that a market purchase must carry to be filled at all at `price`: the venue
 * fills whole steps of quantity and rejects a fill worth less than its minimum, and its fee comes out of the amount.
 * At ₹65,00,000 a bitcoin with steps of 0.00001, one step is ₹65: ₹100 buys one step, which is under a ₹100 minimum.
 */
export function smallestMarketBuy(r: { step: bigint; minNotional: bigint; feeRate: string }, inst: Instrument, price: string): bigint {
  const stepValue = notional(r.step, inst.baseScale, parsePrice(price), inst.quoteScale, 'up')
  if (stepValue <= 0n) return r.minNotional
  const steps = (r.minNotional + stepValue - 1n) / stepValue
  return mulDiv(steps * stepValue, pow10(12) + parseDec(r.feeRate, 12), pow10(12), 'up')
}

export function matchBook(side: Side, levels: { price: string; qty: string }[], want: { qty?: bigint; amount?: bigint }, bound: bigint | null, baseScale: number, quoteScale: number, step: bigint, used: (price: string) => bigint = () => 0n): MatchResult {
  const pieces: MatchPiece[] = []
  let needQty = want.qty ?? null
  let needAmount = want.amount ?? null
  let filledQty = 0n, filledAmount = 0n
  let stoppedBy: MatchResult['stoppedBy'] = levels.length ? 'depth' : 'no_liquidity'
  for (const lv of levels) {
    const price = parsePrice(lv.price)
    if (price <= 0n) continue
    if (bound !== null && (side === 'buy' ? price > bound : price < bound)) { stoppedBy = 'price_limit'; break }
    let avail = parseDec(lv.qty, baseScale, 'down') - used(lv.price)
    if (avail <= 0n) continue
    let q: bigint
    if (needQty !== null) q = avail < needQty ? avail : needQty
    else { const affordable = quantityFor(needAmount!, quoteScale, price, baseScale, 'down'); q = avail < affordable ? avail : affordable }
    q = floorToStep(q, step)
    if (q <= 0n) { if (needQty !== null ? needQty < step : true) { stoppedBy = 'done'; break } continue }
    const amount = notional(q, baseScale, price, quoteScale, side === 'buy' ? 'up' : 'down')
    if (needAmount !== null && amount > needAmount) { stoppedBy = 'done'; break }
    pieces.push({ price: lv.price, qty: q, amount })
    filledQty += q; filledAmount += amount
    avail -= q
    if (needQty !== null) { needQty -= q; if (needQty < step) { stoppedBy = 'done'; break } }
    else { needAmount! -= amount; if (quantityFor(needAmount!, quoteScale, price, baseScale, 'down') < step) { stoppedBy = 'done'; break } }
  }
  const complete = stoppedBy === 'done'
  return { pieces, filledQty, filledAmount, complete, stoppedBy: pieces.length === 0 && stoppedBy === 'depth' ? 'no_liquidity' : stoppedBy }
}

/**
 * A purchase by amount is an all-in budget: its consideration and the fee on each piece must fit inside it. The book is
 * matched for the consideration (the budget less the fee rate, rounded down), but each piece's fee is rounded up on its
 * own, so several pieces could come to a paisa or more over the budget: in R13's test, ₹128.67 bought two pieces whose
 * consideration and fees came to ₹128.68, past a per-run limit of ₹128.67 the order was checked against. Steps are taken
 * off the last piece until consideration and fees fit. Without a budget (a purchase or sale by quantity) it is unchanged.
 */
export function fitBudget(m: MatchResult, budget: bigint | null, feeRate: string, step: bigint, baseScale: number, quoteScale: number): MatchResult {
  if (budget === null) return m
  const fee = (a: bigint): bigint => fraction(a, feeRate, 'up')
  const pieces = [...m.pieces]
  let total = pieces.reduce((s, p) => s + p.amount + fee(p.amount), 0n)
  if (total <= budget) return m
  while (total > budget && pieces.length) {
    const last = pieces[pieces.length - 1]!
    total -= last.amount + fee(last.amount)
    const qty = last.qty - step
    if (qty <= 0n) { pieces.pop(); continue }
    const amount = notional(qty, baseScale, parsePrice(last.price), quoteScale, 'up')
    pieces[pieces.length - 1] = { ...last, qty, amount }
    total += amount + fee(amount)
  }
  return { ...m, pieces, filledQty: pieces.reduce((s, p) => s + p.qty, 0n), filledAmount: pieces.reduce((s, p) => s + p.amount, 0n) }
}

export class PaperCryptoVenue extends OrderVenue {
  name = 'paper-crypto'
  private readonly market: Market
  private readonly fetchBook: (market: Market, inst: Instrument) => Promise<Book>
  /** Depth this venue's own paper fills took recently: "instrument|side|price" -> { qty, ts }. */
  private readonly consumed = new Map<string, { qty: bigint; ts: number }>()
  consumedMemoryMs = 60_000
  /** A market order that cannot get a fresh book within this time is rejected rather than filled on an old one. */
  giveUpMs = 30_000

  constructor(db: Db, market: Market, clock: Clock, fetchBook: (market: Market, inst: Instrument) => Promise<Book> = fetchCoindcxBook) {
    super(db, clock)
    this.market = market
    this.fetchBook = fetchBook
  }

  /** The order book this venue would fill against now, from the same source its fills use. A preview must not look at a different book. */
  book(inst: Instrument): Promise<Book> { return this.fetchBook(this.market, inst) }
  rules(inst: Instrument): { step: bigint; minNotional: bigint; maxMarketQty: bigint | null; feeRate: string; tdsRate: string } {
    return {
      step: parseDec(inst.meta.qtyStep ?? '0.00001', inst.baseScale, 'up'),
      minNotional: parseDec(inst.meta.minNotional ?? '100', inst.quoteScale, 'up'),
      maxMarketQty: inst.meta.maxMarketQty ? parseDec(inst.meta.maxMarketQty, inst.baseScale, 'down') : null,
      feeRate: termValue(this.db, 'fee.paper-crypto.taker', 'rate', '0.005'),
      tdsRate: termValue(this.db, 'tax.vda.tds', 'rate', '0.01'),
    }
  }

  /** Accept or reject an order. Idempotent: the same client reference returns the order already on the book. */
  submit(req: OrderRequest): VenueOrder {
    const have = this.get(req.clientRef)
    if (have) return have
    const inst = instrument(this.db, req.instrumentId)
    const reject = (why: string) => this.insert(req, 'rejected', why, {})
    if (!inst || inst.venue !== this.name || !inst.tradable) return reject('This venue does not trade that instrument.')
    if (!['market', 'limit', 'stop'].includes(req.type)) return reject('Unsupported order type.')
    const r = this.rules(inst)
    if (req.side === 'sell' && req.sellAll) {
      const all = floorToStep(venueHolding(this.db, req.userId, inst.id) - venueOpenSells(this.db, req.userId, inst.id), r.step)
      if (all <= 0n) return reject('Nothing held at this venue to sell.')
      req = { ...req, qty: all }
    }
    const byQty = req.qty !== undefined, byAmount = req.amount !== undefined
    if (byQty === byAmount) return reject('State either a quantity or an amount, not both.')
    if (req.side === 'sell' && !byQty) return reject('A sale must state a quantity.')
    if (byQty && (req.qty! <= 0n || req.qty! % r.step !== 0n)) return reject(`Quantity must be a positive multiple of ${inst.meta.qtyStep ?? 'the step size'}.`)
    if (byAmount && req.amount! < r.minNotional) return reject(`Below the venue minimum of ₹${inst.meta.minNotional ?? '100'}.`)
    if (req.type === 'limit' && !req.limitPrice) return reject('A limit order needs a limit price.')
    if (req.type === 'stop' && (!req.stopPrice || req.side !== 'sell')) return reject('Only sell-stop orders are supported, and they need a stop price.')
    if (req.type === 'market' && byQty && r.maxMarketQty !== null && req.qty! > r.maxMarketQty) return reject(`Above the venue's market-order limit of ${inst.meta.maxMarketQty} ${inst.base_asset}.`)
    if (req.side === 'sell') {
      const free = venueHolding(this.db, req.userId, inst.id) - venueOpenSells(this.db, req.userId, inst.id)
      if (req.qty! > free) return reject('The venue does not hold enough to sell that quantity.')
    }
    return this.insert(req, req.type === 'market' ? 'new' : 'accepted', null, { tif: req.type === 'market' ? 'IOC' : 'GTC' }, req.qty ?? null)
  }

  private used(instId: string, side: Side, now: number): (price: string) => bigint {
    return (price) => {
      const k = `${instId}|${side}|${price}`
      const c = this.consumed.get(k)
      if (!c) return 0n
      if (now - c.ts > this.consumedMemoryMs) { this.consumed.delete(k); return 0n }
      return c.qty
    }
  }

  /** Advance open orders against current real market data. */
  async tick(): Promise<void> {
    const open = this.db.all<Record<string, unknown>>(`SELECT * FROM pv_orders WHERE venue = ? AND state IN ('new', 'accepted') ORDER BY created_at`, this.name)
    for (const row of open) {
      const o = loadOrder(this.db, row)
      try { await this.work(o) } catch (e) { this.note(o, `Not evaluated: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }

  private note(o: VenueOrder, text: string): void {
    const meta = { ...o.meta, lastNote: text, lastNoteAt: this.clock.now() }
    this.db.run('UPDATE pv_orders SET meta_json = ? WHERE id = ?', j(meta), o.id)
  }

  private async work(o: VenueOrder): Promise<void> {
    const inst = instrument(this.db, o.instrumentId)!
    const now = this.clock.now()
    const maxAge = inst.meta.execMaxAgeMs ?? 15_000

    if (o.type === 'stop') {
      const bid = this.market.get(inst.id, 'bid')
      if (!bid || now - bid.recvTs > maxAge) { this.note(o, 'Price data is stale; the stop is not being evaluated.'); return }
      if (parsePrice(bid.price) > parsePrice(o.stopPrice!)) { if (o.meta.lastNote) this.note(o, ''); return }
      // Triggered: from here it behaves as a market sale and needs a fresh book.
    }

    let book: Book
    try {
      const cached = this.market.book(inst.id)
      book = cached && now - cached.recvTs <= 1500 ? cached : await this.fetchBook(this.market, inst)
    } catch (e) {
      if (o.type === 'market' && now - o.createdAt > this.giveUpMs) this.setState(o.id, 'rejected', 'No fresh order book could be obtained; the order was not filled on stale prices.')
      else this.note(o, `Waiting for a fresh order book (${e instanceof Error ? e.message : 'unavailable'}).`)
      return
    }
    const bookAge = this.clock.now() - book.recvTs
    if (bookAge > maxAge) { this.note(o, 'The order book is stale; not executing.'); return }

    const r = this.rules(inst)
    const levels = o.side === 'buy' ? book.asks : book.bids
    const best = levels[0] ? parsePrice(levels[0].price) : 0n
    if (best <= 0n) { this.note(o, 'The book has no price on that side.'); return }
    const slip = BigInt(o.maxSlippageBps ?? 100)
    let bound: bigint | null
    if (o.type === 'limit') bound = parsePrice(o.limitPrice!)
    else bound = o.side === 'buy' ? best + mulDiv(best, slip, 10_000n, 'down') : best - mulDiv(best, slip, 10_000n, 'down')

    const remainingQty = o.qty !== null ? o.qty - o.filledQty : null
    // A buy by amount is an all-in budget: consideration plus the fee must fit inside it.
    const budget = o.amount !== null ? o.amount - o.filledAmount - o.fees : null
    const forConsideration = budget !== null ? mulDiv(budget, pow10(12), pow10(12) + parseDec(r.feeRate, 12), 'down') : null
    const want = remainingQty !== null ? { qty: remainingQty } : { amount: forConsideration! }
    const m = fitBudget(matchBook(o.side, levels, want, bound, inst.baseScale, inst.quoteScale, r.step, this.used(inst.id, o.side, now)), budget, r.feeRate, r.step, inst.baseScale, inst.quoteScale)

    if (m.pieces.length === 0) {
      if (o.type === 'market' || o.type === 'stop') this.setState(o.id, o.filledQty > 0n ? 'partially_filled' : 'rejected', m.stoppedBy === 'price_limit' ? 'No size was available inside the slippage limit.' : 'No size was available in the book.')
      return
    }
    if (o.filledQty === 0n && m.filledAmount < r.minNotional && (o.type !== 'limit')) { this.setState(o.id, 'rejected', `The fill would be below the venue minimum of ₹${inst.meta.minNotional ?? '100'}.`); return }

    const execTs = this.clock.now()
    const snapshotId = this.snapshot(inst.id, 'book', {
      provider: book.provider, sourceTs: book.sourceTs, recvTs: book.recvTs, ageMsAtExecution: execTs - book.recvTs,
      bids: book.bids.slice(0, 10), asks: book.asks.slice(0, 10), bound: bound === null ? null : (Number(bound) / 10 ** PRICE_SCALE).toString(), side: o.side,
    })
    this.db.tx(() => {
      for (const p of m.pieces) {
        const fee = fraction(p.amount, r.feeRate, 'up')
        const tax = o.side === 'sell' ? fraction(p.amount, r.tdsRate, 'up') : 0n
        this.addFill(o, { ts: execTs, effectiveDate: null, qty: p.qty, price: p.price, amount: p.amount, fee, tax, cashAt: null, snapshotId, note: 'Paper fill against the real order book; not executed by an exchange.' })
        const k = `${inst.id}|${o.side}|${p.price}`
        const c = this.consumed.get(k)
        this.consumed.set(k, { qty: (c && execTs - c.ts <= this.consumedMemoryMs ? c.qty : 0n) + p.qty, ts: execTs })
      }
      const done = m.complete
      if (o.type === 'limit') this.setState(o.id, done ? 'filled' : 'accepted')
      else this.setState(o.id, done ? 'filled' : 'partially_filled', done ? null : (m.stoppedBy === 'price_limit' ? 'Filled what was available inside the slippage limit; the rest was cancelled.' : 'Filled what the book offered; the rest was cancelled.'))
    })
  }
}

// ---------------------------------------------------------------------------------------------- mutual funds

/**
 * The earliest NAV date by scheme rule, for money (a purchase) or a request (a redemption) that reaches the fund house at
 * `now`. Weekends handled; holidays resolve when NAVs publish. SEBI's rule allots a purchase at the NAV of the day its
 * money is realised; fundEntitlement applies the paper pay-in to a purchase made now.
 */
export function navEntitlement(inst: Instrument, side: Side, now: number): { minNavDate: string; beforeCutoff: boolean; cutoff: string; rule: string } {
  const t = ist(now)
  const isBusiness = t.weekday >= 1 && t.weekday <= 5
  const liquid = inst.meta.navRule === 'liquid-previous-day'
  // Liquid and overnight purchases cut off at 13:30; all redemptions and other purchases at 15:00.
  const cutoff = liquid && side === 'buy' ? (inst.meta.cutoff ?? '13:30') : '15:00'
  const [ch, cm] = cutoff.split(':').map(Number)
  const beforeCutoff = isBusiness && t.minutes < (ch ?? 15) * 60 + (cm ?? 0)
  const nextBusinessAfter = (date: string): string => { let d = addDays(date, 1); for (;;) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) return d; d = addDays(d, 1) } }
  const applicableBusinessDay = beforeCutoff ? t.date : nextBusinessAfter(t.date)
  if (liquid) {
    if (side === 'buy') return { minNavDate: addDays(applicableBusinessDay, -1), beforeCutoff, cutoff, rule: 'Liquid and overnight purchase: the NAV of the day before the business day on which the fund house receives the money before the cut-off.' }
    return { minNavDate: addDays(nextBusinessAfter(applicableBusinessDay), -1), beforeCutoff, cutoff, rule: 'Liquid and overnight redemption: the NAV of the day before the next business day.' }
  }
  return side === 'buy'
    ? { minNavDate: applicableBusinessDay, beforeCutoff, cutoff, rule: 'The NAV of the business day on which the fund house receives the money before the cut-off; otherwise the next business day\'s.' }
    : { minNavDate: applicableBusinessDay, beforeCutoff, cutoff, rule: 'The NAV of the business day on which the registrar receives the request before the cut-off; otherwise the next business day\'s.' }
}

/**
 * On paper, a purchase's money reaches the fund house this long after the order reaches the registrar: the paper
 * rail's time for an instant transfer (UPI, IMPS; PaperRail below). The day it arrives, against the cut-off, sets the
 * NAV day, as SEBI's rule does with the day the money is realised.
 */
export const FUND_PAY_IN_MS = 2000

/** The NAV day for an order placed at `now`: a purchase by when its money will reach the fund house, a redemption by now. */
export const fundEntitlement = (inst: Instrument, side: Side, now: number): ReturnType<typeof navEntitlement> => navEntitlement(inst, side, side === 'buy' ? now + FUND_PAY_IN_MS : now)

/** The instant cash is paid for a redemption: a number of weekdays after the NAV date, at 10:00 IST. */
export function payoutInstant(navDate: string, businessDays: number): number {
  let d = navDate
  let left = businessDays
  while (left > 0) { d = addDays(d, 1); const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) left-- }
  return istInstant(d, '10:00')
}

export class PaperFundVenue extends OrderVenue {
  name = 'paper-mf'

  submit(req: OrderRequest): VenueOrder {
    const have = this.get(req.clientRef)
    if (have) return have
    const inst = instrument(this.db, req.instrumentId)
    const reject = (why: string) => this.insert(req, 'rejected', why, {})
    if (!inst || inst.venue !== this.name || !inst.tradable) return reject('This venue does not handle that scheme.')
    if (req.type !== 'nav') return reject('Fund orders execute at NAV only.')
    let qty = req.qty ?? null
    if (req.side === 'buy') {
      if (req.amount === undefined || req.qty !== undefined) return reject('A purchase states an amount in rupees.')
      if (req.amount < parseDec(inst.meta.minAmount ?? '100', 2, 'up')) return reject(`Below the scheme minimum of ₹${inst.meta.minAmount ?? '100'}.`)
    } else {
      const free = venueHolding(this.db, req.userId, inst.id) - venueOpenSells(this.db, req.userId, inst.id)
      if (req.sellAll) qty = free
      if (qty === null || qty <= 0n) return reject('A redemption states a number of units.')
      if (qty > free) return reject('The registrar does not hold that many units.')
    }
    const now = this.clock.now()
    const ent = fundEntitlement(inst, req.side, now)
    // a purchase is with the registrar now; its money arrives at fundsDueAt (FUND_PAY_IN_MS), which its NAV day follows
    return this.insert(req, 'accepted', null, { ...ent, placedIst: `${ist(now).date} ${ist(now).hm}`, ...(req.side === 'buy' ? { fundsDueAt: now + FUND_PAY_IN_MS } : {}) }, qty, now)
  }

  /**
   * Record the money that has reached the fund house, allot units for orders whose NAV has been published, and release
   * redemption payouts that have fallen due. Money is recorded at the time it arrived (its pay-in), however late this
   * runs; its NAV day is worked out from that time again, so a pay-in that ever arrived late would take a later NAV.
   */
  async tick(): Promise<void> {
    const now = this.clock.now()
    for (const row of this.db.all<Record<string, unknown>>(`SELECT * FROM pv_orders WHERE venue = ? AND side = 'buy' AND state = 'accepted' ORDER BY created_at`, this.name)) {
      const o = loadOrder(this.db, row)
      const due = typeof o.meta.fundsDueAt === 'number' ? o.meta.fundsDueAt : o.createdAt
      if (due > now) continue
      const inst = instrument(this.db, o.instrumentId)!
      const ent = navEntitlement(inst, 'buy', due)
      const meta = ent.minNavDate > String(o.meta.minNavDate ?? '') ? { ...o.meta, ...ent } : o.meta
      this.db.run(`UPDATE pv_orders SET state = 'funded', funds_at = ?, updated_at = ?, meta_json = ? WHERE id = ? AND state = 'accepted'`, due, now, j(meta), o.id)
    }
    const open = this.db.all<Record<string, unknown>>(`SELECT * FROM pv_orders WHERE venue = ? AND ((side = 'buy' AND state = 'funded') OR (side = 'sell' AND state = 'accepted')) ORDER BY created_at`, this.name)
    // A NAV is a price at the close of its own day: units are allotted or redeemed at it on that day or later, never
    // before. A NAV on record for a day that has not come (a faulty feed, or a test control that published early) waits
    // for its day; until 24 Nov 2026 it was used at once ("NAV for Wed 25 Nov; allotted Tue 24 Nov", R13 section 4).
    const today = ist(now).date
    for (const row of open) {
      const o = loadOrder(this.db, row)
      const inst = instrument(this.db, o.instrumentId)!
      const minDate = String(o.meta.minNavDate ?? '')
      const nav = this.db.get<{ value_date: string; value: string; recv_ts: number; source: string }>(
        'SELECT value_date, value, recv_ts, source FROM daily_values WHERE instrument_id = ? AND value_date >= ? AND value_date <= ? ORDER BY value_date LIMIT 1', inst.id, minDate, today)
      if (!nav) continue
      const price = parsePrice(nav.value)
      const snapshotId = this.snapshot(inst.id, 'nav', { navDate: nav.value_date, nav: nav.value, source: nav.source, receivedAt: nav.recv_ts, entitledFrom: minDate, rule: o.meta.rule })
      this.db.tx(() => {
        if (o.side === 'buy') {
          const stampRate = termValue(this.db, 'mf.stamp', 'rate', '0.00005')
          // Stamp duty is charged on the amount invested net of the duty itself.
          const stamp = mulDiv(o.amount!, parseDec(stampRate, 12), pow10(12) + parseDec(stampRate, 12), 'half')
          const net = o.amount! - stamp
          const units = quantityFor(net, inst.quoteScale, price, inst.baseScale, 'down')
          if (units <= 0n) { this.setState(o.id, 'rejected', 'The amount buys less than one thousandth of a unit.'); return }
          this.addFill(o, { ts: now, effectiveDate: nav.value_date, qty: units, price: nav.value, amount: net, fee: 0n, tax: stamp, cashAt: null, snapshotId, note: 'Paper allotment at the published NAV; not processed by the fund house.' })
        } else {
          const gross = notional(o.qty!, inst.baseScale, price, inst.quoteScale, 'down')
          const load = this.exitLoad(o, inst, nav.value_date, gross)
          const due = payoutInstant(nav.value_date, inst.meta.payoutDays ?? 2)
          this.addFill(o, { ts: now, effectiveDate: nav.value_date, qty: o.qty!, price: nav.value, amount: gross, fee: load, tax: 0n, cashAt: Math.max(due, now), snapshotId, note: 'Paper redemption at the published NAV; not processed by the fund house.' })
        }
        this.setState(o.id, 'filled')
      })
    }
    this.db.run('UPDATE pv_fills SET cash_done = 1 WHERE cash_done = 0 AND cash_at IS NOT NULL AND cash_at <= ?', now)
  }

  /** Exit load on a redemption, applied first-in-first-out to this customer's earlier allotments at the venue. */
  private exitLoad(o: VenueOrder, inst: Instrument, navDate: string, gross: bigint): bigint {
    const t = term(this.db, inst.meta.exitLoad ?? 'mf.exitload.none')
    const byDay = Array.isArray(t?.value.byDay) ? (t!.value.byDay as string[]) : null
    if (!byDay) return fraction(gross, typeof t?.value.rate === 'string' ? t.value.rate : '0', 'up')
    const buys = this.db.all<{ qty: number; effective_date: string | null }>(`SELECT qty, effective_date FROM pv_fills WHERE user_id = ? AND instrument_id = ? AND side = 'buy' ORDER BY ts, id`, o.userId, inst.id)
    let sold = fromAmountText(this.db.get<{ s: string }>(`SELECT amount_sum(qty) s FROM pv_fills WHERE user_id = ? AND instrument_id = ? AND side = 'sell'`, o.userId, inst.id)?.s, `the sold ${inst.id}`)
    let left = o.qty!
    let load = 0n
    for (const b of buys) {
      let lot = big(b.qty)
      if (sold >= lot) { sold -= lot; continue }
      lot -= sold; sold = 0n
      const take = lot < left ? lot : left
      const days = b.effective_date ? Math.round((Date.parse(`${navDate}T00:00:00Z`) - Date.parse(`${b.effective_date}T00:00:00Z`)) / 86_400_000) : 99
      const rate = days >= 0 && days < byDay.length ? byDay[days]! : '0'
      load += fraction(mulDiv(gross, take, o.qty!, 'down'), rate, 'up')
      left -= take
      if (left <= 0n) break
    }
    return load
  }
}

// ---------------------------------------------------------------------------------------------- securities desks

/**
 * The paper exchange (ETFs and shares) and the paper government-securities desk (a Treasury bill and a bond). Both fill a
 * market order, in whole lots, at the desk's one displayed price on the side taken (the ask to buy, the bid to sell),
 * only while the desk is open, and refuse it out of hours rather than hold it. Costs and the settlement date come from the
 * terms table when the order fills (securities.ts). A purchase takes its money at once and the units are the customer's at
 * once; the money from a sale reaches the bank at the settlement date and hour. The prices are synthetic (securities.ts).
 * Nothing here was executed by an exchange, a broker, or the Reserve Bank.
 */
abstract class PaperSecuritiesDesk extends OrderVenue {
  protected readonly market: Market
  /** A market order that cannot get a fresh price within this time is rejected rather than filled on an old one. */
  giveUpMs = 30_000
  constructor(db: Db, market: Market, clock: Clock) { super(db, clock); this.market = market }

  rules(inst: Instrument): { step: bigint } { return { step: BigInt(inst.meta.qtyStep ?? '1') } }

  submit(req: OrderRequest): VenueOrder {
    const have = this.get(req.clientRef)
    if (have) return have
    const inst = instrument(this.db, req.instrumentId)
    const reject = (why: string) => this.insert(req, 'rejected', why, {})
    if (!inst || inst.venue !== this.name || !inst.tradable) return reject('This desk does not trade that instrument.')
    if (req.type !== 'market') return reject('This desk takes market orders only: an order fills at the price shown when it is placed, or is refused.')
    const now = this.clock.now()
    if (!sessionOf(inst, now).open) return reject(closedText(inst, now))
    if (req.side === 'buy' && matured(inst, ist(now).date)) return reject('This bill has matured, so it can no longer be bought.')
    const { step } = this.rules(inst)
    let qty: bigint | null = null
    if (req.side === 'buy') {
      if (req.amount === undefined || req.qty !== undefined || req.amount <= 0n) return reject('A purchase states an amount in rupees.')
    } else {
      const free = venueHolding(this.db, req.userId, inst.id) - venueOpenSells(this.db, req.userId, inst.id)
      qty = req.sellAll ? floorToStep(free, step) : req.qty ?? null
      if (qty === null || qty <= 0n) return reject('A sale states a quantity, and nothing is held to sell.')
      if (qty % step !== 0n) return reject(`A sale is in multiples of ${step} unit${step === 1n ? '' : 's'}.`)
      if (qty > free) return reject('The desk does not hold that many units for you.')
    }
    return this.insert(req, 'new', null, { tif: 'IOC', hours: inst.meta.hours ?? null, placedIst: `${ist(now).date} ${ist(now).hm}` }, qty, now)
  }

  async tick(): Promise<void> {
    for (const row of this.db.all<Record<string, unknown>>(`SELECT * FROM pv_orders WHERE venue = ? AND state = 'new' ORDER BY created_at`, this.name)) {
      const o = loadOrder(this.db, row)
      try { this.work(o) } catch (e) { this.db.run('UPDATE pv_orders SET meta_json = ? WHERE id = ?', j({ ...o.meta, lastNote: `Not evaluated: ${e instanceof Error ? e.message : String(e)}`, lastNoteAt: this.clock.now() }), o.id) }
    }
    this.db.run('UPDATE pv_fills SET cash_done = 1 WHERE cash_done = 0 AND cash_at IS NOT NULL AND cash_at <= ?', this.clock.now())
  }

  private work(o: VenueOrder): void {
    const inst = instrument(this.db, o.instrumentId)!
    const now = this.clock.now()
    const today = ist(now).date
    if (!sessionOf(inst, now).open) { this.setState(o.id, 'rejected', closedText(inst, now)); return }
    if (o.side === 'buy' && matured(inst, today)) { this.setState(o.id, 'rejected', 'This bill has matured, so it can no longer be bought.'); return }
    const ask = this.market.get(inst.id, 'ask'), bid = this.market.get(inst.id, 'bid')
    const t = o.side === 'buy' ? ask : bid
    const maxAge = inst.meta.execMaxAgeMs ?? 15_000
    if (!t || !bid || !ask || now - t.recvTs > maxAge) {
      if (now - o.createdAt > this.giveUpMs) this.setState(o.id, 'rejected', 'No fresh price could be obtained; the order was not filled on an old one.')
      else this.db.run('UPDATE pv_orders SET meta_json = ? WHERE id = ?', j({ ...o.meta, lastNote: 'Waiting for a fresh price.', lastNoteAt: now }), o.id)
      return
    }
    const price = parsePrice(t.price)
    const { step } = this.rules(inst)
    let qty: bigint, gross: bigint
    if (o.side === 'buy') {
      const budget = o.amount!
      qty = floorToStep(quantityFor(budget, inst.quoteScale, price, inst.baseScale, 'down'), step)
      gross = notional(qty, inst.baseScale, price, inst.quoteScale, 'up')
      // the amount is an all-in budget: the price and every cost must fit inside it, so steps come off until they do
      while (qty > 0n) { const c = securityCosts(this.db, inst, 'buy', gross); if (gross + c.fee + c.tax <= budget) break; qty -= step; gross = notional(qty, inst.baseScale, price, inst.quoteScale, 'up') }
      if (qty <= 0n) { this.setState(o.id, 'rejected', `The amount buys less than the smallest lot of ${step} unit${step === 1n ? '' : 's'} once its costs are taken from it.`); return }
    } else {
      qty = o.qty!
      gross = notional(qty, inst.baseScale, price, inst.quoteScale, 'down')
    }
    const costs = securityCosts(this.db, inst, o.side, gross)
    const snapshotId = this.snapshot(inst.id, 'quote', {
      provider: t.provider, sourceTs: t.sourceTs, recvTs: t.recvTs, ageMsAtExecution: now - t.recvTs, side: o.side,
      bids: [{ price: bid.price, qty: '' }], asks: [{ price: ask.price, qty: '' }], costs: costs.parts.map((p) => ({ label: p.label, paise: p.amount.toString(), kind: p.kind })),
    })
    const days = inst.meta.settlementDays ?? 1
    this.db.tx(() => {
      this.addFill(o, { ts: now, effectiveDate: today, qty, price: t.price, amount: gross, fee: costs.fee, tax: costs.tax, cashAt: o.side === 'sell' ? settlementInstant(today, days) : null, snapshotId,
        note: `Paper fill at the desk's displayed price (${t.provider}); not executed by an exchange or a broker. ${o.side === 'sell' ? `Money reaches the bank ${days} business day${days === 1 ? '' : 's'} later (T+${days}).` : 'The money left at once; units are yours at once.'}` })
      this.setState(o.id, 'filled')
    })
  }
}
export class PaperExchangeVenue extends PaperSecuritiesDesk { name = 'paper-exchange' }
export class PaperDebtVenue extends PaperSecuritiesDesk { name = 'paper-gsec' }

// ---------------------------------------------------------------------------------------------- payment rail

export type RailName = 'upi' | 'imps' | 'neft' | 'rtgs' | 'internal'
export type PaymentState = 'pending' | 'settled' | 'failed' | 'reversed' | 'unknown'
export interface PaymentRequest { clientRef: string; userId: string; payeeHandle: string; amount: bigint; rail?: RailName }
export interface VenuePayment { id: string; clientRef: string; userId: string; rail: RailName; payeeHandle: string; amount: bigint; state: PaymentState; reason: string | null; reference: string | null; createdAt: number; updatedAt: number; resolveAt: number | null; meta: Record<string, unknown> }
export const TERMINAL_PAYMENT: ReadonlySet<PaymentState> = new Set(['settled', 'failed', 'reversed'])

export class PaperRail {
  name = 'paper-rail'
  private readonly db: Db
  private readonly clock: Clock
  constructor(db: Db, clock: Clock) { this.db = db; this.clock = clock }

  get(clientRef: string): VenuePayment | undefined {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM pv_payments WHERE client_ref = ?', clientRef)
    if (!r) return undefined
    return { id: String(r.id), clientRef: String(r.client_ref), userId: String(r.user_id), rail: r.rail as RailName, payeeHandle: String(r.payee_handle), amount: big(r.amount), state: r.state as PaymentState,
      reason: (r.reason as string | null) ?? null, reference: (r.reference as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), resolveAt: (r.resolve_at as number | null) ?? null, meta: parse<Record<string, unknown>>(r.meta_json, {}) }
  }

  /** Which rail carries an amount, by the limits on record. */
  chooseRail(amount: bigint, handle: string, preferred?: RailName): { rail: RailName; error?: string } {
    if (handle.endsWith('@paperbank')) return { rail: 'internal' }
    const lim = (id: string, d: number): bigint => { const v = term(this.db, id)?.value.amount; return BigInt(typeof v === 'number' ? v : d) }
    const upi = lim('rail.upi.limit', 10_000_000), imps = lim('rail.imps.limit', 50_000_000), rtgsMin = lim('rail.rtgs.min', 20_000_000)
    if (preferred === 'upi' && amount > upi) return { rail: 'upi', error: 'Above the UPI limit for one payment.' }
    if (preferred === 'imps' && amount > imps) return { rail: 'imps', error: 'Above the IMPS limit for one payment.' }
    if (preferred === 'rtgs' && amount < rtgsMin) return { rail: 'rtgs', error: 'Below the RTGS minimum.' }
    if (preferred) return { rail: preferred }
    if (amount <= upi) return { rail: 'upi' }
    if (amount <= imps) return { rail: 'imps' }
    return { rail: 'rtgs' }
  }

  /**
   * By when the paper rail answers a payment sent at `sentAt` on `rail`, by its own rules: at once inside the bank; a NEFT
   * payment with its half-hourly batch; otherwise within two minutes, which is when its slowest test payee (timeout@paper)
   * answers that the payment failed. The interface states this bound on a pending payment (R12 task comparison, gap 11).
   */
  answerBy(rail: RailName, sentAt: number): number {
    if (rail === 'internal') return sentAt
    const two = sentAt + 120_000
    if (rail === 'neft') { const half = 30 * 60_000; return Math.max(two, Math.ceil((sentAt + 1) / half) * half + 60_000) }
    return two
  }

  /** Idempotent on the client reference: a retry with the same reference returns the payment already on the rail. */
  submit(req: PaymentRequest): VenuePayment {
    const have = this.get(req.clientRef)
    if (have) return have
    const now = this.clock.now()
    const choice = this.chooseRail(req.amount, req.payeeHandle, req.rail)
    const local = req.payeeHandle.split('@')[0]?.toLowerCase() ?? ''
    const test = req.payeeHandle.toLowerCase().endsWith('@paper') ? local : ''
    let state: PaymentState = 'pending', reason: string | null = null, resolveAt: number | null = null
    const meta: Record<string, unknown> = {}
    if (req.amount <= 0n) { state = 'failed'; reason = 'The amount must be positive.' }
    else if (choice.error) { state = 'failed'; reason = choice.error }
    else if (test === 'decline') { state = 'failed'; reason = 'Declined by the payee bank (test payee decline@paper).' }
    else if (test === 'slow') { resolveAt = now + 90_000; meta.outcome = 'settled'; meta.test = 'slow@paper stays pending for 90 seconds' }
    else if (test === 'timeout') { state = 'unknown'; resolveAt = now + 120_000; meta.outcome = 'failed'; meta.test = 'timeout@paper returns no answer for 2 minutes, then fails' }
    else if (test === 'reverse') { resolveAt = now + 2000; meta.outcome = 'settled'; meta.thenReverseAfterMs = 60_000; meta.test = 'reverse@paper settles, then is reversed after a minute' }
    else if (choice.rail === 'neft') { const half = 30 * 60_000; resolveAt = Math.ceil((now + 1) / half) * half + 60_000; meta.outcome = 'settled'; meta.batch = 'next half-hourly batch' }
    else if (choice.rail === 'internal') { resolveAt = now; meta.outcome = 'settled' }
    else { resolveAt = now + 2000; meta.outcome = 'settled' }
    const reference = state === 'failed' ? null : `PAPER${String(now).slice(-9)}${Math.floor(Math.random() * 900 + 100)}`
    this.db.run(`INSERT INTO pv_payments (id, client_ref, user_id, rail, payee_handle, amount, state, reason, reference, created_at, updated_at, resolve_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('pvp', now), req.clientRef, req.userId, choice.rail, req.payeeHandle, toNum(req.amount), state, reason, reference, now, now, resolveAt, j(meta))
    return this.get(req.clientRef)!
  }

  async tick(): Promise<void> {
    const now = this.clock.now()
    const due = this.db.all<Record<string, unknown>>(`SELECT * FROM pv_payments WHERE state IN ('pending', 'unknown', 'settled') AND resolve_at IS NOT NULL AND resolve_at <= ?`, now)
    for (const r of due) {
      const meta = parse<Record<string, unknown>>(r.meta_json, {})
      if (r.state === 'settled') {
        this.db.run(`UPDATE pv_payments SET state = 'reversed', reason = ?, updated_at = ?, resolve_at = NULL WHERE id = ?`, 'Returned by the payee bank (test payee reverse@paper).', now, String(r.id))
        continue
      }
      const outcome = meta.outcome === 'failed' ? 'failed' : 'settled'
      const next = outcome === 'settled' && typeof meta.thenReverseAfterMs === 'number' ? now + meta.thenReverseAfterMs : null
      this.db.run('UPDATE pv_payments SET state = ?, reason = ?, updated_at = ?, resolve_at = ? WHERE id = ?', outcome, outcome === 'failed' ? 'No confirmation arrived; the rail reports the payment did not go through (test payee timeout@paper).' : null, now, next, String(r.id))
    }
  }
}

/** exchange and debt are the paper securities desks (securities.ts); optional so that a fixture that builds only the first three still works, and read through securitiesDesk() there. */
export interface Venues { crypto: PaperCryptoVenue; funds: PaperFundVenue; rail: PaperRail; exchange?: PaperExchangeVenue; debt?: PaperDebtVenue }
/**
 * `fetchBook` replaces the live order book (presentation mode passes syntheticBook, so that neither the engine's fills
 * nor the API's estimates contact CoinDCX).
 */
export function buildVenues(db: Db, market: Market, clock: Clock, fetchBook?: (market: Market, inst: Instrument) => Promise<Book>): Venues {
  // Every call to a simulated institution carries QED's agent identity and is recorded (agent-identity.ts; N-021).
  const id = <T extends object>(name: string, v: T): T => withAgentIdentity(name, v, () => clock.now())
  return { crypto: id('paper-crypto', new PaperCryptoVenue(db, market, clock, fetchBook)), funds: id('paper-mf', new PaperFundVenue(db, clock)), rail: id('paper-rail', new PaperRail(db, clock)), exchange: id('paper-exchange', new PaperExchangeVenue(db, market, clock)), debt: id('paper-gsec', new PaperDebtVenue(db, market, clock)) }
}
