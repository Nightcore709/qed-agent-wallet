/**
 * The statement's stated basis (R13 section 4: "preserve both effective and entry timestamps where they differ. Label the
 * selected ordering clearly and keep running balances, filters and exports consistent with their stated basis. Never
 * rewrite economic history to make the display convenient. Preserve the corrected treatment of delayed loan payments:
 * record when money actually moved and the true reason for delay.")
 *
 * The statement's basis is the order in which lines were entered in the account (server/statement.ts): a period holds the
 * lines entered in it, each with the balance after it, and a line that took effect at another time says when. Checked
 * here as properties over random books (fast-check, fixed seeds): every period adds up and its lines follow one another
 * in that order; consecutive periods meet; a period that has closed never changes when later lines are entered, even
 * ones that took effect inside it; and every line carries both its entry time and its effective time. And the delayed
 * instalment: taken when the money arrived, dated then, with the day it was due and the true reason on its line (until
 * R13 the reason was in the ledger only, and the statement showed the instalment with no word of it).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bankTick } from './bank.ts'
import { istInstant } from './core.ts'
import { post, verifyLedger } from './ledger.ts'
import { statement } from './statement.ts'
import { makeKit } from './testkit.ts'
import { periodOf, type Period } from '../shared/period.ts'

interface Line { seq: number; ts: number; effectiveTs: number; memo: string; amount_text: string; balance_text: string; recordedLate: boolean; takenLate: boolean; scheduledAt: number | null; lateReason: string | null }
interface View { period: Period; opening_text: string; closing_text: string; moneyIn_text: string; moneyOut_text: string; count: number; lines: Line[] }
const IST = 19_800_000
const day = (ms: number): string => new Date(ms + IST).toISOString().slice(0, 10)

describe('the delayed instalment on the statement', () => {
  it('is on the day the money moved, dated then, with the day it was due and the true reason; the day it was due shows no instalment', () => {
    // ₹1,000 in the bank, a ₹10,000 instalment due on 5 Dec at 09:00 with the engine running: it cannot be taken
    const k = makeKit({ opening: { bank: 100_000, fd: 0, card: 0, personalLoan: 30_000_000, homeLoan: 0 }, profile: { line: 0, personalLoanEmi: 1_000_000, homeLoanEmi: 0, emiDay: 5, income: 0 } })
    const due = istInstant('2026-12-05', '09:00')
    k.clock.set(due + 60_000); bankTick(k.ctx)
    const taken = istInstant('2026-12-09', '12:00')
    k.clock.set(taken)
    post(k.db, { userId: k.userId, ts: taken, kind: 'paper-topup', ref: 'topup:1', memo: 'top-up', lines: [{ account: 'bank', amount: 5_000_000n }, { account: 'inc:other', amount: -5_000_000n }] })
    bankTick(k.ctx)
    const dec = statement(k.db, k.userId, taken, periodOf('dates', taken, { first: '2026-12-01', last: '2026-12-31' })) as unknown as View
    const emi = dec.lines.find((l) => l.memo.startsWith('Personal loan instalment'))!
    expect(emi).toMatchObject({ ts: taken, effectiveTs: taken, recordedLate: false, takenLate: true, scheduledAt: due, lateReason: 'Taken late: the money was not there on its day.' })
    // the day it was due: nothing was taken, and the statement of that day says so by having no instalment in it (its
    // one line is November's savings interest, entered that day because the engine first ran on it)
    const fifth = statement(k.db, k.userId, taken, periodOf('dates', taken, { first: '2026-12-05', last: '2026-12-05' })) as unknown as View
    expect(fifth.lines.map((l) => l.memo)).toEqual(['Savings interest for 2026-11 (paper)'])
    // a line recorded late because QED was not running says that reason instead, and keeps its effective time
    expect(dec.lines.filter((l) => l.memo !== emi.memo).every((l) => !l.takenLate && l.lateReason === null)).toBe(true)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('a line recorded late because QED was not running says when it took effect and that reason', () => {
    const k = makeKit({ start: istInstant('2026-10-20', '10:00') })
    const at = istInstant('2026-11-02', '08:00'), eff = istInstant('2026-10-31', '09:30')
    k.clock.set(at)
    post(k.db, { userId: k.userId, ts: at, effectiveTs: eff, kind: 'income-salary', ref: 'salary:2026-10', memo: 'Salary (paper)', meta: { paper: true, recordedLate: true, scheduledAt: eff, note: 'Recorded late: the engine was not running at the scheduled time.' }, lines: [{ account: 'bank', amount: 5_000_000n }, { account: 'inc:salary', amount: -5_000_000n }] })
    const v = statement(k.db, k.userId, at, periodOf('month', at)) as unknown as View
    expect(v.lines[0]).toMatchObject({ ts: at, effectiveTs: eff, recordedLate: true, takenLate: false, scheduledAt: eff, lateReason: 'Recorded late: the engine was not running at the scheduled time.' })
  })
})

describe('property: every period of a random book adds up on its stated basis, the order the lines were entered in', () => {
  // a book of up to 40 lines over about seven weeks: each entered after the one before, some taking effect earlier (a line
  // recorded late) or a little later (a rail's own time), money in and out
  const book = fc.array(fc.record({
    gapMin: fc.integer({ min: 0, max: 3 * 1440 }),
    paise: fc.integer({ min: -2_000_000, max: 2_000_000 }).filter((n) => n !== 0),
    shiftMin: fc.oneof(fc.constant(0), fc.integer({ min: -5 * 1440, max: 0 }), fc.integer({ min: 0, max: 2 })),
  }), { minLength: 1, maxLength: 40 })

  function household(lines: { gapMin: number; paise: number; shiftMin: number }[]) {
    const start = istInstant('2026-10-20', '10:00')
    const k = makeKit({ start, opening: { bank: 50_000_000, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 } })
    let t = start
    lines.forEach((l, i) => {
      t += l.gapMin * 60_000 + 1000
      const amount = BigInt(l.paise)
      post(k.db, { userId: k.userId, ts: t, effectiveTs: t + l.shiftMin * 60_000, kind: amount > 0n ? 'income' : 'spend', ref: `l${i}`, memo: `line ${i}`, meta: l.shiftMin < 0 ? { recordedLate: true } : {},
        lines: amount > 0n ? [{ account: 'bank', amount }, { account: 'inc:other', amount: -amount }] : [{ account: 'exp:spend', amount: -amount }, { account: 'bank', amount }] })
    })
    return { k, start, end: t }
  }
  const read = (k: ReturnType<typeof makeKit>, p: Period, now: number): View => statement(k.db, k.userId, now, p, 100_000) as unknown as View

  function addsUp(v: View): void {
    const big = (s: string) => BigInt(s)
    expect(big(v.opening_text) + big(v.moneyIn_text) - big(v.moneyOut_text)).toBe(big(v.closing_text))
    const oldest = [...v.lines].reverse()
    let run = big(v.opening_text)
    for (const [i, l] of oldest.entries()) {
      run += big(l.amount_text)
      expect(big(l.balance_text)).toBe(run)
      // the stated basis: lines in the order they were entered, and each entered inside the period
      if (i > 0) { expect(l.seq).toBeGreaterThan(oldest[i - 1]!.seq); expect(l.ts).toBeGreaterThanOrEqual(oldest[i - 1]!.ts) }
      if (v.period.from !== null) { expect(l.ts).toBeGreaterThanOrEqual(v.period.from); expect(l.ts).toBeLessThan(v.period.to!) }
      // both times are carried, whatever they are
      expect(typeof l.ts === 'number' && typeof l.effectiveTs === 'number').toBe(true)
    }
    expect(run).toBe(big(v.closing_text))
  }

  it('each period adds up line by line, consecutive periods meet, and the whole book is the sum of its days', () => {
    fc.assert(fc.property(book, fc.integer({ min: 0, max: 48 }), fc.integer({ min: 0, max: 20 }), (lines, a, len) => {
      const { k, start, end } = household(lines)
      const now = end + 60_000
      const d0 = day(start)
      const first = new Date(Date.parse(`${d0}T00:00:00Z`) + a * 86_400_000).toISOString().slice(0, 10)
      const mid = new Date(Date.parse(`${first}T00:00:00Z`) + len * 86_400_000).toISOString().slice(0, 10)
      const after = new Date(Date.parse(`${mid}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      const last = new Date(Date.parse(`${after}T00:00:00Z`) + 9 * 86_400_000).toISOString().slice(0, 10)
      const p1 = read(k, periodOf('dates', now, { first, last: mid }), now), p2 = read(k, periodOf('dates', now, { first: after, last }), now)
      addsUp(p1); addsUp(p2)
      expect(p2.opening_text).toBe(p1.closing_text) // consecutive periods meet
      for (const kind of ['all', 'week', 'month', 'last-month'] as const) addsUp(read(k, periodOf(kind, now), now))
      const all = read(k, periodOf('all', now), now)
      expect(all.count).toBe(lines.length + 1) // every line, and the opening
    }), { seed: 9, numRuns: 120 })
  })

  it('a period that has closed never changes, whatever is entered later, even a line that took effect inside it', () => {
    fc.assert(fc.property(book, fc.integer({ min: 1, max: 10 }), (lines, backDays) => {
      const { k, end } = household(lines)
      const now = end + 60_000
      const closed = periodOf('dates', now, { first: day(end - 20 * 86_400_000), last: day(end) })
      const before = read(k, closed, now)
      // the next day: a line that took effect inside the closed period is entered (recorded late)
      const later = istInstant(new Date(Date.parse(`${day(end)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), '08:00')
      k.clock.set(later)
      post(k.db, { userId: k.userId, ts: later, effectiveTs: later - backDays * 86_400_000, kind: 'income', ref: 'late', memo: 'late line', meta: { recordedLate: true }, lines: [{ account: 'bank', amount: 123_456n }, { account: 'inc:other', amount: -123_456n }] })
      const again = read(k, closed, later + 60_000)
      // its figures and its lines are as they were (the balance now and what is expected next are not the period's)
      const fixed = (v: View) => ({ opening: v.opening_text, closing: v.closing_text, moneyIn: v.moneyIn_text, moneyOut: v.moneyOut_text, count: v.count, lines: v.lines.map((l) => [l.seq, l.amount_text, l.balance_text]) })
      expect(fixed(again)).toEqual(fixed(before))
      // and it is on the statement of the day it was entered, saying when it took effect
      const today = read(k, periodOf('dates', later, { first: day(later), last: day(later) }), later + 60_000)
      expect(today.lines[0]).toMatchObject({ memo: 'late line', ts: later, effectiveTs: later - backDays * 86_400_000, recordedLate: true })
    }), { seed: 24, numRuns: 80 })
  })
})
