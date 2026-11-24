/**
 * Coming up names who acts (R7-111 walkthrough F31): an investing instruction that asks first is not "QED, under your
 * instruction". The commitments carry each instruction's run mode, and the passbook's expected lines pass it on.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { makeKit } from './testkit.ts'
import { commitments } from './valuation.ts'
import { passbook } from './views.ts'

const DAY = 86_400_000

describe('Coming up says how each instruction runs (F31)', () => {
  it('an instruction that asks first is listed with its run mode', () => {
    const k = makeKit(); k.btc(6_600_000)
    const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 30_000, schedule: { type: 'every', minutes: 1440 } }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 30_000, maxPerMonth: 1_000_000, runMode: 'approve' } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    const run = commitments(k.db, k.userId, k.clock.now(), 14 * DAY).find((c) => c.kind === 'program')
    expect(run).toMatchObject({ subject: d.programId, runMode: 'approve' })
    const expected = (passbook(k.db, k.userId, k.clock.now()) as { expected: { kind: string; runMode: string | null }[] }).expected
    expect(expected.find((e) => e.kind === 'program')).toMatchObject({ runMode: 'approve' })
  })
})
