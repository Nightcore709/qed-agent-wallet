/**
 * Readiness (R7-088, R7-098): what this build is and what it derives from, and every reason it is not ready for real
 * money, read from the project's own records (the risk register, the requirements register, the evidence on record)
 * each time the page opens. It never shows a ready state while a blocker remains. It opens on the verdict and its four
 * counts as tiles that visibly add up to the server's own total; then each part is a glass panel of rows, in two
 * independent columns ordered by importance, and the open risks across the full width (DESIGN.md "Meridian"). The head
 * is drawn before any of the records are read (M11).
 *
 * The registers are the team's working records; the server says each open risk in plain words, grouped by area, and
 * leaves out (and counts) what concerns only the team's own operations (server/readiness.ts). A register id sits one
 * step down, under the reason it stands behind.
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { fmt, useData } from '../lib/core.ts'
import { Link, Loading, Note, Problem, Stamp, useMasonry } from '../ui/kit.tsx'
import { LegalRoutes } from '../ui/legal-routes.tsx'

type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Unknown'
interface Blocker { kind: 'standing' | 'risk' | 'evidence' | 'requirement'; id: string; title: string; detail: string; severity: Severity; area?: string }
interface Reason { id: string; says: string; severity: Severity; standing: string }
interface AreaView { id: string; title: string; reasons: Reason[] }
interface View {
  ready: boolean; verdict: string; because: string
  build: { revision: string | null; dirty: boolean | null }
  release: { id: string | null; manifestDigest: string | null; files: number | null }
  risks: { open: Record<Severity, number>; total: number; blocking: number; operations: number; undescribed: number; undescribedBlocking: number; areas: AreaView[]; lower: AreaView[] } | null
  requirements: { total: number; met: number; partly: number; notMet: number; blocked: number; operations: number }
  evidence: { file: string; passed: number; failed: number; producedAt: string | null }[]
  blockers: Blocker[]
}

const tone = (s: Severity) => (s === 'Critical' || s === 'High' ? 'void' : 'plain')
const items = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The standing facts and failing runs: each its title with its severity beside it, then what it means. */
function Rows({ items }: { items: Blocker[] }) {
  return (
    <ul className="pr-rd-rows">
      {items.map((b) => (
        <li key={`${b.kind}-${b.id}`}>
          <p className="pr-rd-reason"><span className="pr-rd-t">{b.title}</span><Stamp tone={tone(b.severity)}>{b.severity}</Stamp></p>
          <p className="pr-rd-d">{b.detail}</p>
        </li>
      ))}
    </ul>
  )
}

/** Open risks by area: each reason in plain words with its severity, and the register entry behind it one step down. */
function Areas({ areas }: { areas: AreaView[] }) {
  return (
    <div className="pr-rd-areas">
      {areas.map((a) => (
        <section key={a.id} className="pr-rd-area" aria-labelledby={`ra-${a.id}`}>
          <h3 id={`ra-${a.id}`}>{a.title}</h3>
          <ul className="pr-rd-rows">
            {a.reasons.map((r) => (
              <li key={r.id}>
                <p className="pr-rd-reason"><span className="pr-rd-t">{r.says}</span><Stamp tone={tone(r.severity)}>{r.severity}</Stamp></p>
                <details className="pr-rd-disclose pr-rd-id"><summary>Register entry</summary><p className="pr-rd-d">{r.id}. {r.standing}.</p></details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Requirements by area: what each asks, where it stands in words, and its register id last. */
function Requirements({ list, at }: { list: Blocker[]; at: string }) {
  const areas = [...new Set(list.map((b) => b.area ?? 'Other requirements'))]
  return (
    <div className="pr-rd-reqs">
      {areas.map((area, i) => (
        <section key={area} className="pr-rd-area" aria-labelledby={`${at}-${i}`}>
          <h3 id={`${at}-${i}`}>{area}</h3>
          <ul className="pr-rd-rows">
            {list.filter((b) => (b.area ?? 'Other requirements') === area).map((b) => (
              <li key={b.id}><p className="pr-rd-t">{b.title}</p><p className="pr-rd-d">{b.detail} <span className="pr-rd-rid">{b.id}</span></p></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** A part of the page: its name, a figure on the right, one sentence on what it is, and its rows, on one glass panel. */
function Part({ id, title, aside, note, col, children }: { id: string; title: string; aside?: string; note?: string; col?: 1 | 2; children: ReactNode }) {
  return (
    <section data-col={col} className="panel pr-rd-part" aria-labelledby={id}>
      <div className="pr-rd-head"><h2 id={id}>{title}</h2>{aside ? <span className="pr-rd-aside">{aside}</span> : null}{note ? <p className="pr-rd-note">{note}</p> : null}</div>
      <div className="pr-rd-body">{children}</div>
    </section>
  )
}

export function ReadinessScreen() {
  const r = useData<View>('/api/readiness')
  const board = useMasonry()
  const head = <header className="page-head"><div><h1>Readiness</h1><p>What this build is, what it derives from, and every reason it is not ready for real money. Read from the project's own records each time this page opens.</p></div></header>
  if (!r.data) return <div className="pr pr-rd">{head}{r.error ? <Problem error={r.error} /> : <div className="page-wait"><Loading what="Reading the records" /></div>}</div>
  const v = r.data
  const of = (k: Blocker['kind']) => v.blockers.filter((b) => b.kind === k)
  const reqs = of('requirement')
  const unplaced = of('risk').find((b) => b.id === 'not-yet-described')
  const lower = v.risks ? v.risks.lower.reduce((t, a) => t + a.reasons.length, 0) : 0
  // the four counts the server adds up in its own sentence (server/readiness.ts: standing + blocking risks + failing runs + unmet requirements)
  const figs: [string, number, string][] = [
    ['Standing', of('standing').length, 'what this build is'],
    ['Open risks', v.risks?.blocking ?? 0, 'critical or high'],
    ['Failing evidence', of('evidence').length, `of ${v.evidence.length} runs on record`],
    ['Requirements', reqs.length, `not yet met, ${v.requirements.partly} of them in part`],
  ]
  const total = figs.reduce((t, [, n]) => t + n, 0)
  const req = v.requirements
  // A requirement in a state the register's four counts do not name ("Owner decision", say) is shown under its own words,
  // never counted as met in part: the server says each one's state first in its words.
  const stateOf = (b: Blocker): string => b.detail.split(',')[0]!.trim()
  const unmetOrBlocked = reqs.filter((b) => b.severity === 'High')
  const inPart = reqs.filter((b) => b.severity !== 'High' && stateOf(b) === 'Met in part')
  const others = [...new Set(reqs.filter((b) => b.severity !== 'High' && stateOf(b) !== 'Met in part').map(stateOf))].map((state) => ({ state, list: reqs.filter((b) => b.severity !== 'High' && stateOf(b) === state) }))
  const otherCount = Math.max(0, req.total - req.met - req.partly - req.notMet - req.blocked)
  return (
    <div className="pr pr-rd">
      {head}
      <section className="panel pr-rd-verdict" aria-labelledby="rv-h">
        <h2 id="rv-h" className="sr">Verdict</h2>
        <div className="pr-rd-top">
          <p className="pr-rd-stamp"><X aria-hidden="true" />{v.verdict}</p>
          <p className="pr-rd-why">{v.because}</p>
        </div>
        <dl className="pr-rd-figs">
          {figs.map(([k, n, note], i) => <div key={k} className="tile"><dt>{i ? <span className="pr-rd-op" aria-hidden="true">+</span> : null}{k}</dt><dd className="pr-rd-n">{n}</dd><dd className="pr-rd-fnote">{note}</dd></div>)}
          <div className="tile pr-rd-total"><dt><span className="pr-rd-op" aria-hidden="true">=</span>Blockers in all</dt><dd className="pr-rd-n">{total}</dd><dd className="pr-rd-fnote">each one listed below</dd></div>
        </dl>
        <p className="pr-rd-note">It cannot say "ready" while any blocker remains, and two of them are what this build is: a test build that has not been reviewed by anyone outside this work.</p>
      </section>

      <div className="pr-rd-board board" ref={board}>

      <Part id="rs-h" col={1} title="What it is" aside="True whatever the records say">
        <Rows items={of('standing')} />
      </Part>

      <Part id="rb-h" col={2} title="This build">
        <dl className="pr-rd-kv">
          <div><dt>Revision</dt><dd><span className="code">{v.build.revision ? v.build.revision.slice(0, 12) : 'not known'}</span>{v.build.dirty ? <strong className="void"> with files changed since that revision</strong> : v.build.dirty === false ? ' exactly' : ''}</dd></div>
          <div><dt>Derives from</dt><dd>The approved release <span className="code">{v.release.id ?? 'not known'}</span>{v.release.files ? `, its manifest of ${v.release.files} files` : ''}. Its contracts and engines are copied unchanged and checked against that manifest when the vault service starts.</dd></div>
          <div><dt>The release's own record</dt><dd>Its transactions on the public test network, kept as historical evidence: <Link to="/vault/records">Vault, Records</Link>, shown once a vault is set up (the vault service serves it to a vault).</dd></div>
        </dl>
        {v.release.manifestDigest ? <details className="pr-rd-disclose"><summary>The manifest's fingerprint</summary><p className="small"><span className="code">{v.release.manifestDigest.slice(0, 16)}</span></p></details> : null}
      </Part>

      <Part id="re-h" col={2} title="Evidence on record" aside={items(v.evidence.length, 'run')}>
        {of('evidence').length ? <Rows items={of('evidence')} /> : <p className="pr-rd-d">Every run on record passed its steps ({items(v.evidence.length, 'run')}). A run passing says what it checked, nothing more.</p>}
        {v.evidence.length ? (
          <details className="pr-rd-disclose">
            <summary>Each run, with its steps</summary>
            <div className="pr-rd-table">
              <table className="pr-rd-runs">
                <thead><tr><th scope="col">Run</th><th scope="col" className="num">Passed</th><th scope="col" className="num">Failed</th></tr></thead>
                <tbody>{v.evidence.map((e) => <tr key={e.file}><td><span className="wrap-any">{e.file}</span>{e.producedAt ? <span className="faint small pr-rd-when">{/^\d{4}-\d{2}-\d{2}T/.test(e.producedAt) ? fmt.dayTime(Date.parse(e.producedAt)) : e.producedAt}</span> : null}</td><td className="num">{e.passed}</td><td className={`num ${e.failed ? 'void' : ''}`}>{e.failed}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        ) : null}
      </Part>

      <Part id="rq-h" col={1} title="Requirements not yet met" aside={`${req.met} of ${req.total} met`} note={`From the requirements register.${req.operations ? ` ${items(req.operations, 'requirement')} about the team's own way of working ${req.operations === 1 ? 'is' : 'are'} kept in its register.` : ''}`}>
        <div>
          <div className="pr-rd-bar" role="img" aria-label={`${req.met} met, ${req.partly} in part, ${req.notMet} not met, ${req.blocked} blocked${otherCount ? `, ${otherCount} in another state` : ''}, of ${req.total}`}>
            {([['met', req.met], ['part', req.partly], ['not', req.notMet], ['block', req.blocked], ['other', otherCount]] as const).map(([k, n]) => n > 0 ? <i key={k} className={k} style={{ flexGrow: n }} /> : null)}
          </div>
          <ul className="pr-rd-key" aria-hidden="true"><li><i className="met" />Met <b>{req.met}</b></li><li><i className="part" />In part <b>{req.partly}</b></li><li><i className="not" />Not met <b>{req.notMet}</b></li><li><i className="block" />Blocked on something outside this work <b>{req.blocked}</b></li>{otherCount ? <li><i className="other" />{others.map((o) => o.state).join(', ') || 'Another state'} <b>{otherCount}</b></li> : null}</ul>
        </div>
        {[{ key: 'high', label: 'Not met or blocked', list: unmetOrBlocked }, { key: 'part', label: 'Met in part', list: inPart }, ...others.map((o, i) => ({ key: `other-${i}`, label: o.state, list: o.list }))].map((g) => g.list.length ? <details key={g.key} className="pr-rd-disclose"><summary>{g.label} ({g.list.length})</summary><Requirements list={g.list} at={`rq-${g.key}`} /></details> : null)}
      </Part>
      </div>

      <section className="panel pr-rd-part pr-rd-risks" aria-labelledby="rr-h">
        <div className="pr-rd-head"><h2 id="rr-h">Open risks, critical and high</h2>{v.risks ? <span className="pr-rd-aside">{v.risks.blocking} open, by area</span> : null}
          {v.risks ? <p className="pr-rd-note">From the risk register, open now: {v.risks.open.Critical} critical, {v.risks.open.High} high, {v.risks.open.Medium} medium and {v.risks.open.Low} low{v.risks.open.Unknown ? `, and ${v.risks.open.Unknown} without a stated severity` : ''}. Each is said here in plain words; its register entry is under it.{v.risks.operations ? ` ${items(v.risks.operations, 'item')} about the team's own operations ${v.risks.operations === 1 ? 'is' : 'are'} kept in its register.` : ''}</p> : null}</div>
        <div className="pr-rd-body">
          {v.risks === null ? <div><Note tone="wait">The risk register is not part of this build, so open risks cannot be listed. That is itself a reason it is not ready.</Note></div> : <>
            {v.risks.areas.length ? <Areas areas={v.risks.areas} /> : unplaced ? null : <p className="pr-rd-d">None open.</p>}
            {unplaced ? <div><Note tone="wait" title={unplaced.title}>{unplaced.detail}</Note></div> : null}
            {v.risks.undescribed > v.risks.undescribedBlocking ? <p className="small muted">{items(v.risks.undescribed - v.risks.undescribedBlocking, 'open risk')} of lower severity in the register {v.risks.undescribed - v.risks.undescribedBlocking === 1 ? 'is' : 'are'} not yet described on this page.</p> : null}
            {lower ? <details className="pr-rd-disclose"><summary>Open risks of lower severity ({lower}); they do not block on their own</summary><Areas areas={v.risks.lower} /></details> : null}
          </>}
        </div>
      </section>
      <LegalRoutes />
    </div>
  )
}
