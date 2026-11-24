/**
 * The runway's arithmetic: what the chart, its reading and its table say about each day must add up to the server's own
 * path (server/liquidity.ts), to the paisa. The household below is built with the server's rules: everyday spending is
 * the monthly figure spread over the days of each month, rounded up (liquidity.ts, "Everyday spending"); a day's
 * figure is the balance at the end of that day; a salary is counted from the day after the latest it may arrive.
 */
import { describe, expect, it } from 'vitest'
import { axisTicks, compactInr, countedSalaryDays, NO_WHAT_IF, runwayDays, runwayRows, type RunwayBasis, type RunwayEvent, whatIf, whatIfSum } from './charts.tsx'

const dim = (date: string): number => { const [y, m] = date.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).getUTCDate() }
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** A path made the way the server makes it: start, less everything due through each day, plus income counted before it. */
function household({ start, today, days, spending, dues, income }: { start: number; today: string; days: number; spending: number; dues: Record<string, number>; income: Record<string, number> }) {
  const path: { date: string; low: number }[] = []
  let out = 0, inn = 0
  for (let k = 0; k < days; k++) {
    const date = addDays(today, k)
    out += Math.ceil(spending / dim(date)) + (dues[date] ?? 0)
    path.push({ date, low: start - out + inn })
    inn += income[addDays(date, 1)] ?? 0 // income counted on a day is certain to have arrived by the day before
  }
  return path
}

describe('axis labels', () => {
  it('are compact Indian figures from the one formatter of sums', () => {
    expect(compactInr(80_000_000)).toBe('₹8 lakh')
    expect(compactInr(0)).toBe('₹0')
    expect(compactInr(1_250_000_000)).toBe('₹1.25 crore')
    expect(compactInr(-5_000_000)).toBe('−₹50k')
  })
  it('cover the data with round steps, from the first tick at or below it to the first at or above it', () => {
    expect(axisTicks(0, 87_603_202, 4)).toEqual([0, 20_000_000, 40_000_000, 60_000_000, 80_000_000, 100_000_000])
    const t = axisTicks(-1_234_500, 9_000_000, 4)
    expect(t[0]!).toBeLessThanOrEqual(-1_234_500)
    expect(t[t.length - 1]!).toBeGreaterThanOrEqual(9_000_000)
    expect(t).toContain(0)
  })
})

describe('each day of the runway, explained exactly', () => {
  const today = '2026-11-28'
  // ₹70,000 a month of spending; bills of ₹2,450 and ₹999 on the 30th; ₹30,000 of instalments on 5 Dec and 5 Jan;
  // a salary of ₹1,80,000 due 1 Jan, allowed to be 5 days late, so counted from 7 Jan.
  const dues = { '2026-11-30': 344_900, '2026-12-05': 3_000_000, '2027-01-05': 3_000_000 }
  const income = { '2027-01-07': 18_000_000 }
  const path = household({ start: 87_203_202, today, days: 60, spending: 7_000_000, dues, income })
  const named: RunwayEvent[] = [
    { date: '2026-11-30', label: 'City Power', amount: -245_000, kind: 'bill' },
    { date: '2026-11-30', label: 'Fibre Broadband', amount: -99_900, kind: 'bill' },
    { date: '2026-12-05', label: 'Personal loan instalment', amount: -1_000_000, kind: 'emi' },
    { date: '2026-12-05', label: 'Home loan instalment', amount: -2_000_000, kind: 'emi' },
  ]
  const salary = countedSalaryDays(path, { income: 18_000_000, incomeDay: 1, lateDays: 5, firstCounted: { due: '2027-01-01', by: '2027-01-06' } })
  const days = runwayDays(path, { start: 87_203_202, spending: 7_000_000, income: 18_000_000, named, salary })

  it('counts a salary from the day after the latest it may arrive', () => {
    expect([...salary.entries()]).toEqual([['2027-01-07', '2027-01-01']])
  })
  it('on every day, everyday spending and the listed items add up to the path’s own change', () => {
    let before = 87_203_202
    for (const d of days) {
      expect(d.change).toBe(d.low - before)
      expect(-d.spending + d.items.reduce((s, i) => s + i.amount, 0)).toBe(d.change)
      before = d.low
    }
  })
  it('spreads everyday spending over the days of each month, rounded up, as the server does', () => {
    expect(days[0]!.spending).toBe(233_334) // November: 30 days
    expect(days.find((d) => d.date === '2026-12-01')!.spending).toBe(225_807) // December: 31 days
  })
  it('names what is named, and calls what is not by what it must be', () => {
    expect(days.find((d) => d.date === '2026-11-30')!.items.map((i) => i.label)).toEqual(['City Power', 'Fibre Broadband'])
    expect(days.find((d) => d.date === '2026-12-05')!.items.map((i) => [i.label, i.amount])).toEqual([['Personal loan instalment', -1_000_000], ['Home loan instalment', -2_000_000]])
    // beyond what the server named: the instalments of 5 Jan are known only by their sum
    expect(days.find((d) => d.date === '2027-01-05')!.items).toEqual([{ label: 'Bills and instalments due', amount: -3_000_000, kind: 'due' }])
    expect(days.find((d) => d.date === '2027-01-07')!.items).toEqual([{ label: 'Salary counted on', amount: 18_000_000, kind: 'income', due: '2027-01-01' }])
    expect(days.find((d) => d.date === '2026-12-12')!.items).toEqual([])
  })
  it('never lets a name stand for money the path did not count', () => {
    const wrong = runwayDays(path, { start: 87_203_202, spending: 7_000_000, income: 18_000_000, named: [...named, { date: '2026-12-12', label: 'A bill being paid already', amount: -50_000, kind: 'bill' }], salary })
    expect(wrong.find((d) => d.date === '2026-12-12')!.items).toEqual([])
  })
  it('separates a salary from what falls due on the same day', () => {
    const same = household({ start: 1_000_000, today: '2027-01-01', days: 10, spending: 0, dues: { '2027-01-07': 3_000_000 }, income: { '2027-01-07': 18_000_000 } })
    const s = countedSalaryDays(same, { income: 18_000_000, incomeDay: 1, lateDays: 5, firstCounted: { due: '2027-01-01', by: '2027-01-06' } })
    const d = runwayDays(same, { start: 1_000_000, spending: 0, income: 18_000_000, named: [], salary: s }).find((x) => x.date === '2027-01-07')!
    expect(d.items).toEqual([{ label: 'Salary counted on', amount: 18_000_000, kind: 'income', due: '2027-01-01' }, { label: 'Bills and instalments due', amount: -3_000_000, kind: 'due' }])
  })
  it('without the household’s figures, a day is its change and nothing more is claimed', () => {
    const bare = runwayDays(path)
    expect(bare.every((d) => d.spending === 0)).toBe(true)
    expect(bare.find((d) => d.date === '2026-12-05')!.items).toEqual([{ label: 'Change on the day', amount: bare.find((d) => d.date === '2026-12-05')!.change, kind: 'net' }])
  })
})

describe('the runway as a table', () => {
  const path = household({ start: 87_203_202, today: '2026-11-28', days: 45, spending: 7_000_000, dues: { '2026-11-30': 344_900, '2026-12-05': 3_000_000 }, income: { '2026-12-20': 18_000_000 } })
  const named: RunwayEvent[] = [{ date: '2026-11-30', label: 'City Power', amount: -344_900, kind: 'bill' }]
  const salary = new Map([['2026-12-20', '2026-12-14']])
  const days = runwayDays(path, { start: 87_203_202, spending: 7_000_000, income: 18_000_000, named, salary })
  const lowAt = path.reduce((a, p, k) => (p.low < path[a]!.low ? k : a), 0)
  const rows = runwayRows(days, 87_203_202, lowAt)

  it('starts with what is in the bank and ends on the last day drawn', () => {
    expect(rows[0]).toMatchObject({ kind: 'start', balance: 87_203_202, amount: null })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'end', balance: path[path.length - 1]!.low })
  })
  it('marks the lowest point with its balance', () => {
    expect(rows.find((r) => r.kind === 'lowest')).toMatchObject({ balance: path[lowAt]!.low })
  })
  it('adds up: each balance is the one before it plus every amount between them, to the paisa', () => {
    let last = rows[0]!.balance!
    let running = last
    for (const r of rows.slice(1)) {
      running += r.amount ?? 0
      if (r.balance !== null) { expect(r.balance).toBe(running); last = r.balance; running = last }
    }
  })
  it('shows everyday spending as its own line, with the days it covers', () => {
    const first = rows.find((r) => r.kind === 'spending')!
    expect(first.what).toBe('Everyday spending, 3 days')
    expect(first.amount).toBe(-3 * 233_334)
  })
})

/**
 * A what-if (Save's scenario strip) is the recorded worst case with harder assumptions, worked out in the browser. Each
 * case below is checked against the same household built again by the server's rules with the harder figure, so the
 * what-if is what the server itself would have drawn, to the paisa.
 */
describe('a what-if, worked out in paise', () => {
  const today = '2026-11-28', start = 87_203_202, spending = 7_000_000, days = 90
  // bills on 30 Nov, instalments on the 5th; salaries of ₹1,80,000 due 1 Jan and 1 Feb, allowed 5 days late, so
  // counted from 7 Jan and 7 Feb (the one due 1 Dec is the one allowed for as lost, so it is not counted at all)
  const dues: Record<string, number> = { '2026-11-30': 344_900, '2026-12-05': 3_000_000, '2027-01-05': 3_000_000, '2027-02-05': 3_000_000 }
  const income: Record<string, number> = { '2027-01-07': 18_000_000, '2027-02-07': 18_000_000 }
  const path = household({ start, today, days, spending, dues, income })
  const named: RunwayEvent[] = [
    { date: '2026-11-30', label: 'City Power', amount: -245_000, kind: 'bill' },
    { date: '2026-11-30', label: 'Fibre Broadband', amount: -99_900, kind: 'bill' },
    { date: '2026-12-05', label: 'Personal loan instalment', amount: -1_000_000, kind: 'emi' },
    { date: '2026-12-05', label: 'Home loan instalment', amount: -2_000_000, kind: 'emi' },
  ]
  const salary = countedSalaryDays(path, { income: 18_000_000, incomeDay: 1, lateDays: 5, firstCounted: { due: '2027-01-01', by: '2027-01-06' } })
  const basis: RunwayBasis = { start, spending, income: 18_000_000, named, salary }
  const lowAt = (p: { low: number }[]) => p.reduce((a, q, k) => (q.low < p[a]!.low ? k : a), 0)
  const again = (o: { dues?: Record<string, number>; income?: Record<string, number>; start?: number }) => household({ start: o.start ?? start, today, days, spending, dues: o.dues ?? dues, income: o.income ?? income })

  it('with nothing set, is the server’s path exactly, in its figures and in its statement', () => {
    const r = whatIf(path, basis, NO_WHAT_IF)
    expect(r.path).toEqual(path)
    expect(r.changed).toBe(false)
    expect(r.salary).toBeNull()
    expect(r.days.every((d) => d.low === d.recorded && d.spend === 0 && d.salary === 0 && d.bill === 0 && d.monthly === 0)).toBe(true)
    expect(r.low).toEqual(r.recordedLow)
    expect(r.recordedLow.k).toBe(lowAt(path))
    expect(runwayRows(runwayDays(r.path, r.basis), start, r.low.k)).toEqual(runwayRows(runwayDays(path, basis), start, lowAt(path)))
  })
  it('adds up on every day: the what-if is the recorded figure plus each part, and its statement adds up to the paisa', () => {
    const r = whatIf(path, basis, { spend: 5_000_050, salaryLate: 12, salaryLost: false, bill: { date: '2026-12-05', label: 'Home loan instalment', more: 250_001 }, monthly: { amount: 1_499_999, day: 10 } })
    expect(r.changed).toBe(true)
    for (const d of r.days) expect(d.low).toBe(d.recorded + d.spend + d.salary + d.bill + d.monthly)
    let before = start
    for (const d of runwayDays(r.path, r.basis)) {
      expect(d.change).toBe(d.low - before)
      expect(-d.spending + d.items.reduce((s, i) => s + i.amount, 0)).toBe(d.change)
      before = d.low
    }
    const rows = runwayRows(runwayDays(r.path, r.basis), start, r.low.k)
    let running = rows[0]!.balance!
    for (const row of rows.slice(1)) { running += row.amount ?? 0; if (row.balance !== null) { expect(row.balance).toBe(running); running = row.balance } }
    expect(rows.find((x) => x.kind === 'lowest')!.balance).toBe(r.low.low)
  })
  it('spending today is the household with that much less in the bank, and is named on today', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, spend: 2_500_000 })
    expect(r.path).toEqual(again({ start: start - 2_500_000 }))
    expect(r.days.every((d) => d.spend === -2_500_000)).toBe(true)
    expect(runwayDays(r.path, r.basis)[0]!.items).toContainEqual({ label: 'What-if: spent today', amount: -2_500_000, kind: 'whatif' })
  })
  it('a bill larger is the household with that bill larger, from its day on', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, bill: { date: '2026-12-05', label: 'Home loan instalment', more: 500_000 } })
    expect(r.path).toEqual(again({ dues: { ...dues, '2026-12-05': dues['2026-12-05']! + 500_000 } }))
    expect(r.days.filter((d) => d.bill !== 0)[0]!.date).toBe('2026-12-05')
    expect(runwayDays(r.path, r.basis).find((d) => d.date === '2026-12-05')!.items.map((i) => i.label)).toEqual(['Personal loan instalment', 'Home loan instalment', 'What-if: Home loan instalment, larger'])
  })
  it('a salary later than allowed for is counted from the day after it comes, and only that salary moves', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, salaryLate: 12 }) // due 1 Jan, comes 13 Jan, counted from 14 Jan
    expect(r.path).toEqual(again({ income: { '2027-01-14': 18_000_000, '2027-02-07': 18_000_000 } }))
    expect(r.salary).toEqual({ due: '2027-01-01', counted: '2027-01-07', now: '2027-01-14' })
    const d = runwayDays(r.path, r.basis)
    expect(d.find((x) => x.date === '2027-01-14')!.items).toEqual([{ label: 'Salary counted on', amount: 18_000_000, kind: 'income', due: '2027-01-01' }])
    expect(d.find((x) => x.date === '2027-01-07')!.items).toEqual([])
  })
  it('a salary late by no more than is allowed for changes nothing', () => {
    for (const late of [0, 3, 5]) expect(whatIf(path, basis, { ...NO_WHAT_IF, salaryLate: late }).path).toEqual(path)
  })
  it('a lost salary is the household without it, and the next one is still counted on', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, salaryLost: true, salaryLate: 20 })
    expect(r.path).toEqual(again({ income: { '2027-02-07': 18_000_000 } }))
    expect(r.salary).toEqual({ due: '2027-01-01', counted: '2027-01-07', now: null })
  })
  it('a new monthly cost falls on its day each month from the next one, as a dated bill would', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, monthly: { amount: 1_500_000, day: 10 } })
    expect(r.path).toEqual(again({ dues: { ...dues, '2026-12-10': 1_500_000, '2027-01-10': 1_500_000, '2027-02-10': 1_500_000 } }))
    expect(runwayDays(r.path, r.basis).find((d) => d.date === '2027-01-10')!.items).toEqual([{ label: 'What-if: new cost each month', amount: -1_500_000, kind: 'whatif' }])
  })
  it('names the first day it falls short and the lowest day', () => {
    const r = whatIf(path, basis, { ...NO_WHAT_IF, spend: 86_000_000 })
    expect(r.firstShort).not.toBeNull()
    expect(r.firstShort!.low).toBeLessThan(0)
    expect(r.days.slice(0, r.firstShort!.k).every((d) => d.low >= 0)).toBe(true)
    expect(r.low.low).toBe(Math.min(...r.path.map((p) => p.low)))
  })
  it('never makes a day easier, and ignores anything that is not a whole positive number of paise or a named bill', () => {
    const odd = whatIf(path, basis, { spend: -100, salaryLate: -4, salaryLost: false, bill: { date: '2026-12-05', label: 'Not a bill', more: 100 }, monthly: { amount: 10.5, day: 31 } })
    expect(odd.path).toEqual(path)
    const hard = whatIf(path, basis, { spend: 1, salaryLate: 40, salaryLost: false, bill: { date: '2026-11-30', label: 'City Power', more: 1 }, monthly: { amount: 1, day: 1 } })
    expect(hard.days.every((d) => d.low <= d.recorded)).toBe(true)
  })
  it('is written so that it adds up as written: free less what it takes, or a shortfall plus what it takes', () => {
    const add = (s: ReturnType<typeof whatIfSum>, shortAfter: boolean) => (s.op === '−' ? (shortAfter ? s.takes - s.first : s.first - s.takes) : s.first + s.takes)
    for (const [recorded, low] of [[69_522_133, 64_522_133], [69_522_133, -477_867], [-230_127_328, -235_127_328], [0, -1], [5, 5]] as const) {
      const s = whatIfSum(recorded, low)
      expect(s.takes).toBe(recorded - low)
      expect(add(s, low < 0 && recorded >= 0)).toBe(s.last)
      expect(s.op).toBe(recorded < 0 ? '+' : '−')
    }
  })
})
