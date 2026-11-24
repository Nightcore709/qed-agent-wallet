/**
 * Netting between workspaces (R13, I2; the audit's I2 and R7-055). Two workspaces, or up to six, record what each owes the
 * other, both sides agree each amount, and the amounts are offset so that each workspace pays or receives only its net
 * position, once. This is QED's own record-keeping on one installation. What it is not:
 *
 *   - It is not a clearing house, a central counterparty or a payment system, and holds no licence as one. The chain's
 *     "certified multilateral clearing" (chain/rail/scenarios.ts) is a scripted economy on a throwaway chain and is not
 *     used here; this module has its own arithmetic and checks it again (verifyTerms).
 *   - The money moves between the workspaces' bank accounts in QED's paper bank: simulated, no real account is touched.
 *   - A debt is whatever both sides agreed to record. QED does not know whether it is owed in law.
 *
 * The flow, each step by a member who may do it:
 *   1. A member records a claim ("B owes A 3,00,000 for invoice 14"); the other workspace's signer agrees or declines.
 *   2. A member proposes a cycle among the workspaces (every agreed, unused claim among them is included). The terms are
 *      fixed with a fingerprint: each workspace's net position, the fewest payments that settle them, and what netting saves.
 *   3. Every workspace agrees to the cycle's fingerprint.
 *   4. Each paying workspace signs its payment: an approval in that workspace, so its signing policy applies (the count of
 *      signatures by amount band, each member's limit). A receiving workspace signs nothing.
 *   5. When every payment is signed and fresh, the cycle settles in one transaction: every payment posts, or none does.
 */
import { createApproval, getApproval, consumeApproval } from './approvals.ts'
import { AppError, audit, bad, type Db, j, newId, notFound, parse } from './core.ts'
import { ensureAccount, post, type Line } from './ledger.ts'
import { staysLiquid } from './liquidity.ts'
import { sha256hex } from './receipts.ts'
import { actor, canPrepare, canSign, type Role } from './workspaces.ts'
import { inrExact } from '../shared/money.ts'
import { canonical } from '../shared/sha256.ts'

export const CYCLE_OPEN_MS = 7 * 86_400_000
export const MAX_PARTICIPANTS = 6
export const MAX_CLAIM_PAISE = 1_000_000_000_000
export const PAPER_NOTE = 'Simulated: the money moves between two paper bank accounts inside QED. Nothing reaches a real bank, and QED is not a clearing house or a payment system.'

export interface Who { personId: string; role: Role }
export type ClaimState = 'proposed' | 'agreed' | 'in-cycle' | 'netted' | 'withdrawn' | 'declined'
export interface Claim { id: string; creditor_ws: string; debtor_ws: string; amount: number; memo: string; state: ClaimState; proposed_by_ws: string; proposed_by: string; created_at: number; agreed_by: string | null; agreed_at: number | null; cycle_id: string | null }
export interface Payment { from: string; to: string; paise: number }
export interface Terms {
  participants: string[]
  claims: { id: string; creditor: string; debtor: string; paise: number; memo: string }[]
  positions: Record<string, number>
  payments: Payment[]
  grossPaise: number
  paidPaise: number
  savedPaise: number
}

/** A workspace's name and code, for the screen and the documents. */
const nameOf = (db: Db, ws: string): string => db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', ws)?.display_name ?? ws

function workspaceByCode(db: Db, code: unknown): { id: string; name: string } {
  const h = typeof code === 'string' ? code.trim().toLowerCase() : ''
  const u = h ? db.get<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE handle = ?', h) : undefined
  if (!u) throw new AppError(404, 'not_found', 'No workspace has that code.', { counterparty: 'No workspace has that code.' })
  if (!db.get(`SELECT 1 FROM accounts WHERE user_id = ? AND code = 'bank'`, u.id)) throw new AppError(409, 'no_books', `${u.display_name} has not opened its books yet, so it cannot be paid or pay.`, { counterparty: 'Its books are not open.' })
  return { id: u.id, name: u.display_name }
}

/** Minimum-count settlement of net positions: the largest debtor pays the largest creditor, until every position is nil. */
export function settlementPayments(positions: Record<string, number>): Payment[] {
  const owe = Object.entries(positions).filter(([, v]) => v < 0).map(([k, v]) => ({ k, v: -v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const get = Object.entries(positions).filter(([, v]) => v > 0).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const out: Payment[] = []
  while (owe.length && get.length) {
    const d = owe[0]!, c = get[0]!
    const x = Math.min(d.v, c.v)
    out.push({ from: d.k, to: c.k, paise: x })
    d.v -= x; c.v -= x
    if (d.v === 0) owe.shift()
    if (c.v === 0) get.shift()
  }
  return out
}

/** Terms of a cycle from its claims: each workspace's net position, the payments, and what netting saves. */
export function buildTerms(claims: Terms['claims'], participants: string[]): Terms {
  const positions: Record<string, number> = Object.fromEntries(participants.map((p) => [p, 0]))
  for (const c of claims) { positions[c.creditor]! += c.paise; positions[c.debtor]! -= c.paise }
  const payments = settlementPayments(positions)
  const grossPaise = claims.reduce((s, c) => s + c.paise, 0), paidPaise = payments.reduce((s, p) => s + p.paise, 0)
  return { participants: [...participants].sort(), claims, positions, payments, grossPaise, paidPaise, savedPaise: grossPaise - paidPaise }
}

/**
 * The checks on terms, made again from the claims alone (no reading of the payments' own arithmetic): positions add up to
 * nothing, every payment is between two participants and above nothing, applying the payments leaves every position at nil,
 * and the payments cost no more than settling each claim separately. Returns the failures; an empty list is a pass.
 */
export function verifyTerms(t: Terms): string[] {
  const bad_: string[] = []
  const pos: Record<string, number> = Object.fromEntries(t.participants.map((p) => [p, 0]))
  for (const c of t.claims) {
    if (!(c.paise > 0) || !Number.isSafeInteger(c.paise)) bad_.push(`claim ${c.id}: not a positive whole number of paise`)
    if (c.creditor === c.debtor) bad_.push(`claim ${c.id}: a workspace cannot owe itself`)
    if (pos[c.creditor] === undefined || pos[c.debtor] === undefined) { bad_.push(`claim ${c.id}: outside the cycle`); continue }
    pos[c.creditor]! += c.paise; pos[c.debtor]! -= c.paise
  }
  if (Object.values(pos).reduce((s, v) => s + v, 0) !== 0) bad_.push('positions do not add up to nothing')
  for (const p of t.participants) if (t.positions[p] !== pos[p]) bad_.push(`position of ${p} differs from its claims`)
  const left = { ...pos }
  for (const p of t.payments) {
    if (!(p.paise > 0) || left[p.from] === undefined || left[p.to] === undefined || p.from === p.to) { bad_.push('a payment is not between two participants for a positive amount'); continue }
    left[p.from]! += p.paise; left[p.to]! -= p.paise
  }
  for (const [k, v] of Object.entries(left)) if (v !== 0) bad_.push(`${k} is left with ${v} paise after the payments`)
  const gross = t.claims.reduce((s, c) => s + c.paise, 0), paid = t.payments.reduce((s, p) => s + p.paise, 0)
  if (paid > gross) bad_.push('the payments are larger than the claims they settle')
  if (t.grossPaise !== gross || t.paidPaise !== paid || t.savedPaise !== gross - paid) bad_.push('the totals differ from the claims and payments')
  return bad_
}

// ------------------------------------------------------------------------------------------------ claims
export function proposeClaim(db: Db, ws: string, by: Who, input: { counterparty?: unknown; direction?: unknown; amountPaise?: unknown; memo?: unknown }, now: number): Claim {
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot record what is owed.')
  const other = workspaceByCode(db, input.counterparty)
  if (other.id === ws) throw bad('A workspace cannot owe itself.', { counterparty: 'That is this workspace.' })
  const dir = input.direction === 'i-owe' ? 'i-owe' : input.direction === 'owed-to-me' ? 'owed-to-me' : null
  if (!dir) throw bad('Say who owes whom.', { direction: 'Choose one.' })
  const amount = Number(input.amountPaise)
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CLAIM_PAISE) throw bad('Enter an amount above nothing.', { amountPaise: 'Enter an amount above nothing.' })
  const memo = typeof input.memo === 'string' ? input.memo.trim().slice(0, 140) : ''
  if (memo.length < 2) throw bad('Say what it is for, so both sides can recognise it.', { memo: 'A few words, such as the invoice.' })
  const id = newId('ncl', now)
  const [creditor, debtor] = dir === 'owed-to-me' ? [ws, other.id] : [other.id, ws]
  db.run('INSERT INTO netting_claims (id, creditor_ws, debtor_ws, amount, memo, state, proposed_by_ws, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, creditor, debtor, amount, memo, 'proposed', ws, by.personId, now)
  audit(db, now, ws, 'owner', 'netting.claim.propose', id, { creditor, debtor, amount, by: by.personId })
  return claimOf(db, id)!
}
const claimOf = (db: Db, id: string): Claim | undefined => db.get<Claim>('SELECT * FROM netting_claims WHERE id = ?', id)

/** The other workspace agrees to (or declines) a recorded claim. Only a member who may sign can agree to a debt. */
export function answerClaim(db: Db, ws: string, by: Who, id: string, agree: boolean, now: number): Claim {
  const c = claimOf(db, id)
  if (!c || (c.creditor_ws !== ws && c.debtor_ws !== ws)) throw notFound('That claim')
  if (c.proposed_by_ws === ws) throw new AppError(403, 'not_permitted', 'The other workspace has to agree to this; you recorded it.')
  if (!canSign(by.role)) throw new AppError(403, 'not_permitted', 'Only a member who may sign can agree to an amount owed.')
  if (c.state !== 'proposed') throw new AppError(409, 'not_open', 'That claim is no longer waiting for an answer.')
  db.run('UPDATE netting_claims SET state = ?, agreed_by = ?, agreed_at = ? WHERE id = ?', agree ? 'agreed' : 'declined', by.personId, now, id)
  audit(db, now, ws, 'owner', agree ? 'netting.claim.agree' : 'netting.claim.decline', id, { by: by.personId })
  return claimOf(db, id)!
}

export function withdrawClaim(db: Db, ws: string, by: Who, id: string, now: number): Claim {
  const c = claimOf(db, id)
  if (!c || c.proposed_by_ws !== ws) throw notFound('That claim')
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot withdraw a claim.')
  if (c.state !== 'proposed' && c.state !== 'agreed') throw new AppError(409, 'not_open', c.state === 'in-cycle' ? 'That claim is in a cycle. Cancel the cycle first.' : 'That claim is already closed.')
  db.run(`UPDATE netting_claims SET state = 'withdrawn' WHERE id = ?`, id)
  audit(db, now, ws, 'owner', 'netting.claim.withdraw', id, { by: by.personId })
  return claimOf(db, id)!
}

// ------------------------------------------------------------------------------------------------ cycles
interface CycleRow { id: string; proposed_by_ws: string; proposed_by: string; state: string; terms_json: string; fingerprint: string; created_at: number; expires_at: number; settled_at: number | null; cancelled_at: number | null; cancelled_by: string | null }
interface PartRow { cycle_id: string; workspace_id: string; agreed_by: string | null; agreed_at: number | null; approval_id: string | null }

/** Propose a cycle among this workspace and the others named (by code): every agreed claim among them, not yet in a cycle. */
export function proposeCycle(db: Db, ws: string, by: Who, codes: unknown, now: number): NonNullable<ReturnType<typeof cycleView>> {
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot propose a netting cycle.')
  const list = Array.isArray(codes) ? codes : []
  if (!list.length) throw bad('Name the workspace to net with.', { counterparties: 'Give at least one code.' })
  const others = [...new Set(list.map((c) => workspaceByCode(db, c).id))].filter((x) => x !== ws)
  const participants = [ws, ...others]
  if (participants.length < 2) throw bad('A cycle needs at least two workspaces.', { counterparties: 'Name another workspace.' })
  if (participants.length > MAX_PARTICIPANTS) throw bad(`At most ${MAX_PARTICIPANTS} workspaces in one cycle.`, { counterparties: 'Too many.' })
  return db.tx(() => {
    const ph = participants.map(() => '?').join(',')
    const claims = db.all<Claim>(`SELECT * FROM netting_claims WHERE state = 'agreed' AND creditor_ws IN (${ph}) AND debtor_ws IN (${ph}) ORDER BY created_at, id`, ...participants, ...participants)
    if (!claims.length) throw new AppError(409, 'nothing_to_net', 'There is no agreed claim among these workspaces. Record a claim and have the other side agree to it first.')
    // every workspace must have a claim in the cycle, or it is not part of it
    for (const p of participants) if (!claims.some((c) => c.creditor_ws === p || c.debtor_ws === p)) throw new AppError(409, 'nothing_to_net', `${nameOf(db, p)} has no agreed claim with the others, so it cannot be in this cycle.`)
    const terms = buildTerms(claims.map((c) => ({ id: c.id, creditor: c.creditor_ws, debtor: c.debtor_ws, paise: c.amount, memo: c.memo })), participants)
    const failures = verifyTerms(terms)
    if (failures.length) throw new AppError(500, 'terms_unverified', `The netting did not check out, so nothing was proposed: ${failures[0]}.`)
    const id = newId('ncy', now)
    const fingerprint = sha256hex(canonical({ id, terms }))
    db.run('INSERT INTO netting_cycles (id, proposed_by_ws, proposed_by, state, terms_json, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ws, by.personId, 'open', j(terms), fingerprint, now, now + CYCLE_OPEN_MS)
    for (const p of terms.participants) db.run('INSERT INTO netting_participants (cycle_id, workspace_id, agreed_by, agreed_at) VALUES (?, ?, ?, ?)', id, p, p === ws ? by.personId : null, p === ws ? now : null)
    for (const c of claims) db.run(`UPDATE netting_claims SET state = 'in-cycle', cycle_id = ? WHERE id = ?`, id, c.id)
    audit(db, now, ws, 'owner', 'netting.cycle.propose', id, { participants: terms.participants, fingerprint, gross: terms.grossPaise, paid: terms.paidPaise, by: by.personId })
    return cycleView(db, ws, id, now)!
  })
}

function cycleRow(db: Db, ws: string, id: string): CycleRow | undefined {
  return db.get<CycleRow>('SELECT c.* FROM netting_cycles c JOIN netting_participants p ON p.cycle_id = c.id WHERE c.id = ? AND p.workspace_id = ?', id, ws)
}

/** Every workspace agrees to the same fingerprint before anything is signed. */
export function agreeCycle(db: Db, ws: string, by: Who, id: string, fingerprint: unknown, now: number): NonNullable<ReturnType<typeof cycleView>> {
  const c = cycleRow(db, ws, id)
  if (!c) throw notFound('That netting cycle')
  if (!canSign(by.role)) throw new AppError(403, 'not_permitted', 'Only a member who may sign can agree to a netting cycle.')
  if (c.state !== 'open') throw new AppError(409, 'not_open', 'That cycle is closed.')
  if (now > c.expires_at) throw new AppError(409, 'expired', 'That cycle ran out of time. Propose it again.')
  if (fingerprint !== c.fingerprint) throw new AppError(409, 'approval_mismatch', 'What was shown does not match what the server holds. Nothing was agreed.')
  db.run('UPDATE netting_participants SET agreed_by = ?, agreed_at = ? WHERE cycle_id = ? AND workspace_id = ? AND agreed_at IS NULL', by.personId, now, id, ws)
  audit(db, now, ws, 'owner', 'netting.cycle.agree', id, { by: by.personId, fingerprint })
  return cycleView(db, ws, id, now)!
}

export function cancelCycle(db: Db, ws: string, by: Who, id: string, now: number): NonNullable<ReturnType<typeof cycleView>> {
  const c = cycleRow(db, ws, id)
  if (!c) throw notFound('That netting cycle')
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot cancel a cycle.')
  if (c.state !== 'open') throw new AppError(409, 'not_open', 'That cycle is closed.')
  db.tx(() => {
    db.run(`UPDATE netting_cycles SET state = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?`, now, by.personId, id)
    db.run(`UPDATE netting_claims SET state = 'agreed', cycle_id = NULL WHERE cycle_id = ? AND state = 'in-cycle'`, id)
    for (const p of db.all<PartRow>('SELECT * FROM netting_participants WHERE cycle_id = ? AND approval_id IS NOT NULL', id)) db.run('UPDATE approvals SET cancelled_at = ? WHERE id = ? AND consumed_at IS NULL AND cancelled_at IS NULL', now, p.approval_id)
    audit(db, now, ws, 'owner', 'netting.cycle.cancel', id, { by: by.personId })
  })
  return cycleView(db, ws, id, now)!
}

const subjectOf = (cycleId: string, ws: string): string => `netting:${cycleId}:${ws}`

/**
 * The paying workspace's request to sign its payment. It is an ordinary approval of that workspace, sized by the payment,
 * so the workspace's signing policy decides how many members must sign and whose limit covers it. Needs every workspace to
 * have agreed first, so no one signs terms the others have not accepted.
 */
export function preparePayment(db: Db, ws: string, by: Who, id: string, now: number): { approvalId: string; docHash: string; expiresAt: number; required: number } {
  const c = cycleRow(db, ws, id)
  if (!c) throw notFound('That netting cycle')
  if (!canPrepare(by.role)) throw new AppError(403, 'not_permitted', 'Your role in this workspace cannot prepare a payment.')
  if (c.state !== 'open') throw new AppError(409, 'not_open', 'That cycle is closed.')
  if (now > c.expires_at) throw new AppError(409, 'expired', 'That cycle ran out of time. Propose it again.')
  const t = parse<Terms>(c.terms_json, null as never)
  const pay = t.payments.filter((p) => p.from === ws)
  if (!pay.length) throw new AppError(409, 'nothing_to_pay', 'This workspace pays nothing in this cycle.')
  const parts = db.all<PartRow>('SELECT * FROM netting_participants WHERE cycle_id = ?', id)
  const waiting = parts.filter((p) => !p.agreed_at).map((p) => nameOf(db, p.workspace_id))
  if (waiting.length) throw new AppError(409, 'not_agreed', `${waiting.join(', ')} ${waiting.length === 1 ? 'has' : 'have'} not agreed to the cycle yet.`)
  const total = pay.reduce((s, p) => s + p.paise, 0)
  const document = JSON.stringify({
    kind: 'netting-payment', title: `Pay ${inr(total)} to settle a netting cycle`, sizePaise: total, cycleId: id, fingerprint: c.fingerprint,
    what: `Pay ${pay.map((p) => `${inr(p.paise)} to ${nameOf(db, p.to)}`).join(' and ')}, the net of ${t.claims.length} agreed claim${t.claims.length === 1 ? '' : 's'} (${inr(t.grossPaise)} gross; the cycle moves ${inr(t.paidPaise)} in all, so ${inr(t.savedPaise)} is not paid twice)`,
    claims: t.claims.map((x) => ({ from: nameOf(db, x.debtor), to: nameOf(db, x.creditor), amount: inr(x.paise), memo: x.memo })),
    note: PAPER_NOTE,
  })
  const a = actor.run({ personId: by.personId, workspaceId: ws, role: by.role }, () => createApproval(db, ws, { purpose: 'netting', subject: subjectOf(id, ws), document, sizePaise: total, ttlMs: undefined }, now))
  db.run('UPDATE netting_participants SET approval_id = ? WHERE cycle_id = ? AND workspace_id = ?', a.id, id, ws)
  return { approvalId: a.id, docHash: a.doc_hash, expiresAt: a.expires_at, required: a.required_signers }
}

const inr = (paise: number): string => inrExact(paise)

/**
 * Settle if every workspace has agreed and every payer's signed approval is confirmed, fresh and for these terms. All
 * payments post together or none does (one transaction). Returns why it did not, when it did not.
 */
export function settleIfReady(db: Db, ws: string, id: string, now: number): { settled: boolean; reason: string | null } {
  const c = cycleRow(db, ws, id)
  if (!c) throw notFound('That netting cycle')
  if (c.state === 'settled') return { settled: true, reason: null }
  if (c.state !== 'open') return { settled: false, reason: 'The cycle is closed.' }
  if (now > c.expires_at) return { settled: false, reason: 'The cycle ran out of time.' }
  const t = parse<Terms>(c.terms_json, null as never)
  if (verifyTerms(t).length || sha256hex(canonical({ id, terms: t })) !== c.fingerprint) throw new AppError(500, 'terms_unverified', 'The stored terms no longer check out, so nothing was settled.')
  const parts = db.all<PartRow>('SELECT * FROM netting_participants WHERE cycle_id = ?', id)
  const waiting = parts.filter((p) => !p.agreed_at)
  if (waiting.length) return { settled: false, reason: `Waiting for ${waiting.map((p) => nameOf(db, p.workspace_id)).join(', ')} to agree.` }
  const payers = [...new Set(t.payments.map((p) => p.from))]
  const unsigned = payers.filter((p) => { const a = parts.find((x) => x.workspace_id === p)?.approval_id; const ap = a ? getApproval(db, p, a) : undefined; return !ap || !ap.confirmed_at || ap.cancelled_at || ap.consumed_at })
  if (unsigned.length) return { settled: false, reason: `Waiting for ${unsigned.map((p) => nameOf(db, p)).join(', ')} to sign its payment.` }
  try {
    db.tx(() => {
      for (const p of payers) {
        const a = getApproval(db, p, parts.find((x) => x.workspace_id === p)!.approval_id!)!
        const total = t.payments.filter((x) => x.from === p).reduce((s, x) => s + x.paise, 0)
        consumeApproval(db, p, a.id, subjectOf(id, p), a.doc_hash, now)
        if ((JSON.parse(a.document) as { fingerprint?: string }).fingerprint !== c.fingerprint) throw new AppError(409, 'approval_stale', 'A signed payment was for other terms. Prepare it again.')
        const live = staysLiquid(db, p, now, total)
        if (!live.ok) throw new AppError(409, 'would_break_reserve', `${nameOf(db, p)} cannot pay this without going below what it must keep in the bank. ${live.detail}`)
      }
      for (const w of t.participants) {
        ensureAccount(db, w, 'bank', 'asset', 'INR', 'Bank account', true)
        const out = t.payments.filter((x) => x.from === w), inn = t.payments.filter((x) => x.to === w)
        const lines: Line[] = []
        for (const x of out) lines.push({ account: 'bank', amount: -BigInt(x.paise) }, { account: 'exp:spend', amount: BigInt(x.paise) })
        for (const x of inn) lines.push({ account: 'bank', amount: BigInt(x.paise) }, { account: 'inc:other', amount: -BigInt(x.paise) })
        if (!lines.length) continue
        post(db, { userId: w, ts: now, kind: 'netting', ref: `netting:${id}`, memo: `Settled by netting with ${t.participants.filter((x) => x !== w).map((x) => nameOf(db, x)).join(', ')}: ${t.claims.length} agreed claims, ${inr(t.grossPaise)} gross, ${inr(t.paidPaise)} paid. Paper bank, simulated.`, meta: { cycleId: id, fingerprint: c.fingerprint, simulated: true, claims: t.claims.map((x) => x.id), payments: t.payments } , lines })
      }
      db.run(`UPDATE netting_cycles SET state = 'settled', settled_at = ? WHERE id = ?`, now, id)
      db.run(`UPDATE netting_claims SET state = 'netted' WHERE cycle_id = ?`, id)
      audit(db, now, ws, 'owner', 'netting.cycle.settle', id, { payments: t.payments, gross: t.grossPaise, paid: t.paidPaise })
    })
  } catch (e) {
    if (e instanceof AppError) return { settled: false, reason: e.message }
    if (e instanceof Error && /below zero|reserved/.test(e.message)) return { settled: false, reason: e.message }
    throw e
  }
  return { settled: true, reason: null }
}

// ------------------------------------------------------------------------------------------------ views
export function cycleView(db: Db, ws: string, id: string, now: number) {
  const c = cycleRow(db, ws, id)
  if (!c) return undefined
  const t = parse<Terms>(c.terms_json, null as never)
  const parts = db.all<PartRow>('SELECT * FROM netting_participants WHERE cycle_id = ?', id)
  const name = (w: string): string => nameOf(db, w)
  const mine = parts.find((p) => p.workspace_id === ws)
  const myApproval = mine?.approval_id ? getApproval(db, ws, mine.approval_id) : undefined
  return {
    id, state: c.state, createdAt: c.created_at, expiresAt: c.expires_at, settledAt: c.settled_at, fingerprint: c.fingerprint, proposedBy: name(c.proposed_by_ws),
    participants: t.participants.map((w) => { const p = parts.find((x) => x.workspace_id === w); const a = p?.approval_id ? getApproval(db, w, p.approval_id) : undefined; return { id: w, name: name(w), position: t.positions[w]!, agreed: !!p?.agreed_at, pays: t.payments.filter((x) => x.from === w).reduce((s, x) => s + x.paise, 0), receives: t.payments.filter((x) => x.to === w).reduce((s, x) => s + x.paise, 0), signed: !!a?.confirmed_at, you: w === ws } }),
    claims: t.claims.map((x) => ({ id: x.id, creditor: name(x.creditor), debtor: name(x.debtor), paise: x.paise, memo: x.memo })),
    payments: t.payments.map((x) => ({ from: name(x.from), to: name(x.to), paise: x.paise, mine: x.from === ws })),
    grossPaise: t.grossPaise, paidPaise: t.paidPaise, savedPaise: t.savedPaise,
    checks: verifyTerms(t).length === 0 ? ['Positions add up to nothing', 'Applying the payments leaves every workspace at nil', 'The payments are no larger than the claims they settle'] : ['The terms did not pass their checks'],
    youAgreed: !!mine?.agreed_at, youPay: t.payments.filter((x) => x.from === ws).reduce((s, x) => s + x.paise, 0), approvalId: myApproval && !myApproval.cancelled_at && !myApproval.consumed_at ? myApproval.id : null, approvalSigned: !!myApproval?.confirmed_at && !myApproval.consumed_at,
    open: c.state === 'open' && now <= c.expires_at, simulated: PAPER_NOTE,
  }
}

export function nettingView(db: Db, ws: string, now: number) {
  const name = (w: string): string => nameOf(db, w)
  const claims = db.all<Claim>(`SELECT * FROM netting_claims WHERE (creditor_ws = ? OR debtor_ws = ?) AND state NOT IN ('withdrawn', 'declined') ORDER BY created_at DESC LIMIT 100`, ws, ws).map((c) => ({
    id: c.id, creditor: name(c.creditor_ws), debtor: name(c.debtor_ws), paise: c.amount, memo: c.memo, state: c.state, cycleId: c.cycle_id, createdAt: c.created_at,
    direction: c.creditor_ws === ws ? 'owed-to-you' : 'you-owe', counterparty: name(c.creditor_ws === ws ? c.debtor_ws : c.creditor_ws), yourMove: c.state === 'proposed' && c.proposed_by_ws !== ws ? 'agree' : c.state === 'proposed' ? 'wait' : null, yours: c.proposed_by_ws === ws,
  }))
  const cycles = db.all<{ cycle_id: string }>('SELECT cycle_id FROM netting_participants WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 20', ws).map((r) => cycleView(db, ws, r.cycle_id, now)!)
  return { code: db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', ws)?.handle ?? '', claims, cycles, simulated: PAPER_NOTE, rule: 'Both sides must agree to every claim, and every workspace to the cycle. Each paying workspace signs its own payment under its own signing policy.' }
}
