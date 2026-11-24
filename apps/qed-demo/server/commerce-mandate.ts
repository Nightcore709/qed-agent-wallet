/**
 * The commerce mandate (R13, S2): what the owner signed QED may buy from simulated paywalled services, and the check of
 * one purchase against it. A leaf module (it reads the database and nothing else of the server), so that the engine's
 * policy (policy.ts) and the purchase flow (commerce.ts) apply the same rules from the same records: what a service's
 * quote says, or what Ask says, never decides. The limits are in paise. Everything here is on the paper rail and the
 * services are simulated.
 */
import { type Db, parse } from './core.ts'
import { monthStart } from './liquidity.ts'
import { homeMoneyMinor } from '../shared/home-money.ts'

export interface Mandate { id: string; version: number; perPurchase: number; perMonth: number; services: string[]; expiresAt: number; approvalId: string; docHash: string; state: string; createdAt: number }

const rowOf = (r: Record<string, unknown>): Mandate => ({ id: String(r.id), version: Number(r.version), perPurchase: Number(r.per_purchase), perMonth: Number(r.per_month), services: parse<string[]>(r.services_json, []), expiresAt: Number(r.expires_at), approvalId: String(r.approval_id), docHash: String(r.doc_hash), state: String(r.state), createdAt: Number(r.created_at) })

/** The mandate in force for a household, or null: none signed, replaced or revoked ones do not count, and one past its end does not either. */
export function activeMandate(db: Db, userId: string, now: number): Mandate | null {
  const r = db.get<Record<string, unknown>>(`SELECT * FROM commerce_mandates WHERE user_id = ? AND state = 'active' ORDER BY version DESC LIMIT 1`, userId)
  const m = r ? rowOf(r) : null
  return m && m.expiresAt > now ? m : null
}
export function mandateHistory(db: Db, userId: string): Mandate[] {
  return db.all<Record<string, unknown>>('SELECT * FROM commerce_mandates WHERE user_id = ? ORDER BY version DESC', userId).map(rowOf)
}

/** Paise bought, or being paid for, in the calendar month (India time) of `now`. A refused or failed purchase counts for nothing. */
export function monthSpent(db: Db, userId: string, now: number, exceptPurchaseId = ''): number {
  // summed here, not in SQL: the amounts are small whole paise, and no SQL sum over an amount is allowed (amount-sql.ts)
  return db.all<{ amount: number }>(`SELECT amount FROM commerce_purchases WHERE user_id = ? AND state IN ('paying', 'paid', 'undelivered') AND created_at >= ? AND id <> ?`, userId, monthStart(now), exceptPurchaseId).reduce((t, r) => t + r.amount, 0)
}

export interface MandateCheck { name: string; ok: boolean; detail: string }
export interface MandateVerdict { ok: boolean; reason: string | null; checks: MandateCheck[]; mandateId: string | null }

/**
 * One purchase against the mandate in force: a signed mandate exists, the service is one it names, the amount is within
 * the limit for one purchase and within what is left of the month's. `quotedPayTo` must be the address QED holds for the
 * service: a quote that names another address is refused, whatever it says its price is.
 */
export function mandateVerdict(db: Db, userId: string, req: { serviceId: string; amount: number; quotedPayTo: string; knownPayTo: string | null }, now: number, exceptPurchaseId = ''): MandateVerdict {
  const checks: MandateCheck[] = []
  const add = (name: string, ok: boolean, detail: string): boolean => { checks.push({ name, ok, detail }); return ok }
  const m = activeMandate(db, userId, now)
  if (!add('mandate-signed', !!m, m ? `Mandate version ${m.version} is in force: signed with your passkey, up to ${homeMoneyMinor(m.perPurchase)} for one purchase and ${homeMoneyMinor(m.perMonth)} a month.` : 'No commerce mandate is in force. QED buys nothing until you sign one: a limit for each purchase, a limit for each month and the services allowed.')) return fail(checks, null)
  add('service-allowed', m!.services.includes(req.serviceId), m!.services.includes(req.serviceId) ? `${req.serviceId} is one of the services the mandate names.` : `${req.serviceId} is not one of the services the mandate names (${m!.services.join(', ') || 'none'}). Sign a new mandate to add it.`)
  add('pays-the-known-address', req.knownPayTo !== null && req.quotedPayTo === req.knownPayTo, req.knownPayTo !== null && req.quotedPayTo === req.knownPayTo ? `The quote asks for payment to ${req.quotedPayTo}, the address QED holds for this service.` : `The quote asks for payment to ${req.quotedPayTo}, which is not the address QED holds for this service${req.knownPayTo ? ` (${req.knownPayTo})` : ''}. It was not paid.`)
  add('price-is-sane', Number.isSafeInteger(req.amount) && req.amount > 0, Number.isSafeInteger(req.amount) && req.amount > 0 ? `The quote is for ${homeMoneyMinor(req.amount)}.` : 'The quote does not carry a usable price.')
  if (Number.isSafeInteger(req.amount) && req.amount > 0) {
    add('within-purchase-limit', req.amount <= m!.perPurchase, req.amount <= m!.perPurchase ? `${homeMoneyMinor(req.amount)} is within ${homeMoneyMinor(m!.perPurchase)} for one purchase.` : `${homeMoneyMinor(req.amount)} is over the ${homeMoneyMinor(m!.perPurchase)} the mandate allows for one purchase.`)
    const spent = monthSpent(db, userId, now, exceptPurchaseId)
    add('within-month-limit', spent + req.amount <= m!.perMonth, spent + req.amount <= m!.perMonth ? `${homeMoneyMinor(spent)} bought this month plus ${homeMoneyMinor(req.amount)} is within ${homeMoneyMinor(m!.perMonth)} a month.` : `${homeMoneyMinor(spent)} is already bought this month; ${homeMoneyMinor(req.amount)} more would pass the ${homeMoneyMinor(m!.perMonth)} the mandate allows for a month.`)
  }
  return fail(checks, m!.id)
}
function fail(checks: MandateCheck[], mandateId: string | null): MandateVerdict {
  const bad = checks.filter((c) => !c.ok)
  return { ok: bad.length === 0, reason: bad.length ? bad.map((c) => c.detail).join(' ') : null, checks, mandateId }
}
