/**
 * A second, separately approved payment that repeats an earlier one is held for the person's confirmation (audit finding S4,
 * server/duplicates.ts): the same bill, or the same payee and amount within 24 hours. Enforced where the payment starts, so
 * races, retries and cancellation are covered here, not only the screen.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { type Db, FakeClock, openDb } from './core.ts'
import { DUPLICATE_CONFIRM_BY_MS, DUPLICATE_WINDOW_MS, repeatOf } from './duplicates.ts'
import { cancelAction, confirmRepeat, getAction, stepAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { available, verifyLedger } from './ledger.ts'
import { Market } from './market.ts'
import { addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { seedRegistry } from './registry.ts'
import { T0 } from './testkit.ts'
import type { Ctx } from './types.ts'
import { PaperCryptoVenue, PaperFundVenue, PaperRail } from './venues.ts'

const USER = 'usr_test'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function twoProcesses() {
  const dir = mkdtempSync(join(tmpdir(), 'qed-dup-')); dirs.push(dir)
  const path = join(dir, 'qed.db')
  const clock = new FakeClock(T0)
  const proc = (): Ctx => {
    const db = openDb(path)
    const market = new Market(db, clock)
    return { db, clock, market, venues: { crypto: new PaperCryptoVenue(db, market, clock, async () => { throw new Error('no book in this test') }), funds: new PaperFundVenue(db, clock), rail: new PaperRail(db, clock) } }
  }
  const api = proc()
  seedRegistry(api.db)
  api.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', USER, 'tester', 'Test Owner', 'x', T0)
  openHousehold(api.db, USER, DEFAULT_OPENING, {}, T0)
  const payee = addPayee(api.db, USER, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, T0 - 3 * 86_400_000)
  const engine = proc()
  return { api, engine, clock, payee, close: () => { api.db.close(); engine.db.close() } }
}
function before(db: Db, first: () => void): void {
  const tx = db.tx.bind(db)
  let done = false
  db.tx = <T>(fn: () => T): T => { if (!done) { done = true; first() } return tx(fn) }
}
/** Preview and approve a payment (nothing is submitted yet). */
async function approve(api: Ctx, body: Record<string, unknown>) {
  const pv = await previewAction(api, USER, { kind: 'payment', purpose: 'spend', ...body })
  confirmApproval(api.db, USER, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, api.clock.now())
  return pv
}
/** Asked for one millisecond after the last, so that "earlier" is by time, as in life (the same moment is tested on its own). */
const pay = async (api: Ctx, payeeId: string, amount = 50_000) => { (api.clock as FakeClock).set(api.clock.now() + 1); return submitApprovedAction(api, USER, (await approve(api, { payeeId, amount })).approvalId) }
const onRail = (db: Db) => db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n

describe('a payment that repeats an earlier one', () => {
  it('is held, with its money set aside, and sent only after the person confirms it', async () => {
    const { api, clock, payee, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const first = await pay(api, payee.id)
    await stepAction(api, first.id)
    expect(onRail(api.db)).toBe(1)
    clock.set(T0 + 60_000)
    const second = await pay(api, payee.id)
    const held = await stepAction(api, second.id)
    expect(held.state).toBe('held')
    expect(held.result.awaitingConfirmation).toMatchObject({ since: T0 + 60_001 })
    expect(String((held.result.awaitingConfirmation as { why: string }).why)).toContain('within 24 hours')
    expect(onRail(api.db)).toBe(1)
    expect(available(api.db, USER, 'bank')).toBe(bank - 100_000n)
    // stepping again, as a retry or the engine's next pass, changes nothing while it is unconfirmed
    expect((await stepAction(api, second.id)).state).toBe('held')
    expect(onRail(api.db)).toBe(1)
    confirmRepeat(api, USER, second.id)
    confirmRepeat(api, USER, second.id) // confirming twice is the same confirmation
    const sent = await stepAction(api, second.id)
    expect(sent.state).not.toBe('held')
    expect(onRail(api.db)).toBe(2)
    expect(verifyLedger(api.db, USER)).toEqual([])
    close()
  })

  it('is not held when the amount differs, or more than 24 hours passed, or the earlier payment ended unsent', async () => {
    const { api, clock, payee, close } = twoProcesses()
    const a = await pay(api, payee.id, 50_000); await stepAction(api, a.id)
    const other = await pay(api, payee.id, 60_000)
    expect((await stepAction(api, other.id)).state).not.toBe('held')
    clock.set(T0 + DUPLICATE_WINDOW_MS + 1000)
    const late = await pay(api, payee.id, 50_000)
    expect((await stepAction(api, late.id)).state).not.toBe('held')
    // an earlier payment that was cancelled before it went does not count
    clock.set(T0 + 3 * DUPLICATE_WINDOW_MS)
    const x = await pay(api, payee.id, 70_000)
    cancelAction(api, USER, x.id)
    const y = await pay(api, payee.id, 70_000)
    expect((await stepAction(api, y.id)).state).not.toBe('held')
    close()
  })

  it('counts a payment for the same bill as a repeat, whatever else differs, and one that ended unsent as none', () => {
    const { api, payee, close } = twoProcesses()
    // submitApprovedAction already refuses a second payment for a bill under way; the rule also covers an instruction's payment
    const row = (id: string, state: string, billId: string) => api.db.run(`INSERT INTO actions (id, user_id, origin, kind, venue, economic_id, state, params_json, created_at, updated_at) VALUES (?, ?, 'program', 'payment', 'paper-rail', ?, ?, ?, ?, ?)`,
      id, USER, `e-${id}`, state, JSON.stringify({ payeeHandle: payee.handle, payeeName: 'Ravi Kumar', amount: '80000', purpose: 'bill', billId }), T0, T0)
    row('act_earlier', 'done', 'bil_1')
    const mine = { payeeHandle: payee.handle, amount: '55555', purpose: 'bill' as const, billId: 'bil_1' }
    expect(repeatOf(api.db, USER, mine, { id: 'act_now', createdAt: T0 + 5 })).toMatchObject({ of: 'act_earlier', reason: 'bill' })
    expect(repeatOf(api.db, USER, { ...mine, billId: 'bil_2' }, { id: 'act_now', createdAt: T0 + 5 })).toBeNull()
    api.db.run(`UPDATE actions SET state = 'failed' WHERE id = 'act_earlier'`)
    expect(repeatOf(api.db, USER, mine, { id: 'act_now', createdAt: T0 + 5 })).toBeNull()
    close()
  })

  it('cancelling it while it waits frees its money and sends nothing', async () => {
    const { api, payee, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const a = await pay(api, payee.id); await stepAction(api, a.id)
    const b = await pay(api, payee.id); await stepAction(api, b.id)
    expect(getAction(api.db, b.id)!.state).toBe('held')
    cancelAction(api, USER, b.id)
    expect(getAction(api.db, b.id)).toMatchObject({ state: 'cancelled' })
    expect(onRail(api.db)).toBe(1)
    expect(available(api.db, USER, 'bank')).toBe(bank - 50_000n)
    expect(() => confirmRepeat(api, USER, b.id)).toThrow(/not waiting/)
    close()
  })

  it('goes on without a confirmation when the earlier payment is cancelled while it waits', async () => {
    const { api, payee, close } = twoProcesses()
    const a = await pay(api, payee.id)
    const b = await pay(api, payee.id)
    expect((await stepAction(api, b.id)).state).toBe('held') // the earlier one is still planned: it will go
    cancelAction(api, USER, a.id)
    const next = await stepAction(api, b.id)
    expect(next.state).not.toBe('held')
    expect(onRail(api.db)).toBe(1)
    close()
  })

  it('is cancelled with nothing sent when 48 hours pass unconfirmed', async () => {
    const { api, clock, payee, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const a = await pay(api, payee.id); await stepAction(api, a.id)
    const b = await pay(api, payee.id); await stepAction(api, b.id)
    clock.set(T0 + DUPLICATE_CONFIRM_BY_MS + 1000)
    const done = await stepAction(api, b.id)
    expect(done.state).toBe('cancelled')
    expect(String(done.error)).toContain('48 hours')
    expect(onRail(api.db)).toBe(1)
    expect(available(api.db, USER, 'bank')).toBe(bank - 50_000n)
    close()
  })

  it('is held for exactly one of two payments asked for at the same moment', async () => {
    const { api, payee, close } = twoProcesses()
    const pa = await approve(api, { payeeId: payee.id, amount: 50_000 })
    const pb = await approve(api, { payeeId: payee.id, amount: 50_000 })
    const a = submitApprovedAction(api, USER, pa.approvalId), b = submitApprovedAction(api, USER, pb.approvalId)
    await stepAction(api, a.id); await stepAction(api, b.id)
    const states = [getAction(api.db, a.id)!.state, getAction(api.db, b.id)!.state]
    expect(states.filter((s) => s === 'held')).toHaveLength(1)
    expect(onRail(api.db)).toBe(1)
    close()
  })

  it('counts a payment another process asked for between the decision and the start', async () => {
    const { api, engine, clock, payee, close } = twoProcesses()
    clock.set(T0 + 1000)
    const b = await pay(api, payee.id)
    const pa = await approve(api, { payeeId: payee.id, amount: 50_000 })
    let a = ''
    before(engine.db, () => { clock.set(T0 + 500); a = submitApprovedAction(api, USER, pa.approvalId).id })
    const r = await stepAction(engine, b.id)
    expect(a).not.toBe('')
    expect(r.state).toBe('held')
    expect(onRail(api.db)).toBe(0)
    close()
  })

  it('is said on the sheet the passkey signs, with the rule', async () => {
    const { api, payee, close } = twoProcesses()
    const a = await pay(api, payee.id); await stepAction(api, a.id)
    const pv = await previewAction(api, USER, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 50_000 })
    expect(pv.warnings.join(' ')).toContain('same payee and the same amount within 24 hours')
    expect(pv.lines.find((l) => l.label === 'Repeat of an earlier payment')).toMatchObject({ value: 'Held for your confirmation before it is sent' })
    close()
  })
})
