/**
 * THE MAKER, trading — how the QED agent converts treasury money with proven best execution.
 *
 *   observe   → the owner's venues and their live reserves, read from QEDExecution and the pools
 *   generate  → candidate routes: the certified optimum and the policies other routers use
 *   evaluate  → exact output of each candidate, simulated with the venues' integer arithmetic
 *   prove     → the dual price vector ν; the on-chain bound B(ν) is pre-flighted with quoteBound
 *   decide    → submit only if the certified route clears the co-signed floor and B within τ
 *   explain   → a decision record listing every alternative and what it would have cost
 *
 * Nothing here is trusted by the chain. A wrong or malicious plan is refused on-chain (NotBestExecution,
 * InsufficientOutput, Leftover, OrderMismatch …); this module exists so an honest agent never sends one.
 */
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { CPMMPoolAbi, QEDExecutionAbi } from "../abi/contracts.js";
import { bestSingleVenue, equalSplitDirect, optimalDirectOnly, simulate, solve, PPM, type Hop, type Plan, type Prices, type VenueState } from "../engine/execution.js";

export interface Order {
  tokenOut: Address;
  recipient: Address;
  minOut: bigint;
  tolerancePpm: number;
  venueSetHash: Hex;
}

export const ORDER_TYPEHASH = keccak256(new TextEncoder().encode("Order(address tokenOut,address recipient,uint256 minOut,uint32 tolerancePpm,bytes32 venueSetHash)"));

/** QEDExecution.hashOrder, off-chain. */
export const hashOrder = (o: Order): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }],
      [ORDER_TYPEHASH, o.tokenOut, o.recipient, o.minOut, o.tolerancePpm, o.venueSetHash],
    ),
  );

export async function readVenues(pub: PublicClient, module: Address, blockNumber?: bigint): Promise<VenueState[]> {
  const vs = (await pub.readContract({ address: module, abi: QEDExecutionAbi, functionName: "venues", blockNumber })) as readonly { pool: Address; token0: Address; token1: Address; feeBps: number }[];
  return Promise.all(
    vs.map(async (v) => {
      const [r0, r1] = (await pub.readContract({ address: v.pool, abi: CPMMPoolAbi, functionName: "getReserves", blockNumber })) as readonly [bigint, bigint, number];
      return { pool: getAddress(v.pool), token0: getAddress(v.token0), token1: getAddress(v.token1), feeBps: Number(v.feeBps), r0, r1 };
    }),
  );
}

export const pricesForChain = (p: Prices) => [...p.entries()].map(([token, value]) => ({ token: getAddress(token), value }));
export const hopsForChain = (r: Hop[]) => r.map((h) => ({ venue: h.venue, zeroForOne: h.zeroForOne, amountIn: h.amountIn }));

export interface Alternative {
  policy: string;
  description: string;
  amountOut: bigint;
  shortfallBps: number; // vs the certified route
  passesFloor?: boolean;
}

export interface TradePlan {
  plan: Plan;
  venues: VenueState[];
  onchainBound: bigint;
  alternatives: Alternative[];
}

/** Plans a conversion and pre-flights its proof against the deployed contract. */
export async function planTrade(pub: PublicClient, module: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<TradePlan> {
  const venues = await readVenues(pub, module);
  const plan = solve(venues, tokenIn, tokenOut, amountIn);
  if (!plan.sim.ok) throw new Error(`planner: the certified route does not execute (${plan.sim.error})`);
  const onchainBound = (await pub.readContract({ address: module, abi: QEDExecutionAbi, functionName: "quoteBound", args: [amountIn, tokenOut, pricesForChain(plan.prices)] })) as bigint;
  if (onchainBound !== plan.bound) throw new Error(`planner: bound replica ${plan.bound} ≠ chain ${onchainBound}`);
  const out = plan.sim.amountOut;
  const alt = (policy: string, description: string, route: Hop[] | null): Alternative | null => {
    if (!route) return null;
    const s = simulate(venues, route, tokenIn, tokenOut, amountIn);
    return { policy, description, amountOut: s.amountOut, shortfallBps: Number(((out - s.amountOut) * 1_000_000n) / out) / 100 };
  };
  const alternatives = [
    { policy: "certified", description: `QED: ${plan.route.length} hops through ${new Set(plan.route.map((h) => h.venue)).size} venues, proven within ${plan.gapPpm.toFixed(3)} ppm of the optimum`, amountOut: out, shortfallBps: 0 },
    alt("direct-optimal", "Optimal split over the direct pools only (a single-pair aggregator)", optimalDirectOnly(venues, tokenIn, tokenOut, amountIn)?.route ?? null),
    alt("equal-split", "Equal split across the direct pools", equalSplitDirect(venues, tokenIn, tokenOut, amountIn)),
    alt("single-venue", "Everything through the best single pool", bestSingleVenue(venues, tokenIn, tokenOut, amountIn)),
  ].filter((a): a is Alternative => a !== null);
  return { plan, venues, onchainBound, alternatives };
}

/** The decision rule the agent applies before it asks anyone to sign anything. */
export function decide(tp: TradePlan, order: Order): { submit: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const out = tp.plan.sim.amountOut;
  if (out < order.minOut) reasons.push(`expected output ${out} is below the co-signed floor ${order.minOut}: market moved — do not trade, re-quote`);
  if (out * PPM < tp.onchainBound * (PPM - BigInt(order.tolerancePpm))) reasons.push(`own proof would fail: output ${out} vs bound ${tp.onchainBound}`);
  return { submit: reasons.length === 0, reasons };
}
