/**
 * Reporting a problem pauses QED on the account (N-018; the dispute procedure of the bank-agent terms research, step 1).
 *
 * The pause is scoped: it holds what QED does on its own (an instruction's payments, an agent purchase) on the rail the
 * disputed payment went through, for that person's account only. The person's own approved payments are untouched, and
 * so are other people's accounts and every other rail. It is released by the person, and nothing else releases it. Each
 * pause keeps when it began and when and by whom it was released. It is not the emergency stop (users.stop_at), which
 * holds everything and is the person's own switch.
 */
import { audit, type Db, emit, newId, notFound, refused } from './core.ts'
import { notice, resolveNotices } from './execute.ts'
import type { Ctx } from './types.ts'

export interface Pause { id: string; disputeId: string; actionId: string; scope: string; startedAt: number; releasedAt: number | null; releasedBy: string | null }
type Row = { id: string; dispute_id: string; action_id: string; scope: string; started_at: number; released_at: number | null; released_by: string | null }
const view = (r: Row): Pause => ({ id: r.id, disputeId: r.dispute_id, actionId: r.action_id, scope: r.scope, startedAt: r.started_at, releasedAt: r.released_at, releasedBy: r.released_by })
const scopeOf = (venue: string): string => `payments:${venue}`

export const PAUSE_REASON = 'You reported a problem with a payment on this account, so QED does nothing on its own there until you release the pause.'

/** Whether QED's own payments on this venue are held for this person. */
export function pausedFor(db: Db, userId: string, venue: string): boolean {
  return !!db.get('SELECT 1 FROM dispute_pauses WHERE user_id = ? AND scope = ? AND released_at IS NULL', userId, scopeOf(venue))
}

/** The person's pauses, newest first; for one payment when given. */
export function listPauses(db: Db, userId: string, actionId?: string): Pause[] {
  return db.all<Row>(`SELECT * FROM dispute_pauses WHERE user_id = ? ${actionId ? 'AND action_id = ?' : ''} ORDER BY started_at DESC, id`, ...(actionId ? [userId, actionId] : [userId])).map(view)
}

/** Begin the pause for a dispute just opened on a payment. Called in the dispute's own transaction. */
export function startPause(ctx: Ctx, userId: string, disputeId: string, actionId: string, venue: string): Pause {
  const now = ctx.clock.now()
  const id = newId('dps', now)
  ctx.db.run('INSERT INTO dispute_pauses (id, user_id, dispute_id, action_id, scope, started_at) VALUES (?, ?, ?, ?, ?, ?)', id, userId, disputeId, actionId, scopeOf(venue), now)
  audit(ctx.db, now, userId, 'owner', 'dispute.pause', id, { disputeId, actionId, scope: scopeOf(venue) })
  emit(ctx.db, now, userId, 'dispute-pause', { id, on: true })
  notice(ctx.db, userId, { level: 'warning', kind: 'dispute-pause', title: 'QED is paused on this account while the problem is open', body: `${PAUSE_REASON} Your own payments still work. Release the pause from the dispute pack.`, subject: id, dedupe: `dispute-pause:${id}` }, now)
  return view(ctx.db.get<Row>('SELECT * FROM dispute_pauses WHERE id = ?', id)!)
}

/** The person releases a pause. Nothing else does. */
export function releasePause(ctx: Ctx, userId: string, personId: string, pauseId: string): Pause {
  const now = ctx.clock.now()
  return ctx.db.tx(() => {
    const r = ctx.db.get<Row>('SELECT * FROM dispute_pauses WHERE id = ? AND user_id = ?', pauseId, userId)
    if (!r) throw notFound('That pause')
    if (r.released_at !== null) throw refused('already_released', 'That pause was already released.')
    ctx.db.run('UPDATE dispute_pauses SET released_at = ?, released_by = ? WHERE id = ?', now, personId, pauseId)
    audit(ctx.db, now, userId, 'owner', 'dispute.pause.release', pauseId, { by: personId })
    emit(ctx.db, now, userId, 'dispute-pause', { id: pauseId, on: false })
    resolveNotices(ctx.db, userId, `dispute-pause:${pauseId}`, now)
    return view(ctx.db.get<Row>('SELECT * FROM dispute_pauses WHERE id = ?', pauseId)!)
  })
}
