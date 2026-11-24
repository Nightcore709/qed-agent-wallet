/** Who answered a turn of Ask, in words (ask-words.ts): the model the response reported, never a test double called a model. */
import { describe, expect, it } from 'vitest'
import { modelWords, usdWords, writtenBy } from './ask-words.ts'

describe('who answered a turn', () => {
  it('a model id reads as its name; anything else as it is', () => {
    expect(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-4-8', 'scripted-test-double'].map(modelWords))
      .toEqual(['Claude Fable 5.2', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Opus 5', 'Claude Opus 4.8', 'scripted-test-double'])
    expect([usdWords(0.19), usdWords(0.004), usdWords(0)]).toEqual(['US$0.19', 'US$0.004', 'US$0.00'])
  })
  it('on the Anthropic API: "Answered by" the model that answered, the kind of question, the cost, and any model asked first without an answer', () => {
    expect(writtenBy({ provider: 'anthropic-sdk', model: 'claude-opus-5-5', latencyMs: 12_340, usage: { tier: 'demanding', costUsd: 0.0661, attempts: [{ model: 'claude-fable-5-2', outcome: 'overloaded' }, { model: 'claude-opus-5-5', outcome: 'answered' }] } }))
      .toBe('Answered by Claude Opus 5.5 in 12.3 seconds · a demanding question · US$0.07 · after Claude Fable 5.2 (overloaded)')
    expect(writtenBy({ provider: 'anthropic-sdk', model: 'claude-sonnet-5-5', latencyMs: 4_000, usage: { tier: 'routine', costUsd: 0.004, attempts: [{ model: 'claude-sonnet-5-5', outcome: 'answered' }] } }))
      .toBe('Answered by Claude Sonnet 5.5 in 4.0 seconds · a routine question · US$0.004')
    // the command-line client records no route or cost: the model alone
    expect(writtenBy({ provider: 'claude-cli', model: 'claude-opus-5-5', latencyMs: 30_000 })).toBe('Answered by Claude Opus 5.5 in 30.0 seconds')
  })
  it('the scripted test double and QED\'s own code are never called a model', () => {
    expect(writtenBy({ provider: 'scripted', model: 'scripted-test-double', latencyMs: 1 })).toBe('Written by a scripted test double, not a model')
    expect(writtenBy({ provider: 'qed', model: '', latencyMs: 0 })).toBe('Handled by QED\'s own code; no model was asked')
  })
})
