import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { istInstant, whenIst } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { DEFAULT_OPENING, householdModel, saveProfile } from './household.ts'
import { balance, post, verifyLedger } from './ledger.ts'
import { activateProgram, buildDraft, ceilingPaise, currentAnalysis, amountText, loadProgram, nextDue, pauseProgram, requestProgramApproval, resumeProgram, revokeProgram, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { cancelRun, clearStop, requestRunApproval, runTick, schedulerTick, setStop, triggerTick } from './runner.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'
import type { Authority } from './types.ts'
import { worstCase } from './valuation.ts'
import { sinceView } from './views.ts'
import { storeProposal } from './ai.ts'

const DAY = 86_400_000
const BANK = BigInt(DEFAULT_OPENING.bank)

/** One engine cycle at the current time. `prices` re-publishes fresh quotes first, as a live feed would. */
async function cycle(k: Kit, prices?: () => void): Promise<void> {
  prices?.()
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
async function run(k: Kit, ms: number, prices?: () => void, stepMs = 5000): Promise<void> {
  for (let t = 0; t < ms; t += stepMs) { k.clock.advance(stepMs); await cycle(k, prices) }
}
function sign(k: Kit, programId: string): string {
  // Test fixtures often run often under a small monthly limit on purpose; the owner accepts that contradiction here.
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
  return req.approvalId
}
function start(k: Kit, kind: string, params: unknown, authority: Partial<Authority> = {}): string {
  // These journeys exercise an instruction that runs on its own. Since R12 (task comparison, gap 14) a hand-written
  // instruction asks each time unless the owner chooses otherwise, so the fixture chooses, as the owner would.
  const d = saveDraft(k.ctx, k.userId, { kind, params, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto', ...authority } })
  sign(k, d.programId)
  return d.programId
}
const runs = (k: Kit, programId: string) => k.db.all<{ state: string; reason: string | null; occurrence: string }>('SELECT state, reason, occurrence FROM runs WHERE program_id = ? ORDER BY created_at, due_at', programId)
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }
const btc = (k: Kit, price = 6_600_000) => () => k.btc(price)

describe('schedules', () => {
  it('computes the next occurrence in India time', () => {
    const wed1030 = T0
    expect(nextDue({ type: 'daily', at: '10:00' }, wed1030)).toBe(istInstant('2026-11-19', '10:00'))
    expect(nextDue({ type: 'daily', at: '11:00' }, wed1030)).toBe(istInstant('2026-11-18', '11:00'))
    expect(nextDue({ type: 'weekly', weekday: 1, at: '09:00' }, wed1030)).toBe(istInstant('2026-11-23', '09:00'))
    expect(nextDue({ type: 'monthly', day: 5, at: '10:00' }, wed1030)).toBe(istInstant('2026-12-05', '10:00'))
    expect(nextDue({ type: 'monthly', day: 28, at: '10:00' }, istInstant('2026-12-28', '10:00'))).toBe(istInstant('2027-01-28', '10:00'))
    expect(nextDue({ type: 'every', minutes: 15 }, wed1030 + 1000)).toBe(wed1030 + 15 * 60_000)
    expect(nextDue({ type: 'once', at: wed1030 - 1 }, wed1030)).toBe(null)
  })
  it('writes the sums in documents, reasons and figures as whole rupees or to the paisa', () => {
    expect(amountText(2_000_000)).toBe('₹20,000')
    expect(amountText(80_610_880)).toBe('₹8,06,108.80') // was ₹8,06,108.8 on the page of a standing instruction
    expect(amountText(174_420n)).toBe('₹1,744.20')
    expect(amountText(-500)).toBe('−₹5')
    expect(amountText(118, 2)).toBe('₹1.18')
    expect(amountText(2_000_000, 2)).toBe('₹20,000.00') // asked for to the paisa, as the cost of a purchase is
  })
  it('states the most an authority can ever move', () => {
    const a: Authority = { maxPerRun: 500_000, maxPerDay: null, maxPerMonth: 1_000_000, expiresAt: istInstant('2027-01-10', '00:00'), runMode: 'auto', noticeSec: 0, maxSlippageBps: 100, maxRuns: null }
    expect(ceilingPaise(a, T0)).toBe(3_000_000) // November, December, January
    expect(ceilingPaise({ ...a, maxRuns: 4 }, T0)).toBe(2_000_000)
  })
})

describe('a program from draft to receipts', () => {
  it('runs on schedule, within its signed authority, and records the version it ran under', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 2 } }, { maxPerRun: 100_000, maxPerMonth: 1_000_000 })
    expect(loadProgram(k.db, k.userId, id).state).toBe('active')
    await run(k, 5 * 60_000, btc(k))
    const rs = runs(k, id)
    expect(rs.length).toBe(3) // next whole minute, then every two minutes
    expect(rs.every((r) => r.state === 'done')).toBe(true)
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR') > 0n).toBe(true)
    const spent = BANK - balance(k.db, k.userId, 'bank')
    expect(spent > 0n && spent <= 300_000n).toBe(true)
    const body = JSON.parse(k.db.get<{ body_json: string }>("SELECT body_json FROM receipts WHERE kind = 'order' ORDER BY seq LIMIT 1")!.body_json) as { program: { version: number; contentHash: string; occurrence: string }; origin: string }
    expect(body.origin).toBe('program')
    expect(body.program.version).toBe(1)
    expect(body.program.contentHash).toMatch(/^[0-9a-f]{64}$/)
    sound(k)
  })

  it('a duplicate tick, a second scheduler or a restart cannot run an occurrence twice', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 5 } })
    k.clock.advance(61_000); k.btc(6_600_000)
    for (let i = 0; i < 5; i++) { schedulerTick(k.ctx); runTick(k.ctx) }
    k.db.run('UPDATE programs SET next_due_at = ? WHERE id = ?', k.clock.now() - 1000, id) // the same occurrence delivered again
    k.db.run("UPDATE runs SET state = 'due' WHERE program_id = ?", id)                    // a restart that re-plans the same run
    await cycle(k, btc(k)); await cycle(k, btc(k))
    expect(runs(k, id).length).toBe(1)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE program_id = ?', id)!.n).toBe(1)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders')!.n).toBe(1)
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM entries WHERE kind = 'buy'")!.n).toBe(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_fills')!.n)
    sound(k)
  })

  it('refuses a run that would exceed the monthly limit, and says which limit', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 100_000, maxPerMonth: 250_000 })
    await run(k, 4 * 60_000 + 5000, btc(k))
    const rs = runs(k, id)
    expect(rs.filter((r) => r.state === 'done').length).toBe(2)
    const blocked = rs.filter((r) => r.state === 'blocked')
    expect(blocked.length).toBeGreaterThanOrEqual(1)
    expect(blocked[0]!.reason).toMatch(/used this month/)
    expect(BANK - balance(k.db, k.userId, 'bank') <= 250_000n).toBe(true)
    sound(k)
  })

  it('refuses a run that would exceed the daily limit, says which limit, and runs again the next day', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 100_000, maxPerMonth: 5_000_000, maxPerDay: 250_000 })
    await run(k, 4 * 60_000 + 5000, btc(k))
    const rs = runs(k, id)
    expect(rs.filter((r) => r.state === 'done').length).toBe(2)
    const blocked = rs.filter((r) => r.state === 'blocked')
    expect(blocked.length).toBeGreaterThanOrEqual(1)
    expect(blocked[0]!.reason).toMatch(/used today/)
    expect(BANK - balance(k.db, k.userId, 'bank') <= 250_000n).toBe(true)
    // Past midnight in India the day's room is back.
    k.clock.set(Date.parse('2026-11-18T18:31:00Z'))   // 19 November, 00:01 IST
    await run(k, 90_000, btc(k))
    expect(runs(k, id).filter((r) => r.state === 'done').length).toBeGreaterThanOrEqual(3)
    sound(k)
  })

  it('an action of an instruction outside what was signed is refused when it is decided: more than a run may move, or another instrument', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 100_000, maxPerMonth: 5_000_000 })
    await run(k, 65_000, btc(k))
    const first = k.db.get<{ id: string; run_id: string }>('SELECT id, run_id FROM actions WHERE program_id = ? ORDER BY created_at LIMIT 1', id)!
    // Planned actions come from the signed parameters, so the engine never produces these two. They are put on the
    // books here as a faulty or tampered planner would, under a run that is still open, to show the decision refuses them.
    const openRun = () => { const rid = `run_test_${Math.random().toString(36).slice(2)}`; k.db.run(`INSERT INTO runs (id, user_id, program_id, version, occurrence, state, trigger_json, due_at, created_at, started_at) SELECT ?, user_id, program_id, version, ?, 'executing', '{}', ?, ?, ? FROM runs WHERE id = ?`, rid, rid, k.clock.now(), k.clock.now(), k.clock.now(), first.run_id); return rid }
    const tooBig = createAction(k.ctx, { userId: k.userId, runId: openRun(), programId: id, origin: 'program', kind: 'order', venue: 'paper-crypto', economicId: 'forged-size', params: { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '100001', purpose: 'invest' } })
    k.nav('amfi:120716', '2026-11-17', '178.8713')   // so that the fund can be priced and only the scope stands in the way
    const other = createAction(k.ctx, { userId: k.userId, runId: openRun(), programId: id, origin: 'program', kind: 'order', venue: 'paper-mf', economicId: 'forged-instrument', params: { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: '100000', purpose: 'invest' } })
    await stepAllActions(k.ctx)
    const failing = (aid: string) => getAction(k.db, aid)!.policy.checks!.filter((c) => !c.ok).map((c) => c.name)
    expect([getAction(k.db, tooBig.id)!.state, failing(tooBig.id)]).toEqual(['blocked', ['within-run-limit']])
    expect([getAction(k.db, other.id)!.state, failing(other.id)]).toEqual(['blocked', ['instrument-in-scope']])
    sound(k)
  })

  it('a limit on the number of runs counts runs still in progress: a fund bought every half hour, three times in all, is bought three times and no more', async () => {
    // Found by an adversarial review on 20 November 2026. A fund order stays in progress until the fund publishes
    // its price, a day later. The run count was only read after a run had finished, so the schedule kept starting
    // purchases: "at most 3 runs in all" was signed, and every half hour another ₹1,000 left the bank.
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const id = start(k, 'invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 30 } }, { maxPerRun: 100_000, maxPerMonth: 5_000_000, maxRuns: 3 })
    await run(k, 4 * 3600_000, undefined, 60_000)
    const acts = k.db.all<{ state: string }>('SELECT state FROM actions WHERE program_id = ?', id)
    expect(acts.map((a) => a.state)).toEqual(['working', 'working', 'working'])
    expect(balance(k.db, k.userId, 'clear:mf')).toBe(300_000n)
    const all = runs(k, id)
    expect(all.filter((r) => r.state === 'executing').length).toBe(3)
    const held = all.filter((r) => r.state === 'skipped')
    expect(held.length).toBeGreaterThanOrEqual(4)
    expect(held[0]!.reason).toBe('This instruction may run 3 times in all, and 3 runs are done or still in progress. Nothing was started.')
    // When the price is published the three complete, and the instruction ends at its limit.
    k.clock.advance(20 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '180.0000')
    await run(k, 120_000, undefined, 30_000)
    expect(runs(k, id).filter((r) => r.state === 'done').length).toBe(3)
    expect(k.db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', id)!.state).toBe('completed')
    expect(k.db.all('SELECT 1 FROM actions WHERE program_id = ?', id).length).toBe(3)
    sound(k)
  })

  it('occurrences that fell due while the engine was not running are recorded as missed and never executed', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 10 } })
    k.clock.advance(35 * 60_000) // the engine was off for 35 minutes
    await cycle(k, btc(k))
    const rs = runs(k, id)
    expect(rs.filter((r) => r.state === 'missed').length).toBe(4)
    expect(rs.find((r) => r.state === 'missed')!.reason).toMatch(/not running/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM notices WHERE kind = 'runs-missed'")!.n).toBe(1)
    await run(k, 6 * 60_000, btc(k)) // back on: the next occurrence runs normally
    expect(runs(k, id).filter((r) => r.state === 'done').length).toBe(1)
    // Off again. The owner still has one notice about missed runs, kept current, not one for every gap.
    k.db.run("UPDATE notices SET resolved_at = ? WHERE kind = 'runs-missed'", k.clock.now()) // they had dismissed the first
    k.clock.advance(25 * 60_000)
    await cycle(k, btc(k))
    const missed = runs(k, id).filter((r) => r.state === 'missed').length
    expect(missed).toBeGreaterThan(4)
    const notes = k.db.all<{ title: string; resolved_at: number | null }>("SELECT title, resolved_at FROM notices WHERE kind = 'runs-missed'")
    expect(notes.length).toBe(1)
    expect(notes[0]!.resolved_at).toBeNull()
    expect(notes[0]!.title).toContain(`${missed} scheduled runs were missed in the last 24 hours`)
  })

  it('revoking while a run waits for approval withdraws the request with the run', async () => {
    // Found live on 20 Nov 2026: the passbook kept asking to approve a run of an instruction that had been revoked.
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 10 } }, { runMode: 'approve' })
    await run(k, 65_000, btc(k))
    expect(runs(k, id)[0]!.state).toBe('awaiting_approval')
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM notices WHERE kind = 'run-approval' AND resolved_at IS NULL")!.n).toBe(1)
    revokeProgram(k.ctx, k.userId, id)
    expect(runs(k, id)[0]!.state).toBe('cancelled')
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM notices WHERE kind = 'run-approval' AND resolved_at IS NULL")!.n).toBe(0)
  })

  it('an instruction that asks first asks once: later occurrences are not queued behind an unanswered request', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 5 } }, { runMode: 'approve' })
    await run(k, 16 * 60_000, btc(k), 20_000)
    const rs = runs(k, id)
    expect(rs.filter((r) => r.state === 'awaiting_approval').length).toBe(1)
    expect(rs.filter((r) => r.state === 'skipped').length).toBeGreaterThanOrEqual(2)
    expect(rs.find((r) => r.state === 'skipped')!.reason).toMatch(/still waiting for you/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0)
  })

  it('a run that wakes on stale prices waits briefly, is then refused, and tells the owner once', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 10 } })
    await run(k, 65_000, undefined, 5000) // the first occurrence falls due; no fresh price arrives, the feed is silent
    expect(runs(k, id)[0]!.state).toBe('executing') // its order is waiting for a price, inside the bounded wait
    expect(k.db.get<{ state: string }>('SELECT state FROM actions')!.state).toBe('planned')
    await run(k, 50_000, undefined, 5000)
    expect(runs(k, id)[0]!.state).toBe('blocked')
    expect(runs(k, id)[0]!.reason).toMatch(/received .* s ago/)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    const notes = k.db.all<{ kind: string }>("SELECT kind FROM notices WHERE resolved_at IS NULL AND kind IN ('run-blocked', 'action-blocked')")
    expect(notes.map((n) => n.kind)).toEqual(['run-blocked']) // one notice for one refusal
    sound(k)
  })
})

describe('what follows from an instruction in force', () => {
  it('is worked out on today\'s records, while the figures that were signed stay in the document', () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '250.1234')
    const id = start(k, 'invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'daily', at: '11:00' } }, { maxPerRun: 100_000, maxPerMonth: 3_100_000 })
    const signed = k.db.get<{ analysis_json: string; document: string }>('SELECT analysis_json, document FROM program_versions WHERE program_id = ? AND version = 1', id)!
    const spare = (a: { figures: { label: string; value: string }[] } | null) => a?.figures.find((f) => f.label === 'Spare each month before this')?.value
    expect(spare(JSON.parse(signed.analysis_json))).toBe('₹20,000') // ₹1,20,000 less ₹70,000 of spending and ₹30,000 of instalments
    // Later the owner records more spending. The page must not go on saying ₹20,000.
    saveProfile(k.db, k.userId, { spending: 8_500_000 })
    k.clock.advance(3 * 3_600_000)
    const now = currentAnalysis(k.ctx, k.userId, id, k.clock.now())!
    expect(spare(now)).toBe('₹5,000')
    expect(now.computedAt).toBe(k.clock.now())
    expect(now.figures.some((f) => f.label === 'Next run')).toBe(true)
    expect(now.figures.some((f) => f.label === 'First run')).toBe(false)
    // The signed document and its stored figures are untouched.
    expect(k.db.get<{ analysis_json: string; document: string }>('SELECT analysis_json, document FROM program_versions WHERE program_id = ? AND version = 1', id)).toEqual(signed)
    revokeProgram(k.ctx, k.userId, id)
    expect(currentAnalysis(k.ctx, k.userId, id, k.clock.now())).toBeNull()
    expect(currentAnalysis(k.ctx, 'usr_other', id, k.clock.now())).toBeNull()
  })

  it('names the time the engine will really run it next, and none while it is paused', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 30 } }, { maxPerRun: 20_000, maxPerMonth: 2_000_000 })
    const due = () => k.db.get<{ next_due_at: number | null }>('SELECT next_due_at FROM programs WHERE id = ?', id)!.next_due_at
    const next = () => currentAnalysis(k.ctx, k.userId, id, k.clock.now())!.figures.filter((f) => f.label === 'Next run').map((f) => f.value)
    const first = due()!
    // Seven minutes on, nothing has ticked: a draft written now would first run at the next whole minute, but this
    // instruction is the one already due. The page must give the engine's time, which is the header's time too.
    k.clock.advance(7 * 60_000 + 20_000)
    expect(next()).toEqual([whenIst(first)])
    // After a run the engine moves the time on by the interval. The figure follows it.
    k.db.run('UPDATE programs SET next_due_at = ? WHERE id = ?', first + 30 * 60_000, id)
    expect(next()).toEqual([whenIst(first + 30 * 60_000)])
    // Paused, it does not run next at all, so the figure is not there to say that it does.
    pauseProgram(k.ctx, k.userId, id)
    expect(next()).toEqual([])
    expect(currentAnalysis(k.ctx, k.userId, id, k.clock.now())!.figures.some((f) => f.label === 'First run')).toBe(false)
  })

  it('says what can leave the bank in a month under the limit, not what the schedule alone would ask for', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const every2 = { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 2 } }
    const leaves = (d: { analysis: { figures: { label: string; value: string; note?: string }[] } }) => d.analysis.figures.find((f) => f.label === 'Leaves your bank each month')!
    // ₹200 every two minutes asks for ₹43,20,000 a month. Under a monthly limit of ₹20,000, ₹20,000 is what can leave.
    const capped = buildDraft(k.ctx, k.userId, 'invest', every2, { maxPerRun: 20_000, maxPerMonth: 2_000_000, expiresAt: k.clock.now() + 30 * DAY }, k.clock.now())
    expect(leaves(capped).value).toBe('₹20,000')
    expect(leaves(capped).note).toMatch(/schedule asks for ₹43,20,000/)
    expect(leaves(capped).note).toMatch(/monthly limit stops it at ₹20,000/)
    // The household has ₹20,000 a month to spare and at most ₹20,000 can leave: there is nothing to warn about there.
    expect(capped.analysis.warnings.filter((w) => /to spare/.test(w))).toEqual([])
    expect(capped.analysis.warnings.some((w) => /monthly limit is ₹20,000: later runs in a month will be refused/.test(w))).toBe(true)
    // A limit that lets more leave than the household has to spare is the case to warn about, with the figure that can leave.
    const loose = buildDraft(k.ctx, k.userId, 'invest', every2, { maxPerRun: 20_000, maxPerMonth: 5_000_000, expiresAt: k.clock.now() + 30 * DAY }, k.clock.now())
    expect(leaves(loose).value).toBe('₹50,000')
    expect(loose.analysis.warnings.filter((w) => /to spare/.test(w))).toEqual(['This can take up to ₹50,000 a month; after your recorded spending, bills and instalments you have about ₹20,000 a month to spare.'])
    // A schedule inside its limit is unchanged: the figure is what the schedule takes.
    const daily = buildDraft(k.ctx, k.userId, 'invest', { ...every2, amount: 50_000, schedule: { type: 'daily', at: '11:00' } }, { maxPerRun: 50_000, maxPerMonth: 2_000_000, expiresAt: k.clock.now() + 30 * DAY }, k.clock.now())
    expect(leaves(daily).value).toBe('₹15,208') // ₹500 on 365 days, a twelfth of it: an average, so to the rupee
    expect(leaves(daily).note).not.toMatch(/stops it/)
  })
})

describe('an amount the venue cannot fill', () => {
  it('cannot be signed: the venue fills whole steps and has a smallest order', async () => {
    const k = makeKit()
    k.btc(6_600_000) // one step of 0.00001 BTC is ₹66.005 at the ask of ₹66,00,500; two steps are ₹132.01, and the fee of 0.59% comes out of the amount
    const tooSmall = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 10_000, schedule: { type: 'daily', at: '11:00' } }, { expiresAt: T0 + 30 * DAY }, T0)
    expect(tooSmall.analysis.refusals.join(' ')).toMatch(/₹100 buys less than the venue's smallest order of ₹100.*Each run needs at least ₹133\./)
    expect(() => { const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 10_000, schedule: { type: 'daily', at: '11:00' } }, authority: { expiresAt: T0 + 30 * DAY, runMode: 'auto' } }); requestProgramApproval(k.ctx, k.userId, d.programId) }).toThrow(/smallest order/)
    const enough = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 13_300, schedule: { type: 'daily', at: '11:00' } }, { expiresAt: T0 + 30 * DAY }, T0)
    expect(enough.analysis.refusals).toEqual([])
    // and the amount said to be enough does fill at the venue
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 13_300, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 13_300, maxPerMonth: 1_000_000 })
    await run(k, 65_000, btc(k))
    expect(runs(k, id)[0]!.state).toBe('done')
  })
})

describe('an account of an absence', () => {
  it('says from the records what was done, missed and refused since a moment, and nothing from before it', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 100_000, maxPerMonth: 300_000 })
    await run(k, 125_000, btc(k)) // two runs done
    const left = k.clock.now()
    const bankThen = balance(k.db, k.userId, 'bank')
    await run(k, 125_000, btc(k)) // one more done, then the monthly limit refuses the next
    const s = sinceView(k.db, k.userId, left, k.clock.now())
    const all = runs(k, id)
    expect(all.filter((r) => r.state === 'done').length).toBe(3)
    expect(s.done).toBe(1)
    expect(s.refused).toBe(all.filter((r) => r.state === 'blocked').length)
    expect(s.refused).toBeGreaterThanOrEqual(1)
    expect(s.missed).toBe(0)
    expect(s.byInstruction).toEqual([{ id, title: 'Invest ₹1,000 in Bitcoin in rupees', n: 1, moved: Number(bankThen - balance(k.db, k.userId, 'bank')) }])
    expect((s.refusedWhy as { reason: string }[])[0]!.reason).toMatch(/used this month/)
    // Asking about a time before the account existed, or in the future, is brought back into range.
    expect(sinceView(k.db, k.userId, 0, k.clock.now()).done).toBe(3)
    expect(sinceView(k.db, k.userId, k.clock.now() + 1e9, k.clock.now()).done).toBe(0)
    expect(sinceView(k.db, 'usr_other', left, k.clock.now()).done).toBe(0)
  })
})

describe('approval binding', () => {
  it('an approval is for one exact document: amending after approval, reusing or skipping confirmation is refused', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto' } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
    expect(() => activateProgram(k.ctx, k.userId, d.programId, req.approvalId)).toThrow(/not been confirmed/)
    expect(() => confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: 'f'.repeat(64) }, k.clock.now())).toThrow(/does not match/)
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
    // The owner approved ₹1,000 a day. Someone swaps the draft for ₹9,000 a day before activation.
    saveDraft(k.ctx, k.userId, { programId: d.programId, params: { instrumentId: 'coindcx:BTCINR', amount: 900_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto' } })
    expect(() => activateProgram(k.ctx, k.userId, d.programId, req.approvalId)).toThrow(/something else|changed after you approved/)
    expect(loadProgram(k.db, k.userId, d.programId).state).toBe('draft')
    const id2 = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } })
    const used = k.db.get<{ approval_id: string }>('SELECT approval_id FROM program_versions WHERE program_id = ?', id2)!.approval_id
    const d3 = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto' } })
    expect(() => activateProgram(k.ctx, k.userId, d3.programId, used)).toThrow()
  })

  it('an approval request expires; a late confirmation is refused', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto' } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
    k.clock.advance(11 * 60_000)
    expect(() => confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())).toThrow(/expired/)
  })

  it('the document states what is authorised, the ceiling, and what is not limited', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const d = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, { expiresAt: istInstant('2026-12-18', '10:30'), maxPerRun: 100_000, maxPerMonth: 3_100_000 }, k.clock.now())
    expect(d.doc.may[0]).toMatch(/Buy Bitcoin in rupees with ₹1,000 from your bank account, every day at 10:00 IST/)
    expect(d.doc.ceiling).toMatch(/at most ₹62,000 before 18 Dec 2026/)
    expect(d.doc.never.join(' ')).toMatch(/sell anything/)
    expect(d.doc.notLimited.length).toBeGreaterThan(0)
    expect(d.contentHash).toBe(sha256hex(d.document))
    expect(JSON.parse(d.document).authority.maxPerRun).toBe(100_000)
  })

  it('rejects bad parameters and unbounded authority with a message per field', () => {
    const k = makeKit()
    const bad = (params: unknown, authority: unknown) => { try { buildDraft(k.ctx, k.userId, 'invest', params, authority, k.clock.now()); return null } catch (e) { return (e as { fields?: Record<string, string> }).fields ?? {} } }
    expect(bad({ instrumentId: 'binance:BTCUSDT', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, { expiresAt: T0 + DAY })).toHaveProperty('instrumentId')
    expect(bad({ instrumentId: 'coindcx:BTCINR', amount: 12.5, schedule: { type: 'daily', at: '25:00' } }, { expiresAt: T0 + DAY })).toMatchObject({ amount: expect.any(String), schedule: expect.any(String) })
    expect(bad({ instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, { expiresAt: T0 - 1 })).toHaveProperty('expiresAt')
    expect(bad({ instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, { expiresAt: T0 + 500 * DAY })).toHaveProperty('expiresAt')
    expect(bad({ instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, { expiresAt: T0 + DAY, maxPerRun: 500_000, maxPerMonth: 100_000 })).toHaveProperty('maxPerMonth')
  })
})

describe('pause, resume, amend, revoke, expiry, emergency stop', () => {
  it('a paused program does not run; a revoked one never runs again and its waiting runs are cancelled', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { runMode: 'notify', noticeSec: 120 })
    await run(k, 70_000, btc(k))
    expect(runs(k, id)[0]!.state).toBe('objection_window')
    pauseProgram(k.ctx, k.userId, id)
    expect(runs(k, id)[0]!.state).toBe('cancelled')
    await run(k, 5 * 60_000, btc(k))
    expect(runs(k, id).length).toBe(1)
    resumeProgram(k.ctx, k.userId, id)
    await run(k, 70_000, btc(k))
    expect(runs(k, id).length).toBe(2)
    revokeProgram(k.ctx, k.userId, id)
    expect(runs(k, id)[1]!.state).toBe('cancelled')
    await run(k, 5 * 60_000, btc(k))
    expect(runs(k, id).length).toBe(2)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(() => resumeProgram(k.ctx, k.userId, id)).toThrow(/revoked/)
  })

  it('an amended version replaces the old one: an action planned under the old version is refused', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } })
    k.clock.advance(61_000); k.btc(6_600_000)
    schedulerTick(k.ctx); runTick(k.ctx) // run 1 is planned under version 1: its action exists but is not yet submitted
    saveDraft(k.ctx, k.userId, { programId: id, params: { instrumentId: 'coindcx:BTCINR', amount: 50_000, schedule: { type: 'every', minutes: 1 } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto' } })
    sign(k, id)
    expect(loadProgram(k.db, k.userId, id).live_version).toBe(2)
    await run(k, 70_000, btc(k))
    const acts = k.db.all<{ state: string; error: string | null; params_json: string }>('SELECT state, error, params_json FROM actions WHERE program_id = ? ORDER BY created_at', id)
    expect(acts[0]!.state).toBe('blocked')
    expect(acts[0]!.error).toMatch(/live version is 2/)
    expect(JSON.parse(acts[1]!.params_json).amount).toBe('50000')
    expect(k.db.get<{ state: string }>('SELECT state FROM program_versions WHERE program_id = ? AND version = 1', id)!.state).toBe('superseded')
    sound(k)
  })

  it('authority ends on its end date: the program expires and nothing runs afterwards', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } }, { expiresAt: T0 + 150_000 })
    await run(k, 4 * 60_000, btc(k))
    expect(loadProgram(k.db, k.userId, id).state).toBe('expired')
    const n = runs(k, id).filter((r) => r.state === 'done').length
    expect(n).toBeGreaterThanOrEqual(1)
    await run(k, 3 * 60_000, btc(k))
    expect(runs(k, id).filter((r) => r.state === 'done').length).toBe(n)
  })

  it('a stop that keeps protective selling, as the owner chose, halts ordinary programs but not protective selling', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const buyer = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } })
    await run(k, 65_000, btc(k))
    expect(runs(k, buyer).filter((r) => r.state === 'done').length).toBe(1)
    const guard = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'below', price: '6400000' })
    setStop(k.ctx, k.userId, 'test', true)
    await run(k, 2 * 60_000, btc(k))
    expect(runs(k, buyer).filter((r) => r.state === 'done').length).toBe(1)
    expect(runs(k, buyer).some((r) => r.state === 'skipped' && /stopped/.test(r.reason ?? ''))).toBe(true)
    await run(k, 10_000, btc(k, 6_300_000)) // the price falls through the level while stopped
    expect(runs(k, guard).some((r) => r.state === 'done')).toBe(true)
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBe(0n)
    clearStop(k.ctx, k.userId)
    await run(k, 65_000, btc(k, 6_300_000))
    expect(runs(k, buyer).filter((r) => r.state === 'done').length).toBe(2)
    sound(k)
  })

  it('stop everything means everything: protective selling is held too unless the owner chose otherwise', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const buyer = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } })
    await run(k, 65_000, btc(k))
    const guard = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'below', price: '6400000' })
    setStop(k.ctx, k.userId, 'test')
    await run(k, 10_000, btc(k, 6_300_000)) // the price falls through the level while everything is stopped
    expect(runs(k, guard).some((r) => r.state === 'done')).toBe(false)
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBeGreaterThan(0n)
    const notice = k.db.get<{ title: string; body: string }>("SELECT title, body FROM notices WHERE kind = 'stopped'")!
    expect(notice.title).toBe('Everything QED does on its own is stopped')
    expect(notice.body).toMatch(/protective selling included/)
    clearStop(k.ctx, k.userId)
    await run(k, 10_000, btc(k, 6_300_000))
    expect(runs(k, guard).some((r) => r.state === 'done')).toBe(true)
    expect(runs(k, buyer).length).toBeGreaterThan(0)
    sound(k)
  })
})

describe('a plain pause cancels waiting protective runs too (claims review F9)', () => {
  for (const keepProtective of [false, true]) {
    it(`a protective run waiting for approval is ${keepProtective ? 'kept when the owner keeps protective selling' : 'cancelled by a plain pause, as the sheet says'}`, async () => {
      const k = makeKit()
      k.btc(6_600_000)
      start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 1 } })
      await run(k, 65_000, btc(k))
      const guard = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'below', price: '6400000' }, { runMode: 'approve' })
      k.db.run("INSERT INTO runs (id, user_id, program_id, version, occurrence, state, trigger_json, due_at, created_at) SELECT 'run_waiting', user_id, id, live_version, 'manual-1', 'awaiting_approval', '{}', ?, ? FROM programs WHERE id = ?", k.clock.now(), k.clock.now(), guard)
      setStop(k.ctx, k.userId, 'Paused by you', keepProtective)
      const st = k.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM runs WHERE id = 'run_waiting'")!
      expect(st.state).toBe(keepProtective ? 'awaiting_approval' : 'cancelled')
      if (!keepProtective) expect(st.reason).toMatch(/stopped all autonomous activity/)
    })
  }
})

describe('asking and announcing', () => {
  it('"ask me each time": nothing happens until the owner approves this run; an unanswered request lapses', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 30 } }, { runMode: 'approve' })
    await run(k, 65_000, btc(k))
    const r1 = k.db.get<{ id: string; state: string }>('SELECT id, state FROM runs WHERE program_id = ?', id)!
    expect(r1.state).toBe('awaiting_approval')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0)
    const req = requestRunApproval(k.ctx, k.userId, r1.id)
    expect(JSON.parse(req.document).willDo[0]).toMatch(/Buy ₹1,000 of Bitcoin/)
    // the sheet shows what the record shows afterwards: the limits used and left with this run, and the bank after it (gap 6)
    const signed = JSON.parse(req.document) as { limits: { label: string; value: string }[]; bank: { now: string; after: string } }
    expect(signed.limits.map((l) => l.label)).toContain('This month')
    expect(signed.limits.find((l) => l.label === 'This run')!.value).toMatch(/^₹1,000, of at most ₹[\d,]+ a run$/)
    expect(signed.limits.find((l) => l.label === 'This month')!.value).toMatch(/^₹0 used before this run, ₹1,000 with it, of at most ₹[\d,]+: ₹[\d,]+ left after it$/)
    const rupees = (t: string) => Number(t.replace(/[₹,]/g, ''))
    expect(rupees(signed.bank.now) - rupees(signed.bank.after)).toBe(1000)
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'session', docHash: sha256hex(req.document) }, k.clock.now())
    await run(k, 10_000, btc(k))
    expect(runs(k, id)[0]!.state).toBe('done')
    await run(k, 30 * 60_000, btc(k), 30_000)
    await run(k, 24 * 3600_000 + 60_000, undefined, 600_000) // nobody answers the second request for a day
    const second = runs(k, id)[1]!
    expect(second.state).toBe('expired')
    expect(second.reason).toMatch(/did not answer/)
    sound(k)
  })

  it('"tell me first": it waits out the notice period and the owner can object', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'every', minutes: 5 } }, { runMode: 'notify', noticeSec: 60 })
    await run(k, 65_000, btc(k))
    const r1 = k.db.get<{ id: string; state: string }>('SELECT id, state FROM runs WHERE program_id = ?', id)!
    expect(r1.state).toBe('objection_window')
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM notices WHERE kind = 'run-notice' AND resolved_at IS NULL")!.n).toBe(1)
    cancelRun(k.ctx, k.userId, r1.id)
    await run(k, 2 * 60_000, btc(k))
    expect(runs(k, id)[0]!).toMatchObject({ state: 'cancelled', reason: 'You objected before it ran.' })
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    await run(k, 4 * 60_000 + 30_000, btc(k)) // the next occurrence is announced, nobody objects, it runs
    expect(runs(k, id)[1]!.state).toBe('done')
    expect(() => cancelRun(k.ctx, k.userId, r1.id)).toThrow(/already/)
  })
})

describe('protective programs', () => {
  it('sells when a fresh, independently confirmed bid reaches the level, then ends', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const buyer = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 500_000, schedule: { type: 'once', at: k.clock.now() } })
    await run(k, 10_000, btc(k))
    expect(loadProgram(k.db, k.userId, buyer).state).toBe('completed')
    const held = balance(k.db, k.userId, 'pos:coindcx:BTCINR')
    expect(held > 0n).toBe(true)
    const id = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'below', price: '6500000', sellBps: 5000 })
    await run(k, 60_000, btc(k, 6_550_000))
    expect(runs(k, id).length).toBe(0)
    await run(k, 10_000, btc(k, 6_480_000))
    expect(runs(k, id)[0]!.state).toBe('done')
    expect(loadProgram(k.db, k.userId, id).state).toBe('completed')
    const left = balance(k.db, k.userId, 'pos:coindcx:BTCINR')
    expect(left > 0n && left <= held / 2n + 1000n).toBe(true)
    sound(k)
  })

  it('does not sell on a stale price or on a price no independent source confirms, and says it is not watching', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 500_000, schedule: { type: 'once', at: k.clock.now() } })
    await run(k, 10_000, btc(k))
    const id = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'below', price: '6500000' })
    // The venue alone shows a collapse; the independent source does not move.
    await run(k, 20_000, () => { k.btc(6_600_000); k.book('coindcx:BTCINR', [['3000000', '1']], [['3001000', '1']]) })
    expect(runs(k, id).length).toBe(0)
    expect(k.db.get<{ body: string }>("SELECT body FROM notices WHERE kind = 'not-watching' AND resolved_at IS NULL")!.body).toMatch(/disagree/)
    await run(k, 60_000) // then the feed stops entirely
    expect(runs(k, id).length).toBe(0)
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR') > 0n).toBe(true)
    await run(k, 10_000, btc(k, 6_600_000)) // fresh, agreeing prices return above the level
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM notices WHERE kind = 'not-watching' AND resolved_at IS NULL")!.n).toBe(0)
  })

  it('a trailing exit follows the high and sells on the fall from it', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 500_000, schedule: { type: 'once', at: k.clock.now() } })
    await run(k, 10_000, btc(k))
    const id = start(k, 'exit', { instrumentId: 'coindcx:BTCINR', mode: 'trail', trailPct: 2 })
    await run(k, 10_000, btc(k, 6_800_000))
    await run(k, 10_000, btc(k, 6_750_000)) // 0.7% under the high: holds
    expect(runs(k, id).length).toBe(0)
    await run(k, 10_000, btc(k, 6_650_000)) // 2.2% under the high: sells
    expect(runs(k, id)[0]!.state).toBe('done')
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBe(0n)
  })

  it('the floor controller sells risk when the worst case is below the floor, and never buys', async () => {
    const k = makeKit({ profile: { line: 60_000_000 } })
    k.btc(6_600_000)
    start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 9_000_000, schedule: { type: 'once', at: k.clock.now() } }, { maxPerRun: 9_000_000, maxPerMonth: 9_000_000, maxSlippageBps: 300 })
    k.book('coindcx:BTCINR', [['6599500', '5']], [['6600500', '5']])
    await run(k, 10_000, () => { k.btc(6_600_000); k.book('coindcx:BTCINR', [['6599500', '5']], [['6600500', '5']]) })
    const before = worstCase(k.db, k.market, k.userId, k.clock.now())
    expect(before.cushion).toBeGreaterThan(0)
    const id = start(k, 'floor', {})
    // The owner raises the floor above the current worst case.
    saveProfile(k.db, k.userId, { line: before.gHat + 1_000_000 })
    const deep = () => { k.btc(6_600_000); k.book('coindcx:BTCINR', [['6599500', '5']], [['6600500', '5']]) }
    await run(k, 30_000, deep)
    const rs = runs(k, id)
    expect(rs.some((r) => r.state === 'done')).toBe(true)
    const after = worstCase(k.db, k.market, k.userId, k.clock.now())
    expect(after.cushion).toBeGreaterThanOrEqual(0)
    expect(k.db.get<{ n: number }>("SELECT COUNT(*) n FROM actions WHERE program_id = ? AND json_extract(params_json, '$.side') = 'buy'", id)!.n).toBe(0)
    expect(k.db.all<{ p: number }>("SELECT json_extract(params_json, '$.protective') p FROM actions WHERE program_id = ?", id).every((a) => a.p === 1)).toBe(true)
    sound(k)
  })

  it('a purchase that would take the worst case below the floor is refused', async () => {
    const k = makeKit({ profile: { line: 64_900_000 } }) // worst case starts at ₹6,50,000: bank 8,00,000 less card 1,20,000 and 30,000 of instalments due
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 500_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 500_000, maxPerMonth: 5_000_000 })
    await run(k, 65_000, btc(k))
    const r = runs(k, id)[0]!
    expect(r.state).toBe('blocked')
    expect(r.reason).toMatch(/floor/)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
  })
})

describe('the certified no-regret program', () => {
  it('certifies ₹50,000 to the card for the recorded household, pays it once, and ends', async () => {
    const k = makeKit()
    const d = saveDraft(k.ctx, k.userId, { kind: 'paydown', params: { plan: { card: 50_000 } }, authority: { expiresAt: k.clock.now() + DAY, runMode: 'auto' } })
    expect(d.draft.analysis.tier).toBe('certified')
    const cert = d.draft.analysis.certificate as { scenarios: number; checkerA: { tierD: boolean }; checkerB: { tierD: boolean }; counted: { label: string }[] }
    expect(cert.scenarios).toBe(64)
    expect(cert.checkerA.tierD && cert.checkerB.tierD).toBe(true)
    expect(cert.counted[0]!.label).toMatch(/Everyday spending/)
    expect(d.draft.doc.conditions.join(' ')).toMatch(/counted these monthly outflows: Everyday spending \(your figure\) ₹70,000/)
    sign(k, d.programId)
    await run(k, 15_000)
    expect(runs(k, d.programId)[0]!.state).toBe('done')
    expect(balance(k.db, k.userId, 'card')).toBe(BigInt(DEFAULT_OPENING.card) - 5_000_000n)
    expect(loadProgram(k.db, k.userId, d.programId).state).toBe('completed')
    sound(k)
  })

  it('is built from the recorded household: with spending of ₹1,17,000 a month the same plan is not certified (review finding B1)', () => {
    const k = makeKit({ profile: { spending: 11_700_000 } })
    const d = saveDraft(k.ctx, k.userId, { kind: 'paydown', params: { plan: { card: 50_000 } }, authority: { expiresAt: k.clock.now() + DAY, runMode: 'auto' } })
    expect(d.draft.analysis.tier).toBe('each-time')
    expect(d.draft.analysis.refusals.join(' ')).toMatch(/not a no-regret move|worse off/)
    expect(() => requestProgramApproval(k.ctx, k.userId, d.programId)).toThrow(/no-regret|worse off|cannot run on its own/)
  })

  it('counts registered bills and investing programs as monthly outflows', () => {
    const k = makeKit()
    k.btc(6_600_000)
    start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 4_700_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }, { maxPerRun: 4_700_000, maxPerMonth: 4_700_000 })
    const d = buildDraft(k.ctx, k.userId, 'paydown', { plan: { card: 50_000 } }, { expiresAt: k.clock.now() + DAY }, k.clock.now())
    const cert = d.analysis.certificate as { counted: { label: string; monthly: number }[]; household: { expenses: number }; certified: boolean }
    expect(cert.counted.some((c) => /Investing instruction/.test(c.label) && c.monthly === 4_700_000)).toBe(true)
    expect(cert.household.expenses).toBe(117_000)
    expect(cert.certified).toBe(false)
  })

  it('counts an instruction at no more than its signed monthly limit, however often it is scheduled', () => {
    // Found in a live run: ₹200 every 30 minutes was counted as ₹2,88,000 a month although it was signed for ₹20,000.
    const k = makeKit()
    k.btc(6_600_000)
    start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 30 } }, { maxPerRun: 20_000, maxPerDay: 500_000, maxPerMonth: 2_000_000 })
    const m = householdModel(k.db, k.userId, k.clock.now())
    const line = m.counted.find((c) => /Investing instruction/.test(c.label))!
    expect(line.monthly).toBe(2_000_000)
    expect(m.model.expenses).toBe(70_000 + 20_000) // the recorded ₹70,000 of spending plus the ₹20,000 it can move
  })

  it('re-checks on the day: if the balances changed so that it no longer holds, nothing is paid', async () => {
    const k = makeKit()
    const d = saveDraft(k.ctx, k.userId, { kind: 'paydown', params: { plan: { card: 50_000 } }, authority: { expiresAt: k.clock.now() + DAY, runMode: 'auto' } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
    // Between approval and the run, ₹3,00,000 leaves the bank account.
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'spend', ref: 'big', memo: 'large spend', lines: [{ account: 'exp:spend', amount: 30_000_000n }, { account: 'bank', amount: -30_000_000n }] })
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    await run(k, 15_000)
    const r = runs(k, d.programId)[0]!
    expect(r.state).toBe('skipped')
    expect(r.reason).toMatch(/no longer passes/)
    expect(balance(k.db, k.userId, 'card')).toBe(BigInt(DEFAULT_OPENING.card))
  })
})

describe('bills, cash parking and income', () => {
  function payee(k: Kit, handle: string, name: string): string {
    const id = `pay_${handle.replace(/\W/g, '')}`
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, name, handle, 'utility', k.clock.now(), k.clock.now())
    return id
  }
  const bill = (k: Kit, payeeId: string, amount: number, dueInMs: number): string => {
    const id = `bill_${payeeId}_${amount}`
    k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)", id, k.userId, payeeId, amount, k.clock.now() + dueInMs, 'November', k.clock.now())
    return id
  }

  it('pays a registered bill after the notice period, once; a bill above the cap waits for the owner', async () => {
    const k = makeKit()
    const power = payee(k, 'power@upi', 'City Power'), net = payee(k, 'fibre@upi', 'Fibre Broadband')
    payee(k, 'stranger@upi', 'Somebody Else')
    const id = start(k, 'bills', { payeeHandles: ['power@upi', 'fibre@upi'], capPerBill: 300_000 }, { runMode: 'notify', noticeSec: 30, maxPerRun: 300_000, maxPerMonth: 1_000_000 })
    const b1 = bill(k, power, 245_000, 20_000)
    const b2 = bill(k, net, 499_900, 20_000)
    await run(k, 15_000)
    expect(runs(k, id).length).toBe(0) // not due yet
    await run(k, 20_000)
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', b1)!.state).toBe('scheduled')
    await run(k, 60_000)
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', b1)!.state).toBe('paid')
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', b2)!.state).toBe('due')
    expect(k.db.get<{ body: string }>("SELECT body FROM notices WHERE kind = 'bill-waiting'")!.body).toMatch(/above your cap/)
    expect(balance(k.db, k.userId, 'exp:spend')).toBe(245_000n)
    await run(k, 5 * 60_000, undefined, 30_000)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n).toBe(1)
    sound(k)
  })

  it('refuses to name a payee the owner has not registered', () => {
    const k = makeKit()
    expect(() => saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['ghost@upi'], capPerBill: 100_000 }, authority: { expiresAt: k.clock.now() + DAY, runMode: 'auto' } })).toThrow(/Some values/)
  })

  it('parks money above the buffer in a liquid fund and brings it back when the bank runs low', async () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    const id = start(k, 'sweep', { instrumentId: 'amfi:118701', keep: 20_000_000, minMove: 1_000_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 60_000_000, maxPerMonth: 200_000_000 })
    await run(k, 65_000)
    // A liquid purchase before 13:30 is entitled to the previous day's NAV, which is already published, so units arrive at once.
    expect(runs(k, id)[0]!.state).toBe('done')
    // Nothing is due within 7 days (the next instalment is 5 December), so everything above the ₹2,00,000 buffer moves.
    expect(balance(k.db, k.userId, 'bank')).toBe(20_000_000n)
    expect(balance(k.db, k.userId, 'pos:amfi:118701') > 0n).toBe(true)
    await run(k, 65_000)
    expect(runs(k, id).filter((r) => r.state === 'skipped').length).toBeGreaterThanOrEqual(1)
    // A large payment takes the bank well below the buffer.
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'spend', ref: 'rent', memo: 'rent', lines: [{ account: 'exp:spend', amount: 15_000_000n }, { account: 'bank', amount: -15_000_000n }] })
    const unitsBefore = balance(k.db, k.userId, 'pos:amfi:118701')
    await run(k, 65_000)
    const redeem = k.db.get<{ params_json: string }>("SELECT params_json FROM actions WHERE program_id = ? AND json_extract(params_json, '$.side') = 'sell'", id)
    expect(redeem).toBeTruthy()
    expect(BigInt(JSON.parse(redeem!.params_json).qty) < unitsBefore).toBe(true)
    sound(k)
  })

  it('splits recorded income, once per income, and ignores money that is not income', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const id = start(k, 'split', { rules: [{ to: 'card', shareBps: 2000 }, { to: 'fund', instrumentId: 'amfi:120716', shareBps: 1000 }] }, { runMode: 'auto', maxPerRun: 5_000_000, maxPerMonth: 10_000_000 })
    await run(k, 10_000)
    expect(runs(k, id).length).toBe(0)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'adjustment', ref: 'refund', memo: 'a refund', lines: [{ account: 'bank', amount: 5_000_000n }, { account: 'inc:other', amount: -5_000_000n }] })
    await run(k, 10_000)
    expect(runs(k, id).length).toBe(0)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'income-salary', ref: 'salary:2026-12', memo: 'Salary', lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    await run(k, 15_000)
    await run(k, 15_000)
    expect(runs(k, id).length).toBe(1)
    expect(balance(k.db, k.userId, 'card')).toBe(BigInt(DEFAULT_OPENING.card) - 2_400_000n)
    expect(balance(k.db, k.userId, 'clear:mf')).toBe(1_200_000n)
    sound(k)
  })
})

describe('a pause already in force (adversarial review of R12, L4 and M4)', () => {
  const stopOf = (k: Kit) => k.db.get<{ stop_at: number | null; stop_protective: number; stop_reason: string }>('SELECT stop_at, stop_protective, stop_reason FROM users WHERE id = ?', k.userId)!
  const notices = (k: Kit) => k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'stopped'`, k.userId)!.n
  it('is never loosened, is tightened when protective selling is asked to stop too, and says nothing when nothing changes', () => {
    const k = makeKit()
    expect(setStop(k.ctx, k.userId, 'Paused by you', false)).toEqual({ keptProtective: false, already: false })
    const at = stopOf(k).stop_at
    // a later request to keep protective selling does not loosen it, and posts nothing
    const before = notices(k)
    expect(setStop(k.ctx, k.userId, 'Paused by you', true)).toEqual({ keptProtective: false, already: true })
    expect(stopOf(k)).toMatchObject({ stop_at: at, stop_protective: 0 })
    expect(notices(k)).toBe(before)
    // all but protective selling, then everything: tightened
    const j = makeKit()
    setStop(j.ctx, j.userId, 'Paused with a saved recovery code, from the signed-out page', true)
    expect(setStop(j.ctx, j.userId, 'Paused by you', false)).toEqual({ keptProtective: false, already: true })
    expect(stopOf(j)).toMatchObject({ stop_protective: 0, stop_reason: 'Paused with a saved recovery code, from the signed-out page' })
  })
  it('a pause someone else made is said in their words, never as "you chose"', () => {
    const k = makeKit()
    setStop(k.ctx, k.userId, 'Paused by your recovery contact @asha', true)
    const n = k.db.get<{ body: string }>(`SELECT body FROM notices WHERE user_id = ? AND kind = 'stopped' ORDER BY rowid DESC LIMIT 1`, k.userId)!
    expect(n.body).toMatch(/^Paused by your recovery contact @asha\./)
    expect(n.body).not.toMatch(/you chose/)
  })
})

describe('a run is held to its signed per-run limit as a whole (adversarial review of R12, H1)', () => {
  it('a split whose shares are each within "at most in one run" but together over it moves no more than the limit', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    // half to the card and half to a fund, at most ₹60,000 in one run; a ₹1,20,000 salary asks for two ₹60,000 shares
    const id = start(k, 'split', { rules: [{ to: 'card', shareBps: 5000 }, { to: 'fund', instrumentId: 'amfi:120716', shareBps: 5000 }] }, { runMode: 'auto', maxPerRun: 6_000_000, maxPerMonth: 100_000_000 })
    await run(k, 10_000)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'income-salary', ref: 'salary:2026-12', memo: 'Salary', lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    await run(k, 15_000)
    await run(k, 15_000)
    const acts = k.db.all<{ state: string; params_json: string }>('SELECT state, params_json FROM actions WHERE program_id = ? ORDER BY created_at, id', id)
    expect(acts).toHaveLength(2)
    const moved = acts.filter((a) => !['blocked', 'rejected', 'failed', 'cancelled', 'expired'].includes(a.state)).reduce((t, a) => t + Number((JSON.parse(a.params_json) as { amount?: string }).amount ?? 0), 0)
    expect(moved).toBeLessThanOrEqual(6_000_000)
    // the share that would have taken the run over its limit is refused, and says why
    const refused = k.db.all<{ policy_json: string | null }>('SELECT policy_json FROM actions WHERE program_id = ?', id)
      .flatMap((a) => (JSON.parse(a.policy_json ?? '{}') as { checks?: { name: string; ok: boolean; detail: string }[] }).checks ?? []).filter((c) => c.name === 'within-run-limit' && !c.ok)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]!.detail).toMatch(/this run/)
    sound(k)
  })
})

describe('contradictions are resolved before approval (R7-093)', () => {
  it('a schedule asking for more each month than the monthly limit cannot be sent for signing until the owner accepts it, and the acceptance is signed', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 60 } }, authority: { maxPerRun: 20_000, maxPerMonth: 2_000_000, expiresAt: k.clock.now() + 30 * 86_400_000, runMode: 'auto' } })
    let refusal: { code?: string; fields?: Record<string, string> } = {}
    try { requestProgramApproval(k.ctx, k.userId, d.programId) } catch (e) { refusal = e as typeof refusal }
    expect(refusal.code).toBe('contradiction_unresolved')
    const listed = JSON.parse(refusal.fields!.contradictions!) as { id: string; text: string }[]
    expect(listed.map((c) => c.id)).toEqual(['schedule-over-limit'])
    expect(listed[0]!.text).toMatch(/about ₹1,44,000 a month and the monthly limit is ₹20,000/)
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
    const doc = JSON.parse(req.draft.document) as { accepted?: string[] }
    expect(doc.accepted).toEqual([listed[0]!.text])
    expect(req.draft.contentHash).toBe(sha256hex(req.draft.document))
  })

  it('a draft from a proposal that dropped a figure the owner wrote is held until the figure is used or the loss is accepted', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const proposal = storeProposal(k.ctx, k.userId, null, 'model', 'invest', 'Bitcoin each week', 'test', { instrumentId: 'coindcx:BTCINR', amount: 50_000, schedule: { type: 'weekly', weekday: 1, at: '10:00' } }, 'approve', k.clock.now(), null, [50_000, 250_000])
    const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: proposal.params, authority: { maxPerRun: 50_000, maxPerMonth: 400_000, expiresAt: k.clock.now() + 30 * 86_400_000, runMode: 'auto' }, origin: `proposal:${proposal.id}` })
    expect(() => requestProgramApproval(k.ctx, k.userId, d.programId)).toThrow(/You wrote ₹2,500 when you asked/)
    // the owner puts the figure in, as the monthly limit it was meant to be: nothing left to accept
    saveDraft(k.ctx, k.userId, { programId: d.programId, params: proposal.params, authority: { maxPerRun: 50_000, maxPerMonth: 250_000, expiresAt: k.clock.now() + 30 * 86_400_000, runMode: 'auto' } })
    expect(requestProgramApproval(k.ctx, k.userId, d.programId).contradictions).toEqual([])
  })
})
