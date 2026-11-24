/**
 * Storage failures (R13, RE2): a full disk (SQLITE_FULL, by a small max_page_count) and an I/O error on write.
 *
 *   engine   stops acting at once, writes nothing half-way, says so (an incident, a notice with the missed runs), and
 *            carries on by itself when space returns
 *   API      refuses what it cannot save with 507 and a plain message, changes nothing, shows the fault, and recovers
 *
 * QED_SEED_FAIL=1 makes the last test fail on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmApproval } from './approvals.ts'
import { FakeClock, loadConfig } from './core.ts'
import { Engine } from './engine.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { heldCount, incidentsView, probeStorage, storageErrorKind } from './incidents.ts'
import { verifyLedger } from './ledger.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { T0 } from './testkit.ts'
import { startApi } from './api.ts'
import type { Db } from './core.ts'

/** Leaves the database no room: its size is capped where it is, and its free pages are used up. */
function fillDisk(db: Db): void {
  db.exec(`PRAGMA max_page_count = ${db.get<{ page_count: number }>('PRAGMA page_count')!.page_count}`)
  // large rows first, then smaller and smaller ones, until not even a tiny row fits: no write that needs a byte can succeed
  let n = 0
  for (const size of [2000, 200, 20, 1]) {
    for (;;) {
      try { db.run('INSERT INTO meta (key, value) VALUES (?, hex(zeroblob(?)))', `filler${n++}`, size) } catch (e) { if (storageErrorKind(e) !== 'full') throw e; break }
    }
  }
}
const space = (db: Db): void => { db.exec('PRAGMA max_page_count = 1000000'); db.run(`DELETE FROM meta WHERE key LIKE 'filler%'`) }
/** One whole pass: waits for the pass the engine started on its own first (a pass never overlaps with itself). */
const tick = async (e: Engine): Promise<void> => { while ((e as unknown as { busy: boolean }).busy) await new Promise((r) => setTimeout(r, 5)); await e.tick(); while ((e as unknown as { busy: boolean }).busy) await new Promise((r) => setTimeout(r, 5)) }
const dump = (db: Db): unknown => ({
  entries: db.get('SELECT COUNT(*) n FROM entries'), postings: db.get('SELECT COUNT(*) n FROM postings'),
  actions: db.all('SELECT id, state FROM actions ORDER BY id'), runs: db.all('SELECT id, state FROM runs ORDER BY id'),
})

describe('the engine on a full disk', () => {
  it('stops acting, leaves the books whole, says so with the missed runs, and resumes by itself when space returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-full-'))
    const clock = new FakeClock(T0)
    const engine = new Engine({ dbPath: join(dir, 'qed.db') }, { clock, live: false })
    try {
      engine.start()
      const db = engine.db, userId = 'usr_full'
      db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'owner', 'Owner', 'x', clock.now())
      openHousehold(db, userId, DEFAULT_OPENING, {}, clock.now())
      engine.ctx.market.update({ instrumentId: 'amfi:120716', type: 'nav', price: '178.8713', sourceTs: T0 - 86_400_000, precision: 'day', recvTs: T0, provider: 'test' })
      const d = saveDraft(engine.ctx, userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 10 } }, authority: { expiresAt: T0 + 30 * 86_400_000 } })
      const req = requestProgramApproval(engine.ctx, userId, d.programId, ['schedule-over-limit'])
      confirmApproval(db, userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, clock.now())
      activateProgram(engine.ctx, userId, d.programId, req.approvalId)
      await tick(engine)
      expect(incidentsView(db).open).toEqual([])
      const booksBefore = verifyLedger(db, userId)
      expect(booksBefore).toEqual([])

      // the disk fills; the instruction falls due while it is full
      fillDisk(db)
      const gapStart = clock.now()
      // Small writes still fit in pages that have room, so passes go on until one needs a new page. The disk is full from here.
      for (let n = 0; n < 400 && !incidentsView(db).open.some((i) => i.key === 'engine-storage'); n++) { clock.advance(11 * 60_000); await tick(engine) }
      const fault = incidentsView(db).open.find((i) => i.key === 'engine-storage')
      expect(fault, 'the fault is an open incident').toBeTruthy()
      expect(fault!.title).toMatch(/disk is full/)
      expect(fault!.openedAt).toBeGreaterThanOrEqual(gapStart)
      // nothing financial was half-written: the books verify and the receipts chain is intact
      expect(verifyLedger(db, userId)).toEqual([])
      expect(verifyChain(db, userId).ok).toBe(true)
      // while the fault lasts the engine acts on nothing: no run, action, entry or posting is added
      const frozen = dump(db)
      for (let s = 0; s < 3; s++) { clock.advance(11 * 60_000); await tick(engine) }
      expect(dump(db)).toEqual(frozen)

      // still full: still stopped, and the engine did not crash on its own heartbeat
      clock.advance(6000); await tick(engine)
      expect(incidentsView(db).open.some((i) => i.key === 'engine-storage')).toBe(true)

      // space returns: the next probe succeeds, the engine acts again, the gap is recorded, the incident is closed
      space(db)
      expect(probeStorage(db)).toBeNull()
      clock.advance(6000); await tick(engine)
      const v = incidentsView(db)
      expect(v.open.filter((i) => i.key === 'engine-storage')).toEqual([])
      const done = v.recent.find((i) => i.key === 'engine-storage')!
      expect(done.resolvedAt).toBeGreaterThan(done.openedAt)
      expect(done.resolution).toMatch(/marked missed and will not be run late/)
      expect(done.affected.missedRuns).toBeGreaterThanOrEqual(1)
      expect(done.events.map((e) => e.event)).toEqual(['opened', 'resolved'])
      expect(heldCount(db)).toBe(0)
      const gap = db.get<{ missed_runs: number; note: string }>(`SELECT missed_runs, note FROM downtime WHERE note LIKE '%could not write%'`)!
      expect(gap.note).toMatch(/could not write to its database/)
      expect(db.get<{ title: string }>(`SELECT title FROM notices WHERE kind = 'engine-was-down' AND resolved_at IS NULL`)!.title).toMatch(/QED was not running/)
      // and it goes on: a later pass writes its heartbeat
      const beat = db.get<{ beat_at: number }>(`SELECT beat_at FROM heartbeats WHERE service = 'engine'`)!.beat_at
      clock.advance(5000); await tick(engine)
      expect(db.get<{ beat_at: number }>(`SELECT beat_at FROM heartbeats WHERE service = 'engine'`)!.beat_at).toBeGreaterThan(beat)
      expect(verifyLedger(db, userId)).toEqual([])
    } finally { engine.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('an I/O error on write (a failure that is not "full") is handled the same way', async () => {
    const clock = new FakeClock(T0)
    const engine = new Engine({ dbPath: ':memory:' }, { clock, live: false })
    try {
      engine.start()
      const real = engine.db.run.bind(engine.db)
      let broken = true
      // every write statement now fails with SQLITE_IOERR_WRITE (10 | 3<<8), as a failing disk would
      engine.db.run = (sql: string, ...params: Parameters<typeof real> extends [string, ...infer P] ? P : never) => {
        if (broken && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 | (3 << 8), errstr: 'disk I/O error' })
        return real(sql, ...params)
      }
      clock.advance(1000); await tick(engine)
      const fault = incidentsView(engine.db).open.find((i) => i.key === 'engine-storage')
      expect(fault?.title).toMatch(/disk reported an error/)
      broken = false
      clock.advance(6000); await tick(engine)
      expect(incidentsView(engine.db).open.filter((i) => i.key === 'engine-storage')).toEqual([])
      expect(incidentsView(engine.db).recent.some((i) => i.key === 'engine-storage' && i.resolution?.includes('acting again'))).toBe(true)
    } finally { engine.stop() }
  })
})

describe('the API on a full disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-api-full-'))
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  let cookie = '', csrf = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }

  it('refuses what it cannot save with 507 and a plain message, changes nothing, shows the fault, recovers once there is room', async () => {
    expect((await call('POST', '/api/auth/signup', { handle: 'fulldisk', password: 'a long enough pass phrase', displayName: 'Full Disk' })).status).toBe(200)
    expect((await call('POST', '/api/household', {})).status).toBe(200)
    const db = api.ctx.db
    const userId = db.get<{ id: string }>(`SELECT id FROM users WHERE handle = 'fulldisk'`)!.id
    fillDisk(db)

    // Small writes still fit in pages that have room, so sign-ups (a user, a session, recovery codes) go on until one needs a new page
    let r = { status: 200, json: {} as Record<string, any> }, handle = ''
    for (let n = 0; n < 300 && r.status === 200; n++) { handle = `nospace${n}`; r = await call('POST', '/api/auth/signup', { handle, password: 'a long enough pass phrase', displayName: 'No Space' }) }
    const refused = handle
    expect([r.status, r.json.error?.code]).toEqual([507, 'storage_full'])
    expect(r.json.error.message).toMatch(/disk it keeps its records on is full/)
    expect(r.json.error.message).toMatch(/Nothing was changed/)
    expect(db.get('SELECT 1 FROM users WHERE handle = ?', refused), 'no half-made account').toBeUndefined()
    expect(verifyLedger(db, userId)).toEqual([])

    // reads still work, and say so
    const inc = await call('GET', '/api/incidents')
    expect(inc.status).toBe(200)
    expect(inc.json.open.map((i: { key: string }) => i.key)).toContain('api-storage')
    expect(inc.json.open.find((i: { key: string }) => i.key === 'api-storage').affected.failedRequests).toBeGreaterThanOrEqual(1)
    expect(heldCount(db) + db.all('SELECT 1 FROM incidents').length).toBeGreaterThan(0)

    // space returns
    space(db)
    await new Promise((res) => setTimeout(res, 5200)) // one probe at most every 5 s
    const after = await call('GET', '/api/incidents')
    expect(after.json.open.filter((i: { key: string }) => i.key === 'api-storage')).toEqual([])
    const done = after.json.recent.find((i: { key: string }) => i.key === 'api-storage')
    expect(done.resolution).toMatch(/write succeeded again/)
    expect(done.resolvedAt).toBeGreaterThanOrEqual(done.openedAt)
    expect((await call('POST', '/api/auth/signup', { handle: 'afterspace', password: 'a long enough pass phrase', displayName: 'No Space' })).status).toBe(200)
  }, 30_000)

  it('seeded failure: false when QED_SEED_FAIL=1', () => { expect(process.env.QED_SEED_FAIL === '1').toBe(false) })
})
