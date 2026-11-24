/**
 * A recorded or published value over true time (a price buyers offered, a fund's NAV, a reference rate). The points
 * are the data: no smoothing and no fill. Both axes carry their unit: the value axis says what is counted and in what
 * ("₹ per BTC"), the time axis says whose clock ("India time"). Where nothing was recorded for much longer than usual,
 * the line stops and the stretch is marked by its two edges and named, so a gap in the record looks like a gap and not
 * like a flat price; nothing is painted over it. It describes what was recorded; it projects nothing. Design system
 * "Meridian" (DESIGN.md M6); styles in grow.css. Fetched as its own chunk, after the page's figures and controls are
 * drawn (R12 perf); the formatters Grow needs at once live in prices.ts and are re-exported here.
 *
 * A published value (a fund's NAV, a rate, a reference value: points whose time is an ISO day) is drawn as the step it
 * is (R12, the owner: "correct daily NAV presentation"). A fund publishes one NAV for each business day and it holds
 * until the next: so each value is a level from the start of its day (India time) to the start of the next value's day,
 * across the weekend or holiday between, and the last holds to the time the record is read; a jump between two values
 * is a thin riser, never a slope, so no value between two NAVs is ever drawn or read. Each day a value was published is
 * marked (a dot on the step where there is room, else a tick on the time axis). The reading names the day the value is
 * for ("NAV for Fri 20 Nov 2026"), and on a day with nothing published it says which value holds and since when.
 *
 * Adapted from the owner's Peak Chart reference: a lit line with a soft glow under it, a faint grid that fades upward,
 * a reading dot that follows the pointer (it glides to the nearest recorded point, never to a value between two), a
 * glass label beside the dot, the line drawn from the left when the chart is first seen (a clip: every value is whole
 * from the first frame). Not taken: the figure that counts up, the comet head that implies motion of value, the
 * smoothed curve (it would draw values that were never recorded), the demonstration data.
 *
 * The scale means something: it spans at least 1% of the latest value, so a move of a few paise on a price of lakhs is
 * drawn as the small move it is (R11: the 24-hour Bitcoin chart drew a 10-paise change on ₹64 lakh from the bottom of
 * the plot to its top, with axis steps of 2 paise, finer than the venue's own price step). It reads under a pointer, a
 * finger or the keyboard; the same reading is written above the chart in words and said to a screen reader.
 *
 * Until 23 Nov 2026 each stretch with nothing recorded was a rectangle the height of the plot, filled with the surface
 * colour of a well and drawn over the grid: on a record with downtime (an engine restarted, a computer asleep) it was
 * an opaque block over most of the Bitcoin chart (the owner's report, R10). Until 24 Nov 2026 daily NAVs were joined by
 * sloping lines, which drew values between two NAVs that no fund ever published.
 */
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { DAY, dayStart, dayWords, IST, isoDayOf, MONTHS, pointTime, WEEKDAYS } from './prices.ts'

export { atomsText, pointTime, priceDecimals, priceText, quantityText } from './prices.ts'

const MINUTE = 60_000, HOUR = 3_600_000
const ist = (t: number): Date => new Date(t + IST)
const p2 = (n: number): string => String(n).padStart(2, '0')

/** Stretches with nothing recorded: longer than six usual steps, and never under a minute. */
export function gapsOf(ts: number[]): [number, number][] {
  if (ts.length < 3) return []
  const steps = ts.slice(1).map((t, i) => t - ts[i]!).sort((a, b) => a - b)
  const limit = Math.max((steps[Math.floor(steps.length / 2)] ?? 0) * 6, 60_000)
  const out: [number, number][] = []
  for (let i = 1; i < ts.length; i++) if (ts[i]! - ts[i - 1]! > limit) out.push([ts[i - 1]!, ts[i]!])
  return out
}

/** The stretch with nothing recorded that a time falls inside (strictly between its two recorded ends), if any. */
export function gapAt(gaps: [number, number][], t: number): [number, number] | null {
  return gaps.find(([a, b]) => t > a && t < b) ?? null
}

/** A length of time as a person says it: "50 s", "4 min", "2 h 10 min", "3 days". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`
  if (ms < 2 * DAY) { const h = Math.floor(ms / HOUR), m = Math.round((ms - h * HOUR) / MINUTE); return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h` }
  return `${Math.round(ms / DAY)} days`
}

/** The index of the recorded time nearest to `t` (times ascending). */
export function nearestIndex(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid]! <= t) lo = mid; else hi = mid }
  return Math.abs(ts[hi]! - t) < Math.abs(ts[lo]! - t) ? hi : lo
}

// ------------------------------------------------------------------------------------------------ published values as steps

/** How long one published value held: from the start of its day to the start of the next value's day (India time). */
export interface Hold { i: number; day: string; v: number; from: number; to: number; next: string | null }

/**
 * Daily values as the steps they are. Each holds from the start of its own day until the next value's day begins, so a
 * Friday NAV holds through Saturday and Sunday; the last holds until `until` (the time the record is read) when that is
 * later, else to the end of its own day. Across a stretch with nothing published for much longer than usual (gapsOf on
 * the days: six usual steps) the earlier value is not carried: it holds its own day, the stretch is a gap in the record,
 * and the line starts again with the next value. Never a slope: nothing between two values is ever a value.
 */
export function holdsOf(points: { t: string; v: number }[], until?: number): Hold[] {
  const starts = points.map((p) => dayStart(p.t))
  const gaps = gapsOf(starts)
  const broken = new Set(gaps.map(([a]) => a))
  return points.map((p, i) => {
    const from = starts[i]!
    const next = points[i + 1]
    const to = next ? (broken.has(from) ? from + DAY : starts[i + 1]!) : until !== undefined && until > from + DAY ? until : from + DAY
    return { i, day: p.t, v: p.v, from, to, next: next && !broken.has(from) ? next.t : null }
  })
}

/** The step a time falls on, if any (a time in a gap in the record, or outside the record, falls on none). */
export function holdAt(holds: Hold[], t: number): Hold | null {
  let lo = 0, hi = holds.length - 1
  if (hi < 0 || t < holds[0]!.from || t >= holds[hi]!.to) return t === holds[hi]?.to ? holds[hi]! : null
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (holds[mid]!.from <= t) lo = mid; else hi = mid - 1 }
  const h = holds[lo]!
  return t < h.to ? h : null
}

/**
 * The days a published value held beyond its own, in words: "" when it held only its own day; "held through Sun 22 Nov"
 * across a weekend or a holiday; for the latest, that it holds until the next is published.
 */
export function heldWords(h: Hold, last: boolean): string {
  if (last && h.next === null) return isoDayOf(h.to - 1) === h.day ? '' : 'the latest: it holds until the next is published'
  const lastDay = isoDayOf(h.to - 1)
  return lastDay === h.day ? '' : `held through ${dayWords(lastDay, false)}`
}
/** Where a published value is read and marked: the middle of the day it is for (its step's first day). */
export const midDay = (h: Hold): number => Math.min(h.from + DAY / 2, (h.from + h.to) / 2)

/**
 * The table a published series is read from instead of its chart: one row for each value published, the day it is
 * for, the value exactly as the chart draws it, and the days it held beyond its own; a gap in the record is a row of
 * its own. Exactly what the steps show, nothing between two values and nothing left out.
 */
export function dailyRows(holds: Hold[]): ({ kind: 'value'; day: string; v: number; held: string } | { kind: 'gap'; from: string; to: string })[] {
  const out: ({ kind: 'value'; day: string; v: number; held: string } | { kind: 'gap'; from: string; to: string })[] = []
  holds.forEach((h, i) => {
    out.push({ kind: 'value', day: h.day, v: h.v, held: heldWords(h, i === holds.length - 1) })
    const n = holds[i + 1]
    if (n && h.next === null) out.push({ kind: 'gap', from: isoDayOf(h.to), to: isoDayOf(n.from - 1) })
  })
  return out
}

/**
 * Where a person reads a published series at a time: on a day a value was published, that value; on a day with none
 * (a weekend, a holiday, or after the latest), the value that held and the day it is for; in a gap in the record,
 * nothing. Never a value between two published ones.
 */
export function readDaily(holds: Hold[], t: number): { kind: 'point'; i: number } | { kind: 'held'; i: number; t: number } | null {
  const h = holdAt(holds, t)
  if (!h) return null
  return isoDayOf(Math.min(t, h.to - 1)) === h.day ? { kind: 'point', i: h.i } : { kind: 'held', i: h.i, t }
}

/**
 * How current the latest published value is, in words, by the server's own judgement of staleness (each fund's
 * `staleAfterMs`, which allows for weekends and holidays): "the latest published" while it is current; once the server
 * says it is stale, how many days old the day it is for is ("stale: for a day 6 days ago").
 */
export function dailyAge(day: string, now: number, stale: boolean): string {
  if (!stale) return 'the latest published'
  const days = Math.max(0, Math.round((dayStart(isoDayOf(now)) - dayStart(day)) / DAY))
  return `stale: for a day ${days} day${days === 1 ? '' : 's'} ago, and nothing newer published`
}

// ------------------------------------------------------------------------------------------------ axes

export interface TimeTick { t: number; label: string; major: boolean }
/**
 * Round times between t0 and t1 in India time, at most `max` of them: minutes or hours over a day or two (a new day named at its
 * midnight), days over a week or two, months over a season or a year (the year named in January), years beyond.
 */
export function timeTicks(t0: number, t1: number, max: number): TimeTick[] {
  const spanMs = t1 - t0, out: TimeTick[] = []
  if (spanMs <= 2 * DAY) {
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].find((m) => spanMs / (m * MINUTE) <= max) ?? 1440
    for (let q = Math.ceil((t0 + IST) / (step * MINUTE)) * step; ; q += step) {
      const t = q * MINUTE - IST
      if (t > t1) break
      const d = ist(t)
      out.push(d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? { t, label: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, major: true } : { t, label: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`, major: false })
    }
    return out
  }
  if (spanMs <= 62 * DAY) {
    const step = [1, 2, 7, 14].find((n) => spanMs / (n * DAY) <= max) ?? 28
    for (let k = Math.ceil((t0 + IST) / DAY); ; k += step) {
      const t = k * DAY - IST
      if (t > t1) break
      const d = ist(t)
      const first = d.getUTCDate() === 1
      out.push({ t, label: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}${first || step >= 7 ? ` ${MONTHS[d.getUTCMonth()]}` : ''}`, major: first })
    }
    return out
  }
  const months = spanMs / (30.44 * DAY)
  const step = [1, 2, 3, 6, 12].find((m) => months / m <= max) ?? 24
  const s = ist(t0)
  let y = s.getUTCFullYear(), m = s.getUTCMonth() + 1
  if (m > 11) { m = 0; y += 1 }
  for (let i = 0; i < 200; i++) {
    if (m % step === 0) {
      const t = Date.UTC(y, m, 1) - IST
      if (t > t1) break
      if (t >= t0) out.push(m === 0 ? { t, label: step >= 6 ? String(y) : `Jan ${y}`, major: true } : { t, label: MONTHS[m]!, major: false })
    }
    m += 1
    if (m > 11) { m = 0; y += 1 }
  }
  return out
}

/** Round values strictly inside [lo, hi], about `n` of them, with the decimals their step needs. */
export function valueTicks(lo: number, hi: number, n = 4): { values: number[]; decimals: number } {
  const range = hi - lo || Math.abs(hi) * 0.01 || 1
  const raw = range / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag
  const step = (f >= 5 ? 5 : f >= 2 ? 2 : 1) * mag
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
  const values: number[] = []
  for (let i = Math.ceil(lo / step); i * step <= hi + step * 1e-9; i++) values.push(Number((i * step).toFixed(decimals)))
  return { values, decimals }
}

/**
 * The value scale of a line: the recorded range, but never narrower than `least` of the latest value (1% unless told
 * otherwise), centred on the range, so a change of a few paise on a price of lakhs is drawn as the small change it
 * is. A reference level within the range's own height of it (what was paid, say) is taken into the scale so it can be
 * drawn, and the line keeps at least half the plot; one farther away is not, and is named at the edge it lies beyond,
 * so the line is never squeezed flat by it. A little room is left above and below.
 */
export function valueScale(vs: number[], least = 0.01, marks: number[] = []): { lo: number; hi: number; above: number[]; below: number[] } {
  const fin = vs.filter(Number.isFinite)
  let lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1
  const level = Math.abs(fin[fin.length - 1] ?? 0) || Math.max(Math.abs(lo), Math.abs(hi)) || 1
  const min = level * least
  if (hi - lo < min) { const mid = (lo + hi) / 2; lo = mid - min / 2; hi = mid + min / 2 }
  const reach = hi - lo
  const above = marks.filter((m) => m > hi + reach), below = marks.filter((m) => m < lo - reach)
  for (const m of marks) if (m >= lo - reach && m <= hi + reach) { lo = Math.min(lo, m); hi = Math.max(hi, m) }
  const pad = (hi - lo) * 0.08
  return { lo: lo - pad, hi: hi + pad, above, below }
}

/** A recorded time in words: the day for a daily value, else the day and the minute (India time). */
export const when = (t: number, daily: boolean): string => { const d = ist(t); return daily ? `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` }
/** The same time, short enough for a label on the time axis. */
const axisWhen = (t: number, daily: boolean, spanMs: number): string => { const d = ist(t); return daily || spanMs > 2 * DAY ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${daily && spanMs > 300 * DAY ? ` ${d.getUTCFullYear()}` : ''}` : `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` }
/** A stretch with nothing recorded, in words: "18:03 to 18:07" within a day, with the days otherwise. */
export function stretch(a: number, b: number, daily: boolean): string {
  const da = ist(a), db = ist(b)
  if (daily) return `${when(a, true)} to ${when(b, true)}`
  const sameDay = da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate()
  return sameDay ? `${p2(da.getUTCHours())}:${p2(da.getUTCMinutes())} to ${p2(db.getUTCHours())}:${p2(db.getUTCMinutes())} on ${db.getUTCDate()} ${MONTHS[db.getUTCMonth()]}` : `${when(a, false)} to ${when(b, false)}`
}

type Reading = { kind: 'point'; i: number } | { kind: 'held'; i: number; t: number } | { kind: 'gap'; a: number; b: number; t: number }

/** Width and height of a box, kept current as the layout changes (a chart that fills its row grows with it). */
function useBox(): [React.RefObject<HTMLDivElement | null>, number, number] {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const ro = new ResizeObserver((es) => { const r = es[0]?.contentRect; if (r && r.width > 0) setSize([Math.round(r.width), Math.round(r.height)]) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [box, size[0], size[1]]
}

/** A level drawn across the plot for comparison (what was paid), with the words that name it. */
export interface Level { v: number; label: string }

/** How each published day is marked: a dot on its step where there are 6 px or more for each, a tick on the axis down to 2 px, else none. */
export const publicationMarks = (plotW: number, n: number): 'dots' | 'ticks' | 'none' => { const each = plotW / Math.max(1, n); return each >= 6 ? 'dots' : each >= 2 ? 'ticks' : 'none' }

/**
 * The chart. `show` writes a value exactly (a price at its step); `tick` writes an axis label (the same, at the axis's
 * step). `unit` names what the value axis counts ("₹ per BTC"). `gapWhy` says why a stretch can be empty ("QED was
 * not running or the source was silent"). Points with an ISO day are published daily values, drawn as steps (see the
 * head of this file); `valueWord` names them ("NAV") and `until` is when the record is read (the last value holds to
 * it). `fill` lets the plot grow to the height its row gives it (never under `height`); `levels` are drawn dashed across.
 */
export function TimeChart({ points, show, tick, height = 260, describe, unit, gapWhy = 'nothing was recorded', width, fill, levels = [], valueWord = 'Value', until }: {
  points: { t: string | number; v: number }[]; show: (v: number) => string; tick: (v: number, decimals: number, narrow: boolean) => string; height?: number
  /** One sentence for a screen reader: what the line is. */
  describe: string
  unit: string
  gapWhy?: string
  /** A fixed width in pixels, for drawing where nothing is laid out (a test); otherwise the box's own width. */
  width?: number
  fill?: boolean
  levels?: Level[]
  /** What a published daily value is called in a reading: "NAV for Fri 20 Nov 2026". */
  valueWord?: string
  /** When the record is read (now): the latest published value holds until then. */
  until?: number
}) {
  const [box, measuredW, measuredH] = useBox()
  const w = width ?? measuredW
  const H = width !== undefined || !fill ? height : Math.max(height, measuredH)
  const [held, setAt] = useState<Reading | null>(null)
  const [focused, setFocused] = useState(false)
  // the line is drawn from the left when the chart is first seen; until it is scrolled to, it waits (motion only)
  const [wait, setWait] = useState(false)
  const [run, setRun] = useState(0)
  const id = useId()
  const gid = id.replace(/[^a-zA-Z0-9_-]/g, '')
  useEffect(() => {
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) return undefined
    setWait(true)
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { io.disconnect(); setWait(false); setRun((n) => n + 1) } }, { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [box])

  const pts = points.map((p) => ({ t: pointTime(p.t), v: p.v, daily: typeof p.t === 'string', day: typeof p.t === 'string' ? p.t : '' })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
  if (pts.length < 2) {
    return (
      <div className="tchart">
        <p className="chart-read small" aria-hidden="true"><span className="muted">Not enough recorded values to draw yet.</span></p>
        <div ref={box} className="tc-plot tc-empty" style={{ height }}><p className="small">A line appears once two values have been recorded.</p></div>
      </div>
    )
  }
  const daily = pts[0]!.daily
  // a published series as steps: each value from the start of its day to the start of the next value's day
  const holds = daily ? holdsOf(pts.map((p) => ({ t: p.day, v: p.v })), until) : []
  // a reading held from an earlier record (a finger's, which stays after it lifts) that this record no longer has is dropped
  const at = (held?.kind === 'point' || held?.kind === 'held') && held.i >= pts.length ? null : held
  const ts = daily ? holds.map((h) => h.from) : pts.map((p) => p.t)
  const vs = pts.map((p) => p.v)
  const t0 = ts[0]!, t1 = daily ? holds[holds.length - 1]!.to : ts[ts.length - 1]!
  const vlo = Math.min(...vs), vhi = Math.max(...vs)
  const scale = valueScale(vs, 0.01, levels.map((l) => l.v))
  const lo = scale.lo, hi = scale.hi
  const narrow = w < 560
  const padT = 26, padB = 28
  const plotH = Math.max(40, H - padT - padB)
  const yt = valueTicks(lo, hi, plotH > 240 ? 4 : 3)
  const labels = yt.values.map((v) => tick(v, yt.decimals, narrow))
  // the value pills on the axis are guides: on a chart under 400 px they take the axis's short form, so the plot keeps
  // its width; the exact value is in the reading above the chart and in the label beside the dot
  const tiny = w < 400
  const pillText = (v: number): string => (tiny ? tick(v, Math.max(yt.decimals, 1), true) : show(v))
  const axisW = Math.min(118, Math.max(tiny ? 64 : 72, Math.max(...labels.map((l) => l.length), pillText(vhi).length, unit.length) * 7 + 16))
  // the unit of the value axis sits above the plot; the time axis's labels and its clock sit below it
  const plotW = Math.max(1, w - axisW)
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * plotW
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH
  // a stretch with nothing recorded (or, for a published series, nothing published for six usual steps)
  const gaps: [number, number][] = daily ? holds.filter((h, i) => h.next === null && i < holds.length - 1).map((h) => [h.to, holds[h.i + 1]!.from]) : gapsOf(ts)
  const after = new Map(gaps.map(([a, b]) => [b, a])) // the first point after a stretch, and where that stretch began
  let d = '', risers = ''
  if (daily) {
    holds.forEach((h) => { d += `M${x(h.from).toFixed(1)} ${y(h.v).toFixed(1)}H${x(h.to).toFixed(1)}` })
    holds.forEach((h) => { const n = holds[h.i + 1]; if (n && h.next !== null) risers += `M${x(h.to).toFixed(1)} ${y(h.v).toFixed(1)}V${y(n.v).toFixed(1)}` })
  } else pts.forEach((p, i) => { d += `${i === 0 || after.has(p.t) ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}` })
  const marks = daily ? publicationMarks(plotW, holds.length) : 'none'
  const last = pts[pts.length - 1]!, first = pts[0]!
  // a recorded value sits at its time; a published one in the middle of the day it is for (its step's first day)
  const tOf = (i: number): number => (daily ? midDay(holds[i]!) : pts[i]!.t)
  const lastX = x(tOf(pts.length - 1))
  const p = at?.kind === 'point' || at?.kind === 'held' ? pts[at.i]! : null
  // where the reading sits: on its point, or (a day with nothing published) at the time being read, on the step that holds
  const readT = at === null ? 0 : at.kind === 'point' ? tOf(at.i) : Math.min(at.t, t1 - 1)
  const cursorX = at === null ? null : Math.max(0, Math.min(plotW, x(readT)))
  // the reading's time on the time axis, kept inside the plot; the round times under it give way
  const timeText = at === null ? '' : axisWhen(readT, daily, t1 - t0)
  const timeW = timeText.length * 7 + 14
  const timeX = cursorX === null ? 0 : Math.max(0, Math.min(plotW - timeW, cursorX - timeW / 2))
  const xt = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / (daily ? 64 : 72)))).filter((k) => x(k.t) > 24 && x(k.t) < plotW - 24)
    .filter((k) => cursorX === null || x(k.t) < timeX - 26 || x(k.t) > timeX + timeW + 26)
  const pointAt = (clientX: number, el: Element): Reading | null => {
    const t = t0 + ((clientX - el.getBoundingClientRect().left) / plotW) * (t1 - t0)
    const g = gapAt(gaps, t)
    if (g) return { kind: 'gap', a: g[0], b: g[1], t }
    if (daily) return readDaily(holds, Math.max(t0, Math.min(t1 - 1, t)))
    return { kind: 'point', i: nearestIndex(ts, Math.max(t0, Math.min(t1, t))) }
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setAt(null); return }
    const cur = at?.kind === 'point' || at?.kind === 'held' ? at.i : at?.kind === 'gap' ? nearestIndex(ts, at.t) : pts.length - 1
    const big = Math.max(1, Math.round(pts.length / 10))
    const next = e.key === 'ArrowRight' ? cur + 1 : e.key === 'ArrowLeft' ? cur - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? pts.length - 1 : e.key === 'PageDown' ? cur + big : e.key === 'PageUp' ? cur - big : null
    if (next === null) return
    e.preventDefault()
    setAt({ kind: 'point', i: Math.max(0, Math.min(pts.length - 1, next)) })
  }
  const change = p && first.v !== 0 ? (p.v - first.v) / Math.abs(first.v) : null
  // the point being read is the first after a stretch with nothing recorded (or published)
  const startOf = (i: number): number => (daily ? holds[i]!.from : pts[i]!.t)
  const since = at?.kind === 'point' ? after.get(startOf(at.i)) : undefined
  const sinceText = at?.kind === 'point' && since !== undefined ? duration(startOf(at.i) - since) : ''
  const pill = (v: number, cls: string) => { const yy = Math.max(padT + 9, Math.min(padT + plotH - 9, y(v))); return <g className={cls}><rect x={plotW + 4} y={yy - 10} width={axisW - 6} height={20} rx={10} /><text x={plotW + 11} y={yy + 4}>{pillText(v)}</text></g> }
  // a published value is read by the day it is for; a recorded one by its time
  const forDay = (i: number): string => `${valueWord} for ${dayWords(holds[i]!.day)}`
  // a day with no value of its own: none published that day (a weekend, a holiday), or, after the latest, none yet
  const noneOn = (i: number, t: number): string => `${dayWords(isoDayOf(Math.min(t, t1 - 1)))}: no ${valueWord} published ${i === holds.length - 1 ? 'yet' : 'that day'}`
  const heldText = (i: number): string => heldWords(holds[i]!, i === holds.length - 1)
  const said = daily
    ? `${describe} Drawn as steps: each of the ${holds.length} published values holds from its day until the next is published; a jump is a new value, never a slope. Between ${show(vlo)} and ${show(vhi)} over the period; the latest is the ${forDay(holds.length - 1)}: ${show(last.v)}.${gaps.length ? ` ${gaps.length} stretch${gaps.length === 1 ? '' : 'es'} with nothing ${gapWhy === 'nothing was published' ? 'published' : 'recorded'}, ${duration(gaps.reduce((s, [a, b]) => s + b - a, 0))} in all, where the line stops.` : ''}${levels.map((l) => ` ${l.label}.`).join('')}`
    : `${describe} Between ${show(vlo)} and ${show(vhi)} over the period; the latest value is ${show(last.v)}, ${when(last.t, daily)}.${gaps.length ? ` ${gaps.length} stretch${gaps.length === 1 ? '' : 'es'} with nothing recorded, ${duration(gaps.reduce((s, [a, b]) => s + b - a, 0))} in all, where the line stops.` : ''}${levels.map((l) => ` ${l.label}.`).join('')}`
  const spoken = at === null ? '' : at.kind === 'gap' ? `Nothing recorded from ${stretch(at.a, at.b, daily)}.`
    : at.kind === 'held' ? `${noneOn(at.i, at.t)}; the ${forDay(at.i)} holds, ${show(pts[at.i]!.v)}.`
      : daily ? `${forDay(at.i)}: ${show(pts[at.i]!.v)}${heldText(at.i) ? `, ${heldText(at.i)}` : ''}.${sinceText ? ` The first after nothing was published for ${sinceText}.` : ''}`
        : `${when(pts[at.i]!.t, daily)}: ${show(pts[at.i]!.v)}.${sinceText ? ` The first value after nothing was recorded for ${sinceText}.` : ''}`

  // a level's name sits at the end of the plot where the line is farthest from it, on the side of the level away
  // from the line, so the words never lie over the line
  const lineYNear = (x0: number, x1: number): number => { const ys = pts.filter((_, i) => x(tOf(i)) >= x0 && x(tOf(i)) <= x1).map((q) => y(q.v)); return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : y(last.v) }
  const drawn = levels.filter((l) => l.v >= lo && l.v <= hi).map((l) => {
    const ly = y(l.v)
    const left = lineYNear(0, Math.min(plotW, 160)), right = lineYNear(Math.max(0, plotW - 160), plotW)
    const onLeft = Math.abs(left - ly) >= Math.abs(right - ly)
    const lineY = onLeft ? left : right
    const below = lineY < ly ? ly + 15 : ly - 7
    return { l, ly, x: onLeft ? 8 : plotW - 8, anchor: (onLeft ? 'start' : 'end') as 'start' | 'end', ty: Math.max(padT + 11, Math.min(padT + plotH - 5, below)) }
  })
  const beyond = levels.filter((l) => scale.above.includes(l.v) || scale.below.includes(l.v))

  // the glass label beside the reading: above the dot, or below it near the top; inside the chart either way
  const half = Math.min(110, w / 2 - 2) // the label is at most 220 px wide, and never wider than the chart
  const dotX = cursorX ?? 0 // the reading's dot, on the line (a recorded point) or on the step that holds
  const tipX = p ? Math.max(half, Math.min(w - half, dotX)) : 0
  const tipUp = p ? y(p.v) - padT > 66 : true
  return (
    <div className={['tchart', wait ? 'tc-wait' : '', fill ? 'tc-fill' : '', daily ? `tc-steps tc-marks-${marks}` : ''].filter(Boolean).join(' ')}>
      <p className="chart-read small" aria-hidden="true">{at === null
        ? <span className="muted">Point at the line, or touch it, to read a value.</span>
        : at.kind === 'gap'
          ? <><span className="muted">No record from </span><strong>{stretch(at.a, at.b, daily)}</strong><span className="muted">: {gapWhy}.</span></>
          : at.kind === 'held'
            ? <><span className="muted">{noneOn(at.i, at.t)}. The {forDay(at.i)} holds: </span><strong>{show(pts[at.i]!.v)}</strong></>
            : <><span className="muted">{daily ? forDay(at.i) : when(pts[at.i]!.t, daily)}</span> <strong>{show(pts[at.i]!.v)}</strong>{change !== null && at.i !== 0 ? <span className="muted"> {change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(2)}% since the start of the line</span> : null}{daily && heldText(at.i) ? <span className="muted">; {heldText(at.i)}</span> : null}{sinceText ? <span className="muted">, the first value after {sinceText} with no record</span> : null}</>}</p>
      <div ref={box} className="tc-plot" style={fill && width === undefined ? { minHeight: height } : { height }}>
        {w > 0 ? (
          <svg className="chart" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-labelledby={`${id}-t`} tabIndex={0} style={{ touchAction: 'pan-y' }}
            onPointerMove={(e) => setAt(pointAt(e.clientX, e.currentTarget))} onPointerDown={(e) => setAt(pointAt(e.clientX, e.currentTarget))} onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !focused) setAt(null) }}
            onFocus={() => { setFocused(true); if (at === null) setAt({ kind: 'point', i: pts.length - 1 }) }} onBlur={() => { setFocused(false); setAt(null) }} onKeyDown={key}>
            <title id={`${id}-t`}>{said}</title>
            <defs>
              {/* the grid fades upward: strongest at the time axis, faint at the top (a stroke in the plot's own space) */}
              <linearGradient id={`${gid}-fade`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={padT} y2={padT + plotH}><stop offset="0" className="tc-fade-top" /><stop offset="1" className="tc-fade-bottom" /></linearGradient>
              <filter id={`${gid}-glow`} x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="5" /></filter>
              <radialGradient id={`${gid}-halo`}><stop offset="0" className="tc-halo-in" /><stop offset="1" className="tc-halo-out" /></radialGradient>
            </defs>
            <g className="tc-grid" stroke={`url(#${gid}-fade)`}>
              {yt.values.map((v) => <line key={v} x1={0} x2={plotW} y1={y(v)} y2={y(v)} />)}
              {xt.map((k) => <line key={k.t} className="tc-vgrid" x1={x(k.t)} x2={x(k.t)} y1={padT} y2={padT + plotH} />)}
            </g>
            {/* a stretch with nothing recorded: its two edges and its name, behind everything; nothing is painted over the plot */}
            {gaps.map(([a, b], i) => (
              <g key={i} className="tc-gap">
                <line className="tc-gap-edge" x1={x(a)} x2={x(a)} y1={padT} y2={padT + plotH} />
                <line className="tc-gap-edge" x1={x(b)} x2={x(b)} y1={padT} y2={padT + plotH} />
                <line className="tc-gap-span" x1={x(a)} x2={x(b)} y1={padT + plotH + 1} y2={padT + plotH + 1} />
                {x(b) - x(a) > 62 ? <text className="tc-gap-label" x={(x(a) + x(b)) / 2} y={padT + 14} textAnchor="middle">No record</text> : null}
              </g>
            ))}
            {/* each day a value was published, as a tick on the time axis when the steps are too close for a dot each */}
            {marks === 'ticks' ? <path className="tc-pub-ticks" d={holds.map((h) => `M${x(midDay(h)).toFixed(1)} ${padT + plotH - 5}V${padT + plotH}`).join('')} /> : null}
            {/* an axis label within a pill's height of the value pill (the latest value, or the one being read) is left out, so the pill never covers it */}
            {yt.values.map((v, i) => (Math.abs(y(v) - y(p ? p.v : last.v)) < 18 ? null : <text key={v} className="tc-tick" x={plotW + 11} y={y(v) + 4}>{labels[i]}</text>))}
            <text className="tc-unit" x={plotW + 11} y={12}>{unit}</text>
            <line className="tc-axis" x1={0} x2={plotW} y1={padT + plotH} y2={padT + plotH} />
            {xt.map((k) => <g key={k.t}><line className={k.major ? 'tc-major' : 'tc-minor'} x1={x(k.t)} x2={x(k.t)} y1={padT + plotH} y2={padT + plotH + 5} /><text className={`tc-tick ${k.major ? 'tc-day' : ''}`} x={x(k.t)} y={H - 8} textAnchor="middle">{k.label}</text></g>)}
            <text className="tc-unit" x={plotW + 11} y={H - 8}>India time</text>
            {drawn.map((m) => <g key={m.l.label} className="tc-level"><line x1={0} x2={plotW} y1={m.ly} y2={m.ly} /><text x={m.x} y={m.ty} textAnchor={m.anchor}>{m.l.label}</text></g>)}
            {beyond.map((l, i) => <text key={l.label} className="tc-level-far" x={8} y={scale.above.includes(l.v) ? padT + 12 + i * 15 : padT + plotH - 7 - i * 15}>{scale.above.includes(l.v) ? '↑ ' : '↓ '}{l.label}</text>)}
            <g className="tc-reveal" key={`${run}:${t0}:${daily ? last.t : t1}:${pts.length}`}>
              <path className="tc-glow" d={d} filter={`url(#${gid}-glow)`} />
              {risers ? <path className="tc-riser" d={risers} /> : null}
              <path className="tc-line" d={d} />
              {marks === 'dots' ? <path className="tc-pub" d={holds.map((h) => `M${x(midDay(h)).toFixed(1)} ${y(h.v).toFixed(1)}h0`).join('')} /> : null}
            </g>
            <circle className="tc-halo" cx={lastX} cy={y(last.v)} r="13" fill={`url(#${gid}-halo)`} />
            <circle className="tc-last" cx={lastX} cy={y(last.v)} r="4" />
            {!p ? pill(last.v, 'tc-pill latest') : null}
            {cursorX !== null ? <g className="tc-cross">
              <line className="tc-cursor" x1={0} x2={0} y1={padT} y2={padT + plotH} style={{ transform: `translateX(${cursorX.toFixed(1)}px)` }} />
              {p ? <><g className="tc-at" style={{ transform: `translate(${dotX.toFixed(1)}px, ${y(p.v).toFixed(1)}px)` }}><circle className="tc-at-halo" r="11" /><circle className="tc-at-dot" r="5" /></g>{pill(p.v, 'tc-pill at')}</> : null}
              <g className="tc-pill at"><rect x={timeX} y={padT + plotH + 4} width={timeW} height={20} rx={10} /><text x={timeX + 7} y={padT + plotH + 18}>{timeText}</text></g>
            </g> : null}
          </svg>
        ) : null}
        {/* on a chart under 400 px the label would cover much of the plot: the reading above the chart says the same */}
        {p && !tiny ? (
          <div className={`tc-tip ${tipUp ? 'up' : 'down'}`} aria-hidden="true" style={{ transform: `translate(${tipX.toFixed(1)}px, ${y(p.v).toFixed(1)}px)` }}>
            <span className="tc-tip-when">{at?.kind === 'held' ? `${dayWords(isoDayOf(Math.min(at.t, t1 - 1)))}: none published${at.i === holds.length - 1 ? ' yet' : ''}` : daily && at?.kind === 'point' ? forDay(at.i) : when(p.t, daily)}</span>
            <b>{show(p.v)}</b>
            {at?.kind === 'held' ? <span className="tc-tip-sub">The {forDay(at.i)} holds</span>
              : change !== null && at?.kind === 'point' && at.i !== 0 ? <span className="tc-tip-sub">{change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(2)}% since the start of the line{daily && heldText(at.i) ? `; ${heldText(at.i)}` : ''}</span> : <span className="tc-tip-sub">The start of the line</span>}
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">{focused ? spoken : ''}</p>
    </div>
  )
}
