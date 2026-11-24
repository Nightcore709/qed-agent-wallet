/**
 * Money in other currencies on the screens (R13 section 7; Meridian, DESIGN.md M4, M8, M10, M12).
 *
 * - Home and Save: the household's balances, each in its own currency at its own precision, and one total in rupees only
 *   with a priced conversion for every line: each line names its rate, the rate's kind and source, and when it was
 *   observed (server/fx.ts pricedTotal). A currency without a usable rate means no total, and says why.
 * - Save: the paper desk's executable quote (rate, spread, fee, expiry, source), approved with the passkey on the same
 *   sheet as every payment, filled once, with rate, spread and fee kept apart on the fill; and a goal in another currency.
 * - Spend: a payee abroad, and a payment on a paper route with its quote, fee, value date and what the payee receives; a
 *   route QED does not offer is refused with the server's reason, never rerouted; a duplicate is held for confirmation.
 *
 * Every figure and every sentence about money comes from the server, which works in integer minor units; the screen
 * only places them. Paper only: no real money moves.
 */
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { api, ApiError, fmt, useData } from '../lib/core.ts'
import { ActionDoc, ApprovalSheet } from '../ui/instrument.tsx'
import { Btn, Field, Note, Problem, StateStamp, useAction } from '../ui/kit.tsx'

// ------------------------------------------------------------------------------------------------ what the server sends

interface Line { label: string; value: string; basis: string; note?: string }
interface Preview { approvalId: string; docHash: string; document: string; expiresAt: number; summary: string; lines: Line[]; warnings?: string[] }
interface Reference { midText: string; source: string; label: string }
interface Fill { fillId: string; duplicate: boolean; sellText: string; buyText: string; rate: string; spreadBps: number; spreadText: string; feeText: string; reference: Reference & { base: string }; filledAt: number }
interface PricedLine { currency: string; balanceText: string; rate: string | null; source: string | null; label: string | null; observedText: string | null; valueText: string | null }
interface FxGoal { id: string; name: string; currency: string; currencyName: string; targetText: string; byText: string; heldText: string; leftText: string; progressPermille: number; monthsLeft: number; perMonthText: string; status: 'reached' | 'date-passed' | 'on-the-way'; words: string
  leftInRupees: { text: string; rate: string; source: string; label: string; observedText: string } | null; perMonthInRupees: { text: string } | null }
export interface MoneyView {
  zone: string; zoneLabel: string; jurisdiction: string; atText: string
  currencies: { code: string; name: string; minorUnit: number }[]
  balances: { currency: string; name: string; minorUnit: number; minor: string; text: string; availableText: string }[]
  total: { text: string | null; why: string | null; rule: string; lines: PricedLine[] }
  desk: { name: string; feeText: string; spreadBps: Record<string, number>; words: string; ttlSeconds: number; rounding: string }
  lrs: { usedText: string; leftText: string; ceilingText: string; fyStartText: string; source: string; url: string; label: string; heldNote: string }
  fills: Fill[]
  goals: FxGoal[]
}
interface Payee { id: string; name: string; country: string; countryName: string; currency: string; scheme: string; account: string }
interface Route { id: string; name: string; currency: string; countries: { code: string; name: string }[]; feeText: string; valueDays: number; cutoff: string; calendar: string; calendarWords: string }
interface Payment {
  id: string; duplicateOf: string | null; state: 'in_transit' | 'credited'; stateWords: string; finality: string
  payee: { name: string; countryName: string; account: string }; route: { name: string; calendar: string; calendarWords: string }
  purposeWords: string; amountText: string; fundedFrom: string; debitText: string; feeText: string; tcsText: string | null; tcsWhy: string | null
  rate: string | null; spreadBps: number | null; spreadText: string | null; reference: Reference | null
  sentText: string; valueDateText: string; creditedText: string | null; reconciliation: { state: 'reconciled' | 'break'; checks: string[]; breaks: string[] }
}
interface AbroadView { payees: Payee[]; countries: { code: string; name: string; scheme: 'iban' | 'aba' | 'bic-account'; ibanNote?: string }[]; routes: Route[]; purposes: { id: string; words: string }[]; refusedPurposes: { id: string; why: string }[]; payments: Payment[]; tcs: { computed: boolean; why: string }; duplicateWindowHours: number }

const KIND_WORDS: Record<string, string> = { historical: 'recorded reference', synthetic: 'synthetic reference', observation: 'reference', fixture: 'test reference' }
const kindWords = (label: string | null): string => (label ? KIND_WORDS[label] ?? `${label} reference` : '')
const pending = (p: Preview | null) => (p ? { approvalId: p.approvalId, docHash: p.docHash, expiresAt: p.expiresAt, requiresStepUp: true } : null)

// ------------------------------------------------------------------------------------------------ balances by currency

/**
 * Each currency apart, and one total only with a priced conversion: the total names every rate, its kind, its source and
 * when it was observed (Home: holdings by currency; Save: balances by currency).
 */
export function ByCurrency({ variant, money }: { variant: 'home' | 'save'; money?: MoneyView | null }) {
  const own = useData<MoneyView>(money === undefined ? '/api/money' : null)
  const m = money ?? own.data
  const id = `ccy-${variant}-h`
  if (!m) return <section data-col="2" className="panel ccy" aria-labelledby={id} aria-busy={!own.error}><div className="panel-head"><h2 id={id}>{variant === 'home' ? 'Holdings by currency' : 'Balances by currency'}</h2></div>{own.error ? <Problem error={own.error} /> : <p className="loading-line">Reading your balances…</p>}</section>
  const foreign = m.balances.filter((b) => b.currency !== 'INR')
  return (
    <section data-col="2" className="panel ccy" aria-labelledby={id} data-testid={`by-currency-${variant}`}>
      <div className="panel-head"><h2 id={id}>{variant === 'home' ? 'Holdings by currency' : 'Balances by currency'}</h2><p>At the paper bank, each in its own currency</p></div>
      {m.total.text
        ? <p className="ccy-total"><span className="ccy-total-k">{foreign.length ? 'All of it in rupees, at the reference rates below' : 'In rupees'}</span><span className="ccy-total-v" data-testid="ccy-total">{foreign.length ? `about ${m.total.text}` : m.total.text}</span></p>
        : <Note tone="wait" title="No total in rupees">{m.total.why}</Note>}
      <ul className="ccy-list">
        {m.balances.map((b) => {
          const line = m.total.lines.find((l) => l.currency === b.currency)
          return (
            <li key={b.currency} className="ccy-row" data-currency={b.currency}>
              <span className="ccy-code">{b.currency}</span>
              <span className="ccy-name">{b.name}<small>{b.minorUnit === 0 ? 'No decimal places' : `${b.minorUnit} decimal places`} (ISO 4217)</small></span>
              <span className="ccy-bal">{b.text}</span>
              {b.currency !== 'INR' ? <span className="ccy-val">{line?.rate ? <>{line.valueText} at ₹{line.rate} per {b.currency}<small>{kindWords(line.label)}, observed {line.observedText}</small></> : <small>No usable rate: not counted in a total</small>}</span> : null}
            </li>
          )
        })}
      </ul>
      {foreign.length ? <p className="small muted ccy-rule">{m.total.rule}</p> : <p className="small muted ccy-rule">You hold rupees only. Change some into another currency under Save, or pay someone abroad under Spend.</p>}
      {foreign.length ? <details className="ccy-src"><summary>Where each rate comes from</summary><ul>{m.total.lines.filter((l) => l.source).map((l) => <li key={l.currency}><b>{l.currency}</b>: {l.source}</li>)}</ul></details> : null}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the paper desk (Save)

/** Rate, spread and fee kept apart, as the fill records them (R7-038). */
function FillCard({ f }: { f: Fill }) {
  return (
    <article className="fx-fill" aria-label="The conversion">
      <div className="fx-fill-head"><StateStamp state="done" /><span>{f.sellText} changed into <b>{f.buyText}</b></span></div>
      <dl className="fx-facts">
        <div><dt>Filled at</dt><dd>₹{f.rate} per {f.reference.base.slice(8)}<small>The quote's executable rate, as approved</small></dd></div>
        <div><dt>Reference</dt><dd>₹{f.reference.midText}<small>{kindWords(f.reference.label)}: {f.reference.source}. Nobody can trade at it.</small></dd></div>
        <div><dt>Spread</dt><dd>{(f.spreadBps / 100).toFixed(2)}%<small>Cost {f.spreadText} against the reference</small></dd></div>
        <div><dt>Fee</dt><dd>{f.feeText}<small>Charged apart from the rate</small></dd></div>
      </dl>
    </article>
  )
}

function Convert({ m, onDone }: { m: MoneyView; onDone: () => void }) {
  const held = m.balances.filter((b) => b.currency !== 'INR' && b.minor !== '0').map((b) => b.currency)
  const [sell, setSell] = useState('INR')
  const [buy, setBuy] = useState('USD')
  const [fixed, setFixed] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [pv, setPv] = useState<Preview | null>(null)
  const [done, setDone] = useState<Fill | null>(null)
  const buyChoices = sell === 'INR' ? m.currencies.filter((c) => c.code !== 'INR') : m.currencies.filter((c) => c.code === 'INR')
  const target = buyChoices.some((c) => c.code === buy) ? buy : buyChoices[0]!.code
  const amountIn = fixed === 'buy' ? target : sell
  const unit = m.currencies.find((c) => c.code === amountIn)?.minorUnit ?? 2
  const quote = useAction(async () => { setDone(null); setPv(await api<Preview>('POST', '/api/fx/quote', { sell, buy: target, amount, fixed })) })
  const submit = (e: FormEvent) => { e.preventDefault(); void quote.run() }
  return (
    <section data-col="1" className="panel fx-desk" aria-labelledby="fx-h">
      <div className="panel-head"><h2 id="fx-h">Change money between currencies</h2><p>{m.desk.name}: an executable quote for {m.desk.ttlSeconds} seconds</p></div>
      <form className="fx-form" onSubmit={submit} aria-describedby="fx-rule">
        <Field label="From">{(p) => <select {...p} className="input" value={sell} onChange={(e) => { setSell(e.target.value); if (e.target.value !== 'INR') setBuy('INR'); else if (buy === 'INR') setBuy('USD') }}>
          <option value="INR">Rupees (INR)</option>{held.map((c) => <option key={c} value={c}>{m.currencies.find((x) => x.code === c)?.name} ({c})</option>)}
        </select>}</Field>
        <Field label="Into">{(p) => <select {...p} className="input" value={target} onChange={(e) => setBuy(e.target.value)}>{buyChoices.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}</select>}</Field>
        <div className="field"><span className="legend" id="fx-fixed-l">The amount is what you</span>
          <div className="seg" role="group" aria-labelledby="fx-fixed-l">
            <button type="button" aria-pressed={fixed === 'buy'} onClick={() => setFixed('buy')}>Receive</button>
            <button type="button" aria-pressed={fixed === 'sell'} onClick={() => setFixed('sell')}>Pay</button>
          </div>
        </div>
        <Field label={`Amount in ${amountIn}`} hint={`${amountIn} has ${unit === 0 ? 'no decimal places' : `${unit} decimal places`} (ISO 4217)`} error={quote.error?.fields.amount}>{(p) => <input {...p} className="input" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Btn tone="fill" type="submit" busy={quote.busy} disabled={!amount.trim()}>Get a quote</Btn>
      </form>
      {quote.error && !quote.error.fields.amount ? <Problem error={quote.error} /> : null}
      <p className="small muted" id="fx-rule">Spread {(m.desk.spreadBps[target === 'INR' ? sell : target] ?? 0) / 100}% over the reference, fee {m.desk.feeText}, each shown apart. {m.desk.rounding}</p>
      <p className="small faint">{m.desk.words}</p>
      <p className="small muted" data-testid="lrs-held-note">Liberalised Remittance Scheme: {m.lrs.heldNote}</p>
      {done ? <FillCard f={done} /> : null}
      {m.fills.length ? <details className="fx-past"><summary>Conversions so far ({m.fills.length})</summary><ul>{m.fills.map((f) => <li key={f.fillId}><span>{f.sellText} into <b>{f.buyText}</b></span><span>at ₹{f.rate}, spread {(f.spreadBps / 100).toFixed(2)}%, fee {f.feeText}</span><span className="faint">{fmt.dayTime(f.filledAt)}</span></li>)}</ul></details> : null}
      <ApprovalSheet approval={pending(pv)} title="Approve this conversion" action="Approve and convert" onClose={() => setPv(null)}
        onApproved={async (approvalId) => { const f = await api<Fill>('POST', '/api/fx/convert', { approvalId }); setPv(null); setDone(f); setAmount(''); onDone() }}>
        {pv ? <ActionDoc summary={pv.summary} lines={pv.lines} warnings={pv.warnings ?? []} document={pv.document} /> : null}
      </ApprovalSheet>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ a goal in another currency (Save)

function FxGoals({ m, onChanged }: { m: MoneyView; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [g, setG] = useState({ name: '', currency: 'JPY', target: '', by: '' })
  const add = useAction(async () => { await api('POST', '/api/fx/goals', g); setOpen(false); setG({ name: '', currency: 'JPY', target: '', by: '' }); onChanged() })
  const remove = useAction(async (id: string) => { await api('POST', `/api/fx/goals/${id}/remove`); onChanged() })
  const unit = m.currencies.find((c) => c.code === g.currency)?.minorUnit ?? 2
  const E = (k: string) => add.error?.fields[k]
  return (
    <section data-col="2" className="panel fx-goals" aria-labelledby="fxg-h">
      <div className="panel-head"><h2 id="fxg-h">A goal in another currency</h2><p>Counted from your balance in that currency</p></div>
      {m.goals.length === 0 ? <p className="small muted">No goal in another currency yet. A goal in rupees is set up under Saving for a goal.</p> : (
        <ul className="fxg-list">
          {m.goals.map((x) => (
            <li key={x.id} className="fxg" data-currency={x.currency}>
              <div className="fxg-top"><b>{x.name}</b><span>{x.targetText} by {x.byText}</span></div>
              <div className="fxg-bar" aria-hidden="true"><i style={{ width: `${x.progressPermille / 10}%` }} /></div>
              <p className="fxg-fig"><b>{x.heldText}</b> held of {x.targetText} ({(x.progressPermille / 10).toFixed(1)}%){x.status === 'reached' ? '. Reached.' : x.status === 'date-passed' ? '. The date has passed.' : ''}</p>
              {x.status === 'on-the-way' ? <p className="small">{x.leftText} left: {x.perMonthText} a month over {x.monthsLeft} month{x.monthsLeft === 1 ? '' : 's'}{x.leftInRupees ? <>; about {x.leftInRupees.text} in rupees{x.perMonthInRupees ? ` (about ${x.perMonthInRupees.text} a month)` : ''} at ₹{x.leftInRupees.rate} per {x.currency}, a {kindWords(x.leftInRupees.label)} observed {x.leftInRupees.observedText}</> : null}.</p> : null}
              <p className="small faint">{x.words}</p>
              <Btn small onClick={() => void remove.run(x.id)} busy={remove.busy}>Stop this goal</Btn>
            </li>
          ))}
        </ul>
      )}
      {remove.error ? <Problem error={remove.error} /> : null}
      {open ? (
        <form className="fxg-form" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
          <Field label="What it is for" error={E('name')}>{(p) => <input {...p} className="input" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />}</Field>
          <Field label="Currency" error={E('currency')}>{(p) => <select {...p} className="input" value={g.currency} onChange={(e) => setG({ ...g, currency: e.target.value })}>{m.currencies.filter((c) => c.code !== 'INR').map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}</select>}</Field>
          <Field label={`Target in ${g.currency}`} hint={`${unit === 0 ? 'No decimal places' : `${unit} decimal places`} (ISO 4217)`} error={E('target')}>{(p) => <input {...p} className="input" inputMode="decimal" value={g.target} onChange={(e) => setG({ ...g, target: e.target.value })} />}</Field>
          <Field label="By" error={E('by')}>{(p) => <input {...p} className="input" type="date" value={g.by} onChange={(e) => setG({ ...g, by: e.target.value })} />}</Field>
          <div className="fxg-acts"><Btn tone="fill" type="submit" busy={add.busy}>Add the goal</Btn><Btn onClick={() => setOpen(false)}>Not now</Btn></div>
          {add.error && !Object.keys(add.error.fields).length ? <Problem error={add.error} /> : null}
        </form>
      ) : <Btn onClick={() => setOpen(true)}><Plus aria-hidden="true" />Add a goal in another currency</Btn>}
    </section>
  )
}

/** Save's part: balances by currency, the paper desk, and a goal in another currency. */
export function SaveInCurrencies() {
  const m = useData<MoneyView>('/api/money')
  if (!m.data) return <section className="panel ccy" aria-busy={!m.error}>{m.error ? <Problem error={m.error} /> : <p className="loading-line">Reading your balances in each currency…</p>}</section>
  return (
    <div className="ccy-save">
      <ByCurrency variant="save" money={m.data} />
      <Convert m={m.data} onDone={() => m.reload()} />
      <FxGoals m={m.data} onChanged={() => m.reload()} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ payments abroad (Spend)

function AddAbroadPayee({ v, onAdded }: { v: AbroadView; onAdded: (id: string) => void }) {
  const [f, setF] = useState({ name: '', country: 'US', currency: 'USD', account: '', routing: '', bank: '' })
  const scheme = v.countries.find((c) => c.code === f.country)?.scheme ?? 'iban'
  const [checked, setChecked] = useState(false)
  const add = useAction(async () => { const p = await api<{ id: string }>('POST', '/api/abroad/payees', { name: f.name, country: f.country, currency: f.currency, account: f.account, ...(scheme === 'aba' ? { routing: f.routing } : {}), ...(scheme === 'bic-account' ? { bank: f.bank } : {}), ...(checked ? { confirmLookalike: true } : {}) }); onAdded(p.id) })
  // a payee that looks like one the owner already pays: the server's words, and the owner's confirmation that they checked
  const look = add.error?.code === 'lookalike' ? add.error : null
  const E = (k: string) => add.error?.fields[k]
  return (
    <form className="ab-add" onSubmit={(e) => { e.preventDefault(); void add.run() }} aria-label="Add a payee abroad">
      <Field label="Payee's name" error={E('name')}>{(p) => <input {...p} className="input" autoComplete="off" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <Field label="Country" error={E('country')}>{(p) => <select {...p} className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{v.countries.map((c) => <option key={c.code} value={c.code}>{c.name.replace(/^the /, '').replace(/^./, (x) => x.toUpperCase())}</option>)}</select>}</Field>
      <Field label="Currency they receive" error={E('currency')}>{(p) => <select {...p} className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'BHD'].map((c) => <option key={c} value={c}>{c}</option>)}</select>}</Field>
      {scheme === 'aba' ? <Field label="Routing number" hint="Nine digits; its checksum is checked" error={E('routing')}>{(p) => <input {...p} className="input" inputMode="numeric" autoComplete="off" value={f.routing} onChange={(e) => setF({ ...f, routing: e.target.value })} />}</Field> : null}
      {scheme === 'bic-account' ? <Field label="Bank's BIC" hint="8 or 11 characters; its country is checked" error={E('bank')}>{(p) => <input {...p} className="input" autoComplete="off" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} />}</Field> : null}
      <Field label={scheme === 'iban' ? 'IBAN' : 'Account number'} hint={scheme === 'iban' ? `Its check digits, country, length and layout are checked. ${v.countries.find((c) => c.code === f.country)?.ibanNote ?? ''}` : undefined} error={E('account')}>{(p) => <input {...p} className="input" autoComplete="off" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} />}</Field>
      {look ? <Note tone="wait" title="This payee looks like one you already have">
        <p>{look.message}</p>
        <label className="check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked this payee's account with them directly, and no message or call asked me to add it.</label>
      </Note> : null}
      <Btn tone="fill" type="submit" busy={add.busy} disabled={!!look && !checked}>{look ? 'Add it, I have checked' : 'Add this payee abroad'}</Btn>
      {add.error && !look && !Object.keys(add.error.fields).length ? <Problem error={add.error} /> : null}
    </form>
  )
}

function PaymentCard({ p }: { p: Payment }) {
  return (
    <article className="ab-sent" aria-label={`Payment abroad: ${p.amountText} to ${p.payee.name}`} data-testid="abroad-receipt">
      <div className="ab-sent-head"><StateStamp state={p.state === 'credited' ? 'done' : 'working'} recon={p.reconciliation.state} /><span><b>{p.amountText}</b> to {p.payee.name}, {p.payee.countryName}</span></div>
      <dl className="fx-facts">
        <div><dt>Where it stands</dt><dd>{p.stateWords}<small>{p.finality}</small></dd></div>
        <div><dt>Route</dt><dd>{p.route.name}<small>Value date {p.valueDateText} in the {p.route.calendar} calendar. {p.route.calendarWords}</small></dd></div>
        <div><dt>From you</dt><dd>{p.debitText}<small>{p.fundedFrom === 'INR' ? 'From your rupees, changed at the quote' : `From your ${p.fundedFrom} balance`}</small></dd></div>
        {p.rate ? <div><dt>Rate, spread</dt><dd>₹{p.rate}, {((p.spreadBps ?? 0) / 100).toFixed(2)}%<small>Spread cost {p.spreadText} against the {kindWords(p.reference?.label ?? null)} of ₹{p.reference?.midText}</small></dd></div> : null}
        <div><dt>Fee</dt><dd>{p.feeText}<small>The route's fee, charged apart</small></dd></div>
        <div><dt>Tax collected at source</dt><dd>{p.tcsText ?? 'Not computed'}{p.tcsWhy ? <small>Its rates are in the Income-tax Act, whose text QED has not read; your bank would collect it.</small> : null}</dd></div>
        <div><dt>The books</dt><dd>{p.reconciliation.state === 'reconciled' ? 'Match this payment\'s record' : 'Do not match its record'}<small>{(p.reconciliation.state === 'reconciled' ? p.reconciliation.checks : p.reconciliation.breaks).join('. ')}</small></dd></div>
      </dl>
    </article>
  )
}

/** Spend's part: a payee abroad, and a payment on a paper route with its quote. */
export function PayAbroad() {
  const v = useData<AbroadView>('/api/abroad')
  const m = useData<MoneyView>('/api/money')
  const [payeeId, setPayeeId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('family')
  const [from, setFrom] = useState('INR')
  const [pv, setPv] = useState<Preview | null>(null)
  const [held, setHeld] = useState<ApiError | null>(null)
  const [sent, setSent] = useState<Payment | null>(null)
  const payee = v.data?.payees.find((p) => p.id === payeeId) ?? null
  const route = payee ? v.data?.routes.find((r) => r.currency === payee.currency && r.countries.some((c) => c.code === payee.country)) ?? null : null
  const heldIn = payee ? m.data?.balances.find((b) => b.currency === payee.currency && b.minor !== '0') ?? null : null
  const unit = payee ? m.data?.currencies.find((c) => c.code === payee.currency)?.minorUnit ?? 2 : 2
  const prepare = useAction(async (confirmDuplicateOf?: string) => {
    setHeld(null); setSent(null)
    try { setPv(await api<Preview>('POST', '/api/abroad/prepare', { payeeId, amount, purpose, from: heldIn ? from : 'INR', ...(confirmDuplicateOf ? { confirmDuplicateOf } : {}) })) } catch (e) {
      if (e instanceof ApiError && e.code === 'held_duplicate') { setHeld(e); return }
      throw e
    }
  })
  if (!v.data) return <section className="panel ab" aria-busy={!v.error}>{v.error ? <Problem error={v.error} /> : <p className="loading-line">Reading payees abroad…</p>}</section>
  const d = v.data
  return (
    <section className="panel ab" aria-labelledby="ab-h" id="abroad">
      <div className="panel-head"><h2 id="ab-h">Pay someone abroad</h2><p>On a paper route: the payee receives nothing real</p></div>
      <div className="ab-grid">
        <div className="ab-form">
          <fieldset className="ab-payees">
            <legend className="legend">Who</legend>
            {d.payees.length ? d.payees.map((p) => (
              <label key={p.id} className={`ab-payee ${payeeId === p.id ? 'on' : ''}`}>
                <input type="radio" name="abroad-payee" value={p.id} checked={payeeId === p.id} onChange={() => { setPayeeId(p.id); setFrom('INR'); setPv(null); setHeld(null) }} />
                <span><b>{p.name}</b><small>{p.countryName.replace(/^the /, '')}, {p.currency}, {p.account}</small></span>
              </label>
            )) : <p className="small muted">No payee abroad yet.</p>}
            {adding ? <AddAbroadPayee v={d} onAdded={(id) => { setAdding(false); setPayeeId(id); v.reload() }} /> : <Btn small onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add a payee abroad</Btn>}
          </fieldset>
          {payee ? <form className="ab-pay" onSubmit={(e) => { e.preventDefault(); void prepare.run() }}>
            <Field label={`Amount they receive, in ${payee.currency}`} hint={`${payee.currency} has ${unit === 0 ? 'no decimal places' : `${unit} decimal places`} (ISO 4217)`} error={prepare.error?.fields.amount}>{(p) => <input {...p} className="input" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
            <Field label="Purpose" hint="As the RBI text lists them">{(p) => <select {...p} className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {d.purposes.map((x) => <option key={x.id} value={x.id}>{x.words}</option>)}
              <option value="margin">Margin for trading on an overseas exchange</option>
              <option value="investment">An investment abroad</option>
            </select>}</Field>
            {heldIn ? <div className="field"><span className="legend" id="ab-from-l">Pay from</span>
              <div className="seg" role="group" aria-labelledby="ab-from-l">
                <button type="button" aria-pressed={from === 'INR'} onClick={() => setFrom('INR')}>Rupees, at a quote</button>
                <button type="button" aria-pressed={from !== 'INR'} onClick={() => setFrom(payee.currency)}>My {payee.currency} balance ({heldIn.text})</button>
              </div></div> : null}
            <Btn tone="fill" type="submit" busy={prepare.busy} disabled={!amount.trim()}>See the quote and the route</Btn>
          </form> : null}
          {prepare.error && !prepare.error.fields.amount ? <Problem error={prepare.error} /> : null}
          {held ? <Note tone="wait" title="Held for your confirmation">
            <p>{held.message}</p>
            <div className="ab-held-acts"><Btn onClick={() => void prepare.run(held.fields.duplicateOf)}>It is a second payment: send it</Btn><Btn onClick={() => setHeld(null)}>Do not send it</Btn></div>
          </Note> : null}
          {sent ? <PaymentCard p={sent} /> : null}
        </div>
        <aside className="ab-facts" aria-label="The route">
          {route ? <dl className="fx-facts">
            <div><dt>Route</dt><dd>{route.name}<small>Fee {route.feeText}; credited {route.valueDays} business day{route.valueDays === 1 ? '' : 's'} after it is sent (cut-off {route.cutoff} IST), in the {route.calendar} calendar</small></dd></div>
            <div><dt>Holidays</dt><dd>{route.calendar}<small>{route.calendarWords}</small></dd></div>
          </dl> : payee ? <Note tone="void" title="No paper route for this payee">QED has no paper route that sends {payee.currency} to {payee.countryName}. Ask for a quote to see the reason in full: nothing is rerouted.</Note> : <p className="small muted">Choose who to pay to see the route, its fee and its value date.</p>}
          {m.data ? <p className="small">Liberalised Remittance Scheme, this financial year (since {m.data.lrs.fyStartText.replace(', 00:00 IST', '')}): <b>{m.data.lrs.usedText}</b> of {m.data.lrs.ceilingText} changed out of rupees. <span className="faint">{m.data.lrs.source}. {m.data.lrs.heldNote} {m.data.lrs.label}</span></p> : null}
          <p className="small faint">{d.tcs.why}</p>
          <p className="small faint">A payment to the same payee for the same amount within {d.duplicateWindowHours} hours is held until you confirm it.</p>
        </aside>
      </div>
      {d.payments.length ? <details className="ab-past" open={!sent}><summary>Payments abroad ({d.payments.length})</summary><ul>{d.payments.map((p) => <li key={p.id}><StateStamp state={p.state === 'credited' ? 'done' : 'working'} recon={p.reconciliation.state} /><span><b>{p.amountText}</b> to {p.payee.name}</span><span className="faint">{p.stateWords}</span></li>)}</ul></details> : null}
      <ApprovalSheet approval={pending(pv)} title="Approve this payment abroad" action="Approve and send" onClose={() => setPv(null)}
        onApproved={async (approvalId) => { const p = await api<Payment>('POST', '/api/abroad/pay', { approvalId }); setPv(null); setSent(p); setAmount(''); v.reload(); m.reload() }}>
        {pv ? <ActionDoc summary={pv.summary} lines={pv.lines} warnings={pv.warnings ?? []} document={pv.document} /> : null}
      </ApprovalSheet>
    </section>
  )
}
