/**
 * Home's "Where your money is" sheet: what the household has, as parts, and what it owes. The parts are the server's
 * overview figures; their sum less what is owed is the net position (R13: reconcile to total assets).
 */
import type { Overview } from './types.ts'

type Parts = Pick<Overview, 'bank' | 'holdingsValue' | 'inTransit' | 'deposits' | 'setAside' | 'taxCredit' | 'paymentsInProgress' | 'card' | 'loans'>

/** Everything the sheet lists under "What you have" (paper money and investments; the test money on the chain is left out). */
export const haveTotal = (o: Parts): number => o.bank + o.holdingsValue + o.inTransit + o.deposits + o.setAside + o.taxCredit + o.paymentsInProgress
/** Everything listed under "What you owe". */
export const oweTotal = (o: Parts): number => o.card + o.loans
