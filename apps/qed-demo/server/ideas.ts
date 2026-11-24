/**
 * Grow's central journey (R13, the owner: "investment idea, necessary clarification, critical investigation, competing
 * strategies and simple baselines, feasibility, portfolio effects and uncertainty, owner decision, exact signed
 * authority, independently checked execution, monitoring, receipts and revision").
 *
 * An idea is read by fixed rules (shared/ideaParse.ts), never by a model, and what its words leave open is asked. The
 * investigation uses the household's own books (what is free, what must stay in the bank, money set aside for goals,
 * debts, holdings, the floor, instructions in force) and the prices this app has recorded (shared/ideaEval.ts). It keeps
 * five things apart: whether QED can place it here (implementable); whether free money pays for it (affordable: never
 * what must stay, never goal money); whether it is open to the household (eligible); whether it keeps the owner's own
 * rules (compatible: the floor, the limits, concentration); and what the record shows (supported). It always sets the
 * idea beside doing nothing and simple alternatives, makes the case against it, and offers to reject it or do nothing.
 *
 * Nothing here moves money or signs anything. Going ahead becomes one of the existing approval flows: a one-time order
 * through previewAction, whose exact document the owner's passkey signs, or an instruction draft through saveDraft,
 * signed on its own page and asking before every run. The decision re-checks the hard rules on the books as they are
 * then; the engine checks again when an order is sent (policy.ts). The idea's record follows what was signed and ran.
 */
import { closedText, isSecurity, securityCosts, sessionOf } from './securities.ts'
import { cancelApproval } from './approvals.ts'
import { AppError, bad, type Db, ist, newId, notFound, parse, refused } from './core.ts'
import { getProfile, type Profile } from './household.ts'
import { balance } from './ledger.ts'
import { liquidity } from './liquidity.ts'
import { previewAction } from './owner.ts'
import { buildDraft, discardDraft, freeCashFlow, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { exchangeCostsStatus, type Instrument, instrument, instruments, term } from './registry.ts'
import type { Ctx } from './types.ts'
import { limitFor, overview } from './valuation.ts'
import { fundEntitlement, smallestMarketBuy } from './venues.ts'
import { actionView } from './views.ts'
import { dayText } from '../shared/day-text.ts'
import { notional, parsePrice } from '../shared/fixed.ts'
import { difference, monthly, NOT_FITTED, OVERLAP, type Plan, type PlanResult, rolling, type Series, stress, SURVIVORSHIP, TAX_RATES, type TaxClass } from '../shared/ideaEval.ts'
import { type IdeaInstrument, type IdeaPlan, readIdea } from '../shared/ideaParse.ts'
import type { Choice, ChoiceId, Claim, DecideResult, IdeaEvent, IdeaReadView, IdeaRecord, IdeaState, IdeaSummary, Investigation, Judgement, Outcome, Verdict } from '../shared/ideaTypes.ts'
import { inr } from '../shared/money.ts'
import { canonical } from '../shared/sha256.ts'

const DAY = 86_400_000
/** One year and a day: a window long enough that an equity fund's gain is taxed as long-term, as a sale after a year would be. */
const HORIZON = 366
const LIQUID = 'amfi:118701'
const GROWTH = ['amfi:120716', 'amfi:120684', 'amfi:122639', 'amfi:148381', 'amfi:119788']
const CASH_LIKE = new Set(['liquid', 'overnight', 'arbitrage'])
/** The smallest fund purchase QED places (owner.ts buildOrder). */
const MIN_FUND = 10_000
const MAX_IDEA = 1_000_000_000
/** QED's caution, not a regulation: one holding over a quarter of what the household has, digital assets over a tenth. */
const ONE_HOLDING = 0.25, DIGITAL = 0.1
type Row = Record<string, unknown>
type Answers = { instrumentId?: unknown; amount?: unknown; cadence?: unknown }

const pct = (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`
const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
const short = (name: string): string => name.replace(/ \(.*\)$/, '')
/** A day with its year always written: a record's first and last windows can be years apart. */
const withYear = (iso: string): string => dayText(iso, '0000-01-01')
const isCashLike = (i: Instrument): boolean => i.kind === 'mutual_fund' && CASH_LIKE.has(String(i.meta.category ?? ''))
const taxOf = (i: Instrument): TaxClass => {
  if (i.kind === 'crypto_spot') return 'vda'
  if (i.kind === 'equity') return 'equity'
  if (i.kind === 'tbill' || i.kind === 'gsec') return 'debt'
  const c = String(i.meta.category ?? '')
  if (c === 'index-etf') return 'equity'
  if (c === 'gold-etf') return 'fof'
  return ['index', 'flexi', 'arbitrage'].includes(c) ? 'equity' : ['international', 'gold'].includes(c) ? 'fof' : 'debt'
}

function investable(db: Db): IdeaInstrument[] {
  return instruments(db).filter((i) => i.tradable && (i.kind === 'mutual_fund' || i.kind === 'crypto_spot' || isSecurity(i))).map((i) => ({ id: i.id, name: i.name, kind: i.kind, category: String(i.meta.category ?? '') }))
}
/** Whole thousands of what is free, all of it or half: the figures an idle-cash idea is asked to choose from. */
function parkChoices(free: number): { value: string; label: string }[] {
  const all = Math.floor(free / 100_000) * 100_000, half = Math.floor(free / 2 / 100_000) * 100_000
  return [...(all >= MIN_FUND ? [{ value: String(all), label: `All that is free, ${inr(all)}` }] : []), ...(half >= MIN_FUND && half < all ? [{ value: String(half), label: `Half of it, ${inr(half)}` }] : [])]
}

/** The idea as read, with the owner's answers to its questions in place, and what is still open. */
export function readWithAnswers(ctx: Ctx, userId: string, text: unknown, answers: unknown, now: number): IdeaReadView {
  if (typeof text !== 'string' || !text.trim() || text.length > 300) throw bad('Write the idea in a sentence of 300 characters at most, or pick one.', { text: 'Write the idea in a sentence of 300 characters at most, or pick one.' })
  const inv = investable(ctx.db)
  const r = readIdea(text, inv)
  const a = (answers ?? {}) as Answers
  const plan: IdeaPlan = { ...r.plan }
  if (!r.refusal) {
    if (typeof a.instrumentId === 'string' && inv.some((i) => i.id === a.instrumentId)) plan.instrumentId = a.instrumentId
    if (typeof a.amount === 'number' && Number.isSafeInteger(a.amount) && a.amount > 0) plan.amount = a.amount
    if (a.cadence === 'once' || a.cadence === 'monthly') plan.cadence = a.cadence
  }
  const free = liquidity(ctx.db, userId, now).free
  const questions = r.questions
    .filter((q) => (q.key === 'instrument' ? !plan.instrumentId : q.key === 'amount' ? plan.amount === null : !plan.cadence))
    .map((q) => (q.key === 'amount' && plan.action === 'park' ? { ...q, choices: parkChoices(free) } : q))
  const inst = plan.instrumentId ? inv.find((i) => i.id === plan.instrumentId) ?? null : null
  return { reading: { plan, heard: r.heard, questions, refusal: r.refusal }, instrument: inst ? { id: inst.id, name: inst.name, kind: inst.kind } : null, free }
}

// ------------------------------------------------------------------------------------------------ the record of prices
function seriesOf(db: Db, id: string): { s: Series; sources: Set<string> } | null {
  const inst = instrument(db, id)
  if (!inst) return null
  const rows = db.all<{ value_date: string; value: string; source: string }>('SELECT value_date, value, source FROM daily_values WHERE instrument_id = ? ORDER BY value_date', id)
  if (rows.length < 30) return null
  return { s: { id, name: short(inst.name), dates: rows.map((r) => r.value_date), values: rows.map((r) => Number(r.value)) }, sources: new Set(rows.map((r) => r.source)) }
}
/** Two monthly series on the months both have. */
function align(a: { months: string[]; r: number[] }, b: { months: string[]; r: number[] }): { a: number[]; b: number[] } {
  const mb = new Map(b.months.map((m, i) => [m, b.r[i]!]))
  const out = { a: [] as number[], b: [] as number[] }
  a.months.forEach((m, i) => { const y = mb.get(m); if (y !== undefined) { out.a.push(a.r[i]!); out.b.push(y) } })
  return out
}
/** A fixed mix's monthly returns, rebalanced each month, on the months every member has. */
function mixMonthly(members: { m: { months: string[]; r: number[] }; w: number }[]): { months: string[]; r: number[] } | null {
  if (!members.length) return null
  const maps = members.map((x) => ({ w: x.w, map: new Map(x.m.months.map((k, i) => [k, x.m.r[i]!])) }))
  const months = members[0]!.m.months.filter((k) => maps.every((x) => x.map.has(k)))
  return { months, r: months.map((k) => maps.reduce((s, x) => s + x.w * x.map.get(k)!, 0)) }
}

// ------------------------------------------------------------------------------------------------ the investigation
const runDay = (p: Profile): number => Math.min(28, Math.max(1, p.incomeDay + p.lateDays + 1))
const investParams = (instrumentId: string, amount: number, p: Profile) => ({ instrumentId, amount, schedule: { type: 'monthly', day: runDay(p), at: '10:00' } })
/** A monthly plan's authority: as many runs as the windows judged, ending when they would, asking before every run. */
const authorityFor = (runs: number, now: number) => ({ maxRuns: runs, expiresAt: now + (runs === 12 ? 366 : 200) * DAY, runMode: 'approve' })

export async function investigate(ctx: Ctx, userId: string, text: unknown, answers: unknown, now: number): Promise<Investigation> {
  const { db } = ctx
  const read = readWithAnswers(ctx, userId, text, answers, now)
  if (read.reading.refusal) throw refused('idea_refused', read.reading.refusal)
  if (read.reading.questions.length) throw bad(`Answer first: ${read.reading.questions.map((q) => q.text).join(' ')}`)
  const p = read.reading.plan
  const inst = instrument(db, p.instrumentId!)
  if (!inst || !inst.tradable) throw bad('Choose something QED can buy.', { instrumentId: 'Choose something QED can buy.' })
  const amount = p.amount!, cadence = p.cadence!
  if (amount > MAX_IDEA) throw bad(`QED tests ideas of up to ${inr(MAX_IDEA)}.`, { amount: `QED tests ideas of up to ${inr(MAX_IDEA)}.` })
  const name = short(inst.name), fund = inst.kind === 'mutual_fund', sec = isSecurity(inst), today = ist(now).date
  const profile = getProfile(db, userId)

  // ---- the household's books
  const o = overview(db, ctx.market, userId, now)
  const liq = o.liquidity, w = o.worst
  const free = liq.free
  const spare = Math.max(0, freeCashFlow(ctx, userId, now).free)
  const personalLoan = Number(balance(db, userId, 'loan:personal'))
  const have = o.bank + o.deposits + o.setAside + o.holdingsValue + o.inTransit
  const sameInForce = db.all<{ id: string; title: string; params_json: string }>(
    `SELECT p.id, p.title, v.params_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.kind = 'invest' AND p.state IN ('active', 'paused')`, userId)
    .filter((r) => parse<{ instrumentId?: string }>(r.params_json, {}).instrumentId === inst.id).map((r) => ({ id: r.id, title: r.title }))
  const lim = limitFor(db, inst)
  const total = cadence === 'once' ? amount : amount * 12

  // ---- costs, as each is known
  const stampTerm = term(db, 'mf.stamp'), stampRate = Number(stampTerm?.value.rate ?? '0.00005')
  let buyCost = fund ? stampRate : 0, sellCost = 0
  let book: Awaited<ReturnType<Ctx['venues']['crypto']['book']>> | null = null
  const rules = fund || sec ? null : ctx.venues.crypto.rules(inst)
  const costs: Investigation['costs'] = []
  if (fund) {
    costs.push({ label: 'Stamp duty on each purchase', value: pct(stampRate, 3), status: stampTerm?.status ?? 'modelled' })
    costs.push({ label: 'Exit load after a year', value: 'None', status: term(db, 'mf.exitload.none')?.status ?? 'modelled' })
    costs.push({ label: 'The fund\'s running costs', value: 'Already in its NAV', status: 'rule' })
  } else if (sec) {
    // a share, an ETF unit, a bill or a bond: the desk's own costs on a ₹1,00,000 trade, and half the gap between its two prices
    const g = 10_000_000n, bc = securityCosts(db, inst, 'buy', g), sc = securityCosts(db, inst, 'sell', g)
    const bid = Number(ctx.market.get(inst.id, 'bid')?.price ?? 0), ask = Number(ctx.market.get(inst.id, 'ask')?.price ?? 0)
    const half = bid > 0 && ask > 0 ? (ask - bid) / ask / 2 : 0
    buyCost = Number(bc.fee + bc.tax) / Number(g) + half; sellCost = Number(sc.fee + sc.tax) / Number(g) + half
    const status = inst.venue === 'paper-gsec' ? (term(db, 'rule.gsec.hours')?.status ?? 'unverified') : exchangeCostsStatus(db)
    costs.push({ label: 'Brokerage, exchange charges, transaction tax and stamp duty on a purchase', value: inst.venue === 'paper-gsec' ? 'None' : pct(Number(bc.fee + bc.tax) / Number(g), 3), status })
    costs.push({ label: 'The same on a sale', value: inst.venue === 'paper-gsec' ? 'None' : pct(Number(sc.fee + sc.tax) / Number(g), 3), status })
    costs.push({ label: 'Half the gap between buyers and sellers, each way', value: bid > 0 ? pct(half, 3) : 'No price right now', status: 'synthetic' })
  } else {
    try { book = await ctx.venues.crypto.book(inst) } catch { book = null }
    const fee = Number(rules!.feeRate)
    const half = book && book.asks[0] && book.bids[0] ? (Number(book.asks[0].price) - Number(book.bids[0].price)) / Number(book.asks[0].price) / 2 : 0
    buyCost = fee + half; sellCost = fee + half
    costs.push({ label: 'Venue fee, each way', value: pct(fee, 2), status: term(db, 'fee.paper-crypto.taker')?.status ?? 'modelled' })
    costs.push({ label: 'Half the gap between buyers and sellers, each way', value: book ? pct(half, 2) : 'No order book right now', status: 'live' })
    costs.push({ label: 'Tax deducted at source on a sale', value: `${pct(Number(rules!.tdsRate), 0)}, counted toward your income tax`, status: term(db, 'tax.vda.tds')?.status ?? 'modelled' })
  }
  costs.push({ label: 'Tax on a gain when you sell', value: TAX_RATES[taxOf(inst)].short, status: `modelled, not tax advice${taxOf(inst) === 'equity' ? '; the yearly exemption left out' : ''}` })

  // ---- 1. implementable: can QED place it here, on paper
  const judgements: Judgement[] = []
  let impl: Verdict = 'yes', implSays = ''
  if (fund) {
    const nav = ctx.market.get(inst.id, 'nav')
    const ent = fundEntitlement(inst, 'buy', now)
    if (!nav) { impl = 'no'; implSays = `No NAV has been received for ${name} yet, so QED cannot place it now.` }
    else if (amount < MIN_FUND) { impl = 'no'; implSays = `The smallest purchase QED places in a fund is ${inr(MIN_FUND)}.` }
    else implSays = cadence === 'once'
      ? `Yes, on paper. Approved now, it buys at the NAV for ${dayText(ent.minNavDate, today)} (cut-off ${ent.cutoff} India time), or the next one published.`
      : `Yes, on paper: a purchase on the ${ordinal(runDay(profile))} of each month, each at the NAV for its own day.`
  } else if (sec) {
    const ask = ctx.market.get(inst.id, 'ask'), step = Number(inst.meta.qtyStep ?? '1')
    const least = ask ? Math.ceil(Number(ask.price) * step) * 100 : 0
    const open = sessionOf(inst, now).open
    if (!ask) { impl = 'unknown'; implSays = `No price has been received for ${name} yet.` }
    else if (amount < least) { impl = 'no'; implSays = `At the current price one lot (${step} unit${step === 1 ? '' : 's'}) costs about ${inr(least)}, so ${inr(amount)} buys nothing.` }
    else implSays = `Yes, on paper, while the ${inst.venue === 'paper-gsec' ? 'government-securities desk' : 'exchange'} is open (${inst.meta.hours?.open ?? '09:15'} to ${inst.meta.hours?.close ?? '15:30'} India time, weekdays)${open ? '; it is open now' : `; it is closed now, so an order placed now is refused: ${closedText(inst, now)}`}. Prices are synthetic.`
  } else if (!book || !book.asks[0]) { impl = 'unknown'; implSays = 'No order book from CoinDCX right now: QED cannot price it until one arrives.' }
  else {
    const least = Math.ceil(Number(smallestMarketBuy(rules!, inst, book.asks[0].price)) / 100) * 100
    if (amount < least) { impl = 'no'; implSays = `At today's price the venue's smallest order needs at least ${inr(least)}.` }
    else implSays = 'Yes, on paper: an order against CoinDCX\'s live order book, filled on paper. No real money moves.'
  }
  if (cadence === 'monthly' && impl !== 'no') {
    // checked as the instruction it would become, by the instruction's own rules
    try {
      const d = buildDraft(ctx, userId, 'invest', investParams(inst.id, amount, profile), authorityFor(12, now), now)
      if (d.analysis.refusals.length) { impl = 'no'; implSays = d.analysis.refusals.join(' ') }
    } catch (e) { impl = 'no'; implSays = e instanceof AppError ? e.message : 'The instruction could not be drafted.' }
  }
  judgements.push({ key: 'implementable', title: 'Can QED place it?', verdict: impl, says: implSays })

  // ---- 2. affordable: from free money only
  const by = liq.binding ? ` by ${dayText(liq.binding.date, today)}` : ''
  const goals = o.setAside > 0 ? ` The ${inr(o.setAside)} set aside for goals is not counted.` : ''
  let afford: Verdict
  let affordSays: string
  if (cadence === 'once') {
    afford = amount <= free ? 'yes' : 'no'
    affordSays = amount <= free
      ? `Yes: ${inr(amount)} of the ${inr(free)} that is free. ${inr(liq.need)} must stay in the bank for what is due${by}.${goals}`
      : `No: it needs ${inr(amount)} and ${inr(free)} is free. ${inr(liq.need)} must stay in the bank for what is due${by}.${goals}`
  } else {
    afford = amount <= spare && amount <= free ? 'yes' : 'no'
    affordSays = amount > spare
      ? `No: after your recorded spending, bills and instalments about ${inr(spare)} a month is left over, and this needs ${inr(amount)} a month.`
      : amount > free
        ? `No: the first purchase needs ${inr(amount)} and ${inr(free)} is free now.${goals}`
        : `Yes: about ${inr(spare)} a month is left over after your recorded spending, bills and instalments, and ${inr(free)} is free now.${goals}`
  }
  judgements.push({ key: 'affordable', title: 'Can free money pay for it?', verdict: afford, says: affordSays })

  // ---- 3. eligible: open to this household, under the instrument's rules
  judgements.push({
    key: 'eligible', title: 'Is it open to you?', verdict: inst.tradable ? 'yes' : 'no',
    says: fund
      ? `Yes: listed here and taking new money on paper. On paper there is no KYC check; a real purchase needs one with the fund house.`
      : sec ? `Yes: listed on a paper ${inst.venue === 'paper-gsec' ? 'government-securities desk' : 'exchange'}. On paper there is no KYC or demat check; a real purchase needs both. Its prices are synthetic.`
      : `Yes: listed on the paper venue. Gains on digital assets are taxed at 30% and losses cannot be set off; 1% is deducted at source on a sale.`,
  })

  // ---- 4. compatible with the owner's own rules: the floor, the limits, concentration
  const perRun = amount
  const worstAfter = w.gHat - Math.round(perRun * lim.fall)
  const largest = lim.fall > 0 ? Math.max(0, Math.floor(w.cushion / lim.fall / 100_000) * 100_000) : null
  const thisNow = o.holdings.find((h) => h.instrumentId === inst.id)?.value ?? 0
  const marketNow = o.holdings.filter((h) => { const i = instrument(db, h.instrumentId); return i ? !isCashLike(i) : true }).reduce((s, h) => s + (h.value ?? 0), 0)
  const added = isCashLike(inst) ? 0 : total
  const shareOne = have > 0 ? (thisNow + total) / have : 1
  const cryptoNow = o.holdings.filter((h) => h.kind === 'crypto_spot').reduce((s, h) => s + (h.value ?? 0), 0)
  const concentration = !fund && !sec && have > 0 && (cryptoNow + total) / have > DIGITAL
    ? `Digital assets would be ${pct((cryptoNow + total) / have, 0)} of what you have; QED points this out above a tenth.`
    : !isCashLike(inst) && shareOne > ONE_HOLDING ? `${name} would be ${pct(shareOne, 0)} of what you have; QED points this out above a quarter.` : null
  let compat: Verdict = worstAfter >= w.line ? 'yes' : 'no'
  const compatParts: string[] = []
  if (compat === 'no') compatParts.push(`No: ${cadence === 'once' ? 'it' : 'each purchase'} would take your worst case to ${inr(worstAfter)}, below your floor of ${inr(w.line)}.${largest !== null && largest >= MIN_FUND ? ` The most that keeps you above it is about ${inr(largest)}.` : ''}`)
  else compatParts.push(`Yes: your worst case would be ${inr(worstAfter)}${cadence === 'monthly' ? ' after the first purchase' : ''}, above your floor of ${inr(w.line)}.${cadence === 'monthly' ? ' Each purchase is checked against your floor when it is due.' : ''}`)
  if (concentration) compatParts.push(concentration)
  if (lim.status !== 'calibrated' && lim.status !== 'verified') compatParts.push(`Its limit (a fall of ${pct(lim.fall, 0)}) is illustrative, not measured from past prices.`)
  if (cadence === 'monthly') compatParts.push('As an instruction it asks you before every purchase and stops after 12.')
  if (sameInForce.length) compatParts.push(`You already have ${sameInForce.length === 1 ? 'an instruction' : `${sameInForce.length} instructions`} buying this: ${sameInForce.map((s) => s.title).join('; ')}.`)
  if (compat === 'yes' && (concentration || compatParts.length > 1 && lim.status !== 'calibrated' && lim.status !== 'verified')) compat = 'caution'
  judgements.push({ key: 'compatible', title: 'Does it keep your own rules?', verdict: compat, says: compatParts.join(' ') })

  // ---- 5. what the record shows: past windows, the same for every plan, and claims it can bear
  const cashRate = Number(term(db, 'rate.savings')?.value.apr ?? '0.0275')
  const mixIds = o.holdings.filter((h) => h.value && h.value > 0).map((h) => h.instrumentId)
  const loaded = new Map<string, Series>(), sources = new Set<string>()
  for (const id of new Set([inst.id, LIQUID, ...GROWTH, ...mixIds])) { const x = seriesOf(db, id); if (x) { loaded.set(id, x.s); x.sources.forEach((s) => sources.add(s)) } }
  const synthetic = sources.has('synthetic') || sources.has('synthetic-markets')
  const ideaSeries = loaded.get(inst.id) ?? null
  const startOf = (id: string): string => loaded.get(id)?.dates[0] ?? '9999'
  const leg = (id: string, weight: number) => { const i = instrument(db, id)!; return { id, weight, taxClass: taxOf(i), buyCost: id === inst.id ? buyCost : stampRate, sellCost: id === inst.id ? sellCost : 0 } }
  const months = cadence === 'monthly' ? 12 : 0
  const shaped = (pl: Plan): Plan => (months && pl.kind !== 'cash' ? { ...pl, kind: 'spread', spreadMonths: months } : pl)
  // alternatives chosen so that their records start no later than the idea's (else they would cut every window short)
  const anchorId = ideaSeries ? inst.id : loaded.has(LIQUID) ? LIQUID : null
  const since = anchorId ? startOf(anchorId) : '9999'
  const covers = (id: string): boolean => loaded.has(id) && startOf(id) <= addDaysIso(since, 31)
  const plans: { plan: Plan; kind: Outcome['kind']; why: string; choice: ChoiceId | null }[] = []
  if (ideaSeries) plans.push({ plan: shaped({ id: 'idea', label: `This idea: ${name}`, kind: 'idea', legs: [leg(inst.id, 1)] }), kind: 'idea', why: cadence === 'once' ? `${name}, bought once and sold at the end, after costs and modelled tax.` : `${name}, bought every month for a year and sold at the end, after costs and modelled tax.`, choice: cadence === 'once' ? 'order' : 'instruction' })
  plans.push({ plan: { id: 'cash', label: 'Do nothing', kind: 'cash', legs: [] }, kind: 'cash', why: `Keep the money in your bank at ${pct(cashRate, 2)} a year, the paper bank's savings rate, the interest taxed at the slab rate.`, choice: 'nothing' })
  if (inst.id !== LIQUID && covers(LIQUID)) plans.push({ plan: shaped({ id: 'liquid', label: 'The liquid fund', kind: 'liquid', legs: [leg(LIQUID, 1)] }), kind: 'liquid', why: 'Nippon India Liquid Fund: where QED parks idle cash; it rarely falls.', choice: cadence === 'once' ? 'alt:liquid' : null })
  if (cadence === 'once' && ideaSeries && !isCashLike(inst)) plans.push({ plan: { id: 'spread', label: 'The same, over six months', kind: 'spread', spreadMonths: 6, legs: [leg(inst.id, 1)] }, kind: 'spread', why: `${name} in six equal monthly parts; the rest waits in the bank meanwhile.`, choice: 'alt:spread' })
  // a growth basket and the household's own mix are alternatives for a growth idea; idle cash is set against doing nothing
  const cashIdea = isCashLike(inst)
  const basket = cashIdea ? [] : GROWTH.filter(covers)
  const named = (ids: string[]): string => { const n = ids.map((id) => short(instrument(db, id)!.name)); return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? '' }
  if (basket.length >= 2) plans.push({ plan: shaped({ id: 'basket', label: `Equal shares of ${basket.length} funds`, kind: 'basket', legs: basket.map((id) => leg(id, 1 / basket.length)) }), kind: 'basket', why: `Equal shares of ${named(basket)}: a fixed rule, from the growth funds QED lists with a record long enough to compare.`, choice: null })
  const mixHeld = cashIdea ? [] : o.holdings.filter((h) => h.value && h.value > 0 && covers(h.instrumentId))
  const mixValue = mixHeld.reduce((s, h) => s + h.value!, 0)
  if (mixHeld.length && !(mixHeld.length === 1 && mixHeld[0]!.instrumentId === inst.id)) plans.push({ plan: shaped({ id: 'mix', label: 'Your current mix', kind: 'mix', legs: mixHeld.map((h) => leg(h.instrumentId, h.value! / mixValue)) }), kind: 'mix', why: 'What you hold now, in the same proportions.', choice: null })
  const roll = anchorId ? rolling(plans.map((x) => x.plan), loaded, HORIZON, cashRate, { anchor: anchorId }) : null
  const result = (id: string): PlanResult | null => roll?.plans.find((r) => r.id === id) ?? null
  const outcomes: Outcome[] = plans.map((x) => {
    const r = result(x.plan.id)
    return { id: x.plan.id, label: x.plan.label, kind: x.kind, median: r ? r.median : null, p05: r ? r.p05 : null, worst: r ? r.worst : null, lostIn: r ? r.lostIn : null, medianValue: r ? Math.round(total * r.median) : null, why: x.why, choice: x.choice }
  })
  if (!ideaSeries) outcomes.unshift({ id: 'idea', label: `This idea: ${name}`, kind: 'idea', median: null, p05: null, worst: null, lostIn: null, medianValue: null, why: `QED has no recorded daily prices for ${name}, so no past window can be worked out for it.`, choice: cadence === 'once' ? 'order' : 'instruction' })
  // paying down the personal loan: certain while the loan lasts (modelled terms)
  const pl = term(db, 'rate.loan.personal')?.value
  if (personalLoan > 0 && pl) {
    const r = Number(pl.apr ?? 0.14), charge = Number(pl.prepayCharge ?? 0.03), v = 1 + r - charge
    outcomes.push({ id: 'loan', label: 'Prepay your personal loan', kind: 'loan', median: v, p05: v, worst: v, lostIn: 0, medianValue: Math.round(Math.min(total, personalLoan) * v + Math.max(0, total - personalLoan)), why: `Each rupee prepaid stops ${pct(r, 0)} a year of interest, less a ${pct(charge, 0)} charge to prepay (modelled terms); ${inr(personalLoan)} is owed.`, choice: null })
  }

  // claims: monthly returns, at least 36 months, every comparison counted
  const through = today.slice(0, 7)
  const mIdea = ideaSeries ? monthly(ideaSeries, through) : null
  const rCash = Math.pow(1 + cashRate, 1 / 12) - 1
  const comps: { vs: string; b: { months: string[]; r: number[] } }[] = []
  if (mIdea) {
    comps.push({ vs: 'doing nothing', b: { months: mIdea.months, r: mIdea.months.map(() => rCash) } })
    if (inst.id !== LIQUID && loaded.has(LIQUID)) comps.push({ vs: 'the liquid fund', b: monthly(loaded.get(LIQUID)!, through) })
    const bm = mixMonthly(basket.filter((id) => id !== inst.id || basket.length > 1).map((id) => ({ m: monthly(loaded.get(id)!, through), w: 1 / basket.length })))
    if (basket.length >= 2 && bm) comps.push({ vs: `equal shares of ${basket.length} funds`, b: bm })
    const mm = mixHeld.length && !(mixHeld.length === 1 && mixHeld[0]!.instrumentId === inst.id) ? mixMonthly(mixHeld.map((h) => ({ m: monthly(loaded.get(h.instrumentId)!, through), w: h.value! / mixValue }))) : null
    if (mm) comps.push({ vs: 'your current mix', b: mm })
  }
  const family = 0.05 / Math.max(1, comps.length)
  const claims: Claim[] = comps.map((c) => {
    const al = align(mIdea!, c.b)
    const d = difference(al.a, al.b, { familyAlpha: family, minMonths: 36 })
    const yr = (x: number) => `${x >= 0 ? '' : '−'}${pct(Math.abs(x))}`
    const says = d.tooShort
      ? `Against ${c.vs}: ${d.months} months is too short for a claim; QED makes none until 36.`
      : d.detectable
        ? `Against ${c.vs}: about ${yr(d.yearly)} a year ${d.yearly >= 0 ? 'more' : 'less'} over ${d.months} months (95% interval ${yr(d.lo)} to ${yr(d.hi)}), more than chance explains${comps.length > 1 ? ` with all ${comps.length} comparisons counted` : ''}. Before tax; one period of history, not a forecast.`
        : `Against ${c.vs}: the record cannot tell them apart over ${d.months} months; it could only have seen a difference of about ${pct(d.mde)} a year.`
    return { vs: c.vs, difference: d, says }
  })
  const basis: Investigation['evidence']['basis'] = !ideaSeries ? 'none' : synthetic ? 'synthetic' : 'recorded'
  const sourceText = synthetic ? 'synthetic prices generated on this computer, not market data' : [...sources].some((s) => s.startsWith('mfapi') || s.startsWith('amfi')) ? 'published NAVs this app recorded (AMFI; earlier history back-filled from mfapi.in)' : sources.size ? `values this app recorded (${[...sources].join(', ')})` : 'no recorded prices'
  const says: string[] = []
  if (!ideaSeries) says.push(`QED has no recorded daily prices for ${name}, so the record says nothing about how it would have done. No figure is shown for it rather than a guess.`)
  if (roll) says.push(`${roll.windows.toLocaleString('en-IN')} past ${cadence === 'monthly' ? 'years of monthly purchases' : 'one-year windows'}, started on each recorded day from ${withYear(roll.firstStart)} to ${withYear(roll.lastStart)}, valued after costs and modelled tax.`)
  else if (ideaSeries) says.push(`The record of ${name} is shorter than a year and a day, so no one-year window can be worked out.`)
  for (const c of claims) says.push(c.says)
  if (synthetic) says.push('Every price here is synthetic, generated on this computer: this shows the method, not markets.')
  const notes = [OVERLAP, NOT_FITTED, SURVIVORSHIP, 'Tax as QED models it: not verified against the Income-tax Act 2025, and not tax advice.']
  const detectedBetter = claims.some((c) => c.difference.detectable && c.difference.yearly > 0 && c.vs === 'doing nothing')
  const detectedWorse = claims.some((c) => c.difference.detectable && c.difference.yearly < 0)
  const supported: Verdict = !ideaSeries || !roll ? 'unknown' : detectedWorse ? 'no' : detectedBetter ? 'yes' : 'unknown'
  judgements.push({
    key: 'supported', title: 'What does the record show?', verdict: supported,
    says: !ideaSeries ? `Nothing: QED has no recorded daily prices for ${name}.`
      : !roll ? `Too little: the record is shorter than a year and a day.`
        : detectedWorse ? `It did worse than ${claims.filter((c) => c.difference.detectable && c.difference.yearly < 0).map((c) => c.vs).join(' and ')}, by more than chance explains.`
          : detectedBetter ? `It did better than doing nothing by more than chance explains${claims.some((c) => c.vs !== 'doing nothing' && !c.difference.detectable) ? ', but not detectably better than the other alternatives' : ''}. One period of history, not a forecast.`
            : claims.some((c) => c.difference.tooShort) ? `Not enough: ${claims[0]?.difference.months ?? 0} months of record, and QED makes no claim on fewer than 36.` : 'The record cannot tell it apart from the alternatives.',
  })

  // ---- portfolio effects and stress
  const ideaR = result('idea')
  const stressList = stress(total, ideaR, mIdea, lim.fall, lim.status).map((x) => ({ ...x, on: total }))
  const effects: Investigation['effects'] = {
    worstBefore: w.gHat, worstAfter, floor: w.line, freeBefore: free, freeAfter: free - (cadence === 'once' ? amount : amount), largest, concentration,
    marketShareBefore: have > 0 ? marketNow / have : 0, marketShareAfter: have > 0 ? (marketNow + added) / have : 0,
  }

  // ---- the case for and against, from the figures
  const forIt: string[] = [], against: string[] = []
  const cashR = result('cash')
  if (ideaR && roll) {
    forIt.push(`In ${pct(1 - ideaR.lostIn, 0)} of ${roll.windows.toLocaleString('en-IN')} past windows it ended above what was put in; the middle outcome was ${inr(Math.round(total * ideaR.median))} for ${inr(total)}.`)
    if (cashR && ideaR.median > cashR.median) forIt.push(`Its middle outcome was ${inr(Math.round(total * (ideaR.median - cashR.median)))} more than doing nothing.`)
    if (ideaR.lostIn > 0) against.push(`It lost money in ${pct(ideaR.lostIn, 0)} of the windows; the worst lost ${inr(Math.max(0, Math.round(total * (1 - ideaR.worst))))}.`)
    const better = outcomes.filter((x) => x.id !== 'idea' && x.median !== null && x.lostIn !== null && x.median > ideaR.median && x.lostIn <= ideaR.lostIn)
    if (better.length) against.push(`${better.map((x) => x.label).join(' and ')} did better in the middle and lost no more often, on the same windows.`)
  }
  for (const c of claims) if (c.difference.detectable) (c.difference.yearly > 0 ? forIt : against).push(c.says)
  if (!ideaSeries) against.push(`There is no record of ${name} to judge it by.`)
  else if (claims.length && claims.every((c) => c.difference.tooShort)) against.push('The record is too short to tell it apart from doing nothing.')
  const loan = outcomes.find((x) => x.id === 'loan')
  if (loan) against.push(`Your personal loan costs ${pct(Number(pl!.apr ?? 0.14), 0)} a year: prepaying it earns about that for certain while it lasts.`)
  if (cadence === 'once' && free - amount < profile.spending && amount <= free) against.push(`It leaves ${inr(free - amount)} free, less than a month of your declared spending (${inr(profile.spending)}).`)
  if (concentration) against.push(concentration)
  if (!fund && !sec) against.push('Gains on digital assets are taxed at 30% and losses cannot be set off.')
  if (sec) against.push('Its prices are synthetic, generated on this computer: the record above shows how the method behaves on made-up prices, not how this security did.')
  if (impl === 'no') against.unshift(implSays)
  if (afford === 'no') against.unshift(affordSays)
  if (compat === 'no') against.unshift(compatParts[0]!)

  // ---- what the owner can decide
  const hardOk = impl === 'yes' && afford === 'yes' && compat !== 'no'
  const no = (why: string): string => `Not offered: ${why.replace(/^No: /, '').replace(/^./, (c) => c.toLowerCase())}`
  const firstFail = impl !== 'yes' ? implSays : afford !== 'yes' ? affordSays : compatParts[0]!
  const choices: Choice[] = []
  if (cadence === 'once') choices.push({ id: 'order', label: `Buy ${inr(amount)} of ${name}, once`, allowed: hardOk, why: hardOk ? 'You see the exact order and its estimate, and sign it with your passkey. Nothing is sent before that.' : no(firstFail) })
  else choices.push({ id: 'instruction', label: `Buy ${inr(amount)} of ${name} every month, 12 times`, allowed: hardOk, why: hardOk ? `An instruction you sign with your passkey: on the ${ordinal(runDay(profile))} of each month, asking you before every purchase.` : no(firstFail) })
  if (cadence === 'once' && inst.id !== LIQUID) {
    const liqInst = instrument(db, LIQUID)
    const lf = liqInst ? limitFor(db, liqInst).fall : 1
    const ok = !!liqInst && !!ctx.market.get(LIQUID, 'nav') && amount >= MIN_FUND && amount <= free && w.gHat - Math.round(amount * lf) >= w.line
    choices.push({ id: 'alt:liquid', label: `Put ${inr(amount)} in the liquid fund instead`, allowed: ok, why: ok ? 'The low-risk alternative, as a one-time order you sign.' : amount > free ? no(affordSays) : 'Not offered: the liquid fund cannot take it right now.' })
  }
  if (cadence === 'once' && !isCashLike(inst)) {
    const part = Math.floor(amount / 6 / 100) * 100
    const least = fund ? MIN_FUND : sec ? Math.ceil(Number(ctx.market.get(inst.id, 'ask')?.price ?? 0) * Number(inst.meta.qtyStep ?? '1')) * 100 || Number.POSITIVE_INFINITY : book?.asks[0] ? Math.ceil(Number(smallestMarketBuy(rules!, inst, book.asks[0].price)) / 100) * 100 : Number.POSITIVE_INFINITY
    const ok = impl === 'yes' && part >= least && amount <= free && w.gHat - Math.round(part * lim.fall) >= w.line
    choices.push({ id: 'alt:spread', label: `Spread it: ${inr(part)} a month for six months`, allowed: ok, why: ok ? `An instruction you sign: on the ${ordinal(runDay(profile))} of each month, six times, asking before each purchase.` : part < least ? `Not offered: a sixth, ${inr(part)}, is below the smallest purchase.` : no(firstFail) })
  }
  choices.push({ id: 'reject', label: 'Not this', allowed: true, why: 'Say why if you like; it is kept with the idea.' })
  choices.push({ id: 'nothing', label: 'Do nothing for now', allowed: true, why: 'The money stays where it is. Nothing is sent or signed.' })

  const title = p.action === 'park' ? `Move ${inr(amount)} of idle cash to ${name}` : cadence === 'once' ? `${inr(amount)} into ${name}, once` : `${inr(amount)} a month into ${name}`
  return {
    v: 1, at: now, plan: { ...p, instrumentId: inst.id, amount, cadence }, instrument: { id: inst.id, name: inst.name, kind: inst.kind, category: fund || sec ? String(inst.meta.category ?? 'fund') : 'crypto' }, title,
    context: { bank: o.bank, free, mustStay: liq.need, mustStayBy: liq.binding?.date ?? null, setAside: o.setAside, card: o.card, loans: o.loans, personalLoan, holdings: o.holdingsValue, netWorth: o.netWorth, worst: w.gHat, floor: w.line, illustrative: w.illustrative, monthlySpare: spare, sameInForce: sameInForce.map(({ id, title: t }) => ({ id, title: t })) },
    judgements, effects, costs,
    evidence: { basis, source: sourceText, horizonDays: HORIZON, windows: roll?.windows ?? 0, firstStart: roll?.firstStart ?? null, lastStart: roll?.lastStart ?? null, outcomes, claims, says, notes },
    stress: stressList, case: { for: forIt, against }, choices,
    schedule: cadence === 'monthly' ? `On the ${ordinal(runDay(profile))} of each month at 10:00 India time, 12 times; it asks you before each purchase.` : null,
  }
}
function addDaysIso(iso: string, n: number): string { return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10) }

// ------------------------------------------------------------------------------------------------ the record
function event(db: Db, ideaId: string, userId: string, at: number, kind: string, says: string): void {
  db.run('INSERT INTO idea_events (idea_id, user_id, at, kind, says) VALUES (?, ?, ?, ?, ?)', ideaId, userId, at, kind, says)
}
/** The five answers as a sentence for the idea's history. */
const SAID: Record<string, Partial<Record<Verdict, string>>> = {
  implementable: { yes: 'QED can place it', no: 'QED cannot place it', unknown: 'QED cannot place it now' },
  affordable: { yes: 'free money pays for it', no: 'free money does not cover it' },
  eligible: { yes: 'it is open to you', no: 'it is not open to you' },
  compatible: { yes: 'it keeps your rules', caution: 'it keeps your rules, with a caution', no: 'it breaks your floor' },
  supported: { yes: 'the record gives it some support', no: 'the record is against it', unknown: 'the record cannot tell' },
}
const verdictWords = (inv: Investigation): string => inv.judgements.map((j) => SAID[j.key]?.[j.verdict] ?? `${j.title} ${j.verdict}`).join('; ')

export async function createIdea(ctx: Ctx, userId: string, body: Row, now: number): Promise<{ id: string }> {
  const { db } = ctx
  const inv = await investigate(ctx, userId, body.text, body.answers, now)
  const hash = sha256hex(canonical(inv))
  const revises = typeof body.revises === 'string' && db.get('SELECT 1 FROM ideas WHERE id = ? AND user_id = ?', body.revises, userId) ? body.revises : null
  const id = newId('idea', now)
  db.tx(() => {
    db.run(`INSERT INTO ideas (id, user_id, text, title, investigation_json, investigation_hash, state, revises, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id, userId, String(body.text).trim(), inv.title, JSON.stringify(inv), hash, revises, now, now)
    event(db, id, userId, now, 'investigated', `Tested on your books and the recorded prices: ${verdictWords(inv)}.`)
    if (revises) event(db, revises, userId, now, 'revised', `Revised as a new idea: ${inv.title}.`)
  })
  return { id }
}

export function listIdeas(db: Db, userId: string, limit = 20): IdeaSummary[] {
  return db.all<Row>('SELECT id FROM ideas WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit).map((r) => summaryOf(db, userId, db.get<Row>('SELECT * FROM ideas WHERE id = ?', String(r.id))!))
}
function stateOf(db: Db, userId: string, r: Row): IdeaState {
  const s = String(r.state) as IdeaState
  if (s === 'declined' || s === 'no-action') return s
  if (r.approval_id && db.get('SELECT 1 FROM actions WHERE approval_id = ? AND user_id = ?', String(r.approval_id), userId)) return 'acted'
  if (r.program_id && db.get('SELECT 1 FROM programs WHERE id = ? AND user_id = ? AND live_version IS NOT NULL', String(r.program_id), userId)) return 'acted'
  return s
}
function summaryOf(db: Db, userId: string, r: Row): IdeaSummary {
  return { id: String(r.id), text: String(r.text), title: String(r.title), createdAt: Number(r.created_at), state: stateOf(db, userId, r), choice: (r.choice as ChoiceId | null) ?? null, revises: (r.revises as string | null) ?? null }
}

/** What the money did since it went in, against doing nothing and the liquid fund over the same days. */
function monitorOf(ctx: Ctx, inv: Investigation, fills: { at: number; put: number; qty: bigint }[], now: number): IdeaRecord['monitor'] {
  if (!fills.length) return null
  const inst = instrument(ctx.db, inv.instrument.id)
  if (!inst) return null
  const tick = ctx.market.get(inst.id, inst.kind === 'mutual_fund' ? 'nav' : 'bid')
  const qty = fills.reduce((s, f) => s + f.qty, 0n)
  const value = tick ? Number(notional(qty, inst.baseScale, parsePrice(tick.price), 2, 'down')) : null
  const rate = Number(term(ctx.db, 'rate.savings')?.value.apr ?? '0.0275')
  const doNothing = Math.round(fills.reduce((s, f) => s + f.put * (1 + rate * Math.max(0, now - f.at) / (365 * DAY)), 0))
  const liquidRows = (iso: string) => ctx.db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date <= ? ORDER BY value_date DESC LIMIT 1', LIQUID, iso)
  const lastLiquid = liquidRows(ist(now).date)
  const liquid = lastLiquid && fills.every((f) => liquidRows(ist(f.at).date)) ? Math.round(fills.reduce((s, f) => s + f.put * (Number(lastLiquid.value) / Number(liquidRows(ist(f.at).date)!.value)), 0)) : null
  const since = Math.min(...fills.map((f) => f.at)), days = Math.floor((now - since) / DAY)
  const put = fills.reduce((s, f) => s + f.put, 0)
  const says = days < 30
    ? `${days === 0 ? 'Bought today' : `${days} day${days === 1 ? '' : 's'} in`}: too early to compare. Over a few days a difference is mostly noise.`
    : `Over ${days} days: worth ${value === null ? 'an unknown amount (no price now)' : inr(value)}, against ${inr(doNothing)} had it stayed in the bank${liquid !== null ? ` and ${inr(liquid)} in the liquid fund` : ''}. One period: not a verdict on the idea.`
  return { since, days, put, value, doNothing, liquid, says }
}

export function ideaRecord(ctx: Ctx, userId: string, id: string, now: number): IdeaRecord {
  const { db } = ctx
  const r = db.get<Row>('SELECT * FROM ideas WHERE id = ? AND user_id = ?', id, userId)
  if (!r) throw notFound('That idea')
  const inv = parse<Investigation>(r.investigation_json, {} as Investigation)
  const fills: { at: number; put: number; qty: bigint }[] = []
  const fillOf = (a: Row): void => {
    if (a.state !== 'done') return
    const res = parse<Record<string, string>>(a.result_json, {})
    const times = parse<Record<string, number>>(a.times_json, {})
    if (!res.filledQty || !res.movedPaise) return
    fills.push({ at: Number(res.allottedAt ?? times.done ?? a.updated_at), put: Number(res.movedPaise), qty: BigInt(res.filledQty) })
  }
  let order: IdeaRecord['order'] = null
  if (r.approval_id) {
    const ap = db.get<Row>('SELECT doc_hash, confirmed_at, method, cancelled_at, expires_at FROM approvals WHERE id = ? AND user_id = ?', String(r.approval_id), userId)
    const a = db.get<Row>('SELECT * FROM actions WHERE approval_id = ? AND user_id = ?', String(r.approval_id), userId)
    const v = a ? actionView(db, a) as { id: string; state: string; what: string; decision: { checks?: { rule: string; pass: boolean; detail?: string }[] }; receiptId: string | null; result: Record<string, unknown>; times: Record<string, number> } : null
    if (a) fillOf(a)
    order = {
      approvalId: String(r.approval_id), docHash: String(ap?.doc_hash ?? ''), signed: !!ap?.confirmed_at, method: (ap?.method as string | null) ?? null, signedAt: (ap?.confirmed_at as number | null) ?? null,
      lapsed: !a && (!!ap?.cancelled_at || Number(ap?.expires_at ?? 0) < now),
      action: v ? { id: v.id, state: v.state, what: v.what, checks: v.decision.checks ?? [], receiptId: v.receiptId, result: v.result, times: v.times } : null,
    }
  }
  let instruction: IdeaRecord['instruction'] = null
  if (r.program_id) {
    const p = db.get<Row>('SELECT id, title, state, live_version FROM programs WHERE id = ? AND user_id = ?', String(r.program_id), userId)
    if (p) {
      const ver = p.live_version ? db.get<Row>('SELECT content_hash, approved_at FROM program_versions WHERE program_id = ? AND version = ?', String(p.id), Number(p.live_version)) : undefined
      const runs = db.all<{ state: string }>('SELECT state FROM runs WHERE program_id = ? AND user_id = ?', String(p.id), userId)
      const acts = db.all<Row>('SELECT * FROM actions WHERE program_id = ? AND user_id = ? ORDER BY created_at', String(p.id), userId)
      acts.forEach(fillOf)
      instruction = {
        programId: String(p.id), title: String(p.title), state: String(p.state), signed: p.live_version !== null && p.live_version !== undefined, contentHash: (ver?.content_hash as string | null) ?? null, signedAt: (ver?.approved_at as number | null) ?? null,
        runs: { done: runs.filter((x) => x.state === 'done' || x.state === 'partial').length, waiting: runs.filter((x) => ['due', 'awaiting_approval', 'objection_window', 'executing'].includes(x.state)).length, refused: runs.filter((x) => ['failed', 'blocked', 'skipped', 'cancelled', 'expired', 'missed'].includes(x.state)).length },
        actions: acts.map((a) => { const v = actionView(db, a) as { id: string; state: string; what: string; receiptId: string | null }; return { id: v.id, state: v.state, what: v.what, receiptId: v.receiptId } }),
      }
    }
  }
  const revisedBy = db.get<{ id: string }>('SELECT id FROM ideas WHERE revises = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1', id, userId)?.id ?? null
  // the history: the idea's own events, then what the approval flows record, each at its own time (read, never stored twice)
  const events = db.all<IdeaEvent>('SELECT at, kind, says FROM idea_events WHERE idea_id = ? AND user_id = ? ORDER BY at, rowid', id, userId)
  const ran = (a: Row, what: string): void => {
    events.push({ at: Number(a.created_at), kind: 'sent', says: `${what} made from the signed terms, to be checked again before it is sent.` })
    const res = parse<Record<string, unknown>>(a.result_json, {}), times = parse<Record<string, number>>(a.times_json, {})
    if (a.state === 'done') events.push({ at: Number(res.allottedAt ?? times.done ?? a.updated_at), kind: 'filled', says: `${what} filled on paper; its record shows the units, the price and the receipt.` })
    else if (['failed', 'rejected', 'blocked', 'cancelled'].includes(String(a.state))) events.push({ at: Number(a.updated_at), kind: 'stopped', says: `${what} did not go ahead (${String(a.state)}); its record says why.` })
  }
  if (order?.signedAt) events.push({ at: order.signedAt, kind: 'signed', says: `Signed with your ${order.method ?? 'passkey'}: the exact order, fingerprint ${order.docHash.slice(0, 12)}.` })
  if (order?.action) ran(db.get<Row>('SELECT * FROM actions WHERE id = ?', order.action.id)!, 'The order was')
  if (instruction?.signedAt) events.push({ at: instruction.signedAt, kind: 'signed', says: 'Signed with your passkey: the instruction is in force, and it asks you before each purchase.' })
  for (const a of instruction?.actions ?? []) ran(db.get<Row>('SELECT * FROM actions WHERE id = ?', a.id)!, 'A monthly purchase was')
  events.sort((x, y) => x.at - y.at)
  return {
    ...summaryOf(db, userId, r), investigation: inv, hash: String(r.investigation_hash), reason: (r.reason as string | null) ?? null, decidedAt: (r.decided_at as number | null) ?? null,
    order, instruction, monitor: monitorOf(ctx, inv, fills, now),
    events,
    revisedBy,
  }
}

// ------------------------------------------------------------------------------------------------ the decision
/**
 * The owner's decision. Going ahead is re-checked on the books as they are now (from free money only, above the floor,
 * placeable here) and then handed to an existing approval flow; nothing is signed or sent here. A decision may be
 * changed until something is signed: an unsigned request is withdrawn and an unsigned draft discarded first.
 */
export async function decide(ctx: Ctx, userId: string, id: string, body: Row, now: number): Promise<DecideResult> {
  const { db } = ctx
  const r = db.get<Row>('SELECT * FROM ideas WHERE id = ? AND user_id = ?', id, userId)
  if (!r) throw notFound('That idea')
  const state = stateOf(db, userId, r)
  if (state === 'acted') throw refused('idea_acted', 'Something was already signed for this idea. To change it, revise the idea, or pause or revoke what was signed.')
  if (state === 'declined' || state === 'no-action') throw refused('idea_closed', 'This idea is closed. Revise it to look again.')
  const choice = String(body.choice ?? '') as ChoiceId
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 280) : ''
  const inv = parse<Investigation>(r.investigation_json, {} as Investigation)
  const offered = inv.choices.find((c) => c.id === choice)
  if (!offered) throw bad('Choose one of the decisions offered.')
  if (!offered.allowed) throw refused('choice_not_offered', offered.why)
  const withdrawEarlier = (): void => {
    if (r.approval_id) cancelApproval(db, userId, String(r.approval_id), now)
    if (r.program_id) { const p = db.get<{ state: string; live_version: number | null }>('SELECT state, live_version FROM programs WHERE id = ? AND user_id = ?', String(r.program_id), userId); if (p && p.state === 'draft' && p.live_version === null) discardDraft(ctx, userId, String(r.program_id)) }
  }
  const words: Record<ChoiceId, string> = { order: 'Go ahead, once', instruction: 'Go ahead, every month', 'alt:liquid': 'The liquid fund instead', 'alt:spread': 'Spread over six months', reject: 'Not this', nothing: 'Do nothing for now' }
  if (choice === 'reject' || choice === 'nothing') {
    db.tx(() => {
      withdrawEarlier()
      db.run('UPDATE ideas SET state = ?, choice = ?, reason = ?, decided_at = ?, approval_id = NULL, program_id = NULL, updated_at = ? WHERE id = ?', choice === 'reject' ? 'declined' : 'no-action', choice, reason || null, now, now, id)
      event(db, id, userId, now, 'decided', `${words[choice]}${reason ? `: "${reason}"` : '.'}`)
    })
    return { kind: 'closed', ideaId: id }
  }

  // going ahead: the hard rules again, on the books as they are now
  const inst = instrument(db, choice === 'alt:liquid' ? LIQUID : inv.plan.instrumentId)
  if (!inst) throw refused('idea_stale', 'That investment is no longer listed. Revise the idea.')
  const monthlyPart = choice === 'alt:spread' ? Math.floor(inv.plan.amount / 6 / 100) * 100 : inv.plan.amount
  const now1 = liquidity(db, userId, now)
  const o = overview(db, ctx.market, userId, now)
  const lim = limitFor(db, inst)
  const first = choice === 'order' || choice === 'alt:liquid' ? inv.plan.amount : monthlyPart
  if (first > now1.free) throw refused('not_affordable', `Free money has changed: this needs ${inr(first)} and ${inr(now1.free)} is free now. Revise the idea.`)
  if (o.worst.gHat - Math.round(first * lim.fall) < o.worst.line) throw refused('below_floor', `Your worst case has changed: this would now take it below your floor of ${inr(o.worst.line)}. Revise the idea.`)
  if (choice === 'instruction' && inv.plan.amount > Math.max(0, freeCashFlow(ctx, userId, now).free)) throw refused('not_affordable', 'What is left over each month has changed and no longer covers this. Revise the idea.')

  if (choice === 'order' || choice === 'alt:liquid') {
    const raw: Row = { kind: 'order', instrumentId: inst.id, side: 'buy', amount: inv.plan.amount, ...(inst.kind === 'mutual_fund' ? {} : { type: 'market', maxSlippageBps: 100 }) }
    // the new request first: if the order cannot be prepared now, what was prepared before is left as it was
    const preview = await previewAction(ctx, userId, raw) as unknown as Row & { approvalId: string }
    withdrawEarlier()
    db.tx(() => {
      db.run(`UPDATE ideas SET state = 'awaiting-signature', choice = ?, reason = ?, decided_at = ?, approval_id = ?, program_id = NULL, updated_at = ? WHERE id = ?`, choice, reason || null, now, preview.approvalId, now, id)
      event(db, id, userId, now, 'decided', `${words[choice]}: the exact order was prepared for your passkey${reason ? `; "${reason}"` : ''}.`)
    })
    return { kind: 'order', ideaId: id, preview }
  }
  // an instruction: 12 monthly purchases of the idea, or six of a sixth (spread)
  const profile = getProfile(db, userId)
  const d = saveDraft(ctx, userId, { kind: 'invest', params: investParams(inst.id, monthlyPart, profile), authority: authorityFor(choice === 'alt:spread' ? 6 : 12, now), origin: `idea:${id}` })
  if (d.draft.analysis.refusals.length) { discardDraft(ctx, userId, d.programId); throw refused('instruction_refused', d.draft.analysis.refusals.join(' ')) }
  withdrawEarlier()
  db.tx(() => {
    db.run(`UPDATE ideas SET state = 'awaiting-signature', choice = ?, reason = ?, decided_at = ?, program_id = ?, approval_id = NULL, updated_at = ? WHERE id = ?`, choice, reason || null, now, d.programId, now, id)
    event(db, id, userId, now, 'decided', `${words[choice]}: an instruction was drafted for your passkey (${d.draft.title})${reason ? `; "${reason}"` : ''}.`)
  })
  return { kind: 'instruction', ideaId: id, programId: d.programId }
}
