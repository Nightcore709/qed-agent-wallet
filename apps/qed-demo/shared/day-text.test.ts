import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dayOf, dayText, istDay } from './day-text.ts'

describe('a published day in household words (R12 task comparison, T4-a: "the NAV for 2026-11-25")', () => {
  it('writes the weekday, the day and the month, as the rest of the app does ("Wed 25 Nov")', () => {
    expect(dayText('2026-11-25')).toBe('Wed 25 Nov')
    expect(dayText('2026-11-23')).toBe('Mon 23 Nov')
    expect(dayText('2026-12-01')).toBe('Tue 1 Dec')
  })
  it('adds the year only when it is not the year of the day it is read on', () => {
    expect(dayText('2026-11-25', '2026-11-24')).toBe('Wed 25 Nov')
    expect(dayText('2027-01-01', '2026-12-31')).toBe('Fri 1 Jan 2027')
    expect(dayText('2025-11-25', '2026-11-24')).toBe('Tue 25 Nov 2025')
  })
  it('leaves what is not a calendar day as it is, rather than naming a day that does not exist', () => {
    expect(dayText('2026-02-30')).toBe('2026-02-30')
    expect(dayText('not a day')).toBe('not a day')
  })
  it('names the India-time day of an instant: 23:59 IST and 00:01 IST the next day are different days', () => {
    expect(istDay(Date.parse('2026-11-24T18:29:00Z'))).toBe('2026-11-24') // 23:59 IST
    expect(istDay(Date.parse('2026-11-24T18:31:00Z'))).toBe('2026-11-25') // 00:01 IST
    expect(dayOf(Date.parse('2026-11-24T18:31:00Z'), Date.parse('2026-11-24T10:00:00Z'))).toBe('Wed 25 Nov')
  })
  it('agrees with the calendar for every day from 2000 to 2100', () => {
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    fc.assert(fc.property(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 11, 31) }), (t) => {
      const d = new Date(t)
      const iso = d.toISOString().slice(0, 10)
      const [weekday, day, , year] = dayText(iso, '1999-01-01').split(' ')
      expect(weekday).toBe(WEEKDAYS[d.getUTCDay()])
      expect(Number(day)).toBe(d.getUTCDate())
      expect(Number(year)).toBe(d.getUTCFullYear())
    }))
  })
})
