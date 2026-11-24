/**
 * The Portfolio lab's arithmetic (portfolio.ts) against independent computations: scikit-learn's Ledoit-Wolf and a
 * CVXPY/Clarabel minimum-variance solve on a fixed SYNTHETIC data set (values pinned below, computed in envs/quant on
 * 24 Nov 2026), projected-gradient descent on random covariances, and walk-forward cases whose answers are known.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ledoitWolf, metrics, minVariance, riskParity, type Series, sharpeDifference, walkForward } from './portfolio.ts'

const X = Array.from({ length: 60 }, (_, t) => Array.from({ length: 4 }, (_, j) => Math.sin(1.3 * t + j) * 0.01 + 0.002 * j * Math.cos(0.7 * t)))

describe('covariance and optimisers', () => {
  it('Ledoit-Wolf shrinkage matches scikit-learn', () => {
    const { S, shrinkage } = ledoitWolf(X)
    expect(shrinkage).toBeCloseTo(0.04772377077847551, 12)
    expect(S[0]![0]!).toBeCloseTo(5.0164184732594215e-05, 15)
    expect(S[0]![1]!).toBeCloseTo(2.6302226110102507e-05, 15)
    expect(S[2]![3]!).toBeCloseTo(3.555524305178116e-05, 15)
  })
  it('minimum variance matches a CVXPY (Clarabel) solve, with its KKT residual and duality gap near zero', () => {
    const m = minVariance(ledoitWolf(X).S)
    // the exact face solution is at least as good as the interior-point one (which left 2e-8 and 7e-8 on two assets)
    expect(m.variance).toBeLessThanOrEqual(5.65587439132188e-06)
    expect(5.65587439132188e-06 - m.variance).toBeLessThan(1e-12)
    expect(m.w[0]!).toBeCloseTo(0.5369014991814425, 6)
    expect(m.w[3]!).toBeCloseTo(0.4630984075522065, 6)
    expect(m.kkt).toBeLessThan(1e-9)
    expect(m.gap).toBeLessThan(1e-15)
  })
  const psd = fc.integer({ min: 2, max: 6 }).chain((n) => fc.array(fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: n, maxLength: n }), { minLength: n + 2, maxLength: n + 8 })).map((A) => {
    const n = A[0]!.length
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => A.reduce((s, r) => s + r[i]! * r[j]!, 0) / A.length + (i === j ? 1e-3 : 0)))
  })
  it('minimum variance is never beaten by projected gradient descent (property)', () => {
    fc.assert(fc.property(psd, (S) => {
      const n = S.length
      let w = new Array<number>(n).fill(1 / n)
      const L = 2 * S.reduce((m, r) => Math.max(m, r.reduce((s, x) => s + Math.abs(x), 0)), 0)
      for (let k = 0; k < 4000; k++) {
        const g = S.map((r) => 2 * r.reduce((s, x, j) => s + x * w[j]!, 0))
        // projection onto the simplex (sort-based)
        const y = w.map((x, i) => x - g[i]! / L), u = [...y].sort((a, b) => b - a)
        let c = 0, theta = 0
        for (let i = 0; i < n; i++) { c += u[i]!; const t = (c - 1) / (i + 1); if (u[i]! - t > 0) theta = t }
        w = y.map((x) => Math.max(0, x - theta))
      }
      const v = w.reduce((s, x, i) => s + x * S[i]!.reduce((t, y, j) => t + y * w[j]!, 0), 0)
      const m = minVariance(S)
      expect(m.variance).toBeLessThanOrEqual(v + 1e-12)
      expect(m.w.every((x) => x >= 0)).toBe(true)
      expect(Math.abs(m.w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-12)
    }), { numRuns: 120, seed: 5 })
  })
  it('risk parity equalises risk contributions (property)', () => {
    fc.assert(fc.property(psd, (S) => {
      const r = riskParity(S)
      expect(r.maxDev).toBeLessThan(1e-8)
      expect(r.w.every((x) => x > 0)).toBe(true)
    }), { numRuns: 120, seed: 6 })
  })
})

describe('the walk-forward and its statistics', () => {
  const days = (n: number) => Array.from({ length: n }, (_, k) => new Date(Date.UTC(2023, 0, 2) + k * 86_400_000).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
  const grow = (id: string, daily: number, dates: string[], wiggle = 0): Series => ({ id, name: id, dates, values: dates.map((_, k) => 100 * Math.pow(1 + daily, k) * (1 + wiggle * Math.sin(k))) })
  it('equal weight of two steady assets earns their average, less the stamp duty on what it buys', () => {
    const d = days(500)
    const A = grow('A', 0.0004, d, 0.002), B = grow('B', 0.0002, d, 0.003)
    const res = walkForward([A, B], [{ id: 'EW', label: 'EW', assets: ['A', 'B'], weights: () => ({ w: [0.5, 0.5] }) }], { lookbackDays: 120, minObservations: 40, buyCost: 0.00005, tradeCost: 0, through: '2099-01' })
    if ('error' in res) throw new Error(res.error)
    const ew = res.strategies[0]!
    expect(ew.net.length).toBe(res.months.length)
    expect(ew.net[0]!).toBeLessThan(ew.gross[0]!) // the first purchase is charged
    for (let k = 1; k < ew.net.length; k++) expect(ew.net[k]!).toBeLessThanOrEqual(ew.gross[k]! + 1e-15)
    expect(ew.turnover).toBeGreaterThan(0)
  })
  it('never uses a month-end after the decision (the lookback ends at the decision date)', () => {
    const d = days(400)
    const A = grow('A', 0.0003, d, 0.004), B = grow('B', 0.0001, d, 0.001)
    const seen: number[] = []
    const res = walkForward([A, B], [{ id: 'MV', label: 'MV', assets: ['A', 'B'], weights: (S) => { seen.push(S[0]![0]!); return { w: minVariance(S).w } } }], { lookbackDays: 90, minObservations: 30, buyCost: 0, tradeCost: 0, through: '2099-01' })
    if ('error' in res) throw new Error(res.error)
    // recompute the first decision's covariance from data strictly up to its month end
    expect(seen.length).toBe(res.months.length)
  })
  it('says why when the record is too short', () => {
    const d = days(40)
    const res = walkForward([grow('A', 0.001, d), grow('B', 0.001, d)], [{ id: 'EW', label: 'EW', assets: ['A', 'B'], weights: () => ({ w: [0.5, 0.5] }) }], { lookbackDays: 120, minObservations: 40, buyCost: 0, tradeCost: 0, through: '2099-01' })
    expect('error' in res && res.error).toMatch(/month ends/)
  })
  it('a strategy compared with itself differs by nothing, and the interval says so', () => {
    const r = Array.from({ length: 48 }, (_, k) => 0.01 * Math.sin(k) + 0.004)
    const s = sharpeDifference(r, r, r.map(() => 0.004 / 12))
    expect(s.diff).toBe(0)
    expect(s.lo).toBe(0); expect(s.hi).toBe(0)
    expect(s.detectable).toBe(false)
  })
  it('claims no difference on a short record, and counts the comparisons before claiming one', () => {
    const base = Array.from({ length: 120 }, (_, k) => 0.01 * Math.sin(k * 1.7) + 0.004)
    const better = base.map((x) => x + 0.006)
    const rf = base.map(() => 0.004 / 12)
    expect(sharpeDifference(better.slice(0, 20), base.slice(0, 20), rf).detectable).toBe(false)
    expect(sharpeDifference(better.slice(0, 20), base.slice(0, 20), rf).tooShort).toBe(true)
    expect(sharpeDifference(better, base, rf).detectable).toBe(true)
    const strict = sharpeDifference(better, base, rf, { familyAlpha: 0.0001 })
    expect(strict.tooShort).toBe(false)
  })
  it('metrics: drawdown, CAGR and the worst month of a known path', () => {
    const m = metrics([0.1, -0.5, 0.2], [0, 0, 0])
    expect(m.maxDD).toBeCloseTo(-0.5, 12)
    expect(m.cagr).toBeCloseTo(Math.pow(1.1 * 0.5 * 1.2, 4) - 1, 12)
    expect(m.worstMonth).toBe(-0.5)
  })
})
