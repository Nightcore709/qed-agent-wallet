/**
 * A fund purchase's two days, in the order they happen (R13): the day of the NAV it was bought at, then the day its
 * units were allotted, which is that day or later (a NAV is published in the evening of its own day, and units are
 * allotted once it is). A record that says otherwise, as one did ("the NAV for Wed 25 Nov; allotted Tue 24 Nov"), is
 * never shown as a sequence: Grow names the NAV's day alone and says the allotment day is left out because the record
 * puts it first. Why the record said so is the server's question (the fund lifecycle), not the screen's to smooth over.
 * Pure: no screen imports.
 */
import { dayOf, dayText, istDay } from '../../shared/day-text.ts'

export interface NavDays { nav: string | null; allotted: string | null; inOrder: boolean }
export function navThenAllotted(navDate: string | null | undefined, allottedAt: number, now: number): NavDays {
  if (!navDate) return { nav: null, allotted: dayOf(allottedAt, now), inOrder: true }
  const inOrder = navDate <= istDay(allottedAt)
  return { nav: dayText(navDate, istDay(now)), allotted: inOrder ? dayOf(allottedAt, now) : null, inOrder }
}
/** Said where the allotment day is left out. */
export const OUT_OF_ORDER = 'allotment day not shown: the record puts it before the NAV\'s day'
