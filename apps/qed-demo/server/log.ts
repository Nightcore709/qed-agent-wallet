/**
 * Operational log lines (docs/DEPLOY.md, "Logs"). One line per event: JSON when QED_LOG_FORMAT=json (the container
 * image sets it, so a host's log store can parse every line), else readable text (the local build). Every line, and
 * every line of a child process the supervisor passes on (scripts/deploy/supervise.ts), goes through redact() first.
 *
 * What a log line may hold: the service, the event, times, process ids, paths of the data folder, HTTP methods, route
 * paths, status codes, error classes and codes, counts. What it must not: request bodies, query strings, cookies, CSRF
 * or bearer tokens, keys, passwords, recovery codes, e-mail addresses, payment handles (UPI-style addresses) and the
 * like. Redaction is a second line of defence: the code does not log those in the first place (ASVS 16.2.5, 16.3; NIST
 * SP 800-92), and the tests in server/log.test.ts hold each rule.
 */

export type Level = 'info' | 'warn' | 'error'
type Env = Record<string, string | undefined>

const RULES: [RegExp, string | ((m: string) => string)][] = [
  // the key-encryption key's record (server/keys.ts: qedkek1:<id>:<key>:<check>)
  [/qedkek1:[^\s"',;]+/g, 'qedkek1:[redacted]'],
  // credentials named in headers or settings, whatever follows them on the line up to a separator
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-qed-csrf|x-qed-adviser|x-postmark-server-token|x-postmark-account-token)(["']?\s*[:=]\s*)("[^"]*"|[^\s,;]+)/gi, '$1$2[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  // a session cookie however it is named (qed_session, __Host-qed_session)
  [/\b((?:__Host-)?qed_session)=[^\s;,"']+/g, '$1=[redacted]'],
  // JSON or key=value pairs whose name says secret
  [/("?(?:password|passphrase|secret|token|csrf|recoveryCodes?|contactCodes?|kek|privateKey|private_key|mnemonic|apiKey|api_key)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\]|[^\s,;}]+)/gi, '$1[redacted]'],
  // query strings and fragments of a URL or a request path: they can carry search terms, handles, ids, tokens
  [/((?:https?:\/\/[^\s/?#"']+)?\/[^\s?#"']*)[?#][^\s"']*/g, '$1?[redacted]'],
  // 32-byte secrets written as hex (the wallet service's master secret, private keys); also hides digests, by design
  [/\b(?:0x)?[0-9a-fA-F]{64}\b/g, '[redacted-hex]'],
  // long opaque tokens (session and bearer tokens are 43 base64url characters); a 40-digit hex git revision or chain
  // address is public and kept
  [/(?<![A-Za-z0-9_/.-])(?:0x)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_/.-])/g, (m) => (/^(?:0x)?[0-9a-fA-F]{40}$/.test(m) ? m : '[redacted-token]')],
  // e-mail addresses, then payment handles (name@bank, as UPI writes them)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._-]+@[A-Za-z]{2,}\b/g, '[redacted-handle]'],
]

/** The text with every pattern that may carry a secret or personal data replaced. Idempotent. */
export function redact(text: string): string {
  let out = text
  for (const [re, by] of RULES) out = typeof by === 'string' ? out.replace(re, by) : out.replace(re, by)
  return out
}

/** Field names whose values are never written, whatever they hold. */
const SECRET_FIELD = /pass(word|phrase)?$|secret|token|cookie|csrf|kek|private|mnemonic|recovery|contactcode|authorization|signature|^body$|^headers?$|^query$/i

function cleanField(key: string, v: unknown): unknown {
  if (SECRET_FIELD.test(key)) return '[redacted]'
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return redact(v)
  if (v instanceof Error) return redact(`${v.name}: ${v.message}`)
  try { return redact(JSON.stringify(v) ?? String(v)) } catch { return '[unserialisable]' }
}

/** One line, redacted, in the configured format. `fields` are merged into the JSON object, or appended as key=value. */
export function formatLine(svc: string, level: Level, event: string, fields: Record<string, unknown> = {}, env: Env = process.env, now = new Date()): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = cleanField(k, v)
  if (env.QED_LOG_FORMAT === 'json') return JSON.stringify({ ts: now.toISOString(), level, svc, event: redact(event), ...clean })
  const tail = Object.entries(clean).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
  return `[${svc}] ${redact(event)}${tail ? ` ${tail}` : ''}`
}

/** Write one operational line: info to standard output, warnings and errors to standard error. */
export function log(svc: string, level: Level, event: string, fields: Record<string, unknown> = {}, env: Env = process.env): void {
  const line = formatLine(svc, level, event, fields, env)
  if (level === 'info') process.stdout.write(`${line}\n`)
  else process.stderr.write(`${line}\n`)
}
