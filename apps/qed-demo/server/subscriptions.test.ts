/**
 * Recurring payments found in the household's own history, with the stated tolerance, the cost, the next expected date and
 * the payments they rest on; and the two review actions (audit finding S3, server/subscriptions.ts).
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { activateProgram, loadProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { CANNOT_CANCEL, cadenceOf, markCancelMyself, stopSubscription, subscriptions } from './subscriptions.ts'
import { makeKit, T0, type Kit } from './testkit.ts'

const DAY = 86_400_000
let n = 0
/** A payment that settled: the action as done, and the ledger entry that recorded it going out. */
function paid(k: Kit, handle: string, amount: number, at: number, opts: { purpose?: string; programId?: string | null; name?: string } = {}): string {
  n++
  const id = `act_s${n}`, eco = `eco_s${n}`
  k.db.run(`INSERT INTO actions (id, user_id, program_id, origin, kind, venue, economic_id, state, params_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'payment', 'paper-rail', ?, 'done', ?, ?, ?)`,
    id, k.userId, opts.programId ?? null, opts.programId ? 'program' : 'owner', eco, JSON.stringify({ payeeHandle: handle, payeeName: opts.name ?? 'Streamly', amount: String(amount), purpose: opts.purpose ?? 'spend' }), at, at)
  k.db.run(`INSERT INTO entries (id, user_id, seq, ts, effective_ts, kind, ref, memo) VALUES (?, ?, ?, ?, ?, 'payment-sent', ?, 'x')`, `ent_s${n}`, k.userId, 1000 + n, at, at, `pay:${eco}:out`)
  return id
}
const monthly = (k: Kit, handle: string, amounts: number[], last: number) => amounts.map((a, i) => paid(k, handle, a, last - (amounts.length - 1 - i) * 30 * DAY))

describe('which payments are a subscription', () => {
  it('three monthly payments of nearly one amount are one: its cost, its next date and its evidence', () => {
    const k = makeKit(), now = T0 + 5 * DAY
    const ids = monthly(k, 'stream@upi', [49_900, 49_900, 53_900], T0)
    const [s] = subscriptions(k.db, k.userId, now)
    expect(s).toMatchObject({ payeeHandle: 'stream@upi', cadence: 'monthly', amount: 49_900, perYear: 49_900 * 12, perMonth: 49_900, nextExpected: T0 + 30 * DAY, lastPaid: T0, review: null, instructions: [] })
    expect(s!.evidence.map((e) => e.actionId)).toEqual(ids)
  })

  it('the tolerance is stated and exact: a 34-day gap fits monthly, a 35-day gap does not', () => {
    expect(cadenceOf([0, 34 * DAY, 68 * DAY])?.name).toBe('monthly')
    expect(cadenceOf([0, 35 * DAY, 70 * DAY])).toBeNull()
    expect(cadenceOf([0, 26 * DAY, 52 * DAY])?.name).toBe('monthly')
    expect(cadenceOf([0, 25 * DAY, 50 * DAY])).toBeNull()
    expect(cadenceOf([0, 7 * DAY, 14 * DAY])?.name).toBe('weekly')
    expect(cadenceOf([0, 365 * DAY, 730 * DAY])?.name).toBe('yearly')
    expect(cadenceOf([0, 30 * DAY])).toBeNull() // two payments are one gap, not a pattern
  })

  it('is not listed when one gap is off, an amount is far from the rest, it ended, or it is not a payment to someone else', () => {
    const k = makeKit(), now = T0 + 5 * DAY
    paid(k, 'a@upi', 100, T0 - 60 * DAY); paid(k, 'a@upi', 100, T0 - 25 * DAY); paid(k, 'a@upi', 100, T0) // a 35 and a 25 day gap
    monthly(k, 'b@upi', [10_000, 10_000, 30_000], T0) // 3x the middle amount
    monthly(k, 'c@upi', [10_000, 10_000, 10_000], T0 - 200 * DAY) // last paid more than two cadences ago
    monthly(k, 'card@paperbank', [10_000, 10_000, 10_000], T0) // the person's own card
    for (const d of [60, 30, 0]) paid(k, 'goal@setaside', 10_000, T0 - d * DAY, { purpose: 'goal' })
    expect(subscriptions(k.db, k.userId, now)).toEqual([])
  })

  it('lists the dearest first, and a price rise within tolerance does not hide it', () => {
    const k = makeKit(), now = T0 + DAY
    monthly(k, 'small@upi', [10_000, 10_000, 10_000], T0)
    monthly(k, 'big@upi', [100_000, 105_000, 109_000], T0)
    expect(subscriptions(k.db, k.userId, now).map((s) => s.payeeHandle)).toEqual(['big@upi', 'small@upi'])
  })
})

describe('reviewing one', () => {
  function bills(k: Kit, handle: string) {
    k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'pay_x', k.userId, 'Streamly', handle, 'utility', k.clock.now(), k.clock.now())
    const d = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: [handle], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * DAY, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const req = requestProgramApproval(k.ctx, k.userId, d.programId, [])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    return d.programId
  }

  it('stopping QED\'s instruction for it revokes the instruction everywhere, at once, with no wait', () => {
    const k = makeKit()
    k.clock.set(T0 + DAY)
    const id = bills(k, 'stream@upi')
    monthly(k, 'stream@upi', [49_900, 49_900, 49_900], T0)
    expect(subscriptions(k.db, k.userId, k.clock.now())[0]!.instructions).toEqual([{ id, title: expect.any(String), state: 'active' }])
    const r = stopSubscription(k.ctx, k.userId, 'stream@upi', false)
    expect(r.nothing).toBe(false)
    expect(r.stopped[0]!.channels.map((c) => c.channel)).toEqual(['instruction', 'scheduled', 'paper-bank'])
    expect(loadProgram(k.db, k.userId, id).state).toBe('revoked')
    expect(k.db.get('SELECT 1 FROM scheduled_changes')).toBeUndefined() // tightening: nothing was scheduled
    const s = subscriptions(k.db, k.userId, k.clock.now())[0]!
    expect(s.instructions).toEqual([])
    expect(s.review).toMatchObject({ state: 'stopped', note: expect.stringContaining(CANNOT_CANCEL) })
  })

  it('with nothing of QED\'s behind it, stopping says so and records nothing', () => {
    const k = makeKit()
    monthly(k, 'stream@upi', [49_900, 49_900, 49_900], T0)
    k.clock.set(T0 + DAY)
    expect(stopSubscription(k.ctx, k.userId, 'stream@upi', false)).toEqual({ stopped: [], nothing: true })
    expect(subscriptions(k.db, k.userId, k.clock.now())[0]!.review).toBeNull()
  })

  it('"I must cancel it myself" is recorded, says QED cannot cancel it, and warns if it is paid again', () => {
    const k = makeKit()
    monthly(k, 'stream@upi', [49_900, 49_900, 49_900], T0)
    k.clock.set(T0 + 2 * DAY)
    markCancelMyself(k.ctx, k.userId, 'stream@upi')
    expect(() => markCancelMyself(k.ctx, k.userId, 'stream@upi')).toThrow(/already marked/)
    let s = subscriptions(k.db, k.userId, k.clock.now())[0]!
    expect(s.review).toMatchObject({ state: 'cancel-myself', reviewedAt: T0 + 2 * DAY })
    expect(s.review!.note).toContain('QED cannot cancel a subscription with the merchant')
    expect(s.paidAfterReview).toBe(0)
    paid(k, 'stream@upi', 49_900, T0 + 30 * DAY)
    k.clock.set(T0 + 31 * DAY)
    s = subscriptions(k.db, k.userId, k.clock.now())[0]!
    expect(s.paidAfterReview).toBe(1)
  })

  it('an unknown payee is not found', () => {
    const k = makeKit()
    expect(() => markCancelMyself(k.ctx, k.userId, 'nobody@upi')).toThrow(/not found|subscription/i)
    expect(() => stopSubscription(k.ctx, k.userId, 'nobody@upi', false)).toThrow(/subscription/i)
  })
})
