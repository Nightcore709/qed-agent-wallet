/**
 * The statement (Meridian, DESIGN.md M4): the bank account as a passbook on glass, for the period the owner chooses
 * (R12 task comparison, gap 9): since opening, this week, this month, last month, or chosen dates, in India time. It opens
 * on figures that add up, as tiles with their operators (the balance at the period's start, plus money in, less money
 * out, is the balance at its end or now), then ruled columns, one group of lines a day, oldest first and newest last.
 * Each line says who caused it and under which instruction, carries the ledger's balance after it, and leads to its
 * record and its receipt; a line your bank entered says so, with its entry number; a line entered late says when it took
 * effect. While the period runs, the line marked "now", drawn as a line of light, and under it what is expected and has
 * not happened yet: promises and estimates on a dashed edge, visibly not entries, carried on as a projected balance. A
 * period that has ended closes on its end balance instead. The period's statement downloads as a CSV file named by its
 * days, opening with the period and its four figures.
 *
 * The period is read by the server (server/statement.ts): it starts at the first line entered at or after 00:00 (in the household's zone) of
 * its first day, so a line entered exactly at midnight belongs to the day that starts then, the figures add up exactly,
 * and a period that has ended never changes.
 */
import { Download } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { api, fmt, getDisplayZone, navigate, useData, useNow, zoneDay, zoneHead, zoneIso, zoneName, zoneWeekday } from '../lib/core.ts'
import { zoneLabel } from '../../shared/zone.ts'
import { useUrlState } from '../lib/url-state.ts'
import { Btn, Field, Link, Problem, Seal, useAction, WHO } from '../ui/kit.tsx'
import type { PassbookLine, Since, StatementView } from '../lib/types.ts'
import { Paise } from '../ui/charts.tsx'
import { fmtDec } from '../../shared/fixed.ts'
import { homeMoneyExact } from '../../shared/home-money.ts'
import { checkDates, type DateFields, istDate, type PeriodKind, periodFileName, periodWords, running } from '../../shared/period.ts'
import { ActivityHead } from './Activity.tsx'
import { Terms } from './Safeguards.tsx'

export { inProgressLine } from './Activity.tsx'

const EXPECTED_BY: Record<string, string> = { program: 'QED, under your instruction', bill: 'A bill, not yet paid', emi: 'Your bank will take this', income: 'Expected from your employer', card: 'Your card' }

const LAST_SEEN = 'qed.lastSeen'
const AWAY_MS = 30 * 60_000
/**
 * When the owner comes back after half an hour or more, the moment they were last here. This browser remembers it;
 * if it cannot (private window, storage cleared) nothing is shown, and the passbook below says the same in full.
 */
function useAbsence(): [number | null, () => void] {
  const read = (): number => { try { return Number(localStorage.getItem(LAST_SEEN)) || 0 } catch { return 0 } }
  const away = (v: number): boolean => v > 0 && Date.now() - v > AWAY_MS
  const [since, setSince] = useState<number | null>(() => { const v = read(); return away(v) ? v : null })
  useEffect(() => {
    // "Seen" means this page was showing. It is noted every minute while it shows and at the moment it is hidden or
    // left. Coming back to a tab that stayed open, or waking a computer that slept with it open, counts as a return.
    const seen = () => { const v = read(); if (away(v)) setSince(v); try { localStorage.setItem(LAST_SEEN, String(Date.now())) } catch { /* nothing to remember with */ } }
    const tick = () => { if (document.visibilityState === 'visible') seen() }
    seen()
    const t = setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', seen); window.addEventListener('pagehide', seen)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', seen); window.removeEventListener('pagehide', seen) }
  }, [])
  return [since, () => setSince(null)]
}
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const span = (ms: number): string => (ms < 5_400_000 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : ms < 172_800_000 ? `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)} hours` : `${Math.round(ms / 86_400_000)} days`)

/** What happened while the owner was away, stated from the records. Nothing here is written by a model. */
function SinceLast({ since, onClose }: { since: number; onClose: () => void }) {
  const d = useData<Since>(`/api/since?ts=${since}`)
  if (!d.data) return null
  const s = d.data
  const quiet = s.done + s.missed + s.refused + s.failed + s.lapsed + s.byHand === 0
  return (
    <section className="panel pb-since" aria-labelledby="since-h">
      <div className="pb-since-head"><h2 id="since-h">Since you were last here</h2><p className="small muted">{fmt.dayTime(s.from)}, {span(s.to - s.from)} ago.</p></div>
      {quiet ? <p>Nothing was due and nothing was done.</p> : (
        <ul className="pb-since-list">
          {s.done > 0 ? <li>QED carried out {plural(s.done, 'run')}{s.byInstruction.length ? ': ' : '.'}{s.byInstruction.slice(0, 3).map((b, i) => <span key={b.id}>{i ? '; ' : ''}{b.n} under <Link to={`/instructions/${b.id}`}>{b.title}</Link>{b.moved ? `, ${fmt.money(b.moved, true)} in all` : ''}</span>)}{s.byInstruction.length > 3 ? `; and ${s.byInstruction.length - 3} more` : ''}{s.byInstruction.length ? '.' : ''}</li> : null}
          {s.missed > 0 ? <li><strong>{plural(s.missed, 'scheduled run')} {s.missed === 1 ? 'was' : 'were'} missed</strong> because the engine was not running{s.downtime.gaps ? ` (${span(s.downtime.ms)} in ${plural(s.downtime.gaps, 'stretch', 'stretches')})` : ''}. {s.missed === 1 ? 'It was' : 'None was'} {s.missed === 1 ? 'not ' : ''}made up late.</li> : s.downtime.gaps ? <li>The engine was not running for {span(s.downtime.ms)}. Nothing was due in that time.</li> : null}
          {s.refused > 0 ? <li><strong>{plural(s.refused, 'run')} {s.refused === 1 ? 'was' : 'were'} refused</strong> before anything was sent{s.refusedWhy[0]?.reason ? `. The latest, under “${s.refusedWhy[0].title}”: ${s.refusedWhy[0].reason}` : '.'}</li> : null}
          {s.failed > 0 ? <li><strong>{plural(s.failed, 'run')} failed.</strong> Any money that had left came back; the record of each says what happened.</li> : null}
          {s.lapsed > 0 ? <li>{plural(s.lapsed, 'request')} to you lapsed without an answer, so {s.lapsed === 1 ? 'that run was' : 'those runs were'} not made.</li> : null}
          {s.byHand > 0 ? <li>You made {plural(s.byHand, 'order or payment', 'orders and payments')} yourself.</li> : null}
        </ul>
      )}
      <div className="row pb-since-foot"><Link className="btn sm" to="/activity">See everything done</Link><Btn small tone="quiet" onClick={onClose}>Close</Btn></div>
    </section>
  )
}

/** "2026-10-25T09:00:00.000+05:30": an instant in the household's zone, as the file writes it. */
const isoIst = zoneIso
/** Paise as exact text to rupees with two decimals ("-100000" is "-1000.00"), digit by digit. */
const rupeesOf = (text: string | undefined, n: number): string => fmtDec(BigInt(text ?? String(n)), 2)

/**
 * The order the statement's lines are in, said on the screen and in the file (R13): the order they were entered in the
 * account, which is the order its balances follow. Ordering by when each took effect was weighed and refused
 * (server/statement.ts): a balance run in that order would show amounts the account never held.
 */
export const STATEMENT_ORDER = 'Oldest first, in the order each line was entered in your bank account; the balance after each line is the account\'s balance then. "Took effect" is when a line took effect, where that is not when it was entered, and "Why late" says why it was entered or taken late.'
/** The same, as the screen says it above the lines. */
/** Said under the order when some lines are stamped earlier than a line entered before them (the clock was set back): they stay where they were entered. */
export const backdatedWords = (n: number): string => n <= 0 ? '' : `${n === 1 ? '1 line here is' : `${n} lines here are`} stamped earlier than a line entered before ${n === 1 ? 'it' : 'them'}. ${n === 1 ? 'It stays' : 'They stay'} where entered, so the periods still meet and the balances still follow.`
export const STATEMENT_ORDER_SCREEN = 'In the order each line was entered in your bank account, oldest first, with the balance after it. A line that took effect at another time, or was taken late, says when and why.'

/** Why a line is late, in the file: recorded late (QED was not running), or taken late with the time it was due. */
function whyLate(l: PassbookLine): string {
  if (l.takenLate) return `Taken late: it was due ${l.scheduledAt ? isoIst(l.scheduledAt) : 'earlier'}, and the money was not there on its day.`
  if (l.recordedLate) return 'Recorded late: QED was not running when it took effect.'
  return ''
}

/**
 * The bank statement of a period as a CSV file (RISK-066): first which days it covers, its four figures (the balance at
 * the start, money in, money out, the balance at the end), when it was read and the order of its lines; a blank line; then
 * every line, oldest first, with when it was entered, its words, who caused it, money in and out and the balance after it
 * in rupees, its record, why it is late if it is, and when it took effect. Every figure is written from the server's exact
 * text. A cell that a spreadsheet would run as a formula (starting with =, +, -, @, a tab or a return) is written as text,
 * since memos and names are typed by people.
 */
export function statementCsv(v: Pick<StatementView, 'opening_text' | 'moneyIn_text' | 'moneyOut_text' | 'closing_text' | 'lines'>, period: string, readAt: string): string {
  const cell = (s: string) => { const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const rows: string[][] = [
    ['Bank statement', `${period} (${zoneName()})`],
    ['Balance at the start (INR)', fmtDec(BigInt(v.opening_text), 2)], ['Money in (INR)', fmtDec(BigInt(v.moneyIn_text), 2)], ['Money out (INR)', fmtDec(BigInt(v.moneyOut_text), 2)], ['Balance at the end (INR)', fmtDec(BigInt(v.closing_text), 2)],
    ['Read at', readAt], ['Order', STATEMENT_ORDER], [],
    [`Entered (${zoneHead()})`, 'What', 'By', 'Under instruction', 'Money in (INR)', 'Money out (INR)', 'Balance after (INR)', 'Record', 'Why late', `Took effect (${zoneHead()})`],
  ]
  for (const l of [...v.lines].reverse()) {
    const amount = BigInt(l.amount_text ?? String(l.amount))
    rows.push([isoIst(l.ts), l.memo, (WHO[l.actor] ?? [l.actor])[0]!, l.programTitle ?? '', amount > 0n ? fmtDec(amount, 2) : '', amount < 0n ? fmtDec(-amount, 2) : '', rupeesOf(l.balance_text, l.balance), l.actionId ?? '', whyLate(l), isoIst(l.effectiveTs)])
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}

/**
 * When a line took effect, said only when that is not when it was entered: a bank event QED recorded late, or a payout
 * dated before it was booked. Seconds apart (a rail's own time against the moment QED booked it) is not worth a word.
 * An instalment taken late for want of money is dated when it was taken, so it says when it was due and why (R13).
 */
export function tookEffect(l: PassbookLine): string | null {
  if (l.takenLate) return `Taken late: it was due ${l.scheduledAt ? fmt.dayTime(l.scheduledAt) : 'earlier'}, and the money was not there on its day.`
  if (Math.abs(l.ts - l.effectiveTs) < 60_000) return null
  return l.recordedLate ? `Recorded late: it took effect ${fmt.dayTime(l.effectiveTs)}, when QED was not running.` : `It took effect ${fmt.dayTime(l.effectiveTs)}.`
}

const istDay = zoneDay
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** "Monday 23 Nov 2026" for a day in the household's zone. */
const longDay = (ms: number): string => `${WEEKDAY[zoneWeekday(ms)]} ${fmt.dayYear(ms)}`
const byWho = (actor: string): string => (actor === 'you' ? 'By you' : actor === 'qed' ? 'By QED' : (WHO[actor] ?? [actor])[0]!)
/** A link inside a line that opens on a press: it goes where it says, not to the line's record, and a new tab still works. */
function go(e: React.MouseEvent<HTMLAnchorElement>, to: string): void {
  e.stopPropagation()
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  navigate(to)
}
/** Rupees with paise from a figure the server sent as a number where exact and as text always. */
const rupees = (n: number | null, text: string): string => (n !== null ? fmt.money(n, true) : homeMoneyExact(BigInt(text)))
/** Hand a file to the browser to save. */
function save(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The lines of one day (the day they were entered, India time), with the day's money in and out. */
interface Day { day: string; at: number; lines: PassbookLine[]; in: number; out: number }

/** A period the owner can choose; chosen dates carry their first and last day. */
type Choice = { kind: Exclude<PeriodKind, 'dates'> } | { kind: 'dates'; first: string; last: string }
const CHOICES: [Exclude<PeriodKind, 'dates'>, string][] = [['all', 'Since opening'], ['week', 'This week'], ['month', 'This month'], ['last-month', 'Last month']]
const queryOf = (c: Choice): string => (c.kind === 'dates' ? `period=dates&first=${c.first}&last=${c.last}` : `period=${c.kind}`)
/** The period a link asks for (?period=, chosen dates with ?first= and ?last=, only when they make a period), else since opening. */
export function choiceFrom(q: URLSearchParams): Choice {
  const k = q.get('period'), first = q.get('first') ?? '', last = q.get('last') ?? ''
  if (k === 'week' || k === 'month' || k === 'last-month') return { kind: k }
  return k === 'dates' && !checkDates(first, last) ? { kind: 'dates', first, last } : { kind: 'all' }
}
/** The period as the address writes it; nothing for since opening. */
export const choiceQuery = (c: Choice): string => (c.kind === 'all' ? '' : queryOf(c))
/** Whether a statement the server sent is the one for this choice (a new choice's arrives a moment after it is made). */
const isFor = (v: StatementView, c: Choice): boolean => v.period.kind === c.kind && (c.kind !== 'dates' || (v.period.first === c.first && v.period.last === c.last))
const FIRST_LINES = (c: Choice): number => (c.kind === 'all' ? 10 : 40)

/**
 * Two days, first and last, checked when shown and refused in words when wrong; nothing is guessed. Focus moves into the
 * form when the person opened it ("Choose dates"), not when a link to chosen dates opens the page with it showing.
 */
function DatesForm({ id, choice, today, focus, onShow }: { id: string; choice: Choice; today: string; focus: boolean; onShow: (first: string, last: string) => void }) {
  const [first, setFirst] = useState(choice.kind === 'dates' ? choice.first : `${today.slice(0, 8)}01`)
  const [last, setLast] = useState(choice.kind === 'dates' ? choice.last : today)
  const [fields, setFields] = useState<DateFields>({})
  const firstRef = useRef<HTMLInputElement>(null), lastRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focus) firstRef.current?.focus() }, [focus])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const wrong = checkDates(first, last)
    setFields(wrong ?? {})
    if (wrong) { (wrong.first ? firstRef : lastRef).current?.focus(); return }
    onShow(first, last)
  }
  return (
    <form id={id} className="pb-dates" onSubmit={submit} noValidate aria-label="Choose the dates to show">
      <Field label="First day" error={fields.first}>{(p) => <input {...p} ref={firstRef} className="input" type="date" value={first} onChange={(e) => { setFirst(e.target.value); setFields({}) }} />}</Field>
      <Field label="Last day" error={fields.last}>{(p) => <input {...p} ref={lastRef} className="input" type="date" value={last} onChange={(e) => { setLast(e.target.value); setFields({}) }} />}</Field>
      <Btn type="submit" className="pb-dates-go">Show these dates</Btn>
    </form>
  )
}

export function PassbookScreen() {
  const now = useNow(1000)
  const [choice, setChoice] = useUrlState<Choice>('/passbook', choiceFrom, choiceQuery)
  const [datesOpen, setDatesOpen] = useState(choice.kind === 'dates')
  const [datesPressed, setDatesPressed] = useState(false)
  const [limit, setLimit] = useState(FIRST_LINES(choice))
  const book = useData<StatementView>(`/api/passbook?${queryOf(choice)}&limit=${limit}`, ['action', 'run', 'bill', 'program', 'profile'])
  const [since, closeSince] = useAbsence()
  const datesId = useId()
  const pick = (c: Choice) => { setChoice(c); setLimit(FIRST_LINES(c)) }
  const csv = useAction(async () => {
    const all = await api<StatementView>('GET', `/api/passbook?${queryOf(choice)}&limit=100000`)
    const at = Date.now(), opened = all.opened !== null ? istDate(all.opened) : null
    save(periodFileName('qed-bank-statement', all.period, at, opened), statementCsv(all, periodWords(all.period, at, opened), fmt.full(at)))
  })

  // the statement for the period chosen; another period's, still showing while the new one is read, is not passed off as it
  const v = book.data && isFor(book.data, choice) ? book.data : null
  const reading = !v && !book.error
  const live = v ? running(v.period, now) : true
  const opened = v?.opened ?? null
  const words = v ? periodWords(v.period, now, opened !== null ? istDate(opened) : null) : null
  // the period ended before the account's first line was entered: there was no account yet
  const before = !!v && v.period.to !== null && (opened === null || opened >= v.period.to)
  const past = (v?.lines ?? []).slice().reverse()
  const expected = v && live ? v.expected : []
  const days: Day[] = []
  for (const l of past) {
    const d = istDay(l.ts)
    const last = days[days.length - 1]
    if (last && last.day === d) { last.lines.push(l); last.in += Math.max(0, l.amount); last.out += Math.max(0, -l.amount) } else days.push({ day: d, at: l.ts, lines: [l], in: Math.max(0, l.amount), out: Math.max(0, -l.amount) })
  }
  let projected = v?.closing ?? 0
  const start = !v ? '' : v.period.from === null ? (opened !== null ? `Opened ${fmt.dayYear(opened)}` : 'Not opened yet') : `${fmt.dayYear(v.period.from)}, 00:00`
  const end = !v ? '' : live ? (v.more ? `The ${v.lines.length} latest of ${plural(v.count, 'line')} are shown; earlier ones are one press away` : `${plural(v.count, 'line')} in this period`) : `End of ${fmt.dayYear(v.period.to! - 1)}${v.more ? `; the ${v.lines.length} latest of ${plural(v.count, 'line')} are shown` : ''}`

  return (
    <div className="pb">
      <ActivityHead at="statement" title="Statement">Your bank account line by line, for the period you choose: the balance at its start, what came in and what went out, each line with who caused it and the balance after it, and the balance at its end. While the period runs, what is expected next follows the line marked now.</ActivityHead>
      {since ? <SinceLast since={since} onClose={closeSince} /> : null}
      <section className="panel pb-sheet" aria-labelledby="book-h">
        <header className="pb-head">
          <div className="pb-title"><h2 id="book-h">Bank statement</h2><p>{words ?? 'Your bank account, in paper money for practice.'}</p></div>
          <Btn small busy={csv.busy} disabled={!v} onClick={() => void csv.run()}><Download aria-hidden="true" />Download it (CSV)</Btn>
        </header>
        <div className="pb-period">
          <div className="seg pb-seg" role="group" aria-label="Period">
            {CHOICES.map(([k, w]) => <button key={k} type="button" aria-pressed={!datesOpen && choice.kind === k} onClick={() => { setDatesOpen(false); setDatesPressed(false); pick({ kind: k }) }}>{w}</button>)}
            <button type="button" aria-pressed={datesOpen || choice.kind === 'dates'} aria-controls={datesOpen ? datesId : undefined} onClick={() => { setDatesOpen(true); setDatesPressed(true) }}>Choose dates</button>
          </div>
          {datesOpen ? <DatesForm id={datesId} choice={choice} today={istDate(now)} focus={datesPressed} onShow={(first, last) => pick({ kind: 'dates', first, last })} /> : null}
        </div>
        {/* the order the lines are in, and so what each balance means (R13: the ordering is labelled) */}
        <p className="small muted pb-order">{STATEMENT_ORDER_SCREEN}{v && v.backdated > 0 ? ` ${backdatedWords(v.backdated)}` : ''}</p>
        {/* the period shown, said once it has arrived, for a screen reader (WCAG 4.1.3) */}
        <p className="sr" role="status">{v && words ? `${words}. Balance at the start ${rupees(v.opening, v.opening_text)}; money in ${rupees(v.moneyIn, v.moneyIn_text)}; money out ${rupees(v.moneyOut, v.moneyOut_text)}; balance ${live ? 'now' : 'at the end'} ${rupees(v.closing, v.closing_text)}.` : ''}</p>
        {v ? (
          <div className="pb-figs">
            <Terms label="The period, as a sum" terms={[
              { k: v.period.kind === 'all' ? 'When the account was opened' : 'Balance at the start', v: rupees(v.opening, v.opening_text), s: start },
              { op: '+', k: 'Money in', v: rupees(v.moneyIn, v.moneyIn_text), s: plural(v.linesIn, 'line') },
              { op: '−', k: 'Money out', v: rupees(v.moneyOut, v.moneyOut_text), s: plural(v.linesOut, 'line') },
              { op: '=', hero: true, k: live ? 'Balance now' : 'Balance at the end', v: v.closing !== null ? <Paise paise={v.closing} /> : rupees(null, v.closing_text), s: end },
            ]} />
          </div>
        ) : reading ? <div key="figs-wait" className="pb-figs pb-figs-wait" aria-hidden="true"><span className="skel" /></div> : null}
        <Problem error={csv.error} />
        {/* Each state keyed, so the table arrives as a new block rather than as the loading block moved down (CLS). */}
        {!v ? (book.error ? <div key="problem" className="pb-problem"><Problem error={book.error} /><Btn small onClick={book.reload}>Try again</Btn></div> : <div key="loading" className="pb-loading" aria-busy="true"><p className="loading-line">Reading your bank account…</p>{[0, 1, 2, 3].map((i) => <span key={i} className="skel" />)}</div>) : (
          <div key="table" className="pb-scroll" tabIndex={0} role="region" aria-label="Passbook table; scroll sideways on a narrow screen">
            <table className="ledger pb-table">
              <caption className="sr">Your bank account for {words}: one line per entry with the balance after it{live ? ', then what is expected' : ''}</caption>
              <thead><tr><th scope="col" className="pb-time">Entered</th><th scope="col">What</th><th scope="col" className="num pb-wide">Money out</th><th scope="col" className="num pb-wide">Money in</th><th scope="col" className="num pb-narrow">Amount and balance</th><th scope="col" className="num pb-bal">Balance</th></tr></thead>
              {v.more ? <tbody><tr className="pb-earlier"><td colSpan={6}><Btn small tone="quiet" onClick={() => setLimit((x) => x + 40)}>{v.period.kind === 'all' ? 'Show earlier entries' : 'Show earlier entries in this period'}</Btn></td></tr></tbody> : null}
              {past.length === 0 ? <tbody><tr className="pb-nothing"><td colSpan={6}>{
                v.period.kind === 'all' ? 'Nothing has been entered in your bank account yet.'
                  : before ? (opened !== null ? `Your bank account was opened on ${fmt.dayYear(opened)}, after this period. Nothing was entered in it before then.` : 'Your bank account has not been opened yet.')
                    : `Nothing was entered in your bank account in this period. The balance stayed at ${rupees(v.closing, v.closing_text)}.`
              }</td></tr></tbody> : null}
              {days.map((d) => (
                <tbody key={d.day} className="pb-day">
                  <tr className="pb-day-head"><th colSpan={6} scope="rowgroup"><span className="pb-day-name">{longDay(d.at)}</span><span className="pb-day-sum">{plural(d.lines.length, 'line')}{d.in ? `, ${fmt.money(d.in, true)} in` : ''}{d.out ? `, ${fmt.money(d.out, true)} out` : ''}</span></th></tr>
                  {d.lines.map((l) => {
                    const open = () => { if (l.actionId) navigate(`/record/${l.actionId}`) }
                    const effect = tookEffect(l)
                    return (
                      <tr key={l.seq} className={`pb-line ${l.actionId ? 'clickable' : ''}`} onClick={open}>
                        <td className="pb-time">{fmt.time(l.ts)}</td>
                        <td className="pb-what">
                          <span className="pb-memo">{l.actionId ? <a href={`/record/${l.actionId}`} onClick={(e) => go(e, `/record/${l.actionId}`)}>{l.memo}</a> : l.memo}</span>
                          <span className="pb-ref">
                            <span className="pb-time-in">{fmt.time(l.ts)}. </span>
                            <span className={l.actor === 'qed' ? 'by-qed' : l.actor === 'you' ? 'by-you' : ''}>{byWho(l.actor)}</span>{l.programTitle ? <>, under “{l.programTitle}”</> : null}{l.actionId ? '.' : ','}
                            {l.receiptId ? <> <a href={`/receipts/${l.receiptId}`} className="pb-receipt" onClick={(e) => go(e, `/receipts/${l.receiptId}`)}><Seal />Receipt kept</a></> : null}
                            {!l.actionId ? <> entry no. {l.seq}.</> : null}
                            {effect ? ` ${effect}` : ''}
                          </span>
                        </td>
                        <td className="num pb-out pb-wide">{l.amount < 0 ? fmt.money(-l.amount, true) : ''}</td>
                        <td className="num pb-in pb-wide">{l.amount > 0 ? fmt.money(l.amount, true) : ''}</td>
                        <td className={`num pb-narrow ${l.amount > 0 ? 'pb-in' : 'pb-out'}`}>{l.amount > 0 ? fmt.signed(l.amount) : `−${fmt.money(-l.amount, true)}`}<span className="pb-after">{fmt.money(l.balance, true)} after</span></td>
                        <td className="num pb-bal">{fmt.money(l.balance, true)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
              {live ? (
                <tbody className="pb-ahead">
                  <tr className="pb-now"><td colSpan={6}><span><b>Now, {fmt.dayTime(now)} {zoneLabel(now, getDisplayZone())}.</b> Below this line nothing has happened yet: these are promises and estimates.</span></td></tr>
                  {expected.length === 0 ? <tr className="pb-exp"><td colSpan={6}>Nothing is expected in the next 30 days.</td></tr> : null}
                  {expected.map((e, i) => {
                    projected += e.amount
                    return (
                      <tr key={i} className={`pb-exp ${projected < 0 ? 'short' : ''}`}>
                        <td className="pb-time">{fmt.day(e.dueAt)}<span className="sub">{fmt.time(e.dueAt)}</span></td>
                        <td className="pb-what"><span className="pb-memo">{e.kind === 'program' && e.subject ? <Link to={`/instructions/${e.subject}`}>{e.label}</Link> : e.kind === 'bill' && e.subject ? <Link to={`/pay?bill=${e.subject}#pay-review`}>{e.label}</Link> : e.label}</span>
                          <span className="pb-ref"><span className="pb-time-in">{fmt.dayTime(e.dueAt)}. </span>
                            {e.kind === 'bill'
                              ? (e.by ? <>A bill. <span className="by-qed">QED will pay it</span> under “{e.by.title}”.</> : <span className="pb-due">A bill nobody will pay unless you do. {e.unpaid}</span>)
                              : <><span className={e.kind === 'program' ? 'by-qed' : ''}>{EXPECTED_BY[e.kind] ?? ''}</span>{e.certain ? '.' : '. The amount is an estimate.'}</>}</span></td>
                        <td className="num pb-out pb-wide">{e.amount < 0 ? fmt.money(-e.amount) : ''}</td>
                        <td className="num pb-in pb-wide">{e.amount > 0 ? fmt.money(e.amount) : ''}</td>
                        <td className={`num pb-narrow ${e.amount > 0 ? 'pb-in' : 'pb-out'}`}>{e.amount > 0 ? fmt.signed(e.amount, false) : `−${fmt.money(-e.amount)}`}<span className="pb-after">{projected < 0 ? `short by ${fmt.money(-projected)}` : `${fmt.money(projected)} after`}</span></td>
                        <td className="num pb-bal">{projected < 0 ? `short by ${fmt.money(-projected)}` : fmt.money(projected)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              ) : (
                <tbody className="pb-close">
                  <tr className="pb-end"><td colSpan={6}><span><b>End of {fmt.dayYear(v.period.to! - 1)}.</b> Balance at the end {rupees(v.closing, v.closing_text)}{before ? '' : `, from ${rupees(v.opening, v.opening_text)} at the start`}.</span></td></tr>
                </tbody>
              )}
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
