/**
 * The best-execution market of the live run (Run 4). Five constant-product venues across three tokens:
 * two direct tUSD/tEUR pools of different depth and fee, a decoy direct pool with a poor price and a
 * 1% fee, and a two-hop path through tETH. Reserves are set so that the optimal route uses the
 * two-hop path — exactly what a single-pair router misses — and so that the simple policies agents
 * use today lose amounts on both sides of a 1% slippage floor.
 *
 * Exchange rates are illustrative: 1 tUSD = 0.92 tEUR, 1 tETH = 3,000 tUSD = 2,760 tEUR.
 */
export type Sym = "tUSD" | "tEUR" | "tETH";
export const DECIMALS: Record<Sym, number> = { tUSD: 6, tEUR: 6, tETH: 18 };

export interface VenueSpec {
  label: string;
  a: Sym;
  ra: number; // whole tokens
  b: Sym;
  rb: number;
  feeBps: number;
}

export const EXEC_VENUES: VenueSpec[] = [
  { label: "tUSD/tEUR · 0.30% · deep", a: "tUSD", ra: 800, b: "tEUR", rb: 736, feeBps: 30 },
  { label: "tUSD/tEUR · 0.05% · thin", a: "tUSD", ra: 250, b: "tEUR", rb: 230.125, feeBps: 5 },
  { label: "tUSD/tETH · 0.30%", a: "tUSD", ra: 600, b: "tETH", rb: 0.2, feeBps: 30 },
  { label: "tETH/tEUR · 0.30%", a: "tETH", ra: 0.3, b: "tEUR", rb: 828.15, feeBps: 30 },
  { label: "tUSD/tEUR · 1.00% · off-market", a: "tUSD", ra: 300, b: "tEUR", rb: 268.5, feeBps: 100 },
];

/** Each trade of the run converts this much of the vault's tUSD. */
export const TRADE_TUSD = 20;
/** The co-signer's market-risk floor: the order's minOut is its own optimal quote less this. */
export const SLIPPAGE_BPS = 100;
/** Best-execution tolerance τ: realised output ≥ (1 − τ)·bound. */
export const TOLERANCE_PPM = 1;

/** Whole-token decimal → raw units, exactly (via the shortest decimal string, never binary rounding). */
export const raw = (sym: Sym, x: number): bigint => {
  const str = x.toString();
  if (/e/i.test(str)) throw new Error(`raw(): use plain decimals, got ${str}`);
  const [i, f = ""] = str.split(".");
  if (f.length > DECIMALS[sym]) throw new Error(`raw(): ${str} has more than ${DECIMALS[sym]} decimals`);
  return BigInt(i + f.padEnd(DECIMALS[sym], "0"));
};
