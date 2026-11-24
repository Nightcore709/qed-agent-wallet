/**
 * Periods for the Statement and Activity (R12 task comparison, gap 9), shared by the server, which reads the ledger for a
 * period, and the interface, which offers the choice and names the files. Days and weeks are in the household's time zone
 * (R13: an IANA zone, shared/zone.ts), India Standard Time (UTC+05:30, no daylight saving) when none is given, computed then
 * exactly as before; a week starts on Monday (as the calendars of coming runs do), a month on its 1st.
 *
 * A period is a half-open span of instants: from 00:00 local time of its first day (inclusive) to 00:00 local time of the
 * day after its last day (exclusive). A moment exactly at midnight therefore belongs to the day that starts then and to no
 * other, and consecutive periods share no moment and miss none. "Since opening" has no start and runs to now.
 */
import { DEFAULT_ZONE, zonedInstant, zonedParts } from './zone.ts'

export const IST_MS = 19_800_000
const DAY_MS = 86_400_000

export type PeriodKind = 'all' | 'week' | 'month' | 'last-month' | 'dates'
/** Since the account was opened, to now. */
export interface OpenPeriod { kind: 'all'; first: null; last: string; from: null; to: null }
/** A span of whole India days: `first` and `last` inclusive (YYYY-MM-DD), `from` inclusive and `to` exclusive (instants). */
export interface DayPeriod { kind: Exclude<PeriodKind, 'all'>; first: string; last: string; from: number; to: number }
export type Period = OpenPeriod | DayPeriod

/** Dates a person chose, or a field's own complaint about them. */
export interface ChosenDates { first: string; last: string }
export type DateFields = Partial<Record<keyof ChosenDates, string>>

/** Chosen dates that cannot make a period: the words for each field that is wrong. */
export class PeriodError extends Error {
  readonly fields: DateFields
  constructor(fields: DateFields) {
    super(fields.first ?? fields.last ?? 'Check the dates.')
    this.fields = fields
  }
}

/** The India day of an instant, "2026-11-24". */
export const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10)
/** The instant at which an India day starts (00:00 IST). */
export const dayStartIst = (date: string): number => Date.parse(`${date}T00:00:00.000Z`) - IST_MS
/** The local day of an instant in a zone ("2026-11-24"); India's by default, computed as before. */
export const dayIn = (ms: number, zone: string = DEFAULT_ZONE): string => (zone === DEFAULT_ZONE ? istDate(ms) : zonedParts(ms, zone).date)
/** The instant a local day starts (00:00) in a zone; India's by default, computed as before. */
export const dayStartIn = (date: string, zone: string = DEFAULT_ZONE): number => (zone === DEFAULT_ZONE ? dayStartIst(date) : zonedInstant(date, '00:00', zone))
/** The India day after this one. */
export const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10)
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** A real calendar date written YYYY-MM-DD (not 2026-02-30). */
export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T00:00:00.000Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (date: string): [number, number, number] => date.split('-').map(Number) as [number, number, number]
/** "23 November 2026", or with its weekday, "Monday 23 November 2026". */
export function dayWords(date: string, weekday = false): string {
  const [y, m, d] = parts(date)
  return `${weekday ? `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ` : ''}${d} ${MONTHS[m - 1]} ${y}`
}
/** "2 Nov 2026", as a field's message writes a date. */
const shortDay = (date: string): string => { const [y, m, d] = parts(date); return `${d} ${SHORT[m - 1]} ${y}` }

/** What is wrong with two dates a person typed, field by field, or null when they make a period. */
export function checkDates(first: unknown, last: unknown): DateFields | null {
  if (!isDate(first)) return { first: 'Give the first day as a date.' }
  if (!isDate(last)) return { last: 'Give the last day as a date.' }
  if (last < first) return { last: `The last day, ${shortDay(last)}, is before the first day, ${shortDay(first)}.` }
  return null
}

const span = (kind: DayPeriod['kind'], first: string, last: string, zone: string): DayPeriod => ({ kind, first, last, from: dayStartIn(first, zone), to: dayStartIn(nextDay(last), zone) })

/**
 * The period of a kind, as it stands at `now`: this week (Monday to Sunday), this month, last month, chosen dates, or
 * since opening. Chosen dates that are missing or wrong are refused with a PeriodError, never guessed.
 */
export function periodOf(kind: 'all', now: number, dates?: undefined, zone?: string): OpenPeriod
export function periodOf(kind: DayPeriod['kind'], now: number, dates?: Partial<ChosenDates>, zone?: string): DayPeriod
export function periodOf(kind: PeriodKind, now: number, dates?: Partial<ChosenDates>, zone?: string): Period
export function periodOf(kind: PeriodKind, now: number, dates?: Partial<ChosenDates>, zone: string = DEFAULT_ZONE): Period {
  const today = dayIn(now, zone)
  const [y, m] = parts(today)
  const monthFirst = (yy: number, mm: number): string => `${yy}-${String(mm).padStart(2, '0')}-01`
  switch (kind) {
    case 'all': return { kind, first: null, last: today, from: null, to: null }
    case 'week': {
      const back = (new Date(Date.parse(`${today}T00:00:00.000Z`)).getUTCDay() + 6) % 7 // days since Monday
      const first = addDays(today, -back)
      return span(kind, first, addDays(first, 6), zone)
    }
    case 'month': {
      const first = monthFirst(y, m)
      return span(kind, first, addDays(m === 12 ? monthFirst(y + 1, 1) : monthFirst(y, m + 1), -1), zone)
    }
    case 'last-month': {
      const first = m === 1 ? monthFirst(y - 1, 12) : monthFirst(y, m - 1)
      return span(kind, first, addDays(monthFirst(y, m), -1), zone)
    }
    case 'dates': {
      const wrong = checkDates(dates?.first, dates?.last)
      if (wrong) throw new PeriodError(wrong)
      return span(kind, dates!.first!, dates!.last!, zone)
    }
  }
}

/** Whether the period is still running at `now` (its end is after now). */
export const running = (p: Period, now: number): boolean => p.to === null || p.to > now

/**
 * The period as a person reads it: "This week: Monday 23 November 2026 to now", "Last month: 1 October 2026 to
 * 31 October 2026", "5 October 2026". `opened` is the India day the account was opened, for "since opening".
 */
export function periodWords(p: Period, now: number, opened?: string | null): string {
  if (p.kind === 'all') return `Since the account was opened${opened ? `, ${dayWords(opened)},` : ''} to now`
  const live = running(p, now) && p.from <= now
  const body = live ? `${dayWords(p.first, p.kind === 'week')} to now` : p.first === p.last ? dayWords(p.first) : `${dayWords(p.first)} to ${dayWords(p.last)}`
  return p.kind === 'week' ? `This week: ${body}` : p.kind === 'month' ? `This month: ${body}` : p.kind === 'last-month' ? `Last month: ${body}` : body
}

/**
 * A file name that says which days the file covers: "qed-bank-statement-2026-10-01-to-2026-10-31.csv". While the period
 * runs it ends today, not on a day that has not come; one day is named once.
 */
export function periodFileName(prefix: string, p: Period, now: number, opened?: string | null, zone: string = DEFAULT_ZONE): string {
  const today = dayIn(now, zone)
  const first = p.first ?? opened ?? today
  const last = running(p, now) && first <= today && today < p.last ? today : p.last
  return `${prefix}-${first === last ? first : `${first}-to-${last}`}.csv`
}
