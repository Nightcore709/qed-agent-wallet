/**
 * A change that loosens a protection, in words (server/loosening.ts; Safeguards and Security show it): every key the
 * server may schedule has a label and a value in words, so no internal name reaches the screen.
 */
import { describe, expect, it } from 'vitest'
import { PROFILE_KEYS } from '../../server/household.ts'
import { profileChangeLines, profileValue, protectionDelayWords } from './words.ts'

describe('a waiting change, in words', () => {
  it('names each thing it sets, what it is now and what it becomes, in Safeguards\' order', () => {
    expect(profileChangeLines({ after: { newPayeeHoldHours: 0, line: 30_000_000, lateDays: 0, lostSalaries: 0 }, before: { newPayeeHoldHours: 24, line: 50_000_000, lateDays: 5, lostSalaries: 1 } })).toEqual([
      'Your floor: ₹5,00,000 becomes ₹3,00,000',
      'Income arriving late, allowed for: 5 days becomes not at all',
      'Salaries that never arrive, allowed for: one becomes none',
      'New payees: the wait: 24 hours becomes no wait',
    ])
    expect(profileChangeLines({ after: { spending: 5_000_000, line: 1 }, before: { spending: 7_000_000, line: 2 } }, ['spending'])).toEqual(['Everyday spending, each month: ₹70,000 becomes ₹50,000'])
  })
  it('has words for every key a person may change, and none of them is a key\'s own name', () => {
    for (const k of PROFILE_KEYS) {
      const [line] = profileChangeLines({ after: { [k]: 100 }, before: { [k]: 200 } })
      expect(line, k).toMatch(/^[A-Z][a-z ,:]+[a-z]: .+ becomes .+$/)
      if (/[A-Z]/.test(k)) expect(line, k).not.toContain(k)
    }
    expect(profileValue('newPayeeHoldHours', 1)).toBe('1 hour')
    expect(profileValue('lateDays', 1)).toBe('1 day')
  })
  it('says a shortened protection delay as such', () => {
    expect(protectionDelayWords(72 * 3600_000)).toBe('72 hours')
    expect(protectionDelayWords(6000)).toBe('6 seconds here (72 hours normally)')
  })
})
