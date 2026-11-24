/**
 * A household's own time zone (R13 section 5; stage S6): its paper bank's schedule (salary, instalments, interest) and its
 * statement periods are computed in its zone, including across daylight saving; a household with no zone chosen reads
 * India Standard Time, and gets exactly what it got before.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bankTick } from './bank.ts'
import { istInstant } from './core.ts'
import { post } from './ledger.ts'
import { periodFromQuery, spanFromQuery, statement } from './statement.ts'
import { makeKit } from './testkit.ts'
import { type PeriodKind, periodOf } from '../shared/period.ts'

const salaryAt = (k: ReturnType<typeof makeKit>, month: string) => k.db.get<{ effective_ts: number }>(`SELECT effective_ts FROM entries WHERE user_id = ? AND ref = ?`, k.userId, `salary:${month}`)?.effective_ts

describe('the paper bank\'s schedule in the household\'s zone', () => {
  it('pays a London household\'s salary at 09:30 London time, in summer time and in winter', () => {
    const k = makeKit({ start: Date.parse('2026-06-20T00:00:00Z'), profile: { timeZone: 'Europe/London', incomeDay: 1 } })
    k.clock.set(Date.parse('2026-07-01T08:29:00Z')); bankTick(k.ctx)
    expect(salaryAt(k, '2026-07')).toBeUndefined()
    k.clock.set(Date.parse('2026-07-01T08:31:00Z')); bankTick(k.ctx)
    expect(new Date(salaryAt(k, '2026-07')!).toISOString()).toBe('2026-07-01T08:30:00.000Z') // 09:30 BST
    k.clock.set(Date.parse('2026-12-01T09:29:00Z')); bankTick(k.ctx)
    expect(salaryAt(k, '2026-12')).toBeUndefined()
    k.clock.set(Date.parse('2026-12-01T09:31:00Z')); bankTick(k.ctx)
    expect(new Date(salaryAt(k, '2026-12')!).toISOString()).toBe('2026-12-01T09:30:00.000Z') // 09:30 GMT
  })

  it('pays a household with no zone chosen at 09:30 India time, as before', () => {
    const k = makeKit({ start: Date.parse('2026-06-20T00:00:00Z'), profile: { incomeDay: 1 } })
    k.clock.set(Date.parse('2026-07-01T06:00:00Z')); bankTick(k.ctx)
    expect(salaryAt(k, '2026-07')).toBe(istInstant('2026-07-01', '09:30'))
  })
})

describe('statement periods in the household\'s zone', () => {
  it('a payment at 23:30 on 30 November in London is on London\'s November statement, and on India\'s December one', () => {
    const now = Date.parse('2026-12-10T12:00:00Z')
    for (const [zone, inNovember] of [['Europe/London', true], ['Asia/Kolkata', false]] as const) {
      const k = makeKit({ start: Date.parse('2026-11-02T12:00:00Z'), profile: { timeZone: zone } })
      post(k.db, { userId: k.userId, ts: Date.parse('2026-11-30T23:30:00Z'), kind: 'payment', ref: 'late-night', memo: 'Paid late at night (paper)', lines: [{ account: 'bank', amount: -12_300n }, { account: 'exp:spend', amount: 12_300n }] })
      const last = statement(k.db, k.userId, now, periodFromQuery(new URLSearchParams('period=last-month'), now, zone), 100) as { lines: { memo?: string }[]; period: { from: number } }
      expect(last.period.from).toBe(zone === 'Europe/London' ? Date.parse('2026-11-01T00:00:00Z') : Date.parse('2026-10-31T18:30:00Z'))
      expect(last.lines.some((l) => JSON.stringify(l).includes('Paid late at night')), zone).toBe(inNovember)
      expect(spanFromQuery(new URLSearchParams('first=2026-12-01&last=2026-12-01'), zone)!.from).toBe(zone === 'Europe/London' ? Date.parse('2026-12-01T00:00:00Z') : Date.parse('2026-11-30T18:30:00Z'))
    }
  })

  it('India\'s periods computed through the zone rules equal the fixed-offset ones a household with no zone gets', () => {
    // 'Asia/Calcutta' is the same zone by its older name: it takes the general path through Intl, not the IST shortcut
    fc.assert(fc.property(fc.integer({ min: Date.parse('2020-01-01T00:00:00Z'), max: Date.parse('2035-01-01T00:00:00Z') }), fc.constantFrom<PeriodKind>('week', 'month', 'last-month', 'all'), (now, kind) => {
      expect(periodOf(kind, now, undefined, 'Asia/Calcutta')).toEqual(periodOf(kind, now))
    }), { numRuns: 300 })
  })
})
