/**
 * Run 4d — the owner's policy becomes a contract. QEDTreasuryPolicy is made QEDExecution's operator, so the agent's
 * hot key can trade only through it, and the chain itself refuses a conversion when the reserve needs nothing, when
 * the tranche is outside the owner's bounds, when it cost more than κ against the mid price, or when it provably
 * converted more than the shortfall required. The attacks below are signed with the co-signer's real key, as if it
 * were stolen too: only the contract stands between them and the treasury.
 *
 *   ANVIL_GENESIS_TS=<before Run 4> KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing \
 *     SCRIPT=agent/scripts/execute-policy-chain.ts SHADOW_OF=11155111 START_STATE='{…}' OUTBOX_SKIP=65 \
 *     OUTBOX_NAME=outbox-11155111-execution-policy-chain EVIDENCE_DIR=evidence/shadow-execution-policy-chain \
 *     npx tsx agent/scripts/local.ts
 *
 * Replica of Sepolia only: it replays Runs 4, 4b and 4c at their original timestamps (their certificates have
 * since expired), then acts at wall-clock time.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionData, getAddress, keccak256, parseTransaction, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QEDExecutionAbi, QEDTreasuryPolicyAbi, QEDTreasuryPolicyBytecode, QEDVaultAbi } from "../src/abi/contracts.js";
import { fn } from "../src/chain.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { POLICY } from "../src/engine/economics.js";
import { rebuildFromOutboxes } from "../src/replica.js";
import { PolicyEngine } from "../src/roles/cosigner.js";
import { decide, hashOrder, hopsForChain, planTrade, pricesForChain } from "../src/roles/trader.js";
import { decideTranche, observeTreasury, policyMessage, type TreasuryPolicy } from "../src/roles/treasury.js";
import { mandateHash, signCertificate, type Certificate } from "../src/protocol/eip712.js";
import { hashRecord } from "../src/protocol/records.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.execution");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const { chainId, rpcUrl } = rpcConfig();
if (chainId !== 11155111 || process.env.SHADOW !== "1") throw new Error("execute-policy-chain.ts runs only on a replica of Sepolia (it replays Runs 4, 4b and 4c)");
const ROLES = ["DEPLOYER", "OWNER", "OPERATOR", "COSIGNER"] as const;
const K = Object.fromEntries(ROLES.map((r) => [r, privateKeyToAccount(process.env[`${r}_PK`] as Hex)])) as Record<(typeof ROLES)[number], LocalAccount>;

const OUT = process.env.EVIDENCE_DIR ?? "evidence/shadow-execution-policy-chain";
mkdirSync(`${OUT}/records`, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8")).contracts;
const RUN4 = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/manifest.json", "utf8"));
const RECEIPTS = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/receipts.json", "utf8"));
const k = RUN4.contracts as { usd: Address; eur: Address; eth: Address; pools: Address[]; vault: Address; reserve: Address; execution: Address; lens: Address };
const fmt = (x: bigint) => (Number(x) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** The mandate and owner signature of Run 4, recovered from E1's signed bytes. */
function run4Mandate(): { mandate: any; ownerSig: Hex } {
  const outbox = JSON.parse(readFileSync("relay/outbox-11155111-execution.json", "utf8"));
  const e1 = RUN4.steps.find((s: any) => s.id === "E1");
  const raw = outbox.find((t: any) => t.hash.toLowerCase() === e1.tx.hash.toLowerCase()).raw as Hex;
  const { args } = decodeFunctionData({ abi: QEDExecutionAbi, data: parseTransaction(raw).data as Hex }) as any;
  return { mandate: args[0], ownerSig: args[1] };
}

async function main() {
  console.log(`\nQED Execute — the policy becomes a contract · replica of ${NETWORK_NAMES[chainId]} via ${rpcUrl}\n`);
  const times = Object.fromEntries(RECEIPTS.transactions.map((r: any) => [r.hash.toLowerCase(), Number(r.timestamp)]));
  const n = await rebuildFromOutboxes(c, MAIN, JSON.parse(process.env.START_STATE ?? "{}"), ["relay/outbox-11155111-execution.json", "relay/outbox-11155111-execution-bounty.json", "relay/outbox-11155111-execution-policy.json"], times);
  console.log(`replayed Runs 4, 4b and 4c at their original timestamps: ${n} signed transactions, identical hashes and statuses`);
  ev.meta = { schema: "qed.evidence/v1", run: "execution-policy-chain", network: { chainId, name: NETWORK_NAMES[chainId], explorer: EXPLORERS[chainId] }, startedAt: new Date().toISOString(), actors: { deployer: K.DEPLOYER.address, owner: K.OWNER.address, operator: K.OPERATOR.address, cosigner: K.COSIGNER.address } };

  const { mandate, ownerSig } = run4Mandate();
  const cosigner = new PolicyEngine(c, K.COSIGNER, { vault: k.vault, lens: k.lens, escrow: getAddress(MAIN.escrow), owner: K.OWNER.address, vendorKeys: {}, catalogPrices: {}, denylist: [], deployBlock: 0n, recordsDir: `${OUT}/records` });
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const target = BigInt(process.env.POLICY_TARGET ?? 55_000_000);
  const onchain = { targetFree: target, minTranche: 2_000_000n, maxTranche: 25_000_000n, maxImpactBps: 150, needSlackBps: 10, validUntil: now + 30n * 86_400n };

  // ── 1 · the policy as a contract ──
  console.log("PHASE 1 · the owner's policy, deployed and wired");
  const pol = await c.deploy(K.DEPLOYER, QEDTreasuryPolicyAbi as any, QEDTreasuryPolicyBytecode as Hex, [k.execution, k.reserve, K.OPERATOR.address]);
  ev.tx("QD1", { phase: "policy-chain", title: "Deploy QEDTreasuryPolicy: the owner's standing policy, enforced by the chain", narrative: "Wraps QEDExecution.trade with four on-chain clauses: a shortfall must exist, the tranche must be within bounds, its execution cost within κ of the direct venues' mid price, and no smaller tranche may provably have covered the shortfall.", actor: "Deployer", outcomes: ["O1", "O3"] }, pol);
  ev.tx("QD2", { phase: "policy-chain", title: `Owner sets the policy on-chain: keep ≥ ${fmt(target)} tEUR free; tranches 2.00–25.00 tUSD; ≤ 1.5% execution cost; at most 0.1% over-conversion`, narrative: "The same objective the co-signer reads from the owner's signed text, now also a contract the agent cannot route around.", actor: "Owner", outcomes: ["O1"] }, await c.send(K.OWNER, pol.address, fn(QEDTreasuryPolicyAbi, "setPolicy", [onchain])));
  ev.tx("QD3", { phase: "policy-chain", title: "Owner makes the policy contract QEDExecution's operator", narrative: "From this transaction on, the AI's hot key can trade only through QEDTreasuryPolicy.convert.", actor: "Owner", outcomes: ["O1", "O3"] }, await c.send(K.OWNER, k.execution, fn(QEDExecutionAbi, "setOperator", [pol.address])));

  // the co-signer keeps reading the owner's signed text (defence in depth)
  const policy: TreasuryPolicy = { vault: k.vault, reserve: k.reserve, tokenIn: k.usd, tokenOut: k.eur, targetFree: target, maxTranche: onchain.maxTranche, minTranche: onchain.minTranche, maxImpactBps: onchain.maxImpactBps, validUntil: onchain.validUntil, nonce: `policy-2-${chainId}` };
  const policySig = await K.OWNER.signMessage({ message: policyMessage(policy) });
  const pPath = `${OUT}/records/QP0-policy.json`;
  writeFileSync(pPath, JSON.stringify({ message: policyMessage(policy), signature: policySig, signer: K.OWNER.address, onchain: { ...onchain, targetFree: String(target), minTranche: String(onchain.minTranche), maxTranche: String(onchain.maxTranche), validUntil: String(onchain.validUntil) } }, null, 2));
  ev.offchain("QP0", { phase: "policy-chain", title: "Owner signs the same policy as text for the co-signer", narrative: "Two independent checkers of one objective: the co-signer before it signs, the contract when the trade executes.", actor: "Owner", actorAddress: K.OWNER.address, outcomes: ["O1"], artifacts: [{ label: "signed policy", path: pPath, hash: hashRecord({ message: policyMessage(policy), signature: policySig }) }] });

  // ── 2 · the agent decides ──
  console.log("\nPHASE 2 · the agent decides, the co-signer agrees");
  const view = await observeTreasury(c.pub, policy, k.execution, POLICY.reserveBuffer);
  const d = decideTranche(view.venues, policy, view.reserveFree, view.available, mandate.maxPerPayment);
  if (d.action !== "convert" || d.candidates.need === null) throw new Error(`expected a need-limited tranche, got ${d.reason}`);
  const dPath = `${OUT}/records/QT1-decision.json`;
  const rec = { reserveFree: view.reserveFree, available: view.available, decision: d };
  writeFileSync(dPath, JSON.stringify(rec, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  ev.offchain("QT1", { phase: "policy-chain", title: `Agent observes ${fmt(view.reserveFree)} tEUR free (short ${fmt(d.shortfall)}) and decides to convert ${fmt(d.amountIn)} tUSD — limited by ${d.limitedBy}`, narrative: `Candidates (tUSD): need ${fmt(d.candidates.need)}, impact limit ${fmt(d.candidates.impact)}, policy cap ${fmt(d.candidates.policyCap)}, mandate cap ${fmt(d.candidates.mandateCap)}, free funds ${fmt(d.candidates.freeFunds)}. Expected ${fmt(d.expectedOut)} tEUR at ${d.impactBps.toFixed(1)} bps.`, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O1"], artifacts: [{ label: "decision", path: dPath, hash: hashRecord(rec) }] });
  const r = await cosigner.evaluateTrade({ mandate, ownerSig, module: k.execution, tokenIn: k.usd, tokenOut: k.eur, recipient: k.reserve, amountIn: d.amountIn, instruction: "policy-chain tick 1", nonce: `${policy.nonce}:tick-1`, policy, policySig, brainEngine: "deterministic policy" });
  if (!r.approved) throw new Error(`co-signer refused: ${r.reasons.join("; ")}`);
  ev.offchain("QC1", { phase: "policy-chain", title: `Co-signer re-derives the same tranche and signs the order (floor ${fmt(r.order!.minOut)} tEUR, τ = ${r.order!.tolerancePpm} ppm)`, narrative: `${r.checks.length} checks, P1–P3 included.`, actor: "Co-signer", actorAddress: K.COSIGNER.address, outcomes: ["O1"], artifacts: [{ label: "co-signer decision record", path: r.recordPath, hash: r.evidenceHash }] });
  const tp = await planTrade(c.pub, k.execution, k.usd, k.eur, d.amountIn);
  if (!decide(tp, r.order!).submit) throw new Error("own plan does not clear the order");
  const tradeArgs = (cert: any, sig: Hex, order: any, plan: typeof tp) => [mandate, ownerSig, cert, sig, order, hopsForChain(plan.plan.route), pricesForChain(plan.plan.prices)] as const;

  // ── 3 · both hot keys stolen: only the contract is left ──
  console.log("\nPHASE 3 · an attacker with the agent key and the co-signer key");
  const atk = (id: string, title: string, threat: string, defence: string, to: Address, data: Hex) =>
    c.sendExpectingRevert(K.OPERATOR, to, data, 3_000_000n).then((tx) => ev.tx(id, { phase: "policy-chain", title, narrative: `${threat} → ${defence}`, actor: "Attacker (agent key + co-signer key)", outcomes: ["O3"], attack: { class: "policy_violation", threat, defence, layer: "QEDTreasuryPolicy" }, expect: "revert" }, tx));
  await atk("QA1", "The agent's key calls QEDExecution.trade directly with the genuine co-signed order", "Skip the policy contract", "QEDExecution's operator is now the policy: NotOperator", k.execution, fn(QEDExecutionAbi, "trade", tradeArgs(r.certificate, r.signature!, r.order, tp)));
  let nonce = 0;
  const stolen = async (amount: bigint) => {
    const plan = await planTrade(c.pub, k.execution, k.usd, k.eur, amount);
    const venueSetHash = (await c.pub.readContract({ address: k.execution, abi: QEDExecutionAbi, functionName: "venueSetHash" })) as Hex;
    const order = { tokenOut: k.eur, recipient: k.reserve, minOut: (plan.plan.sim.amountOut * 99n) / 100n, tolerancePpm: 100, venueSetHash };
    const ts = BigInt((await c.pub.getBlock()).timestamp);
    const cert: Certificate = { mandateHash: mandateHash(mandate), recipient: k.execution, amount, dueAt: 0n, intentId: keccak256(toHex(`stolen-cosigner-key:${++nonce}`)), evidenceHash: keccak256(toHex("no decision record: the co-signer key was stolen")), ref: hashOrder(order), notBefore: ts - 60n, expiresAt: ts + 3600n, epoch: mandate.epoch };
    const sig = await signCertificate(K.COSIGNER, chainId, k.vault, cert);
    return { data: fn(QEDTreasuryPolicyAbi, "convert", tradeArgs(cert, sig, order, plan)), out: plan.plan.sim.amountOut };
  };
  const need = d.candidates.need!;
  const over = need + (need * 25n) / 100n;
  if (over > d.candidates.impact) throw new Error(`no room for an over-conversion within the cost limit (need ${need}, impact ${d.candidates.impact})`);
  const o2 = await stolen(over);
  await atk("QA2", `Convert ${fmt(over)} tUSD when ${fmt(need)} covers the shortfall (best-executed, co-signed with the stolen key)`, "Over-convert: move more treasury money than the objective needs", "Concavity: 99.9% of this tranche provably covers the shortfall: OverConversion", pol.address, o2.data);
  const o3 = await stolen(onchain.maxTranche);
  await atk("QA3", `Convert the maximum tranche, ${fmt(onchain.maxTranche)} tUSD, into the thin market`, "Pay more than the owner's execution-cost limit", "Output below (1 − 150 bps) × the direct venues' mid price: ExecutionCostTooHigh", pol.address, o3.data);

  // ── 4 · the honest tranche, through the policy ──
  console.log("\nPHASE 4 · the honest tranche, through the policy");
  const before = view.reserveFree;
  const tx = await c.send(K.OPERATOR, pol.address, fn(QEDTreasuryPolicyAbi, "convert", tradeArgs(r.certificate, r.signature!, r.order, tp)));
  const pc = tx.events.find((e) => e.name === "PolicyConversion")!.args as any;
  const be = tx.events.find((e) => e.name === "BestExecution")!.args as any;
  const after = (await c.pub.readContract({ address: k.reserve, abi: QEDVaultAbi, functionName: "freeBalance" })) as bigint;
  if (after - before !== BigInt(pc.amountOut)) throw new Error("reserve did not rise by the output");
  const costBps = (1 - Number(pc.amountOut) / Number(pc.midOut)) * 1e4;
  ev.tx("QE1", { phase: "policy-chain", title: `Agent converts ${fmt(d.amountIn)} tUSD → ${fmt(BigInt(pc.amountOut))} tEUR through the policy contract; reserve free ${fmt(before)} → ${fmt(after)}`, narrative: `All four on-chain clauses held: shortfall ${fmt(d.shortfall)}; tranche within 2–25; cost ${costBps.toFixed(1)} bps against mid ≤ 150; no smaller tranche covers the need. Best execution: ${(((Number(be.bound) - Number(be.amountOut)) / Number(be.bound)) * 1e6).toFixed(2)} ppm from the bound.`, actor: "QED agent (operator key)", outcomes: ["O1", "O2"] }, tx);

  // ── 5 · target met: nothing more may move ──
  const view2 = await observeTreasury(c.pub, policy, k.execution, POLICY.reserveBuffer);
  const d2 = decideTranche(view2.venues, policy, view2.reserveFree, view2.available, mandate.maxPerPayment);
  ev.offchain("QT2", { phase: "policy-chain", title: `Agent observes ${fmt(view2.reserveFree)} tEUR free: target met, nothing to do`, narrative: d2.reason, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O1"] });
  const o4 = await stolen(onchain.minTranche);
  await atk("QA4", `With the target met, convert another ${fmt(onchain.minTranche)} tUSD anyway`, "Keep draining the treasury into the reserve", "The reserve already meets its target: NoShortfall", pol.address, o4.data);

  ev.meta.contracts = { treasuryPolicy: pol.address, execution: k.execution, reserve: k.reserve, deployBlock: pol.blockNumber.toString() };
  ev.meta.policyChain = { policy: { ...onchain, targetFree: String(target), minTranche: String(onchain.minTranche), maxTranche: String(onchain.maxTranche), validUntil: String(onchain.validUntil) }, decision: { reserveFree: String(view.reserveFree), shortfall: String(d.shortfall), amountIn: String(d.amountIn), limitedBy: d.limitedBy, need: String(need), impact: String(d.candidates.impact) }, conversion: { amountOut: String(pc.amountOut), midOut: String(pc.midOut), costBps, freeBefore: String(pc.freeBefore), freeAfter: String(pc.freeAfter), bound: String(be.bound) }, attacks: { overConversion: String(over), maxTranche: String(onchain.maxTranche), afterTarget: String(onchain.minTranche) } };
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. reserve free ${fmt(after)} ≥ target ${fmt(target)}; four policy violations refused by the contract.`);
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
