/**
 * How Grow writes prices, quantities, units and the day a published value is for. Kept apart from the chart
 * (src/ui/timechart.tsx), which is fetched as its own chunk after the page's figures and controls are drawn (R12 perf:
 * the phone waited for the chart's code before it could show what the investments are worth); timechart.tsx re-exports
 * the four formatters for its callers and tests.
 *
 * A price is written as the venue quotes it, at its own step, with the same number of decimals every time, so a figure
 * that changes never changes its width; a quantity at its own step, never rounded; a NAV with four decimals.
 */
import { sourceName } from '../lib/core.ts'
import type { MarketInstrument } from '../lib/types.ts'

export const MINUS = '−'
export const IST = 19_800_000
export const DAY = 86_400_000
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** How many decimals a price step has: "0.1" is 1, "0.01" is 2, "1" is 0. Unknown steps keep the fallback. */
export function priceDecimals(step: string | null | undefined, fallback: number): number {
  if (!step || !/^\d+(\.\d+)?$/.test(step) || !(Number(step) > 0)) return fallback
  const dot = step.indexOf('.')
  return dot < 0 ? 0 : step.slice(dot + 1).replace(/0+$/, '').length
}

/**
 * A price as the venue quotes it, at its own step, always with the same number of decimals: a quote that happens to
 * end in zero ("180000") keeps the width of its neighbours ("180583.3"). A price is not a sum (DESIGN.md, Figures), so
 * it is not rounded to rupees and paise.
 */
export function priceText(price: string | number | null | undefined, quote: string, decimals: number): string {
  if (price == null || price === '' || !Number.isFinite(Number(price))) return 'no price'
  const n = Number(price), o = { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
  if (quote === 'INR') return `₹${n.toLocaleString('en-IN', o)}` // a price, written at the quote's step
  if (quote === 'USD') return `$${n.toLocaleString('en-US', o)}`
  return `${n.toLocaleString('en-US', o)} ${quote}`
}

/**
 * A quantity at its own precision: written to the venue's quantity step (three places for fund units), never fewer
 * places than the record holds, so nothing is rounded away; the whole part grouped the Indian way.
 */
export function quantityText(qty: string, places: number): string {
  if (!/^\d+(\.\d+)?$/.test(qty)) return qty
  const [whole, frac = ''] = qty.split('.')
  const grouped = whole!.length > 3 ? `${whole!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole!.slice(-3)}` : whole!
  const f = frac.length >= places ? frac : frac.padEnd(places, '0')
  return f ? `${grouped}.${f}` : grouped
}
/** A quantity held in a venue's smallest units ("46000" at 8 places), as a decimal string ("0.00046"). */
export function atomsText(atoms: string, scale: number): string {
  if (!/^\d+$/.test(atoms)) return atoms
  const s = atoms.padStart(scale + 1, '0')
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s
  return scale ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}

/** A point's time: a recorded time as it is, a daily value (an ISO day) at noon India time. */
export const pointTime = (t: string | number): number => (typeof t === 'number' ? t : Date.parse(`${t}T12:00:00+05:30`))
/** The start of an ISO day in India time: where a published value for that day begins to hold. */
export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00+05:30`)
/** The ISO day (India time) a time falls on. */
export const isoDayOf = (t: number): string => new Date(t + IST).toISOString().slice(0, 10)
/** A day as a person reads it on a statement: "Mon 23 Nov 2026" (or without the year). */
export function dayWords(day: string, year = true): string {
  const d = new Date(dayStart(day) + IST)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`
}

// ------------------------------------------------------------------------------------------------ instruments

/** Decimals a value of this instrument is written with: its venue's price step, a NAV's four places, two otherwise. */
export const decimalsOf = (i: { kind: string; meta?: MarketInstrument['meta'] }): number => (i.kind === 'mutual_fund' || i.kind === 'tbill' || i.kind === 'gsec' ? 4 : priceDecimals(typeof i.meta?.priceTick === 'string' ? i.meta.priceTick : undefined, 2))
/** A value of an instrument, written exactly: a rate as a percentage, anything else at its step in its quote. */
export const show = (i: MarketInstrument, price: string | number | null | undefined): string => (i.kind === 'rate' ? (price == null || price === '' ? 'no value' : `${Number(price).toFixed(2)}%`) : priceText(price, i.quote, decimalsOf(i)))
/** What the value axis of an instrument's chart counts. */
export const unitOf = (i: MarketInstrument): string => (i.kind === 'rate' ? '% a year' : `${i.quote === 'INR' ? '₹' : i.quote === 'USD' ? '$' : i.quote} per ${i.kind === 'mutual_fund' || isUnits(i.kind) ? 'unit' : i.base}`)
/** The identifier one step below a plain name: the venue's market symbol, or a fund's scheme code. */
export const tickerOf = (i: { id: string; kind: string }): string => { const code = i.id.slice(i.id.indexOf(':') + 1); return i.kind === 'mutual_fund' ? `Scheme code ${code}` : code }
/** Held in whole units rather than in a coin's atoms: ETF units, shares, and bills and bonds (a unit is ₹100 of face value). */
export const isUnits = (kind: string): boolean => kind === 'etf' || kind === 'equity' || kind === 'tbill' || kind === 'gsec'
/** The word for what one holds of an instrument: units for funds, ETFs, bills and bonds; shares for a company. */
export const unitsWord = (kind: string, asset: string): string => (kind === 'mutual_fund' || kind === 'etf' || kind === 'tbill' || kind === 'gsec' ? 'units' : kind === 'equity' ? 'shares' : asset)
/** Places a quantity of a holding is written to: three for fund units, else the venue's quantity step. */
export const placesOf = (kind: string, inst: MarketInstrument | undefined, scale: number): number => (kind === 'mutual_fund' ? 3 : isUnits(kind) ? 0 : priceDecimals(typeof inst?.meta.qtyStep === 'string' ? inst.meta.qtyStep : undefined, Math.min(scale, 8)))
/** Whether a securities desk is open at `now`: its hours in India time, Monday to Friday. Holidays are not known here. */
export function deskStatus(i: { meta: MarketInstrument['meta'] }, now: number): { open: boolean; hours: string } {
  const h = (i.meta.hours as { open: string; close: string } | undefined) ?? { open: '09:15', close: '15:30' }
  const t = new Date(now + IST), mins = t.getUTCHours() * 60 + t.getUTCMinutes(), at = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
  const wd = t.getUTCDay()
  return { open: wd >= 1 && wd <= 5 && mins >= at(h.open) && mins < at(h.close), hours: `${h.open} to ${h.close} India time, Monday to Friday` }
}
/** A share of a whole: under one per cent says so, rather than rounding to nothing. */
export const pctText = (x: number): string => (x > 0 && x < 0.001 ? 'under 0.1%' : `${(x * 100).toFixed(1)}%`)
/** A change between two values as a person reads it: "up 0.42%", "down 1.07%", "unchanged". */
export const moved = (x: number): string => (Math.abs(x) < 0.00005 ? 'unchanged' : `${x > 0 ? 'up' : 'down'} ${(Math.abs(x) * 100).toFixed(2)}%`)
/** Where a quote came from, as a person names the source. */
export const fromOf = (inst: MarketInstrument, type: string): string => sourceName(inst.quotes[type]?.provider ?? inst.provider)
/** What a published value is called: a fund's NAV, a rate, or a reference value. */
export const dailyWord = (priceType: string): string => (priceType === 'nav' ? 'NAV' : priceType === 'rate' ? 'Rate' : 'Value')
