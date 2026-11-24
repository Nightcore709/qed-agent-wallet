/**
 * Calendars as data (stage S6; R13 section 5): every holiday comes from a dated, cited source or is labelled synthetic;
 * business days and value dates are computed in each calendar's own zone.
 */
import { describe, expect, it } from 'vitest'
import { addBusinessDays, CALENDARS, calendarWords, isBusinessDay, sendDate, VENUE_CALENDARS } from './calendars.ts'

describe('calendars', () => {
  it('every calendar says where its holidays come from: a dated, cited source, or synthetic', () => {
    for (const c of Object.values(CALENDARS)) {
      expect(c.zone.length).toBeGreaterThan(2)
      for (const s of c.sources) {
        expect(['cited', 'synthetic']).toContain(s.kind)
        if (s.kind === 'cited') { expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(s.words).toMatch(/RBI/) }
        else expect(s.words).toMatch(/synthetic/i)
      }
    }
    for (const v of Object.values(VENUE_CALENDARS)) expect(v.words).toMatch(/cited|synthetic|every day/i)
  })

  it('India: Sundays, the second and fourth Saturdays and the cited November 2026 holidays in Mumbai are not business days', () => {
    const IN = CALENDARS.IN!
    expect(isBusinessDay(IN, '2026-11-10')).toBe(false) // cited holiday (RBI holiday matrix, Mumbai)
    expect(isBusinessDay(IN, '2026-11-24')).toBe(false)
    expect(isBusinessDay(IN, '2026-11-14')).toBe(false) // second Saturday
    expect(isBusinessDay(IN, '2026-11-28')).toBe(false) // fourth Saturday
    expect(isBusinessDay(IN, '2026-11-21')).toBe(true) // third Saturday
    expect(isBusinessDay(IN, '2026-11-22')).toBe(false) // Sunday
    expect(isBusinessDay(IN, '2026-11-25')).toBe(true)
    expect(calendarWords(IN, '2026-11-25')).toMatch(/^Cited: RBI/)
    expect(calendarWords(IN, '2026-12-25')).toMatch(/^Synthetic/)
  })

  it('counts business days in the destination\'s own weekend: Saturday and Sunday in the US, Friday and Saturday in Bahrain', () => {
    expect(addBusinessDays(CALENDARS.US!, '2026-11-27', 1)).toBe('2026-11-30') // Friday + 1 = Monday
    expect(addBusinessDays(CALENDARS.BH!, '2026-11-25', 1)).toBe('2026-11-26') // Wednesday + 1 = Thursday
    expect(addBusinessDays(CALENDARS.BH!, '2026-11-26', 1)).toBe('2026-11-29') // Thursday + 1 = Sunday
    expect(addBusinessDays(CALENDARS.JP!, '2026-11-25', 2)).toBe('2026-11-27')
  })

  it('a payment is sent on the India business day it is approved, before the cut-off, else on the next one', () => {
    const ist = (s: string) => Date.parse(`${s}+05:30`)
    expect(sendDate(ist('2026-11-25T10:00:00'), '15:00')).toBe('2026-11-25')
    expect(sendDate(ist('2026-11-25T15:30:00'), '15:00')).toBe('2026-11-26')
    expect(sendDate(ist('2026-11-24T10:00:00'), '15:00')).toBe('2026-11-25') // a cited bank holiday in Mumbai
    expect(sendDate(ist('2026-11-27T16:00:00'), '15:00')).toBe('2026-11-30') // Friday late; Saturday 28 is the fourth
  })
})
