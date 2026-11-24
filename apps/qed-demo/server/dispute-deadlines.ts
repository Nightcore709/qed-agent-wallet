/**
 * The deadlines a person faces when they report a problem with a payment, by jurisdiction (N-018). QED informs; the account
 * provider decides, and nothing here promises an outcome. The rules are those read in the bank-agent terms research
 * (docs/research/qed-fin-infra-compliance/20261123-bank-agent-terms.md, section 4.5, sources B23, B24, B60 and B62, accessed
 * 23 Nov 2026): not legal advice, and counsel's review is EXT-06.
 *
 *   US consumer (Regulation E, 12 CFR 1005.6 and 1005.11): two business days after learning of a loss or theft; 60 days after
 *     the statement an error first appears on. The bank's investigation: 10 business days (45 days if it credits provisionally).
 *   India, a transaction before 1 Jan 2027 (RBI/2017-18/15): three working days for zero liability; the bank's shadow credit
 *     within 10 working days and resolution within 90 days.
 *   India, a transaction from 1 Jan 2027 (RBI/2026-27/167): five calendar days; the bank's resolution within 45 days.
 *
 * Business days are counted on QED's calendars (calendars.ts): India's with its holidays, the United States' on weekdays only,
 * without federal holidays, which is NOT VERIFIED against a holiday list. A report made on a holiday may have a later due
 * date than shown; the person should treat the date as the latest, and report sooner.
 */
import { addDays } from './core.ts'
import { addBusinessDays, CALENDARS } from './calendars.ts'
import { zonedParts } from '../shared/zone.ts'

export interface Deadline { id: string; party: 'you' | 'institution'; label: string; rule: string; dueDate: string | null; text: string; source: string }
export interface DeadlineInput { learnedAt: number; transactionAt: number; statementDate?: string }
export const INDIA_NEW_RULE_FROM = '2027-01-01'

const SOURCE_US = 'Regulation E, 12 CFR 1005.6 and 1005.11 (CFPB); read 23 Nov 2026'
const SOURCE_IN_OLD = 'RBI circular RBI/2017-18/15 of 6 Jul 2017, paras 5 to 12; read 23 Nov 2026'
const SOURCE_IN_NEW = 'RBI Third Amendment Directions, RBI/2026-27/167 of 24 Jun 2026, for transactions on or after 1 Jan 2027; read 23 Nov 2026'

export function deadlinesFor(jurisdiction: string, i: DeadlineInput): Deadline[] {
  if (jurisdiction === 'US') {
    const learned = zonedParts(i.learnedAt, CALENDARS.US!.zone).date
    const days = (n: number) => addBusinessDays(CALENDARS.US!, learned, n)
    return [
      { id: 'customer-report', party: 'you', label: 'Tell your bank about a loss or theft', rule: 'two business days', dueDate: days(2), source: SOURCE_US,
        text: `Two business days after you learned of it. Telling your bank within two business days is what limits what you can be asked to bear (the $50 tier); after that the limits are higher. Counted on weekdays only: federal holidays are not applied (NOT VERIFIED).` },
      i.statementDate
        ? { id: 'statement-error', party: 'you', label: 'Report an error on a statement', rule: '60 days after the statement', dueDate: addDays(i.statementDate, 60), source: SOURCE_US, text: `60 days after the periodic statement of ${i.statementDate}, the one the error first appears on.` }
        : { id: 'statement-error', party: 'you', label: 'Report an error on a statement', rule: '60 days after the statement', dueDate: null, source: SOURCE_US, text: 'No later than 60 days after the periodic statement the error first appears on. Enter that statement\'s date for the exact day.' },
      { id: 'institution-investigate', party: 'institution', label: 'Your bank investigates', rule: '10 business days', dueDate: days(10), source: SOURCE_US,
        text: 'If you tell your bank on the day you learned of it: it has 10 business days to investigate, or 45 days if it credits your account provisionally meanwhile. Your bank decides; QED does not and cannot.' },
    ]
  }
  if (jurisdiction === 'IN') {
    const zone = CALENDARS.IN!.zone
    const learned = zonedParts(i.learnedAt, zone).date, txDate = zonedParts(i.transactionAt, zone).date
    const fromNew = txDate >= INDIA_NEW_RULE_FROM
    return [
      fromNew
        ? { id: 'customer-report', party: 'you', label: 'Tell your bank about an unauthorised transaction', rule: 'five calendar days', dueDate: addDays(learned, 5), source: SOURCE_IN_NEW, text: 'Five calendar days after you received the communication of the transaction, for zero liability. Weekends and holidays count.' }
        : { id: 'customer-report', party: 'you', label: 'Tell your bank about an unauthorised transaction', rule: 'three working days', dueDate: addBusinessDays(CALENDARS.IN!, learned, 3), source: SOURCE_IN_OLD, text: 'Three working days after you received the communication of the transaction, for zero liability; later reports carry limited liability.' },
      ...(fromNew ? [] : [{ id: 'institution-credit', party: 'institution' as const, label: 'Your bank credits the amount in a shadow account', rule: '10 working days', dueDate: addBusinessDays(CALENDARS.IN!, learned, 10), source: SOURCE_IN_OLD, text: 'If you tell your bank on the day you learned of it: it credits the amount in 10 working days. Your bank decides; QED does not and cannot.' }]),
      { id: 'institution-resolve', party: 'institution', label: 'Your bank resolves the complaint', rule: fromNew ? '45 days' : '90 days', dueDate: addDays(learned, fromNew ? 45 : 90), source: fromNew ? SOURCE_IN_NEW : SOURCE_IN_OLD, text: `If you tell your bank on the day you learned of it: within ${fromNew ? '45 days (60 for a cross-border transaction)' : '90 days'}. Your bank decides; QED does not and cannot.` },
    ]
  }
  return [{ id: 'none', party: 'you', label: 'No deadline is written for this jurisdiction', rule: 'none', dueDate: null, source: 'none', text: 'QED has not read the rules for this jurisdiction (NOT VERIFIED). Report to your account provider as soon as you can; the provider\'s agreement and the law of your country set the time.' }]
}

/** Where a person goes if their account provider does not resolve it. QED informs; it never decides. */
export function escalationFor(jurisdiction: string): { text: string; source: string } {
  if (jurisdiction === 'US') return { text: 'If your bank does not resolve it, you can complain to the CFPB (the Consumer Financial Protection Bureau\'s complaint portal) and to your state regulator.', source: 'CFPB; read 23 Nov 2026' }
  if (jurisdiction === 'IN') return { text: 'If your bank does not resolve it, you can complain to the RBI Ombudsman under the Reserve Bank\'s Integrated Ombudsman Scheme, and report cyber fraud on the national helpline 1930 or the cybercrime portal.', source: 'RBI; read 23 Nov 2026' }
  return { text: 'If your account provider does not resolve it, ask it for the name of its ombudsman or regulator. QED has not read this jurisdiction\'s route (NOT VERIFIED).', source: 'none' }
}
