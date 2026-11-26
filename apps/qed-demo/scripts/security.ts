/**
 * Active security checks against an isolated copy of QED, under the passkey design of R7 (D2 passkeys, D3 approvals as
 * passkey signatures over exact terms, D1 business workspaces with roles).
 *
 *   node scripts/security.ts [report.json]
 *
 * It starts its own engine and API on a fresh scratch database and a spare port, creates paper owners with a software
 * passkey authenticator (server/softauthn.ts, answering as Touch ID would for http://localhost:<port>), and then tries
 * the things that must not work: reading without a session, changing state without the CSRF token, cross-site and
 * rebinding requests, creating an account without a verified passkey, one owner touching another's objects, approving
 * with another person's passkey, a tampered signature or a signature made for something else, replaying or racing an
 * approval, a legacy password session approving anything, guessing passwords and recovery codes, recovering without
 * waiting, weakening a protection without a fresh passkey confirmation, and, in business workspaces, reaching another
 * business or acting above one's role. Each check records what was expected, what was observed, and the ASVS 5.0.0
 * requirement it bears on (docs/standards/sources/OWASP_ASVS_5.0.0_en.flat.json).
 *
 * Account recovery follows the R7 design (NIST SP 800-63B-4 §4.2.2.2): one saved code plus a code issued by a recovery
 * contact (or, for an account made before passkeys, its password), then a delay; any passkey can suspend another at once.
 *
 * Check ids: S01 to S54 continue, in the same order, the 54 checks of the pre-R7 script (password flows), each with its
 * intent kept under passkeys; `was` gives the earlier wording where it changed. N01 onwards are new in R7.
 *
 * The harness writes to its own scratch database in four labelled places, never to anything else: a session's
 * re-authentication time is cleared (instead of waiting five minutes); two legacy password accounts are created with
 * the server's own hashPassword (as accounts from before R7 are); one session is pointed at a workspace its person does
 * not belong to; one membership is ended (there is no route to remove a member yet). Recovery and passkey removal wait
 * DELAY_SEC on this stack (the server's labelled test mode); the product waits 72 hours. Nothing outside the scratch
 * directory is touched. Since R13 no outside service is contacted: the engine runs in presentation mode (synthetic prices,
 * QED_PRESENTATION=1) instead of reading the public market-data feeds, and the port is checked to be free before the
 * stack starts, so the checks can only ever reach the services this script started (QED_SECURITY_PORT; use 10100-10199).
 *
 * R13 hardening (the ASVS 5.0 pass of 24 Nov 2026, docs/SECURITY-REVIEW-R13.md section 9) adds X01 onwards, group
 * 'r13-hardening' (and X03 beside R11): the page's nonce policy in Chrome, files never served, resuming with a passkey
 * session alone (Q-059), grants that wait (Q-048), a new passkey's cool-off (RISK-068, Q-062), the refusal log, a sign-in
 * ending the presented session, and a request refused at its last write changing nothing (brief item 2). Since then, a
 * member given authority waits out the protection delay (DELAY_SEC here) before they are a member, so the harness adds
 * members and then waits for the engine to apply them (addMembers); and a passkey a check adds is past its cool-off only
 * by a labelled harness write (settle: "what 24 hours would leave"), where the check is about something else.
 *
 * R13 (the security review of 24 Nov 2026, docs/SECURITY-REVIEW-R13.md) adds the R13 checks at the end: one for each
 * finding that review confirmed, each seen to fail on the reviewed revision (99dd3e4) before its fix. Its second pass
 * adds R14 (F-14: the wallet service's chain probed from Chrome; it starts a wallet service of its own and needs Anvil
 * and the system's Chrome) and R15 to R26, one for each lead of its section 4 that was confirmed, each seen to fail on
 * the revision before its fix (R16 to R21 and R26 run their scenario in process, against server/rail-fake.ts).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify as verifySignature } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingHttpHeaders, request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { registerAmountSql } from '../server/amount-sql.ts'
import { hashPassword } from '../server/auth.ts'
import { newId } from '../server/core.ts'
import { SoftAuthenticator } from '../server/softauthn.ts'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const out = process.argv[2] ?? 'security.json'
const port = Number(process.env.QED_SECURITY_PORT ?? 5198)
const dir = mkdtempSync(join(tmpdir(), 'qed-security-'))
const dbPath = join(dir, 'qed.db')
const DELAY_SEC = 8
// Only this stack's settings: nothing inherited from the shell may point it at another database, port or relying party.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('QED_')))
const env = { ...inherited, QED_DB: dbPath, QED_API_PORT: String(port), QED_WEB_PORT: String(port), QED_AI_PROVIDER: 'none', QED_PRESENTATION: '1', QED_RECOVERY_DELAY_SEC: String(DELAY_SEC), QED_PROTECTION_DELAY_SEC: String(DELAY_SEC) }
// The review build's ports are never this script's, and a port something already listens on is refused: the checks
// would otherwise sign up people in, and write to, whatever answers there.
if ([5174, 5175, 5176].includes(port)) { console.error(`Port ${port} belongs to the review build; choose another with QED_SECURITY_PORT (10100-10199).`); process.exit(2) }
if (!(await new Promise<boolean>((resolve) => { const s = createNetServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))) }))) {
  console.error(`Port ${port} is in use by another process; nothing was started or sent. Choose a free one with QED_SECURITY_PORT (10100-10199).`)
  process.exit(2)
}
const host = `127.0.0.1:${port}`
/** Passkeys need a domain, so the interface (and so every passkey ceremony) is at localhost. */
const RP_ID = 'localhost'
const origin = `http://${RP_ID}:${port}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest()
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
/** The challenge an approval's signature must cover (server/passkeys.ts approvalChallenge), computed independently here. */
const approvalChallengeOf = (approvalId: string, docHash: string): string => b64u(sha256(`qed/approval/v1\n${approvalId}\n${docHash}`))

const children: ChildProcess[] = []
const serverErrors: string[] = []
/**
 * The API's `refused` lines (server/guard.ts, standard output), its `csp-violation` lines (standard error; X01 makes some on
 * purpose) and its `storage fault` lines (standard error; X08 makes one on purpose), kept apart from the errors S54 counts.
 */
const refusedLines: string[] = [], cspLines: string[] = [], storageLines: string[] = []
function start(cmd: string): ChildProcess {
  const c = spawn(process.execPath, [join(app, 'server', 'main.ts'), cmd], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim() || line.includes('ExperimentalWarning') || line.includes('--trace-warnings')) continue
      if (line.startsWith('[api] csp-violation')) { cspLines.push(line.slice(0, 400)); continue }
      if (line.startsWith('[api] storage fault')) { storageLines.push(line.slice(0, 300)); continue }
      serverErrors.push(line.trim().slice(0, 300))
    }
  })
  c.stdout?.on('data', (d: Buffer) => { for (const line of d.toString().split('\n')) if (line.startsWith('[api] refused')) refusedLines.push(line.slice(0, 300)) })
  children.push(c)
  return c
}

interface Res { status: number; headers: IncomingHttpHeaders; text: string; json: Record<string, any> | null }
interface Opts { cookie?: string; csrf?: string; body?: unknown; rawBody?: string | Buffer; headers?: Record<string, string>; host?: string; noClient?: boolean }
/** One HTTP request with every header under this script's control, including Host. */
function http(method: string, path: string, o: Opts = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = o.rawBody ?? (method === 'GET' ? undefined : JSON.stringify(o.body ?? {}))
    const headers: Record<string, string> = { Host: o.host ?? host, ...(o.cookie ? { Cookie: o.cookie } : {}) }
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (!o.noClient) headers['X-QED-Client'] = 'web'; if (o.csrf !== undefined) headers['X-QED-CSRF'] = o.csrf }
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload))
    Object.assign(headers, o.headers ?? {})
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: Record<string, any> | null = null; try { json = JSON.parse(text) as Record<string, any> } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json }) })
    })
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE') resolve({ status: 0, headers: {}, text: 'connection closed by the server', json: null }); else reject(e) })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}
const cookieOf = (r: Res): string => String(([] as string[]).concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0]!
const code = (r: Res | null | undefined): string => (r ? `${r.status}${r.json?.error?.code ? ` ${String(r.json.error.code)}` : ''}` : 'not sent')
const must = (r: Res, what: string): Record<string, any> => { if (r.status !== 200 || !r.json) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 200)}`); return r.json }

// ---------------------------------------------------------------------------------------------- the scratch database
// Amounts are summed with amount_sum over their text, as the server does (stage S3): the INTEGER copy is NULL past 64 bits.
function rows<T = Record<string, any>>(sql: string, ...p: SQLInputValue[]): T[] { const d = new DatabaseSync(dbPath, { readOnly: true }); registerAmountSql(d); try { return d.prepare(sql).all(...p) as T[] } finally { d.close() } }
const count = (sql: string, ...p: SQLInputValue[]): number => Number(rows<{ n: number }>(sql, ...p)[0]?.n ?? 0)
/** The harness's own writes to its scratch database (see the header); each call site says why. */
function write(sql: string, ...p: SQLInputValue[]): number { const d = new DatabaseSync(dbPath); try { d.exec('PRAGMA busy_timeout = 8000'); return Number(d.prepare(sql).run(...p).changes) } finally { d.close() } }
/** A session whose last re-authentication is no longer recent: what five idle minutes would leave. */
const stale = (p: { userId: string }): number => write('UPDATE sessions SET stepup_at = NULL, stepup_method = NULL WHERE user_id = ?', p.userId)
/** What 24 hours would leave: a passkey this run added, past its cool-off (server/passkeys.ts COOL_OFF_MS), where a check is about something else. */
const settle = (credentialId: string): number => write('UPDATE webauthn_credentials SET cool_off_until = NULL WHERE id = ?', credentialId)

// ---------------------------------------------------------------------------------------------- people and passkeys
const authenticator = (o: { userVerified?: boolean } = {}): SoftAuthenticator => new SoftAuthenticator({ origin, rpId: RP_ID, ...o })
/** The software authenticator answering once without user verification, as a browser does when the person skips the fingerprint. */
function withoutUV<T>(auth: SoftAuthenticator, fn: () => T): T { const o = (auth as unknown as { opts: { userVerified?: boolean } }).opts; const before = o.userVerified; o.userVerified = false; try { return fn() } finally { o.userVerified = before } }

interface Signed { cookie: string; csrf: string; userId: string }
interface Person extends Signed { handle: string; auth: SoftAuthenticator; codes: string[]; signupFinish: unknown }
const as = (p: { cookie: string; csrf: string }, extra: Opts = {}): Opts => ({ cookie: p.cookie, csrf: p.csrf, ...extra })
let signupBegins = 0 // every sign-up begin that reached the handler counts against the per-address limit
const signupCodesAtSignup: number[] = [] // how many saved codes each sign-up's own answer carried (R14, F1: ten, made with the first device)

async function signUp(handle: string, household = true): Promise<Person> {
  const auth = authenticator()
  const b = must(await http('POST', '/api/auth/passkey/signup/begin', { body: { handle, displayName: `Test ${handle}` } }), `sign-up begin for ${handle}`)
  signupBegins++
  const signupFinish = { challengeId: b.challengeId, response: auth.create(b.options) }
  const f = await http('POST', '/api/auth/passkey/signup/finish', { body: signupFinish })
  const j = must(f, `sign-up finish for ${handle}`)
  const p: Person = { handle, auth, cookie: cookieOf(f), csrf: String(j.csrf), userId: String(j.userId), codes: [], signupFinish }
  // R14 (review F1, SECURITY.md 8k): a sign-up with a passkey makes the account's saved codes with its first device, in
  // the same change, and its answer carries them once; these checks are about what the codes do, so they keep that set.
  // (Asking for new ones now would need one of them: H2.)
  signupCodesAtSignup.push(Array.isArray(j.recoveryCodes) ? (j.recoveryCodes as unknown[]).length : 0)
  p.codes = Array.isArray(j.recoveryCodes) && j.recoveryCodes.length ? (j.recoveryCodes as string[]) : must(await http('POST', '/api/security/recovery-codes', as(p, { body: {} })), `saved codes for ${handle}`).codes as string[]
  if (household) must(await http('POST', '/api/household', as(p, { body: {} })), `household for ${handle}`)
  return p
}
async function signIn(auth: SoftAuthenticator): Promise<{ res: Res; cookie: string; csrf: string; body: unknown }> {
  const b = must(await http('POST', '/api/auth/passkey/login/begin', { body: {} }), 'sign-in begin')
  const body = { challengeId: b.challengeId, response: auth.get(b.options) }
  const res = await http('POST', '/api/auth/passkey/login/finish', { body })
  return { res, cookie: cookieOf(res), csrf: String(res.json?.csrf ?? ''), body }
}
/** Re-authenticate inside the session with a passkey (opens the five-minute window for changes that weaken a protection). */
async function stepUp(p: Signed, auth: SoftAuthenticator): Promise<{ res: Res; body: unknown }> {
  const b = must(await http('POST', '/api/auth/passkey/stepup/begin', as(p)), 'step-up begin')
  const body = { challengeId: b.challengeId, response: auth.get(b.options) }
  return { res: await http('POST', '/api/auth/passkey/stepup/finish', as(p, { body })), body }
}
/** Sign one approval's exact terms with a passkey, through the two routes the interface uses. */
async function approve(p: Signed, auth: SoftAuthenticator, approvalId: string, docHash: string): Promise<{ begin: Res; confirm: Res | null; body: unknown }> {
  const begin = await http('POST', `/api/approvals/${approvalId}/passkey`, as(p))
  if (begin.status !== 200) return { begin, confirm: null, body: null }
  const body = { challengeId: begin.json!.challengeId, response: auth.get(begin.json!.options), docHash }
  return { begin, confirm: await http('POST', `/api/approvals/${approvalId}/confirm`, as(p, { body })), body }
}
const beginApproval = async (p: Signed, approvalId: string): Promise<Record<string, any>> => must(await http('POST', `/api/approvals/${approvalId}/passkey`, as(p)), `approval challenge for ${approvalId}`)
const confirmWith = (p: Signed, approvalId: string, body: unknown): Promise<Res> => http('POST', `/api/approvals/${approvalId}/confirm`, as(p, { body }))
const confirmedAt = (approvalId: string): number | null => rows<{ c: number | null }>('SELECT confirmed_at c FROM approvals WHERE id = ?', approvalId)[0]?.c ?? null

/** Alter one part of an authenticator's answer after it was signed. */
function tamper(resp: Record<string, unknown>, part: 'signature' | 'clientData' | 'authData'): Record<string, unknown> {
  const r = JSON.parse(JSON.stringify(resp)) as { response: Record<string, string> }
  if (part === 'signature') { const s = Buffer.from(r.response.signature!, 'base64url'); s[s.length - 1] = s[s.length - 1]! ^ 0x01; r.response.signature = b64u(s) }
  if (part === 'clientData') { const c = JSON.parse(Buffer.from(r.response.clientDataJSON!, 'base64url').toString('utf8')) as Record<string, string>; c.challenge = b64u(randomBytes(32)); r.response.clientDataJSON = b64u(Buffer.from(JSON.stringify(c))) }
  if (part === 'authData') { const a = Buffer.from(r.response.authenticatorData!, 'base64url'); a[a.length - 1] = a[a.length - 1]! ^ 0x01; r.response.authenticatorData = b64u(a) }
  return r as unknown as Record<string, unknown>
}
/** A registration answer with an Ed25519 key (COSE alg -8): well formed, user verified, for the right challenge and origin. */
function ed25519Registration(options: { challenge: string }): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync('ed25519')
  const x = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const id = randomBytes(32)
  const coseKey = new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(x)]])
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
  const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, Buffer.from(isoCBOR.encode(coseKey as never))])
  const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), attested])
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never)
  return { id: b64u(id), rawId: b64u(id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] } }
}

interface Legacy extends Signed { handle: string; password: string }
/** An account from before R7: a password and no passkey, made as the migration leaves it (its own workspace, role owner). */
async function legacyAccount(handle: string): Promise<Legacy> {
  const password = randomBytes(15).toString('base64url')
  const id = newId('usr')
  const now = Date.now()
  write(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, ?, ?, 'person')`, id, handle, `Legacy ${handle}`, await hashPassword(password), now)
  write(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, 'migration-2')`, id, id, now)
  return { handle, password, userId: id, cookie: '', csrf: '' }
}
const passwordSignIn = (handle: string, password: string): Promise<Res> => http('POST', '/api/auth/login', { body: { handle, password } })
const signInPassword = async (l: Legacy): Promise<Legacy> => { const s = await passwordSignIn(l.handle, l.password); l.cookie = cookieOf(s); l.csrf = String(must(s, `password sign-in for ${l.handle}`).csrf); return l }

/** Re-verify a stored approval without the server: its document hash, the challenge its signature covers, the signature. */
function verifyStoredApproval(approvalId: string): { ok: boolean; detail: string } {
  const a = rows<{ document: string; doc_hash: string; method: string; evidence_json: string }>('SELECT document, doc_hash, method, evidence_json FROM approvals WHERE id = ?', approvalId)[0]
  if (!a) return { ok: false, detail: 'no approval row' }
  const ev = JSON.parse(a.evidence_json || '{}') as { credentialId?: string; authenticatorData?: string; clientDataJSON?: string; signature?: string }
  const cred = rows<{ x: string; y: string }>('SELECT x, y FROM webauthn_credentials WHERE id = ?', String(ev.credentialId))[0]
  if (!cred || !ev.authenticatorData || !ev.clientDataJSON || !ev.signature) return { ok: false, detail: `evidence incomplete (method ${a.method})` }
  const client = JSON.parse(Buffer.from(ev.clientDataJSON, 'base64url').toString('utf8')) as { type: string; challenge: string; origin: string }
  const authData = Buffer.from(ev.authenticatorData, 'base64url')
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(cred.x, 'hex').toString('base64url'), y: Buffer.from(cred.y, 'hex').toString('base64url') }, format: 'jwk' })
  const signed = verifySignature('sha256', Buffer.concat([authData, sha256(Buffer.from(ev.clientDataJSON, 'base64url'))]), key, Buffer.from(ev.signature, 'base64url'))
  const parts = { method: a.method === 'passkey', document: sha256hex(a.document) === a.doc_hash, challenge: client.challenge === approvalChallengeOf(approvalId, a.doc_hash), type: client.type === 'webauthn.get', origin: client.origin === origin, rp: authData.subarray(0, 32).equals(sha256(RP_ID)), verified: (authData[32]! & 0x05) === 0x05, signature: signed }
  return { ok: Object.values(parts).every(Boolean), detail: Object.entries(parts).map(([k, v]) => `${k} ${v ? 'ok' : 'WRONG'}`).join(', ') }
}

// ---------------------------------------------------------------------------------------------- checks
interface Check { id: string; area: string; name: string; asvs: string; expected: string; observed: string; pass: boolean; was?: string }
const checks: Check[] = []
/** Timings kept for the record (lead L-14), not checks: a shared computer's timings pass or fail nothing. */
const measurements: { lead: string; what: string; millisecondsMedian: number; samples: number[] }[] = []
function check(id: string, area: string, name: string, asvs: string, expected: string, observed: string, pass: boolean, was?: string): void {
  checks.push({ id, area, name, asvs, expected, observed, pass, ...(was ? { was } : {}) })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} [${area}] ${name}${pass ? '' : `\n        expected: ${expected}\n        observed: ${observed}`}`)
}
/** A group of checks; an exception in one is recorded and the next group still runs. */
/** QED_SECURITY_ONLY=a,b runs only those groups (and 'accounts', which makes the people): for a focused run while developing a check. */
const ONLY = (process.env.QED_SECURITY_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
async function group(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length && name !== 'accounts' && !ONLY.includes(name)) return
  try { await fn() } catch (e) { check('H', 'harness', `the "${name}" checks ran to the end`, '-', 'no exception in the test script', e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}` : String(e), false) }
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0 }
const preview = async (p: Signed, payeeId: string, amount: number): Promise<{ approvalId: string; docHash: string; document: string }> => {
  const j = must(await http('POST', '/api/actions/preview', as(p, { body: { kind: 'payment', purpose: 'spend', payeeId, amount } })), `payment preview of ${amount}`)
  return { approvalId: String(j.approvalId), docHash: String(j.docHash), document: String(j.document) }
}

/**
 * Members given authority wait out the protection delay (Q-048; DELAY_SEC on this stack): ask for each, then wait until the
 * engine has applied every grant (a viewer is added at once). The owner's session must be confirmed and acting in `ws`.
 */
async function addMembers(owner: Signed, ws: string, list: readonly (readonly [Person, string])[]): Promise<void> {
  for (const [p, role] of list) must(await http('POST', '/api/workspace/members', as(owner, { body: { handle: p.handle, role } })), `add ${p.handle}`)
  const ids = list.map(([p]) => p.userId)
  const deadline = Date.now() + (DELAY_SEC + 20) * 1000
  while (count(`SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND person_id IN (${ids.map(() => '?').join(', ')})`, ws, ...ids) < ids.length) {
    if (Date.now() > deadline) throw new Error(`the members of ${ws} were not added within the delay`)
    await sleep(500)
  }
}

// The people. Passkey accounts open their paper household; business members need none of their own.
let victim!: Person, attacker!: Person, careful!: Person, thrifty!: Person, stopper!: Person, spender!: Person, recoverme!: Person, friend!: Person
let boss!: Person, appr!: Person, oper!: Person, view!: Person
let legacy!: Legacy, oldtimer!: Legacy
// Objects shared between groups.
let payeeId = '', programId = '', approvalId = '', docHash = '', billId = '', firstConfirmBody: unknown = null
let goodLoginBody: unknown = null
/** The legacy account's passkey, once it has added one (N15). */
let legacyAuth: SoftAuthenticator | null = null
// the saved codes the legacy account renews in N15 (H2: its later new codes and suspensions need one of them)
let legacySavedCodes: string[] = []
/** recoverme names friend as a recovery contact at the start of the run; it is in effect once the protection delay has passed. */
let contactLink = '', nominatedAt = 0, nominateStale: Res | null = null, nominateOk: Res | null = null, contactAccepted: Res | null = null, issuedEarly: Res | null = null

try {
  console.log(`Scratch database: ${dbPath}; API on ${host}; recovery and passkey removal wait ${DELAY_SEC} s on this stack`)
  start('engine'); start('api')
  for (let i = 0; i < 60; i++) { try { const h = await http('GET', '/api/health'); if (h.status === 200) break } catch { /* not up yet */ } await sleep(500) }

  await group('accounts', async () => {
    victim = await signUp('victim'); attacker = await signUp('attacker')
    careful = await signUp('careful'); thrifty = await signUp('thrifty'); stopper = await signUp('stopper'); spender = await signUp('spender')
    recoverme = await signUp('recoverme', false); friend = await signUp('friend', false)
    boss = await signUp('boss', false); appr = await signUp('appr', false); oper = await signUp('oper', false); view = await signUp('view', false)
    legacy = await legacyAccount('legacy'); oldtimer = await legacyAccount('oldtimer')
  })

  // Named now, so that the protection delay has passed by the time the recovery checks need the contact (N44).
  await group('recovery contact', async () => {
    stale(recoverme)
    nominateStale = await http('POST', '/api/security/contacts', as(recoverme, { body: { handle: friend.handle } }))
    await stepUp(recoverme, recoverme.auth)
    nominatedAt = Date.now()
    nominateOk = await http('POST', '/api/security/contacts', as(recoverme, { body: { handle: friend.handle } }))
    contactLink = String(nominateOk.json?.linkId ?? '')
    contactAccepted = await http('POST', `/api/security/contacts/${contactLink}/accept`, as(friend))
    issuedEarly = await http('POST', `/api/security/contacts/${contactLink}/code`, as(friend))
  })

  // ------------------------------------------------------------------ reading and changing without a session
  await group('session', async () => {
    const reads = ['/api/stop/preview', '/api/home', '/api/passbook', '/api/system', '/api/needs-you', '/api/ledger', '/api/accounts', '/api/receipts', '/api/activity', '/api/programs', '/api/payees', '/api/bills', '/api/earn', '/api/proposals', '/api/engine', '/api/events', '/api/security', '/api/workspaces', '/api/workspace', '/api/approvals/open', '/api/vault']
    const open = (await Promise.all(reads.map(async (p) => [p, (await http('GET', p)).status] as const))).filter(([, s]) => s !== 401)
    check('S01', 'session', 'every owner route refuses a request with no session', 'V8.2.1 function-level access', `401 from all ${reads.length} read routes`, open.length ? `answered without a session: ${open.map(([p, s]) => `${p}=${s}`).join(', ')}` : `401 from all ${reads.length}`, open.length === 0)
    const writes = ['/api/security/sessions/end-others', '/api/stop', '/api/actions', '/api/actions/preview', '/api/programs', '/api/payees', '/api/bills', '/api/money-in', '/api/household', '/api/ask', '/api/auth/stepup', '/api/auth/logout-everywhere',
      '/api/auth/passkey/stepup/begin', '/api/auth/passkey/stepup/finish', '/api/security/passkeys/begin', '/api/security/passkeys/finish', '/api/security/recovery-codes', '/api/workspaces', '/api/workspace/members', '/api/workspace/policy', '/api/approvals/apr_x/passkey', '/api/approvals/apr_x/confirm']
    const wopen = (await Promise.all(writes.map(async (p) => [p, (await http('POST', p, { body: {}, csrf: 'x' })).status] as const))).filter(([, s]) => s !== 401)
    check('S02', 'session', 'every state-changing route refuses a request with no session, the passkey ceremony and workspace routes included', 'V8.2.1 function-level access', `401 from all ${writes.length} write routes`, wopen.length ? wopen.map(([p, s]) => `${p}=${s}`).join(', ') : `401 from all ${writes.length}`, wopen.length === 0)
    const session = await http('GET', '/api/session')
    check('S03', 'session', 'the public session route gives nothing about any owner when signed out', 'V14.2.6 minimum sensitive data', 'authenticated false and no user, csrf, sessions or workspaces', JSON.stringify(Object.keys(session.json ?? {})), session.json?.authenticated === false && !session.json?.user && !session.json?.csrf && !session.json?.sessions && !session.json?.workspaces)
  })

  // ------------------------------------------------------------------ CSRF, cross-site, rebinding
  await group('csrf', async () => {
    let r = await http('POST', '/api/stop', { cookie: victim.cookie, body: {} })
    check('S04', 'csrf', 'a state change with the cookie but no CSRF token is refused', 'V3.5.1 cross-site request forgery', '403 csrf', code(r), r.status === 403 && r.json?.error?.code === 'csrf')
    r = await http('POST', '/api/stop', { cookie: victim.cookie, csrf: attacker.csrf, body: {} })
    check('S05', 'csrf', 'another owner\'s CSRF token does not work with this owner\'s cookie', 'V3.5.1 cross-site request forgery', '403 csrf', code(r), r.status === 403)
    r = await http('POST', '/api/stop', as(victim, { headers: { Origin: 'https://evil.example' } }))
    check('S06', 'csrf', 'a request carrying a foreign Origin is refused even with a valid cookie and token', 'V3.5.1 cross-site request forgery', '403 cross_site', code(r), r.status === 403 && r.json?.error?.code === 'cross_site')
    r = await http('GET', '/api/home', { cookie: victim.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })
    check('S07', 'csrf', 'a cross-site read is refused (Sec-Fetch-Site)', 'V3.5.8 Sec-Fetch validation', '403 cross_site', code(r), r.status === 403)
    r = await http('GET', '/api/home', { cookie: victim.cookie, host: 'attacker.example:5175' })
    check('S08', 'csrf', 'a request for any other Host is refused (DNS rebinding)', 'V3.5.1 (Host allowlist against DNS rebinding)', '421 wrong_host', code(r), r.status === 421)
    const ceremonies: [string, unknown][] = [['/api/auth/pause-with-code', { handle: 'formpost', code: 'x' }], ['/api/auth/passkey/signup/begin', { handle: 'formpost', displayName: 'x' }], ['/api/auth/passkey/login/begin', {}], ['/api/auth/passkey/login/finish', {}], ['/api/auth/recovery/start', { handle: 'victim', code: 'AAAA-AAAA-AAAA-AAAA' }], ['/api/auth/recovery/passkey/begin', { requestId: 'rec_x' }], ['/api/auth/login', { handle: 'victim', password: 'x'.repeat(12) }]]
    const plain = await Promise.all(ceremonies.map(async ([p, body]) => [p, await http('POST', p, { body, noClient: true })] as const))
    check('S09', 'csrf', 'sign-up, sign-in, recovery and legacy password sign-in without the interface\'s own header are refused (plain form post)', 'V3.5.1 cross-site request forgery', `403 csrf from all ${ceremonies.length} routes that work without a session`, plain.map(([p, x]) => `${p.replace('/api/auth/', '')} ${code(x)}`).join('; '), plain.every(([, x]) => x.status === 403 && x.json?.error?.code === 'csrf'), 'sign-in without the interface\'s own header is refused (plain form post)')
    const stopped = count('SELECT COUNT(*) n FROM users WHERE stop_at IS NOT NULL'), recoveries = count('SELECT COUNT(*) n FROM recovery_requests'), formpost = count(`SELECT COUNT(*) n FROM webauthn_challenges WHERE context_json LIKE '%formpost%'`)
    check('S10', 'csrf', 'none of the refused requests changed anything', 'V3.5.1 cross-site request forgery', 'no owner stopped; no recovery started; no sign-up begun for the form post', `${stopped} stopped; ${recoveries} recoveries; ${formpost} sign-up challenges for it`, stopped === 0 && recoveries === 0 && formpost === 0)
  })

  // ------------------------------------------------------------------ cookie and headers
  await group('cookie', async () => {
    const si = await signIn(victim.auth)
    const sc = String(([] as string[]).concat(si.res.headers['set-cookie'] ?? [])[0] ?? '')
    check('S11', 'session', 'the session cookie a passkey sign-in sets is HttpOnly, SameSite=Strict and scoped to the site', 'V3.3.4 HttpOnly; V3.3.2 SameSite', 'HttpOnly; SameSite=Strict; Path=/', `${code(si.res)}; ${sc.replace(/qed_session=[^;]+/, 'qed_session=…')}`, si.res.status === 200 && /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Path=\//.test(sc), 'the session cookie is HttpOnly, SameSite=Strict and scoped to the site')
    const token = sc.split(';')[0]!.split('=')[1] ?? '\u0000'
    const inBody = JSON.stringify(si.res.json ?? {}).includes(token)
    check('S12', 'session', 'the session token is never returned in a response body', 'V3.3.4 token only in Set-Cookie', 'token only in the cookie', inBody ? 'token found in the body' : 'not in the body', !inBody && token.length > 20)
    const raw = count('SELECT COUNT(*) n FROM sessions WHERE id_hash = ?', token), hashed = count('SELECT COUNT(*) n FROM sessions WHERE id_hash = ?', sha256hex(token))
    check('S13', 'session', 'the database stores only a hash of the session token', 'V7.2.1 tokens verified at the backend (stored only as SHA-256)', 'no row keyed by the raw token; one keyed by its SHA-256', `${raw} rows keyed by the raw token; ${hashed} by its hash`, raw === 0 && hashed === 1)
    const hd = (await http('GET', '/api/health')).headers
    const csp = String(hd['content-security-policy'] ?? '')
    check('S14', 'headers', 'every response carries a restrictive Content-Security-Policy: an API answer lets nothing load or run (the page\'s own policy is X01)', 'V3.4.3 CSP; V3.4.6 frame-ancestors', "default-src 'none', base-uri 'none', frame-ancestors 'none'", csp.slice(0, 160), /^default-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe-inline/.test(csp), "default-src 'self', no unsafe-inline scripts, frame-ancestors 'none' (before R13 hardening, one policy for every response)")
    check('S15', 'headers', 'nosniff, no framing, no referrer, no caching of API replies', 'V3.4.4 nosniff; V3.4.5 referrer; V14.3.2 no-store', 'nosniff; DENY; no-referrer; no-store', `${hd['x-content-type-options']}; ${hd['x-frame-options']}; ${hd['referrer-policy']}; ${hd['cache-control']}`, hd['x-content-type-options'] === 'nosniff' && hd['x-frame-options'] === 'DENY' && hd['referrer-policy'] === 'no-referrer' && hd['cache-control'] === 'no-store')
  })

  // ------------------------------------------------------------------ creating an account
  await group('sign-up', async () => {
    const attempts: [string, Res][] = []
    const begin = async (handle: string): Promise<Record<string, any>> => { const b = must(await http('POST', '/api/auth/passkey/signup/begin', { body: { handle, displayName: handle } }), `sign-up begin ${handle}`); signupBegins++; return b }
    const finish = (b: Record<string, any>, response: unknown): Promise<Res> => http('POST', '/api/auth/passkey/signup/finish', { body: { challengeId: b.challengeId, response } })
    { const b = await begin('nochallenge'); attempts.push(['an answer to a different challenge', await finish(b, authenticator().create({ ...b.options, challenge: b64u(randomBytes(32)) }))]) }
    { const b = await begin('wrongorigin'); attempts.push(['made on another site (https://evil.example)', await finish(b, authenticator().create(b.options, { origin: 'https://evil.example' }))]) }
    { const b = await begin('wrongrp'); attempts.push(['scoped to another relying party (evil.example)', await finish(b, authenticator().create({ ...b.options, rp: { id: 'evil.example' } }))]) }
    { const b = await begin('nouv'); attempts.push(['without user verification', await finish(b, authenticator({ userVerified: false }).create(b.options))]) }
    { const b = await begin('edkey'); attempts.push(['an Ed25519 key, not ES256', await finish(b, ed25519Registration(b.options))]) }
    const created = count(`SELECT COUNT(*) n FROM users WHERE handle IN ('nochallenge', 'wrongorigin', 'wrongrp', 'nouv', 'edkey')`)
    const cookies = attempts.filter(([, r]) => r.headers['set-cookie']).length
    check('S39', 'account', 'an account cannot be created without a verified passkey: a wrong challenge, a wrong origin, a wrong relying party, no user verification and a non-ES256 key are all refused', 'V6.3.3 phishing-resistant authenticator; V6.7.2 challenge; V11.6.1 approved algorithm', 'all five refused; no account and no session created', `${attempts.map(([n, r]) => `${n}: ${code(r)}`).join('; ')}; accounts created ${created}; cookies set ${cookies}`, attempts.every(([, r]) => r.status === 401 || r.status === 400) && created === 0 && cookies === 0, 'short, common and handle-derived passwords are refused at registration')

    const u = rows<{ pw_hash: string; kind: string }>('SELECT pw_hash, kind FROM users WHERE id = ?', victim.userId)[0]
    const creds = rows<{ id: string; x: string; y: string }>('SELECT id, x, y FROM webauthn_credentials WHERE person_id = ? AND removed_at IS NULL', victim.userId)
    const s = await http('GET', '/api/session', { cookie: victim.cookie })
    const sameKey = creds.length === 1 && creds[0]!.id === victim.auth.id && creds[0]!.x === victim.auth.x.toString('hex') && creds[0]!.y === victim.auth.y.toString('hex')
    check('N01', 'account', 'a new account has no password: it holds one ES256 passkey (with its P-256 coordinates on record) and its session was opened by that passkey', 'V6.3.3 phishing-resistant authenticator', 'password hash "!"; one credential equal to the authenticator\'s key; session method passkey', `password hash ${u?.pw_hash === '!' ? '"!" (none)' : 'present'}; ${creds.length} credential(s), ${sameKey ? 'the authenticator\'s own key' : 'not the authenticator\'s key'}; session ${String(s.json?.authMethod)}, hasPasskey ${String(s.json?.hasPasskey)}`, u?.pw_hash === '!' && u.kind === 'person' && sameKey && s.json?.authMethod === 'passkey' && s.json?.hasPasskey === true)

    const form = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/
    const stored = rows<Record<string, unknown>>('SELECT * FROM recovery_codes WHERE person_id = ?', victim.userId)
    const flat = JSON.stringify(stored)
    const inClear = victim.codes.filter((c) => flat.includes(c) || flat.includes(c.replace(/-/g, ''))).length
    // How the codes are stored, read from the rows (schema v3 has an algo column; before it, salted SHA-256 only). V6.5.2 asks
    // for a password-hashing algorithm with a random salt of at least 32 bits when a code has under 112 bits (these have 80).
    const algo = (r: Record<string, unknown>): string => String(r.algo ?? (/^[0-9a-f]{64}$/.test(String(r.code_hash)) ? 'sha256' : 'unknown'))
    const storedAs = stored.length && stored.every((r) => algo(r) === 'scrypt') ? 'scrypt (V6.5.2 met)' : stored.every((r) => algo(r) === 'sha256') ? 'salted SHA-256 (V6.5.2 not met: a code of under 112 bits needs a password-hashing algorithm)' : `mixed or unrecognised (${[...new Set(stored.map(algo))].join(', ')})`
    const saltBits = Math.min(...stored.map((r) => Buffer.from(String(r.salt ?? ''), 'hex').length * 8))
    const salts = new Set(stored.map((r) => String(r.salt ?? '')))
    check('N02', 'account', 'recovery codes: the sign-up with a passkey makes them with its first device and returns them once (R14, F1); they are ten, each 16 symbols of a 32-symbol alphabet (80 bits), all different, salted, and none stored in clear', 'V6.5.4 entropy; V6.5.3 random generation; V6.5.2 (see observed)', 'ten codes in each passkey sign-up\'s answer; ten distinct codes of the form; ten stored rows, each with a salt of at least 32 bits; no code in any stored row', `sign-up answers carried ${signupCodesAtSignup.reduce((a, b) => a + b, 0)} codes; `+`${victim.codes.length} codes, ${victim.codes.filter((c) => form.test(c)).length} of the form, ${new Set(victim.codes).size} distinct; ${stored.length} rows, salts of at least ${saltBits} bits (${salts.size} distinct: ${salts.size === 1 ? 'one per batch' : 'one per code'}); ${inClear} found in clear; stored as ${storedAs}`, victim.codes.length === 10 && victim.codes.every((c) => form.test(c)) && new Set(victim.codes).size === 10 && stored.length === 10 && saltBits >= 32 && inClear === 0 && signupCodesAtSignup.every((n) => n === 10))

    let accepted = signupBegins, limited: Res | null = null
    for (let i = 0; i < 25 && !limited; i++) { const x = await http('POST', '/api/auth/passkey/signup/begin', { body: { handle: `limit-${i}`, displayName: 'x' } }); if (x.status === 200) accepted++; else limited = x }
    check('N03', 'limits', 'account creation from one address is limited: the 21st sign-up in an hour is refused', 'V2.4.1 anti-automation', '20 sign-ups begun, then 429 too_many', `${accepted} begun, then ${code(limited)}`, accepted === 20 && limited?.status === 429 && limited.json?.error?.code === 'too_many')
  })

  // ------------------------------------------------------------------ signing in with a passkey
  await group('sign-in', async () => {
    const begin = async (): Promise<Record<string, any>> => must(await http('POST', '/api/auth/passkey/login/begin', { body: {} }), 'sign-in begin')
    const finish = (b: Record<string, any>, response: unknown): Promise<Res> => http('POST', '/api/auth/passkey/login/finish', { body: { challengeId: b.challengeId, response } })
    const tries: [string, Res][] = []
    { const b = await begin(); tries.push(['without user verification', await finish(b, withoutUV(victim.auth, () => victim.auth.get(b.options)))]) }
    { const b = await begin(); tries.push(['made on another site', await finish(b, victim.auth.get(b.options, { origin: 'https://evil.example' }))]) }
    { const b = await begin(); tries.push(['for another relying party', await finish(b, victim.auth.get({ ...b.options, rpId: 'evil.example' }))]) }
    { const b = await begin(); tries.push(['typed as a registration', await finish(b, victim.auth.get(b.options, { type: 'webauthn.create' }))]) }
    const b = await begin(); goodLoginBody = { challengeId: b.challengeId, response: victim.auth.get(b.options) }
    const good = await http('POST', '/api/auth/passkey/login/finish', { body: goodLoginBody })
    check('N04', 'account', 'a passkey sign-in needs user verification, this site\'s origin and relying party, and an assertion (not a registration); the same passkey answering properly signs in', 'V6.3.3 phishing-resistant authenticator', 'four refusals with no cookie; then 200', `${tries.map(([n, r]) => `${n}: ${code(r)}${r.headers['set-cookie'] ? ' (cookie set!)' : ''}`).join('; ')}; proper answer ${code(good)}`, tries.every(([, r]) => r.status === 401 && !r.headers['set-cookie']) && good.status === 200)
    const b1 = await begin(); const unknown = await finish(b1, authenticator().get(b1.options))
    const b2 = await begin(); const badSig = await finish(b2, tamper(victim.auth.get(b2.options), 'signature'))
    check('N05', 'account', 'a passkey this site has never seen and a known passkey with a wrong signature get the same answer', 'V6.3.8 no enumeration', 'same status, code and message', `unknown: ${code(unknown)} "${String(unknown.json?.error?.message)}"; wrong signature: ${code(badSig)} "${String(badSig.json?.error?.message)}"`, unknown.status === 401 && unknown.status === badSig.status && unknown.json?.error?.code === badSig.json?.error?.code && unknown.json?.error?.message === badSig.json?.error?.message)
  })

  // ------------------------------------------------------------------ one owner against another's objects
  await group('access', async () => {
    const payee = must(await http('POST', '/api/payees', as(victim, { body: { name: 'Landlord', handle: 'landlord@upi', category: 'housing', nameCheckAccepted: 'unknown' } })), 'payee')
    payeeId = String(payee.id)
    billId = String(must(await http('POST', '/api/bills', as(victim, { body: { payeeId, amount: 250_000, dueAt: Date.now() + 5 * 86_400_000, memo: 'rent' } })), 'bill').id)
    programId = String(must(await http('POST', '/api/programs', as(victim, { body: { kind: 'floor', params: { buffer: 0 } } })), 'floor draft').programId)
    const pv = await preview(victim, payeeId, 50_000)
    approvalId = pv.approvalId; docHash = pv.docHash
    const own = must(await http('POST', '/api/auth/passkey/stepup/begin', as(attacker)), 'attacker step-up begin')
    const cross: [string, Res][] = [
      ['read the instruction', await http('GET', `/api/programs/${programId}`, as(attacker))],
      ['read the approval', await http('GET', `/api/approvals/${approvalId}`, as(attacker))],
      ['ask for the approval\'s passkey challenge', await http('POST', `/api/approvals/${approvalId}/passkey`, as(attacker))],
      ['confirm the approval with the attacker\'s own passkey', await http('POST', `/api/approvals/${approvalId}/confirm`, as(attacker, { body: { challengeId: own.challengeId, response: attacker.auth.get(own.options), docHash } }))],
      ['cancel the approval', await http('POST', `/api/approvals/${approvalId}/cancel`, as(attacker))],
      ['use the approval', await http('POST', '/api/actions', as(attacker, { body: { approvalId } }))],
      ['request signing of the instruction', await http('POST', `/api/programs/${programId}/approval`, as(attacker))],
      ['revoke the instruction', await http('POST', `/api/programs/${programId}/revoke`, as(attacker))],
      ['discard the draft', await http('POST', `/api/programs/${programId}/discard-draft`, as(attacker))],
      ['remove the bill', await http('POST', `/api/bills/${billId}/cancel`, as(attacker))],
      ['pay with the victim\'s payee', await http('POST', '/api/actions/preview', as(attacker, { body: { kind: 'payment', purpose: 'spend', payeeId, amount: 50_000 } }))],
    ]
    const leaked = cross.filter(([, x]) => x.status === 200)
    check('S16', 'access', 'an owner cannot read, sign, confirm, use or change another owner\'s instruction, approval, bill or payee', 'V8.2.2 object-level access (IDOR)', `no 200 among ${cross.length} attempts`, cross.map(([n, x]) => `${n}: ${code(x)}`).join('; '), leaked.length === 0, 'an owner cannot read, confirm, use or change another owner\'s instruction, approval, bill or payee')
    const intact = count('SELECT COUNT(*) n FROM approvals WHERE id = ? AND cancelled_at IS NULL AND confirmed_at IS NULL', approvalId) === 1 && count(`SELECT COUNT(*) n FROM bills WHERE id = ? AND state = 'due'`, billId) === 1 && count('SELECT COUNT(*) n FROM programs WHERE id = ?', programId) === 1 && count('SELECT COUNT(*) n FROM approval_signatures WHERE approval_id = ?', approvalId) === 0
    check('S17', 'access', 'after those attempts the victim\'s approval, bill and draft are unchanged', 'V8.2.2 object-level access (IDOR)', 'approval open with no signature, bill due, draft present', intact ? 'all unchanged' : 'something changed', intact)
    const first = await approve(victim, victim.auth, approvalId, docHash)
    firstConfirmBody = first.body
    const act = await http('POST', '/api/actions', as(victim, { body: { approvalId } }))
    const actionId = String(act.json?.id ?? '')
    const others: [string, Res][] = [['read the action', await http('GET', `/api/actions/${actionId}`, as(attacker))], ['cancel the action', await http('POST', `/api/actions/${actionId}/cancel`, as(attacker))], ['dispute the payment', await http('POST', `/api/actions/${actionId}/dispute`, as(attacker, { body: { reason: 'not mine at all' } }))]]
    check('S18', 'access', 'an owner cannot read, cancel or dispute another owner\'s payment', 'V8.2.2 object-level access (IDOR)', 'the victim\'s passkey approves and sends it; no 200 among 3 attempts by the attacker', `${code(first.confirm)} passkey approval by the victim, ${code(act)} sent; ${others.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}`, first.confirm?.status === 200 && act.status === 200 && others.every(([, x]) => x.status !== 200))
    await sleep(4000)
    const rc = await http('GET', '/api/receipts?limit=5', as(victim))
    const receiptId = String(rc.json?.receipts?.[0]?.id ?? 'rcp_none')
    const r = await http('GET', `/api/receipts/${receiptId}`, as(attacker))
    check('S19', 'access', 'an owner cannot read another owner\'s receipt', 'V8.2.2 object-level access (IDOR)', '404', `${code(r)} for ${receiptId === 'rcp_none' ? 'a missing receipt (the payment had not finished)' : 'a real receipt'}`, r.status === 404 && receiptId !== 'rcp_none')
    const views = await Promise.all(['/api/ledger?limit=200', '/api/activity', '/api/receipts', '/api/payees', '/api/bills', '/api/programs'].map((p) => http('GET', p, as(attacker))))
    const seen = views.filter((v) => [`Landlord`, payeeId, programId, approvalId, billId].some((s) => v.text.includes(s))).length
    check('S20', 'access', 'the attacker\'s ledger, activity, receipts, payees, bills and instructions contain nothing of the victim\'s', 'V8.4.1 cross-tenant isolation', 'no victim name or id in 6 views', seen ? `${seen} views show victim data` : `none of ${views.length} views (${[...new Set(views.map((v) => v.status))].join(',')})`, seen === 0 && views.every((v) => v.status === 200), 'the attacker\'s ledger, activity and receipts contain nothing of the victim\'s')
  })

  // ------------------------------------------------------------------ approvals: binding, replay, races, tampering
  await group('approval', async () => {
    let r = await http('POST', '/api/actions', as(victim, { body: { approvalId } }))
    const dup = count('SELECT COUNT(*) n FROM actions WHERE approval_id = ?', approvalId)
    check('S21', 'approval', 'a used approval cannot be used again', 'V2.3.4 single use (no double booking)', 'refused, and still one action', `${code(r)}; ${dup} action(s) for that approval`, r.status !== 200 && dup === 1)

    const pv2 = await preview(victim, payeeId, 70_000)
    { const b = await beginApproval(victim, pv2.approvalId); r = await confirmWith(victim, pv2.approvalId, { challengeId: b.challengeId, response: victim.auth.get(b.options), docHash: 'f'.repeat(64) }) }
    check('S22', 'approval', 'a valid passkey signature with a different document fingerprint echoed is refused', 'V4.1.5 signature bound to the exact terms', '409 approval_mismatch; the approval stays unconfirmed', `${code(r)}; confirmed ${confirmedAt(pv2.approvalId) ? 'yes' : 'no'}`, r.status === 409 && r.json?.error?.code === 'approval_mismatch' && confirmedAt(pv2.approvalId) === null, 'confirming with a different document fingerprint is refused')
    r = await http('POST', '/api/actions', as(victim, { body: { approvalId: pv2.approvalId } }))
    check('S23', 'approval', 'an approval that was never confirmed cannot be used', 'V2.3.1 steps in order', 'refused', code(r), r.status !== 200)
    must((await approve(victim, victim.auth, pv2.approvalId, pv2.docHash)).confirm ?? { status: 0, headers: {}, text: 'not sent', json: null }, 'approval of pv2')
    const race = await Promise.all(Array.from({ length: 25 }, () => http('POST', '/api/actions', as(victim, { body: { approvalId: pv2.approvalId, amount: 99_999_999, payeeId: 'pye_other' } }))))
    const made = count('SELECT COUNT(*) n FROM actions WHERE approval_id = ?', pv2.approvalId)
    const amountSent = String((JSON.parse(rows<{ params_json: string }>('SELECT params_json FROM actions WHERE approval_id = ?', pv2.approvalId)[0]?.params_json ?? '{}') as { amount?: string }).amount)
    check('S24', 'approval', '25 simultaneous uses of one approval create exactly one payment', 'V15.4.2 atomic check-and-use; V2.3.4', 'one action', `${made} action(s); ${race.filter((x) => x.status === 200).length} of 25 requests answered 200 (all returning the same action)`, made === 1)
    check('S25', 'approval', 'what runs is built from the approved document: parameters sent with the request are ignored', 'V15.3.3 mass assignment', 'amount 70000 paise, as approved', `amount ${amountSent} paise`, amountSent === '70000')

    const d2 = String(must(await http('POST', '/api/programs', as(victim, { body: { kind: 'floor', params: { buffer: 0 } } })), 'second draft').programId)
    const ap2 = must(await http('POST', `/api/programs/${d2}/approval`, as(victim, { body: {} })), 'approval request for the second draft')
    r = await http('POST', `/api/programs/${programId}/activate`, as(victim, { body: { approvalId: ap2.approvalId } }))
    check('S26', 'approval', 'an approval for one instruction cannot put another in force', 'V4.1.5 signature bound to one subject', 'refused', code(r), r.status !== 200)
    const signed2 = await approve(victim, victim.auth, String(ap2.approvalId), String(ap2.docHash))
    await http('POST', `/api/programs/${d2}/draft`, as(victim, { body: { params: { buffer: 5_000_000 } } }))
    r = await http('POST', `/api/programs/${d2}/activate`, as(victim, { body: { approvalId: ap2.approvalId } }))
    const live = count(`SELECT COUNT(*) n FROM programs WHERE id = ? AND state = 'active'`, d2)
    check('S27', 'approval', 'a draft changed after it was signed with a passkey cannot be put in force with that signature', 'V4.1.5 signature bound to the exact terms', 'signed 200; then refused, instruction not in force', `signed ${code(signed2.confirm)}; activation ${code(r)}; in force: ${live}`, signed2.confirm?.status === 200 && r.status !== 200 && live === 0, 'a draft changed after it was signed cannot be put in force with the old signature')

    // The passkey signature itself: what it covers, whose it must be, and that it cannot be altered or reused.
    const pv3 = await preview(victim, payeeId, 30_000), pv4 = await preview(victim, payeeId, 40_000)
    const b3 = await beginApproval(victim, pv3.approvalId)
    check('N06', 'approval', 'the challenge an approval\'s passkey signs is derived from the approval\'s id and the hash of its exact document', 'V4.1.5 per-message signature', 'challenge = SHA-256("qed/approval/v1\\n" + id + "\\n" + docHash); docHash = SHA-256(document)', `challenge ${b3.options?.challenge === approvalChallengeOf(pv3.approvalId, pv3.docHash) ? 'equals' : 'differs from'} the independent computation; document hash ${sha256hex(pv3.document) === pv3.docHash ? 'matches' : 'does not match'}`, b3.options?.challenge === approvalChallengeOf(pv3.approvalId, pv3.docHash) && sha256hex(pv3.document) === pv3.docHash)
    r = await confirmWith(victim, pv3.approvalId, { challengeId: b3.challengeId, response: attacker.auth.get(b3.options), docHash: pv3.docHash })
    check('N07', 'approval', 'an approval signed with another person\'s passkey is refused, even over the right challenge', 'V4.1.5 per-message signature', '401 passkey_failed; the approval stays unconfirmed', `${code(r)}; confirmed ${confirmedAt(pv3.approvalId) ? 'yes' : 'no'}`, r.status === 401 && r.json?.error?.code === 'passkey_failed' && confirmedAt(pv3.approvalId) === null)
    const altered: [string, Res][] = []
    for (const part of ['signature', 'clientData', 'authData'] as const) { const b = await beginApproval(victim, pv3.approvalId); altered.push([part, await confirmWith(victim, pv3.approvalId, { challengeId: b.challengeId, response: tamper(victim.auth.get(b.options), part), docHash: pv3.docHash })]) }
    check('N08', 'approval', 'a passkey signature altered after signing is refused: one bit of the signature, the client data\'s challenge, or the authenticator data', 'V4.1.5 per-message signature', 'all three 401; the approval stays unconfirmed', `${altered.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}; confirmed ${confirmedAt(pv3.approvalId) ? 'yes' : 'no'}`, altered.every(([, x]) => x.status === 401) && confirmedAt(pv3.approvalId) === null)
    const bx = await beginApproval(victim, pv3.approvalId)
    const moved = await confirmWith(victim, pv4.approvalId, { challengeId: bx.challengeId, response: victim.auth.get(bx.options), docHash: pv4.docHash })
    const by = await beginApproval(victim, pv4.approvalId)
    const swapped = await confirmWith(victim, pv4.approvalId, { challengeId: by.challengeId, response: victim.auth.get(bx.options), docHash: pv4.docHash })
    check('N09', 'approval', 'a valid signature made for one approval cannot confirm another: neither with its own challenge nor under the other\'s', 'V4.1.5 per-message signature', '409 approval_mismatch, then 401; both approvals unconfirmed', `signature for A sent to B: ${code(moved)}; A's signature under B's challenge: ${code(swapped)}; confirmed A ${confirmedAt(pv3.approvalId) ? 'yes' : 'no'}, B ${confirmedAt(pv4.approvalId) ? 'yes' : 'no'}`, moved.status === 409 && moved.json?.error?.code === 'approval_mismatch' && swapped.status === 401 && confirmedAt(pv3.approvalId) === null && confirmedAt(pv4.approvalId) === null)
    const bare = await confirmWith(victim, pv4.approvalId, { docHash: pv4.docHash })
    const withPw = await confirmWith(victim, pv4.approvalId, { docHash: pv4.docHash, password: 'not-a-signature-1' })
    check('N10', 'approval', 'a confirmation with no passkey signature is refused, with or without a password in the body', 'V7.5.3 further authentication; V4.1.5', '401 passkey_required twice; unconfirmed', `${code(bare)}; ${code(withPw)}; confirmed ${confirmedAt(pv4.approvalId) ? 'yes' : 'no'}`, bare.status === 401 && bare.json?.error?.code === 'passkey_required' && withPw.status === 401 && confirmedAt(pv4.approvalId) === null)
    const v = verifyStoredApproval(approvalId)
    check('N11', 'approval', 'the stored record of an approval carries a signature anyone can re-verify: by this script, from the database alone, with the passkey\'s public key', 'V4.1.5 per-message signature', 'method passkey; document hash, challenge, origin, relying party, user verification and ES256 signature all check out', v.detail, v.ok)

    const replays: [string, Res][] = [
      ['a sign-up answer', await http('POST', '/api/auth/passkey/signup/finish', { body: victim.signupFinish })],
      ['a sign-in answer', await http('POST', '/api/auth/passkey/login/finish', { body: goodLoginBody })],
    ]
    const su = await stepUp(victim, victim.auth)
    replays.push(['a step-up answer', await http('POST', '/api/auth/passkey/stepup/finish', as(victim, { body: su.body }))])
    replays.push(['an approval signature', await confirmWith(victim, approvalId, firstConfirmBody)])
    check('N12', 'approval', 'every passkey answer works once: replaying a sign-up, a sign-in, a step-up or an approval signature is refused', 'V6.7.2 challenge unique and single use', 'the first step-up 200; all four replays 401', `step-up ${code(su.res)}; ${replays.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}`, su.res.status === 200 && replays.every(([, x]) => x.status === 401))
    const purposes: [string, Res][] = []
    { const b = must(await http('POST', '/api/auth/passkey/login/begin', { body: {} }), 'sign-in begin'); purposes.push(['a sign-in challenge used to step up', await http('POST', '/api/auth/passkey/stepup/finish', as(victim, { body: { challengeId: b.challengeId, response: victim.auth.get(b.options) } }))]) }
    { const b = must(await http('POST', '/api/auth/passkey/stepup/begin', as(victim)), 'step-up begin'); purposes.push(['a step-up challenge used to approve', await confirmWith(victim, pv4.approvalId, { challengeId: b.challengeId, response: victim.auth.get(b.options), docHash: pv4.docHash })]) }
    { const b = await beginApproval(victim, pv4.approvalId); purposes.push(['an approval challenge used to step up', await http('POST', '/api/auth/passkey/stepup/finish', as(victim, { body: { challengeId: b.challengeId, response: victim.auth.get(b.options) } }))]) }
    { const b = await beginApproval(victim, pv4.approvalId); purposes.push(['an approval challenge used to sign in', await http('POST', '/api/auth/passkey/login/finish', { body: { challengeId: b.challengeId, response: victim.auth.get(b.options) } })]) }
    check('N13', 'approval', 'a challenge issued for one purpose cannot be used for another (sign-in, step-up, approval)', 'V6.7.2 challenge bound to its request', 'all four 401; the approval stays unconfirmed', `${purposes.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}; confirmed ${confirmedAt(pv4.approvalId) ? 'yes' : 'no'}`, purposes.every(([, x]) => x.status === 401) && confirmedAt(pv4.approvalId) === null)
  })

  // ------------------------------------------------------------------ input handling
  await group('input', async () => {
    let r = await http('POST', '/api/payees', as(victim, { rawBody: Buffer.alloc(70_000, 0x61) }))
    check('S29', 'input', 'a body over 64 KB is refused', 'V5.2.1 size limit (request body)', '413, or the connection closed', code(r) === '0' ? 'connection closed' : code(r), r.status === 413 || r.status === 0)
    r = await http('POST', '/api/payees', as(victim, { rawBody: 'name=x&handle=y', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }))
    check('S30', 'input', 'a form-encoded body is refused: JSON only', 'V3.5.2 no request that skips a preflight (JSON only)', '415', code(r), r.status === 415)
    r = await http('POST', '/api/payees', as(victim, { rawBody: '{"name": "x", ' }))
    check('S31', 'input', 'malformed JSON is refused without a server error', 'V2.2.1 input validation', '400', code(r), r.status === 400)
    r = await http('POST', '/api/payees', as(victim, { rawBody: '[1,2,3]' }))
    check('S32', 'input', 'a JSON body that is not an object is refused', 'V2.2.1 input validation', '400', code(r), r.status === 400)
    const amounts: unknown[] = [-100, 0, 1.5, '50000', 1e30, Number.MAX_SAFE_INTEGER, null, { $gt: 0 }, [50_000]]
    const accepted: string[] = []
    for (const a of amounts) { const x = await http('POST', '/api/actions/preview', as(victim, { body: { kind: 'payment', purpose: 'spend', payeeId, amount: a } })); if (x.status === 200) accepted.push(JSON.stringify(a)) }
    check('S33', 'input', 'an amount that is not a positive whole number of paise within range is refused', 'V2.2.1 input validation', `none of ${amounts.length} bad amounts accepted`, accepted.length ? `accepted: ${accepted.join(', ')}` : 'none accepted', accepted.length === 0)
    const usersBefore = count('SELECT COUNT(*) n FROM users')
    const inj = ["' OR '1'='1", "x'; DROP TABLE users;--", '../../etc/passwd', '%00', 'prg_1 UNION SELECT pw_hash FROM users']
    const injRes = await Promise.all(inj.flatMap((s) => [http('GET', `/api/programs/${encodeURIComponent(s)}`, as(attacker)), http('GET', `/api/ledger?account=${encodeURIComponent(s)}`, as(attacker)), http('GET', `/api/market/history?id=${encodeURIComponent(s)}`, as(attacker))]))
    // The replies may echo the probe text back as a JSON string. What must never appear is a stored secret.
    const pw = rows<{ s: string }>(`SELECT pw_hash s FROM users WHERE pw_hash LIKE 'scrypt$%'`).map((x) => x.s)
    const secrets = [...pw, ...rows<{ s: string }>('SELECT code_hash s FROM recovery_codes').map((x) => x.s), ...rows<{ s: string }>('SELECT id_hash s FROM sessions').map((x) => x.s)]
    check('S34', 'input', 'SQL and path metacharacters in ids and query values cause no server error and reveal nothing', 'V1.2.4 parameterised queries', 'no 500; users table intact; no stored password, recovery-code or session hash in any reply', `statuses ${[...new Set(injRes.map((x) => x.status))].join(',')}; ${count('SELECT COUNT(*) n FROM users')} users (${usersBefore} before); searched ${pw.length} password hashes and ${secrets.length - pw.length} other stored hashes`, injRes.every((x) => x.status !== 500 && !secrets.some((h) => x.text.includes(h))) && count('SELECT COUNT(*) n FROM users') === usersBefore && pw.length === 2)
    r = await http('POST', '/api/payees', as(victim, { body: { name: '<img src=x onerror=alert(1)>', handle: 'xss@upi', category: '"><script>alert(1)</script>', nameCheckAccepted: 'unknown' } }))
    const back = await http('GET', '/api/payees', as(victim))
    check('S35', 'input', 'markup in a name is stored as text and served as JSON that a browser will not sniff as HTML', 'V1.2.1 output encoding; V3.4.4', 'application/json with nosniff; the interface renders text nodes only', `${String(back.headers['content-type'])}; nosniff ${String(back.headers['x-content-type-options'])}`, String(back.headers['content-type']).startsWith('application/json') && back.headers['x-content-type-options'] === 'nosniff' && r.status === 200)
    r = await http('POST', '/api/payees', as(victim, { rawBody: '{"name":"Proto","handle":"proto@upi","nameCheckAccepted":"unknown","__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}' }))
    check('S36', 'input', 'prototype-pollution keys in a body do not pollute anything', 'V15.3.6 prototype pollution', 'no polluted property on a fresh object', `${code(r)}; {}.admin is ${String(({} as Record<string, unknown>).admin)}`, ({} as Record<string, unknown>).admin === undefined && (await http('GET', '/api/health')).json?.admin === undefined)
    const trav = await Promise.all(['/../../etc/passwd', '/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/server/schema.sql', '/assets/../../package.json', '/....//....//data/qed.db', '/server/schema.sql', '/data/qed.db', '/.env.local', '/package.json'].map((p) => http('GET', p)))
    const escaped = trav.filter((x) => /root:|CREATE TABLE|"dependencies"|SQLite format/.test(x.text))
    check('S37', 'input', 'no path leaves the built interface\'s folder', 'V5.3.2 file paths from trusted data', 'none of 9 traversal paths returns a file from outside it', escaped.length ? `${escaped.length} escaped` : `statuses ${[...new Set(trav.map((x) => x.status))].join(',')}, no outside content`, escaped.length === 0)
    r = await http('POST', '/', { body: {} })
    check('S38', 'input', 'the static side accepts only GET and HEAD', 'V4.1.4 unused methods blocked', '405', code(r), r.status === 405)
  })

  // ------------------------------------------------------------------ accounts from before R7 (password, no passkey)
  await group('legacy', async () => {
    const lg = await passwordSignIn(legacy.handle, legacy.password)
    legacy.cookie = cookieOf(lg); legacy.csrf = String(must(lg, 'legacy password sign-in').csrf)
    must(await http('POST', '/api/household', as(legacy, { body: {} })), 'legacy household')
    const lp = String(must(await http('POST', '/api/payees', as(legacy, { body: { name: 'Old landlord', handle: 'oldlandlord@upi', category: 'housing', nameCheckAccepted: 'unknown' } })), 'legacy payee').id)
    const L = await preview(legacy, lp, 50_000)
    const b1 = await http('POST', `/api/approvals/${L.approvalId}/passkey`, as(legacy))
    const c1 = await confirmWith(legacy, L.approvalId, { docHash: L.docHash })
    const c2 = await confirmWith(legacy, L.approvalId, { docHash: L.docHash, password: legacy.password })
    const pw1 = await http('POST', '/api/auth/stepup', as(legacy, { body: { password: legacy.password } }))
    const b2 = await http('POST', `/api/approvals/${L.approvalId}/passkey`, as(legacy))
    const c3 = await confirmWith(legacy, L.approvalId, { docHash: L.docHash, password: legacy.password })
    check('N14', 'legacy', 'a legacy password session cannot approve anything, before or after re-entering its password', 'V7.5.3 further authentication; V6.3.4 consistent strength', 'challenge 409 passkey_needed, confirmations 401 passkey_needed, before and after a 200 password re-entry; unconfirmed', `before: challenge ${code(b1)}, confirm ${code(c1)}, with the password in the body ${code(c2)}; password re-entry ${code(pw1)}; after: challenge ${code(b2)}, confirm ${code(c3)}; confirmed ${confirmedAt(L.approvalId) ? 'yes' : 'no'}`, b1.status === 409 && b1.json?.error?.code === 'passkey_needed' && c1.status === 401 && c1.json?.error?.code === 'passkey_needed' && c2.status === 401 && pw1.status === 200 && b2.status === 409 && c3.status === 401 && confirmedAt(L.approvalId) === null)
    const line = Number(must(await http('GET', '/api/home', as(legacy)), 'legacy home').profile?.line ?? 0)
    const weak: [string, Res][] = [
      ['lower the floor', await http('PATCH', '/api/profile', as(legacy, { body: { line: Math.max(0, line - 100_000) } }))],
      ['undo a stop', await http('POST', '/api/stop/clear', as(legacy))],
      ['sign out everywhere', await http('POST', '/api/auth/logout-everywhere', as(legacy))],
      ['replace the recovery codes', await http('POST', '/api/security/recovery-codes', as(legacy))],
      ['create a business', await http('POST', '/api/workspaces', as(legacy, { body: { name: 'Legacy Ltd' } }))],
      ['step up with a passkey', await http('POST', '/api/auth/passkey/stepup/begin', as(legacy))],
    ]
    legacySavedCodes = (weak.find(([n]) => n === 'replace the recovery codes')?.[1].json?.codes as string[] | undefined) ?? []
    const addBegin = await http('POST', '/api/security/passkeys/begin', as(legacy))
    const added = authenticator()
    const addFinish = addBegin.status === 200 ? await http('POST', '/api/security/passkeys/finish', as(legacy, { body: { challengeId: addBegin.json!.challengeId, response: added.create(addBegin.json!.options) } })) : null
    if (addFinish?.status === 200) {
      legacyAuth = added; settle(added.id)
      // D-182: the first passkey makes the account's saved codes and replaces earlier ones, so later checks use the fresh set
      const fresh = addFinish.json?.recoveryCodes as string[] | undefined
      if (fresh?.length) legacySavedCodes = fresh
    }
    check('N15', 'legacy', 'a legacy password re-entry unlocks only adding a first passkey and, on an account whose password is its only credential (RISK-076), renewing its own saved codes: every change that weakens a protection of money still needs a passkey', 'V6.3.4 consistent strength across pathways', 'five refusals (401 stepup_required, or 409 passkey_needed for the passkey step-up); new saved codes 200 (the account\'s strongest credential, outside a reset hold); adding a passkey 200', `${weak.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}; add a first passkey: begin ${code(addBegin)}, finish ${code(addFinish)}`, [0, 1, 2, 4].every((i) => weak[i]![1].status === 401 && weak[i]![1].json?.error?.code === 'stepup_required') && weak[3]![1].status === 200 && weak[5]![1].status === 409 && addBegin.status === 200 && addFinish?.status === 200)
    const pw2 = await http('POST', '/api/auth/stepup', as(legacy, { body: { password: legacy.password } }))
    const second = await http('POST', '/api/security/passkeys/begin', as(legacy))
    const now = await approve(legacy, added, L.approvalId, L.docHash)
    check('N16', 'legacy', 'once the legacy account has a passkey, its password no longer unlocks adding another, and the new passkey approves', 'V6.3.4 consistent strength across pathways', 'password re-entry 200; a second passkey 401 stepup_required; the approval signed with the new passkey 200', `password ${code(pw2)}; second passkey ${code(second)}; approval ${code(now.confirm)}`, pw2.status === 200 && second.status === 401 && second.json?.error?.code === 'stepup_required' && now.confirm?.status === 200)
    let wrong = 0, limited = 0
    for (let i = 0; i < 10; i++) { const x = await http('POST', '/api/auth/stepup', as(legacy, { body: { password: `wrong-${i}-password` } })); if (x.json?.error?.code === 'bad_credentials') wrong++; if (x.status === 429) limited++ }
    const right = await http('POST', '/api/auth/stepup', as(legacy, { body: { password: legacy.password } }))
    check('S28', 'legacy', 'guessing a legacy account\'s password at re-entry is cut off after eight wrong tries, and then even the right one waits', 'V6.3.1 brute force', '8 rejected, then 429 including for the right password', `${wrong} rejected, ${limited} limited, right password afterwards: ${code(right)}`, wrong === 8 && limited === 2 && right.status === 429, 'guessing the signing password is cut off after eight wrong tries, and then even the right one waits')

    // Identical answers, and the same work, whoever the handle belongs to. Three rounds, medians compared.
    const t: Record<'unknown' | 'legacy' | 'passkey', { ms: number; r: Res }[]> = { unknown: [], legacy: [], passkey: [] }
    for (let i = 0; i < 3; i++) for (const [k, h] of [['unknown', 'nobody-here'], ['legacy', oldtimer.handle], ['passkey', stopper.handle]] as const) { const t0 = performance.now(); const r = await passwordSignIn(h, 'not-the-password-1'); t[k].push({ ms: performance.now() - t0, r }) }
    const same = (a: Res, b: Res): boolean => a.status === b.status && a.json?.error?.message === b.json?.error?.message
    const ref = t.unknown[0]!.r
    const ms = (k: keyof typeof t): string => t[k].map((x) => x.ms.toFixed(0)).join('/')
    check('S40', 'legacy', 'a wrong password and an unknown handle get the same answer, and both cost a password hash', 'V6.3.8 no enumeration', 'same status and message; both take the time of a hash', `unknown ${code(ref)} "${String(ref.json?.error?.message)}" in ${ms('unknown')} ms; wrong password ${code(t.legacy[0]!.r)} in ${ms('legacy')} ms (3 rounds)`, [...t.unknown, ...t.legacy].every((x) => same(x.r, ref)) && Math.min(median(t.unknown.map((x) => x.ms)), median(t.legacy.map((x) => x.ms))) > 20, 'a wrong password and an unknown handle get the same answer, and both cost a password hash')
    check('N17', 'legacy', 'password sign-in for a passkey-only account (every account since R7) answers like an unknown handle, in the same time', 'V6.3.8 no enumeration (response times)', 'same status and message; the passkey account\'s median within half of the unknown handle\'s', `unknown ${ms('unknown')} ms; passkey-only ${code(t.passkey[0]!.r)} "${String(t.passkey[0]!.r.json?.error?.message)}" in ${ms('passkey')} ms (3 rounds)`, t.passkey.every((x) => same(x.r, ref)) && median(t.passkey.map((x) => x.ms)) >= 0.5 * median(t.unknown.map((x) => x.ms)))
    let rejected = 0, lockedAnswers = 0
    for (let i = 0; i < 5; i++) { const x = await passwordSignIn(oldtimer.handle, `guess-number-${i}-x`); if (x.status === 401) rejected++; if (x.status === 429) lockedAnswers++ }
    const opened = await passwordSignIn(oldtimer.handle, oldtimer.password)
    check('S41', 'legacy', 'after repeated wrong passwords a legacy account is locked, and the right password does not open it until the lock ends', 'V6.3.1 brute force (lockout)', 'locked: the right password is refused', `${rejected} of 5 further guesses rejected, ${lockedAnswers} answered locked; right password then: ${code(opened)}`, opened.status !== 200 && lockedAnswers > 0, 'after repeated wrong passwords the account is locked, and the right password does not open it until the lock ends')
    let lk: Res | null = null
    for (let i = 0; i < 3; i++) lk = await passwordSignIn(stopper.handle, `guess-number-${i}-y`)
    const pk = await signIn(stopper.auth)
    // Changed on 22 Nov (7599237): a passkey-only account is answered on the password path exactly as an unknown handle,
    // so it is never locked (a lock-out answer would reveal that the handle exists; see N17). Guesses cost nothing there.
    check('N18', 'legacy', 'wrong passwords against a passkey-only account never lock it (they are answered as for an unknown handle), and its owner still signs in with the passkey', 'V6.3.1 brute force (lockout without denial of service); V6.3.8', 'password path 401 bad_credentials after six guesses; passkey sign-in 200', `password path ${code(lk)}; passkey sign-in ${code(pk.res)}`, lk?.status === 401 && lk.json?.error?.code === 'bad_credentials' && pk.res.status === 200)
  })

  // ------------------------------------------------------------------ sessions and live connections
  await group('sessions', async () => {
    const si = await signIn(victim.auth)
    const r = await http('POST', '/api/auth/logout', { cookie: si.cookie, csrf: si.csrf, body: {} })
    const after = await http('GET', '/api/home', { cookie: si.cookie })
    check('S42', 'session', 'after signing out, the old cookie is worthless', 'V7.4.1 session termination', '401', `sign-out ${code(r)}; old cookie then ${code(after)}`, r.status === 200 && after.status === 401)
    const streams = await Promise.all(Array.from({ length: 8 }, () => new Promise<number>((resolve) => { const q = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { Host: host, Cookie: attacker.cookie } }, (res) => resolve(res.statusCode ?? 0)); q.on('error', () => resolve(0)); q.end() })))
    check('S43', 'limits', 'one owner cannot hold more than six live connections', 'V2.4.1 anti-automation', 'six accepted, the rest 429', `${streams.filter((s) => s === 200).length} accepted, ${streams.filter((s) => s === 429).length} refused`, streams.filter((s) => s === 200).length === 6 && streams.filter((s) => s === 429).length === 2)
  })

  // ------------------------------------------------------------------ changes that weaken a protection need a fresh passkey confirmation
  await group('protection', async () => {
    stale(careful)
    const weaker = await http('PATCH', '/api/profile', as(careful, { body: { lostSalaries: 0 } }))
    const stronger = await http('PATCH', '/api/profile', as(careful, { body: { lostSalaries: 2, lateDays: 10 } }))
    const su = await stepUp(careful, careful.auth)
    const withPasskey = await http('PATCH', '/api/profile', as(careful, { body: { lostSalaries: 0 } }))
    check('S44', 'protection', 'asking the bank reserve to withstand less needs a fresh passkey confirmation; asking it to withstand more does not', 'V7.5.3 further authentication', '401 stepup_required, then 200 for the stronger setting, then 200 once confirmed with the passkey', `${code(weaker)}; ${code(stronger)}; step-up ${code(su.res)}; ${code(withPasskey)}`, weaker.status === 401 && weaker.json?.error?.code === 'stepup_required' && stronger.status === 200 && su.res.status === 200 && withPasskey.status === 200, 'asking the bank reserve to withstand less needs the password again; asking it to withstand more does not')
    stale(thrifty)
    const less = await http('PATCH', '/api/profile', as(thrifty, { body: { spending: 0 } }))
    const more = await http('PATCH', '/api/profile', as(thrifty, { body: { spending: 9_000_000 } }))
    check('S45', 'protection', 'lowering the everyday spending figure lowers what must stay in the bank, so it needs a fresh passkey confirmation; raising it does not', 'V7.5.3 further authentication', '401 stepup_required naming both figures; 200 for the higher figure', `${code(less)} "${String(less.json?.error?.message ?? '').slice(0, 90)}"; ${code(more)}`, less.status === 401 && less.json?.error?.code === 'stepup_required' && /lowers what must stay/.test(String(less.json?.error?.message)) && more.status === 200, 'lowering the everyday spending figure lowers what must stay in the bank, so it needs the password; raising it does not')
    const line = Number((await http('GET', '/api/home', { cookie: thrifty.cookie })).json?.profile?.line ?? 0)
    const lower = await http('PATCH', '/api/profile', as(thrifty, { body: { line: Math.max(0, line - 100_000) } }))
    const higher = await http('PATCH', '/api/profile', as(thrifty, { body: { line: line + 100_000 } }))
    check('S46', 'protection', 'lowering the floor needs a fresh passkey confirmation; raising it does not', 'V7.5.3 further authentication', '401 stepup_required, then 200', `${code(lower)}; ${code(higher)}`, lower.status === 401 && lower.json?.error?.code === 'stepup_required' && higher.status === 200, 'lowering the floor needs the password; raising it does not')
    const payee = await http('POST', '/api/payees', as(thrifty, { body: { name: 'City Power', handle: 'power@upi', category: 'utilities', nameCheckAccepted: 'unknown' } }))
    const bill = await http('POST', '/api/bills', as(thrifty, { body: { payeeId: payee.json?.id, amount: 1_100_000, dueAt: Date.now() + 5 * 86_400_000 } }))
    const drop = await http('POST', `/api/bills/${String(bill.json?.id)}/cancel`, as(thrifty))
    const su2 = await stepUp(thrifty, thrifty.auth)
    const dropConfirmed = await http('POST', `/api/bills/${String(bill.json?.id)}/cancel`, as(thrifty))
    check('S47', 'protection', 'removing a bill that is counted in what must stay needs a fresh passkey confirmation', 'V7.5.3 further authentication', '401 stepup_required, then 200 once confirmed with the passkey', `added ${code(payee)}, ${code(bill)}; remove ${code(drop)}; step-up ${code(su2.res)}; then ${code(dropConfirmed)}`, bill.status === 200 && drop.status === 401 && drop.json?.error?.code === 'stepup_required' && dropConfirmed.status === 200, 'removing a bill that is counted in what must stay needs the password')

    stale(stopper)
    const stop = await http('POST', '/api/stop', as(stopper, { body: { reason: 'check' } }))
    const clear = await http('POST', '/api/stop/clear', as(stopper))
    const outAll = await http('POST', '/api/auth/logout-everywhere', as(stopper))
    check('S48', 'protection', 'anyone with the session can stop everything; undoing the stop, and signing out everywhere, need a fresh passkey confirmation', 'V7.5.3 further authentication', '200 to stop; 401 stepup_required to undo it and to sign out everywhere', `stop ${code(stop)}; undo ${code(clear)}; sign out everywhere ${code(outAll)}`, stop.status === 200 && clear.status === 401 && clear.json?.error?.code === 'stepup_required' && outAll.status === 401 && outAll.json?.error?.code === 'stepup_required', 'anyone with the session can stop everything; undoing the stop, and signing out everywhere, need the password')
    const held = rows<{ p: number }>('SELECT stop_protective p FROM users WHERE id = ?', stopper.userId)[0]?.p
    const shown = (await http('GET', '/api/session', { cookie: stopper.cookie })).json?.stop?.protectiveContinues
    await stepUp(stopper, stopper.auth)
    const cleared = await http('POST', '/api/stop/clear', as(stopper))
    const keep = await http('POST', '/api/stop', as(stopper, { body: { reason: 'check', keepProtective: true } }))
    const kept = rows<{ p: number }>('SELECT stop_protective p FROM users WHERE id = ?', stopper.userId)[0]?.p
    const shownKept = (await http('GET', '/api/session', { cookie: stopper.cookie })).json?.stop?.protectiveContinues
    await http('POST', '/api/stop/clear', as(stopper))
    check('N19', 'protection', 'a plain stop holds protective selling too; keeping it running is a choice the owner states, and the record says which', 'V2.3.2 business-logic limits as documented', 'plain stop: stop_protective 0, shown as not continuing; with keepProtective: 1, shown as continuing', `plain: ${String(held)}, shown ${String(shown)}; cleared ${code(cleared)}; with keepProtective ${code(keep)}: ${String(kept)}, shown ${String(shownKept)}`, held === 0 && shown === false && cleared.status === 200 && keep.status === 200 && kept === 1 && shownKept === true)

    stale(spender)
    const sp = String(must(await http('POST', '/api/payees', as(spender, { body: { name: 'A shop', handle: 'shop@upi', category: 'other', nameCheckAccepted: 'unknown' } })), 'spender payee').id)
    const one = await preview(spender, sp, 600_000), two = await preview(spender, sp, 600_000)
    const c1 = await confirmWith(spender, one.approvalId, { docHash: one.docHash })
    const c2 = await confirmWith(spender, two.approvalId, { docHash: two.docHash, password: 'not-a-signature-2' })
    const s1 = await approve(spender, spender.auth, one.approvalId, one.docHash), s2 = await approve(spender, spender.auth, two.approvalId, two.docHash)
    check('S49', 'protection', 'a session alone cannot approve any amount, however it is split: two payments of ₹6,000 prepared together are refused without a passkey signature, and each is accepted with one', 'V7.5.3 further authentication; V4.1.5', 'both 401 passkey_required without a signature (even on a session with no recent re-authentication, the signature is the confirmation); both 200 with the passkey', `without: ${code(c1)}, ${code(c2)}; with the passkey: ${code(s1.confirm)}, ${code(s2.confirm)}`, c1.status === 401 && c1.json?.error?.code === 'passkey_required' && c2.status === 401 && c2.json?.error?.code === 'passkey_required' && s1.confirm?.status === 200 && s2.confirm?.status === 200, 'without the password a session cannot approve ₹10,000 in a day by splitting it: two payments of ₹6,000 prepared together, the second is refused at confirmation')

    const bad = await http('PATCH', '/api/profile', as(careful, { body: { lostSalaries: 9, lateDays: -1 } }))
    check('S50', 'input', 'reserve assumptions outside their range are refused with a message per field', 'V2.2.1 input validation', '400 naming both fields', `${code(bad)} ${Object.keys(bad.json?.error?.fields ?? {}).join(',')}`, bad.status === 400 && !!bad.json?.error?.fields?.lostSalaries && !!bad.json?.error?.fields?.lateDays)
    const since = await http('GET', '/api/since?ts=-99999999999999', { cookie: careful.cookie })
    const junk = await http('GET', '/api/since?ts=not-a-number', { cookie: careful.cookie })
    check('S51', 'input', 'the absence summary clamps its time to the life of the account and never reaches another owner', 'V2.2.1 input validation; V8.2.2', '200 with nothing done for a new account, whatever time is asked for', `${code(since)} done=${String(since.json?.done)}; ${code(junk)} done=${String(junk.json?.done)}`, since.status === 200 && since.json?.done === 0 && junk.status === 200 && junk.json?.done === 0 && Number(since.json?.from) > 1_700_000_000_000)
    const pageAt = await http('GET', '/instructions/new', { host: `localhost:${port}` })
    const missing = await http('GET', '/instructions/assets/no-such-file.js', { host: `localhost:${port}` })
    const built = pageAt.status === 200 && /<div id="root">/.test(pageAt.text)
    check('S52', 'interface', 'a nested route of the built interface serves the page with absolute asset paths, and a missing file is 404, not the page', 'V14.2.5 a missing file is 404, not another file', 'the page with /assets/ paths; 404 for the missing file', built ? `${pageAt.status}, script ${/src="\/assets\//.test(pageAt.text) ? 'absolute' : 'relative'}; missing file ${missing.status}` : `the interface is not built here (${pageAt.status}); run "npm run build"`, built && /src="\/assets\//.test(pageAt.text) && missing.status === 404)
  })

  // ------------------------------------------------------------------ passkeys and recovery codes: removal waits, and needs a fresh confirmation
  await group('passkeys', async () => {
    stale(careful)
    const first = careful.auth.id
    const noConfirm = await http('POST', `/api/security/passkeys/${first}/remove`, as(careful))
    await stepUp(careful, careful.auth)
    const last = await http('POST', `/api/security/passkeys/${first}/remove`, as(careful))
    check('N20', 'passkeys', 'removing a passkey needs a fresh passkey confirmation, and the last passkey cannot be removed', 'V7.5.1 re-authentication before changing authentication', '401 stepup_required; then 409 last_passkey', `without confirmation ${code(noConfirm)}; the only passkey ${code(last)}`, noConfirm.status === 401 && noConfirm.json?.error?.code === 'stepup_required' && last.status === 409 && last.json?.error?.code === 'last_passkey')
    const ab = must(await http('POST', '/api/security/passkeys/begin', as(careful)), 'add a passkey')
    const auth2 = authenticator()
    must(await http('POST', '/api/security/passkeys/finish', as(careful, { body: { challengeId: ab.challengeId, response: auth2.create(ab.options), passkeyName: 'Second' } })), 'add a passkey finish')
    const sch1 = await http('POST', `/api/security/passkeys/${first}/remove`, as(careful))
    const during = await signIn(careful.auth)
    const cancel1 = await http('POST', `/api/security/changes/${String(sch1.json?.changeId)}/cancel`, as(careful))
    const s2 = await signIn(auth2)
    settle(auth2.id) // N22 is about the delay; removing a passkey in its cool-off is X05
    const sch2 = await http('POST', `/api/security/passkeys/${auth2.id}/remove`, as(careful))
    const waitMs = Math.max(Number(sch1.json?.effectiveAt ?? 0), Number(sch2.json?.effectiveAt ?? 0)) - Date.now() + 800
    await sleep(Math.max(0, Math.min(waitMs, (DELAY_SEC + 5) * 1000)))
    const sec = must(await http('GET', '/api/security', as(careful)), 'security view')
    const pk = (id: string) => (sec.passkeys as { id: string; removedAt: number | null }[]).find((x) => x.id === id)
    const after1 = await signIn(careful.auth), after2 = await signIn(auth2)
    const home2 = await http('GET', '/api/home', { cookie: s2.cookie })
    check('N21', 'passkeys', 'removing a passkey waits out the delay, the passkey keeps working meanwhile, and a cancelled removal never takes effect', 'V6.5.6 factor revocation; V7.5.1', `scheduled for about ${DELAY_SEC} s later; sign-in with it 200 meanwhile; cancel 200; after the delay still active and signing in`, `scheduled ${code(sch1)} for +${((Number(sch1.json?.effectiveAt ?? 0) - Date.now()) / 1000 + waitMs / 1000).toFixed(0)} s; sign-in meanwhile ${code(during.res)}; cancel ${code(cancel1)}; after the delay removed ${pk(first)?.removedAt ? 'yes' : 'no'}, sign-in ${code(after1.res)}`, sch1.status === 200 && during.res.status === 200 && cancel1.status === 200 && pk(first)?.removedAt === null && after1.res.status === 200)
    check('N22', 'passkeys', 'when the delay ends the passkey is removed: it no longer signs in, and the sessions it opened end', 'V6.5.6 factor revocation; V7.4.3 sessions end with the factor', 'removed; sign-in 401; its session 401', `scheduled ${code(sch2)}; removed ${pk(auth2.id)?.removedAt ? 'yes' : 'no'}; sign-in ${code(after2.res)}; its session ${code(home2)}`, sch2.status === 200 && !!pk(auth2.id)?.removedAt && after2.res.status === 401 && s2.res.status === 200 && home2.status === 401)
    // Suspension: at once, from another passkey; what the suspended passkey had asked for is cancelled; allowing it again waits.
    const ab3 = must(await http('POST', '/api/security/passkeys/begin', as(careful)), 'add a third passkey')
    const auth3 = authenticator()
    must(await http('POST', '/api/security/passkeys/finish', as(careful, { body: { challengeId: ab3.challengeId, response: auth3.create(ab3.options), passkeyName: 'Third' } })), 'add a third passkey finish')
    settle(auth3.id) // a stolen passkey past its cool-off: in it, it could ask for nothing (X05)
    const s3 = await signIn(auth3)
    const s3s: Signed = { cookie: s3.cookie, csrf: s3.csrf, userId: careful.userId }
    stale(careful)
    const suspStale = await http('POST', `/api/security/passkeys/${auth3.id}/suspend`, as(careful))
    await stepUp(careful, careful.auth)
    const suspOwn = await http('POST', `/api/security/passkeys/${careful.auth.id}/suspend`, as(careful))
    let suspLast: Res | null = null
    if (legacyAuth) { await stepUp(legacy, legacyAuth); suspLast = await http('POST', `/api/security/passkeys/${legacyAuth.id}/suspend`, as(legacy)) }
    check('N46', 'passkeys', 'suspending a passkey needs a fresh passkey confirmation, and is refused for the passkey that opened the asking session and for the last usable passkey', 'V7.5.1 re-authentication; V6.5.6 factor revocation', '401 stepup_required; 409 own_passkey; 409 last_passkey (a legacy account whose one passkey is asked from its password session)', `without confirmation ${code(suspStale)}; this session's own passkey ${code(suspOwn)}; the last usable one ${code(suspLast)}`, suspStale.status === 401 && suspStale.json?.error?.code === 'stepup_required' && suspOwn.status === 409 && suspOwn.json?.error?.code === 'own_passkey' && suspLast?.status === 409 && suspLast.json?.error?.code === 'last_passkey')
    await stepUp(s3s, auth3)
    const pending = await http('POST', `/api/security/passkeys/${careful.auth.id}/remove`, as(s3s)) // what a stolen passkey would ask for
    const susp = await http('POST', `/api/security/passkeys/${auth3.id}/suspend`, as(careful, { body: { code: careful.codes[0] } })) // H2: a saved code
    const signInSusp = await signIn(auth3)
    const s3After = await http('GET', '/api/home', { cookie: s3.cookie })
    const stepSusp = await stepUp(careful, auth3)
    const cp = String(must(await http('POST', '/api/payees', as(careful, { body: { name: 'Corner shop', handle: 'corner@upi', category: 'other', nameCheckAccepted: 'unknown' } })), 'careful payee').id)
    const cpv = await preview(careful, cp, 10_000)
    const apprSusp = await approve(careful, auth3, cpv.approvalId, cpv.docHash)
    const pendingRow = rows<{ cancelled_at: number | null; cancelled_by: string | null }>('SELECT cancelled_at, cancelled_by FROM scheduled_changes WHERE id = ?', String(pending.json?.changeId))[0]
    check('N47', 'passkeys', 'a suspended passkey is refused at once: it cannot sign in, step up or sign an approval, the sessions it opened end, and the removal it had asked for is cancelled', 'V6.5.6 factor revocation', 'suspend 200; sign-in 401; its session 401; step-up 401; approval 401; the removal it asked for cancelled (requester-suspended)', `removal asked by it ${code(pending)}; suspend ${code(susp)}; sign-in ${code(signInSusp.res)}; its session ${code(s3After)}; step-up ${code(stepSusp.res)}; approval ${code(apprSusp.confirm)}; that removal ${pendingRow?.cancelled_at ? `cancelled (${String(pendingRow.cancelled_by)})` : 'STILL PENDING'}`, pending.status === 200 && susp.status === 200 && signInSusp.res.status === 401 && s3After.status === 401 && stepSusp.res.status === 401 && apprSusp.confirm?.status === 401 && !!pendingRow?.cancelled_at && pendingRow.cancelled_by === 'requester-suspended' && confirmedAt(cpv.approvalId) === null)
    const unsusp = await http('POST', `/api/security/passkeys/${auth3.id}/unsuspend`, as(careful))
    const stillOut = await signIn(auth3)
    await sleep(Math.max(0, Math.min(Number(unsusp.json?.effectiveAt ?? 0) - Date.now() + 800, (DELAY_SEC + 5) * 1000)))
    await http('GET', '/api/security', as(careful)) // applies due changes, as the engine's tick also does
    const backIn = await signIn(auth3)
    check('N48', 'passkeys', 'allowing a suspended passkey again waits out the delay: refused meanwhile, usable after', 'V7.5.1 re-authentication before changing authentication', `scheduled about ${DELAY_SEC} s ahead; sign-in 401 meanwhile; 200 after the delay`, `unsuspend ${code(unsusp)}; sign-in meanwhile ${code(stillOut.res)}; after the delay ${code(backIn.res)}`, unsusp.status === 200 && unsusp.json?.effectiveAt > Date.now() - 60_000 && stillOut.res.status === 401 && backIn.res.status === 200)

    stale(careful)
    const unusedBefore = count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', careful.userId)
    const regenStale = await http('POST', '/api/security/recovery-codes', as(careful))
    await stepUp(careful, careful.auth)
    const regen = await http('POST', '/api/security/recovery-codes', as(careful, { body: { code: careful.codes[1] } })) // H2: one of the current codes
    const active = count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', careful.userId), replaced = count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND replaced_at IS NOT NULL', careful.userId)
    const oldStillThere = careful.codes.some((c) => (regen.json?.codes as string[] | undefined)?.includes(c))
    check('N23', 'passkeys', 'replacing the recovery codes needs a fresh passkey confirmation, and the earlier codes stop working', 'V7.5.1 re-authentication before changing authentication; V6.5.1', '401 stepup_required; then, with one of the current codes (H2), 200 with ten new codes; the earlier unused ones marked replaced and the one given spent', `without confirmation ${code(regenStale)}; with ${code(regen)} (${(regen.json?.codes as string[] | undefined)?.length ?? 0} codes${oldStillThere ? ', an old one repeated' : ''}); ${active} active, ${replaced} replaced`, regenStale.status === 401 && regen.status === 200 && (regen.json?.codes as string[] | undefined)?.length === 10 && !oldStillThere && active === 10 && replaced === unusedBefore - 1)
  })

  // ------------------------------------------------------------------ account recovery: two codes by different methods, a wait, cancellable from any session
  // (NIST SP 800-63B-4 §4.2.2.2 for an account at AAL2: a saved code and a code a recovery contact issues, or for an
  // account made before passkeys its password; then the delay, during which every session and the contact are told.)
  await group('recovery', async () => {
    type Started = Res & { sentAt: number }
    let starts = 0
    const startRecovery = async (body: Record<string, unknown>): Promise<Started> => { starts++; const sentAt = Date.now(); return { ...(await http('POST', '/api/auth/recovery/start', { body })), sentAt } }
    const follow = (r: Res): Promise<Res> => http('POST', '/api/auth/recovery/passkey/begin', { body: { reference: r.json?.reference } })
    /** What any start answers: the status, the fields, the delay it states, and no cookie. */
    const shape = (r: Started): string => `${r.status} ${Object.keys(r.json ?? {}).sort().join(',')} delay ${Math.round((Number(r.json?.availableAt ?? 0) - r.sentAt) / 1000)} s${r.headers['set-cookie'] ? ' COOKIE' : ''}`
    const requests = (personId = recoverme.userId): number => count('SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ?', personId)
    const usedSaved = (): number => count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', recoverme.userId)
    const madeUp = 'AAAA-BBBB-CCCC-DDDD'
    const issue = async (): Promise<Res> => { await stepUp(friend, friend.auth); return http('POST', `/api/security/contacts/${contactLink}/code`, as(friend)) }

    await sleep(Math.max(0, Number(nominateOk?.json?.effectiveAt ?? 0) - Date.now() + 500))
    const c1 = await issue()
    check('N44', 'recovery', 'naming a recovery contact needs a fresh passkey confirmation, and the contact can issue a code only after accepting and after the delay', 'V7.5.1 re-authentication; V6.4.3 secure recovery', `401 stepup_required without the confirmation; named 200 effective about ${DELAY_SEC} s later; accepted 200; a code before then 409 contact_inactive, after it 200`, `without confirmation ${code(nominateStale)}; named ${code(nominateOk)} effective +${Math.round((Number(nominateOk?.json?.effectiveAt ?? 0) - nominatedAt) / 1000)} s; accepted ${code(contactAccepted)}; a code before the delay ${code(issuedEarly)}; after it ${code(c1)}`, nominateStale?.status === 401 && nominateStale.json?.error?.code === 'stepup_required' && nominateOk?.status === 200 && contactAccepted?.status === 200 && issuedEarly?.status === 409 && issuedEarly.json?.error?.code === 'contact_inactive' && c1.status === 200)

    const wrong = await startRecovery({ handle: recoverme.handle, code: madeUp, contactCode: String(c1.json?.code) }), unknown = await startRecovery({ handle: 'nobody-here', code: madeUp, contactCode: madeUp })
    const fw = await follow(wrong), fu = await follow(unknown)
    check('N24', 'recovery', 'a wrong saved code and an unknown handle get identical answers, at the start and when the recovery is followed up', 'V6.3.8 no enumeration', 'the same status, fields and delay, no cookie; the follow-up the same refusal; nothing on record', `wrong code: ${shape(wrong)}, follow-up ${code(fw)}; unknown handle: ${shape(unknown)}, follow-up ${code(fu)}; requests on record ${count('SELECT COUNT(*) n FROM recovery_requests')}`, shape(wrong) === shape(unknown) && wrong.status === 200 && fw.status === fu.status && fw.json?.error?.code === fu.json?.error?.code && count('SELECT COUNT(*) n FROM recovery_requests') === 0)
    const alone = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[2]!, password: 'not-the-password-3' })
    check('N42', 'recovery', 'one saved code alone starts nothing, and for a passkey account no password stands in for the second code; the answer is the same as any other', 'V6.4.3 recovery does not bypass the second factor (NIST SP 800-63B-4 §4.2.2.2)', 'the same answer; no request on record; no saved code used up', `${shape(alone)}; requests ${requests()}; saved codes used ${usedSaved()}`, shape(alone) === shape(wrong) && requests() === 0 && usedSaved() === 0)
    const c2 = await issue() // replaces c1
    const badContact = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[0]!, contactCode: madeUp })
    const replacedContact = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[0]!, contactCode: String(c1.json?.code) })
    const replacedRows = count('SELECT COUNT(*) n FROM contact_codes WHERE person_id = ? AND replaced_at IS NOT NULL', recoverme.userId)
    check('N43', 'recovery', 'a wrong contact code, or one replaced by a newer one, starts nothing and does not use up the saved code', 'V6.5.1 single use; V6.4.3', 'the same answer twice; no request; no saved code used; the earlier contact code marked replaced', `new contact code ${code(c2)}; wrong contact code: ${shape(badContact)}; replaced contact code: ${shape(replacedContact)}; requests ${requests()}; saved codes used ${usedSaved()}; contact codes replaced ${replacedRows}`, c2.status === 200 && shape(badContact) === shape(wrong) && shape(replacedContact) === shape(wrong) && requests() === 0 && usedSaved() === 0 && replacedRows === 1)
    const right = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[0]!, contactCode: String(c2.json?.code) })
    const early = await follow(right)
    const c3 = await issue()
    const reuse = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[0]!, contactCode: String(c3.json?.code) })
    const afterReuse = requests(), usableContact = count('SELECT COUNT(*) n FROM contact_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', recoverme.userId)
    check('N28', 'recovery', 'a saved code works once: using it again with a valid contact code starts nothing, says nothing, and leaves the contact code usable', 'V6.5.1 single use', 'the same answer as any start; still one request on record; one usable contact code', `${shape(reuse)}; requests ${afterReuse}; usable contact codes ${usableContact}`, shape(reuse) === shape(wrong) && afterReuse === 1 && usableContact === 1)
    const other = await startRecovery({ handle: recoverme.handle, code: recoverme.codes[1]!, contactCode: String(c3.json?.code) })
    // R12: cancelling a recovery needs a fresh confirmation from a passkey that can approve, so a stolen, stale session
    // cannot cancel the owner's own recovery; the owner confirms once and cancels
    stale(recoverme)
    const staleCancel = await http('POST', `/api/security/recoveries/${String(other.json?.requestId)}/cancel`, as(recoverme))
    await stepUp(recoverme, recoverme.auth)
    const cancel = await http('POST', `/api/security/recoveries/${String(other.json?.requestId)}/cancel`, as(recoverme))
    const told = await http('GET', '/api/session', { cookie: recoverme.cookie })
    const events = rows<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? AND kind LIKE 'recovery-%'`, recoverme.userId).map((e) => e.kind)
    const contactEvents = rows<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? AND kind LIKE 'contact-recovery-%'`, friend.userId).map((e) => e.kind)
    check('N26', 'recovery', 'while a recovery waits the owner is told in every signed-in session, and the recovery contact is told too', 'V6.3.7 notification of changes to authentication', 'one open recovery reported; owner events for both starts and the cancellation; the contact told of both starts', `open recoveries ${String(told.json?.openRecoveries)}; owner events ${events.join(', ')}; contact events ${contactEvents.join(', ') || 'none'}`, told.json?.openRecoveries === 1 && events.filter((e) => e === 'recovery-started').length === 2 && events.includes('recovery-cancelled') && contactEvents.filter((e) => e === 'contact-recovery-started').length === 2)

    // An account made before passkeys: its password stands in for the contact's code (it has a passkey since N15).
    let legacyCodes: Res | null = null, legacyStart: Started | null = null, legacyFollow: Res | null = null
    if (legacyAuth) {
      await stepUp(legacy, legacyAuth)
      legacyCodes = await http('POST', '/api/security/recovery-codes', as(legacy, { body: { code: legacySavedCodes[0] } })) // H2: one of its codes
      legacyStart = await startRecovery({ handle: legacy.handle, code: (legacyCodes.json?.codes as string[] | undefined)?.[0] ?? '', password: legacy.password })
      legacyFollow = await follow(legacyStart)
    }
    const legacyMethod = rows<{ method: string }>('SELECT method FROM recovery_requests WHERE person_id = ?', legacy.userId).map((x) => x.method)
    check('N45', 'recovery', 'for an account made before passkeys its password stands in for the contact\'s code: a saved code and the password start a recovery, which still waits', 'V6.4.3 secure recovery', 'codes 200; the start answers like any other; one request, method saved+password; the follow-up 409 recovery_waiting', `codes ${code(legacyCodes)}; start ${legacyStart ? shape(legacyStart) : 'not sent'}; requests ${legacyMethod.join(', ') || 'none'}; follow-up ${code(legacyFollow)}`, legacyCodes?.status === 200 && !!legacyStart && shape(legacyStart) === shape(wrong) && legacyMethod.length === 1 && legacyMethod[0] === 'saved+password' && legacyFollow?.status === 409 && legacyFollow.json?.error?.code === 'recovery_waiting')

    await sleep(Math.max(0, Math.max(Number(right.json?.availableAt ?? 0), Number(other.json?.availableAt ?? 0)) - Date.now() + 800))
    const begin = await follow(right)
    const fresh = authenticator()
    const fin = begin.status === 200 ? await http('POST', '/api/auth/recovery/passkey/finish', { body: { challengeId: begin.json!.challengeId, response: fresh.create(begin.json!.options), passkeyName: 'Recovered' } }) : null
    const who = fin ? await http('GET', '/api/session', { cookie: cookieOf(fin) }) : null
    const newCodes = (fin?.json?.recoveryCodes as string[] | undefined) ?? []
    const activeCodes = count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', recoverme.userId)
    check('N25', 'recovery', 'a saved code and a contact\'s code together grant nothing until the delay ends; then a new passkey can be created, it signs the person in, and every older saved code is replaced by a new set', 'V6.4.3 secure recovery; V6.4.4', `the start answers like any other; 409 recovery_waiting before the delay; after ${DELAY_SEC} s a new passkey, a session for that person and ten new codes, the only usable ones`, `start ${shape(right)}; before the delay ${code(early)}; after: begin ${code(begin)}, finish ${code(fin)}, signed in as ${String(who?.json?.user?.handle ?? 'nobody')} by ${String(who?.json?.authMethod ?? '-')}; ${newCodes.length} new codes, ${activeCodes} usable, ${recoverme.codes.filter((c) => newCodes.includes(c)).length} old ones among them`, shape(right) === shape(wrong) && early.status === 409 && early.json?.error?.code === 'recovery_waiting' && fin?.status === 200 && who?.json?.user?.handle === recoverme.handle && newCodes.length === 10 && activeCodes === 10 && !recoverme.codes.some((c) => newCodes.includes(c)))
    const late = await follow(other)
    check('N27', 'recovery', 'a signed-in owner cancels a recovery after one fresh confirmation (a stale session is asked to confirm first), and a cancelled recovery can never be completed', 'V6.4.3 secure recovery', 'cancel from a stale session 401 stepup_required; after a fresh confirmation 200; after the delay 409 recovery_unavailable', `stale ${code(staleCancel)}; fresh ${code(cancel)}; after the delay ${code(late)}`, staleCancel.status === 401 && cancel.status === 200 && late.status === 409 && late.json?.error?.code === 'recovery_unavailable')

    let accepted = starts, limited: Res | null = null
    for (let i = 0; i < 12 && !limited; i++) { const x = await http('POST', '/api/auth/recovery/start', { body: { handle: 'nobody-here', code: madeUp, contactCode: madeUp } }); if (x.status === 200) accepted++; else limited = x }
    const knownAfter = await http('POST', '/api/auth/recovery/start', { body: { handle: recoverme.handle, code: newCodes[0] ?? madeUp, contactCode: madeUp } })
    check('N29', 'recovery', 'recovery attempts from one address are cut off after ten in an hour, whatever the handle', 'V6.3.1 brute force; V2.4.1', '10 starts, then 429 too_many, also for a real handle', `${accepted} starts, then ${code(limited)}; a real handle then ${code(knownAfter)}`, accepted === 10 && limited?.status === 429 && limited.json?.error?.code === 'too_many' && knownAfter.status === 429)
  })

  // ------------------------------------------------------------------ business workspaces: tenants and roles
  await group('business', async () => {
    stale(boss)
    const createStale = await http('POST', '/api/workspaces', as(boss, { body: { name: 'Acme Traders' } }))
    await stepUp(boss, boss.auth)
    const acme = String(must(await http('POST', '/api/workspaces', as(boss, { body: { name: 'Acme Traders' } })), 'create Acme').id)
    must(await http('POST', '/api/household', as(boss, { body: {} })), 'Acme household')
    stale(boss)
    const addStale = await http('POST', '/api/workspace/members', as(boss, { body: { handle: appr.handle, role: 'approver' } }))
    const policyStale = await http('POST', '/api/workspace/policy', as(boss, { body: { makerChecker: true } }))
    await stepUp(boss, boss.auth)
    await addMembers(boss, acme, [[appr, 'approver'], [oper, 'operator'], [view, 'viewer']])
    await stepUp(boss, boss.auth) // the wait for the grants outlasts the five-minute confirmation on a slow run
    const raised = must(await http('POST', '/api/workspace/policy', as(boss, { body: { makerChecker: true } })), 'maker-checker on')
    check('N30', 'business', 'creating a business, adding a member and changing who must sign each need a fresh passkey confirmation', 'V7.5.3 further authentication', 'all three 401 stepup_required from a session with no recent confirmation; then done', `create ${code(createStale)}; add a member ${code(addStale)}; change the policy ${code(policyStale)}; after confirming: maker-checker applied ${String(raised.applied)}`, [createStale, addStale, policyStale].every((x) => x.status === 401 && x.json?.error?.code === 'stepup_required') && raised.applied === true)
    for (const p of [appr, oper, view]) must(await http('POST', `/api/workspaces/${acme}/switch`, as(p)), `${p.handle} switches to Acme`)
    // A second business, held by another person, with records of its own.
    await stepUp(attacker, attacker.auth)
    const rival = String(must(await http('POST', '/api/workspaces', as(attacker, { body: { name: 'Rival Imports' } })), 'create Rival').id)
    must(await http('POST', '/api/household', as(attacker, { body: {} })), 'Rival household')
    const rivalPayee = String(must(await http('POST', '/api/payees', as(attacker, { body: { name: 'Rival Supplier', handle: 'rival-supplier@upi', category: 'other', nameCheckAccepted: 'unknown' } })), 'Rival payee').id)
    const rivalProgram = String(must(await http('POST', '/api/programs', as(attacker, { body: { kind: 'floor', params: { buffer: 0 } } })), 'Rival draft').programId)
    const rivalApproval = String(must(await http('POST', `/api/programs/${rivalProgram}/approval`, as(attacker, { body: {} })), 'Rival approval').approvalId)

    // Roles: an operator prepares, a viewer looks, the maker cannot check their own request.
    const aProgram = String(must(await http('POST', '/api/programs', as(oper, { body: { kind: 'floor', params: { buffer: 0 } } })), 'operator draft').programId)
    const A = must(await http('POST', `/api/programs/${aProgram}/approval`, as(oper, { body: {} })), 'operator approval request')
    const operSign = await approve(oper, oper.auth, String(A.approvalId), String(A.docHash))
    const viewSign = await approve(view, view.auth, String(A.approvalId), String(A.docHash))
    const programsBefore = count('SELECT COUNT(*) n FROM programs WHERE user_id = ?', acme), payeesBefore = count('SELECT COUNT(*) n FROM payees WHERE user_id = ?', acme)
    const tries: [string, Res][] = [
      ['draft an instruction', await http('POST', '/api/programs', as(view, { body: { kind: 'floor', params: { buffer: 0 } } }))],
      ['ask for signatures', await http('POST', `/api/programs/${aProgram}/approval`, as(view, { body: {} }))],
      ['revoke an instruction', await http('POST', `/api/programs/${aProgram}/revoke`, as(view))],
      ['withdraw a request', await http('POST', `/api/approvals/${String(A.approvalId)}/cancel`, as(view))],
      ['add a payee', await http('POST', '/api/payees', as(view, { body: { name: 'Viewer pal', handle: 'pal@upi', category: 'other', nameCheckAccepted: 'unknown' } }))],
      ['add a bill', await http('POST', '/api/bills', as(view, { body: { payeeId: 'pye_x', amount: 1000, dueAt: Date.now() + 86_400_000 } }))],
      ['prepare a payment', await http('POST', '/api/actions/preview', as(view, { body: { kind: 'payment', purpose: 'spend', payeeId: 'pye_x', amount: 1000 } }))],
      ['record money in', await http('POST', '/api/money-in', as(view, { body: { amount: 1000 } }))],
      ['stop everything', await http('POST', '/api/stop', as(view, { body: { reason: 'viewer' } }))],
      ['undo a stop', await http('POST', '/api/stop/clear', as(view))],
      ['open the household again', await http('POST', '/api/household', as(view, { body: {} }))],
      ['change the profile', await http('PATCH', '/api/profile', as(view, { body: { spending: 1 } }))],
      ['add a member', await http('POST', '/api/workspace/members', as(view, { body: { handle: 'victim', role: 'viewer' } }))],
      ['change the policy', await http('POST', '/api/workspace/policy', as(view, { body: { signers: 1 } }))],
      ['start an earning job', await http('POST', '/api/earn/jobs', as(view, { body: { title: 'x', client: 'y' } }))],
      ['propose a vault action', await http('POST', '/api/vault/proposals', as(view, { body: { kind: 'pause' } }))],
    ]
    const look = await http('GET', '/api/home', as(view)), ws = await http('GET', '/api/workspace', as(view))
    check('N36', 'business', 'a viewer can look but cannot change anything, nor sign', 'V8.2.1 function-level access', `${tries.length} changes 403 not_permitted; signing 403 not_permitted; reading 200; nothing added`, `${tries.filter(([, x]) => x.status === 403 && x.json?.error?.code === 'not_permitted').length} of ${tries.length} refused 403${tries.filter(([, x]) => x.status !== 403).map(([n, x]) => `; ${n} ${code(x)}`).join('')}; signing ${code(viewSign.confirm)}; home ${code(look)}, role ${String(ws.json?.role)}; programs ${count('SELECT COUNT(*) n FROM programs WHERE user_id = ?', acme) - programsBefore} and payees ${count('SELECT COUNT(*) n FROM payees WHERE user_id = ?', acme) - payeesBefore} added`, tries.every(([, x]) => x.status === 403 && x.json?.error?.code === 'not_permitted') && viewSign.confirm?.status === 403 && viewSign.confirm.json?.error?.code === 'not_permitted' && look.status === 200 && ws.json?.role === 'viewer' && count('SELECT COUNT(*) n FROM programs WHERE user_id = ?', acme) === programsBefore && count('SELECT COUNT(*) n FROM payees WHERE user_id = ?', acme) === payeesBefore)
    const bProgram = String(must(await http('POST', '/api/programs', as(boss, { body: { kind: 'floor', params: { buffer: 0 } } })), 'owner draft').programId)
    const B = must(await http('POST', `/api/programs/${bProgram}/approval`, as(boss, { body: {} })), 'owner approval request')
    const makerSign = await approve(boss, boss.auth, String(B.approvalId), String(B.docHash))
    // The operator also tries the owner's request: there maker-checker does not apply, so only the role can refuse it.
    const operSignB = await approve(oper, oper.auth, String(B.approvalId), String(B.docHash))
    const checkerB = await approve(appr, appr.auth, String(B.approvalId), String(B.docHash))
    const checkerA = await approve(appr, appr.auth, String(A.approvalId), String(A.docHash))
    const sigsA = rows<{ person_id: string }>('SELECT person_id FROM approval_signatures WHERE approval_id = ?', String(A.approvalId)).map((x) => x.person_id)
    const sigsB = rows<{ person_id: string }>('SELECT person_id FROM approval_signatures WHERE approval_id = ?', String(B.approvalId)).map((x) => x.person_id)
    check('N35', 'business', 'an operator can prepare a request but cannot sign one, its own or another member\'s; an approver\'s signature then completes it', 'V8.2.1 function-level access', 'prepared 200; the operator\'s valid passkey signature 403 not_permitted on its own request and on the owner\'s; the approver\'s 200; one signature on each, the approver\'s', `prepared ${A.approvalId ? '200' : 'no'}; operator signs its own ${code(operSign.confirm)}, the owner's ${code(operSignB.confirm)}; approver signs ${code(checkerA.confirm)}; signatures on the operator's ${sigsA.map((x) => (x === appr.userId ? 'approver' : x === oper.userId ? 'operator' : x)).join(', ') || 'none'}, on the owner's ${sigsB.map((x) => (x === appr.userId ? 'approver' : x === oper.userId ? 'operator' : x === boss.userId ? 'owner' : x)).join(', ') || 'none'}`, operSign.begin.status === 200 && operSign.confirm?.status === 403 && operSign.confirm.json?.error?.code === 'not_permitted' && operSignB.confirm?.status === 403 && operSignB.confirm.json?.error?.code === 'not_permitted' && checkerA.confirm?.status === 200 && sigsA.length === 1 && sigsA[0] === appr.userId && !sigsB.includes(oper.userId) && confirmedAt(String(A.approvalId)) !== null)
    check('N37', 'business', 'with maker-checker, whoever prepared a request cannot sign it, even as owner; another member who may sign completes it', 'V2.3.5 multi-user approval', 'the owner\'s own signature 403 maker_cannot_sign; the approver\'s 200; one signature on record, the approver\'s', `owner (maker) signs ${code(makerSign.confirm)}; approver signs ${code(checkerB.confirm)} complete ${String(checkerB.confirm?.json?.complete)}; signatures ${sigsB.map((x) => (x === appr.userId ? 'approver' : x === boss.userId ? 'owner' : x)).join(', ') || 'none'}`, makerSign.confirm?.status === 403 && makerSign.confirm.json?.error?.code === 'maker_cannot_sign' && checkerB.confirm?.status === 200 && sigsB.length === 1 && sigsB[0] === appr.userId)

    // Tenants: nothing of one business is visible or signable from the other, or from a member's personal workspace.
    const ids = [rivalPayee, rivalProgram, rivalApproval, 'Rival Supplier']
    const fromAcme = await Promise.all(['/api/payees', '/api/programs', '/api/ledger?limit=200', '/api/activity', '/api/approvals/open', '/api/receipts'].map((p) => http('GET', p, as(boss))))
    const direct: [string, Res][] = [['Rival\'s instruction', await http('GET', `/api/programs/${rivalProgram}`, as(boss))], ['Rival\'s approval', await http('GET', `/api/approvals/${rivalApproval}`, as(boss))], ['Acme\'s instruction, from Rival', await http('GET', `/api/programs/${aProgram}`, as(attacker))], ['Acme\'s approval, from Rival', await http('GET', `/api/approvals/${String(A.approvalId)}`, as(attacker))]]
    must(await http('POST', `/api/workspaces/${appr.userId}/switch`, as(appr)), 'approver to personal')
    const personal = await Promise.all(['/api/programs', '/api/approvals/open', '/api/payees'].map((p) => http('GET', p, as(appr))))
    must(await http('POST', `/api/workspaces/${acme}/switch`, as(appr)), 'approver back to Acme')
    const leaks = fromAcme.filter((x) => ids.some((s) => x.text.includes(s))).length + personal.filter((x) => [aProgram, bProgram, String(A.approvalId)].some((s) => x.text.includes(s))).length
    check('N31', 'business', 'a member of one business cannot read another business\'s instructions, approvals, payees or books, and a member\'s personal workspace shows none of the business\'s', 'V8.4.1 cross-tenant isolation', 'four direct reads 404; no other business\'s id or name in 9 lists', `${direct.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}; ${leaks} lists with the other workspace's records (${[...new Set([...fromAcme, ...personal].map((x) => x.status))].join(',')})`, direct.every(([, x]) => x.status === 404) && leaks === 0 && [...fromAcme, ...personal].every((x) => x.status === 200))
    const own = must(await http('POST', '/api/auth/passkey/stepup/begin', as(boss)), 'owner step-up begin')
    const crossSign: [string, Res][] = [['ask for Rival\'s approval challenge', await http('POST', `/api/approvals/${rivalApproval}/passkey`, as(boss))], ['confirm Rival\'s approval with Acme\'s owner\'s passkey', await confirmWith(boss, rivalApproval, { challengeId: own.challengeId, response: boss.auth.get(own.options), docHash: 'f'.repeat(64) })], ['ask for Acme\'s approval challenge, from Rival', await http('POST', `/api/approvals/${String(B.approvalId)}/passkey`, as(attacker))]]
    check('N32', 'business', 'a member who may sign in one business cannot begin or complete a signature on another business\'s approval', 'V8.4.1 cross-tenant isolation', 'all 404; Rival\'s approval unsigned', `${crossSign.map(([n, x]) => `${n}: ${code(x)}`).join('; ')}; Rival's approval signatures ${count('SELECT COUNT(*) n FROM approval_signatures WHERE approval_id = ?', rivalApproval)}, confirmed ${confirmedAt(rivalApproval) ? 'yes' : 'no'}`, crossSign.every(([, x]) => x.status === 404) && count('SELECT COUNT(*) n FROM approval_signatures WHERE approval_id = ?', rivalApproval) === 0 && confirmedAt(rivalApproval) === null)
    const sw = [await http('POST', `/api/workspaces/${rival}/switch`, as(boss)), await http('POST', `/api/workspaces/${victim.userId}/switch`, as(boss))]
    const still = await http('GET', '/api/workspace', as(boss))
    check('N33', 'business', 'switching to a workspace the person is not a member of is refused: another business, or another person\'s own', 'V8.4.1 cross-tenant isolation; V8.2.2', 'both 404; the session still acts in Acme', `another business ${code(sw[0])}; another person's ${code(sw[1])}; acting in ${still.json?.id === acme ? 'Acme' : String(still.json?.id)}`, sw.every((x) => x.status === 404) && still.json?.id === acme)
    // The session row pointed at Rival directly in the scratch database, as if the switch check had been bypassed.
    write('UPDATE sessions SET workspace_id = ? WHERE user_id = ?', rival, boss.userId)
    const forged = await http('GET', '/api/workspace', as(boss)), forgedRead = await http('GET', `/api/approvals/${rivalApproval}`, as(boss)), forgedList = await http('GET', '/api/payees', as(boss))
    must(await http('POST', `/api/workspaces/${acme}/switch`, as(boss)), 'owner back to Acme')
    check('N34', 'business', 'a session pointed at a workspace its person does not belong to acts only in the person\'s own: membership is checked on every request', 'V8.3.1 authorization at a trusted layer', 'the workspace is the person\'s own; Rival\'s approval 404; no Rival payee listed', `acting in ${forged.json?.id === boss.userId ? 'the person\'s own workspace' : forged.json?.id === rival ? 'RIVAL' : String(forged.json?.id)} as ${String(forged.json?.role)}; Rival's approval ${code(forgedRead)}; Rival payee listed ${forgedList.text.includes('Rival Supplier') ? 'yes' : 'no'}`, forged.json?.id === boss.userId && forgedRead.status === 404 && !forgedList.text.includes('Rival Supplier'))

    // Lowering the policy reduces protection: it waits, and the members who may sign must be able to stop it.
    await stepUp(boss, boss.auth)
    const lowering = await http('POST', '/api/workspace/policy', as(boss, { body: { makerChecker: false } }))
    const policyNow = (await http('GET', '/api/workspace', as(boss))).json?.policy
    check('N38', 'business', 'lowering who must sign (maker-checker off) does not take effect at once: it is scheduled for after the delay', 'V2.3.5 multi-user approval; V7.5.3', 'applied false with a time; maker-checker still on', `${code(lowering)} applied ${String(lowering.json?.applied)}, effective +${Math.round((Number(lowering.json?.effectiveAt ?? 0) - Date.now()) / 1000)} s; maker-checker now ${String(policyNow?.makerChecker)}`, lowering.status === 200 && lowering.json?.applied === false && policyNow?.makerChecker === true)
    const change = rows<{ id: string }>(`SELECT id FROM scheduled_changes WHERE kind = 'lower-policy' AND workspace_id = ? AND cancelled_at IS NULL AND applied_at IS NULL`, acme)[0]?.id ?? ''
    const ownerSees = ((must(await http('GET', '/api/security', as(boss)), 'owner security').scheduled ?? []) as { id: string }[]).some((x) => x.id === change)
    const apprSec = must(await http('GET', '/api/security', as(appr)), 'approver security')
    const apprSees = ((apprSec.scheduled ?? []) as { id: string }[]).some((x) => x.id === change) || JSON.stringify(must(await http('GET', '/api/workspace', as(appr)), 'approver workspace')).includes(change)
    const apprEvent = ((apprSec.events ?? []) as { kind: string; detail: Record<string, unknown> }[]).find((e) => e.kind === 'policy-lowering-scheduled')
    await stepUp(appr, appr.auth)
    const apprCancel = await http('POST', `/api/security/changes/${change}/cancel`, as(appr))
    check('N39', 'business', 'every member who may sign can see a scheduled lowering of the policy and cancel it (as the workspace screen and server/workspaces.ts say)', 'V2.3.5 multi-user approval', 'the approver\'s security view or workspace lists the change with its id; the approver\'s cancel 200', `requester sees it ${ownerSees ? 'yes' : 'no'}; approver sees it ${apprSees ? 'yes' : 'NO'}; approver's events: ${apprEvent ? `"${apprEvent.kind}" with ${Object.keys(apprEvent.detail).join(', ')} (no change id)` : 'none'}; approver's cancel with the id taken from the database: ${code(apprCancel)}`, apprSees && apprCancel.status === 200)
    // A membership ended directly in the scratch database (there is no route to remove a member yet).
    write('UPDATE memberships SET removed_at = ? WHERE workspace_id = ? AND person_id = ?', Date.now(), acme, view.userId)
    const gone = await http('GET', '/api/workspace', as(view)), goneRead = await http('GET', `/api/approvals/${String(A.approvalId)}`, as(view)), goneBack = await http('POST', `/api/workspaces/${acme}/switch`, as(view))
    check('N40', 'business', 'a member whose membership ends loses access at once, in the middle of a session', 'V8.3.2 authorization changes apply immediately', 'the session acts in the person\'s own workspace; Acme\'s approval 404; switching back 404', `acting in ${gone.json?.id === view.userId ? 'their own workspace' : gone.json?.id === acme ? 'ACME' : String(gone.json?.id)}; Acme's approval ${code(goneRead)}; switch back ${code(goneBack)}`, gone.json?.id === view.userId && goneRead.status === 404 && goneBack.status === 404)
  })

  // ------------------------------------------------------------------ the books, the challenges and the error output after all of that
  // ------------------------------------------------------------------ the emergency pause and the signing window (R12 task comparison)
  await group('emergency', async () => {
    // accounts made earlier in this run (the address's sign-up allowance is spent): a saved code pauses QED from the
    // signed-out page; first, so that the address's shared recovery allowance still has room
    const lost = thrifty
    // the pause shares the address's recovery allowance, which the recovery checks above have spent: first shown, then
    // cleared as an hour later would leave it (a harness write), so that the three answers below can be compared
    const spentAllowance = await http('POST', '/api/auth/pause-with-code', { body: { handle: lost.handle, code: 'AAAA-BBBB-CCCC-DDDD' } })
    write("DELETE FROM rate_limits WHERE key LIKE 'recovery:%'")
    const sessionsBefore = count('SELECT COUNT(*) n FROM sessions')
    const timed = async (body: unknown): Promise<[Res, number]> => { const t = Date.now(); const r = await http('POST', '/api/auth/pause-with-code', { body }); return [r, Date.now() - t] }
    const [wrong, tWrong] = await timed({ handle: lost.handle, code: 'AAAA-BBBB-CCCC-DDDD' })
    const [unknown, tUnknown] = await timed({ handle: 'nobody-at-all', code: 'AAAA-BBBB-CCCC-DDDD' })
    const pausedByWrong = count('SELECT COUNT(*) n FROM users WHERE id = ? AND stop_at IS NOT NULL', lost.userId)
    const [right, tRight] = await timed({ handle: lost.handle, code: lost.codes[0] })
    const st = rows<{ stop_at: number | null; stop_protective: number }>('SELECT stop_at, stop_protective FROM users WHERE id = ?', lost.userId)[0]!
    const spent = count('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NOT NULL', lost.userId)
    const same = [wrong, unknown, right].every((r) => r.status === 200 && r.text === right.text)
    const slowest = Math.min(tWrong, tUnknown, tRight)
    check('N49', 'emergency', 'a saved code pauses QED from the signed-out page: all but protective selling, no session opened, the code not spent; a wrong code or an unknown handle changes nothing; the same answer each way, never sooner than the floor', 'V6.4.3 recovery with a saved code; V2.4 anti-automation; V6.3.8 no account enumeration',
      'with the shared allowance spent, 429; then the same 200 answer three times, each at least 440 ms; paused only by the right code, protective selling kept; no new session; no code spent',
      `with the address's allowance spent ${code(spentAllowance)}; then ${[wrong, unknown, right].map(code).join(', ')}; same body ${same}; fastest ${slowest} ms; paused by the wrong code ${pausedByWrong}; after the right one stop_at ${st.stop_at !== null} protective ${st.stop_protective}; sessions ${count('SELECT COUNT(*) n FROM sessions') - sessionsBefore} new; codes spent ${spent}`,
      spentAllowance.status === 429 && same && slowest >= 440 && pausedByWrong === 0 && st.stop_at !== null && st.stop_protective === 1 && count('SELECT COUNT(*) n FROM sessions') === sessionsBefore && spent === 0)

    // signing out every other session ends this person's other sessions only, though another member shares a workspace with them
    const two = oper
    const second = await signIn(two.auth)
    const bystander = appr
    const ended = await http('POST', '/api/security/sessions/end-others', { cookie: second.cookie, csrf: second.csrf })
    const [firstNow, secondNow, bystanderNow] = await Promise.all([two.cookie, second.cookie, bystander.cookie].map((c) => http('GET', '/api/session', { cookie: c })))
    check('N50', 'emergency', 'signing out every other session ends the person\'s other sessions only: the one asking stays signed in and nobody else\'s session ends', 'V7.4.3 terminate other sessions; V8.2.2 data-specific access',
      '200, one ended; the first session signed out; the asking session and a bystander\'s still signed in',
      `${code(ended)} ended ${String(ended.json?.ended)}; first ${String(firstNow!.json?.authenticated)}, asking ${String(secondNow!.json?.authenticated)}, bystander ${String(bystanderNow!.json?.authenticated)}`,
      ended.status === 200 && ended.json?.ended === 1 && firstNow!.json?.authenticated === false && secondNow!.json?.authenticated === true && bystanderNow!.json?.authenticated === true)

    // keeping a request open: the same document, for its own household only, the first withdrawn, never a lapsed one
    const keeper = spender
    const payee = must(await http('POST', '/api/payees', as(keeper, { body: { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'other' } })), 'payee for keeper')
    const pv = must(await http('POST', '/api/actions/preview', as(keeper, { body: { kind: 'payment', purpose: 'spend', amount: 50_000, payeeId: payee.id } })), 'preview for keeper')
    const other = attacker
    const foreign = await http('POST', `/api/approvals/${String(pv.approvalId)}/renew`, as(other))
    const renewed = await http('POST', `/api/approvals/${String(pv.approvalId)}/renew`, as(keeper))
    const fresh = renewed.json ?? {}
    const oldSigned = await approve(keeper, keeper.auth, String(pv.approvalId), String(pv.docHash))
    const newSigned = await approve(keeper, keeper.auth, String(fresh.approvalId), String(fresh.docHash))
    const pv2 = must(await http('POST', '/api/actions/preview', as(keeper, { body: { kind: 'payment', purpose: 'spend', amount: 60_000, payeeId: payee.id } })), 'second preview for keeper')
    write('UPDATE approvals SET expires_at = ? WHERE id = ?', Date.now() - 1000, String(pv2.approvalId)) // what ten minutes would leave
    const lapsed = await http('POST', `/api/approvals/${String(pv2.approvalId)}/renew`, as(keeper))
    check('N51', 'emergency', 'keeping a request open gives the same document a fresh request for its own household only; the first is withdrawn and its signature covers nothing; a lapsed request cannot be revived', 'V8.2.2 data-specific access; V2.3.4 single use',
      'another household 404; renewal 200 with the same document hash; the first refused at confirmation, the fresh one confirmed; a lapsed one 409 approval_expired',
      `other ${code(foreign)}; renew ${code(renewed)} same hash ${String(fresh.docHash === pv.docHash)}; first ${code(oldSigned.confirm)}; fresh ${code(newSigned.confirm)}; lapsed ${code(lapsed)}`,
      foreign.status === 404 && renewed.status === 200 && fresh.docHash === pv.docHash && fresh.approvalId !== pv.approvalId && oldSigned.confirm?.status !== 200 && newSigned.confirm?.status === 200 && lapsed.status === 409 && lapsed.json?.error?.code === 'approval_expired')

    // a recovery contact pauses QED for the person who trusts them, with their own fresh passkey; a stranger cannot
    const stranger = attacker
    await stepUp(stranger, stranger.auth)
    const byStranger = await http('POST', `/api/security/contacts/${contactLink}/pause`, as(stranger))
    stale(friend)
    const unconfirmed = await http('POST', `/api/security/contacts/${contactLink}/pause`, as(friend))
    await stepUp(friend, friend.auth)
    const byContact = await http('POST', `/api/security/contacts/${contactLink}/pause`, as(friend))
    const theirs = rows<{ stop_at: number | null; stop_protective: number }>('SELECT stop_at, stop_protective FROM users WHERE id = ?', recoverme.userId)[0]!
    check('N52', 'emergency', 'a recovery contact pauses QED for the person who trusts them only with their own fresh passkey, keeping protective selling; a stranger cannot', 'V8.2.2 data-specific access; V6.3 recovery contacts',
      'stranger 404; contact without a fresh confirmation 401 stepup_required; with it 200, the person paused with protective selling kept',
      `stranger ${code(byStranger)}; unconfirmed ${code(unconfirmed)}; confirmed ${code(byContact)}; their stop ${theirs.stop_at !== null} protective ${theirs.stop_protective}`,
      byStranger.status === 404 && unconfirmed.status === 401 && unconfirmed.json?.error?.code === 'stepup_required' && byContact.status === 200 && theirs.stop_at !== null && theirs.stop_protective === 1)
  })

  // ------------------------------------------------------------------ R13: one check for each finding the R13 review confirmed
  // (docs/SECURITY-REVIEW-R13.md). Each was seen to fail on the reviewed revision 99dd3e4 before its fix. The address's
  // sign-in allowances, spent by the checks above, are cleared once here (a harness write: what fifteen minutes would do).
  write("DELETE FROM rate_limits WHERE key LIKE 'login:%' OR key LIKE 'passkey-login:%'")
  const letters = 'abcdefghjkmnpqstuwxyz'
  const rnd = (n: number): string => Array.from(randomBytes(n), (b) => letters[b % letters.length]).join('')

  await group('r13-sessions', async () => {
    // R02: ten wrong passwords sent together were counted as one, so the account never locked
    const lock = await legacyAccount('r13lock')
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => passwordSignIn(lock.handle, `wrong-guess-${i}-zz`)))
    const right = await passwordSignIn(lock.handle, lock.password)
    check('R02', 'r13', 'ten wrong passwords sent together lock the account as five sent one by one do', 'V6.3.1 brute force; V2.4.1 anti-automation',
      'the right password afterwards 429 locked', `burst ${[...new Set(burst.map(code))].join(', ')}; then the right password ${code(right)}`,
      right.status === 429 && right.json?.error?.code === 'locked')

    // R03: a session opened with a (possibly phished) password ended the owner's passkey sessions, again and again
    const weak = await signInPassword(await legacyAccount('r13weak'))
    must(await http('POST', '/api/auth/stepup', as(weak, { body: { password: weak.password } })), 'password re-entry before adding a first passkey')
    const ab = must(await http('POST', '/api/security/passkeys/begin', as(weak)), 'add a passkey: begin')
    const wauth = authenticator()
    must(await http('POST', '/api/security/passkeys/finish', as(weak, { body: { challengeId: ab.challengeId, response: wauth.create(ab.options) } })), 'add a passkey: finish')
    const strong1 = await signIn(wauth), strong2 = await signIn(wauth)
    const endAll = await http('POST', '/api/security/sessions/end-others', as(weak))
    const endOne = await http('POST', `/api/security/sessions/${sha256hex(strong2.cookie.split('=')[1]!).slice(0, 12)}/revoke`, as(weak))
    const [s1Now, s2Now] = await Promise.all([strong1.cookie, strong2.cookie].map((c) => http('GET', '/api/session', { cookie: c })))
    const fromStrong = await http('POST', '/api/security/sessions/end-others', { cookie: strong1.cookie, csrf: strong1.csrf })
    const weakNow = await http('GET', '/api/session', { cookie: weak.cookie })
    check('R03', 'r13', 'a password session cannot end a session opened with a passkey that can approve; that passkey session can end the password session', 'V7.4.3; V6.3.4 consistent strength across pathways',
      'end-others 200 leaving both passkey sessions signed in; ending one of them 401 stepup_required; from the passkey session, the password session ends',
      `end-others ${code(endAll)} ended ${String(endAll.json?.ended)}; end one ${code(endOne)}; passkey sessions ${String(s1Now!.json?.authenticated)}, ${String(s2Now!.json?.authenticated)}; from a passkey session ${code(fromStrong)} ended ${String(fromStrong.json?.ended)}, password session now ${String(weakNow.json?.authenticated)}`,
      endAll.status === 200 && endOne.status === 401 && s1Now!.json?.authenticated === true && s2Now!.json?.authenticated === true && fromStrong.status === 200 && weakNow.json?.authenticated === false)

    // R04: every signed-out "begin" wrote a challenge row that nothing ever removed
    const lb = must(await http('POST', '/api/auth/passkey/login/begin', { body: {} }), 'sign-in begin')
    write('UPDATE webauthn_challenges SET created_at = created_at - 7200000, expires_at = expires_at - 7200000 WHERE id = ?', String(lb.challengeId)) // what two hours would leave
    must(await http('POST', '/api/auth/passkey/login/begin', { body: {} }), 'a later sign-in begin')
    const left = count('SELECT COUNT(*) n FROM webauthn_challenges WHERE id = ?', String(lb.challengeId))
    check('R04', 'r13', 'challenges that expired long ago are removed, so signed-out requests cannot grow the database without bound', 'V2.4.1 anti-automation; V15.2.2 resource limits',
      'the two-hour-old challenge gone after the next begin', `${left} row left`, left === 0)
  })

  await group('r13-links', async () => {
    // R05: a reset link sent to an address kept working after the owner removed that address
    const lr = await signInPassword(await legacyAccount('r13reset'))
    must(await http('POST', '/api/auth/stepup', as(lr, { body: { password: lr.password } })), 'password re-entry before adding an address')
    const mailbox = 'r13-old-mailbox@example.test'
    const added = must(await http('POST', '/api/security/addresses', as(lr, { body: { kind: 'email', address: mailbox } })), 'add an address')
    const six = /page: (\d{6})/.exec(rows<{ body: string }>(`SELECT body FROM outbound_messages WHERE to_address = ? AND purpose = 'verify-email' ORDER BY created_at DESC LIMIT 1`, mailbox)[0]?.body ?? '')?.[1]
    must(await http('POST', `/api/security/addresses/${String(added.id)}/confirm`, as(lr, { body: { code: six } })), 'confirm the address')
    await sleep((DELAY_SEC + 1) * 1000) // an address starts a reset only after the protection delay
    must(await http('POST', '/api/auth/password/forgot', { body: { identifier: lr.handle } }), 'ask for a reset')
    const token = /#token=([A-Za-z0-9_-]+)/.exec(rows<{ body: string }>(`SELECT body FROM outbound_messages WHERE to_address = ? AND purpose = 'password-reset' ORDER BY created_at DESC LIMIT 1`, mailbox)[0]?.body ?? '')?.[1] ?? ''
    const before = await http('POST', '/api/auth/password/reset/state', { body: { token } })
    const removed = await http('POST', `/api/security/addresses/${String(added.id)}/remove`, as(lr))
    // R14 (SECURITY.md 8j (c)): removing a confirmed address is a removal of a way back in, so it waits the protection
    // delay (DELAY_SEC here) and the engine applies it; the address, and the link sent to it, stay until then
    const during = await http('POST', '/api/auth/password/reset/state', { body: { token } })
    await sleep((DELAY_SEC + 2) * 1000)
    must(await http('GET', '/api/security', as(lr)), 'read Security once the removal is due')
    const after = await http('POST', '/api/auth/password/reset/state', { body: { token } })
    const reset = await http('POST', '/api/auth/password/reset', { body: { token, password: 'Lantern-Harbour-6620', confirm: 'Lantern-Harbour-6620' } })
    check('R05', 'r13', 'removing an address stops the reset link already sent to it, when the removal takes effect', 'V6.4.1 recovery secrets; V6.4.3 reset not usable by a former channel',
      'the link works before; removal 200, scheduled; the link works while it waits; once it applies, the link 410 and the reset refused', `before ${code(before)}; removal ${code(removed)}${removed.json?.scheduled === true ? ' scheduled' : ''}; during ${code(during)}; after ${code(after)}; reset ${code(reset)}`,
      before.status === 200 && removed.status === 200 && removed.json?.scheduled === true && during.status === 200 && after.status === 410 && reset.status === 410)
  })

  await group('r13-business', async () => {
    // a business with an owner, an approver and an operator; "From ₹10,000: 2 signatures"
    await stepUp(boss, boss.auth)
    const co = String(must(await http('POST', '/api/workspaces', as(boss, { body: { name: 'R13 Signatures Co' } })), 'create R13 Co').id)
    must(await http('POST', '/api/household', as(boss, { body: {} })), 'R13 Co household')
    await addMembers(boss, co, [[appr, 'approver'], [oper, 'operator']])
    await stepUp(boss, boss.auth)
    const op = await signIn(oper.auth) // the operator's first session was ended by N50
    for (const s of [appr, op]) must(await http('POST', `/api/workspaces/${co}/switch`, as(s)), 'a member switches to R13 Co')
    must(await http('POST', '/api/workspace/policy', as(boss, { body: { largePaise: 1_000_000, largeSigners: 2 } })), 'the large-amount rule')
    const payee = must(await http('POST', '/api/payees', as(boss, { body: { name: 'Big Supplier', handle: 'big.supplier@okaxis', category: 'other', nameCheckAccepted: 'unknown' } })), 'R13 Co payee')
    const signOnce = async (p: Person, programId: string): Promise<Res | null> => { const a = must(await http('POST', `/api/programs/${programId}/approval`, as(p, { body: {} })), 'approval request'); return (await approve(p, p.auth, String(a.approvalId), String(a.docHash))).confirm }

    // R06: an instruction that can move far more than the threshold was put in force by one signature
    const big = String(must(await http('POST', '/api/programs', as(boss, { body: { kind: 'bills', params: { payeeHandles: [payee.handle], capPerBill: 1_000_000 } } })), 'a large bills instruction').programId)
    const bigSigned = await signOnce(boss, big)
    check('R06', 'r13', 'an instruction that can move more than the business\'s large-amount threshold needs the large-amount number of signatures', 'V8.2.1 function-level access; V2.3.5 multi-party approval',
      'the first signature 200 with complete false and 2 required', `${code(bigSigned)} complete ${String(bigSigned?.json?.complete)}, required ${String(bigSigned?.json?.required)}`,
      bigSigned?.status === 200 && bigSigned.json?.complete === false && bigSigned.json?.required === 2)

    // R11: an operator, who may prepare but not sign, resumed what the owner paused and revoked a protective instruction
    const putInForce = async (programId: string): Promise<void> => {
      const first = await signOnce(boss, programId)
      if (first?.json?.complete === false) { const a = rows<{ id: string; doc_hash: string }>('SELECT id, doc_hash FROM approvals WHERE subject LIKE ? AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1', `program:${programId}@%`)[0]!; must((await approve(appr, appr.auth, a.id, a.doc_hash)).confirm ?? { status: 0, headers: {}, text: 'not sent', json: null }, 'second signature') }
      if (count(`SELECT COUNT(*) n FROM programs WHERE id = ? AND state = 'active'`, programId) === 0) { const a = rows<{ id: string }>('SELECT id FROM approvals WHERE subject LIKE ? AND confirmed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1', `program:${programId}@%`)[0]!; must(await http('POST', `/api/programs/${programId}/activate`, as(boss, { body: { approvalId: a.id } })), 'activate') }
    }
    const small = String(must(await http('POST', '/api/programs', as(boss, { body: { kind: 'bills', params: { payeeHandles: [payee.handle], capPerBill: 10_000 } } })), 'a small bills instruction').programId)
    await putInForce(small)
    must(await http('POST', `/api/programs/${small}/pause`, as(boss)), 'the owner pauses it')
    const resumed = await http('POST', `/api/programs/${small}/resume`, as(op))
    const floor = String(must(await http('POST', '/api/programs', as(boss, { body: { kind: 'floor', params: { buffer: 0 } } })), 'a floor instruction').programId)
    await putInForce(floor)
    const revoked = await http('POST', `/api/programs/${floor}/revoke`, as(op))
    const states = rows<{ id: string; state: string }>('SELECT id, state FROM programs WHERE id IN (?, ?)', small, floor)
    const stateOf = (id: string): string => states.find((s) => s.id === id)?.state ?? 'missing'
    check('R11', 'r13', 'an operator cannot resume an instruction the owner paused, nor revoke a protective one', 'V8.2.1 function-level access; V8.2.3 field-level access',
      'both 403 not_permitted; the instruction still paused and the floor still active', `resume ${code(resumed)}; revoke the floor ${code(revoked)}; now ${stateOf(small)} and ${stateOf(floor)}`,
      resumed.status === 403 && revoked.status === 403 && stateOf(small) === 'paused' && stateOf(floor) === 'active')

    // X03 (Q-059, decided in the R13 hardening brief): resuming a paused instruction needs a fresh passkey confirmation, never a
    // passkey session alone. The owner's session was opened with a passkey; its confirmation is made old, then made again.
    stale(boss)
    const resumeStale = await http('POST', `/api/programs/${small}/resume`, as(boss))
    const stillPaused = count(`SELECT COUNT(*) n FROM programs WHERE id = ? AND state = 'paused'`, small)
    await stepUp(boss, boss.auth)
    const resumeFresh = await http('POST', `/api/programs/${small}/resume`, as(boss))
    check('X03', 'r13-hardening', 'resuming a paused instruction needs a fresh passkey confirmation, from a session opened with a passkey too (Q-059)', 'V7.5.3 further authentication for sensitive operations',
      '401 stepup_required with no recent confirmation (still paused); 200 after a passkey step-up', `without ${code(resumeStale)} (still paused: ${stillPaused === 1}); after a step-up ${code(resumeFresh)}`,
      resumeStale.status === 401 && resumeStale.json?.error?.code === 'stepup_required' && stillPaused === 1 && resumeFresh.status === 200)

    // R07: a scheduled lowering of the policy wrote back the whole policy of its day, undoing a raise made meanwhile
    await stepUp(boss, boss.auth)
    const lowered = await http('POST', '/api/workspace/policy', as(boss, { body: { largePaise: 2_000_000 } }))
    const raised = await http('POST', '/api/workspace/policy', as(boss, { body: { signers: 2 } }))
    await sleep((DELAY_SEC + 1) * 1000)
    await http('GET', '/api/security', as(boss)) // applies what has fallen due
    const pol = (await http('GET', '/api/workspace', as(boss))).json?.policy ?? {}
    check('R07', 'r13', 'a lowering of the signing policy that falls due does not undo a raise made while it waited', 'V8.1.4 business rules; V2.3.2 workflow integrity',
      'lowering scheduled, raise applied; after the delay 2 signers still required', `lowering ${code(lowered)} applied ${String(lowered.json?.applied)}; raise ${code(raised)} applied ${String(raised.json?.applied)}; now ${JSON.stringify(pol)}`,
      lowered.json?.applied === false && raised.json?.applied === true && pol.signers === 2)
    // R01: "sign out everywhere" from a session acting in a business workspace ended nobody (it used the workspace's id)
    const member = { ...op, userId: oper.userId }
    const other = await signIn(oper.auth)
    await stepUp(member, oper.auth)
    const all = await http('POST', '/api/auth/logout-everywhere', as(member))
    const [otherNow, selfNow] = await Promise.all([other.cookie, member.cookie].map((c) => http('GET', '/api/session', { cookie: c })))
    check('R01', 'r13', 'signing out everywhere from a session that acts in a business workspace ends every session of the person', 'V7.4.3 terminate all sessions',
      '200 with at least 2 ended; the other session and this one signed out', `${code(all)} ended ${String(all.json?.ended)}; other ${String(otherNow!.json?.authenticated)}, this ${String(selfNow!.json?.authenticated)}`,
      all.status === 200 && Number(all.json?.ended) >= 2 && otherNow!.json?.authenticated === false && selfNow!.json?.authenticated === false)
  })

  await group('r13-instructions', async () => {
    const sp = spender
    // R08: a signature given for an amendment before the instruction was revoked put it back in force afterwards
    const x = String(must(await http('POST', '/api/programs', as(sp, { body: { kind: 'floor', params: { buffer: 0 } } })), 'floor draft').programId)
    const a1 = must(await http('POST', `/api/programs/${x}/approval`, as(sp, { body: {} })), 'approval 1')
    must((await approve(sp, sp.auth, String(a1.approvalId), String(a1.docHash))).confirm ?? { status: 0, headers: {}, text: 'not sent', json: null }, 'signature 1')
    must(await http('POST', `/api/programs/${x}/activate`, as(sp, { body: { approvalId: a1.approvalId } })), 'activation')
    must(await http('POST', `/api/programs/${x}/draft`, as(sp, { body: { params: { buffer: 100_000 } } })), 'an amendment')
    const a2 = must(await http('POST', `/api/programs/${x}/approval`, as(sp, { body: {} })), 'approval 2')
    const s2 = await approve(sp, sp.auth, String(a2.approvalId), String(a2.docHash))
    const rev = await http('POST', `/api/programs/${x}/revoke`, as(sp))
    const revived = await http('POST', `/api/programs/${x}/activate`, as(sp, { body: { approvalId: a2.approvalId } }))
    const xs = rows<{ state: string }>('SELECT state FROM programs WHERE id = ?', x)[0]?.state
    check('R08', 'r13', 'a revoked instruction stays revoked: an amendment signed before the revocation cannot put it back in force', 'V2.3.2 workflow integrity; V2.3.1 steps in order',
      'amendment signed 200; revoke 200; activation 409; still revoked', `signed ${code(s2.confirm)}; revoke ${code(rev)}; activation ${code(revived)}; state ${String(xs)}`,
      s2.confirm?.status === 200 && rev.status === 200 && revived.status === 409 && xs === 'revoked')

    // R09: a payment refunded after one dispute could be disputed again, and was refunded again each time
    const shop = must(await http('POST', '/api/payees', as(sp, { body: { name: 'Refund Shop', handle: 'refund.shop@upi', category: 'other', lookalikeChecked: true, nameCheckAccepted: 'unknown' } })), 'refund payee')
    const pv = await preview(sp, String(shop.id), 100_000)
    must((await approve(sp, sp.auth, pv.approvalId, pv.docHash)).confirm ?? { status: 0, headers: {}, text: 'not sent', json: null }, 'payment signature')
    const act = String(must(await http('POST', '/api/actions', as(sp, { body: { approvalId: pv.approvalId } })), 'payment sent').id)
    for (let i = 0; i < 40 && rows<{ state: string }>('SELECT state FROM actions WHERE id = ?', act)[0]?.state !== 'done'; i++) await sleep(500)
    const resolve = async (): Promise<void> => { write(`UPDATE disputes SET created_at = created_at - 120000 WHERE action_id = ? AND state = 'open'`, act); for (let i = 0; i < 80 && count(`SELECT COUNT(*) n FROM disputes WHERE action_id = ? AND state = 'open'`, act) > 0; i++) await sleep(500) } // what the review minute would leave
    const d1 = await http('POST', `/api/actions/${act}/dispute`, as(sp, { body: { reason: 'The goods never arrived.' } }))
    await resolve()
    const d2 = await http('POST', `/api/actions/${act}/dispute`, as(sp, { body: { reason: 'Still never arrived.' } }))
    if (d2.status === 200) await resolve()
    const refunds = count(`SELECT COUNT(*) n FROM entries WHERE user_id = ? AND kind = 'dispute-refund' AND json_extract(meta_json, '$.actionId') = ?`, sp.userId, act)
    check('R09', 'r13', 'a payment is refunded at most once: after a refund it cannot be disputed again', 'V2.3.4 business-logic limits; V15.4.2',
      'first dispute 200 and refunded once; a second dispute 409', `first ${code(d1)}; second ${code(d2)}; refunds ${refunds}`, d1.status === 200 && d2.status === 409 && refunds === 1)
  })

  await group('r13-load', async () => {
    // R10: the look-alike check compared every named payee with every other, each pair in about 0.2 ms, on the API's thread
    const ds = await signInPassword(await legacyAccount('r13dos'))
    must(await http('POST', '/api/household', as(ds, { body: {} })), 'household')
    const handles: string[] = []
    for (let i = 0; i < 120; i++) { const h = `${rnd(40)}@${rnd(20)}`; handles.push(h); must(await http('POST', '/api/payees', as(ds, { body: { name: rnd(58), handle: h, category: 'other', lookalikeChecked: true, nameCheckAccepted: 'unknown' } })), `payee ${i}`) }
    const timedPreview = async (hs: string[]): Promise<[Res, number, number]> => {
      const t0 = Date.now()
      const [r, healthMs] = await Promise.all([http('POST', '/api/programs/preview', as(ds, { body: { kind: 'bills', params: { payeeHandles: hs, capPerBill: 10_000 } } })), (async () => { await sleep(100); const t = Date.now(); await http('GET', '/api/health'); return Date.now() - t })()])
      return [r, Date.now() - t0, healthMs]
    }
    const [fifty, tFifty, hFifty] = await timedPreview(handles.slice(0, 50))
    const [many, tMany, hMany] = await timedPreview(handles)
    check('R10', 'r13', 'a bills instruction naming 50 of 120 payees is checked for look-alikes in under 0.5 s without holding up others; one naming all 120 is refused at once', 'V15.2.2 resource limits; V2.4.1',
      '50: 200 within 500 ms, health within 500 ms; 120: 400 within 500 ms', `50: ${code(fifty)} in ${tFifty} ms, health waited ${hFifty} ms; 120: ${code(many)} in ${tMany} ms, health waited ${hMany} ms`,
      fifty.status === 200 && tFifty < 500 && hFifty < 500 && many.status === 400 && tMany < 500)

    // R13: one certificate check at the endpoint's largest size held the API's thread for about 2.4 s
    const big = { type: 'cvar', as_of: '2026-11-24', base_currency: 'INR', level: 0.95, horizon_end: '2026-12-24', threshold: 0.1, holdings: [{ id: 'h', value_minor: 1_000_000, currency: 'INR', kind: 'equity_fund' }], accept: ['by_construction', 'model_bound'], scenario_returns: Array.from({ length: 1200 }, (_, i) => (i % 2 ? -0.05 : 0.04)), window: 1176, bootstrap_reps: 5000, seed: 1, model: 'hs' }
    const t0 = Date.now()
    const [cert, certHealth] = await Promise.all([http('POST', '/api/lab/certificates/check', as(ds, { body: big })), (async () => { await sleep(50); const t = Date.now(); await http('GET', '/api/health'); return Date.now() - t })()])
    const tCert = Date.now() - t0
    const usual = await http('POST', '/api/lab/certificates/check', as(ds, { body: { ...big, window: 120, bootstrap_reps: 2000 } }))
    check('R13', 'r13', 'a certificate check cannot hold the API\'s thread for seconds: the largest bootstrap is refused at once, the usual size still runs', 'V15.2.2 resource limits; V2.4.1',
      'largest 400 within 500 ms, health within 500 ms; usual size 200', `largest ${code(cert)} in ${tCert} ms, health waited ${certHealth} ms; usual ${code(usual)}`,
      cert.status === 400 && tCert < 500 && certHealth < 500 && usual.status === 200)

    // R12: a malformed percent-encoding in a page path threw on the static side: a 500 and a stack trace per request
    const errorsBefore = serverErrors.length
    const malformed = await http('GET', '/%E0%A4%A', { host: `localhost:${port}` })
    check('R12', 'r13', 'a malformed path on the static side is a 400, with nothing on the error output', 'V16.5.3 fails securely; V4.1.1',
      '400 and no new server error', `${code(malformed)}; ${serverErrors.length - errorsBefore} new server error line(s)`, malformed.status === 400 && serverErrors.length === errorsBefore)
  })

  // ------------------------------------------------------------------------------------------ R13 second pass: leads
  // The leads of docs/SECURITY-REVIEW-R13.md section 4 that were confirmed (R15, R22 to R25 here over HTTP; R16 to R21
  // and R26 below, in process), and F-14 (R14, below). Each failed on the revision before its fix.
  await group('r13-leads', async () => {
    // a business of its own for these checks: boss owns it, appr approves, oper prepares
    await stepUp(boss, boss.auth)
    const lc = String(must(await http('POST', '/api/workspaces', as(boss, { body: { name: 'R13 Leads Co' } })), 'create R13 Leads Co').id)
    must(await http('POST', '/api/household', as(boss, { body: {} })), 'R13 Leads Co household')
    await addMembers(boss, lc, [[appr, 'approver'], [oper, 'operator']])
    await stepUp(boss, boss.auth)
    const ap = { ...(await signIn(appr.auth)), userId: appr.userId }, op = { ...(await signIn(oper.auth)), userId: oper.userId }
    for (const s of [ap, op]) must(await http('POST', `/api/workspaces/${lc}/switch`, as(s)), 'a member switches to R13 Leads Co')
    const t = Date.now()

    // Harness write: a model call of boss's with two proposals, as server/ai.ts stores them (the stack has no model).
    write(`INSERT INTO conversations (id, user_id, person_id, title, created_at, updated_at) VALUES ('cnv_r13lead', ?, ?, 'Boss asks', ?, ?)`, lc, boss.userId, t, t)
    write(`INSERT INTO ai_calls (id, user_id, ts, provider, model, question, context_hash, ok, conversation_id, output_json) VALUES ('aic_r13lead', ?, ?, 'scripted', 'harness', 'Pay Hidden Vendor quietly before the audit', 'h', 1, 'cnv_r13lead', '{}')`, lc, t)
    const SECRET_TITLE = 'Pay Hidden Vendor 4,90,000 before the audit', SECRET_REASON = 'Hidden Vendor is not a payee of this workspace'
    write(`INSERT INTO proposals (id, user_id, ts, origin, ai_call_id, conversation_id, kind, title, rationale, params_json, analysis_json, state, invalid_reason) VALUES ('prp_r13lead1', ?, ?, 'model', 'aic_r13lead', 'cnv_r13lead', 'bills', ?, 'r', '{}', '{}', 'invalid', ?)`, lc, t, SECRET_TITLE, SECRET_REASON)
    write(`INSERT INTO proposals (id, user_id, ts, origin, ai_call_id, conversation_id, kind, title, rationale, params_json, analysis_json, state) VALUES ('prp_r13lead2', ?, ?, 'model', 'aic_r13lead', 'cnv_r13lead', 'floor', 'Keep a floor of 50,000', 'r', '{"params":{"buffer":5000000}}', '{}', 'new')`, lc, t)

    // R22 (lead L-05): the ask case still showed another member's model-written titles and refusal reasons
    const askCase = await http('GET', '/api/evidence/cases/ask.aic_r13lead', as(op))
    const leaks = [SECRET_TITLE, SECRET_REASON].filter((x) => askCase.text.includes(x))
    const bossCase = await http('GET', '/api/evidence/cases/ask.aic_r13lead', as(boss))
    check('R22', 'r13', 'a member below admin reads another member\'s question to Ask only as hashes: no model-written title or refusal reason in any section of the case', 'V8.2.2 data-specific access; V14.2.6 sensitive data',
      'the case 200 without the title or the reason; the asker reads both', `operator ${code(askCase)}, ${leaks.length} of 2 found${leaks.length ? `: ${leaks.join(' | ')}` : ''}; asker ${code(bossCase)} ${bossCase.text.includes(SECRET_TITLE) ? 'reads the title' : 'does not read the title'}`,
      askCase.status === 200 && leaks.length === 0 && bossCase.status === 200 && bossCase.text.includes(SECRET_TITLE))

    // R23 (lead L-06): another member dismissed, or started an instruction from, the asker's proposal
    const dismissed = await http('POST', '/api/proposals/prp_r13lead2/dismiss', as(op))
    const drafted = await http('POST', '/api/programs', as(op, { body: { kind: 'floor', params: { buffer: 5_000_000 }, proposalId: 'prp_r13lead2' } }))
    const stateNow = rows<{ state: string }>(`SELECT state FROM proposals WHERE id = 'prp_r13lead2'`)[0]?.state
    check('R23', 'r13', 'a model\'s proposal is its asker\'s: another member below admin can neither dismiss it nor start an instruction from it', 'V8.2.2 object-level access (API1)',
      'dismiss 404; instruction from it 404; the proposal still new', `dismiss ${code(dismissed)}; instruction ${code(drafted)}; now ${String(stateNow)}`,
      dismissed.status === 404 && drafted.status === 404 && stateNow === 'new')

    // R24 (lead L-09): one tenant's rows were found by reading every tenant's; an id of any length was stored
    const plans = ['SELECT * FROM actions WHERE program_id = ?', 'SELECT * FROM bills WHERE user_id = ?', 'SELECT * FROM programs WHERE user_id = ?'].map((q) => rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${q}`, 'x').map((r) => r.detail).join(' / '))
    const huge = await http('POST', '/api/programs', as(boss, { body: { kind: 'floor', params: { buffer: 0 }, proposalId: 'p'.repeat(60_000) } }))
    const stored = count(`SELECT COUNT(*) n FROM programs WHERE length(origin) > 200`)
    check('R24', 'r13', 'an instruction\'s actions, a tenant\'s bills and a tenant\'s instructions are found through an index; an instruction cannot carry an arbitrary proposal id', 'V15.2.2 resource limits; V2.2.1 input validation',
      'three SEARCH ... USING INDEX plans; the 60,000-character id 404 and nothing stored', `${plans.join(' | ')}; long id ${code(huge)}, ${stored} stored`,
      plans.every((p) => /SEARCH \w+ USING (COVERING )?INDEX/.test(p)) && huge.status === 404 && stored === 0)

    // R25 (lead L-10): any member with a passkey session, the one who made the change included, cleared a business's
    // notice of a change to who can act. Harness write: the notice rail-signers.ts writes when appr starts a recovery.
    write(`INSERT INTO notices (id, user_id, ts, level, kind, title, body, subject, dedupe) VALUES ('ntc_r13lead', ?, ?, 'warning', 'vault-recovery', 'A recovery of the vault has started', 'appr started a recovery (harness)', '0xr13', ?)`, lc, t, `vault-recovery:req-r13lead:by:${appr.userId}`)
    await stepUp(op, oper.auth); await stepUp(ap, appr.auth)
    const byOperator = await http('POST', '/api/notices/ntc_r13lead/dismiss', as(op))
    const byStarter = await http('POST', '/api/notices/ntc_r13lead/ack', as(ap))
    const stillOpen = count(`SELECT COUNT(*) n FROM notices WHERE id = 'ntc_r13lead' AND resolved_at IS NULL`)
    const byOwner = await http('POST', '/api/notices/ntc_r13lead/dismiss', as(boss))
    const cleared = count(`SELECT COUNT(*) n FROM notices WHERE id = 'ntc_r13lead' AND resolved_at IS NOT NULL`)
    check('R25', 'r13', 'in a business, only an owner or admin other than the member who made the change clears a notice of a change to who can act', 'V8.2.1 function-level access; V16.3.2 security events',
      'operator 403; the starter 403; still open; the owner 200 and it is cleared', `operator ${code(byOperator)}; starter ${code(byStarter)}; open after both ${stillOpen}; owner ${code(byOwner)}; cleared ${cleared}`,
      byOperator.status === 403 && byStarter.status === 403 && stillOpen === 1 && byOwner.status === 200 && cleared === 1)

    // R15 (lead L-12): a password session stopped a protective sale it may not cancel, by asking for the run's approval
    // again (which withdraws the request waiting) or by cancelling that request
    const g = await signInPassword(await legacyAccount('r13guard'))
    must(await http('POST', '/api/auth/stepup', as(g, { body: { password: g.password } })), 'password re-entry before adding a first passkey')
    const gb = must(await http('POST', '/api/security/passkeys/begin', as(g)), 'add a passkey: begin')
    const gauth = authenticator()
    must(await http('POST', '/api/security/passkeys/finish', as(g, { body: { challengeId: gb.challengeId, response: gauth.create(gb.options) } })), 'add a passkey: finish')
    settle(gauth.id) // R15 is about the password session; the cool-off is X05
    const gs = { ...(await signIn(gauth)), userId: g.userId }
    must(await http('POST', '/api/household', as(gs, { body: {} })), 'household')
    const exit = String(must(await http('POST', '/api/programs', as(gs, { body: { kind: 'floor', params: { buffer: 0 } } })), 'a floor instruction (protective; a hand-written one asks first)').programId)
    const ea = must(await http('POST', `/api/programs/${exit}/approval`, as(gs, { body: {} })), 'its approval')
    must((await approve(gs, gauth, String(ea.approvalId), String(ea.docHash))).confirm ?? { status: 0, headers: {}, text: 'not sent', json: null }, 'its signature')
    must(await http('POST', `/api/programs/${exit}/activate`, as(gs, { body: { approvalId: ea.approvalId } })), 'in force')
    // Harness write: one run of it waiting for approval, as the engine leaves it when the price crosses (no price moves here)
    write(`INSERT INTO runs (id, user_id, program_id, version, occurrence, state, trigger_json, due_at, created_at, deadline_at, decision_json) SELECT 'run_r13guard', user_id, id, live_version, 'harness-1', 'awaiting_approval', '{}', ?, ?, ?, ? FROM programs WHERE id = ?`, t, t, Date.now() + 30 * 60_000, JSON.stringify({ summary: ['Sell to restore the floor (harness)'], actions: [] }), exit)
    const asked = must(await http('POST', '/api/runs/run_r13guard/approval', as(gs, { body: {} })), 'the owner asks for the run\'s approval')
    const again = await http('POST', '/api/runs/run_r13guard/approval', as(g, { body: {} }))
    const withdrawn = await http('POST', `/api/approvals/${String(asked.approvalId)}/cancel`, as(g))
    const confirmed = await approve(gs, gauth, String(asked.approvalId), String(asked.docHash))
    check('R15', 'r13', 'a password session can neither ask again for a protective run\'s approval (withdrawing the request waiting) nor withdraw it; the owner\'s passkey then confirms it', 'V8.2.1 function-level access; V6.3.4 consistent strength across pathways',
      'ask again 401 stepup_required; withdraw 401 stepup_required; the owner\'s confirmation 200', `ask again ${code(again)}; withdraw ${code(withdrawn)}; confirmation ${code(confirmed.confirm)}`,
      again.status === 401 && withdrawn.status === 401 && confirmed.confirm?.status === 200)

    // L-14 (not a check): the heaviest reads, timed one at a time under the global throttle, for the record
    for (const [label, path] of [['home', '/api/home'], ['market history, 336 hours', '/api/market/history?hours=336']] as const) {
      const ms: number[] = [], statuses = new Set<number>()
      for (let i = 0; i < 5; i++) { const t0 = Date.now(); statuses.add((await http('GET', path, as(spender))).status); ms.push(Date.now() - t0) }
      measurements.push({ lead: 'L-14', what: `${label} (${path}), as an ordinary household; answered ${[...statuses].join(', ')}`, millisecondsMedian: median(ms), samples: ms })
    }
  })

  // The leads whose scenario needs the wallet service's contract, an injected model or recovery state: their tests run in
  // process against a recording stand-in of the wallet service (server/rail-fake.ts) and are recorded here by check id.
  await group('r13-inprocess', async () => {
    const files = ['server/rail-signers.test.ts', 'server/earn-chain.test.ts', 'server/rail.test.ts', 'server/ask-budget.test.ts', 'server/recovery-review.test.ts']
    const json = join(dir, 'leads.json')
    const run = spawnSync(process.execPath, [join(app, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...files, '-t', 'R13 lead checks', '--maxWorkers=1', '--reporter=json', `--outputFile=${json}`], { cwd: app, env: inherited, encoding: 'utf8', timeout: 300_000 })
    let results: { title: string; status: string; failureMessages?: string[] }[] = []
    try { results = (JSON.parse(readFileSync(json, 'utf8')) as { testResults: { assertionResults: { title: string; status: string; failureMessages?: string[] }[] }[] }).testResults.flatMap((f) => f.assertionResults) } catch { /* recorded below */ }
    const want: [string, string, string][] = [['R16', 'L-01', 'V15.2.2 resource limits (API4); V2.4.1'], ['R17', 'L-02', 'V2.3.2 workflow integrity; V2.3.4 business-logic limits (API6)'], ['R18', 'L-03', 'V2.3.5 multi-party approval; V8.2.1'], ['R19', 'L-04', 'V8.2.3 field-level access (API3)'], ['R20', 'L-07', 'V15.2.2 resource limits (API4)'], ['R21', 'L-08', 'V8.2.2 data-specific access; V16.2.5 sensitive data in logs'], ['R26', 'L-11', 'V6.4.1 recovery; V2.3.2 workflow integrity']]
    for (const [id, lead, asvs] of want) {
      const r = results.find((x) => x.title.startsWith(`${id} (${lead})`))
      check(id, 'r13', r ? r.title.replace(/^R\d+ \(L-\d+\): /, '') : `lead ${lead}`, asvs, 'its test passes', r ? `${r.status}${r.failureMessages?.length ? `: ${r.failureMessages[0]!.split('\n')[0]!.slice(0, 240)}` : ''}` : `not found (vitest exit ${String(run.status)}: ${String(run.stderr ?? '').slice(-200)})`, r?.status === 'passed')
    }
  })

  // R14 (F-14): any web page on a local origin could drive the wallet service's chain over WebSocket, and over HTTP
  // after DNS rebinding. A wallet service of its own is started here (baseline-parity mode, its own data folder) and its
  // chain probed from Chrome as the review probed it: a page on another local origin (this stack's), and a page of a
  // rebinding name (Chrome's Local Network Access gating off, as in browsers without it).
  await group('r13-chain', async () => {
    const railData = join(dir, 'rail-data'), railPort = port + 2
    const legacyAnvilPort = Number(process.env.QED_SECURITY_ANVIL_PORT ?? port + 31)
    const svc = spawn(process.execPath, ['serve.ts'], { cwd: join(app, 'chain'), stdio: 'ignore', env: { ...inherited, PATH: `${join(process.env.HOME ?? '', '.foundry', 'bin')}:${process.env.PATH ?? ''}`, QED_RAIL_DATA: railData, QED_RAIL_PORT: String(railPort), QED_RAIL_ANVIL_PORT: String(legacyAnvilPort), QED_RAIL_ECONOMY_ANVIL_PORT: String(legacyAnvilPort + 1), QED_RAIL_MODE: 'baseline-parity' } })
    children.push(svc)
    const pidFile = join(railData, 'rail', 'anvil.pid'), endpoint = join(railData, 'rail', 'anvil.endpoint.json')
    let chainPid = 0, ports: number[] = []
    for (let i = 0; i < 240 && !ports.length; i++) {
      await sleep(250)
      try { chainPid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { continue }
      try { ports = execFileSync('lsof', ['-nP', '-a', '-p', String(chainPid), '-iTCP', '-sTCP:LISTEN', '-Fn']).toString().split('\n').filter((l) => l.startsWith('n')).map((l) => Number(l.split(':').pop())) } catch { ports = [] }
    }
    if (!ports.length) throw new Error('the wallet service\'s chain did not start')
    // the chain's clock, through whichever door the service uses: its private socket (since R13), else its port
    const cs = existsSync(endpoint) ? await import('../chain/rail/chain-socket.ts') : null
    const url = cs ? (() => { const e = JSON.parse(readFileSync(endpoint, 'utf8')) as { url: string; socket: string }; cs.routeChain(e.url, e.socket); return e.url })() : `http://127.0.0.1:${ports[0]}`
    const clock = async (): Promise<number> => Number(((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()) as { result: { timestamp: string } }).result.timestamp)
    const t0 = await clock()
    // the attacker's page: another local origin, a plain page with no Content-Security-Policy (QED's own pages send one
    // whose connect-src would stop the WebSocket before the chain is ever asked)
    const pageServer = createHttpServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>another local origin</title>') })
    await new Promise<void>((ok) => pageServer.listen(port + 3, '127.0.0.1', () => ok()))
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--host-resolver-rules=MAP rebind.evil.example 127.0.0.1', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights'] })
    const seen: string[] = []
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${port + 3}/`)
      for (const p of ports) {
        for (const host of ['127.0.0.1', 'localhost']) {
          const ws = await page.evaluate(({ host, p }) => new Promise<string>((done) => {
            let opened = false
            const w = new WebSocket(`ws://${host}:${p}`)
            w.onopen = () => { opened = true; w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: ['0x1e13380'] })); w.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'evm_mine', params: [] })) }
            let n = 0
            w.onmessage = () => { if (++n === 2) { w.close(); done('opened and answered') } }
            w.onclose = () => done(opened ? 'opened' : 'refused')
            setTimeout(() => done(opened ? 'opened' : 'refused'), 4000)
          }), { host, p })
          seen.push(`ws://${host}:${p} ${ws}`)
        }
        const rb = await ctx.newPage()
        await rb.route(`http://rebind.evil.example:${p}/`, (r) => (r.request().resourceType() === 'document' ? r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>rebinding</title>' }) : r.continue()))
        const answer = await rb.goto(`http://rebind.evil.example:${p}/`).then(() => rb.evaluate(async () => { try { const r = await fetch('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }); return `answered ${r.status} ${(await r.text()).slice(0, 60)}` } catch (e) { return `refused (${String(e)})` } }), (e: Error) => `page refused (${e.message.split('\n')[0]})`)
        seen.push(`rebind.evil.example:${p} ${answer}`)
        await rb.close()
      }
    } finally { await browser.close(); pageServer.close() }
    const moved = (await clock()) - t0
    svc.kill('SIGTERM')
    for (let i = 0; i < 40 && svc.exitCode === null && svc.signalCode === null; i++) await sleep(250)
    try { process.kill(chainPid, 0); process.kill(chainPid, 'SIGTERM') } catch { /* stopped with the service */ }
    const reached = seen.filter((s) => /opened|answered/.test(s))
    check('R14', 'r13', 'no web page can use the wallet service\'s chain: a WebSocket from another local origin and a request after DNS rebinding reach nothing on any port it listens on, and its clock does not move (F-14)', 'V4.4.1 WebSocket origin; V3.4.5 rebinding (Host); V13.4.1 attack surface',
      `every attempt refused; the clock moved under an hour (the chain listens on ${ports.join(', ')})`, `${seen.join('; ')}; clock moved ${moved} s`, reached.length === 0 && moved < 3600)
  })

  // ------------------------------------------------------------------ R13 hardening (ASVS 5.0 pass): X01 onwards
  await group('r13-hardening', async () => {
    // X01: the built page's policy, in Chrome. A nonce made for the response, no 'unsafe-inline'; the interface runs with
    // nothing blocked; a script without the nonce and an inline style attribute added on purpose are blocked and reported.
    const pageRes = await http('GET', '/', { host: `localhost:${port}` })
    const pagePolicy = String(pageRes.headers['content-security-policy'] ?? '')
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    let rendered = false, before: string[] = [], injectedRan = true, after: string[] = []
    const screens: string[] = []
    try {
      const pg = await (await browser.newContext()).newPage()
      await pg.addInitScript(() => { const w = window as unknown as { __v: string[] }; w.__v = []; document.addEventListener('securitypolicyviolation', (e) => w.__v.push(`${e.disposition} ${e.effectiveDirective}`)) })
      await pg.goto(`http://localhost:${port}/`)
      await pg.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, undefined, { timeout: 20_000 }).then(() => { rendered = true }).catch(() => { rendered = false })
      await sleep(800)
      before = await pg.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0))
      // then every main screen, signed in as a household (the session made over HTTP, its cookie given to the browser): each
      // screen's code is loaded by a dynamic import, which must carry the page's nonce
      const [name, value] = spender.cookie.split('=') as [string, string]
      await pg.context().addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }])
      for (const path of ['/', '/pay', '/save', '/holdings', '/earn', '/protect', '/activity', '/instructions', '/safeguards', '/security', '/workspace', '/vault', '/ask', '/evidence', '/passbook', '/tax', '/notifications', '/readiness', '/more']) {
        await pg.goto(`http://localhost:${port}${path}`)
        const ok = await pg.waitForFunction(() => !!document.querySelector('main h1, main h2'), undefined, { timeout: 15_000 }).then(() => true).catch(() => false)
        await sleep(300)
        screens.push(`${path} ${ok ? 'drawn' : 'BLANK'}`)
        before.push(...await pg.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0)))
      }
      injectedRan = await pg.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = true'; document.body.appendChild(s); const d = document.createElement('div'); d.setAttribute('style', 'outline: 1px solid red'); document.body.appendChild(d); return (window as unknown as { __ran?: boolean }).__ran === true })
      for (let i = 0; i < 40 && (after.length < 2 || !cspLines.length); i++) { await sleep(250); after = await pg.evaluate(() => (window as unknown as { __v: string[] }).__v) }
    } finally { await browser.close() }
    check('X01', 'r13-hardening', 'the built page has a policy with a nonce of its own and no unsafe-inline; it runs in Chrome with nothing blocked, and a script without the nonce or an inline style is blocked and reported', 'V3.4.3 CSP with nonces (L3); V3.4.7 violation reports',
      "script-src 'nonce-…' only; the sign-in page and all 19 main screens (signed in) drawn; no violation; the injected script did not run; script-src-elem and style-src-attr blocked; a csp-violation line in the API's log",
      `${pagePolicy.slice(0, 90)}…; rendered ${rendered}; screens ${screens.filter((x) => x.endsWith('drawn')).length} of ${screens.length} drawn${screens.some((x) => x.endsWith('BLANK')) ? ` (blank: ${screens.filter((x) => x.endsWith('BLANK')).join(', ')})` : ''}; violations before ${before.length}${before.length ? ` (${before.slice(0, 3).join('; ')})` : ''}; injected script ran ${injectedRan}; then ${after.join(', ')}; log lines ${cspLines.length}`,
      /script-src 'nonce-[A-Za-z0-9_-]{20,}';/.test(pagePolicy) && !/unsafe-inline|unsafe-eval/.test(pagePolicy) && rendered && screens.length === 19 && screens.every((x) => x.endsWith('drawn')) && before.length === 0 && !injectedRan && after.some((v) => v.endsWith('script-src-elem')) && after.some((v) => v.endsWith('style-src-attr')) && cspLines.length > 0)

    // X02: only the interface's own kinds of file: a source map that is on disk is not served; text types carry their charset
    const entry = /src="(\/assets\/[^"]+\.js)"/.exec(pageRes.text)?.[1] ?? '/assets/missing.js'
    const js = await http('GET', entry, { host: `localhost:${port}` }), map = await http('GET', `${entry}.map`, { host: `localhost:${port}` })
    const mapOnDisk = existsSync(join(app, 'dist', `${entry}.map`))
    check('X02', 'r13-hardening', 'a source map in the build folder is never served, and a script is sent with its character set', 'V13.4.2 no debug artefacts; V13.4.7 only allowlisted file types; V4.1.1 charset',
      'the script 200 text/javascript; charset=utf-8; its map (on disk) 404', `script ${js.status} ${String(js.headers['content-type'])}; map ${map.status} (on disk: ${mapOnDisk})`,
      js.status === 200 && js.headers['content-type'] === 'text/javascript; charset=utf-8' && map.status === 404 && mapOnDisk)

    // X04 (Q-048): giving a member authority waits out the protection delay; any member who may sign cancels it; a viewer
    // is added at once; narrowing applies at once
    await stepUp(boss, boss.auth)
    const gc = String(must(await http('POST', '/api/workspaces', as(boss, { body: { name: 'R13 Grants Co' } })), 'create R13 Grants Co').id)
    const g1 = await http('POST', '/api/workspace/members', as(boss, { body: { handle: appr.handle, role: 'approver' } }))
    const g2 = await http('POST', '/api/workspace/members', as(boss, { body: { handle: oper.handle, role: 'operator' } }))
    const v1 = await http('POST', '/api/workspace/members', as(boss, { body: { handle: view.handle, role: 'viewer' } }))
    const early = await http('POST', `/api/workspaces/${gc}/switch`, as(appr))
    const cancelled = await http('POST', `/api/security/changes/${String(g2.json?.grant?.changeId)}/cancel`, as(boss))
    const deadline = Date.now() + (DELAY_SEC + 20) * 1000
    while (count(`SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL`, gc, appr.userId) === 0 && Date.now() < deadline) await sleep(500)
    const roleOf = (p: Person): string => rows<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', gc, p.userId)[0]?.role ?? 'none'
    const afterDelay = { appr: roleOf(appr), oper: roleOf(oper), view: roleOf(view) }
    await stepUp(boss, boss.auth)
    const lowered = await http('POST', `/api/workspace/members/${appr.userId}/role`, as(boss, { body: { role: 'viewer' } }))
    const toldMeera = count(`SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'member-grant-scheduled'`, boss.userId)
    check('X04', 'r13-hardening', 'giving a member authority waits out the protection delay and can be cancelled meanwhile; a viewer is added at once; lowering a role applies at once (Q-048)', 'V8.2.1 function-level access; V2.3.5 multi-party control of authority changes',
      `approver and operator asked: 200, waiting (${DELAY_SEC} s here, 72 h in the product); the approver not a member meanwhile (switch 404); the operator's grant cancelled; after the delay the approver an approver, the operator none, the viewer a viewer from the start; lowering 200 at once`,
      `asked ${code(g1)} applied ${String(g1.json?.grant?.applied)}, ${code(g2)}; viewer ${code(v1)} applied ${String(v1.json?.grant?.applied)}; switch meanwhile ${code(early)}; cancel ${code(cancelled)}; after the delay ${JSON.stringify(afterDelay)}; lowered ${code(lowered)} to ${roleOf(appr)}; the asker told ${toldMeera}`,
      g1.status === 200 && g1.json?.grant?.applied === false && g2.status === 200 && v1.json?.grant?.applied === true && early.status === 404 && cancelled.status === 200 && afterDelay.appr === 'approver' && afterDelay.oper === 'none' && afterDelay.view === 'viewer' && lowered.status === 200 && roleOf(appr) === 'viewer' && toldMeera > 0)

    // X05 (RISK-068, Q-062): a passkey added to an account approves nothing above ₹10,000, loosens no protection and makes
    // no new codes for 24 hours; an older passkey removes it at once, and the person is told
    await stepUp(thrifty, thrifty.auth)
    const ab = must(await http('POST', '/api/security/passkeys/begin', as(thrifty)), 'add a passkey: begin')
    const phone = authenticator()
    must(await http('POST', '/api/security/passkeys/finish', as(thrifty, { body: { challengeId: ab.challengeId, response: phone.create(ab.options), passkeyName: 'New phone' } })), 'add a passkey: finish')
    const ps = { ...(await signIn(phone)), userId: thrifty.userId }
    const tp = String(must(await http('POST', '/api/payees', as(ps, { body: { name: 'Big Vendor', handle: 'big.vendor@upi', category: 'other', nameCheckAccepted: 'unknown' } })), 'a payee').id)
    const big = await preview(ps, tp, 2_000_000)
    const bigSigned = await approve(ps, phone, big.approvalId, big.docHash)
    const profileNow = must(await http('GET', '/api/session', as(ps)), 'session').profile as { line: number }
    const loosen = await http('PATCH', '/api/profile', as(ps, { body: { line: Math.max(0, profileNow.line - 100_000) } }))
    const codes = await http('POST', '/api/security/recovery-codes', as(ps))
    await stepUp(thrifty, thrifty.auth)
    const removedNow = await http('POST', `/api/security/passkeys/${phone.id}/remove`, as(thrifty, { body: { code: thrifty.codes[0] } })) // H2: at once only with a saved code
    const phoneAfter = await signIn(phone)
    const toldRemoved = count(`SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'passkey-removed-in-cool-off'`, thrifty.userId)
    check('X05', 'r13-hardening', 'a passkey added to an account cannot approve above ₹10,000, loosen a protection or make new codes in its first 24 hours; an older passkey removes it at once and the person is told (RISK-068, Q-062)', 'V6.3.7 notify of authenticator changes; V7.5.3; V6.4.5 factor lifecycle',
      'approval of ₹20,000 409 passkey_cooling_off; lowering the floor 409; new codes 409; removal by the older passkey 200 removed at once; the new passkey then cannot sign in; told',
      `approve ${code(bigSigned.confirm ?? bigSigned.begin)}; loosen ${code(loosen)}; codes ${code(codes)}; remove ${code(removedNow)} removed ${String(removedNow.json?.removed)}; sign-in after ${code(phoneAfter.res)}; told ${toldRemoved}`,
      bigSigned.confirm?.status === 409 && bigSigned.confirm.json?.error?.code === 'passkey_cooling_off' && loosen.status === 409 && loosen.json?.error?.code === 'passkey_cooling_off' && codes.status === 409 && removedNow.status === 200 && removedNow.json?.removed === true && phoneAfter.res.status === 401 && toldRemoved === 1)

    // X06: refusals are logged, one line each (server/guard.ts), for the CSRF and cross-site refusals the run made (S04 to S07)
    const csrfLines = refusedLines.filter((l) => /status=403/.test(l) && /code=csrf/.test(l)).length, siteLines = refusedLines.filter((l) => /code=cross_site/.test(l)).length
    check('X06', 'r13-hardening', 'every security refusal is a line in the operational log, with its status, code, route and address, never its query or body', 'V16.3.2 failed authorization logged; V16.3.3 bypass attempts logged; V16.2.5 no sensitive data',
      'refused lines for the CSRF (403 csrf) and cross-site (403 cross_site) refusals; none carries a query string or a cookie', `${refusedLines.length} refused lines; csrf ${csrfLines}; cross-site ${siteLines}; e.g. ${refusedLines.find((l) => /code=csrf/.test(l)) ?? 'none'}`,
      csrfLines > 0 && siteLines > 0 && !refusedLines.some((l) => /\?|qed_session=/.test(l)))

    // X07: a sign-in ends the session the browser presented (V7.2.4); signing out asks the browser to clear its cache
    const rot = await legacyAccount('r13rotate')
    const firstIn = await passwordSignIn(rot.handle, rot.password)
    const secondIn = await http('POST', '/api/auth/login', { cookie: cookieOf(firstIn), body: { handle: rot.handle, password: rot.password } })
    const oldNow = await http('GET', '/api/session', { cookie: cookieOf(firstIn) }), newNow = await http('GET', '/api/session', { cookie: cookieOf(secondIn) })
    const out = await http('POST', '/api/auth/logout', { cookie: cookieOf(secondIn), csrf: String(secondIn.json?.csrf) })
    check('X07', 'r13-hardening', 'a sign-in ends the session the browser presented, and signing out sends Clear-Site-Data', 'V7.2.4 new token on authentication, the current one terminated; V14.3.1 client data cleared',
      'the earlier session signed out, the new one signed in; logout 200 with Clear-Site-Data "cache"', `earlier ${String(oldNow.json?.authenticated)}; new ${String(newNow.json?.authenticated)}; logout ${code(out)} ${String(out.headers['clear-site-data'])}`,
      oldNow.json?.authenticated === false && newNow.json?.authenticated === true && out.status === 200 && out.headers['clear-site-data'] === '"cache"')

    // X08 (brief item 2): a request refused at its last write changes nothing. Harness write: a trigger that refuses the
    // profile change's audit entry as a full disk does, then removed.
    const tx = await signInPassword(await legacyAccount('r13atomic'))
    const opened = must(await http('POST', '/api/household', as(tx, { body: {} })), 'household').profile as { line: number }
    write(`CREATE TRIGGER r13_fail_profile_audit BEFORE INSERT ON audit WHEN NEW.action = 'profile.update' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
    const refusedAtLast = await http('PATCH', '/api/profile', as(tx, { body: { line: opened.line + 100_000 } }))
    write('DROP TRIGGER r13_fail_profile_audit')
    const lineNow = (must(await http('GET', '/api/session', as(tx)), 'session').profile as { line: number }).line
    await sleep(300)
    check('X08', 'r13-hardening', 'a changing request that fails at its last write (a full disk) changes nothing: one transaction per request; the fault is logged with its route, not its query', 'V2.3.3 all or nothing; V16.5.3 fails securely; V16.3.4 errors logged',
      '507 storage_full; the floor as it was; no audit entry for it; one storage fault line naming PATCH /api/profile', `${code(refusedAtLast)}; floor ${lineNow} (was ${opened.line}); log ${storageLines.join(' | ') || 'none'}`,
      refusedAtLast.status === 507 && lineNow === opened.line && count(`SELECT COUNT(*) n FROM audit WHERE action = 'profile.update' AND user_id = ?`, tx.userId) === 0 && storageLines.length === 1 && /path=\/api\/profile/.test(storageLines[0]!))
  })

  await group('integrity', async () => {
    const ch = rows<{ purpose: string; challenge: string; context_json: string }>('SELECT purpose, challenge, context_json FROM webauthn_challenges')
    const random = ch.filter((c) => c.purpose !== 'approval'), approval = ch.filter((c) => c.purpose === 'approval')
    const bits = Math.min(...ch.map((c) => Buffer.from(c.challenge, 'base64url').length * 8))
    const derived = approval.filter((c) => { const x = JSON.parse(c.context_json) as { approvalId: string; docHash: string }; return c.challenge === approvalChallengeOf(x.approvalId, x.docHash) }).length
    const byApproval = new Map<string, string>(); for (const c of approval) byApproval.set((JSON.parse(c.context_json) as { approvalId: string }).approvalId, c.challenge)
    check('N41', 'integrity', 'every passkey challenge issued in this run had at least 64 bits; the random ones never repeated; each approval\'s was derived from its own id and terms, and no two approvals shared one', 'V6.7.2 challenge size and uniqueness', '>= 64 bits; random ones distinct; every approval challenge derived; one distinct challenge per approval', `${ch.length} challenges, at least ${bits} bits; ${new Set(random.map((c) => c.challenge)).size} distinct of ${random.length} random; ${derived} of ${approval.length} approval challenges derived (repeated requests for one approval get the same challenge by design); ${new Set(byApproval.values()).size} distinct for ${byApproval.size} approvals`, bits >= 64 && new Set(random.map((c) => c.challenge)).size === random.length && derived === approval.length && new Set(byApproval.values()).size === byApproval.size)
    await sleep(3000)
    const unbalanced = count(`SELECT COUNT(*) n FROM (SELECT entry_id FROM postings GROUP BY entry_id, asset_id HAVING amount_sum(amount_text) != '0')`)
    const pays = count('SELECT COUNT(*) n FROM pv_payments'), acts = count('SELECT COUNT(*) n FROM actions')
    check('S53', 'integrity', 'after every attack the ledger still balances and the rail holds one payment for each action', 'V2.3.3 all or nothing; V15.4.2', 'no unbalanced entry; payments on the rail equal actions sent', `${unbalanced} unbalanced entries; ${pays} rail payments for ${acts} actions`, unbalanced === 0 && pays === acts && acts > 0)
  })
  check('S54', 'integrity', 'no request produced an unhandled server error', 'V16.5.3 fails securely; V16.5.4 last-resort handler', 'nothing on the services\' error output', serverErrors.length ? serverErrors.slice(0, 3).join(' | ') : 'nothing', serverErrors.length === 0)
} catch (e) {
  check('H', 'harness', 'the checks ran to the end', '-', 'no exception in the test script', e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}` : String(e), false)
} finally {
  for (const c of children) c.kill('SIGTERM')
}

const failed = checks.filter((c) => !c.pass)
const continued = checks.filter((c) => c.id.startsWith('S')).length, added = checks.filter((c) => c.id.startsWith('N')).length, r13 = checks.filter((c) => c.id.startsWith('R')).length, hardening = checks.filter((c) => c.id.startsWith('X')).length
const ist = new Date(Date.now() + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST')
writeFileSync(out, `${JSON.stringify({
  what: 'QED active security checks against an isolated scratch copy, passkey design (R7)', producedAt: ist,
  target: `http://${host} on a scratch database (deleted with the temporary directory by the operating system)`,
  howToReproduce: 'node scripts/security.ts <report.json>',
  stack: { recoveryDelaySec: DELAY_SEC, protectionDelaySec: DELAY_SEC, relyingParty: RP_ID, origin, authenticator: 'server/softauthn.ts (software, ES256)' },
  harnessWrites: ['the address\'s recovery allowance cleared once, after showing it spent (instead of waiting an hour)', 'one approval\'s expiry set in the past (instead of waiting ten minutes)', 'session re-authentication time cleared (instead of waiting five minutes)', 'two legacy password accounts created with server/auth.ts hashPassword', 'one session pointed at a workspace its person does not belong to (N34)', 'one membership ended (N40; no route removes a member yet)', 'R13 second pass: one model call of a business owner with two proposals, as server/ai.ts stores them (R22, R23; the stack has no model)', 'one business notice of a vault recovery, as rail-signers.ts writes it (R25; no vault service on this stack)', 'one run of a protective instruction put in the waiting state, as the engine leaves it when a price crosses (R15)', 'R13 hardening: four passkeys a check added put past their cool-off (instead of waiting 24 hours; N15 legacy, N22, N47, R15), and one trigger that refuses an audit entry as a full disk does, created and dropped (X08)'],
  ids: { continuedFromPreR7: continued, newInR7: added, r13Review: r13, r13Hardening: hardening, note: 'S01-S54 continue the 54 pre-R7 checks in order; `was` gives the earlier wording where it changed' },
  passed: checks.length - failed.length, failed: failed.length, checks, measurements,
}, null, 1)}\n`)
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed (${continued} continued checks, ${added} new in R7, ${r13} from the R13 review, ${hardening} from the R13 hardening). Report: ${out}`)
await sleep(500)
process.exit(failed.length ? 1 : 0)
