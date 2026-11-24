/**
 * Passkey flows for scripts that drive the API directly (security, recovery, vault journey): create an account,
 * re-authenticate, approve exact terms. A software authenticator (server/softauthn.ts) answers as Touch ID would,
 * claiming the interface's origin on localhost, which is what the API's relying party expects.
 */
import { SoftAuthenticator } from '../../server/softauthn.ts'

/** A script's own HTTP helper: method, path, body; resolves to the JSON body, rejects on a non-200 answer. */
export type Call = (method: string, path: string, body?: unknown) => Promise<Record<string, any>>

export function authenticatorFor(port: number): SoftAuthenticator {
  return new SoftAuthenticator({ origin: `http://localhost:${port}` })
}

/** Create an account with a passkey. Returns the CSRF token for the new session and the recovery codes. */
export async function signUp(ok: Call, auth: SoftAuthenticator, handle: string, displayName: string): Promise<{ csrf: string; userId: string; recoveryCodes: string[] }> {
  const b = await ok('POST', '/api/auth/passkey/signup/begin', { handle, displayName })
  const r = await ok('POST', '/api/auth/passkey/signup/finish', { challengeId: b.challengeId, response: auth.create(b.options) })
  return { csrf: String(r.csrf), userId: String(r.userId), recoveryCodes: r.recoveryCodes as string[] }
}

export async function signIn(ok: Call, auth: SoftAuthenticator): Promise<{ csrf: string }> {
  const b = await ok('POST', '/api/auth/passkey/login/begin')
  const r = await ok('POST', '/api/auth/passkey/login/finish', { challengeId: b.challengeId, response: auth.get(b.options) })
  return { csrf: String(r.csrf) }
}

/** Re-authenticate inside the session (opens the five-minute window for changes that weaken a protection). */
export async function stepUp(ok: Call, auth: SoftAuthenticator): Promise<void> {
  const b = await ok('POST', '/api/auth/passkey/stepup/begin')
  await ok('POST', '/api/auth/passkey/stepup/finish', { challengeId: b.challengeId, response: auth.get(b.options) })
}

/** Sign one approval's exact terms with the passkey. */
export async function approve(ok: Call, auth: SoftAuthenticator, approvalId: string, docHash: string): Promise<Record<string, any>> {
  const b = await ok('POST', `/api/approvals/${approvalId}/passkey`)
  return ok('POST', `/api/approvals/${approvalId}/confirm`, { challengeId: b.challengeId, response: auth.get(b.options), docHash })
}

/**
 * Sign for an on-chain vault: the terms list the digests the chain checks, and the passkey signs each one as the
 * challenge of its own prompt (the wallet's /api/vault/approvals routes; see server/rail.ts).
 */
export async function signVault(ok: Call, auth: SoftAuthenticator, approvalId: string, docHash: string): Promise<Record<string, any>> {
  const b = await ok('POST', `/api/vault/approvals/${approvalId}/sign/begin`)
  const responses = (b.challenges as { challengeId: string; options: never }[]).map((c) => ({ challengeId: c.challengeId, response: auth.get(c.options) }))
  return ok('POST', `/api/vault/approvals/${approvalId}/sign`, { responses, docHash })
}
