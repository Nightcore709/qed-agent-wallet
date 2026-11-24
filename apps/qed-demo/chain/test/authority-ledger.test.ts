/**
 * R7 decision D7 on the chain (rail/authority-ledger.ts): which events of the release's contracts are which events of
 * the authority budget, from logs shaped as viem decodes them. No chain here; authority-rail.test.ts runs the same on
 * a real local chain in a passkey workspace.
 *
 *   - a payment to an outside payee consumes its amount; a payment to the workspace's own vaults or owner account
 *     consumes nothing; a conversion consumes only its realised cost against the reference band (what is given at the
 *     top, what is received at the bottom, floored at zero, rounded up); a conversion whose output leaves C, or whose
 *     execution is not found, is a payment of its input;
 *   - the agent's forward payment is a hold (availability, not budget), settled to the creditor it consumes budget,
 *     released or settled to C it comes back; the owner's own ring-fence counts nothing;
 *   - earnings: a job paid to the vault by a client outside P, in the vault's asset, after k confirmations, once; the
 *     workspace's owner account, its agent key and a linked workspace's vault are clients in P (self-dealt escrow:
 *     nothing); a job paid in another asset is a receipt, not earnings;
 *   - grants add as granted, never as earned; certificates signed and not yet used are reserved until they are used,
 *     expire or are voided by the vault's epoch;
 *   - round trips cannot raise the budget: a conversion never adds, whatever its price.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { buildLedger, conversionCost, eventsFromLogs, paymentCost, type AuthorityLogs, type D7Config, type Reservation } from "../rail/authority-ledger.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const VAULT = a(1), RESERVE = a(2), OWNER = a(3), EXEC = a(4), POLICY = a(5), AGENT = a(6), RELAYER = a(7), ESCROW = a(8);
const INR = a(10), USD = a(11), EUR = a(12);
const CLOUDCO = a(20), CLIENT = a(21), OTHER_VAULT = a(30), OTHER_OWNER = a(31);
const cfg: D7Config = {
  vault: VAULT, asset: INR, symbol: "tINR", decimals: 2, execution: [EXEC], escrow: ESCROW,
  base: "1000", rate: "1/2", confirmations: 2,
  control: [VAULT, RESERVE, OWNER],
  principal: [VAULT, RESERVE, OWNER, EXEC, POLICY, AGENT, RELAYER, OTHER_VAULT, OTHER_OWNER],
  // 84 tINR per tUSD ± 0.5%, in tINR base units per tUSD base unit (2 and 6 decimals)
  references: [{ token: USD, symbol: "tUSD", decimals: 6, lo: "41790/5000000", mid: "21/2500", hi: "42210/5000000", divergenceBps: 0, source: "test" }],
};
let n = 0;
const at = (block: number) => ({ blockNumber: BigInt(block), logIndex: n++, transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex });
const intent = (s: string) => `0x${Buffer.from(s).toString("hex").padEnd(64, "0")}` as Hex;
const payment = (block: number, id: string, recipient: Address, amount: bigint, liabilityId = 0n) => ({ ...at(block), address: VAULT, args: { intentId: intent(id), mandateHash: intent("m"), recipient, amount, liabilityId, evidenceHash: intent("e"), ref: intent("r") } });
const best = (block: number, id: string, tokenOut: Address, recipient: Address, amountIn: bigint, spent: bigint, amountOut: bigint) => ({ ...at(block), address: EXEC, args: { intentId: intent(id), tokenOut, recipient, amountIn, spent, amountOut, bound: amountOut, hops: 1n } });
const opened = (block: number, jobId: bigint, client: Address, payee: Address, token: Address, price: bigint) => ({ ...at(block), address: ESCROW, args: { jobId, client, provider: CLIENT, payee, token, price, verifier: a(99), specHash: intent("s"), deliverBy: 0n, quoteHash: intent("q") } });
const settledJob = (block: number, jobId: bigint, payee: Address, price: bigint) => ({ ...at(block), address: ESCROW, args: { jobId, payee, price, solutionHash: intent("x"), resultDigest: intent("y") } });
const none: AuthorityLogs = { payments: [], liabilitySettled: [], liabilityReleased: [], executions: [], jobsOpened: [], jobsSettled: [] };
const ledgerOf = (logs: Partial<AuthorityLogs>, o: { latest?: number; grants?: { nonce: string; amount: string; at: string }[]; reservations?: Reservation[]; now?: bigint; epoch?: bigint } = {}) =>
  buildLedger(cfg, eventsFromLogs(cfg, { ...none, ...logs }), { latestBlock: BigInt(o.latest ?? 100), grants: o.grants ?? [], reservations: o.reservations ?? [], now: o.now ?? 1000n, epoch: o.epoch ?? 0n });

test("a payment to an outside payee consumes its amount; to the workspace's own vaults or owner account nothing", () => {
  const l = ledgerOf({ payments: [payment(5, "p1", CLOUDCO, 300n), payment(6, "p2", RESERVE, 500n), payment(7, "p3", OWNER, 200n)] });
  assert.deepEqual([l.budget, l.available, l.consumed.payments], [700n, 700n, 300n]);
  assert.deepEqual(l.rule.log.map((e) => e.kind), ["pay", "self-payment", "self-payment"]);
  assert.deepEqual(paymentCost(cfg, CLOUDCO, 250n, false), { cost: 250n, how: "payment" });
  assert.deepEqual(paymentCost(cfg, RESERVE, 250n, false), { cost: 0n, how: "self-payment" });
  assert.deepEqual(paymentCost(cfg, CLOUDCO, 250n, true), { cost: 250n, how: "hold" });
});

test("a conversion consumes only its realised cost against the reference; its unspent rest and its output stay in C", () => {
  // 1,000.00 tINR spent (of 1,050.00 certified; 50.00 came back) for 11.8 tUSD, into the reserve vault
  const out = 11_800_000n;
  const l = ledgerOf({ payments: [payment(5, "c1", EXEC, 105_000n)], executions: [best(5, "c1", USD, RESERVE, 105_000n, 100_000n, out)] });
  // cost = ⌈100,000 − 11,800,000 · 41790/5,000,000⌉ = ⌈100,000 − 98,624.4⌉ = 1,376 paise
  assert.deepEqual([l.consumed.conversions, l.budget], [1_376n, 1_000n - 1_376n]);
  assert.equal(l.rule.log[0].kind, "convert");
  // a favourable conversion costs nothing and never adds
  const g = ledgerOf({ payments: [payment(5, "c2", EXEC, 100_000n)], executions: [best(5, "c2", USD, RESERVE, 100_000n, 100_000n, 13_000_000n)] });
  assert.deepEqual([g.budget, g.rule.log[0].deltaBudget], [1_000n, 0n]);
  // output to someone outside C: a payment of the input
  const o = ledgerOf({ payments: [payment(5, "c3", EXEC, 400n)], executions: [best(5, "c3", USD, CLOUDCO, 400n, 400n, 47_000n)] });
  assert.deepEqual([o.budget, o.rule.log[0].kind], [600n, "convert-and-pay"]);
  // no BestExecution for the intent (or one from another transaction): the whole certified amount is a payment
  const lost = ledgerOf({ payments: [payment(5, "c4", EXEC, 400n)], executions: [best(9, "c4", USD, RESERVE, 400n, 400n, 47_000n)] });
  assert.deepEqual([lost.budget, lost.rule.log[0].kind], [600n, "pay"]);
  // an output asset with no reference is worth nothing to the budget
  const eur = ledgerOf({ payments: [payment(5, "c5", EXEC, 400n)], executions: [best(5, "c5", EUR, RESERVE, 400n, 400n, 47_000n)] });
  assert.equal(eur.budget, 600n);
});

test("round trips cannot raise the budget: every conversion's debit is at least zero, whatever its price", () => {
  const pays: AuthorityLogs["payments"] = [], execs: AuthorityLogs["executions"] = [];
  for (let i = 0; i < 40; i++) {
    const spent = BigInt(1 + ((i * 7919) % 5000)), out = BigInt(((i * 104_729) % 900_000) + 1);
    pays.push(payment(10 + i, `rt${i}`, EXEC, spent)); execs.push(best(10 + i, `rt${i}`, USD, i % 2 ? RESERVE : VAULT, spent, spent, out));
  }
  const l = ledgerOf({ payments: pays, executions: execs });
  assert.ok(l.rule.log.every((e) => e.deltaBudget <= 0n));
  assert.ok(l.budget <= 1_000n);
});

test("the agent's forward payment is a hold; settled to its creditor it consumes budget, released it comes back; the owner's own ring-fence counts nothing", () => {
  const hold = payment(5, "f1", CLOUDCO, 200n, 1n), hold2 = payment(6, "f2", CLOUDCO, 300n, 2n);
  let l = ledgerOf({ payments: [hold, hold2] });
  assert.deepEqual([l.budget, l.held, l.available], [1_000n, 500n, 500n]);
  l = ledgerOf({ payments: [hold, hold2], liabilitySettled: [{ ...at(8), address: VAULT, args: { id: 1n, creditor: CLOUDCO, amount: 200n, settledBy: AGENT } }], liabilityReleased: [{ ...at(9), address: VAULT, args: { id: 2n, creditor: CLOUDCO, amount: 300n } }] });
  assert.deepEqual([l.budget, l.held, l.available, l.consumed.promisesPaid], [800n, 0n, 800n, 200n]);
  // a liability the agent did not create (the owner ring-fenced it, liability 3): its settlement is the owner's act
  l = ledgerOf({ liabilitySettled: [{ ...at(8), address: VAULT, args: { id: 3n, creditor: CLOUDCO, amount: 400n, settledBy: AGENT } }] });
  assert.deepEqual([l.budget, l.available], [1_000n, 1_000n]);
  // a creditor that assigned the claim to the workspace itself: the settlement comes back (hold settled to C)
  l = ledgerOf({ payments: [hold], liabilitySettled: [{ ...at(8), address: VAULT, args: { id: 1n, creditor: VAULT, amount: 200n, settledBy: AGENT } }] });
  assert.deepEqual([l.budget, l.available], [1_000n, 1_000n]);
});

test("self-dealt escrow raises nothing: jobs paid to the vault by its owner account, its agent key or a linked workspace are receipts in P; an outside client earns r·price after k confirmations, once", () => {
  const jobs = [[1n, OWNER], [2n, AGENT], [3n, OTHER_VAULT], [4n, OTHER_OWNER], [5n, RELAYER]] as const;
  const l = ledgerOf({ jobsOpened: jobs.map(([id, c]) => opened(3, id, c, VAULT, INR, 10_000n)), jobsSettled: jobs.map(([id]) => settledJob(4, id, VAULT, 10_000n)) });
  assert.deepEqual([l.budget, l.earned], [1_000n, 0n]);
  assert.equal(l.notEarnings.length, 5);
  assert.ok(l.notEarnings.every((x) => /principal/.test(x.why)), JSON.stringify(l.notEarnings));
  // an outside client: one confirmation is not enough; two are
  const outside = { jobsOpened: [opened(3, 9n, CLIENT, VAULT, INR, 10_001n)], jobsSettled: [settledJob(50, 9n, VAULT, 10_001n)] };
  const early = ledgerOf(outside, { latest: 50 });
  assert.deepEqual([early.earned, early.pendingCredits.map((p) => p.confirmations)], [0n, [1]]);
  const later = ledgerOf(outside, { latest: 51 });
  assert.deepEqual([later.earned, later.budget], [5_000n, 6_000n], "⌊½ · 10,001⌋");
  // a job paid in another asset is a receipt, not earnings
  const usd = ledgerOf({ jobsOpened: [opened(3, 10n, CLIENT, VAULT, USD, 10_000_000n)], jobsSettled: [settledJob(4, 10n, VAULT, 10_000_000n)] });
  assert.deepEqual([usd.earned, /tUSD|asset/.test(usd.notEarnings[0].why)], [0n, true]);
  // a job settled to someone else is not this workspace's
  const elsewhere = ledgerOf({ jobsOpened: [opened(3, 11n, CLIENT, CLOUDCO, INR, 10_000n)], jobsSettled: [settledJob(4, 11n, CLOUDCO, 10_000n)] });
  assert.equal(elsewhere.earned, 0n);
  // a settlement whose opening is unknown cannot be shown to come from outside P: not earnings
  const orphan = ledgerOf({ jobsSettled: [settledJob(4, 12n, VAULT, 10_000n)] });
  assert.equal(orphan.earned, 0n);
});

test("grants add as granted, never as earned; certificates signed and not yet used are reserved until used, expired or voided", () => {
  const g = ledgerOf({}, { grants: [{ nonce: "g1", amount: "2500", at: "t" }, { nonce: "g2", amount: "500", at: "t" }] });
  assert.deepEqual([g.grants, g.earned, g.budget, g.available], [3_000n, 0n, 4_000n, 4_000n]);
  const r = (id: string, cost: string, expiresAt: string, epoch = "0"): Reservation => ({ intentId: intent(id), cost, kind: "payment", expiresAt, epoch, at: "t" });
  const reservations = [r("used", "300", "2000"), r("open", "200", "2000"), r("expired", "100", "999"), r("voided", "50", "2000", "7")];
  const l = ledgerOf({ payments: [payment(5, "used", CLOUDCO, 300n)] }, { reservations, now: 1000n, epoch: 0n });
  // "used" is now the chain's own debit; "open" still reserves; "expired" and "voided" no longer can be used
  assert.deepEqual([l.budget, l.reserved, l.available, l.liveReservations.map((x) => x.cost)], [700n, 200n, 500n, ["200"]]);
});

test("a conversion's admission: the worst case is what the order's floor allows, at the reference's low end; refused when the venues' mid leaves the band", () => {
  const ok = conversionCost(cfg, { tokenIn: INR, amountIn: 100_000n, tokenOut: USD, minOut: 11_682_000n, recipient: RESERVE, marketOutPerIn: 1 / 0.0084 });
  // ⌈100,000 − 11,682,000 · 0.008358⌉ = ⌈100,000 − 97,638.156⌉ = 2,362
  assert.deepEqual([ok.cost, ok.how, ok.inside], [2_362n, "conversion", true]);
  const off = conversionCost(cfg, { tokenIn: INR, amountIn: 100_000n, tokenOut: USD, minOut: 11_682_000n, recipient: RESERVE, marketOutPerIn: 1 / 0.0085 });
  assert.equal(off.inside, false, "84 × 1.012 is above the band's top (84.42)");
  const out = conversionCost(cfg, { tokenIn: INR, amountIn: 100_000n, tokenOut: USD, minOut: 11_682_000n, recipient: CLOUDCO, marketOutPerIn: 1 / 0.0084 });
  assert.deepEqual([out.cost, out.how], [100_000n, "convert-and-pay"]);
  const unknown = conversionCost(cfg, { tokenIn: INR, amountIn: 100_000n, tokenOut: EUR, minOut: 1n, recipient: RESERVE, marketOutPerIn: 1 });
  assert.deepEqual([unknown.cost, unknown.how], [100_000n, "unvalued"]);
  // an input with no reference cannot be valued at the top of its band: refused, never free
  const input = conversionCost(cfg, { tokenIn: EUR, amountIn: 100_000n, tokenOut: USD, minOut: 1n, recipient: RESERVE, marketOutPerIn: 1 });
  assert.deepEqual([input.how, input.inside], ["unvalued-input", false]);
});

// ───────────── control is per asset (R8 D7 validation, finding F-R8-3) ─────────────
// A QEDVault transfers only its own asset (QEDVault.sol: executePayment, settle and withdraw move `asset`), so tINR that
// reaches the tUSD reserve vault can never leave it. With `controlAssets`, the reserve vault is in C for tUSD only.
const byAsset: D7Config = { ...cfg, controlAssets: [{ address: VAULT, assets: [INR] }, { address: RESERVE, assets: [USD] }, { address: OWNER, assets: "any" }] };
const ledgerByAsset = (logs: Partial<AuthorityLogs>) => buildLedger(byAsset, eventsFromLogs(byAsset, { ...none, ...logs }), { latestBlock: 100n, grants: [], reservations: [], now: 1000n, epoch: 0n });
const settledL = (block: number, id: bigint, creditor: Address, amount: bigint) => ({ ...at(block), address: VAULT, args: { id, creditor, amount, settledBy: CLOUDCO } });

test("control is per asset: a payment of tINR to the tUSD reserve vault is a payment (the tINR is locked there); to the owner account nothing", () => {
  const l = ledgerByAsset({ payments: [payment(5, "pa1", RESERVE, 300n), payment(6, "pa2", OWNER, 200n)] });
  assert.deepEqual([l.budget, l.available, l.consumed.payments], [700n, 700n, 300n]);
  assert.deepEqual(l.rule.log.map((e) => e.kind), ["pay", "self-payment"]);
  assert.deepEqual(paymentCost(byAsset, RESERVE, 250n, false), { cost: 250n, how: "payment" });
  assert.deepEqual(paymentCost(byAsset, OWNER, 250n, false), { cost: 0n, how: "self-payment" });
  assert.deepEqual(paymentCost(byAsset, VAULT, 250n, false), { cost: 0n, how: "self-payment" });
  // without controlAssets the rule is as before (the first test of this file)
  assert.deepEqual(paymentCost(cfg, RESERVE, 250n, false), { cost: 0n, how: "self-payment" });
});

test("control is per asset: a promise its creditor assigns to the tUSD reserve vault and settles there has been paid out", () => {
  const logs = { payments: [payment(5, "fa1", CLOUDCO, 400n, 1n)], liabilitySettled: [settledL(9, 1n, RESERVE, 400n)] };
  const l = ledgerByAsset(logs);
  assert.deepEqual([l.budget, l.held, l.available, l.consumed.promisesPaid], [600n, 0n, 600n, 400n]);
  // the rule before per-asset control read the same settlement as money coming home
  const before = ledgerOf(logs);
  assert.deepEqual([before.budget, before.available, before.consumed.promisesPaid], [1000n, 1000n, 0n]);
  // settled to the owner account, which can move tINR, it did come home
  const home = ledgerByAsset({ payments: [payment(5, "fa2", CLOUDCO, 400n, 1n)], liabilitySettled: [settledL(9, 1n, OWNER, 400n)] });
  assert.deepEqual([home.budget, home.available, home.consumed.promisesPaid], [1000n, 1000n, 0n]);
});

test("control is per asset: an outside client's tINR job paid to the tUSD reserve vault is not earnings; the same job paid to the vault is", () => {
  const l = ledgerByAsset({
    jobsOpened: [opened(3, 11n, CLIENT, RESERVE, INR, 10_000n), opened(3, 12n, CLIENT, VAULT, INR, 10_000n)],
    jobsSettled: [settledJob(4, 11n, RESERVE, 10_000n), settledJob(4, 12n, VAULT, 10_000n)],
  });
  assert.deepEqual([l.earned, l.notEarnings.length], [5_000n, 1]);
  assert.match(l.notEarnings[0].why, /cannot release tINR: the money is locked there/);
});

test("control is per asset: a conversion into tUSD for the reserve vault costs only its cost against the reference; into tEUR, which the reserve cannot release, it is a payment of its input", () => {
  const out = 11_800_000n;
  const l = ledgerByAsset({
    payments: [payment(5, "ca1", EXEC, 100_000n), payment(6, "ca2", EXEC, 100_000n)],
    executions: [best(5, "ca1", USD, RESERVE, 100_000n, 100_000n, out), best(6, "ca2", EUR, RESERVE, 100_000n, 100_000n, 10_900_000n)],
  });
  assert.deepEqual([l.consumed.conversions, l.consumed.payments], [1376n, 100_000n]);
  const q = { tokenIn: INR, amountIn: 100_000n, minOut: out, recipient: RESERVE, marketOutPerIn: 119.05 };
  assert.equal(conversionCost(byAsset, { ...q, tokenOut: USD }).how, "conversion");
  assert.equal(conversionCost(byAsset, { ...q, tokenOut: EUR }).how, "convert-and-pay");
});
