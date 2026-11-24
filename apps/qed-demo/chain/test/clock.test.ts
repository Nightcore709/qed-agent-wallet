/**
 * One authoritative clock: aligned before every transaction, recorded with every decision, refused when the chain
 * is ahead; and the gap detector that notices a machine sleep between two of the rail's own heartbeats.
 * Sleep is simulated here with an injected wall clock that jumps while the monotonic clock does not, which is how
 * a suspended process sees it. test/service.test.ts stops the real service process with SIGSTOP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { toHex } from "viem";
import { startRail } from "./helpers.ts";
import { GapDetector, reading } from "../rail/clock.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

test("gap detector: sleep, stall, a wall clock set back, and ordinary ticks", () => {
  let wall = 1_800_000_000_000, mono = 5_000;
  const d = new GapDetector(() => wall, () => mono, 15_000);
  wall += 2_000; mono += 2_000;
  assert.equal(d.observe(), null, "an ordinary 2 s heartbeat is not a gap");
  wall += 3_600_000; mono += 2_000;
  const sleep = d.observe()!;
  assert.equal(sleep.kind, "suspend");
  assert.equal(sleep.wallSeconds, 3600);
  assert.equal(sleep.monotonicSeconds, 2);
  assert.equal(Date.parse(sleep.wallAfter) - Date.parse(sleep.wallBefore), 3_600_000);
  wall += 60_000; mono += 60_000;
  assert.equal(d.observe()!.kind, "stall", "both clocks advanced: the process was not scheduled");
  wall -= 120_000; mono += 2_000;
  assert.equal(d.observe()!.kind, "clock-set-back");
  wall += 14_000; mono += 14_000;
  assert.equal(d.observe(), null, "below the threshold");
  assert.equal(reading(100, 100_999, 5).skewSeconds, 0);
  assert.equal(reading(110, 100_000, 5).withinLimit, false, "chain 10 s ahead with a 5 s limit");
  assert.equal(reading(104, 100_000, 5).withinLimit, true);
});

test("a chain ahead of the wall clock is refused with both times shown, and nothing is sent", async () => {
  const t = await startRail("clock-ahead", 18561, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    await t.rail.rpc("evm_increaseTime", [toHex(600)]);
    await t.rail.rpc("evm_mine", []);
    const c = await t.rail.clock();
    assert.ok(c.skewSeconds <= -595 && !c.withinLimit, `chain leads by ${-c.skewSeconds} s`);
    const before = await t.rail.state();
    const job = await t.act("convert", { amount: "10" });
    assert.equal(job.status, "failed");
    assert.match(job.error!, /The chain clock is ahead of the wall clock by \d+ s \(limit 5 s\): chain time \d{4}-\d\d-\d\dT[\d:.]+Z, wall time \d{4}-\d\d-\d\dT[\d:.]+Z\. No transaction was sent\./);
    assert.equal(job.guidance, "Nothing was mined for this operation. No money moved.");
    assert.equal(t.rail.store.attempts(job.id).length, 0);
    const after = await t.rail.state();
    assert.deepEqual([after.treasury.balance, after.reserve.balance, after.network.block], [before.treasury.balance, before.reserve.balance, before.network.block]);
    const ev = t.rail.clockEvents(5)[0] as Record<string, unknown>;
    assert.equal(ev.kind, "skew-refusal");
    assert.ok(typeof ev.chainSeconds === "number" && typeof ev.wallSeconds === "number" && ev.limitSeconds === 5);
    assert.equal(after.clock.withinLimit, false, "the state says so before anyone tries");
  } finally { await t.stop(); }
});

test("machine sleep between two heartbeats: detected, chain realigned, recorded; the next conversion settles", async () => {
  let offset = 0, mono = 0;
  const t = await startRail("clock-sleep", 18562, { heartbeatMs: 3_600_000, wallClock: () => Date.now() + offset, monoClock: () => mono });
  try {
    await t.ready();
    assert.equal((await t.act("convert", { amount: "10" })).result!.outcome, "executed");
    assert.equal((await t.rail.state()).treasury.spentInWindow, "10000000");
    assert.equal(await t.rail.tick(), null, "no gap yet");

    // 25 hours pass on the wall clock while the process is suspended: no heartbeat, no monotonic time
    offset += 25 * 3_600_000; mono += 2_000;
    const stale = await t.rail.clock();
    assert.ok(stale.skewSeconds >= 25 * 3600 - 5, "the chain is 25 h behind before anything notices");
    const gap = (await t.rail.tick())!;
    assert.equal(gap.kind, "suspend");
    assert.equal(gap.wallSeconds, 25 * 3600);
    const aligned = await t.rail.clock();
    assert.ok(Math.abs(aligned.skewSeconds) <= 2, `realigned: skew ${aligned.skewSeconds} s`);
    const ev = t.rail.clockEvents(1)[0] as Record<string, any>;
    assert.equal(ev.kind, "suspend");
    assert.equal(ev.wallSeconds, aligned.wallSeconds);
    assert.ok(ev.chainAfter - ev.chainBefore >= 25 * 3600 - 5 && ev.blockMined === true && ev.behindSeconds >= 25 * 3600 - 5);
    const d = t.rail.decisions(1)[0];
    assert.deepEqual([d.kind, d.verdict], ["clock-gap", "REALIGNED"]);
    assert.equal(t.rail.verifyDecisions().ok, true);

    // time-dependent views follow the realigned clock: yesterday's spending window is over
    const s = await t.rail.state();
    assert.equal(s.treasury.spentInWindow, "0");
    assert.equal(s.treasury.availableToday, "100000000");
    assert.equal(s.mandate!.usage.period.spent, "0");
    assert.equal(s.mandate!.usage.lifetime.spent, "10000000", "the lifetime total does not reset");

    const job = await t.act("convert", { amount: "22.5" });
    assert.equal(job.result!.outcome, "executed", job.error ?? job.result!.summary);
    const rec = t.rail.decisions(5, job.id)[0];
    assert.ok(Math.abs(rec.clock!.skewSeconds) <= 2 && rec.clock!.withinLimit, "the decision stores both times");
    assert.ok(Math.abs(rec.clock!.wallSeconds - Math.floor((Date.now() + offset) / 1000)) <= 5);
  } finally { await t.stop(); }
});

test("a gap is also caught lazily, before a transaction, when no heartbeat has run since the wake-up", async () => {
  let offset = 0, mono = 0;
  const t = await startRail("clock-lazy", 18563, { heartbeatMs: 3_600_000, wallClock: () => Date.now() + offset, monoClock: () => mono });
  try {
    await t.ready();
    offset += 3 * 3_600_000; mono += 1_000;
    const p = await t.rail.propose({ kind: "convert", params: { amount: "7" } });
    const { approve, key } = await import("./helpers.ts");
    const job = await t.rail.waitForJob(t.rail.execute(p.id, approve(p, { confirmedAt: new Date(Date.now() + offset).toISOString() }), key()).jobId);
    assert.equal(job.result?.outcome, "executed", job.error ?? "");
    const kinds = t.rail.clockEvents(10).map((e) => e.kind);
    assert.ok(kinds.includes("suspend"), `recorded: ${kinds.join(", ")}`);
    const block = await t.rail.pub.getBlock();
    assert.ok(Math.abs(Number(block.timestamp) - Math.floor((Date.now() + offset) / 1000)) <= 3, "the conversion was mined at the realigned time");
  } finally { await t.stop(); }
});

test("an idle chain: reads are fresh without mining anything, and the next transaction is mined at wall time", async () => {
  const t = await startRail("clock-idle", 18564, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const b0 = (await t.rail.state()).network.block;
    await new Promise((r) => setTimeout(r, 3_100));
    const s = await t.rail.state();
    assert.equal(s.network.block, b0, "reading the state mines nothing");
    assert.ok(s.clock.skewSeconds >= 3 && s.clock.withinLimit, `idle chain is ${s.clock.skewSeconds} s behind and that is allowed`);
    for (let i = 0; i < 20; i++) await t.rail.health();
    assert.equal((await t.rail.state()).network.block, b0, "health checks mine nothing");
    const job = await t.act("convert", { amount: "10" });
    assert.equal(job.result!.outcome, "executed");
    const after = await t.rail.clock();
    assert.ok(Math.abs(after.skewSeconds) <= 1, "mined at wall time, not at the stale block's time");
    // a burst of operations never makes the chain run ahead (the release's replica idiom would)
    for (const kind of ["inferior-route", "skim", "redirect"]) assert.equal((await t.act("attack", { kind })).result!.outcome, "reverted");
    assert.ok((await t.rail.clock()).skewSeconds >= -1, "no lead accumulated");
  } finally { await t.stop(); }
});
