/**
 * The sticky side summary (R14 layout rule L2, DESIGN.md): one rule for every two-column page.
 *
 * A summary beside a longer column stays in view while the column scrolls, starts level with the column's top and ends
 * level with the column's foot. Plain `position: sticky; top` gives the first two and fails the third whenever the page
 * ends soon after the column does: the window stops scrolling while the summary is still pinned at the top, and it is
 * left with a hole under it beside the end of the column (the owner's screenshot of "Room above your floor").
 *
 * `stickyPlan` works out where the summary must be pinned so that it ends level, from five measurements, and moves it
 * as little as geometry allows (the shortest path through what is possible):
 *
 *   pinned   the column's foot passes the pinned summary before the page ends: pinned under the top bar, as always.
 *   lowered  the page ends first, but not before the summary has scrolled up to where it must end: pinned there, lower
 *            in the window, a fixed distance for the whole scroll.
 *   drift    the page ends before the summary could reach its place by scrolling (a tall window, a short page): its
 *            pin moves down evenly from where it starts to where it must end, over the whole scroll.
 *   static   the summary is taller than the room between the bars, or there is nothing to travel: it is not pinned and
 *            scrolls with the page, so no part of it is ever out of reach.
 *
 * Every figure is a CSS pixel. The summary's element keeps `position: sticky`; only its `top` is set (kit.tsx
 * useStickySide), so with scripts off it is still a plain sticky summary under the top bar.
 */
export interface StickyMeasure {
  /** The top of the column the summary travels in, from the top of the document. */
  colTop: number
  /** That column's height: the summary may travel from its top to its foot. */
  colHeight: number
  /** The summary's own height. */
  height: number
  /** The window's height. */
  viewport: number
  /** How far the document scrolls: its height less the window's. */
  scrollMax: number
  /** The least distance from the window's top: clear of the top bar. */
  top: number
  /** The room kept at the window's foot: clear of the bottom navigation. */
  bottom: number
}

export type StickyPlan =
  | { mode: 'static' }
  | { mode: 'pinned'; top: number }
  | { mode: 'lowered'; top: number }
  | { mode: 'drift'; from: number; to: number; scrollMax: number }

export function stickyPlan(m: StickyMeasure): StickyPlan {
  const room = m.viewport - m.top - m.bottom
  if (m.height > room || m.colHeight - m.height < 1) return { mode: 'static' }
  // where the summary's top is in the window when the page is at its end and the summary is level with the column's
  // foot; never under the bottom navigation
  const end = Math.min(m.colTop + m.colHeight - m.scrollMax - m.height, m.viewport - m.bottom - m.height)
  if (end <= m.top) return { mode: 'pinned', top: m.top }
  // where it starts: with the column, or under the top bar when the column starts above it
  const start = Math.max(m.top, m.colTop)
  if (end <= start) return { mode: 'lowered', top: Math.round(end) }
  if (m.scrollMax <= 0) return { mode: 'pinned', top: m.top }
  return { mode: 'drift', from: start, to: Math.round(end), scrollMax: m.scrollMax }
}

/** The `top` a plan gives at a scroll position. */
export function stickyTopAt(plan: StickyPlan, scrollY: number): number | null {
  if (plan.mode === 'static') return null
  if (plan.mode !== 'drift') return plan.top
  const t = Math.max(0, Math.min(1, scrollY / plan.scrollMax))
  return Math.round(plan.from + (plan.to - plan.from) * t)
}

/**
 * Where the summary's top is in the window at a scroll position, as the browser places a sticky box: at its `top`, never
 * above its natural place at the column's top and never past the column's foot. For the tests, which check every plan
 * against the three promises (starts level, stays in view, ends level).
 */
export function stickyPlaced(m: StickyMeasure, plan: StickyPlan, scrollY: number): number {
  const natural = m.colTop - scrollY
  const top = stickyTopAt(plan, scrollY)
  if (top === null) return natural
  return Math.min(Math.max(natural, top), natural + m.colHeight - m.height)
}
