/**
 * Incident response as callable operations (baseline M-03, WF-16, F-016, F-024, F-025): pause, guardian pause,
 * resume, revoke one mandate, void all, and key rotation. The contracts always supported these; the release's app
 * never exposed them (baseline W-03).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { approve, key, startRail } from "./helpers.ts";
import { RailError } from "../rail/service.ts";
import { devAccount } from "../rail/keys.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

test("pause stops the agent and zeroes the worst-case figure; the guardian can pause but not resume; only the owner resumes", async () => {
  const t = await startRail("admin-pause", 18651);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    // the worst-case figure in its three states: fresh window, partly used window, paused
    assert.equal((await t.rail.state()).treasury.worstCaseLoss24h, "100000000");
    assert.match((await t.rail.state()).treasury.worstCaseScope, /^Transfers to payees the owner approved, within the vault's daily cap\. It does not cover value lost to price moves/, "the figure states its scope");
    await t.act("convert", { amount: "10" });
    assert.equal((await t.rail.state()).treasury.worstCaseLoss24h, "90000000");
    const open = await t.rail.propose({ kind: "convert", params: { amount: "5" } });

    const g = await t.act("guardian-pause");
    assert.equal(g.result?.outcome, "executed", g.error ?? "");
    const rc = await t.rail.receipt(g.result!.tx!.hash);
    assert.equal(String(rc.stored!.from).toLowerCase(), t.rail.K.GUARDIAN.address.toLowerCase(), "sent by the guardian's key, not the owner's");
    let s = await t.rail.state();
    assert.deepEqual([s.treasury.paused, s.treasury.worstCaseLoss24h], [true, "0"]);
    assert.deepEqual((await t.rail.limits("5")).checks.filter((c) => !c.pass).map((c) => c.id), ["not-paused"]);
    assert.equal((await t.rail.maximum()).maximum, "0");
    // an approved but unsent conversion is refused before any signature while paused
    const blocked = await t.rail.waitForJob(t.rail.execute(open.id, approve(open), key()).jobId);
    assert.deepEqual([blocked.result!.outcome, blocked.result!.tx], ["refused", undefined]);
    assert.match(blocked.steps.at(-1)!.detail, /The treasury vault is not paused/);
    // the guardian can make things safer, never riskier
    const unpause = V.chain.fn(V.abi.QEDVaultAbi, "unpause");
    assert.equal((await t.rail.c.simulateError(t.rail.K.GUARDIAN.address, A.vault, unpause)).name, "NotOwner");
    assert.equal((await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.vault, unpause)).name, "NotOwner");
    const r = await t.act("resume");
    assert.equal(r.result?.outcome, "executed", r.error ?? "");
    s = await t.rail.state();
    assert.deepEqual([s.treasury.paused, s.treasury.worstCaseLoss24h], [false, "90000000"]);
    assert.equal((await t.act("convert", { amount: "5" })).result?.outcome, "executed");
    // the owner can pause as well
    const p = await t.act("pause");
    assert.equal(String((await t.rail.receipt(p.result!.tx!.hash)).stored!.from).toLowerCase(), t.rail.owner.address.toLowerCase());
    assert.equal((await t.rail.state()).treasury.paused, true);
    await t.act("resume");
    const kinds = t.rail.decisions(50).map((d) => d.kind);
    for (const k of ["guardian-pause", "owner-resume", "owner-pause"]) assert.ok(kinds.includes(k), k);
  } finally { await t.stop(); }
});

test("revoke one mandate, then void all: unsent work is refused, the contract rejects the old authority, a new mandate works", async () => {
  const t = await startRail("admin-revoke", 18652);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const v1 = t.rail.activeMandate()!;
    const trade = async (m: typeof v1) => {
      const nonce = `admin-${key()}`;
      const sig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 5_000_000n, A.usd, A.eur, A.reserve, nonce) });
      const r = await t.rail.cosigner.evaluateTrade({ mandate: m.mandate, ownerSig: m.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "test", nonce, instructionSig: sig, brainEngine: "test" });
      if (!r.approved) return { name: `cosigner: ${r.reasons[0]}` };
      const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
      return t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "trade", [m.mandate, m.ownerSig, r.certificate, r.signature, r.order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]));
    };
    assert.equal(await trade(v1), undefined, "before revocation the genuine order would execute");
    const open = await t.rail.propose({ kind: "convert", params: { amount: "5" } });
    const rv = await t.act("revoke-mandate");
    assert.equal(rv.result?.outcome, "executed", rv.error ?? "");
    let s = await t.rail.state();
    assert.equal(s.mandate, null, "no active mandate; nothing was signed in its place");
    assert.deepEqual((await t.rail.mandates()).map((m) => [m.version, m.status, m.usage.revokedOnChain]), [[1, "revoked", true]]);
    assert.equal((await trade(v1)).name, "MandateIsRevoked");
    const late = await t.rail.waitForJob(t.rail.execute(open.id, approve(open), key()).jobId);
    assert.equal(late.result!.outcome, "refused");
    await assert.rejects(() => t.rail.propose({ kind: "convert", params: { amount: "5" } }), (e: unknown) => e instanceof RailError && e.code === "no_mandate");
    await assert.rejects(() => t.rail.propose({ kind: "revoke-mandate" }), (e: unknown) => e instanceof RailError && e.code === "no_mandate");

    assert.equal((await t.act("mandate", { maxPerPayment: "20" })).result?.outcome, "executed");
    const v2 = t.rail.activeMandate()!;
    const vd = await t.act("void-all");
    assert.equal(vd.result?.outcome, "executed", vd.error ?? "");
    s = await t.rail.state();
    assert.deepEqual([s.treasury.epoch, s.mandate], ["1", null]);
    assert.deepEqual((await t.rail.mandates()).map((m) => [m.version, m.status]), [[2, "voided"], [1, "revoked"]]);
    const stale = await trade(v2);
    assert.ok(stale.name === "StaleEpoch" || /^cosigner: C2 /.test(stale.name), stale.name);
    assert.equal((await t.act("mandate", { maxPerPayment: "25" })).result?.outcome, "executed");
    assert.equal((await t.rail.state()).mandate!.fields.epoch, "1", "a new mandate carries the vault's new epoch");
    assert.equal((await t.act("convert", { amount: "10" })).result?.outcome, "executed");
  } finally { await t.stop(); }
});

test("key rotation: operator, guardian and co-signer; the old key stops working at once and the new one survives a restart", async () => {
  const t = await startRail("admin-rotate", 18653);
  let dir = t.dir, stopped = false;
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const before = await t.rail.state();
    const oldOperator = t.rail.K.OPERATOR, oldGuardian = t.rail.K.GUARDIAN;
    await assert.rejects(() => t.rail.propose({ kind: "rotate-key", params: { role: "owner" } }), (e: unknown) => e instanceof RailError && e.code === "invalid_params");

    const op = await t.rail.propose({ kind: "rotate-key", params: { role: "operator" } });
    assert.deepEqual([(op.terms as any).from, (op.terms as any).role], [before.roles.operator, "operator"]);
    const opJob = await t.rail.waitForJob(t.rail.execute(op.id, approve(op), key()).jobId);
    assert.equal(opJob.result?.outcome, "executed", opJob.error ?? "");
    let s = await t.rail.state();
    assert.equal(s.roles.operator, (op.terms as any).to);
    assert.notEqual(s.roles.operator, before.roles.operator);
    assert.equal(await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "operator"), s.roles.operator);
    assert.equal((await t.act("convert", { amount: "10" })).result?.outcome, "executed", "the new operator key trades");
    assert.equal((await t.act("attack", { kind: "stolen-order" })).result!.tx!.error, "NotOperator");
    assert.equal((await t.rail.c.simulateError(oldOperator.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "setOperator", [oldOperator.address]))).name, "NotVaultOwner");

    const gd = await t.act("rotate-key", { role: "guardian" });
    assert.equal(gd.result?.outcome, "executed", gd.error ?? "");
    s = await t.rail.state();
    assert.notEqual(s.roles.guardian, before.roles.guardian);
    assert.equal((await t.rail.c.simulateError(oldGuardian.address, A.vault, V.chain.fn(V.abi.QEDVaultAbi, "pause"))).name, "NotOwnerOrGuardian");
    assert.equal((await t.act("guardian-pause")).result?.outcome, "executed", "the new guardian key pauses");
    await t.act("resume");

    // a certificate signed by the old co-signer key is worthless after rotation
    const am = t.rail.activeMandate()!;
    const nonce = `rotate-${key()}`;
    const sig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 5_000_000n, A.usd, A.eur, A.reserve, nonce) });
    const old = await t.rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "test", nonce, instructionSig: sig, brainEngine: "test" });
    const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
    const data = V.chain.fn(V.abi.QEDExecutionAbi, "trade", [am.mandate, am.ownerSig, old.certificate, old.signature, old.order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]);
    assert.equal(await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data), undefined, "valid before the rotation");
    const cs = await t.act("rotate-key", { role: "cosigner" });
    assert.equal(cs.result?.outcome, "executed", cs.error ?? "");
    s = await t.rail.state();
    assert.notEqual(s.roles.cosigner, before.roles.cosigner);
    assert.equal(s.roles.cosigner, await t.rail.cosigner.address());
    assert.equal((await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data)).name, "BadCosignerSignature");
    assert.equal((await t.act("convert", { amount: "5" })).result?.outcome, "executed", "the new co-signer key signs");

    const roles = (await t.rail.state()).roles;
    await t.stop({ keep: true });
    stopped = true;
    const again = await startRail("admin-rotate", 18653, { dataDir: dir });
    try {
      const r2 = (await again.rail.state()).roles;
      assert.deepEqual([r2.operator, r2.guardian, r2.cosigner], [roles.operator, roles.guardian, roles.cosigner]);
      assert.equal((await again.act("convert", { amount: "5" })).result?.outcome, "executed", "rotated keys still work after a restart");
    } finally { await again.stop(); }
  } finally { if (!stopped) await t.stop(); }
});
