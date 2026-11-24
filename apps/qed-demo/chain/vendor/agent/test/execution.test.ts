import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  amountOut,
  bestSingleVenue,
  dualBound,
  equalSplitDirect,
  isqrt,
  optimalDirectOnly,
  simulate,
  solve,
  PRICE_ONE,
  type Hop,
  type Prices,
  type VenueState,
} from "../src/engine/execution.js";
import { randomMarket, rng, tokenAddr } from "../src/engine/executionMarkets.js";

test("isqrt is the exact floor square root on 2,000 random inputs up to 2^250", () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    let n = 0n;
    const bits = 1 + Math.floor(r() * 250);
    for (let b = 0; b < bits; b += 30) n = (n << 30n) | BigInt(Math.floor(r() * 2 ** 30));
    const s = isqrt(n);
    assert.ok(s * s <= n && (s + 1n) * (s + 1n) > n, `isqrt(${n})`);
  }
});

test("path deficiency: repeated swaps on one pool never beat a single swap (3,000 random cases)", () => {
  const r = rng(11);
  for (let i = 0; i < 3000; i++) {
    const R0 = BigInt(Math.floor(1e6 + r() * 1e12));
    const R1 = BigInt(Math.floor(1e6 + r() * 1e12));
    const fee = [1, 5, 30, 100][i % 4];
    const x1 = BigInt(Math.floor(r() * Number(R0) * 0.3)) + 1n;
    const x2 = BigInt(Math.floor(r() * Number(R0) * 0.3)) + 1n;
    const o1 = amountOut(x1, R0, R1, fee);
    const o2 = amountOut(x2, R0 + x1, R1 - o1, fee);
    assert.ok(o1 + o2 <= amountOut(x1 + x2, R0, R1, fee), "splitting a swap in time gained output");
    // a round trip loses
    const back = amountOut(o1, R1 - o1, R0 + x1, fee);
    assert.ok(back <= x1, "a round trip gained input");
  }
});

/** A random route from A of the input: up to 6 hops, any venue, any direction, venues reused. */
function randomRoute(venues: VenueState[], tokenIn: string, A: bigint, r: () => number): Hop[] {
  const bal = new Map<string, bigint>([[tokenIn.toLowerCase(), A]]);
  const hops: Hop[] = [];
  const vs = venues.map((v) => ({ ...v }));
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const vi = Math.floor(r() * vs.length);
    const v = vs[vi];
    const z = r() < 0.5;
    const tin = (z ? v.token0 : v.token1).toLowerCase();
    const have = bal.get(tin) ?? 0n;
    if (have === 0n) continue;
    const amt = i === n - 1 ? have : 1n + BigInt(Math.floor(r() * Number(have)));
    const [rIn, rOut] = z ? [v.r0, v.r1] : [v.r1, v.r0];
    const out = amountOut(amt, rIn, rOut, v.feeBps);
    if (out === 0n) continue;
    hops.push({ venue: vi, zeroForOne: z, amountIn: amt });
    bal.set(tin, have - amt);
    const tout = (z ? v.token1 : v.token0).toLowerCase();
    bal.set(tout, (bal.get(tout) ?? 0n) + out);
    if (z) [v.r0, v.r1] = [v.r0 + amt, v.r1 - out];
    else [v.r1, v.r0] = [v.r1 + amt, v.r0 - out];
  }
  return hops;
}

test("weak duality: no route, at any prices, beats the bound (400 markets × 10 routes × 3 price vectors)", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const m = randomMarket(seed, { tokens: 3 + (seed % 2) });
    const plan = solve(m.venues, m.tokenIn, m.tokenOut, m.amountIn);
    const r = rng(seed * 101);
    for (let j = 0; j < 3; j++) {
      const prices: Prices = new Map();
      for (const [k, v] of plan.prices) prices.set(k, k === m.tokenOut.toLowerCase() ? PRICE_ONE : j === 0 ? v : (v * BigInt(Math.floor(r() * 3000))) / 1000n);
      const B = dualBound(m.venues, m.amountIn, m.tokenIn, m.tokenOut, prices);
      for (let k = 0; k < 10; k++) {
        const route = randomRoute(m.venues, m.tokenIn, m.amountIn, r);
        const s = simulate(m.venues, route, m.tokenIn, m.tokenOut, m.amountIn);
        assert.ok(s.amountOut <= B, `seed ${seed}: route out ${s.amountOut} > bound ${B}`);
      }
    }
  }
});

test("strong duality in practice: the solver's route is within 1 ppm of its bound, or within one raw unit per hop, on 300 random markets", () => {
  const gaps: number[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const m = randomMarket(seed, { tokens: 3 + (seed % 2) });
    const p = solve(m.venues, m.tokenIn, m.tokenOut, m.amountIn);
    assert.ok(p.sim.ok, `seed ${seed}: ${p.sim.error}`);
    // integer rounding loses at most one raw unit per hop; allow that on very small outputs
    const slack = BigInt(p.route.length);
    assert.ok(p.sim.amountOut * 1_000_000n >= p.bound * 999_999n - slack * 1_000_000n, `seed ${seed}: gap ${p.gapPpm} ppm`);
    gaps.push(p.gapPpm);
  }
  gaps.sort((a, b) => a - b);
  // what remains above 1 ppm is integer granularity: ≤ 1 raw unit per hop on outputs of a few tokens
  assert.ok(gaps[Math.floor(gaps.length / 2)] < 0.5, `median gap ${gaps[Math.floor(gaps.length / 2)]} ppm`);
});

test("the certified route beats every baseline policy on 200 random markets", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const m = randomMarket(seed);
    const p = solve(m.venues, m.tokenIn, m.tokenOut, m.amountIn);
    for (const [name, route] of [
      ["single", bestSingleVenue(m.venues, m.tokenIn, m.tokenOut, m.amountIn)],
      ["equal", equalSplitDirect(m.venues, m.tokenIn, m.tokenOut, m.amountIn)],
      ["direct", optimalDirectOnly(m.venues, m.tokenIn, m.tokenOut, m.amountIn)?.route ?? null],
    ] as const) {
      if (!route) continue;
      const s = simulate(m.venues, route, m.tokenIn, m.tokenOut, m.amountIn);
      assert.ok(s.amountOut <= p.sim.amountOut + BigInt(p.route.length), `seed ${seed}: ${name} ${s.amountOut} > certified ${p.sim.amountOut}`);
    }
  }
});

test("the committed Solidity fixture is the engine's current output (no drift)", async () => {
  const sol = readFileSync("contracts/test/fixtures/ExecutionFixture.sol", "utf8");
  const get = (name: string) => BigInt(new RegExp(`${name} = (\\d+);`).exec(sol)![1]);
  const { EXEC_VENUES, raw, TRADE_TUSD } = await import("../src/engine/executionScenario.js");
  const ADDR = { tUSD: "0x0000000000000000000000000000000000000a01", tEUR: "0x0000000000000000000000000000000000000a02", tETH: "0x0000000000000000000000000000000000000a03" } as const;
  const venues: VenueState[] = EXEC_VENUES.map((v, i) => {
    const [x, y] = ADDR[v.a] < ADDR[v.b] ? [v.a, v.b] : [v.b, v.a];
    return { pool: `0x00000000000000000000000000000000000b0${i}` as `0x${string}`, token0: ADDR[x], token1: ADDR[y], r0: x === v.a ? raw(v.a, v.ra) : raw(v.b, v.rb), r1: x === v.a ? raw(v.b, v.rb) : raw(v.a, v.ra), feeBps: v.feeBps };
  });
  const p = solve(venues, ADDR.tUSD, ADDR.tEUR, raw("tUSD", TRADE_TUSD));
  assert.equal(p.bound, get("HONEST_BOUND"));
  assert.equal(p.sim.amountOut, get("HONEST_OUT"));
  void tokenAddr;
});
