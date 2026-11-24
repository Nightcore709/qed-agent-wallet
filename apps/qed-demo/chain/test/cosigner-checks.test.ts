/**
 * One failing case per co-signer check (baseline F-018; also F-031, F-033, F-034, F-044): each case fails exactly the
 * named check of the release's unmodified PolicyEngine, yields no certificate, and leaves a refusal record on disk
 * whose hash is the evidence hash that was returned.
 *
 * Conversions and owner-instructed payments go through the rail's own co-signer. Purchases against a vendor invoice
 * (C3 to C8 in their purchase form) are not certified on the rail, which has no vendor registry, price list or escrow
 * for the main treasury; those cases construct the same unmodified engine with one of each on the test chain.
 *
 * In the release's engine four checks cannot fail alone: T1 only with T2 (a route that does not execute quotes nothing,
 * so the rate is zero), P1 only with P2 (P2's condition contains P1's), P3 only with P2 (the co-signer's own tranche is
 * already cut to the cost limit), and T3 never on a chain (it checks only that the hash is 32 bytes; a malformed value
 * makes the release's engine throw before any record exists, shown below). The baseline rail keeps the release's engine
 * (baseline parity), so its cases show that. The engine of every workspace (rail/cosigner-engine.ts) redefines those
 * three checks (decision D-K4a, finding F-018; scripts/fork-cosigner.mjs change 5); on the same chain, each fails alone:
 *   T1 alone: T2 is computed only when T1 passes;
 *   P1 alone: P2 is "if a tranche is due, the request is no larger than the tranche the policy allows and no smaller
 *      than its smallest", which holds when none is due;
 *   P3 alone: P2 leaves the cost limit to P3 (a policy whose limit binds below the shortfall's tranche);
 *   T3 alone: the owner changes the venue set between the co-signer's read of the venues and its read of the hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type LocalAccount } from "viem";
import { key, startRail, type TestRail } from "./helpers.ts";
import { devAccount } from "../rail/keys.ts";
import { createForkedPolicyEngine, policyTranche } from "../rail/cosigner-engine.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const failed = (r: { checks: { id: string; pass: boolean }[] }) => r.checks.filter((c) => !c.pass).map((c) => c.id);
/** Exactly these checks failed, nothing was signed, and the stored record hashes to the evidence hash. */
function refusedBy(t: TestRail, r: any, ids: string[], label: string) {
  assert.deepEqual([r.approved, failed(r), r.certificate, r.signature], [false, ids, undefined, undefined], label);
  assert.deepEqual(r.reasons.map((x: string) => x.split(" ")[0]), ids, label);
  const file = JSON.parse(readFileSync(r.recordPath, "utf8")) as { core: { verdict: string; checks: { id: string; pass: boolean }[] }; canonical: string; evidenceHash: string; certificate: unknown; signature: unknown };
  assert.deepEqual([file.core.verdict, failed(file.core), file.certificate, file.signature], ["REFUSED", ids, null, null], label);
  assert.deepEqual([keccak256(toHex(file.canonical)), file.evidenceHash, t.rail.v.records.hashRecord(file.core)], [r.evidenceHash, r.evidenceHash, r.evidenceHash], `${label}: the record's hash`);
}
const approvedWith = (r: any, n: number, label: string) => { assert.deepEqual([r.approved, r.checks.length, failed(r)], [true, n, []], `${label}: ${r.reasons?.join(" | ")}`); assert.ok(r.certificate && r.signature); };

test("owner-instructed payments: C1, C2, C3, C6, C9, C10, C11 and C12 each fail alone; purchases against an invoice: C3 to C8 each fail alone", { timeout: 180_000 }, async () => {
  const t = await startRail("checks-pay", 18731);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a, K = t.rail.K, owner = devAccount("OWNER"), cloudco = K.CLOUDCO.address;
    const am = t.rail.activeMandate()!;
    let n = 0;
    const mandate = async (over: Record<string, unknown>, signer: LocalAccount = owner) => { const m = { ...am.mandate, ...over, salt: keccak256(toHex(`cosigner-checks-${++n}`)) }; return { mandate: m, ownerSig: await V.eip712.signMandate(signer, 31337, m as never) }; };
    const pay = async (over: Record<string, unknown> = {}, signer: LocalAccount = owner) => {
      const req: any = { kind: "owner-instructed", mandate: am.mandate, ownerSig: am.ownerSig, payee: cloudco, amount: 1_000_000n, instruction: "check", nonce: `checks-${key()}`, ...over };
      req.instructionSig = await signer.signMessage({ message: V.cosigner.ownerInstructionMessage(A.vault, req.payee, req.amount, req.dueInDays, req.nonce) });
      return t.rail.cosigner.evaluatePayment(req);
    };
    const now = await t.rail.chainNow();

    const good = await pay({ nonce: "checks-payment-once" });
    approvedWith(good, 8, "a payment of 1 tUSD to CloudCo");
    assert.deepEqual(good.checks.map((c: { id: string }) => c.id), ["C1", "C2", "C3", "C6", "C9", "C10", "C11", "C12"]);
    refusedBy(t, await pay({ ownerSig: await V.eip712.signMandate(K.MALLORY, 31337, am.mandate as never) }), ["C1"], "C1: the mandate is signed by someone who is not the vault's owner");
    refusedBy(t, await pay(await mandate({ validFrom: now - 7200n, validUntil: now - 3600n })), ["C2"], "C2: the mandate's validity window has closed");
    refusedBy(t, await pay(await mandate({ epoch: am.mandate.epoch + 1n })), ["C2"], "C2: the mandate carries another epoch than the vault's");
    refusedBy(t, await pay({}, K.MALLORY), ["C3"], "C3: the instruction is not signed by the owner");
    refusedBy(t, await pay({ nonce: "checks-payment-once" }), ["C6"], "C6: the nonce was already certified");
    refusedBy(t, await pay({ payee: K.LP1.address }), ["C9"], "C9: the payee is not in the mandate");
    refusedBy(t, await pay({ ...(await mandate({ payees: [...am.mandate.payees, K.MALLORY.address] })), payee: K.MALLORY.address }), ["C11"], "C11: the payee is in the mandate and on the deny-list (F-033)");
    refusedBy(t, await pay({ amount: 10_000_001n }), ["C12"], "C12: one unit above the earned allowance of 10 tUSD (F-034)");
    approvedWith(await pay({ amount: 10_000_000n }), 8, "exactly the allowance");

    // ── purchases: the same engine, unmodified, with a vendor registry, a price list and a funded escrow job ──
    const spec = keccak256(toHex("cosigner-checks: the job's committed problem specification"));
    const escrow = (await t.rail.c.deploy(K.DEPLOYER, V.abi.ProofEscrowAbi as never, V.abi.ProofEscrowBytecode as never)).address;
    const quote = { provider: K.OPERATOR.address, payee: A.vault, client: K.LP1.address, token: A.usd, price: 10_000_000n, verifier: A.lens, specHash: spec, deliverBy: now + 7200n, validUntil: now + 3600n, quoteId: keccak256(toHex("cosigner-checks-quote")) };
    await t.rail.c.send(K.LP1, A.usd, V.chain.fn(V.abi.TestUSDAbi, "approve", [escrow, quote.price]));
    const opened = await t.rail.c.send(K.LP1, escrow, V.chain.fn(V.abi.ProofEscrowAbi, "open", [quote, await V.eip712.signQuote(K.OPERATOR, 31337, escrow, quote as never)]));
    const jobId = String((opened.events.find((e: { name: string }) => e.name === "JobOpened")!.args as { jobId: bigint }).jobId);
    const engine = new V.cosigner.PolicyEngine(t.rail.c, devAccount("COSIGNER"), { vault: A.vault, lens: A.lens, escrow, owner: owner.address, vendorKeys: { [cloudco.toLowerCase()]: cloudco }, catalogPrices: { "dataset-a": 6_000_000n, "dataset-b": 9_000_000n }, denylist: [K.MALLORY.address], deployBlock: BigInt(A.deployBlock), recordsDir: join(t.dir, "rail", "records") });
    let inv = 0;
    const buy = async (over: Record<string, unknown> = {}, signer: LocalAccount = K.CLOUDCO) => {
      const invoice: any = { invoiceId: `inv-${++inv}`, productId: "dataset-a", title: "Market data for the job", vendor: cloudco, payTo: cloudco, buyer: A.vault, amount: "6000000", dataCommitment: spec, jobId, issuedAt: Number(now), expiresAt: Number(now) + 3600, ...over };
      const vendorSig = await signer.signMessage({ message: { raw: V.records.invoiceDigest(invoice) } });
      return engine.evaluate({ kind: "purchase", mandate: am.mandate, ownerSig: am.ownerSig, invoice, vendorSig, jobId, rationale: "check", brainEngine: "test" });
    };
    const bought = await buy({ invoiceId: "inv-once" });
    approvedWith(bought, 12, "a 6 tUSD purchase for a 10 tUSD job");
    assert.deepEqual(bought.checks.map((c) => c.id), ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12"]);
    refusedBy(t, await buy({}, K.MALLORY), ["C3"], "C3: the invoice is not signed by the payee's registered key");
    refusedBy(t, await buy({ buyer: K.LP1.address }), ["C4"], "C4: the invoice is addressed to someone else");
    refusedBy(t, await buy({ expiresAt: Number(now) - 3600 }), ["C4"], "C4: the invoice has expired");
    refusedBy(t, await buy({ amount: "6000001" }), ["C5"], "C5: one unit above the published list price");
    refusedBy(t, await buy({ invoiceId: "inv-once" }), ["C6"], "C6: the invoice was already certified");
    refusedBy(t, await buy({ productId: "dataset-b", amount: "7000001" }), ["C7"], "C7: the job's price less the 30% margin does not cover the cost (7 tUSD)");
    refusedBy(t, await buy({ dataCommitment: keccak256(toHex("other data")) }), ["C8"], "C8: the data is not what the job's committed specification requires");

    // C10 last, because it needs most of the treasury ring-fenced: 12 tUSD free, a payment of 8 leaves less than the 5 tUSD buffer
    assert.equal((await t.act("ring-fence", { creditor: "CloudCo", amount: "88", dueInDays: 30 })).result?.outcome, "executed");
    refusedBy(t, await pay({ amount: 8_000_000n }), ["C10"], "C10: the reserve buffer above ring-fenced liabilities would not be preserved");
    approvedWith(await pay({ amount: 7_000_000n }), 8, "7 tUSD leaves exactly the buffer");
    assert.equal((await t.rail.state()).treasury.balance, "100000000", "no certificate was used: nothing moved");
  } finally { await t.stop(); }
});

test("conversions: C1, C2, C3, C6, C9, C9b, C10, C11, T2 and P2 each fail alone; T1 with T2, P1 with P2, P3 with P2 in the release's engine, and each alone in the rail's (D-K4a), with T3; a refusal inside a job is stored with its hash", { timeout: 240_000 }, async () => {
  const t = await startRail("checks-trade", 18732);
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a, K = t.rail.K, owner = devAccount("OWNER");
    const am = t.rail.activeMandate()!;
    let n = 0;
    const mandate = async (over: Record<string, unknown>) => { const m = { ...am.mandate, ...over, salt: keccak256(toHex(`cosigner-checks-${++n}`)) }; return { mandate: m, ownerSig: await V.eip712.signMandate(owner, 31337, m as never) }; };
    const trade = async (over: Record<string, unknown> = {}, signer: LocalAccount = owner) => {
      const req: any = { mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "check", nonce: `checks-${key()}`, brainEngine: "test", ...over };
      if (!req.policy) req.instructionSig = await signer.signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, req.amountIn, req.tokenIn, req.tokenOut, req.recipient, req.nonce) });
      return t.rail.cosigner.evaluateTrade(req);
    };
    const now = await t.rail.chainNow();

    const good = await trade({ nonce: "checks-trade-once" });
    approvedWith(good, 11, "a conversion of 5 tUSD");
    assert.deepEqual(good.checks.map((c: { id: string }) => c.id), ["C1", "C2", "C3", "C6", "C9", "C9b", "C10", "C11", "T1", "T2", "T3"]);
    refusedBy(t, await trade({ ownerSig: await V.eip712.signMandate(K.MALLORY, 31337, am.mandate as never) }), ["C1"], "C1");
    refusedBy(t, await trade(await mandate({ validFrom: now - 7200n, validUntil: now - 3600n })), ["C2"], "C2");
    refusedBy(t, await trade({}, K.MALLORY), ["C3"], "C3: the conversion is not confirmed by the owner");
    refusedBy(t, await trade({ nonce: "checks-trade-once" }), ["C6"], "C6");
    refusedBy(t, await trade({ recipient: K.LP1.address }), ["C9"], "C9: the recipient is not in the mandate");
    refusedBy(t, await trade(await mandate({ payees: [A.reserve, K.CLOUDCO.address] })), ["C9b"], "C9b: the execution module is not a payee of the mandate");
    refusedBy(t, await trade({ ...(await mandate({ payees: [...am.mandate.payees, K.MALLORY.address] })), recipient: K.MALLORY.address }), ["C11"], "C11: the recipient is on the deny-list");
    // T2: a size the venues cannot absorb near their mid price; T1 and T2: 1 tUSD, for which the release's solver returns a route that does not execute
    const big = await trade({ amountIn: 90_000_000n });
    refusedBy(t, big, ["T2"], `T2: ${big.reasons.join(" | ")}`);
    refusedBy(t, await trade({ amountIn: 1_000_000n }), ["T1", "T2"], "the release: T1 cannot fail without T2");
    // the rail's own engine (every workspace's; D-K4a), on the same chain: T1 alone, T2 not computed
    const forkCfg = (dir: string) => ({ vault: A.vault, lens: A.lens, escrow: A.vault, owner: owner.address, vendorKeys: {}, catalogPrices: {}, denylist: [K.MALLORY.address], deployBlock: BigInt(A.deployBlock), recordsDir: join(t.dir, "rail", dir) }) as never;
    const forkEngine = new (createForkedPolicyEngine(V))(t.rail.c, devAccount("COSIGNER"), forkCfg("records-fork"));
    const forkTrade = async (over: Record<string, unknown> = {}) => {
      const req: any = { mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "check", nonce: `checks-fork-${key()}`, brainEngine: "test", ...over };
      if (!req.policy) req.instructionSig = await owner.signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, req.amountIn, req.tokenIn, req.tokenOut, req.recipient, req.nonce) });
      return forkEngine.evaluateTrade(req);
    };
    const t1 = await forkTrade({ amountIn: 1_000_000n });
    refusedBy(t, t1, ["T1"], "the rail's engine: T1 alone, the co-signer's own route does not execute");
    assert.ok(!t1.checks.some((c: { id: string }) => c.id === "T2"), "T2 is not computed without a route that executes");
    // T3 alone (D-K4a): between the co-signer's read of the venues and its read of the hash, the owner drops a venue
    const fn = V.chain.fn, venuesNow = (await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "venues")) as readonly { pool: `0x${string}`; feeBps: number }[];
    const setVenues = (vs: readonly { pool: `0x${string}`; feeBps: number }[]) => t.rail.c.send(owner, A.exec, fn(V.abi.QEDExecutionAbi, "setVenues", [vs.map((x) => x.pool), vs.map((x) => x.feeBps)]));
    let raced = false;
    const racing = new Proxy(t.rail.pub, { get: (target, prop) => (prop === "readContract" ? async (args: { functionName: string }) => { const out = await target.readContract(args); if (args.functionName === "venues" && !raced) { raced = true; await setVenues(venuesNow.slice(0, -1)); } return out; } : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
    const forked = new (createForkedPolicyEngine(V))({ pub: racing, chainId: 31337 } as never, devAccount("COSIGNER"), forkCfg("records-t3-fork"));
    const t3req: any = { mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "check", nonce: `checks-${key()}`, brainEngine: "test" };
    t3req.instructionSig = await owner.signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, t3req.amountIn, t3req.tokenIn, t3req.tokenOut, t3req.recipient, t3req.nonce) });
    const t3 = await forked.evaluateTrade(t3req);
    assert.equal(raced, true);
    refusedBy(t, t3, ["T3"], `T3 alone: the venues read are not the set the order would commit to: ${t3.reasons.join(" | ")}`);
    await setVenues(venuesNow);
    // the release's T3: a malformed venue-set hash cannot come from the chain; given one, its engine throws before any record or certificate
    const records = join(t.dir, "rail", "records-t3");
    const reader = new Proxy(t.rail.pub, { get: (target, prop) => (prop === "readContract" ? (args: { functionName: string }) => (args.functionName === "venueSetHash" ? "0x1234" : target.readContract(args)) : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
    const engine = new V.cosigner.PolicyEngine({ pub: reader, chainId: 31337 } as never, devAccount("COSIGNER"), { vault: A.vault, lens: A.lens, escrow: A.vault, owner: owner.address, vendorKeys: {}, catalogPrices: {}, denylist: [], deployBlock: BigInt(A.deployBlock), recordsDir: records });
    const nonce = `checks-${key()}`;
    await assert.rejects(() => engine.evaluateTrade({ mandate: am.mandate as never, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "check", nonce, brainEngine: "test" }), "a malformed venue-set hash yields no verdict at all");

    // a refusal inside a job is stored in the rail's decision log with the same hash, under the owner's approval
    const job = await t.act("convert", { amount: "1" });
    assert.deepEqual([job.status, job.result!.outcome, job.result!.tx, t.rail.store.attempts(job.id).length], ["done", "refused", undefined, 0]);
    const d = t.rail.decisions(5, job.id);
    assert.deepEqual(d.map((x) => [x.kind, x.verdict, failed(x.record as never), V.records.hashRecord(x.record) === x.evidenceHash, typeof x.approval?.approvalId]), [["cosigner-trade", "REFUSED", ["T1", "T2"], true, "string"]]);

    // ── under a standing policy (14 checks): C3 in its policy form, P2 alone, P3 alone, P1 alone ──
    assert.equal((await t.act("policy", { targetFree: "12" })).result?.outcome, "executed");
    const pol = t.rail.policy.active()!;
    const own = async () => { const view = await V.treasury.observeTreasury(t.rail.pub, pol.policy, A.exec, V.economics.POLICY.reserveBuffer); return V.treasury.decideTranche(view.venues, pol.policy, view.reserveFree, view.available, am.mandate.maxPerPayment); };
    const tick = (over: Record<string, unknown> = {}) => trade({ policy: pol.policy, policySig: pol.sig, nonce: `${pol.policy.nonce}:check-${key()}`, ...over });
    const d0 = await own();
    assert.deepEqual([d0.action, d0.limitedBy], ["convert", "need"], "about 13 tUSD covers the 12 tEUR shortfall");
    const fits = await tick({ amountIn: d0.amountIn });
    approvedWith(fits, 14, "the co-signer's own tranche");
    assert.deepEqual(fits.checks.map((c: { id: string }) => c.id), ["C1", "C2", "C3", "P1", "P2", "P3", "C6", "C9", "C9b", "C10", "C11", "T1", "T2", "T3"]);
    refusedBy(t, await tick({ amountIn: d0.amountIn, policySig: await K.MALLORY.signMessage({ message: V.treasury.policyMessage(pol.policy) }) }), ["C3"], "C3: the policy is not signed by the owner");
    refusedBy(t, await tick({ amountIn: d0.amountIn + 1n }), ["P2"], "P2: one unit above the co-signer's own tranche (F-044)");
    refusedBy(t, await tick({ amountIn: pol.policy.minTranche - 1n }), ["P2"], "P2: below the policy's smallest tranche");
    const cost = V.treasury.impactBps(await V.trader.readVenues(t.rail.pub, A.exec), A.usd, A.eur, 30_000_000n);
    assert.ok(cost > pol.policy.maxImpactBps && cost < 300, `30 tUSD costs ${cost.toFixed(1)} bps: above the policy's 150, below the manipulation screen's 300`);
    refusedBy(t, await tick({ amountIn: 30_000_000n }), ["P2", "P3"], "the release: P3 cannot fail without P2 (a tranche above the cost limit is above its own tranche)");
    // P3 alone (D-K4a): a policy whose cost limit (50 bps) binds below the shortfall's tranche. The request is the tranche
    // the policy allows; P2 holds, and only P3 refuses. (The rail registers its own policies with a 150 bps limit, so this
    // one, signed by the owner, is put to the same engine directly; the release's engine refuses it with P2 and P3.)
    const tight = { ...pol.policy, maxImpactBps: 50, nonce: `${pol.policy.nonce}-k4` };
    const tightSig = await owner.signMessage({ message: V.treasury.policyMessage(tight as never) });
    const view = await V.treasury.observeTreasury(t.rail.pub, tight as never, A.exec, V.economics.POLICY.reserveBuffer);
    const dTight = V.treasury.decideTranche(view.venues, tight as never, view.reserveFree, view.available, am.mandate.maxPerPayment);
    assert.deepEqual([dTight.action, dTight.limitedBy], ["convert", "impact"], "the cost limit binds below the shortfall's tranche");
    const asked = policyTranche(dTight.candidates);
    const p3req: any = { mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: asked, instruction: "check", nonce: `${tight.nonce}:check-${key()}`, brainEngine: "test", policy: tight, policySig: tightSig };
    refusedBy(t, await forkEngine.evaluateTrade(p3req), ["P3"], `the rail's engine: P3 alone, ${asked} raw units cost more than 50 bps`);
    const release = new V.cosigner.PolicyEngine(t.rail.c, devAccount("COSIGNER"), { ...(forkCfg("records-p3-release") as object), denylist: [K.MALLORY.address] } as never);
    assert.deepEqual(failed(await release.evaluateTrade({ ...p3req, nonce: `${p3req.nonce}-r` })), ["P2", "P3"], "the release refuses the same request with P2 and P3");
    const run = await t.rail.waitForJob(t.rail.submit("policy-run", { maxTicks: 6, maxSeconds: 120 }, key()).jobId);
    assert.equal((run.result!.evidence as { targetMet: boolean }).targetMet, true, run.result!.summary);
    assert.equal((await own()).action, "none");
    refusedBy(t, await tick({ amountIn: 5_000_000n }), ["P1", "P2"], "the release: P1 cannot fail without P2 (the target is met, no tranche is due)");
    const p1 = await forkTrade({ amountIn: 5_000_000n, policy: pol.policy, policySig: pol.sig, nonce: `${pol.policy.nonce}:fork-${key()}` });
    refusedBy(t, p1, ["P1"], "the rail's engine: P1 alone, the target is met and no tranche is due");
    assert.match(p1.checks.find((c: { id: string }) => c.id === "P2")!.detail, /no tranche is due \(P1\)/);

    // C10 last: ring-fence all but 12 tUSD of the free balance; converting 8 would leave less than the 5 tUSD buffer
    const free = BigInt((await t.rail.state()).treasury.free);
    assert.equal((await t.act("ring-fence", { creditor: "CloudCo", amount: t.rail.fmt(free - 12_000_000n).replace(/,/g, ""), dueInDays: 30 })).result?.outcome, "executed");
    refusedBy(t, await trade({ amountIn: 8_000_000n }), ["C10"], "C10");
    approvedWith(await trade({ amountIn: 7_000_000n }), 11, "7 tUSD leaves exactly the buffer");
  } finally { await t.stop(); }
});
