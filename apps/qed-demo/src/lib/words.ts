/**
 * Small words and figures shared by several screens, kept outside any one screen so a screen that needs them does not
 * download another screen with them (R11 perf: Spend took these from Protect, and Protect brought the on-chain wallet).
 * screens/Protect.tsx keeps its own exports of the same names for its other callers.
 *
 * R12 perf (the phone profile, RISK-086): Safeguards took `statusLine` from Instructions and `sessionDevice` from
 * Security, and those two brought Protect, the on-chain wallet and Security with them, so Save, Grow and the Statement
 * (which take their reserve parts from Safeguards) downloaded about 87 KB of compressed script they never ran before
 * their first figure. Both now live here, and Instructions, Protect and Security re-export them for their callers.
 */
import { stateWord } from '../ui/kit.tsx'
import { fmt } from './core.ts'
import type { ProgramSummary } from './types.ts'

/** Each price and value source as a person names it, and what QED takes from it (Grow and Safeguards list them). */
export const SOURCE: Record<string, [string, string]> = {
  coindcx: ['CoinDCX public market data', 'Rupee prices and the order books that paper orders fill against'],
  binance: ['Binance public market stream', 'The second, independent price for digital assets, in US dollars'],
  coinbase: ['Coinbase Exchange public feed', 'A further reference price for bitcoin, in US dollars'],
  amfi: ['AMFI daily NAV file', 'The NAV that every fund order executes at'],
  frankfurter: ['ECB rates, through Frankfurter', 'Dollar and euro reference rates, once each working day'],
  nyfed: ['Federal Reserve Bank of New York', 'SOFR and EFFR reference rates, once each working day'],
  'synthetic-markets': ['Synthetic prices for shares, ETFs, bills and bonds', 'Generated on this QED installation from a stated starting value: a recorded fund NAV for an ETF, a round number for the rest. Not market data, and never live'],
  synthetic: ['Synthetic values (presentation mode)', 'Every price, order book, NAV, rate and history, generated on this QED installation; no market data provider is used'],
}

type Stop = { protectiveContinues?: boolean } | null | undefined
/** Whether QED's own pause holds this instruction: every one does, except protective selling when the owner kept it running. */
export const heldByPause = (kind: string, stop: Stop): boolean => !!stop && !(stop.protectiveContinues && (kind === 'floor' || kind === 'exit'))
/**
 * Where a standing instruction stands, in one sentence (Instructions, Safeguards, Earn and Compose say it the same way).
 * While QED is paused (`stop`, the session's), an instruction the pause holds says so, not its next run (R12, gap 15).
 */
export function statusLine(p: ProgramSummary, now: number, stop?: Stop): string {
  if (p.state === 'draft') return 'Drafted, not signed. It can do nothing until you sign it.'
  if (p.state === 'paused') return `Paused${p.pausedReason ? `: ${p.pausedReason.toLowerCase()}` : ''}. No new runs start.`
  if (p.state !== 'active') return `${stateWord(p.state)}. It can no longer act.`
  if (heldByPause(p.kind, stop)) return 'QED is paused: no run starts until you resume it.'
  if (p.watching) return `Not being evaluated since ${fmt.dayTime(p.watching.since)}: ${p.watching.why}`
  if (p.nextDueAt) return `Next run ${fmt.dayTime(p.nextDueAt)} (${fmt.rel(p.nextDueAt, now)}).`
  if (p.kind === 'exit') return p.lastChecked ? `Watching the price. Last checked ${fmt.age(now - p.lastChecked)}${p.lastBid ? ` at ${fmt.price(String(p.lastBid))}` : ''}${p.high ? `; highest seen ${fmt.price(String(p.high))}` : ''}.` : 'Watching the price.'
  if (p.kind === 'floor') return p.lastChecked ? `Watching your floor against what markets falling to your limits would leave. Last checked ${fmt.age(now - p.lastChecked)}.` : 'Watching your floor against what markets falling to your limits would leave.'
  if (p.kind === 'bills') return 'Waiting for a bill from its payees to fall due.'
  if (p.kind === 'split') return 'Waiting for salary or earnings to be recorded.'
  return 'In force.'
}

/**
 * A session as a person names it, from its user-agent string: the browser and the system ("Chrome on a Mac"), or, for a
 * client that is not a browser (a script, a command-line tool), that it is a program. Security and Safeguards name
 * sessions the same way.
 */
export function sessionDevice(ua: string | null): string {
  if (!ua) return 'An unnamed device'
  if (!/^Mozilla\//.test(ua) || /node|undici/i.test(ua)) return 'A program, not a browser'
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'a Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} on ${os}` : b
}

/** How a standing instruction runs, in words. */
export const MODE_WORD: Record<string, string> = { auto: 'On its own', approve: 'Asks you each time', notify: 'Tells you first, then acts' }
const istDay = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(ms)
/** "Today", "Tomorrow", "Yesterday" or "Tue 24 Nov": a near date as a person says it. */
export function nearDay(ms: number, now: number): string {
  if (istDay(ms) === istDay(now)) return 'Today'
  if (istDay(ms) === istDay(now + 86_400_000)) return 'Tomorrow'
  if (istDay(ms) === istDay(now - 86_400_000)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(ms)
}
/** A clock time in India. */
export const clock = (ms: number): string => fmt.time(ms)
/** What a standing instruction may still move this month: the policy check's own count against its signed limit. */
export function monthLeft(p: ProgramSummary): { left: number; of: number } | null {
  if (!p.authority || p.usedThisMonth === null || p.usedThisMonth === undefined) return null
  return { left: Math.max(0, p.authority.maxPerMonth - p.usedThisMonth), of: p.authority.maxPerMonth }
}
/**
 * Token atoms as paise, for the one formatter of sums (test rupees have at least two decimals). Here rather than with the
 * on-chain wallet's inline parts (WalletInline.tsx, which re-exports it) so that Protect, which reads its figures, need not
 * download the wallet's page before its first draw (R12 perf, the phone profile).
 */
export const atomsToPaise = (raw: string, decimals: number): number => (decimals >= 2 ? Number(BigInt(raw) / 10n ** BigInt(decimals - 2)) : Number(raw) * 10 ** (2 - decimals))

// ------------------------------------------------------------------------------------------------ payments that wait, and pending ones

/** A time in words for a sentence: "14:07" today, "14:07 tomorrow", or "14:07 on 26 Nov". */
export function atTime(ms: number, now: number): string {
  const day = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10)
  if (day(ms) === day(now)) return fmt.time(ms)
  if (day(ms) === day(now + 86_400_000)) return `${fmt.time(ms)} tomorrow`
  return `${fmt.time(ms)} on ${fmt.day(ms)}`
}

/**
 * A payment on hold (server/new-payee.ts): when it is sent and what can still be done, in one sentence. While QED is
 * paused past its time it keeps waiting until the owner resumes (the pause holds it).
 */
export function heldWords(a: { params: { hold?: { until: number } }; result: Record<string, unknown> }, now: number, paused: boolean): string {
  // held because it repeats an earlier payment (server/duplicates.ts): it waits for the person, not for a time
  const w = a.result.awaitingConfirmation as { why?: string; expiresAt?: number } | undefined
  if (w && typeof a.result.duplicateConfirmedAt !== 'number') return `It waits for your confirmation, because it repeats an earlier payment. Its money is set aside. If you do neither, it is cancelled at ${atTime(w.expiresAt ?? now, now)} and nothing is sent.`
  const until = a.params.hold?.until ?? 0
  if (until <= now && paused) return `Its wait ended at ${atTime(until, now)}, but QED is paused, so it has not been sent. It goes when you resume, unless you cancel it.`
  if (until <= now) return 'Its wait is over: QED sends it now.'
  return `It is sent at ${atTime(until, now)}, not before. Its money is set aside until then, and you can cancel it.`
}

/**
 * The rail's bound on a payment it has not answered yet (server/venues.ts PaperRail.answerBy; R12 task comparison, gap 11):
 * by when an answer comes, and what QED does if none comes. Null when the payment is not waiting on the rail.
 */
export function railBound(a: { kind: string; state: string; result: Record<string, unknown> }, now: number): string | null {
  const by = railAnswerBy(a, now)
  return by ? `${by} ${IF_NO_ANSWER}` : null
}
/** What QED does when the rail gives no answer: it never sends the payment again. */
export const IF_NO_ANSWER = 'If no answer comes, QED does not send it again: it waits for the rail\'s answer, and if the rail says it failed, the money comes back to your bank.'
/** By when the rail answers a payment waiting on it, in a sentence; null when the payment is not waiting on the rail. */
export function railAnswerBy(a: { kind: string; state: string; result: Record<string, unknown> }, now: number): string | null {
  if (a.kind !== 'payment' || (a.state !== 'working' && a.state !== 'submitting')) return null
  const by = Number(a.result.answerBy)
  if (!Number.isFinite(by) || by <= 0) return null
  return now > by ? `The rail was to answer by ${atTime(by, now)} and has not yet.` : `The rail answers by ${atTime(by, now)}.`
}

/** A length of time in words, in hours, minutes or seconds; never rounded to zero (test mode shortens delays to seconds). */
const span = (ms: number): string => {
  const [n, unit] = ms >= 3600_000 ? [Math.round(ms / 3600_000), 'hour'] : ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}
/** The protection delay in words; a shortened one says so (Protect.tsx delayWords, kept here so Safeguards need not load Protect). */
export const protectionDelayWords = (ms: number): string => (ms < 72 * 3600_000 ? `${span(ms)} here (72 hours normally)` : span(ms))

/** The household's figures and protections as Safeguards names them (server/household.ts PROFILE_KEYS). */
const PROFILE_LABEL: Record<string, string> = {
  line: 'Your floor', lateDays: 'Income arriving late, allowed for', lostSalaries: 'Salaries that never arrive, allowed for',
  newPayeeHoldAbove: 'New payees: payments wait above', newPayeeHoldHours: 'New payees: the wait',
  income: 'Salary, each month', incomeDay: 'Salary arrives on day', spending: 'Everyday spending, each month',
  personalLoanEmi: 'Personal loan instalment', homeLoanEmi: 'Home loan instalment', emiDay: 'Instalments leave on day',
}
const MONEY_KEYS = new Set(['line', 'newPayeeHoldAbove', 'income', 'spending', 'personalLoanEmi', 'homeLoanEmi'])
/** One figure or protection's value in words. */
export function profileValue(key: string, v: number): string {
  if (MONEY_KEYS.has(key)) return fmt.money(v)
  if (key === 'lateDays') return v === 0 ? 'not at all' : `${v} day${v === 1 ? '' : 's'}`
  if (key === 'lostSalaries') return ['none', 'one', 'two', 'three'][v] ?? String(v)
  if (key === 'newPayeeHoldHours') return v === 0 ? 'no wait' : `${v} hour${v === 1 ? '' : 's'}`
  return String(v)
}
/** A waiting change, key by key: "Your floor: ₹5,00,000 becomes ₹3,00,000", in Safeguards' order. */
export function profileChangeLines(c: { after: Record<string, number>; before: Record<string, number> }, keys?: readonly string[]): string[] {
  return Object.keys(PROFILE_LABEL).filter((k) => c.after[k] !== undefined && (!keys || keys.includes(k)))
    .map((k) => `${PROFILE_LABEL[k]}: ${c.before[k] !== undefined ? `${profileValue(k, c.before[k]!)} becomes ` : ''}${profileValue(k, c.after[k]!)}`)
}
