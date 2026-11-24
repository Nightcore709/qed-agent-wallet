/**
 * A fund order's states, in the words every screen uses (R12 task comparison, gap 17, T4-d). "Sent" used to cover
 * everything until units arrived; the paper registrar now records each state with its own time (server/venues.ts,
 * PaperFundVenue), and the order's record carries them (server/execute.ts settleOrder: registrarAt, fundsAt,
 * allottedAt, navDate):
 *
 *   a purchase     Order with the registrar  ->  Money received by the fund house, <day>  ->  Units allotted, <day>
 *   a redemption   Order with the registrar  ->  Units redeemed, <day>                      ->  Money paid to your bank
 *
 * The day the money arrives, against the cut-off, sets the NAV day, so it is said with its date. Days are written as
 * the rest of the app writes them ("Wed 25 Nov", shared/day-text.ts), never as a database's "2026-11-25". Home's "With
 * the fund house" line, Grow's orders in progress, Activity and the record all read from here. Pure: no screen imports.
 */
import { dayOf, dayText, istDay } from '../../shared/day-text.ts'
import { atomsText, quantityText } from '../ui/prices.ts'
import { fmt } from './core.ts'
import type { ActionView } from './types.ts'

export type FundStep = 'registrar' | 'money' | 'allotted' | 'redeemed' | 'paid'
export interface FundStage { step: FundStep; done: boolean; title: string; at: number | null; says: string }
type Order = Pick<ActionView, 'state' | 'params' | 'result' | 'times'>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
/** A day is one word on a line: its spaces do not break ("Tue 24 Nov" is never split across two lines). */
const nb = (t: string): string => t.replace(/ /g, '\u00a0')
/** A day in words, with the year only when it is not this year's. */
const day = (iso: string | null, now: number): string => (iso ? nb(dayText(iso, istDay(now))) : 'its day')
const dayAt = (ms: number, now: number): string => nb(dayOf(ms, now))
/** "Thu 26 Nov, 10:00": a moment as a person reads a near one. */
const when = (ms: number, now: number): string => `${dayAt(ms, now)}, ${fmt.time(ms)}`
const units = (atoms: unknown): string => `${quantityText(atomsText(String(atoms ?? '0'), 3), 3)} units`
/** A NAV as published, to four places. */
const navText = (price: unknown): string | null => (typeof price === 'string' && Number.isFinite(Number(price)) ? `₹${Number(price).toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : null)
/** What the units came at: "189.859 units at ₹105.3358, the NAV for Tue 24 Nov." */
const cameAt = (r: Record<string, unknown>, navDay: string): string => `${units(r.filledQty)} at ${navText(r.navPrice) ? `${navText(r.navPrice)}, ` : ''}the NAV for ${navDay}.`
/** Why the NAV is for the day it is: when the money (or the request) arrived against the cut-off. */
const againstCutoff = (r: Record<string, unknown>, what: string, navDay: string): string =>
  typeof r.beforeCutoff === 'boolean' && typeof r.cutoff === 'string' ? `${what} ${r.beforeCutoff ? 'before' : 'after'} the ${r.cutoff} India time cut-off, so it takes the NAV for ${navDay}.` : `It takes the NAV for ${navDay}.`

/** Each state of a fund order, in order, done or still to come, with the registrar's own time where it has one. */
export function fundStages(a: Order, now: number): FundStage[] {
  const r = a.result
  const registrarAt = num(r.registrarAt) ?? num(a.times.submitted)
  const navDay = str(r.navDate) ?? str(r.navEntitledFrom)
  const registrar: FundStage = { step: 'registrar', done: registrarAt !== null, title: 'Order with the registrar', at: registrarAt, says: '' }
  const executedAt = num(r.allottedAt)
  if (a.params.side === 'sell') {
    const paid = a.state === 'done' || a.state === 'partial'
    const payoutAt = num(r.payoutAt)
    return [
      { ...registrar, says: `The units are reserved for it until they are redeemed. ${againstCutoff(r, 'It reached the registrar', day(str(r.navEntitledFrom) ?? navDay, now))}` },
      executedAt !== null
        ? { step: 'redeemed', done: true, title: `Units redeemed, ${dayAt(executedAt, now)}`, at: executedAt, says: cameAt(r, day(navDay, now)) }
        : { step: 'redeemed', done: false, title: 'Units not redeemed yet', at: null, says: `At the NAV for ${day(navDay, now)}, once the fund house publishes it.` },
      paid
        ? { step: 'paid', done: true, title: 'Money paid to your bank', at: null, says: '' }
        : { step: 'paid', done: false, title: 'Money not paid yet', at: payoutAt, says: payoutAt !== null ? `It reaches your bank ${when(payoutAt, now)}.` : 'It is paid on a business day after the NAV day.' },
    ]
  }
  const fundsAt = num(r.fundsAt)
  return [
    { ...registrar, says: 'Your money is on its way to the fund house.' },
    fundsAt !== null
      ? { step: 'money', done: true, title: `Money received by the fund house, ${dayAt(fundsAt, now)}`, at: fundsAt, says: againstCutoff(r, 'It arrived', day(str(r.navEntitledFrom) ?? navDay, now)) }
      : { step: 'money', done: false, title: 'Money not received yet', at: null, says: 'On paper it reaches the fund house about 2 seconds after the order; when it arrives, against the cut-off, sets the NAV.' },
    executedAt !== null
      ? { step: 'allotted', done: true, title: `Units allotted, ${dayAt(executedAt, now)}`, at: executedAt, says: cameAt(r, day(navDay, now)) }
      : { step: 'allotted', done: false, title: 'Units not allotted yet', at: null, says: `At the NAV for ${day(navDay, now)}, once the fund house publishes it, usually late that evening.` },
  ]
}

/** Where a fund order in progress stands, in one or two sentences (Activity, the record, Grow's orders in progress). */
export function fundLine(a: Order, now: number): string {
  const r = a.result
  const navDay = day(str(r.navDate) ?? str(r.navEntitledFrom), now)
  const fundsAt = num(r.fundsAt), executedAt = num(r.allottedAt), payoutAt = num(r.payoutAt)
  if (a.params.side === 'sell') {
    if (executedAt !== null) return `Units redeemed ${dayAt(executedAt, now)}. ${payoutAt !== null ? `The money reaches your bank ${when(payoutAt, now)}.` : 'The money is paid on a business day after the NAV day.'}`
    return `Order with the registrar. The units are reserved, to be redeemed at the NAV for ${navDay}.`
  }
  if (fundsAt !== null) return `Money received by the fund house ${dayAt(fundsAt, now)}. Units at the NAV for ${navDay}, once it is published, usually late that evening.`
  return `Order with the registrar. The money reaches the fund house in a moment; units at the NAV for ${navDay}, once it is published.`
}

/** One order's state in a phrase, for a list of several. */
function phrase(a: Order, now: number): string {
  const r = a.result
  const executedAt = num(r.allottedAt), fundsAt = num(r.fundsAt), payoutAt = num(r.payoutAt)
  if (a.params.side === 'sell') return executedAt !== null ? `units redeemed ${dayAt(executedAt, now)}; the money reaches your bank ${payoutAt !== null ? when(payoutAt, now) : 'after the NAV day'}` : 'redemption with the registrar'
  return fundsAt !== null ? `money received by the fund house ${dayAt(fundsAt, now)}` : 'order with the registrar'
}

/** Home's "With the fund house" line: one order's state and when its units come, or each of several (two, then how many more). */
export function fundSummary(orders: Order[], now: number): string {
  if (orders.length === 0) return ''
  if (orders.length === 1) {
    const a = orders[0]!
    const p = phrase(a, now)
    const line = `${p[0]!.toUpperCase()}${p.slice(1)}`
    return a.params.side === 'sell' ? line : `${line}; units at the NAV for ${day(str(a.result.navEntitledFrom), now)}, once published`
  }
  const shown = orders.slice(0, 2).map((a) => phrase(a, now))
  return `${orders.length} orders: ${shown.join('; ')}${orders.length > 2 ? `; and ${orders.length - 2} more` : ''}`
}
