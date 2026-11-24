/**
 * A day in household words, the same on the server's order sheet and in the interface: "Wed 25 Nov", as the rest of
 * the app writes a near day (src/ui/charts.tsx dayName), with the year only when it is not the year of the day it is
 * read on ("Fri 1 Jan 2027" on 31 Dec 2026). R12 task comparison, T4-a: the order sheet said "Executes at the NAV for
 * 2026-11-25", a database's date, where a person reads "the NAV for Wed 25 Nov".
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_MS = 19_800_000

/** "2026-11-25" as "Wed 25 Nov"; with `ref` (an ISO day), the year is added when it differs from ref's. Not a calendar day: returned as it is. */
export function dayText(iso: string, ref?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const at = new Date(Date.UTC(y, mo - 1, d))
  // 2026-02-30 would roll over into March: a day that does not exist is not named
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return iso
  const refYear = ref && /^\d{4}-/.test(ref) ? Number(ref.slice(0, 4)) : y
  return `${WEEKDAYS[at.getUTCDay()]} ${d} ${MONTHS[mo - 1]}${y === refYear ? '' : ` ${y}`}`
}

/** The India-time calendar day (ISO) an instant falls on. */
export const istDay = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10)

/** The India-time day of an instant in household words; with `refMs`, the year is added when it is not refMs's year. */
export const dayOf = (ms: number, refMs?: number): string => dayText(istDay(ms), refMs === undefined ? undefined : istDay(refMs))
