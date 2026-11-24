import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateMandate, purchase, prepareMandate, settledPayment } from './commerce.ts'
import { setSimServices, startSimServices } from './commerce-sim.ts'
import { FakeClock } from './core.ts'
import { DOWN_AFTER_MS, Engine, engineStatus } from './engine.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { T0 } from './testkit.ts'

function boot(): { engine: Engine; clock: FakeClock; userId: string } {
  const clock = new FakeClock(T0)
  const engine = new Engine({ dbPath: ':memory:' }, { clock, live: false })
  const userId = 'usr_engine'
  engine.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'owner', 'Owner', 'x', clock.now())
  openHousehold(engine.db, userId, DEFAULT_OPENING, {}, clock.now())
  return { engine, clock, userId }
}

describe('the engine is honest about time it did not run', () => {
  it('a suspended process (the machine slept) is noticed from the gap between ticks, recorded and disclosed', async () => {
    const { engine, clock, userId } = boot()
    const { ctx } = engine
    ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: '178.8713', sourceTs: T0 - 86_400_000, precision: 'day', recvTs: T0, provider: 'test' })
    const d = saveDraft(ctx, userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 10 } }, authority: { expiresAt: T0 + 30 * 86_400_000 } })
    const req = requestProgramApproval(ctx, userId, d.programId, ['schedule-over-limit'])
    confirmApproval(engine.db, userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, clock.now())
    activateProgram(ctx, userId, d.programId, req.approvalId)

    await engine.tick()
    clock.advance(1000); await engine.tick()
    expect(engine.db.get<{ n: number }>('SELECT COUNT(*) n FROM downtime')!.n).toBe(0)

    clock.advance(47 * 60_000) // the lid was closed for 47 minutes; the process never restarted
    await engine.tick()
    const gap = engine.db.get<{ from_ts: number; to_ts: number; note: string }>('SELECT from_ts, to_ts, note FROM downtime')!
    expect(gap.to_ts - gap.from_ts).toBe(47 * 60_000)
    expect(gap.note).toMatch(/asleep or the process was stalled/)
    const n = engine.db.get<{ title: string; body: string }>("SELECT title, body FROM notices WHERE kind = 'engine-was-down' AND resolved_at IS NULL")!
    expect(n.title).toBe('QED was not running for 47 minutes')
    expect(n.body).toMatch(/nothing was executed/)
    const runs = engine.db.all<{ state: string }>('SELECT state FROM runs WHERE program_id = ?', d.programId)
    expect(runs.filter((r) => r.state === 'missed').length).toBeGreaterThanOrEqual(4)
    expect(engine.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n).toBe(0) // nothing was executed for the missed occurrences

    clock.advance(1000); await engine.tick()
    clock.advance(31 * 60_000); await engine.tick() // a second sleep: the same notice is rewritten, not multiplied
    expect(engine.db.get<{ n: number }>('SELECT COUNT(*) n FROM downtime')!.n).toBe(2)
    const open = engine.db.all<{ title: string }>("SELECT title FROM notices WHERE kind = 'engine-was-down' AND resolved_at IS NULL")
    expect(open.length).toBe(1)
    expect(open[0]!.title).toBe('QED was not running for 78 minutes in 2 periods')
    engine.stop()
  })

  it('a short pause between ticks is not reported, and the heartbeat tells other processes whether the engine is alive', async () => {
    const { engine, clock } = boot()
    engine.start()
    await engine.tick()
    clock.advance(DOWN_AFTER_MS - 1000); await engine.tick()
    expect(engine.db.get<{ n: number }>('SELECT COUNT(*) n FROM downtime')!.n).toBe(0)
    expect(engineStatus(engine.db, clock.now()).running).toBe(true)
    expect(engineStatus(engine.db, clock.now() + DOWN_AFTER_MS + 1).running).toBe(false)
    engine.stop()
  })
})

describe('the engine finishes what an agent bought and left paying', () => {
  it('a purchase whose payment settled after the request ended is delivered by the engine\'s own pass, once', async () => {
    const { engine, clock, userId } = boot()
    const sim = await startSimServices((ref, amount, payTo) => settledPayment(engine.db)(ref, amount, payTo))
    setSimServices(sim)
    try {
      const p = prepareMandate(engine.ctx, userId, { perPurchase: 5000, perMonth: 8000, services: ['sim-alpha', 'sim-beta'] })
      confirmApproval(engine.db, userId, p.approvalId, { method: 'passkey', docHash: sha256hex(p.document) }, clock.now())
      activateMandate(engine.ctx, userId, p.approvalId)
      const made = await purchase(engine.ctx, userId, { sku: 'fund-digest', idempotencyKey: 'engine-test-0001' }, { waitMs: 0 })
      expect(made.state).toBe('paying')
      for (let i = 0; i < 40 && engine.db.get<{ state: string }>('SELECT state FROM commerce_purchases WHERE id = ?', made.id)!.state === 'paying'; i++) { clock.advance(1000); await engine.tick() }
      const row = engine.db.get<{ state: string; receipt_json: string | null }>('SELECT state, receipt_json FROM commerce_purchases WHERE id = ?', made.id)!
      expect(row.state).toBe('paid')
      expect(JSON.parse(row.receipt_json!)).toMatchObject({ simulated: true, amount: 2800 })
      // the next pass finds nothing left to do
      clock.advance(11_000); await engine.tick()
      expect(engine.db.get<{ state: string }>('SELECT state FROM commerce_purchases WHERE id = ?', made.id)!.state).toBe('paid')
    } finally { setSimServices(null); await sim.close() }
  })
})
