/**
 * Instruction schedules in the household's own zone (stage S4 and S6 of the global money model; R13 second pass).
 * A schedule that states no zone means India Standard Time, as every signed document before format 2 said ("at 09:00 IST").
 * A new instruction states its zone in the document the passkey signs (format 2), beside the zone rules' version.
 */
import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { buildDraft } from './programs.ts'
import { describeSchedule, firstDue, nextDue } from './schedule.ts'
import { makeKit, T0 } from './testkit.ts'
import { zonedInstant } from '../shared/zone.ts'

const LONDON = 'Europe/London'

describe('a schedule with a zone', () => {
  it('fires at the local time on both sides of the clocks going back (London, 25 Oct 2026)', () => {
    const s = { type: 'daily' as const, at: '09:00', zone: LONDON }
    const sat = Date.parse('2026-10-24T12:00:00Z')
    expect(nextDue(s, sat)).toBe(Date.parse('2026-10-25T09:00:00Z')) // GMT again: 09:00 is 09:00 UTC
    expect(nextDue(s, Date.parse('2026-10-23T12:00:00Z'))).toBe(Date.parse('2026-10-24T08:00:00Z')) // BST: 09:00 is 08:00 UTC
  })
  it('weekly and monthly follow the zone\'s own calendar day', () => {
    // 23:30 UTC on Sunday 1 Nov is already Monday 2 Nov in Tokyo
    expect(nextDue({ type: 'weekly', weekday: 1, at: '10:00', zone: 'Asia/Tokyo' }, Date.parse('2026-11-01T23:30:00Z'))).toBe(zonedInstant('2026-11-02', '10:00', 'Asia/Tokyo'))
    expect(nextDue({ type: 'monthly', day: 5, at: '10:00', zone: LONDON }, Date.parse('2026-11-05T10:00:00Z'))).toBe(zonedInstant('2026-12-05', '10:00', LONDON))
    expect(firstDue({ type: 'monthly', day: 5, at: '10:00', zone: LONDON }, Date.parse('2026-04-01T00:00:00Z'))).toBe(zonedInstant('2026-04-05', '10:00', LONDON))
  })
  it('keeps the old meaning when no zone is stated: India', () => {
    const wed = istInstant('2026-11-18', '10:30')
    expect(nextDue({ type: 'daily', at: '10:00' }, wed)).toBe(istInstant('2026-11-19', '10:00'))
    expect(nextDue({ type: 'daily', at: '10:00', zone: 'Asia/Kolkata' }, wed)).toBe(istInstant('2026-11-19', '10:00'))
    expect(describeSchedule({ type: 'daily', at: '09:00' })).toBe('every day at 09:00 IST')
    expect(describeSchedule({ type: 'weekly', weekday: 1, at: '09:00', zone: 'Asia/Kolkata' })).toBe('every Monday at 09:00 IST')
  })
  it('says its zone in words, never "IST" for another zone', () => {
    expect(describeSchedule({ type: 'daily', at: '09:00', zone: LONDON })).toBe('every day at 09:00 Europe/London time')
    expect(describeSchedule({ type: 'monthly', day: 3, at: '09:00', zone: 'America/New_York' })).toBe('on day 3 of each month at 09:00 America/New_York time')
    expect(describeSchedule({ type: 'once', at: Date.parse('2026-11-25T09:00:00Z'), zone: LONDON })).toBe('once, at 25 Nov 2026, 09:00 GMT')
  })
})

describe('the signed document of a new instruction', () => {
  const invest = (k: ReturnType<typeof makeKit>) => buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }, { maxPerRun: 100_000, maxPerMonth: 1_000_000, expiresAt: T0 + 30 * 86_400_000 }, T0)
  it('is format 2: it states the zone and the zone rules\' version, and its schedule carries the zone', () => {
    const k = makeKit()
    k.db.run(`UPDATE users SET profile_json = json_set(profile_json, '$.timeZone', ?) WHERE id = ?`, LONDON, k.userId)
    const d = invest(k)
    const doc = JSON.parse(d.document)
    expect(doc).toMatchObject({ v: 2, timeZone: LONDON })
    expect(typeof doc.tzVersion).toBe('string')
    expect(doc.params.schedule).toEqual({ type: 'monthly', day: 5, at: '10:00', zone: LONDON })
    expect(doc.may.join(' ')).toContain('10:00 Europe/London time')
    expect(doc.may.join(' ')).not.toContain('IST')
    expect(d.schedule).toMatchObject({ zone: LONDON })
  })
  it('for an Indian household states Asia/Kolkata and keeps writing IST', () => {
    const k = makeKit()
    const d = invest(k)
    const doc = JSON.parse(d.document)
    expect(doc).toMatchObject({ v: 2, timeZone: 'Asia/Kolkata' })
    expect(doc.may.join(' ')).toContain('10:00 IST')
  })
})
