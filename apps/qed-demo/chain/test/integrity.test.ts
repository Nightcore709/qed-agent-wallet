/**
 * Integrity checks around the core: proposals expire, an injected reconciliation mismatch ends in "do not retry",
 * an altered decision record is detected, and a rail whose vendored release files were changed never becomes ready.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { approve, CHAIN, freshDir, key, startRail } from "./helpers.ts";
import { createRail } from "../rail/index.ts";
import { RailError } from "../rail/service.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

test("a proposal expires: after its ten minutes (here 300 ms) it cannot be executed, whatever the approval says", async () => {
  const t = await startRail("integrity-expiry", 18691, { proposalTtlMs: 300 });
  try {
    const p = await t.rail.propose({ kind: "provision" });
    const a = approve(p);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(t.rail.proposal(p.id).status, "expired");
    assert.throws(() => t.rail.execute(p.id, a, key()), (e: unknown) => e instanceof RailError && e.code === "proposal_expired");
    assert.throws(() => t.rail.execute(p.id, approve(p), key()), (e: unknown) => e instanceof RailError && e.code === "proposal_expired");
    assert.equal((await t.rail.state()).provisioned, false);
    const cancelled = await t.rail.propose({ kind: "provision" });
    t.rail.cancelProposal(cancelled.id);
    assert.throws(() => t.rail.execute(cancelled.id, approve(cancelled), key()), (e: unknown) => e instanceof RailError && e.code === "proposal_cancelled");
    // a proposal is bound to the chain it was prepared for: one that carries another genesis id cannot be executed here
    const foreign = await t.rail.propose({ kind: "provision" });
    t.rail.store.db.prepare("UPDATE proposals SET genesis_id = ? WHERE id = ?").run("00000000-another-chain", foreign.id);
    assert.throws(() => t.rail.execute(foreign.id, approve(foreign), key()), (e: unknown) => e instanceof RailError && e.code === "proposal_stale");
    assert.equal((await t.rail.state()).provisioned, false);
  } finally { await t.stop(); }
});

test("an injected reconciliation mismatch: the job ends as an error with do-not-retry, and it cannot be run again", async () => {
  const t = await startRail("integrity-reconcile", 18692);
  try {
    await t.ready();
    const real = t.rail.bal;
    let calls = 0;
    // The conversion reads four balances: reserve and vault before, reserve and vault after. Falsify the third.
    t.rail.bal = async (token, who) => (++calls === 3 ? (await real(token, who)) + 1n : real(token, who));
    const p = await t.rail.propose({ kind: "convert", params: { amount: "10" } });
    const k = key(), a = approve(p);
    const job = await t.rail.waitForJob(t.rail.execute(p.id, a, k).jobId);
    t.rail.bal = real;
    assert.equal(job.status, "done");
    assert.deepEqual([job.result!.outcome, job.result!.doNotRetry], ["error", true]);
    assert.match(job.result!.summary, /^Transaction 0x[0-9a-f]{64} mined, but balance reconciliation failed\. Do not retry; inspect the receipt\.$/);
    assert.equal(job.guidance, "The transaction was mined but the balances did not reconcile. Do not retry; inspect the receipt.");
    assert.deepEqual(job.steps.at(-1) && [job.steps.at(-1)!.key, job.steps.at(-1)!.status], ["reconcile", "refused"]);
    assert.equal(t.rail.history(1)[0].outcome, "error");
    // retry is blocked: the same key returns the same job, and the proposal is spent
    assert.deepEqual([t.rail.execute(p.id, a, k).jobId, t.rail.execute(p.id, a, k).duplicate], [job.id, true]);
    assert.throws(() => t.rail.execute(p.id, approve(p), key()), (e: unknown) => e instanceof RailError && e.code === "proposal_used");
    assert.equal((await t.rail.receipt(job.result!.tx!.hash)).stored!.status, "success", "the receipt is there to inspect");
  } finally { await t.stop(); }
});

test("an altered decision record breaks the hash chain, and the check says where", async () => {
  const t = await startRail("integrity-chain", 18693);
  const dir = t.dir;
  try {
    await t.ready();
    await t.act("convert", { amount: "10" });
    const before = t.rail.verifyDecisions();
    assert.equal(before.ok, true);
    await t.stop({ keep: true });
    // Someone with file access removes the append-only trigger and edits one verdict.
    const db = new DatabaseSync(join(dir, "rail.db"));
    db.exec("DROP TRIGGER decisions_no_update; UPDATE decisions SET verdict = 'REFUSED' WHERE n = 2;");
    db.close();
    const again = await startRail("integrity-chain", 18693, { dataDir: dir });
    try {
      const v = again.rail.verifyDecisions();
      assert.deepEqual([v.ok, v.brokenAt, v.records], [false, 2, 2]);
      assert.throws(() => again.rail.store.db.exec("UPDATE decisions SET verdict = 'X' WHERE n = 1"), /append-only/, "the trigger is put back at start");
    } finally { await again.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vendored release files that no longer match VENDORED.json: the rail refuses to start and health stays unready", async () => {
  const tree = join(freshDir("integrity-vendor"), "vendor");
  cpSync(join(CHAIN, "vendor"), tree, { recursive: true });
  const ok = createRail({ dataDir: freshDir("integrity-vendor-ok"), anvilPort: 18694, vendorRoot: tree, cosigner: "in-process" });
  try {
    await ok.start();
    assert.equal((await ok.health()).readiness.vendored, true, "an exact copy is accepted");
  } finally { await ok.stop(); rmSync(ok.cfg.dataDir, { recursive: true, force: true }); }
  appendFileSync(join(tree, "agent/src/roles/cosigner.ts"), "\n// edited after vendoring\n");
  const bad = createRail({ dataDir: freshDir("integrity-vendor-bad"), anvilPort: 18694, vendorRoot: tree, cosigner: "in-process" });
  try {
    await assert.rejects(() => bad.start(), /vendored release files do not match their recorded hashes: agent\/src\/roles\/cosigner\.ts/);
    const h = await bad.health();
    assert.deepEqual([h.ready, h.readiness.vendored, h.readiness.rail], [false, false, "failed"]);
  } finally { await bad.stop().catch(() => {}); rmSync(bad.cfg.dataDir, { recursive: true, force: true }); rmSync(join(tree, ".."), { recursive: true, force: true }); }
});
