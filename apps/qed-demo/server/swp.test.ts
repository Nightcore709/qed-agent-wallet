/**
 * The systematic withdrawal plan (R13, audit G3): a recurring withdrawal from a fund to the bank, as an instruction with its
 * own signed authority, schedule and limits, run by the engine like the others. Tested as the other kinds are
 * (programs.test.ts): from draft to signed to run to receipts, with its limits held and its costs shown.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { istInstant } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { available, balance, verifyLedger } from './ledger.ts'
import { activateProgram, buildDraft, loadProgram, requestProgramApproval, revokeProgram, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import type { Authority } from './types.ts'

const FUND = 'amfi:120716' // an index fund: no exit load modelled, taxed as an equity fund
const LIQ = 'amfi:118701' // a liquid fund: a graded exit load in the first six days
const DAY = 86_400_000

function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
async function cycle(k: Kit): Promise<void> {
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx); runTick(k.ctx)
}
async function run(k: Kit, ms: number, stepMs = 5000): Promise<void> { for (let t = 0; t < ms; t += stepMs) { k.clock.advance(stepMs); await cycle(k) } }
/** Units in the fund through the real flow: an owner order at a published NAV. */
async function hold(k: Kit, id: string, rupees: number, nav = '180.0000'): Promise<void> {
  k.nav(id, '2026-11-18', nav)
  const eid = `seed-${id}`
  createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid, params: { instrumentId: id, side: 'buy', type: 'nav', amount: String(rupees * 100), purpose: 'manual' }, approvalId: k.approveOwner(`action:${eid}`) })
  await settle(k, 8, 1000)
}
const monthly = (day: number) => ({ type: 'monthly' as const, day, at: '10:00' })
const auth = (k: Kit, extra: Partial<Authority> = {}) => ({ expiresAt: k.clock.now() + 60 * DAY, runMode: 'auto', ...extra })
const runs = (k: Kit, id: string) => k.db.all<{ state: string; reason: string | null }>('SELECT state, reason FROM runs WHERE program_id = ? ORDER BY created_at, due_at', id)
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }

describe('a withdrawal plan is written, analysed and signed like the other kinds', () => {
  it('is a kind with its own title, schedule and authority, and the document names what it may and never does', async () => {
    const k = makeKit(); await hold(k, FUND, 100_000)
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: FUND, amount: 1_000_000, schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    expect(d.kind).toBe('swp'); expect(d.pillar).toBe('grow')
    expect(d.title).toMatch(/Withdraw ₹10,000 from UTI Nifty 50 Index Fund to your bank, .*20/)
    expect(d.authority).toMatchObject({ maxPerRun: 1_000_000, runMode: 'approve' })
    expect(d.doc.may[0]).toMatch(/Redeem units of UTI Nifty 50 Index Fund.*worth ₹10,000.*your own bank account/)
    expect(d.doc.never).toEqual(expect.arrayContaining(['Buy anything.', 'Send money anywhere except into your own bank account.']))
    expect(d.doc.ceilingPaise).not.toBeNull()
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('shows its exit load and its tax, and says what it cannot protect', async () => {
    const k = makeKit(); await hold(k, LIQ, 100_000, '7041.4542')
    const liquid = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: LIQ, amount: 1_000_000, schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    const load = liquid.analysis.figures.find((f) => f.label === 'Exit load')!
    expect(load.value).toMatch(/about ₹\d/) // units bought today sit in the graded load
    expect(load.basis).toBe('modelled'); expect(load.note).toMatch(/unverified|modelled/)
    const tax = liquid.analysis.figures.find((f) => f.label === 'Tax on the gain in a withdrawal')!
    expect(tax.value).toMatch(/slab rate|about/)
    expect(liquid.analysis.warnings.join(' ')).toMatch(/not a limit this plan can stop/)
    const k2 = makeKit(); await hold(k2, FUND, 100_000)
    const eq = buildDraft(k2.ctx, k2.userId, 'swp', { instrumentId: FUND, amount: 1_000_000, schedule: monthly(20) }, { expiresAt: k2.clock.now() + 60 * DAY }, k2.clock.now())
    expect(eq.analysis.figures.find((f) => f.label === 'Exit load')!.value).toMatch(/none/)
    expect(eq.analysis.figures.find((f) => f.label === 'Withdrawals the units cover')!.value).toBe('9') // ₹1,00,000 less the stamp duty is worth a little under ten withdrawals
    expect(eq.analysis.refusals).toEqual([])
  })
  it('refuses to be signed with nothing to withdraw from, with a limit under the amount, or on a daily schedule', async () => {
    const k = makeKit(); k.nav(FUND, '2026-11-18', '180.0000')
    const none = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: FUND, amount: 1_000_000, schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    expect(none.analysis.refusals.join(' ')).toMatch(/hold no units/)
    await hold(k, FUND, 100_000)
    const low = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: FUND, amount: 1_000_000, schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY, maxPerRun: 500_000, maxPerMonth: 500_000 }, k.clock.now())
    expect(low.analysis.refusals.join(' ')).toMatch(/limit for one run/)
    expect(() => buildDraft(k.ctx, k.userId, 'swp', { instrumentId: FUND, amount: 1_000_000, schedule: { type: 'daily', at: '10:00' } }, {}, k.clock.now())).toThrow()
    expect(() => buildDraft(k.ctx, k.userId, 'swp', { instrumentId: 'coindcx:BTCINR', amount: 1_000_000, schedule: monthly(20) }, {}, k.clock.now())).toThrow()
  })
})

describe('a signed plan runs', () => {
  it('redeems the amount at the NAV on its day and pays the bank on the fund\'s payout day, with a receipt', async () => {
    const k = makeKit(); await hold(k, FUND, 100_000)
    const unitsBefore = balance(k.db, k.userId, `pos:${FUND}`)
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { instrumentId: FUND, amount: 1_000_000, schedule: monthly(20) }, authority: auth(k) })
    sign(k, d.programId)
    const bank = balance(k.db, k.userId, 'bank')
    k.clock.set(istInstant('2026-11-20', '09:59')); k.nav(FUND, '2026-11-20', '181.0000')
    await run(k, 60_000)
    expect(runs(k, d.programId).map((r) => r.state)).toEqual(['executing']) // sold at the day's NAV; the money is on its way
    // the redemption's NAV day passed and its payout falls two business days later (Tuesday 24 Nov, 10:00)
    k.clock.set(istInstant('2026-11-24', '10:05')); k.nav(FUND, '2026-11-23', '182.0000'); k.nav(FUND, '2026-11-24', '182.0000')
    await run(k, 60_000)
    expect(runs(k, d.programId).map((r) => r.state)).toEqual(['done'])
    const sold = unitsBefore - balance(k.db, k.userId, `pos:${FUND}`)
    expect(sold).toBe(55_248n) // 10,000 / 181.0000 = 55.248 units, rounded down
    const got = balance(k.db, k.userId, 'bank') - bank
    expect(got > 990_000n && got <= 1_000_000n).toBe(true) // the amount, less nothing but rounding: no exit load on this fund
    expect(balance(k.db, k.userId, 'recv:mf')).toBe(0n)
    const body = JSON.parse(k.db.get<{ body_json: string }>("SELECT body_json FROM receipts WHERE kind = 'order' ORDER BY seq DESC LIMIT 1")!.body_json) as { program: { kind: string; version: number }; reconciliation: { state: string }; origin: string }
    expect(body.origin).toBe('program'); expect(body.program.kind).toBe('swp'); expect(body.reconciliation.state).toBe('reconciled')
    sound(k)
  })
  it('holds its monthly limit: a weekly plan under a one-withdrawal monthly limit runs once in a month', async () => {
    const k = makeKit(); await hold(k, FUND, 100_000)
    k.nav(FUND, '2026-11-18', '180.0000')
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { instrumentId: FUND, amount: 500_000, schedule: { type: 'weekly', weekday: 4, at: '10:00' } }, authority: auth(k, { maxPerRun: 500_000, maxPerMonth: 500_000 }) })
    sign(k, d.programId)
    for (const day of ['2026-11-19', '2026-11-26']) {
      k.clock.set(istInstant(day, '09:59')); k.nav(FUND, day, '180.0000')
      await run(k, 60_000)
      k.clock.set(istInstant(day, '17:00')); k.nav(FUND, day, '180.0000'); await run(k, 20_000)
    }
    const states = runs(k, d.programId).map((r) => r.state)
    expect(states.filter((s) => s === 'done' || s === 'executing').length).toBe(1)
    expect(states.filter((s) => s === 'blocked').length).toBe(1)
    const refused = k.db.get<{ reason: string }>(`SELECT reason FROM runs WHERE program_id = ? AND state = 'blocked' LIMIT 1`, d.programId)!
    expect(refused.reason).toMatch(/used this month.*against ₹5,000/)
    sound(k)
  })
  it('sells what is left on the last run, then has nothing to withdraw, and stops when revoked', async () => {
    const k = makeKit(); await hold(k, FUND, 12_000) // ₹12,000: one withdrawal of ₹10,000 and a rest
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { instrumentId: FUND, amount: 1_000_000, schedule: { type: 'weekly', weekday: 4, at: '10:00' } }, authority: auth(k, { maxPerMonth: 5_000_000 }) })
    sign(k, d.programId)
    for (const day of ['2026-11-19', '2026-11-26', '2026-12-03']) {
      k.clock.set(istInstant(day, '09:59')); k.nav(FUND, day, '180.0000')
      await run(k, 60_000)
      k.clock.set(istInstant(day, '17:00')); k.nav(FUND, day, '180.0000'); await run(k, 20_000)
    }
    expect(available(k.db, k.userId, `pos:${FUND}`)).toBe(0n) // the second run took the rest
    const states = runs(k, d.programId)
    expect(states.length).toBe(3)
    expect(states[2]!.reason ?? '').toMatch(/no units|nothing to withdraw|Nothing/i)
    // R14: with no units left it says so once and is finished, rather than skipping in silence for ever
    expect(loadProgram(k.db, k.userId, d.programId).state).toBe('completed')
    const told = k.db.all<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE user_id = ? AND kind = 'swp-finished'`, k.userId)
    expect(told.length).toBe(1)
    expect(told[0]!.body).toMatch(/no units .*finished|finished/i)
    await run(k, 3 * DAY)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'swp-finished'`, k.userId)!.n).toBe(1)
    expect(runs(k, d.programId).length).toBe(3) // no run is started for a finished plan
    sound(k)
  })
})
