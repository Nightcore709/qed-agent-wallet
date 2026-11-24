/**
 * R13 E3 on the rail: the review and dispute step in front of the release's ProofEscrow (unmodified), on a real local
 * chain, between three workspaces each owned by its own passkeys: a provider, a client and a named decider.
 *   - the artifact the rail deploys is the committed source's build, and stands in front of the market's ProofEscrow;
 *   - quote: the provider's one signature binds the dispute terms (the quote's id is their hash); a decider that is a
 *     party, or not a workspace here, is refused before anything is signed;
 *   - funding: altered terms, another client and missing terms are refused; the client's one execute opens the job;
 *   - delivery: verified work is paid to the dispute escrow, not the provider, and the review starts in the same block;
 *   - dispute: only the client, only in the review; evidence from both sides until its period ends; the decider rules
 *     only after it, within its powers, and is paid nothing; a split pays both exactly;
 *   - timeouts: the review's and the decision's outcomes, applied by the rail's relayer only once due;
 *   - no delivery: the provider's release and the refund after the deadline both reach the client;
 *   - giving way: the client accepts during a dispute; the provider refunds; the authority budget gains nothing.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { EscrowJobView, EscrowQuote, Job } from "../types.ts";
import { CHAIN_DIR } from "../rail/config.ts";
import { DISPUTE_ARTIFACT } from "../rail/disputes.ts";

let offset = 0;
let t: TestHost, P: Rail, C: Rail, J: Rail, M: Rail;
const pk = new SoftwarePasskey(), ck = new SoftwarePasskey(), jk = new SoftwarePasskey(), mk = new SoftwarePasskey();
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string, words?: RegExp) => (e: { code?: string; message?: string }) => e.code === code && (!words || words.test(e.message ?? ""));
const PROBLEM = { kind: "custom", assets: [{ name: "Alpha", volatilityBps: 1500 }, { name: "Beta", volatilityBps: 3000 }] };
const REVIEW = 600, EVIDENCE = 300, DECISION = 900;
const terms = (over: Record<string, unknown> = {}) => ({ decider: J.a.ownerAccount, reviewSeconds: REVIEW, evidenceSeconds: EVIDENCE, decisionSeconds: DECISION, onReviewBps: 10_000, onDecisionBps: 5_000, deciderMay: { pay: true, refund: true, split: true }, ...over });
const bal = (ws: Rail, who: `0x${string}`) => ws.bal(ws.a.asset!, who);

type Quoted = { quote: EscrowQuote; signature: Hex; spec: Hex; quoteHash: Hex; dispute: { terms: Record<string, unknown>; termsHash: Hex; escrow: string } };
async function quote(price: string, over: Record<string, unknown> = {}, hours = 2): Promise<Quoted> {
  const j = await t.act(P, "escrow-quote", { client: C.a.ownerAccount, price, deliverWithinHours: hours, validForMinutes: Math.min(60, hours * 60 - 15), problem: PROBLEM, title: "Certified sleeve", dispute: terms(over) }, [pk]);
  ok(j);
  return j.result!.evidence as Quoted;
}
async function fund(q: Quoted): Promise<{ escrowJobId: string; disputeJobId: string }> {
  const j = await t.act(C, "escrow-fund", { quote: q.quote, signature: q.signature, spec: q.spec, dispute: q.dispute.terms }, [ck]);
  ok(j);
  return j.result!.evidence as { escrowJobId: string; disputeJobId: string };
}
const view = (ws: Rail, id: string) => ws.escrow.job(id) as Promise<EscrowJobView>;
const relay = async (ws: Rail, kind: "escrow-finish" | "escrow-refund", params: Record<string, unknown>) => ws.waitForJob(ws.submit(kind, params, key()).jobId);

before(async () => {
  t = await startHost("disputes", 11781, { economyAnvilPort: 11782, wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000 });
  P = await t.workspace("dispute-provider", [pk]);
  C = await t.workspace("dispute-client", [ck]);
  J = await t.workspace("dispute-decider", [jk]);
  M = await t.workspace("dispute-other", [mk]);
  for (const [ws, k] of [[P, pk], [C, ck], [J, jk], [M, mk]] as const) ok(await t.act(ws, "provision", {}, [k]));
});
after(async () => { await t?.stop(); });

test("the deployed dispute escrow is the committed source's build, in front of the market's unmodified ProofEscrow", async () => {
  const art = JSON.parse(readFileSync(DISPUTE_ARTIFACT, "utf8"));
  const source = readFileSync(join(CHAIN_DIR, "disputes", "src", "QEDDisputeEscrow.sol"));
  assert.equal(createHash("sha256").update(source).digest("hex"), art.sourceSha256, "artifact is stale: run scripts/export-artifacts.mjs in chain/disputes");
  const d = t.host.disputes!;
  assert.equal(t.host.disputeStatus.state, "ready");
  assert.equal(getAddress(await P.read(d.address, d.abi, "proofEscrow")), getAddress(t.host.market!.escrow));
  assert.equal(d.artifact.sourceSha256, art.sourceSha256);
});

test("a dispute: the terms bind before money moves, verified work waits for the review, the client disputes, both sides give evidence, and the named decider splits the price after the evidence period", async () => {
  // a decider that is a party, or not a workspace here, is refused before anything is signed
  await assert.rejects(() => P.propose({ kind: "escrow-quote", params: { client: C.a.ownerAccount, price: "10", deliverWithinHours: 2, validForMinutes: 60, problem: PROBLEM, dispute: terms({ decider: C.a.ownerAccount }) } }), refusal("decider_not_independent"));
  await assert.rejects(() => P.propose({ kind: "escrow-quote", params: { client: C.a.ownerAccount, price: "10", deliverWithinHours: 2, validForMinutes: 60, problem: PROBLEM, dispute: terms({ decider: `0x${"7e".repeat(20)}` }) } }), refusal("unknown_decider"));
  await assert.rejects(() => P.propose({ kind: "escrow-quote", params: { client: C.a.ownerAccount, price: "10", deliverWithinHours: 2, validForMinutes: 60, problem: PROBLEM, dispute: terms({ deciderMay: { pay: false, refund: false, split: false } }) } }), refusal("invalid_params"));
  const q = await quote("250.51");
  const D = getAddress(t.host.disputes!.address);
  assert.deepEqual([q.quote.client, q.quote.payee], [D, D], "the proof escrow pays the dispute escrow, never the provider directly");
  assert.equal(q.quote.quoteId, q.dispute.termsHash, "one signature binds the dispute terms");
  assert.equal(getAddress(q.dispute.terms.payee as string), getAddress(P.a.vault));
  // what the client may not do with it: change the terms, fund someone else's, leave the terms out
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature, dispute: { ...q.dispute.terms, decisionTimeoutBps: 0 } } }), refusal("terms_mismatch"));
  await assert.rejects(() => M.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature, dispute: q.dispute.terms } }), refusal("not_the_client"));
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature } }), refusal("invalid_params"));
  const p = await C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature, spec: q.spec, dispute: q.dispute.terms } });
  assert.deepEqual(((p.terms.toSign as { calls: { action: string }[] }[])[0]).calls.map((c) => c.action), ["QEDVault (treasury).withdraw", "TestToken (tINR).approve", "QEDDisputeEscrow.open"]);
  assert.equal((p.terms.dispute as { words: string[] }).words.length, 5, "the terms in plain sentences, in the document the client signs");
  C.cancelProposal(p.id);
  const ids = await fund(q);
  // the decider sees the job; a stranger does not
  assert.deepEqual((await view(J, ids.escrowJobId)).roles, ["decider"]);
  await assert.rejects(() => M.escrow.job(ids.escrowJobId), refusal("unknown_escrow_job"));
  await assert.rejects(() => J.propose({ kind: "escrow-decide", params: { disputeId: ids.disputeJobId, toProvider: "100" } }), refusal("wrong_state"), "nothing to decide before a dispute");
  // delivery: verified, held for the review
  const vault0 = await bal(P, P.a.vault);
  const dp = await P.propose({ kind: "escrow-deliver", params: { jobId: ids.escrowJobId } });
  assert.deepEqual(((dp.terms.toSign as { calls: { action: string }[] }[])[0]).calls.map((c) => c.action), ["ProofEscrow.deliver", "QEDDisputeEscrow.noteDelivered"]);
  P.cancelProposal(dp.id);
  ok(await t.act(P, "escrow-deliver", { jobId: ids.escrowJobId }, [pk]));
  assert.equal(await bal(P, P.a.vault), vault0, "not paid before the review");
  assert.equal(await bal(P, D), 25051n);
  const v1 = await view(C, ids.escrowJobId);
  assert.deepEqual([v1.status, v1.dispute?.status, v1.dispute?.canDispute, v1.roles], ["settled", "delivered", true, ["client"]]);
  assert.equal(v1.dispute!.reviewEndsAt - v1.dispute!.deliveredAt, REVIEW);
  const pv = await view(P, ids.escrowJobId);
  assert.deepEqual([pv.roles.sort(), pv.authority?.status], [["payee", "provider"], "not-earnings"], "paid through the dispute escrow, it adds nothing to the authority budget");
  // only the client disputes
  await assert.rejects(() => P.propose({ kind: "escrow-dispute", params: { disputeId: ids.disputeJobId, reason: "I dispute my own work" } }), refusal("not_the_client"));
  ok(await t.act(C, "escrow-dispute", { disputeId: ids.disputeJobId, reason: "The weights cover two assets; we agreed on the whole sleeve." }, [ck]));
  const v2 = await view(J, ids.escrowJobId);
  assert.equal(v2.dispute?.status, "disputed");
  assert.match(String(v2.dispute?.reason?.hash), /^0x[0-9a-f]{64}$/);
  // evidence from both sides; the decider waits for the evidence period
  ok(await t.act(P, "escrow-evidence", { disputeId: ids.disputeJobId, text: "The quote named exactly two assets; the certificate checks." }, [pk]));
  ok(await t.act(C, "escrow-evidence", { disputeId: ids.disputeJobId, text: "Our message of Monday asked for the third asset too." }, [ck]));
  await assert.rejects(() => J.propose({ kind: "escrow-decide", params: { disputeId: ids.disputeJobId, toProvider: "150" } }), refusal("evidence_open"));
  assert.deepEqual((await view(J, ids.escrowJobId)).dispute!.evidence.map((e) => e.by), ["provider", "client"]);
  offset += (EVIDENCE + 2) * 1000;
  await assert.rejects(() => P.propose({ kind: "escrow-evidence", params: { disputeId: ids.disputeJobId, text: "One more thing, too late." } }), refusal("evidence_closed"));
  await assert.rejects(() => C.propose({ kind: "escrow-decide", params: { disputeId: ids.disputeJobId, toProvider: "0" } }), refusal("not_the_decider"));
  await assert.rejects(() => J.propose({ kind: "escrow-decide", params: { disputeId: ids.disputeJobId, toProvider: "300" } }), refusal("invalid_amount"));
  const client0 = await bal(C, C.a.ownerAccount!), decider0 = await bal(J, J.a.ownerAccount!), djVault0 = await bal(J, J.a.vault);
  ok(await t.act(J, "escrow-decide", { disputeId: ids.disputeJobId, toProvider: "150.00" }, [jk]));
  assert.equal((await bal(P, P.a.vault)) - vault0, 15000n, "the provider's part, into its vault");
  assert.equal((await bal(C, C.a.ownerAccount!)) - client0, 10051n, "the rest, to the client's owner account");
  assert.deepEqual([await bal(J, J.a.ownerAccount!), await bal(J, J.a.vault)], [decider0, djVault0], "the decider is paid nothing");
  const v3 = await view(C, ids.escrowJobId);
  assert.deepEqual([v3.dispute?.status, v3.dispute?.outcome, v3.dispute?.toProvider, v3.dispute?.toClient], ["closed", "decided", "15000", "10051"]);
  // the books' source (GET /movements): each side's movements through the dispute escrow, named as escrow movements
  const ofJob = async (ws: Rail) => ((await ws.movements.read(new URLSearchParams())).movements as any[]).filter((x) => x.escrow?.jobId === ids.escrowJobId).map((x) => [x.kind, x.escrow.event, x.escrow.role, x.amount, x.counterparty.kind]);
  assert.deepEqual(await ofJob(P), [["transfer", "settled", "provider", "15000", "escrow"]]);
  assert.deepEqual((await ofJob(C)).sort(), [["escrow-settled", "settled", "client", "15000", "workspace"], ["transfer", "opened", "client", "25051", "escrow"], ["transfer", "refunded", "client", "10051", "escrow"]].sort() as any);
});

test("timeouts: silence after delivery pays the provider; no ruling by the deadline splits half each; the rail applies each only once due", async () => {
  const q = await quote("33.33");
  const ids = await fund(q);
  ok(await t.act(P, "escrow-deliver", { jobId: ids.escrowJobId }, [pk]));
  ok(await relay(C, "escrow-finish", await C.escrow.finishParams(ids.disputeJobId)), "refused");
  offset += (REVIEW + 2) * 1000;
  await assert.rejects(() => C.propose({ kind: "escrow-dispute", params: { disputeId: ids.disputeJobId, reason: "Too late to dispute this one." } }), refusal("review_over"));
  const vault0 = await bal(P, P.a.vault);
  ok(await relay(C, "escrow-finish", await C.escrow.finishParams(ids.disputeJobId)));
  assert.equal((await bal(P, P.a.vault)) - vault0, 3333n);
  assert.equal((await view(P, ids.escrowJobId)).dispute?.outcome, "review-timeout");

  const q2 = await quote("25.51");
  const ids2 = await fund(q2);
  ok(await t.act(P, "escrow-deliver", { jobId: ids2.escrowJobId }, [pk]));
  ok(await t.act(C, "escrow-dispute", { disputeId: ids2.disputeJobId, reason: "Not what we asked for at all." }, [ck]));
  offset += (DECISION + 2) * 1000;
  await assert.rejects(() => J.propose({ kind: "escrow-decide", params: { disputeId: ids2.disputeJobId, toProvider: "25.51" } }), refusal("decision_over"));
  const [v0, c0] = [await bal(P, P.a.vault), await bal(C, C.a.ownerAccount!)];
  ok(await relay(J, "escrow-finish", await J.escrow.finishParams(ids2.disputeJobId)));
  assert.equal((await bal(P, P.a.vault)) - v0, 1276n, "the provider: 2551 - floor(2551 / 2)");
  assert.equal((await bal(C, C.a.ownerAccount!)) - c0, 1275n, "the client: floor(2551 / 2)");
  assert.equal((await view(C, ids2.escrowJobId)).dispute?.outcome, "decision-timeout");
});

test("no delivery: the provider's release before the deadline and anyone's refund after it both reach the client through the dispute escrow", async () => {
  const q = await quote("12");
  const ids = await fund(q);
  const c0 = await bal(C, C.a.ownerAccount!);
  ok(await t.act(P, "escrow-release", { jobId: ids.escrowJobId }, [pk]));
  assert.equal((await bal(C, C.a.ownerAccount!)) - c0, 1200n);
  assert.equal((await view(C, ids.escrowJobId)).dispute?.outcome, "not-delivered");

  const q2 = await quote("13", {}, 1);
  const ids2 = await fund(q2);
  ok(await relay(C, "escrow-refund", await C.escrow.refundParams(ids2.escrowJobId)), "refused");
  offset += 3_601_000;
  await assert.rejects(() => P.propose({ kind: "escrow-deliver", params: { jobId: ids2.escrowJobId } }), refusal("deadline_passed"));
  assert.equal((await view(C, ids2.escrowJobId)).refundable, true);
  const c1 = await bal(C, C.a.ownerAccount!);
  ok(await relay(C, "escrow-refund", await C.escrow.refundParams(ids2.escrowJobId)));
  assert.equal((await bal(C, C.a.ownerAccount!)) - c1, 1300n);
  ok(await relay(C, "escrow-refund", await C.escrow.refundParams(ids2.escrowJobId)), "no-action");
});

test("giving way: the client accepts during its dispute; the provider refunds; neither can take the other's step", async () => {
  const qa = await quote("20");
  const a = await fund(qa);
  const qb = await quote("21");
  const b = await fund(qb);
  for (const x of [a, b]) ok(await t.act(P, "escrow-deliver", { jobId: x.escrowJobId }, [pk]));
  ok(await t.act(C, "escrow-dispute", { disputeId: a.disputeJobId, reason: "Checking the weights first." }, [ck]));
  await assert.rejects(() => P.propose({ kind: "escrow-accept", params: { disputeId: a.disputeJobId } }), refusal("not_the_client"));
  await assert.rejects(() => C.propose({ kind: "escrow-give-way", params: { disputeId: b.disputeJobId } }), refusal("not_the_provider"));
  const [v0, c0] = [await bal(P, P.a.vault), await bal(C, C.a.ownerAccount!)];
  ok(await t.act(C, "escrow-accept", { disputeId: a.disputeJobId }, [ck]));
  ok(await t.act(P, "escrow-give-way", { disputeId: b.disputeJobId }, [pk]));
  assert.equal((await bal(P, P.a.vault)) - v0, 2000n);
  assert.equal((await bal(C, C.a.ownerAccount!)) - c0, 2100n);
  assert.deepEqual([(await view(P, a.escrowJobId)).dispute?.outcome, (await view(P, b.escrowJobId)).dispute?.outcome], ["accepted", "provider-gave-way"]);
  await assert.rejects(() => C.propose({ kind: "escrow-accept", params: { disputeId: a.disputeJobId } }), refusal("wrong_state"));
  // the decider's list holds every job it was named on
  const mine = (await J.escrow.jobs()).filter((x: EscrowJobView) => x.roles.includes("decider"));
  assert.ok(mine.length >= 7);
});
