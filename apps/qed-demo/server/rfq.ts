/**
 * Requests for quotes for a large order (R13, I2; the audit's I2). A household or a business asks every source it can reach
 * for a price on an order of a size, sees each answer side by side, and sees how the order would be split between them to
 * cost least. It moves no money and places no order: to act on a quote the person uses the order screen, which asks for their
 * passkey as it always does.
 *
 * What the sources are, and what is simulated:
 *   - "Paper venue book" (paper-crypto): the order book the paper venue fills against (real public order-book data as this app
 *     recorded it), walked level by level, with the venue's taker fee. Executable on the paper venue.
 *   - "Dealer A" and "Dealer B": SIMULATED. Two scripted dealers whose prices are a documented function of the same
 *     mid-price (DEALERS below). They stand for what a real request to dealers would look like; no dealer exists, no one will deal
 *     at these prices, and nothing here is executable. They are labelled so wherever they appear.
 *   - A mutual fund: bought at NAV from the fund house, so there is one price and nothing to compare (said so, not hidden).
 * The split is exact for what it assumes: each source's price rises with the amount taken from it, and every 1% of the order
 * goes to whichever source is cheapest at that point.
 *
 * "Certified minimum variance, where it applies": for an order of two or more investments that have recorded value history,
 * the shares of the order are compared with the minimum-variance mix of those investments, with the solve's own optimality
 * certificate (lab.ts optimiseMix). Where it does not apply (one investment, or no recorded history) it says why.
 */
import { AppError, audit, bad, type Db, j, newId, parse } from './core.ts'
import { optimiseMix } from './lab.ts'
import { instrument } from './registry.ts'
import type { Ctx } from './types.ts'
import { canPrepare, type Role } from './workspaces.ts'
import { navEntitlement } from './venues.ts'
import { inrExact } from '../shared/money.ts'

export const QUOTE_VALID_MS = 60_000
export const MAX_LEGS = 6
const SLICES = 100
const MIN_ORDER_PAISE = 10_000_00 // ₹10,000: below that an order has nothing to compare
export const SIMULATED_NOTE = 'Dealer A and Dealer B are simulated: scripted prices from a documented formula on the paper venue\'s mid-price. No dealer exists and nobody will trade at these prices. Only the paper venue\'s own book can be ordered, through the order screen.'

/** The simulated dealers: half-spread, how much price rises per ₹10 lakh taken, and the most each will quote. */
export const DEALERS = [
  { id: 'dealer-a', label: 'Dealer A (simulated)', halfSpread: 0.0010, slopePer10L: 0.0005, capacityPaise: 5_000_000_00 },
  { id: 'dealer-b', label: 'Dealer B (simulated)', halfSpread: 0.0016, slopePer10L: 0.0002, capacityPaise: 20_000_000_00 },
] as const

export interface Source { id: string; label: string; simulated: boolean; executable: boolean; note: string; capacityPaise: number; marginal: (takenPaise: number) => number }
export interface SourceQuote { id: string; label: string; simulated: boolean; executable: boolean; note: string; sharePaise: number; qty: number; avgPrice: number | null; slippageBps: number | null; feePaise: number; complete: boolean; alonePrice: number | null; aloneComplete: boolean }
export interface LegQuote {
  instrumentId: string; name: string; side: 'buy' | 'sell'; amountPaise: number; mid: number | null; kind: string
  sources: SourceQuote[]; splitAvgPrice: number | null; bestAlone: { id: string; label: string; avgPrice: number } | null; improvementBps: number | null; filledPaise: number; complete: boolean; why: string | null
}
export interface RfqResult {
  id: string; createdAt: number; validUntil: number; legs: LegQuote[]; simulatedNote: string
  minVariance: { applies: boolean; why: string | null; certified?: boolean; certificate?: Record<string, number>; observations?: number; window?: { from: string; to: string }; shares?: { instrumentId: string; name: string; orderBps: number; minVarianceBps: number }[]; maxGapBps?: number; matches?: boolean }
}

/** Marginal price (rupees per unit) after `taken` paise have been taken from a book's levels. */
function bookSource(levels: { price: number; paise: number }[], feeRate: number): Source {
  const total = levels.reduce((s, l) => s + l.paise, 0)
  return {
    id: 'paper-book', label: 'Paper venue book', simulated: false, executable: true, capacityPaise: total,
    note: `The paper venue's own order book, walked level by level, plus its ${(feeRate * 100).toFixed(2)}% taker fee. Order it on the order screen.`,
    marginal: (taken) => { let left = taken; for (const l of levels) { if (left < l.paise) return l.price; left -= l.paise } return levels[levels.length - 1]?.price ?? Number.NaN },
  }
}
const dealerSource = (d: typeof DEALERS[number], mid: number, side: 'buy' | 'sell'): Source => ({
  id: d.id, label: d.label, simulated: true, executable: false, capacityPaise: d.capacityPaise,
  note: `Scripted: mid-price ${side === 'buy' ? 'plus' : 'minus'} a half-spread of ${(d.halfSpread * 100).toFixed(2)}% and ${(d.slopePer10L * 100).toFixed(2)}% for every ₹10 lakh taken. Not a real quote.`,
  marginal: (taken) => mid * (1 + (side === 'buy' ? 1 : -1) * (d.halfSpread + (d.slopePer10L * taken) / 1_000_000_00)),
})

/** Split an order across sources by taking each 1% from whichever is cheapest (dearest, for a sale) at that point. */
export function splitOrder(sources: Source[], side: 'buy' | 'sell', amountPaise: number): { taken: number[]; qty: number[]; filled: number } {
  const taken = sources.map(() => 0), qty = sources.map(() => 0)
  const slice = amountPaise / SLICES
  let filled = 0
  for (let k = 0; k < SLICES; k++) {
    let best = -1, bestP = side === 'buy' ? Infinity : -Infinity
    sources.forEach((s, i) => {
      if (taken[i]! + slice > s.capacityPaise + 1e-6) return
      const p = s.marginal(taken[i]!)
      if (Number.isFinite(p) && (side === 'buy' ? p < bestP : p > bestP)) { best = i; bestP = p }
    })
    if (best < 0) break
    taken[best]! += slice; qty[best]! += slice / 100 / bestP; filled += slice
  }
  return { taken, qty, filled }
}

async function legQuote(ctx: Ctx, instrumentId: string, side: 'buy' | 'sell', amountPaise: number, now: number): Promise<LegQuote> {
  const inst = instrument(ctx.db, instrumentId)
  const base = { instrumentId, side, amountPaise, sources: [] as SourceQuote[], splitAvgPrice: null, bestAlone: null, improvementBps: null, filledPaise: 0, complete: false }
  if (!inst) throw bad('That instrument is not one this app lists.', { instrumentId: 'Unknown instrument.' })
  if (inst.kind === 'mutual_fund') {
    const nav = ctx.market.get(inst.id, 'nav')
    const e = navEntitlement(inst, side, now)
    return { ...base, name: inst.name, kind: 'mutual_fund', mid: nav ? Number(nav.price) : null, filledPaise: nav ? amountPaise : 0, complete: !!nav, splitAvgPrice: nav ? Number(nav.price) : null,
      sources: nav ? [{ id: 'fund-house', label: 'Fund house at NAV (paper registrar)', simulated: false, executable: true, note: `A fund is bought and sold at the day's NAV: ${e.rule}`, sharePaise: amountPaise, qty: amountPaise / 100 / Number(nav.price), avgPrice: Number(nav.price), slippageBps: 0, feePaise: 0, complete: true, alonePrice: Number(nav.price), aloneComplete: true }] : [],
      why: nav ? 'A fund has one price, its NAV, so there is nothing to compare. Quotes matter for a traded asset.' : 'No NAV is recorded for this fund.' }
  }
  if (inst.kind !== 'crypto_spot' || inst.venue !== 'paper-crypto') return { ...base, name: inst.name, kind: inst.kind, mid: null, why: 'No paper venue quotes this instrument.' }
  const book = await ctx.venues.crypto.book(inst)
  const lv = (side === 'buy' ? book.asks : book.bids).map((l) => ({ price: Number(l.price), qty: Number(l.qty) })).filter((l) => l.price > 0 && l.qty > 0)
  if (!lv.length || !book.bids[0] || !book.asks[0]) return { ...base, name: inst.name, kind: 'crypto', mid: null, why: 'The venue\'s order book is empty or stale, so there is nothing to quote against.' }
  lv.sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price))
  const mid = (Number(book.bids[0].price) + Number(book.asks[0].price)) / 2
  const fee = ctx.venues.crypto.rules(inst).feeRate
  const feeRate = Number(fee)
  const sources: Source[] = [bookSource(lv.map((l) => ({ price: l.price, paise: Math.round(l.price * l.qty * 100) })), feeRate), ...DEALERS.map((d) => dealerSource(d, mid, side))]
  const split = splitOrder(sources, side, amountPaise)
  const alone = sources.map((s) => splitOrder([s], side, amountPaise))
  const avg = (paise: number, qty: number): number | null => (qty > 0 ? paise / 100 / qty : null)
  const out: SourceQuote[] = sources.map((s, i) => {
    const a = avg(split.taken[i]!, split.qty[i]!), al = avg(alone[i]!.filled, alone[i]!.qty[0]!)
    return { id: s.id, label: s.label, simulated: s.simulated, executable: s.executable, note: s.note, sharePaise: Math.round(split.taken[i]!), qty: split.qty[i]!, avgPrice: a, slippageBps: a === null ? null : ((side === 'buy' ? a - mid : mid - a) / mid) * 10_000,
      feePaise: s.id === 'paper-book' ? Math.ceil(split.taken[i]! * feeRate) : 0, complete: split.taken[i]! > 0, alonePrice: al, aloneComplete: alone[i]!.filled >= amountPaise - 1 }
  })
  const full = out.filter((o) => o.aloneComplete && o.alonePrice !== null)
  const bestAlone = full.length ? full.reduce((a, b) => ((side === 'buy' ? b.alonePrice! < a.alonePrice! : b.alonePrice! > a.alonePrice!) ? b : a)) : null
  const splitAvg = avg(split.filled, split.qty.reduce((a, b) => a + b, 0))
  const improvement = bestAlone && splitAvg !== null ? ((side === 'buy' ? bestAlone.alonePrice! - splitAvg : splitAvg - bestAlone.alonePrice!) / bestAlone.alonePrice!) * 10_000 : null
  return { ...base, name: inst.name, kind: 'crypto', mid, sources: out, splitAvgPrice: splitAvg, bestAlone: bestAlone ? { id: bestAlone.id, label: bestAlone.label, avgPrice: bestAlone.alonePrice! } : null, improvementBps: improvement, filledPaise: Math.round(split.filled), complete: split.filled >= amountPaise - 1,
    why: split.filled < amountPaise - 1 ? `The sources together can take ${inrExact(Math.round(split.filled))} of the ${inrExact(amountPaise)} asked.` : null }
}

/** Where the order's shares sit against the minimum-variance mix of the same investments, with the solve's certificate. */
function minVarianceCheck(db: Db, legs: LegQuote[]): RfqResult['minVariance'] {
  const buys = legs.filter((l) => l.side === 'buy')
  const ids = [...new Set(buys.map((l) => l.instrumentId))]
  if (buys.length !== legs.length) return { applies: false, why: 'The check is for an order that buys a mix. This order sells.' }
  if (ids.length < 2) return { applies: false, why: 'The order is for one investment, so there is no mix to compare.' }
  if (ids.length > 6) return { applies: false, why: 'The check covers up to six investments.' }
  const opt = optimiseMix(db, ids, 'minvar')
  if (!opt.ok) return { applies: false, why: opt.why }
  const total = buys.reduce((s, l) => s + l.amountPaise, 0)
  const shares = ids.map((id, i) => ({ instrumentId: id, name: buys.find((l) => l.instrumentId === id)!.name, orderBps: Math.round((buys.filter((l) => l.instrumentId === id).reduce((s, l) => s + l.amountPaise, 0) / total) * 10_000), minVarianceBps: Math.round(opt.w[i]! * 10_000) }))
  const maxGap = Math.max(...shares.map((s) => Math.abs(s.orderBps - s.minVarianceBps)))
  return { applies: true, why: null, certified: opt.certified, certificate: opt.cert, observations: opt.observations, window: { from: opt.from, to: opt.to }, shares, maxGapBps: maxGap, matches: maxGap <= 100 }
}

export async function requestQuotes(ctx: Ctx, ws: string, by: { personId: string; role: Role }, input: { legs?: unknown; minVarianceCheck?: unknown }, now: number): Promise<RfqResult> {
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot ask for quotes.')
  const raw = Array.isArray(input.legs) ? input.legs as Record<string, unknown>[] : []
  if (!raw.length) throw bad('Add at least one investment to the order.', { legs: 'Add one.' })
  if (raw.length > MAX_LEGS) throw bad(`At most ${MAX_LEGS} investments in one request.`, { legs: 'Too many.' })
  const legsIn = raw.map((l) => {
    const amount = Number(l.amountPaise), side = l.side === 'sell' ? 'sell' as const : 'buy' as const
    if (typeof l.instrumentId !== 'string') throw bad('Choose the investment.', { legs: 'Choose one.' })
    if (!Number.isSafeInteger(amount) || amount < MIN_ORDER_PAISE) throw bad('Each amount must be at least ₹10,000: below that there is little to compare.', { legs: 'At least ₹10,000.' })
    return { instrumentId: l.instrumentId, side, amountPaise: amount }
  })
  const legs: LegQuote[] = []
  for (const l of legsIn) legs.push(await legQuote(ctx, l.instrumentId, l.side, l.amountPaise, now))
  const id = newId('rfq', now)
  const result: RfqResult = { id, createdAt: now, validUntil: now + QUOTE_VALID_MS, legs, simulatedNote: SIMULATED_NOTE, minVariance: input.minVarianceCheck === false ? { applies: false, why: 'Not asked for.' } : minVarianceCheck(ctx.db, legs) }
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO rfqs (id, workspace_id, created_by, created_at, valid_until, request_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ws, by.personId, now, now + QUOTE_VALID_MS, j(legsIn), j(result))
    audit(ctx.db, now, ws, 'owner', 'rfq.request', id, { legs: legsIn, by: by.personId })
  })
  return result
}

export function listQuotes(db: Db, ws: string, limit = 10): RfqResult[] {
  return db.all<{ result_json: string }>('SELECT result_json FROM rfqs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', ws, limit).map((r) => parse<RfqResult>(r.result_json, null as never))
}
