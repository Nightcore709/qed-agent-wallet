/**
 * Pausing QED without a passkey, from the signed-out page (R12 task comparison, T6-a and T6-d). A person whose device
 * is lost or stolen types their handle and one of their saved recovery codes. If they match, QED is paused the way a
 * session opened with a password pauses it: everything QED does on its own stops except protective selling (switching
 * protection off needs a passkey that can approve, the D-094 review, M3). Nothing else happens: no session is opened,
 * nothing is resumed, no money moves, and the code stays usable for a recovery. Resuming needs a passkey, as always.
 * The answer is the same, and takes the same time (api.ts uniform), whether or not the handle and the code are right,
 * so it says nothing about either; the person's security history says what happened, and Home says QED is paused.
 * Rate limit: the address's recovery allowance (ten an hour, shared with recovery). Wrong codes never stop a right one
 * from pausing (the adversarial review of R12, M1: a per-person allowance let anyone who knows a handle switch this off
 * for a day with five bogus codes); they are counted only to tell the person, at the third in a day. A known handle
 * with no saved code left costs the same derivation as one that has some, as an unknown handle does.
 */
import { rateLimit } from './auth.ts'
import { AppError, audit } from './core.ts'
import { type CodeRow, DUMMY_SALT, matchCodeAsync, scryptCodeAsync, securityEvent } from './passkeys.ts'
import { setStop } from './runner.ts'
import type { Ctx } from './types.ts'

export const PAUSE_REASON = 'Paused with a saved recovery code, from the signed-out page'

export async function pauseWithCode(ctx: Ctx, input: { handle: unknown; code: unknown }, ip: string): Promise<{ ok: true }> {
  const { db } = ctx
  const now = ctx.clock.now()
  if (!rateLimit(db, `recovery:${ip}`, 10, 3600_000, now)) throw new AppError(429, 'too_many', 'Too many attempts from this address. Try again later.')
  const handle = typeof input.handle === 'string' ? input.handle.trim().toLowerCase().replace(/^@/, '') : ''
  const code = typeof input.code === 'string' ? input.code : ''
  const person = db.get<{ id: string }>(`SELECT id FROM users WHERE handle = ? AND kind = 'person'`, handle)
  // an unknown handle costs the same derivation as a real attempt and answers the same
  if (!person) { await scryptCodeAsync(DUMMY_SALT, code); return { ok: true } }
  const rows = db.all<CodeRow>('SELECT id, salt, code_hash, algo FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', person.id)
  const saved = rows.length ? await matchCodeAsync(rows, code) : (await scryptCodeAsync(DUMMY_SALT, code), undefined)
  if (!saved) {
    audit(db, now, person.id, 'system', 'stop.code-failed', person.id, {}, ip)
    const failed = db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE user_id = ? AND action = 'stop.code-failed' AND ts > ?`, person.id, now - 24 * 3600_000)!.n
    if (failed === 3) securityEvent(db, person.id, 'pause-code-failures', { n: failed }, now)
    return { ok: true }
  }
  db.tx(() => {
    // checked again after the derivation: a code used or replaced meanwhile pauses nothing
    if (!db.get('SELECT 1 FROM recovery_codes WHERE id = ? AND used_at IS NULL AND replaced_at IS NULL', saved.id)) return
    const already = db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', person.id)?.stop_at != null
    if (!already) setStop(ctx, person.id, PAUSE_REASON, true)
    // whether protective selling runs afterwards, so the person's history says it truly (R13): a pause already in force
    // that stopped protective selling too stays as it was
    const protectiveContinues = db.get<{ p: number }>('SELECT stop_protective p FROM users WHERE id = ?', person.id)?.p === 1
    securityEvent(db, person.id, 'paused-with-saved-code', { already, protectiveContinues }, now)
    audit(db, now, person.id, 'system', 'stop.code', person.id, { already }, ip)
  })
  return { ok: true }
}
