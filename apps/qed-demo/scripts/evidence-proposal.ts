/**
 * Trace one model-proposed instruction from the owner's question to a receipt, from recorded rows only.
 *
 *   node scripts/evidence-proposal.ts <instruction id> [output.json]
 *
 * For an instruction that began as a proposal it prints, in order: the model call (provider, model, latency, the
 * owner's question and the fingerprint of the context sent), the proposal as stored after validation, the signed
 * version and its approval, each run with its approval, each action with the time of every stage, and the receipt.
 * Nothing is modified. The model's reply text is not copied out; its length and proposal count are.
 */
import { writeFileSync } from 'node:fs'
import { loadConfig, openDb, parse } from '../server/core.ts'
import { verifyChain } from '../server/receipts.ts'

const id = process.argv[2]
const out = process.argv[3] ?? 'proposal-path.json'
if (!id) { console.error('usage: node scripts/evidence-proposal.ts <instruction id> [output.json]'); process.exit(2) }
const db = openDb(loadConfig().dbPath)
const ist = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST'))
type Row = Record<string, any>

const prog = db.get<Row>('SELECT * FROM programs WHERE id = ?', id)
if (!prog) { console.error(`no instruction ${id}`); process.exit(1) }
const proposalId = String(prog.origin ?? '').startsWith('proposal:') ? String(prog.origin).slice(9) : null
const proposal = proposalId ? db.get<Row>('SELECT * FROM proposals WHERE id = ?', proposalId) : undefined
const call = proposal?.ai_call_id ? db.get<Row>('SELECT * FROM ai_calls WHERE id = ?', proposal.ai_call_id) : undefined
const versions = db.all<Row>('SELECT version, state, content_hash, approval_id, approved_at, authority_json, params_json FROM program_versions WHERE program_id = ? ORDER BY version', id)
const approval = (aid: string | null): Row | null => { const a = aid ? db.get<Row>('SELECT id, purpose, subject, doc_hash, method, created_at, confirmed_at, consumed_at, requires_stepup FROM approvals WHERE id = ?', aid) : undefined; return a ? { id: a.id, purpose: a.purpose, subject: a.subject, documentHash: a.doc_hash, method: a.method, passwordRequired: a.requires_stepup === 1, asked: ist(a.created_at), confirmed: ist(a.confirmed_at), used: ist(a.consumed_at) } : null }
const output = call?.output_json ? parse<{ answer?: string; proposals?: unknown[] }>(call.output_json, {}) : {}

const report = {
  what: 'One model-proposed instruction, from the owner\'s question to a receipt',
  producedAt: ist(Date.now()),
  howToReproduce: `node scripts/evidence-proposal.ts ${id}`,
  '1 question and model call': call ? { callId: call.id, at: ist(call.ts), provider: call.provider, model: call.model, latencyMs: call.latency_ms, ok: call.ok === 1, question: call.question, contextFingerprint: call.context_hash, replyCharacters: (output.answer ?? '').length, proposalsReturned: (output.proposals ?? []).length, usage: parse<Row>(call.usage_json, {}) } : 'not a model proposal',
  '2 proposal as stored after validation': proposal ? { id: proposal.id, origin: proposal.origin, kind: proposal.kind, title: proposal.title, state: proposal.state, invalidReason: proposal.invalid_reason, ...parse<Row>(proposal.params_json, {}), warnings: parse<{ warnings?: string[] }>(proposal.analysis_json, {}).warnings ?? [] } : null,
  '3 instruction and signed versions': { id: prog.id, kind: prog.kind, title: prog.title, state: prog.state, origin: prog.origin, versions: versions.map((v) => ({ version: v.version, state: v.state, documentHash: v.content_hash, signed: ist(v.approved_at), authority: parse<Row>(v.authority_json, {}), params: parse<Row>(v.params_json, {}), approval: approval(v.approval_id) })) },
  '4 runs': db.all<Row>('SELECT * FROM runs WHERE program_id = ? ORDER BY due_at', id).map((r) => {
    const runApproval = db.get<Row>(`SELECT id FROM approvals WHERE subject = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1`, `run:${String(r.id)}`)
    return {
      id: r.id, due: ist(r.due_at), claimed: ist(r.created_at), started: ist(r.started_at), finished: ist(r.finished_at), outcome: r.state, reason: r.reason, approval: approval(runApproval?.id ?? null),
      actions: db.all<Row>('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at', String(r.id)).map((a) => {
        const t = parse<Record<string, number>>(a.times_json, {}), res = parse<Row>(a.result_json, {}), pol = parse<{ checks?: { name: string; ok: boolean }[] }>(a.policy_json, {})
        const rc = a.receipt_id ? db.get<Row>('SELECT id, seq, ts, hash, prev_hash FROM receipts WHERE id = ?', a.receipt_id) : undefined
        return {
          id: a.id, outcome: a.state, reference: a.economic_id, venue: a.venue,
          checks: { passed: (pol.checks ?? []).filter((c) => c.ok).length, failed: (pol.checks ?? []).filter((c) => !c.ok).map((c) => c.name) },
          times: { asked: ist(a.created_at), decided: ist(t.decided), submitted: ist(t.submitted), executed: ist(t.executed), finished: ist(t.finished), reconciled: ist(t.reconciled) },
          latencyMs: { askedToDecided: t.decided ? t.decided - a.created_at : null, decidedToSubmitted: t.submitted && t.decided ? t.submitted - t.decided : null, submittedToExecuted: t.executed && t.submitted ? t.executed - t.submitted : null, askedToReconciled: t.reconciled ? t.reconciled - a.created_at : null },
          result: { filledQuantityAtoms: res.filledQty ?? null, movedPaise: res.movedPaise ?? null, feesPaise: res.fees ?? null, taxesPaise: res.taxes ?? null, venueState: res.venueState ?? res.railState ?? null },
          ledgerEntries: db.all<Row>(`SELECT seq, kind, memo FROM entries WHERE user_id = ? AND meta_json LIKE ? ORDER BY seq`, a.user_id, `%"actionId":"${String(a.id)}"%`),
          comparedWithVenue: a.recon_state,
          receipt: rc ? { id: rc.id, number: rc.seq, issued: ist(rc.ts), fingerprint: rc.hash, follows: rc.prev_hash } : null,
        }
      }),
    }
  }),
  '5 receipt chain for this owner': (() => { const c = verifyChain(db, String(prog.user_id)); return { intact: c.ok, receipts: c.count, brokenAt: c.brokenAt } })(),
}
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
db.close()
console.log(`[evidence] ${out}: ${call ? `${String(call.model)} in ${String(call.latency_ms)} ms` : 'no model call'}; proposal ${proposal ? String(proposal.state) : 'none'}; ${report['4 runs'].length} runs; receipts ${report['4 runs'].flatMap((r) => r.actions).filter((a) => a.receipt).length}`)
