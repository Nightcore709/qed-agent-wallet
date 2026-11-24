/**
 * A goal's set-aside (R12 task comparison, gap 5): money the household has put aside for a goal, kept in an account of
 * its own inside the same paper bank. It is the ledger's account `goal:<instruction id>`, an asset that may not go below
 * zero. Only two things post to it: a contribution (an internal payment from the bank account, made by the goal's own
 * instruction or by the owner's hand, each checked by policy.ts like any payment) and a release back to the bank account,
 * which needs the owner's confirmed approval of its exact terms (goals.ts). Every instruction's orders and payments draw on
 * the bank account and nothing else, so no instruction can spend money set aside, the goal's own included.
 *
 * Only the ledger is read here, so the execution path, the policy check and the valuation can use it without the rest.
 */
import { type Db } from './core.ts'
import { account, balance, ensureAccount } from './ledger.ts'
import { fromAmountText } from '../shared/amount-text.ts'

/** The paper bank's internal address for set-asides: the paper rail carries it between the household's own accounts. */
export const SETASIDE_HANDLE = 'setaside@paperbank'
export const goalAccount = (goalId: string): string => `goal:${goalId}`

/** Open a goal's set-aside if it is not open yet; a set-aside cannot go below zero. */
export function ensureGoalAccount(db: Db, userId: string, goalId: string, name: string): void {
  // in the currency the household's bank account is kept in (its home currency)
  ensureAccount(db, userId, goalAccount(goalId), 'asset', account(db, userId, 'bank')?.asset_id ?? 'INR', `Set aside for ${name}`.slice(0, 120), true, { goalId })
}

/** What is in a goal's set-aside now, in paise. */
export const setAside = (db: Db, userId: string, goalId: string): number => Number(balance(db, userId, goalAccount(goalId)))

/** Contributions to a goal that have left the bank account and not yet reached its set-aside, in paise. */
export function onItsWay(db: Db, userId: string, goalId: string): number {
  return db.all<{ a: string | null; c: string | null }>(`SELECT json_extract(params_json, '$.amount') a, json_extract(params_json, '$.charge') c FROM actions WHERE user_id = ? AND kind = 'payment' AND json_extract(params_json, '$.purpose') = 'goal' AND json_extract(params_json, '$.goalId') = ? AND state IN ('planned', 'submitting', 'working')`, userId, goalId)
    .reduce((s, r) => s + Number(r.a ?? 0) + Number(r.c ?? 0), 0)
}

/** Every goal's set-aside together, in paise: money the household owns, counted in the worst case and the net position. */
export function allSetAside(db: Db, userId: string): number {
  return db.all<{ t: string }>(`SELECT b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code LIKE 'goal:%'`, userId)
    .reduce((s, r) => s + Number(fromAmountText(r.t, 'a set-aside')), 0)
}
