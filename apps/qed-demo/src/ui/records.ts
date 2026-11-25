/**
 * Words shared by the screens that show QED's records (Activity, Evidence, the record and its receipt): what kind of
 * evidence a case is, how a case or a receipt ended, and where a case's execution can be checked. Kept apart from the
 * screens so that Activity's folders can use them without the screens importing one another in a circle.
 */
import { needsAttention, NEEDS_ATTENTION, stateWord } from './kit.tsx'

export type Tone = 'ok' | 'wait' | 'void' | 'plain'

/** One case as the evidence list gives it (server/evidence.ts listCases). */
export interface CaseSummary { id: string; kind: 'vault-job' | 'standing-run' | 'model-call'; title: string; outcome: string; at: string | null; venue: 'local-chain' | 'ephemeral-chain' | 'paper' | 'none'; model: { label: string; provider: string; model: string } | null; standingAuthority: boolean }

export const CASE_KIND: Record<string, string> = { 'vault-job': 'On-chain wallet', 'standing-run': 'Standing instruction', 'model-call': 'Ask' }
export const CASE_OUTCOME: Record<string, [string, Tone]> = { executed: ['Completed', 'ok'], refused: ['Refused', 'void'], reverted: ['Reverted on the chain', 'void'], 'no-action': ['No action needed', 'plain'], invalid: ['Not valid', 'void'], done: ['Done', 'ok'], blocked: ['Refused', 'void'], failed: ['Failed', 'void'], drafted: ['Drafted', 'plain'], proposed: ['Proposed', 'plain'], answered: ['Answered', 'plain'] }
export const caseOutcome = (outcome: string): [string, Tone] => CASE_OUTCOME[outcome] ?? [outcome, 'plain']

/**
 * How a case's execution can be checked, in the owner's terms (R10): on the local test chain of this build (re-readable
 * while it runs), simulated on a paper venue, on a throwaway chain that is gone, or nothing sent at all.
 */
export function executionOf(venue: string): { word: string; says: string } {
  if (venue === 'local-chain') return { word: 'Local test chain', says: 'This build, on a chain on this QED installation; its transactions can be re-read while it runs' }
  if (venue === 'ephemeral-chain') return { word: 'Throwaway test chain', says: 'A chain made for one test and gone since; only its record remains' }
  if (venue === 'paper') return { word: 'Paper venue', says: 'Simulated by this installation with its own books; no exchange or bank was reached' }
  return { word: 'Nothing sent', says: 'No order, payment or transaction was sent anywhere' }
}

export const RECEIPT_TONE: Record<string, Tone> = { done: 'ok', released: 'ok', partial: 'wait', failed: 'void', blocked: 'void', rejected: 'void', reversed: 'void', cancelled: 'plain', expired: 'plain', refunded: 'plain', upheld: 'plain' }
export const RECEIPT_WORD: Record<string, string> = { blocked: 'Refused by QED\'s checks', released: 'Released', refunded: 'Refunded', upheld: 'Upheld', reversed: 'Reversed' }
/**
 * How a receipt says its action ended. A receipt whose reconciliation found the venue's record different from the
 * ledger is never "done" (R7-095): it says it needs attention, as the record and the activity list do.
 */
export function receiptOutcome(body: Record<string, unknown>): [string, Tone] {
  const out = String(body.outcome ?? '')
  const recon = (body.reconciliation as { state?: string } | undefined)?.state
  if (recon === 'break' || needsAttention(out, recon)) return [NEEDS_ATTENTION, 'void']
  return [RECEIPT_WORD[out] ?? stateWord(out), RECEIPT_TONE[out] ?? 'plain']
}

/**
 * Cases one after another with the same title, outcome, kind, place and proposer are one row (a standing policy refused
 * every five minutes is one fact seen six times); each of them stays one press away.
 */
export function groupCases<T extends CaseSummary>(cases: T[]): { lead: T; all: T[] }[] {
  const out: { lead: T; all: T[] }[] = []
  const sig = (c: T) => [c.title, c.outcome, c.kind, c.venue, c.model?.label ?? 'none', c.standingAuthority].join('\u0000')
  for (const c of cases) {
    const last = out[out.length - 1]
    if (last && sig(last.lead) === sig(c)) last.all.push(c)
    else out.push({ lead: c, all: [c] })
  }
  return out
}
