/**
 * Close spellings for search (R12 task comparison, gap 9, T5-c): a word typed with a slip of the finger still finds the
 * name it was meant to be. Only words of letters are matched loosely, and only when long enough that one or two edits
 * leave them recognisable: none for 1 to 3 letters, one edit for 4 to 7, two for 8 or more. A swap of two neighbouring
 * letters ("Nari" for "Nair") counts as one edit (optimal string alignment). Figures are never matched loosely: an amount
 * off by one digit is another amount.
 */

/** The most edits a typed word may be from a name: 0 for 1 to 3 letters, 1 for 4 to 7, 2 for 8 or more. */
export const allowance = (word: string): number => { const n = [...word].length; return n >= 8 ? 2 : n >= 4 ? 1 : 0 }

/** A word made of letters only (any script; a vowel sign, as in Devanagari, is part of its word), the only kind matched loosely. */
export const isWord = (t: string): boolean => /^[\p{L}\p{M}]+$/u.test(t)

/**
 * Edits between two words: an insertion, a deletion, a change, or a swap of two neighbours, each one edit (optimal string
 * alignment). Counting stops once every way through exceeds `cap`, which is then returned plus one.
 */
export function editDistance(a: string, b: string, cap = Number.MAX_SAFE_INTEGER): number {
  const s = [...a], t = [...b]
  if (Math.abs(s.length - t.length) > cap) return cap + 1
  let prev2: number[] = [], prev = Array.from({ length: t.length + 1 }, (_, j) => j)
  for (let i = 1; i <= s.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
      cur[j] = v
      if (v < best) best = v
    }
    if (best > cap) return cap + 1
    prev2 = prev; prev = cur
  }
  return prev[t.length]!
}

/** The words of names, lower case, letters only: "Meera Nair" is ["meera", "nair"]. */
export const nameWords = (names: readonly string[]): string[] => [...new Set(names.flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{M}]+/u)).filter((w) => [...w].length > 1))]

/**
 * The name word a typed word is a close spelling of (fewest edits, the first of equals), or null: when the typed word is
 * not all letters, is shorter than 4, or no name word is within its allowance.
 */
export function closeTo(term: string, words: readonly string[]): string | null {
  const k = allowance(term)
  if (k === 0 || !isWord(term)) return null
  let best: string | null = null, bestD = k + 1
  for (const w of words) {
    if (Math.abs([...w].length - [...term].length) > k) continue
    const d = editDistance(term, w, k)
    if (d < bestD) { best = w; bestD = d }
  }
  return best
}
