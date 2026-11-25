/**
 * One engine per database, and what happens to an action that was in flight when its engine died (ADR-0013).
 *
 * Until 24 Nov 2026 the engine refused to start beside another only when the other's heartbeat was fresh, its pid was
 * not this process's and that pid was alive. A second engine therefore started anyway when it had the same pid (every
 * container's first process is pid 1) or when the first one's heartbeat merely looked old (a stalled or suspended
 * process, a clock step): both cases fail on that code. The check and the heartbeat write were two steps, so two engines
 * starting together could in principle both pass; on that code the second was refused in each of three tries, so that
 * window is a hypothesis, and the test below holds the lock to its stronger answer ("locked", from the operating system).
 * A clean stop left the health check saying "running" for up to 20 s, and nothing stopped an engine that found another
 * engine's name in its heartbeat. Cross-process cases run real child processes (server/engine-fixture.ts) and kill them
 * with SIGKILL, so the operating system, not the test, decides what is released.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { FakeClock, openDb } from './core.ts'
import { DOWN_AFTER_MS, Engine, EngineLocked, engineLockPath, engineStatus } from './engine.ts'
import { getAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { balance, verifyLedger } from './ledger.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { T0 } from './testkit.ts'

const FIXTURE = join(import.meta.dirname, 'engine-fixture.ts')
const dirs: string[] = [], children: ChildProcess[] = [], engines: Engine[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  for (const e of engines.splice(0)) { try { e.stop() } catch { /* already stopped */ } }
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratchDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-engine-lock-'))
  dirs.push(d)
  return join(d, 'qed.db')
}
function engineOn(db: string, opts: { clock?: FakeClock; onFenced?: (why: string) => void } = {}): Engine {
  const e = new Engine({ dbPath: db }, { live: false, ...opts })
  engines.push(e)
  return e
}
/** Start the fixture in its own process; resolve with its first report ("ready …", "locked"). */
function fixture(db: string, mode: 'hold' | 'pay-unanswered'): Promise<{ proc: ChildProcess; line: string }> {
  const proc = spawn(process.execPath, [FIXTURE, db, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(proc)
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    const timer = setTimeout(() => reject(new Error(`the fixture did not report within 15 s: ${out} ${err}`)), 15_000)
    proc.stderr!.on('data', (b: Buffer) => { err += b.toString() })
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      const line = out.split('\n').find((l) => /^(ready|locked|error)/.test(l))
      if (line) { clearTimeout(timer); resolve({ proc, line }) }
    })
  })
}
const kill9 = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once('exit', () => r()); p.kill('SIGKILL') })
/** What the heartbeat row says, read on a connection of its own. */
function heartbeat(db: string): { pid: number; instance: string | undefined } {
  const d = new DatabaseSync(db)
  try {
    d.exec('PRAGMA busy_timeout = 5000')
    const r = d.prepare(`SELECT pid, detail_json FROM heartbeats WHERE service = 'engine'`).get() as { pid: number; detail_json: string }
    return { pid: r.pid, instance: (JSON.parse(r.detail_json) as { instance?: string }).instance }
  } finally { d.close() }
}
const n = (e: Engine, sql: string, ...p: (string | number)[]): number => e.db.get<{ n: number }>(sql, ...p)!.n

describe('one engine per database', () => {
  it('a second engine with the same pid is refused (every container\'s first process is pid 1), and writes nothing', () => {
    const db = scratchDb()
    const first = engineOn(db)
    first.start()
    const second = engineOn(db)
    expect(() => second.start()).toThrow(EngineLocked)
    second.stop() // a refused engine's stop must not touch the running engine's heartbeat
    expect(heartbeat(db).instance).toBe(first.instance)
    expect(engineStatus(first.db, Date.now()).running).toBe(true)
    // The lock file holds no data, so nothing scanning the data folder takes it for a copy of the database.
    expect(statSync(engineLockPath(db)).size).toBe(0)
  })

  it('a live engine in another process is not taken over when its heartbeat only looks old (a stalled process, a clock step)', async () => {
    const db = scratchDb()
    expect((await fixture(db, 'hold')).line).toBe('ready')
    // This engine's clock is past DOWN_AFTER_MS from the other's last beat: the heartbeat check alone let it start beside a live engine.
    const late = engineOn(db, { clock: new FakeClock(Date.now() + DOWN_AFTER_MS + 5_000) })
    expect(() => late.start()).toThrow(/Another engine holds this database's engine lock/)
    expect(n(late, 'SELECT COUNT(*) n FROM downtime')).toBe(0) // the refused start recorded no outage either
  })

  it('two engines started at the same moment: exactly one runs, the other is refused', async () => {
    const db = scratchDb()
    const [a, b] = await Promise.all([fixture(db, 'hold'), fixture(db, 'hold')])
    expect([a.line, b.line].sort()).toEqual(['locked', 'ready'])
  })

  it('a killed engine holds nothing: the operating system releases its lock and the next engine starts at once', async () => {
    const db = scratchDb()
    const { proc } = await fixture(db, 'hold')
    const killedPid = heartbeat(db).pid
    await kill9(proc)
    const next = engineOn(db)
    next.start() // the dead engine's heartbeat is still fresh, but its process and its lock are gone
    expect(heartbeat(db)).toEqual({ pid: process.pid, instance: next.instance })
    expect(killedPid).not.toBe(process.pid)
  })

  it('an engine that stops cleanly says so: health reports it down at once, and the next engine may start at once', () => {
    const db = scratchDb()
    const first = engineOn(db)
    first.start()
    const next = engineOn(db)
    expect(engineStatus(next.db, Date.now()).running).toBe(true)
    first.stop()
    expect(engineStatus(next.db, Date.now()).running).toBe(false) // before: "running" for up to 20 s after the stop
    next.start()
    expect(engineStatus(next.db, Date.now()).running).toBe(true)
  })

  it('an engine that finds another engine named in its heartbeat stops acting at once: no run is claimed, no heartbeat written', async () => {
    const db = scratchDb()
    const clock = new FakeClock(T0)
    const fenced: string[] = []
    const e = engineOn(db, { clock, onFenced: (why) => fenced.push(why) })
    // An instruction due every ten minutes, signed and active (as in engine.test.ts).
    const userId = 'usr_fence'
    e.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'fence', 'Owner', 'x', clock.now())
    openHousehold(e.db, userId, DEFAULT_OPENING, {}, clock.now())
    e.ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: '178.8713', sourceTs: T0 - 86_400_000, precision: 'day', recvTs: T0, provider: 'test' })
    const d = saveDraft(e.ctx, userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 10 } }, authority: { expiresAt: T0 + 30 * 86_400_000 } })
    const req = requestProgramApproval(e.ctx, userId, d.programId, ['schedule-over-limit'])
    confirmApproval(e.db, userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, clock.now())
    activateProgram(e.ctx, userId, d.programId, req.approvalId)
    e.start()
    await sleep(250) // the start's own first pass has finished (passes take milliseconds without live data)
    const runsBefore = n(e, 'SELECT COUNT(*) n FROM runs')

    // Another engine writes the heartbeat row, as one on a second host sharing the volume over a network would.
    const other = new DatabaseSync(db)
    other.exec('PRAGMA busy_timeout = 5000')
    other.prepare(`UPDATE heartbeats SET pid = ?, detail_json = json_set(detail_json, '$.instance', 'another-host') WHERE service = 'engine'`).run(424_242)
    other.close()

    clock.advance(11 * 60_000) // the next occurrence is now due
    await e.tick()
    for (let i = 0; i < 40 && fenced.length === 0; i++) await sleep(50) // or the engine's own next pass, within a second
    expect(fenced).toHaveLength(1)
    expect(n(e, 'SELECT COUNT(*) n FROM runs')).toBe(runsBefore) // nothing claimed by the engine that is no longer the one
    expect(n(e, `SELECT COUNT(*) n FROM events WHERE type = 'engine' AND payload_json LIKE '%"fenced"%'`)).toBe(1)
    await e.tick()
    clock.advance(5_000)
    await e.tick()
    expect(fenced).toHaveLength(1)
    expect(heartbeat(db).instance).toBe('another-host') // never overwritten
    // It let go of its lock: an engine may now be started here (the other "host" has no live pid on this QED installation).
    const next = engineOn(db, { clock })
    next.start()
    expect(heartbeat(db).instance).toBe(next.instance)
  })
})

describe('an action in flight when its engine is killed', () => {
  it('a payment the rail has not answered: the restarted engine neither sends it again nor gives up on it; the money returns once when the rail answers', async () => {
    const db = scratchDb()
    const { proc, line } = await fixture(db, 'pay-unanswered')
    const actionId = line.split(' ')[1]!
    expect(actionId).toMatch(/^act_/)
    await kill9(proc)

    const clock = new FakeClock(Date.now())
    const e = engineOn(db, { clock })
    e.start()
    for (let i = 0; i < 3; i++) { await e.tick(); await sleep(20) }
    const userId = 'usr_fixture'
    let a = getAction(e.db, actionId)!
    expect(a.state).toBe('working')
    expect(a.result.railState).toBe('unknown')
    expect(n(e, 'SELECT COUNT(*) n FROM pv_payments')).toBe(1) // not submitted again
    expect(balance(e.db, userId, 'clear:pay')).toBe(100_000n) // still reserved: not returned on a guess
    expect(balance(e.db, userId, 'bank')).toBe(BigInt(DEFAULT_OPENING.bank) - 100_000n)
    const receiptsBefore = n(e, 'SELECT COUNT(*) n FROM receipts WHERE user_id = ?', userId)

    clock.advance(130_000) // the rail answers: it did not go through
    for (let i = 0; i < 50 && getAction(e.db, actionId)!.state !== 'failed'; i++) { await e.tick(); await sleep(20) }
    a = getAction(e.db, actionId)!
    expect(a.state).toBe('failed')
    expect(n(e, `SELECT COUNT(*) n FROM entries WHERE user_id = ? AND kind = 'payment-returned'`, userId)).toBe(1)
    expect(balance(e.db, userId, 'bank')).toBe(BigInt(DEFAULT_OPENING.bank))
    expect(balance(e.db, userId, 'clear:pay')).toBe(0n)
    expect(n(e, 'SELECT COUNT(*) n FROM receipts WHERE user_id = ?', userId) - receiptsBefore).toBe(1) // one receipt, for the failure
    expect(verifyLedger(e.db, userId)).toEqual([])
    // A second look from a fresh connection agrees: one payment, one return, one receipt.
    const check = openDb(db)
    try { expect(check.get<{ n: number }>('SELECT COUNT(*) n FROM pv_payments WHERE client_ref = ?', 'unanswered')!.n).toBe(1) } finally { check.close() }
  })
})
