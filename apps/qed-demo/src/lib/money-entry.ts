/**
 * Amount entry in a named currency (R14): what a money field shows and what it takes, from the currency itself.
 *
 * One field (kit.tsx MoneyInput) serves every amount a person types. Its sign, its grouping and how many decimal places
 * it takes come from here, and here they come from the currency: the household's home currency unless the field names
 * another (a balance held in yen, a payee paid in dinars). The decimal places are ISO 4217's (shared/currency.ts
 * minorUnit: the rupee, dollar, euro, pound, dirham and Singapore dollar 2, the yen 0, the Bahraini dinar 3), so an
 * amount is always a whole number of the currency's own minor unit and is never multiplied by a fixed 100.
 *
 * The sign that stands in the field is the one the figures beside it carry (shared/home-money.ts homeSign): the rupee's,
 * the pound's and the euro's own sign, otherwise the ISO code, because "$" is two of the eight currencies.
 */
import { type Currency, isPaperCurrency, minorUnit } from '../../shared/currency.ts'
import { homeCurrency, homeSign } from '../../shared/home-money.ts'

export interface EntryFormat {
  currency: Currency
  /** What stands before the digits: "₹", "£", "€", or the ISO code. */
  sign: string
  /** Decimal places the currency has: 0, 2 or 3. */
  places: number
  /** The currency's minor units in one whole unit: 1, 100 or 1000. */
  unit: number
}

export function entryFormat(currency: string = homeCurrency()): EntryFormat {
  const c: Currency = isPaperCurrency(currency) ? currency : homeCurrency()
  const places = minorUnit(c)
  return { currency: c, sign: homeSign(c), places, unit: 10 ** places }
}

/** Whole units grouped as the currency's readers group them: lakh and crore for the rupee, thousands otherwise. */
function groupWhole(whole: string, currency: Currency): string {
  if (currency !== 'INR') return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole
}

/**
 * Minor units as the text of a field the person may edit: grouped, no sign, and decimals only when the amount has
 * them, then all of the currency's places (2,450.50 and never 2,450.5; 1.250 dinars; 1,500 yen).
 */
export function entryText(minor: number, currency: string = homeCurrency()): string {
  const f = entryFormat(currency)
  if (!Number.isSafeInteger(minor)) return ''
  const neg = minor < 0, abs = Math.abs(minor)
  const whole = groupWhole(String(Math.floor(abs / f.unit)), f.currency)
  const frac = abs % f.unit
  return `${neg ? '−' : ''}${frac === 0 || f.places === 0 ? whole : `${whole}.${String(frac).padStart(f.places, '0')}`}`
}

/**
 * What a person typed, as minor units of the currency, or null when it is not an amount of it. Grouping commas and
 * spaces are ignored, as is the currency's own sign or code typed or pasted with the digits. More decimal places than
 * the currency has are refused, never rounded (1.5 yen is not an amount of yen), and so is another currency's sign.
 */
export function parseEntry(text: string, currency: string = homeCurrency()): number | null {
  const f = entryFormat(currency)
  let s = text.replace(/[\s  ,]/g, '')
  for (const lead of [f.sign, f.currency, ...(f.currency === 'USD' ? ['US$', '$'] : [])]) {
    if (s.toUpperCase().startsWith(lead.toUpperCase())) { s = s.slice(lead.length); break }
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > f.places) return null
  const v = Number(m[1]) * f.unit + Number(frac.padEnd(f.places, '0') || '0')
  return Number.isSafeInteger(v) ? v : null
}
