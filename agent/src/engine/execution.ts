/**
 * Best execution with a proof — the off-chain, untrusted side of QEDExecution.
 *
 * Problem. Spend at most A of token s through a set of constant-product venues (any split, any number
 * of hops) to maximise the amount of token t received, ending with no deficit in any other token:
 *
 *   maximise Ψ_t   s.t.   Ψ_s ≥ −A,   Ψ_k ≥ 0 (k ∉ {s,t}),   Δ_i ∈ T_i (each venue's trade set),   Ψ = Σ_i Δ_i
 *
 * Dual. For prices ν ≥ 0 with ν_t = 1, weak duality gives OPT ≤ B(ν) = ν_s·A + Σ_i h_i(ν), where h_i is
 * the value of venue i's best trade at prices ν. For a constant-product venue with reserves (R_a, R_b)
 * and fee 1 − γ the best trade selling a for b has the closed form
 *
 *   h_{a→b}(ν) = ( √(ν_b R_b) − √(ν_a R_a / γ) )₊²       (attained at R_a + γx = √(γ R_a R_b ν_b / ν_a))
 *
 * B is convex in ν and, the routing problem being convex (Angeris, Chitra, Evans, Boyd 2022), strong
 * duality holds: min_ν B(ν) = OPT. ∂B/∂ν_k is the net flow of token k at the venues' best trades
 * (envelope theorem), so the minimiser is exactly the price vector at which the venues' best trades
 * spend A of s and balance every intermediate token: the optimal route can be read off it.
 *
 * This module (1) minimises B by exact coordinate descent, (2) recovers and orders the route,
 * (3) simulates it with the venues' exact integer arithmetic, and (4) recomputes the on-chain bound
 * bit-for-bit, so the agent knows before sending that the chain will accept.
 */
import type { Address } from "viem";

export const PRICE_ONE = 10n ** 36n;
export const PPM = 1_000_000n;

export interface Venue {
  pool: Address;
  token0: Address;
  token1: Address;
  feeBps: number;
}
export interface VenueState extends Venue {
  r0: bigint;
  r1: bigint;
}
/** `amountIn === 0n` spends everything this trade has received of the input token so far. */
export interface Hop {
  venue: number;
  zeroForOne: boolean;
  amountIn: bigint;
}
export type Prices = Map<string, bigint>; // lower-cased token address → ν × PRICE_ONE

const key = (a: string) => a.toLowerCase();

// ───────────────────────────── exact integer replicas of the contracts ─────────────────────────────

/** Uniswap V2 getAmountOut with a fee in basis points (CPMMPool / QEDExecution._swap). */
export function amountOut(amountIn: bigint, rIn: bigint, rOut: bigint, feeBps: number): bigint {
  const inWithFee = amountIn * BigInt(10_000 - feeBps);
  return (inWithFee * rOut) / (rIn * 10_000n + inWithFee);
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  // integer Newton iteration started strictly above the root (float estimate + margin) converges to ⌊√n⌋
  let x = BigInt(Math.ceil(Math.sqrt(Number(n)) * (1 + 1e-9))) + 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
const ceilSqrt = (n: bigint) => {
  const r = isqrt(n);
  return r * r === n ? r : r + 1n;
};

/** QEDExecution._venueValue: (√wBuy − √(wSell/γ))₊², rounded up. */
export function venueValue(wBuy: bigint, wSell: bigint, feeBps: number): bigint {
  const s = ceilSqrt(wBuy);
  const t = isqrt((wSell * 10_000n) / BigInt(10_000 - feeBps));
  return s > t ? (s - t) * (s - t) : 0n;
}

/** QEDExecution._dualBound, bit for bit. */
export function dualBound(venues: VenueState[], amountIn: bigint, tokenIn: Address, tokenOut: Address, prices: Prices): bigint {
  const p = (t: string) => prices.get(key(t)) ?? 0n;
  if (p(tokenOut) !== PRICE_ONE) throw new Error("BadNormalization");
  let acc = p(tokenIn) * amountIn;
  for (const v of venues) {
    const w0 = p(v.token0) * v.r0;
    const w1 = p(v.token1) * v.r1;
    acc += venueValue(w1, w0, v.feeBps) + venueValue(w0, w1, v.feeBps);
  }
  return (acc + PRICE_ONE - 1n) / PRICE_ONE;
}

export interface Simulation {
  ok: boolean;
  error?: string;
  amountOut: bigint;
  spent: bigint;
  leftovers: Map<string, bigint>;
  venuesAfter: VenueState[];
  perHop: { venue: number; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint }[];
}

/** Executes a route exactly as QEDExecution would (same integer maths, same order). */
export function simulate(venues: VenueState[], route: Hop[], tokenIn: Address, tokenOut: Address, amountIn: bigint): Simulation {
  const vs = venues.map((v) => ({ ...v }));
  const bal = new Map<string, bigint>([[key(tokenIn), amountIn]]);
  const get = (t: string) => bal.get(key(t)) ?? 0n;
  const perHop: Simulation["perHop"] = [];
  for (const [i, h] of route.entries()) {
    const v = vs[h.venue];
    if (!v) return fail(`UnknownVenue(${h.venue})`);
    const [tIn, tOut] = h.zeroForOne ? [v.token0, v.token1] : [v.token1, v.token0];
    const a = h.amountIn === 0n ? get(tIn) : h.amountIn;
    if (a > get(tIn)) return fail(`hop ${i}: insufficient ${tIn}`);
    const [rIn, rOut] = h.zeroForOne ? [v.r0, v.r1] : [v.r1, v.r0];
    const out = amountOut(a, rIn, rOut, v.feeBps);
    if (out === 0n) return fail(`ZeroOutputHop(${i})`);
    if (out >= rOut) return fail(`hop ${i}: InsufficientLiquidity`);
    bal.set(key(tIn), get(tIn) - a);
    bal.set(key(tOut), get(tOut) + out);
    if (h.zeroForOne) {
      v.r0 += a;
      v.r1 -= out;
    } else {
      v.r1 += a;
      v.r0 -= out;
    }
    perHop.push({ venue: h.venue, tokenIn: tIn, tokenOut: tOut, amountIn: a, amountOut: out });
  }
  const leftovers = new Map<string, bigint>();
  for (const [t, b] of bal) if (t !== key(tokenIn) && t !== key(tokenOut) && b !== 0n) leftovers.set(t, b);
  return { ok: leftovers.size === 0, error: leftovers.size ? "Leftover" : undefined, amountOut: get(tokenOut), spent: amountIn - get(tokenIn), leftovers, venuesAfter: vs, perHop };

  function fail(error: string): Simulation {
    return { ok: false, error, amountOut: 0n, spent: 0n, leftovers: new Map(), venuesAfter: vs, perHop };
  }
}

// ───────────────────────────── the solver (floating point; checked exactly afterwards) ─────────────────────────────

interface FVenue {
  a: string; // token0
  b: string; // token1
  R0: number;
  R1: number;
  g: number; // γ
}

/** Best trade of one venue at prices (n0, n1): net flows (d0, d1) and value. */
function venueBest(v: FVenue, n0: number, n1: number): { d0: number; d1: number; value: number } {
  // sell token0 for token1
  if (n0 > 0 && n1 * v.R1 > (n0 * v.R0) / v.g) {
    const u = Math.sqrt((v.g * v.R0 * v.R1 * n1) / n0);
    const x = (u - v.R0) / v.g;
    const out = v.R1 - (v.R0 * v.R1) / u;
    return { d0: -x, d1: out, value: (Math.sqrt(n1 * v.R1) - Math.sqrt((n0 * v.R0) / v.g)) ** 2 };
  }
  if (n1 > 0 && n0 * v.R0 > (n1 * v.R1) / v.g) {
    const u = Math.sqrt((v.g * v.R1 * v.R0 * n0) / n1);
    const x = (u - v.R1) / v.g;
    const out = v.R0 - (v.R1 * v.R0) / u;
    return { d0: out, d1: -x, value: (Math.sqrt(n0 * v.R0) - Math.sqrt((n1 * v.R1) / v.g)) ** 2 };
  }
  if (n0 === 0 && n1 > 0) return { d0: -Infinity, d1: v.R1, value: n1 * v.R1 };
  if (n1 === 0 && n0 > 0) return { d0: v.R0, d1: -Infinity, value: n0 * v.R0 };
  return { d0: 0, d1: 0, value: 0 };
}

export interface Plan {
  prices: Prices; // fixed-point ν, ready for the chain
  nu: Record<string, number>; // floating ν, for explanation
  route: Hop[];
  sim: Simulation;
  bound: bigint;
  gapPpm: number; // (bound − realised) / bound, in ppm
  optimalTrades: { venue: number; zeroForOne: boolean; amountIn: number; amountOut: number }[];
  iterations: number;
}

/**
 * Minimises B(ν) by exact coordinate descent (each coordinate: bisection in log-space on ∂B/∂ν_k,
 * which is increasing in ν_k because B is convex), then recovers the route.
 */
export function solve(venues: VenueState[], tokenIn: Address, tokenOut: Address, amountIn: bigint, opts: { sweeps?: number } = {}): Plan {
  const s = key(tokenIn);
  const t = key(tokenOut);
  const scale = new Map<string, number>(); // work in units where reserves are O(1): avoids float trouble across decimals
  for (const v of venues) {
    for (const [tok, r] of [[v.token0, v.r0], [v.token1, v.r1]] as const) {
      const k = key(tok);
      scale.set(k, Math.max(scale.get(k) ?? 0, Number(r)));
    }
  }
  if (!scale.has(s)) scale.set(s, Number(amountIn));
  const S = (k: string) => scale.get(k) ?? 1;
  const fv: FVenue[] = venues.map((v) => ({ a: key(v.token0), b: key(v.token1), R0: Number(v.r0) / S(key(v.token0)), R1: Number(v.r1) / S(key(v.token1)), g: (10_000 - v.feeBps) / 10_000 }));
  const A = Number(amountIn) / S(s);
  const tokens = [...new Set(fv.flatMap((v) => [v.a, v.b]).concat([s]))].filter((k) => k !== t);
  // scaled prices: μ_k = ν_k · S_k / S_t  (value of one scaled unit of k in scaled units of t)
  const mu = new Map<string, number>(tokens.map((k) => [k, 1]));
  mu.set(t, 1);
  const flows = (m: Map<string, number>) => {
    const f = new Map<string, number>(tokens.map((k) => [k, k === s ? A : 0]));
    const trades: { d0: number; d1: number }[] = [];
    for (const v of fv) {
      const r = venueBest(v, m.get(v.a) ?? 0, m.get(v.b) ?? 0);
      trades.push(r);
      if (f.has(v.a)) f.set(v.a, f.get(v.a)! + r.d0);
      if (f.has(v.b)) f.set(v.b, f.get(v.b)! + r.d1);
    }
    return { f, trades };
  };
  const sweeps = opts.sweeps ?? 400;
  let it = 0;
  for (; it < sweeps; it++) {
    let moved = 0;
    for (const k of tokens) {
      const g = (x: number) => {
        mu.set(k, x);
        return flows(mu).f.get(k)!;
      };
      const old = mu.get(k)!;
      let lo = Math.log(1e-12);
      let hi = Math.log(1e12);
      if (g(Math.exp(lo)) >= 0) {
        mu.set(k, Math.exp(lo)); // (numerically) ν_k = 0: a token nobody wants
        moved = Math.max(moved, 1);
        continue;
      }
      if (g(Math.exp(hi)) <= 0) throw new Error(`solver: no root for ${k}`);
      for (let j = 0; j < 200 && hi - lo > 1e-15; j++) {
        const mid = (lo + hi) / 2;
        if (g(Math.exp(mid)) < 0) lo = mid;
        else hi = mid;
      }
      const x = Math.exp((lo + hi) / 2);
      mu.set(k, x);
      moved = Math.max(moved, Math.abs(Math.log(x / Math.max(old, 1e-300))));
    }
    if (moved < 1e-13) break;
  }
  newtonPolish(mu, tokens, s, A, fv, flows);

  // fixed-point ν for the chain: ν_k (per raw unit, in raw units of t) = μ_k · S_t / S_k
  const prices: Prices = new Map([[t, PRICE_ONE]]);
  const nu: Record<string, number> = { [t]: 1 };
  for (const k of tokens) {
    const v = ((mu.get(k) ?? 0) * S(t)) / S(k);
    nu[k] = v;
    prices.set(k, BigInt(Math.round(v * 1e36)));
  }

  // primal recovery from the venues' best trades at the optimal prices
  const { trades } = flows(mu);
  const optimalTrades = trades
    .map((tr, i) => ({ venue: i, zeroForOne: tr.d0 < 0, amountIn: (tr.d0 < 0 ? -tr.d0 : -tr.d1) * S(tr.d0 < 0 ? fv[i].a : fv[i].b), amountOut: (tr.d0 < 0 ? tr.d1 : tr.d0) * S(tr.d0 < 0 ? fv[i].b : fv[i].a) }))
    .filter((x) => Number.isFinite(x.amountIn) && x.amountIn >= 1 && x.amountOut >= 1);
  // Drop numerical dust: trades worth less than a billionth of the whole output (they arise at the
  // boundary where a venue is just inactive, and could not execute in integer units anyway).
  const valueOf = (x: { venue: number; zeroForOne: boolean; amountOut: number }) => x.amountOut * (nu[key(x.zeroForOne ? venues[x.venue].token1 : venues[x.venue].token0)] ?? 0);
  const totalValue = optimalTrades.reduce((acc, x) => acc + valueOf(x), 0);
  const kept = optimalTrades.filter((x) => valueOf(x) >= Math.max(1, 1e-9 * totalValue));
  // a consumer of a token nobody produces (after the dust filter) cannot run: drop it too
  const produced = new Set(kept.map((x) => key(x.zeroForOne ? venues[x.venue].token1 : venues[x.venue].token0)).concat([s]));
  optimalTrades.splice(0, optimalTrades.length, ...kept.filter((x) => produced.has(key(x.zeroForOne ? venues[x.venue].token0 : venues[x.venue].token1))));
  const route = orderRoute(venues, optimalTrades, s, t, amountIn);
  const sim = simulate(venues, route, tokenIn, tokenOut, amountIn);
  const bound = dualBound(venues, amountIn, tokenIn, tokenOut, prices);
  const gapPpm = bound > 0n ? Number(((bound - sim.amountOut) * 1_000_000_000n) / bound) / 1000 : 0;
  return { prices, nu, route, sim, bound, gapPpm, optimalTrades, iterations: it };
}

/**
 * Coordinate descent converges only linearly when the input and bridge prices are strongly coupled.
 * Finish with damped Newton steps on ∇B = net flows (Hessian by finite differences of the analytic
 * gradient), each accepted only if it lowers B — so the polish can never make the bound worse.
 */
function newtonPolish(
  mu: Map<string, number>,
  tokens: string[],
  s: string,
  A: number,
  fv: FVenue[],
  flows: (m: Map<string, number>) => { f: Map<string, number> },
): void {
  const B = (m: Map<string, number>) => (m.get(s) ?? 0) * A + fv.reduce((acc, v) => acc + venueBest(v, m.get(v.a) ?? 0, m.get(v.b) ?? 0).value, 0);
  const active = tokens.filter((k) => (mu.get(k) ?? 0) > 1e-11);
  const n = active.length;
  if (!n) return;
  for (let iter = 0; iter < 60; iter++) {
    const f0 = flows(mu).f;
    const g = active.map((k) => f0.get(k)!);
    if (Math.max(...g.map(Math.abs)) < 1e-15 * Math.max(A, 1)) return;
    const H: number[][] = active.map(() => new Array(n).fill(0));
    active.forEach((kj, j) => {
      const base = mu.get(kj)!;
      const h = base * 1e-7;
      mu.set(kj, base + h);
      const f1 = flows(mu).f;
      mu.set(kj, base);
      active.forEach((ki, i) => (H[i][j] = (f1.get(ki)! - f0.get(ki)!) / h));
    });
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) H[i][j] = H[j][i] = (H[i][j] + H[j][i]) / 2;
    const ridge = 1e-12 * Math.max(...H.map((r, i) => Math.abs(r[i])), 1e-300);
    const step = gaussSolve(H.map((r, i) => r.map((x, j) => (i === j ? x + ridge : x))), g.map((x) => -x));
    if (!step) return;
    const b0 = B(mu);
    let t = 1;
    let accepted = false;
    for (let ls = 0; ls < 40; ls++, t /= 2) {
      const trial = new Map(mu);
      let ok = true;
      active.forEach((k, i) => {
        const x = mu.get(k)! + t * step[i];
        if (!(x > 0)) ok = false;
        trial.set(k, x);
      });
      if (ok && B(trial) <= b0) {
        for (const k of active) mu.set(k, trial.get(k)!);
        accepted = true;
        break;
      }
    }
    if (!accepted) return;
  }
}

function gaussSolve(M: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 0)) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[n] / r[i]);
}

/**
 * Orders the venues' trades so that every hop's input exists when it runs (sources first, then each
 * intermediate token once all of its producers have run), and assigns exact integer amounts: source
 * hops split A exactly; the last consumer of each intermediate token takes all of it (amountIn = 0).
 */
function orderRoute(venues: VenueState[], trades: { venue: number; zeroForOne: boolean; amountIn: number; amountOut: number }[], s: string, t: string, A: bigint): Hop[] {
  const tin = (x: { venue: number; zeroForOne: boolean }) => key(x.zeroForOne ? venues[x.venue].token0 : venues[x.venue].token1);
  const tout = (x: { venue: number; zeroForOne: boolean }) => key(x.zeroForOne ? venues[x.venue].token1 : venues[x.venue].token0);
  const pending = [...trades];
  const ordered: typeof trades = [];
  while (pending.length) {
    const i = pending.findIndex((x) => tin(x) === s || !pending.some((y) => tout(y) === tin(x)));
    if (i < 0) throw new Error("route has a cycle (an arbitrage loop): not supported by the router");
    ordered.push(pending.splice(i, 1)[0]);
  }
  // When venues disagree, the optimum can contain an arbitrage loop that hands input tokens back
  // (a trade whose output is s). Those recycled tokens are spent by repeating the largest source leg as
  // the very last hop ("everything left"), so the first pass spends only A − recycled on that leg.
  const src = ordered.filter((x) => tin(x) === s);
  const recycled = ordered.filter((x) => tout(x) === s).reduce((a, x) => a + x.amountOut, 0);
  const lead = src.filter((x) => tout(x) === t).reduce<(typeof src)[number] | null>((m, x) => (!m || x.amountIn > m.amountIn ? x : m), null); // a direct leg, so the repeat needs no further hops
  const recycle = recycled > 0 && lead !== null && lead.amountIn > recycled;
  const planned = src.map((x) => (recycle && x === lead ? x.amountIn - recycled : x.amountIn));
  const total = planned.reduce((a, x) => a + x, 0);
  const amounts = planned.map((x) => BigInt(Math.floor((x / total) * Number(A))));
  if (src.length) {
    const largest = amounts.reduce((bi, v, i) => (v > amounts[bi] ? i : bi), 0);
    amounts[largest] += A - amounts.reduce((a, b) => a + b, 0n);
  }
  // intermediate consumers: proportional split of what arrives, decided during exact simulation;
  // here we encode the plan as fractions and let `materialise` fix the integers.
  const hops: Hop[] = [];
  const lastConsumer = new Map<string, number>();
  ordered.forEach((x, i) => {
    if (tin(x) !== s && tin(x) !== t) lastConsumer.set(tin(x), i);
  });
  let si = 0;
  ordered.forEach((x, i) => {
    if (tin(x) === s) hops.push({ venue: x.venue, zeroForOne: x.zeroForOne, amountIn: amounts[si++] });
    // selling the output token (an arbitrage leg when venues disagree): an explicit, planned amount
    else if (tin(x) === t) hops.push({ venue: x.venue, zeroForOne: x.zeroForOne, amountIn: BigInt(Math.max(1, Math.floor(x.amountIn))) });
    else hops.push({ venue: x.venue, zeroForOne: x.zeroForOne, amountIn: lastConsumer.get(tin(x)) === i ? 0n : -1n });
  });
  // resolve the −1 placeholders (non-last intermediate consumers) by exact simulation
  if (hops.some((h) => h.amountIn === -1n)) {
    const shares = new Map<string, number>();
    ordered.forEach((x) => {
      if (tin(x) !== s && tin(x) !== t) shares.set(tin(x), (shares.get(tin(x)) ?? 0) + x.amountIn);
    });
    const vs = venues.map((v) => ({ ...v }));
    const bal = new Map<string, bigint>([[s, A]]);
    hops.forEach((h, i) => {
      const v = vs[h.venue];
      const [a, b] = h.zeroForOne ? [key(v.token0), key(v.token1)] : [key(v.token1), key(v.token0)];
      if (h.amountIn === -1n) {
        const inflow = bal.get(a) ?? 0n;
        h.amountIn = BigInt(Math.floor((ordered[i].amountIn / shares.get(a)!) * Number(inflow)));
      }
      const amt = h.amountIn === 0n ? bal.get(a) ?? 0n : h.amountIn;
      const [rIn, rOut] = h.zeroForOne ? [v.r0, v.r1] : [v.r1, v.r0];
      const out = amountOut(amt, rIn, rOut, v.feeBps);
      bal.set(a, (bal.get(a) ?? 0n) - amt);
      bal.set(b, (bal.get(b) ?? 0n) + out);
      if (h.zeroForOne) {
        v.r0 += amt;
        v.r1 -= out;
      } else {
        v.r1 += amt;
        v.r0 -= out;
      }
    });
  }
  if (recycle && lead) hops.push({ venue: lead.venue, zeroForOne: lead.zeroForOne, amountIn: 0n });
  return hops;
}

// ───────────────────────────── baselines (what a router without a proof might do) ─────────────────────────────

/** All of A through the single venue that gives the most output for it (a common naive policy). */
export function bestSingleVenue(venues: VenueState[], tokenIn: Address, tokenOut: Address, A: bigint): Hop[] | null {
  let best: Hop | null = null;
  let bestOut = -1n;
  for (const [i, v] of venues.entries()) {
    const z = key(v.token0) === key(tokenIn) && key(v.token1) === key(tokenOut);
    const o = key(v.token1) === key(tokenIn) && key(v.token0) === key(tokenOut);
    if (!z && !o) continue;
    const out = amountOut(A, z ? v.r0 : v.r1, z ? v.r1 : v.r0, v.feeBps);
    if (out > bestOut) {
      bestOut = out;
      best = { venue: i, zeroForOne: z, amountIn: A };
    }
  }
  return best ? [best] : null;
}

/** A split equally across every direct venue. */
export function equalSplitDirect(venues: VenueState[], tokenIn: Address, tokenOut: Address, A: bigint): Hop[] | null {
  const direct = venues
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => [key(v.token0), key(v.token1)].sort().join() === [key(tokenIn), key(tokenOut)].sort().join());
  if (!direct.length) return null;
  const share = A / BigInt(direct.length);
  return direct.map(({ v, i }, j) => ({ venue: i, zeroForOne: key(v.token0) === key(tokenIn), amountIn: j === direct.length - 1 ? A - share * BigInt(direct.length - 1) : share }));
}

/** Direct venues only, optimally split (what a single-pair aggregator achieves; ignores multi-hop paths). */
export function optimalDirectOnly(venues: VenueState[], tokenIn: Address, tokenOut: Address, A: bigint): { route: Hop[]; out: bigint } | null {
  const idx = venues
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => [key(v.token0), key(v.token1)].sort().join() === [key(tokenIn), key(tokenOut)].sort().join());
  if (!idx.length) return null;
  const sub = idx.map(({ v }) => v);
  const p = solve(sub, tokenIn, tokenOut, A);
  const route = p.route.map((h) => ({ ...h, venue: idx[h.venue].i }));
  return { route, out: p.sim.amountOut };
}

/** Bounds a hostile router could exploit under a slippage-only policy: the worst output still ≥ minOut. */
export const slippageFloor = (quote: bigint, bps: number) => (quote * BigInt(10_000 - bps)) / 10_000n;
