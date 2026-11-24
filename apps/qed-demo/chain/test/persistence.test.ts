/**
 * Chain state and records survive a restart (baseline W-06, correction d), and the Anvil child is supervised.
 * Mechanism confirmed for Anvil 1.7.1: anvil_dumpState after every job, anvil_loadState into a fresh Anvil.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { approve, freshDir, key, startRail } from "./helpers.ts";
import { createRail } from "../rail/index.ts";
import { devAccount } from "../rail/keys.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const until = async (f: () => Promise<boolean> | boolean, ms: number, label: string) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 100)); }
};

test("service restart: balances, mandate usage, receipts, logs, history, proposals and jobs are all still there", async () => {
  const a = await startRail("persist", 18571);
  let dir = a.dir;
  try {
    await a.ready();
    const first = await a.act("convert", { amount: "10" });
    const usedNonce = a.rail.proposal(first.proposalId!).terms.nonce as string;
    const open = await a.rail.propose({ kind: "convert", params: { amount: "22.5" } });
    const before = await a.rail.state();
    const decisionsBefore = a.rail.verifyDecisions();
    const historyBefore = a.rail.history(50);
    await a.stop({ keep: true });

    const b = await startRail("persist", 18571, { dataDir: dir });
    try {
      assert.equal(b.rail.restoredFromState, true);
      const s = await b.rail.state();
      assert.equal(s.genesisId, before.genesisId);
      assert.equal(s.provisioned, true);
      assert.deepEqual(s.contracts, before.contracts);
      assert.deepEqual([s.treasury.balance, s.reserve.balance, s.treasury.spentInWindow], [before.treasury.balance, before.reserve.balance, before.treasury.spentInWindow]);
      assert.deepEqual([s.mandate!.version, s.mandate!.hash, s.mandate!.usage.period.spent, s.mandate!.usage.lifetime.spent], [1, before.mandate!.hash, "10000000", "10000000"]);
      assert.deepEqual(s.lastTrade, before.lastTrade);
      assert.ok(BigInt(s.network.block) >= BigInt(before.network.block), "the chain continues, it does not start over");
      assert.deepEqual(s.venues, before.venues);
      // the restored chain still answers for the old transaction: receipt and event log
      const hash = first.result!.tx!.hash;
      const r = await b.rail.receipt(hash);
      assert.equal((r.chain as { status: string }).status, "success");
      assert.equal(r.stored!.jobId, first.id);
      const logs = await b.rail.pub.getContractEvents({ address: s.contracts.execution, abi: b.rail.v.abi.QEDExecutionAbi, eventName: "BestExecution", fromBlock: 0n });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].transactionHash, hash);
      // records
      assert.deepEqual(b.rail.job(first.id), first);
      assert.deepEqual(b.rail.history(50).slice(-historyBefore.length), historyBefore);
      const dv = b.rail.verifyDecisions();
      assert.equal(dv.ok, true);
      assert.ok(dv.records >= decisionsBefore.records);
      const restart = b.rail.clockEvents(5).find((e) => e.kind === "restart") as Record<string, unknown>;
      assert.ok(restart && typeof restart.chainBefore === "number" && typeof restart.chainAfter === "number", "the restart and its realignment are recorded");
      // a proposal prepared before the restart is still open and executes exactly as it would have
      assert.equal(b.rail.proposal(open.id).status, "open");
      const job = await b.rail.waitForJob(b.rail.execute(open.id, approve(open), key()).jobId);
      assert.equal(job.result?.outcome, "executed", job.error ?? "");
      const s2 = await b.rail.state();
      assert.equal(s2.lastTrade!.amountOut, "20034819", "bit-identical to an uninterrupted run");
      assert.equal(s2.lastTrade!.bound, "20034823");
      assert.equal(s2.mandate!.usage.lifetime.spent, "32500000");
      // the co-signer's replay set is durable: a nonce it certified before the restart is refused after it, for that reason alone (C6)
      const A = b.rail.a, V = b.rail.v, am = b.rail.activeMandate()!;
      const instructionSig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 10_000_000n, A.usd, A.eur, A.reserve, usedNonce) });
      const replayed = await b.rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 10_000_000n, instruction: "the same nonce after a restart", nonce: usedNonce, instructionSig, brainEngine: "test" });
      assert.deepEqual([replayed.approved, replayed.checks.filter((c: { pass: boolean }) => !c.pass).map((c: { id: string }) => c.id)], [false, ["C6"]]);
      assert.equal((await b.act("attack", { kind: "stolen-order" })).result!.tx!.error, "NotOperator");
    } finally { await b.stop({ keep: true }); }

    // third start: still intact, and a missing state file fails closed instead of redeploying over the records
    rmSync(join(dir, "rail", "anvil-state.hex"));
    const c = createRail({ dataDir: dir, anvilPort: 18571, economyAnvilPort: 19071, cosigner: "in-process" });
    await assert.rejects(() => c.start(), /saved state file is missing\. Nothing was redeployed/);
    assert.equal(c.status, "failed");
    await c.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Anvil crash: the rail notices, restores the last durable state into a new Anvil and becomes ready again", async () => {
  const t = await startRail("crash", 18572, { heartbeatMs: 200 });
  try {
    await t.ready();
    const job = await t.act("convert", { amount: "10" });
    const before = await t.rail.state();
    const oldPid = t.rail.anvil.pid!;
    process.kill(oldPid, "SIGKILL");
    await until(async () => !(await t.rail.health()).ready, 5_000, "unready after the crash");
    await until(async () => (await t.rail.health()).ready, 30_000, "ready again");
    assert.notEqual(t.rail.anvil.pid, oldPid);
    const s = await t.rail.state();
    assert.equal(s.restoredFromState, true);
    assert.deepEqual([s.treasury.balance, s.reserve.balance, s.lastTrade!.hash], [before.treasury.balance, before.reserve.balance, job.result!.tx!.hash]);
    assert.equal(((await t.rail.receipt(job.result!.tx!.hash)).chain as { status: string }).status, "success");
    assert.equal((await t.act("convert", { amount: "22.5" })).result!.outcome, "executed");
    assert.equal((await t.rail.state()).lastTrade!.amountOut, "20034819");
  } finally { await t.stop(); }
});

test("a port held by another process is left alone and reported", async () => {
  // Since R13 (F-14) a chain takes a free port that browsers refuse and keeps it across a restart, so its clients' address
  // stays valid; if another process took that port meanwhile, the restart is refused and that process is left alone.
  const { createServer } = await import("node:net");
  const { Anvil } = await import("../rail/anvil.ts");
  const dir = freshDir("blocked");
  const a = new Anvil({ bin: join(homedir(), ".foundry", "bin", "anvil"), stateFile: join(dir, "s.hex"), pidFile: join(dir, "anvil.pid") });
  await a.start();
  const port = a.port;
  await a.stop();
  const blocker = createServer().listen(port, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    await assert.rejects(() => a.start(), new RegExp(`Port ${port}, where this chain listened before, is in use by another process; it was left untouched`));
    assert.equal(a.status, "failed");
    assert.equal(blocker.listening, true);
  } finally { blocker.close(); await a.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
