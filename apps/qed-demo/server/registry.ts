/**
 * What the wallet can hold, price and trade, and the sourced terms it relies on.
 *
 * Every row here is reference data, not a market price. Prices come only from the providers in market.ts.
 * Terms carry a status: "verified" (read from the cited primary source on the given date), "unverified"
 * (plausible, source not yet confirmed) or "modelled" (QED's own modelling assumption). The interface shows the status.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type InstrumentId, iso4217Entries, NETWORKS, parseInstrumentId } from '../shared/instrument.ts'
import { audit, type Db, j } from './core.ts'

/**
 * instrumentId: the asset's canonical instrument id (ADR-0012), which the books write beside asset_id since schema v5
 * (stage S2 of the global money model). What a paper venue holds is a claim on that venue, not the coin or the fund unit
 * itself. null only for PCT, the unit rates are quoted in: it is not an instrument, and no account is opened in it.
 */
export interface AssetDef { id: string; kind: 'fiat' | 'crypto' | 'fund_unit' | 'security_unit'; name: string; scale: number; instrumentId: InstrumentId | null }
/** etf and equity trade on the paper exchange; tbill and gsec on the paper government-securities desk (R13, audit G2). */
export type InstrumentKind = 'crypto_spot' | 'crypto_reference' | 'mutual_fund' | 'fx_reference' | 'rate' | 'etf' | 'equity' | 'tbill' | 'gsec'

export interface InstrumentMeta {
  // crypto_spot
  pair?: string; market?: string; qtyStep?: string; priceTick?: string; minNotional?: string; maxMarketQty?: string
  // mutual_fund
  schemeCode?: number; category?: 'index' | 'liquid' | 'overnight' | 'money-market' | 'gold' | 'international' | 'flexi' | 'arbitrage' | 'gilt' | 'index-etf' | 'gold-etf' | 'large-cap' | 'treasury-bill' | 'government-bond'
  cutoff?: string; navRule?: 'same-day' | 'liquid-previous-day'; payoutDays?: number; exitLoad?: string; minAmount?: string
  // etf, equity, tbill, gsec (server/securities.ts)
  /** The smallest tradable quantity and the step above it, in units (a debt unit is Rs 100 of face value). */
  lot?: string
  hours?: { open: string; close: string }
  /** Business days between the trade and the money or the units being final (T+1 is 1). */
  settlementDays?: number
  /** Which securities transaction tax row applies: 'equity-delivery', 'equity-etf' or 'none'. */
  sttClass?: 'equity-delivery' | 'equity-etf' | 'none'
  /** Where the synthetic series starts: a recorded public value with its date and source, or a round number. */
  anchor?: { value: string; basis: 'recorded' | 'round'; date?: string; source: string }
  /** Daily volatility of the synthetic walk (equities, ETFs) or of the yield in percentage points (debt). */
  vol?: number
  /** Debt: yield a year at the start, coupon a year (0 for a bill), maturity and issue dates. */
  debt?: { yield: number; coupon: number; maturity: string; issued: string; faceLot: number }
  // all
  /** Oldest price (ms) an execution may rely on; older means the action is refused or deferred. */
  execMaxAgeMs?: number
  /** Age (ms) after which the interface marks the value stale. */
  staleAfterMs?: number
  /** The term that holds this instrument's worst-case fall used by the protection floor. */
  limitTerm?: string
  /** Independent price used to sanity-check this instrument before autonomous execution. */
  crossCheck?: { instrumentId: string; via?: string; maxDivergenceBps: number }
  note?: string
}

export interface InstrumentDef {
  id: string; kind: InstrumentKind; name: string; base: string; quote: string; provider: string; venue: string; symbol: string; tradable: boolean; meta: InstrumentMeta
}

export const ASSETS: AssetDef[] = [
  { id: 'INR', kind: 'fiat', name: 'Indian rupee', scale: 2, instrumentId: 'iso4217:INR' },
  { id: 'USD', kind: 'fiat', name: 'US dollar', scale: 2, instrumentId: 'iso4217:USD' },
  { id: 'EUR', kind: 'fiat', name: 'Euro', scale: 2, instrumentId: 'iso4217:EUR' },
  // R13: the paper bank's foreign-currency balances (server/fx.ts). Each scale is the currency's ISO 4217 minor unit, which
  // INSTRUMENT_OF below checks against List One when the module loads: JPY 0, BHD 3.
  { id: 'GBP', kind: 'fiat', name: 'Pound sterling', scale: 2, instrumentId: 'iso4217:GBP' },
  { id: 'AED', kind: 'fiat', name: 'UAE dirham', scale: 2, instrumentId: 'iso4217:AED' },
  { id: 'SGD', kind: 'fiat', name: 'Singapore dollar', scale: 2, instrumentId: 'iso4217:SGD' },
  { id: 'JPY', kind: 'fiat', name: 'Japanese yen', scale: 0, instrumentId: 'iso4217:JPY' },
  { id: 'BHD', kind: 'fiat', name: 'Bahraini dinar', scale: 3, instrumentId: 'iso4217:BHD' },
  { id: 'PCT', kind: 'fiat', name: 'Percent a year', scale: 4, instrumentId: null },
  // Balances on the paper exchange's own ledger (the venue's coin codes), not coins on a chain.
  { id: 'BTC', kind: 'crypto', name: 'Bitcoin', scale: 8, instrumentId: 'claim:paper-crypto/BTC' },
  { id: 'ETH', kind: 'crypto', name: 'Ether', scale: 8, instrumentId: 'claim:paper-crypto/ETH' },
  { id: 'USDT', kind: 'crypto', name: 'Tether USD', scale: 6, instrumentId: 'claim:paper-crypto/USDT' },
  // Never held: only priced, from Binance's PAXG/USDT book, so a claim at that exchange.
  { id: 'PAXG', kind: 'crypto', name: 'PAX Gold', scale: 8, instrumentId: 'claim:binance/PAXG' },
]

/** What the paper exchange and the paper government-securities desk hold for a customer: claims on that venue, whole units. */
export const SECURITY_UNITS: AssetDef[] = [
  { id: 'EQ:NIFTYBEES', kind: 'security_unit', name: 'Units of Nippon India ETF Nifty 50 BeES', scale: 0, instrumentId: 'claim:paper-exchange/NIFTYBEES' },
  { id: 'EQ:GOLDBEES', kind: 'security_unit', name: 'Units of Nippon India ETF Gold BeES', scale: 0, instrumentId: 'claim:paper-exchange/GOLDBEES' },
  { id: 'EQ:RELIANCE', kind: 'security_unit', name: 'Shares of Reliance Industries', scale: 0, instrumentId: 'claim:paper-exchange/RELIANCE' },
  { id: 'EQ:TCS', kind: 'security_unit', name: 'Shares of Tata Consultancy Services', scale: 0, instrumentId: 'claim:paper-exchange/TCS' },
  { id: 'EQ:HDFCBANK', kind: 'security_unit', name: 'Shares of HDFC Bank', scale: 0, instrumentId: 'claim:paper-exchange/HDFCBANK' },
  { id: 'GS:TB91', kind: 'security_unit', name: 'Rs 100 of face value of the 91-day Treasury bill', scale: 0, instrumentId: 'claim:paper-gsec/TB91' },
  { id: 'GS:GS2036', kind: 'security_unit', name: 'Rs 100 of face value of the 2036 government bond', scale: 0, instrumentId: 'claim:paper-gsec/GS2036' },
]

const fund = (code: number, name: string, category: NonNullable<InstrumentMeta['category']>, extra: Partial<InstrumentMeta> = {}): InstrumentDef => {
  const liquidLike = category === 'liquid' || category === 'overnight'
  return {
    id: `amfi:${code}`, kind: 'mutual_fund', name, base: `MF:${code}`, quote: 'INR', provider: 'amfi', venue: 'paper-mf', symbol: String(code), tradable: true,
    meta: {
      schemeCode: code, category,
      cutoff: liquidLike ? '13:30' : '15:00',
      navRule: liquidLike ? 'liquid-previous-day' : 'same-day',
      payoutDays: liquidLike ? 1 : category === 'international' ? 3 : 2,
      exitLoad: liquidLike && category === 'liquid' ? 'mf.exitload.liquid' : 'mf.exitload.none',
      minAmount: '100',
      staleAfterMs: 4 * 86_400_000,
      limitTerm: `limit.amfi:${code}`,
      ...extra,
    },
  }
}

const AMFI_NAVALL = 'AMFI NAVAll.txt (portal.amfiindia.com/spages/NAVAll.txt), read on 24 Nov 2026'
const HOURS = { open: '09:15', close: '15:30' }
const sec = (id: string, kind: 'etf' | 'equity' | 'tbill' | 'gsec', name: string, code: string, venue: 'paper-exchange' | 'paper-gsec', meta: InstrumentMeta): InstrumentDef => ({
  id, kind, name, base: `${venue === 'paper-exchange' ? 'EQ' : 'GS'}:${code}`, quote: 'INR', provider: 'synthetic-markets', venue, symbol: code, tradable: true,
  meta: { execMaxAgeMs: 15_000, staleAfterMs: 30_000, limitTerm: `limit.${id}`, settlementDays: 1, lot: '1', qtyStep: '1', ...meta },
})
const SECURITIES: InstrumentDef[] = [
  sec('xchg:NIFTYBEES', 'etf', 'Nippon India ETF Nifty 50 BeES (paper)', 'NIFTYBEES', 'paper-exchange', { category: 'index-etf', hours: HOURS, sttClass: 'equity-etf',
    anchor: { value: '289.3289', basis: 'recorded', date: '2026-11-23', source: `${AMFI_NAVALL}: scheme 140084, the fund's NAV, not an exchange price. Every later price is synthetic` }, vol: 0.009,
    note: 'Tracks the Nifty 50 index. Synthetic prices: the exchange price of this ETF is not used.' }),
  sec('xchg:GOLDBEES', 'etf', 'Nippon India ETF Gold BeES (paper)', 'GOLDBEES', 'paper-exchange', { category: 'gold-etf', hours: HOURS, sttClass: 'none',
    anchor: { value: '102.6890', basis: 'recorded', date: '2026-11-23', source: `${AMFI_NAVALL}: scheme 140088, the fund's NAV, not an exchange price. Every later price is synthetic` }, vol: 0.009,
    note: 'Tracks the price of gold in rupees. Synthetic prices: the exchange price of this ETF is not used.' }),
  sec('xchg:RELIANCE', 'equity', 'Reliance Industries (paper)', 'RELIANCE', 'paper-exchange', { category: 'large-cap', hours: HOURS, sttClass: 'equity-delivery',
    anchor: { value: '1000.00', basis: 'round', source: 'A round starting value chosen by QED; not the company\'s share price. Every price is synthetic' }, vol: 0.016 }),
  sec('xchg:TCS', 'equity', 'Tata Consultancy Services (paper)', 'TCS', 'paper-exchange', { category: 'large-cap', hours: HOURS, sttClass: 'equity-delivery',
    anchor: { value: '3000.00', basis: 'round', source: 'A round starting value chosen by QED; not the company\'s share price. Every price is synthetic' }, vol: 0.014 }),
  sec('xchg:HDFCBANK', 'equity', 'HDFC Bank (paper)', 'HDFCBANK', 'paper-exchange', { category: 'large-cap', hours: HOURS, sttClass: 'equity-delivery',
    anchor: { value: '1500.00', basis: 'round', source: 'A round starting value chosen by QED; not the company\'s share price. Every price is synthetic' }, vol: 0.014 }),
  sec('gsec:TB91', 'tbill', '91-day Treasury bill, issued 20 Nov 2026, matures 19 Feb 2027 (paper)', 'TB91', 'paper-gsec', { category: 'treasury-bill', hours: { open: '09:00', close: '17:00' }, lot: '100', qtyStep: '100', sttClass: 'none', vol: 0.02,
    anchor: { value: '5.40', basis: 'round', source: 'A round yield chosen by QED, a year, simple interest; not an auction result. Every price is synthetic' }, debt: { yield: 5.4, coupon: 0, maturity: '2027-02-19', issued: '2026-11-20', faceLot: 10_000 },
    note: 'A bill pays no interest: you buy below Rs 100 of face value and it pays Rs 100 on the maturity date. Redeeming at maturity is a sale at face value on paper.' }),
  sec('gsec:GS2036', 'gsec', 'Government of India 6.50% bond maturing 15 May 2036 (paper)', 'GS2036', 'paper-gsec', { category: 'government-bond', hours: { open: '09:00', close: '17:00' }, lot: '100', qtyStep: '100', sttClass: 'none', vol: 0.04,
    anchor: { value: '6.45', basis: 'round', source: 'A round yield chosen by QED, a year; not a market yield. Every price is synthetic' }, debt: { yield: 6.45, coupon: 6.5, maturity: '2036-05-15', issued: '2026-05-15', faceLot: 10_000 },
    note: 'Pays a coupon every six months. The price shown includes interest accrued since the last coupon. Its price falls when yields rise.' }),
]

const inrCrypto = (market: string, base: string, name: string): InstrumentDef => ({
  id: `coindcx:${market}`, kind: 'crypto_spot', name, base, quote: 'INR', provider: 'coindcx', venue: 'paper-crypto', symbol: market, tradable: true,
  meta: {
    pair: `I-${base}_INR`, market, execMaxAgeMs: 15_000, staleAfterMs: 30_000, limitTerm: `limit.coindcx:${market}`,
    crossCheck: base === 'USDT' ? undefined : { instrumentId: `binance:${base}USDT`, via: 'coindcx:USDTINR', maxDivergenceBps: 300 },
  },
})

const ref = (id: string, kind: InstrumentKind, name: string, base: string, quote: string, provider: string, symbol: string, meta: InstrumentMeta = {}): InstrumentDef =>
  ({ id, kind, name, base, quote, provider, venue: provider, symbol, tradable: false, meta })

export const INSTRUMENTS: InstrumentDef[] = [
  inrCrypto('BTCINR', 'BTC', 'Bitcoin in rupees'),
  inrCrypto('ETHINR', 'ETH', 'Ether in rupees'),
  inrCrypto('USDTINR', 'USDT', 'Tether in rupees'),
  ref('binance:BTCUSDT', 'crypto_reference', 'Bitcoin / USDT (Binance)', 'BTC', 'USDT', 'binance', 'BTCUSDT', { staleAfterMs: 10_000 }),
  ref('binance:ETHUSDT', 'crypto_reference', 'Ether / USDT (Binance)', 'ETH', 'USDT', 'binance', 'ETHUSDT', { staleAfterMs: 10_000 }),
  ref('binance:PAXGUSDT', 'crypto_reference', 'PAX Gold / USDT (Binance)', 'PAXG', 'USDT', 'binance', 'PAXGUSDT', { staleAfterMs: 60_000, note: 'A gold-backed token. It tracks spot gold with its own basis and issuer risk.' }),
  ref('coinbase:BTCUSD', 'crypto_reference', 'Bitcoin / USD (Coinbase)', 'BTC', 'USD', 'coinbase', 'BTC-USD', { staleAfterMs: 60_000 }),
  fund(120716, 'UTI Nifty 50 Index Fund (Direct, Growth)', 'index'),
  fund(120684, 'ICICI Prudential Nifty Next 50 Index Fund (Direct, Growth)', 'index'),
  fund(122639, 'Parag Parikh Flexi Cap Fund (Direct, Growth)', 'flexi'),
  fund(148381, 'Motilal Oswal S&P 500 Index Fund (Direct, Growth)', 'international'),
  fund(119788, 'SBI Gold Fund (Direct, Growth)', 'gold'),
  fund(118701, 'Nippon India Liquid Fund (Direct, Growth)', 'liquid'),
  fund(119110, 'HDFC Overnight Fund (Direct, Growth)', 'overnight'),
  fund(119771, 'Kotak Arbitrage Fund (Direct, Growth)', 'arbitrage'),
  // A money-market fund: a mutual fund, so it runs on the existing fund path. Scheme code and name read from AMFI's NAVAll.txt
  // (portal.amfiindia.com/spages/NAVAll.txt) on 24 Nov 2026: "118719; Nippon India Money Market Fund; Direct Plan; Growth Option".
  fund(118719, 'Nippon India Money Market Fund (Direct, Growth)', 'money-market', { payoutDays: 1, note: 'Invests in money-market instruments of up to one year. Its NAV can fall slightly when rates rise; it is not a bank deposit.' }),
  ...SECURITIES,
  ref('ecb:USDINR', 'fx_reference', 'US dollar in rupees (ECB reference)', 'USD', 'INR', 'frankfurter', 'USD/INR', { staleAfterMs: 4 * 86_400_000, note: 'A once-a-day reference rate. Nobody can trade at it.' }),
  ref('ecb:EURINR', 'fx_reference', 'Euro in rupees (ECB reference)', 'EUR', 'INR', 'frankfurter', 'EUR/INR', { staleAfterMs: 4 * 86_400_000, note: 'A once-a-day reference rate. Nobody can trade at it.' }),
  ref('nyfed:SOFR', 'rate', 'SOFR, US secured overnight rate', 'PCT', 'USD', 'nyfed', 'SOFR', { staleAfterMs: 5 * 86_400_000 }),
  ref('nyfed:EFFR', 'rate', 'EFFR, US federal funds effective rate', 'PCT', 'USD', 'nyfed', 'EFFR', { staleAfterMs: 5 * 86_400_000 }),
]

/** Units of each fund, as the paper fund registrar holds them: claims on that venue, by scheme code. */
export const FUND_UNITS: AssetDef[] = INSTRUMENTS.filter((i) => i.kind === 'mutual_fund')
  .map((i): AssetDef => ({ id: i.base, kind: 'fund_unit', name: `Units of ${i.name}`, scale: 3, instrumentId: `claim:${i.venue}/${i.symbol}` }))

/**
 * Asset id to canonical instrument id, built when the module loads. An id that parseInstrumentId does not read back
 * unchanged, a currency outside ISO 4217 List One or with a minor unit other than the asset's scale, or one id given to two
 * assets stops the service, as a broken limits file does.
 */
const INSTRUMENT_OF: ReadonlyMap<string, InstrumentId | null> = (() => {
  const minorUnit = new Map(iso4217Entries().map((e) => [e.code, e.minorUnit]))
  const out = new Map<string, InstrumentId | null>()
  const given = new Set<InstrumentId>()
  for (const a of [...ASSETS, ...FUND_UNITS, ...SECURITY_UNITS]) {
    if (a.instrumentId !== null) {
      const p = parseInstrumentId(a.instrumentId)
      if (p.id !== a.instrumentId) throw new Error(`asset ${a.id}: ${a.instrumentId} is not canonical (${p.id})`)
      if (p.kind === 'fiat' && minorUnit.get(p.code) !== a.scale) throw new Error(`asset ${a.id}: ${a.instrumentId} is not an ISO 4217 currency with ${a.scale} decimals`)
      if (given.has(a.instrumentId)) throw new Error(`asset ${a.id}: ${a.instrumentId} is given to another asset too`)
      given.add(a.instrumentId)
    }
    out.set(a.id, a.instrumentId)
  }
  return out
})()

/**
 * The canonical instrument id the books write beside this asset id: null for PCT, and for an asset this registry does not
 * define. One kind more is known at run time (R13, server/chain-books.ts): a test token of the on-chain wallet, whose asset
 * id is its own CAIP-19 id (eip155:31337/erc20:<contract>), because its contract address comes from the wallet service's
 * chain. Only on a network registered as a test fixture (shared/instrument.ts NETWORKS): a token on a real network is not
 * booked, so it gets null.
 */
export const assetInstrumentId = (assetId: string): InstrumentId | null => INSTRUMENT_OF.get(assetId) ?? testTokenId(assetId)
function testTokenId(assetId: string): InstrumentId | null {
  try {
    const p = parseInstrumentId(assetId)
    return p.kind === 'token' && p.namespace === 'erc20' && p.id === assetId && NETWORKS.some((n) => n.id === p.network && n.fixture) ? p.id : null
  } catch { return null }
}

export interface TermDef { id: string; kind: 'rate' | 'fee' | 'rule' | 'limit'; name: string; value: unknown; source: string; url?: string; asOf: string; status: 'verified' | 'unverified' | 'modelled' | 'calibrated' }

/**
 * Limits calibrated by experiment X9 (server/limits.calibrated.json, written by scripts/import-limits.ts from the run's own
 * file, whose hash it records). Each replaces the illustrative placeholder of the same id. A missing or broken file is a
 * packaging fault and stops the service, rather than silently falling back to placeholders.
 */
export const CALIBRATED: TermDef[] = (JSON.parse(readFileSync(join(import.meta.dirname, 'limits.calibrated.json'), 'utf8')) as { terms: TermDef[] }).terms
/** Calibrated and verified limits are measured; any other status is illustrative. */
export const isCalibrated = (status: string | undefined): boolean => status === 'verified' || status === 'calibrated'

/**
 * Seed terms. Rows marked "unverified" are replaced when the entitlement study or a calibration supplies a sourced
 * value; nothing in the interface presents an unverified or modelled row as fact.
 */
/**
 * How the paper exchange and the government-securities desk charge, settle and keep hours. Each row carries its status.
 * Read from a primary source on 24 Nov 2026 ("verified"): the exchange's and SEBI's charges, securities transaction tax, stamp
 * duty, trading hours, T+1 settlement. Still not verified, each with its reason in the row: GST on the exchange's and SEBI's
 * charges, the government-securities desk's hours and spread, tax on bill interest. Modelled, with no rule to read: the broker's
 * brokerage and the depository participant's charge. Market holidays are not modelled at all. Each row is applied as written
 * at execution, and the interface shows its status. Replace a row, with its source and date, to change it.
 */
const SECURITY_TERMS: TermDef[] = [
  { id: 'fee.exchange.brokerage', kind: 'fee', name: 'Paper broker: 0.03% of the trade, at most ₹20 an order', value: { rate: '0.0003', capPaise: 2000 }, source: 'QED model of a discount broker\'s schedule; no primary source read', asOf: '2026-11-24', status: 'modelled' },
  { id: 'fee.exchange.charges', kind: 'fee', name: 'Exchange charges on each side of a trade: NSE ₹307 per crore (0.00307%: ₹306.99 transaction charge and ₹0.01 contribution to its Investor Protection Fund Trust) and the SEBI turnover fee ₹10 per crore (0.0001%)', value: { txnRate: '0.0000307', sebiRate: '0.000001' }, source: 'NSE circular NSE/FA/73061 of 27 Feb 2026, table: cash market, revised outflow, total ₹307 each side per crore of traded value, with effect from 1 Mar 2026 (it was ₹297 plus ₹10 before: QED\'s earlier 0.00297% left out the ₹10); SEBI (Stock Brokers) Regulations, 2026, regulation 41(1), cash segment: 0.00010 per cent of turnover (Rs. 10 per crore), securities other than debt (Gazette CG-MH-E-07012026-269177, 7 Jan 2026). Read 24 Nov 2026; hashes in docs/research/qed-fin-infra-compliance/20261124-r13-primary-sources.md', url: 'https://archives.nseindia.com/content/circulars/FA73061.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'fee.exchange.gst', kind: 'fee', name: 'GST at 18% on the brokerage, the exchange charge and the SEBI fee', value: { gstOnFee: '0.18' }, source: 'Brokerage: CBIC Notification 11/2017-Central Tax (Rate), Sl. No. 15(v), "Financial and related services other than (i), (ii), (iii), and (iv) above": 9% central tax, with 9% state or union territory tax (18% in all), as the notification was first issued; its later amendments were not walked. GST on the exchange\'s charge and on the SEBI fee: the same 18% is applied, NOT VERIFIED, because no page read states it for those two', url: 'https://cbic-gst.gov.in/hindi/pdf/central-tax-rate/Notification11-CGST.pdf', asOf: '2026-11-24', status: 'unverified' },
  { id: 'fee.exchange.dp', kind: 'fee', name: 'Depository charge on each sale: ₹15.34 (₹13 and 18% GST) per security per day', value: { sellPaise: 1534 }, source: 'A modelled broker price list, not a rule: no regulation or circular sets what a depository participant charges its client, so no primary source exists to verify. Read nothing for it on 24 Nov 2026', asOf: '2026-11-24', status: 'modelled' },
  { id: 'tax.stt', kind: 'rule', name: 'Securities transaction tax: 0.1% on shares bought and on shares sold for delivery; 0.001% on the sale of an equity ETF (an equity-oriented fund unit); none on a gold ETF', value: { 'equity-delivery': '0.001', 'equity-etf': '0.00001', none: '0' }, source: 'Finance (No. 2) Act 2004, section 98, Table, serials 1, 2 and 2A as the Exchange publishes them (NSE circular NSE/FATAX/56235 of 1 Apr 2023: delivery purchase 0.1% by the purchaser, delivery sale 0.1% by the seller, sale of an equity-oriented fund unit on delivery 0.001% by the seller; no row for a gold ETF unit). The later amendments, Finance (No. 2) Act 2024 section 162 and Finance Act 2026 section 159, change serial 4 (options and futures) only; both read in the Gazette 24 Nov 2026. The Act\'s own Table was not opened (the Income Tax Department\'s site refused automated reading)', url: 'https://archives.nseindia.com/content/circulars/FATAX56235.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'tax.stamp.exchange', kind: 'fee', name: 'Stamp duty on a purchase of listed shares or ETF units: 0.015%', value: { buyRate: '0.00015' }, source: 'Indian Stamp Act 1899 Schedule I as amended by the Finance Act 2019, in force from 1 July 2020, as SEBI\'s FAQ on the Act lists it: transfer of a security other than a debenture, on delivery basis, 0.015%, payable by the buyer (government securities 0%). SEBI\'s FAQ read 24 Nov 2026; the Act\'s Schedule I itself was not opened (India Code refused the connection)', url: 'https://www.sebi.gov.in/sebi_data/faqfiles/dec-2021/1639980911330.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'rule.exchange.hours', kind: 'rule', name: 'Exchange trading hours: 9:15 am to 3:30 pm India time, Monday to Friday. Exchange holidays are not modelled. For the stocks that have derivatives the exchange now ends continuous trading earlier and closes with an auction inside that window; QED\'s paper exchange does not model the auction', value: { open: '09:15', close: '15:30' }, source: 'NSE circular NSE/CMTR/72349 of 16 Jan 2026 ("standard market timings": Normal Market 09:15 to 15:30); NSE circular NSE/CMTR/75479 of 30 Jul 2026 (Closing Auction Session live from 3 Aug 2026; its mock-session table has normal-market close for those stocks at 15:15, the auction from 15:20 and the market close at 15:30). The exchange\'s holiday calendar was not read', url: 'https://archives.nseindia.com/content/circulars/CMTR72349.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'rule.exchange.settlement', kind: 'rule', name: 'Settlement T+1: the trade settles the next business day. On paper the units are credited at once; QED\'s own modelling choice is that the money from a sale reaches your bank at 10:00 on that day (SEBI\'s schedule has funds paid out to the broker by 1:30 pm; when your bank is credited is the broker\'s)', value: { days: 1 }, source: 'SEBI Master Circular for Stock Exchanges and Clearing Corporations, chapter 3 (Dec 2024 revision), paragraph 1.2 and the T+1 activity schedule, citing SEBI circular SEBI/HO/MRD2/DCAP/P/CIR/2021/628 of 7 Sep 2021; SEBI\'s Aug 2026 consultation paper states T+1 "fully implemented w.e.f January 27, 2023" and T+2 discontinued. Read 24 Nov 2026', url: 'https://www.sebi.gov.in/sebi_data/commondocs/dec-2024/RE_Chapter%203%20-%20Settlement%20FINAL_p.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'rule.gsec.hours', kind: 'rule', name: 'Government securities desk (paper): 9:00 am to 5:00 pm India time, Monday to Friday; lots of ₹10,000 face value; settlement T+1; no brokerage, the cost is the gap between buy and sell prices', value: { open: '09:00', close: '17:00', faceLot: 10_000, spreadBps: 5 }, source: 'RBI Retail Direct FAQs (page dated 12 Nov 2021, read 24 Nov 2026): minimum ₹10,000 face value for treasury bills, dated securities and State Development Loans; securities credited on the settlement date, "typically one working day after the trade date"; no fee for the account or for bids. VERIFIED from it: the lot and T+1. NOT VERIFIED: the 9:00 to 5:00 hours (the FAQ gives no secondary-market hours; no other RBI page naming them was found) and the 5 basis-point spread (QED\'s model). A bill\'s primary auction is not modelled: only secondary trading', url: 'https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=3337', asOf: '2026-11-24', status: 'unverified' },
  { id: 'tax.debt.interest', kind: 'rule', name: 'Interest and the discount on a bill are taxed as income at your slab rate; no tax is deducted at source on the paper desk', value: { rule: 'slab' }, source: 'Income-tax Act as QED understands it; NOT VERIFIED (the charging sections for interest and for a bill\'s discount were not read for this review), and this app does not compute it', asOf: '2026-11-24', status: 'unverified' },
]

export const TERMS: TermDef[] = [
  { id: 'fee.paper-crypto.taker', kind: 'fee', name: 'Paper venue fee per trade: 0.50% plus 18% GST on the fee (the entry tier of an Indian exchange\'s INR spot schedule)', value: { rate: '0.0059', base: '0.0050', gstOnFee: '0.18' }, source: 'Search excerpt of coindcx.com/vip (the page refused automated reading); entry tier for 30-day volume below ₹2 lakh. Entitlement study rule VDA-04', url: 'https://coindcx.com/vip/', asOf: '2026-11-19', status: 'unverified' },
  { id: 'tax.vda.tds', kind: 'rule', name: 'Tax deducted at source on the sale of virtual digital assets: 1% of the sale amount, even on a losing trade. The paper venue deducts on every sale; the Act\'s small-payment thresholds (₹10,000 a year, ₹50,000 for a specified person, until 31 Mar 2026) are not applied, and from 1 Apr 2026 there is none', value: { rate: '0.01', on: 'sale consideration' }, source: 'Income-tax Act 1961 section 194S(1), "one per cent. of such sum", and (3) thresholds (Finance Act 2022, Gazette CG-DL-E-30032022-234693); Income-tax Act 2025 section 393(1) Table Sl. No. 8(vi): "Any sum by way of consideration for transfer of a virtual digital asset", rate 1%, threshold limit Nil, in force from 1 Apr 2026 (Gazette CG-DL-E-22082025-265620). Read 24 Nov 2026', url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'mf.stamp', kind: 'fee', name: 'Stamp duty on mutual fund purchases: 0.005%, deducted before units are allotted', value: { rate: '0.00005' }, source: 'SEBI FAQ on the Indian Stamp Act amendments, question 21 (issue of mutual fund units: "If the units are issued for Rs.1 crore then Rs.500 would be the stamp duty") and question 33 (issue of a security other than a debenture 0.005% from 1 July 2020); read 24 Nov 2026. The amount × 0.005 / 100.005 arithmetic is QED\'s own', url: 'https://www.sebi.gov.in/sebi_data/faqfiles/dec-2021/1639980911330.pdf', asOf: '2026-11-24', status: 'verified' },
  { id: 'mf.exitload.liquid', kind: 'fee', name: 'Graded exit load on liquid funds for the first six days', value: { byDay: ['0.000070', '0.000065', '0.000060', '0.000055', '0.000050', '0.000045'] }, source: 'SEBI graded exit load for liquid funds (secondary sources; applied per purchase lot)', asOf: '2026-11-19', status: 'unverified' },
  { id: 'mf.cutoff', kind: 'rule', name: 'Fund cut-off times: liquid and overnight purchases 1:30 pm at the previous day\'s NAV; other purchases and all redemptions 3:00 pm', value: { liquidPurchase: '13:30', other: '15:00' }, source: 'AMC documentation citing the SEBI Master Circular, paragraphs 9.4.2 and 9.4.3', url: 'https://www.bajajamc.com/knowledge-centre/articles/mutual-fund-cut-off-time-and-its-significance', asOf: '2026-11-19', status: 'verified' },
  { id: 'mandate.notice', kind: 'rule', name: 'Recurring debits in India: notice at least 24 hours before each debit; no extra authentication up to ₹15,000 (₹1,00,000 for insurance, mutual funds and card bills)', value: { noticeHours: 24, noAfaLimit: 1_500_000, noAfaLimitSpecial: 10_000_000 }, source: 'Reserve Bank of India e-mandate framework', url: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=13374', asOf: '2026-11-18', status: 'verified' },
  { id: 'rail.failure.tat', kind: 'rule', name: 'Failed transfers: money back by the next day for person-to-person UPI and IMPS, within five days for UPI merchant payments', value: { p2pDays: 1, merchantDays: 5 }, source: 'Reserve Bank of India turnaround-time rules', url: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11693&Mode=0', asOf: '2026-11-18', status: 'verified' },
  { id: 'mf.exitload.none', kind: 'fee', name: 'No exit load modelled for this scheme', value: { rate: '0' }, source: 'QED modelling assumption; check the scheme information document', asOf: '2026-11-18', status: 'modelled' },
  { id: 'rail.upi.limit', kind: 'limit', name: 'UPI limit for one ordinary payment', value: { amount: 10_000_000 }, source: 'NPCI UPI limits', asOf: '2026-11-18', status: 'unverified' },
  { id: 'rail.imps.limit', kind: 'limit', name: 'IMPS limit for one payment', value: { amount: 50_000_000 }, source: 'NPCI IMPS limits', asOf: '2026-11-18', status: 'unverified' },
  { id: 'rail.rtgs.min', kind: 'limit', name: 'RTGS minimum', value: { amount: 20_000_000 }, source: 'RBI RTGS rules', asOf: '2026-11-18', status: 'unverified' },
  { id: 'rate.savings', kind: 'rate', name: 'Savings account interest (paper bank)', value: { apr: '0.0275', box: ['0.025', '0.03'] }, source: 'X5 rate box; a modelling range, not one bank\'s published rate', asOf: '2026-11-17', status: 'modelled' },
  { id: 'rate.fd', kind: 'rate', name: 'One-year fixed deposit (paper bank)', value: { apr: '0.0625', breakPenalty: '0.01' }, source: 'X5 model; deposit break rule v3.2 is a modelling rule (D-046)', asOf: '2026-11-17', status: 'modelled' },
  { id: 'rate.card', kind: 'rate', name: 'Credit card interest when a balance is carried', value: { apr: '0.43', box: ['0.40', '0.46'] }, source: 'X5 rate box', asOf: '2026-11-17', status: 'modelled' },
  { id: 'rate.loan.personal', kind: 'rate', name: 'Personal loan', value: { apr: '0.14', prepayCharge: '0.03' }, source: 'X5 model', asOf: '2026-11-17', status: 'modelled' },
  { id: 'rate.loan.home', kind: 'rate', name: 'Home loan (floating)', value: { apr: '0.0875', box: ['0.08', '0.095'] }, source: 'X5 rate box', asOf: '2026-11-17', status: 'modelled' },
  // Worst-case falls used by the protection floor. Illustrative until experiment X9 calibrates each on its own history.
  ...['coindcx:BTCINR', 'coindcx:ETHINR'].map((id): TermDef => ({ id: `limit.${id}`, kind: 'limit', name: `Largest fall allowed for between checks: ${id}`, value: { fall: '0.50', window: 'not calibrated' }, source: 'Illustrative placeholder (D-048)', asOf: '2026-11-18', status: 'modelled' })),
  { id: 'limit.coindcx:USDTINR', kind: 'limit', name: 'Largest fall allowed for between checks: coindcx:USDTINR', value: { fall: '0.10', window: 'not calibrated' }, source: 'Illustrative placeholder (D-048)', asOf: '2026-11-18', status: 'modelled' },
  ...[120716, 120684, 122639, 148381].map((c): TermDef => ({ id: `limit.amfi:${c}`, kind: 'limit', name: `Largest fall allowed for between checks: amfi:${c}`, value: { fall: '0.25', window: 'not calibrated' }, source: 'Illustrative placeholder (D-048)', asOf: '2026-11-18', status: 'modelled' })),
  { id: 'limit.amfi:119788', kind: 'limit', name: 'Largest fall allowed for between checks: amfi:119788', value: { fall: '0.15', window: 'not calibrated' }, source: 'Illustrative placeholder (D-048)', asOf: '2026-11-18', status: 'modelled' },
  // R13 (audit G9): experiment X9 tried to calibrate amfi:120716 (Nifty 50), amfi:118701 (liquid) and amfi:119110 (overnight) on
  // their recorded AMFI histories and its preregistered checks refused all three (validation rejected at 99.9%; tail not identifiable;
  // DEVIATIONS.md D2). They stay illustrative on purpose: recalibrating them here, after seeing that result, would be a second look
  // chosen to get a different answer. X9 gave 16.98% (upper 34.9%) for the Nifty fund, for information only; the 25% below is unchanged.
  ...[118701, 119110, 119771].map((c): TermDef => ({ id: `limit.amfi:${c}`, kind: 'limit', name: `Largest fall allowed for between checks: amfi:${c}`, value: { fall: '0.01', window: 'not calibrated' }, source: 'Illustrative placeholder (D-048)', asOf: '2026-11-18', status: 'modelled' })),
  // Securities added in R13: no history of their own exists to calibrate on (the prices are synthetic), so every limit is illustrative.
  ...[['xchg:NIFTYBEES', '0.25'], ['xchg:GOLDBEES', '0.15'], ['xchg:RELIANCE', '0.35'], ['xchg:TCS', '0.35'], ['xchg:HDFCBANK', '0.35'], ['gsec:TB91', '0.02'], ['gsec:GS2036', '0.12'], ['amfi:118719', '0.02']].map(([id, fall]): TermDef =>
    ({ id: `limit.${id}`, kind: 'limit', name: `Largest fall allowed for between checks: ${id}`, value: { fall, window: 'not calibrated' }, source: 'Illustrative placeholder (D-048): a round number chosen by QED, not measured on any history', asOf: '2026-11-24', status: 'modelled' })),
  ...SECURITY_TERMS,
]

/** Insert reference rows that are missing. Existing terms are left alone so that sourced updates are not overwritten. */
/**
 * `calibrated: false` (presentation mode) seeds only the illustrative limits: the calibrated ones derive from provider
 * data. `presentation` also names reference instruments without their provider, since their values there are synthetic.
 */
/** The terms R13 read from a primary source: an older database's unverified or modelled seed of the same id is replaced once. */
const SOURCED_SINCE_SEED: TermDef[] = [...SECURITY_TERMS, ...TERMS].filter((t) => ['fee.exchange.charges', 'fee.exchange.gst', 'fee.exchange.dp', 'tax.stt', 'tax.stamp.exchange', 'rule.exchange.hours', 'rule.exchange.settlement', 'rule.gsec.hours', 'tax.debt.interest', 'tax.vda.tds', 'mf.stamp'].includes(t.id))

export function seedRegistry(db: Db, opts: { calibrated?: boolean; presentation?: boolean } = {}): void {
  const withCalibrated = opts.calibrated ?? !opts.presentation
  const nameOf = (i: InstrumentDef): string => (opts.presentation ? i.name.replace(/ \((Binance|Coinbase|ECB reference)\)$/, ' (synthetic reference)') : i.name)
  db.tx(() => {
    for (const a of [...ASSETS, ...FUND_UNITS, ...SECURITY_UNITS]) db.run('INSERT OR IGNORE INTO assets (id, kind, name, scale) VALUES (?, ?, ?, ?)', a.id, a.kind, a.name, a.scale)
    for (const i of INSTRUMENTS) {
      const have = db.get<{ meta_json: string }>('SELECT meta_json FROM instruments WHERE id = ?', i.id)
      if (!have) {
        db.run('INSERT INTO instruments (id, kind, name, base_asset, quote_asset, provider, venue, symbol, tradable, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          i.id, i.kind, nameOf(i), i.base, i.quote, i.provider, i.venue, i.symbol, i.tradable ? 1 : 0, j(i.meta))
      }
    }
    const loaded = withCalibrated ? CALIBRATED : []
    const calibrated = new Map(loaded.map((t) => [t.id, t]))
    for (const t of [...TERMS.filter((x) => !calibrated.has(x.id)), ...loaded]) {
      db.run('INSERT OR IGNORE INTO terms (id, kind, name, value_json, source, source_url, as_of, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        t.id, t.kind, t.name, j(t.value), t.source, t.url ?? null, t.asOf, t.status)
    }
    // A term read from its primary source since it was seeded (R13): an older row still carrying its unverified or modelled
    // seed is replaced once, with the change written to the audit log. A row sourced or calibrated by someone since is left alone.
    for (const t of SOURCED_SINCE_SEED) {
      const have = db.get<{ status: string; value_json: string; source: string; as_of: string }>('SELECT status, value_json, source, as_of FROM terms WHERE id = ?', t.id)
      if (!have || have.status === 'verified' || isCalibrated(have.status) || have.source === t.source) continue
      db.run('UPDATE terms SET kind = ?, name = ?, value_json = ?, source = ?, source_url = ?, as_of = ?, status = ? WHERE id = ?', t.kind, t.name, j(t.value), t.source, t.url ?? null, t.asOf, t.status, t.id)
      audit(db, Date.now(), null, 'system', 'term.sourced', t.id, { before: { value: JSON.parse(have.value_json), source: have.source, status: have.status, asOf: have.as_of }, after: { value: t.value, status: t.status, asOf: t.asOf } })
    }
    // A placeholder already stored is replaced by its calibrated value, once, with the change written to the audit log.
    // A term that was sourced or calibrated since is left alone.
    for (const t of loaded) {
      const have = db.get<{ status: string; source: string; value_json: string; as_of: string }>('SELECT status, source, value_json, as_of FROM terms WHERE id = ?', t.id)
      if (!have || isCalibrated(have.status) || !have.source.startsWith('Illustrative placeholder')) continue
      db.run('UPDATE terms SET name = ?, value_json = ?, source = ?, as_of = ?, status = ? WHERE id = ?', t.name, j(t.value), t.source, t.asOf, t.status, t.id)
      audit(db, Date.now(), null, 'system', 'term.calibrated', t.id, { before: { value: JSON.parse(have.value_json), source: have.source, status: have.status, asOf: have.as_of }, after: { value: t.value, status: t.status, asOf: t.asOf } })
    }
  })
}

export interface Instrument { id: string; kind: InstrumentKind; name: string; base_asset: string; quote_asset: string; provider: string; venue: string; symbol: string; tradable: number; meta: InstrumentMeta; baseScale: number; quoteScale: number }

export function instrument(db: Db, id: string): Instrument | undefined {
  const r = db.get<Record<string, unknown>>(
    `SELECT i.*, b.scale base_scale, q.scale quote_scale FROM instruments i JOIN assets b ON b.id = i.base_asset JOIN assets q ON q.id = i.quote_asset WHERE i.id = ?`, id)
  if (!r) return undefined
  return {
    id: String(r.id), kind: r.kind as InstrumentKind, name: String(r.name), base_asset: String(r.base_asset), quote_asset: String(r.quote_asset), provider: String(r.provider),
    venue: String(r.venue), symbol: String(r.symbol), tradable: Number(r.tradable), meta: JSON.parse(String(r.meta_json)) as InstrumentMeta, baseScale: Number(r.base_scale), quoteScale: Number(r.quote_scale),
  }
}

export function instruments(db: Db): Instrument[] {
  return db.all<{ id: string }>('SELECT id FROM instruments ORDER BY kind, name').map((r) => instrument(db, r.id)!)
}

export interface Term { id: string; kind: string; name: string; value: Record<string, unknown>; source: string; source_url: string | null; as_of: string; status: string }
export function term(db: Db, id: string): Term | undefined {
  const r = db.get<Record<string, unknown>>('SELECT * FROM terms WHERE id = ?', id)
  if (!r) return undefined
  return { id: String(r.id), kind: String(r.kind), name: String(r.name), value: JSON.parse(String(r.value_json)) as Record<string, unknown>, source: String(r.source), source_url: (r.source_url as string | null) ?? null, as_of: String(r.as_of), status: String(r.status) }
}
export function termValue(db: Db, id: string, key: string, fallback: string): string {
  const v = term(db, id)?.value[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback
}
/** The weakest status among the terms that make up an exchange trade's costs (brokerage, charges, GST, tax, depository, stamp). */
export function exchangeCostsStatus(db: Db): string {
  const order = ['unverified', 'modelled', 'calibrated', 'verified']
  const ids = ['fee.exchange.brokerage', 'fee.exchange.charges', 'fee.exchange.gst', 'fee.exchange.dp', 'tax.stt', 'tax.stamp.exchange']
  const ranks = ids.map((id) => order.indexOf(term(db, id)?.status ?? 'unverified')).map((r) => (r < 0 ? 0 : r))
  return order[Math.min(...ranks)]!
}
export function setTerm(db: Db, t: TermDef): void {
  db.run(`INSERT INTO terms (id, kind, name, value_json, source, source_url, as_of, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, value_json = excluded.value_json, source = excluded.source,
          source_url = excluded.source_url, as_of = excluded.as_of, status = excluded.status`,
    t.id, t.kind, t.name, j(t.value), t.source, t.url ?? null, t.asOf, t.status)
}
