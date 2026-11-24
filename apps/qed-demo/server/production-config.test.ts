/**
 * The production settings of the API (apps/qed-demo/docs/PRODUCTION.md, sections 1 to 3): one public origin, its host,
 * its passkey relying party, a __Host- session cookie, HSTS, CSRF, and the client's address behind proxies. Unset, every
 * setting keeps the local build's behaviour, which the first test pins. The API is started in this process over plain
 * HTTP, as it runs behind a proxy that ends TLS; TLS itself, a real browser and a virtual authenticator are the
 * rehearsal's (scripts/prod-rehearsal.ts). Port 7431 only.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientIp, startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { relyingParty } from './passkeys.ts'
import { SoftAuthenticator } from './softauthn.ts'

describe('without production settings the local build is unchanged', () => {
  it('hosts, origins, cookie, HSTS, TLS, proxies and the relying party are as before', () => {
    const c = loadConfig({})
    expect(c.allowedHosts).toEqual(['127.0.0.1:5175', 'localhost:5175', '127.0.0.1:5174', 'localhost:5174'])
    expect(c.allowedOrigins).toEqual(['http://127.0.0.1:5175', 'http://localhost:5175', 'http://127.0.0.1:5174', 'http://localhost:5174'])
    expect(c).toMatchObject({ cookieName: 'qed_session', secureCookies: false, hsts: null, tls: null, trustProxyHops: 0, publicOrigin: null, rpId: null })
    expect(relyingParty(c, {})).toEqual({ id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] })
    expect(relyingParty(c, { QED_WEB_PORT: '5174' }).origins).toEqual(['http://localhost:5175', 'http://localhost:5174'])
    expect(loadConfig({ QED_SECURE_COOKIES: '1' })).toMatchObject({ secureCookies: true, cookieName: 'qed_session', hsts: null })
  })
})

describe('a public origin', () => {
  it('https on a port: that host and origin only, a __Host- cookie, HSTS for a year with subdomains, the host name as relying party', () => {
    const c = loadConfig({ QED_PUBLIC_ORIGIN: 'https://qed.localhost:7443', QED_API_PORT: '7443' })
    expect(c.allowedHosts).toEqual(['qed.localhost:7443'])
    expect(c.allowedOrigins).toEqual(['https://qed.localhost:7443'])
    expect(c).toMatchObject({ cookieName: '__Host-qed_session', secureCookies: true, hsts: 'max-age=31536000; includeSubDomains', rpId: 'qed.localhost', publicOrigin: 'https://qed.localhost:7443' })
    expect(relyingParty(c, { QED_RP_ID: 'ignored-when-configured', QED_WEB_PORT: '5174' })).toEqual({ id: 'qed.localhost', name: 'QED', origins: ['https://qed.localhost:7443'] })
  })

  it('leaves the default port out of the host, as browsers send it', () => {
    const c = loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in' })
    expect(c.allowedHosts).toEqual(['wallet.example.in'])
    expect(c.allowedOrigins).toEqual(['https://wallet.example.in'])
  })

  it('may name a parent domain as the relying-party id; any other id is refused at start', () => {
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_RP_ID: 'example.in' }).rpId).toBe('example.in')
    expect(() => loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_RP_ID: 'other.in' })).toThrow(/QED_RP_ID/)
    expect(() => loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_RP_ID: 'xample.in' })).toThrow(/QED_RP_ID/)
  })

  it('refuses at start any setting that would serve with less: plain http on a real domain, a path, an IP address, TLS without https', () => {
    const bad: Record<string, string>[] = [
      { QED_PUBLIC_ORIGIN: 'http://wallet.example.in' },
      { QED_PUBLIC_ORIGIN: 'https://wallet.example.in/app' },
      { QED_PUBLIC_ORIGIN: 'https://user:pw@wallet.example.in' },
      { QED_PUBLIC_ORIGIN: 'https://127.0.0.1:7443' },
      { QED_PUBLIC_ORIGIN: 'not a url' },
      { QED_PUBLIC_ORIGIN: 'http://qed.localhost:7443', QED_TLS_CERT_FILE: 'c.pem', QED_TLS_KEY_FILE: 'k.pem' },
      { QED_TLS_CERT_FILE: 'c.pem', QED_TLS_KEY_FILE: 'k.pem' },
      { QED_PUBLIC_ORIGIN: 'https://qed.localhost:7443', QED_TLS_CERT_FILE: 'c.pem' },
      { QED_PUBLIC_ORIGIN: 'https://qed.localhost:7443', QED_HSTS: 'max-age=1; includeSubDomains; bogus' },
      { QED_TRUST_PROXY_HOPS: '-1' },
      { QED_TRUST_PROXY_HOPS: '1.5' },
    ]
    for (const env of bad) expect(() => loadConfig(env), JSON.stringify(env)).toThrow(/^Configuration: /)
    // plain http is accepted only for a name that means this computer (a secure context in browsers)
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'http://qed.localhost:7480' })).toMatchObject({ cookieName: 'qed_session', secureCookies: false, hsts: null })
  })

  it('adds a named host for a platform health check, and HSTS is the operator\'s to lengthen or switch off, never silently weaker', () => {
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_EXTRA_HOSTS: 'Health.internal:8080, ' }).allowedHosts).toEqual(['wallet.example.in', 'health.internal:8080'])
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_EXTRA_HOSTS: 'health.internal' }).allowedOrigins).toEqual(['https://wallet.example.in'])
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_HSTS: 'off' }).hsts).toBeNull()
    expect(loadConfig({ QED_PUBLIC_ORIGIN: 'https://wallet.example.in', QED_HSTS: 'max-age=63072000; includeSubDomains; preload' }).hsts).toBe('max-age=63072000; includeSubDomains; preload')
  })
})

describe('secure by default when reachable', () => {
  it('refuses to listen beyond this computer with the local build\'s settings; with a public origin it may', () => {
    expect(() => loadConfig({ QED_HOST: '0.0.0.0' })).toThrow(/QED_HOST=0\.0\.0\.0 makes the API reachable/)
    expect(() => loadConfig({ QED_HOST: '192.168.1.20' })).toThrow(/QED_PUBLIC_ORIGIN/)
    expect(loadConfig({ QED_HOST: '0.0.0.0', QED_PUBLIC_ORIGIN: 'https://wallet.example.in' }).host).toBe('0.0.0.0')
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(loadConfig({ QED_HOST: host }).host).toBe(host)
  })
})

describe('session lifetimes (NIST SP 800-63B-4 section 2.2.3)', () => {
  const auth = pathToFileURL(join(import.meta.dirname, 'auth.ts')).href
  const load = (env: Record<string, string>) => spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(auth)}); console.log(JSON.stringify([m.IDLE_MS, m.ABSOLUTE_MS]))`], { env: { ...process.env, QED_SESSION_IDLE_MINUTES: '', QED_SESSION_MAX_MINUTES: '', ...env }, encoding: 'utf8' })
  it('are NIST\'s AAL2 values, 1 hour idle and 24 hours in all, everywhere unless set (R13 hardening; before, the local build kept 12 hours and 7 days)', () => {
    expect(JSON.parse(load({}).stdout)).toEqual([3600_000, 86_400_000])
  })
  it('take the production values, 1 hour idle and 24 hours in all', () => {
    expect(JSON.parse(load({ QED_SESSION_IDLE_MINUTES: '60', QED_SESSION_MAX_MINUTES: '1440' }).stdout)).toEqual([3600_000, 86_400_000])
  })
  it('stop the process on a value that is not a positive whole number of minutes, or an idle limit longer than the whole', () => {
    const bad: Record<string, string>[] = [{ QED_SESSION_IDLE_MINUTES: '0' }, { QED_SESSION_IDLE_MINUTES: '1.5' }, { QED_SESSION_MAX_MINUTES: 'a day' }, { QED_SESSION_IDLE_MINUTES: '90', QED_SESSION_MAX_MINUTES: '60' }]
    for (const env of bad) {
      const r = load(env)
      expect(r.status, JSON.stringify(env)).not.toBe(0)
      expect(r.stderr).toMatch(/Configuration: QED_SESSION_/)
    }
  })
})

describe('the client\'s address behind reverse proxies', () => {
  const req = (xff: string | undefined, socket = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } }) as never
  it('is the socket\'s with no proxy, whatever X-Forwarded-For claims', () => {
    expect(clientIp(req('6.6.6.6'), 0)).toBe('10.0.0.9')
  })
  it('behind N proxies is the N-th entry from the right; entries the client wrote to its left are ignored', () => {
    expect(clientIp(req('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7')
    expect(clientIp(req('6.6.6.6, 203.0.113.7, 198.51.100.2'), 2)).toBe('203.0.113.7')
  })
  it('falls back to the socket when the header is shorter than the configured proxies (they are not as configured)', () => {
    expect(clientIp(req(undefined), 1)).toBe('10.0.0.9')
    expect(clientIp(req('203.0.113.7'), 2)).toBe('10.0.0.9')
  })
  it('is read from QED_TRUST_PROXY_HOPS', () => {
    expect(loadConfig({ QED_TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2)
  })
})

describe('the API under a public origin (TLS ended in front of it)', () => {
  const PORT = 7431
  const ORIGIN = 'https://qed.localhost:7443'
  const HOST = 'qed.localhost:7443'
  let api: ReturnType<typeof startApi>
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qed-prod-config-'))
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_PUBLIC_ORIGIN: ORIGIN, QED_AI_PROVIDER: 'none', QED_RAIL_TOKEN_FILE: join(dir, 'none') }))
  })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })

  interface Answer { status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, any> }
  function call(method: string, path: string, o: { host?: string; origin?: string | null; cookie?: string; csrf?: string; body?: unknown; site?: string } = {}): Promise<Answer> {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body)
    const headers: Record<string, string> = { host: o.host ?? HOST }
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN
    if (o.cookie) headers.cookie = o.cookie
    if (o.csrf) headers['x-qed-csrf'] = o.csrf
    if (o.site) headers['sec-fetch-site'] = o.site
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)) }
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => { text += c.toString() })
        res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text) } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, json }) })
      })
      r.on('error', reject)
      if (body) r.write(body)
      r.end()
    })
  }
  const setCookie = (a: Answer): string => String(([] as string[]).concat(a.headers['set-cookie'] ?? [])[0] ?? '')
  const pair = (a: Answer): string => setCookie(a).split(';')[0]!

  async function signUp(handle: string, auth: SoftAuthenticator, tamper: (o: any) => any = (o) => o): Promise<Answer> {
    const b = await call('POST', '/api/auth/passkey/signup/begin', { body: { handle, displayName: handle } })
    expect(b.status).toBe(200)
    return call('POST', '/api/auth/passkey/signup/finish', { body: { challengeId: b.json.challengeId, response: auth.create(tamper(b.json.options)) } })
  }

  it('signs up with a passkey made at the origin; the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, with no Domain', async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN })
    const b = await call('POST', '/api/auth/passkey/signup/begin', { body: { handle: 'asha', displayName: 'Asha' } })
    expect(b.json.options.rp.id).toBe('qed.localhost')
    const f = await call('POST', '/api/auth/passkey/signup/finish', { body: { challengeId: b.json.challengeId, response: auth.create(b.json.options) } })
    expect(f.status).toBe(200)
    expect(setCookie(f)).toMatch(/^__Host-qed_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
    expect(setCookie(f)).not.toMatch(/Domain=/i)
    const s = await call('GET', '/api/session', { cookie: pair(f) })
    expect(s.json.authenticated).toBe(true)
    // and signs in again with the same passkey
    const lb = await call('POST', '/api/auth/passkey/login/begin', { body: {} })
    const lf = await call('POST', '/api/auth/passkey/login/finish', { body: { challengeId: lb.json.challengeId, response: auth.get(lb.json.options) } })
    expect(lf.status).toBe(200)
    expect(pair(lf)).toMatch(/^__Host-qed_session=/)
  })

  it('sends HSTS on every response: an answer, a refusal for another host or site, a missing route, the interface', async () => {
    const answers = [
      await call('GET', '/api/session'),
      await call('GET', '/api/session', { host: 'localhost:7431' }),
      await call('GET', '/api/session', { origin: 'https://evil.localhost:7443' }),
      await call('GET', '/api/nothing-here'),
      await call('GET', '/'),
    ]
    expect(answers.map((a) => a.status)).toEqual([200, 421, 403, 404, expect.any(Number)])
    for (const a of answers) expect(a.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
    for (const a of answers) expect(a.headers['x-content-type-options']).toBe('nosniff')
  })

  it('answers only to its own host name: localhost, 127.0.0.1 and other names are refused', async () => {
    for (const host of ['localhost:7431', `127.0.0.1:${PORT}`, 'qed.localhost:7431', 'evil.example:7443', 'qed.localhost']) {
      const a = await call('GET', '/api/session', { host })
      expect(a.status, host).toBe(421)
      expect(a.json.error.code).toBe('wrong_host')
    }
  })

  it('refuses requests from another site, from the http:// origin of the same host, or marked cross-site, before any handler', async () => {
    for (const origin of ['https://evil.localhost:7443', 'http://qed.localhost:7443', 'https://qed.localhost:7444', 'null']) {
      const a = await call('POST', '/api/auth/passkey/login/begin', { origin, body: {} })
      expect(a.status, origin).toBe(403)
      expect(a.json.error.code).toBe('cross_site')
    }
    expect((await call('POST', '/api/auth/passkey/login/begin', { site: 'cross-site', body: {} })).status).toBe(403)
    expect((await call('POST', '/api/auth/passkey/login/begin', { site: 'same-origin', body: {} })).status).toBe(200)
  })

  it('needs the session\'s CSRF token on every change: missing or wrong is refused and changes nothing; its own is accepted', async () => {
    const f = await signUp('bhavna', new SoftAuthenticator({ origin: ORIGIN }))
    const cookie = pair(f), csrf = String(f.json.csrf)
    const missing = await call('POST', '/api/household', { cookie, body: {} })
    const wrong = await call('POST', '/api/household', { cookie, csrf: `${csrf}x`, body: {} })
    expect([missing.status, wrong.status]).toEqual([403, 403])
    expect([missing.json.error.code, wrong.json.error.code]).toEqual(['csrf', 'csrf'])
    expect((await call('GET', '/api/session', { cookie })).json.setup).toBe(false)
    expect((await call('POST', '/api/household', { cookie, csrf, body: {} })).status).toBe(200)
    expect((await call('GET', '/api/session', { cookie })).json.setup).toBe(true)
  })

  it('refuses a passkey made at another origin, at the http:// origin of the same host, or for another relying-party id', async () => {
    for (const [handle, auth, tamper] of [
      ['chitra', new SoftAuthenticator({ origin: 'https://evil.localhost:7443' }), undefined],
      ['deepa', new SoftAuthenticator({ origin: 'http://qed.localhost:7443' }), undefined],
      ['esha', new SoftAuthenticator({ origin: ORIGIN }), (o: any) => ({ ...o, rp: { ...o.rp, id: 'evil.localhost' } })],
      ['farah', new SoftAuthenticator({ origin: 'https://localhost:7443' }), (o: any) => ({ ...o, rp: { ...o.rp, id: 'localhost' } })],
    ] as const) {
      const f = await signUp(handle, auth, tamper)
      expect(f.status, handle).toBe(401)
      expect(f.json.error.code).toBe('passkey_failed')
      expect(setCookie(f)).toBe('')
    }
  })

  it('does not read the local build\'s cookie name under HTTPS', async () => {
    const f = await signUp('gauri', new SoftAuthenticator({ origin: ORIGIN }))
    const token = pair(f).split('=')[1]!
    expect((await call('GET', '/api/security', { cookie: `__Host-qed_session=${token}` })).status).toBe(200)
    expect((await call('GET', '/api/security', { cookie: `qed_session=${token}` })).status).toBe(401)
  })
})

describe('the local build\'s API is unchanged', () => {
  const PORT = 7432
  let api: ReturnType<typeof startApi>
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'qed-local-config-')); api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_AI_PROVIDER: 'none' })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  it('sets qed_session without Secure, sends no HSTS, and accepts its local origins', async () => {
    const auth = new SoftAuthenticator({ origin: `http://localhost:${PORT}` })
    const post = (path: string, body: unknown) => fetch(`http://localhost:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}` }, body: JSON.stringify(body) })
    const b = await (await post('/api/auth/passkey/signup/begin', { handle: 'hema', displayName: 'Hema' })).json() as { challengeId: string; options: any }
    const f = await post('/api/auth/passkey/signup/finish', { challengeId: b.challengeId, response: auth.create(b.options) })
    expect(f.status).toBe(200)
    expect(f.headers.get('set-cookie')).toMatch(/^qed_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
    expect(f.headers.get('strict-transport-security')).toBeNull()
  })
})
