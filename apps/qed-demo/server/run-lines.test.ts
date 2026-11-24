/**
 * A fund order in a run's approval names the NAV day it is entitled to if sent now, written as the household's pages
 * write days ("Wed 18 Nov"), with the cut-off it was sent before or after (R12 task comparison, gaps 6 and T4-a).
 */
import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { runActionLines } from './runner.ts'
import { makeKit } from './testkit.ts'

describe('a run\'s fund order line', () => {
  it('names the NAV day in words, before and after the cut-off', () => {
    const k = makeKit()
    const order = { kind: 'order', venue: 'paper-mf', params: { instrumentId: 'amfi:120716', side: 'buy', amount: '50000' } }
    const [before] = runActionLines(k.db, [order], istInstant('2026-11-18', '14:59'))
    expect(before!.nav).toBe('Wed 18 Nov, or the next one published (sent before the 15:00 IST cut-off)')
    const [after] = runActionLines(k.db, [order], istInstant('2026-11-18', '15:00'))
    expect(after!.nav).toBe('Thu 19 Nov, or the next one published (sent after the 15:00 IST cut-off)')
    // on a weekend the cut-off is not what decides it (review of R12, L11): 21 Nov 2026 is a Saturday
    const [weekend] = runActionLines(k.db, [order], istInstant('2026-11-21', '09:00'))
    expect(weekend!.nav).toBe('Mon 23 Nov, or the next one published (sent on a weekend, so the next business day counts)')
    // a payment has no NAV day
    const [pay] = runActionLines(k.db, [{ kind: 'payment', venue: 'paper-rail', params: { amount: '50000', payeeName: 'City Power', payeeHandle: 'power@upi' } }])
    expect(pay!.nav).toBeUndefined()
  })
})
