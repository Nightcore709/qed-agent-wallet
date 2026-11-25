/**
 * Account access over HTTP, against the real API server (R14, Priority 1): the sign-up route's answer does not depend on
 * whether an address is in use; sign-in with Google does not exist where it is not configured; where it is, the whole
 * round trip runs against the local stand-in issuer with the browser's binding cookie, and the session it opens is an
 * ordinary one: every route that needs the device refuses it, as it refuses a password session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { type StandIn, startOidcStandIn } from './oidc-standin.ts'

type J = Record<string, any>
const PW = 'a long enough pass phrase'

function clientFor(port: number) {
  const jar = new Map<string, string>()
  let csrf = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const set of res.headers.getSetCookie()) { const [pair, ...attrs] = set.split(';'); const [k, ...v] = pair!.split('='); if (attrs.some((a) => a.trim() === 'Max-Age=0')) jar.delete(k!); else jar.set(k!, v.join('=')) }
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json, setCookies: res.headers.getSetCookie() }
  }
  return { jar, call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
}

describe('account access where Google is not configured (production today)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-access-routes-'))
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  const client = () => clientFor(PORT)

  it('says so in the session, and its routes answer as any unknown address does', async () => {
    const c = client()
    expect((await c.ok('GET', '/api/session')).signIn).toEqual({ google: false })
    for (const [m, p] of [['POST', '/api/auth/google/begin'], ['POST', '/api/auth/google/finish']] as const) {
      const r = await c.call(m, p, { code: 'x', state: 'y'.repeat(43) })
      expect([r.status, r.json.error?.code]).toEqual([404, 'not_found'])
    }
    await c.ok('POST', '/api/auth/signup', { email: 'g-off@example.in', password: PW, displayName: 'G Off' })
    for (const p of ['/api/security/google/begin', '/api/security/google/finish', '/api/security/google/fid_x/remove']) expect((await c.call('POST', p, {})).status).toBe(404)
    expect((await c.ok('GET', '/api/security')).google).toEqual({ enabled: false, standIn: false, identities: [] })
  }, 30_000)

  it('opening an account answers the same whether or not the address is in use, and carries no saved codes', async () => {
    const a = await client().call('POST', '/api/auth/signup', { email: 'same@example.in', password: PW, displayName: 'First Person' })
    const b = await client().call('POST', '/api/auth/signup', { email: 'SAME@example.in', password: 'another long pass phrase', displayName: 'Second Person' })
    expect([a.status, b.status]).toEqual([200, 200])
    expect(Object.keys(b.json).sort()).toEqual(Object.keys(a.json).sort())
    expect(Object.keys(a.json).sort()).toEqual(['csrf', 'email', 'handle', 'userId'])
    expect(a.json.email).toEqual({ address: 'same@example.in', verified: false, pending: true, canVerify: true, simulated: true })
    expect(b.json.email).toMatchObject({ verified: false, pending: true })
    expect(b.json.userId).not.toBe(a.json.userId)
  }, 30_000)

  it('an account opened with an address signs in with it; the session is a password session, and what needs the device refuses it', async () => {
    const c = client()
    await c.ok('POST', '/api/auth/signup', { email: 'routes@example.in', password: PW, displayName: 'Route Person', handle: 'route-person' })
    await c.ok('POST', '/api/auth/logout')
    const wrong = await c.call('POST', '/api/auth/login', { handle: 'routes@example.in', password: 'not the password at all' })
    const unknown = await c.call('POST', '/api/auth/login', { handle: 'nobody@example.in', password: 'not the password at all' })
    expect([wrong.status, wrong.json]).toEqual([unknown.status, unknown.json])
    expect(wrong.json.error).toMatchObject({ code: 'bad_credentials', message: 'That email and password do not match.' })
    await c.ok('POST', '/api/auth/login', { handle: 'Routes@Example.in', password: PW })
    const me = await c.ok('GET', '/api/session')
    expect(me).toMatchObject({ authenticated: true, authMethod: 'password', stepUpFresh: false, hasPasskey: false, hasPassword: true, recoveryCodesLeft: 0, user: { handle: 'route-person' }, email: { address: 'routes@example.in', verified: false } })
    await c.ok('POST', '/api/household', {})
    const refused = async (m: string, p: string, b?: unknown) => { const r = await c.call(m, p, b); return [r.status, r.json.error?.code] }
    expect(await refused('POST', '/api/auth/passkey/stepup/begin')).toEqual([409, 'passkey_needed'])
    expect(await refused('POST', '/api/workspaces', { name: 'A shop' })).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/stop/clear')).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/vault/setup', { origin: `http://localhost:${PORT}` })).toEqual([401, 'stepup_required'])
    // a plain sign-in is not a just-typed password: it sets up no device and makes no codes until the password is typed again
    expect(await refused('POST', '/api/security/passkeys/begin')).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/security/recovery-codes', {})).toEqual([401, 'stepup_required'])
  }, 60_000)
})

describe('sign-in with Google over HTTP, against the stand-in issuer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-google-routes-'))
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const CLIENT = 'qed-routes.apps.example', SECRET = 'routes-secret'
  let api: ReturnType<typeof startApi>, idp: StandIn
  beforeAll(async () => {
    idp = await startOidcStandIn({ clientId: CLIENT, clientSecret: SECRET, redirectUris: [`http://localhost:${PORT}/auth/google/callback`] })
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_WEB_PORT: String(PORT), QED_TEST_STACK: '1', QED_GOOGLE_CLIENT_ID: CLIENT, QED_GOOGLE_CLIENT_SECRET: SECRET, QED_GOOGLE_ISSUER: idp.issuer }))
  })
  afterAll(async () => { api.close(); await idp.close(); rmSync(dir, { recursive: true, force: true }) })
  const client = () => clientFor(PORT)
  const atIssuer = async (url: string) => { const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!); return { code: back.searchParams.get('code'), state: back.searchParams.get('state'), iss: back.searchParams.get('iss') } }

  it('the round trip: a binding cookie that only this browser holds, then a session that looks and prepares and nothing more', async () => {
    idp.user = { sub: 'routes-1', email: 'kavya@example.in', email_verified: true, name: 'Kavya Iyer' }
    const c = client()
    expect((await c.ok('GET', '/api/session')).signIn).toEqual({ google: 'stand-in' })
    const begun = await c.call('POST', '/api/auth/google/begin', {})
    expect(begun.status).toBe(200)
    const binding = begun.setCookies.find((s) => s.startsWith('qed_oauth='))!
    expect(binding).toMatch(/; HttpOnly; SameSite=Strict; Max-Age=\d+/)
    const cb = await atIssuer(begun.json.url)
    // another browser, without the cookie, finishes nothing with the same callback
    const other = await client().call('POST', '/api/auth/google/finish', cb)
    expect([other.status, other.json.error?.code]).toEqual([400, 'google_state'])
    // and the state is spent by that attempt: the browser that began must start again
    const spent = await c.call('POST', '/api/auth/google/finish', cb)
    expect([spent.status, spent.json.error?.code]).toEqual([400, 'google_state'])
    const again = await c.ok('POST', '/api/auth/google/begin', {})
    const done = await c.call('POST', '/api/auth/google/finish', await atIssuer(again.url))
    expect(done.status).toBe(200)
    expect(done.json).toMatchObject({ purpose: 'signin', created: true })
    // the binding cookie is cleared and the session cookie set
    expect(c.jar.has('qed_oauth')).toBe(false)
    expect(c.jar.has('qed_session')).toBe(true)
    const me = await c.ok('GET', '/api/session')
    expect(me).toMatchObject({ authenticated: true, authMethod: 'google', stepUpFresh: false, hasPasskey: false, hasPassword: false, email: { address: 'kavya@example.in', verified: true } })
    await c.ok('POST', '/api/household', {})
    const refused = async (m: string, p: string, b?: unknown) => { const r = await c.call(m, p, b); return [r.status, r.json.error?.code] }
    expect(await refused('POST', '/api/auth/passkey/stepup/begin')).toEqual([409, 'passkey_needed'])
    expect(await refused('POST', '/api/workspaces', { name: 'A shop' })).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/stop/clear')).toEqual([401, 'stepup_required'])
    expect(await refused('POST', '/api/vault/setup', { origin: `http://localhost:${PORT}` })).toEqual([401, 'stepup_required'])
    // there is no password to type: the password step-up opens nothing for this account
    expect((await c.call('POST', '/api/auth/stepup', { password: PW })).status).toBe(401)
    expect((await c.ok('GET', '/api/security')).google).toMatchObject({ enabled: true, standIn: true, identities: [{ email: 'kavya@example.in' }] })
  }, 60_000)

  it('a sign-in begun signed out cannot be finished through the signed-in route, nor the other way round', async () => {
    idp.user = { sub: 'routes-2', email: 'asha@example.in', email_verified: true, name: 'Asha' }
    const c = client()
    const first = await c.ok('POST', '/api/auth/google/begin', {})
    await c.ok('POST', '/api/auth/google/finish', await atIssuer(first.url))
    // a 'confirm' begun by this session, sent to the signed-out route
    api.ctx.db.run('UPDATE sessions SET stepup_at = NULL')
    const confirm = await c.ok('POST', '/api/security/google/begin', { purpose: 'confirm' })
    const viaSignedOut = await c.call('POST', '/api/auth/google/finish', await atIssuer(confirm.url))
    expect([viaSignedOut.status, viaSignedOut.json.error?.code]).toEqual([400, 'google_state'])
    // a sign-in begun signed out, sent to the signed-in route
    const signin = await c.ok('POST', '/api/auth/google/begin', {})
    const viaSignedIn = await c.call('POST', '/api/security/google/finish', await atIssuer(signin.url))
    expect([viaSignedIn.status, viaSignedIn.json.error?.code]).toEqual([400, 'google_state'])
    // the right route confirms, and the session is then fresh for the first device only
    const right = await c.ok('POST', '/api/security/google/begin', { purpose: 'confirm' })
    expect(await c.ok('POST', '/api/security/google/finish', await atIssuer(right.url))).toEqual({ purpose: 'confirm', ok: true })
    expect((await c.call('POST', '/api/security/passkeys/begin')).status).toBe(200)
    expect((await c.ok('GET', '/api/session')).stepUpFresh).toBe(false)
  }, 60_000)
})
