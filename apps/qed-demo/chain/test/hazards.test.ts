/**
 * R7 D4: one shared chain, no shared hazards. A workspace's Security Lab attack and a time-moving scenario run on
 * ephemeral chains of their own while another workspace transacts on the shared chain at the same time; the other
 * workspace's balances and jobs, and the shared chain's clock, are unaffected, and the ephemeral chains are gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { startHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const portFree = (port: number) => new Promise<boolean>((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(port, "127.0.0.1", () => s.close(() => ok(true))); });

test("an attack and a time-moving scenario for one workspace run on ephemeral chains while another workspace transacts: the other's balances, jobs and the shared chain's clock are unaffected", { timeout: 300_000 }, async () => {
  const h = await startHost("hazards", 18750, { heartbeatMs: 3_600_000 });
  try {
    const alice = new SoftwarePasskey(), bob = new SoftwarePasskey();
    const A = await h.workspace("lab-alice", [alice]), B = await h.workspace("shop-bob", [bob]);
    for (const [ws, k] of [[A, alice], [B, bob]] as const) assert.equal((await h.act(ws, "provision", {}, [k])).result?.outcome, "executed");
    assert.equal((await h.act(B, "mandate", { maxPerPayment: "2500" }, [bob])).result?.outcome, "executed");
    // R7 D7: an 840 tINR conversion may cost up to about 14 tINR against the reference (its worst case), more than the 10 tINR base; the owner grants authority (no money moves)
    assert.equal((await h.act(B, "grant", { amount: "100" }, [bob])).result?.outcome, "executed");
    const bal = (token: `0x${string}`, who: `0x${string}`) => B.read(token, B.v.abi.TestUSDAbi, "balanceOf", [who]) as Promise<bigint>;
    const b0 = { vault: await bal(B.a.asset!, B.a.vault), reserve: await bal(B.a.reserveAsset!, B.a.reserve), account: await bal(B.a.asset!, B.a.ownerAccount!) };
    const a0 = await A.state();
    const start = await A.pub.getBlock(), wall0 = Date.now();

    // at the same time: A's hazards on ephemeral chains, B's ordinary work on the shared chain
    const [aJobs, bJobs] = await Promise.all([
      Promise.all([h.act(A, "attack", { kind: "redirect" }, [alice]), h.act(A, "scenario", { tool: "liability_due", parameters: { amount: "10", dueInDays: 30 } }, [alice]), h.act(A, "attack", { kind: "skim" }, [alice])]),
      // a passkey account has one signature slot per nonce, so B's two owner transactions are prepared one after
      // the other (prepared together, the second would be refused as proposal_stale and nothing sent)
      Promise.all([h.act(B, "convert", { amount: "840" }, [bob]), (async () => [await h.act(B, "withdraw", { amount: "100" }, [bob]), await h.act(B, "deposit", { amount: "50" }, [bob])])()]).then(([c, [w, d]]) => [c, w, d]),
    ]);
    const [redirect, due, skim] = aJobs;

    // A's runs: real mined transactions, on chains that no longer exist, and A's own vaults untouched
    for (const [j, err] of [[redirect, "OrderMismatch"], [skim, "NotBestExecution"]] as const) {
      assert.equal(j.result?.outcome, "reverted", j.error ?? "");
      assert.equal(j.result!.tx!.error, err);
      assert.equal((j.result!.evidence as any).chain, "ephemeral");
      assert.equal((j.result!.evidence as any).workspaceUnchanged, true);
      assert.deepEqual([j.steps[0].key, j.steps.at(-1)!.key], ["chain", "teardown"]);
      await assert.rejects(() => A.pub.getTransactionReceipt({ hash: j.result!.tx!.hash }), "the attack's transaction is not on the shared chain");
      assert.match((await A.receipt(j.result!.tx!.hash)).network, /^Ephemeral Anvil chain 31337 of job/);
      assert.equal(await portFree((j.steps[0].data as any).port), true, "its chain is stopped");
    }
    assert.equal(due.result?.outcome, "executed", due.error ?? "");
    const ev = due.result!.evidence as any;
    assert.equal(ev.notDueYet, "NotDueYet");
    assert.ok(ev.ephemeralClock.movedSeconds >= 30 * 86_400, "the scenario's own chain moved forward 30 days");
    assert.ok(ev.sharedChainClock.after - ev.sharedChainClock.before < 120, "the shared chain's clock did not move with it");
    const a1 = await A.state();
    assert.deepEqual([a1.treasury.balance, a1.reserve.balance], [a0.treasury.balance, a0.reserve.balance]);

    // B: every job executed, and its balances moved by exactly its own operations
    for (const j of bJobs) assert.equal(j.result?.outcome, "executed", `${j.kind}: ${j.error ?? j.result?.summary}`);
    const out = BigInt((bJobs[0].result!.evidence as any).amountOut);
    assert.equal(await bal(B.a.asset!, B.a.vault), b0.vault - 84_000n - 10_000n + 5_000n);
    assert.equal(await bal(B.a.reserveAsset!, B.a.reserve), b0.reserve + out);
    assert.equal(await bal(B.a.asset!, B.a.ownerAccount!), b0.account + 10_000n - 5_000n);
    assert.ok(B.jobs(50).every((j) => j.status === "done"));

    // the shared chain's clock: never ahead of the wall clock, never back, never a jump
    const end = await A.pub.getBlock();
    const wallSeconds = Math.floor(Date.now() / 1000);
    assert.ok(Number(end.timestamp) <= wallSeconds + h.host.cfg.maxClockLeadSeconds, "not ahead of the wall clock");
    let prev = Number(start.timestamp);
    for (let n = start.number + 1n; n <= end.number; n++) {
      const t = Number((await A.pub.getBlock({ blockNumber: n })).timestamp);
      assert.ok(t >= prev, `block ${n} does not go back in time`);
      prev = t;
    }
    assert.ok(Number(end.timestamp) - Number(start.timestamp) <= Math.ceil((Date.now() - wall0) / 1000) + 5, "no jump forward: the shared chain moved only as far as the wall clock");
    assert.ok(!h.host.clockEvents(50).some((e) => e.kind === "skew-refusal"));
    const eph = join(h.dir, "rail", "ephemeral");
    assert.ok(!existsSync(eph) || readdirSync(eph).length === 0, "every ephemeral chain's folder is deleted");
  } finally { await h.stop(); }
});
