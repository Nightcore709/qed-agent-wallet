/**
 * What the two balance charts share (Home's Horizon, Save's Score): how a day money moves is marked on the line, named
 * under the chart, and read beside the pointer. R14 layout rule L5 (DESIGN.md).
 *
 * Before R14 each such day was a sentence written on the plot ("Loan instalments −₹30,000.00"), placed by a guess at
 * its width. The sentences ran over the line, over each other and over the figure for what is kept; below 440 px they
 * were dropped, so a phone lost them. Now:
 *
 *   - each day money moves is a small numbered mark beside its step, on the clear side of the line, moved away from any
 *     other mark and from the lowest point's dot (placeMarks: collision avoidance in tiers, above the line first);
 *   - the same number names the day in a list under the chart: the date, what moved, how much, with its sign. Nothing
 *     is dropped at any width, and the list is real text, read by a screen reader as well;
 *   - the label that follows the pointer stands beside the reading line, on the side with more room, inside the plot:
 *     never over the axis figures on the right, never over the dates along the foot, never over the day it reads
 *     (tipPlace).
 *
 * Colour says one thing here: the lowest point. Money in is told by its plus sign and a thin green ring, not by green
 * words across the plot.
 */
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { fmt } from '../lib/core.ts'
import { dayName, type RunwayDay } from './charts.tsx'

export interface ChartEvent {
  /** The day's place among the days drawn, and its number on the chart and in the list (1, 2, 3 in date order). */
  k: number; n: number; date: string
  label: string; amount: number; income: boolean
  /** Part of a what-if, not of the recorded worst case. */
  whatif: boolean
}

/** What moved a day, apart from everyday spending, in a few words; null on a day nothing else moved. */
export function eventOf(d: RunwayDay): Omit<ChartEvent, 'n'> | null {
  const named = d.items.filter((i) => i.kind !== 'net')
  if (named.length === 0) return null
  const amount = named.reduce((s, i) => s + i.amount, 0)
  const one = named.length === 1 ? named[0]!.label.replace(/ instalment$/, '') : null
  const label = one === 'Salary counted on' ? 'Salary, at its latest' : one ?? (amount > 0 ? 'Money in' : named.every((i) => i.kind === 'emi') ? 'Loan instalments' : `${named.length} payments due`)
  return { k: d.k, date: d.date, label, amount, income: amount > 0, whatif: named.some((i) => i.kind === 'whatif') }
}

/** Every day money moves besides everyday spending, numbered in date order. */
export function chartEvents(days: RunwayDay[]): ChartEvent[] {
  const out: ChartEvent[] = []
  for (const d of days) { const e = eventOf(d); if (e) out.push({ ...e, n: out.length + 1 }) }
  return out
}

export const MARK_R = 9
export interface PlacedMark { n: number; k: number; x: number; y: number; numbered: boolean }
export interface MarkGeometry {
  /** The left edge of day k, one day's width, and how many days are drawn. */
  x: (k: number) => number; dayW: number; n: number
  /** The line's height on day k (after that day's step), and before the first day. */
  lineY: (k: number) => number; startY: number
  /** The plot: its width, and the band a mark may stand in. */
  W: number; top: number; bottom: number
  /** What a mark must keep clear of besides the line and the other marks: the lowest point's dot and its halo. */
  avoid?: { x: number; y: number; r: number }[]
}

/**
 * Where each day's numbered mark stands. A mark is a ring of MARK_R beside its day's step, never on the line: every
 * place is tried against the line itself (each day's level and each step's vertical, with three pixels of air), the
 * other marks, the lowest point and the plot's edges. The places, in order: right of the step above the line, left of
 * it above the line, the same two below the line, then one and two tiers further from the line. A mark with no clear
 * place is not numbered on the plot (the chart then draws a plain tick there); its row in the list still names the day.
 */
export function placeMarks(events: ChartEvent[], g: MarkGeometry): PlacedMark[] {
  const taken: { x: number; y: number; r: number }[] = [...(g.avoid ?? [])]
  const air = MARK_R + 3
  const level = (k: number) => (k < 0 ? g.startY : g.lineY(Math.min(k, g.n - 1)))
  const dayAt = (x: number) => Math.max(0, Math.min(g.n - 1, Math.floor(x / (g.dayW || 1))))
  const offLine = (x: number, y: number): boolean => {
    for (let k = dayAt(x - air); k <= dayAt(x + air); k++) {
      if (Math.abs(level(k) - y) < air) return false                                   // the day's level runs through the ring
      const vx = g.x(k), a = level(k - 1), b = level(k)                                 // the step into day k
      if (Math.abs(vx - x) < air && y > Math.min(a, b) - air && y < Math.max(a, b) + air) return false
    }
    return true
  }
  const clear = (x: number, y: number) => x - MARK_R >= 0 && x + MARK_R <= g.W && y - MARK_R >= g.top && y + MARK_R <= g.bottom && offLine(x, y) && taken.every((t) => Math.hypot(t.x - x, t.y - y) >= t.r + MARK_R + 2)
  const reach = MARK_R + 7 // the ring's centre from the line: seven pixels of air
  const tier = 2 * MARK_R + 3
  return events.map((e) => {
    const xs = [g.x(e.k) + Math.max(g.dayW / 2, air + 1), g.x(e.k) - air - 1]
    for (const dy of [-reach, reach, -reach - tier, reach + tier, -reach - 2 * tier]) for (const x of xs) {
      const y = level(dayAt(x)) + dy
      if (clear(x, y)) { taken.push({ x, y, r: MARK_R }); return { n: e.n, k: e.k, x, y, numbered: true } }
    }
    return { n: e.n, k: e.k, x: g.x(e.k) + g.dayW / 2, y: g.lineY(e.k), numbered: false }
  })
}

/**
 * Where the label that follows the pointer stands, as its left and top inside the plot. Beside the reading line, on the
 * side with more room, level with the point and held inside the plot: so it is never over the axis figures to the right
 * of the plot, never over the dates along its foot, and never over the day being read. On a plot too narrow for the
 * label to stand beside the line at all (a phone), it stands over the line, above the point when there is room and
 * otherwise below it.
 */
export function tipPlace(a: { cx: number; cy: number; W: number; bottom: number; w: number; h: number; gap?: number }): { left: number; top: number; side: 'right' | 'left' | 'over' } {
  const gap = a.gap ?? 14
  const within = (top: number) => Math.max(0, Math.min(top, Math.max(0, a.bottom - a.h)))
  const right = a.cx + gap + a.w <= a.W, left = a.cx - gap - a.w >= 0
  if (right && (!left || a.cx <= a.W / 2)) return { left: Math.round(a.cx + gap), top: Math.round(within(a.cy - a.h / 2)), side: 'right' }
  if (left) return { left: Math.round(a.cx - gap - a.w), top: Math.round(within(a.cy - a.h / 2)), side: 'left' }
  const over = Math.max(0, Math.min(a.cx - a.w / 2, a.W - a.w))
  return { left: Math.round(over), top: Math.round(a.cy - gap - a.h >= 0 ? a.cy - gap - a.h : within(a.cy + gap)), side: 'over' }
}

/** The label's own size, measured once it is drawn, for tipPlace; a first guess until then. */
export function useTipSize(shown: unknown): [RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 200, h: 88 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    if (w !== size.w || h !== size.h) setSize({ w, h })
  }, [shown, size.w, size.h])
  return [ref, size]
}

/** A mark on the line: its number in a ring, or a plain tick over the day where no number has room. `on` is the day being read. */
export function Mark({ m, e, on, tickX, lineY }: { m: PlacedMark; e: ChartEvent; on: boolean; tickX: number; lineY: number }) {
  const cls = `cv-mark ${e.whatif ? 'wif' : e.income ? 'in' : ''} ${on ? 'on' : ''}`
  if (!m.numbered) return <line className={cls} x1={tickX} x2={tickX} y1={lineY - 5} y2={lineY - 13} />
  return <g className={cls}><circle cx={m.x} cy={m.y} r={MARK_R} /><text x={m.x} y={m.y} textAnchor="middle" dominantBaseline="central">{m.n}</text></g>
}

const FIRST = 8
/**
 * The days money moves, under the chart: the number that marks each on the line, the day, what moved and how much.
 * Every day drawn is here at every width; past eight they wait behind one disclosure. Pointing at a row reads that day
 * on the chart.
 */
export function ChartEvents({ events, at, onPick, id }: { events: ChartEvent[]; at: number | null; onPick: (k: number | null) => void; id: string }) {
  if (events.length === 0) return null
  const row = (e: ChartEvent) => (
    <li key={e.k} className={at === e.k ? 'on' : ''} onPointerEnter={() => onPick(e.k)} onPointerLeave={() => onPick(null)}>
      <span className={`cv-n ${e.whatif ? 'wif' : e.income ? 'in' : ''}`} aria-hidden="true">{e.n}</span>
      <span className="cv-what"><span className="sr">{e.n}. </span>{e.label}{e.whatif ? <span className="cv-tag"> what-if</span> : null}<small>{dayName(e.date)}</small></span>
      <span className={`cv-amt ${e.income ? 'in' : ''}`}>{fmt.signed(e.amount, true)}</span>
    </li>
  )
  return (
    <div className="cv-events">
      <p className="cv-events-h" id={`${id}-ev`}>Days money moves, as numbered on the line</p>
      <ol aria-labelledby={`${id}-ev`}>{events.slice(0, FIRST).map(row)}</ol>
      {events.length > FIRST ? <details><summary>{events.length - FIRST} more day{events.length - FIRST === 1 ? '' : 's'}, to number {events.length}</summary><ol aria-labelledby={`${id}-ev`} start={FIRST + 1}>{events.slice(FIRST).map(row)}</ol></details> : null}
    </div>
  )
}
