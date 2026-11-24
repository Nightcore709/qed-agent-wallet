/**
 * Graceful shutdown (docs/DEPLOY.md, "Graceful shutdown"): what SIGTERM does to the engine and the API when a platform
 * stops or replaces the container. The engine starts no new pass, ends the pass under way at its next step boundary
 * (or abandons it safely when the grace runs out), writes its last heartbeat, lets go of its lock and closes the
 * database. The API stops accepting connections, ends the live event streams, lets requests under way finish (or cuts
 * them off when the grace runs out) and closes the database. The last part runs the real entry point in child processes
 * and sends the signal itself. Ports 10293 to 10296 only; presentation mode, so no market data provider is contacted.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { type ClientRequest, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type Api, startApi } from './api.ts'
import { APP_ROOT, loadConfig } from './core.ts'
import { Engine } from './engine.ts'
import { SoftAuthenticator } from './softauthn.ts'

const dirs: string[] = [], apis: Api[] = [], children: ChildProcess[] = [], engines: Engine[] = []
afterEach(() => {
  for (const e of engines.splice(0)) { try { e.stop() } catch { /* stopped */ } }
  for (const a of apis.splice(0)) { try { a.close() } catch { /* closed */ } }
  for (const c of children.splice(0)) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), 'qed-shutdown-')); dirs.push(d); return d }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const heartbeat = (dbPath: string): Record<string, unknown> => {
  const d = new DatabaseSync(dbPath, { readOnly: true })
  try { return JSON.parse((d.prepare(`SELECT detail_json FROM heartbeats WHERE service = 'engine'`).get() as { detail_json: string }).detail_json) as Record<string, unknown> } finally { d.close() }
}

describe('the engine stops gracefully', () => {
  it('a pass under way ends at its next step boundary: nothing after it runs, the last heartbeat says stopped, the lock is free', async () => {
    const dbPath = join(scratch(), 'qed.db')
    const engine = new Engine({ dbPath }, { live: false })
    engines.push(engine)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let cryptoCalls = 0, railCalls = 0
    engine.ctx.venues.crypto.tick = async () => { cryptoCalls++; await gate }
    engine.ctx.venues.rail.tick = async () => { railCalls++ }
    engine.start()
    for (let i = 0; i < 100 && cryptoCalls === 0; i++) await sleep(10)
    expect(cryptoCalls).toBe(1) // the first pass is waiting inside a step
    const stopping = engine.stopGracefully(5_000)
    await sleep(150)
    let done = false
    void stopping.then(() => { done = true })
    expect(done).toBe(false) // it waits for the step under way
    release()
    const r = await stopping
    expect(r.abandoned).toBe(false)
    expect(r.waitedMs).toBeLessThan(5_000)
    expect(railCalls).toBe(0) // the pass stopped at the boundary after the step; the next step never started
    expect(heartbeat(dbPath).stopped).toBe(true)
    const next = new Engine({ dbPath }, { live: false })
    engines.push(next)
    expect(() => next.start()).not.toThrow() // the lock was released and the stop was recorded
  })

  it('a step that does not finish within the grace is abandoned: the engine still closes and a successor can start', async () => {
    const dbPath = join(scratch(), 'qed.db')
    const engine = new Engine({ dbPath }, { live: false })
    engines.push(engine)
    let entered = false
    engine.ctx.venues.crypto.tick = () => { entered = true; return new Promise<void>(() => { /* never answers */ }) }
    engine.start()
    for (let i = 0; i < 100 && !entered; i++) await sleep(10)
    const r = await engine.stopGracefully(300)
    expect(r.abandoned).toBe(true)
    expect(r.waitedMs).toBeGreaterThanOrEqual(300)
    expect(heartbeat(dbPath).stopped).toBe(true)
    const next = new Engine({ dbPath }, { live: false })
    engines.push(next)
    expect(() => next.start()).not.toThrow()
  })
})

/** A POST whose body arrives in two parts: the handler is under way (reading it) until `finish` is called. */
function slowPost(port: number, path: string): { finish(): void; answer: Promise<number> } {
  const body = '{"x":"0123456789ab"}' // 20 bytes
  let req!: ClientRequest
  const answer = new Promise<number>((resolve) => {
    req = request({ host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': '20', 'x-qed-client': 'web' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', () => resolve(0)) // cut off
    req.write(body.slice(0, 5))
  })
  return { finish: () => req.end(body.slice(5)), answer }
}
const live = (port: number): Promise<number> => new Promise((resolve) => {
  // a connection of its own (agent: false): a pooled one from an earlier request would be reused and found closed
  const r = request({ host: '127.0.0.1', port, path: '/api/live', agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
  r.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' ? -1 : 0))
  r.end()
})

describe('the API drains gracefully', () => {
  const api = (port: number, extra: Record<string, string> = {}): Api => {
    const d = scratch()
    const a = startApi(loadConfig({ QED_DB: join(d, 'qed.db'), QED_API_PORT: String(port), QED_AI_PROVIDER: 'none', QED_RAIL_TOKEN_FILE: join(d, 'none'), ...extra }))
    apis.push(a)
    return a
  }

  it('lets a request under way finish, then refuses new connections and closes the database', async () => {
    const a = api(10293)
    await sleep(50)
    const req = slowPost(10293, '/api/auth/passkey/login/begin')
    await sleep(150)
    let drained = false
    const draining = a.drain(5_000).then((r) => { drained = true; return r })
    await sleep(200)
    expect(drained).toBe(false) // waiting for the request under way
    req.finish()
    expect(await req.answer).toBe(200) // it was answered, not cut off
    const r = await draining
    expect(r).toMatchObject({ abandoned: 0 })
    expect(r.waitedMs).toBeLessThan(5_000)
    expect(await live(10293)).toBe(-1) // no new connection is accepted
    expect(() => a.ctx.db.get('SELECT 1')).toThrow() // the database is closed
  })

  it('cuts off a request that does not finish within the grace, and says how many', async () => {
    const a = api(10294)
    await sleep(50)
    const req = slowPost(10294, '/api/auth/passkey/login/begin')
    await sleep(150)
    const r = await a.drain(300)
    expect(r.abandoned).toBe(1)
    expect(r.waitedMs).toBeGreaterThanOrEqual(300)
    expect(await req.answer).toBe(0) // the connection was closed
  })

  it('ends the live event streams at once (the page reconnects to the next process)', async () => {
    const PORT = 10295
    const a = api(PORT, { QED_WEB_PORT: String(PORT) })
    await sleep(50)
    const call = (method: string, path: string, o: { cookie?: string; body?: unknown } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, any> }> => new Promise((resolve, reject) => {
      const body = o.body === undefined ? undefined : JSON.stringify(o.body)
      const headers: Record<string, string> = { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, 'x-qed-client': 'web' }
      if (o.cookie) headers.cookie = o.cookie
      if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)) }
      const r = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => { let t = ''; res.on('data', (c: Buffer) => { t += c.toString() }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: t ? JSON.parse(t) as Record<string, any> : {} })) })
      r.on('error', reject)
      if (body) r.write(body)
      r.end()
    })
    const auth = new SoftAuthenticator({ origin: `http://localhost:${PORT}` })
    const b = await call('POST', '/api/auth/passkey/signup/begin', { body: { handle: 'drainer', displayName: 'Drainer' } })
    const f = await call('POST', '/api/auth/passkey/signup/finish', { body: { challengeId: b.json.challengeId, response: auth.create(b.json.options) } })
    expect(f.status).toBe(200)
    const cookie = String(([] as string[]).concat(f.headers['set-cookie'] ?? [])[0]).split(';')[0]!
    const ended = new Promise<string>((resolve) => {
      const r = request({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { host: `localhost:${PORT}`, cookie } }, (res) => {
        let first = ''
        res.on('data', (c: Buffer) => { first ||= c.toString().split('\n')[0]! })
        res.on('end', () => resolve(first))
        res.on('error', () => resolve(first))
      })
      r.on('error', () => resolve('error'))
      r.end()
    })
    await sleep(300)
    const t0 = performance.now()
    const r = await a.drain(5_000)
    expect(r.abandoned).toBe(0)
    expect(performance.now() - t0).toBeLessThan(1_500)
    expect(await ended).toBe('event: hello') // it was open, and it was ended
  })
})

describe('SIGTERM to the real processes', () => {
  it('the API and the engine each stop gracefully, exit 0, and leave the database closed (no write-ahead log left)', async () => {
    const PORT = 10296
    const dir = scratch()
    const dbPath = join(dir, 'qed.db')
    const env = { ...process.env, QED_DB: dbPath, QED_API_PORT: String(PORT), QED_AI_PROVIDER: 'none', QED_PRESENTATION: '1', QED_RAIL_TOKEN_FILE: join(dir, 'none'), QED_STOP_GRACE_MS: '5000', QED_LOG_FORMAT: 'json' }
    const run = (cmd: string): { child: ChildProcess; out: () => string; exit: Promise<number | null> } => {
      const child = spawn(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), cmd], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let out = ''
      child.stdout!.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr!.on('data', (d: Buffer) => { out += d.toString() })
      return { child, out: () => out, exit: new Promise((r) => child.on('exit', (code) => r(code))) }
    }
    const engine = run('engine')
    for (let i = 0; i < 200 && !engine.out().includes('"event":"running"'); i++) await sleep(50)
    const api = run('api')
    let ready = 0
    for (let i = 0; i < 200 && ready !== 200; i++) {
      ready = await new Promise<number>((resolve) => { const r = request({ host: '127.0.0.1', port: PORT, path: '/api/ready', headers: { host: `127.0.0.1:${PORT}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) }); r.on('error', () => resolve(0)); r.end() })
      if (ready !== 200) await sleep(100)
    }
    expect(ready).toBe(200)
    api.child.kill('SIGTERM')
    expect(await api.exit).toBe(0)
    const apiStop = api.out().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'stopped')
    expect(apiStop).toMatchObject({ svc: 'api', level: 'info', abandonedRequests: 0 })
    engine.child.kill('SIGTERM')
    expect(await engine.exit).toBe(0)
    const engineStop = engine.out().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'stopped')
    expect(engineStop).toMatchObject({ svc: 'engine', level: 'info', abandonedStep: false })
    // every connection closed: the log was checkpointed and removed (checked before this test opens the file itself)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(heartbeat(dbPath).stopped).toBe(true)
  }, 60_000)
})
