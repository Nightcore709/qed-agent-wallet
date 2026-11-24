/**
 * Money-model stage S5: the on-chain wallet's test tokens for the eight currencies the paper bank holds
 * (shared/currency.ts), and a workspace's currency set. Valueless test tokens on a local chain: never money, never a
 * currency balance, never a price.
 *
 * A workspace's currency set names three test tokens: the one its treasury vault holds, the one its reserve vault holds,
 * and the one a conversion may route through (two hops). The default is the set every workspace has had since R7: a tINR
 * treasury, a tUSD reserve, routing through tEUR. Any other set is chosen per workspace at setup, only under the owner's
 * passkey signature over assetSetDocument(...) (chain/rail/host.ts checks it before anything is deployed for the set).
 * Nothing here chooses a set, and no set opens a real-money route (server/legal.ts keeps every one closed).
 *
 * Decimals. The three tokens the shared chain has had keep theirs: tINR 2 (the wallet's, R7), tUSD 6 and tEUR 6 (the
 * release's TestUSD and TestToken "QED Test Euro", kept for parity with the release). The five added here take their
 * currency's minor unit from ISO 4217 List One: tGBP, tAED and tSGD 2, tJPY 0, tBHD 3. This module is read by the chain
 * package too, whose compiler cannot check shared/instrument.ts, so it imports neither that nor shared/currency.ts:
 * shared/chain-assets.test.ts holds its currency list and minor units to theirs.
 *
 * Rates. Each token's genesis rate per tUSD is an illustrative round figure, as the test market's have always been
 * (84 tINR and 0.92 tEUR per tUSD since R7 and the release): synthetic, not an observation, not the paper bank's
 * reference rates (server/fx-rates.ts). They seed the test pools and nothing else.
 *
 * Authority. An amount the operator configures in tINR (a vault's daily cap, the opening grant, the authority budget's
 * base and earned caps, the policy's tranche bounds) is carried into another treasury token at the genesis rates and
 * rounded down (fromInr): choosing a currency never gives more authority, cap or grant than the default, valued at those
 * rates.
 */
import { canonical, sha256 } from './sha256.ts'

/** The paper bank's eight currencies (shared/currency.ts PAPER_CURRENCIES), in its order. */
export const CHAIN_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'] as const
export type Currency = (typeof CHAIN_CURRENCIES)[number]
const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && (CHAIN_CURRENCIES as readonly string[]).includes(c)
/** ISO 4217 List One's minor units of the five currencies added in S5 (held to shared/currency.ts minorUnit by the test). */
const ISO_MINOR: Readonly<Record<'GBP' | 'AED' | 'SGD' | 'JPY' | 'BHD', number>> = { GBP: 2, AED: 2, SGD: 2, JPY: 0, BHD: 3 }

// exact rational arithmetic on bigints (as shared/instrument.ts, which this module may not import)
const pow10 = (e: number): bigint => 10n ** BigInt(e)
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a }
interface Ratio { n: bigint; d: bigint }
const ratio = (n: bigint, d: bigint): Ratio => { const g = gcd(n, d) || 1n; return { n: n / g, d: d / g } }
/** "84", "0.376": a plain non-negative decimal, exactly. */
const parseRatio = (text: string): Ratio => { const m = /^(\d+)(?:\.(\d+))?$/.exec(text); if (!m) throw new RangeError(`not a plain decimal: ${text}`); return ratio(BigInt(m[1]! + (m[2] ?? '')), pow10((m[2] ?? '').length)) }
/** n / d (d > 0, n ≥ 0) rounded down or up. */
const divRound = (n: bigint, d: bigint, mode: 'floor' | 'ceil'): bigint => { const q = n / d; return mode === 'ceil' && q * d !== n ? q + 1n : q }

export interface ChainToken {
  currency: Currency
  symbol: string
  name: string
  decimals: number
  /** The currency's own minor unit (ISO 4217 List One): how many places a person reads, whatever the token's decimals. */
  minor: number
  /** Units of this token per tUSD at the test market's genesis: an illustrative, synthetic figure. */
  perUsd: string
  /** release: the release's own token; wallet: deployed with the shared market since R7; added: deployed for the first workspace that chooses it (S5). */
  origin: 'release' | 'wallet' | 'added'
  one: string
  many: string
  /** How a reserve vault holding it is named ("the dollar reserve"). */
  reserveWords: string
  /** Words a person may use for it in an instruction, lower case. */
  aliases: readonly string[]
}

const added = (currency: keyof typeof ISO_MINOR, symbol: string, name: string, perUsd: string, one: string, many: string, reserveWords: string, aliases: string[]): ChainToken =>
  ({ currency, symbol, name, decimals: ISO_MINOR[currency], minor: ISO_MINOR[currency], perUsd, origin: 'added', one, many, reserveWords, aliases })

export const CHAIN_TOKENS: Readonly<Record<Currency, ChainToken>> = Object.freeze({
  INR: { currency: 'INR', symbol: 'tINR', name: 'QED Test Rupee', decimals: 2, minor: 2, perUsd: '84', origin: 'wallet', one: 'test rupee', many: 'test rupees', reserveWords: 'rupee reserve', aliases: ['rupee', 'rupees', 'inr', 'tinr'] },
  USD: { currency: 'USD', symbol: 'tUSD', name: 'TestUSD', decimals: 6, minor: 2, perUsd: '1', origin: 'release', one: 'test dollar', many: 'test dollars', reserveWords: 'dollar reserve', aliases: ['dollar', 'dollars', 'usd', 'tusd'] },
  EUR: { currency: 'EUR', symbol: 'tEUR', name: 'QED Test Euro', decimals: 6, minor: 2, perUsd: '0.92', origin: 'release', one: 'test euro', many: 'test euros', reserveWords: 'euro reserve', aliases: ['euro', 'euros', 'eur', 'teur'] },
  GBP: added('GBP', 'tGBP', 'QED Test Pound', '0.79', 'test pound', 'test pounds', 'pound reserve', ['pound', 'pounds', 'sterling', 'gbp', 'tgbp']),
  AED: added('AED', 'tAED', 'QED Test Dirham', '3.67', 'test dirham', 'test dirhams', 'dirham reserve', ['dirham', 'dirhams', 'aed', 'taed']),
  SGD: added('SGD', 'tSGD', 'QED Test Singapore Dollar', '1.30', 'test Singapore dollar', 'test Singapore dollars', 'Singapore dollar reserve', ['singapore dollar', 'singapore dollars', 'sgd', 'tsgd']),
  JPY: added('JPY', 'tJPY', 'QED Test Yen', '150', 'test yen', 'test yen', 'yen reserve', ['yen', 'jpy', 'tjpy']),
  BHD: added('BHD', 'tBHD', 'QED Test Dinar', '0.376', 'test dinar', 'test dinars', 'dinar reserve', ['dinar', 'dinars', 'bhd', 'tbhd']),
})

export interface TokenWords { symbol: string; decimals: number; currency: Currency | null; minor: number; one: string; many: string; reserveWords: string | null }
/** The release's tETH: a venue token of its own market, never a workspace's currency (read to two places, as before). */
const TETH: TokenWords = { symbol: 'tETH', decimals: 18, currency: null, minor: 2, one: 'test ether', many: 'test ether', reserveWords: null }
const BY_SYMBOL = new Map<string, TokenWords>([...Object.values(CHAIN_TOKENS).map((t): [string, TokenWords] => [t.symbol, { symbol: t.symbol, decimals: t.decimals, currency: t.currency, minor: t.minor, one: t.one, many: t.many, reserveWords: t.reserveWords }]), ['tETH', TETH]])
/** Any test token of the shared chain by its symbol, for display; null for one this build does not know. */
export const tokenBySymbol = (symbol: string): TokenWords | null => BY_SYMBOL.get(symbol) ?? null
export const TEST_TOKEN_SYMBOLS: readonly string[] = [...BY_SYMBOL.keys()]

// ───────────────────────────────────────────────────────────── a workspace's currency set

export interface AssetSet { treasury: Currency; reserve: Currency; route: Currency }
export const DEFAULT_ASSET_SET: Readonly<AssetSet> = Object.freeze({ treasury: 'INR', reserve: 'USD', route: 'EUR' })
export const sameSet = (a: AssetSet, b: AssetSet): boolean => a.treasury === b.treasury && a.reserve === b.reserve && a.route === b.route
/** True for no set at all (every workspace created before S5) and for the default spelt out. */
export const isDefaultSet = (s: AssetSet | null | undefined): boolean => !s || sameSet(s, DEFAULT_ASSET_SET)
/** "EUR-JPY-BHD": the key a set's pools are recorded under. */
export const setKey = (s: AssetSet): string => `${s.treasury}-${s.reserve}-${s.route}`

export class AssetSetError extends Error {
  readonly code = 'invalid_currencies'
  constructor(message: string) { super(message); this.name = 'AssetSetError' }
}

/** { treasury, reserve, route }: three different currencies of the eight, and nothing else. */
export function checkAssetSet(x: unknown): AssetSet {
  const bad = (m: string) => new AssetSetError(m)
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad('currencies is { treasury, reserve, route }: three different currencies of the eight the paper bank holds.')
  const o = x as Record<string, unknown>
  if (Object.keys(o).some((k) => !['treasury', 'reserve', 'route'].includes(k))) throw bad('currencies takes treasury, reserve and route, and nothing else.')
  for (const k of ['treasury', 'reserve', 'route'] as const) if (!isCurrency(o[k])) throw bad(`currencies.${k} must be one of ${CHAIN_CURRENCIES.join(', ')}.`)
  const s = { treasury: o.treasury as Currency, reserve: o.reserve as Currency, route: o.route as Currency }
  if (new Set([s.treasury, s.reserve, s.route]).size !== 3) throw bad('The treasury, the reserve and the route take three different currencies.')
  return s
}

// ───────────────────────────────────────────────────────────── exact arithmetic between test tokens

/** What arithmetic needs of a token: its decimals and its genesis rate per tUSD. */
export interface TokenRate { decimals: number; perUsd: string }

/**
 * Base units of `to` worth `raw` base units of `from` at the genesis rates, rounded by `mode` (floor: never more than it
 * is worth). Exact for any size and any decimals from 0 to 77.
 */
export function convertRaw(raw: bigint, from: TokenRate, to: TokenRate, mode: 'floor' | 'ceil'): bigint {
  const f = parseRatio(from.perUsd), t = parseRatio(to.perUsd)
  if (f.n <= 0n || t.n <= 0n) throw new RangeError('a genesis rate is positive')
  // raw / 10^dF tokens of `from` are raw / (10^dF · perUsd(from)) tUSD, which is that · perUsd(to) · 10^dT base units of `to`
  return divRound(raw * t.n * f.d * pow10(to.decimals), t.d * f.n * pow10(from.decimals), mode)
}
export const convertAtGenesis = (raw: bigint, from: Currency, to: Currency, mode: 'floor' | 'ceil' = 'floor'): bigint => (from === to ? raw : convertRaw(raw, CHAIN_TOKENS[from], CHAIN_TOKENS[to], mode))
/** The operator's tINR figure (in paise) in the treasury token's base units, rounded down; unchanged for tINR. */
export const fromInr = (paise: bigint, to: Currency): bigint => convertAtGenesis(paise, 'INR', to, 'floor')
/** Base units of `c` worth `usd` whole tUSD at genesis, rounded down. */
export const genesisRaw = (c: Currency, usd: bigint): bigint => convertRaw(usd * 1_000_000n, CHAIN_TOKENS.USD, CHAIN_TOKENS[c], 'floor')

/** Plain machine text of base units at `decimals`: every decimal place written ("1.230" at 3, "1500" at 0). */
export function unitsText(raw: bigint, decimals: number): string {
  const neg = raw < 0n, s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0')
  return `${neg ? '-' : ''}${decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s}`
}
/** Base units from plain decimal text with at most `decimals` places; null for anything else (a sign, an exponent, more places). */
export function parseUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d{1,60})(?:\.(\d{1,60}))?$/.exec(text)
  if (!m || (m[2] ?? '').length > decimals) return null
  return BigInt(m[1]!) * pow10(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0')
}

// ───────────────────────────────────────────────────────────── the test market of a set

export type VenueRole = 'deep' | 'thin' | 'route-in' | 'route-out' | 'off-market'
export interface PlannedVenue { role: VenueRole; a: Currency; b: Currency; feeBps: number; rawA: bigint; rawB: bigint; label: string }

/**
 * The five venues a set's execution module names, in the default market's order (chain/rail/deploy.ts INR_VENUES): a
 * deep and a thin direct pool, the two legs of a route through the third token, and a direct decoy 1% off the genesis
 * rate with a 1% fee. Every pool holds the same value on both sides at the genesis rates (the decoy's reserve side 1%
 * less), so no circular route is profitable at genesis. Synthetic test liquidity, valued in tUSD at genesis.
 */
export function venuePlan(s: AssetSet): PlannedVenue[] {
  const sym = (c: Currency) => CHAIN_TOKENS[c].symbol
  const v = (role: VenueRole, a: Currency, b: Currency, feeBps: number, usdA: bigint, usdB: bigint, label: string): PlannedVenue => ({ role, a, b, feeBps, rawA: genesisRaw(a, usdA), rawB: genesisRaw(b, usdB), label })
  const T = s.treasury, R = s.reserve, V = s.route
  return [
    v('deep', T, R, 30, 100_000n, 100_000n, `${sym(T)}/${sym(R)} · 0.30% · deep`),
    v('thin', T, R, 5, 15_000n, 15_000n, `${sym(T)}/${sym(R)} · 0.05% · thin`),
    v('route-in', T, V, 30, 50_000n, 50_000n, `${sym(T)}/${sym(V)} · 0.30%`),
    v('route-out', R, V, 30, 100_000n, 100_000n, `${sym(R)}/${sym(V)} · 0.30%`),
    v('off-market', T, R, 100, 5_000n, 4_950n, `${sym(T)}/${sym(R)} · 1.00% · off-market`),
  ]
}
/** The key one planned pool is recorded under; pools are shared by every set that plans the same one. */
export const poolKey = (p: PlannedVenue): string => `${p.role}:${p.a}:${p.b}:${p.feeBps}`

const showQ = (r: Ratio): string => `${r.n}/${r.d}`
/**
 * The reference band of the reserve token in treasury base units per reserve base unit (R7 D7), from a deep pool's
 * genesis reserves: its ratio ± bandBps. No trade moves it.
 */
export function referenceBandOf(rawTreasury: bigint, rawReserve: bigint, bandBps: number): { lo: string; mid: string; hi: string } {
  const w = BigInt(bandBps)
  return { lo: showQ(ratio(rawTreasury * (10_000n - w), rawReserve * 10_000n)), mid: showQ(ratio(rawTreasury, rawReserve)), hi: showQ(ratio(rawTreasury * (10_000n + w), rawReserve * 10_000n)) }
}

// ───────────────────────────────────────────────────────────── the owner's signed configuration

export interface AssetSetDocument {
  kind: 'qed/workspace-currencies/v1'
  statement: string
  workspaceId: string
  network: 'eip155:31337'
  rpIdHash: string
  origin: string
  members: { x: string; y: string }[]
  threshold: number
  adminThreshold: number
  currencies: AssetSet
  tokens: { role: 'treasury' | 'reserve' | 'route'; currency: Currency; symbol: string; decimals: number; kind: 'test-token' }[]
  realMoney: false
}

const word = (h: string): string => `0x${BigInt(h).toString(16).padStart(64, '0')}`
export const ASSET_SET_STATEMENT = 'I choose these test tokens for this workspace\'s on-chain wallet. They are valueless test tokens on a local chain, not money; no real-money route is opened. Amounts the service sets in test rupees are carried into the treasury\'s token at the test market\'s genesis rates, rounded down.'

/** What the owner's passkeys sign before a workspace takes a currency set other than the default. */
export function assetSetDocument(i: { workspaceId: string; rpIdHash: string; origin: string; members: { x: string; y: string }[]; threshold: number; adminThreshold: number; currencies: AssetSet }): AssetSetDocument {
  const s = checkAssetSet(i.currencies)
  const token = (role: 'treasury' | 'reserve' | 'route', c: Currency) => ({ role, currency: c, symbol: CHAIN_TOKENS[c].symbol, decimals: CHAIN_TOKENS[c].decimals, kind: 'test-token' as const })
  return {
    kind: 'qed/workspace-currencies/v1', statement: ASSET_SET_STATEMENT, workspaceId: i.workspaceId, network: 'eip155:31337', rpIdHash: word(i.rpIdHash), origin: i.origin,
    members: i.members.map((k) => ({ x: word(k.x), y: word(k.y) })), threshold: i.threshold, adminThreshold: i.adminThreshold, currencies: s,
    tokens: [token('treasury', s.treasury), token('reserve', s.reserve), token('route', s.route)], realMoney: false,
  }
}
/** The 32-byte digest the passkeys sign (their WebAuthn challenge): SHA-256 of the document's canonical JSON. */
export const assetSetDigest = (d: AssetSetDocument): `0x${string}` => `0x${sha256(canonical(d))}`
