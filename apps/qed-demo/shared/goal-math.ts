/**
 * A savings goal's arithmetic, in integer paise (R12 task comparison, gap 5; criteria T3-a to T3-c).
 *
 * The rule, as the household is told it: a goal is on track when what is set aside now, plus every contribution its
 * instruction still has scheduled before the goal's date, reaches the target on that date. Growth is counted only
 * under an assumption the household names (an annual rate, compounded on whole months and rounded down each month);
 * by default none is counted. A contribution is the monthly figure, except the last, which takes only what is left, so
 * the set-aside never goes past its target.
 *
 * Every figure QED offers is a whole rupee rounded so that following it reaches the target: the monthly figure, and,
 * when a goal is behind, the remedies (that much more a month, a later date the schedule reaches it on, or a sum now).
 * Each is searched for with the same projection that decides "on track", so a remedy and the rule cannot disagree.
 * Without growth the arithmetic is exact and each figure is the least that works; with growth it still reaches the
 * target (shared/goal-math.test.ts, properties over random goals).
 *
 * Dates are India calendar dates (YYYY-MM-DD). Pure: nothing here reads a clock or a database.
 */

/** One contribution still to come: its date, and its own figure when it is already planned (a run waiting for the owner). */
export interface GoalRun { date: string; amount?: number }
export interface GoalInputs {
  /** What the goal is for, in paise. */
  target: number
  /** Set aside now (with anything on its way to the set-aside), in paise. */
  balance: number
  /** What each scheduled contribution moves, in paise. */
  monthly: number
  /** The growth the household assumes, in basis points a year; 0 counts none. */
  growthBps: number
  today: string
  date: string
  /** The contributions still scheduled, oldest first, none after `date`. */
  runs: GoalRun[]
  /** The day of the month contributions fall on (1 to 28): the schedule carried past the date for a later one. */
  day: number
  /** The latest date the goal may be moved to: its instruction's authority lasts at most 400 days. */
  latest: string
}
export interface Projection {
  contributions: { date: string; amount: number }[]
  /** Every contribution still scheduled, together. */
  scheduled: number
  /** Growth counted on the set-aside and on each contribution until the date: zero unless the household assumes some. */
  growth: number
  /** What would be set aside on the date. */
  projected: number
  onTrack: boolean
  shortfall: number
}
export interface Remedies {
  /** That much more a month (a whole rupee), and the monthly figure it makes; null without a contribution left. */
  more: { extra: number; monthly: number } | null
  /** The first later date the schedule reaches the target on at the present figure, if it is no later than `latest`. */
  later: { date: string } | null
  /** The sum, set aside now, that brings the goal back on track. */
  now: { amount: number } | null
}

const RUPEE = 100
const p2 = (n: number): string => String(n).padStart(2, '0')
const parts = (date: string): [number, number, number] => date.split('-').map(Number) as [number, number, number]
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
/** Rounded up to a whole rupee. */
const upToRupee = (paise: number): number => Math.ceil(paise / RUPEE) * RUPEE

/** Whole calendar months from one date to another (on or before the same day of the month), never negative. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = parts(from), [ty, tm, td] = parts(to)
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0))
}

/** The same day `n` months on, or the month's last day when it is shorter. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date)
  const k = y * 12 + (m - 1) + n
  const ny = Math.floor(k / 12), nm = (k % 12) + 1
  return `${ny}-${p2(nm)}-${p2(Math.min(d, daysIn(ny, nm)))}`
}

/** Every date on `day` of a month from `from` to `to`, both included. */
export function runDates(day: number, from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = parts(from)
  for (let i = 0; i < 1_000; i++) {
    const d = `${y}-${p2(m)}-${p2(day)}`
    if (d > to) break
    if (d >= from) out.push(d)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** An amount after `months` whole months at `bps` a year: one twelfth of the rate a month, rounded down each month. */
function grow(amount: bigint, months: number, bps: number): bigint {
  if (bps <= 0) return amount
  let a = amount
  for (let k = 0; k < months; k++) a += (a * BigInt(bps)) / 120_000n
  return a
}

/** What would be set aside on the goal's date if every contribution still scheduled is made. */
export function project(i: GoalInputs): Projection {
  let left = BigInt(Math.max(0, i.target - i.balance))
  let scheduled = 0n, grown = 0n
  const contributions = i.runs.map((r) => {
    const want = BigInt(Math.max(0, r.amount ?? i.monthly))
    const c = want < left ? want : left
    left -= c
    scheduled += c
    grown += grow(c, monthsBetween(r.date, i.date), i.growthBps) - c
    return { date: r.date, amount: Number(c) }
  })
  const balance = BigInt(i.balance)
  const growth = grown + grow(balance, monthsBetween(i.today, i.date), i.growthBps) - balance
  const projected = Number(balance + scheduled + growth)
  return { contributions, scheduled: Number(scheduled), growth: Number(growth), projected, onTrack: projected >= i.target, shortfall: Math.max(0, i.target - projected) }
}

/** The least whole number of rupees, from `lo` to `hi` (both in rupees), for which `ok` holds; `hi` must hold. */
function least(lo: number, hi: number, ok: (rupees: number) => boolean): number {
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) hi = mid; else lo = mid + 1 }
  return hi
}

/**
 * The monthly figure: the least whole number of rupees a month that reaches the target by the date, with the
 * contributions scheduled. Null when no contribution falls before the date (only a sum now, or a later date, can help).
 */
export function monthlyFor(i: Omit<GoalInputs, 'monthly'>): number | null {
  const need = i.target - i.balance
  if (need <= 0) return 0
  const open = i.runs.filter((r) => r.amount === undefined).length
  if (open === 0) return project({ ...i, monthly: 0 }).onTrack ? 0 : null
  // every open contribution at this much reaches the target with no growth at all, whatever is already planned
  const hi = upToRupee(Math.ceil(need / open)) / RUPEE
  return least(0, hi, (r) => project({ ...i, monthly: r * RUPEE }).onTrack) * RUPEE
}

/** When a goal is behind: what more a month, which later date, or what sum now brings it back on track. */
export function remedies(i: GoalInputs): Remedies {
  if (project(i).onTrack) return { more: null, later: null, now: null }
  const need = i.target - i.balance
  // more a month: the first open contribution alone would carry everything that is missing at `need` more
  const open = i.runs.some((r) => r.amount === undefined)
  const extra = open ? least(1, upToRupee(need) / RUPEE, (r) => project({ ...i, monthly: i.monthly + r * RUPEE }).onTrack) * RUPEE : null
  // a sum now: everything that is missing, set aside today, is enough
  const now = least(1, upToRupee(need) / RUPEE, (r) => project({ ...i, balance: i.balance + r * RUPEE }).onTrack) * RUPEE
  // a later date: the schedule carried on past the date, contribution by contribution, up to the latest date allowed
  let later: Remedies['later'] = null
  const after = runDates(i.day, nextDay(i.date), i.latest)
  for (let k = 0; k < after.length; k++) {
    const date = after[k]!
    if (project({ ...i, date, runs: [...i.runs, ...after.slice(0, k + 1).map((d) => ({ date: d }))] }).onTrack) { later = { date }; break }
  }
  return { more: extra === null ? null : { extra, monthly: i.monthly + extra }, later, now: { amount: now } }
}
