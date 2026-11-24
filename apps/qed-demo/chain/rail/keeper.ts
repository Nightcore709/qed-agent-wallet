/**
 * The shared test market's keeper (remedy R2 of experiments/r8/D7-validation for Q-049): a stand-in for the
 * arbitrageurs a real market has.
 *
 * Why. Every workspace converts tINR into tUSD and nothing converts back, so the shared constant-product pools drift
 * one way, and the authority budget's reference band (84 tINR per tUSD ± 0.5%, fixed: rail/host.ts referenceBand) is
 * left behind: measured on this host, 23,139 tINR of net conversions by one household (three days at its daily cap)
 * disable every workspace's conversions, and so do 350 tUSD from the public TestUSD faucet sold by anyone, or 24,000
 * tINR sold by one tenant's owner. Once outside the band nothing brings the pools back: the conversions that would
 * are the ones refused.
 *
 * What. On each heartbeat, under the host's writer (so never between a workspace's quote and its trade), every venue
 * of the test market whose price is more than `thetaBps` from the price it was deployed at is traded back to that
 * price through its own swap, paying its fee, by the keeper's own key. The keeper never resets reserves (no sync, no
 * mint into a pool); when it lacks the token it must sell, the host's test-token minter mints the shortfall to the
 * keeper, and that is recorded with the trade. The decoy venue stays where it was deployed (1% off, its fee 1%).
 *
 * What it does not do. It does not make the reference follow the market: the band stays fixed and two-sided, so if the
 * keeper stops, conversions fail closed exactly as before. A trade between the keeper's transfer and its swap by
 * someone else with access to the chain absorbs the transfer (Uniswap V2 semantics); on the local chain only the host
 * reaches the RPC. On a public chain the reference must come from outside (D8) and real arbitrage replaces the keeper.
 */
import type { Address } from "viem";

export interface KeeperPool { pool: Address; token0: Address; token1: Address; r0: bigint; r1: bigint; feeBps: number; target0: bigint; target1: bigint }
export interface KeeperTrade { pool: Address; tokenIn: Address; amountIn: bigint; amountOut: bigint; deviationBps: number }

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
/** CPMMPool.sol's largest admitted output (Uniswap V2, fee on the input). */
export const cpmmOut = (amountIn: bigint, rIn: bigint, rOut: bigint, feeBps: number) => {
  const w = amountIn * BigInt(10_000 - feeBps);
  return (w * rOut) / (rIn * 10_000n + w);
};
/** How far a pool's price r0/r1 is from its deployed price target0/target1, in basis points (signed). */
export const deviationBps = (p: KeeperPool) => (Number(p.r0 * p.target1) / Number(p.r1 * p.target0) - 1) * 10_000;

/**
 * The trades that bring every pool more than `thetaBps` from its deployed price back to it: sell token1 when token0
 * per token1 is too high, token0 when it is too low, sized on the constant product (r0' r1' = r0 r1 at the target
 * ratio, the input grossed up for the fee). A pool within theta is left alone. Pure: no chain access.
 */
export function keeperTrades(pools: KeeperPool[], thetaBps: number): KeeperTrade[] {
  const out: KeeperTrade[] = [];
  for (const p of pools) {
    const dev = deviationBps(p);
    if (!(Math.abs(dev) > thetaBps)) continue;
    const k = p.r0 * p.r1;
    const sell1 = dev > 0; // token0 per token1 above target: token1 is dear, add token1
    const want = sell1 ? isqrt((k * p.target1) / p.target0) - p.r1 : isqrt((k * p.target0) / p.target1) - p.r0;
    if (want <= 0n) continue;
    const amountIn = (want * 10_000n) / BigInt(10_000 - p.feeBps);
    const amountOut = sell1 ? cpmmOut(amountIn, p.r1, p.r0, p.feeBps) : cpmmOut(amountIn, p.r0, p.r1, p.feeBps);
    if (amountIn > 0n && amountOut > 0n) out.push({ pool: p.pool, tokenIn: sell1 ? p.token1 : p.token0, amountIn, amountOut, deviationBps: dev });
  }
  return out;
}
