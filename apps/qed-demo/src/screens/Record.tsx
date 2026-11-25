/**
 * The record of one order or payment (design "Meridian", DESIGN.md M4). It opens on what moved and how it ended, beside
 * its receipt and where its decision can be checked: the receipt's place in the chain, the venue's record against the
 * ledger, and its evidence case. Then one ruled sheet of what was asked, by whom, under which bound (drawn from the
 * limits the checks recorded: used before, this action, what is left, and the bracket at the limit, in QED's colour as
 * every meter of authority is), when each was decided; then the checks with their results beside every stage with its
 * time; the fills; the references and fingerprints one press away; and, while it can still be stopped or disputed, how.
 * An outcome that is not known yet, or only partly done, says so in those words, above everything else.
 * The receipt is its own page: a slip with a counterfoil, whose fingerprint this browser recomputes, and which downloads
 * as the exact record that was fingerprinted.
 */
import { awaitsRepeat, RepeatHeld } from '../ui/repeat.tsx'
import { Check as Tick, Download, FileSearch, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { dayText, istDay } from '../../shared/day-text.ts'
import { decisionWords } from '../../shared/latency.ts'
import { canonical, sha256 } from '../../shared/sha256.ts'
import { api, fmt, sourceName, useData, useNow } from '../lib/core.ts'
import { expiredLine, standsUntilLine } from '../lib/order-expiry.ts'
import { fundStages } from '../lib/fund-stages.ts'
import type { ActionView, Check, Receipt, RecordView } from '../lib/types.ts'
import { Btn, Crumb, Field, Link, Note, Problem, Seal, Stamp, StateStamp, stateWord, useAction, useSession, needsAttention } from '../ui/kit.tsx'
import { type CaseSummary, receiptOutcome } from '../ui/records.ts'
import { checkLabel, inProgressLine, useMedia } from './Activity.tsx'
import { atTime, heldWords, IF_NO_ANSWER, railAnswerBy } from '../lib/words.ts'
import { unitsWord } from '../ui/prices.ts'

const TERMINAL = new Set(['blocked', 'done', 'partial', 'rejected', 'failed', 'cancelled', 'expired'])
/** Ended without using any of its limit: nothing went ahead. */
const NOT_GONE = new Set(['blocked', 'rejected', 'failed', 'cancelled', 'expired'])
const VENUE: Record<string, string> = {
  'paper-crypto': 'QED\'s paper exchange, which fills against CoinDCX\'s live order book',
  'paper-mf': 'QED\'s paper fund registrar, which uses the NAVs AMFI publishes',
  'paper-rail': 'QED\'s paper payment rail',
}
/** In presentation mode the paper venues work from synthetic data (N-003). */
const VENUE_PRESENTATION: Record<string, string> = {
  'paper-crypto': 'QED\'s paper exchange, which fills against a synthetic order book (presentation mode)',
  'paper-mf': 'QED\'s paper fund registrar, which uses synthetic NAVs (presentation mode)',
  'paper-rail': 'QED\'s paper payment rail',
}
const METHOD: Record<string, string> = { password: 'with your password', 'recent-password': 'with the password you had entered a few minutes earlier', session: 'from your signed-in session; an action this small does not ask for the password again', passkey: 'with your passkey' }

const MINUS = '−'
const n = (v: unknown): number => Number(v ?? 0)
const qtyText = (atoms: unknown, scale: number): string => (n(atoms) / 10 ** scale).toLocaleString('en-IN', { maximumFractionDigits: scale })
const rupee = (s: string, dp = 2): string => `₹${fmt.price(s, dp)}`
function later(from: number | undefined | null, to: number | undefined | null): string {
  if (!from || !to || to < from) return ''
  const d = to - from
  if (d === 0) return 'in the same millisecond'
  return d < 1000 ? `${d} ms later` : d < 90_000 ? `${(d / 1000).toFixed(1)} s later` : d < 5_400_000 ? `${Math.round(d / 60_000)} min later` : `${(d / 3_600_000).toFixed(1)} h later`
}

/** What happened, in one or two sentences, from the recorded result. */
function outcome(a: ActionView, now = Date.now(), paused = false): string {
  const r = a.result, i = a.instrument
  const moved = fmt.money(n(r.movedPaise), true)
  if (a.state === 'blocked') return `QED refused this before anything was sent: ${a.error ?? 'a check failed'} No money moved.`
  // a payment on hold: approved, its money set aside, waiting until its terms' time (server/new-payee.ts)
  if (a.state === 'held') return `You approved it, and it waits before it is sent. ${heldWords(a, now, paused)}`
  if (a.kind === 'payment') {
    if (a.state === 'cancelled' && a.params.hold) return 'Cancelled by you while it waited. Nothing was sent, and the money set aside for it is free again.'
    const rail = String(r.rail ?? '')
    // a contribution to a goal is set aside inside the household's own bank: nobody is paid (server/setaside.ts)
    if (a.state === 'done' && a.params.purpose === 'goal') return `${moved} was set aside for ${a.params.payeeName ?? 'your goal'}, inside your bank. No instruction can spend it; only you can release it, with your passkey.`
    if (a.state === 'done') return `${moved} was paid to ${a.params.payeeName ?? 'the payee'}${rail ? ` ${rail === 'internal' ? 'inside your bank' : `by ${rail.toUpperCase()}`}` : ''}.${r.railState === 'reversed' ? ' The rail reversed it afterwards and the money came back.' : ''}`
    if (a.state === 'failed') return `The payment did not go through: ${a.error ?? 'the rail gave no reason.'} The money was returned to your bank account.`
    if (a.state === 'cancelled') return 'Cancelled before it was sent. No money moved.'
    return inProgressLine(a, now, paused)
  }
  if (!i) return stateWord(a.state)
  const fund = i.kind === 'mutual_fund', buy = a.params.side === 'buy', filled = n(r.filledQty) > 0
  if (!TERMINAL.has(a.state)) { const stands = standsUntilLine(a); return `${filled ? `${qtyText(r.filledQty, i.baseScale)} ${fund ? 'units' : i.baseAsset} done so far. ` : ''}${inProgressLine(a)}${stands ? ` ${stands}.` : ''}` }
  const back = fund && buy ? ' The money was returned to your bank account.' : ''
  if (!filled && a.state === 'expired') return `${expiredLine(a) ?? 'It expired'}. Nothing was ${buy ? 'bought' : 'sold'}.${back}`
  if (!filled) return a.state === 'cancelled' ? `Cancelled with nothing done.${a.error ? ` ${a.error}` : ''}${back}` : `Nothing was ${buy ? 'bought' : 'sold'}: ${a.error ?? stateWord(a.state).toLowerCase()}${back}`
  const avg = n(r.filledAmount) / 100 / (n(r.filledQty) / 10 ** i.baseScale)
  const what = `${qtyText(r.filledQty, i.baseScale)} ${fund ? `units of ${i.name}` : i.baseAsset}`
  const costs = [n(r.fees) ? `${fund ? 'an exit load of' : 'a venue fee of'} ${fmt.money(n(r.fees), true)}` : '', n(r.taxes) ? `${fund ? 'stamp duty of' : 'tax deducted at source of'} ${fmt.money(n(r.taxes), true)}` : ''].filter(Boolean).join(' and ')
  const part = a.state === 'done' ? '' : a.result.expired === true ? ` ${expiredLine(a) ?? ''}.` : ` Only part was done; the rest was ${a.state === 'expired' ? 'left to lapse' : 'cancelled'}${a.error ? ` (${a.error.replace(/\.$/, '')})` : ''}.`
  const at = `at ${fund ? 'a NAV' : 'an average'} of ${rupee(String(avg), fund ? 4 : 2)}${costs ? `, with ${costs}` : ''}`
  return buy ? `Bought ${what} ${at}. ${moved} left your bank account.${part}`
    : `${fund ? 'Redeemed' : 'Sold'} ${what} ${at}. ${moved} ${fund && r.payoutAt ? `reaches your bank account ${fmt.dayTime(n(r.payoutAt))}` : 'reached your bank account'}.${part}`
}

/**
 * What is not known, or only partly done, said as such above everything else: a rail that has not answered, a part
 * fill, a venue record that differs from the ledger. Null when the outcome is plain.
 */
export function standing(a: Pick<ActionView, 'kind' | 'state' | 'reconState' | 'result'>, now = Date.now()): { tone: 'wait' | 'void'; title: string; text: string } | null {
  if (needsAttention(a.state, a.reconState)) return { tone: 'void', title: 'Needs attention', text: 'The venue\'s own record differs from your ledger. What it shows and what the ledger shows are under "Every stage", at the comparison.' }
  // a payment the rail has not answered: by when it answers, and what QED does if it does not (R12 task comparison, gap 11)
  const by = railAnswerBy(a, now)
  if (a.kind === 'payment' && a.result.railState === 'unknown') return { tone: 'wait', title: 'Not known yet', text: `The rail took the payment and has not said what happened to it. It is neither done nor failed until it does.${by ? ` ${by} ${IF_NO_ANSWER}` : ''}` }
  if (by) return { tone: 'wait', title: 'Pending', text: `The rail has the payment and has not answered yet. ${by} ${IF_NO_ANSWER}` }
  if (a.state === 'partial') return { tone: 'wait', title: 'Partly completed', text: 'Only part of what was asked was done; what was done stays done, and the rest did not happen.' }
  return null
}

function Step({ title, at, after, tone, children }: { title: string; at?: number | null | undefined; after?: string; tone?: 'todo' | 'bad'; children?: ReactNode }) {
  return (
    <li className={tone ?? ''}>
      <div><strong>{title}</strong></div>
      {at ? <div className="t">{fmt.full(at)}{after ? `, ${after}` : ''}</div> : null}
      {children ? <div className="ac-step-says">{children}</div> : null}
    </li>
  )
}
/** A check's reason in plain words: the approved document's fingerprint is kept under References, not in the sentence. */
export const plainReason = (t: string): string => t.replace(/\bdocument [0-9a-f]{8,}…?/g, 'the document you approved')
function Checks({ checks, plain = false }: { checks: Check[]; plain?: boolean }) {
  // the checks that failed first, then those that passed, each in the order recorded
  const ordered = [...checks.filter((c) => !c.ok), ...checks.filter((c) => c.ok)]
  return (
    <ul className="ac-checks">
      {ordered.map((c, i) => (
        <li key={i} className={c.ok ? 'pass' : 'fail'}>
          <span className="mark" aria-hidden="true">{c.ok ? <Tick /> : <X />}</span>
          <span><span className="sr">{c.ok ? 'Passed: ' : 'Failed: '}</span><strong>{checkLabel(c.name)}.</strong> <span className="muted">{plain ? plainReason(c.detail) : c.detail}</span></span>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------------------------------------ the bound

/** Rupee amounts as written in a check's words ("₹1,23,456.78"), in paise, in the order written. */
export const rupeesIn = (t: string): number[] => [...t.matchAll(/₹([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, '')) * 100))
/** A limit the engine checked, with what was used before, this action's size and the limit itself, all in paise. */
export interface Bound { per: 'run' | 'day' | 'month'; used: number; size: number; limit: number; ok: boolean }
/**
 * The limits an action was checked against, read from the checks' own words: "₹X used this month plus ₹S against ₹L",
 * "₹X used today plus ₹S against ₹L", "₹S against ₹L per run". A check whose words do not have that form is left out
 * (the check itself is still listed with its words).
 */
export function boundsOf(checks: Check[]): Bound[] {
  const out: Bound[] = []
  for (const [name, per] of [['within-month-limit', 'month'], ['within-day-limit', 'day'], ['within-run-limit', 'run']] as const) {
    const c = checks.find((x) => x.name === name)
    if (!c) continue
    const v = rupeesIn(c.detail)
    if (per === 'run' && v.length === 2) out.push({ per, used: 0, size: v[0]!, limit: v[1]!, ok: c.ok })
    else if (per !== 'run' && v.length === 3) out.push({ per, used: v[0]!, size: v[1]!, limit: v[2]!, ok: c.ok })
  }
  return out
}
const PER: Record<Bound['per'], string> = { month: 'This month', day: 'Today', run: 'One run' }

/** One limit as the bound: used before, this action, what is left, and the bracket at the limit. */
function BoundRow({ b, went }: { b: Bound; went: boolean }) {
  const after = b.used + b.size, over = Math.max(0, after - b.limit), scale = Math.max(b.limit, after, 1)
  const pc = (v: number) => `${(v / scale) * 100}%`
  const this_ = went ? 'for this' : 'asked for this, which did not go ahead,'
  const label = `${PER[b.per]}: ${b.used ? `${fmt.money(b.used, true)} used before and ` : ''}${fmt.money(b.size, true)} ${this_} against a limit of ${fmt.money(b.limit, true)}. ${over ? `${fmt.money(over, true)} over the limit.` : went ? `${fmt.money(b.limit - after, true)} left.` : `Within the limit; ${fmt.money(b.limit - b.used, true)} is still left, as nothing was used.`}`
  return (
    <div className={`ac-bound ${over ? 'over' : ''}`}>
      <p className="ac-bound-k">{PER[b.per]}</p>
      <div className="ac-bound-bar" role="img" aria-label={label}>
        {b.used ? <span className="used" style={{ width: pc(Math.min(b.used, scale)) }} /> : null}
        <span className={`this ${went ? '' : 'asked'}`} style={{ width: pc(Math.min(b.size, Math.max(0, b.limit - b.used))) }} />
        {over ? <span className="over" style={{ width: pc(over) }} /> : null}
        <span className="bracket" style={{ width: pc(b.limit) }} />
      </div>
      <p className="ac-bound-sum" aria-hidden="true">{b.used ? <><b>{fmt.money(b.used, true)}</b> before + </> : null}<b>{fmt.money(b.size, true)}</b> {went ? 'this' : 'asked'}{b.used ? <> = <b>{fmt.money(after, true)}</b></> : null} of <b>{fmt.money(b.limit, true)}</b>; {over ? <span className="void">{fmt.money(over, true)} over</span> : went ? <>{fmt.money(b.limit - after, true)} left</> : <>within it; nothing was used, so {fmt.money(b.limit - b.used, true)} is still left</>}</p>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ fills

interface Fill { id: string; executedAt: number; navDate: string | null; qty: string; price: string; amount: string; fee: string; tax: string; cashAt: number | null; evidence: { snapshotId: string | null; provider: string | null; sourceTs: number | null; receivedAt: number | null; ageMsAtExecution: number | null } }
interface ReceiptBody {
  what?: string; outcome?: string; reason?: string | null; origin?: string
  program?: { id: string; title: string; kind: string; version: number; contentHash: string | null; occurrence: string; runId: string } | null
  approval?: { id: string; documentHash: string; method: string | null; confirmedAt: number | null } | null
  decision?: { decidedAt: number | null; checks: Check[] }
  venue?: { name?: string; clientRef?: string; state?: string; rejectReason?: string | null; fills?: Fill[]; rail?: string; reference?: string | null; reason?: string | null }
  ledgerEntries?: number[]; reconciliation?: { state: string; breaks: string[]; checkedAt: number }
  times?: Record<string, number>; economicId?: string; params?: Record<string, unknown>
  instrument?: { id: string; name: string; unit: string; scale: number }
  receipt?: { id: string; seq: number; kind: string; subject: string; issuedAt: number; execution: string }
}

/** A NAV's day as the rest of the app writes it ("Wed 25 Nov"; the year when it is not this year's), never a database's date. */
const navDay = (iso: string | null | undefined): string | null => (iso ? dayText(iso, istDay(Date.now())) : null)

function evidenceText(f: Fill, fund: boolean): string {
  const e = f.evidence
  if (fund) return `The NAV for ${navDay(f.navDate) ?? 'the applicable day'}, as published${e.provider ? ` by ${sourceName(e.provider)}` : ''}${e.receivedAt ? `, received ${fmt.dayTime(e.receivedAt)}` : ''}.`
  if (!e.snapshotId) return 'No price record was kept for this fill.'
  return `${e.provider ? `${sourceName(e.provider)}'s` : 'The venue\'s'} order book${e.ageMsAtExecution !== null ? `, ${e.ageMsAtExecution} ms old when used` : ''}${e.receivedAt ? `; received ${fmt.time(e.receivedAt, true)}` : ''}${e.sourceTs ? `, the source's own time ${fmt.time(e.sourceTs, true)}` : '; the source gives no time of its own'}.${decisionWords(e)}`
}

function Fills({ fills, a }: { fills: Fill[]; a: { instrument: ActionView['instrument'] } }) {
  const scale = a.instrument?.baseScale ?? 0, fund = a.instrument?.kind === 'mutual_fund'
  const narrow = useMedia('(max-width: 759px)')
  // on a phone each fill is its figures one under another, so that no amount has to be scrolled to
  if (narrow) return (
    <ul className="ac-fills">{fills.map((f) => (
      <li key={f.id}>
        <p className="ac-fill-when">{fmt.dayTime(f.executedAt)}</p>
        <dl>
          <div><dt>{fund ? 'Units' : 'Quantity'}</dt><dd>{qtyText(f.qty, scale)}</dd></div>
          <div><dt>{fund ? 'NAV' : 'Price'}</dt><dd>{rupee(f.price, fund ? 4 : 2)}</dd></div>
          <div><dt>Value</dt><dd>{fmt.money(n(f.amount), true)}</dd></div>
          <div><dt>{fund ? 'Exit load' : 'Fee'}</dt><dd>{fmt.money(n(f.fee), true)}</dd></div>
          <div><dt>{fund ? 'Stamp duty' : 'Tax'}</dt><dd>{fmt.money(n(f.tax), true)}</dd></div>
        </dl>
        <p className="small muted">{evidenceText(f, fund)}</p>
      </li>
    ))}</ul>
  )
  return (
    <div className="ac-scroll" tabIndex={0} role="region" aria-label="Fills; scroll sideways on a narrow screen">
      <table className="ledger flush">
        <thead><tr><th scope="col">When</th><th scope="col" className="num">{fund ? 'Units' : 'Quantity'}</th><th scope="col" className="num">{fund ? 'NAV' : 'Price'}</th><th scope="col" className="num">Value</th><th scope="col" className="num">{fund ? 'Exit load' : 'Fee'}</th><th scope="col" className="num">{fund ? 'Stamp duty' : 'Tax'}</th></tr></thead>
        <tbody>
          {fills.map((f) => (
            <tr key={f.id}>
              <td className="date">{fmt.dayTime(f.executedAt)}<span className="sub muted ac-fill-source">{evidenceText(f, fund)}</span></td>
              <td className="num">{qtyText(f.qty, scale)}</td><td className="num">{rupee(f.price, fund ? 4 : 2)}</td><td className="num">{fmt.money(n(f.amount), true)}</td><td className="num">{fmt.money(n(f.fee), true)}</td><td className="num">{fmt.money(n(f.tax), true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecordSkeleton() {
  return (
    <div className="rec" aria-busy="true">
      <Crumb to="/activity">All activity</Crumb>
      <p className="loading-line">Opening the record…</p>
      <span className="skel ac-skel-doc" />
    </div>
  )
}

/** The whole receipt chain as the server last verified it (its own count and whether every link holds). */
type Chain = { ok: boolean; count: number; brokenAt: number | null; head: string }
/** A receipt's place in the chain, in words: "No. 2 of 3 in your chain; it follows no. 1, and the chain is intact". */
export function chainPlace(seq: number, chain: Chain | null, named = true): string {
  const of = chain ? ` of ${chain.count}` : ''
  const follows = seq > 1 ? `it follows no. ${seq - 1}` : 'it is the first in the chain'
  const intact = !chain ? '' : chain.ok ? ', and the chain is intact' : `, and the chain is broken at no. ${chain.brokenAt}`
  return `${named ? 'No. ' : ''}${seq}${of} in your chain; ${follows}${intact}`
}

export function RecordScreen({ id }: { id: string }) {
  const { session } = useSession()
  const presentation = !!session.presentation, paused = !!session.stop
  const now = useNow(15_000)
  const { data: a, error, reload } = useData<RecordView>(`/api/actions/${id}`, ['action', 'receipt', 'dispute', 'recon', 'run'])
  const rcp = useData<Receipt>(a?.receiptId ? `/api/receipts/${a.receiptId}` : null)
  const chain = useData<{ chain: Chain }>(a?.receiptId ? '/api/receipts?limit=1' : null, ['receipt'])
  // the run's evidence case, linked only when the evidence list has it
  const cases = useData<{ cases: CaseSummary[] }>(a?.runId ? '/api/evidence/cases' : null, ['action', 'run'])
  const [reason, setReason] = useState('')
  const [disputing, setDisputing] = useState(false)
  const cancel = useAction(async () => { await api('POST', `/api/actions/${id}/cancel`); reload() })
  const dispute = useAction(async () => { await api('POST', `/api/actions/${id}/dispute`, { reason }); setDisputing(false); setReason(''); reload() })
  if (!a) return error ? <div className="rec"><Crumb to="/activity">All activity</Crumb><div className="ac-problem"><Problem error={error} /><p><Link to="/activity">Back to Activity</Link></p></div></div> : <RecordSkeleton />

  const t = a.times, done = TERMINAL.has(a.state)
  const body = (rcp.data?.body ?? {}) as ReceiptBody
  const fills = body.venue?.fills ?? []
  const checks = a.decision.checks ?? []
  const failed = checks.filter((c) => !c.ok).length
  const fund = a.instrument?.kind === 'mutual_fund'
  const held = a.state === 'held'
  const canCancel = !done && (a.state === 'planned' || a.state === 'awaiting_approval' || held || (a.kind === 'order' && !fund))
  const openDispute = a.disputes.find((d) => d.state === 'open')
  const sentLabel = a.kind === 'payment' ? 'payment' : 'order'
  const attention = needsAttention(a.state, a.reconState)
  const known = standing(a, now)
  const bounds = boundsOf(checks)
  const caseId = a.runId ? `run.${a.runId}` : null
  const hasCase = !!caseId && !!cases.data?.cases.some((c) => c.id === caseId)

  // the figure: what moved and which way, or what was asked for when nothing moved
  const moved = n(a.result.movedPaise), asked = moved || n(a.params.amount)
  const outward = a.kind === 'payment' || a.params.side === 'buy'
  const finished = a.state === 'done' || a.state === 'partial'
  const figure = finished && moved ? `${outward ? MINUS : '+'}${fmt.money(moved, true)}` : asked ? fmt.money(asked, true) : null
  const refunded = a.disputes.find((d) => d.state === 'resolved_refund')
  const figureSays = finished && moved ? (outward ? (refunded ? `Left your bank account; refunded on your dispute ${fmt.dayTime(refunded.updated_at)}` : 'Left your bank account') : fund && a.result.payoutAt ? `Reaches your bank account ${fmt.dayTime(n(a.result.payoutAt))}` : 'Reached your bank account')
    : !done ? (a.state === 'awaiting_approval' ? 'Waiting for your approval: nothing has moved' : held ? 'Approved and set aside: it leaves your bank when its wait ends' : 'Asked for; not settled yet')
    : a.state === 'failed' && (a.kind === 'payment' || (fund && outward)) ? 'Asked for; the money was returned to your bank account' : 'Asked for; nothing moved'
  const tone = a.state === 'done' && !attention ? 'ok' : a.state === 'blocked' || a.state === 'failed' || a.state === 'rejected' || attention ? 'void' : done ? 'plain' : 'hold'
  const venueRecord = a.reconState === 'reconciled' ? 'Agrees with your ledger' : a.reconState === 'break' ? 'Differs from your ledger; the comparison is in the stages below' : a.reconState === 'open' ? 'Not compared yet' : 'Nothing reached a venue, so there is nothing to compare'
  const program = a.program ? <Link to={`/instructions/${a.program.id}`}>{a.program.title}</Link> : 'one of your instructions'

  const asks = a.kind === 'payment' && a.params.purpose === 'goal'
    ? <>Set aside <b>{fmt.money(n(a.params.amount), true)}</b> for <b>{a.params.payeeName}</b>, from your bank account into its set-aside <span className="faint">({a.params.payeeHandle})</span>, inside your bank.</>
    : a.kind === 'payment'
    ? <>Pay <b>{fmt.money(n(a.params.amount), true)}</b>{n(a.params.charge) ? ` plus a charge of ${fmt.money(n(a.params.charge), true)}` : ''} to <b>{a.params.payeeName}</b> <span className="faint">({a.params.payeeHandle})</span>{a.params.memo ? <>, “{a.params.memo}”</> : null}{a.result.rail ? `, ${String(a.result.rail) === 'internal' ? 'inside your bank' : `by ${String(a.result.rail).toUpperCase()}`}` : ''}.</>
    : <>{a.params.side === 'sell' ? (fund ? 'Redeem' : 'Sell') : (fund ? 'Invest in' : 'Buy')} <b>{a.instrument?.name}</b>: <b>{a.params.amount ? fmt.money(n(a.params.amount), true) : a.params.qty ? `${qtyText(a.params.qty, a.instrument?.baseScale ?? 0)} ${fund ? 'units' : a.instrument?.baseAsset ?? ''}` : 'everything free to sell'}</b>, {a.params.type === 'nav' ? 'at the applicable NAV' : a.params.type === 'limit' ? `only at ${rupee(String(a.params.limitPrice))} or better` : a.params.type === 'stop' ? `when buyers offer ${rupee(String(a.params.stopPrice))} or less` : 'at once, at the prices on the book'}{a.params.type !== 'nav' && a.params.type !== 'limit' && typeof a.params.maxSlippageBps === 'number' ? `, at worst ${(a.params.maxSlippageBps / 100).toFixed(2)}% from the best price at that moment` : ''}.</>

  return (
    <div className="rec">
      <Crumb to="/activity">All activity</Crumb>
      <header className="ac-doc-head">
        <div className="ac-doc-title">
          <h1>{a.what}</h1>
          <p>{a.origin === 'owner' ? <span className="by-you">By your hand.</span> : a.origin === 'commerce' ? <span className="by-qed">By QED, within your commerce mandate, from a simulated service.</span> : <span className="by-qed">By QED, under {program}.</span>} On paper: no real money moved.</p>
        </div>
        <div className="ac-tags"><StateStamp state={a.state} recon={a.reconState} /></div>
      </header>

      <div className="ac-pair ac-rec-top">
        <article className={`panel ac-hero tone-${tone}`} aria-labelledby="rec-h">
          <h2 id="rec-h" className="sr">What moved, and how it ended</h2>
          {figure ? <p className={`ac-hero-fig ${finished && moved && !outward ? 'in' : ''} ${finished && moved ? '' : 'unmoved'}`} data-resolve="">{figure}</p> : null}
          <p className="ac-hero-says">{figureSays}</p>
          <p className="ac-hero-outcome">{outcome(a, now, paused)}{refunded ? ' It was refunded on your dispute: the money came back to your bank account.' : ''}</p>
          {held && a.params.hold ? <p className="ac-hold-why">{a.params.hold.why}</p> : null}
          {awaitsRepeat(a) ? <RepeatHeld a={a} onChanged={reload} /> : null}
          {known ? <Note tone={known.tone} title={known.title}>{known.text}</Note> : null}
        </article>

        <aside className="panel ac-seal-card" aria-labelledby="seal-h">
          <h2 id="seal-h" className="sr">Its receipt, and where it can be checked</h2>
          {a.receiptId
            ? <div className="ac-sealed"><Seal size="xl" /><span><strong>Receipt kept</strong><Link to={`/receipts/${a.receiptId}`}>Receipt no. {rcp.data?.seq ?? ''}</Link>{rcp.data ? <small>{chainPlace(rcp.data.seq, chain.data?.chain ?? null)}</small> : null}</span></div>
            : <div className="ac-sealed none"><span><strong>No receipt yet</strong><small>One is issued when it finishes, whatever the outcome</small></span></div>}
          <dl className="ac-seal-facts">
            <div><dt>Venue's record</dt><dd className={a.reconState === 'break' ? 'void' : ''}>{venueRecord}</dd></div>
            <div><dt>Checks</dt><dd className={failed ? 'void' : ''}>{checks.length ? (failed ? `Refused on ${failed} of ${checks.length}` : `All ${checks.length} passed`) : done ? 'None recorded' : 'Made at the moment it is sent'}</dd></div>
          </dl>
          {hasCase ? <Link className="btn sm ac-case-link" to={`/evidence/${encodeURIComponent(caseId!)}`}><FileSearch aria-hidden="true" />Its evidence case</Link> : null}
        </aside>
      </div>

      <section className="panel ac-sheet" aria-labelledby="sheet-h">
        <div className="panel-head"><h2 id="sheet-h">What was asked, and under what</h2><p>Each as recorded, with when it was decided</p></div>
        <dl className="ac-rows">
          <div><dt>Asked</dt><dd>{asks}</dd><dd className="ac-rows-when">{fmt.dayTime(a.createdAt)}</dd></div>
          <div><dt>By</dt><dd>{a.origin === 'owner' ? 'You, by hand from this interface' : a.origin === 'commerce' ? 'QED, buying from a simulated service within the commerce mandate you signed' : <>QED, under {program}{a.program?.version ? `, version ${a.program.version}` : ''}{a.run ? `, for the run due ${fmt.dayTime(a.run.dueAt)}` : ''}</>}</dd></div>
          <div><dt>Under which bound</dt><dd>
            {a.approval?.confirmedAt ? `${a.approval.purpose === 'run' ? 'You approved this run' : 'Exactly what you approved, and nothing else'}, ${METHOD[a.approval.method ?? ''] ?? 'by you'}.` : a.program ? <>The instruction you signed{a.program.version ? `, version ${a.program.version}` : ''}: it runs without asking each time, inside the limits written on it.</> : <span className="void">No approval on record: it cannot be sent.</span>}
            {bounds.length ? <div className="ac-bounds">{bounds.map((b) => <BoundRow key={b.per} b={b} went={!NOT_GONE.has(a.state)} />)}</div> : null}
          </dd><dd className="ac-rows-when">{a.approval?.confirmedAt ? fmt.dayTime(a.approval.confirmedAt) : a.program?.signedAt ? `Signed ${fmt.dayTime(a.program.signedAt)}` : ''}</dd></div>
          <div><dt>Checks</dt><dd>{checks.length ? (failed ? <span className="void">Refused on {failed} of {checks.length}; the one that refused it is first in the list below</span> : `All ${checks.length} passed, each listed below with its figures`) : done ? 'None recorded' : 'Made at the moment it is sent'}</dd><dd className="ac-rows-when">{a.decision.decidedAt ? fmt.time(a.decision.decidedAt, true) : ''}</dd></div>
          <div><dt>Venue's record</dt><dd className={a.reconState === 'break' ? 'void' : ''}>{venueRecord}</dd><dd className="ac-rows-when">{t.reconciled ? fmt.time(t.reconciled, true) : ''}</dd></div>
          <div><dt>Receipt</dt><dd>{a.receiptId ? <><Link to={`/receipts/${a.receiptId}`}>Receipt no. {rcp.data?.seq ?? ''}</Link>{rcp.data ? `, ${chainPlace(rcp.data.seq, chain.data?.chain ?? null, false)}.` : ''}</> : 'None yet: one is issued when it finishes, whatever the outcome.'}</dd><dd className="ac-rows-when">{rcp.data ? fmt.time(rcp.data.ts, true) : ''}</dd></div>
        </dl>
      </section>

      <div className={`ac-pair even ${checks.length ? '' : 'one'}`}>
        {checks.length ? (
          <section className="panel ac-checks-panel" aria-labelledby="chk-h">
            <div className="panel-head"><h2 id="chk-h">{failed ? 'The checks, and what refused it' : 'The checks it passed'}</h2><p>Each as recorded the moment it was decided</p></div>
            <Checks checks={checks} plain />
          </section>
        ) : null}

        <section className="panel ac-stages" aria-labelledby="path-h">
          <div className="panel-head"><h2 id="path-h">Every stage, with its time</h2><p>This computer's clock, in India time</p></div>
          <ol className="timeline ac-timeline">
            <Step title={a.origin === 'owner' ? 'You asked for it' : 'QED started it'} at={a.createdAt}>
              {a.origin === 'owner' ? 'By hand, from this interface.' : a.origin === 'commerce' ? <>Within the commerce mandate you signed, checked against it again when it was sent. <Link to="/pay">Spend</Link> shows the purchase and its receipt.</> : <>Under your instruction {a.program ? <Link to={`/instructions/${a.program.id}`}>{a.program.title}</Link> : ''}{a.program?.version ? `, version ${a.program.version}` : ''}{a.run ? `, for the run due ${fmt.dayTime(a.run.dueAt)}` : ''}.</>}
            </Step>

            {a.approval?.confirmedAt
              ? <Step title={a.approval.purpose === 'run' ? 'You approved this run' : 'You approved exactly this'} at={a.approval.confirmedAt}>Signed {METHOD[a.approval.method ?? ''] ?? 'by you'}. What ran was built from the document you approved; its fingerprint is under References and fingerprints.</Step>
              : a.program ? <Step title="Authorised by the instruction you signed" at={a.program.signedAt}>Version {a.program.version}. It runs without asking each time, inside the limits written on it.</Step>
                : <Step title="No approval on record" tone="bad">This action has no approval attached. It cannot be sent.</Step>}

            {a.params.hold && t.held ? <Step title="Set aside to wait" at={t.held}>Its money was set aside in your bank, to be sent at {fmt.dayTime(a.params.hold.until)}, not before, as the terms you approved said.</Step> : null}
            {a.params.hold && t.released ? <Step title="Its wait ended" at={t.released} after={later(t.held, t.released)}>{t.released - a.params.hold.until > 60_000 ? 'QED was paused or not running when the wait ended, so it was released when QED next ran.' : 'Released for sending, at the time its terms gave.'}</Step>
              : held && a.params.hold ? <Step title={`Waits until ${fmt.dayTime(a.params.hold.until)}`} tone="todo">{heldWords(a, now, paused)}</Step> : null}

            {a.decision.decidedAt
              ? <Step title={failed ? `Checked, and refused on ${failed} point${failed === 1 ? '' : 's'}` : `Checked on ${checks.length} points, all passed`} at={a.decision.decidedAt} after={later(a.approval?.confirmedAt && a.origin === 'owner' ? a.approval.confirmedAt : a.createdAt, a.decision.decidedAt)} tone={failed ? 'bad' : undefined}>{failed ? 'The check that refused it is listed with the checks, with its figures.' : 'Each check is listed with the checks, with its figures.'}</Step>
              : !done ? <Step title="Not checked yet" tone="todo">The engine checks it against your limits, your balance and current prices at the moment it is sent, not before.</Step> : null}

            {fund
              // a fund order's own states with the registrar's times: with the registrar, money received, units allotted
              // (a redemption: redeemed, then paid), each still to come said as such (R12 task comparison, T4-d)
              ? fundStages(a, Date.now()).map((s, i, all) => {
                  const at = s.step === 'paid' && s.done ? fills[0]?.cashAt ?? t.finished ?? null : s.at
                  if (s.step === 'registrar') return s.done
                    ? <Step key={s.step} title={s.title} at={at} after={later(a.decision.decidedAt, at)}>With {(presentation ? VENUE_PRESENTATION : VENUE)[a.venue] ?? a.venue}, under its own reference. {s.says} Sending it again with the same reference cannot create a second order.</Step>
                    : !done ? <Step key={s.step} title="Not sent yet" tone="todo" /> : null
                  if (s.done) return <Step key={s.step} title={s.title} at={at} after={later(all[i - 1]?.at ?? t.submitted, at)}>{s.says || null}</Step>
                  return !done && all[0]!.done ? <Step key={s.step} title={s.title} tone="todo">{s.says}</Step> : null
                })
              : <>
                {t.submitted
                  ? <Step title="Sent" at={t.submitted} after={later(a.decision.decidedAt, t.submitted)}>To {(presentation ? VENUE_PRESENTATION : VENUE)[a.venue] ?? a.venue}, with its own reference. Sending it again with the same reference cannot create a second {sentLabel}.</Step>
                  : !done ? <Step title="Not sent yet" tone="todo" /> : null}

                {t.executed
                  ? <Step title={a.kind === 'payment' ? 'Settled by the rail' : fills.length > 1 || n(a.result.fills) > 1 ? `Executed in ${n(a.result.fills) || fills.length} parts` : 'Executed'} at={t.executed} after={later(t.submitted, t.executed)}>
                      {a.kind === 'payment' ? 'The rail gave it a reference of its own, kept under References and fingerprints.' : 'Against the order book as it stood at that moment. The prices used are listed with the fills.'}
                    </Step>
                  : !done && t.submitted ? <Step title={a.kind === 'payment' ? 'Not settled yet' : 'Not executed yet'} tone="todo">{inProgressLine(a)}</Step> : null}
              </>}

            {t.finished ? <Step title={attention ? `Finished, but it needs attention: the venue's record differs` : `Finished: ${stateWord(a.state).toLowerCase()}`} at={t.finished} after={later(t.executed ?? t.submitted ?? a.decision.decidedAt, t.finished)} tone={a.state === 'failed' || a.state === 'rejected' ? 'bad' : undefined}>{a.error ?? null}</Step> : null}

            {t.reconciled
              ? <Step title={a.reconState === 'reconciled' ? 'Compared with the venue\'s own record: they agree' : a.reconState === 'break' ? 'Compared with the venue\'s own record: they do not agree' : 'Nothing to compare'} at={t.reconciled} tone={a.reconState === 'break' ? 'bad' : undefined}>
                  {a.reconState === 'reconciled' ? `Every fill and every rupee the venue shows for this ${sentLabel} is in your ledger, and nothing is left reserved.` : a.reconState === 'break' ? (body.reconciliation?.breaks ?? []).join(' ') : 'Nothing reached a venue, so there is no venue record to compare with.'}
                </Step>
              : done ? <Step title="Not yet compared with the venue's record" tone="todo">The engine does this within a few seconds of the finish.</Step> : null}

            {a.receiptId
              ? <Step title="Receipt issued" at={rcp.data?.ts}><Link to={`/receipts/${a.receiptId}`}>Receipt no. {rcp.data?.seq ?? ''}</Link>. It is chained to the receipt before it, so a later change to either would show.</Step>
              : <Step title="No receipt yet" tone="todo">One is issued when it finishes, whatever the outcome.</Step>}
          </ol>
        </section>
      </div>

      {fills.length ? (
        <section className="panel ac-fills-panel" aria-labelledby="fills-h">
          <div className="panel-head"><h2 id="fills-h">{fund ? 'Allotment' : 'Fills'} and the price each used</h2></div>
          <Fills fills={fills} a={a} />
        </section>
      ) : null}

      <details className="panel ac-refs">
        <summary>References and fingerprints</summary>
        <dl className="kv small">
          <dt>Reference</dt><dd className="code">{a.economicId}</dd>
          <dt>Record</dt><dd className="code">{a.id}</dd>
          {a.approval ? <><dt>Approval</dt><dd><span className="code">{a.approval.id}</span>{a.approval.docHash ? <>; document <span className="code">{fmt.hash(a.approval.docHash)}</span></> : null}</dd></> : null}
          {a.program?.contentHash ? <><dt>Instruction</dt><dd>Version {a.program.version}, <span className="code">{fmt.hash(a.program.contentHash)}</span></dd></> : null}
          {a.run ? <><dt>Run</dt><dd><span className="code">{a.run.id}</span>, for {a.run.occurrence}</dd></> : null}
          {a.result.railReference ? <><dt>Rail reference</dt><dd className="code">{String(a.result.railReference)}</dd></> : null}
          {rcp.data ? <><dt>Receipt</dt><dd>No. {rcp.data.seq}, <span className="code">{fmt.hash(rcp.data.hash)}</span>; follows <span className="code">{fmt.hash(rcp.data.prev_hash)}</span></dd></> : null}
          {body.ledgerEntries?.length ? <><dt>Ledger</dt><dd>Entr{body.ledgerEntries.length === 1 ? 'y' : 'ies'} {body.ledgerEntries.join(', ')}</dd></> : null}
        </dl>
      </details>

      {!done ? (
        <section className="panel ac-stop" aria-labelledby="stop-h">
          <div><h2 id="stop-h">Stopping it</h2>
            <p className="small muted">{held && awaitsRepeat(a) ? 'Nothing has been sent. It waits for you: cancel it here, or confirm it above.' : held ? `Nothing has been sent. Until ${atTime(a.params.hold?.until ?? now, now)} you can cancel it, and the money set aside for it is free again; after that it goes to the rail and cannot be recalled.` : canCancel ? (n(a.result.filledQty) > 0 ? 'What has already been done stays done. Cancelling stops the rest.' : 'Nothing has been done yet. Cancelling releases anything reserved for it.') : a.kind === 'payment' ? 'A payment that has reached the rail cannot be recalled. If it settles wrongly you can dispute it here afterwards.' : 'A fund order cannot be withdrawn once it reaches the registrar. It executes at the applicable NAV.'}</p></div>
          {canCancel && !awaitsRepeat(a) ? <Btn tone="void" busy={cancel.busy} onClick={() => void cancel.run()}>{held ? 'Cancel this payment' : 'Cancel what is left'}</Btn> : null}
          <Problem error={cancel.error} />
        </section>
      ) : null}

      {a.kind === 'payment' && a.packReason ? (
        <section className="panel ac-pack" aria-labelledby="pack-h">
          <div className="panel-head"><h2 id="pack-h">A dispute pack for this payment</h2><p>{a.packReason === 'disputed' ? 'It is disputed.' : 'Its outcome is not certain.'} Everything QED holds about it, in one place, to hand to a bank or an ombudsman.</p></div>
          <Link className="btn fill" to={`/record/${a.id}/pack`}>Open the dispute pack</Link>
        </section>
      ) : null}

      {a.kind === 'payment' && (a.state === 'done' || a.disputes.length) ? (
        <section className="panel ac-disputes" aria-labelledby="dis-h">
          <div className="panel-head"><h2 id="dis-h">If this payment was wrong</h2><p>A payment that settled wrongly can be disputed; the dispute is kept with this record</p></div>
          {a.disputes.length ? <ul className="ac-dispute-list">{a.disputes.map((d) => (
            <li key={d.id} className={`ac-dispute ${d.state === 'open' ? 'open' : ''}`}>
              <h3>{d.state === 'open' ? 'Dispute open' : d.state === 'resolved_refund' ? 'Dispute settled: refunded' : 'Dispute settled: the payment stands'}</h3>
              <p className="small">You said: “{d.reason.replace(/[.\s]+$/, '')}”. Raised {fmt.dayTime(d.created_at)}.</p>
              <p className="small muted">{d.state === 'open' ? 'The paper review takes about a minute. There is no real payee to answer, so the outcome follows a stated rule: a payee whose address begins with “refund” returns the money; any other payment is upheld.' : `${d.resolution ?? ''} Settled ${fmt.dayTime(d.updated_at)}.`}</p>
            </li>
          ))}</ul> : null}
          {a.state === 'done' && !openDispute ? (disputing
            ? <form className="stack ac-dispute-form" onSubmit={(e) => { e.preventDefault(); void dispute.run() }}>
                <Field label="What went wrong" hint="One sentence. It is stored with the dispute." error={dispute.error?.fields.reason}>{(p) => <textarea {...p} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                {dispute.error && !dispute.error.fields.reason ? <Problem error={dispute.error} /> : null}
                <div className="row"><Btn tone="fill" type="submit" busy={dispute.busy}>Raise the dispute</Btn><Btn onClick={() => setDisputing(false)}>Cancel</Btn></div>
              </form>
            : <div className="ac-dispute-go">
                <p className="ac-dispute-k">How a dispute is decided, before you raise one</p>
                <dl className="ac-dispute-rule">
                  <div><dt>Who decides</dt><dd>QED's paper review, by a stated rule, as there is no real payee to answer: a payee whose address begins with “refund” returns the money; any other payment is upheld.</dd></div>
                  <div><dt>How long</dt><dd>About a minute after you raise it.</dd></div>
                  <div><dt>Meanwhile</dt><dd>The money stays with the payee. Nothing comes back unless the review returns it, and you are told either way.</dd></div>
                </dl>
                <div><Btn onClick={() => setDisputing(true)}>Dispute this payment</Btn></div>
              </div>) : null}
        </section>
      ) : null}
    </div>
  )
}

const OTHER: [string, string][] = [['client', 'Client'], ['counterparty', 'Counterparty'], ['resolution', 'Resolution'], ['rule', 'Rule applied'], ['foundBy', 'Found by'], ['evidenceHash', 'Evidence fingerprint'], ['ledgerEntry', 'Ledger entry']]
const TIME_WORD: [string, string][] = [['decided', 'Checked'], ['submitting', 'Sending began'], ['submitted', 'Sent'], ['executed', 'Executed'], ['finished', 'Finished'], ['reconciled', 'Compared with the venue']]

/** What an order cost against its reference, and whether the ledger moved exactly that (R7-096). */
interface Costs { reference: { kind: 'book' | 'nav'; price: number; mid: number | null; spreadBps: number | null; source: string | null; receivedAt: number | null; ageMsAtExecution: number | null; navDate: string | null }; averagePrice: number; slippageBps: number | null; fee: string; tax: string; deliveredQty: string; cashAccount: string; cashExpected: string; cashBooked: string; ledgerAgrees: boolean }
const price = (v: number): string => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** How the average price sat against its reference: worse or better by how much, or exactly at it. */
export function slippageWords(bps: number | null): string {
  if (bps === null) return ''
  if (bps === 0) return '; exactly at the reference'
  return `; ${Math.abs(bps / 100).toFixed(3)}% ${bps > 0 ? 'worse' : 'better'} than the reference`
}
function CostClauses({ c, unit, scale, buy }: { c: Costs; unit: string; scale: number; buy: boolean }) {
  const r = c.reference
  return <>
    <dt>Reference</dt><dd>{r.kind === 'nav' ? `The NAV ${price(r.price)} for ${navDay(r.navDate) ?? 'its day'}${r.source ? `, from ${sourceName(r.source)}` : ''}` : `The best ${buy ? 'ask' : 'bid'}, ${price(r.price)}, on ${r.source ? `${sourceName(r.source)}'s` : 'the'} order book it filled against${r.ageMsAtExecution !== null ? `, ${r.ageMsAtExecution} ms old when used` : ''}`}</dd>
    {r.spreadBps !== null ? <><dt>Spread then</dt><dd>{(r.spreadBps / 100).toFixed(3)}% between the best bid and ask</dd></> : null}
    <dt>Average price</dt><dd>{price(c.averagePrice)}{slippageWords(c.slippageBps)}</dd>
    <dt>Fee and tax</dt><dd>{fmt.money(Number(c.fee), true)} fee{Number(c.tax) > 0 ? `, ${fmt.money(Number(c.tax), true)} ${r.kind === 'nav' ? 'stamp duty' : 'tax deducted at source'}` : ''}</dd>
    <dt>Delivered</dt><dd>{(Number(c.deliveredQty) / 10 ** scale).toLocaleString('en-IN', { maximumFractionDigits: scale })} {unit}</dd>
    <dt>Ledger</dt><dd>{c.ledgerAgrees ? <>Agrees: it moved exactly {fmt.money(Math.abs(Number(c.cashBooked)), true)} {Number(c.cashBooked) < 0 ? 'out of' : 'into'} {c.cashAccount === 'bank' ? 'your bank account' : 'fund clearing'}, as these fills come to.</> : <Stamp tone="void">{`Differs: it moved ${c.cashBooked} paise; the fills come to ${c.cashExpected}`}</Stamp>}</dd>
  </>
}

export function ReceiptScreen({ id }: { id: string }) {
  const presentation = !!useSession().session.presentation
  const { data: r, error } = useData<Receipt>(`/api/receipts/${id}`)
  const chain = useData<{ chain: Chain }>(r ? '/api/receipts?limit=1' : null, ['receipt'])
  const isAction = !!r && r.subject.startsWith('act_')
  // Receipts issued before the instrument was written into them need the action to say what unit a quantity is in.
  const act = useData<RecordView>(isAction && r && !(r.body as ReceiptBody).instrument && (r.body as ReceiptBody).venue?.fills?.length ? `/api/actions/${r.subject}` : null)
  // Recompute the fingerprint here, in the browser, from what the server sent. This does not trust the server's own check.
  const matches = useMemo(() => (r ? sha256(`${r.prev_hash}\n${canonical(r.body)}`) === r.hash : null), [r])
  if (!r) return error ? <div className="rcp"><div className="ac-problem"><Problem error={error} /><p><Link to="/safeguards">Back to safeguards</Link></p></div></div> : <div className="rcp" aria-busy="true"><p className="loading-line">Opening the receipt…</p><span className="skel ac-skel-doc" /></div>
  const b = r.body as ReceiptBody & Record<string, unknown>
  const checks = b.decision?.checks ?? []
  const unit = b.instrument ?? (act.data?.instrument ? { scale: act.data.instrument.baseScale, unit: unitsWord(act.data.instrument.kind, act.data.instrument.baseAsset) } : null)
  const fundFill = unit?.unit === 'units'
  const [word, tone] = receiptOutcome(b)
  // the exact record that was fingerprinted, with the fingerprints it is checked against: anyone can recompute it offline
  const download = () => {
    const file = { format: 'qed-receipt-v1', howToCheck: 'hash is the SHA-256 of prev_hash, a newline, and the canonical JSON of body (keys sorted, no spaces; shared/sha256.ts).', id: r.id, seq: r.seq, ts: r.ts, kind: r.kind, subject: r.subject, prev_hash: r.prev_hash, hash: r.hash, body: r.body }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }))
    const el = document.createElement('a')
    el.href = url; el.download = `qed-receipt-${r.seq}.json`
    document.body.appendChild(el); el.click(); el.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="rcp">
      {isAction ? <Crumb to={`/record/${r.subject}`}>The full record of this action</Crumb> : <Crumb to="/safeguards">Safeguards</Crumb>}
      <header className="ac-doc-head ac-rcp-head">
        <div className="ac-doc-title">
          <h1>Receipt no. {r.seq}</h1>
          <p>Issued by QED when the action finished, and chained to the receipt before it. {chainPlace(r.seq, chain.data?.chain ?? null)}{chain.data ? ', as the server checked it just now' : ''}.</p>
        </div>
        <div className="ac-head-acts"><Btn onClick={download}><Download aria-hidden="true" />Download this receipt (JSON)</Btn></div>
      </header>

      <article className="instrument ac-slip" aria-label={`Receipt number ${r.seq}`}>
        <div className="i-head"><span>Issued by QED</span><span>{fmt.precise(r.ts)}</span></div>
        <div className="i-body">
          <p className="i-pay">{String(b.what ?? r.kind)}.</p>
          <dl className="clauses ac-clauses">
            <dt>Outcome</dt><dd><Stamp tone={tone}>{word}</Stamp>{b.reason ? <span className="ac-clause-more">{String(b.reason)}</span> : null}</dd>
            {typeof b.amount === 'string' ? <><dt>Amount</dt><dd>{fmt.money(n(b.amount), true)}</dd></> : null}
            {b.costs ? <CostClauses c={b.costs as Costs} unit={String((b.instrument as { unit?: string } | undefined)?.unit ?? '')} scale={Number((b.instrument as { scale?: number } | undefined)?.scale ?? 0)} buy={(b.params as { side?: string } | undefined)?.side === 'buy'} /> : null}
            {b.program ? <><dt>Under</dt><dd><Link to={`/instructions/${b.program.id}`}>{b.program.title}</Link>, version {b.program.version}. Fingerprint <span className="code">{fmt.hash(b.program.contentHash)}</span></dd></> : null}
            {b.approval ? <><dt>Approved</dt><dd>{b.approval.confirmedAt ? fmt.full(b.approval.confirmedAt) : 'Not confirmed'}, {METHOD[b.approval.method ?? ''] ?? 'by you'}. Document <span className="code">{fmt.hash(b.approval.documentHash)}</span></dd></> : null}
            {checks.length ? <><dt>Checks</dt><dd><Checks checks={checks} /></dd></> : null}
            {b.venue ? <><dt>Venue</dt><dd>{(presentation ? VENUE_PRESENTATION : VENUE)[b.venue.name ?? ''] ?? b.venue.name}. Its record says: {String(b.venue.state ?? 'nothing')}{b.venue.rail ? `, by ${b.venue.rail === 'internal' ? 'internal transfer' : b.venue.rail.toUpperCase()}` : ''}{b.venue.reference ? <>, reference <span className="code">{b.venue.reference}</span></> : null}{b.venue.reason ?? b.venue.rejectReason ? `. ${b.venue.reason ?? b.venue.rejectReason}` : ''}</dd></> : null}
            {b.venue?.fills?.length ? <><dt>Fills</dt><dd><ul className="ac-slip-fills">{b.venue.fills.map((f) => <li key={f.id}>{fmt.precise(f.executedAt)}: {unit ? `${qtyText(f.qty, unit.scale)} ${unit.unit}` : `${f.qty} of the venue's smallest unit`} at {rupee(f.price, fundFill ? 4 : 2)}, worth {fmt.money(n(f.amount), true)}; {fundFill ? 'exit load' : 'fee'} {fmt.money(n(f.fee), true)}, {fundFill ? 'stamp duty' : 'tax'} {fmt.money(n(f.tax), true)}. <span className="muted">{evidenceText(f, fundFill)}</span></li>)}</ul></dd></> : null}
            {b.ledgerEntries?.length ? <><dt>Ledger</dt><dd>Entr{b.ledgerEntries.length === 1 ? 'y' : 'ies'} {b.ledgerEntries.join(', ')} in your ledger.</dd></> : null}
            {b.reconciliation ? <><dt>Compared</dt><dd>{b.reconciliation.state === 'reconciled' ? 'The ledger and the venue\'s own record agree.' : b.reconciliation.state === 'break' ? `They do not agree: ${b.reconciliation.breaks.join(' ')}` : 'Nothing reached a venue, so there was nothing to compare.'} Checked {fmt.full(b.reconciliation.checkedAt)}.</dd></> : null}
            {b.times ? <><dt>Times</dt><dd><ul>{TIME_WORD.filter(([k]) => b.times![k]).map(([k, w]) => <li key={k}>{w}: {fmt.precise(b.times![k]!)}</li>)}</ul></dd></> : null}
            {OTHER.filter(([k]) => b[k] !== undefined && b[k] !== null).map(([k, w]) => <div key={k} className="ac-clause-pair"><dt>{w}</dt><dd className={k === 'evidenceHash' ? 'code' : ''}>{String(b[k])}</dd></div>)}
            {b.economicId ? <><dt>Reference</dt><dd className="code">{b.economicId}</dd></> : null}
          </dl>
          <div className="i-sign">
            <div className="small muted">Execution was on paper: no real money moved.</div>
            <div className="ac-verdict">{matches ? <Seal size="xl" /> : null}<Stamp big tone={matches ? 'ok' : 'void'} sub={matches ? 'checked in this browser' : 'do not rely on it'}>{matches ? 'Fingerprint matches' : 'Fingerprint does not match'}</Stamp></div>
          </div>
        </div>
        <div className="counterfoil">
          <div>This receipt <b className="code">{fmt.hash(r.hash)}</b></div>
          <div>Follows {r.seq > 1 ? `no. ${r.seq - 1}, ` : ''}<b className="code">{fmt.hash(r.prev_hash)}</b></div>
        </div>
      </article>

      <section className="panel ac-fingerprint" aria-labelledby="fp-h">
        <h2 id="fp-h">How this was checked</h2>
        <p className="small muted">The fingerprint is the SHA-256 of the previous receipt's fingerprint and the exact record below. This page recomputed it from the record as received and {matches ? 'got the same value' : 'got a different value, so the record or the fingerprint has changed since it was issued'}. Checking the whole chain from the first receipt is on the <Link to="/safeguards">safeguards page</Link>.</p>
        <details className="ac-raw">
          <summary>The exact record that was fingerprinted</summary>
          <pre className="doc">{JSON.stringify(r.body, null, 2)}</pre>
          <p className="small muted">Full fingerprints: this <span className="code">{r.hash}</span>; previous <span className="code">{r.prev_hash}</span>.</p>
        </details>
      </section>
    </div>
  )
}

