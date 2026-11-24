/**
 * The length and layout of an IBAN, per country, in the manner of the IBAN registry (ISO 13616; its registration authority is
 * SWIFT). An IBAN's check digits (MOD 97-10) say nothing of its length: a valid-looking string of the wrong length for its
 * country is an account that does not exist.
 *
 * WHAT IS AND IS NOT READ FROM A PRIMARY SOURCE. The registry itself is SWIFT's (https://www.swift.com/standards/data-standards/iban-international-bank-account-number).
 * SWIFT's site answered HTTP 403 to automated reading on 24 Nov 2026, including its robots.txt, and no bot wall was bypassed. So:
 *  - Bahrain's row is read from the Central Bank of Bahrain's own IBAN standard page (https://www.cbb.gov.bh/iban/, read 24 Nov
 *    2026, page SHA-256 8d26513094713ad5e5b60ec5f6c01822f6621a9b10a5a724ac514efa5635e97b): "all IBANs have a fixed length of 22
 *    characters": country code, two check digits, a 4-letter bank identifier (the first four letters of the bank's BIC) and a
 *    14-character account number of digits or letters.
 *  - Every other row is the registry's structure as QED's research holds it, NOT VERIFIED against the registry's text. The
 *    screens say so beside the country, and nothing here is offered as the registry's own.
 * A row is data: replacing a row by the registry's own, once it can be read, changes no code.
 */
export interface IbanRow {
  /** Total length of the IBAN: country code, two check digits and the BBAN. */
  length: number
  /** The BBAN's layout in the registry's notation: "4!a14!c" is four letters then fourteen letters or digits, fixed length. */
  bban: string
  /** Who published this row, when it was read from a primary source; null when it has not been read from one. */
  verifiedBy: string | null
}

const NOT_READ = null
const CBB = 'Central Bank of Bahrain, IBAN standard for the Kingdom of Bahrain (https://www.cbb.gov.bh/iban/, read 24 Nov 2026, page SHA-256 8d26513094713ad5e5b60ec5f6c01822f6621a9b10a5a724ac514efa5635e97b)'

export const IBAN_REGISTRY: Readonly<Record<string, IbanRow>> = {
  GB: { length: 22, bban: '4!a6!n8!n', verifiedBy: NOT_READ },
  DE: { length: 22, bban: '8!n10!n', verifiedBy: NOT_READ },
  FR: { length: 27, bban: '5!n5!n11!c2!n', verifiedBy: NOT_READ },
  NL: { length: 18, bban: '4!a10!n', verifiedBy: NOT_READ },
  IE: { length: 22, bban: '4!a6!n8!n', verifiedBy: NOT_READ },
  ES: { length: 24, bban: '4!n4!n1!n1!n10!n', verifiedBy: NOT_READ },
  IT: { length: 27, bban: '1!a5!n5!n12!c', verifiedBy: NOT_READ },
  AE: { length: 23, bban: '3!n16!n', verifiedBy: NOT_READ },
  BH: { length: 22, bban: '4!a14!c', verifiedBy: CBB },
  CH: { length: 21, bban: '5!n12!c', verifiedBy: NOT_READ },
}

const KIND = { n: { re: /^\d+$/, words: 'digits' }, a: { re: /^[A-Z]+$/, words: 'letters' }, c: { re: /^[A-Z0-9]+$/, words: 'letters or digits' } } as const
const parts = (bban: string): { len: number; kind: keyof typeof KIND }[] => [...bban.matchAll(/(\d+)!([nac])/g)].map((m) => ({ len: Number(m[1]), kind: m[2] as keyof typeof KIND }))

/** Where a country's row comes from, for the screen and the refusal. */
export function ibanRegistryNote(country: string): string {
  const row = IBAN_REGISTRY[country]
  if (!row) return 'QED has no IBAN registry row for this country.'
  return row.verifiedBy
    ? `An IBAN here has ${row.length} characters (${row.verifiedBy}).`
    : `An IBAN here has ${row.length} characters (the IBAN registry's length, NOT VERIFIED: SWIFT's registry answered HTTP 403 to automated reading on 24 Nov 2026).`
}

/** The refusal for an IBAN (compact, upper case, with its country first) that does not fit its country's length and layout; null when it does. */
export function checkIbanLayout(iban: string): string | null {
  const country = iban.slice(0, 2)
  const row = IBAN_REGISTRY[country]
  if (!row) return null
  if (iban.length !== row.length) return `An IBAN in ${country} has ${row.length} characters; this one has ${iban.length}. Check it with the payee.`
  let at = 4
  for (const p of parts(row.bban)) {
    const chunk = iban.slice(at, at + p.len)
    if (!KIND[p.kind].re.test(chunk)) return `Characters ${at + 1} to ${at + p.len} of an IBAN in ${country} are ${KIND[p.kind].words}; these are not. Check it with the payee.`
    at += p.len
  }
  return null
}
