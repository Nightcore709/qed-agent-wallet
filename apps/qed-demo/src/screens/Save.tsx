/**
 * Save (Meridian, DESIGN.md M4 and M6): what must stay in the bank for what falls due, what is free, the days that
 * figure has to cover, what a harder month would do to them, and what holds money back, each with its limit.
 *
 * Row one is the reserve: the figure that must stay, the bank at true scale with QED's bracket over the free part, the
 * subtraction that leaves what is free, and what the figure allows for (with the control that changes it); beside it,
 * what the figure pays for, each bill and instalment on its day, adding up to it. Row two is the cash flow: the balance
 * at worst day by day as true steps, what each standing instruction may do on the same days, and beside it the what-if,
 * whose harder assumptions are worked out in this browser to the paisa and drawn over the recorded line, changing
 * nothing in the account. Row three: what is kept and set aside with its limit, the most the instructions could take,
 * and the floor if markets fell.
 *
 * Every figure is the server's (server/liquidity.ts, the same figure every instruction is checked against); the
 * what-if is the only figure worked out here, and it says so wherever it appears.
 */
import { ChevronRight, PiggyBank, Plus, RotateCcw, Target } from 'lucide-react'
import { type Dispatch, lazy, type SetStateAction, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { fmt, type Resource, useData } from '../lib/core.ts'
import { homeCurrency } from '../../shared/home-money.ts'
import type { GoalsView, Home, Liquidity, PassbookView, ProgramSummary } from '../lib/types.ts'
import { GoalCard } from '../ui/goal.tsx'
import { dayName, FloorRule, NO_WHAT_IF, Paise, runwayOf, scoreLanes, type WalletGrants, type WhatIf, whatIf, whatIfChoices, type WhatIfResult, whatIfSum } from '../ui/charts.tsx'
import { Btn, EmptyState, Field, Link, MoneyBar, MoneyInput, Note, Problem, Swatch } from '../ui/kit.tsx'
import { ReserveBasis } from '../ui/reserve.tsx'
import { Score } from '../ui/score-lazy.tsx' // the chart is its own chunk, fetched once the figure and controls are drawn (R12 perf)
import { Envelope, NotCounted, ReserveAllows, type ReserveData, ReserveShort, Skel, Terms } from './Safeguards.tsx'
// The on-chain wallet's part is its own chunk, fetched once Save's figure and controls are drawn: it was the larger
// part of what a phone waited for before Save's figure (R12 perf, D-R12-G1; measured 2.61 s with it, 2.42 s without).
const WalletSetAside = lazy(() => import('./WalletInline.tsx').then((m) => ({ default: m.WalletSetAside })))
const SaveInCurrencies = lazy(() => import('./Abroad.tsx').then((m) => ({ default: m.SaveInCurrencies })))

interface VaultBrief {
  setUp: boolean
  workspace?: { reserveAsset: { decimals: number } } | null
  state: { provisioned: boolean; treasury: { balance: string; ringFenced: string; free: string; paused: boolean }; reserve: { balance: string; free: string }; mandate: WalletGrants['mandate']; policy: { status: string; targetFree: string } | null } | null
}

/** What a saving instruction may still move this month: the policy check's own count against its signed limit. */
const left = (p: ProgramSummary): { left: number; of: number; used: number } | null => p.authority && p.usedThisMonth !== null && p.usedThisMonth !== undefined ? { left: Math.max(0, p.authority.maxPerMonth - p.usedThisMonth), of: p.authority.maxPerMonth, used: Math.min(p.usedThisMonth, p.authority.maxPerMonth) } : null
const MINUS = '−'
/** The worst the owner allows for, in words (as Safeguards says it). */
const hardship = (a: { lateDays: number; lostSalaries: number }): string =>
  [a.lateDays > 0 ? `income up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : '', a.lostSalaries > 0 ? `${a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} not arriving` : ''].filter(Boolean).join(' and ')

/** The page's head: drawn before any of its data (DESIGN.md M11), and never replaced while the data arrives. */
function Head() {
  return (
    <header className="page-head sv-head">
      <div><h1>Save</h1><p>What must stay in your bank for what falls due, what is free to use, what you are setting aside for goals, and what a harder month would do. No instruction can spend what must stay; you can, and QED tells you when you do. Money set aside for a goal stays there until you release it.</p></div>
      <div className="row sv-acts">
        <Link className="btn fill" to="/instructions/new?kind=sweep">Park idle cash</Link>
        <Link className="btn" to="/instructions/new?kind=goal">Save for a goal</Link>
        <a className="btn" href="#what-if" onClick={() => requestAnimationFrame(() => document.getElementById('wi-h')?.focus({ preventScroll: true }))}>Try a harder month</a>
      </div>
    </header>
  )
}

export function SaveScreen() {
  const home = useData<Home>('/api/home', ['action', 'run', 'program', 'bill', 'profile', 'stop'])
  const liq = useData<ReserveData>('/api/liquidity', ['action', 'program', 'profile', 'bill', 'run'])
  const book = useData<PassbookView>('/api/passbook?limit=1', ['action', 'run', 'bill', 'program', 'profile'])
  const progs = useData<{ programs: ProgramSummary[] }>('/api/programs', ['program', 'run'])
  const vault = useData<VaultBrief>('/api/vault', ['vault'])
  const goals = useData<GoalsView>('/api/goals', ['program', 'run', 'action'])
  const error = home.error ?? liq.error
  const ready = !!home.data && !!liq.data && (!!book.data || !!book.error)
  return (
    <div className="sv">
      <Head />
      {ready ? <SaveBody h={home.data!} data={liq.data!} expected={book.data?.expected ?? null} progs={progs} vault={vault.data} goals={goals} reload={() => { liq.reload(); home.reload() }} />
        : error ? <Problem error={error} /> : <SaveWaiting />}
    </div>
  )
}

function SaveBody({ h, data, expected, progs, vault, goals, reload }: { h: Home; data: ReserveData; expected: PassbookView['expected'] | null; progs: Resource<{ programs: ProgramSummary[] }>; vault: VaultBrief | null; goals: Resource<GoalsView>; reload: () => void }) {
  const l = data.liquidity, o = h.overview
  const shape = useMemo(() => runwayOf(l, expected ?? []), [l, expected])
  const v = vault?.setUp && vault.state?.provisioned ? vault.state : null
  const decimals = vault?.workspace?.reserveAsset.decimals ?? 6
  const may = data.envelope.windows.find((x) => x.days === 30)?.most ?? 0
  const lanes = scoreLanes({ programs: h.programs, expected: expected ?? [], today: l.today, stopped: !!h.stop, worst: o.worst, wallet: v ? { mandate: v.mandate, policy: v.policy, reserveDecimals: decimals } : null })
  // goals have their own panel above; this part lists the instructions that move idle cash
  const saving = (progs.data?.programs ?? []).filter((p) => p.pillar === 'save' && p.kind !== 'goal' && ['active', 'paused', 'draft'].includes(p.state))

  // the what-if: harder assumptions tried here and drawn over the recorded line; nothing is saved or sent
  const [w, setW] = useState<WhatIf>(NO_WHAT_IF)
  const [bill, setBill] = useState('')
  const [more, setMore] = useState<number | null>(null)
  const choices = useMemo(() => whatIfChoices(l.path, shape.basis), [l.path, shape.basis])
  const picked = choices.bills.find((b) => `${b.date}|${b.label}` === bill) ?? null
  const scenario = useMemo<WhatIf>(() => ({ ...w, bill: picked && more ? { date: picked.date, label: picked.label, more } : null }), [w, picked, more])
  const r = useMemo(() => whatIf(l.path, shape.basis, scenario), [l.path, shape.basis, scenario])

  const isShort = l.short > 0
  const free = isShort ? 0 : l.free
  const b = l.binding
  const a = l.assumptions
  const worstWords = `Income ${a.lateDays > 0 ? `up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : 'on its day'}${a.lostSalaries > 0 ? `, ${a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} lost` : ''}, every bill and instalment on its day, everyday spending at your figure. The steps are the days money moves.`

  return (
    <>
      <div className="sv-top">
        <section className={`panel sv-reserve ${isShort ? 'is-short' : ''}`} id="reserve" aria-labelledby="reserve-h">
          <div className="sv-reserve-head"><h2 id="reserve-h">{isShort ? 'Short for what is due' : 'Must stay in the bank'}</h2><span className="sv-asof">Worked out for {fmt.isoDay(l.today)}</span></div>
          <p className={`sv-hero ${isShort ? 'short' : ''}`} data-resolve="" data-reserve={isShort ? 'short' : 'need'}><Paise paise={isShort ? l.short : l.need} /></p>
          <p className="sv-hero-sub">{isShort
            ? 'If the worst you allow for happens, something due could not be paid. Nothing has failed yet.'
            : b ? `Enough for everything due until ${fmt.isoDay(b.date)}, when money is tightest, even if the worst you allow for happens. No instruction can spend it.` : `Nothing due in the next ${l.horizonDays} days needs money that is not certain to arrive first.`}</p>
          <ReserveBar l={l} may={may} />
          <ReserveBasis l={l} />
          <Terms label="What is free, as a subtraction" terms={[
            { k: 'In your bank', v: fmt.money(l.available, true), s: o.bankHeld > 0 ? `Not counting ${fmt.money(o.bankHeld, true)} held for orders in flight and payments on hold` : `Paper money for practice, as of ${fmt.time(o.asOf)}` },
            { op: MINUS, k: <><Swatch tone="kept" />Must stay</>, v: <span data-reserve="need">{fmt.money(l.need, true)}</span>, s: b ? `For what falls due to ${fmt.isoDay(b.date)}, at worst` : 'Nothing due needs money that is not certain to arrive first' },
            { op: '=', hero: true, k: <><Swatch tone={isShort ? 'short' : 'free'} />{isShort ? 'Short' : 'Free to use'}</>, v: <Paise paise={isShort ? l.short : free} />, tone: isShort ? 'short' : undefined, s: isShort ? 'Something due could not be paid at worst' : 'No day needs it, even at worst' },
          ]} />
          <ReserveShort l={l} />
          <ReserveAllows l={l} profile={h.profile} onSaved={reload} notCounted={false} />
        </section>
        <Dues l={l} />
      </div>

      <Goals goals={goals} onChanged={() => { goals.reload(); reload() }} />

      {/* R13: balances by currency, the paper desk, and a goal in another currency (Abroad.tsx) */}
      {homeCurrency() === 'INR' ? (
      <Suspense fallback={<section className="panel ccy" aria-busy="true"><p className="loading-line">Reading your balances in each currency…</p></section>}><SaveInCurrencies /></Suspense>
      ) : null}

      <section className="panel sv-flow" id="flow" aria-labelledby="flow-h">
        <Score path={l.path} start={l.available} free={free} short={l.short} lowDate={b?.date ?? null} lanes={lanes} basis={shape.basis} whatIf={r} asOf={l.asOf}
          title={<h2 id="flow-h">Your bank balance, day by day, at worst</h2>} sub={worstWords}
          rail={<WhatIfRail l={l} r={r} w={w} setW={setW} bill={bill} setBill={setBill} more={more} setMore={setMore} choices={choices} beyond={shape.beyond} />}
          foot={<><Link to="/passbook">Every line of your bank account, and what is expected<ChevronRight aria-hidden="true" /></Link><Link to="/protect">Review and change what QED may do<ChevronRight aria-hidden="true" /></Link></>} />
      </section>

      {/* R14: the most the instructions could take over the floor on the left, what is kept and set aside beside both on
          the right; the two columns end on one line (save.css .sv-board). In the page, and so for the keyboard and on a
          phone, the left column comes first. */}
      <div className="sv-board">
        <Envelope env={data.envelope} />

        <section className="panel sv-floor fills" aria-labelledby="floor-h">
          <div className="panel-head"><h2 id="floor-h">Your floor</h2><p>If markets fell to your limits</p></div>
          <p className="sv-lead-k">{o.worst.cushion >= 0 ? 'Above your floor' : 'Below your floor'}</p>
          <p className={`sv-lead ${o.worst.cushion < 0 ? 'short' : ''}`}><Paise paise={Math.abs(o.worst.cushion)} /></p>
          <p className="sv-floor-says"><b>{fmt.money(o.worst.gHat, true)}</b> would be left if every holding fell by its limit at once; your floor is <b>{fmt.money(o.worst.line, true)}</b>, so you are <b className={o.worst.cushion < 0 ? 'short' : ''}>{fmt.money(Math.abs(o.worst.cushion), true)} {o.worst.cushion >= 0 ? 'above' : 'below'}</b> it. QED refuses its own purchases that would take you below it.</p>
          {!o.worst.valid ? <Note tone="void" title="This figure cannot be relied on right now">{o.worst.invalidReasons.join('. ')}. While that lasts QED refuses purchases that depend on it.</Note> : null}
          <FloorRule worst={o.worst.gHat} fall={o.worst.holdingsValue - o.worst.holdingsWorst} floor={o.worst.line} />
          <p className="sv-more-link"><Link to="/safeguards#floor">Your floor, line by line, and how to change it<ChevronRight aria-hidden="true" /></Link></p>
        </section>

        <section className="panel sv-kept fills" aria-labelledby="kept-h">
          <div className="panel-head"><h2 id="kept-h">Kept and set aside, each with its limit</h2><p>What may hold money back, and the most each may move</p></div>
          <section className="sv-part fills" aria-labelledby="own-h">
            <div className="sv-part-head"><h3 id="own-h">Saving on its own</h3><p>Instructions that move idle cash</p></div>
            {!progs.data && !progs.error ? <Skel h={64} r={14} /> : progs.error ? <Problem error={progs.error} /> : saving.length === 0 ? (
              <EmptyState fill as="h4" icon={<PiggyBank />} title="No saving instruction yet" action={<Link className="btn sm" to="/instructions/new?kind=sweep"><Plus aria-hidden="true" />Write a saving instruction</Link>}>
                QED can keep a buffer in your bank and move the rest into a liquid fund, bringing it back when the buffer runs low.{l.free > 0 ? ` Today ${fmt.money(l.free, true)} is free: no day needs it.` : ''}
              </EmptyState>
            ) : (
              <ul className="sv-saves">
                {saving.map((p) => {
                  const m = left(p)
                  const keep = typeof p.params.keep === 'number' ? p.params.keep : null
                  const sub = `${p.state === 'paused' ? 'Paused. ' : p.state === 'draft' ? 'Not signed yet. ' : ''}${keep !== null ? `Keeps ${fmt.money(keep)} in the bank before it parks anything.` : ''}`.trim()
                  return (
                    <li key={p.id}>
                      <div className="sv-save-top"><Link to={`/instructions/${p.id}`} className="sv-save-t">{p.title}</Link><span className="sv-save-fig">{m ? <><b>{fmt.money(m.left)} left</b> of {fmt.money(m.of)} this month</> : 'No limit in force'}</span></div>
                      {m ? <div className="meter" role="meter" aria-label={`${p.title}: ${fmt.money(m.used)} used of ${fmt.money(m.of)} this month, ${fmt.money(m.left)} left`} aria-valuemin={0} aria-valuemax={m.of} aria-valuenow={m.left}><i style={{ width: `${Math.max(0, Math.min(100, (m.left / Math.max(1, m.of)) * 100))}%` }} /></div> : null}
                      {sub ? <p className="sv-save-sub">{sub}</p> : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          <section className="sv-part fills" aria-labelledby="chain-h">
            <div className="sv-part-head"><h3 id="chain-h">Set aside on the chain</h3><p>Test rupees on a local chain</p></div>
            <div className="sv-chain"><Suspense fallback={<div aria-busy="true"><p className="loading-line">Reading the wallet on the chain…</p><Skel h={160} r={16} /></div>}><WalletSetAside /></Suspense></div>
            {v ? <DollarReserve v={v} decimals={decimals} /> : null}
          </section>
        </section>
      </div>
    </>
  )
}

/**
 * Saving for goals (R12 task comparison, gap 5): each goal with where it stands by the stated rule, its monthly figure,
 * and when it is behind the remedies in figures (ui/goal.tsx). The set-asides are the household's own accounts in the
 * paper bank: not free to use, not in "In your bank" above, and no instruction can spend them.
 */
function Goals({ goals, onChanged }: { goals: Resource<GoalsView>; onChanged: () => void }) {
  const list = goals.data?.goals ?? []
  // a link to a goal (Home's "See how to catch up": /save#goal-<id>) lands on it once the goals have been read; the router
  // looks for two seconds, and on a phone the data alone can take longer (as Spend lands on a bill's review, gap 13)
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !goals.data) return
    const id = location.hash.slice(1)
    const el = id.startsWith('goal') ? document.getElementById(id) : null
    if (!el) return
    landed.current = true
    requestAnimationFrame(() => { el.scrollIntoView({ block: 'start' }); if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus({ preventScroll: true }) })
  }, [goals.data])
  const total = list.reduce((s, g) => s + g.setAside + g.onItsWay, 0)
  return (
    <section className="panel sv-goals" id="goals" aria-labelledby="goals-h">
      <div className="sv-goals-head">
        <div><h2 id="goals-h">Saving for goals</h2><p>{!list.length ? 'Money set aside each month for something you name, where no instruction can spend it' : `${total > 0 ? `${fmt.money(total, total % 100 !== 0)} set aside, kept out of what is free to use.` : 'Nothing is set aside yet; each contribution is kept out of what is free to use.'} No instruction can spend it; only you can release it, with your passkey.`}</p></div>
        {list.length ? <Link className="btn sm" to="/instructions/new?kind=goal"><Plus aria-hidden="true" />Save for another goal</Link> : null}
      </div>
      {!goals.data ? (goals.error ? <Problem error={goals.error} /> : <Skel h={180} r={18} />) : list.length === 0 ? (
        <EmptyState across icon={<Target />} title="No goal yet" action={<Link className="btn sm" to="/instructions/new?kind=goal"><Plus aria-hidden="true" />Save for a goal</Link>}>
          Name an amount and a date, a holiday in March or school fees in June. QED works out what to set aside each month, asks before each one, and keeps the money where no instruction can spend it until you release it.
        </EmptyState>
      ) : (
        <ul className="sv-goal-list">{list.map((g) => <li key={g.id}><GoalCard g={g} onChanged={onChanged} /></li>)}</ul>
      )}
    </section>
  )
}

/**
 * The bank at true scale on the money bar (DESIGN.md M14): free, then what must stay (or the shortfall, a dashed
 * hollow), with the span of the most QED may move under the free part it may come from.
 */
function ReserveBar({ l, may }: { l: Liquidity; may: number }) {
  const isShort = l.short > 0
  const free = isShort ? 0 : l.free
  const kept = Math.min(l.available, l.need)
  const reach = may > 0 && free > 0
  const label = isShort
    ? `${fmt.money(l.available, true)} in your bank, and ${fmt.money(l.need, true)} must stay: ${fmt.money(l.short, true)} short. QED's instructions may move nothing from the bank until that is covered.`
    : `${fmt.money(free, true)} free and ${fmt.money(kept, true)} kept make the ${fmt.money(l.available, true)} in your bank.${reach ? ` QED may move at most ${fmt.money(may)} in 30 days, from the free part only.` : ''}`
  return (
    <MoneyBar className="sv-bar" label={label} parts={[{ tone: 'free', value: free, reach: reach ? may : 0 }, { tone: 'kept', value: kept }, { tone: 'short', value: l.short }]} keys={[
      ...(free > 0 ? [{ tone: 'free' as const, text: 'Free' }] : []),
      { tone: 'kept', text: 'Must stay' },
      ...(isShort ? [{ tone: 'short' as const, text: 'Short' }] : []),
      reach ? { tone: 'reach', text: <>The most QED may move in 30 days, <b>{fmt.money(may)}</b>, every instruction together, from the free part only</> } : { text: 'No instruction in force can take money from the bank.' },
    ]} />
  )
}

const DUE_KIND: Record<string, string> = { emi: 'Your bank takes it', bill: 'A registered bill' }
// R14: five dated lines, then the rest folded with its sum: the statement stays about as tall as the figure's own panel
// beside it, so neither is left with a hole (it was eight, and the pair stood up to 200 px apart)
const CAP = 5
/**
 * What the figure pays for, as a statement: each bill and instalment through the hardest day on its own day, then the
 * everyday spending to that day, less income certain to have arrived first. Read down, it adds up to what must stay.
 */
function Dues({ l }: { l: Liquidity }) {
  const [all, setAll] = useState(false)
  const b = l.binding
  const a = l.assumptions
  const allowing = hardship(a)
  const living = b?.parts.find((p) => p.kind === 'living')
  const items = b ? [...b.items].sort((x, y) => x.step - y.step) : []
  const folded = !all && items.length > CAP + 1
  const shown = folded ? items.slice(0, CAP) : items
  const rest = items.slice(CAP)
  const fc = a.firstCounted
  return (
    <section className="panel sv-dues" aria-labelledby="dues-h">
      <div className="panel-head"><h2 id="dues-h">What it pays for</h2>{b ? <p>{items.length} bill{items.length === 1 ? '' : 's'} and instalments</p> : null}</div>
      <p className="sv-dues-says">{b ? `Everything due until ${fmt.isoDay(b.date)}, when money is tightest${allowing ? `, allowing for ${allowing}` : ''}.` : `Nothing due in the next ${l.horizonDays} days needs money that is not certain to arrive first.`}</p>
      {b ? (
        <dl className="sv-dues-list">
          {shown.map((i, k) => <div key={k}><dt><span className="when">{i.step === 0 ? 'Today' : dayName(i.date)}</span><span className="what">{i.label}<small>{DUE_KIND[i.kind] ?? ''}</small></span></dt><dd>{fmt.money(i.amount, true)}</dd></div>)}
          {folded ? <div className="fold"><dt><span className="when">{rest.length > 0 ? `to ${dayName(rest[rest.length - 1]!.date).replace(/^\w+ /, '')}` : ''}</span><span className="what"><button type="button" className="linkish" aria-expanded={false} onClick={() => setAll(true)}>And {rest.length} more bills and instalments</button></span></dt><dd>{fmt.money(rest.reduce((s, i) => s + i.amount, 0), true)}</dd></div> : null}
          {living ? <div className="spend"><dt><span className="when">to {dayName(b.date).replace(/^\w+ /, '')}</span><span className="what">Everyday spending<small>Your figure of {fmt.money(a.spending)} a month, spread over the days of each month</small></span></dt><dd>{fmt.money(living.amount, true)}</dd></div> : null}
          {b.inflows > 0 ? <div className="income"><dt><span className="when" /><span className="what">Income certain to have arrived before then</span></dt><dd>{MINUS}{fmt.money(b.inflows, true)}</dd></div> : null}
          <div className="total"><dt><span className="when" /><span className="what">Must be in the bank today</span></dt><dd data-reserve="need">{fmt.money(l.need, true)}</dd></div>
        </dl>
      ) : null}
      {all && items.length > CAP + 1 ? <p className="sv-dues-less"><button type="button" className="linkish" aria-expanded={true} onClick={() => setAll(false)}>Show the first {CAP} only</button></p> : null}
      <div className="sv-dues-foot">
      <NotCounted l={l} />
      <p className="sv-dues-note">{a.income > 0 ? (fc ? <>QED counts on the salary due {fmt.isoDay(fc.due)}{fc.by !== fc.due ? ` only from ${fmt.isoDay(fc.by)}, the latest it may arrive` : ''}.{a.lostSalaries > 0 ? ` ${a.lostSalaries === 1 ? 'The one before it is' : 'The ones before it are'} treated as lost.` : ''} </> : `No salary is counted on in the next ${l.horizonDays} days. `) : null}The figure is the least that pays everything listed, each at its worst. It does not cover a bill that is not on record, or spending above your figure.</p>
      </div>
      {!l.sustainable ? <Note tone="wait" title="More may be needed than this">The hardest day found is at the end of the {l.horizonDays} days QED looks ahead, so the figure is still rising where the look-ahead stops. The usual reason is that your recorded outgoings are larger than your income.</Note> : null}
    </section>
  )
}

/** The dollar reserve against the free amount a standing policy keeps it at: a threshold, in one row. */
function DollarReserve({ v, decimals }: { v: NonNullable<VaultBrief['state']>; decimals: number }) {
  const usd = (raw: string) => `$${(Number(raw) / 10 ** decimals).toFixed(2)}`
  const on = v.policy?.status === 'active'
  const free = Number(v.reserve.free), target = v.policy ? Number(v.policy.targetFree) : 0
  const below = on && BigInt(v.reserve.free) < BigInt(v.policy!.targetFree)
  const scale = Math.max(free, target, 1) * 1.12
  return (
    <div className="sv-dollar">
      <p className="sv-dollar-says">Dollar reserve: <b>{usd(v.reserve.balance)}</b> in test dollars{on ? <>; a standing policy aims to keep <b>{usd(v.policy!.targetFree)}</b> free{below ? ', and the reserve is below that now' : ''}</> : null}. <Link to="/vault">All of the on-chain wallet</Link></p>
      {on ? (
        <div className="sv-threshold" role="img" aria-label={`${usd(v.reserve.free)} free in the dollar reserve; the policy keeps ${usd(v.policy!.targetFree)} free${below ? ', so it is below the threshold' : ''}.`}>
          <span className="fill" style={{ width: `${(free / scale) * 100}%` }} />
          <span className="mark" style={{ left: `${(target / scale) * 100}%` }} />
          <span className={`mark-label ${target / scale > 0.6 ? 'end' : ''}`} style={{ left: `${(target / scale) * 100}%` }}>keep {usd(v.policy!.targetFree)} free</span>
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ the what-if

const LATE = [7, 10, 15, 20, 30, 45, 60]
const DAYS = Array.from({ length: 28 }, (_, i) => i + 1)
type Choices = ReturnType<typeof whatIfChoices>

/**
 * Harder assumptions, tried here: the worst case worked out again to the paisa (charts.tsx `whatIf`) and drawn over the
 * recorded line in the chart beside it, with the same days as a statement. Nothing is saved or sent and no check QED
 * makes reads it.
 */
function WhatIfRail({ l, r, w, setW, bill, setBill, more, setMore, choices, beyond }: {
  l: Liquidity; r: WhatIfResult; w: WhatIf; setW: Dispatch<SetStateAction<WhatIf>>; bill: string; setBill: (v: string) => void
  more: number | null; setMore: (v: number | null) => void; choices: Choices; beyond: { date: string; free: number } | null
}) {
  const head = useRef<HTMLHeadingElement>(null)
  const s = choices.salary
  const picked = choices.bills.find((x) => `${x.date}|${x.label}` === bill) ?? null
  const lateValue = w.salaryLost ? 'never' : w.salaryLate > (s?.allowed ?? 0) ? String(w.salaryLate) : 'as'
  // the button goes once there is nothing to clear, so the keyboard is taken to the what-if's heading instead of the page's top
  const clear = () => { setW(NO_WHAT_IF); setBill(''); setMore(null); head.current?.focus() }
  const n = l.path.length
  // one status line, always in the page, so that a screen reader hears each new result once
  const said = !r.changed ? '' : r.low.low < 0
    ? `If this happens, your bank could not pay everything due from ${dayName(r.firstShort!.date)}: at the lowest, on ${dayName(r.low.date)}, it would be ${fmt.money(-r.low.low, true)} short. Nothing in your account changes.`
    : `If this happens, the lowest your bank would stand is ${fmt.money(r.low.low, true)}, on ${dayName(r.low.date)}: ${fmt.money(r.recordedLow.low - r.low.low, true)} less than recorded. Nothing in your account changes.`
  return (
    <section className={`sv-wi ${r.changed ? 'on' : ''}`} id="what-if" aria-labelledby="wi-h">
      <div className="sv-wi-head">
        <h3 id="wi-h" ref={head} tabIndex={-1}>What if</h3>
        {r.changed ? <Btn small onClick={clear}><RotateCcw aria-hidden="true" />Clear the what-if</Btn> : <span className="sv-wi-tag">Changes nothing in your account</span>}
      </div>
      <p className="sv-wi-says">Try a harder month. The worst case is worked out again, here in your browser, and drawn over the recorded line. Nothing is saved, and no check QED makes uses it.</p>
      <p className="sr" role="status">{said}</p>
      <form className="form-grid fields sv-wi-form" aria-label="What if" onSubmit={(e) => e.preventDefault()}>
        <Field label="You spend this today" hint="By hand, any way you pay">{(p) => <MoneyInput {...p} value={w.spend > 0 ? w.spend : null} onChange={(x) => setW((c) => ({ ...c, spend: x ?? 0 }))} />}</Field>
        {s ? <Field label={`The salary due ${fmt.isoDay(s.due)} comes`} hint={s.allowed > 0 ? `You already allow for ${s.allowed} day${s.allowed === 1 ? '' : 's'} late` : 'You allow for it on its day'}>{(p) => (
          <select {...p} className="input" value={lateValue} onChange={(e) => { const x = e.target.value; setW((c) => ({ ...c, salaryLost: x === 'never', salaryLate: x === 'never' || x === 'as' ? 0 : Number(x) })) }}>
            <option value="as">{s.allowed > 0 ? `Up to ${s.allowed} day${s.allowed === 1 ? '' : 's'} late, as allowed` : 'On its day'}</option>
            {LATE.filter((d) => d > s.allowed && !s.clashes(d)).map((d) => <option key={d} value={d}>{d} days late</option>)}
            <option value="never">Never</option>
          </select>)}</Field>
          : <div className="field"><span className="legend sv-wi-label">A late or lost salary</span><p className="hint">{l.assumptions.income > 0 ? `No salary is counted on in the ${n} days drawn, so none can be later here.` : 'No salary is recorded for this household.'}</p></div>}
          <Field label="A bill or instalment is larger" hint={picked ? `${fmt.money(-picked.amount, true)} as recorded, due ${dayName(picked.date)}` : choices.bills.length ? 'Which one' : `None is named in the ${n} days drawn`}>{(p) => (
            <select {...p} className="input" value={bill} onChange={(e) => setBill(e.target.value)} disabled={choices.bills.length === 0}>
              <option value="">None</option>
              {choices.bills.map((x) => <option key={`${x.date}|${x.label}`} value={`${x.date}|${x.label}`}>{x.label}, {dayName(x.date)}</option>)}
            </select>)}</Field>
          <Field label="Larger by" hint={picked ? 'How much more it could be' : 'Choose which one first'}>{(p) => <MoneyInput {...p} value={more} onChange={setMore} />}</Field>
          <Field label="A new cost each month" hint="On the same day each month">{(p) => <MoneyInput {...p} value={w.monthly?.amount ?? null} onChange={(x) => setW((c) => ({ ...c, monthly: x ? { amount: x, day: c.monthly?.day ?? 1 } : null }))} />}</Field>
          <Field label="On day" hint="1 to 28">{(p) => <select {...p} className="input" value={w.monthly?.day ?? 1} onChange={(e) => setW((c) => ({ ...c, monthly: c.monthly ? { ...c.monthly, day: Number(e.target.value) } : null }))} disabled={!w.monthly}>{DAYS.map((d) => <option key={d} value={d}>{d}</option>)}</select>}</Field>
      </form>

      {r.changed ? <WhatIfResultView r={r} l={l} beyond={beyond} /> : <p className="sv-wi-idle">Nothing is changed yet. Set any of these to see that month on the chart.</p>}

      <details className="sv-more">
        <summary>What a what-if cannot change</summary>
        <ul className="small muted">
          <li>It only makes the case harder: it adds to what leaves the bank or delays what arrives. To allow for more or less in earnest, change what the figure allows for, above; your passkey confirms allowing for less.</li>
          <li>It moves only the first salary the worst case counts on. Later salaries, and income other than your salary, stay as recorded.</li>
          <li>It can make a bill or instalment QED knows of larger, and add one cost on a day of each month; it cannot add a bill on a date of its own or change one QED does not know of.</li>
          <li>It looks at the {n} days drawn. QED looks {l.horizonDays} days ahead for what must stay.</li>
          <li>It does not change what your instructions may do. They may use only what is free, and a run that would take what must stay is refused.</li>
          <li>Prices and holdings are not in this worst case: a fall in markets is your floor's question, on <Link to="/safeguards#floor">Safeguards</Link>.</li>
          <li>Nothing is kept: leave this page and it is gone.</li>
        </ul>
      </details>
    </section>
  )
}

function WhatIfResultView({ r, l, beyond }: { r: WhatIfResult; l: Liquidity; beyond: { date: string; free: number } | null }) {
  const sum = whatIfSum(r.recordedLow.low, r.low.low)
  // when the hardest day is after the days drawn, the lowest point drawn is not what is free: say what it is
  const name = (x: number, as: string) => (x < 0 ? `Short${as}` : beyond ? `Lowest in the days drawn${as}` : `Free to use${as}`)
  return (
    <div className="sv-wi-result">
      <Terms label="The what-if, as a subtraction" terms={[
        { k: name(r.recordedLow.low, ', as recorded'), v: fmt.money(sum.first, true), tone: r.recordedLow.low < 0 ? 'short' : undefined, s: `Lowest on ${dayName(r.recordedLow.date)}` },
        { op: sum.op, k: 'What this takes', v: fmt.money(sum.takes, true), s: r.low.k === r.recordedLow.k ? 'At the same lowest day' : `Counted at the what-if's lowest day, ${dayName(r.low.date)}` },
        { op: '=', hero: true, k: name(r.low.low, ', if this happens'), v: <Paise paise={sum.last} />, tone: r.low.low < 0 ? 'short' : undefined, s: r.firstShort ? `Something due could not be paid from ${dayName(r.firstShort.date)}` : `Lowest on ${dayName(r.low.date)}. A what-if: nothing in your account changes` },
      ]} />
      {r.salary ? <p className="sv-wi-note">{r.salary.now === null
        ? `The salary due ${fmt.isoDay(r.salary.due)} is not counted on at all; as recorded, it is counted on from ${dayName(r.salary.counted)}.`
        : r.salary.now > (l.path[l.path.length - 1]?.date ?? '')
          ? `The salary due ${fmt.isoDay(r.salary.due)} is counted on only after the ${l.path.length} days drawn; as recorded, from ${dayName(r.salary.counted)}.`
          : `The salary due ${fmt.isoDay(r.salary.due)} is counted on from ${dayName(r.salary.now)}; as recorded, from ${dayName(r.salary.counted)}.`}</p> : null}
      {beyond ? <p className="sv-wi-note">The hardest day QED found, {fmt.isoDay(beyond.date)}, is after the days drawn, so these are the lowest points in the days drawn, not what is free.</p> : null}
      <p className="sv-wi-see"><a href="#flow">See it on the chart</a>, dashed over the recorded line.</p>
    </div>
  )
}

/** While the figures are worked out: the same shapes the page will have, so nothing below them moves when they arrive. */
function SaveWaiting() {
  return (
    <div className="sv-wait page-wait" aria-busy="true">
      <p className="loading-line">Working out what must stay in the bank…</p>
      <div className="sv-top"><Skel h={600} r={24} /><Skel h={600} r={24} /></div>
      <Skel h={760} r={24} />
    </div>
  )
}
