/**
 * A fund order's states in words (R12 task comparison, gap 17, T4-d): "Order with the registrar", "Money received by the
 * fund house (date)" and "Units allotted (date)"; a redemption's "Units redeemed (date)" and "Money paid to your bank".
 * Home's "With the fund house" line, Grow's list of orders in progress, Activity and the record all say them this way.
 */
import { describe, expect, it } from 'vitest'
import type { ActionView } from './types.ts'
import { fundLine, fundStages, fundSummary } from './fund-stages.ts'

const IST = 19_800_000
/** A moment given as India time, "2026-11-24 14:02". */
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const NOW = at('2026-11-24 16:00')

const fundOrder = (p: Partial<ActionView> & { result?: Record<string, unknown> } = {}): ActionView => ({
  id: 'act_f', kind: 'order', origin: 'owner', venue: 'paper-mf', state: 'working', runId: null, programId: null, economicId: 'mf_1', what: 'Buy ₹25,000 of UTI Nifty 50 Index Fund',
  params: { instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: '2500000' }, instrument: { id: 'amfi:120716', name: 'UTI Nifty 50 Index Fund', kind: 'mutual_fund', baseAsset: 'MF:120716', baseScale: 3 },
  decision: {}, result: {}, times: { submitted: at('2026-11-24 14:02') }, reconState: 'open', receiptId: null, approvalId: 'apr_1', error: null, createdAt: at('2026-11-24 14:01'), updatedAt: at('2026-11-24 14:02'), ...p,
})
const iso = /\b\d{4}-\d{2}-\d{2}\b/
/** Days are written with no-break spaces, so a day is never split across lines; compared here as plain text. */
const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\u00a0/g, ' ')) as T

describe('a fund purchase: with the registrar, money received, units allotted', () => {
  it('with the registrar, money on its way', () => {
    const a = fundOrder({ result: { venueState: 'accepted', registrarAt: at('2026-11-24 14:02'), fundsAt: null, navEntitledFrom: '2026-11-24' } })
    expect(plain(fundStages(a, NOW).map((s) => [s.step, s.done, s.title]))).toEqual([
      ['registrar', true, 'Order with the registrar'], ['money', false, 'Money not received yet'], ['allotted', false, 'Units not allotted yet']])
    expect(plain(fundLine(a, NOW))).toBe('Order with the registrar. The money reaches the fund house in a moment; units at the NAV for Tue 24 Nov, once it is published.')
  })

  it('money received, with its date: the NAV day it sets is said in words', () => {
    const a = fundOrder({ result: { venueState: 'funded', registrarAt: at('2026-11-24 15:02'), fundsAt: at('2026-11-24 15:02') + 2000, navEntitledFrom: '2026-11-25', cutoff: '15:00', beforeCutoff: false } })
    const s = plain(fundStages(a, NOW))
    expect(s[1]).toMatchObject({ step: 'money', done: true, title: 'Money received by the fund house, Tue 24 Nov', at: at('2026-11-24 15:02') + 2000, says: 'It arrived after the 15:00 India time cut-off, so it takes the NAV for Wed 25 Nov.' })
    expect(s[2]).toMatchObject({ step: 'allotted', done: false, says: 'At the NAV for Wed 25 Nov, once the fund house publishes it, usually late that evening.' })
    expect(plain(fundLine(a, NOW))).toBe('Money received by the fund house Tue 24 Nov. Units at the NAV for Wed 25 Nov, once it is published, usually late that evening.')
    for (const x of [...s.map((y) => `${y.title} ${y.says}`), plain(fundLine(a, NOW))]) expect(x).not.toMatch(iso)
  })

  it('units allotted, with the day and the NAV they came at', () => {
    const a = fundOrder({ state: 'done', result: { venueState: 'filled', registrarAt: at('2026-11-24 14:02'), fundsAt: at('2026-11-24 14:02') + 2000, allottedAt: at('2026-11-25 21:40'), navDate: '2026-11-25', navPrice: '178.6', filledQty: '139970', filledAmount: '2499875', navEntitledFrom: '2026-11-25' } })
    const s = plain(fundStages(a, NOW))
    expect(s.every((x) => x.done)).toBe(true)
    expect(s[2]).toMatchObject({ title: 'Units allotted, Wed 25 Nov', at: at('2026-11-25 21:40'), says: '139.970 units at ₹178.6000, the NAV for Wed 25 Nov.' })
  })

  it('an older database\'s order (money treated as received with the order) reads the same way', () => {
    const a = fundOrder({ result: { venueState: 'funded', fundsAt: at('2026-11-24 14:02'), navEntitledFrom: '2026-11-24' } })
    expect(plain(fundStages(a, NOW))[0]).toMatchObject({ done: true, at: at('2026-11-24 14:02') }) // the registrar's time, from when it was sent
  })
})

describe('a redemption: with the registrar, units redeemed, money paid', () => {
  const sell = (result: Record<string, unknown>, state = 'working') => fundOrder({ state, params: { instrumentId: 'amfi:120716', side: 'sell', type: 'nav', qty: '5000' }, result })
  it('with the registrar: units reserved until the NAV', () => {
    const a = sell({ venueState: 'accepted', registrarAt: at('2026-11-24 14:02'), navEntitledFrom: '2026-11-24' })
    expect(plain(fundStages(a, NOW).map((s) => [s.step, s.done]))).toEqual([['registrar', true], ['redeemed', false], ['paid', false]])
    expect(plain(fundLine(a, NOW))).toBe('Order with the registrar. The units are reserved, to be redeemed at the NAV for Tue 24 Nov.')
  })
  it('redeemed, the money on its way to the bank on its day', () => {
    const a = sell({ venueState: 'filled', registrarAt: at('2026-11-24 14:02'), allottedAt: at('2026-11-24 21:40'), navDate: '2026-11-24', filledQty: '5000', payoutAt: at('2026-11-26 10:00') })
    const s = plain(fundStages(a, NOW))
    expect(s[1]).toMatchObject({ done: true, title: 'Units redeemed, Tue 24 Nov' })
    expect(s[2]).toMatchObject({ done: false, title: 'Money not paid yet', says: 'It reaches your bank Thu 26 Nov, 10:00.' })
    expect(plain(fundLine(a, NOW))).toBe('Units redeemed Tue 24 Nov. The money reaches your bank Thu 26 Nov, 10:00.')
  })
})

describe('Home\'s "With the fund house" line', () => {
  it('one order says where it is; several say each, then how many more', () => {
    const funded = fundOrder({ result: { venueState: 'funded', registrarAt: at('2026-11-24 14:02'), fundsAt: at('2026-11-24 14:02') + 2000, navEntitledFrom: '2026-11-25' } })
    expect(plain(fundSummary([funded], NOW))).toBe('Money received by the fund house Tue 24 Nov; units at the NAV for Wed 25 Nov, once published')
    const waiting = fundOrder({ id: 'act_g', result: { venueState: 'accepted', registrarAt: at('2026-11-24 15:30'), navEntitledFrom: '2026-11-25' } })
    const redeemed = fundOrder({ id: 'act_h', params: { instrumentId: 'amfi:120716', side: 'sell', type: 'nav', qty: '5000' }, result: { venueState: 'filled', navDate: '2026-11-24', allottedAt: at('2026-11-24 21:40'), payoutAt: at('2026-11-26 10:00') } })
    expect(plain(fundSummary([funded, waiting], NOW))).toBe('2 orders: money received by the fund house Tue 24 Nov; order with the registrar')
    expect(plain(fundSummary([funded, waiting, redeemed], NOW))).toBe('3 orders: money received by the fund house Tue 24 Nov; order with the registrar; and 1 more')
    expect(plain(fundSummary([redeemed], NOW))).toBe('Units redeemed Tue 24 Nov; the money reaches your bank Thu 26 Nov, 10:00')
  })
})
