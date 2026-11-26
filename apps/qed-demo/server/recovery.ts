/**
 * Getting back in, kept as three separate things (R12 section 4), each with its own words, routes and screens:
 *
 *   Password reset      an account whose way in is a password, and that has no passkey that can approve, forgot it. A link
 *                       to a confirmed email address (256 random bits, kept as its SHA-256; single use; 30 minutes) lets
 *                       the person set a new one twice-typed and checked like at sign-up. Every session ends, every
 *                       address is told, the person is not signed in by it, and the answer to the request is the same
 *                       whether or not the account exists (OWASP Forgot Password Cheat Sheet). An account with a passkey
 *                       that can approve is told by email to sign in with it instead. The password a reset sets confirms
 *                       no change to how the account gets back in for the protection delay after it (passwordHeldUntil).
 *   Account recovery    every passkey is lost. A link to a confirmed email address (one confirmed longer ago than the
 *                       protection delay) and a second proof obtained differently (a saved code, a code from a recovery
 *                       contact, or the account's password, unless a reset set it within the protection delay: NIST SP
 *                       800-63B-4 section 4.2.2.2) start a recovery that waits RECOVERY_DELAY_MS, during which every
 *                       device, address and recovery contact is told and any of them can cancel it. The browser that
 *                       started it keeps a finishing key (its SHA-256 is kept here); when the wait ends a new link is
 *                       emailed, and the link and that key together make the new passkey, within RECOVERY_FINISH_WINDOW_MS.
 *                       The saved codes and a contact's code without email remain, as the backup path (passkeys.ts),
 *                       finished only with its own reference: neither way finishes a recovery the other started.
 *   Authority to move   a recovered passkey signs in only. It approves no payment, instruction or wallet change, confirms
 *   money               no change to protections and is never a wallet signer, until the person asks for approval
 *                       authority with that passkey and the request waits out the protection delay, told everywhere and
 *                       cancellable by any other passkey of theirs or a recovery contact (requestAuthority). The wallet's
 *                       own signers change only under the wallet's own rules after that (server/rail-signers.ts).
 *
 * Text messages are a lower-assurance channel (NIST SP 800-63B-4 sections 3.1.3.3 and 3.2.9: SIM swap, porting, number
 * reassignment): a confirmed phone number receives short security notices and is never a factor in a reset or a
 * recovery. Delivery goes through server/delivery.ts; in this build that is the local test outbox, which sends nothing,
 * and keeps each message's text, link and code included, until that link or code is used, replaced or expires: then the
 * link and the code are taken out of the kept text (redactSpent, review L1). With no adapter at all, nothing here that
 * needs a message is offered (noDelivery, review M4).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, type RegistrationResponseJSON, verifyRegistrationResponse } from '@simplewebauthn/server'
import { checkNewPassword, emailTagFor, hashPassword, IDLE_MS, rateLimit, storeEmailLogin, type Session, verifyPassword } from './auth.ts'
import { AppError, audit, bad, type Db, j, newId, parse, whenIst } from './core.ts'
import { deliver, deliveryMode, linkOrigin, linkTo, maskAddress, notifyChannels, redactSpent } from './delivery.ts'
import {
  activeContacts, completeRecovery, confirmNeeded, type CodeRow, type Credential, DUMMY_SALT, ES256, fail, handleOf, hasApprovingPasskey, hasPasskey, issueChallenge, isActiveLink,
  type ContactLink, matchCode, matchCodeAsync, passwordHeldUntil, PROTECTION_DELAY_MS, RECOVERY_DELAY_MS, RECOVERY_FINISH_WINDOW_MS, type RelyingParty, scryptCode, scryptCodeAsync, securityEvent, strongConfirm,
  takeChallenge, usableCredentials, utf8, verifyAssertion,
  activatePendingCodes, endAddress, unusedCodes, usedSavedCode, keepPendingCodes, newCodeSet, refuseCoolingOff, scheduleFallbackRemoval, type ScheduledFallback,
} from './passkeys.ts'
import { sha256hex } from './receipts.ts'
import { setStop } from './runner.ts'
import type { Ctx } from './types.ts'
import { noDeliveryWords, type NoDeliveryCase } from '../shared/delivery-words.ts'

export const RESET_TTL_MS = 30 * 60_000
export const RECOVERY_LINK_TTL_MS = 60 * 60_000
export const CONFIRM_EMAIL_TTL_MS = 30 * 60_000
/** A code sent by text message: NIST SP 800-63B-4 section 4.2.1.2 allows ten minutes at most. */
export const CONFIRM_PHONE_TTL_MS = 10 * 60_000
export const MAX_EMAILS = 3
export const MAX_PHONES = 1
/** Wrong proofs or codes one link or code may take before it stops working. */
export const TRIES = 5

type Kind = 'email' | 'phone'
interface Point { id: string; person_id: string; kind: Kind; address: string; address_key: string; created_at: number; verified_at: number | null; usable_from: number | null; replaces_id: string | null; removed_at: number | null }
interface TokenRow { id: string; person_id: string; purpose: string; subject: string | null; token_hash: string | null; code_salt: string | null; code_hash: string | null; created_at: number; expires_at: number; used_at: number | null; replaced_at: number | null; attempts: number }

// ---------------------------------------------------------------------------------------------- addresses

/** An email address as typed: trimmed, one @, a dot in the domain, no spaces; any ordinary address (Gmail included). */
export function normaliseEmail(raw: unknown): { address: string; key: string } {
  const a = typeof raw === 'string' ? raw.trim() : ''
  const at = a.lastIndexOf('@')
  if (a.length > 254 || at < 1 || at > 64 || !/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(a) || /\.\./.test(a)) throw bad('Check the highlighted field.', { address: 'Enter an email address such as name@gmail.com.' })
  const address = `${a.slice(0, at)}@${a.slice(at + 1).toLowerCase()}`
  return { address, key: address.toLowerCase() }
}
/** A phone number in international form (E.164): a plus, the country code, the number; spaces and dashes ignored. */
export function normalisePhone(raw: unknown): { address: string; key: string } {
  const p = typeof raw === 'string' ? raw.replace(/[\s().-]/g, '') : ''
  if (!/^\+[1-9]\d{7,14}$/.test(p)) throw bad('Check the highlighted field.', { address: 'Enter the number with its country code, such as +91 98765 43210.' })
  return { address: p, key: p }
}

const pointsOf = (db: Db, personId: string, kind: Kind): Point[] => db.all<Point>('SELECT * FROM contact_points WHERE person_id = ? AND kind = ? AND removed_at IS NULL ORDER BY created_at', personId, kind)
/** Confirmed email addresses that may start a reset or a recovery now: confirmed, and longer ago than the protection delay. */
export const usableEmails = (db: Db, personId: string, now: number): Point[] => pointsOf(db, personId, 'email').filter((p) => p.verified_at !== null && p.usable_from !== null && p.usable_from <= now)
/** Confirmed email addresses still inside their protection delay: they hear of everything, and start nothing yet. */
const waitingEmails = (db: Db, personId: string, now: number): Point[] => pointsOf(db, personId, 'email').filter((p) => p.verified_at !== null && (p.usable_from === null || p.usable_from > now))

/**
 * With no delivery adapter (QED_DELIVERY=none), a reset, a recovery by email and a new address are refused before
 * anything is looked up, so the refusal says nothing about any account, in words that say what to use instead (review M4).
 */
function noDelivery(what: NoDeliveryCase): void {
  if (deliveryMode() === 'none') throw new AppError(503, 'delivery_unavailable', noDeliveryWords(what))
}

function sixDigits(): string { const b = randomBytes(4).readUInt32BE(0) % 1_000_000; return String(b).padStart(6, '0') }

/**
 * A new one-time secret for one purpose and subject; an earlier one still unused stops working, and its link and code
 * are taken out of the messages that carried them (redactSpent).
 */
function newToken(db: Db, personId: string, purpose: string, subject: string | null, ttlMs: number, now: number, opts: { link: boolean; code: boolean }): { id: string; token: string | null; code: string | null } {
  if (db.run(`UPDATE one_time_tokens SET replaced_at = ? WHERE person_id = ? AND purpose = ? AND COALESCE(subject, '') = ? AND used_at IS NULL AND replaced_at IS NULL`, now, personId, purpose, subject ?? '').changes) redactSpent(db, now)
  const id = newId('ott', now)
  const token = opts.link ? randomBytes(32).toString('base64url') : null
  const code = opts.code ? sixDigits() : null
  const salt = code ? randomBytes(16).toString('hex') : null
  db.run('INSERT INTO one_time_tokens (id, person_id, purpose, subject, token_hash, code_salt, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, personId, purpose, subject, token ? sha256hex(token) : null, salt, code && salt ? scryptCode(salt, code) : null, now, now + ttlMs)
  return { id, token, code }
}

/** Plain words for a link that no longer works, by why. */
const gone = (why: 'invalid' | 'expired' | 'used' | 'replaced', what = 'link'): AppError => new AppError(410, `link_${why}`, {
  invalid: `This ${what} is not one QED sent, or it was copied only in part. Ask for a new one.`,
  expired: `This ${what} has expired. Ask for a new one: links from QED work for 30 minutes, a recovery link for an hour.`,
  used: `This ${what} was already used. Each one works once; ask for a new one if you still need it.`,
  replaced: `A newer ${what} was sent after this one. Use the newest message, or ask for another.`,
}[why])

/** The token a link carries, checked: a known one, of this purpose, unused, not replaced, not expired. Reads only. */
export function linkToken(db: Db, token: unknown, purpose: string, now: number): TokenRow {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw gone('invalid')
  const t = db.get<TokenRow>('SELECT * FROM one_time_tokens WHERE token_hash = ? AND purpose = ?', sha256hex(token), purpose)
  if (!t) throw gone('invalid')
  if (t.used_at !== null) throw gone('used')
  if (t.replaced_at !== null) throw gone('replaced')
  if (now > t.expires_at) throw gone('expired')
  return t
}
/** Spend a token, once: false when another request spent or replaced it first. Its link and code leave the kept text. */
function spend(db: Db, tokenId: string, now: number): boolean {
  if (db.run('UPDATE one_time_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL', now, tokenId).changes !== 1) return false
  redactSpent(db, now)
  return true
}
/**
 * Take one try from a link or code before its proof is checked: at most TRIES proofs are ever checked against one, however
 * many arrive together (review L5: tries counted from a value read before a password hash let a burst all be checked).
 * Returns the tries used, this one included; throws when none is left. The last one spent ends it (see wrongTry).
 */
function takeTry(db: Db, tokenId: string, what = 'link'): number {
  const row = db.get<{ attempts: number }>('UPDATE one_time_tokens SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL AND attempts < ? RETURNING attempts', tokenId, TRIES)
  if (!row) throw new AppError(429, 'too_many', `This ${what} has taken its five tries. Ask for a new one.`)
  return row.attempts
}
/** A try that failed: once the fifth has failed, the link or code stops working and leaves the kept text. */
function wrongTry(db: Db, tokenId: string, tries: number, now: number): void {
  if (tries >= TRIES && db.run('UPDATE one_time_tokens SET replaced_at = ? WHERE id = ? AND replaced_at IS NULL', now, tokenId).changes) redactSpent(db, now)
}

/**
 * Add an email address (or, with `replaces`, change one): confirmed by a link or a six-digit code sent to it, and only
 * then used. It needs the account's strongest confirmation (a passkey; with none, the password typed again), because it
 * becomes a way to start a reset or a recovery, which it may do only once the protection delay after its confirmation
 * has passed (OWASP: do not rely on recovery details just added).
 */
export function addAddress(db: Db, s: Session, kind: Kind, raw: unknown, now: number, replaces?: unknown): { id: string; expiresAt: number } {
  noDelivery('address')
  // email goes through Postmark; no text-message provider exists, so no code could reach a phone (nothing is pretended)
  if (kind === 'phone' && deliveryMode() === 'postmark') throw new AppError(503, 'delivery_unavailable', 'QED sends email, not text messages, so a phone number cannot be confirmed here. Add an email address instead.')
  if (!strongConfirm(db, s, now)) throw confirmNeeded(db, s, kind === 'email' ? 'add an email address' : 'add a phone number', now)
  // an address can start a reset or a recovery after the delay: a passkey in its cool-off adds none (RISK-068, Q-062)
  refuseCoolingOff(db, s, kind === 'email' ? 'add an email address' : 'add a phone number', now)
  const n = kind === 'email' ? normaliseEmail(raw) : normalisePhone(raw)
  if (!rateLimit(db, `address-add:${s.userId}`, 6, 3600_000, now)) throw new AppError(429, 'too_many', 'Six addresses have been asked for in the last hour. Try again later.')
  const mine = pointsOf(db, s.userId, kind)
  const old = typeof replaces === 'string' ? mine.find((p) => p.id === replaces && p.verified_at !== null) : undefined
  if (replaces !== undefined && replaces !== null && !old) throw new AppError(404, 'not_found', 'The address to replace was not found.')
  const same = mine.find((p) => p.address_key === n.key)
  if (same?.verified_at) throw new AppError(409, 'already_added', kind === 'email' ? 'That email address is already confirmed for this account.' : 'That number is already confirmed for this account.', { address: 'Already confirmed.' })
  const max = kind === 'email' ? MAX_EMAILS : MAX_PHONES
  if (!same && mine.filter((p) => p.verified_at !== null).length - (old ? 1 : 0) >= max) throw new AppError(409, 'too_many_addresses', kind === 'email' ? `An account can have ${MAX_EMAILS} email addresses. Remove one, or change one instead.` : 'An account can have one phone number. Change it instead.')
  return db.tx(() => {
    // an earlier unconfirmed request for the same address is replaced by this one
    if (same) db.run(`UPDATE contact_points SET removed_at = ?, removed_reason = 'asked again' WHERE id = ?`, now, same.id)
    db.run(`UPDATE contact_points SET removed_at = ?, removed_reason = 'not confirmed' WHERE person_id = ? AND kind = ? AND verified_at IS NULL AND removed_at IS NULL AND id != ?`, now, s.userId, kind, same?.id ?? '')
    const id = newId('cpt', now)
    db.run('INSERT INTO contact_points (id, person_id, kind, address, address_key, created_at, replaces_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, s.userId, kind, n.address, n.key, now, old?.id ?? null)
    const ttl = kind === 'email' ? CONFIRM_EMAIL_TTL_MS : CONFIRM_PHONE_TTL_MS
    const t = newToken(db, s.userId, kind === 'email' ? 'verify-email' : 'verify-phone', id, ttl, now, { link: kind === 'email', code: true })
    if (kind === 'email') {
      deliver(db, { channel: 'email', to: n.address, personId: s.userId, purpose: 'verify-email', tokenId: t.id, secrets: [linkTo('/verify-email', t.token!), t.code!], subject: 'Confirm your email address for QED',
        body: `Someone signed in to the QED account @${handleOf(db, s.userId)} asked to use this address for its security notices and, after a protection delay, for getting back in.\n\nConfirm it with this link (it works once, for 30 minutes):\n${linkTo('/verify-email', t.token!)}\n\nOr type this code on the Security and recovery page: ${t.code}\n\nIf you did not ask for this, ignore this message: the address is not used until it is confirmed.` }, now)
    } else {
      deliver(db, { channel: 'sms', to: n.address, personId: s.userId, purpose: 'verify-phone', tokenId: t.id, secrets: [t.code!], subject: 'QED confirmation code', body: `QED: your code to confirm this number for security notices is ${t.code}. It works for 10 minutes. QED never asks for it by phone.` }, now)
    }
    securityEvent(db, s.userId, kind === 'email' ? 'email-confirmation-sent' : 'phone-confirmation-sent', { address: maskAddress(kind, n.address), simulated: deliveryMode() === 'outbox' }, now)
    audit(db, now, s.userId, 'owner', `${kind}.add`, id, { replaces: old?.id ?? null })
    return { id, expiresAt: now + ttl }
  })
}

/**
 * The confirmation of the address an account was opened with (R14, server/access.ts): an unconfirmed address and a link and
 * a code sent to it, as addAddress sends them, asked for by the sign-up itself or by a later "send it again". With no
 * adapter nothing is written and false is returned: no message is pretended. Called inside the caller's transaction.
 */
export function sendEmailConfirmation(db: Db, personId: string, n: { address: string; key: string }, handle: string, now: number): boolean {
  if (deliveryMode() === 'none') return false
  // an earlier unconfirmed request for the same address is replaced by this one, and its link and code stop working
  for (const old of db.all<{ id: string }>(`SELECT id FROM contact_points WHERE person_id = ? AND kind = 'email' AND address_key = ? AND verified_at IS NULL AND removed_at IS NULL`, personId, n.key)) {
    db.run(`UPDATE contact_points SET removed_at = ?, removed_reason = 'asked again' WHERE id = ?`, now, old.id)
    if (db.run(`UPDATE one_time_tokens SET replaced_at = ? WHERE person_id = ? AND purpose = 'verify-email' AND subject = ? AND used_at IS NULL AND replaced_at IS NULL`, now, personId, old.id).changes) redactSpent(db, now)
  }
  const id = newId('cpt', now)
  db.run(`INSERT INTO contact_points (id, person_id, kind, address, address_key, created_at) VALUES (?, ?, 'email', ?, ?, ?)`, id, personId, n.address, n.key, now)
  const t = newToken(db, personId, 'verify-email', id, CONFIRM_EMAIL_TTL_MS, now, { link: true, code: true })
  deliver(db, { channel: 'email', to: n.address, personId, purpose: 'verify-email', tokenId: t.id, secrets: [linkTo('/verify-email', t.token!), t.code!], subject: 'Confirm your email address for QED',
    body: `A QED account, @${handle}, was opened with this address.\n\nConfirm that the address is yours with this link (it works once, for 30 minutes):\n${linkTo('/verify-email', t.token!)}\n\nOr type this code under Security in QED: ${t.code}\n\nOnce confirmed, the address receives the account's security notices and can reset its password. If you did not open this account, ignore this message: the address is not used until it is confirmed, and confirming it would tie your address to someone else's account.` }, now)
  securityEvent(db, personId, 'email-confirmation-sent', { address: maskAddress('email', n.address), simulated: deliveryMode() === 'outbox' }, now)
  return true
}

/** Confirm an address: called with the link's token (no session needed: the link proves the mailbox) or a typed code. */
function confirmed(db: Db, p: Point, now: number): { kind: Kind; address: string; usableFrom: number | null } {
  // Every email address, the one the account was opened with included, waits the protection delay after its confirmation
  // before it can start a reset or a recovery, with the owner's devices told (review F4). The link needs no session, so
  // someone who controls the mailbox but not the account (an address typed in by someone else at sign-up, a mailbox
  // given up and taken again) must not be able to confirm it and reset the password at once.
  const own = p.kind === 'email' && !p.replaces_id && !!db.get('SELECT 1 FROM users WHERE id = ? AND email_key = ?', p.person_id, p.address_key)
  const usableFrom = p.kind === 'email' ? now + PROTECTION_DELAY_MS : null
  db.run('UPDATE contact_points SET verified_at = ?, usable_from = ? WHERE id = ?', now, usableFrom, p.id)
  const old = p.replaces_id ? db.get<Point>('SELECT * FROM contact_points WHERE id = ? AND person_id = ? AND removed_at IS NULL', p.replaces_id, p.person_id) : undefined
  // R14 (SECURITY.md 8j (c)): a change of a confirmed email address adds the new one now, as adding always has, and removes
  // the old one only when the protection delay has passed, as a removal does (passkeys.ts endAddress tells it then what the
  // address is now); otherwise asking to "change" an address would remove a way back in at once. A phone number waits the
  // same way (RISK-125: it carries the notices that tell the owner of every change, so ending it silently would silence them).
  const waits = !!old && old.verified_at !== null
  if (old && !waits) db.run(`UPDATE contact_points SET removed_at = ?, removed_reason = 'replaced' WHERE id = ?`, now, old.id)
  securityEvent(db, p.person_id, p.kind === 'email' ? (own ? 'email-confirmed' : 'email-added') : 'phone-added', { address: maskAddress(p.kind, p.address), ...(old ? { replaced: maskAddress(old.kind, old.address) } : {}) }, now)
  // The number that was replaced hears of it once more, although it receives nothing else from now on.
  if (old && !waits) notifyChannels(db, p.person_id, { kind: `${p.kind}-changed`, title: p.kind === 'email' ? 'The email address of your QED account was changed' : 'The phone number of your QED account was changed', body: `It is now ${maskAddress(p.kind, p.address)}. This address will receive nothing more from QED.` }, now, [{ kind: old.kind, address: old.address }], true)
  // the old address is told now, with every other channel, that it is to be removed and when (unless its removal already waits)
  if (old && waits && !db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = 'remove-address' AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, p.person_id, old.id)) {
    scheduleFallbackRemoval(db, { personId: p.person_id, requestedBy: null }, { kind: 'remove-address', subject: old.id, detail: { address: maskAddress(old.kind, old.address), replacedBy: p.id }, event: `${old.kind}-removal-scheduled`, already: `Removing this ${old.kind === 'phone' ? 'phone number' : 'email address'} is already scheduled.` }, now)
  }
  audit(db, now, p.person_id, 'owner', `${p.kind}.confirm`, p.id, { replaced: old?.id ?? null })
  return { kind: p.kind, address: p.address, usableFrom }
}

export function confirmAddressByLink(db: Db, token: unknown, ip: string, now: number): { kind: Kind; address: string; usableFrom: number | null } {
  if (!rateLimit(db, `confirm-link:${ip}`, 30, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many attempts from this address. Wait a few minutes.')
  const t = linkToken(db, token, 'verify-email', now)
  return db.tx(() => {
    const p = db.get<Point>('SELECT * FROM contact_points WHERE id = ? AND person_id = ? AND removed_at IS NULL AND verified_at IS NULL', t.subject ?? '', t.person_id)
    if (!p) throw gone('replaced')
    if (!spend(db, t.id, now)) throw gone('used')
    return confirmed(db, p, now)
  })
}

/**
 * Confirm an address with the code sent to it, from a signed-in session of the same person. Five wrong codes end that
 * code, and wrong codes are counted per person and purpose across new codes too (NIST SP 800-63B-4 section 3.1.3.2: a
 * new secret does not reset the count).
 */
export function confirmAddressByCode(db: Db, s: Session, id: string, code: unknown, now: number): { kind: Kind; address: string; usableFrom: number | null } {
  const p = db.get<Point>('SELECT * FROM contact_points WHERE id = ? AND person_id = ? AND removed_at IS NULL AND verified_at IS NULL', id, s.userId)
  if (!p) throw new AppError(404, 'not_found', 'That address is not waiting for a code. Add it again.')
  const purpose = p.kind === 'email' ? 'verify-email' : 'verify-phone'
  const t = db.get<TokenRow>('SELECT * FROM one_time_tokens WHERE person_id = ? AND purpose = ? AND subject = ? AND used_at IS NULL AND replaced_at IS NULL ORDER BY created_at DESC LIMIT 1', s.userId, purpose, id)
  if (!t || !t.code_hash || !t.code_salt) throw gone('replaced', 'code')
  if (now > t.expires_at) throw gone('expired', 'code')
  if (!rateLimit(db, `code-fail:${s.userId}:${purpose}`, 10, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many wrong codes. Wait an hour, or ask for a new code later.')
  const typed = typeof code === 'string' ? code.replace(/\s/g, '') : ''
  const tries = takeTry(db, t.id, 'code')
  if (!/^\d{6}$/.test(typed) || !matchCode([{ id: t.id, salt: t.code_salt, code_hash: t.code_hash, algo: 'scrypt' }], typed)) {
    wrongTry(db, t.id, tries, now)
    throw bad('Check the highlighted field.', { code: tries >= TRIES ? 'That code is no longer valid after five wrong tries. Add the address again for a new one.' : `That is not the code that was sent. ${TRIES - tries} ${TRIES - tries === 1 ? 'try' : 'tries'} left.` })
  }
  // the counted attempt is given back: only wrong codes count
  db.run(`UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0`, `code-fail:${s.userId}:${purpose}`)
  return db.tx(() => {
    if (!spend(db, t.id, now)) throw gone('used', 'code')
    return confirmed(db, p, now)
  })
}

/**
 * Remove an address, with the account's strongest confirmation. A confirmed email address is a way back in (it can start
 * a reset or a recovery), so its removal is scheduled (SECURITY.md 8j (c), R14): it stays, and keeps receiving notices,
 * for PROTECTION_DELAY_MS; every channel, this address included, is told now; any passkey of the person, one of their
 * saved codes, or on an account with no passkey the password typed again, cancels it (passkeys.ts
 * cancelScheduledChangeWithCode). When it applies (passkeys.ts endAddress) the reset and recovery links already sent stop
 * working too (R13 review, R05). An address never confirmed, and a phone number (notices only, never a way back in), go at once.
 */
export function removeAddress(db: Db, s: Session, id: string, now: number): { removed: true } | ScheduledFallback {
  const p = db.get<Point>('SELECT * FROM contact_points WHERE id = ? AND person_id = ? AND removed_at IS NULL', id, s.userId)
  if (!p) throw new AppError(404, 'not_found', 'That address was not found, or it was already removed.')
  if (p.verified_at !== null && !strongConfirm(db, s, now)) throw confirmNeeded(db, s, p.kind === 'email' ? 'remove an email address' : 'remove a phone number', now)
  // removing an address stops its notices: a passkey in its cool-off removes none (RISK-068, Q-062)
  if (p.verified_at !== null) refuseCoolingOff(db, s, p.kind === 'email' ? 'remove an email address' : 'remove a phone number', now)
  // a confirmed email address is a way back in; a confirmed phone number carries the notices that tell the owner of every change
  // (RISK-125): both wait the protection delay, are told at once on every channel, and are cancelled by a passkey or a saved code
  if (p.verified_at !== null) {
    return scheduleFallbackRemoval(db, { personId: s.userId, requestedBy: s.confirmedBy ?? s.credentialId ?? null }, { kind: 'remove-address', subject: id, detail: { address: maskAddress(p.kind, p.address) }, event: `${p.kind}-removal-scheduled`, already: `Removing this ${p.kind === 'phone' ? 'phone number' : 'email address'} is already scheduled.` }, now)
  }
  db.tx(() => endAddress(db, s.userId, p, now, 'owner'))
  return { removed: true }
}

// ---------------------------------------------------------------------------------------------- who an identifier names

/** The people a handle or an email address names. An email may name several (a household sharing one). */
function peopleFor(db: Db, identifier: unknown): { id: string; handle: string; pw_hash: string }[] {
  const raw = typeof identifier === 'string' ? identifier.trim() : ''
  if (!raw || raw.length > 254) return []
  if (raw.includes('@') && !raw.startsWith('@')) {
    let key: string
    try { key = normaliseEmail(raw).key } catch { return [] }
    return db.all<{ id: string; handle: string; pw_hash: string }>(`SELECT DISTINCT u.id, u.handle, u.pw_hash FROM contact_points c JOIN users u ON u.id = c.person_id
      WHERE c.kind = 'email' AND c.address_key = ? AND c.verified_at IS NOT NULL AND c.removed_at IS NULL AND u.kind = 'person'`, key)
  }
  const h = raw.toLowerCase().replace(/^@/, '')
  return db.all<{ id: string; handle: string; pw_hash: string }>(`SELECT id, handle, pw_hash FROM users WHERE handle = ? AND kind = 'person'`, h)
}

/** Tell confirmed addresses that are still inside their protection delay why nothing more was sent to them. */
function tellWaiting(db: Db, personId: string, what: string, now: number): void {
  for (const p of waitingEmails(db, personId, now)) {
    deliver(db, { channel: 'email', to: p.address, personId, purpose: `${what}-not-yet`, subject: 'QED: this address cannot be used for that yet',
      body: `Someone asked QED for ${what === 'reset' ? 'a password reset' : 'an account recovery'} for @${handleOf(db, personId)}. This address was confirmed recently, so it can be used for that from ${whenIst(p.usable_from ?? now)}: a new address waits, so that someone who adds theirs cannot use it at once.\n\nUntil then: sign in with a passkey if you have one, or recover with a saved recovery code and a code from your recovery contact. If you did not ask, ignore this message.` }, now)
  }
}

// ---------------------------------------------------------------------------------------------- password reset

/**
 * Ask for a password reset by handle or email address. The answer is always the same ({ ok: true }); what happens is
 * said only to the account's confirmed addresses. Ten requests per address of the requester in fifteen minutes, three
 * messages per account an hour (more are dropped silently, so that nobody can flood an inbox).
 */
export function requestPasswordReset(db: Db, identifier: unknown, ip: string, now: number): { ok: true } {
  noDelivery('reset')
  if (!rateLimit(db, `forgot:${ip}`, 10, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many requests from this address. Wait a few minutes.')
  for (const u of peopleFor(db, identifier)) {
    if (!rateLimit(db, `forgot-person:${u.id}`, 3, 3600_000, now)) continue
    const to = usableEmails(db, u.id, now)
    tellWaiting(db, u.id, 'reset', now)
    if (!to.length) { audit(db, now, u.id, 'system', 'password-reset.no-address', u.id, {}, ip); continue }
    db.tx(() => {
      // A passkey that can approve signs this account in, and an email never opens a session on it. Passkeys that sign
      // in only do not stop a reset (review M1: one added with a reset password must not keep the owner from resetting
      // it again); without a password, such a passkey is the way in, and the person is told so.
      if (hasApprovingPasskey(db, u.id) || (hasPasskey(db, u.id) && !u.pw_hash.startsWith('scrypt$'))) {
        for (const p of to) deliver(db, { channel: 'email', to: p.address, personId: u.id, purpose: 'reset-has-passkey', subject: 'QED: sign in with your passkey',
          body: `Someone asked to reset the password of the QED account @${u.handle}. This account has a passkey, so it does not need its password to sign in: sign in with your passkey, and if you want a new password, change it under Security and recovery.\n\nIf you have lost every passkey, recover the account instead: ${linkToPage('/?help=recover')}\n\nIf you did not ask, ignore this message: nothing has changed.` }, now)
        audit(db, now, u.id, 'system', 'password-reset.has-passkey', u.id, {}, ip)
        return
      }
      if (!u.pw_hash.startsWith('scrypt$')) {
        // an account Google signs in to (review F7) is not locked out: it has no password, and Google is its way in
        const viaGoogle = !!db.get(`SELECT 1 FROM federated_identities WHERE person_id = ? AND removed_at IS NULL`, u.id)
        for (const p of to) deliver(db, { channel: 'email', to: p.address, personId: u.id, purpose: 'reset-no-password', subject: 'QED: this account has no password',
          body: viaGoogle
            ? `Someone asked to reset the password of the QED account @${u.handle}. It has no password: it signs in with Google. Sign in with Google; there is no password to reset.\n\nIf you can no longer sign in with that Google account, recover the account instead: ${linkToPage('/?help=recover')}\n\nIf you did not ask, ignore this message.`
            : `Someone asked to reset the password of the QED account @${u.handle}. It has no password and no passkey that can sign in. Recover the account instead: ${linkToPage('/?help=recover')}\n\nIf you did not ask, ignore this message.` }, now)
        return
      }
      const t = newToken(db, u.id, 'password-reset', null, RESET_TTL_MS, now, { link: true, code: false })
      for (const p of to) deliver(db, { channel: 'email', to: p.address, personId: u.id, purpose: 'password-reset', tokenId: t.id, secrets: [linkTo('/reset-password', t.token!)], subject: 'Reset your QED password',
        body: `Someone asked to reset the password of the QED account @${u.handle}.\n\nSet a new password with this link. It works once, for 30 minutes:\n${linkTo('/reset-password', t.token!)}\n\nSetting it signs out every session of the account and stops any request for approval authority. Until the protection delay after the reset has passed, the new password cannot change your saved codes, your addresses or a recovery under way, and a passkey added with it signs in only until you ask for approval authority and its wait ends.\n\nIf you did not ask, ignore this message: your password stays as it is.` }, now)
      audit(db, now, u.id, 'system', 'password-reset.requested', u.id, {}, ip)
    })
  }
  return { ok: true }
}
const linkToPage = (path: string): string => `${linkOrigin()}${path}`

/** What a reset link is for, before the person types anything: the account's handle, so that they know which one. */
export function resetLinkState(db: Db, token: unknown, now: number): { handle: string; expiresAt: number } {
  const t = linkToken(db, token, 'password-reset', now)
  return { handle: handleOf(db, t.person_id), expiresAt: t.expires_at }
}

/**
 * Set a new password with a reset link: checked like at sign-up, typed twice. The link is spent, every other reset link of
 * the account stops working, the sign-in lock clears, every session ends (the person signs in again with it: they are
 * not signed in by this), every address is told, and a hold is left: a passkey added with this password signs in only,
 * until its approval authority is restored after a wait.
 */
export async function resetPassword(db: Db, input: { token: unknown; password: unknown; confirm: unknown }, ip: string, now: number): Promise<{ ok: true; ended: number }> {
  if (!rateLimit(db, `reset:${ip}`, 20, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many attempts from this address. Wait a few minutes.')
  const t = linkToken(db, input.token, 'password-reset', now)
  const u = db.get<{ handle: string; pw_hash: string }>('SELECT handle, pw_hash FROM users WHERE id = ?', t.person_id)!
  if (!u.pw_hash.startsWith('scrypt$')) throw new AppError(409, 'no_password', 'This account has no password now. Recover it instead.')
  if (hasApprovingPasskey(db, t.person_id)) throw new AppError(409, 'has_passkey', 'This account has a passkey that can approve now: sign in with it, and change the password under Security and recovery.')
  if (typeof input.password !== 'string' || input.password !== input.confirm) throw bad('Check the highlighted fields.', { confirm: 'The two passwords are not the same.' })
  const password = checkNewPassword(db, t.person_id, input.password)
  const hash = await hashPassword(password)
  // an account opened with an address signs in with that address and the new password from now (auth.ts storeEmailLogin)
  const tag = await emailTagFor(db, t.person_id, password)
  return db.tx(() => {
    if (!spend(db, t.id, now)) throw gone('used')
    db.run(`UPDATE one_time_tokens SET replaced_at = ? WHERE person_id = ? AND purpose = 'password-reset' AND used_at IS NULL AND replaced_at IS NULL`, now, t.person_id)
    if (db.run('UPDATE users SET pw_hash = ?, failed_logins = 0, locked_until = NULL, authority_hold_at = ?, password_reset_at = ? WHERE id = ? AND pw_hash = ?', hash, now, now, t.person_id, u.pw_hash).changes !== 1) throw new AppError(409, 'retry', 'The password was changed meanwhile. Ask for a new link.')
    storeEmailLogin(db, t.person_id, tag, hash, now)
    // every session ends; the answer counts those that were still in use (lapsed ones are closed too, not counted)
    const ended = db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ? AND last_seen_at >= ?', t.person_id, now, now - IDLE_MS)?.n ?? 0
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, t.person_id)
    // A request for approval authority waiting now was made under the password this replaces (or by whoever held the
    // mailbox before): it stops, and a passkey that wants authority asks again, waiting again (review M1).
    const stopped = db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'password-reset' WHERE person_id = ? AND kind = 'restore-authority' AND cancelled_at IS NULL AND applied_at IS NULL`, now, t.person_id).changes
    redactSpent(db, now)
    securityEvent(db, t.person_id, 'password-reset', { ended, ...(stopped ? { authorityRequestsStopped: stopped } : {}) }, now)
    audit(db, now, t.person_id, 'owner', 'password.reset', t.person_id, { ended }, ip)
    return { ok: true as const, ended }
  })
}

// ---------------------------------------------------------------------------------------------- account recovery by email

interface RequestRow { id: string; person_id: string; started_at: number; available_at: number; cancelled_at: number | null; cancelled_by: string | null; completed_at: number | null; via: string; method: string; secret_hash: string | null }
const openRequest = (db: Db, personId: string): RequestRow | undefined => db.get<RequestRow>('SELECT * FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1', personId)
/**
 * The open recovery an email link is about: the newest started by email. A recovery the backup path started beside it
 * (saved codes; any number may be open) is finished by its own reference and must not hide this one: before, a link
 * looked only at the newest open recovery, so a backup start left the email one unable to finish (R13 review, L-11).
 */
const openEmailRequest = (db: Db, personId: string): RequestRow | undefined => db.get<RequestRow>(`SELECT * FROM recovery_requests WHERE person_id = ? AND via = 'email' AND cancelled_at IS NULL AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1`, personId)

/**
 * Ask for a recovery link by handle or email address: always the same answer. To each confirmed address past its
 * protection delay goes a link (an hour, single use) that starts a recovery, or, when one is under way, shows it and,
 * once its wait is over, finishes it with the finishing key the browser that started it keeps. A recovery the backup
 * path started (saved codes) is only shown: an email link never finishes it (review H1).
 */
export function requestRecoveryLink(db: Db, identifier: unknown, ip: string, now: number): { ok: true } {
  noDelivery('recover')
  if (!rateLimit(db, `recover-link:${ip}`, 10, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many requests from this address. Wait a few minutes.')
  for (const u of peopleFor(db, identifier)) {
    if (!rateLimit(db, `recover-link-person:${u.id}`, 3, 3600_000, now)) continue
    const to = usableEmails(db, u.id, now)
    tellWaiting(db, u.id, 'recovery', now)
    if (!to.length) { audit(db, now, u.id, 'system', 'recovery.no-address', u.id, {}, ip); continue }
    db.tx(() => {
      const open = openEmailRequest(db, u.id) ?? openRequest(db, u.id)
      const t = newToken(db, u.id, 'recovery-email', open?.id ?? null, RECOVERY_LINK_TTL_MS, now, { link: true, code: false })
      const words = !open ? 'Start a recovery with this link. You will also need one more proof: one of your saved recovery codes, a code from your recovery contact, or the account\'s password.'
        : open.via !== 'email' ? 'A recovery of this account that was started with saved codes is under way. This link shows it; it is finished only with its reference, in the browser that started it.'
          : now < open.available_at ? `A recovery of this account is already under way. It can be finished from ${whenIst(open.available_at)}; this link shows it.`
            : 'A recovery of this account is ready to finish: open this link in the browser that started it, which keeps the key that finishes it.'
      for (const p of to) deliver(db, { channel: 'email', to: p.address, personId: u.id, purpose: 'recovery-link', tokenId: t.id, secrets: [linkTo('/recover', t.token!)], subject: 'Get back in to your QED account',
        body: `Someone asked to recover the QED account @${u.handle}, for a person who has lost every passkey.\n\n${words}\nThe link works once, for an hour:\n${linkTo('/recover', t.token!)}\n\nA recovery waits before it can be finished, every device and recovery contact of the account is told, and any of them can stop it. A recovered passkey signs in, and approves payments only after a further wait.\n\nIf you did not ask, ignore this message and nothing starts.` }, now)
      audit(db, now, u.id, 'system', 'recovery.link-sent', u.id, { open: open?.id ?? null }, ip)
    })
  }
  return { ok: true }
}

export type LinkState =
  | { state: 'start'; handle: string; proofs: { savedCode: boolean; contact: boolean; password: boolean }; expiresAt: number }
  | { state: 'waiting' | 'ready' | 'codes'; handle: string; requestId: string; startedAt: number; availableAt: number; finishBy: number; expiresAt: number }

/** Why a recovery this link was about cannot be finished any more: stopped by someone, or left unfinished too long. */
function closedError(r: RequestRow): AppError {
  return r.cancelled_by === 'expired'
    ? new AppError(409, 'recovery_lapsed', `This recovery was not finished within ${Math.round(RECOVERY_FINISH_WINDOW_MS / 86_400_000)} days of its wait ending, so it lapsed. If you are still locked out, ask for a new link and start again.`)
    : new AppError(409, 'recovery_cancelled', 'This recovery was cancelled from one of the account\'s devices or by a recovery contact, so it cannot be finished. If you are the account\'s owner and still locked out, ask for a new link and start again.')
}

/**
 * What a recovery link can do now: start a recovery, show the one under way, or finish it ('ready'). A recovery the
 * backup path started is shown as 'codes': an email link never finishes it. Reads only.
 */
export function recoveryLinkState(db: Db, token: unknown, now: number): LinkState {
  const t = linkToken(db, token, 'recovery-email', now)
  const handle = handleOf(db, t.person_id)
  // A link sent about one recovery speaks only of that one: if it has since been cancelled or has lapsed, it says so.
  if (t.subject) {
    const r = db.get<RequestRow>('SELECT * FROM recovery_requests WHERE id = ? AND person_id = ?', t.subject, t.person_id)
    if (r?.cancelled_at) throw closedError(r)
  }
  const open = openEmailRequest(db, t.person_id) ?? openRequest(db, t.person_id)
  if (open) return { state: open.via !== 'email' ? 'codes' : now < open.available_at ? 'waiting' : 'ready', handle, requestId: open.id, startedAt: open.started_at, availableAt: open.available_at, finishBy: open.available_at + RECOVERY_FINISH_WINDOW_MS, expiresAt: t.expires_at }
  const codes = db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', t.person_id)?.n ?? 0
  const contacts = activeContacts(db, t.person_id, now).filter((c) => hasPasskey(db, c)).length
  const pw = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', t.person_id)?.pw_hash ?? '!'
  // A password a reset link set within the protection delay is no second proof beside an email link (review M1).
  return { state: 'start', handle, proofs: { savedCode: codes > 0, contact: contacts > 0, password: pw.startsWith('scrypt$') && passwordHeldUntil(db, t.person_id, now) === null }, expiresAt: t.expires_at }
}

/**
 * Start a recovery from an email link with a second proof obtained differently: a saved code, a code a recovery contact
 * issued, or the account's password (NIST SP 800-63B-4 section 4.2.2.2), unless a reset set that password within the
 * protection delay: a reset proves only the mailbox this link proves already (review M1). A wrong proof is said to be
 * wrong (the link already proves the mailbox) and counted before it is checked: five end the link, however many arrive
 * together (review L5). Nothing is granted now: the recovery waits. The answer carries the finishing key, which only
 * this browser is given (its SHA-256 is kept): with the link QED sends when the wait is over, it makes the new passkey.
 */
export async function startRecoveryFromLink(db: Db, input: { token: unknown; code?: unknown; contactCode?: unknown; password?: unknown }, ip: string, now: number): Promise<{ requestId: string; availableAt: number; finishBy: number; finishKey: string }> {
  if (!rateLimit(db, `recover-start:${ip}`, 20, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many attempts from this address. Wait a few minutes.')
  const t = linkToken(db, input.token, 'recovery-email', now)
  const person = t.person_id
  if (openRequest(db, person)) throw new AppError(409, 'recovery_open', 'A recovery of this account is already under way. Open the newest link to see it.')
  const code = typeof input.code === 'string' ? input.code : '', contactCode = typeof input.contactCode === 'string' ? input.contactCode : '', password = typeof input.password === 'string' ? input.password : ''
  const given = [code, contactCode, password].filter(Boolean).length
  if (given !== 1) throw bad('Give one second proof: a saved code, a code from your recovery contact, or the account\'s password.')
  const held = password ? passwordHeldUntil(db, person, now) : null
  if (held !== null) throw new AppError(409, 'password_reset_recently', `This account's password was reset by an emailed link recently, so beside an email link it is not a second proof until ${whenIst(held)}: both would prove only the mailbox. Use one of your saved recovery codes, or a code from your recovery contact.`, { password: 'Not a second proof yet: use a saved code or a contact\'s code.' })
  const tries = takeTry(db, t.id)
  let saved: CodeRow | undefined, contact: (CodeRow & { link_id: string }) | undefined, pwOk = false, pwHash = ''
  if (code) saved = await matchCodeAsync(db.all<CodeRow>('SELECT id, salt, code_hash, algo FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', person), code)
  else if (contactCode) {
    const issued = db.all<CodeRow & { link_id: string }>(`SELECT c.id, c.salt, c.code_hash, c.link_id FROM contact_codes c JOIN recovery_contacts l ON l.id = c.link_id
      WHERE c.person_id = ? AND c.used_at IS NULL AND c.replaced_at IS NULL AND c.expires_at > ? AND l.removed_at IS NULL AND l.accepted_at IS NOT NULL AND l.effective_at <= ?`, person, now, now)
    contact = issued.length ? await matchCodeAsync(issued, contactCode) : (await scryptCodeAsync(DUMMY_SALT, contactCode), undefined)
  } else {
    pwHash = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', person)?.pw_hash ?? '!'
    // the password is guessed no faster here than at a step-up: the same eight wrong ones in fifteen minutes
    if (!rateLimit(db, `stepup-fail:${person}`, 8, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many wrong passwords. Wait a few minutes.')
    pwOk = pwHash.startsWith('scrypt$') && await verifyPassword(password, pwHash)
    if (pwOk) db.run('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0', `stepup-fail:${person}`)
  }
  if (!saved && !contact && !pwOk) {
    wrongTry(db, t.id, tries, now)
    audit(db, now, person, 'system', 'recovery.failed', person, { via: 'email', proof: code ? 'saved' : contactCode ? 'contact' : 'password', tries }, ip)
    const field = code ? 'code' : contactCode ? 'contactCode' : 'password'
    const left = TRIES - tries
    throw new AppError(400, 'proof_failed', left > 0 ? `That did not match. ${left} ${left === 1 ? 'try' : 'tries'} left with this link.` : 'That did not match, and this link has now stopped working. Ask for a new one.', { [field]: 'That did not match.' })
  }
  const method = saved ? 'email+saved' : contact ? 'email+contact' : 'email+password'
  const requestId = newId('rec', now), availableAt = now + RECOVERY_DELAY_MS, finishKey = randomBytes(18).toString('base64url')
  db.tx(() => {
    if (openRequest(db, person)) throw new AppError(409, 'recovery_open', 'A recovery of this account is already under way. Open the newest link to see it.')
    if (!spend(db, t.id, now)) throw gone('used')
    if (saved && db.run('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL', now, saved.id).changes !== 1) throw new AppError(409, 'retry', 'That saved code was used meanwhile. Ask for a new link.')
    if (contact && db.run('UPDATE contact_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL AND expires_at > ? AND link_id IN (SELECT id FROM recovery_contacts WHERE removed_at IS NULL AND accepted_at IS NOT NULL AND effective_at <= ?)', now, contact.id, now, now).changes !== 1) throw new AppError(409, 'retry', 'That code was used meanwhile. Ask for a new link.')
    if (pwOk && db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', person)?.pw_hash !== pwHash) throw new AppError(409, 'retry', 'The password changed meanwhile. Ask for a new link.')
    db.run(`INSERT INTO recovery_requests (id, person_id, code_id, contact_code_id, method, started_at, available_at, via, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'email', ?)`, requestId, person, saved?.id ?? 'none', contact?.id ?? null, method, now, availableAt, sha256hex(finishKey))
    securityEvent(db, person, 'recovery-started', { requestId, availableAt, method }, now)
    for (const c of activeContacts(db, person, now)) securityEvent(db, c, 'contact-recovery-started', { for: handleOf(db, person), availableAt }, now)
    audit(db, now, person, 'system', 'recovery.start', requestId, { availableAt, method }, ip)
  })
  return { requestId, availableAt, finishBy: availableAt + RECOVERY_FINISH_WINDOW_MS, finishKey }
}

/**
 * Registration options for the recovered account's new passkey: only with a live link and the finishing key the browser
 * that started this recovery was given, only for a recovery started from an email link (review H1: one the backup path
 * started is finished with its own reference), only once the wait is over, and only within the finishing window. A wrong
 * key takes one of the link's five tries.
 */
export async function beginRecoveryFromLink(db: Db, rp: RelyingParty, input: { token: unknown; finishKey?: unknown }, now: number): Promise<{ challengeId: string; options: unknown }> {
  const t = linkToken(db, input.token, 'recovery-email', now)
  if (t.subject) { const was = db.get<RequestRow>('SELECT * FROM recovery_requests WHERE id = ? AND person_id = ?', t.subject, t.person_id); if (was?.cancelled_at) throw closedError(was) }
  const r = openEmailRequest(db, t.person_id) ?? openRequest(db, t.person_id)
  if (!r) throw new AppError(409, 'recovery_unavailable', 'No recovery of this account is under way: it was cancelled, finished, or it lapsed. Ask for a new link to start one.')
  if (r.via !== 'email') throw new AppError(409, 'recovery_not_by_email', 'This recovery was started with saved codes, not by email, so an email link cannot finish it. Finish it in the browser that started it, with its reference: "Lost your passkey?", then "Finish it here", on the sign-in page.')
  if (now < r.available_at) throw new AppError(409, 'recovery_waiting', `This recovery can be finished from ${whenIst(r.available_at)}. Until then any of the account's passkeys, or a recovery contact, can cancel it.`)
  if (now >= r.available_at + RECOVERY_FINISH_WINDOW_MS) throw closedError({ ...r, cancelled_by: 'expired' })
  const key = typeof input.finishKey === 'string' ? input.finishKey.trim() : ''
  if (!key) throw new AppError(409, 'finish_key_needed', 'Finish this recovery in the browser that started it: it keeps the key that, with this link, makes the new passkey. Open this link there. If that browser is gone, enter the finishing key it showed, or start again from a new link.')
  const want = Buffer.from(r.secret_hash ?? '0'.repeat(64), 'hex'), got = Buffer.from(sha256hex(key), 'hex')
  if (!r.secret_hash || want.length !== got.length || !timingSafeEqual(want, got)) {
    wrongTry(db, t.id, takeTry(db, t.id), now)
    throw new AppError(403, 'finish_key_wrong', 'That is not the finishing key of this recovery. Open the link in the browser that started it, or enter the key it showed exactly.', { finishKey: 'Not this recovery\'s key.' })
  }
  const u = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', t.person_id)!
  const options = await generateRegistrationOptions({ rpName: rp.name, rpID: rp.id, userName: u.handle, userDisplayName: u.display_name, userID: utf8(t.person_id), attestationType: 'none', supportedAlgorithmIDs: [ES256], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
  return { challengeId: issueChallenge(db, 'recover-link', t.person_id, options.challenge, { requestId: r.id, tokenId: t.id }, now), options }
}

/** Make the new passkey: it signs in only (passkeys.ts completeRecovery). The link is spent with it. */
export async function finishRecoveryFromLink(db: Db, rp: RelyingParty, input: { challengeId: unknown; response: unknown; passkeyName?: unknown }, meta: { ip: string; ua: string }, now: number): Promise<ReturnType<typeof completeRecovery>> {
  const ch = takeChallenge(db, input.challengeId, ['recover-link'], null, now)
  const v = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true, supportedAlgorithmIDs: [ES256] }).catch(() => null)
  if (!v?.verified || !v.registrationInfo) throw fail('The passkey could not be created. Try again.')
  const info = v.registrationInfo
  return db.tx(() => {
    const r = db.get<RequestRow>('SELECT * FROM recovery_requests WHERE id = ?', String(ch.context.requestId))
    if (!r || r.person_id !== ch.person_id || r.via !== 'email' || r.cancelled_at || r.completed_at || now < r.available_at || now >= r.available_at + RECOVERY_FINISH_WINDOW_MS) throw new AppError(409, 'recovery_unavailable', 'That recovery is not open: it was cancelled or it lapsed, or it is already finished.')
    if (!spend(db, String(ch.context.tokenId), now)) throw gone('used')
    return completeRecovery(db, r, info, { ...meta, passkeyName: input.passkeyName }, now)
  })
}

/**
 * Send the "ready to finish" message of every recovery started by email whose wait has just ended: a new link to the
 * account's usable addresses (an hour, single use). Once per recovery. Called by the engine's tick.
 */
export function recoveryTick(db: Db, now: number): number {
  // Links and codes that have expired leave the text the outbox keeps (review L1); used and replaced ones already did.
  redactSpent(db, now)
  let sent = 0
  for (const r of db.all<RequestRow>(`SELECT * FROM recovery_requests WHERE via = 'email' AND cancelled_at IS NULL AND completed_at IS NULL AND ready_sent_at IS NULL AND available_at <= ?`, now)) {
    db.tx(() => {
      if (db.run('UPDATE recovery_requests SET ready_sent_at = ? WHERE id = ? AND ready_sent_at IS NULL', now, r.id).changes !== 1) return
      const to = usableEmails(db, r.person_id, now)
      if (!to.length) return
      const t = newToken(db, r.person_id, 'recovery-email', r.id, RECOVERY_LINK_TTL_MS, now, { link: true, code: false })
      for (const p of to) deliver(db, { channel: 'email', to: p.address, personId: r.person_id, purpose: 'recovery-ready', tokenId: t.id, secrets: [linkTo('/recover', t.token!)], subject: 'Your QED recovery can be finished',
        body: `The recovery of the QED account @${handleOf(db, r.person_id)} has waited out its delay and nobody stopped it.\n\nFinish it in the browser that started it, which keeps the key that finishes it. The link works once, for an hour:\n${linkTo('/recover', t.token!)}\n\nIf it expires, ask for a new one from "Lost your passkey?" on the sign-in page. The recovery itself can be finished until ${whenIst(r.available_at + RECOVERY_FINISH_WINDOW_MS)}; after that it lapses and would have to start again.\n\nIf you did not start this recovery, open QED from a device with your passkey and cancel it now.` }, now)
      sent++
    })
  }
  return sent
}

// ---------------------------------------------------------------------------------------------- approval authority after a recovery

const pendingRestore = (db: Db, personId: string, changeId?: string): { id: string; subject: string; effective_at: number; requested_by: string | null } | undefined =>
  db.get(`SELECT id, subject, effective_at, requested_by FROM scheduled_changes WHERE person_id = ? AND kind = 'restore-authority' AND cancelled_at IS NULL AND applied_at IS NULL ${changeId ? 'AND id = ?' : ''} ORDER BY requested_at DESC LIMIT 1`, ...(changeId ? [personId, changeId] : [personId]))

/** The passkey asking for approval authority proves it is present: options that only its own credentials can answer. */
export async function beginAuthorityRequest(db: Db, rp: RelyingParty, s: Session, now: number): Promise<{ challengeId: string; options: unknown }> {
  const creds = usableCredentials(db, s.userId).filter((c) => c.authority === 'signin')
  if (!creds.length) throw new AppError(409, 'authority_full', hasPasskey(db, s.userId) ? 'Every passkey of yours can already approve.' : 'Add a passkey to this account first.')
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required', allowCredentials: creds.map((c) => ({ id: c.id, transports: parse<string[]>(c.transports, []) as never })) })
  return { challengeId: issueChallenge(db, 'authority', s.userId, options.challenge, {}, now), options }
}

/**
 * Ask for approval authority for the passkey that just signed (one that signs in only). It is given when the protection
 * delay has passed, unless cancelled: every device, address and recovery contact is told now.
 */
export async function finishAuthorityRequest(db: Db, rp: RelyingParty, s: Session, input: { challengeId: unknown; response: unknown }, now: number): Promise<{ changeId: string; effectiveAt: number; passkey: string; recoveryCodes?: string[] }> {
  const ch = takeChallenge(db, input.challengeId, ['authority'], s.userId, now)
  const cred: Credential = await verifyAssertion(db, rp, ch, input.response, s.userId, now, 'signin-only')
  const changeId = newId('chg', now), effectiveAt = now + PROTECTION_DELAY_MS
  // R2 (second review of the F1 fix): a passkey added after a password reset brought no codes. Its codes are made with this
  // request, shown once to this session, and kept apart until its authority is restored (passkeys.ts keepPendingCodes).
  // RISK-125: the same for a passkey that an email recovery registered when that recovery spent no saved code (a contact's code
  // or the password was its second proof): nothing was replaced at its end, so its codes come with this request too.
  const viaRecovery = cred.authority_reason === 'recovery' ? db.get<{ id: string }>('SELECT id FROM recovery_requests WHERE credential_id = ? AND person_id = ? AND completed_at IS NOT NULL', cred.id, s.userId) : undefined
  const set = cred.authority_reason === 'after-password-reset' || (viaRecovery && !usedSavedCode(db, viaRecovery.id) && unusedCodes(db, s.userId) === 0) ? newCodeSet() : null
  db.tx(() => {
    if (db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = 'restore-authority' AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, s.userId, cred.id)) throw new AppError(409, 'already_scheduled', 'This passkey has already asked for approval authority. It is given when the wait ends.')
    db.run(`INSERT INTO scheduled_changes (id, person_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, 'restore-authority', ?, ?, ?, ?, ?)`, changeId, s.userId, cred.id, j({ name: cred.name, reason: cred.authority_reason }), now, cred.id, effectiveAt)
    if (set) keepPendingCodes(db, s.userId, changeId, set.kept, cred.authority_reason === 'recovery')
    securityEvent(db, s.userId, 'authority-restore-requested', { passkey: cred.name, effectiveAt, ...(set ? { codesWithIt: true } : {}) }, now)
    for (const c of activeContacts(db, s.userId, now)) securityEvent(db, c, 'contact-authority-requested', { for: handleOf(db, s.userId), effectiveAt }, now)
    audit(db, now, s.userId, 'owner', 'authority.request', cred.id, { changeId, effectiveAt, codesWithIt: !!set })
  })
  return { changeId, effectiveAt, passkey: cred.name, ...(set ? { recoveryCodes: set.codes } : {}) }
}

/**
 * Stop a request for approval authority. From a session opened with the very passkey that asked (its own request), or
 * with a fresh confirmation by a passkey that has full authority; never from a password session alone, which could be
 * a phished password keeping the owner out.
 */
export function cancelAuthorityRequest(db: Db, s: Session, changeId: string, now: number): void {
  const c = pendingRestore(db, s.userId, changeId)
  if (!c) throw new AppError(404, 'not_found', 'That request was not found, or it already took effect or ended.')
  if (!(s.stepUpFresh || (s.credentialId !== null && s.credentialId === c.subject))) throw confirmNeeded(db, s, 'stop that request', now)
  db.tx(() => {
    db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL AND applied_at IS NULL', now, `session:${s.sessionHash.slice(0, 12)}`, c.id)
    securityEvent(db, s.userId, 'authority-restore-cancelled', { by: s.stepUpFresh ? 'another of your passkeys' : 'the passkey that asked' }, now)
    audit(db, now, s.userId, 'owner', 'authority.cancel', c.subject, { changeId })
  })
}

/**
 * Give the waiting passkey approval authority at once: only with a fresh confirmation by a passkey that already has full
 * authority (the verification an expansion of authority needs: it is what adding a passkey from such a session does).
 */
export function grantAuthorityNow(db: Db, s: Session, changeId: string, now: number): void {
  if (!s.stepUpFresh) throw confirmNeeded(db, s, 'give that passkey approval authority now', now)
  refuseCoolingOff(db, s, 'give another passkey approval authority', now)
  const c = pendingRestore(db, s.userId, changeId)
  if (!c) throw new AppError(404, 'not_found', 'That request was not found, or it already took effect or ended.')
  db.tx(() => {
    const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL AND suspended_at IS NULL', c.subject, s.userId)
    if (!cred || cred.authority === 'full') throw new AppError(409, 'not_needed', 'That passkey cannot be given authority: it was suspended or removed, or it has authority already.')
    db.run(`UPDATE webauthn_credentials SET authority = 'full', authority_reason = NULL WHERE id = ?`, c.subject)
    db.run('UPDATE scheduled_changes SET applied_at = ?, cancelled_by = ? WHERE id = ?', now, `granted-by:${s.credentialId ?? 'session'}`, c.id)
    db.run('UPDATE users SET authority_hold_at = NULL WHERE id = ?', s.userId)
    securityEvent(db, s.userId, 'authority-restored', { passkey: cred.name, by: 'another of your passkeys' }, now)
    // R2: authority given early brings the codes made with the request into force, as the end of the wait would
    activatePendingCodes(db, s.userId, c.id, now)
    audit(db, now, s.userId, 'owner', 'authority.grant', c.subject, { changeId })
  })
}

// ---------------------------------------------------------------------------------------------- what a recovery contact may stop

/**
 * A recovery contact pauses QED for the person who trusts them (R12 task comparison, T6-d: a household has no one else
 * who can pause it when its own devices are gone). With the contact's own fresh passkey confirmation, and only for a
 * contact in force. It pauses everything QED does on the person's own household except protective selling, which only a
 * passkey of theirs that can approve may switch off; it resumes nothing, and only the person can resume. Both sides'
 * security histories say who paused it and when. A pause already in force is left as it was.
 */
export function contactPause(ctx: Ctx, s: Session, linkId: string): { ok: true } {
  const { db } = ctx
  const now = ctx.clock.now()
  if (!s.stepUpFresh) throw confirmNeeded(db, s, 'pause QED for them', now)
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND contact_id = ? AND removed_at IS NULL', linkId, s.userId)
  if (!l || !isActiveLink(l, now)) throw new AppError(404, 'not_found', l && l.accepted_at !== null ? `You become a recovery contact for that person on ${whenIst(l.effective_at)}; until then you cannot pause anything for them.` : 'You are not a recovery contact for that person.')
  // three a day for one contact (review L5): enough for an emergency, not a lever to hold someone paused
  if (!rateLimit(db, `contact-pause:${l.id}`, 3, 24 * 3600_000, now)) throw new AppError(429, 'too_many', 'You have paused QED for them three times today. Ask them to call you.')
  const who = handleOf(db, s.userId)
  return db.tx(() => {
    const already = db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', l.person_id)?.stop_at != null
    if (!already) setStop(ctx, l.person_id, `Paused by your recovery contact @${who}`, true)
    // said truly in the person's history (R13): whether protective selling runs afterwards
    const protectiveContinues = db.get<{ p: number }>('SELECT stop_protective p FROM users WHERE id = ?', l.person_id)?.p === 1
    securityEvent(db, l.person_id, 'paused-by-contact', { contact: who, already, protectiveContinues }, now)
    securityEvent(db, s.userId, 'you-paused-for-them', { for: handleOf(db, l.person_id), already }, now)
    audit(db, now, s.userId, 'owner', 'recovery-contact.pause', l.id, { for: l.person_id, already })
    // the same answer either way: whether they had paused it themselves is theirs to say (review L5)
    return { ok: true as const }
  })
}

/** The scheduled changes that loosen a protection (loosening.ts): the ones a recovery contact is told about and may stop. */
const CONTACT_MAY_STOP = ['loosen-profile', 'remove-bill']
/**
 * A recovery contact stops a loosening of a protection that waits out its delay, for the person who trusts them: the contact
 * was told when it was asked for (contact-loosening-scheduled). With the contact's own fresh passkey confirmation, and only for
 * a contact in force. A protective act and nothing more: it cancels, never applies, brings forward or resumes a change, never
 * touches a tightening or a change that took effect, and never sees or changes what it would have loosened. The person is told at
 * once, with who stopped it; both histories and the audit say so. They can ask again, which waits the delay again.
 */
export function contactCancelLoosening(db: Db, s: Session, linkId: string, now: number): { loosenings: number } {
  if (!s.stepUpFresh) throw confirmNeeded(db, s, 'stop their loosening', now)
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND contact_id = ? AND removed_at IS NULL', linkId, s.userId)
  if (!l || !isActiveLink(l, now)) throw new AppError(404, 'not_found', l && l.accepted_at !== null ? `You become a recovery contact for that person on ${whenIst(l.effective_at)}; until then you cannot stop anything for them.` : 'You are not a recovery contact for that person.')
  const who = handleOf(db, s.userId)
  return db.tx(() => {
    const loosenings = db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE person_id = ? AND kind IN (${CONTACT_MAY_STOP.map(() => '?').join(', ')}) AND cancelled_at IS NULL AND applied_at IS NULL AND effective_at > ?`, now, `contact:${who}`, l.person_id, ...CONTACT_MAY_STOP, now).changes
    if (!loosenings) throw new AppError(404, 'nothing_open', 'No loosening of a protection is waiting for that person now.')
    securityEvent(db, l.person_id, 'loosening-cancelled', { by: 'your recovery contact', contact: who, loosenings }, now)
    securityEvent(db, s.userId, 'you-stopped-loosening', { for: handleOf(db, l.person_id), loosenings }, now)
    audit(db, now, s.userId, 'owner', 'recovery-contact.cancel-loosening', l.id, { for: l.person_id, loosenings })
    return { loosenings }
  })
}

/**
 * A recovery contact stops what is under way for the person who trusts them: an open recovery and a waiting request for
 * approval authority. With the contact's own fresh passkey confirmation. Protective only: it grants nothing to anyone.
 * The saved code a cancelled recovery spent stays spent; the person's other codes keep working.
 */
export function contactCancel(db: Db, s: Session, linkId: string, now: number): { recoveries: number; authority: number } {
  if (!s.stepUpFresh) throw confirmNeeded(db, s, 'stop their recovery', now)
  // Only a contact in force: accepted, and past the protection delay of their naming, as for issuing a code (review M2).
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND contact_id = ? AND removed_at IS NULL', linkId, s.userId)
  if (!l || !isActiveLink(l, now)) throw new AppError(404, 'not_found', l && l.accepted_at !== null ? `You become a recovery contact for that person on ${whenIst(l.effective_at)}; until then you cannot stop anything for them.` : 'You are not a recovery contact for that person.')
  const who = handleOf(db, s.userId)
  return db.tx(() => {
    const recoveries = db.run('UPDATE recovery_requests SET cancelled_at = ?, cancelled_by = ? WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', now, `contact:${who}`, l.person_id).changes
    const authority = db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE person_id = ? AND kind = 'restore-authority' AND cancelled_at IS NULL AND applied_at IS NULL`, now, `contact:${who}`, l.person_id).changes
    if (!recoveries && !authority) throw new AppError(404, 'nothing_open', 'Nothing is under way for that person now.')
    if (recoveries) securityEvent(db, l.person_id, 'recovery-cancelled', { by: 'your recovery contact', contact: who }, now)
    if (authority) securityEvent(db, l.person_id, 'authority-restore-cancelled', { by: 'your recovery contact', contact: who }, now)
    securityEvent(db, s.userId, 'you-stopped-recovery', { for: handleOf(db, l.person_id), recoveries, authority }, now)
    audit(db, now, s.userId, 'owner', 'recovery-contact.cancel', l.id, { for: l.person_id, recoveries, authority })
    return { recoveries, authority }
  })
}
