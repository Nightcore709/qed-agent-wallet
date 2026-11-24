/**
 * F-029 (K4): what the run calendar says about today is what the engine then does, on the same state, for the
 * monthly, daily and run-count limits. The calendar (server/liquidity.ts runCalendar) is the preview an instruction's
 * page shows, naming the limit that stops a run; the engine is the runner (server/runner.ts) and the policy checks
 * (server/policy.ts). They are separate code. This test generates the three limits, asks the calendar how many runs
 * today and which limit stops the next, then lets the engine run and compares: the same number of runs, and the
 * same limit (the engine's failing checks, or for the run count the instruction completing).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { stepAllActions } from './execute.ts'
import { runCalendar } from './liquidity.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { type Kit, makeKit } from './testkit.ts'
import type { Authority } from './types.ts'

const DAY = 86_400_000
const PER = 100_000 // ₹1,000 a run
async function cycle(k: Kit): Promise<void> {
  k.btc(6_600_000)
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
function start(k: Kit, authority: Partial<Authority>): string {
  const d = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: PER, schedule: { type: 'every', minutes: 1 } }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto', ...authority } })
  const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
  return d.programId
}
const LIMIT_CHECK = { month: 'within-month-limit', day: 'within-day-limit', runs: 'within-run-count' } as const

describe('F-029: the run calendar and the engine agree on the monthly, daily and run-count limits', () => {
  it('on the same state, minute by minute: the calendar says whether the next run fits and which limit stops it, and the engine does exactly that; over a day the calendar never shows more runs than the engine makes', async () => {
    const seen = { month: 0, day: 0, runs: 0, slack: 0 }
    await fc.assert(fc.asyncProperty(fc.record({
      month: fc.integer({ min: 1, max: 4 }), monthExtra: fc.nat(PER - 1),
      day: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }), dayExtra: fc.nat(PER - 1),
      runs: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
    }), async (p) => {
      const k = makeKit()
      k.btc(6_600_000)
      const id = start(k, { maxPerRun: PER, maxPerMonth: p.month * PER + p.monthExtra, maxPerDay: p.day === null ? null : p.day * PER + p.dayExtra, maxRuns: p.runs })
      const first = runCalendar(k.db, k.userId, id, k.clock.now())!.days[0]!
      for (let minute = 0; minute < first.runs + 3; minute++) {
        // the preview on the state as it is now
        const cal = runCalendar(k.db, k.userId, id, k.clock.now())
        const day0 = cal?.days[0]
        const fits = !!day0 && day0.runs >= 1
        // the engine: one minute, in which the schedule makes one run
        const before = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM runs WHERE program_id = ?', id)!.n
        for (let t = 0; t < 60_000; t += 5000) { k.clock.advance(5000); await cycle(k) }
        const made = k.db.all<{ id: string; state: string }>('SELECT id, state FROM runs WHERE program_id = ? ORDER BY created_at, due_at', id).slice(before)
        const label = JSON.stringify({ ...p, minute, day0 })
        if (!cal || (!fits && day0?.by === 'runs')) {
          // the run count stops the instruction itself: it completes after its last run (and the calendar, which
          // shows only instructions in force, has nothing more to show), and makes no further run
          expect(made, label).toEqual([])
          expect(k.db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', id)!.state, label).toBe('completed')
          seen.runs++
          break
        }
        expect(made.length, label).toBe(1)
        if (fits) { expect(made[0]!.state, label).toBe('done'); continue }
        // refused: by the limits the calendar names as used up (the tightest first; on a tie, every one of them fails)
        expect(made[0]!.state, label).toBe('blocked')
        const failing = k.db.all<{ policy_json: string }>('SELECT policy_json FROM actions WHERE run_id = ?', made[0]!.id)
          .flatMap((r) => (JSON.parse(r.policy_json).checks as { name: string; ok: boolean }[])).filter((c) => !c.ok).map((c) => c.name)
        const named = LIMIT_CHECK[day0!.by!]
        expect(failing, label).toContain(named)
        expect(failing.filter((n) => Object.values(LIMIT_CHECK).includes(n as never)).every((n) => n === LIMIT_CHECK.month || n === LIMIT_CHECK.day), label).toBe(true)
        seen[day0!.by as 'month' | 'day']++
        break
      }
      // over the day: the calendar counted every run at its full amount; the engine counts what each filled run used,
      // which can be less, so it may make more runs than the calendar first showed, never fewer
      const done = k.db.get<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE program_id = ? AND state = 'done'", id)!.n
      expect(done >= first.runs, JSON.stringify(p)).toBe(true)
      if (done > first.runs) seen.slack++
    }), { numRuns: 16, seed: 29 })
    // the generated cases reached each limit
    expect(seen.month * seen.day * seen.runs, JSON.stringify(seen)).toBeGreaterThan(0)
    if (process.env.QED_F029_REPORT) console.log(`F-029 cases stopped by: ${JSON.stringify(seen)}`)
  }, 180_000)

  it('the calendar counts a future run at its full amount and the engine at what the filled run used: with ₹1,995.93 a day, the calendar first shows one run today and the engine makes two (each minute they agree on the state as it is)', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, { maxPerRun: PER, maxPerMonth: 10 * PER, maxPerDay: 199_593, maxRuns: null })
    const shown = runCalendar(k.db, k.userId, id, k.clock.now())!.days[0]!
    expect([shown.runs, shown.by]).toEqual([1, 'day'])
    const states: string[] = []
    for (let minute = 0; minute < 3; minute++) {
      const day0 = runCalendar(k.db, k.userId, id, k.clock.now())!.days[0]!
      const before = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM runs WHERE program_id = ?', id)!.n
      for (let t = 0; t < 60_000; t += 5000) { k.clock.advance(5000); await cycle(k) }
      const made = k.db.all<{ state: string }>('SELECT state FROM runs WHERE program_id = ? ORDER BY created_at, due_at', id).slice(before)
      expect(made.map((r) => r.state)).toEqual([day0.runs >= 1 ? 'done' : 'blocked'])
      states.push(made[0]!.state)
    }
    // the first run filled at ₹995.93 for its ₹1,000.00, which left room for a second
    expect(states).toEqual(['done', 'done', 'blocked'])
  }, 60_000)
})
