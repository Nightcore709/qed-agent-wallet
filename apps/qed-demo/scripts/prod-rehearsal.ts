/**
 * The production rehearsal, on this computer only (apps/qed-demo/docs/PRODUCTION.md, section 12).
 *
 *   node scripts/prod-rehearsal.ts [--port 7443] [--dist <built interface folder>] [--out <report.json>] [--keep]
 *
 * It runs the API and the engine with their production settings behind TLS at https://qed.localhost:<port> and checks,
 * with plain HTTPS requests and with a real Chrome holding a virtual passkey authenticator, what can be proved here:
 *
 *   TLS        TLS 1.3 negotiated with a certificate for qed.localhost; TLS 1.1 and plain HTTP get no answer.
 *   Headers    HSTS and the security headers on every kind of response.
 *   Hosts      only qed.localhost:<port> is answered; localhost and 127.0.0.1 are refused (421).
 *   Origins    requests from another site, or from the http:// origin of the same host, are refused (403).
 *   Passkeys   sign-up and sign-in work in the browser at that origin; the server refuses a passkey made at another
 *              origin or for another relying-party id; the browser refuses a relying-party id the origin is not under.
 *   Sessions   the cookie is __Host-qed_session, Secure, HttpOnly, SameSite=Strict, Path=/, host-only; scripts cannot read it.
 *   CSRF       a change without the session's token is refused in the browser; with it, accepted.
 *   Engine     a second engine on the database is refused; after the first is killed, the next starts at once.
 *
 * Nothing leaves this computer. `qed.localhost` resolves to 127.0.0.1 inside Chrome, which treats it as a secure context;
 * the API listens on 127.0.0.1 only. The certificate and key are made at run time in a private temporary folder (mode 700)
 * with openssl and deleted at the end (unless --keep); Chrome trusts that one certificate by its public key
 * (--ignore-certificate-errors-spki-list, honoured only with a profile folder of its own, which is also temporary), so no
 * system trust store is changed. Prices are synthetic (presentation mode: no market-data provider is contacted), there is
 * no vault service and no model. The report holds no token, cookie value or key.
 *
 * Not proved here, by construction: a public certificate authority, DNS, a real domain, a platform's proxy or load
 * balancer, HSTS preload, real phones' passkeys, off-host backups and alerting. PRODUCTION.md lists who must do each.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { SoftAuthenticator } from '../server/softauthn.ts'

const APP = join(import.meta.dirname, '..')
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const PORT = Number(arg('port') ?? 7443)
if (!Number.isInteger(PORT) || PORT < 7400 || PORT > 7499) throw new Error('Use a port from 7400 to 7499 (--port).')
const DIST = arg('dist')
const OUT = arg('out')
const KEEP = process.argv.includes('--keep')
const HOSTNAME = 'qed.localhost'
const HOST = `${HOSTNAME}:${PORT}`
const ORIGIN = `https://${HOST}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------------------------------------ the record
interface Check { id: string; area: string; standard: string; expected: string; observed: string; ok: boolean }
const checks: Check[] = []
function check(id: string, area: string, standard: string, expected: string, observed: string, ok: boolean): void {
  observed = redact(observed)
  checks.push({ id, area, standard, expected, observed, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${area.padEnd(9)} ${expected}  [${observed}]`)
}
/** Tokens never enter the report: a cookie's value and a CSRF token are replaced by their length. */
const redact = (s: string): string => s.replace(/(qed_session=)[^;\s]+/g, (_m, k: string) => `${k}<redacted>`).split(hostname()).join('<this computer>')

// ------------------------------------------------------------------------------------------------ a private folder, a certificate
const work = mkdtempSync(join(tmpdir(), 'qed-prod-rehearsal-')) // mode 700
const certFile = join(work, 'cert.pem'), keyFile = join(work, 'key.pem')
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
const openssl = spawnSync(process.env.QED_OPENSSL ?? 'openssl', ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '1', '-sha256', '-subj', `/CN=${HOSTNAME}`,
  '-addext', `subjectAltName=DNS:${HOSTNAME}`, '-addext', 'extendedKeyUsage=serverAuth'], { input: '', timeout: 20_000, encoding: 'utf8' })
if (openssl.status !== 0 || !existsSync(certFile)) throw new Error(`openssl could not make the certificate: ${openssl.stderr || openssl.error?.message}`)
const cert = readFileSync(certFile)
const x509 = new X509Certificate(cert)
// Chrome's --ignore-certificate-errors-spki-list takes base64(SHA-256(SubjectPublicKeyInfo)).
const spki = createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')

// ------------------------------------------------------------------------------------------------ the services
const db = join(work, 'qed.db')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  QED_DB: db, QED_HOST: '127.0.0.1', QED_API_PORT: String(PORT),
  QED_PUBLIC_ORIGIN: ORIGIN, QED_TLS_CERT_FILE: certFile, QED_TLS_KEY_FILE: keyFile,
  QED_PRESENTATION: '1', QED_AI_PROVIDER: 'none', QED_RAIL_TOKEN_FILE: join(work, 'no-vault-service'),
  ...(DIST ? { QED_WEB_DIST: DIST } : {}),
}
delete env.QED_TEST_STACK; delete env.QED_RP_ID; delete env.QED_WEB_PORT; delete env.QED_TRUST_PROXY_HOPS
const procs: ChildProcess[] = []
const logs: Record<string, string> = {}
function start(name: string, cmd: 'engine' | 'api'): ChildProcess {
  const p = spawn(process.execPath, [join(APP, 'server', 'main.ts'), cmd], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] })
  logs[name] = ''
  p.stdout!.on('data', (b: Buffer) => { logs[name] += b.toString() })
  p.stderr!.on('data', (b: Buffer) => { logs[name] += b.toString() })
  procs.push(p)
  return p
}
const exited = (p: ChildProcess, ms: number): Promise<number | null> => new Promise((r) => {
  if (p.exitCode !== null || p.signalCode !== null) return r(p.exitCode)
  const t = setTimeout(() => r(null), ms); p.once('exit', (code) => { clearTimeout(t); r(code) })
})

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, any>; protocol: string | null; authorized: boolean }
/** One HTTPS request to the API on 127.0.0.1, with SNI and Host of qed.localhost and the rehearsal's certificate pinned. */
function call(method: string, path: string, o: { host?: string; origin?: string | null; cookie?: string; csrf?: string; body?: unknown; maxVersion?: 'TLSv1.1' } = {}): Promise<Answer> {
  const body = o.body === undefined ? undefined : JSON.stringify(o.body)
  const headers: Record<string, string> = { host: o.host ?? HOST }
  if (o.origin !== null && (o.origin || method !== 'GET')) headers.origin = o.origin ?? ORIGIN
  if (o.cookie) headers.cookie = o.cookie
  if (o.csrf) headers['x-qed-csrf'] = o.csrf
  if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)) }
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1', port: PORT, servername: HOSTNAME, ca: cert, method, path, headers, agent: new Agent({ keepAlive: false }),
      ...(o.maxVersion ? { minVersion: 'TLSv1', maxVersion: o.maxVersion, ciphers: 'DEFAULT@SECLEVEL=0' } : {}),
    }, (res) => {
      let text = ''
      res.on('data', (c: Buffer) => { text += c.toString() })
      res.on('end', () => {
        let json: Record<string, any> = {}
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        const sock = res.socket as unknown as { getProtocol?: () => string | null; authorized?: boolean }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, protocol: sock.getProtocol?.() ?? null, authorized: !!sock.authorized })
      })
    })
    r.setTimeout(10_000, () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}
async function healthy(ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
    try { if ((await call('GET', '/api/health')).status === 200) return true } catch { /* not up yet */ }
  }
  return false
}

let failed = false
const browserInfo: Record<string, unknown> = {}
try {
  const engine = start('engine', 'engine')
  await sleep(900) // the engine creates the database first
  start('api', 'api')
  if (!(await healthy(30_000))) throw new Error(`The API did not answer healthy over TLS within 30 s.\n${redact(logs.api ?? '')}\n${redact(logs.engine ?? '')}`)

  // ---------------------------------------------------------------------------------------------- TLS
  const h = await call('GET', '/api/health')
  check('T1', 'TLS', 'ASVS 5.0 12.1.1, 12.2.1', 'TLS 1.3 (1.2 at least) with a certificate verified for qed.localhost', `${h.protocol}; verified ${h.authorized}; subject ${x509.subject.replace(/\n/g, ' ')}; SAN ${x509.subjectAltName}`, (h.protocol === 'TLSv1.3' || h.protocol === 'TLSv1.2') && h.authorized)
  const old = await call('GET', '/api/health', { maxVersion: 'TLSv1.1' }).then((a) => `answered ${a.status} over ${a.protocol}`, (e: NodeJS.ErrnoException) => `refused: ${e.code ?? e.message}`)
  check('T2', 'TLS', 'ASVS 5.0 12.1.1', 'a client limited to TLS 1.1 gets no answer', old, old.startsWith('refused'))
  const plain = await new Promise<string>((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/health', headers: { host: HOST } }, (res) => resolve(`answered ${res.statusCode}`))
    r.setTimeout(5_000, () => r.destroy(new Error('timeout'))); r.on('error', (e: NodeJS.ErrnoException) => resolve(`no answer: ${e.code ?? e.message}`)); r.end()
  })
  check('T3', 'TLS', 'ASVS 5.0 12.2.1', 'plain HTTP to the API gets no answer', plain, plain.startsWith('no answer'))

  // ---------------------------------------------------------------------------------------------- headers
  const want: Record<string, RegExp> = {
    'strict-transport-security': /^max-age=31536000; includeSubDomains$/,
    'content-security-policy': /default-src 'self'.*frame-ancestors 'none'.*object-src 'none'/,
    'x-content-type-options': /^nosniff$/, 'x-frame-options': /^DENY$/, 'referrer-policy': /^no-referrer$/,
    'cross-origin-opener-policy': /^same-origin$/, 'cross-origin-resource-policy': /^same-origin$/, 'permissions-policy': /camera=\(\)/,
  }
  const kinds: [string, Answer][] = [
    ['health', h],
    ['refused host', await call('GET', '/api/health', { host: `localhost:${PORT}` })],
    ['missing route', await call('GET', '/api/nothing-here')],
    ['interface', await call('GET', '/')],
  ]
  const missing = kinds.flatMap(([k, a]) => Object.entries(want).filter(([n, re]) => !re.test(String(a.headers[n] ?? ''))).map(([n]) => `${k}: ${n}`))
  check('H1', 'headers', 'ASVS 5.0 3.4.1 (HSTS), 3.4.3 (CSP), 3.4.4, 3.4.5, 3.4.6, 3.4.8 (COOP)', 'HSTS (1 year, subdomains) and CSP, nosniff, DENY, no-referrer, COOP, CORP, Permissions-Policy on every kind of response', missing.length ? `missing: ${missing.join('; ')}` : `all present on: ${kinds.map(([k, a]) => `${k} ${a.status}`).join(', ')}`, missing.length === 0)

  // ---------------------------------------------------------------------------------------------- hosts and origins
  const hosts = await Promise.all([`localhost:${PORT}`, `127.0.0.1:${PORT}`, 'qed.localhost', 'evil.localhost:' + PORT].map(async (hh) => [hh, (await call('GET', '/api/session', { host: hh })).status] as const))
  check('O1', 'hosts', 'DNS rebinding defence (Host allowlist); no ASVS 5.0 row names it', 'only qed.localhost:<port> is answered; other Host names get 421', hosts.map(([hh, s]) => `${hh} ${s}`).join(', '), hosts.every(([, s]) => s === 421))
  const origins = await Promise.all([`https://evil.localhost:${PORT}`, `http://${HOST}`, `https://${HOSTNAME}:${PORT + 1}`].map(async (o) => [o, (await call('POST', '/api/auth/passkey/login/begin', { origin: o, body: {} })).status] as const))
  const same = await call('POST', '/api/auth/passkey/login/begin', { body: {} })
  check('O2', 'origins', 'ASVS 5.0 3.5.1 (cross-origin requests validated), 3.5.8 (Sec-Fetch-*)', 'requests from another site, the http:// origin of the same host or another port are refused (403); the origin itself is accepted', `${origins.map(([o, s]) => `${o} ${s}`).join(', ')}; ${ORIGIN} ${same.status}`, origins.every(([, s]) => s === 403) && same.status === 200)

  // ---------------------------------------------------------------------------------------------- the server's relying-party checks
  const forged = async (handle: string, auth: SoftAuthenticator, rpId?: string): Promise<number> => {
    const b = await call('POST', '/api/auth/passkey/signup/begin', { body: { handle, displayName: handle } })
    const options = rpId ? { ...b.json.options, rp: { ...b.json.options.rp, id: rpId } } : b.json.options
    return (await call('POST', '/api/auth/passkey/signup/finish', { body: { challengeId: b.json.challengeId, response: auth.create(options) } })).status
  }
  const otherOrigin = await forged('forgedorigin', new SoftAuthenticator({ origin: `https://evil.localhost:${PORT}` }))
  const httpOrigin = await forged('forgedscheme', new SoftAuthenticator({ origin: `http://${HOST}` }))
  const otherRp = await forged('forgedrpid', new SoftAuthenticator({ origin: ORIGIN }), 'localhost')
  check('W1', 'passkeys', 'W3C WebAuthn Level 3 §7.1 (origin and rpIdHash checks); NIST SP 800-63B-4 §3.2.5 (phishing resistance)', 'the server refuses a passkey made at another origin, at http:// or for another relying-party id (401)', `another origin ${otherOrigin}, http:// origin ${httpOrigin}, rp id "localhost" ${otherRp}`, otherOrigin === 401 && httpOrigin === 401 && otherRp === 401)

  // ---------------------------------------------------------------------------------------------- a real browser
  const profile = join(work, 'chrome-profile')
  mkdirSync(profile, { mode: 0o700 })
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, ignoreHTTPSErrors: false, args: [`--ignore-certificate-errors-spki-list=${spki}`], viewport: { width: 1280, height: 800 } })
  try {
    const page = context.pages()[0] ?? await context.newPage()
    const consoleErrors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
    await page.addInitScript(() => { const w = window as unknown as { cspViolations: string[] }; w.cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => w.cspViolations.push(e.violatedDirective)) })
    const setCookies: string[] = []
    page.on('response', async (r) => { const v = await r.headerValue('set-cookie').catch(() => null); if (v) setCookies.push(v) })
    const nav = await page.goto(`${ORIGIN}/api/health`)
    const sec = await nav?.securityDetails()
    const ctx = await page.evaluate(() => ({ secure: window.isSecureContext, origin: location.origin, webauthn: typeof PublicKeyCredential !== 'undefined' }))
    browserInfo.chrome = context.browser()?.version() ?? null
    check('B1', 'browser', 'W3C Secure Contexts; W3C WebAuthn Level 3 §5.1.3', `Chrome opens ${ORIGIN} as a secure context over a certificate it trusts`, `status ${nav?.status()}; secure context ${ctx.secure}; origin ${ctx.origin}; ${sec?.protocol ?? 'no TLS details'}, subject ${sec?.subjectName ?? '?'}`, nav?.status() === 200 && ctx.secure && ctx.origin === ORIGIN && ctx.webauthn)

    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable', { enableUI: false })
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })

    const handle = `rehearsal${randomBytes(3).toString('hex')}`
    const up = await page.evaluate(async (handle) => {
      const PKC = PublicKeyCredential as unknown as { parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions }
      const post = async (path: string, body: unknown, csrf?: string) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-qed-csrf': csrf } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> } }
      const b = await post('/api/auth/passkey/signup/begin', { handle, displayName: 'Rehearsal Owner' })
      if (b.status !== 200) return { stage: 'begin', status: b.status, error: b.json.error, rpId: null, csrf: '' }
      const cred = await navigator.credentials.create({ publicKey: PKC.parseCreationOptionsFromJSON(b.json.options) }) as PublicKeyCredential & { toJSON(): unknown }
      const f = await post('/api/auth/passkey/signup/finish', { challengeId: b.json.challengeId, response: cred.toJSON() })
      return { stage: 'finish', status: f.status, error: f.json.error ?? null, rpId: b.json.options.rp.id as string, csrf: String(f.json.csrf ?? '') }
    }, handle)
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials as { rpId?: string; isResidentCredential: boolean }[]
    check('B2', 'passkeys', 'W3C WebAuthn Level 3 §5.1.3, §7.1; NIST SP 800-63B-4 §3.2.5', 'passkey sign-up in the browser at the origin succeeds; the credential is scoped to qed.localhost', `${up.stage} ${up.status}${up.error ? ` ${JSON.stringify(up.error)}` : ''}; options rp.id ${up.rpId}; authenticator holds ${creds.length} credential(s) for ${creds.map((c) => c.rpId).join(', ')}`, up.status === 200 && up.rpId === HOSTNAME && creds.length === 1 && creds[0]!.rpId === HOSTNAME && creds[0]!.isResidentCredential)

    const jar = await context.cookies(ORIGIN)
    const c = jar.find((x) => x.name === '__Host-qed_session')
    const raw = setCookies.find((s) => s.startsWith('__Host-qed_session=')) ?? ''
    const scriptSees = await page.evaluate(() => document.cookie)
    check('B3', 'session', 'ASVS 5.0 3.3.1 (Secure), 3.3.2 (SameSite), 3.3.3 (__Host-), 3.3.4 (HttpOnly); NIST SP 800-63B-4 §5.1.1', 'the session cookie is __Host-qed_session: Secure, HttpOnly, SameSite=Strict, Path=/, host-only (no Domain); page scripts cannot read it',
      c ? `${c.name}: secure ${c.secure}, httpOnly ${c.httpOnly}, sameSite ${c.sameSite}, path ${c.path}, domain ${c.domain}; header "${redact(raw)}"; document.cookie ${scriptSees ? 'has a value' : 'is empty'}` : `no session cookie; jar: ${jar.map((x) => x.name).join(', ')}`,
      !!c && c.secure && c.httpOnly && c.sameSite === 'Strict' && c.path === '/' && c.domain === HOSTNAME && !/domain=/i.test(raw) && /;\s*Secure/.test(raw) && !scriptSees.includes('qed_session'))

    const csrf = await page.evaluate(async (token) => {
      const post = async (headers: Record<string, string>) => { const r = await fetch('/api/household', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }); return { status: r.status, code: ((await r.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code ?? null } }
      return { none: await post({}), wrong: await post({ 'x-qed-csrf': `${token}x` }), right: await post({ 'x-qed-csrf': token }) }
    }, up.csrf)
    check('B4', 'CSRF', 'ASVS 5.0 3.5.1 (anti-forgery token), 3.3.2 (SameSite)', 'a change sent by the page without the session\'s token, or with a wrong one, is refused (403 csrf); with it, accepted', `none ${csrf.none.status} ${csrf.none.code}; wrong ${csrf.wrong.status} ${csrf.wrong.code}; right ${csrf.right.status}`, csrf.none.status === 403 && csrf.wrong.status === 403 && csrf.right.status === 200)

    const back = await page.evaluate(async (token) => {
      const PKC = PublicKeyCredential as unknown as { parseRequestOptionsFromJSON(o: unknown): PublicKeyCredentialRequestOptions }
      const post = async (path: string, body: unknown, csrf?: string) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-qed-csrf': csrf } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> } }
      const out = await post('/api/auth/logout', {}, token)
      const after = (await (await fetch('/api/session')).json()) as { authenticated: boolean }
      const b = await post('/api/auth/passkey/login/begin', {})
      const cred = await navigator.credentials.get({ publicKey: PKC.parseRequestOptionsFromJSON(b.json.options) }) as PublicKeyCredential & { toJSON(): unknown }
      const f = await post('/api/auth/passkey/login/finish', { challengeId: b.json.challengeId, response: cred.toJSON() })
      const s = (await (await fetch('/api/session')).json()) as { authenticated: boolean; authMethod?: string }
      return { logout: out.status, signedOutAfter: !after.authenticated, login: f.status, authenticated: s.authenticated, method: s.authMethod ?? null }
    }, up.csrf)
    check('B5', 'passkeys', 'ASVS 5.0 7.4.1 (logout ends the session), 7.2.4 (new token on authentication); W3C WebAuthn Level 3 §5.1.4, §7.2', 'sign-out ends the session; passkey sign-in at the origin opens a new one', `logout ${back.logout}, signed out after ${back.signedOutAfter}; sign-in ${back.login}, authenticated ${back.authenticated} by ${back.method}`, back.logout === 200 && back.signedOutAfter && back.login === 200 && back.authenticated && back.method === 'passkey')

    const scoped = await page.evaluate(async () => {
      try {
        await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32), rp: { id: 'evil.localhost', name: 'Not QED' }, user: { id: new Uint8Array(16), name: 'x', displayName: 'x' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
        return 'created'
      } catch (e) { return `${(e as Error).name}` }
    })
    check('B6', 'passkeys', 'W3C WebAuthn Level 3 §5.1.3 (rp.id must be a registrable domain suffix of the origin)', 'from this origin the browser refuses to make a passkey for another relying-party id', scoped, scoped === 'SecurityError')

    if (DIST) {
      const failedLoads: string[] = []
      page.on('response', (r) => { if (r.status() >= 400) failedLoads.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`) })
      consoleErrors.length = 0
      await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' })
      await sleep(800)
      const csp = await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)
      const title = await page.title()
      check('B7', 'browser', 'ASVS 5.0 3.4.3 (CSP)', 'the built interface loads at the origin with no Content-Security-Policy violation and no console error', `title "${title}"; CSP violations ${csp.length ? csp.join(', ') : 'none'}; console errors ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}; failed loads ${failedLoads.length ? failedLoads.join(', ') : 'none'}`, csp.length === 0 && consoleErrors.length === 0)
    }
  } finally { await context.close() }

  // ---------------------------------------------------------------------------------------------- one engine
  const second = start('second engine', 'engine')
  const code = await exited(second, 15_000)
  const said = ((logs['second engine'] ?? '').match(/Another engine holds this database's engine lock[^\n]*/)?.[0] ?? (logs['second engine'] ?? '').trim()).split(work).join('<temporary>').slice(0, 200)
  check('E1', 'engine', 'ADR-0013; ASVS 5.0 15.4.2 (atomic check and act), 2.3.4 (locking); CSF 2.0 PR.IR-03', 'a second engine on the same database is refused and exits', `exit ${code}; "${said}"`, code !== null && code !== 0 && /Another engine holds this database's engine lock/.test(logs['second engine'] ?? ''))
  engine.kill('SIGKILL')
  await exited(engine, 5_000)
  const t0 = Date.now()
  const third = start('next engine', 'engine')
  let up2 = false
  for (const until = Date.now() + 15_000; Date.now() < until && !up2; await sleep(200)) {
    const s = await call('GET', '/api/health').catch(() => null)
    up2 = s?.status === 200 && s.json.engine?.pid === third.pid
  }
  check('E2', 'engine', 'ADR-0013; CSF 2.0 PR.IR-03, RC.RP-05', 'after the engine is killed outright, the next engine starts at once (the operating system released the lock) and health names it', `${up2 ? `healthy with pid ${third.pid}` : 'not healthy'} ${Date.now() - t0} ms after the kill`, up2)
} catch (e) {
  failed = true
  console.error(`The rehearsal stopped: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}`)
} finally {
  for (const p of procs) { if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM') }
  await Promise.all(procs.map((p) => exited(p, 5_000)))
  if (!KEEP) rmSync(work, { recursive: true, force: true })
}

const passed = checks.filter((c) => c.ok).length
const report = {
  rehearsal: 'production settings on this computer (scripts/prod-rehearsal.ts)', when: new Date().toISOString(), origin: ORIGIN,
  node: process.version, chrome: browserInfo.chrome ?? null, openssl: spawnSync(process.env.QED_OPENSSL ?? 'openssl', ['version'], { encoding: 'utf8' }).stdout.trim(),
  certificate: { subject: x509.subject, subjectAltName: x509.subjectAltName, validTo: x509.validTo, keyType: 'EC P-256', made: 'at run time in a private temporary folder, deleted afterwards' },
  settings: { QED_PUBLIC_ORIGIN: ORIGIN, QED_TLS_CERT_FILE: '<temporary>', QED_TLS_KEY_FILE: '<temporary>', QED_PRESENTATION: '1', QED_AI_PROVIDER: 'none', vaultService: 'none' },
  checks, passed, failed: checks.length - passed, stoppedEarly: failed,
  notProvedHere: ['a public certificate authority and certificate renewal', 'DNS and a real domain', 'a platform proxy or load balancer (QED_TRUST_PROXY_HOPS)', 'HSTS preload', 'passkeys on real phones and computers', 'off-host encrypted backups and their restore on another host', 'alerting by an independent monitor'],
}
if (OUT) { writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`); console.log(`Report: ${OUT}`) }
console.log(`${passed} of ${checks.length} checks passed${failed ? '; the rehearsal stopped early' : ''}. Temporary folder ${KEEP ? `kept: ${work}` : 'deleted'}.`)
process.exit(failed || passed !== checks.length ? 1 : 0)
