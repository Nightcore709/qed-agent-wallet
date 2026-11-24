/**
 * Evidence cases (FinTechathon Topic F): what one autonomous action, refusal or model proposal rested on, answered
 * from this workspace's own records and nothing else. A case is assembled when it is asked for, from the tables the
 * engine and the API wrote (ai_calls, proposals, programs and their versions, approvals and their passkey signatures,
 * runs, actions, receipts, the ledger) and from the vault service's records, read through server/rail.ts (reads only).
 * It is then sealed: a SHA-256 per section and a root (server/evidence-verify.ts), which scripts/verify-evidence.ts
 * re-checks offline and, with --rpc, against the chain.
 *
 * Three kinds of case, each named by the record it starts from:
 *   run.<run id>      one run of a standing instruction on the paper engine (and the model call it began with, if any)
 *   ask.<ai call id>  one model call and what QED's own code made of each proposal in it
 *   vault.<job id>    one job of the household's on-chain vault: a policy tick, a conversion, a payment, a refusal
 *
 * Sections: 1 objective and authority, 2 the model, 3 enforcement, 4 standing authority, 5 balances, costs and
 * consequence, 6 the technical record, 7 changed inputs, 8 refusals. Nothing is narrated: each statement is a field of
 * a record, a figure computed from records, or labelled as a probe evaluated now by the same code. What is left out is
 * listed under `redactions`, and what the case cannot show under `cannotProve`.
 *
 * Only the workspace the request acts in is ever read: every query carries its id, and a vault job is read through
 * that workspace's own vault, so another workspace's case is simply not found.
 */
import { readFileSync } from 'node:fs'
import { fromAmountText } from '../shared/amount-text.ts'
import { inrExact } from '../shared/money.ts'
import { type Config, type Db, j, notFound, parse } from './core.ts'
import { CASE_FORMAT, SECTION_TITLES, approvalChallengeHex, sealCase, sha256hex, type AuthorityInstrument, type BalanceEntry, type ChainEntry, type CheckEntry, type DecisionEntry, type EvidenceCase, type LedgerEntryView, type MovedEntry, type SignatureEntry, type StepEntry, type TxEntry, type UnsealedCase } from './evidence-verify.ts'
import { verifyLedger } from './ledger.ts'
import { decide } from './policy.ts'
import { preparedIn } from './prepared.ts'
import { genesis, verifyChain } from './receipts.ts'
import { readiness } from './readiness.ts'
import { type Asker, railItem, railOverview, railRead, type RailCfg, vaultOf } from './rail.ts'
import type { RelyingParty } from './passkeys.ts'
import { actionFromRow, type Ctx } from './types.ts'
import { canAdminister, type Role } from './workspaces.ts'

type Json = Record<string, unknown>
type Row = Record<string, unknown>

// ------------------------------------------------------------------------------------------------ where vault records come from

/** The vault service's records, read-only: through server/rail.ts in the API, from recorded replies in tests. */
export interface VaultSource {
  overview(): Promise<Json>
  read(name: string, query?: Record<string, string>): Promise<Json>
  item(what: 'jobs' | 'proposals' | 'receipts', id: string): Promise<Json>
}
export function railSource(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker): VaultSource {
  return {
    overview: () => railOverview(cfg, db, rp, who),
    read: (name, q = {}) => railRead(cfg, db, who, name, new URLSearchParams(q)),
    item: (what, id) => railItem(cfg, db, who, what, id),
  }
}

export interface AssembleOptions {
  db: Db
  workspaceId: string
  vault: VaultSource | null
  now: number
  /** The engine's context, for probes that re-run the engine's own checks on a changed input (absent: no paper probes). */
  ctx?: Ctx
  /** The model configuration in force when the case is assembled (only to describe a scripted double's file). */
  ai?: Pick<Config, 'aiProvider' | 'aiScript'>
  rpId?: string
  /**
   * Who reads the case. A question to Ask, its earlier turns and the model's reply are the asker's (RISK-070): another
   * member below admin reads their SHA-256 only, as the Ask page shows a person only their own conversations. Absent:
   * the workspace itself (the tests and the judge journey's export).
   */
  reader?: { personId: string; role: Role }
}

const WITHHELD = 'This question to Ask and what the model answered are shown only to the member who asked it, and the workspace\'s owners and admins; their SHA-256 is here so the case can still be checked.'
/** Whether this reader may read a model call's question, earlier turns and reply. */
function readsAsk(o: AssembleOptions, call: Row): boolean {
  if (!o.reader || canAdminister(o.reader.role)) return true
  const asker = o.db.get<{ person_id: string }>('SELECT person_id FROM conversations WHERE id = ? AND user_id = ?', String(call.conversation_id ?? ''), o.workspaceId)?.person_id
  return asker === o.reader.personId
}
const objectiveOf = (o: AssembleOptions, call: Row): Json => readsAsk(o, call)
  ? { text: call.question, source: 'the owner\'s question to Ask, as typed', at: iso(call.ts) }
  : { text: 'A question asked by another member of this workspace.', questionSha256: sha256hex(String(call.question ?? '')), source: WITHHELD, at: iso(call.ts) }

// ------------------------------------------------------------------------------------------------ small helpers

const iso = (ms: unknown): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const fingerprint = (s: string): string => `sha256:${sha256hex(s).slice(0, 16)}`
const rupees = (paise: unknown): string => inrExact(Number(paise ?? 0))
const units = (raw: unknown, decimals: number, symbol: string): string => {
  const n = BigInt(String(raw ?? '0')), neg = n < 0n, a = neg ? -n : n, d = 10n ** BigInt(decimals)
  const frac = decimals ? `.${String(a % d).padStart(decimals, '0')}`.replace(/0+$/, '').replace(/\.$/, '') : ''
  return `${neg ? '-' : ''}${String(a / d)}${frac} ${symbol}`
}
const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const hexOf = (s: string): string => `0x${s.replace(/^0x/, '').toLowerCase()}`
const ID = /^(run|ask|vault)\.([A-Za-z0-9_-]{6,80})$/

function revision(): Json {
  try { const r = readiness() as { build?: { revision: string | null; dirty: boolean | null }; release?: { id: string | null } }; return { commit: r.build?.revision ?? null, uncommittedChanges: r.build?.dirty ?? null, derivesFromRelease: r.release?.id ?? null, source: 'server/readiness.ts: the git revision the running code was started from' } }
  catch { return { commit: null, uncommittedChanges: null, derivesFromRelease: null, source: 'unavailable' } }
}

/** Who answered: a model, a scripted test double, QED's own rules, or nobody. Words as the records have them. */
export function modelLabel(provider: string | null | undefined, model: string | null | undefined): { involved: boolean; isModel: boolean; label: 'model' | 'scripted-test-double' | 'test-double' | 'rules' | 'none'; statement: string } {
  if (provider === 'scripted') return { involved: true, isModel: false, label: 'scripted-test-double', statement: `A scripted test double, NOT a model: it answers from a fixed file, and QED honours it only on an isolated test stack. Recorded as provider "${provider}", model "${String(model)}".` }
  if (provider === 'injected') return { involved: true, isModel: false, label: 'test-double', statement: 'A test double injected by a unit test, NOT a model.' }
  if (provider === 'claude-cli' || provider === 'anthropic-sdk') return { involved: true, isModel: true, label: 'model', statement: `A real model call: provider "${provider}", model "${String(model)}", as recorded when it answered.` }
  if (provider === 'rules') return { involved: false, isModel: false, label: 'rules', statement: 'Computed by QED\'s fixed rules from recorded data. No model is involved.' }
  return { involved: false, isModel: false, label: 'none', statement: 'No model took part.' }
}

const ALWAYS_REDACTED = [
  { what: 'Credentials', how: 'never read', why: 'Password hashes, recovery codes, session tokens and the vault service\'s bearer token are not part of any case.' },
  { what: 'Session data', how: 'omitted', why: 'The hash of the session an approval was given in, sign-in times and user agents are not needed to judge a decision.' },
  { what: 'Recovery data', how: 'never read', why: 'Recovery codes, contacts and requests have nothing to do with a money decision.' },
  { what: 'Passkey credential ids', how: 'replaced by "sha256:" and the first 16 hex digits of their SHA-256', why: 'That is enough to tell passkeys apart; the public key, which a verifier needs, is kept.' },
  { what: 'Network addresses', how: 'omitted', why: 'The audit log\'s IP addresses are not needed to judge a decision.' },
]
const FORGERY = 'A forger who rewrites this file and recomputes every hash makes a file that is consistent in itself. Compare its root with one obtained independently (verify-evidence.ts --root), check the receipt-chain head against a fresh read (--head), or re-read the transactions from the chain (--rpc).'
const NO_REVIEW = 'No one outside this work has reviewed the code that made these records (server/readiness.ts lists this as a standing blocker).'

// ------------------------------------------------------------------------------------------------ shared record readers

/** The passkey signatures on one approval, as a verifier needs them: public key, exact challenge, assertion. */
function signaturesOf(db: Db, approvalId: string, docHash: string, rpId: string): SignatureEntry[] {
  const out: SignatureEntry[] = []
  for (const r of db.all<{ credential_id: string; evidence_json: string }>('SELECT credential_id, evidence_json FROM approval_signatures WHERE approval_id = ? ORDER BY signed_at', approvalId)) {
    const ev = parse<Json>(r.evidence_json, {})
    if (Array.isArray(ev.vault)) {
      for (const v of ev.vault as Json[]) out.push({ type: 'webauthn-es256', credential: fingerprint(String(v.credentialId)), publicKey: obj(v.publicKey) as { x: string; y: string }, challenge: hexOf(String(v.digest)), challengeIs: `owner-account digest terms.toSign[${Number(v.item)}]`, authenticatorData: String(v.authenticatorData), clientDataJSON: String(v.clientDataJSON), signature: String(v.signature), rpId })
      continue
    }
    const key = db.get<{ x: string; y: string }>('SELECT x, y FROM webauthn_credentials WHERE id = ?', r.credential_id)
    if (!key || typeof ev.clientDataJSON !== 'string') continue
    out.push({ type: 'webauthn-es256', credential: fingerprint(r.credential_id), publicKey: { x: hexOf(key.x), y: hexOf(key.y) }, challenge: hexOf(approvalChallengeHex(approvalId, docHash)), challengeIs: 'approval challenge: SHA-256("qed/approval/v1\\n" + approval id + "\\n" + document hash)', authenticatorData: String(ev.authenticatorData), clientDataJSON: Buffer.from(ev.clientDataJSON, 'base64url').toString('utf8'), signature: String(ev.signature), rpId })
  }
  return out
}
function approvalView(db: Db, ws: string, id: string | null | undefined): Json | null {
  if (!id) return null
  const a = db.get<Row>('SELECT id, purpose, subject, doc_hash, method, created_at, expires_at, confirmed_at, consumed_at, cancelled_at, required_signers FROM approvals WHERE id = ? AND user_id = ?', id, ws)
  if (!a) return null
  const signers = db.get<{ n: number }>('SELECT COUNT(*) n FROM approval_signatures WHERE approval_id = ?', id)?.n ?? 0
  return { id: a.id, purpose: a.purpose, subject: a.subject, docHash: a.doc_hash, method: a.method, askedAt: iso(a.created_at), expiresAt: iso(a.expires_at), confirmedAt: iso(a.confirmed_at), usedAt: iso(a.consumed_at), cancelledAt: iso(a.cancelled_at), signaturesRequired: a.required_signers, signaturesGiven: signers }
}
/** The person's passkey as registered: whether its make is attested. */
function attestation(db: Db, approvalId: string): { aaguid: string | null; attested: boolean } | null {
  const c = db.get<{ aaguid: string | null }>('SELECT w.aaguid FROM approval_signatures s JOIN webauthn_credentials w ON w.id = s.credential_id WHERE s.approval_id = ? LIMIT 1', approvalId)
  if (!c) return null
  return { aaguid: c.aaguid, attested: !!c.aaguid && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(c.aaguid) }
}
const SOFT_KEY = 'The passkey\'s make is not attested (its AAGUID is all zeros): a signature proves possession of the key, not which device or software held it.'

/** The workspace's receipt chain up to the case's last receipt: links and hashes for all, bodies only for the case's own. */
function receiptChain(db: Db, ws: string, own: string[]): Json {
  const server = verifyChain(db, ws)
  const maxSeq = own.length ? (db.get<{ m: number | null }>(`SELECT MAX(seq) m FROM receipts WHERE user_id = ? AND id IN (${own.map(() => '?').join(',')})`, ws, ...own)?.m ?? 0) : 0
  const entries: ChainEntry[] = db.all<Row>('SELECT id, seq, ts, kind, subject, body_json, prev_hash, hash FROM receipts WHERE user_id = ? AND seq <= ? ORDER BY seq', ws, maxSeq)
    .map((r) => ({ seq: Number(r.seq), id: String(r.id), kind: String(r.kind), subject: String(r.subject), ts: Number(r.ts), prevHash: String(r.prev_hash), hash: String(r.hash), ...(own.includes(String(r.id)) ? { body: parse<Json>(r.body_json, {}) } : {}) }))
  return { genesis: genesis(ws), server: { ok: server.ok, count: server.count, brokenAt: server.brokenAt, head: server.head, checkedAt: 'when the case was assembled' }, entries, note: 'Every receipt up to this case\'s last one: its number, its predecessor\'s hash and its own. Bodies are carried only for this case\'s receipts, so a verifier recomputes those and checks the links of the rest.' }
}

/** Ledger entries by their numbers, with every posting, and the balances they changed. */
function ledgerOf(db: Db, ws: string, seqs: number[]): { entries: LedgerEntryView[]; balances: BalanceEntry[] } {
  if (!seqs.length) return { entries: [], balances: [] }
  const rows = db.all<Row>(`SELECT id, seq, ref, kind, memo FROM entries WHERE user_id = ? AND seq IN (${seqs.map(() => '?').join(',')}) ORDER BY seq`, ws, ...seqs)
  const entries = rows.map((e) => ({ seq: Number(e.seq), ref: String(e.ref), kind: String(e.kind), memo: String(e.memo), lines: db.all<{ code: string; asset: string; amount: string }>('SELECT a.code, p.asset_id asset, p.amount_text amount FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = ? ORDER BY p.id', String(e.id)).map((l) => ({ account: l.code, asset: l.asset, amount: String(fromAmountText(l.amount, `a line of entry ${String(e.seq)}`)) })) }))
  const lo = Math.min(...seqs), hi = Math.max(...seqs)
  const accounts = [...new Set(entries.flatMap((e) => e.lines.map((l) => `${l.account}|${l.asset}`)))]
  const sumTo = (code: string, seq: number, inclusive: boolean): bigint => fromAmountText(db.get<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND a.code = ? AND e.seq ${inclusive ? '<=' : '<'} ?`, ws, code, seq)?.s, `the balance of ${code}`)
  const balances: BalanceEntry[] = accounts.map((k) => {
    const [account, asset] = k.split('|') as [string, string]
    const before = sumTo(account, lo, false), after = sumTo(account, hi, true)
    const scale = db.get<{ scale: number }>('SELECT scale FROM assets WHERE id = ?', asset)?.scale ?? 0
    return { account, asset, decimals: scale, before: String(before), after: String(after), delta: String(after - before), source: 'ledger' }
  })
  return { entries, balances }
}

// ------------------------------------------------------------------------------------------------ listing

export interface CaseSummary { id: string; kind: EvidenceCase['kind']; title: string; outcome: string; at: string | null; venue: EvidenceCase['venue']; model: { label: string; provider: string; model: string } | null; standingAuthority: boolean }

const runOutcome = (state: string): string => (state === 'done' ? 'executed' : state === 'partial' ? 'partly executed' : state === 'blocked' ? 'refused' : state === 'skipped' ? 'not run' : state)
const jobOutcome = (j: Json): string => (j.status === 'failed' ? 'failed' : String(obj(j.result).outcome ?? j.status))
/** As the case says it: a run of ticks that converted and was then refused is both. */
const listedOutcome = (j: Json): string => (jobOutcome(j) === 'executed' && arr<StepEntry>(j.steps).some((x) => x.status === 'refused' || x.status === 'reverted') ? 'executed, then refused' : jobOutcome(j))

export async function listCases(db: Db, workspaceId: string, vault: VaultSource | null): Promise<{ cases: CaseSummary[]; vault: { available: boolean; reason: string | null } }> {
  const cases: CaseSummary[] = []
  for (const r of db.all<Row>(`SELECT r.id, r.state, r.due_at, r.finished_at, p.title, p.origin FROM runs r JOIN programs p ON p.id = r.program_id
      WHERE r.user_id = ? AND r.state IN ('done', 'partial', 'blocked', 'failed', 'skipped', 'cancelled', 'expired') ORDER BY r.due_at DESC LIMIT 200`, workspaceId)) {
    const call = String(r.origin).startsWith('proposal:') ? db.get<{ provider: string; model: string }>('SELECT a.provider, a.model FROM proposals p JOIN ai_calls a ON a.id = p.ai_call_id WHERE p.id = ? AND p.user_id = ?', String(r.origin).slice(9), workspaceId) : undefined
    const fresh = db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE run_id = ? AND approval_id IS NOT NULL', String(r.id))?.n ?? 0
    cases.push({ id: `run.${String(r.id)}`, kind: 'standing-run', title: `${String(r.title)}: run ${runOutcome(String(r.state))}`, outcome: runOutcome(String(r.state)), at: iso(r.finished_at ?? r.due_at), venue: 'paper', model: call ? { label: modelLabel(call.provider, call.model).label, provider: call.provider, model: call.model } : null, standingAuthority: fresh === 0 })
  }
  for (const c of db.all<Row>('SELECT id, ts, provider, model, ok, question FROM ai_calls WHERE user_id = ? ORDER BY ts DESC LIMIT 100', workspaceId)) {
    const states = db.all<{ state: string }>('SELECT state FROM proposals WHERE ai_call_id = ? AND user_id = ?', String(c.id), workspaceId).map((p) => p.state)
    cases.push({ id: `ask.${String(c.id)}`, kind: 'model-call', title: `Model call: ${states.length} proposal${states.length === 1 ? '' : 's'}${states.length ? ` (${[...new Set(states)].join(', ')})` : ''}`, outcome: askOutcome(Number(c.ok) === 1, states), at: iso(c.ts), venue: 'none', model: { label: modelLabel(String(c.provider), String(c.model)).label, provider: String(c.provider), model: String(c.model) }, standingAuthority: false })
  }
  let reason: string | null = null
  if (vault && vaultOf(db, workspaceId)) {
    try {
      const [jobs, decisions] = await Promise.all([vault.read('jobs', { limit: '200' }), vault.read('decisions', { limit: '200' })])
      for (const j of arr(obj(jobs).jobs)) {
        // Which model call, if any, proposed the terms this job ran under (N-009): its own, or for a tick its policy's.
        const link = modelLink(db, workspaceId, [j.proposalId as string | null, STANDING_KINDS.has(String(j.kind)) ? policyProposalOf(db, workspaceId, String(j.id), arr<DecisionEntry>(obj(decisions).decisions)) : null])
        const model = link?.call ? { label: modelLabel(String(link.call.provider), String(link.call.model)).label, provider: String(link.call.provider), model: String(link.call.model) } : null
        cases.push({ id: `vault.${String(j.id)}`, kind: 'vault-job', title: String(obj(j.result).summary ?? `${String(j.kind)} ${String(j.status)}`).slice(0, 200), outcome: listedOutcome(j), at: String(j.finishedAt ?? j.createdAt), venue: String(j.kind) === 'attack' ? 'ephemeral-chain' : 'local-chain', model, standingAuthority: !j.proposalId })
      }
    } catch (e) { reason = e instanceof Error ? e.message : 'The vault service could not be read.' }
  } else reason = vault ? 'This household has no vault yet.' : 'The vault service is not configured.'
  cases.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return { cases, vault: { available: reason === null, reason } }
}
function askOutcome(ok: boolean, states: string[]): string {
  if (!ok) return 'failed'
  if (!states.length) return 'answered'
  return states.every((s) => s === 'invalid') ? 'invalid' : 'proposed'
}

// ------------------------------------------------------------------------------------------------ one case

export async function assembleCase(o: AssembleOptions, caseId: string): Promise<EvidenceCase> {
  const m = ID.exec(caseId)
  if (!m) throw notFound('That case')
  const [, kind, id] = m as unknown as [string, 'run' | 'ask' | 'vault', string]
  const c = kind === 'run' ? runCase(o, id) : kind === 'ask' ? await askCase(o, id) : await vaultCase(o, id)
  return sealCase(c)
}

function envelope(o: AssembleOptions, x: Pick<UnsealedCase, 'id' | 'kind' | 'title' | 'outcome' | 'venue'>): Pick<UnsealedCase, 'format' | 'id' | 'kind' | 'title' | 'outcome' | 'venue' | 'workspace' | 'assembledAt'> {
  return { format: CASE_FORMAT, ...x, workspace: o.workspaceId, assembledAt: new Date(o.now).toISOString() }
}
const titled = (n: keyof typeof SECTION_TITLES, body: Json): Json => ({ title: SECTION_TITLES[n], ...body })

/** Section 2 for a model call, from its ai_calls row: what was sent (as sent), what came back, what QED made of it. */
function modelSection(o: AssembleOptions, call: Row | undefined, selected: string | null): Json {
  if (!call) return titled(2, { ...modelLabel(null, null), statement: 'No model took part: the owner wrote this instruction.', information: [], constraints: [] })
  const who = modelLabel(String(call.provider), String(call.model))
  const sent = parse<{ history?: unknown; question?: string; data?: unknown }>(call.sent_json, {})
  const output = parse<Json>(call.output_json, {})
  const usage = parse<Json>(call.usage_json, {})
  const proposals = o.db.all<Row>('SELECT * FROM proposals WHERE ai_call_id = ? AND user_id = ? ORDER BY ts, rowid', String(call.id), o.workspaceId)
  const turn = o.db.get<Row>('SELECT id, grounding_json, cites_json, refusal FROM conversation_turns WHERE ai_call_id = ?', String(call.id))
  const outProposals = arr(output.proposals)
  const sel = selected ? proposals.findIndex((p) => p.id === selected) : -1
  const script = who.label === 'scripted-test-double' && o.ai?.aiScript ? (() => { try { return { file: o.ai!.aiScript!.split('/').slice(-2).join('/'), sha256NowOnDisk: sha256hex(readFileSync(o.ai!.aiScript!, 'utf8')), note: 'The file the double answers from, as it is when the case is assembled. QED does not record which file answered each call.' } } catch { return null } })() : null
  if (!readsAsk(o, call)) {
    return titled(2, {
      ...who,
      withheld: WITHHELD,
      call: { id: call.id, at: iso(call.ts), provider: call.provider, model: call.model, ok: Number(call.ok) === 1, conversationId: call.conversation_id ?? null },
      sent: { questionSha256: sha256hex(String(sent.question ?? '')), historyTurns: arr(sent.history).length, snapshotSha256: call.context_hash },
      output: { withheld: true, sha256: sha256hex(String(call.output_json ?? '')) },
      ...(sel >= 0 ? { selected: { proposalId: proposals[sel]!.id } } : {}),
      // what QED made of the reply, as states only: a title is the model's words and a warning can quote the owner's
      validation: proposals.map((p) => { const an = parse<Json>(p.analysis_json, {}); return { proposalId: p.id, kind: p.kind, state: p.state, tier: an.tier ?? null, refusals: arr(an.refusals).length } }),
    })
  }
  return titled(2, {
    ...who,
    call: { id: call.id, at: iso(call.ts), provider: call.provider, model: call.model, ok: Number(call.ok) === 1, error: call.error ?? null, latencyMs: call.latency_ms ?? null, usage: { ...usage, ...(usage.responseId ? { responseId: fingerprint(String(usage.responseId)) } : {}) }, conversationId: call.conversation_id ?? null, turnId: turn?.id ?? null },
    sent: { question: sent.question ?? null, history: sent.history ?? [], ...(sent.data !== undefined ? { data: sent.data } : {}), snapshotSha256: call.context_hash, note: sent.data !== undefined ? 'As sent, with payee names and addresses replaced by tokens (N-005): the snapshot of the recorded position (DATA), the earlier turns and the question. The context hash is the SHA-256 of DATA exactly as sent, which a verifier recomputes.' : 'As sent: payee names and addresses replaced by tokens (N-005). Besides these, the model received a snapshot of the recorded position (DATA); for this call QED stored only its SHA-256.' },
    output: Object.keys(output).length ? output : null,
    ...(sel >= 0 ? { selected: { proposalId: proposals[sel]!.id, ...obj(outProposals[sel]) , note: 'The proposal this case follows, exactly as the model returned it (in tokens).' } } : {}),
    ...(script ? { scriptedReplies: script } : {}),
    information: ['DATA: a snapshot of the household\'s recorded position, prices with their age, the catalogue of instruction kinds and the payees as tokens (stored as its SHA-256 only).', 'HISTORY: the earlier turns of the conversation, as sent.', 'QUESTION: the owner\'s words, as sent.'],
    constraints: ['It holds no credential, calls no tool and executes nothing (server/ai.ts).', 'Its reply must match a fixed schema: at most four proposals of eight instruction kinds, each with typed parameters and limits.', 'Everything in DATA, HISTORY and QUESTION is information, not instruction.', 'Each proposal is parsed and checked by the code that checks an instruction typed by hand; one that fails is kept as invalid and can never be signed.', 'A valid proposal is only a draft until the owner signs its exact document with a passkey.'],
    validation: proposals.map((p) => { const an = parse<Json>(p.analysis_json, {}); return { proposalId: p.id, kind: p.kind, title: p.title, state: p.state, invalidReason: p.invalid_reason ?? null, tier: an.tier ?? null, warnings: arr(an.warnings), refusals: arr(an.refusals), ceilingPaise: an.ceilingPaise ?? null, ownerFigures: arr(an.ownerFigures) } }),
    grounding: turn ? { ...parse<Json>(turn.grounding_json, {}), cites: parse<unknown[]>(turn.cites_json, []), refusal: turn.refusal ?? null } : null,
  })
}

// ---- run.<id>: a run of a standing instruction on the paper engine

function runCase(o: AssembleOptions, runId: string): UnsealedCase {
  const { db, workspaceId: ws } = o
  const run = db.get<Row>('SELECT * FROM runs WHERE id = ? AND user_id = ?', runId, ws)
  if (!run) throw notFound('That case')
  const prog = db.get<Row>('SELECT * FROM programs WHERE id = ? AND user_id = ?', String(run.program_id), ws)!
  const ver = db.get<Row>('SELECT * FROM program_versions WHERE program_id = ? AND version = ?', String(prog.id), Number(run.version))!
  const authority = parse<Json>(ver.authority_json, {}), params = parse<Json>(ver.params_json, {}), doc = parse<Json>(ver.document, {})
  const approval = approvalView(db, ws, ver.approval_id as string | null)
  const rpId = o.rpId ?? 'localhost'
  const proposalId = String(prog.origin).startsWith('proposal:') ? String(prog.origin).slice(9) : null
  const proposal = proposalId ? db.get<Row>('SELECT * FROM proposals WHERE id = ? AND user_id = ?', proposalId, ws) : undefined
  const call = proposal?.ai_call_id ? db.get<Row>('SELECT * FROM ai_calls WHERE id = ? AND user_id = ?', String(proposal.ai_call_id), ws) : undefined
  const actions = db.all<Row>('SELECT * FROM actions WHERE run_id = ? AND user_id = ? ORDER BY created_at', runId, ws).map(actionFromRow)
  const receipts = actions.map((a) => a.receipt_id).filter((x): x is string => !!x)
  const bodies = new Map(receipts.map((id) => [id, parse<Json>(db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ? AND user_id = ?', id, ws)?.body_json, {})]))
  const runApprovals = db.all<{ id: string; document: string }>(`SELECT id, document FROM approvals WHERE user_id = ? AND subject = ? AND confirmed_at IS NOT NULL`, ws, `run:${runId}`)
  const outcome = runOutcome(String(run.state))
  const att = approval ? attestation(db, String(approval.id)) : null
  const who = modelLabel(call ? String(call.provider) : null, call ? String(call.model) : null)

  // 3: every check the engine made, as recorded on the action and in its receipt
  const checks: CheckEntry[] = actions.flatMap((a) => (a.policy.checks ?? []).map((x) => ({ by: 'engine (server/policy.ts decide)', name: x.name, pass: x.ok, detail: x.detail, ...(x.transient ? { transient: true } : {}), ...(a.receipt_id ? { source: { receipt: a.receipt_id } } : {}) })))
  if (String(run.state) === 'skipped' || String(run.state) === 'cancelled' || String(run.state) === 'expired') checks.push({ by: 'engine (server/runner.ts)', name: `run-${String(run.state)}`, pass: false, detail: String(run.reason ?? '') })
  for (const a of actions) {
    const b = bodies.get(a.receipt_id ?? '') as { reconciliation?: { state?: string; breaks?: string[] }; venue?: { state?: string; rejectReason?: string | null } } | undefined
    if (a.state !== 'blocked' && b?.venue && (b.venue.state === 'rejected' || b.venue.rejectReason)) checks.push({ by: 'paper venue', name: 'venue-accepted', pass: false, detail: String(b.venue.rejectReason ?? b.venue.state) })
  }
  const failing = checks.filter((x) => !x.pass)

  // 5: what moved, by the ledger's own entries
  const seqs = [...bodies.values()].flatMap((b) => arr<number>(b.ledgerEntries))
  const ledger = ledgerOf(db, ws, seqs)
  const moved: MovedEntry[] = actions.flatMap((a) => {
    const b = bodies.get(a.receipt_id ?? '') as { costs?: { filledAmount?: string; fee?: string; tax?: string; deliveredQty?: string }; instrument?: { id: string; name?: string; unit: string; scale: number } } | undefined
    if (!b?.costs) return []
    const fills = ledger.entries.filter((e) => arr<number>((b as { ledgerEntries?: unknown }).ledgerEntries).includes(e.seq) && e.ref.startsWith('fill:')).map((e) => e.seq)
    const paid = BigInt(b.costs.filledAmount ?? '0') + BigInt(b.costs.fee ?? '0')
    return [
      { what: `paid for ${String(b.instrument?.name ?? b.instrument?.id ?? 'the order')}, fee included`, asset: 'INR', decimals: 2, amount: String(paid), from: 'bank', text: rupees(paid), ...(fills.length ? { evidence: { entries: fills } } : {}) },
      { what: `delivered ${String(b.instrument?.unit ?? '')}`, asset: String(b.instrument?.unit ?? ''), decimals: Number(b.instrument?.scale ?? 0), amount: String(b.costs.deliveredQty ?? '0'), to: `pos:${String(b.instrument?.id ?? '')}`, text: units(b.costs.deliveredQty ?? '0', Number(b.instrument?.scale ?? 0), String(b.instrument?.unit ?? '')), ...(fills.length ? { evidence: { entries: fills } } : {}) },
    ]
  })
  const firstCosts = (bodies.get(receipts[0] ?? '') as { costs?: Json } | undefined)?.costs ?? null
  const synthetic = [...bodies.values()].some((b) => JSON.stringify(b).includes('"synthetic"'))

  // 1: the owner's objective and the signed instruction
  const instrument: AuthorityInstrument & Json = {
    kind: 'standing-instruction', id: `${String(prog.id)}@v${String(ver.version)}`, title: prog.title, signedAt: iso(ver.approved_at), venue: actions[0]?.venue ?? null, state: prog.state,
    limits: [
      { name: 'maxPerRun', value: authority.maxPerRun, text: `${rupees(authority.maxPerRun)} a run` },
      { name: 'maxPerDay', value: authority.maxPerDay ?? null, text: authority.maxPerDay === null ? 'no separate daily limit' : `${rupees(authority.maxPerDay)} a day` },
      { name: 'maxPerMonth', value: authority.maxPerMonth, text: `${rupees(authority.maxPerMonth)} a month` },
      { name: 'maxRuns', value: authority.maxRuns ?? null, text: authority.maxRuns === null ? 'no limit on the number of runs' : `${String(authority.maxRuns)} runs in all` },
      { name: 'maxSlippageBps', value: authority.maxSlippageBps, text: `at most ${Number(authority.maxSlippageBps) / 100}% from the best quote` },
      { name: 'runMode', value: authority.runMode, text: authority.runMode === 'auto' ? 'runs on its own, without asking' : authority.runMode === 'approve' ? 'asks before every run' : 'tells the owner first and runs unless they object' },
    ],
    expiresAt: iso(authority.expiresAt), params,
    document: { text: String(ver.document), sha256: String(ver.content_hash) },
    documentAsSigned: { may: doc.may ?? null, limits: doc.limits ?? null, ceiling: doc.ceiling ?? null, conditions: doc.conditions ?? null, never: doc.never ?? null, mode: doc.mode ?? null, ends: doc.ends ?? null, accepted: doc.accepted ?? null, drafted: doc.drafted ?? null, prepared: doc.prepared ?? null },
    approval: approval ? { ...approval, id: String(approval.id), docHash: String(approval.docHash) } : null,
    signatures: approval ? signaturesOf(db, String(approval.id), String(approval.docHash), rpId) : [],
    ...(typeof doc.drafted === 'string' && /^A model \(/.test(doc.drafted) && !who.isModel && call ? { noteOnDisclosure: `The signed document says: "${String(doc.drafted)}" The call was recorded as provider "${String(call.provider)}", model "${String(call.model)}": ${who.statement}` } : {}),
  }

  // 7: the other runs of the same instruction, and the engine's own checks on a changed input now
  const siblings = db.all<Row>('SELECT id, occurrence, state, reason, due_at FROM runs WHERE program_id = ? AND user_id = ? AND id <> ? ORDER BY due_at', String(prog.id), ws, runId).map((r) => {
    const fails = db.all<{ policy_json: string }>('SELECT policy_json FROM actions WHERE run_id = ?', String(r.id)).flatMap((a) => arr<{ name: string; ok: boolean }>(parse<Json>(a.policy_json, {}).checks).filter((x) => !x.ok).map((x) => x.name))
    return { caseId: `run.${String(r.id)}`, changed: `the run due ${iso(r.due_at)} (occurrence ${String(r.occurrence)}), with the usage and balances of its own time`, decision: runOutcome(String(r.state)), failed: fails, reason: r.reason ?? null }
  })
  const probes = o.ctx && actions[0] ? paperProbes(o, actions[0], authority) : []

  // 8: refusals under the same instruction
  const related = db.all<Row>(`SELECT a.id, a.run_id, a.state, a.error, a.policy_json, a.receipt_id, a.created_at FROM actions a WHERE a.program_id = ? AND a.user_id = ? AND a.state = 'blocked' AND a.run_id <> ? ORDER BY a.created_at`, String(prog.id), ws, runId).map((a) => ({
    caseId: `run.${String(a.run_id)}`, at: iso(a.created_at), what: 'an action of the same instruction', failed: arr<{ name: string; ok: boolean; detail: string }>(parse<Json>(a.policy_json, {}).checks).filter((x) => !x.ok).map((x) => ({ name: x.name, detail: x.detail })), executed: false, proof: `the action stopped before submission (state blocked); receipt ${String(a.receipt_id ?? 'none')}` }))

  const sections = {
    1: titled(1, {
      objective: call ? objectiveOf(o, call) : { text: prog.title, source: 'the instruction the owner wrote', at: iso(prog.created_at) },
      instruments: [instrument],
    }),
    2: modelSection(o, call, proposalId),
    3: titled(3, {
      decision: failing.length ? 'refused' : actions.length ? 'allowed' : 'not-applicable',
      statement: 'Every action passes the engine\'s checks immediately before it is sent to a venue. They read only recorded state: the signed authority, the ledger, prices and their age. No model output is an input.',
      checks, run: { id: run.id, occurrence: run.occurrence, state: run.state, reason: run.reason ?? null, planned: parse<Json>(run.decision_json, {}).summary ?? [] },
      reconciliation: actions.map((a) => ({ action: a.id, state: a.recon_state, breaks: arr((bodies.get(a.receipt_id ?? '') as { reconciliation?: { breaks?: unknown } } | undefined)?.reconciliation?.breaks) })),
    }),
    4: titled(4, {
      freshOwnerSignature: actions.some((a) => !!a.approval_id) || runApprovals.length > 0,
      ranUnder: [{ kind: 'standing-instruction', id: instrument.id, signedAt: instrument.signedAt, approvalId: approval?.id ?? null, runMode: authority.runMode }],
      requestedBy: { who: 'the engine\'s scheduler', evidence: `run ${String(run.id)} claimed for occurrence ${String(run.occurrence)} at ${String(iso(run.created_at))}, due ${String(iso(run.due_at))}; started ${String(iso(run.started_at))}`, at: iso(run.created_at) },
      signaturesUsed: [{ approvalId: approval?.id ?? null, when: approval?.confirmedAt ?? null, what: 'the instruction\'s exact document, once, before any run' }, ...runApprovals.map((a) => ({ approvalId: a.id, when: approvalView(db, ws, a.id)?.confirmedAt ?? null, what: 'this run', ...(preparedIn(a.document).length ? { prepared: preparedIn(a.document) } : {}) }))],
      statement: authority.runMode === 'auto' ? 'The engine ran this under the instruction the owner signed earlier. No one signed anything for this run.' : authority.runMode === 'approve' ? 'This instruction asks before every run: the run needed its own approval.' : 'This instruction tells the owner first and runs unless they object in time.',
      neededASignature: authority.runMode === 'approve' ? ['each run'] : ['the instruction itself, and any change to it', 'raising a limit or extending its end'],
    }),
    5: titled(5, {
      executed: actions.some((a) => a.state === 'done' || a.state === 'partial'),
      moved, balances: ledger.balances, entries: ledger.entries, costs: firstCosts,
      receipts: receipts.map((id) => ({ id, hash: db.get<{ hash: string; seq: number }>('SELECT hash FROM receipts WHERE id = ?', id)?.hash ?? null, seq: db.get<{ seq: number }>('SELECT seq FROM receipts WHERE id = ?', id)?.seq ?? null })),
      consequence: actions.map((a) => `${a.state === 'done' ? 'Done' : a.state === 'blocked' ? 'Refused before anything was sent' : a.state}: ${a.error ?? (bodies.get(a.receipt_id ?? '') as { what?: string } | undefined)?.what ?? ''}`).join(' '),
      units: 'Amounts are integers in the asset\'s smallest unit (paise for INR). Ledger balances are the sum of postings, debit positive.',
    }),
    6: titled(6, {
      revision: revision(), venue: { kind: 'paper', names: [...new Set(actions.map((a) => a.venue))], note: 'A paper venue run by this installation, with its own books: no order reached an exchange.' },
      transactions: [] as TxEntry[],
      ids: { run: run.id, program: prog.id, version: ver.version, contentHash: ver.content_hash, approval: approval?.id ?? null, proposal: proposalId, aiCall: call?.id ?? null, actions: actions.map((a) => ({ id: a.id, economicId: a.economic_id, venue: a.venue })), receipts },
      times: actions.map((a) => ({ action: a.id, asked: iso(a.created_at), ...Object.fromEntries(Object.entries(a.times).map(([k, v]) => [k, iso(v)])) })),
      prices: synthetic ? 'synthetic (presentation mode): generated on this computer; no market provider was contacted' : 'as recorded in each fill\'s evidence',
    }),
    7: titled(7, { recorded: siblings, probes, note: 'Recorded: other runs of the same signed instruction. Probes: the engine\'s own checks (server/policy.ts decide) run now on a changed copy of this action, without storing or sending anything.' }),
    8: titled(8, { thisCase: failing.map((x) => ({ check: x.name, by: x.by, detail: x.detail })), related }),
  }
  const cannotProve = [
    ...(who.label === 'scripted-test-double' || who.label === 'test-double' ? ['The proposal came from a scripted test double, not a model. This case shows what QED\'s controls did with it; it is no evidence of how a model would choose, nor of model-directed autonomy.'] : who.isModel ? ['One call of one model: it does not show how the model behaves on other inputs.'] : []),
    ...(call && !keptSnapshot(call) ? [NO_SNAPSHOT] : []),
    'Execution was on a paper venue run by this installation: no order reached an exchange and no money moved.',
    ...(synthetic ? ['Prices were synthetic (presentation mode), generated on this computer: not market prices.'] : []),
    ...(att && !att.attested ? [SOFT_KEY] : []),
    ...(probes.length ? ['Probes are evaluated when the case is assembled, against the records then; they are not records of past decisions.'] : []),
    FORGERY, NO_REVIEW,
  ]
  return {
    ...envelope(o, { id: `run.${runId}`, kind: 'standing-run', title: `${String(prog.title)}: run ${outcome}`, outcome, venue: 'paper' }),
    sections: sections as unknown as UnsealedCase['sections'],
    verification: { receiptChain: receiptChain(db, ws, receipts), ledger: { breaks: verifyLedger(db, ws), checkedAt: 'when the case was assembled', note: 'server/ledger.ts verifyLedger over the whole workspace: entries balance, cached balances equal their postings, nothing negative that may not be.' } },
    redactions: [...ALWAYS_REDACTED, { what: 'Bodies of receipts of other actions', how: 'withheld; their numbers, links and hashes are kept', why: 'The chain stays checkable without disclosing the household\'s other activity.' }, ...(call ? modelRedactions(call) : [])],
    cannotProve,
  }
}
/** Whether the model call kept the snapshot it was sent (calls since N-009 do). */
const keptSnapshot = (call: Row | undefined): boolean => !!call && parse<{ data?: unknown }>(call.sent_json, {}).data !== undefined
const NO_SNAPSHOT = 'The snapshot the model was sent is not stored for this call, only its SHA-256: what it contained cannot be shown from the records.'
const modelRedactions = (call: Row | undefined) => keptSnapshot(call) ? MODEL_REDACTIONS.slice(1) : MODEL_REDACTIONS
const MODEL_REDACTIONS = [
  { what: 'The snapshot of the position sent to the model', how: 'never stored by QED for this call; its SHA-256 is', why: 'Calls made before 22 November 2026 (N-009) kept only the fingerprint.' },
  { what: 'Payee names and addresses in what the model was sent', how: 'replaced by tokens before sending (N-005); shown as sent', why: 'The model never sees who is paid.' },
  { what: 'The model provider\'s response or session id', how: 'replaced by "sha256:" and 16 hex digits of its SHA-256', why: 'It identifies a session with the provider and is not needed to judge the decision.' },
]

/** The engine's checks on changed copies of an action, now: what the same code would decide. Nothing is stored or sent. */
function paperProbes(o: AssembleOptions, a: ReturnType<typeof actionFromRow>, authority: Json): Json[] {
  const out: Json[] = []
  const at = o.now
  const ask = (question: string, change: Json, params: Json): void => {
    try {
      const d = decide(o.ctx!, { ...a, id: `probe-${a.id}`, economic_id: `probe-${a.economic_id}`, state: 'planned', created_at: at, params: params as never }, at)
      out.push({ question, input: change, answer: { allowed: d.allowed, failed: d.checks.filter((x) => !x.ok).map((x) => ({ name: x.name, detail: x.detail })) }, by: 'server/policy.ts decide, the check every action passes before it is sent', evaluatedAt: iso(at) })
    } catch (e) { out.push({ question, input: change, answer: { error: e instanceof Error ? e.message : String(e) }, evaluatedAt: iso(at) }) }
  }
  const p = a.params as unknown as Json
  ask('The same action, now?', {}, p)
  if (typeof p.amount === 'string' && typeof authority.maxPerRun === 'number') ask(`The same action for ₹1 more than the signed limit of ${rupees(authority.maxPerRun)} a run?`, { amount: String(authority.maxPerRun + 100) }, { ...p, amount: String(authority.maxPerRun + 100) })
  return out
}

// ---- ask.<id>: one model call

async function askCase(o: AssembleOptions, callId: string): Promise<UnsealedCase> {
  const { db, workspaceId: ws } = o
  const call = db.get<Row>('SELECT * FROM ai_calls WHERE id = ? AND user_id = ?', callId, ws)
  if (!call) throw notFound('That case')
  const who = modelLabel(String(call.provider), String(call.model))
  const proposals = db.all<Row>('SELECT * FROM proposals WHERE ai_call_id = ? AND user_id = ? ORDER BY ts, rowid', callId, ws)
  const programs = proposals.map((p) => ({ proposalId: String(p.id), program: db.get<Row>('SELECT id, state, live_version, title FROM programs WHERE origin = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1', `proposal:${String(p.id)}`, ws) ?? null }))
  const states = proposals.map((p) => String(p.state))
  const outcome = askOutcome(Number(call.ok) === 1, states)
  // A proposal's title and a refusal's reason are the model's words about the asker's question: a reader who may not read
  // the question (RISK-070) reads the proposal's id and a SHA-256 instead, in every section (R13 review, lead L-05).
  const open = readsAsk(o, call)
  const titleOf = (p: Row): string => (open ? String(p.title) : `proposal ${String(p.id)}`)
  const words = (text: unknown): string => (open ? String(text ?? '') : `withheld (sha256 ${sha256hex(String(text ?? ''))}): ${WITHHELD}`)
  const paperCheck = (p: Row): CheckEntry => ({ by: 'validation (server/ai.ts storeProposal, then server/programs.ts buildDraft)', name: `proposal-valid: ${titleOf(p)}`, pass: p.state !== 'invalid', detail: p.state === 'invalid' ? words(p.invalid_reason) : `Valid as a draft: ${open ? String(parse<Json>(p.analysis_json, {}).headline ?? p.kind) : String(p.kind)}` })
  const wallet = (p: Row): { checks: { name: string; pass: boolean; detail: string }[]; drafts: Json[] } | null => { const w = obj(parse<Json>(p.analysis_json, {}).wallet); return String(p.kind).startsWith('wallet-') ? { checks: arr(w.checks) as never, drafts: arr(w.drafts) } : null }
  const checks: CheckEntry[] = proposals.flatMap((p): CheckEntry[] => {
    const w = wallet(p)
    if (!w) return [paperCheck(p)]
    return [
      ...w.checks.map((c) => ({ by: 'validation (server/ai.ts checkWallet, on the vault service\'s own figures)', name: `${titleOf(p)}: ${c.name}`, pass: c.pass, detail: c.detail })),
      ...w.drafts.filter((d) => d.ok === false).map((d) => ({ by: `when the owner asked for the terms: ${String(d.by ?? 'QED')}`, name: `${titleOf(p)}: terms prepared`, pass: false, detail: words(d.reason) })),
    ]
  })
  if (Number(call.ok) !== 1) checks.push({ by: 'model boundary (server/ai.ts)', name: 'model-answered', pass: false, detail: String(call.error ?? 'no reply') })
  const failing = checks.filter((x) => !x.pass)
  const signed = programs.filter((x) => x.program && x.program.live_version !== null)
  // Each wallet proposal's drafts: the vault terms made from it, and the job they became when the owner signed and sent them.
  const onChain: Json[] = []
  for (const p of proposals) {
    const w = wallet(p)
    if (!w) continue
    const drafts: Json[] = []
    for (const d of w.drafts) {
      const vp = d.ok === true && o.vault && typeof d.vaultProposalId === 'string' ? await o.vault.item('proposals', d.vaultProposalId).catch(() => null) : null
      drafts.push({ at: iso(d.at), ok: d.ok === true, ...(d.ok === true ? { vaultProposal: d.vaultProposalId, approval: d.approvalId, termsHash: d.termsHash, vaultStatus: vp?.status ?? null, jobCase: vp?.jobId ? `vault.${String(vp.jobId)}` : null } : { refusedBy: d.by ?? null, reason: d.reason == null ? null : words(d.reason) }) })
    }
    onChain.push({ proposalId: p.id, kind: p.kind, state: p.state, drafts })
  }
  const sentOnChain = onChain.flatMap((x) => arr(x.drafts)).filter((d) => d.jobCase)
  const siblings = db.all<Row>('SELECT id, ts, question, ok FROM ai_calls WHERE user_id = ? AND id <> ? ORDER BY ts DESC LIMIT 10', ws, callId).map((c) => {
    const s = db.all<{ state: string }>('SELECT state FROM proposals WHERE ai_call_id = ?', String(c.id)).map((x) => x.state)
    return { caseId: `ask.${String(c.id)}`, changed: 'a different question', decision: askOutcome(Number(c.ok) === 1, s), proposals: s }
  })
  // other questions' refused proposals: their words only where this reader may read that question too (lead L-05)
  const readsCall = (aiCallId: unknown): boolean => { const c = aiCallId ? db.get<Row>('SELECT conversation_id FROM ai_calls WHERE id = ? AND user_id = ?', String(aiCallId), ws) : undefined; return !c || readsAsk(o, c) }
  const related = db.all<Row>(`SELECT id, ai_call_id, title, invalid_reason, ts FROM proposals WHERE user_id = ? AND state = 'invalid' AND (ai_call_id IS NULL OR ai_call_id <> ?) ORDER BY ts DESC LIMIT 20`, ws, callId)
    .map((p) => (readsCall(p.ai_call_id) ? p : { ...p, title: `proposal ${String(p.id)}`, invalid_reason: `withheld (sha256 ${sha256hex(String(p.invalid_reason ?? ''))}): ${WITHHELD}` }))
    .map((p) => ({ caseId: p.ai_call_id ? `ask.${String(p.ai_call_id)}` : null, at: iso(p.ts), what: String(p.title), failed: [{ name: 'proposal-valid', detail: String(p.invalid_reason) }], executed: false, proof: 'an invalid proposal can never be drafted or signed' }))
  const sections = {
    1: titled(1, { objective: objectiveOf(o, call), instruments: [], statement: 'A model call grants no authority. A proposal becomes an instruction only when the owner signs its exact document with a passkey.' }),
    2: modelSection(o, call, null),
    3: titled(3, { decision: failing.length && failing.length === checks.length ? 'refused' : 'checked', statement: 'Every proposal is parsed and analysed by the same code that checks an instruction typed by hand.', checks }),
    4: titled(4, {
      freshOwnerSignature: signed.length > 0 || sentOnChain.length > 0, ranUnder: [], requestedBy: { who: 'the owner, asking a question', evidence: `ai call ${callId}`, at: iso(call.ts) }, signaturesUsed: [],
      statement: signed.length || sentOnChain.length ? `${signed.length + sentOnChain.length} of these proposals became an instruction or vault terms, each only after the owner signed it with the passkey.${sentOnChain.length ? ` On the chain: ${sentOnChain.map((d) => String(d.jobCase)).join(', ')}.` : ''}` : 'Nothing ran from this call: no proposal was signed.',
      wallet: onChain,
      proposals: programs.map((x) => ({ proposalId: x.proposalId, program: x.program ? { id: x.program.id, state: x.program.state, signed: x.program.live_version !== null } : null, neededASignature: 'yes: the owner\'s passkey over its exact document' })),
    }),
    5: titled(5, { executed: false, moved: [], balances: [], entries: [], consequence: signed.length ? 'This call moved nothing itself. What ran later, under the signed instruction, is in that instruction\'s run cases.' : 'Nothing moved: no proposal of this call was signed.' }),
    6: titled(6, { revision: revision(), venue: { kind: 'none' }, transactions: [], ids: { aiCall: callId, conversation: call.conversation_id ?? null, proposals: proposals.map((p) => p.id), programs: programs.filter((x) => x.program).map((x) => x.program!.id) } }),
    7: titled(7, { recorded: siblings, probes: [], note: 'Other model calls of this workspace: a different question, and what QED made of the answer.' }),
    8: titled(8, { thisCase: failing.map((x) => ({ check: x.name, by: x.by, detail: x.detail })), related }),
  }
  return {
    ...envelope(o, { id: `ask.${callId}`, kind: 'model-call', title: `Model call: ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} (${[...new Set(states)].join(', ') || 'none'})`, outcome, venue: 'none' }),
    sections: sections as unknown as UnsealedCase['sections'],
    verification: { receiptChain: receiptChain(db, ws, []), ledger: { breaks: verifyLedger(db, ws), checkedAt: 'when the case was assembled' }, note: 'A model call writes no receipt. The workspace\'s receipt chain and ledger as a whole were verified when the case was assembled.' },
    redactions: [...ALWAYS_REDACTED, ...modelRedactions(call)],
    cannotProve: [
      ...(who.isModel ? ['One call of one model: it does not show how the model behaves on other inputs.'] : ['The answer came from a scripted test double, not a model. If it follows an instruction hidden in the question, that is because it was scripted to, as a compromised model might: the case shows what QED\'s own code did with such a proposal, and nothing about how a real model would answer.']),
      ...(keptSnapshot(call) ? [] : [NO_SNAPSHOT]),
      FORGERY, NO_REVIEW,
    ],
  }
}

// ---- vault.<id>: one job of the household's on-chain vault

const STANDING_KINDS = new Set(['policy-tick', 'policy-run'])
/**
 * The model proposal, if any, whose drafted vault terms are one of these vault proposals (N-009): kept on the proposal
 * by server/ai.ts draftWalletProposal. With its model call, and the draft that made the terms.
 */
export function modelLink(db: Db, ws: string, vaultProposalIds: (string | null | undefined)[]): { proposal: Row; call: Row | undefined; draft: Json } | null {
  for (const id of vaultProposalIds.filter((x): x is string => !!x && /^[A-Za-z0-9-]{8,80}$/.test(x))) {
    for (const p of db.all<Row>(`SELECT * FROM proposals WHERE user_id = ? AND kind LIKE 'wallet-%' AND analysis_json LIKE ?`, ws, `%${id}%`)) {
      const d = arr(obj(parse<Json>(p.analysis_json, {}).wallet).drafts).find((x) => x.vaultProposalId === id && x.ok === true)
      if (d) return { proposal: p, call: p.ai_call_id ? db.get<Row>('SELECT * FROM ai_calls WHERE id = ? AND user_id = ?', String(p.ai_call_id), ws) : undefined, draft: d }
    }
  }
  return null
}
/** For a tick: the vault proposal of the standing policy it ran under, through the vault's own decision records. */
function policyProposalOf(db: Db, ws: string, jobId: string, decisions: DecisionEntry[]): string | null {
  const nonce = obj(decisions.find((d) => d.kind === 'policy-decision' && d.jobId === jobId)?.record).policyNonce
  const signed = decisions.find((d) => d.kind === 'owner-policy' && obj(obj(d.record).policy).nonce === nonce)
  const approvalId = obj(signed?.approval).approvalId
  const subject = typeof approvalId === 'string' ? db.get<{ subject: string }>('SELECT subject FROM approvals WHERE id = ? AND user_id = ?', approvalId, ws)?.subject : undefined
  return subject?.startsWith('rail:') ? subject.slice(5) : null
}
const MANDATE_KINDS = new Set(['policy-tick', 'policy-run', 'convert', 'pay', 'policy'])
const POLICY_KINDS = new Set(['policy-tick', 'policy-run', 'policy-revoke'])

async function vaultCase(o: AssembleOptions, jobId: string): Promise<UnsealedCase> {
  const { db, workspaceId: ws } = o
  if (!o.vault || !vaultOf(db, ws)) throw notFound('That case')
  const V = o.vault
  let job: Json
  try { job = await V.item('jobs', jobId) } catch (e) { if ((e as { status?: number }).status === 404) throw notFound('That case'); throw e }
  const [overview, decisionsAll, mandatesR, policyR, jobsR, verify] = await Promise.all([
    // 200 is the most the wallet's rail client asks for (server/rail.ts limitOf); a larger figure would be dropped.
    V.overview(), V.read('decisions', { limit: '200' }), V.read('mandates'), V.read('policy', { limit: '200' }), V.read('jobs', { limit: '200' }), V.read('decisions-verify'),
  ])
  const state = obj(overview.state), workspace = obj(overview.workspace), health = obj(overview.health)
  const asset = obj(workspace.asset), reserveAsset = obj(workspace.reserveAsset)
  const A = { symbol: String(asset.symbol ?? 'tINR'), decimals: Number(asset.decimals ?? 2), address: String(asset.address ?? '') }
  const R = { symbol: String(reserveAsset.symbol ?? 'tUSD'), decimals: Number(reserveAsset.decimals ?? 6), address: String(reserveAsset.address ?? '') }
  const kind = String(job.kind)
  const result = obj(job.result)
  const steps = arr<StepEntry>(job.steps)
  const jobDecisions = arr<DecisionEntry>(obj(await V.read('decisions', { jobId })).decisions)
  const all = arr<DecisionEntry>(decisionsAll.decisions)
  const proposal = job.proposalId ? await V.item('proposals', String(job.proposalId)).catch(() => null) : null
  const rpId = o.rpId ?? 'localhost'
  const createdAt = Date.parse(String(job.createdAt))

  // Which mandate and policy were in force when the job was accepted: the latest signed before it.
  const mandates = arr(mandatesR.mandates).filter((m) => Date.parse(String(m.signedAt)) <= createdAt).sort((a, b) => Number(b.version) - Number(a.version))
  const mandate = mandates[0] ?? null
  const ticks = arr(policyR.ticks)
  const tick = ticks.find((t) => t.jobId === jobId) ?? null
  const policySigned = all.filter((d) => d.kind === 'owner-policy' && Date.parse(d.at) <= createdAt).sort((a, b) => b.n - a.n)[0] ?? null
  const policyNow = obj(policyR.policy)

  // 1: the bounded authority, each piece with the document the owner's passkey signed for it
  const instruments: (AuthorityInstrument & Json)[] = []
  const signedVia = async (approvalId: string | null | undefined, decisionKind: string): Promise<Json> => {
    const d = all.find((x) => x.kind === decisionKind && (obj(x.approval).approvalId === approvalId)) ?? null
    const a = approvalId ? db.get<Row>('SELECT id, subject, document, doc_hash FROM approvals WHERE id = ? AND user_id = ?', approvalId, ws) : undefined
    const pid = a ? String(a.subject).replace(/^rail:/, '') : null
    const p = pid ? await V.item('proposals', pid).catch(() => null) : null
    return { decision: d, approval: a, proposal: p }
  }
  // The mandate governs conversions, payments and ticks; the standing policy governs ticks. Owner-signed actions such as
  // a withdrawal or a Security Lab run rest on their own approval only.
  if (mandate && MANDATE_KINDS.has(kind)) {
    const s = await signedVia(String(mandate.approvalId ?? ''), 'owner-mandate')
    const f = obj(mandate.fields)
    instruments.push({
      kind: 'mandate', id: `mandate v${String(mandate.version)} ${String(mandate.hash).slice(0, 12)}…`, hash: mandate.hash, status: mandate.status, signedAt: mandate.signedAt, purpose: mandate.purposeText,
      limits: [
        { name: 'maxPerPayment', value: f.maxPerPayment, text: `${units(f.maxPerPayment, A.decimals, A.symbol)} a conversion or payment` },
        { name: 'maxPerPeriod', value: f.maxPerPeriod, text: `${units(f.maxPerPeriod, A.decimals, A.symbol)} in each ${Number(f.period) / 3600} h window` },
        { name: 'maxTotal', value: f.maxTotal, text: `${units(f.maxTotal, A.decimals, A.symbol)} in all` },
        { name: 'requireCosign', value: f.requireCosign, text: f.requireCosign ? 'every payment needs the independent co-signer' : 'no co-signer required' },
      ],
      payees: arr<string>(f.payees).map((x, i) => ({ address: x, label: arr<string>(mandate.payeeLabels)[i] ?? null })),
      validFrom: iso(Number(f.validFrom) * 1000), expiresAt: iso(Number(f.validUntil) * 1000), fields: f,
      ...authorityProof(db, s, rpId),
    })
  }
  let policyProposalId: string | null = null
  if (policySigned && POLICY_KINDS.has(kind)) {
    const s = await signedVia(String(obj(policySigned.approval).approvalId ?? ''), 'owner-policy')
    policyProposalId = s.proposal ? String(obj(s.proposal).id) : null
    const p = obj(obj(policySigned.record).policy)
    instruments.push({
      kind: 'standing-policy', id: String(p.nonce ?? `policy ${String(obj(policySigned.record).sequence)}`), signedAt: policySigned.at, status: policyNow.nonce === p.nonce ? policyNow.status : 'superseded or revoked since',
      text: s.proposal ? obj(obj(s.proposal).terms).message ?? null : null,
      limits: [
        { name: 'targetFree', value: p.targetFree, text: `keep at least ${units(p.targetFree, R.decimals, R.symbol)} free in the reserve` },
        { name: 'minTranche', value: p.minTranche, text: `never convert less than ${units(p.minTranche, A.decimals, A.symbol)} at a time` },
        { name: 'maxTranche', value: p.maxTranche, text: `never more than ${units(p.maxTranche, A.decimals, A.symbol)} at a time` },
        { name: 'maxImpactBps', value: p.maxImpactBps, text: `at most ${Number(p.maxImpactBps) / 100}% execution cost` },
      ],
      expiresAt: iso(Number(p.validUntil) * 1000), enforcement: obj(policySigned.record).enforcement ?? null,
      ...authorityProof(db, s, rpId),
    })
  }
  if (proposal && !['mandate', 'policy'].includes(kind)) {
    const s = await signedVia(walletApprovalFor(db, ws, String(job.proposalId)), `owner-${kind}`)
    instruments.push({ kind: 'owner-approval', id: `${kind} ${String(job.proposalId).slice(0, 8)}…`, signedAt: s.approval ? approvalView(db, ws, String((s.approval as Row).id))?.confirmedAt ?? null : null, summary: proposal.summary, allowedWhenPrepared: proposal.allowed, checksWhenPrepared: proposal.checks ?? [], ...authorityProof(db, { ...s, proposal }, rpId) })
  }
  const venues = arr(state.venues).map((x) => ({ index: x.index ?? null, address: x.address ?? x.pool ?? null, name: x.name ?? x.label ?? null }))

  // 3: the agent's decision, the vault's limits, the co-signer, the chain, reconciliation; and the job's steps
  const checks: CheckEntry[] = []
  for (const st of steps) {
    const by = /cosigner/.test(st.key) ? 'co-signer' : st.key === 'receipt' || st.key === 'submit' ? 'chain' : st.key === 'reconcile' ? 'reconciliation' : st.key === 'mandate' ? 'vault limits' : st.key === 'decide' ? 'agent (deterministic policy)' : st.key === 'interpret' ? 'language guard' : st.key === 'attack' ? 'Security Lab' : 'vault service'
    if (st.status === 'pending' || st.status === 'info') continue
    checks.push({ by, name: st.key, pass: st.status === 'ok', detail: st.detail, source: { step: st.seq } })
  }
  for (const lc of arr<{ id: string; rule: string; pass: boolean; limit: string | null; used: string | null; remaining: string | null; detail?: string }>(obj(steps.find((s) => s.key === 'mandate')?.data).checks)) {
    checks.push({ by: 'vault limits', name: `limit: ${lc.id}`, pass: lc.pass, detail: `${lc.rule}: limit ${lc.limit ?? '-'}, used ${lc.used ?? '-'}, remaining ${lc.remaining ?? '-'}${lc.detail ? `; ${lc.detail}` : ''}` })
  }
  for (const d of jobDecisions) {
    const rec = obj(d.record)
    for (const x of arr<{ name?: string; id?: string; pass?: boolean; ok?: boolean; detail?: string }>(rec.checks)) checks.push({ by: `co-signer (decision record #${d.n})`, name: String(x.name ?? x.id), pass: (x.pass ?? x.ok) === true, detail: String(x.detail ?? ''), source: { decision: d.n } })
  }
  if (job.status === 'failed') checks.push({ by: 'vault service', name: 'job-completed', pass: false, detail: String(job.error ?? 'failed') })
  // A wait is the agent's own decision not to convert: recorded with all five candidates, and the binding figure named.
  const waits = steps.filter((s) => s.key === 'decide' && obj(obj(s.data).decision).action === 'wait')
  const minTranche = String(obj(obj(policySigned?.record).policy).minTranche ?? '')
  for (const s of waits) {
    const d = obj(obj(s.data).decision), c = obj(d.candidates)
    const below = Object.entries(c).filter(([, v]) => v !== null && minTranche && BigInt(String(v)) < BigInt(minTranche)).map(([k, v]) => `${k} ${units(v, A.decimals, A.symbol)}`)
    checks.push({ by: 'agent (deterministic policy)', name: `tranche: ${String(d.limitedBy)}`, pass: false, detail: `${String(d.reason)}. Candidates: ${Object.entries(c).map(([k, v]) => `${k} ${v === null ? 'more than any allowed tranche' : units(v, A.decimals, A.symbol)}`).join(', ')}; minimum tranche ${minTranche ? units(minTranche, A.decimals, A.symbol) : 'unrecorded'}${below.length ? `; below the minimum: ${below.join(', ')}` : ''}.`, source: { step: s.seq } })
  }
  // A refusal recorded only in the job's result (no step refused) is a failed check in its own words.
  if (['refused', 'reverted'].includes(String(result.outcome)) && !checks.some((x) => !x.pass)) checks.push({ by: 'vault service', name: `job-${String(result.outcome)}`, pass: false, detail: String(result.summary ?? '') })
  const failing = checks.filter((x) => !x.pass)

  // 5 and 6: the transactions, and what each executed one moved by its BestExecution event; balances re-read after each
  const hashes = [...new Set([result.tx ? String(obj(result.tx).hash) : null, ...steps.map((s) => (obj(s.data).hash as string | undefined) ?? null)].filter((h): h is string => !!h && /^0x[0-9a-fA-F]{64}$/.test(h)))]
  const transactions: TxEntry[] = []
  for (const h of hashes) {
    const r = obj(await V.item('receipts', h).catch(() => ({})))
    const stored = obj(r.stored)
    const ephemeral = !!r.network && r.network !== health.network
    transactions.push({ hash: h, chain: ephemeral ? 'ephemeral' : 'vault', status: String(stored.status ?? ''), block: String(stored.block ?? ''), gasUsed: String(stored.gasUsed ?? ''), from: (stored.from as string) ?? null, to: (stored.to as string) ?? null, events: arr<{ name: string; address?: string; args?: Json }>(stored.events), network: r.network ?? null, ...(stored.error ? { error: stored.error } : {}), chainWhenAssembled: r.chain ?? null } as TxEntry)
  }
  const ev = obj(result.evidence)
  const moved: MovedEntry[] = [], balances: BalanceEntry[] = []
  const executions: Json[] = []
  // Addresses the records name, so that a transfer reads as from one account of this vault to another.
  const contracts = { ...obj(workspace.contracts), ...obj(state.contracts) } as Record<string, unknown>
  const roles = obj(state.roles)
  const pairs: [string, string][] = [[String(contracts.vault ?? ''), 'treasury vault'], [String(contracts.reserve ?? ''), 'dollar reserve'], [String(contracts.execution ?? ''), 'execution module'], [String(contracts.ownerAccount ?? workspace.ownerAccount ?? ''), 'owner account'], [String(roles.creditor ?? ''), 'CloudCo (the approved payee)']]
  const named = new Map<string, string>(pairs.filter(([k]) => k).map(([k, v]) => [k.toLowerCase(), v]))
  const nameOf = (a: unknown): string => named.get(String(a).toLowerCase()) ?? String(a)
  const tokenOf = (a: unknown): { symbol: string; decimals: number } => (String(a).toLowerCase() === A.address.toLowerCase() ? A : String(a).toLowerCase() === R.address.toLowerCase() ? R : { symbol: String(a), decimals: 0 })
  for (const st of steps) {
    const data = obj(st.data)
    if (st.key === 'receipt' && st.status === 'ok' && typeof data.hash === 'string') {
      const tx = String(data.hash)
      const stored = transactions.find((t) => t.hash.toLowerCase() === tx.toLowerCase())
      const beAt = stored ? stored.events.findIndex((e) => e.name === 'BestExecution') : -1
      const be = beAt >= 0 ? stored!.events[beAt] : undefined
      if (!be?.args) {
        // Not a conversion: what moved is each token transfer the transaction emitted.
        stored?.events.forEach((e, i) => { if (e.name === 'Transfer' && e.args) { const t = tokenOf(e.address); moved.push({ what: `${t.symbol} from ${nameOf(e.args.from)} to ${nameOf(e.args.to)} (step ${st.seq})`, asset: t.symbol, decimals: t.decimals, amount: String(e.args.value), from: nameOf(e.args.from), to: nameOf(e.args.to), text: units(e.args.value, t.decimals, t.symbol), evidence: { tx, event: 'Transfer', arg: 'value', index: i } }) } })
        continue
      }
      moved.push({ what: `${A.symbol} converted from the treasury (step ${st.seq})`, asset: A.symbol, decimals: A.decimals, amount: String(be.args.amountIn), from: 'treasury vault', to: 'execution module', text: units(be.args.amountIn, A.decimals, A.symbol), evidence: { tx, event: 'BestExecution', arg: 'amountIn', index: beAt } })
      moved.push({ what: `${R.symbol} delivered to the reserve (step ${st.seq})`, asset: R.symbol, decimals: R.decimals, amount: String(be.args.amountOut), to: 'dollar reserve', text: units(be.args.amountOut, R.decimals, R.symbol), evidence: { tx, event: 'BestExecution', arg: 'amountOut', index: beAt } })
      const out = BigInt(String(be.args.amountOut)), bound = BigInt(String(be.args.bound))
      executions.push({ tx, amountIn: be.args.amountIn, amountOut: be.args.amountOut, bound: be.args.bound, belowBoundPpm: bound > 0n ? Number(((bound - out) * 1_000_000_000n) / bound) / 1000 : null, rate: `${units(be.args.amountIn, A.decimals, A.symbol)} for ${units(be.args.amountOut, R.decimals, R.symbol)}` })
    }
    if (st.key === 'reconcile' && data.before !== undefined && data.after !== undefined) {
      const add = (account: string, sym: { symbol: string; decimals: number }, b: unknown, a: unknown): void => { const x = BigInt(String(b)), y = BigInt(String(a)); balances.push({ account: `${account} (step ${st.seq})`, asset: sym.symbol, decimals: sym.decimals, before: String(x), after: String(y), delta: String(y - x), source: 'the vault service, re-read from the chain after the transaction' }) }
      const LABEL: Record<string, string> = { vault: 'treasury vault', reserve: 'dollar reserve', other: kind === 'withdraw' || kind === 'deposit' ? 'owner account' : 'the other side', ringFenced: 'treasury vault, ring-fenced' }
      if (typeof data.before === 'object') { const b = obj(data.before), a = obj(data.after); for (const k of Object.keys(b)) if (a[k] !== undefined) add(LABEL[k] ?? k, k === 'reserve' ? R : A, b[k], a[k]) }
      else add('dollar reserve, free', R, data.before, data.after)
    }
  }
  const teardown = obj(steps.find((s) => s.key === 'teardown')?.data)
  const budget = await V.read('payment-limits').then((x) => obj(x).authority ?? null).catch(() => null)

  // 4: what asked for this job
  // the engine's own record of asking for this job: this workspace's event (since R13), or in an older line for every
  // workspace only the part that names this job, never the other workspaces' (R13 review, lead L-08)
  const engineEvent = db.all<{ ts: number; payload_json: string }>(`SELECT ts, payload_json FROM events WHERE (user_id = ? OR user_id IS NULL) AND type = 'vault' AND payload_json LIKE ? ORDER BY id LIMIT 1`, ws, `%${jobId}%`)
    .map((e) => ({ ts: e.ts, payload_json: j({ what: String(parse<Json>(e.payload_json, {}).what ?? '').split('; ').find((x) => x.includes(jobId)) ?? '' }) }))[0]
  const asked = db.get<{ ts: number; action: string }>(`SELECT ts, action FROM audit WHERE user_id = ? AND subject = ? AND action LIKE 'vault.%' ORDER BY id LIMIT 1`, ws, jobId)
  const requestedBy = job.proposalId
    ? { who: 'the owner, with a fresh passkey signature over these exact terms', evidence: `proposal ${String(job.proposalId)}; approval ${String(walletApprovalFor(db, ws, String(job.proposalId)) ?? 'unrecorded')}`, at: job.createdAt }
    : engineEvent ? { who: asked ? 'the engine\'s scheduler, and also the owner\'s session' : 'the engine\'s scheduler, by itself', evidence: `the engine's record of ${iso(engineEvent.ts)}: "${String(parse<Json>(engineEvent.payload_json, {}).what ?? '').slice(0, 200)}"; ${asked ? `and audit ${asked.action} at ${iso(asked.ts)}` : 'the audit log has no interface request (vault.policy-tick, vault.policy-run) that names this job'}`, at: iso(engineEvent.ts) }
      : asked ? { who: 'the owner\'s session, with no signature (a run under authority already signed)', evidence: `audit ${asked.action} at ${iso(asked.ts)}`, at: iso(asked.ts) }
        : { who: 'unrecorded', evidence: 'no record of who asked', at: job.createdAt }

  // 7: other decisions under the same authority, and the vault's own limit check now
  const sameKind = arr(jobsR.jobs).filter((j) => j.id !== jobId && (STANDING_KINDS.has(kind) ? STANDING_KINDS.has(String(j.kind)) : j.kind === kind)).slice(0, 20)
  const recorded = STANDING_KINDS.has(kind)
    ? ticks.filter((t) => t.jobId !== jobId).map((t) => ({ caseId: `vault.${String(t.jobId)}`, changed: `tick ${String(t.n)}: reserve free ${units(t.reserveFree, R.decimals, R.symbol)}, shortfall ${units(t.shortfall, R.decimals, R.symbol)}`, decision: `${String(t.action)} ${t.action === 'convert' ? units(t.amountIn, A.decimals, A.symbol) : ''}`.trim(), outcome: t.outcome, limitedBy: t.limitedBy ?? null, reason: t.reason }))
    : sameKind.map((j) => ({ caseId: `vault.${String(j.id)}`, changed: 'the same kind of request with other terms', decision: jobOutcome(j), summary: String(obj(j.result).summary ?? j.error ?? '').slice(0, 240) }))
  const probes: Json[] = []
  if (mandate && (STANDING_KINDS.has(kind) || kind === 'convert')) {
    const cap = BigInt(String(obj(mandate.fields).maxPerPayment)), one = 10n ** BigInt(A.decimals)
    for (const [q, raw] of [[`A conversion of exactly the per-conversion limit, ${units(cap, A.decimals, A.symbol)}, now?`, cap], [`One ${A.symbol} more than that limit, now?`, cap + one]] as const) {
      const amount = `${raw / one}.${String(raw % one).padStart(A.decimals, '0')}`
      const lim = obj(await V.read('limits', { amount }).catch((e) => ({ error: (e as Error).message })))
      probes.push({ question: q, input: { amount }, answer: lim.error ? { error: lim.error } : { allowed: lim.allowed ?? null, failed: arr<{ rule: string; pass: boolean; remaining: string | null }>(lim.checks).filter((x) => !x.pass).map((x) => ({ rule: x.rule, remaining: x.remaining })) }, by: 'the vault service\'s own limit check (GET /limits), which prepares and sends nothing', evaluatedAt: iso(o.now) })
    }
  }

  // 8: every refusal on record for this vault
  const stopped = (j: Json): { name: string; detail: string } | null => {
    const st = arr<StepEntry>(j.steps).find((x) => x.status === 'refused' || x.status === 'reverted') ?? arr<StepEntry>(j.steps).find((x) => x.key === 'decide' && obj(obj(x.data).decision).action === 'wait')
    if (st) return { name: `${st.key} ${st.status === 'info' ? 'waited' : st.status}`, detail: st.detail.slice(0, 300) }
    if (j.status === 'failed' || ['refused', 'reverted'].includes(String(obj(j.result).outcome))) return { name: String(obj(j.result).outcome ?? j.status), detail: String(obj(j.result).summary ?? j.error ?? '').slice(0, 300) }
    return null
  }
  const related = arr(jobsR.jobs).filter((j) => j.id !== jobId && stopped(j)).map((j) => ({
    caseId: `vault.${String(j.id)}`, at: j.finishedAt ?? j.createdAt, what: String(j.kind), failed: [stopped(j)!],
    executed: false, proof: obj(j.result).tx ? `transaction ${String(obj(obj(j.result).tx).hash).slice(0, 12)}… ${String(obj(obj(j.result).tx).status)}${String(j.kind) === 'attack' ? ' on a throwaway chain' : ''}` : 'no transaction was sent',
  }))
  for (const d of all.filter((x) => x.verdict === 'REFUSED' && x.jobId !== jobId)) related.push({ caseId: d.jobId ? `vault.${d.jobId}` : null as never, at: d.at, what: d.kind, failed: [{ name: 'REFUSED', detail: JSON.stringify(obj(d.record)).slice(0, 300) }], executed: false, proof: `decision record #${d.n}` })

  // Who proposed the terms this job ran under (N-009): the model call behind the job's own terms, or, for a tick, behind the policy.
  const link = modelLink(db, ws, [job.proposalId as string | null, STANDING_KINDS.has(kind) ? policyProposalId ?? policyProposalOf(db, ws, jobId, all) : null])
  const linkWho = link ? modelLabel(link.call ? String(link.call.provider) : null, link.call ? String(link.call.model) : null) : null
  // A run of ticks can convert and then be refused: the case says both.
  const outcome = jobOutcome(job) === 'executed' && failing.length ? 'executed, then refused' : jobOutcome(job)
  const ephemeral = transactions.some((t) => t.chain === 'ephemeral') || kind === 'attack'
  const venue: EvidenceCase['venue'] = ephemeral ? 'ephemeral-chain' : 'local-chain'
  const network = obj(state.network)
  const sections = {
    1: titled(1, {
      objective: policySigned && STANDING_KINDS.has(kind) ? { text: String(instruments.find((x) => x.kind === 'standing-policy')?.text ?? ''), source: 'the standing policy\'s text, as the owner\'s passkey signed it (EIP-191 through the owner account)', at: policySigned.at } : { text: String(proposal?.summary ?? result.summary ?? kind), source: 'the terms the owner was shown and signed', at: job.createdAt },
      instruments, venues, decisionRecords: instruments.map((x) => x.decisionRecord).filter(Boolean),
    }),
    2: link ? { ...modelSection(o, link.call, String(link.proposal.id)), proposedOnChain: { modelProposal: link.proposal.id, kind: link.proposal.kind, vaultProposal: link.draft.vaultProposalId, approval: link.draft.approvalId, termsHash: link.draft.termsHash, draftedAt: iso(link.draft.at), how: STANDING_KINDS.has(kind) ? 'This tick ran under a standing policy that the model proposed and the owner signed once, with the passkey, over its exact terms. The model did not choose this tranche: the agent\'s fixed code did (decideTranche), the co-signer re-derived it, and the contract checked the trade.' : 'The model proposed these terms; the owner signed them with the passkey; the vault service, the co-signer and the chain decided.' } } : titled(2, { ...modelLabel(null, null), involved: false, statement: STANDING_KINDS.has(kind) ? 'No model took part. The agent that decided this tranche is the release\'s deterministic policy code (roles/treasury.ts decideTranche); the co-signer re-derived it with its own code. In this build nothing a model outputs reaches the chain.' : 'No model took part: the owner asked for this, and the vault service\'s own code decided it.', decidedBy: STANDING_KINDS.has(kind) ? 'deterministic policy' : 'the vault service', information: tick ? [{ reserveFree: tick.reserveFree, shortfall: tick.shortfall, candidates: tick.candidates }] : [], constraints: tick ? ['X = min(need, impact, policy cap, mandate cap, free funds); below the minimum tranche it waits.'] : [] }),
    3: titled(3, { decision: failing.length ? (outcome === 'no-action' ? 'waited' : 'refused') : 'allowed', statement: 'Each step as the vault service recorded it, with the co-signer\'s own checks from its hash-chained decision record.', checks, steps, decisionRecords: jobDecisions }),
    4: titled(4, {
      freshOwnerSignature: !!job.proposalId,
      ranUnder: instruments.filter((x) => x.kind !== 'owner-approval').map((x) => ({ kind: x.kind, id: x.id, signedAt: x.signedAt ?? null })),
      requestedBy, signaturesUsed: instruments.map((x) => ({ approvalId: obj(x.approval).id ?? null, when: x.signedAt ?? null, what: x.kind })),
      statement: job.proposalId ? 'This needed the owner\'s fresh passkey signature over its exact terms.' : 'This ran under the mandate and the standing policy the owner signed earlier. No one signed anything for it.',
    }),
    5: titled(5, {
      executed: jobOutcome(job) === 'executed' || moved.length > 0, moved, balances,
      executions: executions.length ? { trades: executions, note: 'From each trade\'s BestExecution event: what the route delivered against the on-chain upper bound on what any route over the named venues could deliver. The chain reverts a trade outside the tolerance the co-signer signed.' } : null,
      ...(Object.keys(teardown).length ? { thisVaultAfterwards: { unchanged: teardown.workspaceUnchanged ?? null, before: teardown.before ?? null, after: teardown.after ?? null, note: 'This vault\'s balances read before and after the run on the throwaway chain.' } } : {}),
      authorityBudget: budget ? { ...obj(budget), note: 'The co-signer\'s authority budget (D7), as it stands when the case is assembled.' } : null,
      consequence: String(result.summary ?? job.error ?? ''), guidance: job.guidance ?? null,
      units: `Amounts are integers in the token's smallest unit: ${A.symbol} has ${A.decimals} decimals, ${R.symbol} ${R.decimals}.`,
    }),
    6: titled(6, {
      revision: revision(), venue: { kind: venue, network: job.network ?? null },
      chain: { chainId: Number(network.chainId ?? 31337), name: network.name ?? null, rpc: network.rpc ?? null, genesisId: state.genesisId ?? null, versions: health.versions ?? null },
      contracts: { ...obj(workspace.contracts), ...obj(state.contracts) }, roles: state.roles ?? null, keys: obj(workspace.keys),
      ownerAccount: { address: workspace.ownerAccount ?? null, kind: workspace.ownerKind ?? null, threshold: workspace.threshold ?? null, signers: arr(workspace.signers).map((x) => ({ x: x.x, y: x.y, role: x.role })), build: workspace.ownerAccountBuild ?? null },
      transactions,
      ids: { job: jobId, kind, proposal: job.proposalId ?? null, vaultWorkspace: workspace.id ?? null, tick: tick?.n ?? null },
      decisionChain: { ...obj(verify), note: 'The vault service re-hashed its whole decision chain when the case was assembled.' },
    }),
    7: titled(7, { recorded, probes, note: STANDING_KINDS.has(kind) ? 'Recorded: the other ticks of the policy, each the same authority on a different reserve and usage. Probes: the vault\'s own limit check now.' : 'Recorded: other jobs of the same kind. Probes: the vault\'s own limit check now.' }),
    8: titled(8, { thisCase: failing.map((x) => ({ check: x.name, by: x.by, detail: x.detail })), related: related.slice(0, 30) }),
  }
  const signedWithSoftKey = instruments.some((x) => x.attestation && !obj(x.attestation).attested)
  return {
    ...envelope(o, { id: `vault.${jobId}`, kind: 'vault-job', title: String(result.summary ?? `${kind} ${String(job.status)}`).slice(0, 200), outcome, venue }),
    sections: sections as unknown as UnsealedCase['sections'],
    verification: { receiptChain: receiptChain(db, ws, []), ledger: { breaks: verifyLedger(db, ws), checkedAt: 'when the case was assembled' }, vaultDecisions: { server: verify, reHashedHere: jobDecisions.length + instruments.filter((x) => x.decisionRecord).length }, note: 'A vault job is recorded by the vault service, not in the wallet\'s receipt chain: its decision records are hash-chained there, and each one this case carries is re-hashed by the verifier. The wallet\'s receipt chain and ledger as a whole were verified too when the case was assembled.' },
    redactions: [...ALWAYS_REDACTED, { what: 'The vault service\'s keys', how: 'never held by this API; addresses only', why: 'The agent, co-signer, guardian and relayer keys stay in the vault service.' }, ...(link ? modelRedactions(link.call) : [])],
    cannotProve: [
      ...(!link ? ['No model took part in this job: the owner asked for it directly, or the engine ran it under authority the owner wrote.'] : linkWho?.isModel ? ['One call of one model: it does not show how the model behaves on other inputs, and the model chose the terms, not the tranche (fixed code chose that).'] : ['The terms this job ran under were proposed by a scripted test double, not a model. This case shows QED\'s controls around a model-proposed on-chain action; it is no evidence of a model\'s choice (N-009 needs a real model\'s proposal).']),
      ...(link && !keptSnapshot(link.call) ? [NO_SNAPSHOT] : []),
      ephemeral ? 'This ran on a throwaway chain of its own that no longer exists; its transaction can be read only from the vault service\'s record.' : `The transactions are on a local Anvil chain (chain id ${String(network.chainId ?? 31337)}) started for this installation, with valueless test tokens. Their hashes are not publicly verifiable; they can be re-read only from that chain while it runs (verify-evidence.ts --rpc).`,
      ...(signedWithSoftKey ? [SOFT_KEY] : []),
      ...(probes.length ? ['Probes are evaluated when the case is assembled, against the chain state then; they are not records of past decisions.'] : []),
      FORGERY, NO_REVIEW,
    ],
  }
}
function walletApprovalFor(db: Db, ws: string, proposalId: string): string | null {
  return db.get<{ id: string }>(`SELECT id FROM approvals WHERE user_id = ? AND subject = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1`, ws, `rail:${proposalId}`)?.id ?? null
}
/** The proof of one signed piece of vault authority: the document, the terms and their hash, the passkey signatures, the decision record. */
function authorityProof(db: Db, s: Json, rpId: string): Json {
  const a = s.approval as Row | undefined, p = s.proposal as Json | null, d = s.decision as DecisionEntry | null
  return {
    ...(a ? { document: { text: String(a.document), sha256: String(a.doc_hash) }, approval: { id: String(a.id), docHash: String(a.doc_hash) }, signatures: signaturesOf(db, String(a.id), String(a.doc_hash), rpId), attestation: attestation(db, String(a.id)) } : { approval: null, signatures: [] }),
    ...(p ? { terms: p.terms, termsHash: p.termsHash, digests: arr(obj(p.terms).toSign).map((t) => ({ kind: t.kind, digest: t.digest, purpose: t.purpose ?? null, threshold: t.threshold ?? null })) } : {}),
    ...(d ? { decisionRecord: d } : {}),
  }
}
