/**
 * Spend: services QED can buy for you (R13, S2; server/commerce.ts). Two simulated paywalled services answer a request with
 * a priced quote (HTTP 402, in the style of the x402 pattern); QED compares the quotes and, only inside a mandate you sign
 * with your passkey (a limit for one purchase, a limit for a month, the services allowed), pays one on the paper rail. Every
 * purchase is kept with the quotes compared, the checks made and its receipt; one outside the mandate is refused with the
 * reason. Both services are test doubles on this computer and no real money moves.
 */
import { Check, ShoppingBag, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, fmt, useData } from '../lib/core.ts'
import { ApprovalSheet, type PendingApproval } from '../ui/instrument.tsx'
import { Btn, EmptyState, Field, Link, Loading, MoneyInput, Note, Problem, Stamp, useAction } from '../ui/kit.tsx'

interface Mandate { id: string; version: number; perPurchase: number; perMonth: number; services: string[]; expiresAt: number }
interface Quote { serviceId: string; serviceName: string; ok: boolean; error: string | null; amount: number | null; allowed: boolean }
interface Purchase { id: string; sku: string; title: string; serviceName: string | null; amount: number | null; state: string; reason: string | null; checks: { name: string; ok: boolean; detail: string }[]; actionId: string | null; receipt: { excerpt?: string; contentHash?: string; paymentRef?: string } | null; createdAt: number }
interface State { mandate: Mandate | null; spentThisMonth: number; services: { id: string; name: string; payTo: string }[]; products: { sku: string; title: string; blurb: string }[]; purchases: Purchase[]; note: string }
interface Compared { sku: string; title: string; quotes: Quote[]; cheapest: string | null; cheapestAllowed: string | null }
type Prepared = PendingApproval & { document: string }

const TONE: Record<string, 'ok' | 'void' | 'wait' | 'plain'> = { paid: 'ok', refused: 'void', failed: 'void', undelivered: 'void', paying: 'wait' }
const WORD: Record<string, string> = { paid: 'Bought', refused: 'Refused', failed: 'Not paid', undelivered: 'Paid, not delivered', paying: 'Paying' }

export function Commerce() {
  const { data, error, reload } = useData<State>('/api/commerce', ['action'])
  const [perPurchase, setPerPurchase] = useState<number | null>(5000)
  const [perMonth, setPerMonth] = useState<number | null>(10000)
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [days, setDays] = useState(30)
  const [sheet, setSheet] = useState<Prepared | null>(null)
  const [sku, setSku] = useState('')
  const [cmp, setCmp] = useState<Compared | null>(null)
  const prepare = useAction(async () => {
    const services = chosen ?? data?.services.map((s) => s.id) ?? []
    setSheet(await api<Prepared>('POST', '/api/commerce/mandate', { perPurchase, perMonth, services, days }))
  })
  const revoke = useAction(async () => { await api('POST', '/api/commerce/mandate/revoke'); reload() })
  const compare = useAction(async (s: string) => { setCmp(await api<Compared>('POST', '/api/commerce/quotes', { sku: s })) })
  // One key for one intent: kept while an attempt has not been answered (a dropped connection, then a retry finds the first), dropped when it has.
  const keys = useRef(new Map<string, string>())
  const buy = useAction(async (s: string, serviceId?: string) => { const slot = `${s}|${serviceId ?? ''}`; const idempotencyKey = keys.current.get(slot) ?? (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`); keys.current.set(slot, idempotencyKey); await api('POST', '/api/commerce/purchases', { sku: s, ...(serviceId ? { serviceId } : {}), idempotencyKey }); keys.current.delete(slot); reload(); await compare.run(s) })
  const what = (() => { try { return (JSON.parse(sheet?.document ?? '{}') as { what?: string; note?: string }) } catch { return {} } })()
  const m = data?.mandate ?? null
  const product = sku || data?.products[0]?.sku || ''
  const picked = chosen ?? data?.services.map((s) => s.id) ?? []
  return (
    <section className="panel pay-commerce" aria-labelledby="cm-h">
      <div className="pay-sec-head cm-head"><div><h2 id="cm-h">Services QED can buy for you</h2><p>Simulated: two test services on this computer, paid on the paper rail. No real money moves and no real merchant is involved.</p>
        {data?.note ? <details className="disclose cm-note"><summary>What is simulated, and what is not claimed</summary><p>{data.note}</p></details> : null}</div></div>
      {error ? <Problem error={error} /> : !data ? <Loading what="Reading the mandate" /> : <div className="cm-grid">
        <div className="cm-mandate">
          <h3>Your mandate</h3>
          {m ? <>
            <dl className="kv cm-terms">
              <div><dt>One purchase</dt><dd>up to {fmt.money(m.perPurchase, true)}</dd></div>
              <div><dt>One month</dt><dd>up to {fmt.money(m.perMonth, true)}; {fmt.money(data.spentThisMonth, true)} bought or being paid this month</dd></div>
              <div><dt>Services</dt><dd>{m.services.map((id) => data.services.find((s) => s.id === id)?.name ?? id).join(', ')}</dd></div>
              <div><dt>In force</dt><dd>Version {m.version}, until {fmt.dayYear(m.expiresAt)}</dd></div>
            </dl>
            <div className="cm-acts"><Btn small tone="quiet" busy={revoke.busy} onClick={() => void revoke.run()}>Revoke the mandate</Btn><span className="pay-quiet">Revoking only narrows what QED may do, so it needs no passkey. Signing a new mandate replaces this one.</span></div>
            <Problem error={revoke.error} />
          </> : <p className="cm-none">No mandate is signed, so QED buys nothing. Set one below and sign it with your passkey.</p>}
          <details className="disclose cm-set" open={!m}>
            <summary>{m ? 'Sign a different mandate' : 'Set a mandate'}</summary>
            <form className="cm-form" onSubmit={(e) => { e.preventDefault(); void prepare.run() }}>
              <div className="form-grid cols-3 fields cm-fields">
                <Field label="Most for one purchase" error={prepare.error?.fields?.perPurchase}>{(p) => <MoneyInput {...p} value={perPurchase} onChange={setPerPurchase} />}</Field>
                <Field label="Most in one month" error={prepare.error?.fields?.perMonth}>{(p) => <MoneyInput {...p} value={perMonth} onChange={setPerMonth} />}</Field>
                <Field label="Lasts (days)" error={prepare.error?.fields?.days}>{(p) => <input {...p} className="input" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />}</Field>
              </div>
              <fieldset className="cm-services"><legend>Services QED may buy from</legend>
                {data.services.map((s) => <label key={s.id}><input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setChosen(e.target.checked ? [...new Set([...picked, s.id])] : picked.filter((x) => x !== s.id))} /> {s.name} <small>({s.payTo})</small></label>)}
                {prepare.error?.fields?.services ? <p className="pay-err">{prepare.error.fields.services}</p> : null}
              </fieldset>
              <div className="cm-go"><Btn tone="fill" type="submit" busy={prepare.busy}>Review the mandate and sign</Btn></div>
              {prepare.error && Object.keys(prepare.error.fields ?? {}).length === 0 ? <Problem error={prepare.error} /> : null}
            </form>
          </details>
        </div>

        <div className="cm-buy">
          <h3>Compare quotes and buy</h3>
          <div className="cm-buy-in">
          <div className="cm-pick">
            <Field label="Product">{(p) => <select {...p} className="input" value={product} onChange={(e) => { setSku(e.target.value); setCmp(null) }}>{data.products.map((x) => <option key={x.sku} value={x.sku}>{x.title}</option>)}</select>}</Field>
            <Btn tone="fill" busy={compare.busy} onClick={() => void compare.run(product)}>Compare the two quotes</Btn>
          </div>
          {/* what the product is, and who decides, said before the quotes are asked for (R14: the same words, no longer only after) */}
          <p className="pay-quiet cm-says">{data.products.find((x) => x.sku === product)?.blurb} A service the mandate does not name is refused with the reason, and nothing is paid. The price comes from the service's own quote; the mandate decides, not the quote.</p>
          </div>
          <Problem error={compare.error} />
          {cmp ? <>
            <table className="cm-quotes"><caption className="sr">Quotes for {cmp.title}, cheapest first</caption>
              <thead><tr><th scope="col">Service</th><th scope="col">Price</th><th scope="col">Mandate</th><th scope="col"><span className="sr">Buy</span></th></tr></thead>
              <tbody>{cmp.quotes.map((q) => <tr key={q.serviceId}>
                <th scope="row">{q.serviceName}{q.serviceId === cmp.cheapest ? <small> cheapest</small> : null}</th>
                <td>{q.ok && q.amount !== null ? fmt.money(q.amount, true) : <span className="pay-err">{q.error}</span>}</td>
                <td>{q.allowed ? <span className="cm-yes"><Check aria-hidden="true" /> named</span> : <span className="cm-no"><X aria-hidden="true" /> not named</span>}</td>
                <td><Btn small tone={q.serviceId === cmp.cheapestAllowed ? 'fill' : 'quiet'} busy={buy.busy} disabled={!q.ok} onClick={() => void buy.run(cmp.sku, q.serviceId)}>Buy from {q.serviceName.split(' ')[0]}</Btn></td>
              </tr>)}</tbody>
            </table>
          </> : null}
          <Problem error={buy.error} />
        </div>

        <div className="cm-bought">
          <h3>What QED bought, and was refused</h3>
          {data.purchases.length === 0 ? <EmptyState across compact as="h4" icon={<ShoppingBag />} title="Nothing yet">A purchase, or a refusal with its reason, appears here.</EmptyState> : <ul className="cm-list">{data.purchases.map((p) => (
            <li key={p.id}>
              <span className="what"><b>{p.title}</b><small>{p.serviceName ?? 'No service'}{p.amount !== null ? `, ${fmt.money(p.amount, true)}` : ''}, {fmt.dayTime(p.createdAt)}</small>
                {p.reason ? <Note tone="void" title={p.state === 'refused' ? 'Refused, and nothing was paid' : 'What happened'}>{p.reason}</Note> : null}
                {p.receipt ? <small>Receipt: payment {p.receipt.paymentRef}; the service's reply, simulated: "{p.receipt.excerpt}"</small> : null}
                {p.actionId ? <Link to={`/record/${p.actionId}`}>The payment's record</Link> : null}
              </span>
              <span className="state"><Stamp tone={TONE[p.state] ?? 'plain'}>{WORD[p.state] ?? p.state}</Stamp></span>
            </li>))}</ul>}
        </div>
      </div>}
      <ApprovalSheet approval={sheet} title="Sign this mandate" action="Sign the mandate" onClose={() => setSheet(null)}
        onApproved={async (approvalId) => { await api('POST', '/api/commerce/mandate/activate', { approvalId }); setSheet(null); reload() }}>
        {sheet ? <article className="instrument"><div className="i-head"><span>Commerce mandate, simulated services</span><span>Not signed yet</span></div>
          <div className="i-body"><p className="i-pay">{what.what}</p><p className="small muted">{what.note}</p></div></article> : null}
      </ApprovalSheet>
    </section>
  )
}
