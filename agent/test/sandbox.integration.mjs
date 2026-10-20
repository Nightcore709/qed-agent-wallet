/**
 * Live sandbox acceptance test (no mocks): the browser API drives the real QED contracts on a fresh Anvil chain.
 * Variable amounts execute with an on-chain best-execution proof; over-limit amounts are refused before signing;
 * an inferior route is mined as a NotBestExecution revert; a standing policy converts and then stops at its target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const base = "http://127.0.0.1:14274";
const req = async (path, body) => {
  const r = await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
async function job(path, body) {
  const s = await req(path, body);
  assert.equal(s.status, 202, JSON.stringify(s.data));
  for (let i = 0; i < 240; i++) {
    const j = (await req(`/api/jobs/${s.data.id}`)).data;
    if (j.status !== "running") {
      assert.equal(j.status, "done", j.error ?? "");
      return j.result;
    }
    await sleep(250);
  }
  throw new Error("job timed out");
}

test("live sandbox: variable conversions, refusals, inferior-route revert, policy stop", { timeout: 300_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "agent/scripts/demo-server.mjs"], {
    env: { ...process.env, PORT: "14274", QED_SANDBOX_PORT: "18746", QED_SANDBOX_RECORDS: "evidence/demo-runs/sandbox-test", QED_OFFLINE: "1", ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log = (log + d).slice(-4000)));
  child.stderr.on("data", (d) => (log = (log + d).slice(-4000)));
  try {
    let ready = false;
    for (let i = 0; i < 400 && !ready; i++) {
      if (child.exitCode !== null) throw new Error("server exited");
      try { ready = (await req("/api/health")).data.sandbox === "ready"; } catch {}
      if (!ready) await sleep(250);
    }
    if (!ready) {
      const st = await req("/api/sandbox/state").catch(() => ({ data: {} }));
      console.log(`::error title=sandbox did not start::${JSON.stringify(st.data).slice(0, 300)} ${log.replace(/\n/g, " | ").slice(-700)}`);
    }
    assert.ok(ready, "sandbox chain must deploy");

    // a question is answered from chain state and never executes
    const q = await req("/api/agent", { message: "Would converting 80 tUSD violate my mandate?" });
    assert.equal(q.data.kind, "check");
    assert.equal(q.data.allowed, false);
    assert.equal(q.data.execution, "none");

    // two different authorised amounts, each a mined transaction with the proof inside 1 ppm
    const before = (await req("/api/sandbox/state")).data;
    for (const [text, amount] of [["Convert 10 tUSD to tEUR", 10_000_000n], ["Convert 22.5 tUSD to tEUR", 22_500_000n]]) {
      const r = await job("/api/sandbox/convert", { instruction: text });
      assert.equal(r.outcome, "executed", r.summary);
      assert.equal(r.tx.status, "success");
      assert.match(r.tx.hash, /^0x[0-9a-f]{64}$/);
      const t = (await req("/api/sandbox/state")).data.lastTrade;
      assert.equal(BigInt(t.amountIn), amount);
      assert.ok(BigInt(t.amountOut) <= BigInt(t.bound) && Number(t.gapPpm) <= 1, "output within 1 ppm of the on-chain bound");
    }
    const after = (await req("/api/sandbox/state")).data;
    assert.equal(BigInt(before.treasury.balance) - BigInt(after.treasury.balance), 32_500_000n, "treasury reconciled");
    assert.ok(BigInt(after.reserve.balance) > BigInt(before.reserve.balance), "reserve increased");

    // above the signed per-conversion cap: refused before any signature, nothing sent
    const refused = await job("/api/sandbox/convert", { instruction: "Convert 80 tUSD to tEUR" });
    assert.equal(refused.outcome, "refused");
    assert.equal(refused.tx, undefined);

    // an inferior route with a genuine co-signed order: mined, reverted by QEDExecution
    const bad = await job("/api/sandbox/attack", { kind: "inferior-route" });
    assert.equal(bad.outcome, "reverted");
    assert.equal(bad.tx.error, "NotBestExecution");

    // a standing policy: the agent converts until the target is met, then stops without a transaction
    const target = Math.ceil(Number(after.reserve.free) / 1e6) + 12;
    assert.equal((await job("/api/sandbox/policy", { targetFree: target })).outcome, "executed");
    let stopped = false;
    for (let i = 0; i < 6 && !stopped; i++) {
      const t = await job("/api/sandbox/policy-tick", {});
      if (t.outcome === "no-action") stopped = true;
      else assert.equal(t.outcome, "executed", t.summary);
    }
    assert.ok(stopped, "the policy stops at its target");
    assert.ok(BigInt((await req("/api/sandbox/state")).data.reserve.free) >= BigInt(target) * 1_000_000n);
  } catch (e) {
    console.log(`::error title=sandbox acceptance failed::${String(e.message).replace(/\n/g, " ").slice(0, 400)} | server: ${log.replace(/\n/g, " | ").slice(-600)}`);
    throw e;
  } finally {
    child.kill("SIGTERM");
  }
});
