/**
 * Portfolio arithmetic for the Portfolio lab (R12): covariance shrinkage, two competent baselines that need no
 * forecast of returns (minimum variance, risk parity), a walk-forward backtest with drift, turnover and costs, and the
 * statistics to compare strategies honestly (net Sharpe against equal weight, with a block-bootstrap interval and the
 * smallest difference the data could have detected). Pure functions; the server feeds them the app's own recorded
 * NAVs (server/lab.ts), and portfolio.test.ts checks each against an independent computation.
 *
 * Every optimum is checkable: minimum variance is found exactly by enumerating supports and carries its KKT residual
 * and Frank-Wolfe duality gap; risk parity carries the largest deviation of a risk contribution from equal. These
 * certify the optimisation for its model, never a future return (the R11 study found no optimiser beat 1/N net of
 * costs over 1972-2026; docs/research/qed-quant-finance/20261124-portfolio-intelligence.md section 4.1).
 */

export type Matrix = number[][]

const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0)
const mul = (S: Matrix, w: number[]): number[] => S.map((row) => dot(row, w))
const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0)

/** Ledoit and Wolf (2004): the sample covariance shrunk toward a scaled identity, with the optimal intensity. Rows of
 *  X are observations, columns assets. The mean is removed first. */
export function ledoitWolf(X: number[][]): { S: Matrix; shrinkage: number; sample: Matrix } {
  const T = X.length, N = X[0]?.length ?? 0
  if (T < 2 || N < 1) throw new Error('ledoitWolf needs at least two observations')
  const mean = Array.from({ length: N }, (_, j) => sum(X.map((r) => r[j]!)) / T)
  const Y = X.map((r) => r.map((x, j) => x - mean[j]!))
  const S: Matrix = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => sum(Y.map((r) => r[i]! * r[j]!)) / T))
  const m = sum(S.map((r, i) => r[i]!)) / N
  let d2 = 0
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d2 += (S[i]![j]! - (i === j ? m : 0)) ** 2
  d2 /= N
  let b2 = 0
  for (const r of Y) { let s = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) s += (r[i]! * r[j]! - S[i]![j]!) ** 2; b2 += s / N }
  b2 = Math.min(b2 / (T * T), d2)
  const delta = d2 > 0 ? b2 / d2 : 1
  return { S: S.map((r, i) => r.map((x, j) => delta * (i === j ? m : 0) + (1 - delta) * x)), shrinkage: delta, sample: S }
}

/** Solve A x = b by Gaussian elimination with partial pivoting; null when A is (numerically) singular. */
export function solve(A: Matrix, b: number[]): number[] | null {
  const n = A.length
  const M = A.map((r, i) => [...r, b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r
    if (Math.abs(M[p]![c]!) < 1e-300) return null
    ;[M[c], M[p]] = [M[p]!, M[c]!]
    for (let r = c + 1; r < n; r++) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]! }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) { let s = M[r]![n]!; for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!; x[r] = s / M[r]![r]! }
  return x.every(Number.isFinite) ? x : null
}

export interface Certified { w: number[]; variance: number; kkt: number; gap: number }
/**
 * Long-only minimum variance, exactly: for every support, the minimum on that face (Sigma_SS x = 1, normalised); the
 * least variance among the faces whose solution is non-negative is the global minimum, since the problem is convex.
 * KKT residual: how far the gradient fails to be equal on the support and no smaller off it. Gap: the Frank-Wolfe
 * duality gap, an upper bound on variance(w) - optimum. For up to about 12 assets.
 */
export function minVariance(S: Matrix): Certified {
  const N = S.length
  if (N > 12) throw new Error('minVariance enumerates supports: at most 12 assets')
  let best: { w: number[]; v: number } | null = null
  for (let mask = 1; mask < 1 << N; mask++) {
    const idx = [...Array(N).keys()].filter((i) => mask & (1 << i))
    const x = solve(idx.map((i) => idx.map((j) => S[i]![j]!)), idx.map(() => 1))
    if (!x) continue
    const t = sum(x)
    if (!(t > 0) || x.some((v) => v / t < -1e-12)) continue
    const w = new Array<number>(N).fill(0)
    idx.forEach((i, k) => { w[i] = Math.max(0, x[k]! / t) })
    const s = sum(w); for (let i = 0; i < N; i++) w[i] = w[i]! / s
    const v = dot(w, mul(S, w))
    if (!best || v < best.v - 1e-18) best = { w, v }
  }
  if (!best) throw new Error('no feasible face: the covariance is not positive semidefinite')
  return { w: best.w, variance: best.v, ...certificate(S, best.w) }
}
function certificate(S: Matrix, w: number[]): { kkt: number; gap: number } {
  const g = mul(S, w)
  const on = w.map((x) => x > 1e-12)
  const lambda = dot(w, g)
  let kkt = 0
  g.forEach((gi, i) => { kkt = Math.max(kkt, on[i] ? Math.abs(gi - lambda) : Math.max(0, lambda - gi)) })
  const gap = 2 * (lambda - Math.min(...g))
  return { kkt: kkt / Math.max(Math.abs(lambda), 1e-300), gap }
}

/**
 * Equal risk contribution (risk parity) by cyclical coordinate descent on Spinu's convex problem
 * min 1/2 y'Sy - (1/N) sum ln y (Griveau-Billion, Richard and Roncalli 2013), then w = y / sum y. maxDev: the largest
 * relative deviation of a risk contribution from 1/N of the total (the certificate; 0 at the exact solution).
 */
export function riskParity(S: Matrix, tol = 1e-13): { w: number[]; maxDev: number; sweeps: number } {
  const N = S.length, b = 1 / N
  const y = S.map((r, i) => 1 / Math.sqrt(r[i]!))
  let sweeps = 0
  for (; sweeps < 20_000; sweeps++) {
    let change = 0
    for (let i = 0; i < N; i++) {
      const c = dot(S[i]!, y) - S[i]![i]! * y[i]!
      const next = (-c + Math.sqrt(c * c + 4 * S[i]![i]! * b)) / (2 * S[i]![i]!)
      change = Math.max(change, Math.abs(next - y[i]!) / Math.max(y[i]!, 1e-300))
      y[i] = next
    }
    if (change < tol) break
  }
  const t = sum(y), w = y.map((v) => v / t)
  const g = mul(S, w), total = dot(w, g)
  const maxDev = Math.max(...w.map((wi, i) => Math.abs((wi * g[i]!) / total - b) / b))
  return { w, maxDev, sweeps }
}

// ------------------------------------------------------------------------------------------------ statistics
/** A seeded generator (mulberry32): the bootstrap is reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
}
const mean = (a: number[]): number => sum(a) / a.length
const sd = (a: number[]): number => { const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)) }
export const annualSharpe = (excess: number[]): number => (excess.length > 1 && sd(excess) > 0 ? (mean(excess) / sd(excess)) * Math.sqrt(12) : NaN)

export interface Metrics { months: number; cagr: number; vol: number; sharpe: number; maxDD: number; worstMonth: number; cvar95: number }
/** Monthly net returns, and the risk-free proxy's returns for the same months (excess for the Sharpe ratio). */
export function metrics(r: number[], rf: number[]): Metrics {
  let v = 1, peak = 1, dd = 0
  for (const x of r) { v *= 1 + x; peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1) }
  const losses = r.map((x) => -x).sort((a, b) => b - a)
  const k = Math.max(1, Math.round(0.05 * r.length))
  return {
    months: r.length, cagr: Math.pow(v, 12 / r.length) - 1, vol: sd(r) * Math.sqrt(12), sharpe: annualSharpe(r.map((x, i) => x - (rf[i] ?? 0))),
    maxDD: dd, worstMonth: Math.min(...r), cvar95: mean(losses.slice(0, k)),
  }
}

/**
 * The annualised Sharpe difference of `a` over `b` (same months), with a circular block bootstrap of the paired months:
 * a 95% percentile interval, its standard error, and the minimum detectable difference at 5% two-sided with 80% power
 * (about 2.8 standard errors). A short record cannot tell strategies apart; this says by how much it could have.
 * "Detectable" is claimed only with at least `minMonths` months (36: a percentile bootstrap of a Sharpe ratio on fewer
 * understates its uncertainty) and only when the interval at `familyAlpha` (the caller divides 5% by the number of
 * strategies compared, Bonferroni) excludes zero, so comparing several strategies does not manufacture a finding.
 */
export function sharpeDifference(a: number[], b: number[], rf: number[], opts: { reps?: number; block?: number; seed?: number; familyAlpha?: number; minMonths?: number } = {}): { diff: number; lo: number; hi: number; se: number; mde: number; detectable: boolean; tooShort: boolean } {
  const n = a.length, reps = opts.reps ?? 2000, block = Math.max(1, Math.min(opts.block ?? 3, n)), rnd = prng(opts.seed ?? 20261124)
  const ex = (x: number[], idx: number[]) => idx.map((i) => x[i]! - (rf[i] ?? 0))
  const all = [...Array(n).keys()]
  const diff = annualSharpe(ex(a, all)) - annualSharpe(ex(b, all))
  const d: number[] = []
  for (let r = 0; r < reps; r++) {
    const idx: number[] = []
    while (idx.length < n) { const s = Math.floor(rnd() * n); for (let j = 0; j < block && idx.length < n; j++) idx.push((s + j) % n) }
    const x = annualSharpe(ex(a, idx)) - annualSharpe(ex(b, idx))
    if (Number.isFinite(x)) d.push(x)
  }
  d.sort((x, y) => x - y)
  const q = (p: number) => d[Math.min(d.length - 1, Math.max(0, Math.floor(p * (d.length - 1))))] ?? NaN
  const se = d.length > 1 ? sd(d) : NaN
  const fa = opts.familyAlpha ?? 0.05, tooShort = n < (opts.minMonths ?? 36)
  return { diff, lo: q(0.025), hi: q(0.975), se, mde: 2.8 * se, tooShort, detectable: !tooShort && (q(fa / 2) > 0 || q(1 - fa / 2) < 0) }
}

// ------------------------------------------------------------------------------------------------ the walk-forward
export interface Series { id: string; name: string; dates: string[]; values: number[] }
export interface Strategy { id: string; label: string; assets: string[]; weights: (S: Matrix) => { w: number[]; cert?: Record<string, number> } }
export interface BacktestResult {
  months: string[]; lookbackDays: number; observations: number; universe: string[]
  strategies: { id: string; label: string; assets: string[]; net: number[]; gross: number[]; turnover: number; costDrag: number; metrics: Metrics; path: number[]; cert: Record<string, number>; weightsLast: Record<string, number> }[]
  rf: number[]; rfLabel: string
}

/** The last value of each calendar month (YYYY-MM) a series has, and the date it came from. */
export function monthEnds(s: Series): Map<string, { date: string; value: number }> {
  const out = new Map<string, { date: string; value: number }>()
  s.dates.forEach((d, i) => { out.set(d.slice(0, 7), { date: d, value: s.values[i]! }) })
  return out
}

/**
 * Decide at each month end from the trailing `lookbackDays` of daily returns (dates every asset shares) and hold for
 * the next month, the weights drifting with prices; at the next month end trade back to the new weights. Costs: a
 * proportional charge on purchases (`buyCost`, e.g. stamp duty) and on all trades (`tradeCost`, e.g. a spread);
 * the first purchase is charged. Out of sample by construction: nothing after a month end informs that month's weights.
 */
export function walkForward(series: Series[], strategies: Strategy[], opts: { lookbackDays: number; minObservations: number; buyCost: number; tradeCost: number; through: string; rf?: Series | null }): BacktestResult | { error: string } {
  const ids = [...new Set(strategies.flatMap((s) => s.assets))]
  const by = new Map(series.map((s) => [s.id, s]))
  if (ids.some((id) => !by.has(id))) return { error: `no recorded values for ${ids.filter((id) => !by.has(id)).join(', ')}` }
  const ends = new Map(ids.map((id) => [id, monthEnds(by.get(id)!)]))
  // complete months every asset has (the month in progress is left out)
  const months = [...ends.get(ids[0]!)!.keys()].filter((m) => m < opts.through && ids.every((id) => ends.get(id)!.has(m))).sort()
  // daily returns on the dates every asset shares
  const dateSets = ids.map((id) => new Map(by.get(id)!.dates.map((d, i) => [d, by.get(id)!.values[i]!])))
  const common = [...dateSets[0]!.keys()].filter((d) => dateSets.every((m) => m.has(d))).sort()
  const daily: { date: string; r: number[] }[] = []
  for (let k = 1; k < common.length; k++) daily.push({ date: common[k]!, r: ids.map((_, j) => dateSets[j]!.get(common[k]!)! / dateSets[j]!.get(common[k - 1]!)! - 1) })
  const DAY = 86_400_000
  const decisions: { month: string; S: Matrix }[] = []
  for (const m of months) {
    const end = ends.get(ids[0]!)!.get(m)!.date
    const from = new Date(Date.parse(`${end}T00:00:00Z`) - opts.lookbackDays * DAY).toISOString().slice(0, 10)
    const rows = daily.filter((x) => x.date > from && x.date <= end).map((x) => x.r)
    if (rows.length >= opts.minObservations) decisions.push({ month: m, S: ledoitWolf(rows).S })
  }
  if (decisions.length < 3) return { error: `only ${decisions.length} month ends have ${opts.minObservations} or more shared daily values before them; at least 3 are needed` }
  const held = decisions.slice(0, -1).map((d, k) => ({ decide: d, month: decisions[k + 1]!.month }))
  const monthlyReturn = (id: string, from: string, to: string) => ends.get(id)!.get(to)!.value / ends.get(id)!.get(from)!.value - 1
  // the risk-free proxy: the liquid fund's own month, where it has one; else zero (said in rfLabel)
  const rfEnds = opts.rf ? monthEnds(opts.rf) : null
  const rf = held.map((h) => (rfEnds?.has(h.decide.month) && rfEnds.has(h.month) ? rfEnds.get(h.month)!.value / rfEnds.get(h.decide.month)!.value - 1 : 0))
  const out: BacktestResult['strategies'] = []
  for (const st of strategies) {
    const idx = st.assets.map((a) => ids.indexOf(a))
    let prev: number[] | null = null
    const net: number[] = [], gross: number[] = []
    let turnSum = 0, costSum = 0
    const cert: Record<string, number> = {}
    let last: number[] = []
    for (const h of held) {
      const sub = idx.map((i) => idx.map((j) => h.decide.S[i]![j]!))
      const { w, cert: c } = st.weights(sub)
      for (const [k, v] of Object.entries(c ?? {})) cert[k] = Math.max(cert[k] ?? 0, v)
      const R = st.assets.map((a) => monthlyReturn(a, h.decide.month, h.month))
      const buys = prev ? sum(w.map((x, i) => Math.max(0, x - prev![i]!))) : sum(w)
      const turnover = prev ? sum(w.map((x, i) => Math.abs(x - prev![i]!))) : sum(w)
      const cost = opts.buyCost * buys + opts.tradeCost * turnover
      const g = dot(w, R)
      gross.push(g); net.push((1 - cost) * (1 + g) - 1)
      turnSum += turnover; costSum += cost
      prev = w.map((x, i) => (x * (1 + R[i]!)) / (1 + g)) // drifted to the next month end
      last = w
    }
    const path: number[] = []
    let v = 1
    for (const x of net) { v *= 1 + x; path.push(v) }
    out.push({ id: st.id, label: st.label, assets: st.assets, net, gross, turnover: turnSum / net.length, costDrag: (costSum / net.length) * 12, metrics: metrics(net, rf), path, cert, weightsLast: Object.fromEntries(st.assets.map((a, i) => [a, last[i]!])) })
  }
  return { months: held.map((h) => h.month), lookbackDays: opts.lookbackDays, observations: daily.length, universe: ids, strategies: out, rf, rfLabel: opts.rf && rfEnds ? opts.rf.name : 'zero (no risk-free series recorded)' }
}
