/**
 * Stage S3 of the global money model (ADR-0012): an amount in minor units is stored and sent as canonical integer text.
 * These are the rules every reader and writer of that text shares.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AMOUNT_MAX_DIGITS, fromAmountText, INT64_MAX, INT64_MIN, int64OrNull, numberOrNull, toAmountText } from './amount-text.ts'

const TWO_256 = 1n << 256n

describe('canonical integer text for amounts', () => {
  it('writes an amount the way BigInt does: no sign for zero or a positive amount, no leading zero, no grouping', () => {
    expect(toAmountText(0n)).toBe('0')
    expect(toAmountText(-5n)).toBe('-5')
    expect(toAmountText(1n << 63n)).toBe('9223372036854775808')
    expect(toAmountText(-(10n ** 24n))).toBe('-1000000000000000000000000')
    expect(toAmountText(TWO_256 - 1n)).toHaveLength(AMOUNT_MAX_DIGITS)
  })

  it('refuses an amount longer than the largest balance an ERC-20 token can record (2^256 - 1)', () => {
    expect(() => toAmountText(TWO_256 * 10n)).toThrow(/more than 78 digits/)
    expect(() => fromAmountText('1' + '0'.repeat(78))).toThrow(/not an amount/)
  })

  it('reads back exactly what it wrote, for any amount up to 78 digits either side of zero (property)', () => {
    const big = fc.bigInt({ min: -(TWO_256 - 1n), max: TWO_256 - 1n })
    fc.assert(fc.property(big, (v) => fromAmountText(toAmountText(v)) === v), { numRuns: 2000 })
  })

  it('refuses every text that is not canonical, rather than guessing what it meant', () => {
    for (const bad of ['', '-', '+5', '05', '-0', '-05', ' 5', '5 ', '5.0', '1e3', '0x10', '1_000', '1,000', '١٢', 'NaN', 'Infinity', '--5', '5-', '٥'])
      expect(() => fromAmountText(bad), JSON.stringify(bad)).toThrow(/not an amount/)
  })

  it('refuses anything that is not text: a number (even a safe one), a bigint, null, undefined, a buffer', () => {
    for (const bad of [5, 0, -1.5, Number.NaN, 5n, null, undefined, new Uint8Array([0x35]), { s: '5' }])
      expect(() => fromAmountText(bad)).toThrow(/not an amount/)
  })

  it('names what it was reading in the refusal, and shows the value without failing on it', () => {
    expect(() => fromAmountText('amount_sum refused a REAL value (1.5)', 'the bank balance')).toThrow(/the bank balance is not an amount.*amount_sum refused a REAL value/)
    expect(() => fromAmountText(7n, 'a hold')).toThrow(/a hold is not an amount.*bigint 7/)
  })

  it('the 64-bit copy is the amount when SQLite\'s INTEGER holds it, and null otherwise, at both edges', () => {
    expect(int64OrNull(0n)).toBe(0n)
    expect(int64OrNull(INT64_MAX)).toBe(INT64_MAX)
    expect(int64OrNull(INT64_MIN)).toBe(INT64_MIN)
    expect(int64OrNull(INT64_MAX + 1n)).toBeNull()
    expect(int64OrNull(INT64_MIN - 1n)).toBeNull()
    expect(INT64_MAX).toBe(9_223_372_036_854_775_807n)
  })

  it('a JSON number is given only when a JavaScript number holds the amount exactly; otherwise null, and the text is the figure', () => {
    expect(numberOrNull(123n)).toBe(123)
    expect(numberOrNull(-123n)).toBe(-123)
    expect(numberOrNull(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(numberOrNull(-BigInt(Number.MAX_SAFE_INTEGER))).toBe(-Number.MAX_SAFE_INTEGER)
    expect(numberOrNull(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull()
    expect(numberOrNull(-BigInt(Number.MAX_SAFE_INTEGER) - 1n)).toBeNull()
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (v) => {
      const n = numberOrNull(v)
      return n === null ? (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) : BigInt(n) === v
    }), { numRuns: 1000 })
  })
})
