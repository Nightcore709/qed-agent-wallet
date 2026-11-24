/**
 * A guarantee-or-abstain certificate as a person reads it (R12): the promise checked, the level it holds at in words,
 * and either who stands behind it and what could break it, or why it cannot be promised and what would change that.
 * Levels, in the research note's words: holds by construction (the sovereign's own instruments), holds by a named
 * party's promise (contractual), a model estimate (never called a guarantee), or not promised. The word "guaranteed"
 * appears nowhere below by construction. R13: no label says more than the evidence. A certificate holds only if its
 * assumptions hold, and they are shown before anything else about it. One that rests on purchases not yet made would
 * hold only once they fill. An empty reserve covers nothing. A refused promise names the weaker claims the owner could
 * ask for instead, never certifies one in its place.
 *
 * Self-contained so other screens can mount it: Save can show `<CertificateCard c={…} />` for its reserve when its
 * owner chooses to (its layout belongs to another specialist this round). It needs only the outcome the checker
 * returned (shared/kernel/coverage.ts) and, optionally, the request it answered.
 */
import { useId } from 'react'
import { BadgeCheck, CircleHelp, Landmark, ShieldAlert } from 'lucide-react'
import type { CoverageOutcome as Outcome } from '../../shared/kernel/index.ts'
import { fmt } from '../lib/core.ts'
import '../styles/certificate.css'

export interface CertificateProps { title: string; plain?: string; basis?: string; assumptions?: string[]; request?: unknown; outcome: Outcome }

type LevelText = { word: string; tone: string; line: string; Icon: typeof BadgeCheck }
const LEVEL: Record<Outcome['status'], LevelText> = {
  CERTIFIED_BY_CONSTRUCTION: { word: 'Holds by construction', tone: 'ok', line: 'Holds by construction if the assumptions below hold; it fails on the events listed.', Icon: BadgeCheck },
  CERTIFIED_CONTRACTUAL: { word: 'Holds by a bank\'s promise', tone: 'info', line: 'A contractual promise: it relies on the named bank as well as on what is held, and holds if the assumptions below hold.', Icon: Landmark },
  BOUNDED_UNDER_MODEL: { word: 'Model estimate, not a guarantee', tone: 'wait', line: 'True only if the future resembles the past the model was fitted on. Nobody stands behind it.', Icon: CircleHelp },
  ABSTAIN: { word: 'Not promised', tone: 'void', line: 'QED refuses to promise this as asked. The reasons and what would change them are below.', Icon: ShieldAlert },
}
/** The level as it can truly be said: a promise resting on purchases not yet made would hold only once they fill, and
 *  a reserve with nothing in it covers nothing (R13). */
export function levelOf(o: Outcome): LevelText {
  const pro = o.protected as { purchases_pending?: number; obligations?: number }
  if (o.status === 'CERTIFIED_BY_CONSTRUCTION' || o.status === 'CERTIFIED_CONTRACTUAL') {
    if (pro.obligations === 0) return { word: 'Nothing to cover', tone: 'info', line: 'Nothing listed falls due in this period, so there is nothing for this promise to cover.', Icon: CircleHelp }
    if ((pro.purchases_pending ?? 0) > 0) {
      const how = o.status === 'CERTIFIED_BY_CONSTRUCTION' ? 'by construction' : 'by a bank\'s promise'
      return { ...LEVEL[o.status], word: `Would hold ${how}, once bought`, line: `Would hold ${how} once bought at or below the limit price, if the assumptions below hold; until then nothing is protected. It fails on the events listed.` }
    }
  }
  return LEVEL[o.status]
}
const BASIS_WORD: Record<string, string> = { books: 'Your books', illustration: 'Illustration: not possible in this app', research: 'Research', simulation: 'Simulation', indicative: 'Indicative prices' }

/** Minor units as money: rupees the Indian way, dollars the American way, others with their code. */
export function minor(amount: number, ccy: string): string {
  if (ccy === 'INR') return fmt.money(amount, amount % 100 !== 0)
  const v = (amount / 100).toLocaleString('en-US', { minimumFractionDigits: amount % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })
  return ccy === 'USD' ? `$${v}` : `${ccy} ${v}`
}
/** The checker writes money as "INR 2,796.85"; the interface writes rupees the Indian way and dollars with $. */
const prose = (t: string): string => t.replace(/\b(INR|USD) (-?)([\d,]+)(?:\.(\d{2}))?\b/g, (_m, c: string, neg: string, whole: string, frac?: string) => `${neg ? '−' : ''}${minor(Number(whole.replace(/,/g, '')) * 100 + Number(frac ?? '0'), c)}`)
const ccyOf = (o: Outcome): string => String((o.protected as { currency?: string }).currency ?? (/ in (?:nominal )?([A-Z]{3})\b/.exec(o.property)?.[1] ?? 'INR'))

export function CertificateCard({ title, plain, basis, assumptions, request, outcome: o }: CertificateProps) {
  const L = levelOf(o)
  const headingId = useId() // not the fingerprint: a refused, unreadable request has none
  const claim = typeof (o.protected as { claim?: unknown }).claim === 'string' ? String((o.protected as { claim: string }).claim) : null
  const ccy = ccyOf(o)
  const rows = (o.evidence.coverage ?? []) as { obligation: string; due: string; fund_by: string; amount_minor: number; cum_in_minor: number; slack_minor: number }[]
  const model = o.evidence.model as Record<string, number | string> | undefined
  const ev = o.evidence as Record<string, number | undefined>
  return (
    <article className={`cert cert-${L.tone}`} aria-labelledby={headingId}>
      <header className="cert-head">
        <div className="cert-title">
          <h3 id={headingId}>{title}</h3>
          {basis ? <span className={`cert-basis ${basis}`}>{BASIS_WORD[basis] ?? basis}</span> : null}
        </div>
        <span className={`cert-level ${L.tone}`}><L.Icon aria-hidden="true" />{L.word}</span>
      </header>
      {plain ? <p className="cert-plain">{plain}</p> : null}
      <p className="cert-prop"><span className="cert-k">The promise checked</span>{prose(o.property)}</p>
      {claim && o.status !== 'ABSTAIN' ? <p className="cert-prop"><span className="cert-k">Exactly what is promised</span>{prose(claim)}</p> : null}
      <p className="cert-line">{L.line}</p>

      {o.status === 'ABSTAIN' ? (
        <div className="cert-cols">
          <section aria-label="Why it is not promised"><h4>Why not</h4><ul className="cert-list">{o.reasons.map((r, i) => <li key={i}><span>{prose(r.detail)}</span><code>{r.code}</code></li>)}</ul></section>
          {o.remedies.length ? <section aria-label="What would make it hold"><h4>What would make it hold</h4><ul className="cert-list">{o.remedies.map((r, i) => <li key={i}><span>{prose(r)}</span></li>)}</ul></section> : null}
          {o.alternatives.length ? <section aria-label="A weaker claim you could ask for instead"><h4>A weaker claim you could ask for instead</h4><ul className="cert-list">{o.alternatives.map((a, i) => <li key={i}><span>{prose(a)}</span></li>)}</ul></section> : null}
        </div>
      ) : (
        <div className="cert-cols">
          {o.assumptions.length ? <section aria-label="What it assumes"><h4>What it assumes</h4><ul className="cert-list">{o.assumptions.map((a, i) => <li key={i}><span>{prose(a)}</span></li>)}</ul></section> : null}
          <section aria-label="Who stands behind it"><h4>Who stands behind it</h4><p className="cert-small">{o.funding_underwriter}</p>
            {o.counterparties.length ? <ul className="cert-list">{o.counterparties.map((c, i) => <li key={i}><span><b>{String(c.name)}</b>: {prose(String(c.role))}{typeof c.peak_exposure_minor === 'number' ? `; up to ${minor(c.peak_exposure_minor, ccy)} there at once${typeof c.insured_minor === 'number' ? `, insured up to ${minor(c.insured_minor, ccy)} as declared` : ''}` : ''}</span></li>)}</ul> : null}
          </section>
          <section aria-label="What could break it"><h4>What could break it</h4><ul className="cert-list">{o.failure_conditions.map((f, i) => <li key={i}><span>{prose(f)}</span></li>)}</ul></section>
        </div>
      )}

      {rows.length ? (
        <div className="cert-scroll" tabIndex={0} role="region" aria-label="Each obligation and the cash in place for it">
          <table className="ledger cert-table">
            <thead><tr><th scope="col">Obligation</th><th scope="col">Due</th><th scope="col">Cash must be in place by</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Cash in place by then</th><th scope="col" className="num">Slack</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={`${r.obligation}-${r.fund_by}`}><th scope="row">{r.obligation}</th><td className="date">{fmt.isoDay(r.due)}</td><td className="date">{fmt.isoDay(r.fund_by)}</td><td className="num">{minor(r.amount_minor, ccy)}</td><td className="num">{minor(r.cum_in_minor, ccy)}</td><td className={`num ${r.slack_minor < 0 ? 'cert-short' : ''}`}>{r.slack_minor < 0 ? `short ${minor(-r.slack_minor, ccy)}` : minor(r.slack_minor, ccy)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
      {typeof ev.max_risky_minor === 'number' ? <p className="cert-small">The floor costs {minor(ev.floor_cost_minor ?? 0, ccy)} for {minor(ev.floor_face_minor ?? 0, ccy)} at maturity; at most {minor(ev.max_risky_minor, ccy)} can stay at risk, and that part can be worth nothing.</p> : null}
      {model ? <p className="cert-small">Model {String(model.model)}: CVaR estimate {fmt.pct(Number(model.cvar_estimate), 1)}, 95% upper bound {fmt.pct(Number(model.cvar_ucb95), 1)}. Backtested over {String(model.months_backtested)} months: the VaR was exceeded in {fmt.pct(Number(model.exceedance_rate), 1)} of months (5% expected; Kupiec p = {Number(model.kupiec_p).toFixed(3)}); after an exceedance, {fmt.pct(Number(model.p_exceed_after_exceed), 0)} against {fmt.pct(Number(model.p_exceed_after_calm), 0)} otherwise (Christoffersen p = {Number(model.christoffersen_p).toFixed(3)}).</p> : null}
      {o.liquidity && o.status !== 'ABSTAIN' ? <p className="cert-small">{prose(o.liquidity)}</p> : null}
      {assumptions?.length ? <ul className="cert-assume">{assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
      <details className="cert-more">
        <summary>The exact request and its fingerprint</summary>
        {o.request_hash
          ? <p className="cert-small">SHA-256 of the canonical request: <code className="cert-hash">{o.request_hash}</code>. Checked by {o.checker_version}. QED's research checker, written in Python and not part of this app, computes the same fingerprint for a request it reads the same way; the two were compared on 22 recorded and 25,000 generated requests.</p>
          : <p className="cert-small">No fingerprint: the request could not be read. Checked by {o.checker_version}.</p>}
        {/* a scrolling block must be reachable by keyboard (axe scrollable-region-focusable, found with the disclosure open) */}
        {request !== undefined ? <pre className="cert-json" tabIndex={0} role="region" aria-label="The request, as sent to the checker">{JSON.stringify(request, (k, v) => (k === 'scenario_returns' && Array.isArray(v) ? `${v.length} monthly returns` : v), 2)}</pre> : null}
      </details>
    </article>
  )
}
