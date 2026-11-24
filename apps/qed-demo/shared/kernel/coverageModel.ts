/**
 * The model bound behind a CVaR request (coverage.ts, property 3): historical simulation (hs) or EWMA-filtered historical
 * simulation (fhs_ewma) on the portfolio's own one-period returns, backtested month by month (Kupiec's frequency test,
 * Christoffersen's independence test) and bootstrapped (circular blocks) for a 95% upper confidence bound.
 *
 * Provenance, stated plainly: section 5.1 of the research note says only that a model bound is issued "if Kupiec and
 * Christoffersen both pass and the bootstrap upper bound is within the threshold". The statistics themselves (the window,
 * the EWMA start, the discrete CVaR, the block length, the random draws) are defined only in the Python checker
 * (experiments/r11-portfolio/qpi/guarantee/checker.py, check_cvar, lines 542 to 700), so this file follows that code,
 * and is the one part of the port that does. To agree with it to the last bit, numpy's own arithmetic is reproduced:
 * its pairwise summation, np.var, np.quantile's linear method and its interpolation, and the random stream of
 * np.random.default_rng(seed).integers (SeedSequence, PCG64 XSL-RR, Lemire's bounded integers). The chi-square tail
 * is computed here (the regularised incomplete gamma); it agrees with scipy's to about 1e-15, not bit for bit.
 *
 * A model bound is never a guarantee: nobody stands behind it, and coverage.ts labels it so.
 */
import type { Reason } from './coverage.ts'

// ------------------------------------------------------------------------------------------------ numpy arithmetic
/** numpy's pairwise summation of a float64 run (8 accumulators, blocks of 128): np.sum's exact result. */
export function npSum(a: ArrayLike<number>, off = 0, n = a.length - off): number {
  if (n < 8) { let res = -0; for (let i = 0; i < n; i++) res += a[off + i]!; return res }
  if (n <= 128) {
    const r = [a[off]!, a[off + 1]!, a[off + 2]!, a[off + 3]!, a[off + 4]!, a[off + 5]!, a[off + 6]!, a[off + 7]!]
    let i = 8
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j]! += a[off + i + j]!
    let res = ((r[0]! + r[1]!) + (r[2]! + r[3]!)) + ((r[4]! + r[5]!) + (r[6]! + r[7]!))
    for (; i < n; i++) res += a[off + i]!
    return res
  }
  let n2 = Math.floor(n / 2)
  n2 -= n2 % 8
  return npSum(a, off, n2) + npSum(a, off + n2, n - n2)
}
/** np.var (population): the mean by pairwise sum, then the pairwise sum of squared deviations. */
export function npVar(a: number[]): number {
  const mean = npSum(a) / a.length
  const sq = a.map((x) => { const d = x - mean; return d * d })
  return npSum(sq) / a.length
}
/** np.quantile(a, q) with the default linear method, including numpy's two-sided interpolation. */
export function npQuantile(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).sort()
  const n = s.length
  const v = (n - 1) * q
  if (v >= n - 1) return s[n - 1]!
  if (v < 0) return s[0]!
  const lo = Math.floor(v)
  const g = v - lo
  const x = s[lo]!, y = s[lo + 1]!
  const d = y - x
  return g >= 0.5 ? y - d * (1 - g) : x + d * g
}
/** The discrete CVaR of returns at tail probability `alpha` (the mean of the worst alpha share, with a fractional
 *  last loss): `_hist_cvar` of the Python checker, as a positive loss. */
export function histCVaR(x: ArrayLike<number>, alpha: number): number {
  const L = Float64Array.from(x, (v) => -v).sort().reverse()
  const k = alpha * L.length
  const full = Math.floor(k + 1e-12)
  const v = npSum(L, 0, full) + (full < L.length && k - full > 1e-12 ? (k - full) * L[full]! : 0)
  return v / k
}

// ------------------------------------------------------------------------------------------------ numpy's random stream
const M32 = 0xffffffff
/** numpy SeedSequence(seed).generate_state(words, uint64) for a non-negative integer seed. */
export function seedSequence(seed: number, words64: number): bigint[] {
  const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded, MIX_L = 0xca01f9dd, MIX_R = 0x4973f715
  const entropy: number[] = []
  let s = BigInt(seed)
  do { entropy.push(Number(s & 0xffffffffn)); s >>= 32n } while (s > 0n)
  const pool = [0, 0, 0, 0]
  let hc = INIT_A
  const hashmix = (value: number): number => {
    let v = (value ^ hc) >>> 0
    hc = Math.imul(hc, MULT_A) >>> 0
    v = Math.imul(v, hc) >>> 0
    return (v ^ (v >>> 16)) >>> 0
  }
  const mix = (x: number, y: number): number => { const r = (Math.imul(MIX_L, x) - Math.imul(MIX_R, y)) >>> 0; return (r ^ (r >>> 16)) >>> 0 }
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i]! : 0)
  for (let src = 0; src < 4; src++) for (let dst = 0; dst < 4; dst++) if (src !== dst) pool[dst] = mix(pool[dst]!, hashmix(pool[src]!))
  for (let src = 4; src < entropy.length; src++) for (let dst = 0; dst < 4; dst++) pool[dst] = mix(pool[dst]!, hashmix(entropy[src]!))
  let hb = INIT_B
  const w32: number[] = []
  for (let i = 0; i < words64 * 2; i++) {
    let v = (pool[i % 4]! ^ hb) >>> 0
    hb = Math.imul(hb, MULT_B) >>> 0
    v = Math.imul(v, hb) >>> 0
    w32.push((v ^ (v >>> 16)) >>> 0)
  }
  return Array.from({ length: words64 }, (_, k) => BigInt(w32[2 * k]!) | (BigInt(w32[2 * k + 1]!) << 32n))
}

const M64 = (1n << 64n) - 1n
const M128 = (1n << 128n) - 1n
const PCG_MULT = (2549297995355413924n << 64n) + 4865540595714422341n
/** numpy's PCG64 (XSL-RR 128/64) seeded as np.random.default_rng(seed) seeds it, with its 32-bit buffer. */
export class NumpyPcg64 {
  private state = 0n
  private inc = 0n
  private has32 = false
  private u32 = 0
  constructor(seed: number) {
    const [s0, s1, i0, i1] = seedSequence(seed, 4) as [bigint, bigint, bigint, bigint]
    const initstate = (s0 << 64n) | s1, initseq = (i0 << 64n) | i1
    this.inc = ((initseq << 1n) | 1n) & M128
    this.step()
    this.state = (this.state + initstate) & M128
    this.step()
  }
  private step(): void { this.state = (this.state * PCG_MULT + this.inc) & M128 }
  next64(): bigint {
    this.step()
    const s = this.state
    const x = ((s >> 64n) ^ s) & M64
    const rot = s >> 122n
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & M64
  }
  next32(): number {
    if (this.has32) { this.has32 = false; return this.u32 }
    const n = this.next64()
    this.has32 = true
    this.u32 = Number(n >> 32n)
    return Number(n & 0xffffffffn)
  }
  /** Generator.integers(0, high, size) for 0 < high <= 2^32: Lemire's method on 32-bit draws, as numpy does it. */
  integers(high: number, size: number): number[] {
    const out: number[] = []
    const excl = high, threshold = ((M32 - (high - 1)) >>> 0) % excl
    for (let i = 0; i < size; i++) {
      let m = BigInt(this.next32()) * BigInt(excl)
      let left = Number(m & 0xffffffffn)
      if (left < excl) while (left < threshold) { m = BigInt(this.next32()) * BigInt(excl); left = Number(m & 0xffffffffn) }
      out.push(Number(m >> 32n))
    }
    return out
  }
}

// ------------------------------------------------------------------------------------------------ the chi-square tail
const LN_GAMMA_HALF = 0.5723649429247001 // ln(sqrt(pi))
/** P(chi-square with 1 degree of freedom > x) = Q(1/2, x/2), the regularised upper incomplete gamma. */
export function chi2sf1(x: number): number {
  if (!(x > 0)) return 1
  const a = 0.5, y = x / 2
  const front = Math.exp(-y + a * Math.log(y) - LN_GAMMA_HALF)
  if (y < a + 1) {
    let ap = a, del = 1 / a, sum = del
    for (let n = 0; n < 1000; n++) { ap += 1; del *= y / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-17) break }
    return Math.max(0, 1 - sum * front)
  }
  const tiny = 1e-300
  let b = y + 1 - a, c = 1 / tiny, d = 1 / b, h = d
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-17) break
  }
  return h * front
}

// ------------------------------------------------------------------------------------------------ the model bound
export interface ModelInput { returns: number[]; level: number; window: number; model: 'hs' | 'fhs_ewma'; lambda: number; reps: number; seed: number; source: string }
export interface ModelResult { rejected: boolean; tooShort: boolean; reasons: Reason[]; estimate: number; ucb: number; evidence: Record<string, unknown>; assumptions: string[] }

/** Scenarios for the next period from one window, with its VaR and CVaR (losses as positive fractions). */
function fit(win: number[], alpha: number, model: 'hs' | 'fhs_ewma', lambda: number): { sc: number[]; varLoss: number; cvar: number } {
  let sc = win
  if (model === 'fhs_ewma') {
    let acc = npVar(win.slice(0, 12))
    const sig = new Array<number>(win.length)
    for (let k = 0; k < win.length; k++) { sig[k] = Math.sqrt(acc); acc = lambda * acc + (1 - lambda) * (win[k]! * win[k]!) }
    const next = Math.sqrt(acc)
    sc = win.map((x, k) => (x / sig[k]!) * next)
  }
  return { sc, varLoss: -npQuantile(sc, alpha), cvar: histCVaR(sc, alpha) }
}

const ll = (q: number, a0: number, a1: number): number => { const c = Math.min(Math.max(q, 1e-12), 1 - 1e-12); return a0 * Math.log(1 - c) + a1 * Math.log(c) }
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`
const pct0 = (x: number) => `${Math.round(x * 100)}%`

export function modelBound(m: ModelInput): ModelResult {
  const x = m.returns, W = m.window, alpha = 1 - m.level
  if (x.length < W + 24) return { rejected: true, tooShort: true, reasons: [{ code: 'MODEL_DATA_TOO_SHORT', detail: `${x.length} scenarios; need at least ${W + 24} to fit and backtest` }], estimate: NaN, ucb: NaN, evidence: {}, assumptions: [] }
  const now = fit(x.slice(-W), alpha, m.model, m.lambda)
  const rng = new NumpyPcg64(m.seed)
  const b = Math.max(1, Math.round(Math.pow(W, 1 / 3)))
  const nStarts = Math.ceil(W / b)
  const boots: number[] = []
  const sample = new Array<number>(W)
  for (let r = 0; r < m.reps; r++) {
    const starts = rng.integers(W, nStarts)
    let k = 0
    for (const s of starts) for (let j = 0; j < b && k < W; j++) sample[k++] = now.sc[(s + j) % W]!
    boots.push(histCVaR(sample, alpha))
  }
  const ucb = npQuantile(boots, 0.95)
  const hits: boolean[] = []
  for (let t = W; t < x.length; t++) hits.push(-x[t]! > fit(x.slice(t - W, t), alpha, m.model, m.lambda).varLoss)
  const n = hits.length, k = hits.filter(Boolean).length, ph = k / n
  const pPof = chi2sf1(-2 * (ll(alpha, n - k, k) - ll(ph, n - k, k)))
  let n00 = 0, n01 = 0, n10 = 0, n11 = 0
  for (let t = 1; t < n; t++) { const a = hits[t - 1], c = hits[t]; if (!a && !c) n00++; else if (!a && c) n01++; else if (a && !c) n10++; else n11++ }
  const p01 = n01 / Math.max(n00 + n01, 1), p11 = n11 / Math.max(n10 + n11, 1), p1 = (n01 + n11) / Math.max(n00 + n01 + n10 + n11, 1)
  const pInd = chi2sf1(-2 * (ll(p1, n00 + n10, n01 + n11) - (ll(p01, n00, n01) + ll(p11, n10, n11))))
  const reasons: Reason[] = []
  if (pPof < 0.05) reasons.push({ code: 'MODEL_REJECTED_BY_BACKTEST', detail: `the ${m.model} VaR was exceeded in ${pct1(ph)} of ${n} months (expected ${pct0(alpha)}; Kupiec p = ${pPof.toFixed(3)}), so its CVaR bound is not credible` })
  if (pInd < 0.05) reasons.push({ code: 'MODEL_REJECTED_BY_BACKTEST', detail: `the ${m.model} VaR exceedances cluster: after an exceedance the next month exceeded with probability ${pct0(p11)} against ${pct0(p01)} otherwise (Christoffersen p = ${pInd.toFixed(3)}); the bound fails exactly in sequences of bad months` })
  return {
    rejected: reasons.length > 0, tooShort: false, reasons, estimate: now.cvar, ucb,
    evidence: {
      model: m.model, months_backtested: n, var_exceedances: k, exceedance_rate: ph, expected_rate: alpha, kupiec_p: pPof,
      p_exceed_after_exceed: p11, p_exceed_after_calm: p01, christoffersen_p: pInd, var_estimate: now.varLoss, cvar_estimate: now.cvar,
      cvar_ucb95: ucb, block: b, bootstrap_reps: m.reps, seed: m.seed, source: m.source,
    },
    assumptions: [
      `future one-period returns resemble the last ${W} periods of ${m.source}${m.model === 'fhs_ewma' ? ' after rescaling by current EWMA volatility' : ''}`,
      'a circular block bootstrap captures the estimation error of the CVaR',
      'holdings stay as declared over the horizon',
    ],
  }
}
