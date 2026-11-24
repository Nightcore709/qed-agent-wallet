/**
 * A second payment that repeats an earlier one (the mandate omissions audit, finding S4).
 *
 * The person approves each payment separately, so no signature says "this is the same payment twice". The rule, kept here and
 * stated on the sheet the passkey signs, on the held payment's record and on Spend:
 *
 *   A payment from the person to someone else's address is held for the person's confirmation, before it is sent, when
 *   an earlier payment of theirs that has not ended without sending (not failed, cancelled, expired, refused or rejected)
 *     - is for the same bill; or
 *     - is to the same payee and for the same amount, and was asked for within 24 hours of this one.
 *
 * "Earlier" is a total order (when it was asked for, then its id), so of two payments asked for at the same moment exactly one
 * is held, never both and never neither. The payment's money is set aside while it waits (execute.ts). The person confirms it
 * with a fresh passkey confirmation, or cancels it; unconfirmed after 48 hours it is cancelled and nothing is sent. It is
 * checked again under the write lock when the payment starts, so a payment another process asked for meanwhile counts.
 * An instruction's payment is never held (it cannot wait for a person) but does count as an earlier payment.
 * Payments to the person's own accounts at the paper bank are not covered: they are not payments to someone else.
 */
import type { Db } from './core.ts'
import { isThirdParty } from './new-payee.ts'
import type { PaymentParams } from './types.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

/** How close in time two payments to one payee for one amount must be to count as a repeat. */
export const DUPLICATE_WINDOW_MS = 24 * 3600_000
/** How long a held repeat waits for the person before it is cancelled with nothing sent. */
export const DUPLICATE_CONFIRM_BY_MS = 48 * 3600_000
/** A payment that ended without money leaving, or was never approved, does not count as an earlier one. */
const ENDED = `('failed', 'cancelled', 'expired', 'blocked', 'rejected', 'awaiting_approval')`

/** What decides a repeat: who is paid, how much, when it was asked for, and which payment it is. */
export interface PaymentFacts { payee: string; amount: string; at: number; id: string }

/**
 * Whether `later` repeats `earlier`: the same payee and the same amount, `earlier` first in the total order (when it was asked
 * for, then its id), no more than 24 hours before `later`, the edge included. The one rule of domestic payments (repeatOf) and
 * of payments abroad (abroad.ts), so that neither can drift from the other.
 */
export function repeatsEarlier(earlier: PaymentFacts, later: PaymentFacts): boolean {
  const first = earlier.at < later.at || (earlier.at === later.at && earlier.id < later.id)
  return first && earlier.payee === later.payee && earlier.amount === later.amount && later.at - earlier.at <= DUPLICATE_WINDOW_MS
}

export const DUPLICATE_RULE = 'A payment that repeats an earlier one is held for your confirmation before it is sent: the same bill, or the same payee and the same amount within 24 hours. You confirm it with your passkey, or cancel it; if you do neither within 48 hours it is cancelled and nothing is sent.'

export interface Repeat { of: string; reason: 'bill' | 'payee-and-amount'; askedAt: number; amount: string; payeeName: string }

/** Whether a payment is of the kinds the rule covers: a payment to someone else's address, one-off or for a bill. */
export const coveredPayment = (p: Pick<PaymentParams, 'payeeHandle' | 'purpose'>): boolean => isThirdParty(p.payeeHandle) && (p.purpose === 'spend' || p.purpose === 'bill')

/**
 * The earlier payment this one repeats, or null. `self` is the payment being decided (excluded, and the reference point of
 * "earlier"); a payment not yet asked for passes its time and an empty id, which sorts before every id.
 */
export function repeatOf(db: Db, userId: string, p: Pick<PaymentParams, 'payeeHandle' | 'amount' | 'purpose' | 'billId'>, self: { id: string; createdAt: number }): Repeat | null {
  if (!coveredPayment(p)) return null
  const rows = db.all<{ id: string; created_at: number; params_json: string }>(
    `SELECT id, created_at, params_json FROM actions WHERE user_id = ? AND kind = 'payment' AND state NOT IN ${ENDED} AND id <> ?
       AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC LIMIT 500`, userId, self.id, self.createdAt, self.createdAt, self.id || '￿')
  for (const r of rows) {
    const q = JSON.parse(r.params_json) as PaymentParams
    const sameBill = !!p.billId && q.billId === p.billId
    const sameAmount = repeatsEarlier({ payee: q.payeeHandle, amount: q.amount, at: r.created_at, id: r.id }, { payee: p.payeeHandle, amount: p.amount, at: self.createdAt, id: self.id || '\uffff' })
    if (sameBill || sameAmount) return { of: r.id, reason: sameBill ? 'bill' : 'payee-and-amount', askedAt: r.created_at, amount: q.amount, payeeName: q.payeeName }
  }
  return null
}

const rupees = (paise: string): string => homeMoneyExact(Number(paise)).replace(/\.00$/, '')
/** The reason in a sentence, for the sheet, the check and the record. */
export function repeatWords(r: Repeat, name: string, when: string): string {
  return r.reason === 'bill'
    ? `This pays a bill that an earlier payment of yours (${when}) already pays. ${DUPLICATE_RULE}`
    : `You already sent ${rupees(r.amount)} to ${name} (${when}), and this is the same payee and the same amount within 24 hours. ${DUPLICATE_RULE}`
}
