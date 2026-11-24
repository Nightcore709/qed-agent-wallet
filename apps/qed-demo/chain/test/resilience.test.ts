/**
 * Chain failures (R13, RE1): a reorganisation under a done job, two jobs for one account's nonce, a retried effect, a
 * kill in the middle of a job, and the state file's write. Runs against its own Anvil ports (11180 to 11199).
 *
 * Seeded failures (each makes a test fail on purpose, to show it can):
 *   QED_SEED_NO_RECONCILE=1   the reorganisation check is not run: "a reorganised job is not reported done" must fail.
 *   QED_SEED_FAIL=1           the last test asserts something false.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { approve, key, startRail } from "./helpers.ts";
import { atomicWrite } from "../rail/anvil.ts";
import { RailError } from "../rail/service.ts";
import { startService, type Service } from "./service-helper.ts";
import type { Proposal } from "../types.ts";

const SEED_SKIP = process.env.QED_SEED_NO_RECONCILE === "1";
const PORT = 11181;

test("a reorganisation that replaces the block of a done job: the job is not reported done, nothing is re-sent, the same key finds the same job", { timeout: 240_000 }, async () => {
  // Why this test was flaky (R13), two races, both fixed:
  //  1. the host's heartbeat runs the same check every 10 s. When its check ran between the reorganisation and the test's
  //     forced call, it did the work and the forced call found nothing left to do; when it was still running, the forced
  //     call returned at once with zeros (it skipped instead of waiting). The service now makes a forced call wait and
  //     run (asserted below with two calls at once); this test turns the heartbeat off, so every check in it is its own
  //     and the seeded failure below fails every time, and it reads the outcome from the decision records;
  //  2. Anvil answers eth_sendRawTransaction before its automine has put the transaction in a block (seen on Anvil 1.7.1:
  //     the transaction was neither in a block nor in the pool for a moment), so a check run at once could miss the
  //     transaction mined again. The test now waits for its receipt.
  const t = await startRail("reorg", PORT, { economyAnvilPort: 11191, heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const rail = t.rail;
    const before = await rail.state();
    const p = await rail.propose({ kind: "convert", params: { amount: "10" } });
    const ap = approve(p, { confirmedAt: new Date(rail.now()).toISOString() }), k = key();
    const job = await rail.waitForJob(rail.execute(p.id, ap, k).jobId);
    assert.equal(job.status, "done");
    const hash = job.result!.tx!.hash;
    const after = await rail.state();
    assert.notEqual(after.reserve.balance, before.reserve.balance, "the conversion moved money");
    const raw = (await rail.rpc("eth_getRawTransactionByHash", [hash])) as string;
    const from = ((await rail.rpc("eth_getTransactionByHash", [hash])) as { from: string }).from;
    const count = async () => Number(await rail.rpc("eth_getTransactionCount", [from, "latest"]));
    const nonceAfterJob = await count();

    // the block holding the transaction, and every block after it, are replaced by empty ones
    const latest = Number(await rail.rpc("eth_blockNumber"));
    const depth = latest - Number(job.result!.tx!.block) + 1;
    await rail.rpc("anvil_reorg", [depth, []]);
    assert.equal(await rail.rpc("eth_getTransactionReceipt", [hash]), null, "the chain no longer holds it");

    // before the check runs the record still says done: that window is what the check closes
    const decided = (verdict: string) => rail.decisions(200).filter((d: any) => d.kind === "reorg" && d.verdict === verdict && (d.record as { tx?: string }).tx === hash).length;
    if (!SEED_SKIP) {
      // two forced checks at once: the second waits for the first and runs; neither answers for a check it did not run
      const [r1, r2] = await Promise.all([rail.reconcileChain({ force: true }), rail.reconcileChain({ force: true })]);
      assert.equal(r1.replaced + r2.replaced, 1, "the transaction is found replaced once");
      assert.ok(r1.checked > 0 && r2.checked > 0, `both checks ran: ${JSON.stringify([r1, r2])}`);
      assert.equal(decided("REPLACED"), 1, "one decision record says the transaction was replaced");
    }
    const j = rail.job(job.id);
    assert.equal(j.status, "reorged", "a replaced transaction is not reported as done");
    assert.match(j.error ?? "", /reorganisation replaced/);
    assert.match(j.guidance ?? "", /Nothing was sent again/);
    assert.ok(rail.history(20).some((x: any) => x.jobId === job.id && x.outcome === "reorged"), "the history says so");
    assert.equal(rail.verifyDecisions().ok, true, "the decision chain is intact");
    assert.equal((await rail.state()).reserve.balance, before.reserve.balance, "the chain's own balance is back where it was");

    // a retry under the same key finds the same job; nothing is sent
    const again = rail.execute(p.id, ap, k);
    assert.deepEqual([again.jobId, again.duplicate, again.status], [job.id, true, "reorged"]);
    assert.equal(await count(), nonceAfterJob - 1, "no second transaction from the sender");

    // the same transaction mined again: the job is done again, once, after its confirmations (R7-036)
    await rail.rpc("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 100 && !(await rail.rpc("eth_getTransactionReceipt", [hash])); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await rail.rpc("eth_getTransactionReceipt", [hash]), "the chain holds the transaction again");
    const back = await rail.reconcileChain({ force: true });
    assert.equal(back.restored, 1);
    assert.equal(decided("RESTORED"), 1, "one decision record says it is on the chain again");
    const done = rail.job(job.id);
    assert.equal(done.status, "done");
    assert.ok(done.confirmations && done.confirmations.have >= done.confirmations.need, `reported done with its confirmations: ${JSON.stringify(done.confirmations)}`);
    assert.equal(await count(), nonceAfterJob, "the one transaction, once");
    assert.equal(rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});

test("two jobs racing for one account: both done, each with its own nonce, in the order they were queued", { timeout: 240_000 }, async () => {
  const t = await startRail("nonce", 11183, { economyAnvilPort: 11192 });
  try {
    await t.ready();
    const rail = t.rail;
    const [pa, pb] = await Promise.all([rail.propose({ kind: "convert", params: { amount: "5" } }), rail.propose({ kind: "convert", params: { amount: "6" } })]);
    const a = rail.execute(pa.id, approve(pa, { confirmedAt: new Date(rail.now()).toISOString() }), key());
    const b = rail.execute(pb.id, approve(pb, { confirmedAt: new Date(rail.now()).toISOString() }), key());
    const [ja, jb] = await Promise.all([rail.waitForJob(a.jobId), rail.waitForJob(b.jobId)]);
    assert.deepEqual([ja.status, jb.status], ["done", "done"]);
    const tx = async (j: typeof ja) => (await rail.rpc("eth_getTransactionByHash", [j.result!.tx!.hash])) as { from: string; nonce: string };
    const [ta, tb] = [await tx(ja), await tx(jb)];
    assert.equal(ta.from.toLowerCase(), tb.from.toLowerCase(), "one account sent both");
    assert.equal(Math.abs(Number(ta.nonce) - Number(tb.nonce)), 1, "consecutive nonces: none reused, none skipped");
    assert.equal(Number(ta.nonce) < Number(tb.nonce), true, "the first accepted went first");
    assert.equal(rail.history(50).filter((h) => h.kind === "conversion" && h.outcome === "executed").length, 2);
    assert.equal(rail.host.writerQueued, 0);
  } finally { await t.stop(); }
});

test("the same effect twice: one key sent three times at once, a new key on a used proposal, a used approval on a new proposal", { timeout: 240_000 }, async () => {
  const t = await startRail("dup", 11185, { economyAnvilPort: 11193 });
  try {
    await t.ready();
    const rail = t.rail;
    const p = await rail.propose({ kind: "convert", params: { amount: "5" } });
    const ap = approve(p, { confirmedAt: new Date(rail.now()).toISOString() });
    const k = key();
    const three = await Promise.all([0, 1, 2].map(async () => rail.execute(p.id, ap, k)));
    assert.equal(new Set(three.map((x) => x.jobId)).size, 1, "one job");
    assert.equal(three.filter((x) => !x.duplicate).length, 1, "one of the three was new");
    const done = await rail.waitForJob(three[0].jobId);
    assert.equal(done.status, "done");
    assert.throws(() => rail.execute(p.id, approve(p, { confirmedAt: new Date(rail.now()).toISOString() }), key()), (e: unknown) => e instanceof RailError && e.code === "proposal_used");
    const p2 = await rail.propose({ kind: "convert", params: { amount: "5" } });
    assert.throws(() => rail.execute(p2.id, { ...ap, termsHash: p2.termsHash }, key()), (e: unknown) => e instanceof RailError && e.code === "approval_replayed");
    assert.equal(rail.history(50).filter((h) => h.kind === "conversion" && h.outcome === "executed").length, 1, "one conversion in all");
  } finally { await t.stop(); }
});

test("a kill in the middle of a job (a mandate that replaces another, after its revoking transaction is broadcast): it resumes once, one active mandate, the revoke sent once on the durable chain", { timeout: 300_000 }, async () => {
  const started: Service[] = [];
  const start: typeof startService = async (...a) => { const s = await startService(...a); started.push(s); return s; };
  const env = (extra: Record<string, string> = {}) => ({ QED_RAIL_ECONOMY_ANVIL_PORT: "11194", ...extra });
  try {
    const first = await start("midjob", 11186, 11187, { env: env() });
    await first.act("provision");
    await first.act("mandate", { maxPerPayment: "25" });
    assert.equal(await first.stop(), 0);
    const a = await start("midjob", 11186, 11187, { dir: first.dir, env: env({ QED_RAIL_ALLOW_FAULTS: "1", QED_RAIL_FAULT: "after-broadcast:mandate" }) });
    const p = (await a.call<Proposal>("POST", "/proposals", { kind: "mandate", params: { maxPerPayment: "20" } })).data;
    const k = key();
    const body = { approval: { approvalId: `ap-${key()}`, docHash: "sha256:doc", termsHash: p.termsHash, confirmedAt: new Date().toISOString(), method: "test-owner" } };
    await a.call("POST", `/proposals/${p.id}/execute`, body, { "Idempotency-Key": k }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      if (a.child.exitCode !== null || a.child.signalCode) return resolve();
      const t = setTimeout(() => reject(new Error("the service was expected to die at its fault point")), 60_000);
      a.child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    assert.equal(a.child.signalCode, "SIGKILL");
    const b = await start("midjob", 11186, 11187, { dir: first.dir, env: env() });
    const sub = (await b.call("GET", `/submissions/${k}`)).data;
    await b.until(async () => ["done", "failed", "interrupted"].includes((await b.job(sub.jobId)).status), 120_000, "the job to settle after the restart");
    const job = await b.job(sub.jobId);
    assert.equal(job.status, "done", `resumed to completion, got ${job.status}: ${job.error}`);
    assert.ok(job.steps.some((s) => s.label === "Resumed after a restart"), "it says it was resumed");
    const again = await b.call("POST", `/proposals/${p.id}/execute`, body, { "Idempotency-Key": k });
    assert.deepEqual([again.data.jobId, again.data.duplicate], [sub.jobId, true], "the same key finds the same job");
    const st = (await b.call("GET", "/state")).data;
    assert.deepEqual([st.mandate.version, st.mandate.status], [2, "active"], "exactly one active mandate, the new one");
    const hist = (await b.call("GET", "/history?limit=100")).data.history.filter((h: { kind: string; outcome: string }) => h.kind === "mandate" && h.outcome === "executed");
    assert.equal(hist.length, 2, "two mandates signed in all (v1, v2), none twice");
  } finally { for (const s of started) { try { await s.stop("SIGKILL"); } catch { /* gone */ } s.reapAnvil(); } }
});

test("the Anvil state file is written to a temporary file and renamed, so a failed write leaves the last whole file", { timeout: 120_000 }, async () => {
  const t = await startRail("statefile", 11188, { economyAnvilPort: 11195 });
  try {
    await t.ready();
    const dir = join(t.dir);
    const files = () => readdirSync(dir, { recursive: true }).map(String);
    const state = files().find((f) => f.endsWith("anvil-state.hex"));
    assert.ok(state, "a state file exists after a job");
    const full = join(dir, state!);
    const good = statSync(full).size;
    assert.ok(good > 1000);
    // a write that cannot complete: the temporary file's path is a directory, so opening it fails like a full disk or I/O error
    mkdirSync(`${full}.tmp`, { recursive: true });
    await assert.rejects(() => (t.rail.host as any).anvil.dumpState());
    assert.equal(statSync(full).size, good, "the last whole state file is untouched");
    assert.equal(files().filter((f) => /\.hex\.tmp$/.test(f) && statSync(join(dir, f)).isFile()).length, 0, "no half-written file is left behind as a state file");
    assert.equal((await t.rail.state()).status, "ready", "the service keeps running");
  } finally { await t.stop(); }
});

test("atomicWrite: a write that runs out of space part-way leaves the last whole file and no temporary file; the next write succeeds", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `r13-atomic-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.hex");
  atomicWrite(path, "0xold");
  const enospc = (fd: number, data: string) => { writeSync(fd, data.slice(0, 3)); throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); };
  assert.throws(() => atomicWrite(path, "0xnew-and-longer", enospc), /ENOSPC/);
  assert.equal(readFileSync(path, "utf8"), "0xold");
  assert.equal(existsSync(`${path}.tmp`), false, "the half-written temporary file is removed");
  const eio = () => { throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }); };
  assert.throws(() => atomicWrite(path, "0xnew", eio), /EIO/);
  assert.equal(readFileSync(path, "utf8"), "0xold");
  atomicWrite(path, "0xnew");
  assert.equal(readFileSync(path, "utf8"), "0xnew", "recovered once the disk works again");
  rmSync(dir, { recursive: true, force: true });
});

test("seeded failure: this assertion is false when QED_SEED_FAIL=1", () => {
  assert.equal(process.env.QED_SEED_FAIL === "1", false, "seeded failure fired, as intended");
});
