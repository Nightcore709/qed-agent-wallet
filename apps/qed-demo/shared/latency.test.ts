import { describe, expect, it } from 'vitest'
import { delayWords, journeyWords, quoteLatency, summary } from './latency.ts'

describe('how long a price takes to travel (GL6)', () => {
  it('measures source to receipt, to display and to a decision, from recorded times', () => {
    expect(quoteLatency({ sourceTs: 1_000, recvTs: 1_400 }, { displayedAt: 1_450, decidedAt: 2_900 }))
      .toEqual({ sourceToReceiptMs: 400, receiptToDisplayMs: 50, receiptToDecisionMs: 1_500, sourceToDecisionMs: 1_900 })
  })
  it('invents nothing: a source that stamps no time has no delay, and nothing not yet shown or used has none', () => {
    expect(quoteLatency({ sourceTs: null, recvTs: 1_400 }, { decidedAt: 2_000 })).toEqual({ sourceToReceiptMs: null, receiptToDisplayMs: null, receiptToDecisionMs: 600, sourceToDecisionMs: null })
    expect(quoteLatency({ sourceTs: 1, recvTs: 2 })).toEqual({ sourceToReceiptMs: 1, receiptToDisplayMs: null, receiptToDecisionMs: null, sourceToDecisionMs: null })
  })
  it('keeps a negative delay (a source clock ahead of ours) as it is and says so in words', () => {
    expect(quoteLatency({ sourceTs: 5_000, recvTs: 4_000 }).sourceToReceiptMs).toBe(-1_000)
    expect(journeyWords({ sourceTs: 5_000, recvTs: 4_000 })).toBe('The source\'s clock is ahead of ours, so its delay cannot be told.')
    expect(journeyWords({ sourceTs: null, recvTs: 4_000 })).toBe('The source gives no time, so its delay is not known.')
    expect(journeyWords({ sourceTs: 1_000, recvTs: 1_400 }, 1_450)).toBe('Reached QED 400 ms after the source stamped it; on screen 50 ms after QED had it.')
  })
  it('puts a delay in words and summarises a set of them', () => {
    expect([delayWords(230), delayWords(400), delayWords(2_500), delayWords(12_000), delayWords(180_000)]).toEqual(['230 ms', '400 ms', '2.5 s', '12 s', '3 min'])
    expect(summary([])).toBeNull()
    expect(summary([5, 1, 3, 2, 4])).toEqual({ n: 5, min: 1, median: 3, p95: 5, max: 5 })
  })
})

describe('a fill\'s record says how long its price took to reach the decision', () => {
  it('names each leg from the record\'s own times, and says plainly when one is not known', async () => {
    const { decisionWords } = await import('./latency.ts')
    expect(decisionWords({ sourceTs: 1_000, receivedAt: 1_400, ageMsAtExecution: 1_500 })).toBe(' Delays: source to QED 400 ms, QED to the decision 1.5 s, 1.9 s in all.')
    expect(decisionWords({ sourceTs: null, receivedAt: 1_400, ageMsAtExecution: 300 })).toBe(' Delays: source to QED: not known, the source gives no time, QED to the decision 300 ms.')
    expect(decisionWords({ sourceTs: 1_000, receivedAt: null, ageMsAtExecution: null })).toBe('')
  })
})
