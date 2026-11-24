/**
 * Subscriptions: recurring payments found in the household's own history (the mandate omissions audit, finding S3).
 *
 * Detection, stated on screen with its figures. From the payments that settled to someone else's address (a payment to a
 * payee, or a bill; never a transfer between the person's own accounts), by payee address:
 *   - at least 3 payments, so at least 2 gaps;
 *   - every gap between neighbouring payments within the tolerance of ONE cadence: weekly 7 days (+/- 2), fortnightly 14
 *     (+/- 3), monthly 30 (+/- 4, so 26 to 34), quarterly 91 (+/- 8), yearly 365 (+/- 15). One gap outside it and the
 *     payee is not listed: QED prefers to miss a subscription than to call an irregular payment one;
 *   - every amount within 10% of the middle amount, so a price rise of a few per cent still counts and a different purchase
 *     does not;
 *   - the latest payment no more than two cadences ago, otherwise it is taken to have ended and is not listed.
 * Cost: the middle amount times the payments a year the cadence has (52, 26, 12, 4, 1), per year, and a twelfth of that per
 * month; next expected: the latest payment plus the cadence. The evidence is the payments themselves, each linked.
 *
 * Review. "Stop QED's instruction": if QED's own instruction paid it, or an instruction names the payee, it is revoked
 * everywhere it reaches (revocation.ts). That only removes authority, so it applies at once. If QED holds nothing for it, the
 * action says so and does nothing. "I must cancel it myself": QED cannot cancel a third party's subscription, only record that
 * the person means to, and then say so if the merchant is paid again afterwards. Neither action cancels anything at the
 * merchant, and the screen says that.
 */
import { audit, type Db, notFound, refused } from './core.ts'
import { isThirdParty } from './new-payee.ts'
import { revokeEverywhere, type Revocation } from './revocation.ts'
import type { Ctx, PaymentParams } from './types.ts'

const DAY = 86_400_000
export interface Cadence { name: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly'; days: number; tolerance: number; perYear: number }
export const CADENCES: readonly Cadence[] = [
  { name: 'weekly', days: 7, tolerance: 2, perYear: 52 }, { name: 'fortnightly', days: 14, tolerance: 3, perYear: 26 }, { name: 'monthly', days: 30, tolerance: 4, perYear: 12 },
  { name: 'quarterly', days: 91, tolerance: 8, perYear: 4 }, { name: 'yearly', days: 365, tolerance: 15, perYear: 1 },
]
export const MIN_PAYMENTS = 3
/** An amount may differ from the middle one by this share. */
export const AMOUNT_TOLERANCE = 0.1
export const DETECTION_RULE = `A payee is listed when you paid it at least ${MIN_PAYMENTS} times, every gap between payments fits one cadence (${CADENCES.map((c) => `${c.name} ${c.days} days, give or take ${c.tolerance}`).join('; ')}), every amount is within ${AMOUNT_TOLERANCE * 100}% of the middle amount, and the latest payment is no more than two cadences ago.`
export const CANNOT_CANCEL = 'QED cannot cancel a subscription with the merchant: it can only stop its own instruction or mandate, and remind you. Cancelling is up to you, with them.'

export interface Evidence { actionId: string; at: number; amount: number; programId: string | null }
export interface Subscription {
  payeeHandle: string; payeeName: string; cadence: Cadence['name']; amount: number; perMonth: number; perYear: number
  nextExpected: number; lastPaid: number; evidence: Evidence[]
  /** QED's own instructions that pay or name this payee (they can be stopped here). */
  instructions: { id: string; title: string; state: string }[]
  review: { state: 'stopped' | 'cancel-myself'; reviewedAt: number; note: string } | null
  /** Payments after the person said they would cancel it themselves: it was paid again. */
  paidAfterReview: number
}

/** The cadence a set of ascending payment times fits, or null. */
export function cadenceOf(times: number[]): Cadence | null {
  if (times.length < MIN_PAYMENTS) return null
  const gaps = times.slice(1).map((t, i) => (t - times[i]!) / DAY)
  return CADENCES.find((c) => gaps.every((g) => Math.abs(g - c.days) <= c.tolerance)) ?? null
}
const middle = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }

/** The payments that settled to third parties, with when the ledger recorded them going out. */
function settled(db: Db, userId: string): (Evidence & { handle: string; name: string })[] {
  return db.all<{ id: string; params_json: string; program_id: string | null; effective_ts: number }>(
    `SELECT a.id, a.params_json, a.program_id, e.effective_ts FROM actions a JOIN entries e ON e.user_id = a.user_id AND e.ref = 'pay:' || a.economic_id || ':out'
      WHERE a.user_id = ? AND a.kind = 'payment' AND a.state = 'done' ORDER BY e.effective_ts`, userId)
    .flatMap((r) => { const p = JSON.parse(r.params_json) as PaymentParams; return isThirdParty(p.payeeHandle) && (p.purpose === 'spend' || p.purpose === 'bill') ? [{ actionId: r.id, at: r.effective_ts, amount: Number(p.amount), programId: r.program_id, handle: p.payeeHandle, name: p.payeeName }] : [] })
}

function instructionsFor(db: Db, userId: string, handle: string, ids: Set<string>): Subscription['instructions'] {
  const out = new Map<string, { id: string; title: string; state: string }>()
  for (const p of db.all<{ id: string; title: string; state: string; live_version: number | null; kind: string }>(`SELECT id, title, state, live_version, kind FROM programs WHERE user_id = ? AND state IN ('active', 'paused')`, userId)) {
    let names = ids.has(p.id)
    if (!names && p.kind === 'bills' && p.live_version !== null) {
      const v = db.get<{ params_json: string }>('SELECT params_json FROM program_versions WHERE program_id = ? AND version = ?', p.id, p.live_version)
      try { names = ((JSON.parse(v?.params_json ?? '{}') as { payeeHandles?: string[] }).payeeHandles ?? []).includes(handle) } catch { names = false }
    }
    if (names) out.set(p.id, { id: p.id, title: p.title, state: p.state })
  }
  return [...out.values()]
}

export function subscriptions(db: Db, userId: string, now: number): Subscription[] {
  const byPayee = new Map<string, ReturnType<typeof settled>>()
  for (const s of settled(db, userId)) byPayee.set(s.handle, [...(byPayee.get(s.handle) ?? []), s])
  const out: Subscription[] = []
  for (const [handle, ps] of byPayee) {
    const cadence = cadenceOf(ps.map((p) => p.at))
    if (!cadence) continue
    const mid = middle(ps.map((p) => p.amount))
    if (mid <= 0 || ps.some((p) => Math.abs(p.amount - mid) > mid * AMOUNT_TOLERANCE)) continue
    const last = ps[ps.length - 1]!.at
    if (now - last > 2 * cadence.days * DAY) continue
    const perYear = mid * cadence.perYear
    const rev = db.get<{ state: 'stopped' | 'cancel-myself'; reviewed_at: number; note: string }>('SELECT state, reviewed_at, note FROM subscription_reviews WHERE user_id = ? AND payee_handle = ?', userId, handle)
    out.push({
      payeeHandle: handle, payeeName: ps[ps.length - 1]!.name, cadence: cadence.name, amount: mid, perYear, perMonth: Math.round(perYear / 12),
      nextExpected: last + cadence.days * DAY, lastPaid: last, evidence: ps.map(({ actionId, at, amount, programId }) => ({ actionId, at, amount, programId })),
      instructions: instructionsFor(db, userId, handle, new Set(ps.flatMap((p) => (p.programId ? [p.programId] : [])))),
      review: rev ? { state: rev.state, reviewedAt: rev.reviewed_at, note: rev.note } : null,
      paidAfterReview: rev?.state === 'cancel-myself' ? ps.filter((p) => p.at > rev.reviewed_at).length : 0,
    })
  }
  return out.sort((a, b) => b.perYear - a.perYear)
}

/** The result of stopping what QED holds for a subscription. */
export interface StopResult { stopped: Revocation[]; nothing: boolean }

/**
 * Stop QED's own instruction(s) for a subscription: each is revoked everywhere it reaches, at once (a tightening: nothing
 * waits). Nothing of QED's to stop is said, not done, and the payee is not marked as stopped. Not a cancellation with the merchant.
 */
export function stopSubscription(ctx: Ctx, userId: string, handle: string, hasWallet: boolean): StopResult {
  const now = ctx.clock.now()
  return ctx.db.tx(() => {
    const sub = subscriptions(ctx.db, userId, now).find((s) => s.payeeHandle === handle)
    if (!sub) throw notFound('That subscription')
    if (!sub.instructions.length) return { stopped: [], nothing: true }
    const stopped = sub.instructions.flatMap((i) => { const r = revokeEverywhere(ctx, userId, i.id, hasWallet); return r ? [r] : [] })
    ctx.db.run(`INSERT INTO subscription_reviews (user_id, payee_handle, state, note, reviewed_at) VALUES (?, ?, 'stopped', ?, ?) ON CONFLICT (user_id, payee_handle) DO UPDATE SET state = 'stopped', note = excluded.note, reviewed_at = excluded.reviewed_at`,
      userId, handle, `QED's instruction${stopped.length === 1 ? '' : 's'} stopped. ${CANNOT_CANCEL}`, now)
    audit(ctx.db, now, userId, 'owner', 'subscription.stop', handle, { revocations: stopped.map((s) => s.id) })
    return { stopped, nothing: false }
  })
}

/** The person says they must cancel it with the merchant themselves. Recorded; nothing is cancelled and nothing is stopped. */
export function markCancelMyself(ctx: Ctx, userId: string, handle: string): void {
  const now = ctx.clock.now()
  ctx.db.tx(() => {
    if (!subscriptions(ctx.db, userId, now).some((s) => s.payeeHandle === handle)) throw notFound('That subscription')
    const had = ctx.db.get<{ state: string }>('SELECT state FROM subscription_reviews WHERE user_id = ? AND payee_handle = ?', userId, handle)
    if (had?.state === 'cancel-myself') throw refused('already_marked', 'You already marked this one as yours to cancel.')
    ctx.db.run(`INSERT INTO subscription_reviews (user_id, payee_handle, state, note, reviewed_at) VALUES (?, ?, 'cancel-myself', ?, ?) ON CONFLICT (user_id, payee_handle) DO UPDATE SET state = 'cancel-myself', note = excluded.note, reviewed_at = excluded.reviewed_at`,
      userId, handle, CANNOT_CANCEL, now)
    audit(ctx.db, now, userId, 'owner', 'subscription.cancel-myself', handle, {})
  })
}
