/**
 * The dispute pack for one payment (server/dispute-pack.ts): the signed approval, the receipts with their hashes, the
 * timeline, the payee as signed and the paper bank's reference, on one page that prints, and as a JSON download. Every
 * institution in it is simulated, and the page says so at its head.
 */
import { Download, Printer } from 'lucide-react'
import { Fragment } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { confirmWithPasskey } from '../lib/passkey.ts'
import { Btn, Crumb, Link, Loading, Note, Problem, useAction, useSession } from '../ui/kit.tsx'

interface Pack {
  simulated: true; notice: string; reason: string; reasonText: string
  payment: { actionId: string; economicId: string; state: string; amount: string; charge: string; payeeName: string; payeeHandle: string; purpose: string; memo: string | null; origin: string }
  approval: { id: string; docHash: string; method: string | null; confirmedAt: number | null; signatures: { person: string; credentialId: string; signedAt: number }[] } | { instruction: { programId: string; version: number; contentHash: string | null; approvedAt: number | null }; note: string } | null
  receipts: { id: string; seq: number; kind: string; at: number; hash: string; prevHash: string }[]
  receiptChain: { verified: boolean; count: number; brokenAt: number | null }
  timeline: { at: number; iso: string; step: string; detail: string }[]
  pauses: { id: string; scope: string; startedAt: number; releasedAt: number | null; releasedBy: string | null }[]
  jurisdiction: string
  deadlines: { id: string; party: 'you' | 'institution'; label: string; rule: string; dueDate: string | null; text: string; source: string }[]
  escalation: { text: string; source: string }
  draftNotice: { label: string; to: string; subject: string; text: string }
  integrity: { sha256: string }
  payee: { asSigned: { name: string; handle: string; nameCheck: string | null }; now: { name: string; handle: string; addedAt: number; nameCheck: string | null; registeredName: string | null } | null; changedSinceSigned: boolean }
  bank: { rail: string | null; state: string | null; reason: string | null; reference: string | null; sentAt: number | null } | null
  disputes: { id: string; state: string; reason: string; resolution: string | null; openedAt: number }[]
}
function ReleasePause({ id, onDone }: { id: string; onDone: () => void }) {
  const { session } = useSession()
  const release = useAction(async () => { if (!session.stepUpFresh) await confirmWithPasskey(); await api('POST', `/api/dispute-pauses/${id}/release`); onDone() })
  return <><Btn onClick={() => void release.run()} busy={release.busy}>Release the pause</Btn>{release.error ? <Problem error={release.error} /> : null}</>
}
const STATE: Record<string, string> = { open: 'Open', resolved_refund: 'Settled: refunded', resolved_upheld: 'Settled: the payment stands', withdrawn: 'Withdrawn' }

export function DisputePackScreen({ id }: { id: string }) {
  const { data: p, error, reload } = useData<Pack>(`/api/actions/${id}/dispute-pack`, ['action', 'receipt', 'dispute', 'recon'])
  if (error) return <div className="pr dp"><Crumb to={`/record/${id}`}>The payment</Crumb><Problem error={error} /></div>
  if (!p) return <div className="pr dp"><Crumb to={`/record/${id}`}>The payment</Crumb><Loading what="Assembling the dispute pack" /></div>
  const ap = p.approval
  const open = p.pauses.filter((q) => q.releasedAt === null)
  return (
    <div className="pr dp">
      <Crumb to={`/record/${id}`}>The payment</Crumb>
      <div className="page-head"><div><h1>Dispute pack</h1><p>{fmt.money(Number(p.payment.amount), true)} to {p.payment.payeeName}. {p.reasonText}</p></div>
        <div className="dp-acts">
          <a className="btn" href={`/api/actions/${id}/dispute-pack/export`} download><Download aria-hidden="true" />Download as JSON</a>
          <button type="button" className="btn" onClick={() => window.print()}><Printer aria-hidden="true" />Print this page</button>
        </div>
      </div>
      <Note tone="wait" title="Simulated">{p.notice}</Note>

      <section className="panel" aria-labelledby="dp-pause"><div className="panel-head"><h2 id="dp-pause">What QED is doing on this account</h2></div>
        {p.pauses.length === 0 ? <p>QED has not been paused for this payment.</p> : <ul>{p.pauses.map((q) => <li key={q.id}>{q.releasedAt === null
          ? <>Paused since {fmt.dayTime(q.startedAt)}: QED does not make payments on its own on this account until you release the pause. Your own payments still work. <ReleasePause id={q.id} onDone={reload} /></>
          : <>Paused {fmt.dayTime(q.startedAt)}, released {fmt.dayTime(q.releasedAt)}.</>}</li>)}</ul>}
        {open.length ? null : p.pauses.length ? <p>The pause has been released.</p> : null}
      </section>

      <section className="panel" aria-labelledby="dp-dl"><div className="panel-head"><h2 id="dp-dl">Deadlines and where to escalate</h2><p>QED informs. Your bank decides. {p.jurisdiction === 'IN' ? 'India' : p.jurisdiction === 'US' ? 'United States' : p.jurisdiction}.</p></div>
        <dl className="kv">{p.deadlines.map((d) => <Fragment key={d.id}><dt>{d.party === 'you' ? 'You' : 'Your bank'}: {d.label}{d.dueDate ? `, by ${d.dueDate}` : ''}</dt><dd>{d.text} <span className="muted">Source: {d.source}.</span></dd></Fragment>)}
          <dt>If it is not resolved</dt><dd>{p.escalation.text} <span className="muted">Source: {p.escalation.source}.</span></dd></dl>
      </section>

      <section className="panel" aria-labelledby="dp-nt"><div className="panel-head"><h2 id="dp-nt">Draft notice to your bank</h2><p>{p.draftNotice.label}</p></div>
        <pre className="dp-notice" tabIndex={0}>{p.draftNotice.text}</pre>
      </section>

      <section className="panel" aria-labelledby="dp-ap"><div className="panel-head"><h2 id="dp-ap">The signed approval</h2></div>
        {ap && 'docHash' in ap ? <dl className="kv"><dt>Approval</dt><dd>{ap.id}</dd><dt>Fingerprint of what was signed (SHA-256)</dt><dd className="mono">{ap.docHash}</dd><dt>Signed with</dt><dd>{ap.method ?? 'unknown'}{ap.confirmedAt ? `, ${fmt.dayTime(ap.confirmedAt)}` : ''}</dd>
          {ap.signatures.map((s) => <Fragment key={s.credentialId}><dt>Signature</dt><dd>{s.person}, passkey {s.credentialId.slice(0, 12)}…, {fmt.dayTime(s.signedAt)}</dd></Fragment>)}</dl>
          : ap && 'instruction' in ap ? <p>{ap.note} Instruction {ap.instruction.programId}, version {ap.instruction.version}{ap.instruction.contentHash ? `, hash ${ap.instruction.contentHash}` : ''}.</p>
          : <p>No approval is on record for this payment.</p>}
      </section>

      <section className="panel" aria-labelledby="dp-tl"><div className="panel-head"><h2 id="dp-tl">Timeline</h2></div>
        <ol className="dp-timeline">{p.timeline.map((t, i) => <li key={i}><time>{fmt.dayTime(t.at)}</time><b>{t.step}</b><span>{t.detail}</span></li>)}</ol>
      </section>

      <section className="panel" aria-labelledby="dp-py"><div className="panel-head"><h2 id="dp-py">The payee, as signed</h2></div>
        <dl className="kv"><dt>Name</dt><dd>{p.payee.asSigned.name}</dd><dt>Address</dt><dd className="mono">{p.payee.asSigned.handle}</dd>{p.payee.asSigned.nameCheck ? <><dt>Name check at signing</dt><dd>{p.payee.asSigned.nameCheck}</dd></> : null}
          <dt>Now</dt><dd>{p.payee.now ? `${p.payee.now.name}, added ${fmt.dayTime(p.payee.now.addedAt)}${p.payee.changedSinceSigned ? '. The name has changed since it was signed.' : ', unchanged since it was signed.'}` : 'No longer one of your payees.'}</dd></dl>
      </section>

      <section className="panel" aria-labelledby="dp-bk"><div className="panel-head"><h2 id="dp-bk">The paper bank&rsquo;s reference</h2><p>Simulated: the paper rail is QED&rsquo;s local stand-in, not a real bank.</p></div>
        {p.bank ? <dl className="kv"><dt>Rail</dt><dd>{(p.bank.rail ?? '').toUpperCase()}</dd><dt>Its state</dt><dd>{p.bank.state}{p.bank.reason ? `: ${p.bank.reason}` : ''}</dd><dt>Reference</dt><dd className="mono">{p.bank.reference ?? 'none was given'}</dd></dl> : <p>The payment never reached the rail.</p>}
      </section>

      <section className="panel" aria-labelledby="dp-rc"><div className="panel-head"><h2 id="dp-rc">Receipts</h2><p>{p.receiptChain.verified ? `Your whole receipt chain (${p.receiptChain.count}) verifies.` : `Your receipt chain does not verify: it breaks at receipt ${p.receiptChain.brokenAt}.`}</p></div>
        {p.receipts.length ? <ul className="dp-receipts">{p.receipts.map((r) => <li key={r.id}><b>#{r.seq} {r.kind}</b> <time>{fmt.dayTime(r.at)}</time><span className="mono">hash {r.hash}</span><span className="mono">after {r.prevHash}</span> <Link to={`/receipts/${r.id}`}>Open</Link></li>)}</ul> : <p>No receipt has been issued for this payment yet.</p>}
      </section>

      {p.disputes.length ? <section className="panel" aria-labelledby="dp-ds"><div className="panel-head"><h2 id="dp-ds">The dispute</h2></div>
        <ul>{p.disputes.map((d) => <li key={d.id}><b>{STATE[d.state] ?? d.state}</b>, opened {fmt.dayTime(d.openedAt)}. You said: {d.reason}{d.resolution ? ` Outcome: ${d.resolution}` : ''}</li>)}</ul></section> : null}
    </div>
  )
}
