/**
 * The Portfolio lab (/holdings/lab, R12): the household's own books beside the evidence about what to do with them.
 * Five things, in the order they matter: the mix and how far it has drifted (with what rebalancing would cost in tax
 * and fees, lot by lot, and the instruction it would take); what can honestly be promised about the money
 * (guarantee-or-abstain certificates for Save and Grow); how competent baselines did on the prices this app recorded
 * (a walk-forward simulation, recomputed now); the 54-year study it rests on (research, recorded, with its file hashes);
 * and a payment due in dollars, unhedged and hedged. Every figure says which of those it is.
 *
 * Nothing here trades. The one action, "Propose this mix as an instruction", opens a draft of the existing rebalance
 * instruction, which the owner reads and signs with a passkey on the instruction's own page; it then asks before every
 * run. Design system "Meridian" (DESIGN.md); the layout is in src/styles/screens/lab.css.
 */
import { ArrowLeft, Download, FileSignature, FlaskConical, Scale } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LabCertificates, LabEvaluation, LabHedge, LabStrategy, LabView } from '../../shared/labTypes.ts'
import { api, fmt, navigate, useData } from '../lib/core.ts'
import { CertificateCard, minor } from '../ui/certificate.tsx'
import { useWidth } from '../ui/charts.tsx'
import { Btn, Field, Link, Note, Problem, useAction } from '../ui/kit.tsx'
import '../styles/screens/lab.css'
import { fromRupees, inrCompact } from '../../shared/money.ts'

interface StudyStrategy { id: string; label: string; kind: string; cagr: number; vol: number; sharpe: number; maxDD: number; cvar95: number; turnover: number; costDrag: number; vsEW: { diff: number; pFwer: number; early: { diff: number; pFwer: number } | null; late: { diff: number; pFwer: number } | null } | null; sharpeAtCost: Record<string, number> | null }
interface Research {
  label: string; caveat: string
  source: { note: string; experiment: string; preregistration: string; seed: number; window: number; start: string; end: string; costs: { equity: number; treasury: number }; files: { path: string; sha256: string }[] }
  data: { key: string; publisher: string; url: string; accessed: string; sha256: string; usedInRun: boolean }[]
  core: { months: number; from: string; to: string; strategies: StudyStrategy[] }
  net: { months: string[]; series: Record<string, number[]> }
  household: { run: string; liquidation: number; tax: number; trading: number; sharpe: number; maxDD: number; missed: number }[]
  rebalancing: { EW: { policy: string; sharpe: number; turnover: number; events: number; maxDD: number }[] }
  hedging: { liability: { horizon: number; starts: number; pShort: number; mean: number; cvar95: number; worst: number }[] }
  risk: { worst: { month: string; loss: number; cvar: number; multiple: number }[] }
}

const pct = (x: number | null | undefined, dp = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : fmt.pct(x, dp))
const num = (x: number | null | undefined, dp = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(dp))
const signed = (x: number, dp = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(dp)}`
/** Rupees (not paise: the study's tables are in rupees), in the shared compact form (crore, or lakh below a crore). */
const crore = (rupees: number) => inrCompact(fromRupees(rupees))
const BASIS_TEXT = { books: 'Your books', simulation: 'Simulation, recomputed now', research: 'Research, recorded', modelled: 'Modelled', illustration: 'Illustration' } as const
const Chip = ({ kind, children }: { kind: keyof typeof BASIS_TEXT; children?: string }) => <span className={`lb-chip ${kind}`}>{children ?? BASIS_TEXT[kind]}</span>

// ------------------------------------------------------------------------------------------------ the page
export function LabScreen() {
  // How the mix is chosen (R13, the allocator): equal shares by default; risk parity or minimum variance when asked for.
  const [policy, setPolicy] = useState<LabView['allocation']['policy']>('equal')
  const lab = useData<LabView>(`/api/lab${policy === 'equal' ? '' : `?policy=${policy}`}`, ['action', 'nav', 'profile'])
  const [declared, setDeclared] = useState(false)
  const certs = useData<LabCertificates>(`/api/lab/certificates${declared ? '?declared=1' : ''}`, ['action', 'profile'])
  const research = useData<Research>('/api/lab/research')
  const download = () => {
    const report = { kind: 'QED Portfolio lab report', generatedAt: new Date().toISOString(), note: 'Research, simulations and your own books are labelled apart; nothing here is advice or a promise of returns. Money is in paise (INR) unless a field says otherwise.', lab: lab.data, certificates: certs.data, research: research.data ? { label: research.data.label, caveat: research.data.caveat, source: research.data.source, data: research.data.data, strategies: research.data.core.strategies, household: research.data.household } : null }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `qed-portfolio-report-${new Date().toISOString().slice(0, 10)}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  // the head is drawn before any data arrives (DESIGN.md M11)
  const head = (
    <header className="page-head lb-head">
      <div>
        <h1>Portfolio lab.<span className="dim"> Evidence before allocation.</span></h1>
        <p>Your investments, how they would be kept in balance and what that would cost, what can honestly be promised about your money, and the evidence behind each step. Your books, simulations and research are labelled apart. Nothing here trades: a change becomes an instruction you sign.</p>
      </div>
      <nav className="lb-acts" aria-label="Lab actions">
        <Btn onClick={download} disabled={!lab.data}><Download aria-hidden="true" />Download the report</Btn>
        <Link to="/holdings" className="btn quiet"><ArrowLeft aria-hidden="true" />Back to Grow</Link>
      </nav>
    </header>
  )
  return (
    <div className="lb-page">
      {head}
      <p className="lb-disclaimer"><FlaskConical aria-hidden="true" />Not investment advice. QED is not a registered investment adviser or portfolio manager; this build moves no real money{lab.data?.presentation ? ', and every price here is synthetic (presentation mode)' : ''}.</p>
      {!lab.data ? (lab.error ? <Problem error={lab.error} /> : <p className="loading-line" aria-busy="true">Reading your books and the recorded prices…</p>) : (<>
        <div className="lb-top">
          <Mix v={lab.data} policy={policy} setPolicy={setPolicy} />
          <Watch v={lab.data} />
        </div>
        <section className="panel lb-certs" aria-labelledby="h-certs">
          <div className="panel-head"><h2 id="h-certs">What QED can promise about your money</h2><p>Guarantee or abstain: each promise is checked, and a model is never called a guarantee</p></div>
          <label className="lb-declare"><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} /><span>Every fee and tax I owe in the next 30 days is among my bills. <span className="muted">Your books do not record taxes; without this statement no reserve can be certified.</span></span></label>
          {certs.error ? <Problem error={certs.error} /> : null}
          {certs.data ? <>
            {certs.data.notes.length ? <ul className="lb-notes">{certs.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
            {(['save', 'grow'] as const).map((pillar) => { const list = certs.data!.cases.filter((c) => c.pillar === pillar); return list.length ? (
              <div key={pillar} className="lb-cert-group">
                <h3 className="lb-group-h">{pillar === 'save' ? 'Save: what is due in the next 30 days' : 'Grow: your investments'}</h3>
                {list.map((c) => <CertificateCard key={c.id} title={c.title} plain={c.plain} basis={c.basis} assumptions={c.assumptions} request={c.request} outcome={c.outcome} />)}
              </div>) : null })}
          </> : <p className="loading-line" aria-busy="true">Checking each promise…</p>}
        </section>
        <Evaluation e={lab.data.evaluation} />
        <Study r={research.data} error={research.error} />
        <Hedge />
        <Terms v={lab.data} />
      </>)}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ the mix
function Mix({ v, policy, setPolicy }: { v: LabView; policy: LabView['allocation']['policy']; setPolicy: (p: LabView['allocation']['policy']) => void }) {
  const a = v.allocation
  const propose = useAction(async () => { const r = await api<{ programId: string }>('POST', '/api/lab/proposals/rebalance', { policy }); navigate(`/instructions/${r.programId}`) })
  const band = a.bandBps / 100
  return (
    <section className="panel lb-mix" aria-labelledby="h-mix">
      <div className="panel-head"><h2 id="h-mix"><Scale aria-hidden="true" />Your mix</h2><Chip kind="books" /></div>
      <div className="lb-policy">
        <Field label="How the shares are chosen" hint="Equal shares are the baseline. The other two are calculated from the last year of values this app recorded; they never trade by themselves.">
          {(p) => <select {...p} className="input" value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
            <option value="equal">Equal shares (1/N)</option>
            <option value="riskparity">Risk parity: each investment adds the same risk</option>
            <option value="minvar">Minimum variance, long only</option>
          </select>}
        </Field>
      </div>
      {a.legs.length < 2 && policy !== 'equal' ? <>
        <p className="lb-lead">No {policy === 'minvar' ? 'minimum-variance' : 'risk-parity'} mix to propose</p>
        <p className="lb-sub">{a.why}</p>
      </> : a.legs.length < 2 ? <>
        <p className="lb-lead">Nothing to balance yet</p>
        <p className="lb-sub">{a.why} With two or more, this panel shows each share against equal shares, how far it has drifted, what trading back would cost in tax lot by lot and in fees, and the instruction that would keep it within a {band}-point band, for you to sign.</p>
        <ul className="lb-facts" aria-label="What the 54-year study found (research)">
          <li><b>Equal weight</b><span>was not beaten by any of eleven strategies, net of costs, 1972 to 2026</span></li>
          <li><b>A 5-point band</b><span>cut trading by about two thirds against monthly rebalancing, at the same return for risk</span></li>
          <li><b>About 12% more</b><span>after tax for the taxed household, from the band alone</span></li>
        </ul>
        <p className="lb-note">Research, recorded: the study is described below, with every file it came from.</p>
        <Link to="/holdings#ticket" className="btn">Buy or sell on Grow</Link>
      </> : <>
        <p className={`lb-lead ${a.outside ? 'out' : ''}`}>{a.outside ? `${(a.drift * 100).toFixed(1)} points out of balance` : `Within the ${band}-point band`}</p>
        <p className="lb-sub">{a.policyText}, kept within {band} percentage points of each share. In the 54-year study a band like this cut trading by about two thirds without lowering the return for its risk, and saved the taxed household about 12% against monthly rebalancing (research, below).</p>
        <ul className="lb-legs">
          {a.legs.map((l) => (
            <li key={l.instrumentId}>
              <div className="lb-leg-row"><span className="lb-leg-name">{l.name}</span><span className="lb-leg-fig">{pct(l.weight)} <span className="muted">of {pct(l.target, 0)}</span></span></div>
              <div className="lb-bar" role="img" aria-label={`${l.name}: ${pct(l.weight)} now, ${pct(l.target, 0)} target, band ${pct(Math.max(0, l.target - band / 100), 0)} to ${pct(l.target + band / 100, 0)}`}>
                <span className="lb-band" style={{ left: `${Math.max(0, l.target - band / 100) * 100}%`, width: `${(Math.min(1, l.target + band / 100) - Math.max(0, l.target - band / 100)) * 100}%` }} />
                <span className={`lb-fill ${Math.abs(l.drift) > band / 100 ? 'out' : ''}`} style={{ width: `${l.weight * 100}%` }} />
                <span className="lb-target" style={{ left: `${l.target * 100}%` }} />
              </div>
              <p className="lb-leg-sub">{fmt.inr(l.value)}{l.trade !== 0 && a.outside ? `; ${l.trade > 0 ? 'buy' : 'sell'} about ${fmt.inr(Math.abs(l.trade))}` : ''}</p>
            </li>
          ))}
        </ul>
        {a.evidence ? (
          <div className="lb-evidence" aria-label="The evidence for this mix">
            <h3>The evidence for this mix <Chip kind="simulation">Calculated now, from recorded values</Chip></h3>
            <ul className="lb-notes">
              <li><b>Solve:</b> {a.evidence.method}. From {a.evidence.window.observations} daily returns, {a.evidence.window.from} to {a.evidence.window.to}, covariance shrunk by {(a.evidence.shrinkage * 100).toFixed(0)}%. Its own optimality check {a.evidence.certified ? 'passed' : 'did NOT pass'} ({Object.entries(a.evidence.certificate).map(([k, x]) => `${k} ${x.toExponential(1)}`).join(', ')}).</li>
              <li><b>Out of sample, your investments:</b> {a.evidence.outOfSample.text}</li>
              <li><b>The study:</b> {a.evidence.study.text} <Chip kind="research" /></li>
              {a.evidence.caveats.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        ) : null}
        <p className="lb-key"><span className="lb-key-fill" aria-hidden="true" />share now <span className="lb-key-band" aria-hidden="true" />the band <span className="lb-key-target" aria-hidden="true" />the target share</p>
        {a.outside ? (
          <div className="lb-trades">
            <h3>What rebalancing today would do</h3>
            <div className="lb-scroll" tabIndex={0} role="region" aria-label="Trades and their tax and fees">
              <table className="ledger lb-table">
                <thead><tr><th scope="col">Trade</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Gain realised</th><th scope="col" className="num">Tax (modelled)</th><th scope="col" className="num">Fees</th></tr></thead>
                <tbody>{a.trades.map((t) => <tr key={t.instrumentId}><th scope="row">{t.side === 'sell' ? 'Sell' : 'Buy'} {t.name}<span className="sub">{t.taxNote}</span></th><td className="num">{fmt.inr(t.amount)}</td><td className="num">{t.side === 'sell' ? fmt.signed(t.realisedGain, false) : '—'}</td><td className="num">{fmt.inr(t.tax)}</td><td className="num">{fmt.inr(t.fee, true)}<span className="sub">{t.feeNote}</span></td></tr>)}</tbody>
                <tfoot><tr><th scope="row">Total</th><td /><td /><td className="num">{fmt.inr(a.taxTotal)}</td><td className="num">{fmt.inr(a.feeTotal, true)}</td></tr></tfoot>
              </table>
            </div>
            {a.tdsTotal ? <p className="lb-note">{fmt.inr(a.tdsTotal, true)} would also be deducted at source on the digital-asset sale (1%, credited against your tax).</p> : null}
            {a.newMoney ? <p className="lb-note">{a.newMoney.months !== null ? `Your instruction${a.newMoney.programs.length === 1 ? '' : 's'} (${a.newMoney.programs.join(', ')}) invest about ${fmt.inr(a.newMoney.monthly)} a month. Pointed at what is under its share, that money would close the ${fmt.inr(a.newMoney.gap)} gap in about ${a.newMoney.months} month${a.newMoney.months === 1 ? '' : 's'} without selling anything, and so without tax.` : 'Your investing instructions put nothing in each month, so only selling would close the gap.'}</p> : null}
          </div>
        ) : null}
        <div className="lb-propose">
          <Btn tone="fill" busy={propose.busy} disabled={!a.proposable} onClick={() => void propose.run()}><FileSignature aria-hidden="true" />Propose this mix as an instruction</Btn>
          <p className="lb-note">{a.proposable ? `Opens a draft you read and sign with your passkey. It trades back to these shares only when one leaves the band, and asks you before every run. Nothing trades until you sign.${a.evidence ? ' A calculation by QED, not advice.' : ''}` : a.why}</p>
          {a.existing.length ? <p className="lb-note">{a.existing.map((e) => <Link key={e.id} to={`/instructions/${e.id}`}>{e.title} ({e.state})</Link>)}</p> : null}
          <Problem error={propose.error} />
        </div>
      </>}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ monitoring
function Watch({ v }: { v: LabView }) {
  const m = v.monitor, b = v.books
  const ladder = m.liquidity.steps
  return (
    <section className="panel lb-watch" aria-labelledby="h-watch">
      <div className="panel-head"><h2 id="h-watch">Watching it</h2><Chip kind="books" /></div>
      <ul className="lb-tiles">
        <li className="tile"><p className="k">Largest holding</p><p className="v">{m.concentration.largest ? pct(m.concentration.largest.weight, 0) : '—'}</p><p className="s">{m.concentration.largest ? `${m.concentration.largest.name}, of what can grow` : 'Nothing held that can grow'}</p></li>
        <li className="tile"><p className="k">Effective holdings</p><p className="v">{m.concentration.effectiveN ? num(m.concentration.effectiveN, 1) : '—'}</p><p className="s">As diversified as this many equal holdings (1 ÷ the sum of squared shares)</p></li>
        <li className="tile"><p className="k">Moves with the dollar</p><p className="v">{pct(m.dollar.weight, 0)}</p><p className="s">{m.dollar.names.length ? m.dollar.names.join(', ') : 'Nothing dollar-linked'}</p></li>
        <li className={`tile ${m.liquidity.short30 ? 'lb-warn' : ''}`}><p className="k">Due in the next 30 days</p><p className="v">{fmt.inr(m.liquidity.due30)}</p><p className="s">{m.liquidity.short30 ? 'More than your bank and three days of sales can raise' : `Covered by your bank${m.liquidity.due30 > b.bankAvailable ? ' and three days of sales' : ' alone'}`}</p></li>
      </ul>
      <h3 className="lb-h3">What you owe</h3>
      <ol className="lb-ladder">
        <li><span>Due in the next 30 days ({b.dues.filter((d) => d.certain).length} bills and instalments)</span><b>{fmt.inr(b.due30)}</b></li>
        <li><span>Credit card</span><b>{fmt.inr(b.card)}</b></li>
        <li><span>Loans</span><b>{fmt.inr(b.loans)}</b></li>
      </ol>
      <h3 className="lb-h3">Cash you could raise</h3>
      <ol className="lb-ladder">{ladder.map((s) => <li key={s.label}><span>{s.label}</span><b>{fmt.inr(s.amount)}</b></li>)}</ol>
      <p className="lb-note">Funds pay out on their own schedules (liquid funds the next business day, equity funds in two, international in three); a sale on the paper exchange settles at once. Your worst case after each holding's limit is {fmt.inr(b.worst.gHat)} against your floor of {fmt.inr(b.worst.line)}{b.worst.illustrative ? ' (some limits are illustrative, not calibrated)' : ''}.</p>
      {m.concentration.byFundHouse.length > 1 ? <p className="lb-note">By who runs it: {m.concentration.byFundHouse.map((h) => `${h.house} ${pct(h.weight, 0)}`).join(', ')}.</p> : null}
      {m.stale.length ? <Note tone="wait">Stale prices: {m.stale.join(', ')}. Their values and limits are not current.</Note> : null}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the walk-forward
/** Each line keeps its own colour and its own dash, so the lines can be told apart without colour. */
const LINES: { color: string; dash: string; width: number }[] = [
  { color: 'var(--c1)', dash: '', width: 2.4 }, { color: 'var(--c2)', dash: '7 4', width: 1.7 }, { color: 'var(--c5)', dash: '', width: 1.7 },
  { color: 'var(--c4)', dash: '2 3', width: 1.9 }, { color: 'var(--c3)', dash: '9 3 2 3', width: 1.6 },
]
function Growth({ series, labels, title, unit }: { series: { id: string; label: string; path: number[] }[]; labels: [string, string]; title: string; unit: string }) {
  const [box, width] = useWidth()
  const W = Math.max(280, width || 640), H = W < 520 ? 180 : 220, P = { l: 46, r: 12, t: 12, b: 26 }
  const n = Math.max(...series.map((s) => s.path.length))
  const all = series.flatMap((s) => s.path)
  const lo = Math.log(Math.min(1, ...all)), hi = Math.log(Math.max(1, ...all))
  const x = (i: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r)
  const y = (v: number) => P.t + (1 - (Math.log(v) - lo) / Math.max(1e-9, hi - lo)) * (H - P.t - P.b)
  const ticks = [1, Math.exp(hi), Math.exp(lo)].filter((v, i, a) => a.slice(0, i).every((u) => Math.abs(y(u) - y(v)) > 16))
  const L = (k: number) => LINES[k % LINES.length]!
  return (
    <figure className="lb-chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${series.map((s) => `${s.label} ends at ${s.path[s.path.length - 1]!.toFixed(2)}`).join('; ')}`}>
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="lb-grid" /><text x={P.l - 6} y={y(t) + 4} className="lb-axis" textAnchor="end">{t.toFixed(2)}</text></g>)}
        {series.map((s, k) => <polyline key={s.id} fill="none" stroke={L(k).color} strokeWidth={L(k).width} strokeDasharray={L(k).dash || undefined} strokeLinejoin="round" points={s.path.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />)}
        <text x={P.l} y={H - 6} className="lb-axis">{labels[0]}</text><text x={W - P.r} y={H - 6} className="lb-axis" textAnchor="end">{labels[1]}</text>
      </svg>
      <figcaption><span className="lb-legend">{series.map((s, k) => <span key={s.id}><svg className="lb-swatch" viewBox="0 0 22 6" aria-hidden="true"><line x1="0" x2="22" y1="3" y2="3" stroke={L(k).color} strokeWidth={L(k).width + 0.6} strokeDasharray={L(k).dash || undefined} /></svg>{s.label}</span>)}</span><span className="muted">{unit}; a logarithmic scale, so equal steps are equal percentage changes.</span></figcaption>
    </figure>
  )
}

function Evaluation({ e }: { e: LabEvaluation | { error: string; source: string } }) {
  if ('error' in e) return (
    <section className="panel lb-eval" aria-labelledby="h-eval">
      <div className="panel-head"><h2 id="h-eval">Strategies on the prices this app recorded</h2><Chip kind="simulation" /></div>
      <p className="lb-sub">Not enough recorded prices to compare strategies: {e.error}</p><p className="lb-note">Source: {e.source}.</p>
    </section>
  )
  const cert = (s: LabStrategy) => s.cert.kktResidual !== undefined ? `KKT residual at most ${s.cert.kktResidual.toExponential(1)}, duality gap at most ${(s.cert.dualityGap ?? 0).toExponential(1)}` : s.cert.maxRiskContributionDeviation !== undefined ? `risk contributions equal to within ${s.cert.maxRiskContributionDeviation.toExponential(1)}` : 'fixed weights'
  return (
    <section className="panel lb-eval" aria-labelledby="h-eval">
      <div className="panel-head"><h2 id="h-eval">Strategies on the prices this app recorded</h2><Chip kind="simulation" /></div>
      <p className="lb-lead-s">{e.verdict}</p>
      <p className="lb-note">Recomputed now from {e.source}: {e.months.length} months out of sample ({fmt.isoDay(`${e.months[0]}-01`).replace(/^1 /, '')} to {fmt.isoDay(`${e.months[e.months.length - 1]}-01`).replace(/^1 /, '')}), each month's weights decided from the {e.lookbackDays} days before it. {e.costs.note} Return for risk is measured over {e.rf}.</p>
      <Growth series={e.strategies.map((s) => ({ id: s.id, label: s.label, path: s.path }))} labels={[e.months[0]!, e.months[e.months.length - 1]!]} title="Growth of 1 rupee, net of costs" unit="Growth of 1 rupee, net of costs" />
      <div className="lb-scroll" tabIndex={0} role="region" aria-label="Strategy results, net of costs">
        <table className="ledger lb-table">
          <thead><tr><th scope="col">Strategy</th><th scope="col" className="num">Growth a year</th><th scope="col" className="num">Volatility</th><th scope="col" className="num">Sharpe</th><th scope="col" className="num">Worst fall</th><th scope="col" className="num">Worst month</th><th scope="col" className="num">Traded a month</th><th scope="col" className="num">Against 1/N (95% interval)</th></tr></thead>
          <tbody>{e.strategies.map((s) => <tr key={s.id}><th scope="row">{s.label}<span className="sub">{cert(s)}</span></th><td className="num">{pct(s.metrics.cagr)}</td><td className="num">{pct(s.metrics.vol)}</td><td className="num">{num(s.metrics.sharpe)}</td><td className="num">{pct(s.metrics.maxDD)}</td><td className="num">{pct(s.metrics.worstMonth)}</td><td className="num">{pct(s.turnover)}</td><td className="num">{s.vsEW ? <>{signed(s.vsEW.diff)} <span className="muted">[{signed(s.vsEW.lo)}, {signed(s.vsEW.hi)}]</span><span className="sub">{s.vsEW.tooShort ? 'too few months to tell' : s.vsEW.detectable ? 'detectably different, comparisons counted' : `not detectable; could detect about ${s.vsEW.mde.toFixed(2)}`}</span></> : 'the benchmark'}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="lb-note">A simulation on {e.synthetic ? 'synthetic prices: it shows the method works, and says nothing about markets' : 'one short record of real published NAVs: it is not a forecast'}. The intervals come from a block bootstrap of the paired months (block 3, 1,000 draws, seed 20261124); a difference is called detectable only with 36 months or more and when it survives all the comparisons together (Bonferroni).</p>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the study
function Study({ r, error }: { r: Research | null; error: { message: string } | null }) {
  const recomputed = useMemo(() => {
    if (!r) return null
    const keep = ['EW', 'B6040', 'RP_LW', 'MINV_LW', 'VW_MKT']
    return keep.map((id) => {
      let v = 1; const path: number[] = []
      for (const x of r.net.series[id] ?? []) { v *= 1 + x; path.push(v) }
      const cagr = Math.pow(v, 12 / path.length) - 1
      const table = r.core.strategies.find((s) => s.id === id)!
      return { id, label: table.label, path, cagr, tableCagr: table.cagr }
    })
  }, [r])
  if (!r) return <section className="panel lb-study" aria-labelledby="h-study"><div className="panel-head"><h2 id="h-study">The 54-year study</h2><Chip kind="research" /></div>{error ? <Note tone="void">{error.message}</Note> : <p className="loading-line" aria-busy="true">Reading the recorded study…</p>}</section>
  const ew = r.core.strategies.find((s) => s.id === 'EW')!
  const best = [...r.core.strategies].filter((s) => s.vsEW).sort((a, b) => b.vsEW!.diff - a.vsEW!.diff)[0]!
  const minP = Math.min(...r.core.strategies.filter((s) => s.vsEW).map((s) => s.vsEW!.pFwer))
  const agree = recomputed!.every((x) => Math.abs(x.cagr - x.tableCagr) < 5e-5)
  const hh = (run: string) => r.household.find((h) => h.run === run)
  return (
    <section className="panel lb-study" aria-labelledby="h-study">
      <div className="panel-head"><h2 id="h-study">The 54-year study: nothing beat equal weight net of costs</h2><Chip kind="research" /></div>
      <p className="lb-lead-s">Over {r.core.months} months out of sample ({r.core.from} to {r.core.to}), with trading costs of {(r.source.costs.equity * 1e4).toFixed(0)} basis points on equities and {(r.source.costs.treasury * 1e4).toFixed(0)} on Treasuries, no optimiser's Sharpe ratio differed detectably from equal weight's {num(ew.sharpe, 3)}. The best, {best.label.toLowerCase()}, was {signed(best.vsEW!.diff, 3)} a year (every family-wise p-value at least {minP.toFixed(2)}).</p>
      <p className="lb-note">{r.caveat} Eleven US assets (ten industry portfolios and a 10-year Treasury proxy), in dollars; 1972 to 2026 is one path of history.</p>
      <Growth series={recomputed!.map((x) => ({ id: x.id, label: x.label, path: x.path }))} labels={[r.core.from, r.core.to]} title="Growth of 1 dollar in the study, net of costs" unit="Growth of 1 dollar, net of costs, recomputed here from the study's monthly returns" />
      <p className="lb-note">{agree ? 'Recomputed in your browser from the recorded monthly returns, each baseline\'s growth a year agrees with the study\'s own table.' : 'Recomputed in your browser, a baseline\'s growth a year differs from the study\'s table: the recorded series and the table disagree.'}</p>
      <div className="lb-scroll" tabIndex={0} role="region" aria-label="The study's strategies against equal weight">
        <table className="ledger lb-table">
          <thead><tr><th scope="col">Strategy</th><th scope="col" className="num">Growth a year</th><th scope="col" className="num">Sharpe</th><th scope="col" className="num">Worst fall</th><th scope="col" className="num">Against 1/N</th><th scope="col" className="num">Family-wise p</th><th scope="col" className="num">Cost a year</th></tr></thead>
          <tbody>{r.core.strategies.map((s) => <tr key={s.id}><th scope="row">{s.label}<span className="sub">{s.kind === 'baseline' ? 'a baseline' : 'an optimiser'}</span></th><td className="num">{pct(s.cagr)}</td><td className="num">{num(s.sharpe, 3)}</td><td className="num">{pct(s.maxDD)}</td><td className="num">{s.vsEW ? signed(s.vsEW.diff, 3) : 'the benchmark'}</td><td className="num">{s.vsEW ? num(s.vsEW.pFwer, 2) : '—'}</td><td className="num">{pct(s.costDrag, 2)}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="lb-twin">
        <div>
          <h3 className="lb-h3">For a taxed rupee household, tax mattered more than the optimiser</h3>
          <p className="lb-note">A synthetic household, 2001 to 2026, with dated rupee and dollar obligations (every one met), 20% capital-gains tax and fund fees.</p>
          <table className="ledger lb-table compact">
            <thead><tr><th scope="col">How the growth part was run</th><th scope="col" className="num">Worth at the end</th><th scope="col" className="num">Tax paid</th></tr></thead>
            <tbody>{([['EW', 'Equal weight, rebalanced monthly'], ['EW_BAND5', 'Equal weight, 5-point band'], ['VW_MKT', 'Market, held'], ['RP_LW', 'Risk parity, monthly']] as const).map(([run, label]) => { const h = hh(run); return h ? <tr key={run}><th scope="row">{label}</th><td className="num">{crore(h.liquidation)}</td><td className="num">{crore(h.tax)}</td></tr> : null })}</tbody>
          </table>
        </div>
        <div>
          <h3 className="lb-h3">Model limits are not guarantees</h3>
          <p className="lb-note">The model's 95% CVaR was breached in clusters, and the worst months lost {r.risk.worst.map((w) => `${pct(w.loss, 0)} (${w.month}, ${num(w.multiple, 1)} times the forecast)`).join(', ')}. That is why a model bound is labelled an estimate here, never a guarantee.</p>
        </div>
      </div>
      <details className="lb-prov">
        <summary>Where every research figure comes from ({r.source.files.length} files, {r.data.length} data sources)</summary>
        <p className="lb-note">{r.source.note}; code and outputs in {r.source.experiment}. Design frozen before the first full run: {r.source.preregistration}. Seed {r.source.seed}; {r.source.window}-month estimation window.</p>
        <ul className="lb-files">{r.source.files.map((f) => <li key={f.path}><code>{f.path}</code><span className="muted"> SHA-256 {f.sha256.slice(0, 16)}…</span></li>)}</ul>
        <ul className="lb-files">{r.data.map((d) => <li key={d.key}>{d.publisher}<span className="muted">, read {d.accessed.slice(0, 10)}, SHA-256 {d.sha256.slice(0, 16)}…{d.usedInRun ? '' : ' (not this run\'s copy)'}</span></li>)}</ul>
      </details>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ a dollar liability
function Hedge() {
  const [usd, setUsd] = useState('25000')
  const [due, setDue] = useState(() => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10))
  const [h, setH] = useState<LabHedge | null>(null)
  const run = useAction(async () => setH(await api<LabHedge>('POST', '/api/lab/hedge', { usd: Number(usd.replace(/[,\s$]/g, '')), due })))
  const fields = (run.error as { fields?: Record<string, string> } | null)?.fields
  return (
    <section className="panel lb-hedge" aria-labelledby="h-hedge">
      <div className="panel-head"><h2 id="h-hedge">A payment due in dollars</h2><span className="lb-chips"><Chip kind="simulation" /><Chip kind="illustration" /></span></div>
      <p className="lb-sub">Tuition or a bill abroad, owed in dollars on a date. Leave the rupees in a liquid fund and convert on the day, and the rupee can fall first; buy dollar Treasury bills that mature in time, and the dollars are there by construction, at the price of the rupee interest you give up.</p>
      <form className="lb-form" onSubmit={(e) => { e.preventDefault(); void run.run() }}>
        <Field label="Dollars owed" error={fields?.usd}>{(p) => <input {...p} className="input" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />}</Field>
        <Field label="Due on" error={fields?.due}>{(p) => <input {...p} className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        <Btn busy={run.busy} type="submit">See the risk and the hedge</Btn>
      </form>
      {run.error && !fields ? <Problem error={run.error} /> : null}
      {h ? (
        <div className="lb-hedge-out">
          <div className="lb-twin">
            <div className="tile">
              <p className="k">Unhedged: rupees set aside now, converted on the day</p>
              {h.unhedged ? <>
                <p className="v">{pct(h.unhedged.pShort, 0)} <span className="muted">of past windows short</span></p>
                <p className="s">Across {h.fx!.windows} windows of {h.days} days on {h.fx!.source} ({fmt.isoDay(h.fx!.from)} to {fmt.isoDay(h.fx!.to)}), with the rupees earning {h.unhedged.growth}: on average {h.unhedged.mean > 0 ? 'short' : 'ahead'} by {pct(Math.abs(h.unhedged.mean))}; the worst 5% of windows short by {pct(h.unhedged.cvar95)}, the worst by {pct(h.unhedged.worst)}.</p>
              </> : <p className="s">{h.notes[0]}</p>}
            </div>
            <div className="tile">
              <p className="k">Hedged by construction: US Treasury bills</p>
              <p className="v">${(h.hedged.costUsd / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              <p className="s">{h.hedged.lots} bills of $100 face maturing {fmt.isoDay(h.hedged.maturity)}, at most ${(h.hedged.limitPerLot / 100).toFixed(2)} each{h.hedged.costInr !== null ? `; about ${fmt.inr(h.hedged.costInr)} today at the reference rate plus a 0.25% spread` : ''}. Priced from {h.hedged.rate ? `${h.hedged.rate.source} (${pct(h.hedged.rate.value, 2)}, ${fmt.isoDay(h.hedged.rate.date)})` : 'the R11 study\'s 3-month Treasury yield of 4.32%'}: indicative, not a quote.</p>
            </div>
          </div>
          <CertificateCard title={`USD ${h.usd.toLocaleString('en-US')} due ${fmt.isoDay(h.due)}, from Treasury bills`} basis="illustration" plain="What a hedge by construction would rest on. This app cannot buy Treasury bills or hold dollars at a custodian." outcome={h.certificate} />
          <ul className="lb-notes">{h.notes.slice(h.unhedged ? 0 : 1).map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      ) : null}
      <HedgeStudy />
    </section>
  )
}
function HedgeStudy() {
  const r = useData<Research>('/api/lab/research')
  if (!r.data) return null
  return (
    <div className="lb-hedge-study">
      <h3 className="lb-h3">In the study: USD 25,000 owed by a rupee household, 2001 to 2026 <Chip kind="research" /></h3>
      <table className="ledger lb-table compact">
        <thead><tr><th scope="col">Owed in</th><th scope="col" className="num">Start months</th><th scope="col" className="num">Short in</th><th scope="col" className="num">On average</th><th scope="col" className="num">Worst 5%</th><th scope="col" className="num">Worst</th></tr></thead>
        <tbody>{r.data.hedging.liability.map((x) => <tr key={x.horizon}><th scope="row">{x.horizon} months</th><td className="num">{x.starts}</td><td className="num">{pct(x.pShort, 0)}</td><td className="num">{x.mean < 0 ? `ahead ${pct(-x.mean)}` : `short ${pct(x.mean)}`}</td><td className="num">short {pct(x.cvar95)}</td><td className="num">short {pct(x.worst)}</td></tr>)}</tbody>
      </table>
      <p className="lb-note">Not hedging left a surplus on average (rupee interest outran the rupee's fall) but was short in a quarter to over a third of start months, by up to 18%. Hedging buys certainty at the price of that carry.</p>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ terms
function Terms({ v }: { v: LabView }) {
  return (
    <section className="panel lb-terms" aria-labelledby="h-terms">
      <div className="panel-head"><h2 id="h-terms">Terms and assumptions</h2><p>Each with its status</p></div>
      <ul className="lb-term-list">{v.terms.map((t) => <li key={t.id}><span className={`lb-status ${t.status}`}>{t.status}</span><span>{t.name}<span className="sub">{t.source}</span></span></li>)}</ul>
      <h3 className="lb-h3">What this lab does not do</h3>
      <ul className="lb-notes">
        <li>It does not advise: it shows evidence and computes what a choice would do. QED holds no investment adviser or portfolio manager registration.</li>
        <li>It does not trade. A mix becomes a draft instruction you sign; each run then asks you first.</li>
        <li>It cannot buy government securities, Treasury bills or hold dollars at a custodian; those appear only as illustrations.</li>
        <li>Tax figures are modelled, not verified against the Income-tax Act 2025 this session, and are not tax advice.</li>
        <li>The study is recorded, not re-run here; the walk-forward is recomputed from this app's own records each time you open the page.</li>
      </ul>
    </section>
  )
}
