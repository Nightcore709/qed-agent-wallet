import { afterEach, describe, expect, it } from 'vitest'
import { PAPER_CURRENCIES } from '../../shared/currency.ts'
import { setHomeCurrencySource } from '../../shared/home-money.ts'
import { entryFormat, entryText, parseEntry } from './money-entry.ts'

afterEach(() => setHomeCurrencySource(() => 'INR'))

describe('amount entry follows the currency (R14)', () => {
  it('takes its sign and its decimal places from each of the eight currencies', () => {
    const seen = Object.fromEntries(PAPER_CURRENCIES.map((c) => { const f = entryFormat(c); return [c, `${f.sign} ${f.places} ${f.unit}`] }))
    expect(seen).toEqual({ INR: '₹ 2 100', USD: 'USD 2 100', EUR: '€ 2 100', GBP: '£ 2 100', AED: 'AED 2 100', SGD: 'SGD 2 100', JPY: 'JPY 0 1', BHD: 'BHD 3 1000' })
  })

  it('defaults to the household\'s home currency, and changes with it', () => {
    expect(entryFormat().sign).toBe('₹')
    setHomeCurrencySource(() => 'USD')
    expect(entryFormat().sign).toBe('USD')
    expect(entryText(860_000)).toBe('8,600')
    setHomeCurrencySource(() => 'GBP')
    expect(entryFormat().sign).toBe('£')
  })

  it('groups the rupee in lakh and crore and every other currency in thousands', () => {
    expect(entryText(80_000_000, 'INR')).toBe('8,00,000')
    expect(entryText(1_23_45_678_90, 'INR')).toBe('1,23,45,678.90')
    expect(entryText(80_000_000, 'USD')).toBe('800,000')
    expect(entryText(123_456_789, 'EUR')).toBe('1,234,567.89')
    expect(entryText(999, 'INR')).toBe('9.99')
    expect(entryText(0, 'AED')).toBe('0')
  })

  it('writes a currency with no decimal places, and one with three, at its own precision', () => {
    expect(entryText(150_000, 'JPY')).toBe('150,000')
    expect(entryText(1_250, 'BHD')).toBe('1.250')
    expect(entryText(1_000, 'BHD')).toBe('1')
    expect(entryText(12_345_678, 'BHD')).toBe('12,345.678')
    expect(entryText(245_050, 'USD')).toBe('2,450.50')
  })

  it('reads what was typed as minor units of that currency, never times a fixed hundred', () => {
    expect(parseEntry('8,00,000', 'INR')).toBe(80_000_000)
    expect(parseEntry('2500.5', 'INR')).toBe(250_050)
    expect(parseEntry('1500', 'JPY')).toBe(1_500)
    expect(parseEntry('1,500', 'JPY')).toBe(1_500)
    expect(parseEntry('1.25', 'BHD')).toBe(1_250)
    expect(parseEntry('1.234', 'BHD')).toBe(1_234)
    expect(parseEntry('8,600', 'USD')).toBe(860_000)
    expect(parseEntry('12.', 'EUR')).toBe(1_200)
  })

  it('refuses more decimal places than the currency has, instead of rounding', () => {
    expect(parseEntry('1.5', 'JPY')).toBeNull()
    expect(parseEntry('1.234', 'USD')).toBeNull()
    expect(parseEntry('1.2345', 'BHD')).toBeNull()
  })

  it('ignores the currency\'s own sign or code, and refuses another currency\'s', () => {
    expect(parseEntry('₹1,50,000', 'INR')).toBe(15_000_000)
    expect(parseEntry('£ 12.50', 'GBP')).toBe(1_250)
    expect(parseEntry('USD 20', 'USD')).toBe(2_000)
    expect(parseEntry('$20', 'USD')).toBe(2_000)
    expect(parseEntry('jpy 900', 'JPY')).toBe(900)
    expect(parseEntry('₹500', 'USD')).toBeNull()
    expect(parseEntry('$20', 'SGD')).toBeNull()
    expect(parseEntry('€5', 'GBP')).toBeNull()
  })

  it('refuses what is not an amount', () => {
    for (const t of ['', 'abc', '-5', '1e3', '1.2.3', '.', '12a']) expect(parseEntry(t, 'INR'), t).toBeNull()
    expect(parseEntry('99999999999999999999', 'INR')).toBeNull()
  })

  it('round-trips every currency: the text of an amount reads back as that amount', () => {
    for (const c of PAPER_CURRENCIES) for (const v of [0, 1, 99, 100, 1_001, 123_456_789]) expect(parseEntry(entryText(v, c), c), `${c} ${v}`).toBe(v)
  })
})
