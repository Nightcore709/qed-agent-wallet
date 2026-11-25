/**
 * Spend: subscriptions found in the payment history (server/subscriptions.ts). Each with its cost a month and a year, when
 * the next payment is expected, the payments it rests on, and two ways to review it: stop QED's own instruction for it (applied
 * at once, since it only removes authority) or say you must cancel it with the merchant (QED cannot). The rule used to find
 * them, with its tolerance, is on the screen.
 */
import { Repeat } from 'lucide-react'
import { useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { Btn, EmptyState, Link, Loading, Note, Problem, useAction } from '../ui/kit.tsx'
import { ChannelList, type RevocationRecord } from '../ui/revocation.tsx'

interface Sub {
  payeeHandle: string; payeeName: string; cadence: string; amount: number; perMonth: number; perYear: number; nextExpected: number; lastPaid: number
  evidence: { actionId: string; at: number; amount: number; programId: string | null }[]
  instructions: { id: string; title: string; state: string }[]
  review: { state: 'stopped' | 'cancel-myself'; reviewedAt: number; note: string } | null
  paidAfterReview: number
}
interface Found { rule: string; cannotCancel: string; subscriptions: Sub[] }

export function Subscriptions() {
  const { data, error, reload } = useData<Found>('/api/subscriptions', ['action', 'program'])
  const [stopped, setStopped] = useState<{ handle: string; nothing: boolean; stopped: RevocationRecord[] } | null>(null)
  const stop = useAction(async (handle: string) => { const r = await api<{ nothing: boolean; stopped: RevocationRecord[] }>('POST', '/api/subscriptions/stop', { payeeHandle: handle }); setStopped({ handle, ...r }); reload() })
  const mine = useAction(async (handle: string) => { await api('POST', '/api/subscriptions/cancel-myself', { payeeHandle: handle }); reload() })
  return (
    <section className="panel pay-subs" aria-labelledby="subs-h">
      <div className="pay-subs-in">
      <div className="pay-sec-head"><div><h2 id="subs-h">Subscriptions</h2><p>Payments that repeat on a schedule, found in what you have paid.{data?.subscriptions.length ? ` ${data.cannotCancel}` : ''}</p></div></div>
      <div className="pay-subs-body">
      {error ? <Problem error={error} /> : !data ? <Loading what="Reading your payments" /> : data.subscriptions.length === 0 ? (
        <EmptyState across compact icon={<Repeat />} title="No subscription found in your payments yet" />
      ) : (
        <ul className="subs-list">
          {data.subscriptions.map((s) => (
            <li key={s.payeeHandle} className="sub">
              <div className="sub-head">
                <span className="sub-name"><Repeat aria-hidden="true" /><b>{s.payeeName}</b><small>{s.payeeHandle}, {s.cadence}</small></span>
                <span className="sub-cost gr-n"><b>{fmt.money(s.perMonth, true)}</b> a month<small>{fmt.money(s.perYear, true)} a year</small></span>
              </div>
              <p className="sub-next">Next payment expected {fmt.day(s.nextExpected)}. Last paid {fmt.day(s.lastPaid)}.</p>
              <details className="disclose sub-evidence">
                <summary>The {s.evidence.length} payments this rests on</summary>
                <ul>{s.evidence.map((e) => <li key={e.actionId}><Link to={`/record/${e.actionId}`}>{fmt.day(e.at)}</Link> <span>{fmt.money(e.amount, true)}</span>{e.programId ? <small> by an instruction</small> : null}</li>)}</ul>
              </details>
              {s.review?.state === 'stopped' ? <Note tone="ok" title="QED's instruction for it is stopped">{s.review.note}</Note> : null}
              {s.review?.state === 'cancel-myself' ? <Note tone="wait" title="You are cancelling this one yourself">{s.review.note}{s.paidAfterReview ? ` It was paid ${s.paidAfterReview === 1 ? 'again' : `${s.paidAfterReview} more times`} after you said so: check that the cancellation went through.` : ''}</Note> : null}
              {stopped?.handle === s.payeeHandle ? (stopped.nothing
                ? <Note title="Nothing of QED's to stop">QED holds no instruction or mandate for {s.payeeName}, so there is nothing for it to stop. Cancel it with them yourself.</Note>
                : stopped.stopped.map((r) => <ChannelList key={r.id} r={r} />)) : null}
              <div className="sub-acts">
                <Btn small busy={stop.busy} disabled={s.instructions.length === 0 || s.review?.state === 'stopped'} onClick={() => void stop.run(s.payeeHandle)}>Stop QED&rsquo;s instruction for it<span className="sr">: {s.payeeName}</span></Btn>
                <Btn small tone="quiet" busy={mine.busy} disabled={s.review?.state === 'cancel-myself'} onClick={() => void mine.run(s.payeeHandle)}>I must cancel it with them<span className="sr">: {s.payeeName}</span></Btn>
                {s.instructions.length === 0 && s.review?.state !== 'stopped' ? <small className="sub-none">QED holds no instruction or mandate for this payee.</small> : s.instructions.length ? <small className="sub-none">{s.instructions.map((i) => i.title).join('; ')}</small> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Problem error={stop.error ?? mine.error} />
      {data ? <details className="disclose sub-rule"><summary>How a subscription is found</summary><p>{data.rule}</p>{data.subscriptions.length ? null : <p>{data.cannotCancel}</p>}</details> : null}
      </div>
      </div>
    </section>
  )
}
