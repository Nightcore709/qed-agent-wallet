/**
 * The Statement's file for a chosen period (R12 task comparison, gap 9, T5-d): it says which days it covers and when it
 * was read, then the balance at the start, money in and out and the balance at the end, then every line oldest first
 * with the balance after it. Every figure is written from the server's exact text, never through a float, so the file
 * adds up to the paisa however large the sums.
 */
import { describe, expect, it } from 'vitest'
import type { PassbookLine } from '../lib/types.ts'
import { choiceFrom, choiceQuery, STATEMENT_ORDER, statementCsv, tookEffect } from './Passbook.tsx'

const IST = 19_800_000
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const line = (p: Partial<PassbookLine>): PassbookLine => ({ seq: 2, ts: at('2026-10-25 09:00'), effectiveTs: at('2026-10-25 09:00'), kind: 'spend', memo: 'Rent', amount: -100_000, amount_text: '-100000', balance: 79_900_000, balance_text: '79900000', actor: 'you', actionId: null, receiptId: null, programId: null, programTitle: null, recordedLate: false, takenLate: false, scheduledAt: null, lateReason: null, ...p })
/** A CSV line split into its cells (quoted cells may hold commas and doubled quotes). */
const cells = (l: string): string[] => [...l.matchAll(/("((?:[^"]|"")*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]!))

describe('the Statement file for a period', () => {
  const view = {
    opening_text: '80000000', moneyIn_text: '5000000', moneyOut_text: '100000', closing_text: '84900000', linesIn: 1, linesOut: 1,
    // newest first, as the server sends them
    lines: [
      line({ seq: 3, ts: at('2026-11-02 08:00'), effectiveTs: at('2026-10-31 09:30'), kind: 'income-salary', memo: 'Salary (paper)', amount: 5_000_000, amount_text: '5000000', balance: 84_900_000, balance_text: '84900000', actor: 'employer', recordedLate: true, scheduledAt: at('2026-10-31 09:30'), lateReason: 'Recorded late: the engine was not running at the scheduled time.' }),
      line({}),
    ],
  }

  it('opens with the period, the four figures, when it was read and the order of its lines, then the lines oldest first', () => {
    const csv = statementCsv(view, 'Last month: 1 October 2026 to 31 October 2026', '24 Nov 2026, 16:31 IST')
    const rows = csv.trimEnd().split('\r\n').map(cells)
    expect(rows.slice(0, 8)).toEqual([
      ['Bank statement', 'Last month: 1 October 2026 to 31 October 2026 (India Standard Time)'],
      ['Balance at the start (INR)', '800000.00'], ['Money in (INR)', '50000.00'], ['Money out (INR)', '1000.00'], ['Balance at the end (INR)', '849000.00'],
      ['Read at', '24 Nov 2026, 16:31 IST'],
      // the order is stated in the file, not left to be guessed from its first column (R13)
      ['Order', STATEMENT_ORDER], [], // a blank line before the table
    ])
    expect(STATEMENT_ORDER).toMatch(/^Oldest first, in the order each line was entered in your bank account/)
    expect(rows[8]).toEqual(['Entered (IST)', 'What', 'By', 'Under instruction', 'Money in (INR)', 'Money out (INR)', 'Balance after (INR)', 'Record', 'Why late', 'Took effect (IST)'])
    expect(rows.slice(9)).toEqual([
      ['2026-10-25T09:00:00.000+05:30', 'Rent', 'You', '', '', '1000.00', '799000.00', '', '', '2026-10-25T09:00:00.000+05:30'],
      ['2026-11-02T08:00:00.000+05:30', 'Salary (paper)', 'Your employer', '', '50000.00', '', '849000.00', '', 'Recorded late: QED was not running when it took effect.', '2026-10-31T09:30:00.000+05:30'],
    ])
  })

  it('a line taken late carries when it was due and the true reason, on screen and in the file (R13: the delayed instalment)', () => {
    const emi = line({ seq: 4, ts: at('2026-12-09 12:00'), effectiveTs: at('2026-12-09 12:00'), kind: 'loan-instalment', memo: 'Personal loan instalment (paper)', amount: -1_000_000, amount_text: '-1000000', balance: 4_100_000, balance_text: '4100000', actor: 'bank', takenLate: true, scheduledAt: at('2026-12-05 09:00'), lateReason: 'Taken late: the money was not there on its day.' })
    // entered and in effect at the same moment, so only the reason and the day it was due are said
    expect(tookEffect(emi)).toBe('Taken late: it was due 5 Dec, 09:00, and the money was not there on its day.')
    const rows = statementCsv({ ...view, opening_text: '5100000', moneyIn_text: '0', moneyOut_text: '1000000', closing_text: '4100000', lines: [emi] }, 'x', 'y').trimEnd().split('\r\n').map(cells)
    expect(rows[9]).toEqual(['2026-12-09T12:00:00.000+05:30', 'Personal loan instalment (paper)', 'Your bank', '', '', '10000.00', '41000.00', '', 'Taken late: it was due 2026-12-05T09:00:00.000+05:30, and the money was not there on its day.', '2026-12-09T12:00:00.000+05:30'])
  })

  it('adds up: the start plus every line is the end, and each balance follows from the one before', () => {
    const rows = statementCsv(view, 'x', 'y').trimEnd().split('\r\n').map(cells)
    const paise = (t: string): bigint => (t ? BigInt(t.replace('.', '')) : 0n)
    let running = paise(rows[1]![1]!)
    for (const r of rows.slice(9)) { running += paise(r[4]!) - paise(r[5]!); expect(paise(r[6]!)).toBe(running) }
    expect(running).toBe(paise(rows[4]![1]!))
  })

  it('writes sums past 2^53 exactly, and a name that looks like a formula as text', () => {
    const huge = ((1n << 60n) + 3n).toString()
    const csv = statementCsv({ ...view, opening_text: '0', moneyIn_text: huge, moneyOut_text: '0', closing_text: huge, lines: [line({ memo: '=HYPERLINK("x")', amount: null as unknown as number, amount_text: huge, balance: null as unknown as number, balance_text: huge })] }, 'x', 'y')
    expect(csv).toContain('Money in (INR),11529215046068469.79')
    expect(csv).toContain(`"'=HYPERLINK(""x"")",You,,11529215046068469.79,,11529215046068469.79`)
  })

  it('says when a line took effect only when that differs from when it was entered', () => {
    expect(tookEffect(line({}))).toBeNull()
    expect(tookEffect(line({ effectiveTs: at('2026-10-25 09:00') - 30_000 }))).toBeNull() // seconds apart: the rail's own time
    expect(tookEffect(line({ ts: at('2026-11-02 08:00'), effectiveTs: at('2026-10-31 09:30'), recordedLate: true }))).toBe('Recorded late: it took effect 31 Oct, 09:30, when QED was not running.')
    expect(tookEffect(line({ ts: at('2026-11-02 08:00'), effectiveTs: at('2026-11-01 00:10') }))).toBe('It took effect 1 Nov, 00:10.')
  })
})

describe('the period in the address, so a link, a reload and Back keep it', () => {
  const read = (s: string) => choiceFrom(new URLSearchParams(s))
  it('reads each period, and chosen dates only when they make one', () => {
    expect([read(''), read('period=week'), read('period=month'), read('period=last-month')]).toEqual([{ kind: 'all' }, { kind: 'week' }, { kind: 'month' }, { kind: 'last-month' }])
    expect(read('period=dates&first=2026-10-01&last=2026-10-31')).toEqual({ kind: 'dates', first: '2026-10-01', last: '2026-10-31' })
    expect([read('period=dates&first=2026-10-31&last=2026-10-01'), read('period=dates&first=2026-10-01'), read('period=fortnight')]).toEqual([{ kind: 'all' }, { kind: 'all' }, { kind: 'all' }])
  })

  it('writes what it reads, and nothing for since opening', () => {
    for (const s of ['period=week', 'period=last-month', 'period=dates&first=2026-10-01&last=2026-10-31']) expect(choiceQuery(read(s))).toBe(s)
    expect(choiceQuery({ kind: 'all' })).toBe('')
  })
})
