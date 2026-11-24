/**
 * Certifying solver for the long-only minimum-variance portfolio.
 *
 *     minimise ½·wᵀΣw   s.t.   1ᵀw = 1,  w ≥ 0
 *
 * A *certifying algorithm* (McConnell, Mehlhorn, Näher & Schweitzer, 2011) returns not just an
 * answer but a witness that a tiny, trusted checker can validate. Here the witness is the KKT
 * multiplier pair (ν, μ) plus a Cholesky factor L proving convexity. The trusted checker is the
 * MinVarianceVerifier smart contract. This file is the untrusted, expensive side.
 *
 * Method: exact support enumeration. For a support set S, the KKT system restricted to S is
 *     Σ_SS w_S = ν·1,  1ᵀw_S = 1   ⇒   w_S = Σ_SS⁻¹1 / (1ᵀΣ_SS⁻¹1),  ν = 1 / (1ᵀΣ_SS⁻¹1)
 * and S is optimal iff w_S ≥ 0 and μ_i = (Σw)_i − ν ≥ 0 for every i ∉ S. For n ≤ 14 we simply
 * enumerate all 2ⁿ−1 supports (≤ 16k tiny solves, milliseconds). Σ ≻ 0 ⇒ the KKT point is unique.
 */

export const WAD = 10n ** 18n;

export interface MinVarSpec {
  n: number;
  cov: bigint[]; // n×n row-major, WAD
  tol: bigint; // WAD
  universe: `0x${string}`; // bytes32 tag of the asset universe / risk model
}

export interface MinVarSolution {
  w: bigint[];
  nu: bigint;
  mu: bigint[];
  L: bigint[]; // packed lower-triangular, row-major
}

export interface CertificateReport {
  ok: boolean;
  sumW: bigint;
  maxStationarityResidual: bigint; // WAD
  dualityGap: bigint; // WAD
  maxPsdResidual: bigint; // WAD
  variance: bigint; // WAD, wᵀΣw
  violations: string[];
  optimalityBound: number; // (2n+3+|ν|)·τ  — see docs/ALGORITHMS.md §4
}

// ───────────────────────────────── floating-point linear algebra ─────────────────────────────────

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function cholesky(S: number[][]): number[][] {
  const n = S.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = S[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error(`covariance is not positive definite (pivot ${i})`);
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Exact optimum (floating point) by support enumeration. */
export function solveFloat(S: number[][]): { w: number[]; nu: number; support: number[] } {
  const n = S.length;
  if (n > 14) throw new Error("support enumeration limited to n ≤ 14");
  let best: { w: number[]; nu: number; support: number[]; f: number } | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const sub = idx.map((i) => idx.map((j) => S[i][j]));
    const x = solveLinear(sub, idx.map(() => 1));
    if (!x) continue;
    const s = x.reduce((a, b) => a + b, 0);
    if (!(s > 0)) continue;
    const wS = x.map((v) => v / s);
    if (wS.some((v) => v < -1e-12)) continue;
    const nu = 1 / s;
    const w = new Array(n).fill(0);
    idx.forEach((i, k) => (w[i] = Math.max(0, wS[k])));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (mask & (1 << i)) continue;
      let g = 0;
      for (let j = 0; j < n; j++) g += S[i][j] * w[j];
      if (g - nu < -1e-12) ok = false; // μ_i would be negative ⇒ not KKT
    }
    if (!ok) continue;
    let f = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) f += w[i] * S[i][j] * w[j];
    if (!best || f < best.f - 1e-15) best = { w, nu, support: idx, f };
  }
  if (!best) throw new Error("no KKT point found (is Σ positive definite?)");
  return best;
}

// ───────────────────────────────── fixed-point certificate ─────────────────────────────────

const toWad = (x: number): bigint => {
  // Round-half-away using string arithmetic to avoid float→bigint precision loss on large values.
  const scaled = x * 1e18;
  return BigInt(Math.round(scaled));
};

export const wadToNumber = (x: bigint): number => Number(x) / 1e18;

export function covToWad(S: number[][]): bigint[] {
  const n = S.length;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(toWad(i <= j ? S[i][j] : S[j][i]));
  return out;
}

export function covFromWad(n: number, cov: bigint[]): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => wadToNumber(cov[i * n + j])));
}

/** Produce a solution + certificate that satisfies the on-chain checker exactly. */
export function certify(spec: MinVarSpec): MinVarSolution & { support: number[] } {
  const { n, cov } = spec;
  const S = covFromWad(n, cov);
  const { w: wf, support } = solveFloat(S);

  // 1. weights in WAD, exact budget (absorb rounding into the largest weight)
  const w = wf.map(toWad).map((v) => (v < 0n ? 0n : v));
  const sum = w.reduce((a, b) => a + b, 0n);
  let iMax = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[iMax]) iMax = i;
  w[iMax] += WAD - sum;
  const inSupport = new Set(support);
  for (let i = 0; i < n; i++) if (!inSupport.has(i)) w[i] = 0n;
  const sum2 = w.reduce((a, b) => a + b, 0n);
  w[iMax] += WAD - sum2;

  // 2. exact gradient g = Σw at 1e36 scale
  const g = gradient(n, cov, w);

  // 3. ν = average gradient over the support (exact rounding), μ = (g − ν) off-support
  let acc = 0n;
  for (const i of support) acc += g[i];
  const nu = divRound(acc, BigInt(support.length) * WAD);
  const mu = g.map((gi, i) => (inSupport.has(i) ? 0n : maxBig(0n, divRound(gi, WAD) - nu)));

  // 4. convexity witness: Cholesky factor of Σ in WAD
  const Lf = cholesky(S);
  const L: bigint[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) L.push(toWad(Lf[i][j]));

  return { w, nu, mu, L, support };
}

/** Bit-exact re-implementation of MinVarianceVerifier.verify (used for pre-flight and tests). */
export function checkCertificate(spec: MinVarSpec, sol: MinVarSolution): CertificateReport {
  const { n, cov, tol } = spec;
  const { w, nu, mu, L } = sol;
  const violations: string[] = [];
  const tolHi = tol * WAD;

  for (let i = 0; i < n; i++) {
    if (cov[i * n + i] <= 0n) violations.push(`NonPositiveVariance(${i})`);
    for (let j = i + 1; j < n; j++) if (cov[i * n + j] !== cov[j * n + i]) violations.push(`CovarianceNotSymmetric(${i},${j})`);
  }
  let sumW = 0n;
  for (let i = 0; i < n; i++) {
    if (w[i] < 0n) violations.push(`NegativeWeight(${i})`);
    sumW += w[i];
  }
  if (absBig(sumW - WAD) > tol) violations.push(`BudgetViolated(${sumW})`);

  const g = gradient(n, cov, w);
  let gap = 0n;
  let quad = 0n;
  let maxRes = 0n;
  for (let i = 0; i < n; i++) {
    if (mu[i] < 0n) violations.push(`NegativeMultiplier(${i})`);
    const r = g[i] - (nu + mu[i]) * WAD;
    if (absBig(r) > maxRes) maxRes = absBig(r);
    if (absBig(r) > tolHi) violations.push(`StationarityViolated(${i}, ${r / WAD})`);
    gap += w[i] * mu[i];
    quad += w[i] * g[i];
  }
  if (gap > tolHi) violations.push(`DualityGapTooLarge(${gap / WAD})`);

  let maxPsd = 0n;
  for (let i = 0; i < n; i++) {
    const ri = (i * (i + 1)) / 2;
    for (let j = 0; j <= i; j++) {
      const rj = (j * (j + 1)) / 2;
      let p = 0n;
      for (let k = 0; k <= j; k++) p += L[ri + k] * L[rj + k];
      const r = cov[i * n + j] * WAD - p;
      if (absBig(r) > maxPsd) maxPsd = absBig(r);
      if (absBig(r) > tolHi) violations.push(`NotPositiveSemidefinite(${i},${j})`);
    }
  }

  const tau = wadToNumber(tol);
  return {
    ok: violations.length === 0,
    sumW,
    maxStationarityResidual: maxRes / WAD,
    dualityGap: gap / WAD,
    maxPsdResidual: maxPsd / WAD,
    variance: quad / (WAD * WAD),
    violations,
    optimalityBound: (2 * n + 3 + Math.abs(wadToNumber(nu))) * tau,
  };
}

export function gradient(n: number, cov: bigint[], w: bigint[]): bigint[] {
  const g: bigint[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0n;
    for (let j = 0; j < n; j++) s += cov[i * n + j] * w[j];
    g.push(s);
  }
  return g;
}

// ───────────────────────────────── "lazy AI" counterfeit certificates (for adversarial tests) ─────────────────────────────────

/**
 * The 1/N portfolio dressed up with the most convincing multipliers possible:
 * ν = min_i (Σw)_i, μ_i = (Σw)_i − ν ≥ 0. Stationarity and dual feasibility then hold EXACTLY,
 * so the forgery fails only on complementary slackness — and the revert reports the duality gap,
 * which upper-bounds how far from optimal the forged portfolio is.
 */
export function counterfeitEqualWeight(spec: MinVarSpec): MinVarSolution {
  const { n, cov } = spec;
  const w = Array.from({ length: n }, () => WAD / BigInt(n));
  w[0] += WAD - w.reduce((a, b) => a + b, 0n);
  const g = gradient(n, cov, w).map((x) => divRound(x, WAD));
  const nu = g.reduce((a, b) => (b < a ? b : a));
  const mu = g.map((x) => x - nu);
  const honest = certify(spec);
  return { w, nu, mu, L: honest.L };
}

/** The true optimum nudged by `bps` basis points between two assets — "almost right" is still wrong. */
export function counterfeitNudged(spec: MinVarSpec, bps: bigint): MinVarSolution & { support: number[] } {
  const honest = certify(spec);
  const w = [...honest.w];
  const sorted = w.map((v, i) => [v, i] as const).sort((a, b) => (a[0] > b[0] ? -1 : 1));
  const [, hi] = sorted[0];
  const [, lo] = sorted[1];
  const delta = (WAD * bps) / 10_000n;
  w[hi] -= delta;
  w[lo] += delta;
  return { ...honest, w };
}

// ───────────────────────────────── helpers ─────────────────────────────────

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}
function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
/** Round-half-away-from-zero integer division. */
export function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (2n * (r < 0n ? -r : r) >= (b < 0n ? -b : b)) return q + ((a < 0n) !== (b < 0n) ? -1n : 1n);
  return q;
}
