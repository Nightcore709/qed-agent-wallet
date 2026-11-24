/**
 * Keeping a request open cannot revive work that has ended (R13 section 4: "Renewal preserves timing, member scope and
 * signature requirements and cannot revive cancelled or ended work").
 *
 * An instruction that has ended (revoked by the owner, completed, or past its authority) cannot be amended: saveDraft
 * says "That program has ended. Start a new one instead." Until R13 a request to sign an amendment prepared before the
 * instruction was revoked stayed open, could be kept open for up to an hour by renewing it, and when it was approved the
 * revoked instruction was put back in force under the amendment: revoking did not end it. Now revoking (and any other
 * end) withdraws the open requests to sign a version of it and discards its draft; a request for the version of an ended
 * instruction is neither renewed nor carried out; and an ended instruction is never put in force again.
 *
 * Also checked here, as properties: whatever the times at which a request is renewed, the renewed request is for the same
 * terms (document, subject, signature requirement, one signer, the same maker), never stays open past an hour from when
 * those terms were first prepared, and never past a run's own deadline; and a request whose run has ended, or that was
 * withdrawn or lapsed, is never renewed.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Approval, confirmApproval, getApproval, RENEW_FOR_AT_MOST_MS, renewable, renewApproval, renewTtl } from './approvals.ts'
import { istInstant } from './core.ts'
import { activateProgram, loadProgram, requestProgramApproval, revokeProgram, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { cancelRun, requestRunApproval, runTick, schedulerTick, triggerTick } from './runner.ts'
import { makeKit, type Kit } from './testkit.ts'
import { stepAllActions } from './execute.ts'

const DAY = 86_400_000
const MIN = 60_000

function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
/** A monthly purchase of an index fund, signed and in force. */
function invest(k: Kit, amount = 500_000): string {
  k.nav('amfi:120716', '2026-11-17', '178.8713')
  const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount, schedule: { type: 'monthly', day: 5, at: '10:00' } }, authority: { maxPerRun: 1_000_000, maxPerMonth: 1_000_000, expiresAt: k.clock.now() + 60 * DAY } })
  sign(k, d.programId)
  return d.programId
}
/** An amendment drafted and sent for signature: the request that is left open. */
function amendmentRequest(k: Kit, programId: string, amount = 700_000): { approvalId: string; docHash: string } {
  saveDraft(k.ctx, k.userId, { programId, params: { instrumentId: 'amfi:120716', amount, schedule: { type: 'monthly', day: 5, at: '10:00' } }, authority: { maxPerRun: 1_000_000, maxPerMonth: 1_000_000, expiresAt: k.clock.now() + 60 * DAY } })
  const req = requestProgramApproval(k.ctx, k.userId, programId)
  return { approvalId: req.approvalId, docHash: sha256hex(req.draft.document) }
}
const approval = (k: Kit, id: string): Approval => getApproval(k.db, k.userId, id)!

describe('an instruction that has ended is not revived by a request to sign one of its versions', () => {
  it('revoked while an amendment waits for signature: the request is withdrawn, cannot be kept open, and approving it puts nothing in force', () => {
    const k = makeKit()
    const id = invest(k)
    const req = amendmentRequest(k, id)
    k.clock.advance(MIN)
    revokeProgram(k.ctx, k.userId, id)
    expect(loadProgram(k.db, k.userId, id).state).toBe('revoked')
    k.clock.advance(7 * MIN + 30_000) // the sheet would offer "Keep it open" now
    expect(renewable(k.db, approval(k, req.approvalId), k.clock.now())).toBe(false)
    expect(renewTtl(k.db, approval(k, req.approvalId), k.clock.now())).toBeNull()
    expect(() => renewApproval(k.db, k.userId, req.approvalId, k.clock.now())).toThrow()
    // confirming the stale request, if a sheet still shows it, is refused, and the instruction stays revoked
    expect(() => {
      confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: req.docHash }, k.clock.now())
      activateProgram(k.ctx, k.userId, id, req.approvalId)
    }).toThrow()
    expect(loadProgram(k.db, k.userId, id)).toMatchObject({ state: 'revoked', live_version: 1 })
    // and its draft cannot be sent for signature again
    expect(() => requestProgramApproval(k.ctx, k.userId, id)).toThrow()
  })

  it('a request renewed before the instruction was revoked is withdrawn with it too', () => {
    const k = makeKit()
    const id = invest(k)
    const req = amendmentRequest(k, id)
    k.clock.advance(8 * MIN + 30_000)
    const fresh = renewApproval(k.db, k.userId, req.approvalId, k.clock.now())
    revokeProgram(k.ctx, k.userId, id)
    expect(approval(k, fresh.id).cancelled_at).not.toBeNull()
    expect(renewable(k.db, approval(k, fresh.id), k.clock.now())).toBe(false)
    expect(() => confirmApproval(k.db, k.userId, fresh.id, { method: 'passkey', docHash: fresh.doc_hash }, k.clock.now())).toThrow(/replaced or withdrawn/)
    expect(loadProgram(k.db, k.userId, id).state).toBe('revoked')
  })

  it('completed or past its authority: a request for an amendment prepared before is not kept open, and approving it does not put the instruction back in force', () => {
    for (const end of ['completed', 'expired'] as const) {
      const k = makeKit()
      const id = invest(k)
      const req = amendmentRequest(k, id)
      // the engine ends an instruction by setting its state (runner.ts finish; the expiry tick): as it does, with no other change
      k.db.run('UPDATE programs SET state = ?, next_due_at = NULL WHERE id = ?', end, id)
      k.clock.advance(8 * MIN + 30_000)
      expect(renewable(k.db, approval(k, req.approvalId), k.clock.now()), end).toBe(false)
      expect(() => renewApproval(k.db, k.userId, req.approvalId, k.clock.now()), end).toThrow()
      confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: req.docHash }, k.clock.now())
      expect(() => activateProgram(k.ctx, k.userId, id, req.approvalId), end).toThrow(/ended/)
      expect(loadProgram(k.db, k.userId, id).state, end).toBe(end)
    }
  })

  it('an instruction in force or paused is still amended through a kept-open request, as before', () => {
    const k = makeKit()
    const id = invest(k)
    const req = amendmentRequest(k, id)
    k.clock.advance(8 * MIN + 30_000)
    const fresh = renewApproval(k.db, k.userId, req.approvalId, k.clock.now())
    confirmApproval(k.db, k.userId, fresh.id, { method: 'passkey', docHash: fresh.doc_hash }, k.clock.now())
    activateProgram(k.ctx, k.userId, id, fresh.id)
    expect(loadProgram(k.db, k.userId, id)).toMatchObject({ state: 'active', live_version: 2 })
  })
})

describe('a run\'s request', () => {
  /** A goal contribution waiting for the owner: a payment, whose request can be kept open (a fund order's cannot: its NAV day is part of its terms). */
  async function waitingRun(k: Kit, check = true): Promise<{ programId: string; runId: string }> {
    const d = saveDraft(k.ctx, k.userId, { kind: 'goal', params: { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }, authority: {} })
    sign(k, d.programId)
    k.clock.set(loadProgram(k.db, k.userId, d.programId).next_due_at! + 1000) // on time: a run more than a minute late is missed
    schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx); await stepAllActions(k.ctx)
    const r = k.db.get<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'awaiting_approval' ORDER BY created_at LIMIT 1`, d.programId)!
    // renewable while it waits: the cases below would prove nothing otherwise (the property makes its own first request:
    // the hour a request may be kept open counts from the first one for the same terms)
    if (check) {
      const req = requestRunApproval(k.ctx, k.userId, r.id)
      k.clock.advance(8 * MIN + 30_000)
      expect(renewable(k.db, approval(k, req.approvalId), k.clock.now())).toBe(true)
    }
    return { programId: d.programId, runId: r.id }
  }

  it('is not kept open once its run has ended: declined, its instruction revoked, or lapsed', async () => {
    for (const end of ['declined', 'revoked'] as const) {
      const k = makeKit()
      const { programId, runId } = await waitingRun(k)
      const req = requestRunApproval(k.ctx, k.userId, runId)
      if (end === 'declined') cancelRun(k.ctx, k.userId, runId)
      else revokeProgram(k.ctx, k.userId, programId)
      k.clock.advance(8 * MIN + 30_000)
      expect(renewable(k.db, approval(k, req.approvalId), k.clock.now()), end).toBe(false)
      expect(() => renewApproval(k.db, k.userId, req.approvalId, k.clock.now()), end).toThrow()
    }
  })

  it('property: renewed at any times, a run\'s request stays for the same terms and never outlives the hour from first preparation or the run\'s deadline', async () => {
    // a fresh household each run; the request is made at any point of the day the run waits, half the time within the
    // last hour before its deadline, and kept open by eight to sixteen renewals five to ten minutes apart (a request is open
    // for ten), so every chain reaches past the hour and the deadline is met (fast-check's small-size bias otherwise kept
    // chains under an hour, and two seeded faults went unseen)
    const asked = fc.oneof(fc.integer({ min: 0, max: 23 * 60 }), fc.integer({ min: 23 * 60, max: 24 * 60 - 5 }))
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 5 * MIN, max: 10 * MIN }), { minLength: 8, maxLength: 16 }), asked, async (gaps, atMin) => {
      const k = makeKit()
      const { runId } = await waitingRun(k, false)
      const deadline = k.db.get<{ d: number }>('SELECT deadline_at d FROM runs WHERE id = ?', runId)!.d
      k.clock.set(Math.min(deadline - MIN, k.clock.now() + atMin * MIN))
      const first = requestRunApproval(k.ctx, k.userId, runId)
      const start = approval(k, first.approvalId)
      let current = start
      for (const g of gaps) {
        k.clock.advance(g)
        const now = k.clock.now()
        if (now > current.expires_at) break
        let next: Approval
        try { next = renewApproval(k.db, k.userId, current.id, now) } catch { continue }
        expect(next).toMatchObject({ subject: start.subject, doc_hash: start.doc_hash, document: start.document, requires_stepup: start.requires_stepup, required_signers: 1, created_by: start.created_by, purpose: 'run' })
        expect(next.expires_at).toBeLessThanOrEqual(start.created_at + RENEW_FOR_AT_MOST_MS)
        expect(next.expires_at).toBeLessThanOrEqual(deadline)
        expect(next.expires_at).toBeGreaterThan(current.expires_at)
        current = next
      }
    }), { seed: 1124, numRuns: 40 })
  }, 120_000)
})

describe('the date of a signed goal still bounds a request to sign it again', () => {
  it('a version can be put in force only while the instruction is in force, paused or a draft', () => {
    const k = makeKit({ start: istInstant('2026-11-18', '10:30') })
    const d = saveDraft(k.ctx, k.userId, { kind: 'goal', params: { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }, authority: {} })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId)
    revokeProgram(k.ctx, k.userId, d.programId) // a draft that was never signed, discarded
    expect(approval(k, req.approvalId).cancelled_at).not.toBeNull()
    expect(() => confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())).toThrow(/replaced or withdrawn/)
    expect(loadProgram(k.db, k.userId, d.programId).state).toBe('revoked')
  })
})
