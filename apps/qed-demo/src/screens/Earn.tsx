/**
 * Earn (design system "Meridian", DESIGN.md M1 to M11). Each earning job is read as one journey, from the offer to the
 * money arriving, on one route of five stations: the offer and its terms; the escrow, where the client's money is held;
 * the work, submitted or delivered; the decision (the paper client accepts or disputes; on the chain the verifier
 * checks the certificate); and settlement, paid to you or back to the client. Every milestone of a job sits on that
 * route on one line: the stations it has passed drawn solid, the station where it waits lit in the colour of whose move
 * it is (amber: yours; blue: the other side's; red: a dispute), its state and whose move in words beside it, its amount
 * and the move itself. Above a job's milestones the route is named once, and the stations where money is held are
 * bracketed with what the job holds now.
 *
 * The page opens on what is held in escrow for you, at true scale beside what was paid and what went back, and on who
 * acts next across every job: one numbered sequence of steps, the owner's own first, each with whose move it is, the
 * move, where its step stands in the shared status words (DESIGN.md M12), its deadline and its amount. Then the jobs on
 * paper and the jobs paid through the escrow on the chain, each kind under the terms it is paid on. Then money in: one
 * day book, what is expected above today and what arrived below it.
 *
 * Held in escrow is never counted as earned: income counts only once it is on record. In this practice build the paper
 * client's part is played by the owner, and the screen says so wherever it appears. A step on the chain is approved by
 * the passkey's signature over its exact terms (useVaultApproval); pressing a button here is never the authorisation.
 * The head is drawn before any data (M11); only the parts that read data wait for it.
 */
import { Check, ChevronRight, Plus, RotateCcw, X } from 'lucide-react'
import { lazy, type MouseEvent, type ReactNode, Suspense, useEffect, useId, useState } from 'react'
import { api, fmt, type Resource, useData, useNow } from '../lib/core.ts'
import { nearDay } from '../lib/words.ts'
import type { Home, PassbookView, ProgramDetail, ProgramSummary, Receipt, RunView } from '../lib/types.ts'
import { Btn, Field, Link, Loading, MoneyInput, Note, Problem, Seal, Sheet, Stamp, StateStamp, stateWord, useAction } from '../ui/kit.tsx'
import { Rupees } from './Home.tsx'
import { Acceptances, type Choice, choiceFields, defaultChoice, momentWords, type Outcome, outcomeWords, periodWords, type Policy, type TermsDoc, TermsChooser, TermsList, type TermsView, useTermsPreview } from '../ui/earn-terms.tsx'

/*
 * Two parts of the page come with code the head should not wait for (M11): the work through the escrow on the chain
 * brings the on-chain wallet's approval (useVaultApproval, Vault.tsx), and the income instruction's status line
 * (statusLine, Instructions.tsx) brings Protect. Both load after the head has drawn; the chain's starts at once.
 */
let chainModule: Promise<typeof import('../ui/earn-chain.tsx')> | null = null
const loadChain = () => (chainModule ??= import('../ui/earn-chain.tsx'))
const ChainWork = lazy(() => loadChain().then((m) => ({ default: m.ChainWork })))
/** The work directory (R13 E4): its own module, loaded with the chain's, since a chosen quote becomes work on the chain. */
const Directory = lazy(() => import('../ui/earn-directory.tsx').then((m) => ({ default: m.Directory })))
const SplitStatus = lazy(() => import('./Instructions.tsx').then((m) => ({ default: ({ p, now }: { p: ProgramSummary; now: number }) => <>{m.statusLine(p, now)}</> })))

/**
 * A paper milestone as GET /api/earn gives it (server/escrow.ts): its deadline (worked out from its accepted terms and
 * the step that started it), its terms or none (a milestone from before terms were recorded), a pending proposal of
 * terms, each side's standing offer to settle, its dispute, every step on record, who acts next (actor, step, deadline,
 * what happens on inaction: the same four parts a step on the chain is said in), the moves open to each part, and which
 * parts the signed-in member plays. A milestone on the chain is listed here too, with its state only.
 */
export interface PaperThen { kind: string; toEarner?: number; toClient?: number }
export interface PaperNext { actor: 'earner' | 'client' | 'mediator' | 'rule' | 'both'; step: string; by: number | null; then: PaperThen }
export interface PaperDispute {
  raisedBy: 'client' | 'earner'; against: 'work' | 'refund'; reason: string; raisedAt: number; evidenceDueAt: number; decideBy: number; heardAt: number | null
  state: 'open' | 'decided'; outcome: string | null; toEarner: number | null; toClient: number | null; decidedBy: string | null; decidedAt: number | null
}
export interface PaperStep { ts: number; actor: string; step: string; person?: string | null; detail: Record<string, unknown> }
export interface Offer { outcome: 'released' | 'refunded' | 'split'; toEarner: number; toClient: number; at: number }
export type Part = 'earner' | 'client' | 'mediator'
export interface Milestone {
  id: string; title: string; amount: number; state: string; evidence_hash: string | null; updated_at: number
  dueAt?: number | null; paid?: number; back?: number; dispute?: PaperDispute | null; steps?: PaperStep[]; next?: PaperNext | null
  can?: Record<Part, string[]>; legacy?: boolean; problem?: string | null; terms?: TermsView | null
  proposal?: { termsId: string; hash: string; terms: TermsDoc; by: 'earner' | 'client'; at: number } | null
  offers?: { earner: Offer | null; client: Offer | null }; you?: Part[]
}
export interface Job { id: string; title: string; client: string; state: string; created_at: number; terms?: TermsView | null; milestones: Milestone[] }
interface EarnView { jobs: Job[]; policy?: Policy; business?: boolean; members?: { personId: string; name: string; role: string }[]; you?: string | null }
interface Entry { id: string; seq: number; ts: number; effective_ts: number; kind: string; memo: string; ref: string; meta: Record<string, unknown>; lines: { code: string; amount: number }[] }

// ------------------------------------------------------------------------------------------------ where a milestone stands

/**
 * Where a milestone stands: the stage its money has reached, how it ended if it ended early, and whose move it is.
 * `unknown`: a milestone on the chain while the on-chain wallet's service does not answer. Its stage is the last one
 * read; whose move it is cannot be known, so it is never drawn or said as anyone's.
 */
export interface Place { at: -1 | 0 | 1 | 2 | 3; end: 'disputed' | 'refunded' | 'lapsed' | null; turn: 'you' | 'them' | 'none' | 'unknown' }
const STAGES = ['Offered', 'In escrow', 'Work submitted', 'Paid']

/**
 * A paper milestone: opened with the client's money already in escrow. A refund keeps the stage it was reached from; a
 * dispute over the client taking the money back waits at the decision without having passed the work. In a dispute the
 * move is yours when your answer is the one awaited. A split is paid (its part back to the client is told apart by
 * paperItems).
 */
export function paperPlace(m: { state: string; evidence_hash: string | null; next?: PaperNext | null }): Place {
  // whose move: the earner's, or both sides' (which on paper is the household's), is yours
  const yours = m.next ? m.next.actor === 'earner' || m.next.actor === 'both' : null
  switch (m.state) {
    case 'proposed': return { at: 0, end: null, turn: 'them' }
    case 'funded': return { at: 1, end: null, turn: yours === false ? 'them' : 'you' }
    case 'refund-asked': return { at: 1, end: null, turn: yours === false ? 'them' : 'you' }
    case 'submitted': return { at: 2, end: null, turn: yours ? 'you' : 'them' }
    case 'disputed': return { at: m.evidence_hash ? 2 : 1, end: 'disputed', turn: yours ? 'you' : 'them' }
    case 'released': case 'split': return { at: 3, end: null, turn: 'none' }
    case 'refunded': return { at: m.evidence_hash ? 2 : 1, end: 'refunded', turn: 'none' }
    default: return { at: 1, end: null, turn: 'none' }
  }
}
/**
 * A paper milestone's money for the page's sums: one item, or for a split two, its part paid to you and its part back to
 * the client, so paid, held and back add up to the paisa to what the milestone was worth.
 */
export function paperItems(m: Milestone): Item[] {
  if (m.state !== 'split') return [{ amount: m.amount, place: paperPlace(m) }]
  const paid = m.paid ?? 0
  return [{ amount: paid, place: { at: 3, end: null, turn: 'none' } }, { amount: m.amount - paid, place: { at: m.evidence_hash ? 2 : 1, end: 'refunded', turn: 'none' } }]
}
/**
 * A milestone on the chain: its state as the escrow reports it, and the moves the service offers this side (its turn).
 * While the service does not answer (`reachable` false) the state is the last one read and the turn is unknown.
 */
export function chainPlace(m: { state: string; actions: string[]; pending: { status: string; yours: boolean } | null }, reachable = true): Place {
  const over = m.state === 'chain-released' || m.state === 'chain-refunded' || m.state === 'chain-split'
  const turn = over ? 'none' : !reachable ? 'unknown' : m.pending ? (m.pending.status === 'awaiting-signature' && m.pending.yours ? 'you' : 'them') : m.actions.length ? 'you' : 'them'
  switch (m.state) {
    case 'chain-offered': return { at: 0, end: null, turn }
    case 'chain-expired': return { at: 0, end: 'lapsed', turn }
    case 'chain-funded': return { at: 1, end: null, turn }
    // the dispute step (R13 E3): verified work held for the client's review, a dispute, and a split that settled it
    case 'chain-review': return { at: 2, end: null, turn }
    case 'chain-disputed': return { at: 2, end: 'disputed', turn }
    case 'chain-split': return { at: 3, end: null, turn }
    case 'chain-released': return { at: 3, end: null, turn }
    case 'chain-refunded': return { at: 1, end: 'refunded', turn }
    default: return { at: -1, end: null, turn }
  }
}

/**
 * The tone of a milestone's stamp: amber (waiting on you) when the next move is yours, blue (in progress) when it is the
 * other side's. A dispute is red and money paid is green whoever moves next; money that went back is neutral. The stamp
 * always says it in words too.
 */
export type MoveTone = 'wait' | 'info' | 'void' | 'ok' | 'plain'
export function moveTone(p: Place): MoveTone {
  if (p.end === 'disputed') return 'void'
  if (p.at === 3) return 'ok'
  if (p.end === 'refunded') return 'plain'
  return p.turn === 'you' ? 'wait' : p.turn === 'them' ? 'info' : 'plain'
}
/** Where a milestone stands, by the name of its stage, or how it ended. */
export function stageName(p: Place): string {
  if (p.end === 'refunded') return 'Refunded'
  if (p.end === 'lapsed') return 'Offer lapsed'
  if (p.end === 'disputed') return 'Disputed'
  return p.at === -1 ? 'Not offered yet' : STAGES[p.at]!
}

// ------------------------------------------------------------------------------------------------ the route of a job

type Kind = 'paper' | 'chain'
export type Role = 'provider' | 'client'
/**
 * The five stations of a job's route, named once above its milestones. On paper the offer and the escrow are passed
 * together when the job is opened (the paper client puts the money in at once) and the client decides on delivered
 * work; on the chain the client accepts an offer by funding it, and delivery, the verifier's check and payment happen
 * in one transaction. Nouns for the stations; the stamps say where a milestone is ("In escrow"), so no station shares a
 * stamp's words.
 */
export const STATIONS: Record<Kind, readonly string[]> = { paper: ['Offer', 'Escrow', 'Work', 'Decision', 'Settled'], chain: ['Offer', 'Escrow', 'Work', 'Check', 'Settled'] }

/** The station of its job's route a milestone's money has reached: 0 (offer) to 4 (paid), -1 before the offer, null once it went back. */
export function stepOf(p: Place): number | null {
  if (p.end === 'refunded') return null
  if (p.at === 3) return 4
  if (p.end === 'disputed') return 3
  return p.at
}

type Tone = 'off' | 'ok' | 'them' | 'you' | 'void'
const RANK: Record<Tone, number> = { off: 0, ok: 1, them: 2, you: 3, void: 4 }
interface Item { amount: number; place: Place }
interface Station { amount: number; tone: Tone; early: boolean; lapsed: boolean }

/** The money of a job by station: what sits at each, what went back, and how far any of it has travelled. */
export function lineOf(kind: Kind, items: Item[]): { at: Station[]; back: number; far: number } {
  const at: Station[] = STATIONS[kind].map(() => ({ amount: 0, tone: 'off', early: false, lapsed: false }))
  let back = 0
  // paper money is in escrow from the moment the job is opened: the offer and the escrow are passed together
  let far = kind === 'paper' ? 1 : -1
  for (const { amount, place } of items) {
    const s = stepOf(place)
    if (s === null) { back += amount; far = Math.max(far, place.at); continue }
    far = Math.max(far, s)
    const x = at[Math.max(0, s)]!
    x.amount += amount
    if (s < 0) x.early = true
    if (place.end === 'lapsed') x.lapsed = true
    // a lapsed offer keeps the colour of whose move it is (offering it again is the provider's)
    const tone: Tone = place.end === 'disputed' ? 'void' : s === 4 ? 'ok' : place.turn === 'you' ? 'you' : place.turn === 'them' ? 'them' : 'off'
    if (RANK[tone] > RANK[x.tone]) x.tone = tone
  }
  return { at, back, far }
}

/** A job's money in words: "₹12,000.00 in escrow and ₹18,000.00 delivered, waiting for the client." */
export function lineWords(role: Role, l: { at: Station[]; back: number }): string {
  const where = (i: number, x: Station): string => i === 0 ? (x.early ? 'not offered yet' : x.lapsed ? 'offered; the offer lapsed' : 'offered, not funded yet')
    : i === 1 ? 'in escrow' : i === 2 ? 'delivered, waiting for the client' : i === 3 ? 'disputed' : role === 'client' ? 'paid to them' : 'paid to you'
  const parts = l.at.flatMap((x, i) => (x.amount > 0 ? [`${fmt.inr(x.amount, true)} ${where(i, x)}`] : []))
  if (l.back > 0) parts.push(`${fmt.inr(l.back, true)} back to ${role === 'client' ? 'you' : 'the client'}`)
  return parts.length ? `${listed(parts)}.` : 'Nothing on this job yet.'
}

/**
 * Where one milestone is on its route, for drawing it: the last station it has passed (`reach`, -1 for none), the
 * station where it waits and in whose colour (`next`, `tone`), and how it ended (paid, or back to the client). A draft
 * waits before the offer (`early`); a lapsed offer waits at the offer again (`lapsed`); a dispute waits at the decision,
 * in red. Paid and returned money waits nowhere.
 */
export interface Track { reach: number; next: number | null; tone: 'you' | 'them' | 'void' | 'none'; end: 'paid' | 'back' | null; early: boolean; lapsed: boolean }
export function trackOf(p: Place): Track {
  const s = stepOf(p)
  const tone = p.turn === 'you' ? 'you' : p.turn === 'them' ? 'them' : 'none'
  if (s === null) return { reach: p.at, next: null, tone: 'none', end: 'back', early: false, lapsed: false }
  if (s === 4) return { reach: 4, next: null, tone: 'none', end: 'paid', early: false, lapsed: false }
  if (p.end === 'disputed') return { reach: p.at, next: 3, tone: 'void', end: null, early: false, lapsed: false }
  if (p.end === 'lapsed') return { reach: -1, next: 0, tone, end: null, early: false, lapsed: true }
  if (s < 0) return { reach: -1, next: 0, tone, end: null, early: true, lapsed: false }
  return { reach: s, next: s + 1, tone, end: null, early: false, lapsed: false }
}

// ------------------------------------------------------------------------------------------------ where the money of the work is

export interface Parts { paid: number; held: number; back: number; open: number }
/** A kind of work's money by where it is: paid, held in escrow, gone back to the client, offered but not funded yet. */
export function partsOf(items: Item[]): Parts {
  const p: Parts = { paid: 0, held: 0, back: 0, open: 0 }
  for (const { amount, place } of items) {
    const s = stepOf(place)
    if (s === null) p.back += amount
    else if (s === 4) p.paid += amount
    else if (s >= 1) p.held += amount
    else p.open += amount
  }
  return p
}

/**
 * What is held split by whose move it waits on: yours (the work is yours to do), the other side's, or disputed. The
 * three add up to the paisa to what partsOf calls held; paid, back and open are the same figures as there.
 */
export interface Standing { paid: number; you: number; them: number; disputed: number; back: number; open: number; youN: number; themN: number; disputedN: number }
export function standingOf(items: Item[]): Standing {
  const s: Standing = { paid: 0, you: 0, them: 0, disputed: 0, back: 0, open: 0, youN: 0, themN: 0, disputedN: 0 }
  for (const { amount, place } of items) {
    const step = stepOf(place)
    if (step === null) s.back += amount
    else if (step === 4) s.paid += amount
    else if (step < 1) s.open += amount
    else if (place.end === 'disputed') { s.disputed += amount; s.disputedN++ }
    else if (place.turn === 'you') { s.you += amount; s.youN++ }
    else { s.them += amount; s.themN++ }
  }
  return s
}

/** Whose move it is, in words: the stamp's colour never says it alone. */
export function whose(p: Place, role: Role, sending: boolean): string {
  if (p.turn === 'unknown') return 'Whose move: not known'
  if (p.turn === 'you') return 'Your move'
  if (p.turn === 'none') return 'Finished'
  if (sending) return 'Being recorded on the chain'
  return role === 'client' ? 'The provider\'s move' : 'The client\'s move'
}

// ------------------------------------------------------------------------------------------------ who acts next

/**
 * Where the step a move belongs to stands, in the shared status words (DESIGN.md M12, kit.tsx STATE_WORDS) wherever
 * they say it, so Earn reads as the rest of QED does: Pending (accepted, not finished), Submitted (sent, no answer
 * yet), Awaiting your approval (asked for, waiting for your passkey), Expired, Draft. Those with no shared word keep
 * Earn's own: a paper dispute, a step waiting for the other side's passkey, a refund asked for, terms proposed, money a
 * timeout left locked, and work that has no agreed terms.
 */
export type MoveStatus = 'working' | 'submitting' | 'awaiting_approval' | 'expired' | 'draft' | 'disputed' | 'awaiting_theirs' | 'refund_asked' | 'terms_proposed' | 'locked' | 'no_terms'
const OWN_STATUS: Partial<Record<MoveStatus, [string, 'void' | 'info' | 'wait' | 'plain']>> = {
  disputed: ['Disputed', 'void'], awaiting_theirs: ['Awaiting their approval', 'info'], refund_asked: ['Refund asked', 'wait'],
  terms_proposed: ['Terms proposed', 'wait'], locked: ['Locked in escrow', 'wait'], no_terms: ['No agreed terms', 'plain'],
}
export const moveStatusWord = (s: MoveStatus): string => OWN_STATUS[s]?.[0] ?? stateWord(s)
function MoveStamp({ s }: { s: MoveStatus }) {
  const own = OWN_STATUS[s]
  return own ? <Stamp tone={own[1]}>{own[0]}</Stamp> : <StateStamp state={s} />
}

/**
 * The next move on a milestone. `who`: yours ('you', on the chain), yours in a part on paper ('earner', 'client',
 * 'mediator', or 'both' sides, which on paper you play each), another member's, another QED account's, the chain's or the
 * paper escrow's own at a deadline ('other', with its `name`), or not known while the on-chain wallet's service does not
 * answer ('unknown'). `by`: its deadline in the page's words, open (by, until, lapses) or passed (lapsed, was due).
 * `then`: what happens if nobody takes it.
 */
export type MoveWho = 'you' | 'earner' | 'client' | 'mediator' | 'both' | 'other' | 'unknown'
export type DeadlineWord = 'by' | 'until' | 'lapses' | 'lapsed' | 'was due'
export interface Move {
  id: string; who: MoveWho; name: string | null; what: string; title: string; job: string; amount: number; test: boolean
  status: MoveStatus | null; by: { word: DeadlineWord; at: string } | null; then: string | null
  /** With no deadline, why there is none ("No agreed deadline"); "No deadline" when not given. */
  none?: string
}
const OPEN_DEADLINE: ReadonlySet<DeadlineWord> = new Set(['by', 'until', 'lapses'])

/** The step a paper milestone waits on, as its taker would say it (server/escrow.ts nextOf names the step). */
export const PAPER_STEP: Record<string, string> = {
  submit: 'Submit the work', 'submit-late': 'Submit the work, late', 'answer-refund': 'Agree to give the money back, or dispute it',
  review: 'Accept the work or dispute it', 'answer-dispute': 'Answer the dispute with evidence', decide: 'Decide the dispute',
  'review-ended': 'Applies the terms: the client\'s review has ended', 'answer-ended': 'Applies the terms: the time to answer has ended',
  'evidence-ended': 'Applies the terms: the dispute went unanswered', 'decision-ended': 'Applies the terms: no decision came in time',
  'agree-terms': 'Agree terms for it', 'accept-terms': 'Accept the terms proposed, or propose others', 'agree-outcome': 'Agree how to settle it',
  'accept-job-terms': 'Accept the terms, which puts the money in escrow',
}
const PAPER_STATUS: Record<string, MoveStatus> = {
  submit: 'working', 'submit-late': 'expired', 'answer-refund': 'refund_asked', review: 'submitting', 'answer-dispute': 'disputed', decide: 'disputed',
  'review-ended': 'working', 'answer-ended': 'working', 'evidence-ended': 'working', 'decision-ended': 'working', 'agree-terms': 'no_terms', 'accept-terms': 'terms_proposed', 'agree-outcome': 'locked', 'accept-job-terms': 'terms_proposed',
}
const PAPER_WORD: Record<string, DeadlineWord> = { submit: 'by', 'submit-late': 'was due', 'answer-refund': 'by', review: 'until', 'answer-dispute': 'by', decide: 'by', 'review-ended': 'was due', 'answer-ended': 'was due', 'evidence-ended': 'was due', 'decision-ended': 'was due' }
/** Why a paper step has no deadline: no agreed terms, no delivery date, a period that ran out leaving it locked, terms not accepted yet. */
const PAPER_NONE: Record<string, string> = { 'agree-terms': 'No agreed deadline', 'accept-terms': 'No agreed deadline', submit: 'Any time: the job has no delivery date', 'agree-outcome': 'No deadline left: the terms keep it locked', 'accept-job-terms': 'No deadline until the terms are accepted' }
/** A paper step's deadline as a step says it ("Until Tue 8 Dec, 15:42"), or why it has none. */
export function paperWhen(n: PaperNext, now: number): string {
  return n.by === null ? PAPER_NONE[n.step] ?? 'No deadline' : deadlineWords({ word: PAPER_WORD[n.step] ?? 'by', at: new Date(n.by).toISOString() }, now)
}
/**
 * What happens if nobody takes a paper milestone's next step, as its accepted terms say (the server works out the exact
 * amounts), with the word it is read under: "If not"; "Then" for the escrow's own step at a deadline that has passed;
 * "Meanwhile" for a delivery date that has passed, after which nothing happens by itself.
 */
export function paperDefault(n: PaperNext): { label: 'If not' | 'Then' | 'Meanwhile'; text: string } {
  const label = n.actor === 'rule' ? 'Then' : n.then.kind === 'client-may-take-now' ? 'Meanwhile' : 'If not'
  const when = n.actor === 'rule' ? '' : ' then'
  const t = n.then
  switch (t.kind) {
    case 'stays': return { label, text: 'It stays in escrow, and the client may ask for it back at any time' }
    case 'client-may-take': return { label, text: 'The client may ask for the money back after that' }
    case 'client-may-take-now': return { label, text: 'The client may ask for the money back now; until they do, you can still submit it' }
    case 'refund': return { label, text: `It goes back to the client${when}` }
    case 'release': return { label, text: `It is released to you${when}` }
    case 'split': return { label, text: `It is split${when}: ${fmt.inr(t.toEarner ?? 0, true)} to you, ${fmt.inr(t.toClient ?? 0, true)} to the client` }
    case 'locked': return { label, text: n.actor === 'both' ? 'Nothing happens on its own: it stays locked in escrow' : `It stays locked in escrow${when}, until both sides agree` }
    case 'nothing': return { label, text: 'Nothing happens on its own until both sides agree terms' }
    case 'not-funded': return { label, text: 'Nothing is in escrow until the paper client accepts' }
    default: return { label, text: '' }
  }
}
/** The same default as one line, for a step in "who acts next": "If not, it is released to you then". */
export function paperThen(n: PaperNext): string {
  const d = paperDefault(n)
  return d.label === 'If not' && d.text ? `If not, ${d.text.replace(/^./, (c) => c.toLowerCase())}` : d.text
}
const PART_WHO: Record<PaperNext['actor'], MoveWho> = { earner: 'earner', client: 'client', mediator: 'mediator', both: 'both', rule: 'other' }

/**
 * The next move on every milestone that has one, as one sequence: yours first (in any part you play), then the moves
 * that wait on someone else; within each, the soonest open deadline first, then the page's order. Paid and returned
 * milestones have none. In a business workspace a paper step is yours only in a part you play; another member's is
 * named. While the on-chain wallet's service does not answer, nobody's move on the chain can be known: those milestones
 * come last, as 'unknown', to be counted rather than listed.
 */
export function nextMoves(paper: Job[], chain: ChainView | null): Move[] {
  const out: Move[] = []
  for (const j of paper) for (const m of j.milestones) {
    const n = m.next
    if (!n) continue
    const mine = n.actor === 'rule' ? false : n.actor === 'both' ? (m.you ?? ['earner', 'client']).some((p) => p === 'earner' || p === 'client') : (m.you ?? [n.actor]).includes(n.actor)
    // another member's part, by name: from the terms the milestone runs under (its own, or its job's)
    const name = n.actor === 'rule' ? 'QED\'s paper escrow' : mine ? null : n.actor === 'both' ? 'The earner and the client' : (m.terms ?? j.terms)?.roleNames[n.actor] ?? 'Another member'
    out.push({ id: m.id, title: m.title, job: j.title, amount: m.amount, test: false, who: mine ? PART_WHO[n.actor] : 'other', name, what: PAPER_STEP[n.step] ?? 'Take the next step',
      status: PAPER_STATUS[n.step] ?? null, by: n.by === null ? null : { word: PAPER_WORD[n.step] ?? 'by', at: new Date(n.by).toISOString() }, then: paperThen(n) || null, ...(n.by === null ? { none: PAPER_NONE[n.step] ?? 'No deadline' } : {}) })
  }
  const all = chain ? [...chain.asProvider.map((j) => ({ j, role: 'provider' as const })), ...chain.asClient.map((j) => ({ j, role: 'client' as const }))] : []
  const at = (word: DeadlineWord, iso: string | null | undefined): Move['by'] => (iso ? { word, at: iso } : null)
  for (const { j, role } of all) {
    const { other } = otherOf(j, role)
    for (const m of j.milestones) {
      const base = { id: m.id, title: m.title, job: j.title, amount: m.amount, test: true, then: null }
      if (m.state === 'chain-released' || m.state === 'chain-refunded') continue
      if (!chain!.reachable) { out.push({ ...base, who: 'unknown', name: null, what: 'Not known until the on-chain wallet\'s service answers', status: null, by: null }); continue }
      if (m.pending) {
        const doing = DOING[m.pending.action] ?? m.pending.action
        out.push(m.pending.status === 'sending' ? { ...base, who: 'other', name: 'The chain', what: `Records ${doing}`, status: 'submitting', by: null }
          : m.pending.yours ? { ...base, who: 'you', name: null, what: `Sign ${doing}`, status: 'awaiting_approval', by: at('lapses', m.pending.expiresAt), then: 'If not, the request lapses by itself' }
          : { ...base, who: 'other', name: other, what: `Signs ${doing}`, status: 'awaiting_theirs', by: null })
        continue
      }
      const a = m.actions[0]
      if (a === 'quote') out.push(m.state === 'chain-expired' ? { ...base, who: 'you', name: null, what: 'Offer it again', status: 'expired', by: at('lapsed', m.offerValidUntil) } : { ...base, who: 'you', name: null, what: `Offer it to ${other}`, status: 'draft', by: null })
      else if (a === 'fund') out.push({ ...base, who: 'you', name: null, what: 'Fund it from your wallet', status: 'working', by: at('until', m.offerValidUntil), then: 'If not, the offer lapses and nothing moves' })
      else if (a === 'deliver') out.push({ ...base, who: 'you', name: null, what: 'Deliver the work', status: 'working', by: at('by', m.deliverBy), then: 'If not, the client may take the money back' })
      else if (a === 'refund') out.push({ ...base, who: 'you', name: null, what: role === 'client' ? 'Take the money back: no checked work came in time' : `Refund ${other}: the delivery time has passed`, status: 'expired', by: at('was due', m.deliverBy) })
      else if (m.state === 'chain-offered' && role === 'provider') out.push({ ...base, who: 'other', name: other, what: 'Funds it from their wallet', status: 'working', by: at('until', m.offerValidUntil), then: 'If not, the offer lapses and nothing moves' })
      else if (m.state === 'chain-funded' && role === 'client') out.push({ ...base, who: 'other', name: other, what: 'Delivers the work', status: 'working', by: at('by', m.deliverBy), then: 'If not, you may take the money back' })
      else if (m.state === 'chain-expired' && role === 'client') out.push({ ...base, who: 'other', name: other, what: 'Can offer it again', status: 'expired', by: at('lapsed', m.offerValidUntil) })
    }
  }
  // every part you play is yours: one group, the soonest open deadline first; then the others'; then the unknown
  const rank: Record<MoveWho, number> = { you: 0, earner: 0, both: 0, client: 0, mediator: 0, other: 1, unknown: 2 }
  const due = (m: Move): number => (m.by && OPEN_DEADLINE.has(m.by.word) ? Date.parse(m.by.at) : Infinity)
  return out.map((m, i) => ({ m, i })).sort((a, b) => rank[a.m.who] - rank[b.m.who] || (due(a.m) - due(b.m) || 0) || a.i - b.i).map((x) => x.m)
}

/** Brings a milestone into view and gives it focus, so the move is where the eye and the keyboard land. */
function jump(e: MouseEvent<HTMLAnchorElement>, id: string): void {
  if (!document.getElementById(id)) return
  e.preventDefault()
  land(id)
}
function land(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
  el.dataset.landed = ''
  window.setTimeout(() => { delete el.dataset.landed }, 1800)
}

/** The two groups of the sequence: the moves you make, in any part you play, then the others'. */
const GROUPS: { key: 'yours' | 'theirs'; who: MoveWho[]; head: string }[] = [
  { key: 'yours', who: ['you', 'earner', 'both', 'client', 'mediator'], head: 'Yours to make' },
  { key: 'theirs', who: ['other'], head: 'Waiting on others' },
]
const SEQ_CAP = 6
const WHO_WORDS: Record<Exclude<MoveWho, 'other'>, string> = { you: 'You', earner: 'You, as the earner', client: 'You, as the paper client', mediator: 'You, as the mediator', both: 'Both sides: you play each', unknown: 'Not known' }
/** A deadline as a step says it, near days by name: "Lapses today, 13:04", "Until tomorrow, 12:54", "By Fri 27 Nov, 12:54". */
export const deadlineWords = (b: NonNullable<Move['by']>, now: number): string => {
  const at = Date.parse(b.at)
  return `${b.word.replace(/^./, (c) => c.toUpperCase())} ${nearDay(at, now).replace(/^(Today|Tomorrow|Yesterday)$/, (w) => w.toLowerCase())}, ${fmt.time(at)}`
}

/**
 * One step, in the same order at every width: its number; whose move (the part you play, or the person); the move, on
 * its milestone and job; by when, and where its step stands; what happens if nobody acts; its amount. On a computer each
 * takes its own column, the same for every step; narrower, they stack in that order beside the number. The whole step
 * opens the milestone, where the move is made.
 */
function Step({ m, n, now }: { m: Move; n: number; now: number }) {
  const who = m.who === 'other' ? (m.name ?? 'The other side') : WHO_WORDS[m.who]
  return (
    <li className={`er-step w-${m.who}`}>
      <a className="er-step-go" href={`#ms-${m.id}`} onClick={(e) => jump(e, `ms-${m.id}`)}>
        <span className="er-step-n" aria-hidden="true">{n}</span>
        <span className="er-step-who"><i aria-hidden="true" />{who}<span className="sr">:</span></span>
        <span className="er-step-do"><strong>{m.what}</strong><span className="er-step-ms">{m.title}<span className="sr">, in </span><span aria-hidden="true"> · </span>{m.job}</span></span>
        <span className="er-step-meta">
          <span className="er-step-by"><span className="sr">. </span>{m.by ? deadlineWords(m.by, now) : m.none ?? 'No deadline'}</span>
          {m.status ? <span className="er-step-st"><span className="sr">. </span><MoveStamp s={m.status} /></span> : null}
        </span>
        {m.then ? <span className="er-step-then"><span className="sr">. </span>{m.then}</span> : null}
        <span className="er-step-amt"><span className="sr">. </span><span>{fmt.inr(m.amount, true)}</span>{m.test ? <small>test rupees</small> : null}</span>
        <ChevronRight className="er-step-to" aria-hidden="true" />
      </a>
    </li>
  )
}

/**
 * Who acts next, as one sequence of numbered steps: the moves you make first, in any part you play, then those that wait
 * on someone else, numbered on through both, the soonest deadline first in each, every step on the same columns (named
 * once above them on a computer). Each opens its milestone on the route below. While the on-chain wallet's service does
 * not answer, the work on the chain is counted, not listed: nobody's move there can be known, and you can ask again.
 */
function NextMoves({ moves, work, business, onRetry }: { moves: Move[]; work: boolean; business: boolean; onRetry: () => void }) {
  const now = useNow(30_000)
  const unknown = moves.filter((m) => m.who === 'unknown').length
  const groups = GROUPS.map((g) => ({ ...g, list: moves.filter((m) => g.who.includes(m.who)) })).filter((g) => g.list.length > 0)
  const says: Record<'yours' | 'theirs', string> = {
    yours: business ? 'Each step names the part you take it in.' : 'On paper you play the client and the mediator too: each step names the part it is taken in.',
    theirs: 'Nothing for you to do: each says what happens if they do not act.',
  }
  let shown = 0
  return (
    <section className="panel er-next" aria-labelledby="er-next-h">
      <div className="er-next-head">
        <h2 id="er-next-h">Who acts next</h2>
        <p className="small faint">Your moves first, the soonest deadline first. Each step opens its milestone below.</p>
      </div>
      {moves.length === 0 ? (
        <div className="er-calm"><Seal size="xl" /><p>{work ? 'Nothing waits on anyone: every milestone is paid or gone back. A new job starts on its offer, below.' : 'No work yet, so nothing waits on anyone. Open a job on paper below, or prepare one for another QED account.'}</p></div>
      ) : <>
        {groups.length ? <div className="er-seq-cols" aria-hidden="true"><span>Whose move</span><span>The move</span><span>By when, and if nobody acts</span><span>Where it stands</span><span>Amount</span></div> : null}
        {groups.map((g) => {
          const start = shown + 1
          shown += Math.min(g.list.length, SEQ_CAP)
          return (
            <div key={g.key} className={`er-seq-group g-${g.key}`}>
              <div className="er-seq-h">
                <h3>{g.head}<span className="er-seq-count">{g.list.length}<span className="sr"> {g.list.length === 1 ? 'step' : 'steps'}</span></span></h3>
                <p className="small faint">{says[g.key]}</p>
              </div>
              <ol className="er-seq" role="list" start={start}>{g.list.slice(0, SEQ_CAP).map((m, i) => <Step key={m.id} m={m} n={start + i} now={now} />)}</ol>
              {g.list.length > SEQ_CAP ? <p className="er-seq-more small faint">{g.list.length - SEQ_CAP} more in the jobs below.</p> : null}
            </div>
          )
        })}
        {unknown ? (
          <div className="er-seq-unknown">
            <p><strong>Not known: the next move on {unknown} milestone{unknown === 1 ? '' : 's'} paid through the escrow on the chain.</strong> The on-chain wallet's service is not answering, so QED cannot read whose move each one is. Your work on paper is not affected.</p>
            <Btn small onClick={onRetry}>Try again</Btn>
          </div>
        ) : null}
      </>}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ what is held for you

/** The paper work's money at true scale: paid, held (on your move, on the client's, disputed), gone back. */
function Position({ jobs, chain }: { jobs: Job[]; chain: ChainView | null }) {
  const s = standingOf(jobs.flatMap((j) => j.milestones.flatMap(paperItems)))
  const held = s.you + s.them + s.disputed
  const total = s.paid + held + s.back
  const pc = (v: number) => `${((v / Math.max(1, total)) * 100).toFixed(3)}%`
  const cp = chain ? partsOf(chain.asProvider.flatMap((j) => j.milestones.map((m) => ({ amount: m.amount, place: chainPlace(m) })))) : null
  const cc = chain ? partsOf(chain.asClient.flatMap((j) => j.milestones.map((m) => ({ amount: m.amount, place: chainPlace(m) })))) : null
  const onChain = [cp && cp.held ? `${fmt.inr(cp.held, true)} held for you` : '', cp && cp.paid ? `${fmt.inr(cp.paid, true)} paid into your on-chain wallet` : '', cc && cc.held ? `${fmt.inr(cc.held, true)} of yours held for work you pay for` : ''].filter(Boolean)
  const label = `Work on paper at true scale: ${fmt.inr(s.paid, true)} paid to you, ${fmt.inr(s.you, true)} held waiting on your move, ${fmt.inr(s.them, true)} held waiting on the client${s.disputed ? `, ${fmt.inr(s.disputed, true)} held and disputed` : ''}${s.back ? `, ${fmt.inr(s.back, true)} back to the client` : ''}: ${fmt.inr(total, true)} in all, of which ${fmt.inr(held, true)} is held in escrow.`
  return (
    <section className="panel er-position" aria-labelledby="er-pos-h">
      <div className={`er-pos-main ${total ? '' : 'er-pos-solo'}`}>
        <div className="er-pos-fig">
          <div className="er-pos-head"><h2 id="er-pos-h">Held in escrow for you</h2><span className="small faint">Practice money, on paper</span></div>
          <p className={`er-hero ${held ? '' : 'none'}`} data-resolve=""><Rupees paise={held} /></p>
          <p className="er-hero-sub">{total ? 'Locked in escrow until it is released to you: when the client accepts the work, or as the job\'s terms say when a deadline passes. Until then it is not yours. On paper no account holds it: QED keeps the record.' : 'Nothing is held for you on paper. Open a job below to see how escrowed pay is delivered, decided on and released.'}</p>
          {total ? <>
            <div className="er-bar" role="img" aria-label={label}>
              <span className="er-segs">
                {s.paid ? <span className="er-seg paid" style={{ width: pc(s.paid) }} /> : null}
                {s.you ? <span className="er-seg you" style={{ width: pc(s.you) }} /> : null}
                {s.them ? <span className="er-seg them" style={{ width: pc(s.them) }} /> : null}
                {s.disputed ? <span className="er-seg disputed" style={{ width: pc(s.disputed) }} /> : null}
                {s.back ? <span className="er-seg back" style={{ width: pc(s.back) }} /> : null}
              </span>
              {held ? <span className="er-bracket" style={{ left: pc(s.paid), width: pc(held) }} /> : null}
            </div>
            <p className="er-pos-sum" aria-hidden="true"><strong>{fmt.inr(s.paid, true)}</strong> paid + <strong>{fmt.inr(held, true)}</strong> held{s.back ? <> + <strong>{fmt.inr(s.back, true)}</strong> back to the client</> : null} = <strong>{fmt.inr(total, true)}</strong> of work on paper. The bracket is what is held.</p>
          </> : null}
        </div>
        {total ? (
          <div className="er-tiles">
            <div className="tile"><p className="k"><i className="er-sw paid" aria-hidden="true" />Paid to you</p><p className="v">{fmt.inr(s.paid, true)}</p><p className="s">{s.paid ? 'Released into your bank, each with a receipt' : 'Nothing released yet'}</p></div>
            <div className="tile"><p className="k"><i className="er-sw you" aria-hidden="true" />Waits on your move</p><p className="v">{fmt.inr(s.you, true)}</p><p className="s">{s.youN ? `${s.youN} milestone${s.youN === 1 ? '' : 's'} where your step is next` : 'None: no step is yours'}</p></div>
            <div className="tile"><p className="k"><i className="er-sw them" aria-hidden="true" />Waits on the client</p><p className="v">{fmt.inr(s.them + s.disputed, true)}</p><p className="s">{s.disputed ? <><i className="er-sw disputed" aria-hidden="true" />{fmt.inr(s.disputed, true)} of it disputed</> : s.themN ? 'Delivered; the client, played by you, decides, or the job\'s terms do when the review ends' : 'Nothing delivered is waiting'}</p></div>
            <div className="tile"><p className="k"><i className="er-sw back" aria-hidden="true" />Back to the client</p><p className="v">{fmt.inr(s.back, true)}</p><p className="s">{s.back ? 'Returned from escrow; never yours' : 'Nothing returned'}</p></div>
          </div>
        ) : null}
      </div>
      {onChain.length ? <p className="er-pos-chain small">In test rupees, through the escrow on the chain{chain?.reachable === false ? ', as last read (its service is not answering)' : ''}: {listed(onChain)}. <a href="#cw-h">See that work</a></p> : null}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ a job, as one journey

/** One milestone's place on its job's route (trackOf), drawn; its state and whose move are said in words beside it. */
function Route({ kind, place }: { kind: Kind; place: Place }) {
  const t = trackOf(place)
  const last = STATIONS[kind].length - 1
  return (
    <div className={`er-track ${t.end ? `end-${t.end}` : ''}`} data-reach={t.reach} aria-hidden="true">
      <span className="er-rail" />
      <span className="er-fill" />
      {t.end === 'back' ? <span className="er-return" /> : null}
      {STATIONS[kind].map((n, i) => {
        const cls = i === last && t.end ? `end ${t.end}` : i <= t.reach ? 'done' : i === t.next ? `next t-${t.tone}${t.early ? ' early' : ''}${t.lapsed ? ' lapsed' : ''}` : t.end === 'back' ? 'er-skip' : ''
        return <i key={n} className={cls}>{i === last && t.end === 'paid' ? <Check /> : i === last && t.end === 'back' ? <RotateCcw /> : i === t.next && t.tone === 'void' ? <X /> : null}</i>
      })}
    </div>
  )
}

/** The route named once above a job's milestones, the stations where money is held bracketed with what the job holds. */
function RouteHead({ kind, held }: { kind: Kind; held: number }) {
  return (
    <div className="er-ms-head" aria-hidden="true">
      <span className="er-h-main">Milestone</span>
      <span className="er-route">
        <span className={`er-held ${held > 0 ? 'has' : ''}`}><span>{held > 0 ? `${fmt.inr(held, true)} held` : 'Nothing held'}</span></span>
        {STATIONS[kind].map((n) => <span key={n} className="er-stn">{n}</span>)}
      </span>
      <span className="er-h-state">Where it stands</span>
      <span className="er-h-amt">Amount</span>
    </div>
  )
}

/**
 * A job: its title and client, what it is worth, its terms (the agreement), its money in one sentence with whose move
 * it is, then its milestones on the route. The title is the article's name (the browser journeys find a job by it).
 */
export function JobCard({ id, kind, role, title, who, terms, items, count, test, note, children }: {
  id: string; kind: Kind; role: Role; title: string; who: ReactNode; terms?: ReactNode; items: Item[]; count?: number; test: boolean; note?: ReactNode; children: ReactNode
}) {
  const parts = partsOf(items)
  const total = items.reduce((t, x) => t + x.amount, 0)
  // a split milestone is two items (its part paid, its part back) but one milestone
  const n = count ?? items.length
  const mine = items.filter((x) => x.place.turn === 'you').length
  const turn = mine ? { k: 'you', t: `Your move on ${mine}` } : items.some((x) => x.place.end === 'disputed') ? { k: 'void', t: 'A dispute is open' }
    : items.some((x) => x.place.turn === 'unknown') ? { k: 'unknown', t: 'Whose move: not known' }
    : items.some((x) => x.place.turn === 'them') ? { k: 'them', t: role === 'client' ? 'The provider\'s move' : 'The client\'s move' } : { k: 'done', t: 'Finished' }
  const H = role === 'client' ? 'h4' : 'h3'
  return (
    <article className={`panel er-job is-${turn.k}`} aria-label={title} id={`job-${id}`}>
      <header className="er-job-head">
        <div className="er-job-name"><H>{title}</H><p className="er-job-who">{who}</p>{terms ? <p className="er-job-terms">{terms}</p> : null}</div>
        <p className="er-job-fig"><span className="er-job-total">{fmt.inr(total, true)}</span><span className="er-job-n">{n} milestone{n === 1 ? '' : 's'}{test ? ', test rupees' : ''}</span></p>
      </header>
      <div className="er-job-line">
        <p className="er-job-says">{lineWords(role, lineOf(kind, items))}</p>
        <p className={`er-turn t-${turn.k}`}><i aria-hidden="true">{turn.k === 'done' ? <Check /> : null}</i>{turn.t}</p>
      </div>
      {note}
      <RouteHead kind={kind} held={parts.held} />
      <ul className="er-ms-list">{children}</ul>
    </article>
  )
}

/** One milestone on its job's route: the title, the route, where it stands and whose move, what happens next, the amount, the move. */
export function MsRow({ id, kind, place, title, stamp, whoseMove, amount, say, actions, children }: {
  id: string; kind: Kind; place: Place; title: string; stamp: string; whoseMove: string; amount: number; say: ReactNode; actions: ReactNode; children?: ReactNode
}) {
  return (
    <li id={`ms-${id}`} className={`er-ms turn-${place.turn} ${place.end === 'disputed' ? 'disputed' : ''}`}>
      <strong className="er-ms-title">{title}</strong>
      <Route kind={kind} place={place} />
      <div className="er-ms-state"><Stamp tone={moveTone(place)}>{stamp}</Stamp><span className="er-ms-who">{whoseMove}</span></div>
      <div className="er-ms-say">{say}</div>
      <span className="er-ms-amt">{fmt.inr(amount, true)}</span>
      {actions ? <div className="er-ms-act">{actions}</div> : null}
      {children}
    </li>
  )
}

/** A form for new work, opened in place under its section's head, with its own way to close. */
export function Composer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="panel er-compose">
      <div className="er-compose-head"><h3>{title}</h3><button type="button" className="icon-btn" aria-label={`Close: ${title.toLowerCase()}`} onClick={onClose}><X aria-hidden="true" /></button></div>
      {children}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ work on paper

/** A paper milestone's state in words; its stamp's colour is whose move it is (moveTone). */
const M_STATE: Record<string, string> = { proposed: 'Terms proposed', funded: 'In escrow', submitted: 'Work submitted', 'refund-asked': 'Refund asked', released: 'Released to you', disputed: 'Disputed', refunded: 'Refunded to the client', split: 'Split' }
const lower = (s: string): string => s.replace(/^./, (c) => c.toLowerCase())
type Side = 'earner' | 'client'
type Member = { personId: string; name: string; role: string }

/**
 * Who plays each part of a paper job, as the page names them. In a personal workspace the household plays all three, and
 * the page says so wherever the client or the mediator acts (`names` null). In a business workspace each part is the
 * member the terms name, and `you` holds the parts the signed-in member plays.
 */
export interface Cast { names: { earner: string; client: string; mediator: string } | null; you: Part[] }
const PART_NOUN: Record<Part, string> = { earner: 'the earner', client: 'the paper client', mediator: 'the simulated mediator' }
/** Who takes a step, as its subject: "You", "You, as the paper client", "Chitra, as the paper client", "QED's paper escrow". */
export function partWords(part: string, c: Cast): string {
  if (part === 'rule') return 'QED\'s paper escrow'
  if (part === 'both') return c.names && !(c.you.includes('earner') && c.you.includes('client')) ? `Both sides: ${c.names.earner} and ${c.names.client}` : 'Both sides, each played by you'
  const p = part as Part
  if (!PART_NOUN[p]) return 'Someone'
  if (!c.names || c.you.includes(p)) return p === 'earner' ? 'You' : `You, as ${PART_NOUN[p]}`
  return `${c.names[p]}, as ${PART_NOUN[p]}`
}
/** Whose move a milestone waits on, beside its stamp: the colour of the stamp never says it alone. */
export function whoseMoveWords(n: PaperNext | null | undefined, c: Cast): string {
  if (!n) return 'Finished'
  if (n.actor === 'rule') return 'Due now: the escrow applies its terms'
  if (n.actor === 'both') return c.names ? 'Both sides\' move' : 'Both sides\' move, each played by you'
  if (n.actor === 'earner') return !c.names || c.you.includes('earner') ? 'Your move' : `${c.names.earner}'s move`
  const who = n.actor === 'client' ? 'client' : 'mediator'
  if (!c.names) return `The ${who}'s move, played by you`
  return c.you.includes(n.actor) ? `Your move, as the ${who}` : `${c.names[n.actor]}'s move`
}

/** The terms a paper job was opened on, in one line: the review and what its end does, and the delivery date or none. */
export function termsSummary(t: TermsDoc, now: number): string {
  const amount = t.milestones.length === 1 ? t.milestones[0]!.amount : undefined
  return `The client reviews submitted work for ${periodWords(t.review.ms)}; with no answer by then, ${outcomeWords(t.review.onTimeout, amount)}. ${t.deliverBy === null ? 'No delivery date.' : `Deliver by ${momentWords(t.deliverBy, now)}.`}`
}

/** What ended a period, in a sentence ("when the client's review ran out"). */
const PERIOD_ENDED: Record<string, string> = {
  review: 'the client\'s review ran out', answer: 'the time to answer the request for the money back ran out',
  evidence: 'the time for evidence ran out with one side unheard', decision: 'the mediator\'s deadline passed with no decision',
}
/** A paper step on record in words, after its actor's name (the history and a dispute's statements). */
export function stepWords(s: PaperStep): string {
  const d = s.detail
  const amt = (k: string) => fmt.inr(Number(d[k] ?? 0), true)
  const outcome = d.outcome === 'released' ? `released to you, ${amt('toEarner')}` : d.outcome === 'refunded' ? `refunded to the client, ${amt('toClient')}` : `${amt('toEarner')} to you, ${amt('toClient')} to the client`
  const ended = PERIOD_ENDED[String(d.period)] ?? 'a deadline passed'
  switch (s.step) {
    case 'opened': return d.termsHash ? `Accepted the terms and put ${amt('amount')} in escrow` : `Put ${amt('amount')} in escrow`
    case 'submitted': return d.late ? 'Submitted the work, after the delivery date' : 'Submitted the work'
    case 'accepted': return 'Accepted the work'
    case 'gave-way': return s.actor === 'client' ? 'Released it after all, ending the dispute' : 'Let the client have the money back, ending the dispute'
    case 'disputed':
      if (d.noTerms) return `Disputed the work${d.reason ? `: “${String(d.reason)}”` : ''}. With no agreed terms, no mediator decides it`
      return d.against === 'refund' ? `Disputed the client taking the money back: “${String(d.reason)}”` : `Disputed the work: “${String(d.reason)}”`
    case 'asked-refund': return 'Asked for the money back'
    case 'agreed': return 'Agreed to give the money back'
    case 'gave-back': return 'Gave the money back'
    case 'took-back': return 'Took the money back, as the terms it was opened on allowed'
    case 'evidence': return `Sent evidence: “${String(d.text)}”`
    case 'decided': return s.actor === 'rule' ? `Settled it by the stated rule: ${outcome}` : `Decided: ${outcome}`
    case 'timed-out': return `Applied the accepted terms when ${ended}: ${outcome}`
    case 'locked': return `Kept it locked in escrow when ${ended}, as the accepted terms say`
    case 'released': return 'Released it to you at the end of the client\'s review'
    case 'refunded': return 'Returned it to the client: the time to answer had ended'
    case 'terms-proposed': return 'Proposed terms for it, accepting them'
    case 'terms-agreed': return 'Accepted the terms proposed: they bind it from now'
    case 'offered-settlement': return `Offered to settle: ${outcome}`
    case 'settled-by-agreement': return `Offered the same as the other side, settling it: ${outcome}`
    default: return 'Took a step on it'
  }
}

/** The step that settled a milestone, and how it says it ended. */
const ENDED_BY: Record<string, (s: PaperStep) => string> = {
  accepted: () => ', when the client accepted the work',
  'gave-way': (s) => (s.actor === 'client' ? ', when the client gave way in the dispute' : ', when you gave way in the dispute'),
  agreed: () => ', when you agreed to the client\'s request', 'gave-back': () => ', when you gave it back', 'took-back': () => ', when the client took it back',
  decided: (s) => (s.actor === 'mediator' ? ', by the simulated mediator\'s decision' : ', by the stated rule'),
  'timed-out': (s) => `, by the accepted terms, when ${PERIOD_ENDED[String(s.detail.period)] ?? 'a deadline passed'}`,
  released: () => ', at the end of the client\'s review', refunded: () => ', when the time to answer ended',
  'settled-by-agreement': () => ', by agreement between the two sides',
}
/** How a settled paper milestone ended, in one sentence, in the ledger's figures (paid, and back to the client). */
export function settledWords(m: Milestone): string {
  const last = [...(m.steps ?? [])].reverse().find((s) => ENDED_BY[s.step])
  const by = last ? ENDED_BY[last.step]!(last) : ''
  const on = fmt.day(m.updated_at)
  if (m.state === 'released') return `Paid into your bank account on ${on}${by}, and recorded as earnings.`
  if (m.state === 'split') return `Split on ${on}${by}: ${fmt.inr(m.paid ?? 0, true)} paid into your bank account, ${fmt.inr(m.back ?? 0, true)} back to the client.`
  if (m.state === 'refunded') return `Returned to the client on ${on}${by}. Nothing was paid to you.`
  return ''
}

/**
 * Who acts next on a paper milestone, by when, and what happens if they do not: the same parts a step through the escrow
 * on the chain is said in (actor and step, deadline, default). A settled milestone says how it ended; terms that do not
 * match their fingerprint say so, and nothing happens to it.
 */
function PaperNextLine({ m, cast, now }: { m: Milestone; cast: Cast; now: number }) {
  if (m.problem) return <p className="er-ms-next er-ms-bad">{m.problem}</p>
  const n = m.next
  if (!n) return <p className="er-ms-next">{settledWords(m)}</p>
  const d = paperDefault(n)
  return (
    <dl className="er-pn">
      <div><dt>Next</dt><dd><strong>{partWords(n.actor, cast)}</strong>: {lower(PAPER_STEP[n.step] ?? 'take the next step')}</dd></div>
      <div><dt>When</dt><dd>{paperWhen(n, now)}</dd></div>
      <div><dt>{d.label}</dt><dd>{d.text}</dd></div>
    </dl>
  )
}

/** Who decides a paper dispute, what it may do and what it may not: named before a dispute is raised and on every one. */
export function deciderWords(c: Cast, may: string[] = ['release', 'refund', 'split']): string {
  const each = may.map((p) => (p === 'release' ? 'release this milestone to the earner' : p === 'refund' ? 'refund it to the client' : 'split it between the two in whole paise'))
  const powers = each.length <= 1 ? each.join('') : `${each.slice(0, -1).join(', ')} or ${each[each.length - 1]}`
  return `A simulated mediator, played by ${c.names ? c.names.mediator : 'you'}. Once both sides are heard it may ${powers}, as the accepted terms allow, and move no other money. It is not an arbitrator, a court or a regulated dispute service, and its decision binds no one outside this practice build.`
}
/** The side whose part a step names, as a sentence's subject ("you", "the client, played by you", "Chitra"). */
const sideSubject = (side: Side, c: Cast): string => (!c.names ? (side === 'earner' ? 'you' : 'the client, played by you') : c.you.includes(side) ? 'you' : c.names[side])

/**
 * What happens to a disputed milestone if nobody acts, as its accepted terms say: without the other side's evidence by
 * the evidence deadline, the evidence period's outcome; without a decision, the decision's. Once both sides are heard,
 * only the second.
 */
export function disputeDefaults(amount: number, raisedBy: Side, t: Pick<TermsDoc, 'evidence' | 'decision'>, raisedAt: number, heard: boolean, now: number, c: Cast = { names: null, you: ['earner', 'client', 'mediator'] }): string {
  const other: Side = raisedBy === 'client' ? 'earner' : 'client'
  const ev = t.evidence.onTimeout
  const evidence: Outcome = ev.kind === 'raiser' ? { kind: raisedBy === 'earner' ? 'release' : 'refund' } : ev
  const subject = sideSubject(other, c)
  // a subject with an aside ("the client, played by you") closes it before the verb
  const silent = heard ? '' : `If ${subject}${subject.includes(',') ? ',' : ''} ${subject === 'you' ? 'do' : 'does'} not answer by ${momentWords(raisedAt + t.evidence.ms, now)}, ${outcomeWords(evidence, amount)}. `
  return `${silent}With no decision by ${momentWords(raisedAt + t.decision.ms, now)}, ${outcomeWords(t.decision.onTimeout, amount)}.`
}

/**
 * The decider and the rule of a paper dispute under its accepted terms, and what happens to the money meanwhile and at
 * each outcome, in exact paise: shown before a dispute is raised (with the dates it would have) and on every open one.
 */
function DisputeRules({ amount, raisedBy, raisedAt, t, heard, now, cast }: { amount: number; raisedBy: Side; raisedAt: number; t: TermsDoc; heard?: boolean; now: number; cast: Cast }) {
  const other = sideSubject(raisedBy === 'client' ? 'earner' : 'client', cast)
  return (
    <dl className="er-dsp-terms">
      <div><dt>Who decides</dt><dd>{deciderWords(cast, t.mediator.may)}</dd></div>
      <div><dt>Evidence</dt><dd>From each side until {momentWords(raisedAt + t.evidence.ms, now)}, up to five statements each.{heard === undefined ? '' : heard ? ' Both sides have been heard.' : ` Waiting for ${other === 'you' ? 'your answer' : `the answer of ${other}`}.`}</dd></div>
      <div><dt>Decision</dt><dd>By {momentWords(raisedAt + t.decision.ms, now)}, once both sides have been heard.</dd></div>
      <div><dt>Meanwhile</dt><dd>{fmt.inr(amount, true)} stays locked in escrow: neither side can take it. The two sides may still settle it by agreement.</dd></div>
      <div><dt>If nobody acts</dt><dd>{disputeDefaults(amount, raisedBy, t, raisedAt, heard === true, now, cast)}</dd></div>
    </dl>
  )
}

/** A paper dispute on its milestone: who raised it and why, its decider, rule and deadlines, each side's evidence, and how it ended. */
function DisputeBox({ m, t, cast, now }: { m: Milestone; t: TermsDoc | null; cast: Cast; now: number }) {
  const d = m.dispute!
  const said = (m.steps ?? []).filter((s) => s.step === 'evidence')
  const raiser = d.raisedBy === 'client' ? (cast.names && !cast.you.includes('client') ? `${cast.names.client}, as the paper client, disputes the work` : 'The client disputes the work') : (cast.names && !cast.you.includes('earner') ? `${cast.names.earner} disputes the client taking the money back` : 'You dispute the client taking the money back')
  const how = d.decidedBy === 'mediator' ? `by the simulated mediator, played by ${cast.names ? cast.names.mediator : 'you'}` : d.decidedBy === 'rule' ? 'by the accepted terms, as nobody acted in time' : d.decidedBy === 'agreement' ? 'by agreement between the two sides' : d.decidedBy === 'client' ? 'by the client giving way' : 'by the earner giving way'
  return (
    <section className={`er-wide er-dsp ${d.state === 'open' ? 'er-dsp-open' : ''}`} aria-label={`The dispute over ${m.title}`}>
      <h4 className="er-dsp-h">{raiser}<span className="er-dsp-when">Raised {fmt.dayTime(d.raisedAt)}</span></h4>
      <p className="er-dsp-why">“{d.reason}”</p>
      {d.state === 'open' ? (t ? <DisputeRules amount={m.amount} raisedBy={d.raisedBy} raisedAt={d.raisedAt} t={t} heard={d.heardAt !== null} now={now} cast={cast} /> : null)
        : <p className="er-dsp-out"><strong>Settled {d.decidedAt ? fmt.dayTime(d.decidedAt) : ''}</strong> {how}: {d.outcome === 'released' ? `released to the earner, ${fmt.inr(m.amount, true)}` : d.outcome === 'refunded' ? `refunded to the client, ${fmt.inr(m.amount, true)}` : `${fmt.inr(d.toEarner ?? 0, true)} to the earner, ${fmt.inr(d.toClient ?? 0, true)} to the client`}.</p>}
      {said.length ? (
        <ol className="er-dsp-said" aria-label="Evidence, oldest first">
          {said.map((s, i) => <li key={i}><span className="er-dsp-by">{s.person ? s.person : s.actor === 'client' ? 'The client' : 'You'}<small>{fmt.dayTime(s.ts)}</small></span><span>“{String(s.detail.text)}”</span></li>)}
        </ol>
      ) : null}
    </section>
  )
}

/** Every step on a paper milestone, the part it was taken in, who took it and when, oldest first. */
function StepRecord({ m, cast }: { m: Milestone; cast: Cast }) {
  const steps = m.steps ?? []
  if (!steps.length) return null
  return (
    <details className="er-wide er-hist">
      <summary>Every step on record ({steps.length})</summary>
      <ol>{steps.map((s, i) => <li key={i}><span className="er-hist-when">{fmt.dayTime(s.ts)}</span><span className="er-hist-who">{s.person ? `${s.person}, as ${PART_NOUN[s.actor as Part] ?? 'a part'}` : partWords(s.actor, cast)}</span><span className="er-hist-what">{stepWords(s)}</span></li>)}</ol>
    </details>
  )
}

/** A standing offer to settle, in words: "₹6,000.00 to the earner, ₹6,000.00 to the client". */
export const offerWords = (o: Offer): string => (o.outcome === 'released' ? `all of it to the earner, ${fmt.inr(o.toEarner, true)}` : o.outcome === 'refunded' ? `all of it back to the client, ${fmt.inr(o.toClient, true)}` : `${fmt.inr(o.toEarner, true)} to the earner, ${fmt.inr(o.toClient, true)} to the client`)
/** Each side's standing offer to settle: it settles the milestone once the other side offers exactly the same. */
function Offers({ m, cast }: { m: Milestone; cast: Cast }) {
  const o = m.offers
  const sides = (['earner', 'client'] as const).filter((s) => o?.[s])
  if (!sides.length) return null
  return (
    <div className="er-wide er-offers">
      <p className="er-offers-h">Offers to settle<span className="faint">: each settles it once the other side offers exactly the same</span></p>
      <ul>{sides.map((s) => <li key={s}><span className="er-offers-who">{partWords(s, cast)}</span><span>{offerWords(o![s]!)}</span><small>{fmt.dayTime(o![s]!.at)}</small></li>)}</ul>
    </div>
  )
}

/** What a milestone from before terms allows meanwhile, by its state (server/escrow.ts refusal, the terms it was opened on). */
const LEGACY_MEANWHILE: Record<string, string> = {
  funded: 'Meanwhile you may submit the work, and the client may take the money back at any time.',
  submitted: 'Meanwhile the client may accept the work, dispute it, or take the money back at any time.',
  disputed: 'Meanwhile the client may release it after all or take the money back; no mediator decides it.',
  'refund-asked': 'Meanwhile the client may take the money back at any time.',
}
/**
 * A milestone opened before QED recorded terms: said plainly, with the way to agree terms. One side proposes complete
 * terms (accepting them) and the other accepts them; on paper the household plays both, each recorded in its part.
 */
function LegacyTerms({ m, cast, now, onPropose, onAccept }: { m: Milestone; cast: Cast; now: number; onPropose: (m: Milestone, side: Side) => void; onAccept: (m: Milestone, side: Side) => void }) {
  const p = m.proposal ?? null
  const can = m.can ?? { earner: [], client: [], mediator: [] }
  const plays = (s: Side, mv: string) => cast.you.includes(s) && can[s].includes(mv)
  const acceptor = p ? (['earner', 'client'] as const).find((s) => s !== p.by && plays(s, 'accept-terms')) : undefined
  // a counter-proposal comes from the side whose terms are not on the table; otherwise a side replaces its own
  const order: Side[] = p ? [p.by === 'earner' ? 'client' : 'earner', p.by] : ['earner', 'client']
  const proposer = order.find((s) => plays(s, 'propose-terms'))
  const other: Side | null = p ? (p.by === 'earner' ? 'client' : 'earner') : null
  // "you, as the paper client," closes its aside before the verb
  const otherWho = other ? lower(partWords(other, cast)) : ''
  return (
    <section className="er-wide er-legacy" aria-label={`Terms for ${m.title}`}>
      <p className="er-legacy-h">No agreed deadline: nothing happens on its own until both sides agree terms.</p>
      <p>It was opened before QED recorded terms, so it keeps the terms it was opened on: no deadline, no mediator and no default. {LEGACY_MEANWHILE[m.state] ?? ''}</p>
      {p && other ? <p>Terms proposed by {lower(partWords(p.by, cast))}, {fmt.dayTime(p.at)}: {lower(termsSummary(p.terms, now))} They bind it once {otherWho}{otherWho.includes(',') ? ',' : ''} {cast.names && !cast.you.includes(other) ? 'accepts' : 'accept'} them, and its deadlines start from then.</p>
        : <p>To give it deadlines, one side proposes complete terms and the other accepts them{cast.names ? '' : ': on paper you play both'}. Its deadlines start from that agreement, never before.</p>}
      {acceptor || proposer ? (
        <div className="er-legacy-acts">
          {acceptor ? <Btn small tone="fill" onClick={() => onAccept(m, acceptor)}>Read and accept, as {PART_NOUN[acceptor]}</Btn> : null}
          {proposer ? <Btn small onClick={() => onPropose(m, proposer)}>{p ? 'Propose other terms' : 'Propose terms'}, as {PART_NOUN[proposer]}</Btn> : null}
        </div>
      ) : null}
    </section>
  )
}

/** A step on paper that asks for words, or for a confirmation because it cannot be undone. */
type AskKind = 'dispute-work' | 'dispute-refund' | 'evidence-earner' | 'evidence-client' | 'give-back' | 'agree' | 'take-back' | 'decide-released' | 'decide-refunded' | 'decide-split'
interface Ask { kind: AskKind; m: Milestone; t: TermsDoc | null; cast: Cast }

function PaperSheet({ ask, onClose, onDone }: { ask: Ask | null; onClose: () => void; onDone: (said: string) => void }) {
  const [words, setWords] = useState('')
  const [paise, setPaise] = useState<number | null>(null)
  useEffect(() => { setWords(''); setPaise(null) }, [ask?.kind, ask?.m.id])
  const m = ask?.m
  const amount = m?.amount ?? 0
  const post = (path: string, body: unknown) => api('POST', `/api/earn/milestones/${m!.id}/${path}`, body)
  const go = useAction(async () => {
    if (!ask || !m) return
    const k = ask.kind
    if (k === 'dispute-work') await post('client', { decision: 'dispute', reason: words })
    else if (k === 'dispute-refund') await post('earner', { step: 'dispute', reason: words })
    else if (k === 'evidence-earner' || k === 'evidence-client') await post('evidence', { side: k === 'evidence-earner' ? 'earner' : 'client', text: words })
    else if (k === 'give-back' || k === 'agree') await post('earner', { step: k })
    else if (k === 'take-back') await post('client', { decision: 'refund' })
    else await post('decide', k === 'decide-split' ? { outcome: 'split', earnerPaise: paise ?? 0 } : { outcome: k === 'decide-released' ? 'released' : 'refunded' })
    onDone(DONE[k](m.title))
  })
  const f = go.error?.fields ?? {}
  if (!ask || !m) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const now = Date.now()
  const { kind: k, t, cast } = ask
  const raising = k === 'dispute-work' || k === 'dispute-refund'
  const writing = raising || k === 'evidence-earner' || k === 'evidence-client'
  const field = raising ? f.reason : f.text
  const head: Record<AskKind, string> = {
    'dispute-work': 'Dispute the work, as the paper client', 'dispute-refund': 'Dispute the client taking the money back', 'evidence-earner': 'Send your evidence', 'evidence-client': cast.names ? 'Send the client\'s evidence' : 'Send the client\'s evidence, played by you',
    'give-back': 'Give the money back to the client?', agree: 'Give the money back to the client?', 'take-back': 'Take the money back, as the paper client?',
    'decide-released': 'Release it to the earner?', 'decide-refunded': 'Refund it to the client?', 'decide-split': 'Split it between the two',
  }
  const press: Record<AskKind, string> = { 'dispute-work': 'Raise the dispute', 'dispute-refund': 'Raise the dispute', 'evidence-earner': 'Send it', 'evidence-client': 'Send it', 'give-back': 'Give it back', agree: 'Give it back', 'take-back': 'Take it back', 'decide-released': 'Release it', 'decide-refunded': 'Refund it', 'decide-split': 'Decide the split' }
  return (
    <Sheet open title={head[k]} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn tone={k === 'give-back' || k === 'agree' || k === 'take-back' || k === 'decide-refunded' ? 'void-fill' : 'fill'} busy={go.busy} onClick={() => void go.run()}>{press[k]}</Btn></>}>
      <p>For <strong>{m.title}</strong>: {fmt.inr(amount, true)} in escrow. Practice money, on paper.</p>
      {raising && t ? <>
        <p className="small">Before you raise it, this is who decides and how, under the terms both sides accepted, with the dates it would have if raised now:</p>
        <DisputeRules amount={amount} raisedBy={k === 'dispute-work' ? 'client' : 'earner'} raisedAt={now} t={t} now={now} cast={cast} />
      </> : null}
      {k === 'evidence-earner' || k === 'evidence-client' ? <p className="small">Each side may send up to five statements until {m.dispute && t ? momentWords(m.dispute.raisedAt + t.evidence.ms, now) : 'the evidence closes'}. The mediator reads them before deciding.</p> : null}
      {k === 'give-back' ? <p>{fmt.inr(amount, true)} goes back to the client now and you give up this milestone. It cannot be undone.</p> : null}
      {k === 'agree' ? <p>{m.state === 'disputed' ? `This ends the dispute: ${fmt.inr(amount, true)} goes back to the client and nothing is paid to you.` : `${fmt.inr(amount, true)} goes back to the client now.`} It cannot be undone.</p> : null}
      {k === 'take-back' ? <p>{fmt.inr(amount, true)} goes back to the client now, as the terms this milestone was opened on allow, and nothing is paid to you. It cannot be undone.</p> : null}
      {k === 'decide-released' || k === 'decide-refunded' ? <p>As the simulated mediator you decide that {fmt.inr(amount, true)} {k === 'decide-released' ? 'is released to the earner' : 'is refunded to the client'}, in full. QED's paper escrow carries it out at once; it cannot be undone.</p> : null}
      {k === 'decide-split' ? <>
        <p>As the simulated mediator, say what the earner receives, in whole paise; the rest goes back to the client. QED's paper escrow carries it out at once.</p>
        <Field label="To the earner" error={f.earnerPaise}>{(p) => <MoneyInput {...p} value={paise} onChange={setPaise} />}</Field>
        <p className="er-split-rest">To the client: <strong>{paise !== null && paise >= 0 && paise <= amount ? fmt.inr(amount - paise, true) : 'the rest'}</strong></p>
      </> : null}
      {writing ? <Field label={raising ? (k === 'dispute-work' ? 'What is wrong with the work' : 'Why the money should not go back') : 'What the mediator should know'} hint={raising ? 'In a sentence: 5 to 300 characters.' : '3 to 600 characters.'} error={field}>
        {(p) => <textarea {...p} className="input" rows={4} maxLength={raising ? 300 : 600} value={words} onChange={(e) => setWords(e.target.value)} />}
      </Field> : null}
      {go.error && !field && !f.earnerPaise ? <Problem error={go.error} /> : null}
    </Sheet>
  )
}
/** What a done step says, for the page's announcement. */
const DONE: Record<AskKind, (t: string) => string> = {
  'dispute-work': (t) => `Dispute raised on ${t}. The money stays in escrow until it is decided.`, 'dispute-refund': (t) => `Dispute raised on ${t}. The money stays in escrow until it is decided.`,
  'evidence-earner': (t) => `Your evidence on ${t} is on record.`, 'evidence-client': (t) => `The client's evidence on ${t} is on record.`,
  'give-back': (t) => `The money for ${t} went back to the client.`, agree: (t) => `The money for ${t} went back to the client.`, 'take-back': (t) => `The money for ${t} went back to the client.`,
  'decide-released': (t) => `Decided: ${t} is released to you.`, 'decide-refunded': (t) => `Decided: ${t} is refunded to the client.`, 'decide-split': (t) => `Decided: ${t} is split.`,
}

/**
 * Settling by agreement: one side offers an outcome, and the other side's offer of exactly the same settles it at once.
 * This frees money a timeout left locked, and either side may use it while the milestone is contested.
 */
function SettleSheet({ at, onClose, onDone }: { at: { m: Milestone; side: Side; cast: Cast } | null; onClose: () => void; onDone: (said: string) => void }) {
  const m = at?.m
  const theirs = at ? m?.offers?.[at.side === 'earner' ? 'client' : 'earner'] ?? null : null
  const [outcome, setOutcome] = useState<Offer['outcome']>('split')
  const [paise, setPaise] = useState<number | null>(null)
  useEffect(() => { setOutcome(theirs?.outcome ?? 'split'); setPaise(theirs?.outcome === 'split' ? theirs.toEarner : null) }, [m?.id, at?.side, theirs?.at])
  const go = useAction(async () => {
    if (!at || !m) return
    const r = await api<{ settled: boolean }>('POST', `/api/earn/milestones/${m.id}/settle`, { side: at.side, outcome, ...(outcome === 'split' ? { earnerPaise: paise ?? 0 } : {}) })
    onDone(r.settled ? `${m.title} is settled by agreement.` : `The offer on ${m.title} is on record. It settles once the other side offers the same.`)
  })
  if (!at || !m) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const as = PART_NOUN[at.side]
  const same = !!theirs && theirs.outcome === outcome && (outcome !== 'split' || theirs.toEarner === paise)
  const f = go.error?.fields ?? {}
  return (
    <Sheet open title={`Offer a settlement, as ${as}`} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn tone="fill" busy={go.busy} onClick={() => void go.run()}>{same ? 'Offer the same: settle it' : 'Make this offer'}</Btn></>}>
      <p>For <strong>{m.title}</strong>: {fmt.inr(m.amount, true)} in escrow. An offer settles it only when the other side has offered exactly the same{at.cast.names ? '' : ': on paper you play the other side too'}. Until then nothing moves.</p>
      {theirs ? <p className="er-offer-theirs">{partWords(at.side === 'earner' ? 'client' : 'earner', at.cast)} offered {offerWords(theirs)}, {fmt.dayTime(theirs.at)}. Offering the same settles it now.</p> : null}
      <fieldset className="er-settle">
        <legend className="legend">The outcome you offer</legend>
        {(['released', 'refunded', 'split'] as const).map((o) => (
          <label key={o} className="er-accept-row"><input type="radio" name={`settle-${m.id}`} checked={outcome === o} onChange={() => setOutcome(o)} />
            <span>{o === 'released' ? `All of it to the earner, ${fmt.inr(m.amount, true)}` : o === 'refunded' ? `All of it back to the client, ${fmt.inr(m.amount, true)}` : 'A split between the two, in whole paise'}</span></label>
        ))}
      </fieldset>
      {outcome === 'split' ? <>
        <Field label="To the earner" hint={`From ₹0.01 to ${fmt.inr(m.amount - 1, true)}.`} error={f.earnerPaise}>{(p) => <MoneyInput {...p} value={paise} onChange={setPaise} />}</Field>
        <p className="er-split-rest">To the client: <strong>{paise !== null && paise >= 0 && paise <= m.amount ? fmt.inr(m.amount - paise, true) : 'the rest'}</strong></p>
      </> : null}
      {go.error && !f.earnerPaise ? <Problem error={go.error} /> : null}
    </Sheet>
  )
}

/** The complete terms as read from the server for the choices made, or why they are not shown yet. */
function TermsRead({ preview, now, roleNames, empty }: { preview: ReturnType<typeof useTermsPreview>; now: number; roleNames: Cast['names']; empty: string }) {
  const id = useId()
  return (
    <section className="er-terms-read" aria-labelledby={id} aria-busy={preview.reading}>
      <h4 id={id}>The terms, in full</h4>
      {preview.read ? <TermsList terms={preview.read.terms} hash={preview.read.hash} now={now} roleNames={roleNames} />
        : preview.reading ? <p className="loading-line">Reading the terms…</p>
        : <p className="small faint">{empty}</p>}
    </section>
  )
}
/** The names of the members a set of terms names for each part (business workspaces), from the workspace's members. */
const namesOf = (t: TermsDoc | undefined, members: Member[]): Cast['names'] => {
  if (!t) return null
  const name = (id: string) => members.find((x) => x.personId === id)?.name ?? 'a member to choose'
  return { earner: name(t.roles.earner), client: name(t.roles.client), mediator: name(t.roles.mediator) }
}

/**
 * Proposing complete terms for a milestone from before terms were recorded: the same choices as a new job, for this
 * milestone alone, read in full from the server, and proposed by their fingerprint, which also accepts them for the side
 * that proposes. Nothing changes until the other side accepts them.
 */
function ProposeSheet({ at, policy, business, members, onClose, onDone }: { at: { m: Milestone; side: Side; cast: Cast } | null; policy: Policy; business: boolean; members: Member[]; onClose: () => void; onDone: (said: string) => void }) {
  const [choice, setChoice] = useState<Choice>(() => defaultChoice(policy))
  // a fresh choice for each milestone and side; the policy is read once per opening, not each time the page reloads
  useEffect(() => { setChoice(defaultChoice(policy)) }, [at?.m.id, at?.side])
  const now = useNow(60_000)
  const m = at?.m
  const body = at && m ? { side: at.side, ...choiceFields(choice, business, m.state === 'funded') } : null
  const preview = useTermsPreview(m ? `/api/earn/milestones/${m.id}/terms/preview` : '/api/earn/terms/preview', body)
  const go = useAction(async () => {
    if (!at || !m || !body) return
    await api('POST', `/api/earn/milestones/${m.id}/terms`, { ...body, termsHash: preview.read?.hash ?? '' })
    onDone(`Terms for ${m.title} are proposed. They bind it once the other side accepts them.`)
  })
  if (!at || !m) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const errors = { ...(preview.error?.fields ?? {}), ...(go.error?.fields ?? {}) }
  const other = at.side === 'earner' ? 'client' : 'earner'
  return (
    <Sheet open title={`Propose terms for ${m.title}`} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn tone="fill" busy={go.busy || preview.reading} onClick={() => void go.run()}>{`Propose and accept them, as ${PART_NOUN[at.side]}`}</Btn></>}>
      <p>Complete terms for this milestone alone, {fmt.inr(m.amount, true)} in escrow. Proposing them accepts them for {PART_NOUN[at.side]}; they bind the milestone once {PART_NOUN[other]} accepts them{at.cast.names ? '' : ', which on paper you play too'}, and every deadline counts from then.</p>
      <TermsChooser policy={policy} value={choice} onChange={setChoice} errors={errors} delivery={m.state === 'funded'} members={business ? members : undefined} pick={at.side === 'client' ? ['earner', 'mediator'] : ['client', 'mediator']} />
      <TermsRead preview={preview} now={now} roleNames={business ? namesOf(preview.read?.terms, members) : null} empty="Choose the terms above; they are shown here in full before anything is proposed." />
      {go.error && Object.keys(go.error.fields ?? {}).length === 0 ? <Problem error={go.error} /> : null}
    </Sheet>
  )
}

/** Accepting terms the other side proposed for a milestone from before terms were recorded, by their fingerprint. */
function AcceptTermsSheet({ at, onClose, onDone }: { at: { m: Milestone; side: Side; cast: Cast } | null; onClose: () => void; onDone: (said: string) => void }) {
  const now = useNow(60_000)
  const m = at?.m
  const p = m?.proposal ?? null
  const go = useAction(async () => {
    if (!at || !m || !p) return
    await api('POST', `/api/earn/milestones/${m.id}/terms/accept`, { side: at.side, hash: p.hash })
    onDone(`The terms for ${m.title} are agreed. Its deadlines start now.`)
  })
  if (!at || !m || !p) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  return (
    <Sheet open title={`Accept the terms proposed for ${m.title}?`} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn tone="fill" busy={go.busy} onClick={() => void go.run()}>{`Accept them, as ${PART_NOUN[at.side]}`}</Btn></>}>
      <p>Proposed by {lower(partWords(p.by, at.cast))}, {fmt.dayTime(p.at)}, and accepted in proposing them. Once you accept them as {PART_NOUN[at.side]} they bind {m.title} for good, and its deadlines start now: nothing counts from before.</p>
      <TermsList terms={p.terms} hash={p.hash} now={now} roleNames={at.cast.names} />
      {go.error ? <Problem error={go.error} /> : null}
    </Sheet>
  )
}

/** In a business workspace, the paper client's member accepts a proposed job's terms, by their fingerprint: its money goes into escrow. */
function JobTermsSheet({ job, onClose, onDone }: { job: Job | null; onClose: () => void; onDone: (said: string) => void }) {
  const now = useNow(60_000)
  const t = job?.terms ?? null
  const go = useAction(async () => {
    if (!job || !t) return
    await api('POST', `/api/earn/jobs/${job.id}/accept`, { hash: t.hash })
    onDone(`The terms for ${job.title} are accepted. Its money is in escrow on paper.`)
  })
  if (!job || !t) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const total = job.milestones.reduce((s, m) => s + m.amount, 0)
  return (
    <Sheet open title="Accept the terms, as the paper client?" onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn tone="fill" busy={go.busy} onClick={() => void go.run()}>Accept them, as the paper client</Btn></>}>
      <p>{t.roleNames.earner} proposed these terms for {job.title}. Accepting them as the paper client puts {fmt.inr(total, true)} in escrow on paper, and they then bind the job for good.</p>
      <TermsList terms={t.terms} hash={t.hash} now={now} roleNames={t.roleNames} accepts={t.accepts} />
      {go.error ? <Problem error={go.error} /> : null}
    </Sheet>
  )
}

/**
 * A new paper job: what the work is, for whom, its milestones, then its terms: each period and what happens when it runs
 * out, a choice within stated bounds with the usual one marked and its reason and source one press away. The terms are
 * then read in full from the server, with their fingerprint, and accepted for each side the person plays (on paper the
 * household plays the client too; in a business the client's member accepts later). The job opens only on the terms shown.
 */
function NewJob({ policy, business, members, onDone }: { policy: Policy; business: boolean; members: Member[]; onDone: (said: string) => void }) {
  const now = useNow(60_000)
  const [title, setTitle] = useState(''), [client, setClient] = useState('')
  const [ms, setMs] = useState<{ title: string; amount: number | null }[]>([{ title: '', amount: null }])
  const [choice, setChoice] = useState<Choice>(() => defaultChoice(policy))
  // an acceptance is of one fingerprint: changing anything the terms say asks for it again
  const [accepted, setAccepted] = useState<Record<Side, string | null>>({ earner: null, client: null })
  const [tried, setTried] = useState(false)
  const patch = (i: number, p: Partial<{ title: string; amount: number | null }>) => setMs((s) => s.map((m, j) => (j === i ? { ...m, ...p } : m)))
  const body = { title, client, milestones: ms.map((m) => ({ title: m.title, amount: m.amount ?? 0 })), ...choiceFields(choice, business) }
  // the terms are read once what they describe is there (the server checks it all again): nothing is asked of it that it must refuse
  const filled = title.trim().length >= 3 && client.trim().length >= 2 && ms.every((m) => m.title.trim().length >= 2 && (m.amount ?? 0) > 0)
  const preview = useTermsPreview('/api/earn/terms/preview', filled ? body : null)
  const hash = preview.read?.hash ?? null
  const sides: Side[] = business ? ['earner'] : ['earner', 'client']
  const value = { earner: !!hash && accepted.earner === hash, client: !!hash && accepted.client === hash }
  const all = value.earner && (business || value.client)
  const [unaccepted, setUnaccepted] = useState(false)
  const add = useAction(async () => {
    setTried(true)
    // an acceptance missing is said at once, in the server's words; the server refuses it all the same
    if (hash && !all) { setUnaccepted(true); return }
    const r = await api<{ id: string; state: string }>('POST', '/api/earn/jobs', { ...body, termsHash: hash ?? '', accept: business ? { earner: value.earner } : value })
    onDone(r.state === 'proposed' ? `${title} is proposed. Nothing is in escrow until the paper client's member accepts the terms.` : `${title} is open. The paper client's money is in escrow on the terms both sides accepted.`)
  })
  // what the person has not filled in yet is said once they try to open the job; what the choices get wrong, at once
  const read = preview.error?.fields ?? {}
  const f: Record<string, string> = { ...Object.fromEntries(Object.entries(read).filter(([k]) => tried || !['title', 'client', 'milestones'].includes(k))), ...(add.error?.fields ?? {}) }
  return (
    <form className="er-form" aria-label="Open a job on paper" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
      <div className="form-grid">
        <Field label="The work" error={f.title}>{(p) => <input {...p} className="input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="The client" hint={business ? 'A paper client. A member you choose below plays its part.' : 'A paper client. You play its part.'} error={f.client}>{(p) => <input {...p} className="input" maxLength={60} value={client} onChange={(e) => setClient(e.target.value)} />}</Field>
      </div>
      <fieldset className="er-ms-fields">
        <legend className="legend">Milestones, each paid on its own</legend>
        {ms.map((m, i) => (
          <div className="er-fields" key={i}>
            <Field label={`Milestone ${i + 1}`}>{(p) => <input {...p} className="input" maxLength={80} value={m.title} onChange={(e) => patch(i, { title: e.target.value })} />}</Field>
            <Field label="Paid on acceptance">{(p) => <MoneyInput {...p} value={m.amount} onChange={(v) => patch(i, { amount: v })} />}</Field>
            {ms.length > 1 ? <div className="er-fields-x"><Btn small tone="quiet" onClick={() => setMs((s) => s.filter((_, j) => j !== i))}>Remove</Btn></div> : null}
          </div>
        ))}
        {f.milestones ? <span className="err small void">{f.milestones}</span> : null}
        {ms.length < 8 ? <div><Btn small onClick={() => setMs((s) => [...s, { title: '', amount: null }])}><Plus aria-hidden="true" />Add a milestone</Btn></div> : null}
      </fieldset>
      <fieldset className="er-ms-fields">
        <legend className="legend">The terms: each a choice, the usual one marked</legend>
        <TermsChooser policy={policy} value={choice} onChange={setChoice} errors={f} members={business ? members : undefined} />
      </fieldset>
      <TermsRead preview={preview} now={now} roleNames={business ? namesOf(preview.read?.terms, members) : null} empty="The terms are shown here in full, with their fingerprint, once the work, the client and each milestone are filled in." />
      <Acceptances sides={sides} value={value} waiting={!hash} error={f.accept ?? (unaccepted && !all ? (business ? 'Accept the terms as the earner.' : 'Accept the terms as the earner and as the paper client: on paper you play the client too.') : undefined)} onChange={(v) => setAccepted({ earner: v.earner ? hash : null, client: v.client ? hash : null })} />
      {add.error && Object.keys(add.error.fields ?? {}).length === 0 ? <Problem error={add.error} /> : null}
      <div className="er-form-go"><Btn tone="fill" type="submit" busy={add.busy || preview.reading}>Open this job</Btn><p className="small faint">{business ? 'The money goes into escrow on paper once the paper client\'s member accepts the terms. Nothing real moves.' : 'The paper client puts the money in escrow at once. Nothing real moves.'}</p></div>
    </form>
  )
}

function PaperWork({ earn, receipts, primary, onDecided }: { earn: Resource<EarnView>; receipts: Map<string, string>; primary: string | null; onDecided: () => void }) {
  const now = useNow(30_000)
  const [adding, setAdding] = useState(false)
  const [submitting, setSubmitting] = useState<{ m: Milestone; t: TermsDoc | null } | null>(null)
  const [evidence, setEvidence] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [settling, setSettling] = useState<{ m: Milestone; side: Side; cast: Cast } | null>(null)
  const [proposing, setProposing] = useState<{ m: Milestone; side: Side; cast: Cast } | null>(null)
  const [agreeing, setAgreeing] = useState<{ m: Milestone; side: Side; cast: Cast } | null>(null)
  const [jobTerms, setJobTerms] = useState<Job | null>(null)
  // what the last step did, said to a screen reader; the row itself shows it too
  const [said, setSaid] = useState('')
  // the milestone the last step was taken on, so its outcome or its error shows in that row
  const [deciding, setDeciding] = useState<string | null>(null)
  const done = (s: string) => { setSaid(s); earn.reload(); onDecided() }
  const submit = useAction(async () => { if (!submitting) return; await api('POST', `/api/earn/milestones/${submitting.m.id}/submit`, { evidence }); setSaid(`The work for ${submitting.m.title} is submitted. The client's review has started.`); setSubmitting(null); setEvidence(''); earn.reload() })
  const client = useAction(async (m: Milestone, decision: 'accept' | 'refund') => {
    setDeciding(m.id)
    await api('POST', `/api/earn/milestones/${m.id}/client`, { decision })
    done(decision === 'accept' ? `The client released ${m.title} to you.` : `The client asked for the money for ${m.title} back. You have time to answer.`)
  })
  // jobs paid through the escrow on the chain share these records; they are shown in their own section below
  const jobs = paperJobs(earn.data)
  const v = earn.data
  const business = !!v?.business
  const members = v?.members ?? []
  const open = <Btn onClick={() => setAdding(true)}><Plus aria-hidden="true" />Open a job</Btn>
  return (
    <section className="er-kind paper-work" aria-labelledby="escrow-h">
      <div className="er-kind-head">
        <div><h2 id="escrow-h">Work held in escrow on paper</h2><p>{business
          ? 'Practice money. Each job names three members: the earner, the paper client and a simulated mediator. The client\'s member accepts the job\'s terms, which puts the money in escrow; every deadline, and what happens when it passes, is in those terms.'
          : 'Practice money. The paper client, whose part you play, puts the money in escrow once both sides have accepted the job\'s terms. Every deadline, and what happens when it passes, is in those terms. A dispute is decided by a simulated mediator, which you play too.'}</p></div>
        {v && jobs.length && !adding ? open : null}
      </div>
      {adding && v?.policy ? <Composer title="A new job, on paper" onClose={() => setAdding(false)}><NewJob policy={v.policy} business={business} members={members} onDone={(s) => { setAdding(false); done(s) }} /></Composer> : null}
      {jobs.length ? (
        <details className="er-how small">
          <summary>How the paper escrow decides</summary>
          <p>Every job states its terms before it is opened, and both sides accept them by their fingerprint{business ? '' : ': on paper you accept for the client too'}. They say how long the client's review lasts, how long you have to answer the client asking for the money back, how long each side has for evidence in a dispute and by when the mediator decides, and what happens when each runs out: released to you, back to the client, a stated split, or locked until both sides agree. Every deadline is worked out from those terms and the step that started it, never from QED's settings, so updating or restarting QED moves none of them.</p>
          <p>A dispute is decided by a simulated mediator{business ? ', played by a member' : ' that you play'}: not an arbitrator, a court or a regulated dispute service. Work opened before QED recorded terms keeps the terms it was opened on: nothing happens to it on its own until both sides agree terms. These deadlines run whether or not QED is paused: a pause stops QED's instructions, not an escrow's terms.</p>
        </details>
      ) : null}
      {!v ? (earn.error ? <div className="er-problem"><Problem error={earn.error} /><Btn small onClick={earn.reload}>Try again</Btn></div> : <WorkSkeleton what="Reading the jobs" />)
        : jobs.length === 0 ? (adding ? null : <div className="panel er-empty"><p>No job on paper. Open one to see how escrowed pay is delivered, accepted or disputed, and released, on terms you choose and read in full first: a paper client puts the money in escrow, and you play its part.</p>{open}</div>)
        : jobs.map((j) => {
          const jt = j.terms ?? null
          const proposed = j.milestones.some((m) => m.state === 'proposed')
          const clientMayAccept = proposed && (j.milestones[0]?.you ?? []).includes('client')
          const playedBy = business && jt ? `played by ${jt.roleNames.client}` : 'a paper client you play'
          return (
            <JobCard key={j.id} id={j.id} kind="paper" role="provider" title={j.title} test={false} items={j.milestones.flatMap(paperItems)} count={j.milestones.length}
              who={`For ${j.client}, ${playedBy}; opened ${fmt.day(j.created_at)}`}
              terms={jt ? `${termsSummary(jt.terms, now)}${jt.agreedAt ? ` Accepted by both sides ${fmt.day(jt.agreedAt)}.` : ''}` : j.milestones.some((m) => m.legacy) ? 'Opened before QED recorded terms: no deadlines and no defaults, until both sides agree terms for a milestone.' : undefined}
              note={jt ? <>
                {proposed ? (
                  <div className="er-wide er-legacy er-job-wait">
                    <p className="er-legacy-h">Waiting for the paper client to accept the terms: nothing is in escrow yet.</p>
                    <p>{jt.roleNames.client}, who plays the paper client, accepts them by their fingerprint, which puts the money in escrow. Until then no deadline runs.</p>
                    {clientMayAccept ? <div className="er-legacy-acts"><Btn small tone="fill" onClick={() => setJobTerms(j)}>Read and accept the terms, as the paper client</Btn></div> : null}
                  </div>
                ) : null}
                <details className="er-jterms"><summary>The terms of this job, in full</summary><TermsList terms={jt.terms} hash={jt.hash} now={now} roleNames={business ? jt.roleNames : null} accepts={jt.accepts} /></details>
              </> : undefined}>
              {j.milestones.map((m) => {
                const t = m.terms?.terms ?? jt?.terms ?? null
                const cast: Cast = { names: business ? m.terms?.roleNames ?? jt?.roleNames ?? null : null, you: m.you ?? [] }
                const place = paperPlace(m)
                const receipt = receipts.get(m.id)
                const can = m.can ?? { earner: [], client: [], mediator: [] }
                const plays = (p: Part, mv: string) => cast.you.includes(p) && can[p].includes(mv)
                const contested = m.state === 'disputed' || m.state === 'refund-asked' || m.next?.step === 'agree-outcome' || !!(m.offers?.earner || m.offers?.client)
                const theirs = (side: Side) => m.offers?.[side === 'earner' ? 'client' : 'earner'] ?? null
                const asking = (kind: AskKind) => () => { setDeciding(m.id); setAsk({ kind, m, t, cast }) }
                const settle = (side: Side) => () => { setDeciding(m.id); setSettling({ m, side, cast }) }
                const problem = deciding === m.id ? client.error : null
                const clientMoves = ['accept', 'dispute', 'evidence', 'refund'].some((x) => plays('client', x)) || (contested && plays('client', 'settle'))
                const earnerActs = plays('earner', 'submit') || plays('earner', 'dispute') || plays('earner', 'evidence') || plays('earner', 'agree') || plays('earner', 'give-back') || (contested && plays('earner', 'settle')) || !!receipt
                const mayDecide = plays('mediator', 'decide') ? t?.mediator.may ?? [] : []
                return (
                  <MsRow key={m.id} id={m.id} kind="paper" place={place} title={m.title} stamp={M_STATE[m.state] ?? 'In escrow'} whoseMove={whoseMoveWords(m.next, cast)} amount={m.amount}
                    say={<><PaperNextLine m={m} cast={cast} now={now} />{m.evidence_hash ? <p className="er-ms-proof"><Seal /> The earner's evidence is on record.</p> : null}
                      {m.evidence_hash ? <details className="er-tech small"><summary>Technical details</summary><p>Fingerprint of the evidence submitted (SHA-256): <span className="code">{m.evidence_hash}</span>. QED keeps only this, so it can later be shown that what was submitted has not changed.</p></details> : null}
                      {m.terms && !jt ? <details className="er-tech small"><summary>The terms agreed for it</summary><TermsList terms={m.terms.terms} hash={m.terms.hash} now={now} roleNames={business ? m.terms.roleNames : null} accepts={m.terms.accepts} /></details> : null}</>}
                    actions={earnerActs ? <>
                      {plays('earner', 'submit') ? <Btn small tone={m.id === primary ? 'fill' : undefined} onClick={() => { setEvidence(''); setSubmitting({ m, t }) }}>Submit the work</Btn> : null}
                      {plays('earner', 'dispute') ? <Btn small onClick={asking('dispute-refund')}>Dispute it</Btn> : null}
                      {plays('earner', 'evidence') ? <Btn small onClick={asking('evidence-earner')}>Send your evidence</Btn> : null}
                      {contested && plays('earner', 'settle') ? <Btn small onClick={settle('earner')}>{theirs('earner') ? 'Answer the client\'s offer' : 'Offer a settlement'}</Btn> : null}
                      {plays('earner', 'agree') ? <Btn small tone="quiet" onClick={asking('agree')}>{m.state === 'disputed' ? 'Let the client have it' : 'Agree: give it back'}</Btn> : null}
                      {plays('earner', 'give-back') ? <Btn small tone="quiet" onClick={asking('give-back')}>Give the money back</Btn> : null}
                      {receipt ? <Link className="btn sm quiet" to={`/receipts/${receipt}`}>See the receipt</Link> : null}
                    </> : null}>
                    {m.legacy ? <LegacyTerms m={m} cast={cast} now={now} onPropose={(x, side) => setProposing({ m: x, side, cast })} onAccept={(x, side) => setAgreeing({ m: x, side, cast })} /> : null}
                    {m.dispute ? <DisputeBox m={m} t={t} cast={cast} now={now} /> : null}
                    <Offers m={m} cast={cast} />
                    {clientMoves ? (
                      <div className="er-wide er-client" role="group" aria-label={cast.names ? `The paper client's part for ${m.title}` : `The client's part for ${m.title}, played by you`}>
                        <p><span className="er-role">Paper client</span> {cast.names ? `Played by ${cast.names.client}.` : 'There is no real client, so you play its part.'}</p>
                        <div className="er-client-acts">
                          {plays('client', 'accept') ? <Btn small busy={client.busy} onClick={() => void client.run(m, 'accept')}>{m.state === 'disputed' ? 'Client releases it after all' : 'Client accepts and releases'}</Btn> : null}
                          {plays('client', 'dispute') ? <Btn small onClick={asking('dispute-work')}>Client disputes it</Btn> : null}
                          {plays('client', 'evidence') ? <Btn small onClick={asking('evidence-client')}>Client sends evidence</Btn> : null}
                          {contested && plays('client', 'settle') ? <Btn small onClick={settle('client')}>{theirs('client') ? 'Client answers your offer' : 'Client offers a settlement'}</Btn> : null}
                          {plays('client', 'refund') ? (m.legacy ? <Btn small tone="void" onClick={asking('take-back')}>Client takes the money back</Btn> : <Btn small tone="void" busy={client.busy} onClick={() => void client.run(m, 'refund')}>Client asks for the money back</Btn>) : null}
                        </div>
                      </div>
                    ) : null}
                    {mayDecide.length ? (
                      <div className="er-wide er-client er-med" role="group" aria-label={cast.names ? `The simulated mediator's decision on ${m.title}` : `The simulated mediator's decision on ${m.title}, played by you`}>
                        <p><span className="er-role">Simulated mediator</span> {cast.names ? `Played by ${cast.names.mediator}.` : 'Played by you.'} Not an arbitrator, a court or a regulated dispute service: it may do only what the accepted terms allow, on this milestone.</p>
                        <div className="er-client-acts">
                          {mayDecide.includes('release') ? <Btn small onClick={asking('decide-released')}>Release it to the earner</Btn> : null}
                          {mayDecide.includes('split') ? <Btn small onClick={asking('decide-split')}>Split it</Btn> : null}
                          {mayDecide.includes('refund') ? <Btn small tone="void" onClick={asking('decide-refunded')}>Refund it to the client</Btn> : null}
                        </div>
                      </div>
                    ) : null}
                    <StepRecord m={m} cast={cast} />
                    {problem ? <div className="er-wide"><Problem error={problem} /></div> : null}
                  </MsRow>
                )
              })}
            </JobCard>
          )
        })}
      {client.error && !jobs.some((j) => j.milestones.some((m) => m.id === deciding)) ? <Problem error={client.error} /> : null}
      <p className="sr" role="status">{said}</p>
      <Sheet open={!!submitting} title="Submit the work" onClose={() => setSubmitting(null)}
        foot={<><Btn onClick={() => setSubmitting(null)}>Cancel</Btn><Btn tone="fill" busy={submit.busy} onClick={() => void submit.run()}>Submit to the client</Btn></>}>
        <p>For <strong>{submitting?.m.title}</strong>, {submitting ? fmt.inr(submitting.m.amount, true) : ''} in escrow.</p>
        {submitting?.t ? <p className="small">Once you submit it, the client has {periodWords(submitting.t.review.ms)} to accept it or dispute it; with no answer by then, {outcomeWords(submitting.t.review.onTimeout, submitting.m.amount)}, as the accepted terms say.</p>
          : submitting ? <p className="small">It has no agreed terms: once you submit it, nothing happens on its own until the client decides or both sides agree terms.</p> : null}
        <Field label="Evidence of the work" hint="A link, a description, or the text itself. QED keeps only its fingerprint, so you can later show that what you submitted has not changed." error={submit.error?.fields.evidence}>{(p) => <textarea {...p} className="input" rows={5} value={evidence} onChange={(e) => setEvidence(e.target.value)} />}</Field>
        {submit.error && !submit.error.fields.evidence ? <Problem error={submit.error} /> : null}
      </Sheet>
      <PaperSheet ask={ask} onClose={() => setAsk(null)} onDone={(s) => { setAsk(null); done(s) }} />
      <SettleSheet at={settling} onClose={() => setSettling(null)} onDone={(s) => { setSettling(null); done(s) }} />
      {v?.policy ? <ProposeSheet at={proposing} policy={v.policy} business={business} members={members} onClose={() => setProposing(null)} onDone={(s) => { setProposing(null); done(s) }} /> : null}
      <AcceptTermsSheet at={agreeing} onClose={() => setAgreeing(null)} onDone={(s) => { setAgreeing(null); done(s) }} />
      <JobTermsSheet job={jobTerms} onClose={() => setJobTerms(null)} onDone={(s) => { setJobTerms(null); done(s) }} />
    </section>
  )
}
const paperJobs = (d: { jobs: Job[] } | null): Job[] => (d?.jobs ?? []).filter((j) => !j.milestones.some((m) => m.state.startsWith('chain-')))

export function WorkSkeleton({ what }: { what: string }) {
  return <div className="er-skel" aria-busy="true"><p className="loading-line">{what}</p><span className="skel" /><span className="skel" /></div>
}

// ------------------------------------------------------------------------------------------------ work paid through escrow on the chain

export interface ChainMilestone {
  id: string; title: string; amount: number; state: string; status: string; since: number; deliverWithinHours: number; deliverBy: string | null; offerValidUntil: string | null; escrowJobId: string | null; quoteHash: string | null
  /** A step asked for and not finished; `expiresAt`, for this side's own request, is when it lapses unsigned. */
  pending: { action: string; approvalId: string | null; proposalId: string | null; jobId: string | null; status: 'awaiting-signature' | 'sending'; yours: boolean; expiresAt?: string | null } | null
  last: { action: string; outcome: string; summary: string; at: number } | null
  txs: { opened: { tx: string; block: string } | null; settled: { tx: string; block: string; confirmations: number } | null; refunded: { tx: string; block: string } | null }
  evidence: { solutionHash: string } | null
  authority?: { status: 'credited' | 'pending' | 'not-earnings' | 'not-settled'; credit: string; confirmations: number; needed: number; why: string } | null
  /** The review and dispute step, when the job has one (R13 E3). */
  dispute?: ChainDispute | null
  actions: string[]
}
export interface ChainJob { id: string; title: string; state: string; createdAt: number; problem: { kind: string; assets?: { name: string; volatilityBps: number }[] }; client?: { name: string | null; handle: string }; provider?: { name: string; handle: string }; clientName?: string; authority?: { counts: boolean; why: string }; milestones: ChainMilestone[] }
/** The dispute step of a milestone (R13 E3; server/earn-chain.ts disputeView): its terms, deadlines, texts and outcome. */
export interface ChainDispute {
  decider: { handle: string; name: string | null }
  terms: { review: string; evidence: string; decision: string; reviewSeconds: number; evidenceSeconds: number; decisionSeconds: number; onReviewPct: number; onDecisionPct: number; may: { pay: boolean; refund: boolean; split: boolean }; test: boolean; words: string[] | null }
  deadlines: { reviewEnds: string | null; evidenceEnds: string | null; decideBy: string | null }
  reason: { text: string; onChain: boolean } | null
  evidence: { by: 'client' | 'provider'; text: string; at: number; onChain: boolean }[]
  outcome: { kind: string; words: string; toProvider: number; toClient: number } | null
}
export interface DisputeDefaults { reviewDays: number; evidenceDays: number; decisionDays: number; onReviewPct: number; onDecisionPct: number }
export interface ChainView { reachable: boolean; asProvider: ChainJob[]; asClient: ChainJob[]; asDecider?: ChainJob[]; disputeDefaults?: DisputeDefaults; disputeBounds?: Record<'review' | 'evidence' | 'decision', { min: number; max: number }>; testStack?: boolean }

/** What each step on the chain is called in a sentence ("waiting for your signature on the offer"). */
export const DOING: Record<string, string> = { quote: 'the offer', fund: 'the funding', deliver: 'the delivery', release: 'the release', refund: 'the refund', accept: 'the acceptance', dispute: 'the dispute', evidence: 'the evidence', decide: 'the ruling', 'give-way': 'the refund', finish: 'the timeout' }
/** "A", "A and B", "A, B and C". */
export const listed = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
/** Who the other party is, as this side may name them: the client's name reaches the provider once they fund (RISK-071). */
export const otherOf = (j: ChainJob, role: Role): { named: string | null; other: string } => {
  const named = role === 'provider' ? j.client!.name : j.provider!.name
  return { named, other: named ?? `@${j.client!.handle}` }
}

// ------------------------------------------------------------------------------------------------ money in

function MoneyIn({ splitInForce, onDone, onClose }: { splitInForce: boolean; onDone: (said: string) => void; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null), [kind, setKind] = useState<'earned' | 'topup'>('earned'), [memo, setMemo] = useState('')
  const go = useAction(async () => {
    await api('POST', '/api/money-in', { amount: amount ?? 0, kind, memo })
    onDone(`${fmt.inr(amount ?? 0, true)} is in your bank account${kind === 'earned' ? (splitInForce ? '. Your income instruction acts on it within a few seconds.' : ', recorded as earnings.') : ', recorded as a top-up, not as income.'}`)
  })
  return (
    <form className="er-in-form" aria-label="Record money in" onSubmit={(e) => { e.preventDefault(); void go.run() }}>
      <p className="small faint er-in-wide">Paper money, entered by you.</p>
      <div className="field"><span className="legend">This money is</span>
        <div className="seg" role="group" aria-label="What kind of money this is">
          <button type="button" aria-pressed={kind === 'earned'} onClick={() => setKind('earned')}>Income I earned</button>
          <button type="button" aria-pressed={kind === 'topup'} onClick={() => setKind('topup')}>A top-up of paper money</button>
        </div>
        <span className="hint">{kind === 'earned' ? 'Counts as income. An instruction that splits income will act on it.' : 'Adds paper money to try things with. It is not income and no instruction acts on it.'}</span>
      </div>
      <Field label="How much" error={go.error?.fields.amount}>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
      <Field label="Where it came from" hint="Optional. Shown in the passbook.">{(p) => <input {...p} className="input" maxLength={80} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
      {go.error && !go.error.fields.amount ? <div className="er-in-wide"><Problem error={go.error} /></div> : null}
      <div className="row er-in-wide"><Btn tone="fill" type="submit" busy={go.busy}>Record it</Btn><Btn tone="quiet" onClick={onClose}>Cancel</Btn></div>
    </form>
  )
}

const bankIn = (e: Entry): number => e.lines.find((l) => l.code === 'bank')?.amount ?? 0
/** When the job's terms settled a milestone, by the period that ran out (the entry names it). */
const RULE_WHEN: Record<string, string> = {
  review: 'at the end of the client\'s review, with no answer', answer: 'when the time to answer the client\'s request ran out',
  evidence: 'as the dispute was not answered in time', decision: 'as no decision came in time',
}
/** How a paper milestone's money came to be released, from its ledger entry (server/escrow.ts settle): who decided, and how. */
export function releasedHow(meta: Record<string, unknown>): string {
  const by = meta.decidedBy, split = meta.outcome === 'split'
  const late = meta.recordedLate ? ', recorded late' : ''
  if (by === 'rule') {
    const when = RULE_WHEN[String(meta.period)]
    // an entry from before the terms named the period says what it always said
    if (!when) return split ? `Your half of a dispute no one decided in time, by the escrow's stated rule${late}` : `Released from escrow by its stated rule${meta.disputeId ? ', as the client did not answer your dispute' : ' at the end of the client\'s review, with no answer'}${late}`
    return split ? `Your part of a split the job's terms set ${when}${late}` : `Released from escrow by the job's terms ${when}${late}`
  }
  if (by === 'mediator') return split ? 'Your part of the split the simulated mediator, played by you, decided' : 'Released by the simulated mediator, played by you'
  if (by === 'agreement') return split ? 'Your part of a settlement both sides agreed' : 'Released from escrow by agreement between the two sides'
  return meta.disputeId ? 'Released from escrow when the client, played by you, gave way in the dispute' : 'Released from escrow when the client (played by you) accepted the work'
}

/** One line of the day book: when, from whom, for what, how it was verified, how much, and where it went. */
interface InLine { key: string; at: number; time: boolean; from: string; what: ReactNode; how: ReactNode; amount: number; where: string; income: boolean; entryId: string | null }

/**
 * What an instruction did with one income, from its run: QED's hand, in its colour. A refusal names its check with its
 * figures (the run's own reason), one press away.
 */
function SplitOf({ run, title }: { run: RunView; title: string }) {
  return (
    <div className="er-split">
      <p><span className="by-qed">By QED</span> under “{title}”: {run.willDo.length ? run.willDo.join('; ') : 'nothing to move'}. {stateWord(run.state)}.</p>
      {run.reason ? <details className="er-why"><summary>{run.state === 'blocked' ? 'Why it was refused' : 'Why'}</summary><p>{run.reason}</p></details> : null}
    </div>
  )
}

function MoneyInBook({ home, book, salary, earned, topups, paper, chain, receipts }: {
  home: Resource<Home>; book: Resource<PassbookView>; salary: Resource<{ entries: Entry[] }>; earned: Resource<{ entries: Entry[] }>; topups: Resource<{ entries: Entry[] }>
  paper: Resource<{ jobs: Job[] }>; chain: Resource<ChainView>; receipts: Map<string, string>
}) {
  const now = useNow(30_000)
  const [recording, setRecording] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const split = home.data?.programs.find((x) => x.kind === 'split') ?? null
  const splitRuns = useData<ProgramDetail>(split ? `/api/programs/${split.id}` : null, ['run', 'program', 'action'])
  const byEntry = new Map<string, RunView>()
  for (const r of splitRuns.data?.runs ?? []) if (typeof r.trigger.entryId === 'string') byEntry.set(r.trigger.entryId, r)
  const p = home.data?.profile

  // what arrived: the ledger's income and top-ups, and payments through the escrow on the chain (into the on-chain wallet)
  const jobsById = new Map((paper.data?.jobs ?? []).map((j) => [j.id, j]))
  const arrived: InLine[] = []
  for (const e of salary.data?.entries ?? []) arrived.push({ key: e.id, at: e.effective_ts, time: true, from: 'Your employer', what: e.memo, how: `Your paper bank showed it${e.meta.recordedLate ? '; recorded late' : ''}`, amount: bankIn(e), where: 'Into your bank', income: true, entryId: e.id })
  for (const e of earned.data?.entries ?? []) {
    const job = typeof e.meta.jobId === 'string' ? jobsById.get(e.meta.jobId) : undefined
    const ms = job?.milestones.find((m) => m.id === e.meta.milestoneId)
    const receipt = typeof e.meta.milestoneId === 'string' ? receipts.get(e.meta.milestoneId) : undefined
    if (e.meta.milestoneId) arrived.push({ key: e.id, at: e.effective_ts, time: true, from: job?.client ?? 'Your client', what: ms ? <>{ms.title}<small>{job!.title}</small></> : e.memo,
      how: <>{releasedHow(e.meta)}{e.meta.evidenceHash ? '; your evidence\'s fingerprint is kept' : ''}.{receipt ? <> <Link to={`/receipts/${receipt}`}><Seal /> Receipt</Link></> : null}</>, amount: bankIn(e), where: 'Into your bank', income: true, entryId: e.id })
    else arrived.push({ key: e.id, at: e.effective_ts, time: true, from: 'You, by hand', what: e.memo, how: 'Entered by you; nothing checked it', amount: bankIn(e), where: 'Into your bank', income: true, entryId: e.id })
  }
  for (const e of topups.data?.entries ?? []) arrived.push({ key: e.id, at: e.effective_ts, time: true, from: 'You, by hand', what: e.memo, how: 'Entered by you. Not income: no instruction acts on it', amount: bankIn(e), where: 'Into your bank', income: false, entryId: null })
  for (const j of chain.data?.asProvider ?? []) for (const m of j.milestones) {
    if (m.state !== 'chain-released') continue
    arrived.push({ key: m.id, at: m.since, time: true, from: j.client?.name ?? `@${j.client?.handle ?? ''}`, what: <>{m.title}<small>{j.title}</small></>,
      how: `The verifier on the chain accepted the certificate and the escrow paid${m.txs.settled ? `; ${m.txs.settled.confirmations} confirmation${m.txs.settled.confirmations === 1 ? '' : 's'}` : ''}`, amount: m.amount, where: 'Into your on-chain wallet, test rupees', income: true, entryId: null })
  }
  arrived.sort((a, b) => b.at - a.at)
  const shown = arrived.slice(0, 12)
  const loaded = !!salary.data && !!earned.data && !!topups.data
  const failed = salary.error ?? earned.error ?? topups.error

  // what is expected: the salary as recorded (an estimate), on the day the server expects it; and what escrow holds for you
  const expected = (book.data?.expected ?? []).filter((x) => x.kind === 'income' && x.amount > 0)
  const heldPaper = partsOf(paperJobs(paper.data).flatMap((j) => j.milestones.flatMap(paperItems))).held
  const heldChain = partsOf((chain.data?.asProvider ?? []).flatMap((j) => j.milestones.map((m) => ({ amount: m.amount, place: chainPlace(m) })))).held
  const held = [heldPaper ? `${fmt.inr(heldPaper, true)} on paper` : '', heldChain ? `${fmt.inr(heldChain, true)} in test rupees through the escrow on the chain` : ''].filter(Boolean)

  const record = (): void => { setSaid(null); setRecording(true) }
  const row = (l: InLine, coming: boolean) => (
    <li key={l.key} className={coming ? 'coming' : ''}>
      <span className="er-in-when">{nearDay(l.at, now)}{l.time ? <small>{fmt.time(l.at)}</small> : null}</span>
      <span className="er-in-what">{l.what}<small className="er-in-from">{l.from}</small></span>
      <div className="er-in-how">{l.how}{l.entryId && byEntry.has(l.entryId) && split ? <SplitOf run={byEntry.get(l.entryId)!} title={split.title} /> : null}</div>
      <span className={`er-in-amt ${l.income && !coming ? 'in' : ''}`}>+{fmt.inr(l.amount, true)}</span>
      <small className="er-in-where">{l.where}</small>
    </li>
  )
  return (
    <section className="panel er-book" aria-labelledby="inc-h">
      <div className="er-book-head">
        <div><h2 id="inc-h">Money in</h2><p>Counted only once it is on record: QED never assumes money has arrived.</p></div>
        {shown.length && !recording ? <Btn small onClick={record}><Plus aria-hidden="true" />Record money in</Btn> : null}
      </div>
      {recording ? <MoneyIn splitInForce={split?.state === 'active'} onClose={() => setRecording(false)} onDone={(s) => { setSaid(s); setRecording(false); earned.reload(); topups.reload(); salary.reload(); home.reload(); book.reload() }} /> : null}
      {said ? <div className="er-said"><Note tone="ok">{said}</Note></div> : null}

      <h3 className="er-col-h" id="exp-h">Coming up</h3>
      {!book.data || !p ? (book.error ?? home.error ? <div className="er-problem"><Problem error={book.error ?? home.error} /><Btn small onClick={() => { book.reload(); home.reload() }}>Try again</Btn></div> : <span className="skel er-skel-line" />)
        : expected.length ? (
          <ul className="er-days" aria-labelledby="exp-h">{expected.map((x, i) => row({ key: `exp-${i}`, at: x.dueAt, time: false, from: 'Your employer', what: x.label,
            how: <>Expected: the salary you recorded, an estimate. <Link to="/safeguards#household">Change it</Link></>, amount: x.amount, where: 'Into your bank', income: true, entryId: null }, true))}</ul>
        ) : <p className="er-line small faint">{p.income > 0 ? `Your salary of ${fmt.inr(p.income, true)} is expected on day ${p.incomeDay} of the month, after the days shown here.` : 'No salary is recorded for this household.'} <Link to="/safeguards#household">Change them</Link></p>}
      {held.length ? <p className="er-line small">Also held in escrow for you: {listed(held)}. It comes in only when it is released; until then it is not yours.</p> : null}

      <p className="er-today" aria-hidden="true"><span>Today</span></p>

      <h3 className="er-col-h" id="arr-h">Arrived, newest first</h3>
      {!loaded ? (failed ? <div className="er-problem"><Problem error={failed} /><Btn small onClick={() => { salary.reload(); earned.reload(); topups.reload() }}>Try again</Btn></div> : <span className="skel er-skel-line" />)
        : shown.length === 0 ? (
          <div className="er-in-empty">
            <p className="small faint">Nothing has arrived yet. Salary appears here when your paper bank shows it; earnings when a client releases a milestone or the escrow on the chain pays one. You can also record money that came in yourself.</p>
            {!recording ? <Btn small onClick={record}><Plus aria-hidden="true" />Record money in</Btn> : null}
          </div>
        ) : <ul className="er-days" aria-labelledby="arr-h">{shown.map((l) => row(l, false))}</ul>}
      {arrived.length > shown.length ? <p className="er-line small"><span className="faint">{arrived.length - shown.length} earlier.</span> <Link to="/passbook">The passbook has every entry</Link></p> : null}

      <div className="er-book-foot">
        <h3 id="split-h">When income arrives</h3>
        {!home.data ? <span className="skel er-skel-line" /> : split
          ? <p className="small"><Link to={`/instructions/${split.id}`}>{split.title}</Link><span className="faint"> <Suspense fallback={null}><SplitStatus p={split} now={now} /></Suspense></span></p>
          : <p className="small faint">Nothing happens on its own. An instruction can move a share of each salary or earning into a fund or onto your card as soon as it is recorded. <Link to="/instructions/new?kind=split">Write one</Link></p>}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the screen

export function EarnScreen() {
  const home = useData<Home>('/api/home', ['program', 'profile', 'earn'])
  const earn = useData<EarnView>('/api/earn', ['earn'])
  const chain = useData<ChainView>('/api/earn/chain', ['earn', 'vault'])
  const book = useData<PassbookView>('/api/passbook?limit=1', ['profile', 'earn'])
  const salary = useData<{ entries: Entry[] }>('/api/ledger?account=inc:salary&limit=6', ['profile'])
  const earned = useData<{ entries: Entry[] }>('/api/ledger?account=inc:earn&limit=12', ['earn', 'action'])
  const topups = useData<{ entries: Entry[] }>('/api/ledger?account=inc:other&limit=6', ['earn', 'action'])
  const rcpts = useData<{ receipts: Receipt[] }>('/api/receipts?limit=200', ['earn', 'receipt'])
  // each paper milestone's receipt, once it was released or refunded
  const receipts = new Map((rcpts.data?.receipts ?? []).filter((r) => r.kind === 'earning').map((r) => [r.subject, r.id]))
  // the one primary action of the page: the first move that is yours, on paper or on the chain
  const paper = paperJobs(earn.data)
  const chainMs = [...(chain.data?.asProvider ?? []), ...(chain.data?.asClient ?? [])].flatMap((j) => j.milestones)
  const primary = paper.flatMap((j) => j.milestones).find((m) => m.state === 'funded')?.id ?? chainMs.find((m) => m.actions.length > 0)?.id ?? null
  // One draw for the work: the jobs on paper and on the chain settle first (an answer or an error), so nothing below
  // them is pushed down as each request returns (drawn in pieces, the page's lab layout shift was 0.19, EV-080). The
  // head is drawn before any of it (M11): it is the largest thing on a phone's first screen.
  const settled = (r: { data: unknown; error: unknown }) => r.data !== null || r.error !== null
  const ready = settled(earn) && settled(chain)
  useEffect(() => { void loadChain() }, [])
  // A link to one milestone (Home's "Needs you": /earn#ms-<id>) lands on it once the work has drawn. The router looks for
  // a link's target for two seconds after it navigates; the work here draws only once the chain's view is read, which can
  // take longer, and a page opened at that address directly has no navigation to look for it.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (!ready || !id.startsWith('ms-')) return undefined
    let tries = 0
    const t = setInterval(() => { if (document.getElementById(id) || ++tries > 40) { clearInterval(t); land(id) } }, 50)
    return () => clearInterval(t)
  }, [ready])
  const wait = <div className="page-wait"><Loading what="Opening your work and earnings" /></div>
  return (
    <div className="earn">
      <header className="page-head er-head">
        <div>
          <h1>Earn</h1>
          <p>Work you are paid for, followed from the offer to the money arriving. What is held in escrow is not yours until it is paid.</p>
        </div>
        <Link to="/earn/bounties" className="btn">Refutation bounties</Link>
      </header>
      {/* the work draws once, when its data and the chain's code are both in: nothing below is pushed down as each arrives */}
      {!ready ? wait : <Suspense fallback={wait}>
        <Position jobs={paper} chain={chain.data} />
        <NextMoves moves={nextMoves(paper, chain.data)} business={!!earn.data?.business} work={paper.length + (chain.data?.asProvider.length ?? 0) + (chain.data?.asClient.length ?? 0) > 0} onRetry={chain.reload} />
        <PaperWork earn={earn} receipts={receipts} primary={primary} onDecided={() => { earned.reload(); home.reload(); rcpts.reload() }} />
        <ChainWork v={chain} primary={primary} />
        <Directory onChosen={chain.reload} />
        <MoneyInBook home={home} book={book} salary={salary} earned={earned} topups={topups} paper={earn} chain={chain} receipts={receipts} />
      </Suspense>}
    </div>
  )
}
