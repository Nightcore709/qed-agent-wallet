/**
 * Revoking an instruction reaches every channel it reaches, and each channel's answer is recorded with its time; a channel
 * that does not acknowledge is never shown as revoked (audit finding S7, server/revocation.ts). The paper bank is a
 * simulated institution, made silent here; the chain is the wallet's own job report.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { LocalPaperBank, type PaperBankMandates, setPaperBank } from './bank-mandates.ts'
import { activateProgram, loadProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { chainAnswered, chainSent, retryRevocations, revocationFor, revokeEverywhere } from './revocation.ts'
import { makeKit, type Kit } from './testkit.ts'

const DAY = 86_400_000
const original = new LocalPaperBank()
afterEach(() => { setPaperBank(original) })

/** A live "pay bills" instruction with a bill waiting. */
function live(k: Kit) {
  k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_power', k.userId, 'City Power', 'power@upi', 'utility', k.clock.now(), k.clock.now())
  const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
  const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
  return d.programId
}
const silent = (): PaperBankMandates & { asked: number; answer: boolean } => {
  const b = { asked: 0, answer: false, register: (id: string) => ({ reference: `PB-MANDATE-${id.slice(-8).toUpperCase()}` }), revoke(ref: string) { b.asked++; return b.answer ? { acknowledged: true, reference: ref.replace('MANDATE', 'REVOKE') } : { acknowledged: false } } }
  return b
}

describe('revoking an instruction everywhere', () => {
  it('a bills instruction has a mandate at the paper bank from when it goes live, with the bank\'s own reference', () => {
    const k = makeKit(), id = live(k)
    expect(k.db.get<{ reference: string; state: string }>('SELECT reference, state FROM paper_mandates WHERE program_id = ?', id)).toMatchObject({ state: 'active', reference: expect.stringMatching(/^PB-MANDATE-/) })
  })

  it('every channel it reaches acknowledges, each with its own time; the program is revoked and its mandate ended', () => {
    const k = makeKit(), id = live(k)
    const r = revokeEverywhere(k.ctx, k.userId, id, false)!
    expect(r.channels.map((c) => [c.channel, c.state])).toEqual([['instruction', 'acknowledged'], ['scheduled', 'acknowledged'], ['paper-bank', 'acknowledged']])
    expect(r.complete).toBe(true)
    const bank = r.channels.find((c) => c.channel === 'paper-bank')!
    expect(bank).toMatchObject({ simulated: true, answeredAt: k.clock.now(), reference: expect.stringMatching(/^PB-REVOKE-/) })
    expect(bank.detail).toContain('simulated')
    expect(loadProgram(k.db, k.userId, id).state).toBe('revoked')
    expect(k.db.get<{ state: string; revoked_at: number }>('SELECT state, revoked_at FROM paper_mandates WHERE program_id = ?', id)).toMatchObject({ state: 'revoked', revoked_at: k.clock.now() })
  })

  it('a bank that does not answer is shown as not answering, never as revoked, and is asked again until it does', () => {
    const k = makeKit(), id = live(k), bank = silent()
    setPaperBank(bank)
    const r = revokeEverywhere(k.ctx, k.userId, id, false)!
    expect(r.complete).toBe(false)
    expect(r.channels.find((c) => c.channel === 'paper-bank')).toMatchObject({ state: 'no-answer', answeredAt: null, reference: null })
    expect(r.channels.find((c) => c.channel === 'instruction')!.state).toBe('acknowledged') // QED's own side is revoked regardless
    expect(k.db.get<{ state: string }>('SELECT state FROM paper_mandates WHERE program_id = ?', id)!.state).toBe('active')
    // asking again is the same revocation
    revokeEverywhere(k.ctx, k.userId, id, false)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM revocations')!.n).toBe(1)
    k.clock.set(k.clock.now() + 60_000)
    expect(retryRevocations(k.ctx)).toBe(1)
    expect(revocationFor(k.db, k.userId, id)!.complete).toBe(false)
    bank.answer = true
    k.clock.set(k.clock.now() + 60_000)
    retryRevocations(k.ctx)
    const done = revocationFor(k.db, k.userId, id)!
    expect(done.complete).toBe(true)
    expect(done.channels.find((c) => c.channel === 'paper-bank')).toMatchObject({ state: 'acknowledged', answeredAt: k.clock.now() })
    expect(retryRevocations(k.ctx)).toBe(0)
  })

  it('scheduled work is cancelled and counted: a run waiting to start', () => {
    const k = makeKit(), id = live(k)
    k.db.run(`INSERT INTO runs (id, user_id, program_id, version, occurrence, state, due_at, created_at) VALUES ('run_1', ?, ?, 1, 'o1', 'due', ?, ?)`, k.userId, id, k.clock.now() + DAY, k.clock.now())
    const r = revokeEverywhere(k.ctx, k.userId, id, false)!
    expect(r.channels.find((c) => c.channel === 'scheduled')!.detail).toMatch(/^1 waiting run and 0 unsent payments cancelled/)
    expect(k.db.get<{ state: string }>(`SELECT state FROM runs WHERE id = 'run_1'`)!.state).toBe('cancelled')
  })

  it('with a wallet, the chain channel is needs-you, then sent, and acknowledged only when the chain\'s job is done', () => {
    const k = makeKit(), id = live(k)
    const r = revokeEverywhere(k.ctx, k.userId, id, true)!
    expect(r.channels.find((c) => c.channel === 'chain')).toMatchObject({ state: 'needs-you', answeredAt: null })
    expect(r.complete).toBe(false)
    expect(chainSent(k.db, k.userId, 'job_1234abcd', k.clock.now())).toBe(1)
    expect(revocationFor(k.db, k.userId, id)!.channels.find((c) => c.channel === 'chain')).toMatchObject({ state: 'sent', reference: 'job_1234abcd', answeredAt: null })
    expect(chainAnswered(k.db, k.userId, { id: 'job_1234abcd', status: 'running' }, k.clock.now())).toBe(0)
    expect(chainAnswered(k.db, k.userId, { id: 'job_1234abcd', status: 'failed' }, k.clock.now())).toBe(1)
    expect(revocationFor(k.db, k.userId, id)!.channels.find((c) => c.channel === 'chain')!.state).toBe('needs-you')
    chainSent(k.db, k.userId, 'job_5678efgh', k.clock.now())
    k.clock.set(k.clock.now() + 5000)
    expect(chainAnswered(k.db, k.userId, { id: 'job_5678efgh', status: 'done' }, k.clock.now())).toBe(1)
    const c = revocationFor(k.db, k.userId, id)!.channels.find((x) => x.channel === 'chain')!
    expect(c).toMatchObject({ state: 'acknowledged', answeredAt: k.clock.now() })
    expect(revocationFor(k.db, k.userId, id)!.complete).toBe(true)
  })

  it('reaches no channel it does not have: no wallet means no chain row, and an instruction without a mandate has no bank row', () => {
    const k = makeKit()
    const d = saveDraft(k.ctx, k.userId, { kind: 'floor', params: { }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 100_000, maxPerMonth: 1_000_000 } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    expect(revokeEverywhere(k.ctx, k.userId, d.programId, false)!.channels.map((c) => c.channel)).toEqual(['instruction', 'scheduled'])
  })

  it('a draft, or an instruction revoked before revocations were recorded, is revoked as before and has no record', () => {
    const k = makeKit()
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_power', k.userId, 'City Power', 'power@upi', 'utility', k.clock.now(), k.clock.now())
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    expect(revokeEverywhere(k.ctx, k.userId, d.programId, false)).toBeNull()
    expect(loadProgram(k.db, k.userId, d.programId).state).toBe('revoked')
  })
})
