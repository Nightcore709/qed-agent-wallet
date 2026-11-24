/**
 * The judge's walk-through (FinTechathon 2026, Topic F; R11-018): one connected account of the newest decision Ask made
 * for the household's on-chain wallet, from the household's own records and nothing else. It links, record to record:
 *
 *   the owner's objective (the question to Ask, as typed) and the authority already signed (the mandate)
 *   → the model's decision (the call, who answered as recorded, the proposal and QED's checks of it)
 *   → the terms the owner's passkey signed once (the vault job that put the standing policy in force)
 *   → the ticks that ran under it with no fresh signature (who asked for each, what it did, its transaction)
 *   → the evidence case of each (server/evidence.ts), which the screen loads and checks in the browser.
 *
 * Beside it, the branches a judge asks about: the same request with one input changed, a refusal (an instruction hidden
 * in pasted bill text), a revocation and the tick after it, and recovery (a request repeated after a lost answer is one
 * job; authority comes back only through a new passkey signature). The questions are fixed (shared/judge.ts), so each
 * is found by its exact words. Nothing here moves money or changes a record: the screen acts through the same routes as
 * every other page, under the same checks.
 *
 * Only the workspace the request acts in is read: every query names it, and vault records are read through that
 * workspace's own vault. A question to Ask and the model's words are shown only to the member who asked and to the
 * workspace's owners and admins (RISK-070, as server/evidence.ts does); others see that a question was asked.
 *
 * Also the runs recorded earlier with a real model (evidence/<date>-judge-*), read from their files: shown as replayed
 * records, never as current execution, each case checkable in the browser.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JUDGE_QUESTIONS } from '../shared/judge.ts'
import type { ModelsView } from './ask-models.ts'
import { type Db, notFound, parse } from './core.ts'
import { modelLabel, type VaultSource } from './evidence.ts'
import { vaultOf } from './rail.ts'
import { canAdminister, type Role } from './workspaces.ts'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const iso = (ms: unknown): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const STANDING = new Set(['policy-tick', 'policy-run'])

// ------------------------------------------------------------------------------------------------ the records read

export interface CallRow { id: string; ts: number; provider: string; model: string; ok: number; question: string; conversation_id: string | null; error: string | null; usage_json?: string | null }
export interface ProposalRow { id: string; ai_call_id: string | null; ts: number; kind: string; title: string; rationale: string | null; params_json: string | null; analysis_json: string | null; state: string; invalid_reason: string | null }
/** Everything the walk-through is assembled from, read once. Kept apart from the assembly so that tests give it records. */
export interface JudgeRecords {
  calls: CallRow[]
  proposals: ProposalRow[]
  /** Conversation id → the person who asked in it. */
  askers: Record<string, string>
  /** Null: no vault was set up for this household (or no vault service is configured). */
  vault: null | { unreachable: string | null; overview: Json; jobs: Json[]; decisions: Json[]; ticks: Json[]; verify: Json | null }
  /** Job id → when the engine's scheduler asked for it (its own record). */
  engineAsked: Record<string, number>
  /** Job id → each time the owner's session asked for it (audit vault.policy-tick, vault.policy-run). */
  ownerAsked: Record<string, number[]>
}

export interface JudgeOptions {
  db: Db
  workspaceId: string
  vault: VaultSource | null
  now: number
  presentation: boolean
  /** The model provider in force now (server/ai.ts detectProvider). */
  provider: { provider: string; model: string }
  /** On the Anthropic API: the models in order, where a question would go now, and the spending limits (server/ask-models.ts). */
  models?: ModelsView | null
  /** Who reads it. Absent: the workspace itself (tests). */
  reader?: { personId: string; role: Role }
}

/** Read every record the walk-through needs, for one workspace. Reads only. */
export async function readJudgeRecords(o: Pick<JudgeOptions, 'db' | 'workspaceId' | 'vault'>): Promise<JudgeRecords> {
  const { db, workspaceId: ws } = o
  const calls = db.all<CallRow>('SELECT id, ts, provider, model, ok, question, conversation_id, error, usage_json FROM ai_calls WHERE user_id = ? ORDER BY ts DESC, rowid DESC LIMIT 200', ws)
  const proposals = db.all<ProposalRow>(`SELECT id, ai_call_id, ts, kind, title, rationale, params_json, analysis_json, state, invalid_reason FROM proposals WHERE user_id = ? AND kind LIKE 'wallet-%' ORDER BY ts DESC, rowid DESC LIMIT 200`, ws)
  const askers: Record<string, string> = {}
  for (const r of db.all<{ id: string; person_id: string }>('SELECT id, person_id FROM conversations WHERE user_id = ?', ws)) askers[r.id] = r.person_id
  let vault: JudgeRecords['vault'] = null
  const engineAsked: Record<string, number> = {}
  const ownerAsked: Record<string, number[]> = {}
  if (o.vault && vaultOf(db, ws)) {
    try {
      const [overview, jobs, decisions, policy, verify] = await Promise.all([
        o.vault.overview(), o.vault.read('jobs', { limit: '200' }), o.vault.read('decisions', { limit: '200' }), o.vault.read('policy', { limit: '200' }), o.vault.read('decisions-verify').catch(() => null),
      ])
      vault = { unreachable: overview.available === false ? String(overview.reason ?? 'The vault service did not answer.') : null, overview, jobs: arr(jobs.jobs), decisions: arr(decisions.decisions), ticks: arr(policy.ticks), verify }
    } catch (e) {
      vault = { unreachable: e instanceof Error ? e.message : 'The vault service could not be read.', overview: {}, jobs: [], decisions: [], ticks: [], verify: null }
    }
    // Which of this vault's jobs the engine's scheduler asked for (its own record names the job), and which the owner's
    // session asked for, and how often. Only this workspace's job ids are looked for.
    const mine = new Set(vault.jobs.map((j) => String(j.id)))
    for (const e of db.all<{ ts: number; payload_json: string }>(`SELECT ts, payload_json FROM events WHERE (user_id = ? OR user_id IS NULL) AND type = 'vault' ORDER BY id DESC LIMIT 2000`, ws)) {
      for (const m of e.payload_json.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) if (mine.has(m[0]) && !(m[0] in engineAsked)) engineAsked[m[0]] = e.ts
    }
    for (const a of db.all<{ ts: number; subject: string }>(`SELECT ts, subject FROM audit WHERE user_id = ? AND action IN ('vault.policy-tick', 'vault.policy-run') ORDER BY id`, ws)) {
      if (mine.has(a.subject)) (ownerAsked[a.subject] ??= []).push(a.ts)
    }
  }
  return { calls, proposals, askers, vault, engineAsked, ownerAsked }
}

// ------------------------------------------------------------------------------------------------ what the screen gets

export interface Asset { symbol: string; decimals: number }
export interface Who { provider: string; model: string; isModel: boolean; label: string; statement: string }
export interface WalletCheckView { name: string; pass: boolean; detail: string }
export interface StepView { key: string; label: string; status: string; detail: string }
/** Where a decision came from (R13): a genuine call of a real model, the scripted test double, or nothing that answers. */
export type CallProvenance = 'genuine' | 'scripted' | 'none'
export interface CallView extends Who { id: string; caseId: string; at: string | null; ok: boolean; error: string | null; question: string | null; withheld: boolean; provenance: CallProvenance; spend?: CallSpend | null }
/**
 * On the Anthropic API (server/ask-models.ts): why this model, and what the question cost at the published prices, from
 * the call's own record. Model ids, outcomes and amounts only: no words of the question or the reply.
 */
export interface CallSpend { tier: string; why: string; costUsd: number; attempts: { model: string; answeredBy: string | null; outcome: string }[]; passedOver: { model: string; why: string }[]; priceSource: string | null }
export interface ProposalView { id: string; kind: string; title: string | null; rationale: string | null; params: Json; state: string; invalidReason: string | null; checks: WalletCheckView[] }
export interface JobView { jobId: string; caseId: string; kind: string; at: string | null; status: string; outcome: string; summary: string | null; error: string | null }
export interface TickView extends JobView {
  n: number | null; action: string | null; amountIn: string | null; limitedBy: string | null; reason: string | null
  /** Who asked for it: the engine's scheduler by itself, the owner's session (no signature), both, or no record. */
  requestedBy: 'engine' | 'owner' | 'engine-and-owner' | 'unrecorded'
  /** How many times the owner's session asked for this same job (a repeat with the same key is the same job). */
  asked: number
  tx: { hash: string; block: string | null; status: string | null } | null
  steps: StepView[]
}
export interface Decision { call: CallView; proposals: ProposalView[] }

export interface JudgeIndex {
  format: 'qed-judge-walkthrough/1'
  assembledAt: string
  presentation: boolean
  proposerNow: Who
  /** On the Anthropic API: the models in order, where a question would go now, and the spending limits. Null otherwise. */
  models: ModelsView | null
  wallet: { state: 'none' | 'unreachable' | 'awaiting-acceptance' | 'ready'; reason: string | null; network: string | null; chainId: number | null; asset: Asset; reserveAsset: Asset; decisionRecords: { ok: boolean; records: number; brokenAt: number | null } | null }
  /** The mandate in force (the newest), as the vault service reads it from the chain. */
  mandate: null | { version: number; status: string; perPayment: string; perPeriod: string; periodSeconds: number; total: string; validUntil: number | null; signedAt: string | null; purpose: string | null; jobCaseId: string | null }
  /** The standing policy as it stands now. */
  policy: null | { status: string; targetFree: string; signedAt: string | null; nonce: string | null; ticks: number }
  journey: null | {
    /** The objective: the question as typed (withheld from a member who may not read it). */
    decision: Decision
    /** The wallet-policy proposal this journey follows (null: the model proposed none). */
    proposal: ProposalView | null
    /** The vault job in which the owner's passkey signed the proposal's exact terms. */
    signed: (JobView & { policyNonce: string | null }) | null
    /** Every tick under that policy, newest first, and the one the walk-through follows (newest executed, else newest). */
    ticks: TickView[]
    execution: TickView | null
  }
  branches: {
    /** The same request with only the amount changed, each as Ask decided it. */
    changed: Decision[]
    /** An instruction hidden in pasted bill text, and what QED made of the proposal that followed it. */
    injected: Decision | null
    /** Other refusals on record, newest first: QED's checks, the co-signer, the chain. */
    refusals: (JobView & { by: string })[]
    revocation: null | (JobView & { next: TickView | null })
    /** The newest job the owner's session asked for more than once: one job, however often asked. */
    repeated: TickView | null
    /** A policy signed again after the revocation, and the first tick under it. */
    restored: null | (JobView & { next: TickView | null })
  }
}

// ------------------------------------------------------------------------------------------------ assembly

const PROVIDERS_WITH_A_MODEL = new Set(['claude-cli', 'anthropic-sdk'])
export const provenanceOf = (provider: string): CallProvenance => (PROVIDERS_WITH_A_MODEL.has(provider) ? 'genuine' : provider === 'scripted' ? 'scripted' : 'none')
function who(provider: string, model: string): Who {
  const m = modelLabel(provider, model)
  return { provider, model, isModel: m.isModel, label: m.label, statement: m.statement }
}
/** The provider in force, said as the records would say it once it answers (a configured CLI or SDK is a model). */
export function proposerNow(p: { provider: string; model: string }, models: ModelsView | null = null): Who {
  if (p.provider === 'anthropic-sdk' && models) {
    const now = models.demanding ? `${models.demanding} for a demanding question now` : 'no model for a demanding question now'
    return { provider: p.provider, model: models.demanding ?? models.routine ?? p.model, isModel: true, label: 'model', statement: `A real model answers Ask through the Anthropic API, chosen per question from ${models.order.map((m) => m.id).join(', ')} (${now}; ${models.routine ?? 'none'} for a routine one). ${models.rule} Each question is a metered call; QED records the model that answered and what it cost.` }
  }
  if (PROVIDERS_WITH_A_MODEL.has(p.provider)) return { provider: p.provider, model: p.model, isModel: true, label: 'model', statement: `A real model answers Ask: ${p.model}, through ${p.provider === 'claude-cli' ? 'the Claude command-line client signed in on this computer' : 'the Anthropic API'}. Each question is a metered model call.` }
  if (p.provider === 'scripted') return { provider: p.provider, model: p.model, isModel: false, label: 'scripted-test-double', statement: 'A scripted test double answers Ask from a fixed file. It is not a model: it shows what QED\'s controls do with a proposal, not what a model would propose. It runs only on an isolated test stack.' }
  return { provider: p.provider, model: p.model, isModel: false, label: 'none', statement: 'No model answers Ask on this installation, so no new decision can be asked for here.' }
}

const jobOutcome = (j: Json): string => (j.status === 'failed' ? 'failed' : String(obj(j.result).outcome ?? j.status ?? ''))
function jobView(j: Json): JobView {
  const r = obj(j.result)
  return { jobId: String(j.id), caseId: `vault.${String(j.id)}`, kind: String(j.kind ?? ''), at: str(j.finishedAt) ?? str(j.createdAt), status: String(j.status ?? ''), outcome: jobOutcome(j), summary: str(r.summary), error: str(j.error) }
}
const at = (j: Json): number => Date.parse(String(j.createdAt ?? '')) || 0

/** Whether this reader may read a model call's question and the model's own words (RISK-070). */
function readable(r: JudgeRecords, call: CallRow, reader: JudgeOptions['reader']): boolean {
  if (!reader || canAdminister(reader.role)) return true
  return !!call.conversation_id && r.askers[call.conversation_id] === reader.personId
}

function proposalView(p: ProposalRow, open: boolean): ProposalView {
  const an = parse<Json>(p.analysis_json, {})
  const wallet = obj(an.wallet)
  const params = obj(parse<Json>(p.params_json, {}).params)
  return {
    id: p.id, kind: p.kind, state: p.state,
    // the title and rationale are the model's words, and a reason can quote the owner's: only for those who may read them
    title: open ? p.title : null, rationale: open ? p.rationale : null, params: open ? params : {},
    invalidReason: open ? p.invalid_reason : (p.invalid_reason ? 'Not valid (the reason quotes words this member may not read).' : null),
    checks: arr<WalletCheckView>(wallet.checks).map((c) => ({ name: String(c.name), pass: c.pass === true, detail: open ? String(c.detail ?? '') : '' })),
  }
}
/** The call's route and cost, when the API path recorded them (its usage_json holds the attempts; ask-models.ts CallRecord). */
function spendOf(call: CallRow): CallSpend | null {
  const u = parse<Json>(call.usage_json, {})
  if (typeof u.tier !== 'string' || !Array.isArray(u.attempts)) return null
  return {
    tier: u.tier, why: String(u.why ?? ''), costUsd: Number(u.costUsd) || 0,
    attempts: arr(u.attempts).map((a) => ({ model: String(a.model ?? ''), answeredBy: str(a.answeredBy), outcome: String(a.outcome ?? '') })),
    passedOver: arr(u.passedOver).map((p) => ({ model: String(p.model ?? ''), why: String(p.why ?? '') })), priceSource: str(u.priceSource),
  }
}
function decisionOf(r: JudgeRecords, call: CallRow, reader: JudgeOptions['reader']): Decision {
  const open = readable(r, call, reader)
  return {
    call: { ...who(call.provider, call.model), id: call.id, caseId: `ask.${call.id}`, at: iso(call.ts), ok: Number(call.ok) === 1, error: open ? call.error : null, question: open ? call.question : null, withheld: !open, provenance: provenanceOf(call.provider), spend: spendOf(call) },
    proposals: r.proposals.filter((p) => p.ai_call_id === call.id).sort((a, b) => a.ts - b.ts).map((p) => proposalView(p, open)),
  }
}

function tickView(r: JudgeRecords, j: Json): TickView {
  const id = String(j.id)
  const t = r.vault?.ticks.find((x) => x.jobId === id) ?? {}
  const tx = obj(obj(j.result).tx)
  const engine = id in r.engineAsked, owner = (r.ownerAsked[id] ?? []).length
  return {
    ...jobView(j),
    n: typeof t.n === 'number' ? t.n : null, action: str(t.action), amountIn: str(t.amountIn), limitedBy: str(t.limitedBy), reason: str(t.reason),
    requestedBy: engine && owner ? 'engine-and-owner' : engine ? 'engine' : owner ? 'owner' : 'unrecorded', asked: owner,
    tx: typeof tx.hash === 'string' ? { hash: tx.hash, block: tx.block !== undefined && tx.block !== null ? String(tx.block) : null, status: str(tx.status) } : null,
    steps: arr(j.steps).map((s) => ({ key: String(s.key ?? ''), label: String(s.label ?? ''), status: String(s.status ?? ''), detail: String(s.detail ?? '') })),
  }
}
/** The first job of a standing kind created after a moment, as a tick. */
function nextTick(r: JudgeRecords, afterMs: number): TickView | null {
  const next = (r.vault?.jobs ?? []).filter((j) => STANDING.has(String(j.kind)) && at(j) > afterMs).sort((a, b) => at(a) - at(b))[0]
  return next ? tickView(r, next) : null
}

/** The walk-through, from records already read. Pure: the tests give it records. */
export function buildJudgeIndex(r: JudgeRecords, o: Pick<JudgeOptions, 'now' | 'presentation' | 'provider' | 'reader' | 'models'>): JudgeIndex {
  const v = r.vault
  const ov = obj(v?.overview), state = obj(ov.state), ws = obj(ov.workspace)
  const asset = { symbol: String(obj(ws.asset).symbol ?? 'tINR'), decimals: Number(obj(ws.asset).decimals ?? 2) }
  const reserveAsset = { symbol: String(obj(ws.reserveAsset).symbol ?? 'tUSD'), decimals: Number(obj(ws.reserveAsset).decimals ?? 6) }
  const network = obj(state.network)
  const walletState: JudgeIndex['wallet']['state'] = !v ? 'none' : v.unreachable ? 'unreachable' : ov.setUp === false ? 'none' : state.provisioned === true ? 'ready' : 'awaiting-acceptance'
  const verify = obj(obj(v?.verify).server ?? v?.verify)
  const jobs = v?.jobs ?? [], decisions = v?.decisions ?? []
  const jobById = new Map(jobs.map((j) => [String(j.id), j]))

  // the authority in force now, as the chain has it
  const m = obj(state.mandate), mf = obj(m.fields)
  const mandateJob = jobs.filter((j) => j.kind === 'mandate' && jobOutcome(j) === 'executed').sort((a, b) => at(b) - at(a))[0]
  const mandate: JudgeIndex['mandate'] = m.version !== undefined ? {
    version: Number(m.version), status: String(m.status ?? ''), perPayment: String(mf.maxPerPayment ?? '0'), perPeriod: String(mf.maxPerPeriod ?? '0'), periodSeconds: Number(mf.period ?? 0), total: String(mf.maxTotal ?? '0'),
    validUntil: mf.validUntil !== undefined ? Number(mf.validUntil) : null, signedAt: str(m.signedAt), purpose: str(m.purposeText), jobCaseId: mandateJob ? `vault.${String(mandateJob.id)}` : null,
  } : null
  const p = obj(state.policy)
  const policy: JudgeIndex['policy'] = p.status !== undefined ? { status: String(p.status), targetFree: String(p.targetFree ?? '0'), signedAt: str(p.signedAt), nonce: str(p.nonce), ticks: Number(p.ticks ?? 0) } : null

  // the journey: the newest call that proposed a standing policy for the wallet, or that asked the objective's words
  const policyCalls = new Set(r.proposals.filter((x) => x.kind === 'wallet-policy').map((x) => x.ai_call_id))
  const anchor = r.calls.find((c) => policyCalls.has(c.id) || c.question === JUDGE_QUESTIONS.objective)
  let journey: JudgeIndex['journey'] = null
  if (anchor) {
    const decision = decisionOf(r, anchor, o.reader)
    const row = r.proposals.filter((x) => x.ai_call_id === anchor.id && x.kind === 'wallet-policy').sort((a, b) => b.ts - a.ts)[0]
    const proposal = decision.proposals.find((x) => x.id === row?.id) ?? null
    // the terms drafted from it that the owner signed: kept on the proposal by server/ai.ts draftWalletProposal
    const drafts = row ? arr(obj(parse<Json>(row.analysis_json, {}).wallet).drafts).filter((d) => d.ok === true && typeof d.vaultProposalId === 'string') : []
    const signedJob = drafts.map((d) => jobs.find((j) => j.proposalId === d.vaultProposalId)).filter((j): j is Json => !!j).sort((a, b) => at(b) - at(a))[0]
    const nonce = signedJob ? str(obj(obj(decisions.find((d) => d.kind === 'owner-policy' && d.jobId === signedJob.id)?.record).policy).nonce) : null
    const tickIds = new Set(nonce ? decisions.filter((d) => d.kind === 'policy-decision' && obj(d.record).policyNonce === nonce).map((d) => String(d.jobId)) : [])
    const ticks = [...tickIds].map((id) => jobById.get(id)).filter((j): j is Json => !!j).sort((a, b) => at(b) - at(a)).map((j) => tickView(r, j))
    const execution = ticks.find((t) => t.outcome === 'executed') ?? ticks[0] ?? null
    journey = { decision, proposal, signed: signedJob ? { ...jobView(signedJob), policyNonce: nonce } : null, ticks, execution }
  }

  // the branches, each found by the exact words the walk-through asks
  const newestCall = (q: string) => r.calls.find((c) => c.question === q)
  const changed = [JUDGE_QUESTIONS.payLow, JUDGE_QUESTIONS.payHigh].map(newestCall).filter((c): c is CallRow => !!c).map((c) => decisionOf(r, c, o.reader))
  const injectedCall = newestCall(JUDGE_QUESTIONS.injected)
  const refusals = jobs.filter((j) => ['refused', 'reverted', 'failed'].includes(jobOutcome(j))).sort((a, b) => at(b) - at(a)).slice(0, 8)
    .map((j) => ({ ...jobView(j), by: refusedBy(j) }))
  const revokeJob = jobs.filter((j) => j.kind === 'policy-revoke' && jobOutcome(j) === 'executed').sort((a, b) => at(b) - at(a))[0]
  const revocation = revokeJob ? { ...jobView(revokeJob), next: nextTick(r, at(revokeJob)) } : null
  const repeatedId = Object.entries(r.ownerAsked).filter(([, ts]) => ts.length > 1).sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))[0]?.[0]
  const repeatedJob = repeatedId ? jobById.get(repeatedId) : undefined
  const restoredJob = revokeJob ? jobs.filter((j) => j.kind === 'policy' && jobOutcome(j) === 'executed' && at(j) > at(revokeJob)).sort((a, b) => at(a) - at(b))[0] : undefined
  return {
    format: 'qed-judge-walkthrough/1', assembledAt: new Date(o.now).toISOString(), presentation: o.presentation, proposerNow: proposerNow(o.provider, o.models ?? null), models: o.models ?? null,
    wallet: {
      state: walletState, reason: v?.unreachable ?? (walletState === 'none' ? 'This household has no on-chain wallet yet.' : null), network: str(network.name), chainId: typeof network.chainId === 'number' ? network.chainId : null,
      asset, reserveAsset, decisionRecords: verify.ok !== undefined ? { ok: verify.ok === true, records: Number(verify.records ?? 0), brokenAt: typeof verify.brokenAt === 'number' ? verify.brokenAt : null } : null,
    },
    mandate, policy, journey,
    branches: {
      changed, injected: injectedCall ? decisionOf(r, injectedCall, o.reader) : null, refusals, revocation,
      repeated: repeatedJob ? tickView(r, repeatedJob) : null,
      restored: restoredJob ? { ...jobView(restoredJob), next: nextTick(r, at(restoredJob)) } : null,
    },
  }
}
/** Who refused a job, from the step that said no: QED's own check, the co-signer, or the chain. */
function refusedBy(j: Json): string {
  const s = arr(j.steps).find((x) => ['refused', 'failed', 'reverted', 'error'].includes(String(x.status)))
  const key = String(s?.key ?? '')
  if (key === 'cosigner') return 'cosigner'
  if (key === 'receipt' || key === 'submit' || obj(obj(j.result).tx).status === 'reverted') return 'chain'
  if (key === 'mandate' || key === 'interpret' || key === 'decide') return 'qed'
  return j.status === 'failed' ? 'vault-service' : 'qed'
}

export async function judgeIndex(o: JudgeOptions): Promise<JudgeIndex> {
  return buildJudgeIndex(await readJudgeRecords(o), o)
}

// ------------------------------------------------------------------------------------------------ runs recorded earlier

export interface RecordedCall { caseId: string; provider: string; model: string; genuine: boolean; costUsd: number | null }
export interface RecordedRun {
  id: string; how: 'api-journey' | 'browser-walkthrough'; producedAt: string | null
  revision: { commit: string | null; dirty: boolean | null }
  passed: number | null; failed: number | null
  calls: RecordedCall[]; costUsd: number | null
  /** The cases a judge opens first, by what they show. */
  cases: { role: string; caseId: string }[]
  cannotProve: string[]
  /** Always historical: read from files, never current execution (R13). */
  provenance: 'historical'
  /** Who asked for the tick the run followed, as its case records it (section 4), when the run kept that case. */
  tickAskedBy: string | null
  /** Whether QED's own checks refused a proposal in the changed-inputs or the injected step (false: the model proposed nothing there). */
  qedRefusedAProposal: boolean | null
}
const RUN = /^\d{8}-judge-[a-z0-9-]{2,60}$/
const CASE = /^(run|ask|vault)\.[A-Za-z0-9_-]{6,80}$/
const readJson = (f: string): Json | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as Json } catch { return null } }

/** One recorded case's model call, as its section 2 recorded it. */
function callOf(dir: string, caseId: string): RecordedCall | null {
  const c = readJson(join(dir, 'cases', `${caseId}.json`))
  const call = obj(obj(obj(c?.sections)['2']).call)
  if (typeof call.provider !== 'string') return null
  const cost = Number(obj(call.usage).cost_usd)
  return { caseId, provider: call.provider, model: String(call.model ?? ''), genuine: PROVIDERS_WITH_A_MODEL.has(call.provider) && call.ok === true, costUsd: Number.isFinite(cost) ? cost : null }
}

/**
 * The judge runs recorded with a real model under evidence/ (read only): the API journey's summary.json
 * (scripts/judge-journey.ts --real-model) or the browser walk-through's judge-live.json (scripts/judge-live.ts
 * --real-model). A rehearsal with the scripted double is never listed: it is not a model's decision.
 */
export function recordedRuns(evidenceDir: string): RecordedRun[] {
  if (!existsSync(evidenceDir)) return []
  const out: RecordedRun[] = []
  for (const id of readdirSync(evidenceDir).filter((d) => RUN.test(d)).sort().reverse()) {
    const dir = join(evidenceDir, id)
    if (!statSync(dir).isDirectory()) continue
    const live = readJson(join(dir, 'judge-live.json')), summary = live ? null : readJson(join(dir, 'summary.json'))
    if (live && live.rehearsal === false && live.format === 'qed-judge-live/1') {
      const calls = arr(live.decisions).map((d) => ({ caseId: String(d.caseId ?? ''), provider: String(d.provider ?? ''), model: String(d.model ?? ''), genuine: d.genuineModelCall === true, costUsd: typeof d.costUsd === 'number' ? d.costUsd : null }))
      if (!calls.some((c) => c.genuine)) continue
      const cases = arr(live.mainCases).map((c) => ({ role: String(c.role), caseId: String(c.caseId) })).filter((c) => CASE.test(c.caseId) && existsSync(join(dir, 'cases', `${c.caseId}.json`)))
      const branch = arr(live.decisions).filter((d) => d.step === 'changed-inputs' || d.step === 'injected')
      out.push({ id, how: 'browser-walkthrough', producedAt: str(live.producedAt), revision: { commit: str(obj(live.revision).commit), dirty: typeof obj(live.revision).dirty === 'boolean' ? obj(live.revision).dirty as boolean : null },
        passed: typeof live.passed === 'number' ? live.passed : null, failed: typeof live.failed === 'number' ? live.failed : null, calls, costUsd: sumCost(calls), cases,
        cannotProve: arr<string>(live.cannotProve).map(String), provenance: 'historical',
        tickAskedBy: askedBy(dir, cases.find((c) => /tick/i.test(c.role))?.caseId),
        qedRefusedAProposal: branch.length ? branch.some((d) => arr(d.proposals).some((p) => p.state === 'invalid')) : null })
    } else if (summary && PROVIDERS_WITH_A_MODEL.has(String(obj(summary.proposer).provider))) {
      const main = obj(summary.main), n009 = obj(main.n009)
      const modelCases = arr(summary.cases).filter((c) => c.kind === 'model-call').map((c) => String(c.id))
      const calls = modelCases.map((c) => callOf(dir, c)).filter((c): c is RecordedCall => !!c)
      const roles: [string, unknown][] = [['The model\'s proposal of the standing policy', n009.policyCall], ['The owner signs its exact terms once', n009.policySigned], ['The engine\'s tick, with no fresh signature', n009.engineTick], ['An instruction hidden in a bill', n009.injectedTransfer], ['A tick beyond the authority budget, refused by the co-signer', n009.beyondBudget], ['After the policy was revoked', obj(main.variants).revoked]]
      out.push({ id, how: 'api-journey', producedAt: str(summary.producedAt), revision: { commit: str(obj(summary.revision).commit), dirty: typeof obj(summary.revision).dirty === 'boolean' ? obj(summary.revision).dirty as boolean : null },
        passed: typeof summary.passed === 'number' ? summary.passed : null, failed: typeof summary.failed === 'number' ? summary.failed : null, calls, costUsd: sumCost(calls),
        cases: roles.filter((x): x is [string, string] => typeof x[1] === 'string' && CASE.test(x[1]) && existsSync(join(dir, 'cases', `${x[1]}.json`))).map(([role, caseId]) => ({ role, caseId })),
        cannotProve: arr<string>(summary.cannotProve).map(String), provenance: 'historical', tickAskedBy: askedBy(dir, str(n009.engineTick) ?? undefined), qedRefusedAProposal: null })
    }
  }
  return out
}
/** Who asked for a recorded tick, in the words its case recorded (section 4, requestedBy.who). */
function askedBy(dir: string, caseId: string | undefined): string | null {
  if (!caseId || !CASE.test(caseId)) return null
  return str(obj(obj(obj(readJson(join(dir, 'cases', `${caseId}.json`))?.sections)['4']).requestedBy).who)
}
const sumCost = (calls: RecordedCall[]): number | null => { const c = calls.map((x) => x.costUsd).filter((x): x is number => x !== null); return c.length ? Math.round(c.reduce((a, b) => a + b, 0) * 1000) / 1000 : null }

/** One case of a recorded run, exactly as it was written (the browser recomputes its hashes). */
export function recordedCase(evidenceDir: string, runId: string, caseId: string): Json {
  if (!RUN.test(runId) || !CASE.test(caseId) || !recordedRuns(evidenceDir).some((r) => r.id === runId)) throw notFound('That recorded case')
  const c = readJson(join(evidenceDir, runId, 'cases', `${caseId}.json`))
  if (!c) throw notFound('That recorded case')
  return c
}

// ------------------------------------------------------------------------------------------------ the actual-model adversarial evaluation

/**
 * The live run of the original 30 adversarial cases (24 Nov 2026), referenced where it is kept (docs/research, read only)
 * with its diagnosis: what a judge reads as the actual-model evaluation (R13 keeps the 30-case minimum). Its figures
 * come from the run's own files: the run (cases and outcomes), its calls table (calls, models, the client-reported
 * cost) and the diagnosis made from them. Null when this build does not carry those files.
 */
export interface AdversarialEvaluation {
  provenance: 'historical'; file: string; generatedAt: string | null; commit: string | null; mode: string
  calls: { genuine: number; models: string[]; providers: string[]; costUsd: number | null } | null
  cases: number; passed: number; failed: number; notRun: number
  failing: { id: string; check: string; cause: string; status: string; summary: string; regression: string | null }[]
  qedControlFault: string | null
  rerun: { status: string; covers: string; genuineCalls: number | null; costUsd: number | null } | null
}
const QA = join('docs', 'research', 'qed-qa-reliability')
export function adversarialEvaluation(repoRoot: string): AdversarialEvaluation | null {
  const file = join(QA, '20261124-adversarial-ask-live-original30.json')
  const run = readJson(join(repoRoot, file))
  if (!run || run.mode !== 'live') return null
  const sum = obj(run.summary)
  let calls: AdversarialEvaluation['calls'] = null
  try {
    const rows = readFileSync(join(repoRoot, QA, 'runs', 'adversarial-live-calls.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'))
    const cost = rows.map((r) => Number(r[8])).filter(Number.isFinite)
    calls = { genuine: rows.filter((r) => PROVIDERS_WITH_A_MODEL.has(String(r[2])) && r[4] === '1').length, models: [...new Set(rows.map((r) => String(r[3])))], providers: [...new Set(rows.map((r) => String(r[2])))], costUsd: cost.length ? Math.round(cost.reduce((a, b) => a + b, 0) * 100) / 100 : null }
  } catch { /* the calls table is not in this build */ }
  const dx = readJson(join(repoRoot, QA, '20261124-adversarial-ask-live-diagnosis.json'))
  const dxCase = (id: string) => arr(dx?.cases).find((c) => c.id === id) ?? null
  const rr = obj(dx?.rerunRequest)
  return {
    provenance: 'historical', file, generatedAt: str(run.generatedAt), commit: str(obj(run.code).commit), mode: 'live', calls,
    cases: Number(sum.cases ?? 0), passed: Number(sum.pass ?? 0), failed: Number(sum.fail ?? 0), notRun: Number(sum.notRun ?? 0),
    failing: arr(run.failing).map((f) => { const d = dxCase(String(f.id)); return { id: String(f.id), check: String(arr(f.failed)[0]?.check ?? ''), cause: str(d?.cause) ?? 'not diagnosed', status: str(d?.status) ?? 'Hypothesis', summary: str(d?.summary) ?? 'Not yet diagnosed.', regression: str(d?.regression) } }),
    qedControlFault: str(dx?.qedControlFault),
    rerun: dx ? { status: String(rr.status ?? ''), covers: String(rr.covers ?? ''), genuineCalls: typeof rr.genuineCalls === 'number' ? rr.genuineCalls : null, costUsd: typeof obj(rr.costUsdEstimate).expected === 'number' ? obj(rr.costUsdEstimate).expected as number : null } : null,
  }
}

/**
 * The live re-run of 24 Nov (B1, L1, M1 and the 20 cases added since, approved by the owner), where it is kept, with its
 * diagnosis: genuine model calls, shown as historical evidence beside the first run. Its call count and cost come from
 * the diagnosis, which read them from the run's own stack records (the run's file holds the case calls only, not the
 * seed turns). Null when this build does not carry the files.
 */
export interface AdversarialRerun {
  provenance: 'historical'; genuine: true; file: string; generatedAt: string | null; commit: string | null
  calls: { genuine: number; costUsd: number; models: string } | null
  cases: number; passed: number; failed: number
  failing: { id: string; cause: string; status: string; summary: string; regression: string | null }[]
  verdict: string | null; findings: { id: string; status: string; finding: string }[]
}
export function adversarialRerun(repoRoot: string): AdversarialRerun | null {
  const file = join(QA, '20261124-adversarial-ask-live-rerun.json')
  const run = readJson(join(repoRoot, file)), dx = readJson(join(repoRoot, QA, '20261124-adversarial-ask-live-rerun-diagnosis.json'))
  if (!run || run.mode !== 'live') return null
  const sum = obj(run.summary), facts = obj(dx?.run)
  return {
    provenance: 'historical', genuine: true, file, generatedAt: str(run.generatedAt), commit: str(obj(run.code).commit),
    calls: typeof facts.genuineCalls === 'number' && typeof facts.costUsdClientReported === 'number' ? { genuine: facts.genuineCalls, costUsd: Math.round(facts.costUsdClientReported * 100) / 100, models: String(facts.models ?? '') } : null,
    cases: Number(sum.cases ?? 0), passed: Number(sum.pass ?? 0), failed: Number(sum.fail ?? 0),
    failing: arr(dx?.cases).map((c) => ({ id: String(c.id), cause: String(c.cause ?? ''), status: String(c.status ?? ''), summary: String(c.summary ?? ''), regression: str(c.regression) })),
    verdict: str(obj(dx?.securityVerdict).statement),
    findings: arr(dx?.otherFindings).map((f) => ({ id: String(f.id), status: String(f.status ?? ''), finding: String(f.finding ?? '') })),
  }
}
