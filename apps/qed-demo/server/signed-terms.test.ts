/**
 * A standing instruction runs only on the terms its owner signed (RISK-064, R7-072). The API writes a version's
 * parameters and authority together with the signed document, but the engine reads the stored parameters; if they
 * ever differ from the document (a database edited behind the API), nothing may run under them. The runner compares
 * them with the signed document every time it loads the version.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateProgram, loadProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { runTick, schedulerTick } from './runner.ts'
import { makeKit } from './testkit.ts'

const DAY = 86_400_000

function signed(edit?: (k: ReturnType<typeof makeKit>, programId: string) => void) {
  const k = makeKit()
  k.btc(6_600_000)
  const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 30 * DAY } })
  const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
  edit?.(k, d.programId)
  // the next run falls due (just after its time, so it is due, not missed)
  const due = loadProgram(k.db, k.userId, d.programId).next_due_at!
  k.clock.advance(due - k.clock.now() + 1000)
  for (let i = 0; i < 3; i++) { schedulerTick(k.ctx); runTick(k.ctx); k.clock.advance(1000) }
  const runs = k.db.all<{ state: string; reason: string | null }>('SELECT state, reason FROM runs WHERE program_id = ?', d.programId)
  const orders = k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE kind = 'order'`)!.n
  const notices = k.db.all<{ kind: string }>('SELECT kind FROM notices WHERE user_id = ?', k.userId).map((n) => n.kind)
  return { runs, orders, notices }
}

describe('a standing instruction runs only on the terms its owner signed (RISK-064)', () => {
  it('unchanged, its run goes ahead (the control)', () => {
    const r = signed()
    expect(r.runs.length).toBe(1)
    expect(r.runs[0]!.state).not.toBe('cancelled')
    expect(r.notices).not.toContain('program-terms-differ')
  })

  it.each([
    ['the amount', (k: ReturnType<typeof makeKit>, id: string) => k.db.run(`UPDATE program_versions SET params_json = json_set(params_json, '$.amount', 900000) WHERE program_id = ?`, id)],
    ['the authority', (k: ReturnType<typeof makeKit>, id: string) => k.db.run(`UPDATE program_versions SET authority_json = json_set(authority_json, '$.maxPerRun', 99000000) WHERE program_id = ?`, id)],
  ])('stored %s changed behind the API: nothing runs, nothing is ordered, and the owner is told', (_, edit) => {
    const r = signed(edit)
    expect(r.orders).toBe(0)
    expect(r.runs.every((x) => x.state === 'cancelled' && /differ from the document you signed/.test(x.reason ?? ''))).toBe(true)
    expect(r.notices).toContain('program-terms-differ')
  })
})
