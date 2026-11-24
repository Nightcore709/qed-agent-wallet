/**
 * Closing the books of a chain the wallet service no longer runs (server/chain-books.ts closeReplacedChain). Shown only
 * while the service answers for another chain than the books were kept against: the preview first (nothing changes),
 * then an approval of exactly that preview, confirmed with a passkey, then the closing. Never automatic. The tokens are
 * valueless test tokens on a local chain, and the closing moves nothing on any chain.
 */
import { useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { ApprovalSheet, type PendingApproval } from './instrument.tsx'
import { Btn, Problem, useAction } from './kit.tsx'

interface ClosingPreview { oldGenesis: string; newGenesis: string; accounts: { code: string; symbol: string; amount: string; text: string }[]; movements: number; words: string }
interface Closing { id: string; oldGenesis: string; newGenesis: string; closedAt: number; movements: number }

const PLACE: Record<string, string> = { treasury: 'treasury vault', reserve: 'reserve vault', owner: 'the wallet\'s own account' }
const placeOf = (code: string): string => PLACE[code.split(':')[1] ?? ''] ?? code

/** The control, beside the notice that the books and the wallet disagree; nothing when there is nothing to close. */
export function ChainClosing() {
  const c = useData<{ preview: ClosingPreview | null; closings: Closing[] }>('/api/chain-books/closing', ['recon', 'vault'])
  const [sheet, setSheet] = useState<PendingApproval | null>(null)
  const prepare = useAction(async () => setSheet(await api<PendingApproval>('POST', '/api/chain-books/closing/prepare')))
  const p = c.data?.preview
  if (!p) return null
  return (
    <>
      <Btn small tone="fill" busy={prepare.busy} onClick={() => void prepare.run()}>Close the old chain's books</Btn>
      <Problem error={prepare.error} />
      <ApprovalSheet approval={sheet} title="Close the old chain's books" action="Close them" onClose={() => setSheet(null)}
        onApproved={async (approvalId) => { await api('POST', '/api/chain-books/closing', { approvalId }); setSheet(null); c.reload() }}>
        {sheet ? (
          <article className="instrument">
            <div className="i-head"><span>Closing the books of a replaced chain</span><span>Not approved yet</span></div>
            <div className="i-body">
              <p className="i-pay">{p.words}</p>
              {p.accounts.length ? <ul className="small">{p.accounts.map((a) => <li key={a.code}>{placeOf(a.code)}: {a.text}</li>)}</ul> : null}
              <p className="small muted">Recorded with this text and your approval; it cannot be undone. {c.data!.closings.length ? `Closed before: ${c.data!.closings.map((x) => fmt.dayTime(x.closedAt)).join(', ')}.` : ''}</p>
            </div>
          </article>
        ) : null}
      </ApprovalSheet>
    </>
  )
}
