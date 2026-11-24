/**
 * Keeping a request open (server/approvals.ts renewTtl and renewApproval; WCAG 2.2.1; R12 task comparison, gap 10).
 * Before a request lapses the person may ask for the same terms again: a fresh request for the very same document,
 * so the same fingerprint, which replaces the first; a signature over the first covers nothing once it is replaced.
 * Not where the time is part of the terms (a quote, a run's deadline, the chain's terms, several signers), and never
 * after the request has lapsed, been confirmed or been withdrawn.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval, createApproval, DEFAULT_TTL_MS, getApproval, RENEW_FOR_AT_MOST_MS, renewable, renewApproval, renewTtl } from './approvals.ts'
import { actor } from './workspaces.ts'
import { previewAction, submitApprovedAction } from './owner.ts'
import { makeKit } from './testkit.ts'

const MIN = 60_000
/** When the first request of a test's payment was prepared: the kit's start. */
const T0START = (k: ReturnType<typeof makeKit>) => k.db.get<{ t: number }>('SELECT MIN(created_at) t FROM approvals')!.t

function payment() {
  const k = makeKit()
  k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_m', k.userId, 'Meera Nair', 'meera.nair@upi', 'other', k.clock.now(), k.clock.now())
  return k
}

describe('keeping a request open', () => {
  it('gives the same document a fresh request for the usual time, replaces the first, and the payment goes through on the fresh one', async () => {
    const k = payment()
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 150_000, purpose: 'spend', payeeId: 'pay_m' })
    // offered from the start (the sheet shows it two minutes before the lapse), though renewing at once would add nothing
    expect(renewable(k.db, getApproval(k.db, k.userId, pv.approvalId)!, k.clock.now())).toBe(true)
    expect(renewTtl(k.db, getApproval(k.db, k.userId, pv.approvalId)!, k.clock.now())).toBeNull()
    k.clock.advance(8 * MIN + 30_000)
    const first = getApproval(k.db, k.userId, pv.approvalId)!
    expect(renewTtl(k.db, first, k.clock.now())).toBe(DEFAULT_TTL_MS)
    const fresh = renewApproval(k.db, k.userId, pv.approvalId, k.clock.now())
    expect(fresh.id).not.toBe(pv.approvalId)
    expect(fresh.doc_hash).toBe(pv.docHash)
    expect(fresh.document).toBe(pv.document)
    expect(fresh.expires_at).toBe(k.clock.now() + DEFAULT_TTL_MS)
    expect(fresh.requires_stepup).toBe(first.requires_stepup)
    // the first is withdrawn: confirming it is refused, so a signature over it covers nothing
    expect(getApproval(k.db, k.userId, pv.approvalId)!.cancelled_at).not.toBeNull()
    expect(() => confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())).toThrow(/replaced or withdrawn/)
    // past the first one's lapse, the fresh one is confirmed and the payment is made from the same document
    k.clock.advance(3 * MIN)
    confirmApproval(k.db, k.userId, fresh.id, { method: 'passkey', docHash: fresh.doc_hash }, k.clock.now())
    const act = submitApprovedAction(k.ctx, k.userId, fresh.id)
    expect(act.kind).toBe('payment')
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit WHERE action = 'approval.renew' AND subject = ?", fresh.id)!.n).toBe(1)
  })

  it('can be done again and again, each time on the request in force, up to an hour after the terms were first prepared; then they are prepared again (review M2: the figures shown are part of the terms)', async () => {
    const k = payment()
    let id = (await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 50_000, purpose: 'spend', payeeId: 'pay_m' })).approvalId
    for (let i = 0; i < 6; i++) { k.clock.advance(9 * MIN); id = renewApproval(k.db, k.userId, id, k.clock.now()).id }
    expect(getApproval(k.db, k.userId, id)!.cancelled_at).toBeNull()
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals WHERE cancelled_at IS NULL AND confirmed_at IS NULL')!.n).toBe(1)
    // 54 minutes in, the last renewal reached the hour exactly; at 58 minutes, before it lapses, nothing is left to give
    expect(getApproval(k.db, k.userId, id)!.expires_at).toBe(T0START(k) + RENEW_FOR_AT_MOST_MS)
    k.clock.advance(4 * MIN)
    expect(renewable(k.db, getApproval(k.db, k.userId, id)!, k.clock.now())).toBe(false)
    expect(() => renewApproval(k.db, k.userId, id, k.clock.now())).toThrow(/cannot be kept open longer/)
  })

  it('counts the hour from the unbroken run of identical requests, not from one that lapsed long ago (QA hand-back)', () => {
    const k = makeKit()
    const make = () => createApproval(k.db, k.userId, { purpose: 'action', subject: 'action:same', document: JSON.stringify({ action: { kind: 'payment', params: { amount: '50000' } } }) }, k.clock.now())
    const lapsed = make()
    k.clock.advance(3 * 60 * MIN)   // three hours later the first lapsed long ago
    expect(lapsed.expires_at).toBeLessThan(k.clock.now())
    const again = make()
    expect(again.doc_hash).toBe(lapsed.doc_hash)
    k.clock.advance(8 * MIN + 30_000)
    // an hour from the request now in force, not from the one three hours before
    expect(renewTtl(k.db, getApproval(k.db, k.userId, again.id)!, k.clock.now())).toBe(DEFAULT_TTL_MS)
    const fresh = renewApproval(k.db, k.userId, again.id, k.clock.now())
    expect(fresh.expires_at).toBe(k.clock.now() + DEFAULT_TTL_MS)
    // and the run still ends an hour after the request in force was first prepared
    k.clock.advance(50 * MIN)
    expect(renewTtl(k.db, getApproval(k.db, k.userId, fresh.id)!, k.clock.now())).toBeNull()
  })

  it('is not offered for terms whose figures were shown at a moment: a fund order (its NAV day), or one that accepted going below the floor or into what must stay (review M2)', () => {
    const k = makeKit()
    const now = k.clock.now()
    const fund = createApproval(k.db, k.userId, { purpose: 'action', subject: 'action:f', document: JSON.stringify({ action: { kind: 'order', venue: 'x', params: { instrumentId: 'amfi:120716', side: 'buy', amount: '50000' } } }) }, now)
    const waiver = createApproval(k.db, k.userId, { purpose: 'action', subject: 'action:w', document: JSON.stringify({ acknowledged: { belowFloor: false, intoReserve: true } }) }, now)
    for (const a of [fund, waiver]) {
      expect(renewable(k.db, a, now)).toBe(false)
      expect(() => renewApproval(k.db, k.userId, a.id, now + 8 * MIN)).toThrow(/cannot be kept open longer/)
    }
  })

  it('is for whoever prepared it, and only while it needs one signature under the workspace\'s policy as it stands (review M3)', async () => {
    const k = payment()
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 50_000, purpose: 'spend', payeeId: 'pay_m' })
    k.db.run('UPDATE approvals SET created_by = ? WHERE id = ?', 'per_maker', pv.approvalId)
    k.clock.advance(8 * MIN)
    expect(() => actor.run({ personId: 'per_checker', workspaceId: k.userId, role: 'owner' }, () => renewApproval(k.db, k.userId, pv.approvalId, k.clock.now()))).toThrow(/Only the member who prepared/)
    const mine = actor.run({ personId: 'per_maker', workspaceId: k.userId, role: 'owner' }, () => renewApproval(k.db, k.userId, pv.approvalId, k.clock.now()))
    expect(mine.created_by).toBe('per_maker')
    // the workspace now asks two members to sign everything: keeping the old request open would escape that
    k.db.run(`UPDATE users SET kind = 'business', policy_json = ? WHERE id = ?`, JSON.stringify({ signers: 2 }), k.userId)
    k.clock.advance(8 * MIN)
    expect(() => actor.run({ personId: 'per_maker', workspaceId: k.userId, role: 'owner' }, () => renewApproval(k.db, k.userId, mine.id, k.clock.now()))).toThrow(/needs more than one signature/)
  })

  it('is refused once the request has lapsed, been confirmed or been withdrawn', async () => {
    const k = payment()
    const a = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 50_000, purpose: 'spend', payeeId: 'pay_m' })
    k.clock.advance(DEFAULT_TTL_MS + 1)
    expect(() => renewApproval(k.db, k.userId, a.approvalId, k.clock.now())).toThrow(/expired/)
    const b = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 60_000, purpose: 'spend', payeeId: 'pay_m' })
    confirmApproval(k.db, k.userId, b.approvalId, { method: 'passkey', docHash: b.docHash }, k.clock.now())
    expect(() => renewApproval(k.db, k.userId, b.approvalId, k.clock.now())).toThrow(/already confirmed/)
    const c = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 70_000, purpose: 'spend', payeeId: 'pay_m' })
    k.db.run('UPDATE approvals SET cancelled_at = ? WHERE id = ?', k.clock.now(), c.approvalId)
    expect(() => renewApproval(k.db, k.userId, c.approvalId, k.clock.now())).toThrow(/replaced or withdrawn/)
    expect(() => renewApproval(k.db, k.userId, 'apr_nonexistent', k.clock.now())).toThrow(/not found/)
  })

  it('is not offered where the time is part of the terms: a quote, the chain, several signers', () => {
    const k = makeKit()
    const now = k.clock.now()
    const quoted = createApproval(k.db, k.userId, { purpose: 'action', subject: 'action:q', document: JSON.stringify({ quote: { validUntil: now + MIN } }), ttlMs: MIN }, now)
    const chain = createApproval(k.db, k.userId, { purpose: 'rail', subject: 'rail:1', document: '{}' }, now)
    const several = createApproval(k.db, k.userId, { purpose: 'action', subject: 'action:s', document: '{}', required: 2 }, now)
    for (const a of [quoted, chain, several]) {
      expect(renewable(k.db, a, now)).toBe(false)
      expect(renewTtl(k.db, a, now + 8 * MIN)).toBeNull()
      expect(() => renewApproval(k.db, k.userId, a.id, now)).toThrow(/cannot be kept open longer/)
    }
  })

  it('keeps a run inside its deadline, and is not offered when that gives less than a minute more', () => {
    const k = makeKit()
    const now = k.clock.now()
    k.db.exec('PRAGMA foreign_keys = OFF') // a run row alone, without its instruction
    const run = (id: string, deadline: number) => k.db.run(`INSERT INTO runs (id, program_id, user_id, version, occurrence, state, decision_json, due_at, created_at, deadline_at) VALUES (?, 'prg_x', ?, 1, ?, 'awaiting_approval', '{}', ?, ?, ?)`, id, k.userId, id, now, now, deadline)
    run('run_far', now + 24 * 3600_000)
    run('run_near', now + 5 * MIN)
    run('run_over', now + 24 * 3600_000)
    const far = createApproval(k.db, k.userId, { purpose: 'run', subject: 'run:run_far', document: '{}' }, now)
    const near = createApproval(k.db, k.userId, { purpose: 'run', subject: 'run:run_near', document: '{}', ttlMs: 5 * MIN }, now)
    expect(renewable(k.db, far, now)).toBe(true)
    expect(renewTtl(k.db, far, now + 8 * MIN)).toBe(DEFAULT_TTL_MS)
    expect(renewable(k.db, near, now)).toBe(false)
    expect(renewTtl(k.db, near, now + 3 * MIN)).toBeNull()
    // another household's run of the same id is never read
    expect(renewTtl(k.db, { ...far, user_id: 'usr_other' }, now + 8 * MIN)).toBeNull()
    // a run that has ended (cancelled by a pause, say) is not waiting for approval: nothing to keep open (review L6)
    const over = createApproval(k.db, k.userId, { purpose: 'run', subject: 'run:run_over', document: '{}' }, now)
    k.db.run(`UPDATE runs SET state = 'cancelled' WHERE id = 'run_over'`)
    expect(renewable(k.db, over, now)).toBe(false)
  })
})
