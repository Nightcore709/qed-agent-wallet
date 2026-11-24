/**
 * What a holding was bought at, and why its value changed (R12 task comparison, gap 17: T4-b and T4-c).
 *
 * Bought at: the open purchases (tax lots grouped by the order that made them), each with the day its units were
 * allotted or filled, the NAV day, the price, the units still held and what they cost; and the average price of the
 * units held.
 *
 * Why it changed: the holding's value now, the change from nothing before it was first bought, split exactly, in paise,
 * into three lines read from the ledger's own entries for it:
 *
 *   money added, less money taken out   what left the bank for each purchase; what reached it (or is due to it) for each sale
 *   price movement on the units held    the units held times each change of price, from fill to fill and to today's price
 *   costs                               fees (a venue fee, an exit load), stamp duty, taxes (tax deducted at source), and
 *                                       rounding: money that bought less than the smallest unit the venue deals in, and
 *                                       the fraction of a paisa the value shown is rounded down by
 *
 * Money is integers throughout. Each fill's exact value (units times price) is kept in a fine unit, 10^(base scale +
 * PRICE_SCALE - quote scale) of them to a paisa, so nothing is rounded until the rounding line, which is rounded once,
 * half away from zero. Price movement is then what makes the three lines add up to the change, and it is within half a
 * paisa of the exact units-times-price-changes figure (server/performance.test.ts proves both for purchases, partial
 * sales and costs).
 *
 * The annual rate is money-weighted: the XIRR of the dated cash flows (money put in negative on the day it left the
 * bank, money taken out positive on the day it reached the bank, and today's value positive today), Actual/365. It is
 * shown only for a holding held for at least ANNUAL_MIN_DAYS; over a shorter time a yearly rate is mostly a few days'
 * movement multiplied up. Nothing here forecasts anything: every figure is a record of what happened.
 */
import { type Db, parse } from './core.ts'
import { type Instrument, instrument } from './registry.ts'
import type { HoldingView } from './valuation.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { fmtPrice, parsePrice, PRICE_SCALE, pow10 } from '../shared/fixed.ts'

/** One fill that changed the holding, in the ledger's own figures. */
export interface Flow {
  side: 'buy' | 'sell'
  /** units, in the holding's atoms (always positive) */
  qty: bigint
  /** the fill's price, at PRICE_SCALE */
  price: bigint
  /** the consideration in paise: what the units cost or fetched before any charge */
  gross: bigint
  fee: bigint; stamp: bigint; tax: bigint
  /** money added (a purchase: what left the bank) or taken out (a sale: what reached, or is due to, the bank), in paise */
  cash: bigint
}

export interface Bridge {
  /** the value now, rounded down as the holding shows it: the change from nothing before the first purchase */
  change: bigint
  added: bigint; takenOut: bigint
  /** money added less money taken out */
  flows: bigint
  /** price movement on the units while they were held */
  movement: bigint
  /** fees, stamp duty, taxes and rounding */
  costs: bigint; fees: bigint; stamp: bigint; taxes: bigint; rounding: bigint
  buys: number; sells: number
}

/** Fine units in one paisa for a holding of these scales: a fill's exact value, units times price, is an integer of them. */
export function fineUnit(baseScale: number, quoteScale: number): bigint {
  const e = baseScale + PRICE_SCALE - quoteScale
  if (e < 0) throw new RangeError('the quote has more places than a fill can be valued in exactly')
  return pow10(e)
}

/** n / d rounded half away from zero (d > 0). */
const roundHalf = (n: bigint, d: bigint): bigint => (n >= 0n ? (2n * n + d) / (2n * d) : -((-2n * n + d) / (2n * d)))

/**
 * The three lines for a holding of `qtyNow` atoms valued at `priceNow`, from the fills since it was last empty, oldest
 * first. Throws when the flows do not reconcile (money that is not the consideration plus or minus its charges, a sale
 * of more than was held, or units that do not add up to the holding): a figure that cannot be reconciled is not shown.
 */
export function bridge(flows: readonly Flow[], qtyNow: bigint, priceNow: bigint, baseScale: number, quoteScale: number): Bridge {
  const D = fineUnit(baseScale, quoteScale)
  let added = 0n, takenOut = 0n, fees = 0n, stamp = 0n, taxes = 0n, rounded = 0n, q = 0n, buys = 0, sells = 0
  for (const f of flows) {
    if (f.qty <= 0n || f.price <= 0n) throw new RangeError('a fill has no units or no price')
    const exact = f.qty * f.price
    const charges = f.fee + f.stamp + f.tax
    if (f.side === 'buy') {
      if (f.cash !== f.gross + charges) throw new RangeError('a purchase does not reconcile: the money that left the bank is not the consideration plus its charges')
      added += f.cash; rounded += f.gross * D - exact; q += f.qty; buys++
    } else {
      if (f.cash !== f.gross - charges) throw new RangeError('a sale does not reconcile: the money taken out is not the consideration less its charges')
      if (f.qty > q) throw new RangeError('a sale of more units than were held')
      takenOut += f.cash; rounded += exact - f.gross * D; q -= f.qty; sells++
    }
    fees += f.fee; stamp += f.stamp; taxes += f.tax
  }
  if (q !== qtyNow) throw new RangeError(`the fills come to ${q} units; the holding is ${qtyNow}`)
  const exactNow = qtyNow * priceNow
  const change = exactNow / D // rounded down: the value the holding shows (valuation.ts, notional 'down')
  const rounding = roundHalf(rounded + (exactNow - change * D), D)
  const costs = fees + stamp + taxes + rounding
  const net = added - takenOut
  return { change, added, takenOut, flows: net, movement: change - net + costs, costs, fees, stamp, taxes, rounding, buys, sells }
}

// ------------------------------------------------------------------------------------------------ the annual rate

export interface CashFlow { at: number; amount: number }
/** `ln` is ln(1 + rate), what the equation is solved for; `rate` is e^ln - 1, the yearly rate shown. */
export type Xirr = { rate: number; ln: number; npv: number; size: number } | { rate: null; why: 'one-sided' | 'none' | 'several' }
/**
 * The stated tolerance: at the rate given, the cash flows discounted to the first one's day sum to zero within a
 * billionth of their discounted sizes, |Σ a e^(-ln t)| <= 1e-9 Σ |a e^(-ln t)|, each amount a dated t years (Actual/365)
 * after the first and ln = ln(1 + rate). It is stated in ln and against the discounted sizes because a rate near -100% a
 * year cannot be held in a double closely enough for any other test to be met (1 + r loses its digits), and its
 * discount factors dwarf the amounts.
 */
export const XIRR_TOLERANCE = 1e-9
const YEAR_MS = 365 * 86_400_000
/** A holding younger than this shows no annual rate, with the reason. */
export const ANNUAL_MIN_DAYS = 365

/** The cash flows discounted at a log growth rate `ln` = ln(1 + r) to the first one's day: their sum, and the sum of their sizes. */
export function discounted(cfs: readonly CashFlow[], ln: number): { npv: number; size: number } {
  const t0 = Math.min(...cfs.map((c) => c.at))
  let npv = 0, size = 0
  for (const c of cfs) { const v = c.amount * Math.exp(-ln * ((c.at - t0) / YEAR_MS)); npv += v; size += Math.abs(v) }
  return { npv, size }
}

/**
 * The money-weighted annual rate r > -1 at which Σ amount (1 + r)^-(t - t0)/365 days = 0, solved for x = ln(1 + r).
 * Sign changes are looked for on a grid of x within ±50 (every term kept inside a double's range), which covers from
 * about -100% to far more than any rate a holding meets; in the one interval where the sum changes sign, Newton's
 * method is kept inside the bracket and replaced by halving whenever it would leave it or slow down (Numerical
 * Recipes' rtsafe). Money that moves one way only has no rate; several sign changes mean several rates, and none is
 * chosen for the owner.
 */
export function xirr(cfs: readonly CashFlow[]): Xirr {
  const live = cfs.filter((c) => c.amount !== 0)
  if (!live.some((c) => c.amount < 0) || !live.some((c) => c.amount > 0)) return { rate: null, why: 'one-sided' }
  const t0 = Math.min(...live.map((c) => c.at))
  const tau = live.map((c) => (c.at - t0) / YEAR_MS)
  const tMax = Math.max(...tau, 1e-9)
  const f = (x: number): number => live.reduce((s, c, k) => s + c.amount * Math.exp(-x * tau[k]!), 0)
  const df = (x: number): number => live.reduce((s, c, k) => s - c.amount * tau[k]! * Math.exp(-x * tau[k]!), 0)
  const reach = Math.min(50, 600 / tMax)
  const steps = 4000
  const crossings: [number, number][] = []
  // Laguerre's rule of signs: the sum has at most as many rates as the dated amounts (same day summed) change sign. With
  // one change it has exactly one; with more, two rates can sit inside one step of the grid, where the sum's sign does
  // not differ at the step's ends but its slope does: that step is searched for the turn, and if the sum crosses zero
  // there, there are two rates in it (R13: flows whose rates were 11.05%, 11.11% and 100% were given "100%").
  const byDay = new Map<number, number>()
  for (const [k, c] of live.entries()) byDay.set(tau[k]!, (byDay.get(tau[k]!) ?? 0) + c.amount)
  const signs = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => Math.sign(a)).filter((s) => s !== 0)
  const changes = signs.reduce((n, s, i) => n + (i > 0 && s !== signs[i - 1] ? 1 : 0), 0)
  const turnCrosses = (lo: number, hi: number, fLo: number): boolean => {
    let dlo = df(lo)
    if (Math.sign(dlo) === Math.sign(df(hi))) return false
    for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); i++) { const mid = (lo + hi) / 2, dm = df(mid); if (Math.sign(dm) === Math.sign(dlo)) { lo = mid; dlo = dm } else hi = mid }
    const fm = f((lo + hi) / 2)
    return fm === 0 || Math.sign(fm) !== Math.sign(fLo)
  }
  let xa = -reach, fa = f(xa)
  for (let i = 1; i <= steps; i++) {
    const xb = -reach + (2 * reach * i) / steps, fb = f(xb)
    if (fa === 0) crossings.push([xa, xa])
    else if (fb !== 0 && Math.sign(fa) !== Math.sign(fb)) crossings.push([xa, xb])
    else if (changes > 1 && fb !== 0 && turnCrosses(xa, xb, fa)) crossings.push([xa, xb], [xa, xb]) // two rates in one step
    xa = xb; fa = fb
  }
  if (fa === 0) crossings.push([xa, xa])
  if (crossings.length === 0) return { rate: null, why: 'none' }
  if (crossings.length > 1) return { rate: null, why: 'several' }
  const [a, b] = crossings[0]!
  let x = a
  if (a !== b) {
    // orient the bracket so that f(xl) < 0 < f(xh)
    let [xl, xh] = f(a) < 0 ? [a, b] : [b, a]
    x = (a + b) / 2
    let dxOld = Math.abs(b - a), dx = dxOld
    let fx = f(x), dfx = df(x)
    for (let i = 0; i < 400; i++) {
      if (((x - xh) * dfx - fx) * ((x - xl) * dfx - fx) > 0 || Math.abs(2 * fx) > Math.abs(dxOld * dfx)) {
        dxOld = dx; dx = (xh - xl) / 2; x = xl + dx
      } else {
        dxOld = dx; dx = fx / dfx; x -= dx
      }
      if (Math.abs(dx) <= 4e-16 * Math.max(1, Math.abs(x))) break
      fx = f(x); dfx = df(x)
      if (fx === 0) break
      if (fx < 0) xl = x; else xh = x
    }
  }
  return { rate: Math.expm1(x), ln: x, ...discounted(live, x) }
}

// ------------------------------------------------------------------------------------------------ from the ledger

/** One open purchase: the lots one order made, with the units still held from it. */
export interface PurchaseView { at: number; navDate: string | null; price: string; bought: string; held: string; cost: number }
export interface WhyView { since: number; added: number; takenOut: number; buys: number; sells: number; flows: number; movement: number; costs: number; fees: number; stamp: number; taxes: number; rounding: number; change: number }
export interface AnnualView { method: 'xirr'; minDays: number; heldDays: number; rate: number | null; reason: 'young' | 'one-sided' | 'none' | 'several' | 'no-price' | 'unreconciled' | null }
export interface HoldingStory { purchases: PurchaseView[]; boughtAt: { price: string; purchases: number; first: number; last: number } | null; why: WhyView | null; annual: AnnualView }

const DAY_MS = 86_400_000
const BUY_KINDS = new Set(['buy', 'fund-units-allotted'])
const SELL_KINDS = new Set(['sell', 'fund-units-redeemed'])

interface Row { id: string; seq: number; effective_ts: number; kind: string; meta_json: string }

/**
 * A holding's purchases, what it was bought at, why it changed and its annual rate, from the ledger: the entries that
 * moved its units (each fill, posted once by server/execute.ts bookFill) and the open lots. `qtyNow` is the holding as
 * its account holds it; `priceNow` the price it is valued at, or null when there is none.
 */
export function holdingStory(db: Db, userId: string, inst: Instrument, qtyNow: bigint, priceNow: string | null, now: number): HoldingStory {
  const pos = `pos:${inst.id}`
  const rows = db.all<Row>(`SELECT e.id, e.seq, e.effective_ts, e.kind, e.meta_json FROM entries e WHERE e.user_id = ? AND e.id IN (
      SELECT p.entry_id FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ? AND a.code = ?) ORDER BY e.seq`, userId, userId, pos)
  const lines = new Map<string, Map<string, bigint>>()
  for (const p of db.all<{ entry_id: string; code: string; amount_text: string }>(`SELECT p.entry_id, a.code, p.amount_text FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id IN (
      SELECT p2.entry_id FROM postings p2 JOIN accounts a2 ON a2.id = p2.account_id WHERE a2.user_id = ? AND a2.code = ?)`, userId, pos)) {
    const m = lines.get(p.entry_id) ?? new Map<string, bigint>()
    m.set(p.code, (m.get(p.code) ?? 0n) + fromAmountText(p.amount_text, `a posting of ${p.entry_id}`))
    lines.set(p.entry_id, m)
  }
  // the fills since the holding was last empty: the holding's present life
  let start = 0, run = 0n
  rows.forEach((r, i) => { run += lines.get(r.id)?.get(pos) ?? 0n; if (run === 0n) start = i + 1 })
  const life = rows.slice(start)
  const fund = inst.kind === 'mutual_fund'
  const paidAt = fund ? new Map(db.all<{ a: string | null; t: number }>(`SELECT json_extract(meta_json, '$.actionId') a, effective_ts t FROM entries WHERE user_id = ? AND kind = 'fund-purchase-paid'`, userId).map((r) => [String(r.a), r.t])) : new Map<string, number>()
  const flows: Flow[] = []
  const dated: CashFlow[] = []
  let reconciles = true
  for (const r of life) {
    const l = lines.get(r.id) ?? new Map<string, bigint>()
    const meta = parse<{ price?: string; actionId?: string; fillId?: string }>(r.meta_json, {})
    const units = l.get(pos) ?? 0n
    const side = BUY_KINDS.has(r.kind) && units > 0n ? 'buy' : SELL_KINDS.has(r.kind) && units < 0n ? 'sell' : null
    if (!side || !meta.price) { reconciles = false; continue }
    const get = (code: string): bigint => l.get(code) ?? 0n
    const gross = side === 'buy' ? get('trade:INR') : -get('trade:INR')
    const cashAccounts = get('bank') + get('clear:mf') + get('recv:mf')
    const f: Flow = { side, qty: side === 'buy' ? units : -units, price: parsePrice(meta.price), gross, fee: get('exp:fees'), stamp: get('exp:stamp'), tax: get('tds'), cash: side === 'buy' ? -cashAccounts : cashAccounts }
    flows.push(f)
    // the day the money moved: a fund purchase left the bank when it was ordered; a redemption reaches it on its payout
    // day, and until then it is money due to you, counted as today's; everything else moved with the fill
    let at = r.effective_ts
    if (fund && side === 'buy' && meta.actionId && paidAt.has(meta.actionId)) at = paidAt.get(meta.actionId)!
    if (fund && side === 'sell') at = db.get<{ t: number }>(`SELECT effective_ts t FROM entries WHERE user_id = ? AND ref = ?`, userId, `cash:${meta.fillId ?? ''}`)?.t ?? now
    dated.push({ at, amount: Number(side === 'buy' ? -f.cash : f.cash) })
  }
  const purchases = openPurchases(db, userId, inst)
  const heldInLots = purchases.reduce((s, p) => s + BigInt(p.held), 0n)
  const boughtAt = purchases.length && heldInLots === qtyNow ? averageOf(db, userId, inst, purchases) : null
  const since = life[0]?.effective_ts ?? now
  const heldDays = Math.floor((now - since) / DAY_MS)
  const annual: AnnualView = { method: 'xirr', minDays: ANNUAL_MIN_DAYS, heldDays, rate: null, reason: null }
  let why: WhyView | null = null
  if (priceNow === null) annual.reason = 'no-price'
  else if (!reconciles) annual.reason = 'unreconciled'
  else {
    try {
      const b = bridge(flows, qtyNow, parsePrice(priceNow), inst.baseScale, inst.quoteScale)
      why = { since, added: Number(b.added), takenOut: Number(b.takenOut), buys: b.buys, sells: b.sells, flows: Number(b.flows), movement: Number(b.movement), costs: Number(b.costs), fees: Number(b.fees), stamp: Number(b.stamp), taxes: Number(b.taxes), rounding: Number(b.rounding), change: Number(b.change) }
      if (heldDays < ANNUAL_MIN_DAYS) annual.reason = 'young'
      else {
        const r = xirr([...dated, { at: now, amount: Number(b.change) }])
        if (r.rate === null) annual.reason = r.why
        else annual.rate = r.rate
      }
    } catch { annual.reason = 'unreconciled' }
  }
  return { purchases, boughtAt, why, annual }
}

/** The open lots grouped by the order whose fills made them, oldest first, each with the units still held and their cost. */
function openPurchases(db: Db, userId: string, inst: Instrument): PurchaseView[] {
  const lots = db.all<{ id: string; opened_at: number; qty: string; remaining: string; cost: string; meta_json: string | null }>(
    `SELECT l.id, l.opened_at, CAST(l.qty AS TEXT) qty, CAST(l.remaining AS TEXT) remaining, CAST(l.cost AS TEXT) cost, e.meta_json FROM lots l LEFT JOIN entries e ON e.id = l.entry_id
     WHERE l.user_id = ? AND l.instrument_id = ? AND l.remaining > 0 ORDER BY l.opened_at, l.id`, userId, inst.id)
  const groups = new Map<string, { at: number; navDate: string | null; bought: bigint; held: bigint; cost: bigint; worth: bigint }>()
  for (const l of lots) {
    const meta = parse<{ price?: string; navDate?: string | null; venueOrderId?: string; actionId?: string }>(l.meta_json, {})
    const qty = fromAmountText(l.qty, `lot ${l.id}`), rem = fromAmountText(l.remaining, `lot ${l.id}`), cost = fromAmountText(l.cost, `lot ${l.id}`)
    const key = meta.venueOrderId ?? meta.actionId ?? l.id
    const g = groups.get(key) ?? { at: l.opened_at, navDate: meta.navDate ?? null, bought: 0n, held: 0n, cost: 0n, worth: 0n }
    g.bought += qty; g.held += rem
    g.cost += (cost * rem) / qty // as openCost counts it, so the purchases add up to the cost the holding shows
    g.worth += qty * parsePrice(meta.price ?? '0')
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({ at: g.at, navDate: g.navDate, price: fmtPrice(g.bought > 0n ? roundHalf(g.worth, g.bought) : 0n, 0), bought: g.bought.toString(), held: g.held.toString(), cost: Number(g.cost) }))
}

/** The average price of the units held: each open lot's price weighted by the units still held from it. */
function averageOf(db: Db, userId: string, inst: Instrument, purchases: PurchaseView[]): HoldingStory['boughtAt'] {
  const lots = db.all<{ remaining: string; meta_json: string | null }>(`SELECT CAST(l.remaining AS TEXT) remaining, e.meta_json FROM lots l LEFT JOIN entries e ON e.id = l.entry_id WHERE l.user_id = ? AND l.instrument_id = ? AND l.remaining > 0`, userId, inst.id)
  let units = 0n, worth = 0n
  for (const l of lots) { const rem = fromAmountText(l.remaining, 'a lot'); units += rem; worth += rem * parsePrice(parse<{ price?: string }>(l.meta_json, {}).price ?? '0') }
  if (units === 0n) return null
  return { price: fmtPrice(roundHalf(worth, units), 0), purchases: purchases.length, first: purchases[0]!.at, last: purchases[purchases.length - 1]!.at }
}

/** Each holding with its story, as /api/home sends them to Grow. A holding whose instrument is unknown is sent as it is. */
export function withStories(db: Db, userId: string, hs: HoldingView[], now: number): HoldingView[] {
  return hs.map((h) => {
    const inst = instrument(db, h.instrumentId)
    return inst ? { ...h, story: holdingStory(db, userId, inst, BigInt(h.qtyAtomsText), h.price, now) } : h
  })
}
