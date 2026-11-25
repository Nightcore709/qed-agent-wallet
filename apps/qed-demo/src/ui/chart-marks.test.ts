import { describe, expect, it } from 'vitest'
import type { RunwayDay } from './charts.tsx'
import { chartEvents, MARK_R, placeMarks, tipPlace } from './chart-marks.tsx'

const day = (k: number, date: string, low: number, items: RunwayDay['items']): RunwayDay => ({ k, date, low, change: 0, spending: 0, items })

describe('the balance charts\' marks, list and label (R14 L5)', () => {
  it('numbers every day money moves in date order and keeps each day\'s words and sum', () => {
    const days = [
      day(0, '2026-11-25', 800, []),
      day(10, '2026-12-05', 770, [{ label: 'Personal loan instalment', amount: -10, kind: 'emi' }, { label: 'Home loan instalment', amount: -20, kind: 'emi' }]),
      day(42, '2027-01-06', 880, [{ label: 'Salary counted on', amount: 120, kind: 'income' }]),
      day(43, '2027-01-07', 860, [{ label: 'City Power', amount: -20, kind: 'bill' }, { label: 'net', amount: -3, kind: 'net' }]),
    ]
    expect(chartEvents(days).map((e) => `${e.n} ${e.date} ${e.label} ${e.amount} ${e.income}`)).toEqual([
      '1 2026-12-05 Loan instalments -30 false', '2 2027-01-06 Salary, at its latest 120 true', '3 2027-01-07 City Power -20 false',
    ])
  })

  it('no mark touches the line, another mark or the lowest point, and none leaves the plot', () => {
    // sixty days on 600 px, the owner's shape: a slow fall, instalments, a salary two days after the lowest day
    const n = 60
    const low = Array.from({ length: n }, (_, k) => 800 - k * 2 - (k >= 10 ? 30 : 0) - (k >= 41 ? 30 : 0) + (k >= 43 ? 120 : 0))
    const lineY = (k: number) => 20 + (900 - low[k]!) * 0.9
    const ks = [10, 41, 43, 44, 45, 58, 59]
    const events = ks.map((k, i) => ({ k, n: i + 1, date: '2026-12-01', label: 'x', amount: k === 43 ? 120 : -10, income: k === 43, whatif: false }))
    const g = { x: (k: number) => k * 10, dayW: 10, n, lineY, startY: lineY(0) - 2, W: 600, top: 2, bottom: 232, avoid: [{ x: 425, y: lineY(42), r: 12 }] }
    const placed = placeMarks(events, g)
    const shown = placed.filter((m) => m.numbered)
    expect(shown.length).toBeGreaterThanOrEqual(6)
    for (const m of shown) {
      expect(m.x - MARK_R).toBeGreaterThanOrEqual(0); expect(m.x + MARK_R).toBeLessThanOrEqual(600)
      expect(m.y - MARK_R).toBeGreaterThanOrEqual(2); expect(m.y + MARK_R).toBeLessThanOrEqual(232)
      expect(Math.hypot(m.x - 425, m.y - lineY(42))).toBeGreaterThanOrEqual(12 + MARK_R)
      // the line, sampled every pixel under the ring: each day's level and each step's vertical
      for (let px = Math.ceil(m.x - MARK_R); px <= Math.floor(m.x + MARK_R); px++) {
        const k = Math.max(0, Math.min(n - 1, Math.floor(px / 10)))
        const half = Math.sqrt(MARK_R ** 2 - (px - m.x) ** 2)
        expect(Math.abs(lineY(k) - m.y), `mark ${m.n} on day ${k}'s level`).toBeGreaterThan(half)
        if (px % 10 === 0 && k > 0) { const a = Math.min(lineY(k - 1), lineY(k)), b = Math.max(lineY(k - 1), lineY(k)); expect(m.y + half < a || m.y - half > b, `mark ${m.n} on the step into day ${k}`).toBe(true) }
      }
      for (const o of shown) if (o !== m) expect(Math.hypot(m.x - o.x, m.y - o.y), `${m.n} and ${o.n}`).toBeGreaterThanOrEqual(2 * MARK_R)
    }
  })

  it('a day with no room for a number keeps its place in the list and gets a plain tick', () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ k: 5, n: i + 1, date: '2026-12-01', label: 'x', amount: -1, income: false, whatif: false }))
    const placed = placeMarks(events, { x: (k) => k * 4, dayW: 4, n: 75, lineY: () => 60, startY: 60, W: 300, top: 2, bottom: 120 })
    expect(placed.map((m) => m.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(placed.some((m) => !m.numbered)).toBe(true)
  })

  it('the label stands beside the reading line, inside the plot, on the side with more room', () => {
    const base = { W: 600, bottom: 200, w: 200, h: 90 }
    expect(tipPlace({ ...base, cx: 100, cy: 60 })).toEqual({ left: 114, top: 15, side: 'right' })
    expect(tipPlace({ ...base, cx: 560, cy: 60 })).toEqual({ left: 346, top: 15, side: 'left' })
    for (let cx = 0; cx <= 600; cx += 7) for (const cy of [0, 30, 100, 190]) {
      const p = tipPlace({ ...base, cx, cy })
      expect(p.left).toBeGreaterThanOrEqual(0)
      expect(p.left + base.w, `never over the axis figures (cx ${cx})`).toBeLessThanOrEqual(600)
      expect(p.top).toBeGreaterThanOrEqual(0)
      expect(p.top + base.h, `never over the dates along the foot (cy ${cy})`).toBeLessThanOrEqual(200)
      expect(p.left > cx || p.left + base.w < cx, `never over the day it reads (cx ${cx})`).toBe(true)
    }
  })

  it('on a plot too narrow to stand beside the line, the label stays inside the plot\'s width', () => {
    for (let cx = 0; cx <= 280; cx += 5) {
      const p = tipPlace({ W: 280, bottom: 160, w: 190, h: 86, cx, cy: 100 })
      expect(p.left).toBeGreaterThanOrEqual(0); expect(p.left + 190).toBeLessThanOrEqual(280)
    }
    expect(tipPlace({ W: 280, bottom: 160, w: 190, h: 86, cx: 140, cy: 120 }).side).toBe('over')
  })
})
