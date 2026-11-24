/**
 * Durable idempotency under a hard kill (baseline W-05, F-066): the service process is killed with SIGKILL at three
 * points of one conversion each, restarted on the same data, and the outcome is resolved by lookup. In every case
 * there is at most one execution, and nothing is ever sent a second time.
 *
 * The kill points are a test seam of the service (QED_RAIL_FAULT), honoured only with QED_RAIL_ALLOW_FAULTS=1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { key } from "./helpers.ts";
import { startService as start, type Service } from "./service-helper.ts";
import type { Accepted, Job, Proposal, RailState } from "../types.ts";

const fault = (name: string) => ({ QED_RAIL_ALLOW_FAULTS: "1", QED_RAIL_FAULT: name });
const approval = (p: Proposal) => ({ approvalId: `ap-${key()}`, docHash: "sha256:doc", termsHash: p.termsHash, confirmedAt: new Date().toISOString(), method: "test-owner" });
const exited = (s: Service) => new Promise<void>((resolve, reject) => {
  if (s.child.exitCode !== null || s.child.signalCode) return resolve();
  const t = setTimeout(() => reject(new Error("the service was expected to die at its fault point but is still running")), 30_000);
  s.child.once("exit", () => { clearTimeout(t); resolve(); });
});
const conversions = async (s: Service) => (await s.call("GET", "/history?limit=100")).data.history.filter((h: { kind: string; outcome: string }) => h.kind === "conversion" && h.outcome === "executed").length;

test("killed between accept and reply, after broadcast, and just before the job is marked done: one execution at most, resolved by lookup", { timeout: 240_000 }, async () => {
  const started: Service[] = [];
  const startService: typeof start = async (...args) => { const s = await start(...args); started.push(s); return s; };
  let dir = "";
  try {
    const first = await startService("recovery", 15181, 18621);
    dir = first.dir;
    await first.act("provision");
    await first.act("mandate", { maxPerPayment: "25" });
    assert.equal(await first.stop(), 0);

    // ── A · the process dies after the request is stored and before any reply or work ──
    const a = await startService("recovery", 15181, 18621, { dir, env: fault("after-accept:convert") });
    const pA = (await a.call<Proposal>("POST", "/proposals", { kind: "convert", params: { amount: "10" } })).data;
    const kA = key(), bodyA = { approval: approval(pA) };
    await assert.rejects(() => a.call("POST", `/proposals/${pA.id}/execute`, bodyA, { "Idempotency-Key": kA }), "the caller gets no reply");
    await exited(a);
    assert.equal(a.child.signalCode, "SIGKILL");
    const a2 = await startService("recovery", 15181, 18621, { dir });
    const found = await a2.call("GET", `/submissions/${kA}`);
    assert.equal(found.status, 200, "the accepted request survived the kill");
    const jobA = await a2.job(found.data.jobId);
    assert.deepEqual([jobA.status, jobA.result?.outcome], ["done", "executed"]);
    const again = await a2.call<Accepted>("POST", `/proposals/${pA.id}/execute`, bodyA, { "Idempotency-Key": kA });
    assert.deepEqual([again.status, again.data.jobId, again.data.duplicate], [202, jobA.id, true]);
    let st = (await a2.call<RailState>("GET", "/state")).data;
    assert.deepEqual([st.reserve.balance, st.treasury.balance, await conversions(a2)], ["9107516", "90000000", 1], "exactly one execution");
    assert.equal(st.restoredFromState, true);
    assert.equal(await a2.stop(), 0);

    // ── B · the process dies right after the transaction was broadcast, before the chain state was saved ──
    const b = await startService("recovery", 15181, 18621, { dir, env: fault("after-broadcast:convert") });
    const pB = (await b.call<Proposal>("POST", "/proposals", { kind: "convert", params: { amount: "22.5" } })).data;
    const kB = key(), bodyB = { approval: approval(pB) };
    await b.call("POST", `/proposals/${pB.id}/execute`, bodyB, { "Idempotency-Key": kB }).catch(() => undefined);
    await exited(b);
    const b2 = await startService("recovery", 15181, 18621, { dir });
    const jobB = await b2.job((await b2.call("GET", `/submissions/${kB}`)).data.jobId);
    assert.equal(jobB.status, "interrupted", "the restored chain is the last durable state; it does not hold that transaction");
    assert.equal(jobB.result, null);
    assert.match(jobB.guidance!, /^Nothing moved\./);
    assert.equal(jobB.steps.at(-1)!.label, "Interrupted by a restart");
    st = (await b2.call<RailState>("GET", "/state")).data;
    assert.deepEqual([st.reserve.balance, st.treasury.balance, await conversions(b2)], ["9107516", "90000000", 1], "nothing moved in the durable state");
    const retry = await b2.call<Accepted>("POST", `/proposals/${pB.id}/execute`, bodyB, { "Idempotency-Key": kB });
    assert.deepEqual([retry.data.jobId, retry.data.duplicate], [jobB.id, true], "the same key returns the interrupted job; it is not run again");
    assert.equal((await b2.job(jobB.id)).status, "interrupted");
    const other = await b2.call("POST", `/proposals/${pB.id}/execute`, { approval: approval(pB) }, { "Idempotency-Key": key() });
    assert.deepEqual([other.status, other.data.error.code], [409, "proposal_used"], "the old proposal cannot be reused under a new key either");
    // a NEW request is a new decision, and it executes exactly as an uninterrupted second conversion would
    const fresh = await b2.act("convert", { amount: "22.5" });
    assert.equal(fresh.result?.outcome, "executed");
    st = (await b2.call<RailState>("GET", "/state")).data;
    assert.deepEqual([st.lastTrade!.amountOut, st.lastTrade!.bound, await conversions(b2)], ["20034819", "20034823", 2]);
    assert.equal(await b2.stop(), 0);

    // ── C · the process dies after the transaction was mined and the chain saved, before the job was marked done ──
    const c = await startService("recovery", 15181, 18621, { dir, env: fault("before-done:convert") });
    const pC = (await c.call<Proposal>("POST", "/proposals", { kind: "convert", params: { amount: "5" } })).data;
    const kC = key();
    await c.call("POST", `/proposals/${pC.id}/execute`, { approval: approval(pC) }, { "Idempotency-Key": kC }).catch(() => undefined);
    await exited(c);
    const c2 = await startService("recovery", 15181, 18621, { dir });
    const jobC: Job = await c2.job((await c2.call("GET", `/submissions/${kC}`)).data.jobId);
    assert.deepEqual([jobC.status, jobC.result?.outcome], ["done", "executed"], "found on the restored chain by its certificate's intent id");
    assert.equal((jobC.result!.evidence as { recovered: boolean }).recovered, true);
    assert.equal(jobC.steps.at(-1)!.label, "Recovered by lookup after a restart");
    assert.match(jobC.result!.tx!.hash, /^0x[0-9a-f]{64}$/);
    st = (await c2.call<RailState>("GET", "/state")).data;
    assert.equal(st.treasury.balance, String(100_000_000 - 10_000_000 - 22_500_000 - 5_000_000), "three conversions in total, each once");
    assert.equal(await conversions(c2), 3);
    assert.equal((await c2.call("GET", `/receipts/${jobC.result!.tx!.hash}`)).data.stored.jobId, jobC.id);
    assert.equal((await c2.call("GET", "/decisions/verify")).data.ok, true);
    const restarts = (await c2.call("GET", "/clock")).data.events.filter((e: { kind: string }) => e.kind === "restart");
    assert.ok(restarts.length >= 6 && restarts.some((e: { orphanedChainStopped: boolean }) => e.orphanedChainStopped), "each restart is recorded; an Anvil orphaned by a kill was stopped");
    await c2.stop();
  } finally {
    // Graceful stop first, so each service stops its own Anvil; then make sure nothing this test started is left.
    for (const s of started) { if (s.child.exitCode === null && !s.child.signalCode) await s.stop("SIGTERM"); s.reapAnvil(); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("treasury operations killed mid-way: a payment that was mined and saved is found by lookup; a withdrawal that was only broadcast is interrupted; neither is sent twice", { timeout: 240_000 }, async () => {
  const started: Service[] = [];
  const startService: typeof start = async (...args) => { const s = await start(...args); started.push(s); return s; };
  const payments = async (s: Service) => (await s.call("GET", "/history?limit=100")).data.history.filter((h: { kind: string; outcome: string }) => h.kind === "payment" && h.outcome === "executed").length;
  let dir = "";
  try {
    const first = await startService("recovery-treasury", 15186, 18716);
    dir = first.dir;
    await first.act("provision");
    await first.act("mandate", { maxPerPayment: "25" });
    assert.equal(await first.stop(), 0);

    // ── the process dies after the payment was mined and the chain saved, before the job was marked done ──
    const a = await startService("recovery-treasury", 15186, 18716, { dir, env: fault("before-done:pay") });
    const pA = (await a.call<Proposal>("POST", "/proposals", { kind: "pay", params: { payee: "CloudCo", amount: "3" } })).data;
    const kA = key(), bodyA = { approval: approval(pA) };
    await a.call("POST", `/proposals/${pA.id}/execute`, bodyA, { "Idempotency-Key": kA }).catch(() => undefined);
    await exited(a);
    assert.equal(a.child.signalCode, "SIGKILL");
    const a2 = await startService("recovery-treasury", 15186, 18716, { dir });
    const jobA: Job = await a2.job((await a2.call("GET", `/submissions/${kA}`)).data.jobId);
    assert.deepEqual([jobA.status, jobA.result?.outcome, (jobA.result!.evidence as { recovered: boolean }).recovered, jobA.steps.at(-1)!.label], ["done", "executed", true, "Recovered by lookup after a restart"], "found on the restored chain by its journaled transaction");
    assert.match(jobA.result!.summary, /^Payment: transaction 0x[0-9a-f]{64} was found on the restored chain after a restart; it was not sent again\.$/);
    let st = (await a2.call<RailState>("GET", "/state")).data;
    assert.deepEqual([st.treasury.balance, st.treasury.spentInWindow, await payments(a2)], ["97000000", "3000000", 1], "exactly one payment, and one line for it in the history");
    assert.equal((await a2.call("GET", `/receipts/${jobA.result!.tx!.hash}`)).data.stored.jobId, jobA.id);
    const again = await a2.call<Accepted>("POST", `/proposals/${pA.id}/execute`, bodyA, { "Idempotency-Key": kA });
    assert.deepEqual([again.status, again.data.jobId, again.data.duplicate], [202, jobA.id, true]);
    assert.equal(await a2.stop(), 0);

    // ── the process dies right after the withdrawal was broadcast, before the chain state was saved ──
    const b = await startService("recovery-treasury", 15186, 18716, { dir, env: fault("after-broadcast:withdraw") });
    const pB = (await b.call<Proposal>("POST", "/proposals", { kind: "withdraw", params: { amount: "20" } })).data;
    const kB = key(), bodyB = { approval: approval(pB) };
    await b.call("POST", `/proposals/${pB.id}/execute`, bodyB, { "Idempotency-Key": kB }).catch(() => undefined);
    await exited(b);
    const b2 = await startService("recovery-treasury", 15186, 18716, { dir });
    const jobB = await b2.job((await b2.call("GET", `/submissions/${kB}`)).data.jobId);
    assert.deepEqual([jobB.status, jobB.result, jobB.steps.at(-1)!.label], ["interrupted", null, "Interrupted by a restart"], "the restored chain is the last durable state; it does not hold that transaction");
    assert.match(jobB.guidance!, /^Nothing moved\./);
    st = (await b2.call<RailState>("GET", "/state")).data;
    assert.equal(st.treasury.balance, "97000000", "nothing moved in the durable state");
    const retry = await b2.call<Accepted>("POST", `/proposals/${pB.id}/execute`, bodyB, { "Idempotency-Key": kB });
    assert.deepEqual([retry.data.jobId, retry.data.duplicate, (await b2.job(jobB.id)).status], [jobB.id, true, "interrupted"], "the same key returns the interrupted job; it is not run again");
    const other = await b2.call("POST", `/proposals/${pB.id}/execute`, { approval: approval(pB) }, { "Idempotency-Key": key() });
    assert.deepEqual([other.status, other.data.error.code], [409, "proposal_used"]);
    // a NEW request is a new decision
    assert.equal((await b2.act("withdraw", { amount: "20" })).result?.outcome, "executed");
    assert.equal((await b2.call<RailState>("GET", "/state")).data.treasury.balance, "77000000");
    assert.equal((await b2.call("GET", "/decisions/verify")).data.ok, true);
    await b2.stop();
  } finally {
    for (const s of started) { if (s.child.exitCode === null && !s.child.signalCode) await s.stop("SIGTERM"); s.reapAnvil(); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
