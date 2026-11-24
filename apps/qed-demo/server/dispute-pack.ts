/**
 * A dispute pack: what a person would hand a bank, a merchant or an ombudsman for a payment whose outcome is disputed or
 * uncertain (the mandate omissions audit, finding S6). Assembled from QED's own records, read only, never changed by being
 * read, and the same each time it is read for as long as the records are the same.
 *
 *   approval     the signed approval document the passkey signed, its hash, who signed and when (or, for an instruction's
 *                payment, the signed instruction version it ran under)
 *   receipts     every receipt about the payment, each with its hash and the hash before it, and whether the person's whole
 *                receipt chain still verifies
 *   timeline     requested, approved, held, released, sent, the bank's reference, settled or failed, and each dispute step
 *   payee        the payee as signed in the approval (name, address, the name check's answer), and the payee as QED holds it now
 *   bank         the paper rail's own record: rail, state, reason and the paper reference
 *
 * A payment qualifies when a dispute was opened for it, or its outcome is not known: the rail's answer is "unknown" or is
 * overdue, reconciliation found a break, or the payment failed after money was set aside. Every institution here is simulated
 * and the pack says so on its face: it is not evidence of any real payment, and its references are the paper bank's own.
 */
import { type Db, notFound, parse, refused } from './core.ts'
import { verifyChain } from './receipts.ts'
import { listPauses } from './dispute-pause.ts'
import { deadlinesFor, escalationFor } from './dispute-deadlines.ts'
import type { Deadline } from './dispute-deadlines.ts'
import { getProfile, jurisdictionOf } from './household.ts'
import { packDigest, PACK_FORMAT } from './dispute-pack-verify.ts'
import type { PaymentParams } from './types.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

export type PackReason = 'disputed' | 'unknown-outcome' | 'overdue' | 'reconciliation-break' | 'failed'
export const PACK_REASON: Record<PackReason, string> = {
  disputed: 'A dispute was opened for this payment.', 'unknown-outcome': 'The paper rail has not said whether this payment went through.', overdue: 'The paper rail has not answered by the time it said it would.',
  'reconciliation-break': 'Reconciliation found that the ledger and the paper rail do not agree about this payment.', failed: 'The payment failed after money was set aside for it.',
}
export const SIMULATED = 'Simulated: the paper bank, the paper rail and every reference below are QED\'s local simulation. No real money moved, and this pack is not evidence of a real payment.'

type Row = Record<string, unknown>
export interface TimelineStep { at: number; iso: string; step: string; detail: string }
export interface NoticeDraft { label: string; to: string; subject: string; text: string; sentBy: 'you'; qedSends: false }
export interface DisputePack {
  v: 1; format: 'qed-dispute-pack/v1'; simulated: true; notice: string; generatedFrom: 'QED records at the time of reading'
  reason: PackReason; reasonText: string
  payment: { actionId: string; economicId: string; state: string; amount: string; charge: string; payeeName: string; payeeHandle: string; purpose: string; memo: string | null; origin: string }
  approval: { id: string; docHash: string; method: string | null; confirmedAt: number | null; document: unknown; signatures: { person: string; credentialId: string; signedAt: number }[] } | { instruction: { programId: string; version: number; contentHash: string | null; approvedAt: number | null }; note: string } | null
  receipts: { id: string; seq: number; kind: string; at: number; hash: string; prevHash: string; body: unknown }[]
  receiptChain: { verified: boolean; count: number; brokenAt: number | null; head: string }
  timeline: TimelineStep[]
  payee: { asSigned: { name: string; handle: string; nameCheck: string | null }; now: { name: string; handle: string; addedAt: number; nameCheck: string | null; registeredName: string | null } | null; changedSinceSigned: boolean }
  bank: { simulated: true; institution: 'paper rail'; rail: string | null; state: string | null; reason: string | null; reference: string | null; sentAt: number | null; answeredBy: number | null } | null
  disputes: { id: string; state: string; reason: string; resolution: string | null; openedAt: number; updatedAt: number }[]
  /** QED's own activity on the account: paused when the problem was reported, until the person releases it. */
  pauses: { id: string; scope: string; startedAt: number; startedIso: string; releasedAt: number | null; releasedIso: string | null; releasedBy: string | null }[]
  jurisdiction: string
  deadlines: Deadline[]
  escalation: { text: string; source: string }
  draftNotice: NoticeDraft
  integrity: { algorithm: 'sha256'; sha256: string; covers: string }
}

/** Why this payment qualifies for a pack, or null. */
export function packReason(db: Db, userId: string, actionId: string, now: number): PackReason | null {
  const a = db.get<Row>(`SELECT * FROM actions WHERE id = ? AND user_id = ? AND kind = 'payment'`, actionId, userId)
  if (!a) return null
  if (db.get('SELECT 1 FROM disputes WHERE action_id = ? AND user_id = ?', actionId, userId)) return 'disputed'
  const pay = db.get<{ state: string; resolve_at: number | null }>('SELECT state, resolve_at FROM pv_payments WHERE client_ref = ? AND user_id = ?', String(a.economic_id), userId)
  if (pay?.state === 'unknown') return 'unknown-outcome'
  const result = parse<{ answerBy?: number }>(String(a.result_json), {})
  if (a.state === 'working' && typeof result.answerBy === 'number' && now > result.answerBy) return 'overdue'
  if (a.recon_state === 'break') return 'reconciliation-break'
  if (a.state === 'failed' && db.get(`SELECT 1 FROM entries WHERE user_id = ? AND ref = ?`, userId, `pay:${String(a.economic_id)}:out`)) return 'failed'
  return null
}

export function disputePack(db: Db, userId: string, actionId: string, now: number): DisputePack {
  const a = db.get<Row>(`SELECT * FROM actions WHERE id = ? AND user_id = ? AND kind = 'payment'`, actionId, userId)
  if (!a) throw notFound('That payment')
  const reason = packReason(db, userId, actionId, now)
  if (!reason) throw refused('no_dispute_pack', 'A dispute pack is for a payment that is disputed or whose outcome is not known. This one is neither.')
  const p = parse<PaymentParams>(String(a.params_json), {} as PaymentParams)
  const times = parse<Record<string, number>>(String(a.times_json), {})
  const result = parse<Record<string, unknown>>(String(a.result_json), {})
  const ap = a.approval_id ? db.get<Row>('SELECT * FROM approvals WHERE id = ? AND user_id = ?', String(a.approval_id), userId) : undefined
  const signatures = ap ? db.all<{ person_id: string; credential_id: string; signed_at: number }>('SELECT person_id, credential_id, signed_at FROM approval_signatures WHERE approval_id = ? ORDER BY signed_at', String(ap.id)).map((s) => ({ person: s.person_id, credentialId: s.credential_id, signedAt: s.signed_at })) : []
  let approval: DisputePack['approval'] = null
  if (ap) approval = { id: String(ap.id), docHash: String(ap.doc_hash), method: (ap.method as string | null) ?? null, confirmedAt: (ap.confirmed_at as number | null) ?? null, document: parse<unknown>(String(ap.document), null), signatures }
  else if (a.program_id && a.run_id) {
    const run = db.get<{ version: number }>('SELECT version FROM runs WHERE id = ?', String(a.run_id))
    const v = run ? db.get<{ content_hash: string | null; approved_at: number | null }>('SELECT content_hash, approved_at FROM program_versions WHERE program_id = ? AND version = ?', String(a.program_id), run.version) : undefined
    if (run) approval = { instruction: { programId: String(a.program_id), version: run.version, contentHash: v?.content_hash ?? null, approvedAt: v?.approved_at ?? null }, note: 'Paid by an instruction you signed. The signed terms of that instruction version are identified by this hash; the payment itself carried no separate approval.' }
  }
  const disputes = db.all<{ id: string; state: string; reason: string; resolution: string | null; created_at: number; updated_at: number }>('SELECT id, state, reason, resolution, created_at, updated_at FROM disputes WHERE action_id = ? AND user_id = ? ORDER BY created_at', actionId, userId)
  const rcpts = db.all<{ id: string; seq: number; kind: string; ts: number; hash: string; prev_hash: string; body_json: string }>(
    `SELECT id, seq, kind, ts, hash, prev_hash, body_json FROM receipts WHERE user_id = ? AND (subject = ? ${disputes.length ? `OR subject IN (${disputes.map(() => '?').join(',')})` : ''}) ORDER BY seq`, userId, actionId, ...disputes.map((d) => d.id))
  const chain = verifyChain(db, userId)
  const rail = db.get<{ rail: string; state: string; reason: string | null; reference: string | null; created_at: number }>('SELECT rail, state, reason, reference, created_at FROM pv_payments WHERE client_ref = ? AND user_id = ?', String(a.economic_id), userId)
  const y = db.get<{ name: string; handle: string; created_at: number; name_check: string | null; registered_name: string | null }>('SELECT name, handle, created_at, name_check, registered_name FROM payees WHERE user_id = ? AND handle = ?', userId, p.payeeHandle)
  const doc = ap ? parse<{ estimate?: { label: string; value: string }[] }>(String(ap.document), {}) : {}
  const signedCheck = doc.estimate?.find((l) => l.label === 'Name check')?.value ?? null

  const timeline: Omit<TimelineStep, 'iso'>[] = [{ at: Number(a.created_at), step: 'requested', detail: `Payment of ${homeMoneyExact(Number(p.amount))} to ${p.payeeName} (${p.payeeHandle}) asked for${a.origin === 'program' ? ' by an instruction' : ''}.` }]
  if (ap?.confirmed_at) timeline.push({ at: Number(ap.confirmed_at), step: 'approved', detail: `Approved with ${String(ap.method ?? 'a passkey')}; fingerprint ${String(ap.doc_hash).slice(0, 16)}…` })
  if (times.held) timeline.push({ at: times.held, step: 'held', detail: result.awaitingConfirmation ? 'Held for your confirmation: it repeated an earlier payment.' : 'Held until the time in its signed terms.' })
  if (typeof result.duplicateConfirmedAt === 'number') timeline.push({ at: result.duplicateConfirmedAt, step: 'confirmed', detail: 'You confirmed the repeat.' })
  if (times.released) timeline.push({ at: times.released, step: 'released', detail: 'The wait ended.' })
  if (times.submitted) timeline.push({ at: times.submitted, step: 'sent', detail: `Sent to the paper rail${rail ? ` (${rail.rail})` : ''}.` })
  if (rail?.reference) timeline.push({ at: rail.created_at, step: 'bank reference', detail: `The paper bank gave reference ${rail.reference}.` })
  if (rail && rail.state !== 'pending') timeline.push({ at: Number(times.finished ?? a.updated_at), step: rail.state === 'settled' ? 'settled' : rail.state, detail: rail.state === 'settled' ? 'The paper rail reported it settled.' : `The paper rail reported: ${rail.state}${rail.reason ? `, ${rail.reason}` : ''}.` })
  else if (a.state === 'failed' || a.state === 'rejected') timeline.push({ at: Number(times.finished ?? a.updated_at), step: 'failed', detail: String(a.error ?? 'The payment failed.') })
  for (const d of disputes) {
    timeline.push({ at: d.created_at, step: 'dispute opened', detail: d.reason })
    if (d.state !== 'open') timeline.push({ at: d.updated_at, step: `dispute ${d.state.replace('resolved_', 'resolved: ').replace('_', ' ')}`, detail: d.resolution ?? '' })
  }
  const pauses = listPauses(db, userId, actionId)
  for (const q of pauses) {
    timeline.push({ at: q.startedAt, step: 'QED paused', detail: 'You reported a problem, so QED stopped what it does on its own on this account.' })
    if (q.releasedAt !== null) timeline.push({ at: q.releasedAt, step: 'pause released', detail: 'You released the pause.' })
  }
  timeline.sort((x, z) => x.at - z.at)
  const stamped: TimelineStep[] = timeline.map((t) => ({ ...t, iso: new Date(t.at).toISOString() }))
  const jurisdiction = jurisdictionOf(getProfile(db, userId))
  const reportedAt = disputes[0]?.created_at ?? Number(a.updated_at)
  const deadlines = deadlinesFor(jurisdiction, { learnedAt: reportedAt, transactionAt: Number(a.created_at) })
  const who = db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', userId)?.display_name ?? ''
  const draftNotice = noticeDraft(who, { amount: homeMoneyExact(Number(p.amount)), payeeName: p.payeeName, payeeHandle: p.payeeHandle, paidAt: Number(a.created_at), reference: rail?.reference ?? null, reasonText: disputes[0]?.reason ?? PACK_REASON[reason], reportedAt })

  const pack: Omit<DisputePack, 'integrity'> = {
    v: 1, format: PACK_FORMAT, simulated: true, notice: SIMULATED, generatedFrom: 'QED records at the time of reading', reason, reasonText: PACK_REASON[reason],
    payment: { actionId, economicId: String(a.economic_id), state: String(a.state), amount: p.amount, charge: p.charge ?? '0', payeeName: p.payeeName, payeeHandle: p.payeeHandle, purpose: p.purpose, memo: p.memo ?? null, origin: String(a.origin) },
    approval,
    receipts: rcpts.map((r) => ({ id: r.id, seq: r.seq, kind: r.kind, at: r.ts, hash: r.hash, prevHash: r.prev_hash, body: parse<unknown>(r.body_json, null) })),
    receiptChain: { verified: chain.ok, count: chain.count, brokenAt: chain.brokenAt, head: chain.head },
    timeline: stamped,
    payee: { asSigned: { name: p.payeeName, handle: p.payeeHandle, nameCheck: signedCheck }, now: y ? { name: y.name, handle: y.handle, addedAt: y.created_at, nameCheck: y.name_check, registeredName: y.registered_name } : null, changedSinceSigned: !y || y.name !== p.payeeName },
    bank: rail ? { simulated: true, institution: 'paper rail', rail: rail.rail, state: rail.state, reason: rail.reason, reference: rail.reference, sentAt: rail.created_at, answeredBy: typeof result.answerBy === 'number' ? result.answerBy : null } : null,
    disputes: disputes.map((d) => ({ id: d.id, state: d.state, reason: d.reason, resolution: d.resolution, openedAt: d.created_at, updatedAt: d.updated_at })),
    pauses: pauses.map((q) => ({ id: q.id, scope: q.scope, startedAt: q.startedAt, startedIso: new Date(q.startedAt).toISOString(), releasedAt: q.releasedAt, releasedIso: q.releasedAt === null ? null : new Date(q.releasedAt).toISOString(), releasedBy: q.releasedBy })),
    jurisdiction, deadlines, escalation: escalationFor(jurisdiction), draftNotice,
  }
  return { ...pack, integrity: { algorithm: 'sha256', sha256: packDigest(pack), covers: 'Every field of this pack except this block, in canonical form. Verify offline with scripts/verify-dispute-pack.ts.' } }
}

/**
 * The notice a person may send their account provider, drafted by QED from the pack's records. QED never sends it: the person
 * sends it themselves, through their provider's own channel, and the provider decides. It asks for an investigation and an answer;
 * it claims no right and no outcome.
 */
export function noticeDraft(name: string, d: { amount: string; payeeName: string; payeeHandle: string; paidAt: number; reference: string | null; reasonText: string; reportedAt: number }): NoticeDraft {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  const text = [
    `To: my account provider, through its own channel for reporting a problem`,
    `Date: ${day(d.reportedAt)}`,
    ``,
    `I am writing to report a problem with a payment from my account.`,
    ``,
    `Payment: ${d.amount} to ${d.payeeName} (${d.payeeHandle}), requested on ${day(d.paidAt)}${d.reference ? `, your reference ${d.reference}` : ''}.`,
    `What went wrong, in my words: ${d.reasonText}`,
    ``,
    `Please investigate, tell me in writing that you have received this notice and when, and tell me what you need from me and by when. I have attached a record of the payment with its approval, receipts and timeline. Please tell me the outcome and the reasons for it, and how to escalate if I disagree.`,
    ``,
    `${name || '[your name]'}`,
  ].join('\n')
  return { label: 'A draft written by QED. QED sends nothing to your bank: you send it yourself, through your bank\'s own channel, and your bank decides.', to: 'Your account provider', subject: `Problem with a payment of ${d.amount} to ${d.payeeName}`, text, sentBy: 'you', qedSends: false }
}
