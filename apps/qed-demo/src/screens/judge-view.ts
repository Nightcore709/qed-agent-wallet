/**
 * The words and states of the judge's walk-through (Judge.tsx), from the server's index (server/judge.ts) and the evidence
 * case of the tick it follows (server/evidence.ts). Pure: no figure is computed here, only carried from a record and said
 * in words; tested in judge-view.test.ts. Every station and branch says where it comes from, in the owner's four words
 * (shared/judge.ts PROVENANCE; R13): a genuine model call, mock or scripted, historical evidence, or newly reproduced.
 */
import { PROVENANCE, type Provenance } from '../../shared/judge.ts'
import { stateWord } from '../ui/kit.tsx'
import { checkWords, plainBy, readable, units } from './Evidence.tsx'

type J = Record<string, any>
export type Tone = 'ok' | 'wait' | 'void' | 'plain'

// The index, as server/judge.ts sends it (the fields this module reads).
export interface Asset { symbol: string; decimals: number }
export interface Who { provider: string; model: string; isModel: boolean; label: string; statement: string }
export interface WalletCheck { name: string; pass: boolean; detail: string }
export interface Step { key: string; label: string; status: string; detail: string }
export interface Call extends Who { id: string; caseId: string; at: string | null; ok: boolean; error: string | null; question: string | null; withheld: boolean; provenance?: 'genuine' | 'scripted' | 'none'; spend?: Spend | null }
/** On the Anthropic API: why this model answered, and what the question cost at the published prices (server/judge.ts CallSpend). */
export interface Spend { tier: string; why: string; costUsd: number; attempts: { model: string; answeredBy: string | null; outcome: string }[]; passedOver: { model: string; why: string }[]; priceSource: string | null }
/** On the Anthropic API: the models and the spending limits as they stand (server/ask-models.ts ModelsView, the fields read here). */
export interface ModelsLine { demanding: string | null; routine: string | null; spentUsd: { budget: number; budgetLimit: number }; readOnly: { message: string } | null; priceSource: string }
export interface Proposal { id: string; kind: string; title: string | null; rationale: string | null; params: J; state: string; invalidReason: string | null; checks: WalletCheck[] }
export interface Job { jobId: string; caseId: string; kind: string; at: string | null; status: string; outcome: string; summary: string | null; error: string | null }
export interface Tick extends Job { n: number | null; action: string | null; amountIn: string | null; limitedBy: string | null; reason: string | null; requestedBy: 'engine' | 'owner' | 'engine-and-owner' | 'unrecorded'; asked: number; tx: { hash: string; block: string | null; status: string | null } | null; steps: Step[] }
export interface Decision { call: Call; proposals: Proposal[] }
export interface JudgeIndex {
  format: string; assembledAt: string; presentation: boolean; proposerNow: Who; models?: ModelsLine | null
  wallet: { state: 'none' | 'unreachable' | 'awaiting-acceptance' | 'ready'; reason: string | null; network: string | null; chainId: number | null; asset: Asset; reserveAsset: Asset; decisionRecords: { ok: boolean; records: number; brokenAt: number | null } | null }
  mandate: null | { version: number; status: string; perPayment: string; perPeriod: string; periodSeconds: number; total: string; validUntil: number | null; signedAt: string | null; purpose: string | null; jobCaseId: string | null }
  policy: null | { status: string; targetFree: string; signedAt: string | null; nonce: string | null; ticks: number }
  journey: null | { decision: Decision; proposal: Proposal | null; signed: (Job & { policyNonce: string | null }) | null; ticks: Tick[]; execution: Tick | null }
  branches: { changed: Decision[]; injected: Decision | null; refusals: (Job & { by: string })[]; revocation: null | (Job & { next: Tick | null }); repeated: Tick | null; restored: null | (Job & { next: Tick | null }) }
}
/** A sealed case, as far as this module reads it. */
export interface CaseLike { id: string; hashes: { root: string }; sections: Record<string, J> }

/** A record's moment as a person reads it, in India time: "24 Nov, 12:40". */
export function when(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') return ''
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + 19_800_000)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
/** A long hex identifier, shortened for reading; the whole of it is in the expert detail. */
export const shortHash = (h: string | null | undefined): string => (h ? (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h) : '')
const tokens = (raw: string | null | undefined, a: Asset): string => units(raw ?? '0', a.decimals, a.symbol)
/** A record's words for reading (Activity's readable), with each raw address or hash shortened rather than dropped, so a
 * sentence that names one still reads ("0x00000000…00dEaD is not a payee"). The whole of it is in the expert detail. */
export const say = (t: string): string => readable(t.replace(/0x[0-9a-fA-F]{40,64}\b/g, (h) => shortHash(h)))
const upper = (t: string): string => t.replace(/^./, (c) => c.toUpperCase())

// ------------------------------------------------------------------------------------------------ who decides

/** Who answers Ask here, in one line and where its decisions come from: never a test double called a model. */
export function proposerLine(w: Who): { word: string; tone: Tone; provenance: Provenance | null; says: string } {
  if (w.isModel) return { word: `A real model: ${w.model}`, tone: 'ok', provenance: 'genuine', says: w.statement }
  if (w.label === 'scripted-test-double') return { word: 'A scripted test double, not a model', tone: 'wait', provenance: 'scripted', says: w.statement }
  if (w.label === 'test-double') return { word: 'A test double, not a model', tone: 'wait', provenance: 'scripted', says: w.statement }
  return { word: 'No model', tone: 'plain', provenance: null, says: w.statement }
}

/** US$ as the records show it: two decimals, three below a cent so that a small call does not read as nothing. */
export const usd = (v: number): string => `US$${v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`
/** Why this model answered and what the question cost, as the call recorded them (the API path only). */
export function spendFacts(s: Spend): { label: string; value: string }[] {
  const failed = s.attempts.filter((a) => !['answered', 'refused', 'unusable'].includes(a.outcome))
  return [
    { label: 'Why this model', value: `A ${s.tier} question: ${s.why}.${s.passedOver.length ? ` Passed over: ${s.passedOver.map((x) => `${x.model} (${x.why})`).join('; ')}.` : ''}${failed.length ? ` Asked first, without an answer: ${failed.map((a) => `${a.model} (${a.outcome.replace(/_/g, ' ')})`).join('; ')}.` : ''}` },
    { label: 'What it cost', value: `${usd(s.costUsd)} in all, ${s.attempts.length} request${s.attempts.length === 1 ? '' : 's'}, priced from the tokens the API reported${s.priceSource ? ` (${s.priceSource})` : ''}` },
  ]
}

/** Who answered, as the subject of a sentence: never a test double called a model. */
export function subjectOf(w: Who): string {
  if (w.isModel) return `${w.model}, a real model,`
  if (w.label === 'scripted-test-double') return 'The scripted test double, which is not a model,'
  if (w.label === 'test-double') return 'A test double, which is not a model,'
  return 'QED\'s fixed rules'
}
/** When a recorded run was produced, from the record's own text ("2026-11-22 22:40:08.534 IST" or an ISO instant). */
export function producedWords(t: string | null): string {
  if (!t) return 'At an unrecorded time'
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(t)
  if (!m) return t
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (/IST$/.test(t)) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]} IST`
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? `${when(ms).replace(/^(\d+ \w+)/, `$1 ${new Date(ms + 19_800_000).getUTCFullYear()}`)} IST` : t
}

/** The mandate in words: what it lets the agent move, and until when; the chain enforces it. */
export function mandateWords(m: NonNullable<JudgeIndex['mandate']>, a: Asset): string {
  const day = m.periodSeconds === 86_400 ? 'a day' : `every ${Math.round(m.periodSeconds / 3600)} hours`
  const until = m.validUntil ? `, until ${when(m.validUntil * 1000)}` : ''
  return `At most ${tokens(m.perPayment, a)} a payment or conversion, ${tokens(m.perPeriod, a)} ${day} and ${tokens(m.total, a)} in all${until}`
}

/** Who asked for a tick: the engine by itself, or the owner's session with no signature. */
export function requestedWords(t: Pick<Tick, 'requestedBy' | 'asked'>): string {
  switch (t.requestedBy) {
    case 'engine': return 'QED\'s engine asked for it by itself, on its own schedule: no page asked for it, and no one signed anything for it.'
    case 'owner': return `It was asked for from a page, your session${t.asked > 1 ? ` (${t.asked} times, with one key)` : ''}, with no signature: it ran under the policy you had already signed. The engine did not start it.`
    case 'engine-and-owner': return 'The engine and your session both asked for it; it ran once. No one signed anything for it.'
    default: return 'No record says who asked for it.'
  }
}

/** How a vault job ended, in the shared status words (DESIGN.md M12). */
export function jobStamp(j: Pick<Job, 'outcome' | 'status'>): [string, Tone] {
  switch (j.outcome) {
    case 'executed': return ['Completed', 'ok']
    case 'refused': return ['Refused by QED\'s checks', 'void']
    case 'reverted': return ['Reverted by the chain', 'void']
    case 'failed': return ['Failed', 'void']
    case 'no-action': return ['Nothing to do', 'plain']
    default: return j.status === 'accepted' || j.status === 'running' || j.status === 'confirming' ? ['Pending', 'plain'] : [upper(stateWord(j.outcome || j.status)), 'plain']
  }
}
/** A proposal's state, in the shared words. */
export function proposalStamp(p: Pick<Proposal, 'state'>): [string, Tone] {
  if (p.state === 'invalid') return ['Refused by QED\'s checks', 'void']
  if (p.state === 'new' || p.state === 'drafted') return ['Proposed', 'plain']
  if (p.state === 'dismissed') return ['Cancelled', 'plain']
  if (p.state === 'superseded') return ['Replaced', 'plain']
  return [upper(p.state), 'plain']
}
/** Who refused, said once (QED's own checks before anything was sent; the co-signer, a separate process; the chain). */
export function refusedByWords(by: string): string {
  return by === 'cosigner' ? 'the co-signer, a separate process with its own key' : by === 'chain' ? 'the chain: the contract reverted it' : by === 'vault-service' ? 'the vault service, before anything was sent' : 'QED\'s own checks, before anything was sent'
}

// ------------------------------------------------------------------------------------------------ the six stations

export type StationId = 'authority' | 'decision' | 'checks' | 'execution' | 'reconciliation' | 'evidence'
export interface Fact { label: string; value: string; code?: boolean }
export interface CheckLine { name: string; pass: boolean; by: string; detail: string }
export interface Station {
  n: number; id: StationId; title: string
  /** For the rail: done, where the next move is, not reached, or where the flow stopped (a refusal, a failure). */
  progress: 'done' | 'current' | 'todo' | 'stopped'
  /** How the action at this station ended, in the shared status words; none where nothing acted. */
  stamp: [string, Tone] | null
  /** Where this step comes from (R13): one of the four, always. */
  provenance: Provenance
  finding: string
  facts: Fact[]
  /** The checks made at this step, by who made them (QED's own, then the co-signer's), each list in the record's order. */
  groups: { title: string; checks: CheckLine[] }[]
  caseId: string | null
}

/** The co-signer's own checks, from the tick's case (section 3), each in words. */
export function cosignerChecks(c: CaseLike | null): CheckLine[] {
  const checks = (c?.sections['3']?.checks ?? []) as J[]
  return checks.filter((k) => /^co-signer/.test(String(k.by ?? ''))).filter((k) => k.name !== 'cosigner')
    .map((k) => ({ name: checkWords(String(k.name)), pass: k.pass === true, by: plainBy(String(k.by)), detail: say(String(k.detail ?? '')) }))
}
/** The steps the vault service recorded for a job, each in words, in their order. */
export function stepLines(t: Tick | null): CheckLine[] {
  return (t?.steps ?? []).map((s) => ({ name: checkWords(s.key), pass: s.status === 'ok', by: s.key === 'cosigner' ? 'the co-signer' : s.key === 'receipt' || s.key === 'submit' ? 'the chain' : s.key === 'reconcile' ? 'comparing balances before and after' : s.key === 'decide' ? 'the agent\'s fixed rules' : 'the vault service', detail: say(s.detail) }))
}

/** What moved in the tick, from its case (section 5): converted out, delivered in. */
export function movedWords(c: CaseLike | null): string | null {
  const moved = (c?.sections['5']?.moved ?? []) as J[]
  if (!moved.length) return null
  return moved.map((m) => `${units(String(m.amount ?? '0'), Number(m.decimals ?? 0), String(m.asset ?? ''))}${m.from ? ` out of the ${String(m.from)}` : ''}${m.to ? ` into the ${String(m.to)}` : ''}`).join('; ')
}

export function stations(ix: JudgeIndex, tickCase: CaseLike | null, hashCheck: { ok: boolean } | null): Station[] {
  const a = ix.wallet.asset, j = ix.journey, d = j?.decision ?? null, p = j?.proposal ?? null, x = j?.execution ?? null
  const out: Station[] = []
  // 1. the objective and the authority signed earlier
  const objective = d?.call.withheld ? 'A question asked by another member of this workspace (shown only to them and to the workspace\'s owners and admins)' : d?.call.question ? `“${d.call.question.trim()}”` : null
  const m = ix.mandate
  out.push({
    n: 1, id: 'authority', title: 'What you want, and the authority you already signed',
    progress: m?.status === 'active' ? 'done' : 'current',
    stamp: m ? (m.status === 'active' ? ['In force', 'ok'] : [upper(stateWord(m.status)), 'void']) : null,
    provenance: 'reproduced',
    finding: m
      ? `${objective ? `Your objective, as you typed it: ${objective}${/[.!?]”$/.test(objective) ? '' : '.'} ` : ''}The mandate your passkey signed sets the most QED's agent may move: ${lowerStart(mandateWords(m, a))}. The vault contract on the chain checks every payment against it.`
      : ix.wallet.state === 'ready' ? 'No mandate yet: without one, QED\'s agent may move nothing from the wallet. Sign the example mandate below to start.' : walletNotReady(ix),
    facts: [
      ...(objective ? [{ label: 'Objective', value: objective }] : []),
      ...(m ? [{ label: 'Mandate', value: `Version ${m.version}, signed with your passkey ${when(m.signedAt)}` }, { label: 'Limits', value: mandateWords(m, a) }, ...(m.purpose ? [{ label: 'Its purpose, as signed', value: m.purpose }] : [])] : []),
      { label: 'Where it is enforced', value: ix.wallet.chainId === 31337 ? 'A test chain on this QED installation (chain 31337), test tokens of no value' : ix.wallet.network ?? 'No chain yet' },
    ],
    groups: [], caseId: m?.jobCaseId ?? null,
  })
  // 2. the model's decision
  const who = d ? proposerLine(d.call) : null
  const stamp2: [string, Tone] | null = !d ? null : !d.call.ok ? ['Failed', 'void'] : p ? proposalStamp(p) : ['Nothing proposed', 'plain']
  out.push({
    n: 2, id: 'decision', title: 'What the model decided',
    progress: !d ? (m?.status === 'active' ? 'current' : 'todo') : !d.call.ok ? 'stopped' : p ? (p.state === 'invalid' ? 'stopped' : 'done') : 'stopped',
    stamp: stamp2,
    // a decision is a genuine model call or the scripted double; with no model here, only the recorded runs below decide
    provenance: (who ?? proposerLine(ix.proposerNow)).provenance ?? 'historical',
    finding: !d ? (proposerLine(ix.proposerNow).provenance ? `Not asked yet. ${proposerLine(ix.proposerNow).says}` : `Not asked here: ${proposerLine(ix.proposerNow).says} The decisions a real model made in the runs recorded earlier are below, as historical evidence.`)
      : !d.call.ok ? `The call failed: ${say(d.call.error ?? 'no answer')}. Nothing was proposed, so nothing can be signed or run.`
        : p ? `${subjectOf(d.call)} answered${d.call.at ? ` at ${when(d.call.at).split(', ')[1]}` : ''}. It proposed ${p.title ? `“${p.title}”` : 'a standing policy for the wallet'}${p.rationale ? `, because: “${p.rationale.trim()}”` : '.'} A proposal is only words until QED checks it and you sign its exact terms.`
          : `${subjectOf(d.call)} answered and proposed nothing for the wallet. Nothing can be signed or run from this answer.`,
    facts: d ? [
      { label: 'Answered by', value: d.call.isModel ? `${d.call.model}, through ${d.call.provider}, as recorded when it answered` : `${who!.word} (recorded as provider “${d.call.provider}”)` },
      { label: 'Where it comes from', value: PROVENANCE[who!.provenance ?? 'historical'].word },
      ...(d.call.spend ? spendFacts(d.call.spend) : []),
      ...(p ? [{ label: 'Proposed terms', value: policyTerms(p, ix.wallet.reserveAsset) }] : []),
    ] : [],
    groups: [], caseId: d?.call.caseId ?? null,
  })
  // 3. independent verification: QED's checks of the proposal, then the co-signer's of the tick
  const qed: CheckLine[] = (p?.checks ?? []).map((k) => ({ name: checkWords(k.name), pass: k.pass, by: 'QED, before any terms existed', detail: say(k.detail) }))
  const cos = cosignerChecks(tickCase)
  const cosStep = x?.steps.find((s) => s.key === 'cosigner') ?? null
  const failed = [...qed, ...cos].filter((k) => !k.pass)
  const cosRefused = cosStep?.status === 'refused'
  out.push({
    n: 3, id: 'checks', title: 'Checked independently, before anything moved',
    progress: !p ? 'todo' : failed.length || cosRefused ? 'stopped' : x ? 'done' : qed.length ? 'done' : 'todo',
    stamp: failed.length || cosRefused ? ['Refused by QED\'s checks', 'void'] : null,
    provenance: 'reproduced',
    finding: !p ? 'Nothing to check yet.'
      : `${qed.filter((k) => k.pass).length} of ${qed.length} of QED's checks passed on the proposal, against the wallet's own figures${failed.some((k) => k.by.startsWith('QED')) ? `; ${failed.filter((k) => k.by.startsWith('QED')).map((k) => k.name.toLowerCase()).join('; ')} did not` : ''}. ${x ? (cosRefused ? `The co-signer refused the tick: ${say(firstSentence(cosStep!.detail))}` : cos.length ? `The co-signer, a separate process with its own key, then re-derived the tick itself: ${cos.filter((k) => k.pass).length} of ${cos.length} of its checks passed, and only then did it sign.` : cosStep ? `The co-signer, a separate process with its own key, re-derived the tick itself: ${say(firstSentence(cosStep.detail))}` : 'The co-signer\'s checks are in the tick\'s case.') : 'The co-signer checks each tick again, on its own, before it signs.'} The model holds no key and signs nothing.`,
    facts: [],
    groups: [...(qed.length ? [{ title: 'QED\'s checks of the proposal, before any terms existed', checks: qed }] : []), ...(cos.length ? [{ title: 'The co-signer\'s own checks of the tick, before it signed', checks: cos }] : [])], caseId: x?.caseId ?? null,
  })
  // 4. authorised autonomous execution
  const s = j?.signed ?? null
  const stamp4: [string, Tone] | null = x ? jobStamp(x) : s ? (s.outcome === 'executed' ? (ix.policy?.status === 'active' ? ['In force', 'ok'] : ['Completed', 'ok']) : jobStamp(s)) : p && p.state !== 'invalid' ? ['Awaiting your approval', 'wait'] : null
  const moved = movedWords(tickCase)
  out.push({
    n: 4, id: 'execution', title: 'Signed once, then run on its own',
    progress: x ? (x.outcome === 'executed' || x.outcome === 'no-action' ? 'done' : 'stopped') : s ? 'current' : p && p.state !== 'invalid' ? 'current' : 'todo',
    stamp: stamp4,
    provenance: 'reproduced',
    finding: x
      ? `Your passkey signed the policy's exact terms once${s?.at ? `, ${when(s.at)}` : ''}. Then a tick ran with no new signature. ${requestedWords(x)} ${x.outcome === 'executed' ? `It ${moved ? `moved ${moved}` : 'converted under the policy'}, in a transaction on the local test chain.` : x.outcome === 'no-action' ? 'It found nothing to do and waited; its case says why.' : `It did not run: ${say(firstSentence(x.summary ?? x.error ?? ''))}`}`
      : s ? `Your passkey signed the policy's exact terms once${s.at ? `, ${when(s.at)}` : ''}. QED's engine now runs it on its own: it asks for the first tick within about half a minute, then once every five minutes, each with no new signature. This page only reads the records.`
        : p && p.state !== 'invalid' ? 'The proposal waits for you: review its exact terms, then sign them once with your passkey. After that it runs on its own.'
          : 'Nothing to sign yet.',
    facts: [
      ...(s ? [{ label: 'Signed once', value: `${when(s.at)}, with your passkey, over the exact terms` }] : []),
      ...(x ? [
        { label: 'Asked for by', value: requestedWords(x) },
        { label: 'A new signature for it', value: 'None' },
        ...(x.tx ? [{ label: 'Transaction', value: shortHash(x.tx.hash), code: true }, { label: 'Block', value: x.tx.block ?? 'not recorded' }] : []),
        ...(x.amountIn && x.action === 'convert' ? [{ label: 'Tranche', value: `${tokens(x.amountIn, a)}${x.limitedBy ? `, limited by ${LIMITED[x.limitedBy] ?? x.limitedBy}` : ''}` }] : []),
      ] : []),
    ],
    groups: [], caseId: x?.caseId ?? s?.caseId ?? null,
  })
  // 5. reconciliation
  const rec = x?.steps.find((k) => k.key === 'reconcile') ?? null
  const receipt = x?.steps.find((k) => k.key === 'receipt') ?? null
  const bal = ((tickCase?.sections['5']?.balances ?? []) as J[])
  const dr = ix.wallet.decisionRecords
  out.push({
    n: 5, id: 'reconciliation', title: 'The chain\'s record against QED\'s books',
    progress: !x || x.outcome !== 'executed' ? 'todo' : rec?.status === 'ok' && (!dr || dr.ok) ? 'done' : 'stopped',
    stamp: !x || x.outcome !== 'executed' ? null : rec?.status === 'ok' && (!dr || dr.ok) ? ['Completed', 'ok'] : ['Needs attention', 'void'],
    provenance: 'reproduced',
    finding: !x || x.outcome !== 'executed' ? 'Nothing executed yet, so there is nothing to reconcile.'
      : `${receipt ? `The chain mined it: ${say(firstSentence(receipt.detail))} ` : ''}${rec ? `Read back from the chain afterwards: ${say(rec.detail)}${/[.!?]$/.test(rec.detail) ? '' : '.'} ` : ''}${bal.length ? `${bal.length === 1 ? 'That balance agrees' : 'Those balances agree'} with what the trade's own event on the chain says it delivered. ` : ''}${dr ? (dr.ok ? `The co-signer's decision records are whole: ${dr.records}, each chained to the one before by its hash.` : `The co-signer's decision records are broken at no. ${String(dr.brokenAt)}.`) : ''}`,
    facts: bal.map((b) => ({ label: upper(say(String(b.account))), value: `${units(String(b.before), Number(b.decimals), String(b.asset))} before, ${units(String(b.after), Number(b.decimals), String(b.asset))} after` })),
    groups: [], caseId: x?.caseId ?? null,
  })
  // 6. evidence a judge can check
  const root = tickCase?.hashes.root ?? null
  out.push({
    n: 6, id: 'evidence', title: 'Evidence you can check here',
    progress: !x || !tickCase ? 'todo' : hashCheck ? (hashCheck.ok ? 'done' : 'stopped') : 'current',
    stamp: hashCheck ? (hashCheck.ok ? ['Every hash matches', 'ok'] : ['A hash does not match', 'void']) : null,
    provenance: 'reproduced',
    finding: !x ? 'The evidence case appears once a tick has run.'
      : !tickCase ? 'Assembling the case for this tick from the records…'
        : hashCheck ? (hashCheck.ok ? 'This browser recomputed the hash of every part of the case and the root over them, from the case as it arrived. All of them match: nothing is taken on the server\'s word.' : 'A hash recomputed in this browser does not match the case. Do not rely on it; open the full case to see which part.')
          : 'Every part of the case for this tick has its own SHA-256, and the case has a root over them. Check them here, in this browser, or download the case and check it on your own computer.',
    facts: root ? [{ label: 'Case', value: tickCase!.id, code: true }, { label: 'Root', value: shortHash(root), code: true }] : [],
    groups: [], caseId: x?.caseId ?? null,
  })
  // where the next move is: the first station not done, once every one before it is done
  const firstOpen = out.findIndex((st) => st.progress !== 'done')
  return out.map((st, i) => (st.progress === 'current' && i !== firstOpen ? { ...st, progress: 'todo' } : st))
}
const LIMITED: Record<string, string> = { need: 'what the reserve was short', impact: 'its cost limit', 'policy cap': 'the policy\'s largest tranche', 'mandate cap': 'the mandate\'s limit for one payment', 'free funds': 'the free funds' }
const lowerStart = (t: string): string => t.replace(/^At most/, 'at most')
const firstSentence = (t: string): string => { const k = t.search(/[.!?](\s|$)/); return k > 0 ? t.slice(0, k + 1) : t }
/**
 * A refusal's reason, said by its first rule: the vault's limit check lists every limit an amount breaks, separated by
 * semicolons; the first is the one a reader needs, and the rest are counted (all of them are in the case).
 */
export function briefReason(t: string): string {
  const one = firstSentence(t).replace(/\s*\(the same limit as per conversion\)/g, '').replace(/[.\s]+$/, '')
  const parts = one.split(/;\s+/)
  return parts.length > 1 ? `${parts[0]}, and ${parts.length - 1} more limit${parts.length > 2 ? 's' : ''}.` : `${one}.`
}
function walletNotReady(ix: JudgeIndex): string {
  if (ix.wallet.state === 'unreachable') return `The on-chain wallet service is not answering${ix.wallet.reason ? `: ${say(ix.wallet.reason)}` : ''}. Nothing on the chain can be shown or done until it is.`
  if (ix.wallet.state === 'awaiting-acceptance') return 'Your wallet is set up and waits for you to accept it with your passkey.'
  return 'This household has no on-chain wallet yet. Set one up first: it is owned by your passkey.'
}
/** A standing policy's terms in words: "keep at least 10 test dollars free in the dollar reserve". */
export function policyTerms(p: Pick<Proposal, 'kind' | 'params'>, reserve: Asset): string {
  if (p.kind === 'wallet-policy' && typeof p.params.targetFree === 'string') return `Keep at least ${p.params.targetFree} ${reserve.symbol === 'tUSD' ? 'test dollars' : reserve.symbol} free in the dollar reserve, topped up from the treasury`
  if (p.kind === 'wallet-pay' && p.params.amount !== undefined) return `Pay ${String(p.params.amount)} test rupees to ${payeeWords(String(p.params.payee ?? ''))}`
  return say(JSON.stringify(p.params))
}
const payeeWords = (who: string): string => (/^0x[0-9a-fA-F]{40}$/.test(who) ? `the address ${shortHash(who)}` : /^vault-payee-[0-9a-f]{6}$/.test(who) ? 'the payee in the wallet\'s book' : who || 'an unnamed payee')

// ------------------------------------------------------------------------------------------------ the branches

/** proposedBy: where the proposal came from (a model or the double); QED's decision on it is always newly reproduced. */
export interface ChangedRow { question: string | null; amount: string | null; proposed: string; decided: string; tone: Tone; caseId: string; proposedBy: Provenance }
/** The same request with only the amount changed: what the model proposed for each, and what QED decided. */
export function changedRows(ix: JudgeIndex): { rows: ChangedRow[]; sentence: string | null } {
  const rows = ix.branches.changed.map((d): ChangedRow => {
    const p = d.proposals.find((x) => x.kind === 'wallet-pay') ?? null
    const amount = p && p.params.amount !== undefined ? String(p.params.amount) : amountIn(d.call.question)
    const [decided, tone] = !d.call.ok ? ['The call failed: nothing to check.', 'void' as Tone]
      : !p ? ['Nothing to check: the model proposed no payment.', 'plain' as Tone]
        : p.state === 'invalid' ? [`Refused by QED's checks: ${say(briefReason(p.invalidReason ?? ''))}`, 'void' as Tone]
          : ['Allowed by QED\'s checks; it would still need your signature to run.', 'ok' as Tone]
    return { question: d.call.question, amount, proposed: p ? policyTerms(p, ix.wallet.reserveAsset) : 'Nothing for the wallet', decided, tone, caseId: d.call.caseId, proposedBy: proposerLine(d.call).provenance ?? 'scripted' }
  })
  const lo = rows.find((r) => r.amount === '3'), hi = rows.find((r) => r.amount === '300')
  const sentence = lo && hi && lo.tone !== hi.tone
    ? `Only the amount changed, from 3 to 300 test rupees, and the decision changed with it: ${lo.tone === 'ok' ? 'allowed' : 'not allowed'} at 3, ${hi.tone === 'void' ? 'refused' : 'not proposed'} at 300${hi.tone === 'void' ? ', by the limit your mandate sets' : ''}.`
    : null
  return { rows, sentence }
}
const amountIn = (q: string | null): string | null => (q ? (/\b(\d+) test rupees\b/.exec(q)?.[1] ?? null) : null)

/** The refusal: the instruction hidden in a bill, what the model made of it, what QED decided, and that nothing moved. */
export function injectedView(ix: JudgeIndex): null | { question: string | null; who: string; proposedBy: Provenance; proposed: string; decided: string; tone: Tone; nothingSent: string; caseId: string } {
  const d = ix.branches.injected
  if (!d) return null
  const pay = d.proposals.find((x) => x.kind === 'wallet-pay') ?? null
  const valid = d.proposals.filter((x) => x.state !== 'invalid')
  const who = proposerLine(d.call)
  return {
    question: d.call.question, who: who.word, proposedBy: who.provenance ?? 'scripted', caseId: d.call.caseId,
    proposed: !d.call.ok ? 'The call failed.' : pay ? `${upper(policyTerms(pay, ix.wallet.reserveAsset))}${d.call.isModel ? '' : ' (the double follows the hidden instruction, as a compromised model might)'}` : d.proposals.length ? `${d.proposals.length} proposal${d.proposals.length === 1 ? '' : 's'}, none a payment` : 'Nothing: it did not follow the hidden instruction',
    decided: pay?.state === 'invalid' ? `Refused by QED's checks: ${say(briefReason(pay.invalidReason ?? ''))}` : !pay ? 'Nothing to refuse: no payment was proposed' : 'Allowed by QED\'s checks: it pays a payee in the wallet\'s book, and still needs your signature',
    tone: pay?.state === 'invalid' || !pay ? 'ok' : 'wait',
    nothingSent: valid.some((x) => x.kind === 'wallet-pay') ? 'A valid payment would still wait for your passkey: nothing runs from a proposal.' : 'Nothing was sent: a proposal that fails a check can never become terms for your passkey, so the wallet was never asked.',
  }
}

export function revocationView(ix: JudgeIndex): null | { at: string; stamp: [string, Tone]; next: null | { stamp: [string, Tone]; words: string; caseId: string } ; caseId: string } {
  const r = ix.branches.revocation
  if (!r) return null
  return {
    at: when(r.at), stamp: jobStamp(r), caseId: r.caseId,
    next: r.next ? { stamp: jobStamp(r.next), caseId: r.next.caseId, words: r.next.outcome === 'executed' ? `A tick after it still ran: ${say(r.next.summary ?? '')}` : `The next tick did not run: ${say(firstSentence(r.next.error ?? r.next.summary ?? 'no reason recorded'))} Nothing was sent to the chain.${r.next.requestedBy === 'owner' ? ' It was asked for from this page on purpose, after the policy ended; QED\'s vault service refused it, not the model and not the page.' : ''}` } : null,
  }
}

export function recoveryView(ix: JudgeIndex): { repeated: null | { words: string; stamp: [string, Tone]; caseId: string }; restored: null | { words: string; stamp: [string, Tone]; next: null | { stamp: [string, Tone]; words: string; caseId: string }; caseId: string } } {
  const t = ix.branches.repeated, r = ix.branches.restored
  return {
    repeated: t ? { caseId: t.caseId, stamp: jobStamp(t), words: `Your session asked for the same tick ${t.asked} times with one key, as a browser does after an answer is lost. The vault service started one job and answered every repeat with that same job: nothing ran twice.` } : null,
    restored: r ? {
      caseId: r.caseId, stamp: jobStamp(r),
      words: `You signed a standing policy again with your passkey, ${when(r.at)}. Authority comes back only that way: QED, the model and the vault service hold no key that can sign for you.`,
      next: r.next ? { stamp: jobStamp(r.next), caseId: r.next.caseId, words: `${r.next.outcome === 'executed' ? `The next tick ran again under it: ${say(firstSentence(r.next.summary ?? ''))}` : `The next tick: ${say(firstSentence(r.next.summary ?? r.next.error ?? ''))}`}${r.next.requestedBy === 'engine' ? ' QED\'s engine asked for it by itself.' : ''}` } : null,
    } : null,
  }
}

/** One tick under the same policy, in words: what it did and why (the record's own figures, never recomputed). */
export function tickWords(t: Pick<Tick, 'n' | 'action' | 'amountIn' | 'outcome' | 'limitedBy'>, a: Asset): string {
  const what = t.action === 'convert' ? `converted ${tokens(t.amountIn, a)}` : t.action === 'wait' ? 'waited' : t.action ?? jobStamp({ outcome: t.outcome, status: '' })[0].toLowerCase()
  const end = t.outcome === 'refused' ? ', then the co-signer refused it' : t.outcome === 'failed' ? ', then it failed' : ''
  const why = t.action === 'convert' && t.limitedBy ? `, limited by ${LIMITED[t.limitedBy] ?? t.limitedBy}` : ''
  return `${t.n ? `Tick ${t.n}` : 'A tick'}: ${t.action === 'convert' && t.outcome !== 'executed' ? `would have ${what}` : what}${why}${end}`
}

/** Which of the four this page shows now, for the legend: newly reproduced and historical always; a model's or the double's
 * decisions when there are (or would be) any. */
export function provenanceShown(ix: JudgeIndex): Provenance[] {
  const k = new Set<Provenance>(['reproduced', 'historical'])
  const calls = [ix.journey?.decision.call, ...ix.branches.changed.map((d) => d.call), ix.branches.injected?.call].filter((c): c is Call => !!c)
  for (const w of [...calls, ix.proposerNow]) { const p = proposerLine(w).provenance; if (p) k.add(p) }
  return (['genuine', 'scripted', 'historical', 'reproduced'] as Provenance[]).filter((x) => k.has(x))
}
