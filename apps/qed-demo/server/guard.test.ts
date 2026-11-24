/**
 * The cost-aware throttle (lead L-14) and the refusal log and alert (ASVS 5.0 V16.3.2, V16.3.3), server/guard.ts. Over
 * HTTP: a person whose requests have used up their share of the API's thread is refused 429 too_costly with Retry-After
 * while another person is still served, and a refusal is one `refused` line in the operational log.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openDb } from './core.ts'
import { ALERT_THRESHOLD, CostMeter, costBudget, DEFAULT_COST_MS_PER_MINUTE, LOG_PER_KEY_MINUTE, RefusalMonitor } from './guard.ts'
import { incidentsView } from './incidents.ts'

const T0 = Date.UTC(2026, 10, 24, 6, 0)

describe('the cost-aware throttle', () => {
  it('serves a key until its share of the thread for the minute is spent, then says when to come back', () => {
    const m = new CostMeter(1000)
    m.charge('ip:a', T0, 600)
    expect(m.retryAfterMs('ip:a', T0 + 1)).toBe(0)
    m.charge('ip:a', T0 + 2, 500)
    expect(m.retryAfterMs('ip:a', T0 + 10_000)).toBe(50_000)
    // another key is untouched; the next minute starts afresh
    expect(m.retryAfterMs('ip:b', T0 + 10_000)).toBe(0)
    expect(m.retryAfterMs('ip:a', T0 + 60_000)).toBe(0)
  })

  it('takes its budget from the environment: lower anywhere, higher only on a test stack', () => {
    expect(costBudget({})).toBe(DEFAULT_COST_MS_PER_MINUTE)
    expect(costBudget({ QED_COST_MS_PER_MINUTE: '5000' })).toBe(5000)
    expect(costBudget({ QED_COST_MS_PER_MINUTE: '90000' })).toBe(DEFAULT_COST_MS_PER_MINUTE)
    expect(costBudget({ QED_COST_MS_PER_MINUTE: '90000', QED_TEST_STACK: '1' })).toBe(90000)
    expect(costBudget({ QED_COST_MS_PER_MINUTE: 'lots' })).toBe(DEFAULT_COST_MS_PER_MINUTE)
  })
})

describe('the refusal log and alert', () => {
  it('writes one line per refusal up to a limit per address and code, then says how many it left out', async () => {
    const log = await import('./log.ts')
    const spy = vi.spyOn(log, 'log')
    const m = new RefusalMonitor(openDb(':memory:'))
    for (let i = 0; i < LOG_PER_KEY_MINUTE + 5; i++) m.record(T0 + i, { status: 403, code: 'csrf', method: 'POST', path: '/api/stop', ip: '203.0.113.9' })
    m.record(T0 + 100, { status: 404, code: 'not_found', method: 'GET', path: '/api/nothing', ip: '203.0.113.9' })
    expect(spy.mock.calls.filter((c) => c[2] === 'refused')).toHaveLength(LOG_PER_KEY_MINUTE)
    m.record(T0 + 61_000, { status: 403, code: 'csrf', method: 'POST', path: '/api/stop', ip: '203.0.113.9' })
    expect(spy.mock.calls.find((c) => c[2] === 'refused (more, not written)')?.[3]).toMatchObject({ notWritten: 5 })
    spy.mockRestore()
  })

  it('opens an incident when refusals pass the threshold, and resolves it after a quiet window', () => {
    const db = openDb(':memory:')
    const m = new RefusalMonitor(db, 10, 60_000)
    for (let i = 0; i < 10; i++) m.record(T0 + i, { status: 401, code: 'bad_credentials', method: 'POST', path: '/api/auth/login', ip: `198.51.100.${i}` })
    expect(incidentsView(db).open.map((i) => i.key)).toEqual(['security-refusals'])
    m.tick(T0 + 61_000)
    m.tick(T0 + 122_000)
    expect(incidentsView(db).open).toEqual([])
    expect(ALERT_THRESHOLD).toBeGreaterThan(10)
  })
})

describe('over HTTP', () => {
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const dir = mkdtempSync(join(tmpdir(), 'qed-guard-'))
  let api: { close(): void }
  beforeAll(async () => {
    // a small budget, and the request count lifted (a test stack), so that the cost limit is the one met first
    process.env.QED_COST_MS_PER_MINUTE = '1000'
    process.env.QED_TEST_STACK = '1'
    const { startApi } = await import('./api.ts')
    const { loadConfig } = await import('./core.ts')
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_PRESENTATION: '1', QED_TRUST_PROXY_HOPS: '1', QED_TEST_STACK: '1', QED_REQUESTS_PER_MINUTE: '100000' }))
  })
  afterAll(() => { delete process.env.QED_COST_MS_PER_MINUTE; delete process.env.QED_TEST_STACK; api.close(); rmSync(dir, { recursive: true, force: true }) })

  async function person(handle: string, ip: string) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-forwarded-for': ip }, body: JSON.stringify({ handle, password: 'a long enough pass phrase', displayName: handle }) })
    expect(r.status).toBe(200)
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!
    return (path: string) => fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie, 'x-forwarded-for': ip, 'accept-encoding': 'br' } })
  }

  it('refuses a person whose requests have held the thread past their budget, and serves another person meanwhile', async () => {
    const heavy = await person('costly', '203.0.113.50')
    let refused: Response | null = null
    for (let i = 0; i < 20_000 && !refused; i++) { const r = await heavy('/api/legal'); if (r.status === 429) refused = r; else await r.arrayBuffer() }
    expect(refused?.status).toBe(429)
    expect(((await refused!.json()) as { error: { code: string } }).error.code).toBe('too_costly')
    expect(Number(refused!.headers.get('retry-after'))).toBeGreaterThan(0)
    const other = await person('patient', '198.51.100.7')
    expect((await other('/api/legal')).status).toBe(200)
  })
})
