/**
 * Agent commerce (R13, S2): QED compares the quotes of two simulated paywalled services and buys from one within a mandate
 * the owner signed with the passkey: a limit for each purchase, a limit for each month and the services allowed.
 *
 * The flow, each step on the record:
 *   1. the mandate is prepared as an exact document and signed with the passkey (prepareMandate, activateMandate);
 *   2. QED asks both services for a quote (HTTP 402, in the style of the x402 pattern; commerce-sim.ts) and compares them;
 *   3. the quote chosen is checked against the mandate (commerce-mandate.ts), and the purchase is kept whatever the verdict,
 *      with the reason when it is refused;
 *   4. a payment on the paper rail is made through the same engine and policy as any payment (origin 'commerce'; policy.ts
 *      reads the mandate again from the records); no real money moves;
 *   5. the service is asked again with the payment's reference, and the receipt it returns is kept.
 * Neither a model nor a quote's own words can widen the mandate. Test doubles and paper money throughout.
 */
import { PAUSE_REASON, pausedFor } from './dispute-pause.ts'
import { AppError, audit, bad, type Db, j, newId, parse } from './core.ts'
import { consumeApproval, createApproval, getApproval } from './approvals.ts'
import { type Mandate, activeMandate, mandateHistory, mandateVerdict, monthSpent } from './commerce-mandate.ts'
import { NETWORK, PRODUCTS, type SimService, simServices, type X402Quote } from './commerce-sim.ts'
import { createAction, getAction, stepAction } from './execute.ts'
import { homeMoneyMinor } from '../shared/home-money.ts'
import { canonical, sha256 } from '../shared/sha256.ts'
import { type ActionRow, type Ctx, type PaymentParams, TERMINAL_ACTION } from './types.ts'

export const MAX_PER_PURCHASE = 1_000_000
export const MAX_PER_MONTH = 5_000_000
export const MAX_MANDATE_DAYS = 90
const DAY_MS = 86_400_000
const FETCH_MS = 4000
/** How long a purchase waits for the paper rail to settle before it is left 'paying' (reconcilePurchases finishes it). */
const PAY_WAIT_MS = 20_000

// ------------------------------------------------------------------------------------------------ the mandate

export interface MandateTerms { perPurchase: number; perMonth: number; services: string[]; days: number }
/** The mandate the owner asked for, checked. Amounts are whole paise; the services must be ones QED knows. */
export function parseMandate(raw: unknown): MandateTerms {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const fields: Record<string, string> = {}
  const paise = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
  const perPurchase = paise(r.perPurchase), perMonth = paise(r.perMonth)
  if (perPurchase === null || perPurchase < 100) fields.perPurchase = 'Enter the most for one purchase, at least ₹1.'
  else if (perPurchase > MAX_PER_PURCHASE) fields.perPurchase = `One purchase may be at most ${homeMoneyMinor(MAX_PER_PURCHASE)} on a mandate.`
  if (perMonth === null || perMonth < 100) fields.perMonth = 'Enter the most for one month, at least ₹1.'
  else if (perMonth > MAX_PER_MONTH) fields.perMonth = `A month may be at most ${homeMoneyMinor(MAX_PER_MONTH)} on a mandate.`
  else if (perPurchase !== null && perPurchase > perMonth) fields.perMonth = 'The limit for a month cannot be less than the limit for one purchase.'
  const known = new Set((simServices()?.services ?? []).map((s) => s.id))
  const services = Array.isArray(r.services) ? [...new Set(r.services.filter((x): x is string => typeof x === 'string'))] : []
  if (!services.length) fields.services = 'Choose at least one service.'
  else if (services.some((s) => !known.has(s))) fields.services = 'Choose from the services listed.'
  const days = r.days === undefined ? 30 : r.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_MANDATE_DAYS) fields.days = `Choose how long it lasts, from 1 to ${MAX_MANDATE_DAYS} days.`
  if (Object.keys(fields).length) throw bad('Some values need attention.', fields)
  return { perPurchase: perPurchase!, perMonth: perMonth!, services: services.sort(), days: days as number }
}

/** The exact terms, as a document the passkey signs. */
export function prepareMandate(ctx: Ctx, userId: string, raw: unknown): { approvalId: string; document: string; docHash: string; expiresAt: number; requiresStepUp: boolean; terms: MandateTerms } {
  const now = ctx.clock.now()
  const t = parseMandate(raw)
  const names = (simServices()?.services ?? []).filter((s) => t.services.includes(s.id)).map((s) => `${s.name} (${s.payTo})`)
  const doc = canonical({
    v: 1, kind: 'commerce-mandate', terms: t, economicId: newId('cmd', now),
    what: `Let QED buy from ${names.join(' and ')}, up to ${homeMoneyMinor(t.perPurchase)} for one purchase and ${homeMoneyMinor(t.perMonth)} in a calendar month, for ${t.days} days`,
    note: 'Signing lets QED buy only from the services named, only within these limits, and only on the paper rail: no real money moves, and the services are simulated test doubles. Every purchase is checked against this mandate again when it is paid. You can revoke it at any time, and a new mandate replaces this one.',
  })
  const a = createApproval(ctx.db, userId, { purpose: 'commerce-mandate', subject: `commerce-mandate:${(JSON.parse(doc) as { economicId: string }).economicId}`, document: doc, requiresStepUp: false, sizePaise: t.perMonth }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, requiresStepUp: false, terms: t }
}

/** Put the mandate in force from a confirmed approval: the terms come from the approved document, not from the request. */
export function activateMandate(ctx: Ctx, userId: string, approvalId: string): Mandate {
  const now = ctx.clock.now()
  const a = getApproval(ctx.db, userId, approvalId)
  if (!a || a.purpose !== 'commerce-mandate') throw new AppError(404, 'not_found', 'That approval was not found.')
  const doc = parse<{ terms?: MandateTerms; economicId?: string }>(a.document, {})
  if (!doc.terms || !doc.economicId) throw new AppError(500, 'approval_corrupt', 'The stored document is not a commerce mandate. Nothing was done.')
  // the document is read again through the same checks: a changed row cannot carry a limit the checks would refuse
  const t = parseMandate(doc.terms)
  return ctx.db.tx(() => {
    consumeApproval(ctx.db, userId, approvalId, `commerce-mandate:${doc.economicId}`, a.doc_hash, now)
    const version = (ctx.db.get<{ v: number | null }>('SELECT MAX(version) v FROM commerce_mandates WHERE user_id = ?', userId)?.v ?? 0) + 1
    ctx.db.run(`UPDATE commerce_mandates SET state = 'replaced', ended_at = ? WHERE user_id = ? AND state = 'active'`, now, userId)
    const id = newId('cmn', now)
    ctx.db.run(`INSERT INTO commerce_mandates (id, user_id, version, per_purchase, per_month, services_json, expires_at, approval_id, doc_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      id, userId, version, t.perPurchase, t.perMonth, j(t.services), now + t.days * DAY_MS, approvalId, a.doc_hash, now)
    audit(ctx.db, now, userId, 'owner', 'commerce.mandate', id, { version, perPurchase: t.perPurchase, perMonth: t.perMonth, services: t.services, approvalId })
    return activeMandate(ctx.db, userId, now)!
  })
}

/** Revoking a mandate only ever narrows what QED may do, so it needs no passkey. */
export function revokeMandate(ctx: Ctx, userId: string): { revoked: boolean } {
  const now = ctx.clock.now()
  const r = ctx.db.run(`UPDATE commerce_mandates SET state = 'revoked', ended_at = ? WHERE user_id = ? AND state = 'active'`, now, userId)
  if (r.changes) audit(ctx.db, now, userId, 'owner', 'commerce.revoke', userId, {})
  return { revoked: r.changes > 0 }
}

// ------------------------------------------------------------------------------------------------ quotes

export interface QuoteView { serviceId: string; serviceName: string; ok: boolean; error: string | null; amount: number | null; payTo: string | null; quoteId: string | null; expiresAt: number | null; allowed: boolean; resource: string; network: string | null }

/** Ask one service for a quote: its 402 reply, read strictly. Anything else is an unusable quote with the reason. */
async function askForQuote(s: SimService, sku: string): Promise<{ quote: QuoteView; raw: unknown }> {
  const resource = `${s.url}/resource/${sku}`
  const none = (error: string, raw: unknown = null): { quote: QuoteView; raw: unknown } => ({ quote: { serviceId: s.id, serviceName: s.name, ok: false, error, amount: null, payTo: null, quoteId: null, expiresAt: null, allowed: false, resource, network: null }, raw })
  let res: Response
  try { res = await fetch(resource, { signal: AbortSignal.timeout(FETCH_MS), redirect: 'error' }) } catch (e) { return none(`The service did not answer: ${e instanceof Error ? e.message : 'no reply'}.`) }
  if (res.status !== 402) return none(`The service answered ${res.status}, not 402 with a quote.`)
  let q: X402Quote
  try { q = await res.json() as X402Quote } catch { return none('The service sent a quote that could not be read.') }
  const a = q?.accepts?.[0]
  const amount = a && /^\d{1,12}$/.test(String(a.maxAmountRequired)) ? Number(a.maxAmountRequired) : NaN
  if (!a || q.x402Version !== 1 || a.scheme !== 'exact' || a.network !== NETWORK || !Number.isSafeInteger(amount) || amount <= 0 || typeof a.payTo !== 'string' || typeof a.extra?.quoteId !== 'string' || a.resource !== resource) return none('The quote is not in the shape QED accepts (scheme exact, the paper rail, a whole price in paise, the same resource).', q)
  return { quote: { serviceId: s.id, serviceName: s.name, ok: true, error: null, amount, payTo: a.payTo, quoteId: a.extra.quoteId, expiresAt: Number(a.extra.expiresAt), allowed: false, resource, network: a.network }, raw: q }
}

/** The quotes of both services for one product, cheapest first, each marked with whether the mandate allows that service. */
export async function compareQuotes(ctx: Ctx, userId: string, sku: string): Promise<{ sku: string; title: string; quotes: QuoteView[]; cheapest: string | null; cheapestAllowed: string | null; raw: unknown[] }> {
  const product = PRODUCTS.find((p) => p.sku === sku)
  if (!product) throw bad('Choose a product from the list.', { sku: 'Choose a product from the list.' })
  const sim = simServices()
  if (!sim) throw new AppError(503, 'no_services', 'The simulated services are not running on this stack.')
  const got = await Promise.all(sim.services.map((s) => askForQuote(s, sku)))
  const m = activeMandate(ctx.db, userId, ctx.clock.now())
  const quotes = got.map((g) => ({ ...g.quote, allowed: !!m && m.services.includes(g.quote.serviceId) })).sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity))
  const usable = quotes.filter((q) => q.ok)
  return { sku, title: product.title, quotes, cheapest: usable[0]?.serviceId ?? null, cheapestAllowed: usable.find((q) => q.allowed)?.serviceId ?? null, raw: got.map((g) => g.raw) }
}

// ------------------------------------------------------------------------------------------------ buying

export interface PurchaseView { id: string; sku: string; title: string; serviceId: string | null; serviceName: string | null; amount: number | null; state: string; reason: string | null; checks: { name: string; ok: boolean; detail: string }[]; quotes: QuoteView[]; actionId: string | null; receipt: Record<string, unknown> | null; createdAt: number }

const viewOf = (r: Record<string, unknown>): PurchaseView => {
  const q = parse<{ quotes?: QuoteView[]; checks?: PurchaseView['checks'] }>(r.quotes_json, {})
  return { id: String(r.id), sku: String(r.sku), title: PRODUCTS.find((p) => p.sku === r.sku)?.title ?? String(r.sku), serviceId: (r.service_id as string | null) ?? null, serviceName: (r.service_name as string | null) ?? null, amount: r.amount === null ? null : Number(r.amount), state: String(r.state), reason: (r.reason as string | null) ?? null, checks: q.checks ?? [], quotes: q.quotes ?? [], actionId: (r.action_id as string | null) ?? null, receipt: parse<Record<string, unknown> | null>(r.receipt_json, null), createdAt: Number(r.created_at) }
}
export const purchaseView = (db: Db, userId: string, id: string): PurchaseView | null => { const r = db.get<Record<string, unknown>>('SELECT * FROM commerce_purchases WHERE id = ? AND user_id = ?', id, userId); return r ? viewOf(r) : null }
export const listPurchases = (db: Db, userId: string, limit = 40): PurchaseView[] => db.all<Record<string, unknown>>('SELECT * FROM commerce_purchases WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit).map(viewOf)

export function commerceState(ctx: Ctx, userId: string): { mandate: Mandate | null; history: Mandate[]; spentThisMonth: number; services: { id: string; name: string; payTo: string }[]; products: typeof PRODUCTS; purchases: PurchaseView[]; simulated: true; note: string } {
  const now = ctx.clock.now()
  const m = activeMandate(ctx.db, userId, now)
  return {
    mandate: m, history: mandateHistory(ctx.db, userId), spentThisMonth: monthSpent(ctx.db, userId, now),
    services: (simServices()?.services ?? []).map((s) => ({ id: s.id, name: s.name, payTo: s.payTo })), products: PRODUCTS, purchases: listPurchases(ctx.db, userId), simulated: true,
    note: 'Both services are simulated test doubles started by this QED stack, and every payment is on the paper rail: no real money moves. Their quotes follow the shape of the x402 pattern (HTTP 402); no compatibility with an x402 client or facilitator is claimed or tested.',
  }
}

/** A request key: 8 to 100 characters of letters, digits and - _ . : ; anything else is refused rather than trimmed. */
export function idempotencyKey(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(v)) throw bad('The request key is not valid.', { idempotencyKey: 'Use 8 to 100 letters, digits, - _ . or :.' })
  return v
}
const keyedId = (userId: string, key: string): string => `cpu_k${sha256(`${userId}\n${key}`).slice(0, 26)}`

/**
 * Buy one product. With no `serviceId`, QED buys from the cheapest service the mandate allows; with one, from that service
 * (and refuses if the mandate does not name it). The purchase is kept whatever happens, with the quotes compared, the checks
 * made and, when it is refused, the reason in the words the owner reads.
 */
export async function purchase(ctx: Ctx, userId: string, raw: { sku?: unknown; serviceId?: unknown; idempotencyKey?: unknown }, opts: { waitMs?: number; pump?: () => Promise<void> } = {}): Promise<PurchaseView> {
  const sku = typeof raw.sku === 'string' ? raw.sku : ''
  const wanted = typeof raw.serviceId === 'string' && raw.serviceId ? raw.serviceId : null
  const key = idempotencyKey(raw.idempotencyKey)
  // A request that carries a key is made once: the purchase's id comes from the key, so a second request with it (a double
  // click, a retry after a dropped connection) finds the first and returns it, whatever state it has reached.
  const id = key ? keyedId(userId, key) : newId('cpu', ctx.clock.now())
  const earlier = (): PurchaseView | null => {
    if (key) {
      const row = ctx.db.get<{ sku: string; service_id: string | null }>('SELECT sku, service_id FROM commerce_purchases WHERE id = ? AND user_id = ?', id, userId)
      if (!row) return null
      if (row.sku !== sku) throw new AppError(409, 'idempotency_conflict', 'That request key was used for a different purchase. Start again from the page.')
      return purchaseView(ctx.db, userId, id)
    }
    // No key: a purchase of the same product from the same service that is still being paid for is that one, not another.
    const open = ctx.db.get<{ id: string }>(`SELECT id FROM commerce_purchases WHERE user_id = ? AND sku = ? AND state = 'paying' AND COALESCE(service_id, '') = COALESCE(?, COALESCE(service_id, '')) AND created_at > ? ORDER BY created_at DESC LIMIT 1`, userId, sku, wanted, ctx.clock.now() - PAY_WAIT_MS)
    return open ? purchaseView(ctx.db, userId, open.id) : null
  }
  const first = earlier()
  if (first) return first
  const cmp = await compareQuotes(ctx, userId, sku)
  // read again after the wait for the services: from here to the first write nothing is awaited, so a twin that got in first is found
  const twin = earlier()
  if (twin) return twin
  const now = ctx.clock.now()
  const pick = wanted ? cmp.quotes.find((q) => q.serviceId === wanted) : cmp.quotes.find((q) => q.ok && q.allowed) ?? cmp.quotes.find((q) => q.ok)
  const keep = (state: string, reason: string | null, extra: { serviceId?: string | null; serviceName?: string | null; amount?: number | null; mandateId?: string | null; checks?: unknown[] } = {}): void => {
    ctx.db.run('INSERT INTO commerce_purchases (id, user_id, mandate_id, sku, service_id, service_name, amount, state, reason, quotes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, extra.mandateId ?? null, sku, extra.serviceId ?? null, extra.serviceName ?? null, extra.amount ?? null, state, reason, j({ quotes: cmp.quotes, checks: extra.checks ?? [] }), now, now)
  }
  if (!pick) { keep('refused', 'No service was named, or the one named is not one QED knows.'); audit(ctx.db, now, userId, 'qed', 'commerce.refused', id, { sku, reason: 'no such service' }); return purchaseView(ctx.db, userId, id)! }
  if (!pick.ok) { keep('refused', `${pick.serviceName} gave no usable quote: ${pick.error}`, { serviceId: pick.serviceId, serviceName: pick.serviceName }); audit(ctx.db, now, userId, 'qed', 'commerce.refused', id, { sku, serviceId: pick.serviceId, reason: pick.error }); return purchaseView(ctx.db, userId, id)! }
  const known = simServices()?.services.find((s) => s.id === pick.serviceId)?.payTo ?? null
  const v = mandateVerdict(ctx.db, userId, { serviceId: pick.serviceId, amount: pick.amount!, quotedPayTo: pick.payTo!, knownPayTo: known }, now)
  if (!v.ok) {
    keep('refused', v.reason, { serviceId: pick.serviceId, serviceName: pick.serviceName, amount: pick.amount, mandateId: v.mandateId, checks: v.checks })
    audit(ctx.db, now, userId, 'qed', 'commerce.refused', id, { sku, serviceId: pick.serviceId, amount: pick.amount, reason: v.reason })
    return purchaseView(ctx.db, userId, id)!
  }
  // A reported problem on the rail holds QED's own payments there (dispute-pause.ts)
  if (pausedFor(ctx.db, userId, 'paper-rail')) {
    keep('refused', PAUSE_REASON, { serviceId: pick.serviceId, serviceName: pick.serviceName, amount: pick.amount, mandateId: v.mandateId, checks: v.checks })
    audit(ctx.db, now, userId, 'qed', 'commerce.refused', id, { sku, serviceId: pick.serviceId, amount: pick.amount, reason: PAUSE_REASON })
    return purchaseView(ctx.db, userId, id)!
  }
  // The purchase is on record as being paid for before any payment is made, so the month's limit counts it and the policy finds it.
  keep('paying', null, { serviceId: pick.serviceId, serviceName: pick.serviceName, amount: pick.amount, mandateId: v.mandateId, checks: v.checks })
  const params: PaymentParams = { payeeHandle: pick.payTo!, payeeName: pick.serviceName, amount: String(pick.amount), purpose: 'spend', memo: `Simulated purchase: ${cmp.title}`, commerce: { purchaseId: id, serviceId: pick.serviceId, sku } }
  let act = ctx.db.tx(() => {
    const a = createAction(ctx, { userId, origin: 'commerce', kind: 'payment', venue: 'paper-rail', economicId: `commerce:${id}`, params })
    ctx.db.run('UPDATE commerce_purchases SET action_id = ? WHERE id = ?', a.id, id)
    audit(ctx.db, now, userId, 'qed', 'commerce.buy', id, { sku, serviceId: pick.serviceId, amount: pick.amount, mandateId: v.mandateId, actionId: a.id })
    return a
  })
  const end = (state: string, reason: string): PurchaseView => {
    ctx.db.run(`UPDATE commerce_purchases SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = 'paying'`, state, reason, ctx.clock.now(), id)
    return purchaseView(ctx.db, userId, id)!
  }
  try { act = await stepAction(ctx, act.id) } catch (e) { return end('failed', `The payment could not be completed: ${e instanceof Error ? e.message : 'an error'}.`) }
  // The paper rail settles on the engine's clock, in its own process: wait for it, bounded, rather than act on a half-made payment.
  const until = Date.now() + (opts.waitMs ?? PAY_WAIT_MS)
  while (!TERMINAL_ACTION.has(act.state) && Date.now() < until) {
    if (opts.pump) await opts.pump()
    else await new Promise((r) => setTimeout(r, 250))
    act = getAction(ctx.db, act.id) ?? act
  }
  return afterPayment(ctx, userId, id, act)
}

/** What a payment's ending means for its purchase: refused or failed is recorded as it ended; done means the goods are asked for. */
async function afterPayment(ctx: Ctx, userId: string, id: string, act: ActionRow): Promise<PurchaseView> {
  const end = (state: string, reason: string | null, receipt: unknown = null): PurchaseView => {
    // only a purchase still being paid for moves on: one that has ended is never rewritten by a second pass over it
    ctx.db.run(`UPDATE commerce_purchases SET state = ?, reason = ?, receipt_json = ?, updated_at = ? WHERE id = ? AND state = 'paying'`, state, reason, receipt === null ? null : j(receipt), ctx.clock.now(), id)
    return purchaseView(ctx.db, userId, id)!
  }
  if (!TERMINAL_ACTION.has(act.state)) return end('paying', `The payment is still going through on the paper rail (${act.state}). It counts against this month's limit until it ends, and the goods are asked for when it has settled.`)
  if (act.state !== 'done') {
    const failing = (act.policy.checks ?? []).filter((c) => !c.ok).map((c) => c.detail)
    return end('failed', `The payment was not made (${act.state}): ${failing.join(' ') || act.error || 'the engine refused it'}`)
  }
  return deliver(ctx, userId, id, act)
}

/** A payment has settled: ask the service for the goods with its reference, and keep what comes back. A reference is good for one delivery. */
const delivering = new Set<string>()
async function deliver(ctx: Ctx, userId: string, id: string, act: ActionRow): Promise<PurchaseView> {
  // The request that made the purchase and the engine's pass over stalled ones can meet here: the goods are asked for once.
  if (delivering.has(id)) return purchaseView(ctx.db, userId, id)!
  delivering.add(id)
  try { return await deliverOnce(ctx, userId, id, act) } finally { delivering.delete(id) }
}
async function deliverOnce(ctx: Ctx, userId: string, id: string, act: ActionRow): Promise<PurchaseView> {
  const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM commerce_purchases WHERE id = ? AND user_id = ?', id, userId)!
  const end = (state: string, reason: string | null, receipt: unknown = null): PurchaseView => {
    // only a purchase still being paid for moves on: one that has ended is never rewritten by a second pass over it
    ctx.db.run(`UPDATE commerce_purchases SET state = ?, reason = ?, receipt_json = ?, updated_at = ? WHERE id = ? AND state = 'paying'`, state, reason, receipt === null ? null : j(receipt), ctx.clock.now(), id)
    return purchaseView(ctx.db, userId, id)!
  }
  const svc = simServices()?.services.find((s) => s.id === row.service_id)
  const amount = Number(row.amount), title = PRODUCTS.find((p) => p.sku === row.sku)?.title ?? String(row.sku)
  if (!svc) return end('undelivered', `Paid on the paper rail (${act.id}), but the service is not running now.`)
  const { quote } = await askForQuote(svc, String(row.sku))
  if (!quote.ok || quote.amount !== amount || quote.payTo !== svc.payTo) return end('undelivered', `Paid on the paper rail (${act.id}), but the service's quote is now ${quote.ok ? `${homeMoneyMinor(quote.amount!)}, not the ${homeMoneyMinor(amount)} paid` : 'unusable'}. Nothing is recovered automatically: raise it as a dispute from the payment's record.`)
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: NETWORK, quoteId: quote.quoteId, paymentRef: act.id, amount, payTo: svc.payTo })).toString('base64')
  try {
    const res = await fetch(quote.resource, { headers: { 'x-payment': header }, signal: AbortSignal.timeout(FETCH_MS), redirect: 'error' })
    if (res.status !== 200) return end('undelivered', `Paid on the paper rail (${act.id}), but the service answered ${res.status}, not the goods. Nothing is recovered automatically: raise it as a dispute from the payment's record.`)
    const goods = await res.json() as { title?: string; content?: string }
    const settle = res.headers.get('x-payment-response')
    return end('paid', null, { simulated: true, service: svc.name, title: goods.title ?? title, excerpt: String(goods.content ?? '').slice(0, 240), paymentRef: act.id, amount, payTo: svc.payTo, network: NETWORK, serviceReceipt: settle ? parse(Buffer.from(settle, 'base64').toString('utf8'), null) : null, contentHash: sha256(String(goods.content ?? '')) })
  } catch (e) { return end('undelivered', `Paid on the paper rail (${act.id}), but the service did not answer: ${e instanceof Error ? e.message : 'no reply'}.`) }
}

/** Purchases whose payment was still going through when they were made: settled ones are delivered, failed ones recorded. Idempotent. */
export async function reconcilePurchases(ctx: Ctx, userId: string): Promise<number> {
  let n = 0
  for (const r of ctx.db.all<{ id: string; action_id: string | null }>(`SELECT id, action_id FROM commerce_purchases WHERE user_id = ? AND state = 'paying' AND action_id IS NOT NULL`, userId)) {
    const act = getAction(ctx.db, r.action_id!)
    // Paid but the services are not running in this process: leave it 'paying' (the month's limit still counts it) rather than
    // record the goods as undelivered; the next pass, with the services up, delivers.
    if (act && act.state === 'done' && !simServices()) continue
    if (act && TERMINAL_ACTION.has(act.state)) { await afterPayment(ctx, userId, r.id, act); n++ }
  }
  return n
}

/** Every household's purchases left 'paying': what the engine runs on its own clock, so that a payment that settled after the request ended is finished. */
export async function reconcileAllPurchases(ctx: Ctx): Promise<number> {
  let n = 0
  for (const u of ctx.db.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM commerce_purchases WHERE state = 'paying' AND action_id IS NOT NULL`)) n += await reconcilePurchases(ctx, u.user_id)
  return n
}

/** Whether a paper-rail payment to a service's address for exactly that amount has settled: what a service asks QED before it delivers. */
export function settledPayment(db: Db): (ref: string, amountPaise: number, payTo: string) => boolean {
  return (ref, amount, payTo) => {
    const a = db.get<{ state: string; origin: string; params_json: string }>('SELECT state, origin, params_json FROM actions WHERE id = ?', ref)
    if (!a || a.state !== 'done' || a.origin !== 'commerce') return false
    const p = parse<PaymentParams>(a.params_json, {} as PaymentParams)
    return p.payeeHandle === payTo && Number(p.amount) === amount
  }
}
