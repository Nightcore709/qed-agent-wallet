/**
 * Grow's "Why it changed" and "Each purchase" as drawn (R12 task comparison, gap 17): the three lines and their total
 * as the server gives them, the annual rate with its method named once a holding is a year old, and why not before.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Annual, Holding } from '../lib/types.ts'
import { annualWords, HoldingStory } from './Holdings.tsx'

const IST = 19_800_000
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const NOW = at('2027-12-22 16:00')
const annual = (p: Partial<Annual>): Annual => ({ method: 'xirr', minDays: 365, heldDays: 400, rate: null, reason: null, ...p })
const holding = (p: Partial<Holding> = {}): Holding => ({
  instrumentId: 'amfi:120716', name: 'UTI Nifty 50 Index Fund (Direct, Growth)', kind: 'mutual_fund', asset: 'MF:120716', qty: '139.97', baseScale: 3, priceType: 'nav', price: '196.46',
  priceSourceTs: null, priceRecvTs: null, provider: 'test', fresh: { ageMs: 0, stale: false, usableForExecution: true, label: '' } as never, value: 2_749_850, cost: 2_500_000,
  limit: 0.3, limitStatus: 'modelled', limitNote: '', worst: 1_924_895, held: '0',
  story: {
    purchases: [{ at: at('2026-11-18 22:30'), navDate: '2026-11-18', price: '178.6', bought: '139970', held: '139970', cost: 2_500_000 }],
    boughtAt: { price: '178.6', purchases: 1, first: at('2026-11-18 22:30'), last: at('2026-11-18 22:30') },
    why: { since: at('2026-11-18 22:30'), added: 2_500_000, takenOut: 0, buys: 1, sells: 0, flows: 2_500_000, movement: 249_986, costs: 136, fees: 0, stamp: 125, taxes: 0, rounding: 11, change: 2_749_850 },
    annual: annual({ rate: 0.0905, heldDays: 398 }),
  },
  ...p,
})

describe('the annual rate in words', () => {
  it('shown: the yearly rate, then its method named', () => {
    expect(annualWords(annual({ rate: 0.0905 }))).toEqual({ figure: '+9.05% a year', says: expect.stringMatching(/^Money-weighted: an XIRR, the yearly rate at which the money you put in and took out, on the days it moved, would grow to what it is worth today\. A record of what happened, not a forecast\.$/) })
    expect(annualWords(annual({ rate: -0.1234 })).figure).toBe('−12.34% a year')
  })
  it('not shown, with the reason: too young (and how long so far), several rates, none', () => {
    expect(annualWords(annual({ reason: 'young', heldDays: 3 })).says).toMatch(/^Not shown until you have held it for a year \(3 days so far\): .* When shown, it is money-weighted: an XIRR/)
    expect(annualWords(annual({ reason: 'young', heldDays: 1 })).says).toMatch(/\(1 day so far\)/)
    expect(annualWords(annual({ reason: 'several' })).says).toMatch(/more than one yearly rate fits/)
    expect(annualWords(annual({ reason: 'none' })).says).toMatch(/no yearly rate fits/)
  })
})

describe('Why it changed, drawn', () => {
  const html = renderToStaticMarkup(createElement(HoldingStory, { h: holding(), inst: undefined, now: NOW }))
  it('three lines and a total, each figure with its sign, and the annual rate after a year', () => {
    const dds = [...html.matchAll(/<dd class="gr-n[^"]*">([^<]*)<\/dd>/g)].map((m) => m[1])
    expect(dds).toEqual(['+₹25,000.00', '+₹2,499.86', '−₹1.36', '+₹27,498.50'])
    expect(html).toContain('stamp duty ₹1.25; rounding ₹0.11 (units are allotted in thousandths, money in paise).')
    expect(html).toContain('+9.05% a year')
    expect(html).toContain('Since you first bought it, <span class="gr-nb">Wed 18 Nov 2026</span>: from nothing to ₹27,498.50 now.')
    expect(html).not.toContain('Each purchase') // one purchase: its bought-at line says it all
  })
  it('several purchases: each is one press away, with the day, units, NAV and cost; a sale is said to be counted', () => {
    const two = holding({ story: { ...holding().story!, purchases: [...holding().story!.purchases, { at: at('2026-12-01 21:00'), navDate: '2026-12-01', price: '181.25', bought: '55000', held: '55000', cost: 1_000_000 }], why: { ...holding().story!.why!, sells: 1, takenOut: 600_000 } } })
    const h2 = renderToStaticMarkup(createElement(HoldingStory, { h: two, inst: undefined, now: NOW }))
    expect(h2).toContain('Each purchase (2)')
    expect(h2).toContain('55.000 units at ₹181.25, the NAV for Tue 1 Dec 2026')
    expect(h2).toContain('These lines count the units you redeemed too, while you held them; &quot;Since bought&quot; counts only the units you still hold.')
  })
})
