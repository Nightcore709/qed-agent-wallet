/**
 * Savings automation, payments and wallet operations running together (R7-047; audit SV4). A household with two
 * standing instructions that run by themselves (a monthly goal contribution and a daily investment, each with its own
 * signed monthly limit) also pays by hand, owes bills, and has a wallet whose chain activity is booked as it happens.
 * Random interleavings of all of these, with every invariant checked after every step (fast-check, fixed seed):
 *
 *   1. the books are sound and the bank never goes negative;
 *   2. each instruction moves no more in an India calendar month than its signed monthly limit, and together they move
 *      no more than the limits add up to (the aggregate limit);
 *   3. the envelope the owner is shown (the most every instruction together may move in the next 30 days) is never
 *      exceeded by what then happens in those 30 days;
 *   4. the reserve rule: an instruction's run never takes a household that was not short into a shortfall;
 *   5. wallet operations never move a rupee figure: the bank, what is free and the reserve are the same after the
 *      chain's activity is booked as before.
 * The browser journey (browser/tests/savings-together.spec.ts) shows the same on screen.
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { bankTick } from './bank.ts'
import { syncChainBooks } from './chain-books.ts'
import { stepAllActions } from './execute.ts'
import { available, verifyLedger } from './ledger.ts'
import { authorityEnvelope, liquidity } from './liquidity.ts'
import { addBill, addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { checkPayeeName } from './name-check.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { saveVault } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { sha256hex } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { type Kit, makeKit } from './testkit.ts'
import { ist } from './core.ts'
import { overview } from './valuation.ts'
import { istInstant } from './core.ts'

const DAY = 86_400_000
const ack = (name: string, handle: string): { nameCheckAccepted?: string } => { const o = checkPayeeName(name, handle).outcome; return o === 'match' ? {} : { nameCheckAccepted: o } }
const MONTHLY_INVEST = 300_000   // the investment's signed monthly limit, paise

async function cycle(k: Kit): Promise<void> {
  bankTick(k.ctx)
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.rail.tick(); await k.venues.crypto.tick(); await k.venues.funds.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
async function byHand(k: Kit, what: Record<string, unknown>): Promise<boolean> {
  let pv: Awaited<ReturnType<typeof previewAction>>
  try { pv = await previewAction(k.ctx, k.userId, what) } catch { return false }
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  try { submitApprovedAction(k.ctx, k.userId, pv.approvalId) } catch { return false }
  await cycle(k); k.clock.advance(3000); await cycle(k)
  return true
}

const reached = { cyclesWithInstructionRuns: 0, notShortBeforeRun: 0, hand: 0, bills: 0, walletSyncs: 0, envelopes: 0, instructionMoves: 0 }

/** What each instruction has moved, by India month, from the books of its settled actions. */
function movedByMonth(k: Kit, programId: string): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const a of k.db.all<{ created_at: number; params_json: string; kind: string; state: string }>(`SELECT created_at, params_json, kind, state FROM actions WHERE program_id = ? AND state NOT IN ('blocked', 'rejected', 'failed', 'cancelled', 'expired')`, programId)) {
    const p = JSON.parse(a.params_json) as { amount?: string | number; side?: string }
    if (a.kind === 'order' && p.side === 'sell') continue
    const m = ist(a.created_at).date.slice(0, 7)
    out.set(m, (out.get(m) ?? 0n) + BigInt(p.amount ?? 0))
  }
  return out
}
const instructionMoved = (k: Kit, ids: string[], since: number): bigint => ids.reduce((s, id) => s + k.db.all<{ params_json: string; kind: string }>(`SELECT params_json, kind FROM actions WHERE program_id = ? AND created_at >= ? AND state NOT IN ('blocked', 'rejected', 'failed', 'cancelled', 'expired')`, id, since)
  .reduce((t, a) => { const p = JSON.parse(a.params_json) as { amount?: string | number; side?: string }; return a.kind === 'order' && p.side === 'sell' ? t : t + BigInt(p.amount ?? 0) }, 0n), 0n)

describe('savings automation, payments and wallet operations together', () => {
  const fake = new FakeRail()
  const dir = mkdtempSync(join(tmpdir(), 'qed-aggregate-'))
  beforeAll(async () => { await fake.start() })
  afterAll(async () => { await fake.stop(); rmSync(dir, { recursive: true, force: true }) })

  it('property: random interleavings keep every limit and the reserve, and the wallet never moves a rupee figure', async () => {
    const op = fc.oneof(
      { weight: 5, arbitrary: fc.record({ t: fc.constant('time' as const), days: fc.integer({ min: 1, max: 12 }) }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('hand' as const), rupees: fc.integer({ min: 100, max: 700_000 }) }) },
      { weight: 2, arbitrary: fc.record({ t: fc.constant('bill' as const), rupees: fc.integer({ min: 100, max: 50_000 }) }) },
      { weight: 3, arbitrary: fc.record({ t: fc.constant('wallet' as const), rupees: fc.integer({ min: 1, max: 500_000 }) }) },
      { weight: 2, arbitrary: fc.record({ t: fc.constant('envelope' as const) }) },
    )
    let runNo = 0
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 12 }), async (ops) => {
      const k = makeKit({ profile: { line: 0 } })
      k.btc(6_600_000)
      const goal = saveDraft(k.ctx, k.userId, { kind: 'goal', params: { name: 'Holiday', target: 20_000_000, date: '2027-06-30' }, authority: { runMode: 'auto' } }).programId
      const invest = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'coindcx:BTCINR', amount: 100_000, schedule: { type: 'daily', at: '10:00' } }, authority: { expiresAt: k.clock.now() + 365 * DAY, runMode: 'auto', maxPerRun: 100_000, maxPerMonth: MONTHLY_INVEST } }).programId
      sign(k, goal); sign(k, invest)
      // each instruction's signed monthly limit, as stored with the version in force (a goal's is derived from its figure)
      const signed = (id: string): number => (JSON.parse(k.db.get<{ authority_json: string }>(`SELECT v.authority_json FROM program_versions v JOIN programs p ON p.id = v.program_id AND p.live_version = v.version WHERE p.id = ?`, id)!.authority_json) as { maxPerMonth: number }).maxPerMonth
      const limits = new Map([[goal, signed(goal)], [invest, signed(invest)]])
      const payee = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', ...ack('City Power', 'power@upi') }, k.clock.now())
      // the wallet: a vault on a chain the fake serves, its activity booked by the sync
      const rail = `qed-rupees-${String(++runNo).padStart(6, '0')}`
      saveVault(k.db, k.userId, { railId: rail, request: { workspaceId: rail, owner: { signers: [], threshold: 1 }, rpIdHash: `0x${'00'.repeat(32)}`, origin: 'http://localhost:5175' }, credentialIds: [], createdAt: k.clock.now(), createdBy: k.userId })
      const chain = fake.addChain(rail, Math.floor(k.clock.now() / 1000) - 7200)
      chain.tx([chain.grant('treasury', 1_000_000_000n), chain.grant('owner-account', 50_000_000n)])
      chain.mine(2)

      const soundness = (): void => {
        expect(verifyLedger(k.db, k.userId)).toEqual([])
        expect(Number(available(k.db, k.userId, 'bank'))).toBeGreaterThanOrEqual(0)
        // 2. each instruction within its own signed month, and together within the limits' sum
        const together = new Map<string, bigint>()
        for (const id of [goal, invest]) for (const [m, v] of movedByMonth(k, id)) {
          expect(Number(v), `${id} in ${m}`).toBeLessThanOrEqual(limits.get(id)!)
          together.set(m, (together.get(m) ?? 0n) + v)
        }
        for (const [m, v] of together) expect(Number(v), `together in ${m}`).toBeLessThanOrEqual(limits.get(goal)! + limits.get(invest)!)
      }
      /** Time passing with the engine running, checking the reserve rule at every instant an instruction runs. */
      const runUntil = async (when: number): Promise<void> => {
        for (let i = 0; i < 200 && k.clock.now() < when; i++) {
          const due = k.db.get<{ t: number | null }>(`SELECT MIN(next_due_at) t FROM programs WHERE state = 'active' AND next_due_at > ? AND next_due_at <= ?`, k.clock.now(), when)?.t ?? null
          k.clock.set(due !== null ? due + 1000 : Math.min(when, k.clock.now() + DAY))
          const before = liquidity(k.db, k.userId, k.clock.now()).short
          const ran = k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'program'`)!.n
          await cycle(k)
          const after = liquidity(k.db, k.userId, k.clock.now()).short
          if (k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'program'`)!.n > ran) {
            reached.cyclesWithInstructionRuns++
            if (before === 0) { reached.notShortBeforeRun++; expect(after, 'an instruction run took a household that was not short into a shortfall').toBe(0) }
          }
          await cycle(k)
        }
      }
      soundness()
      for (const o of ops) {
        if (o.t === 'time') await runUntil(k.clock.now() + o.days * DAY)
        else if (o.t === 'hand') { if (await byHand(k, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: o.rupees * 100 })) reached.hand++ }
        else if (o.t === 'bill') { addBill(k.db, k.userId, { payeeId: payee.id, amount: o.rupees * 100, dueAt: k.clock.now() + 3 * DAY, memo: 'Electricity' }, k.clock.now()); reached.bills++ }
        else if (o.t === 'wallet') {
          const figures = () => { const ov = overview(k.db, k.market, k.userId, k.clock.now()); const l = liquidity(k.db, k.userId, k.clock.now()); return { bank: ov.bank, net: ov.netWorth, free: l.free, need: l.need, short: l.short, setAside: ov.setAside } }
          const before = figures()
          chain.tx([chain.pay(BigInt(o.rupees) * 100n)])
          chain.mine(2)
          await syncChainBooks({ dbPath: join(dir, 'qed.db') }, k.db, k.userId, k.clock.now())
          reached.walletSyncs++
          expect(figures(), 'wallet operations never move a rupee figure').toEqual(before)
        } else if (o.t === 'envelope') {
          // 3. the most every instruction together may move in 30 days, as shown, and then what happens
          const start = k.clock.now()
          const most = authorityEnvelope(k.db, k.userId, start).windows.find((w) => w.days === 30)!.most
          const movedBefore = instructionMoved(k, [goal, invest], start)
          await runUntil(start + 30 * DAY)
          const moved = Number(instructionMoved(k, [goal, invest], start) - movedBefore)
          reached.envelopes++; reached.instructionMoves += moved > 0 ? 1 : 0
          expect(moved, 'the instructions moved more in 30 days than the envelope said they could').toBeLessThanOrEqual(most)
        }
        soundness()
      }
    }), { seed: 4711, numRuns: 12 })
    console.info(`[aggregate limits] ${JSON.stringify(reached)}`)
    for (const [path, n] of Object.entries(reached)) expect(n, path).toBeGreaterThan(0)
  }, 600_000)
})
