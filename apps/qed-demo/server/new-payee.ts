/**
 * Payments to a payee that is new (R12 task comparison, gap 4; criteria T2-c and T2-e).
 *
 * Authorised push payment fraud (a person talked into paying a new payee themselves, by a caller, a message or a model)
 * is not stopped by any signature: the person is the one signing. Two things here slow it down.
 *
 *   1. The first-payment caution ("Added today, and never paid before. Check the address with them yourself before you
 *      send.") goes into the payment's signed terms, so it is read on the sheet, not only under the payee.
 *   2. What goes to a payee in its first 24 hours waits, once it comes to more than the household's amount: the payment is
 *      approved and its money set aside, but it is sent only after a stated wait, and the owner can cancel it meanwhile.
 *      It is the sum since the payee was added that counts, so splitting a payment does not get round it. The time it is
 *      sent and the reason are in the terms the passkey signs; the engine sends it when the time comes (execute.ts) and
 *      refuses any payment to a new payee above the amount that has not waited (policy.ts, "new-payee-wait").
 *
 * The defaults, and why (each a default the owner can change in Safeguards, with a passkey, never a password session):
 *   - The wait: 24 hours. QED's own design proposed a 24-hour time-lock for new payees (docs/research/qed-ux-accessibility/
 *     20261117-r4-ux-spec.md, section 3.9, question Q-UX-01). Every protective delay in the interaction research is a day
 *     or more: Kraken's settings lock 24 hours to 30 days, Coinbase's vault withdrawals 48 hours, cancellable, which support
 *     cannot bypass; Monzo's gambling block 48 hours to lift; the only shorter one is Apple's Stolen Device Protection, an
 *     hour, for settings, not payments (docs/research/qed-research-intel/20261118-interaction-pattern-research.md, B12, B13,
 *     B16, B17, sections 2.3 and 5.1; finding DP-8: no source supports a window under 24 hours for money). The UK's payment
 *     rules let a bank hold an outbound payment it suspects is fraud for up to four business days (FCA FG24/6, cited in
 *     docs/research/qed-research-intel/20261124-r12-task-baselines.md, T2): an upper bound, not a default. A day also ends
 *     the "act now" pressure a scam relies on and leaves time to ask someone. The cost: a large first payment to a new
 *     payee arrives a day later, unless the payee was added a day ahead.
 *   - The amount: ₹10,000, the size at which QED already asks for more (owner.ts STEP_UP_PAISE, approvals.ts
 *     PASSWORD_FREE_PAISE_PER_DAY), so everyday first payments go at once and a large one waits.
 *   - "New": added in the last 24 hours, the window the task named.
 * None of these figures comes from an Indian rule: no source in the workspace's research states one for first payments.
 *
 * A test stack (QED_TEST_STACK=1) may shorten the wait with QED_NEW_PAYEE_HOLD_SEC, and every sentence then says so.
 */
import { type Db, ist, whenIst } from './core.ts'
import type { Profile } from './household.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

/** A payee is new for its first 24 hours. */
export const NEW_FOR_MS = 24 * 3600_000
/** The default amount (₹10,000): what goes to a new payee above it waits. */
export const DEFAULT_HOLD_ABOVE = 1_000_000
/** The default wait, in hours. */
export const DEFAULT_HOLD_HOURS = 24
/** The waits a household may choose, in hours. */
export const HOLD_HOURS: readonly number[] = [1, 4, 12, 24, 48, 72]
/** No wait at all: the household switched it off (a loosening, so it takes effect only after the protection delay, R13). */
export const HOLD_OFF = 0
/** Whether a stored wait is one a household may have: a wait on the list, or none. */
export const isHoldHours = (h: unknown): h is number => h === HOLD_OFF || (typeof h === 'number' && HOLD_HOURS.includes(h))
/** Payments that ended without money leaving: they do not count towards what has gone to a payee. */
const ENDED = `('failed', 'cancelled', 'expired', 'blocked', 'rejected')`

/** A shortened wait on an isolated test stack only (QED_TEST_STACK=1 and QED_NEW_PAYEE_HOLD_SEC); null anywhere else. */
export function testHoldMs(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.QED_TEST_STACK !== '1') return null
  const v = Number(env.QED_NEW_PAYEE_HOLD_SEC)
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null
}

const hoursText = (h: number): string => `${h} hour${h === 1 ? '' : 's'}`
/** The wait as a length of time in words, with the test stack's shortening said. */
export function waitWords(profile: Pick<Profile, 'newPayeeHoldHours'>): string {
  const t = testHoldMs()
  return t === null ? hoursText(profile.newPayeeHoldHours) : `${Math.round(t / 1000)} seconds (shortened on this test installation; set to ${hoursText(profile.newPayeeHoldHours)})`
}
export const holdMsOf = (profile: Pick<Profile, 'newPayeeHoldHours'>): number => testHoldMs() ?? profile.newPayeeHoldHours * 3600_000

export interface PayeeAge { id: string; name: string; handle: string; createdAt: number }
export function payeeByHandle(db: Db, userId: string, handle: string): PayeeAge | undefined {
  return db.get<PayeeAge>('SELECT id, name, handle, created_at createdAt FROM payees WHERE user_id = ? AND handle = ?', userId, handle)
}
/** Whether an address is a third party rather than one of the household's own accounts at its bank. */
export const isThirdParty = (handle: string): boolean => !handle.endsWith('@paperbank')

/** Paise that have gone, or are on their way, to this address: every payment to it except those that ended with nothing sent. */
export function sentTo(db: Db, userId: string, handle: string, exceptActionId = ''): bigint {
  return db.all<{ a: string }>(`SELECT json_extract(params_json, '$.amount') a FROM actions WHERE user_id = ? AND kind = 'payment' AND json_extract(params_json, '$.payeeHandle') = ? AND state NOT IN ${ENDED} AND id <> ?`, userId, handle, exceptActionId)
    .reduce((t, r) => t + BigInt(r.a ?? '0'), 0n)
}

/** "today at 14:02", "yesterday at 23:40", or the date. */
export function addedWhen(createdAt: number, now: number): string {
  const at = ist(createdAt), today = ist(now).date
  if (at.date === today) return `today at ${at.hm}`
  if (at.date === ist(now - 86_400_000).date) return `yesterday at ${at.hm}`
  return `on ${whenIst(createdAt).replace(/ IST$/, '').replace(/, (\d\d:\d\d)$/, ' at $1')}`
}

export interface Hold { payee: PayeeAge; before: bigint; total: bigint; above: number; until: number; why: string }

/**
 * The wait a payment of `total` paise to `handle` must take before it is sent, or null when none applies: the payee was
 * added less than 24 hours ago, and what has gone or is on its way to it since, with this payment, comes to more than the
 * household's amount. An address that is not one of the household's payees (no path makes such a payment) is treated as
 * added now, so it waits too. `exceptActionId` leaves out the payment being decided. None while the household has
 * switched the wait off (HOLD_OFF), whatever a test stack's shortening says.
 */
export function holdFor(db: Db, userId: string, profile: Pick<Profile, 'newPayeeHoldAbove' | 'newPayeeHoldHours'>, handle: string, total: bigint, now: number, exceptActionId = ''): Hold | null {
  if (!isThirdParty(handle) || profile.newPayeeHoldHours === HOLD_OFF) return null
  const payee = payeeByHandle(db, userId, handle) ?? { id: '', name: handle, handle, createdAt: now }
  if (now - payee.createdAt >= NEW_FOR_MS) return null
  const before = sentTo(db, userId, handle, exceptActionId)
  if (before + total <= BigInt(profile.newPayeeHoldAbove)) return null
  const until = now + holdMsOf(profile)
  const why = `${payee.name} was added ${addedWhen(payee.createdAt, now)}, and in a payee's first 24 hours what you send it above ${homeMoneyExact(profile.newPayeeHoldAbove)} waits ${waitWords(profile)} before it is sent, as set in Safeguards.${before > 0n ? ` With the ${homeMoneyExact(before)} already paid or on its way to ${payee.name} since then, this comes to ${homeMoneyExact(before + total)}.` : ''}`
  return { payee, before, total, above: profile.newPayeeHoldAbove, until, why }
}

/** The warning a held payment's terms carry: the time it is sent, then why. */
export const holdWarning = (h: Hold): string => `It is sent at ${whenIst(h.until)}, not before: ${h.why} Until then you can cancel it on its record.`

/**
 * The first-payment caution, for a payee no payment has been completed to: the sentence Spend shows under the payee, now
 * also in the terms the passkey signs. Null for a payee paid before, or one of the household's own accounts.
 */
export function firstPaymentCaution(db: Db, userId: string, handle: string, now: number): string | null {
  if (!isThirdParty(handle)) return null
  const p = payeeByHandle(db, userId, handle)
  if (!p) return null
  if (db.get(`SELECT 1 FROM actions WHERE user_id = ? AND kind = 'payment' AND state = 'done' AND json_extract(params_json, '$.payeeHandle') = ? LIMIT 1`, userId, handle)) return null
  const when = addedWhen(p.createdAt, now)
  const recent = now - p.createdAt < NEW_FOR_MS
  return recent && (when.startsWith('today') || when.startsWith('yesterday'))
    ? `Added ${when.split(' at ')[0]}, and never paid before. Check the address with them yourself before you send.`
    : 'You have not paid this payee before. Check the address with them yourself before you send.'
}
