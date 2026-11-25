/**
 * How long a resting order stands, and what its end looked like, in the household's own zone and currency (R14, capability 13).
 * The terms are the order's own signed validity (server/validity.ts); the end is the engine's recorded result (server/execute.ts).
 * Money goes through fmt.money, never a typed currency sign.
 */
import { fmt } from './core.ts'
import type { ActionView } from './types.ts'

type Validity = { kind: 'gtc' } | { kind: 'day' | 'until'; expiresAt: number }
const num = (v: unknown): number => Number(v ?? 0)
const validityOf = (a: Pick<ActionView, 'params'>): Validity | null => {
  const v = a.params.validity as Validity | undefined
  return v && (v.kind === 'gtc' || (typeof v.expiresAt === 'number' && (v.kind === 'day' || v.kind === 'until'))) ? v : null
}
/** A moment with its zone ("18 Nov 2026, 11:00 IST"), the date always included. */
export const atText = (ms: number): string => fmt.at(ms)

/** "Stands until 18 Nov 2026, 11:00 IST" for a resting order still open; null when it is not a resting order or has ended. */
export function standsUntilLine(a: Pick<ActionView, 'kind' | 'state' | 'params'>): string | null {
  if (a.kind !== 'order' || a.params.type !== 'limit') return null
  if (!['planned', 'submitting', 'working', 'awaiting_approval'].includes(a.state)) return null
  const v = validityOf(a)
  if (v && v.kind === 'day') return `Stands until the end of ${fmt.dayYear(v.expiresAt - 1)} (midnight ${fmt.at(v.expiresAt).split(' ').pop()})`
  return v && v.kind !== 'gtc' ? `Stands until ${atText(v.expiresAt)}` : 'Stands until you cancel it'
}

/**
 * "Expired at 18 Nov 2026, 11:00 IST, ₹3,269.18 filled before, ₹1,730.82 released". A sale says what it brought in, not what
 * "filled": the quantity set aside comes back, so that is what it names.
 */
export function expiredLine(a: Pick<ActionView, 'state' | 'result' | 'params' | 'instrument'>): string | null {
  if (a.result.expired !== true || (a.state !== 'expired' && a.state !== 'partial')) return null
  const at = num(a.result.expiredAt)
  const sale = a.result.releasedPaise === undefined || a.result.releasedPaise === null
  const money = fmt.money(num(a.result.filledQty) > 0 ? num(a.result.movedPaise) : 0, true)
  const released = !sale
    ? fmt.money(num(a.result.releasedPaise), true)
    : `${(num(a.result.releasedQty) / 10 ** (a.instrument?.baseScale ?? 0)).toLocaleString('en-IN', { maximumFractionDigits: a.instrument?.baseScale ?? 0 })} ${a.instrument?.baseAsset ?? ''}`.trim()
  return `Expired at ${atText(at)}, ${money} ${sale ? 'brought in' : 'filled'} before, ${released} released`
}
