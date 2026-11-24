/**
 * Look-alike payees (adversarial corpus X01, RISK-073). The usual shape of an induced transfer is a payee that imitates
 * one the owner already pays: "BЕSCOМ Electricity" written with Cyrillic Е and М at bescom.power@okaxls, beside the real
 * BESCOM Electricity at bescom.power@okaxis. A model, a message or a caller only has to get the owner to add it once.
 *
 * Names and addresses are compared on a skeleton in the manner of Unicode TR39 (letters from other alphabets that look
 * Latin, digits that look like letters, "rn" for "m", accents and invisible characters removed), and addresses also on
 * edit distance. It is a warning, not a refusal: a household may have two payees with similar addresses. So adding one
 * needs the owner to confirm they checked it, and wherever it would be paid, QED says what it looks like.
 */
import type { Db } from './core.ts'

/** Capitals that look like a Latin letter, mapped before lower-casing (Greek capital eta looks like H, its small form like n). */
const UPPER: Record<string, string> = {
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', Х: 'x', У: 'y', Ѕ: 's', І: 'l', Ј: 'j', Ӏ: 'l',
  Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'l', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x', I: 'l',
}
/** Small letters and digits that look like a Latin letter. */
const LOWER: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's',
  ј: 'j', һ: 'h', ӏ: 'l', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g', α: 'a', ο: 'o', ρ: 'p', ν: 'v', τ: 't', ι: 'l', κ: 'k', χ: 'x', υ: 'u',
  ε: 'e', ω: 'w', '0': 'o', '1': 'l', '|': 'l', '5': 's',
  // i, l, 1 and capital I are one letter: in many faces they differ by a dot or a serif, and "ELECTRICITY" written in
  // capitals must have the same skeleton as "Electricity" (review finding 4)
  i: 'l', і: 'l', ї: 'l',
}
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯﻿]/gu

/** What a reader would see: the same skeleton means the two strings can look identical. */
export function skeleton(s: string): string {
  // Remembered: a check over n named payees asks for the skeleton of each of the others n times (R13 review, R10).
  const known = skeletons.get(s)
  if (known !== undefined) return known
  const flat = s.normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE, '')
  let out = ''
  for (const ch of flat) { const up = UPPER[ch]; if (up) { out += up; continue } const low = ch.toLowerCase(); out += LOWER[low] ?? low }
  const sk = out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[^\p{L}\p{N}]/gu, '')
  if (skeletons.size >= 20_000) skeletons.clear()
  skeletons.set(s, sk)
  return sk
}
const skeletons = new Map<string, string>()

/** A word that mixes Latin letters with Cyrillic or Greek ones, or Cyrillic with Greek: how a look-alike name is made. */
export function mixedScript(name: string): boolean {
  return name.split(/\s+/).some((w) => {
    const latin = /\p{Script=Latin}/u.test(w), cyr = /\p{Script=Cyrillic}/u.test(w), greek = /\p{Script=Greek}/u.test(w)
    return (latin && (cyr || greek)) || (cyr && greek)
  })
}

/**
 * Edit distance with adjacent transpositions (optimal string alignment), exact up to the cap; anything larger is
 * cap + 1. Only cells within the cap of the diagonal are computed, and it stops at a row with nothing at or under the
 * cap: the full table cost about 0.2 ms a pair, so a bills instruction naming 120 payees held the API's thread for
 * seconds (R13 review, R10). Every caller compares the result with a number at or under its cap.
 */
export function distance(a: string, b: string, cap = 3): number {
  const A = [...a], B = [...b], OVER = cap + 1
  if (Math.abs(A.length - B.length) > cap) return OVER
  let prev2: number[] = [], prev = Array.from({ length: B.length + 1 }, (_, j) => Math.min(j, OVER))
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array<number>(B.length + 1).fill(OVER)
    cur[0] = Math.min(i, OVER)
    let least = cur[0]
    for (let j = Math.max(1, i - cap), last = Math.min(B.length, i + cap); j <= last; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = Math.min(v, OVER)
      if (cur[j]! < least) least = cur[j]!
    }
    if (least > cap) return OVER
    prev2 = prev; prev = cur
  }
  return prev[B.length]!
}

export interface PayeeLike { name: string; handle: string }
export interface Lookalike { name: string; handle: string; why: string[] }

/** The owner's other payees that this one could be mistaken for, each with why, in plain words. */
export function lookalikes(p: PayeeLike, others: readonly PayeeLike[]): Lookalike[] {
  const handle = p.handle.toLowerCase(), [local = '', bank = ''] = handle.split('@')
  const name = skeleton(p.name), mixed = mixedScript(p.name)
  const out: Lookalike[] = []
  for (const o of others) {
    const oh = o.handle.toLowerCase()
    if (oh === handle) continue
    const [oLocal = '', oBank = ''] = oh.split('@')
    const why: string[] = []
    const oName = skeleton(o.name), sameName = name.length > 0 && oName === name
    if (sameName && p.name.normalize('NFC').toLowerCase() !== o.name.normalize('NFC').toLowerCase()) why.push(mixed ? 'its name uses letters from another alphabet that look like the Latin ones' : 'its name looks the same, written with different characters')
    else if (sameName) why.push('it has the same name, at a different address')
    else if (name.length >= 6 && distance(name, oName, 1) === 1) why.push('its name differs by one character')
    const sl = skeleton(local), so = skeleton(oLocal)
    const lookSame = sl === so && skeleton(bank) === skeleton(oBank)
    const d = distance(handle, oh, 2)
    if (lookSame) why.push(`its address looks the same, written with look-alike characters (${handle}, not ${oh})`)
    else if (d <= (handle.length >= 10 ? 2 : 1)) why.push(`its address differs by ${d === 1 ? 'one character' : 'two characters'} (${handle}, not ${oh})`)
    else if (sl.length >= 4 && sl === so) why.push(`its address has the same name at a different bank (@${bank}, not @${oBank})`)
    else if (sl.length >= 6 && bank !== oBank && distance(sl, so, 1) === 1) why.push(`its address has nearly the same name at a different bank (@${bank}, not @${oBank})`)
    if (why.length) out.push({ name: o.name, handle: o.handle, why })
  }
  return out
}

function joinWhy(why: string[]): string { return why.length <= 1 ? (why[0] ?? '') : `${why.slice(0, -1).join(', ')} and ${why.at(-1)!}` }

/** One sentence for a payment or an instruction that pays this payee; null when it resembles none of the others. */
export function lookalikeWarning(p: PayeeLike, others: readonly PayeeLike[]): string | null {
  const sims = lookalikes(p, others)
  if (sims.length) {
    const s = sims[0]!
    return `${p.name} (${p.handle}) looks like ${s.name} (${s.handle}), another of your payees: ${joinWhy(s.why)}.${sims.length > 1 ? ` It also resembles ${sims.slice(1).map((x) => `${x.name} (${x.handle})`).join(', ')}.` : ''} A look-alike payee is a common way to divert a payment; check that this is the one you mean.`
  }
  return mixedScript(p.name) ? `The name ${p.name} (${p.handle}) mixes letters from two alphabets, which is how a look-alike name is made. Check that this is the payee you mean.` : null
}

/** The warning for one of the owner's payees against all their others. */
export function payeeWarning(db: Db, userId: string, p: PayeeLike): string | null {
  return lookalikeWarning(p, db.all<PayeeLike>('SELECT name, handle FROM payees WHERE user_id = ? AND handle <> ?', userId, p.handle))
}

/** What adding this payee would need the owner to confirm, or null. */
export function addWarning(p: PayeeLike, others: readonly PayeeLike[]): { message: string; similar: string[] } | null {
  const sims = lookalikes(p, others), mixed = mixedScript(p.name)
  if (!sims.length && !mixed) return null
  const first = sims[0]
  const what = first
    ? `This payee looks like one you already have: ${first.name} (${first.handle}). ${joinWhy(first.why).replace(/^./, (c) => c.toUpperCase())}.`
    : 'This payee\'s name mixes letters from two alphabets, which is how a look-alike name is made.'
  return { message: `${what} If a message, a call or anyone else asked you to add it, it may be a fraud: check the address with the payee directly, then confirm.`, similar: sims.map((s) => s.handle) }
}
