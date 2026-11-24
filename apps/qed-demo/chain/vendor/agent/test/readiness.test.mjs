import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cachedProbe, readinessReport } from "../scripts/readiness.mjs";

const verified = { sourceDigest: "a".repeat(64), sourceVerified: true };
const up = { anvil: true, contracts: true };
const report = (o) => readinessReport({ publicMode: true, sandboxStatus: "ready", probe: up, identity: verified, now: 0, ...o });

test("a ready public service answers 200 with every readiness check true", () => {
  const r = report({});
  assert.equal(r.httpStatus, 200);
  assert.equal(r.ready, true);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.readiness, { sandbox: "ready", anvil: true, contracts: true, manifest: true, checkedAt: "1970-01-01T00:00:00.000Z" });
});

test("public startup, failed initialisation, unresponsive Anvil, missing contracts and an unverified manifest all answer 503", () => {
  assert.deepEqual([report({ sandboxStatus: "starting", probe: { anvil: false, contracts: false } })].map((r) => [r.httpStatus, r.status, r.ready]), [[503, "starting", false]]);
  assert.deepEqual([report({ sandboxStatus: "failed", probe: { anvil: false, contracts: false } })].map((r) => [r.httpStatus, r.status]), [[503, "unavailable"]]);
  assert.equal(report({ probe: { anvil: false, contracts: false } }).httpStatus, 503);
  assert.equal(report({ probe: { anvil: true, contracts: false } }).httpStatus, 503);
  const bad = report({ identity: { sourceDigest: "a".repeat(64), sourceVerified: false } });
  assert.equal(bad.httpStatus, 503);
  assert.equal(bad.readiness.manifest, false);
  assert.equal(report({ identity: { sourceDigest: null, sourceVerified: false } }).httpStatus, 503, "public mode requires a manifest");
});

test("local development keeps HTTP 200 and reports the manifest as not required", () => {
  const r = readinessReport({ publicMode: false, sandboxStatus: "starting", probe: { anvil: false, contracts: false }, identity: { sourceDigest: null, sourceVerified: false } });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.status, "ok");
  assert.equal(r.ready, false);
  assert.equal(r.readiness.manifest, null);
});

test("readiness recovers on the next probe after a transient failure (no sticky state)", async () => {
  let t = 0, healthy = false, calls = 0;
  const probe = cachedProbe(async () => { calls++; if (!healthy) throw new Error("anvil paused"); return up; }, 2_000, () => t);
  assert.deepEqual(await probe(), { anvil: false, contracts: false });
  healthy = true;
  assert.deepEqual(await probe(), { anvil: false, contracts: false }, "cached within the TTL");
  t = 2_001;
  assert.deepEqual(await probe(), up, "re-probed after the TTL");
  assert.equal(report({ probe: await probe() }).httpStatus, 200);
  const [a, b] = await Promise.all([(t = 5_000, probe()), probe()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 3, "concurrent requests share one probe");
});

test("Anthropic availability never gates readiness, and the health response keeps its existing fields", () => {
  assert.equal(report({}).httpStatus, 200, "readiness takes no model input at all");
  const server = readFileSync(new URL("../scripts/demo-server.mjs", import.meta.url), "utf8");
  const health = server.slice(server.indexOf('parts.join("/")==="api/health"'), server.indexOf('parts.join("/")==="api/chat"'));
  for (const field of ["status:r.status", "ready:r.ready", "readiness:r.readiness", "releaseId:RELEASE_ID", "sourceDigest:", "sourceVerified:", "mode:", "network:", "modelConfigured:", "aiEngine:", "claudeObserved:", "sandbox:sandbox.status", "sandboxError:", "active:"])
    assert.ok(health.includes(field), field);
  assert.match(health, /json\(res,r\.httpStatus,/);
  assert.doesNotMatch(health, /exclusive|convert|reset\(|send\(/, "a health check never queues or sends anything");
  const sandbox = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const probe = sandbox.slice(sandbox.indexOf("async probe()"), sandbox.indexOf("private rpc("));
  assert.match(probe, /getChainId\(\)/);
  assert.doesNotMatch(probe, /exclusive|sendTransaction|evm_|anvil_|this\.c\./, "the probe is read-only and bypasses the operation queue");
});
