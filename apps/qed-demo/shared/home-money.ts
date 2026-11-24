/**
 * Money text in the household's home currency (R13 stage S8, with S7).
 *
 * One formatter writes every figure a household reads: an amount in minor units of one currency, and that currency. The
 * currency defaults to the household's home currency, which is held in context: the interface sets it once from the
 * session (setHomeCurrencySource), the server sets it for the household a request or a tick is working for
 * (server/home-context.ts). With nothing set the home currency is the rupee, so an Indian household, and every caller that has
 * no household, read exactly what `inr` and `inrExact` wrote before: for the rupee these functions ARE those functions.
 *
 * Another currency is written at its own ISO 4217 minor unit (JPY 0 places, USD 2, BHD 3), with its own sign where one is
 * unambiguous (pound, euro) and its ISO code otherwise, so "$" is never read for two dollars. Grouping is the locale's: the
 * lakh and crore grouping is the rupee's alone.
 */
import { currencyInstrument, type Currency, isPaperCurrency } from './currency.ts'
import { amount, formatAmount } from './instrument.ts'
import { type FormatOptions, inr, inrCompact, inrExact, type Paise } from './money.ts'

export const DEFAULT_HOME: Currency = 'INR'
let source: () => Currency = () => DEFAULT_HOME
/** Where "the household's home currency" is read from: the interface's session, or the server's request context. */
export function setHomeCurrencySource(fn: () => Currency): void { source = fn }
export const homeCurrency = (): Currency => { const c = source(); return isPaperCurrency(c) ? c : DEFAULT_HOME }

const SYMBOL_OK: ReadonlySet<Currency> = new Set(['GBP', 'EUR'])
const wholeMinor = (p: number): bigint => BigInt(Math.sign(p) * Math.round(Math.abs(p)))

/** An amount of a currency, whole units unless `paise` (the currency's own decimals) is set: £1,234; JPY 1,235; BHD 1.234. */
export function formatMoney(minor: Paise, currency: Currency = homeCurrency(), opts: FormatOptions = {}): string {
  if (currency === 'INR') return inr(minor, opts)
  if (!Number.isFinite(minor)) return `${currency} —`
  const inst = currencyInstrument(currency)
  const sign = opts.sign ?? 'auto'
  return formatAmount(amount(inst, wholeMinor(minor)), inst, {
    locale: 'en-GB', typographicMinus: true, display: SYMBOL_OK.has(currency) ? 'symbol' : 'code', sign: sign === 'always' ? 'exceptZero' : sign,
    ...(opts.paise ? {} : { fractionDigits: 0, rounding: 'halfExpand' as const }),
  }).replace(/[\u00a0\u202f]/g, ' ')
}

/** A sum in running text that may carry minor units: whole units when it is whole, the currency's own decimals when it is not. */
export function formatMoneyExact(minor: Paise | bigint, currency: Currency = homeCurrency()): string {
  if (currency === 'INR') return inrExact(minor)
  if (typeof minor === 'number' && !Number.isFinite(minor)) return `${currency} —`
  const inst = currencyInstrument(currency)
  const v = typeof minor === 'bigint' ? minor : wholeMinor(minor)
  const whole = v % 10n ** BigInt(inst.exponent) === 0n
  return formatAmount(amount(inst, v), inst, {
    locale: 'en-GB', typographicMinus: true, display: SYMBOL_OK.has(currency) ? 'symbol' : 'code',
    ...(whole ? { fractionDigits: 0, rounding: 'trunc' as const } : {}),
  }).replace(/[\u00a0\u202f]/g, ' ')
}

/** The same figures under the names the call sites use: the household's home currency unless one is named. */
export const homeMoney = formatMoney
/** Always the currency's own decimals, for a check's text and a signed document. */
export const homeMoneyMinor = (minor: Paise | bigint, currency: Currency = homeCurrency()): string => formatMoney(Number(minor), currency, { paise: true })
export const homeMoneyExact = formatMoneyExact

/** Compact form for tight spaces: the rupee's lakh and crore, otherwise thousands and millions (£48k, £1.25m). */
export function homeMoneyCompact(minor: Paise, currency: Currency = homeCurrency()): string {
  if (currency === 'INR') return inrCompact(minor)
  const unit = 10 ** currencyInstrument(currency).exponent
  const v = Math.abs(minor) / unit
  const s = minor < 0 ? '−' : ''
  const sym = SYMBOL_OK.has(currency) ? (currency === 'GBP' ? '£' : '€') : `${currency} `
  const trim = (x: number, dp: number) => x.toFixed(dp).replace(/\.?0+$/, '')
  if (v >= 1e6) return `${s}${sym}${trim(v / 1e6, 2)}m`
  if (v >= 1e3) return `${s}${sym}${trim(v / 1e3, 1)}k`
  return `${s}${sym}${Math.round(v)}`
}

/** The currency's own minor units per whole unit (100 for pounds, 1 for yen, 1000 for dinars). */
export const minorPerUnit = (currency: Currency = homeCurrency()): number => 10 ** currencyInstrument(currency).exponent

/** The plural a person reads for whole units of the currency ("rupees", "pounds"). */
export const UNITS_WORD: Readonly<Record<Currency, string>> = { INR: 'rupees', USD: 'dollars', EUR: 'euros', GBP: 'pounds', AED: 'dirhams', SGD: 'dollars', JPY: 'yen', BHD: 'dinars' }
/** The sign that stands in an empty amount field: the rupee's, the pound's, the euro's, otherwise the ISO code. */
export const homeSign = (currency: Currency = homeCurrency()): string => (currency === 'INR' ? '₹' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency)
