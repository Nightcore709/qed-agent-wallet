/** When a schedule fires. Pure functions of the schedule and an instant, in the schedule's zone (India Standard Time when it states none). */
import { addDays } from './core.ts'
import { nextMonthly } from './household.ts'
import type { Schedule } from './types.ts'
import { DEFAULT_ZONE, whenIn, zonedInstant, zonedParts } from '../shared/zone.ts'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The zone a schedule's clock times are read in: the one it states, else India (what documents before format 2 meant). */
export const scheduleZone = (s: Pick<Schedule, 'zone'>): string => s.zone ?? DEFAULT_ZONE
/** "IST" for India, as always; otherwise the zone's name and "time": "Europe/London time". */
const zoneWords = (zone: string): string => (zone === DEFAULT_ZONE ? 'IST' : `${zone} time`)

export function describeSchedule(s: Schedule): string {
  const zone = scheduleZone(s)
  switch (s.type) {
    case 'every': return s.minutes % 1440 === 0 ? `every ${s.minutes / 1440} day${s.minutes === 1440 ? '' : 's'}` : s.minutes % 60 === 0 ? `every ${s.minutes / 60} hour${s.minutes === 60 ? '' : 's'}` : `every ${s.minutes} minute${s.minutes === 1 ? '' : 's'}`
    case 'daily': return `every day at ${s.at} ${zoneWords(zone)}`
    case 'weekly': return `every ${WEEKDAYS[s.weekday]} at ${s.at} ${zoneWords(zone)}`
    case 'monthly': return `on day ${s.day} of each month at ${s.at} ${zoneWords(zone)}`
    case 'once': return `once, at ${whenIn(s.at, zone)}`
  }
}

/** The first instant strictly after `after` at which the schedule fires, or null when it never fires again. */
export function nextDue(s: Schedule, after: number): number | null {
  const zone = scheduleZone(s)
  switch (s.type) {
    case 'every': return Math.floor(after / 60_000) * 60_000 + s.minutes * 60_000
    case 'daily': { const t = zonedInstant(zonedParts(after, zone).date, s.at, zone); return t > after ? t : zonedInstant(addDays(zonedParts(after, zone).date, 1), s.at, zone) }
    case 'weekly': { for (let i = 0; i < 8; i++) { const d = addDays(zonedParts(after, zone).date, i); const t = zonedInstant(d, s.at, zone); if (new Date(`${d}T00:00:00Z`).getUTCDay() === s.weekday && t > after) return t } return null }
    case 'monthly': return nextMonthly(after, s.day, s.at, zone)
    case 'once': return s.at > after ? s.at : null
  }
}

/** When a newly activated program first runs: the next whole minute for interval schedules, otherwise the next scheduled time. */
export function firstDue(s: Schedule, now: number): number | null {
  if (s.type === 'every') return Math.ceil((now + 1) / 60_000) * 60_000
  if (s.type === 'once') return Math.max(s.at, now)
  return nextDue(s, now)
}
