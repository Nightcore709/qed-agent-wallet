/**
 * The paper bank's name check: Confirmation of Payee, on paper (R12 task comparison, gap 4; criteria T2-a and T2-b).
 *
 * A real rail asks the payee's bank, before a new payee is added or paid, for the name it holds for the address: the UK's
 * Confirmation of Payee (Pay.UK; used when paying "an account they have not previously paid in to"), the EU's
 * Verification of Payee (mandatory for euro credit transfers since 9 October 2025) and UPI's validation of the name at
 * an address (apps show only the bank-registered name). Each answers one of four ways: a match; a close match, with the
 * name the bank holds, which the payer may adopt; no match, which does not say the name; or could not check
 * (docs/research/qed-research-intel/20261124-r12-task-baselines.md, T2; -20261118-interaction-pattern-research.md, C9).
 *
 * QED reaches no bank. This is the paper bank's own directory: small and deterministic, so that every outcome can be
 * tried by hand and tested. It holds the test addresses the Spend form documents, a few billers and people for the other
 * outcomes, and one address whose check does not answer. Any other address is one the paper bank does not know: could
 * not check. The household text says "the paper bank" every time; nothing here claims a real bank confirmed a name.
 */
import { distance } from './lookalike.ts'

/** match, close match, no match, and the two ways a check cannot be made: an address the paper bank does not know, or no answer. */
export type NameOutcome = 'match' | 'close' | 'no_match' | 'unknown' | 'no_answer'
/** The name the paper bank holds is given on a match and a close match, never on no match (as banks' name checks do). */
export interface NameCheck { outcome: NameOutcome; registeredName: string | null }

/** Address -> the name the paper bank holds for it. */
export const PAPER_DIRECTORY: ReadonlyMap<string, string> = new Map([
  // the paper rail's test addresses (server/venues.ts PaperRail; the Spend form lists them)
  ['decline@paper', 'Decline Test Account'],
  ['slow@paper', 'Slow Test Account'],
  ['timeout@paper', 'Timeout Test Account'],
  ['reverse@paper', 'Reverse Test Account'],
  ['refund@paper', 'Refund Test Account'],
  // billers and people, so that a match, a close match and no match can each be had on paper
  ['bescom.power@okaxis', 'BESCOM Electricity'],
  ['citypower@paper', 'City Power'],
  ['ravi.kumar@upi', 'Ravi Kumar'],
  ['meera.nair@upi', 'Meera Nair'],
  ['sunrise.rent@okhdfc', 'Sunrise Apartments'],
])
/** Addresses whose check does not answer: a name check that is down, on paper. */
export const NO_ANSWER: ReadonlySet<string> = new Set(['nocheck@paper'])

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari'])

/** How the check compares names: one script of letters and digits, lower case, without accents, punctuation or a title. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter((t) => t && !TITLES.has(t)).join(' ')
}

/**
 * How a typed name agrees with the name the bank holds. Close: one letter off in a short name or two in a longer one (the
 * same edit distance the look-alike check uses), the same words in another order, an initial for a word, or every word of
 * the shorter name in the longer one with at least two shared. Anything else is no match.
 */
export function nameAgreement(typed: string, registered: string): 'match' | 'close' | 'no_match' {
  const a = normalizeName(typed), b = normalizeName(registered)
  if (!a || !b) return 'no_match'
  if (a === b) return 'match'
  const ta = a.split(' '), tb = b.split(' ')
  const sorted = (t: string[]) => [...t].sort().join(' ')
  if (sorted(ta) === sorted(tb)) return 'close'
  const shortest = Math.min(a.length, b.length)
  if (shortest >= 4 && distance(a, b, 2) <= (shortest >= 8 ? 2 : 1)) return 'close'
  if (ta.length === tb.length && ta.length >= 2) {
    let full = 0
    const each = ta.every((x, i) => { const y = tb[i]!; if (x === y) { full++; return true } return (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y)) })
    if (each && full >= 1) return 'close'
  }
  const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)]
  if (small.length >= 2 && small.every((t) => big.has(t))) return 'close'
  return 'no_match'
}

/** Ask the paper bank for the name behind an address and compare it with the name the household gave. */
export function checkPayeeName(name: string, handle: string): NameCheck {
  const h = handle.trim().toLowerCase()
  if (NO_ANSWER.has(h)) return { outcome: 'no_answer', registeredName: null }
  const held = PAPER_DIRECTORY.get(h)
  if (held === undefined) return { outcome: 'unknown', registeredName: null }
  const agree = nameAgreement(name, held)
  return { outcome: agree, registeredName: agree === 'no_match' ? null : held }
}

export const couldNotCheck = (o: NameOutcome | null | undefined): boolean => o === 'unknown' || o === 'no_answer'
const OUTCOMES: ReadonlySet<string> = new Set(['match', 'close', 'no_match', 'unknown', 'no_answer'])
export const isNameOutcome = (v: unknown): v is NameOutcome => typeof v === 'string' && OUTCOMES.has(v)

/**
 * Where the answer comes from, and what it cannot tell (R13 section 4: local name matching is not verification by a
 * financial institution). The directory is PAPER_DIRECTORY above, on this computer; nothing is asked of a bank or of NPCI.
 */
export const NAME_CHECK_LIMITS = 'It can say only whether a name matches the one held for the address, not who controls the account or whether someone is pressing you to pay.'
const PAPER = `Made when the payee was added, against the paper bank's own directory on this computer; no real bank or NPCI was asked. ${NAME_CHECK_LIMITS}`
/**
 * The check as a line of a payment's terms and of the payee: what the paper bank answered, and in the note whose check it
 * was. `outcome` null is a payee added before QED checked names.
 */
export function nameCheckWords(outcome: NameOutcome | null, registered: string | null, typed: string): { value: string; note: string } {
  const yours = 'You said you checked the address with the payee yourself.'
  switch (outcome) {
    case 'match': return { value: `Matches the name the paper bank holds for this address: ${registered ?? typed}`, note: PAPER }
    case 'close': return { value: `Close match: the paper bank holds ${registered ?? 'another name'} for this address`, note: `${normalizeName(typed) === normalizeName(registered ?? '') ? '' : `You kept the name you gave, ${typed}, and said you checked the address with the payee yourself. `}${PAPER}` }
    case 'no_match': return { value: 'No match: the paper bank holds another name for this address', note: `It does not say which, as banks' name checks do not. ${yours} ${PAPER}` }
    case 'unknown': return { value: 'Could not check: the paper bank does not know this address', note: `${yours} ${PAPER}` }
    case 'no_answer': return { value: 'Could not check: the paper bank\'s name check did not answer', note: `${yours} ${PAPER}` }
    default: return { value: 'Not checked: this payee was added before QED checked names', note: 'No name check was made for it, on paper or otherwise. Check the address with them yourself before you send.' }
  }
}

/**
 * What to do about the answer, for the form that already shows the name given beside the name the paper bank holds (so the
 * names are not said twice): null on a match.
 */
export function nameCheckAdvice(o: NameOutcome): string | null {
  const end = 'It is the paper bank\'s own directory on this computer: no real bank or NPCI was asked, and it cannot tell who controls the account or whether someone is pressing you to pay.'
  switch (o) {
    case 'match': return null
    case 'close': return `Use its name if this is who you mean to pay; to keep yours, say you checked the address with the payee yourself. ${end}`
    case 'no_match': return `Money sent there goes to whoever holds the address, whatever name you give it. If a message, a call or anyone else gave you this address, it may be a fraud: check it with the payee directly. ${end}`
    case 'unknown': return `It does not know this address, so it could not check the name behind it. Check the address with the payee yourself before you add it. ${end}`
    case 'no_answer': return `Its name check did not answer, so the name behind the address was not checked. Check the address with the payee yourself before you add it. ${end}`
  }
}

/** What adding a payee needs the owner to see and confirm, in a sentence or two: null on a match. */
export function nameCheckAddMessage(c: NameCheck, typed: string, handle: string): string | null {
  const end = 'It is the paper bank\'s own directory on this computer: no real bank or NPCI was asked, and it cannot tell who controls the account or whether someone is pressing you to pay.'
  switch (c.outcome) {
    case 'match': return null
    case 'close': return `The paper bank holds a slightly different name for ${handle}: ${c.registeredName}, not ${typed}. Use its name if this is who you mean to pay; to keep yours, say you checked the address with the payee yourself. ${end}`
    case 'no_match': return `The name you gave, ${typed}, does not match the name the paper bank holds for ${handle}. Money sent there goes to whoever holds the address, whatever name you give it. If a message, a call or anyone else gave you this address, it may be a fraud: check it with the payee directly. ${end}`
    case 'unknown': return `The paper bank does not know ${handle}, so it could not check the name behind it. Check the address with the payee yourself before you add it. ${end}`
    case 'no_answer': return `The paper bank's name check did not answer for ${handle}, so the name behind it was not checked. Check the address with the payee yourself before you add it. ${end}`
  }
}
