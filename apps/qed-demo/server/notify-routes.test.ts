/**
 * The notification routes over HTTP (server/api.ts: GET /api/notify, POST /api/notify/prefs, POST /api/notices/:id/ack),
 * against the real API server (R10-006 at API level; server/notify.test.ts covers the policy itself): a session is
 * needed; settings are checked and kept per person; a change to who can act is told at once and waits for an
 * acknowledgement that only its owner can give; a notice that needs nothing cannot be acknowledged.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { notice } from './execute.ts'
import { DEFAULT_PREFS, notifyTick } from './notify.ts'
import { authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (RISK-078).
const PORT = 20000 + Math.floor(Math.random() * 20000)

describe('the notification routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-notify-api-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }

  it('needs a session', async () => {
    const anon = client()
    expect((await anon.call('GET', '/api/notify')).status).toBe(401)
    expect((await anon.call('POST', '/api/notify/prefs', { digestAt: '09:00' })).status).toBe(401)
  })

  it('a new account has nothing waiting; settings are checked, saved and kept per person', async () => {
    const a = client(), b = client()
    await signUp(a.ok, authenticatorFor(PORT), 'notify-a', 'Notify A')
    await signUp(b.ok, authenticatorFor(PORT), 'notify-b', 'Notify B')
    const v = await a.ok('GET', '/api/notify')
    expect(v).toMatchObject({ prefs: DEFAULT_PREFS, unacknowledged: [], acknowledged: [], held: [], digests: [] })
    expect(v.delivery).toMatch(/Nothing leaves this computer/)
    const bad = await a.call('POST', '/api/notify/prefs', { quietFrom: '22:00' })
    expect([bad.status, bad.json.error?.fields]).toEqual([400, { quietTo: 'Set both ends of the quiet hours, or neither.' }])
    const night = { quietFrom: '22:00', quietTo: '07:00', digestAt: '08:30', escalateMin: 60 }
    expect((await a.ok('POST', '/api/notify/prefs', night)).prefs).toEqual(night)
    expect((await a.ok('GET', '/api/notify')).prefs).toEqual(night)
    expect((await b.ok('GET', '/api/notify')).prefs).toEqual(DEFAULT_PREFS)
  })

  it('adding a passkey is told at once and waits for an acknowledgement only its owner can give; acknowledging settles it', async () => {
    const a = client(), b = client(), ka = authenticatorFor(PORT)
    await signUp(a.ok, ka, 'notify-c', 'Notify C')
    await signUp(b.ok, authenticatorFor(PORT), 'notify-d', 'Notify D')
    await stepUp(a.ok, ka)
    const begin = await a.ok('POST', '/api/security/passkeys/begin')
    await a.ok('POST', '/api/security/passkeys/finish', { challengeId: begin.challengeId, response: authenticatorFor(PORT).create(begin.options), passkeyName: 'Phone' })
    // In the lists at once, before the engine has planned it
    const listed = (await a.ok('GET', '/api/needs-you')).notices as J[]
    const told = listed.find((n) => n.kind === 'security-change')!
    expect(told).toMatchObject({ title: 'A passkey was added to your account' })
    expect(String(told.body)).toMatch(/If this was not you, open Security and recovery now/)
    notifyTick(api.ctx.db, Date.now())
    expect(((await a.ok('GET', '/api/notify')).unacknowledged as J[]).map((n) => [n.title, n.urgency])).toEqual([['A passkey was added to your account', 'critical']])
    // Another person cannot acknowledge it, and is told no such notice exists rather than that it is someone else's
    const other = await b.call('POST', `/api/notices/${told.id}/ack`)
    expect([other.status, other.json.error?.code]).toEqual([404, 'not_found'])
    await a.ok('POST', `/api/notices/${told.id}/ack`)
    const after = await a.ok('GET', '/api/notify')
    expect(after.unacknowledged).toEqual([])
    expect((after.acknowledged as J[]).map((n) => [n.title, typeof n.ackedAt])).toEqual([['A passkey was added to your account', 'number']])
    expect(((await a.ok('GET', '/api/needs-you')).notices as J[]).some((n) => n.kind === 'security-change')).toBe(false)
  })

  it('a password session of an account with a passkey cannot clear the notice of a change to its security; a passkey confirmation can', async () => {
    const owner = client(), key = authenticatorFor(PORT), PW = 'a long pass phrase for notices'
    await owner.ok('POST', '/api/auth/signup', { handle: 'notify-pw', password: PW, displayName: 'Careful Person' })
    // the sign-up session is fresh from the password: it adds the account's first passkey, which is told at once
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const told = ((await owner.ok('GET', '/api/needs-you')).notices as J[]).find((n) => n.kind === 'security-change')!
    expect(told.title).toBe('A passkey was added to your account')
    // someone holding the password signs in and tries to clear it
    const thief = client()
    await thief.ok('POST', '/api/auth/login', { handle: 'notify-pw', password: PW })
    await thief.ok('POST', '/api/auth/stepup', { password: PW })
    const refused = await thief.call('POST', `/api/notices/${told.id}/ack`)
    expect([refused.status, refused.json.error?.code]).toEqual([401, 'stepup_required'])
    expect(((await owner.ok('GET', '/api/needs-you')).notices as J[]).some((n) => n.id === told.id)).toBe(true)
    // the owner confirms with the passkey, and the notice is settled
    await stepUp(owner.ok, key)
    await owner.ok('POST', `/api/notices/${told.id}/ack`)
    expect(((await owner.ok('GET', '/api/needs-you')).notices as J[]).some((n) => n.id === told.id)).toBe(false)
  })

  it('a notice that needs nothing from the person cannot be acknowledged, only dismissed', async () => {
    const a = client()
    const { userId } = await signUp(a.ok, authenticatorFor(PORT), 'notify-e', 'Notify E')
    notice(api.ctx.db, userId, { level: 'info', kind: 'program-expired', title: 'An instruction ended', body: 'b' }, Date.now())
    const id = api.ctx.db.get<{ id: string }>('SELECT id FROM notices WHERE user_id = ? AND kind = ?', userId, 'program-expired')!.id
    const r = await a.call('POST', `/api/notices/${id}/ack`)
    expect([r.status, r.json.error?.code]).toEqual([400, 'not_acknowledgeable'])
    expect((await a.call('POST', `/api/notices/${id}/dismiss`)).status).toBe(200)
  })
})
