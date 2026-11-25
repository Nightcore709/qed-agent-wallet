/**
 * Ordinary account access (R14, Priority 1): opening an account with an email address and a password, and the state of
 * that address's confirmation. Signing in with the address is in server/auth.ts (loginWithEmail); Google in
 * server/google.ts. This is the first of five separate operations (shared/access-operations.ts): what is made here
 * enters the account and nothing more. It approves nothing until a device is enrolled (passkeys.ts beginAddPasskey), and
 * no saved recovery codes are made here (there is no device yet): they are made with the first device
 * (passkeys.ts finishAddPasskey), so that nobody ever holds two devices without the tie-breaker (H2; review F1).
 *
 *   Address        kept as typed, and lower-cased for lookup. It is NOT unique and reserves nothing until confirmed: an
 *                  address nobody has proved is only something someone typed. So opening an account never says whether
 *                  an address is in use (ASVS 5.0 V6.3.8), and nobody takes an address from its owner by typing it first.
 *                  A second account opened with the same address is a separate account with its own password and handle.
 *   Handle         made from the person's name (never from the address, which is private), unless they choose one; it is
 *                  the public name others pay them with, and still signs in.
 *   Confirmation   through server/delivery.ts, as every message. With the local test outbox the confirmation is kept there
 *                  and said to be simulated. With no adapter (QED_DELIVERY=none, production today) nothing is written and
 *                  nothing is said to be sent: the account works, its address is shown as not confirmed, and confirming
 *                  is said to be unavailable (emailState.canVerify false).
 *   Usable         the address an account was opened with may start a password reset or a recovery as soon as it is
 *                  confirmed (recovery.ts confirmed): a signed-in session can never change it, so the wait that guards an
 *                  address added later (someone in the session adding their own) has nothing to guard here.
 */
import { randomBytes } from 'node:crypto'
import { emailTag, endPresented, HANDLE_RE, hashPassword, type NewSession, passwordProblem, rateLimit, storeEmailLogin } from './auth.ts'
import { AppError, audit, bad, type Db, newId } from './core.ts'
import { deliveryMode, maskAddress } from './delivery.ts'
import { openSession, securityEvent } from './passkeys.ts'
import { normaliseEmail, sendEmailConfirmation } from './recovery.ts'
import { sha256hex } from './receipts.ts'

export interface EmailState {
  /** The address the account was opened with; null for an account opened with a handle only. */
  address: string | null
  /** Confirmed: the person opened a link, or typed a code, that QED sent to it (or Google stated it is theirs). */
  verified: boolean
  /** A confirmation is waiting to be used. */
  pending: boolean
  /** Whether this installation can send a confirmation at all. False: confirming is unavailable here, and the screens say so. */
  canVerify: boolean
  /** True with the local test outbox: the "message" is kept on this QED installation and nothing is sent. */
  simulated: boolean
}

/** The state of the address a person's account was opened with. Reads only. */
export function emailState(db: Db, personId: string, now: number): EmailState {
  const mode = deliveryMode()
  const u = db.get<{ email: string | null; email_key: string | null }>('SELECT email, email_key FROM users WHERE id = ?', personId)
  const base = { canVerify: mode !== 'none', simulated: mode === 'outbox' }
  if (!u?.email || !u.email_key) return { address: null, verified: false, pending: false, ...base }
  const verified = !!db.get(`SELECT 1 FROM contact_points WHERE person_id = ? AND kind = 'email' AND address_key = ? AND verified_at IS NOT NULL AND removed_at IS NULL`, personId, u.email_key)
  const pending = !verified && !!db.get(`SELECT 1 FROM contact_points c JOIN one_time_tokens t ON t.subject = c.id AND t.person_id = c.person_id AND t.purpose = 'verify-email'
    WHERE c.person_id = ? AND c.kind = 'email' AND c.address_key = ? AND c.verified_at IS NULL AND c.removed_at IS NULL AND t.used_at IS NULL AND t.replaced_at IS NULL AND t.expires_at > ?`, personId, u.email_key, now)
  return { address: u.email, verified, pending, ...base }
}

/** A handle from a name: lower-case letters and digits joined by dots; 'member' when the name gives fewer than three. */
function handleFrom(name: string): string {
  const h = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 24).replace(/\.+$/, '')
  return HANDLE_RE.test(h) ? h : 'member'
}
/**
 * A free handle for a person of this name: the name's own form when it is free (never the neutral 'member' alone), else
 * that with four random digits. Never made from an email address, which is private; the handle is a public name.
 */
export function freeHandle(db: Db, name: string): string {
  const base = handleFrom(name)
  const taken = (h: string): boolean => !!db.get('SELECT 1 FROM users WHERE handle = ?', h)
  if (base !== 'member' && !taken(base)) return base
  for (let i = 0; i < 40; i++) { const h = `${base}.${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0')}`; if (!taken(h)) return h }
  return `member.${randomBytes(6).toString('hex')}`
}

export interface NewAccount { session: NewSession; personId: string; handle: string; email: EmailState }

/**
 * Open an account with an email address and a password. The answer has the same shape whether or not another account
 * uses the address. The session is a password session whose just-typed password unlocks adding the first device, as
 * signUpWithPassword's does; it is not a passkey confirmation.
 */
export async function signUpWithEmail(db: Db, input: { email: unknown; password: unknown; displayName?: unknown; handle?: unknown }, meta: { ip: string; ua: string; replaces?: string }, now: number): Promise<NewAccount> {
  const fields: Record<string, string> = {}
  let email: { address: string; key: string } | null = null
  try { email = normaliseEmail(input.email) } catch { fields.email = 'Enter an email address such as name@gmail.com.' }
  const named = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 60) : ''
  const chosen = typeof input.handle === 'string' && input.handle.trim() ? input.handle.trim().toLowerCase().replace(/^@/, '') : null
  if (chosen !== null && !HANDLE_RE.test(chosen)) fields.handle = 'Use 3 to 32 letters, digits, dots, dashes or underscores.'
  const pw = typeof input.password === 'string' ? input.password : ''
  const local = email ? email.key.slice(0, email.key.lastIndexOf('@')) : ''
  const problem = passwordProblem(pw, [local, ...(chosen ? [chosen] : [])], [local, named, ...(chosen ? [chosen] : [])])
  if (problem) fields.password = problem
  if (Object.keys(fields).length || !email) throw bad('Check the highlighted fields.', fields)
  if (!rateLimit(db, `signup:${meta.ip}`, 20, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many new accounts from this address. Try again later.')
  const taken = (): AppError => new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' })
  if (chosen && db.get('SELECT 1 FROM users WHERE handle = ?', chosen)) throw taken()
  const hash = await hashPassword(pw)
  const tag = { emailKey: email.key, tag: await emailTag(db, email.key, pw) }
  const personId = newId('usr', now)
  const address = email
  return db.tx(() => {
    if (chosen && db.get('SELECT 1 FROM users WHERE handle = ?', chosen)) throw taken()
    const handle = chosen ?? freeHandle(db, named)
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind, email, email_key) VALUES (?, ?, ?, ?, ?, 'person', ?, ?)`, personId, handle, named || handle, hash, now, address.address, address.key)
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, ?)`, personId, personId, now, personId)
    storeEmailLogin(db, personId, tag, hash, now)
    endPresented(db, meta.replaces, meta.ip, now)
    const session = openSession(db, personId, { ua: meta.ua, method: 'password', credentialId: null, ip: meta.ip }, now)
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'password' WHERE id_hash = ?`, now, sha256hex(session.token))
    // The confirmation, where this installation can send one. With none, nothing is written: no message is pretended.
    sendEmailConfirmation(db, personId, address, handle, now)
    securityEvent(db, personId, 'account-created', { method: 'password', email: maskAddress('email', address.address) }, now)
    audit(db, now, personId, 'owner', 'account.create', personId, { method: 'password', with: 'email' }, meta.ip)
    return { session, personId, handle, email: emailState(db, personId, now) }
  })
}

/**
 * Send the confirmation of the address the account was opened with again (the first one expired, or was lost). Any
 * signed-in session of the person may ask: it only sends, to the one address the account was opened with, a message that
 * confirms that same address. Three an hour. Refused, in words that say so, where nothing can be sent.
 */
export function resendEmailConfirmation(db: Db, personId: string, now: number): EmailState {
  if (deliveryMode() === 'none') throw new AppError(503, 'delivery_unavailable', 'This installation of QED cannot send email, so an address cannot be confirmed here. Your account works as it is, and the address stays marked as not confirmed.')
  const u = db.get<{ handle: string; email: string | null; email_key: string | null }>('SELECT handle, email, email_key FROM users WHERE id = ?', personId)
  if (!u?.email || !u.email_key) throw new AppError(409, 'no_address', 'This account was not opened with an email address. Add one under Security.')
  if (emailState(db, personId, now).verified) throw new AppError(409, 'already_confirmed', 'That address is already confirmed.')
  if (!rateLimit(db, `email-confirm:${personId}`, 3, 3600_000, now)) throw new AppError(429, 'too_many', 'Three confirmations have been asked for in the last hour. Try again later.')
  db.tx(() => { sendEmailConfirmation(db, personId, { address: u.email!, key: u.email_key! }, u.handle, now) })
  return emailState(db, personId, now)
}

