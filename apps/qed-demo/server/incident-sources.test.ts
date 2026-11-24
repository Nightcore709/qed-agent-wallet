/**
 * Where incidents come from (R13, RE6): the engine's own gap, the wallet service not answering, reconciliation finding a
 * difference, and the engine's heartbeat going stale as the API reads it (readiness). QED_SEED_FAIL=1 fails the last test.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { DOWN_AFTER_MS, Engine } from './engine.ts'
import { FakeClock } from './core.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { incidentsFor } from './incident-watch.ts'
import { incidentsView } from './incidents.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { T0 } from './testkit.ts'

type Private = { recordVault(what: string, now: number): void; recordRecon(u: string, r: { ok: boolean; breaks: string[]; repaired: string[] }, now: number): void }
const tick = async (e: Engine): Promise<void> => { while ((e as unknown as { busy: boolean }).busy) await new Promise((r) => setTimeout(r, 5)); await e.tick(); while ((e as unknown as { busy: boolean }).busy) await new Promise((r) => setTimeout(r, 5)) }

function boot() {
  const clock = new FakeClock(T0)
  const engine = new Engine({ dbPath: ':memory:' }, { clock, live: false })
  engine.start()
  const userId = 'usr_src'
  engine.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'owner', 'Owner', 'x', clock.now())
  openHousehold(engine.db, userId, DEFAULT_OPENING, {}, clock.now())
  return { engine, clock, userId }
}

describe('incidents from each source', () => {
  it('engine: a gap becomes an incident from its start to its end, with the runs it missed', async () => {
    const { engine, clock, userId } = boot()
    try {
      engine.ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: '178.8713', sourceTs: T0 - 86_400_000, precision: 'day', recvTs: T0, provider: 'test' })
      const d = saveDraft(engine.ctx, userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 10 } }, authority: { expiresAt: T0 + 30 * 86_400_000 } })
      const req = requestProgramApproval(engine.ctx, userId, d.programId, ['schedule-over-limit'])
      confirmApproval(engine.db, userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, clock.now())
      activateProgram(engine.ctx, userId, d.programId, req.approvalId)
      await tick(engine)
      const from = clock.now()
      clock.advance(47 * 60_000); await tick(engine)
      const i = incidentsView(engine.db).recent.find((x) => x.key === 'engine-down')!
      expect([i.source, i.openedAt, i.resolvedAt]).toEqual(['engine', from, from + 47 * 60_000])
      expect(i.affected.missedRuns).toBeGreaterThanOrEqual(1)
      expect(i.resolution).toMatch(/marked missed and will not be run late/)
      expect(i.events.map((e) => e.event)).toEqual(['opened', 'resolved'])
    } finally { engine.stop() }
  })

  it('wallet service: no answer opens an incident, counts the ticks it cost, and an accepted tick closes it', () => {
    const { engine, clock } = boot()
    try {
      const p = engine as unknown as Private
      p.recordVault('tick not accepted in v1 (no answer)', clock.now())
      p.recordVault('failed: connect ECONNREFUSED', clock.now() + 300_000)
      expect(incidentsView(engine.db).open[0]).toMatchObject({ key: 'wallet-service', source: 'wallet-service', openedAt: clock.now(), affected: { missedTicks: 2 } })
      p.recordVault('tick abc in v1', clock.now() + 600_000)
      const done = incidentsView(engine.db).recent[0]!
      expect([done.resolvedAt, done.affected.missedTicks]).toEqual([clock.now() + 600_000, 2])
      expect(done.resolution).toMatch(/2 scheduled ticks had been missed/)
    } finally { engine.stop() }
  })

  it('reconciliation: a difference opens an incident for that owner once, agreement closes it', () => {
    const { engine, clock, userId } = boot()
    try {
      const p = engine as unknown as Private
      p.recordRecon(userId, { ok: false, breaks: ['The venue shows a fill (f1) for an order the wallet never placed.'], repaired: [] }, clock.now())
      p.recordRecon(userId, { ok: false, breaks: ['The venue shows a fill (f1) for an order the wallet never placed.'], repaired: [] }, clock.now() + 30_000)
      const open = incidentsView(engine.db).open
      expect(open).toHaveLength(1)
      expect([open[0]!.source, open[0]!.affected.differences, open[0]!.events.length]).toEqual(['reconciliation', 1, 1])
      p.recordRecon(userId, { ok: true, breaks: [], repaired: ['A venue fill missing from the ledger was sent for booking.'] }, clock.now() + 60_000)
      const done = incidentsView(engine.db).recent[0]!
      expect([done.resolvedAt, done.affected.differences]).toEqual([clock.now() + 60_000, 0])
      expect(done.resolution).toMatch(/agree again; repaired/)
    } finally { engine.stop() }
  })

  it('readiness: a stale heartbeat is an incident when the API reads it, and a running engine closes it', async () => {
    const { engine, clock } = boot()
    try {
      await tick(engine)
      const last = engine.db.get<{ beat_at: number }>(`SELECT beat_at FROM heartbeats WHERE service = 'engine'`)!.beat_at
      const later = last + DOWN_AFTER_MS + 60_000
      const down = incidentsFor(engine.db, later)
      expect(down.open.map((i) => [i.key, i.source, i.openedAt])).toEqual([['engine-down', 'readiness', last]])
      expect(incidentsFor(engine.db, later + 1000).open).toHaveLength(1) // read again: still the one incident
      engine.db.run(`UPDATE heartbeats SET beat_at = ? WHERE service = 'engine'`, later + 2000)
      const back = incidentsFor(engine.db, later + 3000)
      expect(back.open).toEqual([])
      expect([back.recent[0]!.resolvedAt, back.recent[0]!.resolution]).toEqual([later + 3000, 'The engine is running again.'])
      void clock
    } finally { engine.stop() }
  })

  it('seeded failure: false when QED_SEED_FAIL=1', () => { expect(process.env.QED_SEED_FAIL === '1').toBe(false) })
})
