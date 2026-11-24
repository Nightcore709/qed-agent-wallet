/**
 * Paper escrow under terms both sides accepted (R13 section 2, on R12 task comparison gap 16):
 *
 *  - complete terms before commitment, bound to the record: shown with their fingerprint, accepted by both sides by that
 *    fingerprint, stored as canonical JSON with a version and a hash, append-only, never replaced on a milestone;
 *  - every period and timeout outcome a per-job choice within stated bounds, applied from the stored terms and the step
 *    that started the period, never from current settings, a cached deadline, a restart or a migration;
 *  - milestones from before terms were recorded keep their terms (no deadline, no default) until both sides agree terms;
 *  - roles: in a business workspace each step only from the member the terms name for its role;
 *  - no conflicting or duplicate payouts under racing connections and processes, interrupted settlement, late recording;
 *    funds conserved to the paisa, odd paise included.
 *
 * In-memory books with a clock the test moves (testkit.ts), and database files where connections or processes meet.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonical } from '../shared/sha256.ts'
import { type AppError, APP_ROOT, type Db, FakeClock, openDb } from './core.ts'
import { Engine } from './engine.ts'
import { acceptJobTerms, acceptTerms, addEvidence, applyDue, decide, dueMilestones, earnerStep, escrowNeeds, escrowTick, paperView, POLICY, previewProposal, previewTerms, proposeTerms, settleByAgreement, splitOf } from './escrow.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { balance } from './ledger.ts'
import { clientDecision, createJob, submitMilestone } from './owner.ts'
import { sha256hex } from './receipts.ts'
import { seedRegistry } from './registry.ts'
import { makeKit, T0 } from './testkit.ts'
import type { Ctx } from './types.ts'
import { actor } from './workspaces.ts'

const DAY = 86_400_000
const H = 3_600_000
const folders: string[] = []
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }) })
const tempDb = (): string => { const d = mkdtempSync(join(tmpdir(), 'qed-escrow-')); folders.push(d); return join(d, 'qed.db') }

/** An error's code, or 'none' when the call did not throw. */
function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) { return (e as AppError).code ?? String(e) }
  return 'none'
}
function fieldsOf(fn: () => unknown): Record<string, string> {
  try { fn() } catch (e) { return (e as AppError).fields ?? {} }
  return {}
}

interface World { db: Db; ctx: Ctx; clock: FakeClock; userId: string }
const A = 1_800_001 // an odd number of paise, so a half split has an odd paisa to place
const B = 1_200_000
const kit = (): World => { const k = makeKit(); return { db: k.db, ctx: k.ctx, clock: k.clock, userId: k.userId } }
const ctxOf = (db: Db, clock: FakeClock): Ctx => ({ db, clock }) as unknown as Ctx
/** A personal household's own file database, with its books, for tests where connections or processes meet. */
function fileWorld(userId: string): { path: string; w: World } {
  const path = tempDb(), clock = new FakeClock(T0), db = openDb(path)
  seedRegistry(db)
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, userId, userId, 'x', T0)
  openHousehold(db, userId, DEFAULT_OPENING, {}, T0)
  return { path, w: { db, ctx: ctxOf(db, clock), clock, userId } }
}

/** Open a job as the household does: read its complete terms, then accept them by their fingerprint, as earner and as client. */
function job(w: World, extra: Record<string, unknown> = {}): { jobId: string; ms: string[]; hash: string } {
  const raw = { title: 'Quarterly accounts', client: 'Lakeview Studio', milestones: [{ title: 'Books closed', amount: A }, { title: 'Filing prepared', amount: B }], ...extra }
  const { hash } = previewTerms(w.db, w.userId, raw, w.clock.now())
  const { id } = createJob(w.db, w.userId, { ...raw, termsHash: hash, accept: { earner: true, client: true } }, w.clock.now())
  return { jobId: id, ms: w.db.all<{ id: string }>('SELECT id FROM earn_milestones WHERE job_id = ? ORDER BY rowid', id).map((r) => r.id), hash }
}
/** A job as the wallet recorded it before terms were recorded: no terms, the client's money in escrow, work in each state. */
function legacyJob(w: World, states: string[]): string[] {
  const jobId = `job_legacy_${Math.random().toString(36).slice(2, 8)}`
  w.db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES (?, ?, 'Quarterly accounts for Lakeview Studio', 'Lakeview Studio', 'open', ?, '{"paperClient":true}')`, jobId, w.userId, T0 - 30 * DAY)
  return states.map((state, i) => {
    const id = `mil_legacy_${i}_${Math.random().toString(36).slice(2, 8)}`
    w.db.run('INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, evidence_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, jobId, w.userId, i === 0 ? 'Books closed for the quarter' : `Part ${i}`, i === 0 ? 1_800_000 : 100_000 + i, state, state === 'funded' ? null : 'ab'.repeat(32), T0 - 20 * DAY)
    return id
  })
}
const row = (w: World, id: string) => w.db.get<{ state: string; due_at: number | null; terms_id: string | null }>('SELECT state, due_at, terms_id FROM earn_milestones WHERE id = ?', id)!
const entries = (w: World, id: string) => w.db.all<{ seq: number; ts: number; effective_ts: number; ref: string; meta_json: string; amount_text: string }>(
  `SELECT e.seq, e.ts, e.effective_ts, e.ref, e.meta_json, p.amount_text FROM entries e JOIN postings p ON p.entry_id = e.id JOIN accounts a ON a.id = p.account_id
   WHERE e.user_id = ? AND a.code = 'bank' AND json_extract(e.meta_json, '$.milestoneId') = ? ORDER BY e.seq`, w.userId, id)
const receipts = (w: World, id: string) => w.db.all<{ body_json: string }>(`SELECT body_json FROM receipts WHERE user_id = ? AND kind = 'earning' AND subject = ? ORDER BY seq`, w.userId, id).map((r) => JSON.parse(r.body_json) as Record<string, unknown>)
const steps = (w: World, id: string) => w.db.all<{ actor: string; step: string; ts: number; person_id: string | null; detail_json: string }>('SELECT actor, step, ts, person_id, detail_json FROM earn_steps WHERE milestone_id = ? ORDER BY id', id)
const dispute = (w: World, id: string) => w.db.get<Record<string, unknown>>('SELECT * FROM earn_disputes WHERE milestone_id = ?', id)
const bank = (w: World): bigint => balance(w.db, w.userId, 'bank')
const submit = (w: World, id: string) => submitMilestone(w.db, w.userId, id, 'Trial balance and ledger export, shared with the client.', w.clock.now())
const tick = (w: World): number => escrowTick(w.ctx)
/** One side proposes terms for a milestone from before terms were recorded as the page does: read them, then propose them by their fingerprint. */
function propose(w: World, id: string, raw: Record<string, unknown>) {
  const { hash } = previewProposal(w.db, w.userId, id, raw, w.clock.now())
  return proposeTerms(w.ctx, w.userId, id, { ...raw, termsHash: hash })
}
const view = (w: World, id: string) => ((paperView(w.db, w.userId, w.clock.now()) as { jobs: { milestones: Record<string, unknown>[] }[] }).jobs.flatMap((j) => j.milestones).find((m) => m.id === id)!) as Record<string, any>

// ------------------------------------------------------------------------------------------------ terms before commitment

describe('complete terms before commitment, bound to the record', () => {
  it('the preview states every term, with the stated defaults; the job is opened only on that fingerprint, accepted by both sides, and the terms are stored exactly', () => {
    const w = kit()
    const raw = { title: 'Quarterly accounts', client: 'Lakeview Studio', milestones: [{ title: 'Books closed', amount: A }] }
    const p = previewTerms(w.db, w.userId, raw, T0)
    expect(p.terms).toEqual({
      version: 2, job: { title: 'Quarterly accounts', client: 'Lakeview Studio' }, milestones: [{ title: 'Books closed', amount: A }], deliverBy: null,
      review: { ms: 7 * DAY, onTimeout: { kind: 'release' } }, answer: { ms: 3 * DAY, onTimeout: { kind: 'refund' } },
      evidence: { ms: 3 * DAY, onTimeout: { kind: 'raiser' } }, decision: { ms: 5 * DAY, onTimeout: { kind: 'split', earnerPct: 50 } },
      mediator: { simulated: true, may: ['release', 'refund', 'split'] }, roles: { earner: w.userId, client: w.userId, mediator: w.userId }, rounding: 'client-part-down',
    })
    expect(p.hash).toBe(sha256hex(canonical(p.terms)))
    // without the fingerprint of these terms, or without both acceptances, nothing is opened
    expect(codeOf(() => createJob(w.db, w.userId, { ...raw, termsHash: 'f'.repeat(64), accept: { earner: true, client: true } }, T0))).toBe('terms_changed')
    expect(codeOf(() => createJob(w.db, w.userId, { ...raw, reviewDays: 6, termsHash: p.hash, accept: { earner: true, client: true } }, T0))).toBe('terms_changed')
    expect(fieldsOf(() => createJob(w.db, w.userId, { ...raw, termsHash: p.hash, accept: { earner: true } }, T0)).accept).toMatch(/Accept the terms/)
    expect(w.db.get('SELECT COUNT(*) n FROM earn_jobs')).toEqual({ n: 0 })
    const { id } = createJob(w.db, w.userId, { ...raw, termsHash: p.hash, accept: { earner: true, client: true } }, T0)
    const t = w.db.get<{ id: string; terms_json: string; hash: string; version: number; milestone_id: string | null }>('SELECT id, terms_json, hash, version, milestone_id FROM earn_terms WHERE job_id = ?', id)!
    expect(t).toMatchObject({ terms_json: canonical(p.terms), hash: p.hash, version: 2, milestone_id: null })
    expect(w.db.all('SELECT side, person_id, at FROM earn_terms_accepts WHERE terms_id = ? ORDER BY side', t.id)).toEqual([{ side: 'client', person_id: w.userId, at: T0 }, { side: 'earner', person_id: w.userId, at: T0 }])
    const [m] = w.db.all<{ id: string; terms_id: string; state: string }>('SELECT id, terms_id, state FROM earn_milestones WHERE job_id = ?', id)
    expect(m).toMatchObject({ terms_id: t.id, state: 'funded' })
    expect(steps(w, m!.id).map((s) => [s.actor, s.step])).toEqual([['client', 'opened']])
    // bound for good: the terms and their acceptances are append-only, and a milestone's terms are never replaced
    expect(() => w.db.run('UPDATE earn_terms SET terms_json = ?', '{}')).toThrow(/append-only/)
    expect(() => w.db.run('DELETE FROM earn_terms_accepts')).toThrow(/append-only/)
    expect(() => w.db.run('UPDATE earn_milestones SET terms_id = ? WHERE id = ?', 'etm_other', m!.id)).toThrow(/cannot be replaced/)
    expect(() => w.db.run('UPDATE earn_milestones SET terms_id = NULL WHERE id = ?', m!.id)).toThrow(/cannot be replaced/)
  })

  it('each period and timeout outcome is a choice within its stated bounds and options, each default with its reason and source', () => {
    const w = kit()
    for (const p of ['review', 'answer', 'evidence', 'decision'] as const) {
      expect(POLICY[p].why.length).toBeGreaterThan(40)
      expect(POLICY[p].source.length).toBeGreaterThan(20)
      expect(POLICY[p].outcomes).toContain(POLICY[p].onTimeout.kind)
    }
    expect(POLICY.decision.source).toMatch(/QED's own choice/)
    expect(POLICY.decision.timeoutWhy).toMatch(/not fair by itself/)
    const raw = { title: 'Work', client: 'Client', milestones: [{ title: 'Part', amount: 100 }] }
    const bad = (extra: Record<string, unknown>) => fieldsOf(() => previewTerms(w.db, w.userId, { ...raw, ...extra }, T0))
    expect(bad({ reviewDays: 15 }).reviewDays).toMatch(/1 to 14 days/)
    expect(bad({ answerDays: 0 }).answerDays).toMatch(/1 to 7 days/)
    expect(bad({ evidenceDays: 2.5 }).evidenceDays).toMatch(/1 to 7 days/)
    expect(bad({ decisionDays: 22 }).decisionDays).toMatch(/2 to 21 days/)
    expect(bad({ evidenceDays: 4, decisionDays: 4 }).decisionDays).toMatch(/after the evidence closes/)
    expect(bad({ onTimeout: { review: { kind: 'raiser' } } }).reviewOnTimeout).toMatch(/stated outcomes/)
    expect(bad({ onTimeout: { decision: { kind: 'split', earnerPct: 100 } } }).decisionOnTimeout).toMatch(/1 to 99 per cent/)
    expect(bad({ deliverBy: '2026-11-17' }).deliverBy).toMatch(/today or later/)
    expect(bad({ testSeconds: { review: 8 } }).testSeconds).toMatch(/test stack/)
    const t = previewTerms(w.db, w.userId, { ...raw, reviewDays: 3, answerDays: 2, evidenceDays: 4, decisionDays: 9, deliverBy: '2026-11-20', onTimeout: { review: { kind: 'locked' }, answer: { kind: 'split', earnerPct: 30 }, evidence: { kind: 'locked' }, decision: { kind: 'release' } } }, T0).terms
    expect(t).toMatchObject({ deliverBy: Date.parse('2026-11-20T18:29:59.999Z'), review: { ms: 3 * DAY, onTimeout: { kind: 'locked' } }, answer: { ms: 2 * DAY, onTimeout: { kind: 'split', earnerPct: 30 } }, evidence: { ms: 4 * DAY, onTimeout: { kind: 'locked' } }, decision: { ms: 9 * DAY, onTimeout: { kind: 'release' } } })
  })
})

// ------------------------------------------------------------------------------------------------ timers and the terms in force

describe('timers come from the stored terms and the step that started them, never from current settings', () => {
  it('a review runs from its submission for the period accepted; changing the defaults afterwards changes nothing for this job', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    w.clock.advance(H)
    submit(w, m!)
    const due = T0 + H + 7 * DAY
    expect(row(w, m!).due_at).toBe(due)
    expect(view(w, m!).dueAt).toBe(due)
    const was = POLICY.review.days.default
    POLICY.review.days.default = 1 // a later build with another default
    try {
      w.clock.set(T0 + H + DAY + 1)
      expect(tick(w)).toBe(0)
      w.clock.set(due - 1)
      expect(tick(w)).toBe(0)
      w.clock.set(due)
      expect(tick(w)).toBe(1)
    } finally { POLICY.review.days.default = was }
    expect(entries(w, m!)).toMatchObject([{ ref: `earn:${m}`, effective_ts: due, amount_text: String(A) }])
    expect(receipts(w, m!)).toMatchObject([{ outcome: 'released', decidedBy: 'rule', terms: { version: 2 } }])
  })

  it('a deadline cached earlier than the terms give is not acted on: the engine works the deadline out again from the terms and the starting step', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    submit(w, m!)
    w.db.run('UPDATE earn_milestones SET due_at = ? WHERE id = ?', T0 + H, m!)
    w.clock.set(T0 + 2 * H)
    expect(dueMilestones(w.db, w.clock.now()).map((x) => x.id)).toEqual([m])
    expect(tick(w)).toBe(0)
    expect(row(w, m!).state).toBe('submitted')
    expect(view(w, m!).dueAt).toBe(T0 + 7 * DAY)
  })

  it('terms that no longer match their fingerprint are never acted on, and the page says so', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    submit(w, m!)
    // a write past the append-only guard: the stored terms are altered
    w.db.exec('DROP TRIGGER earn_terms_no_update')
    w.db.run(`UPDATE earn_terms SET terms_json = replace(terms_json, '"ms":604800000', '"ms":3600000')`)
    w.clock.set(T0 + 2 * H)
    expect(tick(w)).toBe(0)
    w.clock.set(T0 + 30 * DAY)
    expect(tick(w)).toBe(0)
    expect(row(w, m!).state).toBe('submitted')
    expect(view(w, m!)).toMatchObject({ next: null, problem: expect.stringMatching(/do not match their fingerprint/) })
    expect(codeOf(() => clientDecision(w.ctx, w.userId, m!, 'accept'))).toBe('terms_invalid')
  })

  it('an engine stopped across a deadline applies it once on start, dated at the deadline and recorded late; restarting again, and opening the database again, change nothing', async () => {
    const path = tempDb()
    const clock = new FakeClock(T0)
    const first = new Engine({ dbPath: path }, { clock, live: false })
    first.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_restart', 'restart', 'Restart', 'x', T0)
    openHousehold(first.db, 'usr_restart', DEFAULT_OPENING, {}, T0)
    first.start()
    const w: World = { db: first.db, ctx: first.ctx, clock, userId: 'usr_restart' }
    const { ms: [m] } = job(w, { reviewDays: 2 })
    submit(w, m!)
    await first.tick()
    first.stop()
    // opened again while stopped (a migration that has nothing to do): the deadline does not move
    const again = openDb(path)
    expect(again.get('SELECT due_at FROM earn_milestones WHERE id = ?', m!)).toEqual({ due_at: T0 + 2 * DAY })
    again.close()
    const due = T0 + 2 * DAY
    clock.set(due + 3 * H)
    const second = new Engine({ dbPath: path }, { clock, live: false })
    second.start()
    await second.tick()
    const v: World = { db: second.db, ctx: second.ctx, clock, userId: 'usr_restart' }
    expect(row(v, m!).state).toBe('released')
    const [e] = entries(v, m!)
    expect(e).toMatchObject({ ts: due + 3 * H, effective_ts: due })
    expect(JSON.parse(e!.meta_json)).toMatchObject({ recordedLate: true, scheduledAt: due })
    expect(String(receipts(v, m!)[0]!.resolution)).toMatch(/recorded late/)
    second.stop()
    clock.advance(DAY)
    const third = new Engine({ dbPath: path }, { clock, live: false })
    third.start()
    await third.tick()
    const x: World = { db: third.db, ctx: third.ctx, clock, userId: 'usr_restart' }
    expect(entries(x, m!)).toHaveLength(1)
    expect(receipts(x, m!)).toHaveLength(1)
    third.stop()
  })

  it('a late submission is recorded as late; its review runs from the submission, under the accepted terms', () => {
    const w = kit()
    const { ms: [m] } = job(w, { deliverBy: '2026-11-20', reviewDays: 2 })
    expect(codeOf(() => clientDecision(w.ctx, w.userId, m!, 'refund'))).toBe('not_yet')
    w.clock.set(Date.parse('2026-11-21T04:00:00Z'))
    submit(w, m!)
    expect(row(w, m!).due_at).toBe(w.clock.now() + 2 * DAY)
    expect(JSON.parse(steps(w, m!)[1]!.detail_json)).toMatchObject({ late: true, deliverBy: Date.parse('2026-11-20T18:29:59.999Z') })
  })
})

// ------------------------------------------------------------------------------------------------ each timeout outcome

describe('each timeout outcome as the terms state it', () => {
  it('review: refunded, a stated split rounded to conserve every paisa, or locked until both agree', () => {
    const w = kit()
    const refund = job(w, { onTimeout: { review: { kind: 'refund' } } }).ms[0]!
    const split = job(w, { onTimeout: { review: { kind: 'split', earnerPct: 30 } } }).ms[0]!
    const locked = job(w, { onTimeout: { review: { kind: 'locked' } } }).ms[0]!
    for (const id of [refund, split, locked]) submit(w, id)
    const before = bank(w)
    w.clock.set(T0 + 7 * DAY)
    // due and not yet applied: the escrow's own step, named by the period that ended, with what the terms give
    expect(view(w, refund).next).toEqual({ actor: 'rule', step: 'review-ended', by: T0 + 7 * DAY, then: { kind: 'refund', toEarner: 0, toClient: A } })
    expect(view(w, split).next).toMatchObject({ actor: 'rule', step: 'review-ended', then: { kind: 'split', toEarner: 540_001, toClient: 1_260_000 } })
    expect(tick(w)).toBe(3)
    expect(row(w, refund).state).toBe('refunded')
    expect(entries(w, refund)).toEqual([])
    // 30% of 18,000.01 to the earner: the client's 70% rounded down to the paisa, the earner the rest
    expect(splitOf(A, 30)).toEqual({ earner: 540_001, client: 1_260_000 })
    expect(row(w, split).state).toBe('split')
    expect(entries(w, split)).toMatchObject([{ amount_text: '540001' }])
    expect(receipts(w, split)).toMatchObject([{ outcome: 'split', toEarner: '540001', toClient: '1260000', decidedBy: 'rule' }])
    // the entry names the period that ran out, so money in can say how the payment came about
    expect(JSON.parse(entries(w, split)[0]!.meta_json)).toMatchObject({ decidedBy: 'rule', period: 'review', outcome: 'split', termsHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(bank(w) - before).toBe(540_001n)
    // each is recorded as the terms applied at the end of the period, with what they gave each side
    expect(steps(w, refund).at(-1)).toMatchObject({ actor: 'rule', step: 'timed-out', person_id: null })
    expect(JSON.parse(steps(w, refund).at(-1)!.detail_json)).toEqual({ at: T0 + 7 * DAY, period: 'review', outcome: 'refunded', toEarner: 0, toClient: A })
    expect(JSON.parse(steps(w, split).at(-1)!.detail_json)).toMatchObject({ period: 'review', outcome: 'split', toEarner: 540_001, toClient: 1_260_000 })
    // locked: nothing settles; the two sides must agree, and the client may still give way
    expect(row(w, locked)).toMatchObject({ state: 'submitted', due_at: null })
    expect(steps(w, locked).at(-1)).toMatchObject({ actor: 'rule', step: 'locked' })
    expect(view(w, locked).next).toEqual({ actor: 'both', step: 'agree-outcome', by: null, then: { kind: 'locked' } })
    w.clock.advance(30 * DAY)
    expect(tick(w)).toBe(0)
    expect(codeOf(() => clientDecision(w.ctx, w.userId, locked, 'dispute', { reason: 'Too late to say so.' }))).toBe('review_ended')
    expect(settleByAgreement(w.ctx, w.userId, locked, { side: 'earner', outcome: 'split', earnerPaise: 900_000 })).toEqual({ settled: false })
    expect(settleByAgreement(w.ctx, w.userId, locked, { side: 'client', outcome: 'split', earnerPaise: 900_001 })).toEqual({ settled: false })
    expect(row(w, locked).state).toBe('submitted')
    expect(settleByAgreement(w.ctx, w.userId, locked, { side: 'earner', outcome: 'split', earnerPaise: 900_001 })).toEqual({ settled: true })
    expect(row(w, locked).state).toBe('split')
    expect(receipts(w, locked)).toMatchObject([{ outcome: 'split', toEarner: '900001', toClient: '900000', decidedBy: 'agreement' }])
    // what the page says was paid is what the ledger holds, with no dispute to read it from
    expect(view(w, locked)).toMatchObject({ paid: 900_001, back: 900_000, dispute: null })
    expect(view(w, split)).toMatchObject({ paid: 540_001, back: 1_260_000 })
    expect(view(w, refund)).toMatchObject({ paid: 0, back: A })
  })

  it('answer: the request stands by default, or the terms keep it locked; an answer in time still counts', () => {
    const w = kit()
    // the third's dispute keeps its evidence open past the answer deadlines
    const [byDefault, locked, answered] = [job(w), job(w, { onTimeout: { answer: { kind: 'locked' } } }), job(w, { evidenceDays: 5, decisionDays: 7 })].map((j) => j.ms[0]!)
    for (const id of [byDefault!, locked!, answered!]) clientDecision(w.ctx, w.userId, id, 'refund')
    earnerStep(w.ctx, w.userId, answered!, 'dispute', { reason: 'The client agreed to wait.' })
    w.clock.set(T0 + 3 * DAY)
    expect(tick(w)).toBe(2)
    expect(row(w, byDefault!).state).toBe('refunded')
    expect(row(w, locked!)).toMatchObject({ state: 'refund-asked', due_at: null })
    expect(row(w, answered!).state).toBe('disputed')
    // a locked request may still be agreed to by the earner
    earnerStep(w.ctx, w.userId, locked!, 'agree')
    expect(row(w, locked!).state).toBe('refunded')
  })

  it('evidence: the side that raised it has its way by default, or the terms split or lock it', () => {
    const w = kit()
    const work = job(w).ms[0]!, refundDispute = job(w).ms[0]!, split = job(w, { onTimeout: { evidence: { kind: 'split', earnerPct: 50 } } }).ms[0]!, locked = job(w, { onTimeout: { evidence: { kind: 'locked' } } }).ms[0]!
    for (const id of [work, split, locked]) { submit(w, id); clientDecision(w.ctx, w.userId, id, 'dispute', { reason: 'Not what was agreed.' }) }
    clientDecision(w.ctx, w.userId, refundDispute, 'refund')
    earnerStep(w.ctx, w.userId, refundDispute, 'dispute', { reason: 'The work is half done.' })
    w.clock.set(T0 + 3 * DAY)
    expect(tick(w)).toBe(4)
    expect(row(w, work).state).toBe('refunded')
    expect(row(w, refundDispute).state).toBe('released')
    expect(entries(w, split)).toMatchObject([{ amount_text: '900001' }])
    expect(row(w, locked)).toMatchObject({ state: 'disputed', due_at: null })
    expect(codeOf(() => decide(w.ctx, w.userId, locked, { outcome: 'released' }))).toBe('not_heard')
    clientDecision(w.ctx, w.userId, locked, 'accept')
    expect(dispute(w, locked)).toMatchObject({ outcome: 'released', decided_by: 'client' })
  })

  it('decision: half each by default (the odd paisa to the earner), or released, refunded or locked as the terms say', () => {
    const w = kit()
    const half = job(w).ms[0]!, release = job(w, { onTimeout: { decision: { kind: 'release' } } }).ms[0]!, locked = job(w, { onTimeout: { decision: { kind: 'locked' } } }).ms[0]!
    for (const id of [half, release, locked]) {
      submit(w, id)
      clientDecision(w.ctx, w.userId, id, 'dispute', { reason: 'Not what was agreed.' })
      addEvidence(w.ctx, w.userId, id, { side: 'earner', text: 'It is what the letter says.' })
    }
    w.clock.set(T0 + 5 * DAY)
    expect(tick(w)).toBe(3)
    expect(receipts(w, half)).toMatchObject([{ outcome: 'split', toEarner: '900001', toClient: '900000' }])
    expect(steps(w, half).at(-1)).toMatchObject({ actor: 'rule', step: 'timed-out' })
    expect(JSON.parse(steps(w, half).at(-1)!.detail_json)).toMatchObject({ period: 'decision', outcome: 'split', toEarner: 900_001, toClient: 900_000 })
    expect(entries(w, release)).toMatchObject([{ amount_text: String(A) }])
    expect(row(w, locked)).toMatchObject({ state: 'disputed', due_at: null })
    expect(codeOf(() => decide(w.ctx, w.userId, locked, { outcome: 'released' }))).toBe('decision_closed')
  })
})

// ------------------------------------------------------------------------------------------------ disputes and the mediator

describe('a two-sided dispute under the accepted terms', () => {
  it('raised by the client with a reason; evidence closes and the mediator decides as the terms say; a split pays exactly the decided paise', () => {
    const w = kit()
    const { ms: [m] } = job(w, { evidenceDays: 2, decisionDays: 4 })
    submit(w, m!)
    expect(fieldsOf(() => clientDecision(w.ctx, w.userId, m!, 'dispute', {})).reason).toMatch(/what is wrong/)
    clientDecision(w.ctx, w.userId, m!, 'dispute', { reason: 'Two accounts were not reconciled.' })
    expect(dispute(w, m!)).toMatchObject({ raised_by: 'client', against: 'work', evidence_due_at: T0 + 2 * DAY, decide_by: T0 + 4 * DAY, state: 'open' })
    expect(codeOf(() => decide(w.ctx, w.userId, m!, { outcome: 'released' }))).toBe('not_heard')
    addEvidence(w.ctx, w.userId, m!, { side: 'earner', text: 'The difference is a cheque the client has not deposited.' })
    expect(row(w, m!).due_at).toBe(T0 + 4 * DAY)
    for (const earnerPaise of [0, A, A + 1, 1.5, -5]) expect(codeOf(() => decide(w.ctx, w.userId, m!, { outcome: 'split', earnerPaise }))).toBe('invalid')
    const before = bank(w)
    decide(w.ctx, w.userId, m!, { outcome: 'split', earnerPaise: 1_500_000 })
    expect(bank(w) - before).toBe(1_500_000n)
    expect(receipts(w, m!)).toMatchObject([{ outcome: 'split', toEarner: '1500000', toClient: String(A - 1_500_000), decidedBy: 'mediator' }])
    expect(steps(w, m!).map((s) => `${s.actor}:${s.step}`)).toEqual(['client:opened', 'earner:submitted', 'client:disputed', 'earner:evidence', 'mediator:decided'])
  })
})

// ------------------------------------------------------------------------------------------------ milestones from before terms

describe('a milestone from before terms were recorded keeps its terms until both sides agree new ones', () => {
  it('nothing happens to it on its own, whatever its cached deadline says; the moves its terms allowed stay open; the others wait for terms', () => {
    const w = kit()
    const [submitted, funded, disputed] = legacyJob(w, ['submitted', 'funded', 'disputed'])
    // even a deadline written into the record does nothing without accepted terms
    w.db.run('UPDATE earn_milestones SET due_at = ? WHERE id = ?', T0, submitted!)
    w.clock.set(T0 + 400 * DAY)
    expect(dueMilestones(w.db, w.clock.now())).toEqual([])
    expect(tick(w)).toBe(0)
    expect(applyDue(w.db, w.userId, submitted!, w.clock.now())).toBe(false)
    expect(row(w, submitted!)).toMatchObject({ state: 'submitted', terms_id: null })
    expect(view(w, submitted!)).toMatchObject({ legacy: true, dueAt: null, next: { actor: 'both', step: 'agree-terms', by: null, then: { kind: 'nothing' } }, can: { earner: ['settle', 'propose-terms'], client: ['accept', 'dispute', 'refund', 'settle', 'propose-terms'], mediator: [] } })
    for (const [what, fn] of [
      ['evidence', () => addEvidence(w.ctx, w.userId, disputed!, { side: 'earner', text: 'Here it is.' })],
      ['a mediator', () => decide(w.ctx, w.userId, disputed!, { outcome: 'released' })],
      ['a refund request to answer', () => earnerStep(w.ctx, w.userId, funded!, 'agree')],
      ['giving the money back', () => earnerStep(w.ctx, w.userId, funded!, 'give-back')],
    ] as const) expect(codeOf(fn as () => unknown), what).toBe('no_terms')
    // what its terms allowed: the client accepts at any time, or takes the money back at once
    clientDecision(w.ctx, w.userId, funded!, 'refund')
    expect(row(w, funded!).state).toBe('refunded')
    expect(receipts(w, funded!)).toMatchObject([{ outcome: 'refunded', decidedBy: 'client', terms: 'opened before terms were recorded: no deadline and no default' }])
    clientDecision(w.ctx, w.userId, disputed!, 'accept')
    expect(entries(w, disputed!)).toHaveLength(1)
  })

  it('both sides agree terms for it: one proposes, the other accepts by fingerprint; the review starts at the agreement, never before', () => {
    const w = kit()
    const [m] = legacyJob(w, ['submitted'])
    w.clock.set(T0 + H)
    const p = propose(w, m!, { side: 'earner', reviewDays: 5 })
    expect(p.terms).toMatchObject({ milestones: [{ title: 'Books closed for the quarter', amount: 1_800_000 }], review: { ms: 5 * DAY, onTimeout: { kind: 'release' } } })
    expect(row(w, m!).terms_id).toBeNull()
    expect(view(w, m!)).toMatchObject({ next: { actor: 'both', step: 'accept-terms' }, proposal: { by: 'earner', hash: p.hash } })
    expect(codeOf(() => acceptTerms(w.ctx, w.userId, m!, { side: 'earner', hash: p.hash }))).toBe('no_proposal')
    expect(codeOf(() => acceptTerms(w.ctx, w.userId, m!, { side: 'client', hash: 'f'.repeat(64) }))).toBe('terms_changed')
    // the client proposes others instead: they replace the earner's, and only the earner may accept them
    w.clock.set(T0 + 2 * H)
    const q = propose(w, m!, { side: 'client', reviewDays: 4, onTimeout: { review: { kind: 'locked' } } })
    expect(codeOf(() => acceptTerms(w.ctx, w.userId, m!, { side: 'client', hash: p.hash }))).toBe('no_proposal')
    w.clock.set(T0 + 3 * H)
    acceptTerms(w.ctx, w.userId, m!, { side: 'earner', hash: q.hash })
    expect(row(w, m!)).toMatchObject({ terms_id: q.termsId, due_at: T0 + 3 * H + 4 * DAY })
    // the milestone carries the terms it agreed, in full: its job has none
    expect(view(w, m!)).toMatchObject({ legacy: false, terms: { hash: q.hash, version: 2, agreedAt: T0 + 3 * H, terms: { review: { ms: 4 * DAY, onTimeout: { kind: 'locked' } } }, accepts: [{ side: 'client' }, { side: 'earner' }] } })
    expect(steps(w, m!).map((s) => `${s.actor}:${s.step}`)).toEqual(['earner:terms-proposed', 'client:terms-proposed', 'earner:terms-agreed'])
    w.clock.set(T0 + 3 * H + 4 * DAY)
    expect(tick(w)).toBe(1)
    expect(row(w, m!)).toMatchObject({ state: 'submitted', due_at: null })
    expect(view(w, m!).next).toMatchObject({ actor: 'both', step: 'agree-outcome' })
  })

  it('terms for it are read in full before they are proposed, and proposed only by the fingerprint read', () => {
    const w = kit()
    const [m, settled] = legacyJob(w, ['submitted', 'released'])
    const raw = { side: 'earner', reviewDays: 5 }
    const p = previewProposal(w.db, w.userId, m!, raw, w.clock.now())
    expect(p.terms).toMatchObject({ job: { title: 'Quarterly accounts for Lakeview Studio', client: 'Lakeview Studio' }, milestones: [{ title: 'Books closed for the quarter', amount: 1_800_000 }], review: { ms: 5 * DAY, onTimeout: { kind: 'release' } } })
    expect(p.hash).toBe(sha256hex(canonical(p.terms)))
    // reading them records nothing; proposing others than were read proposes nothing
    expect(w.db.get('SELECT COUNT(*) n FROM earn_terms')).toEqual({ n: 0 })
    expect(codeOf(() => proposeTerms(w.ctx, w.userId, m!, raw))).toBe('terms_changed')
    expect(codeOf(() => proposeTerms(w.ctx, w.userId, m!, { ...raw, reviewDays: 6, termsHash: p.hash }))).toBe('terms_changed')
    expect(w.db.get('SELECT COUNT(*) n FROM earn_terms')).toEqual({ n: 0 })
    expect(fieldsOf(() => previewProposal(w.db, w.userId, m!, { side: 'earner', reviewDays: 30 }, w.clock.now())).reviewDays).toMatch(/1 to 14 days/)
    expect(proposeTerms(w.ctx, w.userId, m!, { ...raw, termsHash: p.hash }).hash).toBe(p.hash)
    // a settled milestone has nothing to agree terms for; one under terms already has them
    expect(codeOf(() => previewProposal(w.db, w.userId, settled!, raw, w.clock.now()))).toBe('wrong_state')
    const { ms: [bound] } = job(w)
    expect(codeOf(() => previewProposal(w.db, w.userId, bound!, raw, w.clock.now()))).toBe('has_terms')
  })

  it('a dispute from before is decided under terms agreed later, its evidence and decision counted from the agreement', () => {
    const w = kit()
    const [m] = legacyJob(w, ['disputed'])
    const p = propose(w, m!, { side: 'client' })
    w.clock.set(T0 + DAY)
    acceptTerms(w.ctx, w.userId, m!, { side: 'earner', hash: p.hash })
    expect(dispute(w, m!)).toMatchObject({ raised_by: 'client', raised_at: T0 + DAY, evidence_due_at: T0 + 4 * DAY, decide_by: T0 + 6 * DAY, state: 'open' })
    expect(row(w, m!).due_at).toBe(T0 + 4 * DAY)
    w.clock.set(T0 + 4 * DAY)
    expect(tick(w)).toBe(1)
    expect(row(w, m!).state).toBe('refunded')
  })
})

// ------------------------------------------------------------------------------------------------ roles

describe('roles: each step only from the member who plays its role', () => {
  function business() {
    const w = kit()
    const ws = 'ws_biz', [earner, client, mediator, operator, viewer] = ['usr_e', 'usr_c', 'usr_m', 'usr_o', 'usr_v']
    w.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, 'biz', 'Biz', '!', ?, 'business')`, ws, T0)
    openHousehold(w.db, ws, DEFAULT_OPENING, {}, T0)
    for (const [id, name, role] of [[earner, 'Esha', 'owner'], [client, 'Chitra', 'approver'], [mediator, 'Mohan', 'admin'], [operator, 'Om', 'operator'], [viewer, 'Vik', 'viewer']] as const) {
      w.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, id, name, 'x', T0)
      w.db.run('INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, ?, ?)', ws, id, role, T0)
    }
    const as = <T>(person: string, fn: () => T): T => actor.run({ personId: person, workspaceId: ws, role: 'owner' }, fn)
    return { w: { ...w, userId: ws }, ws, earner, client, mediator, operator, viewer, as }
  }

  it('in a business workspace the earner, the paper client and the mediator are three named members; the client\'s member accepts and funds; anyone else is refused', () => {
    const { w, ws, earner, client, mediator, operator, viewer, as } = business()
    const raw = { title: 'Brochure', client: 'Lakeview', milestones: [{ title: 'Draft', amount: 300_001 }] }
    expect(as(earner, () => fieldsOf(() => previewTerms(w.db, ws, { ...raw, roles: { client: earner, mediator } }, T0))).roles).toMatch(/three different members/)
    expect(as(earner, () => fieldsOf(() => previewTerms(w.db, ws, { ...raw, roles: { client: operator, mediator } }, T0))).role_client).toMatch(/may approve/)
    const withRoles = { ...raw, roles: { client, mediator } }
    const { hash } = as(earner, () => previewTerms(w.db, ws, withRoles, T0))
    const { id, state } = as(earner, () => createJob(w.db, ws, { ...withRoles, termsHash: hash, accept: { earner: true } }, T0))
    expect(state).toBe('proposed')
    const [m] = w.db.all<{ id: string }>('SELECT id FROM earn_milestones WHERE job_id = ?', id).map((r) => r.id)
    // only the client's member accepts the terms and so funds it
    expect(as(earner, () => codeOf(() => acceptJobTerms(w.ctx, ws, id, { hash })))).toBe('not_your_role')
    expect(as(mediator, () => codeOf(() => acceptJobTerms(w.ctx, ws, id, { hash })))).toBe('not_your_role')
    as(client, () => acceptJobTerms(w.ctx, ws, id, { hash }))
    expect(row(w, m!).state).toBe('funded')
    // each step from its own member only
    expect(as(client, () => codeOf(() => submitMilestone(w.db, ws, m!, 'Done.', T0)))).toBe('not_your_role')
    as(earner, () => submitMilestone(w.db, ws, m!, 'Draft shared.', T0))
    for (const p of [earner, mediator, operator, viewer]) expect(as(p, () => codeOf(() => clientDecision(w.ctx, ws, m!, 'accept'))), p).toBe('not_your_role')
    as(client, () => clientDecision(w.ctx, ws, m!, 'dispute', { reason: 'Wrong colours.' }))
    as(earner, () => addEvidence(w.ctx, ws, m!, { side: 'earner', text: 'The colours are the brand sheet\'s.' }))
    for (const p of [earner, client, operator]) expect(as(p, () => codeOf(() => decide(w.ctx, ws, m!, { outcome: 'released' }))), p).toBe('not_your_role')
    as(mediator, () => decide(w.ctx, ws, m!, { outcome: 'split', earnerPaise: 200_000 }))
    expect(steps(w, m!).map((s) => [s.actor, s.step, s.person_id])).toEqual([['client', 'opened', client], ['earner', 'submitted', earner], ['client', 'disputed', client], ['earner', 'evidence', earner], ['mediator', 'decided', mediator]])
    // without a signed-in member no step is taken in a business workspace
    expect(codeOf(() => clientDecision(w.ctx, ws, m!, 'accept'))).toBe('not_your_role')
  })

  it('in a personal workspace the household plays each role and nobody else may act', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    expect(actor.run({ personId: 'usr_stranger', workspaceId: w.userId, role: 'owner' }, () => codeOf(() => submit(w, m!)))).toBe('not_your_role')
    actor.run({ personId: w.userId, workspaceId: w.userId, role: 'owner' }, () => submit(w, m!))
    expect(steps(w, m!).at(-1)).toMatchObject({ actor: 'earner', step: 'submitted', person_id: w.userId })
  })
})

// ------------------------------------------------------------------------------------------------ races, interruptions, uncertainty

describe('no conflicting or duplicate payouts', () => {
  it('two connections: the client accepting and the engine at the deadline, the mediator deciding and the decision timing out, an agreement and a default: one settlement each', () => {
    const { path, w } = fileWorld('usr_race')
    const other = openDb(path)
    try {
      const o: World = { ...w, db: other, ctx: ctxOf(other, w.clock) }
      const { ms: [review, decision] } = job(w)
      const agreement = job(w).ms[0]!
      submit(w, review!); submit(w, decision!); submit(w, agreement)
      clientDecision(w.ctx, w.userId, decision!, 'dispute', { reason: 'Not what was agreed.' })
      addEvidence(w.ctx, w.userId, decision!, { side: 'earner', text: 'It is what was agreed.' })
      settleByAgreement(w.ctx, w.userId, agreement, { side: 'earner', outcome: 'refunded' })
      // both connections read everything due before either acts
      w.clock.set(T0 + 7 * DAY)
      expect(dueMilestones(other, w.clock.now()).map((x) => x.id).sort()).toEqual([review, decision, agreement].sort())
      expect(applyDue(other, w.userId, review!, w.clock.now())).toBe(true)
      expect(codeOf(() => clientDecision(w.ctx, w.userId, review!, 'accept'))).toBe('wrong_state')
      expect(codeOf(() => decide(o.ctx, w.userId, decision!, { outcome: 'refunded' }))).toBe('decision_closed')
      expect(applyDue(w.db, w.userId, decision!, w.clock.now())).toBe(true)
      expect(applyDue(other, w.userId, decision!, w.clock.now())).toBe(false)
      expect(settleByAgreement(o.ctx, w.userId, agreement, { side: 'client', outcome: 'refunded' })).toEqual({ settled: true })
      expect(applyDue(w.db, w.userId, agreement, w.clock.now())).toBe(false)
      for (const id of [review!, decision!, agreement]) expect(receipts(w, id), id).toHaveLength(1)
      expect(entries(w, review!)).toHaveLength(1)
      expect(entries(w, decision!)).toMatchObject([{ amount_text: '600000' }]) // half of ₹12,000.00
      expect(entries(w, agreement)).toEqual([])
    } finally { other.close(); w.db.close() }
  })

  it('separate processes, all at once: the engine, the client, the earner and the mediator acting on the same milestones settle each once, and the money adds up to the paisa', async () => {
    const { path, w } = fileWorld('usr_proc')
    const amounts = [1_800_001, 1_200_000, 333_333, 7]
    const ids: string[] = []
    for (const amount of amounts) {
      const { ms: [m] } = job(w, { milestones: [{ title: `Part ${amount}`, amount }] })
      submit(w, m!)
      ids.push(m!)
    }
    clientDecision(w.ctx, w.userId, ids[1]!, 'dispute', { reason: 'Not what was agreed.' })
    addEvidence(w.ctx, w.userId, ids[1]!, { side: 'earner', text: 'It is what was agreed.' })
    const bank0 = balance(w.db, 'usr_proc', 'bank')
    w.db.close()
    const at = T0 + 7 * DAY + 5 // past every review and every dispute deadline
    const lib = (f: string) => JSON.stringify(join(APP_ROOT, 'server', f))
    const run = (what: string): Promise<string> => new Promise((done, fail) => {
      const src = `import { escrowTick } from ${lib('escrow.ts')}; import { clientDecision } from ${lib('owner.ts')}; import { decide, settleByAgreement } from ${lib('escrow.ts')}; import { openDb } from ${lib('core.ts')};
        const db = openDb(${JSON.stringify(path)}); const ctx = { db, clock: { now: () => ${at} } }; const ids = ${JSON.stringify(ids)}; let n = 0;
        const tryIt = (fn) => { try { fn(); n++ } catch { /* refused: someone else got there first */ } };
        for (let i = 0; i < 10; i++) {
          if (${JSON.stringify(what)} === 'engine') n += escrowTick(ctx);
          if (${JSON.stringify(what)} === 'client') for (const id of ids) tryIt(() => clientDecision(ctx, 'usr_proc', id, 'accept'));
          if (${JSON.stringify(what)} === 'mediator') tryIt(() => decide(ctx, 'usr_proc', ids[1], { outcome: 'refunded' }));
          if (${JSON.stringify(what)} === 'agree') for (const id of ids) for (const side of ['earner', 'client']) tryIt(() => settleByAgreement(ctx, 'usr_proc', id, { side, outcome: 'refunded' }).settled || (() => { throw new Error('offer') })());
        }
        db.close(); process.stdout.write(String(n))`
      const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
      c.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}: ${err}`))))
    })
    await Promise.all([run('engine'), run('engine'), run('client'), run('mediator'), run('agree')])
    const check = openDb(path)
    try {
      const v: World = { ...w, db: check }
      let earned = 0n, back = 0n
      for (const [i, id] of ids.entries()) {
        expect(['released', 'refunded', 'split']).toContain(row(v, id).state)
        const r = receipts(v, id)
        expect(r, id).toHaveLength(1)
        const e = entries(v, id)
        expect(e.length).toBeLessThanOrEqual(1)
        const toEarner = BigInt(e[0]?.amount_text ?? '0')
        const toClient = BigInt(amounts[i]!) - toEarner
        expect(BigInt(String(r[0]!.outcome === 'split' ? r[0]!.toEarner : r[0]!.outcome === 'released' ? amounts[i] : 0))).toBe(toEarner)
        earned += toEarner; back += toClient
      }
      expect(earned + back).toBe(BigInt(amounts.reduce((a, b) => a + b, 0)))
      expect(balance(check, 'usr_proc', 'bank') - bank0).toBe(earned)
    } finally { check.close() }
  }, 60_000)

  it('an interrupted settlement leaves nothing half done: the transaction rolls back, and the next pass settles it once', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    submit(w, m!)
    w.clock.set(T0 + 7 * DAY)
    const run = w.db.run.bind(w.db)
    let cut = true
    w.db.run = ((sql: string, ...p: never[]) => { if (cut && sql.startsWith('INSERT INTO receipts')) { cut = false; throw new Error('power cut') } return run(sql, ...p) }) as typeof w.db.run
    expect(tick(w)).toBe(0)
    expect(row(w, m!).state).toBe('submitted')
    expect(entries(w, m!)).toEqual([])
    expect(steps(w, m!).map((s) => s.step)).toEqual(['opened', 'submitted'])
    expect(tick(w)).toBe(1)
    expect(entries(w, m!)).toHaveLength(1)
    expect(receipts(w, m!)).toHaveLength(1)
  })

  it('a process killed part-way through a settlement leaves the books as they were; the next pass settles once', async () => {
    const { path, w } = fileWorld('usr_kill')
    const { ms: [m] } = job(w)
    submit(w, m!)
    w.db.close()
    const at = T0 + 7 * DAY
    const src = `import { Db, openDb } from ${JSON.stringify(join(APP_ROOT, 'server', 'core.ts'))}; import { escrowTick } from ${JSON.stringify(join(APP_ROOT, 'server', 'escrow.ts'))};
      const run = Db.prototype.run; Db.prototype.run = function (sql, ...p) { if (sql.startsWith('INSERT INTO receipts')) process.kill(process.pid, 'SIGKILL'); return run.call(this, sql, ...p) };
      escrowTick({ db: openDb(${JSON.stringify(path)}), clock: { now: () => ${at} } })`
    const signal = await new Promise<string | null>((done) => spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'ignore' }).on('exit', (_c, s) => done(s)))
    expect(signal).toBe('SIGKILL')
    const db = openDb(path)
    try {
      const v: World = { ...w, db, ctx: ctxOf(db, new FakeClock(at)) }
      expect(row(v, m!).state).toBe('submitted')
      expect(entries(v, m!)).toEqual([])
      expect(receipts(v, m!)).toEqual([])
      expect(escrowTick(v.ctx)).toBe(1)
      expect(entries(v, m!)).toHaveLength(1)
    } finally { db.close() }
  }, 60_000)

  it('a step repeated after it took effect (an answer lost on the way) is refused with where things stand, and pays nothing twice', () => {
    const w = kit()
    const { ms: [m] } = job(w)
    submit(w, m!)
    clientDecision(w.ctx, w.userId, m!, 'accept')
    expect(codeOf(() => clientDecision(w.ctx, w.userId, m!, 'accept'))).toBe('wrong_state')
    expect(() => clientDecision(w.ctx, w.userId, m!, 'accept')).toThrow(/settled, released to the earner/)
    expect(entries(w, m!)).toHaveLength(1)
    expect(receipts(w, m!)).toHaveLength(1)
  })

  it('funds are conserved to the paisa for any amount and any stated split', () => {
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n }
    for (let i = 0; i < 5000; i++) {
      const amount = 1 + rand(100_000_000_000), pct = 1 + rand(99)
      const p = splitOf(amount, pct)
      expect(p.earner + p.client).toBe(amount)
      expect(p.client).toBe(Number((BigInt(amount) * BigInt(100 - pct)) / 100n))
      expect(p.earner).toBeGreaterThanOrEqual(0)
      expect(p.client).toBeGreaterThanOrEqual(0)
    }
    expect(splitOf(1, 50)).toEqual({ earner: 1, client: 0 })
    expect(splitOf(3, 50)).toEqual({ earner: 2, client: 1 })
  })
})

// ------------------------------------------------------------------------------------------------ out of turn, and what the page reads

describe('steps out of turn are refused, and nothing moves', () => {
  it('each refused step leaves the milestones, the ledger, the receipts and the disputes as they were', () => {
    const w = kit()
    const { ms: [funded, inReview, asked, disputed, done] } = job(w, { milestones: ['a', 'b', 'c', 'd', 'e'].map((t) => ({ title: `Part ${t}`, amount: 100_000 })) })
    submit(w, inReview!)
    clientDecision(w.ctx, w.userId, asked!, 'refund')
    submit(w, disputed!)
    clientDecision(w.ctx, w.userId, disputed!, 'dispute', { reason: 'Not what was agreed.' })
    submit(w, done!); clientDecision(w.ctx, w.userId, done!, 'accept')
    const snapshot = () => ({ ms: w.db.all('SELECT id, state, due_at, terms_id FROM earn_milestones ORDER BY id'), entries: w.db.get('SELECT COUNT(*) n FROM entries'), receipts: w.db.get('SELECT COUNT(*) n FROM receipts'), disputes: w.db.all('SELECT * FROM earn_disputes') })
    const before = snapshot()
    const refused: [string, () => unknown, string][] = [
      ['submit work twice', () => submit(w, inReview!), 'wrong_state'],
      ['the client accepts work not yet submitted', () => clientDecision(w.ctx, w.userId, funded!, 'accept'), 'wrong_state'],
      ['the client takes back money for work in review', () => clientDecision(w.ctx, w.userId, inReview!, 'refund'), 'wrong_state'],
      ['the client takes back money in a dispute', () => clientDecision(w.ctx, w.userId, disputed!, 'refund'), 'wrong_state'],
      ['the earner disputes with no refund asked', () => earnerStep(w.ctx, w.userId, inReview!, 'dispute', { reason: 'Nothing was asked.' }), 'wrong_state'],
      ['evidence with no dispute', () => addEvidence(w.ctx, w.userId, inReview!, { side: 'earner', text: 'Here it is.' }), 'wrong_state'],
      ['a decision before both sides are heard', () => decide(w.ctx, w.userId, disputed!, { outcome: 'released' }), 'not_heard'],
      ['terms proposed for a milestone that has them', () => proposeTerms(w.ctx, w.userId, inReview!, { side: 'earner' }), 'has_terms'],
      ['terms read for a milestone that has them', () => previewProposal(w.db, w.userId, inReview!, { side: 'earner' }, w.clock.now()), 'has_terms'],
      ['anything on a settled milestone', () => settleByAgreement(w.ctx, w.userId, done!, { side: 'earner', outcome: 'released' }), 'wrong_state'],
      ['another household\'s milestone', () => clientDecision(w.ctx, 'usr_other', inReview!, 'accept'), 'not_found'],
    ]
    for (const [what, fn, code] of refused) expect(codeOf(fn), what).toBe(code)
    expect(snapshot()).toEqual(before)
  })

  it('"Needs you" names each step waiting on the household with its deadline and what the terms make happen without it', () => {
    const w = kit()
    const { ms: [m, n] } = job(w)
    const locked = job(w, { onTimeout: { review: { kind: 'locked' } }, milestones: [{ title: 'Locked part', amount: 5_000 }] }).ms[0]!
    clientDecision(w.ctx, w.userId, m!, 'refund')
    submit(w, n!)
    clientDecision(w.ctx, w.userId, n!, 'dispute', { reason: 'Not what was agreed.' })
    submit(w, locked)
    w.clock.set(T0 + 7 * DAY)
    expect(tick(w)).toBe(3) // the unanswered request stands, the unanswered dispute goes the client's way, the review locks
    expect(escrowNeeds(w.db, w.userId, w.clock.now()).map((x) => [x.type, x.milestoneId])).toEqual([['milestone-locked', locked]])
    const w2 = kit()
    const j2 = job(w2)
    clientDecision(w2.ctx, w2.userId, j2.ms[0]!, 'refund')
    submit(w2, j2.ms[1]!)
    clientDecision(w2.ctx, w2.userId, j2.ms[1]!, 'dispute', { reason: 'Not what was agreed.' })
    expect(escrowNeeds(w2.db, w2.userId, T0)).toEqual([
      { type: 'milestone-refund', milestoneId: j2.ms[0], title: 'The client asked for the money for Books closed back', detail: '₹18,000.01 goes back to the client unless you dispute it. On paper you play the client too.', deadline: T0 + 3 * DAY, ifNothing: 'If you do nothing by then, it goes back to the client.' },
      { type: 'milestone-disputed', milestoneId: j2.ms[1], title: 'Disputed: Filing prepared', detail: 'The client disputes the work: “Not what was agreed.” ₹12,000 stays locked in escrow until it is decided.', deadline: T0 + 3 * DAY, ifNothing: 'If you do not answer with evidence by then, it goes back to the client.' },
    ])
  })
})
