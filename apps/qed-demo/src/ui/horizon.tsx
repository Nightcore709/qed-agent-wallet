/**
 * Horizon: the bank account's balance if the worst the owner allows for happens, day by day (server/liquidity.ts
 * `path`), drawn as true steps so that a bill or a salary is a jump on its day and never a slope (cash flow is
 * discontinuous). Under the line, hatched, what is kept for what falls due up to the hardest day; the hardest day is
 * marked and named. Design system "Meridian" (DESIGN.md M6).
 *
 * The figures are the server's; the day accounting is `runwayDays` (charts.tsx, tested to the paisa). It is read by
 * pointer, finger and keyboard: a reading line and a glass label name the day, the balance at worst and what moved
 * that day. The same days are one press away as a statement (the accessible equivalent, and the exact one).
 * Each day money moves besides everyday spending is a numbered mark beside its step, and the same number names it in
 * the list under the chart (chart-marks.tsx, R14 L5): nothing is written across the line, and nothing is dropped on a
 * narrow screen.
 * The line draws from today to the right when the chart arrives; the values are drawn whole from the first frame.
 */
import { type KeyboardEvent, type ReactNode, useId, useMemo, useState } from 'react'
import { fmt } from '../lib/core.ts'
import { axisTicks, compactInr, dayName, runwayDays, runwayRows, type RunwayBasis, useWidth } from './charts.tsx'
import { ChartEvents, chartEvents, Mark, placeMarks, tipPlace, useTipSize } from './chart-marks.tsx'

// the server draws 120 days (server/liquidity.ts), so no button may ask for more
const RANGES = [30, 60, 120] as const

export function Horizon({ path, start, free, short, lowDate, basis, title, sub, foot, height = 232 }: {
  path: { date: string; low: number }[]; start: number; free: number; short: number; lowDate: string | null
  basis?: RunwayBasis; title?: ReactNode; sub?: ReactNode; foot?: ReactNode; height?: number
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const lowIndex = lowDate ? path.findIndex((p) => p.date === lowDate) : -1
  const [range, setRange] = useState<number>(() => (lowIndex > 54 ? 120 : 60))
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const [at, setAt] = useState<number | null>(null)
  const [box, width] = useWidth()
  const n = Math.min(range, path.length)
  const shown = path.slice(0, n)
  const days = useMemo(() => runwayDays(shown, basis), [shown, basis])
  const lowAt = useMemo(() => { let k = 0; shown.forEach((p, i) => { if (p.low < shown[k]!.low) k = i }); return lowIndex >= 0 && lowIndex < n ? lowIndex : k }, [shown, lowIndex, n])
  const lowBeyond = lowIndex >= n
  const H = width && width < 520 ? Math.round(height * 0.82) : height
  const PAD_T = 18, PAD_B = 30

  const W = Math.max(width, 200)
  const x = (k: number) => (k / Math.max(1, n)) * W
  const lows = shown.map((p) => p.low)
  const lo = Math.min(...lows, short > 0 ? 0 : Infinity), hi = Math.max(start, ...lows)
  const raw = axisTicks(lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06, 3)
  const ticks = raw.length > 5 ? raw.filter((_, i) => i % 2 === 0 || i === raw.length - 1) : raw
  const y0 = ticks[0]!, y1 = ticks[ticks.length - 1]!
  const y = (v: number) => PAD_T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - PAD_T - PAD_B)
  const lowV = shown[lowAt]?.low ?? free
  const keptAll = start - free + short

  let line = `M0 ${y(start)}`
  shown.forEach((p, k) => { line += ` V${y(p.low)} H${x(k + 1)}` })
  const area = `${line} V${H - PAD_B} H0 Z`
  let kept = `M0 ${y(lowV)} V${y(start)}`
  shown.slice(0, lowAt + 1).forEach((p, k) => { kept += ` V${y(p.low)} H${x(k + 1)}` })
  kept += ` V${y(lowV)} Z`

  // what moved a day besides everyday spending: a numbered mark beside its step, named in the list under the chart
  const cx = (k: number) => x(k) + x(1) / 2
  const events = useMemo(() => chartEvents(days), [days])
  const placed = placeMarks(events, { x, dayW: x(1), n, lineY: (k) => y(days[k]!.low), startY: y(start), W, top: 2, bottom: H - PAD_B - 2, ...(lowBeyond ? {} : { avoid: [{ x: cx(lowAt), y: y(lowV), r: 12 }] }) })
  const months: { k: number; text: string }[] = []
  shown.forEach((p, k) => { if (k > 0 && p.date.endsWith('-01') && x(k) > 56) months.push({ k, text: dayName(p.date).replace(/^\w+ /, '') }) })

  const reading = at === null ? null : days[at] ?? null
  const readText = reading
    ? `${dayName(reading.date)}: at worst ${fmt.money(reading.low, true)}${reading.k === lowAt ? ', the lowest point' : ''}.${reading.items.filter((i) => i.kind !== 'net').map((i) => ` ${i.label} ${fmt.signed(i.amount, true)}.`).join('')}`
    : `Lowest ${fmt.money(lowV, true)} on ${dayName(shown[lowAt]?.date ?? path[0]!.date)}${lowBeyond ? ' (later than the days drawn)' : ''}.`
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setAt(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))))
  }
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const cur = at ?? lowAt
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: 7, PageUp: -7 }
    if (e.key in step) { e.preventDefault(); setAt(Math.max(0, Math.min(n - 1, cur + step[e.key]!))) }
    else if (e.key === 'Home') { e.preventDefault(); setAt(0) } else if (e.key === 'End') { e.preventDefault(); setAt(n - 1) } else if (e.key === 'Escape') setAt(null)
  }
  // the label stands beside the reading line, inside the plot (chart-marks.tsx tipPlace)
  const [tipRef, tipSize] = useTipSize(reading?.k ?? null)
  const tip = reading ? tipPlace({ cx: cx(reading.k), cy: y(reading.low), W, bottom: H - PAD_B, w: Math.min(tipSize.w, W), h: tipSize.h }) : null

  return (
    <div className="horizon">
      <div className="hz-head">
        <div className="hz-title">{title}{sub ? <p>{sub}</p> : null}</div>
        <div className="hz-tools">
          <div className="seg" role="group" aria-label="Days shown">{RANGES.filter((r) => r <= path.length || r === RANGES[0]).map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => { setRange(r); setAt(null) }}>{r} days</button>)}</div>
          <div className="seg" role="group" aria-label="Show as">{(['chart', 'list'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'chart' ? 'Chart' : 'Statement'}</button>)}</div>
        </div>
      </div>
      {view === 'list' ? <HorizonList days={days} start={start} lowAt={lowAt} /> : (
        <>
          <p className="sr" aria-live="polite">{readText}</p>
          <div className="hz-frame">
            <div className="hz-axis" aria-hidden="true">{ticks.map((t) => <span key={t} style={{ top: y(t) }}>{compactInr(t)}</span>)}</div>
            <div className="hz-plot" ref={box} tabIndex={0} role="img"
              aria-label={`Bank balance at worst, day by day, from ${fmt.money(start, true)} today to ${fmt.money(shown[n - 1]?.low ?? start, true)} on ${dayName(shown[n - 1]?.date ?? path[0]!.date)}. ${readText} Focus here and use the arrow keys to read each day.`}
              onPointerMove={move} onPointerDown={move} onPointerLeave={() => setAt(null)} onKeyDown={key} onBlur={() => setAt(null)} style={{ height: H }}>
              {width > 0 ? (
                <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="hz-svg">
                  <defs>
                    <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="hz-fill-top" /><stop offset="1" className="hz-fill-bottom" /></linearGradient>
                    <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="hz-hatch" /></pattern>
                    <filter id={`${id}-glow`} x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation="5" /></filter>
                  </defs>
                  {ticks.map((t) => <line key={t} className="hz-grid" x1={0} x2={W} y1={y(t)} y2={y(t)} />)}
                  {months.map((m) => <line key={m.k} className="hz-month" x1={x(m.k)} x2={x(m.k)} y1={PAD_T - 6} y2={H - PAD_B} />)}
                  {short > 0 ? <line className="hz-zero" x1={0} x2={W} y1={y(0)} y2={y(0)} /> : null}
                  <g className="hz-reveal">
                    <path d={area} fill={`url(#${id}-fill)`} />
                    <path d={kept} fill={`url(#${id}-hatch)`} className="hz-kept" />
                    <path d={line} className="hz-glow" filter={`url(#${id}-glow)`} />
                    <path d={line} className="hz-line" />
                  </g>
                  {lowBeyond ? null : <g className="hz-low">
                    <line className="hz-low-line" x1={0} x2={W} y1={y(lowV)} y2={y(lowV)} />
                    <circle className="hz-low-halo" cx={cx(lowAt)} cy={y(lowV)} r={11} />
                    <circle className="hz-low-dot" cx={cx(lowAt)} cy={y(lowV)} r={5} />
                  </g>}
                  <g className="hz-reveal">{placed.map((m, i) => <Mark key={m.k} m={m} e={events[i]!} on={at === m.k} tickX={cx(m.k)} lineY={y(days[m.k]!.low)} />)}</g>
                  <text className="hz-today" x={2} y={H - 8}>Today</text>
                  {months.map((m) => <text key={m.k} className="hz-month-text" x={x(m.k) + 4} y={H - 8}>{m.text}</text>)}
                  {reading ? <g className="hz-reading">
                    <line className="hz-cursor" x1={cx(reading.k)} x2={cx(reading.k)} y1={PAD_T - 6} y2={H - PAD_B} />
                    <circle className="hz-dot" cx={cx(reading.k)} cy={y(reading.low)} r={5} />
                  </g> : null}
                </svg>
              ) : null}
              {reading && tip ? (
                <div className="hz-tip cv-tip" ref={tipRef} style={{ left: tip!.left, top: tip!.top }} aria-hidden="true">
                  <span className="hz-tip-day">{dayName(reading.date)}</span>
                  <b>{fmt.money(reading.low, true)}</b>
                  <span className="hz-tip-sub">{reading.k === lowAt ? 'the lowest point, at worst' : 'at worst'}</span>
                  {reading.items.filter((i) => i.kind !== 'net').length ? <ul>{reading.items.filter((i) => i.kind !== 'net').map((i, j) => <li key={j}><span>{i.label}</span><span className={i.amount > 0 ? 'in' : ''}>{fmt.signed(i.amount, true)}</span></li>)}</ul> : null}
                </div>
              ) : null}
            </div>
          </div>
          <div className="hz-key" aria-hidden="true"><span><i className="k-line" />Balance at worst</span><span><i className="k-kept" /><span>Kept for what is due{!lowBeyond && keptAll > 0 ? <>: <b>{fmt.money(keptAll, true)}</b></> : null}</span></span><span><i className="k-low" /><span>Lowest point: <b>{fmt.money(lowV, true)}</b>, {dayName(shown[lowAt]?.date ?? path[0]!.date)}</span></span></div>
          <ChartEvents events={events} at={at} onPick={setAt} id={id} />
        </>
      )}
      {foot ? <div className="hz-foot">{foot}</div> : null}
    </div>
  )
}

/** The same days as a statement: the balance at worst after each day money moves, adding up to the paisa. */
function HorizonList({ days, start, lowAt }: { days: ReturnType<typeof runwayDays>; start: number; lowAt: number }) {
  const rows = runwayRows(days, start, lowAt)
  return (
    <div className="hz-table">
      <table className="ledger">
        <caption className="sr">The bank balance at worst, day by day, as a statement</caption>
        <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Balance at worst</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className={r.kind === 'lowest' ? 'lowest' : r.kind === 'start' ? 'start' : ''}>
            <td className="date">{r.when}</td>
            <td>{r.what}{r.due ? <small> (due {dayName(r.due)})</small> : null}</td>
            <td className="num amount">{r.amount === null ? '' : fmt.signed(r.amount, true)}</td>
            <td className="num">{r.balance === null ? '' : fmt.money(r.balance, true)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}
