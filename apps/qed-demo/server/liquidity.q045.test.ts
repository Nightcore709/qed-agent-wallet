/**
 * Q-045: what must stay in the bank, and whether it rises overnight when nothing has happened.
 * Research note: experiments/r7/S1-science/Q045-rolling-reserve.md. Proposed patch: experiments/r7/S1-science/patch/
 * liquidity-q045.diff. To be placed at apps/qed-demo/server/liquidity.q045.test.ts.
 *
 * Before the patch the first three tests fail (M1 and M3: the wallet rebuilds its salary list from the current month
 * each day). After it they pass. The fourth walks a year day by day and fails before the patch on 1 December 2026.
 * The fifth pins M2, which is the correct worst case of the flows listed and is not changed by the patch.
 */
import { describe, expect, it } from 'vitest'
import { addDays, istInstant } from './core.ts'
import { balance, post } from './ledger.ts'
import { liquidity } from './liquidity.ts'
import { term } from './registry.ts'
import { makeKit, type Kit } from './testkit.ts'
import { mulDiv, parseDec, pow10 } from '../shared/fixed.ts'

const at = (date: string): number => istInstant(date, '00:01')
const p2 = (n: number): string => String(n).padStart(2, '0')

/** A household with a salary on the 28th allowed 4 days late, a home-loan instalment of Rs 20,000 on the 5th, nothing else. */
const lateSalaryHousehold = (): Kit => makeKit({
  opening: { bank: 0, fd: 0, card: 0, personalLoan: 0, homeLoan: 200_000_000 },
  profile: { income: 2_000_000, incomeDay: 28, spending: 0, personalLoanEmi: 0, homeLoanEmi: 2_000_000, emiDay: 5, lateDays: 4, lostSalaries: 0, line: 0 },
})

function postSalary(k: Kit, ym: string, ts: number, amount: number): void {
  post(k.db, { userId: k.userId, ts, effectiveTs: ts, kind: 'income-salary', ref: `salary:${ym}`, memo: 'Salary (test)', meta: { paper: true }, lines: [{ account: 'bank', amount: BigInt(amount) }, { account: 'inc:salary', amount: -BigInt(amount) }] })
}
/** The home-loan instalment exactly as bank.ts takes it, funded first so that the bank can pay it. */
function takeInstalment(k: Kit, ym: string, ts: number, emi: number): void {
  const owed = balance(k.db, k.userId, 'loan:home')
  const interest = mulDiv(owed, parseDec(String(term(k.db, 'rate.loan.home')?.value.apr ?? '0.0875'), 12), pow10(12) * 12n, 'half')
  const principal = BigInt(emi) - interest
  post(k.db, { userId: k.userId, ts, effectiveTs: ts, kind: 'money-in', ref: `fund:${ym}`, memo: 'Funding (test)', meta: { paper: true }, lines: [{ account: 'bank', amount: BigInt(emi) }, { account: 'inc:other', amount: -BigInt(emi) }] })
  post(k.db, { userId: k.userId, ts, effectiveTs: ts, kind: 'loan-instalment', ref: `emi:loan:home:${ym}`, memo: 'Instalment (test)', meta: { paper: true }, lines: [{ account: 'loan:home', amount: principal }, { account: 'exp:interest', amount: interest }, { account: 'bank', amount: -BigInt(emi) }] })
}

describe('what must stay does not rise overnight when nothing has happened (Q-045)', () => {
  it('M1: a salary still inside its allowed lateness stays counted when the month turns', () => {
    const k = lateSalaryHousehold()
    // November's salary (due the 28th) has not arrived; it may still arrive until 2 December. Nothing happens on 30 November.
    const nov30 = liquidity(k.db, k.userId, at('2026-11-30'))
    const dec1 = liquidity(k.db, k.userId, at('2026-12-01'))
    expect(nov30.need).toBe(0)
    expect(dec1.need).toBe(0)                                           // before the patch: 2,000,000, the instalment of 5 December
    expect(dec1.assumptions.firstCounted).toEqual({ due: '2026-11-28', by: '2026-12-02' })
  })

  it('M3: a salary that never arrived keeps using the allowance after the month turns', () => {
    const k = makeKit({
      opening: { bank: 0, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 },
      profile: { income: 12_000_000, incomeDay: 1, spending: 7_000_000, personalLoanEmi: 0, homeLoanEmi: 0, emiDay: 5, lateDays: 5, lostSalaries: 1, line: 0 },
    })
    // December's salary never arrives (the kit posts none by itself). December and January have 31 days: Rs 2,258.07 a day.
    const DAY = 225_807
    const dec31 = liquidity(k.db, k.userId, at('2026-12-31'))
    const jan1 = liquidity(k.db, k.userId, at('2027-01-01'))
    expect(dec31.need).toBe(7 * DAY)                                   // to 6 January, when January's salary is counted
    expect(jan1.need).toBe(6 * DAY)                                    // before the patch: 8,500,017 (the allowance renewed)
    expect(jan1.assumptions.late).toEqual({ due: '2026-12-01', count: 1, beyondAllowance: 0 })   // before: null
    expect(jan1.assumptions.allowanceLeft).toBe(0)                     // before: undefined
    expect(jan1.assumptions.lostSoFar).toBe(1)
  })

  it('M3: once the allowance is used, a second lost salary is reported as worse than allowed for in the next month too', () => {
    const k = makeKit({
      opening: { bank: 0, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 },
      profile: { income: 12_000_000, incomeDay: 1, spending: 7_000_000, personalLoanEmi: 0, homeLoanEmi: 0, emiDay: 5, lateDays: 5, lostSalaries: 1, line: 0 },
    })
    // December's and January's salaries never arrive.
    const feb1 = liquidity(k.db, k.userId, at('2027-02-01'))
    expect(feb1.assumptions.late).toEqual({ due: '2026-12-01', count: 2, beyondAllowance: 1 })      // before: null, both forgotten
  })

  it('walking a year day by day, with salaries on their last allowed day, what must stay never rises on a day no salary arrived', () => {
    const k = lateSalaryHousehold()
    let day = '2026-11-19', prev = liquidity(k.db, k.userId, at(day)).need
    const rises: string[] = []
    for (let i = 0; i < 365; i++) {
      // the events of `day`: the instalment at 09:00 on the 5th, a salary at 09:30 on its last allowed day
      const [y, m, d] = day.split('-').map(Number) as [number, number, number]
      if (d === 5) takeInstalment(k, `${y}-${p2(m)}`, istInstant(day, '09:00'), 2_000_000)
      let arrived = false
      for (const back of [0, 1]) {
        let yy = y, mm = m - back
        if (mm === 0) { mm = 12; yy -= 1 }
        const ym = `${yy}-${p2(mm)}`
        if (addDays(`${ym}-28`, 4) === day) { postSalary(k, ym, istInstant(day, '09:30'), 2_000_000); arrived = true }
      }
      const next = addDays(day, 1), need = liquidity(k.db, k.userId, at(next)).need
      if (need > prev && !arrived) rises.push(`${day} -> ${next}: ${prev} -> ${need}`)
      day = next; prev = need
    }
    expect(rises).toEqual([])                                          // before the patch: a rise on the 1st of every month
  })

  it('M2 (documented, unchanged by the patch): a harder day coming into view can raise what must stay', () => {
    // Rs 70,000 of everyday spending spread over the days of each month; income Rs 70,000.20 on the 28th, on time: the
    // least income that covers every calendar month. The stretch from 29 January to 28 February 2029 carries more than a
    // month of spending (3 days at January's rate and 28 at February's), and comes into view on 2 October 2028.
    const k = makeKit({
      start: istInstant('2028-09-15', '00:00') - 60_000,
      opening: { bank: 0, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 },
      profile: { income: 7_000_020, incomeDay: 28, spending: 7_000_000, personalLoanEmi: 0, homeLoanEmi: 0, emiDay: 5, lateDays: 0, lostSalaries: 0, line: 0 },
    })
    postSalary(k, '2028-09', istInstant('2028-09-28', '09:30'), 7_000_020)
    const oct1 = liquidity(k.db, k.userId, at('2028-10-01')), oct2 = liquidity(k.db, k.userId, at('2028-10-02'))
    expect(oct1.need).toBe(6_749_991)
    expect(oct2.need).toBe(6_774_184)
    expect(oct2.binding?.date).toBe('2029-02-28')
  })
})
