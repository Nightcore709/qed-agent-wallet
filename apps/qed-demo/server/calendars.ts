/**
 * Calendars as data (stage S6 of the global money model; R13 section 5): which days are business days, in each calendar's
 * own zone, and where every holiday comes from. A holiday is either from a dated, cited source or labelled synthetic; a
 * calendar with no cited holidays for a month says so for that month rather than presenting weekends as the whole truth.
 *
 * Cited: the RBI holiday matrix for Mumbai, November 2026 (10 and 24 Nov), and that the second and fourth Saturdays are
 * bank holidays (compliance research CAL-04, read 19 Nov 2026, Verified). Everything else here is synthetic: the other
 * months of India, every foreign calendar's holidays, and the weekend days of the United Arab Emirates and Bahrain, which
 * are general knowledge and were not read from a primary source (NOT VERIFIED). NSE and BSE trading holidays are not used:
 * the research found them only in a broker's list, with a conflict (CAL-01, Hypothesis-S).
 */
import { addDays } from './core.ts'
import { zonedInstant, zonedParts } from '../shared/zone.ts'

export interface CalendarSource { kind: 'cited' | 'synthetic'; words: string; asOf: string; from?: string; to?: string }
export interface Calendar {
  id: string
  name: string
  zone: string
  /** Weekdays that are never business days (0 Sunday … 6 Saturday). */
  weekend: readonly number[]
  /** Saturdays of the month that are holidays (2 and 4 for India's banks). */
  saturdaysOff?: readonly number[]
  holidays: Readonly<Record<string, string>>
  sources: readonly CalendarSource[]
}

const SYNTHETIC_FOREIGN = (who: string, weekend: string): CalendarSource => ({ kind: 'synthetic', asOf: '2026-11-24', words: `Synthetic: ${weekend} only; ${who}'s public holidays were not read from a dated source and are not applied.` })

export const CALENDARS: Readonly<Record<string, Calendar>> = {
  IN: {
    id: 'IN', name: 'The paper bank in India (Mumbai bank holidays)', zone: 'Asia/Kolkata', weekend: [0], saturdaysOff: [2, 4],
    holidays: { '2026-11-10': 'Bank holiday (Mumbai)', '2026-11-24': 'Bank holiday (Mumbai)' },
    sources: [
      { kind: 'cited', from: '2026-11-01', to: '2026-11-30', asOf: '2026-11-19', words: 'Cited: RBI holiday matrix, Mumbai, November 2026 (10 and 24 Nov), and the second and fourth Saturdays (https://www.rbi.org.in/Scripts/HolidayMatrixDisplay.aspx, read 19 Nov 2026; research CAL-04)' },
      { kind: 'synthetic', asOf: '2026-11-24', words: 'Synthetic outside November 2026: Sundays and the second and fourth Saturdays only; other months\' holidays were not read and are not applied.' },
    ],
  },
  US: { id: 'US', name: 'United States', zone: 'America/New_York', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('the United States', 'Saturdays and Sundays')] },
  TARGET: { id: 'TARGET', name: 'Euro area (TARGET)', zone: 'Europe/Berlin', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('TARGET', 'Saturdays and Sundays')] },
  UK: { id: 'UK', name: 'United Kingdom', zone: 'Europe/London', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('the United Kingdom', 'Saturdays and Sundays')] },
  AE: { id: 'AE', name: 'United Arab Emirates', zone: 'Asia/Dubai', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('the United Arab Emirates', 'Saturdays and Sundays (the weekend as generally reported since 2022, NOT VERIFIED)')] },
  SG: { id: 'SG', name: 'Singapore', zone: 'Asia/Singapore', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('Singapore', 'Saturdays and Sundays')] },
  JP: { id: 'JP', name: 'Japan', zone: 'Asia/Tokyo', weekend: [0, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('Japan', 'Saturdays and Sundays')] },
  BH: { id: 'BH', name: 'Bahrain', zone: 'Asia/Bahrain', weekend: [5, 6], holidays: {}, sources: [SYNTHETIC_FOREIGN('Bahrain', 'Fridays and Saturdays (the weekend as generally reported, NOT VERIFIED)')] },
}

/** The calendars of the venues QED trades on, in words: what decides their days, and whether it is cited or synthetic. */
export const VENUE_CALENDARS: Readonly<Record<string, { calendar: string | null; words: string }>> = {
  'paper-mf': { calendar: null, words: 'Synthetic: the paper fund registrar counts weekdays in India as business days and applies no holidays. The exchanges\' own holiday circulars were not read; a broker\'s list (research CAL-01, Hypothesis-S, with a conflict) is not used.' },
  'paper-crypto': { calendar: null, words: 'The paper exchange trades every day: its own modelled rule, as crypto venues do.' },
  'paper-rail': { calendar: 'IN', words: 'The paper bank\'s India calendar: cited for November 2026 (RBI, Mumbai), synthetic otherwise.' },
  'paper-fx-desk': { calendar: null, words: 'A conversion settles at once on paper, every day: the paper desk\'s own modelled rule.' },
}

const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay()

/** Whether a local date is a business day in a calendar. */
export function isBusinessDay(c: Calendar, date: string): boolean {
  const wd = weekdayOf(date)
  if (c.weekend.includes(wd)) return false
  if (wd === 6 && c.saturdaysOff?.length) {
    const nth = Math.ceil(Number(date.slice(8, 10)) / 7)
    if (c.saturdaysOff.includes(nth)) return false
  }
  return !(date in c.holidays)
}

/** The business day n business days after a date (n ≥ 1), or the date itself or the next business day for n = 0. */
export function addBusinessDays(c: Calendar, date: string, n: number): string {
  let d = date
  if (n === 0) { while (!isBusinessDay(c, d)) d = addDays(d, 1); return d }
  for (let left = n; left > 0;) { d = addDays(d, 1); if (isBusinessDay(c, d)) left-- }
  return d
}

/** Where a date's holidays in this calendar come from, in words. */
export function calendarWords(c: Calendar, date: string): string {
  const cited = c.sources.find((s) => s.kind === 'cited' && s.from && s.to && s.from <= date && date <= s.to)
  return (cited ?? c.sources.find((s) => s.kind === 'synthetic') ?? c.sources[0]!).words
}

/** The India business day a payment approved at `now` is sent on: today before the cut-off (IST) on a business day, else the next. */
export function sendDate(now: number, cutoff: string): string {
  const IN = CALENDARS.IN!
  const t = zonedParts(now, IN.zone)
  const beforeCutoff = now < zonedInstant(t.date, cutoff, IN.zone)
  return isBusinessDay(IN, t.date) && beforeCutoff ? t.date : addBusinessDays(IN, t.date, 1)
}
