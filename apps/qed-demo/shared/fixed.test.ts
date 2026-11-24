import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bps, floorToStep, fmtDec, fraction, mulDiv, notional, parseDec, parsePrice, pow10, PRICE_SCALE, quantityFor, toNum } from './fixed.ts'

describe('exact decimals', () => {
  it('parses decimal text without passing through floating point', () => {
    expect(parseDec('6606499.1', 2)).toBe(660649910n)
    expect(parseDec('0.00001', 8)).toBe(1000n)
    expect(parseDec('178.87130', 4)).toBe(1788713n)
    expect(parseDec('.5', 2)).toBe(50n)
    expect(parseDec('-12.345', 2, 'half')).toBe(-1235n)
    expect(parseDec('12.345', 2, 'down')).toBe(1234n)
    expect(parseDec('12.341', 2, 'up')).toBe(1235n)
    expect(parseDec(1e-5, 8)).toBe(1000n)
    expect(parseDec(0.0158, 8)).toBe(1580000n)
  })
  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '.', '1e5', '1,000', 'abc', '1.2.3', ' ', '0x10', 'NaN', '--1']) expect(() => parseDec(bad, 2)).toThrow()
    expect(() => parseDec(Number.NaN, 2)).toThrow()
    expect(() => parseDec(Number.POSITIVE_INFINITY, 2)).toThrow()
  })
  it('formats back exactly', () => {
    expect(fmtDec(660649910n, 2)).toBe('6606499.10')
    expect(fmtDec(-5n, 2)).toBe('-0.05')
    expect(fmtDec(1000n, 8, { trim: true })).toBe('0.00001')
    expect(fmtDec(100000000n, 8, { trim: true, minFrac: 2 })).toBe('1.00')
  })
  it('round-trips every amount (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.integer({ min: 0, max: 10 }), (v, scale) => {
      expect(parseDec(fmtDec(v, scale), scale)).toBe(v)
    }))
  })
  it('mulDiv rounds as named and never drifts by more than one unit', () => {
    expect(mulDiv(7n, 1n, 2n, 'down')).toBe(3n)
    expect(mulDiv(7n, 1n, 2n, 'up')).toBe(4n)
    expect(mulDiv(7n, 1n, 2n, 'half')).toBe(4n)
    expect(mulDiv(-7n, 1n, 2n, 'down')).toBe(-3n)
    expect(() => mulDiv(1n, 1n, 0n, 'down')).toThrow()
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (a, b, d) => {
      const down = mulDiv(a, b, d, 'down'), up = mulDiv(a, b, d, 'up'), half = mulDiv(a, b, d, 'half')
      expect(down * d <= a * b).toBe(true)
      expect(up * d >= a * b).toBe(true)
      expect(up - down <= 1n).toBe(true)
      expect(half === down || half === up).toBe(true)
    }))
  })
  it('refuses to convert amounts a double cannot hold exactly', () => {
    expect(toNum(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => toNum(9007199254740992n)).toThrow()
  })
})

describe('prices, quantities and consideration', () => {
  const BTC = 8, INR = 2
  it('computes consideration for a real INR quote', () => {
    // 0.00123 BTC at ₹66,06,499.1 = ₹8,125.993893 -> 812599 paise down, 812600 up
    const q = parseDec('0.00123', BTC), p = parsePrice('6606499.1')
    expect(notional(q, BTC, p, INR, 'down')).toBe(812599n)
    expect(notional(q, BTC, p, INR, 'up')).toBe(812600n)
  })
  it('quantityFor never buys more than the money covers (property)', () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 5_000_000_00 }), fc.integer({ min: 1_000_00, max: 99_999_999_9 }), (amountPaise, priceTenths) => {
      const price = parsePrice((priceTenths / 10).toFixed(1))
      const qty = quantityFor(BigInt(amountPaise), INR, price, BTC, 'down')
      expect(notional(qty, BTC, price, INR, 'down') <= BigInt(amountPaise)).toBe(true)
      // one more satoshi would cost more than the amount, or exactly reach it
      expect(notional(qty + 1n, BTC, price, INR, 'up') >= BigInt(amountPaise)).toBe(true)
    }))
  })
  it('fund units: three decimals at a four-decimal NAV', () => {
    const units = quantityFor(499975n, 2, parsePrice('178.8713'), 3, 'down') // ₹4,999.75 after stamp duty
    expect(units).toBe(27951n) // 27.951 units
    expect(notional(units, 3, parsePrice('178.8713'), 2, 'down') <= 499975n).toBe(true)
  })
  it('steps, basis points and fractions', () => {
    expect(floorToStep(123456n, 1000n)).toBe(123000n)
    expect(bps(1_000_000n, 50n)).toBe(5000n)
    expect(fraction(1_000_001n, '0.005', 'up')).toBe(5001n)
    expect(fraction(1_000_001n, '0.005', 'down')).toBe(5000n)
    expect(pow10(PRICE_SCALE)).toBe(10_000_000_000n)
  })
})
