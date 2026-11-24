/**
 * Money held in other currencies, in the worst-case figure (R13 second pass, item 7; valuation.ts worstCase).
 *
 * A foreign balance counts at its reference rate (fx-rates.ts) less a haircut, rounded down to the paisa. The haircut is
 * QED's own modelled allowance, not a market's figure and not advice: 10%, a deliberately cautious fall in the rupee value of
 * a foreign balance before it could be changed back (the rupee's yearly moves against the major currencies have been smaller
 * than this in most years, so it is meant to be wider than a bad year). A currency whose reference is a synthetic cross, or
 * that has none usable, counts for nothing, and the figure says so: synthetic data is never counted as money.
 */
import { balance, account } from './ledger.ts'
import { referenceRates } from './fx-rates.ts'
import type { Db } from './core.ts'
import type { Market } from './market.ts'
import { FOREIGN_CURRENCIES, minorUnit, type Currency } from '../shared/currency.ts'
import { divRound, pow10 } from '../shared/instrument.ts'

/** Basis points taken off a foreign balance's value at its reference rate: 1000 is 10%. */
export const FOREIGN_HAIRCUT_BPS = 1000

export interface ForeignLine { currency: string; balance: bigint; counted: string; why: string | null }
export interface ForeignWorst { total: bigint; lines: ForeignLine[]; words: string }

export const FOREIGN_WORDS = `Each balance in another currency counts at its reference rate less ${FOREIGN_HAIRCUT_BPS / 100}% (QED's own cautious allowance, not a market's figure), rounded down; a currency with only a synthetic rate counts for nothing.`

/** What a foreign amount would count for in the worst case, in paise, or null with the reason it counts for nothing. */
export function countedValue(refs: ReturnType<typeof referenceRates>, c: Exclude<Currency, 'INR'>, held: bigint, now: number): { counted: bigint; why: string | null } {
  const r = refs.get(c)
  if (!r) return { counted: 0n, why: `no reference rate for ${c}` }
  if (r.label === 'synthetic') return { counted: 0n, why: 'its rate is synthetic, not a published one' }
  if (now > r.validUntil) return { counted: 0n, why: 'its reference rate is out of date' }
  // rupees (in paise) = held × (rupees per unit) × 10^2 / 10^(exponent of the currency), rounded down, then the haircut, rounded down
  const paise = divRound(held * r.mid.n * pow10(minorUnit('INR')), r.mid.d * pow10(minorUnit(c)), 'floor')
  return { counted: (paise * BigInt(10_000 - FOREIGN_HAIRCUT_BPS)) / 10_000n, why: null }
}

export function foreignHeldWorst(db: Db, market: Market | null, userId: string, now: number): ForeignWorst {
  const lines: ForeignLine[] = []
  let total = 0n
  let refs: ReturnType<typeof referenceRates> | null = null
  for (const c of FOREIGN_CURRENCIES as readonly Exclude<Currency, 'INR'>[]) {
    if (!account(db, userId, `bank:${c}`)) continue
    const held = balance(db, userId, `bank:${c}`)
    if (held <= 0n) continue
    refs ??= referenceRates(market, now)
    const { counted, why } = countedValue(refs, c, held, now)
    total += counted
    lines.push({ currency: c, balance: held, counted: counted.toString(), why })
  }
  return { total, lines, words: FOREIGN_WORDS }
}
