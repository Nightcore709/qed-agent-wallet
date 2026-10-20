/**
 * The standing-policy phases of Run 4c, shared by the Sepolia replica run (execute-policy.ts) and the local
 * best-execution economy (execute.ts on a local chain), so anyone can exercise the autonomous loop with dev keys.
 *
 *   1. Mallory unwinds her failed front-run (sells back, on each venue, the tEUR she bought there).
 *   2. The owner signs a standing treasury policy once.
 *   3. An over-eager agent asks for more than the policy allows; the co-signer re-derives and refuses.
 *   4. Each tick the agent observes, decides, gets the same decision re-derived and certified, trades with best
 *      execution proved on-chain, and re-reads the reserve; it stops when the target is met.
 */
import { writeFileSync } from "node:fs";
import { getAddress, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { CPMMPoolAbi, QEDExecutionAbi, QEDTreasuryPolicyAbi, QEDTreasuryPolicyBytecode, QEDVaultAbi, TestTokenAbi } from "../src/abi/contracts.js";
import { fn, type Chain$ } from "../src/chain.js";
import type { Evidence } from "../src/evidence.js";
import { amountOut as v2Out } from "../src/engine/execution.js";
import { POLICY } from "../src/engine/economics.js";
import type { PolicyEngine } from "../src/roles/cosigner.js";
import { decide, hashOrder, hopsForChain, planTrade, pricesForChain, readVenues } from "../src/roles/trader.js";
import { mandateHash, signCertificate, type Certificate } from "../src/protocol/eip712.js";
import { decideTranche, observeTreasury, policyMessage, type TreasuryPolicy } from "../src/roles/treasury.js";
import { hashRecord } from "../src/protocol/records.js";

export interface PolicyContext {
  c: Chain$;
  ev: Evidence;
  K: { OWNER: LocalAccount; OPERATOR: LocalAccount; COSIGNER: LocalAccount; MALLORY: LocalAccount };
  k: { usd: Address; eur: Address; pools: Address[]; vault: Address; reserve: Address; execution: Address };
  cosigner: PolicyEngine;
  mandate: any;
  ownerSig: Hex;
  out: string;
  chainId: number;
  /** [venue index, tEUR to sell back] for each leg of Mallory's front-run */
  unwind: [number, bigint][];
}

export async function runPolicyPhases(x: PolicyContext) {
  const { c, ev, K, k, cosigner, mandate, ownerSig, chainId } = x;
  const OUT = x.out;
  const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const ticks: any[] = [];
  // ── Mallory unwinds the failed front-run: the market returns to fee-consistent prices ──
  console.log("· Mallory unwinds her front-run");
  const legs = x.unwind.filter(([, amt]) => amt > 0n);
  for (const [i, [vi, amt]] of legs.entries()) {
    const v = (await readVenues(c.pub, k.execution))[vi];
    const z = getAddress(v.token0) === getAddress(k.eur);
    const out = v2Out(amt, z ? v.r0 : v.r1, z ? v.r1 : v.r0, v.feeBps);
    ev.tx(`MU${2 * i + 1}`, { phase: "market", title: `Mallory unwinds: returns ${fmt(amt)} tEUR to venue ${vi}`, narrative: "Her front-run failed (EA8); holding tEUR bought at a bad price, she sells it back.", actor: "Mallory", outcomes: ["O3"] }, await c.send(K.MALLORY, k.eur, fn(TestTokenAbi, "transfer", [k.pools[vi], amt])));
    ev.tx(`MU${2 * i + 2}`, { phase: "market", title: `…and takes ${fmt(out)} tUSD back out of venue ${vi}`, narrative: "Round trip complete; the fees stay with the venue.", actor: "Mallory", outcomes: ["O3"] }, await c.send(K.MALLORY, k.pools[vi], fn(CPMMPoolAbi, "swap", [z ? 0n : out, z ? out : 0n, K.MALLORY.address, "0x"])));
  }

  // ── the owner's standing policy ──
  console.log("\n· the owner signs a standing policy; the agent acts on it");
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const policy: TreasuryPolicy = {
    vault: k.vault,
    reserve: k.reserve,
    tokenIn: k.usd,
    tokenOut: k.eur,
    targetFree: BigInt(process.env.POLICY_TARGET ?? 45_000_000),
    maxTranche: 25_000_000n,
    minTranche: 2_000_000n,
    maxImpactBps: Number(process.env.POLICY_IMPACT_BPS ?? 150),
    validUntil: now + 30n * 86_400n,
    nonce: `policy-1-${chainId}`,
  };
  const policySig = await K.OWNER.signMessage({ message: policyMessage(policy) });
  const pPath = `${OUT}/records/P0-policy.json`;
  writeFileSync(pPath, JSON.stringify({ message: policyMessage(policy), signature: policySig, signer: K.OWNER.address }, null, 2));
  ev.offchain("P0", { phase: "policy", title: `Owner signs a standing policy: keep ≥ ${fmt(policy.targetFree)} tEUR free in the euro reserve; tranches of ${fmt(policy.minTranche)}–${fmt(policy.maxTranche)} tUSD; ≤ ${policy.maxImpactBps / 100}% execution cost`, narrative: "Signed once (EIP-191). From here the agent decides when and how much; the owner does not approve individual trades. The vault's mandate still caps every payment.", actor: "Owner", actorAddress: K.OWNER.address, outcomes: ["O1"], artifacts: [{ label: "signed policy", path: pPath, hash: hashRecord({ message: policyMessage(policy), signature: policySig }) }] });


  // a compromised or over-eager agent asks for more than the policy allows: the co-signer re-derives and refuses
  {
    const view = await observeTreasury(c.pub, policy, k.execution, POLICY.reserveBuffer);
    const d = decideTranche(view.venues, policy, view.reserveFree, view.available, mandate.maxPerPayment);
    const greedy = policy.maxTranche;
    const r = await cosigner.evaluateTrade({ mandate, ownerSig, module: k.execution, tokenIn: k.usd, tokenOut: k.eur, recipient: k.reserve, amountIn: greedy, instruction: "policy tick 0 (over-eager agent)", nonce: `${policy.nonce}:tick-0`, policy, policySig, brainEngine: "deterministic policy" });
    ev.offchain("PA1", { phase: "policy", title: `An over-eager agent asks to convert ${fmt(greedy)} tUSD at once; the co-signer re-derives ${fmt(d.amountIn)} and refuses`, narrative: `${r.reasons.join("; ") || "approved"}. Discretion under a policy is bounded twice: by the co-signer's recomputation and by the vault's mandate.`, actor: "Co-signer", actorAddress: K.COSIGNER.address, outcomes: ["O1", "O3"], artifacts: [{ label: "co-signer decision record", path: r.recordPath, hash: r.evidenceHash }] });
    if (r.approved) throw new Error("PA1: the co-signer should have refused the over-sized tranche");
  }

  for (let t = 1; t <= 4; t++) {
    const view = await observeTreasury(c.pub, policy, k.execution, POLICY.reserveBuffer);
    const d = decideTranche(view.venues, policy, view.reserveFree, view.available, mandate.maxPerPayment);
    const dPath = `${OUT}/records/T${t}-decision.json`;
    const rec = { tick: t, reserveFree: view.reserveFree, available: view.available, decision: d };
    writeFileSync(dPath, JSON.stringify(rec, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    ticks.push({ tick: t, reserveFree: view.reserveFree.toString(), shortfall: d.shortfall.toString(), action: d.action, amountIn: d.amountIn.toString(), limitedBy: d.limitedBy ?? null, impactBps: d.impactBps, candidates: Object.fromEntries(Object.entries(d.candidates).map(([a, b]) => [a, b === null ? null : b.toString()])) });
    const title =
      d.action === "convert"
        ? `Agent observes ${fmt(view.reserveFree)} tEUR free (short ${fmt(d.shortfall)}) and decides to convert ${fmt(d.amountIn)} tUSD now — limited by ${d.limitedBy}`
        : d.action === "none"
          ? `Agent observes ${fmt(view.reserveFree)} tEUR free: target met, nothing to do`
          : `Agent observes a ${fmt(d.shortfall)} tEUR shortfall but waits: ${d.reason.replace(/^wait: /, "")}`;
    ev.offchain(`T${t}`, { phase: "policy", title, narrative: d.action === "none" ? "Shortfall 0: the reserve is at its target, so the agent sends nothing and spends no gas." : `Candidates (tUSD): need ${d.candidates.need === null ? "more than any allowed tranche" : fmt(d.candidates.need)}, impact limit ${fmt(d.candidates.impact)}, policy cap ${fmt(d.candidates.policyCap)}, mandate cap ${fmt(d.candidates.mandateCap)}, free funds ${fmt(d.candidates.freeFunds)}. ${d.action === "convert" ? `Expected ${fmt(d.expectedOut)} tEUR at ${d.impactBps.toFixed(1)} bps execution cost.` : ""}`, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O1"], artifacts: [{ label: "decision", path: dPath, hash: hashRecord(rec) }] });
    if (d.action !== "convert") break;

    const r = await cosigner.evaluateTrade({ mandate, ownerSig, module: k.execution, tokenIn: k.usd, tokenOut: k.eur, recipient: k.reserve, amountIn: d.amountIn, instruction: `policy tick ${t}`, nonce: `${policy.nonce}:tick-${t}`, policy, policySig, brainEngine: "deterministic policy" });
    if (!r.approved) throw new Error(`T${t}: co-signer refused: ${r.reasons.join("; ")}`);
    ev.offchain(`C${t}`, { phase: "policy", title: `Co-signer re-derives the same decision from the chain and signs the order (floor ${fmt(r.order!.minOut)} tEUR, τ = ${r.order!.tolerancePpm} ppm)`, narrative: `${r.checks.length} checks, including P1–P3: shortfall, tranche no larger than its own decision, execution cost within the limit.`, actor: "Co-signer", actorAddress: K.COSIGNER.address, outcomes: ["O1"], artifacts: [{ label: "co-signer decision record", path: r.recordPath, hash: r.evidenceHash }] });
    const tp = await planTrade(c.pub, k.execution, k.usd, k.eur, d.amountIn);
    const go = decide(tp, r.order!);
    if (!go.submit) throw new Error(`T${t}: ${go.reasons.join("; ")}`);
    const before = view.reserveFree;
    const tx = await c.send(K.OPERATOR, k.execution, fn(QEDExecutionAbi, "trade", [mandate, ownerSig, r.certificate, r.signature, r.order, hopsForChain(tp.plan.route), pricesForChain(tp.plan.prices)]));
    const be = tx.events.find((e) => e.name === "BestExecution")!.args as any;
    const after = (await c.pub.readContract({ address: k.reserve, abi: QEDVaultAbi, functionName: "freeBalance" })) as bigint;
    if (after - before !== BigInt(be.amountOut)) throw new Error(`T${t}: reserve moved by ${after - before}, expected ${be.amountOut}`);
    ev.tx(`PE${t}`, { phase: "policy", title: `Agent converts ${fmt(d.amountIn)} tUSD → ${fmt(BigInt(be.amountOut))} tEUR; bound ${fmt(BigInt(be.bound))}; reserve free ${fmt(before)} → ${fmt(after)}`, narrative: `Agent-initiated under the standing policy, executed with best execution proved on-chain (${(((Number(be.bound) - Number(be.amountOut)) / Number(be.bound)) * 1e6).toFixed(2)} ppm from the bound). The agent then re-reads the reserve to confirm the state change.`, actor: "QED agent (operator key)", outcomes: ["O1", "O2"] }, tx);
  }

  return { policy, ticks };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Run 4d — the same policy as a contract (QEDTreasuryPolicy), with attacks signed by stolen agent and co-signer keys.
// Shared by execute-policy-chain.ts (Sepolia replica) and the local economy (execute.ts on a local chain).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PolicyContractContext {
  c: Chain$;
  ev: Evidence;
  K: { DEPLOYER: LocalAccount; OWNER: LocalAccount; OPERATOR: LocalAccount; COSIGNER: LocalAccount };
  k: { usd: Address; eur: Address; vault: Address; reserve: Address; execution: Address };
  cosigner: PolicyEngine;
  mandate: any;
  ownerSig: Hex;
  out: string;
  chainId: number;
  target?: bigint;
}

export async function runPolicyContractPhases(x: PolicyContractContext) {
  const { c, ev, K, k, cosigner, mandate, ownerSig, chainId } = x;
  const OUT = x.out;
  const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const target = x.target ?? 55_000_000n;
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

  return {
    contracts: { treasuryPolicy: pol.address, deployBlock: pol.blockNumber.toString() },
    policyChain: { policy: { ...onchain, targetFree: String(target), minTranche: String(onchain.minTranche), maxTranche: String(onchain.maxTranche), validUntil: String(onchain.validUntil) }, decision: { reserveFree: String(view.reserveFree), shortfall: String(d.shortfall), amountIn: String(d.amountIn), limitedBy: d.limitedBy, need: String(need), impact: String(d.candidates.impact) }, conversion: { amountOut: String(pc.amountOut), midOut: String(pc.midOut), costBps, freeBefore: String(pc.freeBefore), freeAfter: String(pc.freeAfter), bound: String(be.bound) }, attacks: { overConversion: String(over), maxTranche: String(onchain.maxTranche), afterTarget: String(onchain.minTranche) } },
    after,
  };
}
