/**
 * Saving for a goal (R12 task comparison, gaps 5 and 14; criteria T3-a to T3-d).
 *
 * A goal is a name, an amount and a date. QED works out the monthly figure (shared/goal-math.ts) and offers it as a
 * standing instruction of the kind "goal" (programs.ts), signed with the passkey like every instruction and asking
 * first by default. Each run moves the monthly figure from the bank account into the goal's set-aside (setaside.ts): an
 * internal payment inside the paper bank, so it passes the same checks as every payment, including what must stay in
 * the bank for what falls due (liquidity.ts `staysLiquid`, the check behind Save's "Must stay in the bank"). No second
 * guard was written for set-aside money: nothing an instruction does draws on that account.
 *
 * On track follows one rule, said on the screen in these words: what is set aside now, plus every contribution still
 * scheduled before the date, reaches the target on that date; growth only under a rate the household names. When a goal
 * is behind, the remedies are figures that reach it when followed: more a month, a later date, or a sum now. When the
 * date passes or the target is reached nothing more is moved, and the money stays set aside until the owner releases it,
 * which needs a confirmed approval (a passkey) of its exact terms.
 *
 * This file does not import programs.ts (which uses it for the kind), so that neither waits on the other to load.
 */
import { approvalLapsed, consumeApproval, createApproval, getApproval, LAPSED_TEXT } from './approvals.ts'
import { addDays, AppError, audit, bad, type Db, emit, j, newId, notFound, parse, refused, whenIst } from './core.ts'
import { homeZone } from './home-currency.ts'
import { zonedInstant, zonedParts } from '../shared/zone.ts'
import { getProfile } from './household.ts'
import { post } from './ledger.ts'
import { dateText, limitAdvice, liquidity } from './liquidity.ts'
import type { Market } from './market.ts'
import type { Analysis, AuthDoc } from './programs.ts'
import { issueReceipt, sha256hex } from './receipts.ts'
import { firstDue, nextDue } from './schedule.ts'
import { goalAccount, onItsWay, SETASIDE_HANDLE, setAside } from './setaside.ts'
import type { Authority, Ctx, PaymentParams, PlannedAction } from './types.ts'
import { worstCase } from './valuation.ts'
import { type GoalRun, monthlyFor, project, type Remedies, remedies } from '../shared/goal-math.ts'
import { canonical } from '../shared/sha256.ts'
import { homeMoneyExact } from '../shared/home-money.ts'
import { householdHome } from './home-currency.ts'

const DAY = 86_400_000
/** Contributions are made at this time of their day (India time): after the morning's salary, before the day's spending. */
export const GOAL_AT = '10:00'
/** The latest a goal may be set: an instruction's authority lasts at most 400 days, and it runs to the end of the date. */
export const MAX_GOAL_DAYS = 395
export const latestGoalDate = (today: string): string => addDays(today, MAX_GOAL_DAYS)
/** A goal's instruction holds authority until the end of its date, India time. */
/** Days are counted in the household's zone (India's unless it chose another). */
const local = (ms: number) => zonedParts(ms, homeZone())
const localInstant = (date: string, hm: string): number => zonedInstant(date, hm, homeZone())
export const goalEnds = (date: string): number => localInstant(date, '23:59')

export interface GoalParams { name: string; target: number; date: string; schedule: { type: 'monthly'; day: number; at: string }; amount: number; growthBps: number }

// ------------------------------------------------------------------------------------------------ when contributions fall

/** The day of the month the household's salary arrives on, as the books show it: the latest salary entered, else the profile's. */
export function salaryDay(db: Db, userId: string): number | null {
  const last = db.get<{ t: number }>(`SELECT effective_ts t FROM entries WHERE user_id = ? AND kind = 'income-salary' ORDER BY effective_ts DESC LIMIT 1`, userId)
  if (last) return local(last.t).d
  const p = getProfile(db, userId)
  return p.income > 0 ? p.incomeDay : null
}
/** The day QED proposes for contributions: the day after the salary arrives (a day every month has), or the 1st. */
export function defaultDay(db: Db, userId: string): number {
  const d = salaryDay(db, userId)
  return d === null || d >= 28 ? 1 : d + 1
}

/** The India dates of a monthly schedule's runs from `now` until `until`, oldest first. */
export function contributionDates(schedule: GoalParams['schedule'], now: number, until: number): string[] {
  const out: string[] = []
  for (let t = firstDue(schedule, now), i = 0; t !== null && t <= until && i < 40; t = nextDue(schedule, t), i++) out.push(local(t).date)
  return out
}

// ------------------------------------------------------------------------------------------------ the kind's parts (used by programs.ts)

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const held = (db: Db, userId: string, goalId: string): number => (goalId ? setAside(db, userId, goalId) + onItsWay(db, userId, goalId) : 0)

/**
 * Validate a goal and settle its monthly figure. Without a figure given, it is QED's: the least whole rupee a month that
 * reaches the target by the date, on what is already set aside (`self` is the goal's instruction when it is amended).
 * A figure is stored with the version, so the document the owner signs and the runs under it never move.
 */
export function parseGoal(db: Db, userId: string, raw: Record<string, unknown>, now: number, self = ''): GoalParams {
  const errors: Record<string, string> = {}
  const err = (field: string, message: string): void => { if (!errors[field]) errors[field] = message }
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  if (!name) err('name', 'Say what it is for, in a few words.')
  const target = raw.target
  if (typeof target !== 'number' || !Number.isSafeInteger(target)) err('target', 'Enter the amount you want to have set aside.')
  else if (target < 10_000) err('target', 'The amount must be at least ₹100.')
  else if (target > 100_000_000_000) err('target', 'The amount is too large.')
  const today = local(now).date, latest = latestGoalDate(today)
  const date = isDate(raw.date) ? raw.date : ''
  if (!date) err('date', 'Choose the date you want it by.')
  else if (date <= today) err('date', 'Choose a date after today.')
  else if (date > latest) err('date', `Choose a date no later than ${dateText(latest)}: an instruction's authority lasts at most 400 days. For a goal further off, save toward part of it by then and sign again for the rest.`)
  let day = defaultDay(db, userId)
  const s = raw.schedule as Record<string, unknown> | null | undefined
  if (s !== undefined && s !== null) {
    if (typeof s !== 'object' || s.type !== 'monthly' || typeof s.day !== 'number' || !Number.isInteger(s.day) || s.day < 1 || s.day > 28) err('schedule', 'Choose a day from 1 to 28, so that it falls in every month.')
    else day = s.day
  }
  const growthBps = raw.growthBps === undefined || raw.growthBps === null ? 0 : raw.growthBps
  if (typeof growthBps !== 'number' || !Number.isInteger(growthBps) || growthBps < 0 || growthBps > 1500) err('growthBps', 'The growth you assume is in hundredths of a percent a year, a whole number from 0 to 1500 (15%).')
  if (Object.keys(errors).length) throw bad('Some values need attention.', errors)
  const schedule = { type: 'monthly' as const, day, at: GOAL_AT }
  const runs = contributionDates(schedule, now, goalEnds(date))
  if (runs.length === 0) err('date', `No contribution day falls between now and ${dateText(date)}: choose a later date, or an earlier day of the month.`)
  const have = held(db, userId, self)
  let amount = 0
  if (raw.amount !== undefined && raw.amount !== null) {
    if (typeof raw.amount !== 'number' || !Number.isSafeInteger(raw.amount) || raw.amount < 100 || raw.amount > (target as number)) err('amount', 'The monthly figure must be a whole number of paise, at least ₹1 and no more than the amount.')
    else amount = raw.amount
  } else if (runs.length) {
    const m = monthlyFor({ target: target as number, balance: have, growthBps: growthBps as number, today, date, runs: runs.map((d) => ({ date: d })), day, latest })
    if (m === null || m <= 0) err('target', `${homeMoneyExact(have)} is already set aside for it: nothing more is needed.`)
    else amount = m
  }
  if (Object.keys(errors).length) throw bad('Some values need attention.', errors)
  return { name, target: target as number, date, schedule, amount, growthBps: growthBps as number }
}

export const goalTitle = (p: GoalParams): string => `Save ${homeMoneyExact(p.target)} for ${p.name} by ${dateText(p.date)}`

/**
 * What a goal's instruction may do is the goal itself: the monthly figure, once a month, as many times as contributions
 * fall before its date, until the end of that date. So the most its signed limits let it move in all is the goal (the
 * monthly figure was rounded up to the rupee, so it can be a few rupees over), not every calendar month's limit.
 */
export function goalAuthority(p: GoalParams, a: Partial<Authority>, now: number): Authority {
  const runs = contributionDates(p.schedule, now, goalEnds(p.date)).length
  return {
    maxPerRun: p.amount, maxPerMonth: p.amount, maxPerDay: null, maxRuns: runs > 0 ? runs : null, maxSlippageBps: 100,
    expiresAt: Math.min(goalEnds(p.date), now + 400 * DAY - 60_000),
    runMode: a.runMode ?? 'approve', noticeSec: a.runMode === 'notify' ? a.noticeSec ?? 86_400 : 0,
  }
}

const growthWords = (bps: number): string => (bps > 0 ? `${(bps / 100).toFixed(2)}% a year, as you assume; money set aside here earns no interest on paper` : 'none counted')
/** The on-track rule, in the words the household reads (T3-b). */
export const ruleText = (p: Pick<GoalParams, 'date' | 'target' | 'growthBps'>): string => `On track means: what is set aside now, plus every contribution still scheduled before ${dateText(p.date)}, reaches ${homeMoneyExact(p.target)} on that date. Growth: ${growthWords(p.growthBps)}.`
const ordinal = (d: number): string => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`

/** What follows from a goal's instruction, on today's records. */
export function analyseGoal(db: Db, market: Market, userId: string, p: GoalParams, a: Authority, now: number, self = ''): Analysis {
  const today = local(now).date
  const have = held(db, userId, self)
  const runs = contributionDates(p.schedule, now, Math.min(goalEnds(p.date), a.expiresAt))
  const pr = project({ target: p.target, balance: have, monthly: p.amount, growthBps: p.growthBps, today, date: p.date, runs: runs.map((d) => ({ date: d })), day: p.schedule.day, latest: latestGoalDate(today) })
  const warnings: string[] = [], refusals: string[] = []
  if (!pr.onTrack) warnings.push(`At ${homeMoneyExact(p.amount)} a month it would be ${homeMoneyExact(pr.shortfall)} short of ${homeMoneyExact(p.target)} on ${dateText(p.date)}.`)
  if (p.growthBps > 0) warnings.push(`Money set aside here earns no interest on paper. The ${(p.growthBps / 100).toFixed(2)}% a year you assume is counted only in whether it is on track${pr.growth > 0 ? `: ${homeMoneyExact(pr.growth)} of the ${homeMoneyExact(pr.projected)}` : ''}.`)
  if (runs.length === 0) refusals.push(`No contribution day falls between now and ${dateText(p.date)}.`)
  // the same check as every payment from the bank: a contribution may not take what must stay for what falls due
  const liq = liquidity(db, userId, now)
  if (liq.available - p.amount < liq.need) warnings.push(`Today a contribution would be refused: ${homeMoneyExact(liq.need)} must stay in your bank account for what is due${liq.binding ? ` by ${dateText(liq.binding.date)}` : ''}, and ${homeMoneyExact(Math.max(0, liq.free))} of the ${homeMoneyExact(liq.available)} there is free.`)
  else {
    const advice = limitAdvice(db, userId, now, a, p.schedule, self)
    if (!advice.holds) warnings.push(`If every contribution is made, your bank account could not meet what falls due on ${dateText(advice.shortOn ?? today)}. A contribution is refused before that happens.`)
  }
  const w = worstCase(db, market, userId, now)
  const first = runs[0], last = runs[runs.length - 1]
  const firstAt = firstDue(p.schedule, now)
  return {
    tier: 'bounded', tierReason: 'Bounded by the goal: its monthly figure, once a month, until its date. It moves money only between your own accounts, into a set-aside no instruction can spend.',
    headline: pr.onTrack ? `${homeMoneyExact(p.amount)} a month reaches ${homeMoneyExact(p.target)} by ${dateText(p.date)}` : `${homeMoneyExact(pr.shortfall)} short on ${dateText(p.date)} at ${homeMoneyExact(p.amount)} a month`,
    figures: [
      { label: 'Each month', value: homeMoneyExact(p.amount), basis: 'recorded', note: `Worked out by QED: what is left of ${homeMoneyExact(p.target)} over the ${runs.length} contribution${runs.length === 1 ? '' : 's'} before ${dateText(p.date)}, rounded up to the rupee. The last one moves only what is left` },
      { label: 'Set aside now', value: homeMoneyExact(have), basis: 'recorded', note: 'In the set-aside, or on its way to it' },
      { label: 'Still scheduled', value: homeMoneyExact(pr.scheduled), basis: 'recorded', note: first ? `${runs.length} contribution${runs.length === 1 ? '' : 's'} on the ${ordinal(p.schedule.day)}, ${dateText(first)}${last && last !== first ? ` to ${dateText(last)}` : ''}` : 'None before the date' },
      { label: `On ${dateText(p.date)}`, value: homeMoneyExact(pr.projected), basis: p.growthBps > 0 ? 'modelled' : 'recorded', note: pr.onTrack ? `On track for ${homeMoneyExact(p.target)}` : `${homeMoneyExact(pr.shortfall)} short of ${homeMoneyExact(p.target)}` },
      { label: 'Growth counted', value: p.growthBps > 0 ? `${(p.growthBps / 100).toFixed(2)}% a year` : 'None', basis: p.growthBps > 0 ? 'modelled' : 'recorded', note: p.growthBps > 0 ? 'Your assumption; the set-aside earns no interest on paper' : 'None is counted unless you name a rate' },
      ...(firstAt ? [{ label: 'First run', value: whenIst(firstAt), basis: 'recorded' as const }] : []),
    ],
    consequences: [
      `On the ${ordinal(p.schedule.day)} of each month QED moves ${homeMoneyExact(p.amount)} from your bank account into a set-aside for ${p.name}, inside the same paper bank. The last contribution moves only what is left, so the set-aside never goes past ${homeMoneyExact(p.target)}.`,
      'Money in the set-aside is not free to use, and no instruction can spend it, this one included. It stays there until you release it, and releasing needs your passkey.',
      'A contribution is refused if it would take money that must stay in your bank for what falls due; the refusal and its reason are on the record.',
      ruleText(p),
      `When ${homeMoneyExact(p.target)} is set aside, or ${dateText(p.date)} has passed, nothing more is moved, and the money stays set aside until you release it.`,
    ],
    warnings, refusals, inputs: [], worst: { before: w.gHat, after: w.gHat, line: w.line, illustrative: w.illustrative, valid: w.valid }, computedAt: now,
  }
}

export function goalDoc(p: GoalParams): Pick<AuthDoc, 'may' | 'conditions' | 'never'> {
  return {
    may: [`Move ${homeMoneyExact(p.amount)} from your bank account into the set-aside for ${p.name} on day ${p.schedule.day} of each month, until ${dateText(p.date)} or until ${homeMoneyExact(p.target)} is set aside.`],
    conditions: [
      'Only if the money is free in your bank account at that moment: what is left must still cover everything due before your income is certain to arrive.',
      `The last contribution moves only what is left to reach ${homeMoneyExact(p.target)}.`,
      'Only into this set-aside, inside your own paper bank. Nothing leaves the bank.',
    ],
    never: ['Spend, invest or pay anyone with the money set aside: no instruction can, this one included.', 'Move money out of the set-aside: only you can, with your passkey.', 'Act after the end date, or while paused or revoked.', 'Exceed any limit above, whatever the reason.'],
  }
}

/** One run: the monthly figure, or what is left when that is less; nothing once the target is set aside. */
export function planGoal(db: Db, userId: string, goalId: string, p: GoalParams): { actions: PlannedAction[]; skip?: string } {
  const have = held(db, userId, goalId)
  const left = p.target - have
  if (left <= 0) return { actions: [], skip: `Nothing to move: ${homeMoneyExact(have)} is set aside for ${p.name}, the whole of ${homeMoneyExact(p.target)}.` }
  const amount = Math.min(p.amount, left)
  return { actions: [{ kind: 'payment', venue: 'paper-rail', summary: `Set aside ${homeMoneyExact(amount)} for ${p.name}`, params: { payeeHandle: SETASIDE_HANDLE, payeeName: p.name, amount: String(amount), purpose: 'goal', goalId } satisfies PaymentParams }] }
}

/** Whether a goal's target is set aside (the instruction then completes). */
export const goalReached = (db: Db, userId: string, goalId: string, p: { target: number }): boolean => setAside(db, userId, goalId) >= p.target

/** What the notice says when a goal is reached, or its date passes, about the money. */
export function goalEndWords(db: Db, userId: string, goalId: string, p: GoalParams, why: 'reached' | 'date'): { title: string; body: string } {
  const have = setAside(db, userId, goalId)
  const stays = 'It stays set aside until you release it, and releasing needs your passkey.'
  if (why === 'reached') return { title: `${p.name}: reached`, body: `${homeMoneyExact(have)} is set aside for ${p.name}. Nothing more will be moved. ${stays}` }
  return { title: `${p.name}: its date has passed`, body: have > 0 ? `The date for ${p.name}, ${dateText(p.date)}, has passed with ${homeMoneyExact(have)} set aside for it${have < p.target ? `, ${homeMoneyExact(p.target - have)} short of ${homeMoneyExact(p.target)}` : ''}. Nothing more will be moved. ${stays}` : `The date for ${p.name}, ${dateText(p.date)}, has passed with nothing set aside for it. Nothing more will be moved.` }
}

// ------------------------------------------------------------------------------------------------ on track, and what to do when it is not

export type GoalStatus = 'draft' | 'on-track' | 'behind' | 'reached' | 'date-passed' | 'stopped'
export interface GoalView {
  id: string; title: string; state: string; status: GoalStatus; paused: boolean; hasDraft: boolean
  name: string; target: number; date: string; day: number; monthly: number; growthBps: number; runMode: string | null; noticeSec: number
  /** In the set-aside now, and on its way to it. */
  setAside: number; onItsWay: number
  /** A contribution waiting for the owner's answer, counted as scheduled. */
  waiting: { runId: string; amount: number; state: string; deadline: number | null } | null
  scheduled: { count: number; amount: number; first: string | null; last: string | null }
  next: number | null
  growth: number; projected: number; shortfall: number
  remedies: Remedies | null
  /** "₹4,167 more a month, or 2 Apr 2027 instead of 31 Mar 2027, or ₹12,500 now." */
  remedyText: string | null
  /** Paused: whether resuming alone brings it back on track. */
  resumeEnough: boolean | null
  rule: string; ifNothing: string; latest: string
}

type ProgRow = { id: string; title: string; state: string; live_version: number | null; next_due_at: number | null }
function versionOf(db: Db, p: ProgRow): { params: GoalParams; authority: Authority } | null {
  const v = p.live_version !== null
    ? db.get<{ params_json: string; authority_json: string }>('SELECT params_json, authority_json FROM program_versions WHERE program_id = ? AND version = ?', p.id, p.live_version)
    : db.get<{ params_json: string; authority_json: string }>(`SELECT params_json, authority_json FROM program_versions WHERE program_id = ? AND state = 'draft' ORDER BY version DESC LIMIT 1`, p.id)
  const params = parse<GoalParams | null>(v?.params_json, null), authority = parse<Authority | null>(v?.authority_json, null)
  return params && authority ? { params, authority } : null
}

export function goalView(db: Db, userId: string, goalId: string, now: number): GoalView | null {
  const p = db.get<ProgRow>(`SELECT id, title, state, live_version, next_due_at FROM programs WHERE id = ? AND user_id = ? AND kind = 'goal'`, goalId, userId)
  if (!p) return null
  const v = versionOf(db, p)
  if (!v) return null
  const g = v.params
  const today = local(now).date, latest = latestGoalDate(today)
  const inBank = setAside(db, userId, p.id), moving = onItsWay(db, userId, p.id), have = inBank + moving
  const signed = p.live_version !== null
  const inForce = signed && (p.state === 'active' || p.state === 'paused')
  const w = p.state === 'active' ? db.get<{ id: string; state: string; deadline_at: number | null; decision_json: string }>(`SELECT id, state, deadline_at, decision_json FROM runs WHERE program_id = ? AND state IN ('awaiting_approval', 'objection_window') ORDER BY created_at DESC LIMIT 1`, p.id) : undefined
  const waitAmount = w ? Number((parse<{ actions?: { params?: { amount?: string } }[] }>(w.decision_json, {}).actions?.[0]?.params?.amount) ?? 0) : 0
  const waiting = w && waitAmount > 0 ? { runId: w.id, amount: waitAmount, state: w.state, deadline: w.deadline_at } : null
  // what a version in force would still do: the schedule from now, within its authority (re-signing starts the same way)
  const future = contributionDates(g.schedule, now, Math.min(goalEnds(g.date), signed ? v.authority.expiresAt : goalEnds(g.date)))
  const base = { target: g.target, balance: have, monthly: g.amount, growthBps: g.growthBps, today, date: g.date, day: g.schedule.day, latest }
  const runsNow: GoalRun[] = !signed ? future.map((d) => ({ date: d })) : p.state === 'active' ? [...(waiting ? [{ date: today, amount: waiting.amount }] : []), ...future.map((d) => ({ date: d }))] : []
  const pr = project({ ...base, runs: runsNow })
  const status: GoalStatus = have >= g.target ? 'reached' : !signed ? 'draft' : today > g.date ? 'date-passed' : !inForce ? 'stopped' : pr.onTrack ? 'on-track' : 'behind'
  // remedies: "more" and "later" are made by signing again, which starts from the schedule's next day (and replaces a
  // request still waiting); "now" is a payment by hand, which leaves the schedule and any waiting request as they are
  let rem: Remedies | null = null, resumeEnough: boolean | null = null, remedyText: string | null = null
  if (status === 'behind') {
    const fresh = remedies({ ...base, runs: future.map((d) => ({ date: d })) })
    const now_ = remedies({ ...base, runs: p.state === 'active' ? runsNow : future.map((d) => ({ date: d })) }).now
    const paused = p.state === 'paused'
    if (paused) resumeEnough = project({ ...base, runs: future.map((d) => ({ date: d })) }).onTrack
    rem = resumeEnough ? null : { more: fresh.more, later: fresh.later, now: now_ }
    const parts = rem ? [rem.more ? `${homeMoneyExact(rem.more.extra)} more a month` : null, rem.later ? `${dateText(rem.later.date)} instead of ${dateText(g.date)}` : null, rem.now ? `${homeMoneyExact(rem.now.amount)} now` : null].filter((x): x is string => !!x) : []
    remedyText = paused
      ? resumeEnough ? `Resume it: ${homeMoneyExact(g.amount)} a month then reaches ${homeMoneyExact(g.target)} by ${dateText(g.date)}.` : `Resume it, and ${parts.join(', or ')}.`
      : parts.length ? `${parts.join(', or ')}.` : null
  }
  const by = `by ${dateText(g.date)}`
  const stays = 'It stays set aside until you release it, and releasing needs your passkey.'
  const comes = (x: number): string => (x > 0 ? `${homeMoneyExact(x)} will be set aside ${by}` : `nothing will be set aside ${by}`)
  const ifNothing = status === 'reached' ? `${homeMoneyExact(have)} is set aside, the whole of ${homeMoneyExact(g.target)}. Nothing more is moved. ${stays}`
    : status === 'date-passed' ? (have > 0 ? `The date has passed with ${homeMoneyExact(have)} set aside, ${homeMoneyExact(g.target - have)} short of ${homeMoneyExact(g.target)}. Nothing more is moved. ${stays}` : 'The date has passed with nothing set aside. Nothing more is moved.')
    // ended without reaching it: revoked by the owner, or every contribution signed for made (money released meanwhile)
    : status === 'stopped' ? (p.state === 'revoked'
      ? (have > 0 ? `You stopped saving for this. ${homeMoneyExact(have)} stays set aside until you release it, and releasing needs your passkey.` : 'You stopped saving for this. Nothing is set aside.')
      : `Every contribution it was signed for has been made${have > 0 ? `, and ${homeMoneyExact(have)} is set aside, ${homeMoneyExact(g.target - have)} short of ${homeMoneyExact(g.target)}. It stays set aside until you release it, and releasing needs your passkey` : ', and nothing is set aside'}. To save the rest, write a new goal.`)
    : status === 'draft' ? `Nothing happens until you sign it. Signed now, ${homeMoneyExact(g.amount)} a month ${pr.onTrack ? `reaches ${homeMoneyExact(g.target)} ${by}` : `comes to ${homeMoneyExact(pr.projected)} ${by}, ${homeMoneyExact(pr.shortfall)} short`}.`
    // "if nothing is done" holds only if each contribution is made: one that asks first needs a yes each time, so it is said
    : status === 'on-track' ? `If every contribution still scheduled is made, ${comes(pr.projected)}, as planned.${pr.projected > 0 ? ' It stays set aside until you release it.' : ''}`
    : `${p.state === 'paused' ? 'It is paused, so nothing more is set aside. If you change nothing, ' : pr.scheduled > 0 ? 'If you change nothing and every contribution still scheduled is made, ' : 'If you change nothing, '}${comes(pr.projected)}, ${homeMoneyExact(pr.shortfall)} short of ${homeMoneyExact(g.target)}.${pr.projected > 0 ? ' It stays set aside until you release it.' : ''}`
  const next = p.state === 'active' ? p.next_due_at : null
  return {
    id: p.id, title: p.title, state: p.state, status, paused: p.state === 'paused', hasDraft: signed && !!db.get(`SELECT 1 FROM program_versions WHERE program_id = ? AND state = 'draft'`, p.id),
    name: g.name, target: g.target, date: g.date, day: g.schedule.day, monthly: g.amount, growthBps: g.growthBps, runMode: v.authority.runMode ?? null, noticeSec: v.authority.noticeSec ?? 0,
    setAside: inBank, onItsWay: moving, waiting,
    scheduled: { count: pr.contributions.filter((c) => c.amount > 0).length, amount: pr.scheduled, first: pr.contributions.find((c) => c.amount > 0)?.date ?? null, last: [...pr.contributions].reverse().find((c) => c.amount > 0)?.date ?? null },
    next, growth: pr.growth, projected: status === 'reached' ? have : pr.projected, shortfall: status === 'reached' ? 0 : pr.shortfall,
    remedies: rem, remedyText, resumeEnough, rule: ruleText(g), ifNothing, latest,
  }
}

const ORDER: Record<GoalStatus, number> = { behind: 0, 'on-track': 1, draft: 2, reached: 3, 'date-passed': 4, stopped: 5 }
/** Every goal worth showing: those in force or drafted, and ended ones while money is still set aside for them. */
export function goalsView(db: Db, userId: string, now: number): { goals: GoalView[]; defaultDay: number; salaryDay: number | null; latest: string; today: string } {
  const ids = db.all<{ id: string; state: string }>(`SELECT id, state FROM programs WHERE user_id = ? AND kind = 'goal' ORDER BY created_at`, userId)
  const goals = ids.map((r) => goalView(db, userId, r.id, now)).filter((g): g is GoalView => !!g && (['active', 'paused', 'draft'].includes(g.state) || g.setAside + g.onItsWay > 0))
  goals.sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const today = local(now).date
  return { goals, defaultDay: defaultDay(db, userId), salaryDay: salaryDay(db, userId), latest: latestGoalDate(today), today }
}

/** Home asks about a goal only when it falls behind: a need, with what brings it back and what happens if nothing is done. */
export function goalNeeds(db: Db, userId: string, now: number): { type: 'goal-behind'; programId: string; title: string; detail: string; deadline: null; ifNothing: string }[] {
  return goalsView(db, userId, now).goals.filter((g) => g.status === 'behind').map((g) => ({
    type: 'goal-behind' as const, programId: g.id, title: `${g.name} is behind`, detail: `To catch up: ${g.remedyText ?? 'sign it again with a later date.'}`, deadline: null, ifNothing: g.ifNothing,
  }))
}

/** One of the owner's goals that has been signed at least once (money may be set aside for it by hand), or null. */
export function signedGoal(db: Db, userId: string, goalId: string): { id: string; name: string; target: number } | null {
  const p = db.get<ProgRow>(`SELECT id, title, state, live_version, next_due_at FROM programs WHERE id = ? AND user_id = ? AND kind = 'goal' AND live_version IS NOT NULL`, goalId, userId)
  const v = p ? versionOf(db, p) : null
  return p && v ? { id: p.id, name: v.params.name, target: v.params.target } : null
}

// ------------------------------------------------------------------------------------------------ releasing the money

function goalRow(db: Db, userId: string, goalId: string): { id: string; name: string } {
  const p = db.get<ProgRow>(`SELECT id, title, state, live_version, next_due_at FROM programs WHERE id = ? AND user_id = ? AND kind = 'goal'`, goalId, userId)
  const v = p ? versionOf(db, p) : null
  if (!p || !v) throw notFound('That goal')
  return { id: p.id, name: v.params.name }
}

/**
 * Prepare a release: the exact terms the owner's passkey will sign (how much, from which set-aside, to the bank account,
 * what stays). Nothing moves until that approval is confirmed and used by `releaseSetAside`.
 */
export function prepareRelease(ctx: Ctx, userId: string, goalId: string, raw: { amount?: unknown }): { approvalId: string; document: string; docHash: string; expiresAt: number; requiresStepUp: boolean; summary: string; lines: { label: string; value: string; basis: string; note?: string }[] } {
  const { db } = ctx
  const now = ctx.clock.now()
  const g = goalRow(db, userId, goalId)
  const have = setAside(db, userId, goalId)
  if (have <= 0) throw refused('nothing_set_aside', `Nothing is set aside for ${g.name}.`)
  const amount = raw.amount === undefined || raw.amount === null ? have : raw.amount
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw bad('Enter the amount to release.', { amount: 'Enter the amount to release, in rupees.' })
  if (amount > have) throw bad(`Only ${homeMoneyExact(have)} is set aside for ${g.name}.`, { amount: `Only ${homeMoneyExact(have)} is set aside.` })
  const economicId = newId('rel', now)
  const summary = `Release ${homeMoneyExact(amount)} from the set-aside for ${g.name}`
  const lines = [
    { label: 'From', value: `The set-aside for ${g.name}`, basis: 'exact' },
    { label: 'To', value: 'Your bank account', basis: 'exact', note: 'Inside your own paper bank: no real money moves' },
    { label: 'Amount', value: homeMoneyExact(amount), basis: 'exact' },
    { label: 'Stays set aside', value: homeMoneyExact(have - amount), basis: 'exact' },
    { label: 'Once you approve', value: 'It is back in your bank account at once, free to use', basis: 'rule', note: 'An instruction may then use it within its limits. The goal\'s instruction carries on as you signed it.' },
  ]
  const document = canonical({
    v: 2, kind: 'goal-release', currency: householdHome(db, userId), economicId, goalId, goal: g.name, sizePaise: amount, what: summary,
    from: `The set-aside for ${g.name}`, to: 'Your bank account', stays: have - amount, lines,
    note: 'Approving releases exactly this, once. It is checked again against what is set aside at the moment it is made. On paper: no real money moves.',
  })
  const a = createApproval(db, userId, { purpose: 'goal-release', subject: `goal-release:${economicId}`, document, requiresStepUp: true }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, requiresStepUp: true, summary, lines }
}

/** Make a release the owner approved: once, for exactly the approved terms, recorded in the ledger, the audit log and a receipt. */
export function releaseSetAside(ctx: Ctx, userId: string, goalId: string, approvalId: string): { released: number; setAside: number } {
  const { db } = ctx
  const now = ctx.clock.now()
  const a = getApproval(db, userId, approvalId)
  if (!a || a.purpose !== 'goal-release') throw notFound('That approval')
  if (!a.confirmed_at) throw refused('approval_missing', 'Confirm the approval with your passkey first.')
  if (a.consumed_at) throw refused('approval_used', 'That approval has already been used.')
  if (approvalLapsed(a, now)) throw refused('approval_expired', LAPSED_TEXT)
  if (sha256hex(a.document) !== a.doc_hash) throw new AppError(500, 'approval_corrupt', 'The stored document does not match its hash. Nothing was done.')
  const doc = JSON.parse(a.document) as { kind: string; economicId: string; goalId: string; goal: string; sizePaise: number; what: string }
  if (doc.kind !== 'goal-release' || doc.goalId !== goalId || a.subject !== `goal-release:${doc.economicId}`) throw refused('approval_mismatch', 'That approval was given for something else.')
  goalRow(db, userId, goalId)
  return db.tx(() => {
    const have = setAside(db, userId, goalId)
    if (have < doc.sizePaise) throw refused('set_aside_changed', `Only ${homeMoneyExact(have)} is set aside for ${doc.goal} now, so nothing was released. Prepare the release again.`)
    consumeApproval(db, userId, approvalId, a.subject, a.doc_hash, now)
    const e = post(db, { userId, ts: now, kind: 'goal-release', ref: `goal-release:${doc.economicId}`, memo: `Released from the set-aside for ${doc.goal}`, meta: { goalId, approvalId, enteredByOwner: true, paper: true },
      lines: [{ account: 'bank', amount: BigInt(doc.sizePaise) }, { account: goalAccount(goalId), amount: -BigInt(doc.sizePaise) }] })
    db.run('INSERT INTO program_events (program_id, user_id, ts, kind, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)', goalId, userId, now, 'released', 'owner', j({ amount: doc.sizePaise, approvalId, entry: e.seq }))
    audit(db, now, userId, 'owner', 'goal.release', goalId, { amount: doc.sizePaise, approvalId, docHash: a.doc_hash, entry: e.seq })
    issueReceipt(db, userId, 'goal-release', goalId, {
      what: doc.what, outcome: 'done', origin: 'owner', goal: { id: goalId, name: doc.goal }, amount: String(doc.sizePaise),
      approval: { id: a.id, documentHash: a.doc_hash, method: a.method, confirmedAt: a.confirmed_at }, ledgerEntries: [e.seq],
    }, now)
    emit(db, now, userId, 'program', { id: goalId, event: 'released' })
    return { released: doc.sizePaise, setAside: have - doc.sizePaise }
  })
}
