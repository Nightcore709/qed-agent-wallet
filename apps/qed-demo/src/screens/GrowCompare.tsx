/**
 * Grow: holdings against a benchmark the owner chooses, and estimates of how far today's holdings could fall on a bad
 * day (R13, audit G5 and G9). QED chooses no benchmark and starts with none selected: the choice decides what doing better
 * means. The comparison replays the owner's own flows after costs on the same windows and says how uncertain it is. The
 * risk figures are estimates with their method, window and confidence, drawn apart from every limit and never as one.
 * The chosen benchmark is kept in this browser only.
 */
import { useState } from 'react'
import { fmt, useData } from '../lib/core.ts'
import { Field, Note, Problem } from '../ui/kit.tsx'

interface Choice { id: string; label: string; group: string; observations: number; usable: boolean; note: string }
interface Win {
  id: string; label: string; from: string; to: string; observations: number; ok: boolean; why?: string
  portfolio?: { startValue: number; endValue: number; bought: number; sold: number; gain: number; dietz: number }
  benchmark?: { endValue: number; gain: number; dietz: number; costs: string }
  difference?: { rupees: number; points: number }
  active?: { meanDaily: number; se: number; t: number; annualisedLow: number; annualisedHigh: number; enough: boolean }
}
interface Risk { ok: boolean; why?: string; method: string; confidence: number; horizon: string; window: { from: string; to: string; observations: number } | null; covered: { value: number; share: number }; excluded: { id: string; name: string; value: number }[]; var?: { fraction: number; rupees: number }; cvar?: { fraction: number; rupees: number }; worstDay?: { date: string; fraction: number }; says: string }
interface Data { comparison: { chosen: string | null; choices: Choice[]; statement: string; windows: Win[]; excluded: { id: string; name: string; value: number }[]; method: string[] }; risk: Risk }
const KEY = 'qed.growBenchmark'
const pct = (x: number, dp = 2): string => `${(x * 100).toFixed(dp)}%`
const signed = (x: number, dp = 2): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(dp)}%`

export function GrowCompare() {
  const [choice, setChoice] = useState<string>(() => { try { return localStorage.getItem(KEY) ?? '' } catch { return '' } })
  const res = useData<Data>(`/api/grow/compare${choice ? `?benchmark=${encodeURIComponent(choice)}` : ''}`, ['action'])
  const d = res.data
  const pick = (v: string) => { setChoice(v); try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY) } catch { /* kept for this visit only */ } }
  const groups = d ? [...new Set(d.comparison.choices.map((c) => c.group))] : []
  return (
    <section className="panel gr-compare" aria-labelledby="h-compare" id="compare">
      <div className="panel-head"><h2 id="h-compare">Against a benchmark</h2><p>You choose it; QED does not</p></div>
      {res.error ? <Problem error={res.error} /> : null}
      {!d ? <p className="small muted loading-line">Reading your holdings and their price history…</p> : <>
        <p className="small muted">{d.comparison.statement}</p>
        <Field label="Compare my holdings with" hint="Only what has a daily price history can be chosen. Your choice is kept in this browser.">{(p) => (
          <select {...p} className="input gc-pick" value={choice} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose one…</option>
            {groups.map((g) => <optgroup key={g} label={g}>{d.comparison.choices.filter((c) => c.group === g).map((c) => <option key={c.id} value={c.id} disabled={!c.usable}>{c.label}{c.usable ? '' : ' (too little history)'}</option>)}</optgroup>)}
          </select>)}</Field>
        {choice ? <>
          {d.comparison.choices.find((c) => c.id === choice) ? <p className="small muted">{d.comparison.choices.find((c) => c.id === choice)!.note}</p> : null}
          <div className="gc-windows">{d.comparison.windows.map((w) => (
            <article key={w.id} className="gc-win" aria-label={w.label}>
              <h3>{w.label}{w.from ? <span className="sub"> · {fmt.isoDay(w.from)} to {fmt.isoDay(w.to)}, {w.observations} days</span> : null}</h3>
              {!w.ok || !w.portfolio ? <p className="small muted">{w.why ?? 'Not worked out.'}</p> : <>
                <dl>
                  <div><dt>Your holdings, after costs</dt><dd>{fmt.inr(w.portfolio.gain, true)} ({signed(w.portfolio.dietz)})</dd></div>
                  <div><dt>The benchmark, same rupees, same days</dt><dd>{fmt.inr(w.benchmark!.gain, true)} ({signed(w.benchmark!.dietz)})</dd></div>
                  <div><dt>You against it</dt><dd>{w.difference!.rupees >= 0 ? 'ahead' : 'behind'} by {fmt.inr(Math.abs(w.difference!.rupees), true)} ({signed(w.difference!.points)} points)</dd></div>
                </dl>
                {w.active ? <p className="small muted">Uncertainty: the average daily difference is {signed(w.active.meanDaily, 3)} with a standard error of {pct(w.active.se, 3)}; over a year that is {signed(w.active.annualisedLow, 1)} to {signed(w.active.annualisedHigh, 1)} (95% interval). {Math.abs(w.active.t) < 2 ? 'The difference is within what chance alone produces: it does not show that either side did better.' : 'The difference is more than two standard errors, which chance alone would rarely produce, but it is one stretch of history and says nothing of the next.'}{w.active.enough ? '' : ' Fewer than 60 days: this says very little.'}</p> : null}
                <p className="sub">Benchmark costs: {w.benchmark!.costs}. Values are marks at the last close; neither side has paid to sell or paid tax on its gain.</p>
              </>}
            </article>))}</div>
          {d.comparison.excluded.length ? <Note>Left out for want of a daily price history: {d.comparison.excluded.map((e) => e.name).join(', ')}. They are not in these figures.</Note> : null}
          <details className="gr-more"><summary>How this is worked out</summary><ul className="gr-rows">{d.comparison.method.map((m, i) => <li key={i}><span className="sub">{m}</span></li>)}</ul></details>
        </> : <p className="small">Nothing is compared until you choose a benchmark.</p>}

        <div className="gc-risk" id="risk">
          <h3>An estimate of a bad day for what you hold</h3>
          {!d.risk.ok ? <p className="small muted">{d.risk.why}</p> : <dl>
            <div><dt>Value at risk, {pct(d.risk.confidence, 0)} over {d.risk.horizon}</dt><dd>{pct(d.risk.var!.fraction)} · about {fmt.inr(d.risk.var!.rupees, true)}</dd></div>
            <div><dt>Expected shortfall, the average of the worst 5% of days</dt><dd>{pct(d.risk.cvar!.fraction)} · about {fmt.inr(d.risk.cvar!.rupees, true)}</dd></div>
            <div><dt>The worst day in the window</dt><dd>{signed(d.risk.worstDay!.fraction)} on {fmt.isoDay(d.risk.worstDay!.date)}</dd></div>
          </dl>}
          <p className="small muted"><b>An estimate, not a limit and not a protection.</b> {d.risk.says}</p>
          <details className="gr-more"><summary>Method, window and what it covers</summary><ul className="gr-rows">
            <li><span className="sub">{d.risk.method}</span></li>
            {d.risk.window ? <li><span className="sub">Window: {d.risk.window.observations} days, {fmt.isoDay(d.risk.window.from)} to {fmt.isoDay(d.risk.window.to)}. Confidence {pct(d.risk.confidence, 0)}. Horizon {d.risk.horizon}, never scaled to a longer one.</span></li> : null}
            <li><span className="sub">Covers {fmt.inr(d.risk.covered.value, true)}, {pct(d.risk.covered.share, 0)} of what you hold.{d.risk.excluded.length ? ` Left out for want of a daily history: ${d.risk.excluded.map((e) => e.name).join(', ')}.` : ''}</span></li>
          </ul></details>
        </div>
      </>}
    </section>
  )
}
