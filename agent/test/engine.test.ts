import { test } from "node:test";
import assert from "node:assert/strict";
import { certify, checkCertificate, counterfeitEqualWeight, counterfeitNudged, solveFloat, covFromWad, wadToNumber, WAD } from "../src/engine/minvar.js";
import { covarianceFrom, helixSpec, HELIX_CORR, HELIX_VOLS } from "../src/engine/riskModel.js";
import { evaluateJob, priceFor } from "../src/engine/economics.js";

const U = (x: number) => BigInt(Math.round(x * 1e6));

test("certifying solver: honest certificate passes with zero stationarity residual", () => {
  const spec = helixSpec();
  const sol = certify(spec);
  const r = checkCertificate(spec, sol);
  assert.ok(r.ok, r.violations.join(","));
  assert.equal(sol.w.reduce((a, b) => a + b, 0n), WAD, "budget is exact");
  assert.ok(sol.w.every((w) => w >= 0n), "long-only");
  assert.ok(r.optimalityBound < 1e-7);
});

test("solver matches brute-force grid search on the simplex (independent oracle)", () => {
  const S = covarianceFrom(HELIX_VOLS, HELIX_CORR);
  const { w } = solveFloat(S);
  const f = (x: number[]) => x.reduce((acc, xi, i) => acc + xi * x.reduce((a, xj, j) => a + S[i][j] * xj, 0), 0);
  const best = f(w);
  // random feasible portfolios can never beat the certified optimum
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 0; k < 20000; k++) {
    const raw = S.map(() => -Math.log(rnd() + 1e-12));
    const s = raw.reduce((a, b) => a + b, 0);
    const x = raw.map((v) => v / s);
    assert.ok(f(x) >= best - 1e-12, `found a better portfolio at iteration ${k}`);
  }
});

test("lazy 1/N forgery fails ONLY on complementary slackness, and the gap bounds its suboptimality", () => {
  const spec = helixSpec();
  const r = checkCertificate(spec, counterfeitEqualWeight(spec));
  assert.equal(r.ok, false);
  assert.ok(r.violations.every((v) => v.startsWith("DualityGapTooLarge")), r.violations.join(","));
  const opt = wadToNumber(checkCertificate(spec, certify(spec)).variance);
  const lazy = wadToNumber(r.variance);
  assert.ok(lazy - opt <= wadToNumber(r.dualityGap) * 2 + 1e-12, "half-variance gap ≤ duality gap");
});

test("a 0.01% nudge of the optimum is rejected", () => {
  const spec = helixSpec();
  assert.equal(checkCertificate(spec, counterfeitNudged(spec, 1n)).ok, false);
});

test("covariance round-trips through fixed point", () => {
  const spec = helixSpec();
  const S = covFromWad(spec.n, spec.cov);
  assert.ok(Math.abs(S[3][3] - 0.36) < 1e-12);
});

test("economics: price = cost × 2.5 rounded up; unsettled revenue never counts as capital", () => {
  assert.equal(priceFor(U(6)), U(15));
  const t = { balance: U(100), protectedBalance: U(70), free: U(30), dailyCap: U(25), spentInWindow: 0n };
  const e = evaluateJob(t, [{ label: "data", amount: U(6) }], U(20), 24);
  assert.ok(e.accept);
  assert.equal(e.postTradeFree, U(24));
  const tight = evaluateJob({ ...t, free: U(9) }, [{ label: "data", amount: U(6) }], U(20), 24);
  assert.equal(tight.accept, false, "would breach the reserve buffer");
  const cheap = evaluateJob(t, [{ label: "data", amount: U(6) }], U(12), 24);
  assert.equal(cheap.accept, false, "client budget below price");
});
