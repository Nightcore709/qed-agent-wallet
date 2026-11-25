/**
 * Security and recovery (R10 section 7), in four parts kept visibly apart: signing in (where the account is signed in,
 * how each session was opened and how to end it, and its password: change or remove); passkeys (the devices that hold
 * them, what unlocks each where the platform says so, adding one with what the device will ask for, suspending and
 * removing); approving payments (what approves, what a password may do, how many must sign, what QED may do without
 * asking); recovery and signer changes (saved codes, recovery contacts, the people who trust you, and who can sign for
 * the on-chain wallet). What needs the owner comes first (a recovery under way, a code issued for them, a change waiting
 * to take effect); what happened comes last. Every change that reduces protection waits out a delay during which any
 * other passkey can cancel it; a suspected passkey is suspended at once. Also shown before the household is set up.
 * Design system "Meridian" (DESIGN.md M12): the account's state first, as four tiles that each open their part (signing
 * in, passkeys, recovery, changes waiting), then the parts as glass panels in two independent columns.
 */
import { Clock, KeyRound, Laptop, LifeBuoy, LogIn, Mail, MessageSquare, MonitorSmartphone, Smartphone, TimerReset, Usb } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Job } from '../../chain/types.ts'
import { api, ApiError, beginSignOut, endSignOut, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { addPasskey, beginGoogle, confirmWithPasskey, cosignRecovery, withdrawCosignature, deviceWords, newRecoveryCode, recoverWallet, recoveryKeyFrom, recoveryKeyRequest, requestAuthority } from '../lib/passkey.ts'
import { Btn, Field, Link, Loading, Note, PasswordField, Problem, Sheet, Stamp, useAction, useMasonry, useSession } from '../ui/kit.tsx'
import { delayWords, durationWords as dur, listed, Mark, NORMAL_DELAY_MS, sessionDevice } from './Protect.tsx'
import { useVaultApproval } from './Vault.tsx'
import { profileChangeLines } from '../lib/words.ts'
import { noDeliveryWords } from '../../shared/delivery-words.ts'
import { OPERATIONS } from '../../shared/access-operations.ts'
import { SavedCodes } from '../ui/SavedCodes.tsx'

// Safeguards and the words test read these from here; they live with the other Protect pages' helpers.
export { delayWords, sessionDevice }

/**
 * hasPasskey: given for this account's own contacts; a contact issues a recovery code only after confirming with one.
 * removalScheduledFor: ending a contact who has accepted waits the protection delay (SECURITY.md 8j (c)); when it ends.
 */
interface Contact { id: string; handle: string; name: string; requestedAt: number; effectiveAt: number; acceptedAt: number | null; active: boolean; hasPasskey?: boolean; removalScheduledFor?: number | null; removalChangeId?: string | null }
/** An address outside QED (R12): email (notices now; a way back in after the protection delay) or a phone (notices only). A confirmed email's removal waits (8j (c)). */
interface Address { id: string; kind: 'email' | 'phone'; address: string; addedAt: number; confirmedAt: number | null; usableFrom: number | null; replaces: string | null; removalScheduledFor?: number | null; removalChangeId?: string | null }
/** The changes that remove a way back in (8j (c)): any passkey of the person, or one of their saved codes, cancels one. */
const FALLBACK_REMOVALS = new Set(['remove-contact', 'remove-address', 'remove-password'])
interface SecurityView {
  passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null; synced: boolean; removedAt: number | null; suspendedAt: number | null; current: boolean; removalScheduledFor: number | null; unsuspendScheduledFor: number | null
    /** 'signin': added by a recovery or after a password reset; it approves nothing until its authority is restored (R12). */
    authority: 'full' | 'signin'; authorityReason: string | null; restoreScheduledFor: number | null
    /** Until when a passkey added to the account is limited (its cool-off, RISK-068); null when over or never. */
    coolOffUntil?: number | null }[]
  authority: 'full' | 'restricted' | 'none'
  addresses: Address[]
  sessions: { id: string; current: boolean; createdAt: number; lastSeenAt: number; device: string | null; method: string }[]
  recoveryCodesLeft: number
  /** R3: until when this session may ask for a fresh set of the codes it was shown, or null. */
  codesAgainUntil?: number | null
  recoveries: { id: string; started_at: number; available_at: number; cancelled_at: number | null; completed_at: number | null; via?: string; method?: string }[]
  scheduled: { id: string; kind: string; subject: string; requested_at: number; effective_at: number; workspace_id?: string | null; workspace_name?: string | null; requested_by_handle?: string | null; detail?: { policy?: Record<string, unknown>; before?: Record<string, number>; after?: Record<string, number>; reserve?: { before: number; after: number }; contact?: string; address?: string; replacedBy?: string } }[]
  contacts: Contact[]
  /** endingAt: they asked to end you as their contact; you stay it until then (8j (c)). */
  trustedBy: (Contact & { openRecovery: boolean; pendingAuthority: boolean; pendingLoosening: boolean; endingAt?: number | null })[]
  secondMethod: { contacts: number; password: boolean }
  /** heldUntil: after a password reset, until when the password confirms no change to how the account gets back in; removalScheduledFor: its removal waits (8j (c)). */
  password: { set: boolean; changedAt: number | null; heldUntil?: number | null; removalScheduledFor?: number | null; removalChangeId?: string | null }
  /** R2: from when the codes made with a waiting request for approval authority work (they replace the earlier ones then). */
  codesFrom?: number | null
  issuedForMe: { contact: string; issuedAt: number; expiresAt: number }[]
  events: { ts: number; kind: string; detail: Record<string, unknown> }[]
  delays: { recoveryMs: number; protectionMs: number; testMode: boolean }
  /** Whether the workspace this session acts in has an on-chain wallet: its signers are asked for only if so (EV-071). */
  wallet: { setUp: boolean }
  /** R14: whether saved codes were ever made (none is at sign-up); the address the account was opened with; Google, where configured. */
  codesMade: boolean
  email: { address: string | null; verified: boolean; pending: boolean; canVerify: boolean; simulated: boolean }
  google: { enabled: boolean; standIn: boolean; identities: { id: string; email: string | null; addedAt: number; lastUsedAt: number | null }[] }
}

const EVENT: Record<string, string> = {
  'account-created': 'Account created with a passkey', 'signed-in': 'Signed in', 'passkey-added': 'Passkey added (limited for its first 24 hours)', 'first-passkey-added': 'First passkey added',
  'passkey-removed-in-cool-off': 'A passkey added in the last 24 hours was removed at once by an older one', 'signin-locked': 'Five wrong passwords: signing in with the password was locked for 15 minutes',
  'sessions-ended-limit': 'The oldest sessions were ended: a person keeps at most 10', 'member-grant-scheduled': 'A member is to be given authority in a workspace, after the delay',
  'member-granted': 'A member was given authority in a workspace', 'workspace-role-pending': 'You are to be given a role in a workspace, after the delay',
  'workspace-role-lowered': 'A member\'s role was lowered in a workspace', 'workspace-member-removed': 'A member was removed from a workspace',
  'contact-grant-scheduled': 'Someone who trusts you is giving a member authority in a workspace',
  'passkey-removal-scheduled': 'Removal of a passkey scheduled', 'passkey-removed': 'Passkey removed', 'change-cancelled': 'Scheduled change cancelled',
  'passkey-suspended': 'Passkey suspended', 'passkey-unsuspend-scheduled': 'Allowing a suspended passkey again scheduled', 'passkey-unsuspended': 'Suspended passkey allowed again',
  'recovery-started': 'Recovery started', 'recovery-cancelled': 'Recovery stopped', 'recovery-completed': 'Recovery completed: a new passkey that signs in only was added',
  'recovery-codes-replaced': 'Recovery codes replaced', 'recovery-codes-made': 'Saved recovery codes made',
  'email-confirmed': 'The email address this account was opened with was confirmed', 'google-linked': 'A Google account was added as a way to sign in', 'google-unlinked': 'A Google account was removed from the ways to sign in',
  'payee-added-in-google-session': 'A payee was added in a session opened with Google, not with a passkey', 'session-ended': 'A session was ended', 'sessions-ended-others': 'Every other session was signed out, from one of your sessions', 'paused-with-saved-code': 'QED was paused with a saved recovery code, from the signed-out page (protective selling kept running)', 'pause-code-failures': 'Wrong saved codes were typed with your handle to pause QED (three today); nothing was paused by them',
  'paused-by-contact': 'Your recovery contact paused QED for you (protective selling kept running)', 'you-paused-for-them': 'You paused QED for someone who trusts you',
  'recovery-contact-named': 'Recovery contact named', 'recovery-contact-accepted': 'Recovery contact accepted', 'recovery-contact-ended': 'Recovery contact ended',
  'contact-issued-recovery-code': 'Your recovery contact issued a recovery code for this account',
  'named-as-recovery-contact': 'Someone named you as their recovery contact', 'accepted-recovery-contact': 'You accepted being a recovery contact',
  'issued-recovery-code': 'You issued a recovery code for someone', 'recovery-contact-role-ended': 'You are no longer someone\'s recovery contact',
  'contact-recovery-started': 'A recovery started for someone who trusts you', 'contact-recovery-cancelled': 'A recovery was cancelled for someone who trusts you',
  'contact-recovery-completed': 'A recovery completed for someone who trusts you',
  'policy-lowering-scheduled': 'A lowering of who must sign was scheduled in a workspace you belong to', 'added-to-workspace': 'You were added to a workspace',
  'vault-recovery-started': 'On-chain wallet recovery started with its code, for the passkey',
  'vault-recovery-refused': 'On-chain wallet recovery refused: it was not confirmed by the passkey it adds',
  'vault-signer-frozen': 'Suspended passkey frozen on the on-chain wallet',
  'password-changed': 'Password changed; every other session was signed out', 'password-removed': 'Password removed; the account signs in only with passkeys',
  'payee-added-in-password-session': 'A payee was added in a session opened with a password, not with a passkey',
  'payee-added-in-signin-session': 'A payee was added in a session opened with a passkey that signs in only',
  'recovery-lapsed': 'A recovery was not finished in time and lapsed',
  'authority-limited-by-upgrade': 'A passkey a recent recovery added now signs in only, until it asks for approval authority',
  'password-reset': 'Password reset with an email link; every session was signed out',
  'email-confirmation-sent': 'Confirmation sent to an email address', 'phone-confirmation-sent': 'Confirmation code sent to a phone number',
  'email-added': 'Email address confirmed', 'email-removed': 'Email address removed', 'phone-added': 'Phone number confirmed', 'phone-removed': 'Phone number removed',
  'authority-restore-requested': 'A passkey asked for approval authority', 'authority-restored': 'A passkey was given approval authority', 'authority-restore-cancelled': 'A request for approval authority was stopped',
  'contact-authority-requested': 'Someone who trusts you asked for approval authority after a recovery', 'you-stopped-recovery': 'You stopped a recovery for someone who trusts you', 'loosening-cancelled': 'A recovery contact stopped a change that would have loosened your protections', 'you-stopped-loosening': 'You stopped a loosening of protections for someone who trusts you',
  'profile-loosening-scheduled': 'A change that loosens your protections was asked for; it waits before it takes effect', 'profile-loosened': 'A change that loosens your protections took effect after its wait',
  'contact-loosening-scheduled': 'Someone who trusts you asked to loosen a protection',
  // removing a way back in waits (SECURITY.md 8j (c), R14)
  'recovery-contact-removal-scheduled': 'Ending a recovery contact was asked for; it waits before it takes effect',
  'contact-role-ending-scheduled': 'Someone who trusts you asked to end you as their recovery contact; you stay it until the wait ends',
  'contact-role-continues': 'Someone who trusts you cancelled ending you as their recovery contact',
  'email-removal-scheduled': 'Removing an email address was asked for; it waits before it takes effect',
  'password-removal-scheduled': 'Removing your password was asked for; it waits before it takes effect',
  'password-removal-lapsed': 'Removing your password did not take effect: without it, a recovery would have had no second proof',
}
/** How a recovery was started, in words. */
const METHOD_WORDS: Record<string, string> = { 'email+saved': 'an email link and a saved code', 'email+contact': 'an email link and a recovery contact\'s code', 'email+password': 'an email link and the password', 'saved+contact': 'a saved code and a recovery contact\'s code', 'saved+password': 'a saved code and the password' }
/**
 * An event in words. An account opened with a password says so (its creation is recorded with the method). A pause asked
 * for with a saved code or by a recovery contact while QED was already paused changed nothing, and says so; protective
 * selling is said to keep running only when it did (R13: recorded since then; an older event claims nothing about it).
 */
export function eventWords(e: { kind: string; detail: Record<string, unknown> }): string {
  if (e.kind === 'account-created' && e.detail.method === 'password') return 'Account created with a password'
  if (e.kind === 'account-created' && e.detail.method === 'google') return 'Account created with Google'
  if (e.kind === 'signed-in' && e.detail.method === 'google') return 'Signed in with Google'
  if (e.kind === 'recovery-codes-made' && (e.detail.reason === 'first-device' || e.detail.reason === 'second-device')) return 'Saved recovery codes made, with your first device'
  if (e.kind === 'recovery-codes-made' && e.detail.reason === 'recovery') return 'Saved recovery codes made, with the recovery'
  // R2: the codes made with a request for approval authority come into force when it is given
  if (e.kind === 'recovery-codes-made' && e.detail.reason === 'authority-restored') return 'The saved recovery codes made with the request for approval authority now work'
  if (e.kind === 'recovery-codes-replaced' && e.detail.reason === 'authority-restored') return 'The saved recovery codes made with the request for approval authority now work; earlier codes no longer do'
  if (e.kind === 'change-cancelled' && e.detail.with === 'saved-code') return 'A scheduled change was cancelled with a saved recovery code'
  if (e.kind === 'password-changed' && e.detail.removalCancelled === true) return 'Password changed; every other session was signed out, and the waiting removal of the password was cancelled'
  // a confirmation the local test outbox kept was not sent, and is not said to be (R13; recorded since then)
  if (e.detail.simulated === true && (e.kind === 'email-confirmation-sent' || e.kind === 'phone-confirmation-sent')) return `A confirmation for ${e.kind === 'email-confirmation-sent' ? 'an email address' : 'a phone number'} was kept in the simulated outbox, not sent`
  if ((e.kind === 'paused-with-saved-code' || e.kind === 'paused-by-contact') && e.detail.already === true) {
    const said = e.detail.protectiveContinues === true ? ' (protective selling kept running)' : e.detail.protectiveContinues === false ? ' (protective selling stays stopped)' : ''
    return `${e.kind === 'paused-with-saved-code' ? 'A saved recovery code was used to pause QED from the signed-out page' : 'Your recovery contact asked to pause QED for you'}; it was already paused, so nothing changed${said}`
  }
  return EVENT[e.kind] ?? e.kind
}
/** What a scheduled lowering of a workspace's signing policy changes, in words. */
export function policyLowering(d: { policy?: Record<string, unknown>; before?: Record<string, unknown> } | undefined): string {
  const a = d?.before ?? {}, b = d?.policy ?? {}
  const parts: string[] = []
  if (typeof a.signers === 'number' && typeof b.signers === 'number' && b.signers < a.signers) parts.push(`${a.signers} signatures for every request become ${b.signers}`)
  if (a.makerChecker && !b.makerChecker) parts.push('whoever prepares a request may also sign it')
  if (a.largeSigners !== b.largeSigners || a.largePaise !== b.largePaise) parts.push('fewer signatures for large amounts')
  if (JSON.stringify(a.bands ?? []) !== JSON.stringify(b.bands ?? [])) parts.push('the amount bands ask for fewer signatures, or start higher')
  if (JSON.stringify(a.limits ?? {}) !== JSON.stringify(b.limits ?? {})) parts.push('a member\'s limit is raised or removed')
  return parts.join('; ') || 'protection is lowered'
}

/**
 * What unlocks a passkey, where its name says which system made it: the server names an unnamed passkey after the
 * system the browser reported when it was made (server/passkeys.ts nameOf). A name the owner chose, or a plain
 * "Passkey", says nothing about the device, so nothing is claimed for it.
 */
export function unlockWords(name: string): string | null {
  // examples of what the platform offers, always with its check that is not a biometric (R12: no promise of one method)
  if (name === 'Passkey on a Mac') return 'Unlocked by the Mac\'s own check, such as Touch ID or its password'
  if (name === 'Passkey on an iPhone or iPad') return 'Unlocked by the device\'s own check, such as Face ID, Touch ID or its passcode'
  if (name === 'Passkey on Android') return 'Unlocked by the device\'s own check, such as a fingerprint, face or screen lock'
  if (name === 'Passkey on Windows') return 'Unlocked by Windows Hello, such as a face, fingerprint or PIN'
  return null
}
/** The device a passkey's name points to, drawn as a glyph beside it (decoration: the name says the same). */
function DeviceGlyph({ name }: { name: string }) {
  const I = /iPhone|iPad|Android|phone/i.test(name) ? Smartphone : /Mac|Windows|laptop|computer|desktop/i.test(name) ? Laptop : /security key|yubikey/i.test(name) ? Usb : KeyRound
  return <span className="sy-glyph" aria-hidden="true"><I /></span>
}

/** Re-authenticate first when the server needs it, then act. */
async function withPasskey<T>(fresh: boolean | undefined, fn: () => Promise<T>): Promise<T> { if (!fresh) await confirmWithPasskey(); return fn() }

/** The head of one part of the page: its name, a figure on the right, and one sentence on what it is for. */
function PartHead({ id, level = 2, title, aside, children }: { id: string; level?: 2 | 3; title: string; aside?: ReactNode; children?: ReactNode }) {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <div className={level === 2 ? 'pg-sec-head' : 'sy-part-head'}>
      <div className="pg-sec-t"><H id={id}>{title}</H>{aside ? <span className="pg-aside">{aside}</span> : null}</div>
      {children ? <p className="pg-note">{children}</p> : null}
    </div>
  )
}

export function SecurityScreen() {
  const { session, reload } = useSession()
  const now = useNow(30_000)
  const v = useData<SecurityView>('/api/security', ['security'])
  const [codes, setCodes] = useState<string[] | null>(null)
  // H2 (independent review of the R13 fixes): leaving one usable passkey, or making new codes, needs a saved code
  const [savedCode, setSavedCode] = useState('')
  const [codeSpent, setCodeSpent] = useState(false)
  const [legacyPw, setLegacyPw] = useState('')
  const [keyName, setKeyName] = useState('')
  const [contactHandle, setContactHandle] = useState('')
  const [issued, setIssued] = useState<{ linkId: string; code: string; expiresAt: number } | null>(null)
  const [confirmIssue, setConfirmIssue] = useState<string | null>(null)
  const [endingAll, setEndingAll] = useState(false)
  const board = useMasonry()
  const fresh = () => session.stepUpFresh
  // The strongest confirmation this account can give: its passkey, or, with no passkey yet, the password typed in the
  // field of the note above (the server asks the same; review of D-094, M1).
  const strongly = async (): Promise<void> => {
    if (session.hasPasskey) { if (!session.stepUpFresh) await confirmWithPasskey(); return }
    // an account Google signs in to, with no password and no device yet: the server asks for Google again when it must
    if (session.hasPassword === false) return
    if (!legacyPw) throw new ApiError(401, 'stepup_required', 'Type your password in the field above first: this account has no passkey to confirm with.')
    await api('POST', '/api/auth/stepup', { password: legacyPw })
  }
  // R14 (F1): the saved codes the account's first device brings, shown once, where it was added
  const [deviceCodes, setDeviceCodes] = useState<string[] | null>(null), [deviceReplaced, setDeviceReplaced] = useState(false)
  // R3: the codes made a moment ago were not saved: a fresh set, by the session that was shown them, within 30 minutes
  const codesAgain = useAction(async () => { await strongly(); const r = await api<{ codes: string[] }>('POST', '/api/security/recovery-codes/again'); setDeviceCodes(r.codes); setDeviceReplaced(true); v.reload() })
  const add = useAction(async () => {
    // the first device: after the password typed again, or (an account Google signs in to) Google confirmed again
    if (!session.hasPasskey && session.hasPassword !== false) await api('POST', '/api/auth/stepup', { password: legacyPw })
    else if (session.hasPasskey && !session.stepUpFresh) await confirmWithPasskey()
    let made: Awaited<ReturnType<typeof addPasskey>>
    try { made = await addPasskey(keyName.trim() || undefined) }
    catch (e) { if (!session.hasPasskey && session.hasPassword === false && e instanceof ApiError && e.code === 'stepup_required') await beginGoogle('confirm', '/security#passkeys'); throw e }
    if (made.recoveryCodes) { setDeviceCodes(made.recoveryCodes); setDeviceReplaced(made.replacedEarlier === true) }
    setLegacyPw(''); setKeyName(''); await reload(); v.reload()
  })
  const confirmGoogle = useAction(async () => { await beginGoogle('confirm', '/security#passkeys') })
  const linkGoogle = useAction(async () => { await strongly(); await beginGoogle('link', '/security#sign-in') })
  const unlinkGoogle = useAction(async (id: string) => { await strongly(); await api('POST', `/api/security/google/${id}/remove`); v.reload() })
  const resend = useAction(async () => { await api('POST', '/api/security/email/resend'); await reload(); v.reload() })
  const remove = useAction(async (id: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/passkeys/${id}/remove`, { code: savedCode.trim() || undefined })); setSavedCode(''); v.reload() })
  const suspend = useAction(async (id: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/passkeys/${id}/suspend`, { code: savedCode.trim() || undefined })); setSavedCode(''); v.reload() })
  const unsuspend = useAction(async (id: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/passkeys/${id}/unsuspend`)); v.reload() })
  // A removal of a way back in (8j (c)) is cancelled with the account's strongest confirmation (a passkey; with none, the
  // password), or with one of the saved codes, typed below it; every other change with a passkey, as before.
  const cancel = useAction(async (c: { id: string; kind: string }) => {
    if (FALLBACK_REMOVALS.has(c.kind)) { await strongly(); await api('POST', `/api/security/changes/${c.id}/cancel`) }
    else await withPasskey(fresh(), () => api('POST', `/api/security/changes/${c.id}/cancel`))
    v.reload()
  })
  const [codeFor, setCodeFor] = useState<string | null>(null), [cancelCode, setCancelCode] = useState('')
  const cancelWithCode = useAction(async (id: string) => { await api('POST', `/api/security/changes/${id}/cancel`, { code: cancelCode.trim() }); setCancelCode(''); setCodeFor(null); v.reload() })
  // whether the codes shown are the account's first (R14: none is made at sign-up), so the page does not speak of "earlier codes"
  const [codesFirst, setCodesFirst] = useState(false)
  const regen = useAction(async () => { await strongly(); const first = v.data?.codesMade === false; const r = await api<{ codes: string[] }>('POST', '/api/security/recovery-codes', { code: savedCode.trim() || undefined }); setSavedCode(''); setCodesFirst(first); setCodes(r.codes); await reload(); v.reload() })
  // Cancelling spends the saved code the recovery used, so the server issues a new set; it is shown once, below. It
  // needs the account's strongest confirmation, so a phished password cannot cancel the owner's own recovery.
  // A recovery started by email may have spent no saved code: then no new set comes back, and none is shown.
  const cancelRecovery = useAction(async (id: string) => { await strongly(); const r = await api<{ codes: string[]; codeSpent?: boolean }>('POST', `/api/security/recoveries/${id}/cancel`); setCodes(r.codes.length ? r.codes : null); setCodeSpent(!!r.codeSpent); v.reload() })
  const end = useAction(async (id: string) => { await api('POST', `/api/security/sessions/${id}/revoke`); v.reload() })
  // Every session of the account ends, this one too: a change of who is signed in, so the passkey confirms it.
  const endAll = useAction(async () => { if (!session.stepUpFresh) await confirmWithPasskey(); beginSignOut(); try { await api('POST', '/api/auth/logout-everywhere') } catch (e) { endSignOut(); throw e } await reload(); navigate('/', true) })
  const nominate = useAction(async () => { await withPasskey(fresh(), () => api('POST', '/api/security/contacts', { handle: contactHandle })); setContactHandle(''); v.reload() })
  // Ending one's own contact needs the passkey; stepping down as someone else's contact removes their way back in, so
  // it needs this account's strongest confirmation too.
  const endContact = useAction(async (c: { id: string; mine: boolean }) => { if (c.mine) await withPasskey(fresh(), () => api('POST', `/api/security/contacts/${c.id}/remove`)); else { await strongly(); await api('POST', `/api/security/contacts/${c.id}/remove`) } v.reload() })
  const accept = useAction(async (id: string) => { await api('POST', `/api/security/contacts/${id}/accept`); v.reload() })
  const issue = useAction(async (id: string) => { const r = await withPasskey(fresh(), () => api<{ code: string; expiresAt: number }>('POST', `/api/security/contacts/${id}/code`)); setConfirmIssue(null); setIssued({ linkId: id, ...r }); v.reload() })
  // R12: a passkey that signs in only asks for approval authority with itself; the request waits and anyone of yours can stop it.
  // R2: a passkey added after a password reset gets its saved codes with the request, shown once here
  const [authorityCodes, setAuthorityCodes] = useState<{ codes: string[]; from: number } | null>(null)
  const askAuthority = useAction(async () => { const r = await requestAuthority(); if (r.recoveryCodes) setAuthorityCodes({ codes: r.recoveryCodes, from: r.effectiveAt }); await reload(); v.reload() })
  // Stopping it: from the session of the passkey that asked, or after a confirmation with a passkey that has authority.
  const stopAuthority = useAction(async (id: string) => {
    try { await api('POST', `/api/security/authority/${id}/cancel`) }
    catch (e) { if (e instanceof ApiError && e.code === 'stepup_required') { await confirmWithPasskey(); await api('POST', `/api/security/authority/${id}/cancel`) } else throw e }
    await reload(); v.reload()
  })
  const grantAuthority = useAction(async (id: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/authority/${id}/grant`)); await reload(); v.reload() })
  // A recovery contact stops what is under way for the person who trusts them, with their own passkey.
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  const [confirmLoosening, setConfirmLoosening] = useState<string | null>(null)
  const stopLoosening = useAction(async (linkId: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/contacts/${linkId}/cancel-loosening`)); setConfirmLoosening(null); v.reload() })
  const stopForThem = useAction(async (linkId: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/contacts/${linkId}/cancel-recovery`)); setConfirmStop(null); v.reload() })
  // ... and can pause QED for them, never resume it (R12 task comparison, T6-d)
  const [confirmPause, setConfirmPause] = useState<string | null>(null)
  const [pausedFor, setPausedFor] = useState<string | null>(null)
  const pauseForThem = useAction(async (linkId: string) => { await withPasskey(fresh(), () => api('POST', `/api/security/contacts/${linkId}/pause`)); setConfirmPause(null); setPausedFor(linkId); v.reload() })
  if (!v.data) return v.error ? <div className="security"><SecurityHead /><Problem error={v.error} /></div> : <div className="security" aria-busy="true"><SecurityHead /><Loading what="Reading your passkeys, recovery and sessions" /></div>
  const s = v.data
  const open = s.recoveries.filter((r) => !r.cancelled_at && !r.completed_at)
  const usable = s.passkeys.filter((p) => !p.removedAt && !p.suspendedAt)
  // A contact can issue a code only with a passkey of their own: one without is active, but no second code yet.
  const issuer = s.contacts.find((c) => c.active && c.hasPasskey)
  const activeContact = issuer ?? s.contacts.find((c) => c.active)
  const noSecond = !issuer && !s.secondMethod.password
  const wait = delayWords(s.delays.protectionMs)
  const needs = open.length + s.issuedForMe.length + s.scheduled.length
  const signinOnly = s.passkeys.filter((p) => !p.removedAt && !p.suspendedAt && p.authority === 'signin')
  const usableEmail = s.addresses.some((a) => a.kind === 'email' && a.confirmedAt !== null && a.usableFrom !== null && a.usableFrom <= now)
  const byPassword = s.sessions.filter((x) => x.method === 'password').length
  const pol = session.workspace?.policy as { signers: number; makerChecker: boolean; largePaise?: number | null; largeSigners?: number | null } | undefined
  return (
    <div className="security">
      <SecurityHead wait={wait} />
      {s.delays.testMode ? <p className="sy-test"><Clock aria-hidden="true" /><span><b>Test mode: shortened delays.</b> Recovery waits {dur(s.delays.recoveryMs)} and protection-reducing changes {dur(s.delays.protectionMs)} on this installation, for testing; the on-chain wallet's own delays are said where they apply. The normal delay is {dur(NORMAL_DELAY_MS)}.</span></p> : null}

      <SecuritySummary sessions={s.sessions.length} password={s.password.set} usable={usable.length} hasPasskey={!!session.hasPasskey}
        recoveryReady={(usableEmail && (s.recoveryCodesLeft > 0 || !noSecond)) || (!noSecond && s.recoveryCodesLeft > 0)} codesLeft={s.recoveryCodesLeft} codesMade={s.codesMade} contact={activeContact ? `@${activeContact.handle}` : null} email={usableEmail} waiting={needs} />

      {needs ? (
        <section className="sy-needs" aria-labelledby="sy-needs-h">
          <PartHead id="sy-needs-h" title="Needs you" aside={<><span className="count" aria-hidden="true">{needs}</span><span className="sr">{needs} item{needs === 1 ? '' : 's'}</span></>}>{s.scheduled.length ? `Each change below weakens a protection, so it waits. Until the time shown, any of your passkeys can cancel it; after that it applies by itself.${s.scheduled.some((c) => FALLBACK_REMOVALS.has(c.kind)) ? ' Removing a way back in (a recovery contact, an email address, your password) can also be cancelled with one of your saved recovery codes.' : ''}` : null}</PartHead>
          <ul className="sy-need-list">
            {open.map((r) => (
              <li key={r.id} className="sy-need urgent">
                <div role="alert"><h3>Someone started a recovery of this account</h3><p>With {METHOD_WORDS[r.method ?? ''] ?? 'recovery codes'}, {fmt.dayTime(r.started_at)}. If it was not you, cancel it now: otherwise a new passkey can be added from {fmt.full(r.available_at)}. It would sign in only, and could approve nothing until it asked for authority and waited again.</p></div>
                <div className="sy-need-acts"><Btn tone="void" busy={cancelRecovery.busy} onClick={() => void cancelRecovery.run(r.id)}>Cancel this recovery</Btn></div>
              </li>
            ))}
            {s.issuedForMe.map((c) => (
              <li key={c.issuedAt} className="sy-need">
                <div><h3>@{c.contact} issued a recovery code for your account</h3><p>At {fmt.dayTime(c.issuedAt)}; it works until {fmt.full(c.expiresAt)}, and only together with one of your saved codes. If you did not ask for it, tell them, and end them as a contact below.</p></div>
              </li>
            ))}
            {s.scheduled.map((c) => {
              const name = s.passkeys.find((p) => p.id === c.subject)?.name ?? c.subject
              if (c.kind === 'restore-authority') return (
                <li key={c.id} className="sy-need">
                  <div>
                    <h3>{`"${name}" asked for approval authority`}</h3>
                    <p>A passkey added by a recovery or after a password reset. It can approve payments, instructions and wallet changes from {fmt.full(c.effective_at)} ({fmt.rel(c.effective_at, now)}), unless it is stopped. If you did not ask for it, stop it and suspend that passkey.</p>
                  </div>
                  <div className="sy-need-acts">
                    <Btn small tone="void" busy={stopAuthority.busy} onClick={() => void stopAuthority.run(c.id)}>Stop it</Btn>
                    {s.authority === 'full' ? <Btn small busy={grantAuthority.busy} onClick={() => void grantAuthority.run(c.id)}>Give it authority now</Btn> : null}
                  </div>
                </li>
              )
              // removing a way back in (8j (c)): what stays until then, and that a saved code cancels it too
              const fallback = FALLBACK_REMOVALS.has(c.kind)
              const address = s.addresses.find((a) => a.id === c.subject)?.address ?? c.detail?.address ?? 'an email address'
              const until = c.kind === 'remove-contact' ? 'Until then they stay your recovery contact and can still issue you a code.' : c.kind === 'remove-address' ? `Until then it stays on your account and keeps receiving your security notices.${c.detail?.replacedBy ? ' It is being replaced by a new address you added.' : ''}` : 'Until then your password keeps working.'
              return (
                <li key={c.id} className="sy-need">
                  <div>
                    <h3>{c.kind === 'remove-passkey' ? `Remove the passkey "${name}"` : c.kind === 'unsuspend-passkey' ? `Allow the suspended passkey "${name}" again` : c.kind === 'remove-contact' ? `End @${c.detail?.contact ?? 'a contact'} as your recovery contact` : c.kind === 'remove-address' ? `Remove the email address ${address}` : c.kind === 'remove-password' ? 'Remove your password' : c.kind === 'lower-policy' ? `In "${c.workspace_name ?? 'a workspace'}": ${policyLowering(c.detail)}` : c.kind === 'remove-bill' ? `Remove a bill that your bank reserve counts. It frees ${fmt.money(Number(c.detail?.reserve?.before ?? 0) - Number(c.detail?.reserve?.after ?? 0), true)} of what must stay in your bank account. The bill stays until then.` : c.kind === 'loosen-profile' ? `Loosen your protections. ${profileChangeLines({ after: c.detail?.after ?? {}, before: c.detail?.before ?? {} }).join('. ')}.` : 'A change to your account'}{c.requested_by_handle && c.kind === 'lower-policy' ? <span className="sy-by"> (asked by @{c.requested_by_handle})</span> : null}</h3>
                    <p>Asked {fmt.dayTime(c.requested_at)}; takes effect {fmt.full(c.effective_at)} ({fmt.rel(c.effective_at, now)}).{fallback ? ` ${until} To keep it, cancel this with any of your passkeys, or with one of your saved recovery codes.` : ''}</p>
                    {fallback && codeFor === c.id ? (
                      <form className="sy-contact" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void cancelWithCode.run(c.id) }}>
                        <Field label="One of your saved recovery codes" hint="It is checked, not used up: cancelling only keeps a way back in." error={cancelWithCode.error?.code === 'code_wrong' ? cancelWithCode.error.message : undefined}>{(p) => <input {...p} className="input" autoComplete="off" spellCheck={false} value={cancelCode} onChange={(e) => setCancelCode(e.target.value)} />}</Field>
                        <Btn type="submit" small busy={cancelWithCode.busy} disabled={!cancelCode.trim()}>Cancel with this code</Btn>
                      </form>
                    ) : null}
                  </div>
                  <div className="sy-need-acts">
                    <Btn small busy={cancel.busy} onClick={() => void cancel.run(c)}>Cancel it</Btn>
                    {fallback && codeFor !== c.id ? <Btn small tone="quiet" onClick={() => { setCodeFor(c.id); setCancelCode(''); cancelWithCode.clear() }}>Use a saved code instead</Btn> : null}
                  </div>
                </li>
              )
            })}
          </ul>
          <Problem error={cancelRecovery.error ?? cancel.error ?? (cancelWithCode.error?.code === 'code_wrong' ? null : cancelWithCode.error) ?? stopAuthority.error ?? grantAuthority.error} />
        </section>
      ) : null}

      <div className="sy-board board" ref={board}>
      <section data-col="1" className="pg-sec" id="sign-in" aria-labelledby="sy-in-h">
        <PartHead id="sy-in-h" title="Signing in" aside={`With ${[session.hasPasskey ? 'your device' : null, s.password.set ? 'your password' : null, s.google.identities.length ? 'Google' : null].filter(Boolean).join(', ') || 'nothing yet'}`}>How you get in, and every place you are signed in now. Signing in lets you look and prepare; approving anything takes your device.</PartHead>
        <div className="pg-sheet">
          <section id="ways" className="sy-part" aria-labelledby="ops-h">
            <PartHead id="ops-h" level={3} title="Five separate things">Getting into your account is not the same as approving money, and neither is the same as getting back in. QED keeps them apart, so that a stolen password, a Google account or an email inbox can never move your money.</PartHead>
            <ol className="sy-ops">{OPERATIONS.map((o, i) => <li key={o.id}><span className="n" aria-hidden="true">{i + 1}</span><div><p className="sy-t">{o.title}</p><p className="sy-d">{o.plain}</p></div></li>)}</ol>
          </section>
          {s.email.address || s.google.enabled ? (
            <section id="ordinary" className="sy-part" aria-labelledby="ord-h">
              <PartHead id="ord-h" level={3} title="Email and Google">The ordinary ways in. They open your account; they approve nothing.</PartHead>
              <ul className="sy-rows">
                {s.email.address ? (
                  <li>
                    <span className="sy-glyph" aria-hidden="true"><Mail /></span>
                    <div className="sy-main">
                      <p className="sy-t"><span>{s.email.address}</span><span className="sy-tag">{s.email.verified ? 'verified' : 'not verified'}</span></p>
                      <p className="sy-d">The address this account was opened with. {s.password.set ? 'With your password, it signs you in.' : 'It is shown here; this account has no password for it to sign in with.'}</p>
                      {s.email.verified ? null : !s.email.canVerify
                        ? <p className="sy-s wait">Not verified. This build of QED cannot send email, so verifying is unavailable here; nothing was sent to this address. Your account works without it.</p>
                        : s.email.pending
                          ? <p className="sy-s wait">Not verified yet. {s.email.simulated ? <>Its confirmation is kept in the <a href="/dev/outbox" target="_blank" rel="noopener">simulated outbox</a> on this computer; nothing was sent.</> : 'Open the link in the message QED sent to it.'}</p>
                          : <p className="sy-s wait">Not verified. Its confirmation expired or was replaced.</p>}
                    </div>
                    {!s.email.verified && s.email.canVerify ? <span className="sy-acts"><Btn small busy={resend.busy} onClick={() => void resend.run()}>{s.email.pending ? 'Send it again' : 'Send a confirmation'}</Btn></span> : null}
                  </li>
                ) : null}
                {s.google.identities.map((g) => (
                  <li key={g.id}>
                    <span className="sy-glyph" aria-hidden="true"><LogIn /></span>
                    <div className="sy-main">
                      <p className="sy-t"><span>Google{s.google.standIn ? ' (test stand-in)' : ''}</span>{g.email ? <span className="sy-d">{g.email}</span> : null}</p>
                      <p className="sy-d">Signs you in. Added {fmt.dayTime(g.addedAt)}{g.lastUsedAt ? `; last used ${fmt.dayTime(g.lastUsedAt)}` : ''}.</p>
                    </div>
                    <span className="sy-acts"><Btn small busy={unlinkGoogle.busy} onClick={() => void unlinkGoogle.run(g.id)}>Remove<span className="sr"> Google sign-in{g.email ? ` (${g.email})` : ''}</span></Btn></span>
                  </li>
                ))}
              </ul>
              {s.google.enabled && !s.google.identities.length ? <div><Btn small busy={linkGoogle.busy} onClick={() => void linkGoogle.run()}>Add Google sign-in{s.google.standIn ? ' (test stand-in)' : ''}</Btn><p className="sy-hint">QED never adds a Google account because its address matches yours: you add it here, after confirming it is you.</p></div> : null}
              <Problem error={resend.error ?? linkGoogle.error ?? unlinkGoogle.error} />
            </section>
          ) : null}
          <section id="sessions" className="sy-part" aria-labelledby="ss-h">
            <PartHead id="ss-h" level={3} title="Where you are signed in" aside={`${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}${byPassword ? `, ${byPassword} with a password` : ''}`}>Every browser, or program, signed in to this account. Ending one signs it out at once. Signing out does not pause QED: instructions in force keep running.</PartHead>
            <ul className="sy-rows">{s.sessions.map((x) => (
              <li key={x.id}>
                <span className="sy-glyph" aria-hidden="true"><MonitorSmartphone /></span>
                <div className="sy-main"><p className="sy-t">{sessionDevice(x.device)}{x.current ? <span className="sy-tag">this one</span> : null}</p><p className="sy-d">Opened {fmt.dayTime(x.createdAt)} with {x.method === 'passkey' ? 'a passkey' : x.method === 'google' ? 'Google' : 'a password'}; last used {fmt.dayTime(x.lastSeenAt)}</p></div>
                {!x.current ? <span className="sy-acts"><Btn small busy={end.busy} onClick={() => void end.run(x.id)}>End it<span className="sr"> ({sessionDevice(x.device)}, opened {fmt.dayTime(x.createdAt)})</span></Btn></span> : null}
              </li>
            ))}</ul>
            {endingAll ? (
              <div className="sy-confirm">
                <p>Every session of this account ends, this one too{session.stepUpFresh ? '' : '; your passkey confirms it'}. You then sign in again with a passkey.</p>
                <div className="row"><Btn tone="void" busy={endAll.busy} onClick={() => void endAll.run()}>End every session, this one too</Btn><Btn onClick={() => setEndingAll(false)}>Keep them</Btn></div>
                <Problem error={endAll.error} />
              </div>
            ) : <div><Btn small onClick={() => setEndingAll(true)}>End every session</Btn></div>}
            <Problem error={end.error} />
          </section>
          <PasswordPanel view={s} onChanged={() => { v.reload(); void reload() }} />
        </div>
      </section>

      {/* R13, the passkey group: one plain sentence on what a passkey is; the keys as rows; what to do if a device is lost
          and why removing one waits, as two labelled lines beside the list rather than inside one long paragraph; then adding
          one, named for what it does (a second passkey when there is one), with the browser's own choice of where it is kept */}
      <section data-col="1" className="pg-sec sy-pk" id="passkeys" aria-labelledby="pk-h">
        <PartHead id="pk-h" title="Passkeys" aside={`${usable.length} can sign for you`}>A passkey is your device's own check, your fingerprint, Face ID or device PIN, kept for QED. It signs you in and approves what you pay; QED receives only its signatures, never your face, fingerprint or PIN.</PartHead>
        <div className="pg-sheet">
          {!session.hasPasskey ? <div className="sy-part">{session.hasPassword === false
            ? <Note tone="wait" title="This account has no passkey">It signs in with Google and no device is set up yet. Until one is, it can look at everything but approve nothing. Setting one up needs Google confirmed again, a moment before; your browser then asks where to keep the passkey, and for {deviceWords()}.<div className="stack" style={{ marginTop: 8 }}><div className="row"><Btn tone="fill" busy={add.busy} onClick={() => void add.run()}>Create a passkey</Btn><Btn busy={confirmGoogle.busy} onClick={() => void confirmGoogle.run()}>Confirm with Google again</Btn></div><p className="small">Until a device is set up, a change on this page (saved codes, an address) also asks for Google confirmed again in the last five minutes.</p></div></Note>
            : <Note tone="wait" title="This account has no passkey">It signs in with a password and no device is set up yet. Until one is, it can look at everything but approve nothing, and its password is its only key. Enter its password, then create a passkey; your browser asks where to keep it, and for {deviceWords()}.<div className="stack" style={{ marginTop: 8 }}><input className="input" type="password" aria-label="Password" autoComplete="current-password" value={legacyPw} onChange={(e) => setLegacyPw(e.target.value)} /><div><Btn tone="fill" busy={add.busy} disabled={!legacyPw} onClick={() => void add.run()}>Create a passkey</Btn></div></div></Note>}</div> : null}
          {deviceCodes ? <div className="sy-part" role="status"><Note tone="wait" title="Save these recovery codes now"><SavedCodes codes={deviceCodes} replaced={deviceReplaced} onContinue={() => setDeviceCodes(null)} /></Note></div> : null}
          {!deviceCodes && s.codesAgainUntil ? <div className="sy-part"><Btn small busy={codesAgain.busy} onClick={() => void codesAgain.run()}>Show me new codes (the ones made a moment ago were not saved)</Btn><p className="small muted">Until {fmt.dayTime(s.codesAgainUntil)}, from this session only, while you have one passkey and have used none of them. The old set stops working.</p><Problem error={codesAgain.error} /></div> : null}
          {s.passkeys.length ? (
            <ul className="sy-rows sy-part sy-keys">
              {s.passkeys.map((p) => {
                const acts = [
                  !p.removedAt && !p.suspendedAt && !p.current && usable.length > 1 ? <Btn key="suspend" small tone="void" busy={suspend.busy} onClick={() => void suspend.run(p.id)}>Suspend now<span className="sr"> “{p.name}”</span></Btn> : null,
                  !p.removedAt && p.suspendedAt && !p.unsuspendScheduledFor ? <Btn key="allow" small busy={unsuspend.busy} onClick={() => void unsuspend.run(p.id)}>Allow it again<span className="sr"> “{p.name}”</span></Btn> : null,
                  !p.removedAt && !p.removalScheduledFor && usable.filter((u) => u.id !== p.id).length > 0 ? <Btn key="remove" small busy={remove.busy} onClick={() => void remove.run(p.id)}>{p.coolOffUntil && !p.current ? 'Remove now' : 'Remove'}<span className="sr"> “{p.name}”</span></Btn> : null,
                ].filter(Boolean)
                return (
                  <li key={p.id} data-state={p.removedAt ? 'removed' : p.suspendedAt ? 'suspended' : 'ok'}>
                    <DeviceGlyph name={p.name} />
                    <div className="sy-main">
                      <p className="sy-t"><span>{p.name}</span>{p.current ? <span className="sy-tag">this session</span> : null}</p>
                      <p className="sy-d">{unlockWords(p.name) ?? 'Unlocked by the device or security key that holds it'}. {p.synced ? 'Synced by your platform to your other devices.' : 'Not synced to other devices.'}</p>
                      <p className="sy-d">Added {fmt.dayTime(p.createdAt)}{p.lastUsedAt ? `; last used ${fmt.dayTime(p.lastUsedAt)}` : ''}.</p>
                      {!p.removedAt && !p.suspendedAt && p.coolOffUntil ? <p className="sy-s wait"><Stamp tone="wait">New</Stamp> Until {fmt.full(p.coolOffUntil)} it cannot approve payments above ₹10,000, loosen a protection or add a signer.{p.current ? '' : ' One of your older passkeys can remove it at once, with one of your saved recovery codes.'}</p> : null}
                      {!p.removedAt && !p.suspendedAt && p.authority === 'signin' ? <p className="sy-s wait"><Stamp tone="wait">Signs in only</Stamp> {p.authorityReason === 'after-password-reset' ? 'Added after a password reset' : 'Added by a recovery'}: it approves nothing yet.{p.restoreScheduledFor ? ` It can approve from ${fmt.full(p.restoreScheduledFor)}, unless stopped.` : ''}</p> : null}
                      {p.removedAt ? <p className="sy-s"><Stamp tone="void">Removed {fmt.dayTime(p.removedAt)}</Stamp></p>
                        : p.suspendedAt ? <p className="sy-s void">Suspended {fmt.dayTime(p.suspendedAt)}: it cannot sign in, confirm or approve.{p.unsuspendScheduledFor ? ` It will be allowed again ${fmt.full(p.unsuspendScheduledFor)} unless cancelled above.` : ''}</p>
                        : p.removalScheduledFor ? <p className="sy-s wait">Will be removed {fmt.full(p.removalScheduledFor)}. Until then it still works.</p> : null}
                    </div>
                    {/* a row with nothing to do has no action cell, so it keeps no empty line under it on a phone */}
                    {acts.length ? <span className="sy-acts">{acts}</span> : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {usable.length > 1 && s.passkeys.some((p) => !p.removedAt && !p.suspendedAt && !p.current) ? (
            <Field label="A saved recovery code, to suspend" hint="Suspending a passkey, or removing a new one at once, needs one of your saved codes: someone holding just one of your devices does not have them. The code is used up. Without one, a removal waits the protection delay.">{(p) => <input {...p} className="input" autoComplete="off" spellCheck={false} value={savedCode} onChange={(e) => setSavedCode(e.target.value)} />}</Field>
          ) : null}
          {s.passkeys.length ? (
            <dl className="sy-part sy-pk-rules">
              <div><dt>If a device is lost</dt><dd>{usable.length > 1 ? 'Suspend its passkey here, from another of your devices: it stops at once, with the sessions it opened.' : 'With one passkey, losing this device means a recovery. A second passkey on another device can still sign, and can suspend this one.'}</dd></div>
              <div><dt>Removing a passkey</dt><dd>Removing one, or allowing a suspended one again, waits {wait}, so someone who gets in cannot take your other passkeys away before you can stop them.</dd></div>
            </dl>
          ) : null}
          {/* R2: outside the section below, which goes once the passkey can approve, so codes not yet saved stay on screen */}
          {authorityCodes ? (
            <div className="sy-part" role="status"><Note tone="wait" title="Save these recovery codes now">
              <p className="small" style={{ marginBottom: 8 }}>They were made with your request for approval authority. They work from {fmt.full(authorityCodes.from)}, when the passkey can approve, and then replace any codes made before; until then nothing accepts them. If you lose them before then, stop the request and ask again: that makes a new set, and the wait starts again.</p>
              <SavedCodes codes={authorityCodes.codes} onContinue={() => setAuthorityCodes(null)} />
            </Note></div>
          ) : null}
          {signinOnly.length ? (
            <section id="authority" className="sy-part" aria-labelledby="au-h">
              <PartHead id="au-h" level={3} title="Approving payments again" aside={signinOnly.some((p) => p.restoreScheduledFor) ? 'Asked' : 'Not asked yet'}>A passkey added by a recovery, or after a password reset, signs you in but approves nothing: not a payment, an instruction, a change to your protections, or your on-chain wallet. Asking gives it approval authority after {wait}; every device, email address and recovery contact of yours is told, and any other passkey of yours or a recovery contact can stop it. A passkey added after a password reset also gets your saved recovery codes with its request, shown once: they work from the end of the wait.</PartHead>
              <ul className="sy-rows">{signinOnly.map((p) => (
                <li key={p.id}>
                  <DeviceGlyph name={p.name} />
                  <div className="sy-main"><p className="sy-t">{p.name}{p.current ? <span className="sy-tag">this session</span> : null}</p>
                    <p className="sy-d">{p.restoreScheduledFor ? `Asked: it can approve from ${fmt.full(p.restoreScheduledFor)} (${fmt.rel(p.restoreScheduledFor, now)}), unless stopped.` : 'Not asked yet. The device that holds it confirms the request.'}</p></div>
                  <span className="sy-acts">{p.restoreScheduledFor
                    ? <Btn small tone="quiet" busy={stopAuthority.busy} onClick={() => { const c = s.scheduled.find((x) => x.kind === 'restore-authority' && x.subject === p.id); if (c) void stopAuthority.run(c.id) }}>Stop the request</Btn>
                    : <Btn small tone="fill" busy={askAuthority.busy} onClick={() => void askAuthority.run()}>Ask for approval authority</Btn>}</span>
                </li>
              ))}</ul>
              <p className="sy-hint">Your on-chain wallet accepts a passkey only under its own rules after that: its recovery key and its delay, or its other signers, under "Who can sign for your on-chain wallet".</p>
              <Problem error={askAuthority.error ?? stopAuthority.error} />
            </section>
          ) : null}
          {session.hasPasskey && s.authority === 'full' ? (
            <form className="sy-part sy-add" aria-labelledby="pk-add-h" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
              <h3 id="pk-add-h" className="sy-add-h">{usable.length === 1 ? 'Add a second passkey' : 'Add a passkey'}</h3>
              <Field label="Name it, if you like" hint="Say which device it is on. Without a name it is named after the kind of device.">{(p) => <input {...p} className="input" maxLength={60} autoComplete="off" placeholder="Work laptop" value={keyName} onChange={(e) => setKeyName(e.target.value)} />}</Field>
              <Btn type="submit" busy={add.busy}>Add a passkey</Btn>
              <p className="sy-hint">Your browser asks where to keep it, on this device or another, and then for {deviceWords()}. QED receives only the passkey's public key.</p>
            </form>
          ) : null}
          {add.error ?? remove.error ?? suspend.error ?? unsuspend.error ? <div className="sy-part"><Problem error={add.error ?? remove.error ?? suspend.error ?? unsuspend.error} /></div> : null}
        </div>
      </section>

      <section data-col="2" className="pg-sec" id="approving" aria-labelledby="ap-h">
        <PartHead id="ap-h" title="Approving payments">What turns a request into a payment, and what QED may do without asking you each time. Signing in alone approves nothing.</PartHead>
        <dl className="pg-sheet sy-terms">
          <div><dt>What approves</dt><dd>One of your passkeys, signing the exact terms you are shown. QED checks that signature before anything moves; on your on-chain wallet the chain checks it again.</dd></div>
          <div><dt>What a password can do</dt><dd>{s.password.set || byPassword ? 'Sign in, look and prepare, such as adding a payee or drafting a payment. It approves nothing, and work prepared with it says so where your passkey signs.' : 'No password is set on this account, so only a passkey signs in.'}</dd></div>
          {session.setup ? <div><dt>How many must sign</dt><dd>{session.workspace?.kind === 'business' && pol ? <>{pol.signers === 1 ? 'One signature' : `${pol.signers} signatures, each from a different member,`} for every request in {session.workspace.name}{pol.makerChecker ? ', never from whoever prepared it' : ''}. <Link to="/workspace">Workspace and members</Link></> : <>You alone, in your personal workspace. <Link to="/workspace">Workspace and members</Link></>}</dd></div> : null}
          {session.setup ? <div><dt>What QED may do without asking</dt><dd>Only what a standing instruction you signed allows, within its limits and until it ends. <Link to="/protect">What QED may do</Link></dd></div> : null}
        </dl>
      </section>

      <section data-col="2" className="pg-sec" id="if-wrong" aria-labelledby="iw-h">
        <PartHead id="iw-h" title="If something is wrong">What to do, in order, for the usual troubles. Stopping something works at once; anything that weakens a protection waits.</PartHead>
        <dl className="pg-sheet sy-terms">
          <div><dt>A device is lost or stolen</dt><dd>From another device signed in with a passkey, <a href="#passkeys">suspend that device's passkey</a>: it stops at once and the sessions it opened end; where your on-chain wallet allows it, it is frozen there at once too (see "Who can sign for your on-chain wallet"). Removing it later waits {wait}. With no other device, recover the account from the sign-in page.</dd></div>
          <div><dt>Your passkey does not work here</dt><dd>Use a device that has it, or a phone nearby when your browser offers one. With a password, sign in with it and add a passkey on this device. Otherwise recover the account.</dd></div>
          <div><dt>You think someone else is in</dt><dd>End every session, suspend any passkey you do not recognise, stop any recovery or request for approval authority you did not start, and change your password if you have one.<div className="row" style={{ marginTop: 8 }}><Btn small tone="void" onClick={() => { setEndingAll(true); document.getElementById('sessions')?.scrollIntoView({ block: 'start' }) }}>End every session</Btn><a className="btn sm" href="#passkeys">Your passkeys</a></div></dd></div>
          <div><dt>A recovery you did not start</dt><dd>It is listed first on this page, under Needs you: stop it there. Your recovery contacts can stop it too, and every confirmed email address has been told.</dd></div>
          <div><dt>A link that expired or failed</dt><dd>Ask for a new one from the sign-in page: links work once, for 30 minutes (an hour for a recovery). A recovery that failed or was stopped grants nothing; start again when you are ready.</dd></div>
        </dl>
      </section>

      <section data-col="2" className="pg-sec" id="recovery-and-signers" aria-labelledby="rs-h">
        <PartHead id="rs-h" title="Recovery and signer changes">How you would get back in without your devices, who trusts you to help them, and who can sign for your on-chain wallet. A change that weakens a protection waits {wait}; any other passkey can cancel it in that time.</PartHead>
        <div className="pg-sheet">
          <section id="recovery" className="sy-part" aria-labelledby="rv-h">
            <PartHead id="rv-h" level={3} title="If you lose every passkey">A link to your confirmed email address and one more proof obtained another way start a recovery, which then waits. Without email, two codes obtained differently do. So someone who gets into your email, or steals your codes, cannot take the account quietly.</PartHead>
            <ol className="sy-path" aria-label="What a recovery takes">
              <li data-tone={usableEmail ? 'ok' : 'wait'}><span className="node" aria-hidden="true" /><div><p className="sy-t">A link to your email</p><p className="sy-d">{usableEmail ? 'Your confirmed address can start one.' : s.addresses.some((a) => a.kind === 'email' && a.confirmedAt) ? 'Your address is confirmed; it can start one when its protection delay ends.' : 'No confirmed email address yet: add one below. Until then, the backup way is a saved code with a code from your recovery contact.'}</p></div></li>
              <li data-tone={s.recoveryCodesLeft > 0 || !noSecond ? 'ok' : 'void'}><span className="node" aria-hidden="true" /><div><p className="sy-t">One more proof</p><p className="sy-d">One of your saved codes ({s.recoveryCodesLeft} of 10 unused){activeContact?.hasPasskey ? `, a code from @${activeContact.handle}` : ''}{s.secondMethod.password ? ', or your password' : ''}.{!activeContact && !s.contacts.length ? ' A recovery contact, named below, can be one too.' : activeContact && !activeContact.hasPasskey ? ` @${activeContact.handle} cannot issue a code until they add a passkey.` : ''}</p></div></li>
              <li data-tone="plain"><span className="node" aria-hidden="true" /><div><p className="sy-t">A wait of {delayWords(s.delays.recoveryMs)}</p><p className="sy-d">Every session of this account, every confirmed address and every contact hears of it, and any of your passkeys or contacts can stop it.</p></div></li>
              <li data-tone="plain"><span className="node" aria-hidden="true" /><div><p className="sy-t">A new passkey that signs in only</p><p className="sy-d">If the recovery spent a saved code, a new set is shown once.</p></div></li>
              <li data-tone="end"><span className="node" aria-hidden="true" /><div><p className="sy-t">Approving again, after {delayWords(s.delays.protectionMs)}</p><p className="sy-d">Asked with the new passkey; told everywhere, and stoppable by your other passkeys and contacts.</p></div></li>
            </ol>
            {noSecond && !(usableEmail && s.recoveryCodesLeft > 0) ? (activeContact
              ? <Note tone="wait" title="Your recovery contact cannot issue a code yet">@{activeContact.handle} has no passkey yet, and a contact issues a recovery code only after confirming with one. Until they add one, a saved code alone cannot recover this account.</Note>
              : s.contacts.length
              ? <Note tone="wait" title="Your recovery contact is not active yet">Until {s.contacts.map((c) => `@${c.handle}`).join(' or ')} has accepted and the delay has ended, a saved code alone cannot recover this account.</Note>
              : <Note tone="wait" title="No recovery contact yet">A saved code alone cannot recover this account. Name a person you trust who has their own account here, or add a passkey on a second device, so that losing one device does not lose the account.</Note>) : null}

            <AddressesPanel addresses={s.addresses} legacyPw={legacyPw} onChanged={() => v.reload()} />

            <div className="sy-sub">
              <h4>Saved recovery codes</h4>
              {s.codesMade || codes
                ? <p className="sy-d">{s.recoveryCodesLeft} of 10 unused. Each is half of a recovery and works once; a code alone gets no one in. New codes replace every earlier one and are shown only once.</p>
                : <p className="sy-d">None yet: QED makes them with your first device, and this account has no device. Each is half of a recovery and works once; a code alone gets no one in.{s.email.canVerify ? '' : ' On this installation, which cannot send email, they are the way back in if you lose your device.'}</p>}
              {s.codesFrom ? <p className="sy-s wait">A new set was made with your request for approval authority and shown once then. It works from {fmt.full(s.codesFrom)}, and then replaces any codes made before.</p> : null}
              {!codes && s.codesMade && s.recoveryCodesLeft <= 2 ? <Note tone="wait" title={s.recoveryCodesLeft === 0 ? 'No saved codes left' : 'Few saved codes left'}>Saved codes decide between your own passkeys: suspending one, removing a new one at once and making new codes each need one, and someone holding only one of your devices does not have them.{s.recoveryCodesLeft === 0 && usable.length > 1 ? ' With none left and more than one passkey, new codes cannot be made at once: remove the passkeys you no longer hold first (each waits the protection delay).' : ' Make new codes while you still have one.'}</Note> : null}
              {codeSpent && !codes ? <Note tone="wait" title="One of your saved codes was used">The recovery you cancelled had used one of your saved codes, so it no longer works. Make new codes now: that needs one of the codes you still have.</Note> : null}
              {!codes && s.recoveryCodesLeft > 0 ? <Field label="A saved recovery code, for new codes" hint="New codes need one of the codes you have now, so that someone holding one of your devices cannot replace yours.">{(p) => <input {...p} className="input" autoComplete="off" spellCheck={false} value={savedCode} onChange={(e) => setSavedCode(e.target.value)} />}</Field> : null}
              {codes ? <><ol className="codes" aria-label="New recovery codes">{codes.map((c) => <li key={c} className="code">{c}</li>)}</ol><p className="small wait">{codesFirst ? 'Your codes, shown once: store them somewhere other than this device.' : 'New codes, shown once: store them somewhere other than this device. The earlier codes no longer work.'}</p></> : <div><Btn small busy={regen.busy} onClick={() => void regen.run()}>{s.codesMade ? 'Make new codes' : 'Save recovery codes'}</Btn></div>}
              <Problem error={regen.error} />
            </div>

            <div className="sy-sub">
              <h4>Recovery contacts</h4>
              {s.contacts.length ? <ul className="sy-rows">{s.contacts.map((c) => (
                <li key={c.id}>
                  <div className="sy-main"><p className="sy-t">{c.name} <span className="sy-d">@{c.handle}</span></p>
                    <p className="sy-d">{c.active ? `Active since ${fmt.dayTime(Math.max(c.effectiveAt, c.acceptedAt ?? 0))}` : !c.acceptedAt ? `Asked ${fmt.dayTime(c.requestedAt)}; waiting for them to accept${c.effectiveAt > now ? `, and active no earlier than ${fmt.full(c.effectiveAt)}` : ''}` : `Accepted; active from ${fmt.full(c.effectiveAt)}`}</p>
                    <p className="sy-d">{c.active && c.hasPasskey ? 'Can issue you a recovery code from their own account. Cannot sign in to yours or approve anything.' : c.active ? 'Cannot issue a code until they add a passkey of their own.' : 'Cannot issue a code until they have accepted and the wait has ended.'}</p>
                    {c.removalScheduledFor ? <p className="sy-s wait">Ends {fmt.full(c.removalScheduledFor)} ({fmt.rel(c.removalScheduledFor, now)}). Until then they stay your recovery contact. To keep them, cancel it under Needs you, with any of your passkeys or a saved recovery code.</p> : null}</div>
                  {c.removalScheduledFor ? null : <span className="sy-acts"><Btn small busy={endContact.busy} onClick={() => void endContact.run({ id: c.id, mine: true })}>{c.acceptedAt ? 'End' : 'Withdraw'}<span className="sr"> @{c.handle}</span></Btn></span>}
                </li>
              ))}</ul> : <p className="sy-d">None yet.</p>}
              <form className="sy-contact" onSubmit={(e) => { e.preventDefault(); void nominate.run() }}>
                <Field label="Their handle" error={nominate.error?.fields.handle}>{(p) => <input {...p} className="input" autoCapitalize="none" value={contactHandle} onChange={(e) => setContactHandle(e.target.value)} />}</Field>
                <Btn type="submit" busy={nominate.busy} disabled={!contactHandle.trim()}>Name as recovery contact</Btn>
              </form>
              <p className="sy-hint">A contact makes recovering this account easier, so a new one becomes active only after {wait} and once they accept; any passkey can withdraw it meanwhile. Ending a contact who has accepted waits {wait} too: they are told at once and stay your contact until then, and any of your passkeys, or one of your saved codes, can cancel it. That way someone who gets into one of your devices cannot quietly take your way back in.</p>
              {nominate.error && !nominate.error.fields.handle ? <Problem error={nominate.error} /> : <Problem error={endContact.error} />}
            </div>
          </section>

          {s.trustedBy.length ? (
            <section className="sy-part" aria-labelledby="tb-h">
              <PartHead id="tb-h" level={3} title="People who trust you to help them recover">If they lose every passkey, they will ask you for a code. Issue one only when they ask you directly.</PartHead>
              <ul className="sy-rows">{s.trustedBy.map((c) => (
                <li key={c.id} className="sy-trust">
                  <div className="sy-main">
                    <p className="sy-t">{c.name} <span className="sy-d">@{c.handle}</span></p>
                    <p className="sy-d">{!c.acceptedAt ? 'Asked you to be their recovery contact' : c.active ? 'You are their recovery contact' : `Active from ${fmt.full(c.effectiveAt)}`}{c.openRecovery ? '; a recovery of their account is open now' : ''}{c.pendingAuthority ? '; a recovered passkey of theirs has asked for approval authority' : ''}{c.pendingLoosening ? '; they have asked to loosen a protection, which waits its delay' : ''}{c.endingAt ? `; they asked to end you as their recovery contact, which takes effect ${fmt.full(c.endingAt)}: if they did not tell you, call them` : ''}</p>
                    {confirmIssue === c.id ? <Note tone="void" title={`Only if ${c.name} asked you directly`}>Issue a code only if they asked you in person, or on a call you made to a number you already had for them. Anyone who has this code and one of their saved codes can start a recovery of their account. Your passkey confirms it.<div className="row" style={{ marginTop: 8 }}><Btn tone="fill" busy={issue.busy} onClick={() => void issue.run(c.id)}>Issue the code</Btn><Btn onClick={() => setConfirmIssue(null)}>Do not issue</Btn></div></Note> : null}
                    {confirmStop === c.id ? <Note tone="wait" title={`Stop what is under way for ${c.name}`}>{c.openRecovery ? 'Their recovery will not complete. ' : ''}{c.pendingAuthority ? 'Their request for approval authority will not take effect. ' : ''}Do this if they did not tell you about it themselves. Your passkey confirms it, and they are told.<div className="row" style={{ marginTop: 8 }}><Btn tone="void" busy={stopForThem.busy} onClick={() => void stopForThem.run(c.id)}>Stop it</Btn><Btn onClick={() => setConfirmStop(null)}>Leave it</Btn></div></Note> : null}
                    {confirmLoosening === c.id ? <Note tone="wait" title={`Stop the loosening ${c.name} asked for`}>Nothing is loosened: the change is cancelled before its delay ends. Do this if they did not tell you about it themselves, or if someone may be pressing them to make it. It changes nothing else, they can ask again, and it waits its delay again. Your passkey confirms it, and they are told.<div className="row" style={{ marginTop: 8 }}><Btn tone="void" busy={stopLoosening.busy} onClick={() => void stopLoosening.run(c.id)}>Stop it</Btn><Btn onClick={() => setConfirmLoosening(null)}>Leave it</Btn></div></Note> : null}
                    {confirmPause === c.id ? <Note tone="wait" title={`Pause QED for ${c.name}`}>Everything QED does on its own for them stops, except selling to protect their floor. It moves no money, and only they can resume it. Do this if they asked you, or if their devices may be lost or stolen. Your passkey confirms it, and they are told.<div className="row" style={{ marginTop: 8 }}><Btn tone="void" busy={pauseForThem.busy} onClick={() => void pauseForThem.run(c.id)}>Pause QED for them</Btn><Btn onClick={() => setConfirmPause(null)}>Leave it</Btn></div></Note> : null}
                    {pausedFor === c.id ? <div role="status"><Note tone="ok" title="QED is paused for them">Everything it does on its own for them is paused, except protective selling that runs without asking (one set to ask first still waits for their passkey before each sale). Only they can resume it, with a passkey of theirs. They are told at once that you paused it.</Note></div> : null}
                    {issued?.linkId === c.id ? <Note tone="wait" title="Read this code to them"><span className="code issued" aria-label="Recovery code for them">{issued.code}</span><div className="small" style={{ marginTop: 6 }}>Works once, until {fmt.full(issued.expiresAt)}. Shown only now. Their account has been told that you issued it.</div></Note> : null}
                  </div>
                  <span className="sy-acts">{c.active ? <Btn small onClick={() => { setPausedFor(null); setConfirmPause(c.id) }}>Pause QED for them</Btn> : null}{c.active && c.pendingLoosening ? <Btn small tone="void" onClick={() => setConfirmLoosening(c.id)}>Stop their loosening</Btn> : null}{c.acceptedAt && (c.openRecovery || c.pendingAuthority) ? <Btn small tone="void" onClick={() => setConfirmStop(c.id)}>{c.openRecovery ? 'Stop their recovery' : 'Stop their request'}</Btn> : null}{!c.acceptedAt ? <Btn small tone="fill" busy={accept.busy} onClick={() => void accept.run(c.id)}>Accept</Btn> : c.active ? <Btn small onClick={() => setConfirmIssue(c.id)}>Issue a recovery code</Btn> : null}
                    <Btn small tone="quiet" busy={endContact.busy} onClick={() => void endContact.run({ id: c.id, mine: false })}>{c.acceptedAt ? 'Step down' : 'Decline'}</Btn></span>
                </li>
              ))}</ul>
              <Problem error={issue.error ?? accept.error ?? stopForThem.error ?? stopLoosening.error ?? pauseForThem.error} />
            </section>
          ) : null}

          <GuardianRequests />
          <WalletSigners setUp={s.wallet.setUp} current={s.passkeys.find((p) => p.current)?.id ?? null} passkeys={s.passkeys.map((p) => `${p.id}:${p.suspendedAt ?? ''}:${p.removedAt ?? ''}`).join(',')} onChanged={() => { v.reload(); void reload() }} />
        </div>
      </section>

      <section data-col="1" className="pg-sec" aria-labelledby="ev-h">
        <PartHead id="ev-h" title="What happened" aside="Newest first" />
        {s.events.length ? <ul className="pg-sheet sy-history">{s.events.map((e, i) => <li key={i}><span className="sy-main">{eventWords(e)}{typeof e.detail.payee === 'string' ? `: ${e.detail.payee}${typeof e.detail.workspace === 'string' ? `, in ${e.detail.workspace}` : ''}` : typeof e.detail.address === 'string' ? `: ${e.detail.address}` : typeof e.detail.method === 'string' && METHOD_WORDS[e.detail.method] ? `, with ${METHOD_WORDS[e.detail.method]}` : typeof e.detail.passkey === 'string' ? `: ${e.detail.passkey}` : typeof e.detail.contact === 'string' ? `: @${e.detail.contact}` : typeof e.detail.for === 'string' ? `: @${e.detail.for}` : typeof e.detail.by === 'string' && e.kind === 'named-as-recovery-contact' ? `: @${e.detail.by}` : ''}</span><time>{fmt.dayTime(e.ts)}</time></li>)}</ul> : <p className="pg-sheet sy-empty">Nothing yet.</p>}
      </section>
      </div>
    </div>
  )
}

/**
 * Email and text messages (R12): where QED reaches the person outside QED. An email address receives security notices
 * from its confirmation (a link or a six-digit code) and, after the protection delay, can start a password reset or a
 * recovery. A phone number receives short security notices only and is never a way back in: a number can be taken over
 * (a SIM swap, a port to another network) or given to someone else (SECURITY.md, "Text messages"). Adding, changing or
 * removing one takes the account's strongest confirmation. In this build nothing is sent (the simulated outbox).
 */
function AddressesPanel({ addresses, legacyPw, onChanged }: { addresses: Address[]; legacyPw: string; onChanged: () => void }) {
  const { session } = useSession()
  const now = useNow(30_000)
  const [email, setEmail] = useState(''), [phone, setPhone] = useState('')
  const [code, setCode] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<{ id: string; kind: 'email' | 'phone' } | null>(null)
  const [pw, setPw] = useState(''), [needPw, setNeedPw] = useState(false)
  /** The strongest confirmation the account can give, asked only when the server asks for it. */
  const confirmed = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (e) {
      if (!(e instanceof ApiError && e.code === 'stepup_required')) throw e
      if (session.hasPasskey) { await confirmWithPasskey(); return fn() }
      const typed = pw || legacyPw
      if (!typed) { setNeedPw(true); throw new ApiError(401, 'stepup_required', 'Type your password in the field below, then try again: this account has no passkey to confirm with.') }
      await api('POST', '/api/auth/stepup', { password: typed }); setPw(''); setNeedPw(false); return fn()
    }
  }
  const add = useAction(async (kind: 'email' | 'phone') => {
    const address = kind === 'email' ? email : phone
    await confirmed(() => api('POST', '/api/security/addresses', { kind, address, ...(replacing?.kind === kind ? { replaces: replacing.id } : {}) }))
    if (kind === 'email') setEmail(''); else setPhone('')
    setReplacing(null); onChanged()
  })
  const confirm = useAction(async (id: string) => { await api('POST', `/api/security/addresses/${id}/confirm`, { code: code[id] ?? '' }); setCode((c) => ({ ...c, [id]: '' })); onChanged() })
  const remove = useAction(async (id: string) => { await confirmed(() => api('POST', `/api/security/addresses/${id}/remove`)); onChanged() })
  const emails = addresses.filter((a) => a.kind === 'email'), phones = addresses.filter((a) => a.kind === 'phone')
  const confirmedEmails = emails.filter((a) => a.confirmedAt !== null).length, confirmedPhone = phones.some((a) => a.confirmedAt !== null)
  const state = (a: Address): string => a.confirmedAt === null ? 'Waiting for confirmation: open the link in its message, or type the code from it here.'
    : a.removalScheduledFor ? `Confirmed ${fmt.dayTime(a.confirmedAt)}. To be removed ${fmt.full(a.removalScheduledFor)} (${fmt.rel(a.removalScheduledFor, now)}); until then it stays and receives your security notices. To keep it, cancel the removal under Needs you, with any of your passkeys or a saved recovery code.`
    : a.kind === 'phone' ? `Confirmed ${fmt.dayTime(a.confirmedAt)}. Receives short security notices by text message; never a way back in.`
      : a.usableFrom !== null && a.usableFrom > now ? `Confirmed ${fmt.dayTime(a.confirmedAt)}. Receives your security notices now; can start a password reset or a recovery from ${fmt.full(a.usableFrom)}.`
        : `Confirmed ${fmt.dayTime(a.confirmedAt)}. Receives your security notices, and can start a password reset or a recovery.`
  const err = add.error ?? confirm.error ?? remove.error
  return (
    <section id="addresses" className="sy-sub" aria-labelledby="ad-h">
      <h4 id="ad-h">Email and text messages</h4>
      <p className="sy-d">Where QED tells you, outside QED, about every change to who can act for you. A new email address waits {delayWords(session.delays?.protectionMs ?? NORMAL_DELAY_MS)} before it can start a reset or a recovery, so that someone who adds theirs cannot use it at once. Removing a confirmed one, or changing it, waits as long before the old address goes: it is told at once, and any of your passkeys, or one of your saved codes, can cancel it.{session.delivery === 'outbox' ? <> In this build nothing is sent: messages go to the <a href="/dev/outbox" target="_blank" rel="noopener">simulated outbox</a>.</> : null}</p>
      {session.delivery === 'none' ? <Note tone="wait" title="Email is not available here">{noDeliveryWords('address')}</Note> : null}
      {addresses.length ? <ul className="sy-rows">{addresses.map((a) => (
        <li key={a.id}>
          <span className="sy-glyph" aria-hidden="true">{a.kind === 'email' ? <Mail /> : <MessageSquare />}</span>
          <div className="sy-main">
            <p className="sy-t">{a.address}{a.kind === 'phone' ? <span className="sy-tag">notices only</span> : null}</p>
            <p className="sy-d">{state(a)}</p>
            {a.confirmedAt === null ? <form className="sy-inline" onSubmit={(e) => { e.preventDefault(); void confirm.run(a.id) }}>
              <Field label={`Code sent to ${a.address}`} error={confirm.error?.fields.code}>{(p) => <input {...p} className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code[a.id] ?? ''} onChange={(e) => setCode((c) => ({ ...c, [a.id]: e.target.value }))} />}</Field>
              <Btn type="submit" small busy={confirm.busy} disabled={!(code[a.id] ?? '').trim()}>Confirm</Btn>
            </form> : null}
          </div>
          {a.removalScheduledFor ? null : <span className="sy-acts">
            {a.confirmedAt !== null ? <Btn small tone="quiet" onClick={() => { setReplacing({ id: a.id, kind: a.kind }); add.clear() }}>Change<span className="sr"> {a.address}</span></Btn> : null}
            <Btn small tone="quiet" busy={remove.busy} onClick={() => void remove.run(a.id)}>{a.confirmedAt === null ? 'Withdraw' : 'Remove'}<span className="sr"> {a.address}</span></Btn>
          </span>}
        </li>
      ))}</ul> : <p className="sy-d">None yet.</p>}
      {replacing ? <Note tone="wait" title={`Changing ${addresses.find((a) => a.id === replacing.id)?.address ?? 'an address'}`}>Enter the new one below.{replacing.kind === 'email' ? ` The old one keeps working until the new one is confirmed and for ${delayWords(session.delays?.protectionMs ?? NORMAL_DELAY_MS)} after that; it is told at once, and any of your passkeys, or one of your saved codes, can cancel its removal.` : ' The old one keeps working until the new one is confirmed, and is then told of the change and removed.'}<div style={{ marginTop: 8 }}><Btn small tone="quiet" onClick={() => setReplacing(null)}>Keep it as it is</Btn></div></Note> : null}
      {session.delivery !== 'none' && (confirmedEmails < 3 || replacing?.kind === 'email') ? <form className="sy-contact" onSubmit={(e) => { e.preventDefault(); void add.run('email') }}>
        <Field label={replacing?.kind === 'email' ? 'New email address' : 'Add an email address'} hint="Any ordinary address, Gmail included. A link and a code are sent to confirm it." error={add.error?.fields.address && (email || !phone) ? add.error.fields.address : undefined}>{(p) => <input {...p} className="input" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Btn type="submit" busy={add.busy} disabled={!email.trim()}>Send a confirmation</Btn>
      </form> : null}
      {session.delivery !== 'none' && session.delivery !== 'postmark' && (!confirmedPhone || replacing?.kind === 'phone') ? <form className="sy-contact" onSubmit={(e) => { e.preventDefault(); void add.run('phone') }}>
        <Field label={replacing?.kind === 'phone' ? 'New phone number' : 'Add a phone number for security notices'} hint="With its country code, such as +91 98765 43210. It receives short notices only: a text message is easier to intercept than email, so it is never a way back in." error={add.error?.fields.address && phone && !email ? add.error.fields.address : undefined}>{(p) => <input {...p} className="input" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Btn type="submit" busy={add.busy} disabled={!phone.trim()}>Send a code</Btn>
      </form> : null}
      {needPw ? <PasswordField label="Your password, to confirm" value={pw} onChange={setPw} show={false} onShow={() => {}} autoComplete="current-password" /> : null}
      {err && !err.fields.address && !err.fields.code ? <Problem error={err} /> : null}
    </section>
  )
}

/** The sessions a change of password ended, in words. */
const endedWords = (n: number): string => (n === 0 ? 'No other session was signed in.' : n === 1 ? 'The one other session signed in to this account was signed out.' : `The ${n} other sessions signed in to this account were signed out.`)

/**
 * The password of an account that has one (D-094, RISK-076). Changing it takes the account's strongest confirmation:
 * its passkey, or, with no passkey yet, the current password typed again in the same request, takes effect at once and
 * ends every other session. Removing it takes a passkey and a way back in without it (a recovery then needs a saved code
 * and a code from an active recovery contact), so its sheet lists those first and offers the removal only when all are
 * there. The removal waits the protection delay (SECURITY.md 8j (c)): the panel then says until when, and that any
 * passkey or a saved code cancels it under Needs you; when it applies, the sessions the password opened end.
 */
function PasswordPanel({ view, onChanged }: { view: SecurityView; onChanged: () => void }) {
  const { session } = useSession()
  const [sheet, setSheet] = useState<'change' | 'remove' | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNext, setShowNext] = useState(false)
  const [done, setDone] = useState<{ kind: 'changed'; ended: number } | { kind: 'scheduled' } | null>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const passkey = !!session.hasPasskey
  const set = view.password.set
  const pending = view.password.removalScheduledFor ?? null
  const wait = delayWords(view.delays.protectionMs)
  // After asking for the removal its button is gone: focus goes to this panel's heading, not to the top of the page.
  useEffect(() => { if (done?.kind === 'scheduled') head.current?.focus() }, [done])
  /** With a passkey: confirm first when this session's confirmation is not fresh, and once more if the server says it lapsed. */
  const confirmed = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (passkey && !session.stepUpFresh) await confirmWithPasskey()
    try { return await fn() } catch (e) { if (passkey && e instanceof ApiError && e.code === 'stepup_required') { await confirmWithPasskey(); return fn() } throw e }
  }
  const close = () => { setSheet(null); setCurrent(''); setNext(''); setShowCurrent(false); setShowNext(false); change.clear(); remove.clear() }
  const open = (which: 'change' | 'remove') => { setDone(null); setSheet(which) }
  const change = useAction(async () => {
    const r = await confirmed(() => api<{ ended: number }>('POST', '/api/security/password', passkey ? { password: next } : { current, password: next }))
    close(); setDone({ kind: 'changed', ended: r.ended }); onChanged()
  })
  const remove = useAction(async () => {
    await confirmed(() => api<{ effectiveAt: number }>('POST', '/api/security/password/remove'))
    close(); setDone({ kind: 'scheduled' }); onChanged()
  })
  if (!set) return null
  const keys = view.passkeys.filter((p) => !p.removedAt && !p.suspendedAt)
  // the contact a recovery would ask: active, and with a passkey to issue a code with (the server counts only such a one)
  const issuer = view.contacts.find((c) => c.active && c.hasPasskey)
  const active = issuer ?? view.contacts.find((c) => c.active)
  const ready = passkey && keys.length > 0 && !!issuer && view.recoveryCodesLeft > 0
  const fieldError = change.error?.fields.current ?? change.error?.fields.password
  return (
    <section className="sy-part" aria-labelledby="pw-h">
      <div className="sy-part-head"><div className="pg-sec-t"><h3 id="pw-h" ref={head} tabIndex={-1}>Password</h3><span className="pg-aside">{pending ? 'Removal waiting' : view.password.changedAt ? `Changed ${fmt.dayTime(view.password.changedAt)}` : 'As set when the account was made'}</span></div>
        <p className="pg-note">{passkey
          ? `This account can also sign in with its password. A page that imitates this one can steal a password but never a passkey, so here a password signs in and sets things up, and approving anything needs a passkey. Changing it signs out every other session at once; removing it waits ${wait}.`
          : 'This account signs in with its password, and until it has a passkey that password is its only key. Changing it signs out every other session.'}</p></div>
      {!passkey && view.password.heldUntil ? <Note tone="wait" title={`Reset recently: limited until ${fmt.full(view.password.heldUntil)}`}>Until then the password cannot make new recovery codes, add or remove an email address or phone number, or cancel a recovery: every address of the account was told of the reset, and this wait lets its owner act if someone else reset it.</Note> : null}
      <div role="status">
        {done?.kind === 'changed' ? <Note tone="ok" title="Password changed">{endedWords(done.ended)}</Note> : null}
        {pending ? <Note tone="wait" title={`Your password is to be removed ${fmt.full(pending)}`}>It keeps working until then. From then this account signs in only with its passkeys, and every session opened with the password ends. To keep the password, cancel the removal under Needs you, at the top of this page, with any of your passkeys or one of your saved recovery codes. If you think someone knows it, change it now instead: a change takes effect at once.</Note> : null}
      </div>
      <div className="row"><Btn small onClick={() => open('change')}>Change password</Btn>{passkey && !pending ? <Btn small tone="quiet" onClick={() => open('remove')}>Remove password</Btn> : null}</div>
      {set && !passkey ? <p className="sy-hint">Once the account has a passkey, the password can be removed.</p> : null}

      <Sheet open={sheet === 'change'} title="Change your password" onClose={close}
        foot={<><Btn onClick={close}>Cancel</Btn><Btn tone="fill" type="submit" form="pw-change-p" busy={change.busy} disabled={!next || (!passkey && !current)}>Change password</Btn></>}>
        <form id="pw-change-p" className="stack" onSubmit={(e) => { e.preventDefault(); void change.run() }}>
          {!passkey ? <PasswordField label="Current password" value={current} onChange={setCurrent} show={showCurrent} onShow={setShowCurrent} autoComplete="current-password" error={change.error?.fields.current} /> : null}
          <PasswordField label="New password" value={next} onChange={setNext} show={showNext} onShow={setShowNext} autoComplete="new-password" error={change.error?.fields.password} hint="At least 10 characters, not your handle, and not a common password or word with digits added. A phrase of a few words works well." />
          <p className="small">{passkey ? 'Your passkey is asked for first, unless you confirmed with it here in the last five minutes. ' : ''}Every other session of this account ends, so anyone signed in with the old password is signed out. This one stays signed in.</p>
          {change.error && !fieldError ? <Problem error={change.error} /> : null}
        </form>
      </Sheet>

      <Sheet open={sheet === 'remove'} title="Remove your password" onClose={close}
        foot={<><Btn onClick={close}>Keep the password</Btn>{ready ? <Btn tone="void" busy={remove.busy} onClick={() => void remove.run()}>Remove password</Btn> : null}</>}>
        <p>Without a password this account signs in only with its passkeys. Removing it waits {wait}: the password keeps working until then, every address of yours is told now, and any of your passkeys, or one of your saved recovery codes, can cancel it, so someone who gets into one of your devices cannot quietly take this way back in. If you think someone knows the password, change it instead: a change takes effect at once. A password cannot be added back later.</p>
        <ul className="sy-needs-for" aria-label="What removing the password needs">
          <li><Mark tone={keys.length ? 'ok' : 'void'} /><div><p className="sy-t">A passkey that can sign in</p><p className="sy-d">{keys.length ? `You have ${listed(keys.map((k) => `"${k.name}"`))}.` : 'None yet: add one under Passkeys.'}</p></div></li>
          <li><Mark tone={issuer ? 'ok' : view.contacts.length ? 'wait' : 'void'} /><div><p className="sy-t">A recovery contact who can issue you a code</p><p className="sy-d">{issuer ? `@${issuer.handle} is active and can issue you a recovery code.` : active ? `Not yet: @${active.handle} has no passkey, and a contact issues a code only after confirming with one.` : view.contacts.length ? `Not yet: @${view.contacts[0]!.handle} has not accepted, or the wait has not ended.` : 'None yet: name one under "If you lose every passkey".'}</p></div></li>
          <li><Mark tone={view.recoveryCodesLeft > 0 ? 'ok' : 'void'} /><div><p className="sy-t">Saved recovery codes</p><p className="sy-d">{view.recoveryCodesLeft > 0 ? `${view.recoveryCodesLeft} of 10 unused.` : view.codesMade ? 'None left: make new ones under "If you lose every passkey".' : 'None yet: save them under "If you lose every passkey".'}</p></div></li>
        </ul>
        <p className="small">{ready
          ? 'When it takes effect, a recovery needs one of your saved codes and a code from your recovery contact, and every session opened with the password ends; sign in again there with a passkey. Your passkey is asked for first, unless you confirmed with it here in the last five minutes.'
          : 'Without the password, a recovery needs one of your saved codes and a code from an active recovery contact, so both must be in place first: otherwise losing every passkey would lose this account.'}</p>
        <Problem error={remove.error} />
      </Sheet>
    </section>
  )
}

/**
 * The account's state in four tiles, each a link to its part: where it is signed in, how many passkeys can approve, whether
 * a lost device could be recovered, and what waits to take effect. A tile that needs the owner says why in its line.
 */
function SecuritySummary({ sessions, password, usable, hasPasskey, recoveryReady, codesLeft, codesMade, contact, email, waiting }: {
  sessions: number; password: boolean; usable: number; hasPasskey: boolean; recoveryReady: boolean; codesLeft: number; codesMade: boolean; contact: string | null; email: boolean; waiting: number
}) {
  const tiles: { to: string; icon: typeof LogIn; k: string; v: string; s: string; tone: 'ok' | 'wait' | 'void' }[] = [
    { to: '#sign-in', icon: LogIn, k: 'Signing in', v: `${sessions} session${sessions === 1 ? '' : 's'}`, s: password ? 'With a passkey or the password; a password approves nothing' : 'With a passkey only', tone: 'ok' },
    { to: '#passkeys', icon: KeyRound, k: 'Passkeys that approve', v: String(usable), s: !hasPasskey || usable === 0 ? 'None: nothing can be approved until you add one' : usable === 1 ? 'Add one on a second device, so losing this one does not lock you out' : 'On more than one device', tone: !hasPasskey || usable === 0 ? 'void' : usable === 1 ? 'wait' : 'ok' },
    { to: '#recovery', icon: LifeBuoy, k: 'If you lose every device', v: recoveryReady ? 'Recoverable' : 'Not recoverable yet', s: recoveryReady ? `${email ? 'Your email and' : 'A saved code and'} ${email ? (codesLeft ? `a saved code (${codesLeft} left)` : contact ?? 'your second proof') : contact ?? 'your second proof'}, then a wait` : !email && codesLeft > 0 ? 'Add an email address, or name a recovery contact who has a passkey' : codesLeft === 0 && !contact ? (codesMade ? 'No saved codes left: make new ones' : 'Save recovery codes, and name a recovery contact') : 'Name a recovery contact who has a passkey', tone: recoveryReady ? 'ok' : 'wait' },
    { to: waiting ? '#sy-needs-h' : '#recovery-and-signers', icon: TimerReset, k: 'Changes waiting', v: String(waiting), s: waiting ? 'A change that weakens a protection waits; any passkey can cancel it' : 'Nothing is waiting to take effect', tone: waiting ? 'wait' : 'ok' },
  ]
  return (
    <nav className="sy-summary" aria-label="The account's state">
      {tiles.map((t) => {
        const I = t.icon
        return (
          <a key={t.k} href={t.to} className={`sy-tile ${t.tone}`} onClick={(e) => { e.preventDefault(); const el = document.querySelector<HTMLElement>(t.to); if (el) { el.scrollIntoView({ block: 'start' }); if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus({ preventScroll: true }) } }}>
            <span className="sy-tile-k"><I aria-hidden="true" />{t.k}</span>
            <span className="sy-tile-v">{t.v}</span>
            <span className="sy-tile-s">{t.s}</span>
          </a>
        )
      })}
    </nav>
  )
}

/** The page's head; shown while the page loads too, so the heading is there from the start. */
function SecurityHead({ wait }: { wait?: string }) {
  return (
    <header className="page-head sy-head">
      <h1>Security and recovery</h1>
      <p>How you sign in, the passkeys that approve for you, and how you would get back in without them.{wait ? ` A change that weakens a protection waits ${wait}, and any other passkey can cancel it in that time; a passkey you suspect is stolen can be suspended at once.` : ''}</p>
    </header>
  )
}

// ------------------------------------------------------------------------------------------------ R13: recoveries waiting for this person as a guardian

/**
 * Recoveries of other people's wallets that wait for this person's co-signature, as their wallet's guardian (R13). Shown
 * only when there is one. Co-signing is a passkey prompt over that recovery's own digest; declining sends nothing.
 */
function GuardianRequests() {
  const { session } = useSession()
  const q = useData<{ requests: { requestId: string; from: { name: string; handle: string }; since: number; until: number }[]; cosigned?: { requestId: string; from: { name: string; handle: string }; cosignedAt: number }[]; words: string }>('/api/vault/guardian/requests', ['vault'])
  const [done, setDone] = useState<Record<string, string>>({})
  const cosign = useAction(async (id: string) => {
    if (!session.stepUpFresh) await confirmWithPasskey()
    await cosignRecovery(id)
    setDone((x) => ({ ...x, [id]: 'Co-signed: the recovery was sent to their wallet. It completes after its delay unless one of their passkeys that is not frozen stops it.' }))
    q.reload()
  })
  const decline = useAction(async (id: string) => {
    await api('POST', `/api/vault/guardian/requests/${id}/decline`)
    setDone((x) => ({ ...x, [id]: 'Declined: nothing was sent, and their recovery code was not used.' }))
    q.reload()
  })
  // R13 review fix F1: a recovery you co-signed can be withdrawn by you until it finishes (the chain refuses once it has)
  const withdraw = useAction(async (id: string) => {
    await withdrawCosignature(id)
    setDone((x) => ({ ...x, [id]: 'Withdrawn: the recovery is cancelled on their wallet, and the recovery code it used is spent. They have been told.' }))
    q.reload()
  })
  const list = q.data?.requests ?? []
  const given = q.data?.cosigned ?? []
  if (!list.length && !given.length && !Object.keys(done).length) return null
  return (
    <section id="guardian-requests" className="sy-part guardian-requests" aria-labelledby="gr-h">
      <PartHead id="gr-h" level={3} title="Recoveries waiting for you">{q.data?.words}</PartHead>
      <ul className="sy-rows">{list.map((r) => (
        <li key={r.requestId}><span className="sy-glyph" aria-hidden="true"><LifeBuoy /></span><div className="sy-main"><p className="sy-t">{r.from.name}<span className="sy-d"> @{r.from.handle}</span></p>
          <p className="sy-d">Asked {fmt.dayTime(r.since)}; open until {fmt.dayTime(r.until)}. Their wallet's recovery adds one new passkey of theirs as a signer after the wallet's recovery delay.</p></div>
          <span className="sy-acts"><Btn small tone="fill" busy={cosign.busy} onClick={() => void cosign.run(r.requestId)}>Co-sign with your passkey</Btn><Btn small tone="quiet" busy={decline.busy} onClick={() => void decline.run(r.requestId)}>Decline</Btn></span></li>
      ))}
      {given.map((r) => (
        <li key={r.requestId}><span className="sy-glyph" aria-hidden="true"><LifeBuoy /></span><div className="sy-main"><p className="sy-t">{r.from.name}<span className="sy-d"> @{r.from.handle}</span></p>
          <p className="sy-d">You co-signed this recovery {fmt.dayTime(r.cosignedAt)}. If you were misled, withdraw your co-signature: until it finishes, that cancels it on their wallet.</p></div>
          <span className="sy-acts"><Btn small tone="void" busy={withdraw.busy} onClick={() => void withdraw.run(r.requestId)}>Withdraw your co-signature</Btn></span></li>
      ))}</ul>
      {Object.entries(done).map(([id, words]) => <Note key={id} tone="ok">{words}</Note>)}
      <Problem error={cosign.error ?? decline.error ?? withdraw.error} />
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ who signs for the on-chain wallet

interface SignerPasskey { credentialId: string; name: string; person: { name: string; handle: string }; you: boolean; state: 'active' | 'suspended' | 'removed'; registeredAt: number; formerMember?: boolean }
type WalletSigner = { signerId: string; role: 'member'; frozen?: boolean; passkey: SignerPasskey | null; unknown: boolean; pendingRemoval: string | null } | { signerId: string; role: 'recovery'; recoveryKey: { registeredBy: string; registeredAt: number } | null; pendingRecovery: string | null }
  | { signerId: string; role: 'guardian'; guardian: { person: string; handle: string; state: string } | null }
type Pending = { changeId: string; kind: string; readyAt: number; ready: boolean }
/** R13 owner options, as the server reads them from the chain (absent from a server before them). */
interface WalletOptions {
  supported: boolean; why: string | null
  twoDevices: { offered: boolean; on: boolean; possible: boolean; lowering: boolean; tradeOff: string }
  guardian: { offered: boolean; set: { person: string; handle: string; state: string } | null; pending: Pending | null; contacts: { contactId: string; name: string; handle: string; hasPasskey: boolean }[]; words: string }
  timeLock: { offered: boolean; on: boolean; pending: Pending | null }
}
interface WalletSignersView {
  account: string; threshold: number; adminThreshold: number; memberCount: number; delaySeconds: number; recoveryDelaySeconds: number; origin: string
  signers: WalletSigner[]; canAdd: { credentialId: string; name: string; person: { name: string; handle: string } }[]
  pending: Pending[]
  recovery: { keys: number; hasKey: boolean }; warnings: string[]; rules: string[]
  /** R13: whether QED freezes a suspended passkey on this wallet's chain account at once (absent: a wallet set up before it). */
  containment?: { freezes: boolean; protect: boolean }
  options?: WalletOptions
}
/** The on-chain wallet's delays, which it states in seconds. */
const span = (seconds: number): string => delayWords(seconds * 1000)
/** The vault service's sentence, without the identifiers it carries (they are under "Technical details"). */
const said = (t: string | undefined): string => (t ?? '').replace(/\s*\(?0x[0-9a-fA-F]{6,}…?\)?/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (x) => fmt.dayTime(Date.parse(x)))
const OUT: Record<string, ['ok' | 'wait' | 'void', string]> = { executed: ['ok', 'Completed'], scheduled: ['wait', 'Scheduled'], refused: ['void', 'Refused by QED\'s checks; nothing sent'], 'no-action': ['ok', 'Nothing needed doing'], reverted: ['void', 'Refused by the chain'], error: ['void', 'Do not retry'] }

/** What was last asked for here, as the page knew it then; the outcome is said in these terms only when its record is of this kind. */
type Asked =
  | { kind: 'add-signer'; key: false; name: string } | { kind: 'add-signer'; key: true }
  | { kind: 'remove-signers'; name: string } | { kind: 'set-thresholds'; t: number; a: number }
  | { kind: 'cancel-change'; recovery: boolean } | { kind: 'apply-change' } | { kind: 'start-recovery'; name: string }
  | { kind: 'set-guardian'; name: string | null } | { kind: 'set-time-lock'; on: boolean }
const signatures = (n: number): string => `${n} signature${n === 1 ? '' : 's'}`

/** What came back from the chain for the last change asked for here, in plain words, with the record a click away. */
function Outcome({ job, asked, delays }: { job: Job | null; asked: Asked | null; delays: { change: number; recovery: number } }) {
  if (!job) return null
  const live = job.status === 'accepted' || job.status === 'running' || job.status === 'confirming'
  if (live) return <Note tone="qed" title="Sent to the chain">Waiting for it to be recorded there.</Note>
  if (job.status !== 'done' || !job.result) return <Note tone="void" title="It did not complete">{said(job.error ?? 'No result came back.')} {job.guidance ?? ''} <Link to={`/vault/job/${job.id}`}>Open the record</Link></Note>
  const [tone, title] = OUT[job.result.outcome] ?? ['wait', job.result.outcome]
  const readyAt = typeof job.result.evidence?.readyAt === 'number' ? job.result.evidence.readyAt * 1000 : null
  const words = asked && asked.kind === job.kind ? inPlainWords(asked, job.result.outcome, readyAt, delays) : null
  return <Note tone={tone} title={title}>{words ?? said(job.result.summary)} <Link to={`/vault/job/${job.id}`}>Open the record</Link></Note>
}
function inPlainWords(a: Asked, outcome: string, readyAt: number | null, delays: { change: number; recovery: number }): string | null {
  const after = (delay: number) => (readyAt ? `on ${fmt.dayTime(readyAt)}` : `after ${span(delay)}`)
  if (outcome === 'executed') {
    if (a.kind === 'add-signer') return a.key ? 'The wallet now has the recovery key your code stands for. QED cannot show the code again: keep it where you stored it.' : `"${a.name}" now signs for the wallet.`
    if (a.kind === 'set-thresholds') return `The wallet now needs ${signatures(a.t)} for each request and ${signatures(a.a)} to change who signs.`
    if (a.kind === 'cancel-change') return a.recovery ? 'Stopped: the recovery will not happen. Starting it used the recovery key up, so the wallet no longer has it: set up a new one if you want one.' : 'Cancelled: the change that was waiting will not happen.'
    if (a.kind === 'apply-change') return 'The change has taken effect on the chain.'
    if (a.kind === 'set-time-lock' && a.on) return `The time-lock is on: withdrawing, setting money aside for a creditor, resuming the vault and replacing its guardian now wait ${span(delays.change)}, and any signer can cancel them meanwhile.`
    return null
  }
  if (outcome === 'scheduled') {
    if (a.kind === 'remove-signers') return `Removing ${a.name} takes effect ${after(delays.change)}, unless a signer cancels it before then.`
    if (a.kind === 'set-thresholds') return `Needing fewer signatures takes effect ${after(delays.change)}, unless a signer cancels it before then.`
    if (a.kind === 'start-recovery') return `The recovery has started: "${a.name}" can be made a signer ${after(delays.recovery)}, unless a signer stops it before then.`
    if (a.kind === 'set-guardian') return a.name ? `${a.name} becomes the wallet's guardian ${after(delays.change)}, unless a signer cancels it before then.` : `The wallet has no guardian ${after(delays.change)}, unless a signer cancels it before then.`
    if (a.kind === 'set-time-lock') return `The time-lock goes off ${after(delays.change)}, unless a signer cancels it before then. Until then, withdrawals and resuming still wait.`
  }
  return null
}

/**
 * Who can sign for this workspace's on-chain wallet (RISK-053). The wallet's own account on the chain decides: adding
 * a passkey applies at once once the current signers sign it; removing one, or needing fewer signatures, waits the
 * wallet's delay and any other signer can cancel it. A recovery key is made on this device from a code shown once.
 * Its signers are asked for only when the wallet exists (EV-071: the vault service answers 409 otherwise).
 */
function WalletSigners({ setUp, passkeys, current, onChanged }: { setUp: boolean; passkeys: string; current: string | null; onChanged: () => void }) {
  const { session } = useSession()
  const now = useNow(30_000)
  const shared = session.workspace?.kind === 'business'
  const w = useData<WalletSignersView>(setUp ? '/api/vault/signers' : null, ['vault'])
  // a passkey added, suspended or removed above changes who could sign here: read the wallet's signers again
  const reloadSigners = w.reload
  useEffect(() => { reloadSigners() }, [passkeys, reloadSigners])
  const [code, setCode] = useState<string | null>(null)
  // The code stays on screen until its key is on the wallet: closing the sheet unsigned must not lose a code already stored.
  const [keyOf, setKeyOf] = useState<string | null>(null)
  const va = useVaultApproval({ stay: true, onDone: (job) => { if (keyOf && job.kind === 'add-signer' && job.result?.outcome === 'executed') { setCode(null); setStored(false); setKeyOf(null) } w.reload(); onChanged() } })
  const [stored, setStored] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [recovering, setRecovering] = useState<{ code: string; credentialId: string } | null>(null)
  const [limits, setLimits] = useState<{ t: string; a: string } | null>(null)
  const [asked, setAsked] = useState<Asked | null>(null)
  /** A new request: an earlier outcome never stands for it. */
  const begin = (a: Asked) => { va.clear(); setAsked(a) }
  const fresh = async () => { if (!session.stepUpFresh) await confirmWithPasskey() }
  /** A change of who signs needs a fresh passkey confirmation; asked first when the session's is not fresh, or when the server says it lapsed. */
  const ask = useAction(async (path: string, body: unknown, title: string, what: Asked) => {
    begin(what)
    await fresh()
    try { await va.start(path, body, { title }) } catch (e) { if (e instanceof ApiError && e.code === 'stepup_required') { await confirmWithPasskey(); await va.start(path, body, { title }) } else throw e }
  })
  const apply = useAction(async (changeId: string) => { begin({ kind: 'apply-change' }); const a = await api<{ jobId: string }>('POST', `/api/vault/scheduled/${changeId}/apply`, { key: crypto.randomUUID() }); va.watch(a.jobId) })
  // R13 H1: stop a recovery the guardian co-signed through QED (the wallet's sentinel key), with a fresh passkey confirmation
  const [stoppedNote, setStoppedNote] = useState<string | null>(null)
  const stopRecovery = useAction(async (changeId: string) => {
    setStoppedNote(null)
    await fresh()
    try { await api('POST', `/api/vault/recoveries/${changeId}/stop`) } catch (e) { if (e instanceof ApiError && e.code === 'stepup_required') { await confirmWithPasskey(); await api('POST', `/api/vault/recoveries/${changeId}/stop`) } else throw e }
    setStoppedNote('Stopped: the recovery is cancelled on the chain, and the recovery code it used is spent.')
    w.reload(); onChanged()
  })
  const keyUp = useAction(async () => {
    if (!code) return
    await fresh()
    setProgress(0)
    const key = await recoveryKeyFrom(code, (p) => setProgress(p))
    setProgress(null)
    setKeyOf(code)
    begin({ kind: 'add-signer', key: true })
    await va.start('/api/vault/recovery-keys', await recoveryKeyRequest(key), { title: 'Approve: add a recovery key to your wallet', intro: <p>This adds the key your code stands for to the wallet. It can only start a recovery, which waits {span(w.data?.recoveryDelaySeconds ?? 259_200)} and any signer can cancel. The code itself never leaves this device.</p> })
  })
  const recover = useAction(async () => {
    if (!recovering) return
    await fresh()
    setProgress(0)
    const key = await recoveryKeyFrom(recovering.code, (p) => setProgress(p))
    setProgress(null)
    begin({ kind: 'start-recovery', name: mine.find((c) => c.credentialId === recovering.credentialId)?.name ?? 'your passkey' })
    const r = await recoverWallet(key, recovering.credentialId)
    setRecovering(null)
    if (r.jobId) va.watch(r.jobId)
    else if (r.awaitingGuardian) setWaitingFor(r.awaitingGuardian)
  })
  // R13: a recovery that waits for the guardian's co-signature (nothing was sent yet)
  const [waitingFor, setWaitingFor] = useState<{ person: string; until: number } | null>(null)
  const title = shared ? 'Who can sign for this workspace\'s on-chain wallet' : 'Who can sign for your on-chain wallet'
  if (!setUp || w.error) {
    if (!setUp || w.error?.code === 'vault_not_set_up') return <section id="wallet-signers" className="sy-part wallet-signers" aria-labelledby="ws-h"><PartHead id="ws-h" level={3} title={title}>Your on-chain wallet is not set up yet. Once it is, the passkeys that can sign for it, and its recovery key, are managed here.</PartHead><div><Link className="btn sm" to="/vault">Set it up</Link></div></section>
    return <section id="wallet-signers" className="sy-part wallet-signers" aria-labelledby="ws-h"><PartHead id="ws-h" level={3} title={title} /><Problem error={w.error} /></section>
  }
  if (!w.data) return <section id="wallet-signers" className="sy-part wallet-signers" aria-labelledby="ws-h" aria-busy="true"><PartHead id="ws-h" level={3} title={title} /><Loading what="Reading the wallet's signers from the chain" /></section>
  const d = w.data
  const members = d.signers.filter((x): x is Extract<WalletSigner, { role: 'member' }> => x.role === 'member')
  const keys = d.signers.filter((x): x is Extract<WalletSigner, { role: 'recovery' }> => x.role === 'recovery')
  const free = keys.filter((k) => !k.pendingRecovery).length // a key is spent the moment a recovery with it starts
  const named = (changeId: string): string => members.filter((m) => m.pendingRemoval === changeId).map((m) => (m.passkey ? `"${m.passkey.name}"` : 'a key no one here holds')).join(' and ') || 'a signer'
  const mine = d.canAdd.filter((c) => c.person.handle === session.user?.handle)
  const removable = (m: Extract<WalletSigner, { role: 'member' }>) => !m.pendingRemoval && d.memberCount - 1 >= d.adminThreshold
  const pendingWords = (c: WalletSignersView['pending'][number]): string => (c.kind === 'remove-signers' ? `Removing ${named(c.changeId)}` : c.kind === 'set-thresholds' ? 'Needing fewer signatures' : c.kind === 'recovery' ? 'A recovery that adds a new passkey as a signer' : c.kind === 'set-guardian' ? 'A change of the wallet\'s guardian' : c.kind === 'set-time-lock' ? 'Turning the time-lock off' : 'A change')
  const guardians = d.signers.filter((x): x is Extract<WalletSigner, { role: 'guardian' }> => x.role === 'guardian')
  // R13 review fixes and H1 (the owner's rule): with a guardian set and every passkey here frozen, none of the passkeys can
  // cancel a co-signed recovery; the person can stop it from QED (the wallet's sentinel key), and it finishes after its
  // whole delay only because that way stayed open throughout (the chain refuses it if the sentinel changed meanwhile)
  const held = guardians.length > 0 && members.length > 0 && members.every((m) => m.frozen)
  const o = d.options
  const pill = (m: Extract<WalletSigner, { role: 'member' }>): [string, 'ok' | 'wait' | 'void'] => (m.pendingRemoval ? ['Being removed', 'wait'] : m.frozen ? ['Frozen on the chain', 'void'] : m.unknown ? ['Not recognised', 'void'] : m.passkey?.state === 'suspended' ? ['Suspended in QED', 'void'] : m.passkey?.state === 'removed' ? ['Removed in QED', 'void'] : ['Signs', 'ok'])
  return (
    <section id="wallet-signers" className="sy-part wallet-signers" aria-labelledby="ws-h">
      <PartHead id="ws-h" level={3} title={title} aside={d.threshold === 1 ? 'One signature is enough' : `${d.threshold} signatures for each request`}>The wallet's own account on the chain checks every signature; QED only passes them on. {d.threshold === 1 ? 'One of these passkeys is enough for anything the wallet does' : `${d.threshold} different signers must sign each request`}{d.adminThreshold !== d.threshold || d.threshold > 1 ? `, and ${d.adminThreshold} to change who signs` : ''}. Adding a passkey applies at once; removing one waits {span(d.delaySeconds)}, so a stolen key cannot quickly lock the others out.</PartHead>
      {d.warnings.map((x) => <Note key={x} tone="wait">{x}</Note>)}
      <ul className="sy-rows">
        {members.map((m) => { const [label, tone] = pill(m); return (
          <li key={m.signerId}><DeviceGlyph name={m.passkey?.name ?? ''} /><div className="sy-main"><p className="sy-t">{m.passkey ? m.passkey.name : 'A key no one here holds'}{m.passkey ? (m.passkey.you ? <span className="sy-tag">{m.passkey.credentialId === current ? 'yours, this session' : 'yours'}</span> : <span className="sy-d"> {m.passkey.person.name}{m.passkey.formerMember ? ', no longer a member' : ''}</span>) : null}</p>
            <p className="sy-d">{m.pendingRemoval ? `Stops signing ${fmt.dayTime((d.pending.find((c) => c.changeId === m.pendingRemoval)?.readyAt ?? 0) * 1000)}, unless another signer cancels it.` : m.frozen ? 'Frozen on the chain: its signature moves no money and changes nothing on the wallet. It can still cancel a change and stop things until it is removed.' : m.unknown ? 'If nobody here added it, remove it, together with any passkey you have lost, in one removal: no key a removal takes away can stop it.' : m.passkey?.state !== 'active' ? 'QED sends nothing it signs, but the chain still counts it until it is removed here.' : `Signs for the wallet. Registered ${fmt.dayTime(m.passkey.registeredAt)}.`}</p></div>
            <span className="sy-acts"><Stamp tone={tone}>{label}</Stamp>{removable(m) ? <Btn small tone="quiet" busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/remove', m.passkey ? { credentialIds: [m.passkey.credentialId] } : { signerIds: [m.signerId] }, 'Approve: remove a signer from your wallet', { kind: 'remove-signers', name: m.passkey ? `"${m.passkey.name}"` : 'the key no one here holds' })}>Remove</Btn> : null}</span></li>
        ) })}
        {guardians.map((g) => (
          <li key={g.signerId}><span className="sy-glyph" aria-hidden="true"><KeyRound /></span><div className="sy-main"><p className="sy-t">Guardian<span className="sy-d"> {g.guardian ? `${g.guardian.person}'s passkey` : 'a passkey no one in QED holds'}</span></p>
            <p className="sy-d">Co-signs a recovery before it can start. It cannot approve, cancel or move anything.</p></div>
            <span className="sy-acts"><Stamp tone={g.guardian?.state === 'active' ? 'plain' : 'void'}>{g.guardian?.state === 'active' ? 'Co-signs recoveries' : 'Cannot co-sign'}</Stamp></span></li>
        ))}
        {keys.map((k) => (
          <li key={k.signerId}><span className="sy-glyph" aria-hidden="true"><KeyRound /></span><div className="sy-main"><p className="sy-t">Recovery key{k.recoveryKey ? <span className="sy-d"> added by {k.recoveryKey.registeredBy}, {fmt.dayTime(k.recoveryKey.registeredAt)}</span> : null}</p>
            <p className="sy-d">{k.pendingRecovery ? 'A recovery with this key is under way: see below.' : `It can only start a recovery, which waits ${span(d.recoveryDelaySeconds)}; any signer can stop it.`}</p></div>
            <span className="sy-acts"><Stamp tone={k.pendingRecovery ? 'void' : 'plain'}>{k.pendingRecovery ? 'Recovery under way' : 'Recovery only'}</Stamp>{!k.pendingRecovery ? <Btn small tone="quiet" busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/remove', { signerIds: [k.signerId] }, 'Approve: remove a recovery key from your wallet', { kind: 'remove-signers', name: 'the recovery key' })}>Remove</Btn> : null}</span></li>
        ))}
      </ul>
      {d.pending.length ? <div className="sy-sub">
        <h4>Waiting to take effect on the chain</h4>
        <ul className="sy-rows">{d.pending.map((c) => (
          <li key={c.changeId}><Mark tone={c.ready ? 'ok' : 'wait'} /><div className="sy-main"><p className="sy-t">{pendingWords(c)}</p><p className="sy-d">{held && c.kind === 'recovery' ? `Every passkey that signs for this wallet is frozen, so none can cancel it. ${c.ready ? 'Its whole delay has passed: it can be finished now' : `It finishes after its whole delay, ${fmt.dayTime(c.readyAt * 1000)},`} unless you stop it here from QED (with a passkey that is not suspended) or your guardian withdraws it.` : c.ready ? 'Its delay has passed: it can be applied now.' : `Takes effect ${fmt.dayTime(c.readyAt * 1000)} (${fmt.rel(c.readyAt * 1000, now)}) unless a signer cancels it.`}</p></div>
            <span className="sy-acts">{c.ready ? <Btn small busy={apply.busy} onClick={() => void apply.run(c.changeId)}>Apply it now</Btn> : null}{c.kind === 'recovery' && guardians.length > 0 ? <Btn small tone="void" busy={stopRecovery.busy} onClick={() => void stopRecovery.run(c.changeId)}>Stop this recovery</Btn> : null}<Btn small tone="void" busy={va.busy} onClick={() => { begin({ kind: 'cancel-change', recovery: c.kind === 'recovery' }); void va.start('/api/vault/proposals', { kind: 'cancel-change', params: { changeId: c.changeId } }, { title: 'Approve: cancel a change that is waiting' }) }}>Cancel it</Btn></span></li>
        ))}</ul>
      </div> : null}
      {d.canAdd.length ? <div className="sy-sub">
        <h4>Passkeys that do not sign for the wallet yet</h4>
        <ul className="sy-rows">{d.canAdd.map((c, i) => (
          <li key={c.credentialId}><span className="sy-glyph muted" aria-hidden="true"><KeyRound /></span><div className="sy-main"><p className="sy-t">{c.name}{shared ? <span className="sy-d"> {c.person.name}</span> : null}</p><p className="sy-d">Registered in QED, but the wallet does not accept its signature yet.</p></div>
            <span className="sy-acts"><Btn small tone={i === 0 ? 'fill' : undefined} busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/add', { credentialId: c.credentialId }, 'Approve: add a signer to your wallet', { kind: 'add-signer', key: false, name: c.name })}>Make it a signer</Btn></span></li>
        ))}</ul>
      </div> : null}
      {shared ? (limits ? (
        <form className="sy-limits" onSubmit={(e) => { e.preventDefault(); void ask.run('/api/vault/signers/thresholds', { threshold: Number(limits.t), adminThreshold: Number(limits.a) }, 'Approve: change how many must sign', { kind: 'set-thresholds', t: Number(limits.t), a: Number(limits.a) }) }}>
          <Field label="Signatures for each request">{(p) => <input {...p} className="input" inputMode="numeric" value={limits.t} onChange={(e) => setLimits({ ...limits, t: e.target.value })} />}</Field>
          <Field label="Signatures to change who signs">{(p) => <input {...p} className="input" inputMode="numeric" value={limits.a} onChange={(e) => setLimits({ ...limits, a: e.target.value })} />}</Field>
          <div className="row"><Btn type="submit" busy={ask.busy}>Change</Btn><Btn tone="quiet" onClick={() => setLimits(null)}>Close</Btn></div>
        </form>
      ) : <div><Btn small onClick={() => setLimits({ t: String(d.threshold), a: String(d.adminThreshold) })}>Change how many must sign</Btn></div>) : null}

      {o ? <div className="sy-sub wallet-options" aria-labelledby="wo-h">
        <h4 id="wo-h">Protection options</h4>
        {!o.supported ? <Note tone="wait" title="Not on this wallet">{o.why}</Note> : null}
        {o.twoDevices.offered ? <div className="stack" style={{ ['--gap' as string]: '6px' }}>
          <p className="sy-t">Require two of your devices <Stamp tone={o.twoDevices.on ? 'ok' : 'plain'}>{o.twoDevices.on ? 'On' : 'Off'}</Stamp></p>
          <p className="sy-d">{o.twoDevices.tradeOff}</p>
          {o.twoDevices.on
            ? (o.twoDevices.lowering ? <p className="sy-d">Going back to one device is waiting to take effect (above).</p> : <div className="row"><Btn small tone="quiet" busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/thresholds', { threshold: 1, adminThreshold: 1 }, 'Approve: go back to one device', { kind: 'set-thresholds', t: 1, a: 1 })}>Go back to one device</Btn><span className="small muted">waits {span(d.delaySeconds)}</span></div>)
            : o.twoDevices.possible
              ? <div className="row"><Btn small busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/thresholds', { threshold: 2, adminThreshold: 2 }, 'Approve: require two of your devices', { kind: 'set-thresholds', t: 2, a: 2 })}>Require two of your devices</Btn><span className="small muted">applies at once</span></div>
              : <p className="sy-d">Make a second passkey of yours a signer first (above).</p>}
        </div> : null}
        {o.guardian.offered ? <div className="stack" style={{ ['--gap' as string]: '6px' }}>
          <p className="sy-t">Guardian <Stamp tone={o.guardian.set ? 'ok' : 'plain'}>{o.guardian.set ? o.guardian.set.person : 'None'}</Stamp></p>
          <p className="sy-d">{o.guardian.words}</p>
          {o.guardian.pending ? <p className="sy-d">A change of the guardian is waiting to take effect (above).</p>
            : o.guardian.set ? <div className="row"><Btn small tone="quiet" busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/guardian', { remove: true }, 'Approve: remove the wallet\'s guardian', { kind: 'set-guardian', name: null })}>Remove the guardian</Btn><span className="small muted">waits {span(d.delaySeconds)}</span></div>
            : o.guardian.contacts.length ? <ul className="sy-rows">{o.guardian.contacts.map((c) => (
              <li key={c.contactId}><div className="sy-main"><p className="sy-t">{c.name}<span className="sy-d"> your recovery contact</span></p><p className="sy-d">{c.hasPasskey ? 'Their newest passkey would co-sign your wallet\'s recoveries.' : 'They have no passkey that can sign yet.'}</p></div>
                <span className="sy-acts">{c.hasPasskey ? <Btn small busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/guardian', { contactId: c.contactId }, `Approve: make ${c.name} your wallet's guardian`, { kind: 'set-guardian', name: c.name })}>Make {c.name} the guardian</Btn> : null}</span></li>
            ))}</ul>
            : <p className="sy-d">A guardian is one of your recovery contacts. You have none that has accepted yet: name one above, under Recovery contacts.</p>}
        </div> : null}
        {o.timeLock.offered ? <div className="stack" style={{ ['--gap' as string]: '6px' }}>
          <p className="sy-t">Time-lock on withdrawals and resuming <Stamp tone={o.timeLock.on ? 'ok' : 'plain'}>{o.timeLock.on ? 'On' : 'Off'}</Stamp></p>
          <p className="sy-d">{o.timeLock.on ? `Withdrawing, setting money aside for a creditor, resuming the vault after a pause and replacing the vault's guardian each wait ${span(d.delaySeconds)}, and any signer can cancel them meanwhile. Pausing, revoking mandates and payments under a signed mandate are not affected. Funding an earning job from the vault is not possible while it is on.` : `Withdrawing, setting money aside for a creditor, resuming the vault and replacing its guardian run at once at your wallet's threshold. With the time-lock on, each waits ${span(d.delaySeconds)} and any signer can cancel it, so one stolen passkey cannot empty the free balance at once.`}</p>
          {o.timeLock.pending ? <p className="sy-d">Turning it off is waiting to take effect (above).</p>
            : o.timeLock.on ? <div className="row"><Btn small tone="quiet" busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/time-lock', { on: false }, 'Approve: turn the time-lock off', { kind: 'set-time-lock', on: false })}>Turn it off</Btn><span className="small muted">waits {span(d.delaySeconds)}</span></div>
            : <div className="row"><Btn small busy={ask.busy} onClick={() => void ask.run('/api/vault/signers/time-lock', { on: true }, 'Approve: turn the time-lock on', { kind: 'set-time-lock', on: true })}>Turn the time-lock on</Btn><span className="small muted">applies at once</span></div>}
        </div> : null}
      </div> : null}

      <div className="sy-sub">
        <h4>Recovery key</h4>
        {code ? (
          <div className="stack" style={{ ['--gap' as string]: '8px' }}>
            <p className="sy-d">Your wallet's recovery code, made on this device and shown only now. Write it down or store it somewhere other than this device: with it, and a passkey of yours, the wallet can be recovered after {span(d.recoveryDelaySeconds)}.</p>
            <p className="code issued sy-code" aria-label="Wallet recovery code">{code}</p>
            <label className="row small"><input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} /> I have stored this code somewhere other than this device</label>
            {progress !== null ? <p className="small muted" aria-live="polite">Making the key on this device: {Math.round(progress * 100)}%</p> : null}
            <div className="row"><Btn tone="fill" disabled={!stored} busy={keyUp.busy} onClick={() => void keyUp.run()}>Add this recovery key</Btn><Btn tone="quiet" onClick={() => { setCode(null); setStored(false) }}>Discard it</Btn></div>
            <Problem error={keyUp.error} />
          </div>
        ) : <>
          <p className="sy-d">{free ? `The wallet has ${free === 1 ? 'a recovery key' : `${free} recovery keys`} that can start a recovery. ` : keys.length ? 'The wallet\'s recovery key was used by the recovery under way. ' : 'No recovery key yet. '}A recovery key is made on this device from a code shown once; QED never sees the code. It can only start a recovery that adds one of your passkeys as a signer after {span(d.recoveryDelaySeconds)}; any signer can stop it, and starting one uses the code up either way.</p>
          <div><Btn small onClick={() => { va.clear(); setCode(newRecoveryCode()); setStored(false) }}>{keys.length ? 'Make another recovery key' : 'Set up a recovery key'}</Btn></div>
        </>}
        {free && mine.length ? (recovering ? (
          <form className="stack" style={{ ['--gap' as string]: '8px' }} onSubmit={(e) => { e.preventDefault(); void recover.run() }}>
            <p className="sy-d">Lost every passkey that signs for the wallet? Your code can make one of your other passkeys a signer, after {span(d.recoveryDelaySeconds)}. You confirm with that passkey itself: no other passkey can confirm it. Every signer is told and can stop it.</p>
            {mine.length > 1 ? <Field label="The passkey to make a signer">{(p) => <select {...p} className="input" value={recovering.credentialId} onChange={(e) => setRecovering({ ...recovering, credentialId: e.target.value })}>{mine.map((c) => <option key={c.credentialId} value={c.credentialId}>{c.name}</option>)}</select>}</Field> : <p className="small">For the passkey <strong>{mine[0]!.name}</strong>.</p>}
            <Field label="Your wallet's recovery code">{(p) => <input {...p} className="input" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={recovering.code} onChange={(e) => setRecovering({ ...recovering, code: e.target.value })} />}</Field>
            {progress !== null ? <p className="small muted" aria-live="polite">Making the key on this device: {Math.round(progress * 100)}%</p> : null}
            <div className="row"><Btn type="submit" busy={recover.busy} disabled={!recovering.code.trim()}>Start the recovery</Btn><Btn tone="quiet" onClick={() => setRecovering(null)}>Close</Btn></div>
            <Problem error={recover.error} />
          </form>
        ) : <div><Btn small tone="quiet" onClick={() => { va.clear(); setRecovering({ code: '', credentialId: mine[0]!.credentialId }) }}>Recover the wallet with your code</Btn></div>) : null}
      </div>

      {waitingFor ? <Note tone="wait" title="Waiting for your guardian">{waitingFor.person} must now co-sign this recovery in their own QED session, by {fmt.dayTime(waitingFor.until)}. Nothing is sent before they do; the recovery code is spent only then. Tell them you asked for it.</Note> : null}
      <Outcome job={va.job} asked={asked} delays={{ change: d.delaySeconds, recovery: d.recoveryDelaySeconds }} />
      {stoppedNote ? <Note tone="ok">{stoppedNote}</Note> : null}
      <Problem error={ask.error ?? va.error ?? apply.error ?? stopRecovery.error} />
      <div className="sy-disclose">
        <details>
          <summary>How changes take effect</summary>
          <ul className="sy-bullets">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
        <details>
          <summary>Technical details</summary>
          <dl className="kv sy-kv">
            <dt>Wallet account</dt><dd className="code">{d.account}</dd>
            <dt>Signatures from</dt><dd className="code">{d.origin}</dd>
            {d.signers.map((x) => <div key={x.signerId} style={{ display: 'contents' }}><dt>{x.role === 'recovery' ? 'Recovery key' : x.role === 'guardian' ? 'Guardian' : x.passkey?.name ?? 'Unrecognised key'}</dt><dd className="code">{x.signerId}</dd></div>)}
          </dl>
        </details>
      </div>
      {va.sheet}
    </section>
  )
}
