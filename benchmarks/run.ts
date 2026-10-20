/**
 * QED benchmarks and ablations. Deterministic: fixed seeds, no network, no clock in the results.
 *   npx tsx benchmarks/run.ts            → benchmarks/results.json (+ a summary on stdout)
 *
 *   B1  best execution vs the routing policies agents use without a proof (1,000 random markets)
 *   B2  the solver: precision of the certificate and time to compute it
 *   B3  netting: certified maximal netting vs a greedy shortest-cycle netter vs none (500 economies)
 *   B4  paid work: what a provider could deliver if the escrow did not check optimality (500 problems)
 *   B5  authorisation layers: which layer refused each of the attacks recorded on Sepolia
 * Unfavourable results are reported alongside favourable ones.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bestSingleVenue, equalSplitDirect, optimalDirectOnly, simulate, solve } from "../agent/src/engine/execution.js";
import { randomMarket, rng } from "../agent/src/engine/executionMarkets.js";
import { greedyNetting, solveNetting, type Obligation } from "../agent/src/engine/netting.js";
import { solveFloat } from "../agent/src/engine/minvar.js";

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN;
};
const summary = (xs: number[]) => ({ n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), median: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99), max: Math.max(...xs), min: Math.min(...xs) });
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const round = (o: any): any => (typeof o === "number" ? r4(o) : Array.isArray(o) ? o.map(round) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)])) : o);

// ───────────────────────────── B1 + B2: best execution ─────────────────────────────
const SLIP = 100; // the co-signer's floor in the live run: 1%
const policies = ["single", "equal", "directOnly"] as const;
const short: Record<string, number[]> = { single: [], equal: [], directOnly: [] };
const passFloor: Record<string, number> = { single: 0, equal: 0, directOnly: 0 };
const leakInsideFloor: Record<string, number[]> = { single: [], equal: [], directOnly: [] };
const baselineAlreadyOptimal: Record<string, number> = { single: 0, equal: 0, directOnly: 0 };
const gaps: number[] = [];
const ms: number[] = [];
const bySize: { bucket: string; directOnly: number[]; single: number[] }[] = [
  { bucket: "< 0.5%", directOnly: [], single: [] },
  { bucket: "0.5–2%", directOnly: [], single: [] },
  { bucket: "2–5%", directOnly: [], single: [] },
  { bucket: "> 5%", directOnly: [], single: [] },
];
let markets = 0;
for (let seed = 1; seed <= 1000; seed++) {
  const m = randomMarket(seed, { tokens: 3 + (seed % 2) });
  const t0 = performance.now();
  const p = solve(m.venues, m.tokenIn, m.tokenOut, m.amountIn);
  ms.push(performance.now() - t0);
  if (!p.sim.ok) continue;
  markets++;
  gaps.push(p.gapPpm);
  const opt = Number(p.sim.amountOut);
  const floor = opt * (1 - SLIP / 1e4);
  const routes = {
    single: bestSingleVenue(m.venues, m.tokenIn, m.tokenOut, m.amountIn),
    equal: equalSplitDirect(m.venues, m.tokenIn, m.tokenOut, m.amountIn),
    directOnly: optimalDirectOnly(m.venues, m.tokenIn, m.tokenOut, m.amountIn)?.route ?? null,
  };
  const b = m.sizeRatio < 0.005 ? 0 : m.sizeRatio < 0.02 ? 1 : m.sizeRatio < 0.05 ? 2 : 3;
  for (const k of policies) {
    const r = routes[k];
    if (!r) continue;
    const out = Number(simulate(m.venues, r, m.tokenIn, m.tokenOut, m.amountIn).amountOut);
    const bps = ((opt - out) / opt) * 1e4;
    short[k].push(bps);
    if (bps < 0.01) baselineAlreadyOptimal[k]++;
    if (out >= floor) {
      passFloor[k]++;
      leakInsideFloor[k].push(bps);
    }
    if (k === "directOnly" || k === "single") bySize[b][k].push(bps);
  }
}
const B1 = {
  markets,
  setup: "1,000 seeded markets: 3–4 tokens, 1–3 direct pools and 1–2 two-hop paths per bridge token, depths 100–10,000 USD per side, fees {1,5,30,100} bps, venue mispricing below each venue's fee, trade size 0.1%–20% of direct depth",
  shortfallBps: Object.fromEntries(policies.map((k) => [k, summary(short[k])])),
  baselineAlreadyOptimalShare: Object.fromEntries(policies.map((k) => [k, baselineAlreadyOptimal[k] / Math.max(1, short[k].length)])),
  passesOnePercentFloorShare: Object.fromEntries(policies.map((k) => [k, passFloor[k] / Math.max(1, short[k].length)])),
  leakageInsideFloorBps: Object.fromEntries(policies.map((k) => [k, summary(leakInsideFloor[k])])),
  bySize: bySize.map((x) => ({ bucket: x.bucket, n: x.directOnly.length, directOnlyMedianBps: q(x.directOnly, 0.5), directOnlyP90Bps: q(x.directOnly, 0.9), singleMedianBps: q(x.single, 0.5) })),
};
const B2 = { gapPpm: summary(gaps), shareWithin1ppm: gaps.filter((g) => g <= 1).length / gaps.length }; // solver time is machine-dependent: printed, not stored

// ───────────────────────────── B3: netting ─────────────────────────────
const cleared: { optimal: number; greedy: number; gross: number }[] = [];
for (let seed = 1; seed <= 500; seed++) {
  const r = rng(10_000 + seed);
  const members = 4 + Math.floor(r() * 9);
  const nObs = members + Math.floor(r() * members * 3);
  const obs: Obligation[] = [];
  for (let i = 0; i < nObs; i++) {
    const d = Math.floor(r() * members);
    let c = Math.floor(r() * members);
    if (c === d) c = (c + 1) % members;
    obs.push({ id: BigInt(i + 1), debtor: d, creditor: c, amount: BigInt(1 + Math.floor(r() * 200)) * 1_000_000n });
  }
  const opt = solveNetting(members, obs);
  const g = greedyNetting(members, obs);
  const gross = obs.reduce((a, o) => a + Number(o.amount), 0);
  cleared.push({ optimal: Number(opt.cleared) / gross, greedy: g.reduce((a, x) => a + Number(x), 0) / gross, gross });
}
const B3 = {
  economies: cleared.length,
  setup: "500 seeded economies: 4–12 members, 1–4 obligations per member on average, amounts 1–200 tUSD",
  clearedShareOfGross: { optimal: summary(cleared.map((c) => c.optimal)), greedy: summary(cleared.map((c) => c.greedy)), none: 0 },
  greedyShortfallPctPoints: summary(cleared.map((c) => (c.optimal - c.greedy) * 100)),
  greedyAlreadyOptimalShare: cleared.filter((c) => c.optimal - c.greedy < 1e-12).length / cleared.length,
};

// ───────────────────────────── B4: paid work ─────────────────────────────
const excess: number[] = [];
const excessTop: number[] = [];
for (let seed = 1; seed <= 500; seed++) {
  const r = rng(20_000 + seed);
  const n = 4 + Math.floor(r() * 5);
  const vols = Array.from({ length: n }, () => 0.05 + r() * 0.55);
  const F = Array.from({ length: n }, () => r() * 2 - 1); // one-factor correlation
  const S = vols.map((vi, i) => vols.map((vj, j) => vi * vj * (i === j ? 1 : 0.9 * F[i] * F[j])));
  const best = solveFloat(S).w;
  const varOf = (w: number[]) => w.reduce((a, wi, i) => a + wi * w.reduce((b, wj, j) => b + S[i][j] * wj, 0), 0);
  const v0 = varOf(best);
  const eq = varOf(vols.map(() => 1 / n));
  excess.push((eq / v0 - 1) * 100);
  const top = vols.indexOf(Math.min(...vols));
  excessTop.push((varOf(vols.map((_, i) => (i === top ? 1 : 0))) / v0 - 1) * 100);
}
const B4 = {
  problems: excess.length,
  setup: "500 seeded min-variance problems, 4–8 assets, vols 5–60%, one-factor correlations",
  equalWeightExcessVariancePct: summary(excess),
  lowestVolAssetExcessVariancePct: summary(excessTop),
};

// ───────────────────────────── B5: layers, from the public evidence ─────────────────────────────
const layerOf: Record<string, string> = {};
const manifests = ["evidence/ethereum-sepolia/manifest.json", "evidence/ethereum-sepolia/clearing/manifest.json", "evidence/ethereum-sepolia/private/manifest.json", "evidence/ethereum-sepolia/execution/manifest.json"].filter(existsSync);
const attacks: { run: string; id: string; error: string; layer: string }[] = [];
for (const f of manifests) {
  const m = JSON.parse(readFileSync(f, "utf8"));
  for (const s of m.steps ?? []) {
    if (s.expect !== "revert" || !s.tx) continue;
    const layer = s.attack?.layer ?? "QEDVault";
    attacks.push({ run: m.run ?? "main", id: s.id, error: s.error?.name ?? "?", layer });
    layerOf[layer] = layer;
  }
}
const byLayer: Record<string, number> = {};
for (const a of attacks) byLayer[a.layer] = (byLayer[a.layer] ?? 0) + 1;
const B5 = { attacksOnSepolia: attacks.length, byLayer, attacks, note: "Which layer's check produced the revert of each recorded attack. Not a re-run with layers disabled: removing a layer does not imply the next one would catch the attack." };

const results = round({ generatedBy: "benchmarks/run.ts", seeds: "B1 1–1000, B3 10001–10500, B4 20001–20500", B1, B2, B3, B4, B5 });
writeFileSync("benchmarks/results.json", JSON.stringify(results, null, 2));
console.log(`solver time (this machine): median ${q(ms, 0.5).toFixed(1)} ms, p90 ${q(ms, 0.9).toFixed(1)} ms, p99 ${q(ms, 0.99).toFixed(1)} ms`);
console.log(JSON.stringify({ B1: { markets, shortfallMedianBps: Object.fromEntries(policies.map((k) => [k, r4(q(short[k], 0.5))])), passFloor: results.B1.passesOnePercentFloorShare, alreadyOptimal: results.B1.baselineAlreadyOptimalShare }, B2: results.B2, B3: { greedyShortfall: results.B3.greedyShortfallPctPoints, greedyOptimal: results.B3.greedyAlreadyOptimalShare }, B4: results.B4.equalWeightExcessVariancePct, B5: { n: attacks.length, byLayer } }, null, 1));
