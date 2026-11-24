/**
 * Where QED could move real money (register N-022; server/legal.ts): every capability in every jurisdiction of the
 * compliance research, closed unless a recorded licence or partner agreement covers it, with what each one needs in the
 * research's own words. Shown on the readiness page, so the build never implies a permission it does not hold.
 * A table from 760 px; below that, one block per capability (a six-column table does not fit a phone).
 */
import { useData } from '../lib/core.ts'
import { Problem } from './kit.tsx'

interface Cell { jurisdiction: string; open: boolean; verdicts: string[]; missing: string; labels: string[] }
interface View { researched: string; status: string; jurisdictions: { id: string; name: string }[]; capabilities: { id: string; name: string; cells: Cell[] }[]; agreements: number; open: number; pairs: number }

const WORD: Record<string, string> = { P: 'partner', L: 'licence', C: 'counsel', X: 'not offered', O: 'display only', build: 'architecture' }
const wordOf = (c: Cell): string => {
  const w = c.open ? 'open' : c.verdicts.map((v) => WORD[v] ?? v).join(' or ') || 'unknown'
  return w.charAt(0).toUpperCase() + w.slice(1)
}
const kindOf = (c: Cell): string => (c.open ? 'open' : c.verdicts.includes('X') ? 'none' : c.verdicts.includes('C') && !c.verdicts.includes('P') ? 'counsel' : c.verdicts.includes('L') && !c.verdicts.includes('P') ? 'licence' : 'partner')
const TITLE = 'Where QED could move real money'

/** A country code for the eye, its name for a screen reader. */
function Code({ id, name }: { id: string; name: string }) {
  return <><span aria-hidden="true">{id}</span><span className="sr">{name}</span></>
}

export function LegalRoutes() {
  const r = useData<View>('/api/legal')
  if (!r.data) return r.error ? <section className="panel lg-routes" aria-labelledby="lg-h"><h2 id="lg-h">{TITLE}</h2><Problem error={r.error} /></section> : null
  const v = r.data
  const nameOf = (id: string) => v.jurisdictions.find((j) => j.id === id)?.name ?? id
  return (
    <section className="panel lg-routes" aria-labelledby="lg-h">
      <div className="lg-head">
        <h2 id="lg-h">{TITLE}</h2>
        <p>{v.open === 0 ? 'Nowhere yet. ' : `${v.open} of ${v.pairs} routes are open. `}In each country, each capability needs either a licence of QED's own or an agreement with a licensed partner. {v.agreements === 0 ? 'No agreement is recorded, so every one of them runs on practice money only.' : `${v.agreements} agreement${v.agreements === 1 ? ' is' : 's are'} recorded.`}</p>
      </div>
      <div className="lg-scroll" role="region" aria-labelledby="lg-h" tabIndex={0}>
        <table className="ledger lg-table">
          <caption className="sr">What a real-money route needs, by capability and country; none is open unless the cell says Open</caption>
          <thead><tr><th scope="col">Capability</th>{v.jurisdictions.map((j) => <th key={j.id} scope="col"><Code id={j.id} name={j.name} /></th>)}</tr></thead>
          <tbody>
            {v.capabilities.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name}</th>
                {c.cells.map((cell) => <td key={cell.jurisdiction}><span className={`lg-v ${kindOf(cell)}`}>{wordOf(cell)}</span></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="lg-list" aria-labelledby="lg-h">
        {v.capabilities.map((c) => (
          <li key={c.id}>
            <h3>{c.name}</h3>
            <dl>{c.cells.map((cell) => <div key={cell.jurisdiction}><dt><Code id={cell.jurisdiction} name={nameOf(cell.jurisdiction)} /></dt><dd className={`lg-v ${kindOf(cell)}`}>{wordOf(cell)}</dd></div>)}</dl>
          </li>
        ))}
      </ul>
      <p className="lg-key"><b>Partner</b>: a route through a licensed partner exists, with counsel to confirm. <b>Licence</b>: QED would need a licence or registration of its own for the design as built. <b>Counsel</b>: how the law classifies it is unresolved. <b>Not offered</b>: QED's design does not offer it there.</p>
      <details className="lg-more">
        <summary>What each one needs, in the research's words</summary>
        <ul>
          {v.capabilities.map((c) => (
            <li key={c.id}><b>{c.name}</b>
              <ul>{c.cells.map((cell) => <li key={cell.jurisdiction}><span className="lg-j">{nameOf(cell.jurisdiction)}</span> {cell.open ? 'Open under a recorded agreement.' : cell.missing}{cell.labels.length ? <span className="lg-label"> ({cell.labels.join(', ')})</span> : null}</li>)}</ul>
            </li>
          ))}
        </ul>
      </details>
      <p className="lg-source">From QED's compliance research of {v.researched}: research, not legal advice. Agreements are read from data/legal-agreements.json; {v.agreements === 0 ? 'there is none.' : `${v.agreements} recorded.`}</p>
    </section>
  )
}
