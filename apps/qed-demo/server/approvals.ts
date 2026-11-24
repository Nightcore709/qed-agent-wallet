/**
 * Approvals bind the owner's confirmation to one exact document. The server builds the document (the authorisation
 * text with its figures), stores its SHA-256, and shows the same text to the owner. Confirming proves three things:
 * who confirmed (the signed-in owner, re-authenticated by password or passkey when required), what (the stored
 * document hash, which the action or program version must match), and when (before the approval expired).
 * An approval is single-use: the action or program version that consumes it marks it spent.
 */
import { randomBytes } from 'node:crypto'
import { AppError, audit, type Db, j, newId } from './core.ts'
import { recordPrepared } from './prepared.ts'
import { actor, canSign, limitOf, overLimitText, policyOf, requiredSigners, type Role, withinLimit } from './workspaces.ts'
import { refuseCoolingOffApproval } from './passkeys.ts'
import { sha256hex } from './receipts.ts'
import { householdHome, thresholdIn } from './home-currency.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

export interface Approval { id: string; user_id: string; purpose: string; subject: string; document: string; doc_hash: string; nonce: string; requires_stepup: number; created_at: number; expires_at: number; confirmed_at: number | null; method: string | null; consumed_at: number | null; cancelled_at: number | null; created_by: string | null; required_signers: number; approver_id: string | null; size_paise?: number | null }

export const DEFAULT_TTL_MS = 10 * 60_000

export function createApproval(db: Db, userId: string, a: { purpose: string; subject: string; document: string; ttlMs?: number; requiresStepUp?: boolean; required?: number; sizePaise?: number }, now: number): Approval {
  // A newer request for the same subject replaces any earlier one that was never confirmed.
  db.run('UPDATE approvals SET cancelled_at = ? WHERE user_id = ? AND subject = ? AND confirmed_at IS NULL AND cancelled_at IS NULL', now, userId, a.subject)
  const id = newId('apr', now)
  // The maker (whoever is acting in this request) and how many members must sign, from the workspace's policy as it
  // stands now. A business approval that needs several signers lives longer, because they are several people.
  const maker = actor.getStore()?.personId ?? null
  // A member's delegated limit bounds what they may prepare as well as what they may sign (R13, I1; QED checks it alone).
  const size = (a.sizePaise ?? sizeOf(a.document)) || null
  if (maker && !withinLimit(policyOf(db, userId), maker, size)) throw new AppError(403, 'over_limit', overLimitText(limitOf(policyOf(db, userId), maker)!))
  // An on-chain vault's own threshold may set the count (server/rail.ts); otherwise the workspace's policy does.
  // The size the policy's larger count is measured against: a payment's document states its own (sizePaise); an
  // instruction and a run pass theirs, or one signature put in force an instruction able to move far more than the
  // threshold (R13 review, R06).
  const required = a.required ?? requiredSigners(db, userId, (a.sizePaise ?? sizeOf(a.document)) || null)
  const ttl = a.ttlMs ?? (required > 1 ? MULTI_SIGNER_TTL_MS : DEFAULT_TTL_MS)
  db.tx(() => {
    // the size it was measured at is kept (schema v8, part (r)): an instruction's is the most its authority can move, which
    // its document does not state, and a member's limit and a new passkey's cool-off are checked against it when it is signed
    db.run('INSERT INTO approvals (id, user_id, purpose, subject, document, doc_hash, nonce, requires_stepup, created_at, expires_at, created_by, required_signers, size_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, a.purpose, a.subject, a.document, sha256hex(a.document), randomBytes(16).toString('base64url'), a.requiresStepUp === false ? 0 : 1, now, now + ttl, maker, required, size)
    // How the session that asked for it was opened (RISK-076); a request made in a password session says so in its document.
    recordPrepared(db, 'approval', id, userId, now)
  })
  return getApproval(db, userId, id)!
}

/** How long a request that needs several members' signatures stays open. */
export const MULTI_SIGNER_TTL_MS = 24 * 3600_000

export function getApproval(db: Db, userId: string, id: string): Approval | undefined {
  return db.get<Approval>('SELECT * FROM approvals WHERE id = ? AND user_id = ?', id, userId)
}

// The challenge a passkey signs for an approval is server/passkeys.ts approvalChallenge(id, docHash).

/**
 * A confirmed approval must be used within this long. It was given on the figures of that moment; later they are
 * stale, and an approval that could be used at any time afterwards would be a standing permission nobody signed.
 */
export const APPROVAL_USE_WITHIN_MS = 5 * 60_000
/** Whether a confirmed approval that has not been used yet is too old to use. */
export const approvalLapsed = (a: { confirmed_at: number | null; consumed_at: number | null }, now: number): boolean => a.confirmed_at !== null && a.consumed_at === null && now > a.confirmed_at + APPROVAL_USE_WITHIN_MS
export const LAPSED_TEXT = 'That approval was given more than five minutes ago and was not used. Review the current figures and approve again.'

/**
 * Without the password, a session may approve less than this much of orders and payments in any 24 hours, however
 * the amount is split. One limit per action alone would let a stolen session move any amount in small pieces.
 */
export const PASSWORD_FREE_PAISE_PER_DAY = 1_000_000
const sizeOf = (document: string): number => { try { const n = Number((JSON.parse(document) as { sizePaise?: unknown }).sizePaise ?? 0); return Number.isFinite(n) && n > 0 ? n : 0 } catch { return 0 } }
/** The size a request was measured at when it was made; one made before schema v8 (r) is measured from its document. */
export const sizeOfApproval = (a: Pick<Approval, 'document' | 'size_paise'>): number | null => (a.size_paise ?? sizeOf(a.document)) || null
/** What this owner has approved without the password in the last 24 hours, in paise (orders and payments made by hand). */
export function passwordFreeApproved(db: Db, userId: string, now: number, exceptId = ''): number {
  return db.all<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'action' AND method = 'session' AND confirmed_at IS NOT NULL AND confirmed_at > ? AND cancelled_at IS NULL AND id <> ?`, userId, now - 86_400_000, exceptId)
    .reduce((t, r) => t + sizeOf(r.document), 0)
}

export function confirmApproval(db: Db, userId: string, id: string, proof: { method: 'password' | 'recent-password' | 'passkey' | 'session'; docHash: string; evidence?: unknown; sessionHash?: string }, now: number): Approval {
  return db.tx(() => {
    const a = getApproval(db, userId, id)
    if (!a) throw new AppError(404, 'not_found', 'That approval request was not found.')
    if (a.cancelled_at) throw new AppError(409, 'approval_withdrawn', 'That approval request was replaced or withdrawn. Review the current one.')
    if (a.confirmed_at) throw new AppError(409, 'approval_used', 'That approval was already confirmed.')
    if (now > a.expires_at) throw new AppError(409, 'approval_expired', 'That approval request expired. Review the current figures and approve again.')
    // The client echoes the hash of what it displayed. If it shows something else, the confirmation is refused.
    if (proof.docHash !== a.doc_hash) throw new AppError(409, 'approval_mismatch', 'What was shown does not match what the server holds. Nothing was approved.')
    if (a.requires_stepup && proof.method === 'session') throw new AppError(401, 'stepup_required', 'Enter your password to approve this.')
    // The daily password-free amount is settled here, in the same transaction as the confirmation, so that several
    // requests prepared while the amount was still free cannot all be confirmed without the password.
    if (a.purpose === 'action' && proof.method === 'session' && passwordFreeApproved(db, userId, now, id) + sizeOf(a.document) >= thresholdIn(householdHome(db, userId), PASSWORD_FREE_PAISE_PER_DAY)) throw new AppError(401, 'stepup_required', 'With what you have already approved today this reaches ₹10,000, so your password is needed.')
    db.run('UPDATE approvals SET confirmed_at = ?, method = ?, evidence_json = ?, session_hash = ? WHERE id = ?', now, proof.method, j(proof.evidence ?? {}), proof.sessionHash ?? null, id)
    audit(db, now, userId, 'owner', 'approval.confirm', a.subject, { approvalId: id, method: proof.method, docHash: a.doc_hash })
    return getApproval(db, userId, id)!
  })
}

/** Spend a confirmed approval for exactly the subject and document it was given for. */
export function consumeApproval(db: Db, userId: string, id: string, subject: string, docHash: string, now: number): Approval {
  return db.tx(() => {
    const a = getApproval(db, userId, id)
    if (!a) throw new AppError(404, 'not_found', 'That approval was not found.')
    if (a.subject !== subject) throw new AppError(409, 'approval_mismatch', 'That approval was given for something else.')
    if (a.doc_hash !== docHash) throw new AppError(409, 'approval_stale', 'The details changed after you approved. Review and approve the current version.')
    if (!a.confirmed_at || a.cancelled_at) throw new AppError(409, 'approval_missing', 'That approval has not been confirmed.')
    if (a.consumed_at) throw new AppError(409, 'approval_used', 'That approval has already been used.')
    if (a.confirmed_at > a.expires_at) throw new AppError(409, 'approval_expired', 'That approval expired.')
    if (approvalLapsed(a, now)) throw new AppError(409, 'approval_expired', LAPSED_TEXT)
    db.run('UPDATE approvals SET consumed_at = ? WHERE id = ?', now, id)
    return getApproval(db, userId, id)!
  })
}

export function cancelApproval(db: Db, userId: string, id: string, now: number): void {
  db.run('UPDATE approvals SET cancelled_at = ? WHERE id = ? AND user_id = ? AND consumed_at IS NULL AND cancelled_at IS NULL', now, id, userId)
}

/**
 * Keeping a request open (WCAG 2.2.1; R12 task comparison, gap 10). Before a request lapses, the person may ask for
 * the same terms again: a fresh request for the very same document, so the same fingerprint, open for the usual time,
 * which replaces this one (createApproval withdraws the earlier unconfirmed request for the same subject). Nothing in
 * what is signed changes, and what is sent is still checked again at the moment it is sent. As many times as wanted.
 * Not offered where the time is part of the terms: a quoted price (good for its quote only), a run (never past the
 * deadline it lapses at), terms on the chain (the chain's own deadline), or a request several members sign (it is
 * open for a day, and some may have signed it already). Returns how long the renewed request would stay open, or null.
 */
/** A request is kept open at most this long after its terms were first prepared: after that, its figures are prepared again. */
export const RENEW_FOR_AT_MOST_MS = 60 * 60_000
/**
 * The latest a renewed request may stay open until (Infinity: no bound beyond the usual time and the hour above), or null
 * where its time is part of its terms (the adversarial review of R12, M2, M3, L6): a quoted price; a fund order, whose
 * NAV day turns on the cut-off at the time it is sent; a document that accepted going below the floor or into what must
 * stay in the bank, which was shown on the figures of that moment; a run that is no longer waiting for approval, or
 * past its deadline; terms on the chain; a request several members sign.
 */
function renewBound(db: Db, a: Approval): number | null {
  if (a.required_signers > 1) return null
  let doc: { quote?: { validUntil?: unknown }; acknowledged?: { belowFloor?: unknown; intoReserve?: unknown }; action?: { params?: { instrumentId?: unknown } }; actions?: { params?: { instrumentId?: unknown } }[] }
  try { doc = JSON.parse(a.document) as typeof doc } catch { return null }
  if (doc.acknowledged?.belowFloor === true || doc.acknowledged?.intoReserve === true) return null
  const fund = [doc.action, ...(doc.actions ?? [])].some((x) => typeof x?.params?.instrumentId === 'string' && db.get<{ kind: string }>('SELECT kind FROM instruments WHERE id = ?', x.params.instrumentId)?.kind === 'mutual_fund')
  if (fund) return null
  if (a.purpose === 'action') return doc.quote?.validUntil ? null : Infinity
  if (a.purpose === 'run') {
    const run = db.get<{ deadline_at: number | null; state: string }>('SELECT deadline_at, state FROM runs WHERE id = ? AND user_id = ?', a.subject.replace(/^run:/, ''), a.user_id)
    return run?.state === 'awaiting_approval' ? run.deadline_at ?? null : null
  }
  // a version of an instruction that has not ended, still the draft it was prepared from: a request for a version of a
  // revoked, completed or expired instruction, or for a draft since discarded or replaced, is not kept open (R13)
  if (a.purpose === 'program-version') return signableVersion(db, a.user_id, a.subject) ? Infinity : null
  return null
}
/**
 * Whether a request to sign `program:<id>@<version>` can still put that version in force: the instruction has not ended
 * (it is a draft, in force or paused) and that version is still its draft. Until R13 a request prepared before the
 * instruction was revoked stayed open, was kept open, and when approved put the revoked instruction back in force.
 */
export function signableVersion(db: Db, userId: string, subject: string): boolean {
  const m = /^program:(.+)@(\d+)$/.exec(subject)
  if (!m) return false
  return !!db.get(`SELECT 1 FROM programs p JOIN program_versions v ON v.program_id = p.id WHERE p.id = ? AND p.user_id = ? AND p.state IN ('draft', 'active', 'paused') AND v.version = ? AND v.state = 'draft'`, m[1]!, userId, Number(m[2]))
}
/**
 * When these exact terms were first prepared, counting only the unbroken run of identical requests that ends at this one:
 * each earlier request still open (not lapsed) when the next was made. An identical request that lapsed long ago is a
 * different occasion, so it does not shorten the hour for the request now in force (QA hand-back, R13).
 */
const firstPrepared = (db: Db, a: Approval): number => {
  const all = db.all<{ created_at: number; expires_at: number }>('SELECT created_at, expires_at FROM approvals WHERE user_id = ? AND subject = ? AND doc_hash = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC', a.user_id, a.subject, a.doc_hash, a.created_at)
  let start = a.created_at
  for (const p of all) {
    if (p.created_at >= start) continue
    if (p.expires_at < start) break
    start = p.created_at
  }
  return start
}
const open_ = (a: Approval): boolean => a.confirmed_at === null && a.cancelled_at === null && a.consumed_at === null
export function renewTtl(db: Db, a: Approval, now: number): number | null {
  if (!open_(a) || now > a.expires_at) return null
  const bound = renewBound(db, a)
  if (bound === null) return null
  const until = Math.min(now + DEFAULT_TTL_MS, bound, firstPrepared(db, a) + RENEW_FOR_AT_MOST_MS)
  // any time more is given when asked (a page whose clock runs ahead may ask early); a run never past its deadline
  return until > a.expires_at ? until - now : null
}
/**
 * Whether the sheet offers "Keep it open", which it does two minutes before the request lapses: only where renewing
 * then would give at least a minute more (a run close to its deadline would not).
 */
export function renewable(db: Db, a: Approval, now: number): boolean {
  if (!open_(a) || now > a.expires_at) return false
  const bound = renewBound(db, a)
  return bound !== null && Math.min(a.expires_at - 120_000 + DEFAULT_TTL_MS, bound, firstPrepared(db, a) + RENEW_FOR_AT_MOST_MS) >= a.expires_at + 60_000
}

export function renewApproval(db: Db, userId: string, id: string, now: number): Approval {
  return db.tx(() => {
    const a = getApproval(db, userId, id)
    if (!a) throw new AppError(404, 'not_found', 'That approval request was not found.')
    if (a.cancelled_at) throw new AppError(409, 'approval_withdrawn', 'That approval request was replaced or withdrawn. Review the current one.')
    if (a.confirmed_at) throw new AppError(409, 'approval_used', 'That approval was already confirmed.')
    if (now > a.expires_at) throw new AppError(409, 'approval_expired', 'That approval request expired. Review the current figures and approve again.')
    // only whoever prepared it renews it, so the maker stays the maker (review M3); and only while it still needs one
    // signature under the workspace's policy as it stands now (a policy raised since then is not escaped by renewing)
    const asker = actor.getStore()?.personId ?? null
    if (a.created_by && asker && a.created_by !== asker) throw new AppError(403, 'not_maker', 'Only the member who prepared this request can keep it open. Prepare it again yourself if you need it.')
    if (requiredSigners(db, userId, sizeOfApproval(a)) > 1) throw new AppError(409, 'not_renewable', 'This request now needs more than one signature under your workspace\'s rules. Close it and prepare it again.')
    if (a.purpose === 'program-version' && !signableVersion(db, userId, a.subject)) throw new AppError(409, 'program_ended', 'This instruction has ended, or the draft this request was for was replaced, so the request cannot be kept open. Nothing will be put in force by it.')
    const ttl = renewTtl(db, a, now)
    if (ttl === null) throw new AppError(409, 'not_renewable', 'This request cannot be kept open longer: its time or its figures are part of its terms. Close it and prepare it again.')
    const fresh = createApproval(db, userId, { purpose: a.purpose, subject: a.subject, document: a.document, ttlMs: ttl, requiresStepUp: a.requires_stepup === 1, required: 1, ...(a.size_paise ? { sizePaise: a.size_paise } : {}) }, now)
    audit(db, now, userId, 'owner', 'approval.renew', fresh.id, { replaces: a.id, docHash: a.doc_hash })
    return fresh
  })
}

/**
 * One member's passkey signature on an approval (the passkey has already been verified against the approval's own
 * challenge by the caller). The approval takes effect, through confirmApproval, when enough distinct members have
 * signed. Refused: a member whose role may not sign; in a workspace with maker-checker, whoever prepared it; the same
 * member twice.
 */
export function signApproval(db: Db, workspaceId: string, id: string, signer: { personId: string; role: Role; credentialId: string; evidence: unknown; sessionHash: string }, docHash: string, now: number): { complete: boolean; signed: number; required: number; approval: Approval } {
  return db.tx(() => {
    const a = getApproval(db, workspaceId, id)
    if (!a) throw new AppError(404, 'not_found', 'That approval request was not found.')
    if (a.cancelled_at) throw new AppError(409, 'approval_withdrawn', 'That approval request was replaced or withdrawn. Review the current one.')
    if (a.confirmed_at) throw new AppError(409, 'approval_used', 'That approval was already confirmed.')
    if (now > a.expires_at) throw new AppError(409, 'approval_expired', 'That approval request expired. Review the current figures and approve again.')
    if (docHash !== a.doc_hash) throw new AppError(409, 'approval_mismatch', 'What was shown does not match what the server holds. Nothing was approved.')
    if (!canSign(signer.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace can prepare requests but not sign them.')
    const policy = policyOf(db, workspaceId)
    if (!withinLimit(policy, signer.personId, sizeOfApproval(a))) throw new AppError(403, 'over_limit', overLimitText(limitOf(policy, signer.personId)!))
    // a passkey added in the last 24 hours signs nothing above ₹10,000 (RISK-068, Q-062; server/passkeys.ts)
    refuseCoolingOffApproval(db, signer.credentialId, sizeOfApproval(a), now)
    if (policy.makerChecker && a.created_by === signer.personId) throw new AppError(403, 'maker_cannot_sign', 'You prepared this request, so another member must sign it.')
    if (db.get('SELECT 1 FROM approval_signatures WHERE approval_id = ? AND person_id = ?', id, signer.personId)) throw new AppError(409, 'already_signed', 'You have already signed this request.')
    db.run('INSERT INTO approval_signatures (approval_id, person_id, credential_id, evidence_json, signed_at) VALUES (?, ?, ?, ?, ?)', id, signer.personId, signer.credentialId, j(signer.evidence), now)
    const signed = db.get<{ n: number }>('SELECT COUNT(*) n FROM approval_signatures WHERE approval_id = ?', id)!.n
    audit(db, now, workspaceId, 'owner', 'approval.sign', a.subject, { approvalId: id, signer: signer.personId, signed, required: a.required_signers })
    if (signed < a.required_signers) return { complete: false, signed, required: a.required_signers, approval: getApproval(db, workspaceId, id)! }
    const signatures = db.all('SELECT person_id personId, credential_id credentialId, signed_at signedAt FROM approval_signatures WHERE approval_id = ? ORDER BY signed_at', id)
    const done = confirmApproval(db, workspaceId, id, { method: 'passkey', docHash, evidence: { ...(signer.evidence as object), signatures }, sessionHash: signer.sessionHash }, now)
    db.run('UPDATE approvals SET approver_id = ? WHERE id = ?', signer.personId, id)
    return { complete: true, signed, required: a.required_signers, approval: done }
  })
}

/** Requests in this workspace that still need signatures, and whether this member can add one. */
export function openApprovals(db: Db, workspaceId: string, personId: string, role: Role, now: number): Record<string, unknown>[] {
  const p = policyOf(db, workspaceId)
  return db.all<Approval & { signed: number; mine: number }>(`SELECT a.*, (SELECT COUNT(*) FROM approval_signatures s WHERE s.approval_id = a.id) signed,
      (SELECT COUNT(*) FROM approval_signatures s WHERE s.approval_id = a.id AND s.person_id = ?) mine
      FROM approvals a WHERE a.user_id = ? AND a.confirmed_at IS NULL AND a.cancelled_at IS NULL AND a.expires_at > ? AND a.required_signers > 1 ORDER BY a.created_at DESC`, personId, workspaceId, now)
    .map((a) => ({
      id: a.id, purpose: a.purpose, subject: a.subject, document: a.document, docHash: a.doc_hash, createdAt: a.created_at, expiresAt: a.expires_at,
      createdBy: a.created_by, signed: a.signed, required: a.required_signers,
      canSign: canSign(role) && a.mine === 0 && !(p.makerChecker && a.created_by === personId) && withinLimit(p, personId, sizeOfApproval(a)),
      why: !canSign(role) ? 'Your role cannot sign.' : a.mine ? 'You have signed.' : p.makerChecker && a.created_by === personId ? 'You prepared it; another member signs.' : !withinLimit(p, personId, sizeOfApproval(a)) ? `Above your limit of ${homeMoneyExact(limitOf(p, personId)!)}; a member whose limit covers it signs.` : null,
    }))
}

