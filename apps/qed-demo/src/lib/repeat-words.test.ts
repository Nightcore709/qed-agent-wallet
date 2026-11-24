import { describe, expect, it } from 'vitest'
import { awaitsRepeat, REPEAT_RULE } from '../ui/repeat.tsx'
import { DUPLICATE_RULE } from '../../server/duplicates.ts'
import { heldWords } from './words.ts'

describe('a payment held as a repeat', () => {
  const now = Date.UTC(2026, 10, 24, 10, 0)
  const held = { state: 'held', result: { awaitingConfirmation: { why: 'x', expiresAt: now + 3600_000 } }, params: {} }
  it('says it waits for the person, not for a time, and what happens if they do nothing', () => {
    const s = heldWords(held, now, false)
    expect(s).toMatch(/^It waits for your confirmation, because it repeats an earlier payment\./)
    expect(s).toContain('it is cancelled at')
    expect(s).toContain('nothing is sent')
  })
  it('is no longer waiting once confirmed, and an ordinary wait still reads as before', () => {
    expect(awaitsRepeat(held)).toBe(true)
    expect(awaitsRepeat({ ...held, result: { ...held.result, duplicateConfirmedAt: now } })).toBe(false)
    expect(heldWords({ params: { hold: { until: now + 3600_000 } }, result: {} }, now, false)).toMatch(/^It is sent at /)
  })
  it('the screen states the rule the server enforces, word for word', () => { expect(REPEAT_RULE).toBe(DUPLICATE_RULE) })
})
