/**
 * R7-054 on the rail: earning through the proof escrow between two workspaces, each owned by its own passkeys, on a
 * real local chain with the release's ProofEscrow and MinVarianceVerifier (shared, unmodified):
 *   - quote: the provider's passkey signs the escrow's own quote digest through its owner account (ERC-1271); nothing
 *     is sent; the provider cannot hire itself;
 *   - agreement: the client funds the job from its own vault in ONE execute (withdraw, approve, open); a tampered
 *     quote, another client, another token, another verifier and a used quote are refused before anything is sent;
 *   - delivery and verification: a counterfeit certificate (the release's lazy 1/N portfolio) is refused by the
 *     verifier with nothing signed; the certified one settles and the escrow pays the provider's vault in the same
 *     transaction; a second delivery is refused;
 *   - settlement and R7 D7: the provider's budget gains ⌊price/2⌋ after two confirmations and not before;
 *   - refund: before the deadline only the provider can release the client; after it anyone refunds and a late
 *     delivery is refused; a refunded job earns nothing;
 *   - abuse cannot grow authority: a client sharing the provider's passkey (the same person's second workspace), a
 *     client the wallet declared linked (a member in common, no key shared), refund loops, and a round trip between two
 *     linked workspaces leave both budgets where they were; only an outside client's settlement adds.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Hex } from "viem";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { AuthorityView, EscrowJobView, EscrowQuote, Job } from "../types.ts";

let offset = 0;
let t: TestHost, P: Rail, C: Rail, L: Rail, M: Rail;
const pk = new SoftwarePasskey(), ck = new SoftwarePasskey(), mk = new SoftwarePasskey();
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string, words?: RegExp) => (e: { code?: string; message?: string }) => e.code === code && (!words || words.test(e.message ?? ""));
const budget = async (ws: Rail) => (await ws.cosigner.authority()) as AuthorityView;
const bal = (ws: Rail, who: `0x${string}`) => ws.bal(ws.a.asset!, who);
const PROBLEM = { kind: "custom", assets: [{ name: "Alpha", volatilityBps: 1500 }, { name: "Beta", volatilityBps: 3000 }, { name: "Gamma", volatilityBps: 800 }] };

/** The provider quotes for a client; returns what the client needs to fund it. */
async function quote(provider: Rail, signer: SoftwarePasskey, client: Rail, price: string, hours = 2) {
  const j = await t.act(provider, "escrow-quote", { client: client.a.ownerAccount, price, deliverWithinHours: hours, validForMinutes: Math.min(60, hours * 60 - 15), problem: PROBLEM, title: "Minimum-variance sleeve" }, [signer]);
  ok(j);
  return j.result!.evidence as { quote: EscrowQuote; signature: Hex; spec: Hex; quoteHash: Hex };
}
async function fund(client: Rail, signer: SoftwarePasskey, q: { quote: EscrowQuote; signature: Hex; spec: Hex }) {
  const j = await t.act(client, "escrow-fund", { quote: q.quote, signature: q.signature, spec: q.spec }, [signer]);
  ok(j);
  return String((j.result!.evidence as { escrowJobId: string }).escrowJobId);
}
const mine = (ws: Rail) => ws.rpc("evm_mine");

before(async () => {
  t = await startHost("escrow-earn", 9361, { economyAnvilPort: 9362, wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000 });
  P = await t.workspace("earn-provider", [pk]);
  C = await t.workspace("earn-client", [ck]);
  L = await t.workspace("earn-provider-shop", [pk]); // the provider's person again: the same passkey
  M = await t.workspace("earn-partner", [mk]); // a workspace with a member in common with P, but no key shared
  for (const [ws, k] of [[P, pk], [C, ck], [L, pk], [M, mk]] as const) ok(await t.act(ws, "provision", {}, [k]));
});
after(async () => { await t?.stop(); });

test("an earning journey between two workspaces: quote, funding from the client's own vault, a refused counterfeit, verified delivery and settlement, and ⌊price/2⌋ earned after two confirmations", async () => {
  await assert.rejects(() => P.propose({ kind: "escrow-quote", params: { client: P.a.ownerAccount, price: "10", deliverWithinHours: 2, problem: PROBLEM } }), refusal("self_dealing"));
  const b0 = await budget(P);
  const q = await quote(P, pk, C, "250.51");
  assert.deepEqual([q.quote.client, q.quote.payee, q.quote.provider, q.quote.price], [getAddress(C.a.ownerAccount!), getAddress(P.a.vault), getAddress(P.a.ownerAccount!), "25051"]);
  // what the client may not do with that quote: change it, fund another's, change the token or the verifier
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: { ...q.quote, price: "100" }, signature: q.signature } }), refusal("quote_signature_invalid"));
  await assert.rejects(() => M.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature } }), refusal("not_the_client"));
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: { ...q.quote, token: getAddress(C.a.reserveAsset!) }, signature: q.signature } }), refusal("wrong_token"));
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: { ...q.quote, verifier: getAddress(`0x${"7e".repeat(20)}`) }, signature: q.signature } }), refusal("unknown_verifier"));
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature, spec: "0x1234" } }), refusal("spec_mismatch"));
  // the agreement: one execute of the client's owner account, from its own vault
  const escrow = t.host.market!.escrow;
  const [vault0, escrow0] = [await bal(C, C.a.vault), await bal(C, escrow)];
  const p = await C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature, spec: q.spec } });
  assert.deepEqual(((p.terms.toSign as { calls: { action: string }[] }[])[0]).calls.map((c) => c.action), ["QEDVault (treasury).withdraw", "TestToken (tINR).approve", "ProofEscrow.open"]);
  C.cancelProposal(p.id);
  const id = await fund(C, ck, q);
  assert.deepEqual([vault0 - (await bal(C, C.a.vault)), (await bal(C, escrow)) - escrow0], [25051n, 25051n], "the price left the client's vault and is held by the escrow");
  await assert.rejects(() => C.propose({ kind: "escrow-fund", params: { quote: q.quote, signature: q.signature } }), refusal("quote_used"));
  const v1 = await C.escrow.job(id);
  assert.deepEqual([v1.status, v1.roles, v1.client], ["open", ["client"], getAddress(C.a.ownerAccount!)]);
  await assert.rejects(() => L.escrow.job(id), refusal("unknown_escrow_job"), "a workspace that is not a party sees nothing");
  // a counterfeit certificate: the verifier refuses it, nothing is signed or sent
  const kept = P.store.meta<{ spec: Hex }>(`escrow:quote:${q.quoteHash}`)!;
  const spec = (P.escrow as any).problemOf(PROBLEM).spec;
  const lazy = P.v.riskModel.encodeSolution(P.v.minvar.counterfeitEqualWeight(spec)) as Hex;
  assert.equal(kept.spec, q.spec);
  await assert.rejects(() => P.propose({ kind: "escrow-deliver", params: { jobId: id, solution: lazy } }), refusal("verification_failed", /The verifier refuses this certificate: (DualityGapTooLarge|StationarityViolated)/));
  // the certified delivery: verified and settled in one transaction
  const vaultP0 = await bal(P, P.a.vault);
  // R7-036: the job is reported done only at two confirmations, which is when D7 counts the settlement. To look at the
  // settlement with one, the service does not mine the confirmation block for this step: the job waits, confirming.
  P.cfg.confirmMining = false;
  const dp = await P.propose({ kind: "escrow-deliver", params: { jobId: id } });
  const dj = (await P.executeChecked(dp.id, passkeyApproval(dp, [pk], P.now()), key())).jobId;
  for (let i = 0; i < 600 && P.job(dj).status !== "confirming"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([P.job(dj).status, P.job(dj).confirmations?.have], ["confirming", 1], "settled, one confirmation: the job is not done yet");
  assert.equal((await bal(P, P.a.vault)) - vaultP0, 25051n, "paid into the provider's vault");
  await assert.rejects(() => P.propose({ kind: "escrow-deliver", params: { jobId: id } }), refusal("job_not_open"));
  const v2 = await P.escrow.job(id);
  assert.deepEqual([v2.status, v2.roles.sort(), v2.authority?.status], ["settled", ["payee", "provider"], "pending"], "one confirmation: not counted yet");
  assert.equal((await budget(P)).earned, b0.earned);
  await mine(P);
  await P.reconcileChain();
  P.cfg.confirmMining = true;
  const d = await P.waitForJob(dj);
  ok(d);
  assert.equal(d.confirmations?.have, 2, "the job is done at two confirmations, as the settlement is counted");
  const v3 = await P.escrow.job(id);
  assert.deepEqual([v3.authority?.status, v3.authority?.credit], ["credited", "12525"], "⌊250.51 / 2⌋ = 125.25 tINR");
  assert.equal(BigInt((await budget(P)).earned) - BigInt(b0.earned), 12525n);
  assert.equal((await budget(P)).granted, b0.granted, "earnings are never reported as granted");
  assert.equal((await C.escrow.job(id)).authority, null, "the client's side has no earnings to show");
});

test("refunds: before the deadline only the provider releases the client; after it anyone refunds, and a late delivery is refused; neither earns anything", async () => {
  const b0 = await budget(P);
  const q2 = await quote(P, pk, C, "40");
  const j2 = await fund(C, ck, q2);
  const early = await C.waitForJob(C.submit("escrow-refund", await C.escrow.refundParams(j2), key()).jobId);
  ok(early, "refused");
  assert.match(early.result!.summary, /only after its deadline/);
  const acct0 = await bal(C, C.a.ownerAccount!);
  ok(await t.act(P, "escrow-release", { jobId: j2 }, [pk]));
  assert.equal((await bal(C, C.a.ownerAccount!)) - acct0, 4000n, "refunded to the client's owner account");
  assert.equal((await C.escrow.job(j2)).status, "refunded");
  const q3 = await quote(P, pk, C, "60", 1);
  const j3 = await fund(C, ck, q3);
  offset += 3_601_000;
  await assert.rejects(() => P.propose({ kind: "escrow-deliver", params: { jobId: j3 } }), refusal("deadline_passed"));
  assert.equal((await C.escrow.job(j3)).refundable, true);
  const late = await C.waitForJob(C.submit("escrow-refund", await C.escrow.refundParams(j3), key()).jobId);
  ok(late);
  const again = await C.waitForJob(C.submit("escrow-refund", await C.escrow.refundParams(j3), key()).jobId);
  ok(again, "no-action");
  await mine(P); await mine(P);
  const b1 = await budget(P);
  assert.deepEqual([b1.earned, b1.available], [b0.earned, b0.available], "refunded jobs earn nothing");
  assert.equal((await P.escrow.job(j3)).authority?.status, "not-settled");
});

test("abuse cannot grow authority: the same person's second workspace, a declared member in common, refund loops and a round trip between linked workspaces earn nothing", async () => {
  const b0 = await budget(P);
  // the provider's person funds it from their second workspace (the same passkey): self-dealt
  const qs = await quote(P, pk, L, "100");
  const js = await fund(L, pk, qs);
  ok(await t.act(P, "escrow-deliver", { jobId: js }, [pk]));
  await mine(P); await mine(P);
  const vs = await P.escrow.job(js);
  assert.deepEqual([vs.status, vs.authority?.status], ["settled", "not-earnings"]);
  assert.match(vs.authority!.why, /principal set/);
  // a workspace with a member in common and no key shared: the wallet declares the link, and nothing is earned from it
  await t.host.addLinks(P.id, [M.id]);
  const qm = await quote(P, pk, M, "100");
  const jm = await fund(M, mk, qm);
  ok(await t.act(P, "escrow-deliver", { jobId: jm }, [pk]));
  // and the other way round: P pays M for work, M delivers; a round trip of 100 tINR each way
  const back = await quote(M, mk, P, "100");
  const jb = await fund(P, pk, back);
  ok(await t.act(M, "escrow-deliver", { jobId: jb }, [mk]));
  // refund loops: three jobs opened and released
  for (let i = 0; i < 3; i++) { const q = await quote(P, pk, C, "70"); const j = await fund(C, ck, q); ok(await t.act(P, "escrow-release", { jobId: j }, [pk])); }
  await mine(P); await mine(P);
  const bP = await budget(P), bM = await budget(M);
  assert.deepEqual([bP.earned, bP.granted], [b0.earned, b0.granted], "the provider earned nothing from its own person, a linked partner or refunds");
  assert.equal(bM.earned, "0", "the partner earned nothing from the provider either");
  assert.deepEqual(((await P.escrow.jobs()).filter((j: EscrowJobView) => j.jobId === jm || j.jobId === js).map((j) => j.authority?.status)), ["not-earnings", "not-earnings"]);
  // the control: an outside client's settlement still adds (the mechanism was not just switched off)
  const qc = await quote(P, pk, C, "20");
  const jc = await fund(C, ck, qc);
  ok(await t.act(P, "escrow-deliver", { jobId: jc }, [pk]));
  await mine(P); await mine(P);
  assert.equal(BigInt((await budget(P)).earned) - BigInt(b0.earned), 1000n, "⌊20.00 / 2⌋ = 10.00 tINR from the outside client");
});
