/**
 * The rail's own budget (baseline F-069; W-17 lifetime counters, W-18 unbounded stores): a rolling window per class
 * (proposals prepared, operations accepted, scripted runs started), counted in the same database transaction as the
 * row it pays for and stored durably. Limits per signed-in owner and the model budget are the backend's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { approve, key, startRail } from "./helpers.ts";
import { startService } from "./service-helper.ts";
import { defaultConfig } from "../rail/config.ts";
import { RailError } from "../rail/service.ts";
import type { Proposal, QuotaView } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const refused = async (f: () => unknown, cls: string) => {
  let seen: RailError | null = null;
  await assert.rejects(async () => f(), (e: unknown) => { assert.ok(e instanceof RailError, `expected a RailError, got ${String(e)}`); seen = e as RailError; return true; });
  assert.deepEqual([seen!.code, seen!.http, seen!.details.class], ["quota_exceeded", 429, cls]);
  return seen!.details as { limit: number; used: number; windowSeconds: number; retryAfterSeconds: number; nextFreeAt: string | null };
};

test("a rolling, durable budget: one more proposal, operation or scripted run than the limit is refused with the limit named, nothing is stored for it, and the count survives a restart", { timeout: 120_000 }, async () => {
  let offset = 0, mono = 0;
  const cfg = { quota: { windowSeconds: 3600, proposals: 4, operations: 2, economies: 0 }, heartbeatMs: 3_600_000, wallClock: () => Date.now() + offset, monoClock: () => mono };
  const t = await startRail("quota", 18721, cfg);
  const dir = t.dir;
  let stopped = false;
  const at = () => new Date(t.rail.now()).toISOString();
  const count = (table: string) => Number((t.rail.store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  try {
    const { global, ...own } = t.rail.quota();
    assert.deepEqual(global!.classes.map((c) => c.class), ["proposals", "operations", "economies", "workspaces"], "the host's budget over all workspaces is shown with it (R7)");
    assert.deepEqual(own, { windowSeconds: 3600, classes: [
      { class: "proposals", counts: "proposals prepared", limit: 4, used: 0, remaining: 4, nextFreeAt: null },
      { class: "operations", counts: "operations accepted", limit: 2, used: 0, remaining: 2, nextFreeAt: null },
      { class: "economies", counts: "scripted economies started", limit: 0, used: 0, remaining: 0, nextFreeAt: null },
    ] });
    // two operations and four proposals are the whole budget
    const p1 = await t.rail.propose({ kind: "provision" });
    const k1 = key(), a1 = approve(p1, { confirmedAt: at() });
    assert.equal((await t.rail.waitForJob(t.rail.execute(p1.id, a1, k1).jobId)).result?.outcome, "executed");
    const p2 = await t.rail.propose({ kind: "mandate", params: { maxPerPayment: "25" } });
    assert.equal((await t.rail.waitForJob(t.rail.execute(p2.id, approve(p2, { confirmedAt: at() }), key()).jobId)).result?.outcome, "executed");
    const p3 = await t.rail.propose({ kind: "convert", params: { amount: "10" } });
    // a request that is refused for another reason costs nothing
    await assert.rejects(() => t.rail.propose({ kind: "convert", params: { amount: "1e2" } }), (e: unknown) => e instanceof RailError && e.code === "invalid_tool_input");
    assert.equal(t.rail.quota().classes[0].used, 3);
    await t.rail.propose({ kind: "convert", params: { amount: "5" } });
    assert.deepEqual(t.rail.quota().classes.map((c) => [c.class, c.used, c.remaining]), [["proposals", 4, 0], ["operations", 2, 0], ["economies", 0, 0]]);

    // the fifth proposal: refused, and nothing was stored or numbered for it
    const [proposals, nonce] = [count("proposals"), t.rail.store.meta<number>("counter:nonce")];
    const d = await refused(() => t.rail.propose({ kind: "convert", params: { amount: "1" } }), "proposals");
    assert.deepEqual([d.limit, d.used, d.windowSeconds], [4, 4, 3600]);
    assert.ok(d.retryAfterSeconds > 3590 && d.retryAfterSeconds <= 3600 && Date.parse(d.nextFreeAt!) > t.rail.now());
    assert.deepEqual([count("proposals"), t.rail.store.meta<number>("counter:nonce")], [proposals, nonce]);

    // the third operation: refused; its proposal stays open, its approval unused, its key free
    const k3 = key(), a3 = approve(p3, { confirmedAt: at() });
    const jobs = count("jobs");
    await refused(() => t.rail.execute(p3.id, a3, k3), "operations");
    await refused(() => t.rail.submit("policy-tick", {}, key()), "operations");
    assert.deepEqual([count("jobs"), t.rail.proposal(p3.id).status, t.rail.store.approvalUse(a3.approvalId), t.rail.store.submission(k3)], [jobs, "open", undefined, undefined]);
    assert.equal((await t.rail.state()).treasury.balance, "100000000", "nothing was sent");
    // a repeated request under a key that was already accepted is the same job, not a new operation
    assert.deepEqual([t.rail.execute(p1.id, a1, k1).duplicate, t.rail.quota().classes[1].used], [true, 2]);
    // a limit of zero allows none: no scripted run is started
    await refused(() => t.rail.economies.start({ scenario: "clearing" }, key()), "economies");
    assert.equal(t.rail.economies.active(), null);
    // reads are not counted
    for (let i = 0; i < 12; i++) await t.rail.limits("1");

    // the count is in the database, not in the process: a restart does not hand out a new budget
    await t.stop({ keep: true });
    stopped = true;
    const again = await startRail("quota", 18721, { ...cfg, dataDir: dir });
    try {
      assert.deepEqual(again.rail.quota().classes.map((c) => [c.class, c.used]), [["proposals", 4], ["operations", 2], ["economies", 0]]);
      await refused(() => again.rail.propose({ kind: "convert", params: { amount: "1" } }), "proposals");
      // a rolling window: half an hour later nothing has left it; just past the hour it is free again
      offset += 1_800_000; mono += 1_000;
      const half = await refused(() => again.rail.propose({ kind: "convert", params: { amount: "1" } }), "proposals");
      assert.ok(half.retryAfterSeconds > 1700 && half.retryAfterSeconds <= 1800, `retry after ${half.retryAfterSeconds} s`);
      offset += 1_801_000; mono += 1_000;
      const fresh = await again.rail.propose({ kind: "convert", params: { amount: "10" } });
      const job = await again.rail.waitForJob(again.rail.execute(fresh.id, approve(fresh, { confirmedAt: new Date(again.rail.now()).toISOString() }), key()).jobId);
      assert.equal(job.result?.outcome, "executed", job.error ?? job.result?.summary);
      assert.deepEqual(again.rail.quota().classes.map((c) => [c.class, c.used]), [["proposals", 1], ["operations", 1], ["economies", 0]]);
      assert.equal(Number((again.rail.store.db.prepare("SELECT COUNT(*) AS c FROM quota_events WHERE class NOT LIKE 'global:%'").get() as { c: number }).c), 2, "events that left the window are pruned: the store stays bounded");
      // R7: in baseline-parity mode the host's budget over all workspaces is kept in the same table, and pruned the same way
      assert.equal(Number((again.rail.store.db.prepare("SELECT COUNT(*) AS c FROM quota_events WHERE class LIKE 'global:%'").get() as { c: number }).c), 2, "the host's budget rows are pruned too");
    } finally { await again.stop(); }
  } finally { if (!stopped) await t.stop(); }
});

test("the writer's queue is bounded: with two operations accepted and unfinished, a third is refused (429 busy) and stores nothing; when the queue drains the same request is accepted", { timeout: 120_000 }, async () => {
  const t = await startRail("quota-busy", 18724, { maxQueued: 2 });
  try {
    await t.ready();
    const ps = [await t.rail.propose({ kind: "convert", params: { amount: "2" } }), await t.rail.propose({ kind: "convert", params: { amount: "3" } }), await t.rail.propose({ kind: "convert", params: { amount: "4" } })];
    const first = t.rail.execute(ps[0].id, approve(ps[0]), key()), second = t.rail.execute(ps[1].id, approve(ps[1]), key());
    const k = key(), a = approve(ps[2]);
    assert.throws(() => t.rail.execute(ps[2].id, a, k), (e: unknown) => e instanceof RailError && e.code === "busy" && e.http === 429 && e.details.limit === 2);
    assert.deepEqual([t.rail.proposal(ps[2].id).status, t.rail.store.submission(k), t.rail.store.approvalUse(a.approvalId), t.rail.quota().classes[1].used], ["open", undefined, undefined, 4], "nothing stored, nothing counted");
    assert.deepEqual([(await t.rail.waitForJob(first.jobId)).result?.outcome, (await t.rail.waitForJob(second.jobId)).result?.outcome], ["executed", "executed"]);
    assert.equal((await t.rail.waitForJob(t.rail.execute(ps[2].id, a, k).jobId)).result?.outcome, "executed", "the same key and approval, once there is room");
    assert.equal((await t.rail.state()).treasury.balance, "91000000");
  } finally { await t.stop(); }
});

test("over HTTP: 429 quota_exceeded with Retry-After and the figures; GET /quota shows the budget; readiness is not affected", { timeout: 120_000 }, async () => {
  const s = await startService("svc-quota", 15183, 18722, { env: { QED_RAIL_QUOTA_PROPOSALS: "2", QED_RAIL_QUOTA_WINDOW_S: "600" } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await s.call<Proposal>("POST", "/proposals", { kind: "provision" })).status, 201);
    const over = await s.call("POST", "/proposals", { kind: "provision" });
    assert.deepEqual([over.status, over.data.error.code, over.data.error.details.class, over.data.error.details.limit, over.data.error.details.used, over.data.error.details.windowSeconds], [429, "quota_exceeded", "proposals", 2, 2, 600]);
    assert.match(over.data.error.message, /2 in any 10 minutes/);
    const retry = Number(over.headers.get("retry-after"));
    assert.ok(Number.isInteger(retry) && retry > 590 && retry <= 600 && retry === over.data.error.details.retryAfterSeconds, `Retry-After ${over.headers.get("retry-after")}`);
    const q = (await s.call<QuotaView>("GET", "/quota")).data;
    assert.deepEqual([q.windowSeconds, q.classes.map((c) => [c.class, c.limit, c.used, c.remaining])], [600, [["proposals", 2, 2, 0], ["operations", 240, 0, 240], ["economies", 4, 0, 4]]]);
    assert.ok(Date.parse(q.classes[0].nextFreeAt!) > Date.now());
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/health`)).status, 200);
    assert.equal((await s.call("GET", "/state")).status, 200);
  } finally { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
});

test("a quota setting that is not a whole number is refused at configuration time instead of switching the budget off", () => {
  const read = (env: Record<string, string>) => { const saved = { ...process.env }; Object.assign(process.env, env); try { return defaultConfig({ dataDir: "/nonexistent" }).quota; } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
  assert.deepEqual(read({}), { windowSeconds: 3600, proposals: 240, operations: 240, economies: 4 }, "the defaults");
  assert.deepEqual(read({ QED_RAIL_QUOTA_PROPOSALS: "60", QED_RAIL_QUOTA_OPERATIONS: "30", QED_RAIL_QUOTA_ECONOMIES: "0", QED_RAIL_QUOTA_WINDOW_S: "600" }), { windowSeconds: 600, proposals: 60, operations: 30, economies: 0 });
  for (const bad of ["unlimited", "-1", "1.5", "", "1e3", "Infinity"]) assert.throws(() => read({ QED_RAIL_QUOTA_OPERATIONS: bad }), /QED_RAIL_QUOTA_OPERATIONS must be a whole number/, bad);
  assert.throws(() => read({ QED_RAIL_QUOTA_WINDOW_S: "0" }), /QED_RAIL_QUOTA_WINDOW_S must be at least 1/);
  for (const quota of [{ windowSeconds: 3600, proposals: -1, operations: 1, economies: 1 }, { windowSeconds: 0, proposals: 1, operations: 1, economies: 1 }, { windowSeconds: 3600, proposals: 1.5, operations: 1, economies: 1 }]) assert.throws(() => defaultConfig({ dataDir: "/nonexistent", quota }), /quota/);
});
