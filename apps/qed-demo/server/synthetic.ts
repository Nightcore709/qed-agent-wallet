/**
 * Presentation mode (N-003): synthetic market data, so the wallet can be shown to people other than the account holder.
 *
 * The live providers' terms do not allow that: CoinDCX forbids showing its data, or anything derived from it, to any
 * third party; AMFI allows personal, non-commercial use; Binance's datasets may not go into commercial financial
 * products (as read on 20 to 22 November 2026; experiments/r7/X9-calibration/limits.json lists each). In presentation
 * mode no provider is contacted at all. Every price, order book, NAV, reference rate and NAV history is generated here
 * from round starting values by seeded random walks, and carries the provider name "synthetic", which the interface
 * shows as such. Limits calibrated on provider history are not loaded either (registry.ts).
 *
 * The prices hang together as the wallet's own checks expect: an INR crypto price is the USD walk converted through the
 * USDT/INR walk, with a small venue premium, so the cross-check against the reference (policy.ts) behaves as it does on
 * live data.
 *
 * A presentation installation must have a database of its own: one that already holds live market data, or limits
 * calibrated on it, is refused (assertPresentationDb).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { addDays, AppError, type Db, ist, istInstant } from './core.ts'
import { type Book, type BookLevel, isWeekday, type Market, type PriceType, type Provider, type Tick } from './market.ts'
import { instruments, type Instrument } from './registry.ts'

export const SYNTHETIC = 'synthetic'
/**
 * A switch for isolated test stacks only (QED_TEST_STACK=1): while the file named by QED_TEST_SYNTHETIC_PAUSE_FILE
 * exists, the feed publishes nothing, so prices age and the engine's own staleness checks refuse what would use them
 * (the judge journey's stale-price refusal). The provider's status says so in words the interface already shows.
 * Without QED_TEST_STACK=1 the variable is ignored and the feed never pauses.
 */
export function syntheticPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QED_TEST_STACK === '1' && typeof env.QED_TEST_SYNTHETIC_PAUSE_FILE === 'string' && env.QED_TEST_SYNTHETIC_PAUSE_FILE.length > 0 && existsSync(env.QED_TEST_SYNTHETIC_PAUSE_FILE)
}
export const PAUSED_TEXT = 'Test mode (isolated test stack only): the synthetic feed is paused by a test, so prices age and the engine refuses what would use a stale price.'
/**
 * A second switch for isolated test stacks only (QED_TEST_STACK=1): the file named by QED_TEST_SYNTHETIC_NAV_FILE holds
 * an ISO day, and while it does the feed publishes each fund's NAV for that day at once, as the fund houses would that
 * evening, so a browser journey can follow a fund order to its allotment without waiting for the evening (R12 task
 * comparison, gap 17). Only once that day has come: a NAV is the close of its own day, so a later day waits for the clock,
 * which a journey brings forward with the test clock (core.ts testClockOffset); until R13 the day was published at once,
 * whatever it was, and units were allotted a day before their NAV existed. The day returned, or null: not a test stack, no
 * file, or no day in it.
 */
export function syntheticNavThrough(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.QED_TEST_STACK !== '1' || typeof env.QED_TEST_SYNTHETIC_NAV_FILE !== 'string' || !env.QED_TEST_SYNTHETIC_NAV_FILE) return null
  try { const d = readFileSync(env.QED_TEST_SYNTHETIC_NAV_FILE, 'utf8').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null } catch { return null }
}
export const NAV_AHEAD_TEXT = 'Test mode (isolated test stack only): a test asked for a day\'s fund NAVs to be published now, ahead of their evening.'
const DAY = 86_400_000
/** Round starting values, so nobody mistakes them for market prices. US dollars, except where the name says. */
const USD: Record<string, number> = { BTC: 60_000, ETH: 3_000, PAXG: 2_500, USDT: 1 }
const INR_PER: Record<string, number> = { USD: 85, EUR: 95 }
/** Daily volatility of each walk. */
const VOL = { crypto: 0.03, gold: 0.009, fx: 0.003, premium: 0.0005, index: 0.009, flexi: 0.008, international: 0.01, liquid: 0.0001, overnight: 0.00005, 'money-market': 0.0002, arbitrage: 0.0003 } as const
const DRIFT = { liquid: 0.065 / 365, overnight: 0.06 / 365, 'money-market': 0.067 / 365, arbitrage: 0.068 / 365 } as Record<string, number>

/** A small seeded generator (mulberry32), so a run can be reproduced from its seeds. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
}
const seedOf = (s: string): number => createHash('sha256').update(`qed/synthetic/v1\n${s}`).digest().readUInt32BE(0)
/** A standard normal draw (Box-Muller). */
const normal = (r: () => number): number => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r())

/** A geometric random walk: each step multiplies by exp(σ√t·z − σ²t/2 + μt), t in days. */
export class Walk {
  value: number
  private readonly r: () => number
  private readonly vol: number
  private readonly drift: number
  constructor(value: number, vol: number, seed: string, drift = 0) { this.value = value; this.vol = vol; this.drift = drift; this.r = prng(seedOf(seed)) }
  step(days: number): number {
    if (days <= 0) return this.value
    const s = this.vol * Math.sqrt(days)
    this.value *= Math.exp(s * normal(this.r) - (s * s) / 2 + this.drift * days)
    return this.value
  }
}

export const fixed = (v: number, dp: number): string => v.toFixed(dp)
const fundVol = (i: Instrument): number => VOL[(i.meta.category ?? 'flexi') as keyof typeof VOL] ?? VOL.flexi

/** The last business day on or before this IST date. */
export function businessDayOnOrBefore(date: string): string {
  let d = date
  for (let k = 0; k < 7 && !isWeekday(istInstant(d, '12:00')); k++) d = addDays(d, -1)
  return d
}

export class SyntheticProvider implements Provider {
  name = SYNTHETIC
  private timer: NodeJS.Timeout | null = null
  private lastAt = 0
  private readonly walks = new Map<string, Walk>()
  private readonly market: Market
  private readonly everyMs: number
  constructor(market: Market, opts: { everyMs?: number } = {}) { this.market = market; this.everyMs = opts.everyMs ?? 3000 }

  /** A walk, started from the last synthetic value on record (so a restart does not jump) or from its round start. */
  private walk(key: string, start: () => number, vol: number, drift = 0, restartFrom?: { id: string; type: PriceType; scale?: number }): Walk {
    let w = this.walks.get(key)
    if (!w) {
      const prev = restartFrom ? this.market.get(restartFrom.id, restartFrom.type) : undefined
      const v = prev && prev.provider === SYNTHETIC ? Number(prev.price) / (restartFrom?.scale ?? 1) : start()
      w = new Walk(Number.isFinite(v) && v > 0 ? v : start(), vol, key, drift)
      this.walks.set(key, w)
    }
    return w
  }

  start(): void {
    const now = this.market.clock.now()
    this.seedHistory(now)
    this.lastAt = now
    this.tick(now)
    this.market.status(SYNTHETIC, 'live', { messages: 0, extra: { note: 'Presentation mode: every value is generated on this computer.' } })
    this.timer = setInterval(() => {
      if (syntheticPaused()) { this.market.status(SYNTHETIC, 'degraded', { error: PAUSED_TEXT, extra: { testMode: true, paused: true } }); return }
      const t = this.market.clock.now(); this.tick(t); this.market.status(SYNTHETIC, 'live', { messages: 1, ...(syntheticNavThrough() ? { extra: { testMode: true, note: NAV_AHEAD_TEXT } } : {}) })
    }, this.everyMs)
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.market.status(SYNTHETIC, 'idle') }

  /** Business-day NAVs for every fund over the past 400 days, so past returns can be shown; all labelled synthetic. */
  seedHistory(now: number): void {
    const db = this.market.db
    const today = ist(now).date
    for (const i of instruments(db).filter((x) => x.kind === 'mutual_fund')) {
      if (db.get('SELECT 1 FROM daily_values WHERE instrument_id = ? LIMIT 1', i.id)) continue
      const cat = i.meta.category ?? 'flexi'
      const w = new Walk(100, fundVol(i), `${i.id}:history`, DRIFT[cat] ?? 0.12 / 365)
      db.tx(() => {
        for (let k = 400; k >= 1; k--) {
          const d = addDays(today, -k)
          if (!isWeekday(istInstant(d, '12:00'))) continue
          db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', i.id, d, fixed(w.step(1), 4), now, SYNTHETIC)
        }
      })
    }
  }

  tick(now: number): void {
    // The first tick moves nothing; later ones move each walk once, by the time since the previous tick.
    const days = this.lastAt ? Math.max(0, now - this.lastAt) / DAY : 0
    this.lastAt = now
    const tick = (instrumentId: string, type: PriceType, price: string, precision: Tick['precision'], sourceTs: number): void =>
      this.market.update({ instrumentId, type, price, size: null, sourceTs, precision, recvTs: now, provider: SYNTHETIC })
    const usdtInr = this.walk('fx:USDTINR', () => INR_PER.USD! * 1.02, VOL.fx, 0, { id: 'coindcx:USDTINR', type: 'last' }).step(days)
    // Every instrument on the same coin reads the same value in a tick: the walk steps once, then is read.
    const stepped = new Map<string, number>()
    const usd = (base: string): number => { let v = stepped.get(base); if (v === undefined) { v = this.walk(`usd:${base}`, () => USD[base] ?? 100, base === 'PAXG' ? VOL.gold : VOL.crypto, 0, { id: `binance:${base}USDT`, type: 'last' }).step(days); stepped.set(base, v) } return v }
    const today = ist(now).date
    // the control publishes a day's NAV ahead of that day's evening, never a NAV for a day that has not come (a NAV is the
    // close of its own day): a later day written to its file waits for the clock (R13 section 4; server/fund-days.test.ts)
    const asked = syntheticNavThrough()
    const ahead = asked && asked > today ? today : asked
    for (const i of instruments(this.market.db)) {
      if (i.kind === 'crypto_spot') {
        const premium = this.walk(`premium:${i.id}`, () => 1.002, VOL.premium).step(days)
        const mid = (i.base_asset === 'USDT' ? 1 : usd(i.base_asset)) * usdtInr * (i.base_asset === 'USDT' ? 1 : premium)
        const half = mid * 0.0005
        tick(i.id, 'bid', fixed(mid - half, 2), 'ms', now); tick(i.id, 'ask', fixed(mid + half, 2), 'ms', now); tick(i.id, 'last', fixed(mid, 2), 'ms', now)
        this.market.setBook(this.book(i, mid, now))
      } else if (i.kind === 'crypto_reference') {
        const noise = i.provider === 'coinbase' ? this.walk(`noise:${i.id}`, () => 1.0005, VOL.premium).step(days) : 1
        const mid = usd(i.base_asset) * noise, half = mid * 0.0002
        tick(i.id, 'bid', fixed(mid - half, 2), 'ms', now); tick(i.id, 'ask', fixed(mid + half, 2), 'ms', now); tick(i.id, 'last', fixed(mid, 2), 'ms', now)
      } else if (i.kind === 'mutual_fund') {
        // One NAV a business day, published for the previous business day, as fund houses do; on a test stack, a test
        // may ask for a later day's now (syntheticNavThrough). The quote is labelled with the day its NAV is for.
        const usual = businessDayOnOrBefore(addDays(today, -1))
        const date = ahead && ahead > usual ? ahead : usual
        const last = this.market.db.get<{ value: string; value_date: string }>('SELECT value, value_date FROM daily_values WHERE instrument_id = ? ORDER BY value_date DESC LIMIT 1', i.id)
        let nav = last?.value ?? '100.0000', navDate = last?.value_date ?? date
        if (!last || last.value_date < date) {
          const cat = i.meta.category ?? 'flexi'
          const w = new Walk(Number(nav), fundVol(i), `${i.id}:${date}`, DRIFT[cat] ?? 0.12 / 365)
          nav = fixed(w.step(1), 4)
          navDate = date
          this.market.db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', i.id, date, nav, now, SYNTHETIC)
        }
        tick(i.id, 'nav', nav, 'day', istInstant(navDate, '00:00'))
      } else if (i.kind === 'fx_reference') {
        const v = this.walk(`fx:${i.id}`, () => INR_PER[i.base_asset] ?? 100, VOL.fx, 0, { id: i.id, type: 'reference' }).step(days)
        tick(i.id, 'reference', fixed(v, 4), 'day', istInstant(businessDayOnOrBefore(today), '00:00'))
      } else if (i.kind === 'rate') {
        tick(i.id, 'rate', i.symbol === 'EFFR' ? '4.10' : '4.00', 'day', istInstant(businessDayOnOrBefore(today), '00:00'))
      }
    }
  }

  /** Ten levels a side around the mid, a twentieth of a percent apart, with round sizes. */
  private book(i: Instrument, mid: number, now: number): { instrumentId: string; bids: BookLevel[]; asks: BookLevel[]; sourceTs: number; recvTs: number; provider: string } {
    const qty = i.base_asset === 'BTC' ? '0.05' : i.base_asset === 'ETH' ? '1' : i.base_asset === 'USDT' ? '500' : '1'
    const level = (k: number, side: 1 | -1): BookLevel => ({ price: fixed(mid * (1 + side * 0.0005 * (k + 1)), 2), qty })
    return { instrumentId: i.id, bids: Array.from({ length: 10 }, (_, k) => level(k, -1)), asks: Array.from({ length: 10 }, (_, k) => level(k, 1)), sourceTs: now, recvTs: now, provider: SYNTHETIC }
  }
}

/**
 * The order book in presentation mode, for previews in the API process as well as fills in the engine: ten levels a
 * side around the latest synthetic bid and ask on record, as old as they are. Nothing is fetched.
 */
export async function syntheticBook(market: Market, inst: Instrument): Promise<Book> {
  const bid = market.get(inst.id, 'bid'), ask = market.get(inst.id, 'ask')
  if (!bid || !ask || bid.provider !== SYNTHETIC || ask.provider !== SYNTHETIC) throw new Error('no synthetic price on record yet')
  const b = Number(bid.price), a = Number(ask.price)
  const qty = inst.base_asset === 'BTC' ? '0.05' : inst.base_asset === 'ETH' ? '1' : inst.base_asset === 'USDT' ? '500' : '1'
  const at = Math.min(bid.recvTs, ask.recvTs)
  return {
    instrumentId: inst.id, provider: SYNTHETIC, sourceTs: at, recvTs: at,
    bids: Array.from({ length: 10 }, (_, k) => ({ price: fixed(b * (1 - 0.0005 * k), 2), qty })),
    asks: Array.from({ length: 10 }, (_, k) => ({ price: fixed(a * (1 + 0.0005 * k), 2), qty })),
  }
}

/**
 * A presentation installation keeps no live market data: a database that already holds quotes, NAV history or limits
 * from a live provider is refused, so that nothing shown can be derived from them.
 */
export function assertPresentationDb(db: Db): void {
  const quotes = db.get<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE provider != ? AND provider != 'synthetic-markets'`, SYNTHETIC)?.n ?? 0
  const history = db.get<{ n: number }>(`SELECT COUNT(*) n FROM daily_values WHERE source != ? AND source != 'synthetic-markets'`, SYNTHETIC)?.n ?? 0
  const calibrated = db.get<{ n: number }>(`SELECT COUNT(*) n FROM terms WHERE status = 'calibrated'`)?.n ?? 0
  if (quotes + history + calibrated > 0) {
    throw new AppError(500, 'presentation_db', `Presentation mode needs a database of its own: this one holds ${quotes} quotes and ${history} daily values from live providers and ${calibrated} limits calibrated on their history. Start it with QED_DB pointing at a new file.`)
  }
}
