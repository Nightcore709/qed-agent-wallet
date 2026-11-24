/**
 * A payment by hand to a payee with a bill on record (R7-111 walkthrough F20): paying "a person or a business" does
 * not settle the bill, so the bill stays due and an instruction that pays bills would pay it again. The review says
 * so, in the document the passkey signs, and points to paying the bill itself; paying the bill says nothing of it.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { addBill, addPayee, billPaymentUnderWay, previewAction, submitApprovedAction } from './owner.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { makeKit } from './testkit.ts'
import { commitments } from './valuation.ts'

const DAY = 86_400_000

describe('a hand payment to a payee who has a bill on record (F20)', () => {
  const setup = (covered: boolean, runMode?: string) => {
    const k = makeKit()
    const power = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', nameCheckAccepted: 'unknown' }, k.clock.now())
    const bill = addBill(k.db, k.userId, { payeeId: power.id, amount: 245_000, dueAt: k.clock.now() + DAY, memo: 'November' }, k.clock.now())
    if (covered) {
      const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000, ...(runMode ? { runMode, ...(runMode === 'notify' ? { noticeSec: 3600 } : {}) } : {}) } })
      const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
      confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
      activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    }
    return { k, power, bill }
  }

  it('says the bill stays due and that the bills instruction will pay it too, in the signed document', async () => {
    // an instruction that pays after telling the owner (chosen here: since R12, gap 14, one asks each time by default)
    const { k, power } = setup(true, 'notify')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'spend', payeeId: power.id })
    const said = pv.warnings.find((w) => /bill/.test(w))
    expect(said).toMatch(/^City Power has a ₹2,450 bill on record, due /)
    expect(said).toMatch(/Paying by hand does not settle it: it stays due, and "Pay bills from 1 payee up to ₹3,000 each" will pay it when it falls due\. To settle it, pay it as "A bill on record"\./)
    expect((JSON.parse(pv.document) as { warnings: string[] }).warnings).toContain(said)
  })

  it('an instruction that asks first is said to ask, not to pay (review finding 10)', async () => {
    const { k, power } = setup(true, 'approve')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'spend', payeeId: power.id })
    expect(pv.warnings.find((w) => /bill/.test(w))).toMatch(/and "Pay bills from 1 payee up to ₹3,000 each" will ask you to approve paying it when it falls due\./)
    expect(commitments(k.db, k.userId, k.clock.now(), 14 * DAY).find((c) => c.kind === 'bill')?.by).toMatchObject({ runMode: 'approve' })
  })

  it('without an instruction, says the bill stays due', async () => {
    const { k, power } = setup(false)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 100_000, purpose: 'spend', payeeId: power.id })
    expect(pv.warnings.find((w) => /bill/.test(w))).toMatch(/Paying by hand does not settle it: it stays due\. To settle it, pay it as "A bill on record"\./)
  })

  it('paying the bill itself, or a payee with no bill, says nothing of the kind', async () => {
    const { k, power, bill } = setup(true)
    const asBill = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'spend', billId: bill.id })
    expect(asBill.warnings.filter((w) => /bill on record/.test(w))).toEqual([])
    const other = addPayee(k.db, k.userId, { name: 'Asha Rao', handle: 'asha.rao@okhdfc', category: 'family', nameCheckAccepted: 'unknown' }, k.clock.now())
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 50_000, purpose: 'spend', payeeId: other.id })
    expect(pv.warnings.filter((w) => /bill on record/.test(w))).toEqual([])
    expect(power.handle).toBe('power@upi')
  })
})

describe('one bill is paid once (R12 task comparison: ₹880 was paid twice)', () => {
  it('while a payment for a bill is under way, a second is refused at preview and at submission, and the bill says so', async () => {
    const k = makeKit()
    const power = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', nameCheckAccepted: 'unknown' }, k.clock.now())
    const bill = addBill(k.db, k.userId, { payeeId: power.id, amount: 88_000, dueAt: k.clock.now() + DAY, memo: 'November' }, k.clock.now())
    const terms = { kind: 'payment', amount: 88_000, purpose: 'bill', payeeId: power.id, billId: bill.id }
    // two sheets for the same bill, each approved: the first is sent, the second is refused when it is submitted
    const a = await previewAction(k.ctx, k.userId, terms), b = await previewAction(k.ctx, k.userId, terms)
    for (const pv of [a, b]) confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const sent = submitApprovedAction(k.ctx, k.userId, a.approvalId)
    expect(() => submitApprovedAction(k.ctx, k.userId, b.approvalId)).toThrow(/already on its way or made/)
    expect(billPaymentUnderWay(k.db, k.userId, bill.id)).toMatchObject({ id: sent.id })
    // and a third is refused before it is even prepared
    await expect(previewAction(k.ctx, k.userId, terms)).rejects.toMatchObject({ code: 'bill_payment_under_way' })
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ? AND kind = 'payment'`, k.userId)!.n).toBe(1)
    // if that payment fails, the bill is offered again
    k.db.run(`UPDATE actions SET state = 'failed' WHERE id = ?`, sent.id)
    expect(billPaymentUnderWay(k.db, k.userId, bill.id)).toBeUndefined()
    expect((await previewAction(k.ctx, k.userId, terms)).approvalId).toBeTruthy()
  })
})

describe('a payment sheet names who is paid and where, and for a bill its reference, due day and fee (R12 task comparison)', () => {
  it('opens with the payee and address, shows the bill and the fee, ends with what follows, and signs exactly those lines', async () => {
    const k = makeKit()
    const power = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', nameCheckAccepted: 'unknown' }, k.clock.now())
    const bill = addBill(k.db, k.userId, { payeeId: power.id, amount: 245_000, dueAt: k.clock.now() + DAY, memo: 'November, consumer 4471' }, k.clock.now())
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'bill', payeeId: power.id, billId: bill.id })
    expect(pv.lines[0]).toMatchObject({ label: 'To', value: 'City Power, power@upi' })
    expect(pv.lines.find((l) => l.label === 'The bill')?.value).toMatch(/^November, consumer 4471, due /)
    expect(pv.lines.find((l) => l.label === 'Fee')?.value).toBe('None')
    expect(pv.lines.at(-1)).toMatchObject({ label: 'Once you approve', value: 'It leaves your bank on paper, and the bill is marked paid when the payment settles' })
    expect((JSON.parse(pv.document) as { estimate: { label: string; value: string }[] }).estimate).toEqual(pv.lines)
  })
})
