/**
 * The interface's date labels follow the household's zone (R13 second pass, item 4). Until a zone is set they are India's, as
 * they always were; Passbook and Activity (day headings, times, the files they write) read the same one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fmt, getDisplayZone, setDisplayZone, zoneDay, zoneHead, zoneIso, zoneName, zoneWeekday } from './core.ts'
import { dayBookCsv } from '../screens/Activity.tsx'
import { statementCsv } from '../screens/Passbook.tsx'

const SUMMER = Date.parse('2026-07-01T23:30:00Z') // 00:30 on 2 July in London (BST), 05:00 on 2 July in India
const WINTER = Date.parse('2026-12-01T23:30:00Z')
afterEach(() => setDisplayZone(null))

describe('the display zone', () => {
  it('is India until one is set, and then every label says so in IST as before', () => {
    expect(getDisplayZone()).toBe('Asia/Kolkata')
    expect(fmt.full(SUMMER)).toBe('2 Jul 2026, 05:00:00 IST')
    expect(fmt.dayTime(SUMMER)).toBe('2 Jul, 05:00')
    expect(zoneDay(SUMMER)).toBe('2026-07-02')
    expect(zoneName()).toBe('India Standard Time')
    expect(zoneHead()).toBe('IST')
    expect(zoneIso(SUMMER)).toBe('2026-07-02T05:00:00.000+05:30')
  })
  it('follows the household\'s zone through daylight saving: London in summer and winter', () => {
    setDisplayZone('Europe/London')
    expect(fmt.full(SUMMER)).toBe('2 Jul 2026, 00:30:00 BST')
    expect(fmt.full(WINTER)).toBe('1 Dec 2026, 23:30:00 GMT')
    expect(fmt.time(SUMMER)).toBe('00:30')
    expect(zoneDay(SUMMER)).toBe('2026-07-02')
    expect(zoneDay(WINTER)).toBe('2026-12-01')
    expect(zoneWeekday(SUMMER)).toBe(4) // Thursday
    expect(zoneIso(SUMMER)).toBe('2026-07-02T00:30:00.000+01:00')
    expect(zoneIso(WINTER)).toBe('2026-12-01T23:30:00.000+00:00')
    expect(zoneName()).toBe('Europe/London')
    expect(fmt.precise(SUMMER)).toBe('2 Jul 2026, 00:30:00.000 BST')
  })
  it('ignores a name it does not know, rather than showing wrong times', () => {
    setDisplayZone('Mars/Olympus')
    expect(getDisplayZone()).toBe('Asia/Kolkata')
  })
})

describe('the files Passbook and Activity write', () => {
  const line = { ts: SUMMER, effectiveTs: SUMMER, memo: 'Salary', actor: 'qed', amount: 100, amount_text: '100', balance: 100, balance_text: '100', programTitle: null, actionId: null, takenLate: false, recordedLate: false, scheduledAt: null }
  const v = { opening_text: '0', moneyIn_text: '100', moneyOut_text: '0', closing_text: '100', lines: [line] } as unknown as Parameters<typeof statementCsv>[0]
  it('state their zone, and write each time in it', () => {
    const india = statementCsv(v, '1 to 2 Jul 2026', 'now')
    expect(india).toContain('(India Standard Time)')
    expect(india).toContain('Entered (IST)')
    expect(india).toContain('2026-07-02T05:00:00.000+05:30')
    setDisplayZone('Europe/London')
    const london = statementCsv(v, '1 to 2 Jul 2026', 'now')
    expect(london).toContain('(Europe/London)')
    expect(london).toContain('Entered (Europe/London)')
    expect(london).toContain('2026-07-02T00:30:00.000+01:00')
    expect(london).not.toContain('IST')
  })
  it('the day book names its zone too', () => {
    setDisplayZone('Europe/London')
    expect(dayBookCsv([], { period: 'July 2026', rows: 'all', readAt: 'now' } as never)).toContain('(Europe/London)')
    expect(dayBookCsv([], { period: 'July 2026', rows: 'all', readAt: 'now' } as never)).toContain('Asked for, due or raised (Europe/London)')
  })
})
