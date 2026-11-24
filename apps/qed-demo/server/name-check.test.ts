/**
 * The paper bank's name check (Confirmation of Payee on paper, R12 task comparison gap 4: T2-a, T2-b). Four outcomes, as
 * the UK's Confirmation of Payee and the EU's Verification of Payee give them: match, close match with the name the bank
 * holds, no match (which does not reveal that name), could not check (an address the paper bank does not know, or a
 * check that does not answer). Every outcome is reachable from the paper bank's own small directory.
 */
import { describe, expect, it } from 'vitest'
import { checkPayeeName, nameAgreement, nameCheckAddMessage, nameCheckAdvice, nameCheckWords, normalizeName, PAPER_DIRECTORY } from './name-check.ts'

describe('the paper bank\'s directory', () => {
  it('knows the test addresses the Spend form documents, each with a registered name, and one address whose check does not answer', () => {
    for (const a of ['decline@paper', 'slow@paper', 'timeout@paper', 'reverse@paper', 'refund@paper']) expect(PAPER_DIRECTORY.get(a), a).toMatch(/Test Account$/)
    expect(checkPayeeName('Anyone', 'nocheck@paper')).toEqual({ outcome: 'no_answer', registeredName: null })
  })
  it('an address it does not know could not be checked, and nothing is made up for it', () => {
    expect(checkPayeeName('Corner Shop', 'corner.shop@upi')).toEqual({ outcome: 'unknown', registeredName: null })
  })
  it('addresses are compared as the payee form stores them: lower case, trimmed', () => {
    expect(checkPayeeName('Ravi Kumar', '  RAVI.KUMAR@UPI ')).toEqual({ outcome: 'match', registeredName: 'Ravi Kumar' })
  })
})

describe('match, close match and no match', () => {
  it('a match ignores case, accents, punctuation, spacing and a title', () => {
    for (const typed of ['Ravi Kumar', 'RAVI KUMAR', 'ravi  kumar', 'Mr. Ravi Kumar', 'Rávi Kumar']) expect(checkPayeeName(typed, 'ravi.kumar@upi'), typed).toEqual({ outcome: 'match', registeredName: 'Ravi Kumar' })
  })
  it('a close match gives the name the paper bank holds: one or two letters off, words in another order, an initial, or a name with a word more', () => {
    for (const typed of ['Ravi Kumaar', 'Kumar Ravi', 'R Kumar', 'R. Kumar']) expect(checkPayeeName(typed, 'ravi.kumar@upi'), typed).toEqual({ outcome: 'close', registeredName: 'Ravi Kumar' })
    expect(nameAgreement('City Power', 'City Power Distribution')).toBe('close')
    expect(nameAgreement('Meera Nair', 'Meera S Nair')).toBe('close')
  })
  it('a name written with look-alike letters from another alphabet is not a match, only close', () => {
    expect(checkPayeeName('Ravi Kumаr', 'ravi.kumar@upi').outcome).toBe('close') // Cyrillic а
  })
  it('no match does not say the name the paper bank holds, as banks\' name checks do not', () => {
    expect(checkPayeeName('Safe Account Services', 'ravi.kumar@upi')).toEqual({ outcome: 'no_match', registeredName: null })
    expect(checkPayeeName('Gas Agency', 'slow@paper')).toEqual({ outcome: 'no_match', registeredName: null })
  })
  it('one shared word, or a short name one letter off, is not enough to be close', () => {
    expect(nameAgreement('Ravi', 'Ravi Kumar')).toBe('no_match')
    expect(nameAgreement('Ram', 'Rao')).toBe('no_match')
    expect(nameAgreement('Kumar Stores', 'Ravi Kumar')).toBe('no_match')
  })
  it('normalises the way the check compares', () => {
    expect(normalizeName('  Smt. Sunita  SHARMA ')).toBe('sunita sharma')
    expect(normalizeName('BESCOM — Electricity')).toBe('bescom electricity')
  })
})

describe('the words a household reads', () => {
  it('say "the paper bank" every time and never that a real bank confirmed the name', () => {
    const all = [
      nameCheckWords('match', 'Ravi Kumar', 'Ravi Kumar'), nameCheckWords('close', 'Ravi Kumar', 'Ravi Kumaar'), nameCheckWords('no_match', null, 'Safe Account'),
      nameCheckWords('unknown', null, 'Corner Shop'), nameCheckWords('no_answer', null, 'Anyone'), nameCheckWords(null, null, 'Old Payee'),
    ]
    for (const w of all) {
      expect(`${w.value} ${w.note}`).toMatch(/paper bank|before QED checked names/)
      expect(`${w.value} ${w.note}`).not.toMatch(/confirmed by (your|the) bank|verified by (your|the) bank|(confirmed|verified|checked) (by|with) NPCI|\bR\d+-|\bD-\d/)
    }
    expect(nameCheckWords('match', 'Ravi Kumar', 'Ravi Kumar').value).toBe('Matches the name the paper bank holds for this address: Ravi Kumar')
    expect(nameCheckWords('close', 'Ravi Kumar', 'Ravi Kumaar')).toMatchObject({ value: 'Close match: the paper bank holds Ravi Kumar for this address', note: expect.stringMatching(/You kept the name you gave, Ravi Kumaar, and said you checked the address with the payee yourself\./) })
    expect(nameCheckWords('no_match', null, 'Safe Account').value).toBe('No match: the paper bank holds another name for this address')
    expect(nameCheckWords('unknown', null, 'Corner Shop').value).toBe('Could not check: the paper bank does not know this address')
    expect(nameCheckWords('no_answer', null, 'X').value).toBe('Could not check: the paper bank\'s name check did not answer')
    expect(nameCheckWords(null, null, 'X').value).toBe('Not checked: this payee was added before QED checked names')
  })
})

describe('the advice beside the two names on the add form', () => {
  it('says what to do without naming anyone again, always as the paper bank\'s check, and nothing on a match', () => {
    expect(nameCheckAdvice('match')).toBeNull()
    for (const o of ['close', 'no_match', 'unknown', 'no_answer'] as const) {
      const a = nameCheckAdvice(o)!
      expect(a, o).toMatch(/It is the paper bank's own directory on this computer: no real bank or NPCI was asked, and it cannot tell who controls the account or whether someone is pressing you to pay\.$/)
      expect(a, o).not.toMatch(/Ravi|Kumar|@/)
    }
    expect(nameCheckAdvice('close')).toMatch(/^Use its name if this is who you mean to pay; to keep yours, say you checked the address with the payee yourself\./)
    expect(nameCheckAdvice('no_match')).toMatch(/it may be a fraud: check it with the payee directly\./)
  })
})

describe('where the answer comes from, and what it cannot tell (R13 section 4)', () => {
  it('every answer a payee and a payment\'s terms carry names its source, says no real bank or NPCI was asked, and says what it cannot detect', () => {
    for (const o of ['match', 'close', 'no_match', 'unknown', 'no_answer'] as const) {
      const { note } = nameCheckWords(o, 'Ravi Kumar', 'Ravi Kumar')
      expect(note, o).toMatch(/against the paper bank's own directory on this computer; no real bank or NPCI was asked\./)
      expect(note, o).toMatch(/It can say only whether a name matches the one held for the address, not who controls the account or whether someone is pressing you to pay\.$/)
    }
    // and the add form says so for every answer but a match (where the form says it under its button)
    for (const o of ['close', 'no_match', 'unknown', 'no_answer'] as const) expect(nameCheckAddMessage({ outcome: o, registeredName: o === 'close' ? 'Ravi Kumar' : null }, 'Ravi Kumaar', 'ravi.kumar@upi'), o).toMatch(/no real bank or NPCI was asked/)
  })
})
