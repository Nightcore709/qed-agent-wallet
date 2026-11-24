/**
 * Signed limits hold across a run's actions, reservations, retries, partial fills and concurrency (R13 section 4:
 * "Aggregate per-run authority holds across actions, reservations, retries and concurrency"; policy.ts decide,
 * liquidity.ts runUsage and programUsage).
 *
 * What a run, a day and a month have used is what their actions moved, or have in flight: an action in flight counts at
 * its full size, one that finished at what it moved, one that was refused, failed or cancelled at nothing. These tests
 * check that the money that leaves the bank for an action never exceeds the size the limits were checked against, so a
 * limit that held when an action was decided still holds when it is done; that a run's limit binds its actions together
 * (in flight, partly filled, retried after a restart); and that two passes of the engine over the same actions, at once,
 * move the money once.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { createAction, getAction, stepAction, stepAllActions } from './execute.ts'
import { balance, post, verifyLedger } from './ledger.ts'
import { programUsage, runUsage } from './liquidity.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { makeKit, type Kit, settle } from './testkit.ts'
import type { OrderParams, PaymentParams } from './types.ts'

const BTC = 'coindcx:BTCINR'
const state = (k: Kit, id: string): string => getAction(k.db, id)!.state
const DAY = 86_400_000

/** A ten-level book around ₹65 lakh a bitcoin, with the depth the test gives each level. */
function book(k: Kit, levels: { stepPaise: number; qty: string }[]): void {
  let price = 6_500_000_00 // paise
  const asks = levels.map((l) => { price += l.stepPaise; return [(price / 100).toFixed(2), l.qty] as [string, string] })
  k.book(BTC, [['6499000.00', '1']], asks)
  k.quote('coindcx:USDTINR', 'bid', '99.95'); k.quote('coindcx:USDTINR', 'ask', '100.05')
  k.quote('binance:BTCUSDT', 'bid', '65010'); k.quote('binance:BTCUSDT', 'ask', '65012')
}

describe('the money that leaves for an order is never more than the size its limits were checked against', () => {
  it('property: a purchase by amount is an all-in budget, the fee of every piece included, over random books, budgets and fee rates', async () => {
    const levels = fc.array(fc.record({ stepPaise: fc.integer({ min: 1, max: 5_000 }), qty: fc.constantFrom('0.00001', '0.00002', '0.00003', '0.00007', '0.00011', '0.00013') }), { minLength: 2, maxLength: 10 })
    await fc.assert(fc.asyncProperty(levels, fc.integer({ min: 50_000, max: 3_000_000 }), fc.constantFrom('0.005', '0.0049', '0.0051', '0.00333', '0.001'), async (lv, budget, fee) => {
      const k = makeKit()
      k.db.run(`UPDATE terms SET value_json = json_set(value_json, '$.rate', ?) WHERE id = 'fee.paper-crypto.taker'`, fee)
      book(k, lv)
      const o = k.venues.crypto.submit({ clientRef: 'b1', userId: k.userId, instrumentId: BTC, side: 'buy', type: 'market', amount: BigInt(budget), maxSlippageBps: 1_000 })
      await k.venues.crypto.tick()
      const after = k.venues.crypto.get(o.clientRef)!
      // what the purchase takes from the bank (bookFill: consideration plus fee) fits the budget it was sized to
      expect(after.filledAmount + after.fees).toBeLessThanOrEqual(BigInt(budget))
    }), { seed: 4_2026, numRuns: 300 })
  })

  it('a tight budget over two levels: each piece\'s fee rounded up must not take the purchase past its budget (the random budgets above are rarely tight)', async () => {
    // two levels of one step each (0.00001 BTC): ₹64.005 and ₹64.006 of consideration, so ₹64.01 each rounded up; at a
    // 0.5% fee the exact fees are ₹0.32005 each, ₹0.33 each rounded up. ₹128.67 is the least budget whose consideration
    // part (₹128.67 / 1.005, rounded down: ₹128.02) buys both pieces: ₹128.02 + ₹0.66 is ₹128.68, a paisa over.
    const k = makeKit()
    k.db.run(`UPDATE terms SET value_json = json_set(value_json, '$.rate', ?) WHERE id = 'fee.paper-crypto.taker'`, '0.005')
    k.book(BTC, [['6400000.00', '1']], [['6400500.00', '0.00001'], ['6400600.00', '0.00001']])
    const o = k.venues.crypto.submit({ clientRef: 'tight', userId: k.userId, instrumentId: BTC, side: 'buy', type: 'market', amount: 12_867n, maxSlippageBps: 1_000 })
    await k.venues.crypto.tick()
    const after = k.venues.crypto.get(o.clientRef)!
    expect(after.filledAmount + after.fees).toBeLessThanOrEqual(12_867n)
    // both pieces with their fees do not fit, and one alone is under the venue's ₹100 minimum: refused, nothing taken
    expect(after).toMatchObject({ state: 'rejected', filledQty: 0n })
    expect(after.rejectReason).toMatch(/below the venue minimum/)
  })

  it('end to end: an instruction\'s purchase at its per-run limit takes no more from the bank than the limit', async () => {
    // three pieces of one step (₹64.01 each rounded up, fees ₹0.33 each rounded up from ₹0.32005): ₹193.00 is the least
    // budget that buys all three by consideration, and consideration and fees came to ₹193.02 before R13
    const k = makeKit({ profile: { line: 0 } })
    k.db.run(`UPDATE terms SET value_json = json_set(value_json, '$.rate', ?) WHERE id = 'fee.paper-crypto.taker'`, '0.005')
    k.btc(6_400_550)
    k.book(BTC, [['6400000.00', '1']], [['6400500.00', '0.00001'], ['6400600.00', '0.00001'], ['6400700.00', '0.00001']])
    const id = instruction(k, 'invest', { instrumentId: BTC, amount: 19_300, schedule: { type: 'monthly', day: 5, at: '10:00' } }, { maxPerRun: 19_300, maxPerMonth: 19_300 })
    const runId = 'run_tight'
    k.db.run(`INSERT INTO runs (id, program_id, user_id, version, occurrence, due_at, state, trigger_json, decision_json, created_at) VALUES (?, ?, ?, 1, 1, ?, 'executing', '{}', '{}', ?)`, runId, id, k.userId, k.clock.now(), k.clock.now())
    const bank = balance(k.db, k.userId, 'bank')
    const act = createAction(k.ctx, { userId: k.userId, runId, programId: id, origin: 'program', kind: 'order', venue: 'paper-crypto', economicId: `${id}#1#0`, params: { instrumentId: BTC, side: 'buy', type: 'market', amount: '19300', maxSlippageBps: 1_000, purpose: 'invest' } satisfies OrderParams })
    await settle(k, 4)
    expect(getAction(k.db, act.id)!.state).not.toBe('blocked')
    expect(bank - balance(k.db, k.userId, 'bank')).toBeGreaterThan(0n)
    expect(bank - balance(k.db, k.userId, 'bank')).toBeLessThanOrEqual(19_300n)
    expect(runUsage(k.db, runId)).toBeLessThanOrEqual(19_300n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
})

/** A signed instruction whose runs are approved by itself, with the limits given. */
function instruction(k: Kit, kind: string, params: Record<string, unknown>, authority: Record<string, unknown>): string {
  const d = saveDraft(k.ctx, k.userId, { kind, params, authority: { expiresAt: k.clock.now() + 10 * DAY, runMode: 'auto', ...authority } })
  const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
  return d.programId
}

describe('a run\'s limit binds its actions together', () => {
  /** A run of a program with hand-made actions, as a split or a rebalance makes several, under a ₹10,000 run limit. */
  function runWith(k: Kit, sizes: number[]): { programId: string; runId: string; actions: string[] } {
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const programId = instruction(k, 'invest', { instrumentId: 'amfi:120716', amount: 1_000_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }, { maxPerRun: 1_000_000, maxPerMonth: 5_000_000 })
    const runId = 'run_limits'
    k.db.run(`INSERT INTO runs (id, program_id, user_id, version, occurrence, due_at, state, trigger_json, decision_json, created_at) VALUES (?, ?, ?, 1, 1, ?, 'executing', '{}', '{}', ?)`, runId, programId, k.userId, k.clock.now(), k.clock.now())
    const actions = sizes.map((s, i) => createAction(k.ctx, { userId: k.userId, runId, programId, origin: 'program', kind: 'order', venue: 'paper-mf', economicId: `${programId}#1#${i}`, params: { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: String(s), purpose: 'invest' } satisfies OrderParams }).id)
    return { programId, runId, actions }
  }

  it('an action in flight counts at its full size: the next one is refused when together they would pass the run\'s limit', async () => {
    const k = makeKit()
    const { runId, actions } = runWith(k, [700_000, 400_000])
    await stepAction(k.ctx, actions[0]!) // sent to the registrar: in flight
    expect(state(k, actions[0]!)).toBe('working')
    await stepAction(k.ctx, actions[1]!)
    expect(state(k, actions[1]!)).toBe('blocked')
    expect(getAction(k.db, actions[1]!)!.error).toMatch(/already in this run plus .* against ₹10,000\.00 per run/)
    expect(runUsage(k.db, runId)).toBe(700_000n)
  })

  it('an action retried after a restart (stepped again from the state it was left in) is counted once and sent once', async () => {
    const k = makeKit()
    const { runId, programId, actions } = runWith(k, [600_000])
    await stepAction(k.ctx, actions[0]!)
    // the engine died after the money was committed to the order and before the registrar's answer was recorded: the
    // action is left 'submitting', and the next engine sends it again, with the same reference, three times over
    k.db.run(`UPDATE actions SET state = 'submitting' WHERE id = ?`, actions[0]!)
    for (let i = 0; i < 3; i++) { await stepAction(k.ctx, actions[0]!); k.db.run(`UPDATE actions SET state = 'submitting' WHERE id = ?`, actions[0]!) }
    await stepAction(k.ctx, actions[0]!)
    // one order at the registrar for this household, whatever reference it would carry
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders WHERE user_id = ?', k.userId)!.n).toBe(1)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders WHERE client_ref = ?', `${programId}#1#0`)!.n).toBe(1)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE ref = ?`, `mf:${programId}#1#0:pay`)!.n).toBe(1)
    expect(runUsage(k.db, runId)).toBe(600_000n)
    expect(programUsage(k.db, programId, 0)).toBe(600_000n)
  })

  it('two passes of the engine over the same actions at once move the money once, and the run\'s limit still binds them', async () => {
    const k = makeKit()
    const { runId, actions } = runWith(k, [700_000, 700_000])
    const bank = balance(k.db, k.userId, 'bank')
    await Promise.all([stepAllActions(k.ctx), stepAllActions(k.ctx), stepAllActions(k.ctx)])
    expect(actions.map((a) => state(k, a)).sort()).toEqual(['blocked', 'working'])
    expect(bank - balance(k.db, k.userId, 'bank')).toBe(700_000n)
    expect(runUsage(k.db, runId)).toBe(700_000n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('the share that goes over the run\'s limit is refused, as the run\'s sheet says, not an earlier one: a split pays its first share and refuses the second', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    // half to the card and half to a fund, at most ₹60,000 in one run; a ₹1,20,000 salary asks for two ₹60,000 shares
    const id = instruction(k, 'split', { rules: [{ to: 'card', shareBps: 5000 }, { to: 'fund', instrumentId: 'amfi:120716', shareBps: 5000 }] }, { maxPerRun: 6_000_000, maxPerMonth: 100_000_000, expiresAt: k.clock.now() + 60 * DAY })
    k.clock.advance(10_000); triggerTick(k.ctx); runTick(k.ctx); await stepAllActions(k.ctx)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'income-salary', ref: 'salary:2026-12', memo: 'Salary', lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    for (let i = 0; i < 3; i++) { k.clock.advance(15_000); triggerTick(k.ctx); runTick(k.ctx); await stepAllActions(k.ctx); await k.venues.rail.tick(); await stepAllActions(k.ctx); runTick(k.ctx) }
    // the shares in the order the owner wrote them, and in the order the run planned them
    const acts = k.db.all<{ state: string; purpose: string; error: string | null }>(`SELECT state, json_extract(params_json, '$.purpose') purpose, error FROM actions WHERE program_id = ? ORDER BY economic_id`, id)
    expect(acts.map((a) => a.purpose)).toEqual(['card', 'income-split'])
    expect(acts[0]!.state).not.toBe('blocked')
    expect(acts[1]).toMatchObject({ state: 'blocked' })
    expect(acts[1]!.error).toMatch(/already in this run plus .* per run/)
    // and the sheet the owner approves a run on says so: what goes over the limit is refused when it is sent
    expect(acts.filter((a) => a.state !== 'blocked')).toHaveLength(1)
  })

  it('a purchase partly filled counts at what it moved, and what it did not move is free for the run\'s next action', async () => {
    const k = makeKit()
    k.btc(6_500_000)
    // a thin book: ₹10,000 buys only part of what is asked for inside the slippage bound
    k.book(BTC, [['6499500.00', '1']], [['6500500.00', '0.0007']])
    const programId = instruction(k, 'invest', { instrumentId: BTC, amount: 1_000_000, schedule: { type: 'monthly', day: 5, at: '10:00' } }, { maxPerRun: 1_000_000, maxPerMonth: 5_000_000 })
    const runId = 'run_partial'
    k.db.run(`INSERT INTO runs (id, program_id, user_id, version, occurrence, due_at, state, trigger_json, decision_json, created_at) VALUES (?, ?, ?, 1, 1, ?, 'executing', '{}', '{}', ?)`, runId, programId, k.userId, k.clock.now(), k.clock.now())
    const first = createAction(k.ctx, { userId: k.userId, runId, programId, origin: 'program', kind: 'order', venue: 'paper-crypto', economicId: `${programId}#1#0`, params: { instrumentId: BTC, side: 'buy', type: 'market', amount: '1000000', maxSlippageBps: 100, purpose: 'invest' } satisfies OrderParams })
    await settle(k, 4)
    const done = getAction(k.db, first.id)!
    expect(done.state).toBe('partial')
    const moved = BigInt(String(done.result.movedPaise))
    expect(moved).toBeLessThan(1_000_000n)
    expect(runUsage(k.db, runId)).toBe(moved)
    // the money that did not move is not counted, so a second action of the same run may use what is left, and no more
    const rest = 1_000_000n - moved
    const pay = (eid: string, amount: bigint) => createAction(k.ctx, { userId: k.userId, runId, programId, origin: 'program', kind: 'payment', venue: 'paper-rail', economicId: eid, params: { payeeHandle: 'x@upi', payeeName: 'X', amount: String(amount), purpose: 'spend' } satisfies PaymentParams })
    const over = pay(`${programId}#1#1`, rest + 1n)
    await stepAction(k.ctx, over.id)
    expect(state(k, over.id)).toBe('blocked')
    expect(getAction(k.db, over.id)!.error).toMatch(/per run/)
  })
})

describe('a day\'s and a month\'s limit bind runs together the same way', () => {
  it('two runs of one instruction executing together: the later run\'s purchase is the one refused by the day and month limits, whichever is decided first', async () => {
    for (const order of ['in turn', 'later first'] as const) {
      const k = makeKit()
      k.nav('amfi:120716', '2026-11-17', '178.8713')
      const id = instruction(k, 'invest', { instrumentId: 'amfi:120716', amount: 600_000, schedule: { type: 'every', minutes: 5 } }, { maxPerRun: 600_000, maxPerMonth: 1_000_000, maxPerDay: 1_000_000 })
      // two runs executing at once (as after the engine caught up), each with a ₹6,000 purchase
      const acts = [1, 2].map((n) => {
        k.db.run(`INSERT INTO runs (id, program_id, user_id, version, occurrence, due_at, state, trigger_json, decision_json, created_at) VALUES (?, ?, ?, 1, ?, ?, 'executing', '{}', '{}', ?)`, `run_${n}`, id, k.userId, n, k.clock.now(), k.clock.now())
        return createAction(k.ctx, { userId: k.userId, runId: `run_${n}`, programId: id, origin: 'program', kind: 'order', venue: 'paper-mf', economicId: `${id}#${n}#0`, params: { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: '600000', purpose: 'invest' } satisfies OrderParams }).id
      })
      for (const a of order === 'in turn' ? acts : [...acts].reverse()) await stepAction(k.ctx, a)
      expect(acts.map((a) => state(k, a)), order).toEqual(['working', 'blocked'])
      expect(getAction(k.db, acts[1]!)!.error, order).toMatch(/used (this month|today) plus .* against ₹10,000\.00/)
      expect(programUsage(k.db, id, 0), order).toBe(600_000n)
    }
  })
})
