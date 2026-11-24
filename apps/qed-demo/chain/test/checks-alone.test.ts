/**
 * F-018 (K4): which of the co-signer's named checks can fail alone.
 *
 * The release (the first four tests). In the release's engine four checks have no failing case of their own:
 *   T1 fails only together with T2; P1 only with P2; P3 only with P2; T3 cannot fail on a chain.
 * These tests check those statements against the release's own pure functions (vendor/agent/src: solve, decideTranche,
 * impactBps; unmodified) and its source, instead of taking them on trust. No chain is started.
 *
 * The rail's engine (the last three). Decision D-K4a redefines P2, T2 and T3 in the generated engine
 * (scripts/fork-cosigner.mjs change 5), so that each check can fail alone; cosigner-checks.test.ts shows each on a real
 * chain. Here, on generated markets, with the engine's own policyTranche and venueSetHashOf: P1, P2 and P3 each fail
 * alone, and P1∧P2∧P3 is the release's verdict on every generated request; T1 and T2 each fail alone; T3's hash changes
 * with any change to the venue set.
 *
 *   P1 ⇒ P2  proved by the source: P2's condition is P1's condition and more (a conjunct).
 *   P3 ⇒ P2  checked on generated markets: a request whose execution cost is above the limit is above the co-signer's
 *            own tranche, or no tranche is due.
 *   T1 ⇒ T2  checked on generated markets: when the co-signer's own route does not execute, it quotes nothing, so the
 *            rate is zero and T2 fails. The test's stated reason covers only the error path: the simulator also
 *            reports a route with an intermediate token left over as not executing with a positive output; that path
 *            is counted here and was not reached.
 *   T3       proved by decoding: any value the chain returns for a bytes32 has T3's form.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAbiParameters, encodeAbiParameters, type Address } from "viem";
import { solve, type VenueState } from "../vendor/agent/src/engine/execution.ts";
import { decideTranche, impactBps, type TreasuryPolicy } from "../vendor/agent/src/roles/treasury.ts";
import { policyTranche, venueSetHashOf } from "../rail/cosigner-engine.ts";

const T = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2", "0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000d4"] as Address[];
/** A seeded generator, so every run checks the same markets. */
function rng(seed: number) {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return { r, big: (lo: number, hi: number) => BigInt(Math.floor(lo + r() * (hi - lo))), pick: <X>(xs: readonly X[]) => xs[Math.floor(r() * xs.length)]! };
}
function market(g: ReturnType<typeof rng>, tokens: number): VenueState[] {
  const n = 2 + Math.floor(g.r() * 5), out: VenueState[] = [];
  for (let i = 0; i < n; i++) {
    let x = Math.floor(g.r() * tokens), y = Math.floor(g.r() * tokens);
    if (x === y) y = (x + 1) % tokens;
    const [t0, t1] = x < y ? [T[x]!, T[y]!] : [T[y]!, T[x]!];
    out.push({ pool: `0x${(0x1000 + i).toString(16).padStart(40, "0")}` as Address, token0: t0, token1: t1, feeBps: g.pick([5, 30, 100]), r0: g.big(1e3, 1e12), r1: g.big(1e3, 1e12) });
  }
  return out;
}
const SOURCE = readFileSync(join(import.meta.dirname, "..", "vendor", "agent", "src", "roles", "cosigner.ts"), "utf8");

test("P1 ⇒ P2, from the release's source: P2's condition is P1's (\"a tranche is due\") and more, so P1 never fails alone", () => {
  const p1 = /add\("P1", [^,]+, own\.action === "convert", /.exec(SOURCE), p2 = /add\("P2", [^,]+, own\.action === "convert" && /.exec(SOURCE);
  assert.ok(p1 && p2, "the release's P1 and P2 lines have changed: re-derive the dependency");
});

test("P3 ⇒ P2, on generated markets: a request whose execution cost is above the policy's limit is refused by P2 as well", (t) => {
  const g = rng(18);
  let requests = 0, p3Fails = 0, alone = 0;
  for (let m = 0; m < 300; m++) {
    const venues = market(g, 2 + Math.floor(g.r() * 2));
    const minTranche = g.big(1, 1e6);
    const policy: TreasuryPolicy = { vault: T[2]!, reserve: T[3]!, tokenIn: T[0]!, tokenOut: T[1]!, targetFree: g.big(1, 1e11), maxTranche: minTranche + g.big(0, 1e10), minTranche, maxImpactBps: g.pick([10, 50, 100, 300]), validUntil: 0n, nonce: "n" };
    let own;
    try { own = decideTranche(venues, policy, g.big(0, 1e11), g.big(0, 1e11), g.big(1, 1e11)); } catch { continue; } // the solver refuses a market with an arbitrage loop
    for (let i = 0; i < 6; i++) {
      const req = g.r() < 0.5 && own.amountIn > 0n ? own.amountIn - g.big(0, Number(own.amountIn)) : g.big(1, 1e10);
      let ib: number;
      try { ib = impactBps(venues, policy.tokenIn, policy.tokenOut, req); } catch { continue; }
      requests++;
      const P2 = own.action === "convert" && req <= own.amountIn && req >= policy.minTranche, P3 = ib <= policy.maxImpactBps;
      if (!P3) p3Fails++;
      if (!P3 && P2) alone++;
    }
  }
  assert.ok(requests > 600 && p3Fails > 100, `the generator reached too few cases: ${requests} requests, ${p3Fails} with P3 failing`);
  t.diagnostic(`${requests} requests on generated markets, ${p3Fails} with P3 failing, ${alone} of them with P2 passing`);
  assert.equal(alone, 0, `P3 failed alone on ${alone} of ${p3Fails} requests whose cost was above the limit`);
});

test("T1 ⇒ T2, on generated markets: when the co-signer's own route does not execute it quotes nothing, so the rate is zero and T2 fails", (t) => {
  const g = rng(1);
  let solved = 0, t1Fails = 0, leftovers = 0, alone = 0;
  for (let m = 0; m < 600; m++) {
    const venues = market(g, 3 + Math.floor(g.r() * 2)), amountIn = g.big(1, 1e10), tokenIn = T[0]!, tokenOut = T[1]!;
    let own;
    try { own = solve(venues, tokenIn, tokenOut, amountIn); } catch { continue; }
    solved++;
    // T1 and T2 exactly as the release computes them (roles/cosigner.ts, the T1 and T2 lines)
    const T1 = own.sim.ok && own.sim.amountOut > 0n;
    if (own.sim.error === "Leftover") leftovers++;
    if (T1) continue;
    t1Fails++;
    const direct = venues.filter((v) => [v.token0, v.token1].map((x) => x.toLowerCase()).sort().join() === [tokenIn, tokenOut].map((x) => x.toLowerCase()).sort().join());
    const depth = (v: VenueState) => Number(v.token0.toLowerCase() === tokenIn.toLowerCase() ? v.r0 : v.r1);
    const mid = (v: VenueState) => (v.token0.toLowerCase() === tokenIn.toLowerCase() ? Number(v.r1) / Number(v.r0) : Number(v.r0) / Number(v.r1));
    const wMid = direct.reduce((a, v) => a + mid(v) * depth(v), 0) / Math.max(1, direct.reduce((a, v) => a + depth(v), 0));
    const rate = Number(own.sim.amountOut) / Number(amountIn);
    const deviation = wMid > 0 ? Math.abs(rate / wMid - 1) * 10_000 : Infinity;
    if (deviation <= 300) alone++;
  }
  assert.ok(solved > 300 && t1Fails > 100, `the generator reached too few cases: ${solved} solved, ${t1Fails} with T1 failing`);
  t.diagnostic(`${solved} markets solved, ${t1Fails} with T1 failing, ${alone} of them with T2 passing, ${leftovers} routes with a token left over`);
  assert.equal(alone, 0, `T1 failed with T2 passing on ${alone} markets`);
  // the path the test's stated reason does not cover: not reached on these markets
  assert.equal(leftovers, 0);
  assert.match(SOURCE, /add\("T1", [^,]+, own\.sim\.ok && own\.sim\.amountOut > 0n, /);
});

test("T3 cannot fail on a chain: every bytes32 the chain can return, decoded, has the form T3 requires", () => {
  const g = rng(7);
  for (let i = 0; i < 500; i++) {
    const raw = `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(g.r() * 16)]).join("")}` as `0x${string}`;
    const [decoded] = decodeAbiParameters([{ type: "bytes32" }], encodeAbiParameters([{ type: "bytes32" }], [raw]));
    assert.match(decoded, /^0x[0-9a-f]{64}$/i);
  }
  assert.match(SOURCE, /add\("T3", [^,]+, \/\^0x\[0-9a-f\]\{64\}\$\/i\.test\(venueSetHash\), /);
});

// ───────────── the rail's engine (decision D-K4a, scripts/fork-cosigner.mjs change 5) ─────────────
const FORK = readFileSync(join(import.meta.dirname, "..", "rail", "cosigner-engine.ts"), "utf8");

test("the rail's engine (D-K4a): P1, P2 and P3 each fail alone on generated markets, and P1∧P2∧P3 is the release's verdict on every generated request", (t) => {
  assert.match(FORK, /add\("P2", "[^"]+", !due \|\| \(req\.amountIn <= sized && req\.amountIn >= p\.minTranche\), /, "the engine's P2 is the one checked here");
  assert.match(FORK, /const due = own\.action === "convert", sized = policyTranche\(own\.candidates\);/);
  const g = rng(18);
  let requests = 0, differ = 0;
  const alone = { P1: 0, P2: 0, P3: 0 };
  for (let m = 0; m < 300; m++) {
    const venues = market(g, 2 + Math.floor(g.r() * 2));
    const minTranche = g.big(1, 1e6);
    const policy: TreasuryPolicy = { vault: T[2]!, reserve: T[3]!, tokenIn: T[0]!, tokenOut: T[1]!, targetFree: g.big(1, 1e11), maxTranche: minTranche + g.big(0, 1e10), minTranche, maxImpactBps: g.pick([10, 50, 100, 300]), validUntil: 0n, nonce: "n" };
    const reserveFree = g.r() < 0.15 ? policy.targetFree + 1n : g.big(0, 1e11); // sometimes nothing is due
    let own;
    try { own = decideTranche(venues, policy, reserveFree, g.big(0, 1e11), g.big(1, 1e11)); } catch { continue; }
    for (let i = 0; i < 6; i++) {
      const sized = policyTranche(own.candidates);
      const req = g.r() < 0.5 && sized > 0n ? sized - g.big(0, Number(sized)) : g.big(1, 1e10);
      let ib: number;
      try { ib = impactBps(venues, policy.tokenIn, policy.tokenOut, req); } catch { continue; }
      requests++;
      const due = own.action === "convert";
      const P1 = due, P2 = !due || (req <= sized && req >= policy.minTranche), P3 = ib <= policy.maxImpactBps;
      const releaseP2 = due && req <= own.amountIn && req >= policy.minTranche;
      if (!P1 && P2 && P3) alone.P1++;
      if (P1 && !P2 && P3) alone.P2++;
      if (P1 && P2 && !P3) alone.P3++;
      if ((P1 && P2 && P3) !== (P1 && releaseP2 && P3)) differ++;
    }
  }
  t.diagnostic(`${requests} requests: P1 alone ${alone.P1}, P2 alone ${alone.P2}, P3 alone ${alone.P3}; verdicts that differ from the release's ${differ}`);
  assert.ok(requests > 600, `the generator reached too few requests: ${requests}`);
  assert.ok(alone.P1 > 0 && alone.P2 > 0 && alone.P3 > 0, `each fails alone: ${JSON.stringify(alone)}`);
  assert.equal(differ, 0, "the conjunction is the release's verdict");
});

test("the rail's engine (D-K4a): T1 and T2 each fail alone on generated markets (T2 is computed only when T1 passes)", (t) => {
  assert.match(FORK, /if \(own\.sim\.ok && own\.sim\.amountOut > 0n\) add\("T2", /, "the engine adds T2 only when T1 passes");
  const g = rng(1);
  let t1Alone = 0, t2Alone = 0;
  for (let m = 0; m < 600; m++) {
    const venues = market(g, 3 + Math.floor(g.r() * 2)), amountIn = g.big(1, 1e10), tokenIn = T[0]!, tokenOut = T[1]!;
    let own;
    try { own = solve(venues, tokenIn, tokenOut, amountIn); } catch { continue; }
    const T1 = own.sim.ok && own.sim.amountOut > 0n;
    if (!T1) { t1Alone++; continue; } // T2 is not computed: T1 is the only failing check of the pair
    const direct = venues.filter((v) => [v.token0, v.token1].map((x) => x.toLowerCase()).sort().join() === [tokenIn, tokenOut].map((x) => x.toLowerCase()).sort().join());
    const depth = (v: VenueState) => Number(v.token0.toLowerCase() === tokenIn.toLowerCase() ? v.r0 : v.r1);
    const mid = (v: VenueState) => (v.token0.toLowerCase() === tokenIn.toLowerCase() ? Number(v.r1) / Number(v.r0) : Number(v.r0) / Number(v.r1));
    const wMid = direct.reduce((a, v) => a + mid(v) * depth(v), 0) / Math.max(1, direct.reduce((a, v) => a + depth(v), 0));
    const deviation = wMid > 0 ? Math.abs(Number(own.sim.amountOut) / Number(amountIn) / wMid - 1) * 10_000 : Infinity;
    if (deviation > 300) t2Alone++;
  }
  t.diagnostic(`T1 alone on ${t1Alone} markets, T2 alone on ${t2Alone}`);
  assert.ok(t1Alone > 100 && t2Alone > 0, `each fails alone: T1 ${t1Alone}, T2 ${t2Alone}`);
});

test("the rail's engine (D-K4a): T3 compares QEDExecution's venue-set hash with the venues read; any change to the set changes the hash", () => {
  assert.match(FORK, /add\("T3", "[^"]+", solvedOver\.toLowerCase\(\) === String\(venueSetHash\)\.toLowerCase\(\), /);
  const g = rng(7);
  for (let i = 0; i < 200; i++) {
    const vs = market(g, 4);
    const h = venueSetHashOf(vs);
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.equal(venueSetHashOf(vs.map((v) => ({ ...v }))), h, "the same set, the same hash");
    if (vs.length > 1) {
      assert.notEqual(venueSetHashOf(vs.slice(0, -1)), h, "a venue dropped");
      assert.notEqual(venueSetHashOf([...vs.slice(1), vs[0]!]), h, "the order changed (the proof indexes venues by position)");
    }
    assert.notEqual(venueSetHashOf(vs.map((v, k) => (k === 0 ? { ...v, feeBps: v.feeBps + 1 } : v))), h, "a fee changed");
  }
});
