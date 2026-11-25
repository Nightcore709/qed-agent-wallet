/**
 * The board (R14 layout rule L3, DESIGN.md): two columns of cards that stack independently, with their edges either
 * level or plainly apart, never nearly level, and with the two columns ending together.
 *
 * Each card keeps its column and sits under the one before it (useMasonry, kit.tsx), so a tall card never leaves a hole
 * beside a short neighbour. That alone left two faults the owner marked: neighbouring cards whose feet missed each other
 * by a little (a hero panel 395 px beside a 450 px one reads as a mistake, where 395 beside 700 reads as two columns),
 * and a column that stopped short of the other at the end of the page, leaving a hole under its last card.
 *
 * `boardPlan` takes each card's natural height in grid units and returns its column, its span and whether it was
 * lengthened:
 *   snap    when a card would end within `snap` units of a card's foot in the other column, the shorter of the two is
 *           lengthened to end with the other; the cards after them then start level too.
 *   auto    a card marked 'auto' goes under whichever column is shorter when its turn comes. When the two columns are
 *           level by then (within `snap`), it has no shorter column to go under and would leave a hole beside it: it
 *           spans both columns instead, as the board's closing band.
 *   level   at the end, the shorter column's last card is lengthened to end with the other column, when the
 *           difference is at most `level` units (a larger difference is left: a card with a hole in it is no better).
 * A lengthened card keeps its content at the top; the space is added inside it, above its foot.
 */
export interface BoardItem { col: 1 | 2 | 'auto' | null; span: number }
/** `filled`: lengthened. `level`: ends on the same line as a card of the other column (whether or not it was the one lengthened). */
export interface BoardPlaced { col: 1 | 2 | 'both' | null; span: number; filled: boolean; level?: boolean }

export function boardPlan(items: BoardItem[], opts: { snap: number; level: number }): BoardPlaced[] {
  const out: BoardPlaced[] = items.map((i) => ({ col: i.col === 'auto' ? null : i.col, span: Math.max(1, i.span), filled: false }))
  const end = [0, 0]                         // how far down each column reaches
  const last = [-1, -1]                      // the last card of each column
  const feet: [number[], number[]] = [[], []] // where each column's cards end
  const grow = (k: number, by: number) => { if (by > 0) { out[k]!.span += by; out[k]!.filled = true } }
  /** Lengthen the last card of column c so the column ends at `to`; a card across both columns is never lengthened. */
  const lengthen = (c: number, to: number): boolean => {
    const k = last[c]!
    if (k < 0 || out[k]!.col === 'both' || to <= end[c]!) return false
    grow(k, to - end[c]!); end[c] = to; feet[c as 0 | 1][feet[c as 0 | 1].length - 1] = to
    return true
  }
  items.forEach((item, k) => {
    if (item.col === null) return
    if (item.col === 'auto' && last[0]! >= 0 && last[1]! >= 0 && Math.abs(end[0]! - end[1]!) <= opts.snap) {
      const to = Math.max(end[0]!, end[1]!)
      if ((end[0] === to || lengthen(0, to)) && (end[1] === to || lengthen(1, to))) {
        out[k]!.col = 'both'
        end[0] = end[1] = to + out[k]!.span; last[0] = last[1] = k; feet[0].push(end[0]); feet[1].push(end[1])
        return
      }
    }
    const c = item.col === 'auto' ? (end[0]! <= end[1]! ? 0 : 1) : item.col - 1
    const o = 1 - c
    out[k]!.col = (c + 1) as 1 | 2
    const foot = end[c]! + out[k]!.span
    // the nearest foot in the other column, if one is within reach
    const near = feet[o as 0 | 1].reduce<number | null>((best, f) => (Math.abs(f - foot) <= opts.snap && (best === null || Math.abs(f - foot) < Math.abs(best - foot)) ? f : best), null)
    if (near !== null && near > foot) grow(k, near - foot)
    if (near !== null && near >= foot) out[k]!.level = true
    end[c] = end[c]! + out[k]!.span; last[c] = k; feet[c as 0 | 1].push(end[c]!)
    // this card ends a little below the other column's last card: that card is lengthened to end with it
    if (near !== null && near < foot && near === end[o] && lengthen(o, foot)) out[k]!.level = true
  })
  if (last[0]! >= 0 && last[1]! >= 0 && end[0] !== end[1] && Math.abs(end[0]! - end[1]!) <= opts.level) lengthen(end[0]! < end[1]! ? 0 : 1, Math.max(end[0]!, end[1]!))
  return out
}
