/**
 * The currencies the paper bank holds (R13: "every amount carries its currency and that currency's ISO 4217 minor-unit
 * precision"), as amounts of shared/instrument.ts: an integer count of the currency's minor unit with the exponent it was
 * counted at. Each minor unit is read from ISO 4217 List One (published 2026-09-17, embedded in instrument.ts), never
 * typed here: INR 2, USD 2, JPY 0, BHD 3. Two currencies are never added; a conversion is always explicit (server/fx.ts).
 *
 * The chain's test tokens keep their own decimals (tINR 2, tUSD 6, tEUR 6, tETH 18, from instrument.ts's fixtures): they
 * are labelled fixtures on a local chain, not currencies and not money.
 *
 * Text for a reader is written here, on the server's side, in the household's locale (en-IN by default): rupees with
 * their sign, every other currency with its ISO code so that "$" is never ambiguous, and the minus sign as U+2212 as the
 * wallet's own copy writes it.
 */
import { type Amount, addAmounts, amount, amountFromDecimal, type FiatInstrument, formatAmount, iso4217Entries, MoneyError, type RoundingMode, testTokenFixtures, toDecimalString } from './instrument.ts'

/** Rupees first, then the foreign currencies the paper bank holds beside them. */
export const PAPER_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'] as const
export type Currency = (typeof PAPER_CURRENCIES)[number]
export const FOREIGN_CURRENCIES: readonly Currency[] = PAPER_CURRENCIES.filter((c) => c !== 'INR')

export const CURRENCY_NAMES: Readonly<Record<Currency, string>> = {
  INR: 'Indian rupee', USD: 'US dollar', EUR: 'Euro', GBP: 'Pound sterling', AED: 'UAE dirham', SGD: 'Singapore dollar', JPY: 'Japanese yen', BHD: 'Bahraini dinar',
}

export const isPaperCurrency = (c: unknown): c is Currency => typeof c === 'string' && (PAPER_CURRENCIES as readonly string[]).includes(c)

const LIST_ONE = new Map(iso4217Entries().map((e) => [e.code, e]))

/** The currency's minor unit from ISO 4217 List One; refused for an unknown code and for one with no minor unit (gold, XAU). */
export function minorUnit(code: string): number {
  const e = LIST_ONE.get(code)
  if (!e) throw new MoneyError('unknown-instrument', `${code} is not in ISO 4217 List One`)
  if (e.minorUnit === null) throw new MoneyError('no-minor-unit', `${code} has no minor unit in ISO 4217 List One, so no amount of it is booked`)
  return e.minorUnit
}

const instruments = new Map<string, FiatInstrument>()
/** The ISO 4217 instrument of a currency the paper bank holds. */
export function currencyInstrument(code: string): FiatInstrument {
  if (!isPaperCurrency(code)) throw new MoneyError('unknown-instrument', `${code} is not a currency the paper bank holds`)
  let i = instruments.get(code)
  if (!i) {
    const e = LIST_ONE.get(code)!
    i = Object.freeze({ kind: 'fiat', id: `iso4217:${code}`, code, numeric: e.numeric, fund: e.fund, exponent: minorUnit(code), name: CURRENCY_NAMES[code], source: 'ISO 4217 List One (SIX), published 2026-09-17' }) as FiatInstrument
    instruments.set(code, i)
  }
  return i
}

/** An amount of a paper-bank currency: minor units as a bigint, a safe integer, or canonical integer text. */
export function money(code: string, minor: bigint | number | string): Amount {
  const inst = currencyInstrument(code)
  if (typeof minor === 'string') {
    if (!/^-?(0|[1-9]\d{0,77})$/.test(minor)) throw new MoneyError('not-an-integer', `minor units must be integer text: ${JSON.stringify(minor)}`)
    return amount(inst, BigInt(minor))
  }
  return amount(inst, minor)
}

/** Read machine text ("1234.56", "1.234"); more decimal places than the currency has are refused unless a rounding rule is named. */
export const moneyFromDecimal = (code: string, text: string, rounding?: RoundingMode): Amount => amountFromDecimal(currencyInstrument(code), text, rounding)

/** "USD" for an amount of iso4217:USD. */
export function codeOf(a: Amount): Currency {
  const code = a.instrument.replace(/^iso4217:/, '')
  if (!isPaperCurrency(code) || a.instrument !== `iso4217:${code}`) throw new MoneyError('unknown-instrument', `${a.instrument} is not a currency the paper bank holds`)
  return code
}

/** a + b in one currency; two currencies are refused, as instrument.ts refuses them. */
export const addMoney = (a: Amount, b: Amount): Amount => addAmounts(a, b)

/** Canonical machine text at the currency's own precision ("1.234" for BHD, "1500" for JPY). */
export const plainMoney = (a: Amount): string => toDecimalString(a)

/** Text for a reader: "₹1,23,456.78", "USD 1,234.56", "JPY 1,23,456", "BHD 1.234". */
export function moneyText(a: Amount, opts: { locale?: string; sign?: 'auto' | 'always' | 'exceptZero' } = {}): string {
  const code = codeOf(a)
  return formatAmount(a, currencyInstrument(code), { locale: opts.locale ?? 'en-IN', display: code === 'INR' ? 'symbol' : 'code', sign: opts.sign ?? 'auto', typographicMinus: true })
    .replace(/ /g, ' ')
}

/** The test tokens' own decimals on the local chain, from instrument.ts's labelled fixtures (any addresses give the same). */
export const TEST_TOKEN_DECIMALS: Readonly<Record<'tINR' | 'tUSD' | 'tEUR' | 'tETH', number>> = (() => {
  const zero = '0x0000000000000000000000000000000000000001'
  const out: Record<string, number> = {}
  for (const t of testTokenFixtures('eip155:31337', { tINR: zero, tUSD: zero, tEUR: zero, tETH: zero })) out[t.symbol] = t.exponent
  return Object.freeze(out) as Record<'tINR' | 'tUSD' | 'tEUR' | 'tETH', number>
})()
