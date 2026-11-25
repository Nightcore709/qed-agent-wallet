/**
 * Earn's work directory (R13, audit item E4; server/directory.ts; design system "Meridian"). A household publishes an
 * offer of work it does or a request for work it needs; other households of this installation quote on a request or
 * take an offer; the requester compares the quotes and chooses one. Choosing creates the job on the chosen provider's
 * side under "Work paid through escrow on the chain", where the provider offers it with its passkey and the client funds
 * it: nothing moves and nothing is signed here.
 *
 * Simulated: a few listings, and two quotes on each request, stand for QED workspaces beyond this installation. They are
 * marked "Simulated" wherever they appear and cannot be chosen or taken. Titles, notes and asset names come from other
 * households and are shown as they wrote them, as plain text.
 */
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { Composer, listed } from '../screens/Earn.tsx'
import { Btn, Field, MoneyInput, Note, Problem, Stamp, useAction } from './kit.tsx'

type Problem_ = { kind: string; assets?: { name: string; volatilityBps: number }[] }
interface By { handle?: string; name?: string | null; where?: string }
interface DQuote { id: string; amount: number; deliverWithinHours: number; note: string; state: string; simulated: boolean; by: By; jobId: string | null; dispute: { deciderHandle: string } | null; listing?: { id: string; kind: string; title: string; by: By } }
interface DListing { id: string; kind: 'offer' | 'request'; title: string; detail: string; problem: Problem_; amount: number; deliverWithinHours: number; state: string; simulated: boolean; by: By; yours: boolean; yourQuote: DQuote | null; quotes?: DQuote[]; closedWhy?: string | null }
interface DView { simulatedNote: string; hasWallet: boolean; listings: DListing[]; mine: DListing[]; sent: DQuote[] }

const workWords = (p: Problem_): string => (p.kind === 'helix' ? 'The lowest-risk mix of the illustrative Helix model, certified on the chain' : `The lowest-risk mix of ${listed((p.assets ?? []).map((a) => `${a.name} (${a.volatilityBps / 100}% a year)`))}, certified on the chain`)
const byWords = (b: By): string => (b.where ? `${b.name}, ${b.where}` : `@${b.handle}${b.name ? ` (${b.name})` : ''}`)
const STATE: Record<string, string> = { open: 'Open', chosen: 'Chosen', 'not-chosen': 'Not chosen', withdrawn: 'Withdrawn', closed: 'Closed' }

export function Directory({ onChosen }: { onChosen: () => void }) {
  const v = useData<DView>('/api/earn/directory', ['earn'])
  const [publishing, setPublishing] = useState(false)
  const [quoting, setQuoting] = useState<string | null>(null)
  const [said, setSaid] = useState<{ id: string; text: string } | null>(null)
  const choose = useAction(async (l: DListing, q: DQuote) => {
    await api('POST', `/api/earn/directory/quotes/${q.id}/choose`)
    setSaid({ id: l.id, text: `You chose @${q.by.handle}'s quote. The job is ready under "Work paid through escrow on the chain": @${q.by.handle} offers it with their passkey, then you fund it from your wallet. Nothing has moved yet.` })
    v.reload(); onChosen()
  })
  const take = useAction(async (l: DListing) => {
    await api('POST', `/api/earn/directory/listings/${l.id}/take`)
    setSaid({ id: l.id, text: `You took @${l.by.handle}'s offer at ${fmt.inr(l.amount, true)}. The job is ready under "Work paid through escrow on the chain": @${l.by.handle} offers it with their passkey, then you fund it. Nothing has moved yet.` })
    v.reload(); onChosen()
  })
  const close = useAction(async (l: DListing) => { await api('POST', `/api/earn/directory/listings/${l.id}/close`); v.reload() })
  const head = (
    <div className="er-kind-head">
      <div><h2 id="dir-h">Find work, or someone to do it</h2><p>The directory of the QED households in this installation: the same deployment you are using, not a list from elsewhere. Publish an offer of work you do, or a request for work you need; compare the quotes and choose one. The job then goes through the escrow on the chain like any other: nothing moves until the provider offers it with their passkey and the client funds it.</p></div>
      {v.data && !publishing ? <Btn onClick={() => setPublishing(true)}><Plus aria-hidden="true" />Publish an offer or a request</Btn> : null}
    </div>
  )
  if (!v.data) return <section aria-labelledby="dir-h" className="er-kind er-dir">{head}{v.error ? <Problem error={v.error} /> : <p className="small faint">Reading the directory.</p>}</section>
  const d = v.data
  const failed = choose.error ?? take.error ?? close.error
  return (
    <section aria-labelledby="dir-h" className="er-kind er-dir">
      {head}
      {publishing ? <Composer title="Publish in the directory" onClose={() => setPublishing(false)}><PublishForm hasWallet={d.hasWallet} onDone={() => { setPublishing(false); v.reload() }} /></Composer> : null}
      <Note tone="wait" title="Some of this is simulated">{d.simulatedNote}</Note>
      {failed ? <Problem error={failed} /> : null}

      <h3 className="er-sub">Your listings</h3>
      {d.mine.length === 0 ? <p className="small faint">You have published nothing. A request asks other households for quotes; an offer lets them take your work at its price.</p> : d.mine.map((l) => (
        <article key={l.id} className="panel er-dir-item" aria-label={l.title}>
          <div className="er-dir-top"><Stamp tone={l.state === 'open' ? 'info' : 'plain'}>{l.kind === 'request' ? 'Your request' : 'Your offer'}: {STATE[l.state] ?? l.state}</Stamp><strong>{l.title}</strong></div>
          <p className="small">{workWords(l.problem)}. {l.kind === 'request' ? 'Budget' : 'Price'} {fmt.inr(l.amount, true)} (test tINR), delivery within {l.deliverWithinHours} hours.{l.detail ? ` ${l.detail}` : ''}</p>
          {l.kind === 'request' ? (l.quotes?.length ? (
            <ul className="er-dir-quotes" aria-label={`Quotes on ${l.title}`}>{l.quotes.map((q) => (
              <li key={q.id} className={q.simulated ? 'sim' : ''}>
                <span className="er-dir-q"><b>{fmt.inr(q.amount, true)}</b>, within {q.deliverWithinHours} hours, from {byWords(q.by)}{q.simulated ? <> <Stamp tone="plain">Simulated</Stamp></> : null}
                  {q.dispute ? <span className="small faint"> With a review and dispute step; @{q.dispute.deciderHandle} decides a dispute.</span> : null}
                  {q.note ? <span className="small faint"> “{q.note}”</span> : null}</span>
                <span className="er-dir-act">{q.simulated ? <span className="small faint">Cannot be chosen</span> : q.state === 'open' && l.state === 'open' ? <Btn small busy={choose.busy} onClick={() => void choose.run(l, q)}>Choose @{q.by.handle}'s quote</Btn> : <span className="small">{STATE[q.state] ?? q.state}</span>}</span>
              </li>))}</ul>
          ) : <p className="small faint">No quotes yet.</p>) : null}
          {said?.id === l.id ? <Note tone="ok" title="Chosen">{said.text}</Note> : null}
          {l.state === 'open' ? <div><Btn small tone="quiet" busy={close.busy} onClick={() => void close.run(l)}>Close it</Btn></div> : null}
        </article>
      ))}

      <h3 className="er-sub">Open in the directory</h3>
      {d.listings.length === 0 ? <p className="small faint">Nothing is listed by other households yet.</p> : d.listings.map((l) => (
        <article key={l.id} className={`panel er-dir-item${l.simulated ? ' sim' : ''}`} aria-label={l.title}>
          <div className="er-dir-top"><Stamp tone="plain">{l.kind === 'request' ? 'Asks for work' : 'Offers work'}</Stamp>{l.simulated ? <Stamp tone="plain">Simulated</Stamp> : null}<strong>{l.title}</strong></div>
          <p className="small">{byWords(l.by)}. {workWords(l.problem)}. {l.kind === 'request' ? 'Budget' : 'Price'} {fmt.inr(l.amount, true)} (test tINR), delivery within {l.deliverWithinHours} hours.{l.detail ? ` ${l.detail}` : ''}</p>
          {l.simulated ? <p className="small faint">Simulated: it cannot be quoted on or taken.</p> : l.kind === 'request' ? <>
            {l.yourQuote ? <p className="small">You quoted {fmt.inr(l.yourQuote.amount, true)}, within {l.yourQuote.deliverWithinHours} hours. A new quote replaces it.</p> : null}
            {quoting === l.id ? <QuoteForm l={l} onCancel={() => setQuoting(null)} onDone={() => { setQuoting(null); v.reload() }} /> : <div><Btn small onClick={() => setQuoting(l.id)}>{l.yourQuote ? 'Quote again' : 'Send a quote'}</Btn></div>}
          </> : <div>{said?.id === l.id ? <Note tone="ok" title="Taken">{said.text}</Note> : <Btn small busy={take.busy} onClick={() => void take.run(l)}>Take it at {fmt.inr(l.amount, true)}</Btn>}</div>}
        </article>
      ))}

      {d.sent.length ? <>
        <h3 className="er-sub">Quotes you sent</h3>
        <ul className="er-dir-quotes">{d.sent.map((q) => <li key={q.id}><span className="er-dir-q">{fmt.inr(q.amount, true)} for “{q.listing?.title}” (@{q.listing?.by.handle})</span><span className="er-dir-act small">{STATE[q.state] ?? q.state}{q.state === 'chosen' ? ': the job is under "Work paid through escrow on the chain"' : ''}</span></li>)}</ul>
      </> : null}
    </section>
  )
}

function QuoteForm({ l, onCancel, onDone }: { l: DListing; onCancel: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState<number | null>(l.amount)
  const [hours, setHours] = useState(String(l.deliverWithinHours))
  const [note, setNote] = useState('')
  const [decider, setDecider] = useState('')
  const send = useAction(async () => {
    await api('POST', `/api/earn/directory/listings/${l.id}/quotes`, { amount: amount ?? 0, deliverWithinHours: Number(hours), note, ...(decider.trim() ? { dispute: { deciderHandle: decider.trim().replace(/^@/, '') } } : {}) })
    onDone()
  })
  const f = send.error?.fields ?? {}
  return (
    <form className="er-form" aria-label={`Quote on ${l.title}`} onSubmit={(e) => { e.preventDefault(); void send.run() }}>
      <div className="er-fields">
        <Field label="Your price" error={f.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label="Deliver within, hours" error={f.deliverWithinHours}>{(p) => <input {...p} className="input" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
      </div>
      <Field label="A note for them" hint="Optional, up to 400 characters.">{(p) => <input {...p} className="input" maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <Field label="Who decides a dispute (optional)" hint="A third household's handle. With one, the client reviews verified work and may dispute it, on the paper escrow's default periods; without, the escrow pays you as soon as the verifier accepts it." error={f.deciderHandle}>{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={decider} onChange={(e) => setDecider(e.target.value)} />}</Field>
      {send.error && Object.keys(f).length === 0 ? <Problem error={send.error} /> : null}
      <div className="er-form-go"><Btn tone="fill" type="submit" busy={send.busy}>Send the quote</Btn><Btn tone="quiet" onClick={onCancel}>Not now</Btn><p className="small faint">Sending a quote moves no money and signs nothing. If they choose it, the job appears under your work through the escrow, for you to offer with your passkey.</p></div>
    </form>
  )
}

function PublishForm({ hasWallet, onDone }: { hasWallet: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<'request' | 'offer'>('request')
  const [title, setTitle] = useState(''), [detail, setDetail] = useState('')
  const [assets, setAssets] = useState<{ name: string; pct: string }[]>([{ name: '', pct: '' }, { name: '', pct: '' }])
  const [amount, setAmount] = useState<number | null>(null)
  const [hours, setHours] = useState('24')
  const publish = useAction(async () => {
    await api('POST', '/api/earn/directory/listings', { kind, title, detail, problem: { kind: 'custom', assets: assets.map((a) => ({ name: a.name, volatilityBps: Math.round(Number(a.pct) * 100) })) }, amount: amount ?? 0, deliverWithinHours: Number(hours) })
    onDone()
  })
  const f = publish.error?.fields ?? {}
  return (
    <form className="er-form" aria-label="Publish in the directory" onSubmit={(e) => { e.preventDefault(); void publish.run() }}>
      {!hasWallet ? <Note tone="wait" title="An on-chain wallet first">Work in the directory is paid through the escrow on the chain. Set up your on-chain wallet under Vault before you publish.</Note> : null}
      <div className="field"><span className="legend">You</span>
        <div className="seg" role="group" aria-label="Offer or request">
          <button type="button" aria-pressed={kind === 'request'} onClick={() => setKind('request')}>Need this work done</button>
          <button type="button" aria-pressed={kind === 'offer'} onClick={() => setKind('offer')}>Offer to do this work</button>
        </div>
      </div>
      <div className="form-grid">
        <Field label="The work, in a few words" error={f.title}>{(p) => <input {...p} className="input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Anything else they should know" hint="Optional, up to 600 characters.">{(p) => <input {...p} className="input" maxLength={600} value={detail} onChange={(e) => setDetail(e.target.value)} />}</Field>
      </div>
      <fieldset className="er-ms-fields">
        <legend className="legend">The assets whose lowest-risk mix is certified</legend>
        <p className="small faint">The work the escrow on the chain can settle: a minimum-variance portfolio of 2 to 6 assets, from their yearly swings, taken as unrelated. Figures you choose, not market data or advice.</p>
        {assets.map((a, i) => (
          <div className="er-fields" key={i}>
            <Field label={`Asset ${i + 1}`}>{(p) => <input {...p} className="input" maxLength={40} value={a.name} onChange={(e) => setAssets((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}</Field>
            <Field label="Yearly swing, %">{(p) => <input {...p} className="input" inputMode="decimal" value={a.pct} onChange={(e) => setAssets((s) => s.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />}</Field>
          </div>
        ))}
        {assets.length < 6 ? <div><Btn small onClick={() => setAssets((s) => [...s, { name: '', pct: '' }])}><Plus aria-hidden="true" />Add an asset</Btn></div> : null}
      </fieldset>
      <div className="er-fields">
        <Field label={kind === 'request' ? 'Your budget' : 'Your price'} error={f.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label="Delivery within, hours" error={f.deliverWithinHours}>{(p) => <input {...p} className="input" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
      </div>
      {publish.error && Object.keys(f).length === 0 ? <Problem error={publish.error} /> : null}
      <div className="er-form-go"><Btn tone="fill" type="submit" busy={publish.busy}>Publish it</Btn><p className="small faint">Every household in this QED installation can see it, by your handle. Publishing moves no money and signs nothing.</p></div>
    </form>
  )
}
