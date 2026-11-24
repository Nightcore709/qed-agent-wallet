/**
 * A payment to a new payee that must wait (R12 task comparison, gap 4, T2-e), through the engine: approved, its money set
 * aside, held until the time its signed terms give, then sent; cancellable by the owner while it waits; held further while
 * QED is paused; never sent early by any path. The double-payment guard and the pending states still hold.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { cancelAction, createAction, getAction, stepAllActions } from './execute.ts'
import { saveProfile } from './household.ts'
import { available, verifyLedger } from './ledger.ts'
import { addBill, addPayee, billPaymentUnderWay, previewAction, submitApprovedAction } from './owner.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { reconcileUser } from './recon.ts'
import { clearStop, runTick, schedulerTick, setStop, triggerTick } from './runner.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import type { PaymentParams } from './types.ts'

const H = 3600_000
const onRail = (k: Kit) => k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n
const checkOf = (k: Kit, id: string) => (getAction(k.db, id)!.policy.checks ?? []).find((c) => c.name === 'new-payee-wait')
async function approvedPayment(k: Kit, payeeId: string, amount: number, extra: Record<string, unknown> = {}) {
  const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId, amount, ...extra })
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  return { pv, act: submitApprovedAction(k.ctx, k.userId, pv.approvalId) }
}
function setup() {
  const k = makeKit()
  const y = addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, k.clock.now())
  return { k, y }
}

describe('a first-day payment above the amount waits, then is sent', () => {
  it('is approved and its money set aside, waits untouched until its time, and is then sent and settles', async () => {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    const until = (JSON.parse(pv.document) as { action: { params: PaymentParams } }).action.params.hold!.until
    await stepAllActions(k.ctx)
    let a = getAction(k.db, act.id)!
    expect(a.state).toBe('held')
    expect(a.times.held).toBe(k.clock.now())
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)
    expect(k.db.get<{ consumed_at: number | null }>('SELECT consumed_at FROM approvals WHERE id = ?', pv.approvalId)!.consumed_at).toBe(k.clock.now())
    // every check passed: the wait is met by waiting, and the record never reads it as a refusal
    expect(checkOf(k, act.id)).toMatchObject({ ok: true, detail: expect.stringMatching(/^It waits until .+, as the terms you approved say\./) })
    expect((a.policy.checks ?? []).filter((c) => !c.ok)).toEqual([])
    expect(onRail(k)).toBe(0)
    // told where the owner can see it, with the way to cancel
    expect(k.db.get<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE user_id = ? AND kind = 'payment-held'`, k.userId)).toMatchObject({ title: expect.stringMatching(/^₹15,000 to Ravi Kumar waits until /), body: expect.stringMatching(/cancel it on its record/) })

    // a second before its time nothing is sent, however often the engine steps
    k.clock.set(until - 1000)
    for (let i = 0; i < 3; i++) { await stepAllActions(k.ctx); await k.venues.rail.tick() }
    expect(getAction(k.db, act.id)!.state).toBe('held')
    expect(onRail(k)).toBe(0)
    // and it is still waiting, not released and held again: its money stays set aside all through the wait
    expect(getAction(k.db, act.id)!.times.released).toBeUndefined()
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)

    // the engine was not running when the wait ended: it is sent when it next runs, not refused as late
    k.clock.set(until + 10 * 60_000)
    await settle(k)
    a = getAction(k.db, act.id)!
    expect(a.state).toBe('done')
    expect(a.times.released).toBe(until + 10 * 60_000)
    expect(checkOf(k, act.id)).toMatchObject({ ok: true, detail: expect.stringMatching(/^It waited until .+, as the terms you approved said\./) })
    expect((a.policy.checks ?? []).find((c) => c.name === 'started-in-time')).toMatchObject({ ok: true })
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM holds WHERE user_id = ? AND released_at IS NULL`, k.userId)!.n).toBe(0)
    expect(a.receipt_id).toBeTruthy()
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    expect(verifyChain(k.db, k.userId).ok).toBe(true)
  })

  it('reconciliation, which runs every half minute, leaves a waiting payment\'s money set aside and finds nothing to repair', async () => {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    const { act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    for (let i = 0; i < 3; i++) {
      k.clock.advance(30_000)
      const r = reconcileUser(k.ctx, k.userId)
      expect(r.repaired).toEqual([])
      expect(r.breaks).toEqual([])
    }
    expect(getAction(k.db, act.id)!.state).toBe('held')
    expect(k.db.get<{ released_at: number | null }>('SELECT released_at FROM holds WHERE user_id = ? AND ref = ?', k.userId, `act:${act.id}`)).toEqual({ released_at: null })
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)
  })

  it('the owner can cancel it while it waits: the money set aside is free again and nothing is sent', async () => {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    const { act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    const c = cancelAction(k.ctx, k.userId, act.id)
    expect(c).toMatchObject({ state: 'cancelled', error: 'Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.' })
    expect(available(k.db, k.userId, 'bank')).toBe(bank)
    k.clock.advance(48 * H)
    await settle(k)
    expect(getAction(k.db, act.id)).toMatchObject({ state: 'cancelled', recon_state: 'not_applicable', receipt_id: expect.any(String) })
    expect(onRail(k)).toBe(0)
    expect(() => cancelAction(k.ctx, k.userId, act.id)).toThrow(/already finished/)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('the pause holds it: paused when its wait ends, it keeps waiting, and goes once QED is resumed', async () => {
    const { k, y } = setup()
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    const until = (JSON.parse(pv.document) as { action: { params: PaymentParams } }).action.params.hold!.until
    await stepAllActions(k.ctx)
    setStop(k.ctx, k.userId, 'Stopped by you')
    k.clock.set(until + 1000)
    await settle(k)
    expect(getAction(k.db, act.id)).toMatchObject({ state: 'held', result: { pausedWhenDue: until + 1000 } })
    expect(onRail(k)).toBe(0)
    clearStop(k.ctx, k.userId)
    k.clock.advance(5 * H)
    await settle(k)
    expect(getAction(k.db, act.id)!.state).toBe('done')
  })
})

describe('no path sends it early', () => {
  it('the same approval cannot be used again, and asking again for the same payee waits too', async () => {
    const { k, y } = setup()
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    expect(() => submitApprovedAction(k.ctx, k.userId, pv.approvalId)).toThrow(/already been used/)
    // with ₹15,000 already on its way, even ₹100 more to the same new payee waits
    const again = await approvedPayment(k, y.id, 10_000)
    expect((JSON.parse(again.pv.document) as { action: { params: PaymentParams } }).action.params.hold).toBeDefined()
    await stepAllActions(k.ctx)
    expect(getAction(k.db, again.act.id)!.state).toBe('held')
    // cancelling the first and asking again does not send the second early
    cancelAction(k.ctx, k.userId, act.id)
    await settle(k)
    expect(getAction(k.db, again.act.id)!.state).toBe('held')
    expect(onRail(k)).toBe(0)
  })

  it('splitting a payment does not get round it: the part that takes the first day above the amount waits', async () => {
    const { k, y } = setup()
    const one = await approvedPayment(k, y.id, 600_000)
    await settle(k)
    expect(getAction(k.db, one.act.id)!.state).toBe('done')
    const two = await approvedPayment(k, y.id, 600_000)
    await settle(k)
    expect(getAction(k.db, two.act.id)!.state).toBe('held')
  })

  it('a payment made without the wait its payee calls for is refused by the engine and nothing is sent', async () => {
    const { k } = setup()
    const eid = 'forged-no-wait'
    const a = createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'payment', venue: 'paper-rail', economicId: eid, params: { payeeHandle: 'ravi.kumar@upi', payeeName: 'Ravi Kumar', amount: '1500000', purpose: 'spend' }, approvalId: k.approveOwner(`action:${eid}`) })
    await settle(k)
    expect(getAction(k.db, a.id)).toMatchObject({ state: 'blocked', error: expect.stringMatching(/was added today at 10:30.*It did not wait, so it was not sent\./) })
    expect(checkOf(k, a.id)).toMatchObject({ ok: false })
    expect(onRail(k)).toBe(0)
  })

  it('an instruction\'s payment carries no wait of its own: one to a new payee above the amount is refused, whatever its parameters say', async () => {
    const { k } = setup()
    const eid = 'program-with-hold'
    const a = createAction(k.ctx, { userId: k.userId, origin: 'program', kind: 'payment', venue: 'paper-rail', economicId: eid, params: { payeeHandle: 'ravi.kumar@upi', payeeName: 'Ravi Kumar', amount: '1500000', purpose: 'spend', hold: { until: k.clock.now() - 1, why: 'forged' } } })
    await settle(k)
    expect(getAction(k.db, a.id)!.state).toBe('blocked')
    // refused by the new-payee rule in particular, whatever else an instruction-less run also fails on
    expect(checkOf(k, a.id)).toMatchObject({ ok: false, detail: expect.stringMatching(/An instruction's payment does not wait, so it was not sent\.$/) })
    expect(onRail(k)).toBe(0)
  })

  it('a bills instruction does not pay a new payee\'s bill above the amount: the bill waits for the owner', async () => {
    const { k, y } = setup()
    const bill = addBill(k.db, k.userId, { payeeId: y.id, amount: 1_200_000, dueAt: k.clock.now() + 60_000, memo: 'Deposit' }, k.clock.now())
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['ravi.kumar@upi'], capPerBill: 2_000_000 }, authority: { expiresAt: k.clock.now() + 30 * 24 * H, maxPerRun: 2_000_000, maxPerMonth: 5_000_000 } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    k.clock.advance(2 * 60_000)
    for (let i = 0; i < 4; i++) { schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx); await settle(k, 2); runTick(k.ctx) }
    expect(onRail(k)).toBe(0)
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', bill.id)!.state).toBe('due')
    const run = k.db.get<{ state: string; reason: string }>('SELECT state, reason FROM runs WHERE program_id = ? ORDER BY created_at DESC LIMIT 1', d.programId)!
    expect(run).toMatchObject({ state: 'skipped', reason: expect.stringMatching(/^Ravi Kumar was added today at 10:30\. Your instructions do not pay a payee more than ₹10,000 in its first 24 hours, so this ₹12,000 bill waits for you: pay it yourself from Spend, where it waits 24 hours before it is sent\.$/) })
  })

  it('changing the setting after signing does not send it early', async () => {
    const { k, y } = setup()
    const { act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    saveProfile(k.db, k.userId, { newPayeeHoldAbove: 100_000_000, newPayeeHoldHours: 1 })
    k.clock.advance(2 * H)
    await settle(k)
    expect(getAction(k.db, act.id)!.state).toBe('held')
    expect(onRail(k)).toBe(0)
  })
})

describe('what can happen while it waits (R13 section 4)', () => {
  const untilOf = (pv: { document: string }) => (JSON.parse(pv.document) as { action: { params: PaymentParams } }).action.params.hold!.until
  /** A payment held, then everything the engine does once its time has come; with the bank's free money before it. */
  async function heldThenDue(change: (k: Kit, y: { id: string; handle: string }) => void) {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    expect(getAction(k.db, act.id)!.state).toBe('held')
    change(k, y)
    k.clock.set(untilOf(pv) + 1000)
    await settle(k)
    return { k, a: getAction(k.db, act.id)!, bank }
  }
  // No route removes, renames or re-adds a payee today (api.ts); the database is changed directly, as a later feature or a
  // damaged file could. The terms were signed for one payee, as it was: anything else is a recipient change.
  it('its payee removed while it waits: it is not sent, and its money is free again', async () => {
    const { k, a, bank } = await heldThenDue((k, y) => { k.db.run('DELETE FROM payees WHERE id = ?', y.id) })
    expect(a).toMatchObject({ state: 'blocked', error: 'Ravi Kumar is no longer one of your payees, so it was not sent, and nothing left your bank for it.' })
    expect(onRail(k)).toBe(0)
    expect(available(k.db, k.userId, 'bank')).toBe(bank)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
  it('its payee removed and added again at the same address while it waits: it is not sent', async () => {
    const { k, a, bank } = await heldThenDue((k, y) => {
      k.db.run('DELETE FROM payees WHERE id = ?', y.id)
      addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: y.handle, category: 'family' }, k.clock.now() + H)
    })
    expect(a).toMatchObject({ state: 'blocked', error: expect.stringMatching(/^Ravi Kumar was removed from your payees and added again while it waited, so it was not sent/) })
    expect(onRail(k)).toBe(0)
    expect(available(k.db, k.userId, 'bank')).toBe(bank)
  })
  it('its payee renamed while it waits: it is not sent', async () => {
    const { k, a } = await heldThenDue((k, y) => { k.db.run(`UPDATE payees SET name = 'R Kumar Traders' WHERE id = ?`, y.id) })
    expect(a).toMatchObject({ state: 'blocked', error: 'The payee at ravi.kumar@upi is now called R Kumar Traders, not Ravi Kumar as you approved, so it was not sent, and nothing left your bank for it.' })
    expect(onRail(k)).toBe(0)
  })
  it('its payee as it was: it is sent, to the address it was signed for', async () => {
    const { k, a } = await heldThenDue(() => {})
    expect(a.state).toBe('done')
    expect((a.policy.checks ?? []).find((c) => c.name === 'payee-as-signed')).toMatchObject({ ok: true })
    expect(k.db.get('SELECT payee_handle FROM pv_payments')).toEqual({ payee_handle: 'ravi.kumar@upi' })
  })

  it('two payments prepared together, each under the amount: no more than the amount goes without a wait', async () => {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    // both prepared before either is approved, so neither's terms carry a wait
    const p1 = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 600_000 })
    const p2 = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 600_000 })
    for (const pv of [p1, p2]) expect((JSON.parse(pv.document) as { action: { params: PaymentParams } }).action.params.hold).toBeUndefined()
    for (const pv of [p1, p2]) confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const a1 = submitApprovedAction(k.ctx, k.userId, p1.approvalId), a2 = submitApprovedAction(k.ctx, k.userId, p2.approvalId)
    await settle(k)
    const states = [getAction(k.db, a1.id)!, getAction(k.db, a2.id)!]
    expect(states.filter((a) => a.state === 'done').length).toBeLessThanOrEqual(1)
    const refused = states.filter((a) => a.state === 'blocked')
    expect(refused.length).toBeGreaterThanOrEqual(1)
    for (const a of refused) expect(a.error).toMatch(/It did not wait, so it was not sent\. Review it again: its new terms will say when it is sent\.$/)
    const sent = k.db.all<{ amount: number }>('SELECT amount FROM pv_payments').reduce((t, r) => t + BigInt(r.amount), 0n)
    expect(sent).toBeLessThanOrEqual(1_000_000n)
    expect(available(k.db, k.userId, 'bank')).toBe(bank - sent)
    // prepared again, the refused one waits
    const again = await approvedPayment(k, y.id, 600_000)
    expect((JSON.parse(again.pv.document) as { action: { params: PaymentParams } }).action.params.hold).toBeDefined()
  })

  it('cancelled and prepared again, a payment waits its own full wait from its new approval, not the earlier time', async () => {
    const { k, y } = setup()
    const first = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    k.clock.advance(20 * H)
    cancelAction(k.ctx, k.userId, first.act.id)
    const second = await approvedPayment(k, y.id, 1_500_000)
    expect(untilOf(second.pv)).toBe(k.clock.now() + 24 * H)
    expect(untilOf(second.pv)).toBeGreaterThan(untilOf(first.pv))
    await stepAllActions(k.ctx)
    k.clock.set(untilOf(first.pv) + 1000)
    await settle(k)
    expect(getAction(k.db, second.act.id)!.state).toBe('held')
    expect(onRail(k)).toBe(0)
  })

  it('a clock that runs backwards never sends it early: the time it waits for is the signed one, not now plus the wait', async () => {
    const { k, y } = setup()
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    await stepAllActions(k.ctx)
    // the clock jumps back two days (a host's time corrected): still held, and its signed time is unchanged
    k.clock.set(k.clock.now() - 48 * H)
    await settle(k)
    expect(getAction(k.db, act.id)).toMatchObject({ state: 'held', params: { hold: { until: untilOf(pv) } } })
    // forward again to a second before its time: still held
    k.clock.set(untilOf(pv) - 1000)
    await stepAllActions(k.ctx)
    expect(getAction(k.db, act.id)!.state).toBe('held')
    expect(onRail(k)).toBe(0)
    // and a payee added "in the future" (the clock went back after it was added) is still new: a payment to it waits
    const z = addPayee(k.db, k.userId, { name: 'Meera Nair', handle: 'meera.nair@upi', category: 'family' }, k.clock.now() + 5 * H)
    const ahead = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: z.id, amount: 1_500_000 })
    expect((JSON.parse(ahead.document) as { action: { params: PaymentParams } }).action.params.hold).toBeDefined()
  })

  it('the engine down for days when its wait ends: sent when it next runs, its money set aside all the while; the terms say so', async () => {
    const { k, y } = setup()
    const bank = available(k.db, k.userId, 'bank')
    const { pv, act } = await approvedPayment(k, y.id, 1_500_000)
    const sentLine = (JSON.parse(pv.document) as { estimate: { label: string; note?: string }[] }).estimate.find((l) => l.label === 'Sent')
    expect(sentLine?.note).toMatch(/If QED is not running when the wait ends, it is sent when QED next runs\.$/)
    await stepAllActions(k.ctx)
    k.clock.set(untilOf(pv) + 3 * 24 * H)
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)
    await settle(k)
    expect(getAction(k.db, act.id)).toMatchObject({ state: 'done', times: { released: untilOf(pv) + 3 * 24 * H } })
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 1_500_000n)
  })
})

describe('the double-payment guard and pending states still hold', () => {
  it('while a bill\'s payment waits the bill is not offered again; cancelled, it is', async () => {
    const { k, y } = setup()
    const bill = addBill(k.db, k.userId, { payeeId: y.id, amount: 1_200_000, dueAt: k.clock.now() + 3 * 24 * H, memo: 'Deposit' }, k.clock.now())
    const terms = { kind: 'payment', purpose: 'spend', billId: bill.id, amount: 1_200_000 }
    const pv = await previewAction(k.ctx, k.userId, terms)
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const act = submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    await stepAllActions(k.ctx)
    expect(getAction(k.db, act.id)!.state).toBe('held')
    expect(billPaymentUnderWay(k.db, k.userId, bill.id)).toMatchObject({ id: act.id, state: 'held' })
    await expect(previewAction(k.ctx, k.userId, terms)).rejects.toMatchObject({ code: 'bill_payment_under_way' })
    cancelAction(k.ctx, k.userId, act.id)
    expect(billPaymentUnderWay(k.db, k.userId, bill.id)).toBeUndefined()
    expect((await previewAction(k.ctx, k.userId, terms)).approvalId).toBeTruthy()
  })

  it('once sent, a payment to a slow rail is pending with the time the rail answers by, and is not sent again', async () => {
    const k = makeKit()
    const y = addPayee(k.db, k.userId, { name: 'Slow Test Account', handle: 'slow@paper', category: 'other' }, k.clock.now())
    const { act } = await approvedPayment(k, y.id, 50_000)
    await stepAllActions(k.ctx)
    const a = getAction(k.db, act.id)!
    expect(a.state).toBe('working')
    expect(a.result).toMatchObject({ railState: 'pending', answerBy: a.times.submitted! + 120_000 })
    await stepAllActions(k.ctx)
    expect(onRail(k)).toBe(1)
  })
})
