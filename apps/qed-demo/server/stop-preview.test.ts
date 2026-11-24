/**
 * What the pause sheet says pausing changes in the next two weeks (server/stop-preview.ts; R12 task comparison T6-b):
 * the runs and the bills QED would not carry out, and what happens anyway: the bank's own loan instalments, and bills
 * no instruction pays.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { stopPreview } from './stop-preview.ts'
import { makeKit } from './testkit.ts'

const DAY = 86_400_000

describe('what pausing changes', () => {
  it('names the runs and covered bills that will not happen, and the instalments and unpaid bills that happen anyway', () => {
    const k = makeKit(); k.btc(6_600_000)
    const now = k.clock.now()
    const sign = (draft: Parameters<typeof saveDraft>[2]) => {
      const d = saveDraft(k.ctx, k.userId, draft)
      const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
      confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, now)
      activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    }
    const payee = (id: string, name: string, handle: string) => k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, name, handle, 'utilities', now, now)
    payee('pay_power', 'City Power', 'citypower@upi')
    payee('pay_school', 'Green School', 'school@upi')
    const bill = (id: string, payeeId: string, amount: number, inDays: number) => k.db.run(`INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, '', 'due', ?)`, id, k.userId, payeeId, amount, now + inDays * DAY, now)
    bill('bil_power', 'pay_power', 240_000, 5)
    bill('bil_school', 'pay_school', 1_500_000, 9)
    bill('bil_later', 'pay_power', 240_000, 20) // past the two weeks: not named
    sign({ kind: 'bills', params: { payeeHandles: ['citypower@upi'], capPerBill: 300_000 }, authority: { expiresAt: now + 60 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000, runMode: 'auto' } })
    sign({ kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 30_000, schedule: { type: 'every', minutes: 1440 } }, authority: { expiresAt: now + 30 * DAY, maxPerRun: 30_000, maxPerMonth: 1_000_000, runMode: 'approve' } })
    sign({ kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: now + 30 * DAY, maxPerRun: 20_000, maxPerMonth: 1_000_000, runMode: 'auto' } })

    const p = stopPreview(k.db, k.userId, now)
    expect(p.horizonDays).toBe(14)
    // the bills instruction would pay City Power's bill; the investing instruction asks first, so it is not asked for
    expect(p.skipped).toContainEqual(expect.objectContaining({ label: 'City Power', amount: 240_000, why: expect.stringMatching(/does not pay it while paused$/) }))
    expect(p.skipped.some((s) => s.why === 'Not asked for while paused')).toBe(true)
    // every occurrence in the two weeks, not only the next (review L2): a daily one runs 14 times in them
    expect(p.skipped.filter((s) => s.amount === 20_000 && s.why === 'Does not run while paused').length).toBeGreaterThanOrEqual(14)
    // the school's bill: no instruction names its payee, so it is the household's to pay, paused or not
    expect(p.yours).toContainEqual(expect.objectContaining({ label: 'Green School', amount: 1_500_000, why: 'No instruction pays it, paused or not' }))
    // the default household's two loan instalments fall in the two weeks only if day 5 does; when they do, the bank takes them
    for (const c of p.continues.filter((x) => /instalment/.test(x.label))) expect(c.why).toBe('Your bank takes it whether QED is paused or not')
    expect([...p.skipped, ...p.yours, ...p.continues].every((x) => x.dueAt <= now + 14 * DAY)).toBe(true)
    expect([...p.skipped, ...p.yours, ...p.continues].filter((x) => x.label === 'City Power')).toHaveLength(1)
  })

  it('says nothing for a household with nothing due and nothing signed', () => {
    const k = makeKit({ profile: { personalLoanEmi: 0, homeLoanEmi: 0 } })
    expect(stopPreview(k.db, k.userId, k.clock.now())).toEqual({ skipped: [], yours: [], continues: [], horizonDays: 14 })
  })
})
