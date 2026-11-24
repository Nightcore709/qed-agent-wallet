/**
 * Earning on the chain from the wallet's Earn flow (R7-054). The same records as the paper flow (earn_jobs and
 * earn_milestones, server/owner.ts): a job for a client who is another QED account, each milestone one job of the
 * release's ProofEscrow on the local chain, between the two vaults. The steps, and who takes each:
 *
 *   quote     PROVIDER. Its vault's passkeys sign the quote (rail kind escrow-quote): price, deadline, the problem, the
 *             client's owner account, payment into the provider's vault. No money moves. The milestone is "offered".
 *   fund      CLIENT. Its vault's passkeys sign one transaction of its owner account (escrow-fund): the price leaves its
 *             own vault's free funds and the escrow holds it. The milestone is "funded".
 *   deliver   PROVIDER. The certificate (computed by the release's certifying solver on the rail) is checked by the
 *             verifier on the chain before anything is signed; the delivery pays the provider's vault in the same
 *             transaction (escrow-deliver). The milestone is "released". Its evidence hash is the solution's hash.
 *   release   PROVIDER, before the deadline: the escrow refunds the client (escrow-release). "refunded".
 *   refund    CLIENT or PROVIDER, after the deadline: anyone may refund an open job (the rail relays). "refunded".
 *
 * There is no acceptance and no dispute in a proof escrow: the verifier decides. The client's recourse is the deadline:
 * without a valid certificate by then, the money goes back to its owner account. QED says so when asked to accept or
 * dispute.
 *
 * A dispute step (R13, audit item E3). A job may instead be paid through QED's dispute escrow (chain/disputes), which
 * stands in front of the proof escrow, unmodified. The provider names a decider (a third household with an on-chain
 * wallet, sharing no member with either side), three periods and two timeout outcomes, from the paper escrow's policy
 * (server/escrow.ts POLICY: its defaults, bounds and reasons); on an isolated test stack the periods may be seconds. The
 * quote it signs commits to those terms, and the client accepts them by funding. Then:
 *   deliver   PROVIDER: the verifier's acceptance pays the dispute escrow, and the client's review starts. "review".
 *   accept    CLIENT, in the review or a dispute: the provider is paid in full at once. "released".
 *   dispute   CLIENT, in the review, with a reason (kept here; its hash on the chain). "disputed".
 *   evidence  CLIENT or PROVIDER, until the evidence period ends: a text (kept here; its hash on the chain).
 *   decide    DECIDER, after the evidence period and by the deadline, within its powers: pay, refund or split.
 *   give-way  PROVIDER, in the review or a dispute: the client is refunded in full. "refunded".
 *   finish    ANY OF THE THREE, once the review or the decision period has run out: the terms' timeout outcome.
 * A split ends "split"; the parts are read back from the chain. What the chain enforces: who may act, when, and that the
 * money goes only to the provider's vault and the client's account, in parts that add up to the price. What QED does:
 * checks the decider is independent, keeps the texts, shows every term before either side signs, and asks for passkeys. Every state shown is read back from the rail (the job of each signed step, then the escrow itself); when the
 * rail cannot be read, the view says "unknown" and nothing recorded changes. The paper flow's functions refuse these
 * milestones: their states all begin with "chain-".
 *
 * R7 D7: a settlement adds half its price to the provider's authority budget only when the client is outside the
 * provider's workspace (the rail's rule). QED declares to the rail every vault that has a member in common with
 * either party before it quotes or funds, and says beforehand when a job will add nothing. QED cannot tell whether
 * the same person runs another QED account, or pays from an address outside QED.
 */
import { createHash } from 'node:crypto'
import { AppError, audit, bad, type Db, j, newId, notFound, parse, refused } from './core.ts'
import { inrExact } from '../shared/money.ts'
import { type Asker, at, declareLinks, mustVault, must, proposeOnRail, rail, type RailCfg, vaultOf } from './rail.ts'
import { POLICY } from './escrow.ts'

type Json = Record<string, unknown>
type State = 'chain-draft' | 'chain-offered' | 'chain-expired' | 'chain-funded' | 'chain-review' | 'chain-disputed' | 'chain-released' | 'chain-refunded' | 'chain-split'
type Action = 'quote' | 'fund' | 'deliver' | 'release' | 'refund' | 'accept' | 'dispute' | 'evidence' | 'decide' | 'give-way' | 'finish'
type Role3 = 'provider' | 'client' | 'decider'
/** The dispute step a provider chose for a job (R13 E3): periods in seconds; shares are the provider's, in basis points. */
interface DisputeChoice { deciderWs: string; reviewSeconds: number; evidenceSeconds: number; decisionSeconds: number; onReviewBps: number; onDecisionBps: number; deciderMay: { pay: boolean; refund: boolean; split: boolean }; test?: true }
/** The texts of a dispute, kept here; the chain holds their keccak256. */
interface Texts { reason?: { text: string; hash: string; at: number }; evidence: { by: 'client' | 'provider'; text: string; hash: string; at: number }[] }
interface Quote { provider: string; payee: string; client: string; token: string; price: string; verifier: string; specHash: string; deliverBy: string; validUntil: string; quoteId: string }
interface Record_ {
  jobId: string; providerWs: string; clientWs: string; title: string; amount: number; deliverWithinHours: number; validForMinutes: number; problem: Json
  quote?: { quote: Quote; signature: string; spec: string; quoteHash: string; signedAt: number; dispute?: { terms: Json; termsHash: string; words: string[]; escrow: string } }
  escrowJobId?: string
  dispute?: DisputeChoice
  disputeJobId?: string
  texts?: Texts
  pending?: { action: Action; ws: string; proposalId?: string; approvalId?: string; jobId?: string; at: number }
  /** Raised by every write: a writer that read the record before awaiting the rail checks it (see patchRec, reconcile). */
  rev?: number
  /** `ws`: whose step it was (since R13; older records are told apart by the step, see lastFor). */
  last?: { action: Action; outcome: string; summary: string; at: number; ws?: string }
  chain?: Json
}

const KEY = /^[A-Za-z0-9-]{8,80}$/
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const recKey = (milestoneId: string) => `earn.chain.ms:${milestoneId}`
const getRec = (db: Db, id: string): Record_ | null => parse<Record_ | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', recKey(id))?.value ?? 'null', null)
const putRec = (db: Db, id: string, r: Record_): void => { r.rev = (r.rev ?? 0) + 1; db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', recKey(id), j(r)) }
/**
 * A change applied to the record as it is now, read again in the same transaction. A step reads the record, awaits the
 * rail, then records what it started; the page's read-back (reconcile, every few seconds) may have written in between,
 * and writing the copy read before would put an old record over it (R12 review of earn-chain: a read-back could erase a
 * request just recorded, so a signed offer went unrecorded). The change is made to the fresh record instead.
 */
function patchRec(db: Db, id: string, change: (fresh: Record_) => void): Record_ {
  return db.tx(() => {
    const fresh = getRec(db, id)
    if (!fresh) throw notFound('That milestone')
    change(fresh)
    putRec(db, id, fresh)
    return fresh
  })
}
/** paise (an exact integer) as the rail's decimal string of tINR, 1 tINR = ₹1: 25075 → "250.75". */
const tinr = (paise: number): string => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
const iso = (unix: string | number | undefined): string | null => (unix === undefined ? null : new Date(Number(unix) * 1000).toISOString())
const nameOf = (db: Db, id: string): { name: string; handle: string } => { const u = db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM users WHERE id = ?', id); return { name: u?.display_name ?? 'Someone', handle: u?.handle ?? '' } }
/** How the provider names the client: by name once the client has funded a milestone of the job, by the handle the
 *  provider typed before that, so the job form never tells anyone who is behind a handle (RISK-071). */
const clientLabel = (db: Db, jobId: string, clientWs: string): string => {
  const c = nameOf(db, clientWs)
  return db.get(`SELECT 1 FROM earn_milestones WHERE job_id = ? AND state IN ('chain-funded', 'chain-released', 'chain-refunded')`, jobId) ? c.name : `@${c.handle}`
}
/** Two workspaces have (or had) a member in common: neither is an outside client of the other (R7 D1, D7 A-ID). */
const linked = (db: Db, a: string, b: string): boolean => !!db.get('SELECT 1 FROM memberships x JOIN memberships y ON y.person_id = x.person_id WHERE x.workspace_id = ? AND y.workspace_id = ? LIMIT 1', a, b)

/** The problems a quote may name (the rail checks them again). Synthetic inputs, not market data and not advice. */
export const EARN_PROBLEMS = [
  { kind: 'helix', title: 'Minimum-variance long-only portfolio on the Helix model (Oct 2026)', note: 'The release\'s ILLUSTRATIVE six-asset covariance model: synthetic volatilities and correlations.' },
  { kind: 'custom', title: 'Minimum-variance long-only portfolio of 2 to 6 assets', note: 'Annual volatilities from 100 to 10000 basis points (1% to 100%), zero correlations.', bounds: { assets: [2, 6], volatilityBps: [100, 10_000] } },
]
export function problemOf(raw: unknown): Json {
  const p = raw as Json | null
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('Choose the work: { kind: "helix" } or { kind: "custom", assets }.', { problem: 'Choose the work.' })
  if (p.kind === 'helix' && Object.keys(p).length === 1) return { kind: 'helix' }
  const assets = p.assets
  if (p.kind !== 'custom' || Object.keys(p).some((k) => k !== 'kind' && k !== 'assets') || !Array.isArray(assets) || assets.length < 2 || assets.length > 6) throw bad('A custom problem names 2 to 6 assets.', { problem: 'Name 2 to 6 assets.' })
  const list = assets.map((a) => ({ name: clean((a as Json)?.name, 40), volatilityBps: (a as Json)?.volatilityBps }))
  if (list.some((a) => a.name.length < 1 || !Number.isInteger(a.volatilityBps) || (a.volatilityBps as number) < 100 || (a.volatilityBps as number) > 10_000) || new Set(list.map((a) => a.name.toLowerCase())).size !== list.length) throw bad('Each asset needs its own name and an annual volatility from 100 to 10000 basis points.', { problem: 'Check the assets.' })
  return { kind: 'custom', assets: list }
}

// ------------------------------------------------------------------------------------------------ creating the job

export async function createChainJob(_cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<{ id: string; milestones: { id: string }[]; duplicate: boolean }> {
  const b = (raw ?? {}) as Json
  const key = typeof b.key === 'string' && KEY.test(b.key) ? b.key : ''
  if (!key) throw bad('The request is missing its key.', { key: 'Send a key of 8 to 80 letters, digits or hyphens with each new job.' })
  const fields: Record<string, string> = {}
  const title = clean(b.title, 80)
  if (title.length < 3) fields.title = 'Describe the work.'
  const ms = Array.isArray(b.milestones) ? (b.milestones as Json[]) : []
  if (ms.length < 1 || ms.length > 4 || ms.some((m) => clean(m.title, 80).length < 2 || !Number.isSafeInteger(m.amount) || (m.amount as number) < 100 || (m.amount as number) > 1_000_000_000 || !Number.isInteger(m.deliverWithinHours) || (m.deliverWithinHours as number) < 1 || (m.deliverWithinHours as number) > 336 || (m.validForHours !== undefined && (!Number.isInteger(m.validForHours) || (m.validForHours as number) < 1 || (m.validForHours as number) > 168)))) fields.milestones = 'Add one to four milestones, each with a name, an amount from ₹1 to ₹1 crore (test tINR), a delivery time from 1 to 336 hours and, if you like, how long the offer stands (1 to 168 hours).'
  if (Object.keys(fields).length) throw bad('Check the highlighted fields.', fields)
  const problem = problemOf(b.problem)
  const fingerprint = createHash('sha256').update(j({ title, client: b.clientHandle, problem, ms: ms.map((m) => [clean(m.title, 80), m.amount, m.deliverWithinHours, m.validForHours ?? null]), dispute: b.dispute ?? null })).digest('hex')
  const idem = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', `earn.chain.key:${who.workspaceId}:${key}`)?.value
  if (idem) {
    const prev = parse<{ id: string; fingerprint: string }>(idem, { id: '', fingerprint: '' })
    if (prev.fingerprint !== fingerprint) throw new AppError(409, 'idempotency_conflict', 'That key was already used for a different job. Nothing was created.')
    return { id: prev.id, milestones: db.all<{ id: string }>('SELECT id FROM earn_milestones WHERE job_id = ? ORDER BY rowid', prev.id), duplicate: true }
  }
  const handle = clean(b.clientHandle, 40).toLowerCase().replace(/^@/, '')
  const client = db.get<{ id: string; display_name: string; handle: string }>(`SELECT id, display_name, handle FROM users WHERE handle = ? AND kind = 'person'`, handle)
  if (client?.id === who.workspaceId) throw new AppError(422, 'self_dealing', 'A workspace cannot hire itself. Name another QED account as the client.')
  mustVault(db, who.workspaceId)
  // A handle that does not exist and one without an on-chain wallet get the same answer, without a name: the form must
  // not tell anyone who has an account, what they are called or whether they have a wallet (RISK-071).
  if (!client || !vaultOf(db, client.id)) throw refused('client_unavailable', 'No QED account with an on-chain wallet can take this work under that handle. Check the handle with your client, or record the work on paper.')
  const dispute = b.dispute === undefined || b.dispute === null ? null : disputeChoice(db, who.workspaceId, client.id, b.dispute)
  const out = db.tx(() => {
    const made = insertChainJob(db, { providerWs: who.workspaceId, personId: who.personId, client, title, problem, dispute, milestones: ms.map((m) => ({ title: clean(m.title, 80), amount: m.amount as number, deliverWithinHours: m.deliverWithinHours as number, validForHours: typeof m.validForHours === 'number' ? m.validForHours : undefined })), extra: { key } }, now)
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `earn.chain.key:${who.workspaceId}:${key}`, j({ id: made.id, fingerprint }))
    return made
  })
  return { ...out, duplicate: false }
}

/**
 * A job on the chain and its milestones, all drafts on the provider's side: from the provider's own form, or from a
 * quote chosen in the directory (server/directory.ts). Runs inside the caller's transaction.
 */
export function insertChainJob(db: Db, x: { providerWs: string; personId: string; client: { id: string; display_name: string; handle: string }; title: string; problem: Json; dispute: DisputeChoice | null; milestones: { title: string; amount: number; deliverWithinHours: number; validForHours?: number }[]; extra?: Json }, now: number): { id: string; milestones: { id: string }[] } {
  const id = newId('job', now)
  const milestones: { id: string }[] = []
  const decider = x.dispute ? nameOf(db, x.dispute.deciderWs) : null
  db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES (?, ?, ?, ?, 'open', ?, ?)`, id, x.providerWs, x.title, `@${x.client.handle}`, now,
    j({ chain: { v: 1, ...(x.extra ?? {}), clientWorkspace: x.client.id, clientPerson: x.client.id, clientHandle: x.client.handle, clientName: x.client.display_name, problem: x.problem, createdBy: x.personId, ...(x.dispute ? { dispute: { ...x.dispute, deciderWorkspace: x.dispute.deciderWs, deciderHandle: decider!.handle } } : {}) } }))
  for (const m of x.milestones) {
    const mid = newId('mil', now)
    const validForMinutes = Math.max(15, Math.min((m.validForHours ?? 24) * 60, m.deliverWithinHours * 60 - 15))
    db.run(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, updated_at) VALUES (?, ?, ?, ?, ?, 'chain-draft', ?)`, mid, id, x.providerWs, m.title, m.amount, now)
    putRec(db, mid, { jobId: id, providerWs: x.providerWs, clientWs: x.client.id, title: `${x.title}: ${m.title}`, amount: m.amount, deliverWithinHours: m.deliverWithinHours, validForMinutes, problem: x.problem, ...(x.dispute ? { dispute: x.dispute } : {}) })
    milestones.push({ id: mid })
  }
  audit(db, now, x.providerWs, 'owner', 'earn.chain.create', id, { client: x.client.id, milestones: x.milestones.length, dispute: x.dispute ? { decider: x.dispute.deciderWs } : null })
  return { id, milestones }
}

/** The paper escrow's defaults, as the dispute step offers them: periods in days, each timeout's share to the provider in per cent. */
export function disputeDefaults(): { reviewDays: number; evidenceDays: number; decisionDays: number; onReviewPct: number; onDecisionPct: number } {
  const pctOf = (o: { kind: string; earnerPct?: number }) => (o.kind === 'release' ? 100 : o.kind === 'refund' ? 0 : o.earnerPct ?? 50)
  return { reviewDays: POLICY.review.days.default, evidenceDays: POLICY.evidence.days.default, decisionDays: POLICY.decision.days.default, onReviewPct: pctOf(POLICY.review.onTimeout), onDecisionPct: pctOf(POLICY.decision.onTimeout) }
}
const DAY_S = 86_400
/**
 * The provider's dispute step, checked: a decider who is a third household with an on-chain wallet and no member in
 * common with either side; periods in whole days within the paper escrow's bounds (on an isolated test stack, seconds
 * from 60 to 3600), the decision ending after the evidence; each timeout's share to the provider in whole per cent; at
 * least one power.
 */
export function disputeChoice(db: Db, providerWs: string, clientWs: string, raw: unknown, env: Record<string, string | undefined> = process.env): DisputeChoice {
  const d = raw as Json | null
  const keys = ['deciderHandle', 'reviewDays', 'evidenceDays', 'decisionDays', 'onReviewPct', 'onDecisionPct', 'may', 'testSeconds']
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !keys.includes(k))) throw bad('A dispute step is { deciderHandle, reviewDays, evidenceDays, decisionDays, onReviewPct, onDecisionPct, may }.', { dispute: 'Check the dispute step.' })
  const fields: Record<string, string> = {}
  const handle = clean(d.deciderHandle, 40).toLowerCase().replace(/^@/, '')
  const decider = handle ? db.get<{ id: string }>(`SELECT id FROM users WHERE handle = ? AND kind = 'person'`, handle) : undefined
  // the same answer for "no such handle", "no wallet" and "not independent": the form never tells who is behind a handle
  if (!decider || !vaultOf(db, decider.id) || decider.id === providerWs || decider.id === clientWs || linked(db, decider.id, providerWs) || linked(db, decider.id, clientWs)) fields.deciderHandle = 'Name a third household with an on-chain wallet, sharing no member with you or the client.'
  const test = d.testSeconds !== undefined
  if (test && env.QED_TEST_STACK !== '1') fields.testSeconds = 'Periods in seconds are for an isolated test stack only. Set them in days.'
  const secs = d.testSeconds as Json | undefined
  const period = (name: 'review' | 'evidence' | 'decision', bounds: { min: number; max: number }): number => {
    if (test && env.QED_TEST_STACK === '1') { const v = secs?.[name]; if (!Number.isInteger(v) || (v as number) < 60 || (v as number) > 3600) { fields[`${name}Days`] = 'On a test stack a period lasts 60 to 3600 seconds.'; return 0 } return v as number }
    const v = d[`${name}Days`]
    if (!Number.isInteger(v) || (v as number) < bounds.min || (v as number) > bounds.max) { fields[`${name}Days`] = `A whole number of days from ${bounds.min} to ${bounds.max}.`; return 0 }
    return (v as number) * DAY_S
  }
  const P = paperPolicy()
  const review = period('review', P.review), evidence = period('evidence', P.evidence), decision = period('decision', P.decision)
  if (review && evidence && decision && decision < evidence + 60) fields.decisionDays = 'The decision deadline comes after the evidence period ends: the decider rules once the evidence is in.'
  const pct = (k: string) => { const v = d[k]; if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100) { fields[k] = 'A whole per cent from 0 to 100.'; return 0 } return v as number }
  const onReview = pct('onReviewPct'), onDecision = pct('onDecisionPct')
  const may = d.may as Json | null
  if (!may || typeof may !== 'object' || Object.keys(may).some((k) => !['pay', 'refund', 'split'].includes(k)) || !Object.values(may).some((v) => v === true)) fields.may = 'Give the decider at least one power: pay you in full, refund the client in full, or split.'
  if (Object.keys(fields).length) throw bad('Check the dispute step.', fields)
  return { deciderWs: decider!.id, reviewSeconds: review, evidenceSeconds: evidence, decisionSeconds: decision, onReviewBps: onReview * 100, onDecisionBps: onDecision * 100, deciderMay: { pay: may!.pay === true, refund: may!.refund === true, split: may!.split === true }, ...(test ? { test: true as const } : {}) }
}
/** The paper escrow's day bounds (server/escrow.ts POLICY), read when needed, never at load (the modules import each other). */
function paperPolicy(): Record<'review' | 'evidence' | 'decision', { min: number; max: number }> {
  return { review: POLICY.review.days, evidence: POLICY.evidence.days, decision: POLICY.decision.days }
}

// ------------------------------------------------------------------------------------------------ finding a milestone, as one party

function milestoneRow(db: Db, id: string): { id: string; job_id: string; user_id: string; title: string; amount: number; state: State; evidence_hash: string | null; updated_at: number } | undefined {
  return db.get('SELECT id, job_id, user_id, title, amount, state, evidence_hash, updated_at FROM earn_milestones WHERE id = ?', id)
}
/** The milestone and its chain record, only for its provider or its client: anyone else is told it does not exist. */
function asParty(db: Db, who: Asker, id: string, side: 'provider' | 'client' | 'either' | 'decider' | 'any') {
  const m = milestoneRow(db, id), r = m ? getRec(db, id) : null
  if (!m || !r) throw notFound('That milestone')
  const isProvider = r.providerWs === who.workspaceId && m.user_id === who.workspaceId, isClient = r.clientWs === who.workspaceId
  // the decider sees a milestone once it has been funded under its terms: before that, nothing is its business
  const isDecider = !!r.dispute && r.dispute.deciderWs === who.workspaceId && !!r.disputeJobId
  const ok = side === 'provider' ? isProvider : side === 'client' ? isClient : side === 'either' ? isProvider || isClient : side === 'decider' ? isDecider : isProvider || isClient || isDecider
  if (!ok) throw notFound('That milestone')
  return { m, r, role: isProvider ? 'provider' as const : isClient ? 'client' as const : 'decider' as const }
}
function setState(db: Db, id: string, state: State, now: number, evidence?: string): void {
  db.run('UPDATE earn_milestones SET state = ?, updated_at = ?, evidence_hash = COALESCE(?, evidence_hash) WHERE id = ?', state, now, evidence ?? null, id)
}
/** Who takes each step: the provider quotes, delivers and releases; the client funds; either may ask for a refund. */
const PROVIDER_STEPS = new Set<Action>(['quote', 'deliver', 'release'])
/**
 * The last step's outcome as this party may read it. Its words come from that party's own vault service and can carry
 * that vault's figures (a refused funding names the client's free balance), so the other party reads only which step it
 * was, how it ended and when (R13 review, lead L-04).
 */
function lastFor(r: Record_, role: 'provider' | 'client' | 'decider'): Record_['last'] | null {
  if (!r.last) return null
  // a dispute's decider (R13 E3) is neither party: it reads every step as the other side does, without figures
  const mine = role === 'provider' ? r.providerWs : role === 'client' ? r.clientWs : null
  const owner = r.last.ws ?? (PROVIDER_STEPS.has(r.last.action) ? r.providerWs : r.last.action === 'fund' ? r.clientWs : null)
  if (mine !== null && owner === mine) return r.last
  const whose = role === 'decider' ? (owner === r.providerWs ? 'provider' : 'client') : role === 'provider' ? 'client' : 'provider'
  return { action: r.last.action, outcome: r.last.outcome, summary: `The ${whose}'s ${r.last.action} ${r.last.outcome === 'executed' ? 'went through' : 'did not go through'}; what their vault service said is theirs.`, at: r.last.at }
}
/** A step already waiting for signatures or for the rail: refused, so that one press cannot become two proposals. */
function requireIdle(db: Db, r: Record_, now: number): void {
  if (!r.pending) return
  const a = r.pending.approvalId ? db.get<{ cancelled_at: number | null; expires_at: number; consumed_at: number | null }>('SELECT cancelled_at, expires_at, consumed_at FROM approvals WHERE id = ?', r.pending.approvalId) : undefined
  const lapsed = !!a && a.consumed_at === null && (a.cancelled_at !== null || now > a.expires_at)
  if (!lapsed) throw refused('already_pending', `This milestone's ${r.pending.action} is already waiting: sign it, or withdraw it, before preparing another.`)
}
async function propose(cfg: RailCfg, db: Db, who: Asker, id: string, r: Record_, action: Action, kind: string, params: Json, now: number, shown: Json): Promise<Json> {
  const out = await proposeOnRail(cfg, db, who, kind, params, now, { earn: { action, ...shown } })
  const pending = { action, ws: who.workspaceId, proposalId: String((out.proposal as { id: string }).id), approvalId: String(out.approvalId), at: now }
  // a request recorded meanwhile (another tab, a second press) keeps its place; this one is not offered for signing and
  // lapses unsigned on the rail
  patchRec(db, id, (fresh) => { requireIdle(db, fresh, now); fresh.pending = pending })
  r.pending = pending
  audit(db, now, who.workspaceId, 'owner', `earn.chain.${action}`, id, { proposalId: pending.proposalId })
  return out
}

// ------------------------------------------------------------------------------------------------ the steps

export async function quoteChainMilestone(cfg: RailCfg, db: Db, who: Asker, id: string, now: number): Promise<Json> {
  const { m, r } = asParty(db, who, id, 'provider')
  if (m.state !== 'chain-draft' && m.state !== 'chain-expired') throw refused('wrong_state', `This milestone is ${m.state.slice(6)}: it has a quote already.`)
  requireIdle(db, r, now)
  // R7 D7: every vault with a member in common with either side is linked before the quote is signed
  await declareLinks(cfg, db, r.providerWs, now)
  await declareLinks(cfg, db, r.clientWs, now)
  const client = await must(cfg, 'GET', at(mustVault(db, r.clientWs), ''))
  let dispute: Json | undefined
  if (r.dispute) {
    const decider = await must(cfg, 'GET', at(mustVault(db, r.dispute.deciderWs), ''))
    dispute = { decider: String(decider.ownerAccount), reviewSeconds: r.dispute.reviewSeconds, evidenceSeconds: r.dispute.evidenceSeconds, decisionSeconds: r.dispute.decisionSeconds, onReviewBps: r.dispute.onReviewBps, onDecisionBps: r.dispute.onDecisionBps, deciderMay: r.dispute.deciderMay }
  }
  const params = { client: String(client.ownerAccount), price: tinr(r.amount), deliverWithinHours: r.deliverWithinHours, validForMinutes: r.validForMinutes, problem: r.problem, title: r.title, ...(dispute ? { dispute } : {}) }
  return propose(cfg, db, who, id, r, 'quote', 'escrow-quote', params, now, { milestone: r.title, client: clientLabel(db, r.jobId, r.clientWs), amount: inrExact(r.amount) })
}

export async function fundChainMilestone(cfg: RailCfg, db: Db, who: Asker, id: string, now: number): Promise<Json> {
  const { m, r } = asParty(db, who, id, 'client')
  if (m.state !== 'chain-offered' || !r.quote) throw refused('wrong_state', 'This milestone is not on offer.')
  if (now > Number(r.quote.quote.validUntil) * 1000) throw refused('offer_lapsed', `The offer stood until ${iso(r.quote.quote.validUntil)}. Ask ${nameOf(db, r.providerWs).name} for a new one.`)
  requireIdle(db, r, now)
  await declareLinks(cfg, db, r.clientWs, now)
  await declareLinks(cfg, db, r.providerWs, now)
  if (r.dispute && !r.quote.dispute) throw refused('wrong_state', 'This offer was signed without its dispute terms. Ask the provider for a new one.')
  return propose(cfg, db, who, id, r, 'fund', 'escrow-fund', { quote: r.quote.quote, signature: r.quote.signature, spec: r.quote.spec, ...(r.quote.dispute ? { dispute: r.quote.dispute.terms } : {}) }, now, { milestone: r.title, provider: nameOf(db, r.providerWs).name, amount: inrExact(r.amount), deliverBy: iso(r.quote.quote.deliverBy), ...(r.dispute ? { decider: `@${nameOf(db, r.dispute.deciderWs).handle}` } : {}) })
}

export async function deliverChainMilestone(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { m, r } = asParty(db, who, id, 'provider')
  if (m.state !== 'chain-funded' || !r.escrowJobId) throw refused('wrong_state', 'Only a funded milestone can be delivered.')
  requireIdle(db, r, now)
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => k !== 'solution') || (b.solution !== undefined && (typeof b.solution !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(b.solution) || b.solution.length > 8200))) throw bad('A delivery takes, at most, { solution }: a certificate you computed yourself, in hexadecimal. Without it the rail computes one.')
  return propose(cfg, db, who, id, r, 'deliver', 'escrow-deliver', { jobId: r.escrowJobId, ...(b.solution ? { solution: b.solution } : {}) }, now, { milestone: r.title, client: clientLabel(db, r.jobId, r.clientWs), amount: inrExact(r.amount) })
}

export async function releaseChainMilestone(cfg: RailCfg, db: Db, who: Asker, id: string, now: number): Promise<Json> {
  const { m, r } = asParty(db, who, id, 'provider')
  if (m.state !== 'chain-funded' || !r.escrowJobId) throw refused('wrong_state', 'Only a funded milestone can be released.')
  requireIdle(db, r, now)
  return propose(cfg, db, who, id, r, 'release', 'escrow-release', { jobId: r.escrowJobId }, now, { milestone: r.title, client: clientLabel(db, r.jobId, r.clientWs), amount: inrExact(r.amount) })
}

/** After the deadline, either party asks the rail to refund (anyone may then); before it, refused here with the date. */
export async function refundChainMilestone(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { m, r } = asParty(db, who, id, 'either')
  if (m.state !== 'chain-funded' || !r.escrowJobId || !r.quote) throw refused('wrong_state', 'Only a funded milestone can be refunded.')
  if (now <= Number(r.quote.quote.deliverBy) * 1000) throw refused('not_refundable_yet', `Until ${iso(r.quote.quote.deliverBy)} only ${nameOf(db, r.providerWs).name} can release the money; after that you can take it back if no valid work has arrived.`)
  const key = typeof (raw as Json | null)?.key === 'string' && KEY.test((raw as Json).key as string) ? ((raw as Json).key as string) : ''
  if (!key) throw bad('The request is missing its key.')
  // After the deadline the refund is the client's recourse, and the escrow lets anyone ask for it: a request of the other
  // party that waits (a release kept open, re-armed by withdrawing and asking again) must not hold it off (R13 review,
  // lead L-02). Only a refund already waiting is one too many.
  if (r.pending?.action === 'refund') requireIdle(db, r, now)
  const v = mustVault(db, who.workspaceId)
  const accepted = await must(cfg, 'POST', at(v, `/escrow/jobs/${r.escrowJobId}/refund`), {}, { 'Idempotency-Key': `ui-${key}` })
  const pending = { action: 'refund' as const, ws: who.workspaceId, jobId: String(accepted.jobId), at: now }
  db.tx(() => {
    patchRec(db, id, (fresh) => {
      // the rail took the refund. After the deadline it takes the place of a request of the other party that waits (that
      // one lapses unsigned, or fails at the escrow, which refunds once; L-02). A refund recorded meanwhile keeps its place,
      // and the escrow's own state (read back from the rail) shows whether this one happened.
      if (fresh.pending?.action !== 'refund') { fresh.pending = pending; return }
      try { requireIdle(db, fresh, now); fresh.pending = pending } catch { fresh.last = { action: 'refund', outcome: 'accepted', summary: 'The refund was accepted while another refund was waiting; the escrow shows whether it happened.', at: now, ws: who.workspaceId } }
    })
    audit(db, now, who.workspaceId, 'owner', 'earn.chain.refund', id, { jobId: accepted.jobId })
  })
  return accepted
}

// ------------------------------------------------------------------------------------------------ the dispute step (R13 E3)

const textOf = (v: unknown, what: string): string => {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim() : ''
  if (t.length < 10 || t.length > 2000) throw bad(`Write the ${what} in 10 to 2000 characters.`, { text: `10 to 2000 characters.` })
  return t
}
/** A milestone paid through the dispute escrow, in the state a step needs. */
function inDispute(db: Db, who: Asker, id: string, side: 'provider' | 'client' | 'either' | 'decider' | 'any', states: State[], what: string, now: number) {
  const p = asParty(db, who, id, side)
  if (!p.r.dispute || !p.r.disputeJobId) throw refused('no_dispute_step', 'This work is paid straight through the proof escrow, with no review and no dispute: the verifier decides, and the client\'s recourse is the deadline.')
  if (!states.includes(p.m.state)) throw refused('wrong_state', `This milestone is ${p.m.state.slice(6)}: ${what}.`)
  requireIdle(db, p.r, now)
  return p
}
const disputeShown = (db: Db, r: Record_): Json => ({ milestone: r.title, provider: nameOf(db, r.providerWs).name, client: nameOf(db, r.clientWs).name, decider: r.dispute ? `@${nameOf(db, r.dispute.deciderWs).handle}` : null, amount: inrExact(r.amount) })

/** CLIENT: accept verified work, during the review or a dispute. The provider is paid in full at once. */
export async function acceptChainWork(cfg: RailCfg, db: Db, who: Asker, id: string, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'client', ['chain-review', 'chain-disputed'], 'only verified work under review or in dispute can be accepted', now)
  return propose(cfg, db, who, id, r, 'accept', 'escrow-accept', { disputeId: r.disputeJobId }, now, disputeShown(db, r))
}
/** CLIENT: dispute verified work during the review, with a reason. */
export async function disputeChainWork(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'client', ['chain-review'], 'only verified work under review can be disputed', now)
  const reason = textOf((raw as Json | null)?.reason, 'reason')
  return propose(cfg, db, who, id, r, 'dispute', 'escrow-dispute', { disputeId: r.disputeJobId, reason }, now, { ...disputeShown(db, r), reason })
}
/** CLIENT or PROVIDER: evidence for a dispute, until its evidence period ends. */
export async function addChainEvidence(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'either', ['chain-disputed'], 'evidence goes with a dispute', now)
  const text = textOf((raw as Json | null)?.text, 'evidence')
  return propose(cfg, db, who, id, r, 'evidence', 'escrow-evidence', { disputeId: r.disputeJobId, text }, now, { ...disputeShown(db, r), evidence: text })
}
/** DECIDER: rule on a dispute after its evidence period: the provider's part in paise, the rest to the client. */
export async function decideChainDispute(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'decider', ['chain-disputed'], 'the decider rules only on a dispute', now)
  const toProvider = (raw as Json | null)?.toProvider
  if (!Number.isSafeInteger(toProvider) || (toProvider as number) < 0 || (toProvider as number) > r.amount) throw bad(`The provider's part is from ₹0 to ${inrExact(r.amount)}.`, { toProvider: `From ₹0 to ${inrExact(r.amount)}.` })
  const note = (raw as Json | null)?.note === undefined ? null : clean((raw as Json).note, 500)
  return propose(cfg, db, who, id, r, 'decide', 'escrow-decide', { disputeId: r.disputeJobId, toProvider: tinr(toProvider as number) }, now, { ...disputeShown(db, r), ruling: { toProvider: inrExact(toProvider as number), toClient: inrExact(r.amount - (toProvider as number)), ...(note ? { note } : {}) } })
}
/** PROVIDER: refund the client in full, during the review or a dispute. */
export async function giveWayChainWork(cfg: RailCfg, db: Db, who: Asker, id: string, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'provider', ['chain-review', 'chain-disputed'], 'only verified work under review or in dispute can be refunded this way', now)
  return propose(cfg, db, who, id, r, 'give-way', 'escrow-give-way', { disputeId: r.disputeJobId }, now, disputeShown(db, r))
}
/** ANY OF THE THREE: apply the terms' timeout outcome once the review or the decision period has run out. No passkey: the chain lets anyone. */
export async function finishChainWork(cfg: RailCfg, db: Db, who: Asker, id: string, raw: unknown, now: number): Promise<Json> {
  const { r } = inDispute(db, who, id, 'any', ['chain-review', 'chain-disputed'], 'no timeout applies', now)
  const key = typeof (raw as Json | null)?.key === 'string' && KEY.test((raw as Json).key as string) ? ((raw as Json).key as string) : ''
  if (!key) throw bad('The request is missing its key.')
  const accepted = await must(cfg, 'POST', at(mustVault(db, who.workspaceId), `/disputes/${r.disputeJobId}/finish`), {}, { 'Idempotency-Key': `ui-${key}` })
  const pending = { action: 'finish' as const, ws: who.workspaceId, jobId: String(accepted.jobId), at: now }
  db.tx(() => {
    patchRec(db, id, (fresh) => { try { requireIdle(db, fresh, now); fresh.pending = pending } catch { fresh.last = { action: 'finish', outcome: 'accepted', summary: 'The timeout was accepted while another request was waiting; the escrow shows whether it applied.', at: now } } })
    audit(db, now, who.workspaceId, 'owner', 'earn.chain.finish', id, { jobId: accepted.jobId })
  })
  return accepted
}

/**
 * The paper flow's client decision, for a milestone on the chain. A proof escrow has no acceptance and no dispute: the
 * verifier decides, and the client's recourse is the deadline. Work paid through the dispute escrow has both.
 */
export async function chainClientDecision(cfg: RailCfg, db: Db, who: Asker, id: string, decision: unknown, raw: unknown, now: number): Promise<Json> {
  const { r } = asParty(db, who, id, 'either')
  if (decision === 'refund') return refundChainMilestone(cfg, db, who, id, raw, now)
  if (r.dispute && r.disputeJobId && decision === 'accept') return acceptChainWork(cfg, db, who, id, now)
  if (r.dispute && r.disputeJobId && decision === 'dispute') return disputeChainWork(cfg, db, who, id, raw, now)
  throw chainDecisionRefusal(db, id, decision)
}

/** What a proof escrow answers to "accept" or "dispute" (and to anything else): the words both the chain route and the paper flow give. */
export function chainDecisionRefusal(db: Db, id: string, decision: unknown): AppError {
  const r = getRec(db, id)
  if (r?.dispute && (decision === 'accept' || decision === 'dispute')) return new AppError(409, 'use_dispute_step', 'This work is paid through the dispute escrow: accept or dispute it from its review on the Earn page, where your passkey signs the step for the chain.')
  const deadline = r?.quote ? iso(r.quote.quote.deliverBy) : null
  if (decision === 'accept') return new AppError(409, 'settles_on_verification', 'There is nothing to accept: the escrow pays only when the verifier on the chain accepts the delivered certificate, and then at once. Before that, no one can release the money to the provider.')
  if (decision === 'dispute') return new AppError(409, 'no_dispute_in_proof_escrow', `A proof escrow has no dispute: the verifier on the chain decides whether the work is correct, and it pays only for work that is. ${deadline ? `If no valid certificate arrives by ${deadline}, you can take the money back.` : 'If no valid certificate arrives by the deadline, you can take the money back.'}`)
  return bad('The decision is accept, dispute or refund.')
}

/** A milestone paid through the escrow on the chain (its record exists; its states all begin with "chain-"). */
export const isChainMilestone = (db: Db, id: string): boolean => getRec(db, id) !== null
/** Its delivery deadline (ms), once a quote is signed. */
export const chainDeadline = (db: Db, id: string): number | null => { const q = getRec(db, id)?.quote; return q ? Number(q.quote.deliverBy) * 1000 : null }
/** The failure of a step started for a caller that did not wait for it (the paper routes), kept on the milestone where the Earn page shows it. */
export function recordChainFailure(db: Db, id: string, action: Action, e: unknown, now: number): void {
  if (!getRec(db, id)) return
  // whose step it was follows from the step (lastFor)
  patchRec(db, id, (fresh) => { fresh.last = { action, outcome: 'failed', summary: e instanceof Error ? e.message : String(e), at: now } })
}

// ------------------------------------------------------------------------------------------------ reading it back from the rail

/** The rail could not be read: the state stays as recorded and the view says it is unknown. */
class Unreachable extends Error {}
async function read(cfg: RailCfg, db: Db, ws: string, path: string): Promise<{ status: number; json: Json }> {
  const v = vaultOf(db, ws)
  if (!v) throw new Unreachable()
  let r: { status: number; json: Json }
  try { r = await rail(cfg, 'GET', at(v, path)) } catch { throw new Unreachable() }
  if (r.status >= 500) throw new Unreachable()
  return r
}
/** Brings one milestone up to date with the rail: the job of its pending step, then the escrow itself. */
async function reconcile(cfg: RailCfg, db: Db, id: string, now: number): Promise<void> {
  const m = milestoneRow(db, id), r = getRec(db, id)
  if (!m || !r) return
  const rev0 = r.rev ?? 0
  let state = m.state
  const finish = (outcome: string, summary: string) => { r.last = { action: r.pending!.action, outcome, summary, at: now, ws: r.pending!.ws }; delete r.pending }
  if (r.pending) {
    let jobId = r.pending.jobId
    if (!jobId && r.pending.proposalId) {
      const p = await read(cfg, db, r.pending.ws, `/proposals/${r.pending.proposalId}`)
      if (p.status === 404) finish('failed', 'The vault service no longer knows this request (its data was replaced). Nothing happened; prepare it again.')
      else if (p.json.status === 'used' && typeof p.json.jobId === 'string') jobId = r.pending.jobId = p.json.jobId
      else if (p.json.status === 'expired' || p.json.status === 'cancelled') finish('expired', 'It was not signed in time, or it was withdrawn. Nothing happened.')
      else {
        const a = r.pending.approvalId ? db.get<{ cancelled_at: number | null; expires_at: number; consumed_at: number | null }>('SELECT cancelled_at, expires_at, consumed_at FROM approvals WHERE id = ?', r.pending.approvalId) : undefined
        if (a && a.consumed_at === null && (a.cancelled_at !== null || now > a.expires_at)) finish('expired', 'It was not signed in time, or it was withdrawn. Nothing happened.')
      }
    }
    if (r.pending && jobId) {
      const job = await read(cfg, db, r.pending.ws, `/jobs/${jobId}`)
      const status = String(job.json.status ?? '')
      const result = (job.json.result ?? null) as { outcome?: string; summary?: string; evidence?: Json } | null
      if (status === 'done' && result?.outcome === 'executed') {
        const ev = result.evidence ?? {}
        if (r.pending.action === 'quote' && ev.quote) { r.quote = { quote: ev.quote as Quote, signature: String(ev.signature), spec: String(ev.spec), quoteHash: String(ev.quoteHash), signedAt: now, ...(ev.dispute ? { dispute: ev.dispute as NonNullable<NonNullable<Record_['quote']>['dispute']> } : {}) }; state = 'chain-offered' }
        if (r.pending.action === 'fund' && ev.escrowJobId) { r.escrowJobId = String(ev.escrowJobId); if (ev.disputeJobId) r.disputeJobId = String(ev.disputeJobId); state = 'chain-funded' }
        // a dispute's texts are kept here, each with the hash the chain recorded for it
        if (r.pending.action === 'dispute' && typeof ev.reason === 'string') r.texts = { evidence: r.texts?.evidence ?? [], reason: { text: ev.reason, hash: String(ev.reasonHash), at: now } }
        if (r.pending.action === 'evidence' && typeof ev.text === 'string') r.texts = { ...(r.texts ?? { evidence: [] }), evidence: [...(r.texts?.evidence ?? []), { by: ev.by === 'provider' ? 'provider' : 'client', text: ev.text, hash: String(ev.evidenceHash), at: now }] }
        finish('executed', String(result.summary ?? ''))
      } else if (status === 'done') finish(result?.outcome ?? 'no-action', String(result?.summary ?? ''))
      else if (status === 'failed' || status === 'interrupted' || status === 'reorged') finish(status, `${String(job.json.error ?? 'It did not complete.')} ${String(job.json.guidance ?? '')}`.trim())
      else if (job.status === 404) finish('failed', 'The vault service no longer knows this job. Nothing is known to have happened.')
    }
  }
  // the escrow itself, as the provider's vault (always a party) sees it
  if (r.quote && !r.escrowJobId) {
    const found = await read(cfg, db, r.providerWs, `/escrow/jobs?quoteHash=${r.quote.quoteHash}`)
    const job = ((found.json.jobs ?? []) as Json[])[0]
    if (job) { r.escrowJobId = String(job.jobId); const dj = (job.dispute ?? null) as Json | null; if (dj?.disputeId) r.disputeJobId = String(dj.disputeId) }
    else if (state === 'chain-offered' && now > Number(r.quote.quote.validUntil) * 1000) state = 'chain-expired'
  }
  let evidence: string | undefined
  if (r.escrowJobId) {
    const e = await read(cfg, db, r.providerWs, `/escrow/jobs/${r.escrowJobId}`)
    if (e.status === 200) {
      r.chain = { status: e.json.status, deliverByTime: e.json.deliverByTime, refundable: e.json.refundable, opened: e.json.opened, settled: e.json.settled, refunded: e.json.refunded, solutionHash: e.json.solutionHash, authority: e.json.authority, priceText: e.json.priceText, ...(e.json.dispute ? { dispute: e.json.dispute } : {}) }
      const dj = (e.json.dispute ?? null) as { disputeId?: string; status?: string; outcome?: string; toProvider?: string; toClient?: string } | null
      if (dj?.disputeId) r.disputeJobId = String(dj.disputeId)
      state = dj ? disputeState(dj) : e.json.status === 'settled' ? 'chain-released' : e.json.status === 'refunded' ? 'chain-refunded' : 'chain-funded'
      if (e.json.status === 'settled' && typeof e.json.solutionHash === 'string') evidence = e.json.solutionHash
    }
  }
  db.tx(() => {
    // written only if nothing else wrote while the rail was read: a step that recorded a request meanwhile wins, and the
    // next read-back works from it (everything here is read again from the rail, so nothing is lost by not writing)
    if ((getRec(db, id)?.rev ?? 0) !== rev0) return
    putRec(db, id, r)
    // only a change is written: a settled milestone is read back on every view, and rewriting it would move the time
    // QED first recorded the payment (the Earn page dates the payment by it)
    if (state !== m.state || (evidence && evidence !== m.evidence_hash)) setState(db, id, state, now, evidence)
    const open = db.get<{ n: number }>(`SELECT COUNT(*) n FROM earn_milestones WHERE job_id = ? AND state NOT IN ('chain-released', 'chain-refunded', 'chain-split')`, m.job_id)!.n
    if (open === 0) db.run(`UPDATE earn_jobs SET state = 'complete' WHERE id = ? AND state <> 'complete'`, m.job_id)
  })
}

/** A milestone's state from the dispute escrow's job: its status, and for a closed job who received what. */
function disputeState(d: { status?: string; outcome?: string; toProvider?: string; toClient?: string }): State {
  if (d.status === 'delivered') return 'chain-review'
  if (d.status === 'disputed') return 'chain-disputed'
  if (d.status !== 'closed') return 'chain-funded'
  if (d.outcome === 'not-delivered' || BigInt(d.toProvider ?? '0') === 0n) return 'chain-refunded'
  return BigInt(d.toClient ?? '0') === 0n ? 'chain-released' : 'chain-split'
}
const when = (unix: unknown) => (typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null)
const OUTCOME_WORDS: Record<string, string> = { accepted: 'the client accepted the work', 'review-timeout': 'the review ended with no answer, so its timeout outcome applied', decided: 'the decider ruled', 'decision-timeout': 'no ruling came by the deadline, so its timeout outcome applied', 'provider-gave-way': 'the provider refunded the client', 'not-delivered': 'no verified work arrived in time' }
const disputeOf = (r: Record_) => ((r.chain ?? {}) as { dispute?: Json }).dispute as (Json & { outcome?: string; toProvider?: string; toClient?: string; reviewEndsAt?: number; evidenceEndsAt?: number; decideBy?: number }) | undefined
const STATUS: Record<State, (r: Record_, db: Db, role: Role3) => string> = {
  'chain-draft': (r, db, role) => role === 'provider' ? `Not offered yet: sign the quote to offer it to ${clientLabel(db, r.jobId, r.clientWs)}.` : 'Not offered yet.',
  'chain-offered': (r, db, role) => role === 'provider' ? `Offered to ${clientLabel(db, r.jobId, r.clientWs)}: waiting for them to fund it from their wallet, until ${iso(r.quote?.quote.validUntil)}.` : `Offered by ${nameOf(db, r.providerWs).name}: fund it from your wallet until ${iso(r.quote?.quote.validUntil)}. The escrow pays them only for work the verifier accepts by ${iso(r.quote?.quote.deliverBy)}.`,
  'chain-expired': (r, db, role) => role === 'provider' ? `The offer lapsed on ${iso(r.quote?.quote.validUntil)} without funding. No money moved. You can offer it again.` : 'The offer lapsed. No money moved.',
  'chain-funded': (r, db, role) => role === 'decider' ? `Funded: waiting for ${nameOf(db, r.providerWs).name}'s delivery, by ${iso(r.quote?.quote.deliverBy)}.` : r.dispute ? (role === 'provider' ? `Funded: the escrow holds the money. Deliver by ${iso(r.quote?.quote.deliverBy)}; once the verifier accepts the certificate, the client reviews it under the terms below.` : `Funded from your wallet: the escrow holds the money until a certificate the verifier accepts arrives by ${iso(r.quote?.quote.deliverBy)}; then you review the work under the terms below. Without it by then, the money comes back to you.`) : role === 'provider' ? `Funded: the escrow holds the money. Deliver by ${iso(r.quote?.quote.deliverBy)}; it pays your wallet when the verifier accepts the certificate.` : `Funded from your wallet: the escrow holds the money until a certificate the verifier accepts arrives by ${iso(r.quote?.quote.deliverBy)}, or it comes back to you after that.`,
  'chain-review': (r, db, role) => { const d = disputeOf(r); const ends = when(d?.reviewEndsAt) ?? 'the end of the review'; return role === 'client' ? `Delivered and verified on the chain. Review it: accept it, or dispute it with your reason, by ${ends}. With no answer by then, its timeout outcome applies.` : role === 'provider' ? `Delivered and verified on the chain: the dispute escrow holds the money for ${nameOf(db, r.clientWs).name}'s review until ${ends}.` : `Delivered and verified; under the client's review until ${ends}. Nothing to decide unless they dispute it.` },
  'chain-disputed': (r, db, role) => { const d = disputeOf(r); const ev = when(d?.evidenceEndsAt) ?? 'the end of the evidence period', by = when(d?.decideBy) ?? 'the deadline'; return role === 'decider' ? `Disputed. Both sides add evidence until ${ev}; then you rule, by ${by}, within the powers the terms give you.` : `Disputed. Both sides add evidence until ${ev}; then ${r.dispute ? `@${nameOf(db, r.dispute.deciderWs).handle}` : 'the decider'} rules, by ${by}. With no ruling by then, the terms' timeout outcome applies.` },
  'chain-released': (r, db, role) => { const d = disputeOf(r); const how = d?.outcome && d.outcome !== 'none' ? ` (${OUTCOME_WORDS[d.outcome] ?? d.outcome})` : ''; return role === 'provider' ? `Delivered and verified on the chain: your wallet was paid${how}.` : `Delivered and verified on the chain: ${nameOf(db, r.providerWs).name} was paid${how}.` },
  'chain-refunded': (r, _db, role) => { const d = disputeOf(r); const how = d?.outcome && d.outcome !== 'none' ? ` (${OUTCOME_WORDS[d.outcome] ?? d.outcome})` : ''; return role === 'provider' ? `Refunded to the client${how}: nothing was paid to your wallet.` : role === 'decider' ? `Refunded to the client${how}.` : `Refunded to your wallet's own account on the chain${how}. Move it back into the wallet with Deposit, on the wallet's page.` },
  'chain-split': (r, db, role) => { const d = disputeOf(r); const how = d?.outcome ? OUTCOME_WORDS[d.outcome] ?? d.outcome : 'the terms applied'; return `Split: ${how}. ${inrExact(Number(d?.toProvider ?? 0))} to ${role === 'provider' ? 'your wallet' : nameOf(db, r.providerWs).name}, ${inrExact(Number(d?.toClient ?? 0))} to ${role === 'client' ? 'your wallet\'s own account on the chain' : nameOf(db, r.clientWs).name}.` },
}
function actionsOf(state: State, r: Record_, role: Role3, now: number): string[] {
  if (r.pending) return []
  if (state === 'chain-review' || state === 'chain-disputed') {
    // From the chain's deadlines, as read back, against the time now (the rail keeps the chain on the wall clock). The
    // job is read from the provider's side, so the rail's own per-role flags do not apply to the client or the decider;
    // the vault service checks every step again, with the chain's time, before anything is signed.
    const d = (disputeOf(r) ?? {}) as { reviewEndsAt?: number; evidenceEndsAt?: number; decideBy?: number }
    const t = Math.floor(now / 1000)
    const inReview = !!d.reviewEndsAt && t <= d.reviewEndsAt, evidenceOpen = !!d.evidenceEndsAt && t <= d.evidenceEndsAt
    const ruling = !!d.decideBy && t > (d.evidenceEndsAt ?? 0) && t <= d.decideBy
    const due = state === 'chain-review' ? !!d.reviewEndsAt && !inReview : !!d.decideBy && t > d.decideBy
    const out: string[] = []
    if (role === 'client') { out.push('accept'); if (state === 'chain-review' && inReview) out.push('dispute') }
    if (role === 'provider') out.push('give-way')
    if (role !== 'decider' && state === 'chain-disputed' && evidenceOpen) out.push('evidence')
    if (role === 'decider' && state === 'chain-disputed' && ruling) out.push('decide')
    if (due) out.push('finish')
    return out
  }
  if (role === 'decider') return []
  if (role === 'provider') return state === 'chain-draft' || state === 'chain-expired' ? ['quote'] : state === 'chain-funded' ? (now <= Number(r.quote?.quote.deliverBy ?? 0) * 1000 ? ['deliver', 'release'] : ['refund']) : []
  return state === 'chain-offered' ? ['fund'] : state === 'chain-funded' && now > Number(r.quote?.quote.deliverBy ?? 0) * 1000 ? ['refund'] : []
}
/** The dispute step of a milestone as one side sees it: the terms, the deadlines, the texts and how it ended. */
function disputeView(db: Db, r: Record_): Json | null {
  if (!r.dispute) return null
  const d = disputeOf(r) as (Json & { reviewEndsAt?: number; evidenceEndsAt?: number; decideBy?: number; deliveredAt?: number; disputedAt?: number; outcome?: string; toProvider?: string; toClient?: string; reason?: { hash: string } | null; evidence?: { by: string; hash: string }[] }) | undefined
  const t = r.dispute
  const span = (x: number) => (x % 86_400 === 0 ? `${x / 86_400} day${x === 86_400 ? '' : 's'}` : x % 3600 === 0 ? `${x / 3600} hour${x === 3600 ? '' : 's'}` : x % 60 === 0 ? `${x / 60} minute${x === 60 ? '' : 's'}` : `${x} seconds`)
  // a text counts as recorded only when the chain holds its hash
  const onChain = new Set([d?.reason?.hash, ...(d?.evidence ?? []).map((e) => e.hash)].filter(Boolean) as string[])
  return {
    decider: { handle: nameOf(db, t.deciderWs).handle, name: r.disputeJobId ? nameOf(db, t.deciderWs).name : null },
    terms: { review: span(t.reviewSeconds), evidence: span(t.evidenceSeconds), decision: span(t.decisionSeconds), reviewSeconds: t.reviewSeconds, evidenceSeconds: t.evidenceSeconds, decisionSeconds: t.decisionSeconds, onReviewPct: t.onReviewBps / 100, onDecisionPct: t.onDecisionBps / 100, may: t.deciderMay, test: t.test === true, words: r.quote?.dispute?.words ?? null },
    deadlines: { reviewEnds: when(d?.reviewEndsAt), evidenceEnds: when(d?.evidenceEndsAt), decideBy: when(d?.decideBy) },
    reason: r.texts?.reason ? { text: r.texts.reason.text, onChain: onChain.has(r.texts.reason.hash) } : null,
    evidence: (r.texts?.evidence ?? []).map((e) => ({ by: e.by, text: e.text, at: e.at, onChain: onChain.has(e.hash) })),
    outcome: d?.outcome && d.outcome !== 'none' ? { kind: d.outcome, words: OUTCOME_WORDS[d.outcome] ?? d.outcome, toProvider: Number(d.toProvider ?? 0), toClient: Number(d.toClient ?? 0) } : null,
  }
}
function milestoneView(db: Db, id: string, role: Role3, reachable: boolean, now: number): Json {
  const m = milestoneRow(db, id)!, r = getRec(db, id)!
  const chain = (r.chain ?? {}) as { opened?: unknown; settled?: unknown; refunded?: unknown; solutionHash?: string | null; authority?: unknown }
  // A step waiting for this side's own signature lapses by itself when its approval does: the Earn page says when. The
  // other side's request stays theirs: only that it waits is shown, not when they asked.
  const yours = !!r.pending && r.pending.ws === (role === 'provider' ? r.providerWs : role === 'client' ? r.clientWs : r.dispute?.deciderWs)
  const lapses = r.pending && yours && !r.pending.jobId && r.pending.approvalId ? db.get<{ expires_at: number }>('SELECT expires_at FROM approvals WHERE id = ?', r.pending.approvalId)?.expires_at ?? null : null
  return {
    id, title: m.title, amount: m.amount, amountText: `${inrExact(m.amount)} (test tINR)`, state: m.state,
    // when QED recorded the present state (ms): for a payment, when it first read the settlement from the chain
    since: m.updated_at,
    status: reachable ? STATUS[m.state](r, db, role) : `Status unknown: the on-chain wallet's service did not answer. Last known: ${STATUS[m.state](r, db, role)}`,
    deliverWithinHours: r.deliverWithinHours, deliverBy: iso(r.quote?.quote.deliverBy), offerValidUntil: iso(r.quote?.quote.validUntil),
    escrowJobId: r.escrowJobId ?? null, quoteHash: r.quote?.quoteHash ?? null,
    pending: r.pending ? { action: r.pending.action, approvalId: r.pending.approvalId ?? null, proposalId: r.pending.proposalId ?? null, jobId: r.pending.jobId ?? null, status: r.pending.jobId ? 'sending' : 'awaiting-signature', yours, expiresAt: lapses === null ? null : new Date(lapses).toISOString() } : null,
    last: lastFor(r, role), txs: { opened: chain.opened ?? null, settled: chain.settled ?? null, refunded: chain.refunded ?? null },
    evidence: chain.solutionHash ? { solutionHash: chain.solutionHash } : null,
    ...(role === 'provider' ? { authority: chain.authority ?? null } : {}),
    dispute: disputeView(db, r),
    actions: reachable ? actionsOf(m.state, r, role, now) : [],
  }
}

/** Everything the Earn screen needs for jobs on the chain, read back from the rail first. */
export async function earnChainView(cfg: RailCfg, db: Db, who: Asker, now: number): Promise<Json> {
  const mine = db.all<{ id: string; title: string; state: string; created_at: number; meta_json: string; user_id: string }>(`SELECT id, title, state, created_at, meta_json, user_id FROM earn_jobs WHERE user_id = ? AND json_extract(meta_json, '$.chain') IS NOT NULL ORDER BY created_at DESC`, who.workspaceId)
  const theirs = db.all<{ id: string; title: string; state: string; created_at: number; meta_json: string; user_id: string }>(`SELECT id, title, state, created_at, meta_json, user_id FROM earn_jobs WHERE json_extract(meta_json, '$.chain.clientWorkspace') = ? ORDER BY created_at DESC`, who.workspaceId)
  const deciding = db.all<{ id: string; title: string; state: string; created_at: number; meta_json: string; user_id: string }>(`SELECT id, title, state, created_at, meta_json, user_id FROM earn_jobs WHERE json_extract(meta_json, '$.chain.dispute.deciderWorkspace') = ? ORDER BY created_at DESC`, who.workspaceId)
  // every milestone is read back from the rail, settled ones too (their authority credit counts only after confirmations)
  let reachable = true
  const ids = [...mine, ...theirs, ...deciding].flatMap((job) => db.all<{ id: string }>('SELECT id FROM earn_milestones WHERE job_id = ? ORDER BY rowid', job.id).map((m) => m.id))
  for (const id of ids) {
    try { await reconcile(cfg, db, id, now) } catch (e) { if (e instanceof Unreachable) { reachable = false; break } throw e }
  }
  const out = (rows: typeof mine, role: Role3) => rows.map((jb) => {
    const meta = parse<{ chain?: { clientWorkspace: string; clientName: string; clientHandle: string; problem: Json } }>(jb.meta_json, {}).chain!
    const fresh = db.get<{ state: string }>('SELECT state FROM earn_jobs WHERE id = ?', jb.id)!.state
    // the client sees a milestone only once it has been offered: the provider's drafts are the provider's
    // the decider sees a milestone only once it was funded under its terms
    const ms = db.all<{ id: string }>('SELECT id FROM earn_milestones WHERE job_id = ? ORDER BY rowid', jb.id).filter((m) => role === 'provider' || (role === 'client' ? !!getRec(db, m.id)?.quote : !!getRec(db, m.id)?.disputeJobId)).map((m) => milestoneView(db, m.id, role, reachable, now))
    const isLinked = linked(db, jb.user_id, meta.clientWorkspace)
    // the provider learns the client's name once the client has funded a milestone, not from the handle alone (RISK-071)
    const named = role === 'provider' && !!db.get(`SELECT 1 FROM earn_milestones WHERE job_id = ? AND state IN ('chain-funded', 'chain-released', 'chain-refunded')`, jb.id)
    const clientLabel = named ? meta.clientName : `@${meta.clientHandle}`
    return {
      id: jb.id, title: jb.title, state: fresh, createdAt: jb.created_at, problem: meta.problem,
      ...(role === 'provider'
        ? { client: { name: named ? meta.clientName : null, handle: meta.clientHandle }, authority: isLinked ? { counts: false, why: `${clientLabel} and this workspace have a member in common: work between them adds nothing to the agent's authority budget (R7 D7). It is paid all the same.` } : { counts: true, why: 'Once it settles and has two confirmations, half the price adds to the agent\'s authority budget (R7 D7). QED cannot tell whether the client is the same person under another account.' } }
        : role === 'client' ? { provider: nameOf(db, jb.user_id) } : { provider: nameOf(db, jb.user_id), clientName: meta.clientName }),
      milestones: ms,
    }
  })
  return { reachable, asProvider: out(mine, 'provider'), asClient: out(theirs, 'client').filter((jb) => jb.milestones.length > 0), asDecider: out(deciding, 'decider').filter((jb) => jb.milestones.length > 0), problems: EARN_PROBLEMS, disputeDefaults: disputeDefaults(), disputeBounds: paperPolicy(), testStack: process.env.QED_TEST_STACK === '1' }
}

/** What the release's solver gives for a problem, before anyone quotes it: through this workspace's own vault. Nothing is prepared or sent. */
export async function previewChainProblem(cfg: RailCfg, db: Db, who: Asker, raw: unknown): Promise<Json> {
  const problem = problemOf((raw as Json | null)?.problem)
  return must(cfg, 'POST', at(mustVault(db, who.workspaceId), '/escrow/problems/preview'), { problem })
}
