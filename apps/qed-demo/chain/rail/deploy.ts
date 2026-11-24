/**
 * Deployments from the release's embedded bytecode (unmodified contracts).
 *
 *   deployReleaseSandbox  the release's sandbox deployment, in the release's order, minus the two owner transactions
 *                         (setAgent, setVenues: the owner's `provision`). With the development keys it gives the
 *                         release sandbox's exact addresses (baseline parity); with random keys it seeds an ephemeral
 *                         chain for one Security Lab or scenario run.
 *   deployMarket          the multi-tenant host's shared test market, deployed once: the release's test tokens and
 *                         five pools, tINR (the release's TestToken with 2 decimals, matching paise) and its pools,
 *                         ProofEscrow, QEDClearing, the minimum-variance verifier and the two proof bounties.
 *
 * Every amount is a valueless test token on a local chain. Pool reserves are synthetic test liquidity: their ratios
 * are not market prices and are not taken from any observation.
 */
import { getAddress, parseEther, toHex, type Address, type Hex, type LocalAccount } from "viem";
import type { Vendored } from "./vendored.ts";
import { CHAIN_TOKENS, poolKey, venuePlan, type AssetSet, type Currency } from "../../shared/chain-assets.ts";

export type Addresses = {
  usd: Address; eur: Address; eth: Address; lens: Address; vault: Address; reserve: Address; exec: Address; pools: Address[]; treasuryPolicy: Address | null; deployBlock: string;
  /** The treasury vault's asset and the reserve vault's asset (tUSD and tEUR in the release's sandbox; tINR and tUSD in a workspace). */
  asset?: Address; reserveAsset?: Address;
  /** The workspace's passkey owner account; null for the release's development owner. */
  ownerAccount?: Address | null;
};
export type SandboxKeys = Record<"DEPLOYER" | "OPERATOR" | "GUARDIAN" | "LP1" | "LP2" | "LP3" | "MALLORY", LocalAccount>;
type Rpc = (method: string, params?: unknown[]) => Promise<unknown>;

/** The release's sandbox, exactly as RailService.deployFresh always deployed it. */
export async function deployReleaseSandbox(c: any, v: Vendored, rpc: Rpc, K: SandboxKeys, owner: Address, cosigner: Address): Promise<Addresses> {
  const A = v.abi;
  const U = (x: number) => v.scenario.raw("tUSD", x);
  for (const r of ["DEPLOYER", "OPERATOR", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY"] as const) await rpc("anvil_setBalance", [K[r].address, toHex(parseEther("10"))]);
  await rpc("anvil_setBalance", [owner, toHex(parseEther("10"))]);
  const dep = async (abi: unknown, bytecode: unknown, args: unknown[] = []) => await c.deploy(K.DEPLOYER, abi, bytecode as Hex, args);
  const usd = getAddress((await dep(A.TestUSDAbi, A.TestUSDBytecode)).address);
  const lens = getAddress((await dep(A.QEDLensAbi, A.QEDLensBytecode)).address);
  const eurD = await dep(A.TestTokenAbi, A.TestTokenBytecode, ["QED Test Euro", "tEUR", 6]);
  const eur = getAddress(eurD.address);
  const eth = getAddress((await dep(A.TestTokenAbi, A.TestTokenBytecode, ["QED Test Ether", "tETH", 18])).address);
  const TOK: Record<string, Address> = { tUSD: usd, tEUR: eur, tETH: eth };
  const pools: Address[] = [];
  for (const s of v.scenario.EXEC_VENUES) pools.push(getAddress((await dep(A.CPMMPoolAbi, A.CPMMPoolBytecode, [TOK[s.a], TOK[s.b], s.feeBps])).address));
  const vault = getAddress((await dep(A.QEDVaultAbi, A.QEDVaultBytecode, [usd, owner, K.OPERATOR.address, cosigner, K.GUARDIAN.address, U(100)])).address);
  const reserve = getAddress((await dep(A.QEDVaultAbi, A.QEDVaultBytecode, [eur, owner, K.OPERATOR.address, cosigner, K.GUARDIAN.address, 0n])).address);
  const exec = getAddress((await dep(A.QEDExecutionAbi, A.QEDExecutionBytecode, [vault, K.OPERATOR.address])).address);
  const fn = v.chain.fn;
  for (const lp of ["LP1", "LP2", "LP3"] as const) await c.send(K[lp], usd, fn(A.TestUSDAbi, "faucet"));
  const usdSource: Record<number, "LP1" | "LP2" | "LP3"> = { 0: "LP1", 1: "LP2", 2: "LP2", 4: "LP3" };
  for (const [i, s] of v.scenario.EXEC_VENUES.entries()) {
    for (const [sym, amt] of [[s.a, s.ra], [s.b, s.rb]] as const) {
      const r = v.scenario.raw(sym, amt);
      if (sym === "tUSD") await c.send(K[usdSource[i]], usd, fn(A.TestUSDAbi, "transfer", [pools[i], r]));
      else await c.send(K.DEPLOYER, TOK[sym], fn(A.TestTokenAbi, "mint", [pools[i], r]));
    }
    await c.send(K.DEPLOYER, pools[i], fn(A.CPMMPoolAbi, "sync"));
  }
  await c.send(K.LP3, usd, fn(A.TestUSDAbi, "transfer", [vault, U(100)]));
  // Deployed last so every address above equals the release sandbox's. Not wired until the owner asks for it.
  const treasuryPolicy = getAddress((await dep(A.QEDTreasuryPolicyAbi, A.QEDTreasuryPolicyBytecode, [exec, reserve, K.OPERATOR.address])).address);
  return { usd, eur, eth, lens, vault, reserve, exec, pools, treasuryPolicy, deployBlock: eurD.blockNumber.toString(), asset: usd, reserveAsset: eur, ownerAccount: null };
}

/**
 * The venues a workspace's execution module may name: four tINR pools and the release's deep tUSD/tEUR pool, so that
 * the best-execution proof ranges over direct routes, a two-hop route through tEUR and an off-market decoy, as the
 * release's five venues do for tUSD → tEUR. Reserves are synthetic, about 84 tINR per tUSD and 91.3 per tEUR, and
 * every pair of venues stays inside the no-arbitrage band their fees allow (the decoy is 1% worse with a 1% fee), so
 * no circular route is profitable at genesis.
 */
export const INR_VENUES = [
  { label: "tINR/tUSD · 0.30% · deep", a: "tINR", b: "tUSD", feeBps: 30, ra: "8400000", rb: "100000" },
  { label: "tINR/tUSD · 0.05% · thin", a: "tINR", b: "tUSD", feeBps: 5, ra: "1260000", rb: "15000" },
  { label: "tINR/tEUR · 0.30%", a: "tINR", b: "tEUR", feeBps: 30, ra: "4565000", rb: "50000" },
  { label: "tUSD/tEUR · 0.30% · deep (the release's pool)", a: "tUSD", b: "tEUR", feeBps: 30, ra: null, rb: null },
  { label: "tINR/tUSD · 1.00% · off-market", a: "tINR", b: "tUSD", feeBps: 100, ra: "420000", rb: "4950" },
] as const;
export const INR_DECIMALS = 2;

export type MarketAddresses = {
  usd: Address; eur: Address; eth: Address; lens: Address; pools: Address[];
  inr: Address;
  /** The five venues of INR_VENUES, in order (index 3 is the release's deep tUSD/tEUR pool, pools[0]). */
  inrPools: Address[];
  escrow: Address; clearing: Address; verifier: Address; optimalityBounty: Address; maximalityBounty: Address;
  deployBlock: string;
};
export type MarketKeys = { deployer: LocalAccount };

/** The shared market, once per host chain. The host's deployer key is the minter of every test token. */
export async function deployMarket(c: any, v: Vendored, rpc: Rpc, K: MarketKeys): Promise<MarketAddresses> {
  const A = v.abi, fn = v.chain.fn, d = K.deployer;
  await rpc("anvil_setBalance", [d.address, toHex(parseEther("1000"))]);
  const dep = async (abi: unknown, bytecode: unknown, args: unknown[] = []) => getAddress((await c.deploy(d, abi, bytecode as Hex, args)).address);
  const usd = await dep(A.TestUSDAbi, A.TestUSDBytecode);
  const lens = await dep(A.QEDLensAbi, A.QEDLensBytecode);
  const eurD = await c.deploy(d, A.TestTokenAbi, A.TestTokenBytecode, ["QED Test Euro", "tEUR", 6]);
  const eur = getAddress(eurD.address);
  const eth = await dep(A.TestTokenAbi, A.TestTokenBytecode, ["QED Test Ether", "tETH", 18]);
  const inr = await dep(A.TestTokenAbi, A.TestTokenBytecode, ["QED Test Rupee", "tINR", INR_DECIMALS]);
  const TOK: Record<string, Address> = { tUSD: usd, tEUR: eur, tETH: eth, tINR: inr };
  const raw = (sym: string, amount: string) => BigInt(amount) * 10n ** BigInt(sym === "tINR" ? INR_DECIMALS : sym === "tETH" ? 18 : 6);
  const mint = (sym: string, to: Address, amount: bigint) => c.send(d, TOK[sym], sym === "tUSD" ? fn(A.TestUSDAbi, "mint", [to, amount]) : fn(A.TestTokenAbi, "mint", [to, amount]));
  // the release's five pools with the release's reserves
  const pools: Address[] = [];
  for (const s of v.scenario.EXEC_VENUES) {
    const pool = await dep(A.CPMMPoolAbi, A.CPMMPoolBytecode, [TOK[s.a], TOK[s.b], s.feeBps]);
    for (const [sym, amt] of [[s.a, s.ra], [s.b, s.rb]] as const) await mint(sym, pool, v.scenario.raw(sym, amt));
    await c.send(d, pool, fn(A.CPMMPoolAbi, "sync"));
    pools.push(pool);
  }
  // tINR's pools; venue 3 is the release's deep tUSD/tEUR pool
  const inrPools: Address[] = [];
  for (const s of INR_VENUES) {
    if (s.ra === null) { inrPools.push(pools[0]); continue; }
    const pool = await dep(A.CPMMPoolAbi, A.CPMMPoolBytecode, [TOK[s.a], TOK[s.b], s.feeBps]);
    await mint(s.a, pool, raw(s.a, s.ra));
    await mint(s.b, pool, raw(s.b, s.rb));
    await c.send(d, pool, fn(A.CPMMPoolAbi, "sync"));
    inrPools.push(pool);
  }
  const escrow = await dep(A.ProofEscrowAbi, A.ProofEscrowBytecode);
  const clearing = await dep(A.QEDClearingAbi, A.QEDClearingBytecode, [inr]);
  const verifier = await dep(A.MinVarianceVerifierAbi, A.MinVarianceVerifierBytecode);
  const optimalityBounty = await dep(A.OptimalityBountyAbi, A.OptimalityBountyBytecode, [verifier, inr]);
  const maximalityBounty = await dep(A.MaximalityBountyAbi, A.MaximalityBountyBytecode, [inr]);
  return { usd, eur, eth, lens, pools, inr, inrPools, escrow, clearing, verifier, optimalityBounty, maximalityBounty, deployBlock: eurD.blockNumber.toString() };
}

/**
 * Money-model S5: what the shared chain holds for the currency sets workspaces chose (shared/chain-assets.ts), beyond the
 * market above. Test tokens by currency (the five added ones; tINR, tUSD and tEUR are the market's) and pools by
 * poolKey, each with the genesis reserves it was seeded with (the keeper's targets). Plain JSON: kept in the host's store.
 */
export type CurrencyMarket = {
  tokens: Partial<Record<Currency, { address: Address; symbol: string; decimals: number }>>;
  pools: Record<string, { address: Address; label: string; feeBps: number; a: Currency; b: Currency; rawA: string; rawB: string }>;
};
export const emptyCurrencyMarket = (): CurrencyMarket => ({ tokens: {}, pools: {} });

/** The address of a currency's test token on the shared chain, or null while it is not deployed. */
export function tokenOf(c: Currency, m: MarketAddresses, cm: CurrencyMarket): Address | null {
  return c === "INR" ? m.inr : c === "USD" ? m.usd : c === "EUR" ? m.eur : cm.tokens[c]?.address ?? null;
}

/**
 * Deploys what `set` needs and the shared chain lacks: the test token of each of its currencies (the release's TestToken,
 * with the currency's decimals, minted only by the host's deployer) and the five pools of venuePlan(set), seeded at the
 * genesis rates. Each is recorded (`save`) as soon as it exists; one recorded but absent from the chain (a chain restored
 * from an earlier state) is deployed again. Runs under the host's writer. Valueless test tokens and synthetic liquidity.
 */
export async function ensureCurrencyMarket(c: any, v: Vendored, rpc: Rpc, K: MarketKeys, m: MarketAddresses, cm: CurrencyMarket, set: AssetSet, save: (cm: CurrencyMarket) => void): Promise<CurrencyMarket> {
  const A = v.abi, fn = v.chain.fn, d = K.deployer;
  const exists = async (address: Address | undefined) => !!address && ((await c.pub.getCode({ address })) ?? "0x") !== "0x";
  if ((await c.pub.getBalance({ address: d.address })) < parseEther("10")) await rpc("anvil_setBalance", [d.address, toHex(parseEther("1000"))]);
  for (const cur of [set.treasury, set.reserve, set.route]) {
    if (cur === "INR" || cur === "USD" || cur === "EUR" || (await exists(cm.tokens[cur]?.address))) continue;
    const t = CHAIN_TOKENS[cur];
    const address = getAddress((await c.deploy(d, A.TestTokenAbi, A.TestTokenBytecode, [t.name, t.symbol, t.decimals])).address);
    cm = { ...cm, tokens: { ...cm.tokens, [cur]: { address, symbol: t.symbol, decimals: t.decimals } } };
    save(cm);
  }
  const mint = (cur: Currency, to: Address, amount: bigint) => { const token = tokenOf(cur, m, cm)!; return c.send(d, token, fn(token === m.usd ? A.TestUSDAbi : A.TestTokenAbi, "mint", [to, amount])); };
  for (const p of venuePlan(set)) {
    const k = poolKey(p);
    if (await exists(cm.pools[k]?.address)) continue;
    const pool = getAddress((await c.deploy(d, A.CPMMPoolAbi, A.CPMMPoolBytecode, [tokenOf(p.a, m, cm), tokenOf(p.b, m, cm), p.feeBps])).address);
    await mint(p.a, pool, p.rawA);
    await mint(p.b, pool, p.rawB);
    await c.send(d, pool, fn(A.CPMMPoolAbi, "sync"));
    cm = { ...cm, pools: { ...cm.pools, [k]: { address: pool, label: p.label, feeBps: p.feeBps, a: p.a, b: p.b, rawA: p.rawA.toString(), rawB: p.rawB.toString() } } };
    save(cm);
  }
  return cm;
}
