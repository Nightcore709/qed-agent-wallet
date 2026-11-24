/**
 * The rail's core on a real local Anvil chain with the release's unmodified contracts (no mocks):
 * deployment and readiness, provisioning, the approval binding, the mandate and its supersession, limits,
 * quotes, the eight-step conversion, the six Security Lab attacks, in-process idempotency, and parity with the
 * release's own Sandbox class and with the figures its production smoke test recorded.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { recoverTypedDataAddress, toHex } from "viem";
import { approve, key, startRail, freshDir, type TestRail } from "./helpers.ts";
import { ATTACK_KINDS, ATTACKS, RailError } from "../rail/service.ts";
import { devAccount } from "../rail/keys.ts";
import { hashTerms } from "../terms.ts";
import { NETWORK_LABEL } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

let t: TestRail;
before(async () => { t = await startRail("core", 18551); });
after(async () => { await t.stop(); });

const rejects = async (f: () => unknown, code: string) => {
  await assert.rejects(async () => f(), (e: unknown) => {
    assert.ok(e instanceof RailError, `expected a RailError, got ${String(e)}`);
    assert.equal((e as RailError).code, code);
    return true;
  });
};

test("deploys the release's contracts from embedded bytecode and is ready; nothing works before the owner provisions", async () => {
  const h = await t.rail.health();
  assert.equal(h.ready, true);
  assert.deepEqual({ ...h.readiness, checkedAt: "" }, { rail: "ready", anvil: true, contracts: true, store: true, cosigner: true, vendored: true, checkedAt: "" });
  assert.equal(h.provisioned, false);
  const s = await t.rail.state();
  assert.equal(s.network.chainId, 31337);
  assert.equal(s.network.valueless, true);
  assert.equal(s.treasury.balance, "100000000");
  assert.equal(s.treasury.dailyCap, "100000000");
  assert.equal(s.reserve.balance, "0");
  assert.equal(s.reserve.dailyCap, "0", "the agent can never spend from the reserve");
  assert.equal(s.venues.length, 0, "no venue is named until the owner names them at provisioning");
  assert.equal(s.mandate, null, "the rail signs no mandate on its own initiative");
  assert.equal(s.treasury.agent.toLowerCase(), s.roles.operator.toLowerCase(), "not wired yet: the vault's agent is still the constructor value");
  for (const a of [s.contracts.vault, s.contracts.reserve, s.contracts.execution, s.contracts.lens, s.contracts.tUSD, s.contracts.tEUR, s.contracts.tETH, s.contracts.treasuryPolicy!, ...s.contracts.pools]) {
    const code = await t.rail.pub.getCode({ address: a });
    assert.ok(code && code.length > 2, `contract deployed at ${a}`);
  }
  await rejects(() => t.rail.propose({ kind: "convert", params: { amount: "10" } }), "not_provisioned");
  await rejects(() => t.rail.quote("10"), "not_provisioned");
  await rejects(() => t.rail.propose({ kind: "rpc", params: {} } as never), "unsupported_proposal");
});

test("the approval must carry the hash of the exact terms; every refusal is recorded and nothing is signed", async () => {
  const p = await t.rail.propose({ kind: "provision" });
  assert.equal(p.termsHash, hashTerms(p.terms));
  assert.equal((p.terms.actions as unknown[]).length, 2);
  await rejects(() => t.rail.execute(p.id, undefined, key()), "approval_required");
  await rejects(() => t.rail.execute(p.id, approve(p, { termsHash: `sha256:${"0".repeat(64)}` }), key()), "approval_terms_mismatch");
  await rejects(() => t.rail.execute(p.id, { ...approve(p), owner: "me" }, key()), "approval_malformed");
  await rejects(() => t.rail.execute(p.id, approve(p, { confirmedAt: new Date(Date.now() + 3_600_000).toISOString() }), key()), "approval_from_future");
  await rejects(() => t.rail.execute(p.id, approve(p, { confirmedAt: new Date(Date.now() - 3_600_000).toISOString() }), key()), "approval_predates_terms");
  await rejects(() => t.rail.execute(p.id, approve(p), undefined), "idempotency_key_required");
  // an approval for other terms: a proposal whose terms differ by one field
  const other = await t.rail.propose({ kind: "provision" });
  assert.equal(t.rail.proposal(p.id).status, "cancelled", "a newer proposal of the same kind replaces the older one");
  const refused = t.rail.decisions(50).filter((d) => d.kind === "approval-refused");
  assert.ok(refused.length >= 4, "refused approvals are in the decision log");
  assert.equal((await t.rail.state()).provisioned, false, "nothing was sent");

  const a = approve(other);
  const accepted = t.rail.execute(other.id, a, key());
  const job = await t.rail.waitForJob(accepted.jobId);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.result?.outcome, "executed");
  const s = await t.rail.state();
  assert.equal(s.provisioned, true);
  assert.equal(s.treasury.agent, s.contracts.execution, "QEDExecution is now the vault's agent");
  assert.equal(s.venues.length, 5, "the five owner-approved venues are named");
  // the same approval cannot authorise anything else, and a used proposal cannot run twice
  await rejects(() => t.rail.execute(other.id, approve(other), key()), "proposal_used");
  const m = await t.rail.propose({ kind: "mandate", params: { maxPerPayment: "25" } });
  await rejects(() => t.rail.execute(m.id, { ...a, termsHash: m.termsHash }, key()), "approval_replayed");
  const sent = t.rail.decisions(50).filter((d) => d.kind === "owner-provision");
  assert.equal(sent.length, 2, "two owner transactions, each with its approval and clock reading");
  for (const d of sent) { assert.equal(d.approval?.approvalId, a.approvalId); assert.equal(d.termsHash, other.termsHash); assert.ok(d.clock && typeof d.clock.chainSeconds === "number" && typeof d.clock.wallSeconds === "number"); }
});

test("mandate: thirteen fields readable, EIP-712 parity with the contract, usage per limit", async () => {
  const p = await t.rail.propose({ kind: "mandate", params: { maxPerPayment: "25" } });
  const fields = p.terms.mandate as Record<string, unknown>;
  assert.deepEqual(Object.keys(fields).sort(), ["agent", "epoch", "maxPerPayment", "maxPerPeriod", "maxTotal", "payees", "period", "purpose", "requireCosign", "salt", "validFrom", "validUntil", "vault"].sort());
  assert.equal(p.terms.supersedes, null);
  const job = await t.rail.waitForJob(t.rail.execute(p.id, approve(p), key()).jobId);
  assert.equal(job.result?.outcome, "executed", job.error ?? "");
  assert.equal(job.result?.tx, undefined, "the first mandate is signed off-chain: no transaction");
  const s = await t.rail.state();
  const m = s.mandate!;
  assert.equal(m.version, 1);
  assert.equal(m.status, "active");
  assert.equal(m.fields.maxPerPayment, "25000000");
  assert.equal(m.fields.maxPerPeriod, "100000000");
  assert.equal(m.fields.maxTotal, "200000000");
  assert.equal(m.fields.period, "86400");
  assert.equal(m.fields.requireCosign, true);
  assert.deepEqual(m.fields.payees.map((x) => x.toLowerCase()), [s.contracts.execution, s.contracts.reserve, s.roles.creditor].map((x) => x.toLowerCase()));
  assert.equal(Number(m.fields.validUntil) - Number(m.fields.validFrom), 7 * 86_400 + 60);
  assert.deepEqual([m.usage.period.spent, m.usage.lifetime.spent, m.usage.lifetime.remaining, m.usage.vaultDaily.remaining], ["0", "0", "200000000", "100000000"]);
  assert.equal(m.usage.revokedOnChain, false);
  // TypeScript and Solidity agree on the digest, and the stored signature is the owner's
  const am = t.rail.activeMandate()!;
  const onchainHash = await t.rail.read(s.contracts.lens, t.rail.v.abi.QEDLensAbi, "hashMandate", [am.mandate]);
  assert.equal(onchainHash, m.hash);
  const signer = await recoverTypedDataAddress({ domain: t.rail.v.eip712.vaultDomain(31337, s.contracts.vault), types: t.rail.v.eip712.MandateTypes, primaryType: "Mandate", message: am.mandate as never, signature: am.ownerSig });
  assert.equal(signer, s.roles.owner);
  await rejects(() => t.rail.propose({ kind: "mandate", params: { maxPerPayment: "0.5" } }), "invalid_params");
  await rejects(() => t.rail.propose({ kind: "mandate", params: { maxPerPayment: "101" } }), "invalid_params");
  await rejects(() => t.rail.propose({ kind: "mandate", params: { maxPerPayment: 25 } }), "invalid_amount");
});

test("limit check and maximum: one function, every rule with usage; a question never executes", async () => {
  const before = (await t.rail.state()).treasury.balance;
  const over = await t.rail.limits("80");
  assert.equal(over.allowed, false);
  assert.equal(over.execution, "none");
  assert.deepEqual(over.checks.filter((c) => !c.pass).map((c) => c.id), ["per-conversion"]);
  assert.deepEqual(over.checks.map((c) => c.id), ["amount", "mandate-valid", "per-conversion", "mandate-period", "mandate-lifetime", "vault-daily", "free-buffer", "not-paused"]);
  assert.equal((await t.rail.limits("25")).allowed, true);
  assert.equal((await t.rail.limits("25.000001")).allowed, false);
  assert.equal((await t.rail.maximum()).maximum, "25000000");
  for (const bad of [".5", "1e2", "-10", "1,00", "0x10", "1.2345678", "10 20", ""]) await rejects(() => t.rail.limits(bad), "invalid_amount");
  assert.equal((await t.rail.state()).treasury.balance, before);
  assert.equal(t.rail.jobs(50).filter((j) => j.kind === "convert").length, 0, "no job was created by reading");
});

test("read-only quote carries its source and freshness, and equals the contract's own bound", async () => {
  const q = await t.rail.quote("12.5");
  assert.equal(q.allowed, true);
  assert.equal(q.execution, "none");
  assert.equal(q.amountIn, "12500000");
  assert.ok(BigInt(q.expectedOut!) <= BigInt(q.bound!));
  assert.ok(q.gapPpm! <= 1);
  assert.equal(q.plan!.alternatives.length, 4);
  assert.deepEqual(q.plan!.alternatives.map((a) => a.policy), ["certified", "direct-optimal", "equal-split", "single-venue"]);
  assert.ok(q.source.provider.length > 0 && q.source.block.length > 0 && q.source.priceType.includes("indicative"));
  assert.equal((await t.rail.quote("80")).allowed, false);
});

test("conversion: the eight visible steps, a mined receipt, reconciliation, and the figures the production smoke test recorded", async () => {
  const before = await t.rail.state();
  const p = await t.rail.propose({ kind: "convert", params: { amount: "10" } });
  assert.equal(p.allowed, true);
  assert.match(p.terms.message as string, /^QED owner instruction\nvault: 0x[0-9a-fA-F]{40}\nconvert: 10000000 of 0x/);
  const k = key(), a = approve(p);
  const first = t.rail.execute(p.id, a, k);
  const dup = t.rail.execute(p.id, a, k);
  assert.equal(first.duplicate, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.jobId, first.jobId);
  await rejects(() => t.rail.execute(p.id, approve(p), k), "idempotency_conflict");
  const job = await t.rail.waitForJob(first.jobId);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.result!.outcome, "executed");
  // the release's eight steps, in order, and the rail's executable quote after the co-signer (R7-038, rail/quote-kinds.ts)
  assert.deepEqual(job.steps.map((s) => s.key), ["interpret", "mandate", "owner", "cosigner", "executable", "plan", "submit", "receipt", "reconcile"]);
  assert.ok(job.steps.every((s) => s.status === "ok"));
  assert.equal(job.steps[6].label, "Transaction broadcast");
  assert.deepEqual([(job.steps[0].data as { engine: string }).engine, p.network, job.network], ["offline-deterministic", NETWORK_LABEL, NETWORK_LABEL], "the language step is labelled as the offline parser; the proposal and the job carry the network label");
  assert.match(job.result!.tx!.hash, /^0x[0-9a-f]{64}$/);
  // ~/qed-approved-release/review/release-verification/production-smoke.txt:20-31 recorded these exact figures
  const s = await t.rail.state();
  assert.equal(s.lastTrade!.amountIn, "10000000");
  assert.deepEqual([s.lastTrade!.engine, s.network.name], ["offline-deterministic", NETWORK_LABEL]);
  assert.equal(s.lastTrade!.amountOut, "9107516");
  assert.equal(s.lastTrade!.bound, "9107519");
  assert.ok(s.lastTrade!.gapPpm <= s.lastTrade!.tolerancePpm, "within the order's own tolerance");
  assert.equal(BigInt(before.treasury.balance) - BigInt(s.treasury.balance), 10_000_000n);
  assert.equal(s.reserve.balance, "9107516");
  assert.equal(s.mandate!.usage.period.spent, "10000000");
  assert.equal(s.mandate!.usage.lifetime.remaining, "190000000");
  assert.equal(s.treasury.worstCaseLoss24h, "90000000", "worst case = free balance, below one more daily cap");
  assert.equal((await t.rail.maximum()).maximum, "25000000");
  assert.equal(t.rail.jobs(50).filter((j) => j.kind === "convert").length, 1, "one execution for two identical submissions");
  const r = await t.rail.receipt(job.result!.tx!.hash);
  assert.deepEqual([r.stored!.status, r.network], ["success", NETWORK_LABEL]);
  assert.ok((r.stored!.events as { name: string }[]).some((e) => e.name === "BestExecution"));
  const d = t.rail.decisions(50, job.id);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "cosigner-trade");
  assert.equal(d[0].verdict, "APPROVED");
  assert.equal(d[0].approval?.approvalId, a.approvalId);
  assert.ok(d[0].clock!.withinLimit);
  assert.equal((d[0].record as { checks: unknown[] }).checks.length, 11, "the co-signer's eleven conversion checks");

  const second = await t.act("convert", { amount: "22.5" });
  assert.equal(second.result!.outcome, "executed", second.error ?? "");
  const s2 = await t.rail.state();
  assert.equal(s2.lastTrade!.amountOut, "20034819");
  assert.equal(s2.lastTrade!.bound, "20034823");
  assert.equal(t.rail.history(1)[0].kind, "conversion");
  assert.equal(t.rail.history(1)[0].trade!.amountOut, s2.lastTrade!.amountOut);
});

test("over the signed limit: refused before any signature, no transaction, the refusal is in the history", async () => {
  const p = await t.rail.propose({ kind: "convert", params: { amount: "80" } });
  assert.equal(p.allowed, false);
  const job = await t.rail.waitForJob(t.rail.execute(p.id, approve(p), key()).jobId);
  assert.equal(job.status, "done");
  assert.equal(job.result!.outcome, "refused");
  assert.equal(job.result!.tx, undefined);
  assert.deepEqual(job.steps.map((s) => `${s.key}:${s.status}`), ["interpret:ok", "mandate:refused"]);
  assert.equal(t.rail.store.attempts(job.id).length, 0, "nothing was prepared for sending");
  assert.equal(t.rail.history(1)[0].outcome, "refused");
});

test("mandate supersession: signing v2 revokes v1 on-chain, and the vault then rejects v1", async () => {
  const v1 = t.rail.activeMandate()!;
  const stale = await t.rail.propose({ kind: "convert", params: { amount: "5" } });
  const p = await t.rail.propose({ kind: "mandate", params: { maxPerPayment: "12" } });
  assert.deepEqual(p.terms.supersedes, { version: 1, hash: v1.hash });
  assert.equal((p.terms.actions as { function: string }[])[0].function, "revokeMandate");
  const job = await t.rail.waitForJob(t.rail.execute(p.id, approve(p), key()).jobId);
  assert.equal(job.result?.outcome, "executed", job.error ?? "");
  assert.match(job.result!.tx!.hash, /^0x[0-9a-f]{64}$/);
  const s = await t.rail.state();
  assert.equal(s.mandate!.version, 2);
  assert.equal(s.mandate!.fields.maxPerPayment, "12000000");
  assert.equal(s.mandate!.usage.lifetime.spent, "0", "a new mandate starts its own counters");
  const all = await t.rail.mandates();
  assert.deepEqual(all.map((m) => [m.version, m.status, m.usage.revokedOnChain]), [[2, "active", false], [1, "superseded", true]]);
  // a genuine, owner-confirmed and co-signed order under the OLD mandate is refused by the contract itself
  const A = t.rail.a, V = t.rail.v;
  const nonce = `supersession-${key()}`;
  const instructionSig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 5_000_000n, A.usd, A.eur, A.reserve, nonce) });
  const r = await t.rail.cosigner.evaluateTrade({ mandate: v1.mandate, ownerSig: v1.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "old mandate", nonce, instructionSig, brainEngine: "test" });
  assert.equal(r.approved, true, "the release's co-signer does not look at revocation (baseline W-02)");
  const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
  const data = V.chain.fn(V.abi.QEDExecutionAbi, "trade", [v1.mandate, v1.ownerSig, r.certificate, r.signature, r.order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]);
  const err = await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data);
  assert.equal(err.name, "MandateIsRevoked");
  // a conversion prepared under v1 cannot be executed after v2 exists
  const late = await t.rail.waitForJob(t.rail.execute(stale.id, approve(stale), key()).jobId);
  assert.equal(late.result!.outcome, "refused");
  assert.equal((await t.rail.limits("12.000001")).allowed, false);
  assert.equal((await t.act("convert", { amount: "12" })).result!.outcome, "executed");
});

test("Security Lab: each of the six attacks is mined as a revert with its error, and no balance changes", async () => {
  assert.deepEqual(t.rail.attacks().map((a) => a.kind), ATTACK_KINDS);
  for (const kind of ATTACK_KINDS) {
    const before = await t.rail.state();
    const job = await t.act("attack", { kind });
    assert.equal(job.status, "done", `${kind}: ${job.error ?? ""}`);
    assert.equal(job.result!.outcome, "reverted", kind);
    assert.equal(job.result!.tx!.status, "reverted");
    assert.equal(job.result!.tx!.error, ATTACKS[kind].expect, kind);
    const ev = job.result!.evidence as { balancesUnchanged: boolean; certificateConsumed: boolean; matchesExpectation: boolean };
    assert.deepEqual([ev.balancesUnchanged, ev.certificateConsumed, ev.matchesExpectation], [true, false, true], kind);
    // R7 D4: the run happens on an ephemeral chain of its own, started and destroyed around the release's three steps
    assert.deepEqual(job.steps.map((s) => s.key), ["chain", "cosigner", "attack", "receipt", "teardown"]);
    const after = await t.rail.state();
    assert.deepEqual([after.treasury.balance, after.reserve.balance, after.treasury.spentInWindow], [before.treasury.balance, before.reserve.balance, before.treasury.spentInWindow], kind);
    const rc = await t.rail.receipt(job.result!.tx!.hash);
    assert.equal(rc.stored!.status, "reverted");
    assert.equal(rc.stored!.error, ATTACKS[kind].expect);
  }
  await rejects(() => t.rail.propose({ kind: "attack", params: { kind: "drain-everything" } }), "unknown_attack");
  assert.equal(t.rail.history(6).every((h) => h.kind === "attack" && h.outcome === "reverted"), true);
});

test("decision records are hash-chained and append-only", async () => {
  const v = t.rail.verifyDecisions();
  assert.equal(v.ok, true);
  assert.ok(v.records >= 10);
  assert.throws(() => t.rail.store.db.exec("UPDATE decisions SET verdict = 'APPROVED' WHERE n = 1"), /append-only/);
  assert.throws(() => t.rail.store.db.exec("DELETE FROM receipts"), /append-only/);
  assert.throws(() => t.rail.store.db.exec("DELETE FROM history WHERE n = 1"), /append-only/);
});

test("parity with the release's own Sandbox class: same addresses, same quote, same conversions, same attack errors", { timeout: 180_000 }, async () => {
  // A variable specifier keeps the release's sandbox.ts (and its optional prover import) out of this package's type check.
  const releaseSandbox = "../vendor/agent/src/sandbox.ts";
  const { Sandbox, ATTACK_KINDS: RELEASE_KINDS } = await import(releaseSandbox);
  assert.deepEqual(ATTACK_KINDS, RELEASE_KINDS, "the six attack kinds are the release's");
  const fresh = await startRail("parity-rail", 18552);
  const sb = new Sandbox(18553, join(freshDir("parity-sandbox"), "records"));
  try {
    await sb.start();
    await fresh.ready();
    const rs: any = await sb.state(), mine = await fresh.rail.state();
    assert.deepEqual([mine.contracts.vault, mine.contracts.reserve, mine.contracts.execution, mine.contracts.lens, mine.contracts.tUSD, mine.contracts.tEUR, mine.contracts.tETH], [rs.contracts.vault, rs.contracts.reserve, rs.contracts.execution, rs.contracts.lens, rs.contracts.tUSD, rs.contracts.tEUR, rs.contracts.tETH], "identical contract addresses");
    assert.deepEqual(mine.venues.map((v) => [v.pool, v.feeBps, v.r0, v.r1]), rs.venues.map((v: any) => [v.pool, v.feeBps, v.r0, v.r1]));
    const rq: any = await sb.quote(12_500_000n), mq = await fresh.rail.quote("12.5");
    assert.deepEqual([mq.expectedOut, mq.bound, mq.plan!.hops, mq.plan!.prices], [rq.expectedOut, rq.bound, rq.plan.hops, rq.plan.prices]);
    for (const amount of ["10", "22.5", "0.000001", "7.123456"]) {
      const r = await sb.convert(`Convert ${amount} tUSD to tEUR`);
      const j = await fresh.act("convert", { amount });
      assert.equal(j.result!.outcome, r.outcome, `${amount}: ${j.result!.summary} / ${r.summary}`);
      if (r.outcome !== "executed") continue;
      const a: any = (await sb.state()).lastTrade, b = (await fresh.rail.state()).lastTrade!;
      assert.deepEqual([b.amountIn, b.amountOut, b.bound, b.floor, b.tolerancePpm, b.cosignerChecks, b.plan.hops], [a.amountIn, a.amountOut, a.bound, a.floor, a.tolerancePpm, a.cosignerChecks, a.plan.hops], `conversion of ${amount}`);
    }
    for (const kind of ATTACK_KINDS) {
      const r = await sb.attack(kind), j = await fresh.act("attack", { kind });
      assert.equal(j.result!.tx!.error, r.tx!.error, kind);
    }
    const ra: any = await sb.state(), mb = await fresh.rail.state();
    assert.deepEqual([mb.treasury.balance, mb.reserve.balance, mb.treasury.spentInWindow, mb.treasury.worstCaseLoss24h], [ra.treasury.balance, ra.reserve.balance, ra.treasury.spentInWindow, ra.treasury.blastRadius24h]);
  } finally {
    sb.stop();
    await fresh.stop();
  }
});

test("the terms a proposal shows are exactly what is signed: tampering with stored terms is caught at signing time", async () => {
  const p = await t.rail.propose({ kind: "convert", params: { amount: "3" } });
  const a = approve(p);
  // Simulate a corrupted or swapped proposal row between approval and signing: the signer recomputes the hash.
  const tampered = { ...p.terms, amountIn: "11000000", message: String(p.terms.message).replace("convert: 3000000", "convert: 11000000") };
  await assert.rejects(() => t.rail.owner.signMessage(tampered as never, a, { notBeforeMs: Date.parse(p.createdAt), notAfterMs: Date.parse(p.expiresAt), nowMs: Date.now() }), /different terms/);
  const ok = await t.rail.owner.signMessage(p.terms as never, a, { notBeforeMs: Date.parse(p.createdAt), notAfterMs: Date.parse(p.expiresAt), nowMs: Date.now() });
  assert.match(ok.signature, /^0x[0-9a-f]{130}$/);
  void toHex;
});
