/**
 * Things the owner does by hand: buy, sell, pay, register payees and bills, record earnings, raise disputes.
 *
 * A manual order or payment is previewed first. The preview is a document: the exact parameters that will be sent,
 * an estimate from current recorded data (order-book depth, NAV entitlement, rail and timing, fees and tax), the
 * effect on the worst case, and warnings. The owner approves that document; the action that executes is built from
 * the approved document itself, so what runs is what was shown.
 */
import { startPause } from './dispute-pause.ts'
import { approvalLapsed, createApproval, getApproval, LAPSED_TEXT, PASSWORD_FREE_PAISE_PER_DAY, passwordFreeApproved } from './approvals.ts'
import { actor, requiredSigners } from './workspaces.ts'
import type { Session } from './auth.ts'
import { chainDeadline, chainDecisionRefusal, deliverChainMilestone, isChainMilestone, recordChainFailure, refundChainMilestone, releaseChainMilestone } from './earn-chain.ts'
import { clientPaper, openJob, submitPaper } from './escrow.ts'
import type { Asker, RailCfg } from './rail.ts'
import { AppError, audit, bad, type Db, emit, j, newId, notFound, refused } from './core.ts'
import { createAction, notice } from './execute.ts'
import { available, balance, post } from './ledger.ts'
import { dateText, hardshipText, staysLiquid } from './liquidity.ts'
import type { Book } from './market.ts'
import { crossCheck } from './policy.ts'
import { amountText, whenIst } from './programs.ts'
import { exchangeCostsStatus, type Instrument, instrument, term } from './registry.ts'
import { issueReceipt, sha256hex } from './receipts.ts'
import type { ActionRow, Ctx, OrderParams, PaymentParams } from './types.ts'
import { addWarning, payeeWarning } from './lookalike.ts'
import { checkPayeeName, isNameOutcome, nameCheckAddMessage, nameCheckWords, type NameOutcome } from './name-check.ts'
import { DUPLICATE_RULE, repeatOf, repeatWords } from './duplicates.ts'
import { firstPaymentCaution, holdFor, holdWarning } from './new-payee.ts'
import { getProfile, jurisdictionOf, TZ_VERSION, zoneOf } from './household.ts'
import { householdHome, requireRupeeHome, thresholdIn, withHome } from './home-currency.ts'
import { assertOffered, instrumentOffer } from './eligibility.ts'
import { passwordWork, recordPrepared, tellPayeeAdded } from './prepared.ts'
import { billCover, limitFor, worstCase } from './valuation.ts'
import { signedGoal } from './goals.ts'
import { SETASIDE_HANDLE, setAside } from './setaside.ts'
import { FUND_PAY_IN_MS, fundEntitlement, matchBook, navEntitlement, payoutInstant, type RailName, type Side, smallestMarketBuy } from './venues.ts'
import { dayText, istDay } from '../shared/day-text.ts'
import { floorToStep, fraction, mulDiv, notional, parseDec, parsePrice, pow10, quantityFor } from '../shared/fixed.ts'
import { canonical } from '../shared/sha256.ts'
import { resolveValidity, standsUntilText } from './validity.ts'
import { closedText, DATA_LABEL, isSecurity, securityCosts, sessionOf } from './securities.ts'

/** At or above this size, or when an action takes the worst case below the floor or dips into the bank reserve, the password is asked again. */
export const STEP_UP_PAISE = 1_000_000

type Raw = Record<string, unknown>
const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 100_000_000_000
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')

export interface ActionPreview {
  approvalId: string; document: string; docHash: string; expiresAt: number; requiresStepUp: boolean
  summary: string; lines: { label: string; value: string; basis: string; note?: string }[]; warnings: string[]; worst: { before: number; after: number; line: number }
  /** Prices an estimate was worked out on, when they came from a live order book (R7-094). */
  quote: Quote | null
}
/** When and from where an estimate was priced, and until when it holds; null validity means indicative only. */
export interface Quote { at: number; validUntil: number | null; source: string; best: string; indicative: boolean }
/** How long an estimate priced on a live order book holds (shorter only on a test stack). The approval for it lapses with it. */
export const QUOTE_TTL_MS = Number(process.env.QED_QUOTE_TTL_SEC) > 0 ? Number(process.env.QED_QUOTE_TTL_SEC) * 1000 : 60_000

interface Built { kind: 'order' | 'payment'; venue: string; params: OrderParams | PaymentParams; summary: string; lines: ActionPreview['lines']; warnings: string[]; basis: string[]; sizePaise: number; worstDelta: number; quote?: { source: string; best: string } }

/**
 * An order's sheet names who it goes to, what asset, by which route and what follows once approved, before and after its
 * figures (R12 section 4: the approval shows the recipient, amount, asset, network and consequences). The venues are
 * paper: no order leaves this computer, and the sheet says so.
 */
function framed(inst: Instrument, side: Side, type: 'nav' | 'market' | 'limit' | 'stop', b: Built, synthetic = false): Built {
  const fund = inst.kind === 'mutual_fund'
  // in presentation mode the NAVs and the book are generated on this computer: the sheet says so, never AMFI or a live book
  const priced = fund
    ? synthetic ? 'it is priced at a synthetic NAV generated on this computer (presentation mode).' : 'it is priced at the NAV the fund house publishes through AMFI.'
    : synthetic ? 'it is priced against a synthetic order book generated on this computer (presentation mode).' : 'it is priced against the live prices on its book.'
  const head: Built['lines'] = [
    { label: 'Placed with', value: fund ? 'the fund house, on paper' : "CoinDCX's order book, on paper", basis: 'rule', note: `Practice money: no order reaches ${fund ? 'the fund house' : 'CoinDCX'}; ${priced}` },
    { label: 'Asset', value: fund ? `Units of ${inst.name}` : `${inst.base_asset}, for Indian rupees`, basis: 'exact' },
    { label: 'Route', value: 'A paper venue on this computer', basis: 'rule', note: 'No exchange, fund house, bank or blockchain is contacted.' },
  ]
  const tail: Built['lines'][number] = fund
    ? side === 'buy'
      ? { label: 'Once you approve', value: 'The amount leaves your bank now; units are allotted at the NAV the rule above gives', basis: 'rule', note: 'It cannot be cancelled once the cut-off has passed.' }
      : { label: 'Once you approve', value: 'The units are redeemed at the NAV the rule above gives; the money follows on the day shown', basis: 'rule', note: 'It cannot be cancelled once the cut-off has passed.' }
    : type === 'limit'
      ? { label: 'Once you approve', value: 'It rests on the book until it fills at your price or you cancel it', basis: 'rule', note: 'Part of it may fill at once; what has filled cannot be undone.' }
      : type === 'stop'
        ? { label: 'Once you approve', value: 'When buyers offer your trigger or less, it sells at what they offer', basis: 'rule', note: 'That can be lower than the trigger; a sale cannot be undone.' }
        : { label: 'Once you approve', value: 'It fills at once against the book, no worse than your worst price', basis: 'rule', note: 'What cannot fill inside it is cancelled; a fill cannot be undone.' }
  return { ...b, lines: [...head, ...b.lines, tail] }
}

/**
 * What a market order costs against the mid price, in paise, split so the parts sum to the whole exactly (F-083): half
 * the gap between the best bid and ask, the walk down the book beyond the best price (what remains), and the venue fee.
 * Tax deducted at source on a sale is a credit against income tax, not a cost, and is left out.
 */
export function midCost(side: Side, bid: number, ask: number, qty: number, amountPaise: number, feePaise: number): { mid: number; total: number; halfSpread: number; impact: number } | null {
  if (!(qty > 0) || !(bid > 0) || !(ask >= bid)) return null
  const mid = (bid + ask) / 2
  const atMid = Math.round(qty * mid * 100)
  const total = side === 'buy' ? amountPaise + feePaise - atMid : atMid - (amountPaise - feePaise)
  const halfSpread = Math.round(qty * (side === 'buy' ? ask - mid : mid - bid) * 100)
  return { mid, total, halfSpread, impact: total - feePaise - halfSpread }
}

async function buildOrder(ctx: Ctx, userId: string, raw: Raw, now: number): Promise<Built> {
  requireRupeeHome(householdHome(ctx.db, userId), 'Buying and selling funds, shares and coins')
  const { db } = ctx
  const inst = typeof raw.instrumentId === 'string' ? instrument(db, raw.instrumentId) : undefined
  if (!inst || !inst.tradable) throw bad('Choose something QED can trade.', { instrumentId: 'Choose something QED can trade.' })
  // R7-057: refused where it is not offered, with the reason (server/eligibility.ts)
  assertOffered(instrumentOffer({ id: inst.id, kind: inst.kind, venue: inst.venue, name: inst.name, tradable: inst.tradable === 1 }), jurisdictionOf(getProfile(db, userId)))
  const side: Side = raw.side === 'sell' ? 'sell' : 'buy'
  // a fund, a share, an ETF, a bill or a bond cannot rest: a time to stand until is refused here, as it is on a coin market order
  if (inst.kind === 'mutual_fund' || isSecurity(inst)) resolveValidity(raw, 'market', now)
  const lines: Built['lines'] = [], warnings: string[] = [], basis: string[] = []
  const lim = limitFor(db, inst)
  const free = available(db, userId, `pos:${inst.id}`)

  if (inst.kind === 'mutual_fund') {
    const nav = ctx.market.get(inst.id, 'nav')
    if (!nav) throw refused('no_price', `No NAV has been received for ${inst.name} yet.`)
    // the NAV day by when the money reaches the fund house (a purchase) or the request reaches the registrar, in words
    const ent = fundEntitlement(inst, side, now)
    const today = istDay(now)
    const navSource = nav.provider === 'synthetic' ? 'generated on this computer (presentation mode)' : 'published by AMFI'
    basis.push(`Latest NAV ${nav.price} is for ${dayText(istDay(nav.sourceTs ?? 0), today)}, ${navSource} and received ${whenIst(nav.recvTs)}. It is not the price this order will get.`)
    const arrives = side === 'buy' ? `On paper the money reaches the fund house about ${Math.round(FUND_PAY_IN_MS / 1000)} seconds after you approve, ${ent.beforeCutoff ? 'before' : 'after'} the ${ent.cutoff} India time cut-off.` : `The request reaches the registrar when you approve, ${ent.beforeCutoff ? 'before' : 'after'} the ${ent.cutoff} India time cut-off.`
    lines.push({ label: 'Executes at', value: `the NAV for ${dayText(ent.minNavDate, today)}, or the next one published`, basis: 'rule', note: `${arrives} ${ent.rule}` })
    if (side === 'buy') {
      if (!isPaise(raw.amount) || raw.amount < 10_000) throw bad('Enter an amount of at least ₹100.', { amount: 'Enter an amount of at least ₹100.' })
      const stamp = Number(mulDiv(BigInt(raw.amount), parseDec(String(term(db, 'mf.stamp')?.value.rate ?? '0.00005'), 12), pow10(12) + parseDec(String(term(db, 'mf.stamp')?.value.rate ?? '0.00005'), 12), 'half'))
      const units = quantityFor(BigInt(raw.amount - stamp), 2, parsePrice(nav.price), inst.baseScale, 'down')
      lines.push({ label: 'Leaves your bank now', value: amountText(raw.amount, 2), basis: 'exact' })
      lines.push({ label: 'Stamp duty', value: amountText(stamp, 2), basis: 'exact', note: '0.005% of the purchase' })
      lines.push({ label: 'Units at the latest NAV', value: `about ${(Number(units) / 1000).toFixed(3)}`, basis: 'estimate', note: 'The real number depends on the NAV published for the applicable day' })
      return framed(inst, side, 'nav', { kind: 'order', venue: inst.venue, params: { instrumentId: inst.id, side, type: 'nav', amount: String(raw.amount), purpose: 'manual' }, summary: `Buy ${amountText(raw.amount)} of ${inst.name}`, lines, warnings, basis, sizePaise: raw.amount, worstDelta: -Math.round(raw.amount * lim.fall) }, nav.provider === 'synthetic')
    }
    const sellAll = raw.sellAll === true
    const qty = sellAll ? free : typeof raw.qty === 'string' && /^\d+(\.\d{1,3})?$/.test(raw.qty) ? parseDec(raw.qty, inst.baseScale, 'down') : 0n
    if (qty <= 0n) throw bad('Enter how many units to redeem.', { qty: 'Enter how many units to redeem, to three decimals at most.' })
    if (qty > free) throw refused('insufficient_holding', `You have ${(Number(free) / 1000).toFixed(3)} units free to redeem.`)
    const gross = Number(notional(qty, inst.baseScale, parsePrice(nav.price), 2, 'down'))
    lines.push({ label: 'Units redeemed', value: (Number(qty) / 1000).toFixed(3), basis: 'exact' })
    lines.push({ label: 'Value at the latest NAV', value: `about ${amountText(gross, 2)}`, basis: 'estimate', note: 'Before any exit load; the executing NAV can differ' })
    lines.push({ label: 'Money reaches your bank', value: `${inst.meta.payoutDays ?? 2} working day${(inst.meta.payoutDays ?? 2) === 1 ? '' : 's'} after the NAV date`, basis: 'rule', note: `If it is the NAV for ${dayText(ent.minNavDate, today)}: ${whenIst(payoutInstant(ent.minNavDate, inst.meta.payoutDays ?? 2))}` })
    if (inst.meta.exitLoad === 'mf.exitload.liquid') warnings.push('Units bought in the last six days carry a small exit load.')
    return framed(inst, side, 'nav', { kind: 'order', venue: inst.venue, params: { instrumentId: inst.id, side, type: 'nav', qty: qty.toString(), purpose: 'manual' }, summary: `Redeem ${(Number(qty) / 1000).toFixed(3)} units of ${inst.name}`, lines, warnings, basis, sizePaise: gross, worstDelta: 0 }, nav.provider === 'synthetic')
  }

  if (isSecurity(inst)) return securityOrder(ctx, inst, side, raw, now, free, lim)

  // Traded on an order book: estimate against a book fetched now.
  const rules = ctx.venues.crypto.rules(inst)
  let book: Book
  try { book = await ctx.venues.crypto.book(inst) } catch (e) { throw refused('no_price', `No current order book for ${inst.name} (${e instanceof Error ? e.message : 'unavailable'}). Try again in a moment.`) }
  const type = raw.type === 'limit' ? 'limit' : raw.type === 'stop' ? 'stop' : 'market'
  const slip = typeof raw.maxSlippageBps === 'number' && Number.isInteger(raw.maxSlippageBps) && raw.maxSlippageBps >= 1 && raw.maxSlippageBps <= 500 ? raw.maxSlippageBps : 100
  const levels = side === 'buy' ? book.asks : book.bids
  const best = parsePrice(levels[0]!.price)
  const priceText = (v: unknown, field: string): string => { if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw bad('Enter a price.', { [field]: 'Enter a price.' }); return v }
  const limitPrice = type === 'limit' ? priceText(raw.limitPrice, 'limitPrice') : undefined
  // how long a resting order stands: a term of the order, so it is inside the document that is signed (validity.ts)
  const validity = type === 'limit' ? resolveValidity(raw, type, now) : (resolveValidity(raw, type, now), undefined)
  const stopPrice = type === 'stop' ? priceText(raw.stopPrice, 'stopPrice') : undefined
  if (type === 'stop' && side !== 'sell') throw bad('A stop order here can only sell.', { type: 'A stop order here can only sell.' })
  const bound = limitPrice ? parsePrice(limitPrice) : side === 'buy' ? best + mulDiv(best, BigInt(slip), 10_000n, 'down') : best - mulDiv(best, BigInt(slip), 10_000n, 'down')
  basis.push(`Order book for ${inst.name} from ${book.provider}: source time ${book.sourceTs ? new Date(book.sourceTs).toISOString() : 'not supplied'}, received ${new Date(book.recvTs).toISOString()}. Best bid ${book.bids[0]!.price}, best ask ${book.asks[0]!.price}.`)
  const cc = crossCheck(ctx, inst, now)
  if (inst.meta.crossCheck) { basis.push(`Independent price check: ${cc.detail}`); if (cc.available && !cc.ok) warnings.push('The venue price disagrees with the independent price by more than the limit. An order placed now is refused.') }
  const spread = (Number(book.asks[0]!.price) - Number(book.bids[0]!.price)) / Number(book.asks[0]!.price)
  lines.push({ label: 'Buyers offer / sellers ask', value: `${Number(book.bids[0]!.price).toLocaleString('en-IN')} / ${Number(book.asks[0]!.price).toLocaleString('en-IN')}`, basis: 'live', note: `Gap ${(spread * 100).toFixed(2)}%` })

  let want: { qty?: bigint; amount?: bigint }
  let params: OrderParams
  if (side === 'buy') {
    if (isPaise(raw.amount)) {
      if (BigInt(raw.amount) < rules.minNotional) throw bad(`The venue's minimum is ₹${inst.meta.minNotional ?? '100'}.`, { amount: `The venue's minimum is ₹${inst.meta.minNotional ?? '100'}.` })
      const budget = mulDiv(BigInt(raw.amount), pow10(12), pow10(12) + parseDec(rules.feeRate, 12), 'down')
      want = { amount: budget }
      params = { instrumentId: inst.id, side, type, amount: String(raw.amount), maxSlippageBps: slip, purpose: 'manual', ...(limitPrice ? { limitPrice } : {}), ...(validity ? { validity } : {}) }
    } else throw bad('Enter the amount in rupees.', { amount: 'Enter the amount in rupees.' })
  } else {
    const sellAll = raw.sellAll === true
    let qty = sellAll ? free : typeof raw.qty === 'string' && /^\d+(\.\d+)?$/.test(raw.qty) ? parseDec(raw.qty, inst.baseScale, 'down') : 0n
    qty = floorToStep(qty, rules.step)
    if (qty <= 0n) throw bad('Enter how much to sell.', { qty: `Enter how much to sell, in steps of ${inst.meta.qtyStep ?? '0.00001'}.` })
    if (qty > free) throw refused('insufficient_holding', `You have ${Number(free) / 10 ** inst.baseScale} ${inst.base_asset} free to sell.`)
    want = { qty }
    params = { instrumentId: inst.id, side, type, qty: qty.toString(), maxSlippageBps: slip, purpose: 'manual', ...(limitPrice ? { limitPrice } : {}), ...(stopPrice ? { stopPrice } : {}), ...(validity ? { validity } : {}) }
  }
  const m = matchBook(side, levels, want, type === 'stop' ? null : bound, inst.baseScale, inst.quoteScale, rules.step)
  // A purchase the venue would reject for being under its minimum is refused here, before the owner is asked to approve it.
  if (side === 'buy' && type === 'market' && m.filledAmount < rules.minNotional) {
    const least = Math.ceil(Number(smallestMarketBuy(rules, inst, levels[0]!.price)) / 100) * 100
    const msg = `At the current price ${amountText(Number(raw.amount))} buys less than the venue's smallest order of ₹${inst.meta.minNotional ?? '100'}, because it fills in steps of ${inst.meta.qtyStep ?? '0.00001'} ${inst.base_asset}. Enter at least ${amountText(least)}.`
    throw bad(msg, { amount: msg })
  }
  const fee = Number(fraction(m.filledAmount, rules.feeRate, 'up'))
  const tds = side === 'sell' ? Number(fraction(m.filledAmount, rules.tdsRate, 'up')) : 0
  const avg = m.filledQty > 0n ? Number(m.filledAmount) / 100 / (Number(m.filledQty) / 10 ** inst.baseScale) : 0
  const slipPct = avg && Number(levels[0]!.price) ? Math.abs(avg - Number(levels[0]!.price)) / Number(levels[0]!.price) : 0
  if (type === 'market') {
    lines.push({ label: side === 'buy' ? 'You would get' : 'You would sell', value: `${Number(m.filledQty) / 10 ** inst.baseScale} ${inst.base_asset}`, basis: 'estimate', note: `Across ${m.pieces.length} price level${m.pieces.length === 1 ? '' : 's'} of the current book; average ${avg.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` })
    lines.push({ label: side === 'buy' ? 'Paid for it' : 'Received for it', value: amountText(Number(m.filledAmount), 2), basis: 'estimate' })
    lines.push({ label: 'Venue fee', value: amountText(fee, 2), basis: 'estimate', note: `${(Number(rules.feeRate) * 100).toFixed(2)}% of the trade, GST included (${term(db, 'fee.paper-crypto.taker')?.status ?? 'modelled'})` })
    if (side === 'sell') lines.push({ label: 'Tax deducted at source', value: amountText(tds, 2), basis: 'estimate', note: '1% of the sale, credited against your income tax' })
    lines.push({ label: side === 'buy' ? 'Leaves your bank' : 'Reaches your bank', value: amountText(side === 'buy' ? Number(m.filledAmount) + fee : Number(m.filledAmount) - fee - tds, 2), basis: 'estimate' })
    lines.push({ label: 'Worse than the best price by', value: `${(slipPct * 100).toFixed(3)}%`, basis: 'estimate', note: `It will not go beyond ${(slip / 100).toFixed(2)}%; what cannot fill inside that is cancelled` })
    const cost = midCost(side, Number(book.bids[0]!.price), Number(book.asks[0]!.price), Number(m.filledQty) / 10 ** inst.baseScale, Number(m.filledAmount), fee)
    if (cost) lines.push({ label: 'Cost against the mid price', value: amountText(cost.total, 2), basis: 'estimate', note: `Half the gap between buyers and sellers ${amountText(cost.halfSpread, 2)} + walking the book ${amountText(cost.impact, 2)} + venue fee ${amountText(fee, 2)}; the mid price is ${cost.mid.toLocaleString('en-IN')}` })
    if (!m.complete) warnings.push(m.stoppedBy === 'price_limit' ? `Only part of this would fill inside your ${(slip / 100).toFixed(2)}% price tolerance right now.` : 'The book does not show enough size for all of this right now; it would fill in part.')
  } else if (type === 'limit') {
    lines.push({ label: 'Limit price', value: Number(limitPrice).toLocaleString('en-IN'), basis: 'exact', note: m.filledQty > 0n ? 'Part or all of it would fill immediately at current prices' : 'It rests until the market reaches it, or you cancel' })
    lines.push({ label: 'Stands until', value: standsUntilText(validity), basis: 'exact', note: validity && validity.kind !== 'gtc' ? 'When that time comes, what has not filled is cancelled and the money or holding set aside for it is free again. What filled stays.' : 'It stays on the book until it fills or you cancel it.' })
  } else {
    lines.push({ label: 'Sells when buyers offer', value: `${Number(stopPrice).toLocaleString('en-IN')} or less`, basis: 'exact', note: 'Then it sells at what buyers offer, which can be lower. It is not evaluated while price data is stale.' })
  }
  if (inst.base_asset !== 'USDT') warnings.push('Gains on digital assets are taxed at 30% in India; losses cannot be set off.')
  const size = side === 'buy' ? Number(BigInt((params as OrderParams).amount ?? '0')) : Number(m.filledAmount)
  const summary = side === 'buy' ? `Buy ${amountText(size)} of ${inst.name}` : `Sell ${Number(BigInt(params.qty!)) / 10 ** inst.baseScale} ${inst.base_asset}`
  return framed(inst, side, type, { kind: 'order', venue: inst.venue, params, summary, lines, warnings, basis, sizePaise: size, worstDelta: side === 'buy' ? -Math.round(size * lim.fall) : 0, quote: { source: book.provider, best: String(levels[0]?.price ?? '') } }, book.provider === 'synthetic')
}


/**
 * An ETF, a share, a Treasury bill or a bond: one displayed price a side, whole lots, costs from the terms, settlement later.
 * Everything the sheet says is what the paper desk will do; the prices are synthetic and the sheet says so.
 */
function securityOrder(ctx: Ctx, inst: Instrument, side: Side, raw: Raw, now: number, free: bigint, lim: { fall: number }): Built {
  const { db } = ctx
  const debt = inst.venue === 'paper-gsec'
  const desk = debt ? 'a paper government-securities desk' : 'a paper exchange'
  const ask = ctx.market.get(inst.id, 'ask'), bid = ctx.market.get(inst.id, 'bid')
  if (!ask || !bid) throw refused('no_price', `No price has been received for ${inst.name} yet.`)
  const step = BigInt(inst.meta.qtyStep ?? '1')
  const session = sessionOf(inst, now)
  const days = inst.meta.settlementDays ?? 1
  const unit = inst.kind === 'equity' ? 'shares' : debt ? 'units of ₹100 face value' : 'units'
  const lines: Built['lines'] = [], warnings: string[] = [], basis: string[] = []
  basis.push(`${DATA_LABEL}. ${inst.name}: sellers ask ${ask.price}, buyers offer ${bid.price}, from ${ask.provider}, received ${new Date(ask.recvTs).toISOString()}. ${inst.meta.anchor ? `Where the series started: ${inst.meta.anchor.source}${inst.meta.anchor.date ? ` (${inst.meta.anchor.date})` : ''}.` : ''}`)
  if (!session.open) warnings.push(`${closedText(inst, now)} An order placed now is refused; nothing is held until it opens.`)
  lines.push({ label: 'Placed with', value: `${desk}, on paper`, basis: 'rule', note: `Practice money: no exchange, broker or bank is contacted. ${DATA_LABEL}.` })
  lines.push({ label: 'Asset', value: `${unit.replace(/^units/, 'Units')} of ${inst.name}`, basis: 'exact' })
  lines.push({ label: 'Trading hours', value: `${session.opens} to ${session.closes} India time, Monday to Friday`, basis: 'rule', note: `${session.open ? 'Open now.' : 'Closed now.'} Market holidays are not modelled (${term(db, debt ? 'rule.gsec.hours' : 'rule.exchange.hours')?.status ?? 'unverified'}).` })
  lines.push({ label: 'Buyers offer / sellers ask', value: `${ask.price === bid.price ? ask.price : `${bid.price} / ${ask.price}`}`, basis: 'estimate', note: debt ? 'A price for ₹100 of face value, interest accrued so far included' : 'A price for one unit' })
  let params: OrderParams, size: number, summary: string
  if (side === 'buy') {
    if (!isPaise(raw.amount)) throw bad('Enter the amount in rupees.', { amount: 'Enter the amount in rupees.' })
    const amt = BigInt(raw.amount)
    const price = parsePrice(ask.price)
    let qty = floorToStep(quantityFor(amt, 2, price, 0, 'down'), step), gross = notional(qty, 0, price, 2, 'up')
    while (qty > 0n) { const c = securityCosts(db, inst, 'buy', gross); if (gross + c.fee + c.tax <= amt) break; qty -= step; gross = notional(qty, 0, price, 2, 'up') }
    if (qty <= 0n) {
      const lot = inst.meta.debt ? ` The smallest lot is ${step} units (${amountText(inst.meta.debt.faceLot * 100)} of face value).` : ''
      const msg = `At the current price ${amountText(Number(raw.amount))} buys less than one lot once its costs are taken from it.${lot}`
      throw bad(msg, { amount: msg })
    }
    const c = securityCosts(db, inst, 'buy', gross)
    lines.push({ label: 'You would get', value: `${qty.toLocaleString('en-IN')} ${unit}`, basis: 'estimate', note: `Whole lots of ${step}; what is left of the amount stays in your bank` })
    lines.push({ label: 'Paid for it', value: amountText(Number(gross), 2), basis: 'estimate' })
    for (const p of c.parts) lines.push({ label: p.label, value: amountText(Number(p.amount), 2), basis: 'estimate', note: p.kind === 'tax' ? `Applied at execution (${term(db, 'tax.stamp.exchange')?.status ?? 'unverified'})` : undefined })
    if (!debt) lines.push({ label: 'Costs in all', value: amountText(Number(c.fee + c.tax), 2), basis: 'estimate', note: `Rates are ${exchangeCostsStatus(db)} (the weakest of brokerage, charges, GST, tax, depository and stamp): see the terms` })
    else lines.push({ label: 'Costs', value: 'No brokerage or tax; the gap between the two prices', basis: 'rule', note: `The gap here is ${(((Number(ask.price) - Number(bid.price)) / Number(ask.price)) * 100).toFixed(3)}%` })
    lines.push({ label: 'Leaves your bank now', value: amountText(Number(gross + c.fee + c.tax), 2), basis: 'estimate' })
    lines.push({ label: 'The units are', value: 'Yours at once on paper', basis: 'rule', note: `Settlement is T+${days}: a sale later pays out ${days} business day${days === 1 ? '' : 's'} after it, at 10:00` })
    if (inst.kind === 'tbill') warnings.push('A bill pays no interest. It is bought below ₹100 and pays ₹100 at maturity (19 Feb 2027). Selling earlier gets the price then. Redeeming at maturity is a sale at face value on paper.')
    if (inst.kind === 'gsec') warnings.push('A bond\'s price moves opposite to yields. Its coupon is paid twice a year, on 15 May and 15 Nov, to whoever held it at the start of that day.')
    params = { instrumentId: inst.id, side, type: 'market', amount: String(raw.amount), purpose: 'manual' }
    size = raw.amount
    summary = `Buy ${amountText(raw.amount)} of ${inst.name}`
  } else {
    const sellAll = raw.sellAll === true
    let qty = sellAll ? free : typeof raw.qty === 'string' && /^\d+$/.test(raw.qty) ? BigInt(raw.qty) : 0n
    qty = floorToStep(qty, step)
    if (qty <= 0n) throw bad('Enter how many to sell, in whole lots.', { qty: `Enter a whole number, in multiples of ${step}.` })
    if (qty > free) throw refused('insufficient_holding', `You have ${free.toLocaleString('en-IN')} ${unit} free to sell.`)
    const gross = notional(qty, 0, parsePrice(bid.price), 2, 'down')
    const c = securityCosts(db, inst, 'sell', gross)
    lines.push({ label: 'You would sell', value: `${qty.toLocaleString('en-IN')} ${unit}`, basis: 'exact' })
    lines.push({ label: 'Received for it', value: amountText(Number(gross), 2), basis: 'estimate' })
    for (const p of c.parts) lines.push({ label: p.label, value: amountText(Number(p.amount), 2), basis: 'estimate' })
    lines.push({ label: 'Reaches your bank', value: `about ${amountText(Number(gross - c.fee), 2)}, ${days} business day${days === 1 ? '' : 's'} after the sale`, basis: 'estimate', note: 'Settlement is T+1, at 10:00 India time. Tax on the gain is not deducted here' })
    params = { instrumentId: inst.id, side, type: 'market', qty: qty.toString(), purpose: 'manual' }
    size = Number(gross)
    summary = `Sell ${qty.toLocaleString('en-IN')} ${unit} of ${inst.name}`
  }
  lines.push({ label: 'Once you approve', value: session.open ? 'It fills at once at the price shown, or is refused' : 'It is refused: the market is closed', basis: 'rule', note: 'A fill cannot be undone. A price older than 15 seconds is never used.' })
  return { kind: 'order', venue: inst.venue, params, summary, lines, warnings, basis, sizePaise: size, worstDelta: side === 'buy' ? -Math.round(size * lim.fall) : 0, quote: { source: ask.provider, best: ask.price } }
}

/**
 * A payment for this bill that is under way or made, by hand or by an instruction: the bill is not offered for payment
 * again (R12 task comparison: while a payment was pending the bill still said "Pay it now" and a second one was accepted).
 */
export function billPaymentUnderWay(db: Db, userId: string, billId: string): { id: string; state: string } | undefined {
  return db.get<{ id: string; state: string }>(`SELECT id, state FROM actions WHERE user_id = ? AND kind = 'payment' AND json_extract(params_json, '$.billId') = ? AND state NOT IN ('rejected', 'failed', 'cancelled', 'expired', 'blocked') ORDER BY created_at DESC LIMIT 1`, userId, billId)
}
const UNDER_WAY = 'A payment for this bill is already on its way or made, so a second one was not prepared. Follow it in Activity; if it fails, the bill is offered again.'

function buildPayment(ctx: Ctx, userId: string, raw: Raw, now: number): Built {
  const { db } = ctx
  if (!isPaise(raw.amount)) throw bad('Enter an amount.', { amount: 'Enter an amount in rupees.' })
  const amount: number = raw.amount
  const purpose = (['spend', 'card', 'loan:personal', 'loan:home', 'fd', 'goal'] as const).find((p) => p === raw.purpose) ?? 'spend'
  const lines: Built['lines'] = [], warnings: string[] = [], basis: string[] = []
  let handle: string, name: string, charge = 0, billId: string | undefined, look: string | null = null, goalId: string | undefined
  let billSeen: { memo: string | null; dueAt: number } | null = null
  let checked: { value: string; note: string } | null = null
  if (purpose === 'spend') {
    if (typeof raw.billId === 'string') {
      const b = db.get<{ id: string; amount: number; state: string; payee_id: string; memo: string | null; due_at: number }>('SELECT id, amount, state, payee_id, memo, due_at FROM bills WHERE id = ? AND user_id = ?', raw.billId, userId)
      if (!b || (b.state !== 'due' && b.state !== 'failed')) throw refused('bill_not_due', 'That bill is not waiting to be paid.')
      if (b.amount !== amount) throw bad('The amount must equal the bill.', { amount: `The bill is for ${amountText(b.amount, 2)}.` })
      if (billPaymentUnderWay(db, userId, b.id)) throw refused('bill_payment_under_way', UNDER_WAY)
      billId = b.id
      billSeen = { memo: b.memo, dueAt: b.due_at }
      raw = { ...raw, payeeId: b.payee_id }
    }
    const payee = db.get<{ name: string; handle: string; name_check: string | null; registered_name: string | null }>('SELECT name, handle, name_check, registered_name FROM payees WHERE id = ? AND user_id = ?', String(raw.payeeId ?? ''), userId)
    if (!payee) throw bad('Choose one of your payees.', { payeeId: 'Choose one of your payees, or add a new one first.' })
    handle = payee.handle; name = payee.name
    look = payeeWarning(db, userId, payee)
    if (look) warnings.push(look)
    // what the paper bank's name check answered when the payee was added, and the first-payment caution, both signed
    // (R12 task comparison, gap 4: they were shown under the payee only, or not at all)
    checked = nameCheckWords(isNameOutcome(payee.name_check) ? payee.name_check : null, payee.registered_name, payee.name)
    const caution = firstPaymentCaution(db, userId, payee.handle, now)
    if (caution) warnings.push(caution)
    // A hand payment does not settle a bill of the same payee (walkthrough F20): the bill stays due, and an instruction
    // that pays bills would pay it again. Say so, and how to settle the bill instead.
    if (!billId) {
      const open = db.all<{ amount: number; due_at: number }>(`SELECT b.amount, b.due_at FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND y.handle = ? AND b.state IN ('due', 'scheduled', 'failed') ORDER BY b.due_at`, userId, payee.handle)
      if (open.length) {
        const first = open[0]!, cover = billCover(db, userId, payee.handle, first.amount)
        warnings.unshift(`${payee.name} has ${open.length === 1 ? `a ${amountText(first.amount)} bill` : `${open.length} bills`} on record, due ${whenIst(first.due_at)}${open.length > 1 ? ' first' : ''}. Paying by hand does not settle it: it stays due${'id' in cover ? `, and "${cover.title}" will ${cover.runMode === 'approve' ? 'ask you to approve paying it' : 'pay it'} when it falls due` : ''}. To settle it, pay it as "A bill on record".`)
      }
    }
  } else if (purpose === 'goal') {
    // money set aside by hand for one of the owner's signed goals (the "sum now" that brings a goal back on track)
    const g = typeof raw.goalId === 'string' ? signedGoal(db, userId, raw.goalId) : null
    if (!g) throw bad('Choose one of your goals.', { goalId: 'Choose one of your goals, signed with your passkey.' })
    handle = SETASIDE_HANDLE; name = g.name; goalId = g.id
    const have = setAside(db, userId, g.id)
    if (have + amount > g.target) warnings.push(`This takes the set-aside for ${g.name} past its target of ${amountText(g.target)}: ${amountText(have)} is set aside already.`)
  } else {
    const owed = purpose === 'fd' ? null : balance(db, userId, purpose === 'card' ? 'card' : purpose)
    if (owed !== null && BigInt(amount) > owed) throw bad('That is more than you owe.', { amount: `You owe ${amountText(owed, 2)}.` })
    handle = { card: 'card@paperbank', 'loan:personal': 'loan-personal@paperbank', 'loan:home': 'loan-home@paperbank', fd: 'fd@paperbank' }[purpose]
    name = { card: 'your credit card', 'loan:personal': 'your personal loan', 'loan:home': 'your home loan', fd: 'a fixed deposit' }[purpose]
    if (purpose === 'loan:personal') { charge = Number(fraction(BigInt(amount), String(term(db, 'rate.loan.personal')?.value.prepayCharge ?? '0.03'), 'half')); lines.push({ label: 'Prepayment charge', value: amountText(charge, 2), basis: 'modelled', note: `${(Number(term(db, 'rate.loan.personal')?.value.prepayCharge ?? 0.03) * 100).toFixed(0)}% of the amount prepaid` }) }
    if (purpose === 'fd') warnings.push('If you break the deposit early, the broken amount earns the savings rate less one point, not the deposit rate. This is a modelling rule, not a bank\'s published term.')
  }
  const choice = ctx.venues.rail.chooseRail(BigInt(amount + charge), handle, typeof raw.rail === 'string' ? (raw.rail as RailName) : undefined)
  if (choice.error) throw bad(choice.error, { rail: choice.error })
  const timing = choice.rail === 'neft' ? 'In the next half-hourly batch' : choice.rail === 'internal' ? 'At once, inside your bank' : 'Within seconds'
  // A payment to a payee in its first 24 hours waits, once what goes to it comes to more than the household's amount
  // (new-payee.ts): when it is sent and why are terms the passkey signs, and the action is built from them.
  const profile = getProfile(db, userId)
  const hold = purpose === 'spend' ? holdFor(db, userId, profile, handle, BigInt(amount + charge), now) : null
  if (hold) warnings.push(holdWarning(hold))
  lines.unshift({ label: 'Leaves your bank', value: amountText(amount + charge, 2), basis: 'exact' })
  // who is paid, at which address, always on the sheet: it is in what the passkey signs (R12 task comparison, gap 3)
  lines.unshift({ label: 'To', value: goalId ? `The set-aside for ${name}, inside your own bank` : `${name}, ${handle}`, basis: 'exact', ...(goalId ? { note: `${handle}: it moves between your own accounts and leaves the bank for no one` } : {}) })
  if (checked) lines.splice(1, 0, { label: 'Name check', value: checked.value, basis: 'recorded', note: checked.note })
  if (hold) lines.splice(checked ? 3 : 2, 0, { label: 'Sent', value: `Not before ${whenIst(hold.until)}`, basis: 'exact', note: 'The money is set aside from when you approve until then, and you can cancel it on its record. It goes only to this payee as it is now: if they are removed or changed meanwhile, it is not sent. If QED is paused when the wait ends, it waits until you resume. If QED is not running when the wait ends, it is sent when QED next runs.' })
  // a payment that repeats an earlier one is held for the person's confirmation (duplicates.ts); the sheet says so, and why
  const repeat = purpose === 'spend' ? repeatOf(db, userId, { payeeHandle: handle, amount: String(amount), purpose: billId ? 'bill' : 'spend', ...(billId ? { billId } : {}) }, { id: '', createdAt: now }) : null
  if (repeat) {
    const words = repeatWords(repeat, name, whenIst(repeat.askedAt))
    warnings.push(words)
    lines.push({ label: 'Repeat of an earlier payment', value: 'Held for your confirmation before it is sent', basis: 'rule', note: DUPLICATE_RULE })
  }
  if (billSeen) lines.push({ label: 'The bill', value: `${billSeen.memo || 'No reference given'}, due ${whenIst(billSeen.dueAt)}`, basis: 'exact', note: 'As you recorded it: no biller is asked on paper' })
  lines.push({ label: 'Sent by', value: choice.rail === 'internal' ? 'Your bank (internal)' : choice.rail.toUpperCase(), basis: 'rule', note: `${timing}${hold ? ' once its wait is over' : ''}. Paper rail: no real payment is made.` })
  if (!charge) lines.push({ label: 'Fee', value: 'None', basis: 'rule', note: 'The paper rail charges no fee for this payment' })
  const settles = billId ? ', and the bill is marked paid when the payment settles' : ''
  lines.push(goalId
    ? { label: 'Once you approve', value: 'It is set aside at once, on paper', basis: 'rule', note: 'No instruction can spend money set aside. Only you can release it, with your passkey.' }
    : { label: 'Once you approve', value: hold ? `It waits until ${whenIst(hold.until)}, then leaves your bank on paper${settles}` : `It leaves your bank on paper${settles}`, basis: 'rule', note: 'A payment that has gone is not recalled; if it goes wrong, it can be disputed from its record.' })
  if (handle.endsWith('@paper')) warnings.push(`"${handle}" is a test payee that exercises a failure path.`)
  basis.push('Rail limits and timings are the paper rail\'s modelled rules; see the terms register for their sources.')
  const memo = clean(raw.memo, 80)
  const params: PaymentParams = { payeeHandle: handle, payeeName: name, amount: String(amount), purpose: billId ? 'bill' : purpose, ...(charge ? { charge: String(charge) } : {}), ...(billId ? { billId } : {}), ...(goalId ? { goalId } : {}), ...(memo && !goalId ? { memo } : {}), ...(typeof raw.rail === 'string' ? { rail: choice.rail } : {}), ...(hold ? { hold: { until: hold.until, why: hold.why, ...(hold.payee.id ? { payeeId: hold.payee.id } : {}) } } : {}) }
  // a set-aside is counted in the worst case like a deposit, so moving money into it leaves the worst case as it was
  const delta = purpose === 'card' || purpose === 'fd' || purpose === 'goal' || billId ? -charge : -(amount + charge)
  return { kind: 'payment', venue: 'paper-rail', params, summary: goalId ? `Set aside ${amountText(amount)} for ${name}` : `Pay ${amountText(amount)} to ${name}${look ? ` (${handle})` : ''}`, lines, warnings, basis, sizePaise: amount + charge, worstDelta: delta }
}

/** Build the preview document for a manual order or payment and open an approval request for it. */
export async function previewAction(ctx: Ctx, userId: string, raw: unknown): Promise<ActionPreview> {
  if (typeof raw !== 'object' || raw === null) throw bad('Nothing to preview.')
  const r = raw as Raw
  const now = ctx.clock.now()
  const built = r.kind === 'payment' ? buildPayment(ctx, userId, r, now) : await buildOrder(ctx, userId, r, now)
  const w = worstCase(ctx.db, ctx.market, userId, now)
  const after = w.gHat + built.worstDelta
  const warnings = [...built.warnings]
  const basis: string[] = []
  if (built.worstDelta < 0 && after < w.line) warnings.unshift(`This takes your worst case to ${amountText(after)}, below your floor of ${amountText(w.line)}. You may do it yourself; QED's instructions may not.`)
  let dipsIntoReserve = false
  if (built.kind === 'payment' || (built.params as OrderParams).side === 'buy') {
    const free = available(ctx.db, userId, 'bank')
    if (BigInt(built.sizePaise) > free) throw refused('insufficient_funds', `You have ${amountText(free, 2)} available in your bank account; this needs ${amountText(built.sizePaise, 2)}.`)
    // Money that something already due will need. The owner may use it; an instruction may not. Say so before they approve.
    const pay = built.kind === 'payment' ? (built.params as PaymentParams) : null
    const prepays = pay && (pay.purpose === 'loan:personal' || pay.purpose === 'loan:home') ? { code: pay.purpose, amount: Number(pay.amount) } : undefined
    const l = staysLiquid(ctx.db, userId, now, built.sizePaise, { ...(pay?.billId ? { paysBillId: pay.billId } : {}), ...(prepays ? { prepays } : {}) })
    if (!l.ok) {
      dipsIntoReserve = true
      const b = l.before.binding
      warnings.unshift(`This leaves ${amountText(l.leftAfter)} in your bank account, and ${amountText(l.needAfter)} is needed for what is due${b ? ` by ${dateText(b.date)}` : ''}${l.before.assumptions.lateDays > 0 || l.before.assumptions.lostSalaries > 0 ? `, allowing for ${hardshipText(l.before.assumptions)}` : ''}. You may do it yourself; QED's instructions may not.`)
    }
    basis.push(`Bank reserve: ${l.detail}`)
  }
  const economicId = newId('man', now)
  const belowFloor = built.worstDelta < 0 && after < w.line
  // An estimate priced on a live order book holds for a minute (R7-094): the approval lapses with it, so nobody signs
  // against prices that have moved on. A request that needs several members' signatures cannot gather them in a minute:
  // its estimate is marked indicative, and the order's price bound, set from these prices, is what protects it.
  const required = requiredSigners(ctx.db, userId, built.sizePaise)
  const quote: Quote | null = built.quote ? { at: now, validUntil: required === 1 ? now + QUOTE_TTL_MS : null, source: built.quote.source, best: built.quote.best, indicative: required > 1 } : null
  // What a password session prepared, in the document the passkey signs: this request, the payee and the bill (RISK-076).
  const pays = built.kind === 'payment' ? (built.params as PaymentParams) : null
  const prepared = passwordWork(ctx.db, userId, { request: true, payeeHandles: pays ? [pays.payeeHandle] : [], billIds: pays?.billId ? [pays.billId] : [] }, now)
  // Format 2 (stage S4): the document states the currency its figures are in, the household's zone and the zone rules' version, and
  // the D-064 thresholds in force when it was signed in that currency. A document without them (format 1, signed before) is read
  // as rupees in India's zone, which is what it always meant (submitApprovedAction).
  const home = householdHome(ctx.db, userId)
  const stepUpAt = thresholdIn(home, STEP_UP_PAISE), passwordFreeAt = thresholdIn(home, PASSWORD_FREE_PAISE_PER_DAY)
  const doc = canonical({
    v: 2, kind: 'action', currency: home, instrumentId: `iso4217:${home}`, timeZone: zoneOf(getProfile(ctx.db, userId)), tzVersion: TZ_VERSION,
    thresholds: { currency: home, stepUp: stepUpAt, passwordFreeDaily: passwordFreeAt }, economicId, action: { kind: built.kind, venue: built.venue, params: built.params }, what: built.summary,
    // What the engine may assume the owner accepted. It refuses an action that would go below the floor or take what
    // must stay in the bank unless the document that was approved says so here.
    sizePaise: built.sizePaise, acknowledged: { belowFloor, intoReserve: dipsIntoReserve },
    estimate: built.lines, ...(quote ? { quote } : {}), warnings, basis: [...built.basis, ...basis, `Worst case now ${amountText(w.gHat)}; after this ${amountText(after)}; your floor ${amountText(w.line)}.${w.illustrative ? ' Limits are illustrative.' : ''}`],
    note: 'Approving lets QED carry out exactly this, once. It is checked again against prices and balances at the moment it is sent. Execution is on paper: no real money moves.',
    ...(prepared.length ? { prepared } : {}),
  })
  // The password is asked for an action of ₹10,000 or more, for one that brings the day's password-free total to
  // ₹10,000, and for one that goes below the floor or takes what must stay.
  const requiresStepUp = built.sizePaise >= stepUpAt || passwordFreeApproved(ctx.db, userId, now) + built.sizePaise >= passwordFreeAt || belowFloor || dipsIntoReserve
  const a = createApproval(ctx.db, userId, { purpose: 'action', subject: `action:${economicId}`, document: doc, requiresStepUp, ...(quote?.validUntil ? { ttlMs: QUOTE_TTL_MS } : {}) }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, requiresStepUp, summary: built.summary, lines: built.lines, warnings, worst: { before: w.gHat, after, line: w.line }, quote }
}

/** Create the action from a confirmed approval. The parameters come from the approved document, not from the request. */
export function submitApprovedAction(ctx: Ctx, userId: string, approvalId: string): ActionRow {
  const a = getApproval(ctx.db, userId, approvalId)
  if (!a || a.purpose !== 'action') throw notFound('That approval')
  if (!a.confirmed_at) throw refused('approval_missing', 'Confirm the approval first.')
  if (a.consumed_at) throw refused('approval_used', 'That approval has already been used.')
  if (approvalLapsed(a, ctx.clock.now())) throw refused('approval_expired', LAPSED_TEXT)
  if (sha256hex(a.document) !== a.doc_hash) throw new AppError(500, 'approval_corrupt', 'The stored document does not match its hash. Nothing was done.')
  const doc = JSON.parse(a.document) as { v?: number; currency?: string; economicId: string; action: { kind: 'order' | 'payment'; venue: string; params: OrderParams | PaymentParams } }
  // A format 1 document states no currency and means rupees; a format 2 one states it. Either must be in the household's own, or the
  // figures in it would be read in a currency they were not written in.
  const stated = doc.v === 2 ? doc.currency : 'INR'
  if (stated !== householdHome(ctx.db, userId)) throw refused('approval_mismatch', 'That approval states figures in a currency other than your home currency. Nothing was done.')
  if (a.subject !== `action:${doc.economicId}`) throw refused('approval_mismatch', 'That approval was given for something else.')
  // checked again here, in the same transaction as the action is made: two sheets for one bill, each approved, pay it once
  const billId = doc.action.kind === 'payment' ? (doc.action.params as PaymentParams).billId : undefined
  const act = ctx.db.tx(() => {
    if (billId && billPaymentUnderWay(ctx.db, userId, billId)) throw refused('bill_payment_under_way', UNDER_WAY)
    return createAction(ctx, { userId, origin: 'owner', kind: doc.action.kind, venue: doc.action.venue, economicId: doc.economicId, params: doc.action.params, approvalId })
  })
  audit(ctx.db, ctx.clock.now(), userId, 'owner', 'action.create', act.id, { approvalId, docHash: a.doc_hash })
  return act
}

// ------------------------------------------------------------------------------------------------ payees and bills

/** The most payees one workspace keeps (R13 review, R10). */
export const MAX_PAYEES = 500

/** A payee as offered: its fields checked, and refused if the address is already one of the household's payees. */
function offeredPayee(db: Db, userId: string, raw: Raw): { name: string; handle: string; category: string } {
  const name = clean(raw.name, 60), handle = clean(raw.handle, 80).toLowerCase(), category = clean(raw.category, 30) || 'other'
  const fields: Record<string, string> = {}
  if (name.length < 2) fields.name = 'Enter the payee\'s name.'
  if (!/^[a-z0-9][a-z0-9._-]{1,48}@[a-z0-9][a-z0-9.-]{1,28}$/.test(handle)) fields.handle = 'Enter a payment address such as name@bank.'
  if (handle.endsWith('@paperbank')) fields.handle = 'That address is reserved for your own bank.'
  if (Object.keys(fields).length) throw bad('Check the highlighted fields.', fields)
  if (db.get('SELECT 1 FROM payees WHERE user_id = ? AND handle = ?', userId, handle)) throw new AppError(409, 'exists', 'You already have a payee with that address.', { handle: 'You already have a payee with that address.' })
  return { name, handle, category }
}

/**
 * What the owner must see before a payee is saved: a payee that imitates one the owner already pays is how an induced
 * transfer starts (X01, lookalike.ts), and the paper bank's name check (name-check.ts; R12 task comparison, gap 4) answers
 * match, close match, no match or could not check. Anything but a match, and any look-alike, needs the owner's confirmation.
 */
function payeeAnswer(db: Db, userId: string, p: { name: string; handle: string }) {
  const look = addWarning(p, db.all<{ name: string; handle: string }>('SELECT name, handle FROM payees WHERE user_id = ?', userId))
  const check = checkPayeeName(p.name, p.handle)
  return { look, check, said: nameCheckAddMessage(check, p.name, p.handle) }
}

/**
 * Ask before adding (POST /api/payees/check): the answers adding would need confirmed, in the server's words, with nothing
 * saved. The form asks this first, so that a payee that needs confirming is shown without a refused request; adding still
 * refuses one that was not confirmed (addPayee).
 */
export function checkNewPayee(db: Db, userId: string, raw: Raw): { nameCheck: { outcome: NameOutcome; registeredName: string | null; message: string | null }; lookalike: string | null; needsConfirmation: boolean } {
  const p = offeredPayee(db, userId, raw)
  const { look, check, said } = payeeAnswer(db, userId, p)
  return { nameCheck: { outcome: check.outcome, registeredName: check.registeredName, message: said }, lookalike: look?.message ?? null, needsConfirmation: !!look || !!said }
}

export function addPayee(db: Db, userId: string, raw: Raw, now: number): { id: string; name: string; handle: string; category: string } {
  const { name, handle, category } = offeredPayee(db, userId, raw)
  // Each payee is compared with every other for look-alikes, here and in every payment and instruction that pays one; a
  // workspace is held to MAX_PAYEES so that one person cannot make those checks hold the API's thread (R13 review, R10).
  if ((db.get<{ n: number }>('SELECT COUNT(*) n FROM payees WHERE user_id = ?', userId)?.n ?? 0) >= MAX_PAYEES) throw new AppError(409, 'too_many_payees', `This workspace has ${MAX_PAYEES} payees, the most it can have. Remove one you no longer pay first.`)
  // A look-alike needs the owner to confirm they checked it, and every payment or instruction to it says what it looks
  // like. Anything but a match from the paper bank's name check needs the same confirmation, given for exactly the answer
  // shown: `nameCheckAccepted` must name it, so a confirmation never covers an answer the owner did not see. Neither kind
  // of answer is refused outright: as with the UK's Confirmation of Payee and the EU's Verification of Payee, the payer may
  // go on once warned, and most addresses are ones the paper bank does not know. What protects instead: the warning, the
  // owner's own confirmation, the answer kept with the payee and written into every payment's signed terms, and the wait
  // on a large first-day payment (new-payee.ts).
  const { look, check, said } = payeeAnswer(db, userId, { name, handle })
  const lookOpen = !!look && raw.lookalikeChecked !== true
  const nameOpen = !!said && raw.nameCheckAccepted !== check.outcome
  if (lookOpen || nameOpen) {
    const fields: Record<string, string> = { ...(said ? { nameCheck: check.outcome } : {}), ...(said && check.registeredName ? { registeredName: check.registeredName } : {}), ...(look ? { lookalike: look.message } : {}) }
    throw new AppError(409, lookOpen ? 'lookalike' : 'payee_check', lookOpen ? `${look!.message}${said ? ` ${said}` : ''}` : said!, fields)
  }
  const id = newId('pye', now)
  // How the session that added it was opened is recorded with it, and a password session's payee is told to the passkey
  // holders (RISK-076).
  db.tx(() => {
    db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at, name_check, registered_name) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)', id, userId, name, handle, category, now, check.outcome, check.registeredName)
    recordPrepared(db, 'payee', id, userId, now)
    tellPayeeAdded(db, userId, { name, handle }, now)
    audit(db, now, userId, 'owner', 'payee.add', id, { handle, nameCheck: check.outcome, ...(check.registeredName ? { registeredName: check.registeredName } : {}), ...(said ? { nameCheckConfirmed: true } : {}), ...(look ? { lookalikeOf: look.similar, confirmed: look.message } : {}) })
  })
  return { id, name, handle, category }
}

export function addBill(db: Db, userId: string, raw: Raw, now: number): { id: string } {
  const payee = db.get<{ id: string }>('SELECT id FROM payees WHERE id = ? AND user_id = ?', String(raw.payeeId ?? ''), userId)
  const fields: Record<string, string> = {}
  if (!payee) fields.payeeId = 'Choose one of your payees.'
  if (!isPaise(raw.amount)) fields.amount = 'Enter the bill amount.'
  if (typeof raw.dueAt !== 'number' || raw.dueAt < now - 86_400_000 || raw.dueAt > now + 400 * 86_400_000) fields.dueAt = 'Enter when it is due.'
  if (Object.keys(fields).length) throw bad('Check the highlighted fields.', fields)
  const id = newId('bil', now)
  db.tx(() => {
    db.run(`INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)`, id, userId, payee!.id, raw.amount as number, raw.dueAt as number, clean(raw.memo, 80), now)
    recordPrepared(db, 'bill', id, userId, now)
  })
  emit(db, now, userId, 'bill', { id })
  return { id }
}

export function cancelBill(db: Db, userId: string, id: string, now: number): void {
  const r = db.run(`UPDATE bills SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state = 'due'`, id, userId)
  if (r.changes === 0) throw refused('bill_not_due', 'Only a bill that is still due can be removed.')
  emit(db, now, userId, 'bill', { id })
}

// ------------------------------------------------------------------------------------------------ money in (paper)

/** Add paper money by hand. "topup" is not income; "earned" is, and income-splitting programs act on it. */
export function recordMoneyIn(ctx: Ctx, userId: string, raw: Raw): { entryId: string } {
  if (!isPaise(raw.amount) || (raw.amount as number) > 10_000_000_000) throw bad('Enter an amount up to ₹10 crore.', { amount: 'Enter an amount up to ₹10 crore.' })
  const kind = raw.kind === 'earned' ? 'earned' : 'topup'
  const now = ctx.clock.now()
  const amount = BigInt(raw.amount as number)
  const e = post(ctx.db, { userId, ts: now, kind: kind === 'earned' ? 'income-earn' : 'paper-topup', ref: `in:${newId('x', now)}`, memo: clean(raw.memo, 80) || (kind === 'earned' ? 'Earnings recorded by you (paper)' : 'Paper money added by you'), meta: { paper: true, enteredByOwner: true },
    lines: [{ account: 'bank', amount }, { account: kind === 'earned' ? 'inc:earn' : 'inc:other', amount: -amount }] })
  audit(ctx.db, now, userId, 'owner', `money-in.${kind}`, e.id, { amount: raw.amount })
  return { entryId: e.id }
}

// ------------------------------------------------------------------------------------------------ earning through escrowed work

/**
 * A job on paper, opened on the complete terms it was shown with (server/escrow.ts openJob): termsHash is the fingerprint of
 * those terms and both sides accept them (on paper the household plays the client too; in a business workspace the
 * client's member accepts later). The paper client then puts each milestone's money in escrow.
 */
export function createJob(db: Db, userId: string, raw: Raw, now: number): { id: string; termsHash: string; state: 'funded' | 'proposed' } {
  return openJob(db, userId, raw, now)
}

type MilestoneRow = { id: string; job_id: string; title: string; amount: number; state: string; evidence_hash: string | null }
function milestone(db: Db, userId: string, id: string): MilestoneRow {
  const m = db.get<MilestoneRow>('SELECT id, job_id, title, amount, state, evidence_hash FROM earn_milestones WHERE id = ? AND user_id = ?', id, userId)
  if (!m) throw notFound('That milestone')
  return m
}

/**
 * A milestone paid through the escrow on the chain is handed to server/earn-chain.ts: "submit the work" becomes the
 * delivery of the certified work, signed by the vault's passkeys, and the client's decisions are what a proof escrow
 * allows (nothing to accept, no dispute; a refund is the provider's release before the deadline, anyone's after it).
 * A state that cannot take the step is refused at once. The step itself needs the vault service, so it is returned as
 * a promise for a caller that waits for it; for one that does not (the paper routes answer at once), a failure is kept
 * on the milestone and shown with it on the Earn page, never left unhandled.
 */
function onChain(db: Db, userId: string, id: string, action: 'deliver' | 'release' | 'refund', now: number, step: (cfg: RailCfg, who: Asker) => Promise<unknown>): Promise<unknown> {
  // the person asking, as the request established it: with none, or for another workspace, nothing is prepared (no identity is assumed)
  const a = actor.getStore()
  if (!a || a.workspaceId !== userId) throw new AppError(403, 'not_permitted', 'Only a signed-in member of this workspace can hand its milestones to the chain. Nothing was prepared.')
  const who: Asker = { workspaceId: userId, personId: a.personId, role: a.role, session: {} as Session }
  const p = step({ dbPath: db.path }, who)
  p.catch((e: unknown) => recordChainFailure(db, id, action, e, now))
  return p
}
const chainWords = (state: string): string => state.replace(/^chain-/, '')

/** The owner submits evidence of the work. Only its hash is kept. On the chain, the evidence is the certificate. */
export function submitMilestone(db: Db, userId: string, id: string, evidence: unknown, now: number): void | Promise<unknown> {
  const m = milestone(db, userId, id)
  if (isChainMilestone(db, id)) {
    if (m.state !== 'chain-funded') throw refused('wrong_state', `This milestone is paid through the escrow on the chain and is ${chainWords(m.state)}: only a funded one can be delivered.`)
    return onChain(db, userId, id, 'deliver', now, (cfg, who) => deliverChainMilestone(cfg, db, who, id, {}, now))
  }
  const text = clean(evidence, 4000)
  if (m.state === 'funded' && text.length < 3) throw bad('Describe or paste the evidence of the work.', { evidence: 'Describe or paste the evidence of the work.' })
  // on paper the client's review starts now, with its stated end and default (server/escrow.ts)
  submitPaper(db, userId, id, sha256hex(text), now)
}

/**
 * The paper client's decision. There is no real counterparty, so the owner plays the client; every result is labelled.
 * accept: released to the earner (in the review, or giving way in a dispute). dispute: with a reason, during the review.
 * refund: the client takes the money back before work is submitted, after the delivery date; the earner may answer it.
 * The turns, deadlines and defaults are server/escrow.ts's.
 */
export function clientDecision(ctx: Ctx, userId: string, id: string, decision: unknown, raw: Raw = {}): void | Promise<unknown> {
  const { db } = ctx
  const now = ctx.clock.now()
  const m = milestone(db, userId, id)
  if (isChainMilestone(db, id)) {
    if (decision !== 'refund') throw chainDecisionRefusal(db, id, decision)
    if (m.state !== 'chain-funded') throw refused('wrong_state', `This milestone is paid through the escrow on the chain and is ${chainWords(m.state)}: only a funded one can be refunded.`)
    const due = chainDeadline(db, id)
    if (due !== null && now > due) return onChain(db, userId, id, 'refund', now, (cfg, who) => refundChainMilestone(cfg, db, who, id, { key: `paper-${id.replace(/[^A-Za-z0-9-]/g, '')}-${Math.floor(now / 60_000)}` }, now))
    return onChain(db, userId, id, 'release', now, (cfg, who) => releaseChainMilestone(cfg, db, who, id, now))
  }
  clientPaper(ctx, userId, id, decision, raw)
}

// ------------------------------------------------------------------------------------------------ disputes on payments

export const DISPUTE_REVIEW_MS = 60_000

export function openDispute(ctx: Ctx, userId: string, actionId: string, reason: unknown): { id: string } {
  const { db } = ctx
  const now = ctx.clock.now()
  const a = db.get<{ id: string; kind: string; state: string; venue: string }>('SELECT id, kind, state, venue FROM actions WHERE id = ? AND user_id = ?', actionId, userId)
  if (!a) throw notFound('That payment')
  if (a.kind !== 'payment' || a.state !== 'done') throw refused('cannot_dispute', 'Only a payment that has settled can be disputed.')
  if (db.get(`SELECT 1 FROM disputes WHERE action_id = ? AND state = 'open'`, actionId)) throw refused('already_open', 'A dispute is already open for that payment.')
  // A payment is refunded once: a refunded dispute stays on record, and disputing again would refund it again, money the
  // payee never sent (R13 review, R09).
  if (db.get(`SELECT 1 FROM disputes WHERE action_id = ? AND state = 'resolved_refund'`, actionId)) throw refused('already_refunded', 'That payment was already refunded after a dispute.')
  const text = clean(reason, 300)
  if (text.length < 5) throw bad('Say what went wrong.', { reason: 'Say what went wrong, in a sentence.' })
  const id = newId('dsp', now)
  // Reporting a problem stops what QED does on its own on this payment's rail until the person releases it (N-018).
  db.tx(() => {
    db.run(`INSERT INTO disputes (id, user_id, action_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)`, id, userId, actionId, text, now, now)
    startPause(ctx, userId, id, actionId, a.venue)
  })
  emit(db, now, userId, 'dispute', { id, state: 'open' })
  return { id }
}

/**
 * Resolve disputes whose paper review period has passed. With no real payee to answer, the outcome is a stated rule:
 * a payee whose address begins with "refund" gives the money back; any other payee's payment is upheld.
 */
export function disputeTick(ctx: Ctx): void {
  const { db } = ctx
  const now = ctx.clock.now()
  const due = db.all<{ id: string; user_id: string; action_id: string; reason: string }>(`SELECT id, user_id, action_id, reason FROM disputes WHERE state = 'open' AND created_at <= ?`, now - DISPUTE_REVIEW_MS)
  for (const d of due) {
    const a = db.get<{ params_json: string; economic_id: string }>('SELECT params_json, economic_id FROM actions WHERE id = ?', d.action_id)
    if (!a) continue
    const p = JSON.parse(a.params_json) as PaymentParams
    const refund = p.payeeHandle.startsWith('refund') && p.purpose === 'spend' && !db.get(`SELECT 1 FROM disputes WHERE action_id = ? AND state = 'resolved_refund' AND id <> ?`, d.action_id, d.id)
    withHome(db, d.user_id, () => db.tx(() => {
      if (refund) {
        const amt = BigInt(p.amount)
        post(db, { userId: d.user_id, ts: now, kind: 'dispute-refund', ref: `dispute:${d.id}:refund`, memo: `Refund from ${p.payeeName} after your dispute`, meta: { disputeId: d.id, actionId: d.action_id, paper: true }, lines: [{ account: 'bank', amount: amt }, { account: 'exp:spend', amount: -amt }] })
      }
      const resolution = refund ? 'The payee returned the money.' : 'The payment was found valid and stands.'
      db.run('UPDATE disputes SET state = ?, resolution = ?, updated_at = ? WHERE id = ?', refund ? 'resolved_refund' : 'resolved_upheld', resolution, now, d.id)
      issueReceipt(db, d.user_id, 'dispute', d.action_id, { what: `Dispute on your payment to ${p.payeeName}`, outcome: refund ? 'refunded' : 'upheld', reason: d.reason, resolution, amount: p.amount, rule: 'Paper rule: payees whose address begins with "refund" give the money back; others are upheld.' }, now)
      notice(db, d.user_id, { level: 'info', kind: 'dispute-resolved', title: `Dispute settled: ${p.payeeName}`, body: resolution, subject: d.action_id, dedupe: `dispute:${d.id}` }, now)
      emit(db, now, d.user_id, 'dispute', { id: d.id, state: refund ? 'resolved_refund' : 'resolved_upheld' })
    }))
  }
}
