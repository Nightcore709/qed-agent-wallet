/**
 * Agent commerce (R13, S2): two simulated paywalled services answer HTTP 402 with a priced quote; QED compares the quotes
 * and buys one within a mandate the owner signs with the passkey (a limit for a purchase, a limit for a month, the services
 * allowed), on the paper rail. A request outside the mandate is refused with the reason, and the engine's policy reads the
 * mandate again, so a purchase that bypassed the flow is refused too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateMandate, commerceState, compareQuotes, parseMandate, prepareMandate, purchase, reconcileAllPurchases, reconcilePurchases, revokeMandate, settledPayment } from './commerce.ts'
import { activeMandate, mandateVerdict } from './commerce-mandate.ts'
import { OFFERS, setSimServices, simServices, type SimServices, startSimServices } from './commerce-sim.ts'
import { createAction, stepAction, stepAllActions } from './execute.ts'
import { available, balance } from './ledger.ts'
import { DEFAULT_OPENING } from './household.ts'
import { sha256hex } from './receipts.ts'
import { makeKit, type Kit } from './testkit.ts'
import type { PaymentParams } from './types.ts'

let sim: SimServices
/** Every household a test makes: the services ask whichever one holds the payment, as one QED would ask its own database. */
const kits: Kit[] = []
const kitOf = (o?: Parameters<typeof makeKit>[0]): Kit => { const x = makeKit(o); kits.push(x); return x }
beforeAll(async () => { sim = await startSimServices((ref, amount, payTo) => kits.some((x) => settledPayment(x.db)(ref, amount, payTo))); setSimServices(sim) })
afterAll(async () => { setSimServices(null); await sim.close() })

function sign(kit: Kit, terms: Record<string, unknown>): void {
  const p = prepareMandate(kit.ctx, kit.userId, terms)
  confirmApproval(kit.db, kit.userId, p.approvalId, { method: 'passkey', docHash: sha256hex(p.document) }, kit.clock.now())
  activateMandate(kit.ctx, kit.userId, p.approvalId)
}
/** A purchase with the paper rail and the engine's step run beside it, as the engine process does in service. */
const buy = (kit: Kit, raw: { sku?: unknown; serviceId?: unknown; idempotencyKey?: unknown }) => purchase(kit.ctx, kit.userId, raw, { waitMs: 5000, pump: async () => { kit.clock.advance(1000); await kit.venues.rail.tick(); await stepAllActions(kit.ctx); await new Promise((r) => setTimeout(r, 5)) } })
const ALPHA = 'sim-alpha', BETA = 'sim-beta'

describe('the simulated services', () => {
  it('answer 402 with a priced quote in the shape of the x402 pattern, labelled simulated', async () => {
    const res = await fetch(`${sim.services[0]!.url}/resource/fund-digest`)
    expect(res.status).toBe(402)
    expect(res.headers.get('x-qed-simulated')).toBe('1')
    const q = await res.json() as { x402Version: number; simulated: boolean; accepts: { scheme: string; network: string; maxAmountRequired: string; payTo: string; description: string }[] }
    expect(q.x402Version).toBe(1)
    expect(q.simulated).toBe(true)
    expect(q.accepts[0]).toMatchObject({ scheme: 'exact', network: 'qed-paper-rail', maxAmountRequired: '3500', payTo: 'alpha-digest@simservice' })
    expect(q.accepts[0]!.description).toMatch(/simulated/i)
  })
  it('do not deliver for a payment header that names no settled payment', async () => {
    const s = sim.services[0]!
    const first = await (await fetch(`${s.url}/resource/fund-digest`)).json() as { accepts: { extra: { quoteId: string } }[] }
    const header = Buffer.from(JSON.stringify({ quoteId: first.accepts[0]!.extra.quoteId, paymentRef: 'act_made_up', amount: 3500, payTo: s.payTo })).toString('base64')
    const res = await fetch(`${s.url}/resource/fund-digest`, { headers: { 'x-payment': header } })
    expect(res.status).toBe(402)
    expect(JSON.stringify(await res.json())).toContain('no settled payment')
  })
  it('compare: both quotes, cheapest first, each marked by whether the mandate allows it', async () => {
    const kit = kitOf()
    const c = await compareQuotes(kit.ctx, kit.userId, 'fund-digest')
    expect(c.quotes.map((q) => [q.serviceId, q.amount])).toEqual([[BETA, 2800], [ALPHA, 3500]])
    expect(c.cheapest).toBe(BETA)
    expect(c.cheapestAllowed).toBeNull()
    const d = await compareQuotes(kit.ctx, kit.userId, 'filing-pack')
    expect(d.cheapest).toBe(ALPHA)
    await expect(compareQuotes(kit.ctx, kit.userId, 'nothing')).rejects.toThrow(/product/)
  })
})

describe('the mandate', () => {
  it('is signed with a confirmed approval of its exact document, and is checked', () => {
    const kit = kitOf()
    expect(() => parseMandate({ perPurchase: 5000, perMonth: 4000, services: [ALPHA] })).toThrow(/Some values/)
    expect(() => parseMandate({ perPurchase: 5000, perMonth: 9000, services: ['sim-gamma'] })).toThrow(/Some values/)
    expect(() => parseMandate({ perPurchase: 99_999_999, perMonth: 99_999_999, services: [ALPHA] })).toThrow(/Some values/)
    const p = prepareMandate(kit.ctx, kit.userId, { perPurchase: 5000, perMonth: 9000, services: [ALPHA, BETA] })
    expect(p.document).toContain('simulated')
    // unconfirmed: nothing is in force
    expect(() => activateMandate(kit.ctx, kit.userId, p.approvalId)).toThrow(/not been confirmed/)
    expect(activeMandate(kit.db, kit.userId, kit.clock.now())).toBeNull()
    confirmApproval(kit.db, kit.userId, p.approvalId, { method: 'passkey', docHash: sha256hex(p.document) }, kit.clock.now())
    const m = activateMandate(kit.ctx, kit.userId, p.approvalId)
    expect(m).toMatchObject({ version: 1, perPurchase: 5000, perMonth: 9000, services: [ALPHA, BETA] })
    // an approval is used once
    expect(() => activateMandate(kit.ctx, kit.userId, p.approvalId)).toThrow(/already been used/)
  })
  it('a new one replaces the old; revoking ends it', () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 9000, services: [ALPHA] })
    sign(kit, { perPurchase: 4000, perMonth: 8000, services: [BETA] })
    expect(activeMandate(kit.db, kit.userId, kit.clock.now())).toMatchObject({ version: 2, services: [BETA] })
    expect(commerceState(kit.ctx, kit.userId).history.map((m) => m.state)).toEqual(['active', 'replaced'])
    expect(revokeMandate(kit.ctx, kit.userId).revoked).toBe(true)
    expect(activeMandate(kit.db, kit.userId, kit.clock.now())).toBeNull()
  })
  it('lapses at its end', () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 9000, services: [ALPHA], days: 2 })
    kit.clock.advance(3 * 86_400_000)
    expect(activeMandate(kit.db, kit.userId, kit.clock.now())).toBeNull()
  })
})

describe('buying', () => {
  it('with no mandate, nothing is bought and the reason says so', async () => {
    const kit = kitOf()
    const p = await buy(kit, { sku: 'fund-digest' })
    expect(p.state).toBe('refused')
    expect(p.reason).toMatch(/No commerce mandate is in force/)
    expect(p.actionId).toBeNull()
    expect(balance(kit.db, kit.userId, 'bank')).toBe(balance(kitOf().db, kitOf().userId, 'bank'))
  })

  it('within the mandate: the cheaper allowed service is paid on the paper rail, the receipt is kept, the month counts it', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA, BETA] })
    const before = available(kit.db, kit.userId, 'bank')
    const p = await buy(kit, { sku: 'fund-digest' })
    expect(p).toMatchObject({ state: 'paid', serviceId: BETA, amount: 2800 })
    expect(p.receipt).toMatchObject({ simulated: true, amount: 2800, payTo: 'beta-briefs@simservice', network: 'qed-paper-rail' })
    expect((p.receipt as { serviceReceipt: { success: boolean } }).serviceReceipt.success).toBe(true)
    expect(available(kit.db, kit.userId, 'bank')).toBe(before - 2800n)
    // the payment is an action of origin 'commerce', in Activity's source, decided by the engine's policy
    const a = kit.db.get<{ origin: string; state: string; policy_json: string }>('SELECT origin, state, policy_json FROM actions WHERE id = ?', p.actionId!)!
    expect(a).toMatchObject({ origin: 'commerce', state: 'done' })
    expect(a.policy_json).toContain('mandate:within-month-limit')
    expect(commerceState(kit.ctx, kit.userId).spentThisMonth).toBe(2800)
  })

  it('outside the mandate: a service it does not name, a price over the limit, a month used up; each refused with its reason, nothing paid', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 6000, services: [ALPHA] })
    const bank = available(kit.db, kit.userId, 'bank')
    // 1. a service not on the list
    const a = await buy(kit, { sku: 'fund-digest', serviceId: BETA })
    expect(a.state).toBe('refused')
    expect(a.reason).toMatch(/not one of the services the mandate names/)
    // 2. a price over the limit for one purchase (the pack is 9,500 paise at alpha)
    const b = await buy(kit, { sku: 'filing-pack' })
    expect(b.state).toBe('refused')
    expect(b.reason).toMatch(/over the .* the mandate allows for one purchase/)
    // 3. within the purchase limit, then the month runs out: 3,500 then 3,500 more is over 6,000
    const c = await buy(kit, { sku: 'fund-digest' })
    expect(c.state).toBe('paid')
    const d = await buy(kit, { sku: 'fund-digest' })
    expect(d.state).toBe('refused')
    expect(d.reason).toMatch(/already bought this month/)
    expect(available(kit.db, kit.userId, 'bank')).toBe(bank - 3500n)
    // every refusal is kept with its quotes and checks
    const kept = commerceState(kit.ctx, kit.userId).purchases
    expect(kept.map((x) => x.state)).toEqual(['refused', 'paid', 'refused', 'refused'])
    expect(kept[0]!.checks.some((x) => !x.ok)).toBe(true)
    expect(kept[0]!.quotes).toHaveLength(2)
  })

  it('a quote that names another address is refused, whatever its price', () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA] })
    const v = mandateVerdict(kit.db, kit.userId, { serviceId: ALPHA, amount: 100, quotedPayTo: 'thief@simservice', knownPayTo: OFFERS[0]!.payTo }, kit.clock.now())
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/not the address QED holds/)
  })

  it('the engine refuses a commerce payment that bypassed the flow: no purchase on record, or outside the mandate', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA] })
    const params: PaymentParams = { payeeHandle: 'alpha-digest@simservice', payeeName: 'Alpha', amount: '3500', purpose: 'spend', commerce: { purchaseId: 'cpu_none', serviceId: ALPHA, sku: 'fund-digest' } }
    const a = await stepAction(kit.ctx, createAction(kit.ctx, { userId: kit.userId, origin: 'commerce', kind: 'payment', venue: 'paper-rail', economicId: 'commerce:cpu_none', params }).id)
    expect(a.state).not.toBe('done')
    expect(JSON.stringify(a.policy)).toContain('purchase-on-record')
    // a purchase on record for a different amount than the payment
    kit.db.run(`INSERT INTO commerce_purchases (id, user_id, sku, service_id, service_name, amount, state, quotes_json, created_at, updated_at) VALUES ('cpu_x', ?, 'fund-digest', ?, 'Alpha', 100, 'paying', '{}', ?, ?)`, kit.userId, ALPHA, kit.clock.now(), kit.clock.now())
    const b = await stepAction(kit.ctx, createAction(kit.ctx, { userId: kit.userId, origin: 'commerce', kind: 'payment', venue: 'paper-rail', economicId: 'commerce:cpu_x', params: { ...params, commerce: { purchaseId: 'cpu_x', serviceId: ALPHA, sku: 'fund-digest' } } }).id)
    expect(b.state).not.toBe('done')
    expect(JSON.stringify(b.policy)).toContain('purchase-on-record')
    // an order is never a commerce action
    const o = await stepAction(kit.ctx, createAction(kit.ctx, { userId: kit.userId, origin: 'commerce', kind: 'order', venue: 'paper-mf', economicId: 'commerce:ord', params: { instrumentId: 'amfi:118701', side: 'buy', type: 'market', amount: '10000', purpose: 'x' } }).id)
    expect(o.state).not.toBe('done')
  })

  it('does not take what must stay in the bank: the reserve check applies to an agent as to an instruction', async () => {
    const kit = kitOf({ opening: { ...DEFAULT_OPENING, bank: 3000 } })
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA] })
    const p = await buy(kit, { sku: 'fund-digest' })
    expect(p.state).toBe('failed')
    expect(p.reason).toMatch(/not made/)
  })
})

describe('a request made twice buys once', () => {
  const count = (kit: Kit): number => kit.db.get<{ n: number }>('SELECT COUNT(*) n FROM commerce_purchases WHERE user_id = ?', kit.userId)!.n
  const KEY = 'click-0001-abcdef'
  it('two requests with one key, sent together, make one purchase and one payment', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA, BETA] })
    const bank = available(kit.db, kit.userId, 'bank')
    const [a, b] = await Promise.all([buy(kit, { sku: 'fund-digest', idempotencyKey: KEY }), buy(kit, { sku: 'fund-digest', idempotencyKey: KEY })])
    expect(a.id).toBe(b.id)
    expect(count(kit)).toBe(1)
    expect(kit.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'commerce'`)!.n).toBe(1)
    expect(available(kit.db, kit.userId, 'bank')).toBe(bank - 2800n)
  })
  it('a repeat after it ended returns that purchase unchanged, pays nothing more', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA, BETA] })
    const first = await buy(kit, { sku: 'fund-digest', idempotencyKey: KEY })
    expect(first.state).toBe('paid')
    const bank = available(kit.db, kit.userId, 'bank')
    const again = await buy(kit, { sku: 'fund-digest', idempotencyKey: KEY })
    expect(again).toEqual(first)
    expect(available(kit.db, kit.userId, 'bank')).toBe(bank)
    expect(count(kit)).toBe(1)
  })
  it('a new key is a new purchase; a key used for another product is refused; a malformed key is refused', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 20000, services: [ALPHA, BETA] })
    const a = await buy(kit, { sku: 'fund-digest', idempotencyKey: KEY })
    const b = await buy(kit, { sku: 'fund-digest', idempotencyKey: 'click-0002-abcdef' })
    expect(a.id).not.toBe(b.id)
    await expect(buy(kit, { sku: 'filing-pack', idempotencyKey: KEY })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(101), 12345678]) await expect(buy(kit, { sku: 'fund-digest', idempotencyKey: bad })).rejects.toThrow(/not valid/)
    expect(count(kit)).toBe(2)
  })
  it('with no key, a second request while the first is still being paid is that purchase, not another', async () => {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 20000, services: [ALPHA, BETA] })
    const first = await purchase(kit.ctx, kit.userId, { sku: 'fund-digest' }, { waitMs: 0 })
    expect(first.state).toBe('paying')
    const second = await purchase(kit.ctx, kit.userId, { sku: 'fund-digest' }, { waitMs: 0 })
    expect(second.id).toBe(first.id)
    expect(count(kit)).toBe(1)
  })
})

describe('a purchase left paying is finished from the engine', () => {
  async function stalled() {
    const kit = kitOf()
    sign(kit, { perPurchase: 5000, perMonth: 8000, services: [ALPHA, BETA] })
    const p = await purchase(kit.ctx, kit.userId, { sku: 'fund-digest', idempotencyKey: 'stalled-0001-abc' }, { waitMs: 0 })
    expect(p.state).toBe('paying')
    return { kit, p }
  }
  const settle = async (kit: Kit): Promise<void> => { for (let i = 0; i < 6; i++) { kit.clock.advance(1000); await kit.venues.rail.tick(); await stepAllActions(kit.ctx) } }
  it('once the payment has settled, reconcile delivers it; a second pass changes nothing', async () => {
    const { kit, p } = await stalled()
    expect(await reconcilePurchases(kit.ctx, kit.userId)).toBe(0) // not settled yet: left as it is
    await settle(kit)
    expect(await reconcileAllPurchases(kit.ctx)).toBe(1)
    const done = commerceState(kit.ctx, kit.userId).purchases.find((x) => x.id === p.id)!
    expect(done.state).toBe('paid')
    expect(done.receipt).toMatchObject({ simulated: true, amount: 2800 })
    expect(await reconcileAllPurchases(kit.ctx)).toBe(0)
  })
  it('never overwrites a purchase that has ended, and asks for the goods once when two passes meet', async () => {
    const { kit, p } = await stalled()
    await settle(kit)
    const [a, b] = await Promise.all([reconcilePurchases(kit.ctx, kit.userId), reconcilePurchases(kit.ctx, kit.userId)])
    expect(a + b).toBeGreaterThanOrEqual(1)
    expect(commerceState(kit.ctx, kit.userId).purchases.find((x) => x.id === p.id)!.state).toBe('paid')
    // a late pass, handed the same payment, cannot turn paid into anything else
    kit.db.run(`UPDATE commerce_purchases SET state = 'paid' WHERE id = ?`, p.id)
    expect(await reconcilePurchases(kit.ctx, kit.userId)).toBe(0)
    expect(kit.db.get<{ state: string }>('SELECT state FROM commerce_purchases WHERE id = ?', p.id)!.state).toBe('paid')
  })
  it('with the services not running in this process, a settled purchase stays paying, still counted, instead of being marked undelivered', async () => {
    const { kit, p } = await stalled()
    await settle(kit)
    const running = simServices()
    setSimServices(null)
    try {
      expect(await reconcilePurchases(kit.ctx, kit.userId)).toBe(0)
      expect(kit.db.get<{ state: string }>('SELECT state FROM commerce_purchases WHERE id = ?', p.id)!.state).toBe('paying')
      expect(commerceState(kit.ctx, kit.userId).spentThisMonth).toBe(2800)
    } finally { setSimServices(running) }
    expect(await reconcilePurchases(kit.ctx, kit.userId)).toBe(1)
  })
})
