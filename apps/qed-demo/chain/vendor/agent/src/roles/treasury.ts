/**
 * THE MAKER, deciding — an owner-signed treasury policy, executed by the agent on its own initiative.
 *
 * The owner states an objective once ("keep at least T of the output token free in the reserve") with the limits
 * of discretion (largest and smallest tranche, the most price impact a tranche may pay). From then on the agent:
 *
 *   observe   the reserve's free balance, the treasury's free balance, every venue's reserves
 *   decide    whether there is a shortfall, and if so how much to convert now:
 *               need    the smallest input X whose certified output covers the shortfall
 *               impact  the largest X whose execution cost stays within the policy's impact limit
 *               caps    the policy's tranche cap, the mandate's per-payment cap, free funds above the buffer
 *             X = min(need, impact, caps); below the minimum tranche it waits
 *   act       through QEDExecution, with best execution proved on-chain
 *
 * Execution cost is measured against the depth-weighted mid price of the direct venues:
 *   impact(X) = 1 − F*(X) / (X · mid),   F*(X) the certified (integer-simulated) output for input X.
 * F* is concave, so impact is non-decreasing in X and both searches are monotone bisections.
 *
 * Nothing here is trusted: the co-signer recomputes the shortfall and the impact before it signs, and the chain
 * proves the quality of whatever is executed.
 */
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { QEDVaultAbi } from "../abi/contracts.js";
import { solve, type VenueState } from "../engine/execution.js";
import { readVenues } from "./trader.js";

export interface TreasuryPolicy {
  vault: Address; //        the treasury that pays (tokenIn)
  reserve: Address; //      the vault to keep funded (tokenOut)
  tokenIn: Address;
  tokenOut: Address;
  targetFree: bigint; //    keep at least this much of tokenOut free (not ring-fenced) in the reserve
  maxTranche: bigint; //    largest single conversion, in tokenIn
  minTranche: bigint; //    smaller tranches are not worth a transaction: wait instead
  maxImpactBps: number; //  most a tranche may pay in execution cost against the mid price
  validUntil: bigint;
  nonce: string;
}

/** The exact text the owner signs (EIP-191). The co-signer recovers the owner from it. */
export const policyMessage = (p: TreasuryPolicy) =>
  [
    "QED treasury policy",
    `vault: ${getAddress(p.vault)}`,
    `reserve: ${getAddress(p.reserve)}`,
    `keep free in reserve at least: ${p.targetFree.toString()} of ${getAddress(p.tokenOut)}`,
    `convert from: ${getAddress(p.tokenIn)}`,
    `tranche: ${p.minTranche.toString()} to ${p.maxTranche.toString()}`,
    `max impact bps: ${p.maxImpactBps}`,
    `valid until: ${p.validUntil.toString()}`,
    `nonce: ${p.nonce}`,
  ].join("\n");

/** Depth-weighted mid price (tokenOut per tokenIn, raw units) of the venues that trade the pair directly. */
export function directMid(venues: VenueState[], tokenIn: Address, tokenOut: Address): number {
  const pair = [tokenIn, tokenOut].map((x) => x.toLowerCase()).sort().join();
  const direct = venues.filter((v) => [v.token0, v.token1].map((x) => x.toLowerCase()).sort().join() === pair);
  const zIn = (v: VenueState) => v.token0.toLowerCase() === tokenIn.toLowerCase();
  const depth = (v: VenueState) => Number(zIn(v) ? v.r0 : v.r1);
  const mid = (v: VenueState) => (zIn(v) ? Number(v.r1) / Number(v.r0) : Number(v.r0) / Number(v.r1));
  const d = direct.reduce((a, v) => a + depth(v), 0);
  return d > 0 ? direct.reduce((a, v) => a + mid(v) * depth(v), 0) / d : 0;
}

export const certifiedOut = (venues: VenueState[], tokenIn: Address, tokenOut: Address, x: bigint): bigint => {
  if (x <= 0n) return 0n;
  const p = solve(venues, tokenIn, tokenOut, x);
  return p.sim.ok ? p.sim.amountOut : 0n;
};

export function impactBps(venues: VenueState[], tokenIn: Address, tokenOut: Address, x: bigint, mid = directMid(venues, tokenIn, tokenOut)): number {
  if (x <= 0n || mid <= 0) return 0;
  return (1 - Number(certifiedOut(venues, tokenIn, tokenOut, x)) / (Number(x) * mid)) * 10_000;
}

/** Largest x in [lo, hi] with pred(x) true, for a predicate that is true then false as x grows. */
function lastTrue(lo: bigint, hi: bigint, pred: (x: bigint) => boolean): bigint {
  if (!pred(lo)) return 0n;
  if (pred(hi)) return hi;
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (pred(m)) lo = m;
    else hi = m;
  }
  return lo;
}

export interface TrancheDecision {
  action: "convert" | "wait" | "none";
  amountIn: bigint;
  expectedOut: bigint;
  impactBps: number;
  limitedBy?: "need" | "impact" | "policy cap" | "mandate cap" | "free funds";
  shortfall: bigint;
  /** need is null when even the largest allowed tranche cannot cover the shortfall */
  candidates: { need: bigint | null; impact: bigint; policyCap: bigint; mandateCap: bigint; freeFunds: bigint };
  mid: number;
  reason: string;
}

/**
 * The tranche rule. Pure: the same inputs give the same decision, so the co-signer can recompute it.
 * `available` is what the treasury may spend now (free balance above its buffer, within the daily window).
 */
export function decideTranche(venues: VenueState[], policy: TreasuryPolicy, reserveFree: bigint, available: bigint, mandateCap: bigint): TrancheDecision {
  const { tokenIn, tokenOut } = policy;
  const shortfall = policy.targetFree > reserveFree ? policy.targetFree - reserveFree : 0n;
  const mid = directMid(venues, tokenIn, tokenOut);
  const base = { shortfall, mid, candidates: { need: null as bigint | null, impact: 0n, policyCap: policy.maxTranche, mandateCap, freeFunds: available } };
  if (shortfall === 0n) return { ...base, action: "none", amountIn: 0n, expectedOut: 0n, impactBps: 0, reason: "reserve is at or above its target: nothing to do" };
  const hardCap = [policy.maxTranche, mandateCap, available].reduce((a, b) => (b < a ? b : a));
  // need: the smallest input whose certified output covers the shortfall (if even the cap cannot, the cap)
  const covers = (x: bigint) => certifiedOut(venues, tokenIn, tokenOut, x) >= shortfall;
  let need: bigint | null = null;
  if (hardCap > 0n && covers(hardCap)) {
    let lo = 0n;
    let hi = hardCap;
    while (hi - lo > 1n) {
      const m = (lo + hi) / 2n;
      if (covers(m)) hi = m;
      else lo = m;
    }
    need = hi;
  }
  // impact: the largest input whose execution cost stays within the policy's limit
  // (searched from the minimum tranche: at a few raw units, integer rounding alone would read as huge "impact")
  const impact = hardCap < policy.minTranche ? 0n : lastTrue(policy.minTranche, hardCap, (x) => impactBps(venues, tokenIn, tokenOut, x, mid) <= policy.maxImpactBps);
  base.candidates.need = need;
  base.candidates.impact = impact;
  const pick: [bigint, TrancheDecision["limitedBy"]][] = [
    ...(need !== null ? [[need, "need"] as [bigint, TrancheDecision["limitedBy"]]] : []),
    [impact, "impact"],
    [policy.maxTranche, "policy cap"],
    [mandateCap, "mandate cap"],
    [available, "free funds"],
  ];
  const [amountIn, limitedBy] = pick.reduce((a, b) => (b[0] < a[0] ? b : a));
  if (amountIn < policy.minTranche) {
    const why = limitedBy === "impact" ? `the market is too thin: any tranche ≥ ${policy.minTranche} would pay more than ${policy.maxImpactBps} bps` : `only ${amountIn} can be converted now (${limitedBy})`;
    return { ...base, action: "wait", amountIn: 0n, expectedOut: 0n, impactBps: 0, limitedBy, reason: `wait: ${why}` };
  }
  const expectedOut = certifiedOut(venues, tokenIn, tokenOut, amountIn);
  const ib = impactBps(venues, tokenIn, tokenOut, amountIn, mid);
  return { ...base, action: "convert", amountIn, expectedOut, impactBps: ib, limitedBy, reason: `convert ${amountIn} now (limited by ${limitedBy}); expected ${expectedOut} at ${ib.toFixed(1)} bps execution cost` };
}

export interface TreasuryView {
  reserveFree: bigint;
  available: bigint;
  venues: VenueState[];
}

/** What the agent (or the co-signer) observes before deciding. */
export async function observeTreasury(pub: PublicClient, policy: TreasuryPolicy, module: Address, buffer: bigint): Promise<TreasuryView> {
  const free = async (v: Address) => (await pub.readContract({ address: v, abi: QEDVaultAbi, functionName: "freeBalance" })) as bigint;
  const [reserveFree, vaultFree, venues] = await Promise.all([free(policy.reserve), free(policy.vault), readVenues(pub, module)]);
  const [cap, spent] = await Promise.all([
    pub.readContract({ address: policy.vault, abi: QEDVaultAbi, functionName: "dailyCap" }) as Promise<bigint>,
    pub.readContract({ address: policy.vault, abi: QEDVaultAbi, functionName: "spentInWindow" }) as Promise<bigint>,
  ]);
  const funds = vaultFree > buffer ? vaultFree - buffer : 0n;
  const window = cap > spent ? cap - spent : 0n;
  return { reserveFree, available: funds < window ? funds : window, venues };
}

export type { Hex };
