/**
 * Operations on the main treasury besides conversion (baseline F-021, F-022, F-026, F-030, F-041), each through
 * proposal → approval → execute on a real local Anvil chain with the release's unmodified contracts (no mocks):
 * a payment to the approved payee, a forward payment, an owner ring-fence, settlement when due while paused,
 * owner withdrawal and deposit, and a later change of the venue set.
 *
 * Due dates are whole days. The tests move the rail's injected wall clock (the seam test/clock.test.ts uses for a
 * sleeping machine); the rail realigns the chain to it, so no block is ever mined ahead of the rail's clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { approve, key, startRail, type TestRail } from "./helpers.ts";
import { startService } from "./service-helper.ts";
import { RailError } from "../rail/service.ts";
import { devAccount } from "../rail/keys.ts";
import type { Accepted, LiabilityView, PaymentLimits, RailState } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const rejects = (f: () => unknown, code: string) => assert.rejects(async () => f(), (e: unknown) => { assert.ok(e instanceof RailError, `expected a RailError, got ${String(e)}`); assert.equal((e as RailError).code, code); return true; });
const settle = async (t: TestRail, id: string, k = key()) => t.rail.waitForJob(t.rail.submit("settle", t.rail.treasury.settleParams(id), k).jobId);
const failing = (checks: { id: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.id);

test("payment from the main treasury (F-030): 3.123456 tUSD reaches only CloudCo under the mandate and a co-signer certificate; a replay, an unlisted payee and spend above the earned allowance are refused", { timeout: 120_000 }, async () => {
  const t = await startRail("treasury-pay", 18711);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const s0 = await t.rail.state();
    const cloudco = s0.roles.creditor;
    const usd = (who: string) => t.rail.bal(A.usd, who as never);

    const p = await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "3.123456" } });
    assert.equal(p.allowed, true);
    assert.deepEqual([p.terms.payee, p.terms.payeeLabel, p.terms.amount, p.terms.amountRaw, p.terms.dueInDays, p.terms.instruction], [cloudco, "CloudCo", "3.123456", "3123456", 0, "Pay CloudCo 3.123456 tUSD"]);
    assert.match(p.terms.message as string, new RegExp(`^QED owner instruction\\nvault: ${A.vault}\\npay: ${cloudco}\\namount: 3123456\\ndueInDays: 0\\nnonce: rail-[0-9a-f]{8}-\\d+$`));
    assert.deepEqual(p.checks.map((c) => c.id), ["amount", "mandate-valid", "per-conversion", "mandate-period", "mandate-lifetime", "vault-daily", "free-buffer", "not-paused", "earned-autonomy"]);
    // the same checks as a read: nothing is prepared, and none of the rail's budget is used
    const budget = JSON.stringify(await t.rail.quota());
    const fresh = await t.rail.treasury.paymentLimits(null);
    const conversionMax = BigInt((await t.rail.maximum()).maximum);
    assert.deepEqual([fresh.earned, fresh.mandate, fresh.allowed, fresh.execution, fresh.checks.map((c) => c.id)], [{ limit: "10000000", used: "0", remaining: "10000000" }, true, true, "none", p.checks.map((c) => c.id)]);
    assert.equal(fresh.maximum, (conversionMax < 10_000_000n ? conversionMax : 10_000_000n).toString(), "the largest payment is the smaller of the conversion ceiling and what is left of the earned allowance");
    assert.equal(JSON.stringify(await t.rail.quota()), budget);
    await rejects(() => t.rail.treasury.paymentLimits("1e2"), "invalid_amount");
    const k = key(), a = approve(p);
    const first = t.rail.execute(p.id, a, k);
    assert.deepEqual([t.rail.execute(p.id, a, k).jobId, t.rail.execute(p.id, a, k).duplicate], [first.jobId, true], "the same key is the same job");
    const job = await t.rail.waitForJob(first.jobId);
    assert.equal(job.status, "done", job.error ?? "");
    assert.equal(job.result!.outcome, "executed", job.result!.summary);
    assert.deepEqual(job.steps.map((x) => `${x.key}:${x.status}`), ["mandate:ok", "owner:ok", "cosigner:ok", "submit:ok", "receipt:ok", "reconcile:ok"]);

    // the money: exactly 3.123456 left the treasury and reached the approved payee, and every cap counted it
    const s = await t.rail.state();
    assert.deepEqual([s.treasury.balance, (await usd(cloudco)).toString(), s.treasury.spentInWindow, s.mandate!.usage.lifetime.spent, s.treasury.ringFenced], ["96876544", "3123456", "3123456", "3123456", "0"]);
    const rc = await t.rail.receipt(job.result!.tx!.hash);
    assert.deepEqual([String(rc.stored!.from).toLowerCase(), String(rc.stored!.to).toLowerCase()], [s.roles.operator.toLowerCase(), A.exec.toLowerCase()], "sent by the operator key through QEDExecution.pay");
    const paid = (rc.stored!.events as { name: string; args: Record<string, string> }[]).find((e) => e.name === "PaymentExecuted")!;
    assert.deepEqual([paid.args.recipient, paid.args.amount, paid.args.liabilityId], [cloudco, "3123456", "0"]);
    assert.equal(t.rail.jobs(50).filter((j) => j.kind === "pay").length, 1, "one execution for three identical submissions");
    await rejects(() => t.rail.execute(p.id, approve(p), key()), "proposal_used");

    // the co-signer's verdict is stored with the approval, and its record hashes to the certificate's evidence hash
    const d = t.rail.decisions(10, job.id);
    assert.deepEqual(d.map((x) => [x.kind, x.verdict]), [["cosigner-payment", "APPROVED"]]);
    const rec = d[0].record as { checks: { id: string; pass: boolean }[]; request: { kind: string } };
    assert.deepEqual(rec.checks.map((c) => c.id), ["C1", "C2", "C3", "C6", "C9", "C10", "C11", "C12"]);
    assert.deepEqual([rec.request.kind, d[0].approval?.approvalId, d[0].termsHash, V.records.hashRecord(d[0].record)], ["owner-instructed", a.approvalId, p.termsHash, d[0].evidenceHash]);
    assert.equal(paid.args.evidenceHash, d[0].evidenceHash, "the chain anchors the same hash");

    // a replay of the genuine certificate is refused by the vault itself
    const file = JSON.parse(readFileSync(join(t.dir, "rail", "records", `${d[0].evidenceHash}.json`), "utf8")) as { certificate: Record<string, string>; signature: string };
    const c = file.certificate;
    const cert = { ...c, amount: BigInt(c.amount), dueAt: BigInt(c.dueAt), notBefore: BigInt(c.notBefore), expiresAt: BigInt(c.expiresAt), epoch: BigInt(c.epoch) };
    const am = t.rail.activeMandate()!;
    const replay = await t.rail.c.sendExpectingRevert(t.rail.K.OPERATOR, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "pay", [am.mandate, am.ownerSig, cert, file.signature]), 3_000_000n);
    assert.deepEqual([replay.status, replay.error.name], ["reverted", "IntentAlreadyUsed"]);
    assert.equal((await usd(cloudco)).toString(), "3123456");

    // a payee outside the mandate: refused by the rail's fixed payee book, by the co-signer (C9), and by the vault
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: "Mallory", amount: "1" } }), "unknown_payee");
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: s.roles.attacker, amount: "1" } }), "unknown_payee");
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: "Euro reserve", amount: "1" } }), "unknown_payee");
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1", to: s.roles.attacker } }), "invalid_params");
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1e2" } }), "invalid_amount");
    await rejects(() => t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1", dueInDays: 366 } }), "invalid_params");
    const stranger = t.rail.K.LP1.address;
    const ask = async (payee: string, amount: bigint) => {
      const nonce = `treasury-test-${key()}`;
      const instructionSig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerInstructionMessage(A.vault, payee as never, amount, undefined, nonce) });
      return t.rail.cosigner.evaluatePayment({ kind: "owner-instructed", mandate: am.mandate, ownerSig: am.ownerSig, payee, amount, instruction: "test", nonce, instructionSig });
    };
    const unlisted = await ask(stranger, 1_000_000n);
    assert.deepEqual([unlisted.approved, failing(unlisted.checks), unlisted.certificate], [false, ["C9"], undefined]);
    const ts = await t.rail.chainNow();
    const forgedCert = { mandateHash: am.hash, recipient: stranger, amount: 1_000_000n, dueAt: 0n, intentId: `0x${"33".repeat(32)}`, evidenceHash: `0x${"44".repeat(32)}`, ref: `0x${"55".repeat(32)}`, notBefore: ts - 60n, expiresAt: ts + 3600n, epoch: am.mandate.epoch };
    const forgedSig = await V.eip712.signCertificate(devAccount("COSIGNER"), 31337, A.vault, forgedCert as never);
    assert.equal((await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "pay", [am.mandate, am.ownerSig, forgedCert, forgedSig])))!.name, "PayeeNotInMandate", "with the operator key and the co-signer key both misused");
    // only the operator key reaches QEDExecution.pay, and a trade certificate cannot be used as a payment
    assert.equal((await t.rail.c.simulateError(t.rail.K.MALLORY.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "pay", [am.mandate, am.ownerSig, cert, file.signature])))!.name, "NotOperator");

    // the release's earned-autonomy rule (C12): 10 tUSD plus half of verified revenue. Preview and co-signer agree to the unit.
    const left = 10_000_000n - 3_123_456n;
    const over = await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "6.876545" } });
    assert.deepEqual([over.allowed, failing(over.checks)], [false, ["earned-autonomy"]]);
    const autonomy = over.checks.find((x) => x.id === "earned-autonomy")!;
    assert.deepEqual([autonomy.limit, autonomy.used, autonomy.remaining], ["10000000", "3123456", left.toString()]);
    const readOver = await t.rail.treasury.paymentLimits("6.876545");
    assert.deepEqual([readOver.allowed, failing(readOver.checks), readOver.earned, readOver.maximum], [false, ["earned-autonomy"], { limit: "10000000", used: "3123456", remaining: left.toString() }, left.toString()], "the read says what the proposal says");
    assert.equal((await t.rail.treasury.paymentLimits("6.876544")).allowed, true);
    assert.deepEqual(failing((await ask(cloudco, left + 1n)).checks), ["C12"], "the co-signer refuses the same unit the preview refuses");
    const refused = await t.rail.waitForJob(t.rail.execute(over.id, approve(over), key()).jobId);
    assert.deepEqual([refused.result!.outcome, refused.result!.tx, t.rail.store.attempts(refused.id).length], ["refused", undefined, 0]);
    assert.equal(refused.result!.summary, "Refused before signing: a payment of 6.876545 tUSD to CloudCo is more than is left of the co-signer's earned allowance. No transaction was sent.");
    const exact = await t.act("pay", { payee: "CloudCo", amount: "6.876544" });
    assert.equal(exact.result!.outcome, "executed", exact.result!.summary);
    assert.equal((await usd(cloudco)).toString(), "10000000");
    assert.deepEqual(failing((await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "0.000001" } })).checks), ["earned-autonomy"]);
    // conversions are not held to C12, but the release's rule counts them as spend for later payments
    assert.equal((await t.act("convert", { amount: "10" })).result!.outcome, "executed");
    assert.equal((await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1" } })).checks.find((x) => x.id === "earned-autonomy")!.used, "20000000");
    const spent = await t.rail.treasury.paymentLimits(null);
    assert.deepEqual([spent.earned, spent.maximum, spent.allowed], [{ limit: "10000000", used: "20000000", remaining: "0" }, "0", false]);
    assert.equal(t.rail.verifyDecisions().ok, true);
    assert.deepEqual(t.rail.history(50).filter((h) => h.kind === "payment").map((h) => h.outcome), ["executed", "executed"]);
  } finally { await t.stop(); }
});

test("forward payment and owner ring-fence (F-021, F-022): funded at creation and counted against the caps; untouchable by owner and agent; settled to the creditor when due, while paused, without a new approval", { timeout: 120_000 }, async () => {
  let offset = 0, mono = 0;
  const t = await startRail("treasury-liabilities", 18712, { heartbeatMs: 3_600_000, wallClock: () => Date.now() + offset, monoClock: () => mono });
  const pass = async (seconds: number) => { offset += seconds * 1000; mono += 2_000; assert.equal((await t.rail.tick())!.kind, "suspend"); };
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const cloudco = (await t.rail.state()).roles.creditor;
    const usd = async (who: string) => (await t.rail.bal(A.usd, who as never)).toString();
    assert.deepEqual(await t.rail.treasury.liabilities(), []);

    // a forward payment: the agent's promise, funded now, due in seven days
    const fp = await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "4", dueInDays: 7 } });
    assert.match(fp.terms.message as string, /\namount: 4000000\ndueInDays: 7\nnonce: /);
    assert.deepEqual([fp.terms.amount, fp.terms.instruction], ["4", "Promise CloudCo 4 tUSD, due in 7 days"]);
    const fj = await t.rail.waitForJob(t.rail.execute(fp.id, approve(fp, { confirmedAt: new Date(t.rail.now()).toISOString() }), key()).jobId);
    assert.equal(fj.result?.outcome, "executed", fj.error ?? fj.result?.summary);
    assert.equal((fj.result!.evidence as { liabilityId: string }).liabilityId, "1");
    let s = await t.rail.state();
    assert.deepEqual([s.treasury.balance, s.treasury.ringFenced, s.treasury.free, s.treasury.openLiabilities, s.treasury.spentInWindow, s.mandate!.usage.lifetime.spent, await usd(cloudco)], ["100000000", "4000000", "96000000", "1", "4000000", "4000000", "0"], "nothing left the vault, but the amount is ring-fenced and every cap counted it");
    let ls = await t.rail.treasury.liabilities();
    assert.deepEqual(ls.map((l) => [l.id, l.creditor, l.creditorLabel, l.amount, l.status, l.due, l.createdByRole]), [["1", cloudco, "CloudCo", "4000000", "open", false, "agent"]]);
    assert.ok(Math.abs(ls[0].dueAt - (Math.floor(t.rail.now() / 1000) + 7 * 86_400)) <= 5);

    // the owner ring-fences 70.123456 for the same creditor, due tomorrow: free funds fall, the agent's caps do not move
    const rp = await t.rail.propose({ kind: "ring-fence", params: { creditor: "CloudCo", amount: "70.123456", dueInDays: 1 } });
    assert.deepEqual((rp.terms.actions as { contract: string; function: string }[]).map((x) => `${x.contract}.${x.function}`), ["QEDVault (treasury).ringFence"]);
    const rj = await t.rail.waitForJob(t.rail.execute(rp.id, approve(rp, { confirmedAt: new Date(t.rail.now()).toISOString() }), key()).jobId);
    assert.equal(rj.result?.outcome, "executed", rj.error ?? rj.result?.summary);
    assert.equal(String((await t.rail.receipt(rj.result!.tx!.hash)).stored!.from).toLowerCase(), t.rail.owner.address.toLowerCase());
    assert.deepEqual(t.rail.decisions(5, rj.id).map((x) => [x.kind, x.verdict, x.termsHash]), [["owner-ring-fence", "SENT", rp.termsHash]]);
    s = await t.rail.state();
    assert.deepEqual([s.treasury.balance, s.treasury.ringFenced, s.treasury.free, s.treasury.openLiabilities, s.treasury.spentInWindow], ["100000000", "74123456", "25876544", "2", "4000000"]);
    ls = await t.rail.treasury.liabilities();
    assert.deepEqual(ls.map((l) => [l.id, l.amount, l.status, l.createdByRole]), [["1", "4000000", "open", "agent"], ["2", "70123456", "open", "owner"]]);
    await rejects(() => t.rail.propose({ kind: "ring-fence", params: { creditor: "Mallory", amount: "1", dueInDays: 1 } }), "unknown_payee");
    await rejects(() => t.rail.propose({ kind: "ring-fence", params: { creditor: "CloudCo", amount: "1" } }), "invalid_params");
    await rejects(() => t.rail.propose({ kind: "ring-fence", params: { creditor: "CloudCo", amount: "1", dueInDays: 0 } }), "invalid_params");
    const tooMuch = await t.rail.propose({ kind: "ring-fence", params: { creditor: "CloudCo", amount: "25.876545", dueInDays: 1 } });
    assert.deepEqual([tooMuch.allowed, failing(tooMuch.checks)], [false, ["free-balance"]]);

    // ring-fenced money cannot be spent, withdrawn or released by the owner or the agent
    const owner = devAccount("OWNER").address, operator = t.rail.K.OPERATOR;
    const fn = (name: string, args: unknown[]) => V.chain.fn(V.abi.QEDVaultAbi, name, args);
    const w = await t.rail.propose({ kind: "withdraw", params: { amount: "25.876545" } });
    assert.deepEqual([w.allowed, failing(w.checks)], [false, ["free-balance"]]);
    const wj = await t.rail.waitForJob(t.rail.execute(w.id, approve(w, { confirmedAt: new Date(t.rail.now()).toISOString() }), key()).jobId);
    assert.deepEqual([wj.result!.outcome, wj.result!.tx, t.rail.store.attempts(wj.id).length], ["refused", undefined, 0]);
    assert.match(wj.result!.summary, /25\.876545 tUSD.*25\.876544 tUSD/, "refused with both figures");
    const solvency = (await t.rail.c.simulateError(owner, A.vault, fn("withdraw", [owner, 25_876_545n])))!;
    assert.deepEqual([solvency.name, solvency.args.map(String)], ["SolvencyViolation", ["25876545", "25876544"]], "the vault itself answers with both figures");
    assert.equal((await t.rail.c.simulateError(owner, A.vault, fn("release", [2n])))!.name, "NotCreditor");
    assert.equal((await t.rail.c.sendExpectingRevert(operator, A.vault, fn("release", [2n]), 2_000_000n)).error.name, "NotCreditor");
    assert.equal((await t.rail.c.simulateError(operator.address, A.vault, fn("withdraw", [operator.address, 1n])))!.name, "NotOwner");
    // the agent can spend free funds only, less the co-signer's 5 tUSD buffer: 25.876544 − 5 = 20.876544, to the unit
    assert.equal((await t.rail.limits("20.876544")).allowed, true);
    assert.deepEqual(failing((await t.rail.limits("20.876545")).checks), ["free-buffer"]);
    assert.equal((await t.rail.maximum()).maximum, "20876544");

    // not due yet: nothing is sent; the vault would answer NotDueYet
    const early = await settle(t, "2");
    assert.deepEqual([early.status, early.result!.outcome, early.result!.tx, t.rail.store.attempts(early.id).length], ["done", "refused", undefined, 0]);
    assert.match(early.result!.summary, /not due until \d{4}-\d\d-\d\dT/);
    assert.equal((await t.rail.c.simulateError(operator.address, A.vault, fn("settle", [2n])))!.name, "NotDueYet");

    // the guardian pauses the agent; a day passes; the bill is settled to its creditor all the same, with no approval
    assert.equal((await t.act("guardian-pause")).result?.outcome, "executed");
    await pass(86_405);
    ls = await t.rail.treasury.liabilities();
    assert.deepEqual(ls.map((l) => [l.id, l.due]), [["1", false], ["2", true]]);
    const k = key();
    const paidOut = await settle(t, "2", k);
    assert.equal(paidOut.status, "done", paidOut.error ?? "");
    assert.equal(paidOut.result!.outcome, "executed", paidOut.result!.summary);
    assert.equal(paidOut.proposalId, null, "no proposal and no approval: the contract lets anyone settle a due liability");
    assert.deepEqual(paidOut.steps.map((x) => `${x.key}:${x.status}`), ["liability:ok", "submit:ok", "receipt:ok", "reconcile:ok"]);
    s = await t.rail.state();
    assert.deepEqual([s.treasury.paused, s.treasury.balance, s.treasury.ringFenced, s.treasury.openLiabilities, await usd(cloudco)], [true, "29876544", "4000000", "1", "70123456"], "CloudCo received exactly 70.123456 while the agent was paused");
    const settled = (await t.rail.receipt(paidOut.result!.tx!.hash)).stored!.events as { name: string; args: Record<string, string> }[];
    assert.deepEqual(settled.filter((e) => e.name === "LiabilitySettled").map((e) => [e.args.id, e.args.creditor, e.args.amount]), [["2", cloudco, "70123456"]]);
    assert.deepEqual([(await settle(t, "2", k)).id, t.rail.submit("settle", t.rail.treasury.settleParams("2"), k).duplicate], [paidOut.id, true]);
    const again = await settle(t, "2");
    assert.deepEqual([again.result!.outcome, again.result!.tx], ["no-action", undefined], "a settled liability is not paid twice");
    assert.deepEqual(failing((await t.rail.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1" } })).checks), ["not-paused"], "the agent itself stays stopped");
    assert.equal((await t.act("resume")).result?.outcome, "executed");

    // the forward payment falls due six days later and is paid the same way
    await pass(6 * 86_400);
    const last = await settle(t, "1");
    assert.equal(last.result!.outcome, "executed", last.error ?? last.result!.summary);
    assert.deepEqual([await usd(cloudco), (await t.rail.state()).treasury.ringFenced, (await t.rail.treasury.liabilities()).map((l) => l.status)], ["74123456", "0", ["settled", "settled"]]);
    for (const bad of ["abc", "0", "-1", "1.5", ""]) await rejects(() => t.rail.treasury.settleParams(bad), "invalid_params");
    const unknown = await settle(t, "9");
    assert.deepEqual([unknown.status, unknown.result], ["failed", null]);
    assert.match(unknown.error!, /no liability #9/i);
    assert.deepEqual(t.rail.history(50).filter((h) => h.kind === "settlement").map((h) => h.outcome), ["executed", "no-action", "executed"], "newest first: #1 paid, the second request for #2 did nothing, #2 paid");
    assert.equal(t.rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});

test("deposit and withdrawal (F-026): the owner withdraws free funds only and is refused above them with both figures; a deposit returns funds; the limits follow", { timeout: 120_000 }, async () => {
  const t = await startRail("treasury-funds", 18713);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a, owner = t.rail.owner.address;
    const usd = async (who: string) => (await t.rail.bal(A.usd, who as never)).toString();

    const w = await t.rail.propose({ kind: "withdraw", params: { amount: "20" } });
    assert.deepEqual([w.allowed, w.terms.to, w.terms.amount, (w.terms.actions as { function: string; args: unknown[] }[])[0].function, (w.terms.actions as { args: unknown[] }[])[0].args], [true, owner, "20", "withdraw", [owner, "20000000"]]);
    const wj = await t.rail.waitForJob(t.rail.execute(w.id, approve(w), key()).jobId);
    assert.equal(wj.result?.outcome, "executed", wj.error ?? wj.result?.summary);
    assert.deepEqual([(await t.rail.state()).treasury.balance, await usd(owner)], ["80000000", "20000000"]);
    const rc = await t.rail.receipt(wj.result!.tx!.hash);
    assert.deepEqual([String(rc.stored!.from).toLowerCase(), (rc.stored!.events as { name: string }[]).some((e) => e.name === "Withdrawn")], [owner.toLowerCase(), true]);
    assert.deepEqual(t.rail.decisions(5, wj.id).map((x) => [x.kind, x.verdict, x.termsHash]), [["owner-withdraw", "SENT", w.termsHash]]);
    await rejects(() => t.rail.execute(w.id, approve(w), key()), "proposal_used");

    // above the free balance: refused before anything is sent, naming what was asked and what is free
    const big = await t.rail.propose({ kind: "withdraw", params: { amount: "80.000001" } });
    const free = big.checks.find((c) => c.id === "free-balance")!;
    assert.deepEqual([big.allowed, free.pass, free.limit], [false, false, "80000000"]);
    const bj = await t.rail.waitForJob(t.rail.execute(big.id, approve(big), key()).jobId);
    assert.deepEqual([bj.result!.outcome, bj.result!.tx, t.rail.store.attempts(bj.id).length], ["refused", undefined, 0]);
    assert.match(bj.result!.summary, /80\.000001 tUSD.*80\.00 tUSD/);
    assert.equal((await t.rail.state()).treasury.balance, "80000000");

    // a deposit from the owner's own account: approve, then deposit; the allowance is used up exactly
    const dp = await t.rail.propose({ kind: "deposit", params: { amount: "5.5" } });
    assert.deepEqual((dp.terms.actions as { contract: string; function: string }[]).map((x) => `${x.contract}.${x.function}`), ["TestUSD (tUSD).approve", "QEDVault (treasury).deposit"]);
    assert.equal(dp.terms.amount, "5.5");
    const dj = await t.rail.waitForJob(t.rail.execute(dp.id, approve(dp), key()).jobId);
    assert.equal(dj.result?.outcome, "executed", dj.error ?? dj.result?.summary);
    assert.deepEqual([(await t.rail.state()).treasury.balance, await usd(owner)], ["85500000", "14500000"]);
    assert.equal(String(await t.rail.read(A.usd, V.abi.TestUSDAbi, "allowance", [owner, A.vault])), "0");
    assert.deepEqual(t.rail.decisions(5, dj.id).map((x) => x.kind), ["owner-deposit", "owner-deposit"]);
    const poor = await t.rail.propose({ kind: "deposit", params: { amount: "14.500001" } });
    assert.deepEqual([poor.allowed, failing(poor.checks)], [false, ["owner-balance"]]);
    const pj = await t.rail.waitForJob(t.rail.execute(poor.id, approve(poor), key()).jobId);
    assert.deepEqual([pj.result!.outcome, pj.result!.tx, t.rail.store.attempts(pj.id).length], ["refused", undefined, 0]);
    for (const kind of ["withdraw", "deposit"] as const) {
      await rejects(() => t.rail.propose({ kind, params: { amount: "1e2" } }), "invalid_amount");
      await rejects(() => t.rail.propose({ kind, params: { amount: "1", to: t.rail.K.MALLORY.address } }), "invalid_params");
    }
    // the agent's limits follow the balance, and the hot keys cannot withdraw
    assert.equal((await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.vault, V.chain.fn(V.abi.QEDVaultAbi, "withdraw", [t.rail.K.OPERATOR.address, 1n])))!.name, "NotOwner");
    assert.equal((await t.act("convert", { amount: "10" })).result!.outcome, "executed");
    assert.equal((await t.rail.state()).treasury.balance, "75500000");
    assert.deepEqual(t.rail.history(50).filter((h) => ["withdrawal", "deposit"].includes(h.kind)).map((h) => [h.kind, h.outcome]), [["deposit", "executed"], ["withdrawal", "executed"]]);
    assert.equal(t.rail.verifyDecisions().ok, true);
  } finally { await t.stop(); }
});

test("venue set (F-041): the planned set is readable before provisioning; the owner later names a new set, and an order signed before the change is refused after it", { timeout: 120_000 }, async () => {
  const t = await startRail("treasury-venues", 18714);
  try {
    const before = await t.rail.state();
    assert.deepEqual([before.provisioned, before.venues.length, before.plannedVenues.length], [false, 0, 5]);
    assert.deepEqual(before.plannedVenues.map((v) => v.label), t.rail.v.scenario.EXEC_VENUES.map((v: { label: string }) => v.label));
    const planned = await t.rail.propose({ kind: "provision" });
    assert.deepEqual((planned.terms.venues as { pool: string; feeBps: number }[]).map((v) => [v.pool, v.feeBps]), before.plannedVenues.map((v) => [v.pool, v.feeBps]), "the state shows the set the provisioning proposal will name");
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const full = await t.rail.state();
    assert.deepEqual([full.venues, full.plannedVenues], [before.plannedVenues, []], "once named, the same five venues with the same reserves");
    const hash = () => t.rail.read(A.exec, V.abi.QEDExecutionAbi, "venueSetHash") as Promise<string>;
    const h5 = await hash();

    // a genuine order, owner-confirmed and co-signed, for the five-venue set
    const am = t.rail.activeMandate()!;
    const nonce = `venues-${key()}`;
    const instructionSig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 5_000_000n, A.usd, A.eur, A.reserve, nonce) });
    const r = await t.rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "before the venue change", nonce, instructionSig, brainEngine: "test" });
    const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
    const data = V.chain.fn(V.abi.QEDExecutionAbi, "trade", [am.mandate, am.ownerSig, r.certificate, r.signature, r.order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]);
    assert.deepEqual([r.approved, r.order.venueSetHash, await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data)], [true, h5, undefined], "it would execute now");

    // the owner names the three direct pools only
    for (const bad of [[], [5], [1, 1], [2, 1], [0, 1, 2, 3, 4, 0], ["0"]]) await rejects(() => t.rail.propose({ kind: "venues", params: { venues: bad } }), "invalid_params");
    const vp = await t.rail.propose({ kind: "venues", params: { venues: [0, 1, 4] } });
    assert.deepEqual((vp.terms.actions as { contract: string; function: string; args: unknown[] }[]).map((x) => [`${x.contract}.${x.function}`, x.args]), [["QEDExecution.setVenues", [[A.pools[0], A.pools[1], A.pools[4]], [30, 5, 100]]]]);
    const vj = await t.rail.waitForJob(t.rail.execute(vp.id, approve(vp), key()).jobId);
    assert.equal(vj.result?.outcome, "executed", vj.error ?? vj.result?.summary);
    const three = await t.rail.state();
    assert.deepEqual(three.venues.map((v) => [v.i, v.label, v.pool]), [0, 1, 4].map((k, i) => [i, V.scenario.EXEC_VENUES[k].label, A.pools[k]]));
    const h3 = await hash();
    assert.notEqual(h3, h5);
    assert.deepEqual(t.rail.decisions(5, vj.id).map((x) => [x.kind, x.verdict, x.termsHash]), [["owner-venues", "SENT", vp.termsHash]]);

    // the order signed before the change is void: mined as a revert, nothing moves
    const stale = await t.rail.c.sendExpectingRevert(t.rail.K.OPERATOR, A.exec, data, 3_000_000n);
    assert.deepEqual([stale.status, stale.error.name, stale.error.args.map(String)], ["reverted", "VenueSetChanged", [h5, h3]]);
    assert.deepEqual([three.treasury.balance, three.reserve.balance], ["100000000", "0"]);

    // conversions go on over the new set (no two-hop path any more); the Security Lab needs the five-venue market
    const conv = await t.act("convert", { amount: "10" });
    assert.equal(conv.result?.outcome, "executed", conv.error ?? conv.result?.summary);
    const trade = (await t.rail.state()).lastTrade!;
    assert.ok(trade.plan.hops.length >= 1 && trade.plan.hops.every((h) => /^tUSD\/tEUR/.test(h.label)), JSON.stringify(trade.plan.hops.map((h) => h.label)));
    assert.ok(BigInt(trade.amountOut) < 9_107_516n, "less than the five-venue optimum of 9.107516");
    // R7 D4: the Security Lab runs on an ephemeral chain with the five-venue market of its own, whatever this workspace names
    assert.equal((await t.rail.propose({ kind: "attack", params: { kind: "skim" } })).allowed, true);

    // back to the five: the same proposal kind, and the Security Lab works again
    assert.equal((await t.act("venues", { venues: [0, 1, 2, 3, 4] })).result?.outcome, "executed");
    assert.deepEqual([(await t.rail.state()).venues.length, await hash()], [5, h5]);
    assert.equal((await t.act("attack", { kind: "skim" })).result!.tx!.error, "NotBestExecution");
    const same = await t.act("venues", { venues: [0, 1, 2, 3, 4] });
    assert.deepEqual([same.result?.outcome, same.result?.tx], ["no-action", undefined], "naming the set that is already named sends nothing");
    assert.equal((await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "setVenues", [[A.pools[0]], [30]])))!.name, "NotVaultOwner");
  } finally { await t.stop(); }
});

test("over HTTP with the co-signer in its own process: a payment, a forward payment, the liabilities list, and settlement by number without an approval", { timeout: 120_000 }, async () => {
  const s = await startService("svc-treasury", 15185, 18715);
  try {
    await s.act("provision");
    await s.act("mandate", { maxPerPayment: "25" });
    assert.equal((await s.call<RailState>("GET", "/state")).data.roles.cosignerIsolation, "separate-process");
    const paid = await s.act("pay", { payee: "CloudCo", amount: "3.123456" });
    assert.deepEqual([paid.status, paid.result?.outcome, paid.steps.map((x) => x.key), paid.steps[2].data!.isolation], ["done", "executed", ["mandate", "owner", "cosigner", "submit", "receipt", "reconcile"], "separate-process"], paid.error ?? paid.result?.summary);
    const promised = await s.act("pay", { payee: "CloudCo", amount: "4", dueInDays: 1 });
    assert.deepEqual([promised.result?.outcome, (promised.result!.evidence as { liabilityId: string }).liabilityId], ["executed", "1"], promised.error ?? promised.result?.summary);
    const ls = (await s.call<{ liabilities: LiabilityView[] }>("GET", "/liabilities")).data.liabilities;
    assert.deepEqual(ls.map((l) => [l.id, l.creditorLabel, l.amount, l.status, l.due, l.createdByRole]), [["1", "CloudCo", "4000000", "open", false, "agent"]]);
    const st = (await s.call<RailState>("GET", "/state")).data;
    assert.deepEqual([st.treasury.balance, st.treasury.ringFenced, st.treasury.free, st.treasury.openLiabilities, st.plannedVenues], ["96876544", "4000000", "92876544", "1", []]);
    // the payment limits as a read: the promise counts against the earned allowance from the moment it is made
    const lim = await s.call<PaymentLimits>("GET", "/payments/limits?amount=2.876545");
    assert.deepEqual([lim.status, lim.data.allowed, lim.data.earned, lim.data.maximum], [200, false, { limit: "10000000", used: "7123456", remaining: "2876544" }, "2876544"]);
    assert.deepEqual([(await s.call<PaymentLimits>("GET", "/payments/limits")).data.allowed, (await s.call("GET", "/payments/limits?amount=abc")).status], [true, 422]);

    // settlement is asked for by number, with a key and no approval; before the due date nothing is sent
    const noKey = await s.call("POST", "/liabilities/1/settle", {});
    assert.deepEqual([noKey.status, noKey.data.error.code], [400, "idempotency_key_required"]);
    const k = key();
    const accepted = await s.call<Accepted>("POST", "/liabilities/1/settle", {}, { "Idempotency-Key": k });
    assert.deepEqual([accepted.status, accepted.data.kind, accepted.headers.get("location")], [202, "settle", `/workspaces/baseline/jobs/${accepted.data.jobId}`]);
    const early = await s.job(accepted.data.jobId);
    assert.deepEqual([early.status, early.result?.outcome, early.result?.tx, early.proposalId], ["done", "refused", undefined, null]);
    assert.match(early.result!.summary, /^Liability #1 \(4\.00 tUSD for CloudCo\) is not due until \d{4}-/);
    assert.deepEqual((await s.call<Accepted>("POST", "/liabilities/1/settle", {}, { "Idempotency-Key": k })).data, { jobId: early.id, kind: "settle", status: "done", duplicate: true });
    for (const [id, status, code] of [["7", 404, "unknown_liability"], ["abc", 422, "invalid_params"], ["0", 422, "invalid_params"]] as const) {
      const r = await s.call("POST", `/liabilities/${id}/settle`, {}, { "Idempotency-Key": key() });
      assert.deepEqual([r.status, r.data.error.code], [status, code], id);
    }
    // the fixed lists hold over HTTP too, and an owner action goes the same way as every other
    const stranger = await s.call("POST", "/proposals", { kind: "pay", params: { payee: st.roles.attacker, amount: "1" } });
    assert.deepEqual([stranger.status, stranger.data.error.code], [422, "unknown_payee"]);
    assert.equal((await s.act("withdraw", { amount: "10" })).result?.outcome, "executed");
    assert.equal((await s.call<RailState>("GET", "/state")).data.treasury.balance, "86876544");
    assert.deepEqual((await s.call("GET", "/history?limit=3")).data.history.map((h: { kind: string }) => h.kind), ["withdrawal", "refusal", "forward-payment"]);
    assert.equal((await s.call("GET", "/decisions/verify")).data.ok, true);
  } finally { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); }
});
