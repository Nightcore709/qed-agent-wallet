/**
 * Evidence (N-010; design "Meridian", DESIGN.md M4): each case is one thing QED did or refused, assembled by the server
 * from its own records (server/evidence.ts). The list opens on the kinds of evidence, each counted and each a filter, so
 * that none is read as another (the owner's R10 directive): execution on the local test chain of this build, simulated
 * execution on a paper venue, a throwaway chain that no longer exists, a scripted test double's replayed replies rather
 * than a model, and the historical record of a public test network from before this build. Then the cases, found by
 * their words and narrowed by how they ended, and the historical record.
 *
 * A case reads first as an explanation, in five answers (what happened, who decided, what checked it, what executed,
 * what reconciled), beside the way to check it: the hashes recomputed in this browser, the file to download and verify
 * offline. Then the eight numbered sections of the record, each with its technical detail one press away, and what the
 * case cannot prove beside what was left out. Token tickers and raw addresses are written out of the readable text; the
 * exact words are in the technical detail and the downloaded file. The browser recomputes each section's hash and the
 * root itself (shared/sha256.ts, the same canonical JSON the server and the offline verifier use).
 */
import { Check, Download, FileSearch, Route, Search, X } from 'lucide-react'
import { Fragment, type ReactNode, useId, useState } from 'react'
import { fmt, useData } from '../lib/core.ts'
import { canonical, sha256 } from '../../shared/sha256.ts'
import { Btn, Crumb, Link, Note, Problem, Seal, Stamp } from '../ui/kit.tsx'
import type { HistoricalEvidence } from '../../chain/types.ts'
import { CASE_KIND, caseOutcome, type CaseSummary, executionOf, groupCases } from '../ui/records.ts'
import { ActivityHead, checkLabel, readable, useMedia } from './Activity.tsx'

export { executionOf, groupCases, readable }

type J = Record<string, any>
export interface Case { format: string; id: string; kind: string; title: string; outcome: string; venue: string; workspace: string; assembledAt: string; sections: Record<string, J>; verification: J; redactions: { what: string; how: string; why: string }[]; cannotProve: string[]; hashes: { algorithm: string; sections: Record<string, string>; verification: string; redactions: string; cannotProve: string; root: string } }

const proposer = (m: CaseSummary['model'] | J | null | undefined): [string, string] => !m || m.label === 'none' ? ['No model: deterministic rules', 'plain'] : m.label === 'scripted-test-double' ? ['Scripted test double, not a model', 'wait'] : ['A model', 'info']
const short = (h: string | null | undefined): string => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '')
const when = (iso: string | null | undefined): string => (iso ? fmt.dayTime(Date.parse(iso)) : '')

const UNIT_WORDS: Record<string, string> = { tINR: 'test rupees', tUSD: 'test dollars', tEUR: 'test euros', tETH: 'test ether' }
/** A raw token amount with its decimals, digits moved, never through a float; the unit named in words ("3.00 test rupees"). */
export function units(raw: string | number | null | undefined, decimals: number, asset: string): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const s = String(raw), neg = s.startsWith('-'), d = (neg ? s.slice(1) : s).padStart(decimals + 1, '0')
  const int = decimals ? d.slice(0, -decimals) : d, frac = decimals ? d.slice(-decimals).replace(/0+$/, '').padEnd(Math.min(2, decimals), '0') : ''
  const figure = `${neg ? '−' : ''}${Number(int).toLocaleString(asset.includes('INR') ? 'en-IN' : 'en-US')}${frac ? `.${frac}` : ''}`
  return asset === 'INR' ? `${neg ? '−' : ''}₹${figure.replace(/^−/, '')}` : `${figure} ${UNIT_WORDS[asset] ?? asset}`
}

/** What a check of a proposal, the vault or a run establishes, in words (the record's own id is in the technical detail). */
const CHECK_WORDS: Record<string, string> = {
  'vault-available': 'The on-chain wallet answered', parameters: 'The terms have the form the wallet accepts', 'mandate-active': 'A signed mandate is in force',
  'reserve-target-range': 'The reserve target is within what the wallet accepts', 'free-funds': 'The wallet has the money free', 'payee-in-book': 'The payee is one the wallet already knows',
  'vault-limits': 'Within the wallet\'s limits', 'model-answered': 'The model answered', 'venue-accepted': 'The venue accepted it',
  'job-completed': 'The vault service finished it', 'job-refused': 'The vault service refused it', 'job-reverted': 'The chain reverted it',
  'run-skipped': 'The run had something to do', 'run-cancelled': 'The run was not cancelled', 'run-expired': 'The run started in time',
  // the vault service's steps (chain/rail), as its job records name them
  interpret: 'The instruction is understood', mandate: 'Within the mandate and the wallet\'s limits', owner: 'Your approval, signed with your passkey',
  cosigner: 'The co-signer\'s own rules are met', plan: 'A route is found and its proof built', submit: 'Sent to the chain', receipt: 'Mined on the chain',
  reconcile: 'Balances agree before and after', decide: 'The agent works out the tranche',
}
const TRANCHE: Record<string, string> = { need: 'the shortfall', impact: 'its cost limit', 'policy cap': 'the policy\'s largest tranche', 'mandate cap': 'the mandate\'s limit for one payment', 'free funds': 'the free funds' }
/** A proposal's state, as the model-call case's section 2 lists it. */
const PROPOSAL_STATE: Record<string, string> = { new: 'proposed, not signed', drafted: 'drafted, not yet signed', invalid: 'not valid', dismissed: 'dismissed', superseded: 'replaced by a later proposal' }
const lowerFirst = (t: string): string => t.replace(/^([A-Z])(?=[a-z\s])/, (c) => c.toLowerCase())
/** A check's name as a person would say what it checks: "Keep 10 test dollars in the dollar reserve: the on-chain wallet answered". */
export function checkWords(name: string): string {
  if (CHECK_WORDS[name]) return CHECK_WORDS[name]!
  let m = /^proposal-valid: (.+)$/.exec(name)
  if (m) return `${m[1]}: the proposal is valid`
  if ((m = /^(C\d+): (.+)$/.exec(name))) return `${readable(m[2]!).replace(/[.\s]+$/, '')}, the co-signer's rule ${m[1]}`
  if ((m = /^limit: (.+)$/.exec(name))) return `Within the wallet's limit: ${m[1]!.replace(/[-_]/g, ' ')}`
  if ((m = /^tranche: (.+)$/.exec(name))) return `The tranche, limited by ${TRANCHE[m[1]!] ?? m[1]}`
  if ((m = /^(.+): ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(name))) return `${readable(m[1]!)}: ${lowerFirst(checkWords(m[2]!))}`
  if (/^[a-z][a-z0-9-]*$/.test(name)) return checkLabel(name)
  return readable(name)
}
/** Who made a check, in words; the record names the file and the function, which stay in the technical detail. */
const BY: [RegExp, string][] = [
  [/^engine\b.*$/, 'QED\'s engine'],
  [/^validation\b.*\bvault service's own figures\b.*$/, 'QED, on the vault service\'s own figures'],
  [/^validation\b.*$/, 'QED, as it stores and drafts the proposal'],
  [/^model boundary\b.*$/, 'QED\'s guard around the model'],
  [/^agent \(deterministic policy\)$/, 'the agent\'s fixed rules'],
  [/^co-signer \(decision record #(\d+)\)$/, 'the co-signer, in its decision record no. $1'],
  [/^when the owner asked for the terms: (.+)$/, '$1, when the owner asked for the terms'],
  [/^vault limits$/, 'the wallet\'s limits'], [/^vault service$/, 'the vault service'], [/^paper venue$/, 'the paper venue'],
  [/^co-signer$/, 'the co-signer'], [/^chain$/, 'the chain'], [/^reconciliation$/, 'comparing balances before and after'],
  [/^language guard$/, 'QED\'s guard on the instruction\'s words'], [/^Security Lab$/, 'the attack test'],
]
export function plainBy(by: string): string {
  const b = by.trim()
  for (const [re, words] of BY) if (re.test(b)) return b.replace(re, words)
  return readable(b)
}

const sentenceOf = (t: string): string => { const k = t.indexOf('. '); const x = (k > 0 ? t.slice(0, k + 1) : t).trim(); return /[.!?]$/.test(x) ? x : `${x}.` }
const upperFirst = (t: string): string => t.replace(/^./, (c) => c.toUpperCase())
/**
 * What happened, for the case's one reading: what moved, or that nothing did, said once. The record's consequence is used
 * when it adds something: its own words when they already say why nothing moved, else who stopped it or why.
 */
export function whatHappened(outcome: string, moved: string | null, consequence: string | null): string {
  if (moved) return moved
  const base = outcome === 'refused' || outcome === 'blocked' ? 'Nothing moved: it was refused before anything was sent.' : 'Nothing moved.'
  const c = readable(consequence ?? '').trim()
  if (!c) return base
  if (/^nothing moved\b|\bmoved nothing\b/i.test(c)) return /[.!?]$/.test(c) ? c : `${c}.`
  const k = c.indexOf(': ')
  const head = (k > 0 ? c.slice(0, k) : c).replace(/[.\s]+$/, ''), rest = k > 0 ? c.slice(k + 2).trim() : ''
  // a head the sentence already says (refused before anything was sent), or a bare state, adds nothing: its reason may
  const said = base.toLowerCase().includes(head.toLowerCase()) || /^(done|failed|rejected|cancelled|expired|partial|blocked|refused)$/i.test(head)
  if (!said) return `${base} ${upperFirst(head)}.`
  return rest ? `${base} ${upperFirst(sentenceOf(rest))}` : base
}
/** Section 5's own "Nothing moved." when nothing moved: left out when the record's consequence below it already says so. */
export function nothingMovedLine(consequence: string | null): string | null {
  return consequence && /^nothing moved\b|\bmoved nothing\b/i.test(readable(consequence).trim()) ? null : 'Nothing moved.'
}
/** Section 4's verdict in bold: a fresh signature, or authority signed earlier; nothing at all when nothing ran under any. */
export function authorityLine(s4: { freshOwnerSignature?: unknown; ranUnder?: unknown }): string | null {
  if (s4.freshOwnerSignature) return 'A fresh owner signature was needed for this.'
  return Array.isArray(s4.ranUnder) && s4.ranUnder.length ? 'No fresh owner signature: it ran under authority signed earlier.' : null
}

/** What executed, from sections 5 and 6: the transactions and where they ran, a paper fill, or nothing at all. */
export function executedWords(c: { outcome: string; venue: string }, s5: J, s6: J): string {
  const txs = Array.isArray(s6.transactions) ? (s6.transactions as J[]) : []
  if (txs.length) {
    const ok = txs.filter((t) => t.status === 'success').length
    const blocks = [...new Set(txs.map((t) => String(t.block ?? '')).filter(Boolean))]
    const where = c.venue === 'ephemeral-chain' || txs.every((t) => t.chain === 'ephemeral') ? 'a throwaway test chain that no longer exists' : 'the local test chain on this computer'
    return `${txs.length === 1 ? 'One transaction' : `${txs.length} transactions`} on ${where}; ${ok} of ${txs.length} succeeded${blocks.length ? `, in block${blocks.length === 1 ? '' : 's'} ${blocks.join(', ')}` : ''}.`
  }
  if (s5.executed && (c.venue === 'paper' || s6.venue?.kind === 'paper')) return 'Filled by a paper venue this installation runs, with its own books; no order or payment reached an exchange or a bank.'
  if (s5.executed) return 'It was executed; the record names no transaction.'
  return c.outcome === 'refused' || c.outcome === 'blocked' ? 'Nothing: it was refused before anything was sent.' : 'Nothing was executed.'
}
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
/** What reconciled: the venue's record against the ledger, balances re-read from the chain, and the chains that were intact. */
export function reconciledWords(s3: J, s5: J, v: J): string {
  const out: string[] = []
  const recon = Array.isArray(s3.reconciliation) ? (s3.reconciliation as J[]) : []
  if (recon.length) {
    const breaks = recon.filter((r) => r.state === 'break').length
    out.push(breaks ? `The venue's record differs from the ledger for ${breaks} of ${recon.length}.` : recon.every((r) => r.state === 'reconciled') ? 'The venue\'s own record agrees with the ledger.' : 'Nothing reached a venue, so there was nothing to compare.')
  } else if (Array.isArray(s5.balances) && (s5.balances as J[]).some((b) => /re-read from the chain/.test(String(b.source ?? '')))) out.push('The balances were re-read from the chain after the transaction.')
  const rc = v.receiptChain?.server, led = v.ledger, vd = v.vaultDecisions?.server
  const intact = [rc?.ok ? `the receipt chain (${rc.count} receipt${rc.count === 1 ? '' : 's'})` : '', led && Array.isArray(led.breaks) && !led.breaks.length ? 'the ledger' : '', vd?.ok ? `the wallet's decision records (${vd.records})` : ''].filter(Boolean)
  const broken = [rc && !rc.ok ? `the receipt chain is broken at no. ${String(rc.brokenAt)}` : '', led && Array.isArray(led.breaks) && led.breaks.length ? `the ledger shows ${led.breaks.length} break${led.breaks.length === 1 ? '' : 's'}` : '', vd && !vd.ok ? `the wallet's decision records are broken at no. ${String(vd.brokenAt)}` : ''].filter(Boolean)
  if (intact.length) out.push(`${upperFirst(andList(intact))} ${intact.length === 1 ? 'was' : 'were'} intact when the case was assembled.`)
  if (broken.length) out.push(`${upperFirst(andList(broken))}.`)
  return out.join(' ') || 'Nothing was reconciled: nothing was executed.'
}

// ------------------------------------------------------------------------------------------------ the list

/** The kinds of evidence, in the owner's terms, so that none is read as another; each counts its cases and narrows to them. */
type KindKey = 'local-chain' | 'ephemeral-chain' | 'paper' | 'scripted'
const KINDS: { key: KindKey; word: string; says: string; of: (c: CaseSummary) => boolean }[] = [
  { key: 'local-chain', word: 'Local test chain', says: 'Executed by this build on a chain on this computer, with test tokens of no value. Re-readable while it runs; not a public network.', of: (c) => c.venue === 'local-chain' },
  { key: 'ephemeral-chain', word: 'Throwaway test chain', says: 'Executed on a chain made for one test and gone since; only its record remains.', of: (c) => c.venue === 'ephemeral-chain' },
  { key: 'paper', word: 'Paper venue', says: 'Simulated: this installation\'s own books. No exchange or bank was reached and no money moved.', of: (c) => c.venue === 'paper' },
  { key: 'scripted', word: 'Scripted test double', says: 'Replies replayed from a fixed file, not a model. It shows what QED\'s controls do with a proposal, not what a model would do.', of: (c) => c.model?.label === 'scripted-test-double' },
]
const HISTORICAL_SAYS = 'Recorded on a public test network on 19 and 20 October, before this build. It does not prove this build.'
type Ended = 'all' | 'ok' | 'void' | 'plain'
const ENDED: [Ended, string][] = [['all', 'Any outcome'], ['ok', 'Completed'], ['void', 'Refused, rejected or failed'], ['plain', 'Other']]
/** A case's words for searching: its title as read, what kind it is, how it ended, where it ran, who proposed it, when. */
export function caseText(c: CaseSummary): string {
  return [readable(c.title), c.title, CASE_KIND[c.kind] ?? c.kind, caseOutcome(c.outcome)[0], executionOf(c.venue).word, proposer(c.model)[0], when(c.at)].join(' \u0001 ').toLowerCase()
}

function KindTiles({ cases, kind, onKind, hist }: { cases: CaseSummary[]; kind: KindKey | null; onKind: (k: KindKey | null) => void; hist: HistoricalEvidence | null }) {
  const shown = KINDS.filter((k) => k.key !== 'ephemeral-chain' || cases.some(k.of))
  return (
    <section className="ac-kinds" aria-labelledby="kinds-h">
      <h2 id="kinds-h" className="ac-kinds-h">Kinds of evidence</h2>
      <ul className="ac-kind-list">
        {shown.map((k) => {
          const count = cases.filter(k.of).length, on = kind === k.key
          return (
            <li key={k.key}>
              <button type="button" className={`tile ac-kind ac-kind-${k.key}`} aria-pressed={on} onClick={() => onKind(on ? null : k.key)}>
                <span className="ac-kind-word">{k.word}</span>
                <span className="ac-kind-n">{count}<small>{count === 1 ? 'case' : 'cases'}</small></span>
                <span className="ac-kind-says">{k.says}</span>
                <span className="ac-kind-act">{on ? 'Showing only these; press to show all' : count ? 'Show only these' : 'None in this list'}</span>
              </button>
            </li>
          )
        })}
        <li>
          <a className="tile ac-kind ac-kind-historical" href="#hist">
            <span className="ac-kind-word">Historical</span>
            <span className="ac-kind-n">{hist ? hist.counts.inManifests.transactions : '…'}<small>transactions</small></span>
            <span className="ac-kind-says">{HISTORICAL_SAYS}</span>
            <span className="ac-kind-act">Read the record, below</span>
          </a>
        </li>
      </ul>
    </section>
  )
}

export function EvidenceListScreen() {
  const d = useData<{ cases: CaseSummary[]; vault: { available: boolean; reason?: string } }>('/api/evidence/cases', ['action', 'run', 'vault'])
  // a household with no wallet has no wallet cases; the service being unreachable is said only when there is one to reach
  const wallet = useData<{ available?: boolean; setUp?: boolean }>('/api/vault', ['vault'])
  const hist = useData<HistoricalEvidence>('/api/evidence/historical')
  const noWallet = wallet.data?.available !== false && wallet.data?.setUp === false
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<KindKey | null>(null)
  const [ended, setEnded] = useState<Ended>('all')
  const searchId = useId()
  const toggle = (id: string) => setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x })
  const head = <ActivityHead at="evidence" title="Evidence" actions={<Link to="/judge" className="btn"><Route aria-hidden="true" />Follow one decision, end to end</Link>}>Each case is one thing QED did or refused, assembled from its own records: what happened, who decided, what checked it, what executed and what reconciled, then the technical record behind each answer. Download any case and check it on your own computer.</ActivityHead>
  if (!d.data) return <div className="ac">{head}{d.error ? <div className="ac-problem"><Problem error={d.error} /><Btn small onClick={d.reload}>Try again</Btn></div> : <div className="panel ac-cases" aria-busy="true"><p className="loading-line">Assembling the evidence…</p><span className="skel ac-cases-skel" /><span className="skel ac-cases-skel" /></div>}<Historical h={hist} /></div>
  const all = d.data.cases
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const kindOf = KINDS.find((k) => k.key === kind)
  const narrowed = kind !== null || ended !== 'all' || terms.length > 0
  const found = all.filter((c) => (!kindOf || kindOf.of(c)) && (ended === 'all' || caseOutcome(c.outcome)[1] === ended) && (!terms.length || terms.every((t) => caseText(c).includes(t))))
  const groups = groupCases(found)
  const clear = () => { setKind(null); setEnded('all'); setQ('') }
  return (
    <div className="ac">
      {head}
      {!d.data.vault.available && !noWallet ? <Note tone="wait" title="The on-chain wallet service is not reachable">Cases of on-chain operations appear when it is running. {d.data.vault.reason ?? ''}</Note> : null}
      {all.length === 0 ? (
        <div className="empty-state">
          <span className="glyph"><FileSearch aria-hidden="true" /></span>
          <h2>No case yet</h2>
          <p>A case appears for each run of a standing instruction, each question to Ask, and each operation of the on-chain wallet.</p>
        </div>
      ) : <>
        <KindTiles cases={all} kind={kind} onKind={setKind} hist={hist.data} />
        <section className="panel ac-cases" aria-labelledby="cases-h">
          <div className="panel-head ac-cases-head"><h2 id="cases-h">Cases</h2><p>{all.length} case{all.length === 1 ? '' : 's'}, newest first</p></div>
          <form className="ac-cases-find" role="search" aria-label="Find a case" onSubmit={(e) => e.preventDefault()}>
            <div className="ac-search">
              <label htmlFor={searchId}>Search the cases</label>
              <div className="ac-search-box">
                <Search aria-hidden="true" />
                <input id={searchId} type="search" className="input" value={q} placeholder="What was done, an outcome" autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
                {q ? <button type="button" className="icon-btn ac-search-clear" aria-label="Clear the search" onClick={() => setQ('')}><X aria-hidden="true" /></button> : null}
              </div>
            </div>
            <div className="ac-ended">
              <span className="ac-ended-k" id={`${searchId}-ended`}>How it ended</span>
              <div className="seg" role="group" aria-labelledby={`${searchId}-ended`}>
                {ENDED.map(([v, w]) => <button key={v} type="button" aria-pressed={ended === v} onClick={() => setEnded(v)}>{w}</button>)}
              </div>
            </div>
            <p className="ac-count" aria-live="polite">{narrowed ? <>Showing {found.length} of {all.length} cases{kindOf ? `, ${kindOf.word.toLowerCase()} only` : ''}. <button type="button" className="linkish" onClick={clear}>Show all</button></> : `${all.length} case${all.length === 1 ? '' : 's'}`}</p>
          </form>
          {groups.length === 0 ? <div className="ac-cases-none"><p>No case matches{q.trim() ? ` “${q.trim()}”` : ''}{kindOf ? ` among the ${kindOf.word.toLowerCase()} cases` : ''}.</p><Btn small onClick={clear}>Show all</Btn></div> : (
            <div className="ac-cases-scroll">
              <table className="ledger ac-cases-table bleed">
                <thead><tr><th scope="col">What</th><th scope="col" className="wide-only">Outcome</th><th scope="col" className="wide-only">Where</th><th scope="col" className="wide-only">Proposed by</th><th scope="col" className="wide-only">Authority</th><th scope="col" className="ac-case-when wide-only">When</th></tr></thead>
                <tbody>
                  {groups.map(({ lead: c, all: alike }) => {
                    const o = caseOutcome(c.outcome), p = proposer(c.model), x = executionOf(c.venue)
                    const many = alike.length > 1, shown = open.has(c.id)
                    const oldest = alike[alike.length - 1]!
                    return (
                      <Fragment key={c.id}>
                        <tr className={many ? 'is-group' : ''}>
                          <td className="ac-case-what"><Link to={`/evidence/${encodeURIComponent(c.id)}`}>{readable(c.title)}</Link>
                            <span className="sub">{CASE_KIND[c.kind] ?? c.kind}{many ? `. The latest of ${alike.length} alike` : ''}</span>
                            <span className="sub narrow-only ac-case-narrow"><Stamp tone={o[1]}>{o[0]}</Stamp><span>{x.word}</span><span>{when(c.at)}</span></span>
                            {many ? <button type="button" className="linkish ac-more" aria-expanded={shown} onClick={() => toggle(c.id)}>{shown ? 'Hide the others' : `Show each of the ${alike.length}`}</button> : null}
                          </td>
                          <td className="wide-only"><Stamp tone={o[1]}>{o[0]}</Stamp></td>
                          <td className="wide-only small">{x.word}<span className="sub">{c.venue === 'local-chain' ? 'This build; re-readable' : c.venue === 'paper' ? 'Simulated' : c.venue === 'ephemeral-chain' ? 'Gone; record only' : ''}</span></td>
                          <td className="wide-only small">{p[1] === 'plain' ? <>No model<span className="sub">deterministic rules</span></> : p[1] === 'wait' ? <>Scripted test double<span className="sub">replayed; not a model</span></> : <span className={`chip ${p[1]}`}>{p[0]}</span>}</td>
                          <td className="wide-only small">{c.kind === 'model-call' ? 'None: a question grants none' : c.standingAuthority ? 'Standing, signed earlier' : 'Your fresh signature'}</td>
                          <td className="date ac-case-when wide-only">{when(c.at)}{many ? <span className="sub">from {when(oldest.at)}</span> : null}</td>
                        </tr>
                        {many && shown ? alike.map((y, i) => (
                          <tr key={y.id} className="member">
                            <td colSpan={6}><Link to={`/evidence/${encodeURIComponent(y.id)}`}>{`Case ${alike.length - i} of ${alike.length}, ${when(y.at)}`}</Link></td>
                          </tr>
                        )) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>}
      <Historical h={hist} />
    </div>
  )
}

/**
 * R7-098: what the QED team recorded on a public test network on 19 and 20 October, before this build existed, read
 * from the vendored release and labelled historical everywhere. Not re-verified here (that needs a public node, an
 * owner decision); each transaction links to the public explorer for anyone who wants to check it there.
 */
function Historical({ h }: { h: { data: HistoricalEvidence | null; error: Parameters<typeof Problem>[0]['error']; reload: () => void } }) {
  if (!h.data) return <section id="hist" className="panel ac-hist" aria-labelledby="hist-h" aria-busy={!h.error}><div className="panel-head"><h2 id="hist-h">Recorded before this build: 19 and 20 October</h2></div>{h.error ? <div className="ac-problem"><Problem error={h.error} /><Btn small onClick={h.reload}>Try again</Btn></div> : <p className="loading-line">Reading the recorded transactions…</p>}</section>
  const d = h.data
  const runs = [...new Set(d.transactions.map((t) => t.run))]
  return (
    <section id="hist" className="panel ac-hist" aria-labelledby="hist-h">
      <div className="panel-head"><h2 id="hist-h">Recorded before this build: 19 and 20 October</h2><p>Historical, on {d.network}</p></div>
      <div className="ac-hist-top">
        <Note tone="wait" title="Historical, not made by this build">{readable(d.note)}</Note>
        <dl className="ac-hist-figs">
          <div><dt>Transactions</dt><dd>{d.counts.inManifests.transactions}</dd></div>
          <div><dt>Runs</dt><dd>{runs.length}</dd></div>
          <div><dt>Reverted</dt><dd>{d.counts.inManifests.reverted}</dd></div>
          <div><dt>Contracts matched</dt><dd>{d.counts.contracts}</dd></div>
        </dl>
      </div>
      <p className="small ac-hist-count">{d.counts.inManifests.transactions} transactions in {runs.length} runs, as the runs' own manifests count them ({d.counts.inManifests.reverted} reverted); {d.counts.transactions} of them are named steps, listed below, and the rest deployed and set up the contracts. Of the steps, {d.counts.reverted} reverted, {d.transactions.filter((t) => t.status === 'reverted' && t.expect === 'revert').length} of them as their test intended (attacks and tampering the contracts were meant to refuse); {d.counts.contracts} contracts whose source code Sourcify matched.{d.excluded.length ? ` ${d.excluded.length === 1 ? 'One file' : `${d.excluded.length} files`} of the record ${d.excluded.length === 1 ? 'is' : 'are'} left out, each for the reason given with it at the end of the list.` : ''}</p>
      <div className="ac-hist-runs">
        {runs.map((run) => {
          const txs = d.transactions.filter((t) => t.run === run)
          return (
            <details key={run} className="ac-hist-run">
              <summary>{run}: {txs.length} transactions{txs.some((t) => t.status === 'reverted') ? `, ${txs.filter((t) => t.status === 'reverted').length} reverted` : ''}</summary>
              <div className="ac-cases-scroll"><table className="ledger bleed"><thead><tr><th scope="col">Step</th><th scope="col">Outcome</th><th scope="col" className="wide-only">Block</th><th scope="col">Transaction</th></tr></thead>
                <tbody>{txs.map((t) => <tr key={t.hash}><td>{t.title}</td><td>{t.status === 'reverted' ? (t.expect === 'revert' ? 'Reverted, as its test intended' : 'Reverted, not as intended') : t.expect === 'revert' ? 'Succeeded, though a revert was intended' : 'Succeeded'}</td><td className="wide-only">{t.block}</td><td><a href={`${d.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer noopener"><span className="code">{fmt.hash(t.hash)}</span></a></td></tr>)}</tbody>
              </table></div>
            </details>
          )
        })}
        {d.excluded.length ? <details className="ac-hist-run"><summary>The files left out, and why</summary><ul className="ac-list small">{d.excluded.map((x) => <li key={x}>{x}</li>)}</ul></details> : null}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ one case

/**
 * Recompute every hash the case states, here in the browser, with the same canonical JSON as the server. Also used by the
 * judge's walk-through (Judge.tsx), for this household's cases and for cases recorded earlier and read from their files.
 */
export function checkHashes(c: Case): { ok: boolean; lines: [string, boolean][] } {
  const h = (v: unknown) => sha256(canonical(v))
  const lines: [string, boolean][] = Object.keys(c.hashes.sections).sort().map((k) => [`Section ${k}`, h(c.sections[k]) === c.hashes.sections[k]])
  lines.push(['Verification', h(c.verification) === c.hashes.verification], ['Redactions', h(c.redactions) === c.hashes.redactions], ['What it cannot prove', h(c.cannotProve) === c.hashes.cannotProve])
  const root = h({ format: c.format, id: c.id, kind: c.kind, title: c.title, outcome: c.outcome, venue: c.venue, workspace: c.workspace, assembledAt: c.assembledAt, sections: c.hashes.sections, verification: c.hashes.verification, redactions: c.hashes.redactions, cannotProve: c.hashes.cannotProve })
  lines.push(['Root', root === c.hashes.root])
  return { ok: lines.every(([, v]) => v), lines }
}

/** A long finding shows its first lines; the rest is one press away and always in the page for a screen reader. */
function Clamped({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > 220
  return <span className={`ac-clamp ${long && !all ? 'cut' : ''}`}><span className="ac-clamp-text">{text}</span>{long ? <button type="button" className="linkish ac-clamp-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show less' : 'Show all of it'}</button> : null}</span>
}

/** The checks that failed first, then those that passed, each in the order the record gives them. */
export const orderChecks = <T extends { pass?: unknown }>(checks: T[]): T[] => [...checks.filter((k) => !k.pass), ...checks.filter((k) => k.pass)]

/** Many checks: the ones that failed first, then the first few that passed; the rest one press away. */
function CheckList({ checks }: { checks: J[] }) {
  const [all, setAll] = useState(false)
  const ordered = orderChecks(checks)
  const FIRST = 5
  const shown = all ? ordered : ordered.slice(0, Math.max(FIRST, checks.filter((k) => !k.pass).length))
  return (
    <>
      <ul className="ac-checks">{shown.map((k, i) => (
        <li key={i} className={k.pass ? 'pass' : 'fail'}>
          <span className="mark" aria-hidden="true">{k.pass ? <Check /> : <X />}</span>
          <span><span className="sr">{k.pass ? 'Passed: ' : 'Failed: '}</span><strong>{checkWords(String(k.name))}</strong>{k.by ? <span className="muted">, checked by {plainBy(String(k.by))}</span> : null}{k.detail ? <span className="ac-check-detail"><Clamped text={readable(String(k.detail))} /></span> : null}</span>
        </li>
      ))}</ul>
      {ordered.length > shown.length || all ? <button type="button" className="linkish ac-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show fewer checks' : `Show the other ${ordered.length - shown.length} checks`}</button> : null}
    </>
  )
}

const RELATED: Record<string, string> = { 'policy-tick': 'A tick of the standing policy', 'policy-run': 'A run of the standing policy', 'cosigner-policy-trade': 'The co-signer, on a conversion the policy proposed' }
/** Related refusals by what was refused, in the order each kind first appears, each kind's cases newest first. */
export function groupRelated<T extends { what?: unknown; title?: unknown; at?: unknown }>(related: T[]): { key: string; items: T[] }[] {
  const time = (r: T): number => Date.parse(String(r.at ?? '')) || 0
  const groups: { key: string; items: T[] }[] = []
  for (const r of related) {
    const key = String(r.what ?? r.title ?? '')
    const g = groups.find((x) => x.key === key)
    if (g) g.items.push(r); else groups.push({ key, items: [r] })
  }
  return groups.map((g) => ({ key: g.key, items: [...g.items].sort((a, b) => time(b) - time(a)) }))
}

/** Related refusals of one kind are one line: how many, over what time, the latest one linked and every one a press away. */
function RelatedRefusals({ related }: { related: J[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const name = (k: string): string => RELATED[k] ?? readable(k.replace(/[-_]/g, ' ')).replace(/^./, (c) => c.toUpperCase())
  return (
    <ul className="ac-related">
      {groupRelated(related).map(({ key, items: sorted }) => {
        const latest = sorted[0]!, oldest = sorted[sorted.length - 1]!
        const failing = Array.isArray(latest.failed) && latest.failed[0] ? String(latest.failed[0].name ?? '') : String(latest.failing ?? '')
        const shown = open.has(key)
        return (
          <li key={key}>
            <p><strong>{name(key)}</strong>{sorted.length > 1 ? `: refused ${sorted.length} times, from ${when(oldest.at)} to ${when(latest.at)}` : `: refused ${when(latest.at)}`}{failing ? <span className="muted"> ({lowerFirst(checkWords(failing))})</span> : null}.</p>
            <div className="row">
              {latest.caseId ? <Link to={`/evidence/${encodeURIComponent(String(latest.caseId))}`}>{sorted.length > 1 ? 'The latest case' : 'Its case'}</Link> : null}
              {sorted.length > 1 ? <button type="button" className="linkish ac-more" aria-expanded={shown} onClick={() => setOpen((s0) => { const x = new Set(s0); if (x.has(key)) x.delete(key); else x.add(key); return x })}>{shown ? 'Hide them' : `Show each of the ${sorted.length}`}</button> : null}
            </div>
            {shown ? <ul className="ac-related-each">{sorted.map((r, k) => <li key={k}>{r.caseId ? <Link to={`/evidence/${encodeURIComponent(String(r.caseId))}`}>{when(r.at)}</Link> : when(r.at)}</li>)}</ul> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** One numbered section of the record: its finding in words, then its exact record and hash one press away. */
function Step({ n, s, hash, kind, children }: { n: string; s: J; hash: string; kind?: string; children?: ReactNode }) {
  return (
    <li className="ac-step">
      <span className="ac-step-n" aria-hidden="true">{n}</span>
      <div className="ac-step-body">
        <h3 id={`ev-${n}`}><span className="sr">Section {n}: </span>{s.title ?? `Section ${n}`}{kind ? <span className="ac-step-kind">{kind}</span> : null}</h3>
        {s.statement ? <p className="ac-step-statement">{readable(String(s.statement))}</p> : null}
        {children}
        <details className="ac-tech"><summary>Technical detail for section {n}</summary>
          <p className="small faint">SHA-256 <span className="code">{hash}</span></p>
          <pre className="doc">{JSON.stringify(s, null, 1)}</pre>
        </details>
      </div>
    </li>
  )
}

/** What moved, as one sentence: each amount, from where, to where. */
function movedText(s5: J): string | null {
  const moved = Array.isArray(s5.moved) ? (s5.moved as J[]) : []
  if (!moved.length) return null
  return moved.map((m) => (m.from && m.to ? `${units(m.amount, m.decimals ?? 0, m.asset ?? '')} from ${m.from} to ${m.to}` : readable(String(m.text ?? m.what ?? '')))).join('; ')
}

export function EvidenceCaseScreen({ id }: { id: string }) {
  const d = useData<Case>(`/api/evidence/cases/${encodeURIComponent(id)}`)
  const narrow = useMedia('(max-width: 759px)')
  const [check, setCheck] = useState<ReturnType<typeof checkHashes> | null>(null)
  const crumb = <Crumb to="/evidence">All evidence</Crumb>
  if (!d.data) return d.error
    ? <div className="case-page">{crumb}<div className="ac-problem"><Problem error={d.error} /><p><Link to="/evidence">All evidence</Link></p></div></div>
    : <div className="case-page" aria-busy="true">{crumb}<p className="loading-line">Assembling this case…</p><span className="skel ac-case-skel" /></div>
  const c = d.data, S = c.sections
  const o = caseOutcome(c.outcome), p = proposer(S['2']), x = executionOf(c.venue)
  const s1 = S['1'] ?? {}, s2 = S['2'] ?? {}, s3 = S['3'] ?? {}, s4 = S['4'] ?? {}, s5 = S['5'] ?? {}, s6 = S['6'] ?? {}, s7 = S['7'] ?? {}, s8 = S['8'] ?? {}
  const checks = (s3.checks ?? []) as J[]
  const failed = checks.filter((k) => !k.pass)
  const refusals = Array.isArray(s8.thisCase) ? (s8.thisCase as J[]) : []
  const moved = movedText(s5)
  const objective = s1.objective?.text ? String(s1.objective.text) : null
  const signedText = !!objective && objective.includes('\n')
  const txs = Array.isArray(s6.transactions) ? (s6.transactions as J[]) : []
  const auth = authorityLine(s4)
  const probes = Array.isArray(s7.probes) ? (s7.probes as J[]) : []
  return (
    <div className="case-page">
      {crumb}
      <header className="ac-doc-head">
        <div className="ac-doc-title">
          <h1>{readable(c.title)}</h1>
          <p>{CASE_KIND[c.kind] ?? c.kind}. Assembled {when(c.assembledAt)} from this workspace's own records.</p>
        </div>
        <div className="ac-tags"><Stamp big tone={o[1]}>{o[0]}</Stamp><span className="chip">{x.word}</span><span className={`chip ${p[1]}`}>{p[0]}</span></div>
      </header>

      <div className="ac-pair ac-case-top">
        <section className="panel ac-reading" aria-labelledby="brief-h">
          <div className="panel-head"><h2 id="brief-h">The case in one reading</h2><p>{x.says}</p></div>
          <dl className="ac-brief">
            <div className="lead"><dt>What happened</dt><dd>{whatHappened(c.outcome, moved, s5.consequence ? String(s5.consequence) : null)}</dd></div>
            <div><dt>Who decided</dt><dd>{s2.statement ? readable(String(s2.statement)) : p[0]} {s4.statement ? readable(String(s4.statement)) : auth ?? 'Nothing ran, so no authority was used.'}</dd></div>
            <div><dt>What checked it</dt><dd>{checks.length ? <>{checks.length - failed.length} of {checks.length} independent checks passed{failed.length ? <span className="void">; {failed.length === 1 ? 'one' : failed.length} did not pass: {failed.map((k) => { const nm = String(k.name), m = /^.+: ([a-z][a-z0-9-]*)$/.exec(nm); return lowerFirst(checkWords(m ? m[1]! : nm)) }).join('; ')}</span> : null}.</> : 'No check is recorded.'}{refusals.length ? <span className="void"> Refused by {refusals[0]!.by ? plainBy(String(refusals[0]!.by)) : refusals[0]!.check ? lowerFirst(checkWords(String(refusals[0]!.check))) : 'a check'}.</span> : null}</dd></div>
            <div><dt>What executed</dt><dd>{executedWords(c, s5, s6)}</dd></div>
            <div><dt>What reconciled</dt><dd>{reconciledWords(s3, s5, c.verification)}</dd></div>
          </dl>
        </section>

        <section className="panel ac-proof" aria-labelledby="proof-h">
          <div className="panel-head"><h2 id="proof-h">Check it yourself</h2><p>The record, reproduced: here in this browser, or on your own computer</p></div>
          <div className="ac-proof-here">
            <p className="ac-proof-k">Checked here, now</p>
            <div className="row"><Btn tone="fill" onClick={() => setCheck(checkHashes(c))}>Check its hashes here</Btn><a className="btn" href={`/api/evidence/cases/${encodeURIComponent(c.id)}/export`} download><Download aria-hidden="true" />Download this case</a></div>
            {check ? (
              <div className="ac-checked" role="status">
                {check.ok ? <Seal size="lg" live label="Every hash matches" /> : <X aria-hidden="true" />}
                <Note tone={check.ok ? 'ok' : 'void'} title={check.ok ? 'Every hash matches, recomputed in this browser' : 'A hash does not match'}>{check.lines.filter(([, v]) => !v).map(([k]) => k).join(', ') || `${check.lines.length} of ${check.lines.length} parts match their stated SHA-256, and the root ${short(c.hashes.root)} matches.`} This checks that the file is intact as served; the offline verifier also checks every signature, the receipt chain and, with the chain running, each transaction.</Note>
              </div>
            ) : <p className="small muted">The hashes are recomputed here, in this browser, from the case as it arrived: nothing is taken on the server's word.</p>}
          </div>
          <div className="ac-proof-kind">
            <p className="ac-proof-k">What kind of evidence this is</p>
            <p><strong>{x.word}</strong>. {x.says}.</p>
            <p><strong>{p[0]}</strong>{p[1] === 'wait' ? '. Its replies were replayed from a fixed file: this case shows what QED\'s controls do, not what a model would do.' : p[1] === 'plain' ? '. Fixed rules decided; no model took part.' : '.'}</p>
          </div>
          <details className="ac-offline"><summary>Verify it yourself, offline</summary>
            <p className="small">Download the case, then in <span className="code">apps/qed-demo</span>:</p>
            <pre className="doc">node scripts/verify-evidence.ts qed-evidence-{c.id}.json{c.venue === 'local-chain' ? ' --rpc http://127.0.0.1:8546' : ''}</pre>
            <p className="small muted">It re-implements every hash, checks each passkey signature, the receipt chain and that figures agree across sections, and with <span className="code">--rpc</span> re-reads each transaction from the chain while it runs. Add <span className="code">--root</span> and a root, or <span className="code">--head</span> and a receipt-chain head, that you obtained another way, to compare the case with them. Root: <span className="code">{c.hashes.root}</span></p>
            <p className="small muted">The case's own title, exactly as recorded: {c.title}</p>
            <p className="small muted">What it cannot prove and what was left out, exactly as recorded, with the files, commands and register entries they cite:</p>
            <pre className="doc">{[...c.cannotProve, ...c.redactions.map((r) => `${r.what}: ${r.how}. ${r.why}`)].join('\n')}</pre>
          </details>
        </section>
      </div>

      <section className="panel ac-record" aria-labelledby="steps-h">
        <div className="panel-head"><h2 id="steps-h">The record, section by section</h2><p>Each as recorded when it happened, except where marked</p></div>
        <ol className="ac-steps">
          <Step n="1" s={s1} hash={c.hashes.sections['1'] ?? ''}>
            {objective ? (signedText
              ? <><blockquote className="ac-quote">{objective.split('\n')[0]}</blockquote><details className="ac-inline"><summary>The exact text that was signed</summary><pre className="doc">{objective}</pre></details></>
              : <blockquote className="ac-quote">{readable(objective)}</blockquote>) : null}
            {Array.isArray(s1.instruments) && s1.instruments.length ? <ul className="ac-list">{(s1.instruments as J[]).map((i, k) => <li key={k}><strong>{String(i.kind).replace(/-/g, ' ')}</strong>{i.expiresAt ? <span className="muted"> until {when(i.expiresAt)}</span> : null}{Array.isArray(i.limits) && i.limits.length ? <span className="muted">: {(i.limits as J[]).map((l) => readable(String(l.text ?? `${l.name} ${l.value}`))).join('; ')}.</span> : null}{Array.isArray(i.signatures) ? <span className="muted"> Signed with a passkey ({i.signatures.length} signature{i.signatures.length === 1 ? '' : 's'}).</span> : null}</li>)}</ul> : null}
          </Step>
          <Step n="2" s={s2} hash={c.hashes.sections['2'] ?? ''} kind={p[1] === 'wait' ? 'Replayed, not a model' : undefined}>
            {s2.call ? <p className="small muted">Recorded as provider “{String(s2.call.provider)}”, model “{String(s2.call.model)}”.</p> : null}
            {s2.withheld ? <p className="small muted">{readable(String(s2.withheld))}</p> : null}
            {s2.selected?.rationale ? <blockquote className="ac-quote">{String(s2.selected.rationale)}</blockquote> : null}
            {Array.isArray(s2.validation) && s2.validation.length ? <ul className="ac-list">{(s2.validation as J[]).map((v, k) => <li key={k}>{v.title ?? v.kind ?? `Proposal ${k + 1}`}: <span className={v.valid === false || v.state === 'invalid' ? 'void' : 'ok'}>{v.state ? PROPOSAL_STATE[String(v.state)] ?? String(v.state) : v.valid === false ? 'not valid' : 'valid'}</span>{v.reason ?? v.invalidReason ? <span className="muted"> ({readable(String(v.reason ?? v.invalidReason))})</span> : null}</li>)}</ul> : null}
          </Step>
          <Step n="3" s={s3} hash={c.hashes.sections['3'] ?? ''}>
            {checks.length ? <CheckList checks={checks} /> : null}
          </Step>
          <Step n="4" s={s4} hash={c.hashes.sections['4'] ?? ''}>
            {auth || s4.requestedBy?.who ? <p>{auth ? <strong>{auth}</strong> : null}{s4.requestedBy?.who ? `${auth ? ' ' : ''}Asked for by ${String(s4.requestedBy.who)}.` : ''}</p> : null}
            {Array.isArray(s4.ranUnder) && s4.ranUnder.length ? <ul className="ac-list">{(s4.ranUnder as J[]).map((r, k) => <li key={k}>{String(r.kind).replace(/-/g, ' ')} <span className="muted">signed {when(r.signedAt)}</span></li>)}</ul> : null}
          </Step>
          <Step n="5" s={s5} hash={c.hashes.sections['5'] ?? ''}>
            {Array.isArray(s5.moved) && s5.moved.length ? <ul className="ac-list">{(s5.moved as J[]).map((m, k) => <li key={k}>{m.text ? readable(String(m.text)) : `${readable(String(m.what))}: ${units(m.amount, m.decimals ?? 0, m.asset ?? '')}`}{m.from && m.to ? <span className="muted">, from {String(m.from)} to {String(m.to)}</span> : null}</li>)}</ul> : nothingMovedLine(s5.consequence ? String(s5.consequence) : null) ? <p className="muted">Nothing moved.</p> : null}
            {Array.isArray(s5.balances) && s5.balances.length && narrow ? <ul className="ac-bal-list">{(s5.balances as J[]).map((b, k) => <li key={k}><p className="ac-bal-acct">{String(b.account)}</p><dl><div><dt>Before</dt><dd>{units(b.before, b.decimals, b.asset)}</dd></div><div><dt>After</dt><dd>{units(b.after, b.decimals, b.asset)}</dd></div><div><dt>Change</dt><dd>{units(b.delta, b.decimals, b.asset)}</dd></div></dl></li>)}</ul> : null}
            {Array.isArray(s5.balances) && s5.balances.length && !narrow ? <div className="ac-cases-scroll" tabIndex={0} role="region" aria-label="Balances before and after; scroll sideways on a narrow screen"><table className="ledger ac-balances flush"><thead><tr><th scope="col">Account</th><th scope="col" className="num">Before</th><th scope="col" className="num">After</th><th scope="col" className="num">Change</th></tr></thead><tbody>{(s5.balances as J[]).map((b, k) => <tr key={k}><td>{String(b.account)}</td><td className="num">{units(b.before, b.decimals, b.asset)}</td><td className="num">{units(b.after, b.decimals, b.asset)}</td><td className="num">{units(b.delta, b.decimals, b.asset)}</td></tr>)}</tbody></table></div> : null}
            {s5.consequence ? <p className="small"><Clamped text={readable(String(s5.consequence))} /></p> : null}
          </Step>
          <Step n="6" s={s6} hash={c.hashes.sections['6'] ?? ''}>
            <dl className="kv small">
              {s6.revision ? <><dt>QED's code</dt><dd>Revision {String(s6.revision.commit ?? '').slice(0, 7)}{s6.revision.uncommittedChanges ? <span className="wait">, with changes not yet committed</span> : null}</dd></> : null}
              {s6.chain ? <><dt>Chain</dt><dd>{s6.chain.chainId === 31337 ? 'A local test chain on this computer; not publicly verifiable' : `Chain ${String(s6.chain.chainId)}`}</dd></> : null}
              {txs.length ? <><dt>Transactions</dt><dd>{txs.filter((t) => t.status === 'success').length} of {txs.length} succeeded{txs.some((t) => t.block) ? `, in block ${[...new Set(txs.map((t) => String(t.block ?? '')).filter(Boolean))].join(', ')}` : ''}; each hash is in the technical detail below</dd></> : null}
            </dl>
          </Step>
          <Step n="7" s={s7} hash={c.hashes.sections['7'] ?? ''} kind={probes.length ? 'Probes re-run when the case was assembled' : undefined}>
            {s7.note ? <p className="small">{readable(String(s7.note))}</p> : null}
            {probes.length ? <ul className="ac-list">{probes.map((q, k) => <li key={k}>{readable(String(q.question ?? ''))} <span className={q.answer?.allowed ? 'ok' : 'void'}>{q.answer?.allowed ? 'Allowed' : 'Refused'}</span>{Array.isArray(q.answer?.failed) && q.answer.failed.length ? <span className="muted">: {(q.answer.failed as J[]).map((f) => `${lowerFirst(checkWords(String(f.name)))}, ${readable(String(f.detail ?? ''))}`).join('; ')}</span> : null}</li>)}</ul> : null}
          </Step>
          <Step n="8" s={s8} hash={c.hashes.sections['8'] ?? ''}>
            {refusals.length ? <ul className="ac-list">{refusals.map((r, k) => <li key={k} className="void">{r.rule ?? r.name ?? r.check ? checkWords(String(r.rule ?? r.name ?? r.check)) : 'Refused'}{r.detail ? <span className="muted">: <Clamped text={readable(String(r.detail))} /></span> : null}</li>)}</ul> : <p className="muted">Nothing in this case was refused.</p>}
            {Array.isArray(s8.related) && s8.related.length ? <><p className="small muted">Related refusals, each its own case:</p><RelatedRefusals related={s8.related as J[]} /></> : null}
          </Step>
        </ol>
      </section>

      <div className="ac-pair even">
        <section className="panel ac-limit" aria-labelledby="cp-h"><h2 id="cp-h">What this case cannot prove</h2><ul className="ac-list">{c.cannotProve.map((t, k) => <li key={k}>{readable(t)}</li>)}</ul></section>
        <section className="panel ac-limit" aria-labelledby="rd-h"><h2 id="rd-h">What was left out, and why</h2><ul className="ac-list">{c.redactions.map((r, k) => <li key={k}><strong>{readable(r.what)}</strong>: {readable(r.how)}. <span className="muted">{readable(r.why)}</span></li>)}</ul></section>
      </div>
    </div>
  )
}
