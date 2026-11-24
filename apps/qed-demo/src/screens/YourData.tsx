/**
 * Your data, in Protect (register N-007): take everything QED holds about you as a file; see who used your account over the
 * last year; read what deleting the account does to each table and for how long records are kept, with the source of each
 * period; and ask for the account to be deleted (a passkey confirmation, then a wait you can cancel in). Deleting is refused
 * while money is in flight. It never claims physical erasure: the page says what it does not reach.
 */
import { Download } from 'lucide-react'
import { useState } from 'react'
import { api, fmt, useData, useNow } from '../lib/core.ts'
import { withPasskeyIfAsked } from '../lib/stepup.ts'
import { Btn, Field, Loading, Note, Problem, Stamp, useAction, useSession } from '../ui/kit.tsx'

interface View {
  delayMs: number; deletion: { pending: { id: string; requestedAt: number; effectiveAt: number } | null; erased: { erasedAt: number; retainUntil: number } | null }
  inFlight: string[]; accessLogDays: number
  schedule: { table: string; what: 'deleted' | 'overwritten' | 'kept'; detail: string; period: string | null }[]
  retention: { financialYears: number; logDays: number; sources: { id: string; claim: string; where: string; status: string }[]; backups: string; physical: string }
  accessLog: { ts: number; kind: string; ip: string | null; device: string | null; method: string | null }[]
}
const KIND: Record<string, string> = { 'sign-in': 'Signed in', 'step-up': 'Confirmed with a passkey', export: 'Exported your data', 'deletion-requested': 'Asked to delete the account', 'deletion-cancelled': 'Cancelled the deletion' }
const days = (ms: number): string => { const d = Math.round(ms / 86_400_000); return d >= 1 ? `${d} day${d === 1 ? '' : 's'}` : `${Math.max(1, Math.round(ms / 1000))} seconds` }

export function YourData() {
  const { session } = useSession()
  const now = useNow(30_000)
  const v = useData<View>('/api/data', ['security'])
  const [text, setText] = useState('')
  const [all, setAll] = useState(false)
  const exp = useAction(async () => {
    const x = await api<unknown>('GET', '/api/data/export')
    const url = URL.createObjectURL(new Blob([JSON.stringify(x, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'qed-my-data.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    v.reload()
  })
  const ask = useAction(async () => { await withPasskeyIfAsked(() => api('POST', '/api/data/deletion', { confirm: text }), session.hasPasskey); setText(''); v.reload() })
  const cancel = useAction(async () => { await api('POST', '/api/data/deletion/cancel'); v.reload() })

  const d = v.data
  const log = d ? (all ? d.accessLog : d.accessLog.slice(0, 8)) : []
  return (
    <section className="panel yd" id="data" aria-labelledby="yd-h">
      <header className="yd-head"><h2 id="yd-h">Your data</h2><p>What QED holds about you, who used your account, how long records are kept, and how to delete the account.</p></header>
      {!d ? (v.error ? <><Problem error={v.error} /><Btn small onClick={v.reload}>Try again</Btn></> : <Loading what="Reading your data rights" />) : (
        <>
          <div className="yd-block">
            <h3>Take your data</h3>
            <p className="yd-note">One JSON file with every row QED holds that names you, from every table that does. Secrets such as password hashes and passkey keys are left out, and the file lists them.</p>
            <Btn small busy={exp.busy} onClick={() => void exp.run()}><Download aria-hidden="true" />Download my data (JSON)</Btn>
            <Problem error={exp.error} />
          </div>

          <div className="yd-block">
            <h3>Who used your account, last {d.accessLogDays} days</h3>
            {d.accessLog.length ? (
              <>
                <div className="yd-scroll" tabIndex={0} role="region" aria-label="Access log; scroll sideways on a narrow screen">
                  <table className="ledger yd-table">
                    <caption className="sr">Uses of your account in the last year, newest first</caption>
                    <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">How</th><th scope="col">From</th><th scope="col">Device</th></tr></thead>
                    <tbody>{log.map((e, i) => <tr key={i}><th scope="row">{fmt.full(e.ts)}</th><td>{KIND[e.kind] ?? e.kind}</td><td>{e.method ?? 'Not recorded'}</td><td>{e.ip ?? 'Not recorded'}</td><td>{e.device ?? 'Not recorded'}</td></tr>)}</tbody>
                  </table>
                </div>
                {d.accessLog.length > 8 ? <Btn small tone="quiet" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${d.accessLog.length}`}</Btn> : null}
              </>
            ) : <p className="yd-note">Nothing recorded yet. Sign-ins, passkey confirmations and exports are written here from now on.</p>}
            <p className="yd-note">Where a sign-in came from is sealed under a key of yours. Passkey sign-ins record the device but not the address.</p>
          </div>

          <div className="yd-block">
            <h3>Delete the account</h3>
            {d.deletion.pending ? (
              <>
                <Note tone="wait" title={`Deletion is scheduled for ${fmt.full(d.deletion.pending.effectiveAt)}`}>
                  <p>It is {days(Math.max(0, d.deletion.pending.effectiveAt - now))} away. Until then you can cancel and nothing changes. It is refused if money is still in flight when the time comes.</p>
                </Note>
                <Btn small busy={cancel.busy} onClick={() => void cancel.run()}>Cancel the deletion</Btn>
                <Problem error={cancel.error} />
              </>
            ) : (
              <>
                <p className="yd-note">Deleting needs a confirmation with your passkey, then waits {days(d.delayMs)}, and you can cancel in that time. It signs you out everywhere, removes your sign-in methods, contact details and notices, and overwrites names and notes in the records that stay. Your financial records stay under a pseudonymous id for {d.retention.financialYears} years, as the schedule below says. Paper balances are not paid out.</p>
                {d.inFlight.length ? <Note tone="void" title="Not while money is in flight"><ul className="yd-list">{d.inFlight.map((x) => <li key={x}>{x}</li>)}</ul></Note> : null}
                <Field label="Type delete my account to confirm">{(p) => <input {...p} type="text" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
                <Btn tone="void" small busy={ask.busy} disabled={text !== 'delete my account' || d.inFlight.length > 0} onClick={() => void ask.run()}>Delete my account</Btn>
                <Problem error={ask.error} />
              </>
            )}
          </div>

          <details className="yd-block yd-schedule">
            <summary><h3>Retention schedule: what deleting does to each table</h3></summary>
            <div className="yd-body">
            <ul className="yd-list">
              {d.retention.sources.map((s) => <li key={s.id}><b>{s.id}.</b> {s.claim}. <span className="yd-src">{s.where}. <Stamp tone="plain">{s.status}</Stamp></span></li>)}
              <li>{d.retention.physical}</li>
              <li>{d.retention.backups}</li>
            </ul>
            <div className="yd-scroll" tabIndex={0} role="region" aria-label="Retention schedule; scroll sideways on a narrow screen">
              <table className="ledger yd-table">
                <caption className="sr">What happens to each table that names you when the account is deleted</caption>
                <thead><tr><th scope="col">Table</th><th scope="col">What happens</th><th scope="col">Detail</th><th scope="col">Kept for</th></tr></thead>
                <tbody>{d.schedule.map((r) => <tr key={r.table}><th scope="row">{r.table}</th><td>{r.what === 'kept' ? 'Kept' : r.what === 'deleted' ? 'Deleted' : 'Overwritten'}</td><td>{r.detail}</td><td>{r.period ?? '—'}</td></tr>)}</tbody>
              </table>
            </div>
            </div>
          </details>

          <div className="yd-block">
            <h3>If your data is exposed</h3>
            <p className="yd-note">QED has a written procedure: contain, preserve, scope, tell you without delay, and report to the authorities in the times the rules set (CERT-In: within 6 hours; the Data Protection Board: without delay, then a detailed report within 72 hours, under rules not yet in force and read in the Gazette on 24 Nov 2026). This is not legal advice. It is in <code>docs/BREACH-PROCEDURE.md</code> in the repository. It has not been run: this is a paper build with no real person&rsquo;s data.</p>
          </div>
        </>
      )}
    </section>
  )
}
