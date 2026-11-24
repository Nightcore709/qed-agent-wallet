/**
 * The paper securities desks' rules and data (R13, audit G2): exchange-traded funds and shares on a paper exchange, a
 * Treasury bill and a government bond on a paper government-securities desk. The desks themselves are in venues.ts; this
 * module holds what they and the screens share: trading hours, the costs applied at execution, the price of a bill and a
 * bond from its yield, the coupons a bond pays, the synthetic data feed, and the catalogue of what is not offered yet.
 *
 * Data. No live market data is used for any of these. Prices come from a synthetic feed (provider "synthetic-markets"): a
 * seeded random walk that starts from a value the instrument names, with its source. An ETF starts from the NAV AMFI
 * published for its scheme on a stated day (a recorded public value, which is a fund's NAV and not an exchange price); a
 * share starts from a round number; a bill and a bond start from a round yield. Every price after the start is generated on
 * this computer. The feed's source name is shown wherever a price is.
 *
 * Costs. Every rate here is read from the terms table (registry.ts SECURITY_TERMS) when an order is filled, and each carries
 * its own status: the exchange's and SEBI's charges, securities transaction tax and stamp duty were read from their primary
 * sources on 24 Nov 2026; GST on the exchange's charges is not verified, and the brokerage and the depository charge are
 * modelled prices, not rules. The screens show each status. Market holidays are not modelled.
 */
import { addDays, type Db, ist, istInstant } from './core.ts'
import { type Market, type Provider, type Tick } from './market.ts'
import { type Instrument, type InstrumentMeta, instruments, termValue } from './registry.ts'
import { businessDayOnOrBefore, fixed, Walk } from './synthetic.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { fraction } from '../shared/fixed.ts'

export const SYNTH_MARKETS = 'synthetic-markets'
export const SECURITY_KINDS: ReadonlySet<string> = new Set(['etf', 'equity', 'tbill', 'gsec'])
export const isSecurity = (inst: { kind: string }): boolean => SECURITY_KINDS.has(inst.kind)
export const isDebt = (inst: { kind: string }): boolean => inst.kind === 'tbill' || inst.kind === 'gsec'
export const DATA_LABEL = 'Synthetic prices generated on this computer, not market data'

// ---------------------------------------------------------------------------------------------- hours

const minutesOf = (hm: string): number => { const [h, m] = hm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0) }
const HOURS_DEFAULT = { open: '09:15', close: '15:30' }

export interface Session { open: boolean; opens: string; closes: string; nextOpenAt: number | null }
/** Is the desk open at `now`: its hours, Monday to Friday, India time. Holidays are not modelled. */
export function sessionOf(inst: { meta: InstrumentMeta }, now: number): Session {
  const h = inst.meta.hours ?? HOURS_DEFAULT
  const t = ist(now)
  const weekday = t.weekday >= 1 && t.weekday <= 5
  const open = weekday && t.minutes >= minutesOf(h.open) && t.minutes < minutesOf(h.close)
  let nextOpenAt: number | null = null
  if (!open) {
    let d = weekday && t.minutes < minutesOf(h.open) ? t.date : addDays(t.date, 1)
    for (let k = 0; k < 8; k++) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w >= 1 && w <= 5) break; d = addDays(d, 1) }
    nextOpenAt = istInstant(d, h.open)
  }
  return { open, opens: h.open, closes: h.close, nextOpenAt }
}
const clock12 = (hm: string): string => { const [h, m] = hm.split(':').map(Number); return `${(h! % 12) || 12}:${String(m).padStart(2, '0')} ${h! < 12 ? 'am' : 'pm'}` }
export function closedText(inst: Instrument, now: number): string {
  const s = sessionOf(inst, now)
  const desk = inst.venue === 'paper-gsec' ? 'The government-securities desk' : 'The exchange'
  const next = s.nextOpenAt === null ? '' : ` It opens next at ${new Date(s.nextOpenAt + 19_800_000).toISOString().slice(0, 16).replace('T', ' ')} India time.`
  return `${desk} is closed. It trades ${clock12(s.opens)} to ${clock12(s.closes)} India time, Monday to Friday; market holidays are not modelled.${next}`
}

/** The date `days` business days after `date` (weekends skipped; holidays are not modelled). */
export function settlementDate(date: string, days: number): string {
  let d = date, left = days
  while (left > 0) { d = addDays(d, 1); const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) left-- }
  return d
}
/** When the money from a sale made on `date` reaches the bank: `days` business days later at 10:00 India time. */
export const settlementInstant = (date: string, days: number): number => istInstant(settlementDate(date, days), '10:00')

// ---------------------------------------------------------------------------------------------- costs

export interface SecurityCosts { fee: bigint; tax: bigint; parts: { label: string; amount: bigint; kind: 'fee' | 'tax' }[] }
/**
 * What a trade of `gross` paise costs on top of its price, from the terms table. `fee` is everything charged as a fee
 * (brokerage, exchange and SEBI charges, GST, securities transaction tax, the depository's charge); `tax` is the stamp
 * duty on a purchase. A government-securities trade has none: its cost is the gap between its buy and sell prices.
 */
export function securityCosts(db: Db, inst: { kind: string; venue: string; meta: InstrumentMeta }, side: 'buy' | 'sell', gross: bigint): SecurityCosts {
  const parts: SecurityCosts['parts'] = []
  if (inst.venue !== 'paper-exchange' || gross <= 0n) return { fee: 0n, tax: 0n, parts }
  const rate = (id: string, key: string, dflt: string): string => termValue(db, id, key, dflt)
  const brokerage0 = fraction(gross, rate('fee.exchange.brokerage', 'rate', '0.0003'), 'up')
  const cap = BigInt(termValue(db, 'fee.exchange.brokerage', 'capPaise', '2000'))
  const brokerage = brokerage0 < cap ? brokerage0 : cap
  const txn = fraction(gross, rate('fee.exchange.charges', 'txnRate', '0.0000307'), 'up')
  const sebi = fraction(gross, rate('fee.exchange.charges', 'sebiRate', '0.000001'), 'up')
  const gst = fraction(brokerage + txn + sebi, rate('fee.exchange.gst', 'gstOnFee', '0.18'), 'up')
  const cls = inst.meta.sttClass ?? 'none'
  const stt = side === 'sell' || cls === 'equity-delivery' ? fraction(gross, rate('tax.stt', cls, '0'), 'up') : 0n
  const dp = side === 'sell' ? BigInt(termValue(db, 'fee.exchange.dp', 'sellPaise', '1534')) : 0n
  parts.push({ label: 'Brokerage', amount: brokerage, kind: 'fee' }, { label: 'Exchange transaction charge and SEBI fee', amount: txn + sebi, kind: 'fee' }, { label: 'GST on those', amount: gst, kind: 'fee' })
  if (stt > 0n) parts.push({ label: 'Securities transaction tax', amount: stt, kind: 'fee' })
  if (dp > 0n) parts.push({ label: 'Depository charge', amount: dp, kind: 'fee' })
  const stamp = side === 'buy' ? fraction(gross, rate('tax.stamp.exchange', 'buyRate', '0.00015'), 'up') : 0n
  if (stamp > 0n) parts.push({ label: 'Stamp duty', amount: stamp, kind: 'tax' })
  const sum = (k: 'fee' | 'tax'): bigint => parts.filter((p) => p.kind === k).reduce((s, p) => s + p.amount, 0n)
  return { fee: sum('fee'), tax: sum('tax'), parts }
}

// ---------------------------------------------------------------------------------------------- debt prices

const DAY = 86_400_000
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)
/** A bill's price per Rs 100 of face value: the face discounted at a simple yield a year over the days left. */
export function billPrice(yieldPct: number, daysLeft: number): number { return daysLeft <= 0 ? 100 : 100 / (1 + (yieldPct / 100) * (daysLeft / 365)) }
/** The coupon dates of a bond after `asOf`, every six months back from its maturity. */
export function couponDates(maturity: string, issued: string): string[] {
  const out: string[] = []
  const [y, m, d] = maturity.split('-').map(Number) as [number, number, number]
  for (let k = 0; ; k++) {
    const mm = m - 6 * k
    const yy = y + Math.floor((mm - 1) / 12), mo = ((mm - 1) % 12 + 12) % 12 + 1
    const date = `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (date <= issued) break
    out.unshift(date)
  }
  return out
}
/**
 * A bond's full price per Rs 100 of face value on `asOf`: the present value of every coupon still to come and of the face,
 * at a yield a year compounded half-yearly. Being the value of what is still to be paid, it already includes the interest
 * accrued since the last coupon, and it falls by the coupon on the day the coupon is paid.
 */
export function bondPrice(yieldPct: number, couponPct: number, maturity: string, issued: string, asOf: string): number {
  const y = yieldPct / 100
  let pv = 0
  for (const date of couponDates(maturity, issued)) {
    if (date <= asOf) continue
    pv += (couponPct / 2) / Math.pow(1 + y / 2, 2 * (daysBetween(asOf, date) / 365))
  }
  return pv + 100 / Math.pow(1 + y / 2, 2 * (Math.max(0, daysBetween(asOf, maturity)) / 365))
}
/** The price per Rs 100 of face value of a debt instrument on `asOf` at `yieldPct` (page for tests and the feed). */
export function debtPrice(inst: { kind: string; meta: InstrumentMeta }, yieldPct: number, asOf: string): number {
  const d = inst.meta.debt!
  return inst.kind === 'tbill' ? billPrice(yieldPct, daysBetween(asOf, d.maturity)) : bondPrice(yieldPct, d.coupon, d.maturity, d.issued, asOf)
}
export const matured = (inst: { meta: InstrumentMeta }, asOf: string): boolean => !!inst.meta.debt && asOf >= inst.meta.debt.maturity

// ---------------------------------------------------------------------------------------------- the synthetic feed

const SESSION_MS = 375 * 60_000
const HALF_SPREAD: Record<string, number> = { etf: 0.0001, equity: 0.0003, tbill: 0.00025, gsec: 0.0005 }
const priceDp = (i: Instrument): number => (isDebt(i) ? 4 : 2)

export class SecuritiesProvider implements Provider {
  name = SYNTH_MARKETS
  private timer: NodeJS.Timeout | null = null
  private lastAt = 0
  private readonly walks = new Map<string, Walk>()
  private readonly market: Market
  private readonly everyMs: number
  constructor(market: Market, opts: { everyMs?: number } = {}) { this.market = market; this.everyMs = opts.everyMs ?? 3000 }

  private list(): Instrument[] { return instruments(this.market.db).filter((i) => isSecurity(i)) }
  /** The walk's start: the last synthetic value on record (so a restart does not jump) or the instrument's own anchor. */
  private walk(i: Instrument): Walk {
    let w = this.walks.get(i.id)
    if (!w) {
      const anchor = Number(i.meta.anchor?.value ?? 100)
      const last = this.market.get(i.id, 'last')
      const lastYield = this.market.get(i.id, 'rate')
      const start = isDebt(i) ? (lastYield && lastYield.provider === SYNTH_MARKETS ? Number(lastYield.price) : anchor) : last && last.provider === SYNTH_MARKETS ? Number(last.price) : anchor
      const vol = isDebt(i) ? (i.meta.vol ?? 0.03) / anchor : (i.meta.vol ?? 0.01)
      w = new Walk(start, vol, `${i.id}:live`, 0.06 / 365)
      this.walks.set(i.id, w)
    }
    return w
  }

  start(): void {
    const now = this.market.clock.now()
    this.seedHistory(now)
    this.lastAt = now
    this.tick(now)
    this.market.status(SYNTH_MARKETS, 'live', { messages: 0, extra: { note: DATA_LABEL } })
    this.timer = setInterval(() => { const t = this.market.clock.now(); this.tick(t); this.market.status(SYNTH_MARKETS, 'live', { messages: 1, extra: { note: DATA_LABEL } }) }, this.everyMs)
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.market.status(SYNTH_MARKETS, 'idle') }

  /** Business-day closes for 400 days (a bill and a bond only since they were issued), so past figures can be worked out; all synthetic. */
  seedHistory(now: number): void {
    const db = this.market.db
    const today = ist(now).date
    for (const i of this.list()) {
      if (db.get('SELECT 1 FROM daily_values WHERE instrument_id = ? LIMIT 1', i.id)) continue
      const anchor = Number(i.meta.anchor?.value ?? 100)
      const debt = i.meta.debt
      const from = debt ? debt.issued : addDays(today, -400)
      const days = daysBetween(from, today)
      // an ETF's history ends at its anchor (the recorded NAV is the close before today); a debt instrument's yield walks to the anchor
      const w = new Walk(anchor, isDebt(i) ? (i.meta.vol ?? 0.03) / anchor : (i.meta.vol ?? 0.01), `${i.id}:history`, 0.06 / 365)
      const closes: [string, number][] = []
      let v = anchor
      for (let k = days; k >= 1; k--) {
        const d = addDays(today, -k)
        if (!(new Date(`${d}T00:00:00Z`).getUTCDay() % 6)) continue
        v = w.step(1)
        closes.push([d, v])
      }
      // rescale so the last close equals the anchor (the walk was run forward from it; the series is only a shape)
      const last = closes[closes.length - 1]?.[1] ?? anchor
      db.tx(() => {
        for (const [d, raw] of closes) {
          const level = raw * (anchor / last)
          const value = debt ? debtPrice(i, level, d) : level
          if (debt && d < debt.issued) continue
          db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', i.id, d, fixed(value, priceDp(i)), now, SYNTH_MARKETS)
        }
      })
    }
  }

  tick(now: number): void {
    const elapsed = this.lastAt ? Math.max(0, now - this.lastAt) : 0
    this.lastAt = now
    const today = ist(now).date
    const put = (id: string, type: Tick['type'], price: string): void => this.market.update({ instrumentId: id, type, price, size: null, sourceTs: now, precision: 'ms', recvTs: now, provider: SYNTH_MARKETS })
    for (const i of this.list()) {
      const w = this.walk(i)
      const open = sessionOf(i, now).open
      if (open) w.step(elapsed / SESSION_MS)
      const half = HALF_SPREAD[i.kind] ?? 0.0003
      if (isDebt(i)) {
        const y = w.value
        const dp = priceDp(i)
        const mid = debtPrice(i, y, today)
        const gone = matured(i, today)
        put(i.id, 'rate', y.toFixed(4))
        put(i.id, 'bid', fixed(gone ? 100 : mid * (1 - half), dp)); put(i.id, 'ask', fixed(gone ? 100 : mid * (1 + half), dp)); put(i.id, 'last', fixed(mid, dp))
      } else {
        const mid = w.value
        put(i.id, 'bid', fixed(mid * (1 - half), 2)); put(i.id, 'ask', fixed(mid * (1 + half), 2)); put(i.id, 'last', fixed(mid, 2))
      }
    }
    this.recordClose(now)
  }

  /**
   * The close of the latest finished business day, once, so the record keeps growing as days pass: the price at the first
   * pass after that day, taken as its close (synthetic, like every value here).
   */
  private recordClose(now: number): void {
    const db = this.market.db
    const day = businessDayOnOrBefore(addDays(ist(now).date, -1))
    for (const i of this.list()) {
      const have = db.get<{ value_date: string }>('SELECT MAX(value_date) value_date FROM daily_values WHERE instrument_id = ?', i.id)?.value_date
      if (have && have >= day) continue
      const w = this.walks.get(i.id)
      if (!w) continue
      const value = isDebt(i) ? debtPrice(i, w.value, day) : w.value
      if (isDebt(i) && day < i.meta.debt!.issued) continue
      db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', i.id, day, fixed(value, priceDp(i)), now, SYNTH_MARKETS)
    }
  }
}

// ---------------------------------------------------------------------------------------------- coupons

/** Units of a bond a customer held at the start of an India date: fills before it, bought less sold. */
function heldBefore(db: Db, userId: string, instrumentId: string, date: string): bigint {
  const at = istInstant(date, '00:00')
  const r = db.get<{ b: string; s: string }>(`SELECT amount_sum(CASE WHEN side = 'buy' THEN qty ELSE 0 END) b, amount_sum(CASE WHEN side = 'sell' THEN qty ELSE 0 END) s FROM pv_fills WHERE user_id = ? AND instrument_id = ? AND ts < ?`, userId, instrumentId, at)
  return fromAmountText(r?.b, `the bought ${instrumentId}`) - fromAmountText(r?.s, `the sold ${instrumentId}`)
}
export interface CouponDue { userId: string; instrumentId: string; date: string; units: bigint; paise: bigint; ref: string }
/**
 * The coupons now payable on every bond held: one per holder per coupon date, paid at 10:00 India time on the date to
 * whoever held the units at the start of that day. Each carries a reference, so posting it twice does nothing.
 */
export function couponsDue(db: Db, now: number): CouponDue[] {
  const out: CouponDue[] = []
  for (const i of instruments(db).filter((x) => x.kind === 'gsec' && x.meta.debt)) {
    const d = i.meta.debt!
    for (const date of couponDates(d.maturity, d.issued)) {
      if (istInstant(date, '10:00') > now) continue
      for (const u of db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM pv_fills WHERE instrument_id = ?', i.id)) {
        const units = heldBefore(db, u.user_id, i.id, date)
        if (units <= 0n) continue
        // a unit is Rs 100 of face: Rs 100 x coupon / 2 = coupon x 50 paise (6.50% pays 325 paise a unit), rounded down
        const paise = (units * BigInt(Math.round(d.coupon * 100)) * 50n) / 100n
        out.push({ userId: u.user_id, instrumentId: i.id, date, units, paise, ref: `coupon:${i.id}:${date}` })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------- what is not offered

export interface NotOffered { id: string; name: string; reason: string }
/** What the mandate names and QED does not trade yet, each with the reason. Shown in Grow's catalogue so nothing is silently missing. */
export const NOT_OFFERED: NotOffered[] = [
  { id: 'us-equities', name: 'US shares', reason: 'Buying them from India needs a dollar account, a model of sending money abroad and US market hours and tax. QED has none of the three, so a paper trade would show a cost and a delivery that nothing here can honestly work out.' },
  { id: 'fx-trades', name: 'Currency trades', reason: 'Only once-a-day reference rates exist here (the ECB\'s), and nobody can trade at a reference rate. A tradable rate needs a bank\'s two-way quote, and the rules on who may trade currency in India have not been read.' },
  { id: 'futures-options', name: 'Futures and options', reason: 'They need margin, daily settlement of gains and losses, and expiry, none of which the ledger holds, and a position can lose more than the money put in. QED does not paper-trade what its risk checks cannot bound.' },
  { id: 'reits-invits', name: 'REITs and InvITs', reason: 'They trade like shares, but their payouts mix interest, dividends and return of capital, taxed differently, and the ledger has no posting for them yet. They are added once those payouts are modelled.' },
]
