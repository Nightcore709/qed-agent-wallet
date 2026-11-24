/**
 * A goal in another currency (R13 section 7, Save): "Kyoto in spring, JPY 3,00,000 by 1 Apr 2027". Its money is the
 * household's balance in that currency at the paper bank, counted at the currency's own precision; one goal per currency,
 * so a balance is never counted twice. What is left, and a month's share of it, are also said in rupees at a named
 * reference rate, rounded once, as an estimate: a reference rate is not a price anyone can trade at.
 *
 * It moves no money and holds no authority: the owner changes rupees into the currency at a quote (server/fx.ts) to fund
 * it. A goal in rupees stays a signed instruction with its set-aside (server/goals.ts).
 */
import { AppError, audit, bad, type Db, newId, notFound } from './core.ts'
import { amountIn, balanceAccount, rateText, referenceRates } from './fx.ts'
import { getProfile, zoneOf } from './household.ts'
import { account, balance } from './ledger.ts'
import type { Ctx } from './types.ts'
import { type Currency, CURRENCY_NAMES, currencyInstrument, isPaperCurrency, money, moneyText } from '../shared/currency.ts'
import { convert, divRound } from '../shared/instrument.ts'
import { dateWords, whenIn, zonedParts } from '../shared/zone.ts'
import { isDate } from '../shared/period.ts'

type Raw = Record<string, unknown>
/** The furthest a goal's date may be, as for a goal in rupees (goals.ts MAX_GOAL_DAYS). */
export const MAX_FX_GOAL_DAYS = 395

export interface FxGoalRow { id: string; user_id: string; name: string; currency: Currency; target_text: string; by_date: string; created_at: number; removed_at: number | null }

export function addFxGoal(db: Db, userId: string, raw: Raw, now: number): FxGoalRow {
  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : ''
  if (currency === 'INR') throw bad('A goal in rupees is set up under "Saving for a goal": its monthly figure is signed as an instruction.', { currency: 'Choose another currency.' })
  if (!isPaperCurrency(currency)) throw new AppError(400, 'currency_not_held', `The paper bank does not hold ${currency || 'that currency'}.`, { currency: 'Choose a currency the paper bank holds.' })
  if (name.length < 2) throw bad('Name the goal.', { name: 'Name the goal.' })
  const target = amountIn(currency, raw.target, 'target')
  const today = zonedParts(now, zoneOf(getProfile(db, userId))).date
  const by = typeof raw.by === 'string' ? raw.by : ''
  const latest = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_FX_GOAL_DAYS * 86_400_000).toISOString().slice(0, 10)
  if (!isDate(by) || by <= today || by > latest) throw bad(`Choose a date after today and no later than ${dateWords(latest)}.`, { by: `After today, at most ${MAX_FX_GOAL_DAYS} days away.` })
  if (db.get('SELECT 1 FROM fx_goals WHERE user_id = ? AND currency = ? AND removed_at IS NULL', userId, currency)) throw new AppError(409, 'exists', `You already have a goal in ${currency}: your ${CURRENCY_NAMES[currency]} balance counts toward one goal only.`, { currency: 'One goal per currency.' })
  const id = newId('fxg', now)
  db.run('INSERT INTO fx_goals (id, user_id, name, currency, target_text, by_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, userId, name, currency, target.minor.toString(), by, now)
  audit(db, now, userId, 'owner', 'fx.goal.add', id, { currency, target: target.minor.toString(), by })
  return db.get<FxGoalRow>('SELECT * FROM fx_goals WHERE id = ?', id)!
}

export function removeFxGoal(db: Db, userId: string, id: string, now: number): void {
  if (!db.run('UPDATE fx_goals SET removed_at = ? WHERE user_id = ? AND id = ? AND removed_at IS NULL', now, userId, id).changes) throw notFound('That goal')
  audit(db, now, userId, 'owner', 'fx.goal.remove', id, {})
}

/** Calendar months from this one up to the one before the goal's date (at least one): when a month's share is put by. */
const monthsBetween = (today: string, by: string): number => Math.max(1, (Number(by.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(by.slice(5, 7)) - Number(today.slice(5, 7)))

export function fxGoalsView(ctx: Ctx, userId: string): { goals: Record<string, unknown>[] } {
  const { db } = ctx
  const now = ctx.clock.now()
  const zone = zoneOf(getProfile(db, userId))
  const today = zonedParts(now, zone).date
  const refs = referenceRates(ctx.market, now)
  const inr = currencyInstrument('INR')
  const rows = db.all<FxGoalRow>('SELECT * FROM fx_goals WHERE user_id = ? AND removed_at IS NULL ORDER BY by_date, created_at', userId)
  return {
    goals: rows.map((g) => {
      const c = g.currency
      const target = money(c, g.target_text)
      const held = money(c, account(db, userId, balanceAccount(c)) ? balance(db, userId, balanceAccount(c)) : 0n)
      const leftMinor = target.minor > held.minor ? target.minor - held.minor : 0n
      const left = money(c, leftMinor)
      const months = monthsBetween(today, g.by_date)
      const perMonth = money(c, divRound(leftMinor, BigInt(months), 'ceil'))
      const r = refs.get(c as Exclude<Currency, 'INR'>)
      const inRupees = (a: ReturnType<typeof money>) => {
        if (!r) return null
        try {
          const v = convert(a, r, currencyInstrument(c), inr, { at: now, use: 'display', bound: 'mid', rounding: 'halfExpand' })
          return { text: moneyText(v.to), rate: rateText(r.mid), source: r.source, label: r.label, observedText: whenIn(r.observedAt, zone) }
        } catch { return null }
      }
      const status = leftMinor === 0n ? 'reached' : g.by_date <= today ? 'date-passed' : 'on-the-way'
      return {
        id: g.id, name: g.name, currency: c, currencyName: CURRENCY_NAMES[c], targetText: moneyText(target), by: g.by_date, byText: dateWords(g.by_date),
        heldText: moneyText(held), leftText: moneyText(left), progressPermille: Number(target.minor > 0n ? (held.minor >= target.minor ? 1000n : (held.minor * 1000n) / target.minor) : 0n),
        monthsLeft: months, perMonthText: moneyText(perMonth), leftInRupees: inRupees(left), perMonthInRupees: inRupees(perMonth), status,
        words: `Counted from your ${CURRENCY_NAMES[c]} balance at the paper bank. This goal moves no money: change rupees into ${c} at a quote to put money toward it. In rupees, the figures are estimates at a reference rate, which nobody can trade at.`,
      }
    }),
  }
}
