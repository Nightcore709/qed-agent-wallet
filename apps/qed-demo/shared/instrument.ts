/**
 * The global money model, first slice: identities, exact amounts, locale-aware text, conversion with provenance and
 * conservative exposure. ADR-0012 and docs/research/qed-systems-architect/20261123-global-money-model.md.
 *
 * Callers so far, one per migration stage: shared/money.ts writes rupees through formatAmount (S1), and server/registry.ts
 * gives each asset of the books a canonical id that parseInstrumentId reads back (S2). The rest of the wallet is unchanged
 * until a later stage moves it over.
 *
 * Rules this module keeps:
 * - An amount is a bigint count of an instrument's minor unit, bound to the instrument's id AND its exponent, so an
 *   amount can never be read at another instrument's scale. Nothing here passes money through a binary float.
 * - Identities are standard identifiers, never tickers: ISO 4217 for currencies, CAIP-2/CAIP-19 for networks and
 *   tokens (CAIP-10 for chain accounts), ISIN for securities, ISO 10383 MIC for venues. A balance on a venue's own
 *   ledger is a custodial claim, named by the venue and the venue's own code for the asset (claim:paper-crypto/BTC); the
 *   code is a key on that venue's ledger only.
 * - Every division names its rounding mode (the nine of ECMA-402: floor, ceil, trunc, expand and the five half modes).
 * - A rate says which side is base and which is quote, what kind of figure it is (indicative, executable, fill,
 *   valuation, reference, projection), where it came from, when it was observed and until when it may be used, and
 *   its uncertainty as an exact band lo ≤ mid ≤ hi. A conversion records all of that and what rounding removed.
 * - Test instruments (tINR, tUSD, tEUR, tETH) are fixtures with a label, never ISO currencies.
 */
import { keccak_256 } from '@noble/hashes/sha3'

// ───────────────────────────────────────────────────────────── errors

export type MoneyErrorCode =
  | 'invalid-id' | 'unknown-instrument' | 'no-minor-unit' | 'unknown-network' | 'unknown-venue' | 'duplicate'
  | 'bad-checksum' | 'instrument-mismatch' | 'exponent-mismatch' | 'not-an-integer' | 'division-by-zero'
  | 'empty' | 'unexpected-text' | 'wrong-instrument' | 'bad-grouping' | 'bad-sign' | 'too-precise'
  | 'rounding-required' | 'invalid-rate' | 'stale-rate' | 'rate-from-the-future' | 'kind-not-allowed' | 'intl-inexact'
  | 'invalid-argument' | 'ambiguous'

export class MoneyError extends Error {
  readonly code: MoneyErrorCode
  constructor(code: MoneyErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'MoneyError'
  }
}

// ───────────────────────────────────────────────────────────── rounding

/** ECMA-402's rounding modes, by the same names (Intl.NumberFormat roundingMode). */
export type RoundingMode = 'ceil' | 'floor' | 'expand' | 'trunc' | 'halfCeil' | 'halfFloor' | 'halfExpand' | 'halfTrunc' | 'halfEven'
export const ROUNDING_MODES: readonly RoundingMode[] = ['ceil', 'floor', 'expand', 'trunc', 'halfCeil', 'halfFloor', 'halfExpand', 'halfTrunc', 'halfEven']

/** n / d rounded to an integer by the named mode. Exact for any size. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d === 0n) throw new MoneyError('division-by-zero', 'division by zero')
  if (d < 0n) { n = -n; d = -d }
  const q = n / d // toward zero
  const r = n % d // the sign of n
  if (r === 0n) return q
  const neg = n < 0n
  const floor = neg ? q - 1n : q
  const ceil = neg ? q : q + 1n
  const away = neg ? floor : ceil
  switch (mode) {
    case 'floor': return floor
    case 'ceil': return ceil
    case 'trunc': return q
    case 'expand': return away
    default: {
      const twice = 2n * (r < 0n ? -r : r)
      if (twice < d) return q
      if (twice > d) return away
      if (mode === 'halfCeil') return ceil
      if (mode === 'halfFloor') return floor
      if (mode === 'halfExpand') return away
      if (mode === 'halfTrunc') return q
      return floor % 2n === 0n ? floor : ceil // halfEven
    }
  }
}

const POW10: bigint[] = [1n]
export function pow10(e: number): bigint {
  if (!Number.isInteger(e) || e < 0 || e > 256) throw new RangeError(`pow10(${e})`)
  while (POW10.length <= e) POW10.push(POW10[POW10.length - 1]! * 10n)
  return POW10[e]!
}

// ───────────────────────────────────────────────────────────── exact ratios

/** An exact rational number n/d with d > 0 and gcd(n, d) = 1. Serialised as "n/d" (chain/rail/authority.ts uses the same form). */
export interface Ratio { readonly n: bigint; readonly d: bigint }

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a }

export function ratio(n: bigint, d: bigint = 1n): Ratio {
  if (d === 0n) throw new MoneyError('division-by-zero', 'a ratio cannot have a zero denominator')
  if (d < 0n) { n = -n; d = -d }
  const g = gcd(n, d) || 1n
  return Object.freeze({ n: n / g, d: d / g })
}

/** "n/d", "n" or a plain decimal ("1.0850"), read exactly. */
export function parseRatio(text: string): Ratio {
  const s = text.trim()
  const frac = /^([+-]?\d+)\/(\d+)$/.exec(s)
  if (frac) return ratio(BigInt(frac[1]!), BigInt(frac[2]!))
  const dec = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s)
  if (!dec) throw new MoneyError('unexpected-text', `not an exact number: ${JSON.stringify(text)}`)
  const digits = dec[3] ?? ''
  const v = BigInt(dec[2]! + digits)
  return ratio(dec[1] === '-' ? -v : v, pow10(digits.length))
}

export const showRatio = (r: Ratio): string => (r.d === 1n ? `${r.n}` : `${r.n}/${r.d}`)
export const mulRatio = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.n, a.d * b.d)
export const invRatio = (a: Ratio): Ratio => ratio(a.d, a.n)
export const cmpRatio = (a: Ratio, b: Ratio): -1 | 0 | 1 => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0 }

// ───────────────────────────────────────────────────────────── identities

/** A CAIP-2 chain id, such as "eip155:1". */
export type NetworkId = string
/**
 * "iso4217:USD", a CAIP-19 asset type ("eip155:1/slip44:60", "eip155:1/erc20:0x…"), "isin:US0378331005", or a custodial
 * claim, "claim:paper-crypto/BTC": a balance on a venue's own ledger, which is not the coin or currency it tracks.
 */
export type InstrumentId = string

const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/
const CAIP10 = /^([-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}):([-.%a-zA-Z0-9]{1,128})$/
const CAIP19 = /^([-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8}):([-.%a-zA-Z0-9]{1,128})$/
/** claim:<venue-id>/<asset-code>: the venue in lower case with single hyphens, then the venue's own code for the asset in upper case. */
const CLAIM = /^claim:([a-z0-9]+(?:-[a-z0-9]+)*)\/([A-Z0-9]+(?:[._-][A-Z0-9]+)*)$/
const EIP155_REF = /^[1-9][0-9]{0,31}$/
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** EIP-55 mixed-case checksum of a 20-byte hex address. */
export function checksumAddress(address: string): string {
  if (!HEX_ADDRESS.test(address)) throw new MoneyError('invalid-id', `not a 20-byte hex address: ${address}`)
  const lower = address.slice(2).toLowerCase()
  const hash = keccak_256(lower)
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf
    out += c >= 'a' && nibble >= 8 ? c.toUpperCase() : c
  }
  return out
}

/**
 * The canonical form of an EVM address: its EIP-55 checksum. All-lowercase and all-uppercase input are accepted as
 * legacy forms (the eip155 CAIP-10 profile asks implementers to accept them); mixed case must be a valid checksum.
 */
export function canonicalAddress(address: string): string {
  const sum = checksumAddress(address)
  const body = address.slice(2)
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase()
  if (mixed && sum !== address) throw new MoneyError('bad-checksum', `${address} fails its EIP-55 checksum (expected ${sum})`)
  return sum
}

export function parseNetworkId(id: string): { namespace: string; reference: string; id: NetworkId } {
  const m = CAIP2.exec(id)
  if (!m) throw new MoneyError('invalid-id', `not a CAIP-2 chain id: ${JSON.stringify(id)}`)
  if (m[1] === 'eip155' && !EIP155_REF.test(m[2]!)) throw new MoneyError('invalid-id', `an eip155 chain id is a decimal integer without leading zeros: ${id}`)
  return { namespace: m[1]!, reference: m[2]!, id }
}

/** A CAIP-10 account id; EVM addresses come back in their canonical checksum form. */
export function parseAccountId(id: string): { network: NetworkId; address: string; id: string } {
  const m = CAIP10.exec(id)
  if (!m) throw new MoneyError('invalid-id', `not a CAIP-10 account id: ${JSON.stringify(id)}`)
  const network = parseNetworkId(m[1]!).id
  let address = m[2]!
  if (network.startsWith('eip155:')) address = canonicalAddress(address)
  return { network, address, id: `${network}:${address}` }
}

export type ParsedInstrumentId =
  | { kind: 'fiat'; code: string; id: InstrumentId }
  | { kind: 'token'; network: NetworkId; namespace: 'erc20' | 'slip44'; reference: string; id: InstrumentId }
  | { kind: 'security'; isin: string; id: InstrumentId }
  | { kind: 'claim'; venue: string; code: string; id: InstrumentId }

/** Parse and canonicalise an instrument id. Unknown token namespaces and CAIP-19 asset ids (NFT serials) are refused. */
export function parseInstrumentId(id: string): ParsedInstrumentId {
  const fiat = /^iso4217:([A-Z]{3})$/.exec(id)
  if (fiat) return { kind: 'fiat', code: fiat[1]!, id }
  const sec = /^isin:([A-Z0-9]{12})$/.exec(id)
  if (sec) {
    if (!isValidIsin(sec[1]!)) throw new MoneyError('bad-checksum', `${sec[1]} is not a valid ISIN (check digit)`)
    return { kind: 'security', isin: sec[1]!, id }
  }
  // The prefix is read only as a claim: checked before CAIP-19, whose namespace pattern would also accept "claim".
  if (id.startsWith('claim:')) {
    const claim = CLAIM.exec(id)
    if (!claim || claim[1]!.length > 32 || claim[2]!.length > 32) throw new MoneyError('invalid-id', `not a custodial claim (claim:<venue-id>/<asset-code>, each at most 32 characters): ${JSON.stringify(id)}`)
    return { kind: 'claim', venue: claim[1]!, code: claim[2]!, id }
  }
  const tok = CAIP19.exec(id)
  if (!tok) throw new MoneyError('invalid-id', `not an instrument id (iso4217:XXX, isin:…, claim:…/…, or a CAIP-19 asset type): ${JSON.stringify(id)}`)
  const network = parseNetworkId(tok[1]!).id
  const ns = tok[2]!, ref = tok[3]!
  if (ns === 'slip44') {
    if (!/^(0|[1-9][0-9]{0,63})$/.test(ref)) throw new MoneyError('invalid-id', `a slip44 reference is a decimal coin type: ${id}`)
    return { kind: 'token', network, namespace: 'slip44', reference: ref, id: `${network}/slip44:${ref}` }
  }
  if (ns === 'erc20') {
    if (!network.startsWith('eip155:')) throw new MoneyError('invalid-id', `erc20 is an EVM namespace: ${id}`)
    const address = canonicalAddress(ref)
    return { kind: 'token', network, namespace: 'erc20', reference: address, id: `${network}/erc20:${address}` }
  }
  throw new MoneyError('invalid-id', `asset namespace ${ns} is not supported in this slice (erc20 and slip44 are): ${id}`)
}

const isinValue = (c: string): string => (c >= '0' && c <= '9' ? c : String(c.charCodeAt(0) - 55))

/** ISO 6166 check digit over the first 11 characters: letters become 10 to 35, then the Luhn rule. */
export function isinCheckDigit(first11: string): number {
  if (!/^[A-Z]{2}[A-Z0-9]{9}$/.test(first11)) throw new MoneyError('invalid-id', `not the first 11 characters of an ISIN: ${first11}`)
  const digits = [...first11].map(isinValue).join('')
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let v = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 0) { v *= 2; if (v > 9) v -= 9 } // the rightmost digit is doubled: the check digit goes to its right
    sum += v
  }
  return (10 - (sum % 10)) % 10
}

export function isValidIsin(isin: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) && isinCheckDigit(isin.slice(0, 11)) === Number(isin[11])
}

/** ISO 10383: four characters, letters and digits. Whether a MIC is active is a lookup in the venue table, not a format check. */
export const isMicFormat = (mic: string): boolean => /^[A-Z0-9]{4}$/.test(mic)

// ───────────────────────────────────────────────────────────── reference data

/**
 * ISO 4217 List One as published by the maintenance agency (SIX), "Pblshd" 2026-09-17, fetched 2026-11-23 from
 * https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 * (SHA-256 33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff). One entry per alphabetic code:
 * code, numeric code, minor unit ("-" where the list says N.A.), and "*" for a fund code. 178 codes.
 */
export const ISO4217_LIST_ONE = {
  published: '2026-09-17',
  source: 'ISO 4217 List One (SIX), published 2026-09-17, fetched 2026-11-23',
  table: 'AED7842 AFN9712 ALL0082 AMD0512 AOA9732 ARS0322 AUD0362 AWG5332 AZN9442 BAM9772 BBD0522 BDT0502 BHD0483 BIF1080 '
    + 'BMD0602 BND0962 BOB0682 BOV9842* BRL9862 BSD0442 BTN0642 BWP0722 BYN9332 BZD0842 CAD1242 CDF9762 CHE9472* CHF7562 '
    + 'CHW9482* CLF9904* CLP1520 CNY1562 COP1702 COU9702* CRC1882 CUP1922 CVE1322 CZK2032 DJF2620 DKK2082 DOP2142 DZD0122 '
    + 'EGP8182 ERN2322 ETB2302 EUR9782 FJD2422 FKP2382 GBP8262 GEL9812 GHS9362 GIP2922 GMD2702 GNF3240 GTQ3202 GYD3282 '
    + 'HKD3442 HNL3402 HTG3322 HUF3482 IDR3602 ILS3762 INR3562 IQD3683 IRR3642 ISK3520 JMD3882 JOD4003 JPY3920 KES4042 '
    + 'KGS4172 KHR1162 KMF1740 KPW4082 KRW4100 KWD4143 KYD1362 KZT3982 LAK4182 LBP4222 LKR1442 LRD4302 LSL4262 LYD4343 '
    + 'MAD5042 MDL4982 MGA9692 MKD8072 MMK1042 MNT4962 MOP4462 MRU9292 MUR4802 MVR4622 MWK4542 MXN4842 MXV9792* MYR4582 '
    + 'MZN9432 NAD5162 NGN5662 NIO5582 NOK5782 NPR5242 NZD5542 OMR5123 PAB5902 PEN6042 PGK5982 PHP6082 PKR5862 PLN9852 '
    + 'PYG6000 QAR6342 RON9462 RSD9412 RUB6432 RWF6460 SAR6822 SBD0902 SCR6902 SDG9382 SEK7522 SGD7022 SHP6542 SLE9252 '
    + 'SOS7062 SRD9682 SSP7282 STN9302 SVC2222 SYP7602 SZL7482 THB7642 TJS9722 TMT9342 TND7883 TOP7762 TRY9492 TTD7802 '
    + 'TWD9012 TZS8342 UAH9802 UGX8000 USD8402 USN9972* UYI9400* UYU8582 UYW9274* UZS8602 VED9262 VES9282 VND7040 VUV5480 '
    + 'WST8822 XAD3962* XAF9500 XAG961- XAU959- XBA955- XBB956- XBC957- XBD958- XCD9512 XCG5322 XDR960- XOF9520 XPD964- '
    + 'XPF9530 XPT962- XSU994- XTS963- XUA965- XXX999- YER8862 ZAR7102 ZMW9672 ZWG9242',
} as const

export interface Iso4217Entry { code: string; numeric: string; minorUnit: number | null; fund: boolean }

export function iso4217Entries(): Iso4217Entry[] {
  return ISO4217_LIST_ONE.table.split(' ').map((e) => {
    const m = /^([A-Z]{3})(\d{3})([0-9-])(\*?)$/.exec(e)
    if (!m) throw new MoneyError('invalid-id', `bad ISO 4217 table entry ${e}`)
    return { code: m[1]!, numeric: m[2]!, minorUnit: m[3] === '-' ? null : Number(m[3]), fund: m[4] === '*' }
  })
}

// ───────────────────────────────────────────────────────────── instruments, networks, venues

interface InstrumentCommon {
  readonly id: InstrumentId
  readonly name: string
  /** Decimal places of one minor unit: 2 for USD, 0 for JPY, 3 for KWD, 18 for ether; for a security, the quantity precision booked. */
  readonly exponent: number
  /** Where the identity and the exponent come from. */
  readonly source: string
  /** Only on test instruments: what they are, in words, for every place that shows them. */
  readonly fixture?: string
}
export interface FiatInstrument extends InstrumentCommon { readonly kind: 'fiat'; readonly code: string; readonly numeric: string; readonly fund: boolean }
export interface TokenInstrument extends InstrumentCommon {
  readonly kind: 'token'
  readonly network: NetworkId
  readonly namespace: 'erc20' | 'slip44'
  /** Contract address (erc20, canonical checksum) or SLIP-44 coin type (slip44: the network's native asset). */
  readonly reference: string
  /** A label for display only. Two tokens may share a symbol; the id is what identifies one. */
  readonly symbol: string
}
export interface Listing {
  /** Segment or operating MIC of the venue where the line trades. */
  readonly mic: string
  /** The currency the line is quoted and settled in. */
  readonly currency: InstrumentId
  /** The venue's own code for the line (a ticker): a label, never an identity. */
  readonly localCode?: string
}
export interface SecurityInstrument extends InstrumentCommon {
  readonly kind: 'security'
  readonly isin: string
  readonly form: 'share' | 'fund-unit' | 'etf' | 'bond'
  readonly listings: readonly Listing[]
}
export type Instrument = FiatInstrument | TokenInstrument | SecurityInstrument

export interface Venue {
  readonly mic: string
  readonly operatingMic: string
  readonly name: string
  /** ISO 3166-1 alpha-2, from the MIC list. */
  readonly country: string
  /** IANA time zone of the venue's trading day; assigned by QED from the venue's city (the MIC list has no time zone). */
  readonly timeZone: string
  readonly source: string
}

export type Finality = { readonly kind: 'confirmations'; readonly depth: number } | { readonly kind: 'finalized-checkpoint' }
export interface Network {
  readonly id: NetworkId
  readonly name: string
  /** The asset that pays for transactions on this network. */
  readonly gasAsset: InstrumentId
  /** When a transaction on this network counts as final for QED's books. */
  readonly finality: Finality
  readonly source: string
  readonly fixture?: string
}

const MIC_SOURCE = 'ISO 10383 MIC list (iso20022.org ISO10383_MIC.csv, 2,893 rows, last update 2026-11-23), fetched 2026-11-23'

/** A few venues, enough for the listings below and to show operating and segment MICs apart. */
export const VENUES: readonly Venue[] = [
  { mic: 'XNAS', operatingMic: 'XNAS', name: 'Nasdaq, all markets', country: 'US', timeZone: 'America/New_York', source: MIC_SOURCE },
  { mic: 'XNGS', operatingMic: 'XNAS', name: 'Nasdaq Global Select Market', country: 'US', timeZone: 'America/New_York', source: MIC_SOURCE },
  { mic: 'XNYS', operatingMic: 'XNYS', name: 'New York Stock Exchange', country: 'US', timeZone: 'America/New_York', source: MIC_SOURCE },
  { mic: 'XNSE', operatingMic: 'XNSE', name: 'National Stock Exchange of India', country: 'IN', timeZone: 'Asia/Kolkata', source: MIC_SOURCE },
  { mic: 'XBOM', operatingMic: 'XBOM', name: 'BSE Ltd', country: 'IN', timeZone: 'Asia/Kolkata', source: MIC_SOURCE },
  { mic: 'XJPX', operatingMic: 'XJPX', name: 'Japan Exchange Group', country: 'JP', timeZone: 'Asia/Tokyo', source: MIC_SOURCE },
  { mic: 'XTKS', operatingMic: 'XJPX', name: 'Tokyo Stock Exchange', country: 'JP', timeZone: 'Asia/Tokyo', source: MIC_SOURCE },
  { mic: 'XLON', operatingMic: 'XLON', name: 'London Stock Exchange', country: 'GB', timeZone: 'Europe/London', source: MIC_SOURCE },
]

export const NETWORKS: readonly Network[] = [
  { id: 'eip155:1', name: 'Ethereum mainnet', gasAsset: 'eip155:1/slip44:60', finality: { kind: 'finalized-checkpoint' }, source: 'CAIP-2 test case; EIP-155 chain id 1' },
  { id: 'eip155:11155111', name: 'Ethereum Sepolia (test network)', gasAsset: 'eip155:11155111/slip44:60', finality: { kind: 'finalized-checkpoint' }, source: 'The release\'s deployment (chain/vendor/evidence/ethereum-sepolia/manifest.json, chainId 11155111)', fixture: 'a public test network; its ether has no value' },
  { id: 'eip155:31337', name: 'Local Anvil chain', gasAsset: 'eip155:31337/slip44:60', finality: { kind: 'confirmations', depth: 2 }, source: 'chain/rail/config.ts (chain id 31337); R7 decision D6 (two confirmations by default)', fixture: 'a chain running on this QED installation; nothing on it has value' },
]

const nativeEther = (network: Network): TokenInstrument => ({
  kind: 'token', id: `${network.id}/slip44:60`, network: network.id, namespace: 'slip44', reference: '60', symbol: 'ETH',
  name: network.fixture ? `Test ether on ${network.name}` : 'Ether', exponent: 18,
  source: 'CAIP-20 (SLIP-44 coin type 60, "Ether Token" test case); 18 decimals (wei)',
  ...(network.fixture ? { fixture: `${network.name}'s gas asset; ${network.fixture}` } : {}),
})

/** One security, to show the identity scheme: ISIN plus listings by MIC, each with its own currency. Reference data, not a recommendation. */
export const EXAMPLE_SECURITIES: readonly SecurityInstrument[] = [
  {
    kind: 'security', id: 'isin:US0378331005', isin: 'US0378331005', form: 'share', name: 'Apple Inc. common stock', exponent: 0,
    listings: [{ mic: 'XNGS', currency: 'iso4217:USD', localCode: 'AAPL' }],
    source: 'ISIN check digit verified here; issuer and listing are general knowledge, not checked against ANNA or the venue (NOT VERIFIED)',
  },
]

/** The release's test tokens and the wallet's tINR, as labelled fixtures. Addresses come from the rail's genesis record at run time. */
export interface TestTokenAddresses { tINR: string; tUSD: string; tEUR: string; tETH: string }
export function testTokenFixtures(network: NetworkId, addresses: TestTokenAddresses): TokenInstrument[] {
  const make = (symbol: keyof TestTokenAddresses, name: string, exponent: number, words: string, source: string): TokenInstrument => {
    const address = canonicalAddress(addresses[symbol])
    return { kind: 'token', id: `${network}/erc20:${address}`, network, namespace: 'erc20', reference: address, symbol, name, exponent, source, fixture: words }
  }
  return [
    make('tINR', 'QED Test Rupee', 2, 'test rupees on a local chain, not money', 'chain/rail/deploy.ts (TestToken "QED Test Rupee", INR_DECIMALS = 2)'),
    make('tUSD', 'TestUSD', 6, 'test dollars on a local chain, not money', 'release M-35: TestUSD, 6 decimals, public faucet'),
    make('tEUR', 'QED Test Euro', 6, 'test euros on a local chain, not money', 'release M-35: TestToken "QED Test Euro", 6 decimals'),
    make('tETH', 'QED Test Ether', 18, 'a test token named after ether, on a local chain, not money and not the chain\'s gas asset', 'release M-35: TestToken "QED Test Ether", 18 decimals'),
  ]
}

export class Registry {
  readonly #instruments = new Map<InstrumentId, Instrument>()
  readonly #networks = new Map<NetworkId, Network>()
  readonly #venues = new Map<string, Venue>()
  readonly #noMinorUnit = new Map<string, string>()

  constructor(parts: { instruments?: readonly Instrument[]; networks?: readonly Network[]; venues?: readonly Venue[]; noMinorUnit?: readonly string[] } = {}) {
    for (const v of parts.venues ?? []) {
      if (!isMicFormat(v.mic) || !isMicFormat(v.operatingMic)) throw new MoneyError('invalid-id', `bad MIC ${v.mic}/${v.operatingMic}`)
      if (this.#venues.has(v.mic)) throw new MoneyError('duplicate', `venue ${v.mic} twice`)
      this.#venues.set(v.mic, Object.freeze({ ...v }))
    }
    for (const v of this.#venues.values()) if (!this.#venues.has(v.operatingMic)) throw new MoneyError('unknown-venue', `${v.mic} names operating MIC ${v.operatingMic}, which is not registered`)
    for (const n of parts.networks ?? []) {
      parseNetworkId(n.id)
      if (this.#networks.has(n.id)) throw new MoneyError('duplicate', `network ${n.id} twice`)
      this.#networks.set(n.id, Object.freeze({ ...n }))
    }
    for (const code of parts.noMinorUnit ?? []) this.#noMinorUnit.set(code, code)
    // Currencies and tokens first, so that a security's listings can name a currency given later in the list.
    for (const i of parts.instruments ?? []) if (i.kind !== 'security') this.#add(i)
    for (const i of parts.instruments ?? []) if (i.kind === 'security') this.#add(i)
    for (const n of this.#networks.values()) {
      const gas = this.#instruments.get(n.gasAsset)
      if (!gas || gas.kind !== 'token' || gas.network !== n.id) throw new MoneyError('unknown-instrument', `network ${n.id} names gas asset ${n.gasAsset}, which is not one of its registered tokens`)
    }
  }

  #add(i: Instrument): void {
    if (!Number.isInteger(i.exponent) || i.exponent < 0 || i.exponent > 36) throw new MoneyError('invalid-id', `${i.id}: exponent ${i.exponent} is out of range`)
    const parsed = parseInstrumentId(i.id)
    if (parsed.kind !== i.kind) throw new MoneyError('invalid-id', `${i.id} is a ${parsed.kind} id on a ${i.kind} record`)
    if (parsed.id !== i.id) throw new MoneyError('invalid-id', `${i.id} is not canonical (${parsed.id})`)
    if (i.kind === 'fiat' && (parsed.kind !== 'fiat' || parsed.code !== i.code)) throw new MoneyError('invalid-id', `${i.id} does not match code ${i.code}`)
    if (i.kind === 'token') {
      if (!this.#networks.has(i.network)) throw new MoneyError('unknown-network', `${i.id}: network ${i.network} is not registered`)
      if (parsed.kind !== 'token' || parsed.network !== i.network || parsed.namespace !== i.namespace || parsed.reference !== i.reference) throw new MoneyError('invalid-id', `${i.id} does not match its network, namespace or reference`)
    }
    if (i.kind === 'security') {
      if (parsed.kind !== 'security' || parsed.isin !== i.isin) throw new MoneyError('invalid-id', `${i.id} does not match ISIN ${i.isin}`)
      for (const l of i.listings) {
        if (!this.#venues.has(l.mic)) throw new MoneyError('unknown-venue', `${i.id} is listed on ${l.mic}, which is not registered`)
        const cur = this.#instruments.get(l.currency)
        if (!cur || cur.kind !== 'fiat') throw new MoneyError('unknown-instrument', `${i.id} on ${l.mic} is quoted in ${l.currency}, which is not a registered currency`)
      }
    }
    if (this.#instruments.has(i.id)) throw new MoneyError('duplicate', `instrument ${i.id} twice`)
    this.#instruments.set(i.id, Object.freeze({ ...i }) as Instrument)
  }

  /** A new registry with these entries added (an id already present is refused as a duplicate); this one is unchanged. */
  with(parts: { instruments?: readonly Instrument[]; networks?: readonly Network[]; venues?: readonly Venue[] }): Registry {
    return new Registry({
      venues: [...this.#venues.values(), ...(parts.venues ?? [])],
      networks: [...this.#networks.values(), ...(parts.networks ?? [])],
      instruments: [...this.#instruments.values(), ...(parts.instruments ?? [])],
      noMinorUnit: [...this.#noMinorUnit.keys()],
    })
  }

  find(id: InstrumentId): Instrument | undefined { return this.#instruments.get(id) }

  instrument(id: InstrumentId): Instrument {
    const found = this.#instruments.get(id)
    if (found) return found
    const code = /^iso4217:([A-Z]{3})$/.exec(id)?.[1]
    if (code && this.#noMinorUnit.has(code)) throw new MoneyError('no-minor-unit', `ISO 4217 gives ${code} no minor unit; hold it through an instrument with a stated unit (a fund, a token, or a quantity of metal)`)
    throw new MoneyError('unknown-instrument', `no instrument ${id} in this registry`)
  }

  network(id: NetworkId): Network {
    const n = this.#networks.get(id)
    if (!n) throw new MoneyError('unknown-network', `no network ${id} in this registry`)
    return n
  }

  venue(mic: string): Venue {
    const v = this.#venues.get(mic)
    if (!v) throw new MoneyError('unknown-venue', `no venue ${mic} in this registry`)
    return v
  }

  get instruments(): readonly Instrument[] { return [...this.#instruments.values()] }
  get networks(): readonly Network[] { return [...this.#networks.values()] }
}

/** Every ISO 4217 currency that has a minor unit, the three networks, their gas assets, the venues and the example security. */
export function standardRegistry(): Registry {
  const entries = iso4217Entries()
  const fiat: FiatInstrument[] = entries.filter((e) => e.minorUnit !== null).map((e) => ({
    kind: 'fiat', id: `iso4217:${e.code}`, code: e.code, numeric: e.numeric, fund: e.fund, exponent: e.minorUnit!, name: e.code, source: ISO4217_LIST_ONE.source,
  }))
  return new Registry({
    venues: VENUES,
    networks: NETWORKS,
    noMinorUnit: entries.filter((e) => e.minorUnit === null).map((e) => e.code),
    instruments: [...fiat, ...NETWORKS.map(nativeEther), ...EXAMPLE_SECURITIES],
  })
}

// ───────────────────────────────────────────────────────────── amounts

/** A quantity of one instrument: an integer count of its minor unit, with the exponent it was counted at. */
export interface Amount { readonly instrument: InstrumentId; readonly exponent: number; readonly minor: bigint }

export function amount(inst: Instrument, minor: bigint | number): Amount {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) throw new MoneyError('not-an-integer', `${minor} is not a whole number of minor units that a JavaScript number holds exactly`)
  return Object.freeze({ instrument: inst.id, exponent: inst.exponent, minor: BigInt(minor) })
}

function same(a: Amount, b: Amount): void {
  if (a.instrument !== b.instrument) throw new MoneyError('instrument-mismatch', `${a.instrument} and ${b.instrument} cannot be combined without a conversion`)
  if (a.exponent !== b.exponent) throw new MoneyError('exponent-mismatch', `${a.instrument} counted at exponents ${a.exponent} and ${b.exponent}`)
}

const withMinor = (a: Amount, minor: bigint): Amount => Object.freeze({ instrument: a.instrument, exponent: a.exponent, minor })
export const addAmounts = (a: Amount, b: Amount): Amount => { same(a, b); return withMinor(a, a.minor + b.minor) }
export const subtractAmounts = (a: Amount, b: Amount): Amount => { same(a, b); return withMinor(a, a.minor - b.minor) }
export const negateAmount = (a: Amount): Amount => withMinor(a, -a.minor)
export const compareAmounts = (a: Amount, b: Amount): -1 | 0 | 1 => { same(a, b); return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0 }
export function sumAmounts(inst: Instrument, xs: readonly Amount[]): Amount {
  let total = amount(inst, 0n)
  for (const x of xs) total = addAmounts(total, x)
  return total
}

/** a × r, rounded by the named mode (a fee rate, a share, a haircut). */
export const scaleAmount = (a: Amount, r: Ratio, mode: RoundingMode): Amount => withMinor(a, divRound(a.minor * r.n, r.d, mode))

/**
 * Split an amount in proportion to non-negative weights without creating or losing a minor unit: each part is the
 * floor of its exact share, and the units left over go one each to the largest remainders (ties to the earlier part).
 */
export function allocateAmount(a: Amount, weights: readonly bigint[]): Amount[] {
  const total = weights.reduce((s, w) => { if (w < 0n) throw new MoneyError('invalid-argument', 'a weight cannot be negative'); return s + w }, 0n)
  if (total === 0n) throw new MoneyError('division-by-zero', 'weights sum to zero')
  const neg = a.minor < 0n, abs = neg ? -a.minor : a.minor
  const parts = weights.map((w) => abs * w / total)
  const rems = weights.map((w, i) => ({ i, r: abs * w % total }))
  let left = abs - parts.reduce((s, p) => s + p, 0n)
  rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1))
  for (const { i } of rems) { if (left === 0n) break; parts[i] = parts[i]! + 1n; left -= 1n }
  return parts.map((p) => withMinor(a, neg ? -p : p))
}

/** Canonical machine text: optional "-", whole units, and exactly `exponent` fraction digits ("1234.50", "-0.000000000000000001"). */
export function toDecimalString(a: Amount): string { return decimalText(a.minor, a.exponent) }

function decimalText(minor: bigint, exponent: number): string {
  const neg = minor < 0n
  const s = (neg ? -minor : minor).toString().padStart(exponent + 1, '0')
  const int = s.slice(0, s.length - exponent), frac = s.slice(s.length - exponent)
  return `${neg ? '-' : ''}${int}${exponent ? `.${frac}` : ''}`
}

/**
 * Read canonical machine text ("1234.5", "-0.25"). More fraction digits than the instrument has is refused unless the
 * extra digits are zeros, or a rounding mode is named.
 */
export function amountFromDecimal(inst: Instrument, text: string, rounding?: RoundingMode): Amount {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) throw new MoneyError('unexpected-text', `not a plain decimal: ${JSON.stringify(text)}`)
  return amount(inst, fromDigits(m[1] === '-', m[2]!, m[3] ?? '', inst, rounding))
}

/** The signed value int.frac in minor units of the instrument. Extra decimal places must be zeros, or a rounding mode is named. */
function fromDigits(neg: boolean, int: string, frac: string, inst: Instrument, rounding?: RoundingMode): bigint {
  const e = inst.exponent
  if (int.length + frac.length > 200) throw new MoneyError('unexpected-text', 'an amount of more than 200 digits is not accepted')
  const whole = BigInt(int + frac)
  const signed = neg ? -whole : whole
  if (frac.length <= e) return signed * pow10(e - frac.length)
  if (/[1-9]/.test(frac.slice(e)) && !rounding) {
    throw new MoneyError('too-precise', `${inst.id} has ${e} decimal place${e === 1 ? '' : 's'}; ${int}.${frac} needs rounding, and no rounding mode was given`)
  }
  return divRound(signed, pow10(frac.length - e), rounding ?? 'trunc') // 'trunc' is exact here: the dropped digits are zeros
}

export interface AmountJSON { instrument: InstrumentId; exponent: number; minor: string }
export const amountToJSON = (a: Amount): AmountJSON => ({ instrument: a.instrument, exponent: a.exponent, minor: a.minor.toString() })
export function amountFromJSON(j: AmountJSON, registry: Registry): Amount {
  const inst = registry.instrument(j.instrument)
  if (inst.exponent !== j.exponent) throw new MoneyError('exponent-mismatch', `${j.instrument} is registered at exponent ${inst.exponent}, the record says ${j.exponent}`)
  if (!/^-?\d+$/.test(j.minor)) throw new MoneyError('not-an-integer', `minor units must be an integer string: ${j.minor}`)
  return amount(inst, BigInt(j.minor))
}

// ───────────────────────────────────────────────────────────── locale-aware text

let intlExact: boolean | null = null
/** Intl.NumberFormat (ES2023) formats a decimal string exactly. If this runtime does not, formatting refuses rather than lose digits. */
function assertExactIntl(): void {
  if (intlExact === null) {
    const probe = '-98765432109876543210.123456789012345678'
    const out = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 18, maximumFractionDigits: 18 }).format(probe as `${number}`)
    intlExact = out.replace(/[^0-9.-]/g, '') === probe
  }
  if (!intlExact) throw new MoneyError('intl-inexact', 'this runtime\'s Intl.NumberFormat does not format decimal strings exactly; refusing to format money')
}

const nfCache = new Map<string, Intl.NumberFormat>()
function nf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let f = nfCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, options) // an invalid locale tag throws here: nothing is formatted in a guessed locale
    if (nfCache.size >= 512) nfCache.clear() // locales can come from requests: the cache must not grow without bound
    nfCache.set(key, f)
  }
  return f
}

export interface FormatOptions {
  locale: string
  /** 'symbol' (default): the locale's currency symbol, or a token's symbol; 'code': ISO code, token symbol or ISIN; 'name': the instrument's name; 'none': the number alone. */
  display?: 'symbol' | 'code' | 'name' | 'none'
  /** Fraction digits to write; default the instrument's exponent. Fewer than the exponent needs `rounding`. */
  fractionDigits?: number
  rounding?: RoundingMode
  sign?: 'auto' | 'always' | 'exceptZero' | 'never' | 'negative'
  grouping?: boolean
  /** Write the minus sign as U+2212, as QED's own copy does, instead of the locale's character. */
  typographicMinus?: boolean
}

/**
 * Write an amount for a reader. The digits are worked out here in integers and handed to Intl as an exact decimal
 * string with the fraction digits fixed, so neither CLDR's own idea of a currency's digits (it gives IQD 0 where
 * ISO 4217 gives 3) nor a binary float can change the figure.
 */
export function formatAmount(a: Amount, inst: Instrument, opts: FormatOptions): string {
  if (inst.id !== a.instrument) throw new MoneyError('instrument-mismatch', `formatting ${a.instrument} with the record of ${inst.id}`)
  if (inst.exponent !== a.exponent) throw new MoneyError('exponent-mismatch', `${a.instrument} counted at ${a.exponent}, registered at ${inst.exponent}`)
  assertExactIntl()
  const digits = opts.fractionDigits ?? inst.exponent
  if (!Number.isInteger(digits) || digits < 0 || digits > 100) throw new RangeError(`fractionDigits ${digits}`)
  let minor = a.minor
  let scale = inst.exponent
  if (digits < scale) {
    if (!opts.rounding) throw new MoneyError('rounding-required', `writing ${inst.id} to ${digits} of its ${scale} decimal places needs a rounding mode`)
    minor = divRound(minor, pow10(scale - digits), opts.rounding)
    scale = digits
  }
  const text = decimalText(minor, scale) // a value that rounds to zero is written "0…", without a sign
  const display = opts.display ?? 'symbol'
  const common: Intl.NumberFormatOptions = {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
    useGrouping: (opts.grouping ?? true) ? 'auto' : false,
    signDisplay: opts.sign ?? 'auto',
  }
  const fiatStyle = inst.kind === 'fiat' && display !== 'none'
  const options: Intl.NumberFormatOptions = fiatStyle
    ? { ...common, style: 'currency', currency: (inst as FiatInstrument).code, currencyDisplay: display === 'code' ? 'code' : display === 'name' ? 'name' : 'symbol' }
    : { ...common, style: 'decimal' }
  let parts = nf(opts.locale, options).formatToParts(text as `${number}`)
  // ICU can split the digits with the currency's name for some locale and currency pairs (tr-TR, UYW, name display:
  // "UYW 0,000 UYW0"). A figure whose digits are not together is not written: fall back to the ISO code display.
  if (!digitsTogether(parts) && fiatStyle) parts = nf(opts.locale, { ...options, currencyDisplay: 'code' }).formatToParts(text as `${number}`)
  if (!digitsTogether(parts)) throw new MoneyError('intl-inexact', `Intl split the digits of ${inst.id} in ${opts.locale}; refusing to write it`)
  let out = parts.map((p) => (p.type === 'minusSign' && opts.typographicMinus ? '\u2212' : p.value)).join('')
  if (!fiatStyle && display !== 'none') out = `${out} ${unitLabel(inst, display)}`
  return out
}

const NUMBER_PARTS = new Set(['integer', 'group', 'decimal', 'fraction'])
/** True when the integer, group, decimal and fraction parts are one unbroken run. */
function digitsTogether(parts: Intl.NumberFormatPart[]): boolean {
  const at = parts.map((p, i) => (NUMBER_PARTS.has(p.type) ? i : -1)).filter((i) => i >= 0)
  return at.length === 0 || at[at.length - 1]! - at[0]! + 1 === at.length
}

function unitLabel(inst: Instrument, display: 'symbol' | 'code' | 'name'): string {
  if (display === 'name') return inst.fixture ?? inst.name
  if (inst.kind === 'token') return inst.symbol
  if (inst.kind === 'security') return display === 'code' ? inst.isin : inst.name
  return inst.code
}

/** Separators and grouping of one formatting style. Some locales use different ones for currency amounts (fr-CH writes
 * "1'234,5" but "1'234.50 $US"; de-AT groups plain numbers with a space and currency amounts with a full stop). */
interface StyleSymbols { group: string; decimal: string; minus: string; primary: number; secondary: number }
interface LocaleSymbols { styles: StyleSymbols[]; digits: Map<string, string> }
const symbolsCache = new Map<string, LocaleSymbols>()

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const norm = (s: string): string => s.normalize('NFKC').replace(BIDI, '')

function styleSymbols(locale: string, style: Intl.NumberFormatOptions): StyleSymbols {
  const grouped = nf(locale, { ...style, useGrouping: 'always' as never, maximumFractionDigits: 0 }).formatToParts(1234567890n)
  const groups = grouped.filter((p) => p.type === 'integer').map((p) => p.value)
  const group = norm(grouped.find((p) => p.type === 'group')?.value ?? ',')
  const primary = Array.from(groups[groups.length - 1] ?? '000').length
  const secondary = groups.length >= 3 ? Array.from(groups[groups.length - 2]!).length : primary
  const parts = nf(locale, { ...style, minimumFractionDigits: 1 }).formatToParts('-1.5' as `${number}`)
  const decimal = norm(parts.find((p) => p.type === 'decimal')?.value ?? '.')
  const minus = norm(parts.find((p) => p.type === 'minusSign')?.value ?? '-')
  return { group, decimal, minus, primary, secondary }
}

function localeSymbols(locale: string): LocaleSymbols {
  const cached = symbolsCache.get(locale)
  if (cached) return cached
  const plainStyle = styleSymbols(locale, {})
  const currencyStyle = styleSymbols(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'code' })
  const same = JSON.stringify(plainStyle) === JSON.stringify(currencyStyle)
  const digits = new Map<string, string>()
  const plain = nf(locale, { useGrouping: false })
  for (let d = 0; d <= 9; d++) {
    const native = norm(plain.format(BigInt(d)))
    if (Array.from(native).length === 1) digits.set(native, String(d))
  }
  const s: LocaleSymbols = { styles: same ? [plainStyle] : [plainStyle, currencyStyle], digits }
  if (symbolsCache.size >= 128) symbolsCache.clear()
  symbolsCache.set(locale, s)
  return s
}

/** The texts that may name this instrument in input, longest first. Ambiguous symbols are not accepted. */
function unitTokens(inst: Instrument, locale: string): string[] {
  const out = new Set<string>()
  if (inst.kind === 'fiat') {
    out.add(inst.code)
    const sym = (display: 'symbol' | 'narrowSymbol' | 'code') => norm(nf(locale, { style: 'currency', currency: inst.code, currencyDisplay: display }).formatToParts(1n).find((p) => p.type === 'currency')?.value ?? '')
    const symbol = sym('symbol'), narrow = sym('narrowSymbol')
    if (symbol) out.add(symbol)
    if (narrow && narrow === symbol) out.add(narrow) // "$" names USD in en-US; for CAD it is "CA$", and a bare "$" is refused
    // The locale's name of the currency in its plural forms ("US dollar", "US dollars", "円"), for whole and fractional amounts.
    const named = nf(locale, { style: 'currency', currency: inst.code, currencyDisplay: 'name', minimumFractionDigits: 0, maximumFractionDigits: 3 })
    for (const v of ['0', '1', '2', '3', '5', '11', '21', '101', '1.5', '0.25', '1.125']) {
      for (const p of named.formatToParts(v as `${number}`)) if (p.type === 'currency') out.add(norm(p.value).trim())
    }
  } else if (inst.kind === 'token') out.add(norm(inst.symbol))
  else out.add(inst.isin)
  return [...out].filter(Boolean).sort((x, y) => y.length - x.length)
}

export interface ParseOptions {
  locale: string
  /** Needed only when the text has more decimal places than the instrument; without it such text is refused. */
  rounding?: RoundingMode
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Read an amount a person typed, in their locale: the locale's digits, group and decimal separators and minus sign;
 * the instrument's own symbol or code may appear once, before or after the number. Strict on purpose: grouping must
 * fall where the locale puts it ("1.5" is not fifteen in de-DE, "1,5" is not fifteen in en-US), another currency's
 * symbol or any other text is refused, and more decimal places than the instrument has need a rounding mode.
 */
export function parseAmount(text: string, inst: Instrument, opts: ParseOptions): Amount {
  const sym = localeSymbols(opts.locale)
  let s = norm(text).trim()
  if (!s) throw new MoneyError('empty', 'no amount was given')
  if (s.length > 128) throw new MoneyError('unexpected-text', 'an amount of more than 128 characters is not accepted')
  // Each text that names this instrument may appear once, before or after the number (some locales write a symbol and a
  // name together: "$0,00 ABD doları" in Turkish), never inside it. Longest first, so "US dollars" goes before "$".
  const signOnly = (x: string) => x.length <= 1 && !/[0-9\p{Nd}]/u.test(x)
  for (const tok of unitTokens(inst, opts.locale)) {
    const at = s.indexOf(tok)
    if (at < 0) continue
    const before = s.slice(0, at).trim(), after = s.slice(at + tok.length).trim()
    const outside = (x: string) => signOnly(x) || !/[0-9\p{Nd}]/u.test(x) // only signs, or only other words of the unit
    if (!outside(before) && !outside(after)) throw new MoneyError('unexpected-text', `${JSON.stringify(text)}: the currency or unit sits inside the number`)
    s = `${before} ${after}`
  }
  s = [...s].map((c) => sym.digits.get(c) ?? c).join('')
  if (/[\p{L}\p{Sc}]/u.test(s)) throw new MoneyError(/[\p{Sc}]|\b[A-Z]{3}\b/u.test(s) ? 'wrong-instrument' : 'unexpected-text', `${JSON.stringify(text)} names something other than ${inst.id}, or has text that is not part of an amount`)
  // Read the number under each of the locale's styles and compare the exact values before the instrument's precision
  // applies: a reading that is only too precise is still a reading. Some locales write plain numbers and currency with
  // opposite separators (en-DE: "1.234,5" and "$1,234.50"), and there "1.234" is two different numbers: refused.
  const readings = new Map<string, Decimal>()
  let firstError: MoneyError | null = null
  for (const style of sym.styles) {
    try { const d = readNumber(s, style, text, opts); readings.set(decimalKey(d), d) } catch (e) { if (!(e instanceof MoneyError)) throw e; firstError ??= e }
  }
  const [only, ...others] = [...readings.values()]
  if (only !== undefined && others.length === 0) return amount(inst, fromDigits(only.neg, only.int, only.frac, inst, opts.rounding))
  if (only !== undefined) throw new MoneyError('ambiguous', `${JSON.stringify(text)} reads as different numbers under ${opts.locale}'s number and currency conventions; write it without digit grouping`)
  throw firstError ?? new MoneyError('unexpected-text', `${JSON.stringify(text)} is not an amount in ${opts.locale}`)
}

interface Decimal { neg: boolean; int: string; frac: string }
/** One key per exact value: no leading zeros in the integer part, no trailing zeros in the fraction, no sign on zero. */
function decimalKey(d: Decimal): string {
  const int = d.int.replace(/^0+(?=\d)/, ''), frac = d.frac.replace(/0+$/, '')
  return `${d.neg && /[1-9]/.test(int + frac) ? '-' : ''}${int}.${frac}`
}

/** A number written with one style's separators (the unit and letters already removed), as sign and digit strings. */
function readNumber(input: string, sym: StyleSymbols, text: string, opts: ParseOptions): Decimal {
  let s = input
  const spaceGroup = /^\s$/.test(sym.group)
  const groupChars = sym.group === "'" ? "'\u2019" : sym.group
  const G = '\u0001'
  if (spaceGroup) s = s.replace(/(?<=\d)\s+(?=\d)/g, G)
  else s = s.replace(new RegExp(`[${esc(groupChars)}]`, 'g'), G)
  if (/\d\s+\d/.test(s)) throw new MoneyError('bad-grouping', `${JSON.stringify(text)}: a space inside the number is not this locale's digit grouping`)
  s = s.replace(/\s+/g, '')
  const minusChars = new Set(['-', '\u2212', '\u2012', '\u2013', '\uFE63', '\uFF0D', sym.minus])
  let neg = false
  const signAt = (c: string | undefined): 'minus' | 'plus' | null => (c === undefined ? null : minusChars.has(c) ? 'minus' : c === '+' ? 'plus' : null)
  const head = signAt(s[0]), tail = signAt(s[s.length - 1])
  if (head && tail) throw new MoneyError('bad-sign', `${JSON.stringify(text)} has two signs`)
  if (head) { neg = head === 'minus'; s = s.slice(1) } else if (tail) { neg = tail === 'minus'; s = s.slice(0, -1) }
  const D = sym.decimal
  const core = new RegExp(`^([0-9${G}]*)(?:${esc(D)}([0-9]+))?$`).exec(s)
  if (!core || !/[0-9]/.test(s)) throw new MoneyError('unexpected-text', `${JSON.stringify(text)} is not an amount in ${opts.locale}`)
  const intPart = core[1]!, frac = core[2] ?? ''
  if (intPart.includes(G)) {
    const groups = intPart.split(G)
    const last = groups[groups.length - 1]!, first = groups[0]!
    const middleOk = groups.slice(1, -1).every((g) => g.length === sym.secondary)
    if (last.length !== sym.primary || !middleOk || first.length < 1 || first.length > sym.secondary) {
      throw new MoneyError('bad-grouping', `${JSON.stringify(text)}: digit groups are not where ${opts.locale} puts them (decimal separator "${D}")`)
    }
  }
  const int = intPart.split(G).join('') || '0'
  return { neg, int, frac }
}

// ───────────────────────────────────────────────────────────── rates and conversion

/** Kept apart on purpose (R7 D8, R10 section 8): what each kind of figure may be used for is in KINDS_FOR_USE. */
export type RateKind = 'indicative' | 'executable' | 'fill' | 'valuation' | 'reference' | 'projection'
/** Where a figure comes from (R7 D5), plus 'fixture' for a test setting. */
export type DataLabel = 'chain' | 'observation' | 'sandbox' | 'synthetic' | 'historical' | 'fixture'
export type RateUse = 'display' | 'valuation' | 'authority' | 'execution' | 'settlement' | 'projection'
export type Bound = 'lo' | 'mid' | 'hi'

export const KINDS_FOR_USE: Readonly<Record<RateUse, readonly RateKind[]>> = {
  display: ['indicative', 'executable', 'fill', 'valuation', 'reference', 'projection'],
  valuation: ['valuation', 'fill', 'executable', 'indicative', 'reference'],
  authority: ['reference', 'executable', 'fill'],
  execution: ['executable'],
  settlement: ['fill'],
  projection: ['projection', 'valuation', 'reference', 'indicative'],
}

/** Quote units per one base unit, in whole units of each (EUR/USD 1.0850: base EUR, quote USD). */
export interface Rate {
  readonly base: InstrumentId
  readonly quote: InstrumentId
  readonly kind: RateKind
  /** The band the figure is known to lie in: bid and ask, a quote's own price, a reference band, a scenario range. */
  readonly lo: Ratio
  readonly mid: Ratio
  readonly hi: Ratio
  /** Provider and method, in words ("ECB euro reference rate, 16:00 CET", "the test market's genesis rate"). */
  readonly source: string
  readonly label: DataLabel
  /** When the source says the figure was true (Unix ms, UTC). */
  readonly observedAt: number
  /** After this instant the figure may not be used for anything but history. */
  readonly validUntil: number
  /** MIC, or a CAIP-10 account for an on-chain pool, when the figure belongs to one venue. */
  readonly venue?: string
  /** Projections only: the scenario that produced it. */
  readonly scenario?: string
}

export interface RateInput {
  base: InstrumentId; quote: InstrumentId; kind: RateKind
  mid: Ratio | string; lo?: Ratio | string; hi?: Ratio | string
  source: string; label: DataLabel; observedAt: number; validUntil: number; venue?: string; scenario?: string
}

const asRatio = (x: Ratio | string): Ratio => (typeof x === 'string' ? parseRatio(x) : ratio(x.n, x.d))

export function makeRate(r: RateInput): Rate {
  const mid = asRatio(r.mid), lo = asRatio(r.lo ?? r.mid), hi = asRatio(r.hi ?? r.mid)
  parseInstrumentId(r.base); parseInstrumentId(r.quote)
  if (r.base === r.quote) throw new MoneyError('invalid-rate', 'a rate needs two different instruments')
  if (lo.n <= 0n) throw new MoneyError('invalid-rate', 'a rate must be positive')
  if (cmpRatio(lo, mid) > 0 || cmpRatio(mid, hi) > 0) throw new MoneyError('invalid-rate', 'a rate needs lo ≤ mid ≤ hi')
  if (r.kind === 'fill' && (cmpRatio(lo, hi) !== 0)) throw new MoneyError('invalid-rate', 'a fill happened at one price: lo, mid and hi must be equal')
  if (r.kind === 'projection' && !r.scenario) throw new MoneyError('invalid-rate', 'a projection names its scenario')
  if (r.kind !== 'projection' && r.scenario) throw new MoneyError('invalid-rate', 'only a projection has a scenario')
  if (!Number.isFinite(r.observedAt) || !Number.isFinite(r.validUntil) || r.validUntil < r.observedAt) throw new MoneyError('invalid-rate', 'a rate is valid from when it was observed until a later instant')
  if (!r.source.trim()) throw new MoneyError('invalid-rate', 'a rate names its source')
  return Object.freeze({ base: r.base, quote: r.quote, kind: r.kind, lo, mid, hi, source: r.source, label: r.label, observedAt: r.observedAt, validUntil: r.validUntil, ...(r.venue ? { venue: r.venue } : {}), ...(r.scenario ? { scenario: r.scenario } : {}) })
}

/** The same figure the other way round, exactly: base and quote swap, and the band's ends swap. */
export function invertRate(r: Rate): Rate {
  return Object.freeze({ ...r, base: r.quote, quote: r.base, lo: invRatio(r.hi), mid: invRatio(r.mid), hi: invRatio(r.lo) })
}

/** The rate in minor units of the quote per minor unit of the base (the form R7 D7's reference bands use). */
export function atomicRatio(r: Rate, bound: Bound, base: Instrument, quote: Instrument): Ratio {
  if (base.id !== r.base || quote.id !== r.quote) throw new MoneyError('instrument-mismatch', `${r.base}/${r.quote} is not ${base.id}/${quote.id}`)
  const x = r[bound]
  return ratio(x.n * pow10(quote.exponent), x.d * pow10(base.exponent))
}

export interface ConvertOptions {
  /** The decision time (Unix ms). The rate must have been observed by then and still be valid. */
  at: number
  use: RateUse
  bound: Bound
  rounding: RoundingMode
}

export interface Conversion {
  readonly from: Amount
  readonly to: Amount
  /** The unrounded result in minor units of the target, and what rounding took off it (exact − to). */
  readonly exact: Ratio
  readonly remainder: Ratio
  readonly rate: Rate
  /** True when the rate was quoted the other way round and inverted exactly. */
  readonly inverted: boolean
  readonly bound: Bound
  readonly rounding: RoundingMode
  readonly use: RateUse
  readonly at: number
}

function usable(r: Rate, at: number, use: RateUse): void {
  if (!KINDS_FOR_USE[use].includes(r.kind)) throw new MoneyError('kind-not-allowed', `a ${r.kind} figure may not be used for ${use}`)
  if (at < r.observedAt) throw new MoneyError('rate-from-the-future', `the rate was observed at ${new Date(r.observedAt).toISOString()}, after the decision time ${new Date(at).toISOString()}`)
  if (at > r.validUntil) throw new MoneyError('stale-rate', `the rate expired at ${new Date(r.validUntil).toISOString()}; the decision time is ${new Date(at).toISOString()}`)
}

/** Convert an amount with a rate quoted either way round, naming the end of the band and the rounding. */
export function convert(a: Amount, rate: Rate, from: Instrument, to: Instrument, opts: ConvertOptions): Conversion {
  if (from.id !== a.instrument || from.exponent !== a.exponent) throw new MoneyError('instrument-mismatch', `the amount is ${a.instrument}@${a.exponent}, not ${from.id}@${from.exponent}`)
  let r = rate, inverted = false
  if (r.base === to.id && r.quote === from.id) { r = invertRate(rate); inverted = true }
  if (r.base !== from.id || r.quote !== to.id) throw new MoneyError('instrument-mismatch', `a ${rate.base}/${rate.quote} rate cannot convert ${from.id} into ${to.id}`)
  usable(rate, opts.at, opts.use)
  const x = r[opts.bound]
  const num = a.minor * x.n * pow10(to.exponent), den = x.d * pow10(from.exponent)
  const minor = divRound(num, den, opts.rounding)
  const exact = ratio(num, den)
  return Object.freeze({
    from: a, to: amount(to, minor), exact, remainder: ratio(exact.n - minor * exact.d, exact.d),
    rate, inverted, bound: opts.bound, rounding: opts.rounding, use: opts.use, at: opts.at,
  })
}

/**
 * The least an amount is worth in another instrument under a rate's band: an asset at the band's low end, a
 * liability (a negative amount) at its high end, both rounded toward minus infinity.
 */
export function conservativeValue(a: Amount, rate: Rate, from: Instrument, to: Instrument, at: number, use: RateUse = 'valuation'): Conversion {
  // convert() orients the rate as from → to first (inverting it exactly when needed, which swaps the band's ends), and
  // the bound names an end of that oriented band: the low end is the least value of a positive amount, the high end
  // the least (most negative) value of a negative one.
  return convert(a, rate, from, to, { at, use, bound: a.minor >= 0n ? 'lo' : 'hi', rounding: 'floor' })
}

// ───────────────────────────────────────────────────────────── exposure

export interface ExposureLine {
  /** Positive: held or owed to the owner. Negative: owed by the owner, or committed to go out. */
  readonly amount: Amount
  /** Where it sits: "bank:…", "chain:eip155:31337", "broker:…", "pending:…". */
  readonly rail: string
}

export interface ExposureOptions {
  numeraire: Instrument
  at: number
  rates: readonly Rate[]
  registry: Registry
  /** A haircut in basis points for a line (0 to 10,000): it lowers an asset and deepens a liability. Default none. */
  haircutBps?: (line: ExposureLine) => number
}

export interface ExposureValue { readonly line: ExposureLine; readonly value: Amount | null; readonly rate: Rate | null; readonly why: string }
export interface ExposureResult {
  readonly numeraire: InstrumentId
  /** The sum of every line that could be valued, conservatively. */
  readonly total: Amount
  /** False when a liability could not be valued (no usable rate): the total leaves it out and must not be used to decide. */
  readonly complete: boolean
  readonly byRail: ReadonlyMap<string, Amount>
  readonly byInstrument: ReadonlyMap<InstrumentId, Amount>
  readonly lines: readonly ExposureValue[]
}

/**
 * Aggregate positions across instruments and rails into one numeraire, conservatively: each line at the band's worse
 * end for its sign (the lowest of several usable rates for an asset, the highest for a liability), rounded down, less
 * its haircut. An asset with no usable rate counts as zero; a liability with no usable rate makes the result
 * incomplete. Stale and not-yet-observed rates are not usable. No triangulation through a third currency here.
 */
export function aggregateExposure(lines: readonly ExposureLine[], opts: ExposureOptions): ExposureResult {
  const N = opts.numeraire
  const values: ExposureValue[] = []
  let total = amount(N, 0n)
  let complete = true
  const byRail = new Map<string, Amount>(), byInstrument = new Map<InstrumentId, Amount>()
  for (const line of lines) {
    const inst = opts.registry.instrument(line.amount.instrument)
    let best: { v: Amount; rate: Rate | null } | null = null
    if (inst.id === N.id) best = { v: line.amount, rate: null }
    else {
      for (const r of opts.rates) {
        const pair = (r.base === inst.id && r.quote === N.id) || (r.base === N.id && r.quote === inst.id)
        if (!pair) continue
        let c: Conversion
        try { c = conservativeValue(line.amount, r, inst, N, opts.at) } catch { continue }
        if (!best || c.to.minor < best.v.minor) best = { v: c.to, rate: r }
      }
    }
    if (!best) {
      if (line.amount.minor < 0n) complete = false
      values.push({ line, value: null, rate: null, why: line.amount.minor < 0n ? 'a liability with no usable rate: the total is incomplete' : 'no usable rate: counted as zero' })
      continue
    }
    const h = opts.haircutBps?.(line) ?? 0
    if (!Number.isInteger(h) || h < 0 || h > 10_000) throw new RangeError(`haircut ${h} bps`)
    const factor = best.v.minor >= 0n ? 10_000n - BigInt(h) : 10_000n + BigInt(h)
    const v = amount(N, divRound(best.v.minor * factor, 10_000n, 'floor'))
    values.push({ line, value: v, rate: best.rate, why: best.rate ? `${best.rate.kind} rate from ${best.rate.source}, ${h} bps haircut` : `already in ${N.id}, ${h} bps haircut` })
    total = addAmounts(total, v)
    byRail.set(line.rail, addAmounts(byRail.get(line.rail) ?? amount(N, 0n), v))
    byInstrument.set(inst.id, addAmounts(byInstrument.get(inst.id) ?? amount(N, 0n), v))
  }
  return Object.freeze({ numeraire: N.id, total, complete, byRail, byInstrument, lines: values })
}
