/**
 * Signing in with Google (R14, Priority 1): OpenID Connect, authorization-code flow, with node:crypto and fetch only.
 *
 *   What it is     an ordinary way INTO the account, exactly like a password (shared/access-operations.ts, 'enter'). A
 *                  session it opens looks and prepares. It approves nothing, confirms no change to protections and is
 *                  never authority over the wallet: every rule written for a password session holds for it (api.ts
 *                  weakSession). Confirmed again within five minutes, it unlocks what a password typed again unlocks on
 *                  an account with no passkey: enrolling the first device, and nothing a passkey must confirm.
 *   Enabled        only when QED_GOOGLE_CLIENT_ID and QED_GOOGLE_CLIENT_SECRET are both set (googleConfig). Otherwise the
 *                  routes answer "not found" and the interface renders no button at all.
 *   The flow       state (256 random bits; the database keeps its SHA-256), nonce (in the ID token), PKCE with S256, and
 *                  a binding value in an HttpOnly cookie of the browser that began, so a callback pasted into another
 *                  browser finishes nothing (login CSRF). The issuer named in the callback must be Google's (RFC 9207).
 *                  The code is exchanged at Google's token endpoint with the client secret and the PKCE verifier.
 *   The ID token   RS256 only, verified against Google's published keys (JWKS), with: issuer, audience (and azp when
 *                  there are several), expiry, issued-at, the nonce of this flow, a subject, and email_verified true.
 *   The identity   is Google's issuer and subject. Never the email address: an existing QED account is NEVER signed in
 *                  to, linked or merged because its address matches (the classic-federated-merge and pre-hijacking
 *                  attacks). A Google account QED has not seen opens a new, separate account. To add Google to an
 *                  account that exists, its owner signs in to it and links Google under Security, with that account's
 *                  strongest confirmation.
 *   "Again"        Google does not state when the person last signed in to Google (its discovery document lists no
 *                  auth_time claim; read 25 Nov 2026), so "confirmed with Google again" means a new, complete round trip
 *                  in this browser, with Google's account chooser shown, whose ID token was issued just now. It is not a
 *                  re-entry of the Google password, and QED never says it is.
 *
 * Endpoints (https://accounts.google.com/.well-known/openid-configuration, read 25 Nov 2026) are fixed here, not
 * discovered at run time. On an isolated test stack only (QED_TEST_STACK=1, no public origin) QED_GOOGLE_ISSUER points
 * the flow at a local stand-in issuer (server/oidc-standin.ts), which the interface then labels as a stand-in.
 */
import { createHash, createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { freeHandle } from './access.ts'
import { endPresented, rateLimit, type NewSession, type Session } from './auth.ts'
import type { GoogleConfig } from './google-config.ts'
import { AppError, audit, type Db, newId } from './core.ts'
import { openSession, confirmNeeded, hasPasskey, hasPassword, refuseCoolingOff, securityEvent, strongConfirm } from './passkeys.ts'
import { logAccess } from './records.ts'
import { sha256hex } from './receipts.ts'

export { GOOGLE_CALLBACK_PATH, type GoogleConfig, googleConfig } from './google-config.ts'

const STATE_TTL_MS = 10 * 60_000
/** How far Google's clock and this one may differ (expiry and issued-at). */
const SKEW_MS = 60_000
/** An ID token is used at once, from the token endpoint's answer: one issued longer ago than this is not this flow's. */
const MAX_TOKEN_AGE_MS = 10 * 60_000
const b64u = (b: Buffer): string => b.toString('base64url')
const random = (): string => b64u(randomBytes(32))

// ---------------------------------------------------------------------------------------------- the ID token

/** PKCE, S256 (RFC 7636): the challenge sent with the request is the SHA-256 of the verifier sent with the code. */
export const pkceChallenge = (verifier: string): string => b64u(createHash('sha256').update(verifier).digest())

export interface IdClaims { iss: string; sub: string; aud: string | string[]; azp?: string; exp: number; iat: number; nonce?: string; email?: string; email_verified?: unknown; name?: string }
export type KeyFor = (kid: string) => Promise<KeyObject | undefined>
const rejected = (why: string): AppError => Object.assign(new AppError(401, 'google_rejected', 'That Google sign-in could not be verified, so nothing was changed. Try again.'), { why })
const json = (part: string): unknown => { try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return null } }

/**
 * Verify an ID token, as OpenID Connect Core 3.1.3.7 lists, and return its claims. Every refusal is the same error to the
 * caller; `why` (kept on the error for the audit entry and the tests) names the check that failed.
 */
export async function verifyIdToken(token: unknown, o: { clientId: string; issuers: string[]; nonce: string; now: number; keyFor: KeyFor }): Promise<IdClaims> {
  if (typeof token !== 'string' || token.length > 8192) throw rejected('not a token')
  const parts = token.split('.')
  // (an unsigned token has an empty third part: it is refused below for its algorithm, which is the truer reason)
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]*$/.test(parts[2]!)) throw rejected('not three base64url parts')
  const header = json(parts[0]!) as { alg?: unknown; kid?: unknown } | null
  // RS256 and nothing else: "none", and an HMAC keyed with the public key, are refused before any key is looked up
  if (!header || header.alg !== 'RS256') throw rejected('algorithm is not RS256')
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) throw rejected('no key id')
  const key = await o.keyFor(header.kid)
  if (!key) throw rejected('unknown key id')
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw rejected('key is not RSA of 2048 bits or more')
  if (!verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw rejected('signature')
  const c = json(parts[1]!) as Partial<IdClaims> | null
  if (!c || typeof c !== 'object') throw rejected('claims are not an object')
  if (typeof c.iss !== 'string' || !o.issuers.includes(c.iss)) throw rejected('issuer')
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (!aud.every((a) => typeof a === 'string') || !aud.includes(o.clientId)) throw rejected('audience')
  if (aud.length > 1 && c.azp !== o.clientId) throw rejected('several audiences without this client as authorized party')
  if (c.azp !== undefined && c.azp !== o.clientId) throw rejected('authorized party')
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || o.now >= c.exp * 1000 + SKEW_MS) throw rejected('expired')
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat) || c.iat * 1000 > o.now + SKEW_MS) throw rejected('issued in the future')
  if (o.now - c.iat * 1000 > MAX_TOKEN_AGE_MS) throw rejected('issued too long ago')
  const want = Buffer.from(o.nonce), got = Buffer.from(typeof c.nonce === 'string' ? c.nonce : '')
  if (!o.nonce || want.length !== got.length || !timingSafeEqual(want, got)) throw rejected('nonce')
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw rejected('subject')
  return c as IdClaims
}

/**
 * The issuer's signing keys by key id, from its JWKS. Kept for an hour; a key id not in the kept set makes one new read
 * (keys rotate), at most once a minute, so tokens with made-up key ids cannot make QED ask again and again.
 */
export function jwksKeys(uri: string, fetchImpl: typeof fetch = fetch): KeyFor {
  let keys = new Map<string, KeyObject>(), readAt = 0
  const read = async (now: number): Promise<void> => {
    readAt = now
    const res = await fetchImpl(uri, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`keys: HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > 64 * 1024) throw new Error('keys: answer too large')
    const next = new Map<string, KeyObject>()
    for (const k of ((JSON.parse(text) as { keys?: Record<string, unknown>[] }).keys ?? [])) {
      if (k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use !== undefined && k.use !== 'sig') || (k.alg !== undefined && k.alg !== 'RS256')) continue
      try { next.set(k.kid, createPublicKey({ key: { kty: 'RSA', n: k.n as string, e: k.e as string }, format: 'jwk' })) } catch { /* a malformed key is no key */ }
    }
    if (next.size) keys = next
  }
  return async (kid) => {
    const now = Date.now()
    if ((!keys.has(kid) && now - readAt > 60_000) || now - readAt > 3600_000) { try { await read(now) } catch { /* the kept keys stay; an unknown key id stays unknown */ } }
    return keys.get(kid)
  }
}
const keySets = new Map<string, KeyFor>()
const keysOf = (g: GoogleConfig): KeyFor => { let k = keySets.get(g.jwksUri); if (!k) { k = jwksKeys(g.jwksUri); keySets.set(g.jwksUri, k) } return k }

// ---------------------------------------------------------------------------------------------- the flow

export type Purpose = 'signin' | 'link' | 'confirm'
const stateGone = (): AppError => new AppError(400, 'google_state', 'That sign-in was not started in this browser, was already used, or took longer than ten minutes. Start again from the sign-in page.')

/**
 * Begin: the address to send the browser to, and the binding value for its cookie. 'link' (add Google to the account
 * signed in) and 'confirm' (confirm with Google again) belong to the session that asks, and are finished only by it.
 */
export function beginGoogle(db: Db, g: GoogleConfig, purpose: unknown, s: Session | null, ip: string, now: number): { url: string; binding: string; expiresAt: number } {
  if (purpose !== 'signin' && purpose !== 'link' && purpose !== 'confirm') throw new AppError(400, 'invalid', 'That is not something Google sign-in does here.')
  if (!rateLimit(db, `google-begin:${ip}`, 40, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many sign-in attempts. Wait a few minutes.')
  if (purpose !== 'signin' && !s) throw new AppError(401, 'signed_out', 'Sign in to continue.')
  if (purpose === 'link') {
    // adding a way in needs the account's strongest confirmation now, and again when Google answers (finishGoogle)
    if (!strongConfirm(db, s!, now)) throw confirmNeeded(db, s!, 'add Google sign-in', now)
    refuseCoolingOff(db, s!, 'add Google sign-in', now)
  }
  if (purpose === 'confirm' && !db.get(`SELECT 1 FROM federated_identities WHERE person_id = ? AND provider = 'google' AND removed_at IS NULL`, s!.userId)) throw new AppError(409, 'no_google', 'No Google account signs in to this QED account.')
  db.run('DELETE FROM oauth_states WHERE expires_at < ?', now - 3600_000)
  const state = random(), nonce = random(), verifier = random(), binding = random()
  db.run('INSERT INTO oauth_states (state_hash, purpose, person_id, session_hash, nonce, verifier, binding_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256hex(state), purpose, purpose === 'signin' ? null : s!.userId, purpose === 'signin' ? null : s!.sessionHash, nonce, verifier, sha256hex(binding), now, now + STATE_TTL_MS)
  const q = new URLSearchParams({ response_type: 'code', client_id: g.clientId, redirect_uri: g.redirectUri, scope: 'openid email profile', state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' })
  return { url: `${g.authorizationEndpoint}?${q.toString()}`, binding, expiresAt: now + STATE_TTL_MS }
}

/** Google's own issuer: the one `iss` an absent callback parameter is excused for. */
export const GOOGLE_ISSUER = 'https://accounts.google.com'
/** RFC 9207: present, it must be this issuer; absent (or empty), it is excused only when the one configured issuer is Google's. */
export function issuerAcceptable(iss: unknown, g: Pick<GoogleConfig, 'issuer'>): boolean {
  if (iss === undefined || iss === null || iss === '') return g.issuer === GOOGLE_ISSUER
  return iss === g.issuer
}

/** Exchange the code for the ID token at the issuer's token endpoint (client secret in the body; PKCE verifier beside it). */
async function exchange(g: GoogleConfig, code: string, verifier: string): Promise<unknown> {
  const failed = (): AppError => new AppError(502, 'google_failed', 'Google did not complete the sign-in, so nothing was changed. Try again.')
  let res: Response
  try {
    res = await fetch(g.tokenEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: g.redirectUri, code_verifier: verifier }).toString() })
  } catch { throw failed() }
  if (!res.ok) throw failed()
  const text = await res.text()
  if (text.length > 32 * 1024) throw failed()
  try { return (JSON.parse(text) as { id_token?: unknown }).id_token } catch { throw failed() }
}

export interface GoogleResult { purpose: Purpose; personId: string; session?: NewSession; created?: boolean }

/**
 * Finish: the state (once), the browser's binding, the issuer named in the callback, the code exchanged, the ID token
 * verified; then what the purpose says. Nothing here reads an account by its email address.
 */
export async function finishGoogle(db: Db, g: GoogleConfig, input: { code: unknown; state: unknown; iss?: unknown; binding: string | undefined; only?: 'signin' | 'session' }, s: Session | null, meta: { ip: string; ua: string; replaces?: string }, now: number): Promise<GoogleResult> {
  if (!rateLimit(db, `google-finish:${meta.ip}`, 40, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many sign-in attempts. Wait a few minutes.')
  if (typeof input.state !== 'string' || input.state.length < 20 || input.state.length > 200 || typeof input.code !== 'string' || !input.code || input.code.length > 2048) throw stateGone()
  const h = sha256hex(input.state)
  const row = db.get<{ purpose: Purpose; person_id: string | null; session_hash: string | null; nonce: string; verifier: string; binding_hash: string; expires_at: number; used_at: number | null }>('SELECT * FROM oauth_states WHERE state_hash = ?', h)
  if (!row || row.used_at !== null || now > row.expires_at) throw stateGone()
  // Single use, marked before anything is checked or sent; the nonce and the verifier leave the database with it.
  if (db.run(`UPDATE oauth_states SET used_at = ?, nonce = '', verifier = '' WHERE state_hash = ? AND used_at IS NULL`, now, h).changes !== 1) throw stateGone()
  const have = Buffer.from(sha256hex(input.binding ?? ''), 'hex'), want = Buffer.from(row.binding_hash, 'hex')
  if (!input.binding || have.length !== want.length || !timingSafeEqual(have, want)) throw stateGone()
  // each route finishes only its own kind: the signed-out route a sign-in, the signed-in route what a session began
  if (input.only && (input.only === 'signin') !== (row.purpose === 'signin')) throw stateGone()
  // 'link' and 'confirm' are finished only by the session that began them
  if (row.purpose !== 'signin' && (!s || s.userId !== row.person_id || s.sessionHash !== row.session_hash)) throw stateGone()
  // RFC 9207: a callback that names the issuer that answered must name this one; another one is a mix-up. Where it names
  // none, it is accepted only for Google's own issuer: the RFC lets a client of one authorization server rely on that
  // alone (the state, the browser binding and PKCE still bind the flow, and the ID token's iss is checked below). The
  // stand-in issuer of a test stack is never excused, so the tests keep proving the refusal.
  if (!issuerAcceptable(input.iss, g)) throw stateGone()
  const idToken = await exchange(g, input.code, row.verifier)
  let c: IdClaims
  try { c = await verifyIdToken(idToken, { clientId: g.clientId, issuers: g.issuers, nonce: row.nonce, now, keyFor: keysOf(g) }) }
  catch (e) { audit(db, now, row.person_id, 'system', 'google.rejected', null, { why: (e as { why?: string }).why ?? 'error', purpose: row.purpose }, meta.ip); throw e }
  if (c.email_verified !== true || typeof c.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(c.email) || c.email.length > 254) {
    audit(db, now, row.person_id, 'system', 'google.rejected', null, { why: 'email not verified by Google', purpose: row.purpose }, meta.ip)
    throw new AppError(403, 'google_email_unverified', 'Google has not confirmed the email address of that Google account, so QED cannot use it. Confirm the address with Google, or sign in another way.')
  }
  const issuer = g.issuer, email = c.email
  const known = db.get<{ id: string; person_id: string }>(`SELECT id, person_id FROM federated_identities WHERE issuer = ? AND subject = ? AND removed_at IS NULL`, issuer, c.sub)

  if (row.purpose === 'confirm') {
    if (!known || known.person_id !== s!.userId) throw new AppError(403, 'google_other_account', 'That is not the Google account that signs in to this QED account. Nothing was changed.')
    db.tx(() => {
      db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'google', stepup_credential_id = NULL WHERE id_hash = ? AND revoked_at IS NULL`, now, s!.sessionHash)
      db.run('UPDATE federated_identities SET last_used_at = ? WHERE id = ?', now, known.id)
      audit(db, now, s!.userId, 'owner', 'stepup', s!.userId, { method: 'google' }, meta.ip)
      logAccess(db, s!.userId, 'step-up', { method: 'google', ip: meta.ip }, now)
    })
    return { purpose: 'confirm', personId: s!.userId }
  }

  if (row.purpose === 'link') {
    // read again: the confirmation may have lapsed, or been withdrawn, while the browser was at Google
    const live = db.get<{ stepup_at: number | null; stepup_method: string | null; revoked_at: number | null }>('SELECT stepup_at, stepup_method, revoked_at FROM sessions WHERE id_hash = ?', s!.sessionHash)
    if (!live || live.revoked_at !== null) throw new AppError(401, 'signed_out', 'Sign in to continue.')
    if (!strongConfirm(db, s!, now)) throw confirmNeeded(db, s!, 'add Google sign-in', now)
    refuseCoolingOff(db, s!, 'add Google sign-in', now)
    if (known && known.person_id !== s!.userId) throw new AppError(409, 'google_in_use', 'That Google account already signs in to another QED account, so it was not added to this one.')
    if (!known) db.tx(() => {
      db.run(`INSERT INTO federated_identities (id, person_id, provider, issuer, subject, email, created_at) VALUES (?, ?, 'google', ?, ?, ?, ?)`, newId('fid', now), s!.userId, issuer, c.sub, email, now)
      securityEvent(db, s!.userId, 'google-linked', { email }, now)
      audit(db, now, s!.userId, 'owner', 'google.link', s!.userId, {}, meta.ip)
    })
    return { purpose: 'link', personId: s!.userId }
  }

  // sign in: the account this Google identity already signs in to, or a new one. Never an account found by its address.
  if (known) {
    if (db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', known.person_id)?.kind !== 'person') throw rejected('not a person')
    const session = db.tx(() => {
      endPresented(db, meta.replaces, meta.ip, now) // the browser's earlier session ends in this transaction (F12)
      const x = openSession(db, known.person_id, { ua: meta.ua, method: 'google', credentialId: null, ip: meta.ip }, now)
      db.run('UPDATE federated_identities SET last_used_at = ? WHERE id = ?', now, known.id)
      securityEvent(db, known.person_id, 'signed-in', { method: 'google', device: meta.ua.slice(0, 80) }, now)
      audit(db, now, known.person_id, 'owner', 'login', known.person_id, { method: 'google' }, meta.ip)
      return x
    })
    return { purpose: 'signin', personId: known.person_id, session }
  }
  if (!rateLimit(db, `signup:${meta.ip}`, 20, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many new accounts from this address. Try again later.')
  const personId = newId('usr', now)
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, 60) : ''
  const at = email.lastIndexOf('@'), address = `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`
  const session = db.tx(() => {
    const handle = freeHandle(db, name)
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind, email, email_key) VALUES (?, ?, ?, '!', ?, 'person', ?, ?)`, personId, handle, name || handle, now, address, address.toLowerCase())
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, ?)`, personId, personId, now, personId)
    db.run(`INSERT INTO federated_identities (id, person_id, provider, issuer, subject, email, created_at, last_used_at) VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`, newId('fid', now), personId, issuer, c.sub, email, now, now)
    // Google states the address is the person's (email_verified): it is kept as confirmed, said to be confirmed by Google
    db.run(`INSERT INTO contact_points (id, person_id, kind, address, address_key, created_at, verified_at, usable_from) VALUES (?, ?, 'email', ?, ?, ?, ?, ?)`, newId('cpt', now), personId, address, address.toLowerCase(), now, now, now)
    endPresented(db, meta.replaces, meta.ip, now) // (F12)
    const x = openSession(db, personId, { ua: meta.ua, method: 'google', credentialId: null, ip: meta.ip }, now)
    // just confirmed with Google: for five minutes this unlocks enrolling the first device, as a password just typed does
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'google' WHERE id_hash = ?`, now, sha256hex(x.token))
    securityEvent(db, personId, 'account-created', { method: 'google' }, now)
    audit(db, now, personId, 'owner', 'account.create', personId, { method: 'google' }, meta.ip)
    return x
  })
  return { purpose: 'signin', personId, session, created: true }
}

/** The Google accounts that sign in to this person's account, for the Security page. */
export function googleIdentities(db: Db, personId: string): { id: string; email: string | null; addedAt: number; lastUsedAt: number | null }[] {
  return db.all<{ id: string; email: string | null; created_at: number; last_used_at: number | null }>(`SELECT id, email, created_at, last_used_at FROM federated_identities WHERE person_id = ? AND provider = 'google' AND removed_at IS NULL ORDER BY created_at`, personId)
    .map((i) => ({ id: i.id, email: i.email, addedAt: i.created_at, lastUsedAt: i.last_used_at }))
}

/**
 * Remove Google from the ways of signing in, with the account's strongest confirmation, and only while another way in
 * remains (a password, a passkey, or another Google account): an account is never left with none. Its Google sessions end.
 */
export function unlinkGoogle(db: Db, s: Session, identityId: string, ip: string, now: number): void {
  const i = db.get<{ id: string; email: string | null }>(`SELECT id, email FROM federated_identities WHERE id = ? AND person_id = ? AND removed_at IS NULL`, identityId, s.userId)
  if (!i) throw new AppError(404, 'not_found', 'That Google account was not found, or it was already removed.')
  if (!strongConfirm(db, s, now)) throw confirmNeeded(db, s, 'remove Google sign-in', now)
  refuseCoolingOff(db, s, 'remove Google sign-in', now)
  const others = db.get<{ n: number }>(`SELECT COUNT(*) n FROM federated_identities WHERE person_id = ? AND removed_at IS NULL AND id != ?`, s.userId, identityId)!.n
  if (!hasPassword(db, s.userId) && !hasPasskey(db, s.userId) && others === 0) throw new AppError(409, 'no_way_in', 'Google is the only way in to this account. Set up a device first, so that removing Google does not lock you out.')
  db.tx(() => {
    db.run('UPDATE federated_identities SET removed_at = ? WHERE id = ?', now, identityId)
    // The sessions opened through Google end (review F9), whether or not another Google account still signs in: a session
    // does not record which Google account opened it, so none is trusted past the removal of one. This one, which asked, stays.
    db.run(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND auth_method = 'google' AND revoked_at IS NULL AND id_hash != ?`, now, s.userId, s.sessionHash)
    // a confirmation Google gave a session no longer counts once the account is removed (every session asks again)
    db.run(`UPDATE sessions SET stepup_at = NULL, stepup_method = NULL WHERE user_id = ? AND stepup_method = 'google' AND id_hash != ?`, s.userId, s.sessionHash)
    securityEvent(db, s.userId, 'google-unlinked', { email: i.email }, now)
    audit(db, now, s.userId, 'owner', 'google.unlink', s.userId, {}, ip)
  })
}
