/**
 * The watchlist over HTTP against the real API server (R14, Grow): session and CSRF are required, a viewer reads and cannot
 * change, another household neither sees nor changes it, a duplicate changes nothing, every change is audited, a rupee
 * household and a dollar household may both keep one, and the routes' least roles are the ones the permission table states.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'
import { routeTable, startApi } from './api.ts'
import { loadConfig } from './core.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)

describe('the watchlist over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-watchlist-api-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_AI_PROVIDER: 'none', QED_TEST_STACK: '1', QED_REQUESTS_PER_MINUTE: '1000000' })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown, csrfOverride?: string) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', ...((csrfOverride ?? csrf) ? { 'x-qed-csrf': csrfOverride ?? csrf } : {}) } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown): Promise<J> => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }

  it('is signed-in, CSRF-protected, per household, role-limited and audited', async () => {
    const ka = authenticatorFor(PORT), kb = authenticatorFor(PORT), kv = authenticatorFor(PORT)
    const a = client(), b = client(), v = client()
    expect((await client().call('GET', '/api/watchlist')).status).toBe(401)
    await signUp(a.ok, ka, 'watch-a', 'Watcher A')
    await signUp(b.ok, kb, 'watch-b', 'Watcher B')
    await signUp(v.ok, kv, 'watch-v', 'Viewer V')
    // before the household is set up there is nothing to watch with
    expect((await a.call('GET', '/api/watchlist')).json.error?.code).toBe('not_set_up')
    await a.ok('POST', '/api/household', {})
    await b.ok('POST', '/api/household', { profile: { homeCurrency: 'USD' } })

    // a change without the CSRF token is refused and writes nothing
    expect((await a.call('POST', '/api/watchlist', { instrumentId: 'coindcx:BTCINR' }, 'wrong')).status).toBe(403)
    expect((await a.ok('GET', '/api/watchlist')).count).toBe(0)

    const added = await a.ok('POST', '/api/watchlist', { instrumentId: 'coindcx:BTCINR' })
    expect(added).toMatchObject({ added: true, count: 1, item: { instrumentId: 'coindcx:BTCINR', tradable: true } })
    expect(added.item.provider).toBeTruthy()
    expect(await a.ok('POST', '/api/watchlist', { instrumentId: 'coindcx:BTCINR' })).toMatchObject({ added: false, count: 1 })
    expect((await a.call('POST', '/api/watchlist', { instrumentId: 'nse:NOSUCH' })).status).toBe(404)
    expect((await a.call('POST', '/api/watchlist', {})).status).toBe(404)
    await a.ok('POST', '/api/watchlist', { instrumentId: 'amfi:120716' })
    expect((await a.ok('GET', '/api/watchlist')).items.map((i: J) => i.instrumentId).sort()).toEqual(['amfi:120716', 'coindcx:BTCINR'])

    // another household: nothing of A's, and cannot remove it; a dollar household keeps its own list
    expect((await b.ok('GET', '/api/watchlist')).items).toEqual([])
    expect(await b.ok('POST', '/api/watchlist/remove', { instrumentId: 'coindcx:BTCINR' })).toEqual({ removed: false })
    expect((await a.ok('GET', '/api/watchlist')).count).toBe(2)
    expect((await b.ok('POST', '/api/watchlist', { instrumentId: 'amfi:120716' })).added).toBe(true)
    expect((await b.ok('GET', '/api/session')).homeCurrency).toBe('USD')

    // a viewer of A's workspace reads it and cannot change it
    await stepUp(a.ok, ka)
    const ws = await a.ok('POST', '/api/workspaces', { name: 'Shared watching' })
    await stepUp(a.ok, ka)
    await a.ok('POST', '/api/workspace/members', { handle: 'watch-v', role: 'viewer' })
    await a.ok('POST', '/api/household', {})
    await a.ok('POST', '/api/watchlist', { instrumentId: 'xchg:TCS' })
    await v.ok('POST', `/api/workspaces/${String(ws.id)}/switch`)
    expect((await v.ok('GET', '/api/session')).workspace).toMatchObject({ role: 'viewer' })
    const seen = await v.ok('GET', '/api/watchlist')
    expect(seen.items.map((i: J) => i.instrumentId)).toEqual(['xchg:TCS'])
    expect((await v.call('POST', '/api/watchlist', { instrumentId: 'amfi:120716' })).status).toBe(403)
    expect((await v.call('POST', '/api/watchlist/remove', { instrumentId: 'xchg:TCS' })).status).toBe(403)
    expect((await v.ok('GET', '/api/watchlist')).count).toBe(1)

    // each change that did something is audited, with the role that made it; a repeat and a refusal write nothing
    expect(api.ctx.db.all(`SELECT actor, action, subject FROM audit WHERE action LIKE 'watchlist.%' ORDER BY id`)).toEqual([
      { actor: 'owner', action: 'watchlist.add', subject: 'coindcx:BTCINR' }, { actor: 'owner', action: 'watchlist.add', subject: 'amfi:120716' },
      { actor: 'owner', action: 'watchlist.add', subject: 'amfi:120716' }, { actor: 'owner', action: 'watchlist.add', subject: 'xchg:TCS' }])
  }, 60_000)

  it('the permission table says what the code enforces: read by a viewer, change by an operator, each behind a session and a rate limit', () => {
    const at = (m: string, p: string) => routeTable().find((r) => r.method === m && r.path === p)!
    expect(at('GET', '/api/watchlist')).toMatchObject({ session: true, least: 'viewer', transaction: 'reads' })
    expect(at('POST', '/api/watchlist')).toMatchObject({ session: true, least: 'operator', transaction: 'one', checks: expect.arrayContaining(['rate limit', 'household set up']) })
    expect(at('POST', '/api/watchlist/remove')).toMatchObject({ session: true, least: 'operator', transaction: 'one', checks: expect.arrayContaining(['rate limit']) })
  })
})
