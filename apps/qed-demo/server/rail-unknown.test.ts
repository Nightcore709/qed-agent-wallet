/**
 * A request to the vault service that gets no answer (docs/PRODUCTION.md, section 7). Until 24 Nov 2026 every failure of
 * a request, a timeout included, was reported as "The on-chain vault service is not running" (503 rail_off), although a
 * POST that timed out may have been received and acted on; and the interface makes a new Idempotency-Key for each press,
 * so pressing again after that message could start the same work twice. Now: a connection refused is still "not
 * running" (nothing was sent), and so is a read without an answer; a POST that may have arrived is looked up by its key
 * (GET /workspaces/:id/submissions/:key, chain/rail/service.ts) and returned as accepted if the job exists, and otherwise
 * reported as of unknown outcome (504).
 * The stand-in service below accepts the POST, records its key and never answers it. Port 7441 only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AppError } from './core.ts'
import { must, rail } from './rail.ts'

const PORT = 7441
const TOKEN = 'test-token-for-the-stand-in-service-only'
let dir = ''
let server: Server | null = null
const posts: { path: string; key: string | undefined }[] = []
const lookups: string[] = []
/** Keys the stand-in has accepted, and the job each started. */
const accepted = new Map<string, string>()

function standIn(opts: { record: boolean }): Promise<void> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
      const key = req.headers['idempotency-key'] as string | undefined
      if (req.method === 'POST') {
        posts.push({ path: req.url ?? '', key })
        if (opts.record && key && !accepted.has(key)) accepted.set(key, `job_${accepted.size + 1}`) // one job per key, as the service keeps it
        return // received, perhaps acted on, never answered
      }
      const m = /^\/workspaces\/([^/]+)\/submissions\/([^/]+)$/.exec(req.url ?? '')
      if (m) {
        lookups.push(decodeURIComponent(m[2]!))
        const job = accepted.get(decodeURIComponent(m[2]!))
        if (job) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobId: job, kind: 'policy-run', status: 'running' })); return }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unknown_submission', message: 'No accepted submission is stored under this key.' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise((r) => server!.listen(PORT, '127.0.0.1', () => r()))
}
async function stop(): Promise<void> {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((r) => server!.close(() => r()))
  server = null
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qed-rail-unknown-'))
  writeFileSync(join(dir, 'rail.token'), TOKEN, { mode: 0o600 })
  process.env.QED_RAIL_URL = `http://127.0.0.1:${PORT}`
  process.env.QED_RAIL_TOKEN_FILE = join(dir, 'rail.token')
})
afterEach(async () => { await stop(); posts.length = 0; lookups.length = 0; accepted.clear() })
afterAll(() => { delete process.env.QED_RAIL_URL; delete process.env.QED_RAIL_TOKEN_FILE; rmSync(dir, { recursive: true, force: true }) })

const CFG = { dbPath: join(tmpdir(), 'unused', 'qed.db') }
const refusal = async (p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> => {
  try { await p } catch (e) { if (e instanceof AppError) return { status: e.status, code: e.code, message: e.message }; throw e }
  throw new Error('expected a refusal')
}

describe('a request the vault service does not answer', () => {
  it('a POST it received and started: found by its key and returned as accepted, sent once only', async () => {
    await standIn({ record: true })
    const r = await rail(CFG, 'POST', '/workspaces/ws_a/policy/run', {}, { 'Idempotency-Key': 'ui-press-1' }, 300)
    expect(r).toEqual({ status: 202, json: { jobId: 'job_1', kind: 'policy-run', status: 'running', duplicate: true, recovered: true } })
    expect(posts).toEqual([{ path: '/workspaces/ws_a/policy/run', key: 'ui-press-1' }])
    expect(lookups).toEqual(['ui-press-1'])
    // and through must(), as the routes call it
    expect(await must(CFG, 'POST', '/workspaces/ws_a/policy/run', {}, { 'Idempotency-Key': 'ui-press-1' }, 300)).toMatchObject({ jobId: 'job_1', recovered: true })
  })

  it('a POST with no record yet: reported as of unknown outcome (504), not as "not running"', async () => {
    await standIn({ record: false })
    const e = await refusal(rail(CFG, 'POST', '/workspaces/ws_a/liabilities/3/settle', {}, { 'Idempotency-Key': 'ui-press-2' }, 300))
    expect(e).toMatchObject({ status: 504, code: 'rail_outcome_unknown' })
    expect(e.message).toMatch(/may have received this request/)
    expect(e.message).not.toMatch(/not running/)
    expect(posts).toHaveLength(1) // nothing re-sent
  })

  it('a POST outside a workspace cannot be looked up: unknown outcome as well', async () => {
    await standIn({ record: true })
    expect(await refusal(rail(CFG, 'POST', '/workspaces', { workspaceId: 'x' }, { 'Idempotency-Key': 'create-1' }, 300))).toMatchObject({ status: 504, code: 'rail_outcome_unknown' })
  })

  it('nothing listening: "not running" (503), because nothing was sent', async () => {
    const e = await refusal(rail(CFG, 'POST', '/workspaces/ws_a/policy/run', {}, { 'Idempotency-Key': 'ui-press-3' }, 300))
    expect(e).toMatchObject({ status: 503, code: 'rail_off' })
  })

  it('a POST without a key cannot be looked up: unknown outcome; a read that times out stays "not running" (it changes nothing)', async () => {
    await standIn({ record: true })
    server!.removeAllListeners('request')
    server!.on('request', () => { /* never answers anything */ })
    expect(await refusal(rail(CFG, 'POST', '/workspaces/ws_a/links', {}, {}, 300))).toMatchObject({ status: 504, code: 'rail_outcome_unknown' })
    expect(await refusal(rail(CFG, 'GET', '/workspaces/ws_a/state', undefined, {}, 300))).toMatchObject({ status: 503, code: 'rail_off' })
  })
})
