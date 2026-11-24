/**
 * Local dates and times in a household's own zone (stage S6 of the global money model, ADR-0012; R13).
 *
 * An instant is stored in UTC (Unix milliseconds), as before. A local date and time are worked out here with an IANA zone
 * through Intl, never with a fixed offset, so a zone with daylight saving is right on both sides of its changes. A local
 * time that does not exist (clocks going forward) is moved to after the gap, and one that happens twice (clocks going
 * back) is its first occurrence: Temporal's "compatible" choice.
 *
 * Asia/Kolkata gives exactly what server/core.ts ist() and istInstant() give (a property test checks it over 2000 to
 * 2100), so a household whose zone is the default sees no change. The zone rules are the runtime's own tzdata; the server
 * records their version beside anything authority depends on (server/calendars.ts TZ_VERSION).
 *
 * This module runs in the browser too: it uses Intl only.
 */
export const DEFAULT_ZONE = 'Asia/Kolkata'

export interface ZonedParts { date: string; hm: string; minutes: number; weekday: number; y: number; m: number; d: number }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const known = new Map<string, boolean>()
/**
 * An IANA zone name the runtime knows ("Asia/Kolkata", "Europe/London", "UTC"); never an abbreviation or an offset. Intl
 * decides, not Intl.supportedValuesOf: that list holds CLDR's canonical names, in which India is still "Asia/Calcutta".
 */
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false
  if (!/^(?:UTC|[A-Z][A-Za-z_-]+(?:\/[A-Z0-9][A-Za-z0-9_+-]*)+)$/.test(zone)) return false
  let ok = known.get(zone)
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); ok = true } catch { ok = false }
    if (known.size < 1024) known.set(zone, ok)
  }
  return ok
}

function checkZone(zone: string): void {
  if (!isZone(zone)) throw new RangeError(`"${zone}" is not a time zone this build knows (an IANA name such as Asia/Kolkata)`)
}

const formats = new Map<string, Intl.DateTimeFormat>()
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone)
  if (!f) {
    checkZone(zone)
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    formats.set(zone, f)
  }
  return f
}

const p2 = (n: number): string => String(n).padStart(2, '0')

function fields(ms: number, zone: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number } {
  const out: Record<string, string> = {}
  for (const p of format(zone).formatToParts(new Date(ms))) out[p.type] = p.value
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), hh: Number(out.hour), mm: Number(out.minute), ss: Number(out.second), weekday: WEEKDAY[out.weekday ?? ''] ?? -1 }
}

/** Calendar parts of an instant in a zone, in the shape core.ts ist() returns. */
export function zonedParts(ms: number, zone: string): ZonedParts {
  const f = fields(ms, zone)
  return { date: `${f.y}-${p2(f.m)}-${p2(f.d)}`, hm: `${p2(f.hh)}:${p2(f.mm)}`, minutes: f.hh * 60 + f.mm, weekday: f.weekday, y: f.y, m: f.m, d: f.d }
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetMs(ms: number, zone: string): number {
  const whole = Math.floor(ms / 1000) * 1000
  const f = fields(whole, zone)
  return Date.UTC(f.y, f.m - 1, f.d, f.hh, f.mm, f.ss) - whole
}

/** The instant of a local date ("2026-11-20") and time ("09:30") in a zone. */
export function zonedInstant(date: string, hm: string, zone: string): number {
  checkZone(zone)
  const wall = Date.parse(`${date}T${hm}:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hm) || !Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`"${date} ${hm}" is not a date and time`)
  }
  const before = offsetMs(wall - 86_400_000, zone), after = offsetMs(wall + 86_400_000, zone)
  const fits = [...new Set([before, after])].map((o) => wall - o).filter((t) => { const p = zonedParts(t, zone); return p.date === date && p.hm === hm })
  if (fits.length) return Math.min(...fits)
  return wall - before // the local time falls in a gap: the offset before the change puts it after the gap
}

/** The zone's short name at an instant, as the owner reads it: "IST" for India (as the wallet has always written), else Intl's. */
export function zoneLabel(ms: number, zone: string): string {
  if (zone === 'Asia/Kolkata') return 'IST'
  checkZone(zone)
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? zone
}

/** "20 Nov 2026, 09:24 IST": how a moment is written for the owner, in their zone. */
export function whenIn(ms: number, zone: string): string {
  const t = zonedParts(ms, zone)
  return `${t.d} ${MONTHS[t.m - 1]} ${t.y}, ${t.hm} ${zoneLabel(ms, zone)}`
}

/** "20 Nov 2026": a local date written for the owner. */
export const dateWords = (date: string): string => { const [y, m, d] = date.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}` }
