/**
 * The score (Meridian, DESIGN.md M6): one line of time for three things a person otherwise reads in three places. The
 * bank account's balance if the worst the owner allows for happens (server/liquidity.ts `path`), drawn as true steps so
 * that a bill or a salary is a jump on its day and never a slope; what falls due and what arrives, marked on its day;
 * and, under the line on the same days, what every standing authority may do and how much of its limit is left.
 *
 * A what-if (charts.tsx `whatIf`, worked out in this browser to the paisa) is drawn over the recorded line, dashed, with
 * what it takes shaded between the two and any day it would leave the bank short shaded below empty. It changes
 * nothing in the account, and the chart says so wherever it shows it.
 *
 * The figures are the server's; the day accounting is `runwayDays` (charts.tsx, tested to the paisa). This component
 * only lays them out. It is read by pointer, finger and arrow keys: a reading line and a glass label name the day, the
 * balance at worst (and the what-if's), and everything on that day; the same reading is said once in words for a screen
 * reader. The same days are a statement one press away, exact to the paisa. The line draws from today to the right when
 * the chart arrives; every value is whole from the first frame.
 */
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { fmt } from '../lib/core.ts'
import { axisTicks, compactInr, dayName, type RunwayBasis, type RunwayDay, runwayDays, runwayRows, useWidth, type WhatIfResult } from './charts.tsx'
import { Link } from './kit.tsx'

/** One standing authority as a row of the score. */
export interface Lane {
  id: string
  title: string
  to: string
  /** How it acts: on its own, after telling the owner, after asking, only to protect, enforced by a contract. */
  mode: 'auto' | 'notify' | 'approve' | 'watch' | 'chain' | 'paused'
  modeText: string
  /** Days (ISO, Indian time) on which it is due to act. */
  runs: string[]
  /** It acts continuously (every few minutes) rather than on days. */
  continuous?: boolean
  /** Things due that it will not pay or do (over its cap): they wait for the owner. */
  waiting?: { date: string; label: string }[]
  /** The day its authority lapses, if within the days drawn. */
  until?: string | null
  left?: { left: number; of: number; per: string } | null
  note?: string | null
}

/** Days shown: a month, two, and every day the server drew (it draws 120: server/liquidity.ts `path`). */
const rangesFor = (days: number): number[] => [...new Set([30, 60, days])].filter((r) => r <= days).sort((x, y) => x - y)
const LANE_H = 22
const PAD_T = 20, PAD_B = 30

/** Round, evenly spaced steps for the axis: every other one when there are too many, the last carried one step further. */
function evenTicks(raw: number[]): number[] {
  if (raw.length <= 6) return raw
  const step = raw[1]! - raw[0]!
  const out = raw.filter((_, i) => i % 2 === 0)
  if ((raw.length - 1) % 2 === 1) out.push(out[out.length - 1]! + 2 * step)
  return out
}
/** A figure as a person says it at worst: a shortfall is written as one. */
const worded = (v: number): string => (v < 0 ? `${fmt.money(-v, true)} short` : fmt.money(v, true))
/** What moved a day, apart from everyday spending, named the way a mark on the line is named. */
function markOf(d: RunwayDay): { label: string; amount: number; income: boolean; whatif: boolean } | null {
  const named = d.items.filter((i) => i.kind !== 'net')
  if (named.length === 0) return null
  const amount = named.reduce((s, i) => s + i.amount, 0)
  const one = named.length === 1 ? named[0]!.label.replace(/ instalment$/, '') : null
  const label = one === 'Salary counted on' ? 'Salary, at its latest' : one ?? (amount > 0 ? 'Money in' : named.every((i) => i.kind === 'emi') ? 'Loan instalments' : `${named.length} payments due`)
  return { label, amount, income: amount > 0, whatif: named.some((i) => i.kind === 'whatif') }
}

export function Score({ path, start, free, short, lowDate, lanes, basis, whatIf, asOf, title, sub, rail, foot }: {
  path: { date: string; low: number }[]; start: number; free: number; short: number; lowDate: string | null
  lanes: Lane[]; basis?: RunwayBasis
  /** A what-if worked out from the same path; drawn over the recorded line when it changes anything. */
  whatIf?: WhatIfResult | null
  /** When the server worked the path out (its source and freshness, said under the chart). */
  asOf?: number
  title: ReactNode; sub?: ReactNode
  /** What sits beside the chart on a wide screen and under it on a narrow one (Save's what-if). */
  rail?: ReactNode
  foot?: ReactNode
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const lowIndex = lowDate ? path.findIndex((p) => p.date === lowDate) : -1
  const ranges = rangesFor(path.length)
  const [range, setRange] = useState<number>(() => (lowIndex > 54 ? path.length : 60))
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const [at, setAt] = useState<number | null>(null)
  const [box, width] = useWidth()
  const n = Math.min(range, path.length)
  const shown = useMemo(() => path.slice(0, n), [path, n])
  const days = useMemo(() => runwayDays(shown, basis), [shown, basis])
  const lowAt = useMemo(() => { if (lowIndex >= 0 && lowIndex < n) return lowIndex; let k = 0; shown.forEach((p, i) => { if (p.low < shown[k]!.low) k = i }); return k }, [shown, lowIndex, n])
  const lowBeyond = lowIndex >= n
  const w = whatIf && whatIf.changed ? whatIf : null
  // A what-if's lowest day is its result. When one is set, or its lowest day moves, past the days shown, the days shown
  // widen once to reach it; the owner can narrow them again, and the key then says the lowest is later.
  const fitted = useRef<number | null>(null)
  const wLowK = w ? w.low.k : null
  useEffect(() => {
    if (wLowK === null) { fitted.current = null; return }
    if (fitted.current === wLowK) return
    fitted.current = wLowK
    if (wLowK >= Math.min(range, path.length)) setRange(Math.max(range, rangesFor(path.length).find((r) => r > wLowK) ?? path.length))
  }, [wLowK, range, path.length])
  const wBeyond = !!w && w.low.k >= n
  const wDays = useMemo(() => (w ? w.days.slice(0, n) : null), [w, n])
  const wRun = useMemo(() => (w ? runwayDays(w.path.slice(0, n), w.basis) : null), [w, n])
  const wLowAt = useMemo(() => { if (!wDays) return -1; let k = 0; wDays.forEach((d, i) => { if (d.low < wDays[k]!.low) k = i }); return k }, [wDays])
  const wShortAt = wDays ? wDays.findIndex((d) => d.low < 0) : -1

  // scales: the days across, rupees up; zero is drawn only when a line goes below it
  const H = width && width < 520 ? 220 : 268
  const W = Math.max(width, 200)
  const x = (k: number) => (k / Math.max(1, n)) * W
  const cx = (k: number) => x(k) + x(1) / 2
  const vals = [start, ...shown.map((p) => p.low), ...(wDays ? wDays.map((d) => d.low) : [])]
  const below = short > 0 || wShortAt >= 0
  const lo = Math.min(...vals, below ? 0 : Infinity), hi = Math.max(...vals)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.06
  const ticks = evenTicks(axisTicks(lo - pad, hi + pad, 3))
  const y0 = ticks[0]!, y1 = ticks[ticks.length - 1]!
  const y = (v: number) => PAD_T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PAD_T - PAD_B)
  const lowV = shown[lowAt]?.low ?? free
  const keptAll = start - free + short

  // true steps: the balance moves on the day, then holds until the next
  const points = (lows: number[]): [number, number][] => { const p: [number, number][] = [[0, y(start)]]; lows.forEach((v, k) => { p.push([x(k), y(v)], [x(k + 1), y(v)]) }); return p }
  const d = (p: [number, number][]) => `M${p.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join('L')}`
  const rec = points(shown.map((p) => p.low))
  const line = d(rec)
  const area = `${line}V${H - PAD_B}H0Z`
  let kept = `M0 ${y(lowV)}V${y(start)}`
  shown.slice(0, lowAt + 1).forEach((p, k) => { kept += `V${y(p.low)}H${x(k + 1)}` })
  kept += `V${y(lowV)}Z`
  const wif = wDays ? points(wDays.map((v) => v.low)) : null
  const wLine = wif ? d(wif) : null
  const gap = wif ? `${d(wif)}L${[...rec].reverse().map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join('L')}Z` : null
  // what lies below empty: the part of the plot under zero and over the line, wherever the line has gone below it
  const under = (l: string) => `${l}V${PAD_T - 12}H0Z`
  const zeroY = below ? y(0) : null

  // marks on the line: what moved a day besides everyday spending (on the what-if's line when one is drawn)
  const markDays = wRun ?? days
  const markLow = (k: number) => (wDays ? wDays[k]!.low : shown[k]!.low)
  const marks = markDays.flatMap((day) => { const m = markOf(day); return m ? [{ k: day.k, ...m }] : [] })
  const placed: { k: number; x: number; y: number; text: string; income: boolean; whatif: boolean }[] = []
  if (W >= 440) {
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = []
    const clear = (b: { x0: number; x1: number; y0: number; y1: number }) => b.y0 > 2 && b.y1 < H - PAD_B && boxes.every((o) => b.x1 + 8 < o.x0 || b.x0 > o.x1 + 8 || b.y1 < o.y0 || b.y0 > o.y1)
    for (const m of [...marks].filter((mm) => mm.whatif || Math.abs(mm.amount) >= (y1 - y0) * 0.02).sort((a, b) => Number(b.whatif) - Number(a.whatif) || Math.abs(b.amount) - Math.abs(a.amount))) {
      const text = `${m.label} ${m.income ? '+' : '−'}${fmt.money(Math.abs(m.amount), true)}`
      const tw = text.length * 6.6 + 10
      const x0 = cx(m.k) + 6 + tw <= W ? cx(m.k) + 6 : Math.max(2, cx(m.k) - 6 - tw)
      for (const tier of [0, 1]) {
        const ty = y(markLow(m.k)) + (m.income ? 24 + tier * 15 : -14 - tier * 15)
        const b = { x0, x1: x0 + tw, y0: ty - 11, y1: ty + 4 }
        if (clear(b)) { boxes.push(b); placed.push({ k: m.k, x: x0, y: ty, text, income: m.income, whatif: m.whatif }); break }
      }
    }
  }
  const months: { k: number; text: string }[] = []
  shown.forEach((p, k) => { if (k > 0 && p.date.endsWith('-01') && x(k) > 56 && x(k) < W - 36) months.push({ k, text: dayName(p.date).replace(/^\w+ /, '') }) })

  // the reading: one day, by pointer, finger or arrow keys
  const reading = at === null ? null : days[at] ?? null
  const wAt = at === null || !wDays ? null : wDays[at] ?? null
  const wAtItems = at === null || !wRun ? null : wRun[at] ?? null
  const runsOn = (date: string) => lanes.filter((l) => l.runs.includes(date) || l.waiting?.some((v) => v.date === date))
  const laneWords = (date: string) => runsOn(date).map((l) => ` ${l.waiting?.some((v) => v.date === date) ? `Waits for you under “${l.title}”.` : `${l.title}: due to run.`}`).join('')
  const itemWords = (dd: RunwayDay) => dd.items.filter((i) => i.kind !== 'net').map((i) => ` ${i.label} ${fmt.signed(i.amount, true)}.`).join('')
  const wLowV = wDays && wLowAt >= 0 ? wDays[wLowAt]!.low : null
  const takes = (v: { spend: number; bill: number; salary: number; monthly: number }): string => [v.spend ? `spent today ${fmt.money(-v.spend, true)}` : '', v.bill ? `a bill larger by ${fmt.money(-v.bill, true)}` : '', v.salary ? `a salary of ${fmt.money(-v.salary, true)} ${w?.salary?.now === null ? 'never counted on' : 'not counted on yet'}` : '', v.monthly ? `new monthly costs so far ${fmt.money(-v.monthly, true)}` : ''].filter(Boolean).join(', ')
  const readText = reading && wAt && wAtItems
    ? `${dayName(reading.date)}: ${worded(wAt.low)} at worst if this happens, ${worded(wAt.recorded)} as recorded${wAt.low !== wAt.recorded ? `, ${fmt.money(wAt.recorded - wAt.low, true)} less (${takes(wAt)})` : ', the same'}.${itemWords(wAtItems)}${laneWords(reading.date)}`
    : reading
      ? `${dayName(reading.date)}: at worst ${fmt.money(reading.low, true)}${reading.k === lowAt ? ', the lowest point' : ''}.${itemWords(reading)}${laneWords(reading.date)}`
      : wDays && wLowV !== null
        ? `If this happens, lowest ${worded(wLowV)} on ${dayName(wDays[wLowAt]!.date)}${wBeyond && w ? ` in the days drawn, and lower later: ${worded(w.low.low)} on ${dayName(w.low.date)}` : ''}; as recorded, lowest ${worded(lowV)} on ${dayName(shown[lowAt]?.date ?? path[0]!.date)}.`
        : `Lowest ${fmt.money(lowV, true)} on ${dayName(shown[lowAt]?.date ?? path[0]!.date)}${lowBeyond ? ' (later than the days drawn)' : ''}.`
  const pick = (e: PointerEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); setAt(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)))) }
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const cur = at ?? (wDays ? wLowAt : lowAt)
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 7, PageUp: -7 }
    if (e.key in step) { e.preventDefault(); setAt(Math.max(0, Math.min(n - 1, cur + step[e.key]!))) }
    else if (e.key === 'Home') { e.preventDefault(); setAt(0) } else if (e.key === 'End') { e.preventDefault(); setAt(n - 1) } else if (e.key === 'Escape') setAt(null)
  }
  const tipValue = wAt ? wAt.low : reading?.low ?? 0
  const tipLeft = reading ? Math.min(Math.max(cx(reading.k), 104), W - 104) : 0
  // the label sits above the point, or under it when the point is too near the top for the label to fit above
  const tipBelow = y(tipValue) < 132
  const tipItems = (wAtItems ?? reading)?.items.filter((i) => i.kind !== 'net') ?? []
  const summary = `Bank balance at worst, day by day for ${n} days, from ${fmt.money(start, true)} today to ${worded(shown[n - 1]?.low ?? start)} on ${dayName(shown[n - 1]?.date ?? path[0]!.date)}, lowest ${worded(lowV)} on ${dayName(shown[lowAt]?.date ?? path[0]!.date)}${w && wLowV !== null ? `; with the what-if drawn over it, lowest ${worded(wLowV)} on ${dayName(wDays![wLowAt]!.date)}` : ''}. Focus here and use the arrow keys to read each day.`

  return (
    <div className={`sc ${rail ? 'with-rail' : ''} ${w ? 'is-whatif' : ''}`}>
      <div className="sc-head">
        <div className="sc-title">{title}{sub ? <p>{sub}</p> : null}</div>
        <div className="sc-tools">
          <div className="seg" role="group" aria-label="Days shown">{ranges.map((r) => <button key={r} type="button" aria-pressed={n === r} onClick={() => { setRange(r); setAt(null) }}>{r} days</button>)}</div>
          <div className="seg" role="group" aria-label="Show as">{(['chart', 'list'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'chart' ? 'Chart' : 'Statement'}</button>)}</div>
        </div>
      </div>

      <div className="sc-chart" id={`${id}-chart`}>
        {w ? <p className="sc-flag"><i aria-hidden="true" />A what-if is drawn over the recorded line. Nothing in your account changes.</p> : null}
        {view === 'list' ? (w ? <WhatIfList w={w} n={n} start={start} lowAt={wLowAt} /> : <ScoreList days={days} start={start} lowAt={lowAt} lowBeyond={lowBeyond} />) : (
          <>
            <p className="sr" aria-live="polite">{readText}</p>
            <div className="sc-frame">
              <div className="sc-axis" aria-hidden="true">{ticks.map((t) => <span key={t} style={{ top: y(t) }}>{compactInr(t)}</span>)}</div>
              <div className="sc-plot" ref={box} tabIndex={0} role="img" aria-label={summary}
                onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setAt(null)} onKeyDown={key} onBlur={() => setAt(null)} style={{ height: H }}>
                {width > 0 ? (
                  <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="sc-svg">
                    <defs>
                      <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="sc-fill-top" /><stop offset="1" className="sc-fill-bottom" /></linearGradient>
                      <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="sc-hatch" /></pattern>
                      <pattern id={`${id}-wif`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="7" className="sc-wif-hatch" /></pattern>
                      <filter id={`${id}-glow`} x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation="5" /></filter>
                      {zeroY !== null ? <clipPath id={`${id}-under`}><rect x={0} y={zeroY} width={W} height={Math.max(0, H - PAD_B - zeroY)} /></clipPath> : null}
                    </defs>
                    {ticks.map((t) => <line key={t} className="sc-grid" x1={0} x2={W} y1={y(t)} y2={y(t)} />)}
                    {months.map((m) => <line key={m.k} className="sc-month" x1={x(m.k)} x2={x(m.k)} y1={PAD_T - 6} y2={H - PAD_B} />)}
                    <g className="sc-reveal">
                      <path d={area} fill={`url(#${id}-fill)`} className="sc-area" />
                      {w ? null : <path d={kept} fill={`url(#${id}-hatch)`} className="sc-kept" />}
                      {gap ? <><path d={gap} className="sc-gap-tint" /><path d={gap} fill={`url(#${id}-wif)`} className="sc-gap" /></> : null}
                      {zeroY !== null && short > 0 ? <path d={under(line)} clipPath={`url(#${id}-under)`} className="sc-short" /> : null}
                      {zeroY !== null && wLine && wShortAt >= 0 ? <path d={under(wLine)} clipPath={`url(#${id}-under)`} className="sc-short" /> : null}
                      <path d={line} className="sc-glow" filter={`url(#${id}-glow)`} />
                      <path d={line} className="sc-line" />
                      {wLine ? <path d={wLine} className="sc-wline" /> : null}
                      {marks.map((m) => <line key={m.k} className={`sc-mark ${m.whatif ? 'wif' : m.income ? 'in' : ''}`} x1={cx(m.k)} x2={cx(m.k)} y1={y(markLow(m.k)) + (m.income ? 5 : -5)} y2={y(markLow(m.k)) + (m.income ? 14 : -14)} />)}
                      {placed.map((p) => <text key={p.k} className={`sc-mark-text ${p.whatif ? 'wif' : p.income ? 'in' : ''}`} x={p.x} y={p.y}>{p.text}</text>)}
                    </g>
                    {zeroY !== null ? <><line className="sc-zero" x1={0} x2={W} y1={zeroY} y2={zeroY} /><text className="sc-zero-text" x={W - 4} y={zeroY - 6} textAnchor="end">Empty: ₹0</text></> : null}
                    {lowBeyond ? null : <g className={`sc-low ${w ? 'was' : ''}`}>
                      {w ? null : <line className="sc-low-line" x1={0} x2={W} y1={y(lowV)} y2={y(lowV)} />}
                      {w ? null : <circle className="sc-low-halo" cx={cx(lowAt)} cy={y(lowV)} r={11} />}
                      <circle className="sc-low-dot" cx={cx(lowAt)} cy={y(lowV)} r={5} />
                    </g>}
                    {wDays && wLowV !== null ? <g className="sc-wlow"><circle className="sc-wlow-halo" cx={cx(wLowAt)} cy={y(wLowV)} r={11} /><circle className="sc-wlow-dot" cx={cx(wLowAt)} cy={y(wLowV)} r={5} /></g> : null}
                    {!w && !lowBeyond && W >= 440 && keptAll > 0 ? <text className="sc-kept-text" x={10} y={Math.min(y(lowV) - 10, (y(start) + y(lowV)) / 2 + 4)}>Kept {fmt.money(keptAll, true)}</text> : null}
                    <text className="sc-today" x={2} y={H - 8}>Today</text>
                    {months.map((m) => <text key={m.k} className="sc-month-text" x={x(m.k) + 4} y={H - 8}>{m.text}</text>)}
                    {reading ? <g className="sc-reading">
                      <line className="sc-cursor" x1={cx(reading.k)} x2={cx(reading.k)} y1={PAD_T - 6} y2={H - PAD_B} />
                      {wAt ? <circle className="sc-dot was" cx={cx(reading.k)} cy={y(wAt.recorded)} r={4} /> : null}
                      <circle className={`sc-dot ${wAt ? 'wif' : ''}`} cx={cx(reading.k)} cy={y(tipValue)} r={5} />
                    </g> : null}
                  </svg>
                ) : null}
                {reading ? (
                  <div className={`sc-tip ${tipBelow ? 'below' : ''}`} style={{ left: tipLeft, top: tipBelow ? y(tipValue) + 14 : y(tipValue) - 14 }} aria-hidden="true">
                    <span className="sc-tip-day">{dayName(reading.date)}</span>
                    <b className={tipValue < 0 ? 'short' : ''}>{worded(tipValue)}</b>
                    <span className="sc-tip-sub">{wAt ? `at worst if this happens; ${worded(wAt.recorded)} as recorded` : reading.k === lowAt ? 'the lowest point, at worst' : 'at worst'}</span>
                    {tipItems.length ? <ul>{tipItems.map((i, j) => <li key={j} className={i.kind === 'whatif' ? 'wif' : ''}><span>{i.label}</span><span className={i.amount > 0 ? 'in' : ''}>{fmt.signed(i.amount, true)}</span></li>)}</ul> : null}
                    {runsOn(reading.date).length ? <ul className="sc-tip-runs">{runsOn(reading.date).map((l) => <li key={l.id}><span>{l.title}</span><span>{l.waiting?.some((v) => v.date === reading.date) ? 'waits for you' : 'due to run'}</span></li>)}</ul> : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="sc-key" aria-hidden="true">
              {w ? <>
                <span><i className="k-line" />As recorded, at worst</span>
                <span><i className="k-wif" />If this happens</span>
                <span><i className="k-gap" />What it takes</span>
                {lowBeyond ? null : <span><i className="k-was" /><span>Lowest as recorded</span></span>}
                {wLowV !== null ? <span><i className="k-wlow" /><span>{wBeyond ? 'Lowest drawn if this happens' : 'Lowest if this happens'}: <b>{worded(wLowV)}</b>, {dayName(wDays![wLowAt]!.date)}{wBeyond && w ? <>; lower later, <b>{worded(w.low.low)}</b> on {dayName(w.low.date)}</> : null}</span></span> : null}
              </> : <>
                <span><i className="k-line" />Balance at worst</span>
                <span><i className="k-kept" />Kept for what is due</span>
                <span><i className="k-low" /><span>Lowest point: <b>{fmt.money(lowV, true)}</b>, {dayName(shown[lowAt]?.date ?? path[0]!.date)}{lowBeyond ? ' (the hardest day is later)' : ''}</span></span>
              </>}
            </div>
          </>
        )}
        <p className="sc-source">From your records{asOf ? `, as of ${fmt.time(asOf)} today` : ''}: what is in your bank now, each bill and instalment QED knows of, your salary and your everyday spending figure. Today is recorded; every later day is worked out at worst, not forecast.{w ? ' The dashed line is a what-if worked out in this browser.' : ''}</p>
      </div>

      {rail ? <div className="sc-rail">{rail}</div> : null}

      {view === 'chart' ? (
        <div className="sc-lanes">
          <div className="sc-lanes-head">
            <h3>What each instruction may do on these days</h3>
            <p className="sc-lanes-key" aria-hidden="true"><span><i className="k-acts" />acts</span><span><i className="k-asks" />asks you first</span><span><i className="k-waits" />waits for you</span><span><i className="k-ends" />its authority ends</span></p>
          </div>
          {lanes.length === 0 ? <p className="sc-none">No standing instruction may act on these days. QED does nothing on its own until you sign one.</p> : (
            <ul className="sc-lane-list">{lanes.map((l) => <Row key={l.id} lane={l} n={n} W={W} dates={shown.map((p) => p.date)} cursor={reading ? cx(reading.k) : null} onPick={pick} onLeave={() => setAt(null)} />)}</ul>
          )}
        </div>
      ) : null}
      {foot ? <div className="sc-foot">{foot}</div> : null}
    </div>
  )
}

/** One standing authority: its name and how it acts, what is left of its limit, and its days under the line's. */
function Row({ lane: l, n, W, dates, cursor, onPick, onLeave }: { lane: Lane; n: number; W: number; dates: string[]; cursor: number | null; onPick: (e: PointerEvent<HTMLElement>) => void; onLeave: () => void }) {
  const x = (k: number) => (k / Math.max(1, n)) * W + (W / Math.max(1, n)) / 2
  const idx = (d: string) => dates.indexOf(d)
  const runs = l.runs.map(idx).filter((k) => k >= 0)
  const waits = (l.waiting ?? []).map((v) => idx(v.date)).filter((k) => k >= 0)
  const end = l.until ? idx(l.until) : -1
  const mid = LANE_H / 2
  const kind = l.mode === 'paused' ? 'paused' : l.mode === 'approve' ? 'asks' : 'acts'
  const stop = end >= 0 ? x(end) : W
  // a run's mark is as large as the day it stands on allows, so that daily runs stay apart on a narrow screen
  const r = Math.max(1.4, Math.min(3.6, W / Math.max(1, n) / 2 - 0.6))
  return (
    <li className="sc-lane">
      <div className="sc-lane-top">
        <Link to={l.to} className="sc-lane-t">{l.title}</Link>
        <span className={`sc-mode m-${l.mode}`}>{l.modeText}</span>
        <span className="sc-left">{l.left ? <><b>{fmt.money(l.left.left, true)}</b> left of {fmt.money(l.left.of, true)} {l.left.per}</> : l.note ?? null}</span>
      </div>
      <div className="sc-lane-row">
        <div className="sc-track" aria-hidden="true" onPointerMove={onPick} onPointerDown={onPick} onPointerLeave={onLeave}>
          <svg width={W} height={LANE_H} viewBox={`0 0 ${W} ${LANE_H}`}>
            <line className="sc-rail-line" x1={0} x2={stop} y1={mid} y2={mid} />
            {l.mode === 'watch' || l.continuous ? <line className={`sc-watch ${l.continuous ? 'dense' : ''}`} x1={4} x2={stop - 4} y1={mid} y2={mid} /> : null}
            {l.mode === 'chain' ? <line className="sc-chain" x1={0} x2={stop} y1={mid} y2={mid} /> : null}
            {runs.map((k) => <circle key={k} className={`sc-run ${kind}`} cx={x(k)} cy={mid} r={r} />)}
            {waits.map((k) => <rect key={k} className="sc-wait" x={x(k) - 4.5} y={mid - 4.5} width={9} height={9} rx={2} />)}
            {end >= 0 ? <line className="sc-end" x1={x(end)} x2={x(end)} y1={mid - 8} y2={mid + 8} /> : null}
            {cursor === null ? null : <line className="sc-cursor" x1={cursor} x2={cursor} y1={0} y2={LANE_H} />}
          </svg>
        </div>
        <span className="sc-lane-pad" />
      </div>
    </li>
  )
}

/** The same days as a statement: the balance at worst after each day money moves, adding up to the paisa. */
function ScoreList({ days, start, lowAt, lowBeyond }: { days: RunwayDay[]; start: number; lowAt: number; lowBeyond: boolean }) {
  const rows = runwayRows(days, start, lowAt)
  return (
    <div className="sc-table" tabIndex={0} role="region" aria-label="The bank balance at worst as a statement; scroll for more">
      <table className="ledger">
        <caption className="sr">The bank balance at worst, day by day, as a statement</caption>
        <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Balance at worst</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className={r.kind === 'lowest' ? 'lowest' : r.kind === 'start' ? 'start' : ''}>
            <td className="date">{r.when}</td>
            <td>{r.kind === 'lowest' && lowBeyond ? 'The lowest in the days drawn; the hardest day is later' : r.what}{r.due ? <small> (due {dayName(r.due)})</small> : null}</td>
            <td className={`num amount ${r.amount !== null && r.amount > 0 ? 'in' : ''}`}>{r.amount === null ? '' : fmt.signed(r.amount, true)}</td>
            <td className="num bal">{r.balance === null ? '' : fmt.money(r.balance, true)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

/** The what-if's days as a statement, the recorded balance beside each: it adds up to the paisa, read down. */
function WhatIfList({ w, n, start, lowAt }: { w: WhatIfResult; n: number; start: number; lowAt: number }) {
  const rows = runwayRows(runwayDays(w.path.slice(0, n), w.basis), start, lowAt)
  return (
    <div className="sc-table" tabIndex={0} role="region" aria-label="The what-if as a statement; scroll for more">
      <table className="ledger sc-wtable">
        <caption className="sr">The bank balance at worst if this happens, day by day, with the recorded balance beside it</caption>
        <thead><tr><th scope="col" className="sc-when">When</th><th scope="col">What</th><th scope="col" className="num sc-amt">Amount</th><th scope="col" className="num">If this happens</th><th scope="col" className="num sc-was">As recorded</th></tr></thead>
        <tbody>{rows.map((row, i) => {
          const was = row.balance === null ? null : row.kind === 'start' ? start : w.days[row.k]!.recorded
          return (
            <tr key={i} className={`${row.kind === 'lowest' ? 'lowest' : ''} ${row.kind === 'whatif' ? 'whatif' : ''}`}>
              <td className="date sc-when">{row.when}</td>
              <td><span className="sc-when-in">{row.when}</span>{row.kind === 'lowest' ? (row.what.startsWith('The lowest point,') ? 'The lowest point if this happens, on the last day drawn' : 'The lowest point if this happens') : row.what}{row.due ? <span className="sub">Due {fmt.isoDay(row.due)}; counted on once it can no longer be late</span> : null}</td>
              <td className={`num sc-amt ${row.amount !== null && row.amount > 0 ? 'in' : ''}`}>{row.amount === null ? '' : fmt.signed(row.amount, true)}</td>
              <td className={`num bal ${row.balance !== null && row.balance < 0 ? 'short' : ''}`}>
                {row.amount === null ? null : <span className={`sc-amt-in ${row.amount > 0 ? 'in' : ''}`}>{fmt.signed(row.amount, true)}</span>}
                {row.balance === null ? null : <span className="sc-bal">{worded(row.balance)}</span>}
                {was === null ? null : <span className="sc-was-in">{worded(was)} as recorded</span>}
              </td>
              <td className="num sc-was">{was === null ? '' : worded(was)}</td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}
