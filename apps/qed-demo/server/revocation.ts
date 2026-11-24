/**
 * Revoking an instruction reaches every channel it reaches (the mandate omissions audit, finding S7). Revoking only removes
 * authority, so it needs no approval and takes effect at once; what takes time is the channels outside QED, and each is
 * recorded separately, with the time it answered:
 *
 *   instruction  QED's own record of it: no run starts. QED answers at once.
 *   scheduled    runs waiting to start and payments it asked for that have not been sent (planned, or held for a wait). QED
 *                cancels them and answers at once, with how many.
 *   paper-bank   the paper bank's standing mandate for an instruction that pays bills (bank-mandates.ts; a simulated
 *                institution). The bank is asked to end it. Only the bank's own answer makes the channel 'acknowledged'; no
 *                answer leaves it 'no-answer', the mandate still active at the bank, and QED asks again at each pass.
 *   chain        the wallet's on-chain mandate for QED's agent, when the household has a wallet. QED cannot sign for the
 *                person: it is revoked on the chain only with their passkey. Revoking an instruction prepares the wallet's
 *                own revoke-mandate proposal (server/rail.ts proposeOnRail, the wallet's route; R13) for the person to
 *                sign, and it can be prepared again after it lapses. It is 'needs-you' until signed, 'sent' when the job
 *                was given to the chain, and 'acknowledged' only when the chain's job reports it done (after its
 *                confirmations). If the wallet has no mandate in force, the chain's own state says so and the channel is
 *                answered. Revoking one instruction does not by itself end the wallet's mandate, which covers every
 *                instruction that uses the wallet; the record, and what remains in force (`remains`), say so.
 *
 * A channel that has not acknowledged is never shown as revoked. A channel the instruction does not reach (no mandate on
 * record at the paper bank, no wallet) has no row: nothing is invented for it. Asking again is the same revocation.
 */
import { paperBank } from './bank-mandates.ts'
import { audit, type Db, newId } from './core.ts'
import { cancelAction } from './execute.ts'
import { loadProgram, revokeProgram } from './programs.ts'
import type { Ctx } from './types.ts'

export type ChannelName = 'instruction' | 'scheduled' | 'paper-bank' | 'chain'
export type ChannelState = 'acknowledged' | 'no-answer' | 'needs-you' | 'sent'
export interface Channel { channel: ChannelName; label: string; state: ChannelState; askedAt: number; answeredAt: number | null; reference: string | null; detail: string; simulated: boolean }
export interface Revocation { id: string; subjectKind: 'instruction'; subjectId: string; title: string; requestedAt: number; complete: boolean; channels: Channel[]; remains: string[] }

const LABEL: Record<ChannelName, string> = { instruction: 'QED\'s instruction', scheduled: 'Scheduled runs and payments', 'paper-bank': 'The paper bank\'s mandate (simulated)', chain: 'The wallet\'s on-chain mandate (test chain)' }
const NOT_BEFORE = 'Nothing is shown as revoked until the channel says it is.'

const put = (db: Db, id: string, c: { channel: ChannelName; state: ChannelState; at: number; answeredAt?: number | null; reference?: string | null; detail: string; simulated?: boolean }): void => {
  db.run(`INSERT INTO revocation_channels (revocation_id, channel, state, asked_at, answered_at, reference, detail, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (revocation_id, channel) DO UPDATE SET state = excluded.state, answered_at = excluded.answered_at, reference = excluded.reference, detail = excluded.detail`,
  id, c.channel, c.state, c.at, c.answeredAt ?? null, c.reference ?? null, c.detail, c.simulated ? 1 : 0)
}

/** Ask the paper bank to end an instruction's mandate, and record what it answered. Safe to repeat. */
function askPaperBank(db: Db, revocationId: string, userId: string, programId: string, now: number): void {
  const m = db.get<{ id: string; reference: string; state: string }>(`SELECT id, reference, state FROM paper_mandates WHERE user_id = ? AND program_id = ?`, userId, programId)
  if (!m) return
  const asked = db.get<{ asked_at: number }>('SELECT asked_at FROM revocation_channels WHERE revocation_id = ? AND channel = ?', revocationId, 'paper-bank')?.asked_at ?? now
  if (m.state === 'revoked') return
  const answer = paperBank().revoke(m.reference)
  if (answer.acknowledged) {
    db.run(`UPDATE paper_mandates SET state = 'revoked', revoked_at = ? WHERE id = ?`, now, m.id)
    put(db, revocationId, { channel: 'paper-bank', state: 'acknowledged', at: asked, answeredAt: now, reference: answer.reference ?? null, simulated: true,
      detail: `The paper bank (a simulated institution) acknowledged ending mandate ${m.reference} and gave its own reference.` })
  } else {
    put(db, revocationId, { channel: 'paper-bank', state: 'no-answer', at: asked, simulated: true,
      detail: `The paper bank (a simulated institution) has not answered. Mandate ${m.reference} is still active there, so it is not shown as revoked. QED asks again at each pass; ${NOT_BEFORE}` })
  }
}

/**
 * Revoke an instruction everywhere, in one transaction. `hasWallet` says whether the household has an on-chain wallet (the
 * route reads it from the wallet's record). Returns the revocation as recorded.
 */
export function revokeEverywhere(ctx: Ctx, userId: string, programId: string, hasWallet: boolean): Revocation | null {
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const p = loadProgram(db, userId, programId)
    let rev: { id: string } | undefined = db.get<{ id: string }>(`SELECT id FROM revocations WHERE user_id = ? AND subject_kind = 'instruction' AND subject_id = ?`, userId, programId)
    if (!rev) {
      // a draft has no authority and nothing outside QED; one revoked before revocations were recorded has no record of its channels
      if (p.state === 'revoked' || (p.state === 'draft' && p.live_version === null)) { revokeProgram(ctx, userId, programId); return }
      const waitingRuns = db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE program_id = ? AND state IN ('due', 'awaiting_approval', 'objection_window')`, programId)?.n ?? 0
      revokeProgram(ctx, userId, programId)
      const id = newId('rev', now)
      db.run(`INSERT INTO revocations (id, user_id, subject_kind, subject_id, title, requested_at) VALUES (?, ?, 'instruction', ?, ?, ?)`, id, userId, programId, p.title, now)
      rev = { id }
      put(db, id, { channel: 'instruction', state: 'acknowledged', at: now, answeredAt: now, detail: 'QED ended the instruction. No run starts from now.' })
      // payments it asked for that have not been sent: planned, or waiting
      let stopped = 0
      for (const a of db.all<{ id: string }>(`SELECT id FROM actions WHERE user_id = ? AND program_id = ? AND state IN ('planned', 'awaiting_approval', 'held')`, userId, programId)) {
        try { cancelAction(ctx, userId, a.id); stopped++ } catch { /* sent meanwhile: it is on its way and cannot be recalled */ }
      }
      put(db, id, { channel: 'scheduled', state: 'acknowledged', at: now, answeredAt: now, detail: `${waitingRuns} waiting run${waitingRuns === 1 ? '' : 's'} and ${stopped} unsent payment${stopped === 1 ? '' : 's'} cancelled. Anything already sent to the rail is on its way and cannot be recalled.` })
      if (hasWallet) put(db, id, { channel: 'chain', state: 'needs-you', at: now, detail: `Your wallet has an on-chain mandate for QED's agent. Revoking an instruction does not end it: it is revoked on the chain only with your passkey, under Vault, "Revoke the mandate". Until then it is not revoked. ${NOT_BEFORE}` })
      audit(db, now, userId, 'owner', 'program.revoke-everywhere', programId, { revocation: id })
    }
    if (rev) askPaperBank(db, rev.id, userId, programId, now)
  })
  return revocationFor(db, userId, programId)
}

const channelOf = (r: { channel: string; state: string; asked_at: number; answered_at: number | null; reference: string | null; detail: string; simulated: number }): Channel =>
  ({ channel: r.channel as ChannelName, label: LABEL[r.channel as ChannelName], state: r.state as ChannelState, askedAt: r.asked_at, answeredAt: r.answered_at, reference: r.reference, detail: r.detail, simulated: r.simulated === 1 })
const ORDER: ChannelName[] = ['instruction', 'scheduled', 'paper-bank', 'chain']

/** What stays in force while a channel has not acknowledged, in the person's words (R13: stated on screen). */
function remainsOf(channels: Channel[]): string[] {
  const out: string[] = []
  for (const c of channels) {
    if (c.state === 'acknowledged') continue
    if (c.channel === 'chain') out.push(c.state === 'sent'
      ? 'The wallet\'s on-chain mandate for QED\'s agent: its revocation was given to the chain and is not yet confirmed, so the mandate still counts until it is. It covers every instruction that uses the wallet, not only this one.'
      : 'The wallet\'s on-chain mandate for QED\'s agent: still in force on the chain, within its own limits, until you sign its revocation with your passkey and the chain confirms it. It covers every instruction that uses the wallet, not only this one.')
    if (c.channel === 'paper-bank') out.push('The paper bank\'s mandate for this instruction (a simulated bank): still active at the bank until it answers; QED asks again at each pass.')
  }
  return out
}
function viewOf(db: Db, r: { id: string; subject_id: string; title: string; requested_at: number }): Revocation {
  const channels = db.all<Parameters<typeof channelOf>[0]>('SELECT * FROM revocation_channels WHERE revocation_id = ?', r.id).map(channelOf).sort((a, b) => ORDER.indexOf(a.channel) - ORDER.indexOf(b.channel))
  return { id: r.id, subjectKind: 'instruction', subjectId: r.subject_id, title: r.title, requestedAt: r.requested_at, complete: channels.every((c) => c.state === 'acknowledged'), channels, remains: remainsOf(channels) }
}
export function revocationFor(db: Db, userId: string, programId: string): Revocation | null {
  const r = db.get<{ id: string; subject_id: string; title: string; requested_at: number }>(`SELECT id, subject_id, title, requested_at FROM revocations WHERE user_id = ? AND subject_kind = 'instruction' AND subject_id = ?`, userId, programId)
  return r ? viewOf(db, r) : null
}
export function revocations(db: Db, userId: string): Revocation[] {
  return db.all<{ id: string; subject_id: string; title: string; requested_at: number }>(`SELECT id, subject_id, title, requested_at FROM revocations WHERE user_id = ? ORDER BY requested_at DESC LIMIT 50`, userId).map((r) => viewOf(db, r))
}

/** The engine's pass: ask again every paper-bank mandate whose revocation has not been acknowledged. */
export function retryRevocations(ctx: Ctx): number {
  const { db } = ctx
  const open = db.all<{ id: string; user_id: string; subject_id: string }>(`SELECT r.id, r.user_id, r.subject_id FROM revocations r JOIN revocation_channels c ON c.revocation_id = r.id WHERE c.channel = 'paper-bank' AND c.state = 'no-answer'`)
  for (const r of open) db.tx(() => askPaperBank(db, r.id, r.user_id, r.subject_id, ctx.clock.now()))
  return open.length
}

/**
 * The wallet's revoke-mandate proposal was prepared for a revocation that names the chain (the wallet's own route): the
 * channel waits for the person's passkey, with the approval as its reference and the mandate it would end in its detail.
 * Nothing is revoked by preparing it.
 */
export function chainPrepared(db: Db, userId: string, revocationId: string, p: { approvalId: string; expiresAt: number; mandate: string }, now: number): number {
  return db.run(`UPDATE revocation_channels SET reference = ?, detail = ? WHERE channel = 'chain' AND state = 'needs-you' AND revocation_id = ? AND revocation_id IN (SELECT id FROM revocations WHERE user_id = ?)`,
    p.approvalId, `QED prepared the wallet's revocation of its mandate for QED's agent (${p.mandate}) at ${new Date(now).toISOString()}. Sign it with your passkey to revoke the mandate on the chain; the request lapses at ${new Date(p.expiresAt).toISOString()} and can be prepared again. Until the chain confirms it, the mandate is not revoked. ${NOT_BEFORE}`, revocationId, userId).changes
}
/** The wallet's own state shows no mandate in force for QED's agent: there is nothing to revoke on the chain, and the channel says why. */
export function chainNothingToRevoke(db: Db, userId: string, revocationId: string, why: string, now: number): number {
  return db.run(`UPDATE revocation_channels SET state = 'acknowledged', answered_at = ?, detail = ? WHERE channel = 'chain' AND state = 'needs-you' AND revocation_id = ? AND revocation_id IN (SELECT id FROM revocations WHERE user_id = ?)`,
    now, `The wallet's own state shows no mandate in force for QED's agent (${why}), so there is nothing to revoke on the chain.`, revocationId, userId).changes
}

/** The person gave the wallet's own "revoke the mandate" to the chain: its channels become 'sent', with the job. */
export function chainSent(db: Db, userId: string, jobId: string, now: number): number {
  return db.run(`UPDATE revocation_channels SET state = 'sent', reference = ?, detail = ? WHERE channel = 'chain' AND state IN ('needs-you', 'sent') AND revocation_id IN (SELECT id FROM revocations WHERE user_id = ?)`,
    jobId, `The revocation was given to the chain (job ${jobId}) at ${new Date(now).toISOString()}. The chain has not confirmed it, so it is not shown as revoked.`, userId).changes
}
/** The chain's own job report for a revocation it was given: only a job reported done acknowledges. */
export function chainAnswered(db: Db, userId: string, job: { id: string; status: string }, now: number): number {
  if (job.status === 'done') return db.run(`UPDATE revocation_channels SET state = 'acknowledged', answered_at = ?, detail = ? WHERE channel = 'chain' AND state = 'sent' AND reference = ? AND revocation_id IN (SELECT id FROM revocations WHERE user_id = ?)`,
    now, `The chain reported the wallet's mandate revoked (job ${job.id}).`, job.id, userId).changes
  if (job.status === 'failed' || job.status === 'interrupted' || job.status === 'reorged') return db.run(`UPDATE revocation_channels SET state = 'needs-you', detail = ? WHERE channel = 'chain' AND state = 'sent' AND reference = ? AND revocation_id IN (SELECT id FROM revocations WHERE user_id = ?)`,
    `The chain did not complete the revocation (job ${job.id} ${job.status}). The mandate is not revoked. Try again under Vault.`, job.id, userId).changes
  return 0
}
