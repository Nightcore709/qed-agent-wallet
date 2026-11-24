/**
 * Instructions: what QED may do (DESIGN.md "Meridian"). Each instruction is a rule the owner set and signed; QED's server
 * checks every run against it (no model decides); on the bank account nothing outside QED enforces it. The page says so
 * with the same marks as Protect (ui/kinds.tsx).
 *
 * The list opens on what QED may move, all instructions together, beside how many are in force, unsigned and waiting
 * for the owner; then one row per instruction on shared columns: what it does, how it acts (on its own, tells you first,
 * asks you each time; the colours and words of Home's "What QED may do"), what is left of its limit (the lit part is
 * what it may still move), its next run and its state. Drafts follow (they can do nothing until signed), then the ended
 * ones; then every kind QED can follow. An instruction's own page: what it may still do, who enforces it, its coming
 * runs on their days, its signed document, what follows from it, what it has done and its history, in two independent
 * columns ordered by importance. `statusLine` and `Consequences` are shared with Safeguards, Earn and Compose.
 */
import { RevocationOf } from '../ui/revocation.tsx'
import { ChevronRight, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { api, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { ApprovalSheet, Bound, InstrumentDoc, type PendingApproval } from '../ui/instrument.tsx'
import { KindTag } from '../ui/kinds.tsx'
import { Basis, Btn, Crumb, Link, Loading, Note, Problem, Sheet, StateStamp, stateWord, useAction, useMasonry, useSession, needsAttention, NEEDS_ATTENTION } from '../ui/kit.tsx'
import type { Analysis, Authority, AuthorityEnvelope, ProgramDetail, ProgramSummary, RunCalendar, RunView } from '../lib/types.ts'
import type { AuthDoc } from '../ui/instrument.tsx'
import { heldByPause, statusLine } from '../lib/words.ts'
import { MODE_WORD, monthLeft, resumeInstruction, sellsOnly, withPasskeyIfAsked } from './Protect.tsx'
import { GoalCard } from '../ui/goal.tsx'

const PURPOSES: [string, string, string][] = [['spend', 'Spending', 'Paying people and bills'], ['save', 'Saving and debt', 'Idle cash, deposits and what you owe'], ['grow', 'Growing', 'Investing regularly and keeping a mix'], ['earn', 'Earning', 'What happens when income arrives'], ['protect', 'Protecting', 'Selling risk when it matters']]

// one definition, in lib/words.ts, so Safeguards (and through it Save, Grow and the Statement) need not download this
// screen and Protect with it (R12 perf); re-exported here for this screen's other callers
export { statusLine }

/** The signed limit as one sentence: the most it may ever move, and until when; or that it only sells. */
const ceilingOf = (p: ProgramSummary): string => (p.ceiling !== null && p.authority ? `Not over ${fmt.money(p.ceiling)} before ${fmt.dayYear(p.authority.expiresAt)}` : p.authority ? `Sells only. Ends ${fmt.dayYear(p.authority.expiresAt)}` : '')
const countsOf = (p: ProgramSummary): string => [p.counts.done ? `${p.counts.done} run${p.counts.done === 1 ? '' : 's'} completed` : 'No runs yet', p.counts.missed ? `${p.counts.missed} missed` : '', p.counts.refused ? `${p.counts.refused} refused` : '', p.counts.waiting ? `${p.counts.waiting} waiting for you` : ''].filter(Boolean).join(', ')
const noticeOf = (sec: number): string => (sec >= 3600 ? `${Math.round(sec / 3600)} hour${Math.round(sec / 3600) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(sec / 60))} minute${Math.round(sec / 60) === 1 ? '' : 's'}`)
/** How it acts, in the words of Home's score: on its own, after telling you, after asking you; or only to protect. */
const modeOf = (p: ProgramSummary | { kind: string; state: string; authority: Authority | null }): { key: string; text: string; sub?: string } => {
  const a = p.authority
  if (sellsOnly(p.kind)) return { key: 'watch', text: 'Sells only, to protect you' }
  const text = MODE_WORD[a?.runMode ?? ''] ?? ''
  return { key: p.state === 'paused' ? 'paused' : a?.runMode ?? 'auto', text, ...(a?.runMode === 'notify' && a.noticeSec ? { sub: `${noticeOf(a.noticeSec)} before each run; you can object` } : a?.runMode === 'approve' ? { sub: 'Nothing moves until you approve the run' } : {}) }
}
/** When it next acts, in two short lines. */
function nextOf(p: ProgramSummary, now: number, stop?: Parameters<typeof heldByPause>[1]): { text: string; sub?: string; wait?: boolean } {
  if (p.state === 'draft') return { text: 'Not until you sign it' }
  if (p.state === 'paused') return { text: 'None while paused', ...(p.pausedReason ? { sub: p.pausedReason } : {}) }
  if (p.state !== 'active') return { text: 'It can no longer act' }
  if (heldByPause(p.kind, stop)) return { text: 'None while QED is paused', sub: 'Until you resume it' }
  if (p.watching) return { text: 'Not being evaluated', sub: `Since ${fmt.dayTime(p.watching.since)}: ${p.watching.why}`, wait: true }
  if (p.nextDueAt) return { text: fmt.dayTime(p.nextDueAt), sub: fmt.rel(p.nextDueAt, now) }
  const checked = p.lastChecked ? { sub: `Last checked ${fmt.age(now - p.lastChecked)}` } : {}
  if (p.kind === 'exit') return { text: 'When the price falls to its level', ...checked }
  if (p.kind === 'floor') return { text: 'When your worst case drops below your floor', ...checked }
  if (p.kind === 'bills') return { text: 'When a bill from its payees falls due' }
  if (p.kind === 'split') return { text: 'When salary or earnings arrive' }
  return { text: 'In force' }
}

/** One instruction as one row on the list's columns: what it does, how it acts, its bound, its next run, its state. */
function Row({ p, now }: { p: ProgramSummary; now: number }) {
  const { session } = useSession()
  const l = monthLeft(p), m = modeOf(p), n = nextOf(p, now, session.stop)
  const bound: ReactNode = p.state === 'draft' ? <span className="pr-il-would">{ceilingOf(p) ? `Once signed: ${ceilingOf(p).replace(/^./, (c) => c.toLowerCase())}` : 'Can do nothing until you sign it'}</span>
    : sellsOnly(p.kind) ? <span className="pr-il-would">It never buys or pays anyone</span>
    : l && (p.state === 'active' || p.state === 'paused') ? <Bound used={p.usedThisMonth ?? 0} limit={l.of} period="this month" />
    : <span className="pr-il-would">{ceilingOf(p)}</span>
  return (
    <li className={`pr-il-row ${p.state}`}>
      <span className="pr-il-what"><Link to={`/instructions/${p.id}`}>{p.title}</Link><small>{p.state === 'draft' ? 'Drafted, not signed: it can do nothing until you sign it.' : p.state === 'active' || p.state === 'paused' ? `${ceilingOf(p)}. ${countsOf(p)}.` : `${p.counts.done} run${p.counts.done === 1 ? '' : 's'} done. Last changed ${fmt.dayTime(p.updatedAt)}.`}</small></span>
      <span className={`pr-il-mode m-${m.key}`}><span><i aria-hidden="true" />{p.state === 'draft' ? `Would be: ${m.text.toLowerCase()}` : m.text}</span>{m.sub && p.state !== 'draft' ? <small>{m.sub}</small> : null}</span>
      <span className="pr-il-bound">{bound}</span>
      <span className={`pr-il-next ${n.wait ? 'wait' : ''}`}><span>{n.text}</span>{n.sub ? <small>{n.sub}</small> : null}</span>
      <span className="pr-il-state"><StateStamp state={p.state} />{p.state === 'draft' ? <Link className="btn sm" to={`/instructions/${p.id}`}>Review and sign<span className="sr"> “{p.title}”</span></Link> : null}</span>
    </li>
  )
}

export function InstructionsScreen() {
  const now = useNow(5000)
  const { data, error } = useData<{ programs: ProgramSummary[]; kinds: { kind: string; pillar: string; label: string; blurb: string }[] }>('/api/programs', ['program', 'run'])
  const liq = useData<{ envelope: AuthorityEnvelope }>('/api/liquidity', ['action', 'run', 'program', 'bill', 'profile'])
  const head = (
    <header className="page-head">
      <div>
        <h1>Instructions</h1>
        <p>What QED may do with your paper money. Each instruction is a document you signed, with a limit and an end date, and revoking one takes effect at once. On your on-chain wallet, what QED may do is its mandate and its standing policy, <Link to="/protect">under Protect</Link>.</p>
      </div>
      <Link className="btn fill" to="/instructions/new"><Plus aria-hidden="true" />Write a new instruction</Link>
    </header>
  )
  if (!data) return <div className="pr pr-il">{head}{error ? <Problem error={error} /> : <section className="panel pr-il-skel" aria-busy="true"><Loading what="Reading your instructions" />{[0, 1, 2].map((i) => <span key={i} className="skel" />)}</section>}</div>
  const signed = [...data.programs.filter((p) => p.state === 'active'), ...data.programs.filter((p) => p.state === 'paused')]
  const drafts = data.programs.filter((p) => p.state === 'draft')
  const ended = data.programs.filter((p) => !['active', 'paused', 'draft'].includes(p.state))
  const inUse = new Set(signed.map((p) => p.kind))
  const drafted = new Set(drafts.map((p) => p.kind))
  const active = signed.filter((p) => p.state === 'active').length
  const waiting = signed.reduce((s, p) => s + p.counts.waiting, 0)
  const month = liq.data?.envelope.windows.find((w) => w.days === 30)?.most ?? null
  return (
    <div className="pr pr-il">
      {head}
      <section className="panel pr-il-figs" aria-label="What QED may do, all together">
        <div className="pr-il-hero">
          <p className="k">QED may move</p>
          <p className="v" data-resolve="">{month === null ? (liq.error ? 'Not known' : '…') : fmt.money(active ? month : 0)}</p>
          <p className="s">{liq.error ? 'The limit across your instructions could not be read just now.' : active ? 'At most in the next 30 days, all instructions together, never from what is kept for what is due' : 'Nothing until you sign an instruction'}</p>
          <p className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></p>
        </div>
        <div className="tile"><p className="k">In force</p><p className="v">{active}</p><p className="s">{signed.length > active ? `and ${signed.length - active} paused, which start nothing new` : 'Each until it ends, or until you pause or revoke it'}</p></div>
        <div className="tile"><p className="k">Not signed</p><p className="v">{drafts.length}</p><p className="s">{drafts.length ? 'Drafts can do nothing until you sign them' : 'No draft is waiting'}</p></div>
        <div className="tile"><p className="k">Waiting for you</p><p className="v">{waiting}</p><p className="s">{waiting ? <>Runs that ask you first, <Link to="/">approved on Home</Link></> : 'No run is waiting for your approval'}</p></div>
      </section>

      <section className="panel pr-il-list" aria-label="Your instructions">
        <p className="pr-il-held">QED's server checks every run against its instruction's limits before anything is sent, and refuses one beyond them; no model decides. Nothing outside QED checks them on your bank account.</p>
        <p className="pr-il-cols" aria-hidden="true"><span>Instruction</span><span>How it acts</span><span>What is left of its limit</span><span>Next</span><span>State</span></p>
        <h2 className="pr-il-group" id="signed-h">Signed<small>{signed.length ? 'In force until it ends, or until you pause or revoke it' : ''}</small></h2>
        {signed.length ? <ul className="pr-il-rows" aria-labelledby="signed-h">{signed.map((p) => <Row key={p.id} p={p} now={now} />)}</ul> : (
          <div className="pr-il-empty">
            <p><b>Nothing is signed.</b> QED does nothing on its own until you sign an instruction: paying bills up to a cap, investing a fixed sum, keeping a buffer, selling to protect your floor.</p>
            <Link className="btn fill" to="/instructions/new">Write an instruction</Link>
          </div>
        )}
        {drafts.length ? <>
          <h2 className="pr-il-group" id="drafts-h">Not signed<small>QED can do nothing under these until you sign them</small></h2>
          <ul className="pr-il-rows" aria-labelledby="drafts-h">{drafts.map((p) => <Row key={p.id} p={p} now={now} />)}</ul>
        </> : null}
        {ended.length ? (
          <details className="pr-il-ended">
            <summary>Ended instructions ({ended.length})</summary>
            <ul className="pr-il-rows">{ended.map((p) => <Row key={p.id} p={p} now={now} />)}</ul>
          </details>
        ) : null}
      </section>

      <section className="panel pr-il-cat" aria-labelledby="could-h">
        <div className="pr-il-cat-head"><h2 id="could-h">Write another</h2><p>Every kind QED can follow. You see the exact document, its limit and what follows from it before you sign anything.</p></div>
        <ul className="pr-il-cat-rows">
          {PURPOSES.map(([key, name, about]) => {
            const kinds = data.kinds.filter((k) => k.pillar === key)
            return kinds.length ? (
              <li key={key}>
                <span className="pr-il-cat-p"><h3>{name}</h3><small>{about}</small></span>
                <span className="pr-il-cat-k">{kinds.map((k) => <Link key={k.kind} className="pr-il-kind" to={`/instructions/new?kind=${k.kind}`}><span>{k.label}</span>{inUse.has(k.kind) ? <small className="pr-il-tag">in use</small> : drafted.has(k.kind) ? <small className="pr-il-tag">a draft, not signed</small> : null}<ChevronRight aria-hidden="true" /></Link>)}</span>
              </li>
            ) : null
          })}
        </ul>
      </section>
    </div>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * The coming five weeks of a scheduled instruction as a calendar: each run on its day (a filled dot where QED acts, a
 * ring where it asks you first, as in Home's score), where a limit refuses one, and where authority ends (hatched). A
 * signed limit is a statement about time, so it is shown in time; the same facts are given in words beside it, and each
 * month's limit as a bound row: used, then what the schedule asks for, against the limit.
 */
function ComingWeeks({ cal, paused }: { cal: RunCalendar; paused: boolean }) {
  const lead = (new Date(`${cal.days[0]!.date}T00:00:00Z`).getUTCDay() + 6) % 7
  const firstEnded = cal.days.findIndex((d) => d.state === 'ended')
  // Weeks that lie wholly after the end of the authority add nothing: the grid stops with the week in which it ends.
  const stop = firstEnded < 0 ? cal.days.length : Math.min(cal.days.length, firstEnded + ((7 - ((lead + firstEnded) % 7)) % 7 || 7))
  const days = cal.days.slice(0, stop)
  const LIMIT = { day: 'the daily limit', month: 'the monthly limit', runs: 'the number of runs you allowed' }
  const AGAIN = { day: 'The daily limit starts again at midnight.', month: 'The monthly limit starts again on the 1st.', runs: 'It does not start again: the instruction ends when its runs are used.' }
  const said = `${cal.runs} run${cal.runs === 1 ? '' : 's'} in the next five weeks, ${cal.fixed ? '' : 'at most '}${fmt.money(cal.total)} in all.${cal.limitOn ? ` From ${fmt.isoDay(cal.limitOn)} the schedule asks for more than a limit allows.` : ''} Authority ends ${fmt.isoDay(cal.endsOn)}.`
  const months = cal.months.filter((m) => m.scheduled > 0 || m.month <= cal.endsOn.slice(0, 7))
  return (
    <section data-col="1" className="panel pr-ix-cal" aria-labelledby="weeks-h">
      <div className="pr-ix-sec-head"><h2 id="weeks-h">The next five weeks</h2><p>Each run on its day, under the limits you signed</p></div>
      <p className="pr-wk-key" aria-hidden="true">
        <span><i className={cal.asks ? 'pr-wk-dot asks' : 'pr-wk-dot'} />one run of {cal.fixed ? '' : 'at most '}{fmt.money(cal.perRun)}{cal.asks ? ', asked of you first' : ', made on its own'}</span>
        {cal.limitOn ? <span><i className="pr-wk-sq" />refused: over a limit</span> : null}
        {firstEnded >= 0 ? <span><i className="pr-wk-hatch" />after its authority ends</span> : null}
      </p>
      <div className="pr-wk" role="img" aria-label={said}>
        {WEEKDAYS.map((w) => <div key={w} className="pr-wk-wd">{w}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={`lead${i}`} className="pr-wk-day blank" />)}
        {days.map((d, i) => {
          const day = Number(d.date.slice(8)), month = MONTHS_LONG[Number(d.date.slice(5, 7)) - 1]!.slice(0, 3)
          return (
            <div key={d.date} className={`pr-wk-day ${d.state}${i === 0 ? ' today' : ''}`}>
              <span className="n">{i === 0 ? 'Today' : day === 1 ? `1 ${month}` : day}</span>
              {d.runs > 0 ? <span className="v"><i className={cal.asks ? 'pr-wk-dot asks' : 'pr-wk-dot'} />{d.runs > 1 ? `${d.runs} × ` : ''}<span className="pr-wk-amt">{fmt.money(cal.perRun)}</span></span> : null}
              {d.state === 'limit' ? <span className="v over">{d.runs > 0 ? 'the rest refused' : 'refused'}: {d.by === 'day' ? 'daily' : d.by === 'runs' ? 'run' : 'monthly'} limit</span> : null}
              {i === firstEnded ? <span className="v">ended</span> : null}
            </div>
          )
        })}
      </div>
      <div className="pr-wk-side">
        <p className="pr-quiet">{said} {cal.asks ? 'A ring is a request to you: nothing is done on that day unless you approve it.' : 'A filled dot is a run QED makes on its own.'}{cal.fixed ? '' : ` ${fmt.money(cal.perRun)} is the most one run may move, not what it will.`}{paused ? ' It is paused: none of this happens until you resume it.' : ''}</p>
        <ul className="pr-wk-months">
          {months.map((m) => {
            const pc = (x: number) => `${Math.max(0, Math.min(100, (x / Math.max(1, m.limit)) * 100)).toFixed(1)}%`
            const over = m.used + m.scheduled > m.limit
            return (
              <li key={m.month}>
                <b>{MONTHS_LONG[Number(m.month.slice(5)) - 1]}</b>
                <span className={`pr-wk-mbar ${over ? 'over' : ''}`} aria-hidden="true"><i className="used" style={{ width: pc(m.used) }} /><i className="sched" style={{ width: pc(Math.min(m.scheduled, Math.max(0, m.limit - m.used))) }} /></span>
                <small>{fmt.money(m.scheduled)} on the schedule{m.used ? `, ${fmt.money(m.used)} already used` : ''}, of at most {fmt.money(m.limit)}{over ? ': the rest is refused' : ''}</small>
              </li>
            )
          })}
        </ul>
      </div>
      {cal.limitOn && cal.limitBy ? <Note tone="wait">On this schedule {LIMIT[cal.limitBy]} is reached {cal.limitOn === cal.days[0]!.date ? 'today' : `on ${fmt.isoDay(cal.limitOn)}`}. A run there is no room for is refused, not postponed. {AGAIN[cal.limitBy]}</Note> : null}
    </section>
  )
}

/** What follows from an instruction: the server's analysis, figure by figure, each with the kind of figure it is. */
export function Consequences({ analysis, headingId, heading = true }: { analysis: Analysis; headingId?: string; heading?: boolean }) {
  const cert = analysis.certificate as { scenarios?: number; counted?: { label: string; monthly: number }[]; notCounted?: string[]; scope?: string; checkerA?: { tierD: boolean }; checkerB?: { tierD: boolean }; agree?: boolean } | undefined
  return (
    <div className="pr-cq">
      {heading ? <div className="pr-cq-head"><h2 id={headingId}>What follows from it</h2><p>{analysis.tierReason}</p></div> : <p className="pr-cq-reason">{analysis.tierReason}</p>}
      {analysis.refusals.map((r, i) => <Note key={`r${i}`} tone="void" title="Cannot be signed as it stands">{r}</Note>)}
      {analysis.warnings.map((w, i) => <Note key={`w${i}`} tone="wait">{w}</Note>)}
      {analysis.figures.length ? <dl className="pr-cq-figs">{analysis.figures.map((f, i) => <div key={i}><dt>{f.label}</dt><dd className="v">{f.value}</dd><dd className="n"><Basis kind={f.basis} />{f.note ? ` ${f.note}` : ''}</dd></div>)}</dl> : null}
      {analysis.consequences.length ? <div className="pr-cq-plain"><h3>In plain words</h3><ul>{analysis.consequences.map((c, i) => <li key={i}>{c}</li>)}</ul></div> : null}
      {cert?.counted ? (
        <div className="pr-cq-plain"><h3>What the no-regret check assumed about you</h3>
          <dl className="pr-cq-kv">{cert.counted.map((c, i) => <div key={i}><dt>{c.label}</dt><dd>{fmt.money(c.monthly)} a month</dd></div>)}</dl>
          <p>Not counted: {(cert.notCounted ?? []).join('; ')}.</p>
          <p>{cert.scope}</p></div>
      ) : null}
    </div>
  )
}

/** Consecutive missed runs are told once, as a stretch, instead of one identical line for each. Runs arrive newest first. */
function groupRuns(runs: RunView[]): RunView[][] {
  const out: RunView[][] = []
  for (const r of runs) { const g = out[out.length - 1]; if (r.state === 'missed' && g && g[0]!.state === 'missed') g.push(r); else out.push([r]) }
  return out
}

const usedSoFar = (runs: RunView[]): number => runs.reduce((s, r) => s + (r.actions ?? []).reduce((t, a) => t + ((a.state === 'done' || a.state === 'partial') && (a.kind === 'payment' || a.params.side === 'buy') ? Number(a.result.movedPaise ?? 0) : 0), 0), 0)

/** The top of an instruction's page: what it may still do, in figures that add up (used and left make the limit). */
function MayStillDo({ p, a, ceiling, used, now, live }: { p: ProgramDetail; a: Authority; ceiling: number | null; used: number; now: number; live: boolean }) {
  const { session } = useSession()
  const l = monthLeft(p), m = modeOf({ kind: p.kind, state: p.state, authority: a }), n = nextOf(p, now, session.stop)
  const sells = sellsOnly(p.kind)
  return (
    <section className="panel pr-ix-may" aria-labelledby="may-h">
      <div className="pr-ix-may-head"><h2 id="may-h">{live ? 'What it may still do' : p.state === 'draft' ? 'What it would allow, once signed' : 'What it was allowed'}</h2><span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span></div>
      <div className={`pr-ix-figs ${sells ? 'three' : 'five'}`}>
        {sells ? (
          <div className="pr-ix-fig"><p className="k">Its bound</p><p className="v">Sells only</p><p className="s">It never buys and never pays anyone. It ends {fmt.dayYear(a.expiresAt)}.</p></div>
        ) : <>
          <div className="pr-ix-fig"><p className="k">This month</p>{live && l ? <Bound used={p.usedThisMonth ?? 0} limit={l.of} period="this month" /> : <><p className="v">{fmt.money(a.maxPerMonth)}</p><p className="s">at most in one calendar month</p></>}</div>
          <div className="pr-ix-fig"><p className="k">In all, until {fmt.dayYear(a.expiresAt)}</p>{typeof ceiling === 'number' ? (live ? <Bound used={used} limit={ceiling} period="in all" /> : <><p className="v">{fmt.money(ceiling)}</p><p className="s">at most, then it ends</p></>) : <p className="s">{ceilingOf(p)}</p>}</div>
          <div className="pr-ix-fig"><p className="k">One run</p><p className="v">{fmt.money(a.maxPerRun)}</p><p className="s">at most; a run beyond any limit is refused</p></div>
        </>}
        <div className={`pr-ix-fig mode m-${m.key}`}><p className="k">How it acts</p><p className="v sm"><i aria-hidden="true" />{m.text}</p>{m.sub ? <p className="s">{m.sub}</p> : null}</div>
        <div className={`pr-ix-fig ${n.wait ? 'wait' : ''}`}><p className="k">Next</p><p className="v sm">{n.text}</p>{n.sub ? <p className="s">{n.sub}</p> : null}</div>
      </div>
    </section>
  )
}

/** Who enforces one instruction: what the owner set, what QED's server refuses, what QED watches for it, and what nothing outside QED checks. */
function WhoEnforces({ p, version, now }: { p: ProgramDetail; version: number; now: number }) {
  const { session } = useSession()
  const waits = p.kind === 'exit' || p.kind === 'floor' || p.kind === 'bills' || p.kind === 'split'
  return (
    <section data-col="2" className="panel pr-ix-who" aria-labelledby="who-h">
      <div className="pr-ix-sec-head"><h2 id="who-h">Who enforces it</h2></div>
      <ul className="pr-ix-who-list">
        <li><KindTag kind="set" /><p>{p.state === 'draft' ? 'Its limits and how it acts, as drafted. Nothing holds until your passkey signs it.' : `Its limits and how it acts, as your passkey signed them (version ${version}). Changing them makes a new version, which you sign before it is in force.`}</p></li>
        <li><KindTag kind="enforced" by="server" /><p>Every run is checked against those limits before anything is sent, and a run beyond any of them is refused, not postponed. No model decides.</p></li>
        {waits && (p.state === 'active' || p.state === 'paused') ? <li><KindTag kind="watched" /><p>{statusLine(p, now, session.stop)} Watching stops nothing by itself; a run follows only within the limits above.</p></li> : null}
        <li><span className="pr-ix-none">Outside QED</span><p>Nothing: on your bank account no bank, rail or venue checks it in this build. If QED's server failed, nothing outside QED would stop a larger run from your bank account.</p></li>
      </ul>
    </section>
  )
}

export function InstructionScreen({ id }: { id: string }) {
  const { session } = useSession()
  const now = useNow(5000)
  const board = useMasonry()
  const { data: p, error, reload } = useData<ProgramDetail>(`/api/programs/${id}`, ['program', 'run', 'action'])
  const [confirm, setConfirm] = useState<'pause' | 'revoke' | null>(null)
  const [approval, setApproval] = useState<(PendingApproval & { doc: AuthDoc; version: number }) | null>(null)
  const act = useAction(async (what: 'pause' | 'resume' | 'revoke' | 'discard-draft') => { if (what === 'resume') await resumeInstruction(id, session.hasPasskey); else await withPasskeyIfAsked(() => api('POST', `/api/programs/${id}/${what}`), session.hasPasskey); setConfirm(null); reload(); if (what === 'discard-draft' && p?.liveVersion === null) navigate('/instructions') })
  const sign = useAction(async () => { const a = await api<PendingApproval & { doc: AuthDoc; version: number }>('POST', `/api/programs/${id}/approval`); setApproval(a) })
  if (!p) return <div className="pr pr-ix"><Crumb to="/instructions">Instructions</Crumb>{error ? <><Problem error={error} /><p><Link to="/instructions">Back to instructions</Link></p></> : <div className="page-wait"><Loading what="Opening the instruction" /></div>}</div>
  const live = p.versions.find((v) => v.state === 'live'), draft = p.versions.find((v) => v.state === 'draft'), shown = live ?? draft ?? p.versions[0]
  if (!shown) return <div className="pr pr-ix"><Crumb to="/instructions">Instructions</Crumb><Note tone="void">This instruction has no version on record.</Note></div>
  const used = usedSoFar(p.runs)
  const stamp = p.state === 'active' ? { label: 'In force', tone: 'ok' as const, sub: live?.approvedAt ? `since ${fmt.day(live.approvedAt)}` : undefined } : p.state === 'paused' ? { label: 'Paused', tone: 'wait' as const } : p.state === 'revoked' ? { label: 'Revoked', tone: 'void' as const, sub: fmt.day(p.updatedAt) } : p.state === 'draft' ? null : { label: stateWord(p.state), tone: 'plain' as const, sub: fmt.day(p.updatedAt) }
  const analysis = p.current && shown.state === 'live' ? p.current : shown.analysis
  const inForce = p.state === 'active' || p.state === 'paused'
  return (
    <div className="pr pr-ix">
      <header className="page-head pr-ix-head">
        <div>
          <Crumb to="/instructions">Instructions</Crumb>
          <h1>{p.title}</h1>
          <p className={`pr-ix-status ${p.watching ? 'wait' : ''}`}><StateStamp state={p.state} /><span>{statusLine(p, now, session.stop)}</span></p>
        </div>
        <div className="pr-ix-acts">
          {p.state === 'active' ? <><Btn onClick={() => setConfirm('pause')}>Pause</Btn><Link className="btn" to={`/instructions/${id}/amend`}>Amend</Link><Btn tone="void" onClick={() => setConfirm('revoke')}>Revoke</Btn></> : null}
          {p.state === 'paused' ? <><Btn tone="fill" busy={act.busy} onClick={() => void act.run('resume')}>Resume</Btn><Btn tone="void" onClick={() => setConfirm('revoke')}>Revoke</Btn></> : null}
          {p.state === 'draft' ? <><Btn tone="fill" busy={sign.busy} onClick={() => void sign.run()}>Review and sign</Btn><Link className="btn" to={`/instructions/${id}/amend`}>Change it</Link><Btn tone="quiet" busy={act.busy} onClick={() => void act.run('discard-draft')}>Discard</Btn></> : null}
        </div>
      </header>
      <Problem error={act.error ?? sign.error} />
      {live && draft ? <Note tone="wait" title="An amended version is drafted but not signed">Version {live.version} stays in force until you sign version {draft.version}. <span className="row pr-ix-note-acts"><Btn small tone="fill" busy={sign.busy} onClick={() => void sign.run()}>Review and sign version {draft.version}</Btn><Btn small tone="quiet" busy={act.busy} onClick={() => void act.run('discard-draft')}>Discard the draft</Btn></span></Note> : null}

      {/* a savings goal's standing, remedies and release, as Save shows it (R12 task comparison, gap 5) */}
      {p.goal ? <section className="panel" id="goal" aria-labelledby="goal-h"><div className="pr-ix-sec-head"><h2 id="goal-h">The goal</h2><p>Where it stands by the rule below, worked out now from your records</p></div><GoalCard g={p.goal} onChanged={reload} onRecord /></section> : null}

      <MayStillDo p={p} a={shown.authority} ceiling={typeof shown.doc.ceilingPaise === 'number' ? shown.doc.ceilingPaise : null} used={used} now={now} live={inForce && shown.state === 'live'} />

      <div className="pr-ix-board board" ref={board}>
        {p.calendar && shown.state === 'live' ? <ComingWeeks cal={p.calendar} paused={p.state === 'paused'} /> : null}

        <WhoEnforces p={p} version={shown.version} now={now} />

        <section data-col="1" className="pr-ix-doc" aria-labelledby="doc-h">
          <div className="pr-ix-sec-head"><h2 id="doc-h">{shown.state === 'live' ? 'The document you signed' : shown.state === 'draft' ? 'The draft, word for word' : 'The document'}</h2><p>{shown.state === 'live' ? 'What QED may do, exactly as your passkey signed it' : shown.state === 'draft' ? 'The same document is shown again when you sign' : `Version ${shown.version}`}</p></div>
          <InstrumentDoc doc={shown.doc} version={shown.version} state={p.state === 'active' ? 'inforce' : p.state === 'draft' ? 'draft' : p.state === 'paused' ? 'held' : 'ended'}
            signature={shown.approvedAt ? { name: session.user?.displayName ?? 'You', at: shown.approvedAt, hash: shown.contentHash, method: shown.approvalMethod } : null} stamp={stamp}
            counterfoil={live ? <>
              <span><b>{p.counts.done} run{p.counts.done === 1 ? '' : 's'}</b> so far{p.counts.missed ? `, ${p.counts.missed} missed` : ''}{p.counts.refused ? `, ${p.counts.refused} refused` : ''}.</span>
              {typeof shown.doc.ceilingPaise === 'number' ? <span>Used <b>{fmt.money(used)}</b> of {fmt.money(shown.doc.ceilingPaise)}.</span> : shown.doc.ceilingPaise === null ? <span>Sells only.</span> : <span>Used <b>{fmt.money(used)}</b> so far.</span>}
              {p.state === 'active' && p.following.length ? <span>Next: {p.following.map((t) => fmt.dayTime(t)).join('; ')}.</span> : null}
            </> : undefined} />
        </section>

        <section data-col="2" className="panel pr-ix-follows" aria-labelledby="follows-h">
          <Consequences analysis={analysis} headingId="follows-h" />
          <p className="pr-quiet">{p.current && shown.state === 'live' ? <>Worked out now, {fmt.dayTime(p.current.computedAt)}, from today's records and prices. The figures you saw when you signed are part of the signed document and have not changed.</> : <>Figures as worked out {fmt.dayTime(shown.analysis.computedAt)}, when this version was written.</>}</p>
        </section>

        <section data-col="1" className="panel pr-ix-runs" aria-labelledby="runs-h">
          <div className="pr-ix-sec-head"><h2 id="runs-h">What it has done</h2><p>{p.runs.length ? `Every time it was due, newest first; a run that did not happen says why` : 'Nothing yet'}</p></div>
          {p.runs.length === 0 ? <p className="pr-quiet">It has not been due yet. Each time it is due appears here, done, refused or missed, with the reason.</p> : (
            <ul className="pr-ix-run-list">
              {groupRuns(p.runs).map((g) => g.length > 1 ? (
                <li key={g[0]!.id}>
                  <span className="when">{fmt.dayTime(g[g.length - 1]!.dueAt)}<small>to {fmt.dayTime(g[0]!.dueAt)}</small></span>
                  <span className="what"><b>{g.length} runs</b><small>QED's engine was not running at those times. Nothing was executed for them, and nothing will be executed late.</small>
                    <details className="pr-ix-each"><summary>Each of the {g.length} times</summary><small>{g.map((r) => fmt.dayTime(r.dueAt)).reverse().join('; ')}.</small></details></span>
                  <span className="state"><StateStamp state="missed" /></span>
                </li>
              ) : g.map((r) => (
                <li key={r.id}>
                  <span className="when">{fmt.dayTime(r.dueAt)}<small>version {r.version}</small></span>
                  <span className="what">
                    {(r.actions ?? []).map((a) => <span key={a.id} className="pr-ix-act"><Link to={`/record/${a.id}`}>{a.what}</Link>: {needsAttention(a.state, a.reconState) ? <span className="void">{NEEDS_ATTENTION.toLowerCase()}</span> : stateWord(a.state).toLowerCase()}{a.error && a.error !== r.reason ? `. ${a.error}` : ''}</span>)}
                    {(r.actions ?? []).length === 0 && r.willDo.length && !r.reason ? <span className="pr-ix-act">{r.willDo.join('; ')}</span> : null}
                    {r.reason ? <small>{r.reason}</small> : null}
                    {r.state === 'objection_window' && r.deadlineAt ? <small className="wait">Announced. It goes ahead {fmt.rel(r.deadlineAt, now)} unless you object on Home.</small> : null}
                    {r.state === 'awaiting_approval' && r.deadlineAt ? <small className="wait">Waiting for your approval on Home. It lapses {fmt.rel(r.deadlineAt, now)}.</small> : null}
                  </span>
                  <span className="state"><StateStamp state={r.state} recon={(r.actions ?? []).some((a) => a.reconState === 'break') ? 'break' : null} /></span>
                </li>
              )))}
            </ul>
          )}
        </section>

        <section data-col="2" className="panel pr-ix-hist" aria-labelledby="hist-h">
          <div className="pr-ix-sec-head"><h2 id="hist-h">Its history</h2><p>{p.versions.length} version{p.versions.length === 1 ? '' : 's'}, and everything done to it</p></div>
          <h3 className="pr-ix-sub">Versions</h3>
          <ul className="pr-ix-ver-list">
            {p.versions.map((v) => (
              <li key={v.version}>
                <span className="what"><b>Version {v.version}</b><small>{v.approvedAt ? `Signed ${fmt.full(v.approvedAt)}` : `Drafted ${fmt.full(v.createdAt)}`}.</small></span>
                <span className={`pr-ix-tag ${v.state === 'live' ? 'live' : ''}`}>{v.state === 'live' ? 'in force' : v.state}</span>
                <details className="pr-ix-fp"><summary>Its document's fingerprint</summary><span className="code">{fmt.hash(v.contentHash)}</span></details>
              </li>
            ))}
          </ul>
          <h3 className="pr-ix-sub">What was done to it</h3>
          <ul className="pr-ix-ev-list">
            {p.events.filter((e) => !e.kind.startsWith('run-')).slice(0, 12).map((e) => <li key={e.id}><span>{e.kind.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} by {e.actor === 'owner' ? 'you' : 'QED'}</span><time>{fmt.dayTime(e.ts)}</time></li>)}
          </ul>
        </section>
      </div>

      {p.state === 'revoked' ? <RevocationOf programId={id} /> : null}

      <Sheet open={confirm !== null} title={confirm === 'pause' ? 'Pause this instruction' : 'Revoke this instruction'} onClose={() => setConfirm(null)}
        foot={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn>{confirm === 'pause' ? <Btn tone="fill" busy={act.busy} onClick={() => void act.run('pause')}>Pause it</Btn> : <Btn tone="void-fill" busy={act.busy} onClick={() => void act.run('revoke')}>Revoke it for good</Btn>}</>}>
        <dl className="kv">
          <dt>Stops</dt><dd>{confirm === 'pause' ? 'New runs, until you resume. Runs that fall due while paused are not caught up later.' : 'Everything, permanently. To use it again you write and sign a new instruction.'}</dd>
          <dt>Cancelled now</dt><dd>Any run of it that is waiting for your approval or in its notice period, and any payment of it not yet sent.</dd>
          <dt>Asked to stop</dt><dd>The paper bank&rsquo;s mandate for it (a simulated bank) and, if you have a wallet, a reminder that its on-chain mandate is revoked only with your passkey. Each answer is shown here afterwards; one that has not answered is not shown as revoked.</dd>
          <dt>Still completes</dt><dd>An order or payment it has already sent to a venue or a rail. Those cannot be recalled; you will see them finish.</dd>
        </dl>
        <Problem error={act.error} />
      </Sheet>

      <ApprovalSheet approval={approval} title="Sign this instruction" action="Sign and put in force" onClose={() => setApproval(null)}
        onApproved={async (approvalId) => { await api('POST', `/api/programs/${id}/activate`, { approvalId }); setApproval(null); reload() }}>
        {approval ? <InstrumentDoc doc={approval.doc} version={approval.version} state="review" /> : null}
      </ApprovalSheet>
    </div>
  )
}
