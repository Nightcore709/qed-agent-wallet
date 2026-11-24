/**
 * Grow's price record: one instrument's recorded or published prices over time, what it answers in words with exact
 * values, the same values as a table, and what explains the price (what a purchase pays, what was paid, what the worst
 * case allows). Design system "Meridian" (DESIGN.md M6). It is fetched as its own chunk with the chart
 * (src/ui/timechart.tsx) once Grow has drawn its figures and controls (R12 perf: on the phone profile the figure waited
 * for this code); Holdings.tsx draws its head while it arrives.
 *
 * A fund's NAV is published once a business day and holds until the next: the chart draws it as steps, the figure says
 * which day the NAV is for and whether it is still current (by the server's own staleness rule), and the table lists
 * every NAV of the period with the days it held. Nothing here is a forecast.
 */
import { useState } from 'react'
import { calibrated } from '../lib/limits.ts'
import { fmt, sourceName, useData, useQuote } from '../lib/core.ts'
import type { Home, Market, MarketInstrument } from '../lib/types.ts'
import { compactInr } from '../ui/charts.tsx'
import { Problem } from '../ui/kit.tsx'
import { Skel } from '../ui/page.tsx'
import { DAY, dailyWord, dayStart, dayWords, isoDayOf, isUnits, moved, pctText, pointTime, priceText, show, unitOf } from '../ui/prices.ts'

/** A published value's day as every other day on Grow is written (R13): "Mon 23 Nov", the year only when it is not `ref`'s. */
const dayIn = (day: string, ref: string): string => dayWords(day, day.slice(0, 4) !== ref.slice(0, 4))
import { dailyAge, dailyRows, duration, gapsOf, holdsOf, type Level, stretch, TimeChart } from '../ui/timechart.tsx'

interface History { kind: string; priceType: string; points: { t: string | number; v: number }[]; observations: number; step?: number; from: string | number | null; to: string | number | null; note: string }
const RANGES: Record<'live' | 'daily', [string, string][]> = { live: [['hours=6', '6 hours'], ['hours=24', '24 hours'], ['hours=168', '7 days']], daily: [['days=90', '3 months'], ['days=365', '1 year'], ['days=1095', '3 years']] }
const UNIT_MS: Record<string, number> = { hour: 3_600_000, day: 86_400_000, month: 30.44 * 86_400_000, year: 365.25 * 86_400_000 }
const askedMs = (range: string): number => ((m) => (m ? Number(m[1]) * (UNIT_MS[m[2]!] ?? 0) : 0))(/(\d+)\s*(hour|day|month|year)s?/.exec(range))
/** "the last 24 hours", "the last year": a period as a person says it. */
const lastOf = (range: string): string => `the last ${range === '1 year' ? 'year' : range}`
/** How much of the period asked for the record covers, when it covers less than half of it (a fresh install). */
function shortOf(range: string, spanMs: number): string | null {
  const asked = askedMs(range)
  if (!(asked && spanMs > 0 && spanMs < asked * 0.5)) return null
  const n = (ms: number, unit: string) => { const k = Math.max(1, Math.round(spanMs / ms)); return `${k} ${unit}${k === 1 ? '' : 's'}` }
  return spanMs < 3_600_000 ? n(60_000, 'minute') : spanMs < 2 * 86_400_000 ? n(3_600_000, 'hour') : n(86_400_000, 'day')
}
/** A point's time in words: a published value by the day it is for, a recorded one by its day and minute. */
const edgeOf = (t: string | number | null): string => (t === null ? '' : typeof t === 'number' ? fmt.dayTime(t) : fmt.isoDay(t))

/** What a purchase pays beside what the line shows: sellers ask above what buyers offer, live. */
function Spread({ inst }: { inst: MarketInstrument }) {
  const bid = useQuote(inst.id, 'bid')?.price ?? inst.quotes.bid?.price
  const ask = useQuote(inst.id, 'ask')?.price ?? inst.quotes.ask?.price
  const b = Number(bid), a = Number(ask)
  if (!(b > 0) || !(a >= b)) return <>What sellers ask, which is more than buyers offer.</>
  return <>What sellers ask: <b className="gr-n">{show(inst, a)}</b>, <b className="gr-n">{fmt.pct((a - b) / b, 2)}</b> above what buyers offer.</>
}

/**
 * One instrument's recorded or published prices over time. Its figure leads: the latest value, the day or time it is
 * for and how current it is, and how it moved over the period. The picker lists what can be bought here first. For a
 * holding, what was paid for it is drawn across.
 */
export function PriceRecord({ m, home, id, onPick, now }: { m: Market; home: Home; id: string; onPick: (id: string) => void; now: number }) {
  const inst = m.instruments.find((i) => i.id === id) ?? m.instruments[0]!
  const mode: 'live' | 'daily' = inst.kind === 'crypto_spot' ? 'live' : 'daily'
  const [range, setRange] = useState<Record<'live' | 'daily', string>>({ live: 'hours=24', daily: 'days=365' })
  const hist = useData<History>(`/api/market/history?id=${encodeURIComponent(inst.id)}&${range[mode]}`)
  const h = hist.data
  // an axis label is a guide, the reading is exact: on a narrow chart a rupee price of a lakh or more is written short
  const tick = (v: number, d: number, narrow: boolean) => (inst.kind === 'rate' ? `${v.toFixed(d)}%` : narrow && inst.quote === 'INR' && v >= 100_000 ? compactInr(Math.round(v * 100)) : priceText(v, inst.quote, d))
  // beside the ticket on a wide screen the chart takes the height the row gives it, never less than this
  const tall = typeof window !== 'undefined' && window.matchMedia('(min-width: 1100px)').matches ? 280 : 232
  const daily = h?.kind === 'daily'
  const word = h ? (daily ? dailyWord(h.priceType) : 'Buyers offer') : ''
  const from = sourceName(inst.quotes[h?.priceType ?? '']?.provider ?? inst.provider)
  const what = h ? (h.priceType === 'nav' ? 'The NAV published for each business day' : h.priceType === 'bid' ? 'The price buyers offered, as QED recorded it' : h.priceType === 'rate' ? 'The rate published each working day' : 'The reference value published each working day') : ''
  const rangeText = RANGES[mode].find(([q]) => q === range[mode])?.[1] ?? ''
  const pts = (h?.points ?? []).filter((p) => Number.isFinite(p.v))
  const first = pts[0], last = pts[pts.length - 1]
  const short = first && last ? shortOf(rangeText, pointTime(last.t) - pointTime(first.t)) : null
  const change = first && last && first.v !== 0 ? (last.v - first.v) / Math.abs(first.v) : null
  // the day the latest published value is for, and whether it is still current: the quote's own staleness when it is for
  // the same day, else the server's rule (older than the instrument's staleAfterMs from the start of its day)
  const lastDay = daily && last && typeof last.t === 'string' ? last.t : null
  const q = h ? inst.quotes[h.priceType] : undefined
  const stale = lastDay === null ? false : q?.precision === 'day' && q.sourceTs !== null && isoDayOf(q.sourceTs) === lastDay ? q.stale : now - dayStart(lastDay) > Number(inst.meta.staleAfterMs ?? 4 * DAY)
  // what was paid for it, per unit: what its open lots cost (buying costs included) over the quantity held; drawn only
  // against the price it is valued at (what buyers offer, or the NAV), in rupees
  const holding = home.overview.holdings.find((x) => x.instrumentId === inst.id)
  const paidPer = holding && Number(holding.qty) > 0 && holding.cost > 0 && inst.quote === 'INR' && (h?.priceType === 'bid' || h?.priceType === 'nav') ? holding.cost / 100 / Number(holding.qty) : null
  const per = inst.kind === 'mutual_fund' || isUnits(inst.kind) ? 'unit' : inst.base
  // R13: the line is where a sale would get back what was paid, costs included; the card's bought-at price is before costs
  const levels: Level[] = paidPer !== null ? [{ v: paidPer, label: `Break-even ${show(inst, paidPer)}` }] : []
  const term = m.terms.find((t) => t.id === (typeof inst.meta.limitTerm === 'string' ? inst.meta.limitTerm : `limit.${inst.id}`))
  const fall = term ? Number(term.value.fall) : NaN
  const vsPaid = paidPer !== null && last ? (last.v - paidPer) / paidPer : null
  const until = Math.floor(now / 60_000) * 60_000 // the latest published value holds to now; read to the minute
  return (
    <figure className="panel price-chart" id="chart" aria-labelledby="h-chart">
      <div className="pc-top">
        <div className="pc-title"><h2 id="h-chart">Prices over time</h2><p>Recorded or published; no forecast</p></div>
        <div className="pc-tools">
          <label className="pc-pick"><span className="sr">Instrument to chart</span>
            <select className="input" value={inst.id} onChange={(e) => onPick(e.target.value)}>
              <optgroup label="You can buy these here">{m.instruments.filter((i) => i.tradable).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
              <optgroup label="Reference only">{m.instruments.filter((i) => !i.tradable).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
            </select></label>
          <div className="seg pc-range" role="group" aria-label="Period">{RANGES[mode].map(([qq, w]) => <button key={qq} type="button" aria-pressed={range[mode] === qq} onClick={() => setRange((r) => ({ ...r, [mode]: qq }))}>{w}</button>)}</div>
        </div>
      </div>
      {h ? <>
        <div className="pc-main">
          <div className="pc-left">
            <div className="pc-figure" key={`${inst.id}:${range[mode]}`}>
              <p className="pc-k">{inst.name}</p>
              <p className="pc-v" data-resolve="">{last ? show(inst, last.v) : 'No value yet'}</p>
              {last ? <p className={`pc-when ${stale ? 'stale' : ''}`}>{daily && lastDay
                ? <><b>{word} for {dayIn(lastDay, isoDayOf(now))}</b><span>{dailyAge(lastDay, now, stale)}</span></>
                : <><b>{word}, recorded {fmt.time(pointTime(last.t), true)}</b><span>{fmt.age(now - pointTime(last.t))}</span></>}</p> : null}
              {last ? <p className="pc-s">{change !== null ? <span className={`pc-chg ${moved(change) === 'unchanged' ? '' : change > 0 ? 'up' : 'down'}`}>{moved(change).replace(/^./, (c) => c.toUpperCase())}</span> : null}<span>over {short ? `the ${short} recorded` : lastOf(rangeText)}</span><span className="pc-unit">{unitOf(inst)}</span></p> : null}
            </div>
            <TimeChart points={h.points} show={(v) => show(inst, v)} tick={tick} height={tall} fill unit={unitOf(inst)} levels={levels} valueWord={word} until={daily ? until : undefined}
              gapWhy={daily ? 'nothing was published' : 'QED was not running, or the source was silent'} describe={`${what} for ${inst.name}, in ${unitOf(inst)}.`} />
            <div className="pc-key" aria-hidden="true">
              {daily ? <span><i className="k-step" />{word}, as published: each holds until the next</span> : <span><i className="k-line" />{word}, as recorded</span>}
              {/* the chart marks each day a value was published with a dot where there is room, else a tick (grow.css shows the one drawn) */}
              {daily ? <><span className="pk-dots"><i className="k-pub" />A day a {word} was published</span><span className="pk-ticks"><i className="k-tick" />A day a {word} was published</span></> : null}
              {paidPer !== null ? <span><i className="k-level" />Break-even: what you paid a {per} on average, costs included</span> : null}
              {gapsOf(pts.map((p) => pointTime(p.t))).length ? <span><i className="k-gap" />No record</span> : null}
            </div>
          </div>
          <div className="pc-side">
            {short ? <p className="chart-note small pc-short"><b>Only {short} of the {rangeText} is recorded</b>: QED has kept these prices since {edgeOf(first!.t)}.</p> : null}
            <ChartQuestion inst={inst} h={h} range={rangeText} />
            <dl className="pc-facts small">
              {h.priceType === 'bid' ? <div><dt>A purchase pays</dt><dd><Spread inst={inst} /></dd></div>
                : h.priceType === 'nav' ? <div><dt>An order now gets</dt><dd>The NAV for its own day, published after the {String(inst.meta.cutoff ?? '15:00')} India time cut-off: not the one shown here.</dd></div>
                  : <div><dt>Reference only</dt><dd>QED checks the prices it trades on against it. It cannot be bought or sold here.</dd></div>}
              {paidPer !== null ? <div><dt>To break even</dt><dd><b className="gr-n">{show(inst, paidPer)}</b> a {per}: what you paid on average, costs included{vsPaid !== null ? <>; the latest is <b className="gr-n">{Math.abs(vsPaid) < 0.00005 ? 'the same' : `${fmt.pct(Math.abs(vsPaid), 2)} ${vsPaid > 0 ? 'above' : 'below'}`}</b></> : null}.</dd></div> : null}
              {inst.tradable && Number.isFinite(fall) ? <div><dt>Your worst case allows</dt><dd>A fall of <b className="gr-n">{pctText(fall)}</b> between QED's checks ({calibrated(term?.status) ? 'measured from past prices' : 'illustrative, not calibrated'}).</dd></div> : null}
            </dl>
          </div>
        </div>
        <ChartTable inst={inst} h={h} until={until} />
        <figcaption className="small muted">{what}: {h.observations.toLocaleString('en-IN')} values{h.step && h.step > 1 ? `, every ${h.step === 2 ? 'second' : `${h.step}th`} one drawn` : ''}, from {from}. Past prices say nothing about future ones.</figcaption>
      </> : hist.error ? <Problem error={hist.error} /> : <PriceRecordWaiting tall={tall} />}
    </figure>
  )
}

/** The record's shape while its values load: the figure, the plot and the table's line, at their own heights. */
function PriceRecordWaiting({ tall }: { tall: number }) {
  return <div className="pc-loading" aria-busy="true"><p className="pc-q loading-line">Reading the price record</p><Skel h={tall + 52} r={18} /><Skel h={18} r={8} className="pc-line short" /></div>
}

/**
 * What the chart answers (R7-114), asked and answered in words with exact values, and the same values as a table for
 * anyone who cannot read a line: the first and the last value over the period, the change between them, the lowest
 * and the highest, and every stretch with nothing recorded. It describes what was recorded; it projects nothing.
 */
function chartFacts(h: History) {
  const pts = h.points.filter((p) => Number.isFinite(p.v))
  const what = h.priceType === 'nav' ? 'published NAV' : h.priceType === 'rate' ? 'rate' : h.priceType === 'reference' ? 'reference price' : 'price buyers offer'
  if (pts.length < 2) return { what, pts, rec: null }
  const first = pts[0]!, last = pts[pts.length - 1]!
  const lo = pts.reduce((a, b) => (b.v < a.v ? b : a)), hi = pts.reduce((a, b) => (b.v > a.v ? b : a))
  const gaps = gapsOf(pts.map((p) => pointTime(p.t)))
  return { what, pts, rec: { first, last, lo, hi, gaps, change: first.v === 0 ? null : (last.v - first.v) / Math.abs(first.v), missing: gaps.reduce((s, [a, b]) => s + b - a, 0) } }
}

function ChartQuestion({ inst, h, range }: { inst: MarketInstrument; h: History; range: string }) {
  const { what, rec } = chartFacts(h)
  if (!rec) return <div className="pc-words"><p className="chart-q">How has the {what} of {inst.name} moved over {range}?</p></div>
  const { first, last, lo, hi, gaps, change, missing } = rec
  return <div className="pc-words">
    <p className="chart-q">How has the {what} of {inst.name} moved over {range}?</p>
    <p className="chart-a small">From {show(inst, first.v)} ({edgeOf(first.t)}) to {show(inst, last.v)} ({edgeOf(last.t)}){change === null ? '' : `, ${moved(change)}`}. Lowest {show(inst, lo.v)} ({edgeOf(lo.t)}), highest {show(inst, hi.v)} ({edgeOf(hi.t)}). Recorded values only; nothing here is a forecast.</p>
    {gaps.length ? <p className="chart-note small">The line stops where nothing was {h.kind === 'recorded' ? 'recorded' : 'published'}: {gaps.length} stretch{gaps.length === 1 ? '' : 'es'}, {duration(missing)} in all{h.kind === 'recorded' ? ', when QED was not running or the source was silent' : ''}.</p> : null}
  </div>
}

/**
 * The same values as a table, one press away. A published series lists every value of the period, the day it is for and
 * the days it held (the steps, exactly); a recorded one, at most about two dozen rows (the first, the last, the lowest
 * and the highest always in) and a row for every stretch with no record. Rows are drawn when the table is opened.
 */
function ChartTable({ inst, h, until }: { inst: MarketInstrument; h: History; until: number }) {
  const [open, setOpen] = useState(false)
  const { what, pts, rec } = chartFacts(h)
  if (!rec) return null
  const { lo, hi, gaps } = rec
  const daily = typeof rec.first.t === 'string'
  const word = daily ? dailyWord(h.priceType) : 'Price'
  const body = () => {
    if (daily) {
      const holds = holdsOf(pts.map((p) => ({ t: String(p.t), v: p.v })), until)
      const loDay = String(lo.t), hiDay = String(hi.t)
      return dailyRows(holds).map((r, i) => r.kind === 'value'
        ? <tr key={i}><td>{word} for {dayIn(r.day, isoDayOf(until))}{r.day === loDay ? ' (lowest)' : r.day === hiDay ? ' (highest)' : ''}{r.held ? <span className="sub">{r.held.replace(/^./, (c) => c.toUpperCase())}</span> : null}</td><td className="num">{show(inst, r.v)}</td></tr>
        : <tr key={i} className="gr-gap-row"><td>No record, {dayIn(r.from, isoDayOf(until))} to {dayIn(r.to, isoDayOf(until))}</td><td className="num">none</td></tr>)
    }
    // evenly spaced, with the first, the last, the lowest and the highest always in, and a row for every stretch with
    // nothing recorded, where it falls
    const step = Math.max(1, Math.ceil(pts.length / 24))
    const rows = [...new Set([0, ...pts.map((_, i) => i).filter((i) => i % step === 0), pts.indexOf(lo), pts.indexOf(hi), pts.length - 1])].sort((a, b) => a - b).map((i) => pts[i]!)
    const lines: ({ kind: 'value'; p: (typeof pts)[number] } | { kind: 'gap'; a: number; b: number })[] = []
    rows.forEach((r, i) => {
      lines.push({ kind: 'value', p: r })
      const next = rows[i + 1]
      if (next) for (const [a, b] of gaps) if (a >= pointTime(r.t) && b <= pointTime(next.t)) lines.push({ kind: 'gap', a, b })
    })
    return lines.map((l, i) => l.kind === 'value'
      ? <tr key={i}><td>{edgeOf(l.p.t)}{l.p === lo ? ' (lowest)' : l.p === hi ? ' (highest)' : ''}</td><td className="num">{show(inst, l.p.v)}</td></tr>
      : <tr key={i} className="gr-gap-row"><td>No record, {stretch(l.a, l.b, false)}</td><td className="num">none</td></tr>)
  }
  return (
    <details className="small chart-table" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}><summary>The values as a table</summary>
      <div className="gr-scroll gr-scroll-y" tabIndex={0} role="region" aria-label={`The ${what} of ${inst.name} as a table; scroll for more rows`}><table className="ledger fixed gr-values">
        <caption className="sr">{daily ? `Every ${what} of ${inst.name} in the period, the day it is for, and the days it held until the next` : `The ${what} of ${inst.name}: the first, the last, the lowest and the highest recorded values, others evenly between, and each stretch with nothing recorded`}</caption>
        <colgroup><col /><col className="c-px" /></colgroup><thead><tr><th scope="col">{daily ? 'For the day' : 'When'}</th><th scope="col" className="num">{daily ? word : 'Price'}</th></tr></thead>
        <tbody>{open ? body() : null}</tbody></table></div>
    </details>
  )
}
