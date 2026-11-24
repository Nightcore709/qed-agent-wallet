/**
 * N-018: reporting a problem stops what QED does on its own on that payment's rail, for the person's account only, until the
 * person releases it; everything is timestamped. The person's own payments are untouched.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { FakeClock, openDb } from './core.ts'
import { pausedFor, listPauses, releasePause } from './dispute-pause.ts'
import { createAction, getAction, stepAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { Market } from './market.ts'
import { addPayee, openDispute, previewAction, submitApprovedAction } from './owner.ts'
import { seedRegistry } from './registry.ts'
import { T0 } from './testkit.ts'
import type { Ctx } from './types.ts'
import { PaperCryptoVenue, PaperFundVenue, PaperRail } from './venues.ts'

const USER = 'usr_test', OTHER = 'usr_other'
function stack() {
  const db = openDb(':memory:'), clock = new FakeClock(T0), market = new Market(db, clock)
  const ctx: Ctx = { db, clock, market, venues: { crypto: new PaperCryptoVenue(db, market, clock, async () => { throw new Error('no book') }), funds: new PaperFundVenue(db, clock), rail: new PaperRail(db, clock) } }
  seedRegistry(db)
  for (const [id, h] of [[USER, 'tester'], [OTHER, 'other']] as const) {
    db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, h, h, 'x', T0)
    openHousehold(db, id, DEFAULT_OPENING, {}, T0)
  }
  return { ctx, clock }
}
const KNOWN = [['Ravi Kumar', 'ravi.kumar@upi'], ['Meera Nair', 'meera.nair@upi']] as const // the paper bank's name check knows these two
async function settledPayment(ctx: Ctx, userId = USER) {
  const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM payees WHERE user_id = ?', userId)!.n
  const [name, handle] = KNOWN[n]!
  const y = addPayee(ctx.db, userId, { name, handle, category: 'family' }, T0 - 3 * 86_400_000)
  const pv = await previewAction(ctx, userId, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 50_000 + n * 1000 })
  confirmApproval(ctx.db, userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, ctx.clock.now())
  const a = submitApprovedAction(ctx, userId, pv.approvalId)
  await stepAction(ctx, a.id)
  ;(ctx.clock as FakeClock).set(ctx.clock.now() + 10_000)
  await ctx.venues.rail.tick()
  await stepAction(ctx, a.id)
  return a.id
}
const qedPayment = (ctx: Ctx, userId: string, ref: string) => createAction(ctx, { userId, origin: 'program', kind: 'payment', venue: 'paper-rail', economicId: ref, params: { payeeHandle: 'ravi.kumar@upi', payeeName: 'Ravi Kumar', amount: '10000', purpose: 'spend' } })

describe('a reported problem pauses QED on the account', () => {
  it('starts a pause on the rail, timestamped, and holds QED-origin payments until the owner releases it', async () => {
    const { ctx, clock } = stack()
    const id = await settledPayment(ctx)
    expect(pausedFor(ctx.db, USER, 'paper-rail')).toBe(false)
    const reportedAt = clock.now()
    openDispute(ctx, USER, id, 'The payee says they never received it')
    expect(pausedFor(ctx.db, USER, 'paper-rail')).toBe(true)
    const [p] = listPauses(ctx.db, USER, id)
    expect(p).toMatchObject({ scope: 'payments:paper-rail', startedAt: reportedAt, releasedAt: null, actionId: id })
    expect(ctx.db.get('SELECT 1 FROM audit WHERE user_id = ? AND action = ?', USER, 'dispute.pause')).toBeTruthy()
    // an instruction's payment does not move while the pause holds
    const held = qedPayment(ctx, USER, 'prog#1#0')
    expect((await stepAction(ctx, held.id)).state).toBe('planned')
    // the person's own payment still does
    const mine = await settledPayment(ctx)
    expect(getAction(ctx.db, mine)!.state).toBe('done')
    // another person's account is untouched
    expect(pausedFor(ctx.db, OTHER, 'paper-rail')).toBe(false)
    expect((await stepAction(ctx, qedPayment(ctx, OTHER, 'prog#2#0').id)).state).not.toBe('planned')
    // only the owner releases it, and it is timestamped with who did
    expect(() => releasePause(ctx, OTHER, 'per_x', p!.id)).toThrow(/not found/i)
    clock.set(clock.now() + 5_000)
    const rel = releasePause(ctx, USER, 'per_owner', p!.id)
    expect(rel).toMatchObject({ releasedAt: clock.now(), releasedBy: 'per_owner' })
    expect(pausedFor(ctx.db, USER, 'paper-rail')).toBe(false)
    expect(() => releasePause(ctx, USER, 'per_owner', p!.id)).toThrow(/already released/i)
    expect((await stepAction(ctx, held.id)).state).not.toBe('planned')
  })

  it('two disputes make two pauses, each released by the person', async () => {
    const { ctx } = stack()
    const a = await settledPayment(ctx), b = await settledPayment(ctx)
    openDispute(ctx, USER, a, 'First problem here')
    openDispute(ctx, USER, b, 'Second problem here')
    const open = listPauses(ctx.db, USER).filter((p) => p.releasedAt === null)
    expect(open.length).toBe(2)
    for (const p of open) releasePause(ctx, USER, 'per_owner', p.id)
    expect(pausedFor(ctx.db, USER, 'paper-rail')).toBe(false)
  })
})

describe('the pause holds an instruction\'s run and an agent purchase, not only a stepped action', () => {
  it('a bills instruction\'s run is skipped with the reason and creates no payment; the bill is the owner\'s while it holds', async () => {
    const { makeKit } = await import('./testkit.ts')
    const { activateProgram, requestProgramApproval, saveDraft } = await import('./programs.ts')
    const { sha256hex } = await import('./receipts.ts')
    const { runTick, triggerTick } = await import('./runner.ts')
    const { billCover } = await import('./valuation.ts')
    const { startPause, PAUSE_REASON } = await import('./dispute-pause.ts')
    const k = makeKit(), DAY = 86_400_000
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_power', k.userId, 'City Power', 'power@upi', 'utility', k.clock.now(), k.clock.now())
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000, runMode: 'auto' } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)", 'bill_1', k.userId, 'pay_power', 245_000, k.clock.now(), 'November', k.clock.now())
    startPause(k.ctx, k.userId, 'dsp_x', 'act_x', 'paper-rail')
    expect(billCover(k.db, k.userId, 'power@upi', 245_000)).toMatchObject({ reason: expect.stringContaining('reported a problem') })
    triggerTick(k.ctx); runTick(k.ctx)
    expect(k.db.get<{ state: string; reason: string }>('SELECT state, reason FROM runs WHERE program_id = ?', d.programId)).toMatchObject({ state: 'skipped', reason: PAUSE_REASON })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE program_id = ?', d.programId)!.n).toBe(0)
  })
})
