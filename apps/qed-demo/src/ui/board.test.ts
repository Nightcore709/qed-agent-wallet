import { describe, expect, it } from 'vitest'
import { type BoardItem, boardPlan } from './board.ts'

const OPTS = { snap: 18, level: 42 } // 72 px and 168 px in 4 px units, as useMasonry sets them
const ends = (items: BoardItem[]) => { const p = boardPlan(items, OPTS); const e = [0, 0]; p.forEach((x) => { if (x.col === 'both') e[0] = e[1] = Math.max(e[0]!, e[1]!) + x.span; else if (x.col) e[x.col - 1]! += x.span }); return { p, e } }

describe('the board: level or plainly apart, and ending together (R14 L3)', () => {
  it('Home as the owner saw it: the two hero panels end level, and so do the two columns', () => {
    // position 395 px beside "Needs you" 450 px; then the chart, the day book; what QED may do, where the money is,
    // holdings by currency; and "Ways to do better", marked auto
    const items: BoardItem[] = [{ col: 1, span: 104 }, { col: 2, span: 118 }, { col: 1, span: 109 }, { col: 2, span: 27 }, { col: 1, span: 105 }, { col: 2, span: 130 }, { col: 2, span: 67 }, { col: 'auto', span: 45 }]
    const { p, e } = ends(items)
    expect(p[0]).toMatchObject({ col: 1, span: 118, filled: true }) // the position panel is lengthened to its neighbour's foot
    expect(p[1]).toMatchObject({ col: 2, span: 118, filled: false, level: true }) // not lengthened, and level with the card that was
    expect(p[4]).toMatchObject({ col: 1, span: 115, filled: true }) // the day book ends with holdings by currency, 40 px lower
    expect(p[7]!.col).toBe('both') // the columns are level, so the last card closes the board across both
    expect(e[0]).toBe(e[1]) // no hole under either column's last card
  })

  it('the same board when the columns are not level at the end: the auto card goes under the shorter, and the feet are levelled', () => {
    const { p, e } = ends([{ col: 1, span: 104 }, { col: 2, span: 180 }, { col: 1, span: 109 }, { col: 2, span: 160 }, { col: 'auto', span: 100 }])
    expect(p[4]!.col).toBe(1)
    expect(e).toEqual([340, 340]) // 313 beside 340: the auto card is lengthened by 27 units
    expect(p[4]!.filled).toBe(true)
  })

  it('leaves two feet that are plainly apart where they are', () => {
    const { p } = ends([{ col: 1, span: 100 }, { col: 2, span: 175 }, { col: 1, span: 200 }, { col: 2, span: 60 }])
    expect(p.map((x) => x.span).slice(0, 2)).toEqual([100, 175])
  })

  it('does not lengthen a card by more than the level limit: a large difference is left', () => {
    const { p, e } = ends([{ col: 1, span: 300 }, { col: 2, span: 100 }])
    expect(p.every((x) => !x.filled)).toBe(true)
    expect(e).toEqual([300, 100])
  })

  it('puts an auto card under the shorter column', () => {
    expect(boardPlan([{ col: 1, span: 200 }, { col: 2, span: 100 }, { col: 'auto', span: 40 }], OPTS)[2]!.col).toBe(2)
    expect(boardPlan([{ col: 1, span: 100 }, { col: 2, span: 200 }, { col: 'auto', span: 40 }], OPTS)[2]!.col).toBe(1)
  })

  it('never shortens a card, and leaves a one-column board alone', () => {
    const items: BoardItem[] = [{ col: 1, span: 80 }, { col: 1, span: 120 }, { col: null, span: 30 }]
    expect(boardPlan(items, OPTS)).toEqual([{ col: 1, span: 80, filled: false }, { col: 1, span: 120, filled: false }, { col: null, span: 30, filled: false }])
    for (let seed = 1; seed < 200; seed++) {
      let s = seed
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
      const its: BoardItem[] = Array.from({ length: 2 + Math.floor(rnd() * 8) }, () => ({ col: (rnd() < 0.2 ? 'auto' : rnd() < 0.5 ? 1 : 2) as BoardItem['col'], span: 10 + Math.floor(rnd() * 200) }))
      const p = boardPlan(its, OPTS)
      p.forEach((x, k) => { expect(x.span).toBeGreaterThanOrEqual(its[k]!.span); expect(x.span - its[k]!.span).toBeLessThanOrEqual(OPTS.snap + OPTS.level) })
      // a lengthened card ends on a foot the other column has, or on the other column's end
      const e = [0, 0]; const feet: [Set<number>, Set<number>] = [new Set(), new Set()]
      const walk = (fn: (x: (typeof p)[number], cs: number[]) => void) => { e[0] = e[1] = 0; p.forEach((x) => { if (!x.col) return; const cs = x.col === 'both' ? [0, 1] : [x.col - 1]; if (x.col === 'both') e[0] = e[1] = Math.max(e[0]!, e[1]!); for (const c of cs) e[c]! += x.span; fn(x, cs) }) }
      walk((_, cs) => { for (const c of cs) feet[c as 0 | 1].add(e[c]!) })
      walk((x, cs) => { if (x.filled && x.col !== 'both') expect(feet[(1 - cs[0]!) as 0 | 1].has(e[cs[0]!]!), `seed ${seed}`).toBe(true) })
    }
  })
})
