/**
 * Home: the owner's position as one instrument. What is free, what is kept for what is due and what QED may move,
 * at true scale on one bar; then the score, one line of time for the bank account's worst case, what falls due and
 * what each standing authority may do on which days. Around it: what needs the owner, what is coming, what happened,
 * where the money is, and ways to do better that QED's fixed rules (never a model) worked out on request.
 * Every figure is read from the server's own records and definitions; nothing is computed for display that the server
 * does not also enforce. Design system "Meridian" (DESIGN.md M7).
 */
import { ArrowLeftRight, ArrowUpRight, Check, ChevronRight, FilePlus2, Lightbulb } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useState } from 'react'
import { api, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { homeCurrency } from '../../shared/home-money.ts'
import { fundSummary } from '../lib/fund-stages.ts'
import type { AuthorityEnvelope, ChainComparison, Home as HomeData, Liquidity, NeedsYou, PassbookView, ProgramSummary, Proposal } from '../lib/types.ts'
import { ApprovalSheet, type PendingApproval } from '../ui/instrument.tsx'
import { dayName, runwayOf, scoreLanes } from '../ui/charts.tsx'
import { Horizon } from '../ui/horizon.tsx'
import type { Lane } from '../ui/score.tsx'
import { Btn, EmptyState, Link, Loading, MoneyBar, Problem, Seal, Swatch, useAction, useMasonry, useSession } from '../ui/kit.tsx'
import { withPasskeyIfAsked } from '../lib/stepup.ts'
import { haveTotal, oweTotal } from '../lib/sheet.ts'
import { ReserveBasis } from '../ui/reserve.tsx'
import { ChainClosing } from '../ui/chain-closing.tsx'
const ByCurrency = lazy(() => import('./Abroad.tsx').then((m) => ({ default: m.ByCurrency })))

const MINUS = '−'
/** A rupee sum with the paise set smaller: the figure a person reads first, then the exact remainder. */
/** The worst case the server models, in the owner's own assumptions (server/liquidity.ts): income late or lost, every
    bill and instalment on its day, everyday spending at the owner's figure. Save says the same in the same words. */
const worstOf = (a: { lateDays: number; lostSalaries: number }): string =>
  `Income ${a.lateDays > 0 ? `up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : 'on its day'}${a.lostSalaries > 0 ? `, ${a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} lost` : ''}, every bill and instalment on its day, everyday spending at your figure.`

export function Rupees({ paise }: { paise: number }) {
  const s = fmt.money(paise, true)
  const dot = s.lastIndexOf('.')
  return dot < 0 ? <>{s}</> : <>{s.slice(0, dot)}<span className="paise">{s.slice(dot)}</span></>
}
const out = (paise: number): string => `${MINUS}${fmt.money(Math.abs(paise), true)}`
const inn = (paise: number): string => `+${fmt.money(Math.abs(paise), true)}`

const longDay = (now: number): string => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(now)
/** "Today", "Tomorrow", or "Tue 24 Nov": how a person says a near date. */
function nearDay(ms: number, now: number): string {
  const d = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(t)
  if (d(ms) === d(now)) return 'Today'
  if (d(ms) === d(now + 86_400_000)) return 'Tomorrow'
  if (d(ms) === d(now - 86_400_000)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(ms)
}
const nearDayIn = (ms: number, now: number): string => { const d = nearDay(ms, now); return d === 'Today' || d === 'Tomorrow' || d === 'Yesterday' ? d.toLowerCase() : `on ${d}` }
const clock = (ms: number): string => fmt.time(ms)
/** A run's day as a person says it: "Wed 25 Nov". */
const dayShort = (iso: string): string => dayName(iso)


/** The vault's figures that belong in the owner's position (raw token units as strings). */
interface VaultBrief { setUp: boolean; available: boolean; workspace?: { reserveAsset: { decimals: number } } | null; state: { provisioned: boolean; treasury: { balance: string; ringFenced: string; free: string; paused: boolean }; ownerHolds?: { asset: string }; reserve: { balance: string }; mandate: { status: string; usage: { perPayment: { limit: string }; lifetime: { limit: string; remaining: string }; validity: { validUntil: number } } } | null; policy: { status: string; targetFree: string } | null } | null }


/** A run's approval document, as signed: what it will do, each action, the limits used and left, the bank before and after. */
interface RunDoc { program: string; willDo: string[]; note: string; lines?: { to: string; amount: string; asset: string; route: string; once: string; nav?: string }[]; limits?: { label: string; value: string }[]; bank?: { now: string; after: string } }

export function HomeScreen() {
  const now = useNow(30_000)
  const { session } = useSession()
  const home = useData<HomeData>('/api/home', ['action', 'run', 'program', 'notice', 'bill', 'stop', 'profile', 'recon', 'earn', 'nav'])
  const book = useData<PassbookView>('/api/passbook?limit=6', ['action', 'run', 'bill', 'program', 'profile'])
  const liq = useData<{ liquidity: Liquidity; envelope: AuthorityEnvelope }>('/api/liquidity', ['action', 'run', 'program', 'bill', 'profile'])
  const vault = useData<VaultBrief>('/api/vault', ['vault'])
  const [approval, setApproval] = useState<(PendingApproval & { item: NeedsYou; doc: RunDoc }) | null>(null)
  const ask = useAction(async (item: NeedsYou) => {
    const a = await api<PendingApproval & { document: string }>('POST', `/api/runs/${item.runId}/approval`)
    setApproval({ ...a, item, doc: JSON.parse(a.document) as RunDoc })
  })
  const decline = useAction(async (item: NeedsYou) => { await withPasskeyIfAsked(() => api('POST', `/api/runs/${item.runId}/cancel`), session.hasPasskey); home.reload() })
  // Acknowledging changes nothing but the notice: it says the person has read it (server/notify.ts).
  const ackN = useAction(async (id: string) => { await withPasskeyIfAsked(() => api('POST', `/api/notices/${id}/ack`), session.hasPasskey); home.reload() })
  const board = useMasonry()

  if (!home.data) return home.error ? <Problem error={home.error} /> : <HomeSkeleton />
  const h = home.data, o = h.overview, lq = o.liquidity
  const free = lq.short > 0 ? 0 : lq.free
  const kept = Math.min(o.bankAvailable, lq.need)
  const held = o.bankHeld
  const active = h.programs.filter((p) => p.state === 'active' || p.state === 'paused')
  // the fund orders whose money "With the fund house" holds: purchases sent, and redemptions redeemed and not yet paid
  // (a redemption still with the registrar is units, counted in Investments until it is redeemed)
  const funds = h.inFlight.filter((a) => a.instrument?.kind === 'mutual_fund' && a.state !== 'planned' && a.state !== 'awaiting_approval' && (a.params.side !== 'sell' || typeof a.result.allottedAt === 'number'))
  const notices = h.notices.filter((n) => n.level === 'action' && !['run-approval', 'run-notice', 'bill-waiting', 'milestone-disputed'].includes(n.kind))
  const expected = book.data?.expected ?? []
  const allComing = expected.filter((e) => e.dueAt <= now + 14 * 86_400_000)
  const coming = allComing.slice(0, 6)
  const v = vault.data?.setUp && vault.data.state?.provisioned ? vault.data.state : null
  const walletGrantCount = (v?.mandate?.status === 'active' ? 1 : 0) + (v?.policy?.status === 'active' ? 1 : 0)
  const month = liq.data?.envelope.windows.find((w) => w.days === 30)?.most ?? null
  const stopped = !!h.stop
  // while QED is paused it starts nothing on its own, so it may move nothing (R12 task comparison, gap 15); what it may
  // move once resumed is said beside
  const signed = month !== null && active.length ? month : 0
  const may = stopped ? 0 : signed
  const { basis } = runwayOf(lq, expected)

  // one row of the score for every standing authority (charts.tsx scoreLanes, shared with Save)
  const lanes: Lane[] = scoreLanes({ programs: h.programs, expected, today: lq.today, stopped, protectiveContinues: !!h.stop?.protectiveContinues, worst: o.worst,
    wallet: v ? { mandate: v.mandate ?? null, policy: v.policy ?? null, reserveDecimals: vault.data?.workspace?.reserveAsset.decimals ?? 6 } : null })

  const first = (session.user?.displayName ?? '').split(/\s+/)[0] ?? ''
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(now))
  const greet = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  // who paused it, when it was not the person (a saved code, a recovery contact), and whether protective selling runs (review M4, M5)
  const byOther = h.stop?.reason && !/^(Paused|Stopped) by you$/.test(h.stop.reason) ? ` ${h.stop.reason}.` : ''
  const working = stopped ? (h.stop?.protectiveContinues ? `QED is paused, except selling to protect you: it starts nothing else on its own until you resume it.${byOther}` : `QED is paused: it does nothing on its own until you resume it.${byOther}`) : active.length || walletGrantCount ? `QED is working under ${[active.length ? `${active.length} instruction${active.length === 1 ? '' : 's'} you signed` : '', walletGrantCount ? `${walletGrantCount} grant${walletGrantCount === 1 ? '' : 's'} on your on-chain wallet` : ''].filter(Boolean).join(' and ')}.` : 'QED does nothing on its own until you sign an instruction.'
  const needsCount = h.needsYou.length + notices.length
  const showSetup = !setupDone(session.hasPasskey, vault.data, active.length, h.needsYou)

  return (
    <div className="home">
      {/* the greeting and the day's standing side by side, on the board's two columns: the space beside the greeting
          holds what QED is doing today and the three things the owner can do (R12) */}
      <header className="page-head hm-head">
        <h1>{greet}{first ? `, ${first}` : ''}.<span className="dim"> Here is your money.</span></h1>
        <div className="hm-now">
          <p><span className="hm-when">{longDay(now)}, {clock(now)}.</span> {working}</p>
          <nav className="hm-acts" aria-label="Do something yourself">
            <Link to="/pay" className="btn fill"><ArrowUpRight aria-hidden="true" />Pay someone</Link>
            <Link to="/holdings#ticket" className="btn"><ArrowLeftRight aria-hidden="true" />Buy or sell</Link>
            <Link to="/instructions/new" className="btn"><FilePlus2 aria-hidden="true" />New instruction</Link>
          </nav>
        </div>
      </header>

      <div className="hm-grid board" ref={board}>
        <section data-col="1" className="panel hm-position" aria-labelledby="pos-h">
          <div className="hm-pos-head">
            <h2 id="pos-h">{lq.short > 0 ? 'Short for what is due' : 'Free to use'}</h2>
            <span className="small faint">Paper money, as of {clock(o.asOf)}</span>
          </div>
          <p className={`hm-hero ${lq.short > 0 ? 'short' : ''}`} data-resolve=""><Rupees paise={lq.short > 0 ? lq.short : free} /></p>
          <p className="hm-hero-sub">{lq.short > 0 ? `If the worst you allow for happens, your bank cannot cover everything due${lq.binding ? ` by ${fmt.isoDay(lq.binding.date)}` : ''}. Nothing has failed yet.` : 'Yours to spend, move or invest today, after everything kept for what falls due.'}</p>
          <PositionBar free={free} kept={kept} held={held} short={lq.short} may={may} bank={o.bank} />
          <div className="hm-tiles">
            <div className="tile"><p className="k"><Swatch tone="kept" />Kept for what is due</p><p className="v" data-reserve="kept">{fmt.money(kept, true)}</p><p className="s">Protected: {lq.binding ? `bills, instalments and spending to ${fmt.isoDay(lq.binding.date)}; no instruction may spend it` : 'nothing falls due in the period'}</p></div>
            <div className="tile"><p className="k"><Swatch tone="held" />Committed</p><p className="v">{fmt.money(held, true)}</p><p className="s">{held ? 'Held for orders on their way and payments on hold; it leaves when they go' : 'No order or payment is on its way'}{v && v.treasury.ringFenced !== '0' ? `. On the chain, ${fmt.money(Number(v.treasury.ringFenced), true)} test rupees are set aside for promised payments` : ''}</p></div>
            <div className="tile qed"><p className="k"><Swatch tone="reach" />QED may move</p><p className="v">{fmt.money(may)}</p><p className="s">{stopped ? `Nothing while QED is paused${signed ? `; at most ${fmt.money(signed)} in 30 days once you resume it` : ''}` : may ? 'At most in 30 days, every instruction together, only from what is free' : 'Nothing until you sign an instruction'}</p></div>
          </div>
          <ReserveBasis l={lq} />
        </section>

        <section data-col="2" className={`panel hm-needs ${needsCount ? 'has' : 'calm'}`} aria-labelledby="att-h">
          <div className="panel-head"><h2 id="att-h">{needsCount ? 'Needs you' : showSetup ? 'Finish setting up' : 'Nothing needs you'}</h2>{needsCount ? <span className="count" aria-label={`${needsCount} item${needsCount === 1 ? '' : 's'}`}>{needsCount}</span> : null}</div>
          <div className="hm-needs-list">
            {h.needsYou.map((n) => {
              const soon = !!n.deadline && n.deadline - now < 2 * 86_400_000
              return (
                <article key={`${n.type}-${n.runId ?? n.billId ?? n.milestoneId ?? n.programId}`} className={`need ${soon ? 'urgent' : ''}`}>
                  <div className="need-body">
                    <h3>{n.title}</h3>
                    {n.detail ? <Clamped text={n.detail} /> : null}
                    <p className="need-when">{n.deadline ? <b>{n.type === 'object-run' ? 'Goes ahead' : n.type === 'approve-run' ? 'Lapses' : 'Due'} {nearDayIn(n.deadline, now)} at {clock(n.deadline)}. </b> : null}{n.ifNothing}</p>
                  </div>
                  <div className="need-acts">
                    {n.type === 'approve-run' ? <><Btn small tone="fill" busy={ask.busy} onClick={() => void ask.run(n)}>Review and approve</Btn><Btn small busy={decline.busy} onClick={() => void decline.run(n)}>Decline this run</Btn></> : null}
                    {n.type === 'object-run' ? <Btn small busy={decline.busy} onClick={() => void decline.run(n)}>Object: do not run it</Btn> : null}
                    {n.type === 'pay-bill' ? <Link className="btn sm fill" to={`/pay?bill=${n.billId}#pay-review`}>Pay this bill</Link> : null}
                    {n.type.startsWith('milestone-') ? <Link className="btn sm" to={`/earn#ms-${n.milestoneId}`}>Open the milestone</Link> : null}
                    {n.type === 'account-safety' ? <Link className="btn sm fill" to="/security">Add a passkey or a recovery contact</Link> : null}
                    {n.type === 'goal-behind' ? <Link className="btn sm fill" to={`/save#goal-${n.programId}`}>See how to catch up</Link> : null}
                    {n.programId ? <Link className="btn sm quiet" to={`/instructions/${n.programId}`}>The instruction</Link> : null}
                  </div>
                </article>
              )
            })}
            {notices.map((n) => <article key={n.id} className={`need ${n.kind === 'security-change' || n.kind === 'escalation' ? 'urgent' : ''}`}><div className="need-body"><h3>{n.title}</h3><Clamped text={n.body} /></div><div className="need-acts">
              {n.kind === 'security-change' || n.kind === 'escalation' ? <><Btn small tone="fill" busy={ackN.busy} onClick={() => void ackN.run(n.id)}>Acknowledge</Btn><Link className="btn sm quiet" to="/security">Security and recovery</Link></> : null}
              {n.subject?.startsWith('act_') ? <Link className="btn sm quiet" to={`/record/${n.subject}`}>See what happened</Link> : null}
              {n.kind === 'vault-job-reorged' && n.subject ? <><Btn small tone="fill" busy={ackN.busy} onClick={() => void ackN.run(n.id)}>Acknowledge</Btn><Link className="btn sm quiet" to={`/vault/job/${n.subject}`}>See the operation</Link></> : null}
              {n.kind === 'chain-books-disagree' && /different chain/.test(n.body) ? <ChainClosing /> : null}
            </div></article>)}
            {!needsCount && !showSetup ? <div className="hm-calm"><Seal size="xl" /><p>Every bill due soon is covered or has an instruction, and nothing is waiting for your approval. QED tells you here, and in Notifications, the moment something does.</p></div> : null}
            <SetupSteps hasPasskey={!!session.hasPasskey} wallet={vault.data ? !!vault.data.setUp : null} instructions={active.length} secondWay={!h.needsYou.some((n) => n.type === 'account-safety')} />
          </div>
          <Problem error={ask.error ?? decline.error ?? ackN.error} />
        </section>

        <section data-col="1" className="panel hm-horizon" aria-labelledby="hz-h">
          <Horizon path={lq.path} start={lq.available} free={free} short={lq.short} lowDate={lq.binding?.date ?? null} basis={basis}
            title={<h2 id="hz-h">Your bank balance, at worst</h2>}
            sub={`${worstOf(lq.assumptions)} The steps are the days money moves.`}
            foot={<Link to="/save">How what is kept is worked out<ChevronRight aria-hidden="true" /></Link>} />
        </section>

        <section data-col="2" className="panel hm-authority" aria-labelledby="auth-h">
          <div className="panel-head"><h2 id="auth-h">What QED may do</h2><Link to="/protect" className="small">Review all</Link></div>
          {/* R14 L6: what this is, why it is empty, the one next step */}
          {lanes.length === 0 ? <EmptyState compact icon={<FilePlus2 />} title="Nothing yet" action={<Link to="/instructions/new" className="btn">Write an instruction</Link>}>QED does nothing on its own until you sign an instruction. Each one you sign appears here with its limit and what is left of it.</EmptyState> : (
            <ul className="hm-lanes">{lanes.slice(0, 6).map((l) => {
              const next = l.runs[0]
              return (
                <li key={l.id}>
                  <div className="ln-top"><Link to={l.to} className="ln-t">{l.title}</Link><span className={`ln-mode m-${l.mode}`}>{l.modeText}</span></div>
                  {l.left ? <><div className="meter" role="meter" aria-label={`${l.title}: ${fmt.money(l.left.left, true)} left of ${fmt.money(l.left.of, true)} ${l.left.per}`} aria-valuemin={0} aria-valuemax={l.left.of} aria-valuenow={l.left.left}><i style={{ width: `${Math.max(0, Math.min(100, (l.left.left / Math.max(1, l.left.of)) * 100))}%` }} /></div>
                    <p className="ln-s"><b>{fmt.money(l.left.left, true)}</b> left of {fmt.money(l.left.of, true)} {l.left.per}{next ? `; next ${dayShort(next)}` : ''}{l.waiting?.length ? `; ${l.waiting.length} waiting for you` : ''}</p></>
                    : <p className="ln-s">{l.note ?? (l.continuous ? 'Watches continuously' : next ? `Next ${dayShort(next)}` : 'No run in the coming weeks')}</p>}
                </li>
              )
            })}</ul>
          )}
          {lanes.length > 6 ? <p className="small hm-more-line"><Link to="/protect">{lanes.length - 6} more</Link></p> : null}
        </section>

        <section data-col="1" className="panel hm-daybook" aria-labelledby="day-h">
          <div className="panel-head"><h2 id="day-h">Coming up and what happened</h2><p>Your bank account</p></div>
          <h3 className="hm-col-h" id="up-h">Coming up, next two weeks</h3>
          {coming.length === 0 ? <p className="small muted hm-empty-line">Nothing is due in the next two weeks.</p> : (
            <ul className="hm-days" aria-labelledby="up-h">
              {coming.map((e, i) => (
                <li key={i}>
                  <span className="when">{nearDay(e.dueAt, now)}</span>
                  <span className="what">{e.kind === 'program' && e.subject ? <Link to={`/instructions/${e.subject}`}>{e.label}</Link> : e.kind === 'bill' && e.subject ? <Link to={`/pay?bill=${e.subject}#pay-review`}>{e.label}</Link> : e.label}
                    <small className={`why ${e.unpaid ? 'due' : ''}`}>{e.kind === 'bill' ? (e.unpaid ? 'Over the cap: nobody pays it unless you do' : e.by ? (e.by.runMode === 'approve' ? `QED asks you first, under “${e.by.title}”` : `QED pays it under “${e.by.title}”`) : 'Nobody pays it unless you do') : e.kind === 'program' ? (stopped ? 'Paused: it will not run until you resume QED' : e.runMode === 'approve' ? 'Asks you first: nothing moves unless you approve' : e.runMode === 'notify' ? 'QED, after telling you in advance' : 'QED, under your instruction') : e.kind === 'income' ? 'Expected; the amount is an estimate' : e.kind === 'emi' ? 'Your bank takes it' : ''}</small></span>
                  <span className={`amt ${e.amount > 0 ? 'in' : ''}`}>{e.amount > 0 ? inn(e.amount) : out(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          {allComing.length > coming.length ? <p className="small hm-more-line"><span className="muted">{allComing.length - coming.length} more in the next two weeks.</span> <Link to="/passbook">See them all</Link></p> : null}
          <p className="hm-today" aria-hidden="true"><span>Today</span></p>
          <h3 className="hm-col-h" id="rec-h">What happened, newest first</h3>
          {(book.data?.lines ?? []).length === 0 ? <p className="small muted hm-empty-line">Nothing has happened yet.</p> : (
            <ul className="hm-days" aria-labelledby="rec-h">{(book.data?.lines ?? []).slice(0, 6).map((l) => {
              const memo = l.memo.replace(/\bBTC\b/g, 'bitcoin').replace(/\bETH\b/g, 'ether').replace(/\bUSDT\b/g, 'tether')
              const head = memo.includes(' at ') ? memo.slice(0, memo.indexOf(' at ')) : memo
              const whoText = l.actor === 'you' ? 'By you' : l.actor === 'qed' ? 'By QED' : l.actor === 'bank' ? 'Your bank' : l.actor === 'employer' ? 'Your employer' : l.actor === 'client' ? 'Your client' : l.actor
              return (
                <li key={l.seq}>
                  <span className="when">{nearDay(l.effectiveTs, now)}<small>{clock(l.effectiveTs)}</small></span>
                  <span className="what">{l.actionId ? <Link to={`/record/${l.actionId}`}>{head}</Link> : head}
                    <small className="why"><span className={l.actor === 'qed' ? 'by-qed' : 'by-who'}>{whoText}</span>{l.programTitle ? ` under “${l.programTitle}”` : ''}{l.receiptId ? <> <Seal label="Receipt kept" /></> : null}</small></span>
                  <span className={`amt ${l.amount > 0 ? 'in' : ''}`}>{l.amount > 0 ? inn(l.amount) : out(l.amount)}<small>{fmt.money(l.balance, true)} after</small></span>
                </li>
              )
            })}</ul>
          )}
          <div className="panel-foot"><Link to="/activity">All activity, with the checks behind each</Link>{!h.receipts.ok ? <span className="small void">Receipt chain broken at {h.receipts.brokenAt}</span>
            /* an empty chain is not "intact": nothing has been checked yet (R13: no reassuring mark without evidence) */
            : h.receipts.count === 0 ? <span className="small muted">No receipts yet</span>
            : <span className="sealed"><Seal />{h.receipts.count === 1 ? '1 receipt' : `${h.receipts.count} receipts`}, chain intact</span>}</div>
        </section>

        <section data-col="2" className="panel hm-sheet" aria-labelledby="where-h">
          <div className="panel-head"><h2 id="where-h">Where your money is</h2></div>
          <p className="hm-net"><span>Net position</span><b>{o.netWorth < 0 ? out(o.netWorth) : fmt.money(o.netWorth, true)}</b><small>What you have less what you owe. A home is not counted, only its loan; the test money on the chain is left out.</small></p>
          <h3 className="hm-col-h" id="have-h">What you have</h3>
          <ul className="hm-book" aria-labelledby="have-h">
            <SheetRow name={<Link to="/activity">Bank account</Link>} what={`Paper money for practice, as of ${clock(o.asOf)}`} value={fmt.money(o.bank, true)} />
            {o.holdingsValue > 0 || o.holdings.length ? <SheetRow name={<Link to="/holdings">Investments</Link>} what={`${o.holdings.length} holding${o.holdings.length === 1 ? '' : 's'} at live prices; the value moves with the market`} value={fmt.money(o.holdingsValue, true)} /> : null}
            {/* each fund order's own state, with its day: with the registrar, money received, redeemed (R12 task comparison, T4-d) */}
            {o.inTransit > 0 ? <SheetRow name={<Link to={funds.length === 1 ? `/record/${funds[0]!.id}` : '/holdings#funds-waiting'}>With the fund house</Link>} what={funds.length ? fundSummary(funds, now) : 'Money for fund units not yet allotted, or from units redeemed and not yet paid'} value={fmt.money(o.inTransit, true)} /> : null}
            {o.deposits > 0 ? <SheetRow name="Fixed deposit" what="Paper" value={fmt.money(o.deposits, true)} /> : null}
            {o.paymentsInProgress > 0 ? <SheetRow name={<Link to="/activity">Payments in progress</Link>} what="Sent from your paper bank and not yet delivered; returned to the bank if the payment fails" value={fmt.money(o.paymentsInProgress, true)} /> : null}
            {o.taxCredit > 0 ? <SheetRow name="Tax already deducted" what="Deducted at source on sales of digital assets: a credit against your tax, counted here as yours" value={fmt.money(o.taxCredit, true)} /> : null}
            {o.setAside > 0 ? <SheetRow name={<Link to="/save#goals">Set aside for goals</Link>} what="In your own paper bank, kept out of what is free; only you can release it" value={fmt.money(o.setAside, true)} /> : null}
            {v ? <SheetRow name={<Link to="/vault">On-chain wallet</Link>} what={`Test rupees on a chain on this QED installation; no value.${v.treasury.ringFenced !== '0' ? ` ${fmt.money(Number(v.treasury.ringFenced), true)} set aside for promised payments.` : ''}${v.treasury.paused ? ' Paused.' : ''}${v.reserve.balance !== '0' ? ` Also $${(Number(v.reserve.balance) / 1e6).toFixed(2)} in test dollars.` : ''}${booksWords(h.chainBooks?.comparison ?? null, now)}`} value={fmt.money(Number(v.treasury.balance), true)} test />
              : vault.data && !vault.data.setUp ? <SheetRow name={<Link to="/vault">On-chain wallet</Link>} what="Not set up: a wallet on a local test chain, owned by your passkey" value="Set up" quiet /> : null}
            {v && (v.ownerHolds?.asset ?? '0') !== '0' ? <SheetRow name={<Link to="/vault">Wallet's own account</Link>} what="Outside the vault on the same chain: refunds and withdrawals land here" value={fmt.money(Number(v.ownerHolds?.asset ?? 0), true)} test /> : null}
          </ul>
          <p className="hm-total"><span>Paper money and investments</span><b>{fmt.money(haveTotal(o), true)}</b></p>
          <h3 className="hm-col-h" id="owe-h">What you owe</h3>
          <ul className="hm-book" aria-labelledby="owe-h">
            {o.card > 0 ? <SheetRow name="Credit card" what="The paper bank asks for no minimum payment" value={out(o.card)} /> : null}
            {o.loans > 0 ? <SheetRow name="Loans" what="Home and personal, paid by instalment" value={out(o.loans)} /> : null}
            {o.card <= 0 && o.loans <= 0 ? <SheetRow name="Nothing owed" what="No card balance or loan recorded" value="" quiet /> : null}
          </ul>
          <p className="hm-total"><span>Owed</span><b>{out(oweTotal(o))}</b></p>
        </section>
        {/* R13: holdings by currency, with a total in rupees that names each rate and when it was observed (Abroad.tsx) */}
        {homeCurrency() === 'INR' ? (
        <Suspense fallback={null}><ByCurrency variant="home" /></Suspense>
        ) : null}

        <Better />
      </div>

      <ApprovalSheet approval={approval} title="Approve this run" action="Approve this run" onClose={() => setApproval(null)} onApproved={async () => { setApproval(null); home.reload() }}>
        {approval ? (
          <article className="instrument"><div className="i-head"><span>One run of “{approval.doc.program}”</span><span>Not approved yet</span></div>
            <div className="i-body">{approval.doc.willDo.map((w, i) => <p className="i-pay" key={i}>{w}.</p>)}
              {/* each action's recipient, amount, asset, route and what follows, as signed (R12 section 4) */}
              {(approval.doc.lines ?? []).map((l, i) => (
                <dl className="doc-lines" key={i} aria-label={`Action ${i + 1}`}>
                  <div><dt>To</dt><dd><strong>{l.to}</strong></dd></div>
                  {l.amount ? <div><dt>Amount</dt><dd><strong>{l.amount}</strong></dd></div> : null}
                  {l.asset ? <div><dt>Asset</dt><dd>{l.asset}</dd></div> : null}
                  <div><dt>Route</dt><dd>{l.route}</dd></div>
                  {l.nav ? <div><dt>Executes at</dt><dd>The NAV for {l.nav}</dd></div> : null}
                  <div><dt>Once approved</dt><dd>{l.once}</dd></div>
                </dl>
              ))}
              {/* the limits the record shows afterwards, and the bank before and after, as signed (R12 task comparison, gap 6) */}
              {approval.doc.limits?.length ? <dl className="doc-lines" aria-label="Limits">{approval.doc.limits.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}</dl> : null}
              {approval.doc.bank ? <dl className="doc-lines" aria-label="Your bank account"><div><dt>Your bank now</dt><dd>{approval.doc.bank.now}</dd></div><div><dt>After this run</dt><dd><strong>{approval.doc.bank.after}</strong></dd></div></dl> : null}
              <p className="small muted" style={{ marginTop: 10 }}>{approval.doc.note}</p></div></article>
        ) : null}
      </ApprovalSheet>
    </div>
  )
}

/**
 * Free, kept and held at true scale on the money bar (kit.tsx, DESIGN.md M14), with the span of the most QED may move
 * under the free part. Short, the bar shows what is missing as a dashed hollow after what the bank holds.
 */
function PositionBar({ free, kept, held, short, may, bank }: { free: number; kept: number; held: number; short: number; may: number; bank: number }) {
  const label = short > 0
    ? `${fmt.money(bank, true)} in your bank${held ? `, ${fmt.money(held, true)} of it held for orders and payments on hold` : ''}; all the rest is kept for what is due, and ${fmt.money(short, true)} more is needed. QED may move nothing from the bank until that is covered.`
    : `${fmt.money(free, true)} free, ${fmt.money(kept, true)} kept${held ? `, ${fmt.money(held, true)} held for orders and payments on hold` : ''}: ${fmt.money(bank, true)} in your bank. ${may ? `QED may move at most ${fmt.money(may)} in 30 days, from the free part only.` : 'QED may move none of it until you sign an instruction.'}`
  return (
    <div className="hm-bar-wrap">
      <MoneyBar label={label} parts={[{ tone: 'free', value: free, reach: may }, { tone: 'kept', value: kept }, { tone: 'held', value: held }, { tone: 'short', value: short }]} />
      <p className="hm-sum" aria-hidden="true">{short > 0
        ? <><Swatch tone="kept" /><b>{fmt.money(kept, true)}</b> kept{held ? <> + <Swatch tone="held" /><b>{fmt.money(held, true)}</b> held</> : null} = <b>{fmt.money(bank, true)}</b> in your bank, and <Swatch tone="short" /><b className="short">{fmt.money(short, true)}</b> more is needed for what is due.</>
        : <><Swatch tone="free" /><b>{fmt.money(free, true)}</b> free + <Swatch tone="kept" /><b>{fmt.money(kept, true)}</b> kept{held ? <> + <Swatch tone="held" /><b>{fmt.money(held, true)}</b> held</> : null} = <b>{fmt.money(bank, true)}</b> in your bank.</>}</p>
    </div>
  )
}

/** What the books say of the on-chain wallet, in one clause: agreeing with the chain, disagreeing, or not compared (server/chain-books.ts). */
function booksWords(c: ChainComparison | null, now: number): string {
  if (!c) return ''
  return c.state === 'agrees' ? ` Your books agree with the chain, checked ${fmt.rel(c.at, now)}.` : c.state === 'disagrees' ? ' Your books and the chain disagree: see Protect.' : ' Not compared with your books lately.'
}
function SheetRow({ name, what, value, quiet, test }: { name: ReactNode; what: string; value: string; quiet?: boolean; test?: boolean }) {
  return <li className="hm-row"><span className="nw"><span className="n">{name}</span><span className="w">{what}</span></span><span className={`val ${quiet ? 'quiet' : ''}`}>{value}{test ? <small>test rupees</small> : null}</span></li>
}

/** A long explanation shows its first lines; the rest is one press away and always in the page for a screen reader. */
function Clamped({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > 150
  return <div className={`d ${long && !all ? 'clamped' : ''}`}><p>{text}</p>{long ? <button type="button" className="linkish more" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show less' : 'Show all of it'}</button> : null}</div>
}

const setupDone = (hasPasskey: boolean | undefined, vault: { setUp: boolean } | null, instructions: number, needs: NeedsYou[]): boolean =>
  !!hasPasskey && !needs.some((n) => n.type === 'account-safety') && (vault === null || vault.setUp) && instructions > 0

/** What is left of opening the account properly: shown until done, each step one click from where it is done. */
function SetupSteps({ hasPasskey, wallet, instructions, secondWay }: { hasPasskey: boolean; wallet: boolean | null; instructions: number; secondWay: boolean }) {
  const steps = [
    { done: hasPasskey, to: '/security', label: 'Add the passkey that approves payments' },
    { done: hasPasskey && secondWay, to: '/security#recovery', label: 'Give yourself a second way back in' },
    { done: wallet === null ? true : wallet, to: '/vault', label: 'Set up your on-chain wallet' },
    { done: instructions > 0, to: '/instructions/new', label: 'Sign your first instruction' },
  ]
  const todo = steps.filter((s) => !s.done).length
  if (todo === 0) return null
  return (
    <article className="need setup-steps" aria-labelledby="setup-h">
      <div className="need-body">
        <h3 id="setup-h">Finish setting up <span className="faint">{steps.length - todo} of {steps.length} done</span></h3>
        <ol className="hm-steps">{steps.map((s) => <li key={s.label} className={s.done ? 'done' : ''}>{s.done ? <><Check aria-hidden="true" /><span>{s.label}</span></> : <Link to={s.to}><i aria-hidden="true" /><span>{s.label}</span><ChevronRight aria-hidden="true" /></Link>}</li>)}</ol>
        <p className="small muted">Run a business too? <Link to="/workspace">Open a business workspace</Link> with its own members and signing rules.</p>
      </div>
    </article>
  )
}

/**
 * Ways to do better, worked out by QED's fixed rules from the owner's own records (never by a model), only when asked.
 * Each opens as an unsigned draft: nothing runs until it is signed.
 */
function Better() {
  const stored = useData<{ proposals: Proposal[] }>('/api/proposals')
  const work = useAction(async () => { await api('POST', '/api/proposals/suggest'); stored.reload() })
  const draft = useAction(async (id: string) => {
    const r = await api<{ drafted: { programId: string }[]; skipped: { reason: string }[] }>('POST', '/api/proposals/drafts', { ids: [id] })
    if (r.drafted[0]) navigate(`/instructions/${r.drafted[0].programId}`); else stored.reload()
  })
  const list = (stored.data?.proposals ?? []).filter((p) => p.origin === 'rules' && p.state === 'new').slice(0, 3)
  return (
    <section data-col="auto" className="panel hm-better" aria-labelledby="better-h">
      <div className="panel-head"><h2 id="better-h">Ways to do better</h2><p>Worked out by fixed rules from your records, not by a model</p></div>
      {list.length ? (
        <ul className="hm-better-list">{list.map((p) => (
          <li key={p.id}>
            <span className="glyph" aria-hidden="true"><Lightbulb /></span>
            <div><h3>{p.title}</h3><Clamped text={p.rationale} />{p.analysis?.headline ? <p className="small muted">{p.analysis.headline}</p> : null}</div>
            <Btn small busy={draft.busy} onClick={() => void draft.run(p.id)}>Open as a draft</Btn>
          </li>
        ))}</ul>
      ) : <p className="small muted hm-better-none">{stored.data ? 'None on file.' : ''} QED can look for a cheaper way to carry your debts, idle cash, an unwatched floor and unpaid bills. It reads only your records and does arithmetic; each suggestion says why.</p>}
      <div className="panel-foot"><Btn small busy={work.busy} onClick={() => void work.run()}>{list.length ? 'Work them out again' : 'Look for ways to do better'}</Btn><span className="small muted">A suggestion opens as a draft; nothing runs until you sign it.</span></div>
      <Problem error={work.error ?? draft.error} />
    </section>
  )
}

function HomeSkeleton() {
  return (
    <div className="home" aria-busy="true">
      <Loading what="Opening your money" />
      <div className="skel" style={{ height: 520, borderRadius: 16, marginTop: 24 }} />
    </div>
  )
}
