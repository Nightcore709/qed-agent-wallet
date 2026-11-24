import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import fixturesB from './checkerB.fixtures.json'
import { checkerB } from './checkerB.ts'
import { exactCheck } from './x5.ts'

const decode = (v: unknown): unknown => {
  if (v === 'nan') return NaN
  if (v === 'inf') return Infinity
  if (v === '-inf') return -Infinity
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, u]) => [k, decode(u)]))
  return v
}

interface Expect { rejected: boolean; tier_D: boolean; min_exact_improvement_inr: number | null; max_shortfall_deepening_inr: number | null }

describe('Checker B matches the independent X7 checker (rule v3.2) on golden fixtures', () => {
  for (const c of fixturesB.cases) {
    it(c.name, () => {
      const e = c.expect as Expect
      const v = checkerB(decode(c.plan), decode(c.s0))
      expect(v.rejected).toBe(e.rejected)
      expect(v.tierD).toBe(e.tier_D)
      if (e.min_exact_improvement_inr === null) expect(v.minImprovement).toBeNull()
      else expect(Math.abs((v.minImprovement ?? NaN) - e.min_exact_improvement_inr)).toBeLessThan(0.006)
      if (e.max_shortfall_deepening_inr === null) expect(v.maxDeepening).toBeNull()
      else expect(Math.abs((v.maxDeepening ?? NaN) - e.max_shortfall_deepening_inr)).toBeLessThan(0.006)
    })
  }
})

describe('N-version: Checkers A and B agree', () => {
  it('on every fixture input, in verdict, and in figures to ₹0.02', () => {
    for (const c of fixturesB.cases) {
      const a = exactCheck(decode(c.plan), decode(c.s0))
      const b = checkerB(decode(c.plan), decode(c.s0))
      expect(b.rejected).toBe(a.rejected)
      expect(b.tierD).toBe(a.tierD)
      if (!a.rejected) {
        expect(Math.abs((b.minImprovement ?? 0) - (a.minImprovement ?? 0))).toBeLessThan(0.02)
        expect(Math.abs((b.maxDeepening ?? 0) - (a.maxDeepening ?? 0))).toBeLessThan(0.02)
      }
    }
  })
  it('on random plans across three savings levels', () => {
    const amount = fc.double({ min: 0, max: 900_000, noNaN: true, noDefaultInfinity: true })
    fc.assert(
      fc.property(fc.record({ card: amount, personal_loan: amount, home_loan: amount, fd: amount, liquid_fund: amount }), fc.constantFrom(600_000, 800_000, 1_200_000), (plan, s0) => {
        const a = exactCheck(plan, s0)
        const b = checkerB(plan, s0)
        expect(b.rejected).toBe(a.rejected)
        if (!a.rejected) expect(b.tierD).toBe(a.tierD)
      }),
      { numRuns: 400, seed: 20261118 },
    )
  })
})
