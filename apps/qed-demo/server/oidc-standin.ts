/**
 * Test support: a local stand-in for an OpenID Connect issuer, so that sign-in with Google (server/google.ts) is tested
 * end to end without Google: the authorization endpoint, the token endpoint (which checks the client secret, the redirect
 * address and PKCE, and uses each code once) and the keys (JWKS). It signs ID tokens with an RSA key made for the run.
 *
 * It is not Google and nothing presents it as Google: QED uses it only on an isolated test stack (QED_TEST_STACK=1, no
 * public origin; google.ts googleConfig), and the interface then labels the button as a stand-in. Used by tests only.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

export interface StandInUser { sub: string; email: string; email_verified: unknown; name?: string }
export interface StandIn {
  issuer: string
  port: number
  /** Who the next sign-in is: the "Google account" the person chooses. */
  user: StandInUser
  /** Changes to what the next ID token says, for the refusals: wrong audience, another issuer, a stale token, another nonce... */
  tamper: { claims?: Record<string, unknown>; header?: Record<string, unknown>; key?: KeyObject; omitIss?: boolean; iss?: string } | null
  /** False: the authorization endpoint shows a page with a button to press (the browser journeys). True: it redirects at once. */
  auto: boolean
  /** An ID token signed by this issuer (or by `key`), for tests of the verification alone. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>, key?: KeyObject): string
  jwks(): { keys: Record<string, unknown>[] }
  privateKey: KeyObject
  kid: string
  /** What the token endpoint was sent, newest last: tests read that the secret and the verifier arrived, and codes were single-use. */
  tokenRequests: { ok: boolean; why?: string; body: Record<string, string> }[]
  close(): Promise<void>
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f1ea;color:#1c1a17}main{max-width:420px;padding:28px;border:1px solid #c9c2b4;border-radius:12px;background:#fff}a.go{display:inline-block;margin-top:12px;padding:10px 16px;border-radius:8px;background:#1c1a17;color:#fff;text-decoration:none}p.t{font-size:13px;color:#6b665c}</style></head><body><main>${body}</main></body></html>`
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export async function startOidcStandIn(o: { port?: number; clientId: string; clientSecret: string; redirectUris: string[] }): Promise<StandIn> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = `standin-${randomBytes(4).toString('hex')}`
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; user: StandInUser; at: number; used: boolean }>()
  const pending = new Map<string, { redirectUri: string; state: string; challenge: string; nonce: string }>()
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}, key: KeyObject = privateKey): string => {
    const h = { alg: 'RS256', typ: 'JWT', kid, ...header }
    const head = `${b64u(JSON.stringify(h))}.${b64u(JSON.stringify(claims))}`
    if (h.alg === 'none') return `${head}.`
    return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`
  }
  const st: StandIn = {
    issuer: '', port: 0, user: { sub: 'standin-user-1', email: 'person@example.in', email_verified: true, name: 'Stand-in Person' }, tamper: null, auto: true,
    sign, jwks: () => ({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' }] }), privateKey, kid, tokenRequests: [],
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }),
  }
  const issue = (tx: { redirectUri: string; state: string; challenge: string; nonce: string }): string => {
    const code = randomBytes(24).toString('base64url')
    codes.set(code, { challenge: tx.challenge, nonce: tx.nonce, redirectUri: tx.redirectUri, user: { ...st.user }, at: Date.now(), used: false })
    const back = new URL(tx.redirectUri)
    back.searchParams.set('code', code); back.searchParams.set('state', tx.state)
    if (!st.tamper?.omitIss) back.searchParams.set('iss', st.tamper?.iss ?? st.issuer)
    return back.toString()
  }
  const readBody = (req: IncomingMessage): Promise<string> => new Promise((done) => { let b = ''; req.on('data', (c: Buffer) => { if (b.length < 16384) b += c.toString('utf8') }); req.on('end', () => done(b)) })
  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', st.issuer)
      const send = (status: number, body: unknown, type = 'application/json'): void => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
      if (req.method === 'GET' && u.pathname === '/jwks') return send(200, st.jwks())
      if (req.method === 'GET' && u.pathname === '/authorize') {
        const q = u.searchParams
        const redirectUri = q.get('redirect_uri') ?? ''
        if (q.get('client_id') !== o.clientId || !o.redirectUris.includes(redirectUri)) return send(400, page('Stand-in sign-in', '<h1>Refused</h1><p>Unknown client or redirect address.</p>'), 'text/html; charset=utf-8')
        if (q.get('response_type') !== 'code' || !(q.get('scope') ?? '').split(' ').includes('openid') || !q.get('state') || !q.get('nonce') || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(400, page('Stand-in sign-in', '<h1>Refused</h1><p>The request lacks a state, a nonce or a PKCE S256 challenge.</p>'), 'text/html; charset=utf-8')
        const tx = { redirectUri, state: q.get('state')!, challenge: q.get('code_challenge')!, nonce: q.get('nonce')! }
        if (st.auto) { res.writeHead(302, { location: issue(tx), 'cache-control': 'no-store' }); return res.end() }
        const id = randomBytes(12).toString('hex')
        pending.set(id, tx)
        return send(200, page('Stand-in sign-in (test only)', `<p class="t">Stand-in issuer for tests. This is not Google.</p><h1>Choose an account</h1><p>${esc(st.user.name ?? st.user.email)}<br>${esc(st.user.email)}</p><a class="go" href="/continue?tx=${id}">Continue as ${esc(st.user.email)}</a>`), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && u.pathname === '/continue') {
        const tx = pending.get(u.searchParams.get('tx') ?? '')
        if (!tx) return send(400, page('Stand-in sign-in', '<h1>Refused</h1><p>That request is not open.</p>'), 'text/html; charset=utf-8')
        pending.delete(u.searchParams.get('tx')!)
        res.writeHead(302, { location: issue(tx), 'cache-control': 'no-store' }); return res.end()
      }
      if (req.method === 'POST' && u.pathname === '/token') {
        const body = Object.fromEntries(new URLSearchParams(await readBody(req)))
        const refuse = (why: string) => { st.tokenRequests.push({ ok: false, why, body }); send(400, { error: 'invalid_grant', error_description: why }) }
        const c = codes.get(body.code ?? '')
        if (body.grant_type !== 'authorization_code') return refuse('grant type')
        if (body.client_id !== o.clientId || body.client_secret !== o.clientSecret) return refuse('client credentials')
        if (!c || c.used || Date.now() - c.at > 60_000) return refuse('code unknown, used or expired')
        c.used = true
        if (body.redirect_uri !== c.redirectUri) return refuse('redirect address')
        if (!body.code_verifier || createHash('sha256').update(body.code_verifier).digest('base64url') !== c.challenge) return refuse('PKCE verifier')
        const now = Math.floor(Date.now() / 1000)
        const claims = { iss: st.issuer, aud: o.clientId, azp: o.clientId, sub: c.user.sub, email: c.user.email, email_verified: c.user.email_verified, name: c.user.name, iat: now, exp: now + 3600, nonce: c.nonce, ...(st.tamper?.claims ?? {}) }
        st.tokenRequests.push({ ok: true, body })
        return send(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 3600, id_token: sign(claims, st.tamper?.header, st.tamper?.key) })
      }
      send(404, { error: 'not_found' })
    })()
  })
  await new Promise<void>((done) => server.listen(o.port ?? 0, '127.0.0.1', done))
  st.port = (server.address() as { port: number }).port
  st.issuer = `http://127.0.0.1:${st.port}`
  return st
}
