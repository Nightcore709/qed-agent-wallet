import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import fixtures from './x5.fixtures.json'
import { exactCheck, ledger, scenarios, X5_DEFAULT, ZERO_PLAN, type Plan } from './x5.ts'

const decode = (v: unknown): unknown => {
  if (v === 'nan') return NaN
  if (v === 'inf') return Infinity
  if (v === '-inf') return -Infinity
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, u]) => [k, decode(u)]))
  return v
}

interface Expect { rejected: boolean; tier_D: boolean; scenarios_checked: number; min_exact_improvement_inr: number | null; max_shortfall_deepening_inr: number | null }

describe('Checker A matches the X5 research checker (v3.1) on golden fixtures', () => {
  it('has the fixture set', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(255)
  })
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const e = c.expect as Expect
      const v = exactCheck(decode(c.plan), decode(c.s0))
      expect(v.rejected).toBe(e.rejected)
      expect(v.tierD).toBe(e.tier_D)
      expect(v.scenariosChecked).toBe(e.scenarios_checked)
      if (e.min_exact_improvement_inr === null) expect(v.minImprovement).toBeNull()
      else expect(Math.abs((v.minImprovement ?? NaN) - e.min_exact_improvement_inr)).toBeLessThan(0.006)
      if (e.max_shortfall_deepening_inr === null) expect(v.maxDeepening).toBeNull()
      else expect(Math.abs((v.maxDeepening ?? NaN) - e.max_shortfall_deepening_inr)).toBeLessThan(0.006)
    })
  }
  it('reproduces every per-scenario ledger value for the ₹50,000 card repayment exactly', () => {
    const plan: Plan = { ...ZERO_PLAN, card: 50_000 }
    const all = scenarios()
    expect(all).toHaveLength(64)
    fixtures.card_50k_detail.forEach((d, i) => {
      const s = all[i]!
      expect(s.sav).toBe(d.scenario.sav)
      expect(s.card).toBe(d.scenario.card)
      expect(ledger(plan, s, X5_DEFAULT.s0).nw).toBe(d.nw_plan)
      expect(ledger(ZERO_PLAN, s, X5_DEFAULT.s0).nw).toBe(d.nw_base)
      expect(ledger(plan, s, X5_DEFAULT.s0).shortfalls).toEqual(d.sh_plan)
    })
  })
})

describe('Checker A properties', () => {
  const amount = fc.double({ min: 0, max: 1_500_000, noNaN: true, noDefaultInfinity: true })
  it('never certifies a plan that is not executable, and never reports a non-finite figure', () => {
    fc.assert(
      fc.property(fc.record({ card: amount, personal_loan: amount, home_loan: amount, fd: amount, liquid_fund: amount }), (plan) => {
        const v = exactCheck(plan)
        if (v.rejected) {
          expect(v.tierD).toBe(false)
          expect(v.minImprovement).toBeNull()
        } else {
          expect(Number.isFinite(v.minImprovement)).toBe(true)
          expect(Number.isFinite(v.maxDeepening)).toBe(true)
          expect(plan.card).toBeLessThanOrEqual(X5_DEFAULT.debt.card)
        }
      }),
      { numRuns: 300, seed: 20261118 },
    )
  })
  it('rejects ill-formed input of any shape without throwing', () => {
    const anything = fc.oneof(fc.double(), fc.integer(), fc.boolean(), fc.constant(null), fc.string({ maxLength: 4 }))
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('card', 'personal_loan', 'home_loan', 'fd', 'liquid_fund', 'crypto'), anything), (plan) => {
        const wellFormed = ['card', 'personal_loan', 'home_loan', 'fd', 'liquid_fund'].every((k) => typeof plan[k] === 'number' && Number.isFinite(plan[k]) && (plan[k] as number) >= 0) && !('crypto' in plan)
        const v = exactCheck(plan)
        if (!wellFormed) expect(v.rejected).toBe(true)
        if (v.tierD) expect(wellFormed).toBe(true)
      }),
      { numRuns: 400, seed: 7 },
    )
  })
})
