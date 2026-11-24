/**
 * Railway activates a deployment only after /api/health answers 200. These tests run the real public-mode server
 * (real Anvil, real contracts) from a freshly staged release, exactly as the image runs it, and check that the
 * healthcheck answers 503 until the service can genuinely serve, recovers by itself, never changes the chain, and
 * accepts Railway's own probe host while every other cross-origin restriction stays in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { RELEASE_ID, stage } from "../scripts/release-identity.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A staged release (runtime files + manifest) that can run in place, like the image. */
function stagedRelease() {
  const dir = mkdtempSync(join(tmpdir(), "qed-health-"));
  const root = join(dir, "app");
  stage(ROOT, root);
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  return { root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function publicServer(root, port, sandboxPort, anvilPort) {
  const child = spawn(process.execPath, ["--import", "tsx", "agent/scripts/demo-server.mjs"], {
    cwd: root,
    env: { ...process.env, QED_PUBLIC_DEMO: "1", QED_TRUST_PROXY: "1", PORT: String(port), QED_SANDBOX_PORT: String(sandboxPort), QED_DEMO_ANVIL_PORT: String(anvilPort), QED_OFFLINE: "1", ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log = (log + d).slice(-2000)));
  child.stderr.on("data", (d) => (log = (log + d).slice(-2000)));
  return { child, log: () => log };
}
/** node:http lets us send Railway's probe Host header (fetch forbids setting Host). */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, data: {} }); } });
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}
const health = (port, headers) => get(port, "/api/health", headers);

test("startup is 503 until ready, then 200; Railway's probe host is accepted; checks have no side effects; resets and a paused Anvil recover", { timeout: 180_000 }, async () => {
  const rel = stagedRelease();
  const t0 = Date.now();
  const srv = publicServer(rel.root, 14295, 18795, 18695);
  try {
    const seen = [];
    const first200 = await until(async () => {
      const h = await health(14295);
      seen.push(h.status);
      return h.status === 200 ? h : undefined;
    }, 60_000, "readiness");
    const readyMs = Date.now() - t0;
    console.log(`time to ready: ${readyMs} ms (Railway healthcheck timeout on the service: 120 s)`);
    assert.ok(seen.includes(503), `a 503 was served while starting (saw ${[...new Set(seen)]})`);
    assert.ok(readyMs < 60_000);
    assert.equal(first200.data.status, "ok");
    assert.equal(first200.data.ready, true);
    assert.deepEqual({ ...first200.data.readiness, checkedAt: undefined }, { sandbox: "ready", anvil: true, contracts: true, manifest: true, checkedAt: undefined });
    assert.equal(first200.data.releaseId, RELEASE_ID);
    assert.equal(first200.data.sourceVerified, true);
    assert.equal(first200.data.modelConfigured, false, "no Anthropic key, yet ready");

    // Railway probes with Host: healthcheck.railway.app and no Origin.
    const probe = await health(14295, { Host: "healthcheck.railway.app" });
    assert.equal(probe.status, 200);
    assert.equal(probe.data.ready, true);
    // Cross-origin restrictions are unchanged for everything else (and for health with a foreign Origin).
    assert.equal((await get(14295, "/api/sandbox/state", { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await health(14295, { Origin: "https://attacker.example" })).status, 403);

    // Health checks are read-only: many of them change neither the chain nor the history.
    const before = (await get(14295, "/api/sandbox/state")).data;
    for (let i = 0; i < 50; i++) assert.equal((await health(14295, { Host: "healthcheck.railway.app" })).status, 200);
    const after = (await get(14295, "/api/sandbox/state")).data;
    assert.equal(after.network.block, before.network.block, "no block mined by health checks");
    assert.equal(after.history.length, before.history.length);

    // A sandbox reset does not leave readiness failing.
    const reset = await fetch("http://127.0.0.1:14295/api/sandbox/reset", { method: "POST", headers: { "Content-Type": "application/json", "X-QED-Client": randomUUID(), "Idempotency-Key": randomUUID() }, body: "{}" });
    assert.equal(reset.status, 202);
    await until(async () => (await get(14295, "/api/sandbox/state")).data.resets === 1, 30_000, "reset");
    assert.equal((await until(async () => { const h = await health(14295); return h.status === 200 ? h : undefined; }, 10_000, "ready after reset")).data.ready, true);

    // An unresponsive Anvil makes the service unready, and it recovers without a restart.
    const anvilPid = Number(execFileSync("pgrep", ["-f", "anvil --port 18795"]).toString().trim().split("\n")[0]);
    process.kill(anvilPid, "SIGSTOP");
    try {
      const down = await until(async () => { const h = await health(14295); return h.status === 503 ? h : undefined; }, 15_000, "503 while Anvil is paused");
      assert.equal(down.data.readiness.anvil, false);
      assert.equal(down.data.status, "unavailable");
    } finally {
      process.kill(anvilPid, "SIGCONT");
    }
    const back = await until(async () => { const h = await health(14295); return h.status === 200 ? h : undefined; }, 15_000, "recovery");
    assert.equal(back.data.readiness.anvil, true);
  } catch (e) {
    console.log(`server log: ${srv.log()}`);
    throw e;
  } finally {
    srv.child.kill("SIGTERM");
    await sleep(500);
    rel.cleanup();
  }
});

test("a release whose files do not match its manifest never becomes ready", { timeout: 120_000 }, async () => {
  const rel = stagedRelease();
  appendFileSync(join(rel.root, "product/index.html"), "\n<!-- altered after staging -->\n");
  const srv = publicServer(rel.root, 14296, 18796, 18696);
  try {
    await until(async () => (await get(14296, "/api/sandbox/state")).data.status === "ready", 60_000, "sandbox");
    await sleep(2_500);
    const h = await health(14296, { Host: "healthcheck.railway.app" });
    assert.equal(h.status, 503);
    assert.equal(h.data.readiness.sandbox, "ready");
    assert.equal(h.data.readiness.manifest, false);
    assert.equal(h.data.sourceVerified, false);
    assert.equal(h.data.status, "unavailable");
  } finally {
    srv.child.kill("SIGTERM");
    await sleep(500);
    rel.cleanup();
  }
});

test("a sandbox that fails to initialise keeps the healthcheck at 503 with the reason", { timeout: 60_000 }, async () => {
  const rel = stagedRelease();
  const blocker = createServer().listen(18797, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const srv = publicServer(rel.root, 14297, 18797, 18697);
  try {
    const h = await until(async () => { const r = await health(14297); return r.data.sandbox === "failed" ? r : undefined; }, 30_000, "failed state");
    assert.equal(h.status, 503);
    assert.equal(h.data.status, "unavailable");
    assert.equal(h.data.ready, false);
    assert.match(h.data.sandboxError, /already in use/);
    await sleep(2_500);
    assert.equal((await health(14297)).status, 503, "stays unready");
  } finally {
    srv.child.kill("SIGTERM");
    blocker.close();
    await sleep(500);
    rel.cleanup();
  }
});
