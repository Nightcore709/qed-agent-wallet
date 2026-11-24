/**
 * Payments abroad on paper routes (R13 section 4; R10: "cross-border scenarios", "duplicate-payment prevention",
 * "disputed or uncertain outcomes"; R10-003).
 *
 * A payee abroad is a name, a country, a currency and an account in that country's scheme, checked when added: an IBAN's
 * check digits and country, a US routing number's checksum, a BIC's country. A payment names the payee, an amount in the
 * payee's currency and a purpose, and is paid from rupees (changed at an executable quote of the paper desk, server/fx.ts)
 * or from a balance already held in that currency. Its route is the one paper route for that currency and country, with
 * the route's fee, a value date counted in business days of the destination's calendar from the day it is sent, and what
 * the payee receives. Anything else is refused with the reason, and nothing is rerouted: QED never changes the currency,
 * the country or the route for the owner.
 *
 * The money is booked to the currency's in-transit account when the payment is sent, and to "paid abroad" on its value
 * date (abroadTick), on paper; this build models no returns or recalls, so a credited payment is final on paper. Each
 * payment can be reconciled against the books (reconcileAbroad).
 *
 * India's Liberalised Remittance Scheme: purposes are the RBI text's current-account purposes; a remittance for margins
 * or margin calls is refused as the text refuses it; every rupee conversion counts toward the year's ceiling (fx.ts).
 * Tax collected at source is computed from the Income-tax Act 2025's own text, from 1 April 2026 (TCS_RULE); before that, not.
 * Modelled from the cited texts, not advice. Paper only: no real money moves, no bank or network is asked.
 */
import { consumeApproval, createApproval, getApproval, MULTI_SIGNER_TTL_MS } from './approvals.ts'
import { CALENDARS, addBusinessDays, calendarWords, sendDate } from './calendars.ts'
import { AppError, audit, bad, type Db, newId, notFound, refused } from './core.ts'
import { assertOffered, type Offer } from './eligibility.ts'
import { assertWithinLrs, balanceAccount, bookConversion, clockText, DESK, ensureCurrencyAccounts, financialYearStart, FX_QUOTE_TTL_MS, LRS, makeQuote, type QuoteDoc, quoteLines, referenceRates, rupeeOutflowWarnings, type SheetLine, TZ_VERSION, usdCents } from './fx.ts'
import { getProfile, jurisdictionOf, zoneOf } from './household.ts'
import { requiredSigners } from './workspaces.ts'
import { account, available, ensureAccount, post } from './ledger.ts'
import { foreignLookalikeWarning } from './abroad-lookalike.ts'
import { DUPLICATE_WINDOW_MS, repeatsEarlier } from './duplicates.ts'
import { checkIbanLayout, IBAN_REGISTRY, ibanRegistryNote } from './iban-registry.ts'
import { sha256hex } from './receipts.ts'
import type { Ctx } from './types.ts'
import { type Currency, CURRENCY_NAMES, isPaperCurrency, minorUnit, money, moneyFromDecimal, moneyText } from '../shared/currency.ts'
import { type Amount, amountToJSON } from '../shared/instrument.ts'
import { canonical } from '../shared/sha256.ts'
import { dateWords, whenIn, zonedInstant } from '../shared/zone.ts'

type Raw = Record<string, unknown>
type Foreign = Exclude<Currency, 'INR'>
export type Scheme = 'iban' | 'aba' | 'bic-account'

// ------------------------------------------------------------------------------------------------ countries and accounts

/** The countries a payee may be in, with the account scheme used there. Some have no paper route: a payment to them is refused. */
export const COUNTRIES: Readonly<Record<string, { name: string; scheme: Scheme }>> = {
  US: { name: 'the United States', scheme: 'aba' }, GB: { name: 'the United Kingdom', scheme: 'iban' },
  DE: { name: 'Germany', scheme: 'iban' }, FR: { name: 'France', scheme: 'iban' }, NL: { name: 'the Netherlands', scheme: 'iban' },
  IE: { name: 'Ireland', scheme: 'iban' }, ES: { name: 'Spain', scheme: 'iban' }, IT: { name: 'Italy', scheme: 'iban' },
  AE: { name: 'the United Arab Emirates', scheme: 'iban' }, BH: { name: 'Bahrain', scheme: 'iban' },
  SG: { name: 'Singapore', scheme: 'bic-account' }, JP: { name: 'Japan', scheme: 'bic-account' },
  CH: { name: 'Switzerland', scheme: 'iban' }, CA: { name: 'Canada', scheme: 'bic-account' },
}
const countryName = (c: string): string => COUNTRIES[c]?.name ?? c

const letterValue = (ch: string): string => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch)
/** The remainder mod 97 of an IBAN rearranged as ISO 13616 describes (as generally documented; the ISO text was not read). */
function mod97(text: string): number {
  let r = 0
  for (const ch of text) for (const d of letterValue(ch)) r = (r * 10 + Number(d)) % 97
  return r
}
const compact = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : '')

/** IBAN check digits (MOD 97-10), shape only. Length and layout per country are checked by checkIbanLayout (iban-registry.ts). */
export function isValidIban(v: unknown): boolean {
  const s = compact(v)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  return mod97(s.slice(4) + s.slice(0, 4)) === 1
}
/** The IBAN with its check digits worked out, for a country and a domestic account number (BBAN). */
export function ibanWithCheckDigits(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`)
  return `${country}${String(check).padStart(2, '0')}${bban}`
}
/** A US routing number's checksum: 3, 7 and 1 weights summing to a multiple of ten (as generally documented; NOT VERIFIED from the Fed's text). */
export function isValidAba(v: unknown): boolean {
  const s = compact(v)
  if (!/^\d{9}$/.test(s)) return false
  const d = [...s].map(Number)
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0
}
const BIC = /^[A-Z]{4}([A-Z]{2})[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/

export interface AbroadPayee { id: string; name: string; country: string; currency: Currency; scheme: Scheme; account: string; bank: string | null; created_at: number }

/** "•••• 3000": an account written for a reader, its last four characters only. */
export const masked = (account: string): string => `•••• ${account.replace(/\s/g, '').slice(-4)}`

/** Add a payee abroad (POST /api/abroad/payees), its account checked in its country's scheme. */
export function addAbroadPayee(db: Db, userId: string, raw: Raw, now: number): AbroadPayee {
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
  const country = compact(raw.country).slice(0, 2), currency = compact(raw.currency).slice(0, 3)
  if (!isPaperCurrency(currency) || currency === 'INR') throw new AppError(400, 'currency_not_held', `The paper bank pays abroad in ${['USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'].join(', ')}; it cannot pay in ${currency || 'that currency'}.`, { currency: 'Choose a currency the paper bank holds.' })
  const where = COUNTRIES[country]
  if (!where) throw bad(`Choose the payee's country from the list. ${country || 'That country'} is not one QED knows the account scheme of.`, { country: 'Choose a country from the list.' })
  if (name.length < 2) throw bad('Enter the payee\'s name.', { name: 'Enter the payee\'s name.' })
  let acct: string, bank: string | null = null
  if (where.scheme === 'iban') {
    acct = compact(raw.account)
    if (!isValidIban(acct)) throw bad('That IBAN\'s check digits are wrong. Check it with the payee.', { account: 'The check digits do not match (ISO 13616, MOD 97).' })
    if (acct.slice(0, 2) !== country) throw bad(`That IBAN is for an account in ${countryName(acct.slice(0, 2))}, not ${where.name}.`, { account: `The IBAN begins ${acct.slice(0, 2)}.` })
    const layout = checkIbanLayout(acct)
    if (layout) throw bad(layout, { account: ibanRegistryNote(country) })
  } else if (where.scheme === 'aba') {
    const routing = compact(raw.routing), number = compact(raw.account)
    if (!isValidAba(routing)) throw bad('That routing number\'s checksum is wrong. Check it with the payee.', { routing: 'Nine digits whose checksum matches.' })
    if (!/^\d{4,17}$/.test(number)) throw bad('Enter the account number: 4 to 17 digits.', { account: 'Enter 4 to 17 digits.' })
    acct = `${routing} ${number}`
  } else {
    bank = compact(raw.bank)
    const m = BIC.exec(bank)
    if (!m) throw bad('Enter the bank\'s BIC: 8 or 11 letters and digits.', { bank: 'A BIC has 8 or 11 characters.' })
    if (m[1] !== country) throw bad(`That BIC is for a bank in ${countryName(m[1]!)}, not ${where.name}.`, { bank: `The BIC's country is ${m[1]}.` })
    acct = compact(raw.account)
    if (!/^[A-Z0-9]{4,34}$/.test(acct)) throw bad('Enter the account number: 4 to 34 letters and digits.', { account: 'Enter 4 to 34 letters and digits.' })
  }
  if (db.get('SELECT 1 FROM xb_payees WHERE user_id = ? AND currency = ? AND account = ?', userId, currency, acct)) throw new AppError(409, 'exists', 'You already have a payee abroad with that account.', { account: 'Already a payee.' })
  // A payee that imitates another the owner pays is how an induced transfer starts (X01): adding it needs the owner's confirmation
  const look = foreignLookalikeWarning({ name, country, scheme: where.scheme, account: acct, bank }, abroadPayees(db, userId))
  if (look && raw.confirmLookalike !== true) throw new AppError(409, 'lookalike', `${look} If a message, a call or anyone else asked you to add it, it may be a fraud. Confirm only after you have checked.`, { name: 'Confirm that you checked this payee.' })
  const id = newId('xbp', now)
  db.run('INSERT INTO xb_payees (id, user_id, name, country, currency, scheme, account, bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, userId, name, country, currency, where.scheme, acct, bank, now)
  audit(db, now, userId, 'owner', 'abroad.payee.add', id, { country, currency, scheme: where.scheme, lookalikeConfirmed: !!look })
  return db.get<AbroadPayee>('SELECT id, name, country, currency, scheme, account, bank, created_at FROM xb_payees WHERE id = ?', id)!
}

export const abroadPayees = (db: Db, userId: string): AbroadPayee[] =>
  db.all<AbroadPayee>('SELECT id, name, country, currency, scheme, account, bank, created_at FROM xb_payees WHERE user_id = ? ORDER BY name', userId)

// ------------------------------------------------------------------------------------------------ routes and purposes

export interface Route { id: string; name: string; currency: Foreign; countries: readonly string[]; feeMinor: bigint; valueDays: number; calendar: string; cutoff: string; offer: Offer }

const route = (id: string, name: string, currency: Foreign, countries: string[], feeRupees: number, valueDays: number, calendar: string): Route => ({
  id, name, currency, countries, feeMinor: BigInt(feeRupees * 100), valueDays, calendar, cutoff: '15:00',
  offer: { id, name, capability: 'C4', offeredIn: ['IN'], basedIn: 'IN', integration: { status: 'paper', dependency: 'A paper route: no bank is asked and no money moves. A real one would need a licensed partner for cross-border payments (capability C4); no agreement is recorded.' } },
})

/** The paper routes: one per currency, to the countries listed. Fees, value days and cut-offs are the paper bank's modelled figures. */
export const ROUTES: readonly Route[] = [
  route('paper-usd-us', 'Paper wire to the United States', 'USD', ['US'], 500, 1, 'US'),
  route('paper-eur-sepa', 'Paper euro transfer to the euro area', 'EUR', ['DE', 'FR', 'NL', 'IE', 'ES', 'IT'], 400, 1, 'TARGET'),
  route('paper-gbp-uk', 'Paper transfer to the United Kingdom', 'GBP', ['GB'], 450, 1, 'UK'),
  route('paper-aed-ae', 'Paper transfer to the United Arab Emirates', 'AED', ['AE'], 350, 1, 'AE'),
  route('paper-sgd-sg', 'Paper transfer to Singapore', 'SGD', ['SG'], 400, 1, 'SG'),
  route('paper-jpy-jp', 'Paper transfer to Japan', 'JPY', ['JP'], 600, 2, 'JP'),
  route('paper-bhd-bh', 'Paper transfer to Bahrain', 'BHD', ['BH'], 450, 2, 'BH'),
]

/** The purposes the paper routes carry: current-account purposes as the RBI text lists them (LRS Master Direction; "gift/donation" written out). */
export const PURPOSES: Readonly<Record<string, string>> = {
  family: 'Maintenance of relatives abroad', gift: 'Gift or donation', education: 'Studies abroad', medical: 'Medical treatment abroad', travel: 'Private visit',
}
export type Purpose = keyof typeof PURPOSES
const REFUSED_PURPOSES: Readonly<Record<string, string>> = {
  margin: `Remittances "in the nature of remittance for margins or margin calls to overseas exchanges/ overseas counterparty are not allowed under the Scheme" (${LRS.source}, paragraph 5; read 24 Nov 2026). QED refuses it on paper too.`,
  investment: 'An investment abroad is a capital account transaction with conditions of its own under the Scheme, which QED does not model; the paper routes do not carry it.',
}
const routeList = (): string => ROUTES.map((r) => `${r.currency} to ${r.countries.map(countryName).join(', ')}`).join('; ')

/** The one paper route for a currency and a country, or the refusal in words. Never another route in its place. */
export function routeFor(currency: string, country: string): Route {
  const r = ROUTES.find((x) => x.currency === currency && x.countries.includes(country))
  if (!r) throw new AppError(409, 'route_not_offered', `No paper route sends ${currency} to ${countryName(country)}. QED does not change the route or the currency for you. The paper routes: ${routeList()}.`)
  return r
}

function checkPurpose(raw: unknown): Purpose {
  const p = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (p in PURPOSES) return p as Purpose
  if (p in REFUSED_PURPOSES) throw new AppError(409, 'purpose_not_offered', REFUSED_PURPOSES[p]!)
  throw new AppError(409, 'purpose_not_offered', `The paper routes carry these purposes only: ${Object.values(PURPOSES).join('; ')}.`)
}

// ------------------------------------------------------------------------------------------------ tax collected at source

/**
 * A rule for tax collected at source, as recorded from the Income-tax text. `effectiveFromMs` is the first instant it applies:
 * a payment before it is not computed (an earlier Act governs it, and QED has not recorded that rule).
 */
export interface TcsRule { source: string; asOf: string; effectiveFromMs: number; thresholdPaise: bigint; rateBps: Partial<Record<string, number>> }

/**
 * Income-tax Act, 2025 (Act 30 of 2025), section 394(1), Table, Sl. No. 7, "Remittance under the Liberalised Remittance
 * Scheme of an amount or aggregate of the amounts exceeding ten lakh rupees", collected by the authorised dealer:
 * "(a) 5% for purposes of education or medical treatment; (b) 20% for purposes other than education or medical treatment".
 * The Finance Act, 2026 (Act 4 of 2026), section 85(e), substituted 2% for the 5% in clause (a), from 1 April 2026 (section 1(2)(a)).
 * Read in the Gazette of India, Extraordinary, 21 Aug 2025 (CG-DL-E-22082025-265620, page 418) and 30 Mar 2026
 * (CG-DL-E-31032026-271439, page 56 to 57), on 24 Nov 2026; hashes in docs/research/qed-fin-infra-compliance/20261124-r13-primary-sources.md.
 *
 * Purposes: QED's education and medical are the Table's education and medical treatment; family, gift and travel are
 * "other than education or medical treatment", so 20%.
 * NOT VERIFIED, two readings: (1) the Table says the remittance "exceeding ten lakh rupees" and does not say whether the rate
 * is charged on the whole amount or on the excess; QED charges on the excess, as sub-section (1G) of section 206C of the
 * 1961 Act was applied (that Act's text was not read here); the other reading would collect more. (2) The threshold is read as
 * one aggregate for the tax year, across purposes; the Table says "aggregate of the amounts" and names no period.
 * Not modelled: no collection on a remittance that is a loan from a financial institution for education (section 394(4)(b)),
 * nor where the buyer was deducted tax under another provision (394(5)); QED does not know how an education payment is funded.
 */
export const TCS_RULE: TcsRule | null = {
  source: 'Income-tax Act 2025, section 394(1) Table Sl. No. 7, as amended by the Finance Act 2026, section 85(e)',
  asOf: '2026-11-24',
  effectiveFromMs: Date.parse('2026-04-01T00:00:00+05:30'),
  thresholdPaise: 100_000_000n, // ten lakh rupees
  rateBps: { education: 200, medical: 200, family: 2_000, gift: 2_000, travel: 2_000 },
}
export const TCS_NOT_COMPUTED = 'Tax collected at source is not computed for this payment: the rule QED has recorded (Income-tax Act 2025, section 394, from 1 April 2026) does not cover it. Your bank would compute and collect it; it is a credit against your tax, not a cost. Modelled, not tax or legal advice.'

/** Rupees changed for payments abroad since the financial year began (what a threshold would count). */
const remittedThisYear = (db: Db, userId: string, now: number): bigint =>
  BigInt(db.get<{ s: string }>(`SELECT amount_sum(debit_text) s FROM xb_payments WHERE user_id = ? AND funded_from = 'INR' AND created_at >= ?`, userId, financialYearStart(now))?.s ?? '0')

export function tcsFor(db: Db, userId: string, purpose: string, rupees: bigint, now: number, rule: TcsRule | null = TCS_RULE): { computed: false; why: string } | { computed: true; paise: bigint; words: string } {
  if (!rule) return { computed: false, why: TCS_NOT_COMPUTED }
  if (now < rule.effectiveFromMs) return { computed: false, why: `Tax collected at source is not computed for a payment before ${new Date(rule.effectiveFromMs + 19_800_000).toISOString().slice(0, 10)}: the recorded rule (${rule.source}) applies from that date, and the Act in force before it (the 1961 Act) is not recorded here. Modelled, not tax or legal advice.` }
  const bps = rule.rateBps[purpose]
  if (bps === undefined) return { computed: false, why: `The recorded rule (${rule.source}) gives no rate for this purpose.` }
  const before = remittedThisYear(db, userId, now)
  const above = before + rupees - (before > rule.thresholdPaise ? before : rule.thresholdPaise)
  const paise = above > 0n ? (above * BigInt(bps) + 9_999n) / 10_000n : 0n
  return { computed: true, paise, words: `${(bps / 100).toFixed(2)}% of what passes ${moneyText(money('INR', rule.thresholdPaise))} this financial year (${rule.source}, as of ${rule.asOf}). Modelled, not advice.` }
}

// ------------------------------------------------------------------------------------------------ duplicates

// The rule is the domestic one (duplicates.ts repeatsEarlier): the same payee, the same amount, 24 hours, the edge included.
export { DUPLICATE_WINDOW_MS }

interface PaymentRow { id: string; user_id: string; payee_id: string; route: string; purpose: string; currency: string; amount_text: string; funded_from: string; debit_text: string; fee_text: string; tcs_text: string | null; fill_id: string | null; value_date: string; calendar: string; time_zone: string; approval_id: string; entry_id: string; duplicate_of: string | null; state: 'in_transit' | 'credited'; created_at: number; credited_at: number | null }

/** The earlier payment to this payee for this amount that the one being decided repeats under the shared rule, or undefined. */
function recentSame(db: Db, userId: string, payeeId: string, currency: string, minor: string, now: number): PaymentRow | undefined {
  const candidates = db.all<PaymentRow>('SELECT * FROM xb_payments WHERE user_id = ? AND payee_id = ? AND currency = ? AND amount_text = ? AND created_at >= ? ORDER BY created_at DESC, id DESC', userId, payeeId, currency, minor, now - DUPLICATE_WINDOW_MS)
  return candidates.find((p) => repeatsEarlier({ payee: p.payee_id, amount: p.amount_text, at: p.created_at, id: p.id }, { payee: payeeId, amount: minor, at: now, id: '\uffff' }))
}

function heldDuplicate(p: PaymentRow, payeeName: string, zone: string): AppError {
  return new AppError(409, 'held_duplicate', `Held for your confirmation: you sent ${moneyText(money(p.currency, p.amount_text))} to ${payeeName} at ${whenIn(p.created_at, zone)}, and this is the same payee and the same amount within 24 hours. Nothing has been sent again. If this is a second payment, confirm it; if not, leave it.`, { duplicateOf: p.id, sentAt: whenIn(p.created_at, zone), amount: moneyText(money(p.currency, p.amount_text)) })
}

// ------------------------------------------------------------------------------------------------ prepare, approve, pay

/**
 * How far above the indicative price a payment that needs several signatures may be sent: 1.00% of the rupees, rounded up. The
 * desk's own spread is 0.50% to 0.75% and a reference moves less than this between quotes on a business day, so the band is
 * wide enough that members who sign within the approval's day are rarely refused, and narrow enough that it is a stated cost.
 * A modelled figure, not a market's.
 */
export const INDICATIVE_BAND_BPS = 100

export interface AbroadPreview { approvalId: string; document: string; docHash: string; expiresAt: number; summary: string; lines: SheetLine[]; warnings: string[]; valueDate: string; route: string }

/** Price a payment abroad and open the approval of its exact terms (POST /api/abroad/prepare). */
export function prepareAbroad(ctx: Ctx, userId: string, raw: Raw): AbroadPreview {
  const { db } = ctx
  const now = ctx.clock.now()
  const profile = getProfile(db, userId)
  const zone = zoneOf(profile)
  const payee = typeof raw.payeeId === 'string' ? db.get<AbroadPayee>('SELECT id, name, country, currency, scheme, account, bank, created_at FROM xb_payees WHERE user_id = ? AND id = ?', userId, raw.payeeId) : undefined
  if (!payee) throw notFound('That payee')
  const r = routeFor(payee.currency, payee.country)
  assertOffered(r.offer, jurisdictionOf(profile))
  const purpose = checkPurpose(raw.purpose)
  const from = typeof raw.from === 'string' ? raw.from.toUpperCase() : 'INR'
  if (from !== 'INR' && from !== payee.currency) throw new AppError(409, 'route_not_offered', `A payment in ${payee.currency} is paid from rupees, changed at a quote, or from a ${payee.currency} balance. QED does not change ${from} into ${payee.currency} for you.`)
  const amt = amountInPayeeCurrency(payee.currency, raw.amount)

  const dup = recentSame(db, userId, payee.id, payee.currency, amt.minor.toString(), now)
  if (dup && raw.confirmDuplicateOf !== dup.id) throw heldDuplicate(dup, payee.name, zone)

  const sent = sendDate(now, r.cutoff)
  const cal = CALENDARS[r.calendar]!
  const valueDate = addBusinessDays(cal, sent, r.valueDays)
  const lines: SheetLine[] = [
    { label: 'To', value: `${payee.name}, ${countryName(payee.country)}, ${payee.scheme === 'iban' ? 'IBAN' : 'account'} ${masked(payee.account)}`, basis: 'exact' },
    { label: 'Route', value: r.name, basis: 'rule', note: 'Paper route: no bank is asked and no money moves' },
    { label: 'Purpose', value: PURPOSES[purpose]!, basis: 'exact', note: `As the RBI text names it (${LRS.source})` },
    { label: 'They receive', value: moneyText(amt), basis: 'exact', note: 'The route deducts nothing on paper' },
  ]
  let quote: QuoteDoc | undefined
  let rupeesOut = 0n, debit: Amount
  if (from === 'INR') {
    quote = makeQuote(ctx, userId, { sell: 'INR', buy: payee.currency, foreign: payee.currency as Foreign, fixed: 'buy', amount: amt, fee: r.feeMinor }, now).quote
    debit = money('INR', quote.sell.minor)
    rupeesOut = BigInt(quote.sell.minor) + r.feeMinor
    // Several members cannot sign inside a quote's minute (as an order's estimate, owner.ts): the quote becomes indicative, with a
    // band, and what the members sign is the ceiling. The count is read at the exact size; a ceiling can only raise it.
    if (requiredSigners(db, userId, Number(rupeesOut)) > 1) {
      const sell = BigInt(quote.sell.minor)
      const ceiling = sell + (sell * BigInt(INDICATIVE_BAND_BPS) + 9_999n) / 10_000n
      quote = { ...quote, expiresAt: now + MULTI_SIGNER_TTL_MS, indicative: { bandBps: INDICATIVE_BAND_BPS, ceiling: amountToJSON(money('INR', ceiling)) } }
      rupeesOut = ceiling + r.feeMinor
    }
    // the quote's own lines, less what this sheet says elsewhere: what they receive (above) and the expiry (last)
    lines.push(...quoteLines(quote, zone).filter((l) => l.label !== 'You receive' && l.label !== 'Quote expires').map((l) => (l.label === 'Rate' && quote!.indicative ? { ...l, label: 'Indicative rate', note: 'What the paper desk would give now: not a price anyone can trade at, and not the rate you will get' } : l.label === 'You pay' && quote!.indicative ? { ...l, label: 'You pay, indicatively', note: 'At the indicative rate: the price at the moment of sending is whatever a fresh quote then is, within the band below' } : l.label === 'Fee' ? { ...l, value: moneyText(money('INR', r.feeMinor)), note: 'The route\'s fee, in place of the desk\'s; charged apart from the rate (modelled)' } : l)))
  } else {
    debit = amt
    rupeesOut = r.feeMinor
    const free = account(db, userId, balanceAccount(payee.currency)) ? available(db, userId, balanceAccount(payee.currency)) : 0n
    if (amt.minor > free) throw new AppError(409, 'insufficient_funds', `You have ${moneyText(money(payee.currency, free))} free; this needs ${moneyText(amt)}.`)
    lines.push({ label: 'You pay', value: moneyText(amt), basis: 'exact', note: `From your ${CURRENCY_NAMES[payee.currency]} balance: nothing is changed` })
    lines.push({ label: 'Fee', value: moneyText(money('INR', r.feeMinor)), basis: 'rule', note: 'The route\'s fee, from your rupee account (modelled)' })
  }
  const tcs = tcsFor(db, userId, purpose, from === 'INR' ? BigInt(quote!.sell.minor) : 0n, now)
  if (tcs.computed) rupeesOut += tcs.paise
  lines.push({ label: 'Tax collected at source', value: tcs.computed ? moneyText(money('INR', tcs.paise)) : 'Not computed', basis: 'rule', note: tcs.computed ? tcs.words : tcs.why })
  const free = available(db, userId, 'bank')
  if (rupeesOut > free) throw new AppError(409, 'insufficient_funds', `You have ${moneyText(money('INR', free))} free in your bank account; this needs ${moneyText(money('INR', rupeesOut))} with the fee.`)
  const guard = rupeeOutflowWarnings(ctx, userId, rupeesOut, now)
  const look = foreignLookalikeWarning(payee, abroadPayees(db, userId).filter((o) => o.id !== payee.id))
  if (look) guard.warnings.push(look)
  let lrs: Record<string, string> | null = null
  if (from === 'INR') {
    const cents = usdCents(amt, referenceRates(ctx.market, now))
    const st = assertWithinLrs(db, userId, cents, now)
    lrs = { after: moneyText(money('USD', st.usedCents + cents)), ceiling: moneyText(money('USD', st.ceilingCents)) }
    lines.push({ label: 'Liberalised Remittance Scheme', value: `${lrs.after} of ${lrs.ceiling} this financial year`, basis: 'rule', note: `${LRS.source}. ${LRS.label}` })
  } else {
    lines.push({ label: 'Liberalised Remittance Scheme', value: 'Counted when the currency was bought', basis: 'rule', note: `Paid from a balance already held: its rupees were counted when they were changed (${LRS.source}). ${LRS.label}` })
  }
  lines.push({ label: 'Value date', value: dateWords(valueDate), basis: 'rule', note: `Sent ${dateWords(sent)} (cut-off ${r.cutoff} IST on India business days); ${r.valueDays} business day${r.valueDays === 1 ? '' : 's'} later in ${cal.name}. ${calendarWords(cal, valueDate)}` })
  if (quote?.indicative) {
    const ceil = money('INR', quote.indicative.ceiling.minor)
    lines.push({ label: 'Price band', value: `Up to ${moneyText(ceil)} (${(quote.indicative.bandBps / 100).toFixed(2)}% above the indicative price)`, basis: 'rule', note: 'When it is sent, QED asks the desk for a fresh quote and sends it only if it costs no more than this. If it costs more, it is refused and nothing is sent: ask again.' })
    lines.push({ label: 'Approval open until', value: clockText(quote.expiresAt, zone), basis: 'exact', note: 'Several members must sign, so this is not a 60-second quote: the approval stays open for the time a business needs to gather its signatures' })
  } else if (quote) lines.push({ label: 'Quote expires', value: clockText(quote.expiresAt, zone), basis: 'exact', note: 'After this it is refused, even if approved: ask for a new one' })
  if (dup) lines.unshift({ label: 'Not a duplicate', value: `You confirmed this is not the ${moneyText(amt)} sent ${whenIn(dup.created_at, zone)}`, basis: 'exact' })

  const id = newId('xbq', now)
  const summary = `Pay ${moneyText(amt)} to ${payee.name} in ${countryName(payee.country)}`
  const doc = canonical({
    v: 2, kind: 'xb-payment', id, what: summary,
    payee: { id: payee.id, name: payee.name, country: payee.country, currency: payee.currency, scheme: payee.scheme, account: payee.account, bank: payee.bank },
    route: { id: r.id, name: r.name, fee: amountToJSON(money('INR', r.feeMinor)), valueDays: r.valueDays, cutoff: r.cutoff },
    purpose, receives: amountToJSON(amt), from, debit: amountToJSON(debit), ...(quote ? { quote } : {}),
    tcs: tcs.computed ? { computed: true, amount: amountToJSON(money('INR', tcs.paise)), words: tcs.words } : { computed: false, why: tcs.why },
    ...(lrs ? { lrs: { ...lrs, source: LRS.source } } : {}),
    account: { from: balanceAccount(from as Currency), via: `xb:${payee.currency}` }, rail: r.id, recipient: `${payee.name}, ${payee.country}`,
    sendDate: sent, valueDate, calendar: r.calendar, timeZone: zone, tzVersion: TZ_VERSION,
    ...(dup ? { confirmedNotDuplicateOf: dup.id } : {}),
    sizePaise: Number(rupeesOut), acknowledged: guard.acknowledged, estimate: lines, warnings: guard.warnings,
    note: (quote?.indicative ? 'Approving lets QED send this once, at a fresh quote that costs no more than the ceiling stated above' : 'Approving lets QED send exactly this, once' + (quote ? ', before the quote expires' : '')) + '. Paper route: no real money moves, and nothing reaches the payee.',
  })
  const a = createApproval(db, userId, { purpose: 'xb-payment', subject: `xb:${id}`, document: doc, requiresStepUp: true, ...(quote && !quote.indicative ? { ttlMs: FX_QUOTE_TTL_MS } : {}) }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: quote ? quote.expiresAt : a.expires_at, summary, lines, warnings: guard.warnings, valueDate, route: r.id }
}

function amountInPayeeCurrency(c: Currency, v: unknown): Amount {
  const text = typeof v === 'string' ? v.trim().replace(/,/g, '') : ''
  const e = minorUnit(c)
  let a: Amount
  try { a = moneyFromDecimal(c, text) } catch { throw bad(`Enter an amount of ${c} with ${e === 0 ? 'no decimal places' : `at most ${e} decimal place${e === 1 ? '' : 's'}`}.`, { amount: `${c} has ${e} decimal place${e === 1 ? '' : 's'} (ISO 4217).` }) }
  if (a.minor <= 0n) throw bad('Enter an amount above zero.', { amount: 'Enter an amount above zero.' })
  return a
}

interface PayDoc { id: string; payee: { id: string; name: string; currency: Currency; country: string }; route: { id: string; fee: { minor: string } }; purpose: string; receives: { minor: string }; from: string; debit: { minor: string }; quote?: QuoteDoc; tcs: { computed: boolean; amount?: { minor: string } }; valueDate: string; calendar: string; timeZone: string; confirmedNotDuplicateOf?: string }

/** Send the approved payment (POST /api/abroad/pay). Once: the same approval again returns the same payment. */
export function payAbroad(ctx: Ctx, userId: string, approvalId: string): PaymentView {
  const { db } = ctx
  const done = db.get<PaymentRow>('SELECT * FROM xb_payments WHERE user_id = ? AND approval_id = ?', userId, approvalId)
  if (done) return { ...paymentView(db, userId, done.id)!, duplicate: true }
  const now = ctx.clock.now()
  const zone = zoneOf(getProfile(db, userId))
  const a = getApproval(db, userId, approvalId)
  if (!a || a.purpose !== 'xb-payment') throw notFound('That payment')
  if (!a.confirmed_at || a.cancelled_at) throw refused('approval_missing', 'Approve the payment with your passkey first.')
  if (a.consumed_at) throw refused('approval_used', 'That approval has already been used.')
  if (sha256hex(a.document) !== a.doc_hash) throw new AppError(500, 'approval_corrupt', 'The stored terms do not match their hash. Nothing was sent.')
  const d = JSON.parse(a.document) as PayDoc
  if (d.quote && !d.quote.indicative && now > d.quote.expiresAt) throw refused('quote_expired', `This quote expired at ${clockText(d.quote.expiresAt, zone)}. Nothing was sent. Ask for a new quote.`)
  return db.tx(() => {
    // checked again as it is sent: a duplicate paid since this one was previewed is held here too
    const dup = recentSame(db, userId, d.payee.id, d.payee.currency, d.receives.minor, now)
    if (dup && d.confirmedNotDuplicateOf !== dup.id) throw heldDuplicate(dup, d.payee.name, zone)
    consumeApproval(db, userId, approvalId, a.subject, a.doc_hash, now)
    const c = d.payee.currency as Foreign
    const amount = BigInt(d.receives.minor)
    // An indicative quote is only a ceiling: price the payment afresh now and send it only inside the signed band.
    let quote = d.quote
    if (quote?.indicative) {
      quote = makeQuote(ctx, userId, { sell: 'INR', buy: c, foreign: c, fixed: 'buy', amount: money(c, amount), fee: BigInt(quote.fee.minor) }, now).quote
      const ceiling = BigInt(d.quote!.indicative!.ceiling.minor)
      if (BigInt(quote.sell.minor) > ceiling) throw refused('outside_band', `The price has moved: it now costs ${moneyText(money('INR', quote.sell.minor))}, above the ${moneyText(money('INR', ceiling))} ceiling the members signed (${(d.quote!.indicative!.bandBps / 100).toFixed(2)}% above the indicative price). Nothing was sent, and the approval is not used up. Ask for a new quote, or try again if the price returns.`)
    }
    // the fee from the approved terms: the quote's (the route's fee, priced in) or the route's as approved, never today's table
    const fee = BigInt(quote ? quote.fee.minor : d.route.fee.minor)
    const tcs = d.tcs.computed && d.tcs.amount ? BigInt(d.tcs.amount.minor) : 0n
    const tcsLines = tcs > 0n ? (ensureAccount(db, userId, 'tcs', 'asset', 'INR', 'Tax collected at source (a credit against your tax)', true), [{ account: 'bank', amount: -tcs }, { account: 'tcs', amount: tcs }]) : []
    const pid = newId('xbt', now)
    const memo = `Paid ${moneyText(money(c, amount))} to ${d.payee.name} abroad (paper route)`
    let entryId: string, fillId: string | null = null
    if (quote) {
      assertWithinLrs(db, userId, usdCents(money(c, amount), referenceRates(ctx.market, now)), now)
      const b = bookConversion(ctx, userId, quote, { approvalId, now, purpose: 'payment', ref: `xb:${pid}`, kind: 'xb-payment', memo, toAccount: `xb:${c}`, extraLines: tcsLines })
      entryId = b.entryId; fillId = b.fill.id
    } else {
      ensureCurrencyAccounts(db, userId, c)
      entryId = post(db, { userId, ts: now, kind: 'xb-payment', ref: `xb:${pid}`, memo, meta: { paper: true, route: d.route.id, valueDate: d.valueDate }, lines: [
        { account: `bank:${c}`, amount: -amount }, { account: `xb:${c}`, amount }, { account: 'bank', amount: -fee }, { account: 'exp:fees', amount: fee }, ...tcsLines] }).id
    }
    db.run(`INSERT INTO xb_payments (id, user_id, payee_id, route, purpose, currency, amount_text, funded_from, debit_text, fee_text, tcs_text, fill_id, value_date, calendar, time_zone, approval_id, entry_id, duplicate_of, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit', ?)`,
    pid, userId, d.payee.id, d.route.id, d.purpose, c, amount.toString(), d.from, quote ? quote.sell.minor : d.debit.minor, fee.toString(), d.tcs.computed ? tcs.toString() : null, fillId, d.valueDate, d.calendar, d.timeZone, approvalId, entryId, d.confirmedNotDuplicateOf ?? null, now)
    audit(db, now, userId, 'owner', 'abroad.pay', pid, { approvalId, docHash: a.doc_hash, route: d.route.id, amount: amount.toString(), currency: c, valueDate: d.valueDate, duplicateOf: d.confirmedNotDuplicateOf ?? null })
    return { ...paymentView(db, userId, pid)!, duplicate: false }
  })
}

// ------------------------------------------------------------------------------------------------ settlement, reconciliation, views

/** The moment a payment's value date begins in its calendar's zone: when it is credited on paper. */
const creditAt = (p: Pick<PaymentRow, 'value_date' | 'calendar'>): number => zonedInstant(p.value_date, '00:00', CALENDARS[p.calendar]?.zone ?? 'UTC')

/** Credit on paper every payment whose value date has begun. Safe to call as often as you like (one entry per payment). */
export function abroadTick(ctx: Ctx): number {
  const { db } = ctx
  const now = ctx.clock.now()
  let n = 0
  for (const p of db.all<PaymentRow>(`SELECT * FROM xb_payments WHERE state = 'in_transit' ORDER BY created_at`)) {
    if (now < creditAt(p)) continue
    db.tx(() => {
      const amount = BigInt(p.amount_text)
      post(db, { userId: p.user_id, ts: now, effectiveTs: Math.min(now, creditAt(p)), kind: 'xb-credited', ref: `xb-credited:${p.id}`, memo: `Credited to the payee on paper, value date ${dateWords(p.value_date)}`, meta: { paper: true, paymentId: p.id }, lines: [{ account: `xb:${p.currency}`, amount: -amount }, { account: `exp:abroad:${p.currency}`, amount }] })
      if (db.run(`UPDATE xb_payments SET state = 'credited', credited_at = ? WHERE id = ? AND state = 'in_transit'`, now, p.id).changes) n++
    })
  }
  return n
}

const postingsOf = (db: Db, ref: string, userId: string): Map<string, bigint> => {
  const m = new Map<string, bigint>()
  for (const r of db.all<{ code: string; t: string }>('SELECT a.code, p.amount_text t FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND e.ref = ?', userId, ref)) m.set(r.code, (m.get(r.code) ?? 0n) + BigInt(r.t))
  return m
}

/** Compare a payment's record with the books and with its fill: every leg as recorded, in each currency. */
export function reconcileAbroad(db: Db, userId: string, id: string): { state: 'reconciled' | 'break'; checks: string[]; breaks: string[] } {
  const p = db.get<PaymentRow>('SELECT * FROM xb_payments WHERE user_id = ? AND id = ?', userId, id)
  if (!p) throw notFound('That payment')
  const checks: string[] = [], breaks: string[] = []
  // each leg in money at its currency's precision: what the books hold, and what the payment's record says it should be
  const expect = (what: string, c: string, got: bigint | undefined, want: bigint) => {
    const g = got ?? 0n
    if (g === want) checks.push(`${what}: ${moneyText(money(c, g))}, as recorded`)
    else breaks.push(`${what}: ${moneyText(money(c, g))}, but the record says ${moneyText(money(c, want))}`)
  }
  const out = (v: bigint | undefined): bigint => -(v ?? 0n)
  const sent = postingsOf(db, `xb:${p.id}`, userId)
  const c = p.currency
  const amount = BigInt(p.amount_text), fee = BigInt(p.fee_text), tcs = BigInt(p.tcs_text ?? '0')
  expect(`On its way in ${c}`, c, sent.get(`xb:${c}`), amount)
  if (p.funded_from === 'INR') {
    expect('Out of your bank account', 'INR', out(sent.get('bank')), BigInt(p.debit_text) + fee + tcs)
    const f = p.fill_id ? db.get<{ buy_text: string; sell_text: string; fee_text: string }>('SELECT buy_text, sell_text, fee_text FROM fx_fills WHERE id = ?', p.fill_id) : undefined
    if (!f) breaks.push('The conversion\'s fill is missing')
    else { expect('The fill bought', c, BigInt(f.buy_text), amount); expect('The fill sold', 'INR', BigInt(f.sell_text), BigInt(p.debit_text)); expect('The fill\'s fee', 'INR', BigInt(f.fee_text), fee) }
  } else {
    expect(`Out of your ${c} balance`, c, out(sent.get(`bank:${c}`)), amount)
    expect('Fee out of your bank account', 'INR', out(sent.get('bank')), fee + tcs)
  }
  expect('Fee booked', 'INR', sent.get('exp:fees'), fee)
  if (p.state === 'credited') {
    const cr = postingsOf(db, `xb-credited:${p.id}`, userId)
    expect('Credited to the payee', c, cr.get(`exp:abroad:${c}`), amount)
    expect('Left in transit', c, (sent.get(`xb:${c}`) ?? 0n) + (cr.get(`xb:${c}`) ?? 0n), 0n)
  }
  return { state: breaks.length ? 'break' : 'reconciled', checks, breaks }
}

export interface PaymentView {
  id: string; duplicate?: boolean; duplicateOf: string | null; state: 'in_transit' | 'credited'; stateWords: string; finality: string
  payee: { id: string; name: string; country: string; countryName: string; account: string }; route: { id: string; name: string; calendar: string; calendarWords: string }
  purpose: string; purposeWords: string; currency: string; amountText: string; fundedFrom: string; debitText: string; feeText: string; tcsText: string | null; tcsWhy: string | null
  rate: string | null; spreadBps: number | null; spreadText: string | null; reference: { midText: string; source: string; label: string } | null
  sendAt: number; sentText: string; valueDate: string; valueDateText: string; creditedText: string | null; reconciliation: ReturnType<typeof reconcileAbroad>
}

export function paymentView(db: Db, userId: string, id: string): PaymentView | null {
  const p = db.get<PaymentRow>('SELECT * FROM xb_payments WHERE user_id = ? AND id = ?', userId, id)
  if (!p) return null
  const payee = db.get<AbroadPayee>('SELECT id, name, country, currency, scheme, account, bank, created_at FROM xb_payees WHERE id = ?', p.payee_id)!
  const r = ROUTES.find((x) => x.id === p.route)
  const cal = CALENDARS[p.calendar]
  const f = p.fill_id ? db.get<{ rate: string; spread_bps: number; spread_text: string; reference_json: string }>('SELECT rate, spread_bps, spread_text, reference_json FROM fx_fills WHERE id = ?', p.fill_id) : undefined
  const ref = f ? (JSON.parse(f.reference_json) as QuoteDoc['reference']) : null
  return {
    id: p.id, duplicateOf: p.duplicate_of, state: p.state,
    stateWords: p.state === 'credited' ? `Credited on paper, ${dateWords(p.value_date)}` : `On its way on paper: credited on its value date, ${dateWords(p.value_date)}`,
    finality: p.state === 'credited' ? 'Final on paper: this build models no returns or recalls. Nothing reached a real payee.' : 'Not final: on its way on paper until its value date.',
    payee: { id: payee.id, name: payee.name, country: payee.country, countryName: countryName(payee.country), account: masked(payee.account) },
    route: { id: p.route, name: r?.name ?? p.route, calendar: cal?.name ?? p.calendar, calendarWords: cal ? calendarWords(cal, p.value_date) : '' },
    purpose: p.purpose, purposeWords: PURPOSES[p.purpose] ?? p.purpose, currency: p.currency, amountText: moneyText(money(p.currency, p.amount_text)),
    fundedFrom: p.funded_from, debitText: moneyText(money(p.funded_from, p.debit_text)), feeText: moneyText(money('INR', p.fee_text)),
    tcsText: p.tcs_text === null ? null : moneyText(money('INR', p.tcs_text)), tcsWhy: p.tcs_text === null ? TCS_NOT_COMPUTED : null,
    rate: f?.rate ?? null, spreadBps: f?.spread_bps ?? null, spreadText: f ? moneyText(money('INR', f.spread_text)) : null, reference: ref ? { midText: ref.midText, source: ref.source, label: ref.label } : null,
    sendAt: p.created_at, sentText: whenIn(p.created_at, p.time_zone), valueDate: p.value_date, valueDateText: dateWords(p.value_date), creditedText: p.credited_at ? whenIn(p.credited_at, p.time_zone) : null,
    reconciliation: reconcileAbroad(db, userId, p.id),
  }
}

/** What Spend reads (GET /api/abroad): payees, routes, purposes, recent payments, and the scheme's figure. */
export function abroadView(ctx: Ctx, userId: string): Record<string, unknown> {
  const { db } = ctx
  const ids = db.all<{ id: string }>('SELECT id FROM xb_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', userId)
  return {
    payees: abroadPayees(db, userId).map((p) => ({ ...p, countryName: countryName(p.country), account: masked(p.account) })),
    countries: Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, scheme: c.scheme, ...(c.scheme === 'iban' ? { ibanNote: ibanRegistryNote(code), ibanLength: IBAN_REGISTRY[code]?.length ?? null } : {}) })),
    routes: ROUTES.map((r) => ({ id: r.id, name: r.name, currency: r.currency, countries: r.countries.map((c) => ({ code: c, name: countryName(c) })), feeText: moneyText(money('INR', r.feeMinor)), valueDays: r.valueDays, cutoff: r.cutoff, calendar: CALENDARS[r.calendar]!.name, calendarWords: CALENDARS[r.calendar]!.sources.map((s) => s.words).join(' '), offeredIn: r.offer.offeredIn, integration: r.offer.integration })),
    purposes: Object.entries(PURPOSES).map(([id, words]) => ({ id, words })),
    refusedPurposes: Object.entries(REFUSED_PURPOSES).map(([id, why]) => ({ id, why })),
    payments: ids.map((r) => paymentView(db, userId, r.id)!),
    tcs: { computed: TCS_RULE !== null, why: TCS_NOT_COMPUTED },
    duplicateWindowHours: DUPLICATE_WINDOW_MS / 3_600_000,
    desk: { name: DESK.name },
  }
}

