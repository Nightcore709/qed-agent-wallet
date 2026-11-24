/**
 * Close spellings (src/lib/fuzzy.ts): edits between words with a swap of neighbours counted as one, the allowance by
 * length (none under 4 letters, one for 4 to 7, two for 8 or more), and only words of letters matched loosely.
 */
import { describe, expect, it } from 'vitest'
import { allowance, closeTo, editDistance, isWord, nameWords } from './fuzzy.ts'

describe('edits between two words', () => {
  it('counts an insertion, a deletion, a change and a swap of neighbours as one each', () => {
    expect(editDistance('nair', 'nair')).toBe(0)
    expect(editDistance('bitcon', 'bitcoin')).toBe(1) // a letter left out
    expect(editDistance('meeera', 'meera')).toBe(1) // one too many
    expect(editDistance('neera', 'meera')).toBe(1) // the first letter wrong
    expect(editDistance('nari', 'nair')).toBe(1) // two neighbours swapped
    expect(editDistance('elektrcity', 'electricity')).toBe(2)
    expect(editDistance('', 'abc')).toBe(3)
  })

  it('stops counting once past the cap', () => {
    expect(editDistance('abcdefgh', 'stuvwxyz', 2)).toBe(3)
    expect(editDistance('a', 'abcdef', 1)).toBe(2)
  })
})

describe('which words are matched loosely, and how loosely', () => {
  it('allows none under 4 letters, one for 4 to 7, two for 8 or more, counting letters, not bytes', () => {
    expect([allowance('nai'), allowance('nair'), allowance('bitcoin'), allowance('electric')]).toEqual([0, 1, 1, 2])
    expect(allowance('मीरा')).toBe(1) // four code points: three letters' worth of Devanagari with its vowel signs
  })

  it('takes letters of any script as a word, and never a figure', () => {
    expect([isWord('Nair'), isWord('मीरा'), isWord('25000'), isWord('upi2'), isWord('a-b')]).toEqual([true, true, false, false, false])
    expect(nameWords(['Meera Nair', 'Bitcoin in rupees', 'मीरा नायर', 'Pay ₹1,000 to A'])).toEqual(['meera', 'nair', 'bitcoin', 'in', 'rupees', 'मीरा', 'नायर', 'pay', 'to'])
  })

  it('finds the closest name word within the allowance, or nothing', () => {
    const words = nameWords(['Meera Nair', 'Bitcoin in rupees', 'Bharatpur Electricity'])
    expect([closeTo('nari', words), closeTo('bitcon', words), closeTo('elektrcity', words)]).toEqual(['nair', 'bitcoin', 'electricity'])
    expect([closeTo('bltcon', words), closeTo('nar', words), closeTo('25001', words)]).toEqual([null, null, null])
    expect(closeTo('मिरा', nameWords(['मीरा नायर']))).toBe('मीरा') // a vowel sign changed
  })
})
