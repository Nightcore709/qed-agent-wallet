/**
 * The liquidity-aware withdrawal plan (R14, capability 8): the order in which a plan sells from several holdings, the floor it
 * never goes below, each fund's settlement day, the signed plan's binding, a run where a source has become unusable, and runs
 * that are the same after a restart. Every figure is paper: NAVs are test fixtures.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { istInstant } from './core.ts'
import { createAction, stepAllActions } from './execute.ts'
import { available, balance, verifyLedger } from './ledger.ts'
import { activateProgram, buildDraft, loadProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import type { Authority } from './types.ts'
import { planWithdrawal } from './withdrawal.ts'
import { readFileSync } from 'node:fs'
import { requestRunApproval } from './runner.ts'

const INDEX = 'amfi:120716' // equity index fund: no exit load; payout 2 business days
const LIQ = 'amfi:118701' // liquid fund: graded exit load in the first six days; payout 1 business day
const OVER = 'amfi:119110' // overnight fund: no exit load; payout 1 business day
const DAY = 86_400_000

function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
async function cycle(k: Kit): Promise<void> {
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx); runTick(k.ctx)
}
async function run(k: Kit, ms: number, stepMs = 5000): Promise<void> { for (let t = 0; t < ms; t += stepMs) { k.clock.advance(stepMs); await cycle(k) } }
async function hold(k: Kit, id: string, rupees: number, nav = '100.0000', date = '2026-11-18', tag = ''): Promise<void> {
  k.nav(id, date, nav)
  const eid = `seed-${id}${tag}`
  createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid, params: { instrumentId: id, side: 'buy', type: 'nav', amount: String(rupees * 100), purpose: 'manual' }, approvalId: k.approveOwner(`action:${eid}`) })
  await settle(k, 8, 1000)
}
const monthly = (day: number) => ({ type: 'monthly' as const, day, at: '10:00' })
const auth = (k: Kit, extra: Partial<Authority> = {}) => ({ expiresAt: k.clock.now() + 60 * DAY, runMode: 'auto', ...extra })
const runs = (k: Kit) => k.db.all<{ id: string; state: string; reason: string | null }>('SELECT id, state, reason FROM runs ORDER BY created_at, due_at')
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }
const scope = (sources: string[], reserve = 0, needByDays: number | null = null) => ({ sources, reserve, needByDays })
const RS = (n: number) => n * 100
/** A kit holding each fund with the same NAV on its day, so that gains and losses are only the stamp duty. */
async function held(funds: [string, number][], navs: Record<string, string> = {}): Promise<Kit> {
  const k = makeKit()
  for (const [id, r] of funds) await hold(k, id, r, navs[id] ?? '100.0000')
  return k
}

describe('the order a withdrawal sells in', () => {
  it('takes the fund whose money arrives soonest first when no fund has an exit load or a short-term gain', async () => {
    const k = await held([[INDEX, 50_000], [OVER, 50_000]])
    k.clock.advance(20 * DAY)
    for (const id of [INDEX, OVER]) k.nav(id, '2026-12-08', '100.0000')
    const w = planWithdrawal(k.ctx, k.userId, scope([INDEX, OVER]), RS(10_000), k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([OVER]) // one business day beats two
    expect(w.legs[0]!.gross).toBeGreaterThan(RS(10_000) - 100)
    expect(w.shortfall).toBe(0)
    expect(w.left.find((l) => l.instrumentId === INDEX)?.kind).toBe('covered')
    expect(w.legs[0]!.why).toMatch(/no exit load on the units to be sold.*1 business day/)
  })
  it('passes over a liquid fund still in its exit-load days for one with no load, even though it pays sooner', async () => {
    const k = await held([[LIQ, 50_000], [INDEX, 50_000]])
    // units bought today are inside the liquid fund's graded load
    const w = planWithdrawal(k.ctx, k.userId, scope([LIQ, INDEX]), RS(10_000), k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([INDEX])
    expect(w.legs[0]!.exitLoad).toBe(0)
    expect(w.left.find((l) => l.instrumentId === LIQ)?.kind).toBe('covered')
    // the same funds ten days on: the load has gone, so the liquid fund is first again
    k.clock.advance(10 * DAY)
    const later = planWithdrawal(k.ctx, k.userId, scope([LIQ, INDEX]), RS(10_000), k.clock.now())
    expect(later.legs.map((l) => l.instrumentId)).toEqual([LIQ])
    expect(later.legs[0]!.exitLoad).toBe(0)
  })
  it('uses a costly fund only for what the cheaper ones cannot cover, and says so', async () => {
    const k = await held([[LIQ, 50_000], [INDEX, 4_000]])
    const w = planWithdrawal(k.ctx, k.userId, scope([LIQ, INDEX]), RS(10_000), k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([INDEX, LIQ])
    expect(w.legs[0]!.last).toBe(true) // every unit of the no-cost fund
    expect(w.legs[1]!.exitLoad).toBeGreaterThan(0)
    expect(w.legs[1]!.why).toMatch(/inside the exit-load period.*no other usable fund could cover/)
    expect(Math.abs(w.planned - RS(10_000))).toBeLessThan(200) // rounding to a thousandth of a unit
    expect(w.shortfall).toBe(0)
  })
  it('is deterministic: the same records give the same plan every time', async () => {
    const k = await held([[LIQ, 30_000], [INDEX, 30_000], [OVER, 3_000]])
    const a = planWithdrawal(k.ctx, k.userId, scope([INDEX, LIQ, OVER]), RS(8_000), k.clock.now())
    const b = planWithdrawal(k.ctx, k.userId, scope([OVER, INDEX, LIQ]), RS(8_000), k.clock.now())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('the reserve is never sold', () => {
  it('stops at the reserve and says what is still owed', async () => {
    const k = await held([[INDEX, 12_000]])
    k.nav(INDEX, '2026-11-18', '100.0000')
    const all = planWithdrawal(k.ctx, k.userId, scope([INDEX]), RS(10_000), k.clock.now())
    const w = planWithdrawal(k.ctx, k.userId, scope([INDEX], RS(5_000)), RS(10_000), k.clock.now())
    expect(w.planned).toBeLessThanOrEqual(all.valueNow - RS(5_000))
    expect(w.keptAfter).toBeGreaterThanOrEqual(RS(5_000))
    expect(w.shortfall).toBeGreaterThan(0)
    expect(w.owed).toBe(true)
    expect(w.shortfallWhy.join(' ')).toMatch(/reserve of ₹5,000 is kept/)
  })
  it('never lets any combination of funds go below the reserve, across several amounts and reserves', async () => {
    const k = await held([[INDEX, 20_000], [OVER, 7_000], [LIQ, 9_000]])
    for (const reserve of [0, RS(1), RS(9_999), RS(18_000), RS(30_000), RS(60_000)]) for (const target of [RS(500), RS(10_000), RS(17_500), RS(40_000)]) {
      const w = planWithdrawal(k.ctx, k.userId, scope([INDEX, OVER, LIQ], reserve), target, k.clock.now())
      expect(w.planned).toBeLessThanOrEqual(target)
      expect(w.valueNow - w.planned).toBeGreaterThanOrEqual(Math.min(reserve, w.valueNow))
    }
  })
})

describe('each fund\'s settlement day against the day the money is needed', () => {
  it('leaves out a fund whose money would arrive too late and reports the shortfall rather than selling it', async () => {
    const k = await held([[OVER, 4_000], [INDEX, 50_000]])
    k.clock.set(istInstant('2026-11-20', '11:00')) // a Friday, before the 3 pm cut-off
    for (const id of [OVER, INDEX]) k.nav(id, '2026-11-20', '100.0000')
    const w = planWithdrawal(k.ctx, k.userId, scope([OVER, INDEX], 0, 1), RS(10_000), k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([OVER]) // the index fund pays two business days on: too late
    expect(w.legs[0]!.settlesAt).toBeLessThanOrEqual(w.neededBy!)
    expect(w.left.find((l) => l.instrumentId === INDEX)?.kind).toBe('late')
    expect(w.shortfall).toBeGreaterThan(RS(5_000))
    expect(w.owed).toBe(true)
    expect(w.shortfallWhy.join(' ')).toMatch(/Index Fund.*after .*the latest you need it/)
    // with a longer wait, the same two funds cover it, the quick one first
    const wide = planWithdrawal(k.ctx, k.userId, scope([OVER, INDEX], 0, 3), RS(10_000), k.clock.now())
    expect(wide.legs.map((l) => l.instrumentId)).toEqual([OVER, INDEX])
    expect(wide.shortfall).toBe(0)
    for (const l of wide.legs) expect(l.settlesAt).toBeLessThanOrEqual(wide.neededBy!)
  })
  it('is refused at the draft when no chosen fund could ever pay in time', async () => {
    const k = await held([[INDEX, 50_000]])
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, amount: RS(1_000), schedule: monthly(20), needByDays: 1 }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    expect(d.analysis.refusals.join(' ')).toMatch(/would find no chosen fund able to pay within 1 business day/)
    expect(() => buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, amount: RS(1_000), schedule: monthly(20), needByDays: 99 }, {}, k.clock.now())).toThrow()
  })
})

describe('the plan the owner sees before approving, and what the passkey signs', () => {
  it('shows each holding, its units, amount, settlement date and costs, in the draft and in the signed document', async () => {
    const k = await held([[INDEX, 4_000], [LIQ, 50_000]])
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, alsoFrom: [LIQ], reserve: RS(2_000), amount: RS(10_000), schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    const w = (d.analysis.preview as { withdrawal: ReturnType<typeof planWithdrawal> }).withdrawal
    expect(w.legs.map((l) => l.instrumentId)).toEqual([INDEX, LIQ])
    for (const l of w.legs) { expect(l.units).toMatch(/^\d+$/); expect(l.settlesAt).toBeGreaterThan(k.clock.now()); expect(l.gross).toBeGreaterThan(0); expect(l.navProvider).toBeTruthy() }
    expect(d.analysis.figures.find((f) => f.label === 'Kept back, never sold')!.value).toBe('₹2,000')
    expect(d.doc.may[0]).toMatch(/UTI Nifty 50 Index Fund, Nippon India Liquid Fund, in the order the rule below gives/)
    expect(d.doc.limits.join(' ')).toMatch(/less than ₹2,000 is left/)
    expect(d.doc.conditions.join(' ')).toMatch(/Order of sale \(rule 1\): .*inside the exit-load period goes last/)
    expect(d.doc.never).toContain('Sell any holding not named above.')
    expect(d.title).toMatch(/from 2 funds/)
  })
  it('keeps a single-fund plan\'s document exactly as it was, with no extra terms', async () => {
    const k = await held([[INDEX, 50_000]])
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, amount: RS(10_000), schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    expect(d.params).toEqual({ instrumentId: INDEX, amount: RS(10_000), schedule: { ...monthly(20), zone: 'Asia/Kolkata' } }) // no rule version, no added terms
    expect(d.doc.may[0]).toMatch(/^Redeem units of UTI Nifty 50 Index Fund \(Direct, Growth\) worth ₹10,000 at the latest NAV/)
    expect(d.doc.conditions.join(' ')).not.toMatch(/Order of sale/)
  })
  it('binds the sources: a signed plan runs only its own funds, and an amendment adding one is not used until it is signed', async () => {
    const k = await held([[INDEX, 50_000], [OVER, 50_000]])
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { instrumentId: INDEX, amount: RS(5_000), schedule: monthly(20) }, authority: auth(k) })
    sign(k, d.programId)
    const v1 = k.db.get<{ content_hash: string; document: string }>('SELECT content_hash, document FROM program_versions WHERE program_id = ? AND version = 1', d.programId)!
    // the same plan with a second fund is a different document with a different fingerprint
    const v2 = saveDraft(k.ctx, k.userId, { programId: d.programId, params: { instrumentId: INDEX, alsoFrom: [OVER], amount: RS(5_000), schedule: monthly(20) }, authority: auth(k) })
    expect(v2.version).toBe(2)
    const h2 = k.db.get<{ content_hash: string; document: string }>('SELECT content_hash, document FROM program_versions WHERE program_id = ? AND version = 2', d.programId)!
    expect(h2.content_hash).not.toBe(v1.content_hash)
    expect(h2.document).toMatch(/Overnight Fund/); expect(v1.document).not.toMatch(/Overnight Fund/)
    // the first version's approval cannot put the second in force
    const oldApproval = k.db.get<{ id: string }>(`SELECT id FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, k.userId)!.id
    expect(() => activateProgram(k.ctx, k.userId, d.programId, oldApproval)).toThrow()
    expect(loadProgram(k.db, k.userId, d.programId).live_version).toBe(1)
    k.clock.set(istInstant('2026-11-20', '09:59'))
    for (const id of [INDEX, OVER]) k.nav(id, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const sold = k.db.all<{ instrument_id: string }>(`SELECT json_extract(params_json, '$.instrumentId') instrument_id FROM actions WHERE origin = 'program'`).map((r) => r.instrument_id)
    expect(sold).toEqual([INDEX]) // the overnight fund was never in the signed plan
    sound(k)
  })
})

describe('a signed plan runs across holdings', () => {
  const setup = async (funds: [string, number][], p: Record<string, unknown>, a: Partial<Authority> = {}) => {
    const k = await held(funds)
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { amount: RS(10_000), schedule: monthly(20), ...p }, authority: auth(k, { maxPerMonth: RS(100_000), ...a }) })
    sign(k, d.programId)
    return { k, id: d.programId }
  }
  it('sells every leg, pays the bank on each fund\'s own day, and records each sale with its settlement', async () => {
    const { k, id } = await setup([[OVER, 4_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER] })
    const bank = balance(k.db, k.userId, 'bank')
    k.clock.set(istInstant('2026-11-20', '09:59'))
    for (const f of [OVER, INDEX]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    expect(runs(k).map((r) => r.state)).toEqual(['executing'])
    const acts = k.db.all<{ instrument_id: string; swp: string; state: string }>(`SELECT json_extract(params_json, '$.instrumentId') instrument_id, json_extract(params_json, '$.swpPaise') swp, state FROM actions WHERE program_id = ? ORDER BY economic_id`, id)
    expect(acts.map((a) => a.instrument_id)).toEqual([OVER, INDEX])
    expect(acts.reduce((s, a) => s + Number(a.swp), 0)).toBe(RS(10_000)) // the legs' limits add up to the amount, no more
    // each fund pays on its own day: the overnight fund before the index fund
    k.clock.set(istInstant('2026-11-23', '10:05')); for (const f of [OVER, INDEX]) { k.nav(f, '2026-11-22', '100.0000'); k.nav(f, '2026-11-23', '100.0000') }
    await run(k, 30_000)
    expect(runs(k).map((r) => r.state)).toEqual(['executing']) // the index fund's money is still on its way
    k.clock.set(istInstant('2026-11-24', '10:05')); k.nav(INDEX, '2026-11-24', '100.0000'); k.nav(OVER, '2026-11-24', '100.0000')
    await run(k, 60_000)
    expect(runs(k).map((r) => `${r.state} ${r.reason}`)).toEqual(['done null'])
    expect(available(k.db, k.userId, `pos:${OVER}`)).toBe(0n) // the overnight fund's last units went first
    const got = balance(k.db, k.userId, 'bank') - bank
    expect(got > BigInt(RS(10_000) - 1_000) && got <= BigInt(RS(10_000))).toBe(true)
    expect(balance(k.db, k.userId, 'recv:mf')).toBe(0n)
    const receipts = k.db.all<{ body_json: string }>(`SELECT body_json FROM receipts WHERE kind = 'order' ORDER BY seq DESC LIMIT 2`).map((r) => JSON.parse(r.body_json) as { program: { kind: string }; reconciliation: { state: string } })
    expect(receipts.map((r) => r.program.kind)).toEqual(['swp', 'swp']); expect(receipts.every((r) => r.reconciliation.state === 'reconciled')).toBe(true)
    sound(k)
  })
  it('with a source that can no longer be used, sells only from the others, ends partial and says what is still owed', async () => {
    const { k, id } = await setup([[OVER, 50_000], [INDEX, 4_000]], { instrumentId: INDEX, alsoFrom: [OVER] })
    // after signing, the overnight fund's NAV feed is gone: its units cannot be priced, so it cannot be used
    k.db.run('DELETE FROM quotes WHERE instrument_id = ?', OVER); (k.market as unknown as { latest: Map<string, unknown> }).latest.delete(`${OVER}|nav`)
    expect(k.market.get(OVER, 'nav')).toBeUndefined()
    k.clock.set(istInstant('2026-11-20', '09:59'))
    k.nav(INDEX, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const progActions = k.db.all<{ i: string }>(`SELECT json_extract(params_json, '$.instrumentId') i FROM actions WHERE program_id = ?`, id).map((r) => r.i)
    expect(progActions).toEqual([INDEX]) // the fallback stays inside the approved funds; nothing is sold unpriced
    k.clock.set(istInstant('2026-11-24', '10:05')); k.nav(INDEX, '2026-11-23', '100.0000'); k.nav(INDEX, '2026-11-24', '100.0000')
    await run(k, 60_000)
    const [r] = runs(k)
    expect(r!.state).toBe('partial')
    expect(r!.reason).toMatch(/of the ₹10,000 was not withdrawn this run, and later runs do not make it up: .*Overnight Fund.*No NAV has been received/)
    expect(available(k.db, k.userId, `pos:${OVER}`)).toBeGreaterThan(0n) // nothing was sold from it
    const note = k.db.get<{ decision_json: string }>('SELECT decision_json FROM runs')!.decision_json
    expect(JSON.parse(note).summary.at(-1)).toMatch(/later runs do not make it up/)
    sound(k)
  })
  it('refuses with a plain reason when no source can be used', async () => {
    const { k } = await setup([[OVER, 50_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER] })
    k.clock.set(istInstant('2026-11-20', '09:59')) // no NAV has been received for either fund today, but earlier ones exist; make the price unavailable instead
    for (const f of [OVER, INDEX]) createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: `sell-${f}`, params: { instrumentId: f, side: 'sell', type: 'nav', qty: available(k.db, k.userId, `pos:${f}`).toString(), purpose: 'manual' }, approvalId: k.approveOwner(`action:sell-${f}`) })
    await settle(k, 8, 1000)
    k.clock.set(istInstant('2026-11-20', '09:59'))
    await run(k, 60_000)
    const [r] = runs(k)
    expect(r!.state).toBe('skipped')
    expect(r!.reason).toMatch(/hold no units of any of the funds/)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'program'`)!.n).toBe(0)
  })
  it('is the same after a restart: a second engine over the same records makes no second sale', async () => {
    const { k, id } = await setup([[OVER, 4_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER] }, { runMode: 'auto' })
    k.clock.set(istInstant('2026-11-20', '09:59'))
    for (const f of [OVER, INDEX]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const snap = () => JSON.stringify({ acts: k.db.all(`SELECT economic_id, params_json FROM actions WHERE program_id = ? ORDER BY economic_id`, id), orders: k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders WHERE client_ref LIKE ?', `${id}%`), runs: runs(k).length })
    const before = snap()
    const heldNow = [available(k.db, k.userId, `pos:${OVER}`), available(k.db, k.userId, `pos:${INDEX}`)]
    const restarted = { ...k.ctx } // a new engine over the same database, as after a restart
    for (let i = 0; i < 6; i++) { schedulerTick(restarted); triggerTick(restarted); runTick(restarted); await stepAllActions(restarted) }
    expect(snap()).toBe(before)
    expect([available(k.db, k.userId, `pos:${OVER}`), available(k.db, k.userId, `pos:${INDEX}`)]).toEqual(heldNow)
    expect(JSON.parse(before).acts).toHaveLength(2)
    sound(k)
  })
})

const NR = { [INDEX]: '171.2345', [OVER]: '3701.2345' } // non-round NAVs: a round NAV hides rounding leftovers
const setupWith = async (funds: [string, number][], p: Record<string, unknown>, a: Partial<Authority> = {}, navs: Record<string, string> = {}) => {
  const k = await held(funds, navs)
  const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { amount: RS(10_000), schedule: monthly(20), ...p }, authority: auth(k, { maxPerMonth: RS(100_000), ...a }) })
  sign(k, d.programId)
  return { k, id: d.programId }
}
const approveRun = (k: Kit, runId: string) => { const req = requestRunApproval(k.ctx, k.userId, runId); confirmApproval(k.db, k.userId, req.approvalId, { method: 'session', docHash: sha256hex(req.document) }, k.clock.now()) }
const manualSell = async (k: Kit, id: string, eid: string, milli: bigint) => { createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid, params: { instrumentId: id, side: 'sell', type: 'nav', qty: milli.toString(), purpose: 'manual' }, approvalId: k.approveOwner(`action:${eid}`) }); await settle(k, 8, 1000) }

describe('F1: the reserve and the needed-by day are tested again when each sale is sent', () => {
  it('refuses a leg when a sale by hand during the wait for approval took the funds below the signed reserve', async () => {
    const { k, id } = await setupWith([[INDEX, 10_000], [OVER, 10_000]], { instrumentId: INDEX, alsoFrom: [OVER], reserve: RS(9_000) }, { runMode: 'approve' })
    k.clock.set(istInstant('2026-11-20', '09:59')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const r = runs(k)[0]!; expect(r.state).toBe('awaiting_approval')
    await manualSell(k, INDEX, 'by-hand', available(k.db, k.userId, `pos:${INDEX}`) - 10_000n) // leaves ₹100 of the index fund
    approveRun(k, r.id)
    await run(k, 20_000)
    const a = k.db.all<{ state: string; error: string | null }>('SELECT state, error FROM actions WHERE program_id = ?', id)
    expect(a[0]!.state).toBe('blocked') // the large leg: selling it would leave ₹1,100 against a ₹9,000 reserve
    expect(a[0]!.error).toMatch(/against the signed reserve of ₹9,000/)
    // only the rounding-sized second leg, which left the reserve intact, is sent: the blocked one moved nothing
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM pv_orders WHERE side = 'sell' AND client_ref LIKE ?", `${id}%`)!.n).toBe(1)
    sound(k)
  })
  it('refuses a leg approved after the cut-off whose money would now pay after the day it was needed by', async () => {
    const { k, id } = await setupWith([[OVER, 20_000], [INDEX, 20_000]], { instrumentId: INDEX, alsoFrom: [OVER], needByDays: 1, schedule: { type: 'monthly', day: 20, at: '14:55' } }, { runMode: 'approve' })
    k.clock.set(istInstant('2026-11-20', '14:54')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const r = runs(k)[0]!; expect(r.state).toBe('awaiting_approval')
    k.clock.set(istInstant('2026-11-20', '15:30')) // after the cut-off: the redemption is now for the next business day
    approveRun(k, r.id)
    await run(k, 20_000)
    const a = k.db.all<{ state: string; error: string | null }>('SELECT state, error FROM actions WHERE program_id = ?', id)
    expect(a.map((x) => x.state)).toEqual(['blocked'])
    expect(a[0]!.error).toMatch(/Sent now, this sale pays .*; the money was to reach your bank by /)
    sound(k)
  })
  it('lets the same leg through when nothing changed (approved before the cut-off, reserve intact)', async () => {
    const { k, id } = await setupWith([[OVER, 20_000], [INDEX, 20_000]], { instrumentId: INDEX, alsoFrom: [OVER], needByDays: 1, reserve: RS(5_000), schedule: { type: 'monthly', day: 20, at: '14:00' } }, { runMode: 'approve' })
    k.clock.set(istInstant('2026-11-20', '13:59')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    approveRun(k, runs(k)[0]!.id)
    await run(k, 20_000)
    expect(k.db.all<{ state: string }>('SELECT state FROM actions WHERE program_id = ?', id).map((x) => x.state)).not.toContain('blocked')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE program_id = ?', id)!.n).toBe(1)
  })
})

describe('F2: a run\'s limit counts every withdrawal leg together', () => {
  it('refuses an extra leg that a second engine planned differently for the same occurrence', async () => {
    const { k, id } = await setupWith([[OVER, 4_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER] })
    k.clock.set(istInstant('2026-11-20', '09:59')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const runId = runs(k)[0]!.id
    createAction(k.ctx, { userId: k.userId, origin: 'program', runId, programId: id, kind: 'order', venue: 'paper-mf', economicId: `${id}#other-engine#9`, params: { instrumentId: INDEX, side: 'sell', type: 'nav', qty: '10000', purpose: 'swp', swpPaise: String(RS(5_000)) }, approvalId: null })
    await stepAllActions(k.ctx)
    const extra = k.db.get<{ state: string; error: string | null }>('SELECT state, error FROM actions WHERE economic_id = ?', `${id}#other-engine#9`)!
    expect(extra.state).toBe('blocked')
    expect(extra.error).toMatch(/already in this run plus/)
  })
})

describe('F3: the deadline does not stop a run on a weekend or after the cut-off', () => {
  it('runs on a Saturday, counting from the next business day', async () => {
    const { k, id } = await setupWith([[OVER, 4_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER], needByDays: 2, schedule: monthly(21) })
    k.clock.set(istInstant('2026-11-21', '09:59')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    expect(runs(k)[0]!.state).toBe('executing')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE program_id = ?', id)!.n).toBe(2)
  })
  it('runs after 15:00 on a business day', async () => {
    const { k, id } = await setupWith([[OVER, 4_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER], needByDays: 2, schedule: { type: 'monthly', day: 20, at: '16:00' } })
    k.clock.set(istInstant('2026-11-20', '15:59')); for (const f of [INDEX, OVER]) k.nav(f, '2026-11-20', '100.0000')
    await run(k, 60_000)
    expect(runs(k)[0]!.state).toBe('executing')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE program_id = ?', id)!.n).toBe(2)
  })
  it('refuses at drafting a deadline that no day on the schedule could meet, and accepts one that every day can', async () => {
    const k = await held([[INDEX, 50_000]])
    for (const schedule of [monthly(21), { type: 'monthly' as const, day: 20, at: '16:00' }]) {
      const bad = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, amount: RS(1_000), schedule, needByDays: 1 }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
      expect(bad.analysis.refusals.join(' ')).toMatch(/would find no chosen fund able to pay within 1 business day/)
      const ok = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, amount: RS(1_000), schedule, needByDays: 2 }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
      expect(ok.analysis.refusals).toEqual([])
    }
  })
  it('tells the owner when a run is skipped and leaves money not withdrawn, once', async () => {
    const { k } = await setupWith([[OVER, 50_000], [INDEX, 50_000]], { instrumentId: INDEX, alsoFrom: [OVER] })
    k.db.run('DELETE FROM quotes'); (k.market as unknown as { latest: Map<string, unknown> }).latest.clear()
    k.clock.set(istInstant('2026-11-20', '09:59'))
    await run(k, 60_000)
    const r = runs(k)[0]!
    expect(r.state).toBe('skipped'); expect(r.reason).toMatch(/not withdrawn, and later runs do not make it up.*No NAV has been received/)
    const n = k.db.all<{ title: string; body: string }>("SELECT title, body FROM notices WHERE kind = 'run-owed'")
    expect(n).toHaveLength(1); expect(n[0]!.body).toMatch(/later runs do not make it up/)
  })
})

describe('F4, F5: rounding leftovers are not sales; a reserve shortfall is reported (non-round NAVs)', () => {
  it('does not sell a few paise from the next fund after a fund covers all but rounding', async () => {
    const k = await held([[OVER, 10_000], [INDEX, 50_000]], NR)
    const w = planWithdrawal(k.ctx, k.userId, scope([OVER, INDEX]), RS(10_000) - 30, k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([OVER])
    expect(w.shortfall).toBe(0)
    const near = planWithdrawal(k.ctx, k.userId, scope([OVER, INDEX]), RS(10_000), k.clock.now())
    expect(near.legs.map((l) => l.instrumentId)).toEqual([OVER]) // the value is a little under ₹10,000 after stamp duty: under a thousandth of a unit and a paisa short? it is the rounding gap of the sale
  })
  it('reports a shortfall caused by the reserve even when a few paise of room remain after rounding', async () => {
    const k = await held([[INDEX, 12_000]], NR)
    for (const reserve of [RS(5_000), RS(5_001), RS(2_000) + 37]) {
      const w = planWithdrawal(k.ctx, k.userId, scope([INDEX], reserve), RS(10_000), k.clock.now())
      expect(w.valueNow - w.planned).toBeGreaterThanOrEqual(reserve)
      expect(w.shortfall).toBeGreaterThan(0)
      expect(w.owed).toBe(true)
      expect(w.shortfallWhy.join(' ')).toMatch(/reserve of .* is kept/)
    }
  })
})

describe('F6, F7: the order is judged on the units to be sold, and is liquidity-aware', () => {
  it('judges the exit load on the first-in units a leg would sell, not on the whole holding', async () => {
    const k = makeKit()
    await hold(k, LIQ, 50_000, '100.0000', '2026-11-18', 'a')
    k.clock.advance(9 * DAY)
    await hold(k, LIQ, 1_000, '100.0000', '2026-11-27', 'b') // a small new lot inside the load period
    await hold(k, INDEX, 50_000, '100.0000', '2026-11-27')
    expect(available(k.db, k.userId, `pos:${INDEX}`)).toBeGreaterThan(0n)
    const w = planWithdrawal(k.ctx, k.userId, scope([INDEX, LIQ]), RS(5_000), k.clock.now())
    expect(w.legs.map((l) => l.instrumentId)).toEqual([LIQ]) // the old lot is sold first: no load on those units
    expect(w.legs[0]!.exitLoad).toBe(0)
  })
  it('puts a fund inside its exit-load period last, then the soonest payout, then the lower cost, then the name', async () => {
    const k = makeKit()
    await hold(k, LIQ, 20_000, '100.0000', '2026-11-18', 'a'); k.clock.advance(9 * DAY) // aged: no load
    await hold(k, OVER, 20_000, '100.0000', '2026-11-27'); await hold(k, INDEX, 20_000, '100.0000', '2026-11-27')
    for (const f of [LIQ, OVER, INDEX]) expect(available(k.db, k.userId, `pos:${f}`)).toBeGreaterThan(0n)
    const aged = planWithdrawal(k.ctx, k.userId, scope([INDEX, LIQ, OVER]), RS(55_000), k.clock.now())
    expect(aged.legs.map((l) => l.instrumentId)).toEqual([OVER, LIQ, INDEX]) // both pay in 1 day; a slab-taxed gain is unknown for both, so the name decides; the 2-day fund is last
    const k2 = makeKit()
    await hold(k2, LIQ, 20_000); await hold(k2, OVER, 20_000); await hold(k2, INDEX, 20_000)
    const fresh = planWithdrawal(k2.ctx, k2.userId, scope([INDEX, LIQ, OVER]), RS(55_000), k2.clock.now())
    expect(fresh.legs.map((l) => l.instrumentId)).toEqual([OVER, INDEX, LIQ]) // the liquid fund, still inside its load, goes last
  })
})

describe('F8: a rule version is signed and enforced', () => {
  it('writes the version into a new multi-fund plan, refuses another, and refuses to plan one it does not implement', async () => {
    const k = await held([[INDEX, 50_000], [OVER, 50_000]])
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, alsoFrom: [OVER], amount: RS(5_000), schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    expect(d.params).toMatchObject({ withdrawalRule: 1 })
    expect(d.doc.conditions.join(' ')).toMatch(/Order of sale \(rule 1\)/)
    expect(() => buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, alsoFrom: [OVER], amount: RS(5_000), schedule: monthly(20), withdrawalRule: 2 }, {}, k.clock.now())).toThrow()
    expect(() => planWithdrawal(k.ctx, k.userId, { sources: [INDEX, OVER], reserve: 0, needByDays: null, ruleVersion: 2 }, RS(5_000), k.clock.now())).toThrow(/does not implement/)
  })
})

describe('F9 to F11: the wording and the unchanged single-fund plan', () => {
  it('says what a plan with added funds can and cannot do, truthfully', async () => {
    const k = await held([[INDEX, 50_000], [OVER, 4_000]])
    const d = buildDraft(k.ctx, k.userId, 'swp', { instrumentId: INDEX, alsoFrom: [OVER], reserve: RS(1_000), needByDays: 1, amount: RS(10_000), schedule: monthly(20) }, { expiresAt: k.clock.now() + 60 * DAY }, k.clock.now())
    const text = JSON.stringify([d.analysis, d.doc])
    expect(text).not.toMatch(/sells what is left and ends|would sell everything|sell everything above your reserve/)
    expect(text).toMatch(/Not withdrawn this run|not withdrawn this run, and later runs do not make it up/i)
    // only the quick fund can pay within a day and its value less the reserve is under one withdrawal: it covers none
    expect(d.analysis.figures.find((f) => f.label === 'Withdrawals the units cover')!.value).toBe('0')
    expect(d.analysis.figures.find((f) => f.label === 'Exit load')!.note).toMatch(/^HDFC Overnight Fund/)
    const tax = d.analysis.figures.find((f) => f.label === 'Tax on the gain in a withdrawal')!.value
    expect(tax).toMatch(/slab rate, no figure, on HDFC Overnight Fund/)
  })
  it('keeps a single-fund plan\'s whole document and analysis exactly as before the change', async () => {
    const k = makeKit(); k.nav(INDEX, '2026-11-18', '180.0000')
    createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: 's', params: { instrumentId: INDEX, side: 'buy', type: 'nav', amount: '10000000', purpose: 'manual' }, approvalId: k.approveOwner('action:s') })
    await settle(k, 8, 1000)
    const d = saveDraft(k.ctx, k.userId, { kind: 'swp', params: { instrumentId: INDEX, amount: 1_000_000, schedule: monthly(20) }, authority: { expiresAt: k.clock.now() + 60 * DAY, runMode: 'approve' } })
    const r = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
    const gold = JSON.parse(readFileSync(new URL('./swp-legacy-document.fixture.json', import.meta.url), 'utf8')) as { document: string; hash: string; analysis: unknown }
    expect(r.draft.document).toBe(gold.document)
    expect(r.draft.contentHash).toBe(gold.hash)
    expect(JSON.parse(JSON.stringify(r.draft.analysis))).toEqual(gold.analysis)
  })
  it('keeps a single-fund plan\'s run as before: the target is the reported amount, and a fund no longer tradable blocks the run', async () => {
    const { k, id } = await setupWith([[INDEX, 50_000]], { instrumentId: INDEX })
    k.clock.set(istInstant('2026-11-20', '09:59')); k.nav(INDEX, '2026-11-20', '100.0000')
    await run(k, 60_000)
    const swpPaise = k.db.get<{ s: string }>(`SELECT json_extract(params_json, '$.swpPaise') s FROM actions WHERE program_id = ?`, id)!.s
    expect(swpPaise).toBe(String(RS(10_000)))
    const k2 = (await setupWith([[INDEX, 50_000]], { instrumentId: INDEX })).k
    const id2 = k2.db.get<{ id: string }>('SELECT id FROM programs')!.id
    k2.db.run("UPDATE instruments SET tradable = 0 WHERE id = ?", INDEX)
    k2.clock.set(istInstant('2026-11-20', '09:59')); k2.nav(INDEX, '2026-11-20', '100.0000')
    await run(k2, 60_000)
    expect(runs(k2).map((r) => r.state)).toEqual(['blocked']) // as before: a blocked run with its reason, not a skipped one
    expect(id2).toBeTruthy()
  })
})
