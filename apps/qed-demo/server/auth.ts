/**
 * Accounts and sessions.
 *
 *   Passwords   scrypt (N = 2^17, r = 8, p = 1) with a per-user random salt; only the derived key is stored.
 *   Sessions    a 256-bit random token in an HttpOnly, SameSite=Strict cookie; the database stores only its SHA-256.
 *               A session ends after 1 hour idle or 24 hours in total (NIST SP 800-63B-4 section 2.2.3, AAL2), or when the
 *               owner signs out. Signing in ends the session the browser presented, and a person keeps at most
 *               MAX_SESSIONS: a new one ends the least recently used (ASVS 5.0 V7.1.2, V7.2.4).
 *   Step-up     consequential actions need a passkey confirmation within the last five minutes of that session; a
 *               password typed again (stepUp) unlocks only what server/passkeys.ts allows it (a first passkey, and on an
 *               account with no passkey, the strongest confirmation it has).
 *   Throttling  five wrong passwords lock the account for fifteen minutes; attempts are also limited per address.
 *
 * Errors for sign-in are deliberately identical whether the handle exists or not.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { AppError, audit, bad, type Db, newId } from './core.ts'
import { logAccess } from './records.ts'
import { sha256hex } from './receipts.ts'

const N = 2 ** 17, R = 8, P = 1, KEYLEN = 32
/**
 * A whole number of minutes from the environment, or the fallback when unset. A value that is set but is not a positive
 * whole number stops the process: a mistyped production limit must not quietly become the local build's longer one.
 */
function minutesFrom(name: string, fallbackMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallbackMs
  const v = Number(raw)
  if (!Number.isInteger(v) || v <= 0) throw new Error(`Configuration: ${name} must be a whole number of minutes greater than 0 (it was "${raw}").`)
  return v * 60_000
}
/**
 * Session lifetimes: 1 hour idle and 24 hours in all, everywhere, the local build included (R13 hardening; before, the local
 * build kept 12 hours and 7 days). NIST SP 800-63B-4 section 2.2.3 says at AAL2 the inactivity timeout SHOULD be no more
 * than 1 hour and the overall one no more than 24 hours. QED_SESSION_IDLE_MINUTES and QED_SESSION_MAX_MINUTES change them
 * (a long-lived local fixture for photographs sets them longer, and says so). Every approval and every weakening of a
 * protection needs a fresh passkey assertion whatever these are (STEPUP_MS, server/passkeys.ts).
 */
export const IDLE_MS = minutesFrom('QED_SESSION_IDLE_MINUTES', 3600_000)
export const ABSOLUTE_MS = minutesFrom('QED_SESSION_MAX_MINUTES', 86_400_000)
if (IDLE_MS > ABSOLUTE_MS) throw new Error('Configuration: QED_SESSION_IDLE_MINUTES may not be longer than QED_SESSION_MAX_MINUTES.')
export const STEPUP_MS = 5 * 60_000
/**
 * The most sessions one person keeps at once (ASVS 5.0 V7.1.2). A sign-in beyond it ends the least recently used, and the
 * security history says so: a person signs in on a few devices; dozens of live sessions would be someone else's.
 */
export const MAX_SESSIONS = 10
const MAX_FAILS = 5
const LOCK_MS = 15 * 60_000

function derive(password: string, salt: Buffer, n = N): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r: R, p: P, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))))
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  if (!Number.isInteger(n) || n < 2 ** 14 || n > 2 ** 20) return false
  const salt = Buffer.from(parts[4]!, 'base64'), want = Buffer.from(parts[5]!, 'base64')
  const got = await derive(password, salt, n)
  return got.length === want.length && timingSafeEqual(got, want)
}
// Compared against when the handle does not exist, so that timing does not reveal which handles are registered. Also
// used by the recovery start (passkeys.ts), which hashes a typed password whether or not the account has one.
let dummy: Promise<string> | null = null
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(12).toString('hex')))

const COMMON = new Set(['password123', 'password1234', '1234567890', 'qwertyuiop', 'iloveyou123', 'administrator', 'letmein12345', '0123456789', 'passwordpassword', 'qwerty123456'])
// The words most guessing lists start from. A password that is one of them with digits or symbols added, or that
// holds them alone, is refused (the review of D-094 found "password12" and "qwerty1234" accepted).
const COMMON_WORDS = ['password', 'passw0rd', 'qwerty', 'qwertz', 'azerty', 'asdfgh', 'zxcvbn', 'iloveyou', 'letmein', 'welcome', 'admin', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'trustno1', 'abc123', 'master', 'shadow', 'superman', 'whatever', 'qazwsx', 'india', 'cricket']
/** Too easy to guess: a common password, a common word dressed with digits and symbols, one repeated character, or a run. */
export function guessable(pw: string): boolean {
  const p = pw.toLowerCase()
  if (COMMON.has(p)) return true
  const letters = p.replace(/[^a-z]/g, '')
  if (letters.length < 4 && /\d/.test(p)) return true // mostly digits and symbols
  if (COMMON_WORDS.some((w) => letters === w || letters === w + w || letters.replace(/(.+)\1+/, '$1') === w)) return true
  if (/^(.)\1+$/.test(p)) return true // one character repeated
  // a run up or down the alphabet or the digits, such as "abcdefghij" or "9876543210"
  const codes = [...p].map((c) => c.charCodeAt(0)), step = codes[1]! - codes[0]!
  if ((step === 1 || step === -1) && codes.every((c, i) => i === 0 || c - codes[i - 1]! === step)) return true
  return false
}
/**
 * Words of this service that a password must not be built from (ASVS 5.0 V6.1.2, V6.2.11; NIST SP 800-63B-4 section
 * 3.1.1.2, "context-specific words"): the service's and its parts' names. The person's own handle and display name are
 * added for each check (contextual). Documented in SECURITY.md, "Passwords".
 */
export const CONTEXT_WORDS = ['qed', 'qedwallet', 'wallet', 'paperbank', 'paper', 'rupee', 'rupees', 'meridian', 'household', 'passkey', 'webank', 'fintechathon'] as const
/** Letters only, with the usual digit-for-letter swaps undone ("w4ll3t" is "wallet"). */
const deLeet = (p: string): string => p.toLowerCase().replace(/[0@4]/g, (c) => (c === '0' ? 'o' : 'a')).replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '')
/**
 * Built from context words: what is left of its letters, once every context word (and the person's handle and the parts of
 * their name, three letters or more) is taken out, is fewer than four letters. "QedWallet2026!" is; "qed-is-not-my-friend"
 * is not (twelve letters are left).
 */
export function contextual(pw: string, own: string[] = []): boolean {
  let letters = deLeet(pw)
  if (!letters) return false
  const words = [...CONTEXT_WORDS, ...own.flatMap((w) => w.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 3)].sort((a, b) => b.length - a.length)
  let took = false
  for (const w of words) if (letters.includes(w)) { letters = letters.split(w).join(''); took = true }
  return took && letters.length < 4
}
export function validateCredentials(handle: unknown, password: unknown, displayName?: unknown): { handle: string; password: string; displayName: string } {
  const fields: Record<string, string> = {}
  const h = typeof handle === 'string' ? handle.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(h)) fields.handle = 'Use 3 to 32 letters, digits, dots, dashes or underscores.'
  const pw = typeof password === 'string' ? password : ''
  const named = typeof displayName === 'string' ? displayName : ''
  if (pw.length < 10) fields.password = 'Use at least 10 characters.'
  else if (pw.length > 200) fields.password = 'Use at most 200 characters.'
  else if (guessable(pw) || (h && pw.toLowerCase().includes(h))) fields.password = 'That password is too easy to guess.'
  else if (contextual(pw, [h, named])) fields.password = 'That password is made from the name of this service or your own name or handle. Choose one that is not.'
  const dn = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : h
  if (Object.keys(fields).length) throw bad('Check the highlighted fields.', fields)
  return { handle: h, password: pw, displayName: dn }
}

/**
 * A fixed-window counter. Returns false when the limit for this key is used up. The count is kept apart from the request's
 * transaction (Db.keep): a request that is counted and then refused or fails rolls back whole, and its attempt still counts.
 */
export function rateLimit(db: Db, key: string, limit: number, windowMs: number, now: number): boolean {
  let allowed = false
  db.keep(() => {
    allowed = db.tx(() => {
      const r = db.get<{ window_start: number; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', key)
      if (!r || now - r.window_start >= windowMs) { db.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1', key, now); return true }
      if (r.count >= limit) return false
      db.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', key)
      return true
    })
  })
  return allowed
}

/**
 * At most MAX_SESSIONS live sessions per person: the least recently used beyond it end now, and the person's security
 * history says how many (V7.1.2). Called by every sign-in, after its session is written.
 */
export function capSessions(db: Db, personId: string, now: number): number {
  const live = db.all<{ id_hash: string }>('SELECT id_hash FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at >= ? ORDER BY last_seen_at DESC, created_at DESC', personId, now, now - IDLE_MS)
  const over = live.slice(MAX_SESSIONS)
  for (const s of over) db.run('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL', now, s.id_hash)
  if (over.length) db.run('INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, ?, ?)', personId, now, 'sessions-ended-limit', JSON.stringify({ ended: over.length, limit: MAX_SESSIONS }))
  return over.length
}

export async function register(db: Db, input: { handle: unknown; password: unknown; displayName?: unknown }, ip: string, now: number): Promise<string> {
  const c = validateCredentials(input.handle, input.password, input.displayName)
  if (!rateLimit(db, `register:${ip}`, 10, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many new accounts from this address. Try again later.')
  const pw = await hashPassword(c.password)
  const id = newId('usr', now)
  db.tx(() => {
    try { db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, c.handle, c.displayName, pw, now) }
    catch { throw new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' }) }
    audit(db, now, id, 'owner', 'account.create', id, {}, ip)
  })
  return id
}

export interface NewSession { token: string; csrf: string; userId: string; expiresAt: number }
const FAIL = new AppError(401, 'bad_credentials', 'That handle and password do not match.')

export async function login(db: Db, input: { handle: unknown; password: unknown }, meta: { ip: string; ua: string }, now: number): Promise<NewSession> {
  const handle = typeof input.handle === 'string' ? input.handle.trim().toLowerCase() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  if (!rateLimit(db, `login:${meta.ip}`, 30, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many sign-in attempts. Wait a few minutes.')
  const u = db.get<{ id: string; pw_hash: string; failed_logins: number; locked_until: number | null }>('SELECT id, pw_hash, failed_logins, locked_until FROM users WHERE handle = ?', handle)
  if (u?.locked_until && u.locked_until > now) { await verifyPassword(password, await dummyHash()); throw new AppError(429, 'locked', 'Too many wrong passwords. This account is locked for a few minutes.') }
  // An account made with a passkey has no password ('!'). It is answered exactly as an unknown handle is: the same
  // hash is computed, and no failure is counted, so neither the time taken nor a lock-out reveals that it exists.
  const hasPassword = !!u && u.pw_hash.startsWith('scrypt$')
  // Each try at a password is counted before the password is checked, in one statement, and one beyond the allowance is
  // refused as the lock refuses it, unchecked. Read before the hash and written after it, ten guesses sent together all
  // read the same count and wrote it back plus one, so the account never locked (R13 review, R02), as checkRetyped
  // already guards against for a password typed again.
  let attempt = 0
  if (u && hasPassword) {
    const c = db.get<{ failed_logins: number }>('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING failed_logins', u.id, now)
    if (!c || c.failed_logins > MAX_FAILS) {
      if (c) db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)', now + LOCK_MS, u.id, now)
      await verifyPassword(password, await dummyHash())
      throw new AppError(429, 'locked', 'Too many wrong passwords. This account is locked for a few minutes.')
    }
    attempt = c.failed_logins
  }
  const matched = await verifyPassword(password, hasPassword ? u!.pw_hash : await dummyHash())
  const ok = hasPassword && matched
  if (!u || !ok) {
    if (u && hasPassword) {
      const locked = attempt >= MAX_FAILS
      // The person is told, at once and on every confirmed address, that their password is being guessed (ASVS 5.0 V6.3.5):
      // the lock holds the password only; their passkeys still sign in. The lock, its record and the notice together.
      const { securityEvent } = await import('./passkeys.ts')
      db.tx(() => {
        if (locked) db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', now + LOCK_MS, u.id)
        audit(db, now, u.id, 'system', 'login.failed', u.id, { locked }, meta.ip)
        if (locked) securityEvent(db, u.id, 'signin-locked', { until: now + LOCK_MS, failures: MAX_FAILS }, now)
      })
    }
    throw FAIL
  }
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id)
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url')
  const expiresAt = now + ABSOLUTE_MS
  db.tx(() => {
    db.run('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, csrf, ua, stepup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sha256hex(token), u.id, now, now, expiresAt, csrf, meta.ua.slice(0, 200), now)
    capSessions(db, u.id, now)
    audit(db, now, u.id, 'owner', 'login', u.id, { method: 'password' }, meta.ip)
  })
  logAccess(db, u.id, 'sign-in', { method: 'password', ip: meta.ip, ua: meta.ua.slice(0, 200) }, now)
  return { token, csrf, userId: u.id, expiresAt }
}

/**
 * stepUpFresh: re-authenticated with a passkey within STEPUP_MS. A password re-entry (legacy accounts only) sets
 * passwordStepUpFresh instead, which unlocks nothing but adding a first passkey.
 * signinOnly: opened with a passkey that signs in only (one a recovery registered, or one added after a password reset,
 * R12), read from that passkey now: such a session confirms nothing, like a password session (review H2).
 */
export interface Session { userId: string; csrf: string; sessionHash: string; stepUpFresh: boolean; passwordStepUpFresh: boolean; expiresAt: number; authMethod: string; credentialId: string | null; workspaceId: string; signinOnly?: boolean
  /** The passkey that gave the fresh confirmation (stepUpFresh); null when none is fresh, or for a session from before v8 (r). */
  confirmedBy?: string | null }
export function sessionFor(db: Db, token: string | undefined, now: number): Session | null {
  if (!token || token.length < 20 || token.length > 100) return null
  const h = sha256hex(token)
  const s = db.get<{ user_id: string; csrf: string; last_seen_at: number; expires_at: number; stepup_at: number | null; revoked_at: number | null; auth_method: string; credential_id: string | null; workspace_id: string | null; stepup_method: string | null; stepup_credential_id: string | null; authority: string | null }>(`SELECT s.user_id, s.csrf, s.last_seen_at, s.expires_at, s.stepup_at, s.revoked_at, s.auth_method, s.credential_id, s.workspace_id, s.stepup_method, s.stepup_credential_id,
    (SELECT c.authority FROM webauthn_credentials c WHERE c.id = s.credential_id) authority FROM sessions s WHERE s.id_hash = ?`, h)
  if (!s || s.revoked_at || now > s.expires_at || now - s.last_seen_at > IDLE_MS) return null
  if (now - s.last_seen_at > 60_000) db.run('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?', now, h)
  const fresh = s.stepup_at !== null && now - s.stepup_at <= STEPUP_MS
  const passkeyFresh = fresh && s.stepup_method === 'passkey'
  return { userId: s.user_id, csrf: s.csrf, sessionHash: h, stepUpFresh: passkeyFresh, passwordStepUpFresh: fresh && s.stepup_method === 'password', expiresAt: s.expires_at, authMethod: s.auth_method, credentialId: s.credential_id, workspaceId: s.workspace_id ?? s.user_id, signinOnly: s.credential_id !== null && s.authority === 'signin',
    confirmedBy: passkeyFresh ? s.stepup_credential_id : null }
}

/** Ends the session of this token, if it is live; returns its person, so that the end can be recorded. */
export function logout(db: Db, token: string | undefined, now: number): string | null {
  if (!token || token.length > 100) return null
  const h = sha256hex(token)
  const s = db.get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id_hash = ? AND revoked_at IS NULL', h)
  if (!s) return null
  db.run('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL', now, h)
  return s.user_id
}
export function logoutEverywhere(db: Db, userId: string, now: number): number {
  return db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, userId).changes
}

/** True when a key has used up its allowance in the current window. Reads only; does not count an attempt. */
export function rateBlocked(db: Db, key: string, limit: number, windowMs: number, now: number): boolean {
  const r = db.get<{ window_start: number; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', key)
  return !!r && now - r.window_start < windowMs && r.count >= limit
}

/**
 * A password typed again inside a session: to re-authenticate (stepUp), or as the current password of a change
 * (changePassword, server/passkeys.ts). Both share one limit per person, eight wrong passwords in fifteen minutes, so
 * neither route gives a guess the other does not. Each attempt is counted before its password is checked and given back
 * when it was right: counted only after the check, a burst of guesses sent together would all be checked before any
 * was counted (the review of RISK-076's change, M4). Only wrong passwords stay counted, so an owner who confirms many
 * times in a row is never held up by it. `wrong` names the audit entry and the field a wrong password is reported on.
 */
export async function checkRetyped(db: Db, userId: string, password: unknown, ip: string, now: number, wrong: { action: string; fields?: Record<string, string> }): Promise<void> {
  const key = `stepup-fail:${userId}`
  if (!rateLimit(db, key, 8, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many wrong passwords. Wait a few minutes.')
  const counted = db.get<{ window_start: number }>('SELECT window_start FROM rate_limits WHERE key = ?', key)?.window_start
  const u = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', userId)
  if (u && typeof password === 'string' && (await verifyPassword(password, u.pw_hash))) {
    db.run('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND window_start = ? AND count > 0', key, counted ?? -1)
    return
  }
  audit(db, now, userId, 'system', wrong.action, userId, {}, ip)
  throw new AppError(401, 'bad_credentials', 'That password is not right.', wrong.fields)
}

/**
 * Re-enter the password to unlock consequential actions for five minutes in this session. Only wrong passwords
 * count towards the limit, so an owner who approves many things in a row is never locked out by their own success.
 */
export async function stepUp(db: Db, s: Session, password: unknown, ip: string, now: number): Promise<void> {
  await checkRetyped(db, s.userId, password, ip, now, { action: 'stepup.failed' })
  db.tx(() => {
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'password', stepup_credential_id = NULL WHERE id_hash = ?`, now, s.sessionHash)
    // every authentication is recorded, the successful ones too, with the factor used (ASVS 5.0 V16.3.1)
    audit(db, now, s.userId, 'owner', 'stepup', s.userId, { method: 'password' }, ip)
  })
}
