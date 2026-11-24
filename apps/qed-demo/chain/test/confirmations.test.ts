/**
 * R7-036: a rail job is reported done only once every transaction it sent on the shared chain has the stated number of
 * confirmations (rail/config.ts `confirmations`, 2 by default, as the household's books use), and a job whose
 * transaction a reorganisation replaces before then is reported "reorged", never done. On a real Anvil, with its own
 * `anvil_reorg`. The empty blocks a confirmation needs are mined by the service by default (`confirmMining`); these tests
 * turn that off after setting up, so that the job waits and the reorganisation can come first.
 *
 * And (R13, the security specialist's finding): the reorganisation check never looks for an ephemeral chain's
 * transactions (a Security Lab attack, a scenario) on the shared chain, and a job it wrongly marked "reorged" before the
 * fix is put back at start, with a correction in the history.
 *
 * The rail's chains listen on a port browsers refuse, chosen when they start (rail/chain-socket.ts); the ports named here
 * (12481 to 12483) only name the tests' data folders and the pre-R13 port a stale chain would be recognised by.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { approve, key, startRail, type TestRail } from "./helpers.ts";
import type { Job } from "../types.ts";

process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const until = async (f: () => boolean, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
/** Starts a conversion and returns once the job holds, mined and waiting for its confirmations. */
async function convertAndHold(t: TestRail, amount: string): Promise<{ id: string; seen: Set<string>; settled: Promise<Job> }> {
  const rail = t.rail;
  const p = await rail.propose({ kind: "convert", params: { amount } });
  const id = rail.execute(p.id, approve(p, { confirmedAt: new Date(rail.now()).toISOString() }), key()).jobId;
  const seen = new Set<string>();
  const watch = setInterval(() => seen.add(rail.job(id).status), 10);
  const settled = rail.waitForJob(id, 120_000).finally(() => clearInterval(watch));
  await until(() => rail.job(id).status === "confirming", "the job to wait for its confirmations");
  seen.add("confirming");
  return { id, seen, settled };
}

test("R7-036: a job waits for 2 confirmations before it is reported done; a block on top makes it done", { timeout: 240_000 }, async () => {
  const t = await startRail("confirm-depth", 12481, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const rail = t.rail;
    assert.equal(rail.cfg.confirmations, 2, "the stated default depth");
    // with the service's own mining (the default) a job is done at once, with its block and one on top
    const quick = await t.act("convert", { amount: "5" });
    assert.equal(quick.status, "done");
    assert.deepEqual([quick.confirmations?.have, quick.confirmations?.need], [2, 2]);
    assert.deepEqual(quick.steps.map((s) => s.key), ["interpret", "mandate", "owner", "cosigner", "executable", "plan", "submit", "receipt", "reconcile"], "the steps are the operation's own (the executable quote, R7-038, among them)");

    rail.cfg.confirmMining = false;
    const { id, seen, settled } = await convertAndHold(t, "6");
    const held = rail.job(id);
    assert.deepEqual([held.status, held.confirmations?.have, held.confirmations?.need], ["confirming", 1, 2]);
    assert.equal(held.result?.outcome, "executed", "the conversion itself happened: only its report waits");
    let answered = false;
    void settled.then(() => { answered = true; });
    await rail.reconcileChain({ force: true });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([rail.job(id).status, answered], ["confirming", false], "one confirmation is not enough, and nobody waiting is told it is done");

    await rail.rpc("evm_mine", []);
    const r = await rail.reconcileChain();
    assert.equal(r.confirmed, 1);
    const done = await settled;
    assert.deepEqual([done.status, done.confirmations?.have, done.confirmations?.need], ["done", 2, 2]);
    assert.ok(!seen.has("reorged"), [...seen].join(","));
    assert.equal(rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});

test("R7-036: a job whose block is replaced (anvil_reorg) before its confirmations is reported reorged, never done; nothing is re-sent", { timeout: 240_000 }, async () => {
  const t = await startRail("confirm-reorg", 12482, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const rail = t.rail;
    const before = await rail.state();
    rail.cfg.confirmMining = false;
    const { id, seen, settled } = await convertAndHold(t, "7");
    const hash = rail.job(id).result!.tx!.hash;
    const from = ((await rail.rpc("eth_getTransactionByHash", [hash])) as { from: string }).from;
    const nonce = async () => Number(await rail.rpc("eth_getTransactionCount", [from, "latest"]));
    const nonceAfter = await nonce();
    assert.notEqual((await rail.state()).reserve.balance, before.reserve.balance, "the conversion moved money on the chain");

    // the block holding the job's transaction is replaced by an empty one, before a second confirmation
    await rail.rpc("anvil_reorg", [1, []]);
    assert.equal(await rail.rpc("eth_getTransactionReceipt", [hash]), null, "the chain no longer holds it");
    await rail.reconcileChain();
    const j = await settled;
    assert.equal(j.status, "reorged");
    assert.match(j.error ?? "", /before it had 2 confirmations\. It was never done\./);
    assert.match(j.guidance ?? "", /Nothing was sent again/);
    assert.ok(!seen.has("done"), `never reported done: ${[...seen].join(" → ")}`);
    assert.ok(rail.history(10).some((h: any) => h.jobId === id && h.outcome === "reorged" && /never reported done/.test(h.title)));
    assert.equal((await rail.state()).reserve.balance, before.reserve.balance, "the chain's balance is back where it was");
    assert.equal(await nonce(), nonceAfter - 1, "nothing was sent again");

    // more blocks later do not make it done: its transaction is not on the chain
    await rail.rpc("evm_mine", []); await rail.rpc("evm_mine", []);
    await rail.reconcileChain({ force: true });
    assert.equal(rail.job(id).status, "reorged");
    assert.equal(rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});

test("R13: an attack's transactions on its ephemeral chain are never looked for on the shared chain; a job wrongly marked reorged before the fix is put back", { timeout: 240_000 }, async () => {
  const t = await startRail("confirm-ephemeral", 12483, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const rail = t.rail;
    const job = await t.act("attack", { kind: "skim" });
    assert.equal(job.status, "done", job.error ?? "");
    const attempts = rail.store.attempts(job.id);
    assert.ok(attempts.length > 0 && attempts.every((a) => typeof a.network === "string" && /Ephemeral Anvil chain/.test(String(a.network))), "each attempt names its ephemeral chain");
    const r = await rail.reconcileChain({ force: true });
    assert.equal(r.replaced, 0);
    assert.equal(rail.job(job.id).status, "done", "not marked reorged");
    assert.ok(!rail.history(20).some((h: any) => h.outcome === "reorged"), "no false history line");

    // what the check did before the fix, written as it wrote it; the next start corrects it
    for (const a of attempts) rail.store.updateAttempt(Number(a.id), { status: "replaced", at: rail.iso() });
    rail.store.setJobStatus(job.id, "reorged", "A chain reorganisation replaced the block that held this operation's transaction. It is not done.", "Nothing was sent again.");
    rail.store.appendHistory({ at: rail.iso(), kind: "attack", title: "attack was undone by a chain reorganisation (written by the check before R13)", outcome: "reorged", jobId: job.id });
    await rail.recoverJobs();
    assert.equal(rail.job(job.id).status, "done");
    assert.ok(rail.store.attempts(job.id).every((a) => a.status === "mined-revert" || a.status === "mined-success"), "each attempt is back to its receipt's state");
    assert.ok(rail.history(5).some((h: any) => h.jobId === job.id && /^Correction: attack was not undone by a reorganisation/.test(h.title)), "the history corrects the false line, which stays");
    assert.ok(rail.decisions(20).some((d: any) => d.kind === "reorg" && d.verdict === "CORRECTED" && d.jobId === job.id));
    await rail.recoverJobs();
    assert.equal(rail.decisions(50).filter((d: any) => d.verdict === "CORRECTED").length, attempts.length, "the repair finds nothing the second time");
    assert.equal(rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});
