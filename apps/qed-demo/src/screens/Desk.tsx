/**
 * The institutional desk (/workspace/desk, R13): what two or more workspaces owe each other, offset so each pays or receives its
 * net once; a request for quotes on a large order; and a report for each client with model portfolios offered to several
 * workspaces. Everything here is QED's own capability on this installation. It is not a clearing house, a dealer or a regulated
 * portfolio-management service, and the paper bank and the dealers it quotes against are simulated; each says so where it appears.
 * Money is signed through the workspace's own approval (its signing policy, bands and limits), never from this page.
 */
import { Building2, FileText, Layers, Scale } from 'lucide-react'
import { useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { ApprovalSheet } from '../ui/instrument.tsx'
import { Btn, Field, Loading, MoneyInput, Note, Problem, useAction, useSession } from '../ui/kit.tsx'

// ------------------------------------------------------------------------------------------------ shapes (server/netting.ts, rfq.ts, institutional.ts)
interface Claim { id: string; creditor: string; debtor: string; paise: number; memo: string; state: string; cycleId: string | null; direction: 'owed-to-you' | 'you-owe'; counterparty: string; yourMove: 'agree' | 'wait' | null; yours: boolean }
interface Cycle {
  id: string; state: string; expiresAt: number; fingerprint: string; settledAt: number | null
  participants: { id: string; name: string; position: number; agreed: boolean; pays: number; receives: number; signed: boolean; you: boolean }[]
  claims: { id: string; creditor: string; debtor: string; paise: number; memo: string }[]
  payments: { from: string; to: string; paise: number; mine: boolean }[]
  grossPaise: number; paidPaise: number; savedPaise: number; checks: string[]
  youAgreed: boolean; youPay: number; approvalId: string | null; approvalSigned: boolean; open: boolean; simulated: string
}
interface NettingView { code: string; claims: Claim[]; cycles: Cycle[]; simulated: string; rule: string }
interface SourceQuote { id: string; label: string; simulated: boolean; executable: boolean; note: string; sharePaise: number; qty: number; avgPrice: number | null; slippageBps: number | null; feePaise: number; alonePrice: number | null; aloneComplete: boolean }
interface LegQuote { instrumentId: string; name: string; side: 'buy' | 'sell'; amountPaise: number; mid: number | null; kind: string; sources: SourceQuote[]; splitAvgPrice: number | null; bestAlone: { label: string; avgPrice: number } | null; improvementBps: number | null; filledPaise: number; complete: boolean; why: string | null }
interface Rfq { id: string; validUntil: number; legs: LegQuote[]; simulatedNote: string; minVariance: { applies: boolean; why: string | null; certified?: boolean; certificate?: Record<string, number>; observations?: number; window?: { from: string; to: string }; shares?: { instrumentId: string; name: string; orderBps: number; minVarianceBps: number }[]; maxGapBps?: number; matches?: boolean } }
interface Model { id: string; name: string; version: number; retired: boolean; owner: string; legs: { instrumentId: string; name: string; weightBps: number }[]; basis: string; offers?: { id: string; client: string; state: string }[] }
interface ModelsView { owned: Model[]; received: { id: string; state: string; from: string; model: Model; programId: string | null; current: boolean }[]; scope: string }
interface ReportRow { id: string; name: string; kind: string; role: string; ok: boolean; value?: number; gain?: number; costs?: number; flags?: string[]; why?: string }
interface Report {
  workspace: { id: string; name: string }; period: { days: number }; scope: string; fingerprint: string
  accounting: { ok: boolean; breaks: number; note: string }
  holdings: { instrumentId: string; name: string; value: number | null; cost: number; gain: number | null; shareBps: number | null; priceReturn: number | null }[]
  totals: { value: number; bank: number; netWorth: number }
  attribution: { method: string; rows: { instrumentId: string; name: string; realised: number; unrealised: number; total: number; shareOfGainBps: number | null }[]; gain: number; costs: number; costsNote: string; model: { name: string; version: number; owner: string; active: { instrumentId: string; name: string; weightBps: number; targetBps: number; activeBps: number }[] } | null }
  compliance: { id: string; ok: boolean | null; text: string; basis: string }[]
  outcomes: { summary: string }
}
interface Market { instruments: { id: string; kind: string; name: string; venue: string; tradable: boolean }[] }

const STATE_TEXT: Record<string, string> = { proposed: 'Waiting for the other side', agreed: 'Both sides agreed', 'in-cycle': 'In a cycle', netted: 'Netted' }
const pctOf = (bps: number): string => `${(bps / 100).toFixed(1)}%`

export function DeskScreen() {
  return (
    <div className="workspace desk">
      <header className="pg-head">
        <h1>Institutional desk</h1>
        <p>Offset what workspaces owe each other, ask for quotes on a large order, and report to each client. This is QED's own capability on this installation: not a clearing house, a dealer or a regulated portfolio-management service.</p>
      </header>
      <Netting />
      <Quotes />
      <Clients />
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ netting
function Netting() {
  const { session, reload } = useSession()
  const n = useData<NettingView>('/api/desk/netting', ['approval', 'action', 'workspace'])
  const [other, setOther] = useState(''), [dir, setDir] = useState<'owed-to-me' | 'i-owe'>('owed-to-me'), [amount, setAmount] = useState<number | null>(null), [memo, setMemo] = useState('')
  const [with_, setWith] = useState('')
  const [signing, setSigning] = useState<{ approvalId: string; docHash: string; expiresAt: number; text: string } | null>(null)
  const [settled, setSettled] = useState<string | null>(null)
  const record = useAction(async () => { await api('POST', '/api/desk/netting/claims', { counterparty: other, direction: dir, amountPaise: amount, memo }); setAmount(null); setMemo(''); n.reload() })
  const answer = useAction(async (id: string, what: 'agree' | 'decline' | 'withdraw') => { await api('POST', `/api/desk/netting/claims/${id}/${what}`); n.reload() })
  const propose = useAction(async () => { await api('POST', '/api/desk/netting/cycles', { counterparties: with_.split(/[\s,]+/).filter(Boolean) }); setWith(''); n.reload() })
  const agree = useAction(async (c: Cycle) => { await api('POST', `/api/desk/netting/cycles/${c.id}/agree`, { fingerprint: c.fingerprint }); n.reload() })
  const cancel = useAction(async (id: string) => { await api('POST', `/api/desk/netting/cycles/${id}/cancel`); n.reload() })
  const prepare = useAction(async (c: Cycle) => {
    const p = await api<{ approvalId: string; docHash: string; expiresAt: number; required: number }>('POST', `/api/desk/netting/cycles/${c.id}/pay`)
    setSigning({ approvalId: p.approvalId, docHash: p.docHash, expiresAt: p.expiresAt, text: `Pay ${fmt.inr(c.youPay)} to settle the netting cycle. ${p.required > 1 ? `Your workspace's rules ask ${p.required} members to sign a payment this size.` : 'One signature is needed.'}` })
  })
  const settle = useAction(async (id: string) => { const r = await api<{ settled: boolean; reason: string | null }>('POST', `/api/desk/netting/cycles/${id}/settle`); setSettled(r.settled ? id : r.reason); n.reload(); void reload() })
  if (!n.data) return <section className="pg-sec"><div className="pg-sec-head"><div className="pg-sec-t"><h2>Between workspaces</h2></div></div>{n.error ? <Problem error={n.error} /> : <Loading what="Reading the claims" />}</section>
  const d = n.data
  const live = d.cycles.filter((c) => c.state === 'open'), done = d.cycles.filter((c) => c.state !== 'open')
  return (
    <section className="pg-sec" aria-labelledby="net-h">
      <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="net-h"><Layers aria-hidden="true" /> Between workspaces: netting</h2><span className="pg-aside">Simulated paper bank</span></div><p className="pg-note">{d.rule}</p></div>
      <div className="pg-sheet">
        <div className="wk-part"><p className="wk-hint">Your workspace's code, for the other side to name: <b data-testid="ws-code">{d.code}</b>. {d.simulated}</p></div>
        <ul className="wk-rows" aria-label="Claims">
          {d.claims.length ? d.claims.map((c) => (
            <li key={c.id}>
              <div className="wk-main"><p className="wk-t">{c.direction === 'owed-to-you' ? `${c.counterparty} owes you ${fmt.inr(c.paise)}` : `You owe ${c.counterparty} ${fmt.inr(c.paise)}`}<span className="wk-tag">{STATE_TEXT[c.state] ?? c.state}</span></p><p className="wk-d">{c.memo}{c.yours ? ' (recorded by you)' : ''}</p></div>
              <span className="wk-acts">
                {c.yourMove === 'agree' ? <><Btn small tone="fill" busy={answer.busy} onClick={() => void answer.run(c.id, 'agree')}>Agree<span className="sr"> to {c.memo}</span></Btn><Btn small busy={answer.busy} onClick={() => void answer.run(c.id, 'decline')}>Decline<span className="sr"> {c.memo}</span></Btn></> : null}
                {c.yours && (c.state === 'proposed' || c.state === 'agreed') ? <Btn small tone="void" busy={answer.busy} onClick={() => void answer.run(c.id, 'withdraw')}>Withdraw<span className="sr"> {c.memo}</span></Btn> : null}
              </span>
            </li>
          )) : <li><p className="wk-d">No claims yet. Record what another workspace owes you, or what you owe it; the other side agrees before it can be netted.</p></li>}
        </ul>
        <Problem error={answer.error} />
        <form className="wk-part wk-form" onSubmit={(e) => { e.preventDefault(); void record.run() }}>
          <h3>Record a claim</h3>
          <div className="form-grid">
            <Field label="The other workspace's code" error={record.error?.fields.counterparty}>{(p) => <input {...p} className="input" autoCapitalize="none" value={other} onChange={(e) => setOther(e.target.value)} />}</Field>
            <Field label="Who owes whom">{(p) => <select {...p} className="input" value={dir} onChange={(e) => setDir(e.target.value as typeof dir)}><option value="owed-to-me">They owe us</option><option value="i-owe">We owe them</option></select>}</Field>
            <Field label="Amount" error={record.error?.fields.amountPaise}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
            <Field label="What it is for" error={record.error?.fields.memo}>{(p) => <input {...p} className="input" value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
          </div>
          {record.error && !Object.keys(record.error.fields).length ? <Problem error={record.error} /> : null}
          <div><Btn type="submit" busy={record.busy} disabled={!other || !amount || !memo}>Record the claim</Btn></div>
        </form>
        <form className="wk-part wk-form" onSubmit={(e) => { e.preventDefault(); void propose.run() }}>
          <h3>Net what is agreed</h3>
          <p className="wk-hint">Name one or more other workspaces by code, separated by commas. Every agreed claim among them is offset. Each paying workspace then signs its own payment under its own signing rules.</p>
          <Field label="Net with (codes)" error={propose.error?.fields.counterparties}>{(p) => <input {...p} className="input" autoCapitalize="none" value={with_} onChange={(e) => setWith(e.target.value)} />}</Field>
          {propose.error && !propose.error.fields.counterparties ? <Problem error={propose.error} /> : null}
          <div><Btn type="submit" busy={propose.busy} disabled={!with_.trim()}>Propose a netting cycle</Btn></div>
        </form>
      </div>

      {live.length ? <h3 className="desk-h">Open cycles</h3> : null}
      {live.map((c) => <CycleCard key={c.id} c={c} onAgree={() => void agree.run(c)} onPrepare={() => void prepare.run(c)} onSettle={() => void settle.run(c.id)} onCancel={() => void cancel.run(c.id)} busy={agree.busy || prepare.busy || settle.busy || cancel.busy} />)}
      <Problem error={agree.error ?? prepare.error ?? settle.error ?? cancel.error} />
      {settled && settled.startsWith('ncy_') ? <Note tone="ok" title="Settled">Every payment of the cycle posted together in the paper bank. The claims are netted.</Note> : settled ? <Note tone="wait" title="Not settled yet">{settled}</Note> : null}
      {done.length ? <><h3 className="desk-h">Closed cycles</h3>{done.map((c) => <CycleCard key={c.id} c={c} />)}</> : null}

      <ApprovalSheet approval={signing ? { approvalId: signing.approvalId, docHash: signing.docHash, expiresAt: signing.expiresAt, requiresStepUp: true } : null} title="Sign this payment" action="Sign" withdrawOnClose={false}
        onClose={() => { setSigning(null); n.reload() }} onApproved={async () => { setSigning(null); n.reload(); void reload() }}>
        {signing ? <><p>{signing.text}</p><p className="wk-hint">{d.simulated}</p></> : null}
      </ApprovalSheet>
      <span hidden>{session.workspace?.id}</span>
    </section>
  )
}

function CycleCard({ c, onAgree, onPrepare, onSettle, onCancel, busy }: { c: Cycle; onAgree?: () => void; onPrepare?: () => void; onSettle?: () => void; onCancel?: () => void; busy?: boolean }) {
  const allAgreed = c.participants.every((p) => p.agreed)
  const payers = c.participants.filter((p) => p.pays > 0)
  const ready = allAgreed && payers.every((p) => p.signed)
  return (
    <article className="pg-sheet desk-cycle" aria-label={`Netting cycle ${c.id}`} data-state={c.state}>
      <div className="wk-part">
        <p className="wk-t">{c.state === 'settled' ? 'Settled' : c.state === 'cancelled' ? 'Cancelled' : 'Open'}: {fmt.inr(c.grossPaise)} of claims become {fmt.inr(c.paidPaise)} of payments <span className="wk-tag">saves {fmt.inr(c.savedPaise)}</span></p>
        <p className="wk-d">Fingerprint {c.fingerprint.slice(0, 12)}…. {c.simulated}</p>
      </div>
      <table className="wk-roles desk-table">
        <caption className="sr">Positions in cycle {c.id}</caption>
        <thead><tr><th scope="col">Workspace</th><th scope="col">Net position</th><th scope="col">Agreed</th><th scope="col">Payment signed</th></tr></thead>
        <tbody>{c.participants.map((p) => <tr key={p.id} className={p.you ? 'you' : ''}><th scope="row">{p.name}{p.you ? <span className="wk-tag">you</span> : null}</th><td>{p.position > 0 ? `Receives ${fmt.inr(p.receives)}` : p.position < 0 ? `Pays ${fmt.inr(p.pays)}` : 'Nothing to pay or receive'}</td><td>{p.agreed ? 'Yes' : 'Not yet'}</td><td>{p.pays > 0 ? (p.signed ? 'Yes' : 'Not yet') : 'Not needed'}</td></tr>)}</tbody>
      </table>
      <ul className="wk-rows" aria-label="Claims in this cycle">{c.claims.map((x) => <li key={x.id}><div className="wk-main"><p className="wk-t">{x.debtor} owes {x.creditor} {fmt.inr(x.paise)}</p><p className="wk-d">{x.memo}</p></div></li>)}</ul>
      <div className="wk-part"><p className="wk-hint">Checked again from the claims alone: {c.checks.join('; ')}.</p>
        {c.open ? <p className="wk-acts desk-acts">
          {!c.youAgreed && onAgree ? <Btn small tone="fill" busy={busy} onClick={onAgree}>Agree to these terms</Btn> : null}
          {c.youAgreed && c.youPay > 0 && !c.approvalSigned && allAgreed && onPrepare ? <Btn small tone="fill" busy={busy} onClick={onPrepare}>Sign my payment of {fmt.inr(c.youPay)}</Btn> : null}
          {c.youAgreed && c.youPay > 0 && !allAgreed ? <span className="wk-d">Waiting for every workspace to agree before payments are signed.</span> : null}
          {ready && onSettle ? <Btn small tone="fill" busy={busy} onClick={onSettle}>Settle now</Btn> : null}
          {onCancel ? <Btn small tone="void" busy={busy} onClick={onCancel}>Cancel the cycle</Btn> : null}
        </p> : null}
      </div>
    </article>
  )
}

// ------------------------------------------------------------------------------------------------ quotes
function Quotes() {
  const m = useData<Market>('/api/market')
  const [id, setId] = useState(''), [side, setSide] = useState<'buy' | 'sell'>('buy'), [amount, setAmount] = useState<number | null>(null)
  const [extra, setExtra] = useState<{ id: string; amount: number | null }[]>([])
  const [r, setR] = useState<Rfq | null>(null)
  const ask = useAction(async () => {
    const legs = [{ instrumentId: id, side, amountPaise: amount }, ...extra.filter((x) => x.id && x.amount).map((x) => ({ instrumentId: x.id, side, amountPaise: x.amount }))]
    setR(await api<Rfq>('POST', '/api/desk/rfq', { legs }))
  })
  const choices = (m.data?.instruments ?? []).filter((i) => i.tradable && (i.venue === 'paper-crypto' || i.kind === 'mutual_fund'))
  return (
    <section className="pg-sec" aria-labelledby="rfq-h">
      <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="rfq-h"><Scale aria-hidden="true" /> Quotes for a large order</h2><span className="pg-aside">Paper venue and simulated dealers</span></div><p className="pg-note">Ask every source for a price on an order of a size, see them side by side and how the order would be split to cost least. This places no order and moves no money; to act on a quote, use the order screen.</p></div>
      <form className="pg-sheet wk-form wk-part" onSubmit={(e) => { e.preventDefault(); void ask.run() }}>
        <div className="form-grid">
          <Field label="Investment">{(p) => <select {...p} className="input" value={id} onChange={(e) => setId(e.target.value)}><option value="">Choose</option>{choices.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>}</Field>
          <Field label="Buy or sell">{(p) => <select {...p} className="input" value={side} onChange={(e) => setSide(e.target.value as typeof side)}><option value="buy">Buy</option><option value="sell">Sell</option></select>}</Field>
          <Field label="Order size" hint="At least ₹10,000.">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        </div>
        {extra.map((x, i) => (
          <div key={i} className="form-grid">
            <Field label={`Another investment ${i + 1}`}>{(p) => <select {...p} className="input" value={x.id} onChange={(e) => setExtra(extra.map((y, k) => (k === i ? { ...y, id: e.target.value } : y)))}><option value="">Choose</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
            <Field label={`Its size ${i + 1}`}>{(p) => <MoneyInput {...p} value={x.amount} onChange={(v) => setExtra(extra.map((y, k) => (k === i ? { ...y, amount: v } : y)))} />}</Field>
          </div>
        ))}
        {extra.length < 5 ? <div><Btn small onClick={() => setExtra([...extra, { id: '', amount: null }])}>Add another investment to the order</Btn></div> : null}
        <Problem error={ask.error} />
        <div><Btn type="submit" busy={ask.busy} disabled={!id || !amount}>Request quotes</Btn></div>
      </form>
      {r ? <RfqResult r={r} /> : null}
    </section>
  )
}

function RfqResult({ r }: { r: Rfq }) {
  return (
    <div className="desk-rfq" aria-label="Quotes">
      <Note tone="wait" title="Simulated sources">{r.simulatedNote}</Note>
      {r.legs.map((l) => (
        <article key={`${l.instrumentId}-${l.side}`} className="pg-sheet">
          <div className="wk-part"><p className="wk-t">{l.side === 'buy' ? 'Buy' : 'Sell'} {fmt.inr(l.amountPaise)} of {l.name}</p>
            <p className="wk-d">{l.why ?? (l.bestAlone ? `Split across the sources: average price ₹${l.splitAvgPrice!.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${l.improvementBps !== null ? `, ${l.improvementBps.toFixed(1)} basis points ${l.improvementBps >= 0 ? 'better' : 'worse'} than the best single source (${l.bestAlone.label})` : ''}.` : `Filled ${fmt.inr(l.filledPaise)} of ${fmt.inr(l.amountPaise)} asked; no single source can take it all.`)}</p></div>
          {l.sources.length ? <table className="wk-roles desk-table">
            <caption className="sr">Quotes for {l.name}</caption>
            <thead><tr><th scope="col">Source</th><th scope="col">Share of the order</th><th scope="col">Average price</th><th scope="col">Slippage from mid</th><th scope="col">Alone</th></tr></thead>
            <tbody>{l.sources.map((s) => <tr key={s.id}><th scope="row">{s.label}{s.simulated ? <span className="wk-tag">simulated</span> : null}<span className="wk-d desk-note">{s.note}</span></th><td>{s.sharePaise > 0 ? fmt.inr(s.sharePaise) : '—'}</td><td>{s.avgPrice !== null ? `₹${s.avgPrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</td><td>{s.slippageBps !== null ? `${s.slippageBps.toFixed(1)} bp` : '—'}</td><td>{s.aloneComplete && s.alonePrice !== null ? `₹${s.alonePrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : 'cannot take it all'}</td></tr>)}</tbody>
          </table> : null}
        </article>
      ))}
      <article className="pg-sheet" aria-label="Minimum-variance check">
        <div className="wk-part">
          <p className="wk-t">Minimum-variance check</p>
          {r.minVariance.applies ? <>
            <p className="wk-d">The solve {r.minVariance.certified ? 'passed' : 'did NOT pass'} its own optimality check ({Object.entries(r.minVariance.certificate ?? {}).map(([k, v]) => `${k} ${v.toExponential(1)}`).join(', ')}) on {r.minVariance.observations} daily returns, {r.minVariance.window?.from} to {r.minVariance.window?.to}. Your order is {r.minVariance.matches ? 'within 1 point of' : `${pctOf(r.minVariance.maxGapBps ?? 0)} away from`} the minimum-variance mix of these investments.</p>
            <table className="wk-roles desk-table"><caption className="sr">Order against minimum variance</caption><thead><tr><th scope="col">Investment</th><th scope="col">Your order</th><th scope="col">Minimum variance</th></tr></thead><tbody>{r.minVariance.shares!.map((s) => <tr key={s.instrumentId}><th scope="row">{s.name}</th><td>{pctOf(s.orderBps)}</td><td>{pctOf(s.minVarianceBps)}</td></tr>)}</tbody></table>
            <p className="wk-hint">Calculated now from last year's recorded values: past covariance, not a forecast, and not advice. In the R11 study no optimiser beat equal weight after costs.</p>
          </> : <p className="wk-d">Does not apply: {r.minVariance.why}</p>}
        </div>
      </article>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ clients, models and reports
function Clients() {
  const { session, reload } = useSession()
  const [days, setDays] = useState(90)
  const rows = useData<{ scope: string; reports: ReportRow[] }>(`/api/desk/reports?days=${days}`, ['action', 'workspace'])
  const rep = useData<Report>(`/api/desk/report?days=${days}`, ['action', 'workspace'])
  const models = useData<ModelsView>('/api/desk/models', ['workspace', 'action'])
  const market = useData<Market>('/api/market')
  const [name, setName] = useState(''), [legs, setLegs] = useState<{ id: string; pct: string }[]>([{ id: '', pct: '' }, { id: '', pct: '' }])
  const [codes, setCodes] = useState('')
  const publish = useAction(async () => { await api('POST', '/api/desk/models', { name, legs: legs.filter((l) => l.id).map((l) => ({ instrumentId: l.id, weightBps: Math.round(Number(l.pct) * 100) })) }); setName(''); models.reload() })
  const offer = useAction(async (id: string) => { await api('POST', `/api/desk/models/${id}/offer`, { codes: codes.split(/[\s,]+/).filter(Boolean) }); setCodes(''); models.reload() })
  const answer = useAction(async (id: string, what: 'accept' | 'decline') => { const r = await api<{ programId: string | null }>('POST', `/api/desk/offers/${id}/${what}`); models.reload(); rep.reload(); return r })
  const switchTo = useAction(async (id: string) => { await api('POST', `/api/workspaces/${id}/switch`); await reload() })
  const choices = (market.data?.instruments ?? []).filter((i) => i.tradable && i.kind === 'mutual_fund')
  const download = () => {
    if (!rep.data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(rep.data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `qed-client-report-${rep.data.workspace.name.replace(/[^A-Za-z0-9]+/g, '-')}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section className="pg-sec" aria-labelledby="cl-h">
      <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="cl-h"><Building2 aria-hidden="true" /> Clients: reports and model portfolios</h2><span className="pg-aside">QED's own capability</span></div><p className="pg-note">{rows.data?.scope ?? 'QED\'s own reporting capability. Not a regulated portfolio-management service.'}</p></div>
      <div className="pg-sheet">
        <div className="wk-part"><Field label="Period of the reports">{(p) => <select {...p} className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 365 days</option></select>}</Field></div>
        {!rows.data ? <div className="wk-part">{rows.error ? <Problem error={rows.error} /> : <Loading what="Reading each workspace" />}</div> : <ul className="wk-rows" aria-label="One report for each workspace you belong to">
          {rows.data.reports.map((r) => (
            <li key={r.id}>
              <div className="wk-main"><p className="wk-t">{r.kind === 'business' ? r.name : 'Personal'}{r.id === session.workspace?.id ? <span className="wk-tag">open now</span> : null}</p>
                <p className="wk-d">{r.ok ? `Value ${fmt.inr(r.value ?? 0)}; gain ${fmt.signed(r.gain ?? 0, false)}; costs ${fmt.inr(r.costs ?? 0, true)}${r.flags?.length ? `; to look at: ${r.flags.join(', ')}` : '; nothing flagged'}` : `No report: ${r.why}`}</p></div>
              {r.id === session.workspace?.id ? null : <span className="wk-acts"><Btn small busy={switchTo.busy} onClick={() => void switchTo.run(r.id)}>Open its report<span className="sr"> ({r.name})</span></Btn></span>}
            </li>
          ))}
        </ul>}
      </div>

      {rep.data ? <article className="pg-sheet desk-report" aria-label={`Report for ${rep.data.workspace.name}`}>
        <div className="wk-part"><p className="wk-t"><FileText aria-hidden="true" /> {rep.data.workspace.name}: the last {rep.data.period.days} days</p><p className="wk-d">{rep.data.outcomes.summary}</p><p className="wk-hint">Report fingerprint {rep.data.fingerprint.slice(0, 16)}…. {rep.data.attribution.method}</p>
          <div><Btn small onClick={download}>Download the report (JSON)</Btn></div></div>
        <table className="wk-roles desk-table">
          <caption className="sr">Gain by holding</caption>
          <thead><tr><th scope="col">Holding</th><th scope="col">Value</th><th scope="col">Share</th><th scope="col">Realised</th><th scope="col">Unrealised</th><th scope="col">Share of gain</th></tr></thead>
          <tbody>{rep.data.attribution.rows.map((a) => { const h = rep.data!.holdings.find((x) => x.instrumentId === a.instrumentId); return <tr key={a.instrumentId}><th scope="row">{a.name}</th><td>{h?.value != null ? fmt.inr(h.value) : '—'}</td><td>{h?.shareBps != null ? pctOf(h.shareBps) : '—'}</td><td>{fmt.signed(a.realised, false)}</td><td>{fmt.signed(a.unrealised, false)}</td><td>{a.shareOfGainBps != null ? pctOf(a.shareOfGainBps) : '—'}</td></tr> })}</tbody>
        </table>
        {rep.data.attribution.model ? <div className="wk-part"><p className="wk-t">Against the model "{rep.data.attribution.model.name}" (version {rep.data.attribution.model.version}, from {rep.data.attribution.model.owner})</p>
          <table className="wk-roles desk-table"><caption className="sr">Active weights</caption><thead><tr><th scope="col">Holding</th><th scope="col">Held</th><th scope="col">Target</th><th scope="col">Active</th></tr></thead><tbody>{rep.data.attribution.model.active.map((a) => <tr key={a.instrumentId}><th scope="row">{a.name}</th><td>{pctOf(a.weightBps)}</td><td>{pctOf(a.targetBps)}</td><td>{a.activeBps > 0 ? '+' : ''}{(a.activeBps / 100).toFixed(1)} points</td></tr>)}</tbody></table></div> : null}
        <ul className="wk-rows" aria-label="Checks">{rep.data.compliance.map((c) => <li key={c.id}><span className="wk-glyph" aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '!' : '·'}</span><div className="wk-main"><p className="wk-t">{c.ok === true ? 'Passed' : c.ok === false ? 'To look at' : 'For information'}</p><p className="wk-d">{c.text} <i>({c.basis})</i></p></div></li>)}</ul>
      </article> : rep.error ? <Problem error={rep.error} /> : null}

      <h3 className="desk-h">Model portfolios</h3>
      {!models.data ? (models.error ? <Problem error={models.error} /> : <Loading what="Reading models" />) : <>
        <div className="pg-sheet">
          {models.data.received.length ? <ul className="wk-rows" aria-label="Models offered to this workspace">{models.data.received.map((o) => (
            <li key={o.id}>
              <div className="wk-main"><p className="wk-t">{o.from} offers "{o.model.name}" (version {o.model.version})<span className="wk-tag">{o.state}</span></p>
                <p className="wk-d">{o.model.legs.map((l) => `${pctOf(l.weightBps)} ${l.name}`).join('; ')}. {o.model.basis}</p>
                {o.state === 'accepted' && o.programId ? <p className="wk-d">Draft instruction made: <a href={`/instructions/${o.programId}`}>read and sign it</a>. Nothing trades until your signers sign it.</p> : null}</div>
              {o.state === 'offered' ? <span className="wk-acts"><Btn small tone="fill" busy={answer.busy} onClick={() => void answer.run(o.id, 'accept')}>Accept and draft it<span className="sr"> ({o.model.name})</span></Btn><Btn small busy={answer.busy} onClick={() => void answer.run(o.id, 'decline')}>Decline<span className="sr"> ({o.model.name})</span></Btn></span> : null}
            </li>))}</ul> : <p className="wk-empty">No model has been offered to this workspace.</p>}
          <Problem error={answer.error} />
        </div>
        <div className="pg-sheet">
          {models.data.owned.length ? <ul className="wk-rows" aria-label="Models this workspace publishes">{models.data.owned.filter((m) => !m.retired).map((m) => (
            <li key={m.id}>
              <div className="wk-main"><p className="wk-t">{m.name} (version {m.version})</p><p className="wk-d">{m.legs.map((l) => `${pctOf(l.weightBps)} ${l.name}`).join('; ')}</p>
                {m.offers?.length ? <p className="wk-d">Offered to {m.offers.map((x) => `${x.client} (${x.state})`).join(', ')}</p> : null}
                <div className="wk-form"><Field label={`Offer ${m.name} to workspaces (codes)`}>{(p) => <input {...p} className="input" autoCapitalize="none" value={codes} onChange={(e) => setCodes(e.target.value)} />}</Field>
                  <div><Btn small busy={offer.busy} disabled={!codes.trim()} onClick={() => void offer.run(m.id)}>Offer it<span className="sr"> ({m.name})</span></Btn></div></div></div>
            </li>))}</ul> : null}
          <Problem error={offer.error} />
          <form className="wk-part wk-form" onSubmit={(e) => { e.preventDefault(); void publish.run() }}>
            <h3>Publish a model portfolio</h3>
            <p className="wk-hint">Target shares you choose, two to six funds, adding to 100%. Offering it changes nothing in another workspace: its own owner or admin accepts, and its own signers sign the instruction that makes. QED does not judge whether a model suits anyone.</p>
            <Field label="Model name" error={publish.error?.fields.name}>{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            {legs.map((l, i) => (
              <div key={i} className="form-grid">
                <Field label={`Fund ${i + 1}`}>{(p) => <select {...p} className="input" value={l.id} onChange={(e) => setLegs(legs.map((x, k) => (k === i ? { ...x, id: e.target.value } : x)))}><option value="">Choose</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
                <Field label={`Share ${i + 1} (%)`}>{(p) => <input {...p} className="input" inputMode="decimal" value={l.pct} onChange={(e) => setLegs(legs.map((x, k) => (k === i ? { ...x, pct: e.target.value } : x)))} />}</Field>
              </div>
            ))}
            {legs.length < 6 ? <div><Btn small onClick={() => setLegs([...legs, { id: '', pct: '' }])}>Add a fund</Btn></div> : null}
            {publish.error && !publish.error.fields.name ? <Problem error={publish.error} /> : null}
            <div><Btn type="submit" busy={publish.busy} disabled={!name || legs.filter((l) => l.id).length < 2}>Publish the model</Btn></div>
          </form>
        </div>
      </>}
    </section>
  )
}
