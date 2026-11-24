/**
 * Look-alike payees abroad (adversarial corpus X01, RISK-073; R13 second pass). The domestic check (lookalike.ts) compares a
 * payee's name and its address with the owner's others. A payee abroad has no address but an account, so the same three
 * comparisons are made on its NAME (the same skeleton, letters of another alphabet, one character apart), its IBAN (one or two
 * characters apart, compared without the check digits that every change moves) and its ACCOUNT (the same account number at a
 * different bank or routing number, an account number one or two characters apart). It is a warning, not a refusal: adding such
 * a payee needs the owner's confirmation, and every payment to it says what it looks like.
 */
import { distance, mixedScript, skeleton } from './lookalike.ts'

export interface ForeignPayeeLike { name: string; country: string; scheme: 'iban' | 'aba' | 'bic-account'; account: string; bank: string | null }
export interface ForeignLookalike { name: string; account: string; why: string[]; id?: string }

/** The account in two parts for comparison: where it is held (the bank) and which account it is. */
function parts(p: ForeignPayeeLike): { bank: string; number: string } {
  if (p.scheme === 'iban') return { bank: p.account.slice(4, 12), number: p.account.slice(-10) } // the bank's code leads the BBAN; the account number ends it
  if (p.scheme === 'aba') { const [routing = '', number = ''] = p.account.split(' '); return { bank: routing, number } }
  return { bank: p.bank ?? '', number: p.account }
}
const chars = (d: number): string => (d === 1 ? 'one character' : 'two characters')

/** The owner's other payees abroad that this one could be mistaken for, each with why, in plain words. */
export function foreignLookalikes(p: ForeignPayeeLike, others: readonly (ForeignPayeeLike & { id?: string })[]): ForeignLookalike[] {
  const name = skeleton(p.name), mixed = mixedScript(p.name), mine = parts(p)
  const out: ForeignLookalike[] = []
  for (const o of others) {
    if (o.account === p.account && o.country === p.country) continue
    const why: string[] = []
    const oName = skeleton(o.name), sameName = name.length > 0 && oName === name
    if (sameName && p.name.normalize('NFC').toLowerCase() !== o.name.normalize('NFC').toLowerCase()) why.push(mixed ? 'its name uses letters from another alphabet that look like the Latin ones' : 'its name looks the same, written with different characters')
    else if (sameName) why.push('it has the same name, at a different account')
    else if (name.length >= 6 && distance(name, oName, 1) === 1) why.push('its name differs by one character')
    const theirs = parts(o)
    if (p.scheme === 'iban' && o.scheme === 'iban') {
      const a = p.account.slice(4), b = o.account.slice(4) // without the country code and check digits
      const d = distance(a, b, 2)
      if (p.account.slice(0, 2) === o.account.slice(0, 2) && d >= 1 && d <= 2) why.push(`its IBAN differs by ${chars(d)}`)
    }
    if (p.scheme === o.scheme && p.country === o.country) {
      const d = distance(mine.number, theirs.number, 2)
      if (mine.number === theirs.number && mine.bank !== theirs.bank) why.push('it has the same account number at a different bank')
      else if (p.scheme !== 'iban' && mine.bank === theirs.bank && d >= 1 && d <= (mine.number.length >= 8 ? 2 : 1)) why.push(`its account number differs by ${chars(d)}`)
    }
    if (why.length) out.push({ name: o.name, account: o.account, why, ...(o.id ? { id: o.id } : {}) })
  }
  return out
}

const joinWhy = (why: string[]): string => (why.length <= 1 ? (why[0] ?? '') : `${why.slice(0, -1).join(', ')} and ${why.at(-1)!}`)
const tail = (a: string): string => `•••• ${a.replace(/\s/g, '').slice(-4)}`

/** One sentence for an addition or a payment; null when the payee resembles none of the others. */
export function foreignLookalikeWarning(p: ForeignPayeeLike, others: readonly (ForeignPayeeLike & { id?: string })[]): string | null {
  const sims = foreignLookalikes(p, others)
  if (sims.length) {
    const s = sims[0]!
    return `${p.name} (${tail(p.account)}) looks like ${s.name} (${tail(s.account)}), another of your payees abroad: ${joinWhy(s.why)}.${sims.length > 1 ? ` It also resembles ${sims.slice(1).map((x) => `${x.name} (${tail(x.account)})`).join(', ')}.` : ''} A look-alike payee is a common way to divert a payment; check the account with the payee directly.`
  }
  return mixedScript(p.name) ? `The name ${p.name} (${tail(p.account)}) mixes letters from two alphabets, which is how a look-alike name is made. Check that this is the payee you mean.` : null
}
