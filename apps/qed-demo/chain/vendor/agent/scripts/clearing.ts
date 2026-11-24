/**
 * QED CLEARING — live run of proof-gated multilateral netting.
 *
 *   KEYS_FILE=.keys.env.clearing SCRIPT=agent/scripts/clearing.ts SHADOW_OF=11155111 npm run local
 *   (or without SHADOW_OF / KEYS_FILE: a local chain with deterministic dev keys)
 *
 * Five AI businesses owe each other 200 tUSD in overlapping cycles but hold only 28 tUSD of cash.
 * Gross settlement is impossible. The QED agent reads the open obligations from the chain, computes
 * the maximal netting with its optimality certificate, and submits it; the contract executes it only
 * after checking the proof. A rival clearing bot and Mallory try lazy and dishonest nettings first.
 * Afterwards every remaining debt settles with exactly the cash the agents hold.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, parseEther, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QEDClearingAbi, QEDClearingBytecode, TestUSDAbi, TestUSDBytecode } from "../src/abi/contracts.js";
import { fn, fmtUsd } from "../src/chain.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { checkNetting, greedyNetting, netPositions, settlementOrder, solveNetting, type Obligation } from "../src/engine/netting.js";
import { CLEARING_MEMBERS, CLEARING_OBLIGATIONS, USD } from "../src/engine/clearingScenario.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.clearing");
const { chainId, rpcUrl } = rpcConfig();
const ROLES = ["DEPLOYER", "NORTHWIND", "QEDM", "CLOUDCO", "HELIX", "ATLAS", "MALLORY"] as const;
if (!process.env.DEPLOYER_PK) {
  if (chainId !== 31337) throw new Error("real keys required for a public network");
  for (const r of ROLES) process.env[`${r}_PK`] = keccak256(toHex(`qed-dev-clearing-${r}`));
  console.log("no clearing keys found → deterministic DEV keys (local chain only)");
}
const acct = (r: (typeof ROLES)[number]): LocalAccount => privateKeyToAccount(process.env[`${r}_PK`] as Hex);
const deployer = acct("DEPLOYER");
const members = [acct("NORTHWIND"), acct("QEDM"), acct("CLOUDCO"), acct("HELIX"), acct("ATLAS")];
const prover = members[1]; // the QED agent is itself a member — and still cannot favour itself
const mallory = acct("MALLORY");

const network = (NETWORK_NAMES[chainId] ?? `chain-${chainId}`).toLowerCase().replace(/\s+/g, "-");
const OUT = process.env.EVIDENCE_DIR ?? `evidence/${network}/clearing`;
mkdirSync(OUT, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);

async function main() {
  console.log(`\nQED Clearing live run on ${NETWORK_NAMES[chainId] ?? chainId} via ${rpcUrl}\n`);
  ev.meta = {
    schema: "qed.evidence/v1",
    run: "clearing",
    network: { chainId, name: NETWORK_NAMES[chainId] ?? `chain-${chainId}`, explorer: EXPLORERS[chainId] ?? "" },
    startedAt: new Date().toISOString(),
    actors: {
      deployer: deployer.address,
      ...Object.fromEntries(CLEARING_MEMBERS.map((n, k) => [n.toLowerCase(), members[k].address])),
      mallory: mallory.address,
    },
  };

  // ═════════════ 0 · deploy, fund gas, give each agent only its net debit in cash ═════════════
  console.log("PHASE 0 · deploy");
  if (chainId === 31337) await (c.pub as any).request({ method: "anvil_setBalance", params: [deployer.address, "0x16345785D8A0000"] }); // dev chain: 0.1 ETH
  const d1 = await c.deploy(deployer, TestUSDAbi as any, TestUSDBytecode as Hex);
  ev.tx("K1", { phase: "deploy", title: "Deploy the clearing run's TestUSD (valueless; minter = this run's deployer)", narrative: "A separate instance so the run can give each agent exactly the cash it holds in the scenario.", actor: "Deployer", outcomes: ["O4"] }, d1);
  const d2 = await c.deploy(deployer, QEDClearingAbi as any, QEDClearingBytecode as Hex, [d1.address]);
  ev.tx("K2", { phase: "deploy", title: "Deploy QEDClearing (proof-gated multilateral netting)", narrative: "Executes a netting only if net positions are unchanged, nothing is created, and an LP-duality certificate proves no larger netting exists.", actor: "Deployer", outcomes: ["O3", "O4"] }, d2);
  const token = d1.address;
  const clr = d2.address;
  ev.meta.contracts = { token, clearing: clr, deployBlock: d1.blockNumber.toString() };
  for (const a of [...members, mallory]) await c.send(deployer, a.address, "0x", { value: parseEther("0.003") });

  const obs0: Obligation[] = CLEARING_OBLIGATIONS.map((o, i) => ({ id: BigInt(i + 1), debtor: o.debtor, creditor: o.creditor, amount: BigInt(o.tusd) * USD }));
  const pos0 = netPositions(5, obs0);
  for (let k = 0; k < 5; k++) if (pos0[k] < 0n) await c.send(deployer, token, fn(TestUSDAbi, "mint", [members[k].address, -pos0[k]]));
  const cash = pos0.reduce((s, p) => s + (p < 0n ? -p : 0n), 0n);
  const gross = obs0.reduce((s, o) => s + o.amount, 0n);
  console.log(`  agents hold ${fmtUsd(cash)} tUSD in total against ${fmtUsd(gross)} tUSD of gross debt`);

  // ═════════════ 1 · the agents join (explicit consent) and record their debts ═════════════
  console.log("\nPHASE 1 · five AI businesses join and record what they owe each other");
  for (let k = 0; k < 5; k++) {
    ev.tx(`J${k + 1}`, { phase: "setup", title: `${CLEARING_MEMBERS[k]} joins the clearing house`, narrative: "Joining is on-chain consent to the TERMS: any netting that leaves my net position unchanged, creates no new claim, and is proven maximal.", actor: CLEARING_MEMBERS[k], outcomes: ["O4"] }, await c.send(members[k], clr, fn(QEDClearingAbi, "join")));
  }
  const due = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
  for (let i = 0; i < CLEARING_OBLIGATIONS.length; i++) {
    const o = CLEARING_OBLIGATIONS[i];
    ev.tx(`I${i + 1}`, { phase: "setup", title: `${CLEARING_MEMBERS[o.debtor]} owes ${CLEARING_MEMBERS[o.creditor]} ${o.tusd} tUSD (${o.memo})`, narrative: "Recorded by the debtor's own key: nobody can create a debt for someone else.", actor: CLEARING_MEMBERS[o.debtor], outcomes: ["O4"] }, await c.send(members[o.debtor], clr, fn(QEDClearingAbi, "issue", [members[o.creditor].address, BigInt(o.tusd) * USD, due, keccak256(toHex(o.memo))])));
  }
  for (let k = 0; k < 5; k++) if (pos0[k] < 0n) await c.send(members[k], token, fn(TestUSDAbi, "approve", [clr, 2n ** 255n]));

  // ═════════════ 2 · gridlock ═════════════
  console.log("\nPHASE 2 · gridlock");
  ev.tx("G1", { phase: "gridlock", title: "Gridlock: Northwind tries to pay its 40 tUSD debt gross, but holds 18", narrative: "With 200 tUSD of debt and 28 tUSD of cash between them, the five agents cannot settle gross. Every one of them is solvent on a net basis.", actor: "Northwind", outcomes: ["O4"], expect: "revert" }, await c.sendExpectingRevert(members[0], clr, fn(QEDClearingAbi, "pay", [1n])));

  // ═════════════ 3 · the QED agent reads the chain and proves the maximal netting ═════════════
  console.log("\nPHASE 3 · the QED agent computes the maximal netting from on-chain state");
  const [ids, rows] = (await c.pub.readContract({ address: clr, abi: QEDClearingAbi, functionName: "openObligations" })) as any;
  const memberList = (await c.pub.readContract({ address: clr, abi: QEDClearingAbi, functionName: "allMembers" })) as Address[];
  const idx = (a: Address) => memberList.findIndex((m) => m.toLowerCase() === a.toLowerCase());
  const obs: Obligation[] = (ids as bigint[]).map((id, i) => ({ id, debtor: idx(rows[i].debtor), creditor: idx(rows[i].creditor), amount: BigInt(rows[i].amount) }));
  const t0 = performance.now();
  const proof = solveNetting(memberList.length, obs);
  const solveMs = performance.now() - t0;
  const report = checkNetting(memberList.length, obs, proof);
  if (!report.ok) throw new Error(`certificate failed locally: ${report.violations}`);
  const greedy = greedyNetting(memberList.length, obs);
  const greedyCleared = greedy.reduce((s, v) => s + v, 0n);
  const amounts = obs.map((o) => o.amount);
  const idList = obs.map((o) => o.id);
  const netting = (x: bigint[], potential = proof.potential, y = proof.y, ids_ = idList, am = amounts) => fn(QEDClearingAbi, "net", [{ ids: ids_, amounts: am, x, potential, y }]);
  ev.offchain("P0", {
    phase: "proof",
    title: `QED agent proves the maximal netting: ${fmtUsd(proof.cleared)} of ${fmtUsd(gross)} tUSD can be cancelled`,
    narrative: `Minimum-mean cycle cancelling (Goldberg–Tarjan, Karp) in ${solveMs.toFixed(1)} ms; dual certificate from residual shortest paths: Σx = ${fmtUsd(proof.cleared)} = Σd·y = ${fmtUsd(proof.bound)}. A naive shortest-cycle-first netting reaches only ${fmtUsd(greedyCleared)}.`,
    actor: "QED agent",
    actorAddress: prover.address,
    outcomes: ["O4"],
  });
  writeFileSync(`${OUT}/proof.json`, JSON.stringify({ members: CLEARING_MEMBERS, memberAddresses: memberList, obligations: obs.map((o, i) => ({ id: o.id.toString(), debtor: CLEARING_MEMBERS[o.debtor], creditor: CLEARING_MEMBERS[o.creditor], amount: o.amount.toString(), memo: CLEARING_OBLIGATIONS[i].memo, cancelled: proof.x[i].toString(), remaining: (o.amount - proof.x[i]).toString(), y: proof.y[i].toString(), greedyCancelled: greedy[i].toString() })), potential: proof.potential.map(String), cleared: proof.cleared.toString(), bound: proof.bound.toString(), greedyCleared: greedyCleared.toString(), gross: gross.toString(), cash: cash.toString(), solveMs }, null, 2));

  // ═════════════ 4 · lazy and dishonest nettings are refused ═════════════
  console.log("\nPHASE 4 · a rival clearing bot and Mallory submit nettings first");
  const atk = (id: string, title: string, a: { class: string; threat: string; defence: string }, data: Hex) =>
    c.sendExpectingRevert(mallory, clr, data, 900_000n).then((r) => ev.tx(id, { phase: "clearing-attack", title, narrative: `${a.threat} → ${a.defence}`, actor: "Mallory / rival clearing bot", outcomes: ["O3", "O4"], attack: { ...a, layer: "QEDClearing" }, expect: "revert" }, r));
  await atk("N1", `Lazy netting (shortest cycles first): cancels ${fmtUsd(greedyCleared)}, not ${fmtUsd(proof.cleared)}`, { class: "fake_work", threat: "A conservation-valid but suboptimal netting leaves avoidable debt", defence: "Dual bound exceeds the amount cleared: NotProvablyMaximal" }, netting(greedy));
  const shifted = [...proof.x];
  shifted[0] += USD;
  await atk("N2", "Netting that quietly cancels 1 tUSD more of Northwind's debt to QED", { class: "liability_violation", threat: "Move value between members inside a netting", defence: "Every member's net position must be exactly unchanged: NetPositionChanged" }, netting(shifted));
  const over = [...proof.x];
  over[1] = amounts[1] + 1n;
  await atk("N3", "Netting that cancels more than an obligation is worth", { class: "liability_violation", threat: "Erase more debt than exists", defence: "ExceedsObligation" }, netting(over));
  await atk("N4", "Netting over a snapshot that hides one obligation", { class: "signed_terms_tampering", threat: "Prove maximality on a doctored state", defence: "The proof must cover every open obligation: IncompleteSnapshot" }, netting(proof.x.slice(0, -1), proof.potential, proof.y.slice(0, -1), idList.slice(0, -1), amounts.slice(0, -1)));
  const fakeY = [...proof.y];
  const j = fakeY.findIndex((v) => v > 0n);
  fakeY[j] = 0n;
  await atk("N5", "Forged certificate: drop a dual multiplier to fake a smaller bound", { class: "fake_work", threat: "Claim optimality with an invalid proof", defence: "DualInfeasible" }, netting(proof.x, proof.potential, fakeY));

  // ═════════════ 5 · the proof executes ═════════════
  console.log("\nPHASE 5 · the QED agent submits the proven netting");
  const before = (await c.pub.readContract({ address: clr, abi: QEDClearingAbi, functionName: "positions" })) as any;
  const r = await c.send(prover, clr, netting(proof.x));
  ev.tx("N6", { phase: "clearing", title: `Proven-maximal netting executes: ${fmtUsd(proof.cleared)} tUSD of debt cancelled, ${fmtUsd(gross)} → ${fmtUsd(gross - proof.cleared)}`, narrative: "No token moved. Every agent's receivables and payables fell by the same amount; no new claim was created; the contract checked the LP-duality certificate.", actor: "QED agent", outcomes: ["O4"] }, r);
  const after = (await c.pub.readContract({ address: clr, abi: QEDClearingAbi, functionName: "positions" })) as any;
  for (let k = 0; k < 5; k++) {
    const b = BigInt(before[1][k]) - BigInt(before[2][k]);
    const a = BigInt(after[1][k]) - BigInt(after[2][k]);
    if (a !== b) throw new Error("net position changed?!");
  }
  await atk("N7", "Replay the executed netting", { class: "replay", threat: "Apply the same proof twice", defence: "The state changed, so the snapshot no longer matches: IncompleteSnapshot" }, netting(proof.x));

  // ═════════════ 6 · settlement with the cash that exists ═════════════
  console.log("\nPHASE 6 · settle what is left with the 28 tUSD the agents hold");
  const remaining = obs.map((o, i) => o.amount - proof.x[i]);
  const order = settlementOrder(5, obs, remaining);
  let s = 0;
  for (const i of order) {
    const o = obs[i];
    ev.tx(`S${++s}`, { phase: "settlement", title: `${CLEARING_MEMBERS[o.debtor]} pays ${CLEARING_MEMBERS[o.creditor]} the remaining ${fmtUsd(remaining[i])} tUSD`, narrative: "Paid in an order where every payer has first been paid; each agent needs only its net debit in cash.", actor: CLEARING_MEMBERS[o.debtor], outcomes: ["O4"] }, await c.send(members[o.debtor], clr, fn(QEDClearingAbi, "pay", [o.id])));
  }

  const open = (await c.pub.readContract({ address: clr, abi: QEDClearingAbi, functionName: "openCount" })) as bigint;
  const balances = await Promise.all(members.map((m) => c.pub.readContract({ address: token, abi: TestUSDAbi, functionName: "balanceOf", args: [m.address] }) as Promise<bigint>));
  ev.meta.final = {
    gross: gross.toString(),
    cash: cash.toString(),
    cleared: proof.cleared.toString(),
    greedyCleared: greedyCleared.toString(),
    settledWithTokens: remaining.reduce((a, b) => a + b, 0n).toString(),
    openObligations: open.toString(),
    balances: Object.fromEntries(CLEARING_MEMBERS.map((n, k) => [n, balances[k].toString()])),
    netPositions: Object.fromEntries(CLEARING_MEMBERS.map((n, k) => [n, pos0[k].toString()])),
  };
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. ${fmtUsd(gross)} tUSD of debt cleared: ${fmtUsd(proof.cleared)} by proof-gated netting, ${fmtUsd(gross - proof.cleared)} paid with tokens. Open obligations: ${open}.`);
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
