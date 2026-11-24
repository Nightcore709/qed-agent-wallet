/**
 * Liveness and readiness (server/probes.ts; docs/DEPLOY.md, "Health and readiness"), through the API itself: what a
 * platform's deploy gate and an outside monitor see. Readiness needs the database, this build's schema, a fresh engine
 * heartbeat and an API that is not draining; the wallet service is reported and gates only when asked. Under a public
 * origin a platform's health-check host reaches the probes and nothing else, and the answers carry no detail.
 * Ports 10291 and 10292 only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, startApi } from './api.ts'
import { loadConfig, openDb, SCHEMA_VERSION } from './core.ts'
import { Engine } from './engine.ts'
import { publicReport, readinessReport } from './probes.ts'

interface Answer { status: number; json: Record<string, any> }
function get(port: number, path: string, host: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host } }, (res) => {
      let text = ''
      res.on('data', (c: Buffer) => { text += c.toString() })
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text) } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }) })
    })
    r.on('error', reject)
    r.end()
  })
}
const names = (a: Answer): Record<string, boolean> => Object.fromEntries((a.json.checks as { name: string; ok: boolean }[]).map((c) => [c.name, c.ok]))

describe('readinessReport', () => {
  it('is ready only when every gating check passes; the wallet service gates only when asked', () => {
    const db = openDb(':memory:')
    try {
      const now = Date.now()
      const none = readinessReport({ db, now, draining: false, wallet: 'not configured', requireWallet: false })
      expect(none.ready).toBe(false) // no engine has run
      expect(none.checks.find((c) => c.name === 'engine')).toMatchObject({ ok: false, detail: 'no engine has run on this database' })
      db.run(`INSERT INTO heartbeats (service, pid, started_at, beat_at, detail_json) VALUES ('engine', 1, ?, ?, '{}')`, now, now)
      expect(readinessReport({ db, now, draining: false, wallet: 'down', requireWallet: false }).ready).toBe(true)
      expect(readinessReport({ db, now, draining: false, wallet: 'down', requireWallet: true }).ready).toBe(false)
      expect(readinessReport({ db, now, draining: true, wallet: 'up', requireWallet: true }).ready).toBe(false)
      expect(readinessReport({ db, now: now + 25_000, draining: false, wallet: 'up', requireWallet: false }).ready).toBe(false) // heartbeat too old
      db.run(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, String(Number(SCHEMA_VERSION) + 1))
      const other = readinessReport({ db, now, draining: false, wallet: 'up', requireWallet: false })
      expect(other.ready).toBe(false)
      expect(other.checks.find((c) => c.name === 'schema')!.detail).toContain(`this build is at ${SCHEMA_VERSION}`)
      expect(publicReport(other)).toEqual({ ready: false, checks: { database: true, schema: false, engine: true, accepting: true, wallet: true } })
    } finally { db.close() }
  })

  it('reports a closed database as a failed check, never by throwing', () => {
    const db = openDb(':memory:')
    db.close()
    const r = readinessReport({ db, now: Date.now(), draining: false, wallet: 'up', requireWallet: false })
    expect(r.ready).toBe(false)
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([['database', false], ['schema', false], ['engine', false], ['accepting', true], ['wallet', true]])
  })
})

describe('the probes of a local API', () => {
  const PORT = 10291, HOST = `127.0.0.1:${PORT}`
  let dir = '', dbPath = '', api: Api
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qed-probes-'))
    dbPath = join(dir, 'qed.db')
    api = startApi(loadConfig({ QED_DB: dbPath, QED_API_PORT: String(PORT), QED_AI_PROVIDER: 'none', QED_RAIL_TOKEN_FILE: join(dir, 'none') }))
  })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })

  it('live answers at once; ready waits for the engine, then names each check', async () => {
    expect(await get(PORT, '/api/live', HOST)).toMatchObject({ status: 200, json: { live: true } })
    const before = await get(PORT, '/api/ready', HOST)
    expect(before.status).toBe(503)
    expect(names(before)).toEqual({ database: true, schema: true, engine: false, accepting: true, wallet: false })
    expect(before.json.checks.find((c: { name: string }) => c.name === 'wallet')).toMatchObject({ gating: false, detail: 'no wallet service is configured' })
    const engine = new Engine({ dbPath }, { live: false })
    engine.start()
    try {
      const after = await get(PORT, '/api/ready', HOST)
      expect(after.status).toBe(200)
      expect(after.json.ready).toBe(true)
      expect(after.json.checks.find((c: { name: string }) => c.name === 'engine').detail).toMatch(/^heartbeat \d+ s old$/)
    } finally { await engine.stopGracefully(2_000) }
    // a clean stop says so in its last beat: not ready at once, not 20 s later
    expect(names(await get(PORT, '/api/ready', HOST)).engine).toBe(false)
  })

  it('is not ready when another build has moved the database to another schema', async () => {
    const engine = new Engine({ dbPath }, { live: false })
    engine.start()
    const raw = new DatabaseSync(dbPath)
    try {
      raw.exec('PRAGMA busy_timeout = 5000')
      raw.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(Number(SCHEMA_VERSION) + 1))
      const r = await get(PORT, '/api/ready', HOST)
      expect(r.status).toBe(503)
      expect(names(r).schema).toBe(false)
    } finally {
      raw.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(SCHEMA_VERSION)
      raw.close()
      await engine.stopGracefully(2_000)
    }
  })

  it('keeps the health answer the scripts read: the engine\'s status and the open interfaces', async () => {
    const h = await get(PORT, '/api/health', HOST)
    expect(Object.keys(h.json).sort()).toEqual(['engine', 'interfaces', 'now', 'ok'])
    expect(Object.keys(h.json.engine)).toContain('pid')
  })
})

describe('the probes under a public origin, behind a platform\'s health check', () => {
  const PORT = 10292, ORIGIN = 'https://wallet.example.in', PROBE = 'healthcheck.railway.app'
  let dir = '', dbPath = '', api: Api
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qed-probes-public-'))
    dbPath = join(dir, 'qed.db')
    api = startApi(loadConfig({ QED_DB: dbPath, QED_API_PORT: String(PORT), QED_PUBLIC_ORIGIN: ORIGIN, QED_EXTRA_HOSTS: PROBE, QED_AI_PROVIDER: 'none', QED_RAIL_TOKEN_FILE: join(dir, 'none') }))
  })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })

  it('the health-check host reaches the probes, with check names and results only', async () => {
    const engine = new Engine({ dbPath }, { live: false })
    engine.start()
    try {
      const r = await get(PORT, '/api/ready', PROBE)
      expect(r).toEqual({ status: 200, json: { ready: true, checks: { database: true, schema: true, engine: true, accepting: true, wallet: false } } })
      expect((await get(PORT, '/api/live', PROBE)).status).toBe(200)
      const h = await get(PORT, '/api/health', PROBE)
      expect(h.json.engine).toEqual({ running: true }) // no pid, start time, ticks or open interfaces for a stranger
      expect(h.json.interfaces).toBeUndefined()
    } finally { await engine.stopGracefully(2_000) }
  })

  it('the health-check host reaches nothing else: no page, no session, no sign-in', async () => {
    for (const path of ['/', '/api/session', '/api/readiness', '/api/auth/passkey/login/begin']) expect((await get(PORT, path, PROBE)).status, path).toBe(421)
    expect((await get(PORT, '/api/session', 'wallet.example.in')).status).toBe(200) // the public host does (a signed-out session view)
    expect((await get(PORT, '/api/ready', 'evil.example')).status).toBe(421) // any other name does not
  })
})
