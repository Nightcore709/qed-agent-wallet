/**
 * Writing or amending an instruction, as a guided form (DESIGN.md "Meridian"). First the kinds QED can follow, by
 * what they are for. Then one glass surface of numbered steps: what it does, its bound, how it acts, and what follows.
 * Beside each step is that step's live preview, worked out by QED's server from your recorded position as you type and
 * tinted with QED's tide because it is what QED would be allowed: the document's own words for what it does; its
 * limits on one scale (one run, one month, in all until it ends) with its effect on your worst case against your floor;
 * what the way it acts means for each run. What you set here is a rule; QED's server is what refuses a run beyond it.
 * Nothing is saved, and nothing can act, until you sign the document; the approval sheet that signs it is UX only (the
 * hold and the button express intent), and the server checks the passkey's signature over the document's fingerprint.
 */
import { ChevronRight, HandCoins, PiggyBank, Receipt, Scale, ShieldCheck, Split, Target, TrendingDown, TrendingUp } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { api, ApiError, fmt, navigate, useData, useLocation } from '../lib/core.ts'
import { ApprovalSheet, type AuthDoc, InstrumentDoc, type PendingApproval } from '../ui/instrument.tsx'
import { Btn, Crumb, Field, Link, Loading, MoneyInput, Note, Problem, useAction } from '../ui/kit.tsx'
import type { Analysis, Authority, Draft, GoalsView, Home, Market, MarketInstrument, ProgramDetail, Proposal } from '../lib/types.ts'
import { Consequences } from './Instructions.tsx'

type P = Record<string, unknown>
type Sched = { type: 'every'; minutes: number } | { type: 'daily'; at: string } | { type: 'weekly'; weekday: number; at: string } | { type: 'monthly'; day: number; at: string }
const DAY = 86_400_000, IST = 19_800_000
const DEFAULTS: Record<string, P> = {
  invest: { instrumentId: 'amfi:120716', amount: 500_000, schedule: { type: 'monthly', day: 5, at: '10:00' } },
  sweep: { instrumentId: 'amfi:118701', keep: 20_000_000, minMove: 1_000_000, topUp: true, schedule: { type: 'daily', at: '12:45' } },
  // a withdrawal plan: the amount and the day are the owner's; the fund starts as the one the invest default names
  swp: { instrumentId: 'amfi:120716', amount: 1_000_000, schedule: { type: 'monthly', day: 5, at: '10:00' } },
  paydown: { plan: { card: 10_000, personal_loan: 0, home_loan: 0, fd: 0, liquid_fund: 0 } },
  bills: { payeeHandles: [], capPerBill: 500_000, leadMinutes: 0 },
  exit: { instrumentId: 'coindcx:BTCINR', mode: 'trail', trailPct: 5, sellBps: 10_000 },
  floor: { buffer: 0 },
  rebalance: { legs: [{ instrumentId: 'amfi:120716', weightBps: 7000 }, { instrumentId: 'amfi:119788', weightBps: 3000 }], bandBps: 500, schedule: { type: 'weekly', weekday: 1, at: '11:00' } },
  split: { rules: [{ to: 'fund', instrumentId: 'amfi:120716', shareBps: 1000 }], minIncome: 500_000 },
  // a goal is the household's own: what it is for, how much and by when start empty; the day and the monthly figure are QED's
  goal: { name: '', date: '', growthBps: 0 },
}
/** A goal's monthly figure is worked out by QED's server each time it is drafted, so a stored one is never sent back. */
const goalParams = (p: P): P => { const { amount: _monthly, ...rest } = p; return rest }
const GROWTH = [0, 200, 300, 400, 500, 600, 700, 800]
const ordinal = (d: number): string => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`
const PILLARS: [string, string, string][] = [['spend', 'Spending', 'Paying people and bills'], ['save', 'Saving and debt', 'Idle cash, deposits and what you owe'], ['grow', 'Growing', 'Investing regularly and keeping a mix'], ['earn', 'Earning', 'What happens when income arrives'], ['protect', 'Protecting', 'Selling risk when it matters']]
const KIND_ICON: Record<string, typeof Receipt> = { bills: Receipt, sweep: PiggyBank, swp: HandCoins, paydown: HandCoins, invest: TrendingUp, rebalance: Scale, split: Split, exit: TrendingDown, floor: ShieldCheck, goal: Target }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const endOfDayIst = (date: string): number => Date.parse(`${date}T23:59:00.000Z`) - IST
const istDate = (ms: number): string => new Date(ms + IST).toISOString().slice(0, 10)
/** What each way of acting means for a run, said once beside the choice. */
const MODE_MEANS: Record<string, string> = {
  approve: 'Each run is prepared and waits for you. Nothing moves until you approve that run; a request you do not answer lapses after 24 hours.',
  notify: 'You are told before every run, and the run goes ahead at its time unless you object to it.',
  auto: 'Each run goes ahead inside the limits without asking. You see every run, and can pause or revoke at any time.',
}

function InstrumentSelect({ value, onChange, market, only, ...p }: { value: string; onChange: (v: string) => void; market: Market; only?: (i: MarketInstrument) => boolean; id?: string }) {
  const list = market.instruments.filter((i) => i.tradable && (!only || only(i)))
  const funds = list.filter((i) => i.kind === 'mutual_fund'), digital = list.filter((i) => i.kind === 'crypto_spot')
  return (
    <select className="input" {...p} value={value} onChange={(e) => onChange(e.target.value)}>
      {funds.length ? <optgroup label="Mutual funds (priced once a day at NAV)">{funds.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup> : null}
      {digital.length ? <optgroup label="Digital assets (live order book, in rupees)">{digital.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup> : null}
    </select>
  )
}

function ScheduleField({ value, onChange, error, only }: { value: Sched; onChange: (s: Sched) => void; error?: string | undefined; only?: Sched['type'][] }) {
  const offer = (t: Sched['type']): boolean => !only || only.includes(t)
  const at = 'at' in value ? value.at : '10:00'
  return (
    <fieldset className="pr-cw-group">
      <legend>When it runs</legend>
      <div className="pr-cw-grid">
        <Field label="How often">{(p) => (
          <select {...p} className="input" value={value.type} onChange={(e) => { const t = e.target.value; onChange(t === 'every' ? { type: 'every', minutes: 30 } : t === 'daily' ? { type: 'daily', at } : t === 'weekly' ? { type: 'weekly', weekday: 1, at } : { type: 'monthly', day: 5, at }) }}>
            {offer('monthly') ? <option value="monthly">Every month</option> : null}{offer('weekly') ? <option value="weekly">Every week</option> : null}{offer('daily') ? <option value="daily">Every day</option> : null}{offer('every') ? <option value="every">Every so many minutes</option> : null}
          </select>)}</Field>
        {value.type === 'monthly' ? <Field label="On day" hint="1 to 28, so it exists in every month.">{(p) => <input {...p} className="input" type="number" min={1} max={28} value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })} />}</Field> : null}
        {value.type === 'weekly' ? <Field label="On">{(p) => <select {...p} className="input" value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}</Field> : null}
        {value.type === 'every' ? <Field label="Minutes between runs" hint="Short intervals are for trying things out.">{(p) => <input {...p} className="input" type="number" min={1} max={10080} value={value.minutes} onChange={(e) => onChange({ type: 'every', minutes: Number(e.target.value) })} />}</Field>
          : <Field label="At (India time)">{(p) => <input {...p} className="input" type="time" value={at} onChange={(e) => onChange({ ...value, at: e.target.value } as Sched)} />}</Field>}
      </div>
      {error ? <span className="err">{error}</span> : null}
    </fieldset>
  )
}

/** One step of the guided form: its number and name, the fields, and beside them what those fields would allow. */
function Step({ n, id, title, live, children, wide }: { n: number; id: string; title: string; live?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`pr-cw-step ${wide ? 'wide' : ''}`} aria-labelledby={id}>
      <div className="pr-cw-main">
        <div className="pr-cw-label"><span className="pr-cw-n" aria-hidden="true">{n}</span><h2 id={id}>{title}</h2></div>
        <div className="pr-cw-fields">{children}</div>
      </div>
      {live === undefined ? null : <div className="pr-cw-live"><p className="pr-cw-live-h">What signing would allow<span>Worked out by QED's server as you type</span></p>{live}</div>}
    </section>
  )
}

export function ComposeScreen({ amendId }: { amendId?: string }) {
  const { query } = useLocation()
  const proposalId = query.get('proposal')
  const [kind, setKind] = useState(amendId ? '' : query.get('kind') ?? '')
  const [params, setParams] = useState<P>(() => structuredClone(DEFAULTS[query.get('kind') ?? ''] ?? {}))
  const [auth, setAuth] = useState<Partial<Authority>>({})
  const [draft, setDraft] = useState<Draft | null>(null)
  const [updating, setUpdating] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [previewError, setPreviewError] = useState<ApiError | null>(null)
  const [ready, setReady] = useState(!amendId && !proposalId)
  const [approval, setApproval] = useState<(PendingApproval & { doc: AuthDoc; version: number; programId: string }) | null>(null)
  // Contradictions the server found in the draft (R7-093): each must be accepted, or the draft changed, before signing.
  const [conflicts, setConflicts] = useState<{ programId: string; list: { id: string; text: string }[] } | null>(null)
  // when the contradictions appear, they are announced and focus goes to them (R12 task comparison, WCAG 2.4.3, 4.1.3)
  const conflictRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (conflicts) conflictRef.current?.focus() }, [conflicts])
  const [accepted, setAccepted] = useState<string[]>([])
  const market = useData<Market>('/api/market')
  const home = useData<Home>('/api/home')
  const payees = useData<{ payees: { id: string; name: string; handle: string }[] }>(kind === 'bills' ? '/api/payees' : null)
  const kinds = useData<{ kinds: { kind: string; pillar: string; label: string; blurb: string }[] }>(!kind ? '/api/programs' : null)
  const goals = useData<GoalsView>(kind === 'goal' ? '/api/goals' : null)
  // a goal is worked out once it has what it is for, how much and by when; until then nothing is asked of the server
  const goalIncomplete = kind === 'goal' && (!String(params.name ?? '').trim() || typeof params.target !== 'number' || !params.date)

  // Start from an existing instruction (amend) or from a proposal.
  useEffect(() => {
    // a goal's bound is the goal itself (server/goals.ts): only how it acts is carried over, and its monthly figure is worked out again
    if (amendId) void api<ProgramDetail>('GET', `/api/programs/${amendId}`).then((p) => { const v = p.versions.find((x) => x.state === 'draft') ?? p.versions.find((x) => x.state === 'live') ?? p.versions[0]; if (v) { setKind(p.kind); setParams(p.kind === 'goal' ? goalParams(v.params) : v.params); setAuth(p.kind === 'goal' ? { runMode: v.authority.runMode, ...(v.authority.runMode === 'notify' ? { noticeSec: v.authority.noticeSec } : {}) } : { ...v.authority, expiresAt: Math.max(v.authority.expiresAt, Date.now() + DAY) }) } setReady(true) }, (e: ApiError) => { setPreviewError(e); setReady(true) })
    else if (proposalId) void api<{ proposals: Proposal[] }>('GET', '/api/proposals').then((r) => { const pr = r.proposals.find((x) => x.id === proposalId); if (pr) { setKind(pr.kind); setParams(pr.params); setAuth({ ...(pr.authority ?? {}), ...(pr.origin === 'model' ? { runMode: 'approve' as Authority['runMode'] } : pr.runMode ? { runMode: pr.runMode as Authority['runMode'], ...(pr.runMode === 'notify' ? { noticeSec: 86_400 } : {}) } : {}) }) /* A3, D2: a model's run mode is not prefilled; it asks each time until the owner chooses */ } setReady(true) }, () => setReady(true))
  }, [amendId, proposalId])

  // Recompute the instrument and its consequences shortly after each change.
  const seq = useRef(0)
  useEffect(() => {
    if (!kind || !ready) return
    const mine = ++seq.current
    if (goalIncomplete) { setDraft(null); setFieldErrors({}); setPreviewError(null); setUpdating(false); return }
    setUpdating(true)
    const t = setTimeout(() => {
      api<{ draft: Draft }>('POST', '/api/programs/preview', { kind, params, authority: auth }).then(
        (r) => { if (mine === seq.current) { setDraft(r.draft); setFieldErrors({}); setPreviewError(null); setUpdating(false) } },
        (e: ApiError) => { if (mine === seq.current) { setFieldErrors(e.fields ?? {}); setPreviewError(Object.keys(e.fields ?? {}).length ? null : e); setUpdating(false) } })
    }, 350)
    return () => clearTimeout(t)
  }, [kind, params, auth, ready, goalIncomplete])

  const sign = useAction(async () => {
    type Saved = { programId: string; version: number; contradictions: { id: string; text: string }[] }
    const saved = amendId ? await api<Saved>('POST', `/api/programs/${amendId}/draft`, { params, authority: auth }) : await api<Saved>('POST', '/api/programs', { kind, params, authority: auth, ...(proposalId ? { proposalId } : {}) })
    // Contradictions are shown before anything is sent for signing; the approval route refuses them only as a guard.
    const open = saved.contradictions.filter((c) => !accepted.includes(c.id))
    if (open.length) { setConflicts({ programId: saved.programId, list: saved.contradictions }); return }
    try { const a = await api<PendingApproval & { doc: AuthDoc; version: number }>('POST', `/api/programs/${saved.programId}/approval`, { acknowledge: accepted }); setConflicts(null); setApproval({ ...a, programId: saved.programId }) }
    catch (e) {
      if (e instanceof ApiError && e.code === 'contradiction_unresolved') { setConflicts({ programId: saved.programId, list: JSON.parse(e.fields.contradictions ?? '[]') as { id: string; text: string }[] }); return }
      navigate(`/instructions/${saved.programId}`); throw e
    }
  })
  const saveOnly = useAction(async () => { const saved = amendId ? await api<{ programId: string }>('POST', `/api/programs/${amendId}/draft`, { params, authority: auth }) : await api<{ programId: string }>('POST', '/api/programs', { kind, params, authority: auth, ...(proposalId ? { proposalId } : {}) }); navigate(`/instructions/${saved.programId}`) })
  const pick = (k: string) => { setKind(k); setParams(structuredClone(DEFAULTS[k] ?? {})); setAuth({}); setDraft(null); setFieldErrors({}); setConflicts(null); setAccepted([]); navigate(`/instructions/new?kind=${k}`, true) }

  if (!kind && !amendId && !proposalId) {
    const head = <header className="page-head pr-cw-head"><div><Crumb to="/instructions">Instructions</Crumb><h1>Write a new instruction</h1><p>Choose what you want done. You will see the exact document, its limit and what follows from it before you sign anything.</p></div></header>
    if (!kinds.data) return <div className="pr pr-cw">{head}{kinds.error ? <Problem error={kinds.error} /> : <Loading what="Reading what QED can follow" />}</div>
    const by = (p: string) => kinds.data!.kinds.filter((k) => k.pillar === p)
    return (
      <div className="pr pr-cw">
        {head}
        <div className="panel pr-cw-kinds">
          {PILLARS.map(([p, name, about]) => by(p).length ? (
            <section key={p} className="pr-cw-kind-row" aria-labelledby={`k-${p}`}>
              <div className="pr-cw-pillar"><h2 id={`k-${p}`}>{name}</h2><p>{about}</p></div>
              <ul className="pr-cw-kind-list" style={{ ['--n' as string]: Math.min(3, by(p).length) }}>{by(p).map((k) => { const I = KIND_ICON[k.kind] ?? TrendingUp; return (
                <li key={k.kind}><a className="pr-cw-kind" href={`/instructions/new?kind=${k.kind}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); pick(k.kind) }}>
                  <span className="pr-cw-kind-icon" aria-hidden="true"><I /></span>
                  <span className="pr-cw-kind-body"><strong>{k.label}</strong><span>{k.blurb}</span></span>
                  <ChevronRight className="pr-cw-kind-go" aria-hidden="true" />
                </a></li>
              ) })}</ul>
            </section>
          ) : null)}
        </div>
        <p className="pr-cw-quiet pr-cw-kinds-foot">Not sure which? <Link to="/ask">Ask QED</Link> in your own words; it drafts an instruction for you to read, change and sign, or not.</p>
      </div>
    )
  }
  if (!ready || !market.data) return <div className="pr pr-cw" aria-busy="true"><header className="page-head pr-cw-head"><div><Crumb to="/instructions">Instructions</Crumb><h1>{amendId ? 'Amend the instruction' : 'Write an instruction'}</h1></div></header>{market.error ? <Problem error={market.error} /> : <Loading what="Preparing" />}</div>

  const set = (k: string, v: unknown) => setParams((s) => ({ ...s, [k]: v }))
  const setA = (patch: Partial<Authority>) => setAuth((s) => ({ ...s, ...patch }))
  const A = (k: keyof Authority) => (auth[k] ?? draft?.authority[k]) as never
  const inst = market.data.instruments.find((i) => i.id === params.instrumentId)
  const sellOnly = kind === 'exit' || kind === 'floor'
  const plan = (params.plan ?? {}) as Record<string, number>
  const legs = (params.legs ?? []) as { instrumentId: string; weightBps: number }[]
  const rules = (params.rules ?? []) as { to: 'fund' | 'card'; instrumentId?: string; shareBps: number }[]
  const handles = (params.payeeHandles ?? []) as string[]
  const held = new Set((home.data?.overview.holdings ?? []).map((h) => h.instrumentId))
  const E = (k: string) => fieldErrors[k]
  const moneyField = (k: string, label: string, hint?: string): ReactNode => <Field label={label} hint={hint} error={E(k)}>{(p) => <MoneyInput {...p} value={typeof params[k] === 'number' ? (params[k] as number) : null} onChange={(v) => set(k, v ?? 0)} />}</Field>
  const hasErrors = Object.keys(fieldErrors).length > 0
  const refused = !!draft && draft.analysis.refusals.length > 0
  const ceiling = draft ? draft.doc.ceilingPaise : null
  const allows = draft ? (typeof ceiling === 'number' ? <>Signing allows at most <strong>{fmt.money(ceiling)}</strong> in all, before {fmt.dayYear(draft.authority.expiresAt)}.</> : <>Signing allows selling only, never buying or paying anyone, until {fmt.dayYear(draft.authority.expiresAt)}.</>) : null
  // what the live column says while the server works, or when a field must be fixed first
  const pending = hasErrors ? <p className="pr-cw-quiet">Fix the highlighted fields to see what it would allow.</p>
    : goalIncomplete ? <p className="pr-cw-quiet">Say what it is for, how much and by when. QED then works out what to set aside each month.</p>
    : <p className="pr-cw-quiet" aria-busy="true"><span className="skel pr-cw-skel" aria-hidden="true" />Working out what it would allow…</p>
  const goalDay = (params.schedule as { day?: number } | undefined)?.day ?? (draft?.params.schedule as { day?: number } | undefined)?.day ?? goals.data?.defaultDay ?? 1
  const salary = goals.data?.salaryDay ?? null
  const runMode = A('runMode') as Authority['runMode'] | undefined

  return (
    <div className="pr pr-cw">
      <header className="page-head pr-cw-head">
        <div>
          <Crumb to={amendId ? `/instructions/${amendId}` : '/instructions'}>{amendId ? 'The instruction' : 'Instructions'}</Crumb>
          <h1>{amendId ? 'Amend the instruction' : 'Write an instruction'}</h1>
          <p>{amendId ? 'An amendment is a new version. The version in force keeps running until you sign this one.' : 'Four steps. Beside each, what it would allow, worked out from your records as you type. Nothing can act until you sign it.'}</p>
        </div>
        {!amendId && !proposalId ? <Btn tone="quiet" onClick={() => { setKind(''); setDraft(null); navigate('/instructions/new', true) }}>Choose another kind</Btn> : null}
      </header>

      <form id="compose-form" className="panel pr-cw-form" onSubmit={(e) => { e.preventDefault(); void sign.run() }}>
        <Step n={1} id="does-h" title={kind === 'goal' ? 'What you are saving for' : 'What it does'} live={draft ? <div className="pr-cw-says">{kind === 'goal' && typeof draft.params.amount === 'number' ? <><p className="pr-cw-live-k">QED works out</p><p className="pr-cw-says-big">{fmt.money(draft.params.amount)} a month<small>{draft.analysis.headline}</small></p></> : null}<p className="pr-cw-live-k">It will</p>{draft.doc.may.map((m, i) => <p key={i} className="pr-cw-may">{m}</p>)}{updating ? <p className="pr-cw-quiet">Updating…</p> : null}</div> : pending}>
          {kind === 'goal' ? <>
            <Field label="What it is for" hint="A few words, such as a holiday in March" error={E('name')}>{(p) => <input {...p} className="input" maxLength={60} autoComplete="off" value={String(params.name ?? '')} onChange={(e) => set('name', e.target.value)} />}</Field>
            <div className="pr-cw-grid">
              {moneyField('target', 'How much')}
              <Field label="By" hint={goals.data ? `A date up to ${fmt.isoDay(goals.data.latest)}` : undefined} error={E('date')}>{(p) => <input {...p} className="input" type="date" min={istDate(Date.now() + DAY)} max={goals.data?.latest} value={String(params.date ?? '')} onChange={(e) => set('date', e.target.value)} />}</Field>
            </div>
            <div className="pr-cw-grid">
              <Field label="Set aside on day" hint={salary ? `Of each month: the ${ordinal(salary >= 28 ? 1 : salary + 1)}, the day after your salary arrives on the ${ordinal(salary)}, unless you choose another.` : 'Of each month, 1 to 28. No salary is on record, so the 1st unless you choose another.'} error={E('schedule')}>{(p) => <select {...p} className="input" value={goalDay} onChange={(e) => set('schedule', { type: 'monthly', day: Number(e.target.value), at: '10:00' })}>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select>}</Field>
              <Field label="Growth to count" hint="None unless you name a rate. Money set aside here earns no interest on paper: a rate you name is your assumption, counted only in whether it is on track." error={E('growthBps')}>{(p) => <select {...p} className="input" value={Number(params.growthBps ?? 0)} onChange={(e) => set('growthBps', Number(e.target.value))}>{GROWTH.map((g) => <option key={g} value={g}>{g === 0 ? 'None' : `${g / 100}% a year, as I assume`}</option>)}</select>}</Field>
            </div></> : null}
          {kind === 'invest' ? <>
            <Field label="Buy" error={E('instrumentId')}>{(p) => <InstrumentSelect {...p} market={market.data!} value={String(params.instrumentId ?? '')} onChange={(v) => set('instrumentId', v)} />}</Field>
            {moneyField('amount', 'With this much each time')}
            <ScheduleField value={params.schedule as Sched} onChange={(s) => set('schedule', s)} error={E('schedule')} /></> : null}
          {kind === 'swp' ? <>
            <Field label="Withdraw from" hint="A fund. You can only withdraw units you hold." error={E('instrumentId')}>{(p) => <InstrumentSelect {...p} market={market.data!} only={(i) => i.kind === 'mutual_fund'} value={String(params.instrumentId ?? '')} onChange={(v) => setParams((s) => ({ ...s, instrumentId: v, alsoFrom: ((s.alsoFrom ?? []) as string[]).filter((x) => x !== v) }))} />}</Field>
            <fieldset className="pr-cw-group"><legend>Also allow it to sell from</legend>
              <p className="pr-cw-quiet">Tick more funds and QED chooses, each run, which to sell first: a fund whose units are inside their exit-load period goes last, then the fund whose money arrives soonest, then the lower estimated cost. It sells only from the funds you tick here.</p>
              <div className="choice pr-cw-payees">{market.data.instruments.filter((i) => i.tradable && i.kind === 'mutual_fund' && i.id !== params.instrumentId && held.has(i.id)).map((i) => <label key={i.id}><input type="checkbox" checked={((params.alsoFrom ?? []) as string[]).includes(i.id)} onChange={(e) => { const cur = (params.alsoFrom ?? []) as string[]; const next = e.target.checked ? [...cur, i.id] : cur.filter((x) => x !== i.id); setParams((s) => { const { alsoFrom: _a, ...rest } = s; return next.length ? { ...rest, alsoFrom: next } : rest }) }} /> {i.name}</label>)}</div>
              {E('alsoFrom') ? <span className="err">{E('alsoFrom')}</span> : null}</fieldset>
            {moneyField('amount', 'Each time', 'The units sold are worth about this at the latest NAV. The money goes into your own bank account.')}
            <Field label="Always keep in these funds" hint="Optional. A reserve that is never sold, in rupees; leave empty for none." error={E('reserve')}>{(p) => <MoneyInput {...p} value={typeof params.reserve === 'number' ? params.reserve : null} onChange={(v) => setParams((s) => { const { reserve: _r, ...rest } = s; return v ? { ...rest, reserve: v } : rest })} />}</Field>
            <Field label="Money needed within" hint="Optional. Business days after a run; a fund that pays out later is not sold, and what is left is reported as still owed." error={E('needByDays')}>{(p) => <select {...p} className="input" value={String(params.needByDays ?? '')} onChange={(e) => setParams((s) => { const { needByDays: _n, ...rest } = s; return e.target.value ? { ...rest, needByDays: Number(e.target.value) } : rest })}><option value="">No deadline</option>{[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} business day{n === 1 ? '' : 's'}</option>)}</select>}</Field>
            <ScheduleField only={['monthly', 'weekly']} value={params.schedule as Sched} onChange={(s) => set('schedule', s)} error={E('schedule')} /></> : null}
          {kind === 'sweep' ? <>
            <Field label="Park spare cash in" hint="Liquid, overnight and arbitrage funds only." error={E('instrumentId')}>{(p) => <InstrumentSelect {...p} market={market.data!} only={(i) => ['liquid', 'overnight', 'arbitrage'].includes(String(i.meta.category))} value={String(params.instrumentId ?? '')} onChange={(v) => set('instrumentId', v)} />}</Field>
            <div className="pr-cw-grid">{moneyField('keep', 'Always keep in the bank')}{moneyField('minMove', 'Only move when at least this much is spare')}</div>
            <label className="check"><input type="checkbox" checked={params.topUp !== false} onChange={(e) => set('topUp', e.target.checked)} /> Bring money back from the fund when the bank falls below the buffer</label>
            <ScheduleField value={params.schedule as Sched} onChange={(s) => set('schedule', s)} error={E('schedule')} /></> : null}
          {kind === 'paydown' ? <>
            <p className="pr-cw-quiet">Whole rupees. QED runs this only if two independent checkers find it never leaves you worse off in the scenarios it lists.</p>
            <div className="pr-cw-grid">{[['card', 'To your credit card'], ['personal_loan', 'To your personal loan'], ['home_loan', 'To your home loan'], ['fd', 'Into a fixed deposit'], ['liquid_fund', 'Into a liquid fund']].map(([k, label]) => (
              <Field key={k} label={label!} error={E(`plan.${k}`)}>{(p) => <MoneyInput {...p} value={(plan[k!] ?? 0) * 100} onChange={(v) => set('plan', { ...plan, [k!]: Math.round((v ?? 0) / 100) })} />}</Field>))}</div>
            {E('plan') ? <span className="err">{E('plan')}</span> : null}</> : null}
          {kind === 'bills' ? <>
            <fieldset className="pr-cw-group"><legend>Pay bills from</legend>
              {!payees.data ? <Loading /> : payees.data.payees.length === 0 ? <p className="pr-cw-quiet">You have no payees yet. <Link to="/pay">Add one on the Spend page</Link>, then come back.</p> : <div className="choice pr-cw-payees">{payees.data.payees.map((y) => <label key={y.id}><input type="checkbox" checked={handles.includes(y.handle)} onChange={(e) => set('payeeHandles', e.target.checked ? [...handles, y.handle] : handles.filter((h) => h !== y.handle))} /><b>{y.name}</b><small>{y.handle}</small></label>)}</div>}
              {E('payeeHandles') ? <span className="err">{E('payeeHandles')}</span> : null}</fieldset>
            <div className="pr-cw-grid">{moneyField('capPerBill', 'Never pay a single bill above')}
              <Field label="Pay it">{(p) => <select {...p} className="input" value={Number(params.leadMinutes ?? 0)} onChange={(e) => set('leadMinutes', Number(e.target.value))}><option value={0}>At the due time</option><option value={60}>An hour before</option><option value={1440}>A day before</option></select>}</Field></div></> : null}
          {kind === 'exit' ? <>
            <Field label="Sell" hint={held.size ? undefined : 'You hold nothing yet; it can be signed once you do.'} error={E('instrumentId')}>{(p) => <InstrumentSelect {...p} market={market.data!} only={(i) => held.size === 0 || held.has(i.id)} value={String(params.instrumentId ?? '')} onChange={(v) => set('instrumentId', v)} />}</Field>
            <div className="choice" role="radiogroup" aria-label="When to sell">
              <label><input type="radio" name="mode" checked={params.mode === 'trail'} onChange={() => setParams((s) => ({ ...s, mode: 'trail', trailPct: s.trailPct ?? 5 }))} /><b>When it falls a set percentage from its highest price</b><small>The level follows the price up and never comes down.</small></label>
              <label><input type="radio" name="mode" checked={params.mode === 'below'} onChange={() => setParams((s) => ({ ...s, mode: 'below', price: s.price ?? inst?.quotes.bid?.price ?? inst?.quotes.nav?.price ?? '' }))} /><b>When it reaches a price you name</b><small>A fixed level.</small></label>
            </div>
            <div className="pr-cw-grid">
              {params.mode === 'trail' ? <Field label="Fall from the high, in percent" error={E('trailPct')}>{(p) => <input {...p} className="input" type="number" step="0.5" min={0.1} max={80} value={Number(params.trailPct ?? 5)} onChange={(e) => set('trailPct', Number(e.target.value))} />}</Field>
                : <Field label="Sell at or below" hint={inst?.quotes.bid ? `Buyers offer ${fmt.price(inst.quotes.bid.price)} now.` : undefined} error={E('price')}>{(p) => <input {...p} className="input" inputMode="decimal" value={String(params.price ?? '')} onChange={(e) => set('price', e.target.value.replace(/[,\s]/g, ''))} />}</Field>}
              <Field label="How much of it">{(p) => <select {...p} className="input" value={Number(params.sellBps ?? 10_000)} onChange={(e) => set('sellBps', Number(e.target.value))}><option value={10_000}>All of it</option><option value={5000}>Half</option><option value={2500}>A quarter</option></select>}</Field></div></> : null}
          {kind === 'floor' ? <>{moneyField('buffer', 'Restore to this much above the floor', 'Zero restores exactly to your floor.')}<p className="pr-cw-quiet">Your floor itself is set on the Safeguards page: {home.data ? fmt.money(home.data.overview.worst.line) : ''}.</p></> : null}
          {kind === 'rebalance' ? <>
            <fieldset className="pr-cw-group"><legend>Keep these shares</legend>
              <div className="pr-cw-legs">{legs.map((l, i) => <div className="pr-cw-leg" key={i}><div className="pr-cw-leg-what"><InstrumentSelect market={market.data!} value={l.instrumentId} onChange={(v) => set('legs', legs.map((x, j) => (j === i ? { ...x, instrumentId: v } : x)))} /></div>
                <div className="pr-cw-pct"><input className="input" type="number" min={1} max={99} aria-label="Share in percent" value={l.weightBps / 100} onChange={(e) => set('legs', legs.map((x, j) => (j === i ? { ...x, weightBps: Math.round(Number(e.target.value) * 100) } : x)))} /></div>
                {legs.length > 2 ? <Btn small tone="quiet" onClick={() => set('legs', legs.filter((_, j) => j !== i))}>Remove</Btn> : null}</div>)}</div>
              {legs.length < 6 ? <div><Btn small onClick={() => set('legs', [...legs, { instrumentId: 'amfi:148381', weightBps: 1000 }])}>Add a holding</Btn></div> : null}
              <p className={`small ${legs.reduce((s, l) => s + l.weightBps, 0) === 10_000 ? 'muted' : 'void'}`}>Shares add up to {legs.reduce((s, l) => s + l.weightBps, 0) / 100}%. They must make 100%.</p>{E('legs') ? <span className="err">{E('legs')}</span> : null}</fieldset>
            <Field label="Trade only when a share is this far off, in percent of the mix" error={E('bandBps')}>{(p) => <input {...p} className="input" type="number" step="0.5" min={0.5} max={30} value={Number(params.bandBps ?? 500) / 100} onChange={(e) => set('bandBps', Math.round(Number(e.target.value) * 100))} />}</Field>
            <ScheduleField value={params.schedule as Sched} onChange={(s) => set('schedule', s)} error={E('schedule')} /></> : null}
          {kind === 'split' ? <>
            <fieldset className="pr-cw-group"><legend>When income arrives, send</legend>
              <div className="pr-cw-legs">{rules.map((r, i) => <div className="pr-cw-leg" key={i}>
                <div className="pr-cw-pct"><input className="input" type="number" min={1} max={100} aria-label="Share in percent" value={r.shareBps / 100} onChange={(e) => set('rules', rules.map((x, j) => (j === i ? { ...x, shareBps: Math.round(Number(e.target.value) * 100) } : x)))} /></div>
                <div className="pr-cw-to"><select className="input" aria-label="Where it goes" value={r.to} onChange={(e) => set('rules', rules.map((x, j) => (j === i ? (e.target.value === 'card' ? { to: 'card', shareBps: x.shareBps } : { to: 'fund', instrumentId: 'amfi:120716', shareBps: x.shareBps }) : x)))}><option value="fund">% into</option><option value="card">% to your card</option></select></div>
                {r.to === 'fund' ? <div className="pr-cw-leg-what"><InstrumentSelect market={market.data!} value={r.instrumentId ?? ''} onChange={(v) => set('rules', rules.map((x, j) => (j === i ? { ...x, instrumentId: v } : x)))} /></div> : <div className="pr-cw-leg-what" />}
                {rules.length > 1 ? <Btn small tone="quiet" onClick={() => set('rules', rules.filter((_, j) => j !== i))}>Remove</Btn> : null}</div>)}</div>
              {rules.length < 5 ? <div><Btn small onClick={() => set('rules', [...rules, { to: 'card', shareBps: 1000 }])}>Add a share</Btn></div> : null}{E('rules') ? <span className="err">{E('rules')}</span> : null}</fieldset>
            {moneyField('minIncome', 'Only split income of at least')}</> : null}
        </Step>

        <Step n={2} id="limits-h" title="Its bound" live={draft ? <BoundPreview draft={draft} sellOnly={sellOnly} kind={kind} /> : pending}>
          {kind === 'goal' ? <p className="pr-cw-quiet">Its bound is the goal itself: {draft ? <>at most <strong>{fmt.money(draft.authority.maxPerRun)}</strong> in one run and in one month, until the end of {fmt.isoDay(String(draft.params.date))}</> : 'its monthly figure, once a month, until the end of its date'}. Each contribution goes only into the goal's set-aside, and no instruction can spend what is there; only you can release it, with your passkey.</p> : null}
          {kind !== 'goal' && !sellOnly ? <div className="pr-cw-grid">
            <Field label="Most in one run" error={E('maxPerRun')}>{(p) => <MoneyInput {...p} value={A('maxPerRun') ?? null} onChange={(v) => setA({ maxPerRun: v ?? 0 })} />}</Field>
            <Field label="Most in one month" error={E('maxPerMonth')}>{(p) => <MoneyInput {...p} value={A('maxPerMonth') ?? null} onChange={(v) => setA({ maxPerMonth: v ?? 0 })} />}</Field>
          </div> : sellOnly ? <p className="pr-cw-quiet">This instruction only sells, so it has no spending limits. It can never buy or pay.</p> : null}
          {kind !== 'goal' ? <div className="pr-cw-grid">
            <Field label="Authority ends on" hint="It always ends. At most 400 days from now." error={E('expiresAt')}>{(p) => <input {...p} className="input" type="date" value={A('expiresAt') ? istDate(A('expiresAt')) : ''} min={istDate(Date.now() + DAY)} onChange={(e) => { if (e.target.value) setA({ expiresAt: endOfDayIst(e.target.value) }) }} />}</Field>
            {inst?.kind === 'crypto_spot' || kind === 'floor' ? <Field label="Worst price it may accept" hint="Away from the best price on the book at that moment.">{(p) => <select {...p} className="input" value={A('maxSlippageBps') ?? 100} onChange={(e) => setA({ maxSlippageBps: Number(e.target.value) })}><option value={50}>0.5%</option><option value={100}>1%</option><option value={200}>2%</option><option value={500}>5%</option></select>}</Field> : null}
          </div> : null}
        </Step>

        <Step n={3} id="mode-h" title="How it acts" live={runMode ? <div className="pr-cw-says"><p className="pr-cw-live-k">Each run</p><p>{MODE_MEANS[runMode]}</p>{draft ? <FirstRun analysis={draft.analysis} /> : null}</div> : <p className="pr-cw-quiet">Choose how it acts. Until you choose, nothing is assumed.</p>}>
          <div className="choice pr-cw-modes" role="radiogroup" aria-labelledby="mode-h">
            <label><input type="radio" name="runMode" checked={runMode === 'approve'} onChange={() => setA({ runMode: 'approve' })} /><b>Ask me each time</b><small>It prepares each run and does nothing until you approve that run. Unanswered requests lapse after 24 hours.</small></label>
            <label><input type="radio" name="runMode" checked={runMode === 'notify'} onChange={() => setA({ runMode: 'notify', noticeSec: auth.noticeSec ?? 86_400 })} /><b>Tell me first, then run unless I object</b><small>You get notice before every run and can stop that run.</small></label>
            <label><input type="radio" name="runMode" checked={runMode === 'auto'} onChange={() => setA({ runMode: 'auto' })} /><b>On its own</b><small>It runs inside the limits above without asking. You still see every run, and can pause or revoke at any time.</small></label>
          </div>
          {E('runMode') ? <span className="err">{E('runMode')}</span> : null}
          {runMode === 'notify' ? <div className="pr-cw-notice"><Field label="Notice before each run" hint="Indian mandate rules require 24 hours. Shorter is a paper setting for trying it out.">{(p) => <select {...p} className="input" value={A('noticeSec') ?? 86_400} onChange={(e) => setA({ noticeSec: Number(e.target.value) })}><option value={86_400}>24 hours</option><option value={3600}>1 hour</option><option value={600}>10 minutes</option><option value={60}>1 minute</option></select>}</Field></div> : null}
        </Step>

        <Step n={4} id="follows-h" title="What follows, and signing" wide>
          {draft ? <Consequences analysis={draft.analysis} heading={false} /> : pending}
          {draft ? <details className="pr-cw-doc"><summary><span>The document you would sign</span><small>Every clause as it stands now, word for word. The same document is shown again when you sign.</small></summary><InstrumentDoc doc={draft.doc} state="draft" /></details> : null}
          <div className="pr-cw-sign">
            {allows ? <p className="pr-cw-allows" aria-live="polite">{allows}</p> : null}
            {refused ? <p className="pr-cw-refused">It cannot be signed as it stands. The reasons are listed above.</p> : null}
            <Problem error={previewError ?? sign.error ?? saveOnly.error} />
            {conflicts ? <div ref={conflictRef} tabIndex={-1} role="alert" className="pr-cw-conflicts"><Note tone="wait" title="This instruction contradicts itself or what you wrote">
              <p className="small">Change the instruction above, or accept each point below. What you accept is written into the document your passkey signs.</p>
              <div className="pr-cw-accepts">{conflicts.list.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={accepted.includes(c.id)} onChange={(e) => setAccepted((xs) => (e.target.checked ? [...xs, c.id] : xs.filter((x) => x !== c.id)))} /> <span>I accept: {c.text}</span></label>)}</div>
            </Note></div> : null}
            <div className="pr-cw-go">
              <Btn tone="fill" type="submit" className="lg" busy={sign.busy} disabled={!draft || refused || hasErrors || (!!conflicts && conflicts.list.some((c) => !accepted.includes(c.id)))}>{conflicts ? 'Accept and continue to signing' : 'Review and sign'}</Btn>
              <Btn className="lg" busy={saveOnly.busy} disabled={!draft || hasErrors} onClick={() => void saveOnly.run()}>Save as a draft</Btn>
              <Link className="btn quiet lg" to={amendId ? `/instructions/${amendId}` : '/instructions'}>Cancel</Link>
            </div>
            <p className="pr-cw-quiet">Nothing is saved, and nothing can act, until your passkey signs the document. A draft is kept unsigned until you sign it or discard it.</p>
          </div>
        </Step>
      </form>

      <ApprovalSheet approval={approval} title="Sign this instruction" action="Sign and put in force" onClose={() => { const id = approval?.programId; setApproval(null); if (id) navigate(`/instructions/${id}`) }}
        onApproved={async (approvalId) => { const id = approval!.programId; await api('POST', `/api/programs/${id}/activate`, { approvalId }); setApproval(null); navigate(`/instructions/${id}`) }}>
        {approval ? <InstrumentDoc doc={approval.doc} version={approval.version} state="review" /> : null}
      </ApprovalSheet>
    </div>
  )
}

/**
 * The live preview of an instruction's bound: one run, one month and everything until it ends as brackets on one scale,
 * so the limits are seen to nest; then its effect on the worst case against the floor, as the server worked it out.
 */
function BoundPreview({ draft, sellOnly, kind }: { draft: Draft; sellOnly: boolean; kind: string }) {
  const a = draft.authority, all = draft.doc.ceilingPaise
  const w = draft.analysis.worst
  const rows: [string, number][] = typeof all === 'number' ? [['One run', a.maxPerRun], ['One month', a.maxPerMonth], ['In all', all]] : []
  const top = Math.max(1, ...rows.map((r) => r[1]))
  const fall = w ? w.before - w.after : 0
  return (
    <div className="pr-cw-bound">
      {sellOnly || typeof all !== 'number' ? <p className="pr-cw-says-big">Sells only<small>It never buys and never pays anyone. It ends {fmt.dayYear(a.expiresAt)}.</small></p> : <>
        <p className="pr-cw-live-k">Its limits, on one scale</p>
        <ul className="pr-cw-ladder">
          {rows.map(([label, v]) => <li key={label}><span className="k">{label}</span><span className="bar" aria-hidden="true"><i style={{ width: `${((v / top) * 100).toFixed(2)}%` }} /></span><b>{fmt.money(v)}</b></li>)}
        </ul>
        <p className="pr-cw-quiet">Until {fmt.dayYear(a.expiresAt)}. QED's server refuses a run beyond any of these, whatever the reason.</p>
      </>}
      {w ? (
        <div className="pr-cw-worst">
          <p className="pr-cw-live-k">Your worst case<small>all you have if prices fall to your limits, less what you owe</small></p>
          <p className="pr-cw-worst-line"><b>{fmt.money(w.before)}</b> now{fall > 0 ? <>, <b>{fmt.money(w.after)}</b> after it acts once <span className="nowrap">({MINUS}{fmt.money(fall)})</span></> : <>; {kind === 'floor' || kind === 'exit' ? 'it only sells, so it can only raise it' : 'it does not change'}</>}. Your floor is <b>{fmt.money(w.line)}</b>{w.after < w.line ? <span className="void">: a run would be refused today, below your floor</span> : <>, <span className="nowrap">{fmt.money(w.after - w.line)}</span> above it{fall > 0 ? ' after it acts' : ''}</>}.</p>
          {w.illustrative ? <p className="pr-cw-quiet">The limits behind this are illustrative, not calibrated.</p> : null}
          {!w.valid ? <p className="pr-cw-quiet void">The worst case cannot be relied on right now; the reasons are listed in step 4.</p> : null}
        </div>
      ) : null}
    </div>
  )
}
const MINUS = '−'

/** When the first run would be, if the server's figures say. */
function FirstRun({ analysis }: { analysis: Analysis }) {
  const f = analysis.figures.find((x) => /^First run|^Next run/.test(x.label))
  return f ? <p className="pr-cw-quiet">{f.label}: {f.value}.</p> : null
}
