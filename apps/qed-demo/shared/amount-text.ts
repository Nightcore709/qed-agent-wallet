/**
 * Amounts as canonical integer text (ADR-0012; stage S3 of the global money model,
 * docs/research/qed-systems-architect/20261123-global-money-model.md, sections 5 and 11).
 *
 * An amount is an integer count of an instrument's minor unit. A JavaScript number holds such a count exactly only up to
 * 2^53, and SQLite's INTEGER only up to 2^63 - 1, which is 9.22 units of an 18-decimal token. So the books keep every
 * amount as text: "0", or an optional "-" and digits without a leading zero, at most 78 digits (2^256 - 1, the largest
 * balance an ERC-20 token can record, has 78). Text is read back strictly: anything else is refused, never guessed.
 * No imports: the server and the interface can both use this file.
 */

/** The most digits an amount may have: those of 2^256 - 1. */
export const AMOUNT_MAX_DIGITS = 78
export const INT64_MIN = -(1n << 63n)
export const INT64_MAX = (1n << 63n) - 1n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const CANONICAL = /^(?:0|-?[1-9][0-9]{0,77})$/

/** The canonical text of an amount in minor units. */
export function toAmountText(v: bigint): string {
  const s = v.toString()
  if (s.length - (v < 0n ? 1 : 0) > AMOUNT_MAX_DIGITS) throw new RangeError(`an amount of more than ${AMOUNT_MAX_DIGITS} digits is not recorded`)
  return s
}

const shown = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v.length > 100 ? `${v.slice(0, 100)}…` : v)
  if (typeof v === 'bigint') return `bigint ${v}`
  if (v instanceof Uint8Array) return `${v.length} bytes`
  return typeof v === 'number' ? `number ${v}` : typeof v === 'object' ? (v === null ? 'null' : 'an object') : String(v)
}

/** Read canonical text back. A number, a bigint, null or any other text is refused: the caller reads the text column. */
export function fromAmountText(text: unknown, what = 'the value'): bigint {
  if (typeof text !== 'string' || !CANONICAL.test(text)) throw new RangeError(`${what} is not an amount in canonical integer text: ${shown(text)}`)
  return BigInt(text)
}

/** The value of the INTEGER column kept beside the text: the amount when SQLite's 64-bit INTEGER holds it, else null. */
export const int64OrNull = (v: bigint): bigint | null => (v >= INT64_MIN && v <= INT64_MAX ? v : null)

/** The amount as a JSON number when a JavaScript number holds it exactly, else null; the text beside it is always exact. */
export const numberOrNull = (v: bigint): number | null => (v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : null)
