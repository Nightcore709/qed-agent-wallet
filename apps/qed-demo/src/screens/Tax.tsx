/**
 * Tax statement (register R7-059): the realised gains of the ledger's FIFO lots, by Indian financial year and asset class,
 * short-term and long-term by each class's holding-period rule, at the rates in force on each sale date, with tax deducted
 * at source, the charges already applied at execution, the set-off rules and a reconciliation to the ledger. The server
 * works it out (server/tax.ts); this screen shows it and hands it over as CSV or JSON. Always labelled "Modelled, not tax
 * advice", with the date of the rule set. Every figure is a table cell or a labelled value: nothing depends on colour.
 */
import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { inrExact } from '../../shared/money.ts'
import { api, fmt, httpsOnly, useData } from '../lib/core.ts'
import { Btn, Loading, Note, Problem, Stamp, useAction } from '../ui/kit.tsx'
import { ActivityHead } from './Activity.tsx'

interface Line { fy: string; cls: string; term: string; section: string; rateBp: number | null; modelled: boolean; proceeds: string; cost: string; gain: string; note: string }
interface Transfer { entryId: string; ts: number; instrumentId: string; consideration: string; cost: string; gain: string; saleFee: string; tds: string }
interface Year {
  fy: string; assessmentYear: string; lines: Line[]
  vda: { transfers: Transfer[]; gains: string; disallowedLoss: string; taxable: string; tax: string; saleFeesNotAllowed: string }
  charges: { kind: string; label: string; amount: string; treatment: string }[]; tds: { vda: string; creditNote: string }
  setOff: { from: string; against: string; amount: string; kind: string }[]; exemption: { section: string; limit: string; used: string }
  tax: { section: string; rateBp: number | null; taxable: string; tax: string | null; note: string }[]; taxTotalFixedRates: string; slabGainsTaxable: string
  carriedForward: { fy: string; term: string; amount: string; usableUntilFy: string }[]; lapsed: { fy: string; term: string; amount: string }[]
  totals: { proceeds: string; cost: string; ledgerGain: string; gain: string }
}
interface Statement {
  generatedAt: number; label: string; ruleSet: { id: string; asOf: string; sources: { id: string; claim: string; url: string; seen: string }[]; notVerified: string[] }
  assumptions: string[]; years: Year[]; reconciliation: { ok: boolean; breaks: { check: string; detail: string }[] }; csv?: string
}

const CLASS_NAME: Record<string, string> = { equity_fund: 'Equity-oriented funds', debt_fund_50aa: 'Debt funds bought on or after 1 April 2023', other_fund: 'Other funds', vda: 'Virtual digital assets', unclassified: 'Not classified' }
/** Paise, as a decimal string, to rupees through the one formatter (shared/money.ts): exact, whole rupees without decimals. */
export const rs = (paise: string): string => inrExact(BigInt(paise))
const rate = (bp: number | null): string => (bp === null ? 'Your slab rate' : `${bp / 100}%`)
const termWord = (t: string): string => (t === 'long' ? 'Long-term' : 'Short-term')
function save(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function TaxScreen() {
  const st = useData<Statement>('/api/tax', ['action', 'run'])
  const [pick, setPick] = useState<string | null>(null)
  const tabs = useId()
  const csv = useAction(async () => { const s = await api<Statement>('GET', '/api/tax?csv=1'); save(`qed-tax-statement-${s.ruleSet.asOf}.csv`, s.csv ?? '', 'text/csv;charset=utf-8') })
  const json = useAction(async () => { const s = await api<Statement>('GET', '/api/tax'); save(`qed-tax-statement-${s.ruleSet.asOf}.json`, JSON.stringify(s, null, 2), 'application/json') })
  const s = st.data
  const years = s ? [...s.years].reverse() : []
  const y = s ? years.find((x) => x.fy === pick) ?? years[0] : undefined

  return (
    <div className="tx">
      <ActivityHead title="Tax statement" actions={s ? <>
        <Btn small busy={csv.busy} onClick={() => void csv.run()}><Download aria-hidden="true" />Download CSV</Btn>
        <Btn small busy={json.busy} onClick={() => void json.run()}><Download aria-hidden="true" />Download JSON</Btn>
      </> : null}>Realised gains from your holdings, by financial year (April to March) and kind of asset, worked out from the ledger&rsquo;s first-in, first-out lots.</ActivityHead>
      <Note tone="wait" title={s ? `${s.label}. Rule set dated ${fmt.dayYear(Date.parse(s.ruleSet.asOf))}.` : 'Modelled, not tax advice.'}>
        <p>These are paper trades, so these are the tax figures of simulated trades. The rules are QED&rsquo;s reading of the sources listed at the foot of this page; some are not verified against the Act&rsquo;s own text. Check with a tax professional before you file anything.</p>
      </Note>
      <Problem error={csv.error ?? json.error} />
      {!s ? (st.error ? <><Problem error={st.error} /><Btn small onClick={st.reload}>Try again</Btn></> : <Loading what="Working out your tax statement" />) : !y ? (
        <section className="panel tx-sec"><h2>No sales yet</h2><p className="tx-note">Nothing has been sold, so there are no realised gains. Charges and tax deducted appear here in the year they were applied.</p></section>
      ) : (
        <>
          <div className="tx-years" role="group" aria-label="Financial year">
            <div className="seg">{years.map((x) => <button key={x.fy} type="button" aria-pressed={x.fy === y.fy} onClick={() => setPick(x.fy)}>{x.fy}</button>)}</div>
            <p className="tx-note" id={tabs}>Financial year {y.fy}, assessment year {y.assessmentYear}.</p>
          </div>
          <div className="tx-tiles">
            <div className="tx-tile"><p className="k">Realised gain, by the ledger</p><p className="v">{rs(y.totals.ledgerGain)}</p><p className="s">Proceeds {rs(y.totals.proceeds)} less cost {rs(y.totals.cost)}</p></div>
            <div className="tx-tile"><p className="k">Tax at fixed rates</p><p className="v">{rs(y.taxTotalFixedRates)}</p><p className="s">Before surcharge and cess. Gains taxed at your slab rate: {rs(y.slabGainsTaxable)} taxable, no tax figure</p></div>
            <div className="tx-tile"><p className="k">Tax already deducted</p><p className="v">{rs(y.tds.vda)}</p><p className="s">Section 194S, 1% on virtual digital asset sales</p></div>
          </div>

          <section className="panel tx-sec" aria-labelledby="tx-gains">
            <h2 id="tx-gains">Realised gains by kind of asset</h2>
            {y.lines.length ? (
              <div className="tx-scroll" tabIndex={0} role="region" aria-label="Realised gains table; scroll sideways on a narrow screen">
                <table className="ledger tx-table">
                  <caption className="sr">Realised gains in {y.fy}: kind of asset, term, section, rate, proceeds, cost and gain</caption>
                  <thead><tr><th scope="col">Asset</th><th scope="col">Term</th><th scope="col">Section</th><th scope="col">Rate</th><th scope="col" className="num">Proceeds</th><th scope="col" className="num">Cost</th><th scope="col" className="num">Gain</th></tr></thead>
                  <tbody>{y.lines.map((l) => (
                    <tr key={`${l.cls}${l.term}${l.section}${l.rateBp}`}>
                      <th scope="row">{CLASS_NAME[l.cls] ?? l.cls}<span className="tx-sub">{l.note}</span></th><td>{termWord(l.term)}</td><td>{l.section}</td><td>{l.modelled ? rate(l.rateBp) : 'Not modelled'}</td>
                      <td className="num">{rs(l.proceeds)}</td><td className="num">{rs(l.cost)}</td><td className="num">{rs(l.gain)}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            ) : <p className="tx-note">Nothing was sold in this year.</p>}
          </section>

          {y.vda.transfers.length ? (
            <section className="panel tx-sec" aria-labelledby="tx-vda">
              <h2 id="tx-vda">Virtual digital assets, sale by sale</h2>
              <p className="tx-note">Section 115BBH: 30% on the gain of each sale. The cost is the only deduction; a loss on one sale is not set off against another sale, or against any other income, and is not carried forward. The venue&rsquo;s fee on a sale is added back to the consideration for the same reason.</p>
              <div className="tx-scroll" tabIndex={0} role="region" aria-label="Virtual digital asset sales; scroll sideways on a narrow screen">
                <table className="ledger tx-table">
                  <caption className="sr">Each sale of a virtual digital asset in {y.fy}</caption>
                  <thead><tr><th scope="col">Sold</th><th scope="col" className="num">Consideration</th><th scope="col" className="num">Cost</th><th scope="col" className="num">Gain or loss</th><th scope="col" className="num">Fee added back</th><th scope="col" className="num">Tax deducted</th></tr></thead>
                  <tbody>{y.vda.transfers.map((t) => <tr key={t.entryId}><th scope="row">{fmt.dayYear(t.ts)}</th><td className="num">{rs(t.consideration)}</td><td className="num">{rs(t.cost)}</td><td className="num">{rs(t.gain)}</td><td className="num">{rs(t.saleFee)}</td><td className="num">{rs(t.tds)}</td></tr>)}</tbody>
                  <tfoot><tr><th scope="row">Taxable at 30%</th><td colSpan={2} className="num">Gains {rs(y.vda.gains)}</td><td className="num">Losses not allowed {rs(y.vda.disallowedLoss)}</td><td colSpan={2} className="num">Tax {rs(y.vda.tax)}</td></tr></tfoot>
                </table>
              </div>
            </section>
          ) : null}

          <section className="panel tx-sec" aria-labelledby="tx-set">
            <h2 id="tx-set">Set-off, exemption and tax</h2>
            <p className="tx-note">A short-term loss is set off against any capital gain; a long-term loss only against long-term gains (section 74). Losses are applied to the highest rate first, then carried forward for at most eight assessment years. A loss on a virtual digital asset is never set off.</p>
            {y.setOff.length ? <ul className="tx-list">{y.setOff.map((x, i) => <li key={i}>{rs(x.amount)} of the {x.from.toLowerCase()} set against {x.against.toLowerCase()}{x.kind === 'brought-forward' ? ' (brought forward)' : ''}</li>)}</ul> : <p className="tx-note">No loss was set off in this year.</p>}
            <p className="tx-note">Exemption on long-term gains under section {y.exemption.section}: {rs(y.exemption.used)} used of {rs(y.exemption.limit)}.</p>
            <div className="tx-scroll" tabIndex={0} role="region" aria-label="Tax by section; scroll sideways on a narrow screen">
              <table className="ledger tx-table">
                <caption className="sr">Taxable amount and tax by section for {y.fy}</caption>
                <thead><tr><th scope="col">Section</th><th scope="col">Rate</th><th scope="col" className="num">Taxable</th><th scope="col" className="num">Tax</th><th scope="col">Note</th></tr></thead>
                <tbody>{y.tax.map((t, i) => <tr key={i}><th scope="row">{t.section}</th><td>{rate(t.rateBp)}</td><td className="num">{rs(t.taxable)}</td><td className="num">{t.tax === null ? 'Not worked out' : rs(t.tax)}</td><td>{t.note}</td></tr>)}</tbody>
              </table>
            </div>
            {y.carriedForward.length ? <><h3>Loss carried forward</h3><ul className="tx-list">{y.carriedForward.map((c, i) => <li key={i}>{rs(c.amount)} {c.term}-term loss of {c.fy}, usable until {c.usableUntilFy}</li>)}</ul></> : null}
            {y.lapsed.length ? <><h3>Loss that lapsed</h3><ul className="tx-list">{y.lapsed.map((c, i) => <li key={i}>{rs(c.amount)} {c.term}-term loss of {c.fy}</li>)}</ul></> : null}
          </section>

          <section className="panel tx-sec" aria-labelledby="tx-charges">
            <h2 id="tx-charges">Stamp duty, fees and tax deducted</h2>
            <p className="tx-note">As already applied when the trades were carried out.</p>
            <ul className="tx-list">
              {y.charges.map((c) => <li key={c.kind}><b>{c.label}: {rs(c.amount)}.</b> {c.treatment}.</li>)}
              <li><b>Tax deducted at source: {rs(y.tds.vda)}.</b> {y.tds.creditNote}.</li>
              {!y.charges.length && y.tds.vda === '0' ? <li>None in this year.</li> : null}
            </ul>
          </section>

          <section className="panel tx-sec" aria-labelledby="tx-recon">
            <h2 id="tx-recon">Reconciled to the ledger</h2>
            {s.reconciliation.ok
              ? <p className="tx-note"><Stamp tone="ok">Agrees</Stamp> Each sale&rsquo;s proceeds, each lot&rsquo;s cost, the totals, the tax deducted and the stamp duty agree with the ledger&rsquo;s own postings.</p>
              : <><p className="tx-note"><Stamp tone="void">Does not agree</Stamp> Do not rely on these figures until this is explained.</p><ul className="tx-list">{s.reconciliation.breaks.map((b, i) => <li key={i}><b>{b.check}.</b> {b.detail}</li>)}</ul></>}
          </section>

          <section className="panel tx-sec" aria-labelledby="tx-src">
            <h2 id="tx-src">Sources, as read on {fmt.dayYear(Date.parse(s.ruleSet.asOf))}</h2>
            <ul className="tx-list">{s.ruleSet.sources.map((x) => <li key={x.id}>{x.claim}. {httpsOnly(x.url) ? <a href={httpsOnly(x.url)} target="_blank" rel="noreferrer noopener">{new URL(x.url).hostname}<span className="sr"> (another site, in a new tab)</span></a> : <span>{String(x.url)}</span>}</li>)}</ul>
            <h3>Not verified</h3>
            <ul className="tx-list">{s.ruleSet.notVerified.map((x) => <li key={x}>{x}</li>)}</ul>
            <h3>Assumptions</h3>
            <ul className="tx-list">{s.assumptions.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
        </>
      )}
    </div>
  )
}
