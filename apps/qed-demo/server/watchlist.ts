/**
 * A household's watchlist (R14, Grow): the names it watches, each row built from the market data QED already holds and
 * nothing else. A row has the latest price with the provider that gave it, the time of that price, and whether the price is
 * observed (read from a public source) or synthetic (generated on this QED installation: the paper exchange); the change since the
 * price at the moment the name was added (stored then: price, type, provider and times); and a stale flag by the source's own
 * freshness rule (market.ts freshness). It moves no money, places no order and gives no advice: buying or selling from a
 * row opens the ordinary ticket, which keeps its approval.
 *
 * It is per household (user_id is the workspace), at most 50, and adding a name already on the list changes nothing: the
 * first price and time stay. Rows are read for any member; changing the list needs the operator role (api.ts route table).
 */
import { AppError, audit, type Db } from './core.ts'
import { freshness, type Market, type PriceType, type Precision } from './market.ts'
import { type Instrument, instrument } from './registry.ts'

export const WATCH_MAX = 50
/** The providers whose prices QED generates itself; every other provider's price was read from a public source. */
const SYNTHETIC_PROVIDERS = new Set(['synthetic-markets', 'synthetic'])

/** The price a name is watched by: a fund's NAV, a rate or reference as published, and for anything quoted by bid and ask the price buyers offer (what a sale would fetch, as Grow values holdings). */
export const watchPriceType = (i: Pick<Instrument, 'kind'>): PriceType => (i.kind === 'mutual_fund' ? 'nav' : i.kind === 'fx_reference' ? 'reference' : i.kind === 'rate' ? 'rate' : 'bid')

export interface WatchItem {
  instrumentId: string; name: string; kind: string; quote: string; tradable: boolean
  priceType: PriceType; price: string | null
  /** Who gave the price (the instrument's own provider when none has yet), and whether it is observed or synthetic. */
  provider: string; basis: 'observed' | 'synthetic'
  precision: Precision | null
  /** The time of the price: the source's own when it gives one (for a published value, the day it is for), otherwise null when none has arrived. */
  at: number | null; recvTs: number | null; ageMs: number | null
  stale: boolean; status: string
  addedAt: number; addedPrice: string | null; addedProvider: string | null; addedPriceAt: number | null
  change: string | null; changePct: number | null; changeNote: string | null
}
export interface WatchlistView { items: WatchItem[]; count: number; max: number }

const decimals = (s: string): number => (s.split('.')[1] ?? '').length
/** b minus a, written with the figures' own decimals (exact: whole numbers in a bigint). */
function difference(a: string, b: string): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b)) return null
  const d = Math.max(decimals(a), decimals(b))
  const whole = (s: string): bigint => { const [i, f = ''] = s.split('.'); return BigInt(i! + f.padEnd(d, '0')) }
  const x = whole(b) - whole(a)
  const neg = x < 0n, abs = (neg ? -x : x).toString().padStart(d + 1, '0')
  const text = d === 0 ? abs : `${abs.slice(0, -d)}.${abs.slice(-d)}`
  return `${neg ? '-' : ''}${text}`
}

interface Row { instrument_id: string; added_at: number; price_type: string; added_price: string | null; added_provider: string | null; added_source_ts: number | null; added_recv_ts: number | null }

function itemOf(i: Instrument, r: Row, market: Market, now: number): WatchItem {
  const type = watchPriceType(i)
  const t = market.get(i.id, type)
  const f = freshness(t, i, now)
  const provider = t?.provider ?? i.provider
  let change: string | null = null, changePct: number | null = null, changeNote: string | null = null
  if (!t) changeNote = r.added_price === null ? 'No price was on record when you added it, and none has arrived since.' : 'No price has arrived since you added it.'
  else if (r.added_price === null) changeNote = 'No price was on record when you added it.'
  else if (r.price_type !== type || r.added_provider !== t.provider) changeNote = 'The price now comes from a different source than when you added it, so the two are not compared.'
  else {
    change = difference(r.added_price, t.price)
    const base = Number(r.added_price)
    changePct = change !== null && base > 0 ? Math.round((Number(change) / base) * 10_000) / 100 : null
    if (change === null) changeNote = 'The change could not be worked out.'
  }
  return {
    instrumentId: i.id, name: i.name, kind: i.kind, quote: i.quote_asset, tradable: i.tradable === 1, priceType: type, price: t?.price ?? null,
    provider, basis: SYNTHETIC_PROVIDERS.has(provider) ? 'synthetic' : 'observed', precision: t?.precision ?? null,
    at: t ? (t.sourceTs ?? t.recvTs) : null, recvTs: t?.recvTs ?? null, ageMs: Number.isFinite(f.ageMs) ? f.ageMs : null,
    stale: f.stale, status: f.label,
    addedAt: r.added_at, addedPrice: r.added_price, addedProvider: r.added_provider, addedPriceAt: r.added_source_ts ?? r.added_recv_ts,
    change, changePct, changeNote,
  }
}

export function watchlistView(db: Db, market: Market, userId: string, now: number): WatchlistView {
  const rows = db.all<Row>('SELECT * FROM watchlist_items WHERE user_id = ? ORDER BY added_at, instrument_id', userId)
  const items = rows.flatMap((r) => { const i = instrument(db, r.instrument_id); return i ? [itemOf(i, r, market, now)] : [] })
  return { items, count: items.length, max: WATCH_MAX }
}

/** Adds a name, taking its price now as the one the change is counted from. Adding one already listed changes nothing. */
export function addWatch(db: Db, market: Market, userId: string, role: string, instrumentId: string, now: number, ip: string | null = null): { added: boolean; count: number; item: WatchItem } {
  const i = typeof instrumentId === 'string' ? instrument(db, instrumentId) : undefined
  if (!i) throw new AppError(404, 'not_found', 'QED does not offer that name, so it cannot be watched.')
  const count = (): number => db.get<{ n: number }>('SELECT COUNT(*) n FROM watchlist_items WHERE user_id = ?', userId)!.n
  const have = db.get<Row>('SELECT * FROM watchlist_items WHERE user_id = ? AND instrument_id = ?', userId, i.id)
  if (have) return { added: false, count: count(), item: itemOf(i, have, market, now) }
  if (count() >= WATCH_MAX) throw new AppError(409, 'watchlist_full', `Your watchlist holds ${WATCH_MAX} names, which is the most. Remove one to add another.`)
  const type = watchPriceType(i)
  const t = market.get(i.id, type)
  db.run('INSERT INTO watchlist_items (user_id, instrument_id, added_at, added_role, price_type, added_price, added_provider, added_source_ts, added_recv_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId, i.id, now, role, type, t?.price ?? null, t?.provider ?? null, t?.sourceTs ?? null, t?.recvTs ?? null)
  audit(db, now, userId, role, 'watchlist.add', i.id, { priceType: type, price: t?.price ?? null, provider: t?.provider ?? null }, ip)
  const row = db.get<Row>('SELECT * FROM watchlist_items WHERE user_id = ? AND instrument_id = ?', userId, i.id)!
  return { added: true, count: count(), item: itemOf(i, row, market, now) }
}

export function removeWatch(db: Db, userId: string, role: string, instrumentId: string, now: number, ip: string | null = null): { removed: boolean } {
  const id = typeof instrumentId === 'string' ? instrumentId : ''
  if (!db.get('SELECT 1 FROM watchlist_items WHERE user_id = ? AND instrument_id = ?', userId, id)) return { removed: false }
  db.run('DELETE FROM watchlist_items WHERE user_id = ? AND instrument_id = ?', userId, id)
  audit(db, now, userId, role, 'watchlist.remove', id, {}, ip)
  return { removed: true }
}
