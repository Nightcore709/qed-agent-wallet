/**
 * A fund purchase's days are shown in the order they happen, or not as a sequence at all (src/lib/nav-order.ts, R13):
 * the seeded fault is the record Grow once drew, "the NAV for Wed 25 Nov; allotted Tue 24 Nov".
 */
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { navThenAllotted, OUT_OF_ORDER } from './nav-order.ts'
import { boughtLine } from '../screens/Holdings.tsx'
import type { Holding } from './types.ts'

const IST = 19_800_000
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const NOW = at('2026-11-26 12:00')

describe('the NAV day, then the allotment day', () => {
  it('in order: the NAV for its day, allotted that evening or later', () => {
    expect(navThenAllotted('2026-11-24', at('2026-11-24 22:30'), NOW)).toEqual({ nav: 'Tue 24 Nov', allotted: 'Tue 24 Nov', inOrder: true })
    expect(navThenAllotted('2026-11-24', at('2026-11-25 09:10'), NOW)).toEqual({ nav: 'Tue 24 Nov', allotted: 'Wed 25 Nov', inOrder: true })
  })
  it('out of order: the allotment day is left out, never drawn before the NAV\'s day (seeded fault)', () => {
    expect(navThenAllotted('2026-11-25', at('2026-11-24 18:27'), NOW)).toEqual({ nav: 'Wed 25 Nov', allotted: null, inOrder: false })
  })
  it('a day after midnight in India is that India day, not the UTC one', () => {
    // 00:30 IST on Wed 25 Nov is still Tue 24 Nov in UTC: the allotment is in order for the NAV for Wed 25 Nov
    expect(navThenAllotted('2026-11-25', at('2026-11-25 00:30'), NOW).inOrder).toBe(true)
  })
  it('no NAV day on record: the allotment day alone', () => {
    expect(navThenAllotted(null, at('2026-11-24 22:30'), NOW)).toEqual({ nav: null, allotted: 'Tue 24 Nov', inOrder: true })
  })
})

describe('Grow\'s bought-at line', () => {
  const holding = (navDate: string, allotted: string): Holding => ({
    instrumentId: 'amfi:120716', name: 'UTI Nifty 50 Index Fund (Direct, Growth)', kind: 'mutual_fund', asset: 'MF:120716', qty: '27.996', baseScale: 3, priceType: 'nav', price: '178.6', priceSourceTs: null, priceRecvTs: null, provider: 'test',
    fresh: { ageMs: 0, stale: false, usableForExecution: true, label: '' } as never, value: 500_000, cost: 500_000, limit: 0.3, limitStatus: 'modelled', limitNote: '', worst: 350_000, held: '0',
    story: { purchases: [{ at: at(allotted), navDate, price: '178.6', bought: '27996', held: '27996', cost: 500_000 }], boughtAt: { price: '178.6', purchases: 1, first: at(allotted), last: at(allotted) }, why: null, annual: { method: 'xirr', minDays: 365, heldDays: 1, rate: null, reason: 'young' } },
  })
  const text = (h: Holding) => renderToStaticMarkup(createElement(Fragment, null, boughtLine(h, undefined, NOW))).replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")
  it('in order, as before: "the NAV for Tue 24 Nov; allotted Tue 24 Nov"', () => {
    expect(text(holding('2026-11-24', '2026-11-24 22:30'))).toBe('Bought at ₹178.6 a unit, the NAV for Tue 24 Nov; allotted Tue 24 Nov')
  })
  it('out of order: the NAV\'s day alone, and why the allotment day is left out (seeded fault)', () => {
    const t = text(holding('2026-11-25', '2026-11-24 18:27'))
    expect(t).toBe(`Bought at ₹178.6 a unit, the NAV for Wed 25 Nov; ${OUT_OF_ORDER}`)
    expect(t).not.toMatch(/allotted Tue 24 Nov/)
  })
})
