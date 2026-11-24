/**
 * Sandbox clock regression (real Anvil, no mocks of the chain or contracts).
 *
 * Root cause reproduced on 23 Oct 2026: `evm_revert` rewinds Anvil's clock to the snapshot block, so after a
 * sandbox reset the chain ran behind real time while certificates were issued from real time
 * (sandboxClock.ts). The next conversion reverted with QEDVault.CertificateNotActive (0x4205b2b5).
 *
 * Most cases below simulate inactivity deterministically: the in-process wall clock (Date.now) and Anvil
 * (evm_increaseTime) advance together, exactly as real idle time would. The last test waits for real and
 * goes through the server's own automatic idle reset. No validity window, cap or check is relaxed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { toHex } from "viem";
import { Sandbox } from "../src/sandbox.ts";
import { fn } from "../src/chain.ts";
import { QEDExecutionAbi } from "../src/abi/contracts.ts";
import { ownerTradeMessage } from "../src/roles/cosigner.ts";
import { decide, hopsForChain, planTrade, pricesForChain } from "../src/roles/trader.ts";
import { signCertificate } from "../src/protocol/eip712.ts";

process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const realNow = Date.now.bind(Date);
let offsetMs = 0;
const wall = () => Math.floor(Date.now() / 1000);
function shiftWallClock(ms) {
  offsetMs += ms;
  Date.now = () => realNow() + offsetMs;
}
function restoreWallClock() {
  offsetMs = 0;
  Date.now = realNow;
}
/** Deterministic inactivity: real time and the chain's own clock both move forward by `seconds`. */
async function idle(s, seconds) {
  shiftWallClock(seconds * 1000);
  await s.c.pub.request({ method: "evm_increaseTime", params: [toHex(seconds)] });
}
const chainTime = async (s) => Number((await s.c.pub.getBlock()).timestamp);
async function assertAligned(s, label) {
  const drift = (await chainTime(s)) - wall();
  assert.ok(Math.abs(drift) <= 5, `${label}: chain clock drifts ${drift}s from wall clock`);
}
function assertExecuted(r, amountLabel) {
  assert.equal(r.outcome, "executed", `${amountLabel}: ${r.summary}`);
  assert.equal(r.tx.status, "success");
  assert.match(r.tx.hash, /^0x[0-9a-f]{64}$/);
}

/** A genuine, owner-confirmed and co-signed conversion, built exactly as Sandbox.convert does, but not sent. */
async function cosignedTrade(s, amountIn, nonce) {
  const { usd, eur, reserve, exec, vault } = s.a;
  const instructionSig = await s.K.OWNER.signMessage({ message: ownerTradeMessage(vault, amountIn, usd, eur, reserve, nonce) });
  const r = await s.cosigner.evaluateTrade({ mandate: s.mandate, ownerSig: s.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn, instruction: `clock regression ${nonce}`, nonce, instructionSig, brainEngine: "clock regression test" });
  assert.equal(r.approved, true, (r.reasons ?? []).join("; "));
  const tp = await planTrade(s.c.pub, exec, usd, eur, amountIn);
  assert.equal(decide(tp, r.order).submit, true);
  const build = (certificate, signature) => fn(QEDExecutionAbi, "trade", [s.mandate, s.ownerSig, certificate, signature, r.order, hopsForChain(tp.plan.route), pricesForChain(tp.plan.prices)]);
  return { certificate: r.certificate, signature: r.signature, data: build(r.certificate, r.signature), build };
}
/** Mine the trade in a block with exactly timestamp `ts`; decode the revert reason in that same block. */
async function mineAt(s, ts, data) {
  await s.c.pub.request({ method: "evm_setNextBlockTimestamp", params: [toHex(ts)] });
  const hash = await s.c.wallet(s.K.OPERATOR).sendTransaction({ account: s.K.OPERATOR, chain: s.c.chain, to: s.a.exec, data, gas: 3_000_000n, ...s.c.fees });
  const receipt = await s.c.pub.waitForTransactionReceipt({ hash });
  const block = await s.c.pub.getBlock({ blockNumber: receipt.blockNumber });
  assert.equal(Number(block.timestamp), ts, "block mined at the requested timestamp");
  const error = receipt.status === "reverted" ? await s.c.simulateError(s.K.OPERATOR.address, s.a.exec, data, receipt.blockNumber) : undefined;
  return { receipt, error };
}
const rpc = (s, method, params = []) => s.c.pub.request({ method, params });

test("deterministic idle time: conversions, multiple resets, 22.50 tUSD, attack, policy and workbench stay on time", { timeout: 300_000 }, async () => {
  const s = new Sandbox(18781, "evidence/demo-runs/clock-test-a");
  try {
    await s.start();
    await assertAligned(s, "fresh start");
    assert.equal((await s.state()).mandate.version, 1, "the first signed mandate is v1, as after a reset");
    assertExecuted(await s.convert("Convert 10 tUSD to tEUR"), "fresh 10");

    // The original production failure: a long-idle chain whose last block is hours old, no reset in between.
    await idle(s, 5 * 3600);
    assertExecuted(await s.convert("Convert 22.50 tUSD to tEUR"), "22.50 after 5 h idle, no reset");
    await assertAligned(s, "after idle conversion");

    // The regression: reset after inactivity, then convert immediately. Repeated resets must all stay aligned.
    for (const [n, seconds] of [[1, 20 * 60], [2, 3 * 3600], [3, 0]]) {
      if (seconds) await idle(s, seconds);
      await s.reset();
      assert.equal(s.resets, n);
      await assertAligned(s, `reset #${n}`);
      const state = await s.state();
      assert.equal(state.treasury.balance, "100000000", `reset #${n} restores the initial treasury`);
      assert.equal(state.mandate.version, 1);
      assertExecuted(await s.convert("Convert 22.50 tUSD to tEUR"), `22.50 immediately after reset #${n}`);
    }

    // Attacks must fail — and be recorded — for their own reason, not because of a stale clock. After idle time
    // the last block is old; the reason must come from the block the attack was actually mined in.
    await idle(s, 10 * 60);
    for (const kind of ["forged-proof", "inferior-route"]) {
      const bad = await s.attack(kind);
      assert.equal(bad.outcome, "reverted");
      assert.equal(bad.tx.error, "NotBestExecution", `${kind} after idle`);
    }

    // Standing policy after a reset: the co-signed tranche settles on time.
    await idle(s, 30 * 60);
    await s.reset();
    assert.equal((await s.setPolicy(20)).outcome, "executed");
    const tick = await s.policyTick();
    assert.equal(tick.outcome, "executed", tick.summary);
    assert.equal(tick.tx.status, "success");

    // Workbench scenarios after a reset: mandate validity and liability maturity use the same clock.
    await idle(s, 45 * 60);
    await s.reset();
    await assertAligned(s, "reset before workbench");
    for (const [name, input] of [["payment", { amount: "3.123456" }], ["liability", { amount: "70.123456" }]]) {
      const r = await s.workbench(name, input);
      assert.equal(r.outcome, "executed", `${name}: ${r.summary}`);
      assert.equal(r.tx.status, "success");
    }
    await assertAligned(s, "after workbench");
  } finally {
    restoreWallClock();
    s.stop();
  }
});

test("certificate validity window: inclusive bounds, expired, not yet active, forged and replayed certificates are refused on-chain", { timeout: 180_000 }, async () => {
  const s = new Sandbox(18782, "evidence/demo-runs/clock-test-b");
  try {
    await s.start();

    // expiresAt is inclusive; one second later the vault refuses the same genuine certificate.
    const exp = await cosignedTrade(s, 5_000_000n, `boundary-exp-${randomUUID()}`);
    const E = Number(exp.certificate.expiresAt);
    assert.equal(E - Number(exp.certificate.notBefore), 4 * 3600 + 60, "certificate window unchanged: [now − 60 s, now + 4 h]");
    const beforeExpiry = await rpc(s, "evm_snapshot");
    const late = await mineAt(s, E + 1, exp.data);
    assert.equal(late.receipt.status, "reverted");
    assert.equal(late.error.name, "CertificateNotActive");
    assert.equal(late.error.selector, "0x4205b2b5");
    assert.equal(late.error.args[2], BigInt(E + 1));
    await rpc(s, "evm_revert", [beforeExpiry]);
    const onTime = await mineAt(s, E, exp.data);
    assert.equal(onTime.receipt.status, "success", "valid at exactly expiresAt");
    // The same certificate can never pay twice.
    assert.equal((await s.c.simulateError(s.K.OPERATOR.address, s.a.exec, exp.data)).name, "IntentAlreadyUsed");
    await s.reset();
    await assertAligned(s, "reset after expiry checks");

    // notBefore is inclusive; a certificate issued from a clock ahead of the chain is not yet active.
    shiftWallClock(10 * 60_000);
    const early = await cosignedTrade(s, 5_000_000n, `boundary-nb-${randomUUID()}`);
    restoreWallClock();
    const NB = Number(early.certificate.notBefore);
    assert.ok(NB > (await chainTime(s)) + 1, "notBefore lies in the chain's future");
    const beforeActive = await rpc(s, "evm_snapshot");
    const tooEarly = await mineAt(s, NB - 1, early.data);
    assert.equal(tooEarly.receipt.status, "reverted");
    assert.equal(tooEarly.error.name, "CertificateNotActive");
    assert.equal(tooEarly.error.args[2], BigInt(NB - 1));
    await rpc(s, "evm_revert", [beforeActive]);
    assert.equal((await mineAt(s, NB, early.data)).receipt.status, "success", "valid at exactly notBefore");
    await s.reset();
    await assertAligned(s, "reset after notBefore checks");

    // Unauthorized certificates: a non-co-signer signature, and a co-signed certificate altered afterwards.
    const genuine = await cosignedTrade(s, 4_000_000n, `forged-${randomUUID()}`);
    const forgedSig = await signCertificate(s.K.MALLORY, 31337, s.a.vault, genuine.certificate);
    const forged = await s.c.sendExpectingRevert(s.K.OPERATOR, s.a.exec, genuine.build(genuine.certificate, forgedSig), 2_000_000n);
    assert.equal(forged.error.name, "BadCosignerSignature");
    const altered = { ...genuine.certificate, evidenceHash: `0x${"ab".repeat(32)}` };
    const tampered = await s.c.sendExpectingRevert(s.K.OPERATOR, s.a.exec, genuine.build(altered, genuine.signature), 2_000_000n);
    assert.equal(tampered.error.name, "BadCosignerSignature");
    // …while the untouched certificate still settles, proving the refusals were about authority, not time.
    assert.equal((await s.c.send(s.K.OPERATOR, s.a.exec, genuine.data)).status, "success");
  } finally {
    restoreWallClock();
    s.stop();
  }
});

test("genuine inactivity: the server's own idle reset, then 22.50 tUSD through the browser API", { timeout: 300_000 }, async () => {
  const base = "http://127.0.0.1:14291";
  const client = randomUUID();
  const req = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-QED-Client": client, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const job = async (accepted) => {
    assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
    for (let i = 0; i < 360; i++) {
      const j = (await req(`/api/jobs/${accepted.data.id}`)).data;
      if (j.status !== "running") {
        assert.equal(j.status, "done", j.error ?? "");
        return j.result;
      }
      await sleep(250);
    }
    throw new Error("job timed out");
  };
  const child = spawn(process.execPath, ["--import", "tsx", "agent/scripts/demo-server.mjs"], {
    // One idle minute: the server checks every 60 s, so the reset lands about two minutes after the startup
    // snapshot — beyond the certificate's 60 s notBefore grace, which a shorter wait would hide.
    env: { ...process.env, PORT: "14291", QED_SANDBOX_PORT: "18791", QED_DEMO_ANVIL_PORT: "18691", QED_SANDBOX_RECORDS: "evidence/demo-runs/clock-test-c", QED_OFFLINE: "1", ANTHROPIC_API_KEY: "", QED_IDLE_RESET_MIN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log = (log + d).slice(-3000)));
  child.stderr.on("data", (d) => (log = (log + d).slice(-3000)));
  try {
    let ready = false;
    for (let i = 0; i < 400 && !ready; i++) {
      try { ready = (await req("/api/health")).data.sandbox === "ready"; } catch {}
      if (!ready) await sleep(250);
    }
    assert.ok(ready, `sandbox must start: ${log}`);
    const first = await job(await req("/api/sandbox/convert", { instruction: "Convert 10 tUSD to tEUR" }, { "Idempotency-Key": randomUUID() }));
    assert.equal(first.outcome, "executed", first.summary);

    // Real idle time: the server's interval resets the shared sandbox once the idle period has passed.
    let resets = 0;
    for (let i = 0; i < 200 && resets < 1; i++) {
      await sleep(1000);
      resets = (await req("/api/sandbox/state")).data.resets;
    }
    assert.equal(resets, 1, "automatic idle reset happened");
    const after = (await req("/api/sandbox/state")).data;
    assert.equal(after.treasury.balance, "100000000");
    const sinceStart = (Date.now() - Date.parse(after.startedAt)) / 1000;
    assert.ok(sinceStart >= 65, `reset happened ${sinceStart}s after startup; must exceed the 60 s certificate grace`);

    // The exact production failure: 22.50 tUSD → tEUR, prepared and confirmed through the agent tool API.
    const p = await req("/api/tools/prepare", { tool: "convert", parameters: { amount: "22.50" } });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.allowed, true);
    const key = randomUUID();
    const accepted = await req("/api/tools/confirm", { proposalId: p.data.proposalId }, { "Idempotency-Key": key });
    const dup = await req("/api/tools/confirm", { proposalId: p.data.proposalId }, { "Idempotency-Key": key });
    assert.equal(dup.data.duplicate, true);
    assert.equal(dup.data.id, accepted.data.id);
    const r = await job(accepted);
    assert.equal(r.outcome, "executed", r.summary);
    assert.equal(r.tx.status, "success");
    assert.match(r.tx.hash, /^0x[0-9a-f]{64}$/);
  } catch (e) {
    console.log(`server log: ${log.slice(-1200)}`);
    throw e;
  } finally {
    child.kill("SIGTERM");
  }
});
