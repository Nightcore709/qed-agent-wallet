/**
 * C-10 (K4, R12 Hypothesis): "for a scheduled payment whose size includes a charge, the run calendar could show a run the
 * engine refuses". The engine sizes a payment as its amount plus its charge (server/policy.ts) and the run calendar counts
 * each run at the instruction's amount (server/liquidity.ts runCalendar, perRun). Result: refuted for every instruction QED
 * can schedule today, and guarded:
 *
 *   1. The kinds that run on a schedule are invest, sweep, swp, rebalance and goal (paydown is one-shot; bills, exit,
 *      floor and split run on events, not a schedule). Of these only goal plans payments, and its payments carry no
 *      charge: a charge arises only in a one-off payment (owner.ts, a loan prepayment charge) and in the one-shot paydown.
 *      If a kind is added or changed to run on a schedule, the list below fails and this question must be asked again.
 *   2. On generated goals run by the engine, every payment a run makes has no charge, its size is at most the calendar's
 *      per-run figure, and on each day the calendar shows a run the engine makes it.
 *   3. The mechanism the hypothesis names is real, and is shown on the engine's own check: a payment of the per-run
 *      amount plus a charge is refused by within-run-limit when the per-run limit is the amount. No scheduled kind can
 *      produce one (1).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { getAction, stepAllActions } from './execute.ts'
import { decide } from './policy.ts'
import type { PaymentParams } from './types.ts'
import { runCalendar } from './liquidity.ts'
import { activateProgram, KINDS, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { makeKit, type Kit } from './testkit.ts'

const DAY = 86_400_000
async function cycle(k: Kit): Promise<void> {
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}

describe('C-10: the run calendar against a scheduled payment whose size includes a charge', () => {
  it('the kinds that run on a schedule, and which of them plan payments: only goal, and never with a charge', () => {
    const probe = { schedule: { type: 'monthly', day: 1, at: '10:00' } }
    const scheduled = Object.values(KINDS).filter((k) => !k.oneShot && (k.schedule as (p: unknown) => unknown)(probe) !== null).map((k) => k.kind).sort()
    expect(scheduled).toEqual(['goal', 'invest', 'rebalance', 'sweep', 'swp'])
    // the payments each scheduled kind's plan can produce, read from its source: only goal's, and without a charge
    const src = (name: string) => (KINDS as Record<string, { plan: (...a: never[]) => unknown }>)[name]!.plan.toString()
    for (const kind of scheduled) expect(src(kind), `${kind} plans no charge`).not.toMatch(/charge/)
  })

  it('on generated goals run by the engine: no payment has a charge, each is at most the calendar\'s per-run figure, and a run the calendar shows today is made', async () => {
    const seen = { runs: 0, payments: 0 }
    await fc.assert(fc.asyncProperty(fc.record({ target: fc.integer({ min: 50_000, max: 5_000_000 }), months: fc.integer({ min: 2, max: 12 }) }), async (p) => {
      const k = makeKit({ profile: { line: 0 } })
      const date = new Date(k.clock.now() + p.months * 31 * DAY).toISOString().slice(0, 10)
      const id = saveDraft(k.ctx, k.userId, { kind: 'goal', params: { name: 'Holiday', target: p.target * 100, date }, authority: { runMode: 'auto' } }).programId
      sign(k, id)
      // each run of the goal: the calendar an hour before it is due, then the engine at its due time
      for (let n = 0; n < 4; n++) {
        const next = k.db.get<{ next_due_at: number | null; state: string }>('SELECT next_due_at, state FROM programs WHERE id = ?', id)
        if (!next?.next_due_at || next.state !== 'active') break
        if (next.next_due_at - 3600_000 > k.clock.now()) k.clock.advance(next.next_due_at - 3600_000 - k.clock.now())
        const cal = runCalendar(k.db, k.userId, id, k.clock.now())
        if (!cal) break
        const before = k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE program_id = ?`, id)!.n
        k.clock.advance(3600_000)
        for (let t = 0; t < 120_000; t += 5000) { k.clock.advance(5000); await cycle(k) }
        const made = k.db.all<{ kind: string; params_json: string }>(`SELECT kind, params_json FROM actions WHERE program_id = ? ORDER BY created_at`, id).slice(before)
        for (const a of made) {
          const prm = JSON.parse(a.params_json) as { amount?: string; charge?: string }
          expect(a.kind).toBe('payment')
          expect(prm.charge, 'no charge on a scheduled payment').toBeUndefined()
          expect(Number(prm.amount), 'the engine\'s size is at most the calendar\'s per-run figure').toBeLessThanOrEqual(cal.perRun)
          seen.payments++
        }
        // the run the calendar shows for today is made: the calendar never shows a run the engine refuses
        if (cal.days[0]!.runs > 0) expect(made.length, JSON.stringify({ p, n, day0: cal.days[0] })).toBeGreaterThanOrEqual(1)
        if (made.length) seen.runs++
      }
    }), { numRuns: 6, seed: 1010 })
    expect(seen.payments).toBeGreaterThan(0)
  }, 300_000)

  it('the mechanism, on the engine\'s own check: the same payment of a goal\'s run with a charge added would be refused by within-run-limit, while the calendar counts the run at its amount', async () => {
    const k = makeKit({ profile: { line: 0 } })
    const id = saveDraft(k.ctx, k.userId, { kind: 'goal', params: { name: 'Holiday', target: 1_000_000, date: new Date(k.clock.now() + 200 * DAY).toISOString().slice(0, 10) }, authority: { runMode: 'auto' } }).programId
    sign(k, id)
    const cal = runCalendar(k.db, k.userId, id, k.clock.now())!
    const due = k.db.get<{ next_due_at: number }>('SELECT next_due_at FROM programs WHERE id = ?', id)!.next_due_at
    k.clock.advance(due - k.clock.now())
    for (let t = 0; t < 120_000 && !k.db.get('SELECT 1 x FROM actions WHERE program_id = ?', id); t += 5000) { k.clock.advance(5000); await cycle(k) }
    const row = getAction(k.db, k.db.get<{ id: string }>('SELECT id FROM actions WHERE program_id = ? ORDER BY created_at LIMIT 1', id)!.id)!
    const p = row.params as PaymentParams
    expect(Number(p.amount)).toBe(cal.perRun)
    const pass = (r: typeof row) => decide(k.ctx, r, k.clock.now()).checks.find((c) => c.name === 'within-run-limit')?.ok
    expect(pass(row), 'as planned: within the per-run limit').toBe(true)
    expect(pass({ ...row, params: { ...p, charge: '100' } }), 'with a charge of one rupee: refused').toBe(false)
  })
})
