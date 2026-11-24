/**
 * The bank statement for a chosen period (R12 task comparison, gap 9; T5-a, T5-d). A period is a run of the ledger's own
 * order: it starts at the first bank entry entered at or after the period's first moment (00:00 IST) and ends before the
 * first entered at or after its end. So the balance at its start, plus money in, less money out, is the balance at its
 * end, exactly, in integer paise; every line carries the ledger's balance after it; one period's end is the next one's
 * start; and a period that has closed never changes, whatever is entered later.
 */
import { describe, expect, it } from 'vitest'
import { AppError } from './core.ts'
import { createAction } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { balance, post } from './ledger.ts'
import { periodFromQuery, spanFromQuery, statement } from './statement.ts'
import { makeKit } from './testkit.ts'
import { listActions } from './views.ts'
import { periodOf, type Period } from '../shared/period.ts'

const IST = 19_800_000
/** A moment given as India time, "2026-11-24 16:31", optionally with seconds and milliseconds. */
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}${s.length > 16 ? '' : ':00'}Z`) - IST
const OPENED = at('2026-10-20 10:00')
const NOW = at('2026-11-24 16:31') // a Tuesday

interface Line { seq: number; ts: number; effectiveTs: number; kind: string; amount: number | null; amount_text: string; balance: number | null; balance_text: string; recordedLate: boolean; memo: string }
interface View {
  balance: number | null; balance_text: string; period: Period; opened: number | null
  opening: number | null; opening_text: string; closing: number | null; closing_text: string
  moneyIn: number | null; moneyIn_text: string; moneyOut: number | null; moneyOut_text: string
  linesIn: number; linesOut: number; count: number; more: boolean; lines: Line[]; expected: unknown[]
}

/** A household opened on 20 Oct 2026 with the paper opening balance, and lines entered when each test says. */
function household() {
  const k = makeKit({ start: OPENED })
  const move = (ref: string, ts: number, paise: bigint, opts: { effectiveTs?: number; late?: boolean } = {}) =>
    post(k.db, { userId: k.userId, ts, effectiveTs: opts.effectiveTs, kind: paise > 0n ? 'income' : 'spend', ref, memo: ref, meta: opts.late ? { recordedLate: true } : {},
      lines: paise > 0n ? [{ account: 'bank', amount: paise }, { account: 'inc:salary', amount: -paise }] : [{ account: 'exp:spend', amount: -paise }, { account: 'bank', amount: paise }] })
  const view = (p: Period, limit = 1000): View => statement(k.db, k.userId, NOW, p, limit) as unknown as View
  return { k, move, view }
}

/** The lines' names, newest first; the household's own opening line is "opening". */
const names = (v: View): string[] => v.lines.map((l) => (l.kind === 'opening' ? 'opening' : l.memo))
/** What a statement says of its period, without the balance now that it also carries. */
const figures = (v: View) => ({ opening: v.opening_text, closing: v.closing_text, moneyIn: v.moneyIn_text, moneyOut: v.moneyOut_text, count: v.count, lines: v.lines })

/** The full figures a statement stands on: its start, its lines (oldest first) and its end must add up. */
function expectReconciles(v: View): void {
  const big = (t: string) => BigInt(t)
  expect(big(v.opening_text) + big(v.moneyIn_text) - big(v.moneyOut_text)).toBe(big(v.closing_text))
  const oldestFirst = [...v.lines].reverse()
  let running = big(v.opening_text)
  for (const l of oldestFirst) { running += big(l.amount_text); expect(big(l.balance_text), `line ${l.seq}`).toBe(running) }
  expect(running).toBe(big(v.closing_text))
  expect(v.count).toBe(v.lines.length)
  expect(v.linesIn + v.linesOut).toBe(v.count)
  expect(v.moneyIn_text).toBe(String(v.lines.filter((l) => big(l.amount_text) > 0n).reduce((s, l) => s + big(l.amount_text), 0n)))
  expect(v.moneyOut_text).toBe(String(v.lines.filter((l) => big(l.amount_text) < 0n).reduce((s, l) => s - big(l.amount_text), 0n)))
}

describe('the statement for a period adds up', () => {
  it('in every period: the start plus money in less money out is the end, and each line follows from the one before', () => {
    const { k, move, view } = household()
    move('rent', at('2026-10-25 09:00'), -100_000n)
    move('groceries', at('2026-10-31 23:59'), -200_050n)
    move('salary', at('2026-11-01 00:00'), 5_000_000n)
    move('power', at('2026-11-10 12:00'), -30_000n)
    move('tea', at('2026-11-23 00:00'), -1n)
    move('refund', at('2026-11-24 09:00'), 10_000n)
    const periods = [periodOf('all', NOW), periodOf('week', NOW), periodOf('month', NOW), periodOf('last-month', NOW), periodOf('dates', NOW, { first: '2026-10-25', last: '2026-11-10' })]
    for (const p of periods) expectReconciles(view(p))

    const all = view(periodOf('all', NOW))
    expect([all.opening, all.closing_text, all.count, all.opened]).toEqual([0, balance(k.db, k.userId, 'bank').toString(), 7, OPENED])
    expect(all.closing).toBe(DEFAULT_OPENING.bank - 100_000 - 200_050 + 5_000_000 - 30_000 - 1 + 10_000)
    // one period's end is the next one's start
    expect(view(periodOf('last-month', NOW)).closing_text).toBe(view(periodOf('month', NOW)).opening_text)
    expect(view(periodOf('dates', NOW, { first: '2026-10-01', last: '2026-11-22' })).closing_text).toBe(view(periodOf('week', NOW)).opening_text)
    // this week: the paisa at Monday 00:00 and the refund
    expect(names(view(periodOf('week', NOW)))).toEqual(['refund', 'tea'])
    // the period still running ends at the balance now
    expect(view(periodOf('month', NOW)).closing_text).toBe(all.balance_text)
  })

  it('a line entered exactly at midnight IST belongs to the period that starts then, and to no other', () => {
    const { move, view } = household()
    move('last minute', at('2026-10-31 23:59:59.999'), -1_000n)
    move('salary', at('2026-11-01 00:00:00.000'), 5_000_000n)
    const october = view(periodOf('last-month', NOW)), november = view(periodOf('month', NOW))
    expect(names(october)).toEqual(['last minute', 'opening'])
    expect(names(november)).toEqual(['salary'])
    expect(october.closing).toBe(DEFAULT_OPENING.bank - 1_000)
    expect([november.opening, november.closing]).toEqual([DEFAULT_OPENING.bank - 1_000, DEFAULT_OPENING.bank - 1_000 + 5_000_000])
    const lastDay = view(periodOf('dates', NOW, { first: '2026-10-31', last: '2026-10-31' }))
    expect(names(lastDay)).toEqual(['last minute'])
  })

  it('a period before the account was opened has nothing in it, from nothing, and says when the account was opened', () => {
    const { view } = household()
    const v = view(periodOf('dates', NOW, { first: '2026-09-01', last: '2026-10-19' }))
    expect([v.opening, v.moneyIn, v.moneyOut, v.closing, v.count, v.lines, v.opened]).toEqual([0, 0, 0, 0, 0, [], OPENED])
    expectReconciles(v)
    // the day it was opened starts from nothing and holds the opening line
    const day = view(periodOf('dates', NOW, { first: '2026-10-20', last: '2026-10-20' }))
    expect([day.opening, day.moneyIn, day.closing, names(day)]).toEqual([0, DEFAULT_OPENING.bank, DEFAULT_OPENING.bank, ['opening']])
  })

  it('an empty period after opening: the balance stood still, and the start and end say so', () => {
    const { move, view } = household()
    move('rent', at('2026-11-02 09:00'), -100_000n)
    move('power', at('2026-11-21 09:00'), -30_000n)
    const v = view(periodOf('dates', NOW, { first: '2026-11-05', last: '2026-11-20' }))
    expect([v.count, v.lines, v.moneyIn, v.moneyOut]).toEqual([0, [], 0, 0])
    expect([v.opening, v.closing]).toEqual([DEFAULT_OPENING.bank - 100_000, DEFAULT_OPENING.bank - 100_000])
    // a future period has nothing yet and ends at the balance now
    const future = view(periodOf('dates', NOW, { first: '2026-12-01', last: '2026-12-31' }))
    expect([future.count, future.opening, future.closing]).toEqual([0, DEFAULT_OPENING.bank - 130_000, DEFAULT_OPENING.bank - 130_000])
  })

  it('a line entered late is on the statement of the day it was entered, saying when it took effect; a closed period never changes', () => {
    const { move, view } = household()
    move('rent', at('2026-10-25 09:00'), -100_000n)
    const before = figures(view(periodOf('last-month', NOW)))
    // salary due 31 Oct 09:30, entered on 2 Nov because QED was not running: it does not rewrite October
    move('salary', at('2026-11-02 08:00'), 5_000_000n, { effectiveTs: at('2026-10-31 09:30'), late: true })
    const after = figures(view(periodOf('last-month', NOW)))
    expect(after).toEqual(before)
    const nov = view(periodOf('month', NOW))
    expect(nov.lines).toHaveLength(1)
    expect(nov.lines[0]).toMatchObject({ memo: 'salary', ts: at('2026-11-02 08:00'), effectiveTs: at('2026-10-31 09:30'), recordedLate: true })
    expect(nov.opening_text).toBe(after.closing)
    expectReconciles(nov)
  })

  it('sends the latest lines the screen asks for, and still states the figures of the whole period', () => {
    const { move, view } = household()
    for (let i = 1; i <= 5; i++) move(`pay ${i}`, at(`2026-11-0${i} 10:00`), -1_000n * BigInt(i))
    const whole = view(periodOf('month', NOW)), two = view(periodOf('month', NOW), 2)
    expect([two.count, two.lines.length, two.more, whole.more]).toEqual([5, 2, true, false])
    expect(names(two)).toEqual(['pay 5', 'pay 4'])
    for (const k of ['opening_text', 'closing_text', 'moneyIn_text', 'moneyOut_text', 'linesIn', 'linesOut'] as const) expect(two[k]).toEqual(whole[k])
    expect(two.lines.map((l) => l.balance_text)).toEqual(whole.lines.slice(0, 2).map((l) => l.balance_text))
  })

  it('is exact past 2^53: the number is null rather than rounded, and the text is the figure', () => {
    const { move, view } = household()
    const huge = (1n << 60n) + 3n
    move('windfall', at('2026-11-03 10:00'), huge)
    const v = view(periodOf('month', NOW))
    expect([v.moneyIn, v.moneyIn_text, v.closing, v.closing_text]).toEqual([null, huge.toString(), null, (BigInt(DEFAULT_OPENING.bank) + huge).toString()])
    expectReconciles(v)
  })

  it('says what is expected next only while the period runs', () => {
    const { view } = household()
    expect(view(periodOf('last-month', NOW)).expected).toEqual([])
    expect(view(periodOf('month', NOW)).expected.length).toBeGreaterThan(0) // the salary the profile expects
  })
})

describe('the period asked for', () => {
  const q = (s: string) => periodFromQuery(new URLSearchParams(s), NOW)
  it('reads the period kinds and chosen dates', () => {
    expect(q('period=week')).toEqual(periodOf('week', NOW))
    expect(q('period=last-month')).toEqual(periodOf('last-month', NOW))
    expect(q('period=all')).toEqual(periodOf('all', NOW))
    expect(q('period=dates&first=2026-11-02&last=2026-11-08')).toEqual(periodOf('dates', NOW, { first: '2026-11-02', last: '2026-11-08' }))
  })

  it('refuses a first day after the last, a date that is not one, and a period it does not know, each in words', () => {
    const refusal = (s: string): AppError => { try { q(s) } catch (e) { return e as AppError } throw new Error(`${s} was accepted`) }
    const late = refusal('period=dates&first=2026-11-10&last=2026-11-02')
    expect([late.status, late.code, late.message, late.fields]).toEqual([400, 'invalid', 'The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.', { last: 'The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.' }])
    expect(refusal('period=dates&first=2026-02-30&last=2026-03-01').fields).toEqual({ first: 'Give the first day as a date.' })
    expect(refusal('period=fortnight').message).toBe('Choose a period: since opening, this week, this month, last month, or dates.')
  })
})

describe("Activity's dates read what was done in those India days", () => {
  it('keeps the actions made from 00:00 IST of the first day to before 00:00 IST of the day after the last', () => {
    const k = makeKit({ start: OPENED })
    const pay = (id: string, ts: number) => { k.clock.set(ts); createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'payment', venue: 'paper-rail', economicId: id, params: { payeeHandle: 'meera.nair@upi', payeeName: 'Meera Nair', amount: '100000', purpose: 'manual' } as never, approvalId: k.approveOwner(`action:${id}`) }) }
    pay('before', at('2026-11-01 23:59:59.999')); pay('first', at('2026-11-02 00:00')); pay('last', at('2026-11-08 23:59')); pay('after', at('2026-11-09 00:00'))
    const span = periodOf('dates', NOW, { first: '2026-11-02', last: '2026-11-08' })
    expect(listActions(k.db, k.userId, { limit: 300, from: span.from, to: span.to }).map((a) => a.economicId)).toEqual(['last', 'first'])
    expect(listActions(k.db, k.userId, { limit: 300 }).map((a) => a.economicId)).toEqual(['after', 'last', 'first', 'before'])
  })
})

describe("Activity's dates, as the request gives them", () => {
  const span = (s: string) => spanFromQuery(new URLSearchParams(s))
  it('reads both days, or one of them with the other end open, or none', () => {
    expect(span('first=2026-11-02&last=2026-11-08')).toEqual({ from: at('2026-11-02 00:00'), to: at('2026-11-09 00:00') })
    expect(span('first=2026-11-02')).toEqual({ from: at('2026-11-02 00:00'), to: Number.MAX_SAFE_INTEGER })
    expect(span('last=2026-11-08')).toEqual({ from: 0, to: at('2026-11-09 00:00') })
    expect(span('limit=100')).toBeNull()
  })

  it('refuses a first day after the last, and a day that is not a date, in words', () => {
    const refusal = (s: string): AppError => { try { span(s) } catch (e) { return e as AppError } throw new Error(`${s} was accepted`) }
    expect([refusal('first=2026-11-10&last=2026-11-02').status, refusal('first=2026-11-10&last=2026-11-02').fields]).toEqual([400, { last: 'The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.' }])
    expect(refusal('first=yesterday').fields).toEqual({ first: 'Give the first day as a date.' })
    expect(refusal('last=2026-13-01').fields).toEqual({ last: 'Give the last day as a date.' })
  })
})

describe('entry times that run backwards (QA hand-back, R13)', () => {
  it('a line stamped earlier than one before it stays where it was entered: periods still meet, add up and are counted', () => {
    const { k, move, view } = household()
    move('rent', at('2026-11-05 09:00'), -100_000n)
    move('clock set back', at('2026-10-28 09:00'), -50_000n)   // entered after rent, stamped a week before it
    move('salary', at('2026-11-12 09:00'), 5_000_000n)
    const month = view(periodOf('month', NOW)), last = view(periodOf('last-month', NOW))
    for (const v of [month, last, view(periodOf('all', NOW))]) expectReconciles(v)
    expect(last.closing_text).toBe(month.opening_text)            // no gap and no overlap
    expect(names(month)).toEqual(['salary', 'clock set back', 'rent'])
    expect((month as unknown as { backdated: number }).backdated).toBe(1)
    expect((last as unknown as { backdated: number }).backdated).toBe(0)
    expect(month.count + last.count).toBe(view(periodOf('all', NOW)).count)
  })
})
