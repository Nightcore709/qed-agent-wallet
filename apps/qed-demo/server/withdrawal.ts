/**
 * The withdrawal plan: which of the household's funds a withdrawal sells, in what order, and what it costs.
 *
 * The rule is fixed, written out in RULE_WORDS (and signed with the instruction), and worked out here on the server from what
 * the app already records: each fund's latest NAV and where it came from, its payout days and exit load (registry terms), the
 * units and their purchase dates (lots), and the tax rules in tax.ts. Nothing is invented. The same inputs always give the same
 * plan, with no model involved, so what the owner sees before approving is what a run does at that moment.
 *
 * Every figure is an estimate on today's NAV on paper: the registrar prices a redemption at a later NAV, and no fund house is
 * involved. Tax deducted at source is not modelled for funds in this app (only for digital assets), so none is shown or taken.
 */
import { homeMoneyExact } from '../shared/home-money.ts'
import { notional, parsePrice, quantityFor } from '../shared/fixed.ts'
import { type Db, ist, refused, whenIst, addDays } from './core.ts'
import { available } from './ledger.ts'
import { type Instrument, instrument, term } from './registry.ts'
import { CLASS_NAME, classOf, treatment } from './tax.ts'
import type { Ctx } from './types.ts'
import { navEntitlement, payoutInstant } from './venues.ts'

const rs = (paise: number | bigint): string => homeMoneyExact(paise)
const DAY = 86_400_000

/** The version of the rule below. A plan signed with a version this code does not implement is refused, never planned by another rule. */
export const RULE_VERSION = 1
/** What the owner approves: the funds a withdrawal may sell from, a floor on what stays, and the day the money is needed by. */
export interface WithdrawalScope { sources: string[]; reserve: number; needByDays: number | null; ruleVersion?: number }

export const RULE_WORDS: string[] = [
  'Each run first leaves out a fund that cannot be used: no NAV received, no free units, or its money would reach your bank after the day you need it.',
  'A fund whose units to be sold are still inside the exit-load period goes last, and is used only when no other fund can cover the amount.',
  'Among the rest, the fund whose money arrives soonest goes first (overnight, liquid and money-market funds before the others).',
  'A tie goes to the lower estimated cost (exit load plus the modelled tax on the gain; a tax that cannot be worked out, such as a slab-rate gain, counts as unknown, not as nothing), then to the fund\'s name.',
  'It never sells so much that less than your reserve is left across the funds you approved. Money already in your bank is not a source: it is where the withdrawal goes.',
  'If the funds that can be used do not cover the amount, it sells what they allow and says how much was not withdrawn and why. Later runs do not make it up, and it never reaches for a fund you did not approve.',
]

export interface Leg {
  instrumentId: string; name: string; category: string
  units: string; unitsText: string; gross: number; exitLoad: number; tax: number | null; taxNote: string; gain: number
  navPrice: string; navProvider: string; navDate: string; payoutDays: number; settlesAt: number; onTime: boolean; loadNote: string
  /** Why it sits where it does in the order, in words. */
  why: string; last: boolean
}
export interface Left { instrumentId: string; name: string; reason: string; kind: 'gone' | 'no-nav' | 'none-held' | 'late' | 'covered' | 'reserve' | 'tiny' }
export interface Withdrawal {
  target: number; planned: number; shortfall: number; owed: boolean; shortfallWhy: string[]
  legs: Leg[]; left: Left[]; reserve: number; valueNow: number; usableValue: number; keptAfter: number; ruleVersion: number
  /** The latest instant the money may reach the bank, or null when no day was set. */
  neededBy: number | null; neededByDays: number | null; rule: string[]; basis: string
}

/**
 * What one withdrawal of `units` would cost, worked out on the units it would redeem first-in, first-out: the exit load on
 * each slice by how long it has been held (the scheme's graded or flat load), and the tax on each slice's gain by the rule in
 * force (tax.ts, a model: a slab-rate class has no figure). All are estimates on today's NAV; the real NAV is a later one.
 */
export function swpEstimate(ctx: Ctx, userId: string, inst: Instrument, units: bigint, nav: string, now: number): { gross: number; exitLoad: number; gain: number; shortGain: number; tax: number | null; taxNote: string; slices: number; loadNote: string } {
  const price = parsePrice(nav)
  const gross = Number(notional(units, inst.baseScale, price, inst.quoteScale, 'down'))
  const lots = ctx.db.all<{ opened_at: number; qty: string; remaining: string; cost: string }>(
    'SELECT opened_at, CAST(qty AS TEXT) qty, CAST(remaining AS TEXT) remaining, CAST(cost AS TEXT) cost FROM lots WHERE user_id = ? AND instrument_id = ? AND remaining > 0 ORDER BY opened_at, id', userId, inst.id)
  const lt = term(ctx.db, inst.meta.exitLoad ?? 'mf.exitload.none')
  const byDay = Array.isArray(lt?.value.byDay) ? (lt!.value.byDay as string[]) : null
  const flat = !byDay && typeof lt?.value.rate === 'string' ? Number(lt.value.rate) : 0
  let left = Number(units), exitLoad = 0, gain = 0, shortGain = 0, tax = 0, slab = false, slices = 0
  const cls = (at: number) => classOf(ctx.db, inst.id, at)
  for (const l of lots) {
    if (left <= 0) break
    const rem = Number(l.remaining), take = Math.min(rem, left)
    left -= take; slices++
    const value = gross * (take / Number(units)), cost = Number(l.cost) * (take / Number(l.qty))
    const days = Math.floor((now - l.opened_at) / DAY)
    const rate = byDay ? (days >= 0 && days < byDay.length ? Number(byDay[days]) : 0) : flat
    exitLoad += value * rate
    const g = value - cost
    gain += g
    const tr = treatment(cls(l.opened_at), l.opened_at, now)
    if (tr.term === 'short' && g > 0) shortGain += g
    if (tr.rateBp === null) slab = true
    else if (g > 0) tax += g * (tr.rateBp / 10_000)
  }
  const c = cls(lots[0]?.opened_at ?? now)
  const taxNote = lots.length === 0 ? 'No units are held yet, so there is no gain to tax.' : slab
    ? `Taxed at your slab rate (${CLASS_NAME[c]}); this app does not know your slab, so no figure is given. The gain on this withdrawal is about ${rs(Math.max(0, Math.round(gain)))}.`
    : `${CLASS_NAME[c]}: modelled rate on the gain, before any yearly exemption. A model of the rules, not tax advice.`
  return { gross, exitLoad: Math.round(exitLoad), gain: Math.round(gain), shortGain: Math.round(shortGain), tax: slab ? null : Math.round(tax), taxNote, slices, loadNote: lt ? `${lt.name} (${lt.status})` : 'none modelled' }
}

/** The funds a plan may sell from, as approved: the one it names, then any it adds. */
export const sourcesOf = (p: { instrumentId: string; alsoFrom?: string[] }): string[] => [p.instrumentId, ...(p.alsoFrom ?? []).filter((x) => x !== p.instrumentId)]
export const scopeOf = (p: { instrumentId: string; alsoFrom?: string[]; reserve?: number; needByDays?: number; withdrawalRule?: number }): WithdrawalScope => ({ sources: sourcesOf(p), reserve: p.reserve ?? 0, needByDays: p.needByDays ?? null, ...(p.withdrawalRule !== undefined ? { ruleVersion: p.withdrawalRule } : {}) })

interface Cand {
  inst: Instrument; units: bigint; value: number; price: string; provider: string
  navDate: string; payoutDays: number; settlesAt: number; onTime: boolean
}
const unitsText = (u: bigint, inst: Instrument): string => (Number(u) / 10 ** inst.baseScale).toFixed(3)
const isBusiness = (date: string): boolean => { const w = new Date(`${date}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 }

/** The business day on which the registrar receives a request made at `at`: that day if it is a business day and before the 15:00 cut-off, else the next. */
export function receivingDay(at: number): string {
  const t = ist(at)
  if (isBusiness(t.date) && t.minutes < 15 * 60) return t.date
  let d = addDays(t.date, 1)
  while (!isBusiness(d)) d = addDays(d, 1)
  return d
}
/** The latest instant the money may reach the bank for a request made at `at`: `days` business days after the day it is received, 10:00 India time. */
export const neededByInstant = (at: number, days: number): number => payoutInstant(receivingDay(at), days)
/** When a redemption sent at `at` would pay, by the registrar's own rule. */
export const payoutAt = (inst: Instrument, at: number): number => payoutInstant(navEntitlement(inst, 'sell', at).minNavDate, inst.meta.payoutDays ?? 2)

const loadNoteOf = (db: Db, inst: Instrument): string => { const t = term(db, inst.meta.exitLoad ?? 'mf.exitload.none'); return t ? `${t.name} (${t.status})` : 'none modelled' }

export function planWithdrawal(ctx: Ctx, userId: string, w: WithdrawalScope, target: number, now: number): Withdrawal {
  const ruleVersion = w.ruleVersion ?? RULE_VERSION
  if (ruleVersion !== RULE_VERSION) throw refused('rule_version', `This plan was signed under withdrawal rule ${ruleVersion}, which this version of QED does not implement, so it will not plan a withdrawal by another rule. Nothing was sold.`)
  const db: Db = ctx.db
  const neededBy = w.needByDays === null ? null : neededByInstant(now, w.needByDays)
  const left: Left[] = []
  const cands: Cand[] = []
  let valueNow = 0
  for (const id of w.sources) {
    const inst = instrument(db, id)
    if (!inst || !inst.tradable || inst.kind !== 'mutual_fund') { left.push({ instrumentId: id, name: inst?.name ?? id, reason: 'It is no longer offered for withdrawal.', kind: 'gone' }); continue }
    const nav = ctx.market.get(inst.id, 'nav')
    if (!nav) { left.push({ instrumentId: id, name: inst.name, reason: `No NAV has been received for ${inst.name}, so its units cannot be priced.`, kind: 'no-nav' }); continue }
    const units = available(db, userId, `pos:${inst.id}`)
    if (units <= 0n) { left.push({ instrumentId: id, name: inst.name, reason: `You hold no free units of ${inst.name}.`, kind: 'none-held' }); continue }
    const value = Number(notional(units, inst.baseScale, parsePrice(nav.price), inst.quoteScale, 'down'))
    valueNow += value
    const payoutDays = inst.meta.payoutDays ?? 2
    const navDate = navEntitlement(inst, 'sell', now).minNavDate
    const settlesAt = payoutInstant(navDate, payoutDays)
    cands.push({ inst, units, value, price: nav.price, provider: nav.provider, navDate, payoutDays, settlesAt, onTime: neededBy === null || settlesAt <= neededBy })
  }
  for (const c of cands.filter((x) => !x.onTime)) left.push({ instrumentId: c.inst.id, name: c.inst.name, reason: `Its money would reach your bank about ${whenIst(c.settlesAt)}, after ${whenIst(neededBy!)}, the latest you need it.`, kind: 'late' })
  const pool = cands.filter((c) => c.onTime)
  const usableValue = pool.reduce((t, c) => t + c.value, 0)
  const step = (c: Cand): number => Number(notional(1n, c.inst.baseScale, parsePrice(c.price), c.inst.quoteScale, 'up')) + 1 // one thousandth of a unit and a paisa: rounding, not money
  let need = target
  let budget = Math.max(0, valueNow - w.reserve)
  let reserveLimited = false
  const legs: Leg[] = []
  let lastStep = 0
  while (need > 0 && pool.length > 0) {
    // each fund is judged on the units it would actually sell now, first-in, first-out
    const evals = pool.map((c) => {
      const take = Math.min(need, c.value, budget)
      if (take <= 0) return null
      const all = take >= c.value
      const units = all ? c.units : quantityFor(BigInt(take), c.inst.quoteScale, parsePrice(c.price), c.inst.baseScale, 'down')
      if (units <= 0n) return null
      const est = swpEstimate(ctx, userId, c.inst, units, c.price, now)
      const cost = est.tax === null ? null : est.exitLoad + est.tax
      return { c, take, all, units, est, load: est.exitLoad > 0, cost, ratio: cost === null ? null : cost / Math.max(1, est.gross) }
    }).filter((e): e is NonNullable<typeof e> => e !== null)
    if (evals.length === 0) break
    evals.sort((a, b) => Number(a.load) - Number(b.load) || a.c.payoutDays - b.c.payoutDays
      || (a.ratio === null ? 1 : 0) - (b.ratio === null ? 1 : 0) || (a.ratio ?? 0) - (b.ratio ?? 0) || a.c.inst.name.localeCompare(b.c.inst.name))
    const pick = evals[0]!
    if (pick.take < Math.min(need, pick.c.value)) reserveLimited = true
    const days = `${pick.c.payoutDays} business day${pick.c.payoutDays === 1 ? '' : 's'}`
    const why = `${legs.length === 0 ? 'First' : 'Next'}: ${pick.load ? 'its units to be sold are inside the exit-load period, so it is used only because no other usable fund could cover the amount' : 'no exit load on the units to be sold'}; its money reaches your bank in ${days}${pick.cost === null ? '; its tax cannot be worked out, so its cost is unknown' : ''}.`
    legs.push({ instrumentId: pick.c.inst.id, name: pick.c.inst.name, category: String(pick.c.inst.meta.category ?? ''), units: pick.units.toString(), unitsText: unitsText(pick.units, pick.c.inst), gross: pick.est.gross, exitLoad: pick.est.exitLoad, tax: pick.est.tax, taxNote: pick.est.taxNote, gain: pick.est.gain,
      navPrice: pick.c.price, navProvider: pick.c.provider, navDate: pick.c.navDate, payoutDays: pick.c.payoutDays, settlesAt: pick.c.settlesAt, onTime: true, loadNote: loadNoteOf(db, pick.c.inst), why, last: pick.all })
    need -= pick.est.gross; budget -= pick.est.gross
    lastStep = step(pick.c)
    pool.splice(pool.indexOf(pick.c), 1)
    // what is left after a sale is a rounding gap of under a thousandth of a unit and a paisa: it is not another sale from the next fund
    if (need <= lastStep) need = 0
  }
  for (const c of pool) {
    if (need <= 0) left.push({ instrumentId: c.inst.id, name: c.inst.name, reason: 'Not needed: funds earlier in the order cover the amount.', kind: 'covered' })
    else { reserveLimited = true; left.push({ instrumentId: c.inst.id, name: c.inst.name, reason: `Not sold: it would leave less than your reserve of ${rs(w.reserve)}.`, kind: 'reserve' }) }
  }
  const planned = legs.reduce((t, l) => t + l.gross, 0)
  let shortfall = Math.max(0, target - planned)
  if (legs.length && shortfall <= lastStep) shortfall = 0
  // What was not withdrawn is owed because of a fund that could not be used or a reserve that limited a sale. A plan that has simply
  // sold every unit it may sell is at its end, as the plan says, and owes nothing.
  const why: string[] = []
  if (shortfall > 0) {
    if (reserveLimited && w.reserve > 0) why.push(`Your reserve of ${rs(w.reserve)} is kept.`)
    for (const l of left) if (l.kind === 'gone' || l.kind === 'no-nav' || l.kind === 'late' || l.kind === 'tiny') why.push(`${l.name}: ${l.reason}`)
  }
  const first = cands[0]
  const basis = `NAV on paper as last received${first ? ` (${first.provider}, NAV date ${first.navDate})` : ''}; the registrar prices a redemption at a later NAV. Estimates, not a promise of money.`
  return { target, planned, shortfall, owed: shortfall > 0 && why.length > 0, shortfallWhy: why, legs, left, reserve: w.reserve, valueNow, usableValue, keptAfter: Math.max(0, valueNow - planned), ruleVersion, neededBy, neededByDays: w.needByDays, rule: RULE_WORDS, basis }
}
