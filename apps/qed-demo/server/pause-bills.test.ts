/**
 * While QED is paused, no bill is described as paid by QED (R7-111 F4): the runner holds every instruction, so a bill
 * an instruction would otherwise pay is the owner's to pay, and "Needs you" says so with the reason.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { clearStop, setStop } from './runner.ts'
import { makeKit } from './testkit.ts'
import { billCover } from './valuation.ts'
import { needsYou } from './views.ts'

const DAY = 86_400_000

describe('a paused QED pays no bill, and says so (R7-111 F4)', () => {
  it('a bill an instruction covers is the owner\'s while QED is paused, with the reason, and covered again once resumed', () => {
    const k = makeKit()
    const payee = 'pay_power'
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', payee, k.userId, 'City Power', 'power@upi', 'utility', k.clock.now(), k.clock.now())
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)", 'bill_1', k.userId, payee, 245_000, k.clock.now() + 2 * DAY, 'November', k.clock.now())
    const items = () => needsYou(k.db, k.userId, k.clock.now()).filter((n) => n.type === 'pay-bill')

    expect('id' in billCover(k.db, k.userId, 'power@upi', 245_000)).toBe(true)
    expect(items()).toEqual([])

    setStop(k.ctx, k.userId, 'Stopped by you', false)
    const paused = billCover(k.db, k.userId, 'power@upi', 245_000)
    expect('reason' in paused && paused.reason).toMatch(/QED is paused, so .* will not pay it until you resume QED/)
    expect(items()).toHaveLength(1)
    expect(String(items()[0]!.detail)).toMatch(/QED is paused/)

    clearStop(k.ctx, k.userId)
    expect('id' in billCover(k.db, k.userId, 'power@upi', 245_000)).toBe(true)
    expect(items()).toEqual([])
  })
})
