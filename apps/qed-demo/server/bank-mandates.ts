/**
 * The paper bank's standing debit mandates: a simulated institution (R13 Spend, audit finding S7). Nothing here is a real
 * bank. When an instruction that pays bills goes live, the paper bank is told and answers with a reference of its own; when
 * the instruction is revoked, the paper bank is asked to end the mandate and its answer (or its silence) is what QED records.
 * The bank is a small interface so that a test, or a later real adapter, can make it slow, silent or refusing; the local
 * one answers at once and never refuses.
 */
import { assertNoWider, type ChannelTerms, derive, PAPER_CEILINGS, recordChannelTerms, type Signed } from './channel-terms.ts'
import { type Db, newId, refused } from './core.ts'

export interface PaperBankAnswer { acknowledged: boolean; reference?: string }
export interface PaperBankMandates {
  /** Register a mandate for an instruction; the bank answers with its own reference. Given terms, the bank applies its own ceilings (N-004). */
  register(localId: string, terms?: ChannelTerms): { reference: string }
  /** Ask the bank to end the mandate with this reference. Asking again is the same request. */
  revoke(reference: string): PaperBankAnswer
}

/** The local simulated bank. Its references are its own ("PB-MANDATE-…" and "PB-REVOKE-…"), never a real bank's. */
export class LocalPaperBank implements PaperBankMandates {
  register(localId: string, terms?: ChannelTerms): { reference: string } {
    // a bank applies a mandate's own limits whatever other limits its customer has set, so it refuses terms above its ceilings
    const c = terms ? PAPER_CEILINGS[terms.channel] : null
    if (terms && c && ((c.perPayment !== null && (terms.perPayment ?? 0) > c.perPayment) || (c.perMonth !== null && (terms.perMonth ?? 0) > c.perMonth))) throw refused('bank_ceiling', 'The paper bank (a simulated institution) refuses a mandate above its own ceilings.')
    return { reference: `PB-MANDATE-${localId.slice(-8).toUpperCase()}` }
  }
  revoke(reference: string): PaperBankAnswer { return { acknowledged: true, reference: reference.replace('PB-MANDATE-', 'PB-REVOKE-') } }
}
let bank: PaperBankMandates = new LocalPaperBank()
export const paperBank = (): PaperBankMandates => bank
/** Replace the paper bank (tests make it silent). Returns what it replaced. */
export function setPaperBank(next: PaperBankMandates): PaperBankMandates { const was = bank; bank = next; return was }

/** Instruction kinds that debit the household's bank account for a third party, so that a mandate stands behind them. */
export const MANDATE_KINDS: ReadonlySet<string> = new Set(['bills'])

/** Register the paper bank's mandate for an instruction that has just gone live; once per instruction, whatever its versions. */
export function registerPaperMandate(db: Db, userId: string, programId: string, kind: string, now: number, signed?: Signed): void {
  if (!MANDATE_KINDS.has(kind) || db.get('SELECT 1 FROM paper_mandates WHERE user_id = ? AND program_id = ?', userId, programId)) return
  const id = newId('pmd', now)
  // The mandate's terms come from the signed instruction and are never wider than it: its payment maximum, monthly limit, expiry and
  // payees are the instruction's own, narrowed to the bank's ceilings (N-004, N-016; server/channel-terms.ts).
  const terms = signed ? derive('e-mandate', signed, now) : undefined
  if (terms && signed) assertNoWider(terms, signed)
  const reference = bank.register(id, terms).reference
  db.run(`INSERT INTO paper_mandates (id, user_id, program_id, reference, state, registered_at) VALUES (?, ?, ?, ?, 'active', ?)`, id, userId, programId, reference, now)
  if (terms && signed) recordChannelTerms(db, userId, programId, 'paper-rail', terms, signed, reference, now)
}
