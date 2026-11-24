/**
 * Market data: real prices from public sources, each stored with its provider, price type, the provider's own
 * timestamp (when it supplies one), the time this engine received it, and nothing invented in between.
 *
 * Sources and their nature (kept visible to the owner):
 *   binance    WebSocket stream: best bid/ask (no source timestamp on this stream) and last trade (ms timestamps)
 *   coinbase   WebSocket stream: bid, ask, last with a source timestamp
 *   coindcx    polled REST: INR markets, bid/ask/last (second timestamps) and full order books (ms timestamps)
 *   amfi       polled file: mutual fund NAVs, one value per scheme per day
 *   frankfurter polled REST: European Central Bank daily reference rates (not tradable prices)
 *   nyfed      polled REST: SOFR and EFFR, one value per business day
 * When a source goes quiet the last value stays on record with its age; it is never refreshed artificially.
 *
 * Entitlements (docs/research/qed-fin-infra-compliance/20261118-live-data-entitlements.md): every source here is
 * keyless and usable for the owner's own local use. CoinDCX and AMFI data may not be displayed to third parties on
 * the terms read. Kraken, NSE, BSE, Yahoo Finance, Google Finance, Stooq and WazirX are deliberately not used: their
 * terms forbid or do not clearly allow automated access.
 */
import { type Clock, type Db, emit, ist, j } from './core.ts'
import { type Instrument, instruments } from './registry.ts'

export type PriceType = 'bid' | 'ask' | 'last' | 'nav' | 'reference' | 'rate'
export type Precision = 'ms' | 's' | 'day' | 'none'
export interface Tick { instrumentId: string; type: PriceType; price: string; size?: string | null; sourceTs: number | null; precision: Precision; recvTs: number; provider: string }
export interface BookLevel { price: string; qty: string }
export interface Book { instrumentId: string; bids: BookLevel[]; asks: BookLevel[]; sourceTs: number | null; recvTs: number; provider: string }
export type ProviderState = 'connecting' | 'live' | 'degraded' | 'down' | 'idle'

const UA = 'qed-local-research/0.2'
const key = (id: string, type: PriceType) => `${id}|${type}`

/**
 * A provider's answer. Redirects are followed only within the same host and only to https (at most three), so a provider's
 * answer, or a spoofed one, cannot send QED to another host, this computer's own services or a platform's metadata address
 * (R13 hardening; ASVS 5.0 V15.3.2, V1.3.6). The body is read only up to maxBytes, then the read stops (before, the whole
 * body was read and then measured).
 */
export async function httpGet(url: string, opts: { timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number } = {}): Promise<{ status: number; headers: Headers; text: string; ms: number }> {
  const t0 = performance.now()
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000)
  const origin = new URL(url)
  let at = origin, res: Response
  for (let hop = 0; ; hop++) {
    res = await fetch(at, { headers: { 'user-agent': UA, accept: '*/*', ...(opts.headers ?? {}) }, signal, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) break
    const next = new URL(res.headers.get('location')!, at)
    await res.body?.cancel()
    if (hop >= 3 || next.host !== origin.host || next.protocol !== 'https:') throw new Error(`a provider's redirect was refused: ${origin.host} sent it to ${next.protocol}//${next.host} (only the same host over https is followed)`)
    at = next
  }
  const max = opts.maxBytes ?? 8_000_000
  const chunks: Uint8Array[] = []
  let size = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) { await reader.cancel(); throw new Error(`response from ${origin.host} is larger than expected`) }
      chunks.push(value)
    }
  }
  return { status: res.status, headers: res.headers, text: new TextDecoder().decode(Buffer.concat(chunks)), ms: performance.now() - t0 }
}

// ---------------------------------------------------------------------------------------------- pure parsers

const dec = (v: unknown): string | null => {
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return v
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 })
  return null
}

export function parseBinance(raw: string, recvTs: number): Tick[] {
  const m = JSON.parse(raw) as { stream?: string; data?: Record<string, unknown> }
  const d = m.data
  if (!d || typeof d.s !== 'string') return []
  const id = `binance:${d.s}`
  if (typeof m.stream === 'string' && m.stream.endsWith('@bookTicker')) {
    const bid = dec(d.b), ask = dec(d.a)
    const out: Tick[] = []
    if (bid) out.push({ instrumentId: id, type: 'bid', price: bid, size: dec(d.B), sourceTs: null, precision: 'none', recvTs, provider: 'binance' })
    if (ask) out.push({ instrumentId: id, type: 'ask', price: ask, size: dec(d.A), sourceTs: null, precision: 'none', recvTs, provider: 'binance' })
    return out
  }
  if (d.e === 'aggTrade') {
    const p = dec(d.p)
    return p ? [{ instrumentId: id, type: 'last', price: p, size: dec(d.q), sourceTs: typeof d.T === 'number' ? d.T : null, precision: 'ms', recvTs, provider: 'binance' }] : []
  }
  return []
}

export function parseCoinbase(raw: string, recvTs: number): Tick[] {
  const d = JSON.parse(raw) as Record<string, unknown>
  if (d.type !== 'ticker' || typeof d.product_id !== 'string') return []
  const id = `coinbase:${d.product_id.replace('-', '')}`
  const ts = typeof d.time === 'string' ? Date.parse(d.time) : NaN
  const sourceTs = Number.isFinite(ts) ? ts : null
  const precision: Precision = sourceTs === null ? 'none' : 'ms'
  const out: Tick[] = []
  for (const [f, type, sz] of [['best_bid', 'bid', 'best_bid_size'], ['best_ask', 'ask', 'best_ask_size'], ['price', 'last', 'last_size']] as const) {
    const p = dec(d[f])
    if (p) out.push({ instrumentId: id, type, price: p, size: dec(d[sz]), sourceTs, precision, recvTs, provider: 'coinbase' })
  }
  return out
}

export function parseCoindcxTicker(raw: string, markets: Set<string>, recvTs: number): Tick[] {
  const arr = JSON.parse(raw) as Record<string, unknown>[]
  if (!Array.isArray(arr)) throw new Error('unexpected ticker payload')
  const out: Tick[] = []
  for (const m of arr) {
    if (typeof m.market !== 'string' || !markets.has(m.market)) continue
    const id = `coindcx:${m.market}`
    const sourceTs = typeof m.timestamp === 'number' ? m.timestamp * 1000 : null
    for (const [f, type] of [['bid', 'bid'], ['ask', 'ask'], ['last_price', 'last']] as const) {
      const p = dec(m[f])
      if (p && Number(p) > 0) out.push({ instrumentId: id, type, price: trimZeros(p), sourceTs, precision: sourceTs === null ? 'none' : 's', recvTs, provider: 'coindcx' })
    }
  }
  return out
}

const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

export function parseCoindcxBook(raw: string, instrumentId: string, recvTs: number, depth = 25): Book {
  const d = JSON.parse(raw) as { bids?: Record<string, string>; asks?: Record<string, string>; timestamp?: number }
  if (!d || typeof d.bids !== 'object' || typeof d.asks !== 'object') throw new Error('unexpected order book payload')
  const side = (o: Record<string, string>, desc: boolean): BookLevel[] => Object.entries(o)
    .map(([price, qty]) => ({ price: trimZeros(price), qty: trimZeros(String(qty)), n: Number(price) }))
    .filter((l) => Number.isFinite(l.n) && l.n > 0 && Number(l.qty) > 0)
    .sort((a, b) => (desc ? b.n - a.n : a.n - b.n)).slice(0, depth).map(({ price, qty }) => ({ price, qty }))
  return { instrumentId, bids: side(d.bids!, true), asks: side(d.asks!, false), sourceTs: typeof d.timestamp === 'number' ? d.timestamp : null, recvTs, provider: 'coindcx' }
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
/** AMFI NAVAll.txt: "Scheme Code;ISIN;ISIN;Scheme Name;[Plan;Option;]Net Asset Value;Date" with dd-Mon-yyyy dates. */
export function parseNavAll(text: string, codes: Set<number>): { code: number; nav: string; date: string }[] {
  const out: { code: number; nav: string; date: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const semi = line.indexOf(';')
    if (semi < 1) continue
    const code = Number(line.slice(0, semi))
    if (!codes.has(code)) continue
    const parts = line.split(';')
    const nav = parts[parts.length - 2]?.trim() ?? ''
    const dm = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(parts[parts.length - 1]?.trim() ?? '')
    if (!dm || !/^\d+(\.\d+)?$/.test(nav) || Number(nav) <= 0) continue
    const mon = MONTHS[dm[2]!.toLowerCase()]
    if (!mon) continue
    out.push({ code, nav, date: `${dm[3]}-${mon}-${dm[1]}` })
  }
  return out
}

/** mfapi.in history: { data: [{ date: "dd-mm-yyyy", nav: "…" }] }, newest first. */
export function parseMfapiHistory(raw: string): { date: string; nav: string }[] {
  const d = JSON.parse(raw) as { data?: { date?: string; nav?: string }[] }
  const out: { date: string; nav: string }[] = []
  for (const r of d.data ?? []) {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r.date ?? '')
    if (m && typeof r.nav === 'string' && /^\d+(\.\d+)?$/.test(r.nav) && Number(r.nav) > 0) out.push({ date: `${m[3]}-${m[2]}-${m[1]}`, nav: r.nav })
  }
  return out
}

// ---------------------------------------------------------------------------------------------- store

export class Market {
  readonly db: Db
  readonly clock: Clock
  private readonly latest = new Map<string, Tick>()
  private readonly dirty = new Set<string>()
  private readonly lastHistory = new Map<string, number>()
  private readonly books = new Map<string, Book>()
  private seq = 0
  /** Minimum spacing of history samples for streaming values. Daily values are always recorded. */
  historyEveryMs = 15_000

  constructor(db: Db, clock: Clock) { this.db = db; this.clock = clock }

  update(t: Tick): void {
    const k = key(t.instrumentId, t.type)
    const prev = this.latest.get(k)
    if (prev && prev.price === t.price && prev.sourceTs === t.sourceTs && t.recvTs - prev.recvTs < 1000) { prev.recvTs = t.recvTs; this.dirty.add(k); return }
    this.latest.set(k, t)
    this.dirty.add(k)
  }
  setBook(b: Book): void { this.books.set(b.instrumentId, b) }
  book(id: string): Book | undefined { return this.books.get(id) }

  /** Latest tick: this process's memory first (the engine), then the database (the API process). */
  get(id: string, type: PriceType): Tick | undefined {
    const m = this.latest.get(key(id, type))
    if (m) return m
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM quotes WHERE instrument_id = ? AND price_type = ?', id, type)
    return r ? rowToTick(r) : undefined
  }

  /** Persist what changed since the last flush. Called about once a second by the engine. */
  flush(): number {
    if (this.dirty.size === 0) return 0
    const now = this.clock.now()
    const keys = [...this.dirty]
    this.dirty.clear()
    this.db.tx(() => {
      for (const k of keys) {
        const t = this.latest.get(k)
        if (!t) continue
        this.seq++
        this.db.run(`INSERT INTO quotes (instrument_id, price_type, price, size, source_ts, source_precision, recv_ts, provider, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(instrument_id, price_type) DO UPDATE SET price = excluded.price, size = excluded.size, source_ts = excluded.source_ts,
                     source_precision = excluded.source_precision, recv_ts = excluded.recv_ts, provider = excluded.provider, seq = excluded.seq`,
          t.instrumentId, t.type, t.price, t.size ?? null, t.sourceTs, t.precision, t.recvTs, t.provider, this.seq)
        const last = this.lastHistory.get(k) ?? 0
        if (t.precision === 'day' || now - last >= this.historyEveryMs) {
          this.db.run('INSERT INTO quote_history (instrument_id, price_type, price, source_ts, recv_ts) VALUES (?, ?, ?, ?, ?)', t.instrumentId, t.type, t.price, t.sourceTs, t.recvTs)
          this.lastHistory.set(k, now)
        }
      }
    })
    return keys.length
  }

  status(provider: string, state: ProviderState, detail: { error?: string; messages?: number; reconnect?: boolean; extra?: Record<string, unknown> } = {}): void {
    const now = this.clock.now()
    const prev = this.db.get<{ state: string }>('SELECT state FROM provider_status WHERE provider = ?', provider)
    this.db.run(`INSERT INTO provider_status (provider, state, since, last_ok, last_error, last_error_at, messages, reconnects, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(provider) DO UPDATE SET
                   since = CASE WHEN provider_status.state != excluded.state THEN excluded.since ELSE provider_status.since END,
                   state = excluded.state,
                   last_ok = COALESCE(excluded.last_ok, provider_status.last_ok),
                   last_error = COALESCE(excluded.last_error, provider_status.last_error),
                   last_error_at = COALESCE(excluded.last_error_at, provider_status.last_error_at),
                   messages = provider_status.messages + excluded.messages,
                   reconnects = provider_status.reconnects + excluded.reconnects,
                   detail_json = CASE WHEN excluded.detail_json != '{}' THEN excluded.detail_json ELSE provider_status.detail_json END`,
      provider, state, now, state === 'live' ? now : null, detail.error ?? null, detail.error ? now : null, detail.messages ?? 0, detail.reconnect ? 1 : 0, j(detail.extra ?? {}))
    if (!prev || prev.state !== state) emit(this.db, now, null, 'provider', { provider, state, error: detail.error ?? null })
  }
}

export function rowToTick(r: Record<string, unknown>): Tick {
  return { instrumentId: String(r.instrument_id), type: r.price_type as PriceType, price: String(r.price), size: (r.size as string | null) ?? null, sourceTs: (r.source_ts as number | null) ?? null, precision: r.source_precision as Precision, recvTs: Number(r.recv_ts), provider: String(r.provider) }
}

export interface Freshness { ageMs: number; stale: boolean; usableForExecution: boolean; label: string }
/** How old a value is and whether an execution may rely on it. Daily values are judged against their publication cycle. */
export function freshness(t: Tick | undefined, inst: Instrument, now: number): Freshness {
  if (!t) return { ageMs: Infinity, stale: true, usableForExecution: false, label: 'No value received yet' }
  const ageMs = Math.max(0, now - t.recvTs)
  const staleAfter = inst.meta.staleAfterMs ?? 60_000
  const execMax = inst.meta.execMaxAgeMs ?? staleAfter
  if (t.precision === 'day') {
    const dayAge = t.sourceTs === null ? Infinity : now - t.sourceTs
    return { ageMs: dayAge, stale: dayAge > staleAfter, usableForExecution: dayAge <= staleAfter, label: 'Published once a day' }
  }
  return { ageMs, stale: ageMs > staleAfter, usableForExecution: ageMs <= execMax, label: ageMs > staleAfter ? 'Stale' : 'Live' }
}

// ---------------------------------------------------------------------------------------------- providers

export interface Provider { name: string; start(): void; stop(): void }

abstract class WsProvider implements Provider {
  abstract name: string
  protected abstract url: string
  protected abstract onOpen(ws: WebSocket): void
  protected abstract parse(raw: string, recvTs: number): Tick[]
  protected readonly market: Market
  private ws: WebSocket | null = null
  private stopped = false
  private backoff = 1000
  private count = 0
  private lastMsg = 0
  private timer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  /** A stream that stays silent this long is treated as dead and reconnected. */
  protected quietMs = 30_000

  constructor(market: Market) { this.market = market }

  start(): void {
    this.stopped = false
    this.connect()
    this.watchdog = setInterval(() => {
      const now = this.market.clock.now()
      if (this.count > 0) { this.market.status(this.name, 'live', { messages: this.count }); this.count = 0 }
      if (this.ws && this.lastMsg > 0 && now - this.lastMsg > this.quietMs) {
        this.market.status(this.name, 'degraded', { error: `no message for ${Math.round((now - this.lastMsg) / 1000)} s; reconnecting` })
        try { this.ws.close() } catch { /* ignore */ }
      }
    }, 5000)
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    try { this.ws?.close() } catch { /* ignore */ }
    this.market.status(this.name, 'idle')
  }
  private connect(): void {
    if (this.stopped) return
    this.market.status(this.name, 'connecting')
    let ws: WebSocket
    try { ws = new WebSocket(this.url) } catch (e) { this.retry(String(e)); return }
    this.ws = ws
    ws.onopen = () => { this.backoff = 1000; this.lastMsg = this.market.clock.now(); this.onOpen(ws) }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      const now = this.market.clock.now()
      this.lastMsg = now
      try {
        const ticks = this.parse(ev.data, now)
        for (const t of ticks) this.market.update(t)
        if (ticks.length) this.count += 1
      } catch { /* a malformed message is dropped; it never becomes a price */ }
    }
    ws.onerror = () => { /* the close handler reconnects */ }
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.retry('connection closed') } }
  }
  private retry(why: string): void {
    if (this.stopped) return
    this.market.status(this.name, 'down', { error: why, reconnect: true })
    this.timer = setTimeout(() => this.connect(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, 60_000)
  }
}

export class BinanceStream extends WsProvider {
  name = 'binance'
  protected url: string
  constructor(market: Market, symbols: string[]) {
    super(market)
    const streams = symbols.flatMap((s) => [`${s.toLowerCase()}@bookTicker`, `${s.toLowerCase()}@aggTrade`]).join('/')
    this.url = `wss://data-stream.binance.vision/stream?streams=${streams}`
  }
  protected onOpen(): void { /* streams are named in the URL */ }
  protected parse(raw: string, recvTs: number): Tick[] { return parseBinance(raw, recvTs) }
}

export class CoinbaseStream extends WsProvider {
  name = 'coinbase'
  protected url = 'wss://ws-feed.exchange.coinbase.com'
  private readonly products: string[]
  constructor(market: Market, products: string[]) { super(market); this.products = products; this.quietMs = 90_000 }
  protected onOpen(ws: WebSocket): void { ws.send(JSON.stringify({ type: 'subscribe', product_ids: this.products, channels: ['ticker'] })) }
  protected parse(raw: string, recvTs: number): Tick[] { return parseCoinbase(raw, recvTs) }
}

abstract class Poller implements Provider {
  abstract name: string
  protected abstract everyMs: number
  protected abstract poll(): Promise<number>
  protected readonly market: Market
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private failures = 0
  constructor(market: Market) { this.market = market }
  start(): void { this.stopped = false; this.market.status(this.name, 'connecting'); void this.loop() }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.market.status(this.name, 'idle') }
  private async loop(): Promise<void> {
    if (this.stopped) return
    try {
      const n = await this.poll()
      this.failures = 0
      this.market.status(this.name, 'live', { messages: n })
    } catch (e) {
      this.failures++
      this.market.status(this.name, this.failures >= 3 ? 'down' : 'degraded', { error: e instanceof Error ? e.message : String(e), reconnect: true })
    }
    if (this.stopped) return
    const wait = this.failures > 0 ? Math.min(this.everyMs * 2 ** Math.min(this.failures, 4), 15 * 60_000) : this.everyMs
    this.timer = setTimeout(() => void this.loop(), wait)
  }
}

export class CoindcxPoller extends Poller {
  name = 'coindcx'
  protected everyMs = 5000
  private readonly markets: Set<string>
  private readonly byMarket = new Map<string, Instrument>()
  private n = 0
  constructor(market: Market, insts: Instrument[]) {
    super(market)
    this.markets = new Set(insts.map((i) => i.symbol))
    for (const i of insts) this.byMarket.set(i.symbol, i)
  }
  protected async poll(): Promise<number> {
    const r = await httpGet('https://api.coindcx.com/exchange/ticker', { timeoutMs: 6000 })
    if (r.status !== 200) throw new Error(`ticker HTTP ${r.status}`)
    const ticks = parseCoindcxTicker(r.text, this.markets, this.market.clock.now())
    for (const t of ticks) this.market.update(t)
    // Keep a recent order book for every INR market so previews and resting orders have depth to look at.
    if (this.n++ % 2 === 0) await Promise.allSettled([...this.byMarket.values()].map((i) => fetchCoindcxBook(this.market, i)))
    return ticks.length
  }
}

/** Fetch one order book now. Used on the polling cycle and again at the moment an order executes. */
export async function fetchCoindcxBook(market: Market, inst: Instrument): Promise<Book> {
  const r = await httpGet(`https://public.coindcx.com/market_data/orderbook?pair=${encodeURIComponent(inst.meta.pair ?? '')}`, { timeoutMs: 5000 })
  if (r.status !== 200) throw new Error(`order book HTTP ${r.status}`)
  const book = parseCoindcxBook(r.text, inst.id, market.clock.now())
  if (!book.bids.length || !book.asks.length) throw new Error('order book is empty on one side')
  market.setBook(book)
  return book
}

/** Read the venue's own trading rules (step sizes, minimum order, market-order cap) and keep them with the instrument. */
export async function refreshCoindcxRules(db: Db, insts: Instrument[], now: number): Promise<number> {
  const r = await httpGet('https://api.coindcx.com/exchange/v1/markets_details', { timeoutMs: 10_000 })
  if (r.status !== 200) throw new Error(`markets_details HTTP ${r.status}`)
  const arr = JSON.parse(r.text) as Record<string, unknown>[]
  let n = 0
  for (const i of insts) {
    const m = arr.find((x) => x.symbol === i.symbol)
    if (!m) continue
    const num = (v: unknown): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 }) : undefined)
    const tick = typeof m.base_currency_precision === 'number' ? (1 / 10 ** m.base_currency_precision).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 }) : undefined
    const meta = { ...i.meta, qtyStep: num(m.step) ?? i.meta.qtyStep, minNotional: num(m.min_notional) ?? i.meta.minNotional, maxMarketQty: num(m.max_quantity_market) ?? i.meta.maxMarketQty, priceTick: tick ?? i.meta.priceTick, rulesReadAt: now, venueStatus: m.status }
    db.run('UPDATE instruments SET meta_json = ? WHERE id = ?', j(meta), i.id)
    n++
  }
  return n
}

export class AmfiPoller extends Poller {
  name = 'amfi'
  protected everyMs = 20 * 60_000
  private readonly codes: Set<number>
  private etag: string | null = null
  private backfilled = false
  constructor(market: Market, insts: Instrument[]) { super(market); this.codes = new Set(insts.map((i) => i.meta.schemeCode!).filter((c) => Number.isInteger(c))) }
  protected async poll(): Promise<number> {
    const db = this.market.db
    if (!this.backfilled) { await this.backfill(); this.backfilled = true }
    const r = await httpGet('https://portal.amfiindia.com/spages/NAVAll.txt', { timeoutMs: 30_000, headers: this.etag ? { 'if-none-match': this.etag } : {} })
    if (r.status === 304) return 0
    if (r.status !== 200) throw new Error(`NAVAll HTTP ${r.status}`)
    this.etag = r.headers.get('etag')
    const now = this.market.clock.now()
    const rows = parseNavAll(r.text, this.codes)
    if (rows.length === 0) throw new Error('NAV file contained none of the tracked schemes')
    let fresh = 0
    db.tx(() => {
      for (const row of rows) {
        const id = `amfi:${row.code}`
        const ins = db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, row.date, row.nav, now, 'amfi-navall')
        if (ins.changes > 0) { fresh++; emit(db, now, null, 'nav', { instrumentId: id, date: row.date, nav: row.nav }) }
      }
    })
    this.publishLatest()
    return fresh
  }
  /** Load each scheme's published history once, so charts, missed dates and calibrations use real past NAVs. */
  private async backfill(): Promise<void> {
    const db = this.market.db
    for (const code of this.codes) {
      const id = `amfi:${code}`
      const have = db.get<{ n: number }>('SELECT COUNT(*) n FROM daily_values WHERE instrument_id = ?', id)?.n ?? 0
      if (have > 250) continue
      try {
        const r = await httpGet(`https://api.mfapi.in/mf/${code}`, { timeoutMs: 20_000 })
        if (r.status !== 200) continue
        const now = this.market.clock.now()
        const hist = parseMfapiHistory(r.text)
        db.tx(() => { for (const h of hist) db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, h.date, h.nav, now, 'mfapi-history') })
      } catch { /* history is a convenience; today's NAV file is the source of record */ }
    }
    this.publishLatest()
  }
  private publishLatest(): void {
    const db = this.market.db
    for (const code of this.codes) {
      const id = `amfi:${code}`
      const r = db.get<{ value_date: string; value: string; recv_ts: number }>('SELECT value_date, value, recv_ts FROM daily_values WHERE instrument_id = ? ORDER BY value_date DESC LIMIT 1', id)
      if (r) this.market.update({ instrumentId: id, type: 'nav', price: r.value, sourceTs: Date.parse(`${r.value_date}T00:00:00+05:30`), precision: 'day', recvTs: r.recv_ts, provider: 'amfi' })
    }
  }
}

export class FrankfurterPoller extends Poller {
  name = 'frankfurter'
  protected everyMs = 3 * 3600_000
  protected async poll(): Promise<number> {
    const db = this.market.db
    const now = this.market.clock.now()
    let n = 0
    for (const base of ['USD', 'EUR']) {
      const id = `ecb:${base}INR`
      const have = db.get<{ n: number }>('SELECT COUNT(*) n FROM daily_values WHERE instrument_id = ?', id)?.n ?? 0
      const url = have < 60
        ? `https://api.frankfurter.dev/v1/${new Date(now - 400 * 86_400_000).toISOString().slice(0, 10)}..?base=${base}&symbols=INR`
        : `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=INR`
      const r = await httpGet(url, { timeoutMs: 10_000 })
      if (r.status !== 200) throw new Error(`reference rates HTTP ${r.status}`)
      const d = JSON.parse(r.text) as { date?: string; rates?: Record<string, unknown> }
      const rows: [string, string][] = []
      if (d.date && d.rates && typeof (d.rates as { INR?: unknown }).INR === 'number') rows.push([d.date, String((d.rates as { INR: number }).INR)])
      else for (const [date, v] of Object.entries(d.rates ?? {})) { const x = (v as { INR?: unknown }).INR; if (typeof x === 'number') rows.push([date, String(x)]) }
      db.tx(() => { for (const [date, v] of rows) n += db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, date, v, now, 'frankfurter').changes })
      const last = db.get<{ value_date: string; value: string; recv_ts: number }>('SELECT value_date, value, recv_ts FROM daily_values WHERE instrument_id = ? ORDER BY value_date DESC LIMIT 1', id)
      if (last) this.market.update({ instrumentId: id, type: 'reference', price: last.value, sourceTs: Date.parse(`${last.value_date}T15:00:00Z`), precision: 'day', recvTs: last.recv_ts, provider: 'frankfurter' })
    }
    return n
  }
}

export class NyFedPoller extends Poller {
  name = 'nyfed'
  protected everyMs = 6 * 3600_000
  protected async poll(): Promise<number> {
    const db = this.market.db
    const now = this.market.clock.now()
    let n = 0
    for (const [id, path] of [['nyfed:SOFR', 'secured/sofr'], ['nyfed:EFFR', 'unsecured/effr']] as const) {
      const r = await httpGet(`https://markets.newyorkfed.org/api/rates/${path}/last/30.json`, { timeoutMs: 12_000 })
      if (r.status !== 200) throw new Error(`reference rate HTTP ${r.status}`)
      const d = JSON.parse(r.text) as { refRates?: { effectiveDate?: string; percentRate?: number }[] }
      db.tx(() => {
        for (const x of d.refRates ?? []) {
          if (typeof x.effectiveDate === 'string' && typeof x.percentRate === 'number')
            n += db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, x.effectiveDate, String(x.percentRate), now, 'nyfed').changes
        }
      })
      const last = db.get<{ value_date: string; value: string; recv_ts: number }>('SELECT value_date, value, recv_ts FROM daily_values WHERE instrument_id = ? ORDER BY value_date DESC LIMIT 1', id)
      if (last) this.market.update({ instrumentId: id, type: 'rate', price: last.value, sourceTs: Date.parse(`${last.value_date}T12:00:00Z`), precision: 'day', recvTs: last.recv_ts, provider: 'nyfed' })
    }
    return n
  }
}

/** Compare this machine's clock with an exchange's server time. The uncertainty is half the round trip. */
export async function checkClock(db: Db, clock: Clock): Promise<{ offsetMs: number; uncertaintyMs: number }> {
  // Several samples on one connection; the one with the shortest round trip bounds the offset most tightly.
  let best: { offsetMs: number; uncertaintyMs: number } | null = null
  for (let i = 0; i < 4; i++) {
    const t0 = clock.now()
    const p0 = performance.now()
    const r = await httpGet('https://data-api.binance.vision/api/v3/time', { timeoutMs: 5000 })
    const rtt = performance.now() - p0
    const server = (JSON.parse(r.text) as { serverTime?: number }).serverTime
    if (r.status !== 200 || typeof server !== 'number') continue
    const sample = { offsetMs: server - (t0 + rtt / 2), uncertaintyMs: rtt / 2 }
    if (!best || sample.uncertaintyMs < best.uncertaintyMs) best = sample
  }
  if (!best) throw new Error('time endpoint unavailable')
  const { offsetMs, uncertaintyMs } = best
  db.run('INSERT INTO clock_checks (ts, reference, offset_ms, uncertainty_ms) VALUES (?, ?, ?, ?)', clock.now(), 'binance server time', offsetMs, uncertaintyMs)
  return { offsetMs, uncertaintyMs }
}

export function buildProviders(market: Market): Provider[] {
  const all = instruments(market.db)
  const by = (provider: string) => all.filter((i) => i.provider === provider)
  return [
    new BinanceStream(market, by('binance').map((i) => i.symbol)),
    new CoinbaseStream(market, by('coinbase').map((i) => i.symbol)),
    new CoindcxPoller(market, by('coindcx')),
    new AmfiPoller(market, by('amfi')),
    new FrankfurterPoller(market),
    new NyFedPoller(market),
  ]
}

/** Is this an Indian business day by the calendar alone (Monday to Friday)? Holidays are resolved from published NAV dates. */
export const isWeekday = (ms: number): boolean => { const w = ist(ms).weekday; return w !== 0 && w !== 6 }
