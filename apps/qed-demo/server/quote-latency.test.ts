/**
 * A price's times survive its whole journey, so each delay can be measured from records (audit GL6, R7-039): the source's
 * stamp and QED's receipt time are stored with the price, served unchanged to the screen, and kept in the evidence of
 * the decision that used it, with the price's age at that moment.
 */
import { describe, expect, it } from 'vitest'
import { quoteLatency } from '../shared/latency.ts'
import { parseCoindcxTicker } from './market.ts'
import { makeKit } from './testkit.ts'
import { marketView } from './views.ts'

describe('a price keeps the times its delays are measured from', () => {
  it('source stamp and receipt time go in, come out of the market view unchanged, and give the delay', () => {
    const k = makeKit()
    const recvTs = k.clock.now()
    const frame = JSON.stringify([{ market: 'BTCINR', bid: '6500000', ask: '6501000', timestamp: Math.floor((recvTs - 400) / 1000) }])
    const ticks = parseCoindcxTicker(frame, new Set(['BTCINR']), recvTs)
    expect(ticks.length).toBeGreaterThan(0)
    for (const t of ticks) k.market.update(t)
    k.market.flush()
    k.clock.advance(50)
    const inst = (marketView(k.db, k.market, k.clock.now()) as { instruments: { id: string; quotes: Record<string, { sourceTs: number | null; recvTs: number; ageMs: number }> }[] }).instruments.find((i) => i.id === 'coindcx:BTCINR')!
    const q = inst.quotes.bid!
    expect(q.recvTs).toBe(recvTs)
    expect(q.ageMs).toBe(50)
    // the source stamps whole seconds: the delay it gives is within a second of the 400 ms put in, never invented
    const l = quoteLatency(q, { displayedAt: k.clock.now() })
    expect(l.sourceToReceiptMs).toBeGreaterThanOrEqual(400)
    expect(l.sourceToReceiptMs).toBeLessThan(1400)
    expect(l.receiptToDisplayMs).toBe(50)
  })
  it('a source that stamps nothing leaves the delay unknown, not zero', () => {
    const k = makeKit()
    const ticks = parseCoindcxTicker(JSON.stringify([{ market: 'BTCINR', bid: '6500000', ask: '6501000' }]), new Set(['BTCINR']), k.clock.now())
    for (const t of ticks) k.market.update(t)
    k.market.flush()
    const inst = (marketView(k.db, k.market, k.clock.now()) as { instruments: { id: string; quotes: Record<string, { sourceTs: number | null; recvTs: number }> }[] }).instruments.find((i) => i.id === 'coindcx:BTCINR')!
    expect(inst.quotes.bid!.sourceTs).toBeNull()
    expect(quoteLatency(inst.quotes.bid!).sourceToReceiptMs).toBeNull()
  })
})
