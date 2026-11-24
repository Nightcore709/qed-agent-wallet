/**
 * Grow's comparison with a benchmark the owner chooses, and its risk estimates (R13, audit G5 and G9).
 *
 * No benchmark is chosen for the owner: the choice decides what "doing better" means, and a benchmark that does not look
 * like what is held makes any comparison misleading. The choices are offered, and nothing is compared until one is picked.
 *
 * The comparison replays the owner's own flows. Over each window, the same rupees go into the benchmark on the same days
 * the owner's went into the holdings, and come out on the same days; both ends are valued at the same last close. Both
 * sides are after costs: the owner's flows are what actually left and reached the bank (fees, stamp duty and securities
 * transaction tax inside them), and the benchmark's purchases and sales pay its own costs under the same terms. A window
 * that starts after the first purchase carries over the value at its start on both sides without a cost. The values at
 * the end are marks at the last close: neither side has paid to sell, nor tax on its gain.
 *
 * Uncertainty: the difference between the two daily returns, its standard error from the days of the window and the
 * interval it gives, with the caveats that the days are treated as independent and that few days say little.
 *
 * Risk estimates: a historical-simulation value at risk and expected shortfall of today's holdings over past days. They
 * are estimates with their method, window and confidence, never limits and never protections: nothing in QED is set by them.
 */
import { addDays, type Db, ist } from './core.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { isSecurity, securityCosts } from './securities.ts'
import { type Instrument, instrument, instruments, term } from './registry.ts'
import type { HoldingView } from './valuation.ts'

export interface Point { d: string; v: number }
const DAY = 86_400_000
const dayNo = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY)

function seriesOf(db: Db, id: string): Point[] {
  return db.all<{ value_date: string; value: string }>('SELECT value_date, value FROM daily_values WHERE instrument_id = ? ORDER BY value_date', id).map((r) => ({ d: r.value_date, v: Number(r.value) })).filter((p) => Number.isFinite(p.v) && p.v > 0)
}
/** The last value on or before a date (binary search); null before the series begins. */
function at(s: Point[], d: string): number | null {
  let lo = 0, hi = s.length - 1, best = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid]!.d <= d) { best = mid; lo = mid + 1 } else hi = mid - 1 }
  return best < 0 ? null : s[best]!.v
}

export interface Choice { id: string; label: string; group: string; observations: number; usable: boolean; note: string }
export const EQUAL_WEIGHT = 'equal-weight'
const MIN_HISTORY = 30

/** What can be chosen as a benchmark: every instrument with a daily history, and the owner's own holdings at equal weight. */
export function benchmarkChoices(db: Db): Choice[] {
  const out: Choice[] = []
  for (const i of instruments(db)) {
    if (!(i.kind === 'mutual_fund' || isSecurity(i))) continue
    const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM daily_values WHERE instrument_id = ?', i.id)!.n
    const synthetic = i.provider === 'synthetic-markets'
    out.push({ id: i.id, label: i.name, group: i.kind === 'mutual_fund' ? 'Mutual funds' : i.kind === 'etf' ? 'ETFs' : i.kind === 'equity' ? 'Shares' : 'Government securities', observations: n, usable: n >= MIN_HISTORY,
      note: n < MIN_HISTORY ? `Only ${n} daily value${n === 1 ? '' : 's'} on record: too few to compare against.` : synthetic ? 'A synthetic price series generated on this computer, not market data.' : 'Published NAVs on record.' })
  }
  out.push({ id: EQUAL_WEIGHT, label: 'Equal weight of everything you have held (1/N)', group: 'Your own holdings', observations: 0, usable: true, note: 'Each holding with a daily history gets the same share every day. It ignores trading costs, so it flatters itself.' })
  return out
}

interface Fill { instrumentId: string; side: 'buy' | 'sell'; date: string; cash: number }
interface Book { fills: Fill[]; ids: string[]; series: Map<string, Point[]>; excluded: { id: string; name: string; value: number }[] }

function loadBook(db: Db, userId: string, hs: HoldingView[]): Book {
  const rows = db.all<{ instrument_id: string; side: string; ts: number; amount: string; fee: string; tax: string; qty: string }>(`SELECT instrument_id, side, ts, CAST(amount AS TEXT) amount, CAST(fee AS TEXT) fee, CAST(tax AS TEXT) tax, CAST(qty AS TEXT) qty FROM pv_fills WHERE user_id = ? ORDER BY ts, id`, userId)
  const series = new Map<string, Point[]>()
  const excluded = new Map<string, { id: string; name: string; value: number }>()
  const fills: Fill[] = []
  for (const r of rows) {
    if (!series.has(r.instrument_id)) series.set(r.instrument_id, seriesOf(db, r.instrument_id))
    if (series.get(r.instrument_id)!.length < MIN_HISTORY) { const h = hs.find((x) => x.instrumentId === r.instrument_id); excluded.set(r.instrument_id, { id: r.instrument_id, name: instrument(db, r.instrument_id)?.name ?? r.instrument_id, value: h?.value ?? 0 }); continue }
    const amount = Number(r.amount), fee = Number(r.fee), tax = Number(r.tax)
    fills.push({ instrumentId: r.instrument_id, side: r.side as 'buy' | 'sell', date: ist(r.ts).date, cash: r.side === 'buy' ? amount + fee + tax : amount - fee - tax })
  }
  const ids = [...new Set(fills.map((f) => f.instrumentId))]
  return { fills, ids, series, excluded: [...excluded.values()] }
}

function unitsAt(db: Db, userId: string, id: string, date: string): number {
  const r = db.get<{ b: string; s: string }>(`SELECT amount_sum(CASE WHEN side = 'buy' THEN qty ELSE 0 END) b, amount_sum(CASE WHEN side = 'sell' THEN qty ELSE 0 END) s FROM pv_fills WHERE user_id = ? AND instrument_id = ? AND ts < ?`, userId, id, Date.parse(`${addDays(date, 1)}T00:00:00Z`) - 19_800_000)
  const inst = instrument(db, id)
  return Number(fromAmountText(r?.b, `the bought ${id}`) - fromAmountText(r?.s, `the sold ${id}`)) / 10 ** (inst?.baseScale ?? 0)
}

/** The benchmark's price index on each date it has one: a published series, or the daily-rebalanced equal weight of the held series. */
function benchmarkSeries(db: Db, id: string, held: Map<string, Point[]>): Point[] {
  if (id !== EQUAL_WEIGHT) return seriesOf(db, id)
  const all = [...held.values()].filter((s) => s.length >= MIN_HISTORY)
  if (!all.length) return []
  const dates = [...new Set(all.flatMap((s) => s.map((p) => p.d)))].sort()
  const out: Point[] = []
  let level = 100, prev: string | null = null
  for (const d of dates) {
    if (prev !== null) {
      const rs = all.map((s) => { const a = at(s, prev!), b = at(s, d); return a && b ? b / a - 1 : null }).filter((x): x is number => x !== null)
      if (rs.length) level *= 1 + rs.reduce((s, x) => s + x, 0) / rs.length
    }
    out.push({ d, v: level }); prev = d
  }
  return out
}

/** Cost rates of buying and selling one rupee of the benchmark: its own terms, never the owner's. A composite pays none. */
function benchCosts(db: Db, inst: Instrument | undefined): { buy: number; sell: number; note: string } {
  if (!inst) return { buy: 0, sell: 0, note: 'It pays no trading costs.' }
  if (inst.kind === 'mutual_fund') { const r = Number(term(db, 'mf.stamp')?.value.rate ?? 0.00005); return { buy: r, sell: 0, note: `Stamp duty ${(r * 100).toFixed(3)}% on each purchase; no exit load modelled on the sales.` } }
  if (isSecurity(inst) && inst.venue === 'paper-exchange') {
    const g = 100_000_00n
    const b = securityCosts(db, inst, 'buy', g), s = securityCosts(db, inst, 'sell', g)
    return { buy: Number(b.fee + b.tax) / Number(g), sell: Number(s.fee) / Number(g), note: 'The exchange\'s costs on a ₹1,00,000 trade, as a share, on each purchase and sale.' }
  }
  return { buy: 0, sell: 0, note: 'It pays no brokerage or tax; the gap between buy and sell prices is not counted.' }
}

export interface CompareWindow {
  id: string; label: string; from: string; to: string; observations: number; ok: boolean; why?: string
  portfolio?: { startValue: number; endValue: number; bought: number; sold: number; gain: number; dietz: number }
  benchmark?: { endValue: number; gain: number; dietz: number; costs: string }
  difference?: { rupees: number; points: number }
  active?: { meanDaily: number; se: number; t: number; annualisedLow: number; annualisedHigh: number; enough: boolean }
}
export interface Comparison {
  asOf: number; chosen: string | null; choices: Choice[]; statement: string
  windows: CompareWindow[]; excluded: { id: string; name: string; value: number }[]; method: string[]
}
const STATEMENT = 'QED does not choose a benchmark for you. The choice decides what doing better means, and a benchmark unlike what you hold makes any comparison misleading. Pick one below.'

export function compare(db: Db, userId: string, hs: HoldingView[], chosen: string | null, now: number): Comparison {
  const choices = benchmarkChoices(db)
  const base: Comparison = { asOf: now, chosen: null, choices, statement: STATEMENT, windows: [], excluded: [], method: [] }
  if (!chosen) return base
  if (!choices.some((c) => c.id === chosen && c.usable)) return { ...base, windows: [], method: [`That cannot be used as a benchmark: ${choices.find((c) => c.id === chosen)?.note ?? 'it is not one of the choices'}`] }
  const book = loadBook(db, userId, hs)
  const bench = benchmarkSeries(db, chosen, book.series)
  const out: Comparison = { ...base, chosen, excluded: book.excluded }
  const binst = chosen === EQUAL_WEIGHT ? undefined : instrument(db, chosen)
  const costs = benchCosts(db, binst)
  out.method = [
    'Your own flows are replayed: the same rupees go into the benchmark on the days yours went into the holdings, and come out on the days yours came out.',
    `Both sides are after costs. Yours are what actually left and reached your bank. ${costs.note} A window that begins after your first purchase carries its starting value over on both sides without a cost.`,
    'Both ends are valued at the same last close on record. Neither side has paid to sell, nor tax on its gain.',
    'The difference in daily returns, with its standard error and a 95% interval, is the uncertainty. It treats the days as independent; if they are not the interval is too narrow, and a few days say very little.',
  ]
  if (book.fills.length === 0) return { ...out, windows: [{ id: 'all', label: 'Since your first purchase', from: '', to: '', observations: 0, ok: false, why: 'You have bought nothing with a daily price history yet, so there is nothing to compare.' }] }
  const last = bench[bench.length - 1]!.d
  const first = book.fills[0]!.date
  const defs: [string, string, string][] = [['30d', 'The last 30 days', addDays(last, -30)], ['90d', 'The last 90 days', addDays(last, -90)], ['365d', 'The last year', addDays(last, -365)], ['all', 'Since your first purchase', addDays(first, -1)]]
  const seen = new Set<string>()
  for (const [id, label, start] of defs) {
    const from = start < bench[0]!.d ? bench[0]!.d : start
    const key = `${from}`
    if (seen.has(key)) continue
    seen.add(key)
    out.windows.push(window(db, userId, book, bench, costs, id, label, from, last))
  }
  return out
}

function window(db: Db, userId: string, book: Book, bench: Point[], costs: { buy: number; sell: number }, id: string, label: string, from: string, to: string): CompareWindow {
  const w: CompareWindow = { id, label, from, to, observations: 0, ok: false }
  const dates = bench.filter((p) => p.d > from && p.d <= to).map((p) => p.d)
  w.observations = dates.length
  if (dates.length < 2) return { ...w, why: 'Fewer than two daily values fall in this window.' }
  const value = (d: string): number => book.ids.reduce((s, i) => { const u = unitsAt(db, userId, i, d), p = at(book.series.get(i)!, d); return s + (u > 0 && p ? u * p : 0) }, 0) * 100 // paise
  const flows = book.fills.filter((f) => f.date > from && f.date <= to)
  const v0 = value(from), v1 = value(to)
  const span = Math.max(1, dayNo(to) - dayNo(from))
  const bought = flows.filter((f) => f.side === 'buy').reduce((s, f) => s + f.cash, 0), sold = flows.filter((f) => f.side === 'sell').reduce((s, f) => s + f.cash, 0)
  const denom = v0 + flows.reduce((s, f) => s + (f.side === 'buy' ? f.cash : -f.cash) * ((dayNo(to) - dayNo(f.date)) / span), 0)
  if (!(denom > 0)) return { ...w, why: 'No money was invested during this window, so it has no return.' }
  const gain = v1 - v0 - bought + sold
  const p0 = at(bench, from) ?? bench[0]!.v
  let units = v0 / p0
  for (const f of flows) {
    const p = at(bench, f.date) ?? p0
    units += f.side === 'buy' ? (f.cash * (1 - costs.buy)) / p : -f.cash / (p * (1 - costs.sell))
  }
  if (units < 0) return { ...w, why: 'The benchmark would have run out of units to pay what you took out.' }
  const bEnd = units * (at(bench, to) ?? p0)
  const bGain = bEnd - v0 - bought + sold
  w.portfolio = { startValue: Math.round(v0), endValue: Math.round(v1), bought: Math.round(bought), sold: Math.round(sold), gain: Math.round(gain), dietz: gain / denom }
  w.benchmark = { endValue: Math.round(bEnd), gain: Math.round(bGain), dietz: bGain / denom, costs: `buy ${(costs.buy * 100).toFixed(3)}%, sell ${(costs.sell * 100).toFixed(3)}%` }
  w.difference = { rupees: Math.round(gain - bGain), points: (gain - bGain) / denom }
  // the daily difference: the holdings' return over the day (flows at the close taken out) against the benchmark's
  const act: number[] = []
  let prev = from
  for (const d of dates) {
    const vPrev = value(prev)
    if (vPrev > 0) {
      const f = flows.filter((x) => x.date === d).reduce((s, x) => s + (x.side === 'buy' ? x.cash : -x.cash), 0)
      const rp = (value(d) - f) / vPrev - 1
      const rb = (at(bench, d) ?? 1) / (at(bench, prev) ?? 1) - 1
      if (Number.isFinite(rp) && Number.isFinite(rb)) act.push(rp - rb)
    }
    prev = d
  }
  if (act.length >= 2) {
    const mean = act.reduce((s, x) => s + x, 0) / act.length
    const sd = Math.sqrt(act.reduce((s, x) => s + (x - mean) ** 2, 0) / (act.length - 1))
    const se = sd / Math.sqrt(act.length)
    w.active = { meanDaily: mean, se, t: se > 0 ? mean / se : 0, annualisedLow: (mean - 1.96 * se) * 252, annualisedHigh: (mean + 1.96 * se) * 252, enough: act.length >= 60 }
  }
  w.ok = true
  return w
}

// ---------------------------------------------------------------------------------------------- risk estimates

export interface RiskEstimate {
  ok: boolean; why?: string
  method: string; confidence: number; horizon: string; window: { from: string; to: string; observations: number } | null
  covered: { value: number; share: number }; excluded: { id: string; name: string; value: number }[]
  var?: { fraction: number; rupees: number }; cvar?: { fraction: number; rupees: number }; worstDay?: { date: string; fraction: number }
  says: string
}
const NOT_A_LIMIT = 'These are estimates from past days, not limits and not protections. About one day in twenty is worse than the value at risk by construction, and the expected shortfall averages those days: a day worse than any of them can come. QED\'s own limits and your floor are set separately and are not worked out from these.'

/**
 * A historical-simulation estimate for today's holdings that have a daily history: each past day's return of the book at
 * today's weights, over up to the last 250 days, at 95% confidence over one day. Nothing is scaled to a longer horizon.
 */
export function riskEstimate(db: Db, hs: HoldingView[]): RiskEstimate {
  const method = 'Historical simulation: the return the book at today\'s weights would have had on each past day, from daily closes, over up to the last 250 days. The value at risk is the 5th-percentile day; the expected shortfall is the average of the days at or below it.'
  const base = { method, confidence: 0.95, horizon: 'one day', says: NOT_A_LIMIT }
  const total = hs.reduce((s, h) => s + (h.value ?? 0), 0)
  const priced = hs.filter((h) => (h.value ?? 0) > 0).map((h) => ({ h, s: seriesOf(db, h.instrumentId) })).filter((x) => x.s.length >= 60)
  const excluded = hs.filter((h) => (h.value ?? 0) > 0 && !priced.some((p) => p.h.instrumentId === h.instrumentId)).map((h) => ({ id: h.instrumentId, name: h.name, value: h.value ?? 0 }))
  const covered = priced.reduce((s, x) => s + (x.h.value ?? 0), 0)
  const cov = { value: covered, share: total > 0 ? covered / total : 0 }
  if (!priced.length) return { ...base, ok: false, why: 'None of what you hold has a daily price history on record, so no estimate can be made.', window: null, covered: cov, excluded }
  const dates = [...new Set(priced.flatMap((x) => x.s.map((p) => p.d)))].sort()
  const rets: { d: string; r: number }[] = []
  for (let k = 1; k < dates.length; k++) {
    let r = 0, ok = true
    for (const x of priced) { const a = at(x.s, dates[k - 1]!), b = at(x.s, dates[k]!); if (!a || !b) { ok = false; break } r += ((x.h.value ?? 0) / covered) * (b / a - 1) }
    if (ok) rets.push({ d: dates[k]!, r })
  }
  const window = rets.slice(-250)
  if (window.length < 60) return { ...base, ok: false, why: `Only ${window.length} days of history are common to everything you hold; at least 60 are needed.`, window: null, covered: cov, excluded }
  const sorted = [...window].sort((a, b) => a.r - b.r)
  const k = Math.max(1, Math.floor(window.length * 0.05))
  const varF = -sorted[k - 1]!.r
  const tail = sorted.slice(0, k)
  const cvarF = -tail.reduce((s, x) => s + x.r, 0) / tail.length
  return { ...base, ok: true, window: { from: window[0]!.d, to: window[window.length - 1]!.d, observations: window.length }, covered: cov, excluded,
    var: { fraction: varF, rupees: Math.round(varF * covered) }, cvar: { fraction: cvarF, rupees: Math.round(cvarF * covered) }, worstDay: { date: sorted[0]!.d, fraction: sorted[0]!.r } }
}
