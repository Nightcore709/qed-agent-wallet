/**
 * The configuration of sign-in with Google (server/google.ts), read from the environment. A module of its own, importing
 * nothing, so that server/core.ts (loadConfig) can use it.
 */
export interface GoogleConfig {
  clientId: string; clientSecret: string
  /** The `iss` values an ID token may carry. Google documents both forms. */
  issuers: string[]
  /** The issuer the callback must name (RFC 9207). */
  issuer: string
  authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string
  /** Where Google sends the browser back: a page of the interface, which hands the code to POST /api/auth/google/finish. */
  redirectUri: string
  /** True when the issuer is the local stand-in of a test stack: said on the button. */
  standIn: boolean
}

export const GOOGLE_CALLBACK_PATH = '/auth/google/callback'
/**
 * The configuration, from the environment; null when sign-in with Google is not configured. One of the two set without
 * the other, or a stand-in issuer anywhere but an isolated test stack, stops the process with the reason.
 */
export function googleConfig(env: NodeJS.ProcessEnv, linkOrigin: string, publicOrigin: string | null): GoogleConfig | null {
  const clientId = env.QED_GOOGLE_CLIENT_ID?.trim() ?? '', clientSecret = env.QED_GOOGLE_CLIENT_SECRET?.trim() ?? ''
  const standIn = env.QED_GOOGLE_ISSUER?.trim() ?? ''
  if (!clientId && !clientSecret) {
    if (standIn) throw new Error('Configuration: QED_GOOGLE_ISSUER is set without QED_GOOGLE_CLIENT_ID and QED_GOOGLE_CLIENT_SECRET.')
    return null
  }
  if (!clientId || !clientSecret) throw new Error('Configuration: QED_GOOGLE_CLIENT_ID and QED_GOOGLE_CLIENT_SECRET are set together or not at all. With one missing, sign-in with Google cannot work, so QED does not start with half of it.')
  const redirectUri = `${linkOrigin}${GOOGLE_CALLBACK_PATH}`
  if (standIn) {
    if (env.QED_TEST_STACK !== '1' || publicOrigin) throw new Error('Configuration: QED_GOOGLE_ISSUER names a stand-in issuer for tests. It is honoured only on an isolated test stack (QED_TEST_STACK=1) with no public origin; Google\'s own endpoints are built in.')
    let u: URL
    try { u = new URL(standIn) } catch { throw new Error(`Configuration: QED_GOOGLE_ISSUER (${standIn}) is not a URL.`) }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/' || u.search || u.hash) throw new Error('Configuration: QED_GOOGLE_ISSUER must be an http:// origin on this computer (127.0.0.1 or localhost).')
    return { clientId, clientSecret, issuers: [u.origin], issuer: u.origin, authorizationEndpoint: `${u.origin}/authorize`, tokenEndpoint: `${u.origin}/token`, jwksUri: `${u.origin}/jwks`, redirectUri, standIn: true }
  }
  return {
    clientId, clientSecret, issuers: ['https://accounts.google.com', 'accounts.google.com'], issuer: 'https://accounts.google.com',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token', jwksUri: 'https://www.googleapis.com/oauth2/v3/certs', redirectUri, standIn: false,
  }
}
