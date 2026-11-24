/**
 * A payment's cancel racing the engine (R13 section 4: "cancellation, ... concurrent requests"). The API and the engine
 * are two processes with two connections to one database; each reads an action, then writes it in a transaction. A cancel
 * that commits between the engine's read and its transaction must win (nothing is sent), and an engine that sends between
 * the cancel's read and its transaction must win (the payment is not recorded as cancelled while it is on the rail). Each
 * side reads the action again under the write lock (BEGIN IMMEDIATE) and acts only if it is still in the state it read.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { type Db, FakeClock, openDb } from './core.ts'
import { cancelAction, getAction, stepAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { available, verifyLedger } from './ledger.ts'
import { Market } from './market.ts'
import { addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { seedRegistry } from './registry.ts'
import { T0 } from './testkit.ts'
import type { Ctx, PaymentParams } from './types.ts'
import { PaperCryptoVenue, PaperFundVenue, PaperRail } from './venues.ts'

const USER = 'usr_test'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Two processes on one database file, sharing a clock the test moves. */
function twoProcesses() {
  const dir = mkdtempSync(join(tmpdir(), 'qed-hold-race-')); dirs.push(dir)
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
  const engine = proc()
  return { api, engine, clock, close: () => { api.db.close(); engine.db.close() } }
}
/** Run `first` (the other process's step) just before this connection's next transaction begins. */
function before(db: Db, first: () => void): void {
  const tx = db.tx.bind(db)
  let done = false
  db.tx = <T>(fn: () => T): T => { if (!done) { done = true; first() } return tx(fn) }
}
async function approvedPayment(api: Ctx, amount: number) {
  const y = addPayee(api.db, USER, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, api.clock.now())
  const pv = await previewAction(api, USER, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount })
  confirmApproval(api.db, USER, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, api.clock.now())
  const hold = (JSON.parse(pv.document) as { action: { params: PaymentParams } }).action.params.hold
  return { act: submitApprovedAction(api, USER, pv.approvalId), until: hold?.until ?? null }
}
const onRail = (db: Db) => db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments')!.n

describe('a cancel racing the engine', () => {
  it('a cancel that commits after the engine read the payment as waiting, but before it released it: nothing is sent', async () => {
    const { api, engine, clock, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const { act, until } = await approvedPayment(api, 1_500_000)
    await stepAction(engine, act.id)
    expect(getAction(api.db, act.id)!.state).toBe('held')
    clock.set(until! + 1000)
    before(engine.db, () => { cancelAction(api, USER, act.id) })
    await stepAction(engine, act.id)
    expect(getAction(api.db, act.id)).toMatchObject({ state: 'cancelled', error: 'Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.' })
    expect(onRail(api.db)).toBe(0)
    expect(available(api.db, USER, 'bank')).toBe(bank)
    expect(verifyLedger(api.db, USER)).toEqual([])
    close()
  })

  it('a cancel that read the payment as waiting, but reaches its transaction after the engine sent it: refused, and it stays sent', async () => {
    const { api, engine, clock, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const { act, until } = await approvedPayment(api, 1_500_000)
    await stepAction(engine, act.id)
    clock.set(until! + 1000)
    before(api.db, () => { void stepAction(engine, act.id) })
    expect(() => cancelAction(api, USER, act.id)).toThrow(/cannot be recalled|already finished/)
    const a = getAction(api.db, act.id)!
    expect(['working', 'done']).toContain(a.state)
    expect(onRail(api.db)).toBe(1)
    expect(available(api.db, USER, 'bank')).toBe(bank - 1_500_000n)
    expect(verifyLedger(api.db, USER)).toEqual([])
    close()
  })

  it('the same for a payment that does not wait: a cancel between the engine deciding it and sending it wins', async () => {
    const { api, engine, close } = twoProcesses()
    const bank = available(api.db, USER, 'bank')
    const { act, until } = await approvedPayment(api, 500_000)
    expect(until).toBeNull()
    before(engine.db, () => { cancelAction(api, USER, act.id) })
    await stepAction(engine, act.id)
    expect(getAction(api.db, act.id)).toMatchObject({ state: 'cancelled', error: 'Cancelled by you before it was submitted.' })
    expect(onRail(api.db)).toBe(0)
    expect(available(api.db, USER, 'bank')).toBe(bank)
    expect(verifyLedger(api.db, USER)).toEqual([])
    close()
  })

  it('two cancels at once: one cancels, the other is told it has finished', async () => {
    const { api, engine, close } = twoProcesses()
    const { act } = await approvedPayment(api, 1_500_000)
    await stepAction(engine, act.id)
    before(api.db, () => { cancelAction(engine, USER, act.id) })
    expect(() => cancelAction(api, USER, act.id)).toThrow(/already finished/)
    expect(getAction(api.db, act.id)!.state).toBe('cancelled')
    expect(api.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE action = 'action.cancel' AND subject = ?`, act.id)!.n).toBe(1)
    close()
  })
})
