/**
 * The configuration of email through Postmark (server/postmark.ts), read from the environment. A module of its own,
 * importing only node:fs, so that server/core.ts (loadConfig) can use it. Anything missing or malformed stops the process
 * with the reason: QED never starts with half of an email setup and never falls back to saying a message was sent.
 *
 *   QED_DELIVERY=postmark          switches it on
 *   QED_POSTMARK_TOKEN             the Server API token of the Postmark server (or QED_POSTMARK_TOKEN_FILE: a file that
 *                                  holds it); never logged, never in an error message
 *   QED_MAIL_FROM                  the sender, on a domain verified at Postmark: "QED <no-reply@mail.example.com>"
 *   QED_POSTMARK_STREAM            the message stream (default "outbound", Postmark's transactional stream)
 *   QED_POSTMARK_URL               tests only: a stand-in on this computer (see postmarkBaseUrl)
 */
import { readFileSync } from 'node:fs'

export interface PostmarkConfig {
  /** The Server API token. Held in memory for the header of each request; never written anywhere. */
  token: string
  /** The From header exactly as it will be sent. */
  from: string
  /** The bare address of `from`. */
  fromAddress: string
  stream: string
  /** https://api.postmarkapp.com, or the stand-in of a test stack. */
  baseUrl: string
  /** True when baseUrl is the local stand-in of a test stack (nothing leaves this computer). */
  standIn: boolean
}

export const POSTMARK_API = 'https://api.postmarkapp.com'
const fail = (m: string): never => { throw new Error(`Configuration: ${m}`) }

/**
 * Postmark's address: the real one, unless a test stack asks for its stand-in. The stand-in is honoured only with
 * QED_TEST_STACK=1, no public origin, and an http:// origin on this computer (127.0.0.1 or localhost); in any other
 * setting QED_POSTMARK_URL stops the process, so a production configuration can never be pointed at anything else.
 */
export function postmarkBaseUrl(env: NodeJS.ProcessEnv, publicOrigin: string | null): { baseUrl: string; standIn: boolean } {
  const asked = env.QED_POSTMARK_URL?.trim() ?? ''
  if (!asked) return { baseUrl: POSTMARK_API, standIn: false }
  if (env.QED_TEST_STACK !== '1' || publicOrigin) fail('QED_POSTMARK_URL names a stand-in for tests. It is honoured only on an isolated test stack (QED_TEST_STACK=1) with no public origin; Postmark\'s own address is built in.')
  let u: URL
  try { u = new URL(asked) } catch { return fail('QED_POSTMARK_URL is not a URL.') }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) fail('QED_POSTMARK_URL must be an http:// origin on this computer (127.0.0.1 or localhost).')
  return { baseUrl: u.origin, standIn: true }
}

/** "QED <no-reply@mail.example.com>" or "no-reply@mail.example.com": the address checked, the display name kept plain. */
export function parseFrom(raw: string): { from: string; address: string } {
  const v = raw.trim()
  const m = /^(?:([^<>"\\\r\n\t]{1,80}?)\s*<([^<>\s]+)>|([^<>\s]+))$/.exec(v)
  if (!m) return fail(`QED_MAIL_FROM (${JSON.stringify(v.slice(0, 80))}) is not a sender address. Use "QED <no-reply@mail.example.com>" or "no-reply@mail.example.com".`)
  const address = (m[2] ?? m[3])!
  const at = address.lastIndexOf('@')
  const local = address.slice(0, at), domain = address.slice(at + 1)
  const labels = domain.split('.')
  if (at < 1 || local.length > 64 || !/^[A-Za-z0-9._%+-]+$/.test(local) || labels.length < 2 || labels.some((l) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)) || !/^[A-Za-z]{2,}$/.test(labels.at(-1)!)) {
    return fail(`QED_MAIL_FROM (${JSON.stringify(v.slice(0, 80))}) does not hold a valid email address.`)
  }
  return { from: m[1] ? `${m[1].trim()} <${address}>` : address, address }
}

function tokenOf(env: NodeJS.ProcessEnv): string {
  const direct = env.QED_POSTMARK_TOKEN?.trim() ?? '', file = env.QED_POSTMARK_TOKEN_FILE?.trim() ?? ''
  if (direct && file) fail('QED_POSTMARK_TOKEN and QED_POSTMARK_TOKEN_FILE are both set; set one.')
  let token = direct
  if (file) {
    try { token = readFileSync(file, 'utf8').trim() } catch { fail('QED_POSTMARK_TOKEN_FILE could not be read.') }
  }
  if (!token) return fail('QED_DELIVERY=postmark needs QED_POSTMARK_TOKEN (the Server API token of the Postmark server) or QED_POSTMARK_TOKEN_FILE. Without it nothing can be sent, so QED does not start.')
  // a header value: no spaces or control characters, so it cannot be anything but a token
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(token)) fail('The Postmark token (QED_POSTMARK_TOKEN or the file named by QED_POSTMARK_TOKEN_FILE) is not shaped like a Server API token.')
  return token
}

/** The settings for QED_DELIVERY=postmark; throws, with the reason and never the token, when any is missing or malformed. */
export function postmarkConfig(env: NodeJS.ProcessEnv, publicOrigin: string | null): PostmarkConfig {
  const token = tokenOf(env)
  const rawFrom = env.QED_MAIL_FROM?.trim() ?? ''
  if (!rawFrom) fail('QED_DELIVERY=postmark needs QED_MAIL_FROM, the sender, for example "QED <no-reply@mail.example.com>", on a domain verified at Postmark.')
  const { from, address } = parseFrom(rawFrom)
  const stream = env.QED_POSTMARK_STREAM?.trim() || 'outbound'
  if (!/^[A-Za-z0-9-]{1,50}$/.test(stream)) fail('QED_POSTMARK_STREAM is the id of a message stream: letters, digits and hyphens ("outbound" is the default transactional stream).')
  return { token, from, fromAddress: address, stream, ...postmarkBaseUrl(env, publicOrigin) }
}
