/**
 * Charts, and the arithmetic behind them, drawn from the server's own figures. Each draws the quantity as it is: a
 * balance that moves when something falls due is a step, never a smoothed curve. Every chart answers a stated question,
 * names its units, can be read by pointer, finger or keyboard, and has the same figures as a table one press away.
 *
 * The worst case's arithmetic is exact. A day's figure is the server's (server/liquidity.ts `path`): the least the bank
 * could hold at the end of that day if the worst the owner allows for happens. What is said to have moved it on that
 * day (everyday spending, each obligation, a salary counted on) always adds up to the change between one day and the
 * next, to the paisa; where a name is not known, the item is called by what it must be, never guessed.
 *
 * A what-if (`whatIf`) is the same path with harder assumptions, worked out here in integer paise. The server's path
 * is linear in what it counts (each day is the bank less everything due through it, plus the income certain to have
 * arrived before it), so a change to one assumption is a change to the days it touches, and nothing else moves.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { homeMoneyCompact } from '../../shared/home-money.ts'
import { fmt } from '../lib/core.ts'
import type { Liquidity, PassbookView, ProgramSummary, Worst } from '../lib/types.ts'
import type { Lane } from './score.tsx'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY = 86_400_000
const ymd = (iso: string): [number, number, number] => iso.split('-').map(Number) as [number, number, number]
/** "Tue 24 Nov" for an ISO day. */
export function dayName(iso: string): string {
  const [y, m, d] = ymd(iso)
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`
}
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY)
const daysInMonth = (iso: string): number => { const [y, m] = ymd(iso); return new Date(Date.UTC(y, m, 0)).getUTCDate() }
/** "28 to 30 Nov", "28 Nov to 5 Dec", or one day's name. */
function span(a: string, b: string): string {
  if (a === b) return dayName(a)
  const [, ma, da] = ymd(a), [, mb, db] = ymd(b)
  return ma === mb ? `${da} to ${db} ${MONTHS[mb - 1]}` : `${da} ${MONTHS[ma - 1]} to ${db} ${MONTHS[mb - 1]}`
}

/** A rupee figure short enough for an axis: ₹45k, ₹8.7 lakh, ₹1.2 crore (the one formatter of sums, shared/money.ts). */
export const compactInr = (paise: number): string => homeMoneyCompact(paise)

/** Round steps (1, 2 or 5 times a power of ten) from the first at or below `lo` to the first at or above `hi`. */
export function axisTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag
  const step = (f >= 5 ? 5 : f >= 2 ? 2 : 1) * mag
  const out: number[] = []
  for (let i = Math.floor(lo / step); i <= Math.ceil(hi / step); i++) out.push(Math.round(i * step))
  return out
}

/** Width of a box, kept current as the layout changes. */
export function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const ro = new ResizeObserver((es) => { const cw = es[0]?.contentRect.width ?? 0; if (cw > 0) setW(Math.round(cw)) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [box, w]
}

// ------------------------------------------------------------------------------------------------ the worst case's arithmetic

/** Something expected on a day: negative leaves the bank, positive arrives. */
export interface RunwayEvent { date: string; label: string; amount: number; kind?: string }
/** What moved the balance on a day, apart from everyday spending. */
export interface RunwayItem { label: string; amount: number; kind: string; due?: string }
export interface RunwayDay {
  k: number; date: string
  /** The least the bank could hold at the end of the day (the server's figure). */
  low: number
  /** Exactly `low` less the day before (less what is in the bank now, on the first day). */
  change: number
  /** Everyday spending counted that day; 0 when the household's figure is not known here. */
  spending: number
  /** Everything else that moved it; with `-spending` these add up to `change`. */
  items: RunwayItem[]
}
/** What the server counted, so that each day can be explained (Home, Save and Safeguards pass it). */
export interface RunwayBasis {
  /** In the bank now, before anything due today. */
  start: number
  /** Everyday spending a month: the server spreads it over the days of each month, rounded up (liquidity.ts). */
  spending: number
  /** Salary a month. */
  income: number
  /** Obligations the server named (the hardest day's list, the passbook's expected bills and instalments). */
  named: RunwayEvent[]
  /** The days a salary is counted on, each with the day it was due (`countedSalaryDays`). */
  salary: Map<string, string>
}

/**
 * The days a salary is counted on: the day after the latest it may arrive. The first is the server's own
 * (`assumptions.firstCounted`); each later one is due on the same day of the next month and allowed the same lateness.
 * Salaries allowed for as lost come before the first counted one, so none after it is lost.
 */
export function countedSalaryDays(path: { date: string }[], a: { income: number; incomeDay: number; lateDays: number; firstCounted: { due: string; by: string } | null }): Map<string, string> {
  const out = new Map<string, string>()
  if (!a.firstCounted || a.income <= 0 || path.length === 0) return out
  const first = path[0]!.date, last = path[path.length - 1]!.date
  let due = a.firstCounted.due, by = a.firstCounted.by
  for (let i = 0; i < 36; i++) {
    const counted = addDays(by, 1)
    if (counted > last) break
    if (counted >= first) out.set(counted, due)
    const [y, m] = ymd(due)
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1
    due = `${ny}-${String(nm).padStart(2, '0')}-${String(a.incomeDay).padStart(2, '0')}`
    by = addDays(due, a.lateDays)
  }
  return out
}

/** Each day of the path with what moved it. Every day's items and spending add up to its change exactly. */
export function runwayDays(path: { date: string; low: number }[], basis?: RunwayBasis): RunwayDay[] {
  return path.map((p, k) => {
    const before = k === 0 ? basis?.start ?? p.low : path[k - 1]!.low
    const change = p.low - before
    if (!basis) return { k, date: p.date, low: p.low, change, spending: 0, items: change === 0 ? [] : [{ label: 'Change on the day', amount: change, kind: 'net' }] }
    const spending = basis.spending > 0 ? Math.ceil(basis.spending / daysInMonth(p.date)) : 0
    const lump = change + spending // what the day's change holds besides everyday spending
    if (lump === 0) return { k, date: p.date, low: p.low, change, spending, items: [] }
    const due = basis.salary.get(p.date)
    const salary: RunwayItem[] = due !== undefined && basis.income > 0 ? [{ label: 'Salary counted on', amount: basis.income, kind: 'income', due }] : []
    const inc = salary[0]?.amount ?? 0
    const names: RunwayItem[] = basis.named.filter((e) => e.date === p.date && e.amount < 0).map((e) => ({ label: e.label, amount: e.amount, kind: e.kind ?? 'due' }))
    const named = names.reduce((s, e) => s + e.amount, 0)
    const rest = lump - named - inc
    let items: RunwayItem[]
    if (rest === 0) items = [...salary, ...names]
    else if (rest < 0) items = [...salary, ...names, { label: names.length ? 'Other bills and instalments due' : 'Bills and instalments due', amount: rest, kind: 'due' }]
    else {
      // The names claim more than the path counted (a bill already being paid, for one): they are left out, and the
      // day is described by what it must be.
      const unnamed = lump - inc
      items = unnamed === 0 ? salary : unnamed < 0 ? [...salary, { label: 'Bills and instalments due', amount: unnamed, kind: 'due' }] : [{ label: 'Change apart from everyday spending', amount: lump, kind: 'net' }]
    }
    return { k, date: p.date, low: p.low, change, spending, items }
  })
}

const istDay = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(ms)
type Expected = { dueAt: number; label: string; amount: number; kind: string }[]

/**
 * What the worst case needs to explain each day exactly: the server's named obligations (the hardest day's list, then
 * the passbook's expected bills and instalments after it), the salaries it counts on, and the expected salary it does
 * not (one the owner allows to be lost), all from the server's own figures. Home, Save and Safeguards draw from it.
 */
export function runwayOf(l: Liquidity, expected: Expected): { basis: RunwayBasis; uncounted: RunwayEvent[]; beyond: { date: string; free: number } | null } {
  const b = l.binding
  const named: RunwayEvent[] = [
    ...(b?.items ?? []).map((i) => ({ date: i.date, label: i.label, amount: -i.amount, kind: i.kind })),
    ...expected.filter((e) => (e.kind === 'bill' || e.kind === 'emi') && e.amount < 0).map((e) => ({ date: istDay(e.dueAt), label: e.label, amount: e.amount, kind: e.kind })).filter((e) => !b || e.date > b.date),
  ]
  const fc = l.assumptions.firstCounted
  const uncounted = expected.filter((e) => e.kind === 'income' && e.amount > 0).map((e) => ({ date: istDay(e.dueAt), label: e.label, amount: e.amount, kind: 'income' })).filter((e) => (fc ? e.date < fc.due : true))
  return {
    basis: { start: l.available, spending: l.assumptions.spending, income: l.assumptions.income, named, salary: countedSalaryDays(l.path, l.assumptions) },
    uncounted,
    beyond: b && b.step >= l.path.length ? { date: b.date, free: l.free } : null,
  }
}

export interface RunwayRow { k: number; kind: string; when: string; what: string; amount: number | null; balance: number | null; due?: string }
/**
 * The worst case as a statement: what is in the bank now, then each day money moves, with everyday spending between
 * them on lines of their own, and the balance at the worst after each day's last line. Read down, it adds up to the paisa.
 */
export function runwayRows(days: RunwayDay[], start: number, lowAt: number): RunwayRow[] {
  if (days.length === 0) return []
  const rows: RunwayRow[] = [{ k: 0, kind: 'start', when: dayName(days[0]!.date), what: 'In your bank account now', amount: null, balance: start }]
  const last = days.length - 1
  let spent = 0, from = 0, counted = 0
  for (const d of days) {
    spent += d.spending
    if (d.spending > 0) counted += 1
    if (d.items.length === 0 && d.k !== lowAt && d.k !== last) continue
    if (spent > 0) rows.push({ k: d.k, kind: 'spending', when: span(days[from]!.date, d.date), what: `Everyday spending, ${counted} day${counted === 1 ? '' : 's'}`, amount: -spent, balance: null })
    for (const it of d.items) rows.push({ k: d.k, kind: it.kind, when: dayName(d.date), what: it.label, amount: it.amount, balance: null, ...(it.due ? { due: it.due } : {}) })
    if (d.k === lowAt) rows.push({ k: d.k, kind: 'lowest', when: dayName(d.date), what: d.k === last ? 'The lowest point, on the last day drawn' : 'The lowest point: what is free today', amount: null, balance: d.low })
    else if (d.k === last) rows.push({ k: d.k, kind: 'end', when: dayName(d.date), what: 'The last day drawn', amount: null, balance: d.low })
    else rows[rows.length - 1]!.balance = d.low
    spent = 0; counted = 0; from = d.k + 1
  }
  return rows
}

// ------------------------------------------------------------------------------------------------ a what-if, worked out here

/**
 * A harder case than the recorded worst case, tried in the browser. Each part only adds to what leaves the bank or
 * delays what arrives. Nothing is saved or sent, and no check QED makes reads it.
 */
export interface WhatIf {
  /** Paise spent today by hand: it leaves the bank today. */
  spend: number
  /** Days after its due day that the first salary the worst case counts on arrives. Up to the lateness already allowed for, nothing changes. */
  salaryLate: number
  /** The first salary the worst case counts on never arrives (wins over `salaryLate`). */
  salaryLost: boolean
  /** One bill or instalment the worst case names (by its day and label), larger by `more` paise. */
  bill: { date: string; label: string; more: number } | null
  /** A new cost of `amount` paise on `day` (1 to 28) of each month, from the next such day. */
  monthly: { amount: number; day: number } | null
}
export const NO_WHAT_IF: WhatIf = { spend: 0, salaryLate: 0, salaryLost: false, bill: null, monthly: null }

export interface WhatIfDay {
  k: number; date: string
  /** The server's figure for the day. */
  recorded: number
  /** The day's figure in the what-if: exactly `recorded + spend + salary + bill + monthly`. */
  low: number
  /** What each part has taken from the day's figure by the end of that day (zero or negative paise). */
  spend: number; salary: number; bill: number; monthly: number
}
export interface WhatIfResult {
  days: WhatIfDay[]
  /** The what-if as a path, and what explains each of its days: `runwayDays(path, basis)` adds up to the paisa. */
  path: { date: string; low: number }[]
  basis: RunwayBasis
  recordedLow: { k: number; date: string; low: number }
  low: { k: number; date: string; low: number }
  /** The first day the what-if falls below empty: something due that day could not be paid. */
  firstShort: { k: number; date: string; low: number } | null
  /** The salary the what-if moves: its due day, the day it is counted on as recorded, and in the what-if (null: never). */
  salary: { due: string; counted: string; now: string | null } | null
  changed: boolean
}

/** Labels of what a what-if adds, as they read in its statement. */
export const WHAT_IF_LABEL = { spend: 'What-if: spent today', monthly: 'What-if: new cost each month', bill: (label: string) => `What-if: ${label}, larger` } as const
const paiseIn = (v: number): number => (Number.isSafeInteger(v) && v > 0 ? v : 0)

/**
 * The recorded worst case with harder assumptions, day by day, in integer paise. A day's figure in the server's path is
 * the bank less everything due through that day plus the income certain to have arrived before it, so:
 *   spent today          comes off every day from today;
 *   a bill larger        comes off every day from its day;
 *   a salary later       comes off every day from the day it was counted on to the day before it is counted on now
 *                        (never: to the last day drawn);
 *   a new monthly cost   comes off every day from each day it falls due, once for each time it has.
 * With nothing set the result is the server's path exactly, and every day's parts add up to its change.
 */
export function whatIf(path: { date: string; low: number }[], basis: RunwayBasis, w: WhatIf): WhatIfResult {
  const n = path.length
  const first = path[0]?.date ?? '', last = path[n - 1]?.date ?? ''
  const index = (iso: string): number => dayNumber(iso) - dayNumber(first)
  const spend = new Array<number>(n).fill(0), salary = new Array<number>(n).fill(0), bill = new Array<number>(n).fill(0), monthly = new Array<number>(n).fill(0)
  const named: RunwayEvent[] = [...basis.named]
  const counted = new Map(basis.salary)

  const spent = paiseIn(w.spend)
  if (spent > 0 && n > 0) {
    for (let k = 0; k < n; k++) spend[k] = -spent
    named.push({ date: first, label: WHAT_IF_LABEL.spend, amount: -spent, kind: 'whatif' })
  }

  const more = w.bill ? paiseIn(w.bill.more) : 0
  const which = w.bill ? basis.named.find((e) => e.date === w.bill!.date && e.label === w.bill!.label && e.amount < 0) : undefined
  if (more > 0 && which && n > 0) {
    const from = Math.max(0, index(which.date))
    if (from < n) {
      for (let k = from; k < n; k++) bill[k] = -more
      named.push({ date: path[from]!.date, label: WHAT_IF_LABEL.bill(which.label), amount: -more, kind: 'whatif' })
    }
  }

  let moved: WhatIfResult['salary'] = null
  const firstSalary = [...basis.salary.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]
  if (firstSalary && basis.income > 0 && n > 0) {
    const [was, due] = firstSalary
    const allowed = dayNumber(was) - dayNumber(due) - 1
    const late = Number.isSafeInteger(w.salaryLate) ? Math.min(Math.max(w.salaryLate, 0), 366) : 0
    const now = w.salaryLost ? null : late > allowed ? addDays(due, late + 1) : was
    if (now !== was) {
      const to = now === null ? n : Math.min(n, index(now))
      for (let k = Math.max(0, index(was)); k < to; k++) salary[k] = -basis.income
      counted.delete(was)
      if (now !== null && now <= last && !counted.has(now)) counted.set(now, due)
      moved = { due, counted: was, now }
    }
  }

  const m = w.monthly && paiseIn(w.monthly.amount) > 0 && Number.isInteger(w.monthly.day) && w.monthly.day >= 1 && w.monthly.day <= 28 ? w.monthly : null
  if (m && n > 0) {
    let [y, mo] = ymd(first)
    for (let i = 0; i < 24; i++) {
      const date = `${y}-${String(mo).padStart(2, '0')}-${String(m.day).padStart(2, '0')}`
      if (date > last) break
      if (date >= first) {
        for (let k = index(date); k < n; k++) monthly[k]! -= m.amount
        named.push({ date, label: WHAT_IF_LABEL.monthly, amount: -m.amount, kind: 'whatif' })
      }
      mo += 1
      if (mo > 12) { mo = 1; y += 1 }
    }
  }

  const days: WhatIfDay[] = path.map((p, k) => ({ k, date: p.date, recorded: p.low, low: p.low + spend[k]! + salary[k]! + bill[k]! + monthly[k]!, spend: spend[k]!, salary: salary[k]!, bill: bill[k]!, monthly: monthly[k]! }))
  const lowest = (of: (d: WhatIfDay) => number) => days.reduce<{ k: number; date: string; low: number }>((best, d) => (of(d) < best.low ? { k: d.k, date: d.date, low: of(d) } : best), { k: 0, date: first, low: days[0] ? of(days[0]) : 0 })
  const short = days.find((d) => d.low < 0)
  return {
    days,
    path: days.map((d) => ({ date: d.date, low: d.low })),
    basis: { start: basis.start, spending: basis.spending, income: basis.income, named, salary: counted },
    recordedLow: lowest((d) => d.recorded),
    low: lowest((d) => d.low),
    firstShort: short ? { k: short.k, date: short.date, low: short.low } : null,
    salary: moved,
    changed: days.some((d) => d.low !== d.recorded),
  }
}

/**
 * The what-if's three figures as they are written: the recorded lowest point, what the what-if takes from it, and the
 * what-if's lowest point, each a whole number of paise shown without its sign (a negative one is written "short"). The
 * operator is chosen so that the line adds up as written: free less what it takes is what is left (or short); a
 * shortfall plus what it takes is the larger shortfall.
 */
export function whatIfSum(recorded: number, low: number): { op: '+' | '−'; first: number; takes: number; last: number } {
  return { op: recorded < 0 ? '+' : '−', first: Math.abs(recorded), takes: recorded - low, last: Math.abs(low) }
}

/**
 * What a what-if can change, read from the same basis: the salary it can move (the first the worst case counts on),
 * how late that salary is already allowed to be, and the day it would be counted on if it came `late` days after its
 * due day; and the bills and instalments the worst case names within the days drawn, each of which can be made larger.
 */
export function whatIfChoices(path: { date: string }[], basis: RunwayBasis): {
  salary: { due: string; counted: string; allowed: number; countedIf: (late: number) => string; clashes: (late: number) => boolean } | null
  bills: RunwayEvent[]
} {
  const first = path[0]?.date ?? '', last = path[path.length - 1]?.date ?? ''
  const s = [...basis.salary.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]
  const seen = new Set<string>()
  const bills = basis.named.filter((e) => e.amount < 0 && e.date >= first && e.date <= last && !seen.has(`${e.date}|${e.label}`) && seen.add(`${e.date}|${e.label}`))
  if (!s || basis.income <= 0) return { salary: null, bills }
  const [counted, due] = s
  const countedIf = (late: number) => addDays(due, late + 1)
  return { salary: { due, counted, allowed: dayNumber(counted) - dayNumber(due) - 1, countedIf, clashes: (late: number) => countedIf(late) !== counted && basis.salary.has(countedIf(late)) }, bills }
}

// ------------------------------------------------------------------------------------------------ the score's rows, one per standing authority

/** The days a scheduled instruction is due to run, from its next run, through the days drawn. */
function runDays(p: ProgramSummary, today: string, days: number): { runs: string[]; continuous: boolean } {
  const s = p.params.schedule as { type: string; minutes?: number; weekday?: number; day?: number } | undefined
  const first = p.nextDueAt ?? p.following[0] ?? null
  if (!s || first === null || p.state !== 'active') return { runs: [], continuous: false }
  if (s.type === 'every') return { runs: [], continuous: (s.minutes ?? 1440) < 1440 }
  const from = istDay(first), out: string[] = []
  for (let k = 0; k < days; k++) {
    const d = addDays(today, k)
    if (d < from) continue
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay(), dom = Number(d.slice(8))
    if (s.type === 'daily' || (s.type === 'weekly' && wd === s.weekday) || (s.type === 'monthly' && dom === s.day)) out.push(d)
    else if (s.type === 'once' && d === from) out.push(d)
  }
  if (p.authority && p.authority.expiresAt) { const end = istDay(p.authority.expiresAt); return { runs: out.filter((d) => d <= end), continuous: false } }
  return { runs: out, continuous: false }
}
const MODE: Record<string, string> = { auto: 'acts on its own', approve: 'asks you each time', notify: 'tells you first, then acts' }

/** The on-chain wallet's grants, as the score draws them (raw token units as strings). */
export interface WalletGrants {
  mandate: { status: string; usage: { lifetime: { limit: string; remaining: string }; validity: { validUntil: number } } } | null
  policy: { status: string; targetFree: string } | null
  reserveDecimals: number
}

/**
 * One row of the score for every standing authority, worked out as Home works them out: when each is due to act, how
 * it acts, when its authority lapses and what is left of its limit this month.
 */
export function scoreLanes({ programs, expected, today, stopped, protectiveContinues = false, worst, wallet }: { programs: ProgramSummary[]; expected: PassbookView['expected']; today: string; stopped: boolean; protectiveContinues?: boolean; worst: Worst; wallet: WalletGrants | null }): Lane[] {
  const active = programs.filter((p) => p.state === 'active' || p.state === 'paused')
  const unpaid = expected.filter((e) => e.kind === 'bill' && e.unpaid)
  const bills = active.filter((p) => p.kind === 'bills')
  const lanes: Lane[] = active.map((p) => {
    const l = p.authority && p.usedThisMonth !== null && p.usedThisMonth !== undefined ? { left: Math.max(0, p.authority.maxPerMonth - p.usedThisMonth), of: p.authority.maxPerMonth } : null
    const protective = p.kind === 'floor' || p.kind === 'exit'
    const { runs, continuous } = p.kind === 'bills'
      ? { runs: expected.filter((e) => e.kind === 'bill' && e.by?.id === p.id).map((e) => istDay(e.dueAt)), continuous: false }
      : runDays(p, today, 150)
    return {
      id: p.id, title: p.title, to: `/instructions/${p.id}`,
      // protective selling the pause kept running is not paused, and is not said to be (review of R12, M5)
      mode: p.state === 'paused' || (stopped && !(protective && protectiveContinues)) ? 'paused' : protective ? 'watch' : (p.authority?.runMode ?? 'auto'),
      modeText: p.state === 'paused' ? 'paused' : stopped && !(protective && protectiveContinues) ? 'QED is paused' : protective ? 'sells only to protect you' : MODE[p.authority?.runMode ?? 'auto'] ?? '',
      runs, continuous,
      waiting: p.kind === 'bills' && bills.length === 1 ? unpaid.map((e) => ({ date: istDay(e.dueAt), label: e.label })) : [],
      until: p.authority ? istDay(p.authority.expiresAt) : null,
      left: l ? { ...l, per: 'this month' } : null,
      note: protective ? (worst.valid && p.kind === 'floor' ? `${fmt.money(Math.abs(worst.cushion), true)} ${worst.cushion >= 0 ? 'above' : 'below'} your floor` : 'watching') : null,
    }
  })
  if (wallet?.mandate?.status === 'active') lanes.push({
    id: 'wallet-mandate', title: 'Pay from your on-chain wallet', to: '/vault', mode: 'chain', modeText: "enforced by the wallet's contract", runs: [],
    until: istDay(wallet.mandate.usage.validity.validUntil * 1000),
    left: { left: Number(wallet.mandate.usage.lifetime.remaining), of: Number(wallet.mandate.usage.lifetime.limit), per: 'in all' },
  })
  if (wallet?.policy?.status === 'active') lanes.push({
    id: 'wallet-policy', title: 'Keep the dollar reserve topped up', to: '/vault/policy', mode: 'chain', modeText: 'every five minutes, within the mandate', runs: [], continuous: true,
    note: `keeps $${(Number(wallet.policy.targetFree) / 10 ** wallet.reserveDecimals).toFixed(2)} free`,
  })
  return lanes
}

// ------------------------------------------------------------------------------------------------ the worst case against the floor

/**
 * The household's worst case against the owner's floor, on one rule from nothing, with its figures written on it: the
 * lit part is what would still be there if every holding fell by its limit at once, hatched is what those falls would
 * take, the upright mark is the floor, and QED's bracket spans the room above it (QED refuses its own purchases that
 * would use more). Below the floor, the gap is marked as short. Figures come from the server's valuation
 * (`overview.worst`); this only draws them. Save and Safeguards use it.
 */
export function FloorRule({ worst, fall, floor }: { worst: number; fall: number; floor: number }) {
  const [box, w] = useWidth()
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const today = worst + Math.max(0, fall)
  const lo = Math.min(0, worst), hi = Math.max(today, floor, 1) * 1.04
  const W = Math.max(w, 120)
  const x = (v: number) => 1 + ((v - lo) / (hi - lo)) * (W - 2)
  const below = worst < floor
  const said = `If every holding fell by its limit at once, you would have ${fmt.money(worst, true)}, ${below ? `${fmt.money(floor - worst, true)} below` : `${fmt.money(worst - floor, true)} above`} your floor of ${fmt.money(floor, true)}. The falls would take ${fmt.money(Math.max(0, fall), true)}.`
  // a label sits at its point if it fits there, else is turned to fit, and never leaves the rule (estimated at 7 px a character)
  const place = (at: number, text: string): { x: number; anchor: 'start' | 'middle' | 'end' } => {
    const tw = text.length * 7
    if (at + tw <= W) return { x: Math.max(0, at), anchor: 'start' }
    if (at - tw >= 0) return { x: at, anchor: 'end' }
    return { x: W / 2, anchor: 'middle' }
  }
  const top = `If markets fell: ${fmt.money(worst, true)}`
  const floorText = `Your floor ${fmt.money(floor, true)}`
  const gapText = below ? `${fmt.money(floor - worst, true)} below it` : `${fmt.money(worst - floor, true)} above it`
  const t = place(x(worst) - 4, top)
  const f = place(x(floor) + 6, floorText)
  const g = place(below ? x(worst) + 6 : (x(floor) + x(worst)) / 2 - (gapText.length * 7) / 2, gapText)
  const H = 88, BAR = 22, BH = 14
  return (
    <div ref={box} className="floor-rule">
      {w > 0 ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={said}>
          <defs>
            <pattern id={`${id}-h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line className="fr-hatch" x1="0" y1="0" x2="0" y2="6" /></pattern>
            <linearGradient id={`${id}-k`} x1="0" x2="1" y1="0" y2="0"><stop offset="0" className="fr-keep-a" /><stop offset="1" className="fr-keep-b" /></linearGradient>
            <clipPath id={`${id}-c`}><rect x={x(lo)} y={BAR} width={x(hi) - x(lo)} height={BH} rx={BH / 2} /></clipPath>
          </defs>
          <rect className="fr-track" x={x(lo)} y={BAR} width={x(hi) - x(lo)} height={BH} rx={BH / 2} />
          <g clipPath={`url(#${id}-c)`}>
            {worst > 0 ? <rect className="fr-keep" fill={`url(#${id}-k)`} x={x(0)} y={BAR} width={Math.max(0, x(worst) - x(0))} height={BH} /> : null}
            {fall > 0 ? <rect className="fr-fall" fill={`url(#${id}-h)`} x={x(Math.max(0, worst))} y={BAR} width={Math.max(1.5, x(today) - x(Math.max(0, worst)))} height={BH} /> : null}
          </g>
          <path className={below ? 'fr-short' : 'fr-room'} d={`M${x(Math.min(floor, worst))} ${BAR + BH + 6}V${BAR + BH + 12}H${x(Math.max(floor, worst))}V${BAR + BH + 6}`} />
          <line className="fr-floor-cut" x1={x(floor)} x2={x(floor)} y1={BAR} y2={BAR + BH} />
          <line className="fr-floor" x1={x(floor)} x2={x(floor)} y1={BAR - 5} y2={BAR + BH + 5} />
          <text className="fr-worst" x={t.x} y={13} textAnchor={t.anchor}>{top}</text>
          <text className="fr-floor-label" x={f.x} y={BAR + BH + 28} textAnchor={f.anchor}>{floorText}</text>
          <text className={`fr-gap ${below ? 'below' : ''}`} x={g.x} y={BAR + BH + 46} textAnchor={g.anchor}>{gapText}</text>
        </svg>
      ) : <div style={{ height: H }} />}
    </div>
  )
}

/** A figure set the way Home sets its lead: rupees, then the paise smaller. */
export function Paise({ paise }: { paise: number }): ReactNode {
  const s = fmt.money(paise, true)
  const dot = s.lastIndexOf('.')
  // one inline box, so a flex parent with a gap cannot pull the paise away from the rupees (the finish review)
  return dot < 0 ? s : <span className="with-paise">{s.slice(0, dot)}<span className="paise">{s.slice(dot)}</span></span>
}
