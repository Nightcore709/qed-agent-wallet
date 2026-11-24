/**
 * The paper bank's currencies (R13): every amount carries its currency and that currency's ISO 4217 minor unit, read
 * from List One, never typed by hand; arithmetic is in integer minor units; two currencies are never added.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { iso4217Entries, ISO4217_LIST_ONE, MoneyError } from './instrument.ts'
import { CURRENCY_NAMES, PAPER_CURRENCIES, TEST_TOKEN_DECIMALS, addMoney, codeOf, isPaperCurrency, minorUnit, money, moneyFromDecimal, moneyText, plainMoney } from './currency.ts'

describe('the paper bank\'s currencies', () => {
  it('holds rupees and at least seven others, each with its minor unit from ISO 4217 List One', () => {
    expect(PAPER_CURRENCIES).toEqual(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'])
    const listOne = new Map(iso4217Entries().map((e) => [e.code, e.minorUnit]))
    for (const c of PAPER_CURRENCIES) expect(minorUnit(c)).toBe(listOne.get(c))
    expect([minorUnit('INR'), minorUnit('USD'), minorUnit('JPY'), minorUnit('BHD')]).toEqual([2, 2, 0, 3])
    expect(ISO4217_LIST_ONE.published).toBe('2026-09-17')
    for (const c of PAPER_CURRENCIES) expect(CURRENCY_NAMES[c].length).toBeGreaterThan(3)
  })

  it('names the test tokens\' own decimals on the chain, which are not ISO\'s', () => {
    expect(TEST_TOKEN_DECIMALS).toEqual({ tINR: 2, tUSD: 6, tEUR: 6, tETH: 18 })
  })

  it('refuses a currency without a minor unit, an unknown code, and one the paper bank does not hold', () => {
    expect(() => minorUnit('XAU')).toThrow(MoneyError)
    expect(() => minorUnit('ABC')).toThrow(MoneyError)
    expect(isPaperCurrency('KWD')).toBe(false)
    expect(isPaperCurrency('JPY')).toBe(true)
    expect(() => money('KWD', 1n)).toThrow(/not a currency the paper bank holds/)
  })

  it('keeps amounts in integer minor units and refuses a fraction of one unless a rounding rule is named', () => {
    expect(money('JPY', 1500n).minor).toBe(1500n)
    expect(() => money('JPY', 1.5)).toThrow(MoneyError)
    expect(() => moneyFromDecimal('JPY', '1.5')).toThrow(/needs rounding/)
    expect(moneyFromDecimal('JPY', '1.5', 'halfEven').minor).toBe(2n)
    expect(moneyFromDecimal('BHD', '1.234').minor).toBe(1234n)
    expect(() => moneyFromDecimal('BHD', '1.2345')).toThrow(/needs rounding/)
    expect(money('USD', '120050').minor).toBe(120050n)
    expect(() => money('USD', '12.5')).toThrow(/integer/)
  })

  it('never adds two currencies', () => {
    expect(() => addMoney(money('USD', 100n), money('JPY', 100n))).toThrow(/cannot be combined without a conversion/)
    expect(addMoney(money('BHD', 1n), money('BHD', 999n)).minor).toBe(1000n)
  })

  it('writes each currency at its own precision: rupees with the sign, others with their code', () => {
    expect(moneyText(money('INR', 12345678n))).toBe('₹1,23,456.78')
    expect(moneyText(money('USD', 123456n))).toBe('USD 1,234.56')
    expect(moneyText(money('JPY', 123456n))).toBe('JPY 1,23,456')
    expect(moneyText(money('BHD', 1234n))).toBe('BHD 1.234')
    expect(moneyText(money('USD', -5n))).toBe('−USD 0.05')
    expect(plainMoney(money('BHD', 1234n))).toBe('1.234')
    expect(codeOf(money('SGD', 1n))).toBe('SGD')
  })

  it('reads back exactly what it writes, at precisions 0, 2 and 3', () => {
    fc.assert(fc.property(fc.constantFrom('JPY', 'USD', 'BHD', 'INR'), fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (c, minor) => {
      const a = money(c, minor)
      expect(moneyFromDecimal(c, plainMoney(a)).minor).toBe(minor)
    }), { numRuns: 300 })
  })
})
