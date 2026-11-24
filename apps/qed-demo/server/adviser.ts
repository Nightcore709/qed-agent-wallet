/**
 * N-006: a model's investment proposal reviewed by a registered investment adviser before the owner can sign it.
 *
 * Off in this build (QED_ADVISER_REVIEW unset): every model proposal, and the document the owner signs, says that no
 * licensed adviser reviewed it. With QED_ADVISER_REVIEW=1, ask() puts each model proposal of an investment kind into
 * this queue instead of offering it. A reviewer holding QED_ADVISER_TOKEN, who is not a member of the workspace and
 * holds no authority in it, approves or declines it with their name and SEBI registration. An approved proposal opens
 * and is signed like any other, and the signed document names the review; a declined one cannot be opened or signed.
 * The reviewer is sent the proposal's terms, its title and rationale, and QED's analysis, not the owner's question or
 * conversation; the model's title and rationale may restate the question. A review covers the terms it was given: an
 * instruction signed on other terms says no adviser reviewed them. The SEBI registration is the reviewer's own
 * statement; QED does not check it against SEBI's register.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { canonical } from '../shared/sha256.ts'
import { AppError, audit, type Config, type Db, j, notFound, parse, refused } from './core.ts'

/** What an adviser reviews: what the instruction buys or sells, and how much (its kind and parameters). */
export const termsHash = (kind: string, params: unknown): string => createHash('sha256').update(canonical({ kind, params })).digest('hex')

/** The kinds that buy, sell or hold investments, a split included (it can send income into a fund or a digital asset):
 *  a model's proposal of one of these is investment advice. */
export const ADVICE_KINDS: ReadonlySet<string> = new Set(['invest', 'rebalance', 'sweep', 'exit', 'floor', 'split'])

/** Whether this model proposal must wait for a reviewer. */
export const needsReview = (cfg: Pick<Config, 'adviserReview'>, origin: string, kind: string): boolean => cfg.adviserReview && origin === 'model' && ADVICE_KINDS.has(kind)

/** Hold a new model proposal for review: it is not offered, drafted or signed until a reviewer approves it. */
export function queueForReview(db: Db, userId: string, proposalId: string, now: number): void {
  db.tx(() => {
    const r = db.run(`UPDATE proposals SET state = 'review' WHERE id = ? AND user_id = ? AND state = 'new'`, proposalId, userId)
    if (r.changes === 0) return
    db.run(`INSERT INTO adviser_reviews (proposal_id, user_id, requested_at, state) VALUES (?, ?, ?, 'pending')`, proposalId, userId, now)
    audit(db, now, userId, 'system', 'adviser.queued', proposalId, {})
  })
}

/** The reviewer's credential, compared in constant time; the queue does not exist without the setting and a token. */
export function requireReviewer(cfg: Pick<Config, 'adviserReview' | 'adviserToken'>, presented: unknown): void {
  if (!cfg.adviserReview || !cfg.adviserToken) throw notFound('The review queue')
  const h = (s: string): Buffer => createHash('sha256').update(s).digest()
  if (typeof presented !== 'string' || !timingSafeEqual(h(presented), h(cfg.adviserToken))) throw new AppError(401, 'reviewer_only', 'Only the registered adviser\'s credential opens the review queue.')
}

/** What a reviewer reads: the terms and QED's analysis of them, oldest first. Never the owner's question. */
export function reviewQueue(db: Db): { proposalId: string; requestedAt: number; kind: string; title: string; rationale: string; terms: unknown; analysis: unknown }[] {
  return db.all<{ proposal_id: string; requested_at: number; kind: string; title: string; rationale: string; params_json: string; analysis_json: string }>(
    `SELECT r.proposal_id, r.requested_at, p.kind, p.title, p.rationale, p.params_json, p.analysis_json FROM adviser_reviews r JOIN proposals p ON p.id = r.proposal_id WHERE r.state = 'pending' AND p.state = 'review' ORDER BY r.requested_at LIMIT 200`)
    .map((r) => {
      const an = parse<Record<string, unknown>>(r.analysis_json, {})
      return { proposalId: r.proposal_id, requestedAt: r.requested_at, kind: r.kind, title: r.title, rationale: r.rationale, terms: parse(r.params_json, {}), analysis: { tier: an.tier ?? null, headline: an.headline ?? null, figures: an.figures ?? [], warnings: an.warnings ?? [], refusals: an.refusals ?? [] } }
    })
}

const SEBI_RIA = /^INA\d{9}$/

/** A reviewer's decision. Approving lets the owner open and sign the proposal; it signs nothing and grants nothing. */
export function decideReview(db: Db, proposalId: string, raw: unknown, now: number): { proposalId: string; state: 'approved' | 'declined' } {
  const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const decision = b.decision === 'approve' ? 'approved' : b.decision === 'decline' ? 'declined' : null
  const reviewer = typeof b.reviewer === 'string' ? b.reviewer.trim().slice(0, 80) : ''
  const registration = typeof b.registration === 'string' ? b.registration.trim().toUpperCase() : ''
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : ''
  const fields: Record<string, string> = {}
  if (!decision) fields.decision = 'Approve or decline.'
  if (reviewer.length < 2) fields.reviewer = 'Give your name as registered.'
  if (!SEBI_RIA.test(registration)) fields.registration = 'Give your SEBI investment adviser registration, such as INA000012345.'
  if (decision === 'declined' && note.length < 3) fields.note = 'Say why it is declined; the owner reads it.'
  if (Object.keys(fields).length) throw new AppError(400, 'invalid', 'Check the highlighted fields.', fields)
  const row = db.get<{ user_id: string; state: string }>('SELECT user_id, state FROM adviser_reviews WHERE proposal_id = ?', proposalId)
  if (!row) throw notFound('That proposal')
  if (row.state !== 'pending') throw refused('already_decided', 'This proposal has already been reviewed.')
  db.tx(() => {
    db.run('UPDATE adviser_reviews SET state = ?, reviewer = ?, registration = ?, note = ?, decided_at = ? WHERE proposal_id = ?', decision, reviewer, registration, note || null, now, proposalId)
    const p = db.get<{ analysis_json: string; kind: string; params_json: string }>('SELECT analysis_json, kind, params_json FROM proposals WHERE id = ?', proposalId)!
    // the review covers these terms only: an instruction signed on other terms does not carry it (review finding 2)
    const review = { by: reviewer, registration, at: now, decision, termsSha256: termsHash(p.kind, parse<{ params?: unknown }>(p.params_json, {}).params ?? null), ...(note ? { note } : {}) }
    db.run(`UPDATE proposals SET state = ?, analysis_json = ?, invalid_reason = ? WHERE id = ? AND state = 'review'`,
      decision === 'approved' ? 'new' : 'declined', j({ ...parse<Record<string, unknown>>(p.analysis_json, {}), review }),
      decision === 'declined' ? `Declined by ${reviewer} (SEBI registration ${registration}): ${note}` : null, proposalId)
    audit(db, now, row.user_id, 'adviser', `adviser.${decision}`, proposalId, { reviewer, registration })
  })
  return { proposalId, state: decision! }
}

/**
 * The approved review of a proposal, in the words the signed document carries, for the terms being signed; null when
 * none. Terms other than those reviewed (the owner changed what it buys or how much) say that no adviser reviewed
 * them. The registration is the adviser's own statement: QED does not check it against SEBI's register.
 */
export function reviewedLine(db: Db, proposalId: string, signed: { kind: string; params: unknown }): string | null {
  const r = db.get<{ reviewer: string; registration: string; decided_at: number; note: string | null }>(`SELECT reviewer, registration, decided_at, note FROM adviser_reviews WHERE proposal_id = ? AND state = 'approved'`, proposalId)
  if (!r) return null
  const day = new Date(r.decided_at).toISOString().slice(0, 10)
  const reviewed = parse<{ review?: { termsSha256?: string } }>(db.get<{ analysis_json: string }>('SELECT analysis_json FROM proposals WHERE id = ?', proposalId)?.analysis_json, {}).review?.termsSha256
  if (reviewed !== termsHash(signed.kind, signed.params)) return `A registered investment adviser reviewed an earlier version of this proposal on ${day}; the terms signed here differ from what they reviewed, so no licensed adviser reviewed them.`
  return `A registered investment adviser, ${r.reviewer}, who gave SEBI registration ${r.registration} (QED has not checked it against SEBI's register), reviewed what this buys and how much on ${day}${r.note ? `: "${r.note}"` : ''}.`
}
