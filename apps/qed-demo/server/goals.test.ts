/**
 * Saving for a goal (R12 task comparison, gaps 5 and 14; criteria T3-a to T3-d): a name, an amount and a date become
 * a standing instruction, signed like every instruction, that moves QED's monthly figure into a set-aside inside the
 * household's own paper bank. The set-aside is an account of the ledger that no instruction debits: only the owner
 * releases it, with a confirmed approval of exact terms. Each contribution is an ordinary run, checked like every run
 * (limits, approval, pause and stop, and what must stay in the bank for what is due), with its reason on the record
 * when refused. Whether the goal is on track follows one stated rule, and when it is behind the remedies are figures
 * that reach the goal when followed.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { istInstant } from './core.ts'
import { stepAllActions } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { available, balance, post, verifyLedger } from './ledger.ts'
import { liquidity } from './liquidity.ts'
import { addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { activateProgram, buildDraft, kindSpec, loadProgram, pauseProgram, requestProgramApproval, resumeProgram, revokeProgram, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { cancelRun, requestRunApproval, runTick, schedulerTick, triggerTick } from './runner.ts'
import { defaultDay, goalNeeds, goalView, prepareRelease, releaseSetAside } from './goals.ts'
import { goalAccount } from './setaside.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'
import type { Authority } from './types.ts'
import { overview, worstCase } from './valuation.ts'
import { needsYou } from './views.ts'

const DAY = 86_400_000
const HOLIDAY = { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }
const DEC2 = istInstant('2026-12-02', '10:00')

async function cycle(k: Kit): Promise<void> {
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
/** Move the clock to an instant (never backwards) and let the engine run there. */
async function at(k: Kit, when: number): Promise<void> { k.clock.advance(Math.max(0, when - k.clock.now())); await cycle(k); await cycle(k) }
function sign(k: Kit, programId: string): void {
  // a test instruction that runs every few minutes under a small monthly limit: the owner accepts that contradiction here
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
function goal(k: Kit, params: Record<string, unknown> = HOLIDAY, authority: Partial<Authority> = {}): string {
  const d = saveDraft(k.ctx, k.userId, { kind: 'goal', params, authority })
  sign(k, d.programId)
  return d.programId
}
async function approveWaiting(k: Kit, programId: string): Promise<void> {
  const r = k.db.get<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'awaiting_approval'`, programId)!
  const req = requestRunApproval(k.ctx, k.userId, r.id)
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: req.docHash }, k.clock.now())
  await cycle(k); await cycle(k)
}
const setAside = (k: Kit, id: string): bigint => balance(k.db, k.userId, goalAccount(id))
const runs = (k: Kit, id: string) => k.db.all<{ id: string; state: string; reason: string | null }>('SELECT id, state, reason FROM runs WHERE program_id = ? ORDER BY created_at', id)
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }
/** The fields a refusal names; fails when nothing is refused. */
const refusedFields = (fn: () => unknown): Record<string, string> => { try { fn() } catch (e) { return (e as { fields?: Record<string, string> }).fields ?? {} } throw new Error('expected a refusal') }

describe('a goal becomes a standing instruction with QED\'s monthly figure', () => {
  it('works out the monthly figure, asks first by default, and binds its limits and end to the goal', () => {
    const k = makeKit()
    const d = buildDraft(k.ctx, k.userId, 'goal', HOLIDAY, { maxPerRun: 99_000_000, maxPerMonth: 99_000_000, expiresAt: T0 + 300 * DAY }, T0)
    // 18 Nov: contributions on the 2nd (the day after the salary on the 1st) fall on 2 Dec, 2 Jan, 2 Feb and 2 Mar
    expect(d.params).toMatchObject({ name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31', amount: 1_250_000, growthBps: 0, schedule: { type: 'monthly', day: 2, at: '10:00' } })
    expect(d.title).toBe('Save ₹50,000 for Holiday in Goa by 31 Mar 2027')
    // whatever limits were asked for, the bound is the goal's own: the monthly figure, until the end of its date
    expect(d.authority).toMatchObject({ maxPerRun: 1_250_000, maxPerMonth: 1_250_000, maxPerDay: null, maxRuns: 4, runMode: 'approve', expiresAt: istInstant('2027-03-31', '23:59') })
    // in all, its signed limits let it move the goal, not five calendar months of its monthly limit (₹62,500)
    expect(d.doc.ceilingPaise).toBe(5_000_000)
    expect(d.doc.limits).toContain('At most 4 runs in total.')
    expect(d.doc.may[0]).toBe('Move ₹12,500 from your bank account into the set-aside for Holiday in Goa on day 2 of each month, until 31 Mar 2027 or until ₹50,000 is set aside.')
    expect(d.doc.never).toContain('Spend, invest or pay anyone with the money set aside: no instruction can, this one included.')
    expect(d.doc.never).toContain('Move money out of the set-aside: only you can, with your passkey.')
    expect(d.analysis.headline).toBe('₹12,500 a month reaches ₹50,000 by 31 Mar 2027')
    expect(d.analysis.consequences.join(' ')).toMatch(/On track means: what is set aside now, plus every contribution still scheduled before 31 Mar 2027, reaches ₹50,000 on that date\. Growth: none counted\./)
    expect(d.analysis.refusals).toEqual([])
  })

  it('a goal saved as a draft before a contribution day and signed after it runs as signed', async () => {
    // its limits count the contributions left, so they are worked out again when it is signed; what is stored must be
    // what is signed, or the runner would refuse every run as terms that differ from the document (RISK-064)
    const k = makeKit()
    const d = saveDraft(k.ctx, k.userId, { kind: 'goal', params: HOLIDAY, authority: { runMode: 'auto' } })
    expect((d.draft.authority as Authority).maxRuns).toBe(4)
    await at(k, DEC2 + 60_000) // the 2 December contribution day passes while it is still a draft
    sign(k, d.programId)
    const v = k.db.get<{ authority_json: string; document: string }>(`SELECT authority_json, document FROM program_versions WHERE program_id = ? AND state = 'live'`, d.programId)!
    expect(JSON.parse(v.authority_json)).toEqual((JSON.parse(v.document) as { authority: unknown }).authority)
    expect((JSON.parse(v.authority_json) as Authority).maxRuns).toBe(3)
    await at(k, istInstant('2027-01-02', '10:00') + 1000)
    expect(runs(k, d.programId).map((r) => r.state)).toEqual(['done'])
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE kind = 'program-terms-differ'`)!.n).toBe(0)
    sound(k)
  })

  it('defaults to the day after the salary the books show, and to the 1st without one', () => {
    const k = makeKit()
    expect(defaultDay(k.db, k.userId)).toBe(2) // the profile's salary day is the 1st
    post(k.db, { userId: k.userId, ts: T0, effectiveTs: istInstant('2026-11-07', '09:30'), kind: 'income-salary', ref: 'salary:2026-11', memo: 'Salary (paper)', lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    expect(defaultDay(k.db, k.userId)).toBe(8) // the books show it arriving on the 7th
    const none = makeKit({ profile: { income: 0 } })
    expect(defaultDay(none.db, none.userId)).toBe(1)
    const late = makeKit({ profile: { incomeDay: 28 } })
    expect(defaultDay(late.db, late.userId)).toBe(1) // the day after the 28th that every month has
  })

  it('refuses a date that has passed, one beyond what an instruction may last, and one no contribution day falls before', () => {
    const k = makeKit()
    const draft = (params: Record<string, unknown>) => () => buildDraft(k.ctx, k.userId, 'goal', { ...HOLIDAY, ...params }, {}, T0)
    expect(refusedFields(draft({ date: '2026-11-17' })).date).toBe('Choose a date after today.')
    expect(refusedFields(draft({ date: '2027-12-31' })).date).toMatch(/^Choose a date no later than 18 Dec 2027: /)
    expect(refusedFields(draft({ date: '2026-11-30' })).date).toMatch(/^No contribution day falls between now and 30 Nov 2026/)
    expect(refusedFields(draft({ name: '  ' })).name).toBe('Say what it is for, in a few words.')
    expect(refusedFields(draft({ target: 99 })).target).toMatch(/at least ₹100/)
    expect(refusedFields(draft({ growthBps: 5_000 })).growthBps).toMatch(/from 0 to 1500/)
    expect(refusedFields(draft({ schedule: { type: 'monthly', day: 31, at: '10:00' } })).schedule).toMatch(/day from 1 to 28/)
  })

  it('counts growth only under the rate the household names, and says the set-aside earns nothing on paper', () => {
    const k = makeKit()
    const d = buildDraft(k.ctx, k.userId, 'goal', { ...HOLIDAY, growthBps: 600 }, {}, T0)
    expect(d.params).toMatchObject({ growthBps: 600 })
    expect((d.params as { amount: number }).amount).toBeLessThan(1_250_000)
    expect(d.analysis.consequences.join(' ')).toMatch(/Growth: 6\.00% a year, as you assume/)
    expect(d.analysis.warnings.join(' ')).toMatch(/earns no interest on paper/)
  })
})

describe('contributions, and the set-aside no instruction can spend', () => {
  it('a contribution asks first, then moves the monthly figure into the goal\'s own set-aside, on paper, with a receipt', async () => {
    const k = makeKit()
    const id = goal(k)
    const bank = balance(k.db, k.userId, 'bank')
    await at(k, DEC2 + 1000)
    expect(runs(k, id)[0]!.state).toBe('awaiting_approval')
    await approveWaiting(k, id)
    expect(runs(k, id)[0]!.state).toBe('done')
    expect(setAside(k, id)).toBe(1_250_000n)
    expect(balance(k.db, k.userId, 'bank')).toBe(bank - 1_250_000n)
    const a = k.db.get<{ params_json: string; receipt_id: string | null }>('SELECT params_json, receipt_id FROM actions WHERE program_id = ?', id)!
    expect(JSON.parse(a.params_json)).toMatchObject({ purpose: 'goal', goalId: id, payeeHandle: 'setaside@paperbank', payeeName: 'Holiday in Goa', amount: '1250000' })
    expect(a.receipt_id).toMatch(/^rcp/)
    sound(k)
  })

  it('is not free to use and no instruction can spend it, while the worst case and the net position still count it', async () => {
    const k = makeKit({ profile: { line: 0 } }) // no floor, so that what refuses the run below is what must stay in the bank
    const id = goal(k, HOLIDAY, { runMode: 'auto' })
    const before = { worst: worstCase(k.db, k.market, k.userId, k.clock.now()).gHat, net: overview(k.db, k.market, k.userId, k.clock.now()).netWorth }
    await at(k, DEC2 + 1000)
    expect(setAside(k, id)).toBe(1_250_000n)
    const now = k.clock.now()
    expect(worstCase(k.db, k.market, k.userId, now).gHat).toBe(before.worst)
    expect(worstCase(k.db, k.market, k.userId, now).setAside).toBe(1_250_000)
    expect(overview(k.db, k.market, k.userId, now)).toMatchObject({ netWorth: before.net, setAside: 1_250_000 })
    // what is free to use is the bank's own money beyond what must stay; the set-aside is not in it
    const l = liquidity(k.db, k.userId, now)
    expect(l.available).toBe(Number(available(k.db, k.userId, 'bank')))
    // spend everything that is free by hand; then an instruction's run finds nothing it may take, though the set-aside holds ₹12,500
    const payee = addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, now)
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: l.free })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    await cycle(k); k.clock.advance(3000); await cycle(k)
    k.nav('amfi:120716', '2026-12-01', '250.1234')
    const inv = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 5 } }, authority: { expiresAt: k.clock.now() + 10 * DAY, runMode: 'auto', maxPerRun: 100_000, maxPerMonth: 1_000_000 } })
    sign(k, inv.programId)
    await at(k, k.clock.now() + 61_000)
    const r = runs(k, inv.programId)[0]!
    expect(r.state).toBe('blocked')
    expect(r.reason).toMatch(/must stay for what is due/)
    expect(setAside(k, id)).toBe(1_250_000n)
    sound(k)
  })

  it('an instruction may move money only into its own set-aside', async () => {
    const k = makeKit()
    const a = goal(k)
    const b = goal(k, { name: 'New laptop', target: 8_000_000, date: '2027-06-30' })
    await at(k, DEC2 + 1000)
    // the plan of A's waiting run is altered to fill B's set-aside instead (as a fault or a tampered row would)
    const r = k.db.get<{ id: string; decision_json: string }>(`SELECT id, decision_json FROM runs WHERE program_id = ? AND state = 'awaiting_approval'`, a)!
    const dj = JSON.parse(r.decision_json) as { actions: { params: { goalId: string } }[] }
    dj.actions[0]!.params.goalId = b
    k.db.run('UPDATE runs SET decision_json = ? WHERE id = ?', JSON.stringify(dj), r.id)
    await approveWaiting(k, a)
    const act = k.db.get<{ state: string; error: string }>('SELECT state, error FROM actions WHERE program_id = ?', a)!
    expect(act.state).toBe('blocked')
    expect(act.error).toMatch(/only into its own set-aside/)
    expect(setAside(k, b)).toBe(0n)
    sound(k)
  })

  it('a contribution that would take money that must stay in the bank for what is due is refused, with the reason on the record', async () => {
    const k = makeKit({ opening: { ...DEFAULT_OPENING, bank: 5_000_000 } })
    const id = goal(k)
    await at(k, DEC2 + 1000)
    await approveWaiting(k, id)
    const r = runs(k, id)[0]!
    expect(r.state).toBe('blocked')
    expect(r.reason).toMatch(/^₹50,000 is available in the bank and this takes ₹12,500, leaving ₹37,500; ₹[\d,]+(\.\d\d)? must stay for what is due by \d+ \w+ \d{4}/)
    expect(setAside(k, id)).toBe(0n)
    expect(balance(k.db, k.userId, 'bank')).toBe(5_000_000n)
    sound(k)
  })

  it('pausing stops its runs; the goal then says it is behind, and resuming starts them again', async () => {
    const k = makeKit()
    const id = goal(k, HOLIDAY, { runMode: 'auto' })
    pauseProgram(k.ctx, k.userId, id)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'behind', paused: true, scheduled: { count: 0, amount: 0 } })
    await at(k, DEC2 + 1000)
    expect(runs(k, id)).toEqual([])
    expect(setAside(k, id)).toBe(0n)
    resumeProgram(k.ctx, k.userId, id)
    expect(loadProgram(k.db, k.userId, id).next_due_at).toBe(istInstant('2027-01-02', '10:00'))
  })
})

describe('on track, behind, and the remedies', () => {
  async function behind() {
    const k = makeKit()
    const id = goal(k)
    await at(k, DEC2 + 1000)
    cancelRun(k.ctx, k.userId, runs(k, id)[0]!.id) // the December contribution is declined
    return { k, id }
  }

  it('is on track by the stated rule while every contribution is still scheduled', () => {
    const k = makeKit()
    const id = goal(k)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({
      status: 'on-track', target: 5_000_000, setAside: 0, monthly: 1_250_000, day: 2, scheduled: { count: 4, amount: 5_000_000, first: '2026-12-02', last: '2027-03-02' },
      projected: 5_000_000, shortfall: 0, remedies: null,
      rule: 'On track means: what is set aside now, plus every contribution still scheduled before 31 Mar 2027, reaches ₹50,000 on that date. Growth: none counted.',
    })
  })

  it('behind: says by how much, what happens if nothing is done, and three remedies in figures', async () => {
    const { k, id } = await behind()
    const g = goalView(k.db, k.userId, id, k.clock.now())!
    expect(g).toMatchObject({ status: 'behind', projected: 3_750_000, shortfall: 1_250_000, scheduled: { count: 3, amount: 3_750_000 } })
    expect(g.remedies).toEqual({ more: { extra: 416_700, monthly: 1_666_700 }, later: { date: '2027-04-02' }, now: { amount: 1_250_000 } })
    expect(g.ifNothing).toBe('If you change nothing and every contribution still scheduled is made, ₹37,500 will be set aside by 31 Mar 2027, ₹12,500 short of ₹50,000. It stays set aside until you release it.')
    expect(g.remedyText).toBe('₹4,167 more a month, or 2 Apr 2027 instead of 31 Mar 2027, or ₹12,500 now.')
    // Home asks only about goals that are behind, as a need, with what happens if nothing is done
    const need = goalNeeds(k.db, k.userId, k.clock.now())
    expect(need).toEqual([expect.objectContaining({ type: 'goal-behind', programId: id, title: 'Holiday in Goa is behind', ifNothing: g.ifNothing })])
    expect(needsYou(k.db, k.userId, k.clock.now()).some((n) => n.type === 'goal-behind')).toBe(true)
  })

  it('applying "more a month" signs the figure it named, and the goal is on track again', async () => {
    const { k, id } = await behind()
    const g = goalView(k.db, k.userId, id, k.clock.now())!
    const d = saveDraft(k.ctx, k.userId, { programId: id, params: { name: g.name, target: g.target, date: g.date, schedule: { type: 'monthly', day: g.day, at: '10:00' }, growthBps: g.growthBps }, authority: {} })
    expect((d.draft.params as { amount: number }).amount).toBe(g.remedies!.more!.monthly)
    sign(k, id)
    // the last contribution takes only what is left: ₹16,667, ₹16,667 and ₹16,666
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'on-track', monthly: 1_666_700, projected: 5_000_000 })
    expect(goalNeeds(k.db, k.userId, k.clock.now())).toEqual([])
  })

  it('applying "a later date" signs that date, and the goal is on track again', async () => {
    const { k, id } = await behind()
    const g = goalView(k.db, k.userId, id, k.clock.now())!
    saveDraft(k.ctx, k.userId, { programId: id, params: { name: g.name, target: g.target, date: g.remedies!.later!.date, schedule: { type: 'monthly', day: g.day, at: '10:00' }, growthBps: g.growthBps, amount: g.monthly }, authority: {} })
    sign(k, id)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'on-track', date: '2027-04-02', monthly: 1_250_000, projected: 5_000_000 })
  })

  it('applying "a sum now" is a payment by hand into the set-aside, approved with the passkey, and the goal is on track again', async () => {
    const { k, id } = await behind()
    const g = goalView(k.db, k.userId, id, k.clock.now())!
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'goal', goalId: id, amount: g.remedies!.now!.amount })
    expect(pv.summary).toBe('Set aside ₹12,500 for Holiday in Goa')
    expect(pv.lines[0]).toMatchObject({ label: 'To', value: 'The set-aside for Holiday in Goa, inside your own bank' })
    expect(pv.worst.after).toBe(pv.worst.before) // moving money into one's own set-aside does not change the worst case
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    await cycle(k); await cycle(k)
    expect(setAside(k, id)).toBe(1_250_000n)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'on-track', projected: 5_000_000 })
    // a set-aside that is not the household's own goal is refused
    await expect(previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'goal', goalId: 'prg_nobody', amount: 10_000 })).rejects.toThrow(/Choose one of your goals/)
    sound(k)
  })
})

describe('reached, date passed, stopped, and releasing the money', () => {
  it('reaching the target completes the instruction and says the money stays set aside until released with the passkey', async () => {
    const k = makeKit()
    const id = goal(k, { name: 'School fees', target: 100_000, date: '2026-12-31' }, { runMode: 'auto' })
    await at(k, DEC2 + 1000)
    expect(setAside(k, id)).toBe(100_000n)
    expect(loadProgram(k.db, k.userId, id).state).toBe('completed')
    const n = k.db.get<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE kind = 'goal-reached'`)!
    expect(n.title).toBe('School fees: reached')
    expect(n.body).toBe('₹1,000 is set aside for School fees. Nothing more will be moved. It stays set aside until you release it, and releasing needs your passkey.')
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'reached', setAside: 100_000, remedies: null })
  })

  it('a contribution moves only what is left to reach the target, never past it', async () => {
    const k = makeKit()
    const id = goal(k, HOLIDAY, { runMode: 'auto' })
    // ₹45,000 set aside by hand first: the December contribution then moves ₹5,000, not the monthly ₹12,500
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'goal', goalId: id, amount: 4_500_000 })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    await cycle(k); await cycle(k)
    await at(k, DEC2 + 1000)
    const moved = k.db.all<{ amount: string }>(`SELECT json_extract(params_json, '$.amount') amount FROM actions WHERE program_id = ?`, id)
    expect(moved).toEqual([{ amount: '500000' }])
    expect(setAside(k, id)).toBe(5_000_000n)
    expect(loadProgram(k.db, k.userId, id).state).toBe('completed')
    sound(k)
  })

  it('when the date passes the instruction ends; the goal says what is set aside and that it stays until released', async () => {
    const k = makeKit()
    const id = goal(k, { name: 'Diwali gifts', target: 2_000_000, date: '2026-12-31' })
    await at(k, DEC2 + 1000)
    await approveWaiting(k, id) // one contribution of ₹20,000 was the whole plan; it is made
    expect(setAside(k, id)).toBe(2_000_000n)
    const id2 = goal(k, { name: 'New phone', target: 3_000_000, date: '2027-01-15' })
    await at(k, istInstant('2027-01-02', '10:00') + 1000)
    cancelRun(k.ctx, k.userId, runs(k, id2).find((r) => r.state === 'awaiting_approval')!.id)
    await at(k, istInstant('2027-01-16', '00:01'))
    expect(loadProgram(k.db, k.userId, id2).state).toBe('expired')
    const n = k.db.get<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE kind = 'program-expired' AND subject = ?`, id2)!
    expect(n.title).toBe('New phone: its date has passed')
    expect(n.body).toBe('The date for New phone, 15 Jan 2027, has passed with nothing set aside for it. Nothing more will be moved.')
    expect(goalView(k.db, k.userId, id2, k.clock.now())).toMatchObject({ status: 'date-passed', remedies: null })
    expect(goalNeeds(k.db, k.userId, k.clock.now())).toEqual([])
  })

  it('releasing needs the owner\'s confirmed approval of the exact terms, moves the money back once, and is recorded', async () => {
    const k = makeKit()
    const id = goal(k, HOLIDAY, { runMode: 'auto' })
    await at(k, DEC2 + 1000)
    const bank = balance(k.db, k.userId, 'bank')
    // more than is set aside is refused before anything is prepared
    expect(() => prepareRelease(k.ctx, k.userId, id, { amount: 1_250_001 })).toThrow(/Only ₹12,500 is set aside/)
    const p = prepareRelease(k.ctx, k.userId, id, {})
    const doc = JSON.parse(p.document) as { kind: string; sizePaise: number; from: string; to: string }
    expect(doc).toMatchObject({ kind: 'goal-release', sizePaise: 1_250_000, from: 'The set-aside for Holiday in Goa', to: 'Your bank account' })
    expect(p.requiresStepUp).toBe(true)
    // not confirmed: nothing moves
    expect(() => releaseSetAside(k.ctx, k.userId, id, p.approvalId)).toThrow(/Confirm the approval with your passkey first/)
    confirmApproval(k.db, k.userId, p.approvalId, { method: 'passkey', docHash: p.docHash }, k.clock.now())
    const out = releaseSetAside(k.ctx, k.userId, id, p.approvalId)
    expect(out).toMatchObject({ released: 1_250_000, setAside: 0 })
    expect(setAside(k, id)).toBe(0n)
    expect(balance(k.db, k.userId, 'bank')).toBe(bank + 1_250_000n)
    // once: the same approval cannot release again
    expect(() => releaseSetAside(k.ctx, k.userId, id, p.approvalId)).toThrow(/already been used/)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE kind = 'goal-release'`)!.n).toBe(1)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE action = 'goal.release' AND subject = ?`, id)!.n).toBe(1)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM receipts WHERE kind = 'goal-release'`)!.n).toBe(1)
    // the goal carries on as signed: with the money released it is behind
    expect(goalView(k.db, k.userId, id, k.clock.now())!.status).toBe('behind')
    sound(k)
  })

  it('a goal that ended by itself, its money later released, says so rather than that the owner stopped it', async () => {
    const k = makeKit()
    const id = goal(k, { name: 'School fees', target: 100_000, date: '2026-12-31' }, { runMode: 'auto' })
    await at(k, DEC2 + 1000) // reached: the instruction completes
    const p = prepareRelease(k.ctx, k.userId, id, {})
    confirmApproval(k.db, k.userId, p.approvalId, { method: 'passkey', docHash: p.docHash }, k.clock.now())
    releaseSetAside(k.ctx, k.userId, id, p.approvalId)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'stopped', state: 'completed', ifNothing: 'Every contribution it was signed for has been made, and nothing is set aside. To save the rest, write a new goal.' })
  })

  it('an ended goal with money set aside stays on Save until it is released', async () => {
    const k = makeKit()
    const id = goal(k, HOLIDAY, { runMode: 'auto' })
    await at(k, DEC2 + 1000)
    revokeProgram(k.ctx, k.userId, id)
    expect(goalView(k.db, k.userId, id, k.clock.now())).toMatchObject({ status: 'stopped', setAside: 1_250_000, remedies: null })
    expect(goalView(k.db, k.userId, id, k.clock.now())!.ifNothing).toBe('You stopped saving for this. ₹12,500 stays set aside until you release it, and releasing needs your passkey.')
  })
})

describe('gap 14: what a hand-written instruction assumes when the owner has not said', () => {
  it('asks each time, for every kind', () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '5400.12')
    k.btc(6_600_000)
    const payee = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', nameCheckAccepted: 'unknown' }, T0) // the paper bank does not know it: its answer confirmed, as the form asks
    const kinds: [string, Record<string, unknown>][] = [
      ['invest', { instrumentId: 'amfi:120716', amount: 500_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }],
      ['sweep', { instrumentId: 'amfi:118701', keep: 20_000_000, minMove: 1_000_000 }],
      ['bills', { payeeHandles: [payee.handle], capPerBill: 500_000 }],
      ['exit', { instrumentId: 'coindcx:BTCINR', mode: 'trail', trailPct: 5 }],
      ['floor', { buffer: 0 }],
      ['rebalance', { legs: [{ instrumentId: 'amfi:120716', weightBps: 7000 }, { instrumentId: 'amfi:119788', weightBps: 3000 }], bandBps: 500, schedule: { type: 'weekly', weekday: 1, at: '11:00' } }],
      ['split', { rules: [{ to: 'card', shareBps: 1000 }], minIncome: 500_000 }],
      ['goal', HOLIDAY],
    ]
    for (const [kind, params] of kinds) expect([kind, kindSpec(kind).suggestAuthority(k.ctx, k.userId, kindSpec(kind).parse(k.ctx, k.userId, params, T0), T0).runMode]).toEqual([kind, 'approve'])
  })

  it('a protective sale that asks first says it may come too late', () => {
    const k = makeKit()
    const d = buildDraft(k.ctx, k.userId, 'floor', { buffer: 0 }, {}, T0)
    expect(d.authority.runMode).toBe('approve')
    expect(d.analysis.warnings.join(' ')).toMatch(/asks you before it sells/)
  })

  it('the idle-cash sweep\'s default limits are what is free after what must stay, not the whole bank', () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '5400.12')
    const l = liquidity(k.db, k.userId, T0)
    expect(l.free).toBeGreaterThan(0)
    expect(l.free).toBeLessThan(l.available)
    const d = buildDraft(k.ctx, k.userId, 'sweep', { instrumentId: 'amfi:118701', keep: 20_000_000, minMove: 1_000_000 }, {}, T0)
    const cap = Math.ceil(l.free / 100_000) * 100_000
    expect(d.authority).toMatchObject({ maxPerRun: cap, maxPerMonth: cap, runMode: 'approve' })
    expect(d.authority.maxPerRun).toBeLessThan(Number(balance(k.db, k.userId, 'bank')))
    // a household with nothing free still gets a limit a move can be made under, the smallest move it named
    const short = makeKit({ opening: { ...DEFAULT_OPENING, bank: 5_000_000 } })
    short.nav('amfi:118701', '2026-11-17', '5400.12')
    expect(buildDraft(short.ctx, short.userId, 'sweep', { instrumentId: 'amfi:118701', keep: 1_000_000, minMove: 1_000_000 }, {}, T0).authority).toMatchObject({ maxPerRun: 1_000_000, maxPerMonth: 1_000_000 })
  })
})
