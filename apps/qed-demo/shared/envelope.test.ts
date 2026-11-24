import { describe, expect, it } from 'vitest'
import { type Caps, cumLower, cumUpper, greedyDrain, type Income, incomeExceeded, largestMonthlyLimit, monthOf, most, type Outflow, reserve } from './envelope.ts'
import fixtures from './envelope.fixtures.json' with { type: 'json' }

interface CapsCase { caps: Caps; now: number; u: number; v: number; most: number; mostFresh: number; cum: number[]; allow: number[]; greedy: number[] }
interface HouseholdCase { now: number; horizon: number; committed: Outflow[]; inflows: Income[]; reserve: { need: number; bindingStep: number | null; debitsToBinding: number; inflowsToBinding: number; path: number[]; sustainable: boolean }; limit: { balance: number; perRun: number; runSteps: number[]; runsPerStep: number; start: string; answer: number } }
interface EdgeCase { now: number; horizon: number; kind: 'none' | 'beyond' | 'mixed'; committed: Outflow[]; inflows: Income[]; cumLower: number[]; exceeded: number; reserve: { need: number; bindingStep: number | null }; limit: { balance: number; perRun: number; runSteps: number[]; runsPerStep: number; start: string; answer: number } }
const f = fixtures as unknown as { caps: CapsCase[]; households: HouseholdCase[]; edges: EdgeCase[] }

describe('agreement with the Python reference (experiments/r6/E1-flow-envelopes)', () => {
  it('the most a set of limits lets through, for 150 generated cases', () => {
    for (const c of f.caps) {
      expect(most(c.caps, c.u, c.v, c.now)).toBe(c.most)
      expect(most({ ...c.caps, usedMonth: 0, usedLife: c.caps.usedLife }, c.u, c.v, null)).toBe(c.mostFresh)
      expect(cumUpper(c.caps, c.now, 70)).toEqual(c.cum)
      expect(greedyDrain(c.allow, c.caps, c.now)).toEqual(c.greedy)
    }
  })
  it('the reserve, its hardest debit and its path, for 150 generated households', () => {
    for (const h of f.households) {
      const r = reserve(h.committed, h.inflows, h.now, h.horizon)
      expect({ need: r.need, bindingStep: r.bindingStep, debitsToBinding: r.debitsToBinding, inflowsToBinding: r.inflowsToBinding, sustainable: r.sustainable }).toEqual({ need: h.reserve.need, bindingStep: h.reserve.bindingStep, debitsToBinding: h.reserve.debitsToBinding, inflowsToBinding: h.reserve.inflowsToBinding, sustainable: h.reserve.sustainable })
      expect(r.path).toEqual(h.reserve.path)
    }
  })
  it('the largest safe monthly limit, for 150 generated households', () => {
    for (const h of f.households) expect(largestMonthlyLimit(h.limit.balance, h.committed, h.inflows, h.now, h.horizon, h.limit.perRun, h.limit.runSteps, h.limit.start, h.limit.runsPerStep)).toBe(h.limit.answer)
  })
})

describe('the inputs the independent review of 20 November 2026 found wrong or unpinned', () => {
  it('agrees with the corrected reference on 120 generated cases: due steps out of order, no run day in view, run days beyond the horizon', () => {
    expect(f.edges.length).toBe(120)
    for (const e of f.edges) {
      expect(cumLower(e.inflows[0]!, e.now, e.horizon)).toEqual(e.cumLower)
      expect(incomeExceeded(e.inflows[0]!, e.now)).toBe(e.exceeded)
      const r = reserve(e.committed, e.inflows, e.now, e.horizon)
      expect({ need: r.need, bindingStep: r.bindingStep }).toEqual(e.reserve)
      expect(largestMonthlyLimit(e.limit.balance, e.committed, e.inflows, e.now, e.horizon, e.limit.perRun, e.limit.runSteps, e.limit.start, e.limit.runsPerStep)).toBe(e.limit.answer)
      if (e.kind !== 'mixed') expect(e.limit.answer).toBe(0)
    }
  })
  it('income due steps written out of order promise nothing the assumption does not', () => {
    const inc: Income = { type: 'income', amount: 1, due: [1, 0], lateBy: 0, missing: 1, received: [] }
    expect(cumLower(inc, 0, 2)).toEqual([0, 1])
    expect(cumLower(inc, 0, 2)).toEqual(cumLower({ ...inc, due: [0, 1] }, 0, 2))
  })
  it('an instruction with no run day in view has no safe limit, and run days beyond the horizon do not raise one', () => {
    expect(largestMonthlyLimit(100, [], [], 0, 3, 7, [], '2027-06-10')).toBe(0)
    expect(largestMonthlyLimit(100, [], [], 0, 3, 7, [50, 51], '2027-06-10')).toBe(0)
    expect(largestMonthlyLimit(100, [], [], 0, 2, 1, [0, 1], '2026-11-01')).toBe(2)
    expect(largestMonthlyLimit(100, [], [], 0, 2, 1, [0, 1, 50, 51, 52], '2026-11-01')).toBe(2)
  })
  it('a payment lost beyond the allowance is counted, so that it can be said', () => {
    const inc: Income = { type: 'income', amount: 5, due: [0, 30, 60], lateBy: 5, missing: 1, received: [] }
    expect([5, 6, 35, 36, 66].map((t) => incomeExceeded(inc, t))).toEqual([0, 0, 0, 1, 2])
  })
  it('with a look-ahead that moves, the reserve can rise with nothing spent (the review\'s smallest counterexample)', () => {
    const debts: Outflow[] = [{ type: 'scheduled', at: [[1, 1]] }]
    expect([reserve(debts, [], 0, 1).need, reserve(debts, [], 1, 1).need, reserve(debts, [], 0, 2).need]).toEqual([0, 1, 1])
  })
})

describe('what the envelope says about calendar limits', () => {
  const monthly: Caps = { type: 'caps', perRun: 1_000_000_000, perMonth: 100, perDay: null, runSteps: null, runsPerStep: 1, lifetime: null, expires: null, start: '2026-11-01', usedMonth: 0, usedLife: 0 }
  const worst = (width: number): number => { let best = 0; for (let u = 0; u < 800; u++) best = Math.max(best, most(monthly, u, u + width)); return best }
  it('a monthly limit lets twice the limit through in two days at a month end', () => { expect(worst(1)).toBe(100); expect(worst(2)).toBe(200); expect(worst(29)).toBe(200) })
  it('and three times the limit in a 30-day stretch that spans a 28-day February', () => { expect(worst(30)).toBe(300) })
  it('months are counted on the calendar of step 0', () => { expect(monthOf('2026-11-30', 0)).not.toBe(monthOf('2026-11-30', 1)); expect(monthOf('2027-02-01', 27)).toBe(monthOf('2027-02-01', 0)) })
})
