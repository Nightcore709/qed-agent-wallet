/**
 * What moved in and out of a wallet, as the chain's own logs hold it (rail/movements.ts, R13 RISK-084), on a real local
 * chain with the release's contracts: the opening grant, a payment, a conversion with its pool hops (each hop's fee and
 * the pool's reserves before it, checked against the execution module's own arithmetic), a withdrawal to the owner
 * account, and escrow work between two workspaces seen from both sides (funding, the provider's earnings, the client's
 * settlement, a refund). Each by transaction hash and log index, with its block, time and confirmations; and the hash the
 * chain now holds at a height. Nothing here sends anything for the read itself.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { MovementView, MovementsView } from "../rail/movements.ts";
import type { EscrowQuote, Job } from "../types.ts";

const pk = new SoftwarePasskey(), ck = new SoftwarePasskey();
let t: TestHost, P: Rail, C: Rail;
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const read = (ws: Rail, q: Record<string, string> = {}): Promise<MovementsView> => ws.movements.read(new URLSearchParams(q));
const ofTx = (v: MovementsView, hash: string) => v.movements.filter((m) => m.txHash === hash.toLowerCase());
const PROBLEM = { kind: "custom", assets: [{ name: "Alpha", volatilityBps: 1500 }, { name: "Beta", volatilityBps: 3000 }] };

before(async () => {
  t = await startHost("movements", 10480, { economyAnvilPort: 10481, heartbeatMs: 3_600_000 });
  P = await t.workspace("books-provider", [pk]);
  C = await t.workspace("books-client", [ck]);
  for (const [ws, k] of [[P, pk], [C, ck]] as const) {
    ok(await t.act(ws, "provision", {}, [k]));
    ok(await t.act(ws, "mandate", { maxPerPayment: "2500" }, [k]));
  }
  // R7 D7: a conversion's worst case is above the base budget; the owner grants authority (no money moves)
  ok(await t.act(P, "grant", { amount: "100" }, [pk]));
});
after(async () => { await t?.stop(); });

test("the opening grant: two mints from the faucet, into the treasury and the owner account, each with its block, time and the job that asked for it", async () => {
  const v = await read(P);
  assert.equal(v.network, "eip155:31337");
  assert.deepEqual(v.holders.map((h) => [h.role, h.address]), [["treasury", getAddress(P.a.vault)], ["reserve", getAddress(P.a.reserve)], ["owner-account", getAddress(P.a.ownerAccount!)]]);
  assert.deepEqual(v.tokens.map((x) => [x.symbol, x.decimals]), [["tINR", 2], ["tUSD", 6]]);
  assert.deepEqual([v.finality.kind, v.finality.depth], ["confirmations", 2]);
  const grant = P.summary.grant!;
  const mints = v.movements.filter((m) => m.counterparty.kind === "faucet");
  assert.deepEqual(mints.map((m) => [m.toRole, m.amount, m.symbol]).sort(), [["owner-account", grant.ownerAccount, "tINR"], ["treasury", grant.vault, "tINR"]].sort());
  const provision = P.jobs(50).find((j) => j.kind === "provision")!;
  for (const m of mints) {
    assert.equal(m.jobId, provision.id, "the grant is the provision job's");
    assert.equal(m.fromRole, null);
    assert.ok(grant.txs.map((x) => x.toLowerCase()).includes(m.txHash));
    const b = await P.pub.getBlock({ blockNumber: BigInt(m.blockNumber) });
    assert.deepEqual([m.blockHash, m.blockTimestamp], [b.hash, Number(b.timestamp)], "the block's own hash and time");
    assert.equal(m.confirmations, Number(BigInt(v.head.number) - BigInt(m.blockNumber) + 1n));
  }
});

test("a payment, a conversion and a withdrawal: each transfer by hash and log index, named by what it is; the conversion's hops reproduce the execution module's own output", async () => {
  const pay = await t.act(P, "pay", { payee: "CloudCo", amount: "3.5" }, [pk]);
  ok(pay);
  let v = await read(P);
  const [paid] = ofTx(v, pay.result!.tx!.hash);
  assert.ok(paid, "the payment is a movement");
  assert.deepEqual([paid.kind, paid.fromRole, paid.toRole, paid.amount, paid.symbol, paid.counterparty.kind, paid.counterparty.label, paid.jobId], ["transfer", "treasury", null, "350", "tINR", "payee", "CloudCo", pay.id]);
  // R7-036: the job is reported done once its transaction has two confirmations (its block, and the one the service mined)
  assert.deepEqual([paid.confirmations, pay.confirmations?.have], [2, 2], "the job's block and one on top: two confirmations");

  const conv = await t.act(P, "convert", { amount: "840" }, [pk]);
  ok(conv);
  v = await read(P);
  const legs = ofTx(v, conv.result!.tx!.hash);
  const out = legs.find((m) => m.fromRole === "treasury")!, into = legs.find((m) => m.toRole === "reserve")!;
  assert.deepEqual([out.symbol, out.amount, out.counterparty.kind, into.symbol, into.counterparty.kind], ["tINR", "84000", "conversion", "tUSD", "conversion"]);
  assert.ok(BigInt(into.amount) > 0n);
  const c = out.conversion!;
  assert.deepEqual([c.amountIn, c.amountOut, c.tokenOut], ["84000", into.amount, getAddress(P.a.reserveAsset!)]);
  const back = legs.filter((m) => m.toRole === "treasury").reduce((s, m) => s + BigInt(m.amount), 0n);
  assert.equal(BigInt(c.spent!), 84000n - back, "what was spent is what left less what came back");
  assert.ok(c.hops.length >= 1);
  for (const h of c.hops) {
    const fee = BigInt(h.feeBps);
    assert.equal(fee, BigInt(await P.read(h.pool, P.v.abi.CPMMPoolAbi, "feeBps") as number), "the pool's own fee");
    // QEDExecution._swap: out = (in·(10⁴ − f)·rOut) / (rIn·10⁴ + in·(10⁴ − f)), from the reserves before the swap
    const inWithFee = BigInt(h.amountIn) * (10_000n - fee);
    assert.equal(BigInt(h.amountOut), (inWithFee * BigInt(h.reserveOutBefore)) / (BigInt(h.reserveInBefore) * 10_000n + inWithFee), `${h.label}: the reserves before reproduce the output`);
  }
  const tinrIn = c.hops.filter((h) => h.tokenIn === getAddress(P.a.asset!)).reduce((s, h) => s + BigInt(h.amountIn), 0n);
  assert.equal(tinrIn, BigInt(c.spent!), "the hops in tINR add up to what was spent");

  const w = await t.act(P, "withdraw", { amount: "1.25" }, [pk]);
  ok(w);
  const [moved] = ofTx(await read(P), w.result!.tx!.hash);
  assert.deepEqual([moved.fromRole, moved.toRole, moved.counterparty.kind, moved.amount, moved.jobId], ["treasury", "owner-account", "own", "125", w.id]);
  // the logs are ordered by block, then log index, and none is listed twice
  const all = (await read(P)).movements, keys = all.map((m) => `${m.txHash}:${m.logIndex}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(all.map((m) => [Number(m.blockNumber), m.logIndex]), [...all].map((m) => [Number(m.blockNumber), m.logIndex]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});

test("escrow work between two workspaces: the client's funding, the provider's earnings and the client's settlement, then a refund back to the client's own account", async () => {
  const quote = async (price: string) => {
    const j = await t.act(P, "escrow-quote", { client: C.a.ownerAccount, price, deliverWithinHours: 2, validForMinutes: 60, problem: PROBLEM, title: "Sleeve" }, [pk]);
    ok(j);
    return j.result!.evidence as { quote: EscrowQuote; signature: string; spec: string };
  };
  const q = await quote("25.51");
  const fund = await t.act(C, "escrow-fund", { quote: q.quote, signature: q.signature, spec: q.spec }, [ck]);
  ok(fund);
  const id = String((fund.result!.evidence as { escrowJobId: string }).escrowJobId);
  const funded = ofTx(await read(C), fund.result!.tx!.hash);
  assert.deepEqual(funded.map((m) => [m.fromRole, m.toRole, m.counterparty.kind, m.amount, m.escrow?.event ?? null]), [["treasury", "owner-account", "own", "2551", null], ["owner-account", null, "escrow", "2551", "opened"]]);
  assert.deepEqual(funded[1]!.escrow, { jobId: id, event: "opened", role: "client" });

  const deliver = await t.act(P, "escrow-deliver", { jobId: id }, [pk]);
  ok(deliver);
  const [earned] = ofTx(await read(P), deliver.result!.tx!.hash);
  assert.deepEqual([earned.toRole, earned.counterparty.kind, earned.amount, earned.jobId], ["treasury", "escrow", "2551", deliver.id]);
  assert.deepEqual(earned.escrow, { jobId: id, event: "settled", role: "provider" });
  // the client sees the same settlement as the escrow's own log: nothing of its own moved, its commission is spent
  const [spent] = ofTx(await read(C), deliver.result!.tx!.hash);
  assert.deepEqual([spent.kind, spent.amount, spent.symbol, spent.fromRole, spent.jobId, spent.escrow], ["escrow-settled", "2551", "tINR", null, null, { jobId: id, event: "settled", role: "client" }]);
  assert.equal(spent.counterparty.kind, "workspace", "paid to another wallet on this rail");

  const q2 = await quote("4");
  const fund2 = await t.act(C, "escrow-fund", { quote: q2.quote, signature: q2.signature, spec: q2.spec }, [ck]);
  ok(fund2);
  const id2 = String((fund2.result!.evidence as { escrowJobId: string }).escrowJobId);
  const release = await t.act(P, "escrow-release", { jobId: id2 }, [pk]);
  ok(release);
  const [refund] = ofTx(await read(C), release.result!.tx!.hash);
  assert.deepEqual([refund.toRole, refund.counterparty.kind, refund.amount, refund.jobId, refund.escrow], ["owner-account", "escrow", "400", null, { jobId: id2, event: "refunded", role: "client" }], "observed: the provider sent it");
  assert.deepEqual(ofTx(await read(P), release.result!.tx!.hash), [], "the provider's wallet moved nothing");
});

test("confirmations count from the latest block; a range reads only its blocks; the chain's hash at a height is given, and nothing above the head", async () => {
  const before = await read(C);
  const last = before.movements.at(-1)!;
  assert.equal(last.confirmations, Number(BigInt(before.head.number) - BigInt(last.blockNumber) + 1n));
  await C.rpc("evm_mine");
  const after = await read(C);
  assert.equal(after.movements.find((m) => m.txHash === last.txHash && m.logIndex === last.logIndex)!.confirmations, last.confirmations + 1);
  const n = last.blockNumber;
  const one = await read(C, { fromBlock: n, toBlock: n, blocks: `${n},${BigInt(after.head.number) + 5n}` });
  assert.ok(one.movements.length > 0 && one.movements.every((m: MovementView) => m.blockNumber === n));
  assert.deepEqual([one.range.from, one.range.to, one.range.complete], [n, n, true]);
  assert.deepEqual(one.canonical, { [n]: last.blockHash, [(BigInt(after.head.number) + 5n).toString()]: null });
  const empty = await read(C, { fromBlock: String(BigInt(after.head.number) + 1n) });
  assert.deepEqual(empty.movements, []);
  for (const bad of [{ fromBlock: "x1" }, { toBlock: "-3" }, { blocks: Array.from({ length: 65 }, (_, i) => String(i)).join(",") }] as Record<string, string>[]) {
    await assert.rejects(() => read(C, bad), (e: { code?: string }) => e.code === "invalid_query");
  }
});
