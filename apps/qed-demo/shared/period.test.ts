/**
 * Periods for the Statement and Activity (R12 task comparison, gap 9): days and weeks in India Standard Time (UTC+05:30,
 * no daylight saving), a week from Monday, a month from its 1st. A period is a half-open span of instants
 * [00:00 IST of its first day, 00:00 IST of the day after its last day), so a moment exactly at midnight belongs to the
 * day that starts then and to no other.
 */
import { describe, expect, it } from 'vitest'
import { checkDates, dayStartIst, istDate, nextDay, periodFileName, periodOf, periodWords } from './period.ts'

const IST = 19_800_000
/** A moment given as India time, "2026-11-24 16:31". */
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const NOW = at('2026-11-24 16:31') // a Tuesday

describe('India days', () => {
  it('names the India day of an instant; midnight belongs to the day it starts', () => {
    expect(istDate(at('2026-11-24 00:00'))).toBe('2026-11-24')
    expect(istDate(at('2026-11-24 00:00') - 1)).toBe('2026-11-23')
    expect(istDate(at('2026-11-24 23:59'))).toBe('2026-11-24')
    expect(dayStartIst('2026-11-24')).toBe(at('2026-11-24 00:00'))
    expect(nextDay('2026-11-30')).toBe('2026-12-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })
})

describe('the periods a person chooses', () => {
  it('this week runs from Monday 00:00 IST to the next Monday, whichever day it is now', () => {
    const p = periodOf('week', NOW)
    expect([p.first, p.last, p.from, p.to]).toEqual(['2026-11-23', '2026-11-29', at('2026-11-23 00:00'), at('2026-11-30 00:00')])
    expect(periodOf('week', at('2026-11-29 23:59')).first).toBe('2026-11-23') // Sunday night is still the same week
    expect(periodOf('week', at('2026-11-30 00:00')).first).toBe('2026-11-30') // Monday at midnight starts the next
  })

  it('this month and last month run from the 1st; last month in January is December of the year before', () => {
    expect(periodOf('month', NOW)).toMatchObject({ first: '2026-11-01', last: '2026-11-30', from: at('2026-11-01 00:00'), to: at('2026-12-01 00:00') })
    expect(periodOf('last-month', NOW)).toMatchObject({ first: '2026-10-01', last: '2026-10-31', from: at('2026-10-01 00:00'), to: at('2026-11-01 00:00') })
    expect(periodOf('last-month', at('2027-01-01 00:00'))).toMatchObject({ first: '2026-12-01', last: '2026-12-31' })
    expect(periodOf('month', at('2028-02-10 09:00'))).toMatchObject({ first: '2028-02-01', last: '2028-02-29' })
  })

  it('chosen dates run from the first day 00:00 to the day after the last; one day is one day', () => {
    expect(periodOf('dates', NOW, { first: '2026-11-02', last: '2026-11-08' })).toMatchObject({ from: at('2026-11-02 00:00'), to: at('2026-11-09 00:00') })
    const one = periodOf('dates', NOW, { first: '2026-11-24', last: '2026-11-24' })
    expect(one.to - one.from).toBe(86_400_000)
  })

  it('since opening has no start and runs to now', () => {
    expect(periodOf('all', NOW)).toMatchObject({ kind: 'all', first: null, from: null, last: '2026-11-24', to: null })
  })
})

describe('dates a person types', () => {
  it('refuses a first day after the last, and a date that does not exist, in words', () => {
    expect(checkDates('2026-11-10', '2026-11-02')).toEqual({ last: 'The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.' })
    expect(checkDates('2026-02-30', '2026-03-02')).toEqual({ first: 'Give the first day as a date.' })
    expect(checkDates('', '2026-03-02')).toEqual({ first: 'Give the first day as a date.' })
    expect(checkDates('2026-03-01', 'soon')).toEqual({ last: 'Give the last day as a date.' })
    expect(checkDates('2026-11-02', '2026-11-02')).toBeNull()
  })

  it('refuses chosen dates that are wrong rather than guessing', () => {
    expect(() => periodOf('dates', NOW, { first: '2026-11-10', last: '2026-11-02' })).toThrow('The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.')
    expect(() => periodOf('dates', NOW)).toThrow('Give the first day as a date.')
  })
})

describe('the period in words and in a file name', () => {
  it('says each period as a person would, and says "to now" while it is still running', () => {
    expect(periodWords(periodOf('week', NOW), NOW)).toBe('This week: Monday 23 November 2026 to now')
    expect(periodWords(periodOf('month', NOW), NOW)).toBe('This month: 1 November 2026 to now')
    expect(periodWords(periodOf('last-month', NOW), NOW)).toBe('Last month: 1 October 2026 to 31 October 2026')
    expect(periodWords(periodOf('dates', NOW, { first: '2026-10-05', last: '2026-10-05' }), NOW)).toBe('5 October 2026')
    expect(periodWords(periodOf('dates', NOW, { first: '2026-10-05', last: '2026-12-31' }), NOW)).toBe('5 October 2026 to now')
    expect(periodWords(periodOf('all', NOW), NOW, '2026-11-18')).toBe('Since the account was opened, 18 November 2026, to now')
  })

  it('names a file by the days it covers, ending today while the period runs', () => {
    expect(periodFileName('qed-bank-statement', periodOf('last-month', NOW), NOW)).toBe('qed-bank-statement-2026-10-01-to-2026-10-31.csv')
    expect(periodFileName('qed-bank-statement', periodOf('week', NOW), NOW)).toBe('qed-bank-statement-2026-11-23-to-2026-11-24.csv')
    expect(periodFileName('qed-day-book', periodOf('all', NOW), NOW, '2026-11-18')).toBe('qed-day-book-2026-11-18-to-2026-11-24.csv')
    expect(periodFileName('qed-day-book', periodOf('dates', NOW, { first: '2026-11-20', last: '2026-11-20' }), NOW)).toBe('qed-day-book-2026-11-20.csv')
  })
})
