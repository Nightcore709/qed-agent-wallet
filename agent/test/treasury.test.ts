import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTranche, directMid, impactBps, certifiedOut, type TreasuryPolicy } from "../src/roles/treasury.js";
import { randomMarket } from "../src/engine/executionMarkets.js";
import type { Address } from "viem";

const policyFor = (m: ReturnType<typeof randomMarket>, over: Partial<TreasuryPolicy> = {}): TreasuryPolicy => ({
  vault: "0x0000000000000000000000000000000000000001" as Address,
  reserve: "0x0000000000000000000000000000000000000002" as Address,
  tokenIn: m.tokenIn,
  tokenOut: m.tokenOut,
  targetFree: 50_000_000n,
  maxTranche: 25_000_000n,
  minTranche: 1_000_000n,
  maxImpactBps: 100,
  validUntil: 2n ** 40n,
  nonce: "t",
  ...over,
});

test("execution cost is non-decreasing in size (F* concave), so the impact search is well defined", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const m = randomMarket(seed);
    const mid = directMid(m.venues, m.tokenIn, m.tokenOut);
    let last = -Infinity;
    for (const x of [1n, 2n, 4n, 8n, 16n, 32n].map((k) => k * 1_000_000n)) {
      const ib = impactBps(m.venues, m.tokenIn, m.tokenOut, x, mid);
      assert.ok(ib >= last - 0.05, `seed ${seed}: impact fell from ${last} to ${ib} at ${x}`);
      last = ib;
    }
  }
});

test("the tranche never exceeds any of its limits, and covers the shortfall when need is the binding one", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const m = randomMarket(seed);
    const p = policyFor(m, { maxImpactBps: [30, 100, 300][seed % 3] });
    const reserveFree = BigInt(seed % 7) * 5_000_000n;
    const available = BigInt(10 + (seed % 5) * 10) * 1_000_000n;
    const mandateCap = 20_000_000n;
    const d = decideTranche(m.venues, p, reserveFree, available, mandateCap);
    if (d.action !== "convert") continue;
    assert.ok(d.amountIn <= p.maxTranche && d.amountIn <= mandateCap && d.amountIn <= available && d.amountIn >= p.minTranche);
    assert.ok(impactBps(m.venues, m.tokenIn, m.tokenOut, d.amountIn) <= p.maxImpactBps + 1e-9);
    if (d.limitedBy === "need") assert.ok(certifiedOut(m.venues, m.tokenIn, m.tokenOut, d.amountIn) >= d.shortfall);
    if (d.limitedBy === "need") assert.ok(certifiedOut(m.venues, m.tokenIn, m.tokenOut, d.amountIn - 1n) < d.shortfall, "need is the smallest covering input");
  }
});

test("no shortfall → no action; a market too thin for the minimum tranche → wait, never a forced trade", () => {
  const m = randomMarket(5);
  assert.equal(decideTranche(m.venues, policyFor(m), 60_000_000n, 100_000_000n, 25_000_000n).action, "none");
  const thin = decideTranche(m.venues, policyFor(m, { maxImpactBps: 0, minTranche: 5_000_000n }), 0n, 100_000_000n, 25_000_000n);
  assert.equal(thin.action, "wait");
  assert.equal(thin.amountIn, 0n);
  const broke = decideTranche(m.venues, policyFor(m), 0n, 500_000n, 25_000_000n);
  assert.equal(broke.action, "wait", "less free money than the minimum tranche");
});

test("the decision is deterministic: the co-signer recomputes exactly what the agent decided", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const m = randomMarket(seed);
    const a = decideTranche(m.venues, policyFor(m), 10_000_000n, 60_000_000n, 25_000_000n);
    const b = decideTranche(m.venues.map((v) => ({ ...v })), policyFor(m), 10_000_000n, 60_000_000n, 25_000_000n);
    assert.equal(a.amountIn, b.amountIn);
    assert.equal(a.action, b.action);
  }
});
