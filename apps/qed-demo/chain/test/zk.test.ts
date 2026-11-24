/**
 * The optional zero-knowledge tier (parity row F-052). Runs ONLY when zk-optional/ has been enabled
 * (see zk-optional/README.md); otherwise every test here is skipped and says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAIN, key, startRail } from "./helpers.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const enabled = existsSync(join(CHAIN, "zk-optional", "vendor", "agent", "src", "engine", "privateMinvar.ts")) && existsSync(join(CHAIN, "zk-optional", "node_modules", "snarkjs"));
const skip = enabled ? false : "the optional GPL-3.0 tier is not enabled (owner decision F-052)";

test("with the tier enabled: the Groth16 scenario settles and neither weights nor covariance leave the prover", { skip, timeout: 300_000 }, async () => {
  const t = await startRail("zk", 18681, { zk: true });
  try {
    await t.ready();
    const info = t.rail.scenarios.list().find((s) => s.tool === "private_portfolio")!;
    assert.equal(info.available, true);
    const before = await t.rail.state();
    const job = await t.act("scenario", { tool: "private_portfolio", parameters: { price: "4.25", volatilities: [8, 10, 12, 9, 30, 5] } });
    assert.equal(job.status, "done", job.error ?? "");
    assert.equal(job.result!.outcome, "executed", job.result!.summary);
    const ev = job.result!.evidence as Record<string, unknown>;
    assert.ok(ev.weightsCommitment && ev.dataCommitment, "the chain sees commitments");
    assert.deepEqual([ev.weights, ev.cov, ev.private, ev.providerBalance], [undefined, undefined, true, "4250000"]);
    assert.ok(!JSON.stringify(job).includes("\"cov\":"), "no covariance in the stored evidence");
    assert.ok(job.steps.some((s) => s.label === "Groth16 proof generated"));
    const after = await t.rail.state();
    assert.deepEqual([after.treasury.balance, after.reserve.balance], [before.treasury.balance, before.reserve.balance]);
    // the other five still work from the assembled tree, and the default limits are unchanged
    assert.equal((await t.act("scenario", { tool: "payment", parameters: { amount: "3.123456" } })).result?.outcome, "executed");
    assert.equal((await t.act("convert", { amount: "10" })).result?.outcome, "executed");
    assert.equal((await t.rail.state()).lastTrade!.amountOut, "9107516");
  } finally { await t.stop(); }
});

test("with the tier enabled: the privacy economy completes with the step ids of the bundled Run 3 manifest", { skip, timeout: 420_000 }, async () => {
  const t = await startRail("zk-economy", 18682, { zk: true });
  try {
    await t.ready();
    assert.equal(t.rail.economies.list().find((e) => e.scenario === "privacy")!.available, true);
    const job = await t.rail.waitForJob(t.rail.economies.start({ scenario: "privacy" }, key()).jobId, 400_000);
    assert.equal(job.status, "done", job.error ?? "");
    const ev = job.result!.evidence as any;
    assert.deepEqual(ev.comparedWithBundledManifest.missingHere, []);
    assert.ok(ev.reverted >= 8, `${ev.reverted} reverted steps (counterfeits and bounty claims)`);
    assert.ok(!readdirSync(ev.outputFolder).includes("honeypot.json"));
  } finally { await t.stop(); }
});

test("without the flag the rail does not read the tier at all", async () => {
  const t = await startRail("zk-off", 18683);
  try {
    assert.equal(t.rail.cfg.vendorRoot, join(CHAIN, "vendor"));
    assert.equal(t.rail.scenarios.list().find((s) => s.tool === "private_portfolio")!.available, false);
    assert.equal(t.rail.economies.list().find((e) => e.scenario === "privacy")!.available, false);
  } finally { await t.stop(); }
});
