/**
 * The paper bank's own events: salary arriving, loan instalments leaving, card interest on a carried balance, and
 * savings interest. They happen at their real dates, at the terms on record, and each is posted once (the ledger
 * reference names the month). If the engine was not running on the date, the event is posted when it next runs,
 * with its scheduled time as the effective time and a note that it was recorded late.
 */
import { type Db, instalmentMonths, ist, istInstant, parse } from './core.ts'
import { notice } from './execute.ts'
import { getProfile, type Profile, zoneOf } from './household.ts'
import { zonedInstant, zonedParts } from '../shared/zone.ts'
import { available, balance, post } from './ledger.ts'
import { term } from './registry.ts'
import type { Ctx } from './types.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { mulDiv, parseDec, pow10 } from '../shared/fixed.ts'
import { homeCurrencyOfJson, inHomeCurrency, zoneOfJson } from './home-currency.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

const p2 = (n: number) => String(n).padStart(2, '0')
const entryExists = (db: Db, userId: string, ref: string): boolean => !!db.get('SELECT 1 FROM entries WHERE user_id = ? AND ref = ?', userId, ref)
const rate = (db: Db, id: string, fallback: string): bigint => parseDec(String(term(db, id)?.value.apr ?? fallback), 12)

/** Average end-of-day balance of an account over the IST calendar days [from, to), from the postings. */
export function averageDailyBalance(db: Db, userId: string, code: string, from: number, to: number): bigint {
  const acc = db.get<{ id: string }>('SELECT id FROM accounts WHERE user_id = ? AND code = ?', userId, code)
  if (!acc || to <= from) return 0n
  const opening = fromAmountText(db.get<{ s: string }>('SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id WHERE p.account_id = ? AND e.effective_ts < ?', acc.id, from)?.s, `the opening balance of ${code}`)
  const moves = db.all<{ t: number; amount: string }>('SELECT e.effective_ts t, p.amount_text amount FROM postings p JOIN entries e ON e.id = p.entry_id WHERE p.account_id = ? AND e.effective_ts >= ? AND e.effective_ts < ? ORDER BY e.effective_ts', acc.id, from, to)
  const days = Math.round((to - from) / 86_400_000)
  let bal = opening, i = 0, total = 0n
  for (let d = 0; d < days; d++) {
    const end = from + (d + 1) * 86_400_000
    while (i < moves.length && moves[i]!.t < end) { bal += fromAmountText(moves[i]!.amount, `a posting to ${code}`); i++ }
    total += bal
  }
  return days > 0 ? total / BigInt(days) : 0n
}

function monthEvents(ctx: Ctx, userId: string, profile: Profile, createdAt: number): void {
  const { db } = ctx
  const now = ctx.clock.now()
  // R13: the household's own zone (India Standard Time when none was chosen, which gives what ist() gave)
  const zone = zoneOf(profile)
  const t = zonedParts(now, zone)
  const ym = `${t.y}-${p2(t.m)}`
  const lateNote = (scheduled: number) => (now - scheduled > 10 * 60_000 ? { recordedLate: true, scheduledAt: scheduled, note: 'Recorded late: the engine was not running at the scheduled time.' } : {})

  // Salary, on its day at 09:30. The paper salary always arrives: one the engine missed because it was not running on
  // the day is posted now, recorded late, even when the month has since turned (as instalments are). Without this, a
  // stopped engine across a month's turn would make the reserve count a paper salary as lost (Q-045).
  const prevYm = t.m === 1 ? `${t.y - 1}-12` : `${t.y}-${p2(t.m - 1)}`
  for (const m of [prevYm, ym]) {
    const salaryAt = zonedInstant(`${m}-${p2(profile.incomeDay)}`, '09:30', zone)
    if (profile.income > 0 && now >= salaryAt && createdAt <= salaryAt && !entryExists(db, userId, `salary:${m}`)) {
      post(db, { userId, ts: now, effectiveTs: salaryAt, kind: 'income-salary', ref: `salary:${m}`, memo: 'Salary (paper)', meta: { paper: true, ...lateNote(salaryAt) },
        lines: [{ account: 'bank', amount: BigInt(profile.income) }, { account: 'inc:salary', amount: -BigInt(profile.income) }] })
    }
  }

  // Loan instalments, on their day at 09:00: interest for the month first, the rest reduces what is owed. One that
  // could not be taken stays owed and is taken when the money is there, in a later month too, oldest first. (Until
  // 20 November 2026 an instalment still unpaid at the month's end was dropped, though its notice said otherwise.)
  for (const [code, emi, rateId, fallback, label] of [['loan:personal', profile.personalLoanEmi, 'rate.loan.personal', '0.14', 'Personal loan'], ['loan:home', profile.homeLoanEmi, 'rate.loan.home', '0.0875', 'Home loan']] as const) {
    for (const m of instalmentMonths(ym)) {
      const emiAt = zonedInstant(`${m}-${p2(profile.emiDay)}`, '09:00', zone)
      const ref = `emi:${code}:${m}`
      const owed = balance(db, userId, code)
      if (emi <= 0 || owed <= 0n) break
      if (now < emiAt || createdAt > emiAt || entryExists(db, userId, ref)) continue
      const interest = mulDiv(owed, rate(db, rateId, fallback), pow10(12) * 12n, 'half')
      let principal = BigInt(emi) - interest
      if (principal < 0n) principal = 0n
      if (principal > owed) principal = owed
      const total = principal + interest
      if (available(db, userId, 'bank') < total) {
        notice(db, userId, { level: 'action', kind: 'emi-unpaid', title: `${label} instalment could not be paid`, body: `${homeMoneyExact(total)} was due and your bank account does not have it free. It will be taken when the money is there.`, dedupe: `emi-unpaid:${code}:${m}` }, now)
        break // an older instalment is taken before a newer one
      }
      // one refused on its day for lack of money is taken now and dated now, with that reason: back-dating it to its day
      // showed balances the account never had, and said the engine had not been running (the statement review, R12)
      const refused = !!db.get('SELECT 1 FROM notices WHERE user_id = ? AND dedupe = ?', userId, `emi-unpaid:${code}:${m}`)
      const when = refused ? { effectiveTs: now, late: { takenLate: true, scheduledAt: emiAt, note: 'Taken late: the money was not there on its day.' } } : { effectiveTs: emiAt, late: lateNote(emiAt) }
      post(db, { userId, ts: now, effectiveTs: when.effectiveTs, kind: 'loan-instalment', ref, memo: `${label} instalment (paper)`, meta: { paper: true, principal: principal.toString(), interest: interest.toString(), ...when.late },
        lines: [{ account: code, amount: principal }, { account: 'exp:interest', amount: interest }, { account: 'bank', amount: -total }] })
    }
  }

  // On the 1st: last month's card interest on a carried balance, and last month's savings interest on the average daily balance.
  const monthStart = zonedInstant(`${ym}-01`, '00:10', zone)
  if (now >= monthStart && createdAt < monthStart) {
    const prev = zonedParts(monthStart - 86_400_000, zone)
    const prevYm = `${prev.y}-${p2(prev.m)}`
    const from = Math.max(zonedInstant(`${prevYm}-01`, '00:00', zone), createdAt), to = zonedInstant(`${ym}-01`, '00:00', zone)
    const days = BigInt(Math.max(1, Math.round((to - from) / 86_400_000)))
    if (!entryExists(db, userId, `cardint:${prevYm}`)) {
      const avg = -averageDailyBalance(db, userId, 'card', from, to) // a liability is stored as a credit
      const interest = avg > 0n ? mulDiv(avg * days, rate(db, 'rate.card', '0.43'), pow10(12) * 365n, 'half') : 0n
      if (interest > 0n) post(db, { userId, ts: now, effectiveTs: monthStart, kind: 'card-interest', ref: `cardint:${prevYm}`, memo: `Card interest for ${prevYm} (paper)`, meta: { paper: true, averageOwed: avg.toString(), days: Number(days), termId: 'rate.card' },
        lines: [{ account: 'exp:interest', amount: interest }, { account: 'card', amount: -interest }] })
    }
    if (!entryExists(db, userId, `savint:${prevYm}`)) {
      const avg = averageDailyBalance(db, userId, 'bank', from, to)
      const interest = avg > 0n ? mulDiv(avg * days, rate(db, 'rate.savings', '0.0275'), pow10(12) * 365n, 'half') : 0n
      if (interest > 0n) post(db, { userId, ts: now, effectiveTs: monthStart, kind: 'savings-interest', ref: `savint:${prevYm}`, memo: `Savings interest for ${prevYm} (paper)`, meta: { paper: true, averageBalance: avg.toString(), days: Number(days), termId: 'rate.savings' },
        lines: [{ account: 'bank', amount: interest }, { account: 'inc:interest', amount: -interest }] })
    }
  }
}

/** Post any paper-bank event that has fallen due for any household. Safe to call as often as you like. */
export function bankTick(ctx: Ctx): void {
  const users = ctx.db.all<{ id: string; created_at: number; profile_json: string }>('SELECT id, created_at, profile_json FROM users')
  for (const u of users) {
    if (!parse<{ setup?: boolean }>(u.profile_json, {}).setup) continue
    try { inHomeCurrency(homeCurrencyOfJson(u.profile_json), () => ctx.db.tx(() => monthEvents(ctx, u.id, getProfile(ctx.db, u.id), u.created_at)), zoneOfJson(u.profile_json)) }
    catch (e) { notice(ctx.db, u.id, { level: 'warning', kind: 'bank-event-error', title: 'A scheduled bank event could not be recorded', body: e instanceof Error ? e.message : String(e), dedupe: `bank-event-error:${ist(ctx.clock.now()).date}` }, ctx.clock.now()) }
  }
}
