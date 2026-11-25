/**
 * Sign-in with Google (R14, Priority 1; server/google.ts), tested without Google: ID tokens signed by keys made for the
 * run, and the whole authorization-code flow against a local stand-in issuer (server/oidc-standin.ts) over HTTP.
 *
 *   - The ID token: RS256 only, Google's keys, issuer, audience, expiry, issued-at, this flow's nonce, a subject.
 *   - The flow: state used once, bound to the browser that began; PKCE checked by the issuer; the callback's issuer.
 *   - The identity is Google's issuer and subject. An account is never signed in to, linked or merged by its address.
 *   - A Google session is an ordinary sign-in: it approves nothing, and confirms nothing a passkey must confirm.
 */
import { createHmac, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signUpWithEmail } from './access.ts'
import { login, sessionFor, STEPUP_MS } from './auth.ts'
import { type Db, loadConfig, openDb } from './core.ts'
import { beginGoogle, finishGoogle, type GoogleConfig, googleConfig, GOOGLE_ISSUER, googleIdentities, issuerAcceptable, jwksKeys, pkceChallenge, unlinkGoogle, verifyIdToken } from './google.ts'
import { type StandIn, startOidcStandIn } from './oidc-standin.ts'
import { beginAddPasskey, beginLogin, beginReauth, finishAddPasskey, finishLogin, regenerateRecoveryCodes, type RelyingParty, revokeSession, signOutOtherSessions, strongConfirm } from './passkeys.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const CLIENT = 'qed-test-client.apps.example', SECRET = 'a-test-client-secret', REDIRECT = 'http://localhost:5174/auth/google/callback'
const PW = 'a long and private phrase 7'
let idp: StandIn, G: GoogleConfig
beforeAll(async () => {
  idp = await startOidcStandIn({ clientId: CLIENT, clientSecret: SECRET, redirectUris: [REDIRECT] })
  G = googleConfig({ QED_GOOGLE_CLIENT_ID: CLIENT, QED_GOOGLE_CLIENT_SECRET: SECRET, QED_GOOGLE_ISSUER: idp.issuer, QED_TEST_STACK: '1' }, 'http://localhost:5174', null)!
})
afterAll(async () => { await idp.close() })

/** The browser's part: follow the address QED gives to the issuer, and come back with what the issuer put on the callback. */
async function atIssuer(url: string): Promise<{ code: string; state: string; iss: string | undefined }> {
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const back = new URL(res.headers.get('location')!)
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')!, iss: back.searchParams.get('iss') ?? undefined }
}
/** One whole sign-in with Google, as the person the stand-in currently is. */
async function signInWithGoogle(db: Db, now: number) {
  const b = beginGoogle(db, G, 'signin', null, META.ip, now)
  const cb = await atIssuer(b.url)
  return finishGoogle(db, G, { ...cb, binding: b.binding }, null, META, now)
}
const as = (sub: string, email: string, name = 'Asha Rao', email_verified: unknown = true): void => { idp.user = { sub, email, email_verified, name }; idp.tamper = null }

describe('the configuration', () => {
  it('is off unless both the client id and the client secret are set; one without the other stops the process', () => {
    expect(googleConfig({}, 'https://qed.example', 'https://qed.example')).toBeNull()
    expect(() => googleConfig({ QED_GOOGLE_CLIENT_ID: 'x' }, 'https://qed.example', 'https://qed.example')).toThrow(/together or not at all/)
    expect(() => googleConfig({ QED_GOOGLE_CLIENT_SECRET: 'x' }, 'https://qed.example', 'https://qed.example')).toThrow(/together or not at all/)
    expect(loadConfig({ QED_DB: ':memory:' }).google).toBeNull()
  })
  it('uses Google\'s own endpoints, and sends the browser back to the one configured origin', () => {
    const g = googleConfig({ QED_GOOGLE_CLIENT_ID: 'id', QED_GOOGLE_CLIENT_SECRET: 'secret' }, 'https://qed.example', 'https://qed.example')!
    expect(g).toMatchObject({ issuer: 'https://accounts.google.com', issuers: ['https://accounts.google.com', 'accounts.google.com'], authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token', jwksUri: 'https://www.googleapis.com/oauth2/v3/certs', redirectUri: 'https://qed.example/auth/google/callback', standIn: false })
  })
  it('accepts a stand-in issuer only on an isolated test stack, on this QED installation, with no public origin', () => {
    const base = { QED_GOOGLE_CLIENT_ID: 'id', QED_GOOGLE_CLIENT_SECRET: 'secret', QED_GOOGLE_ISSUER: 'http://127.0.0.1:9999' }
    expect(() => googleConfig(base, 'http://localhost:5174', null)).toThrow(/isolated test stack/)
    expect(() => googleConfig({ ...base, QED_TEST_STACK: '1' }, 'https://qed.example', 'https://qed.example')).toThrow(/isolated test stack/)
    expect(() => googleConfig({ ...base, QED_TEST_STACK: '1', QED_GOOGLE_ISSUER: 'https://evil.example' }, 'http://localhost:5174', null)).toThrow(/on this QED installation/)
    expect(googleConfig({ ...base, QED_TEST_STACK: '1' }, 'http://localhost:5174', null)).toMatchObject({ standIn: true, issuer: 'http://127.0.0.1:9999', issuers: ['http://127.0.0.1:9999'] })
  })
})

describe('the ID token', () => {
  const NOW = Date.UTC(2026, 10, 25, 10, 0)
  const iat = Math.floor(NOW / 1000)
  const good = (): Record<string, unknown> => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1098', email: 'asha@example.in', email_verified: true, iat, exp: iat + 3600, nonce: 'the-nonce' })
  const check = (token: unknown, o: Partial<Parameters<typeof verifyIdToken>[1]> = {}) => verifyIdToken(token, { clientId: CLIENT, issuers: ['https://accounts.google.com', 'accounts.google.com'], nonce: 'the-nonce', now: NOW, keyFor: async (kid) => (kid === idp.kid ? jwkPublic(idp) : undefined), ...o })
  const why = async (p: Promise<unknown>): Promise<string> => p.then(() => 'accepted', (e: { code?: string; why?: string }) => `${e.code}: ${e.why}`)

  it('accepts a token Google\'s key signed for this client, this flow and this moment, in either form of the issuer', async () => {
    expect(await check(idp.sign(good()))).toMatchObject({ sub: '1098', email: 'asha@example.in', email_verified: true })
    expect(await check(idp.sign({ ...good(), iss: 'accounts.google.com' }))).toMatchObject({ sub: '1098' })
    expect(await check(idp.sign({ ...good(), aud: [CLIENT, 'another'], azp: CLIENT }))).toMatchObject({ sub: '1098' })
  })
  it('refuses another algorithm: "none", and an HMAC keyed with the public key', async () => {
    expect(await why(check(idp.sign(good(), { alg: 'none' })))).toBe('google_rejected: algorithm is not RS256')
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: idp.kid })).toString('base64url'), body = Buffer.from(JSON.stringify(good())).toString('base64url')
    const pem = jwkPublic(idp).export({ type: 'spki', format: 'pem' }) as string
    const forged = `${head}.${body}.${createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url')}`
    expect(await why(check(forged))).toBe('google_rejected: algorithm is not RS256')
  })
  it('refuses a token signed by another key, a changed claim, an unknown key id and a key that is too small', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect(await why(check(idp.sign(good(), {}, other)))).toBe('google_rejected: signature')
    const t = idp.sign(good()).split('.')
    const changed = `${t[0]}.${Buffer.from(JSON.stringify({ ...good(), sub: 'someone-else' })).toString('base64url')}.${t[2]}`
    expect(await why(check(changed))).toBe('google_rejected: signature')
    expect(await why(check(idp.sign(good(), { kid: 'not-a-key' })))).toBe('google_rejected: unknown key id')
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 })
    expect(await why(check(idp.sign(good(), {}, small.privateKey), { keyFor: async () => small.publicKey }))).toBe('google_rejected: key is not RSA of 2048 bits or more')
  })
  it('refuses another issuer, another audience, and several audiences without this client as the authorized party', async () => {
    expect(await why(check(idp.sign({ ...good(), iss: 'https://accounts.google.com.evil.example' })))).toBe('google_rejected: issuer')
    expect(await why(check(idp.sign({ ...good(), aud: 'another-client' })))).toBe('google_rejected: audience')
    expect(await why(check(idp.sign({ ...good(), aud: [CLIENT, 'another'] })))).toBe('google_rejected: several audiences without this client as authorized party')
    expect(await why(check(idp.sign({ ...good(), azp: 'another-client' })))).toBe('google_rejected: authorized party')
  })
  it('refuses an expired token, one from the future, one issued long ago, another flow\'s nonce and a missing subject', async () => {
    expect(await why(check(idp.sign({ ...good(), exp: iat - 120 })))).toBe('google_rejected: expired')
    expect(await why(check(idp.sign({ ...good(), iat: iat + 600 })))).toBe('google_rejected: issued in the future')
    expect(await why(check(idp.sign({ ...good(), iat: iat - 3000 })))).toBe('google_rejected: issued too long ago')
    expect(await why(check(idp.sign({ ...good(), nonce: 'another-nonce' })))).toBe('google_rejected: nonce')
    expect(await why(check(idp.sign({ ...good(), nonce: undefined })))).toBe('google_rejected: nonce')
    expect(await why(check(idp.sign({ ...good(), sub: '' })))).toBe('google_rejected: subject')
    expect(await why(check('not.a.token!'))).toBe('google_rejected: not three base64url parts')
    expect(await why(check(undefined))).toBe('google_rejected: not a token')
  })
  it('reads the issuer\'s keys from its JWKS, and asks again for an unknown key id at most once a minute', async () => {
    let reads = 0
    const keyFor = jwksKeys(`${idp.issuer}/jwks`, (async (...a: Parameters<typeof fetch>) => { reads++; return fetch(...a) }) as typeof fetch)
    expect(await check(idp.sign(good()), { keyFor })).toMatchObject({ sub: '1098' })
    expect(reads).toBe(1)
    await check(idp.sign(good()), { keyFor })
    for (let i = 0; i < 5; i++) expect(await why(check(idp.sign(good(), { kid: `made-up-${i}` }), { keyFor }))).toBe('google_rejected: unknown key id')
    expect(reads).toBe(1)
  })
  it('PKCE: the challenge is the SHA-256 of the verifier (RFC 7636, appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
const jwkPublic = (s: StandIn): KeyObject => createPublicKey(s.privateKey)

describe('the flow, against the stand-in issuer', () => {
  const T0 = Date.now()
  it('sends state, nonce and a PKCE S256 challenge; the code is exchanged with the secret and the verifier; a new account opens', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'Asha.Rao@Example.in')
    const b = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const q = new URL(b.url).searchParams
    expect(Object.fromEntries(q)).toMatchObject({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid email profile', code_challenge_method: 'S256', prompt: 'select_account' })
    for (const k of ['state', 'nonce', 'code_challenge']) expect(q.get(k)!.length).toBeGreaterThanOrEqual(43)
    // the database keeps the state only as its SHA-256
    expect(db.get('SELECT 1 x FROM oauth_states WHERE state_hash = ?', q.get('state')!)).toBeUndefined()
    const cb = await atIssuer(b.url)
    const out = await finishGoogle(db, G, { ...cb, binding: b.binding }, null, META, T0)
    expect(out).toMatchObject({ purpose: 'signin', created: true })
    const sent = idp.tokenRequests.at(-1)!
    expect(sent.ok).toBe(true)
    expect(sent.body).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT, client_secret: SECRET, redirect_uri: REDIRECT })
    expect(pkceChallenge(sent.body.code_verifier!)).toBe(q.get('code_challenge'))
    const u = db.get<{ handle: string; display_name: string; pw_hash: string; email: string; email_key: string }>('SELECT handle, display_name, pw_hash, email, email_key FROM users WHERE id = ?', out.personId)!
    expect(u).toEqual({ handle: 'asha.rao', display_name: 'Asha Rao', pw_hash: '!', email: 'Asha.Rao@example.in', email_key: 'asha.rao@example.in' })
    expect(googleIdentities(db, out.personId)).toMatchObject([{ email: 'Asha.Rao@Example.in' }])
    // Google states the address is theirs: it is kept as confirmed
    expect(db.get('SELECT address, verified_at IS NOT NULL v FROM contact_points WHERE person_id = ?', out.personId)).toEqual({ address: 'Asha.Rao@example.in', v: 1 })
    // the state is spent, and its nonce and verifier have left the database
    expect(db.get('SELECT used_at IS NOT NULL used, nonce, verifier FROM oauth_states')).toEqual({ used: 1, nonce: '', verifier: '' })
    // no saved codes are made
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes')!.n).toBe(0)
  })

  it('the same Google account signs in to the same QED account next time; another Google account opens another', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const first = await signInWithGoogle(db, T0), again = await signInWithGoogle(db, T0 + 1000)
    expect(again).toMatchObject({ purpose: 'signin', personId: first.personId })
    expect(again.created).toBeUndefined()
    // the subject names the account, not the address: the same person at Google with a changed address is the same account
    as('g-asha', 'asha.new@example.in')
    expect((await signInWithGoogle(db, T0 + 2000)).personId).toBe(first.personId)
    as('g-ravi', 'ravi@example.in', 'Ravi')
    expect((await signInWithGoogle(db, T0 + 3000)).personId).not.toBe(first.personId)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(2)
  })

  it('a state is used once; one that was never issued, or has expired, finishes nothing', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const b = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const cb = await atIssuer(b.url)
    await finishGoogle(db, G, { ...cb, binding: b.binding }, null, META, T0)
    await expect(finishGoogle(db, G, { ...cb, binding: b.binding }, null, META, T0 + 1)).rejects.toMatchObject({ code: 'google_state' })
    await expect(finishGoogle(db, G, { code: 'x', state: 'a'.repeat(43), iss: G.issuer, binding: b.binding }, null, META, T0 + 2)).rejects.toMatchObject({ code: 'google_state' })
    const late = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const lateCb = await atIssuer(late.url)
    await expect(finishGoogle(db, G, { ...lateCb, binding: late.binding }, null, META, T0 + 10 * 60_000 + 1)).rejects.toMatchObject({ code: 'google_state' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(1)
  })

  it('a callback finished in another browser (no binding cookie, or another flow\'s) signs nobody in: login CSRF', async () => {
    const db = openDb(':memory:')
    as('g-attacker', 'attacker@example.in', 'Attacker')
    // the attacker begins in their own browser and has the victim's browser open the callback
    const theirs = beginGoogle(db, G, 'signin', null, '198.51.100.7', T0)
    const cb = await atIssuer(theirs.url)
    await expect(finishGoogle(db, G, { ...cb, binding: undefined }, null, META, T0)).rejects.toMatchObject({ code: 'google_state' })
    const victims = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const again = await atIssuer(beginGoogle(db, G, 'signin', null, '198.51.100.7', T0).url)
    await expect(finishGoogle(db, G, { ...again, binding: victims.binding }, null, META, T0)).rejects.toMatchObject({ code: 'google_state' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n).toBe(0)
  })

  it('a callback that names another issuer, or none, is refused before the code is sent anywhere (RFC 9207)', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const before = idp.tokenRequests.length
    const b = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const cb = await atIssuer(b.url)
    await expect(finishGoogle(db, G, { ...cb, iss: 'https://evil.example', binding: b.binding }, null, META, T0)).rejects.toMatchObject({ code: 'google_state' })
    const b2 = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const cb2 = await atIssuer(b2.url)
    await expect(finishGoogle(db, G, { code: cb2.code, state: cb2.state, binding: b2.binding }, null, META, T0)).rejects.toMatchObject({ code: 'google_state' })
    expect(idp.tokenRequests.length).toBe(before)
  })

  describe('the callback\'s iss with Google\'s own issuer configured (RFC 9207)', () => {
    // Google's issuer, with the stand-in's endpoints and a token signed by the stand-in as if Google had issued it
    let GG: GoogleConfig
    beforeAll(() => { GG = { ...G, issuer: GOOGLE_ISSUER, issuers: [GOOGLE_ISSUER, 'accounts.google.com'], standIn: false } })
    const run = async (iss: string | null | undefined) => {
      const db = openDb(':memory:')
      as('g-asha', 'asha@example.in')
      idp.tamper = { claims: { iss: GOOGLE_ISSUER } }
      const b = beginGoogle(db, GG, 'signin', null, META.ip, T0)
      const cb = await atIssuer(b.url)
      return finishGoogle(db, GG, { code: cb.code, state: cb.state, ...(iss === undefined ? {} : { iss }), binding: b.binding }, null, META, T0)
    }
    it('present and matching: accepted', async () => { expect(await run(GOOGLE_ISSUER)).toMatchObject({ purpose: 'signin', created: true }) })
    it('present and wrong: refused before the code is sent anywhere', async () => {
      const before = idp.tokenRequests.length
      await expect(run('https://evil.example')).rejects.toMatchObject({ code: 'google_state' })
      await expect(run('accounts.google.com')).rejects.toMatchObject({ code: 'google_state' })
      expect(idp.tokenRequests.length).toBe(before)
    })
    it('absent (not sent, null or empty): accepted, because the one configured issuer is Google\'s', async () => {
      for (const absent of [undefined, null, '']) expect(await run(absent)).toMatchObject({ purpose: 'signin' })
    })
    it('absent is never excused for any other issuer, the stand-in included; the ID token\'s own iss is still checked', async () => {
      expect(issuerAcceptable(undefined, G)).toBe(false)
      expect(issuerAcceptable(undefined, { issuer: 'https://login.example' })).toBe(false)
      expect(issuerAcceptable(undefined, { issuer: GOOGLE_ISSUER })).toBe(true)
      expect(issuerAcceptable(['https://accounts.google.com'], { issuer: GOOGLE_ISSUER })).toBe(false)
      const db = openDb(':memory:')
      as('g-asha', 'asha@example.in')
      idp.tamper = { claims: { iss: 'https://evil.example' } }
      const b = beginGoogle(db, GG, 'signin', null, META.ip, T0)
      const cb = await atIssuer(b.url)
      await expect(finishGoogle(db, GG, { code: cb.code, state: cb.state, binding: b.binding }, null, META, T0)).rejects.toMatchObject({ code: 'google_rejected' })
    })
  })

  it('the issuer refuses a code sent with another verifier, the wrong secret or a second time (PKCE and single use at the stand-in)', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const b = beginGoogle(db, G, 'signin', null, META.ip, T0)
    const cb = await atIssuer(b.url)
    const post = (body: Record<string, string>) => fetch(`${idp.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }).then((r) => r.status)
    const base = { grant_type: 'authorization_code', code: cb.code, client_id: CLIENT, client_secret: SECRET, redirect_uri: REDIRECT }
    expect(await post({ ...base, client_secret: 'wrong', code_verifier: 'x'.repeat(43) })).toBe(400)
    expect(await post({ ...base, code_verifier: 'not-the-verifier-of-this-flow-0123456789abc' })).toBe(400)
    // the code was spent by the refused exchange: QED's own exchange now fails, and nothing is opened
    await expect(finishGoogle(db, G, { ...cb, binding: b.binding }, null, META, T0)).rejects.toMatchObject({ code: 'google_failed', status: 502 })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(0)
  })

  it('refuses, and records why, a token for another client, from another issuer, with another nonce, stale, or signed by another key', async () => {
    const db = openDb(':memory:')
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const now = Math.floor(Date.now() / 1000)
    const cases: [NonNullable<StandIn['tamper']>, string][] = [
      [{ claims: { aud: 'another-client', azp: 'another-client' } }, 'audience'], [{ claims: { iss: 'https://accounts.google.com' } }, 'issuer'], [{ claims: { nonce: 'replayed' } }, 'nonce'],
      [{ claims: { exp: now - 600, iat: now - 4200 } }, 'expired'], [{ key: other }, 'signature'], [{ header: { alg: 'none' } }, 'algorithm is not RS256'],
    ]
    for (const [tamper, why] of cases) {
      as('g-asha', 'asha@example.in'); idp.tamper = tamper
      await expect(signInWithGoogle(db, Date.now())).rejects.toMatchObject({ code: 'google_rejected', status: 401 })
      expect(db.get<{ detail_json: string }>(`SELECT detail_json FROM audit WHERE action = 'google.rejected' ORDER BY ts DESC, rowid DESC LIMIT 1`)!.detail_json).toContain(why)
    }
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')!.n).toBe(0)
  })

  it('refuses a Google account whose address Google has not confirmed: false, missing, or the word "true"', async () => {
    const db = openDb(':memory:')
    for (const v of [false, undefined, 'true', 1]) {
      as('g-unverified', 'someone@example.in', 'Someone'); idp.user.email_verified = v
      await expect(signInWithGoogle(db, Date.now())).rejects.toMatchObject({ code: 'google_email_unverified', status: 403 })
    }
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(0)
  })
})

describe('an address alone links nothing', () => {
  const T0 = Date.now()
  it('a Google account with the address of an existing account does not sign in to it: it opens a separate account, and the existing one is untouched', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW, displayName: 'Meera Nair' }, META, T0)
    const before = db.get('SELECT * FROM users WHERE id = ?', owner.personId)
    as('g-someone', 'Meera@Example.in', 'Meera Nair')
    const g = await signInWithGoogle(db, T0 + 1000)
    expect(g.personId).not.toBe(owner.personId)
    expect(g.created).toBe(true)
    expect(db.get('SELECT * FROM users WHERE id = ?', owner.personId)).toEqual(before)
    expect(googleIdentities(db, owner.personId)).toEqual([])
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND auth_method = ?', owner.personId, 'google')!.n).toBe(0)
    // the owner's password still opens the owner's account, by address and by handle, and never the other one
    expect((await login(db, { handle: 'meera@example.in', password: PW }, META, T0 + 2000)).userId).toBe(owner.personId)
    expect((await login(db, { handle: owner.handle, password: PW }, META, T0 + 3000)).userId).toBe(owner.personId)
    // and the handle the Google account got is its own
    expect(db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', g.personId)!.handle).toMatch(/^meera\.nair\.\d{4}$/)
  }, 60_000)

  it('the other way round: an account opened by Google is not reachable by someone who opens a password account with its address', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const g = await signInWithGoogle(db, T0)
    const other = await signUpWithEmail(db, { email: 'asha@example.in', password: PW }, META, T0 + 1000)
    expect(other.personId).not.toBe(g.personId)
    expect((await login(db, { handle: 'asha@example.in', password: PW }, META, T0 + 2000)).userId).toBe(other.personId)
    as('g-asha', 'asha@example.in')
    expect((await signInWithGoogle(db, T0 + 3000)).personId).toBe(g.personId)
  }, 60_000)
})

describe('a session opened by Google is an ordinary sign-in', () => {
  const T0 = Date.now()
  it('approves nothing and is no passkey confirmation; freshly made, it enrols the first device, and later only after confirming with Google again', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const made = await signInWithGoogle(db, T0)
    const fresh = sessionFor(db, made.session!.token, T0 + 1000)!
    expect(fresh).toMatchObject({ authMethod: 'google', stepUpFresh: false, passwordStepUpFresh: false, googleStepUpFresh: true })
    // nothing to approve with: an approval needs a passkey, and the account has none
    await expect(beginReauth(db, RP, made.personId, 'approval', new Uint8Array(32), { approvalId: 'apr_x', docHash: 'h' }, T0 + 1000)).rejects.toMatchObject({ code: 'passkey_needed' })
    // a later sign-in with Google is not fresh: it enrols nothing until Google is confirmed again
    as('g-asha', 'asha@example.in')
    const later = await signInWithGoogle(db, T0 + 2000)
    const plain = sessionFor(db, later.session!.token, T0 + 3000)!
    expect(plain).toMatchObject({ authMethod: 'google', googleStepUpFresh: false })
    await expect(beginAddPasskey(db, RP, plain, T0 + 3000)).rejects.toMatchObject({ code: 'stepup_required', message: 'Confirm with Google again, then set up your device.' })
    expect(strongConfirm(db, plain, T0 + 3000)).toBe(false)
    const b = beginGoogle(db, G, 'confirm', plain, META.ip, T0 + 4000)
    const out = await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, plain, META, T0 + 4000)
    expect(out).toEqual({ purpose: 'confirm', personId: made.personId })
    const confirmed = sessionFor(db, later.session!.token, T0 + 5000)!
    expect(confirmed).toMatchObject({ googleStepUpFresh: true, stepUpFresh: false })
    expect(sessionFor(db, later.session!.token, T0 + 4000 + STEPUP_MS + 1)).toMatchObject({ googleStepUpFresh: false })
    // the first device: enrolled with full authority and no cool-off, as a password account's first is
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const add = await beginAddPasskey(db, RP, confirmed, T0 + 5000)
    const cred = await finishAddPasskey(db, RP, confirmed, { challengeId: add.challengeId, response: device.create(add.options as never) }, META.ua, T0 + 5000)
    expect(cred).toMatchObject({ authority: 'full' })
    // from now Google confirms nothing on this account: only the passkey does
    const after = sessionFor(db, later.session!.token, T0 + 6000)!
    expect(after.googleStepUpFresh).toBe(true)
    expect(strongConfirm(db, after, T0 + 6000)).toBe(false)
    await expect(beginAddPasskey(db, RP, after, T0 + 6000)).rejects.toMatchObject({ code: 'stepup_required', message: 'Confirm with one of your passkeys first.' })
    expect(() => regenerateRecoveryCodes(db, after, T0 + 6000)).toThrow(/passkeys/)
  })

  it('cannot end a session opened with the device, nor every other session at once: only sessions as weak as itself', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const made = await signInWithGoogle(db, T0)
    const fresh = sessionFor(db, made.session!.token, T0 + 1000)!
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const add = await beginAddPasskey(db, RP, fresh, T0 + 1000)
    await finishAddPasskey(db, RP, fresh, { challengeId: add.challengeId, response: device.create(add.options as never) }, META.ua, T0 + 1000)
    // the owner signs in with the device elsewhere; someone holding the Google account signs in too
    const lb = await beginLogin(db, RP, T0 + 2000)
    const strong = await finishLogin(db, RP, { challengeId: lb.challengeId, response: device.get(lb.options as never) }, META, T0 + 2000)
    as('g-asha', 'asha@example.in')
    const other = await signInWithGoogle(db, T0 + 3000)
    const weak = sessionFor(db, other.session!.token, T0 + 4000)!
    const strongId = sessionFor(db, strong.token, T0 + 4000)!.sessionHash.slice(0, 12)
    expect(() => revokeSession(db, weak, strongId, T0 + 4000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    signOutOtherSessions(db, weak, T0 + 5000)
    expect(sessionFor(db, strong.token, T0 + 6000)).not.toBeNull()
    // the first Google session, as weak as this one, is ended by it
    expect(sessionFor(db, made.session!.token, T0 + 6000)).toBeNull()
  })

  it('"confirm" belongs to the session that asked and to the Google account of that QED account', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const a = await signInWithGoogle(db, T0)
    const sa = sessionFor(db, a.session!.token, T0 + STEPUP_MS + 1000)!
    // another Google account confirms nothing for this one
    const b = beginGoogle(db, G, 'confirm', sa, META.ip, T0 + STEPUP_MS + 1000)
    as('g-ravi', 'ravi@example.in', 'Ravi')
    await expect(finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, sa, META, T0 + STEPUP_MS + 1000)).rejects.toMatchObject({ code: 'google_other_account' })
    // a flow one session began is not finished by another session, or signed out
    as('g-asha', 'asha@example.in')
    const again = await signInWithGoogle(db, T0 + STEPUP_MS + 2000)
    const other = sessionFor(db, again.session!.token, T0 + STEPUP_MS + 3000)!
    const b2 = beginGoogle(db, G, 'confirm', sa, META.ip, T0 + STEPUP_MS + 3000)
    const cb2 = await atIssuer(b2.url)
    await expect(finishGoogle(db, G, { ...cb2, binding: b2.binding }, other, META, T0 + STEPUP_MS + 3000)).rejects.toMatchObject({ code: 'google_state' })
    const b3 = beginGoogle(db, G, 'confirm', sa, META.ip, T0 + STEPUP_MS + 4000)
    await expect(finishGoogle(db, G, { ...(await atIssuer(b3.url)), binding: b3.binding }, null, META, T0 + STEPUP_MS + 4000)).rejects.toMatchObject({ code: 'google_state' })
    expect(sessionFor(db, a.session!.token, T0 + STEPUP_MS + 5000)).toMatchObject({ googleStepUpFresh: false })
    // and a signed-in flow is never finished through the signed-out route
    const b4 = beginGoogle(db, G, 'confirm', sa, META.ip, T0 + STEPUP_MS + 6000)
    await expect(finishGoogle(db, G, { ...(await atIssuer(b4.url)), binding: b4.binding, only: 'signin' }, null, META, T0 + STEPUP_MS + 6000)).rejects.toMatchObject({ code: 'google_state' })
  })
})

describe('adding Google to an account that exists, and removing it', () => {
  const T0 = Date.now()
  it('needs the account\'s strongest confirmation: on a password account with no device, the password typed in the last five minutes', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const stale = sessionFor(db, owner.session.token, T0 + STEPUP_MS + 1000)!
    expect(() => beginGoogle(db, G, 'link', stale, META.ip, T0 + STEPUP_MS + 1000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(() => beginGoogle(db, G, 'link', null, META.ip, T0)).toThrow(expect.objectContaining({ code: 'signed_out' }))
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    as('g-meera', 'another.address@example.in', 'Meera')
    const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
    expect(await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, typed, META, T0 + 2000)).toEqual({ purpose: 'link', personId: owner.personId })
    // the address at Google need not be the account's: the link is the person's own act, not a match
    expect(googleIdentities(db, owner.personId)).toMatchObject([{ email: 'another.address@example.in' }])
    expect(db.get(`SELECT 1 x FROM security_events WHERE person_id = ? AND kind = 'google-linked'`, owner.personId)).toEqual({ x: 1 })
    // from now that Google account signs in to this account
    as('g-meera', 'another.address@example.in', 'Meera')
    expect(await signInWithGoogle(db, T0 + 3000)).toMatchObject({ personId: owner.personId })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n).toBe(1)
  }, 60_000)

  it('F5: on an account that has a password, a fresh Google sign-in confirms nothing and enrols no device: the password is still needed', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    as('g-meera', 'meera@example.in', 'Meera')
    const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
    await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, typed, META, T0 + 2000)
    // a long time later, only Google signs in: the session is fresh by Google, as any Google sign-in is
    const later = T0 + 3000
    as('g-meera', 'meera@example.in', 'Meera')
    const g = await signInWithGoogle(db, later)
    // and the session confirms with Google again (the 'confirm' purpose, open to any account Google signs in to)
    const plain = sessionFor(db, g.session!.token, later + 500)!
    const c = beginGoogle(db, G, 'confirm', plain, META.ip, later + 500)
    await finishGoogle(db, G, { ...(await atIssuer(c.url)), binding: c.binding }, plain, META, later + 600)
    const s = sessionFor(db, g.session!.token, later + 1000)!
    expect(s).toMatchObject({ authMethod: 'google', googleStepUpFresh: true, passwordStepUpFresh: false })
    expect(strongConfirm(db, s, later + 1000)).toBe(false)
    await expect(beginAddPasskey(db, RP, s, later + 1000)).rejects.toMatchObject({ code: 'stepup_required', message: 'Enter your password, then create your passkey.' })
    expect(() => regenerateRecoveryCodes(db, s, later + 1000)).toThrow(/password/)
    // with the password typed again it enrols its first device, as before
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'password' WHERE id_hash = ?`, later + 1500, s.sessionHash)
    const typedAgain = sessionFor(db, g.session!.token, later + 2000)!
    expect(strongConfirm(db, typedAgain, later + 2000)).toBe(true)
    await expect(beginAddPasskey(db, RP, typedAgain, later + 2000)).resolves.toBeTruthy()
  }, 60_000)

  it('a confirmation that lapses while the browser is at Google adds nothing', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    as('g-meera', 'meera@example.in')
    const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
    const cb = await atIssuer(b.url)
    const lapsed = sessionFor(db, owner.session.token, T0 + STEPUP_MS + 2000)!
    await expect(finishGoogle(db, G, { ...cb, binding: b.binding }, lapsed, META, T0 + STEPUP_MS + 2000)).rejects.toMatchObject({ code: 'stepup_required' })
    expect(googleIdentities(db, owner.personId)).toEqual([])
  }, 60_000)

  it('on an account with a device, only the device confirms it: a password or a Google session cannot add Google', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    const device = new SoftAuthenticator({ origin: RP.origins[0]! })
    const add = await beginAddPasskey(db, RP, typed, T0 + 1000)
    await finishAddPasskey(db, RP, typed, { challengeId: add.challengeId, response: device.create(add.options as never) }, META.ua, T0 + 1000)
    // the password session is still inside its five minutes; with a passkey on the account that confirms nothing
    expect(() => beginGoogle(db, G, 'link', sessionFor(db, owner.session.token, T0 + 2000)!, META.ip, T0 + 2000)).toThrow(expect.objectContaining({ code: 'stepup_required', message: 'Confirm with one of your passkeys to add Google sign-in.' }))
  }, 60_000)

  it('a Google account that already signs in to another QED account is not added to this one', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const theirs = await signInWithGoogle(db, T0)
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
    as('g-asha', 'asha@example.in')
    await expect(finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, typed, META, T0 + 2000)).rejects.toMatchObject({ code: 'google_in_use', status: 409 })
    expect(googleIdentities(db, owner.personId)).toEqual([])
    expect(googleIdentities(db, theirs.personId)).toHaveLength(1)
  }, 60_000)

  it('is removed with the same confirmation, never when it is the only way in, and then no longer signs in to the account', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const only = await signInWithGoogle(db, T0)
    const s = sessionFor(db, only.session!.token, T0 + 1000)!
    const [id] = googleIdentities(db, only.personId)
    expect(() => unlinkGoogle(db, s, id!.id, META.ip, T0 + 1000)).toThrow(expect.objectContaining({ code: 'no_way_in' }))
    // an account with a password as well
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    as('g-meera', 'meera@example.in', 'Meera')
    const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
    await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, typed, META, T0 + 1500)
    const linked = googleIdentities(db, owner.personId)[0]!
    expect(() => unlinkGoogle(db, sessionFor(db, owner.session.token, T0 + STEPUP_MS + 5000)!, linked.id, META.ip, T0 + STEPUP_MS + 5000)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(() => unlinkGoogle(db, s, linked.id, META.ip, T0 + 2000)).toThrow(expect.objectContaining({ code: 'not_found' }))
    unlinkGoogle(db, typed, linked.id, META.ip, T0 + 2000)
    expect(googleIdentities(db, owner.personId)).toEqual([])
    // that Google account is a stranger again: it opens an account of its own, not this one
    as('g-meera', 'meera@example.in', 'Meera')
    expect((await signInWithGoogle(db, T0 + 3000)).personId).not.toBe(owner.personId)
  }, 60_000)

  it('F9: removing a linked Google account ends the sessions opened through Google, even when another still signs in; the session that asks stays', async () => {
    const db = openDb(':memory:')
    const owner = await signUpWithEmail(db, { email: 'meera@example.in', password: PW }, META, T0)
    const typed = sessionFor(db, owner.session.token, T0 + 1000)!
    for (const sub of ['g-one', 'g-two']) {
      as(sub, `${sub}@example.in`, 'Meera')
      const b = beginGoogle(db, G, 'link', typed, META.ip, T0 + 1000)
      await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, typed, META, T0 + 1500)
    }
    as('g-two', 'g-two@example.in', 'Meera')
    const viaGoogle = await signInWithGoogle(db, T0 + 2000)
    expect(sessionFor(db, viaGoogle.session!.token, T0 + 2100)).not.toBeNull()
    const one = googleIdentities(db, owner.personId).find((i) => i.email === 'g-one@example.in')!
    unlinkGoogle(db, typed, one.id, META.ip, T0 + 2500)
    expect(sessionFor(db, viaGoogle.session!.token, T0 + 2600)).toBeNull()
    expect(sessionFor(db, owner.session.token, T0 + 2600)).not.toBeNull()
  }, 60_000)

  it('F12: a Google sign-in ends the browser\'s earlier session in the same transaction that opens the new one', async () => {
    const db = openDb(':memory:')
    as('g-asha', 'asha@example.in')
    const first = await signInWithGoogle(db, T0)
    as('g-other', 'other@example.in')
    const b = beginGoogle(db, G, 'signin', null, META.ip, T0 + 1000)
    const out = await finishGoogle(db, G, { ...(await atIssuer(b.url)), binding: b.binding }, null, { ...META, replaces: first.session!.token }, T0 + 1000)
    expect(sessionFor(db, first.session!.token, T0 + 1100)).toBeNull()
    expect(sessionFor(db, out.session!.token, T0 + 1100)).not.toBeNull()
    expect(db.get(`SELECT 1 x FROM audit WHERE action = 'session.replaced-by-sign-in'`)).toBeTruthy()
  }, 60_000)
})
