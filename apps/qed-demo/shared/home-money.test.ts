/**
 * R13 S8: the home-currency formatter. For the rupee it is `inr` and `inrExact` themselves (byte for byte, over a wide spread of
 * sums, signs and options); for every other currency it writes at that currency's own minor unit, with exact integer arithmetic.
 */
import { describe, expect, it } from 'vitest'
import { PAPER_CURRENCIES } from './currency.ts'
import { formatMoney, formatMoneyExact, homeCurrency, homeMoney, homeMoneyCompact, homeMoneyExact, homeMoneyMinor, minorPerUnit, setHomeCurrencySource } from './home-money.ts'
import { inr, inrCompact, inrExact } from './money.ts'

const SUMS = [0, 1, 49, 50, 51, 99, 100, 101, 149, 150, 199_999, 200_000, 12_345_678, 80_000_000, 99_999_999_999, -1, -49, -50, -150, -80_000_000, 9_007_199_254_740_000, Number.NaN, Number.POSITIVE_INFINITY]

describe('for the rupee it is the rupee formatters', () => {
  it('writes the same text for every sum and option', () => {
    for (const p of SUMS) for (const opts of [{}, { paise: true }, { sign: 'always' as const }, { sign: 'never' as const }, { paise: true, sign: 'always' as const }]) {
      expect(formatMoney(p, 'INR', opts)).toBe(inr(p, opts))
      expect(homeMoney(p, undefined, opts)).toBe(inr(p, opts)) // no household: the rupee
    }
    for (const p of SUMS) expect(formatMoneyExact(p, 'INR')).toBe(inrExact(p))
    for (const p of [0n, 150n, 12_345_678n, -99n, 10n ** 20n]) expect(formatMoneyExact(p, 'INR')).toBe(inrExact(p))
    for (const p of [0, 4_999, 5_000_000, 12_345_678_900]) expect(homeMoneyCompact(p, 'INR')).toBe(inrCompact(p))
    expect(homeMoneyMinor(123_456)).toBe(inr(123_456, { paise: true }))
  })
})

describe('every other currency, at its own minor unit', () => {
  it('writes whole units, the currency\'s own decimals, and exact sums in running text', () => {
    expect(formatMoney(123_456_789, 'GBP')).toBe('£1,234,568')
    expect(formatMoney(123_456_789, 'GBP', { paise: true })).toBe('£1,234,567.89')
    expect(formatMoney(-5_050, 'EUR', { paise: true })).toBe('−€50.50')
    expect(formatMoney(5_000, 'USD')).toBe('USD 50')
    expect(formatMoney(5_000, 'SGD', { sign: 'always' })).toBe('+SGD 50')
    expect(formatMoney(150, 'AED', { paise: true })).toBe('AED 1.50')
    expect(formatMoney(123_456, 'JPY')).toBe('JPY 123,456')
    expect(formatMoney(1_234_567, 'BHD', { paise: true })).toBe('BHD 1,234.567')
    expect(formatMoneyExact(123_450, 'GBP')).toBe('£1,234.50')
    expect(formatMoneyExact(123_400, 'GBP')).toBe('£1,234')
    expect(formatMoneyExact(1_234_000, 'BHD')).toBe('BHD 1,234')
    expect(formatMoneyExact(10n ** 20n, 'GBP')).toBe('£1,000,000,000,000,000,000')
    expect(formatMoney(Number.NaN, 'GBP')).toBe('GBP —')
  })
  it('groups in threes: the lakh grouping is the rupee\'s alone', () => {
    for (const c of PAPER_CURRENCIES.filter((x) => x !== 'INR')) expect(formatMoney(12_345_678_00, c)).not.toMatch(/\d{2},\d{2},\d{3}/)
    expect(formatMoney(12_345_678_00, 'INR')).toBe('₹1,23,45,678')
  })
  it('compact text uses thousands and millions outside the rupee', () => {
    expect(homeMoneyCompact(4_800_00, 'GBP')).toBe('£4.8k')
    expect(homeMoneyCompact(125_000_000, 'GBP')).toBe('£1.25m')
    expect(homeMoneyCompact(-125_000_000, 'USD')).toBe('−USD 1.25m')
  })
  it('knows the minor units per whole unit from ISO 4217', () => {
    expect(PAPER_CURRENCIES.map((c) => [c, minorPerUnit(c)])).toEqual([['INR', 100], ['USD', 100], ['EUR', 100], ['GBP', 100], ['AED', 100], ['SGD', 100], ['JPY', 1], ['BHD', 1000]])
  })
})

describe('the home currency in context', () => {
  it('defaults to the rupee, follows the source it is given, and falls back to the rupee for anything that is not a currency', () => {
    expect(homeCurrency()).toBe('INR')
    setHomeCurrencySource(() => 'GBP')
    try { expect(homeCurrency()).toBe('GBP'); expect(homeMoney(123_400)).toBe('£1,234'); expect(homeMoneyExact(123_450)).toBe('£1,234.50') } finally { setHomeCurrencySource(() => 'INR') }
    setHomeCurrencySource(() => 'XXX' as never)
    try { expect(homeCurrency()).toBe('INR') } finally { setHomeCurrencySource(() => 'INR') }
  })
})
