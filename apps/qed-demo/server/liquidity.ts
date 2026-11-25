/**
 * Liquidity: what must stay in the bank so that everything already due is met, on the worst arrival of income the
 * owner has said to allow for.
 *
 * The protection floor (valuation.ts) asks whether the household is worth enough. This asks a different question:
 * will the money be in the bank on the day each debit falls due? An instruction can leave the worst case far above
 * the floor and still take the money an instalment needs next week. The answer here is safe for what is listed:
 * from the reserve nothing listed can fail through the days looked at. It is also the least such figure when the
 * listed amounts really are charged in full, which everyday spending (an assumption of the owner's, rounded up by
 * the day, and not a debit the paper bank makes) is not. So it is described to the owner as the least that covers
 * what is listed at its worst, never as exact.
 *
 * One step is one calendar day of the household's zone (India's unless it chose another) and step 0 is today. Every result carries what it counted and what it did not.
 */
import { addDays, type Db, instalmentMonths, parse } from './core.ts'
import { homeZone } from './home-currency.ts'
import { zonedInstant, zonedParts } from '../shared/zone.ts'
import { getProfile, type Profile } from './household.ts'
import { available, balance } from './ledger.ts'
import { term } from './registry.ts'
import { firstDue, nextDue } from './schedule.ts'
import type { Authority, OrderParams, PaymentParams, Schedule } from './types.ts'
import { type Caps, cumLower, cumUpper, type Income, incomeExceeded, largestMonthlyLimit, type Outflow, reserveFrom } from '../shared/envelope.ts'
import { mulDiv, parseDec, pow10 } from '../shared/fixed.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

const DAY = 86_400_000
/** How far ahead debits and income are laid out. Anything due later is not counted, and results say so. */
export const HORIZON_DAYS = 150
/** Days are counted in the household's zone (India's unless it chose another; home-currency.ts), at the instant they are asked about. */
const local = (ms: number) => zonedParts(ms, homeZone())
const localInstant = (date: string, hm: string): number => zonedInstant(date, hm, homeZone())
const p2 = (n: number): string => String(n).padStart(2, '0')
const dayIndex = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY)
const stepOf = (today: string, at: number): number => dayIndex(local(at).date) - dayIndex(today)
const daysInMonth = (date: string): number => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).getUTCDate() }
const monthsFrom = (today: string, n: number): string[] => { let [y, m] = today.split('-').map(Number) as [number, number]; const out: string[] = []; for (let i = 0; i < n; i++) { out.push(`${y}-${p2(m)}`); m += 1; if (m > 12) { m = 1; y += 1 } } return out }
/** Every month from the one `from` falls in (YYYY-MM-DD) through `n` months after the one `today` falls in, oldest first. */
const monthsSince = (from: string, today: string, n: number): string[] => {
  const [ty, tm] = today.split('-').map(Number) as [number, number]
  let [y, m] = from.split('-').map(Number) as [number, number]
  const last = ty * 12 + (tm - 1) + n
  const out: string[] = []
  while (y * 12 + (m - 1) <= last) { out.push(`${y}-${p2(m)}`); m += 1; if (m > 12) { m = 1; y += 1 } }
  return out
}
const big = (s: string | undefined): bigint => BigInt(s ?? '0')

// ------------------------------------------------------------------------------------------------ what an instruction has used

export const dayStart = (now: number): number => localInstant(local(now).date, '00:00')
export const monthStart = (now: number): number => { const t = local(now); return localInstant(`${t.y}-${p2(t.m)}-01`, '00:00') }

/**
 * When an action is being decided (`excludeActionId`), the actions planned after it and not yet decided are left out: each
 * is decided in its turn and counts this one then. Until R13 they were counted at their full size, so the first share of
 * a run over its limit was refused because of a later one, which then went through; the run's sheet tells the owner that
 * what goes over the limit is refused when it is sent (runner.ts runLimits). Actions planned before it still count at
 * their full size, whatever their state. Without `excludeActionId` (what a screen shows, what a new limit is sized
 * against) everything in flight counts.
 */
const LATER_UNDECIDED = `AND NOT (state = 'planned' AND rowid > (SELECT rowid FROM actions WHERE id = ?))`

/** Paise this program has already moved, or has in flight, since `since`. Refused, failed and cancelled actions do not count. */
export function programUsage(db: Db, programId: string, since: number, excludeActionId = ''): bigint {
  const rows = db.all<{ kind: string; state: string; params_json: string; result_json: string }>(
    `SELECT kind, state, params_json, result_json FROM actions WHERE program_id = ? AND created_at >= ? AND id != ? AND state NOT IN ('blocked', 'rejected', 'failed', 'cancelled', 'expired') ${excludeActionId ? LATER_UNDECIDED : ''}`, programId, since, excludeActionId, ...(excludeActionId ? [excludeActionId] : []))
  let total = 0n
  for (const r of rows) {
    const p = parse<OrderParams & PaymentParams>(r.params_json, {} as OrderParams & PaymentParams)
    // a withdrawal plan's sales are what its limits count (R13); every other kind's sales are not spending
    if (r.kind === 'order' && p.side === 'sell' && !p.swpPaise) continue
    const res = parse<{ movedPaise?: string }>(r.result_json, {})
    total += (r.state === 'done' || r.state === 'partial') && res.movedPaise ? BigInt(res.movedPaise) : big(p.swpPaise) + big(p.amount) + big(p.charge)
  }
  return total
}

/** Paise one run's actions have moved, or have in flight, other than `excludeActionId`; counted as programUsage counts. */
export function runUsage(db: Db, runId: string, excludeActionId = ''): bigint {
  const rows = db.all<{ kind: string; state: string; params_json: string; result_json: string }>(
    `SELECT kind, state, params_json, result_json FROM actions WHERE run_id = ? AND id != ? AND state NOT IN ('blocked', 'rejected', 'failed', 'cancelled', 'expired') ${excludeActionId ? LATER_UNDECIDED : ''}`, runId, excludeActionId, ...(excludeActionId ? [excludeActionId] : []))
  let total = 0n
  for (const r of rows) {
    const p = parse<OrderParams & PaymentParams>(r.params_json, {} as OrderParams & PaymentParams)
    // a withdrawal plan's sales count against the run's limit, as programUsage counts them; every other kind's sales are not spending
    if (r.kind === 'order' && p.side === 'sell' && !p.swpPaise) continue
    const res = parse<{ movedPaise?: string }>(r.result_json, {})
    total += (r.state === 'done' || r.state === 'partial') && res.movedPaise ? BigInt(res.movedPaise) : big(p.swpPaise) + big(p.amount) + big(p.charge)
  }
  return total
}

// ------------------------------------------------------------------------------------------------ what is due and what is certain to arrive

export interface Due { step: number; date: string; kind: 'emi' | 'bill' | 'living'; label: string; amount: number }
export interface LiquidityOpts {
  /** A registered bill the action being judged pays: afterwards it is no longer due. */
  paysBillId?: string
  /** A loan prepayment the action being judged makes: later instalments are worked out on the smaller balance. */
  prepays?: { code: 'loan:personal' | 'loan:home'; amount: number }
}
interface Flows { today: string; committed: Outflow[]; inflows: Income[]; dues: Due[] }

const LOANS = [['loan:personal', 'personalLoanEmi', 'rate.loan.personal', '0.14', 'Personal loan instalment'], ['loan:home', 'homeLoanEmi', 'rate.loan.home', '0.0875', 'Home loan instalment']] as const

function flows(db: Db, userId: string, now: number, profile: Profile, opts: LiquidityOpts): Flows {
  const today = local(now).date
  const createdAt = db.get<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', userId)?.created_at ?? 0
  const posted = (ref: string): boolean => !!db.get('SELECT 1 FROM entries WHERE user_id = ? AND ref = ?', userId, ref)
  const months = monthsFrom(today, 7)
  const dues: Due[] = []
  const due = (step: number, kind: Due['kind'], label: string, amount: number): void => { if (amount > 0 && step < HORIZON_DAYS) dues.push({ step, date: addDays(today, step), kind, label, amount }) }

  // Loan instalments, as the paper bank takes them: the month's interest on what is owed, the rest off the principal.
  // One that has fallen due and has not been taken is owed today, whichever month it was due in: the bank keeps
  // trying, oldest first, for up to a year.
  for (const [code, field, rateId, fallback, label] of LOANS) {
    const emi = BigInt(profile[field])
    let owed = balance(db, userId, code) - (opts.prepays?.code === code ? BigInt(opts.prepays.amount) : 0n)
    if (emi <= 0n || owed <= 0n) continue
    const apr = parseDec(String(term(db, rateId)?.value.apr ?? fallback), 12)
    for (const ym of [...instalmentMonths(months[0]!).slice(0, -1), ...months]) {
      const at = localInstant(`${ym}-${p2(profile.emiDay)}`, '09:00')
      if (at < createdAt || posted(`emi:${code}:${ym}`)) continue
      const interest = mulDiv(owed, apr, pow10(12) * 12n, 'up')
      let principal = emi - interest
      if (principal < 0n) principal = 0n
      if (principal > owed) principal = owed
      due(Math.max(0, stepOf(today, at)), 'emi', label, Number(principal + interest))
      owed -= principal
      if (owed <= 0n) break
    }
  }

  // Registered bills that are still owed. A bill whose payment has already been sent is not counted twice, nor one whose
  // payment waits with its money set aside in the bank ('held', new-payee.ts): that money is already out of what is free.
  const beingPaid = new Set(db.all<{ params_json: string }>(`SELECT params_json FROM actions WHERE user_id = ? AND kind = 'payment' AND state IN ('held', 'submitting', 'working')`, userId).map((r) => parse<{ billId?: string }>(r.params_json, {}).billId))
  const bills = db.all<{ id: string; amount: number; due_at: number; name: string }>(
    `SELECT b.id, b.amount, b.due_at, y.name FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? AND b.state IN ('due', 'scheduled') AND b.due_at < ? ORDER BY b.due_at`, userId, localInstant(addDays(today, HORIZON_DAYS), '00:00'))
  for (const b of bills) if (b.id !== opts.paysBillId && !beingPaid.has(b.id)) due(Math.max(0, stepOf(today, b.due_at)), 'bill', b.name, b.amount)

  // Everyday spending: the owner's monthly figure, spread evenly over the days of each month.
  if (profile.spending > 0) for (let k = 0; k < HORIZON_DAYS; k++) due(k, 'living', 'Everyday spending', Math.ceil(profile.spending / daysInMonth(addDays(today, k))))

  // Salary. A month whose salary is on the ledger has been received; the rest are outstanding. The list runs from the
  // month the household was opened, not from this month (Q-045, research note of 22 November 2026):
  //   - a salary that is still inside its allowed lateness when the month turns stays counted. Until then it dropped
  //     out of the list on the 1st, and what must stay rose overnight with nothing having happened (mechanism M1);
  //   - a salary that never arrived keeps using the allowance for lost salaries. The allowance is counted over the
  //     life of the household, as the specification says (SPEC 4a, "counted over the whole life of the flow"); it no
  //     longer renews on the 1st, which made what must stay jump by a month of outgoings overnight (mechanism M3).
  //     When it is used up, `assumptions.allowanceLeft` is 0 and the screen says so.
  const salaryDue: number[] = [], received: number[] = []
  // (When the household's opening time is unknown the list starts this month, as before.)
  if (profile.income > 0) for (const ym of monthsSince(createdAt > 0 ? local(createdAt).date : today, today, 6)) {
    const at = localInstant(`${ym}-${p2(profile.incomeDay)}`, '09:30')
    if (at < createdAt) continue
    if (posted(`salary:${ym}`)) received.push(salaryDue.length)
    salaryDue.push(stepOf(today, at))
  }
  return {
    today, dues,
    committed: [{ type: 'scheduled', at: dues.map((d) => [d.step, d.amount]) }],
    inflows: salaryDue.length ? [{ type: 'income', amount: profile.income, due: salaryDue, lateBy: profile.lateDays, missing: profile.lostSalaries, received }] : [],
  }
}

const sum = (curves: number[][]): number[] => { const out = new Array<number>(HORIZON_DAYS).fill(0); for (const c of curves) for (let k = 0; k < HORIZON_DAYS; k++) out[k]! += c[k]!; return out }

export interface Liquidity {
  asOf: number; today: string; horizonDays: number
  /** Bank money not already held for something in flight. */
  available: number
  /** The least that must be in the bank now for everything due to be met. */
  need: number
  free: number
  /** What is missing today, when the bank holds less than is needed. */
  short: number
  /** The debit that is hardest to meet: everything due up to it, less the income certain to have arrived before it. */
  binding: { date: string; step: number; debits: number; inflows: number; parts: { kind: Due['kind']; label: string; amount: number }[]; items: Due[] } | null
  /**
   * False when the hardest debit falls in the last month of the horizon: debits are still outrunning certain income
   * where the look-ahead ends, so more may be needed than the figure says. A household that spends more than it
   * earns is the usual cause. (The reference flags only a hardest debit on the very last day, which misses a
   * requirement that peaks before each salary; found by this module's tests.)
   */
  sustainable: boolean
  assumptions: {
    lateDays: number; lostSalaries: number; spending: number; income: number; incomeDay: number; firstCounted: { due: string; by: string } | null
    /**
     * A salary that has not arrived within the days allowed. It is then counted as one that never arrives.
     * `beyondAllowance` is how many such salaries there are over the number the owner allowed to be lost: above
     * zero, what has happened is worse than the assumption written here, and the screen must say so.
     */
    late: { due: string; count: number; beyondAllowance: number } | null
    /** Salaries counted as lost since the household was opened, and how many more the allowance still covers. */
    lostSoFar: number; allowanceLeft: number
  }
  notCounted: string[]
  /** The lowest the bank would stand on each of the next days if the worst allowed for happens and nothing else leaves. */
  path: { date: string; low: number }[]
}

/** For each day ahead, everything due through that day less the income certain to have arrived before it. The reserve is the largest of these. */
function requirementByDay(db: Db, userId: string, now: number, opts: LiquidityOpts, profile: Profile): number[] {
  const f = flows(db, userId, now, profile, opts)
  const cumOut = sum(f.committed.map((c) => cumUpper(c, 0, HORIZON_DAYS)))
  const cumIn = sum(f.inflows.map((c) => cumLower(c, 0, HORIZON_DAYS)))
  return cumOut.map((out, k) => out - (k > 0 ? cumIn[k - 1]! : 0))
}

export function liquidity(db: Db, userId: string, now: number, opts: LiquidityOpts = {}, profile: Profile = getProfile(db, userId)): Liquidity {
  const f = flows(db, userId, now, profile, opts)
  const cumOut = sum(f.committed.map((c) => cumUpper(c, 0, HORIZON_DAYS)))
  const cumIn = sum(f.inflows.map((c) => cumLower(c, 0, HORIZON_DAYS)))
  const r = reserveFrom(cumOut, cumIn, 0)
  const bank = Number(available(db, userId, 'bank'))
  let binding: Liquidity['binding'] = null
  if (r.bindingStep !== null) {
    const upTo = f.dues.filter((d) => d.step <= r.bindingStep!)
    const total = (kind: Due['kind']): number => upTo.filter((d) => d.kind === kind).reduce((s, d) => s + d.amount, 0)
    binding = {
      date: addDays(f.today, r.bindingStep), step: r.bindingStep, debits: r.debitsToBinding, inflows: r.inflowsToBinding,
      parts: ([['emi', 'Loan instalments'], ['bill', 'Registered bills'], ['living', 'Everyday spending']] as const).map(([kind, label]) => ({ kind, label, amount: total(kind) })).filter((p) => p.amount > 0),
      items: upTo.filter((d) => d.kind !== 'living').sort((a, b) => a.step - b.step),
    }
  }
  const inc = f.inflows[0]
  const firstStep = cumIn.findIndex((v) => v > 0)
  // The owner's assumption about income, checked against the record: which salaries are past their last allowed day.
  const lapsed = inc ? inc.due.filter((d, k) => !inc.received.includes(k) && d + inc.lateBy < 0) : []
  return {
    asOf: now, today: f.today, horizonDays: HORIZON_DAYS, available: bank, need: r.need, free: Math.max(0, bank - r.need), short: Math.max(0, r.need - bank), binding, sustainable: r.bindingStep === null || r.bindingStep < HORIZON_DAYS - 31,
    assumptions: {
      lateDays: profile.lateDays, lostSalaries: profile.lostSalaries, spending: profile.spending, income: profile.income, incomeDay: profile.incomeDay,
      firstCounted: inc && firstStep >= 0 ? { due: addDays(f.today, firstStep - inc.lateBy), by: addDays(f.today, firstStep) } : null,
      late: inc && lapsed.length ? { due: addDays(f.today, Math.min(...lapsed)), count: lapsed.length, beyondAllowance: incomeExceeded(inc, 0) } : null,
      lostSoFar: lapsed.length, allowanceLeft: Math.max(0, profile.lostSalaries - lapsed.length),
    },
    notCounted: ['Bills that are not registered here', 'Payments you make by hand beyond your everyday spending figure', 'What you owe on the card: the paper bank asks for no minimum payment', 'Fund redemptions and earnings on their way, until they arrive', `Anything due more than ${HORIZON_DAYS} days from now. The look-ahead moves forward a day each day, so a large payment further off than that is not yet being kept for`],
    path: cumOut.slice(0, 120).map((out, k) => ({ date: addDays(f.today, k), low: bank - out + (k > 0 ? cumIn[k - 1]! : 0) })),
  }
}

/**
 * Whether an outflow of `out` paise from the bank may be made by an instruction: it may not make any day ahead
 * worse. For each day, what would be missing on that day (everything due through it, less certain income before it,
 * less the bank) must not be larger after the action than before it.
 *
 * For spending that pays nothing off this is the plain rule: what is left must cover the reserve. Paying a bill on
 * its own day passes even when the household is already short, because the bill is owed either way and no day gets
 * worse. Paying a bill ahead of its day, or prepaying a loan, passes only if every earlier day stays as well covered
 * as it was: money that an instalment on the 5th needs may not go to a bill due on the 6th.
 *
 * Until 20 November 2026 the rule compared only the largest shortfall before and after. That let an instruction pay
 * a later bill early while the household was short, moving the first day that fails earlier with the figure
 * unchanged (found by an adversarial review; test "may not pay a bill ahead of its day").
 */
export function staysLiquid(db: Db, userId: string, now: number, out: number, opts: LiquidityOpts = {}): { ok: boolean; before: Liquidity; needAfter: number; leftAfter: number; detail: string; firstWorse: { date: string; shortBefore: number; shortAfter: number } | null } {
  const profile = getProfile(db, userId)
  const before = liquidity(db, userId, now, {}, profile)
  const changes = !!(opts.paysBillId || opts.prepays)
  const after = changes ? liquidity(db, userId, now, opts, profile) : before
  const termsBefore = requirementByDay(db, userId, now, {}, profile)
  const termsAfter = changes ? requirementByDay(db, userId, now, opts, profile) : termsBefore
  const leftAfter = before.available - out
  let firstWorse: { date: string; shortBefore: number; shortAfter: number } | null = null
  for (let k = 0; k < HORIZON_DAYS && !firstWorse; k++) {
    const shortBefore = Math.max(0, termsBefore[k]! - before.available), shortAfter = Math.max(0, termsAfter[k]! - leftAfter)
    if (shortAfter > shortBefore) firstWorse = { date: addDays(before.today, k), shortBefore, shortAfter }
  }
  const ok = firstWorse === null
  const b = after.binding
  const why = b ? `${homeMoneyExact(after.need)} must stay for what is due by ${dateText(b.date)}${after.assumptions.lostSalaries > 0 || after.assumptions.lateDays > 0 ? `, allowing for ${hardshipText(after.assumptions)}` : ''}` : 'nothing is due before income arrives'
  const worse = firstWorse ? (firstWorse.shortBefore > 0 ? ` That would take what is missing for what is due by ${dateText(firstWorse.date)} from ${homeMoneyExact(firstWorse.shortBefore)} to ${homeMoneyExact(firstWorse.shortAfter)}.` : ` That would leave ${homeMoneyExact(firstWorse.shortAfter)} too little for what is due by ${dateText(firstWorse.date)}.`) : ''
  return { ok, before, needAfter: after.need, leftAfter, detail: `${homeMoneyExact(before.available)} is available in the bank and this takes ${homeMoneyExact(out)}, leaving ${homeMoneyExact(leftAfter)}; ${why}.${worse}`, firstWorse }
}

/**
 * Whether a change to the household's figures would lower what must stay in the bank. Lowering it frees money for
 * instructions, so it weakens a protection and needs a fresh passkey confirmation, exactly as lowering the floor does. Raising it,
 * or leaving it as it is, does not. Returns the figure before and after when it falls, and null otherwise.
 */
export function profileLowersReserve(db: Db, userId: string, now: number, next: Profile): { before: number; after: number } | null {
  const before = liquidity(db, userId, now).need, after = liquidity(db, userId, now, {}, next).need
  return after < before ? { before, after } : null
}
/** The same for removing a registered bill: a bill that is counted in what must stay cannot be dropped without the password. */
export function billLowersReserve(db: Db, userId: string, now: number, billId: string): { before: number; after: number } | null {
  const before = liquidity(db, userId, now).need, after = liquidity(db, userId, now, { paysBillId: billId }).need
  return after < before ? { before, after } : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const dateText = (date: string): string => { const [y, m, d] = date.split('-').map(Number); return `${d} ${MONTHS[m! - 1]} ${y}` }
export const hardshipText = (a: { lateDays: number; lostSalaries: number }): string =>
  [a.lateDays > 0 ? `income up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : '', a.lostSalaries > 0 ? `${a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} not arriving` : ''].filter(Boolean).join(' and ')

// ------------------------------------------------------------------------------------------------ what signed limits allow

/** Kinds that can take money out of the bank. Protective kinds only sell. A goal moves money into its set-aside. */
const TAKES_BANK_MONEY = new Set(['invest', 'sweep', 'paydown', 'bills', 'rebalance', 'split', 'goal'])
/**
 * Kinds whose limits are counted as spending when a new limit is sized. A cash-parking instruction moves only what
 * is spare and a bills instruction pays bills that are already counted as due, so neither is counted again.
 */
const SPENDS = new Set(['invest', 'paydown', 'rebalance', 'split', 'goal'])

function scheduleSteps(schedule: Schedule, today: string, first: number | null, until: number): number[] {
  const out = new Set<number>()
  let t = first
  for (let i = 0; t !== null && t <= until && i < 400; i++) { const s = stepOf(today, t); if (s >= HORIZON_DAYS) break; if (s >= 0) out.add(s); t = nextDue(schedule, t) }
  return [...out].sort((a, b) => a - b)
}

/** The limits of a signed authority as an envelope. Where a run can be held for the owner's answer, any day is allowed for. */
export function capsOf(today: string, a: Authority, schedule: Schedule | null, firstRun: number | null, usedMonth: number, runsLeft: number | null): Caps {
  let runSteps: number[] | null = null
  let runsPerStep = Math.max(1, Math.ceil(a.maxPerMonth / Math.max(1, a.maxPerRun)))
  if (a.runMode === 'auto' && schedule) {
    if (schedule.type === 'every' && schedule.minutes < 1440) runsPerStep = Math.ceil(1440 / schedule.minutes)
    else { runSteps = scheduleSteps(schedule, today, firstRun, a.expiresAt); runsPerStep = 1 }
  }
  return {
    type: 'caps', perRun: a.maxPerRun, perMonth: a.maxPerMonth, perDay: a.maxPerDay, runSteps, runsPerStep,
    lifetime: runsLeft === null ? null : Math.max(0, runsLeft) * a.maxPerRun, expires: stepOf(today, a.expiresAt) + 1, start: today, usedMonth, usedLife: 0,
  }
}

export interface InstructionLimits { id: string; title: string; kind: string; caps: Caps }

/** Every active instruction that can take money from the bank, with its limits as they stand now. */
export function instructionCaps(db: Db, userId: string, now: number): InstructionLimits[] {
  const today = local(now).date
  const rows = db.all<{ id: string; title: string; kind: string; next_due_at: number | null; live_version: number; params_json: string; authority_json: string }>(
    `SELECT p.id, p.title, p.kind, p.next_due_at, p.live_version, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.state = 'active'`, userId)
  const out: InstructionLimits[] = []
  for (const r of rows) {
    if (!TAKES_BANK_MONEY.has(r.kind)) continue
    const a = parse<Authority | null>(r.authority_json, null)
    if (!a || a.expiresAt <= now) continue
    const schedule = parse<{ schedule?: Schedule }>(r.params_json, {}).schedule ?? null
    // Runs in progress have used one of the signed runs already, exactly as the engine counts them when it decides.
    const runsDone = a.maxRuns === null ? 0 : db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND version = ? AND state IN ('done', 'partial', 'executing')`, r.id, r.live_version)!.n
    out.push({ id: r.id, title: r.title, kind: r.kind, caps: capsOf(today, a, schedule, r.next_due_at, Number(programUsage(db, r.id, monthStart(now))), a.maxRuns === null ? null : a.maxRuns - runsDone) })
  }
  return out
}

export interface AuthorityEnvelope { windows: { days: number; most: number }[]; instructions: { id: string; title: string; kind: string; most: number[] }[] }

/** The most all active instructions together are allowed to take from the bank over the coming days, by their signed limits. */
export function authorityEnvelope(db: Db, userId: string, now: number, days: number[] = [1, 7, 30]): AuthorityEnvelope {
  const list = instructionCaps(db, userId, now).map((i) => { const cum = cumUpper(i.caps, 0, Math.max(...days)); return { id: i.id, title: i.title, kind: i.kind, most: days.map((d) => cum[d - 1]!) } })
  return { windows: days.map((d, k) => ({ days: d, most: list.reduce((s, i) => s + i.most[k]!, 0) })), instructions: list }
}

export interface RunDay { date: string; runs: number; amount: number; state: 'none' | 'coming' | 'limit' | 'ended'; /** Which limit refused a run that day. */ by?: 'day' | 'month' | 'runs' }
export interface RunCalendar {
  /** From today, day by day: how many runs the schedule puts on that day and how much the limits let them move. */
  days: RunDay[]
  months: { month: string; limit: number; used: number; scheduled: number }[]
  /** What one run moves; `fixed` is false when the signed figure is only a ceiling for a run. */
  perRun: number; fixed: boolean
  /** The owner is asked, or told first, before each run. */
  asks: boolean
  endsOn: string
  /** The first day on which the schedule asks for more than a limit has left, so a run is refused, and which limit. */
  limitOn: string | null; limitBy: 'day' | 'month' | 'runs' | null
  runs: number; total: number
}

/**
 * The coming weeks of one scheduled instruction as a calendar: each run on its day, what the monthly, daily and
 * run-count limits leave for it, and where authority ends. It answers "when, and how much" for a signed limit.
 */
export function runCalendar(db: Db, userId: string, programId: string, now: number, span = 35): RunCalendar | null {
  const r = db.get<{ state: string; next_due_at: number | null; live_version: number | null; params_json: string; authority_json: string }>(
    `SELECT p.state, p.next_due_at, p.live_version, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.id = ? AND p.user_id = ?`, programId, userId)
  if (!r || (r.state !== 'active' && r.state !== 'paused')) return null
  const a = parse<Authority | null>(r.authority_json, null)
  const prm = parse<{ schedule?: Schedule; amount?: number }>(r.params_json, {})
  if (!a || !prm.schedule) return null
  const today = local(now).date
  const perRun = typeof prm.amount === 'number' ? prm.amount : a.maxPerRun
  const end = Math.min(a.expiresAt, localInstant(addDays(today, span), '00:00') - 1)
  // how many times the schedule fires on each day from now to the end of the strip or of the authority
  const count = new Array<number>(span).fill(0)
  let t = r.next_due_at ?? firstDue(prm.schedule, now)
  if (prm.schedule.type === 'every' && t !== null) {
    const step = prm.schedule.minutes * 60_000
    if (t < now) t += Math.ceil((now - t) / step) * step
    for (let k = 0; k < span; k++) {
      const from = Math.max(now, localInstant(addDays(today, k), '00:00')), to = Math.min(end, localInstant(addDays(today, k + 1), '00:00') - 1)
      if (to < from || t > to) continue
      const first = t >= from ? t : t + Math.ceil((from - t) / step) * step
      if (first <= to) count[k] = Math.floor((to - first) / step) + 1
    }
  } else for (let i = 0; t !== null && t <= end && i < 400; i++) { const k = stepOf(today, t); if (k >= 0 && k < span && t >= now) count[k]! += 1; t = nextDue(prm.schedule, t) }

  const usedMonth = Number(programUsage(db, programId, monthStart(now))), usedDay = a.maxPerDay === null ? 0 : Number(programUsage(db, programId, dayStart(now)))
  let runsLeft = a.maxRuns === null ? Number.POSITIVE_INFINITY : a.maxRuns - (db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND version = ? AND state IN ('done', 'partial', 'executing')`, programId, r.live_version!)?.n ?? 0)
  const left = new Map<string, number>([[today.slice(0, 7), Math.max(0, a.maxPerMonth - usedMonth)]])
  const months = new Map<string, { month: string; limit: number; used: number; scheduled: number }>()
  const endsOn = local(a.expiresAt).date
  const days: RunDay[] = []
  let limitOn: string | null = null, limitBy: RunCalendar['limitBy'] = null, runs = 0, total = 0
  for (let k = 0; k < span; k++) {
    const date = addDays(today, k), month = date.slice(0, 7)
    if (!left.has(month)) left.set(month, a.maxPerMonth)
    if (!months.has(month)) months.set(month, { month, limit: a.maxPerMonth, used: month === today.slice(0, 7) ? usedMonth : 0, scheduled: 0 })
    if (date > endsOn) { days.push({ date, runs: 0, amount: 0, state: 'ended' }); continue }
    const want = count[k]!
    if (want === 0) { days.push({ date, runs: 0, amount: 0, state: 'none' }); continue }
    const dayRoom = a.maxPerDay === null ? Number.POSITIVE_INFINITY : Math.max(0, a.maxPerDay - (k === 0 ? usedDay : 0))
    const byMonth = Math.floor(left.get(month)! / Math.max(1, perRun)), byDay = Math.floor(dayRoom / Math.max(1, perRun))
    const can = Math.max(0, Math.min(want, runsLeft, byMonth, byDay))
    const amount = can * perRun
    // the limit that refuses: the tightest one, and the longer-lasting one when two are equally tight
    const by = can < want ? (can === runsLeft ? 'runs' as const : can === byMonth ? 'month' as const : 'day' as const) : undefined
    left.set(month, left.get(month)! - amount); runsLeft -= can; months.get(month)!.scheduled += amount; runs += can; total += amount
    if (by && limitOn === null) { limitOn = date; limitBy = by }
    days.push({ date, runs: can, amount, state: by ? 'limit' : 'coming', ...(by ? { by } : {}) })
  }
  return { days, months: [...months.values()], perRun, fixed: typeof prm.amount === 'number', asks: a.runMode !== 'auto', endsOn, limitOn, limitBy, runs, total }
}

export interface LimitAdvice {
  /**
   * The largest monthly limit with which, even if every run takes its full amount, nothing due in the look-ahead
   * can fail, on what is recorded today. It is worked out again whenever it is shown: the look-ahead moves forward
   * each day, so a bill that comes into view later can lower it, and a run can then be refused for want of money.
   * (That no run would ever be refused is a theorem only for a fixed end date: independent review, Theorem 5.)
   */
  largest: number
  /** With the limit asked for and every run taking its full amount: what the bank would need to hold now, and whether it does. */
  need: number; holds: boolean
  /** The first day on which something due could not be met, when it does not hold. */
  shortOn: string | null
  available: number
  countedWith: string[]
}

/** Size a new scheduled instruction against what is due: the largest safe monthly limit, and whether the one asked for holds. */
export function limitAdvice(db: Db, userId: string, now: number, a: Authority, schedule: Schedule, exceptProgramId = ''): LimitAdvice {
  const profile = getProfile(db, userId)
  const f = flows(db, userId, now, profile, {})
  const others = instructionCaps(db, userId, now).filter((i) => i.id !== exceptProgramId && SPENDS.has(i.kind))
  const bank = Number(available(db, userId, 'bank'))
  const own = capsOf(f.today, { ...a, runMode: 'auto' }, schedule, firstDue(schedule, now), 0, a.maxRuns)
  const committed: Outflow[] = [...f.committed, ...others.map((o) => o.caps)]
  const runSteps = own.runSteps ?? Array.from({ length: Math.min(HORIZON_DAYS, Math.max(0, own.expires ?? HORIZON_DAYS)) }, (_, k) => k)
  const largest = largestMonthlyLimit(bank, committed, f.inflows, 0, HORIZON_DAYS, a.maxPerRun, runSteps, f.today, own.runsPerStep)
  const cumIn = sum(f.inflows.map((c) => cumLower(c, 0, HORIZON_DAYS)))
  const cumOut = sum([...committed, own].map((c) => cumUpper(c, 0, HORIZON_DAYS)))
  const r = reserveFrom(cumOut, cumIn, 0)
  const firstShort = cumOut.findIndex((out, k) => out - (k > 0 ? cumIn[k - 1]! : 0) > bank)
  return { largest, need: r.need, holds: r.need <= bank, shortOn: firstShort < 0 ? null : addDays(f.today, firstShort), available: bank, countedWith: others.map((o) => o.title) }
}
