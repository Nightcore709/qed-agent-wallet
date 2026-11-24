/**
 * Four ways to tamper with an evidence case, used by the tests (server/evidence-verify.test.ts) and by the judge journey
 * to show that verification fails, and with what message. Each returns a changed copy and says what it changed. A
 * tampered copy can also be resealed (every hash recomputed, as a forger would), which only internal consistency or an
 * external anchor can then catch.
 */
import { type EvidenceCase, sealCase } from './evidence-verify.ts'

type Json = Record<string, any>
const copy = (c: EvidenceCase): EvidenceCase => JSON.parse(JSON.stringify(c)) as EvidenceCase
export interface Tampered { case: EvidenceCase; what: string }

/** Add one unit to the first amount that moved (section 5). */
export function changeAmount(c: EvidenceCase): Tampered | null {
  const t = copy(c), m = (t.sections['5'] as Json).moved?.[0]
  if (!m) return null
  m.amount = String(BigInt(m.amount) + 1n)
  return { case: t, what: `section 5: "${m.what}" raised by one unit to ${m.amount}` }
}
/** Drop the first refusal of this case from section 8 (or, if it has none, the first related refusal). */
export function dropRefusal(c: EvidenceCase): Tampered | null {
  const t = copy(c), s8 = t.sections['8'] as Json
  if (s8.thisCase?.length) { const x = s8.thisCase.shift(); return { case: t, what: `section 8: dropped this case's refusal "${String(x.check)}"` } }
  if (s8.related?.length) { const x = s8.related.shift(); return { case: t, what: `section 8: dropped the related refusal ${String(x.caseId)}` } }
  return null
}
/** Swap a transaction hash for another (section 6), or a receipt hash where there is no transaction (section 5). */
export function swapHash(c: EvidenceCase, other = `0x${'ab'.repeat(32)}`): Tampered | null {
  const t = copy(c), tx = (t.sections['6'] as Json).transactions?.[0]
  if (tx) { const was = tx.hash; tx.hash = other; return { case: t, what: `section 6: transaction ${String(was).slice(0, 10)}… replaced by ${other.slice(0, 10)}…` } }
  const r = (t.sections['5'] as Json).receipts?.[0]
  if (r) { const was = r.hash; r.hash = other.replace(/^0x/, ''); return { case: t, what: `section 5: receipt ${String(r.id)} hash ${String(was).slice(0, 10)}… replaced` } }
  return null
}
/** Swap two adjacent steps (section 3), or two adjacent receipts of the chain where there are no steps. */
export function reorderSteps(c: EvidenceCase): Tampered | null {
  const t = copy(c), steps = (t.sections['3'] as Json).steps
  if (Array.isArray(steps) && steps.length >= 3) { [steps[1], steps[2]] = [steps[2], steps[1]]; return { case: t, what: `section 3: steps "${String(steps[2].key)}" and "${String(steps[1].key)}" swapped` } }
  const e = (t.verification as Json).receiptChain?.entries
  if (Array.isArray(e) && e.length >= 2) { [e[e.length - 2], e[e.length - 1]] = [e[e.length - 1], e[e.length - 2]]; return { case: t, what: 'verification: the last two receipts of the chain swapped' } }
  return null
}
export const TAMPERS = { changeAmount, dropRefusal, swapHash, reorderSteps } as const
/** What a forger would do next: recompute every hash so that the hashes match the changed content. */
export const reseal = (c: EvidenceCase): EvidenceCase => sealCase(c)
