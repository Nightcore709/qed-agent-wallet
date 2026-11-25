/**
 * The browser's half of passkeys. Each function asks the server for options, lets the device's authenticator (built into
 * the device, a password manager, a phone nearby or a security key) create or use a passkey, and sends the result back.
 * The device checks that it is the person (WebAuthn user verification) in whatever way it is set up to; QED never
 * receives a fingerprint, a face or a PIN, only a signature, and never promises one way of checking over another.
 */
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService, WebAuthnError } from '@simplewebauthn/browser'
import { api, ApiError, setCsrf } from './core.ts'

type Options = { challengeId: string; options: Record<string, unknown> }

export const passkeysAvailable = (): boolean => browserSupportsWebAuthn()
/**
 * Whether this device can hold a passkey itself and check that it is the person (a platform authenticator with user
 * verification: Touch ID, Windows Hello, a phone's screen lock). False means a passkey is still possible, on a phone
 * nearby or a security key; null where the browser cannot say. Used only to tell the person what to expect (R14).
 */
export async function platformPasskeyAvailable(): Promise<boolean | null> {
  try {
    const pk = (globalThis as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential
    return pk?.isUserVerifyingPlatformAuthenticatorAvailable ? await pk.isUserVerifyingPlatformAuthenticatorAvailable() : null
  } catch { return null }
}

/**
 * What this device will ask for, so the button says what will happen. A passkey is unlocked by the device in whatever
 * way it is set up (R12: no promise of a particular biometric method): the platform's usual checks are named only as
 * examples, always with the one that is not a biometric (a passcode, a PIN, a password), because the device may have no
 * biometric, the person may not use it, or the passkey may live in a password manager or on a phone nearby that asks
 * its own way. QED never receives the face, the fingerprint or the PIN, only a signature. The words follow the platform
 * the browser reports; where it cannot tell, they name the general case.
 */
export function deviceWords(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''
  if (/iPhone|iPad|iPod/.test(ua)) return 'its usual check, such as Face ID, Touch ID or its passcode'
  if (/Android/.test(ua) || platform === 'Android') return 'its usual check, such as a fingerprint, face or screen lock'
  if (/Mac OS X|Macintosh/.test(ua) || platform === 'macOS') return 'its usual check, such as Touch ID or your Mac\'s password, or a phone nearby'
  if (/Windows/.test(ua) || platform === 'Windows') return 'its usual check, such as Windows Hello (face, fingerprint or PIN), or a phone nearby'
  return 'its usual check, such as its screen lock, a phone nearby or a security key'
}

/** Whether this browser can offer the account's passkeys in the handle field's own suggestions (conditional mediation). */
export const passkeyAutofillAvailable = (): Promise<boolean> => browserSupportsWebAuthnAutofill().catch(() => false)

/**
 * Sign in by choosing a passkey from the handle field's suggestions. It waits until one is chosen; pressing "Sign in
 * with a passkey" instead cancels this wait (the library aborts the earlier request) and starts its own.
 */
/** Stop offering passkeys in the handle field (leaving sign-in for account creation, say). */
export function stopAutofill(): void { try { WebAuthnAbortService.cancelCeremony() } catch { /* nothing was waiting */ } }

export async function signInWithAutofill(): Promise<void> {
  const b = await api<Options>('POST', '/api/auth/passkey/login/begin')
  let response: unknown
  try { response = await startAuthentication({ optionsJSON: b.options as never, useBrowserAutofill: true }) } catch (e) { explain(e) }
  const r = await api<{ csrf: string }>('POST', '/api/auth/passkey/login/finish', { challengeId: b.challengeId, response })
  setCsrf(r.csrf)
}

/** Turn the authenticator's refusals into sentences. A cancelled prompt is not an error worth alarming anyone over. */
function explain(e: unknown): never {
  if (e instanceof ApiError) throw e
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY') throw new ApiError(0, 'passkey_cancelled', 'The passkey prompt was closed before it finished. Nothing was signed.')
    if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') throw new ApiError(0, 'passkey_exists', 'This device already holds a passkey for this account.')
    if (e.code === 'ERROR_CEREMONY_ABORTED') throw new ApiError(0, 'passkey_aborted', 'The passkey request was replaced by another.')
    // the rest in words a person can act on; the library's code stays at the end for whoever has to look into it
    const words: Partial<Record<string, string>> = {
      ERROR_INVALID_DOMAIN: 'Passkeys for QED work only at the address QED was set up on, and this page is open at another. Open QED at its usual address and try again.',
      ERROR_INVALID_RP_ID: 'Passkeys for QED work only at the address QED was set up on, and this page is open at another. Open QED at its usual address and try again.',
      ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT: 'This device cannot keep a passkey that signs in by itself. Use another device, or sign in with your handle and password.',
      ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT: 'This device cannot check that it is you (face, fingerprint or PIN), and QED needs that for every passkey.',
      ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG: 'This device cannot make the kind of passkey QED uses. Try another device.',
      ERROR_AUTHENTICATOR_GENERAL_ERROR: 'The device could not finish with the passkey. Nothing was signed; try again.',
    }
    throw new ApiError(0, 'passkey_failed', `${words[e.code] ?? 'The passkey could not be used. Nothing was signed.'} (${e.code})`)
  }
  if (e instanceof Error && e.name === 'NotAllowedError') throw new ApiError(0, 'passkey_cancelled', 'The passkey prompt was closed before it finished. Nothing was signed.')
  throw new ApiError(0, 'passkey_failed', e instanceof Error ? e.message : 'The passkey could not be used.')
}

async function create(begin: Options): Promise<unknown> {
  try { return await startRegistration({ optionsJSON: begin.options as never }) } catch (e) { explain(e) }
}
async function use(begin: Options): Promise<unknown> {
  try { return await startAuthentication({ optionsJSON: begin.options as never }) } catch (e) { explain(e) }
}

/** Create an account: the handle is reserved only when the passkey verifies. Returns the recovery codes, shown once. */
export async function signUp(handle: string, displayName: string, passkeyName?: string): Promise<string[]> {
  const b = await api<Options>('POST', '/api/auth/passkey/signup/begin', { handle, displayName })
  const response = await create(b)
  const r = await api<{ csrf: string; recoveryCodes: string[] }>('POST', '/api/auth/passkey/signup/finish', { challengeId: b.challengeId, response, passkeyName })
  setCsrf(r.csrf)
  return r.recoveryCodes
}

/**
 * Create an account with a handle and a password (D-094). It can read and set up everything; approving anything needs a
 * passkey, which the next screen offers to add. Returns the recovery codes, shown once.
 */
export async function signUpWithPassword(handle: string, displayName: string, password: string): Promise<string[]> {
  const r = await api<{ csrf: string; recoveryCodes: string[] }>('POST', '/api/auth/signup', { handle, displayName, password })
  setCsrf(r.csrf)
  return r.recoveryCodes
}

export async function signInWithPassword(handle: string, password: string): Promise<void> {
  const r = await api<{ csrf: string }>('POST', '/api/auth/login', { handle, password })
  setCsrf(r.csrf)
}

export async function signIn(): Promise<void> {
  const b = await api<Options>('POST', '/api/auth/passkey/login/begin')
  const response = await use(b)
  const r = await api<{ csrf: string }>('POST', '/api/auth/passkey/login/finish', { challengeId: b.challengeId, response })
  setCsrf(r.csrf)
}

/** Re-authenticate inside the session, so the next few minutes may change protections. */
export async function confirmWithPasskey(): Promise<void> {
  const b = await api<Options>('POST', '/api/auth/passkey/stepup/begin')
  const response = await use(b)
  await api('POST', '/api/auth/passkey/stepup/finish', { challengeId: b.challengeId, response })
}

/** Sign the exact terms of one approval. The challenge is derived on the server from the approval and its terms. */
/** In a business workspace one signature may not be enough: `complete` says whether the request has taken effect. */
export async function approveWithPasskey(approvalId: string, docHash: string): Promise<{ confirmedAt: number | null; complete: boolean; signed: number; required: number }> {
  const b = await api<Options>('POST', `/api/approvals/${approvalId}/passkey`)
  const response = await use(b)
  return api('POST', `/api/approvals/${approvalId}/confirm`, { challengeId: b.challengeId, response, docHash })
}

/**
 * Sign for an on-chain vault: each digest the terms list (the owner account's digest of the exact calls, the hash of a
 * mandate or instruction, or a cancellation) is the challenge of its own passkey prompt, offered only to the passkeys
 * that are the vault's signers. The chain checks these signatures before anything runs.
 *
 * R13 ("Require two of your devices"): when the vault needs more than one of the person's passkeys, the server answers
 * the first round with `devices.next: 'another-device'`; `onNextDevice` is told, and the next round's prompts are offered
 * only to the passkeys not used yet, until every digest has its devices.
 */
export async function signForVault(approvalId: string, docHash: string, onNextDevice?: (done: number, needed: number) => void): Promise<{ confirmedAt: number | null; complete: boolean; signed: number; required: number; devices?: { needed: number; done: number } }> {
  for (let round = 0; round < 16; round++) {
    const b = await api<{ challenges: Options[] }>('POST', `/api/vault/approvals/${approvalId}/sign/begin`)
    const responses: { challengeId: string; response: unknown }[] = []
    for (const c of b.challenges) responses.push({ challengeId: c.challengeId, response: await use(c) })
    const r = await api<{ confirmedAt: number | null; complete: boolean; signed: number; required: number; devices?: { needed: number; done: number; next?: string } }>('POST', `/api/vault/approvals/${approvalId}/sign`, { responses, docHash })
    if (r.devices?.next !== 'another-device') return r
    onNextDevice?.(r.devices.done, r.devices.needed)
  }
  throw new Error('Signing took more rounds than this vault has passkeys. Nothing was approved.')
}

/**
 * Money-model S5: set the household's wallet up with test tokens other than the default. The passkey signs the
 * configuration's digest (the prompt's challenge, from the server), and the vault service checks that signature before it
 * creates anything. The default needs no signature and goes through /api/vault/setup as before.
 */
export async function setUpVaultWithTokens(origin: string, currencies: { treasury: string; reserve: string; route: string }, timeLock = false): Promise<unknown> {
  const b = await api<Options & { digest: string }>('POST', '/api/vault/currencies/begin', { origin, currencies })
  const response = await use(b)
  // R13: the time-lock, chosen at set-up, travels with the request (it only adds protection, so it needs no signature of its own)
  return api('POST', '/api/vault/setup', { origin, currencies, challengeId: b.challengeId, response, ...(timeLock ? { timeLock: true } : {}) })
}

/**
 * A password account's first passkey (D-094): the password typed again, which unlocks exactly this, then the device
 * makes the passkey. The server refuses it if the account has a passkey by then.
 */
export async function addFirstPasskey(password: string, passkeyName?: string): Promise<{ id: string; name: string }> {
  await api('POST', '/api/auth/stepup', { password })
  return addPasskey(passkeyName)
}

export async function addPasskey(passkeyName?: string): Promise<{ id: string; name: string }> {
  const b = await api<Options>('POST', '/api/security/passkeys/begin')
  const response = await create(b)
  return (await api<{ passkey: { id: string; name: string } }>('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response, passkeyName })).passkey
}

/** Two codes from different methods: a saved code, and one a recovery contact issued (or a legacy account's password). */
export async function startRecovery(handle: string, code: string, second: { contactCode?: string; password?: string }): Promise<{ requestId: string; availableAt: number; reference: string }> {
  return api('POST', '/api/auth/recovery/start', { handle, code, ...second })
}

/**
 * Completes a recovery of the backup path (saved code and a second code, no email) that has waited out its delay, with
 * the reference the start gave (only the person who started it has that; a session of the account sees the recovery
 * listed but cannot finish it). The new passkey signs in only. Returns the new saved codes, to be shown once.
 */
export async function finishRecovery(reference: string, passkeyName?: string): Promise<string[]> {
  const b = await api<Options>('POST', '/api/auth/recovery/passkey/begin', { reference: reference.trim() })
  const response = await create(b)
  const r = await api<{ csrf: string; recoveryCodes: string[] }>('POST', '/api/auth/recovery/passkey/finish', { challengeId: b.challengeId, response, passkeyName })
  setCsrf(r.csrf)
  return r.recoveryCodes
}

/**
 * Finishes a recovery started from an email link, with the newest link and the finishing key the browser that started it
 * was given (R12; review H1: the link alone finishes nothing): this device makes the account's new passkey, which signs
 * in only until approval authority is restored. Returns the new saved codes when the recovery spent one (none otherwise).
 */
export async function finishRecoveryWithLink(token: string, finishKey: string, passkeyName?: string): Promise<string[]> {
  const b = await api<Options>('POST', '/api/auth/recovery/link/passkey/begin', { token, finishKey: finishKey.trim() })
  const response = await create(b)
  const r = await api<{ csrf: string; recoveryCodes: string[] }>('POST', '/api/auth/recovery/link/passkey/finish', { challengeId: b.challengeId, response, passkeyName })
  setCsrf(r.csrf)
  return r.recoveryCodes
}

/**
 * Ask for approval authority with the passkey a recovery registered (R12): the device proves that passkey is here; the
 * authority is given when the wait ends, unless another passkey of the account or a recovery contact stops it.
 */
export async function requestAuthority(): Promise<{ changeId: string; effectiveAt: number; passkey: string }> {
  const b = await api<Options>('POST', '/api/security/authority/begin')
  const response = await use(b)
  return api('POST', '/api/security/authority/finish', { challengeId: b.challengeId, response })
}

// ------------------------------------------------------------------------------------------------ the on-chain wallet's recovery key
/*
 * A recovery key for the on-chain wallet (RISK-053): a raw P-256 key that can do one thing on the chain, start a
 * recovery that adds one passkey as a signer after the wallet's recovery delay, which any signer can cancel. It is made
 * here, on this device, from a code shown once: 130 random bits as 26 Crockford base-32 characters. The key is derived
 * exactly as chain/accounts/webauthn.ts RecoveryKey derives it (scrypt N 2^15, r 8, p 1, the fixed salt, 48 bytes,
 * reduced into P-256's scalars), so the code works with the account's own tools too. QED's server receives the public
 * key and signatures made with it; never the code and never the private key.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const hex32 = (x: bigint): string => `0x${x.toString(16).padStart(64, '0')}`
const bytesToBig = (b: Uint8Array): bigint => { let n = 0n; for (const v of b) n = (n << 8n) | BigInt(v); return n }
const hexToBytes = (h: string): Uint8Array => { const s = h.replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out }

/** A new recovery code, from this device's random source: 26 characters grouped 5-5-5-5-6. Never shorten it: its key is public. */
export function newRecoveryCode(): string {
  const bits = bytesToBig(crypto.getRandomValues(new Uint8Array(17))) >> 6n
  let chars = ''
  for (let i = 25; i >= 0; i--) chars += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)]
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i === 20 ? 26 : i + 5)).join('-')
}
/** A code as typed: case, spaces and dashes do not matter, and O, I and L read as 0, 1 and 1. Null when it is not a code. */
export function normaliseRecoveryCode(code: string): string | null {
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(c) ? c : null
}

export interface WalletRecoveryKey { publicKey: { x: string; y: string }; sign: (message: string) => { r: string; s: string } }
/**
 * The recovery key a code stands for. `sign` is ECDSA P-256 over SHA-256 of the given bytes (hex), with s in its low
 * form, as the wallet's owner account checks it. About a second of work on purpose (scrypt).
 */
export async function recoveryKeyFrom(code: string, onProgress?: (done: number) => void): Promise<WalletRecoveryKey> {
  const c = normaliseRecoveryCode(code)
  if (!c) throw new ApiError(0, 'recovery_code_format', 'A recovery code has 26 letters and digits; spaces and dashes do not matter. Check it and try again.')
  // loaded only when a recovery key is made or used, not with every page
  const [{ p256 }, { scryptAsync }, { sha256 }] = await Promise.all([import('@noble/curves/p256'), import('@noble/hashes/scrypt'), import('@noble/hashes/sha2')])
  const material = await scryptAsync(new TextEncoder().encode(c), new TextEncoder().encode('QEDOwnerAccount recovery v1'), { N: 1 << 15, r: 8, p: 1, dkLen: 48, maxmem: 64 * 1024 * 1024, ...(onProgress ? { onProgress } : {}) })
  const priv = hexToBytes(hex32((bytesToBig(material) % (p256.CURVE.n - 1n)) + 1n))
  const pub = p256.getPublicKey(priv, false)
  return {
    publicKey: { x: hex32(bytesToBig(pub.slice(1, 33))), y: hex32(bytesToBig(pub.slice(33, 65))) },
    sign: (message: string) => { const s = p256.sign(sha256(hexToBytes(message)), priv, { lowS: true }); return { r: hex32(s.r), s: hex32(s.s) } },
  }
}

/** What registers a recovery key (POST /api/vault/recovery-keys): its public key and a proof, over a fresh request from QED, that this device holds it. */
export async function recoveryKeyRequest(key: WalletRecoveryKey): Promise<{ challengeId: string; publicKey: { x: string; y: string }; proof: { r: string; s: string } }> {
  const b = await api<{ challengeId: string; challenge: string }>('POST', '/api/vault/recovery-keys/begin')
  return { challengeId: b.challengeId, publicKey: key.publicKey, proof: key.sign(b.challenge) }
}

/**
 * Start a recovery of the wallet for one of this person's passkeys that is not a signer: the passkey being added confirms
 * this very request (R13: its prompt offers no other passkey), and the recovery key signs the account's digest.
 */
export async function recoverWallet(key: WalletRecoveryKey, credentialId: string): Promise<{ jobId: string | null; recoveryDelaySeconds: number; awaitingGuardian?: { person: string; until: number } }> {
  const b = await api<{ requestId: string; digest: string; recoveryDelaySeconds: number; confirm: Options }>('POST', '/api/vault/recovery/begin', { recoveryKey: key.publicKey, credentialId })
  const response = await use(b.confirm)
  const r = await api<{ jobId?: string; awaitingGuardian?: { person: string; until: number } }>('POST', '/api/vault/recovery', { requestId: b.requestId, signature: key.sign(b.digest), confirmation: { challengeId: b.confirm.challengeId, response } })
  // R13: a wallet with a guardian sends the recovery only once the guardian has co-signed it in their own session
  return { jobId: r.jobId ?? null, recoveryDelaySeconds: b.recoveryDelaySeconds, ...(r.awaitingGuardian ? { awaitingGuardian: r.awaitingGuardian } : {}) }
}

/**
 * R13: as a guardian, co-sign a recovery of someone else's wallet: the passkey signs the recovery's own digest (the
 * challenge the server derives from that request), offered only to the passkey that is the guardian.
 */
/** R13 review fix F1: the guardian withdraws its co-signature of a pending recovery, with the same passkey. */
export async function withdrawCosignature(requestId: string): Promise<{ jobId: string }> {
  const b = await api<Options>('POST', `/api/vault/guardian/requests/${requestId}/withdraw/begin`)
  const response = await use(b)
  return api('POST', `/api/vault/guardian/requests/${requestId}/withdraw`, { challengeId: b.challengeId, response })
}

export async function cosignRecovery(requestId: string): Promise<{ jobId: string }> {
  const b = await api<Options>('POST', `/api/vault/guardian/requests/${requestId}/cosign/begin`)
  const response = await use(b)
  return api('POST', `/api/vault/guardian/requests/${requestId}/cosign`, { challengeId: b.challengeId, response })
}
