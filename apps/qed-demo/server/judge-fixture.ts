/**
 * Records for the judge's walk-through tests (server/judge.test.ts, src/screens/judge-view.test.ts): a household's model
 * calls, wallet proposals and vault records, shaped as the stack writes and the vault service answers them (read from a
 * design-fixture stack and the API judge journey's recorded cases on 24 Nov 2026). Each stage adds what the walk-through
 * would have produced by then, so a test can ask for the records "after the tick" or "after the revocation".
 */
import { JUDGE_QUESTIONS } from '../shared/judge.ts'
import type { CallRow, JudgeRecords, ProposalRow } from './judge.ts'

type Json = Record<string, unknown>
export type Stage = 'fresh' | 'mandate' | 'asked' | 'signed' | 'ticked' | 'revoked' | 'restored'
const ORDER: Stage[] = ['fresh', 'mandate', 'asked', 'signed', 'ticked', 'revoked', 'restored']
export const T0 = Date.parse('2026-11-24T07:00:00.000Z')
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString()
export const IDS = {
  mandateJob: '11111111-1111-4111-8111-111111111111', policyJob: '22222222-2222-4222-8222-222222222222', tick: '33333333-3333-4333-8333-333333333333',
  refusedTick: '44444444-4444-4444-8444-444444444444', revokeJob: '55555555-5555-4555-8555-555555555555', afterRevoke: '66666666-6666-4666-8666-666666666666',
  againJob: '77777777-7777-4777-8777-777777777777', afterAgain: '88888888-8888-4888-8888-888888888888',
  call: 'aic_objective0001', payLowCall: 'aic_paylow00001', payHighCall: 'aic_payhigh0001', injectedCall: 'aic_injected001',
  proposal: 'prp_policy000001', vaultProposal: 'vp-policy-0001', txHash: '0xae12760dbddd856b51cb52346ac4e3afc1fcfc88b11b23414a957c33bc56a1e1',
}
const CHECKS = [
  { name: 'vault-available', pass: true, detail: 'The vault service answered with this household\'s vault.' },
  { name: 'parameters', pass: true, detail: 'The parameters have the shape of policy.' },
  { name: 'mandate-active', pass: true, detail: 'Mandate v1 is active: every tranche stays within 250.00 tINR and its period and lifetime limits.' },
  { name: 'reserve-target-range', pass: true, detail: 'A reserve target of 10 tUSD is between 2 and 80, the range the vault accepts.' },
]

export interface FixtureOptions {
  stage: Stage
  /** Who answered Ask: the scripted double (default) or a real model through the command-line client. */
  provider?: 'scripted' | 'claude-cli'
  /** The first tick under the policy: executed (default) or refused by the co-signer. */
  tick?: 'executed' | 'refused'
  /** Ask the changed-input pair and the bill with the hidden instruction too. */
  branches?: boolean
  /** The owner's session asked for the first tick twice with one key. */
  repeated?: boolean
  /** Who asked for the first tick and the tick after authority came back: QED's engine (default, R13) or the owner's session. */
  tickAskedBy?: 'engine' | 'owner'
}

export function judgeRecords(o: FixtureOptions): JudgeRecords {
  const reached = (s: Stage): boolean => ORDER.indexOf(o.stage) >= ORDER.indexOf(s)
  const provider = o.provider ?? 'scripted', model = provider === 'scripted' ? 'scripted-test-double' : 'claude-opus-5-5'
  const calls: CallRow[] = [], proposals: ProposalRow[] = []
  const call = (id: string, question: string, min: number): void => { calls.unshift({ id, ts: T0 + min * 60_000, provider, model, ok: 1, question, conversation_id: `cnv_${id}`, error: null }) }
  const prop = (id: string, callId: string, min: number, kind: string, state: string, params: Json, extra: { reason?: string; drafts?: Json[]; title?: string; checks?: Json[] } = {}): void => {
    proposals.unshift({ id, ai_call_id: callId, ts: T0 + min * 60_000, kind, title: extra.title ?? 'Keep 10 test dollars in the dollar reserve', rationale: 'A standing policy that keeps the reserve topped up from the treasury.', params_json: JSON.stringify({ params, runMode: null, authority: null }), analysis_json: JSON.stringify({ wallet: { railKind: kind.replace('wallet-', ''), checks: extra.checks ?? CHECKS, raw: params, drafts: extra.drafts ?? [] } }), state, invalid_reason: extra.reason ?? null })
  }
  if (reached('asked')) {
    call(IDS.call, JUDGE_QUESTIONS.objective, 2)
    prop(IDS.proposal, IDS.call, 2, 'wallet-policy', reached('signed') ? 'drafted' : 'new', { targetFree: '10' }, { drafts: reached('signed') ? [{ at: T0 + 3 * 60_000, ok: true, vaultProposalId: IDS.vaultProposal, approvalId: 'apr_policy' }] : [] })
  }
  if (o.branches && reached('asked')) {
    call(IDS.payLowCall, JUDGE_QUESTIONS.payLow, 10)
    prop('prp_paylow000001', IDS.payLowCall, 10, 'wallet-pay', 'new', { payee: 'CloudCo', amount: '3' }, { title: 'Pay 3 test rupees from the vault', checks: [{ name: 'vault-limits', pass: true, detail: 'The vault\'s own limit check allows 3 tINR.' }] })
    call(IDS.payHighCall, JUDGE_QUESTIONS.payHigh, 11)
    if (provider === 'scripted') prop('prp_payhigh00001', IDS.payHighCall, 11, 'wallet-pay', 'invalid', { payee: 'vault-payee-1a2b3c', amount: '300' }, { title: 'Pay 300 test rupees', reason: 'The vault\'s own limit check refuses 300 tINR: Per-payment limit in the owner\'s signed mandate (the same limit as per conversion) (250.00 tINR left).', checks: [{ name: 'payee-in-book', pass: true, detail: 'vault-payee-1a2b3c is a payee of the vault\'s book.' }, { name: 'vault-limits', pass: false, detail: 'The vault\'s own limit check refuses 300 tINR: Per-payment limit in the owner\'s signed mandate (the same limit as per conversion) (250.00 tINR left).' }] })
    call(IDS.injectedCall, JUDGE_QUESTIONS.injected, 12)
    if (provider === 'scripted') prop('prp_injected0001', IDS.injectedCall, 12, 'wallet-pay', 'invalid', { payee: '0x000000000000000000000000000000000000dEaD', amount: '50' }, { title: 'Send 50 test rupees as the bill asks', reason: '"0x000000000000000000000000000000000000dEaD" is not a payee of the vault\'s book: it has 3 payees, given to the model as tokens. A payment or a promise can go only to one of them.', checks: [{ name: 'payee-in-book', pass: false, detail: '"0x000000000000000000000000000000000000dEaD" is not a payee of the vault\'s book.' }] })
  }

  const jobs: Json[] = [], decisions: Json[] = [], ticks: Json[] = []
  const job = (id: string, kind: string, min: number, outcome: string, extra: Json = {}): void => {
    jobs.unshift({ id, kind, status: outcome === 'failed' ? 'failed' : 'done', createdAt: at(min), finishedAt: at(min + 0.1), proposalId: extra.proposalId ?? null, steps: extra.steps ?? [], result: outcome === 'failed' ? null : { outcome, summary: extra.summary ?? `${kind} ${outcome}`, ...(extra.tx ? { tx: extra.tx } : {}) }, error: extra.error ?? null })
  }
  const decision = (n: number, kind: string, jobId: string, record: Json): void => { decisions.unshift({ n, at: at(n), kind, jobId, verdict: 'SIGNED', record }) }
  const tickSteps = (outcome: string): Json[] => outcome === 'executed'
    ? [{ key: 'decide', label: 'Agent decides', status: 'ok', detail: 'Reserve has 0.00 tUSD free, short 10.00. X = 250.00 tINR, limited by mandate cap.' }, { key: 'cosigner', label: 'Co-signer', status: 'ok', detail: '15 checks, including the shortfall, the tranche rule and the execution cost.' }, { key: 'plan', label: 'Plan', status: 'ok', detail: 'Expected 2.974112 tUSD, bound 2.974113.' }, { key: 'submit', label: 'Submit', status: 'ok', detail: `Broadcast acknowledged. Transaction ${IDS.txHash}; awaiting mined receipt.` }, { key: 'receipt', label: 'Receipt', status: 'ok', detail: 'Block 60, 363,564 gas. 250.00 tINR → 2.974112 tUSD, bound 2.974113.' }, { key: 'reconcile', label: 'Reconcile', status: 'ok', detail: 'Free tUSD 0.00 → 2.974112 (target 10.00).' }]
    : [{ key: 'decide', label: 'Agent decides', status: 'ok', detail: 'Reserve has 0.00 tUSD free, short 10.00.' }, { key: 'cosigner', label: 'Co-signer', status: 'refused', detail: 'Refused: C12 not met: Authority budget (R7 D7): this conversion\'s cost does not fit. More detail follows.' }]
  const vaultOn = reached('mandate')
  if (vaultOn) job(IDS.mandateJob, 'mandate', 1, 'executed', { proposalId: 'vp-mandate-0001', summary: 'Owner signed mandate v1' })
  if (reached('signed')) {
    job(IDS.policyJob, 'policy', 4, 'executed', { proposalId: IDS.vaultProposal, summary: 'Owner signed a standing policy: keep ≥ 10.00 tUSD free in the dollar reserve' })
    decision(4, 'owner-policy', IDS.policyJob, { policy: { nonce: 'rail-policy-aaaa-1', targetFree: '10000000' }, sequence: 1 })
  }
  if (reached('ticked')) {
    const first = o.tick ?? 'executed'
    job(IDS.tick, 'policy-tick', 6, first, { steps: tickSteps(first), summary: first === 'executed' ? 'Converted 250.00 tINR → 2.974112 tUSD; bound 2.974113.' : 'Co-signer refused: C12 not met: Authority budget.', ...(first === 'executed' ? { tx: { hash: IDS.txHash, block: 60, status: 'success' } } : {}) })
    decision(6, 'policy-decision', IDS.tick, { policyNonce: 'rail-policy-aaaa-1', tick: 1 })
    ticks.unshift({ jobId: IDS.tick, n: 1, action: 'convert', amountIn: '25000', limitedBy: 'mandate cap', reason: 'convert 25000 now (limited by mandate cap)', outcome: first })
    if (first === 'executed') {
      job(IDS.refusedTick, 'policy-tick', 8, 'refused', { steps: tickSteps('refused'), summary: 'Co-signer refused: C12 not met: Authority budget.' })
      decision(8, 'policy-decision', IDS.refusedTick, { policyNonce: 'rail-policy-aaaa-1', tick: 2 })
      ticks.unshift({ jobId: IDS.refusedTick, n: 2, action: 'convert', amountIn: '25000', limitedBy: 'mandate cap', reason: 'convert 25000 now (limited by mandate cap)', outcome: 'refused' })
    }
  }
  if (reached('revoked')) {
    job(IDS.revokeJob, 'policy-revoke', 20, 'executed', { proposalId: 'vp-revoke-0001', summary: 'Owner revoked the standing policy' })
    job(IDS.afterRevoke, 'policy-tick', 21, 'failed', { error: 'No standing policy yet: the owner must sign one first.' })
  }
  if (reached('restored')) {
    job(IDS.againJob, 'policy', 25, 'executed', { proposalId: 'vp-policy-0002', summary: 'Owner signed a standing policy: keep ≥ 10.00 tUSD free in the dollar reserve' })
    decision(25, 'owner-policy', IDS.againJob, { policy: { nonce: 'rail-policy-aaaa-2', targetFree: '10000000' }, sequence: 2 })
    job(IDS.afterAgain, 'policy-tick', 26, 'executed', { steps: tickSteps('executed'), summary: 'Converted 250.00 tINR → 2.971754 tUSD; bound 2.971755.', tx: { hash: `0x${'b'.repeat(64)}`, block: 75, status: 'success' } })
    decision(26, 'policy-decision', IDS.afterAgain, { policyNonce: 'rail-policy-aaaa-2', tick: 1 })
  }
  const state: Json = {
    provisioned: reached('mandate') || o.stage === 'fresh', network: { chainId: 31337, name: 'Local Anvil chain 31337 · valueless test tokens' },
    ...(vaultOn ? { mandate: { version: 1, status: 'active', signedAt: at(1), purposeText: 'Convert surplus tINR into the dollar reserve and pay approved payees', fields: { maxPerPayment: '25000', maxPerPeriod: '60000', maxTotal: '200000', period: '86400', validUntil: String(Math.round(T0 / 1000) + 7 * 86_400) } } } : {}),
    ...(reached('signed') ? { policy: { status: reached('revoked') && !reached('restored') ? 'revoked' : 'active', targetFree: '10000000', signedAt: at(reached('restored') ? 25 : 4), nonce: reached('restored') ? 'rail-policy-aaaa-2' : 'rail-policy-aaaa-1', ticks: ticks.length } } : {}),
  }
  return {
    calls, proposals, askers: Object.fromEntries(calls.map((c) => [c.conversation_id!, 'person-a'])),
    vault: { unreachable: null, overview: { available: true, setUp: true, state, workspace: { asset: { symbol: 'tINR', decimals: 2 }, reserveAsset: { symbol: 'tUSD', decimals: 6 } } }, jobs, decisions, ticks, verify: { ok: true, records: decisions.length, brokenAt: null, head: 'c8d990' } },
    engineAsked: { ...(reached('ticked') ? { [IDS.refusedTick]: T0 + 8 * 60_000, ...(o.tickAskedBy === 'owner' ? {} : { [IDS.tick]: T0 + 6 * 60_000 }) } : {}), ...(reached('restored') && o.tickAskedBy !== 'owner' ? { [IDS.afterAgain]: T0 + 26 * 60_000 } : {}) },
    ownerAsked: { ...(reached('ticked') && (o.tickAskedBy === 'owner' || o.repeated) ? { [IDS.tick]: o.repeated ? [T0 + 6 * 60_000, T0 + 7 * 60_000] : [T0 + 6 * 60_000] } : {}), ...(reached('revoked') ? { [IDS.afterRevoke]: [T0 + 21 * 60_000] } : {}), ...(reached('restored') && o.tickAskedBy === 'owner' ? { [IDS.afterAgain]: [T0 + 26 * 60_000] } : {}) },
  }
}
