import { describe, expect, it } from 'vitest'
import { createAction, DATA_WAIT_MS, dismissNotice, getAction, notice, stepAction, stepAllActions } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { available, balance, verifyLedger } from './ledger.ts'
import { crossCheck, START_BY_MS } from './policy.ts'
import { verifyChain } from './receipts.ts'
import { instrument } from './registry.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import { APPROVAL_USE_WITHIN_MS, confirmApproval } from './approvals.ts'
import { midCost, previewAction, QUOTE_TTL_MS, submitApprovedAction } from './owner.ts'
import { noticesView } from './views.ts'
import type { OrderParams, PaymentParams } from './types.ts'
import { venueHolding } from './venues.ts'

const BANK = BigInt(DEFAULT_OPENING.bank)

function ownerOrder(k: Kit, eid: string, params: OrderParams) {
  const venue = params.instrumentId.startsWith('amfi:') ? 'paper-mf' : 'paper-crypto'
  return createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue, economicId: eid, params, approvalId: k.approveOwner(`action:${eid}`) })
}
function ownerPayment(k: Kit, eid: string, params: PaymentParams) {
  return createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'payment', venue: 'paper-rail', economicId: eid, params, approvalId: k.approveOwner(`action:${eid}`) })
}
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }
const payeeRow = (k: Kit, handle: string, name: string): string => { const id = `pay_${handle.replace(/\W/g, '')}`; k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, name, handle, 'other', k.clock.now(), k.clock.now()); return id }

describe('approvals of the owner\'s own actions (found by an adversarial review, 20 November 2026)', () => {
  it('an approval that is not used within five minutes cannot be used: the figures it was given on are stale', async () => {
    const k = makeKit()
    const shop = payeeRow(k, 'shop@upi', 'A shop')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 200_000, purpose: 'spend' })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'session', docHash: pv.docHash }, k.clock.now())
    k.clock.advance(APPROVAL_USE_WITHIN_MS + 1000)
    expect(() => submitApprovedAction(k.ctx, k.userId, pv.approvalId)).toThrow(/given more than five minutes ago/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0)
    // Used in time, it works, and afterwards it cannot be used again.
    const pv2 = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 200_000, purpose: 'spend' })
    confirmApproval(k.db, k.userId, pv2.approvalId, { method: 'session', docHash: pv2.docHash }, k.clock.now())
    k.clock.advance(60_000)
    const a = submitApprovedAction(k.ctx, k.userId, pv2.approvalId)
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('done')
    expect(() => submitApprovedAction(k.ctx, k.userId, pv2.approvalId)).toThrow(/already been used/)
    sound(k)
  })

  it('without the password a session can approve less than ₹10,000 in a day, however it is split and whenever the requests were prepared', async () => {
    const k = makeKit()
    const shop = payeeRow(k, 'shop@upi', 'A shop')
    const one = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 600_000, purpose: 'spend' })
    const two = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 600_000, purpose: 'spend' })
    // Each is under ₹10,000 and nothing has been approved yet, so neither asks for the password when it is prepared.
    expect([one.requiresStepUp, two.requiresStepUp]).toEqual([false, false])
    confirmApproval(k.db, k.userId, one.approvalId, { method: 'session', docHash: one.docHash }, k.clock.now())
    // The second would bring the day to ₹12,000: it is refused at confirmation, in the same transaction that counts.
    expect(() => confirmApproval(k.db, k.userId, two.approvalId, { method: 'session', docHash: two.docHash }, k.clock.now())).toThrow(/reaches ₹10,000, so your password is needed/)
    confirmApproval(k.db, k.userId, two.approvalId, { method: 'password', docHash: two.docHash }, k.clock.now())
    // A third, prepared now, says so at once. A day later the amount is free again.
    expect((await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 400_000, purpose: 'spend' })).requiresStepUp).toBe(true)
    k.clock.advance(86_400_000 + 1000)
    expect((await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 400_000, purpose: 'spend' })).requiresStepUp).toBe(false)
  })

  it('the same reference with different details is a conflict for an owner\'s action; the same details return the action that exists', async () => {
    const k = makeKit()
    payeeRow(k, 'shop@upi', 'A shop')
    const a = ownerPayment(k, 'one-ref', { payeeHandle: 'shop@upi', payeeName: 'A shop', amount: '100000', purpose: 'spend' })
    expect(ownerPayment(k, 'one-ref', { payeeHandle: 'shop@upi', payeeName: 'A shop', amount: '100000', purpose: 'spend' }).id).toBe(a.id)
    expect(() => ownerPayment(k, 'one-ref', { payeeHandle: 'shop@upi', payeeName: 'A shop', amount: '900000', purpose: 'spend' })).toThrow(/already exists with different details/)
    await settle(k)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n).toBe(1)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - 100_000n)
    sound(k)
  })

  it('a venue record that disagrees with the ledger is found when the action finishes: recorded on the receipt, raised to the owner, never passed as agreed', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    // The venue will claim one more unit than it filled. Nothing else is touched.
    const real = k.venues.crypto.get.bind(k.venues.crypto)
    k.venues.crypto.get = (id: string) => { const v = real(id); return v ? { ...v, filledQty: v.filledQty + 1n } : v }
    const a = ownerOrder(k, 'mismatch', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect([done.state, done.recon_state]).toEqual(['done', 'break'])
    const receipt = JSON.parse(k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', done.receipt_id!)!.body_json) as { reconciliation: { state: string; breaks: string[] } }
    expect(receipt.reconciliation.state).toBe('break')
    expect(receipt.reconciliation.breaks[0]).toMatch(/^The ledger shows \d+ atoms for this order; the venue shows \d+\.$/)
    const n = k.db.get<{ level: string; title: string; subject: string }>(`SELECT level, title, subject FROM notices WHERE kind = 'recon-break'`)!
    expect(n).toEqual({ level: 'action', title: 'A record does not match the venue', subject: a.id })
    // The ledger itself still balances: the disagreement is between two records, and it is on the table.
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('a receipt cannot be edited or deleted, and if the protection were removed the chain check would show the change', async () => {
    const k = makeKit()
    payeeRow(k, 'shop@upi', 'A shop')
    ownerPayment(k, 'r-1', { payeeHandle: 'shop@upi', payeeName: 'A shop', amount: '100000', purpose: 'spend' })
    ownerPayment(k, 'r-2', { payeeHandle: 'shop@upi', payeeName: 'A shop', amount: '200000', purpose: 'spend' })
    await settle(k)
    const n = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM receipts WHERE user_id = ?', k.userId)!.n
    expect(n).toBeGreaterThanOrEqual(2)
    expect(verifyChain(k.db, k.userId)).toMatchObject({ ok: true, count: n, brokenAt: null })
    expect(() => k.db.run(`UPDATE receipts SET body_json = '{}' WHERE user_id = ? AND seq = 1`, k.userId)).toThrow(/append-only/)
    expect(() => k.db.run('DELETE FROM receipts WHERE user_id = ? AND seq = 1', k.userId)).toThrow(/append-only/)
    // Someone with the database file could drop the triggers. The chain is what would then give the edit away.
    k.db.run('DROP TRIGGER receipts_no_update')
    const body = JSON.parse(k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE user_id = ? AND seq = 1', k.userId)!.body_json) as Record<string, unknown>
    k.db.run('UPDATE receipts SET body_json = ? WHERE user_id = ? AND seq = 1', JSON.stringify({ ...body, edited: true }), k.userId)
    expect(verifyChain(k.db, k.userId)).toMatchObject({ ok: false, brokenAt: 1 })
  })
})

describe('an estimate priced on a live order book (R7-094)', () => {
  it('holds for a minute: its time and source are in the signed document, and the approval lapses with it', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const t0 = k.clock.now()
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 500_000 })
    expect(pv.quote).toMatchObject({ at: t0, validUntil: t0 + QUOTE_TTL_MS, indicative: false })
    expect(pv.expiresAt).toBe(t0 + QUOTE_TTL_MS)
    expect((JSON.parse(pv.document) as { quote?: { validUntil: number } }).quote?.validUntil).toBe(t0 + QUOTE_TTL_MS)
    k.clock.advance(QUOTE_TTL_MS + 1)
    expect(() => confirmApproval(k.db, k.userId, pv.approvalId, { method: 'password', docHash: pv.docHash }, k.clock.now())).toThrow(/expired|lapsed|no longer/i)
  })
  it('a fund order has no live quote: its estimate follows the NAV rule and its approval keeps the ordinary time', async () => {
    const k = makeKit(); k.nav('amfi:118701', '2026-11-17', '6500.0000')
    const t0 = k.clock.now()
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:118701', side: 'buy', type: 'nav', amount: 500_000 })
    expect(pv.quote).toBeNull()
    expect(pv.expiresAt - t0).toBeGreaterThan(QUOTE_TTL_MS)
  })
})

describe('an order\'s approval names who it goes to, the asset, the route and what follows (R12 section 4)', () => {
  it('a market buy on the order book and a fund purchase each open with where, what and how, and end with what follows once approved', async () => {
    const k = makeKit(); k.btc(6_600_000); k.nav('amfi:118701', '2026-11-17', '6500.0000')
    const coin = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 500_000 })
    expect(coin.lines.slice(0, 3).map((l) => [l.label, l.value])).toEqual([['Placed with', "CoinDCX's order book, on paper"], ['Asset', 'BTC, for Indian rupees'], ['Route', 'A paper venue on this QED installation']])
    expect(coin.lines.at(-1)).toMatchObject({ label: 'Once you approve', value: 'It fills at once against the book, no worse than your worst price' })
    expect(coin.lines.some((l) => l.label === 'Leaves your bank')).toBe(true) // the amount stays where it was
    const fund = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'amfi:118701', side: 'buy', type: 'nav', amount: 500_000 })
    expect(fund.lines.slice(0, 3).map((l) => l.label)).toEqual(['Placed with', 'Asset', 'Route'])
    expect(fund.lines[0]!.note).toMatch(/no order reaches the fund house/)
    expect(fund.lines.at(-1)).toMatchObject({ label: 'Once you approve', note: 'It cannot be cancelled once the cut-off has passed.' })
    // the signed document carries the same lines, so what the passkey signs is what the sheet shows
    expect((JSON.parse(fund.document) as { estimate?: { label: string }[] }).estimate?.map((l) => l.label)).toEqual(fund.lines.map((l) => l.label))
  })
})

describe('a market order\'s cost against the mid price (F-083)', () => {
  it('splits into half the spread, the walk down the book and the fee, which sum to the whole to the paisa', () => {
    // buy 0.5 at an average of ₹101.20 (₹50.60 paid) when the book shows 99 / 101, fee ₹0.25: against the mid of 100
    // (₹50.00) it costs ₹0.85 = half the spread ₹0.50 + the walk beyond the best ask ₹0.10 + the fee ₹0.25
    const b = midCost('buy', 99, 101, 0.5, 5_060, 25)!
    expect(b).toEqual({ mid: 100, total: 85, halfSpread: 50, impact: 10 })
    // sell 2 at an average of ₹98.50 (₹197.00 received) against the same book, fee ₹0.20: ₹3.20 = ₹2.00 + ₹1.00 + ₹0.20
    const sl = midCost('sell', 99, 101, 2, 19_700, 20)!
    expect(sl).toEqual({ mid: 100, total: 320, halfSpread: 200, impact: 100 })
    for (let i = 0; i < 200; i++) { // any figures: the parts always sum
      const bid = 50 + Math.random() * 50, ask = bid + Math.random() * 3, q = Math.random() * 3, amt = Math.round(q * (ask + Math.random()) * 100), fee = Math.round(amt * 0.005)
      const c = midCost(i % 2 ? 'buy' : 'sell', bid, ask, q, amt, fee)
      if (c) expect(c.halfSpread + c.impact + fee).toBe(c.total)
    }
    expect(midCost('buy', 99, 101, 0, 0, 0)).toBeNull()
  })
  it('a market buy\'s sheet shows the cost against the mid price, split', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 500_000 })
    const line = pv.lines.find((l) => l.label === 'Cost against the mid price')!
    expect(line.note).toMatch(/^Half the gap between buyers and sellers ₹[\d,.]+ \+ walking the book ₹[\d,.]+ \+ venue fee ₹[\d,.]+; the mid price is /)
  })
})

describe('order execution, end to end', () => {
  it('a market buy: hold, fill against the book, ledger, reconciliation, receipt', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const a = ownerOrder(k, 'buy-1', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', maxSlippageBps: 100, purpose: 'manual' })
    await stepAction(k.ctx, a.id)
    expect(getAction(k.db, a.id)!.state).toBe('working')
    expect(available(k.db, k.userId, 'bank')).toBe(BANK - 1_000_000n) // reserved, not yet spent
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect(done.state).toBe('done')
    expect(done.recon_state).toBe('reconciled')
    expect(done.receipt_id).toBeTruthy()
    const spent = BANK - balance(k.db, k.userId, 'bank')
    expect(spent > 0n && spent <= 1_000_000n).toBe(true)
    expect(available(k.db, k.userId, 'bank')).toBe(balance(k.db, k.userId, 'bank')) // nothing left reserved
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBe(venueHolding(k.db, k.userId, 'coindcx:BTCINR'))
    expect(balance(k.db, k.userId, 'exp:fees') > 0n).toBe(true)
    for (const t of ['created', 'decided', 'submitted', 'executed', 'finished', 'reconciled']) expect(done.times[t]).toBeTypeOf('number')
    const r = k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', done.receipt_id)!
    const body = JSON.parse(r.body_json) as { venue: { fills: { evidence: { snapshotId: string; receivedAt: number } }[] }; decision: { checks: { name: string; ok: boolean }[] }; approval: { documentHash: string } }
    expect(body.venue.fills[0]!.evidence.snapshotId).toBeTruthy()
    expect(body.decision.checks.every((c) => c.ok)).toBe(true)
    expect(body.approval.documentHash).toMatch(/^[0-9a-f]{64}$/)
    // what it cost against its reference, and that the ledger moved exactly that (R7-096)
    const costs = (JSON.parse(r.body_json) as { costs: { reference: { kind: string; price: number; spreadBps: number; source: string }; averagePrice: number; slippageBps: number; cashExpected: string; cashBooked: string; fee: string; feeBooked: string; ledgerAgrees: boolean } }).costs
    expect(costs.reference).toMatchObject({ kind: 'book', source: 'test' })
    const snap = JSON.parse(k.db.get<{ body_json: string }>('SELECT body_json FROM snapshots WHERE id = ?', body.venue.fills[0]!.evidence.snapshotId)!.body_json) as { asks: { price: string }[] }
    expect(costs.reference.price).toBe(Number(snap.asks[0]!.price))
    expect(costs.slippageBps).toBeGreaterThanOrEqual(0)
    expect(costs.reference.spreadBps).toBeGreaterThan(0)
    expect(costs.ledgerAgrees).toBe(true)
    expect(BigInt(costs.cashBooked)).toBe(-spent)
    expect(costs.cashBooked).toBe(costs.cashExpected)
    expect(costs.feeBooked).toBe(costs.fee)
    sound(k)
  })

  it('the same economic id never executes twice, however often it is created or stepped', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const p: OrderParams = { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' }
    const a = ownerOrder(k, 'dup', p)
    const again = createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: 'dup', params: p })
    expect(again.id).toBe(a.id)
    await settle(k)
    for (let i = 0; i < 5; i++) { await stepAction(k.ctx, a.id); await stepAllActions(k.ctx) }
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(1)
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM entries WHERE kind = 'buy'")!.n).toBe(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_fills')!.n)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM receipts')!.n).toBe(1)
    sound(k)
  })

  it('a crash between "submitting" and "working" resubmits with the same reference and books once', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const a = ownerOrder(k, 'crash', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await stepAction(k.ctx, a.id) // now 'working': the venue has the order
    // Simulate the process dying after the venue accepted the order but before the wallet recorded that.
    k.db.run("UPDATE actions SET state = 'submitting' WHERE id = ?", a.id)
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('done')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(1)
    sound(k)
  })

  it('refuses when there is not enough money, and nothing moves', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const a = ownerOrder(k, 'poor', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: (BANK + 100n).toString(), purpose: 'manual' })
    await settle(k)
    const r = getAction(k.db, a.id)!
    expect(r.state).toBe('blocked')
    expect(r.error).toMatch(/needed/)
    expect(r.recon_state).toBe('not_applicable')
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(0)
    expect(k.db.get<{ kind: string }>('SELECT kind FROM receipts')!.kind).toBe('refusal')
    sound(k)
  })

  it('a stale price: waits a bounded time for a fresh one, then refuses instead of trading on it', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.clock.advance(60_000)
    const a = ownerOrder(k, 'stale', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    let r = getAction(k.db, a.id)!
    expect(r.state).toBe('planned') // waiting; nothing is reserved or sent while it waits
    expect(String(r.result.waitingFor)).toMatch(/received/)
    expect(available(k.db, k.userId, 'bank')).toBe(BANK)
    k.clock.advance(DATA_WAIT_MS)
    await settle(k)
    r = getAction(k.db, a.id)!
    expect(r.state).toBe('blocked')
    expect(r.policy.checks!.find((c) => c.name === 'price-fresh')!.ok).toBe(false)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    sound(k)
  })

  it('a price that turns fresh within the wait is used, and the order executes once', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.clock.advance(60_000) // the feed went quiet, as after a machine wakes
    const a = ownerOrder(k, 'reconnect', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('planned')
    k.btc(6_610_000) // the feed is back
    await settle(k)
    const r = getAction(k.db, a.id)!
    expect(r.state).toBe('done')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(1)
    sound(k)
  })

  it('an approved order the engine could not start in time is refused, not sent late at a new price', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const a = ownerOrder(k, 'late', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    // The engine was not running: nothing stepped the action for 200 seconds. Prices are fresh again when it returns.
    k.clock.advance(200_000)
    k.btc(6_900_000)
    await settle(k)
    const r = getAction(k.db, a.id)!
    expect(r.state).toBe('blocked')
    expect(r.policy.checks!.filter((c) => !c.ok).map((c) => c.name)).toEqual(['started-in-time'])
    expect(START_BY_MS).toBeLessThan(200_000)
    // After ten minutes the approval itself has lapsed as well: it was given on figures that are no longer current.
    const b = ownerOrder(k, 'later', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    k.clock.advance(600_000)
    k.btc(6_900_000)
    await settle(k)
    const failed = getAction(k.db, b.id)!.policy.checks!.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['owner-approved', 'started-in-time'])
    expect(failed[0]!.detail).toMatch(/given more than five minutes ago and was not used/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(0)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    sound(k)
  })

  it('an approval covers one action only: a second action cannot reuse it', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const a = ownerOrder(k, 'one', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    const b = createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: 'two', params: { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' }, approvalId: a.approval_id })
    await settle(k)
    expect(getAction(k.db, b.id)!.state).toBe('blocked')
    expect(getAction(k.db, b.id)!.error).toMatch(/something else/)
  })

  it('sell everything: holdings, fee and TDS all reconcile; the ledger and the venue agree', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    ownerOrder(k, 'b', { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '2000000', purpose: 'manual' })
    await settle(k)
    const held = balance(k.db, k.userId, 'pos:coindcx:BTCINR')
    expect(held > 0n).toBe(true)
    k.clock.advance(120_000); k.btc(6_700_000)
    const s = ownerOrder(k, 's', { instrumentId: 'coindcx:BTCINR', side: 'sell', type: 'market', sellAll: true, purpose: 'manual' })
    await settle(k)
    const done = getAction(k.db, s.id)!
    expect(done.state).toBe('done')
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBe(0n)
    expect(venueHolding(k.db, k.userId, 'coindcx:BTCINR')).toBe(0n)
    expect(balance(k.db, k.userId, 'tds') > 0n).toBe(true)
    const realised = k.db.get<{ p: string; c: string }>('SELECT amount_sum(proceeds) p, amount_sum(cost) c FROM realised')!
    expect(BigInt(realised.c)).toBeGreaterThan(0n)
    expect(done.recon_state).toBe('reconciled')
    sound(k)
  })
})

describe('fund orders', () => {
  it('money leaves at once, and units arrive only when the NAV is published', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const a = ownerOrder(k, 'mf-1', { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: '500000', purpose: 'manual' })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('working')
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - 500_000n)
    expect(balance(k.db, k.userId, 'clear:mf')).toBe(500_000n)
    expect(getAction(k.db, a.id)!.result.navEntitledFrom).toBe('2026-11-18')
    k.clock.advance(12 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '180.0000')
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect(done.state).toBe('done')
    expect(balance(k.db, k.userId, 'pos:amfi:120716')).toBe(27_776n)
    expect(balance(k.db, k.userId, 'clear:mf')).toBe(0n)
    expect(balance(k.db, k.userId, 'exp:stamp')).toBe(25n)
    // The whole ₹5,000 is invested: ₹0.25 stamp duty and ₹4,999.75 for 27.776 units (units are rounded down to a thousandth).
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - 500_000n)
    expect(done.recon_state).toBe('reconciled')
    // its costs: the NAV it executed at, the stamp duty, and the money fund clearing moved for it (R7-096)
    const fc = (JSON.parse(k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', done.receipt_id)!.body_json) as { costs: { reference: { kind: string; navDate: string | null }; cashAccount: string; ledgerAgrees: boolean; slippageBps: number } }).costs
    expect(fc).toMatchObject({ reference: { kind: 'nav' }, cashAccount: 'clear:mf', ledgerAgrees: true })
    expect(fc.reference.navDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    sound(k)
  })

  it('a redemption shows "on its way" until the payout day, then lands in the bank', async () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    ownerOrder(k, 'lb', { instrumentId: 'amfi:118701', side: 'buy', type: 'nav', amount: '10000000', purpose: 'manual' })
    await settle(k)
    const units = balance(k.db, k.userId, 'pos:amfi:118701')
    expect(units > 0n).toBe(true)
    const s = ownerOrder(k, 'ls', { instrumentId: 'amfi:118701', side: 'sell', type: 'nav', sellAll: true, purpose: 'manual' })
    await settle(k)
    expect(available(k.db, k.userId, 'pos:amfi:118701')).toBe(0n) // units reserved for the redemption
    k.clock.advance(20 * 3600_000)
    k.nav('amfi:118701', '2026-11-18', '7034.7000')
    await settle(k)
    const mid = getAction(k.db, s.id)!
    expect(mid.state).toBe('working')
    expect(balance(k.db, k.userId, 'pos:amfi:118701')).toBe(0n)
    const receivable = balance(k.db, k.userId, 'recv:mf')
    expect(receivable > 0n).toBe(true)
    expect(mid.result.payoutAt).toBeTypeOf('number')
    k.clock.set(Number(mid.result.payoutAt) + 60_000)
    await settle(k)
    expect(getAction(k.db, s.id)!.state).toBe('done')
    expect(balance(k.db, k.userId, 'recv:mf')).toBe(0n)
    sound(k)
  })
})

describe('payments', () => {
  it('settles: clearing empties and the spend is booked', async () => {
    const k = makeKit()
    // a landlord on the list for a month (a payee added in the last day would wait first: new-payee.ts)
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'pye_landlord', k.userId, 'Landlord', 'landlord@upi', 'rent', k.clock.now() - 30 * 86_400_000)
    const a = ownerPayment(k, 'p1', { payeeHandle: 'landlord@upi', payeeName: 'Landlord', amount: '2500000', purpose: 'spend', memo: 'Rent' })
    await stepAction(k.ctx, a.id)
    expect(balance(k.db, k.userId, 'clear:pay')).toBe(2_500_000n)
    expect(getAction(k.db, a.id)!.state).toBe('working')
    await settle(k)
    const d = getAction(k.db, a.id)!
    expect(d.state).toBe('done')
    expect(balance(k.db, k.userId, 'clear:pay')).toBe(0n)
    expect(balance(k.db, k.userId, 'exp:spend')).toBe(2_500_000n)
    expect(d.recon_state).toBe('reconciled')
    sound(k)
  })
  it('a declined payment returns the money and says why', async () => {
    const k = makeKit()
    const a = ownerPayment(k, 'p2', { payeeHandle: 'decline@paper', payeeName: 'Test decline', amount: '100000', purpose: 'spend' })
    await settle(k)
    const d = getAction(k.db, a.id)!
    expect(d.state).toBe('failed')
    expect(d.error).toMatch(/Declined/)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(balance(k.db, k.userId, 'clear:pay')).toBe(0n)
    sound(k)
  })
  it('an unanswered payment stays pending, visibly, until the rail answers', async () => {
    const k = makeKit()
    const a = ownerPayment(k, 'p3', { payeeHandle: 'timeout@paper', payeeName: 'Test timeout', amount: '100000', purpose: 'spend' })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('working')
    expect(getAction(k.db, a.id)!.result.railState).toBe('unknown')
    expect(balance(k.db, k.userId, 'clear:pay')).toBe(100_000n)
    k.clock.advance(130_000)
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('failed')
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
  })
  it('paying the card reduces the debt; paying more than is owed is refused', async () => {
    const k = makeKit()
    const a = ownerPayment(k, 'c1', { payeeHandle: 'card@paperbank', payeeName: 'Credit card', amount: '5000000', purpose: 'card' })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('done')
    expect(balance(k.db, k.userId, 'card')).toBe(BigInt(DEFAULT_OPENING.card) - 5_000_000n)
    const b = ownerPayment(k, 'c2', { payeeHandle: 'card@paperbank', payeeName: 'Credit card', amount: '9900000', purpose: 'card' })
    await settle(k)
    expect(getAction(k.db, b.id)!.state).toBe('blocked')
    expect(getAction(k.db, b.id)!.error).toMatch(/owed/)
    sound(k)
  })
  it('a loan prepayment books the principal and its charge separately', async () => {
    const k = makeKit()
    const a = ownerPayment(k, 'l1', { payeeHandle: 'loan-personal@paperbank', payeeName: 'Personal loan', amount: '10000000', charge: '300000', purpose: 'loan:personal' })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('done')
    expect(balance(k.db, k.userId, 'loan:personal')).toBe(BigInt(DEFAULT_OPENING.personalLoan) - 10_000_000n)
    expect(balance(k.db, k.userId, 'exp:fees')).toBe(300_000n)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - 10_300_000n)
    sound(k)
  })
})

describe('the sentence that compares the venue\'s price with a second source', () => {
  it('writes both prices to the paisa, so one is never ₹64,70,950.5 beside ₹64,33,454.45', () => {
    const k = makeKit()
    k.btc(6_470_950)
    // The two prices are midpoints the wallet works out, not quotes: 64,70,950.5 here, and 64,70,950 there.
    k.quote('coindcx:BTCINR', 'bid', '6470950'); k.quote('coindcx:BTCINR', 'ask', '6470951')
    const cc = crossCheck(k.ctx, instrument(k.db, 'coindcx:BTCINR')!, k.clock.now())
    expect(cc.ok).toBe(true)
    expect(cc.detail).toMatch(/^₹64,70,950\.50 here against ₹64,70,950\.00 from /)
    expect(cc.detail).not.toMatch(/₹[0-9,]+\.[0-9](?![0-9])/)
  })
})

describe('notices', () => {
  it('the same thing said several times is listed once with a count, and dismissed together; a different notice stays', () => {
    const k = makeKit()
    const t = k.clock.now()
    for (let i = 0; i < 3; i++) notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'Invest: 1 scheduled run was missed', body: 'The engine was not running.', subject: 'prg_1' }, t + i * 60_000)
    notice(k.db, k.userId, { level: 'warning', kind: 'runs-missed', title: 'Invest: 1 scheduled run was missed', body: 'The engine was not running.', subject: 'prg_2' }, t)
    notice(k.db, k.userId, { level: 'action', kind: 'emi-unpaid', title: 'An instalment could not be paid', body: 'x' }, t)
    const list = noticesView(k.db, k.userId)
    expect(list.map((n) => [n.level, n.subject, n.count])).toEqual([['action', null, 1], ['warning', 'prg_1', 3], ['warning', 'prg_2', 1]])
    const three = list.find((n) => n.subject === 'prg_1')!
    expect([three.firstTs, three.ts]).toEqual([t, t + 120_000])
    expect(dismissNotice(k.db, k.userId, String(three.id), t + 200_000)).toBe(3)
    expect(noticesView(k.db, k.userId).map((n) => n.subject)).toEqual([null, 'prg_2'])
    // A notice that needs an answer cannot be dismissed, and another owner's notice cannot be touched.
    expect(dismissNotice(k.db, k.userId, String(list[0]!.id), t + 200_000)).toBe(0)
    expect(dismissNotice(k.db, 'usr_other', String(list[2]!.id), t + 200_000)).toBe(0)
  })
})

describe('a hand-made purchase too small for the venue', () => {
  it('is refused at the preview, with the least that would fill, before the owner is asked to approve anything', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    await expect(previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 10_000 })).rejects.toThrow(/₹100 buys less than the venue's smallest order of ₹100.*Enter at least ₹133\./)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals')!.n).toBe(0)
    const ok = await previewAction(k.ctx, k.userId, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 13_300 })
    expect(ok.summary).toBe('Buy ₹133 of Bitcoin in rupees')
  })
})
