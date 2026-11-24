/**
 * A household's own time zone (stage S6 of the global money model): local dates and times through IANA zones, with
 * Asia/Kolkata giving exactly what the IST helpers of server/core.ts give, so the existing household sees no change.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ist, istInstant } from '../server/core.ts'
import { DEFAULT_ZONE, isZone, whenIn, zoneLabel, zonedInstant, zonedParts } from './zone.ts'

const instant = fc.integer({ min: Date.parse('2000-01-01T00:00:00Z'), max: Date.parse('2100-01-01T00:00:00Z') })

describe('a household time zone', () => {
  it('defaults to India Standard Time, by its IANA name', () => {
    expect(DEFAULT_ZONE).toBe('Asia/Kolkata')
    expect(isZone('Asia/Kolkata')).toBe(true)
    expect(isZone('Europe/London')).toBe(true)
    for (const bad of ['', 'IST', 'Mars/Olympus', '+05:30', 'Asia/Kolkata ', 42, null]) expect(isZone(bad)).toBe(false)
  })

  it('in Asia/Kolkata, gives exactly the parts and instants core.ts ist() and istInstant() give', () => {
    fc.assert(fc.property(instant, (ms) => {
      const z = zonedParts(ms, 'Asia/Kolkata'), i = ist(ms)
      expect({ date: z.date, hm: z.hm, minutes: z.minutes, weekday: z.weekday, y: z.y, m: z.m, d: z.d }).toEqual(i)
      expect(zonedInstant(i.date, i.hm, 'Asia/Kolkata')).toBe(istInstant(i.date, i.hm))
    }), { numRuns: 400 })
  })

  it('round-trips a local date and time in a zone with daylight saving', () => {
    fc.assert(fc.property(instant, (ms) => {
      const minute = ms - (((ms % 60_000) + 60_000) % 60_000)
      const p = zonedParts(minute, 'Europe/London')
      const back = zonedInstant(p.date, p.hm, 'Europe/London')
      // the hour that occurs twice when clocks go back maps to its first occurrence
      expect(back === minute || back === minute - 3_600_000).toBe(true)
      expect(zonedParts(back, 'Europe/London').hm).toBe(p.hm)
    }), { numRuns: 400 })
  })

  it('moves a local time that does not exist (clocks going forward) to after the gap, and takes the first of a repeated one', () => {
    // 29 Mar 2026: London goes from 01:00 GMT to 02:00 BST, so 01:30 does not exist
    expect(new Date(zonedInstant('2026-03-29', '01:30', 'Europe/London')).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // 25 Oct 2026: 01:30 happens twice in London (BST, then GMT): the first is 00:30 UTC
    expect(new Date(zonedInstant('2026-10-25', '01:30', 'Europe/London')).toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(new Date(zonedInstant('2026-07-01', '09:30', 'Europe/London')).toISOString()).toBe('2026-07-01T08:30:00.000Z')
    expect(new Date(zonedInstant('2026-12-01', '09:30', 'Europe/London')).toISOString()).toBe('2026-12-01T09:30:00.000Z')
  })

  it('writes a moment for the owner as before in India, and with the zone\'s own label elsewhere', () => {
    const t = Date.parse('2026-11-20T03:54:00Z')
    expect(whenIn(t, 'Asia/Kolkata')).toBe('20 Nov 2026, 09:24 IST')
    expect(zoneLabel(t, 'Asia/Kolkata')).toBe('IST')
    expect(whenIn(t, 'Europe/London')).toBe('20 Nov 2026, 03:54 GMT')
    expect(whenIn(Date.parse('2026-07-20T03:54:00Z'), 'Europe/London')).toBe('20 Jul 2026, 04:54 BST')
    expect(whenIn(t, 'Asia/Tokyo')).toBe('20 Nov 2026, 12:54 GMT+9')
  })

  it('refuses a zone it does not know rather than guess one', () => {
    expect(() => zonedParts(0, 'Mars/Olympus')).toThrow(/time zone/)
    expect(() => zonedInstant('2026-11-20', '09:00', 'IST')).toThrow(/time zone/)
    expect(() => zonedInstant('2026-02-30', '09:00', DEFAULT_ZONE)).toThrow(/date/)
  })
})
