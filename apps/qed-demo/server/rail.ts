/**
 * The wallet's side of the chain rail (apps/qed-demo/chain): the approved release's contracts, unmodified, on a
 * local Anvil chain, behind a loopback service of its own that serves many owners. The rail refuses browsers
 * outright, so the interface reaches it only through here, and three things are added on the way:
 *
 *   - whose vault it is. A household has at most one vault: a workspace of the rail whose name is a fixed function
 *     of the household's id (railWorkspaceId). Every call names that workspace and no other, so no owner of this
 *     installation can reach another's vault; the rail keeps the workspaces' records and funds apart as well.
 *   - who owns it. The vault's owner is an account on the chain (QEDOwnerAccount) whose signers are the owner's
 *     passkeys, as they were when the vault was set up. The rail holds no key that can satisfy it. Every owner action
 *     is a proposal whose exact terms list what the chain will check (terms.toSign): the account's EIP-712 digest of
 *     the exact calls, the replay-safe hash of a mandate or of a signed instruction, or a cancellation. The owner's
 *     passkey signs each digest as its WebAuthn challenge; this layer verifies each assertion, keeps it with the
 *     approval document, and hands it to the rail, which checks it on chain before it relays anything. Terms with
 *     nothing for the chain to check (an attack or a scenario on a throwaway chain, or a pause by the guardian's key)
 *     are approved with the ordinary passkey signature over the approval document.
 *   - a fixed list of what may be asked. Reads are named one by one and their parameters are checked; nothing the
 *     browser sends becomes part of a path.
 *
 * The rail's bearer token is read from its own file and is sent only to a loopback address.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { approvalLapsed, createApproval, getApproval, LAPSED_TEXT, signApproval } from './approvals.ts'
import { rateLimit, type Session } from './auth.ts'
import { log } from './log.ts'
import { AppError, audit, bad, type Config, type Db, emit, j, notFound, parse, refused, whenIst } from './core.ts'
import { activeContacts, approvingCredentials, beginReauth, coolingOffUntil, COOL_OFF_MS, type Credential, finishReauth, handleOf, hasPasskey, type RelyingParty, restrictedError, securityEvent, settledCredentials } from './passkeys.ts'
import { passwordWork } from './prepared.ts'
import { sha256hex } from './receipts.ts'
import { canSign, members, policyOf, type Role } from './workspaces.ts'
import { canonical } from '../shared/sha256.ts'
import { AssetSetError, assetSetDigest, assetSetDocument, type AssetSet, checkAssetSet, isDefaultSet, sameSet } from '../shared/chain-assets.ts'
import { notice, resolveNotices } from './execute.ts'

type Json = Record<string, unknown>
/** All this layer needs to know of the configuration: where the database is, and so where the rail's token file is. */
export type RailCfg = Pick<Config, 'dbPath'>
export interface RailReply { status: number; json: Json }
/** Who is asking: the workspace whose vault it is, the person signed in, their role there, and their session. */
export interface Asker { workspaceId: string; personId: string; role: Role; session: Session }

// What the person is told when the wallet's service does not answer (R14): what is wrong, that nothing of theirs changed,
// and what to do. How to start the service is the operator's matter and is said on the wallet's page behind a disclosure.
const OFF = 'The on-chain wallet\'s service is not answering, so nothing on the chain can be read or done just now. Nothing was sent, and nothing in your wallet has changed. Try again in a minute.'
const STARTING = 'The on-chain wallet\'s service is starting: its chain, contracts and co-signer must all answer before it is ready, which usually takes under a minute. Nothing needs doing; try again shortly.'
const BASELINE = 'The vault service on this computer runs in baseline-parity mode: one vault owned by the release\'s development key, for the parity tests only. Owners\' vaults need the multi-tenant mode: start it with "npm start" in apps/qed-demo/chain on a data folder of that mode.'
const SHARED_OWNER = 'Only the owner of this workspace can set up its vault: it makes every signing member\'s passkey a signer of the vault\'s owner account.'
const CUSTODY = 'Your vault is owned by an account on the chain whose signers are your passkeys, as they were when you set it up. The vault service holds no key that can act as the owner: every owner action needs your passkey\'s signature over the exact digest shown, and the chain checks it before anything runs. The agent, co-signer, guardian and relayer keys are the service\'s own, derived from a secret on this computer; none of them can sign for the owner.'

function railBase(env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(env.QED_RAIL_URL ?? 'http://127.0.0.1:5176')
  // The token below is a credential. It is never sent anywhere but this machine.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new AppError(500, 'rail_misconfigured', 'QED_RAIL_URL must be a loopback address.')
  return url.origin
}
export function railToken(cfg: RailCfg, env: NodeJS.ProcessEnv = process.env): string | null {
  const p = env.QED_RAIL_TOKEN_FILE ?? join(dirname(cfg.dbPath), 'rail.token')
  try { return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null } catch { return null }
}

const UNKNOWN = 'The vault service did not answer in time. It may have received this request: it has no record of it yet, so nothing is confirmed either way. Look at the wallet\'s activity before asking again; a new request could do the same thing twice.'

/**
 * Whether a request that failed may have reached the vault service. A refused or unresolvable connection means nothing
 * was sent. Anything else, a timeout or a connection closed during the request, may have been received and acted on.
 */
function mayHaveArrived(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code
  return !(code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
}

/**
 * Recovery by lookup after a POST that may have arrived (chain/rail/service.ts `submission`): the vault service keeps
 * the job each Idempotency-Key started, in the workspace's own store. Found, the job is returned as accepted, marked
 * `recovered`, and nothing is sent again. Not found, or no answer, the outcome stays unknown and is said so: a job may
 * still be on its way in, so "not found" now is not "never started".
 */
async function recoverByKey(token: string, path: string, key: string): Promise<RailReply> {
  const ws = /^\/workspaces\/[^/]+/.exec(path)?.[0]
  if (ws) {
    try {
      const r = await fetch(`${railBase()}${ws}/submissions/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error' })
      if (r.status === 200) return { status: 202, json: { ...((await r.json()) as Json), duplicate: true, recovered: true } }
    } catch { /* still unknown */ }
  }
  throw new AppError(504, 'rail_outcome_unknown', UNKNOWN)
}

/**
 * One call to the rail. A refusal by the rail comes back as its own status and message. A connection refused becomes
 * "not running" (nothing was sent), as does a read with no answer (a read changes nothing). A POST that may have arrived
 * but got no answer is looked up by its Idempotency-Key and, if it is not found or has no key, reported as of unknown
 * outcome (504), never as "not running": the service may have acted.
 */
export async function rail(cfg: RailCfg, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<RailReply> {
  const token = railToken(cfg)
  if (!token) throw new AppError(503, 'rail_off', OFF)
  const base = railBase() // a misconfigured address is its own error (500), before anything is sent
  let res: Response
  try {
    res = await fetch(base + path, {
      // the vault service never redirects; a redirect would send the bearer token elsewhere (ASVS 5.0 V15.3.2)
      method, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
  } catch (e) {
    if (method === 'POST' && mayHaveArrived(e)) {
      const key = headers['Idempotency-Key']
      if (key) return recoverByKey(token, path, key)
      throw new AppError(504, 'rail_outcome_unknown', UNKNOWN)
    }
    throw new AppError(503, 'rail_off', OFF)
  }
  const json = (await res.json().catch(() => ({}))) as Json
  return { status: res.status, json }
}
/** As `rail`, but a refusal is thrown in this API's own error shape, with the rail's words. */
export async function must(cfg: RailCfg, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<Json> {
  return answer(await rail(cfg, method, path, body, headers, timeoutMs))
}
/** The wallet service's 5xx answers whose words go to the person as they are (each says what to do; none names a path). */
const SAYABLE = new Set(['rail_starting', 'workspace_unavailable', 'bounties_unavailable', 'disputes_unavailable'])
function answer(r: RailReply): Json {
  if (r.status >= 200 && r.status < 300) return r.json
  const e = (r.json.error ?? {}) as { code?: string; message?: string; details?: unknown }
  // A fault of the vault service is not the person's: its own words can name its folders and processes, so they go to the
  // log, and the person is told plainly (R13 hardening; ASVS 5.0 V16.5.1). Refusals (4xx) keep the service's words, which say what to change.
  if (r.status >= 500) {
    log('api', 'warn', 'wallet service fault', { status: r.status, code: e.code ?? 'none', message: typeof e.message === 'string' ? e.message.slice(0, 300) : undefined })
    // its own words only for the answers that say what to do and name nothing inside it (the chain starting, a workspace
    // being made, a part this chain does not have)
    if (e.code && SAYABLE.has(e.code) && typeof e.message === 'string') throw new AppError(503, e.code, e.message.slice(0, 300))
    throw new AppError(503, 'rail_unavailable', 'The on-chain wallet\'s service could not finish that. Nothing was changed, and your passkey and your device are not the cause. Try again in a minute; if it fails again, the fault is in the service itself, and whoever runs this QED can read the reason in its log.')
  }
  throw new AppError(r.status === 401 ? 503 : r.status, e.code ?? 'rail_refused', e.message ?? 'The on-chain vault service refused that request.')
}

// ------------------------------------------------------------------------------------------------ whose vault it is

/** The rail workspace of a wallet workspace: a fixed function of its id, so a lost reply can always be asked again. */
export function railWorkspaceId(walletWorkspaceId: string): string {
  return `qed-${createHash('sha256').update(`qed/vault-workspace/v1\n${walletWorkspaceId}`).digest('hex').slice(0, 24)}`
}
/**
 * Exactly what was sent to create the vault: POST /workspaces is idempotent only for the same body. `currencies` and
 * `authorization` (money-model S5): a set of test tokens other than the default, with the owner's passkey assertion over
 * its configuration (shared/chain-assets.ts); absent for the default, as before S5. `timeLock` (R13): the household chose,
 * at set-up, to time-lock withdraw, ring-fence, resume and the vault's guardian; absent when it did not, as before R13.
 */
export interface CreateRequest { workspaceId: string; owner: { signers: { x: string; y: string }[]; threshold: number; adminThreshold?: number }; rpIdHash: string; origin: string; currencies?: AssetSet; authorization?: { assertions: Json[] }; timeLock?: boolean }
/**
 * `members` (a shared workspace): whose passkey each signer was at set-up. A household's signers are its own passkeys.
 * `current`: the owner account's signers as the chain held them when last read (signers change after set-up, RISK-053);
 * `request` stays exactly what was sent to create the vault.
 */
export interface VaultRecord { railId: string; request: CreateRequest; credentialIds: string[]; members?: { personId: string; credentialId: string }[]; createdAt: number; createdBy: string; current?: CurrentSigners }
/** `guardian` (R13): the recovery contact's passkey that co-signs recoveries; it never signs for the vault. */
export interface CurrentSigners { signers: { x: string; y: string; role: 'member' | 'recovery' | 'guardian' }[]; threshold: number; adminThreshold: number; syncedAt: number }
const recordKey = (ws: string): string => `vault.workspace:${ws}`
export function vaultOf(db: Db, ws: string): VaultRecord | null {
  const v = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', recordKey(ws))?.value
  return v ? parse<VaultRecord | null>(v, null) : null
}
export function saveVault(db: Db, ws: string, v: VaultRecord): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', recordKey(ws), j(v))
}
export function mustVault(db: Db, ws: string): VaultRecord {
  const v = vaultOf(db, ws)
  if (!v) throw refused('vault_not_set_up', 'This household has no vault yet. Set it up first.')
  return v
}
export const at = (v: VaultRecord, path: string): string => `/workspaces/${v.railId}${path}`

/** A stored credential's coordinates (hex without 0x) against a key from the rail (0x hex). */
export const sameKey = (c: { x: string; y: string }, k: { x: string; y: string }): boolean => BigInt(`0x${c.x}`) === BigInt(k.x) && BigInt(`0x${c.y}`) === BigInt(k.y)
/** The vault's member keys: as the chain held them when last read, or as set up. */
export const vaultMembers = (v: VaultRecord): { x: string; y: string }[] => v.current ? v.current.signers.filter((k) => k.role === 'member') : v.request.owner.signers
/**
 * The person's passkeys that are signers of this vault and may sign here now (neither removed nor suspended, and with
 * full authority: one a recovery registered signs in only, R12), less any excluded. Every passkey this module offers
 * for the vault (its set-up, its planned signers, the overview's list) is such a passkey.
 */
function signingKeys(db: Db, v: VaultRecord, personId: string, exclude: { x: string; y: string }[] = []): Credential[] {
  return approvingCredentials(db, personId).filter((c) => vaultMembers(v).some((k) => sameKey(c, k)) && !exclude.some((k) => sameKey(c, k)))
}
/** Keeps the vault record's signers as the rail reports them (`signers` of the workspace view or of GET /signers). */
export function rememberSigners(db: Db, ws: string, view: { signers?: unknown; threshold?: unknown; adminThreshold?: unknown }, now: number): VaultRecord | null {
  const v = vaultOf(db, ws)
  if (!v || !Array.isArray(view.signers)) return v
  // a role this server does not know is kept as neither a member nor a recovery key (R13: the guardian signs for nothing)
  const signers = (view.signers as { x?: unknown; y?: unknown; role?: unknown }[]).filter((k) => typeof k.x === 'string' && typeof k.y === 'string').map((k) => ({ x: String(k.x), y: String(k.y), role: k.role === 'recovery' ? 'recovery' as const : k.role === 'member' || k.role === undefined ? 'member' as const : 'guardian' as const }))
  v.current = { signers, threshold: Number(view.threshold) || v.request.owner.threshold, adminThreshold: Number(view.adminThreshold ?? view.threshold) || v.request.owner.threshold, syncedAt: now }
  saveVault(db, ws, v)
  return v
}

/**
 * Who would sign for a shared workspace's vault: every member whose role may sign, each with one passkey (the first
 * they registered that can sign today). One key per member, so that the account's threshold counts distinct people:
 * a member with two passkeys on the account could meet a threshold of two alone.
 */
function plannedSigners(db: Db, ws: string): { members: { personId: string; name: string; handle: string; role: Role; credential: Credential | null }[]; threshold: number } {
  // a passkey in its first 24 hours is not made a signer (server/passkeys.ts settledCredentials; RISK-068, Q-062)
  const list = members(db, ws).filter((m) => canSign(m.role)).map((m) => ({ personId: m.personId, name: m.name, handle: m.handle, role: m.role, credential: settledCredentials(db, m.personId, Date.now())[0] ?? null }))
  return { members: list, threshold: policyOf(db, ws).signers }
}
const isShared = (db: Db, ws: string): boolean => db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', ws)?.kind === 'business'

/** Everything the vault's first screen needs, or a plain statement of why there is nothing to show. */
export async function railOverview(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker): Promise<Json> {
  const v = vaultOf(db, who.workspaceId)
  const shared = isShared(db, who.workspaceId)
  const passkeysOf = (rec: VaultRecord | null) => approvingCredentials(db, who.personId).map((c) => ({ id: c.id, name: c.name, signer: rec ? vaultMembers(rec).some((k) => sameKey(c, k)) : null }))
  const passkeys = passkeysOf(v)
  // A shared workspace: who signs (one passkey per signing member) and how many must, planned or as set up.
  const plan = shared ? plannedSigners(db, who.workspaceId) : null
  const signersNow = v?.members?.map((m) => { const p = plan?.members.find((x) => x.personId === m.personId); const c = db.get<{ name: string }>('SELECT name FROM webauthn_credentials WHERE id = ?', m.credentialId); return { name: p?.name ?? 'A former member', passkey: c?.name ?? '', you: m.personId === who.personId } }) ?? null
  const canSetUp = shared ? who.role === 'owner' : who.workspaceId === who.personId
  const base = {
    // R14: for a household's own wallet, whether its passkeys can own one now, and if not why (the page says it before any press)
    ...(shared || !canSetUp ? {} : { owner: ownerReadiness(db, who.personId, Date.now()) }),
    custody: CUSTODY, setUp: !!v, canSetUp, ...(canSetUp ? {} : { whyNot: SHARED_OWNER }), passkeys, origin: v?.request.origin ?? null, origins: rp.origins, workspace: null, state: null, scheduled: [],
    shared, ...(plan ? { plan: { threshold: plan.threshold, members: plan.members.map((m) => ({ name: m.name, handle: m.handle, role: m.role, passkey: m.credential?.name ?? null })) } } : {}), ...(signersNow ? { signers: signersNow } : {}),
  }
  if (!railToken(cfg)) return { available: false, reason: OFF, ...base }
  let health: Json
  try { const r = await fetch(`${railBase()}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' }); health = (await r.json()) as Json } catch { return { available: false, reason: OFF, ...base } }
  if (health.ready !== true) return { available: false, reason: STARTING, health, ...base }
  if (health.mode !== 'multi-tenant') return { available: false, reason: BASELINE, health, ...base }
  if (!v) return { available: true, health, ...base }
  const ws = await rail(cfg, 'GET', at(v, ''))
  // The vault service was given a new data folder since: this vault no longer exists, and setting up makes a new one.
  if (ws.status === 404) return { available: true, health, ...base, setUp: false, lost: true }
  const workspace = answer(ws)
  // the signers as the chain holds them now (they change after set-up: RISK-053)
  const fresh = rememberSigners(db, who.workspaceId, workspace, Date.now())
  const live = workspace.status === 'ready' || workspace.status === 'awaiting-acceptance'
  const [state, scheduled] = live ? await Promise.all([must(cfg, 'GET', at(v, '/state')), must(cfg, 'GET', at(v, '/scheduled'))]) : [null, { scheduled: [] }]
  return { available: true, health, ...base, passkeys: passkeysOf(fresh), workspace, state, scheduled: (scheduled as Json).scheduled ?? [] }
}

// ------------------------------------------------------------------------------------------------ test tokens (S5)

const SETUP_UNFINISHED = 'A wallet set-up you started earlier stopped part of the way, and the wallet service is finishing it with the settings and passkeys you chose then, not these. Nothing was changed. Open the wallet again in a minute: once it says it is waiting for you, accept it with the passkey you used that first time. You can turn the time-lock on or off afterwards on the Security screen.'
const SHARED_CURRENCIES = 'A shared workspace\'s vault takes the default test tokens (test rupees, test dollars, test euros) for now: another set needs as many members\' passkey signatures as the vault\'s admin threshold, which this screen does not collect yet. Nothing was set up.'
/** A currency set from a request: three different currencies of the eight; null for the default (nothing to sign). */
function currencySet(x: unknown): AssetSet | null {
  try { const s = checkAssetSet(x); return isDefaultSet(s) ? null : s } catch (e) { if (e instanceof AssetSetError) throw bad(e.message); throw e }
}
/** The configuration a household owner's passkey signs for a set of test tokens other than the default (shared/chain-assets.ts). */
const currencyDocument = (request: CreateRequest, set: AssetSet) => assetSetDocument({ workspaceId: request.workspaceId, rpIdHash: request.rpIdHash, origin: request.origin, members: request.owner.signers, threshold: request.owner.threshold, adminThreshold: request.owner.adminThreshold ?? request.owner.threshold, currencies: set })
/**
 * R14: whether this person's passkeys can own a new wallet now and, if not, exactly why. One rule, read by the wallet's
 * page before anyone presses anything (railOverview's `owner`) and by the set-up itself (householdRequest), so the page
 * and the refusal never say different things.
 *   - `ready`: the passkeys that approve and are past their first 24 hours; they become the wallet's signers. `waiting`
 *     names any that approve but are still in those hours: they are left out, and can be made signers later.
 *   - `no-passkey`: the account signs in with a password only. Its first passkey has no 24-hour wait (server/passkeys.ts
 *     finishAddPasskey), so adding one and setting the wallet up is one sitting.
 *   - `signin-only`: its passkeys sign in but do not approve (a recovery's, or one added after a password reset, R12).
 *   - `cooling-off`: every passkey that approves was added beside another within 24 hours (RISK-068, Q-062); the
 *     earliest to finish is named with its time.
 */
export type OwnerReadiness =
  | { state: 'ready'; passkeys: string[]; waiting?: { passkey: string; until: number }[] }
  | { state: 'no-passkey' }
  | { state: 'signin-only' }
  | { state: 'cooling-off'; passkey: string; until: number }
export function ownerReadiness(db: Db, personId: string, now: number): OwnerReadiness {
  const approving = approvingCredentials(db, personId)
  if (!approving.length) return hasPasskey(db, personId) ? { state: 'signin-only' } : { state: 'no-passkey' }
  const waiting = approving.flatMap((c) => { const until = coolingOffUntil(db, c.id, now); return until === null ? [] : [{ passkey: c.name, until }] }).sort((a, b) => a.until - b.until)
  const settled = settledCredentials(db, personId, now)
  if (!settled.length) return { state: 'cooling-off', ...waiting[0]! }
  return { state: 'ready', passkeys: settled.map((c) => c.name), ...(waiting.length ? { waiting } : {}) }
}
/** What a set-up that cannot go ahead is told: what is wrong and what to do next. Null when it can. */
function ownerRefusal(r: OwnerReadiness): AppError | null {
  if (r.state === 'ready') return null
  if (r.state === 'signin-only') return restrictedError()
  // the wait in words: 24 hours, or the seconds of a labelled test stack (QED_COOL_OFF_SEC)
  const wait = COOL_OFF_MS >= 3600_000 ? `${Math.round(COOL_OFF_MS / 3600_000)} hours` : `${Math.round(COOL_OFF_MS / 1000)} seconds`
  if (r.state === 'cooling-off') return new AppError(409, 'passkey_cooling_off', `${r.passkey} was added to this account less than ${wait} ago, and a passkey can own a wallet only after its first ${wait}: someone who got into your session must not be able to put their own passkey on your wallet. Set the wallet up from ${whenIst(r.until)}. Nothing was created.`)
  return new AppError(409, 'passkey_needed', 'This account has no passkey yet, and a wallet is owned by a passkey. Add a passkey on this device first: enter your password on the wallet\'s page and your device makes one. Then set the wallet up. Nothing was created.')
}

/**
 * The request a household's vault would be set up with now: its passkeys past their first 24 hours (server/passkeys.ts
 * settledCredentials; RISK-068, Q-062), one to approve. railSetup and railCurrenciesBegin both use it, so the
 * configuration the owner signs names exactly the signers the vault is created with.
 */
function householdRequest(db: Db, rp: RelyingParty, who: Asker, origin: string, now: number): { request: CreateRequest; keys: Credential[] } {
  const refusal = ownerRefusal(ownerReadiness(db, who.personId, now))
  if (refusal) throw refusal
  const keys = settledCredentials(db, who.personId, now)
  if (keys.length > 12) throw bad('A vault takes at most 12 passkeys. Remove the ones you no longer use first.')
  const rpIdHash = `0x${createHash('sha256').update(rp.id, 'utf8').digest('hex')}`
  return { keys, request: { workspaceId: railWorkspaceId(who.workspaceId), owner: { signers: keys.map((c) => ({ x: `0x${c.x}`, y: `0x${c.y}` })), threshold: 1 }, rpIdHash, origin } }
}

/**
 * S5: before a household's vault is set up with test tokens other than the default, the owner's passkey signs the
 * configuration: this returns it, its digest and the passkey prompt over that digest (offered only to the passkeys that
 * will own the vault). Nothing is created or chosen here; railSetup sends it with the signature.
 */
export async function railCurrenciesBegin(db: Db, rp: RelyingParty, who: Asker, origin: unknown, currencies: unknown, now: number): Promise<Json> {
  if (isShared(db, who.workspaceId)) throw refused('currencies_shared', SHARED_CURRENCIES)
  if (who.workspaceId !== who.personId) throw new AppError(403, 'not_permitted', SHARED_OWNER)
  if (typeof origin !== 'string' || !rp.origins.includes(origin)) throw bad(`Set the vault up from QED itself, at ${rp.origins.join(' or ')}.`)
  const set = currencySet(currencies)
  if (!set) throw bad('These are the default test tokens: nothing needs signing. Set the vault up as usual.')
  if (vaultOf(db, who.workspaceId)) throw refused('vault_exists', 'This household already has a vault; its test tokens were fixed when it was set up. Nothing was changed.')
  const { request, keys } = householdRequest(db, rp, who, origin, now)
  const document = currencyDocument(request, set), digest = assetSetDigest(document)
  const ch = await beginReauth(db, rp, who.personId, 'approval', Uint8Array.from(Buffer.from(digest.slice(2), 'hex')), { kind: 'vault-currencies', digest, currencies: set }, now, keys.map((c) => c.id))
  return { document, digest, ...ch }
}

/** The owner's assertion over the set's configuration, checked here (passkeys.ts) and again by the vault service. */
async function currencyAssertion(db: Db, rp: RelyingParty, who: Asker, request: CreateRequest, set: AssetSet, choice: { challengeId?: unknown; response?: unknown }, now: number): Promise<Json> {
  const digest = assetSetDigest(currencyDocument(request, set))
  if (choice.challengeId === undefined || choice.response === undefined) throw refused('currencies_not_signed', 'Test tokens other than the default need your passkey\'s signature over them first. Nothing was set up.')
  const ok = await finishReauth(db, rp, who.session, 'approval', { challengeId: choice.challengeId, response: choice.response }, now)
  const c = ok.context as { kind?: string; digest?: string; currencies?: AssetSet }
  if (c.kind !== 'vault-currencies' || c.digest !== digest || !c.currencies || !sameSet(c.currencies, set)) throw refused('currencies_mismatch', 'That signature was made for other test tokens or other passkeys. Choose them again and sign. Nothing was set up.')
  if (!request.owner.signers.some((k) => sameKey(ok.credential, k))) throw refused('not_a_vault_signer', 'That passkey will not be a signer of the vault. Nothing was set up.')
  const resp = (choice.response as { response?: { authenticatorData?: unknown; clientDataJSON?: unknown; signature?: unknown } }).response ?? {}
  return { publicKey: { x: `0x${ok.credential.x}`, y: `0x${ok.credential.y}` }, authenticatorData: `0x${b64(resp.authenticatorData).toString('hex')}`, clientDataJSON: b64(resp.clientDataJSON).toString('utf8'), signature: `0x${b64(resp.signature).toString('hex')}` }
}

/**
 * Set up the household's vault: the rail deploys an owner account whose signers are the person's passkeys (one
 * signature suffices), and the vault set it is offered. Nothing is owned yet: the owner's first approval accepts it.
 * The account takes assertions from one web origin only, fixed now: the one the owner is using.
 */
export async function railSetup(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, origin: unknown, now: number, choice: { currencies?: unknown; challengeId?: unknown; response?: unknown; timeLock?: unknown } = {}): Promise<Json> {
  const shared = isShared(db, who.workspaceId)
  // R13: the time-lock, chosen at set-up (off unless asked for); changed later on the Security screen (off waits the delay)
  if (choice.timeLock !== undefined && typeof choice.timeLock !== 'boolean') throw bad('timeLock is true or false.')
  if (shared ? who.role !== 'owner' : who.workspaceId !== who.personId) throw new AppError(403, 'not_permitted', SHARED_OWNER)
  if (typeof origin !== 'string' || !rp.origins.includes(origin)) throw bad(`Set the vault up from QED itself, at ${rp.origins.join(' or ')}.`)
  // S5: the test tokens, the default unless the owner chose and signed another set (railCurrenciesBegin)
  const set = choice.currencies === undefined ? null : currencySet(choice.currencies)
  if (set && shared) throw refused('currencies_shared', SHARED_CURRENCIES)
  quota(db, who, now)
  let v = vaultOf(db, who.workspaceId)
  const stored = v // the record as it stood before this request (R14, review M2)
  // A vault set-up is the host's scarcest resource (60 an hour for everyone): a person sets up at most four a day (L-01).
  // The engine also asks each vault's service on its own schedule, which no request budget counts: so the vaults one
  // person owns are bounded too (their household's and their businesses').
  if (!v) {
    const owned = db.get<{ n: number }>(`SELECT COUNT(*) n FROM memberships m JOIN meta x ON x.key = 'vault.workspace:' || m.workspace_id WHERE m.person_id = ? AND m.role = 'owner' AND m.removed_at IS NULL`, who.personId)!.n
      + (db.get(`SELECT 1 FROM meta WHERE key = ?`, `vault.workspace:${who.personId}`) ? 1 : 0)
    if (owned >= VAULTS_PER_PERSON) throw refused('too_many_vaults', `You own ${owned} vaults, the most one person may own here. Nothing was set up.`)
    if (!rateLimit(db, `vault-setup:${who.personId}`, VAULT_SETUPS_PER_PERSON_DAY, 86_400_000, now)) throw new AppError(429, 'too_many', `You have set up ${VAULT_SETUPS_PER_PERSON_DAY} vaults today, the most for one person in a day. Try again tomorrow.`)
  }
  if (v) {
    const known = await rail(cfg, 'GET', at(v, ''))
    if (known.status === 200 && known.json.status !== 'deploying' && known.json.status !== 'failed') return known.json
    // Unknown to the vault service (its data folder was replaced): set up afresh, with the passkeys of today.
    if (known.status === 404) v = null
  }
  if (!v) {
    const railId = railWorkspaceId(who.workspaceId)
    const rpIdHash = `0x${createHash('sha256').update(rp.id, 'utf8').digest('hex')}`
    let keys: Credential[], owner: CreateRequest['owner'], who_: { personId: string; credentialId: string }[] | undefined
    if (shared) {
      const p = plannedSigners(db, who.workspaceId)
      const missing = p.members.filter((m) => !m.credential)
      if (missing.length) throw refused('passkey_needed', `${missing.map((m) => m.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no passkey that can sign. Every member who may sign needs one before the vault is set up.`)
      if (p.members.length > 12) throw bad('A vault takes at most 12 signers. This workspace has more members who may sign.')
      if (p.threshold > p.members.length) throw refused('threshold_too_high', `This workspace asks for ${p.threshold} signatures but only ${p.members.length} members may sign.`)
      keys = p.members.map((m) => m.credential!)
      who_ = p.members.map((m) => ({ personId: m.personId, credentialId: m.credential!.id }))
      owner = { signers: keys.map((c) => ({ x: `0x${c.x}`, y: `0x${c.y}` })), threshold: p.threshold, adminThreshold: p.threshold }
    } else {
      // the household's request, as railCurrenciesBegin computed it for a signed choice of test tokens (one function, one digest)
      const h = householdRequest(db, rp, who, origin, now)
      keys = h.keys
      owner = h.request.owner
    }
    const request: CreateRequest = { workspaceId: railId, owner, rpIdHash, origin, ...(choice.timeLock === true ? { timeLock: true } : {}) }
    // S5: a set other than the default goes only with the owner's passkey assertion over exactly this request's configuration
    if (set) Object.assign(request, { currencies: set, authorization: { assertions: [await currencyAssertion(db, rp, who, request, set, choice, now)] } })
    v = { railId, credentialIds: keys.map((c) => c.id), ...(who_ ? { members: who_ } : {}), createdAt: now, createdBy: who.personId, request }
    // Stored before the request, so that a lost reply is asked again with exactly the same body.
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', recordKey(who.workspaceId), j(v))
  }
  let view: Json
  try {
    view = await must(cfg, 'POST', '/workspaces', v.request, {}, 120_000)
  } catch (e) {
    // R14 (review M2): the service still holds a set-up begun earlier with other settings, one that stopped part of the way
    // (an outage, or a restart in the middle). It finishes that one exactly as it was asked, never this one, so the record
    // here goes back to that request: what the page shows, and the passkey it asks to accept, are what the chain will hold.
    if (e instanceof AppError && e.code === 'workspace_exists' && stored && stored !== v) {
      db.run('UPDATE meta SET value = ? WHERE key = ?', j(stored), recordKey(who.workspaceId))
      throw refused('setup_unfinished', SETUP_UNFINISHED)
    }
    throw e
  }
  audit(db, now, who.workspaceId, 'owner', 'vault.setup', v.railId, { signers: v.credentialIds, members: v.members?.map((m) => m.personId), threshold: v.request.owner.threshold, origin: v.request.origin, ownerAccount: view.ownerAccount, duplicate: view.duplicate === true, ...(v.request.currencies ? { currencies: v.request.currencies, signedDigest: (view.currencies as Json | undefined)?.digest ?? null } : {}) })
  // R7 D7: every other vault with a member in common is linked from the start (a failure is retried by the scheduler)
  await declareLinks(cfg, db, who.workspaceId, now).catch(() => undefined)
  return view
}

// ------------------------------------------------------------------------------------------------ reads, by name

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/
export const ID = /^[A-Za-z0-9-]{8,80}$/
export const HASH = /^0x[0-9a-fA-F]{64}$/
const limitOf = (q: URLSearchParams, max = 200): string => { const n = Number(q.get('limit') ?? ''); return Number.isInteger(n) && n >= 1 && n <= max ? `?limit=${n}` : '' }
const amountOf = (q: URLSearchParams): string => { const a = q.get('amount') ?? ''; if (!AMOUNT.test(a)) throw bad('Enter an amount with at most six decimals.', { amount: 'Enter an amount such as 12.5, with at most six decimals.' }); return `?amount=${a}` }

const READS: Record<string, (q: URLSearchParams) => string> = {
  mandates: () => '/mandates', history: (q) => `/history${limitOf(q)}`, attacks: () => '/attacks', maximum: () => '/maximum',
  limits: (q) => `/limits${amountOf(q)}`, quote: (q) => `/quote${amountOf(q)}`, policy: (q) => `/policy${limitOf(q)}`,
  scenarios: () => '/scenarios', economies: () => '/economies', evidence: () => '/evidence', jobs: (q) => `/jobs${limitOf(q)}`, clock: (q) => `/clock${limitOf(q)}`,
  decisions: (q) => { const j = q.get('jobId'); return j && ID.test(j) ? `/decisions?jobId=${j}` : `/decisions${limitOf(q)}` },
  'decisions-verify': () => '/decisions/verify', capabilities: () => '/language/capabilities',
  liabilities: () => '/liabilities', quota: () => '/quota', scheduled: () => '/scheduled',
  // Without an amount the vault service answers for the smallest unit, which shows what is left of each limit.
  'payment-limits': (q) => `/payments/limits${q.get('amount') ? amountOf(q) : ''}`,
}
export async function railRead(cfg: RailCfg, db: Db, who: Asker, name: string, query: URLSearchParams): Promise<Json> {
  // own keys only: `constructor`, `__proto__` or `valueOf` from the path otherwise reached Object's prototype (R13 review, hardening)
  const path = Object.hasOwn(READS, name) ? READS[name] : undefined
  if (!path) throw notFound('That')
  return must(cfg, 'GET', at(mustVault(db, who.workspaceId), path(query)))
}
export async function railItem(cfg: RailCfg, db: Db, who: Asker, what: 'jobs' | 'proposals' | 'receipts', id: string): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  if (!(what === 'receipts' ? HASH : ID).test(id)) throw notFound('That')
  return must(cfg, 'GET', at(v, `/${what}/${id}`))
}

// ------------------------------------------------------------------------------------------------ actions a principal signs

/** Vault requests that only stop something (pause, revoke, void, end a policy): never more signers than the chain asks. */
const STOPPING_KINDS = new Set(['pause', 'guardian-pause', 'revoke-mandate', 'void-all', 'policy-revoke'])
const KINDS = new Set(['provision', 'mandate', 'convert', 'attack', 'policy', 'policy-revoke', 'scenario', 'pause', 'guardian-pause', 'resume', 'revoke-mandate', 'void-all', 'rotate-key',
  // on the main treasury: a payment or a promise to an approved payee, money set aside for a creditor, the owner's own money in and out, the venue set
  'pay', 'ring-fence', 'withdraw', 'deposit', 'venues',
  // one passkey cancels a change scheduled behind the owner account's delay
  'cancel-change',
  // the owner adds to the agent's authority budget (R7 decision D7): signed by the passkey, moves no money
  'grant',
  // the owner's caps on earned authority (D-K1b): signed by the passkey; a lower one at once, a higher one after the delay
  'earned-caps'])
const NOTE_SIGNED = 'Your passkey signs the digests listed under "sign", one prompt for each, and nothing else. Each commits to exactly these terms on the chain; the chain checks the signature against your vault\'s owner account before anything runs, and the vault service only relays. The tokens are valueless test tokens on a local test chain.'
const NOTE_PLAIN = 'Nothing here is signed for your vault\'s owner account: this runs with the vault service\'s own keys (the guardian\'s, or those of a throwaway chain). Your passkey signs this document as your approval of exactly these terms, once. The tokens are valueless test tokens.'

/** One item of terms.toSign, as far as this layer needs it. */
interface ToSignItem { kind: 'execute' | 'erc1271' | 'cancel'; digest: string; threshold: number; purpose?: string }
const itemsOf = (terms: unknown): ToSignItem[] => {
  const t = (terms as { toSign?: unknown } | null)?.toSign
  return Array.isArray(t) ? (t as ToSignItem[]).filter((x) => x && typeof x.digest === 'string' && HASH.test(x.digest)) : []
}

/**
 * What one workspace, and one person over all their workspaces, may ask of the vault service in an hour. The service's
 * own budgets are per workspace and host-wide (2,400 operations an hour for everyone): without the person's own limit,
 * one person with a handful of business workspaces could spend the host's budget and stop every household's vault
 * (R13 review, lead L-01). A person's limit is two workspaces' worth.
 */
export const RAIL_PER_WORKSPACE_HOUR = 240, RAIL_PER_PERSON_HOUR = 480, VAULT_SETUPS_PER_PERSON_DAY = 4, VAULTS_PER_PERSON = 10
export function quota(db: Db, who: Pick<Asker, 'workspaceId' | 'personId'>, now: number): void {
  if (!rateLimit(db, `rail:${who.workspaceId}`, RAIL_PER_WORKSPACE_HOUR, 3600_000, now)) throw new AppError(429, 'too_many', `That is ${RAIL_PER_WORKSPACE_HOUR} vault requests in an hour. Wait a while.`)
  if (!rateLimit(db, `rail-person:${who.personId}`, RAIL_PER_PERSON_HOUR, 3600_000, now)) throw new AppError(429, 'too_many', `That is ${RAIL_PER_PERSON_HOUR} vault requests in an hour from you, over all your workspaces. Wait a while.`)
}

/** Ask the rail for the exact terms of an action and open an approval request for them. Nothing is signed. */
export async function railPropose(cfg: RailCfg, db: Db, who: Asker, raw: Json, now: number): Promise<Json> {
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!KINDS.has(kind)) throw bad('That is not something the vault can be asked to do.')
  const params = typeof raw.params === 'object' && raw.params !== null && !Array.isArray(raw.params) ? raw.params as Json : {}
  return proposeOnRail(cfg, db, who, kind, params, now)
}

/**
 * The same for a kind the generic route does not offer (signers, recovery keys, escrow work): the caller has checked
 * who may ask for it and with what. `shown` is added to the approval document, for the person to read: it can never
 * replace the terms, their hash or what is to be signed.
 */
export async function proposeOnRail(cfg: RailCfg, db: Db, who: Asker, kind: string, params: Json, now: number, shown: Json = {}): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  quota(db, who, now)
  const p = await must(cfg, 'POST', at(v, '/proposals'), { kind, params })
  const items = itemsOf(p.terms)
  const sign = items.map((t, i) => ({ item: i, kind: t.kind, ...(t.purpose ? { purpose: t.purpose } : {}), digest: t.digest, signers: t.threshold }))
  // A request prepared in a password session says so in its document (RISK-076), which the sheet shows before signing.
  const prepared = passwordWork(db, who.workspaceId, { request: true }, now)
  const document = canonical({ ...shown, v: 2, kind: 'vault-proposal', vault: v.railId, proposalId: p.id, action: p.kind, summary: p.summary, terms: p.terms, termsHash: p.termsHash, network: p.network, sign, note: items.length ? NOTE_SIGNED : NOTE_PLAIN, ...(prepared.length ? { prepared } : {}) })
  // The chain's own thresholds are the least that signs (one for a cancellation, the account's threshold otherwise). A
  // shared workspace's own count, when it is larger (raised after the vault was set up), is checked here, by QED: the
  // account has one threshold (R13 review, lead L-03). A cancellation and the calls that only stop things keep the
  // chain's count, so stopping never needs more people than the chain asks for. The approval lapses with the vault
  // service's proposal, which is good for ten minutes.
  const own = STOPPING_KINDS.has(kind) ? 1 : policyOf(db, who.workspaceId).signers
  // R13 (D-l): a household's vault may need two of the person's own passkeys ("Require two of your devices"): then one
  // person signs, with as many different passkeys as the chain's threshold for each digest (railSignBegin/Finish), and
  // the chain checks that count itself. In a shared workspace each member has one passkey, so the count is people.
  const required = items.length ? (isShared(db, who.workspaceId) ? Math.max(...items.map((t) => Math.max(Number(t.threshold) || 1, t.kind === 'cancel' ? 1 : own))) : 1) : undefined
  const ttlMs = Math.max(60_000, (Date.parse(String(p.expiresAt)) || now + 600_000) - now)
  const a = createApproval(db, who.workspaceId, { purpose: 'rail', subject: `rail:${String(p.id)}`, document, requiresStepUp: true, ttlMs, ...(required ? { required } : {}) }, now)
  audit(db, now, who.workspaceId, 'owner', 'vault.propose', String(p.id), { kind, termsHash: p.termsHash, toSign: items.length })
  // R13 (D-l): how many of the person's own passkeys sign it, in a household (one in a shared workspace)
  const devices = items.length && !isShared(db, who.workspaceId) ? Math.max(1, ...items.map((t) => (t.kind === 'cancel' ? 1 : Number(t.threshold) || 1))) : 1
  return { proposal: p, approvalId: a.id, docHash: a.doc_hash, expiresAt: Math.min(a.expires_at, Date.parse(String(p.expiresAt)) || a.expires_at), requiresStepUp: true, sign, devices }
}

function railApproval(db: Db, who: Asker, approvalId: string): { a: NonNullable<ReturnType<typeof getApproval>>; doc: { termsHash: string; action: string; proposalId: string; vault: string; terms: unknown }; items: ToSignItem[] } {
  const a = getApproval(db, who.workspaceId, approvalId)
  if (!a || a.purpose !== 'rail') throw notFound('That approval')
  if (sha256hex(a.document) !== a.doc_hash) throw new AppError(500, 'approval_corrupt', 'The stored document does not match its fingerprint. Nothing was done.')
  const doc = JSON.parse(a.document) as { termsHash: string; action: string; proposalId: string; vault: string; terms: unknown }
  return { a, doc, items: itemsOf(doc.terms) }
}

/**
 * The passkey prompts for an approval whose terms list digests for the chain: one per digest, each digest being the
 * challenge, offered only to the person's passkeys that are signers of this vault.
 *
 * R13 (D-l, "Require two of your devices"): in a household whose vault's threshold is 2 or more, one person signs each
 * digest with that many DIFFERENT passkeys of their own, one device per round: this round's prompts are for the digests
 * that still need an assertion, offered only to the person's signing passkeys not used yet for this approval. A
 * cancellation always takes exactly one.
 */
export async function railSignBegin(db: Db, rp: RelyingParty, who: Asker, approvalId: string, now: number): Promise<{ challenges: { challengeId: string; options: unknown }[]; devices: { needed: number; done: number } }> {
  const v = mustVault(db, who.workspaceId)
  const { a, items } = railApproval(db, who, approvalId)
  if (!items.length) throw refused('nothing_for_the_chain', 'These terms have nothing for your vault\'s owner account to sign. Approve them with your passkey as usual.')
  if (a.cancelled_at || a.confirmed_at || now > a.expires_at) throw refused('approval_closed', 'That approval request is no longer open. Prepare the action again.')
  // a removal names the keys it removes: none of them may sign its cancellation (the owner account refuses it anyway)
  const targets = (((JSON.parse(a.document) as { terms?: { kind?: string; change?: { targets?: unknown } } }).terms?.change?.targets ?? []) as { x: string; y: string }[]).filter((k) => typeof k?.x === 'string' && typeof k?.y === 'string')
  const rounds = deviceRounds(db, who, a.id, items)
  const keys = signingKeys(db, v, who.personId, targets).filter((c) => !rounds.used.has(c.id))
  if (!keys.length && rounds.used.size) throw refused('another_device_needed', `This vault needs ${rounds.needed} different passkeys of yours for this approval, and none you have not used for it yet can sign today. Add another passkey as a signer under Security, or ask for a lower threshold (that waits the vault's delay).`)
  if (!keys.length) throw refused('not_a_vault_signer', targets.length ? 'None of your passkeys may sign this: a passkey cannot cancel its own removal. Another signer must.' : 'None of your passkeys that can sign today is a signer of this vault. Add one under Vault › Signers, signed by a passkey that is.')
  const challenges = []
  for (const i of rounds.todo) {
    const t = items[i]!
    challenges.push(await beginReauth(db, rp, who.personId, 'approval', Uint8Array.from(Buffer.from(t.digest.slice(2), 'hex')), { approvalId: a.id, docHash: a.doc_hash, item: i, digest: t.digest.toLowerCase() }, now, keys.map((c) => c.id)))
  }
  return { challenges, devices: { needed: rounds.needed, done: rounds.used.size } }
}

/** One assertion of the approval's evidence: the digest it signs, by which passkey, as the browser returned it. */
type VaultEntry = Json & { item: number; digest: string; credentialId: string }
const devicesKey = (approvalId: string): string => `vault.devices:${approvalId}`
/**
 * R13 (D-l): where a household's signing of this approval stands: the assertions earlier rounds gave (kept in meta until
 * the last round), the passkeys they used, how many each digest needs (the chain's threshold; one for a cancellation;
 * one in a shared workspace, whose members sign one each), and which digests this round must still sign.
 */
function deviceRounds(db: Db, who: Asker, approvalId: string, items: ToSignItem[]): { entries: VaultEntry[]; used: Set<string>; needed: number; need: number[]; todo: number[] } {
  const shared = isShared(db, who.workspaceId)
  const need = items.map((t) => (shared || t.kind === 'cancel' ? 1 : Math.max(1, Number(t.threshold) || 1)))
  const saved = shared ? null : parse<{ person: string; entries: VaultEntry[] } | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', devicesKey(approvalId))?.value ?? 'null', null)
  const entries = saved && saved.person === who.personId ? saved.entries : []
  const todo = items.map((_, i) => i).filter((i) => entries.filter((e) => e.item === i).length < need[i]!)
  return { entries, used: new Set(entries.map((e) => e.credentialId)), needed: Math.max(...need), need, todo }
}

const b64 = (s: unknown): Buffer => { if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw bad('That passkey response is malformed.'); return Buffer.from(s, 'base64url') }

/**
 * Verify one assertion per digest and record them as this person's signature of the approval. Each must be by a
 * signer of the vault, over exactly that digest, from the web origin the owner account accepts.
 *
 * R13 (D-l): in a household whose vault needs two or more of the person's passkeys, each round signs the digests that
 * still need one, all with ONE passkey not used before for this approval; the rounds are kept, and the person's
 * signature is recorded (and the approval complete) only once every digest has as many assertions, by different
 * passkeys, as the chain asks for. The chain still checks that count; this only collects it.
 */
export async function railSignFinish(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, approvalId: string, responses: unknown, docHash: string, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  const { a, items } = railApproval(db, who, approvalId)
  const rounds = deviceRounds(db, who, a.id, items)
  if (!items.length || !Array.isArray(responses) || responses.length !== rounds.todo.length) throw bad(`These terms need ${rounds.todo.length} passkey signature${rounds.todo.length === 1 ? '' : 's'} now, one for each digest still to sign.`)
  if (docHash !== a.doc_hash) throw refused('approval_mismatch', 'What was shown does not match what the server holds. Nothing was approved.')
  const vault: VaultEntry[] = []
  for (const [k, i] of rounds.todo.entries()) {
    const t = items[i]!
    const r = responses[k] as { challengeId?: unknown; response?: unknown } | null
    const ok = await finishReauth(db, rp, who.session, 'approval', { challengeId: r?.challengeId, response: r?.response }, now)
    const c = ok.context
    if (c.approvalId !== a.id || c.docHash !== a.doc_hash || c.item !== i || c.digest !== t.digest.toLowerCase()) throw refused('approval_mismatch', 'That signature was made for something else. Nothing was approved.')
    if (!vaultMembers(v).some((k) => sameKey(ok.credential, k))) throw refused('not_a_vault_signer', 'That passkey is not a signer of this vault. Nothing was approved.')
    // R13: a round is one device, and a device signs each digest once
    if (rounds.used.has(ok.credential.id)) throw refused('same_device', `"${ok.credential.name}" has already signed this approval. The vault needs ${rounds.needed} different passkeys of yours: use another one. Nothing was recorded for this round.`)
    if (vault.length && vault[0]!.credentialId !== ok.credential.id) throw refused('one_device_per_round', 'Sign every prompt of a round with the same passkey. Nothing was recorded for this round.')
    const resp = (r!.response as { response?: { authenticatorData?: unknown; clientDataJSON?: unknown; signature?: unknown } }).response ?? {}
    const clientDataJSON = b64(resp.clientDataJSON).toString('utf8')
    const origin = parse<{ origin?: string }>(clientDataJSON, {}).origin
    if (origin !== v.request.origin) throw refused('vault_origin', `Your vault takes signatures made at ${v.request.origin} only; this one was made at ${origin ?? 'an unknown origin'}. Open QED at ${v.request.origin} to sign. Nothing was approved.`)
    vault.push({ item: i, digest: t.digest.toLowerCase(), credentialId: ok.credential.id, publicKey: { x: `0x${ok.credential.x}`, y: `0x${ok.credential.y}` }, authenticatorData: `0x${b64(resp.authenticatorData).toString('hex')}`, clientDataJSON, signature: `0x${b64(resp.signature).toString('hex')}` })
  }
  const all = [...rounds.entries, ...vault]
  if (items.some((_, i) => all.filter((e) => e.item === i).length < rounds.need[i]!)) {
    // not every digest has its devices yet: keep this round and ask for the next device
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', devicesKey(a.id), j({ person: who.personId, entries: all, expiresAt: a.expires_at }))
    audit(db, now, who.workspaceId, 'owner', 'vault.sign.device', a.id, { device: rounds.used.size + 1, of: rounds.needed })
    return { id: a.id, confirmedAt: null, method: 'passkey', complete: false, signed: 0, required: a.required_signers, devices: { needed: rounds.needed, done: rounds.used.size + 1, next: 'another-device' } }
  }
  const s = signApproval(db, who.workspaceId, a.id, { personId: who.personId, role: who.role, credentialId: String(all[0]!.credentialId), evidence: { vault: all }, sessionHash: who.session.sessionHash }, docHash, now)
  db.run('DELETE FROM meta WHERE key = ?', devicesKey(a.id))
  // In a shared workspace the last member to sign may be on another screen than whoever prepared it: it is sent here.
  // Sending is safe to repeat: the approval's id is the vault service's idempotency key.
  const sent = s.complete && s.required > 1 ? await railExecute(cfg, db, who, String((JSON.parse(a.document) as { proposalId: string }).proposalId), a.id, now) : null
  return { id: a.id, confirmedAt: s.approval.confirmed_at, method: 'passkey', complete: s.complete, signed: s.signed, required: s.required, ...(rounds.needed > 1 ? { devices: { needed: rounds.needed, done: rounds.needed } } : {}), ...(sent ? { jobId: sent.jobId } : {}) }
}

/** The approval's sixth field for the rail: for each digest, every recorded assertion over it. */
function signaturesOf(db: Db, approvalId: string, items: ToSignItem[]): { assertions: Json[] }[] {
  const rows = db.all<{ evidence_json: string }>('SELECT evidence_json FROM approval_signatures WHERE approval_id = ? ORDER BY signed_at', approvalId)
  const all = rows.flatMap((r) => parse<{ vault?: (Json & { item: number })[] }>(r.evidence_json, {}).vault ?? [])
  return items.map((t, i) => ({
    assertions: all.filter((e) => e.item === i && e.digest === t.digest.toLowerCase()).map((e) => ({ publicKey: e.publicKey, authenticatorData: e.authenticatorData, clientDataJSON: e.clientDataJSON, signature: e.signature })),
  }))
}

/** Tell the rail to act under a confirmed approval. Safe to repeat: the approval's id is the idempotency key. */
export async function railExecute(cfg: RailCfg, db: Db, who: Asker, proposalId: string, approvalId: string, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  if (!ID.test(proposalId)) throw notFound('That proposal')
  const { a, doc, items } = railApproval(db, who, approvalId)
  if (a.subject !== `rail:${proposalId}` || doc.vault !== v.railId) throw notFound('That approval')
  if (a.cancelled_at) throw refused('approval_withdrawn', 'That approval was withdrawn.')
  if (!a.confirmed_at) throw refused('approval_missing', 'Confirm the approval first.')
  // An approval that was never used lapses. One that was used may be presented again: the vault service answers with
  // the same job, which is how a lost reply is recovered.
  if (approvalLapsed(a, now)) throw refused('approval_expired', LAPSED_TEXT)
  const signatures = items.length ? signaturesOf(db, a.id, items) : null
  if (signatures?.some((s) => s.assertions.length === 0)) throw refused('approval_signature_missing', 'This approval does not carry your passkey\'s signature for every digest of the terms. Approve it again.')
  // A passkey suspended (or removed) after it signed: QED sends nothing it signed. The chain would still accept it until
  // its removal from the vault applies, which is why the vault's signers view asks for that removal.
  if (a.consumed_at === null && items.length) {
    const used = db.all<{ evidence_json: string }>('SELECT evidence_json FROM approval_signatures WHERE approval_id = ?', a.id).flatMap((r) => parse<{ vault?: { credentialId?: string }[] }>(r.evidence_json, {}).vault ?? []).map((e) => String(e.credentialId))
    const gone = used.length ? db.all<{ name: string }>(`SELECT name FROM webauthn_credentials WHERE id IN (${used.map(() => '?').join(',')}) AND (suspended_at IS NOT NULL OR removed_at IS NOT NULL)`, ...used) : []
    if (gone.length) throw refused('signer_suspended', `The passkey "${gone[0]!.name}" signed this and has been suspended or removed since. Nothing was sent: sign it again with a passkey that can sign.`)
  }
  db.run('UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?) WHERE id = ?', now, a.id)
  const approval = { approvalId: a.id, docHash: `sha256:${a.doc_hash}`, termsHash: doc.termsHash, confirmedAt: new Date(a.confirmed_at).toISOString(), method: a.method ?? 'passkey', ...(signatures ? { signatures } : {}) }
  const accepted = await must(cfg, 'POST', at(v, `/proposals/${proposalId}/execute`), { approval }, { 'Idempotency-Key': a.id })
  audit(db, now, who.workspaceId, 'owner', 'vault.execute', proposalId, { approvalId: a.id, action: doc.action, jobId: accepted.jobId, duplicate: accepted.duplicate, signatures: signatures?.length ?? 0 })
  return accepted
}

export async function railCancel(cfg: RailCfg, db: Db, who: Asker, proposalId: string): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  if (!ID.test(proposalId)) throw notFound('That proposal')
  return must(cfg, 'POST', at(v, `/proposals/${proposalId}/cancel`), {})
}

// ------------------------------------------------------------------------------------------------ actions under authority already signed

const RUNS: Record<string, (b: Json) => Json> = {
  'policy/tick': () => ({}),
  'policy/run': (b) => ({ ...(Number.isInteger(b.maxTicks) ? { maxTicks: b.maxTicks } : {}), ...(Number.isInteger(b.maxSeconds) ? { maxSeconds: b.maxSeconds } : {}) }),
  'economies/run': (b) => ({ scenario: b.scenario, ...(typeof b.instruction === 'string' ? { instruction: b.instruction } : {}), ...(b.impact === 50 || b.impact === 150 ? { impact: b.impact } : {}) }),
}
const keyOf = (body: Json): string => { const key = typeof body.key === 'string' && ID.test(body.key) ? body.key : ''; if (!key) throw bad('The request is missing its key.'); return key }

/**
 * A policy tick, a policy run or a scripted economy. No principal signs: a tick acts only under a policy the owner
 * already signed, and a script runs on fresh contracts with its own roles. The interface supplies a key for each
 * press of a button so that a repeated request is the same job.
 */
export async function railRun(cfg: RailCfg, db: Db, who: Asker, what: string, body: Json, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  quota(db, who, now)
  const shape = RUNS[what]
  if (!shape) throw notFound('That')
  // R7-091: a tick or a run is QED acting under the standing policy, which a pause stops whoever asks; the owner's own
  // conversions, signed with the passkey, are not affected. Refused here, before the vault service is asked.
  if ((what === 'policy/tick' || what === 'policy/run') && db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', who.workspaceId)?.stop_at != null) {
    throw refused('paused', 'QED is paused, so the standing policy does not run, on its own or on request. Resume QED to run it; nothing was converted. A conversion you sign yourself still works.')
  }
  const accepted = await must(cfg, 'POST', at(v, `/${what}`), shape(body), { 'Idempotency-Key': `ui-${keyOf(body)}` })
  audit(db, now, who.workspaceId, 'owner', `vault.${what.replace('/', '-')}`, String(accepted.jobId ?? ''), {})
  return accepted
}

/**
 * Pay a promise that has fallen due to its creditor. No one signs: the contract lets anyone do this, even while the
 * vault is paused, and it can only pay the creditor named when the promise was made.
 */
export async function railSettle(cfg: RailCfg, db: Db, who: Asker, id: string, body: Json, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  quota(db, who, now)
  if (!/^\d{1,9}$/.test(id)) throw notFound('That promise')
  const accepted = await must(cfg, 'POST', at(v, `/liabilities/${id}/settle`), {}, { 'Idempotency-Key': `ui-${keyOf(body)}` })
  audit(db, now, who.workspaceId, 'owner', 'vault.liability-settle', String(accepted.jobId ?? ''), { liability: id })
  return accepted
}

/**
 * Apply a change that was scheduled behind the owner account's delay, once the delay has passed. No one signs: the
 * account lets anyone apply it then, and only exactly the calls that were approved. Before then the rail answers
 * with a refusal and sends nothing.
 */
export async function railApplyChange(cfg: RailCfg, db: Db, who: Asker, changeId: string, body: Json, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  quota(db, who, now)
  if (!HASH.test(changeId)) throw notFound('That change')
  const accepted = await must(cfg, 'POST', at(v, `/scheduled/${changeId}/apply`), {}, { 'Idempotency-Key': `ui-${keyOf(body)}` })
  audit(db, now, who.workspaceId, 'owner', 'vault.change-apply', String(accepted.jobId ?? ''), { changeId })
  return accepted
}

const LANGUAGE = new Set(['screen', 'validate', 'parse', 'amount', 'topic'])
/** The release's guard, strict amount parser, tool validation and labelled offline parser. They propose; they execute nothing. */
export async function railLanguage(cfg: RailCfg, db: Db, who: Asker, fn: string, body: Json, now: number): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  quota(db, who, now)
  if (!LANGUAGE.has(fn)) throw notFound('That')
  return must(cfg, 'POST', at(v, `/language/${fn}`), body)
}

/**
 * The scheduler for the standing vault policies. Each owner signed their policy; the rail decides each tranche and
 * the co-signer re-derives it. This only asks, for every vault with an active policy, on a fixed five-minute grid,
 * so a restart or a repeated call lands on the same key and cannot convert twice for one slot. Returns what it did,
 * for the engine's own record.
 *
 * A workspace whose owner pressed "Stop everything" (users.stop_at) is not ticked, in either stop mode: the vault's
 * policy is treasury automation, not protective selling, so keeping protective selling running does not keep it.
 *
 * `asked` (R13, Topic F): the engine passes the slot keys it has already asked for and calls this every half minute, so
 * a policy the owner has just signed is ticked by the engine within about 30 seconds, in the slot it was signed in,
 * rather than at the start of the next five-minute slot; a policy already asked for in this slot is not asked again.
 * Without it (a restart, or a test) every active policy is asked for, and the vault service answers a repeated key with
 * the same job, so one slot still converts at most once.
 */
export async function railPolicySchedule(cfg: RailCfg, db: Db, now: number, asked?: Set<string>): Promise<string> {
  if (!railToken(cfg)) return 'no vault service'
  const vaults = db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'vault.workspace:%' ORDER BY key`)
    .map((r) => ({ ws: r.key.slice('vault.workspace:'.length), v: parse<VaultRecord | null>(r.value, null) })).filter((x): x is { ws: string; v: VaultRecord } => !!x.v)
  if (!vaults.length) return 'no vault'
  const slot = Math.floor(now / 300_000)
  if (asked) for (const k of asked) if (!k.endsWith(`-${slot}`)) asked.delete(k)
  const did: string[] = [], paused: string[] = []
  let waiting = 0
  for (const { ws, v } of vaults) {
    // R7 D7: a member who joined since is linked before anything is ticked (links only ever make the budget stricter)
    await declareLinks(cfg, db, ws, now).catch(() => undefined)
    // R13: a passkey suspended or removed in QED is frozen on the chain; a freeze that could not be sent is sent now
    await (await import('./rail-signers.ts')).containVault(cfg, db, ws, now).catch(() => undefined)
    // Each workspace's line is its own event (R13 review, lead L-08): the engine's line for everyone names no workspace.
    if (db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', ws)?.stop_at != null) { paused.push(`not ticked in ${v.railId}: paused by the owner`); emit(db, now, ws, 'vault', { what: paused.at(-1) }); continue }
    const st = await rail(cfg, 'GET', at(v, '/state')).catch(() => null)
    const policy = st?.status === 200 ? (st.json.policy as { id: number; status: string; targetMet: boolean } | null) : null
    if (!policy || policy.status !== 'active' || policy.targetMet) continue
    const key = `sched-${policy.id}-${slot}`
    if (asked?.has(key)) { waiting++; continue }
    await refusedTicks(cfg, db, ws, v, now)
    const r = await rail(cfg, 'POST', at(v, '/policy/tick'), {}, { 'Idempotency-Key': key }).catch(() => null)
    if (r && r.status === 202) asked?.add(key)
    did.push(r && r.status === 202 ? `tick ${String(r.json.jobId)} in ${v.railId}${r.json.duplicate ? ' (already asked for this slot)' : ''}` : `tick not accepted in ${v.railId} (${r?.status ?? 'no answer'})`)
    emit(db, now, ws, 'vault', { what: did.at(-1) })
  }
  // ticks first: the engine announces a run whose report starts with one
  return did.length || paused.length ? [...did, ...paused].join('; ') : waiting ? 'each active policy already asked for in this slot' : 'no active policy'
}

/**
 * Why the latest tick was refused, as one sentence for a notice on Home: the co-signer's rule by its name when
 * the co-signer refused it, else the record's first sentence with any account address put in words. The full record,
 * with its figures and addresses, stays on the wallet's own pages (a money overview shows no raw identifiers).
 */
export function refusalReason(summary: string | null | undefined): string {
  const s = String(summary ?? '')
  const m = /^Co-signer refused: (C\d+) not met: ([^:]+):/.exec(s)
  // the rule by its name only: its number and the research decision it comes from are references, not household words
  if (m) return `The co-signer refused the latest under its ${m[2]!.replace(/\s*\((?:R\d+ )?(?:decision )?D\d+[^)]*\)/g, '').trim().toLowerCase()} rule.`
  const first = (s.split(/(?<=\.)\s/)[0] ?? '').replace(/0x[0-9a-fA-F]{8,}/g, 'an account').trim()
  return first ? `The latest was refused: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}${/[.!?]$/.test(first) ? '' : '.'}` : 'The latest was refused.'
}

/**
 * R7-111 F6: a standing policy that keeps being refused converts nothing, quietly, every five minutes. When its last
 * three finished ticks were all refused, the owner is told once, under "Needs you", with the latest reason; the notice
 * is kept current while it lasts and resolved when a tick goes through.
 */
async function refusedTicks(cfg: RailCfg, db: Db, ws: string, v: VaultRecord, now: number): Promise<void> {
  const r = await rail(cfg, 'GET', at(v, '/jobs?limit=30')).catch(() => null)
  if (r?.status !== 200) return
  const ticks = ((r.json.jobs ?? []) as { kind: string; status: string; result?: { outcome?: string; summary?: string } | null }[]).filter((j) => (j.kind === 'policy-tick' || j.kind === 'policy-run') && j.status === 'done').slice(0, 3)
  if (ticks.length === 3 && ticks.every((j) => j.result?.outcome === 'refused')) {
    notice(db, ws, { level: 'action', kind: 'vault-policy-refused', title: 'Your on-chain wallet\'s standing policy keeps being refused', body: `Its last three ticks converted nothing. ${refusalReason(ticks[0]!.result?.summary)} It tries again every five minutes. You can grant the agent more authority, change the policy in Grow, or revoke it; each tick's full record is on the wallet's "Automatic conversions" page.`, subject: ws, dedupe: `vault-policy-refused:${ws}`, rolling: true }, now)
  } else if (ticks[0] && ticks[0].result?.outcome !== 'refused') resolveNotices(db, ws, `vault-policy-refused:${ws}`, now)
}

// ------------------------------------------------------------------------------------------------ links for the authority budget

const LINKS_KEY = 'vault.links.declared'
/**
 * R7 D7, assumption A-ID: no workspace may count as an outside client of a workspace it has (or had) a member in
 * common with. The vault service knows keys, not people, so QED declares those links: every other workspace with a
 * vault that shares a member with `ws`, former members included. Links are only ever added, by the rail and here; a
 * pair declared from either side is not declared again. Returns the newly declared rail workspaces.
 */
export async function declareLinks(cfg: RailCfg, db: Db, ws: string, now: number): Promise<string[]> {
  const v = vaultOf(db, ws)
  if (!v) return []
  const others = db.all<{ ws: string }>('SELECT DISTINCT b.workspace_id ws FROM memberships a JOIN memberships b ON b.person_id = a.person_id WHERE a.workspace_id = ? AND b.workspace_id <> ? ORDER BY b.workspace_id', ws, ws)
  const linked = others.map((o) => vaultOf(db, o.ws)?.railId).filter((x): x is string => !!x).sort()
  const done = new Set(parse<string[]>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', LINKS_KEY)?.value ?? '[]', []))
  const pair = (a: string, b: string): string => [a, b].sort().join('|')
  const fresh = linked.filter((id) => !done.has(pair(v.railId, id)))
  if (!fresh.length) return []
  const r = await must(cfg, 'POST', at(v, '/links'), { workspaces: linked })
  const unknown = new Set(Array.isArray(r.unknown) ? (r.unknown as string[]) : [])
  for (const id of linked) if (!unknown.has(id)) done.add(pair(v.railId, id))
  db.tx(() => {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', LINKS_KEY, j([...done].sort()))
    audit(db, now, ws, 'system', 'vault.links', v.railId, { declared: fresh.filter((x) => !unknown.has(x)), unknown: [...unknown] })
  })
  return fresh.filter((x) => !unknown.has(x))
}

/**
 * D-K1b: a raise of the earned-authority caps is a loosening (server/loosening.ts): when the owner gives one to the vault
 * service, the person who approved it (in a shared workspace, every member who may sign) and the person's recovery
 * contacts are told at once, and QED remembers the raise so that the engine tells them again when it comes into force
 * (vault-watch.ts). `doc` is the approval's document: the rail's terms, which name each cap's change.
 */
export function announceCapsRaise(db: Db, who: Asker, doc: { action?: string; terms?: unknown }, jobId: string, now: number): number {
  if (doc.action !== 'earned-caps') return 0
  const t = (doc.terms ?? {}) as { nonce?: unknown; delaySeconds?: unknown; perWindowRaw?: unknown; perPayerRaw?: unknown; changes?: { cap: string; effect: string; text: string }[] }
  const raises = (t.changes ?? []).filter((c) => c.effect === 'raise')
  if (!raises.length || typeof t.nonce !== 'string') return 0
  const effectiveAt = now + Number(t.delaySeconds ?? 0) * 1000
  const detail = { workspaceId: who.workspaceId, jobId, nonce: t.nonce, effectiveAt, raises: raises.map((c) => c.text) }
  const people = new Set([who.personId, ...(who.workspaceId === who.personId ? [] : members(db, who.workspaceId).filter((m) => canSign(m.role)).map((m) => m.personId))])
  for (const person of people) securityEvent(db, person, 'vault-earned-caps-raise-scheduled', detail, now)
  for (const c of activeContacts(db, who.personId, now)) securityEvent(db, c, 'contact-loosening-scheduled', { for: handleOf(db, who.personId), effectiveAt }, now)
  const values = Object.fromEntries(raises.map((c) => [c.cap, String(c.cap === 'perWindow' ? t.perWindowRaw : t.perPayerRaw)]))
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', `vault.caps-raise:${who.workspaceId}:${t.nonce}`, j({ ...detail, people: [...people], caps: raises.map((c) => c.cap), values }))
  return people.size
}
