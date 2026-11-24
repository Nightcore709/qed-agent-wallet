/**
 * Test an idea (/holdings/idea) and the idea's record (/holdings/idea/:id): Grow's central journey (R13). An idea in
 * the owner's words, or picked; the questions its words leave open; the investigation on the household's own books
 * and the recorded prices, with the five things kept apart (can QED place it, can free money pay for it, is it open to
 * you, does it keep your own rules, what the record shows); the idea beside doing nothing and simple alternatives on the
 * same past windows; what it does to the money and how it could go badly; the case against it; then the owner's
 * decision, the exact order or instruction their passkey signs, what ran with the checks it passed, its receipts, how it
 * is doing against doing nothing, and a way to revise or stop it.
 *
 * QED reads the idea by fixed rules, not a model, and nothing on these pages moves money: going ahead opens the same
 * approval sheet as Buy or sell, or the instruction's own signing. Not investment advice. Design system "Meridian";
 * the layout is in src/styles/screens/idea.css (every class ix-).
 */
import { Check, CircleHelp, FileSignature, History, Scale, TriangleAlert, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Choice, ChoiceId, IdeaReadView, IdeaRecord, IdeaState, IdeaSummary, Investigation, Judgement, Outcome, Verdict } from '../../shared/ideaTypes.ts'
import { PICKS } from '../../shared/ideaParse.ts'
import { api, ApiError, fmt, navigate, useData, useLocation } from '../lib/core.ts'
import { ActionDoc, ApprovalSheet, type AuthDoc, InstrumentDoc, type PendingApproval } from '../ui/instrument.tsx'
import { Btn, Crumb, Field, Link, Loading, MoneyInput, Note, Problem, Stamp, useAction } from '../ui/kit.tsx'
import type { ActionPreview } from '../lib/types.ts'
import '../styles/screens/idea.css'

const NOT_ADVICE = 'Not investment advice: QED is not a registered investment adviser or portfolio manager, and nothing here is a promise of returns. Every trade is on paper.'
// a state still open carries the stamp's in-progress clock (no tone), never a check
type Tone = 'ok' | 'wait' | 'void' | 'plain' | 'you' | 'info' | undefined
const STATE_WORDS: Record<IdeaState, [string, Tone]> = {
  open: ['Not decided', undefined], 'awaiting-signature': ['Waiting for your signature', undefined], acted: ['Signed', 'ok'], declined: ['Not this', 'plain'], 'no-action': ['Nothing done', 'plain'],
}
export const ideaState = (s: IdeaState): [string, Tone] => STATE_WORDS[s]
const rupees = (paise: number | null | undefined): string => (paise === null || paise === undefined || !Number.isFinite(paise) ? 'none' : fmt.inr(paise))
const share = (x: number | null): string => (x === null || !Number.isFinite(x) ? 'none' : `${Math.round(x * 100)}%`)

// ------------------------------------------------------------------------------------------------ a new idea
export function IdeaScreen() {
  const { query } = useLocation()
  const revise = query.get('revise')
  const prior = useData<IdeaRecord>(revise ? `/api/ideas/${encodeURIComponent(revise)}` : null)
  // an idea Ask handed over arrives in the address (?text=): read at once, as if the person had pressed Read
  const handed = revise ? '' : (query.get('text') ?? '').slice(0, 300)
  const [text, setText] = useState(handed)
  const [answers, setAnswers] = useState<{ instrumentId?: string; amount?: number; cadence?: 'once' | 'monthly' }>({})
  const [view, setView] = useState<IdeaReadView | null>(null)
  const recent = useData<{ ideas: IdeaSummary[] }>('/api/ideas', ['action', 'program'])
  const reading = useAction(async (t: string, a: typeof answers) => { setView(await api<IdeaReadView>('POST', '/api/ideas/read', { text: t, answers: a })) })
  const test = useAction(async () => {
    const made = await api<{ id: string }>('POST', '/api/ideas', { text, answers, ...(revise ? { revises: revise } : {}) })
    navigate(`/holdings/idea/${made.id}`)
  })
  // a revision starts from the idea as it was decided: its words and its answers, read again on today's books
  const { run: readNow } = reading
  useEffect(() => {
    const p = prior.data
    if (!p) return
    const a = { instrumentId: p.investigation.plan.instrumentId, amount: p.investigation.plan.amount, cadence: p.investigation.plan.cadence }
    setText(p.text); setAnswers(a); void readNow(p.text, a)
  }, [prior.data, readNow])
  useEffect(() => { if (handed) void readNow(handed, {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const submitRead = (e: FormEvent) => { e.preventDefault(); void reading.run(text, answers) }
  const pick = (p: string) => { setText(p); setAnswers({}); setView(null); void reading.run(p, {}) }
  const answer = (patch: typeof answers) => { const next = { ...answers, ...patch }; setAnswers(next); void reading.run(text, next) }
  const ready = !!view && !view.reading.refusal && view.reading.questions.length === 0
  return (
    <div className="ix-page">
      <header className="page-head ix-head">
        <div>
          <Crumb to="/holdings">Grow</Crumb>
          <h1>Test an idea.<span className="dim"> Before any money moves.</span></h1>
          <p>Write what you have in mind, or pick one. QED asks what your words leave open, then tests the idea on your own money and the prices it has recorded, beside doing nothing.</p>
        </div>
      </header>
      {revise && prior.data ? <Note tone="qed" title="Revising an idea">{prior.data.title}. Change anything, then test it again; the earlier record is kept and links here.</Note> : null}

      <section className="panel ix-ask" aria-labelledby="ix-ask-h">
        <h2 id="ix-ask-h" className="sr">Your idea</h2>
        <form onSubmit={submitRead} className="ix-ask-form">
          <Field label="Your idea" hint="For example: ₹10,000 into the Nifty 50 index fund every month.">{(p) => <input {...p} className="input ix-text" value={text} maxLength={300} autoComplete="off" onChange={(e) => { setText(e.target.value); setView(null) }} />}</Field>
          <div className="ix-ask-go"><Btn type="submit" tone={ready ? undefined : 'fill'} busy={reading.busy} disabled={!text.trim()}>Read it</Btn></div>
        </form>
        <div className="ix-picks" role="group" aria-label="Or pick an idea">
          <span className="ix-picks-k">Or pick one</span>
          {PICKS.map((p) => <button key={p} type="button" className="ix-pick" aria-pressed={text === p} onClick={() => pick(p)}>{p}</button>)}
        </div>
        {reading.error ? <Problem error={reading.error} /> : null}
        {view ? <Reading view={view} answers={answers} onAnswer={answer} /> : null}
        {ready ? (
          <div className="ix-test">
            <Btn tone="fill" busy={test.busy} onClick={() => void test.run()}><Scale aria-hidden="true" />Test this idea</Btn>
            <span className="small muted">It is checked on your books and the recorded prices. Nothing is bought or signed.</span>
          </div>
        ) : null}
        {test.error ? <Problem error={test.error} /> : null}
      </section>

      <RecentList ideas={recent.data?.ideas ?? null} />
      <p className="ix-fine">{NOT_ADVICE}</p>
    </div>
  )
}

/** What QED heard, and what it still needs to know, one question at a time. */
function Reading({ view, answers, onAnswer }: { view: IdeaReadView; answers: { amount?: number }; onAnswer: (a: { instrumentId?: string; amount?: number; cadence?: 'once' | 'monthly' }) => void }) {
  const [amount, setAmount] = useState<number | null>(answers.amount ?? null)
  const r = view.reading
  if (r.refusal) return <Note tone="void" title="Not something this tests">{r.refusal}</Note>
  return (
    <div className="ix-read" aria-live="polite">
      {r.heard.length ? <p className="ix-heard"><span className="ix-heard-k">QED read</span>{r.heard.map((h) => <span key={h} className="ix-chip">{h}</span>)}</p> : null}
      {r.questions.map((q) => (
        <fieldset key={q.key} className="ix-q">
          <legend>{q.text}</legend>
          {q.key === 'amount' ? (
            <div className="ix-q-amount">
              {q.choices?.length ? <div className="ix-q-choices">{q.choices.map((c) => <button key={c.value} type="button" className="ix-pick" onClick={() => onAnswer({ amount: Number(c.value) })}>{c.label}</button>)}</div> : null}
              <div className="ix-q-row">
                <MoneyInput aria-label={q.text} value={amount} onChange={setAmount} />
                <Btn disabled={!amount} onClick={() => amount && onAnswer({ amount })}>Use this amount</Btn>
              </div>
              {view.free ? <p className="small muted">{fmt.inr(view.free)} is free: money not needed for anything due. What must stay in your bank, and money set aside for goals, is never counted.</p> : null}
            </div>
          ) : (
            <div className="ix-q-choices">{(q.choices ?? []).map((c) => <button key={c.value} type="button" className="ix-pick" onClick={() => onAnswer(q.key === 'cadence' ? { cadence: c.value as 'once' | 'monthly' } : { instrumentId: c.value })}>{c.label}</button>)}</div>
          )}
        </fieldset>
      ))}
    </div>
  )
}

function RecentList({ ideas }: { ideas: IdeaSummary[] | null }) {
  if (!ideas?.length) return null
  return (
    <section className="panel ix-recent" aria-labelledby="ix-recent-h">
      <div className="panel-head"><h2 id="ix-recent-h"><History aria-hidden="true" />Your ideas</h2><span className="small muted">Newest first</span></div>
      <ol className="ix-recent-list">{ideas.slice(0, 8).map((i) => { const [w, tone] = ideaState(i.state); return (
        <li key={i.id}><Link to={`/holdings/idea/${i.id}`} className="ix-recent-row"><span className="ix-recent-t"><strong>{i.title}</strong><span className="small muted">{fmt.dayTime(i.createdAt)}</span></span><Stamp tone={tone}>{w}</Stamp></Link></li>
      ) })}</ol>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the idea's record
const VERDICT: Record<string, Partial<Record<Verdict, [string, 'ok' | 'wait' | 'void' | 'plain' | 'info']>>> = {
  implementable: { yes: ['Yes, on paper', 'ok'], no: ['No', 'void'], unknown: ['Not now', 'plain'] },
  affordable: { yes: ['Yes, from free money', 'ok'], no: ['No', 'void'] },
  eligible: { yes: ['Yes', 'ok'], no: ['No', 'void'] },
  compatible: { yes: ['Yes', 'ok'], caution: ['Yes, with a caution', 'wait'], no: ['No', 'void'] },
  supported: { yes: ['Some support', 'info'], no: ['Against it', 'void'], unknown: ['Cannot tell', 'plain'] },
}
const ICON: Record<Verdict, typeof Check> = { yes: Check, no: X, caution: TriangleAlert, unknown: CircleHelp }

export function IdeaRecordScreen({ id }: { id: string }) {
  const rec = useData<IdeaRecord>(`/api/ideas/${encodeURIComponent(id)}`, ['action', 'program', 'run', 'nav'])
  const head = (title: ReactNode, sub: ReactNode) => (
    <header className="page-head ix-head ix-rec-head">
      <div><Crumb to="/holdings">Grow</Crumb><h1>{title}</h1>{sub}</div>
    </header>
  )
  if (!rec.data) return <div className="ix-page">{head('An idea', null)}{rec.error ? <Problem error={rec.error} /> : <Loading what="Reading the idea and its investigation" />}</div>
  const r = rec.data, inv = r.investigation
  const [w, tone] = ideaState(r.state)
  return (
    <div className="ix-page">
      {head(inv.title, <p className="ix-quote"><span>“{r.text}”</span> <span className="small muted">Tested {fmt.dayTime(inv.at)} on your books and the recorded prices.{r.revises ? <> It revises <Link to={`/holdings/idea/${r.revises}`}>an earlier idea</Link>.</> : null}</span> <Stamp tone={tone}>{w}</Stamp></p>)}
      {rec.error ? <Problem error={rec.error} /> : null}
      <Judgements inv={inv} />
      <Alternatives inv={inv} />
      <div className="ix-two">
        <Effects inv={inv} />
        <CaseAgainst inv={inv} />
      </div>
      {r.order || r.instruction || r.state === 'declined' || r.state === 'no-action' ? <Followed r={r} /> : null}
      {r.state === 'open' || r.state === 'awaiting-signature' ? <Decide r={r} onDone={rec.reload} /> : null}
      <Method inv={inv} hash={r.hash} />
      <p className="ix-fine">{NOT_ADVICE}</p>
    </div>
  )
}

/** The five things kept apart, each with its own answer in words. */
function Judgements({ inv }: { inv: Investigation }) {
  return (
    <section className="ix-judge" aria-labelledby="ix-judge-h">
      <h2 id="ix-judge-h" className="ix-h2">Five questions, answered apart</h2>
      <ol className="ix-judge-list">{inv.judgements.map((j) => <JudgementCard key={j.key} j={j} />)}</ol>
    </section>
  )
}
function JudgementCard({ j }: { j: Judgement }) {
  const [word, tone] = VERDICT[j.key]?.[j.verdict] ?? [j.verdict, 'plain']
  const I = ICON[j.verdict]
  return (
    <li className={`ix-jcard ${j.verdict} ${j.key}`} aria-label={`${j.title} ${word}`}>
      <span className="ix-jcard-i" aria-hidden="true"><I /></span>
      <h3>{j.title}</h3>
      <Stamp tone={tone}>{word}</Stamp>
      <p>{j.says}</p>
    </li>
  )
}

/** The idea beside doing nothing and the alternatives: what one would have been worth after a year, on the same windows. */
function Alternatives({ inv }: { inv: Investigation }) {
  const e = inv.evidence
  const total = inv.plan.cadence === 'once' ? inv.plan.amount : inv.plan.amount * 12
  const shown = e.outcomes.filter((o) => o.median !== null)
  const lo = Math.min(1, ...shown.map((o) => o.p05 ?? 1)), hi = Math.max(1, ...shown.map((o) => o.median ?? 1))
  const pad = (hi - lo) * 0.08 || 0.02
  const scale = { lo: lo - pad, hi: hi + pad }
  return (
    <section className="panel ix-alts" aria-labelledby="ix-alts-h">
      <div className="panel-head">
        <h2 id="ix-alts-h">Against doing nothing, and the alternatives</h2>
        <span className={`ix-basis ${e.basis}`}>{e.basis === 'synthetic' ? 'Synthetic prices' : e.basis === 'none' ? 'No record of the idea' : 'Recorded prices'}</span>
      </div>
      <p className="ix-lede">{inv.plan.cadence === 'once' ? `${fmt.inr(total)} put in once` : `${fmt.inr(inv.plan.amount)} a month for a year (${fmt.inr(total)} in all)`}, held for a year, in every past window the record allows{e.windows ? ` (${e.windows.toLocaleString('en-IN')})` : ''}: what it was worth at the end, after costs and modelled tax.</p>
      <ol className="ix-alt-list">{e.outcomes.map((o) => <AltRow key={o.id} o={o} total={total} scale={scale} />)}</ol>
      <p className="ix-key"><span><i className="ix-k-range" aria-hidden="true" />From the 1-in-20 low to the middle outcome</span><span><i className="ix-k-mid" aria-hidden="true" />The middle outcome</span><span><i className="ix-k-put" aria-hidden="true" />What was put in</span></p>
      <p className="ix-key-note small muted">Middle: half the windows ended above it, half below. 1 in 20 below: only one window in twenty ended lower.</p>
      <ul className="ix-says">{e.says.map((s) => <li key={s}>{s}</li>)}</ul>
    </section>
  )
}
function AltRow({ o, total, scale }: { o: Outcome; total: number; scale: { lo: number; hi: number } }) {
  const at = (x: number) => `${(((x - scale.lo) / (scale.hi - scale.lo)) * 100).toFixed(2)}%`
  const none = o.median === null
  const certain = o.kind === 'loan'
  return (
    <li className={`ix-alt ${o.kind}`}>
      <div className="ix-alt-what"><strong>{o.label}</strong><span>{o.why}</span></div>
      {none ? <p className="ix-alt-none">No figure: there is no record to work it out from.</p> : (
        <>
          <dl className="ix-alt-figs">
            <div><dt>{certain ? 'After a year' : 'Middle'}</dt><dd>{rupees(o.medianValue)}</dd></div>
            <div><dt>{certain ? 'Certain' : '1 in 20 below'}</dt><dd>{certain ? 'While it lasts' : rupees(o.p05 === null ? null : Math.round(total * o.p05))}</dd></div>
            <div><dt>Lost money in</dt><dd>{certain ? 'None' : share(o.lostIn)}</dd></div>
          </dl>
          <span className="ix-range" role="img" aria-label={certain ? `${o.label}: ${rupees(o.medianValue)} after a year, modelled.` : `${o.label}: the middle outcome ${rupees(o.medianValue)}; 1 in 20 windows ended below ${rupees(Math.round(total * (o.p05 ?? 0)))}.`}>
            <i className="ix-range-put" style={{ left: at(1) }} />
            {certain ? null : <i className="ix-range-band" style={{ left: at(Math.min(o.p05!, o.median!)), width: `calc(${at(Math.max(o.p05!, o.median!))} - ${at(Math.min(o.p05!, o.median!))})` }} />}
            <i className="ix-range-mid" style={{ left: at(o.median!) }} />
          </span>
        </>
      )}
    </li>
  )
}

/** What it does to the household's money, and three ways it could go badly. */
function Effects({ inv }: { inv: Investigation }) {
  const f = inv.effects, c = inv.context
  return (
    <section className="panel ix-effects" aria-labelledby="ix-eff-h">
      <div className="panel-head"><h2 id="ix-eff-h">What it does to your money</h2></div>
      <dl className="ix-rows">
        <div><dt>Free to use<span>Not needed for anything due</span></dt><dd>{fmt.inr(f.freeBefore)} <span className="ix-to">to</span> {fmt.inr(f.freeAfter)}</dd></div>
        <div><dt>Your worst case<span>Your floor is {fmt.inr(f.floor)}</span></dt><dd className={f.worstAfter < f.floor ? 'ix-bad' : ''}>{fmt.inr(f.worstBefore)} <span className="ix-to">to</span> {fmt.inr(f.worstAfter)}</dd></div>
        <div><dt>In markets<span>Share of what you have</span></dt><dd>{share(f.marketShareBefore)} <span className="ix-to">to</span> {share(f.marketShareAfter)}</dd></div>
        {c.setAside > 0 ? <div><dt>Set aside for goals<span>Never counted as free</span></dt><dd>{fmt.inr(c.setAside)}</dd></div> : null}
        {c.card + c.loans > 0 ? <div><dt>Debts<span>Card {fmt.inr(c.card)}; loans {fmt.inr(c.loans)}</span></dt><dd>{fmt.inr(c.card + c.loans)}</dd></div> : null}
      </dl>
      {f.concentration ? <p className="ix-caution"><TriangleAlert aria-hidden="true" />{f.concentration}</p> : null}
      <h3 className="ix-h3">If it goes badly</h3>
      <dl className="ix-rows">{inv.stress.map((s) => <div key={s.label}><dt>{s.label}<span>{s.note}</span></dt><dd className="ix-bad">{s.loss > 0 ? `−${fmt.inr(s.loss)}` : fmt.inr(0)}</dd></div>)}</dl>
      <h3 className="ix-h3">What it costs</h3>
      <dl className="ix-rows ix-costs">{inv.costs.map((x) => <div key={x.label}><dt>{x.label}<span>{x.status}</span></dt><dd>{x.value}</dd></div>)}</dl>
    </section>
  )
}

/** The strongest case against, beside what the record says for it. */
function CaseAgainst({ inv }: { inv: Investigation }) {
  return (
    <section className="panel ix-case" aria-labelledby="ix-case-h">
      <div className="panel-head"><h2 id="ix-case-h">The case against</h2></div>
      {inv.case.against.length ? <ul className="ix-case-list against">{inv.case.against.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="small muted">Nothing in the figures speaks against it.</p>}
      <h3 className="ix-h3">For it</h3>
      {inv.case.for.length ? <ul className="ix-case-list for">{inv.case.for.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="small muted">Nothing in the record speaks for it.</p>}
    </section>
  )
}

/** The decision: go ahead (the exact order or instruction, signed with the passkey), an alternative, not this, or nothing. */
function Decide({ r, onDone }: { r: IdeaRecord; onDone: () => void }) {
  const inv = r.investigation
  const first = inv.choices.find((c) => c.allowed && c.id !== 'reject' && c.id !== 'nothing')?.id ?? 'nothing'
  const [choice, setChoice] = useState<ChoiceId>(r.choice ?? first)
  const [reason, setReason] = useState('')
  const [order, setOrder] = useState<(PendingApproval & ActionPreview) | null>(null)
  const [signing, setSigning] = useState<(PendingApproval & { doc: AuthDoc; version: number; programId: string }) | null>(null)
  const chosen = inv.choices.find((c) => c.id === choice)
  const go = useAction(async () => {
    const d = await api<{ kind: string; preview?: PendingApproval & ActionPreview; programId?: string }>('POST', `/api/ideas/${encodeURIComponent(r.id)}/decide`, { choice, reason })
    if (d.kind === 'order' && d.preview) { setOrder(d.preview); return }
    if (d.kind === 'instruction' && d.programId) {
      try { const a = await api<PendingApproval & { doc: AuthDoc; version: number }>('POST', `/api/programs/${d.programId}/approval`, {}); setSigning({ ...a, programId: d.programId }) }
      catch (e) { onDone(); if (e instanceof ApiError) throw e }
      return
    }
    onDone()
  })
  const verb = choice === 'order' || choice === 'alt:liquid' ? (r.state === 'awaiting-signature' && r.choice === choice ? 'Prepare the order again' : 'See the exact order') : choice === 'instruction' || choice === 'alt:spread' ? (r.state === 'awaiting-signature' && r.choice === choice ? 'Prepare the instruction again' : 'See the exact instruction') : choice === 'reject' ? 'Record: not this' : 'Record: do nothing'
  return (
    <section className="panel ix-decide" aria-labelledby="ix-dec-h">
      <div className="panel-head"><h2 id="ix-dec-h"><FileSignature aria-hidden="true" />Your decision</h2><span className="small muted">Yours alone: QED does not choose for you</span></div>
      {r.state === 'awaiting-signature' ? <Note tone="wait" title="Not signed yet">{r.instruction ? <>The instruction is drafted and waits for your passkey. <Link to={`/instructions/${r.instruction.programId}`}>Read and sign it on its page</Link>, or prepare it again here.</> : 'The order was prepared but not signed. Prepare it again to see current prices, or choose differently.'}</Note> : null}
      <form onSubmit={(e) => { e.preventDefault(); void go.run() }}>
        <fieldset className="ix-choices">
          <legend className="sr">What to do</legend>
          {inv.choices.map((c) => <ChoiceRow key={c.id} c={c} checked={choice === c.id} onPick={() => setChoice(c.id)} />)}
        </fieldset>
        <Field label="Why, in a few words (optional)" hint="Kept with the idea, so you can see later what you decided and why.">{(p) => <input {...p} className="input" maxLength={280} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        {go.error ? <Problem error={go.error} /> : null}
        <div className="ix-decide-go">
          <Btn tone="fill" type="submit" busy={go.busy} disabled={!chosen?.allowed}>{verb}</Btn>
          <span className="small muted">{choice === 'reject' || choice === 'nothing' ? 'Nothing is sent or signed.' : 'Nothing is sent until you sign it with your passkey, and it is checked again when it is sent.'}</span>
        </div>
      </form>
      <ApprovalSheet approval={order} title="Approve this order" action="Approve and send" onClose={() => { setOrder(null); onDone() }}
        onApproved={async (approvalId) => { await api('POST', '/api/actions', { approvalId }); setOrder(null); onDone() }}>
        {order ? <ActionDoc summary={order.summary} lines={order.lines} warnings={order.warnings} worst={order.worst} /> : null}
      </ApprovalSheet>
      <ApprovalSheet approval={signing} title="Sign this instruction" action="Sign and put in force" onClose={() => { setSigning(null); onDone() }}
        onApproved={async (approvalId) => { const pid = signing!.programId; await api('POST', `/api/programs/${pid}/activate`, { approvalId }); setSigning(null); onDone() }}>
        {signing ? <InstrumentDoc doc={signing.doc} version={signing.version} state="review" /> : null}
      </ApprovalSheet>
    </section>
  )
}
function ChoiceRow({ c, checked, onPick }: { c: Choice; checked: boolean; onPick: () => void }) {
  return (
    <label className={`ix-choice ${c.allowed ? '' : 'off'} ${checked ? 'on' : ''}`}>
      <input type="radio" name="ix-choice" value={c.id} checked={checked} disabled={!c.allowed} onChange={onPick} />
      <span className="ix-choice-t"><strong>{c.label}</strong><span>{c.why}</span></span>
    </label>
  )
}

/** After the decision: what was signed, what ran and the checks it passed, the receipts, how it is doing, and what next. */
function Followed({ r }: { r: IdeaRecord }) {
  const m = r.monitor
  return (
    <section className="panel ix-follow" aria-labelledby="ix-fol-h">
      <div className="panel-head"><h2 id="ix-fol-h">What you decided, and what followed</h2></div>
      {r.decidedAt ? <p className="ix-lede">{fmt.dayTime(r.decidedAt)}: {r.choice ? choiceWords(r.choice) : ''}{r.reason ? <>, because “{r.reason}”</> : null}.</p> : null}
      {r.order ? (
        <dl className="ix-rows">
          <div><dt>{r.order.signed ? 'Signed' : 'Not signed'}<span>{r.order.signed ? `With your ${r.order.method ?? 'passkey'}, ${r.order.signedAt ? fmt.dayTime(r.order.signedAt) : ''}` : r.order.lapsed ? 'The request lapsed or was withdrawn' : 'Waiting for your passkey'}</span></dt><dd><span className="ix-fp">Fingerprint</span> <code className="ix-hash" title={r.order.docHash}>{r.order.docHash.slice(0, 12)}</code></dd></div>
          {r.order.action ? <div><dt>The order<span>{r.order.action.what}</span></dt><dd><Link to={`/record/${r.order.action.id}`}>{stateText(r.order.action.state)}</Link></dd></div> : null}
          {r.order.action?.receiptId ? <div><dt>Receipt<span>Its record, hashed into the chain of receipts</span></dt><dd><Link to={`/receipts/${r.order.action.receiptId}`}>Open the receipt</Link></dd></div> : null}
        </dl>
      ) : null}
      {r.order?.action?.checks.length ? (
        <details className="ix-checks"><summary>Checked again when it was sent ({r.order.action.checks.filter((c) => c.pass).length} of {r.order.action.checks.length} passed)</summary>
          <ul>{r.order.action.checks.map((c, i) => <li key={i} className={c.pass ? 'pass' : 'fail'}>{c.pass ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}<span><b>{c.pass ? 'Passed' : 'Failed'}:</b> {c.detail ?? c.rule}</span></li>)}</ul>
        </details>
      ) : null}
      {r.instruction ? (
        <dl className="ix-rows">
          <div><dt>The instruction<span>{r.instruction.title}</span></dt><dd><Link to={`/instructions/${r.instruction.programId}`}>{r.instruction.signed ? programWord(r.instruction.state) : 'Draft, not signed'}</Link></dd></div>
          {r.instruction.signed ? <div><dt>Signed<span>With your passkey{r.instruction.signedAt ? `, ${fmt.dayTime(r.instruction.signedAt)}` : ''}</span></dt><dd><span className="ix-fp">Fingerprint</span> <code className="ix-hash" title={r.instruction.contentHash ?? ''}>{(r.instruction.contentHash ?? '').slice(0, 12)}</code></dd></div> : null}
          <div><dt>Purchases<span>Each asks you first</span></dt><dd>{r.instruction.runs.done} done{r.instruction.runs.waiting ? `, ${r.instruction.runs.waiting} waiting` : ''}{r.instruction.runs.refused ? `, ${r.instruction.runs.refused} not made` : ''}</dd></div>
        </dl>
      ) : null}
      {m ? (
        <>
          <h3 className="ix-h3">How it is doing</h3>
          <dl className="ix-tiles">
            <div><dt>Put in</dt><dd>{fmt.inr(m.put)}</dd></div>
            <div><dt>Worth now</dt><dd>{rupees(m.value)}</dd></div>
            <div><dt>Had it stayed in the bank</dt><dd>{fmt.inr(m.doNothing)}</dd></div>
            {m.liquid !== null ? <div><dt>In the liquid fund</dt><dd>{fmt.inr(m.liquid)}</dd></div> : null}
          </dl>
          <p className="small muted">{m.says}</p>
        </>
      ) : null}
      <div className="ix-next">
        <Link className="btn" to={`/holdings/idea?revise=${encodeURIComponent(r.id)}`}>Revise this idea</Link>
        {r.instruction?.signed && (r.instruction.state === 'active' || r.instruction.state === 'paused') ? <Link className="btn quiet" to={`/instructions/${r.instruction.programId}`}>Pause or stop it</Link> : null}
        {r.order?.action && (r.order.action.state === 'working' || r.order.action.state === 'planned') ? <Link className="btn quiet" to={`/record/${r.order.action.id}`}>Cancel it if it has not gone</Link> : null}
        {r.revisedBy ? <Link className="btn quiet" to={`/holdings/idea/${r.revisedBy}`}>See the revision</Link> : null}
      </div>
      <h3 className="ix-h3">The idea's history</h3>
      <ol className="ix-events">{r.events.map((e, i) => <li key={i}><span className="small muted">{fmt.dayTime(e.at)}</span> {e.says}</li>)}</ol>
    </section>
  )
}
const choiceWords = (c: ChoiceId): string => ({ order: 'go ahead, once', instruction: 'go ahead, every month', 'alt:liquid': 'the liquid fund instead', 'alt:spread': 'spread over six months', reject: 'not this', nothing: 'do nothing for now' })[c]
const stateText = (s: string): string => ({ planned: 'Waiting to be sent', submitting: 'Being sent', working: 'With the venue', done: 'Done', failed: 'Failed', rejected: 'Refused by the venue', blocked: 'Refused by QED\'s checks', cancelled: 'Cancelled', partial: 'Partly done' } as Record<string, string>)[s] ?? s
const programWord = (s: string): string => ({ active: 'In force', paused: 'Paused', revoked: 'Revoked', completed: 'Completed', expired: 'Ended', draft: 'Draft' } as Record<string, string>)[s] ?? s

/** How the figures were worked out, one press away, with the fingerprint of what was shown. */
function Method({ inv, hash }: { inv: Investigation; hash: string }) {
  const claims = useMemo(() => inv.evidence.claims, [inv])
  return (
    <details className="panel ix-method">
      <summary><Scale aria-hidden="true" />How this was worked out</summary>
      <ul className="ix-says">
        <li>Prices: {inv.evidence.source}. Each window starts on a recorded day and ends a year and a day later; a window counts only if every plan can be valued in it.</li>
        <li>Claims use monthly returns: none on fewer than 36 months, and each needs its interval to exclude zero at 5% divided by the {claims.length || 'number of'} comparisons made.</li>
        {inv.evidence.notes.map((n) => <li key={n}>{n}</li>)}
        <li>The idea was read by fixed rules, not a model. The investigation was kept as it was shown; its fingerprint is <code className="ix-hash">{hash.slice(0, 16)}</code>.</li>
      </ul>
    </details>
  )
}
