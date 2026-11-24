/**
 * The household's home currency (R13 stage S7): the currency its profile figures, its paper bank and everything it reads are
 * held and shown in. The rupee is the default; a household made before this stage has none written and reads the rupee, so
 * nothing about it changes. A household chooses another at set-up and cannot change it afterwards (see changeRefusal).
 *
 *   - Context. Text is written in the home currency of the household a request or a tick is working for (AsyncLocalStorage,
 *     read by shared/home-money.ts), never in a process-wide setting: two households with two currencies share one process.
 *   - Starting figures. The rupee defaults (the example household, the first-payments wait, the step-up size) are rupee figures.
 *     For another currency they are converted ONCE, at set-up, at the recorded reference rate (FBIL, 18 Nov 2026, as recorded
 *     by the compliance research) and rounded to two significant figures: opening figures to the nearest, thresholds DOWN, so a
 *     threshold is never looser than the rupee one is in value. The rate and its source are written into the profile
 *     (`homeBasis`) and shown beside the figures.
 *   - What is rupee-only. Orders, funds, instruments quoted in rupees, the rupee desk, payments abroad, the chain rail's test
 *     rupees, paper escrow, Indian tax and the debt planner price and settle in rupees: for a household whose home currency is
 *     another they are refused with the reason, never converted silently (INR_ONLY_REASON).
 *
 * Exponent: planners count in hundredths of a unit. A currency whose minor unit is not two places (the yen has none, the dinar
 * three) is therefore refused as a home currency for now (HOME_OFFERED), with the reason.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError, type Db, parse } from './core.ts'
import { FX_RECORDED, rateText, referenceRates } from './fx-rates.ts'
import { type Currency, CURRENCY_NAMES, isPaperCurrency, minorUnit, PAPER_CURRENCIES } from '../shared/currency.ts'
import { divRound, type Ratio } from '../shared/instrument.ts'
import { DEFAULT_ZONE, isZone } from '../shared/zone.ts'
import { setHomeCurrencySource, UNITS_WORD } from '../shared/home-money.ts'

interface Home { currency: Currency; zone: string }
const store = new AsyncLocalStorage<Home>()
setHomeCurrencySource(() => store.getStore()?.currency ?? 'INR')
/**
 * Run work in a household's home currency and time zone: every money text written inside it reads in that currency, and the
 * planners (liquidity.ts, goals.ts) count their days in that zone. Outside any household: the rupee and India's zone.
 */
export const inHomeCurrency = <T>(currency: Currency, fn: () => T, zone: string = DEFAULT_ZONE): T => (currency === 'INR' && zone === DEFAULT_ZONE && store.getStore() === undefined ? fn() : store.run({ currency, zone }, fn))
/** The zone the household being worked for counts its days in (India's when none). */
export const homeZone = (): string => store.getStore()?.zone ?? DEFAULT_ZONE
/** The same household and currency, in another zone: for a call that is handed a profile and knows its zone best. */
export const inZone = <T>(zone: string, fn: () => T): T => store.run({ currency: store.getStore()?.currency ?? 'INR', zone }, fn)

/** The currencies the paper bank holds and a household may choose at set-up: those counted in hundredths, as the planners count. */
export const HOME_OFFERED: readonly Currency[] = PAPER_CURRENCIES.filter((c) => minorUnit(c) === 2)
export const homeRefusal = (c: Currency): string | null => (HOME_OFFERED.includes(c) ? null : `${CURRENCY_NAMES[c]} cannot be a home currency yet: its smallest unit is not one hundredth, and the planners count in hundredths. Choose one of ${HOME_OFFERED.join(', ')}.`)

/** A household's home currency as stored: the rupee when none was written. */
export function homeCurrencyOfJson(profileJson: string | null | undefined): Currency {
  const c = parse<{ homeCurrency?: unknown }>(profileJson ?? undefined, {}).homeCurrency
  return isPaperCurrency(c) ? c : 'INR'
}
const profileJsonOf = (db: Db, userId: string): string | undefined => db.get<{ profile_json: string }>('SELECT profile_json FROM users WHERE id = ?', userId)?.profile_json
export const householdHome = (db: Db, userId: string): Currency => homeCurrencyOfJson(profileJsonOf(db, userId))
export const zoneOfJson = (profileJson: string | null | undefined): string => { const z = parse<{ timeZone?: unknown }>(profileJson ?? undefined, {}).timeZone; return isZone(z) ? z : DEFAULT_ZONE }
/** Run work for one household in its own home currency and zone (a request, a tick's pass over one household). */
export const withHome = <T>(db: Db, userId: string, fn: () => T): T => { const j = profileJsonOf(db, userId); return inHomeCurrency(homeCurrencyOfJson(j), fn, zoneOfJson(j)) }

/** Why a part of QED that works in rupees only is closed to a household whose home currency is another. */
export const INR_ONLY_REASON = (home: Currency, what: string): string =>
  `${what} works in rupees only, and your home currency is ${CURRENCY_NAMES[home]} (${home}). It is closed to you rather than converted behind your back.`
export function requireRupeeHome(home: Currency, what: string): void { if (home !== 'INR') throw new AppError(409, 'rupees_only', INR_ONLY_REASON(home, what)) }

// ------------------------------------------------------------------------------------------------ starting figures

export interface HomeBasis { currency: Currency; rupeesPerUnit: string; source: string; label: string; observedAt: number; rounding: string }
const ROUNDING = 'to two significant figures: opening and monthly figures to the nearest, thresholds down'

/** The recorded rupee rate of one home-currency unit, with its source and label (never a live or a synthetic walk). */
export function homeBasis(currency: Currency): HomeBasis | null {
  if (currency === 'INR') return null
  const r = referenceRates(null, FX_RECORDED.observedAt).get(currency)
  if (!r) throw new AppError(409, 'no_rate', `No recorded rate for ${currency}.`)
  return { currency, rupeesPerUnit: rateText(r.mid), source: r.source, label: r.label, observedAt: r.observedAt, rounding: ROUNDING }
}
export const basisWords = (b: HomeBasis): string =>
  `Starting figures are the rupee example's, at ${b.rupeesPerUnit} rupees to one ${CURRENCY_NAMES[b.currency]}: ${b.source} (${b.label}), rounded ${b.rounding}. Change any of them to your own.`

/** A rupee figure in paise as minor units of a currency counted in hundredths, at the recorded rate, two significant figures. */
export function fromRupeeFigure(paise: number, currency: Currency, mode: 'nearest' | 'down'): number {
  if (currency === 'INR' || paise <= 0) return paise
  const r = referenceRates(null, FX_RECORDED.observedAt).get(currency)!.mid as Ratio
  const exact = Number(divRound(BigInt(paise) * r.d * 1000n, r.n, 'trunc')) / 1000 // minor units, three decimals of one
  const digits = Math.floor(Math.log10(Math.max(exact, 1))) + 1
  const step = 10 ** Math.max(0, digits - 2)
  return Math.max(mode === 'down' ? 0 : 1, (mode === 'down' ? Math.floor : Math.round)(exact / step) * step)
}

export { UNITS_WORD } from '../shared/home-money.ts'

/**
 * A rupee threshold (D-064: the passkey step-up size, the password-free daily limit) in the household's home currency: the
 * rupee figure itself for the rupee, otherwise converted at the recorded rate and rounded DOWN, so it is never looser in value.
 */
export const thresholdIn = (home: Currency, inrPaise: number): number => (home === 'INR' ? inrPaise : fromRupeeFigure(inrPaise, home, 'down'))
