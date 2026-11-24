/**
 * A goal's arithmetic (R12 task comparison, gap 5; T3-a to T3-c): the monthly figure, the on-track rule, and the
 * remedies when behind, all in integer paise. The properties are the rule's promises: the figure QED offers, and every
 * remedy it names, reaches the target when followed; QED never offers more than is needed by a rupee or more (without
 * growth, where the arithmetic is exact); and a contribution never takes the set-aside past its target.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addMonths, type GoalInputs, monthlyFor, monthsBetween, project, remedies, runDates } from './goal-math.ts'

const R = 100 // paise in a rupee

describe('the example a household gives: ₹50,000 for the end of March', () => {
  // 24 Nov 2026, contributions on the 2nd: 2 Dec, 2 Jan, 2 Feb and 2 Mar fall before 31 Mar 2027
  const runs = runDates(2, '2026-11-24', '2027-03-31')
  const base: GoalInputs = { target: 5_000_000, balance: 0, monthly: 0, growthBps: 0, today: '2026-11-24', date: '2027-03-31', runs: runs.map((date) => ({ date })), day: 2, latest: '2027-12-24' }

  it('lays out the contributions on the chosen day of each month, up to the date', () => {
    expect(runs).toEqual(['2026-12-02', '2027-01-02', '2027-02-02', '2027-03-02'])
    expect(runDates(24, '2026-11-24', '2026-12-31')).toEqual(['2026-11-24', '2026-12-24']) // today counts when it is the day
  })

  it('works out ₹12,500 a month, which reaches it exactly', () => {
    expect(monthlyFor(base)).toBe(1_250_000)
    const p = project({ ...base, monthly: 1_250_000 })
    expect(p.projected).toBe(5_000_000)
    expect(p.onTrack).toBe(true)
    expect(p.shortfall).toBe(0)
    expect(p.contributions.map((c) => c.amount)).toEqual([1_250_000, 1_250_000, 1_250_000, 1_250_000])
  })

  it('when the December contribution does not happen it is ₹12,500 short, and says what reaches it', () => {
    const behind: GoalInputs = { ...base, monthly: 1_250_000, today: '2026-12-03', runs: runDates(2, '2026-12-03', '2027-03-31').map((date) => ({ date })) }
    const p = project(behind)
    expect(p.onTrack).toBe(false)
    expect(p.projected).toBe(3_750_000)
    expect(p.shortfall).toBe(1_250_000)
    const r = remedies(behind)
    // ₹50,000 over the three that are left is ₹16,666.67, rounded up to the rupee so that following it reaches the goal
    expect(r.more).toEqual({ monthly: 1_666_700, extra: 416_700 })
    // carrying on at ₹12,500 a month, the 2 April contribution reaches it
    expect(r.later).toEqual({ date: '2027-04-02' })
    expect(r.now).toEqual({ amount: 1_250_000 })
  })

  it('rounds the monthly figure up to the rupee, and the last contribution takes only what is left', () => {
    const odd = { ...base, target: 1_000_001 } // ₹10,000.01 over four contributions
    const m = monthlyFor(odd)!
    expect(m).toBe(250_100) // ₹2,500.0025 rounded up to the rupee
    const p = project({ ...odd, monthly: m })
    expect(p.contributions.map((c) => c.amount)).toEqual([250_100, 250_100, 250_100, 249_701])
    expect(p.projected).toBe(1_000_001)
  })

  it('counts growth only under an assumption the household names, and floors it', () => {
    const none = project({ ...base, monthly: 1_250_000 })
    expect(none.growth).toBe(0)
    const g = project({ ...base, monthly: 1_250_000, growthBps: 1_200 }) // 12% a year, 1% a month, compounded monthly
    // 2 Dec grows 3 whole months to 31 Mar, 2 Jan 2, 2 Feb 1, 2 Mar none
    expect(g.growth).toBe(37_876 + 25_125 + 12_500)
    expect(monthlyFor({ ...base, growthBps: 1_200 })).toBeLessThan(1_250_000)
  })
})

describe('months and dates', () => {
  it('counts whole months, never a part month', () => {
    expect(monthsBetween('2026-12-02', '2027-03-31')).toBe(3)
    expect(monthsBetween('2026-11-24', '2027-03-31')).toBe(4)
    expect(monthsBetween('2027-01-31', '2027-02-28')).toBe(0)
    expect(monthsBetween('2027-03-02', '2027-03-02')).toBe(0)
    expect(monthsBetween('2027-03-31', '2027-03-02')).toBe(0)
  })
  it('adds months on a day that every month has', () => {
    expect(addMonths('2026-12-02', 1)).toBe('2027-01-02')
    expect(addMonths('2026-11-28', 3)).toBe('2027-02-28')
  })
})

describe('no contribution left before the date', () => {
  it('has no monthly figure, and offers the date and the amount now', () => {
    const late: GoalInputs = { target: 2_000_000, balance: 500_000, monthly: 500_000, growthBps: 0, today: '2027-03-03', date: '2027-03-31', runs: [], day: 2, latest: '2028-03-01' }
    expect(monthlyFor(late)).toBe(null)
    const r = remedies(late)
    expect(r.more).toBe(null)
    expect(r.now).toEqual({ amount: 1_500_000 })
    expect(r.later).toEqual({ date: '2027-06-02' }) // 2 Apr, 2 May and 2 Jun at ₹5,000
  })
  it('offers no later date beyond the latest an instruction may run to', () => {
    const tight: GoalInputs = { target: 2_000_000, balance: 0, monthly: 100_000, growthBps: 0, today: '2026-11-24', date: '2026-12-31', runs: [{ date: '2026-12-02' }], day: 2, latest: '2027-02-01' }
    expect(remedies(tight).later).toBe(null)
  })
})

// ---------------------------------------------------------------------------------------------- properties

const day = fc.integer({ min: 1, max: 28 })
const isoFrom = (base: string, n: number): string => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
/** A random goal: a target up to ₹1 crore, part of it set aside, a date up to 13 months away, a day, a growth assumption. */
const goal = fc.record({
  target: fc.integer({ min: 100, max: 1_000_000_000 }),
  setAside: fc.double({ min: 0, max: 0.95, noNaN: true }),
  todayOffset: fc.integer({ min: 0, max: 3_000 }),
  span: fc.integer({ min: 1, max: 395 }),
  day,
  growthBps: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_500 })),
}).map((g) => {
  const today = isoFrom('2026-01-01', g.todayOffset)
  const date = isoFrom(today, g.span)
  const balance = Math.floor(g.target * g.setAside)
  return { target: g.target, balance, monthly: 0, growthBps: g.growthBps, today, date, runs: runDates(g.day, today, date).map((d) => ({ date: d })), day: g.day, latest: isoFrom(today, 395) } satisfies GoalInputs
})

describe('properties over many random goals', () => {
  it('the monthly figure QED offers reaches the target, in whole rupees, and a rupee less does not without growth', () => {
    fc.assert(fc.property(goal, (g) => {
      const m = monthlyFor(g)
      if (g.runs.length === 0) return m === null
      expect(m).not.toBe(null)
      expect(Number.isSafeInteger(m) && m! % R === 0).toBe(true)
      expect(project({ ...g, monthly: m! }).projected).toBeGreaterThanOrEqual(g.target)
      if (g.growthBps === 0 && m! >= R) expect(project({ ...g, monthly: m! - R }).projected).toBeLessThan(g.target)
      return true
    }), { numRuns: 3_000 })
  })

  it('on track means the projection reaches the target; the shortfall is exactly what is missing', () => {
    fc.assert(fc.property(goal, fc.integer({ min: 0, max: 50_000_000 }), (g, monthly) => {
      const p = project({ ...g, monthly })
      expect(p.onTrack).toBe(p.projected >= g.target)
      expect(p.shortfall).toBe(Math.max(0, g.target - p.projected))
      expect(p.projected).toBe(g.balance + p.scheduled + p.growth)
      return true
    }), { numRuns: 3_000 })
  })

  it('a contribution never takes the set-aside past its target, and none is negative', () => {
    fc.assert(fc.property(goal, fc.integer({ min: 0, max: 50_000_000 }), (g, monthly) => {
      const p = project({ ...g, monthly })
      expect(p.contributions.every((c) => Number.isSafeInteger(c.amount) && c.amount >= 0 && c.amount <= monthly)).toBe(true)
      expect(g.balance + p.scheduled).toBeLessThanOrEqual(Math.max(g.balance, g.target))
      return true
    }), { numRuns: 3_000 })
  })

  it('every remedy offered when behind reaches the target when it is followed', () => {
    fc.assert(fc.property(goal, fc.double({ min: 0, max: 0.99, noNaN: true }), (g, frac) => {
      const needed = monthlyFor(g)
      // a monthly figure below what is needed: behind, unless the set-aside is already enough
      const monthly = needed === null ? 100_000 : Math.floor((needed * frac) / R) * R
      const i = { ...g, monthly }
      const p = project(i)
      const r = remedies(i)
      if (p.onTrack) return r.more === null && r.later === null && r.now === null
      if (r.more) {
        expect(r.more.extra % R === 0 && r.more.extra > 0 && r.more.monthly === monthly + r.more.extra).toBe(true)
        expect(project({ ...i, monthly: r.more.monthly }).onTrack).toBe(true)
      } else expect(g.runs.length).toBe(0)
      expect(r.now).not.toBe(null)
      expect(r.now!.amount % R === 0 && r.now!.amount > 0).toBe(true)
      expect(project({ ...i, balance: g.balance + r.now!.amount }).onTrack).toBe(true)
      if (g.growthBps === 0) expect(project({ ...i, balance: g.balance + r.now!.amount - R }).onTrack).toBe(false)
      if (r.later) {
        expect(r.later.date > g.date && r.later.date <= g.latest).toBe(true)
        const later = { ...i, date: r.later.date, runs: runDates(g.day, g.today, r.later.date).map((d) => ({ date: d })) }
        expect(project(later).onTrack).toBe(true)
        // the earliest such date: the contribution before it does not reach the target
        const before = runDates(g.day, g.today, r.later.date).filter((d) => d > g.date && d < r.later!.date).pop()
        if (before) expect(project({ ...i, date: before, runs: runDates(g.day, g.today, before).map((d) => ({ date: d })) }).onTrack).toBe(false)
      }
      return true
    }), { numRuns: 3_000 })
  })

  it('a contribution already planned is counted at its own figure', () => {
    fc.assert(fc.property(goal, fc.integer({ min: 1, max: 5_000_000 }), (g, planned) => {
      if (g.runs.length === 0) return true
      const [first, ...rest] = g.runs
      const p = project({ ...g, monthly: 0, runs: [{ date: first!.date, amount: planned }, ...rest] })
      expect(p.contributions[0]!.amount).toBe(Math.min(planned, Math.max(0, g.target - g.balance)))
      return true
    }), { numRuns: 1_000 })
  })
})
