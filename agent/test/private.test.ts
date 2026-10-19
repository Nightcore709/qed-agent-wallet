import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CIRCUIT,
  ONE,
  certifyFixed,
  checkWitness,
  commitData,
  commitWeights,
  covFromFixed,
  prove,
  shutdownProver,
  verifyOffchain,
  type PrivateWitness,
} from "../src/engine/privateMinvar.js";
import { privateCovariance } from "../src/engine/privateScenario.js";
import { solveFloat } from "../src/engine/minvar.js";

const vkey = JSON.parse(readFileSync(CIRCUIT.vkey, "utf8"));
const cov = privateCovariance();
const cert = certifyFixed(cov);
const provider = 0x77e6ff5628e5c193bd37c337c0ae3c86b444a65fn;

async function witness(over: Partial<PrivateWitness> = {}): Promise<PrivateWitness> {
  const saltData = 11n;
  return { cov, saltData, ...cert, saltW: 22n, dataCommitment: await commitData({ cov, salt: saltData }), provider, ...over };
}

after(async () => {
  await shutdownProver();
});

test("certificate for the private model satisfies every circuit constraint, with zero duality gap", () => {
  const r = checkWitness({ cov, ...cert });
  assert.ok(r.ok, r.violations.join("; "));
  assert.equal(r.gap, 0n);
  assert.equal(cert.w.reduce((a, b) => a + b, 0n), ONE);
  assert.equal(cert.w[4], 0n, "venture capital is excluded…");
  assert.ok(cert.mu[4] > 0n, "…and its multiplier proves adding it would raise risk");
});

test("fixed-point optimum matches the exact solver to 1e-12 per weight", () => {
  const { w } = solveFloat(covFromFixed(cov));
  cert.w.forEach((wi, i) => assert.ok(Math.abs(Number(wi) / 1e12 - w[i]) < 1e-11, `w[${i}]`));
});

test("Groth16 proof verifies, and its public signals commit to the data, the portfolio and the provider", async () => {
  const x = await witness();
  const p = await prove(x);
  assert.ok(await verifyOffchain(vkey, p.raw));
  assert.equal(p.signals.dataCommitment, x.dataCommitment);
  assert.equal(p.signals.weightsCommitment, await commitWeights(cert.w, 22n));
  assert.equal(p.signals.provider, provider);
  assert.equal(p.signals.variance, checkWitness(x).variance);
});

test("a tampered public signal fails verification", async () => {
  const p = await prove(await witness());
  for (const k of [0, 1, 3]) {
    const bad = { proof: p.raw.proof, publicSignals: p.raw.publicSignals.map((s, i) => (i === k ? (BigInt(s) + 1n).toString() : s)) };
    assert.equal(await verifyOffchain(vkey, bad), false, `signal ${k}`);
  }
});

test("no proof exists for a lazy 1/N portfolio, a nudged optimum, or a different data set", async () => {
  const w = Array(6).fill(ONE / 6n);
  w[0] += ONE - w.reduce((a: bigint, b: bigint) => a + b, 0n);
  await assert.rejects(prove(await witness({ w, mu: Array(6).fill(0n) })), /Assert Failed/);
  const nudged = [...cert.w];
  nudged[0] += ONE / 10_000n;
  nudged[5] -= ONE / 10_000n; // one basis point
  assert.equal(checkWitness({ cov, ...cert, w: nudged }).ok, false);
  await assert.rejects(prove(await witness({ w: nudged })), /Assert Failed/);
  await assert.rejects(prove(await witness({ dataCommitment: 12345n })), /Assert Failed/);
});
