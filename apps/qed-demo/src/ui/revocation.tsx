/**
 * Where a revocation reached (server/revocation.ts): each channel with the answer it gave and when. A channel that has not
 * acknowledged is shown as such, never as revoked. The paper bank is a simulated institution and says so.
 */
import { lazy, Suspense } from 'react'
import { useData, fmt } from '../lib/core.ts'
import { Loading, Problem } from './kit.tsx'

// the wallet's signing flow lives with its page: loaded only when a revocation waits for the wallet's mandate
const RevokeMandateSigner = lazy(() => import('../screens/Vault.tsx').then((m) => ({ default: m.RevokeMandateSigner })))

export interface RevocationChannel { channel: string; label: string; state: 'acknowledged' | 'no-answer' | 'needs-you' | 'sent'; askedAt: number; answeredAt: number | null; reference: string | null; detail: string; simulated: boolean }
export interface RevocationRecord { id: string; subjectId: string; title: string; requestedAt: number; complete: boolean; channels: RevocationChannel[]; remains?: string[] }

const STATE: Record<RevocationChannel['state'], string> = { acknowledged: 'Acknowledged', 'no-answer': 'No answer yet: not revoked', 'needs-you': 'Needs you: not revoked', sent: 'Sent, not confirmed: not revoked' }

export function ChannelList({ r }: { r: RevocationRecord }) {
  return (
    <ul className="rv-channels" aria-label={`Where revoking ${r.title} reached`}>
      {r.channels.map((c) => (
        <li key={c.channel} className={`rv-ch ${c.state}`}>
          <b>{c.label}{c.simulated ? <span className="rv-sim"> (simulated)</span> : null}</b>
          <span className="rv-state">{STATE[c.state]}{c.answeredAt ? `, ${fmt.dayTime(c.answeredAt)}` : ''}</span>
          <small>{c.detail}{c.reference ? ` Reference: ${c.reference}.` : ''}</small>
        </li>
      ))}
    </ul>
  )
}

/** The revocation of one instruction, if it has a record; nothing otherwise (one revoked before revocations were recorded). */
export function RevocationOf({ programId }: { programId: string }) {
  const { data, error, reload } = useData<{ revocations: RevocationRecord[] }>('/api/revocations', ['program', 'vault'])
  if (error) return <Problem error={error} />
  if (!data) return <Loading what="Reading where the revocation reached" />
  const r = data.revocations.find((x) => x.subjectId === programId)
  const chainWaits = r?.channels.some((c) => c.channel === 'chain' && c.state === 'needs-you')
  return r ? (
    <section className="panel rv" aria-labelledby="rv-h">
      <div className="panel-head"><h2 id="rv-h">Where the revocation reached</h2><p>{r.complete ? 'Every channel acknowledged.' : 'Not every channel has acknowledged. Only an acknowledged channel is revoked.'}</p></div>
      <ChannelList r={r} />
      {r.remains?.length ? (
        <div className="rv-remains">
          <h3>What remains in force</h3>
          <ul>{r.remains.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
      {chainWaits ? (
        // R13: the wallet's own revoke-mandate request, prepared for the passkey (server/api.ts prepareChainRevocation)
        <div className="rv-act"><Suspense fallback={null}><RevokeMandateSigner revocationId={r.id} onDone={reload} /></Suspense></div>
      ) : null}
    </section>
  ) : null
}
