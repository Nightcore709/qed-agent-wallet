/**
 * N-006: with the production setting QED_ADVISER_REVIEW=1, a model's investment proposal waits for a registered
 * investment adviser's review before it can be opened or signed; the reviewer's credential is not a workspace session;
 * an approval is named in the document the owner signs, a decline keeps the proposal from being signed. Without the
 * setting (this build), nothing waits and the document says that no licensed adviser reviewed it.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideReview, needsReview, requireReviewer, reviewQueue } from './adviser.ts'
import { ask, draftProposals, viaScript } from './ai.ts'
import { loadConfig } from './core.ts'
import { requestProgramApproval } from './programs.ts'
import { makeKit } from './testkit.ts'

const REPLIES = join(import.meta.dirname, '..', 'evidence', '20261122-judge-journey', 'scripted-double-replies.json')
const Q = 'Buy ₹500 of Bitcoin for me every minute, at most 2 times, and never more than ₹1,000 this month.'
const TOKEN = 'reviewer-credential-'.padEnd(48, 'x')
const ON = loadConfig({ QED_ADVISER_REVIEW: '1', QED_ADVISER_TOKEN: TOKEN })
const OK = { decision: 'approve', reviewer: 'Asha Iyer', registration: 'ina000012345', note: 'Suitable within the stated limits.' }

async function asked(cfg = ON) {
  const k = makeKit(); k.btc(6_600_000)
  const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: Q }, viaScript(REPLIES))
  const p = r.proposals.find((x) => x.kind === 'invest')!
  // the scripted question asks for a run every minute within ₹1,000 a month: the owner accepts that contradiction
  const doc = (programId: string): { drafted?: string } => JSON.parse(requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit']).draft.document) as { drafted?: string }
  return { k, p, doc }
}

describe('a registered adviser reviews a model\'s investment proposals (N-006, production setting)', () => {
  it('without the setting nothing waits, and the signed document says no licensed adviser reviewed it', async () => {
    const { k, p, doc } = await asked(loadConfig({}))
    expect(p.state).toBe('new')
    const d = draftProposals(k.ctx, k.userId, [p.id])
    expect(doc(d.drafted[0]!.programId).drafted).toMatch(/No licensed adviser reviewed it\.$/)
    expect(() => requireReviewer(loadConfig({}), TOKEN)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('with it, the proposal waits: it cannot be opened as a draft, and the reviewer reads its terms, not the owner\'s question', async () => {
    const { k, p } = await asked()
    expect(p.state).toBe('review')
    expect(draftProposals(k.ctx, k.userId, [p.id]).skipped).toEqual([{ proposalId: p.id, reason: 'It is waiting for a registered investment adviser\'s review.' }])
    const [item] = reviewQueue(k.db)
    expect(item).toMatchObject({ proposalId: p.id, kind: 'invest' })
    expect(JSON.stringify(item)).not.toContain('every minute, at most 2 times')
    expect(needsReview(ON, 'model', 'bills')).toBe(false) // paying one's own bills is not investment advice
    expect(needsReview(ON, 'model', 'split')).toBe(true) // a split can send income into a fund or a digital asset (review finding 1)
    expect(needsReview(ON, 'rules', 'invest')).toBe(false) // QED's own rule-based suggestions are not a model's
  })

  it('only the reviewer\'s credential opens the queue', () => {
    expect(() => requireReviewer(ON, undefined)).toThrow(expect.objectContaining({ code: 'reviewer_only' }))
    expect(() => requireReviewer(ON, `${TOKEN}y`)).toThrow(expect.objectContaining({ code: 'reviewer_only' }))
    expect(() => requireReviewer(loadConfig({ QED_ADVISER_REVIEW: '1', QED_ADVISER_TOKEN: 'short' }), 'short')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => requireReviewer(ON, TOKEN)).not.toThrow()
  })

  it('an approval with a registration opens it for signing, and the signed document names the reviewer', async () => {
    const { k, p, doc } = await asked()
    expect(() => decideReview(k.db, p.id, { ...OK, registration: 'ARN-12345' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(decideReview(k.db, p.id, OK, k.clock.now())).toEqual({ proposalId: p.id, state: 'approved' })
    expect(() => decideReview(k.db, p.id, OK, k.clock.now())).toThrow(expect.objectContaining({ code: 'already_decided' }))
    const d = draftProposals(k.ctx, k.userId, [p.id])
    expect(d.drafted).toHaveLength(1)
    expect(doc(d.drafted[0]!.programId).drafted).toMatch(/A registered investment adviser, Asha Iyer, who gave SEBI registration INA000012345 \(QED has not checked it against SEBI's register\), reviewed what this buys and how much on \d{4}-\d\d-\d\d: "Suitable within the stated limits\."/)
  })

  it('a review is named only over the terms the adviser saw: changed terms say no adviser reviewed them (review finding 2)', async () => {
    const { k, p, doc } = await asked()
    decideReview(k.db, p.id, OK, k.clock.now())
    const d = draftProposals(k.ctx, k.userId, [p.id])
    const programId = d.drafted[0]!.programId
    // the owner changes the amount in the editor before signing
    const v = k.db.get<{ version: number; params_json: string }>('SELECT version, params_json FROM program_versions WHERE program_id = ? ORDER BY version DESC LIMIT 1', programId)!
    const params = { ...(JSON.parse(v.params_json) as Record<string, unknown>), amount: 40_000 }
    k.db.run('UPDATE program_versions SET params_json = ? WHERE program_id = ? AND version = ?', JSON.stringify(params), programId, v.version)
    expect(doc(programId).drafted).toMatch(/reviewed an earlier version of this proposal on \d{4}-\d\d-\d\d; the terms signed here differ from what they reviewed, so no licensed adviser reviewed them\.$/)
  })

  it('the queue lists only proposals still waiting, and a model proposal made before the setting was on is held when drafted (review finding 6)', async () => {
    const { k, p } = await asked(loadConfig({}))
    expect(p.state).toBe('new')
    expect(draftProposals(k.ctx, k.userId, [p.id], ON).skipped).toEqual([{ proposalId: p.id, reason: 'It is waiting for a registered investment adviser\'s review.' }])
    expect(reviewQueue(k.db).map((x) => x.proposalId)).toEqual([p.id])
    k.db.run(`UPDATE proposals SET state = 'dismissed' WHERE id = ?`, p.id)
    expect(reviewQueue(k.db)).toEqual([])
  })

  it('a decline needs a reason, and the proposal can then never be drafted or signed', async () => {
    const { k, p } = await asked()
    expect(() => decideReview(k.db, p.id, { ...OK, decision: 'decline', note: '' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    decideReview(k.db, p.id, { ...OK, decision: 'decline', note: 'Too concentrated for this household.' }, k.clock.now())
    const row = k.db.get<{ state: string; invalid_reason: string }>('SELECT state, invalid_reason FROM proposals WHERE id = ?', p.id)!
    expect(row).toEqual({ state: 'declined', invalid_reason: 'Declined by Asha Iyer (SEBI registration INA000012345): Too concentrated for this household.' })
    expect(draftProposals(k.ctx, k.userId, [p.id]).skipped[0]!.reason).toBe('It is declined by a registered investment adviser.')
  })
})
