import { describe, expect, it } from 'vitest'
import { type StickyMeasure, stickyPlaced, stickyPlan } from './sticky.ts'

/** A page: what is above the column, the column, and what is under it. */
const page = (o: { above: number; col: number; below: number; height: number; viewport: number; top?: number; bottom?: number }): StickyMeasure => ({
  colTop: o.above, colHeight: o.col, height: o.height, viewport: o.viewport, top: o.top ?? 24, bottom: o.bottom ?? 0,
  scrollMax: Math.max(0, o.above + o.col + o.below - o.viewport),
})
/** At every scroll position: inside its column, clear of both bars whenever the column allows it. */
function holds(m: StickyMeasure): void {
  const plan = stickyPlan(m)
  for (let s = 0; s <= m.scrollMax; s += Math.max(1, Math.floor(m.scrollMax / 200))) {
    const y = stickyPlaced(m, plan, s)
    const colTop = m.colTop - s, colFoot = colTop + m.colHeight
    expect(y, `inside its column at ${s}`).toBeGreaterThanOrEqual(colTop - 0.5)
    expect(y + m.height, `inside its column at ${s}`).toBeLessThanOrEqual(colFoot + 0.5)
    if (plan.mode !== 'static' && colFoot - m.height >= m.top) expect(y, `clear of the top bar at ${s}`).toBeGreaterThanOrEqual(Math.min(m.top, colTop) - 0.5)
  }
}

describe('the sticky side summary (R14 L2)', () => {
  it('the owner\'s screenshot: a tall window, a page that ends with the column; the summary ends level with the column\'s foot', () => {
    // "Open your paper household" at 1440 by 940: the form 1,176 px, the summary 500 px, 80 px under the form
    const m = page({ above: 200, col: 1176, below: 80, height: 500, viewport: 940 })
    expect(m.scrollMax).toBe(516)
    const plan = stickyPlan(m)
    expect(plan.mode).toBe('drift')
    expect(stickyPlaced(m, plan, 0), 'starts level with the column').toBe(200)
    const end = stickyPlaced(m, plan, m.scrollMax)
    expect(end + m.height, 'ends level with the column\'s foot').toBe(m.colTop + m.colHeight - m.scrollMax)
    // plain sticky, for comparison, leaves 300 px under the summary at the end
    expect(stickyPlaced(m, { mode: 'pinned', top: 24 }, m.scrollMax) + m.height).toBe(524)
    holds(m)
  })

  it('a long page under the column: pinned under the bar, as plain sticky, and it leaves with the column\'s foot', () => {
    const m = page({ above: 300, col: 2400, below: 900, height: 480, viewport: 900, top: 88, bottom: 92 })
    expect(stickyPlan(m)).toEqual({ mode: 'pinned', top: 88 })
    expect(stickyPlaced(m, stickyPlan(m), 0)).toBe(300)
    expect(stickyPlaced(m, stickyPlan(m), 1000)).toBe(88)
    holds(m)
  })

  it('the page ends a little after the column: pinned lower, a fixed place, and level at the end', () => {
    const m = page({ above: 420, col: 1500, below: 160, height: 520, viewport: 900, top: 88, bottom: 92 })
    const plan = stickyPlan(m)
    expect(plan.mode).toBe('lowered')
    const end = stickyPlaced(m, plan, m.scrollMax)
    expect(end + m.height).toBe(m.colTop + m.colHeight - m.scrollMax)
    expect(stickyPlaced(m, plan, 0), 'starts level with the column').toBe(420)
    holds(m)
  })

  it('never ends under the bottom navigation', () => {
    const m = page({ above: 200, col: 1400, below: 0, height: 500, viewport: 900, top: 88, bottom: 92 })
    const plan = stickyPlan(m)
    const end = stickyPlaced(m, plan, m.scrollMax)
    expect(end + m.height).toBeLessThanOrEqual(m.viewport - m.bottom)
    holds(m)
  })

  it('a summary taller than the room between the bars is not pinned, so all of it can be reached', () => {
    expect(stickyPlan(page({ above: 200, col: 3000, below: 500, height: 800, viewport: 844, top: 88, bottom: 92 }))).toEqual({ mode: 'static' })
  })

  it('a summary as tall as its column has nowhere to travel', () => {
    expect(stickyPlan(page({ above: 200, col: 500, below: 500, height: 500, viewport: 900 }))).toEqual({ mode: 'static' })
  })

  it('a page that does not scroll keeps the summary at the column\'s top', () => {
    const m = page({ above: 100, col: 600, below: 40, height: 300, viewport: 900 })
    expect(m.scrollMax).toBe(0)
    expect(stickyPlaced(m, stickyPlan(m), 0)).toBe(100)
  })

  it('holds its promises across window heights, column lengths and page endings', () => {
    for (const viewport of [600, 768, 900, 1080, 1440]) for (const col of [700, 1100, 1800, 3200]) for (const below of [0, 60, 200, 1200]) for (const height of [320, 500, 640]) {
      const m = page({ above: 180, col, below, height, viewport, top: 88, bottom: 92 })
      const plan = stickyPlan(m)
      holds(m)
      if (plan.mode === 'static' || m.scrollMax === 0) continue
      // ends level with the column's foot, or above the bottom navigation when the foot is under it
      const end = stickyPlaced(m, plan, m.scrollMax) + m.height
      const foot = m.colTop + m.colHeight - m.scrollMax
      expect(Math.abs(end - Math.min(foot, Math.max(m.viewport - m.bottom, m.top + m.height))), `${viewport} ${col} ${below} ${height} ${plan.mode}`).toBeLessThanOrEqual(1)
    }
  })
})
