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
import { getAddress, type Address, type Hex, type LocalAccount } from "viem";
import { CPMMPoolAbi, QEDExecutionAbi, QEDVaultAbi, TestTokenAbi } from "../src/abi/contracts.js";
import { fn, type Chain$ } from "../src/chain.js";
import type { Evidence } from "../src/evidence.js";
import { amountOut as v2Out } from "../src/engine/execution.js";
import { POLICY } from "../src/engine/economics.js";
import type { PolicyEngine } from "../src/roles/cosigner.js";
import { decide, hopsForChain, planTrade, pricesForChain, readVenues } from "../src/roles/trader.js";
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
