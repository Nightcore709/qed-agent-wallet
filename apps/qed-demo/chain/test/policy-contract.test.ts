/**
 * The standing policy enforced by the unmodified QEDTreasuryPolicy contract on the live rail path (baseline X-06,
 * F-045), with the agent key and the co-signer key both misused against it; the zero-slack defect executed on the
 * unmodified contract (baseline W-11); and the loss and restoration of the direct path (baseline W-12).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { key, startRail } from "./helpers.ts";
import { RailError } from "../rail/service.ts";
import { devAccount } from "../rail/keys.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

test("contract-enforced policy: wired by the owner, ticks go through QEDTreasuryPolicy.convert, four clauses hold against both hot keys", { timeout: 240_000 }, async () => {
  const t = await startRail("policy-contract", 18661);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a, pol = A.treasuryPolicy!;
    const tick = async () => t.rail.waitForJob(t.rail.submit("policy-tick", {}, key()).jobId);
    // What an attacker holding the agent key AND the co-signer key can build: a genuinely co-signed order of any size.
    let n = 0;
    const stolen = async (amount: bigint) => {
      const am = t.rail.activeMandate()!;
      const plan = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, amount);
      const venueSetHash = await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "venueSetHash");
      const order = { tokenOut: A.eur, recipient: A.reserve, minOut: (plan.plan.sim.amountOut * 99n) / 100n, tolerancePpm: 100, venueSetHash };
      const ts = await t.rail.chainNow();
      const cert = { mandateHash: am.hash, recipient: A.exec, amount, dueAt: 0n, intentId: keccak256(toHex(`stolen-cosigner-key:${++n}`)), evidenceHash: keccak256(toHex("no decision record: the co-signer key was stolen")), ref: V.trader.hashOrder(order as never), notBefore: ts - 60n, expiresAt: ts + 3600n, epoch: am.mandate.epoch };
      const sig = await V.eip712.signCertificate(devAccount("COSIGNER"), 31337, A.vault, cert as never);
      return [am.mandate, am.ownerSig, cert, sig, order, V.trader.hopsForChain(plan.plan.route), V.trader.pricesForChain(plan.plan.prices)];
    };
    const mined = async (to: string, data: string) => (await t.rail.c.sendExpectingRevert(t.rail.K.OPERATOR, to, data, 3_000_000n)).error.name;
    const viaPolicy = async (amount: bigint) => mined(pol, V.chain.fn(V.abi.QEDTreasuryPolicyAbi, "convert", await stolen(amount)));

    // the owner signs a policy enforced by the contract; zero slack is refused by the rail
    await assert.rejects(() => t.rail.propose({ kind: "policy", params: { targetFree: "6", enforcement: "contract", needSlackBps: 0 } }), (e: unknown) => e instanceof RailError && e.code === "zero_slack_refused");
    const p = await t.rail.propose({ kind: "policy", params: { targetFree: "6", enforcement: "contract" } });
    assert.deepEqual((p.terms.actions as { contract: string; function: string }[]).map((a) => `${a.contract}.${a.function}`), ["QEDTreasuryPolicy.setPolicy", "QEDExecution.setOperator"]);
    assert.equal(p.terms.needSlackBps, 10);
    const { approve } = await import("./helpers.ts");
    const signed = await t.rail.waitForJob(t.rail.execute(p.id, approve(p), key()).jobId);
    assert.equal(signed.result?.outcome, "executed", signed.error ?? "");
    let s = await t.rail.state();
    assert.deepEqual([s.policy!.enforcement, s.policy!.needSlackBps, s.policy!.policyContract], ["contract", 10, pol]);
    assert.equal(await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "operator"), pol, "the policy contract is now QEDExecution's only operator");
    const onchain: any = await t.rail.read(pol, V.abi.QEDTreasuryPolicyAbi, "policy");
    assert.deepEqual([onchain[0], onchain[1], onchain[2], Number(onchain[3]), Number(onchain[4])], [6_000_000n, 2_000_000n, 25_000_000n, 150, 10]);

    // W-12: while it is wired, the hot key cannot trade directly, so direct conversions and the Security Lab are refused up front
    await assert.rejects(() => t.rail.propose({ kind: "convert", params: { amount: "5" } }), (e: unknown) => e instanceof RailError && e.code === "policy_contract_wired");
    // R7 D4: the Security Lab runs on an ephemeral chain of its own, so this workspace's wiring no longer limits it
    assert.equal((await t.rail.propose({ kind: "attack", params: { kind: "skim" } })).allowed, true);
    await assert.rejects(() => t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1" } }), (e: unknown) => e instanceof RailError && e.code === "policy_contract_wired", "an ordinary payment cannot be reached either: QEDExecution.pay is operator-only");
    assert.equal(await mined(A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "trade", await stolen(5_000_000n))), "NotOperator", "skip the policy contract: refused");

    // both hot keys: convert a quarter more than the shortfall needs
    const view = await V.treasury.observeTreasury(t.rail.pub, t.rail.policy.active()!.policy, A.exec, V.economics.POLICY.reserveBuffer);
    const d = V.treasury.decideTranche(view.venues, t.rail.policy.active()!.policy, view.reserveFree, view.available, t.rail.activeMandate()!.mandate.maxPerPayment);
    assert.equal(d.limitedBy, "need");
    assert.equal(await viaPolicy(d.amountIn + d.amountIn / 4n), "OverConversion");
    assert.equal(await viaPolicy(1_999_999n), "TrancheOutOfBounds");
    const before = await t.rail.state();
    assert.equal(before.reserve.balance, "0", "none of the attacks moved anything");

    // the honest tranche, through the contract
    const job = await tick();
    assert.equal(job.result?.outcome, "executed", job.error ?? job.result?.summary);
    const rc = await t.rail.receipt(job.result!.tx!.hash);
    assert.equal(String(rc.stored!.to).toLowerCase(), pol.toLowerCase(), "the transaction went to the policy contract");
    const names = (rc.stored!.events as { name: string }[]).map((e) => e.name);
    assert.ok(names.includes("PolicyConversion") && names.includes("BestExecution") && names.includes("PaymentExecuted"), names.join(","));
    assert.equal((job.result!.evidence as { enforcement: string }).enforcement, "contract");
    s = await t.rail.state();
    assert.equal(s.policy!.targetMet, true);
    const idle = await tick();
    assert.deepEqual([idle.result!.outcome, idle.result!.tx], ["no-action", undefined]);
    // target met: with both hot keys, another tranche is refused by the contract
    assert.equal(await viaPolicy(2_000_000n), "NoShortfall");

    // a larger target and the maximum tranche into the market: the cost clause
    assert.equal((await t.act("policy", { targetFree: "80", enforcement: "contract" })).result?.outcome, "executed");
    assert.equal(await viaPolicy(25_000_000n), "ExecutionCostTooHigh");
    const run = await t.rail.waitForJob(t.rail.submit("policy-run", { maxTicks: 2, maxSeconds: 120 }, key()).jobId);
    assert.equal((run.result!.evidence as { conversions: number }).conversions, 2, run.result!.summary);

    // W-11, executed on the unmodified contract: with zero slack the tranche that reaches the target can never pass
    assert.equal((await t.act("policy", { targetFree: "70", enforcement: "contract" })).result?.outcome, "executed");
    const live: any = await t.rail.read(pol, V.abi.QEDTreasuryPolicyAbi, "policy");
    await t.rail.c.send(devAccount("OWNER"), pol, V.chain.fn(V.abi.QEDTreasuryPolicyAbi, "setPolicy", [{ targetFree: live[0], minTranche: live[1], maxTranche: live[2], maxImpactBps: live[3], needSlackBps: 0, validUntil: live[5] }]));
    let stuck = await tick();
    for (let i = 0; i < 4 && stuck.status === "done" && stuck.result!.outcome === "executed"; i++) stuck = await tick();
    assert.equal(stuck.status, "failed", "the need-limited tranche that would reach the target is rejected by the contract");
    assert.match(stuck.error!, /OverConversion/);
    assert.equal((await t.rail.state()).policy!.targetMet, false, "with zero slack the target is never reached");
    assert.equal(stuck.guidance, "Nothing was mined for this operation. No money moved.");

    // ending the policy unwires the contract: the direct path and the Security Lab are back (W-12 restored)
    const end = await t.act("policy-revoke");
    assert.equal(end.result?.outcome, "executed", end.error ?? "");
    assert.equal(await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "operator"), t.rail.K.OPERATOR.address);
    assert.equal(Number(((await t.rail.read(pol, V.abi.QEDTreasuryPolicyAbi, "policy")) as any)[5]), 0, "the on-chain policy is revoked");
    assert.equal((await t.act("mandate", { maxPerPayment: "25" })).result?.outcome, "executed");
    assert.equal((await t.act("convert", { amount: "3" })).result?.outcome, "executed");
    assert.equal((await t.act("attack", { kind: "skim" })).result!.tx!.error, "NotBestExecution");
    assert.equal(await mined(pol, V.chain.fn(V.abi.QEDTreasuryPolicyAbi, "convert", await stolen(2_000_000n))), "PolicyLapsed", "the revoked contract refuses the agent key");
  } finally { await t.stop(); }
});
