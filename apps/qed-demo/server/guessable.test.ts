/** The password rule for sign-up (D-094; the review found only ten exact strings refused). */
import { describe, expect, it } from 'vitest'
import { guessable, validateCredentials } from './auth.ts'

describe('guessable passwords', () => {
  it('refuses common passwords, common words dressed up, repeats and runs', () => {
    for (const p of ['password12', 'Password!23', 'qwerty1234', 'iloveyou99', 'cricket2026', '1111111111', 'abcdefghij', '9876543210', 'aaaaaaaaaaaa', '12345678!!', 'letmein!!!!', 'passwordpassword'])
      expect([p, guessable(p)]).toEqual([p, true])
  })
  it('accepts a phrase of a few words and long mixed passwords', () => {
    for (const p of ['a long and private phrase 7', 'river tiger lamp 42', 'Correct-Horse-Battery', 'mumbai monsoon tea 9'])
      expect([p, guessable(p)]).toEqual([p, false])
  })
  it('still refuses a password that holds the handle', () => {
    expect(() => validateCredentials('meera', 'meera-meera-meera')).toThrow()
  })
})
