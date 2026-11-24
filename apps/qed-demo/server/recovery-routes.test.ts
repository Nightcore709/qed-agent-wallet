/**
 * R12 over HTTP, against the real API server: the reset and recovery requests answer every identifier alike and in the
 * same time; the developer outbox exists only while the local test outbox is the delivery (a public origin refuses it);
 * and a whole recovery by email, read from the outbox, ends in a session whose passkey signs in only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { authenticatorFor, signUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)

function client(port: number) {
  let cookie = '', csrf = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }
  return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
}

describe('reset and recovery over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-recovery-routes-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_WEB_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => { api.ctx.db.run(`DELETE FROM rate_limits WHERE key LIKE 'forgot%' OR key LIKE 'recover%' OR key LIKE 'signup:%'`) })
  const outbox = async (to: string): Promise<J[]> => ((await client(PORT).ok('GET', '/api/dev/outbox')).messages as J[]).filter((m) => m.to === to)
  const tokenIn = (body: string, page: string): string => new RegExp(`${page}#token=([A-Za-z0-9_-]+)`).exec(body)![1]!

  it('a reset or recovery request answers the same, in at least the same time, whether or not the account exists', async () => {
    const owner = client(PORT)
    await signUp(owner.ok, authenticatorFor(PORT), 'routeowner', 'Route Owner')
    const answers: { status: number; body: string; ms: number }[] = []
    for (const [path, id] of [['/api/auth/password/forgot', 'routeowner'], ['/api/auth/password/forgot', 'no-such-person'], ['/api/auth/recovery/link', 'routeowner'], ['/api/auth/recovery/link', 'nobody@gmail.com']] as const) {
      const t0 = Date.now()
      const r = await client(PORT).call('POST', path, { identifier: id })
      answers.push({ status: r.status, body: JSON.stringify(r.json), ms: Date.now() - t0 })
    }
    expect(new Set(answers.map((a) => `${a.status} ${a.body}`))).toEqual(new Set(['200 {"ok":true}']))
    for (const a of answers) expect(a.ms).toBeGreaterThanOrEqual(440)
  }, 60_000)

  it('the outbox page says nothing was sent; the session says how messages leave', async () => {
    const r = await client(PORT).ok('GET', '/api/dev/outbox')
    expect(r.notice).toBe('Simulated delivery: no email or text message was sent.')
    expect(r.simulated).toBe(true)
    expect(await client(PORT).ok('GET', '/api/session')).toMatchObject({ authenticated: false, delivery: 'outbox' })
  })

  it('a recovery by email, read from the outbox, ends signed in with a passkey that approves nothing', async () => {
    const owner = client(PORT), key = authenticatorFor(PORT)
    const made = await signUp(owner.ok, key, 'routerec', 'Route Rec')
    // the sign-up's own confirmation (five minutes) adds the address; its link confirms it
    await owner.ok('POST', '/api/security/addresses', { kind: 'email', address: 'routerec@gmail.com' })
    const confirm = (await outbox('routerec@gmail.com')).find((m) => m.purpose === 'verify-email')!
    expect(await client(PORT).ok('POST', '/api/auth/email/confirm', { token: tokenIn(confirm.body, '/verify-email') })).toMatchObject({ kind: 'email', address: 'routerec@gmail.com' })
    // the protection delay is written past here, as the other route suites write a contact's
    api.ctx.db.run(`UPDATE contact_points SET usable_from = ? WHERE address = 'routerec@gmail.com'`, Date.now() - 1000)
    const someone = client(PORT)
    await someone.ok('POST', '/api/auth/recovery/link', { identifier: 'routerec@gmail.com' })
    const link = (await outbox('routerec@gmail.com')).find((m) => m.purpose === 'recovery-link')!
    const token = tokenIn(link.body, '/recover')
    expect(await someone.ok('POST', '/api/auth/recovery/link/state', { token })).toMatchObject({ state: 'start', handle: 'routerec', proofs: { savedCode: true } })
    const started = await someone.ok('POST', '/api/auth/recovery/link/start', { token, code: made.recoveryCodes[0] })
    expect(started.availableAt).toBeGreaterThan(Date.now())
    // a replayed start with the same link is refused: the link was spent by the first
    expect((await someone.call('POST', '/api/auth/recovery/link/start', { token, code: made.recoveryCodes[1] })).json.error.code).toBe('link_used')
    // the owner's devices see it; after its wait (written past here) a new link finishes it
    expect((await owner.ok('GET', '/api/session')).openRecoveries).toBe(1)
    api.ctx.db.run('UPDATE recovery_requests SET available_at = ? WHERE id = ?', Date.now() - 1000, started.requestId)
    api.ctx.db.run(`DELETE FROM rate_limits WHERE key LIKE 'recover%'`)
    await someone.ok('POST', '/api/auth/recovery/link', { identifier: 'routerec' })
    const ready = tokenIn((await outbox('routerec@gmail.com')).find((m) => m.purpose === 'recovery-link')!.body, '/recover')
    expect(await someone.ok('POST', '/api/auth/recovery/link/state', { token: ready })).toMatchObject({ state: 'ready' })
    const device = authenticatorFor(PORT)
    // the link alone finishes nothing: the finishing key the starting browser was given goes with it (review H1)
    expect((await someone.call('POST', '/api/auth/recovery/link/passkey/begin', { token: ready })).json.error.code).toBe('finish_key_needed')
    const b = await someone.ok('POST', '/api/auth/recovery/link/passkey/begin', { token: ready, finishKey: started.finishKey })
    const done = await someone.ok('POST', '/api/auth/recovery/link/passkey/finish', { challengeId: b.challengeId, response: device.create(b.options) })
    expect(done).toMatchObject({ authority: 'signin' })
    expect(done.recoveryCodes).toHaveLength(10)
    // signed in, restricted: no confirmation, no approval
    expect(await someone.ok('GET', '/api/session')).toMatchObject({ authenticated: true, authority: 'full', stepUpFresh: false })
    const st = await someone.call('POST', '/api/auth/passkey/stepup/begin')
    expect(st.json.error).toBeUndefined() // the old passkey (not lost here) still could; the recovered one cannot answer it:
    const fin = await someone.call('POST', '/api/auth/passkey/stepup/finish', { challengeId: st.json.challengeId, response: device.get(st.json.options) })
    expect([fin.status, fin.json.error.code]).toEqual([409, 'authority_restricted'])
    // the owner's old passkey is suspended from... nowhere: here the owner really lost it. Removed in the database as a
    // lost device would be, the account is restricted as a whole and says so
    api.ctx.db.run(`UPDATE webauthn_credentials SET removed_at = ? WHERE id = ?`, Date.now(), key.id)
    expect(await someone.ok('GET', '/api/session')).toMatchObject({ authority: 'restricted', hasPasskey: true })
    const again = await someone.call('POST', '/api/auth/passkey/stepup/begin')
    expect([again.status, again.json.error.code]).toEqual([409, 'authority_restricted'])
    // nor can it clear the notice that warns the owner of the recovery (only a passkey with authority settles it)
    const completed = api.ctx.db.get<{ id: string }>(`SELECT n.id FROM notices n JOIN users u ON u.id = n.user_id WHERE u.handle = 'routerec' AND n.subject = 'recovery-completed'`)
    expect(completed).toBeDefined()
    const ack = await someone.call('POST', `/api/notices/${completed!.id}/ack`)
    expect([ack.status, ack.json.error?.code]).toEqual([401, 'stepup_required'])
    // asking for authority with the recovered passkey schedules it, and the session says when
    const ab = await someone.ok('POST', '/api/security/authority/begin')
    const asked = await someone.ok('POST', '/api/security/authority/finish', { challengeId: ab.challengeId, response: device.get(ab.options) })
    expect((await someone.ok('GET', '/api/session')).authorityRequest).toMatchObject({ id: asked.changeId, effective_at: asked.effectiveAt })
  }, 120_000)
})

describe('where the outbox is refused', () => {
  it('a public origin has no outbox, and refuses one asked for; links point at the configured origin only', () => {
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_HOST: '127.0.0.1' }).delivery).toBe('none')
    expect(() => loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_DELIVERY: 'outbox' })).toThrow(/for this computer only/)
    expect(() => loadConfig({ QED_DELIVERY: 'smtp' })).toThrow(/QED_DELIVERY/)
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in' }).linkOrigin).toBe('https://wallet.example.in')
    expect(loadConfig({ QED_WEB_PORT: '8700' }).linkOrigin).toBe('http://localhost:8700')
    expect(() => loadConfig({ QED_LINK_ORIGIN: 'https://evil.example' })).toThrow(/QED_LINK_ORIGIN/)
  })

  it('with no adapter the developer page does not exist', async () => {
    const port = PORT + 1
    const d = mkdtempSync(join(tmpdir(), 'qed-recovery-none-'))
    const a = startApi(loadConfig({ QED_DB: join(d, 'qed.db'), QED_API_PORT: String(port), QED_DELIVERY: 'none' }))
    try {
      const r = await client(port).call('GET', '/api/dev/outbox')
      expect(r.status).toBe(404)
      expect((await client(port).ok('GET', '/api/session')).delivery).toBe('none')
    } finally { a.close(); rmSync(d, { recursive: true, force: true }) }
  })
})
