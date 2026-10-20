/**
 * Seeded random constant-product markets for tests and benchmarks of best execution.
 *
 * A market has T tokens with "true" prices; each venue quotes the true price perturbed by less than
 * its own fee (so no venue pair offers a fee-free arbitrage loop), with a depth drawn log-uniformly
 * over two orders of magnitude and a fee from the common tiers {1, 5, 30, 100} bps. Token 0 is the
 * input, token 1 the output; tokens 2.. are bridges reachable only through two-hop paths.
 */
import type { Address } from "viem";
import type { VenueState } from "./execution.js";

/** Mulberry32: tiny, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const tokenAddr = (i: number): Address => `0x${(0xa00 + i).toString(16).padStart(40, "0")}` as Address;

export interface Market {
  venues: VenueState[];
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** trade size as a fraction of the input-side depth of the direct venues */
  sizeRatio: number;
  decimals: number[];
}

const FEES = [1, 5, 30, 100];

export function randomMarket(seed: number, opts: { tokens?: number; direct?: number; bridges?: number; sizeRatio?: number } = {}): Market {
  const r = rng(seed);
  const T = opts.tokens ?? 3;
  const decimals = Array.from({ length: T }, (_, i) => (i >= 2 ? 18 : 6)); // bridges: 18 dp, so one raw unit is worth far less than a ppm of any trade
  const price = Array.from({ length: T }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.8 + 0.4 * r() : 10 ** (r() * 4 - 1))); // value in "USD" per whole token
  const venues: VenueState[] = [];
  const add = (a: number, b: number) => {
    const fee = FEES[Math.floor(r() * FEES.length)];
    const depthUsd = 10 ** (2 + 2 * r()); // 100 … 10,000 USD per side
    const skew = 1 + (2 * r() - 1) * (fee / 10_000) * 0.9; // mispricing smaller than the fee
    const ra = depthUsd / price[a];
    const rb = (depthUsd / price[b]) * skew;
    const toRaw = (x: number, d: number) => BigInt(Math.max(1, Math.round(x * 10 ** Math.min(d, 12)))) * 10n ** BigInt(Math.max(0, d - 12));
    const [x, y, rx, ry] = tokenAddr(a) < tokenAddr(b) ? [a, b, ra, rb] : [b, a, rb, ra];
    venues.push({ pool: `0x${(0xb000 + venues.length).toString(16).padStart(40, "0")}` as Address, token0: tokenAddr(x), token1: tokenAddr(y), r0: toRaw(rx, decimals[x]), r1: toRaw(ry, decimals[y]), feeBps: fee });
  };
  const direct = opts.direct ?? 1 + Math.floor(r() * 3);
  for (let i = 0; i < direct; i++) add(0, 1);
  const bridges = opts.bridges ?? (T > 2 ? 1 + Math.floor(r() * 2) : 0);
  for (let k = 2; k < T; k++) for (let i = 0; i < bridges; i++) {
    add(0, k);
    add(k, 1);
  }
  const directDepthUsd = venues.filter((v) => [v.token0, v.token1].includes(tokenAddr(0)) && [v.token0, v.token1].includes(tokenAddr(1))).reduce((s, v) => s + Number(v.token0 === tokenAddr(0) ? v.r0 : v.r1) / 1e6, 0);
  const sizeRatio = opts.sizeRatio ?? 10 ** (-3 + 2.3 * r()); // 0.1% … 20% of direct depth
  const amountIn = BigInt(Math.max(1, Math.round(directDepthUsd * sizeRatio * 1e6)));
  return { venues, tokenIn: tokenAddr(0), tokenOut: tokenAddr(1), amountIn, sizeRatio, decimals };
}
