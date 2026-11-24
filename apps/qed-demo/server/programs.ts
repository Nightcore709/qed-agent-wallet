/**
 * Programs: versioned standing instructions with a signed authority.
 *
 * A program version is immutable. It consists of the parameters, the authority envelope and an authorisation
 * document: the exact statements the owner is shown and signs. Amending a program creates a new version that
 * needs a fresh approval; the old version stays on record as superseded. Every kind implements the same contract:
 * validate, describe consequences from recorded data, state what is authorised, and plan the actions of one run
 * deterministically. No model output is needed, or used, to run a program.
 */
import { registerPaperMandate } from './bank-mandates.ts'
import { signedOf } from './channel-terms.ts'
import { consumeApproval, createApproval } from './approvals.ts'
import { AppError, audit, bad, type Db, emit, ist, addDays, j, newId, notFound, parse, refused, whenIst } from './core.ts'
import { householdHome, requireRupeeHome } from './home-currency.ts'
import { getProfile, householdModel, monthlyRuns, TZ_VERSION, zoneOf } from './household.ts'
import { available, balance } from './ledger.ts'
import { dateText, hardshipText, limitAdvice, liquidity } from './liquidity.ts'
import { freshness } from './market.ts'
import { crossCheck } from './policy.ts'
import { exchangeCostsStatus, type Instrument, instrument, term, isCalibrated } from './registry.ts'
import { sha256hex } from './receipts.ts'
import { describeSchedule, firstDue, nextDue, scheduleZone } from './schedule.ts'
import { DEFAULT_ZONE, isZone, whenIn } from '../shared/zone.ts'
import type { Authority, Ctx, OrderParams, PaymentParams, Pillar, PlannedAction, RunMode, Schedule } from './types.ts'
import { smallestMarketBuy } from './venues.ts'
import { commitments, exitPrice, holdings, limitFor, worstCase } from './valuation.ts'
import { payeeWarning } from './lookalike.ts'
import { addedWhen, holdFor, waitWords } from './new-payee.ts'
import { passwordWork, recordPrepared } from './prepared.ts'
import { reviewedLine } from './adviser.ts'
import { analyseGoal, goalAuthority, goalDoc, type GoalParams, goalTitle, parseGoal, planGoal } from './goals.ts'
import { classOf, CLASS_NAME, treatment } from './tax.ts'
import { isSecurity, securityCosts } from './securities.ts'
import { checkerB, exactCheck, type Plan, PLAN_KEYS, ZERO_PLAN } from '../shared/kernel/index.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { floorToStep, fraction, mulDiv, notional, parseDec, parsePrice, priceToNumber, quantityFor, toNum } from '../shared/fixed.ts'
import { homeMoney, homeMoneyExact } from '../shared/home-money.ts'
import { canonical } from '../shared/sha256.ts'

export type ProgramKind = 'invest' | 'sweep' | 'swp' | 'paydown' | 'bills' | 'exit' | 'floor' | 'rebalance' | 'split' | 'goal'
export type Tier = 'certified' | 'bounded' | 'each-time'

export interface Figure { label: string; value: string; basis: 'recorded' | 'live' | 'estimate' | 'modelled' | 'historical' | 'limit'; note?: string }
export interface DataInput { instrumentId: string; name: string; priceType: string; price: string; provider: string; sourceTs: number | null; recvTs: number; ageMs: number; stale: boolean }
export interface Analysis {
  tier: Tier
  tierReason: string
  headline: string
  figures: Figure[]
  consequences: string[]
  warnings: string[]
  /** Reasons this version cannot be approved as it stands. */
  refusals: string[]
  inputs: DataInput[]
  worst?: { before: number; after: number; line: number; illustrative: boolean; valid: boolean }
  certificate?: Record<string, unknown>
  preview?: Record<string, unknown>
  computedAt: number
}

/** The authorisation document. Its canonical JSON is what the owner's approval is bound to. */
export interface AuthDoc {
  /** 1: clock times mean India Standard Time (every document signed before the household's zone was recorded). 2: states `timeZone`. */
  v: 1 | 2
  /** Format 2: the IANA zone the document's clock times are read in, and the zone rules' version that worked them out. */
  timeZone?: string
  tzVersion?: string
  kind: ProgramKind
  title: string
  may: string[]
  limits: string[]
  /** The most this authority can ever move, computed from its limits and its end date. */
  ceiling: string
  /** The same ceiling in paise, or null for an instruction that only sells. */
  ceilingPaise: number | null
  /** What the limits do not bound, said plainly. */
  notLimited: string[]
  conditions: string[]
  never: string[]
  mode: string
  ends: string
  stop: string
  consequences: string[]
  basis: string[]
  params: unknown
  authority: Authority
}

const DAY = 86_400_000
/** A sum in a sentence, through the one formatter (shared/money.ts): whole rupees or to the paisa; with 2, always to the paisa. */
export const amountText = (paise: number | bigint, dp: 0 | 2 = 0): string => (dp === 0 ? homeMoneyExact(paise) : homeMoney(Number(paise), undefined, { paise: true }))
const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`
/** An estimate is shown to the rupee; paise would claim a precision it does not have. */
const whole = (paise: number): number => Math.round(paise / 100) * 100
const runsText = (n: number): string => { const r = n < 10 ? Math.round(n * 10) / 10 : Math.round(n); return `${r.toLocaleString('en-IN')} run${r === 1 ? '' : 's'}` }

// ------------------------------------------------------------------------------------------------ validation helpers

type Raw = Record<string, unknown>
class Fields {
  errors: Record<string, string> = {}
  err(field: string, msg: string): void { if (!this.errors[field]) this.errors[field] = msg }
  paise(raw: Raw, field: string, opts: { min?: number; max?: number; label?: string } = {}): number {
    const v = raw[field]
    const label = opts.label ?? 'The amount'
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) { this.err(field, `${label} must be a whole number of paise.`); return 0 }
    if (v < (opts.min ?? 1)) this.err(field, `${label} must be at least ${amountText(opts.min ?? 1, 2)}.`)
    if (v > (opts.max ?? 100_000_000_000)) this.err(field, `${label} is too large.`)
    return v
  }
  int(raw: Raw, field: string, min: number, max: number, label: string): number {
    const v = raw[field]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) { this.err(field, `${label} must be a whole number from ${min} to ${max}.`); return min }
    return v
  }
  instrument(db: Db, raw: Raw, field: string, kinds: string[], categories?: string[]): Instrument | null {
    const id = raw[field]
    const inst = typeof id === 'string' ? instrument(db, id) : undefined
    if (!inst || !inst.tradable) { this.err(field, 'Choose something QED can trade.'); return null }
    if (!kinds.includes(inst.kind)) { this.err(field, 'That instrument cannot be used for this kind of instruction.'); return null }
    if (categories && inst.kind === 'mutual_fund' && !categories.includes(inst.meta.category ?? '')) { this.err(field, 'Choose a liquid, overnight or arbitrage fund for parked cash.'); return null }
    return inst
  }
  schedule(raw: Raw, field: string, now: number): Schedule {
    const s = raw[field] as Raw | undefined
    const hm = (v: unknown): string | null => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null)
    // The zone a stored instruction states (format 2) is kept; buildDraft sets a new one's from the household.
    const zone: { zone?: string } = s && isZone(s.zone) ? { zone: s.zone } : {}
    if (s && typeof s === 'object') {
      if (s.type === 'every' && typeof s.minutes === 'number' && Number.isInteger(s.minutes) && s.minutes >= 1 && s.minutes <= 7 * 24 * 60) return { type: 'every', minutes: s.minutes }
      if (s.type === 'daily' && hm(s.at)) return { type: 'daily', at: hm(s.at)!, ...zone }
      if (s.type === 'weekly' && hm(s.at) && typeof s.weekday === 'number' && Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6) return { type: 'weekly', weekday: s.weekday, at: hm(s.at)!, ...zone }
      if (s.type === 'monthly' && hm(s.at) && typeof s.day === 'number' && Number.isInteger(s.day) && s.day >= 1 && s.day <= 28) return { type: 'monthly', day: s.day, at: hm(s.at)!, ...zone }
      if (s.type === 'once' && typeof s.at === 'number' && s.at > now - 60_000 && s.at < now + 400 * DAY) return { type: 'once', at: s.at, ...zone }
    }
    this.err(field, 'Choose when it runs: every so many minutes, daily, weekly, monthly on a day from 1 to 28, or once.')
    return { type: 'daily', at: '10:00' }
  }
  done(what = 'Some values need attention.'): void { if (Object.keys(this.errors).length) throw bad(what, this.errors) }
}

export function parseAuthority(raw: unknown, now: number, f: Fields, defaults: Partial<Authority> = {}): Authority {
  const r = { ...defaults, ...((raw ?? {}) as Raw) } as Raw
  const maxPerRun = f.paise(r, 'maxPerRun', { label: 'The most per run' })
  const maxPerMonth = f.paise(r, 'maxPerMonth', { label: 'The most per month' })
  if (maxPerMonth < maxPerRun) f.err('maxPerMonth', 'The monthly limit cannot be smaller than the limit for one run.')
  let maxPerDay: number | null = null
  if (r.maxPerDay !== null && r.maxPerDay !== undefined) { maxPerDay = f.paise(r, 'maxPerDay', { label: 'The most per day' }); if (maxPerDay < maxPerRun) f.err('maxPerDay', 'The daily limit cannot be smaller than the limit for one run.') }
  const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : 0
  if (!(expiresAt > now + 60_000)) f.err('expiresAt', 'Choose an end date in the future. Authority always ends.')
  if (expiresAt > now + 400 * DAY) f.err('expiresAt', 'Authority can last at most 400 days; renew it after that.')
  const runMode = (['auto', 'approve', 'notify'] as RunMode[]).includes(r.runMode as RunMode) ? (r.runMode as RunMode) : (f.err('runMode', 'Choose how it runs: on its own, after telling you, or only when you approve.'), 'approve' as RunMode)
  const noticeSec = runMode === 'notify' ? f.int(r, 'noticeSec', 30, 7 * 86_400, 'The notice period in seconds') : 0
  const maxSlippageBps = r.maxSlippageBps === undefined ? 100 : f.int(r, 'maxSlippageBps', 1, 500, 'The price tolerance in basis points')
  let maxRuns: number | null = null
  if (r.maxRuns !== null && r.maxRuns !== undefined) maxRuns = f.int(r, 'maxRuns', 1, 100_000, 'The number of runs')
  return { maxPerRun, maxPerDay, maxPerMonth, expiresAt, runMode, noticeSec, maxSlippageBps, maxRuns }
}

// ------------------------------------------------------------------------------------------------ shared analysis pieces

function inputFor(ctx: Ctx, inst: Instrument, now: number, type?: 'bid' | 'ask' | 'nav'): DataInput | null {
  const pt = type ?? (inst.kind === 'mutual_fund' ? 'nav' : 'bid')
  const t = ctx.market.get(inst.id, pt)
  if (!t) return null
  const f = freshness(t, inst, now)
  return { instrumentId: inst.id, name: inst.name, priceType: pt, price: t.price, provider: t.provider, sourceTs: t.sourceTs, recvTs: t.recvTs, ageMs: Number.isFinite(f.ageMs) ? Math.round(f.ageMs) : -1, stale: f.stale }
}
function basisLine(i: DataInput): string {
  const src = i.sourceTs === null ? 'the source gives no timestamp' : i.priceType === 'nav' ? `NAV date ${new Date(i.sourceTs + 19_800_000).toISOString().slice(0, 10)}` : `source time ${new Date(i.sourceTs).toISOString()}`
  return `${i.name}: ${i.priceType} ${i.price} from ${i.provider}; ${src}; received ${new Date(i.recvTs).toISOString()}.`
}
function modeSentence(a: Authority): string {
  if (a.runMode === 'auto') return 'It runs on its own, without asking you each time.'
  if (a.runMode === 'approve') return 'It asks you before every run and does nothing until you approve. A request you do not answer within 24 hours lapses.'
  const n = a.noticeSec
  const span = n % 86_400 === 0 ? `${n / 86_400} day${n === 86_400 ? '' : 's'}` : n % 3600 === 0 ? `${n / 3600} hour${n === 3600 ? '' : 's'}` : n % 60 === 0 ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${n} seconds`
  return `It tells you first, then runs ${span} later unless you object.`
}
const limitLines = (a: Authority): string[] => [
  `At most ${amountText(a.maxPerRun)} in one run.`,
  ...(a.maxPerDay !== null ? [`At most ${amountText(a.maxPerDay)} in one day.`] : []),
  `At most ${amountText(a.maxPerMonth)} in one calendar month.`,
  ...(a.maxRuns !== null ? [`At most ${a.maxRuns} run${a.maxRuns === 1 ? '' : 's'} in total.`] : []),
]
/** The most the authority can move before it ends: the tightest of its monthly, daily and run-count limits. */
export function ceilingPaise(a: Authority, now: number): number {
  const from = ist(now), to = ist(a.expiresAt)
  const months = (to.y - from.y) * 12 + (to.m - from.m) + 1
  let total = months * a.maxPerMonth
  if (a.maxPerDay !== null) total = Math.min(total, Math.ceil((a.expiresAt - now) / DAY + 1) * a.maxPerDay)
  if (a.maxRuns !== null) total = Math.min(total, a.maxRuns * a.maxPerRun)
  return total
}
const STOP = 'You can pause or revoke this at any time. Revoking takes effect at once for anything not yet sent to a venue or a rail.'
/** A protective sale that asks first (the default for a hand-written instruction since R12, gap 14) can come too late. */
const ASKS_BEFORE_SELLING = 'It asks you before it sells. A request you do not answer within 24 hours lapses and nothing is sold, and the price may have fallen further meanwhile; choose "On its own" to let it sell without asking.'
const COMMON_NEVER = ['Act after the end date, or while paused or revoked.', 'Exceed any limit above, whatever the reason.', 'Move money to anyone or anything not named here.']

export function freeCashFlow(ctx: Ctx, userId: string, now: number, self = ''): { income: number; counted: number; emis: number; free: number } {
  const hm = householdModel(ctx.db, userId, now, self)
  const p = getProfile(ctx.db, userId)
  const counted = hm.counted.reduce((s, c) => s + c.monthly, 0)
  const emis = p.personalLoanEmi + p.homeLoanEmi
  return { income: p.income, counted, emis, free: p.income - counted - emis }
}

/** Annualised change of a fund's NAV over the trailing `days`, from published NAVs on record. Historical, never a forecast. */
export function trailingReturn(db: Db, instrumentId: string, days: number): { annualised: number; from: string; to: string; observations: number } | null {
  const last = db.get<{ value_date: string; value: string }>('SELECT value_date, value FROM daily_values WHERE instrument_id = ? ORDER BY value_date DESC LIMIT 1', instrumentId)
  if (!last) return null
  const first = db.get<{ value_date: string; value: string }>('SELECT value_date, value FROM daily_values WHERE instrument_id = ? AND value_date <= ? ORDER BY value_date DESC LIMIT 1', instrumentId, addDays(last.value_date, -days))
  if (!first) return null
  const span = (Date.parse(last.value_date) - Date.parse(first.value_date)) / DAY
  if (span < days * 0.8) return null
  const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM daily_values WHERE instrument_id = ? AND value_date BETWEEN ? AND ?', instrumentId, first.value_date, last.value_date)!.n
  const growth = Number(last.value) / Number(first.value)
  return { annualised: Math.pow(growth, 365 / span) - 1, from: first.value_date, to: last.value_date, observations: n }
}

// ------------------------------------------------------------------------------------------------ kinds

export { describeSchedule, firstDue, nextDue }

export interface PlanResult { actions: PlannedAction[]; skip?: string; memo?: Record<string, unknown> }
export interface ProgramRow { id: string; user_id: string; kind: ProgramKind; pillar: Pillar; title: string; state: string; live_version: number | null; next_due_at: number | null; memo: Record<string, unknown>; created_at: number }
export interface TriggerHit { occurrence: string; trigger: Record<string, unknown>; memo?: Record<string, unknown> }

export interface KindSpec<P = Raw> {
  kind: ProgramKind
  pillar: Pillar
  label: string
  blurb: string
  /** `self` is the instruction being amended, when there is one (a goal reads what is already set aside for it). */
  parse(ctx: Ctx, userId: string, raw: Raw, now: number, self?: string): P
  title(ctx: Ctx, p: P): string
  schedule(p: P): Schedule | null
  /** `self` is the instruction being amended, when there is one, so that its own live limits are not counted twice. */
  suggestAuthority(ctx: Ctx, userId: string, p: P, now: number, self?: string): Partial<Authority>
  analyse(ctx: Ctx, userId: string, p: P, a: Authority, now: number, self?: string): Analysis
  doc(ctx: Ctx, userId: string, p: P, a: Authority, an: Analysis): Pick<AuthDoc, 'may' | 'conditions' | 'never'> & { limits?: string[] }
  /** Event- or market-driven kinds: which occurrences are due now. */
  due?(ctx: Ctx, prog: ProgramRow, p: P, version: number, now: number): TriggerHit[]
  plan(ctx: Ctx, prog: ProgramRow, p: P, a: Authority, trigger: Record<string, unknown>, now: number): PlanResult
  /** A kind whose bound follows from its parameters (a goal): the limits and end are set from them, whatever was asked. */
  bindAuthority?(p: P, a: Authority, now: number): Authority
  /** True when a finished run completes the program. */
  oneShot?: boolean
}

const venueOf = (inst: Instrument): string => inst.venue
const buyOrder = (inst: Instrument, amount: number | bigint, a: Authority, purpose: string): PlannedAction => ({
  kind: 'order', venue: venueOf(inst), summary: `Buy ${amountText(amount)} of ${inst.name}`,
  params: { instrumentId: inst.id, side: 'buy', type: inst.kind === 'mutual_fund' ? 'nav' : 'market', amount: String(amount), ...(inst.kind === 'mutual_fund' ? {} : { maxSlippageBps: a.maxSlippageBps }), purpose } satisfies OrderParams,
})
const sellOrder = (inst: Instrument, qty: bigint, a: Authority, purpose: string, protective: boolean): PlannedAction => ({
  kind: 'order', venue: venueOf(inst), summary: `Sell ${(Number(qty) / 10 ** inst.baseScale).toString()} ${inst.kind === 'mutual_fund' ? 'units of ' + inst.name : inst.base_asset}`,
  params: { instrumentId: inst.id, side: 'sell', type: inst.kind === 'mutual_fund' ? 'nav' : 'market', qty: qty.toString(), ...(inst.kind === 'mutual_fund' ? {} : { maxSlippageBps: a.maxSlippageBps }), purpose, protective } satisfies OrderParams,
})

function costOfBuy(ctx: Ctx, inst: Instrument, amount: number): { text: string; figure: Figure } {
  if (inst.kind === 'mutual_fund') {
    const stamp = Number(fraction(BigInt(amount), String(term(ctx.db, 'mf.stamp')?.value.rate ?? '0.00005'), 'half'))
    return { text: `Stamp duty of about ${amountText(stamp, 2)} is taken from each purchase.`, figure: { label: 'Cost per purchase', value: amountText(stamp, 2), basis: 'estimate', note: 'Stamp duty 0.005%; the fund\'s running cost is inside its NAV' } }
  }
  if (isSecurity(inst)) {
    const c = securityCosts(ctx.db, inst, 'buy', BigInt(amount))
    const total = Number(c.fee + c.tax)
    const status = inst.venue === 'paper-gsec' ? (term(ctx.db, 'rule.gsec.hours')?.status ?? 'unverified') : exchangeCostsStatus(ctx.db)
    return {
      text: inst.venue === 'paper-gsec' ? 'There is no brokerage or tax on a purchase; the cost is the gap between the buying and selling prices.' : `Brokerage, exchange charges, GST and stamp duty come to about ${amountText(total, 2)} on each purchase.`,
      figure: { label: 'Cost per purchase', value: inst.venue === 'paper-gsec' ? 'The price gap only' : amountText(total, 2), basis: 'estimate', note: `Rates ${status}: see the terms; the prices are synthetic` },
    }
  }
  const rate = String(term(ctx.db, 'fee.paper-crypto.taker')?.value.rate ?? '0.005')
  const fee = Number(fraction(BigInt(amount), rate, 'up'))
  const bid = ctx.market.get(inst.id, 'bid'), ask = ctx.market.get(inst.id, 'ask')
  const spread = bid && ask ? (Number(ask.price) - Number(bid.price)) / Number(ask.price) : null
  return {
    text: `The venue fee is about ${amountText(fee, 2)} per purchase${spread !== null ? `, and the gap between buying and selling prices is ${pct(spread, 2)} right now` : ''}.`,
    figure: { label: 'Cost per purchase', value: `${amountText(fee, 2)}${spread !== null ? ` + ${pct(spread, 2)} spread` : ''}`, basis: 'estimate', note: `Taker fee ${pct(Number(rate), 2)} (${term(ctx.db, 'fee.paper-crypto.taker')?.status ?? 'modelled'}); spread from the current book` },
  }
}

function worstAfter(ctx: Ctx, userId: string, now: number, deltaPaise: number): NonNullable<Analysis['worst']> {
  const w = worstCase(ctx.db, ctx.market, userId, now)
  return { before: w.gHat, after: w.gHat + deltaPaise, line: w.line, illustrative: w.illustrative, valid: w.valid }
}

// ---- invest
interface InvestP { instrumentId: string; amount: number; schedule: Schedule }
const invest: KindSpec<InvestP> = {
  kind: 'invest', pillar: 'grow', label: 'Invest regularly', blurb: 'Buy a fixed rupee amount of one fund or asset on a schedule.',
  parse(ctx, _u, raw, now) {
    const f = new Fields()
    const inst = f.instrument(ctx.db, raw, 'instrumentId', ['mutual_fund', 'crypto_spot', 'etf', 'equity', 'tbill', 'gsec'])
    const amount = f.paise(raw, 'amount', { min: 10_000, max: 100_000_000 })
    const schedule = f.schedule(raw, 'schedule', now)
    f.done()
    return { instrumentId: inst!.id, amount, schedule }
  },
  title: (ctx, p) => `Invest ${amountText(p.amount)} in ${instrument(ctx.db, p.instrumentId)!.name.replace(/ \(.*\)$/, '')}`,
  schedule: (p) => p.schedule,
  // The default monthly limit is the smallest of: what the schedule asks for; what the recorded household has to
  // spare each month; and the largest limit under which, even if every run takes its full amount, the bank still
  // holds what is due on the day it is due (liquidity.ts). It is never less than one run. A schedule of a small
  // amount every few minutes would otherwise default to a limit of lakhs a month that nobody chose.
  suggestAuthority: (ctx, userId, p, now, self) => {
    const need = Math.ceil(monthlyRuns(p.schedule) * p.amount)
    const spare = Math.floor(Math.max(0, freeCashFlow(ctx, userId, now, self).free) / 100_000) * 100_000
    const base = { maxPerRun: p.amount, maxPerDay: null, expiresAt: now + 90 * DAY, runMode: 'approve' as const, noticeSec: 0, maxSlippageBps: 100, maxRuns: null }
    const safe = limitAdvice(ctx.db, userId, now, { ...base, maxPerMonth: p.amount }, p.schedule, self).largest
    return { ...base, maxPerMonth: Math.max(p.amount, Math.min(need, spare, safe)) }
  },
  analyse(ctx, userId, p, a, now, self) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const input = inputFor(ctx, inst, now, inst.kind === 'mutual_fund' ? 'nav' : 'ask')
    const lim = limitFor(ctx.db, inst)
    const perMonth = Math.round(monthlyRuns(p.schedule) * p.amount)
    // What can leave in a month is what the schedule asks for, but never more than the monthly limit: runs beyond it are refused.
    const leaves = Math.min(perMonth, a.maxPerMonth)
    const cash = freeCashFlow(ctx, userId, now, self)
    const atRisk = Math.round(p.amount * lim.fall)
    const worst = worstAfter(ctx, userId, now, -atRisk)
    const cost = costOfBuy(ctx, inst, p.amount)
    const warnings: string[] = [], refusals: string[] = []
    if (!input) warnings.push(`No price has been received for ${inst.name} yet.`)
    else if (input.stale) warnings.push(`The latest price for ${inst.name} is stale; a run is refused while it stays stale.`)
    if (perMonth > a.maxPerMonth) warnings.push(`The schedule needs about ${amountText(whole(perMonth))} a month but the monthly limit is ${amountText(a.maxPerMonth)}: later runs in a month will be refused.`)
    if (p.amount > a.maxPerRun) refusals.push(`Each run needs ${amountText(p.amount)} but the limit for one run is ${amountText(a.maxPerRun)}.`)
    if (leaves > cash.free) warnings.push(`${leaves < perMonth ? `This can take up to ${amountText(leaves)}` : `This needs about ${amountText(whole(perMonth))}`} a month; after your recorded spending, bills and instalments you have about ${amountText(whole(cash.free))} a month to spare.`)
    if (worst.after < worst.line) warnings.push(`Today a run would be refused: it would take your worst case to ${amountText(worst.after)}, below your floor of ${amountText(worst.line)}.`)
    // Liquidity: if every run took its full amount under this monthly limit, would the bank still hold what is due on the day?
    const liq = liquidity(ctx.db, userId, now)
    const advice = limitAdvice(ctx.db, userId, now, a, p.schedule, self)
    const allowing = liq.assumptions.lateDays > 0 || liq.assumptions.lostSalaries > 0 ? `, allowing for ${hardshipText(liq.assumptions)}` : ''
    if (liq.available - p.amount < liq.need) warnings.push(`Today a run would be refused: ${amountText(whole(liq.need))} must stay in your bank account for what is due${liq.binding ? ` by ${dateText(liq.binding.date)}` : ''}${allowing}, and you have ${amountText(whole(liq.available))} there.`)
    else if (!advice.holds) warnings.push(`If every run takes its full amount, your bank account could not meet what falls due on ${dateText(advice.shortOn ?? liq.today)}${allowing}. Runs are refused before that happens. The largest monthly limit that what is due in the next ${liq.horizonDays} days can carry, on today's records, is ${amountText(advice.largest)}.`)
    if (inst.kind === 'crypto_spot') warnings.push('Gains on digital assets are taxed at 30% in India and losses cannot be set off; 1% is deducted at source when you sell.')
    // An amount the venue would reject every time must not be signable: it fills whole steps and has a smallest order.
    if (inst.kind === 'crypto_spot' && input && !input.stale) {
      const least = Math.ceil(Number(smallestMarketBuy(ctx.venues.crypto.rules(inst), inst, input.price)) / 100) * 100
      if (p.amount < least) refusals.push(`At the current price ${amountText(p.amount)} buys less than the venue's smallest order of ₹${inst.meta.minNotional ?? '100'}: it fills in steps of ${inst.meta.qtyStep ?? '0.00001'} ${inst.base_asset} and takes its fee from the amount. Each run needs at least ${amountText(least)}.`)
    }
    if (isSecurity(inst)) {
      if (input && !input.stale) {
        const step = Number(inst.meta.qtyStep ?? '1'), least = Math.ceil(Number(input.price) * step * 100)
        if (p.amount < least) refusals.push(`At the current price one lot (${step} unit${step === 1 ? '' : 's'}) costs about ${amountText(least)}, and costs come out of the amount: each run needs more than ${amountText(p.amount)}.`)
      }
      warnings.push(`A run on a day or at an hour the ${inst.venue === 'paper-gsec' ? 'government-securities desk' : 'exchange'} is closed (${inst.meta.hours?.open ?? '09:15'} to ${inst.meta.hours?.close ?? '15:30'} India time, weekdays) is refused, not delayed. The prices are synthetic, generated on this computer.`)
    }
    const first = firstDue(p.schedule, now)
    return {
      tier: 'bounded', tierReason: 'Bounded by your limits and your floor. It can lose money; it is not a certified no-regret move.',
      headline: `${amountText(p.amount)} into ${inst.name}, ${describeSchedule(p.schedule)}`,
      figures: [
        // The limit is exact. The schedule's own figure is an average over months of different lengths, so to the rupee.
        { label: 'Leaves your bank each month', value: amountText(leaves < perMonth ? leaves : whole(perMonth)), basis: 'recorded', note: leaves < perMonth
          ? `The schedule asks for ${amountText(whole(perMonth))} a month: ${describeSchedule(p.schedule)}, about ${runsText(monthlyRuns(p.schedule))}. The monthly limit stops it at ${amountText(a.maxPerMonth)}`
          : `${describeSchedule(p.schedule)}; about ${runsText(monthlyRuns(p.schedule))} a month` },
        { label: 'Spare each month before this', value: amountText(whole(cash.free)), basis: 'recorded', note: `Income ${amountText(cash.income)} less counted outflows ${amountText(whole(cash.counted))} and instalments ${amountText(cash.emis)}` },
        { label: 'Largest monthly limit that keeps every due payment covered', value: amountText(advice.largest), basis: 'recorded', note: `Even if every run takes its full amount${allowing}${advice.countedWith.length ? `; other instructions counted at their limits: ${advice.countedWith.join(', ')}` : ''}. Worked out on what is due in the next ${liq.horizonDays} days as recorded today, and again each time it is shown` },
        { label: 'At risk per run', value: amountText(atRisk), basis: 'limit', note: `${pct(lim.fall, 0)} limit on ${inst.name} (${isCalibrated(lim.status) ? 'calibrated' : 'illustrative, not calibrated'})` },
        cost.figure,
        ...(first ? [{ label: 'First run', value: whenIn(first, scheduleZone(p.schedule)), basis: 'recorded' as const }] : []),
      ],
      consequences: [
        `Each run takes ${amountText(p.amount)} from your bank account and buys ${inst.name} at ${inst.kind === 'mutual_fund' ? 'the NAV the fund house publishes for that day' : isSecurity(inst) ? 'the price the desk shows when it runs, in whole lots' : 'the best prices then on the order book'}.`,
        cost.text,
        `Each run lowers your worst case by about ${amountText(atRisk)}: what the holding could lose under its limit.`,
        inst.kind === 'mutual_fund' ? 'Units arrive when the NAV is published, usually that night. Until then the money shows as "awaiting units".' : isSecurity(inst) ? 'The units are yours at once on paper; a price older than 15 seconds is never used.' : 'A run is refused, not delayed, if the price is older than 15 seconds or disagrees with an independent price by more than 3%.',
      ],
      warnings, refusals, inputs: input ? [input] : [], worst, computedAt: now,
    }
  },
  doc(ctx, _u, p, a) {
    const inst = instrument(ctx.db, p.instrumentId)!
    return {
      may: [`Buy ${inst.name} with ${amountText(p.amount)} from your bank account, ${describeSchedule(p.schedule)}.`],
      conditions: [
        'Only if the money is free in your bank account at that moment: what is left must still cover everything due before your income is certain to arrive.',
        'Only if your worst case stays at or above your floor after the purchase.',
        ...(inst.kind === 'crypto_spot' ? [`Only at prices no more than ${(a.maxSlippageBps / 100).toFixed(2)}% above the best price on the book, with price data no older than 15 seconds that agrees with an independent source.`] : isSecurity(inst) ? ['Only while the market is open, at the price its desk shows, with a price no older than 15 seconds. The prices are synthetic.'] : ['At the NAV the fund house publishes for the applicable day; the price is not known when the order is placed.']),
      ],
      never: ['Buy anything else, or sell anything.', ...COMMON_NEVER],
    }
  },
  plan(ctx, _prog, p, a) {
    return { actions: [buyOrder(instrument(ctx.db, p.instrumentId)!, p.amount, a, 'invest')] }
  },
}

// ---- sweep
interface SweepP { instrumentId: string; keep: number; minMove: number; schedule: Schedule; topUp: boolean }
function sweepNow(ctx: Ctx, userId: string, p: SweepP, a: Authority, now: number): { free: number; reserved: number; surplus: number; move: number; redeemUnits: bigint; fundValue: number; need: number; needBy: string | null; room: number } {
  const inst = instrument(ctx.db, p.instrumentId)!
  const bank = Number(available(ctx.db, userId, 'bank'))
  const reserved = commitments(ctx.db, userId, now, 7 * DAY).filter((c) => c.certain).reduce((s, c) => s + c.amount, 0)
  const free = bank - reserved
  const surplus = free - p.keep
  // Money that something due will need before income is certain to arrive is never parked, whatever the buffer says.
  const liq = liquidity(ctx.db, userId, now)
  const room = liq.available - liq.need
  const within = Math.min(surplus, a.maxPerRun, room)
  const move = surplus >= p.minMove && within >= p.minMove ? within : 0
  const units = available(ctx.db, userId, `pos:${inst.id}`)
  const nav = ctx.market.get(inst.id, 'nav')
  const fundValue = nav ? Number(notional(units, inst.baseScale, parsePrice(nav.price), inst.quoteScale, 'down')) : 0
  let redeemUnits = 0n
  if (p.topUp && surplus <= -p.minMove && units > 0n && nav) {
    const need = quantityFor(BigInt(Math.min(-surplus, a.maxPerRun)), inst.quoteScale, parsePrice(nav.price), inst.baseScale, 'up')
    redeemUnits = need < units ? need : units
  }
  return { free, reserved, surplus, move, redeemUnits, fundValue, need: liq.need, needBy: liq.binding?.date ?? null, room }
}
const sweep: KindSpec<SweepP> = {
  kind: 'sweep', pillar: 'save', label: 'Park idle cash', blurb: 'Keep a buffer in the bank and move the rest into a liquid fund; bring it back when the buffer runs low.',
  parse(ctx, _u, raw, now) {
    const f = new Fields()
    const inst = f.instrument(ctx.db, raw, 'instrumentId', ['mutual_fund'], ['liquid', 'overnight', 'arbitrage'])
    const keep = f.paise(raw, 'keep', { min: 0, label: 'The buffer to keep' })
    const minMove = f.paise(raw, 'minMove', { min: 10_000, label: 'The smallest amount worth moving' })
    const schedule = raw.schedule ? f.schedule(raw, 'schedule', now) : { type: 'daily', at: '12:45' } as Schedule
    f.done()
    return { instrumentId: inst!.id, keep, minMove, schedule, topUp: raw.topUp !== false }
  },
  title: (ctx, p) => `Keep ${amountText(p.keep)} in the bank, park the rest in ${instrument(ctx.db, p.instrumentId)!.name.replace(/ \(.*\)$/, '')}`,
  schedule: (p) => p.schedule,
  // Its limits are sized to what is free after what must stay in the bank (R12 task comparison, gap 14), rounded up to
  // the thousand rupees, never below the smallest move it names; until then they were the whole bank, ₹8,67,000 a run
  // and ₹1,38,72,000 in all on a household with about ₹8.7 lakh. Like every hand-written instruction it asks first.
  suggestAuthority: (ctx, userId, p, now) => { const free = liquidity(ctx.db, userId, now).free; const cap = Math.max(p.minMove, Math.ceil(Math.max(0, free) / 100_000) * 100_000); return { maxPerRun: cap, maxPerMonth: cap, maxPerDay: null, expiresAt: now + 90 * DAY, runMode: 'approve', maxSlippageBps: 100, maxRuns: null } },
  analyse(ctx, userId, p, a, now) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const s = sweepNow(ctx, userId, p, a, now)
    const input = inputFor(ctx, inst, now, 'nav')
    const tr = trailingReturn(ctx.db, inst.id, 30)
    const sav = Number(term(ctx.db, 'rate.savings')?.value.apr ?? 0)
    const lim = limitFor(ctx.db, inst)
    const p0 = getProfile(ctx.db, userId)
    const daysOfSpending = p0.spending > 0 ? (p.keep / p0.spending) * 30 : Infinity
    const warnings: string[] = []
    if (!input) warnings.push(`No NAV has been received for ${inst.name} yet.`)
    if (daysOfSpending < 7) warnings.push(`The buffer covers about ${Math.max(0, Math.round(daysOfSpending))} days of your recorded spending. Money in the fund takes a business day to come back.`)
    if (inst.meta.category === 'liquid') warnings.push('A liquid fund charges a small exit load if you redeem within six days of buying.')
    return {
      tier: 'bounded', tierReason: 'Bounded by your limits. A liquid fund can fall slightly in stressed markets; this is not a certified no-regret move.',
      headline: s.move > 0 ? `Would move ${amountText(s.move)} into ${inst.name} at the next run` : s.redeemUnits > 0n ? 'Would bring money back from the fund at the next run' : 'Nothing to move right now',
      figures: [
        // not Home's "Free to use" (what nothing due needs); this is the bank less only the next 7 days' dues (the finish review)
        { label: 'In your bank, less the next 7 days\' dues', value: amountText(s.free), basis: 'recorded', note: `${amountText(s.reserved)} falls due in the next 7 days. This is not Home's "Free to use", which keeps back everything due until income is certain` },
        { label: 'Buffer you keep', value: amountText(p.keep), basis: 'recorded', note: Number.isFinite(daysOfSpending) ? `About ${Math.round(daysOfSpending)} days of your recorded spending` : undefined },
        { label: 'Must stay for what is due', value: amountText(whole(s.need)), basis: 'recorded', note: s.needBy ? `Everything due by ${dateText(s.needBy)}, before income is certain to arrive. Never parked, whatever the buffer` : 'Nothing is due before income arrives' },
        { label: 'Would move at the next run', value: s.move > 0 ? amountText(s.move) : s.redeemUnits > 0n ? 'Redeem to refill the buffer' : 'Nothing', basis: 'recorded', note: `Moves only when at least ${amountText(p.minMove)} is spare` },
        ...(tr ? [{ label: 'Fund, last 30 days, annualised', value: pct(tr.annualised, 2), basis: 'historical' as const, note: `From published NAVs ${tr.from} to ${tr.to}. Past change, not a forecast` }] : []),
        { label: 'Savings account rate assumed', value: pct(sav, 2), basis: 'modelled', note: 'A modelling range, not one bank\'s published rate' },
      ],
      consequences: [
        `${describeSchedule(p.schedule).replace(/^./, (c) => c.toUpperCase())}, QED compares what is free in your bank with the ${amountText(p.keep)} you keep.`,
        `If at least ${amountText(p.minMove)} is spare, it buys ${inst.name} with it. Purchases before ${inst.meta.cutoff} IST take the previous day's NAV.`,
        p.topUp ? `If the bank falls ${amountText(p.minMove)} or more below the buffer, it redeems enough units to refill it. The money arrives the next business day.` : 'It never redeems by itself; you bring money back by hand.',
        `Money in the fund counts in your worst case after a ${pct(lim.fall, 0)} fall (${isCalibrated(lim.status) ? 'calibrated' : 'illustrative'}).`,
      ],
      warnings, refusals: [], inputs: input ? [input] : [], worst: worstAfter(ctx, userId, now, -Math.round(s.move * lim.fall)), preview: { move: s.move, redeemUnits: s.redeemUnits.toString(), fundValue: s.fundValue }, computedAt: now,
    }
  },
  doc(ctx, _u, p) {
    const inst = instrument(ctx.db, p.instrumentId)!
    return {
      may: [`Buy ${inst.name} with bank money above your ${amountText(p.keep)} buffer, checked ${describeSchedule(p.schedule)}.`, ...(p.topUp ? [`Redeem units of ${inst.name} back to your bank account when the bank falls below the buffer.`] : [])],
      conditions: [`It moves money only when at least ${amountText(p.minMove)} is spare after everything due in the next 7 days.`, 'It never parks money that something already due will need before your income is certain to arrive.', 'Orders execute at the NAV the fund house publishes; redemptions pay out on the next business day.'],
      never: ['Buy or redeem any other fund.', 'Send money anywhere except between your bank account and this fund.', ...COMMON_NEVER.slice(0, 2)],
    }
  },
  plan(ctx, prog, p, a, _t, now) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const s = sweepNow(ctx, prog.user_id, p, a, now)
    if (s.move > 0) return { actions: [buyOrder(inst, s.move, a, 'sweep')] }
    if (s.redeemUnits > 0n) return { actions: [sellOrder(inst, s.redeemUnits, a, 'sweep-refill', false)] }
    if (s.surplus >= p.minMove) return { actions: [], skip: `Nothing to move: ${amountText(s.surplus)} is spare above your buffer, but ${amountText(whole(s.need))} must stay for what is due${s.needBy ? ` by ${dateText(s.needBy)}` : ''}, which leaves ${amountText(Math.max(0, whole(s.room)))} that could be parked (moves need ${amountText(p.minMove)} or more).` }
    return { actions: [], skip: `Nothing to move: ${amountText(s.free)} free against a ${amountText(p.keep)} buffer (moves need ${amountText(p.minMove)} or more).` }
  },
}

// ---- swp (a systematic withdrawal plan: a fixed rupee amount from one fund to the bank on a schedule; R13, audit G3)
interface SwpP { instrumentId: string; amount: number; schedule: Schedule }
/**
 * What one withdrawal of `units` would cost, worked out on the units it would redeem first-in, first-out: the exit load on
 * each slice by how long it has been held (the scheme's graded or flat load), and the tax on each slice's gain by the rule in
 * force (tax.ts, a model: a slab-rate class has no figure). All are estimates on today's NAV; the real NAV is a later one.
 */
export function swpEstimate(ctx: Ctx, userId: string, inst: Instrument, units: bigint, nav: string, now: number): { gross: number; exitLoad: number; gain: number; tax: number | null; taxNote: string; slices: number; loadNote: string } {
  const price = parsePrice(nav)
  const gross = Number(notional(units, inst.baseScale, price, inst.quoteScale, 'down'))
  const lots = ctx.db.all<{ opened_at: number; qty: string; remaining: string; cost: string }>(
    'SELECT opened_at, CAST(qty AS TEXT) qty, CAST(remaining AS TEXT) remaining, CAST(cost AS TEXT) cost FROM lots WHERE user_id = ? AND instrument_id = ? AND remaining > 0 ORDER BY opened_at, id', userId, inst.id)
  const lt = term(ctx.db, inst.meta.exitLoad ?? 'mf.exitload.none')
  const byDay = Array.isArray(lt?.value.byDay) ? (lt!.value.byDay as string[]) : null
  const flat = !byDay && typeof lt?.value.rate === 'string' ? Number(lt.value.rate) : 0
  let left = Number(units), exitLoad = 0, gain = 0, tax = 0, slab = false, slices = 0
  const cls = (at: number) => classOf(ctx.db, inst.id, at)
  for (const l of lots) {
    if (left <= 0) break
    const rem = Number(l.remaining), take = Math.min(rem, left)
    left -= take; slices++
    const value = gross * (take / Number(units)), cost = Number(l.cost) * (take / Number(l.qty))
    const days = Math.floor((now - l.opened_at) / 86_400_000)
    const rate = byDay ? (days >= 0 && days < byDay.length ? Number(byDay[days]) : 0) : flat
    exitLoad += value * rate
    const g = value - cost
    gain += g
    const tr = treatment(cls(l.opened_at), l.opened_at, now)
    if (tr.rateBp === null) slab = true
    else if (g > 0) tax += g * (tr.rateBp / 10_000)
  }
  const c = cls(lots[0]?.opened_at ?? now)
  const taxNote = lots.length === 0 ? 'No units are held yet, so there is no gain to tax.' : slab
    ? `Taxed at your slab rate (${CLASS_NAME[c]}); this app does not know your slab, so no figure is given. The gain on this withdrawal is about ${amountText(Math.max(0, Math.round(gain)))}.`
    : `${CLASS_NAME[c]}: modelled rate on the gain, before any yearly exemption. A model of the rules, not tax advice.`
  return { gross, exitLoad: Math.round(exitLoad), gain: Math.round(gain), tax: slab ? null : Math.round(tax), taxNote, slices, loadNote: lt ? `${lt.name} (${lt.status})` : 'none modelled' }
}
const swp: KindSpec<SwpP> = {
  kind: 'swp', pillar: 'grow', label: 'Withdraw regularly', blurb: 'Redeem a fixed rupee amount of one fund into your bank account each week or month, while the units last.',
  parse(ctx, _u, raw, now) {
    const f = new Fields()
    const inst = f.instrument(ctx.db, raw, 'instrumentId', ['mutual_fund'])
    const amount = f.paise(raw, 'amount', { min: 50_000, max: 100_000_000, label: 'The amount each time' })
    const schedule = f.schedule(raw, 'schedule', now)
    if (schedule.type !== 'weekly' && schedule.type !== 'monthly') f.err('schedule', 'A withdrawal plan runs weekly or monthly.')
    f.done()
    return { instrumentId: inst!.id, amount, schedule }
  },
  title: (ctx, p) => `Withdraw ${amountText(p.amount)} from ${instrument(ctx.db, p.instrumentId)!.name.replace(/ \(.*\)$/, '')} to your bank, ${describeSchedule(p.schedule)}`,
  schedule: (p) => p.schedule,
  // Each run redeems no more than the amount, so the limit for a run is the amount; the month's is what the schedule asks for.
  suggestAuthority: (_c, _u, p, now) => ({ maxPerRun: p.amount, maxPerMonth: Math.max(p.amount, Math.ceil(monthlyRuns(p.schedule)) * p.amount), maxPerDay: null, expiresAt: now + 365 * DAY, runMode: 'approve', maxSlippageBps: 100, maxRuns: null }),
  analyse(ctx, userId, p, a, now) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const input = inputFor(ctx, inst, now, 'nav')
    const nav = ctx.market.get(inst.id, 'nav')
    const held = available(ctx.db, userId, `pos:${inst.id}`)
    const value = nav ? Number(notional(held, inst.baseScale, parsePrice(nav.price), inst.quoteScale, 'down')) : 0
    const target = Math.min(p.amount, a.maxPerRun)
    const units = nav ? quantityFor(BigInt(target), inst.quoteScale, parsePrice(nav.price), inst.baseScale, 'down') : 0n
    const est = nav && held > 0n ? swpEstimate(ctx, userId, inst, units < held ? units : held, nav.price, now) : null
    const perMonth = Math.round(monthlyRuns(p.schedule) * p.amount)
    const runs = value > 0 ? Math.floor(value / p.amount) : 0
    const warnings: string[] = [], refusals: string[] = []
    if (!input) warnings.push(`No NAV has been received for ${inst.name} yet.`)
    if (held <= 0n) refusals.push(`You hold no units of ${inst.name} to withdraw from.`)
    else if (value < p.amount) warnings.push(`Your units are worth ${amountText(value)} at the latest NAV, less than one withdrawal of ${amountText(p.amount)}: the first run would sell everything and end it.`)
    if (p.amount > a.maxPerRun) refusals.push(`Each withdrawal is ${amountText(p.amount)} but the limit for one run is ${amountText(a.maxPerRun)}.`)
    if (perMonth > a.maxPerMonth) warnings.push(`The schedule asks for about ${amountText(whole(perMonth))} a month but the monthly limit is ${amountText(a.maxPerMonth)}: later runs in a month will be refused.`)
    warnings.push('A withdrawal sells units at the NAV published for its day. If the fund falls, the same rupees take more units and the units run out sooner. A fall in value is not a limit this plan can stop.')
    if (a.runMode === 'approve') warnings.push('It asks you before every run. A request you do not answer within 24 hours lapses, and that withdrawal does not happen.')
    const exitText = est ? (est.exitLoad > 0 ? `about ${amountText(est.exitLoad, 2)} on the next withdrawal` : 'none on the next withdrawal') : 'worked out once you hold units'
    return {
      tier: 'bounded', tierReason: 'It only sells units of one fund and pays the money into your own bank account. It is bounded by your limits; it does not protect the fund\'s value and it is not a certified move.',
      headline: `${amountText(p.amount)} from ${inst.name} to your bank, ${describeSchedule(p.schedule)}`,
      figures: [
        { label: 'Your units now', value: amountText(value), basis: 'recorded', note: nav ? `${(Number(held) / 10 ** inst.baseScale).toFixed(3)} units at NAV ${nav.price}` : 'No NAV yet' },
        { label: 'Each withdrawal', value: amountText(p.amount), basis: 'recorded', note: `About ${(Number(units) / 10 ** inst.baseScale).toFixed(3)} units at today's NAV, rounded down so the amount is never exceeded; the NAV that applies is a later one` },
        { label: 'Withdrawals the units cover', value: `${runs}`, basis: 'estimate', note: 'At today\'s NAV, with the fund neither rising nor falling; it changes with the NAV' },
        { label: 'Exit load', value: exitText, basis: 'modelled', note: est ? `${est.loadNote}; first-in, first-out on the units it would sell. Money out is the amount less this` : 'The scheme\'s own load applies to units held less than its period' },
        { label: 'Tax on the gain in a withdrawal', value: est ? (est.tax === null ? 'slab rate: no figure' : `about ${amountText(est.tax, 2)}`) : 'worked out once you hold units', basis: 'modelled', note: est ? est.taxNote : 'The rule that applies depends on the fund and how long each unit has been held' },
        { label: 'Money reaches your bank', value: `${inst.meta.payoutDays ?? 2} business day${(inst.meta.payoutDays ?? 2) === 1 ? '' : 's'} after the NAV date`, basis: 'modelled', note: 'The paper registrar pays as the scheme\'s rule says; a real fund house pays on its own schedule' },
        ...(p.schedule.type === 'monthly' || p.schedule.type === 'weekly' ? [{ label: 'First run', value: firstDue(p.schedule, now) ? whenIn(firstDue(p.schedule, now)!, scheduleZone(p.schedule)) : 'none', basis: 'recorded' as const }] : []),
      ],
      consequences: [
        `${describeSchedule(p.schedule).replace(/^./, (c) => c.toUpperCase())}, QED redeems the units of ${inst.name} that come to ${amountText(p.amount)} at the latest NAV.`,
        `The fund house prices the redemption at the NAV for its own day, so the money that arrives can differ a little from ${amountText(p.amount)}. The exit load is taken from it; tax on the gain is not, and is yours to pay later.`,
        'When the units run out it sells what is left and ends. It never buys.',
      ],
      warnings, refusals, inputs: input ? [input] : [], computedAt: now, preview: { held: held.toString(), units: units.toString(), value },
    }
  },
  doc(ctx, _u, p, a) {
    const inst = instrument(ctx.db, p.instrumentId)!
    return {
      may: [`Redeem units of ${inst.name} worth ${amountText(p.amount)} at the latest NAV, ${describeSchedule(p.schedule)}, and pay the money into your own bank account.`],
      limits: [`Each run redeems units worth at most ${amountText(Math.min(p.amount, a.maxPerRun))} at the NAV it sees; the NAV that applies is a later one.`],
      conditions: ['Only units you hold now; when they run out it sells what is left and ends.', 'The exit load the scheme charges is taken from each withdrawal, and tax on the gain is yours to pay: neither is a limit of this authority.', 'Orders execute at the NAV the fund house publishes for the applicable day.'],
      never: ['Buy anything.', 'Sell any other holding.', 'Send money anywhere except into your own bank account.', ...COMMON_NEVER.slice(0, 2)],
    }
  },
  plan(ctx, prog, p, a, _t, now) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const nav = ctx.market.get(inst.id, 'nav')
    if (!nav) return { actions: [], skip: `No NAV has been received for ${inst.name}, so nothing was withdrawn.` }
    const held = available(ctx.db, prog.user_id, `pos:${inst.id}`)
    if (held <= 0n) return { actions: [], skip: `You hold no units of ${inst.name}, so there is nothing to withdraw.` }
    const target = Math.min(p.amount, a.maxPerRun)
    let units = quantityFor(BigInt(target), inst.quoteScale, parsePrice(nav.price), inst.baseScale, 'down')
    const last = units >= held
    if (last) units = held
    if (units <= 0n) return { actions: [], skip: 'The amount buys less than a thousandth of a unit.' }
    const act = sellOrder(inst, units, a, 'swp', false)
    const est = swpEstimate(ctx, prog.user_id, inst, units, nav.price, now)
    return { actions: [{ ...act, summary: `Withdraw ${amountText(Math.min(target, est.gross))} from ${inst.name}${last ? ' (the last units)' : ''}`, params: { ...(act.params as OrderParams), swpPaise: String(target) } }], memo: { lastWithdrawal: { units: units.toString(), exitLoadEstimate: est.exitLoad, taxEstimate: est.tax, at: now } } }
  },
}

// ---- paydown (the certified no-regret kind)
interface PaydownP { plan: Plan }
export const MIN_CERTIFIED_MARGIN_RUPEES = 100
export function certify(ctx: Ctx, userId: string, plan: Plan, now: number) {
  const hm = householdModel(ctx.db, userId, now)
  const a = exactCheck(plan, hm.s0, hm.model)
  const b = checkerB(plan, hm.s0, hm.model)
  const agree = a.rejected === b.rejected && a.tierD === b.tierD
  const margin = a.minImprovement ?? null
  const thin = a.tierD && margin !== null && margin < MIN_CERTIFIED_MARGIN_RUPEES
  const certified = agree && a.tierD && b.tierD && !thin
  return { hm, a, b, agree, thin, certified, margin }
}
const paydown: KindSpec<PaydownP> = {
  kind: 'paydown', pillar: 'save', label: 'Pay down debt (no-regret check)', blurb: 'Move savings into repaying debt or a deposit, only if two independent checkers find it never leaves you worse off in the scenarios you approve.',
  parse(_ctx, _u, raw) {
    const f = new Fields()
    const rp = (raw.plan ?? {}) as Raw
    const plan = { ...ZERO_PLAN }
    for (const k of PLAN_KEYS) {
      const v = rp[k] ?? 0
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) f.err(`plan.${k}`, 'Enter a whole number of rupees, zero or more.')
      else plan[k] = v
    }
    if (PLAN_KEYS.every((k) => plan[k] === 0)) f.err('plan', 'Choose at least one amount.')
    f.done()
    return { plan }
  },
  title: (_c, p) => { const parts = PLAN_KEYS.filter((k) => p.plan[k] > 0).map((k) => `${amountText(p.plan[k] * 100)} to ${({ card: 'the card', personal_loan: 'the personal loan', home_loan: 'the home loan', fd: 'a fixed deposit', liquid_fund: 'a liquid fund' })[k]}`); return `Move ${parts.join(', ')}` },
  schedule: () => null,
  suggestAuthority: (_c, _u, p, now) => { const total = Math.ceil(PLAN_KEYS.reduce((s, k) => s + p.plan[k], 0) * 100 * 1.03); return { maxPerRun: total, maxPerMonth: total, maxPerDay: null, expiresAt: now + 2 * DAY, runMode: 'approve', maxSlippageBps: 100, maxRuns: 1 } },
  analyse(ctx, userId, p, _a, now) {
    const c = certify(ctx, userId, p.plan, now)
    const total = PLAN_KEYS.reduce((s, k) => s + p.plan[k], 0)
    const charges = Math.round(p.plan.personal_loan * c.hm.model.prepayPenalty.personal_loan * 100)
    const refusals: string[] = [], warnings: string[] = []
    if (c.a.rejected || c.b.rejected) refusals.push(...new Set([...c.a.reasons, ...c.b.reasons]))
    else if (!c.agree) refusals.push('The two checkers disagree about this plan, so QED will not certify it.')
    else if (!c.a.tierD) refusals.push('This is not a no-regret move: in at least one scenario you approved it leaves you worse off or deeper in a shortfall than doing nothing.')
    else if (c.thin) refusals.push(`It passes every scenario, but by less than ₹${MIN_CERTIFIED_MARGIN_RUPEES}. A margin that thin can fail between scenarios, so QED does not certify it.`)
    const owed = { card: Number(balance(ctx.db, userId, 'card')), personal_loan: Number(balance(ctx.db, userId, 'loan:personal')), home_loan: Number(balance(ctx.db, userId, 'loan:home')) }
    for (const k of ['card', 'personal_loan', 'home_loan'] as const) if (p.plan[k] * 100 > owed[k]) refusals.push(`You owe ${amountText(owed[k])} on ${k.replace('_', ' ')}; the plan repays more than that.`)
    if (total * 100 + charges > Number(available(ctx.db, userId, 'bank'))) refusals.push('The plan needs more than is available in your bank account.')
    const scen = c.a.outcomes ?? []
    const worstScenario = scen.length ? scen.reduce((m, o) => (o.improvement < m.improvement ? o : m)) : null
    const w = worstAfter(ctx, userId, now, -Math.round((p.plan.personal_loan + p.plan.home_loan) * 100) - charges)
    return {
      tier: c.certified ? 'certified' : 'each-time',
      tierReason: c.certified
        ? `Both checkers find that in all ${scen.length} scenarios you approved, this leaves you at least as well off after 12 months and never deeper in a shortfall than doing nothing.`
        : 'Not certified. QED will not run this as an instruction; you can still make these payments yourself.',
      headline: c.certified ? `Certified in ${scen.length} of ${scen.length} approved scenarios` : 'Not certified',
      figures: [
        { label: 'Leaves your bank now', value: amountText(total * 100 + charges), basis: 'recorded', note: charges ? `Includes a ${amountText(charges)} prepayment charge` : undefined },
        ...(c.a.minImprovement !== null && c.a.minImprovement !== undefined ? [{ label: 'Smallest gain after 12 months', value: amountText(Math.round(c.a.minImprovement * 100), 2), basis: 'modelled' as const, note: 'The worst of the approved scenarios, against doing nothing' }] : []),
        ...(c.a.maxDeepening !== null && c.a.maxDeepening !== undefined ? [{ label: 'Largest deepening of any shortfall', value: amountText(Math.round(Math.max(0, c.a.maxDeepening) * 100), 2), basis: 'modelled' as const, note: 'Zero means no month of any scenario is made worse' }] : []),
        { label: 'Checker A (X5 v3.1)', value: c.a.rejected ? 'Rejected the input' : c.a.tierD ? 'Passes' : 'Does not pass', basis: 'modelled' },
        { label: 'Checker B (X7, independent implementation)', value: c.b.rejected ? 'Rejected the input' : c.b.tierD ? 'Passes' : 'Does not pass', basis: 'modelled' },
      ],
      consequences: [
        ...PLAN_KEYS.filter((k) => p.plan[k] > 0).map((k) => ({ card: `Pays ${amountText(p.plan.card * 100)} off your credit card.`, personal_loan: `Prepays ${amountText(p.plan.personal_loan * 100)} of your personal loan, plus a ${pct(c.hm.model.prepayPenalty.personal_loan, 0)} charge.`, home_loan: `Prepays ${amountText(p.plan.home_loan * 100)} of your home loan.`, fd: `Opens a fixed deposit of ${amountText(p.plan.fd * 100)}. If broken early, the broken amount earns the savings rate less one point.`, liquid_fund: `Buys ${amountText(p.plan.liquid_fund * 100)} of a liquid fund.` })[k]),
        'The check covers only the scenarios listed: four interest-rate ranges at their ends and four hardships that start in month 1. Rates and hardships between or beyond them are not covered.',
      ],
      warnings, refusals, inputs: [], worst: w, computedAt: now,
      certificate: {
        certified: c.certified, agree: c.agree, thinMargin: c.thin, scenarios: scen.length, minImprovement: c.a.minImprovement ?? null, maxDeepening: c.a.maxDeepening ?? null,
        checkerA: { tierD: c.a.tierD, rejected: c.a.rejected, reasons: c.a.reasons }, checkerB: { tierD: c.b.tierD, rejected: c.b.rejected, minImprovement: c.b.minImprovement, maxDeepening: c.b.maxDeepening, reasons: c.b.reasons },
        household: { savings: c.hm.s0, debt: c.hm.model.debt, income: c.hm.model.income, expenses: c.hm.model.expenses, plEmi: c.hm.model.plEmi, hlEmi: c.hm.model.hlEmi, rateBoxes: c.hm.model.rateBoxes, shocks: c.hm.model.shocks.map((s) => s.label) },
        counted: c.hm.counted, notCounted: c.hm.notCounted,
        worstScenario: worstScenario ? { ...worstScenario.scenario, improvement: worstScenario.improvement, deepening: worstScenario.deepening } : null,
        outcomes: scen.map((o) => ({ s: o.scenario, i: Math.round(o.improvement * 100) / 100, d: Math.round(o.deepening * 100) / 100 })),
        scope: 'Finite check: 16 combinations of interest-rate range ends × 4 hardships. Checker B shares the written requirement and the deposit-break rule with Checker A (D-045, D-046).',
      },
    }
  },
  doc(_ctx, _u, p, _a, an) {
    const cert = an.certificate as { counted: { label: string; monthly: number }[]; scenarios: number } | undefined
    return {
      may: PLAN_KEYS.filter((k) => p.plan[k] > 0).map((k) => ({ card: `Pay ${amountText(p.plan.card * 100)} to your credit card.`, personal_loan: `Prepay ${amountText(p.plan.personal_loan * 100)} of your personal loan and pay its prepayment charge.`, home_loan: `Prepay ${amountText(p.plan.home_loan * 100)} of your home loan.`, fd: `Open a fixed deposit of ${amountText(p.plan.fd * 100)} with your bank.`, liquid_fund: `Buy ${amountText(p.plan.liquid_fund * 100)} of Nippon India Liquid Fund (Direct, Growth).` })[k]),
      conditions: [
        `Once, now. Certified in ${cert?.scenarios ?? 0} approved scenarios by two checkers that must agree.`,
        `The check counted these monthly outflows: ${(cert?.counted ?? []).map((c) => `${c.label} ${amountText(c.monthly)}`).join('; ')}; plus your loan instalments.`,
        'It is not certified for rates or hardships outside or between the approved scenarios.',
      ],
      never: ['Repeat. It runs once and then ends.', ...COMMON_NEVER.slice(1)],
    }
  },
  oneShot: true,
  plan(ctx, prog, p, _a, _t, now) {
    const c = certify(ctx, prog.user_id, p.plan, now)
    // The certificate is recomputed at run time on the balances of that moment. If it no longer holds, nothing is paid.
    if (!c.certified) return { actions: [], skip: 'The no-regret check no longer passes on your balances as they are now, so nothing was paid.' }
    const actions: PlannedAction[] = []
    const pay = (purpose: PaymentParams['purpose'], handle: string, name: string, rupees: number, charge = 0) => actions.push({ kind: 'payment', venue: 'paper-rail', summary: `Pay ${amountText(rupees * 100)} to ${name}`, params: { payeeHandle: handle, payeeName: name, amount: String(rupees * 100), ...(charge ? { charge: String(charge) } : {}), purpose } satisfies PaymentParams })
    if (p.plan.card > 0) pay('card', 'card@paperbank', 'your credit card', p.plan.card)
    if (p.plan.personal_loan > 0) pay('loan:personal', 'loan-personal@paperbank', 'your personal loan', p.plan.personal_loan, Math.round(p.plan.personal_loan * c.hm.model.prepayPenalty.personal_loan * 100))
    if (p.plan.home_loan > 0) pay('loan:home', 'loan-home@paperbank', 'your home loan', p.plan.home_loan)
    if (p.plan.fd > 0) pay('fd', 'fd@paperbank', 'a fixed deposit', p.plan.fd)
    if (p.plan.liquid_fund > 0) actions.push(buyOrder(instrument(ctx.db, 'amfi:118701')!, p.plan.liquid_fund * 100, _a, 'paydown'))
    return { actions }
  },
}

// ---- bills
/** The most payees one bills instruction names (R13 review, R10). */
export const MAX_BILL_PAYEES = 50
interface BillsP { payeeHandles: string[]; capPerBill: number; leadMinutes: number }
const bills: KindSpec<BillsP> = {
  kind: 'bills', pillar: 'spend', label: 'Pay registered bills', blurb: 'Pay bills from payees you name when they fall due, within a cap for each bill.',
  parse(ctx, userId, raw) {
    const f = new Fields()
    const handles = Array.isArray(raw.payeeHandles) ? [...new Set(raw.payeeHandles.filter((h): h is string => typeof h === 'string'))] : []
    if (handles.length === 0) f.err('payeeHandles', 'Choose at least one payee.')
    // Each payee named is checked against every other for look-alikes, at the preview, the save and the approval (R13 review, R10).
    if (handles.length > MAX_BILL_PAYEES) f.err('payeeHandles', `Name at most ${MAX_BILL_PAYEES} payees in one instruction; make a second instruction for the rest.`)
    for (const h of handles) if (!ctx.db.get('SELECT 1 FROM payees WHERE user_id = ? AND handle = ?', userId, h)) f.err('payeeHandles', `"${h}" is not one of your payees.`)
    const capPerBill = f.paise(raw, 'capPerBill', { min: 100, label: 'The most for one bill' })
    const leadMinutes = raw.leadMinutes === undefined ? 0 : f.int(raw, 'leadMinutes', 0, 10_080, 'How long before the due time to pay, in minutes')
    f.done()
    return { payeeHandles: handles.sort(), capPerBill, leadMinutes }
  },
  title: (_c, p) => `Pay bills from ${p.payeeHandles.length} payee${p.payeeHandles.length === 1 ? '' : 's'} up to ${amountText(p.capPerBill)} each`,
  schedule: () => null,
  suggestAuthority: (_c, _u, p, now) => ({ maxPerRun: p.capPerBill, maxPerMonth: p.capPerBill * Math.max(2, p.payeeHandles.length * 2), maxPerDay: null, expiresAt: now + 180 * DAY, runMode: 'approve', noticeSec: 0, maxSlippageBps: 100, maxRuns: null }),
  analyse(ctx, userId, p, a, now) {
    const names = ctx.db.all<{ name: string; handle: string }>(`SELECT name, handle FROM payees WHERE user_id = ? AND handle IN (${p.payeeHandles.map(() => '?').join(',')})`, userId, ...p.payeeHandles)
    const due = ctx.db.all<{ amount: number; due_at: number; name: string }>(
      `SELECT b.amount, b.due_at, y.name FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND b.state IN ('due', 'scheduled') AND y.handle IN (${p.payeeHandles.map(() => '?').join(',')}) ORDER BY b.due_at`, userId, ...p.payeeHandles)
    const over = due.filter((d) => d.amount > p.capPerBill)
    const warnings = over.map((d) => `${d.name}: ${amountText(d.amount)} is above your cap of ${amountText(p.capPerBill)} and will wait for you.`)
    for (const n of names) { const look = payeeWarning(ctx.db, userId, n); if (look) warnings.unshift(look) }
    if (a.runMode === 'notify' && a.noticeSec < 86_400) warnings.push('Card and UPI mandates in India must tell you 24 hours before a debit. A shorter notice here is a paper setting for review.')
    return {
      tier: 'bounded', tierReason: 'A registered obligation within your caps. No checker certifies bills; the limits and your notice period are the protection.',
      headline: due.length ? `${due.length} bill${due.length === 1 ? '' : 's'} on record, ${amountText(due.reduce((s, d) => s + d.amount, 0))} in total` : 'No bills on record for these payees yet',
      figures: [
        { label: 'Payees covered', value: names.map((n) => n.name).join(', ') || '—', basis: 'recorded' },
        { label: 'Most for one bill', value: amountText(p.capPerBill), basis: 'recorded' },
        { label: 'Most in a month', value: amountText(a.maxPerMonth), basis: 'recorded' },
        ...due.slice(0, 4).map((d) => ({ label: `${d.name}, due ${whenIst(d.due_at)}`, value: amountText(d.amount), basis: 'recorded' as const })),
      ],
      consequences: [
        `When a bill from one of these payees falls due, QED pays it from your bank account${p.leadMinutes ? `, ${p.leadMinutes} minutes ahead of the due time` : ''}.`,
        'A bill above the cap, or from anyone else, is not paid. It waits for you and you are told.',
        'A payment that fails comes back to your account and the bill returns to "due".',
      ],
      warnings, refusals: [], inputs: [], computedAt: now,
    }
  },
  doc(ctx, userId, p) {
    const names = ctx.db.all<{ name: string; handle: string }>(`SELECT name, handle FROM payees WHERE user_id = ? AND handle IN (${p.payeeHandles.map(() => '?').join(',')}) ORDER BY handle`, userId, ...p.payeeHandles)
    return {
      may: [`Pay bills that fall due from: ${names.map((n) => `${n.name} (${n.handle})`).join('; ')}.`],
      limits: [`At most ${amountText(p.capPerBill)} for any one bill.`],
      conditions: ['Only bills recorded as due from these payees, each paid once.', 'Only if the money is available in your bank account.'],
      never: ['Pay anyone not named here, even with the same name at a different address.', 'Pay a bill above the cap; it waits for you instead.', ...COMMON_NEVER.slice(0, 2)],
    }
  },
  due(ctx, prog, p, _v, now) {
    const rows = ctx.db.all<{ id: string; amount: number; due_at: number; handle: string }>(
      `SELECT b.id, b.amount, b.due_at, y.handle FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND b.state = 'due' AND b.due_at - ? <= ? AND y.handle IN (${p.payeeHandles.map(() => '?').join(',')})`,
      prog.user_id, p.leadMinutes * 60_000, now, ...p.payeeHandles)
    // One attempt ahead of the bill's day, if the owner allowed paying ahead, and one on its day. The attempt ahead
    // can be refused because it would leave something due earlier uncovered; on its own day the bill is owed either
    // way, so it is tried once more. Each attempt is its own occurrence and happens once.
    const today = ist(now).date
    return rows.map((b) => ({ occurrence: ist(b.due_at).date > today ? `bill-${b.id}-early` : `bill-${b.id}`, trigger: { billId: b.id, amount: b.amount, dueAt: b.due_at, handle: b.handle } }))
  },
  plan(ctx, prog, p, _a, trigger, now) {
    const b = ctx.db.get<{ id: string; amount: number; state: string; memo: string; name: string; handle: string }>(
      'SELECT b.id, b.amount, b.state, b.memo, y.name, y.handle FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.id = ? AND b.user_id = ?', String(trigger.billId), prog.user_id)
    if (!b || (b.state !== 'due' && b.state !== 'scheduled')) return { actions: [], skip: 'The bill is no longer due.' }
    if (b.amount > p.capPerBill) return { actions: [], skip: `${b.name}: ${amountText(b.amount)} is above your cap of ${amountText(p.capPerBill)}. It waits for you.` }
    // a payee in its first 24 hours: an instruction does not pay it more than the household's amount (new-payee.ts); the
    // owner may, and then the payment waits, which an instruction's run cannot (it is started when due or not at all)
    const profile = getProfile(ctx.db, prog.user_id)
    const h = holdFor(ctx.db, prog.user_id, profile, b.handle, BigInt(b.amount), now)
    if (h) return { actions: [], skip: `${b.name} was added ${addedWhen(h.payee.createdAt, now)}. Your instructions do not pay a payee more than ${amountText(h.above)} in its first 24 hours, so this ${amountText(b.amount)} bill waits for you: pay it yourself from Spend, where it waits ${waitWords(profile)} before it is sent.` }
    return { actions: [{ kind: 'payment', venue: 'paper-rail', summary: `Pay ${amountText(b.amount)} to ${b.name}`, params: { payeeHandle: b.handle, payeeName: b.name, amount: String(b.amount), purpose: 'bill', billId: b.id, memo: b.memo } satisfies PaymentParams }] }
  },
}

// ---- protective exit
interface ExitP { instrumentId: string; mode: 'below' | 'trail'; price?: string; trailPct?: number; sellBps: number }
function exitTrigger(ctx: Ctx, p: ExitP, memo: Record<string, unknown>, now: number): { evaluable: boolean; why: string; bid: number | null; level: number | null; fire: boolean; high: number | null } {
  const inst = instrument(ctx.db, p.instrumentId)!
  const { tick } = exitPrice(ctx.market, inst)
  const f = freshness(tick, inst, now)
  if (!tick || !f.usableForExecution) return { evaluable: false, why: tick ? `The price of ${inst.name} is ${Math.round(f.ageMs / 1000)} seconds old.` : `No price has been received for ${inst.name}.`, bid: null, level: null, fire: false, high: null }
  if (inst.kind === 'crypto_spot') {
    const cc = crossCheck(ctx, inst, now)
    if (!cc.ok) return { evaluable: false, why: cc.available ? `The venue price and the independent price disagree. ${cc.detail}` : cc.detail, bid: Number(tick.price), level: null, fire: false, high: null }
  }
  const bid = priceToNumber(parsePrice(tick.price))
  if (p.mode === 'below') { const level = Number(p.price); return { evaluable: true, why: '', bid, level, fire: bid <= level, high: null } }
  const high = Math.max(typeof memo.high === 'number' ? memo.high : 0, bid)
  const level = high * (1 - (p.trailPct ?? 0) / 100)
  return { evaluable: true, why: '', bid, level, fire: bid <= level, high }
}
const exit: KindSpec<ExitP> = {
  kind: 'exit', pillar: 'protect', label: 'Sell if the price falls', blurb: 'Sell part or all of a holding when its price drops to a level you set, or falls a set percentage from its high.',
  parse(ctx, _u, raw) {
    const f = new Fields()
    const inst = f.instrument(ctx.db, raw, 'instrumentId', ['crypto_spot', 'mutual_fund'])
    const mode = raw.mode === 'trail' ? 'trail' : 'below'
    let price: string | undefined, trailPct: number | undefined
    if (mode === 'below') { if (typeof raw.price !== 'string' || !/^\d+(\.\d+)?$/.test(raw.price) || Number(raw.price) <= 0) f.err('price', 'Enter the price at which to sell.'); else price = raw.price }
    else { if (typeof raw.trailPct !== 'number' || !(raw.trailPct >= 0.1 && raw.trailPct <= 80)) f.err('trailPct', 'Enter a fall from the high between 0.1% and 80%.'); else trailPct = raw.trailPct }
    const sellBps = raw.sellBps === undefined ? 10_000 : f.int(raw, 'sellBps', 1, 10_000, 'The share to sell, in hundredths of a percent')
    f.done()
    return { instrumentId: inst!.id, mode, ...(price ? { price } : {}), ...(trailPct !== undefined ? { trailPct } : {}), sellBps }
  },
  title: (ctx, p) => { const n = instrument(ctx.db, p.instrumentId)!.name.replace(/ \(.*\)$/, ''); const share = p.sellBps === 10_000 ? 'all' : `${p.sellBps / 100}%`; return p.mode === 'below' ? `Sell ${share} of ${n} at ${Number(p.price).toLocaleString('en-IN')} or lower` : `Sell ${share} of ${n} if it falls ${p.trailPct}% from its high` },
  schedule: () => null,
  suggestAuthority: (_c, _u, _p, now) => ({ maxPerRun: 100_000_000_000, maxPerMonth: 100_000_000_000, maxPerDay: null, expiresAt: now + 30 * DAY, runMode: 'approve', maxSlippageBps: 150, maxRuns: 1 }),
  analyse(ctx, userId, p, a, now) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const input = inputFor(ctx, inst, now)
    const t = exitTrigger(ctx, p, {}, now)
    const held = available(ctx.db, userId, `pos:${inst.id}`)
    const qty = inst.kind === 'crypto_spot' ? floorToStep(mulDiv(held, BigInt(p.sellBps), 10_000n, 'down'), ctx.venues.crypto.rules(inst).step) : mulDiv(held, BigInt(p.sellBps), 10_000n, 'down')
    const level = p.mode === 'below' ? Number(p.price) : t.level
    const gross = level !== null ? Number(notional(qty, inst.baseScale, parsePrice(level.toFixed(6)), inst.quoteScale, 'down')) : 0
    const rules = inst.kind === 'crypto_spot' ? ctx.venues.crypto.rules(inst) : null
    const costs = rules ? Number(fraction(BigInt(gross), rules.feeRate, 'up') + fraction(BigInt(gross), rules.tdsRate, 'up')) : 0
    const warnings: string[] = [], refusals: string[] = []
    if (held <= 0n) refusals.push(`You hold no ${inst.name} to protect.`)
    if (!t.evaluable) warnings.push(`It cannot be evaluated right now: ${t.why}`)
    if (t.evaluable && t.fire) warnings.push('The price is already at or below your level: it would sell at the next check.')
    if (inst.kind === 'mutual_fund') warnings.push('A fund has one price a day. The sale is decided on the published NAV and executes at a later NAV, which can be lower.')
    if (a.runMode === 'approve') warnings.push(ASKS_BEFORE_SELLING)
    const dist = t.bid && level ? (t.bid - level) / t.bid : null
    return {
      tier: 'bounded', tierReason: 'It only ever sells, which lowers risk. It does not promise a price: it sells at what buyers offer after the trigger.',
      headline: dist !== null ? `Sells if the price falls ${pct(Math.max(0, dist), 2)} from here` : 'Waiting for a usable price',
      figures: [
        ...(t.bid ? [{ label: 'Price a sale would get now', value: t.bid.toLocaleString('en-IN'), basis: 'live' as const, note: input ? `${input.priceType} from ${input.provider}` : undefined }] : []),
        ...(level !== null ? [{ label: 'Sells at or below', value: level.toLocaleString('en-IN', { maximumFractionDigits: 2 }), basis: 'recorded' as const, note: p.mode === 'trail' ? `${p.trailPct}% under the highest price seen while this is active` : undefined }] : []),
        { label: 'Would sell', value: `${(Number(qty) / 10 ** inst.baseScale).toString()} ${inst.kind === 'mutual_fund' ? 'units' : inst.base_asset}`, basis: 'recorded', note: p.sellBps === 10_000 ? 'Everything free to sell at that moment' : `${p.sellBps / 100}% of what is free to sell at that moment` },
        ...(gross > 0 ? [{ label: 'Proceeds at the trigger price', value: `about ${amountText(whole(gross - costs))}`, basis: 'estimate' as const, note: rules ? `After the ${pct(Number(rules.feeRate), 2)} fee and 1% tax deducted at source; the fill can be up to ${(a.maxSlippageBps / 100).toFixed(2)}% lower` : 'At the trigger NAV; the executing NAV can differ' }] : []),
      ],
      consequences: [
        inst.kind === 'crypto_spot' ? 'QED checks the bid every few seconds while it is running. When the bid reaches your level it sells into the order book straight away.' : 'QED checks each published NAV. When it reaches your level, it places a redemption at the next applicable NAV.',
        `It sells only down to ${(a.maxSlippageBps / 100).toFixed(2)}% below the best bid at that moment. If buyers are thinner than that, it sells what it can and tells you.`,
        'If QED or the price source is offline, nothing is sold. When it comes back you are told the period it could not watch.',
        'After it sells, it ends. It never buys back.',
      ],
      warnings, refusals, inputs: input ? [input] : [], computedAt: now, preview: { level, bid: t.bid, qty: qty.toString() },
    }
  },
  doc(ctx, _u, p, a) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const share = p.sellBps === 10_000 ? 'all' : `${p.sellBps / 100}%`
    return {
      may: [p.mode === 'below' ? `Sell ${share} of your ${inst.name} when the price buyers offer is ${Number(p.price).toLocaleString('en-IN')} or lower.` : `Sell ${share} of your ${inst.name} when the price buyers offer falls ${p.trailPct}% below the highest it has been since you signed this.`],
      limits: [`Sell no lower than ${(a.maxSlippageBps / 100).toFixed(2)}% under the best bid at that moment.`, 'Once. After it sells, it ends.'],
      conditions: [inst.kind === 'crypto_spot' ? 'Only on price data no older than 15 seconds that agrees with an independent source to within 3%.' : 'Only on a NAV published by the fund house.', 'Proceeds go to your bank account, less the venue fee and tax deducted at source.'],
      never: ['Buy anything.', 'Sell any other holding.', 'Act after the end date, or while paused or revoked.'],
    }
  },
  oneShot: true,
  due(ctx, prog, p, version, now) {
    const t = exitTrigger(ctx, p, prog.memo, now)
    if (!t.evaluable) return [{ occurrence: '', trigger: { unevaluable: t.why }, memo: { ...prog.memo, blindSince: prog.memo.blindSince ?? now, blindWhy: t.why } }]
    const memo = { ...prog.memo, high: t.high ?? prog.memo.high, lastBid: t.bid, lastChecked: now, blindSince: null, blindWhy: null }
    if (!t.fire) return [{ occurrence: '', trigger: {}, memo }]
    const attempt = typeof prog.memo.attempt === 'number' ? prog.memo.attempt : 0
    return [{ occurrence: `fire-v${version}-${attempt}`, trigger: { bid: t.bid, level: t.level, high: t.high, mode: p.mode }, memo: { ...memo, firedAt: now } }]
  },
  plan(ctx, prog, p, a) {
    const inst = instrument(ctx.db, p.instrumentId)!
    const held = available(ctx.db, prog.user_id, `pos:${inst.id}`)
    let qty = mulDiv(held, BigInt(p.sellBps), 10_000n, 'down')
    if (inst.kind === 'crypto_spot') qty = floorToStep(qty, ctx.venues.crypto.rules(inst).step)
    if (qty <= 0n) return { actions: [], skip: 'Nothing is free to sell.' }
    return { actions: [sellOrder(inst, qty, a, 'protective-exit', true)] }
  },
}

// ---- the floor controller
interface FloorP { buffer: number }
function floorPlan(ctx: Ctx, userId: string, p: FloorP, a: Authority, now: number): { deficit: number; sells: { inst: Instrument; qty: bigint; value: number }[]; valid: boolean; reasons: string[]; cushion: number } {
  const hs = holdings(ctx.db, ctx.market, userId, now)
  const w = worstCase(ctx.db, ctx.market, userId, now, hs)
  if (w.cushion >= 0) return { deficit: 0, sells: [], valid: w.valid, reasons: w.invalidReasons, cushion: w.cushion }
  // Aim a little past the floor (0.2% of the gap plus one rupee) so that rounding and a slightly worse fill do not leave it short.
  const deficit = Math.ceil((-w.cushion + p.buffer) * 1.002) + 100
  // Selling value X of a holding with limit λ raises the worst case by about X × (λ − cost of selling).
  // The cost allows for the venue fee, tax deducted at source and the full price tolerance of the authority.
  const gains = hs.filter((h) => h.value && h.limit > 0).map((h) => {
    const inst = instrument(ctx.db, h.instrumentId)!
    const rules = inst.kind === 'crypto_spot' ? ctx.venues.crypto.rules(inst) : null
    const cost = rules ? Number(rules.feeRate) + Number(rules.tdsRate) + a.maxSlippageBps / 10_000 : 0.0001
    return { h, gainPerRupee: Math.max(0.0001, h.limit - cost) }
  })
  const total = gains.reduce((s, g) => s + g.h.value! * g.gainPerRupee, 0)
  const fracToSell = total > 0 ? Math.min(1, deficit / total) : 0
  const sells: { inst: Instrument; qty: bigint; value: number }[] = []
  for (const g of gains) {
    const inst = instrument(ctx.db, g.h.instrumentId)!
    const free = available(ctx.db, userId, `pos:${inst.id}`)
    let qty = mulDiv(free, BigInt(Math.ceil(fracToSell * 1_000_000)), 1_000_000n, 'up')
    if (qty > free) qty = free
    if (inst.kind === 'crypto_spot') { const step = ctx.venues.crypto.rules(inst).step; qty = floorToStep(qty + step - 1n, step); if (qty > free) qty = floorToStep(free, step) }
    if (qty > 0n) sells.push({ inst, qty, value: Math.round(g.h.value! * fracToSell) })
  }
  return { deficit, sells, valid: w.valid, reasons: w.invalidReasons, cushion: w.cushion }
}
const floor: KindSpec<FloorP> = {
  kind: 'floor', pillar: 'protect', label: 'Hold the floor', blurb: 'If your worst case falls below your floor, sell enough of what can fall to bring it back above. It only ever sells.',
  parse(_c, _u, raw) {
    const f = new Fields()
    const buffer = raw.buffer === undefined ? 0 : f.paise(raw, 'buffer', { min: 0, label: 'The margin above the floor' })
    f.done()
    return { buffer }
  },
  title: () => 'Hold my floor: sell risk when the worst case drops below it',
  schedule: () => null,
  suggestAuthority: (_c, _u, _p, now) => ({ maxPerRun: 100_000_000_000, maxPerMonth: 100_000_000_000, maxPerDay: null, expiresAt: now + 90 * DAY, runMode: 'approve', maxSlippageBps: 200, maxRuns: null }),
  analyse(ctx, userId, p, a, now) {
    const hs = holdings(ctx.db, ctx.market, userId, now)
    const w = worstCase(ctx.db, ctx.market, userId, now, hs)
    const warnings: string[] = []
    if (a.runMode === 'approve') warnings.push(ASKS_BEFORE_SELLING)
    if (w.illustrative) warnings.push('One or more limits are illustrative, not calibrated on that instrument\'s own history. The floor is only as good as its limits.')
    if (!w.valid) warnings.push(`The worst case cannot be relied on right now: ${w.invalidReasons.join('; ')}.`)
    if (hs.some((h) => h.kind === 'mutual_fund')) warnings.push('Fund holdings can only be sold at a later NAV, so a fall between two NAVs larger than the limit breaks the floor for that holding.')
    return {
      tier: 'bounded', tierReason: 'A conditional protection. It holds if no fall between two checks exceeds each holding\'s limit and the sale can execute.',
      headline: w.cushion >= 0 ? `Worst case is ${amountText(w.cushion)} above your floor` : `Worst case is ${amountText(-w.cushion)} below your floor: it would sell now`,
      figures: [
        { label: 'Worst case now', value: amountText(w.gHat), basis: 'limit', note: 'Cash and deposits, plus holdings after their limits, less card debt and what is due in 30 days' },
        { label: 'Your floor', value: amountText(w.line), basis: 'recorded' },
        { label: 'Cushion', value: amountText(w.cushion), basis: 'limit' },
        { label: 'Holdings that can fall', value: amountText(w.holdingsValue), basis: 'live', note: `Worth ${amountText(w.holdingsWorst)} after their limits` },
      ],
      consequences: [
        'QED recomputes your worst case whenever prices or balances change.',
        `If it falls below your floor, QED sells the same share of every holding that can fall, enough to bring the worst case back to the floor${p.buffer ? ` plus ${amountText(p.buffer)}` : ''}.`,
        'It never buys back. Rebuilding the holdings afterwards is your decision.',
        'If prices go stale or QED is offline, it cannot act. You are told when it could not watch, and for how long.',
      ],
      warnings, refusals: [], inputs: hs.map((h) => inputFor(ctx, instrument(ctx.db, h.instrumentId)!, now)).filter((x): x is DataInput => !!x),
      worst: { before: w.gHat, after: w.gHat, line: w.line, illustrative: w.illustrative, valid: w.valid }, computedAt: now,
    }
  },
  doc(_c, userId, p, a) {
    void userId
    return {
      may: [`Sell part of any holding that can fall in value, whenever your worst case is below your floor, until it is back at the floor${p.buffer ? ` plus ${amountText(p.buffer)}` : ''}.`],
      limits: [`Sell no lower than ${(a.maxSlippageBps / 100).toFixed(2)}% under the best bid at that moment.`, 'Sell the same share of each such holding; never more than is needed.'],
      conditions: ['Only on fresh prices: a holding whose price is stale is not sold on that price.', 'Proceeds go to your bank account.'],
      never: ['Buy anything, ever.', 'Send money to anyone.', 'Act after the end date, or while paused or revoked.'],
    }
  },
  due(ctx, prog, p, version, now) {
    const active = ctx.db.get(`SELECT 1 FROM runs WHERE program_id = ? AND state IN ('due', 'executing', 'objection_window', 'awaiting_approval')`, prog.id)
    if (active) return []
    const lastDone = ctx.db.get<{ t: number | null }>('SELECT MAX(finished_at) t FROM runs WHERE program_id = ?', prog.id)?.t ?? 0
    if (now - lastDone < 60_000) return []
    const w = worstCase(ctx.db, ctx.market, prog.user_id, now)
    if (!w.valid) return [{ occurrence: '', trigger: { unevaluable: w.invalidReasons.join('; ') }, memo: { ...prog.memo, blindSince: prog.memo.blindSince ?? now, blindWhy: w.invalidReasons.join('; ') } }]
    const memo = { ...prog.memo, lastChecked: now, lastCushion: w.cushion, blindSince: null, blindWhy: null }
    if (w.cushion >= 0 || w.holdingsValue <= 0) return [{ occurrence: '', trigger: {}, memo }]
    void p
    return [{ occurrence: `breach-v${version}-${Math.floor(now / 60_000)}`, trigger: { worstCase: w.gHat, line: w.line, cushion: w.cushion }, memo }]
  },
  plan(ctx, prog, p, a, _t, now) {
    const fp = floorPlan(ctx, prog.user_id, p, a, now)
    if (fp.deficit <= 0) return { actions: [], skip: 'The worst case is back above the floor; nothing needs selling.' }
    if (!fp.sells.length) return { actions: [], skip: 'Nothing that can fall is free to sell.' }
    return { actions: fp.sells.map((s) => sellOrder(s.inst, s.qty, a, 'floor', true)) }
  },
}

// ---- rebalance
interface RebalanceP { legs: { instrumentId: string; weightBps: number }[]; bandBps: number; schedule: Schedule }
function rebalanceState(ctx: Ctx, userId: string, p: RebalanceP, now: number) {
  const rows = p.legs.map((l) => {
    const inst = instrument(ctx.db, l.instrumentId)!
    const qty = balance(ctx.db, userId, `pos:${inst.id}`)
    const { tick } = exitPrice(ctx.market, inst)
    const value = tick ? Number(notional(qty, inst.baseScale, parsePrice(tick.price), inst.quoteScale, 'down')) : 0
    return { inst, qty, tick, value, target: l.weightBps / 10_000, fresh: freshness(tick, inst, now) }
  })
  const total = rows.reduce((s, r) => s + r.value, 0)
  const withW = rows.map((r) => ({ ...r, weight: total > 0 ? r.value / total : 0, diff: Math.round(total * r.target - r.value) }))
  const drift = withW.reduce((m, r) => Math.max(m, Math.abs(r.weight - r.target)), 0)
  return { rows: withW, total, drift, needs: total > 0 && drift > p.bandBps / 10_000, priced: rows.every((r) => !!r.tick) }
}
const rebalance: KindSpec<RebalanceP> = {
  kind: 'rebalance', pillar: 'grow', label: 'Keep a mix in balance', blurb: 'Hold several funds or assets in set proportions and trade back to them when they drift beyond a band.',
  parse(ctx, _u, raw, now) {
    const f = new Fields()
    const legsRaw = Array.isArray(raw.legs) ? (raw.legs as Raw[]) : []
    if (legsRaw.length < 2 || legsRaw.length > 6) f.err('legs', 'Choose between two and six holdings.')
    const legs = legsRaw.map((l, i) => {
      const inst = f.instrument(ctx.db, l, 'instrumentId', ['mutual_fund', 'crypto_spot'])
      if (!inst) f.err(`legs.${i}`, 'Choose something QED can trade.')
      const w = typeof l.weightBps === 'number' && Number.isInteger(l.weightBps) && l.weightBps > 0 && l.weightBps < 10_000 ? l.weightBps : (f.err(`legs.${i}`, 'Each share must be between 0.01% and 99.99%.'), 0)
      return { instrumentId: inst?.id ?? '', weightBps: w }
    })
    if (legs.reduce((s, l) => s + l.weightBps, 0) !== 10_000) f.err('legs', 'The shares must add up to 100%.')
    if (new Set(legs.map((l) => l.instrumentId)).size !== legs.length) f.err('legs', 'Each holding can appear once.')
    const bandBps = f.int(raw, 'bandBps', 50, 3000, 'The band in hundredths of a percent')
    const schedule = raw.schedule ? f.schedule(raw, 'schedule', now) : { type: 'daily', at: '11:00' } as Schedule
    f.done()
    return { legs, bandBps, schedule }
  },
  title: (ctx, p) => `Keep ${p.legs.map((l) => `${l.weightBps / 100}% ${instrument(ctx.db, l.instrumentId)!.name.split(' ').slice(0, 3).join(' ')}`).join(' / ')}`,
  schedule: (p) => p.schedule,
  suggestAuthority: (ctx, userId, p, now) => { const t = rebalanceState(ctx, userId, p, now).total; const cap = Math.max(1_000_000, Math.round(t * 0.25)); return { maxPerRun: cap, maxPerMonth: cap * 4, maxPerDay: null, expiresAt: now + 90 * DAY, runMode: 'approve', maxSlippageBps: 100, maxRuns: null } },
  analyse(ctx, userId, p, a, now) {
    const s = rebalanceState(ctx, userId, p, now)
    const warnings: string[] = []
    if (!s.priced) warnings.push('One of the holdings has no price yet.')
    if (s.total === 0) warnings.push('You hold none of these yet. This instruction trades between them; it does not make the first purchase.')
    if (s.rows.some((r) => r.inst.kind === 'crypto_spot')) warnings.push('Each sale of a digital asset has 1% deducted at source and gains are taxed at 30%. Frequent rebalancing costs tax.')
    const sells = s.rows.filter((r) => r.diff < 0), buys = s.rows.filter((r) => r.diff > 0)
    return {
      tier: 'bounded', tierReason: 'Bounded by your limits and your floor. Selling one holding to buy another changes what can fall; it is not a no-regret move.',
      headline: s.needs ? `Out of balance by ${pct(s.drift, 1)}: it would trade at the next run` : `Within the ${pct(p.bandBps / 10_000, 1)} band`,
      figures: [
        ...s.rows.map((r) => ({ label: r.inst.name, value: `${pct(r.weight, 1)} now, ${pct(r.target, 0)} target`, basis: 'live' as const, note: `${amountText(r.value)}; ${r.diff === 0 ? 'on target' : r.diff > 0 ? `buy about ${amountText(whole(r.diff))}` : `sell about ${amountText(whole(-r.diff))}`}` })),
        { label: 'Total in this mix', value: amountText(s.total), basis: 'live' },
        { label: 'Most it may buy in one run', value: amountText(a.maxPerRun), basis: 'recorded' },
      ],
      consequences: [
        `${describeSchedule(p.schedule).replace(/^./, (c) => c.toUpperCase())}, QED measures each holding's share of the mix.`,
        `If any share is more than ${pct(p.bandBps / 10_000, 1)} from its target, it sells what is above target and buys what is below.`,
        sells.length && buys.length ? `Today that would mean selling ${sells.map((r) => r.inst.name.split(' ').slice(0, 3).join(' ')).join(', ')} and buying ${buys.map((r) => r.inst.name.split(' ').slice(0, 3).join(' ')).join(', ')}.` : 'Today nothing would trade.',
        'Fund trades execute at a later NAV and fund sales pay out days later, so the two halves do not happen at the same moment.',
      ],
      warnings, refusals: [], inputs: s.rows.map((r) => inputFor(ctx, r.inst, now)).filter((x): x is DataInput => !!x), computedAt: now,
    }
  },
  doc(ctx, _u, p) {
    return {
      may: [`Trade between these holdings to keep them at: ${p.legs.map((l) => `${l.weightBps / 100}% ${instrument(ctx.db, l.instrumentId)!.name}`).join('; ')}.`],
      conditions: [`Only when a share is more than ${p.bandBps / 100}% of the mix away from its target, checked ${describeSchedule(p.schedule)}.`, 'Purchases only with money free in your bank account, and only if your worst case stays at or above your floor.'],
      never: ['Trade anything outside this list.', 'Add new money to the mix or take money out of it to spend.', ...COMMON_NEVER.slice(0, 2)],
    }
  },
  plan(ctx, prog, p, a, _t, now) {
    const s = rebalanceState(ctx, prog.user_id, p, now)
    if (!s.priced) return { actions: [], skip: 'A holding has no price; nothing was traded.' }
    if (!s.needs) return { actions: [], skip: `Every share is within ${p.bandBps / 100}% of its target.` }
    const actions: PlannedAction[] = []
    let buyBudget = a.maxPerRun
    for (const r of s.rows) {
      if (r.diff < 0 && r.tick) {
        let qty = quantityFor(BigInt(-r.diff), r.inst.quoteScale, parsePrice(r.tick.price), r.inst.baseScale, 'down')
        if (r.inst.kind === 'crypto_spot') qty = floorToStep(qty, ctx.venues.crypto.rules(r.inst).step)
        const free = available(ctx.db, prog.user_id, `pos:${r.inst.id}`)
        if (qty > free) qty = free
        if (qty > 0n) actions.push(sellOrder(r.inst, qty, a, 'rebalance', false))
      }
    }
    for (const r of s.rows) {
      if (r.diff > 0) { const amt = Math.min(r.diff, buyBudget); if (amt >= 10_000) { actions.push(buyOrder(r.inst, amt, a, 'rebalance')); buyBudget -= amt } }
    }
    return actions.length ? { actions } : { actions: [], skip: 'The differences are too small to trade.' }
  },
}

// ---- income split
interface SplitP { rules: { to: 'fund' | 'card'; instrumentId?: string; shareBps: number }[]; minIncome: number }
const split: KindSpec<SplitP> = {
  kind: 'split', pillar: 'earn', label: 'Split income when it arrives', blurb: 'When pay or earnings land, send set shares to investments or to your card. The rest stays in the bank.',
  parse(ctx, _u, raw) {
    const f = new Fields()
    const rr = Array.isArray(raw.rules) ? (raw.rules as Raw[]) : []
    if (rr.length < 1 || rr.length > 5) f.err('rules', 'Add between one and five shares.')
    const rules = rr.map((r, i) => {
      const share = typeof r.shareBps === 'number' && Number.isInteger(r.shareBps) && r.shareBps > 0 && r.shareBps <= 10_000 ? r.shareBps : (f.err(`rules.${i}`, 'Each share must be between 0.01% and 100%.'), 0)
      if (r.to === 'card') return { to: 'card' as const, shareBps: share }
      const inst = f.instrument(ctx.db, r, 'instrumentId', ['mutual_fund', 'crypto_spot'])
      if (!inst) f.err(`rules.${i}`, 'Choose where this share goes.')
      return { to: 'fund' as const, instrumentId: inst?.id ?? '', shareBps: share }
    })
    if (rules.reduce((s, r) => s + r.shareBps, 0) > 10_000) f.err('rules', 'The shares cannot add up to more than 100%.')
    const minIncome = raw.minIncome === undefined ? 100_000 : f.paise(raw, 'minIncome', { min: 100, label: 'The smallest income to split' })
    f.done()
    return { rules, minIncome }
  },
  title: (ctx, p) => `Split income: ${p.rules.map((r) => `${r.shareBps / 100}% to ${r.to === 'card' ? 'the card' : instrument(ctx.db, r.instrumentId!)!.name.split(' ').slice(0, 3).join(' ')}`).join(', ')}`,
  schedule: () => null,
  suggestAuthority: (ctx, userId, p, now) => { const inc = getProfile(ctx.db, userId).income; const share = p.rules.reduce((s, r) => s + r.shareBps, 0) / 10_000; const cap = Math.max(100_000, Math.ceil(inc * share)); return { maxPerRun: cap, maxPerMonth: cap * 2, maxPerDay: null, expiresAt: now + 180 * DAY, runMode: 'approve', noticeSec: 0, maxSlippageBps: 100, maxRuns: null } },
  analyse(ctx, userId, p, a, now) {
    const profile = getProfile(ctx.db, userId)
    const example = profile.income
    const kept = 10_000 - p.rules.reduce((s, r) => s + r.shareBps, 0)
    const cash = freeCashFlow(ctx, userId, now)
    const moved = Math.round(example * (10_000 - kept) / 10_000)
    const warnings: string[] = []
    if (moved > cash.free) warnings.push(`On your recorded income this sends ${amountText(moved)} away each month; you have about ${amountText(whole(cash.free))} a month to spare after spending, bills and instalments.`)
    if (moved > a.maxPerRun) warnings.push(`On your recorded income it would move ${amountText(moved)}, above the ${amountText(a.maxPerRun)} limit for one run: the later shares would be refused.`)
    return {
      tier: 'bounded', tierReason: 'Bounded by your limits and your floor.',
      headline: `On ${amountText(example)} of income: ${amountText(moved)} moves, ${amountText(example - moved)} stays in the bank`,
      figures: [
        ...p.rules.map((r) => ({ label: r.to === 'card' ? 'To your credit card' : `To ${instrument(ctx.db, r.instrumentId!)!.name}`, value: `${r.shareBps / 100}% (${amountText(Math.round(example * r.shareBps / 10_000))})`, basis: 'recorded' as const, note: r.to === 'card' ? 'Never more than you owe' : undefined })),
        { label: 'Stays in the bank', value: `${kept / 100}% (${amountText(example - moved)})`, basis: 'recorded' },
        { label: 'Example uses your recorded monthly income', value: amountText(example), basis: 'recorded' },
      ],
      consequences: [
        `Whenever at least ${amountText(p.minIncome)} of salary or earnings is recorded in your bank account, QED works out the shares from that amount.`,
        'Each share is a separate payment or purchase, checked against your limits and your floor on its own.',
        'Money you add by hand, refunds and sale proceeds are not income and are never split.',
      ],
      warnings, refusals: [], inputs: [], computedAt: now,
    }
  },
  doc(ctx, _u, p) {
    return {
      may: p.rules.map((r) => (r.to === 'card' ? `Pay ${r.shareBps / 100}% of each income to your credit card, never more than you owe.` : `Buy ${instrument(ctx.db, r.instrumentId!)!.name} with ${r.shareBps / 100}% of each income.`)),
      conditions: [`Only when salary or earnings of at least ${amountText(p.minIncome)} is recorded, once per income.`, 'Only if the money is free in your bank account and your worst case stays at or above your floor.'],
      never: ['Treat anything other than recorded salary or earnings as income.', ...COMMON_NEVER],
    }
  },
  due(ctx, prog, p) {
    const lastSeq = typeof prog.memo.lastSeq === 'number' ? prog.memo.lastSeq : -1
    // The bank's share of each income entry, exact, then a number for the instruction's rupee arithmetic (toNum refuses past 2^53).
    const rows = ctx.db.all<{ id: string; seq: number; amount: string }>(
      `SELECT e.id, e.seq, (SELECT amount_sum(x.amount_text) FROM postings x JOIN accounts a ON a.id = x.account_id WHERE x.entry_id = e.id AND a.code = 'bank') amount
       FROM entries e WHERE e.user_id = ? AND e.kind IN ('income-salary', 'income-earn') AND e.seq > ? ORDER BY e.seq LIMIT 5`, prog.user_id, lastSeq)
      .map((r) => ({ ...r, amount: toNum(fromAmountText(r.amount, `the income in entry ${r.seq}`)) }))
    if (lastSeq < 0) {
      // A new program starts from the present: income recorded before it was signed is not split.
      const head = ctx.db.get<{ m: number | null }>('SELECT MAX(seq) m FROM entries WHERE user_id = ?', prog.user_id)?.m ?? 0
      return [{ occurrence: '', trigger: {}, memo: { ...prog.memo, lastSeq: head } }]
    }
    return rows.map((r) => (r.amount >= p.minIncome
      ? { occurrence: `income-${r.id}`, trigger: { entryId: r.id, amount: r.amount }, memo: { ...prog.memo, lastSeq: r.seq } }
      : { occurrence: '', trigger: {}, memo: { ...prog.memo, lastSeq: r.seq } }))
  },
  plan(ctx, prog, p, a, trigger) {
    const income = Number(trigger.amount ?? 0)
    const actions: PlannedAction[] = []
    for (const r of p.rules) {
      const amt = Math.floor(income * r.shareBps / 10_000)
      if (r.to === 'card') {
        const pay = Math.min(amt, Number(balance(ctx.db, prog.user_id, 'card')))
        if (pay > 0) actions.push({ kind: 'payment', venue: 'paper-rail', summary: `Pay ${amountText(pay)} to your credit card`, params: { payeeHandle: 'card@paperbank', payeeName: 'your credit card', amount: String(pay), purpose: 'card' } satisfies PaymentParams })
      } else if (amt >= 10_000) actions.push(buyOrder(instrument(ctx.db, r.instrumentId!)!, amt, a, 'income-split'))
    }
    return actions.length ? { actions } : { actions: [], skip: 'The shares of this income are too small to move.' }
  },
}

// ---- save for a goal (goals.ts): a name, an amount and a date; QED's monthly figure into a set-aside no instruction can spend
const goal: KindSpec<GoalParams> = {
  kind: 'goal', pillar: 'save', label: 'Save for a goal', blurb: 'Name an amount and a date. QED works out the monthly figure and sets it aside each month, where no instruction can spend it.',
  parse: (ctx, userId, raw, now, self) => parseGoal(ctx.db, userId, raw, now, self),
  title: (_c, p) => goalTitle(p),
  schedule: (p) => p.schedule,
  suggestAuthority: (_c, _u, p, now) => goalAuthority(p, { runMode: 'approve' }, now),
  bindAuthority: (p, a, now) => goalAuthority(p, a, now),
  analyse: (ctx, userId, p, a, now, self) => analyseGoal(ctx.db, ctx.market, userId, p, a, now, self),
  doc: (_c, _u, p) => goalDoc(p),
  plan: (ctx, prog, p) => planGoal(ctx.db, prog.user_id, prog.id, p),
}

export const KINDS: Record<ProgramKind, KindSpec<never>> = { invest, sweep, swp, paydown, bills, exit, floor, rebalance, split, goal } as unknown as Record<ProgramKind, KindSpec<never>>
export const kindSpec = (kind: string): KindSpec<Raw> => {
  const s = (KINDS as unknown as Record<string, KindSpec<Raw>>)[kind]
  if (!s) throw bad(`"${kind}" is not a kind of instruction.`)
  return s
}
export const kindCatalogue = (): { kind: ProgramKind; pillar: Pillar; label: string; blurb: string }[] => Object.values(KINDS).map((k) => ({ kind: k.kind, pillar: k.pillar, label: k.label, blurb: k.blurb }))

// ------------------------------------------------------------------------------------------------ drafts and documents

/** The params with every schedule they hold stating `zone`. The instruction's own words and its next run both read it. */
function withZone<T>(params: T, zone: string): T {
  const p = params as Record<string, unknown>
  const s = p?.schedule
  if (s && typeof s === 'object' && (s as { type?: unknown }).type !== 'every') return { ...p, schedule: { ...(s as object), zone } } as T
  return params
}

export interface Draft { kind: ProgramKind; pillar: Pillar; title: string; params: unknown; authority: Authority; analysis: Analysis; doc: AuthDoc; document: string; contentHash: string; schedule: Schedule | null }

/** Validate, analyse on current recorded data, and produce the exact document an approval would bind to. Persists nothing. */
/** The kinds that move only the household's own bank account in its home currency. */
const HOME_KINDS: ReadonlySet<string> = new Set(['goal', 'bills'])
export function buildDraft(ctx: Ctx, userId: string, kind: string, rawParams: unknown, rawAuthority: unknown, now: number, self = ''): Draft {
  const spec = kindSpec(kind)
  if (typeof rawParams !== 'object' || rawParams === null) throw bad('The instruction details are missing.')
  // Instructions that buy, sell or plan debt price in rupees: a household in another home currency saves for goals and pays bills only.
  if (!HOME_KINDS.has(kind)) requireRupeeHome(householdHome(ctx.db, userId), `An instruction of the kind "${kind}"`)
  // A new instruction states the household's zone for its clock times (format 2); one that does not is read in India's (format 1).
  const zone = zoneOf(getProfile(ctx.db, userId))
  const params = withZone(spec.parse(ctx, userId, rawParams as Raw, now, self), zone)
  const f = new Fields()
  const asked = parseAuthority(rawAuthority, now, f, spec.suggestAuthority(ctx, userId, params, now, self))
  f.done('Some limits need attention.')
  const authority = spec.bindAuthority ? spec.bindAuthority(params, asked, now) : asked
  const analysis = spec.analyse(ctx, userId, params, authority, now, self)
  if (authority.runMode === 'auto' && analysis.tier === 'each-time') analysis.refusals.push('This cannot run on its own: it is not certified. Choose "ask me each time", or change the plan.')
  const d = spec.doc(ctx, userId, params, authority, analysis)
  const title = spec.title(ctx, params)
  const sellOnly = spec.kind === 'exit' || spec.kind === 'floor'
  const doc: AuthDoc = {
    v: 2, kind: spec.kind, timeZone: zone, tzVersion: TZ_VERSION, title, may: d.may, limits: [...(d.limits ?? []), ...(sellOnly ? [] : limitLines(authority))],
    ceiling: sellOnly
      ? 'It can sell up to everything it names. It can never spend money, buy anything or pay anyone.'
      : `Taken together, the limits let it move at most ${amountText(ceilingPaise(authority, now))} before ${whenIn(authority.expiresAt, zone)}.`,
    ceilingPaise: sellOnly ? null : ceilingPaise(authority, now),
    notLimited: sellOnly
      ? ['The price it sells at: it takes what buyers offer, down to the tolerance stated above.', 'Venue fees and tax deducted at source on each sale.']
      : ['The price or NAV at which an order executes.', 'Venue fees, stamp duty and tax, which come out of the amounts above rather than on top of them, except a loan prepayment charge where one is named.'],
    conditions: d.conditions, never: d.never,
    mode: modeSentence(authority), ends: `This authority ends on ${whenIn(authority.expiresAt, zone)}. Nothing runs after that unless you sign again.`, stop: STOP,
    consequences: analysis.figures.map((g) => `${g.label}: ${g.value}${g.note ? ` (${g.note})` : ''}`),
    basis: [...analysis.inputs.map(basisLine), `Figures computed ${new Date(analysis.computedAt).toISOString()} from your recorded balances. All execution is on paper: no real money moves.`],
    params, authority,
  }
  const document = canonical(doc)
  return { kind: spec.kind, pillar: spec.pillar, title, params, authority, analysis, doc, document, contentHash: sha256hex(document), schedule: spec.schedule(params) }
}

/**
 * What follows from the version in force, worked out on today's records and prices. The figures an owner signed are
 * part of the signed document and never change; these are what the same instruction means now.
 */
export function currentAnalysis(ctx: Ctx, userId: string, programId: string, now: number): Analysis | null {
  const p = ctx.db.get<{ kind: string; live_version: number | null; state: string; next_due_at: number | null }>('SELECT kind, live_version, state, next_due_at FROM programs WHERE id = ? AND user_id = ?', programId, userId)
  if (!p || p.live_version === null || (p.state !== 'active' && p.state !== 'paused')) return null
  const v = ctx.db.get<{ params_json: string; authority_json: string }>('SELECT params_json, authority_json FROM program_versions WHERE program_id = ? AND version = ?', programId, p.live_version)
  if (!v) return null
  try {
    const a = kindSpec(p.kind).analyse(ctx, userId, JSON.parse(v.params_json) as Raw, JSON.parse(v.authority_json) as Authority, now, programId)
    // A draft's figure says when it would first run. An instruction in force has the time the engine holds for its
    // next run, which is a different time once it has run (an interval counts on from the last run, not from now),
    // and it has none while it is paused. The page's heading gives the same time from the same column.
    const next = p.state === 'active' ? p.next_due_at : null
    return { ...a, figures: a.figures.flatMap((f) => (f.label !== 'First run' ? [f] : next === null ? [] : [{ ...f, label: 'Next run', value: whenIn(next, (JSON.parse(v.params_json) as { schedule?: { zone?: string } }).schedule?.zone ?? DEFAULT_ZONE) }])) }
  }
  catch { return null } // an instrument that has left the register, for one: the page then shows the figures as signed
}

function programEvent(db: Db, programId: string, userId: string, kind: string, actor: string, detail: unknown, now: number): void {
  db.run('INSERT INTO program_events (program_id, user_id, ts, kind, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)', programId, userId, now, kind, actor, j(detail))
  emit(db, now, userId, 'program', { id: programId, event: kind })
}

export function loadProgram(db: Db, userId: string, id: string): ProgramRow {
  const r = db.get<Record<string, unknown>>('SELECT * FROM programs WHERE id = ? AND user_id = ?', id, userId)
  if (!r) throw notFound('That instruction')
  return rowToProgram(r)
}
export const rowToProgram = (r: Record<string, unknown>): ProgramRow => ({ id: String(r.id), user_id: String(r.user_id), kind: r.kind as ProgramKind, pillar: r.pillar as Pillar, title: String(r.title), state: String(r.state), live_version: (r.live_version as number | null) ?? null, next_due_at: (r.next_due_at as number | null) ?? null, memo: parse<Record<string, unknown>>(r.memo_json, {}), created_at: Number(r.created_at) })

/** Save a draft version: a new program, or a proposed amendment to an existing one. Nothing is authorised yet. */
export function saveDraft(ctx: Ctx, userId: string, input: { kind?: string; params: unknown; authority?: unknown; programId?: string; origin?: string }): { programId: string; version: number; draft: Draft } {
  const { db } = ctx
  const now = ctx.clock.now()
  return db.tx(() => {
    let programId = input.programId
    let kind = input.kind
    if (programId) {
      const p = loadProgram(db, userId, programId)
      if (p.state === 'revoked' || p.state === 'completed' || p.state === 'expired') throw refused('program_ended', 'That program has ended. Start a new one instead.')
      kind = p.kind
    }
    if (!kind) throw bad('Choose what kind of instruction this is.')
    // C6: no new draft from a replaced or withdrawn proposal (the editor route marks its proposal drafted afterwards,
    // which would otherwise hide the withdrawal from the approval check).
    const closed = programId ? null : closedProposal(db, userId, input.origin)
    if (closed) throw closed
    const draft = buildDraft(ctx, userId, kind, input.params, input.authority, now, programId)
    if (!programId) {
      programId = newId('prg', now)
      db.run(`INSERT INTO programs (id, user_id, kind, pillar, title, state, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`, programId, userId, draft.kind, draft.pillar, draft.title, input.origin ?? 'owner', now, now)
    }
    db.run(`UPDATE program_versions SET state = 'discarded' WHERE program_id = ? AND state = 'draft'`, programId)
    const version = (db.get<{ m: number | null }>('SELECT MAX(version) m FROM program_versions WHERE program_id = ?', programId)?.m ?? 0) + 1
    db.run(`INSERT INTO program_versions (program_id, version, params_json, authority_json, analysis_json, document, content_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      programId, version, j(draft.params), j(draft.authority), j(draft.analysis), draft.document, draft.contentHash, now)
    // How the session that saved this version was opened (RISK-076): a password session's draft says so when it is signed.
    recordPrepared(db, 'program-version', `${programId}@${version}`, userId, now)
    programEvent(db, programId, userId, version === 1 ? 'drafted' : 'amendment-drafted', 'owner', { version, contentHash: draft.contentHash }, now)
    return { programId, version, draft }
  })
}

/**
 * Ask for the owner's approval of the current draft. The figures are recomputed first, so what is shown and signed is
 * current; if they moved since the draft was saved, the draft version is replaced by one with the new document.
 */
/**
 * Contradictions in a draft that the owner must resolve, by changing the draft or by accepting each one explicitly,
 * before it can be sent for approval (R7-093). A schedule that asks for more each month than the monthly limit allows
 * (later runs would be refused); and, for a draft that came from a model's proposal, judged against the owner's terms
 * as they stood in the conversation (server/ai.ts standingTerms): a rupee figure the owner wrote that the draft does
 * not use anywhere (a limit may have been lost); a draft that can move more in all than a total the owner wrote, alone
 * or with the other drafts of the same question (X02); and authority that runs past the end the owner gave (C1).
 */
export interface Contradiction { id: string; text: string }
export function contradictionsOf(db: Db, userId: string, programId: string, kind: string, params: unknown, authority: Authority, now: number = Date.now()): Contradiction[] {
  const out: Contradiction[] = []
  const p = params as { amount?: number; schedule?: Schedule }
  if (kind === 'invest' && typeof p.amount === 'number' && p.schedule) {
    const perMonth = Math.round(monthlyRuns(p.schedule) * p.amount)
    if (perMonth > authority.maxPerMonth) out.push({ id: 'schedule-over-limit', text: `The schedule asks for about ${amountText(whole(perMonth))} a month and the monthly limit is ${amountText(authority.maxPerMonth)}: runs beyond the limit in a month will be refused, not postponed.` })
  }
  const origin = db.get<{ origin: string }>('SELECT origin FROM programs WHERE id = ? AND user_id = ?', programId, userId)?.origin ?? ''
  const m = /^proposal:(.+)$/.exec(origin)
  if (m) {
    const row = db.get<{ analysis_json: string; turn_id: string | null }>('SELECT analysis_json, turn_id FROM proposals WHERE id = ? AND user_id = ?', m[1]!, userId)
    const a = parse<{ ownerFigures?: number[]; ownerTotals?: number[]; ownerEndsAt?: number | null; ownerPeriod?: string | null }>(row?.analysis_json, {})
    const used = figuresIn({ params, authority })
    const ceiling = kind === 'exit' || kind === 'floor' ? null : ceilingPaise(authority, now)
    // A total the owner wrote is honoured by a ceiling within it, not by appearing as a number (X02).
    for (const f of a.ownerFigures ?? []) if (!used.has(f) && !(a.ownerTotals?.includes(f) && ceiling !== null && ceiling <= f)) out.push({ id: `dropped-figure-${f}`, text: `You wrote ${amountText(f)} when you asked, and this instruction does not use that figure anywhere. If it was a limit, it is not in force.` })
    const total = a.ownerTotals?.length ? Math.min(...a.ownerTotals) : null
    if (total !== null && ceiling !== null) {
      if (ceiling > total) out.push({ id: `ceiling-above-total-${total}`, text: `You wrote ${amountText(total)} in total, and this instruction can move up to ${amountText(ceiling)} before it ends. Lower its limits, or accept that the total you wrote is not in force.` })
      // The other drafts and instructions made from the same question count against the same total.
      const others = row?.turn_id ? db.all<{ id: string }>(`SELECT g.id FROM proposals x JOIN programs g ON g.origin = 'proposal:' || x.id AND g.user_id = x.user_id WHERE x.turn_id = ? AND x.user_id = ? AND g.id <> ? AND g.state IN ('draft', 'active', 'paused')`, row.turn_id, userId, programId) : []
      const theirs = others.reduce((sum, g) => { const doc = parse<{ ceilingPaise?: number | null }>(db.get<{ document: string }>(`SELECT document FROM program_versions WHERE program_id = ? AND state IN ('draft', 'live') ORDER BY version DESC LIMIT 1`, g.id)?.document, {}); return sum + (typeof doc.ceilingPaise === 'number' ? doc.ceilingPaise : 0) }, 0)
      if (others.length && ceiling <= total && ceiling + theirs > total) out.push({ id: `turn-total-${total}`, text: `You wrote ${amountText(total)} in total, and with the ${others.length === 1 ? 'other instruction' : `${others.length} other instructions`} from the same question this can move up to ${amountText(ceiling + theirs)} in all. Discard one, lower their limits, or accept that the total you wrote is not in force.` })
    }
    if (typeof a.ownerEndsAt === 'number' && authority.expiresAt > a.ownerEndsAt + 86_400_000) out.push({ id: 'period-longer-than-asked', text: `You asked for ${a.ownerPeriod ?? 'a shorter period'}, and this instruction's authority runs until ${whenIst(authority.expiresAt)}, after ${whenIst(a.ownerEndsAt)}. Set the end date yourself, or accept that the end you gave is not in force.` })
  }
  return out
}
/**
 * A draft that was never signed, made from a model's proposal that has since been replaced by a correction or
 * withdrawn, cannot be signed or activated (C6): the owner moved on from it. An instruction once in force stays the
 * owner's to amend, whatever has happened to the proposal it came from.
 */
function closedOrigin(db: Db, userId: string, p: ProgramRow): AppError | null {
  if (p.live_version !== null) return null
  return closedProposal(db, userId, db.get<{ origin: string }>('SELECT origin FROM programs WHERE id = ? AND user_id = ?', p.id, userId)?.origin)
}
/** The refusal for a draft origin ("proposal:<id>") whose proposal was replaced or withdrawn; null for any other. */
function closedProposal(db: Db, userId: string, origin: string | undefined): AppError | null {
  const m = /^proposal:(.+)$/.exec(origin ?? '')
  const state = m ? db.get<{ state: string }>('SELECT state FROM proposals WHERE id = ? AND user_id = ?', m[1]!, userId)?.state : undefined
  if (state === 'superseded') return refused('proposal_superseded', 'This came from a proposal that a later correction replaced, so it cannot be signed. Sign the corrected one, or write the instruction yourself.')
  if (state === 'dismissed') return refused('proposal_withdrawn', 'This came from a proposal that was withdrawn, so it cannot be signed. Ask again, or write the instruction yourself.')
  if (state === 'review') return refused('adviser_review_pending', 'A registered investment adviser has not yet reviewed this proposal, so it cannot be signed. It is in their queue.')
  if (state === 'declined') return refused('adviser_declined', 'A registered investment adviser declined this proposal, so it cannot be signed. Their reason is on the proposal.')
  return null
}
/** Who drafted an instruction that came from a model's proposal, in the words the signed document carries; null otherwise. */
export function draftedBy(db: Db, userId: string, programId: string, signed?: { kind: string; params: unknown }): string | null {
  const origin = db.get<{ origin: string }>('SELECT origin FROM programs WHERE id = ? AND user_id = ?', programId, userId)?.origin ?? ''
  const m = /^proposal:(.+)$/.exec(origin)
  if (!m) return null
  const p = db.get<{ origin: string; model: string | null; provider: string | null }>('SELECT p.origin, a.model, a.provider FROM proposals p LEFT JOIN ai_calls a ON a.id = p.ai_call_id WHERE p.id = ? AND p.user_id = ?', m[1]!, userId)
  if (!p || p.origin !== 'model') return null
  // A scripted test double (isolated test stacks only) or a unit test's double is not a model, and the signed document says so.
  if (p.provider === 'scripted' || p.provider === 'injected') return `A scripted test double, not a model, drafted this instruction from the owner's question (recorded as provider "${p.provider}", "${p.model ?? 'unrecorded'}"). ${(signed ? reviewedLine(db, m[1]!, signed) : null) ?? 'No licensed adviser reviewed it.'}`
  return `A model (${p.model ?? 'unrecorded'}) drafted this instruction from the owner's question. ${(signed ? reviewedLine(db, m[1]!, signed) : null) ?? 'No licensed adviser reviewed it.'}`
}
/** Every whole number in an instruction's parameters and limits, as paise (a paydown plan is written in rupees). */
export function figuresIn(v: unknown, rupees = false, out = new Set<number>()): Set<number> {
  if (typeof v === 'number' && Number.isFinite(v)) out.add(Math.round(rupees ? v * 100 : v))
  else if (Array.isArray(v)) for (const x of v) figuresIn(x, rupees, out)
  else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) figuresIn(x, rupees || k === 'plan', out)
  return out
}

/**
 * An instruction that has ended (revoked, completed, expired) takes no new version: saveDraft refuses one, and a draft
 * saved before the end can no longer be signed or put in force with a signature given before it (R13 review, R08).
 */
const ended = (p: { state: string }): AppError | null => (p.state === 'revoked' || p.state === 'completed' || p.state === 'expired' ? refused('program_ended', 'That program has ended. Start a new one instead.') : null)

export function requestProgramApproval(ctx: Ctx, userId: string, programId: string, acknowledge: string[] = []): { approvalId: string; version: number; draft: Draft; expiresAt: number; nonce: string; contradictions: Contradiction[] } {
  const { db } = ctx
  const now = ctx.clock.now()
  return db.tx(() => {
    const p = loadProgram(db, userId, programId)
    if (ENDED.has(p.state)) throw endedRefusal()
    const closed = closedOrigin(db, userId, p)
    if (closed) throw closed
    const v = db.get<{ version: number; params_json: string; authority_json: string }>(`SELECT version, params_json, authority_json FROM program_versions WHERE program_id = ? AND state = 'draft' ORDER BY version DESC LIMIT 1`, programId)
    if (!v) throw refused('no_draft', 'There is no draft to approve.')
    const draft = buildDraft(ctx, userId, p.kind, JSON.parse(v.params_json), JSON.parse(v.authority_json), now, programId)
    if (draft.analysis.refusals.length) throw new AppError(409, 'cannot_approve', draft.analysis.refusals[0]!, { refusals: draft.analysis.refusals.join(' | ') })
    const contradictions = contradictionsOf(db, userId, programId, p.kind, draft.params, draft.authority, now)
    const open = contradictions.filter((c) => !acknowledge.includes(c.id))
    if (open.length) throw new AppError(409, 'contradiction_unresolved', open[0]!.text, { contradictions: j(open) })
    // What the owner accepted, and who drafted it (N-006: a model, with no adviser's review), are part of the document
    // the passkey signs.
    const drafted = draftedBy(db, userId, programId, { kind: p.kind, params: draft.params })
    // A bills instruction for a payee that looks like another says so in what is signed, not only on screen (RISK-073)
    const looks = p.kind === 'bills' ? ((draft.params as { payeeHandles?: string[] }).payeeHandles ?? []).map((h) => {
      const y = db.get<{ name: string; handle: string }>('SELECT name, handle FROM payees WHERE user_id = ? AND handle = ?', userId, h)
      return y ? payeeWarning(db, userId, y) : null
    }).filter((w): w is string => !!w) : []
    // What a password session prepared (RISK-076): this request, the draft and the payees it names, in what is signed.
    const prepared = passwordWork(db, userId, { request: true, draft: { programId, version: v.version }, payeeHandles: p.kind === 'bills' ? (draft.params as { payeeHandles?: string[] }).payeeHandles ?? [] : [] }, now)
    if (contradictions.length || drafted || looks.length || prepared.length) {
      const doc = draft.doc as unknown as Record<string, unknown>
      if (contradictions.length) doc.accepted = contradictions.map((c) => c.text)
      if (drafted) doc.drafted = drafted
      if (looks.length) doc.payeesLookAlike = looks
      if (prepared.length) doc.prepared = prepared
      draft.document = canonical(draft.doc); draft.contentHash = sha256hex(draft.document)
    }
    // The terms are stored as they are signed: a goal's limits count the contribution days left, so a draft saved before
    // one passes is signed with one run fewer, and the runner refuses terms that differ from the signed document (RISK-064).
    // For every other kind the parameters and limits are those already stored, unchanged.
    db.run('UPDATE program_versions SET params_json = ?, authority_json = ?, analysis_json = ?, document = ?, content_hash = ? WHERE program_id = ? AND version = ?', j(draft.params), j(draft.authority), j(draft.analysis), draft.document, draft.contentHash, programId, v.version)
    // Its size is the most its authority can move before it ends (ceilingPaise), whatever the size of each run: an
    // instruction split into small runs needs the same signatures as one large payment (R13 review, R06).
    const a = createApproval(db, userId, { purpose: 'program-version', subject: `program:${programId}@${v.version}`, document: draft.document, sizePaise: ceilingPaise(draft.authority, now) }, now)
    return { approvalId: a.id, version: v.version, draft, expiresAt: a.expires_at, nonce: a.nonce, contradictions }
  })
}

/** States in which an instruction has ended for good: it is not amended, signed again or put back in force (saveDraft says so too). */
const ENDED = new Set(['revoked', 'completed', 'expired'])
const endedRefusal = (): AppError => refused('program_ended', 'That instruction has ended, so nothing can be signed or put in force under it. Start a new one instead.')
/** Withdraw every open request to sign a version of an instruction (not yet confirmed); a confirmed one is refused by activateProgram. */
function withdrawSigningRequests(db: Db, userId: string, programId: string, now: number): number {
  return db.run(`UPDATE approvals SET cancelled_at = ? WHERE user_id = ? AND purpose = 'program-version' AND subject LIKE ? AND confirmed_at IS NULL AND cancelled_at IS NULL`, now, userId, `program:${programId}@%`).changes
}

/** Make an approved draft the live version. The approval must be confirmed, unused, and for exactly this document. */
export function activateProgram(ctx: Ctx, userId: string, programId: string, approvalId: string): ProgramRow {
  const { db } = ctx
  const now = ctx.clock.now()
  return db.tx(() => {
    const p = loadProgram(db, userId, programId)
    if (ENDED.has(p.state)) throw endedRefusal()
    const closed = closedOrigin(db, userId, p)
    if (closed) throw closed
    const v = db.get<{ version: number; params_json: string; authority_json: string; document: string; content_hash: string }>(`SELECT version, params_json, authority_json, document, content_hash FROM program_versions WHERE program_id = ? AND state = 'draft' ORDER BY version DESC LIMIT 1`, programId)
    if (!v) throw refused('no_draft', 'There is no draft to activate.')
    consumeApproval(db, userId, approvalId, `program:${programId}@${v.version}`, sha256hex(v.document), now)
    const authority = JSON.parse(v.authority_json) as Authority
    if (authority.expiresAt <= now) throw refused('expired', 'The end date has already passed. Choose a later one.')
    const spec = kindSpec(p.kind)
    const params = JSON.parse(v.params_json) as Raw
    const schedule = spec.schedule(params)
    if (p.live_version !== null) {
      db.run(`UPDATE program_versions SET state = 'superseded' WHERE program_id = ? AND version = ?`, programId, p.live_version)
      cancelWaitingRuns(db, programId, 'A newer version of the instruction replaced the one this run belonged to.', now)
    }
    db.run(`UPDATE program_versions SET state = 'live', approved_at = ?, approval_id = ? WHERE program_id = ? AND version = ?`, now, approvalId, programId, v.version)
    const next = schedule ? firstDue(schedule, now) : spec.kind === 'paydown' ? now : null
    db.run(`UPDATE programs SET state = 'active', live_version = ?, title = ?, next_due_at = ?, paused_reason = NULL, memo_json = '{}', updated_at = ? WHERE id = ?`, v.version, spec.title(ctx, params), next, now, programId)
    registerPaperMandate(db, userId, programId, p.kind, now, signedOf(authority, Array.isArray(params.payeeHandles) ? (params.payeeHandles as string[]) : []))
    programEvent(db, programId, userId, p.live_version === null ? 'activated' : 'amended', 'owner', { version: v.version, contentHash: v.content_hash, approvalId, supersedes: p.live_version }, now)
    audit(db, now, userId, 'owner', 'program.activate', programId, { version: v.version, contentHash: v.content_hash })
    return loadProgram(db, userId, programId)
  })
}

function cancelWaitingRuns(db: Db, programId: string, reason: string, now: number): number {
  const waiting = db.all<{ id: string; user_id: string }>(`SELECT id, user_id FROM runs WHERE program_id = ? AND state IN ('due', 'awaiting_approval', 'objection_window')`, programId)
  for (const r of waiting) {
    db.run(`UPDATE runs SET state = 'cancelled', reason = ?, finished_at = ? WHERE id = ?`, reason, now, r.id)
    // The request to approve it, or the notice that it was about to run, is withdrawn with it.
    db.run('UPDATE notices SET resolved_at = ? WHERE user_id = ? AND resolved_at IS NULL AND dedupe LIKE ?', now, r.user_id, `run:${r.id}%`)
    emit(db, now, r.user_id, 'run', { id: r.id, programId, state: 'cancelled' })
  }
  return waiting.length
}

export function pauseProgram(ctx: Ctx, userId: string, programId: string, reason = 'Paused by you'): ProgramRow {
  const { db } = ctx; const now = ctx.clock.now()
  return db.tx(() => {
    const p = loadProgram(db, userId, programId)
    if (p.state !== 'active') throw refused('not_active', `That instruction is ${p.state}; only an active instruction can be paused.`)
    db.run(`UPDATE programs SET state = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?`, reason, now, programId)
    const cancelled = cancelWaitingRuns(db, programId, 'The instruction was paused before this run started.', now)
    programEvent(db, programId, userId, 'paused', 'owner', { reason, cancelledRuns: cancelled }, now)
    return loadProgram(db, userId, programId)
  })
}

export function resumeProgram(ctx: Ctx, userId: string, programId: string): ProgramRow {
  const { db } = ctx; const now = ctx.clock.now()
  return db.tx(() => {
    const p = loadProgram(db, userId, programId)
    if (p.state !== 'paused') throw refused('not_paused', `That instruction is ${p.state}; only a paused instruction can be resumed.`)
    const v = db.get<{ params_json: string; authority_json: string }>('SELECT params_json, authority_json FROM program_versions WHERE program_id = ? AND version = ?', programId, p.live_version)!
    if ((JSON.parse(v.authority_json) as Authority).expiresAt <= now) throw refused('expired', 'Its authority ended while it was paused. Sign a new version to continue.')
    const schedule = kindSpec(p.kind).schedule(JSON.parse(v.params_json) as Raw)
    db.run(`UPDATE programs SET state = 'active', paused_reason = NULL, next_due_at = ?, updated_at = ? WHERE id = ?`, schedule ? nextDue(schedule, now) : null, now, programId)
    programEvent(db, programId, userId, 'resumed', 'owner', { note: 'Runs that fell due while paused were not executed.' }, now)
    return loadProgram(db, userId, programId)
  })
}

/** End a program's authority for good. Takes effect at once; needs no approval because it only removes authority. */
export function revokeProgram(ctx: Ctx, userId: string, programId: string): ProgramRow {
  const { db } = ctx; const now = ctx.clock.now()
  return db.tx(() => {
    const p = loadProgram(db, userId, programId)
    if (p.state === 'revoked') return p
    // A draft of an amendment, and any request to sign a version, end with the instruction: until R13 an amendment's
    // request prepared before the revocation could still be approved, and put the revoked instruction back in force.
    db.run(`UPDATE program_versions SET state = 'discarded' WHERE program_id = ? AND state = 'draft'`, programId)
    withdrawSigningRequests(db, userId, programId, now)
    db.run(`UPDATE approvals SET cancelled_at = ? WHERE user_id = ? AND subject LIKE ? AND consumed_at IS NULL AND cancelled_at IS NULL`, now, userId, `program:${programId}@%`)
    db.run(`UPDATE programs SET state = 'revoked', next_due_at = NULL, updated_at = ? WHERE id = ?`, now, programId)
    const cancelled = cancelWaitingRuns(db, programId, 'You revoked the instruction before this run started.', now)
    programEvent(db, programId, userId, 'revoked', 'owner', { cancelledRuns: cancelled }, now)
    audit(db, now, userId, 'owner', 'program.revoke', programId)
    return loadProgram(db, userId, programId)
  })
}

export function discardDraft(ctx: Ctx, userId: string, programId: string): void {
  const { db } = ctx; const now = ctx.clock.now()
  db.tx(() => {
    const p = loadProgram(db, userId, programId)
    db.run(`UPDATE program_versions SET state = 'discarded' WHERE program_id = ? AND state = 'draft'`, programId)
    if (p.live_version === null) db.run(`UPDATE programs SET state = 'revoked', updated_at = ? WHERE id = ?`, now, programId)
    programEvent(db, programId, userId, 'draft-discarded', 'owner', {}, now)
  })
}

export { programEvent, whenIst }
