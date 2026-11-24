/**
 * The money-weighted annual rate handles undefined results (R13 section 4: "money-weighted returns use dated cash flows
 * and handle undefined results"; server/performance.ts xirr).
 *
 * The rate solves Σ amount (1 + r)^-(t/365 days) = 0. Money that moves one way has no rate; cash flows that change sign
 * more than once (a purchase, a redemption, another purchase, the value today) can have several rates, and then none
 * is chosen for the owner. xirr looks for the sum's sign changes on a grid in ln(1 + r); two rates closer together than
 * one step of the grid change the sign twice inside a step and were missed, so a third rate elsewhere was given as the
 * rate (found here: flows whose rates are 11.05%, 11.11% and 100% were given "100%"). By Laguerre's rule of signs the
 * number of rates is at most the number of sign changes of the dated amounts; when that is more than one, a step whose
 * ends do not differ in sign but whose slope does is searched for a turn where the sum crosses zero twice.
 */
import { describe, expect, it } from 'vitest'
import { discounted, xirr } from './performance.ts'

const YEAR = 365 * 86_400_000
/** Yearly cash flows whose discounted sum is the polynomial Π (x - x_i) in x = 1 / (1 + r), scaled and rounded to paise. */
function flowsWithRates(rates: number[], scale = 1e9): { at: number; amount: number }[] {
  let coef = [1] // highest power last
  for (const r of rates) {
    const root = 1 / (1 + r), next = new Array<number>(coef.length + 1).fill(0)
    coef.forEach((c, k) => { next[k + 1]! += c; next[k]! -= c * root })
    coef = next
  }
  return coef.map((c, k) => ({ at: k * YEAR, amount: Math.round(c * scale) }))
}
const npvAt = (cfs: { at: number; amount: number }[], r: number): number => discounted(cfs, Math.log1p(r)).npv

describe('several rates: none is chosen', () => {
  it('two rates closer together than a step of the solver\'s grid, and a third far from them: "several", not the third as the rate', () => {
    const cfs = [{ at: 0, amount: -405_225 }, { at: YEAR, amount: 1_710_700 }, { at: 2 * YEAR, amount: -2_300_500 }, { at: 3 * YEAR, amount: 1_000_000 }]
    // the sum is zero at 11.05%, 11.11% and 100% a year: three rates
    expect(Math.sign(npvAt(cfs, 0.10))).toBe(1)
    expect(Math.sign(npvAt(cfs, 0.1108))).toBe(-1)
    expect(Math.sign(npvAt(cfs, 0.5))).toBe(1)
    expect(xirr(cfs)).toEqual({ rate: null, why: 'several' })
  })

  it('a pair of rates at every closeness from a hundredth of a percentage point to two points, with a third elsewhere: always "several"', () => {
    for (const gap of [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02]) {
      const cfs = flowsWithRates([0.08, 0.08 + gap, 0.6])
      expect(xirr(cfs), `gap ${gap}`).toEqual({ rate: null, why: 'several' })
    }
  })

  it('one rate, however the flows change sign, is still given: a purchase, a redemption, a purchase and the value today', () => {
    const cfs = [{ at: 0, amount: -10_000_000 }, { at: 0.5 * YEAR, amount: 3_000_000 }, { at: YEAR, amount: -5_000_000 }, { at: 2 * YEAR, amount: 15_000_000 }]
    const r = xirr(cfs)
    expect(r.rate).not.toBeNull()
    if (r.rate !== null) expect(Math.abs(npvAt(cfs, r.rate))).toBeLessThan(1e-6 * 33_000_000)
  })

  it('money only in, or only out, or nothing, has no rate', () => {
    expect(xirr([{ at: 0, amount: -100 }, { at: YEAR, amount: -50 }])).toEqual({ rate: null, why: 'one-sided' })
    expect(xirr([{ at: 0, amount: 0 }])).toEqual({ rate: null, why: 'one-sided' })
  })
})
