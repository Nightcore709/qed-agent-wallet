/**
 * The interface's data layer: one API client, one live event stream, a hook that keeps a resource current, a tiny
 * router and formatting. The server is the only source of truth; nothing here keeps money state of its own.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { inr as inrBase, inrWords } from '../../shared/money.ts'
import {  } from '../../shared/home-money.ts'
import { homeMoney, setHomeCurrencySource } from '../../shared/home-money.ts'
import { type Currency, isPaperCurrency } from '../../shared/currency.ts'
import { DEFAULT_ZONE, isZone, offsetMs, zonedParts, zoneLabel } from '../../shared/zone.ts'

// ------------------------------------------------------------------------------------------------ API client

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: Record<string, string>
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

let csrf = ''
export const setCsrf = (t: string): void => { csrf = t }
const signedOutListeners = new Set<() => void>()
export const onSignedOut = (fn: () => void): (() => void) => { signedOutListeners.add(fn); return () => signedOutListeners.delete(fn) }

export async function api<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-QED-Client': 'web', 'X-QED-CSRF': csrf },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
  } catch {
    throw new ApiError(0, 'unreachable', 'QED\'s service on this QED installation is not answering. Check that it is running, then try again.')
  }
  let json: unknown = null
  try { json = await res.json() } catch { /* an empty or non-JSON reply is handled below */ }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error
    if (res.status === 401 && e?.code === 'signed_out') signedOutListeners.forEach((fn) => fn())
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `The request failed (${res.status}).`, e?.fields ?? {})
  }
  return json as T
}

// ------------------------------------------------------------------------------------------------ live events

type Listener = () => void
const topicVersion = new Map<string, number>()
const topicListeners = new Set<Listener>()
/** The latest streamed price per instrument and kind; `shownAt` is when this browser received it (its own clock, for the journey's last leg). */
const quotes = new Map<string, { price: string; sourceTs: number | null; recvTs: number; shownAt: number }>()
const quoteListeners = new Set<Listener>()
let quoteVersion = 0
let stream: EventSource | null = null
let streamState: 'off' | 'live' | 'retrying' = 'off'
const stateListeners = new Set<Listener>()

const TOPICS = ['action', 'run', 'program', 'notice', 'receipt', 'recon', 'bill', 'earn', 'dispute', 'stop', 'profile', 'engine', 'provider', 'nav', 'vault', 'workspace'] as const
function bump(topic: string): void {
  topicVersion.set(topic, (topicVersion.get(topic) ?? 0) + 1)
  topicListeners.forEach((l) => l())
}

export function startLive(): void {
  if (stream) return
  stream = new EventSource('/api/events')
  stream.addEventListener('hello', () => { streamState = 'live'; stateListeners.forEach((l) => l()); bump('reconnect') })
  for (const t of TOPICS) stream.addEventListener(t, () => bump(t))
  stream.addEventListener('beat', () => bump('beat'))
  stream.addEventListener('quotes', (ev) => {
    try {
      const d = JSON.parse((ev as MessageEvent<string>).data) as { q: [string, string, string, number | null, number][] }
      for (const [id, type, price, sourceTs, recvTs] of d.q) quotes.set(`${id}|${type}`, { price, sourceTs, recvTs, shownAt: Date.now() })
      quoteVersion++
      quoteListeners.forEach((l) => l())
    } catch { /* a malformed frame is ignored */ }
  })
  stream.onerror = () => { streamState = 'retrying'; stateListeners.forEach((l) => l()) }
}
export function stopLive(): void { stream?.close(); stream = null; streamState = 'off' }

export function useStreamState(): 'off' | 'live' | 'retrying' {
  return useSyncExternalStore((l) => { stateListeners.add(l); return () => stateListeners.delete(l) }, () => streamState)
}
/** The latest streamed price for an instrument, or undefined until one arrives on this connection. */
export function useQuote(id: string, type: string): { price: string; sourceTs: number | null; recvTs: number; shownAt: number } | undefined {
  useSyncExternalStore((l) => { quoteListeners.add(l); return () => quoteListeners.delete(l) }, () => quoteVersion)
  return quotes.get(`${id}|${type}`)
}

export interface Resource<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }
/**
 * Set from the moment a sign-out starts until a session signs in again: data loads are not sent meanwhile, so a refresh
 * an event scheduled just before is not refused (401) once the session has ended (R12 QA: the notices refresh went out
 * 2 ms after the sign-out and failed the journey).
 */
let signingOut = false
/**
 * A sign-out also drops what this page keeps of the account in memory (ASVS 5.0 V14.3.1): streamed prices and a question
 * handed to Ask (the CSRF token is still needed to send the sign-out, and the session read after it replaces it). The
 * server's answer asks the browser to clear its cache too (Clear-Site-Data).
 */
export const beginSignOut = (): void => { signingOut = true; quotes.clear(); quoteVersion++; handedQuestion = null }
export const endSignOut = (): void => { signingOut = false }
/**
 * The order a resource shows its answers in. Each request is numbered as it is sent. An answer with data is shown
 * unless a newer answer already is: a reload sent while an earlier request is still out (a live event, or the stream's
 * first hello, which reloads everything read before it) no longer throws that earlier answer away when it comes first,
 * and an older answer never replaces a newer one. A failure is shown only for the latest request: an earlier request's
 * failure says nothing about now. A new path forgets every request still out: their answers are for what is no longer
 * read. (R12, Protect on the phone profile: the stream's hello reloaded the page's seven reads while their answers were
 * on the way; only the reload's answers counted, and the page's single draw waited 0.5 s for them.)
 */
export function answerOrder(): { send: () => number; data: (n: number) => boolean; error: (n: number) => boolean; reset: () => void } {
  let sent = 0, shown = 0
  const take = (n: number): boolean => { if (n <= shown) return false; shown = n; return true }
  return { send: () => ++sent, data: take, error: (n) => n === sent && take(n), reset: () => { shown = sent } }
}
/**
 * Fetch a resource and keep it current: refetch when any of the named event topics fires (and on reconnect).
 * A failed refresh keeps showing the last good data and reports the error beside it.
 */
export function useData<T>(path: string | null, topics: readonly string[] = []): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path })
  const order = useRef<ReturnType<typeof answerOrder> | null>(null)
  order.current ??= answerOrder()
  const load = useCallback(() => {
    if (!path || signingOut) return
    const o = order.current!
    const mine = o.send()
    api<T>('GET', path).then(
      (data) => { if (o.data(mine)) setState({ data, error: null, loading: false }) },
      (e: unknown) => { if (o.error(mine)) setState((s) => ({ data: s.data, error: e instanceof ApiError ? e : new ApiError(0, 'error', String(e)), loading: false })) },
    )
  }, [path])
  useEffect(() => { order.current!.reset(); setState((s) => ({ ...s, loading: !!path })); load() }, [load, path])
  const key = topics.join(',')
  useEffect(() => {
    if (!path) return
    const want = new Set([...key.split(',').filter(Boolean), 'reconnect'])
    let last = [...want].map((t) => topicVersion.get(t) ?? 0).join('.')
    let timer: ReturnType<typeof setTimeout> | null = null
    const l = () => {
      const now = [...want].map((t) => topicVersion.get(t) ?? 0).join('.')
      if (now === last) return
      last = now
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 250)
    }
    topicListeners.add(l)
    return () => { topicListeners.delete(l); if (timer) clearTimeout(timer) }
  }, [key, load, path])
  return { ...state, reload: load }
}

/** A clock that re-renders its user every `everyMs`, for ages and countdowns. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t) }, [everyMs])
  return now
}

// ------------------------------------------------------------------------------------------------ router

const routeListeners = new Set<Listener>()
/**
 * The page's content crosses to the next page in a short fade and rise (the browser's view transitions, where it has
 * them, and never under reduced motion). The shell around it does not move.
 */
function swapPage(): void {
  const tell = () => routeListeners.forEach((l) => l())
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  // the transition's callback runs outside React's own work, so the new page can be drawn synchronously inside it
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(() => flushSync(tell))
  else tell()
}
/**
 * A question typed into the Ask composer docked on another page, handed to the Ask page in memory. It never goes into
 * the address (browser history, logs and the Referer header would keep a person's question about their money).
 */
let handedQuestion: string | null = null
export function handAsk(question: string): void { handedQuestion = question; navigate('/ask') }
export function takeHandedAsk(): string | null { const q = handedQuestion; handedQuestion = null; return q }

/**
 * A link to another site, only if it is an https: address (ASVS 5.0 V1.2.2): a javascript:, data: or plain http: address,
 * from any source, is shown as text and never made a link.
 */
export function httpsOnly(url: unknown): string | undefined {
  try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.href : undefined } catch { return undefined }
}

export function navigate(to: string, replace = false): void {
  const hash = to.includes('#') ? to.slice(to.indexOf('#') + 1) : ''
  if (to === location.pathname + location.search && !hash) return
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to)
  swapPage()
  window.scrollTo(0, 0)
  // Move focus to the new page's heading so keyboard and screen-reader users land where the content starts; a link to
  // a section ("/security#wallet-signers") lands on that section instead, once the page has drawn it (a page may draw
  // it only after its data arrives, so it is looked for for up to two seconds).
  // with a section named, focus goes there only: the heading's turn, a frame later, would take it back (review of R12, L12)
  if (hash) { landOn(hash, Date.now() + 2000); return }
  requestAnimationFrame(() => { const h = document.querySelector<HTMLElement>('main h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }) } })
}
function landOn(id: string, until: number): void {
  const el = document.getElementById(id)
  if (el) { el.scrollIntoView({ block: 'start' }); if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus({ preventScroll: true }); return }
  if (Date.now() < until) setTimeout(() => landOn(id, until), 100)
}
if (typeof window !== 'undefined') window.addEventListener('popstate', () => routeListeners.forEach((l) => l()))
export function useLocation(): { path: string; query: URLSearchParams } {
  const href = useSyncExternalStore((l) => { routeListeners.add(l); return () => routeListeners.delete(l) }, () => location.pathname + location.search)
  const [path = '/', search = ''] = href.split('?')
  return { path, query: new URLSearchParams(search) }
}
/** Match "/instructions/:id" against a path. Returns the parameters, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean), sp = path.split('/').filter(Boolean)
  if (pp.length !== sp.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!, s = sp[i]!
    if (p.startsWith(':')) out[p.slice(1)] = decodeURIComponent(s)
    else if (p !== s) return null
  }
  return out
}

// ------------------------------------------------------------------------------------------------ formatting

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// The household's zone (profile.timeZone, set at set-up; India when absent). The app sets it when the session loads, so every
// label below, and in Passbook and Activity, reads the same zone. Computed with Intl, never a fixed offset.
let displayZone = DEFAULT_ZONE
/** The household's home currency, from its session (R13 S7): every figure the interface writes reads in it; the rupee until a session says otherwise. */
let homeNow: Currency = 'INR'
setHomeCurrencySource(() => homeNow)
export const setHomeCurrency = (c: unknown): void => { homeNow = isPaperCurrency(c) ? c : 'INR' }
export const setDisplayZone = (zone?: string | null): void => { displayZone = isZone(zone) ? zone : DEFAULT_ZONE }
export const getDisplayZone = (): string => displayZone
/** "India Standard Time" for India, as the files have always said; otherwise the zone's name. */
export const zoneName = (): string => (displayZone === DEFAULT_ZONE ? 'India Standard Time' : displayZone)
/** "IST" for India, otherwise the zone's name: for a column heading, where one label serves a whole table. */
export const zoneHead = (): string => (displayZone === DEFAULT_ZONE ? 'IST' : displayZone)
/** The local date of an instant in the household's zone, "2026-07-02". */
export const zoneDay = (ms: number): string => zonedParts(ms, displayZone).date
/** The local weekday of an instant, 0 for Sunday. */
export const zoneWeekday = (ms: number): number => zonedParts(ms, displayZone).weekday
/** "2026-07-02T00:30:00.000+01:00": an instant written with its zone's offset at that instant, as the files do. */
export const zoneIso = (ms: number): string => {
  const off = offsetMs(ms, displayZone), a = Math.abs(off)
  const sign = off < 0 ? '-' : '+'
  return `${new Date(ms + off).toISOString().slice(0, -1)}${sign}${String(Math.floor(a / 3_600_000)).padStart(2, '0')}:${String(Math.floor((a % 3_600_000) / 60_000)).padStart(2, '0')}`
}
const parts = (ms: number) => { const d = new Date(ms + offsetMs(ms, displayZone)); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() } }
const p2 = (n: number) => String(n).padStart(2, '0')
/** All times are shown in the household's zone (India's unless the household set another). */
export const fmt = {
  /** The rupee, named: the rupee-only features (the chain's test rupees, the rupee desk, Indian tax and securities). */
  inr: (paise: number, paiseShown = false): string => inrBase(paise, { paise: paiseShown }),
  money: (paise: number, paiseShown = false): string => homeMoney(paise, undefined, { paise: paiseShown }),
  signed: (paise: number, paiseShown = true): string => homeMoney(paise, undefined, { paise: paiseShown, sign: 'always' }),
  words: (paise: number): string => inrWords(paise),
  day: (ms: number): string => { const p = parts(ms); return `${p.d} ${MONTHS[p.m]}` },
  dayYear: (ms: number): string => { const p = parts(ms); return `${p.d} ${MONTHS[p.m]} ${p.y}` },
  time: (ms: number, seconds = false): string => { const p = parts(ms); return `${p2(p.hh)}:${p2(p.mm)}${seconds ? `:${p2(p.ss)}` : ''}` },
  dayTime: (ms: number): string => `${fmt.day(ms)}, ${fmt.time(ms)}`,
  /** The date with its year, the minute and the zone: "18 Nov 2026, 11:00 IST". */
  at: (ms: number): string => `${fmt.dayYear(ms)}, ${fmt.time(ms)} ${zoneLabel(ms, displayZone)}`,
  full: (ms: number): string => `${fmt.dayYear(ms)}, ${fmt.time(ms, true)} ${zoneLabel(ms, displayZone)}`,
  /** "in 42 minutes", "3 hours ago". */
  rel: (ms: number, now: number): string => {
    const diff = ms - now, a = Math.abs(diff)
    const unit = a < 60_000 ? `${Math.max(1, Math.round(a / 1000))} second` : a < 3_600_000 ? `${Math.round(a / 60_000)} minute` : a < 172_800_000 ? `${Math.round(a / 3_600_000)} hour` : `${Math.round(a / 86_400_000)} day`
    const text = /^1 /.test(unit) ? unit : `${unit}s`
    return diff >= 0 ? `in ${text}` : `${text} ago`
  },
  age: (ms: number): string => (ms < 1500 ? 'just now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`),
  price: (s: string | null | undefined, dp = 2): string => (s == null ? 'no price' : Number(s).toLocaleString('en-IN', { maximumFractionDigits: dp })),
  pct: (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`,
  hash: (h: string | null | undefined): string => (h ? `${h.slice(0, 8)} ${h.slice(8, 16)}` : ''),
  /** A time to the millisecond, for records where the order of events matters. */
  precise: (ms: number): string => `${fmt.dayYear(ms)}, ${fmt.time(ms, true)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, '0')} ${zoneLabel(ms, displayZone)}`,
  /** "2026-11-20" as "20 Nov 2026". */
  isoDay: (d: string | null | undefined): string => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : d ?? '' },
  /** A price in the currency it is quoted in: rupees the Indian way, dollars the American way. */
  quoted: (price: string | number | null | undefined, quote: string, dp = 2): string => {
    if (price == null || price === '') return 'no price'
    const n = Number(price)
    if (quote === 'INR') return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp })}`
    if (quote === 'USD') return `$${n.toLocaleString('en-US', { maximumFractionDigits: dp })}`
    return `${n.toLocaleString('en-US', { maximumFractionDigits: dp })} ${quote}`
  },
}

const SOURCES: Record<string, string> = { coindcx: 'CoinDCX', binance: 'Binance', coinbase: 'Coinbase', amfi: 'AMFI', frankfurter: 'the ECB, through Frankfurter', nyfed: 'the New York Fed', mfapi: 'mfapi.in', test: 'a test fixture', 'synthetic-markets': 'synthetic prices generated on this QED installation (not market data)', synthetic: 'synthetic values generated on this QED installation (presentation mode)' }
/** The name of a data source as a person would say it. */
export const sourceName = (id: string | null | undefined): string => (id ? SOURCES[id] ?? id : 'an unnamed source')

/** Rupees typed by a person ("1,50,000" or "2500.50") to paise, or null when it is not an amount. */
export function rupeesToPaise(text: string): number | null {
  const s = text.replace(/[₹,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [r, p = ''] = s.split('.')
  const v = Number(r) * 100 + Number(p.padEnd(2, '0'))
  return Number.isSafeInteger(v) ? v : null
}
export const paiseToRupees = (p: number): string => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2))
