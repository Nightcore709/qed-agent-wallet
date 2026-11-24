/**
 * Money is held as integer paise. Rupee formatting follows Indian digit grouping (lakh, crore).
 * Research figures computed in floating rupees (the X5 checker port) are converted at the edge with `fromRupees`.
 *
 * Stage S1 of the global money model (docs/research/qed-systems-architect/20261123-global-money-model.md, section 11):
 * `inr` and `inrExact` write through the instrument-aware formatter in `./instrument.ts` as the rupee, iso4217:INR,
 * in integers end to end. The text is the same as before for every sum (the equality properties in instrument.test.ts);
 * the one change is that whole-rupee sums within 50 paise of 2^53 are now exact (inr's old Math.floor((abs + 50) / 100)
 * stopped being exact there).
 */
import { amount, formatAmount, standardRegistry } from './instrument.ts'

export type Paise = number
const RUPEE = standardRegistry().instrument('iso4217:INR')
/** Whole paise from any finite number, half away from zero, as the old integer arithmetic rounded. */
const wholePaise = (p: number): number => Math.sign(p) * Math.round(Math.abs(p))

export const fromRupees = (r: number): Paise => Math.round(r * 100)
export const toRupees = (p: Paise): number => p / 100

/** Integer formatting only: amounts are split into whole rupees and paise with integer arithmetic, never divided as floats. */
const grouping = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0, useGrouping: true })

export interface FormatOptions {
  /** Show paise (two decimals). Default false: whole rupees, rounded half away from zero. */
  paise?: boolean
  /** 'always' prefixes + for positive values (changes); 'never' drops the sign (magnitudes). */
  sign?: 'auto' | 'always' | 'never'
}

/** ₹8,00,000 · −₹50,000 · +₹22,586 */
export function inr(p: Paise, opts: FormatOptions = {}): string {
  if (!Number.isFinite(p)) return '₹—'
  const sign = opts.sign ?? 'auto'
  // Whole rupees are rounded half away from zero (halfExpand), exactly; a sum that rounds to zero carries no sign.
  return formatAmount(amount(RUPEE, wholePaise(p)), RUPEE, { locale: 'en-IN', typographicMinus: true, sign: sign === 'always' ? 'exceptZero' : sign, ...(opts.paise ? {} : { fractionDigits: 0, rounding: 'halfExpand' as const }) })
}

/**
 * A sum in running text that may carry paise: ₹2,450 when it is whole rupees, ₹194.80 when it is not. Never one
 * decimal place: ₹194.8 reads as a mistake, and a reader cannot tell eighty paise from eight. Integer arithmetic,
 * so a sum of any size is exact. Every sentence the server writes about money goes through this.
 */
export function inrExact(p: Paise | bigint): string {
  if (typeof p === 'number' && !Number.isFinite(p)) return '₹—'
  const v = typeof p === 'bigint' ? p : BigInt(wholePaise(p))
  const a = amount(RUPEE, v)
  return v % 100n === 0n
    ? formatAmount(a, RUPEE, { locale: 'en-IN', fractionDigits: 0, rounding: 'trunc', typographicMinus: true })
    : formatAmount(a, RUPEE, { locale: 'en-IN', typographicMinus: true })
}

/** Compact form for tight spaces: ₹8.0 lakh, ₹1.25 crore, ₹48k. */
export function inrCompact(p: Paise): string {
  const r = Math.abs(p) / 100
  const s = p < 0 ? '−' : ''
  if (r >= 1e7) return `${s}₹${trim(r / 1e7, 2)} crore`
  if (r >= 1e5) return `${s}₹${trim(r / 1e5, 2)} lakh`
  if (r >= 1e3) return `${s}₹${trim(r / 1e3, 1)}k`
  return `${s}₹${Math.round(r)}`
}

const trim = (v: number, dp: number) => v.toFixed(dp).replace(/\.?0+$/, '')

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const t = TENS[Math.floor(n / 10)] ?? ''
  const o = ONES[n % 10] ?? ''
  return o ? `${t}-${o}` : t
}

function below1000(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  return [h ? `${ONES[h]} hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ')
}

/** "eight lakh twenty-two thousand five hundred and eighty-six rupees" — used for screen-reader labels of large sums. */
export function inrWords(p: Paise): string {
  let n = Math.round(Math.abs(p) / 100)
  if (n === 0) return 'zero rupees'
  const parts: string[] = []
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const thousand = Math.floor(n / 1e3); n %= 1e3
  if (crore) parts.push(`${below1000(crore)} crore`)
  if (lakh) parts.push(`${below100(lakh)} lakh`)
  if (thousand) parts.push(`${below100(thousand)} thousand`)
  if (n) parts.push(below1000(n))
  return `${p < 0 ? 'minus ' : ''}${parts.join(' ')} rupees`
}

/** Percentages with fixed fraction digits and no space: "7.25%" (design digest §4.3 E). */
export const pct = (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`

export const sum = (xs: Paise[]): Paise => xs.reduce((a, b) => a + b, 0)
