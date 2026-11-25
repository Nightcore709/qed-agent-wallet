/**
 * Passkeys (WebAuthn) for sign-in, re-authentication and approval of exact terms; recovery codes; the changes that
 * reduce protection and therefore wait out a delay. R7 decisions D2 and D3 (docs/r7/00-ARCHITECTURE-DECISIONS.md).
 *
 *   Five operations  (R14) entering the account, enrolling a device, approving a protected action, recovering access and
 *                 recovering authority over the wallet are separate and never stand in for one another
 *                 (shared/access-operations.ts). Here: a passkey with full authority is the only thing that confirms a
 *                 change or approves; a password, Google, an emailed code or a session alone never does.
 *   Sign-up       a new account is created only after its first passkey verifies; it has no password. (Or with a
 *                 password, D-094 and server/access.ts; or by Google, server/google.ts.)
 *   Saved codes   (R14, review F1) no forced step at sign-up, but made in the same transaction as the account's FIRST
 *                 device, whichever way it comes (finishSignup, or finishAddPasskey for an address, password or Google
 *                 account, and the one made inside the wallet's set-up), and shown once on the next screen. H2 lets the only
 *                 usable passkey make codes at once; so if codes were optional, the first holder of a device (a thief with
 *                 a synced passkey) could mint the tie-breaker and lock the owner out. A second device and a completed
 *                 recovery make none, as before R14.
 *   Sign-in       discoverable credentials, user verification required (the authenticator checks the fingerprint, face
 *                 or device PIN; the server only ever sees a signature).
 *   Approval      the challenge is derived from the approval's id and the hash of its exact terms, so the signature is
 *                 over those terms and cannot be used for anything else (approvalChallenge).
 *   Algorithms    ES256 only: the same P-256 key must also verify on chain, where each workspace's vault owner is a
 *                 passkey account (EIP-7951 precompile).
 *   Recovery      NIST SP 800-63B-4 §4.2.2.2 (an account that authenticates at AAL2): two codes obtained by different
 *                 methods. One of ten saved codes (80 random bits each, single use, stored with scrypt), and a code
 *                 issued by a recovery contact (a person with their own account here, who confirms with their own
 *                 passkey); for an account made before passkeys, its password may stand in for the contact's code.
 *                 Even then nothing is granted at once: the recovery becomes usable only after RECOVERY_DELAY_MS,
 *                 during which every signed-in session and every contact sees it and any of the person's passkeys can
 *                 cancel it. Completing it issues a new set of saved codes (§4.2.1.1).
 *   Suspension    any of the person's passkeys can suspend another at once (§4.3: "promptly"); a suspended passkey
 *                 can do nothing, its sessions end and what it had scheduled is cancelled. Allowing it again waits.
 *   Removal       removing a passkey waits PROTECTION_DELAY_MS and can be cancelled from another passkey: one
 *                 stolen passkey must not be able to lock the owner out of their own account.
 *   Cool-off      (R13 hardening; RISK-068, Q-062) a passkey added beside another is limited for COOL_OFF_MS (24 hours): it
 *                 approves nothing above NEW_PASSKEY_LIMIT_PAISE (₹10,000), loosens no protection (COOLING_OFF_ACTS) and
 *                 adds no signer. Meanwhile any older passkey with full authority removes it at once, not after the
 *                 protection delay, and the person is told when it is added and when it is removed. A passkey registered
 *                 by a recovery keeps the recovery's own rules (it signs in only until a delayed restoration).
 *   Password      an account opened with a password (D-094) changes it with the strongest confirmation it can give
 *                 and removes it only with a passkey, keeping a way back in; either ends every other session
 *                 (changePassword, removePassword; RISK-076).
 *   Authority     (R12) a passkey has 'full' authority (signs in, confirms changes, approves) or 'signin' authority. A
 *                 passkey registered by an account recovery, or added with the password after a password reset, signs
 *                 in only: it approves no payment, instruction or wallet change, confirms no change to protections and
 *                 is never made a wallet signer, until a separate restoration (server/recovery.ts requestAuthority) has
 *                 waited out its delay, told every device, address and recovery contact, and not been cancelled.
 */
import { logAccess } from './records.ts'
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  type AuthenticationResponseJSON, generateAuthenticationOptions, generateRegistrationOptions, type RegistrationResponseJSON,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers'
import { ABSOLUTE_MS, capSessions, checkNewPassword, checkRetyped, dummyHash, emailTagFor, endPresented, hashPassword, IDLE_MS, rateLimit, STEPUP_MS, storeEmailLogin, validateCredentials, verifyPassword, type NewSession, type Session } from './auth.ts'
import { AppError, audit, bad, type Config, type Db, emit, j, layerDigest, LEGACY_LAYER, legacyLayerSalt, newId, parse, whenIst } from './core.ts'
import { sha256hex } from './receipts.ts'
import { notice } from './execute.ts'
import { notifyChannels, redactSpent } from './delivery.ts'
import { PROFILE_KEYS, saveProfile, validateProfile } from './household.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

export interface RelyingParty { id: string; name: string; origins: string[] }

/**
 * WebAuthn needs a domain as relying-party id; an IP address is refused by browsers. Locally that is `localhost`. With a
 * public origin (QED_PUBLIC_ORIGIN, checked by loadConfig), that origin is the only one accepted and the id is the
 * configured one: a passkey made at one origin, or for another id, is refused (docs/PRODUCTION.md).
 */
export function relyingParty(cfg: Pick<Config, 'apiPort'> & Partial<Pick<Config, 'publicOrigin' | 'rpId'>>, env: NodeJS.ProcessEnv = process.env): RelyingParty {
  if (cfg.publicOrigin && cfg.rpId) return { id: cfg.rpId, name: 'QED', origins: [cfg.publicOrigin] }
  const id = env.QED_RP_ID ?? 'localhost'
  // The interface the API serves is the one origin. The development server's origin is accepted only when it is named
  // (QED_WEB_PORT): any page served from an accepted origin can obtain assertions that QED accepts.
  const ports = [...new Set([cfg.apiPort, ...(env.QED_WEB_PORT ? [Number(env.QED_WEB_PORT)] : [])])]
  return { id, name: 'QED', origins: ports.map((p) => `http://${id}:${p}`) }
}

const CHALLENGE_TTL_MS = 5 * 60_000
const seconds = (name: string, fallback: number): number => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v * 1000 : fallback }
/** How long a recovery waits before a new passkey may be registered. Shorter only in a labelled test mode. */
export const RECOVERY_DELAY_MS = seconds('QED_RECOVERY_DELAY_SEC', 72 * 3600_000)
/** How long a change that reduces protection waits (removing a passkey). */
export const PROTECTION_DELAY_MS = seconds('QED_PROTECTION_DELAY_SEC', 72 * 3600_000)
/** How long a passkey added to an account is limited (the cool-off). Shorter only in a labelled test mode. */
export const COOL_OFF_MS = seconds('QED_COOL_OFF_SEC', 24 * 3600_000)
/** The most a passkey in its cool-off may approve in one request: ₹10,000 (paise). A request of no stated size is not limited by it. */
export const NEW_PASSKEY_LIMIT_PAISE = 1_000_000
export const TEST_DELAYS = RECOVERY_DELAY_MS < 72 * 3600_000 || PROTECTION_DELAY_MS < 72 * 3600_000 || COOL_OFF_MS < 24 * 3600_000
/**
 * How long a recovery stays ready once its wait is over. Not finished by then, it lapses and is started again, so that
 * one forgotten does not stay open to whoever later holds its reference, or its link and finishing key (review H1).
 */
export const RECOVERY_FINISH_WINDOW_MS = 7 * 86_400_000
export const ES256 = -7
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
const CODES = 10

// the failure says what to do next (R12 task comparison, gap 19): another passkey of this account, else recovery
export const fail = (message = 'That passkey could not be verified. Try again and choose a passkey saved for this account; if none of yours works, use “Recover your account” on the sign-in page.'): AppError => new AppError(401, 'passkey_failed', message)
export const utf8 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(s, 'utf8'))

// ---------------------------------------------------------------------------------------------- challenges

export function issueChallenge(db: Db, purpose: string, personId: string | null, challenge: string, context: unknown, now: number): string {
  // A challenge that expired an hour ago can never be used: removed here, or a signed-out "begin" (which needs no
  // account) would add a row that nothing ever removes (R13 review, R04).
  db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now - 3600_000)
  const id = newId('wch', now)
  db.run('INSERT INTO webauthn_challenges (id, person_id, purpose, challenge, context_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, personId, purpose, challenge, j(context), now, now + CHALLENGE_TTL_MS)
  return id
}

export interface ChallengeRow { id: string; person_id: string | null; purpose: string; challenge: string; context_json: string; expires_at: number; used_at: number | null }
/** Single use: the row is marked used before verification, so a second attempt with the same challenge always fails. */
export function takeChallenge(db: Db, id: unknown, purposes: string[], personId: string | null, now: number): ChallengeRow & { context: Record<string, unknown> } {
  if (typeof id !== 'string') throw fail()
  const c = db.get<ChallengeRow>('SELECT * FROM webauthn_challenges WHERE id = ?', id)
  if (!c || !purposes.includes(c.purpose) || c.used_at !== null || now > c.expires_at) throw fail('That request expired or was already used. Try again.')
  if (personId !== null && c.person_id !== personId) throw fail()
  if (db.run('UPDATE webauthn_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL', now, id).changes !== 1) throw fail()
  return { ...c, context: parse<Record<string, unknown>>(c.context_json, {}) }
}

// ---------------------------------------------------------------------------------------------- credentials

export interface Credential { id: string; person_id: string; public_key: Uint8Array; x: string; y: string; counter: number; transports: string; name: string; removed_at: number | null; suspended_at: number | null; device_type: string | null; backed_up: number; created_at: number; last_used_at: number | null; authority: 'full' | 'signin'; authority_reason: string | null; cool_off_until?: number | null }

/** The P-256 coordinates of an ES256 COSE key; anything else is refused. */
export function p256Coordinates(publicKey: Uint8Array): { x: string; y: string } {
  const k = decodeCredentialPublicKey(new Uint8Array(publicKey)) as unknown as Map<number, unknown>
  if (k.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2 || k.get(cose.COSEKEYS.alg) !== ES256 || k.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256) throw bad('Only P-256 (ES256) passkeys are supported here.')
  const x = k.get(cose.COSEKEYS.x) as Uint8Array | undefined, y = k.get(cose.COSEKEYS.y) as Uint8Array | undefined
  if (!x || !y || x.length !== 32 || y.length !== 32) throw bad('That passkey has a malformed public key.')
  return { x: Buffer.from(x).toString('hex'), y: Buffer.from(y).toString('hex') }
}

/** Passkeys not removed (a suspended one included: its authenticator must not register a second credential). */
const activeCredentials = (db: Db, personId: string): Credential[] => db.all<Credential>('SELECT * FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL ORDER BY created_at', personId)
/** Passkeys that can sign in, re-authenticate and approve: neither removed nor suspended. */
export const usableCredentials = (db: Db, personId: string): Credential[] => db.all<Credential>('SELECT * FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL AND suspended_at IS NULL ORDER BY created_at', personId)
export const hasPasskey = (db: Db, personId: string): boolean => usableCredentials(db, personId).length > 0
/** Passkeys that may confirm changes and approve: usable, and with full authority (a recovered one signs in only). */
export const approvingCredentials = (db: Db, personId: string): Credential[] => db.all<Credential>(`SELECT * FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL AND suspended_at IS NULL AND authority = 'full' ORDER BY created_at`, personId)
export const hasApprovingPasskey = (db: Db, personId: string): boolean => approvingCredentials(db, personId).length > 0
/** The account's authority in one word: a passkey that approves, only passkeys that sign in, or no passkey at all. */
export const authorityOf = (db: Db, personId: string): 'full' | 'restricted' | 'none' => (hasApprovingPasskey(db, personId) ? 'full' : hasPasskey(db, personId) ? 'restricted' : 'none')
/** What a passkey that signs in only is told when it tries to confirm or approve. */
export const RESTRICTED_WORDS = 'Your passkey was added by a recovery or after a password reset, so it signs you in but cannot approve payments, instructions or wallet changes, or change your protections, yet. Ask for approval authority under Security and recovery: it takes effect after a wait, and every device, email address and recovery contact of yours is told and can stop it.'
export const restrictedError = (): AppError => new AppError(409, 'authority_restricted', RESTRICTED_WORDS)

/**
 * Until when a password a reset link set confirms nothing that changes how the account gets back in: the protection
 * delay after the reset, in which every address of the person is told and the owner can act (review M1). A reset proves
 * only the mailbox; a password it set must not then replace the saved codes, change the addresses, cancel a recovery
 * under way, or stand as the second proof beside a link to that same mailbox. Null when no such hold is in force.
 */
export function passwordHeldUntil(db: Db, personId: string, now: number): number | null {
  const h = db.get<{ h: number | null }>('SELECT password_reset_at h FROM users WHERE id = ?', personId)?.h
  return h != null && now < h + PROTECTION_DELAY_MS ? h + PROTECTION_DELAY_MS : null
}
export const resetHeldError = (until: number, what: string): AppError => new AppError(409, 'authority_restricted',
  `This account's password was reset recently. Until ${whenIst(until)} it cannot ${what}: every address of the account was told of the reset, and this wait lets its owner act if someone else reset it. From then the password confirms this again; a passkey with approval authority confirms it at any time.`)

/**
 * The strongest confirmation this account can give right now: a fresh passkey confirmation, or, for an account with no
 * passkey yet (its password is then its only credential, RISK-076), a fresh re-entry of that password, unless a reset
 * set that password within the protection delay (passwordHeldUntil). Used where a change could cost the account its own
 * way back in (cancelling a recovery, new saved codes, its addresses, stepping down as someone else's recovery contact).
 */
export function strongConfirm(db: Db, s: Session, now: number): boolean {
  if (s.stepUpFresh) return true
  if (hasPasskey(db, s.userId)) return false
  // No passkey yet: the way the account signs in, given again in the last five minutes. Its password (unless a reset set it
  // within the protection delay), or, R14, Google confirmed again by an account that Google signs in to (google.ts).
  return (s.passwordStepUpFresh && passwordHeldUntil(db, s.userId, now) === null) || googleConfirms(db, s)
}
/**
 * Google confirmed again counts only for an account with no password to type (review F5): on an account that has a
 * password, a Google sign-in is an ordinary sign-in and the password stays its confirmation.
 */
export const googleConfirms = (db: Db, s: Session): boolean => s.googleStepUpFresh === true && !hasPassword(db, s.userId)
/** Whether the account has a password to type: one opened by Google alone, or with a passkey, has none ('!'). */
export const hasPassword = (db: Db, personId: string): boolean => !!db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', personId)?.pw_hash.startsWith('scrypt$')
export function confirmNeeded(db: Db, s: Session, what: string, now: number): AppError {
  if (hasApprovingPasskey(db, s.userId)) return new AppError(401, 'stepup_required', `Confirm with one of your passkeys to ${what}.`)
  if (hasPasskey(db, s.userId)) return restrictedError()
  if (!hasPassword(db, s.userId)) return new AppError(401, 'stepup_required', `Confirm with Google again to ${what}.`)
  const held = passwordHeldUntil(db, s.userId, now)
  return held !== null ? resetHeldError(held, what) : new AppError(401, 'stepup_required', `Enter your password again to ${what}.`)
}
export const handleOf = (db: Db, personId: string): string => db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', personId)?.handle ?? ''

export function storeCredential(db: Db, personId: string, info: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }, extra: { deviceType: string; backedUp: boolean; aaguid: string; name: string; authority?: 'full' | 'signin'; reason?: string; coolOffUntil?: number }, now: number): Credential {
  const { x, y } = p256Coordinates(info.publicKey)
  db.run('INSERT INTO webauthn_credentials (id, person_id, public_key, x, y, counter, transports, device_type, backed_up, aaguid, name, created_at, authority, authority_reason, cool_off_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    info.id, personId, info.publicKey, x, y, info.counter, j(info.transports ?? []), extra.deviceType, extra.backedUp ? 1 : 0, extra.aaguid, extra.name.slice(0, 60), now, extra.authority ?? 'full', extra.authority === 'signin' ? extra.reason ?? 'recovery' : null, extra.coolOffUntil ?? null)
  return db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', info.id)!
}

// ---------------------------------------------------------------------------------------------- a new passkey's cool-off

/** Until when this passkey is in its cool-off, or null when it is not (or is unknown, removed or not a passkey). */
export function coolingOffUntil(db: Db, credentialId: string | null | undefined, now: number): number | null {
  if (!credentialId) return null
  const u = db.get<{ u: number | null }>('SELECT cool_off_until u FROM webauthn_credentials WHERE id = ?', credentialId)?.u
  return u != null && u > now ? u : null
}
/**
 * What a passkey in its cool-off may not do, as the screen and the refusal say it. Loosening a protection is anything the
 * protection delay governs or that makes it easier for someone else to act for the person or harder for the person to get
 * back in: a lower floor, smaller reserve or shorter wait; removing a bill the reserve counts; lowering a business's
 * signing policy; giving a member authority; removing or allowing again another passkey; naming or ending a recovery
 * contact; new saved codes; adding or removing an address; changing the password. Adding a signer covers an on-chain
 * wallet's signers, thresholds, recovery keys and recoveries.
 */
export const COOLING_OFF_WORDS = 'approve payments above ₹10,000, loosen a protection or add a signer'
const coolOffError = (db: Db, credentialId: string, until: number, what: string): AppError => {
  const c = db.get<{ name: string; created_at: number }>('SELECT name, created_at FROM webauthn_credentials WHERE id = ?', credentialId)
  return new AppError(409, 'passkey_cooling_off', `${c?.name ?? 'This passkey'} was added to your account on ${whenIst(c?.created_at ?? until - COOL_OFF_MS)}. Until ${whenIst(until)} it cannot ${what}: a passkey added to an account waits ${Math.round(COOL_OFF_MS / 3600_000)} hours before it can ${COOLING_OFF_WORDS}. Confirm with one of your older passkeys instead, or wait. Any older passkey of yours can remove it now under Security and recovery.`)
}
/**
 * Refuses an act a passkey in its cool-off may not do, when the session's fresh confirmation came from such a passkey. A
 * session whose confirmation is fresh but whose passkey is not known (opened before schema v8, part (r)) confirms again.
 */
export function refuseCoolingOff(db: Db, s: Pick<Session, 'stepUpFresh' | 'confirmedBy'>, what: string, now: number): void {
  if (!s.stepUpFresh) return
  if (!s.confirmedBy) throw new AppError(401, 'stepup_required', `Confirm with one of your passkeys again to ${what}.`)
  const until = coolingOffUntil(db, s.confirmedBy, now)
  if (until !== null) throw coolOffError(db, s.confirmedBy, until, what)
}
/** Passkeys that approve and are past their cool-off: the ones that may become a vault's signers. */
export const settledCredentials = (db: Db, personId: string, now: number): Credential[] => approvingCredentials(db, personId).filter((c) => coolingOffUntil(db, c.id, now) === null)
/** The same for a passkey that signs an approval: refused above NEW_PASSKEY_LIMIT_PAISE while it cools off. */
export function refuseCoolingOffApproval(db: Db, credentialId: string, sizePaise: number | null, now: number): void {
  const until = coolingOffUntil(db, credentialId, now)
  if (until !== null && sizePaise !== null && sizePaise > NEW_PASSKEY_LIMIT_PAISE) throw coolOffError(db, credentialId, until, `approve this request of ${homeMoneyExact(sizePaise)}`)
}

export function securityEvent(db: Db, personId: string, kind: string, detail: unknown, now: number): void {
  db.run('INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, ?, ?)', personId, now, kind, j(detail))
  // A change to who can act for the account is also told to the person as an urgent notice, beside the history, with
  // what to do if it was not them (R10 section 7; server/notify.ts treats 'security-change' as critical and escalates it
  // if nobody acknowledges it). Delivery is inside QED only.
  // One event, one notice: the codes a completed recovery replaces are told in the recovery's own notice.
  const told = SENSITIVE[kind]
  const partOfRecovery = kind === 'recovery-codes-replaced' && (detail as { reason?: string } | null)?.reason === 'recovery'
  // ... and the codes the first device brings (R14, F1) are told in that device's own notice ('first-passkey-added')
  const withDevice = kind === 'recovery-codes-made' && ['first-device'].includes((detail as { reason?: string } | null)?.reason ?? '')
  if (told && !partOfRecovery && !withDevice) {
    notice(db, personId, { level: 'action', kind: 'security-change', title: told[0], body: told[1], subject: kind, dedupe: `security:${kind}:${now}` }, now)
    // And on every address the person has confirmed, outside QED (R12; NIST SP 800-63B-4 sections 4.2.3 and 4.6).
    notifyChannels(db, personId, { kind, title: told[0], body: told[1] }, now)
  }
}

const IF_NOT_YOU = 'If this was not you, open Security and recovery now: suspend a passkey you do not recognise from another of yours, end sessions you do not recognise, and cancel a recovery you did not start.'
/** The security events a person is told of at once, as an urgent notice: title, then what it means and what to do. */
const SENSITIVE: Record<string, [string, string]> = {
  'passkey-added': ['A passkey was added to your account', `A new passkey can now sign in for you. For its first 24 hours it cannot approve payments above ₹10,000, loosen a protection or add a signer, and one of your older passkeys can remove it at once under Security and recovery, with one of your saved recovery codes. ${IF_NOT_YOU}`],
  'first-passkey-added': ['A passkey was added to your account', `It is the account's first passkey: it now signs in and approves for you. If the account had no saved recovery codes, ten were made with it and shown once to the session that added it. ${IF_NOT_YOU}`],
  'passkey-removed-in-cool-off': ['A newly added passkey was removed from your account', `It was removed at once, during its first 24 hours, by one of your older passkeys, and can no longer sign in or sign for you. ${IF_NOT_YOU}`],
  'signin-locked': ['Wrong passwords were typed for your account', 'Five wrong passwords in a row were typed with your handle or your email address, so signing in with the password is locked for 15 minutes. Your passkeys still sign you in. If this was not you, someone knows your handle or address and is guessing your password: remove the password under Security and recovery, or change it to a long one you use nowhere else.'],
  'member-grant-scheduled': ['A member is to be given authority in a shared workspace', `It takes effect only when its delay ends, and any member who may sign can cancel it before then, under Workspace. If you did not expect it, cancel it and ask who asked for it. ${IF_NOT_YOU}`],
  'member-granted': ['A member was given authority in a shared workspace', `No member who may sign cancelled it while it waited. Workspace shows every member and their role. ${IF_NOT_YOU}`],
  'contact-grant-scheduled': ['Someone you are a recovery contact for is giving a member authority', 'In a shared workspace of theirs, a member is to be given authority to act. It takes effect only after a delay, and any member who may sign can cancel it. If they did not tell you about it, call them on a number you already have.'],
  'passkey-removed': ['A passkey was removed from your account', `It can no longer sign for you. ${IF_NOT_YOU}`],
  'passkey-removal-scheduled': ['A passkey is to be removed from your account', `It will be removed when its delay ends; any of your passkeys can cancel that. ${IF_NOT_YOU}`],
  'passkey-suspended': ['A passkey of your account was suspended', `It cannot sign or sign in until it is restored. ${IF_NOT_YOU}`],
  'password-changed': ['Your password was changed', `Every other session was signed out. ${IF_NOT_YOU}`],
  'password-removed': ['Your password was removed', `The account now signs in only with its passkeys. ${IF_NOT_YOU}`],
  'recovery-started': ['A recovery of your account has started', `It can be completed only after its delay, and any of your passkeys, or a recovery contact, can cancel it. ${IF_NOT_YOU}`],
  'recovery-completed': ['A recovery of your account was completed', `A new passkey now signs in to the account. It cannot approve payments, instructions or wallet changes until it is given approval authority, which waits and can be stopped. ${IF_NOT_YOU}`],
  'recovery-cancelled': ['A recovery of your account was stopped', 'It was cancelled from one of your devices or by a recovery contact, and cannot be completed. If you were the one trying to get back in, start again; if not, nothing more is needed.'],
  'authority-restore-requested': ['A passkey of your account asked for approval authority', `When its wait ends it can approve payments, instructions and wallet changes. Any of your other passkeys, or a recovery contact, can stop it before then. ${IF_NOT_YOU}`],
  'authority-restored': ['A passkey of your account can now approve', `It was added by a recovery or after a password reset, and its wait has ended. ${IF_NOT_YOU}`],
  'loosening-cancelled': ['A change that would have loosened your protections was stopped', 'One of your recovery contacts stopped it before its delay ended, so nothing was loosened. If you asked for it yourself, ask again; it waits its delay again. If you did not, someone may have your sign-in: check Security and recovery.'],
  'authority-restore-cancelled': ['A request for approval authority was stopped', 'The passkey that asked still signs in only. If it was yours, ask again; if not, suspend it under Security and recovery.'],
  'password-reset': ['Your password was reset', `Every session was signed out. A passkey added with the new password signs in only, until it is given approval authority after a wait. ${IF_NOT_YOU}`],
  'email-confirmed': ['Your email address was confirmed', `It is the address this account was opened with. It receives your security notices now. Like every address it can start a password reset or a recovery only after the protection delay (Security and recovery shows when). ${IF_NOT_YOU}`],
  'email-added': ['An email address was confirmed for your account', `It receives your security notices now, and can start a password reset or a recovery after the protection delay. ${IF_NOT_YOU}`],
  'email-removed': ['An email address was removed from your account', `It no longer receives notices and cannot start a reset or a recovery. ${IF_NOT_YOU}`],
  'phone-added': ['A phone number was confirmed for your account', `It receives short security notices by text message. It cannot start a reset or a recovery. ${IF_NOT_YOU}`],
  'phone-removed': ['A phone number was removed from your account', `It no longer receives security notices. ${IF_NOT_YOU}`],
  'contact-authority-requested': ['Someone you are a recovery contact for asked for approval authority', 'After a recovery, their new passkey asked to approve payments. If they did not tell you about it, cancel it under Security and recovery.'],
  'recovery-codes-replaced': ['Your saved recovery codes were replaced', `The earlier codes no longer work. ${IF_NOT_YOU}`],
  'recovery-codes-made': ['Saved recovery codes were made for your account', `They were shown once, to the session that made them. One of them is needed to suspend another device, to make new codes, and beside a second proof to recover the account. ${IF_NOT_YOU}`],
  'payee-added-in-google-session': ['A payee was added in a session opened with Google', `Signing in with Google is not your device's approval: check the payee before you pay it. ${IF_NOT_YOU}`],
  'google-linked': ['A Google account can now sign in to your account', `It signs in, as a password does: it approves nothing and changes no protection. ${IF_NOT_YOU}`],
  'google-unlinked': ['A Google account can no longer sign in to your account', `It was removed from your ways of signing in. ${IF_NOT_YOU}`],
  // a pause nobody signed in to make (review of R12, M4): told at once, with what it means if it was not the person
  'paused-with-saved-code': ['QED was paused with one of your saved recovery codes', 'Someone typed your handle and a saved code on the sign-in page. Everything QED does on its own is paused, except protective selling that runs without asking (a protective instruction set to ask first still waits for your passkey before each sale); no money moved and no one was signed in. Resume it from the status control with a passkey. If this was not you, someone has one of your saved codes: under Security and recovery, make new ones with another unused code of yours, which stops the old ones working. With no unused code left, or with more than one passkey and none, new codes cannot be made at once: name a recovery contact, or recover the account.'],
  'pause-code-failures': ['Wrong saved codes were tried for your account', 'Three or more codes that do not match were typed with your handle on the sign-in page today, to pause QED. Nothing was paused by them. If this was not you, someone knows your handle; your saved codes are still safe unless you shared them.'],
  'paused-by-contact': ['Your recovery contact paused QED for you', 'Everything QED does on its own is paused, except protective selling that runs without asking (a protective instruction set to ask first still waits for your passkey before each sale); no money moved. Resume it from the status control with a passkey. If you did not ask them to, ask them why, and choose another recovery contact under Security and recovery if you need to.'],
  'vault-recovery-started': ['A recovery of your on-chain wallet has started', `It can be completed only after its delay, and any signer can cancel it. ${IF_NOT_YOU}`],
  'vault-recovery-refused': ['A recovery of your on-chain wallet was refused', `It was confirmed with a passkey other than the one it would add, so nothing was sent. ${IF_NOT_YOU}`],
  'vault-signer-frozen': ['A suspended passkey was frozen on your on-chain wallet', 'From now its signature moves no money and changes nothing there; it can still stop things. It stays a signer until it is removed under Security.'],
  'policy-lowering-scheduled': ['A change that lowers your protections is scheduled', `It takes effect only when its delay ends, and you can cancel it before then. ${IF_NOT_YOU}`],
  'payee-added-in-password-session': ['A payee was added in a password session', `A password can be phished: check the payee before you pay it. ${IF_NOT_YOU}`],
  'payee-added-in-signin-session': ['A payee was added in a session that cannot approve', `It was added in a session opened with a passkey that signs in only (one a recovery added, or one added after a password reset): check the payee before you pay it. ${IF_NOT_YOU}`],
  'contact-recovery-started': ['Someone you are a recovery contact for has started a recovery', 'Make sure it is really them, on a call you make, before you give them a code.'],
  // a protection loosened (loosening.ts, R13): told when it is asked for, and again when it takes effect
  'profile-loosening-scheduled': ['A change that loosens your protections is scheduled', `It takes effect only when its delay ends, and any of your passkeys can cancel it before then, under Safeguards, where what it changes is listed. If someone is telling you to make this change so that a payment goes faster or money is freed, cancel it: that is how this kind of fraud works. ${IF_NOT_YOU}`],
  'profile-loosened': ['A change that loosens your protections took effect', `No passkey of yours cancelled it while it waited. Safeguards shows what is in force now. ${IF_NOT_YOU}`],
  // removing a bill that is counted in what must stay in the bank frees that money (loosening.ts requestBillRemoval)
  'bill-removal-scheduled': ['Removing a bill that your bank reserve counts is scheduled', `The bill stays, and so does the money kept for it, until the delay ends; any of your passkeys can cancel it before then, under Safeguards. ${IF_NOT_YOU}`],
  'bill-removed': ['A bill that your bank reserve counted was removed', `No passkey of yours cancelled the removal while it waited. ${IF_NOT_YOU}`],
  // a raise of the on-chain wallet's caps on earned authority (D-K1b; rail.ts announceCapsRaise, vault-watch.ts): told when
  // it is signed, and again when it comes into force
  'vault-earned-caps-raise-scheduled': ['A raise of your on-chain wallet\'s caps on earned authority is scheduled', `It lets more of what clients pay count as authority for the agent, so it waits the account's delay before it counts. Signing a lower cap before then, under Vault, stops it. If someone is telling you to raise it so that a payment can go through, do not: that is how this kind of fraud works. ${IF_NOT_YOU}`],
  'vault-earned-caps-raised': ['A raise of your on-chain wallet\'s caps on earned authority is now in force', `It waited the account's delay and no lower cap was signed meanwhile. The wallet's page shows the caps in force. ${IF_NOT_YOU}`],
  'contact-loosening-scheduled': ['Someone you are a recovery contact for is loosening a protection', 'They asked QED to protect their money less: a lower floor, a smaller reserve, or less of a wait on payments to new payees. It takes effect only after a delay, and any of their passkeys can cancel it before then. If they did not tell you about it, call them on a number you already have.'],
}

/** A session opened by a passkey. The re-authentication time starts now, because the person has just verified. */
export function openSession(db: Db, personId: string, meta: { ua: string; method: 'passkey' | 'password' | 'google'; credentialId: string | null; signinOnly?: boolean; ip?: string }, now: number): NewSession {
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url')
  const expiresAt = now + ABSOLUTE_MS
  // A passkey that signs in only (R12) opens a session with no confirmation in it: it confirms nothing.
  const confirmed = meta.method === 'passkey' && !meta.signinOnly
  db.run('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, csrf, ua, stepup_at, auth_method, credential_id, workspace_id, stepup_method, stepup_credential_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256hex(token), personId, now, now, expiresAt, csrf, meta.ua.slice(0, 200), confirmed ? now : null, meta.method, meta.credentialId, personId, confirmed ? 'passkey' : null, confirmed ? meta.credentialId : null)
  capSessions(db, personId, now)
  logAccess(db, personId, 'sign-in', { method: meta.method, ip: meta.ip ?? null, ua: meta.ua.slice(0, 200) }, now)
  return { token, csrf, userId: personId, expiresAt }
}

// ---------------------------------------------------------------------------------------------- sign-up

export function validateHandle(handle: unknown, displayName?: unknown): { handle: string; displayName: string } {
  const h = typeof handle === 'string' ? handle.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(h)) throw bad('Check the highlighted fields.', { handle: 'Use 3 to 32 letters, digits, dots, dashes or underscores.' })
  const dn = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : h
  return { handle: h, displayName: dn }
}

export async function beginSignup(db: Db, rp: RelyingParty, input: { handle: unknown; displayName?: unknown }, ip: string, now: number): Promise<{ challengeId: string; options: unknown }> {
  const c = validateHandle(input.handle, input.displayName)
  if (!rateLimit(db, `signup:${ip}`, 20, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many new accounts from this address. Try again later.')
  if (db.get('SELECT 1 FROM users WHERE handle = ?', c.handle)) throw new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' })
  const personId = newId('usr', now)
  const options = await generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: c.handle, userDisplayName: c.displayName, userID: utf8(personId),
    attestationType: 'none', supportedAlgorithmIDs: [ES256],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  return { challengeId: issueChallenge(db, 'register', null, options.challenge, { personId, ...c }, now), options }
}

export async function finishSignup(db: Db, rp: RelyingParty, input: { challengeId: unknown; response: unknown; passkeyName?: unknown }, meta: { ip: string; ua: string; replaces?: string }, now: number): Promise<{ session: NewSession; recoveryCodes: string[]; personId: string }> {
  const ch = takeChallenge(db, input.challengeId, ['register'], null, now)
  const v = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true, supportedAlgorithmIDs: [ES256] }).catch(() => null)
  if (!v?.verified || !v.registrationInfo) throw fail('The passkey could not be created. Try again.')
  const personId = String(ch.context.personId), handle = String(ch.context.handle), displayName = String(ch.context.displayName)
  const info = v.registrationInfo
  return db.tx(() => {
    if (db.get('SELECT 1 FROM users WHERE handle = ?', handle)) throw new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' })
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, personId, handle, displayName, now)
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, ?)`, personId, personId, now, personId)
    const cred = storeCredential(db, personId, info.credential, { deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, aaguid: info.aaguid, name: nameOf(input.passkeyName, meta.ua) }, now)
    // R14 (review F1): no forced step, but the codes are made with the first device, here, and shown once on the next screen
    const recoveryCodes = makeRecoveryCodes(db, personId, now)
    endPresented(db, meta.replaces, meta.ip, now)
    const session = openSession(db, personId, { ua: meta.ua, method: 'passkey', credentialId: cred.id, ip: meta.ip }, now)
    armJustMade(db, personId, sha256hex(session.token), now)
    securityEvent(db, personId, 'account-created', { passkey: cred.name, synced: cred.backed_up === 1 }, now)
    audit(db, now, personId, 'owner', 'account.create', personId, { method: 'passkey', credentialId: cred.id }, meta.ip)
    return { session, recoveryCodes, personId }
  })
}

/**
 * Sign-up with a handle and a password (D-094, 22 Nov 2026; replaces D2's "passkey only" for opening an account, not for
 * approving anything). Such an account can read everything and set up its household, and approves nothing until it adds
 * a passkey: every approval is a passkey signature over the exact terms (D3), and the approval route has no password
 * path. The new session counts as a fresh password entry, which unlocks only adding the first passkey. No saved recovery
 * codes are made now (R14: they were a forced step at sign-up); the first passkey brings them (finishAddPasskey, review F1). The ordinary sign-up, with an email address, is
 * server/access.ts signUpWithEmail; this one, with a handle alone, is kept for the accounts and programs that use it.
 */
export async function signUpWithPassword(db: Db, input: { handle: unknown; password: unknown; displayName?: unknown }, meta: { ip: string; ua: string; replaces?: string }, now: number): Promise<{ session: NewSession; personId: string }> {
  const c = validateCredentials(input.handle, input.password, input.displayName)
  if (!rateLimit(db, `signup:${meta.ip}`, 20, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many new accounts from this address. Try again later.')
  if (db.get('SELECT 1 FROM users WHERE handle = ?', c.handle)) throw new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' })
  const hash = await hashPassword(c.password)
  const personId = newId('usr', now)
  return db.tx(() => {
    if (db.get('SELECT 1 FROM users WHERE handle = ?', c.handle)) throw new AppError(409, 'handle_taken', 'That handle is already in use.', { handle: 'That handle is already in use.' })
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, ?, ?, 'person')`, personId, c.handle, c.displayName, hash, now)
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, ?)`, personId, personId, now, personId)
    endPresented(db, meta.replaces, meta.ip, now)
    const session = openSession(db, personId, { ua: meta.ua, method: 'password', credentialId: null, ip: meta.ip }, now)
    db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'password' WHERE id_hash = ?`, now, sha256hex(session.token))
    securityEvent(db, personId, 'account-created', { method: 'password' }, now)
    audit(db, now, personId, 'owner', 'account.create', personId, { method: 'password' }, meta.ip)
    return { session, personId }
  })
}

export function nameOf(given: unknown, ua: string): string {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 60)
  return /Mac OS X|Macintosh/.test(ua) ? 'Passkey on a Mac' : /iPhone|iPad/.test(ua) ? 'Passkey on an iPhone or iPad' : /Android/.test(ua) ? 'Passkey on Android' : /Windows/.test(ua) ? 'Passkey on Windows' : 'Passkey'
}

// ---------------------------------------------------------------------------------------------- sign-in and re-authentication

export async function beginLogin(db: Db, rp: RelyingParty, now: number): Promise<{ challengeId: string; options: unknown }> {
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' })
  return { challengeId: issueChallenge(db, 'login', null, options.challenge, {}, now), options }
}

/**
 * Verify an assertion over an issued challenge. `need`: 'signin' accepts any usable passkey; 'full' only one with full
 * authority (confirming and approving); 'signin-only' only one that signs in only (asking for approval authority).
 */
export async function verifyAssertion(db: Db, rp: RelyingParty, ch: ChallengeRow, response: unknown, personId: string | null, now: number, need: 'signin' | 'full' | 'signin-only' = 'full'): Promise<Credential> {
  const r = response as AuthenticationResponseJSON | undefined
  if (!r || typeof r.id !== 'string') throw fail()
  const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', r.id)
  if (!cred || cred.removed_at !== null || cred.suspended_at !== null || (personId !== null && cred.person_id !== personId)) throw fail()
  if (need === 'full' && cred.authority !== 'full') throw restrictedError()
  if (need === 'signin-only' && cred.authority === 'full') throw new AppError(409, 'authority_full', 'That passkey can already approve: nothing needs restoring.')
  const v = await verifyAuthenticationResponse({
    response: r, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true,
    credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key) as Uint8Array<ArrayBuffer>, counter: cred.counter, transports: parse(cred.transports, []) },
  }).catch(() => null)
  if (!v?.verified) throw fail()
  db.run('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?', v.authenticationInfo.newCounter, now, cred.id)
  return cred
}

export async function finishLogin(db: Db, rp: RelyingParty, input: { challengeId: unknown; response: unknown }, meta: { ip: string; ua: string }, now: number): Promise<NewSession> {
  if (!rateLimit(db, `passkey-login:${meta.ip}`, 60, 15 * 60_000, now)) throw new AppError(429, 'too_many', 'Too many sign-in attempts. Wait a few minutes.')
  const ch = takeChallenge(db, input.challengeId, ['login'], null, now)
  const cred = await verifyAssertion(db, rp, ch, input.response, null, now, 'signin')
  const kind = db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', cred.person_id)?.kind
  if (kind !== 'person') throw fail()
  // the session, its record and the person's history together, or none of them (brief item 2)
  return db.tx(() => {
    const session = openSession(db, cred.person_id, { ua: meta.ua, method: 'passkey', credentialId: cred.id, signinOnly: cred.authority !== 'full', ip: meta.ip }, now)
    securityEvent(db, cred.person_id, 'signed-in', { passkey: cred.name, device: meta.ua.slice(0, 80) }, now)
    audit(db, now, cred.person_id, 'owner', 'login', cred.person_id, { method: 'passkey', credentialId: cred.id }, meta.ip)
    return session
  })
}

/**
 * Re-authenticate inside a session: to refresh the step-up window, or to approve exact terms. For an approval the
 * challenge is the caller's (approvalChallenge, or a digest an on-chain vault's owner account checks); otherwise a
 * random one. `only` narrows the passkeys offered (a vault accepts only the passkeys that are its signers).
 */
export async function beginReauth(db: Db, rp: RelyingParty, personId: string, purpose: 'stepup' | 'approval', challenge: Uint8Array | null, context: unknown, now: number, only?: string[]): Promise<{ challengeId: string; options: unknown }> {
  if (!hasPasskey(db, personId)) throw new AppError(409, 'passkey_needed', 'Add a passkey to this account first. Approvals and changes to authority need one.')
  // Only a passkey with full authority confirms or approves (R12): one a recovery registered signs in only.
  const all = approvingCredentials(db, personId)
  if (!all.length) throw restrictedError()
  const creds = only ? all.filter((c) => only.includes(c.id)) : all
  if (!creds.length) throw new AppError(409, 'passkey_not_allowed', 'None of your passkeys may sign this.')
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required', ...(challenge ? { challenge: new Uint8Array(challenge) as Uint8Array<ArrayBuffer> } : {}), allowCredentials: creds.map((c) => ({ id: c.id, transports: parse<string[]>(c.transports, []) as never })) })
  return { challengeId: issueChallenge(db, purpose, personId, options.challenge, context, now), options }
}

export async function finishReauth(db: Db, rp: RelyingParty, s: Session, purpose: 'stepup' | 'approval', input: { challengeId: unknown; response: unknown }, now: number, ip?: string): Promise<{ credential: Credential; context: Record<string, unknown>; challenge: string }> {
  const ch = takeChallenge(db, input.challengeId, [purpose], s.userId, now)
  const credential = await verifyAssertion(db, rp, ch, input.response, s.userId, now, 'full')
  // Only a step-up made as a step-up refreshes the session's re-authentication: an assertion made to approve one
  // document must not also unlock changes to passkeys, recovery or protections for five minutes (claims review F1).
  if (purpose === 'stepup') db.tx(() => { db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'passkey', stepup_credential_id = ? WHERE id_hash = ?`, now, credential.id, s.sessionHash); logAccess(db, s.userId, 'step-up', { method: 'passkey', ip: ip ?? null }, now) })
  return { credential, context: ch.context, challenge: ch.challenge }
}

/** The challenge an approval's passkey signature covers: its id and the hash of its exact terms, and nothing else. */
export function approvalChallenge(approvalId: string, docHash: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`qed/approval/v1\n${approvalId}\n${docHash}`).digest())
}

// ---------------------------------------------------------------------------------------------- adding a passkey

export async function beginAddPasskey(db: Db, rp: RelyingParty, s: Session, now: number): Promise<{ challengeId: string; options: unknown }> {
  // A legacy account (password, no passkey yet) adds its first passkey after re-entering its password; that is the
  // only thing a password re-entry unlocks.
  const first = !hasPasskey(db, s.userId)
  // Enrolling a device is its own operation (shared/access-operations.ts). The first: after the account's ordinary sign-in
  // given again in the last five minutes, its password or, R14, Google confirmed again on an account with no password (F5). Every further one: only after a
  // confirmation by a passkey that can approve. A session alone enrols nothing.
  if (!(s.stepUpFresh || (first && (s.passwordStepUpFresh || googleConfirms(db, s))))) {
    throw new AppError(401, 'stepup_required', !first ? 'Confirm with one of your passkeys first.' : hasPassword(db, s.userId) ? 'Enter your password, then create your passkey.' : 'Confirm with Google again, then set up your device.')
  }
  const u = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', s.userId)!
  const options = await generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: u.handle, userDisplayName: u.display_name, userID: utf8(s.userId), attestationType: 'none',
    supportedAlgorithmIDs: [ES256], authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: activeCredentials(db, s.userId).map((c) => ({ id: c.id, transports: parse(c.transports, []) })),
  })
  // A password re-entry unlocks one passkey, the account's first: the finish refuses it if one exists by then.
  return { challengeId: issueChallenge(db, 'add', s.userId, options.challenge, { viaPassword: !s.stepUpFresh }, now), options }
}

/**
 * `recoveryCodes` on the answer: the saved codes, made now and shown once, when this is the account's FIRST device and it
 * holds no unused code (R14, review F1). They are made in the same transaction as the passkey. A second device makes none:
 * H2 lets the only usable passkey make codes at once, so if the first device did not bring them, whoever first held a
 * device (a thief with a synced passkey) could mint the tie-breaker and lock the owner out. Not made for a first passkey
 * added after a password reset (it signs in only: a reset proves the mailbox, not the owner).
 */
export async function finishAddPasskey(db: Db, rp: RelyingParty, s: Session, input: { challengeId: unknown; response: unknown; passkeyName?: unknown }, ua: string, now: number): Promise<Credential & { recoveryCodes?: string[]; replacedEarlier?: boolean }> {
  const ch = takeChallenge(db, input.challengeId, ['add'], s.userId, now)
  const v = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true, supportedAlgorithmIDs: [ES256] }).catch(() => null)
  if (!v?.verified || !v.registrationInfo) throw fail('The passkey could not be added. Try again.')
  const info = v.registrationInfo
  return db.tx(() => {
    if (ch.context.viaPassword === true && hasPasskey(db, s.userId)) throw new AppError(409, 'not_first', 'This account has a passkey now, so another can be added only after confirming with it.')
    // After a password reset (or a recovery), a passkey added with the password signs in only, until its approval
    // authority is restored after a wait (R12): a reset password must not become, at once, authority over money.
    const held = ch.context.viaPassword === true && db.get<{ h: number | null }>('SELECT authority_hold_at h FROM users WHERE id = ?', s.userId)?.h != null
    // A passkey added beside another starts in its cool-off (RISK-068, Q-062): one added by script in a confirmed session
    // cannot at once approve large payments, loosen a protection or add a signer, and the older one can remove it at once.
    // The account's first passkey has none: there is no older passkey to remove it (one added by an account that had only a
    // password follows D-094's rule, a password re-entry, and its risk is RISK-076's).
    const before = usableCredentials(db, s.userId).length
    const coolOffUntil = before > 0 ? now + COOL_OFF_MS : undefined
    // The first device brings the saved codes (R14, F1; H2): in this transaction, when the account holds none and the
    // passkey is not a reset's sign-in-only one.
    // R1 (second review): ALWAYS a fresh set for the first usable device, replacing every unused code made before it. Codes
    // made while the account had no device (with only the password, or Google) were made by whoever held that credential,
    // who would otherwise keep the tie-breaker for good.
    const earlier = unusedCodes(db, s.userId)
    const makeCodes = before === 0 && !held
    const cred = storeCredential(db, s.userId, info.credential, { deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, aaguid: info.aaguid, name: nameOf(input.passkeyName, ua), coolOffUntil, ...(held ? { authority: 'signin' as const, reason: 'after-password-reset' } : {}) }, now)
    securityEvent(db, s.userId, coolOffUntil ? 'passkey-added' : 'first-passkey-added', { passkey: cred.name, ...(coolOffUntil ? { coolOffUntil } : {}), ...(held ? { signinOnly: true } : {}) }, now)
    audit(db, now, s.userId, 'owner', 'passkey.add', cred.id, {})
    if (!makeCodes) return cred
    const recoveryCodes = makeRecoveryCodes(db, s.userId, now)
    armJustMade(db, s.userId, s.sessionHash, now)
    securityEvent(db, s.userId, 'recovery-codes-made', { reason: 'first-device', ...(earlier ? { replacedEarlier: earlier } : {}) }, now)
    audit(db, now, s.userId, 'owner', 'recovery-codes.make', s.userId, { reason: 'first-device', replacedEarlier: earlier })
    return { ...cred, recoveryCodes, ...(earlier ? { replacedEarlier: true } : {}) }
  })
}

// ---------------------------------------------------------------------------------------------- recovery codes

const normalizeCode = (code: string): string => code.replace(/[^A-Z0-9]/gi, '').toUpperCase()
/** Codes made before schema v3: a salted SHA-256, which part (r) of the v8 step puts under scrypt ('scrypt-sha256'). */
const sha256Code = (salt: string, code: string): string => createHash('sha256').update(`${salt}:${normalizeCode(code)}`).digest('hex')
/** A pre-v3 code as part (r) keeps it: scrypt over its SHA-256 digest (server/core.ts layerDigest). */
const layeredCode = (salt: string, code: string): string => layerDigest(sha256Code(salt, code), salt)
const layeredCodeAsync = (salt: string, code: string): Promise<string> => new Promise((resolve, reject) =>
  scrypt(sha256Code(salt, code), legacyLayerSalt(salt), LEGACY_LAYER.keylen, { N: LEGACY_LAYER.N, r: LEGACY_LAYER.r, p: LEGACY_LAYER.p, maxmem: LEGACY_LAYER.maxmem }, (e, k) => (e ? reject(e) : resolve(k.toString('hex')))))
/**
 * scrypt, the cost of an interactive login (N = 2^14): the codes carry 80 random bits, and a password-hashing function
 * keeps guessing from a copied database expensive (ASVS 5.0 V6.5.2 asks for one below 112 bits). One salt per batch,
 * so checking a code against all of a person's codes costs one hash.
 */
const SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const scryptCode = (salt: string, code: string): string => scryptSync(normalizeCode(code), Buffer.from(salt, 'hex'), 32, SCRYPT).toString('hex')
export const DUMMY_SALT = '00'.repeat(16)
/** 16 symbols of 5 bits (80 bits), in groups of four. 256 is a multiple of 32, so every symbol is equally likely. */
function newCode(): string {
  const b = randomBytes(16)
  let raw = ''
  for (let k = 0; k < 16; k++) raw += CODE_ALPHABET[b[k]! % 32]
  return raw.match(/.{4}/g)!.join('-')
}
export interface CodeRow { id: string; salt: string; code_hash: string; algo?: string }
/** The row this code matches, if any. Every row is compared, so the time does not depend on which one matched. */
export function matchCode<T extends CodeRow>(rows: T[], code: string): T | undefined {
  const bySalt = new Map<string, string>()
  let hit: T | undefined
  for (const r of rows) {
    let h: string
    if (r.algo === 'sha256') h = sha256Code(r.salt, code)
    else if (r.algo === 'scrypt-sha256') { const k = `layer:${r.salt}`; h = bySalt.get(k) ?? layeredCode(r.salt, code); bySalt.set(k, h) }
    else { h = bySalt.get(r.salt) ?? scryptCode(r.salt, code); bySalt.set(r.salt, h) }
    if (timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(r.code_hash, 'hex')) && !hit) hit = r
  }
  return hit
}

/**
 * The same, off the event loop (the QA review of R12, D-d): each scrypt takes tens of milliseconds and a person may
 * hold ten codes with ten salts, so the signed-out recovery paths, which anyone can call, derive them in the thread
 * pool instead of stopping every other request meanwhile. Their transactions check again that a code is still unused.
 */
export const scryptCodeAsync = (salt: string, code: string): Promise<string> =>
  new Promise((resolve, reject) => scrypt(normalizeCode(code), Buffer.from(salt, 'hex'), 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k.toString('hex')))))
export async function matchCodeAsync<T extends CodeRow>(rows: T[], code: string): Promise<T | undefined> {
  // no code left to compare with costs one derivation all the same, so the time does not say so (review of R12, N4)
  if (!rows.length) { await scryptCodeAsync(DUMMY_SALT, code); return undefined }
  const salts = [...new Set(rows.filter((r) => r.algo !== 'sha256' && r.algo !== 'scrypt-sha256').map((r) => r.salt))]
  const layered = [...new Set(rows.filter((r) => r.algo === 'scrypt-sha256').map((r) => r.salt))]
  const bySalt = new Map([
    ...(await Promise.all(salts.map(async (salt) => [salt, await scryptCodeAsync(salt, code)] as const))),
    ...(await Promise.all(layered.map(async (salt) => [`layer:${salt}`, await layeredCodeAsync(salt, code)] as const))),
  ])
  let hit: T | undefined
  for (const r of rows) {
    const h = r.algo === 'sha256' ? sha256Code(r.salt, code) : r.algo === 'scrypt-sha256' ? bySalt.get(`layer:${r.salt}`)! : bySalt.get(r.salt)!
    if (timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(r.code_hash, 'hex')) && !hit) hit = r
  }
  return hit
}

/**
 * A set of codes shown only once can be lost before it is saved (a reload, a dropped response), and then nobody holds the
 * tie-breaker and no route makes new codes without one (second review, R3). So the session that RECEIVED a first-device set
 * may ask for a fresh set without a code, for 30 minutes, while the account still has exactly one usable passkey and no
 * code of that set has been used. The window is kept on the server, bound to the receiving session's id (meta; no table).
 */
export const JUST_MADE_WINDOW_MS = 30 * 60_000
const windowKey = (personId: string): string => `codes-window:${personId}`
function armJustMade(db: Db, personId: string, sessionHash: string, now: number): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', windowKey(personId), j({ session: sessionHash, at: now }))
}
/** Until when this session may ask for a fresh set, or null. (Asking also needs the session's fresh passkey confirmation.) */
export function justMadeUntil(db: Db, s: Pick<Session, 'userId' | 'sessionHash'>, now: number): number | null {
  const w = parse<{ session: string; at: number } | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', windowKey(s.userId))?.value, null)
  if (!w || w.session !== s.sessionHash || now >= w.at + JUST_MADE_WINDOW_MS || now < w.at) return null
  if (usableCredentials(db, s.userId).length !== 1) return null
  if (db.get('SELECT 1 FROM recovery_codes WHERE person_id = ? AND created_at = ? AND used_at IS NOT NULL', s.userId, w.at)) return null
  if (!db.get('SELECT 1 FROM recovery_codes WHERE person_id = ? AND created_at = ? AND used_at IS NULL AND replaced_at IS NULL', s.userId, w.at)) return null
  return w.at + JUST_MADE_WINDOW_MS
}
/** A fresh set for the session that received the last first-device set and did not save it (see justMadeUntil). */
export function regenerateJustMadeCodes(db: Db, s: Session, now: number): string[] {
  if (!s.stepUpFresh) throw stepUpNeeded()
  if (justMadeUntil(db, s, now) === null) throw new AppError(409, 'codes_window_closed', 'New codes can be made without one of the old ones only by the session that was shown them, within 30 minutes, while you have one passkey and have used none of them. Use one of your saved codes, or recover the account.')
  return db.tx(() => {
    const codes = makeRecoveryCodes(db, s.userId, now)
    armJustMade(db, s.userId, s.sessionHash, now)
    securityEvent(db, s.userId, 'recovery-codes-replaced', { reason: 'not-saved' }, now)
    audit(db, now, s.userId, 'owner', 'recovery-codes.make', s.userId, { reason: 'not-saved' })
    return codes
  })
}

/** Ten new codes, shown once; earlier unused codes stop working. */
export function makeRecoveryCodes(db: Db, personId: string, now: number): string[] {
  db.run('UPDATE recovery_codes SET replaced_at = ? WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', now, personId)
  const salt = randomBytes(16).toString('hex')
  const codes: string[] = []
  for (let i = 0; i < CODES; i++) {
    const code = newCode()
    db.run(`INSERT INTO recovery_codes (id, person_id, salt, code_hash, created_at, algo) VALUES (?, ?, ?, ?, ?, 'scrypt')`, newId('rcv', now), personId, salt, scryptCode(salt, code), now)
    codes.push(code)
  }
  return codes
}

export function regenerateRecoveryCodes(db: Db, s: Session, now: number, spentCodeId?: string): string[] {
  if (!strongConfirm(db, s, now)) throw confirmNeeded(db, s, 'make new codes', now)
  refuseCoolingOff(db, s, 'make new saved codes', now)
  // H2 (below suspendPasskey): new codes while unused ones remain need one of them; with none left, only at once for a
  // person with a single usable passkey (more than one: remove the ones you no longer hold first; each waits the delay)
  const unused = unusedCodes(db, s.userId)
  if (unused > 0 && !spentCodeId) throw codeNeeded('make new ones')
  if (unused === 0 && usableCredentials(db, s.userId).length > 1) throw new AppError(409, 'codes_none', 'You have no unused saved codes and more than one usable passkey, so new codes cannot be made at once: anyone holding one of your devices could otherwise make them. Remove the passkeys you no longer hold (each waits the protection delay), or recover the account with your recovery contact.')
  return db.tx(() => {
    if (unused > 0) spendSavedCode(db, s.userId, spentCodeId!, now)
    // an account's first codes are made, not replaced (R14: none is made at sign-up); the history and the notice say which
    const first = !db.get('SELECT 1 FROM recovery_codes WHERE person_id = ?', s.userId)
    const codes = makeRecoveryCodes(db, s.userId, now); securityEvent(db, s.userId, first ? 'recovery-codes-made' : 'recovery-codes-replaced', first ? { reason: 'asked' } : {}, now); return codes
  })
}

// ---------------------------------------------------------------------------------------------- recovery contacts

const MAX_CONTACTS = 3
const CONTACT_CODE_TTL_MS = 24 * 3600_000
export interface ContactLink { id: string; person_id: string; contact_id: string; requested_at: number; effective_at: number; accepted_at: number | null; removed_at: number | null }
export const isActiveLink = (l: ContactLink, now: number): boolean => l.removed_at === null && l.accepted_at !== null && l.effective_at <= now
/** The people who can issue a recovery code for this person now. */
export function activeContacts(db: Db, personId: string, now: number): string[] {
  return db.all<ContactLink>('SELECT * FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL', personId).filter((l) => isActiveLink(l, now)).map((l) => l.contact_id)
}
const stepUpNeeded = (): AppError => new AppError(401, 'stepup_required', 'Confirm with one of your passkeys first.')

/**
 * Name a recovery contact. It makes recovering this account easier, so it takes effect only after the protection
 * delay (any passkey can withdraw it meanwhile) and only once the contact has accepted.
 */
export function nominateContact(db: Db, s: Session, handle: unknown, now: number): { linkId: string; effectiveAt: number } {
  if (!s.stepUpFresh) throw stepUpNeeded()
  refuseCoolingOff(db, s, 'name a recovery contact', now)
  const h = typeof handle === 'string' ? handle.trim().toLowerCase().replace(/^@/, '') : ''
  const c = db.get<{ id: string }>(`SELECT id FROM users WHERE handle = ? AND kind = 'person'`, h)
  if (!c) throw bad('Check the highlighted field.', { handle: 'No person has that handle here.' })
  if (c.id === s.userId) throw bad('Check the highlighted field.', { handle: 'Your recovery contact must be someone else.' })
  const links = db.all<ContactLink>('SELECT * FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL', s.userId)
  if (links.some((l) => l.contact_id === c.id)) throw new AppError(409, 'already_contact', 'That person is already your recovery contact, or has been asked.', { handle: 'Already asked.' })
  if (links.length >= MAX_CONTACTS) throw new AppError(409, 'too_many_contacts', `You can have at most ${MAX_CONTACTS} recovery contacts.`)
  const linkId = newId('rcl', now), effectiveAt = now + PROTECTION_DELAY_MS
  db.tx(() => {
    db.run('INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at) VALUES (?, ?, ?, ?, ?)', linkId, s.userId, c.id, now, effectiveAt)
    securityEvent(db, s.userId, 'recovery-contact-named', { contact: h, effectiveAt }, now)
    securityEvent(db, c.id, 'named-as-recovery-contact', { by: handleOf(db, s.userId), effectiveAt }, now)
    audit(db, now, s.userId, 'owner', 'recovery-contact.name', linkId, { contact: c.id, effectiveAt })
  })
  return { linkId, effectiveAt }
}

export function acceptContact(db: Db, s: Session, linkId: string, now: number): void {
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND contact_id = ? AND removed_at IS NULL AND accepted_at IS NULL', linkId, s.userId)
  if (!l) throw new AppError(404, 'not_found', 'That request was not found, or it was already answered.')
  db.tx(() => {
    db.run('UPDATE recovery_contacts SET accepted_at = ? WHERE id = ?', now, linkId)
    securityEvent(db, s.userId, 'accepted-recovery-contact', { for: handleOf(db, l.person_id) }, now)
    securityEvent(db, l.person_id, 'recovery-contact-accepted', { contact: handleOf(db, s.userId), effectiveAt: l.effective_at }, now)
  })
}

/** The person ends a contact (with a fresh passkey confirmation), or the contact steps down. At once, either way. */
export function removeContact(db: Db, s: Session, linkId: string, now: number): void {
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND (person_id = ? OR contact_id = ?) AND removed_at IS NULL', linkId, s.userId, s.userId)
  if (!l) throw new AppError(404, 'not_found', 'That recovery contact was not found, or it already ended.')
  if (l.person_id === s.userId && !s.stepUpFresh) throw stepUpNeeded()
  if (l.person_id === s.userId) refuseCoolingOff(db, s, 'end a recovery contact', now)
  // Stepping down removes someone else's second way back in, so the contact confirms as strongly as they can.
  if (l.contact_id === s.userId && !strongConfirm(db, s, now)) throw confirmNeeded(db, s, 'step down as a recovery contact', now)
  db.tx(() => {
    db.run('UPDATE recovery_contacts SET removed_at = ?, removed_by = ? WHERE id = ?', now, s.userId, linkId)
    db.run('UPDATE contact_codes SET replaced_at = ? WHERE link_id = ? AND used_at IS NULL AND replaced_at IS NULL', now, linkId)
    securityEvent(db, l.person_id, 'recovery-contact-ended', { contact: handleOf(db, l.contact_id), by: l.person_id === s.userId ? 'you' : 'the contact' }, now)
    securityEvent(db, l.contact_id, 'recovery-contact-role-ended', { for: handleOf(db, l.person_id) }, now)
  })
}

/**
 * A contact issues a one-time code for the person's recovery, after confirming with their own passkey. Valid for 24
 * hours; issuing another replaces it. The person's account is told at once, so a code issued on a request the person
 * never made is visible on every one of their sessions.
 */
export function issueContactCode(db: Db, s: Session, linkId: string, now: number): { code: string; expiresAt: number } {
  if (!s.stepUpFresh) throw stepUpNeeded()
  const l = db.get<ContactLink>('SELECT * FROM recovery_contacts WHERE id = ? AND contact_id = ?', linkId, s.userId)
  if (!l || !isActiveLink(l, now)) throw new AppError(409, 'contact_inactive', 'You are not an active recovery contact for this person.')
  if (!rateLimit(db, `contact-code:${l.id}`, 3, 24 * 3600_000, now)) throw new AppError(429, 'too_many', 'Three codes have been issued for this person in the last day. Try again tomorrow.')
  const code = newCode(), salt = randomBytes(16).toString('hex'), expiresAt = now + CONTACT_CODE_TTL_MS
  db.tx(() => {
    db.run('UPDATE contact_codes SET replaced_at = ? WHERE link_id = ? AND used_at IS NULL AND replaced_at IS NULL', now, l.id)
    db.run('INSERT INTO contact_codes (id, link_id, person_id, contact_id, salt, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('ccd', now), l.id, l.person_id, s.userId, salt, scryptCode(salt, code), now, expiresAt)
    securityEvent(db, s.userId, 'issued-recovery-code', { for: handleOf(db, l.person_id), expiresAt }, now)
    securityEvent(db, l.person_id, 'contact-issued-recovery-code', { contact: handleOf(db, s.userId), expiresAt }, now)
    audit(db, now, s.userId, 'owner', 'recovery-contact.issue-code', l.id, { for: l.person_id, expiresAt })
  })
  return { code, expiresAt }
}

// ---------------------------------------------------------------------------------------------- recovery

/**
 * Start a recovery with a handle, one saved code, and a second code from a different method: one a recovery contact
 * issued, or for an account made before passkeys, its password. The answer is the same whatever matched, so the
 * endpoint reveals neither which handles exist nor which code was wrong; only a full match records a request that can
 * later be completed. Nothing is granted now.
 */
export async function startRecovery(db: Db, input: { handle: unknown; code: unknown; contactCode?: unknown; password?: unknown }, ip: string, now: number): Promise<{ requestId: string; availableAt: number; reference: string }> {
  if (!rateLimit(db, `recovery:${ip}`, 10, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many recovery attempts from this address. Try again later.')
  const handle = typeof input.handle === 'string' ? input.handle.trim().toLowerCase().replace(/^@/, '') : ''
  const code = typeof input.code === 'string' ? input.code : ''
  const contactCode = typeof input.contactCode === 'string' ? input.contactCode : ''
  const password = typeof input.password === 'string' ? input.password : ''
  // The reference completes the recovery after its delay. Only this answer carries it (the database keeps its hash),
  // so a session of the account that can see the recovery listed cannot finish it (review H1). Every answer has one.
  const requestId = newId('rec', now), availableAt = now + RECOVERY_DELAY_MS, secret = randomBytes(18).toString('base64url')
  const reference = `${requestId}.${secret}`, answer = { requestId, availableAt, reference }
  const person = db.get<{ id: string; pw_hash: string }>(`SELECT id, pw_hash FROM users WHERE handle = ? AND kind = 'person'`, handle)
  // A password typed is hashed on every path, against a stand-in where the account has none or does not exist, so that
  // the time taken does not say which (review L4); the route also answers no sooner than its floor (api.ts uniform).
  const typed = async (stored: string | undefined): Promise<boolean> => (password === '' ? false : verifyPassword(password, stored?.startsWith('scrypt$') ? stored : await dummyHash()))
  if (!person || !rateLimit(db, `recovery-person:${person.id}`, 10, 24 * 3600_000, now)) { await scryptCodeAsync(DUMMY_SALT, code); await scryptCodeAsync(DUMMY_SALT, contactCode); await typed(undefined); return answer }
  const saved = await matchCodeAsync(db.all<CodeRow>('SELECT id, salt, code_hash, algo FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', person.id), code)
  const issued = db.all<CodeRow & { link_id: string }>(`SELECT c.id, c.salt, c.code_hash, c.link_id FROM contact_codes c JOIN recovery_contacts l ON l.id = c.link_id
    WHERE c.person_id = ? AND c.used_at IS NULL AND c.replaced_at IS NULL AND c.expires_at > ? AND l.removed_at IS NULL AND l.accepted_at IS NOT NULL AND l.effective_at <= ?`, person.id, now, now)
  const contact = issued.length ? await matchCodeAsync(issued, contactCode) : (await scryptCodeAsync(DUMMY_SALT, contactCode), undefined)
  const pwMatched = await typed(person.pw_hash)
  const pwOk = !contact && person.pw_hash.startsWith('scrypt$') && pwMatched
  if (!saved || !(contact || pwOk)) { audit(db, now, person.id, 'system', 'recovery.failed', person.id, { saved: !!saved, second: !!(contact || pwOk) }, ip); return answer }
  const method = contact ? 'saved+contact' : 'saved+password'
  const started = db.tx((): true | string => {
    // The password was checked before this transaction: one changed or removed meanwhile starts nothing (review L3).
    if (!contact && db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', person.id)?.pw_hash !== person.pw_hash) return 'the password changed meanwhile'
    // Single use even under concurrent attempts: a code another attempt has just used makes this one start nothing.
    if (db.run('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL', now, saved.id).changes !== 1) return 'code already used'
    if (contact && db.run('UPDATE contact_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL AND expires_at > ? AND link_id IN (SELECT id FROM recovery_contacts WHERE removed_at IS NULL AND accepted_at IS NOT NULL AND effective_at <= ?)', now, contact.id, now, now).changes !== 1) throw new AppError(409, 'retry', 'Try again.')
    db.run('INSERT INTO recovery_requests (id, person_id, code_id, contact_code_id, method, started_at, available_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', requestId, person.id, saved.id, contact?.id ?? null, method, now, availableAt, sha256hex(secret))
    securityEvent(db, person.id, 'recovery-started', { requestId, availableAt, method }, now)
    for (const c of activeContacts(db, person.id, now)) securityEvent(db, c, 'contact-recovery-started', { for: handle, availableAt }, now)
    audit(db, now, person.id, 'system', 'recovery.start', requestId, { availableAt, method }, ip)
    return true
  })
  if (started !== true) audit(db, now, person.id, 'system', 'recovery.failed', person.id, { reason: started }, ip)
  return answer
}

/**
 * Cancel an open recovery from a signed-in session. The saved code it used is spent, so (§4.2.1.1: after a saved code
 * is used, a new one is issued) every remaining saved code is replaced by a new set, shown once to this session.
 */
export function cancelRecovery(db: Db, s: Session, requestId: string, now: number): { codes: string[]; codeSpent?: boolean } {
  // A session alone (a phished password, a stolen cookie) could otherwise cancel the owner's own recovery and be handed
  // the new codes: it confirms with a passkey, or, on an account with no passkey, with the password (review M1).
  if (!strongConfirm(db, s, now)) throw confirmNeeded(db, s, 'cancel the recovery', now)
  return db.tx(() => {
    const n = db.run('UPDATE recovery_requests SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', now, `session:${s.sessionHash.slice(0, 12)}`, requestId, s.userId).changes
    if (!n) throw new AppError(404, 'not_found', 'That recovery was not found, or it already ended.')
    securityEvent(db, s.userId, 'recovery-cancelled', { requestId, by: 'a signed-in device' }, now)
    for (const c of activeContacts(db, s.userId, now)) securityEvent(db, c, 'contact-recovery-cancelled', { for: handleOf(db, s.userId) }, now)
    // A recovery started from an email link may have used no saved code (a contact's code or the password instead):
    // then nothing was spent and the codes stay. One that used a saved code spent it, so the set is replaced (§4.2.1.1).
    // H2 (re-check): it no longer replaces the codes and hands the new set to the session that cancels, which could be a
    // thief holding one of the person's devices. The code the recovery used stays spent; the person is told to make new
    // codes, which needs one of the remaining ones.
    return { codes: [] as string[], codeSpent: usedSavedCode(db, requestId) }
  })
}

/** Whether a recovery request spent one of the saved codes (every request of the backup path does; an email one may not). */
export const usedSavedCode = (db: Db, requestId: string): boolean => { const c = db.get<{ code_id: string }>('SELECT code_id FROM recovery_requests WHERE id = ?', requestId)?.code_id; return !!c && c !== 'none' }

const lapsed = (): AppError => new AppError(409, 'recovery_lapsed', `This recovery was not finished within ${Math.round(RECOVERY_FINISH_WINDOW_MS / 86_400_000)} days of its wait ending, so it lapsed. Start again if you are still locked out.`)
/** Whether a reference ("<request id>.<secret>") names an open recovery request and carries its secret. */
function recoveryByReference(db: Db, reference: unknown): { id: string; person_id: string; available_at: number; cancelled_at: number | null; completed_at: number | null } | undefined {
  const m = typeof reference === 'string' ? /^(rec_[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16,64})$/.exec(reference.trim()) : null
  if (!m) return undefined
  const r = db.get<{ id: string; person_id: string; available_at: number; cancelled_at: number | null; completed_at: number | null; secret_hash: string | null; via: string }>('SELECT * FROM recovery_requests WHERE id = ?', m[1]!)
  const want = Buffer.from(r?.secret_hash ?? '0'.repeat(64), 'hex'), got = Buffer.from(sha256hex(m[2]!), 'hex')
  // A recovery started from an email link is finished only from a link, with its finishing key (recovery.ts): its key
  // is not a reference (review H1: each way finishes only what it started).
  return r && r.secret_hash && r.via === 'codes' && want.length === got.length && timingSafeEqual(want, got) ? r : undefined
}

export async function beginRecoveryPasskey(db: Db, rp: RelyingParty, reference: unknown, now: number): Promise<{ challengeId: string; options: unknown }> {
  const r = recoveryByReference(db, reference)
  if (!r || r.cancelled_at || r.completed_at) throw new AppError(409, 'recovery_unavailable', 'That recovery reference is not open, or it is not the reference this recovery was given. It may have been cancelled from one of your passkeys.')
  if (now < r.available_at) throw new AppError(409, 'recovery_waiting', `This recovery can be completed from ${new Date(r.available_at).toISOString()}. Until then any of your passkeys can cancel it.`)
  if (now >= r.available_at + RECOVERY_FINISH_WINDOW_MS) throw lapsed()
  const u = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', r.person_id)!
  const options = await generateRegistrationOptions({ rpName: rp.name, rpID: rp.id, userName: u.handle, userDisplayName: u.display_name, userID: utf8(r.person_id), attestationType: 'none', supportedAlgorithmIDs: [ES256], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
  return { challengeId: issueChallenge(db, 'recover', r.person_id, options.challenge, { requestId: r.id }, now), options }
}

/** Register the new passkey of a recovery that has waited out its delay; issue a new set of saved codes (§4.2.1.1). */
export async function finishRecoveryPasskey(db: Db, rp: RelyingParty, input: { challengeId: unknown; response: unknown; passkeyName?: unknown }, meta: { ip: string; ua: string }, now: number): Promise<{ session: NewSession; recoveryCodes: string[]; authority: 'signin' }> {
  const ch = takeChallenge(db, input.challengeId, ['recover'], null, now)
  const v = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true, supportedAlgorithmIDs: [ES256] }).catch(() => null)
  if (!v?.verified || !v.registrationInfo) throw fail('The passkey could not be created. Try again.')
  const info = v.registrationInfo
  return db.tx(() => {
    const r = db.get<{ id: string; person_id: string; cancelled_at: number | null; completed_at: number | null; available_at: number }>('SELECT * FROM recovery_requests WHERE id = ?', String(ch.context.requestId))
    if (!r || r.person_id !== ch.person_id || r.cancelled_at || r.completed_at || now < r.available_at) throw new AppError(409, 'recovery_unavailable', 'That recovery is not open.')
    if (now >= r.available_at + RECOVERY_FINISH_WINDOW_MS) throw lapsed()
    return completeRecovery(db, r, info, { ...meta, passkeyName: input.passkeyName }, now)
  })
}

/**
 * The end of every recovery, whichever way it started: the new passkey is stored with sign-in authority only (it
 * approves nothing until a separate, delayed restoration: R12), the request is completed, the saved codes are replaced
 * when one was spent (§4.2.1.1), a hold is left so that a passkey added with the password signs in only too, everyone
 * is told, and a session opens with no confirmation in it. Called inside the caller's transaction.
 */
export function completeRecovery(db: Db, r: { id: string; person_id: string }, info: { credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }; credentialDeviceType: string; credentialBackedUp: boolean; aaguid: string }, meta: { ip: string; ua: string; passkeyName?: unknown }, now: number): { session: NewSession; recoveryCodes: string[]; authority: 'signin' } {
  const cred = storeCredential(db, r.person_id, info.credential, { deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, aaguid: info.aaguid, name: nameOf(meta.passkeyName, meta.ua), authority: 'signin', reason: 'recovery' }, now)
  db.run('UPDATE recovery_requests SET completed_at = ?, credential_id = ? WHERE id = ?', now, cred.id, r.id)
  db.run('UPDATE users SET authority_hold_at = ? WHERE id = ?', now, r.person_id)
  const spent = usedSavedCode(db, r.id)
  const recoveryCodes = spent ? makeRecoveryCodes(db, r.person_id, now) : []
  securityEvent(db, r.person_id, 'recovery-completed', { requestId: r.id, passkey: cred.name, signinOnly: true }, now)
  if (spent) securityEvent(db, r.person_id, 'recovery-codes-replaced', { reason: 'recovery' }, now)
  for (const c of activeContacts(db, r.person_id, now)) securityEvent(db, c, 'contact-recovery-completed', { for: handleOf(db, r.person_id) }, now)
  audit(db, now, r.person_id, 'owner', 'recovery.complete', r.id, { credentialId: cred.id, authority: 'signin' }, meta.ip)
  return { session: openSession(db, r.person_id, { ua: meta.ua, method: 'passkey', credentialId: cred.id, signinOnly: true, ip: meta.ip }, now), recoveryCodes, authority: 'signin' }
}

// ---------------------------------------------------------------------------------------------- suspension

/**
 * Suspend one of this person's passkeys at once: it can no longer sign in, re-authenticate or approve, the sessions it
 * opened end, and whatever it had scheduled is cancelled. The session that asks must not have been opened with it, and
 * at least one usable passkey must remain. It also spends one of the person's saved codes (`spentCodeId`, matched by
 * suspendPasskeyWithCode): independent review of the R13 fixes, H2.
 */
export function suspendPasskey(db: Db, s: Session & { credentialId?: string | null }, credentialId: string, now: number, spentCodeId?: string): void {
  if (!s.stepUpFresh) throw stepUpNeeded()
  const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL AND suspended_at IS NULL', credentialId, s.userId)
  if (!cred) throw new AppError(404, 'not_found', 'That passkey was not found, or it is already suspended.')
  if (s.credentialId === credentialId) throw new AppError(409, 'own_passkey', 'This session was opened with that passkey. Suspend it from a session opened with another of your passkeys.')
  if (usableCredentials(db, s.userId).filter((c) => c.id !== credentialId).length === 0) throw new AppError(409, 'last_passkey', 'This is your only usable passkey.')
  // H2: every suspension of another passkey spends a saved code. The re-check of the fix found that "only when it would
  // leave a single usable passkey" let a thief first add a passkey of their own (or remove a cooling-off one), so the
  // count never fell to one while the owner's passkeys were suspended.
  if (!spentCodeId) throw codeNeeded('suspend another of your passkeys')
  db.tx(() => {
    spendSavedCode(db, s.userId, spentCodeId, now)
    db.run('UPDATE webauthn_credentials SET suspended_at = ?, suspended_by = ? WHERE id = ?', now, s.credentialId ?? null, credentialId)
    db.run('UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL', now, credentialId)
    // A confirmation this passkey gave a session it did not open (one opened with a password, say) must end with it.
    // A session records only that a passkey confirmed, not which one, so every other session of the person confirms
    // again; the one that suspends keeps its own (the review of RISK-076's change, M2).
    db.run('UPDATE sessions SET stepup_at = NULL WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL', s.userId, s.sessionHash)
    db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'requester-suspended' WHERE requested_by = ? AND cancelled_at IS NULL AND applied_at IS NULL`, now, credentialId)
    securityEvent(db, s.userId, 'passkey-suspended', { passkey: cred.name }, now)
    audit(db, now, s.userId, 'owner', 'passkey.suspend', credentialId, {})
  })
}

// Independent review of the R13 fixes, H2 (25 Nov 2026). One passkey could, at once, suspend every other passkey of its
// person (they can then no longer sign in, and QED freezes them on every on-chain wallet), or make new saved codes (the
// owner's printed ones stop working). Someone holding only one of the person's devices could so lock the owner out and,
// at an admin threshold of 1, remove the frozen passkeys after the delay. Both now need one of the person's unused saved
// codes, which a device thief does not have: every suspension of another passkey, the at-once removal of one in its
// cool-off (without a code it is scheduled like any removal), and new codes while unused ones remain (with none left,
// only a person with a single usable passkey makes them at once). A cancelled recovery no longer hands new codes to the
// session that cancels it.
const codeNeeded = (what: string): AppError =>
  new AppError(409, 'code_needed', `Enter one of your saved recovery codes to ${what}. Someone holding only one of your devices does not have them.`)
/** The unused saved code this text matches (off the event loop), or an error saying what is missing. */
export async function savedCodeFor(db: Db, personId: string, code: unknown, what: string): Promise<CodeRow> {
  const typed = typeof code === 'string' ? code.trim() : ''
  if (!typed) throw codeNeeded(what)
  const hit = await matchCodeAsync(db.all<CodeRow>('SELECT id, salt, code_hash, algo FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', personId), typed)
  if (!hit) throw new AppError(403, 'code_wrong', 'That is not one of your unused saved recovery codes. Nothing was changed.')
  return hit
}
/** Spends a matched saved code inside the caller's transaction; a code spent meanwhile refuses the whole change. */
function spendSavedCode(db: Db, personId: string, codeId: string, now: number): void {
  if (db.run('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND person_id = ? AND used_at IS NULL AND replaced_at IS NULL', now, codeId, personId).changes !== 1) {
    throw new AppError(409, 'code_used', 'That saved code has just been used. Enter another one. Nothing was changed.')
  }
}
/** suspendPasskey, with the saved code it needs (H2). */
export async function suspendPasskeyWithCode(db: Db, s: Session & { credentialId?: string | null }, credentialId: string, code: unknown, now: number): Promise<void> {
  const usable = usableCredentials(db, s.userId)
  const target = usable.some((c) => c.id === credentialId) && s.credentialId !== credentialId && usable.length > 1
  const spent = s.stepUpFresh && target ? (await savedCodeFor(db, s.userId, code, 'suspend another of your passkeys')).id : undefined
  suspendPasskey(db, s, credentialId, now, spent)
}
/** scheduleRemovePasskey, with the saved code that the at-once removal of a passkey in its cool-off needs (H2). */
export async function removePasskeyWithCode(db: Db, s: Session & { credentialId?: string | null }, credentialId: string, code: unknown, now: number): Promise<ScheduledRemoval> {
  const typed = typeof code === 'string' && code.trim() !== ''
  const spent = typed && s.stepUpFresh ? (await savedCodeFor(db, s.userId, code, 'remove it at once')).id : undefined
  return scheduleRemovePasskey(db, s, credentialId, now, spent)
}
type ScheduledRemoval = { changeId: string | null; effectiveAt: number; removed?: true }
const unusedCodes = (db: Db, personId: string): number =>
  db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', personId)?.n ?? 0
/** regenerateRecoveryCodes, with the saved code it needs while unused ones remain (H2). */
export async function regenerateRecoveryCodesWithCode(db: Db, s: Session, code: unknown, now: number): Promise<string[]> {
  // the confirmation and a cooling-off passkey's refusal come first, as in regenerateRecoveryCodes: they are the more specific answers
  if (!strongConfirm(db, s, now)) throw confirmNeeded(db, s, 'make new codes', now)
  refuseCoolingOff(db, s, 'make new saved codes', now)
  const spent = unusedCodes(db, s.userId) > 0 ? (await savedCodeFor(db, s.userId, code, 'make new ones')).id : undefined
  return regenerateRecoveryCodes(db, s, now, spent)
}

/** Allowing a suspended passkey again restores authority, so it waits out the protection delay. */
export function scheduleUnsuspend(db: Db, s: Session & { credentialId?: string | null }, credentialId: string, now: number): { changeId: string; effectiveAt: number } {
  if (!s.stepUpFresh) throw stepUpNeeded()
  refuseCoolingOff(db, s, 'allow a suspended passkey again', now)
  const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL AND suspended_at IS NOT NULL', credentialId, s.userId)
  if (!cred) throw new AppError(404, 'not_found', 'That passkey is not suspended.')
  if (db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = 'unsuspend-passkey' AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, s.userId, credentialId)) throw new AppError(409, 'already_scheduled', 'Allowing this passkey again is already scheduled.')
  const changeId = newId('chg', now), effectiveAt = now + PROTECTION_DELAY_MS
  db.tx(() => {
    db.run(`INSERT INTO scheduled_changes (id, person_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, 'unsuspend-passkey', ?, ?, ?, ?, ?)`, changeId, s.userId, credentialId, j({ name: cred.name }), now, s.credentialId ?? null, effectiveAt)
    securityEvent(db, s.userId, 'passkey-unsuspend-scheduled', { passkey: cred.name, effectiveAt }, now)
  })
  return { changeId, effectiveAt }
}

// ---------------------------------------------------------------------------------------------- removal and sessions

/**
 * Schedule removal of a passkey. It keeps working until the delay ends; any other passkey can cancel the removal. A
 * passkey in its cool-off is removed at once instead when an older passkey with full authority asks (the cool-off's
 * remedy: RISK-068, Q-062); the person is told.
 */
export function scheduleRemovePasskey(db: Db, s: Session & { credentialId?: string | null }, credentialId: string, now: number, spentCodeId?: string): { changeId: string | null; effectiveAt: number; removed?: true } {
  if (!s.stepUpFresh) throw new AppError(401, 'stepup_required', 'Confirm with one of your passkeys first.')
  const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL', credentialId, s.userId)
  if (!cred) throw new AppError(404, 'not_found', 'That passkey was not found.')
  if (usableCredentials(db, s.userId).filter((c) => c.id !== credentialId).length === 0) throw new AppError(409, 'last_passkey', 'This is your only usable passkey. Add another before removing it, or you could not sign in.')
  const by = s.confirmedBy ? db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL AND suspended_at IS NULL', s.confirmedBy, s.userId) : undefined
  const olderConfirms = !!by && by.id !== credentialId && by.authority === 'full' && coolingOffUntil(db, by.id, now) === null && by.created_at < cred.created_at
  // H2: removing a passkey in its cool-off at once spends a saved code; without one it is scheduled like any removal (it
  // waits the protection delay and can be cancelled), so a thief cannot drop the owner's newest passkey at once
  if (coolingOffUntil(db, credentialId, now) !== null && olderConfirms && spentCodeId) {
    db.tx(() => {
      spendSavedCode(db, s.userId, spentCodeId, now)
      db.run(`UPDATE webauthn_credentials SET removed_at = ?, removed_reason = 'removed in its cool-off by an older passkey' WHERE id = ? AND removed_at IS NULL`, now, credentialId)
      db.run('UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL', now, credentialId)
      // a confirmation it gave a session it did not open ends with it, as on suspension; this session keeps its own
      db.run('UPDATE sessions SET stepup_at = NULL WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL AND stepup_credential_id = ?', s.userId, s.sessionHash, credentialId)
      db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'requester-removed' WHERE requested_by = ? AND cancelled_at IS NULL AND applied_at IS NULL`, now, credentialId)
      securityEvent(db, s.userId, 'passkey-removed-in-cool-off', { passkey: cred.name, addedAt: cred.created_at, by: by!.name }, now)
      audit(db, now, s.userId, 'owner', 'passkey.remove-in-cool-off', credentialId, { by: by!.id })
    })
    return { changeId: null, effectiveAt: now, removed: true }
  }
  // Removing another passkey loosens the account's protection: a passkey in its own cool-off cannot ask for it.
  refuseCoolingOff(db, s, 'remove another passkey', now)
  if (db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = 'remove-passkey' AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, s.userId, credentialId)) throw new AppError(409, 'already_scheduled', 'Removing this passkey is already scheduled.')
  const changeId = newId('chg', now), effectiveAt = now + PROTECTION_DELAY_MS
  db.tx(() => {
    db.run(`INSERT INTO scheduled_changes (id, person_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, 'remove-passkey', ?, ?, ?, ?, ?)`, changeId, s.userId, credentialId, j({ name: cred.name }), now, s.credentialId ?? null, effectiveAt)
    securityEvent(db, s.userId, 'passkey-removal-scheduled', { passkey: cred.name, effectiveAt }, now)
  })
  return { changeId, effectiveAt }
}

export function cancelScheduledChange(db: Db, s: Session, changeId: string, now: number): void {
  if (!s.stepUpFresh) throw new AppError(401, 'stepup_required', 'Confirm with one of your passkeys first.')
  // A person's own change, or a change to a workspace in which this person may sign.
  const n = db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL AND applied_at IS NULL AND (person_id = ?
      OR workspace_id IN (SELECT workspace_id FROM memberships WHERE person_id = ? AND removed_at IS NULL AND role IN ('owner', 'admin', 'approver')))`, now, s.sessionHash.slice(0, 12), changeId, s.userId, s.userId).changes
  if (!n) throw new AppError(404, 'not_found', 'That change was not found, or it already took effect.')
  securityEvent(db, s.userId, 'change-cancelled', { changeId }, now)
}

/**
 * Who is told that a change took effect: the person who asked and, in a business workspace, every member who may sign (they were
 * told when it was asked for, and could cancel it). A personal workspace has only its owner.
 */
function toldOfChange(db: Db, workspaceId: string, requester: string): string[] {
  const signers = workspaceId === requester ? [] : db.all<{ person_id: string }>(`SELECT person_id FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND role IN ('owner', 'admin', 'approver')`, workspaceId).map((m) => m.person_id)
  return [...new Set([requester, ...signers])]
}

/**
 * Apply every scheduled change whose delay has ended, and close every recovery left unfinished past its window
 * (RECOVERY_FINISH_WINDOW_MS after its wait ended). Called by the engine's tick and before security reads.
 */
export function applyDueChanges(db: Db, now: number): number {
  let applied = 0
  for (const r of db.all<{ id: string; person_id: string }>('SELECT id, person_id FROM recovery_requests WHERE cancelled_at IS NULL AND completed_at IS NULL AND available_at <= ?', now - RECOVERY_FINISH_WINDOW_MS)) {
    db.tx(() => {
      if (db.run(`UPDATE recovery_requests SET cancelled_at = ?, cancelled_by = 'expired' WHERE id = ? AND cancelled_at IS NULL AND completed_at IS NULL`, now, r.id).changes !== 1) return
      securityEvent(db, r.person_id, 'recovery-lapsed', { requestId: r.id }, now)
      audit(db, now, r.person_id, 'system', 'recovery.lapse', r.id, {})
    })
  }
  for (const c of db.all<{ id: string; person_id: string; kind: string; subject: string }>(`SELECT id, person_id, kind, subject FROM scheduled_changes WHERE cancelled_at IS NULL AND applied_at IS NULL AND kind != 'delete-account' AND effective_at <= ?`, now)) {
    db.tx(() => {
      // Read again under the write lock: a cancel (from the API, another process) may have landed since the list was read,
      // or another engine applied it. A change cancelled is never applied, and none is applied twice (R13).
      if (!db.get('SELECT 1 FROM scheduled_changes WHERE id = ? AND cancelled_at IS NULL AND applied_at IS NULL', c.id)) return
      if (c.kind === 'remove-passkey') {
        // Never remove the last passkey, even if others were removed meanwhile.
        const others = db.get<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL AND suspended_at IS NULL AND id != ?', c.person_id, c.subject)?.n ?? 0
        if (others === 0) { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'last-passkey', c.id); return }
        db.run(`UPDATE webauthn_credentials SET removed_at = ?, removed_reason = 'removed by the owner' WHERE id = ?`, now, c.subject)
        db.run('UPDATE sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL', now, c.subject)
        securityEvent(db, c.person_id, 'passkey-removed', { credentialId: c.subject }, now)
      }
      if (c.kind === 'unsuspend-passkey') {
        db.run('UPDATE webauthn_credentials SET suspended_at = NULL, suspended_by = NULL WHERE id = ? AND removed_at IS NULL', c.subject)
        securityEvent(db, c.person_id, 'passkey-unsuspended', { credentialId: c.subject }, now)
      }
      if (c.kind === 'restore-authority') {
        // Given only to the passkey that asked, and only if it is still usable and still signs in only.
        const cred = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ?', c.subject, c.person_id)
        if (!cred || cred.removed_at !== null || cred.suspended_at !== null || cred.authority === 'full') { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'no-longer-valid', c.id); return }
        db.run(`UPDATE webauthn_credentials SET authority = 'full', authority_reason = NULL WHERE id = ?`, c.subject)
        db.run('UPDATE users SET authority_hold_at = NULL WHERE id = ?', c.person_id)
        securityEvent(db, c.person_id, 'authority-restored', { passkey: cred.name }, now)
        audit(db, now, c.person_id, 'system', 'authority.restore', c.subject, { changeId: c.id })
      }
      if (c.kind === 'lower-policy') {
        // Applied as scheduled, unless members who may sign have since become too few for it.
        const d = parse<{ policy?: { signers: number; makerChecker: boolean; largeSigners: number | null }; before?: Record<string, unknown> }>(db.get<{ detail_json: string }>('SELECT detail_json FROM scheduled_changes WHERE id = ?', c.id)?.detail_json, {})
        const signers = db.get<{ n: number }>(`SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND role IN ('owner', 'admin', 'approver')`, c.subject)?.n ?? 0
        if (!d.policy || Math.max(d.policy.signers, d.policy.largeSigners ?? 0) > signers - (d.policy.makerChecker ? 1 : 0)) { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'no-longer-valid', c.id); return }
        // The change was worked out against the policy of its day and stores the whole of it. If the policy changed while
        // it waited (a raise applies at once), writing it would undo that change unseen: it lapses instead, and can be asked
        // for again against the policy as it is (R13 review, R07).
        const cur = { signers: 1, makerChecker: false, largePaise: null, largeSigners: null, bands: [], limits: {}, ...parse<Record<string, unknown>>(db.get<{ policy_json: string }>('SELECT policy_json FROM users WHERE id = ?', c.subject)?.policy_json, {}) } as Record<string, unknown>
        if (!d.before || (['signers', 'makerChecker', 'largePaise', 'largeSigners', 'bands', 'limits'] as const).some((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(d.before![k] ?? null))) {
          db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'policy-changed', c.id)
          audit(db, now, c.subject, 'system', 'policy.lowering-lapsed', c.id, { because: 'the policy changed while it waited' })
          return
        }
        db.run('UPDATE users SET policy_json = ? WHERE id = ?', j(d.policy), c.subject)
      }
      if (c.kind === 'loosen-profile') {
        // A loosening of the household's protections (loosening.ts), as asked, now that its delay has ended; the person
        // who asked is told again. Only keys a person may change, with valid values: a damaged row is not applied.
        const raw = parse<{ after?: Record<string, unknown> }>(db.get<{ detail_json: string }>('SELECT detail_json FROM scheduled_changes WHERE id = ?', c.id)?.detail_json, {}).after
        const after = Object.fromEntries(PROFILE_KEYS.filter((k) => raw && raw[k] !== undefined).map((k) => [k, raw![k]]))
        const valid = !!raw && Object.keys(after).length > 0 && Object.keys(after).length === Object.keys(raw).length && Object.keys(validateProfile(after)).length === 0 && !!db.get('SELECT 1 FROM users WHERE id = ?', c.subject)
        if (!valid) { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'no-longer-valid', c.id); return }
        saveProfile(db, c.subject, after)
        for (const who of toldOfChange(db, c.subject, c.person_id)) securityEvent(db, who, 'profile-loosened', { workspaceId: c.subject, changeId: c.id, after }, now)
        audit(db, now, c.subject, 'system', 'profile.loosen', c.id, { after, askedBy: c.person_id })
      }
      if (c.kind === 'grant-member') {
        // A member given authority (workspaces.ts requestMember), now that the delay has ended: only while whoever asked may
        // still give that role (a member, an owner or admin, not below the role), the person is still a person, and the
        // grant still raises what they have. Otherwise it lapses, said in the audit, and can be asked for again.
        const RANKS: Record<string, number> = { owner: 4, admin: 3, approver: 2, operator: 1, viewer: 0 }
        const ws = db.get<{ workspace_id: string | null; detail_json: string }>('SELECT workspace_id, detail_json FROM scheduled_changes WHERE id = ?', c.id)
        const role = parse<{ role?: string }>(ws?.detail_json, {}).role ?? ''
        const asker = ws?.workspace_id ? db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', ws.workspace_id, c.person_id)?.role : undefined
        const now_ = db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', ws?.workspace_id ?? '', c.subject)?.role
        const valid = !!ws?.workspace_id && role in RANKS && !!asker && RANKS[asker]! >= RANKS.admin! && RANKS[asker]! >= RANKS[role]! && !!db.get(`SELECT 1 FROM users WHERE id = ? AND kind = 'person'`, c.subject) && (now_ === undefined || RANKS[now_]! < RANKS[role]!)
        if (!valid) { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'no-longer-valid', c.id); audit(db, now, ws?.workspace_id ?? null, 'system', 'member.grant-lapsed', c.subject, { changeId: c.id }); return }
        db.run('INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, person_id) DO UPDATE SET role = excluded.role, removed_at = NULL', ws!.workspace_id, c.subject, role, now, c.person_id)
        const signers = db.all<{ person_id: string }>(`SELECT person_id FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND role IN ('owner', 'admin', 'approver')`, ws!.workspace_id).map((m) => m.person_id)
        for (const who of new Set([c.subject, c.person_id, ...signers])) securityEvent(db, who, 'member-granted', { workspaceId: ws!.workspace_id, changeId: c.id, person: handleOf(db, c.subject), role, before: now_ ?? null }, now)
        audit(db, now, ws!.workspace_id, 'system', 'member.grant', c.subject, { role, before: now_ ?? null, changeId: c.id, askedBy: c.person_id })
        // a live page of every member shows it (a stream carries its person's events: server/api.ts openStream)
        for (const m of db.all<{ person_id: string }>('SELECT person_id FROM memberships WHERE workspace_id = ? AND removed_at IS NULL', ws!.workspace_id)) emit(db, now, m.person_id, 'workspace', { workspaceId: ws!.workspace_id, grant: c.id })
      }
      if (c.kind === 'remove-bill') {
        // The removal of a bill the reserve counted (loosening.ts), now that its delay has ended: only a bill still due is removed.
        const owner = db.get<{ workspace_id: string | null }>('SELECT workspace_id FROM scheduled_changes WHERE id = ?', c.id)?.workspace_id ?? c.person_id
        if (db.run(`UPDATE bills SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state = 'due'`, c.subject, owner).changes !== 1) { db.run('UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', now, 'no-longer-valid', c.id); return }
        emit(db, now, owner, 'bill', { id: c.subject })
        for (const who of toldOfChange(db, owner, c.person_id)) securityEvent(db, who, 'bill-removed', { workspaceId: owner, billId: c.subject, changeId: c.id }, now)
        audit(db, now, owner, 'system', 'bill.remove', c.subject, { changeId: c.id, askedBy: c.person_id })
      }
      db.run('UPDATE scheduled_changes SET applied_at = ? WHERE id = ?', now, c.id)
      applied++
    })
  }
  return applied
}

// ---------------------------------------------------------------------------------------------- the password (D-094, RISK-076)

/** The account's handle and password hash, if it has a password: one made with a passkey, or one removed, is '!'. */
function passwordOf(db: Db, personId: string): { handle: string; pw_hash: string } | undefined {
  const u = db.get<{ handle: string; pw_hash: string }>('SELECT handle, pw_hash FROM users WHERE id = ?', personId)
  return u?.pw_hash.startsWith('scrypt$') ? u : undefined
}
const noPassword = (): AppError => new AppError(409, 'no_password', 'This account has no password: it signs in only with its passkeys.')

/**
 * Thirty attempts in fifteen minutes from one address (sign-in's own figure) and ten for one person from anywhere. Only
 * attempts that carry their confirmation are counted, each of which runs a password hash: a session refused for want
 * of one (a phished password on an account with a passkey) would otherwise use up the owner's allowance and hold back
 * the very change that shuts it out (the review of this change, M3). Wrong current passwords are limited apart, with
 * the step-up's (checkRetyped). Called outside any transaction, so that an attempt refused later still counts.
 */
function passwordAttempt(db: Db, s: Session, route: 'change' | 'remove', ip: string, now: number): void {
  if (!rateLimit(db, `password-${route}:${ip}`, 30, 15 * 60_000, now) || !rateLimit(db, `password-${route}-person:${s.userId}`, 10, 15 * 60_000, now)) {
    throw new AppError(429, 'too_many', 'Too many attempts on this password. Wait a few minutes.')
  }
}

/**
 * Ends every session of the person except this one, so whoever signed in with the old password is signed out. Returns
 * how many were still in use; rows of sessions that had already lapsed are closed too, and not counted (review L4).
 */
function endOtherSessions(db: Db, s: Session, now: number, opts: { weakOnly?: boolean } = {}): number {
  const only = opts.weakOnly ? ` AND ${WEAK_SESSION}` : ''
  const live = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sessions s WHERE s.user_id = ? AND s.id_hash != ? AND s.revoked_at IS NULL AND s.expires_at >= ? AND s.last_seen_at >= ?${only}`, s.userId, s.sessionHash, now, now - IDLE_MS)?.n ?? 0
  db.run(`UPDATE sessions SET revoked_at = ? WHERE id_hash IN (SELECT s.id_hash FROM sessions s WHERE s.user_id = ? AND s.id_hash != ? AND s.revoked_at IS NULL${only})`, now, s.userId, s.sessionHash)
  return live
}
/**
 * A session that confirms nothing by itself (api.ts weakSession): opened with a password, or with a passkey that signs in
 * only. Such a session may end sessions like itself, but not one opened with a passkey that can approve, unless it was
 * itself confirmed with such a passkey in the last five minutes: a phished password could otherwise end the owner's
 * passkey sessions again and again, and keep the owner from every remedy that needs a session (R13 review, R03).
 */
const WEAK_SESSION = `(s.auth_method <> 'passkey' OR s.credential_id IS NULL OR EXISTS (SELECT 1 FROM webauthn_credentials c WHERE c.id = s.credential_id AND c.authority = 'signin'))`
// only a session opened with a passkey that can approve is strong: a password, Google (R14) or anything else is not
const mayEndStrong = (s: Session): boolean => s.stepUpFresh || (s.authMethod === 'passkey' && s.signinOnly !== true)
/** Reset and recovery links not yet used stop working: they were sent before this change, perhaps to an address that is no longer the person's (R13 review, R05). */
export function endLinks(db: Db, personId: string, now: number): number {
  const n = db.run(`UPDATE one_time_tokens SET replaced_at = ? WHERE person_id = ? AND purpose IN ('password-reset', 'recovery-email') AND used_at IS NULL AND replaced_at IS NULL`, now, personId).changes
  if (n) redactSpent(db, now)
  return n
}

/**
 * The session as it was checked when the request began, read again inside the transaction that writes: the password
 * hashes take about a second, in which the session may have been ended, a suspension may have withdrawn its passkey
 * confirmation, or a first passkey may have been added (the review of this change, L2).
 */
function stillAsChecked(db: Db, s: Session, passkey: boolean, what: string, now: number): void {
  const row = db.get<{ revoked_at: number | null; expires_at: number; stepup_at: number | null; stepup_method: string | null }>('SELECT revoked_at, expires_at, stepup_at, stepup_method FROM sessions WHERE id_hash = ?', s.sessionHash)
  if (!row || row.revoked_at !== null || now > row.expires_at) throw new AppError(401, 'signed_out', 'Sign in to continue.')
  if (hasPasskey(db, s.userId) !== passkey) throw new AppError(409, 'retry', 'This account changed meanwhile. Reload the page and try again.')
  if (passkey && !(row.stepup_method === 'passkey' && row.stepup_at !== null && now - row.stepup_at <= STEPUP_MS)) throw confirmNeeded(db, s, what, now)
}

/**
 * Change the password. It takes the strongest confirmation the account can give. With no passkey, that is the current
 * password typed again in this very request, as ASVS 5.0 V6.2.3 asks of every change: the five-minute password
 * freshness that strongConfirm accepts elsewhere (a sign-up opens one) is not enough when that password is the thing
 * being changed. With a passkey, it is a fresh confirmation with one instead, and the current password is not asked
 * for, which departs from V6.2.3 on purpose: a password session (a phished password) cannot change it, and the owner
 * can without remembering the old one. The new password passes the sign-up rules and differs from the current one.
 * Every other session ends; this one stays.
 */
export async function changePassword(db: Db, s: Session, input: { current?: unknown; password: unknown }, ip: string, now: number): Promise<{ ended: number }> {
  const u = passwordOf(db, s.userId)
  if (!u) throw noPassword()
  const passkey = hasPasskey(db, s.userId)
  if (passkey ? !s.stepUpFresh : typeof input.current !== 'string' || input.current === '') throw confirmNeeded(db, s, 'change your password', now)
  if (passkey) refuseCoolingOff(db, s, 'change your password', now)
  const password = checkNewPassword(db, s.userId, input.password)
  passwordAttempt(db, s, 'change', ip, now)
  if (!passkey) await checkRetyped(db, s.userId, input.current, ip, now, { action: 'password.change-failed', fields: { current: 'That is not the password this account has now.' } })
  if (await verifyPassword(password, u.pw_hash)) throw bad('Check the highlighted field.', { password: 'That is the password this account has now. Choose a different one.' })
  const hash = await hashPassword(password)
  // an account opened with an address signs in with that address and the new password from now (auth.ts storeEmailLogin)
  const tag = await emailTagFor(db, s.userId, password)
  return db.tx(() => {
    stillAsChecked(db, s, passkey, 'change your password', now)
    // Written only over the password checked above: one changed or removed meanwhile, in another tab, is not overwritten.
    if (db.run('UPDATE users SET pw_hash = ? WHERE id = ? AND pw_hash = ?', hash, s.userId, u.pw_hash).changes !== 1) throw new AppError(409, 'retry', 'The password was changed or removed meanwhile. Reload the page and try again.')
    storeEmailLogin(db, s.userId, tag, hash, now)
    const ended = endOtherSessions(db, s, now)
    endLinks(db, s.userId, now)
    securityEvent(db, s.userId, 'password-changed', { ended }, now)
    audit(db, now, s.userId, 'owner', 'password.change', s.userId, { ended, confirmedWith: passkey ? 'passkey' : 'password' }, ip)
    return { ended }
  })
}

/**
 * What a recovery would lack without the password, as a sentence to act on; null when nothing. A recovery takes one
 * saved code and a code from a second method, an active recovery contact or the password (startRecovery): without the
 * password, only the contact remains, and a contact issues a code only after confirming with their own passkey
 * (issueContactCode), so one with no passkey does not count (the review of this change, M1).
 */
function wayBackWithoutPassword(db: Db, personId: string, now: number): string | null {
  const active = activeContacts(db, personId, now)
  if (!active.some((c) => hasPasskey(db, c))) {
    if (active.length) return 'Your recovery contact has no passkey yet, so cannot issue the code a recovery needs. Without the password, a recovery needs a code from an active recovery contact: ask them to add a passkey first.'
    return db.get('SELECT 1 FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL', personId)
      ? 'Your recovery contact is not active yet. Without the password, a recovery needs a code from an active recovery contact: wait until they have accepted and the delay has ended.'
      : 'Name a recovery contact first. Without the password, a recovery needs one of your saved codes and a code from a recovery contact, so with no contact, losing every passkey would lose this account.'
  }
  const codes = db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', personId)?.n ?? 0
  if (codes) return null
  // R14: none is made at sign-up, so an account may never have had any
  return db.get('SELECT 1 FROM recovery_codes WHERE person_id = ?', personId)
    ? 'Make new saved codes first. None of yours is left unused, and without the password a recovery needs one of them and a code from your recovery contact.'
    : 'Save recovery codes first, under Security. Without the password a recovery needs one of them and a code from your recovery contact, and this account has none yet.'
}

/**
 * Remove the password: the account then signs in only with its passkeys, and a password someone has learned opens
 * nothing from this moment. Only on an account with a passkey that can sign in, after a fresh confirmation with a
 * passkey (which a password session never gives), and only while a recovery would still work without the password
 * (wayBackWithoutPassword); the conditions are read in the same transaction as the change. A sign-in lock left by
 * wrong passwords is cleared with it, so the handle answers from then on as an unknown one does (review L5). Every
 * other session ends. Nothing in this build adds a password back.
 */
export function removePassword(db: Db, s: Session, ip: string, now: number): { ended: number } {
  if (!passwordOf(db, s.userId)) throw noPassword()
  if (!hasPasskey(db, s.userId)) throw new AppError(409, 'passkey_needed', 'Add a passkey first. Without its password this account signs in only with its passkeys, and it has none yet.')
  if (!s.stepUpFresh) throw confirmNeeded(db, s, 'remove your password', now)
  passwordAttempt(db, s, 'remove', ip, now)
  return db.tx(() => {
    stillAsChecked(db, s, true, 'remove your password', now)
    if (!passwordOf(db, s.userId)) throw noPassword()
    const lacking = wayBackWithoutPassword(db, s.userId, now)
    if (lacking) throw new AppError(409, 'no_way_back', lacking)
    db.run(`UPDATE users SET pw_hash = '!', failed_logins = 0, locked_until = NULL WHERE id = ?`, s.userId)
    storeEmailLogin(db, s.userId, null, '!', now) // the address no longer signs in: there is no password for it to go with
    const ended = endOtherSessions(db, s, now)
    endLinks(db, s.userId, now)
    securityEvent(db, s.userId, 'password-removed', { ended }, now)
    audit(db, now, s.userId, 'owner', 'password.remove', s.userId, { ended }, ip)
    return { ended }
  })
}

export function revokeSession(db: Db, s: Session, sessionIdPrefix: string, now: number): void {
  if (!/^[0-9a-f]{12}$/.test(sessionIdPrefix)) throw bad('That session id is not valid.')
  if (!mayEndStrong(s) && db.get(`SELECT 1 FROM sessions s WHERE s.user_id = ? AND substr(s.id_hash, 1, 12) = ? AND s.revoked_at IS NULL AND NOT ${WEAK_SESSION}`, s.userId, sessionIdPrefix)) {
    throw new AppError(401, 'stepup_required', 'That session was opened with a passkey. A session opened with a password, or with a passkey that signs in only, cannot end it: confirm with a passkey that can approve first.')
  }
  const n = db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(id_hash, 1, 12) = ? AND revoked_at IS NULL', now, s.userId, sessionIdPrefix).changes
  if (!n) throw new AppError(404, 'not_found', 'That session was not found, or it already ended.')
  securityEvent(db, s.userId, 'session-ended', { session: sessionIdPrefix }, now)
}

/**
 * End every session of this person but the one asking (the pause sheet's "Also sign out every other session", R12 task
 * comparison T6-a). Like ending one session from the list, it needs no fresh confirmation: it only takes access away,
 * and whoever is signed out signs in again with their passkey. Said in the security history with how many were in use.
 */
export function signOutOtherSessions(db: Db, s: Session, now: number): number {
  const n = endOtherSessions(db, s, now, { weakOnly: !mayEndStrong(s) })
  securityEvent(db, s.userId, 'sessions-ended-others', { n, by: s.sessionHash.slice(0, 12) }, now)
  return n
}

/** Everything the security screen shows. Applies due changes first so the list is current. */
export function securityView(db: Db, s: Session, now: number): unknown {
  applyDueChanges(db, now)
  const creds = db.all<Credential>('SELECT * FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at', s.userId)
  // The person's own changes, and every change waiting in a workspace where this person may sign: a lowering of a
  // business's signing policy must be visible, and cancellable, to every member who could cancel it.
  const pending = db.all<Record<string, unknown>>(`SELECT c.id, c.kind, c.subject, c.requested_at, c.effective_at, c.workspace_id, c.detail_json, w.display_name workspace_name, r.handle requested_by_handle
      FROM scheduled_changes c LEFT JOIN users w ON w.id = c.workspace_id LEFT JOIN users r ON r.id = c.person_id
      WHERE c.cancelled_at IS NULL AND c.applied_at IS NULL AND (c.person_id = ? OR c.workspace_id IN (SELECT workspace_id FROM memberships WHERE person_id = ? AND removed_at IS NULL AND role IN ('owner', 'admin', 'approver')))
      ORDER BY c.requested_at`, s.userId, s.userId)
    .map((c): Record<string, unknown> => ({ ...c, detail: parse(c.detail_json, {}), detail_json: undefined }))
  const contact = (l: ContactLink, other: string) => { const u = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', other); return { id: l.id, handle: u?.handle ?? '', name: u?.display_name ?? '', requestedAt: l.requested_at, effectiveAt: l.effective_at, acceptedAt: l.accepted_at, active: isActiveLink(l, now) } }
  const mine = db.all<ContactLink>('SELECT * FROM recovery_contacts WHERE person_id = ? AND removed_at IS NULL ORDER BY requested_at', s.userId)
  const theirs = db.all<ContactLink>('SELECT * FROM recovery_contacts WHERE contact_id = ? AND removed_at IS NULL ORDER BY requested_at', s.userId)
  const pw = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', s.userId)?.pw_hash ?? '!'
  const hasPw = pw.startsWith('scrypt$')
  return {
    // Whether the account has a password, and when it was last changed (null: as set when the account was made); heldUntil:
    // after a reset, until when the password confirms no change to how the account gets back in (review M1).
    password: { set: hasPw, changedAt: hasPw ? db.get<{ ts: number | null }>(`SELECT MAX(ts) ts FROM security_events WHERE person_id = ? AND kind = 'password-changed'`, s.userId)?.ts ?? null : null, ...(hasPw && passwordHeldUntil(db, s.userId, now) !== null ? { heldUntil: passwordHeldUntil(db, s.userId, now) } : {}) },
    passkeys: creds.map((c) => ({ id: c.id, name: c.name, createdAt: c.created_at, lastUsedAt: c.last_used_at, synced: c.backed_up === 1, removedAt: c.removed_at, suspendedAt: c.suspended_at, current: c.id === s.credentialId,
      // 'full': signs in, confirms and approves; 'signin': added by a recovery or after a password reset (R12)
      authority: c.authority, authorityReason: c.authority_reason,
      removalScheduledFor: (pending.find((p) => p.kind === 'remove-passkey' && p.subject === c.id)?.effective_at as number | undefined) ?? null,
      unsuspendScheduledFor: (pending.find((p) => p.kind === 'unsuspend-passkey' && p.subject === c.id)?.effective_at as number | undefined) ?? null,
      restoreScheduledFor: (pending.find((p) => p.kind === 'restore-authority' && p.subject === c.id)?.effective_at as number | undefined) ?? null,
      // the cool-off of a passkey added to the account (null when over, or never): until then it is limited, and an older passkey removes it at once
      coolOffUntil: c.removed_at === null ? coolingOffUntil(db, c.id, now) : null })),
    authority: authorityOf(db, s.userId),
    // hasPasskey: a contact issues a code only after confirming with their own passkey (issueContactCode).
    contacts: mine.map((l) => ({ ...contact(l, l.contact_id), hasPasskey: hasPasskey(db, l.contact_id) })),
    // openRecovery / pendingAuthority: what a recovery contact may cancel for the person who trusts them (R12).
    trustedBy: theirs.map((l) => ({ ...contact(l, l.person_id), pendingLoosening: !!db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind IN ('loosen-profile', 'remove-bill') AND cancelled_at IS NULL AND applied_at IS NULL`, l.person_id), openRecovery: !!db.get('SELECT 1 FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', l.person_id),
      pendingAuthority: !!db.get(`SELECT 1 FROM scheduled_changes WHERE person_id = ? AND kind = 'restore-authority' AND cancelled_at IS NULL AND applied_at IS NULL`, l.person_id) })),
    // The addresses that reach the person outside QED: confirmed or waiting for confirmation (server/recovery.ts).
    addresses: db.all<{ id: string; kind: string; address: string; created_at: number; verified_at: number | null; usable_from: number | null; replaces_id: string | null }>('SELECT id, kind, address, created_at, verified_at, usable_from, replaces_id FROM contact_points WHERE person_id = ? AND removed_at IS NULL ORDER BY created_at', s.userId)
      .map((a) => ({ id: a.id, kind: a.kind, address: a.address, addedAt: a.created_at, confirmedAt: a.verified_at, usableFrom: a.kind === 'email' ? a.usable_from : null, replaces: a.replaces_id })),
    // What a recovery would need besides a saved code: an active contact, or (accounts made before passkeys) the password.
    secondMethod: { contacts: mine.filter((l) => isActiveLink(l, now)).length, password: pw !== '!' },
    // Codes a contact issued for this account that could still be used: the owner should know at once.
    issuedForMe: db.all<{ contact_id: string; created_at: number; expires_at: number }>('SELECT contact_id, created_at, expires_at FROM contact_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL AND expires_at > ? ORDER BY created_at DESC', s.userId, now)
      .map((c) => ({ contact: handleOf(db, c.contact_id), issuedAt: c.created_at, expiresAt: c.expires_at })),
    sessions: db.all<{ id_hash: string; created_at: number; last_seen_at: number; ua: string | null; auth_method: string }>('SELECT id_hash, created_at, last_seen_at, ua, auth_method FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', s.userId, now)
      .map((x) => ({ id: x.id_hash.slice(0, 12), current: x.id_hash === s.sessionHash, createdAt: x.created_at, lastSeenAt: x.last_seen_at, device: x.ua, method: x.auth_method })),
    codesAgainUntil: justMadeUntil(db, s, now),
    recoveryCodesLeft: db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', s.userId)?.n ?? 0,
    recoveries: db.all<Record<string, unknown>>('SELECT id, started_at, available_at, cancelled_at, completed_at, via, method FROM recovery_requests WHERE person_id = ? ORDER BY started_at DESC LIMIT 10', s.userId),
    scheduled: pending,
    events: db.all<{ ts: number; kind: string; detail_json: string }>('SELECT ts, kind, detail_json FROM security_events WHERE person_id = ? ORDER BY ts DESC LIMIT 50', s.userId).map((e) => ({ ts: e.ts, kind: e.kind, detail: parse(e.detail_json, {}) })),
    delays: { recoveryMs: RECOVERY_DELAY_MS, protectionMs: PROTECTION_DELAY_MS, coolOffMs: COOL_OFF_MS, newPasskeyLimitPaise: NEW_PASSKEY_LIMIT_PAISE, testMode: TEST_DELAYS },
    // which passkey gave this session its fresh confirmation, so the screen can say when it is one in its cool-off
    confirmedBy: s.stepUpFresh ? s.confirmedBy ?? null : null,
  }
}
