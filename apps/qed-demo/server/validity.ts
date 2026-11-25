/**
 * How long a resting order stands (R14, capability 13). The owner chooses: until cancelled (the default, and what every
 * resting order was before this existed), until the end of the market day, or until a date and time within 90 days.
 * The choice becomes an absolute instant here, once, and that instant is part of the order's terms in the document the
 * passkey signs (owner.ts), so a different expiry cannot be substituted after approval. India's zone is used throughout:
 * the paper crypto venue's day is the Indian calendar day, ending at midnight.
 */
import { addDays, bad, ist, istInstant, whenIst } from './core.ts'

export type OrderValidity = { kind: 'gtc' } | { kind: 'day'; expiresAt: number } | { kind: 'until'; expiresAt: number }
export const MAX_VALIDITY_DAYS = 90
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A real calendar day: month 1 to 12, and a day that month has (never reaching a date function with anything else). */
function realDay(date: string): boolean {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10))
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The validity a request states, as an absolute term. Throws a field error on anything unclear, past, or too far away. */
export function resolveValidity(raw: Record<string, unknown>, type: string, now: number): OrderValidity {
  const choice = raw.validity === undefined || raw.validity === null || raw.validity === '' ? 'gtc' : raw.validity
  if (choice !== 'gtc' && choice !== 'day' && choice !== 'until') throw bad('Choose how long the order stands.', { validity: 'Choose how long the order stands.' })
  if (type !== 'limit') {
    if (choice === 'gtc') return { kind: 'gtc' }
    throw bad('Only a resting order has a time it stands until.', { validity: 'Only a resting order has a time it stands until.' })
  }
  if (choice === 'gtc') return { kind: 'gtc' }
  if (choice === 'day') return { kind: 'day', expiresAt: istInstant(addDays(ist(now).date, 1), '00:00') }
  const date = raw.untilDate, time = raw.untilTime
  const valid = typeof date === 'string' && typeof time === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && realDay(date)
  if (!valid) throw bad('Enter a valid date and time.', { untilDate: 'Enter a valid date and time.' })
  const at = istInstant(date, time)
  if (at <= now) throw bad('Choose a time in the future.', { untilDate: 'Choose a time in the future.' })
  if (at > now + MAX_VALIDITY_DAYS * 86_400_000) throw bad(`Choose a time within ${MAX_VALIDITY_DAYS} days from now.`, { untilDate: `Choose a time within ${MAX_VALIDITY_DAYS} days from now.` })
  return { kind: 'until', expiresAt: at }
}

/** In words, for the sheet and the records: when a resting order ends. */
export function standsUntilText(v: OrderValidity | undefined): string {
  if (!v || v.kind === 'gtc') return 'Until you cancel it'
  // the day's end is the instant midnight begins the next; said as the day it was placed, so it is not read as the end of the next one
  if (v.kind === 'day') { const t = ist(v.expiresAt - 1); return `The end of ${t.d} ${MONTHS[t.m - 1]} ${t.y} (midnight IST)` }
  return whenIst(v.expiresAt)
}
