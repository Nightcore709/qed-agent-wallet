/**
 * The paper FX desk and the paper bank's foreign-currency balances (R13 sections 1 to 3; R7-038; R10-003).
 *
 * Three kinds of figure are kept apart, in data and in words:
 * - a REFERENCE rate says what a currency was worth by a published benchmark; nobody can trade at it. The desk prices from
 *   the FBIL reference rates of 18 Nov 2026 as displayed on the RBI home page (recorded by the compliance research, E44),
 *   or from a fresh ECB reference (or a test's) for USD and EUR when the market has one. AED, SGD and BHD have no recorded
 *   reference: their rates are synthetic crosses from the US dollar, labelled synthetic. The synthetic random walk of the
 *   local market is never used to price a conversion.
 * - an EXECUTABLE quote is the paper desk's own price: the reference moved by a stated spread against the owner, stated to
 *   six decimal places, with a fee charged apart, an expiry, and its source. It is the terms of an approval document
 *   (format 2, stage S4 of the global money model): the owner's passkey signs exactly those terms.
 * - a FILL is what happened: it keeps the rate, the spread (and what it cost against the reference mid) and the fee in
 *   separate columns (fx_fills), and the ledger books each currency on its own accounts, balanced in each.
 *
 * Rounding: once, at a stated point, under a named rule. The rate is stated to six places, rounded against the owner by
 * less than 0.000001 (up when the owner buys a currency, down when they sell one). The amount is then converted once at
 * that stated rate, to the minor unit of its currency (ISO 4217): what the owner pays is rounded up and what they receive
 * is rounded down, so the desk never pays out more than the money covers.
 *
 * Every conversion of rupees into another currency counts toward India's Liberalised Remittance Scheme ceiling for the
 * financial year, at its US-dollar equivalent rounded up (lrsStatus; RBI's Master Direction, cited below). Modelled, not
 * advice. Paper only: no real money moves and no market is asked.
 */
import { consumeApproval, createApproval, getApproval } from './approvals.ts'
import { AppError, audit, bad, type Db, j, newId, notFound, refused } from './core.ts'
import { assertOffered, FX_DESK_OFFER } from './eligibility.ts'
import { countedValue, FOREIGN_HAIRCUT_BPS } from './foreign-worst.ts'
import { INR_ID, rateText, referenceRates } from './fx-rates.ts'
import { getProfile, jurisdictionOf, TZ_VERSION, zoneOf } from './household.ts'
import { account, available, balance, ensureAccount, post } from './ledger.ts'
import type { Market } from './market.ts'
import { sha256hex } from './receipts.ts'
import { dateText, staysLiquid } from './liquidity.ts'
import { worstCase } from './valuation.ts'
import type { Ctx } from './types.ts'
import { codeOf, type Currency, CURRENCY_NAMES, currencyInstrument, FOREIGN_CURRENCIES, isPaperCurrency, minorUnit, money, moneyFromDecimal, moneyText, PAPER_CURRENCIES } from '../shared/currency.ts'
import { type Amount, type AmountJSON, amountToJSON, convert, divRound, makeRate, MoneyError, parseRatio, pow10, type Rate, type Ratio, ratio, showRatio } from '../shared/instrument.ts'
import { canonical } from '../shared/sha256.ts'
import { offsetMs, whenIn, zonedInstant, zonedParts, zoneLabel } from '../shared/zone.ts'

type Raw = Record<string, unknown>
type Foreign = Exclude<Currency, 'INR'>

export { TZ_VERSION }

// ------------------------------------------------------------------------------------------------ reference rates (fx-rates.ts)

export { CBB_PEG, FX_RECORDED, rateText, referenceRates, SYNTHETIC_CROSSES } from './fx-rates.ts'

// ------------------------------------------------------------------------------------------------ the desk

/** The paper desk's own modelled figures, not a bank's. */
export const DESK = {
  name: 'QED paper FX desk',
  feeMinor: 5_000n, // ₹50.00 a conversion, charged apart from the rate
  spreadBps: { USD: 50, EUR: 50, GBP: 50, JPY: 50, AED: 75, SGD: 75, BHD: 75 } as Readonly<Record<Foreign, number>>,
  words: 'The paper desk\'s own modelled spread and fee, not a bank\'s. Research found bank mark-ups of 1.5% to 3.5% over the mid-market rate in commentary (FX-04, Hypothesis-S).',
} as const

/** How long an executable quote holds: the same setting as an order's priced estimate (owner.ts QUOTE_TTL_MS). */
export const FX_QUOTE_TTL_MS = Number(process.env.QED_QUOTE_TTL_SEC) > 0 ? Number(process.env.QED_QUOTE_TTL_SEC) * 1000 : 60_000

export const ROUNDING_RULE = 'The desk states its rate to six decimal places, moved by its spread against you and rounded against you by less than 0.000001. The amount is then converted once, at that rate, to the currency\'s minor unit (ISO 4217): what you pay is rounded up and what you receive is rounded down.'

export interface PriceInput { sell: string; buy: string; amount: bigint; fixed: 'sell' | 'buy'; reference: { mid: Ratio }; spreadBps: number }
export interface Priced { sell: bigint; buy: bigint; rate: string; micro: bigint; foreign: Foreign; ownerBuysForeign: boolean }

/** The terms of one conversion between rupees and one other currency, worked out in integers. Pure. */
export function priceConversion(p: PriceInput): Priced {
  const ownerBuysForeign = p.sell === 'INR'
  const foreign = (ownerBuysForeign ? p.buy : p.sell) as Foreign
  const eF = minorUnit(foreign), eI = minorUnit('INR')
  const m = p.reference.mid
  const factor = BigInt(10_000 + (ownerBuysForeign ? p.spreadBps : -p.spreadBps))
  const micro = divRound(m.n * factor * 1_000_000n, m.d * 10_000n, ownerBuysForeign ? 'ceil' : 'floor')
  if (micro <= 0n) throw new AppError(409, 'rate_too_small', `The ${foreign} rate is too small to state to six places.`)
  // x foreign minor units are worth x × micro × 10^eI / (10^6 × 10^eF) rupee minor units at the stated rate
  const den = 1_000_000n * pow10(eF)
  let fx: bigint, inr: bigint
  if (p.fixed === (ownerBuysForeign ? 'buy' : 'sell')) {
    fx = p.amount
    inr = divRound(fx * micro * pow10(eI), den, ownerBuysForeign ? 'ceil' : 'floor')
  } else {
    inr = p.amount
    fx = divRound(inr * den, micro * pow10(eI), ownerBuysForeign ? 'floor' : 'ceil')
  }
  const s = micro.toString().padStart(7, '0')
  return { sell: ownerBuysForeign ? inr : fx, buy: ownerBuysForeign ? fx : inr, rate: `${s.slice(0, -6)}.${s.slice(-6)}`, micro, foreign, ownerBuysForeign }
}

/** What the spread cost against the reference mid, in paise: |rupees − foreign × mid|, rounded half away from zero. Derived. */
export function spreadCost(rupees: bigint, foreignMinor: bigint, foreign: Foreign, mid: Ratio): bigint {
  const den = mid.d * pow10(minorUnit(foreign))
  const atMid = foreignMinor * mid.n * pow10(minorUnit('INR'))
  const diff = rupees * den - atMid
  return divRound(diff < 0n ? -diff : diff, den, 'halfExpand')
}

// ------------------------------------------------------------------------------------------------ the Liberalised Remittance Scheme

/** RBI's ceiling, read from the primary source on the dates given. Modelled, not advice. */
export const LRS = {
  ceilingCents: 25_000_000n, // USD 2,50,000.00
  source: 'RBI, Master Direction – Liberalised Remittance Scheme (LRS), updated as on 6 Sep 2024',
  url: 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10192',
  read: 'read 18 Nov 2026 (compliance research, FX-01) and again 24 Nov 2026 (R13: the page still lists "Updated as on September 06, 2024" as its latest version, paragraph 1; page SHA-256 7432c7895e4259c503b6e0c8f48058fba33896e2084f1e8ae98b17e404418279)',
  quote: 'Authorised Dealers may freely allow remittances by resident individuals up to USD 2,50,000 per Financial Year (April-March) for any permitted current or capital account transaction or a combination of both.',
  label: 'Modelled from the RBI text, not advice. Your bank decides; QED counts every rupee conversion into another currency at its US-dollar equivalent on the reference rates of the day, rounded up.',
} as const

/** Said wherever a conversion of rupees is shown (the sheet, the money view): the cautious reading of what counts. */
export const LRS_HELD_NOTE = 'Rupees changed into another currency count now, even when the money stays in your account here and is never sent abroad, and changing it back does not give the count back: QED counts on the cautious side. Your bank decides what counts.'

/** The start of India's financial year (1 April, 00:00 IST) that contains an instant. The scheme is India's, so IST. */
export function financialYearStart(ms: number): number {
  const t = zonedParts(ms, 'Asia/Kolkata')
  return zonedInstant(`${t.m >= 4 ? t.y : t.y - 1}-04-01`, '00:00', 'Asia/Kolkata')
}

/** US cents an amount of a foreign currency counts as, at the reference rates of the time, rounded up (never undercounted). */
export function usdCents(a: Amount, refs: Map<Foreign, Rate>): bigint {
  const c = codeOf(a)
  if (c === 'USD') return a.minor
  if (c === 'INR') throw new MoneyError('invalid-argument', 'rupees are not counted toward the scheme')
  const r = refs.get(c as Foreign), usd = refs.get('USD')
  if (!r || !usd) throw new AppError(409, 'no_reference', `There is no reference rate for ${c} or the US dollar, so the scheme's figure cannot be counted.`)
  // a × (rupees per unit of c) / (rupees per dollar), in cents
  return divRound(a.minor * r.mid.n * usd.mid.d * pow10(minorUnit('USD')), r.mid.d * usd.mid.n * pow10(minorUnit(c)), 'ceil')
}

export interface LrsStatus { usedCents: bigint; ceilingCents: bigint; leftCents: bigint; fyStart: number; source: string; url: string; read: string; quote: string; label: string }
export function lrsStatus(db: Db, userId: string, now: number): LrsStatus {
  const fyStart = financialYearStart(now)
  const used = BigInt(db.get<{ s: string }>('SELECT amount_sum(lrs_usd_text) s FROM fx_fills WHERE user_id = ? AND filled_at >= ? AND lrs_usd_text IS NOT NULL', userId, fyStart)?.s ?? '0')
  const left = LRS.ceilingCents - used
  return { usedCents: used, ceilingCents: LRS.ceilingCents, leftCents: left > 0n ? left : 0n, fyStart, source: LRS.source, url: LRS.url, read: LRS.read, quote: LRS.quote, label: LRS.label }
}

const usdText = (cents: bigint): string => moneyText(money('USD', cents))

/** Refuses what would take the year's conversions of rupees past the scheme's ceiling, with the source. */
export function assertWithinLrs(db: Db, userId: string, addCents: bigint, now: number): LrsStatus {
  const s = lrsStatus(db, userId, now)
  if (s.usedCents + addCents > s.ceilingCents) {
    throw new AppError(409, 'lrs_ceiling', `This would bring what you have changed out of rupees since ${whenIn(s.fyStart, 'Asia/Kolkata').replace(', 00:00 IST', '')} to ${usdText(s.usedCents + addCents)}, above the Liberalised Remittance Scheme's ${usdText(s.ceilingCents)} a financial year (${LRS.source}). More needs the Reserve Bank's permission. ${LRS.label}`)
  }
  return s
}

// ------------------------------------------------------------------------------------------------ the protections a payment has

/**
 * What rupees leaving the bank account would do to what must stay there and to the floor, said before approval in the
 * words a payment's preview uses (owner.ts previewAction): the owner may go ahead; QED's instructions may not. Money held in another
 * currency counts in the worst case at its reference rate less a stated haircut (foreign-worst.ts), so a balance that is spent here counts less afterwards.
 */
export function rupeeOutflowWarnings(ctx: Ctx, userId: string, rupees: bigint, now: number, boughtForeign?: Amount): { warnings: string[]; acknowledged: { belowFloor: boolean; intoReserve: boolean } } {
  const out = Number(rupees)
  const w = worstCase(ctx.db, ctx.market, userId, now)
  // a conversion into a currency that stays in the paper bank gives a balance that counts too (at the haircut)
  const credit = boughtForeign ? Number(countedValue(referenceRates(ctx.market, now), codeOf(boughtForeign) as Foreign, boughtForeign.minor, now).counted) : 0
  const after = Math.round(w.gHat - out + credit), line = Math.round(w.line)
  const warnings: string[] = []
  const belowFloor = after < line
  if (belowFloor) warnings.push(`This takes your worst case to ${moneyText(money('INR', after))}, below your floor of ${moneyText(money('INR', line))}. You may do it yourself; QED's instructions may not. The worst case counts money held in other currencies at its reference rate less ${FOREIGN_HAIRCUT_BPS / 100}%.`)
  const l = staysLiquid(ctx.db, userId, now, out)
  if (!l.ok) warnings.unshift(`This leaves ${moneyText(money('INR', Math.round(l.leftAfter)))} in your bank account, and ${moneyText(money('INR', Math.round(l.needAfter)))} is needed for what is due${l.before.binding ? ` by ${dateText(l.before.binding.date)}` : ''}. You may do it yourself; QED's instructions may not.`)
  return { warnings, acknowledged: { belowFloor, intoReserve: !l.ok } }
}

// ------------------------------------------------------------------------------------------------ accounts and balances

/** The accounts a foreign currency is booked in: its balance, what was bought and sold, what is on its way abroad, what was paid abroad. */
export function ensureCurrencyAccounts(db: Db, userId: string, c: Foreign): void {
  const name = CURRENCY_NAMES[c]
  ensureAccount(db, userId, `bank:${c}`, 'asset', c, `${name} balance (paper)`, true)
  ensureAccount(db, userId, `fx:${c}`, 'trading', c, `${name}s bought and sold`, false)
  ensureAccount(db, userId, `xb:${c}`, 'clearing', c, `${name}s on their way abroad`, true)
  ensureAccount(db, userId, `exp:abroad:${c}`, 'expense', c, `Paid abroad in ${name}s`, false)
  ensureAccount(db, userId, 'fx:INR', 'trading', 'INR', 'Rupees exchanged for other currencies', false)
}

export const balanceAccount = (c: Currency): string => (c === 'INR' ? 'bank' : `bank:${c}`)
const freeIn = (db: Db, userId: string, c: Currency): bigint => (account(db, userId, balanceAccount(c)) ? available(db, userId, balanceAccount(c)) : 0n)

export interface CurrencyBalance { currency: Currency; name: string; minorUnit: number; account: string; balance: Amount; available: Amount }
/** Each currency the household holds, apart: rupees first, then every foreign balance opened, in the paper bank's order. */
export function balancesByCurrency(db: Db, userId: string): CurrencyBalance[] {
  const out: CurrencyBalance[] = []
  for (const c of PAPER_CURRENCIES) {
    const code = balanceAccount(c)
    if (c !== 'INR' && !account(db, userId, code)) continue
    out.push({ currency: c, name: CURRENCY_NAMES[c], minorUnit: minorUnit(c), account: code, balance: money(c, balance(db, userId, code)), available: money(c, account(db, userId, code) ? available(db, userId, code) : 0n) })
  }
  return out
}

export interface PricedLine { currency: Currency; balance: Amount; balanceText: string; rate: string | null; source: string | null; label: string | null; observedAt: number | null; value: Amount | null; valueText: string | null; exact: { n: string; d: string } }
export interface PricedTotal { total: Amount | null; totalText: string | null; why: string | null; rule: string; numeraire: 'INR'; at: number; lines: PricedLine[] }

export const TOTAL_RULE = 'Each balance is converted exactly at its reference rate; the sum is rounded once, half away from zero, to the paisa. A reference rate is not a price anyone can trade at.'

/**
 * One total in rupees across currencies, only with a priced conversion for every line: each names its rate, the rate's
 * source and the time it was observed. A currency without a usable rate means no total at all, and says which.
 */
export function pricedTotal(balances: readonly CurrencyBalance[], rates: Map<Foreign, Rate>, at: number): PricedTotal {
  const inr = currencyInstrument('INR')
  const lines: PricedLine[] = []
  const missing: string[] = []
  let n = 0n, d = 1n
  for (const b of balances) {
    if (b.currency === 'INR') {
      lines.push({ currency: 'INR', balance: b.balance, balanceText: moneyText(b.balance), rate: null, source: null, label: null, observedAt: null, value: b.balance, valueText: moneyText(b.balance), exact: { n: b.balance.minor.toString(), d: '1' } })
      n += b.balance.minor * d
      continue
    }
    const r = rates.get(b.currency as Foreign)
    let conv: ReturnType<typeof convert> | null = null
    let why = `no reference rate for ${b.currency}`
    if (r) {
      try { conv = convert(b.balance, r, currencyInstrument(b.currency), inr, { at, use: 'valuation', bound: 'mid', rounding: 'halfExpand' }) } catch (e) { why = `the ${b.currency} reference cannot be used now (${e instanceof Error ? e.message : String(e)})` }
    }
    if (!conv || !r) {
      missing.push(why)
      lines.push({ currency: b.currency, balance: b.balance, balanceText: moneyText(b.balance), rate: null, source: null, label: null, observedAt: null, value: null, valueText: null, exact: { n: '0', d: '1' } })
      continue
    }
    lines.push({ currency: b.currency, balance: b.balance, balanceText: moneyText(b.balance), rate: rateText(r.mid), source: r.source, label: r.label, observedAt: r.observedAt, value: conv.to, valueText: moneyText(conv.to), exact: { n: conv.exact.n.toString(), d: conv.exact.d.toString() } })
    n = n * conv.exact.d + conv.exact.n * d
    d = d * conv.exact.d
  }
  if (missing.length) return { total: null, totalText: null, why: `No total is given: ${missing.join('; ')}. Currencies are never added without a priced conversion.`, rule: TOTAL_RULE, numeraire: 'INR', at, lines }
  const total = money('INR', divRound(n, d, 'halfExpand'))
  return { total, totalText: moneyText(total), why: null, rule: TOTAL_RULE, numeraire: 'INR', at, lines }
}

// ------------------------------------------------------------------------------------------------ quotes, approval, fill

export interface QuoteDoc {
  id: string; desk: string; sell: AmountJSON; buy: AmountJSON; fixed: 'sell' | 'buy'
  rate: { kind: 'executable'; base: string; quote: string; value: string; source: string; label: 'sandbox' }
  reference: { kind: 'reference'; base: string; quote: string; mid: string; midText: string; source: string; label: string; observedAt: number }
  spreadBps: number; fee: AmountJSON; quotedAt: number; expiresAt: number; rounding: string
  /**
   * Present on a payment that several members must sign (abroad.ts): the quote is INDICATIVE. Its rate and terms are what the desk
   * would give now; what is signed is the ceiling in rupees. At the moment of sending a fresh quote is asked for, and it is used
   * only if its price is within the ceiling. `expiresAt` is then when the approval closes, not a 60-second quote's expiry.
   */
  indicative?: { bandBps: number; ceiling: AmountJSON }
}
export interface SheetLine { label: string; value: string; basis: 'exact' | 'rule' | 'reference' | 'estimate'; note?: string }

/** "10:31:05 IST": a quote's expiry, to the second, in the household's zone. */
export function clockText(ms: number, zone: string): string {
  const seconds = new Date(ms + offsetMs(ms, zone)).getUTCSeconds()
  return `${zonedParts(ms, zone).hm}:${String(seconds).padStart(2, '0')} ${zoneLabel(ms, zone)}`
}

const cleanCode = (v: unknown): string => (typeof v === 'string' ? v.trim().toUpperCase().slice(0, 8) : '')

/** An amount the owner typed in a currency, refused in words when it is not one. */
export function amountIn(c: Currency, v: unknown, field = 'amount'): Amount {
  const text = typeof v === 'string' ? v.trim().replace(/,/g, '') : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  const e = minorUnit(c)
  let a: Amount
  try { a = moneyFromDecimal(c, text) } catch { throw bad(`Enter an amount of ${c} with ${e === 0 ? 'no decimal places' : `at most ${e} decimal place${e === 1 ? '' : 's'}`}.`, { [field]: `${c} has ${e} decimal place${e === 1 ? '' : 's'} (ISO 4217).` }) }
  if (a.minor <= 0n) throw bad('Enter an amount above zero.', { [field]: 'Enter an amount above zero.' })
  return a
}

/** The pair, checked: two currencies the paper bank holds, one of them rupees. */
export function checkPair(sellRaw: unknown, buyRaw: unknown): { sell: Currency; buy: Currency; foreign: Foreign } {
  const sell = cleanCode(sellRaw), buy = cleanCode(buyRaw)
  for (const c of [sell, buy]) if (!isPaperCurrency(c)) throw new AppError(400, 'currency_not_held', `The paper bank does not hold ${c || 'that currency'}. It holds ${PAPER_CURRENCIES.join(', ')}.`)
  if (sell === buy) throw bad('Choose two different currencies.')
  if (sell !== 'INR' && buy !== 'INR') throw new AppError(409, 'pair_not_offered', `The paper desk changes rupees and one other currency. To change ${sell} into ${buy}, change ${sell} into rupees first: it never routes through a third currency for you.`)
  return { sell: sell as Currency, buy: buy as Currency, foreign: (sell === 'INR' ? buy : sell) as Foreign }
}

/** The executable quote's terms, priced now from the reference, with the desk's (or a route's) fee. Refuses what cannot be filled. */
export function makeQuote(ctx: Ctx, userId: string, req: { sell: Currency; buy: Currency; foreign: Foreign; fixed: 'sell' | 'buy'; amount: Amount; fee?: bigint }, now: number): { quote: QuoteDoc; reference: Rate } {
  const reference = referenceRates(ctx.market, now).get(req.foreign)
  if (!reference) throw new AppError(409, 'no_reference', `There is no reference rate for ${req.foreign}, so the paper desk gives no quote.`)
  const spreadBps = DESK.spreadBps[req.foreign]
  const p = priceConversion({ sell: req.sell, buy: req.buy, amount: req.amount.minor, fixed: req.fixed, reference, spreadBps })
  if (p.sell <= 0n || p.buy <= 0n) throw refused('too_small', `That comes to less than one minor unit of ${p.sell <= 0n ? req.sell : req.buy} at this rate.`)
  const fee = req.fee ?? DESK.feeMinor
  const id = newId('fxq', now)
  const quote: QuoteDoc = {
    id, desk: DESK.name, sell: amountToJSON(money(req.sell, p.sell)), buy: amountToJSON(money(req.buy, p.buy)), fixed: req.fixed,
    rate: { kind: 'executable', base: `iso4217:${req.foreign}`, quote: INR_ID, value: p.rate, source: `${DESK.name}: the reference moved ${spreadBps} basis points against you (modelled)`, label: 'sandbox' },
    reference: { kind: 'reference', base: reference.base, quote: reference.quote, mid: showRatio(reference.mid), midText: rateText(reference.mid), source: reference.source, label: reference.label, observedAt: reference.observedAt },
    spreadBps, fee: amountToJSON(money('INR', fee)), quotedAt: now, expiresAt: now + FX_QUOTE_TTL_MS, rounding: ROUNDING_RULE,
  }
  return { quote, reference }
}

/** The lines the owner reads before approving: rate, reference, spread and fee kept apart, and when the quote expires. */
export function quoteLines(q: QuoteDoc, zone: string): SheetLine[] {
  const sell = money(q.sell.instrument.slice(8), q.sell.minor), buy = money(q.buy.instrument.slice(8), q.buy.minor)
  const foreign = q.rate.base.slice(8)
  const fee = money('INR', q.fee.minor)
  return [
    { label: 'Rate', value: `₹${q.rate.value} per ${foreign}`, basis: 'exact', note: 'The paper desk\'s executable price until the quote expires: not a market\'s, and no real money' },
    { label: 'Reference', value: `₹${q.reference.midText} per ${foreign}`, basis: 'reference', note: `${q.reference.source}. A reference rate: nobody can trade at it.${q.reference.label === 'synthetic' ? ' Synthetic.' : ''}` },
    { label: 'Spread', value: `${(q.spreadBps / 100).toFixed(2)}%`, basis: 'rule', note: 'The desk\'s modelled spread over the reference, apart from the fee' },
    { label: 'Fee', value: moneyText(fee), basis: 'rule', note: 'Charged apart from the rate (modelled)' },
    { label: 'You pay', value: moneyText(sell), basis: 'exact', note: q.fixed === 'sell' ? 'As you asked' : 'Rounded up to the minor unit' },
    { label: 'You receive', value: moneyText(buy), basis: 'exact', note: q.fixed === 'buy' ? 'As you asked' : 'Rounded down to the minor unit' },
    { label: 'Quote expires', value: clockText(q.expiresAt, zone), basis: 'exact', note: 'After this it is refused, even if approved: ask for a new one' },
  ]
}

export interface FxPreview { approvalId: string; document: string; docHash: string; expiresAt: number; quote: QuoteDoc; lines: SheetLine[]; warnings: string[]; summary: string; lrs: { usedText: string; afterText: string; ceilingText: string; source: string } | null }

/** Ask the desk for an executable quote, and open the approval of its exact terms (POST /api/fx/quote). */
export function prepareConversion(ctx: Ctx, userId: string, raw: Raw): FxPreview {
  const { db } = ctx
  const now = ctx.clock.now()
  const profile = getProfile(db, userId)
  assertOffered(FX_DESK_OFFER, jurisdictionOf(profile))
  const { sell, buy, foreign } = checkPair(raw.sell, raw.buy)
  const fixed = raw.fixed === 'sell' ? 'sell' : raw.fixed === 'buy' ? 'buy' : null
  if (!fixed) throw bad('Say which amount is fixed: what you sell or what you buy.', { fixed: 'Choose sell or buy.' })
  const amt = amountIn(fixed === 'sell' ? sell : buy, raw.amount)
  const { quote } = makeQuote(ctx, userId, { sell, buy, foreign, fixed, amount: amt }, now)
  const s = BigInt(quote.sell.minor), b = BigInt(quote.buy.minor)
  let lrs: FxPreview['lrs'] = null
  const guard = sell === 'INR' ? rupeeOutflowWarnings(ctx, userId, s + DESK.feeMinor, now, money(buy, b)) : { warnings: [], acknowledged: { belowFloor: false, intoReserve: false } }
  const warnings: string[] = guard.warnings
  if (sell === 'INR') {
    const need = s + DESK.feeMinor, free = freeIn(db, userId, 'INR')
    if (need > free) throw new AppError(409, 'insufficient_funds', `You have ${moneyText(money('INR', free))} free in your bank account; this needs ${moneyText(money('INR', need))} with the fee.`)
    const cents = usdCents(money(buy, b), referenceRates(ctx.market, now))
    const st = assertWithinLrs(db, userId, cents, now)
    lrs = { usedText: usdText(st.usedCents), afterText: usdText(st.usedCents + cents), ceilingText: usdText(st.ceilingCents), source: LRS.source }
  } else {
    const free = freeIn(db, userId, sell)
    if (s > free) throw new AppError(409, 'insufficient_funds', `You have ${moneyText(money(sell, free))} free; this needs ${moneyText(money(sell, s))}.`)
    if (b <= DESK.feeMinor) throw refused('too_small', `This would give you ${moneyText(money('INR', b))}, no more than the desk's fee of ${moneyText(money('INR', DESK.feeMinor))}.`)
  }
  const zone = zoneOf(profile)
  const lines = quoteLines(quote, zone)
  if (lrs) lines.push({ label: 'Liberalised Remittance Scheme', value: `${lrs.afterText} of ${lrs.ceilingText} this financial year`, basis: 'rule', note: `${LRS.source}. ${LRS_HELD_NOTE} ${LRS.label}` })
  const summary = `Change ${moneyText(money(sell, s))} into ${moneyText(money(buy, b))}`
  const rupees = sell === 'INR' ? s + DESK.feeMinor : b
  const doc = canonical({
    v: 2, kind: 'fx-conversion', what: summary, quote,
    account: { from: balanceAccount(sell), to: balanceAccount(buy) }, rail: 'paper-fx-desk', recipient: 'Yourself: your own balances at the paper bank',
    timeZone: zone, tzVersion: TZ_VERSION, calendar: 'none: a conversion settles at once on paper',
    sizePaise: Number(rupees), acknowledged: guard.acknowledged, estimate: lines, warnings,
    note: 'Approving lets QED make exactly this conversion, once, before the quote expires. Paper desk: no real money moves.',
  })
  const a = createApproval(db, userId, { purpose: 'fx-conversion', subject: `fx:${quote.id}`, document: doc, ttlMs: FX_QUOTE_TTL_MS, requiresStepUp: true }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: quote.expiresAt, quote, lines, warnings, summary, lrs }
}

export interface FillRow { id: string; user_id: string; quote_id: string; approval_id: string; entry_id: string; purpose: string; sell_ccy: string; sell_text: string; buy_ccy: string; buy_text: string; rate: string; reference_json: string; spread_bps: number; spread_text: string; fee_text: string; lrs_usd_text: string | null; filled_at: number }

/**
 * Book a conversion at its quote's terms: rupees and the other currency each on their own accounts, balanced in each, the
 * fee apart; then the fill record with rate, spread and fee in separate columns. `toAccount` sends what is bought abroad
 * (a payment's money in transit) instead of into the balance. Runs inside the caller's transaction.
 */
export function bookConversion(ctx: Ctx, userId: string, q: QuoteDoc, o: { approvalId: string; now: number; purpose: 'conversion' | 'payment'; ref?: string; kind?: string; memo?: string; toAccount?: string; extraLines?: { account: string; amount: bigint }[] }): { fill: FillRow; entryId: string } {
  const { db } = ctx
  const sell = q.sell.instrument.slice(8) as Currency, buy = q.buy.instrument.slice(8) as Currency
  const foreign = (sell === 'INR' ? buy : sell) as Foreign
  const s = BigInt(q.sell.minor), b = BigInt(q.buy.minor), fee = BigInt(q.fee.minor)
  ensureCurrencyAccounts(db, userId, foreign)
  const lines = sell === 'INR'
    ? [{ account: 'bank', amount: -(s + fee) }, { account: 'fx:INR', amount: s }, { account: 'exp:fees', amount: fee }, { account: `fx:${buy}`, amount: -b }, { account: o.toAccount ?? `bank:${buy}`, amount: b }]
    : [{ account: `bank:${sell}`, amount: -s }, { account: `fx:${sell}`, amount: s }, { account: 'fx:INR', amount: -b }, { account: 'bank', amount: b - fee }, { account: 'exp:fees', amount: fee }]
  const memo = o.memo ?? `Changed ${moneyText(money(sell, s))} into ${moneyText(money(buy, b))} at ₹${q.rate.value} per ${foreign} (paper desk)`
  const e = post(db, { userId, ts: o.now, kind: o.kind ?? 'fx-conversion', ref: o.ref ?? `fx:${q.id}`, memo, meta: { paper: true, quoteId: q.id, rate: q.rate.value, spreadBps: q.spreadBps, fee: q.fee.minor, reference: { mid: q.reference.mid, source: q.reference.source, observedAt: q.reference.observedAt } }, lines: [...lines, ...(o.extraLines ?? [])] })
  const mid = parseRatio(q.reference.mid)
  const rupees = sell === 'INR' ? s : b, foreignMinor = sell === 'INR' ? b : s
  let lrsCents: bigint | null = null
  if (sell === 'INR') lrsCents = usdCents(money(buy, b), referenceRates(ctx.market, o.now))
  const id = newId('fxf', o.now)
  db.run(`INSERT INTO fx_fills (id, user_id, quote_id, approval_id, entry_id, purpose, sell_ccy, sell_text, buy_ccy, buy_text, rate, reference_json, spread_bps, spread_text, fee_text, lrs_usd_text, filled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, userId, q.id, o.approvalId, e.id, o.purpose, sell, q.sell.minor, buy, q.buy.minor, q.rate.value, j(q.reference), q.spreadBps, spreadCost(rupees, foreignMinor, foreign, mid).toString(), q.fee.minor, lrsCents === null ? null : lrsCents.toString(), o.now)
  return { fill: db.get<FillRow>('SELECT * FROM fx_fills WHERE id = ?', id)!, entryId: e.id }
}

export interface FillView { fillId: string; duplicate: boolean; entryId: string; sellText: string; buyText: string; rate: string; spreadBps: number; spreadText: string; feeText: string; reference: QuoteDoc['reference']; filledAt: number }
export function fillView(f: FillRow, duplicate: boolean): FillView {
  return {
    fillId: f.id, duplicate, entryId: f.entry_id, sellText: moneyText(money(f.sell_ccy, f.sell_text)), buyText: moneyText(money(f.buy_ccy, f.buy_text)), rate: f.rate,
    spreadBps: f.spread_bps, spreadText: moneyText(money('INR', f.spread_text)), feeText: moneyText(money('INR', f.fee_text)), reference: JSON.parse(f.reference_json) as QuoteDoc['reference'], filledAt: f.filled_at,
  }
}

/** The approved quote, read back and checked: the terms come from the approved document, never from the request. */
export function approvedQuote(db: Db, userId: string, approvalId: string, purpose: string, now: number, zone: string): { doc: Record<string, unknown> & { quote: QuoteDoc }; hash: string; subject: string } {
  const a = getApproval(db, userId, approvalId)
  if (!a || a.purpose !== purpose) throw notFound('That quote')
  if (!a.confirmed_at || a.cancelled_at) throw refused('approval_missing', 'Approve the quote with your passkey first.')
  if (a.consumed_at) throw refused('approval_used', 'That approval has already been used.')
  if (sha256hex(a.document) !== a.doc_hash) throw new AppError(500, 'approval_corrupt', 'The stored terms do not match their hash. Nothing was done.')
  const doc = JSON.parse(a.document) as Record<string, unknown> & { quote: QuoteDoc }
  if (now > doc.quote.expiresAt) throw refused('quote_expired', `This quote expired at ${clockText(doc.quote.expiresAt, zone)}. Nothing was changed. Ask for a new quote.`)
  return { doc, hash: a.doc_hash, subject: a.subject }
}

/** Make the approved conversion (POST /api/fx/convert). Once: the same approval again returns the same fill. */
export function convertApproved(ctx: Ctx, userId: string, approvalId: string): FillView {
  const { db } = ctx
  const done = db.get<FillRow>('SELECT * FROM fx_fills WHERE user_id = ? AND approval_id = ?', userId, approvalId)
  if (done) return fillView(done, true)
  const now = ctx.clock.now()
  const zone = zoneOf(getProfile(db, userId))
  const { doc, hash, subject } = approvedQuote(db, userId, approvalId, 'fx-conversion', now, zone)
  return db.tx(() => {
    consumeApproval(db, userId, approvalId, subject, hash, now)
    const q = doc.quote
    if (q.sell.instrument === INR_ID) assertWithinLrs(db, userId, usdCents(money(q.buy.instrument.slice(8), q.buy.minor), referenceRates(ctx.market, now)), now)
    const { fill } = bookConversion(ctx, userId, q, { approvalId, now, purpose: 'conversion' })
    audit(db, now, userId, 'owner', 'fx.fill', fill.id, { approvalId, docHash: hash, quoteId: q.id, rate: q.rate.value, spreadBps: q.spreadBps, fee: q.fee.minor })
    return fillView(fill, false)
  })
}

/** Every fill, newest first, for the record (GET /api/fx/fills). */
export const fills = (db: Db, userId: string, limit = 50): FillView[] =>
  db.all<FillRow>('SELECT * FROM fx_fills WHERE user_id = ? ORDER BY filled_at DESC, rowid DESC LIMIT ?', userId, Math.min(Math.max(limit, 1), 500)).map((f) => fillView(f, false))

/** What the screens read (GET /api/money): balances by currency, the priced total with its rates, the scheme's figure, the references. */
export function moneyView(ctx: Ctx, userId: string): Record<string, unknown> {
  const { db } = ctx
  const now = ctx.clock.now()
  const profile = getProfile(db, userId)
  const zone = zoneOf(profile)
  const refs = referenceRates(ctx.market, now)
  const balances = balancesByCurrency(db, userId)
  const total = pricedTotal(balances, refs, now)
  const lrs = lrsStatus(db, userId, now)
  return {
    zone, zoneLabel: zoneLabel(now, zone), tzVersion: TZ_VERSION, jurisdiction: jurisdictionOf(profile), at: now, atText: whenIn(now, zone),
    currencies: PAPER_CURRENCIES.map((c) => ({ code: c, name: CURRENCY_NAMES[c], minorUnit: minorUnit(c) })),
    balances: balances.map((b) => ({ currency: b.currency, name: b.name, minorUnit: b.minorUnit, account: b.account, minor: b.balance.minor.toString(), text: moneyText(b.balance), availableText: moneyText(b.available) })),
    total: { text: total.totalText, minor: total.total?.minor.toString() ?? null, why: total.why, rule: total.rule, lines: total.lines.map((l) => ({ currency: l.currency, balanceText: l.balanceText, rate: l.rate, source: l.source, label: l.label, observedAt: l.observedAt, observedText: l.observedAt === null ? null : whenIn(l.observedAt, zone), valueText: l.valueText })) },
    references: FOREIGN_CURRENCIES.map((c) => { const r = refs.get(c as Foreign)!; return { currency: c, kind: r.kind, mid: rateText(r.mid), source: r.source, label: r.label, observedAt: r.observedAt, observedText: whenIn(r.observedAt, zone) } }),
    desk: { name: DESK.name, feeText: moneyText(money('INR', DESK.feeMinor)), spreadBps: DESK.spreadBps, words: DESK.words, ttlSeconds: FX_QUOTE_TTL_MS / 1000, rounding: ROUNDING_RULE },
    lrs: { usedText: usdText(lrs.usedCents), leftText: usdText(lrs.leftCents), ceilingText: usdText(lrs.ceilingCents), fyStartText: whenIn(lrs.fyStart, 'Asia/Kolkata'), source: lrs.source, url: lrs.url, read: lrs.read, quote: lrs.quote, label: lrs.label, heldNote: LRS_HELD_NOTE },
    fills: fills(db, userId, 20),
  }
}
