/**
 * Exact decimal arithmetic for money, quantities and prices.
 *
 * An amount is an integer count of an asset's smallest unit ("atoms"): paise for INR (scale 2), satoshi for BTC
 * (scale 8), thousandths of a unit for fund units (scale 3). Prices arrive as decimal strings and are parsed to
 * integers scaled by 10^PRICE_SCALE. Products are computed in BigInt, so nothing passes through binary floating
 * point; every division names its rounding direction.
 */
export const PRICE_SCALE = 10
export type Rounding = 'down' | 'up' | 'half'

const POW: bigint[] = [1n]
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 40) throw new RangeError(`pow10(${n})`)
  while (POW.length <= n) POW.push(POW[POW.length - 1]! * 10n)
  return POW[n]!
}

/** a * b / d with explicit rounding. d must be positive. Rounding is symmetric about zero ("down" truncates). */
export function mulDiv(a: bigint, b: bigint, d: bigint, mode: Rounding): bigint {
  if (d <= 0n) throw new RangeError('mulDiv: divisor must be positive')
  const n = a * b
  const neg = n < 0n
  const abs = neg ? -n : n
  let q = abs / d
  const r = abs % d
  if (r !== 0n) {
    if (mode === 'up') q += 1n
    else if (mode === 'half' && r * 2n >= d) q += 1n
  }
  return neg ? -q : q
}

/** Expand a JavaScript number such as 1e-05 into plain decimal text without exponent notation. */
function plain(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError('not a finite number')
  const s = String(v)
  if (!/e/i.test(s)) return s
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s)
  if (!m) throw new RangeError(`cannot parse ${s}`)
  const sign = m[1]!, digits = m[2]! + (m[3] ?? ''), exp = Number(m[4]) - (m[3]?.length ?? 0)
  return exp >= 0 ? sign + digits + '0'.repeat(exp) : sign + (digits.length > -exp ? digits.slice(0, exp) + '.' + digits.slice(exp) : '0.' + '0'.repeat(-exp - digits.length) + digits)
}

/** Parse decimal text (or a number) into an integer scaled by 10^scale. Rejects anything that is not a plain decimal. */
export function parseDec(input: string | number, scale: number, mode: Rounding = 'half'): bigint {
  const s = (typeof input === 'number' ? plain(input) : input).trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`not a decimal number: ${JSON.stringify(input)}`)
  const neg = m[1] === '-'
  const int = m[2] === '' ? '0' : m[2]!
  const frac = m[3] ?? ''
  let v: bigint
  if (frac.length <= scale) {
    v = BigInt(int + frac.padEnd(scale, '0'))
  } else {
    v = mulDiv(BigInt(int + frac), 1n, pow10(frac.length - scale), mode)
  }
  return neg ? -v : v
}

export function fmtDec(v: bigint | number, scale: number, opts: { trim?: boolean; minFrac?: number } = {}): string {
  const b = typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
  const neg = b < 0n
  const abs = (neg ? -b : b).toString().padStart(scale + 1, '0')
  const int = abs.slice(0, abs.length - scale)
  let frac = scale > 0 ? abs.slice(abs.length - scale) : ''
  if (opts.trim) {
    frac = frac.replace(/0+$/, '')
    if (opts.minFrac && frac.length < opts.minFrac) frac = frac.padEnd(opts.minFrac, '0')
  }
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '')
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
/** Convert to a JavaScript number, refusing values that a double cannot represent exactly. */
export function toNum(v: bigint): number {
  if (v > MAX_SAFE || v < -MAX_SAFE) throw new RangeError(`amount ${v} exceeds the exactly representable range`)
  return Number(v)
}

export const parsePrice = (s: string | number): bigint => parseDec(s, PRICE_SCALE, 'half')
export const fmtPrice = (p: bigint, minFrac = 2): string => fmtDec(p, PRICE_SCALE, { trim: true, minFrac })

/** Consideration in quote atoms for qty base atoms at a price (scaled by PRICE_SCALE). */
export function notional(qty: bigint, baseScale: number, price: bigint, quoteScale: number, mode: Rounding): bigint {
  // qty / 10^base * price / 10^P * 10^quote
  return mulDiv(qty * price, pow10(quoteScale), pow10(baseScale + PRICE_SCALE), mode)
}

/** Quantity in base atoms that an amount of quote atoms buys at a price. */
export function quantityFor(amount: bigint, quoteScale: number, price: bigint, baseScale: number, mode: Rounding): bigint {
  if (price <= 0n) throw new RangeError('price must be positive')
  return mulDiv(amount * pow10(baseScale + PRICE_SCALE), 1n, price * pow10(quoteScale), mode)
}

/** Round an atom quantity down to a multiple of step atoms. */
export function floorToStep(qty: bigint, step: bigint): bigint {
  if (step <= 1n) return qty
  return qty - (qty % step)
}

/** amount * bps / 10000. */
export const bps = (amount: bigint, basisPoints: bigint, mode: Rounding = 'half'): bigint => mulDiv(amount, basisPoints, 10_000n, mode)

/** amount * rate where rate is decimal text such as "0.005" (a fraction, not a percentage). */
export function fraction(amount: bigint, rate: string, mode: Rounding = 'half'): bigint {
  return mulDiv(amount, parseDec(rate, 12), pow10(12), mode)
}

/** Ratio a/b as a JavaScript number, for display and thresholds only (never for booking money). */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return a === 0n ? 0 : (a > 0n ? Infinity : -Infinity)
  const scaled = mulDiv(a, 1_000_000_000_000n, b < 0n ? -b : b, 'half')
  return Number(b < 0n ? -scaled : scaled) / 1e12
}

/** Price as a plain number, for charts and thresholds only. */
export const priceToNumber = (p: bigint): number => Number(p) / Number(pow10(PRICE_SCALE))
