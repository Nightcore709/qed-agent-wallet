/**
 * The standing treasury policy on a real local chain: sign once, tick, the five candidates per tick, a server-side
 * run until the target is met with its stop conditions, the co-signer's re-derivation, and supersession.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { recoverMessageAddress } from "viem";
import { approve, freshDir, key, startRail, type TestRail } from "./helpers.ts";
import { RailError } from "../rail/service.ts";
import { devAccount } from "../rail/keys.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

let t: TestRail;
before(async () => { t = await startRail("policy", 18591); await t.ready(); });
after(async () => { await t.stop(); });
const tick = async (r = t) => r.rail.waitForJob(r.rail.submit("policy-tick", {}, key()).jobId);
const rejects = async (f: () => unknown, code: string) => assert.rejects(async () => f(), (e: unknown) => e instanceof RailError && e.code === code);

test("without a signed policy a tick does nothing; the policy's bounds are the release's", async () => {
  const job = await tick();
  assert.equal(job.status, "failed");
  assert.match(job.error!, /No standing policy yet: the owner must sign one first\./);
  assert.equal(job.guidance, "Nothing was mined for this operation. No money moved.");
  assert.equal((await t.rail.state()).policy, null);
  for (const bad of ["1.999999", "80.000001", "0"]) await rejects(() => t.rail.propose({ kind: "policy", params: { targetFree: bad } }), bad === "0" ? "invalid_amount" : "invalid_params");
  await rejects(() => t.rail.propose({ kind: "policy", params: { targetFree: "30", enforcement: "contract", needSlackBps: 0 } }), "zero_slack_refused");
  await rejects(() => t.rail.propose({ kind: "policy", params: { targetFree: "30", needSlackBps: 10 } }), "invalid_params");
  await rejects(() => t.rail.submit("policy-run", t.rail.policy.runParams({ maxTicks: 13 }), key()), "invalid_params");
});

test("the owner signs the policy text once; the state shows target, tranche bounds, shortfall and enforcement", async () => {
  const p = await t.rail.propose({ kind: "policy", params: { targetFree: "30" } });
  const msg = p.terms.message as string;
  assert.match(msg, /^QED treasury policy\nvault: 0x[0-9a-fA-F]{40}\nreserve: 0x[0-9a-fA-F]{40}\nkeep free in reserve at least: 30000000 of 0x[0-9a-fA-F]{40}\nconvert from: 0x[0-9a-fA-F]{40}\ntranche: 2000000 to 25000000\nmax impact bps: 150\nvalid until: \d+\nnonce: rail-policy-[0-9a-f]{8}-1$/);
  const job = await t.rail.waitForJob(t.rail.execute(p.id, approve(p), key()).jobId);
  assert.equal(job.result?.outcome, "executed", job.error ?? "");
  const pol = (await t.rail.state()).policy!;
  assert.deepEqual([pol.status, pol.enforcement, pol.targetFree, pol.minTranche, pol.maxTranche, pol.maxImpactBps, pol.ticks, pol.reserveFree, pol.shortfall, pol.targetMet, pol.policyContract], ["active", "cosigner", "30000000", "2000000", "25000000", 150, 0, "0", "30000000", false, null]);
  const signer = await recoverMessageAddress({ message: msg, signature: t.rail.policy.active()!.sig });
  assert.equal(signer, (await t.rail.state()).roles.owner);
  const d = t.rail.decisions(5, job.id);
  assert.deepEqual([d[0].kind, d[0].verdict, d[0].termsHash], ["owner-policy", "SIGNED", p.termsHash]);
});

test("a tick: observe, decide with five candidates, co-signer re-derives (14 checks), trade, reserve re-read", async () => {
  const before = await t.rail.state();
  const job = await tick();
  assert.equal(job.result?.outcome, "executed", job.error ?? job.result?.summary);
  assert.deepEqual(job.steps.map((s) => s.key), ["decide", "cosigner", "plan", "submit", "receipt", "reconcile"]);
  const rec = t.rail.policy.ticks(1)[0];
  assert.equal(rec.n, 1);
  assert.equal(rec.action, "convert");
  assert.deepEqual(Object.keys(rec.candidates).sort(), ["freeFunds", "impact", "mandateCap", "need", "policyCap"]);
  assert.deepEqual([rec.candidates.policyCap, rec.candidates.mandateCap], ["25000000", "25000000"]);
  const numeric = [rec.candidates.impact, rec.candidates.policyCap, rec.candidates.mandateCap, rec.candidates.freeFunds, ...(rec.candidates.need === null ? [] : [rec.candidates.need])].map(BigInt);
  assert.equal(BigInt(rec.amountIn), numeric.reduce((a, b) => (b < a ? b : a)), "X = min(need, impact, policy cap, mandate cap, free funds)");
  assert.ok(["need", "impact", "policy cap", "mandate cap", "free funds"].includes(rec.limitedBy!));
  const dec = t.rail.decisions(10, job.id);
  assert.deepEqual(dec.map((d) => d.kind), ["policy-decision", "cosigner-policy-trade"]);
  const checks = (dec[1].record as { checks: { id: string; pass: boolean }[] }).checks;
  assert.equal(checks.length, 14);
  assert.deepEqual(checks.filter((c) => c.id.startsWith("P")).map((c) => [c.id, c.pass]), [["P1", true], ["P2", true], ["P3", true]]);
  const s = await t.rail.state();
  assert.equal(BigInt(before.treasury.balance) - BigInt(s.treasury.balance), BigInt(rec.amountIn));
  assert.equal(s.policy!.ticks, 1);
  assert.equal(s.lastTrade!.instruction, "standing policy, tick 1");
  assert.equal(s.lastTrade!.engine, "deterministic policy");
  // the same idempotency key never produces a second tick
  const k = key();
  const a = t.rail.submit("policy-tick", {}, k), b = t.rail.submit("policy-tick", {}, k);
  assert.deepEqual([b.duplicate, b.jobId], [true, a.jobId]);
  await t.rail.waitForJob(a.jobId);
  assert.equal((await t.rail.state()).policy!.ticks, 2);
});

test("run until the target is met, on the server: it stops at the target without a transaction, and every tick is recorded", async () => {
  const run = await t.rail.waitForJob(t.rail.submit("policy-run", t.rail.policy.runParams({ maxTicks: 8 }), key()).jobId);
  assert.equal(run.status, "done", run.error ?? "");
  const ev = run.result!.evidence as { ticks: { tick: number; action: string; outcome: string }[]; stopReason: string; targetMet: boolean };
  assert.equal(ev.stopReason, "the target is met");
  assert.equal(ev.targetMet, true);
  assert.deepEqual([ev.ticks.at(-1)!.action, ev.ticks.at(-1)!.outcome], ["none", "no-action"]);
  const s = await t.rail.state();
  assert.ok(BigInt(s.reserve.free) >= 30_000_000n);
  assert.deepEqual([s.policy!.targetMet, s.policy!.shortfall], [true, "0"]);
  assert.equal(t.rail.policy.ticks(50).length, s.policy!.ticks, "every tick has its durable record");
  // once the target is met, further ticks cost nothing and say so
  const idle = await tick();
  assert.deepEqual([idle.result!.outcome, idle.result!.tx, idle.steps.length], ["no-action", undefined, 1]);
  assert.match(idle.result!.summary, /target met \(.* tEUR free\); the agent stops\./);
});

test("stop conditions: the tick limit, and a refusal when the mandate cannot pay for the tranche", async () => {
  const fresh = await startRail("policy-stops", 18592);
  try {
    await fresh.ready();
    assert.equal((await fresh.act("policy", { targetFree: "60" })).result?.outcome, "executed");
    const one = await fresh.rail.waitForJob(fresh.rail.submit("policy-run", { maxTicks: 1, maxSeconds: 120 }, key()).jobId);
    const ev1 = one.result!.evidence as { ticks: unknown[]; stopReason: string; targetMet: boolean; conversions: number };
    assert.deepEqual([ev1.ticks.length, ev1.conversions, ev1.stopReason, ev1.targetMet], [1, 1, "the limit of 1 ticks was reached", false]);
    // a mandate whose lifetime total is nearly used: the next tranche is refused by name, before any signature
    assert.equal((await fresh.act("mandate", { maxPerPayment: "25", maxPerPeriod: "25", maxTotal: "30" })).result?.outcome, "executed");
    const first = await fresh.rail.waitForJob(fresh.rail.submit("policy-tick", {}, key()).jobId);
    assert.equal(first.result!.outcome, "executed", first.result!.summary);
    const run = await fresh.rail.waitForJob(fresh.rail.submit("policy-run", { maxTicks: 6, maxSeconds: 120 }, key()).jobId);
    const ev = run.result!.evidence as { ticks: { outcome: string }[]; stopReason: string };
    assert.equal(ev.stopReason, "a tick was refused");
    assert.equal(ev.ticks.at(-1)!.outcome, "refused");
    assert.match(run.steps.at(-1)!.detail, /Left in the mandate's (current period|lifetime total)/);
    assert.equal(fresh.rail.store.attempts(run.id).length, 0, "nothing was prepared for sending");
  } finally { await fresh.stop(); }
});

test("the co-signer refuses an over-sized tranche (P2), and an older or revoked policy (P0)", async () => {
  const fresh = await startRail("policy-supersede", 18593);
  let stopped = false;
  try {
    await fresh.ready();
    await fresh.act("policy", { targetFree: "12" });
    const A = fresh.rail.a, am = fresh.rail.activeMandate()!, old = fresh.rail.policy.active()!;
    const ask = (policy: unknown, sig: string, amountIn: bigint, nonce: string) => fresh.rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn, instruction: "test", nonce, policy, policySig: sig, brainEngine: "test" });
    // an over-eager agent asks for the whole tranche cap when about 13 tUSD covers the 12 tEUR shortfall
    const greedy = await ask(old.policy, old.sig, 25_000_000n, `${old.policy.nonce}:tick-greedy`);
    assert.equal(greedy.approved, false);
    assert.ok(greedy.reasons.some((r: string) => r.startsWith("P2 ")), greedy.reasons.join(" | "));
    assert.equal(greedy.certificate, undefined);

    // the owner signs a new policy: the old one is refused from then on, although its signature is genuine
    const job = await fresh.act("policy", { targetFree: "40" });
    assert.equal(job.result?.outcome, "executed", job.error ?? "");
    const rows = fresh.rail.store.policies();
    assert.deepEqual(rows.map((r) => r.status), ["active", "superseded"]);
    const stale = await ask(old.policy, old.sig, 5_000_000n, `${old.policy.nonce}:tick-stale`);
    assert.equal(stale.approved, false);
    assert.match(stale.reasons[0], /^P0 .*superseded by the owner's policy 2$/);
    const rec = JSON.parse(stale.record);
    assert.equal(fresh.rail.v.records.hashRecord(rec.core), stale.evidenceHash, "the refusal has a hashed decision record like any other");
    // a policy nobody signed as owner cannot displace the owner's
    const forged = { ...old.policy, nonce: old.policy.nonce.replace(/-1$/, "-9") };
    await assert.rejects(() => fresh.rail.cosigner.registerPolicy(forged, old.sig), /not signed by the vault owner/);
    void devAccount;

    // the owner ends the policy: ticks stop, and the co-signer refuses the ended policy too
    const current = fresh.rail.policy.active()!;
    const end = await fresh.act("policy-revoke");
    assert.equal(end.result?.outcome, "executed", end.error ?? "");
    assert.equal((await fresh.rail.state()).policy, null);
    const dead = await fresh.rail.waitForJob(fresh.rail.submit("policy-tick", {}, key()).jobId);
    assert.match(dead.error!, /No standing policy yet/);
    const revoked = await ask(current.policy, current.sig, 5_000_000n, `${current.policy.nonce}:tick-revoked`);
    assert.match(revoked.reasons[0], /^P0 .*was revoked by the owner/);
    // and all of it survives a restart of the co-signer's state
    const dir = fresh.dir;
    await fresh.stop({ keep: true });
    stopped = true;
    const again = await startRail("policy-supersede", 18593, { dataDir: dir });
    try {
      const am2 = again.rail.activeMandate()!;
      const r = await again.rail.cosigner.evaluateTrade({ mandate: am2.mandate, ownerSig: am2.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "test", nonce: `${current.policy.nonce}:tick-after-restart`, policy: current.policy, policySig: current.sig, brainEngine: "test" });
      assert.match(r.reasons[0], /^P0 .*was revoked by the owner/);
    } finally { await again.stop(); }
  } finally { if (!stopped) await fresh.stop(); }
});

test("parity with the release's own Sandbox: the same target gives the same tranches, tick by tick", { timeout: 180_000 }, async () => {
  const releaseSandbox = "../vendor/agent/src/sandbox.ts";
  const { Sandbox } = await import(releaseSandbox);
  const fresh = await startRail("policy-parity", 18594);
  const sb = new Sandbox(18595, join(freshDir("policy-parity-sandbox"), "records"));
  try {
    await sb.start();
    await fresh.ready();
    await sb.setPolicy(45);
    await fresh.act("policy", { targetFree: "45" });
    for (let i = 1; i <= 6; i++) {
      const r = await sb.policyTick();
      const j = await fresh.rail.waitForJob(fresh.rail.submit("policy-tick", {}, key()).jobId);
      assert.equal(j.result!.outcome, r.outcome, `tick ${i}: ${j.result!.summary} / ${r.summary}`);
      if (r.outcome !== "executed") break;
      const a: any = (await sb.state()).lastTrade, b = (await fresh.rail.state()).lastTrade!;
      assert.deepEqual([b.amountIn, b.amountOut, b.bound, b.floor, b.tolerancePpm, b.cosignerChecks], [a.amountIn, a.amountOut, a.bound, a.floor, a.tolerancePpm, a.cosignerChecks], `tick ${i}`);
    }
    const ra: any = await sb.state(), mb = await fresh.rail.state();
    assert.deepEqual([mb.treasury.balance, mb.reserve.free, mb.policy!.ticks], [ra.treasury.balance, ra.reserve.free, ra.policy.ticks]);
  } finally { sb.stop(); await fresh.stop(); }
});
