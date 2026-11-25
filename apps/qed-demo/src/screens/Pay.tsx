/**
 * Spend: paying someone by hand, as one connected journey on one surface (DESIGN.md "Meridian", M10): a checkout. The
 * steps on the left settle one figure each under a progress rail; the payment forms on the right as it is chosen (who,
 * how much, the route and when it arrives, what stays free after it), with the button that asks for the exact terms.
 * After the passkey signs, the same card follows the payment: sent to the rail, its answer, the receipt. It reads from the
 * top: where the money comes from (the bank account, or the on-chain wallet, which pays only the payee its mandate
 * names); who it goes to (a payee, a bill on record or one of your own accounts; a look-alike payee is named as one in
 * the server's own words, lookalike.ts); how much; the route and when it arrives (the rail rule, read from the same
 * terms register the server reads); and what stays free after it (the bank's free and kept money at true scale, with
 * this payment drawn where it comes from). The last step asks the server for the exact terms, and the approval sheet
 * opens over the journey with the same figures: what leaves the bank, the route, and the server's own sentence about
 * what must stay. The sheet is UX only: the server checks the passkey's signature over the document's fingerprint,
 * and checks the payment again when it is sent.
 * Below the journey: the bills on record, each with who pays it and what is left of that instruction's limit, and
 * every payment so far.
 */
import { ArrowDown, ArrowUpRight, CalendarClock, Check, CreditCard, Landmark, PiggyBank, Plus, Search, ShieldAlert, X } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { fraction } from '../../shared/fixed.ts'
import { lookalikeWarning } from '../../server/lookalike.ts'
import { isNameOutcome, nameCheckAdvice, nameCheckWords, type NameOutcome } from '../../server/name-check.ts'
import { api, type ApiError, fmt, useData, useLocation, useNow } from '../lib/core.ts'
import { homeCurrency } from '../../shared/home-money.ts'
import type { ActionPreview, ActionView, AuthorityEnvelope, Dispute, Home, ProgramSummary } from '../lib/types.ts'
import { ActionDoc, ApprovalSheet, Bound, type PendingApproval } from '../ui/instrument.tsx'
import { Btn, EmptyState, Field, Link, MoneyBar, MoneyInput, Note, Problem, Seal, StateStamp, needsAttention, useAction, useSession, useStepUpWhenAsked, useStickySide } from '../ui/kit.tsx'
import { ReserveBasis } from '../ui/reserve.tsx'
import { atTime, heldWords, MODE_WORD, monthLeft, nearDay, railBound } from '../lib/words.ts'
import { awaitsRepeat, REPEAT_RULE, RepeatHeld } from '../ui/repeat.tsx'
import { Commerce } from './Commerce.tsx'
import { Subscriptions } from './Subscriptions.tsx'
// the on-chain wallet's payment form, fetched only when the person chooses to pay from the wallet
const WalletPay = lazy(async () => ({ default: (await import('./WalletInline.tsx')).WalletPay }))
// R13: a payee abroad and a payment on a paper route with its quote (Abroad.tsx), below the checkout, loaded with it
const PayAbroad = lazy(async () => ({ default: (await import('./Abroad.tsx')).PayAbroad }))

/** name_check: what the paper bank's name check answered when the payee was added (server/name-check.ts); null before it existed. */
interface Payee { id: string; name: string; handle: string; category: string; created_at: number; verified_at: number | null; name_check?: string | null; registered_name?: string | null }
interface Bill { id: string; amount: number; due_at: number; memo: string; state: string; action_id: string | null; created_at: number; payee_id: string; payee_name: string; payee_handle: string; paying?: { id: string; state: string } | null; removal?: { id: string; effectiveAt: number } | null }
type Purpose = 'spend' | 'bill' | 'card' | 'loan:personal' | 'loan:home' | 'fd'
type Own = Exclude<Purpose, 'spend' | 'bill'>
/** What the journey is paying: a payee, a bill on record, or one of the owner's own accounts. */
type Pick = { kind: 'payee'; id: string } | { kind: 'bill'; id: string } | { kind: 'own'; purpose: Own }
type Kind = Pick['kind']
interface Term { id: string; value: Record<string, unknown> }
interface VaultBrief { setUp: boolean; available: boolean; state: { provisioned: boolean; treasury: { balance: string; paused: boolean } } | null }

const CATEGORIES = ['housing', 'utilities', 'family', 'services', 'shopping', 'other']
const OWN: [Own, string, string][] = [['card', 'My credit card', 'Pay what you owe on it'], ['loan:personal', 'My personal loan', 'Prepay part of it'], ['loan:home', 'My home loan', 'Prepay part of it'], ['fd', 'A fixed deposit', 'Move money into it']]
const isOwn = (p: string | null): p is Own => OWN.some((o) => o[0] === p)
const todayIst = (now: number): string => new Date(now + 19_800_000).toISOString().slice(0, 10)
const istDate = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10)
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
const cap = (t: string): string => t.replace(/^./, (c) => c.toUpperCase())
const MINUS = '−'
const DAY = 86_400_000
/** Payments that ended with nothing sent: they do not count towards what has gone to a payee (server/new-payee.ts). */
const ENDED = new Set(['failed', 'cancelled', 'expired', 'blocked', 'rejected'])

/**
 * The household's rule for a payee's first day, in words (server/new-payee.ts; the server decides, on the terms): what
 * goes to a payee in its first 24 hours waits once it comes to more than the household's amount. A test stack's
 * shortened wait is said as such.
 */
export function newPayeeRule(profile: { newPayeeHoldAbove: number; newPayeeHoldHours: number }, testMs: number | null | undefined): { above: number; wait: string; short: string; off: boolean } {
  const h = profile.newPayeeHoldHours
  // 0: the household switched the wait off in Safeguards (server/new-payee.ts HOLD_OFF), so nothing to a new payee waits
  if (h === 0) return { above: profile.newPayeeHoldAbove, wait: 'no time', short: 'no time', off: true }
  const hours = `${h} hour${h === 1 ? '' : 's'}`
  return { above: profile.newPayeeHoldAbove, wait: testMs ? `${Math.round(testMs / 1000)} seconds (shortened on this test installation; set to ${hours})` : hours, short: testMs ? `${Math.round(testMs / 1000)} seconds` : hours, off: false }
}
/** What has gone, or is on its way, to an address: every payment to it except those that ended with nothing sent. */
export const sentTo = (actions: readonly ActionView[], handle: string): number => actions.filter((a) => a.kind === 'payment' && a.params.payeeHandle === handle && !ENDED.has(a.state)).reduce((t, a) => t + Number(a.params.amount ?? 0), 0)

// ------------------------------------------------------------------------------------------------ the rules the journey shows

export type Rail = 'upi' | 'imps' | 'neft' | 'rtgs' | 'internal'
export interface RailLimits { upi: number; imps: number; rtgsMin: number }
/** The rail limits on record (the terms register the server's rail reads, server/venues.ts), with its defaults. */
export function railLimits(terms: readonly Term[] | undefined): RailLimits {
  const v = (id: string, d: number): number => { const x = terms?.find((t) => t.id === id)?.value.amount; return typeof x === 'number' ? x : d }
  return { upi: v('rail.upi.limit', 10_000_000), imps: v('rail.imps.limit', 50_000_000), rtgsMin: v('rail.rtgs.min', 20_000_000) }
}
/**
 * Which rail carries a payment: the server's own rule (PaperRail.chooseRail), applied to what leaves the bank, so the
 * route is known before the terms are prepared. src/screens/spend.test.ts holds it to the server's rule.
 */
export function routeFor(amount: number, own: boolean, preferred: string, lim: RailLimits): { rail: Rail; error?: string } {
  if (own) return { rail: 'internal' }
  if (preferred === 'upi' && amount > lim.upi) return { rail: 'upi', error: 'Above the UPI limit for one payment.' }
  if (preferred === 'imps' && amount > lim.imps) return { rail: 'imps', error: 'Above the IMPS limit for one payment.' }
  if (preferred === 'rtgs' && amount < lim.rtgsMin) return { rail: 'rtgs', error: 'Below the RTGS minimum.' }
  if (preferred === 'upi' || preferred === 'imps' || preferred === 'neft' || preferred === 'rtgs') return { rail: preferred }
  if (amount <= lim.upi) return { rail: 'upi' }
  if (amount <= lim.imps) return { rail: 'imps' }
  return { rail: 'rtgs' }
}
/** The rail as the terms name it ("Sent by"), and when the money arrives on it (server/owner.ts, buildPayment). */
export const RAIL_NAME: Record<Rail, string> = { upi: 'UPI', imps: 'IMPS', neft: 'NEFT', rtgs: 'RTGS', internal: 'Your bank (internal)' }
export const ARRIVES: Record<Rail, string> = { upi: 'Within seconds', imps: 'Within seconds', neft: 'In the next half-hourly batch', rtgs: 'Within seconds', internal: 'At once, inside your bank' }
/** The charge a payment carries on top of its amount: only prepaying the personal loan has one, at the rate on record. */
export function chargeFor(purpose: Purpose, amount: number, terms: readonly Term[] | undefined): number {
  if (purpose !== 'loan:personal' || amount <= 0) return 0
  const rate = terms?.find((t) => t.id === 'rate.loan.personal')?.value.prepayCharge
  return Number(fraction(BigInt(amount), String(rate ?? '0.03'), 'half'))
}
/**
 * What stays free after a payment that changes nothing kept for what is due (a payee, the card, a deposit): the
 * server's reserve rule (liquidity.ts staysLiquid) is that it takes free money first and anything beyond it from what is
 * kept. Not for a bill on record or a loan prepayment, which change what is kept; the terms give those exactly.
 */
export function freeAfter(free: number, kept: number, out: number): { fromFree: number; fromKept: number; free: number; kept: number } {
  const fromFree = Math.min(Math.max(0, out), free), fromKept = Math.min(Math.max(0, out - fromFree), kept)
  return { fromFree, fromKept, free: free - fromFree, kept: kept - fromKept }
}

// ------------------------------------------------------------------------------------------------ the screen

export function PayScreen() {
  const now = useNow(30_000)
  const { query } = useLocation()
  const home = useData<Home>('/api/home', ['action', 'bill', 'profile', 'program'])
  const payees = useData<{ payees: Payee[] }>('/api/payees')
  const bills = useData<{ bills: Bill[] }>('/api/bills', ['bill', 'action'])
  const activity = useData<{ actions: ActionView[]; disputes: Dispute[] }>('/api/activity?limit=120', ['action', 'dispute'])
  const market = useData<{ terms: Term[] }>('/api/market')
  const vault = useData<VaultBrief>('/api/vault', ['vault'])
  const liq = useData<{ envelope: AuthorityEnvelope }>('/api/liquidity', ['action', 'run', 'program', 'bill', 'profile'])
  const [added, setAdded] = useState<string | null>(null)
  // the page's head draws at once, before any data: it is the largest thing on the first screen (LCP on a phone)
  if (!home.data || !payees.data || !bills.data) return <div className="pay-page"><SpendHead />{home.error ?? payees.error ?? bills.error ? <Problem error={home.error ?? payees.error ?? bills.error} /> : <SpendSkeleton />}</div>

  const uncovered = new Map(home.data.needsYou.filter((x) => x.type === 'pay-bill').map((x) => [x.billId, x.detail]))
  const payers = home.data.programs.filter((p) => p.kind === 'bills' && (p.state === 'active' || p.state === 'paused'))
  return (
    <div className="pay-page">
      <SpendHead />
      <Journey home={home.data} payees={payees.data.payees} bills={bills.data.bills} terms={market.data?.terms} termsError={!!market.error} vault={vault.data} actions={activity.data?.actions ?? []} payers={payers} uncovered={uncovered} now={now}
        qedMay={home.data.stop ? 0 : home.data.programs.some((p) => p.state === 'active') ? liq.data?.envelope.windows.find((x) => x.days === 30)?.most ?? null : 0}
        askedBill={query.get('bill')} askedPurpose={query.get('purpose')} chosen={added}
        onAdded={(id) => { setAdded(id); payees.reload() }} onDone={() => activity.reload()} onWalletPaid={() => activity.reload()} />
      {/* R14: under the checkout every part takes the whole width and is composed in columns inside it (a list across the
          width, or two halves), so no part stands beside a hole however long its neighbour's list grows */}
      <BillsOnRecord home={home.data} payees={payees.data.payees} bills={bills.data.bills} payers={payers} uncovered={uncovered} now={now} onChanged={() => { bills.reload(); home.reload() }} />
      <Subscriptions />
      {homeCurrency() === 'INR' ? (
      <Suspense fallback={<section className="panel ab" aria-busy="true"><p className="loading-line">Reading payees abroad…</p></section>}><PayAbroad /></Suspense>
      ) : null}
      <Commerce />
      <PaymentsSoFar actions={activity.data?.actions ?? []} disputes={activity.data?.disputes ?? []} error={activity.error} loading={!activity.data && !activity.error} />
    </div>
  )
}

/** One step of the journey: its number and name on the left (the name labels its control), what it settles on the right. */
function Step({ n, id, title, children, wide }: { n: number; id: string; title: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <li className="pay-step" id={id}>
      <div className="pay-label"><span className="pay-n" aria-hidden="true">{n}</span><h3 id={`${id}-h`}>{title}</h3></div>
      <div className={`pay-body ${wide ? 'wide' : ''}`}>{children}</div>
    </li>
  )
}

function Journey({ home, payees, bills, terms, termsError, vault, actions, payers, uncovered, now, qedMay, askedBill, askedPurpose, chosen, onAdded, onDone, onWalletPaid }: {
  home: Home; payees: Payee[]; bills: Bill[]; terms: Term[] | undefined; termsError: boolean; vault: VaultBrief | null; actions: ActionView[]; payers: ProgramSummary[]; uncovered: Map<string | undefined, string>; now: number
  /** The most QED's instructions may move in 30 days, all together (the server's envelope); null while it is read. */
  qedMay: number | null
  askedBill: string | null; askedPurpose: string | null; chosen: string | null
  onAdded: (id: string) => void; onDone: (actionId: string) => void; onWalletPaid: () => void
}) {
  const o = home.overview, lq = o.liquidity
  const { session } = useSession()
  const rule = newPayeeRule(home.profile, session.delays?.newPayeeHoldTestMs)
  const due = useMemo(() => bills.filter((b) => b.state === 'due' || b.state === 'failed').sort((a, b) => a.due_at - b.due_at), [bills])
  // R7-045: the on-chain wallet is a place to pay from, chosen in the journey, not a separate area to visit
  const [from, setFrom] = useState<'bank' | 'wallet'>('bank')
  // Nobody is chosen until the person chooses (R12 task comparison: Spend chose the first payee on load, so a person who
  // skipped the step paid whoever sorted first). A bill asked for in the address, one of the owner's own accounts asked
  // for, and a payee just added on this page are choices the person made, and are kept.
  const first = (): Pick => askedBill && due.some((b) => b.id === askedBill) ? { kind: 'bill', id: askedBill } : isOwn(askedPurpose) ? { kind: 'own', purpose: askedPurpose } : { kind: 'payee', id: '' }
  const [pick, setPick] = useState<Pick>(first)
  const [kind, setKind] = useState<Kind>(() => first().kind)
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(payees.length === 0)
  const [amount, setAmount] = useState<number | null>(null)
  const [memo, setMemo] = useState('')
  const [rail, setRail] = useState('')
  const [pv, setPv] = useState<(PendingApproval & ActionPreview) | null>(null)
  const amountRef = useRef<HTMLDivElement>(null)
  const amountId = useId(), railId = useId()
  // R14 layout rule L2: beside the steps the summary stays in view and ends level with them (kit.tsx useStickySide)
  const side = useStickySide<HTMLElement>()

  // a bill asked for in the address ("Pay this bill" on Home, "Pay it now" below) is the one the person means to pay; both
  // links land on this payment's review (#pay-review), which on a phone sits below the whole journey
  useEffect(() => { if (askedBill && due.some((b) => b.id === askedBill)) { setFrom('bank'); setKind('bill'); setPick({ kind: 'bill', id: askedBill }) } }, [askedBill]) // eslint-disable-line react-hooks/exhaustive-deps
  // a payee just added on this page is the one the person means to pay
  useEffect(() => { if (chosen && payees.some((p) => p.id === chosen)) { setKind('payee'); setPick({ kind: 'payee', id: chosen }) } }, [chosen, payees])
  // a chosen payee that is no longer listed is unchosen, never swapped for another
  useEffect(() => { if (pick.kind === 'payee' && pick.id && !payees.some((p) => p.id === pick.id)) setPick({ kind: 'payee', id: '' }) }, [payees, pick])

  const purpose: Purpose = pick.kind === 'payee' ? 'spend' : pick.kind === 'bill' ? 'bill' : pick.purpose
  const own = pick.kind === 'own'
  const payee = pick.kind === 'payee' ? payees.find((p) => p.id === pick.id) : undefined
  const bill = pick.kind === 'bill' ? due.find((b) => b.id === pick.id) : undefined
  const pay = bill ? bill.amount : amount ?? 0
  const charge = chargeFor(purpose, pay, terms)
  const leaves = pay + charge
  const route = routeFor(leaves, own, rail, railLimits(terms))
  const overOwed = purpose === 'card' && pay > o.card
  // a large first-day payment to a new payee waits before it is sent (server/new-payee.ts): said here before the terms are
  // asked for; the terms themselves give the exact time
  const willWait = !!payee && !rule.off && leaves > 0 && now - payee.created_at < DAY && sentTo(actions, payee.handle) + leaves > rule.above
  // the payment is the one whose choice is in view: a kind with nothing in it (no bill waiting) leaves nothing to pay
  const ready = pick.kind === kind && (purpose === 'spend' ? !!payee : purpose === 'bill' ? !!bill : true)

  const preview = useAction(async () => {
    const body: Record<string, unknown> = { kind: 'payment', purpose: purpose === 'bill' ? 'spend' : purpose, amount: purpose === 'bill' ? bill?.amount ?? 0 : amount ?? 0 }
    if (purpose === 'spend') { body.payeeId = payee?.id ?? ''; if (memo.trim()) body.memo = memo.trim() }
    if (purpose === 'bill') body.billId = bill?.id ?? ''
    if (rail && !own) body.rail = rail
    setPv(await api<PendingApproval & ActionPreview>('POST', '/api/actions/preview', body))
  })
  useEffect(() => { preview.clear() }, [pick.kind, pick.kind === 'own' ? pick.purpose : pick.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const f = preview.error?.fields ?? {}

  const choose = (k: Kind) => {
    setKind(k); setFilter('')
    if (k === 'payee' && pick.kind !== 'payee') setPick({ kind: 'payee', id: '' })
    if (k === 'bill' && pick.kind !== 'bill' && due[0]) setPick({ kind: 'bill', id: due[0].id })
    if (k === 'own' && pick.kind !== 'own') setPick({ kind: 'own', purpose: 'card' })
  }
  const q = filter.trim().toLowerCase()
  const match = (s: string) => !q || s.toLowerCase().includes(q)
  const shownPayees = payees.filter((p) => match(`${p.name} ${p.handle} ${p.category}`))
  const shownBills = due.filter((b) => match(`${b.payee_name} ${b.memo} ${b.payee_handle}`))
  const key = pick.kind === 'own' ? `own:${pick.purpose}` : `${pick.kind}:${pick.id}`
  const radio = (k: string, p: Pick, body: ReactNode, label: string) => (
    <label key={k} className={`pay-rcpt ${key === k ? 'on' : ''}`}>
      <input type="radio" name="to" checked={key === k} onChange={() => setPick(p)} aria-label={label} />
      {body}
    </label>
  )

  const free = lq.short > 0 ? 0 : lq.free
  const kept = Math.min(o.bankAvailable, lq.need)
  const held = o.bankHeld
  const keptBy = lq.binding ? ` by ${fmt.isoDay(lq.binding.date)}` : ''
  const w = vault?.setUp && vault.state?.provisioned ? vault.state : null
  // a bill already counted in what is kept is paid from that money; whether the subtraction is exact before the terms (StaysFree)
  const billKept = !!bill && !!lq.binding && istDate(bill.due_at) <= lq.binding.date
  const staysExact = purpose === 'spend' || purpose === 'card' || purpose === 'fd' || (purpose === 'bill' && !billKept)

  // where the journey stands, said on its rail: each step is done when its figure is settled
  // From the on-chain wallet the next step is one form of its own (to, how much and the limit), signed there: the rail
  // stands at "To" and claims nothing after it (R14: it showed every step ticked and Review lit, even with no wallet set up)
  const settled = from === 'wallet' ? { from: true, to: false, amount: false, route: false } : { from: true, to: ready, amount: leaves > 0, route: !route.error && (!!terms || own) }
  const order = ['from', 'to', 'amount', 'route', 'review'] as const
  const now_ = order.find((k) => k !== 'review' && !settled[k as keyof typeof settled]) ?? 'review'
  const [sent, setSent] = useState<string | null>(null)
  const recipient = payee ? { name: payee.name, sub: payee.handle } : bill ? { name: bill.payee_name, sub: bill.memo || bill.payee_handle } : pick.kind === 'own' ? { name: OWN.find((x) => x[0] === pick.purpose)?.[1] ?? 'Your account', sub: 'Your own account at the bank' } : null

  return (
    <div className="pay-checkout">
      <section className="panel pay-journey" aria-labelledby="pay-h">
        <div className="pay-jhead"><h2 id="pay-h">Pay someone</h2>
          <ol className="pay-progress" aria-label="Where you are">{order.map((k, i) => {
            // a step is shown settled only before the current one: a later step is never ahead of the person
            const done = i < order.indexOf(now_)
            return <li key={k} className={k === now_ ? 'now' : done ? 'done' : ''} aria-current={k === now_ ? 'step' : undefined}><i aria-hidden="true">{done ? <Check /> : i + 1}</i><span>{k === 'from' ? 'From' : k === 'to' ? 'To' : k === 'amount' ? 'How much' : k === 'route' ? 'Route' : 'Review'}</span></li>
          })}</ol>
        </div>
        <ol className="pay-steps">
        <Step n={1} id="pay-from" title="Pay from">
          <div className="pay-from" role="group" aria-labelledby="pay-from-h">
            <button type="button" aria-pressed={from === 'bank'} onClick={() => setFrom('bank')}>
              <Landmark aria-hidden="true" /><span><b>Bank account</b><small>{fmt.money(o.bank, true)} in it, {fmt.money(free, true)} free to use</small></span>
            </button>
            <button type="button" aria-pressed={from === 'wallet'} onClick={() => setFrom('wallet')}>
              <CreditCard aria-hidden="true" /><span><b>On-chain wallet</b><small>{w ? `${fmt.money(Number(w.treasury.balance), true)} in test rupees${w.treasury.paused ? ', paused' : ''}` : vault ? (vault.setUp ? 'Being set up' : 'Not set up yet') : 'Test rupees on a chain on this computer'}</small></span>
            </button>
          </div>
        </Step>
        {from === 'wallet' ? (
          <Step n={2} id="pay-wallet" title="To, how much and the limit" wide>
            <div className="pay-wallet"><Suspense fallback={<p className="loading-line">Opening the on-chain wallet…</p>}><WalletPay onPaid={onWalletPaid} /></Suspense></div>
          </Step>
        ) : <>
          <Step n={2} id="pay-to" title="To" wide>
            <div className="pay-to-tools">
              <div className="seg pay-seg" role="group" aria-label="Paying">
                <button type="button" aria-pressed={kind === 'payee'} onClick={() => choose('payee')}>A payee</button>
                <button type="button" aria-pressed={kind === 'bill'} onClick={() => choose('bill')}>A bill on record{due.length ? ` (${due.length})` : ''}</button>
                <button type="button" aria-pressed={kind === 'own'} onClick={() => choose('own')}>Your own account</button>
              </div>
              {kind !== 'own' ? <div className="pay-search"><Search aria-hidden="true" /><input type="search" className="input" placeholder="Search payees and bills" aria-label="Search payees and bills" value={filter} onChange={(e) => setFilter(e.target.value)} /></div> : null}
            </div>
            <div className={`pay-list ${kind}`} role="radiogroup" aria-labelledby="pay-to-h">
              {kind === 'payee' ? (payees.length === 0 ? <p className="pay-none">No payee yet. Add one below to pay them.</p> : shownPayees.length === 0 ? <p className="pay-none">No payee matches “{filter}”.</p>
                : shownPayees.map((y) => radio(`payee:${y.id}`, { kind: 'payee', id: y.id }, <><span className="avatar sm" aria-hidden="true">{initials(y.name)}</span><span className="pay-rc"><b>{y.name}<span className="pay-tag">{cap(y.category)}</span></b><small>{y.handle}</small></span></>, `${y.name} (${y.handle})`))) : null}
              {kind === 'bill' ? (due.length === 0 ? <p className="pay-none">No bill is waiting to be paid. Put one on record below and an instruction can pay it when it falls due.</p> : shownBills.length === 0 ? <p className="pay-none">No bill matches “{filter}”.</p>
                : shownBills.map((b) => radio(`bill:${b.id}`, { kind: 'bill', id: b.id }, <><span className="avatar sm" aria-hidden="true">{initials(b.payee_name)}</span><span className="pay-rc"><b>{b.payee_name}</b><small>{b.memo || b.payee_handle}</small></span><span className="pay-rc-fig"><b>{fmt.money(b.amount, true)}</b><small className={uncovered.has(b.id) ? 'due' : ''}>{b.due_at < now ? 'was due' : 'due'} {fmt.day(b.due_at)}{uncovered.has(b.id) ? ', not covered' : ''}</small></span></>, `Bill from ${b.payee_name}, ${fmt.money(b.amount, true)}, due ${fmt.day(b.due_at)}`))) : null}
              {kind === 'own' ? OWN.map(([p, t, d]) => radio(`own:${p}`, { kind: 'own', purpose: p }, <><span className="avatar sm own" aria-hidden="true">{p === 'fd' ? <PiggyBank /> : p === 'card' ? <CreditCard /> : <Landmark />}</span><span className="pay-rc"><b>{t}</b><small>{p === 'card' && o.card > 0 ? `You owe ${fmt.money(o.card, true)}` : d}</small></span></>, t)) : null}
            </div>
            {kind === 'payee' ? (adding
              ? <div className="pay-add"><div className="pay-add-head"><h4>Add a payee</h4>{payees.length ? <button type="button" className="icon-btn" aria-label="Close adding a payee" onClick={() => setAdding(false)}><X aria-hidden="true" /></button> : null}</div><AddPayee focus={payees.length > 0} rule={rule} onAdded={(id) => { onAdded(id); setAdding(false); requestAnimationFrame(() => amountRef.current?.querySelector('input')?.focus()) }} /></div>
              : <div className="pay-add-row"><Btn onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add a payee</Btn>
                <details className="disclose pay-test"><summary>Payees that test a failure</summary>
                  <dl>
                    <dt>decline@paper</dt><dd>Declined at once. The money comes straight back.</dd>
                    <dt>slow@paper</dt><dd>Stays pending for 90 seconds, then settles.</dd>
                    <dt>timeout@paper</dt><dd>The rail gives no answer for two minutes, then fails. QED does not resend; it waits and returns the money.</dd>
                    <dt>reverse@paper</dt><dd>Settles, then is reversed a minute later. Reconciliation finds it and books the money back.</dd>
                    <dt>refund…@…</dt><dd>Any address beginning with “refund” gives the money back when you dispute a payment. Other payments are upheld.</dd>
                    <dt>nocheck@paper</dt><dd>The paper bank's name check does not answer for it, so the name cannot be checked.</dd>
                  </dl>
                  <p>The paper bank knows each test address by a test name, such as Slow Test Account for slow@paper, and ravi.kumar@upi as Ravi Kumar; any other address it does not know.</p>
                </details></div>) : null}
            {pick.kind === kind ? <PickFacts pick={pick} payee={payee} bill={bill} payees={payees} due={due} actions={actions} payers={payers} uncovered={uncovered} home={home} now={now} rule={rule} onPayBill={(id) => { setKind('bill'); setPick({ kind: 'bill', id }) }} /> : null}
            {f.payeeId ? <p className="pay-err" role="alert">{f.payeeId}</p> : null}
          </Step>
        </>}
        </ol>
        {from === 'bank' ? (
          <form id="pay-form" className="pay-form" onSubmit={(e) => { e.preventDefault(); if (ready && !overOwed) void preview.run() }}>
            <ol className="pay-steps" start={3}>
              <Step n={3} id="pay-amount" title={bill ? 'How much' : <label htmlFor={amountId}>How much</label>}>
                  <div className="pay-amount" ref={amountRef}>
                    {bill ? <><p className="pay-fixed-fig">{fmt.money(bill.amount, true)}</p><p className="pay-quiet">A bill is paid in full or not at all.</p></> : <>
                      <MoneyInput id={amountId} value={amount} onChange={setAmount} aria-invalid={!!f.amount || overOwed || undefined} aria-describedby={f.amount || overOwed ? `${amountId}-e ${amountId}-say` : `${amountId}-say`} />
                      {f.amount || overOwed ? <p className="pay-err" id={`${amountId}-e`} role="alert">{f.amount ?? `You owe ${fmt.money(o.card, true)} on the card; you cannot pay more than that.`}</p> : null}
                    </>}
                    {bill ? null : <p className="pay-say" id={`${amountId}-say`}>{purpose === 'card' ? `You owe ${fmt.money(o.card, true)} on the card. The paper bank asks for no minimum payment.`
                      : purpose === 'loan:personal' ? `Prepaying carries a charge of ${pctOf(terms)} of what you prepay, on top of it (modelled).${charge ? ` On this amount: ${fmt.money(charge, true)}.` : ''}`
                      : purpose === 'loan:home' ? 'Prepaying lowers what you owe and the instalments after it.'
                      : purpose === 'fd' ? 'Money in the deposit is not free to spend. Breaking it early costs interest.'
                      : lq.short > 0 ? `Your bank account is ${fmt.money(lq.short, true)} short of what is due${keptBy}: anything paid now comes out of money kept for it.`
                      : <><span data-reserve="free">{fmt.money(free, true)}</span> is free to use. Up to that, nothing kept for what is due is touched.</>}</p>}
                    {bill || purpose !== 'spend' ? null : <ReserveBasis l={lq} />}
                  </div>
                  {purpose === 'spend' ? <div className="form-grid fields pay-memo"><Field label="Note for your records" hint="Optional. Shown in the passbook.">{(p) => <input {...p} className="input" maxLength={80} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field></div> : null}
              </Step>
              <Step n={4} id="pay-route" title={own ? 'Send by' : <label htmlFor={railId}>Send by</label>}>
                  {own ? <p className="pay-fixed-route">Inside your bank</p> : (
                    <div className="pay-rail">
                      <select id={railId} className="input" value={rail} onChange={(e) => setRail(e.target.value)} aria-invalid={!!(f.rail || route.error) || undefined} aria-describedby={`${railId}-say`}>
                        <option value="">Let QED choose</option><option value="upi">UPI</option><option value="imps">IMPS</option><option value="neft">NEFT (half-hourly batches)</option><option value="rtgs">RTGS (large payments)</option>
                      </select>
                    </div>
                  )}
                  <div className="pay-route" id={`${railId}-say`}>
                    {!terms && !termsError ? <p className="pay-quiet">Reading the rail limits…</p>
                      : route.error ? <p className="pay-err">{route.error} {route.rail === 'rtgs' ? `It takes ${fmt.money(railLimits(terms).rtgsMin)} or more.` : `It takes at most ${fmt.money(route.rail === 'upi' ? railLimits(terms).upi : railLimits(terms).imps)}.`} Choose another rail, or let QED choose.</p>
                      : <p><b>{RAIL_NAME[route.rail]}</b>{leaves > 0 || own ? <>: {ARRIVES[route.rail].toLowerCase()}.</> : <>, once you enter how much.</>}{f.rail ? <span className="pay-err"> {f.rail}</span> : null}</p>}
                    {own ? <p className="pay-quiet">A payment to your own account moves between your accounts at the bank, at once.</p>
                      : <p className="pay-quiet">QED's choice: UPI up to {fmt.money(railLimits(terms).upi)}, IMPS up to {fmt.money(railLimits(terms).imps)}, RTGS above that. NEFT goes in half-hourly batches. On paper: no real payment is made.</p>}
                  </div>
              </Step>
              {/* R14: the fifth step is in the journey, at the steps' width: the bank at true scale with this payment in
                  it, and the subtraction. In the summary it made the card taller than a laptop's window, so the card could
                  not stay in view (layout rule L2 unpins a summary taller than the room between the bars); the summary
                  keeps its one figure, and the button. */}
              <Step n={5} id="pay-free" title="Review">
                {sent ? <p className="pay-quiet">This payment is signed. Follow it under “Your payment”; what is free now is on Home and Save.</p>
                  : <StaysFree purpose={purpose} leaves={leaves} free={free} kept={kept} held={held} short={lq.short} keptBy={keptBy} bill={bill} billKept={billKept} qedMay={qedMay} />}
              </Step>
            </ol>
          </form>
        ) : null}
      </section>

      {/* R14: where the summary cannot stand beside the steps (under 960 px), the payment still travels with them: one
          line pinned above the bottom navigation with who and how much, which leads to the summary below. It shows
          once there is someone or an amount to show, never an empty line over the steps. It is a way to the review,
          never an approval: the terms are asked for and signed in the summary and its sheet. */}
      {from === 'bank' && !sent && (recipient || leaves > 0) ? <PaymentStrip to={recipient?.name ?? null} amount={leaves} /> : null}

      <aside id="pay-review" ref={side} className="panel pay-summary sticky-side" aria-labelledby="sum-h">
        {sent ? <Sent id={sent} actions={actions} now={now} paused={!!session.stop} onChanged={() => onDone(sent)} onAgain={() => { setSent(null); setAmount(null); setMemo('') }} /> : <>
          <h2 id="sum-h">{from === 'wallet' ? 'From your on-chain wallet' : 'This payment'}</h2>
          {from === 'wallet' ? <p className="pay-quiet">The wallet pays only the payee its mandate names, up to the mandate's limits; the contract refuses anything else.{w ? ' Choose the payee and amount on the left.' : ''}</p> : <>
            <div className="ps-to">{recipient ? <><span className="avatar sm" aria-hidden="true">{initials(recipient.name)}</span><span><b>{recipient.name}</b><small>{recipient.sub}</small></span></> : <span className="pay-quiet">Choose who to pay</span>}</div>
            <p className={`ps-amount ${leaves > 0 ? '' : 'none'}`} data-resolve="">{leaves > 0 ? fmt.money(leaves, true) : fmt.money(0, true)}</p>
            <dl className="ps-lines">
              <div><dt>From</dt><dd>Bank account</dd></div>
              <div><dt>Route</dt><dd>{route.error ? <span className="pay-err">{route.error}</span> : <>{RAIL_NAME[route.rail]}{leaves > 0 || own ? `, ${ARRIVES[route.rail].toLowerCase()}${willWait ? ' once its wait is over' : ''}` : ''}</>}</dd></div>
              {willWait ? <div className="ps-wait"><dt>Sent</dt><dd>After a wait of {rule.short}: a new payee's first day, above {fmt.money(rule.above)}</dd></div> : null}
              {charge ? <div><dt>Prepayment charge</dt><dd>{fmt.money(charge, true)} <small>(modelled)</small></dd></div> : null}
              {/* the one figure of step 5, here beside the button: what is free, and after an amount is entered what stays free */}
              {leaves > 0 && staysExact && freeAfter(free, kept, leaves).fromKept > 0 ? <div className="ps-over"><dt>More than is free, taken from what is kept</dt><dd>{fmt.money(freeAfter(free, kept, leaves).fromKept, true)}</dd></div> : null}
              {leaves > 0 && staysExact ? <div className="ps-free"><dt>Stays free after it</dt><dd>{fmt.money(freeAfter(free, kept, leaves).free, true)}</dd></div>
                : <div className="ps-free"><dt>Free to use now</dt><dd>{fmt.money(free, true)}</dd></div>}
            </dl>
            <div className="pay-go">
              <Btn tone="fill" className="lg block" type="submit" form="pay-form" busy={preview.busy} disabled={!ready || overOwed}>See what this would do</Btn>
              <p className="pay-quiet">QED writes these figures into the terms. Your passkey signs them and nothing else; the payment is checked again as it is sent and kept with its receipt.</p>
            </div>
            {preview.error && Object.keys(f).length === 0 ? <Problem error={preview.error} /> : null}
          </>}
        </>}
      </aside>

      <ApprovalSheet approval={pv} title="Approve this payment" action="Approve and send" onClose={() => setPv(null)}
        onApproved={async (approvalId) => { const a = await api<{ id: string }>('POST', '/api/actions', { approvalId }); setPv(null); setSent(a.id); onDone(a.id) }}>
        {pv ? <ActionDoc summary={pv.summary} lines={pv.lines} warnings={pv.warnings} worst={pv.worst} document={pv.document} /> : null}
      </ApprovalSheet>
    </div>
  )
}

/**
 * The payment in one line, pinned above the bottom navigation while the summary is out of view on a screen too narrow
 * for the summary to stand beside the steps (pay.css shows it under 960 px only). It gives way once the summary itself
 * is on the screen. A link to the summary: it moves nothing and approves nothing.
 */
function PaymentStrip({ to, amount }: { to: string | null; amount: number }) {
  const [away, setAway] = useState(true)
  useEffect(() => {
    const el = document.getElementById('pay-review')
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver(([e]) => setAway(!e?.isIntersecting), { rootMargin: '0px 0px -120px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div className="pay-strip" data-away={away}>
      <a href="#pay-review" tabIndex={away ? 0 : -1} aria-hidden={away ? undefined : true}>
        <span className="pay-strip-who"><small>This payment</small><b>{to ?? 'Choose who to pay'}</b></span>
        <span className="pay-strip-fig">{fmt.money(amount, true)}</span>
        <span className="pay-strip-go">Review<ArrowDown aria-hidden="true" /></span>
      </a>
    </div>
  )
}

/**
 * After the passkey signs: the payment followed on the same card, in the record's own words. Sent is not settled; a
 * rail that has not answered is said to be unanswered, never done, with the rail's bound and what QED does if no answer
 * comes (R12 task comparison, gap 11); the receipt is kept when it settles (R7-095). A payment on hold (a large first-day
 * payment to a new payee, server/new-payee.ts) says when it is sent, and can be cancelled here until then.
 */
function Sent({ id, actions, now, paused, onChanged, onAgain }: { id: string; actions: ActionView[]; now: number; paused: boolean; onChanged: () => void; onAgain: () => void }) {
  const a = actions.find((x) => x.id === id)
  const head = useRef<HTMLHeadingElement>(null)
  const cancel = useAction(async () => { await api('POST', `/api/actions/${id}/cancel`); onChanged(); requestAnimationFrame(() => head.current?.focus()) })
  const attention = a ? needsAttention(a.state, a.reconState) : false
  const waits = !!a?.params.hold
  const said = !a ? 'Signed. Waiting for the record of it.'
    : attention ? 'The money moved, and the rail\'s record differs from the books. It is being reconciled.'
    : a.state === 'held' ? `Signed, and on hold. ${heldWords(a, now, paused)}`
    : a.state === 'done' ? 'Settled. The receipt is kept with the record.'
    : a.state === 'failed' ? 'It did not go through. The money came back to your bank account.'
    : a.state === 'cancelled' && waits ? 'Cancelled while it waited. Nothing was sent, and its money is free again.'
    : a.state === 'cancelled' || a.state === 'expired' ? 'It was not sent.'
    : a.state === 'blocked' ? `QED refused it before anything was sent: ${a.error ?? 'a check failed.'}`
    : a.state === 'planned' ? 'Signed. QED is checking it now.'
    : `Sent to the rail. Waiting for its answer; do not send it again.${railBound(a, now) ? ` ${railBound(a, now)}` : ''}`
  const sentYet = !!a && !['planned', 'held', 'cancelled', 'blocked', 'expired'].includes(a.state)
  const steps: [string, boolean][] = [['Signed', true], ...(waits ? [[a?.state === 'held' ? `Waits until ${atTime(a.params.hold!.until, now)}` : 'Waited', !!a && a.state !== 'planned'] as [string, boolean]] : []), ['Sent', sentYet], [a?.state === 'failed' ? 'Returned' : 'Settled', !!a && (a.state === 'done' || a.state === 'failed')]]
  return (
    <div className="ps-sent" role="status" aria-live="polite">
      <h2 id="sum-h" ref={head} tabIndex={-1}>Your payment</h2>
      <ol className="ps-track">{steps.map(([t, on], i) => <li key={t} className={on ? 'on' : ''}><i aria-hidden="true">{on ? <Check /> : i + 1}</i>{t}</li>)}</ol>
      {a ? <p className="ps-what">{a.what}</p> : null}
      <p className="ps-said">{a?.state === 'done' && !attention ? <Seal /> : null}{said}</p>
      {a?.state === 'held' && a.params.hold ? <p className="ps-why">{a.params.hold.why}</p> : null}
      {a && awaitsRepeat(a) ? <RepeatHeld a={a} onChanged={onChanged} /> : null}
      {a ? <div className="ps-state"><StateStamp state={a.state} recon={a.reconState} /></div> : null}
      <div className="ps-acts">
        <Link className="btn fill" to={`/record/${id}`}><ArrowUpRight aria-hidden="true" />Its record and receipt</Link>
        {a?.state === 'held' && !awaitsRepeat(a) ? <Btn tone="void" busy={cancel.busy} onClick={() => void cancel.run()}>Cancel this payment</Btn> : null}
        <Btn onClick={onAgain}>Pay someone else</Btn>
      </div>
      <Problem error={cancel.error} />
    </div>
  )
}

const pctOf = (terms: readonly Term[] | undefined): string => `${(Number(terms?.find((t) => t.id === 'rate.loan.personal')?.value.prepayCharge ?? 0.03) * 100).toFixed(0)}%`

/** What is known about the chosen recipient, so a wrong or new one is noticed before the amount is typed. */
function PickFacts({ pick, payee, bill, payees, due, actions, payers, uncovered, home, now, rule, onPayBill }: {
  pick: Pick; payee: Payee | undefined; bill: Bill | undefined; payees: Payee[]; due: Bill[]; actions: ActionView[]; payers: ProgramSummary[]; uncovered: Map<string | undefined, string>; home: Home; now: number
  rule: { above: number; wait: string; off: boolean }; onPayBill: (id: string) => void
}) {
  const lines: ReactNode[] = []
  if (payee) {
    // the server's own sentence (server/lookalike.ts), the same one the terms will carry
    const look = lookalikeWarning(payee, payees.filter((p) => p.handle !== payee.handle))
    if (look) lines.push(<p key="look" className="pay-fact warn"><ShieldAlert aria-hidden="true" /><span>{look}</span></p>)
    // what the paper bank's name check answered when the payee was added, in the words its payments' terms carry
    // (server/name-check.ts): shown before any payment, and marked when it was anything but a match
    const outcome = isNameOutcome(payee.name_check) ? payee.name_check : null
    const named = nameCheckWords(outcome, payee.registered_name ?? null, payee.name)
    lines.push(<p key="name" className={`pay-fact ${outcome === 'match' ? '' : 'heed'}`}><b>Name check:</b> {named.value}. <span className="pay-fact-note">{named.note}</span></p>)
    const past = actions.filter((a) => a.kind === 'payment' && a.params.payeeHandle === payee.handle && a.state === 'done')
    const added = new Date(payee.created_at + 19_800_000).toISOString().slice(0, 10), today = new Date(now + 19_800_000).toISOString().slice(0, 10)
    lines.push(<p key="hist" className={`pay-fact ${past.length === 0 ? 'first' : ''}`}>{past.length === 0
      ? <>{now - payee.created_at < DAY ? (added === today ? 'Added today, and never paid before.' : 'Added yesterday, and never paid before.') : 'You have not paid this payee before.'} Check the address with them yourself before you send.</>
      : <>Paid {past.length} time{past.length === 1 ? '' : 's'} before{past[0] ? `, last on ${fmt.day(past[0].createdAt)}` : ''}.</>}</p>)
    // a payee's first day: what goes to it above the household's amount waits (server/new-payee.ts)
    if (now - payee.created_at < DAY) lines.push(<p key="new" className="pay-fact">{rule.off
      ? <>Until {atTime(payee.created_at + DAY, now)} it is a new payee. Payments to it do not wait: you switched that off in Safeguards.</>
      : <>Until {atTime(payee.created_at + DAY, now)} it is a new payee: a payment that takes what you send it above {fmt.money(rule.above)} waits {rule.wait} before it is sent, and you can cancel it meanwhile.{sentTo(actions, payee.handle) > 0 ? ` ${fmt.money(sentTo(actions, payee.handle), true)} has gone or is on its way to it so far.` : ''}</>}</p>)
    const open = due.filter((b) => b.payee_handle === payee.handle)
    if (open[0]) lines.push(<p key="bill" className="pay-fact">{payee.name} has {open.length === 1 ? `a ${fmt.money(open[0].amount, true)} bill` : `${open.length} bills`} on record, due {fmt.day(open[0].due_at)}{open.length > 1 ? ' first' : ''}. Paying by hand does not settle it: it stays due. <button type="button" className="linkish" onClick={() => onPayBill(open[0]!.id)}>Pay the bill instead</button></p>)
  }
  if (bill) {
    const payer = payers.find((p) => p.state === 'active' && ((p.params.payeeHandles as string[] | undefined) ?? []).includes(bill.payee_handle) && bill.amount <= Number(p.params.capPerBill ?? 0))
    lines.push(<p key="when" className="pay-fact">{bill.due_at < now ? `Was due ${fmt.dayTime(bill.due_at)} (${fmt.rel(bill.due_at, now)}).` : `Due ${fmt.dayTime(bill.due_at)} (${fmt.rel(bill.due_at, now)}).`}{bill.state === 'failed' ? ' The last attempt to pay it failed and the money came back.' : ''}</p>)
    lines.push(uncovered.has(bill.id)
      ? <p key="who" className="pay-fact first">{uncovered.get(bill.id)} It stays unpaid unless you pay it.</p>
      : <p key="who" className="pay-fact">{payer ? <>QED pays it when it falls due under <Link to={`/instructions/${payer.id}`}>{payer.title}</Link> ({(MODE_WORD[payer.authority?.runMode ?? 'auto'] ?? '').toLowerCase()}). Paying it now settles it early.</> : 'An instruction pays it when it falls due. Paying it now settles it early.'}</p>)
  }
  if (pick.kind === 'own' && pick.purpose === 'card' && home.overview.card <= 0) lines.push(<p key="card" className="pay-fact">Nothing is owed on the card.</p>)
  return lines.length ? <div className="pay-facts">{lines}</div> : null
}

/**
 * The fifth step, the bound a payment by hand falls under: the bank's money at true scale on the money bar (kit.tsx,
 * DESIGN.md M14), this payment drawn where it comes from, and the most QED's instructions may move in 30 days as the
 * span under the free part that is left (the same bar as Home's). Free money is used first; beyond it, money kept for
 * what is due, which the owner may use by hand and an instruction never may.
 */
function StaysFree({ purpose, leaves, free, kept, held, short, keptBy, bill, billKept, qedMay }: {
  purpose: Purpose; leaves: number; free: number; kept: number; held: number; short: number; keptBy: string; bill: Bill | undefined; billKept: boolean; qedMay: number | null
}) {
  const exact = purpose === 'spend' || purpose === 'card' || purpose === 'fd' || (purpose === 'bill' && !billKept)
  const a = freeAfter(free, kept, leaves)
  // a bill already counted in what is kept is paid from that money; anything else from the free part first
  const fromKeptOnly = purpose === 'bill' && billKept
  const segFree = fromKeptOnly ? 0 : a.fromFree, segKept = fromKeptOnly ? Math.min(leaves, kept) : a.fromKept
  const left = free - segFree
  const may = qedMay ?? 0
  const bank = free + kept + held
  const label = `Your bank at true scale: ${fmt.money(free, true)} free and ${fmt.money(kept, true)} kept for what is due${held ? `, ${fmt.money(held, true)} held for orders and payments on hold` : ''}.${leaves > 0 ? ` This payment of ${fmt.money(leaves, true)} is drawn ${fromKeptOnly ? 'inside what is kept' : segKept > 0 ? 'across the end of the free part and into what is kept' : 'at the end of the free part'}.` : ''}${may > 0 && left > 0 ? ` The line under the bar is the most your instructions may move in 30 days, ${fmt.money(may)}, from the free part that is left.` : ''}`
  return (
    <div className="pay-free">
      <MoneyBar className="pay-bar" label={label} parts={[
        { tone: 'free', value: left, reach: may },
        { tone: 'pay', value: segFree },
        { tone: fromKeptOnly ? 'pay' : 'over', value: segKept },
        { tone: 'kept', value: kept - segKept },
        { tone: 'held', value: held },
      ]} keys={[
        ...(left > 0 ? [{ tone: 'free' as const, text: 'Free to use' }] : []),
        ...(leaves > 0 ? [{ tone: 'pay' as const, text: 'This payment' }] : []),
        ...(segKept > 0 && !fromKeptOnly ? [{ tone: 'over' as const, text: 'Taken from what is kept' }] : []),
        { tone: 'kept', text: `Kept for what is due${keptBy}` },
        ...(held ? [{ tone: 'held' as const, text: 'Held for orders and payments on hold' }] : []),
        ...(may > 0 && left > 0 ? [{ tone: 'reach' as const, text: 'Most QED may move in 30 days' }] : []),
      ]} />
      {fromKeptOnly && leaves > 0 ? (
        // a bill already counted in what is kept is subtracted from what is kept, not from what is free
        <dl className="pay-sum">
          <div><dt>Kept for what is due{keptBy}</dt><dd data-reserve="kept">{fmt.money(kept, true)}</dd></div>
          <div><dt>This bill, already counted in it</dt><dd>{MINUS}{fmt.money(leaves, true)}</dd></div>
          <div><dt>Free to use now</dt><dd data-reserve="free">{fmt.money(free, true)}</dd></div>
        </dl>
      ) : <dl className="pay-sum">
        <div><dt>Free to use now</dt><dd data-reserve="free">{fmt.money(free, true)}</dd></div>
        {leaves > 0 ? <div><dt>Leaves your bank</dt><dd>{MINUS}{fmt.money(leaves, true)}</dd></div> : null}
        {leaves > 0 && exact && a.fromKept > 0 ? <div className="over"><dt>More than is free, taken from what is kept</dt><dd>{fmt.money(a.fromKept, true)}</dd></div> : null}
        {leaves > 0 && exact ? <div className="total"><dt>Stays free after it</dt><dd>{fmt.money(a.free, true)}</dd></div> : null}
      </dl>}
      {leaves <= 0 ? <p className="pay-quiet">{fmt.money(free, true)} free + {fmt.money(kept, true)} kept{held ? ` + ${fmt.money(held, true)} held` : ''} = {fmt.money(bank, true)} in your bank. Enter how much to see what stays free after it.</p>
        : exact ? <p className="pay-quiet" aria-live="polite">After it: {fmt.money(a.free, true)} free + {fmt.money(a.kept, true)} kept{held ? ` + ${fmt.money(held, true)} held` : ''} = {fmt.money(bank - leaves, true)} in your bank.{short > 0 || a.fromKept > 0 ? ` ${fmt.money(short + a.fromKept, true)} would be missing from what is due${keptBy}.` : ''}</p>
        : fromKeptOnly && bill ? <p className="pay-quiet" aria-live="polite">It is paid from money kept for it, not from what is free. The terms you sign give what stays in your bank to the paisa.</p>
        : <p className="pay-quiet" aria-live="polite">Prepaying lowers the instalments counted in what is kept, so what is kept falls as well. The terms you sign give what stays in your bank to the paisa.</p>}
      {leaves > 0 && exact && (a.fromKept > 0 || short > 0) ? <Note tone="wait" title="This takes money kept for what is due">You may do this yourself; QED's instructions may not take money kept for what is due. The terms you sign say so.</Note> : null}
      {may > 0 && leaves > 0 && exact ? <p className="pay-quiet">{a.free >= may
        ? `Your instructions may move at most ${fmt.money(may)} in 30 days, always from the free part: that much stays free after this.`
        : `Your instructions may move at most ${fmt.money(may)} in 30 days, from the free part only. After this less than that is free, so a run that would need money kept for what is due is refused, not paid from it.`}</p> : null}
    </div>
  )
}

/** What the server answered when a payee was offered (server/name-check.ts, server/lookalike.ts), for the owner to confirm. */
interface Asked { outcome: NameOutcome | null; registered: string | null; look: string | null; name: string; handle: string }
/** POST /api/payees/check: what adding would need confirmed, with nothing saved (server/owner.ts checkNewPayee). */
interface CheckAnswer { nameCheck: { outcome: NameOutcome; registeredName: string | null; message: string | null }; lookalike: string | null; needsConfirmation: boolean }
const ASKED_TITLE: Record<NameOutcome, string> = { match: '', close: 'The paper bank holds a slightly different name', no_match: 'The name does not match', unknown: 'The paper bank could not check the name', no_answer: 'The paper bank could not check the name' }

function AddPayee({ onAdded, focus, rule }: { onAdded: (id: string) => void; focus: boolean; rule: { above: number; wait: string; off: boolean } }) {
  const [name, setName] = useState(''), [handle, setHandle] = useState(''), [category, setCategory] = useState('other')
  // Before a payee is saved the server answers: the paper bank's name check (match, close match, no match, could not
  // check) and the look-alike check (X01). Anything but a match, or a look-alike, is shown in the server's words and added
  // only once the owner confirms they checked the address; the confirmation names the exact answer shown. Changing the
  // name or the address withdraws it, so it never covers a payee not shown. On a close match the name the paper bank
  // holds can be taken instead, which is a match.
  const [checked, setChecked] = useState(false), [asked, setAsked] = useState<Asked | null>(null)
  const first = useRef<HTMLDivElement>(null)
  // opened by a press (not on arrival, when there is no payee yet): the first field takes focus
  useEffect(() => { if (focus) first.current?.querySelector('input')?.focus() }, [focus])
  const add = useAction(async (as?: string) => {
    const n = as ?? name
    // the server trims the name and lower-cases the address; the confirmation is sent only for exactly what was shown
    const confirmed = !!asked && checked && n.trim() === asked.name && handle.trim().toLowerCase() === asked.handle
    if (!confirmed) {
      // asked first, with nothing saved, so that a payee that needs confirming is shown without a refused request
      const c = await api<CheckAnswer>('POST', '/api/payees/check', { name: n, handle, category })
      if (c.needsConfirmation) {
        setAsked({ outcome: c.nameCheck.outcome === 'match' ? null : c.nameCheck.outcome, registered: c.nameCheck.registeredName, look: c.lookalike, name: n.trim(), handle: handle.trim().toLowerCase() })
        setChecked(false)
        return
      }
    }
    const confirm = confirmed ? { ...(asked!.look ? { lookalikeChecked: true } : {}), ...(asked!.outcome ? { nameCheckAccepted: asked!.outcome } : {}) } : {}
    const p = await api<{ id: string }>('POST', '/api/payees', { name: n, handle, category, ...confirm })
    setName(''); setHandle(''); setChecked(false); setAsked(null); onAdded(p.id)
  })
  // adding still refuses an answer that was not confirmed (for instance one that changed since it was asked): shown the same way
  useEffect(() => {
    const e = add.error
    if (!e || (e.code !== 'lookalike' && e.code !== 'payee_check')) return
    const o = e.fields.nameCheck
    const outcome = isNameOutcome(o) ? o : null, registered = e.fields.registeredName ?? null
    setAsked({ outcome, registered, look: e.fields.lookalike ?? (e.code === 'lookalike' ? e.message : null), name: name.trim(), handle: handle.trim().toLowerCase() })
    setChecked(false)
  }, [add.error]) // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setChecked(false); setAsked(null); if (add.error) add.clear() }
  const useRegistered = (registered: string) => { setName(registered); setChecked(false); setAsked(null); add.clear(); void add.run(registered) }
  const f = add.error?.fields ?? {}
  const fieldErrors = !!(f.name || f.handle)
  return (
    <form className="pay-add-form" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
      <div className="form-grid cols-3 fields pay-add-fields" ref={first}>
        <Field label="Name" error={f.name}>{(p) => <input {...p} className="input" value={name} maxLength={60} onChange={(e) => edit(setName)(e.target.value)} />}</Field>
        <Field label="Payment address" hint="Such as name@bank. QED compares it with your payees for look-alikes." error={f.handle}>{(p) => <input {...p} className="input" autoCapitalize="none" spellCheck={false} value={handle} maxLength={80} onChange={(e) => edit(setHandle)(e.target.value)} />}</Field>
        <Field label="Kind">{(p) => <select {...p} className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}</select>}</Field>
      </div>
      {asked ? <Note tone="wait" title={asked.look ? 'This may be a look-alike payee' : asked.outcome ? ASKED_TITLE[asked.outcome] : undefined}>
        {asked.look ? <p className="small" role="alert">{asked.look}</p> : null}
        {asked.outcome ? <div className="pay-namecheck">
          <div className="pay-namecheck-says" role="alert">
            <dl className="pay-names">
              <div><dt>You gave</dt><dd>{asked.name}</dd></div>
              <div><dt>The paper bank holds</dt><dd>{asked.registered ?? (asked.outcome === 'no_match' ? 'Another name. It does not say which.' : 'Nothing it could check')}</dd></div>
            </dl>
            <p className="small">{nameCheckAdvice(asked.outcome)}</p>
          </div>
          {asked.outcome === 'close' && asked.registered ? <div><Btn small busy={add.busy} onClick={() => useRegistered(asked.registered!)}>Use the registered name</Btn></div> : null}
        </div> : null}
        <label className="check pay-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked this address with the payee myself, not from a message or a call</label>
      </Note> : add.error && !fieldErrors ? <Problem error={add.error} /> : null}
      <div className="pay-add-go"><Btn type="submit" tone={asked ? undefined : 'fill'} busy={add.busy} disabled={!!asked && !checked}>{asked ? (asked.outcome === 'close' ? 'Add it with the name I gave' : 'Add it anyway') : 'Add this payee'}</Btn>
        <p className="pay-quiet">The name is checked before the payee is saved. A match cannot tell who controls the account.</p></div>
      <details className="disclose pay-add-more"><summary>What the name check is, and a new payee's first day</summary>
        <p>Before a payee is saved, QED checks the name you give against the paper bank's own directory on this computer, not a real bank or NPCI. A match cannot tell who controls the account, or whether someone is pressing you to pay. {rule.off ? 'Payments to a new payee do not wait: you switched that off in Safeguards.' : `In a payee's first 24 hours, a payment that takes what you send it above ${fmt.money(rule.above)} waits ${rule.wait} before it is sent.`}</p>
      </details>
    </form>
  )
}

// ------------------------------------------------------------------------------------------------ bills, and who pays them

function BillsOnRecord({ home, payees, bills, payers, uncovered, now, onChanged }: { home: Home; payees: Payee[]; bills: Bill[]; payers: ProgramSummary[]; uncovered: Map<string | undefined, string>; now: number; onChanged: () => void }) {
  const [addingBill, setAddingBill] = useState(false)
  // Removing a bill that is counted in what must stay in the bank needs the passkey; the server says when.
  const removeBill = useStepUpWhenAsked(async (id: string) => { await api('POST', `/api/bills/${id}/cancel`); onChanged() })
  const waiting = bills.filter((b) => b.state === 'due' || b.state === 'failed').sort((a, b) => a.due_at - b.due_at)
  const settled = bills.filter((b) => b.state !== 'due' && b.state !== 'failed').slice(0, 8)
  const payerOf = (b: Bill) => payers.find((p) => p.state === 'active' && ((p.params.payeeHandles as string[] | undefined) ?? []).includes(b.payee_handle) && b.amount <= Number(p.params.capPerBill ?? 0))
  return (
    <section className="panel pay-bills" aria-labelledby="bills-h">
      <div className="pay-sec-head">
        <div><h2 id="bills-h">Bills on record</h2><p>{payers.length ? 'Each says who pays it. An instruction pays only the payees it names, up to its cap, inside its limit.' : 'No instruction pays bills for you: each stays unpaid until you pay it.'}</p></div>
        {addingBill ? null : <Btn onClick={() => setAddingBill(true)}><CalendarClock aria-hidden="true" />Put a bill on record</Btn>}
      </div>
      {payers.length ? (
        <ul className="pay-payers" aria-label="Instructions that pay bills">
          {payers.map((p) => { const l = monthLeft(p); return (
            <li key={p.id} className={p.state === 'paused' ? 'paused' : ''}>
              <span className="pay-payer"><Link to={`/instructions/${p.id}`}>{p.title}</Link><small>{p.state === 'paused' ? 'Paused: it pays nothing until you resume it' : `${MODE_WORD[p.authority?.runMode ?? 'auto'] ?? ''}. At most ${fmt.money(Number(p.params.capPerBill ?? 0))} for one bill`}</small></span>
              {l ? <Bound used={p.usedThisMonth ?? 0} limit={l.of} period="this month" /> : <span />}
              <StateStamp state={p.state} />
            </li>
          ) })}
        </ul>
      ) : null}
      {waiting.length === 0 ? <EmptyState across compact icon={<CalendarClock />} title="No bill is waiting to be paid">Put one on record and an instruction can pay it when it falls due.</EmptyState> : (
        <ul className="pay-bill-list">
          {waiting.map((b) => {
            const open = uncovered.has(b.id), payer = payerOf(b)
            return (
              <li key={b.id} className={open ? 'needs' : ''}>
                <span className="when">{nearDay(b.due_at, now)}<small>{fmt.time(b.due_at)}</small></span>
                <span className="what"><b>{b.payee_name}</b><small>{b.memo || b.payee_handle}</small></span>
                <span className={`who ${open && !b.paying ? 'due' : ''}`}>{b.paying?.state === 'held' ? 'A payment for it is on hold, waiting to be sent; it is not offered again unless that payment is cancelled or fails. ' : b.paying ? 'A payment for it is on its way; it is not offered again unless that payment fails. ' : b.state === 'failed' ? 'The last attempt failed and the money came back. ' : ''}{open ? `${uncovered.get(b.id)} It stays unpaid unless you pay it.` : payer ? <>QED pays it when due, under <Link to={`/instructions/${payer.id}`}>{payer.title}</Link></> : 'An instruction pays it when it falls due.'}</span>
                <span className="amt">{fmt.money(b.amount, true)}</span>
                <span className="acts">
                  {b.paying?.state === 'held'
                    ? <Link className="btn sm quiet" to={`/record/${b.paying.id}`}>Payment on hold<span className="sr">: {b.payee_name}, {fmt.money(b.amount, true)}; see it, or cancel it, on its record</span></Link>
                    : b.paying
                    ? <Link className="btn sm quiet" to="/activity">Payment on its way<span className="sr">: {b.payee_name}, {fmt.money(b.amount, true)}; follow it in Activity</span></Link>
                    : <Link className="btn sm" to={`/pay?bill=${b.id}#pay-review`}>Pay it now<span className="sr">: {b.payee_name}, {fmt.money(b.amount, true)}</span></Link>}
                  {b.removal
                    ? <Link className="btn sm quiet" to="/security">Removal waiting until {fmt.dayTime(b.removal.effectiveAt)}<span className="sr">: {b.payee_name}, {fmt.money(b.amount, true)}; any passkey can cancel it under Security and recovery</span></Link>
                    : <Btn small tone="quiet" busy={removeBill.busy} onClick={() => void removeBill.run(b.id)}>Remove the bill<span className="sr">: {b.payee_name}, {fmt.money(b.amount, true)}</span></Btn>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {/* confirming with the passkey removes the bill by itself (useStepUpWhenAsked tries again): no second press is asked for */}
      {removeBill.field ? <div className="note pay-stepup">{removeBill.field}</div> : null}
      <Problem error={removeBill.error} />
      {addingBill ? <div className="pay-add-bill"><div className="pay-add-head"><h3>Put a bill on record</h3><button type="button" className="icon-btn" aria-label="Close putting a bill on record" onClick={() => setAddingBill(false)}><X aria-hidden="true" /></button></div><AddBill payees={payees} onAdded={() => { setAddingBill(false); onChanged() }} /></div> : null}
      {settled.length ? (
        <details className="disclose pay-settled">
          <summary>Bills already dealt with ({settled.length})</summary>
          <ul>{settled.map((b) => <li key={b.id}><span className="what"><b>{b.payee_name}</b><small>{b.state === 'paid' ? 'Paid' : cap(b.state)}, was due {fmt.day(b.due_at)}{b.action_id ? <>. <Link to={`/record/${b.action_id}`}>See the payment</Link></> : null}</small></span><span className="amt">{fmt.money(b.amount, true)}</span></li>)}</ul>
        </details>
      ) : null}
    </section>
  )
}

function AddBill({ payees, onAdded }: { payees: Payee[]; onAdded: () => void }) {
  const now = useNow(60_000)
  const [payeeId, setPayeeId] = useState(payees[0]?.id ?? ''), [amount, setAmount] = useState<number | null>(null), [date, setDate] = useState(''), [time, setTime] = useState('10:00'), [memo, setMemo] = useState('')
  useEffect(() => { if (!payeeId && payees[0]) setPayeeId(payees[0].id) }, [payees, payeeId])
  const add = useAction(async () => {
    const dueAt = date ? Date.parse(`${date}T${time || '10:00'}:00+05:30`) : NaN
    await api('POST', '/api/bills', { payeeId, amount: amount ?? 0, dueAt: Number.isFinite(dueAt) ? dueAt : 0, memo })
    setAmount(null); setMemo(''); setDate(''); onAdded()
  })
  const f = add.error?.fields ?? {}
  return (
    <form className="pay-add-form" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
      {payees.length === 0 ? <p className="pay-quiet">Add the payee first, in the journey above; a bill is always from one of your payees.</p> : null}
      <div className="form-grid cols-2 fields pay-bill-fields">
        <Field label="From" error={f.payeeId}>{(p) => <select {...p} className="input" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>{payees.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select>}</Field>
        <Field label="Amount" error={f.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label="Due on" error={f.dueAt}>{(p) => <input {...p} className="input" type="date" min={todayIst(now)} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="At (India time)">{(p) => <input {...p} className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
      </div>
      <div className="form-grid fields"><Field label="What it is for" hint="Optional.">{(p) => <input {...p} className="input" maxLength={80} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field></div>
      {add.error && Object.keys(f).length === 0 ? <Problem error={add.error} /> : null}
      <div className="pay-add-go"><Btn tone="fill" type="submit" busy={add.busy} disabled={payees.length === 0}>Put this bill on record</Btn></div>
    </form>
  )
}

// ------------------------------------------------------------------------------------------------ what has been paid

function PaymentsSoFar({ actions, disputes, error, loading }: { actions: ActionView[]; disputes: Dispute[]; error: ApiError | null; loading: boolean }) {
  const payments = actions.filter((a) => a.kind === 'payment').slice(0, 12)
  const byAction = new Map(disputes.map((d) => [d.action_id, d]))
  return (
    <section className="panel pay-paid" aria-labelledby="sent-h">
      <div className="pay-sec-head"><div><h2 id="sent-h">Payments so far</h2><p>By you and by QED, newest first. Each opens its record and receipt.</p></div><Link className="pay-all" to="/activity">All activity</Link></div>
      {error ? <Problem error={error} /> : loading ? <p className="loading-line" aria-busy="true">Reading payments…</p> : payments.length === 0 ? <EmptyState across compact icon={<ArrowUpRight />} title="No payment has been made yet">The first one you send appears here, with its record and receipt.</EmptyState> : (
        <ul className="pay-paid-list">
          {payments.map((a) => {
            const d = byAction.get(a.id)
            return (
              <li key={a.id}>
                <span className="when">{fmt.day(a.createdAt)}<small>{fmt.time(a.createdAt)}</small></span>
                <span className="what"><Link to={`/record/${a.id}`}>{a.what}</Link>
                  <small><span className={a.origin === 'owner' ? 'by-you' : 'by-qed'}>{a.origin === 'owner' ? 'By you' : a.origin === 'commerce' ? 'By QED, within your mandate' : 'By QED'}</span>{a.params.memo ? `, ${a.params.memo}` : ''}{a.error ? `. ${a.error}` : ''}{d ? `. Dispute ${d.state === 'open' ? 'open' : d.state === 'resolved_refund' ? 'settled: refunded' : 'settled: the payment stands'}` : ''}{a.packReason ? <>. <Link to={`/record/${a.id}/pack`}>Dispute pack</Link></> : null}</small></span>
                <span className="state"><StateStamp state={a.state} recon={a.reconState} /></span>
              </li>
            )
          })}
        </ul>
      )}
      <details className="disclose pay-repeat"><summary>When a payment that repeats an earlier one is held</summary><p>{REPEAT_RULE}</p></details>
    </section>
  )
}

function SpendHead() {
  return (
    <header className="page-head pay-head">
      <div>
        <h1>Spend</h1>
        <p>Pay someone yourself, once. Each step settles one figure; your passkey signs exactly those figures, and you follow the payment to its receipt here.</p>
      </div>
      <Link className="btn" to="/instructions/new?kind=bills"><CalendarClock aria-hidden="true" />Set up a repeating payment</Link>
    </header>
  )
}

function SpendSkeleton() {
  return (
    <div className="pay-checkout" aria-busy="true">
      <p className="loading-line sr">Reading payees and bills…</p>
      <section className="panel pay-journey pay-skel" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="pay-skel-row"><span className="skel" /><span className="skel" /></div>)}
      </section>
      <section className="panel pay-summary pay-skel" aria-hidden="true"><span className="skel" style={{ height: 180 }} /></section>
    </div>
  )
}
