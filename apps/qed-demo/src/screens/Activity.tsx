/**
 * Activity (design "Meridian", DESIGN.md M4): everything done in the owner's name, in the bank account and on the
 * on-chain wallet. The page opens on what happened (search, what it came to, the day book); the records QED keeps follow, filed by kind as glass folders (receipts, evidence cases,
 * the instructions signed, the wallet's own records; ui/folder.tsx), each with its figure and the check it carries;
 * then a way to find anything (words, amounts, a payee, an instruction, a check) and narrow it (account, who acted,
 * kind, state); what the rows found came to, per account, in figures that add up; and the day book itself, one line
 * per thing done, grouped by day, the same thing done again in a row folded into one line with each instance a press
 * away. Each row leads to its record, its receipt and its evidence case. What is shown downloads as a CSV file and
 * every receipt as one JSON file that can be checked offline.
 *
 * Every figure is a record's own figure, carried through: a bank row's money and the balance it left come from the bank
 * statement's lines; a wallet row's amount from the wallet's job record (its unit named in words). A run that produced no
 * order or payment (missed, nothing to do, lapsed, refused) is a row too, so that nothing QED was meant to do is absent;
 * the missed runs of one instruction on one day are one row. The period shown is the span every list read covers in
 * full, so the rows and the summary never stop short in one account while running on in the other.
 */
import { ChevronDown, ChevronRight, Download, FileSearch, ReceiptText, ScrollText, Search, SlidersHorizontal, Wallet, X } from 'lucide-react'
import { type MouseEvent, type ReactNode, useCallback, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { Job as WalletJob } from '../../chain/types.ts'
import { homeCurrency, homeSign, UNITS_WORD } from '../../shared/home-money.ts'
import { api, fmt, navigate, rupeesToPaise, useData, useNow, zoneDay, zoneHead, zoneIso, zoneName } from '../lib/core.ts'
import { fundLine } from '../lib/fund-stages.ts'
import { closeTo, nameWords } from '../lib/fuzzy.ts'
import { useUrlState } from '../lib/url-state.ts'
import { checkDates, dayStartIst, isDate, istDate, nextDay, periodFileName, periodOf, periodWords } from '../../shared/period.ts'
import { homeMoneyExact } from '../../shared/home-money.ts'
import type { ActionView, ChainBooksView, ChainEntry, Dispute, PassbookLine, PassbookView, ProgramSummary, Receipt, RunView } from '../lib/types.ts'
import { type Folder, FolderShelf } from '../ui/folder.tsx'
import { Btn, Link, NEEDS_ATTENTION, needsAttention, Problem, Seal, Stamp, StateStamp, STATUS_GLOSSARY, stateWord, useAction } from '../ui/kit.tsx'
import { CASE_KIND, caseOutcome, type CaseSummary, groupCases, receiptOutcome } from '../ui/records.ts'
import { heldWords, IF_NO_ANSWER, railAnswerBy } from '../lib/words.ts'
import { unitsWord } from '../ui/prices.ts'

// ------------------------------------------------------------------------------------------------ the shared head

/**
 * The head of the Activity pages: the page's title at display size, one sentence on what it shows, and the page's own
 * actions beside them. The pages' tabs (Activity, Statement, Evidence) are drawn once by the shell (`SectionNav`); `at`
 * names the page, and its title unless one is given. `aside` is kept for the pages that pass it and sits with the actions.
 */
export function ActivityHead({ at, title = at === 'statement' ? 'Statement' : at === 'evidence' ? 'Evidence' : 'Activity', children, aside, actions }: { at?: 'actions' | 'statement' | 'evidence'; title?: string; children: ReactNode; aside?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head ac-head">
      <div className="ac-head-text"><h1>{title}</h1><p>{children}</p></div>
      {actions || aside ? <div className="ac-head-acts">{actions}{aside}</div> : null}
    </header>
  )
}

// ------------------------------------------------------------------------------------------------ words shared by the record

/** The name of each check the engine records, as a person would say it. */
const CHECK_LABEL: Record<string, string> = {
  'program-active': 'The instruction is in force', 'version-live': 'This is the version you signed', 'authority-in-date': 'Its authority has not ended', 'authority-on-record': 'An approval is on record',
  'size-known': 'The size is known', 'within-run-limit': 'Within the limit for one run', 'within-day-limit': 'Within the limit for a day', 'within-month-limit': 'Within the limit for a month',
  'instrument-in-scope': 'The instruction names this instrument', 'payee-in-scope': 'The instruction names this payee', 'run-approved': 'You approved this run', 'not-stopped': 'You have not stopped QED',
  'owner-approved': 'You approved exactly this', 'instrument-tradable': 'QED can trade this', 'price-fresh': 'The price is fresh', 'price-agrees-with-independent-source': 'The price agrees with a second source',
  'nav-on-record': 'A NAV is on record', 'funds-available': 'The money is there', 'holding-available': 'The holding is there', 'not-more-than-owed': 'Not more than you owe',
  'floor-can-be-evaluated': 'The worst case can be worked out', 'worst-case-stays-above-floor': 'Your worst case stays above your floor', 'stays-liquid': 'What is already due stays covered', 'started-in-time': 'It was started when it was asked for',
}
export const checkLabel = (name: string): string => CHECK_LABEL[name] ?? name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Where an order or payment that has not finished stands, from its recorded result. */
export function inProgressLine(a: ActionView, now = Date.now(), paused = false): string {
  const r = a.result
  if (a.state === 'planned' && r.waitingFor) return `Waiting for fresh data before it is sent: ${String(r.waitingFor).replace(/\.$/, '')}. If none arrives within 45 seconds it is refused, not sent late.`
  // a payment on hold: approved, its money set aside, waiting until its terms' time (server/new-payee.ts)
  if (a.state === 'held') return heldWords(a, now, paused)
  if (a.kind === 'payment') {
    const by = railAnswerBy(a, now)
    return r.railState === 'unknown' ? `The rail has not answered. Do not send it again; QED checks every few seconds and will return the money if it failed.${by ? ` ${by}` : ''}` : `With the rail (${String(r.rail ?? '').toUpperCase() || 'being sent'}). ${r.railNote ? String(r.railNote) : 'It usually settles in seconds.'}${by ? ` ${by} ${IF_NO_ANSWER}` : ''}`
  }
  // a fund order's own states: with the registrar, money received (with its day), units allotted or redeemed (T4-d)
  if (a.instrument?.kind === 'mutual_fund') return a.state === 'planned' ? 'Being checked by QED; nothing has been sent.' : fundLine(a, now)
  if (a.params.type === 'stop') return r.venueNote ? String(r.venueNote) : 'Resting at the venue. It sells when buyers offer your price or less.'
  if (a.params.type === 'limit') return 'Resting at the venue until the market reaches your price.'
  return a.state === 'planned' ? 'Being checked by QED; nothing has been sent.' : 'At the venue.'
}

/**
 * A record's words for reading: test tokens as words, rupees grouped the Indian way, times in India time, and taken out
 * (they stay in the record itself, one step down): raw addresses and hashes, a parenthesis naming a source file or
 * function, a command's flag, and register and decision ids. Used by the wallet's rows here and by the evidence cases.
 */
export function readable(t: string): string {
  return t
    .replace(/\s*(?:for\s+)?\(?0x[0-9a-fA-F]{10,}…?\)?/g, '')
    .replace(/\s*\([^()]*\b[\w./-]+\.(?:ts|tsx|mjs|js|sol|json)\b[^()]*\)/g, '')
    .replace(/\s*\(--[a-z][a-z-]*\)/g, '')
    .replace(/\s*\((?:(?:[A-Z]{1,3}\d*-\d{2,3}|R\d+|D\d+)[\s,;]*)+\)/g, '')
    .replace(/\s*[:;,]\s*(?:the )?(?:owner(?:'s)? )?decision [A-Z]{1,3}-\d{2,3}\b/g, '')
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d{4,})(\.\d+)?(?= (?:test )?tINR\b)/g, (_, int: string, frac?: string) => `${Number(int.replace(/,/g, '')).toLocaleString('en-IN')}${frac ?? ''}`)
    .replace(/(?<![A-Za-z])(?:test )?tINR\b/g, 'test rupees')
    .replace(/(?<![A-Za-z])(?:test )?tUSD\b/g, 'test dollars')
    .replace(/(?<![A-Za-z])(?:test )?tEUR\b/g, 'test euros')
    .replace(/(?<![A-Za-z])(?:test )?tETH\b/g, 'test ether')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (x) => fmt.dayTime(Date.parse(x)))
}

// ------------------------------------------------------------------------------------------------ the rows

export type Account = 'bank' | 'wallet'
/** Who acted. 'chain': a movement QED only saw on the chain and entered in the books; it did not act, and the row names the other party (`by`) or the chain. */
export type Who = 'you' | 'qed' | 'chain'
/** What a row is: a payment, an order or conversion, a run with nothing sent, a change of authority, a dispute. */
export type Kind = 'payment' | 'order' | 'run' | 'authority' | 'dispute'
/** Where a row's state puts it, for the counts that add up: every row is in exactly one. */
export type Bucket = 'done' | 'waiting' | 'trouble' | 'other'
type Tone = 'ok' | 'wait' | 'void' | 'plain' | undefined
/** The unit of an amount: rupees, in paise, in the bank; a test token on the wallet's chain, in its smallest unit. */
export type Unit = { kind: 'inr' } | { kind: 'token'; symbol: string; decimals: number; words: string }
const INR: Unit = { kind: 'inr' }

/** The name a row's actor column shows. */
export const whoName = (e: { who: Who; by?: string }): string => (e.who === 'you' ? 'You' : e.who === 'chain' ? e.by ?? 'The chain' : 'QED')
const whoClass = (w: Who): string => (w === 'qed' ? 'by-qed' : w === 'you' ? 'by-you' : 'by-other')
/** Who a movement QED only observed is credited to: the party the books name, the escrow or faucet by what it is, else the chain. */
const observedBy = (cp: { kind: string; label: string | null } | null): string =>
  cp?.label ?? (cp?.kind === 'escrow' ? 'The escrow contract' : cp?.kind === 'faucet' ? 'The local chain\'s faucet' : cp?.kind === 'conversion' ? 'The conversion venue' : cp?.kind === 'workspace' ? 'Another wallet on this computer' : 'The chain')

/** One thing that happened, as the day book shows it. */
export interface DayEvent {
  key: string; ts: number
  account: Account; kind: Kind
  /** Who acted: the owner (by hand, or by asking from the session), or QED under authority signed earlier. */
  who: Who
  /** For 'chain': the other party's name when the books know one, else "The chain". */
  by?: string
  /** What happened, without its actor (the actor has a column of its own). */
  what: string
  /** The names it is about (a payee, an instrument, an instruction): where search forgives a slip of the finger. */
  names: string[]
  /** What else a person needs to read it, in plain fragments: the note, the rail, the checks, the venue's record. */
  detail: string[]
  /** The instruction or authority it ran under. */
  under: string
  state: string; recon: string | null
  /** A stamp of its own (a dispute's, a wallet job's); otherwise the state's. */
  stamp: { tone: Tone; word: string } | null
  /** In the unit's smallest step. Signed when it moved (negative out, positive in); the amount asked for when nothing moved. */
  amount: number | null; moved: boolean; unit: Unit
  /** A second amount that came back for the first (what a conversion delivered), in its own unit. */
  received: { amount: number; unit: Unit } | null
  /** The consequence: the balance after it, or what happened to the money. */
  after: string
  receipt: boolean
  to: string
  bucket: Bucket
  waiting: boolean; trouble: boolean
  /** Its receipt, once it finished with one. */
  receiptId?: string | null
  /** Its evidence case, by the evidence list's own ids (run.<run>, vault.<job>), when it can have one. */
  caseId?: string | null
}

const istDay = zoneDay
const n = (v: unknown): number => Number(v ?? 0)
const firstSentence = (t: string): string => { const k = t.indexOf('. '); return k > 0 ? t.slice(0, k + 1) : t }
/**
 * A detail is a fragment: its words without closing punctuation, since detailText puts one full stop after each. A
 * record's own sentence ("Money sent.") once kept its stop and the day book file read "Money sent.. 7 of 7 checks passed"
 * (R12 task comparison, item 19). `whole` keeps every sentence of a text; `fragment` keeps only its first.
 */
const whole = (t: string): string => t.trim().replace(/[\s.;,:]+$/, '')
const fragment = (t: string): string => whole(firstSentence(t))
const lower = (t: string): string => t.replace(/^./, (c) => c.toLowerCase())
const qtyText = (atoms: unknown, scale: number): string => (n(atoms) / 10 ** scale).toLocaleString('en-IN', { maximumFractionDigits: scale })
const RAIL: Record<string, string> = { upi: 'by UPI', imps: 'by IMPS', neft: 'by NEFT', rtgs: 'by RTGS', internal: 'inside your bank' }
const WAITING = new Set(['planned', 'awaiting_approval', 'held', 'submitting', 'working', 'due', 'objection_window', 'executing'])
const TROUBLE = new Set(['blocked', 'failed', 'rejected', 'missed', 'expired', 'partial'])
const IDLE = new Set(['missed', 'skipped', 'expired', 'cancelled', 'blocked', 'failed'])
const bucketOf = (waiting: boolean, trouble: boolean, done: boolean): Bucket => (trouble ? 'trouble' : waiting ? 'waiting' : done ? 'done' : 'other')

type ActivityAction = ActionView & { programTitle?: string | null }

/** What an order or payment did, without its actor: past tense once it filled or settled, else what was asked. */
function actionWhat(a: ActivityAction): string {
  const finished = a.state === 'done' || a.state === 'partial', part = a.state === 'partial' ? ', in part' : ''
  if (a.kind === 'payment') {
    const to = String(a.params.payeeName ?? 'the payee')
    // a contribution to a goal pays nobody: it is set aside inside the household's own bank
    if (a.params.purpose === 'goal') return finished ? `Set aside for ${to}${part}` : `Setting aside for ${to}`
    return finished ? `Paid ${to}${part}` : `Payment to ${to}`
  }
  const name = a.instrument?.name ?? 'an instrument'
  const fund = a.instrument?.kind === 'mutual_fund', buy = a.params.side !== 'sell'
  if (finished) return `${buy ? (fund ? 'Invested in' : 'Bought') : (fund ? 'Redeemed' : 'Sold')} ${name}${part}`
  return `Order to ${buy ? (fund ? 'invest in' : 'buy') : (fund ? 'redeem' : 'sell')} ${name}`
}

/** What else the row needs: the note and the rail, what filled, where it stands, and its checks. */
function actionDetail(a: ActivityAction): string[] {
  const d: string[] = []
  const said = [a.kind === 'payment' && a.params.memo ? whole(String(a.params.memo)) : '', a.kind === 'payment' && (a.state === 'done' || a.state === 'partial') && a.result.rail ? RAIL[String(a.result.rail)] ?? `by ${String(a.result.rail).toUpperCase()}` : ''].filter(Boolean).join(', ')
  if (said) d.push(said)
  if (a.kind === 'order' && a.instrument && n(a.result.filledQty) > 0) d.push(`${qtyText(a.result.filledQty, a.instrument.baseScale)} ${unitsWord(a.instrument.kind, a.instrument.baseAsset)}`)
  if (WAITING.has(a.state) && a.state !== 'awaiting_approval') d.push(fragment(inProgressLine(a)))
  if (['failed', 'rejected', 'cancelled', 'expired', 'partial'].includes(a.state) && a.error) d.push(fragment(a.error))
  // a dispute pack can be made for a payment that is disputed or whose outcome is uncertain (server/dispute-pack.ts)
  if (a.packReason && a.packReason !== 'disputed') d.push('Its outcome is in doubt: a dispute pack can be made from its record')
  const checks = a.decision.checks ?? []
  const failed = checks.filter((c) => !c.ok)
  if (checks.length) d.push(failed.length ? `Refused on ${failed.length} of ${checks.length} checks: ${lower(checkLabel(failed[0]!.name))}` : `${checks.length} of ${checks.length} checks passed`)
  // what the venue's own record says, once it finished there: agreeing is a protection worth saying, as is not knowing yet
  if (a.state === 'done' || a.state === 'partial') {
    if (a.reconState === 'break') d.push('The venue\'s record differs from your ledger')
    else if (a.reconState === 'reconciled') d.push('The venue\'s record agrees')
    else if (a.reconState === 'open') d.push('Not yet compared with the venue\'s record')
  }
  return d
}

/**
 * The bank account's rows, newest first: each order and payment (its money and balance from the bank statement's own
 * lines), each run that produced neither, and each dispute raised on a payment.
 */
export function toEvents(d: { actions: ActivityAction[]; runs: RunView[]; disputes?: Dispute[] }, lines: PassbookLine[]): DayEvent[] {
  // the bank lines each action made: their sum is what it moved, the last one's balance is what it left
  const bank = new Map<string, { amount: number; balance: number; seq: number }>()
  for (const l of lines) {
    if (!l.actionId) continue
    const b = bank.get(l.actionId)
    bank.set(l.actionId, { amount: (b?.amount ?? 0) + l.amount, balance: !b || l.seq > b.seq ? l.balance : b.balance, seq: Math.max(l.seq, b?.seq ?? 0) })
  }
  const events: DayEvent[] = d.actions.map((a) => {
    const fund = a.instrument?.kind === 'mutual_fund', buy = a.params.side !== 'sell'
    const asked = n(a.result.movedPaise) || n(a.params.amount) || null
    const outward = a.kind === 'payment' || buy
    const b = bank.get(a.id)
    let amount: number | null = asked, moved = false, after = 'Nothing moved'
    if (b && b.amount !== 0) { amount = b.amount; moved = true; after = `${fmt.money(b.balance, true)} after` }
    else if (b) after = 'Sent, and returned to your bank'
    else if ((a.state === 'done' || a.state === 'partial') && asked) { amount = outward ? -asked : asked; moved = true; after = '' }
    else if (a.state === 'awaiting_approval') after = 'Nothing has moved'
    else if (WAITING.has(a.state)) after = 'Not settled yet'
    else if (a.state === 'failed' && (a.kind === 'payment' || (fund && buy))) after = 'Returned to your bank'
    const waiting = WAITING.has(a.state), trouble = TROUBLE.has(a.state) || (a.reconState === 'break' && (a.state === 'done' || a.state === 'partial'))
    return {
      key: a.id, ts: a.createdAt, account: 'bank', kind: a.kind, who: a.origin === 'owner' ? 'you' : 'qed', what: actionWhat(a), detail: actionDetail(a),
      names: [a.kind === 'payment' ? String(a.params.payeeName ?? '') : a.instrument?.name ?? '', a.programTitle ?? ''].filter(Boolean),
      under: a.origin === 'owner' ? 'Your approval' : a.origin === 'commerce' ? 'Your commerce mandate' : a.programTitle ?? 'One of your instructions',
      state: a.state, recon: a.reconState ?? null, stamp: null, amount, moved, unit: INR, received: null, after, receipt: !!a.receiptId, to: `/record/${a.id}`,
      bucket: bucketOf(waiting, trouble, a.state === 'done'), waiting, trouble, receiptId: a.receiptId ?? null, caseId: a.runId ? `run.${a.runId}` : null,
    }
  })

  // Runs that never became an order or a payment. A night with the computer asleep can miss dozens of runs of one
  // instruction; those are one fact, so the missed (and the idle) runs of an instruction on one India day are one row.
  const withAction = new Set(d.actions.map((a) => a.runId).filter(Boolean))
  const folded = new Map<string, RunView[]>()
  for (const r of d.runs.filter((x) => !withAction.has(x.id) && IDLE.has(x.state))) {
    const k = r.state === 'missed' || r.state === 'skipped' ? `${r.state} ${r.programId} ${istDay(r.dueAt)}` : r.id
    folded.set(k, [...(folded.get(k) ?? []), r])
  }
  for (const g of folded.values()) {
    const r = g[0]!, times = g.map((x) => x.dueAt), first = Math.min(...times), last = Math.max(...times), many = g.length > 1
    const what: Record<string, string> = {
      missed: many ? `Missed ${g.length} runs` : 'Missed a run', skipped: many ? `${g.length} runs had nothing to do` : 'A run had nothing to do',
      expired: 'A run lapsed', cancelled: 'A run was cancelled', blocked: 'Refused a run', failed: 'A run failed',
    }
    const reason = !r.reason ? null : !many ? whole(r.reason) : g.every((x) => x.reason === r.reason) ? `For each: ${whole(r.reason)}` : null
    const trouble = TROUBLE.has(r.state)
    events.push({
      key: many ? `${r.state} ${r.programId} ${first}` : r.id, ts: last, account: 'bank', kind: 'run', who: 'qed', what: what[r.state] ?? 'A run', names: r.programTitle ? [r.programTitle] : [],
      detail: [many ? `Due from ${fmt.time(first)} to ${fmt.time(last)}` : `Due ${fmt.time(first)}`, reason].filter((x): x is string => !!x),
      under: r.programTitle ?? 'One of your instructions', state: r.state, recon: null, stamp: null, amount: null, moved: false, unit: INR, received: null, after: 'Nothing moved', receipt: false, to: `/instructions/${r.programId}`,
      bucket: bucketOf(false, trouble, false), waiting: false, trouble, receiptId: null, caseId: many ? null : `run.${r.id}`,
    })
  }

  const byId = new Map(d.actions.map((a) => [a.id, a]))
  for (const x of d.disputes ?? []) {
    const a = x.action_id ? byId.get(x.action_id) : undefined
    const word: [Tone, string] = x.state === 'open' ? ['wait', 'Dispute open'] : x.state === 'resolved_refund' ? ['ok', 'Refunded'] : ['plain', 'Payment stands']
    events.push({
      key: x.id, ts: x.created_at, account: 'bank', kind: 'dispute', who: 'you', what: `Disputed ${a?.params.payeeName ? `the payment to ${String(a.params.payeeName)}` : 'a payment'}`, names: a?.params.payeeName ? [String(a.params.payeeName)] : [],
      detail: [`You said: “${whole(x.reason)}”`, x.state !== 'open' && x.resolution ? whole(x.resolution) : '', 'A dispute pack for it (approval, receipts, timeline, payee, bank reference) is on its record'].filter(Boolean), under: 'Your request', state: x.state, recon: null,
      stamp: { tone: word[0], word: word[1] }, amount: null, moved: false, unit: INR, received: null, after: '', receipt: false, to: x.action_id ? `/record/${x.action_id}` : '/activity',
      bucket: x.state === 'open' ? 'waiting' : x.state === 'resolved_refund' ? 'done' : 'other', waiting: x.state === 'open', trouble: false, receiptId: null, caseId: null,
    })
  }
  return events.sort((a, b) => b.ts - a.ts)
}

// ------------------------------------------------------------------------------------------------ the wallet's rows

/** The parts of a wallet job (chain/types.ts Job) a row reads. */
export type WalletJobLine = Pick<WalletJob, 'id' | 'kind' | 'status' | 'createdAt' | 'proposalId'> & { error?: string | null; result: { outcome: string; summary?: string; tx?: { block: string } | null; evidence?: Record<string, unknown> } | null }
/** The wallet's two units: its main asset (test rupees) and its reserve (test dollars), as the workspace declares them. */
export interface WalletUnits { asset: { symbol: string; decimals: number }; reserve: { symbol: string; decimals: number } | null }
const TOKEN_WORDS: Record<string, string> = { tINR: 'test rupees', tUSD: 'test dollars', tEUR: 'test euros', tETH: 'test ether' }
type TokenUnit = Extract<Unit, { kind: 'token' }>
const tokenUnit = (a: { symbol: string; decimals: number }): TokenUnit => ({ kind: 'token', symbol: a.symbol, decimals: a.decimals, words: TOKEN_WORDS[a.symbol] ?? a.symbol })
/** A token amount in its smallest unit, written with its decimals (moved as digits, never through a float). */
export function tokenFigure(raw: number, decimals: number, symbol = 'tINR'): string {
  const neg = raw < 0, s = String(Math.abs(Math.trunc(raw))).padStart(decimals + 1, '0')
  const int = decimals ? s.slice(0, -decimals) : s, frac = decimals ? s.slice(-decimals) : ''
  const shown = frac.replace(/0+$/, '').padEnd(Math.min(2, decimals), '0')
  return `${neg ? '−' : ''}${Number(int).toLocaleString(symbol === 'tINR' ? 'en-IN' : 'en-US')}${shown ? `.${shown}` : ''}`
}

const STANDING = new Set(['policy-tick', 'policy-run'])
const LAB = new Set(['economy', 'attack', 'scenario'])
const AUTHORITY = new Set(['provision', 'mandate', 'policy', 'policy-revoke', 'grant', 'earned-caps', 'revoke-mandate', 'void-all', 'rotate-key', 'add-signer', 'remove-signers', 'set-thresholds', 'start-recovery', 'apply-change', 'cancel-change', 'pause', 'resume', 'guardian-pause', 'venues'])
/** What a wallet job did (once it executed) and what it asked for (otherwise), by its kind. */
const WALLET_DID: Record<string, [string, string]> = {
  provision: ['Accepted the wallet; its opening grant arrived', 'Accepting the wallet'], mandate: ['Signed a mandate', 'Signing a mandate'], policy: ['Signed a standing policy', 'Signing a standing policy'],
  'policy-revoke': ['Ended the standing policy', 'Ending the standing policy'], grant: ['Granted the agent more authority', 'More authority for the agent'], 'revoke-mandate': ['Revoked the mandate', 'Revoking the mandate'],
  'void-all': ['Voided every mandate', 'Voiding every mandate'], 'rotate-key': ['Replaced a key', 'Replacing a key'], 'add-signer': ['Added a signer', 'Adding a signer'], 'remove-signers': ['Removed signers', 'Removing signers'],
  'set-thresholds': ['Changed how many must sign', 'Changing how many must sign'], 'start-recovery': ['Started a recovery of the wallet', 'Starting a recovery'], 'apply-change': ['Applied a scheduled change', 'Applying a scheduled change'],
  'cancel-change': ['Cancelled a scheduled change', 'Cancelling a scheduled change'], pause: ['Paused the wallet', 'Pausing the wallet'], resume: ['Resumed the wallet', 'Resuming the wallet'], 'guardian-pause': ['Paused as guardian', 'Pausing as guardian'],
  venues: ['Named the venues', 'Naming the venues'], 'ring-fence': ['Set money aside for a creditor', 'Setting money aside'], settle: ['Paid a promise that fell due', 'Paying a promise that fell due'],
  withdraw: ['Withdrew to your own account', 'Withdrawal to your own account'], deposit: ['Deposited from your own account', 'Deposit from your own account'],
  'escrow-quote': ['Offered work through the escrow', 'Offer of work through the escrow'], 'escrow-fund': ['Funded work through the escrow', 'Funding work through the escrow'], 'escrow-deliver': ['Delivered work to the escrow', 'Delivery to the escrow'],
  'escrow-release': ['Released the client from the escrow', 'Release from the escrow'], 'escrow-refund': ['Refunded an escrow job', 'Refund of an escrow job'],
  'policy-tick': ['Topped up the reserve', 'Top-up of the reserve'], 'policy-run': ['Topped up the reserve', 'Top-up of the reserve'],
  economy: ['Ran a scripted economy', 'A scripted economy'], attack: ['Ran an attack test', 'An attack test'], scenario: ['Ran a scenario', 'A scenario'],
  'bounty-commit': ['Committed a bounty claim', 'Committing a bounty claim'], 'bounty-reveal': ['Revealed a bounty claim', 'Revealing a bounty claim'], 'bounty-settle': ['Settled a bounty', 'Settling a bounty'],
}
/** A wallet outcome as the day book's shared state words: the vault's own words stay in its record. */
const WALLET_STATE: Record<string, [string, Tone, Bucket]> = {
  executed: ['Completed', 'ok', 'done'], scheduled: ['Scheduled', 'wait', 'waiting'], refused: ['Refused by QED\'s checks', 'void', 'trouble'], reverted: ['Reverted on the chain', 'void', 'trouble'],
  'no-action': ['Nothing to do', 'plain', 'other'], error: ['Do not retry', 'void', 'trouble'],
  accepted: ['Submitted', undefined, 'waiting'], running: ['Pending', undefined, 'waiting'], failed: ['Failed', 'void', 'trouble'], interrupted: ['Interrupted: not known yet', 'void', 'trouble'], done: ['Completed', 'ok', 'done'],
}
/** A co-signer refusal's rule by its name (its number stays in the record's checks); the rest of the record's words otherwise. */
function walletReason(summary: string): string {
  const m = /^Co-signer refused: (C\d+) not met: ([^:]+):/.exec(summary)
  if (m) return `The co-signer refused it under its ${whole(lower(readable(m[2]!.replace(/\s*\((?:R\d+ )?(?:decision )?D\d+[^)]*\)/g, '').trim())))} rule`
  return fragment(readable(summary))
}

/**
 * The on-chain wallet's rows, newest first, from the list of jobs its records page reads. Who acted: the owner when the
 * job carries a proposal the owner's passkey signed, or asked for it from the session (a promise settled, a scheduled
 * change applied, a test in the lab); QED for the standing policy's ticks and runs, which its scheduler starts.
 * Amounts come from the job's own record where it states them: a payment, money set aside, a conversion, the opening
 * grant. A job whose record states no amount says so rather than showing a figure.
 */
export function walletEvents(jobs: WalletJobLine[], units: WalletUnits | null): DayEvent[] {
  return jobs.map((j) => {
    const outcome = j.result?.outcome ?? j.status
    const [word, tone, bucket] = WALLET_STATE[outcome] ?? [outcome, 'plain' as Tone, 'other' as Bucket]
    const done = outcome === 'executed'
    const ev = (j.result?.evidence ?? {}) as Record<string, unknown>
    const main = units ? tokenUnit(units.asset) : null, reserve = units?.reserve ? tokenUnit(units.reserve) : null
    const payee = typeof ev.payeeLabel === 'string' ? ev.payeeLabel : null
    // a promise is ring-fenced as a liability, to be paid when due; a payment made now has no liability and no due day
    const due = n(ev.dueAt)
    const promise = j.kind === 'pay' && ((ev.liabilityId !== undefined && ev.liabilityId !== null && ev.liabilityId !== '') || n(ev.dueInDays) > 0)
    let what = (WALLET_DID[j.kind] ?? [`${j.kind.replace(/-/g, ' ')}`, `${j.kind.replace(/-/g, ' ')}`])[done ? 0 : 1]
    if (j.kind === 'pay') what = promise ? (done ? `Promised ${payee ?? 'a payee'} a payment` : `Promise to ${payee ?? 'a payee'}`) : (done ? `Paid ${payee ?? 'a payee'}` : `Payment to ${payee ?? 'a payee'}`)
    if (j.kind === 'convert' && main && reserve) what = done ? `Converted ${main.words} into ${reserve.words}` : `Conversion of ${main.words} into ${reserve.words}`
    what = what.replace(/^./, (c) => c.toUpperCase())

    // the amount, in its own unit, where the record states it
    let amount: number | null = null, moved = false, received: DayEvent['received'] = null, after = done ? 'Amount in its record' : 'Nothing moved'
    if (main && (j.kind === 'pay' || j.kind === 'ring-fence') && ev.amount !== undefined) {
      amount = n(ev.amount)
      if (promise || j.kind === 'ring-fence') after = done ? `Set aside${due > 0 ? `, due ${fmt.day(due * 1000)}` : ''}` : 'Nothing moved'
      else if (done) { amount = -amount; moved = true; after = 'Left the wallet' }
    } else if (main && (j.kind === 'convert' || STANDING.has(j.kind)) && ev.amountIn !== undefined) {
      amount = n(ev.amountIn)
      if (done) { amount = -amount; moved = true; after = 'Into the reserve'; if (reserve && ev.amountOut !== undefined) received = { amount: n(ev.amountOut), unit: reserve } }
    } else if (main && j.kind === 'provision' && done && ev.grant && typeof ev.grant === 'object' && (ev.grant as { vault?: unknown }).vault !== undefined) {
      amount = n((ev.grant as { vault: unknown }).vault); moved = true; after = 'The opening grant'
    } else if (reserve && j.kind === 'bounty-settle' && done && ev.ours === true && ev.payout !== undefined) {
      // a bounty this household won pays its reserve: money in, in test dollars (the bounty specialist's finding)
      received = { amount: n(ev.payout), unit: reserve }; moved = true; after = 'Paid into the reserve by the bounty'
    } else if (AUTHORITY.has(j.kind) || !done) after = 'Nothing moved'
    if (LAB.has(j.kind)) after = 'A test on a throwaway chain; nothing of yours moved'

    const summary = j.result?.summary ?? ''
    // block numbers, hashes and addresses are references, one step down on the job's own page
    const detail = [summary ? walletReason(summary) : '', j.error ? fragment(j.error) : ''].filter(Boolean)
    return {
      key: `job:${j.id}`, ts: Date.parse(j.createdAt), account: 'wallet' as const, names: payee ? [payee] : [],
      kind: (j.kind === 'pay' || j.kind === 'settle' || j.kind === 'withdraw' || j.kind === 'deposit' || j.kind.startsWith('escrow') || j.kind === 'ring-fence' || (j.kind === 'bounty-settle' && moved) ? 'payment' : j.kind === 'convert' || (STANDING.has(j.kind) && done) ? 'order' : STANDING.has(j.kind) || LAB.has(j.kind) ? 'run' : 'authority') as Kind,
      who: (STANDING.has(j.kind) ? 'qed' : 'you') as Who, what, detail,
      under: j.proposalId ? 'Your signature on these terms' : STANDING.has(j.kind) ? 'The standing policy you signed' : LAB.has(j.kind) ? 'A test in the lab' : 'Authority you signed earlier',
      state: outcome, recon: null, stamp: { tone, word }, amount, moved, unit: main ?? INR, received, after, receipt: false, to: `/vault/job/${j.id}`,
      bucket, waiting: bucket === 'waiting', trouble: bucket === 'trouble', receiptId: null, caseId: `vault.${j.id}`,
    }
  }).sort((a, b) => b.ts - a.ts)
}

/** A test-token amount in its own words, never with a currency sign: "25.51 test rupees". */
const tokenWords = (raw: number, decimals: number, symbol: string, words: string): string => `${tokenFigure(raw, decimals, symbol)} ${words}`
/** What an entry moved in or out of the wallet's own holders (a move between them is nothing), in its token. */
function holderDelta(e: ChainEntry): { raw: number; unit: TokenUnit } | null {
  const ls = e.lines.filter((l) => l.holder)
  if (!ls.length) return null
  return { raw: ls.reduce((t, l) => t + Number(l.amount_text), 0), unit: { kind: 'token', symbol: ls[0]!.symbol, decimals: ls[0]!.decimals, words: ls[0]!.words } }
}

/**
 * The on-chain wallet's rows with what the books hold of them (server/chain-books.ts). Each booked entry says when it took
 * effect on the chain (its block's time) and when QED entered it in the books, and that its tokens are valueless test
 * tokens on a local chain, with its amount in words. An entry of a job listed here is told on that job's row; an entry with
 * no job here (an escrow paying in, a refund another sent, money from outside) is a row of its own. The books' amounts are
 * told in words only, never as a row's figure, so the wallet's summary counts each job's own figure once, as before (a
 * figure taken from the books once put an escrow earning under "Paid out"). A disagreement between the books and the
 * chain is a row too, with its figures; nothing was corrected.
 */
export function withBooks(rows: DayEvent[], books: ChainBooksView | null): DayEvent[] {
  if (!books) return rows
  const jobs = new Set(rows.map((r) => r.key.slice(4)))
  const byJob = new Map<string, ChainEntry[]>()
  const alone: ChainEntry[] = []
  for (const e of books.entries) { if (e.jobId && jobs.has(e.jobId)) byJob.set(e.jobId, [...(byJob.get(e.jobId) ?? []), e]); else alone.push(e) }
  const moved = (e: ChainEntry): string => { const d = holderDelta(e); return !d || d.raw === 0 ? 'within the wallet' : `${tokenWords(Math.abs(d.raw), d.unit.decimals, d.unit.symbol, d.unit.words)} ${d.raw > 0 ? 'in' : 'out'}` }
  const told = (e: ChainEntry): string[] => [`${e.memo} (${moved(e)}): took effect ${fmt.full(e.effectiveTs)} on the chain`, `entered in your books ${fmt.full(e.entryTs)}${e.recordedLate ? ', later than it happened' : ''}`]
  const label = (u: TokenUnit | null): string => `${u ? `${u.words[0]!.toUpperCase()}${u.words.slice(1)}` : 'Test tokens'}: ${books.words}`
  const out = rows.map((r) => {
    const es = byJob.get(r.key.slice(4))
    if (!es) return r
    const unit = es.map(holderDelta).find((x) => !!x)?.unit ?? null
    return { ...r, detail: [...r.detail, ...es.flatMap(told), label(unit)] }
  })
  for (const e of alone) {
    const d = holderDelta(e)
    const cp = e.counterparty
    out.push({
      key: `book:${e.seq}`, ts: e.effectiveTs, account: 'wallet', names: cp?.label ? [cp.label] : [],
      kind: e.kind.startsWith('chain-conversion') ? 'order' : 'payment', who: 'chain', by: observedBy(cp), what: e.memo, detail: [...told(e), label(d?.unit ?? null)],
      under: 'Seen on the chain and entered in your books by QED', state: 'booked', recon: null, stamp: { tone: 'ok', word: 'In your books' },
      amount: null, moved: false, unit: d?.unit ?? INR, received: null,
      after: e.kind === 'chain-escrow-earning' ? 'Received for work' : e.kind === 'chain-escrow-settled' ? 'Paid for work from the escrow' : 'In your books',
      receipt: false, to: '/vault/records', bucket: 'done', waiting: false, trouble: false, receiptId: null, caseId: null,
    })
  }
  const c = books.comparison
  if (c?.state === 'disagrees') {
    const off = c.assets.filter((a) => a.difference !== '0')
    const u: TokenUnit | null = off[0] ? { kind: 'token', symbol: off[0].symbol, decimals: off[0].decimals, words: off[0].words } : null
    out.push({
      key: `chainrecon:${c.at}`, ts: c.at, account: 'wallet', names: [], kind: 'run', who: 'qed', what: 'Your books and your on-chain wallet disagree',
      detail: [...(c.why ? [c.why] : []), ...off.map((a) => `${a.words}: the books hold ${tokenWords(Number(a.books), a.decimals, a.symbol, a.words)} with ${tokenWords(Number(a.inFlight), a.decimals, a.symbol, a.words)} in flight; the chain holds ${a.chain === null ? 'an amount not known' : tokenWords(Number(a.chain), a.decimals, a.symbol, a.words)}`), 'Nothing was corrected', label(u)],
      under: 'The comparison QED makes every half minute', state: 'disagrees', recon: null, stamp: { tone: 'void', word: 'Books and chain disagree' },
      amount: null, moved: false, unit: u ?? INR, received: null, after: 'Nothing was corrected', receipt: false, to: '/protect', bucket: 'trouble', waiting: false, trouble: true, receiptId: null, caseId: null,
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

// ------------------------------------------------------------------------------------------------ the period, folds, days

/**
 * The start of the period every list read covers in full, or null when each was read to its end. A list that came back
 * as long as was asked for may stop short of older entries, so it covers only back to its oldest entry; rows older than
 * the latest such point would show one list's past without the other's, and are left out with a way to read further.
 */
export function periodStart(lists: { count: number; asked: number; oldest: number | null }[]): number | null {
  const cut = lists.filter((l) => l.count >= l.asked && l.oldest !== null).map((l) => l.oldest!)
  return cut.length ? Math.max(...cut) : null
}

/**
 * Rows in a run that say the same thing (same account, actor, authority, words and state) are one line: a standing
 * instruction that buys every five minutes is one fact seen many times. Each keeps its own record one press away.
 */
export function foldRepeats(events: DayEvent[]): { lead: DayEvent; all: DayEvent[] }[] {
  const sig = (e: DayEvent) => [e.account, e.kind, e.who, e.by ?? '', e.under, e.what, e.state, e.recon ?? '', e.stamp?.word ?? '', e.moved ? 'moved' : 'unmoved', e.unit.kind === 'token' ? e.unit.symbol : 'inr'].join('\u0000')
  const out: { lead: DayEvent; all: DayEvent[] }[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && sig(last.lead) === sig(e) && istDay(last.lead.ts) === istDay(e.ts)) last.all.push(e)
    else out.push({ lead: e, all: [e] })
  }
  return out
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "Today", "Yesterday", or "Wednesday 18 November", with the year only when it is not this year. */
function dayName(key: string, now: number): { name: string; date: string } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const today = istDay(now)
  const long = `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}`
  if (key === today) return { name: 'Today', date: long }
  if (key === istDay(now - 86_400_000)) return { name: 'Yesterday', date: long }
  return { name: long, date: '' }
}
/** The events of each India day, newest day first and newest first within it. */
export function byDay(events: DayEvent[], now: number): { key: string; name: string; date: string; events: DayEvent[] }[] {
  const days: { key: string; name: string; date: string; events: DayEvent[] }[] = []
  for (const e of [...events].sort((a, b) => b.ts - a.ts)) {
    const key = istDay(e.ts)
    const last = days[days.length - 1]
    if (last && last.key === key) last.events.push(e)
    else days.push({ key, ...dayName(key, now), events: [e] })
  }
  return days
}

// ------------------------------------------------------------------------------------------------ filters and search

/** Which way money moved: into the account or out of it. */
export type Direction = 'in' | 'out'
export interface Filters { account: 'all' | Account; who: 'all' | Who; kind: 'all' | Kind; state: 'all' | Bucket; direction: 'all' | Direction }
export const NO_FILTER: Filters = { account: 'all', who: 'all', kind: 'all', state: 'all', direction: 'all' }
export const FILTER_CHOICES: { [K in keyof Filters]: { label: string; options: [Filters[K], string][] } } = {
  account: { label: 'Account', options: [['all', 'Both accounts'], ['bank', 'Bank account'], ['wallet', 'On-chain wallet']] },
  who: { label: 'Who acted', options: [['all', 'Anyone'], ['you', 'You'], ['qed', 'QED'], ['chain', 'The chain or another party']] },
  kind: { label: 'Kind', options: [['all', 'Everything'], ['payment', 'Payments'], ['order', 'Orders and conversions'], ['run', 'Runs with nothing sent'], ['authority', 'Changes of authority'], ['dispute', 'Disputes']] },
  state: { label: 'State', options: [['all', 'Any state'], ['done', 'Completed'], ['waiting', 'Not finished yet'], ['trouble', 'Refused, rejected or failed'], ['other', 'Other']] },
  direction: { label: 'Direction', options: [['all', 'In and out'], ['in', 'Money in'], ['out', 'Money out']] },
}
/**
 * Which way a row moved money, or null when it moved none (a refusal, a run with nothing sent, a change of authority, a
 * dispute, a promise set aside). A conversion is money out of the wallet's rupees; a bounty won is money in.
 */
export function directionOf(e: DayEvent): Direction | null {
  if (!e.moved) return null
  if (e.amount !== null && e.amount !== 0) return e.amount > 0 ? 'in' : 'out'
  return e.received ? 'in' : null
}
export const matches = (f: Filters) => (e: DayEvent): boolean =>
  (f.account === 'all' || e.account === f.account) && (f.who === 'all' || e.who === f.who) && (f.kind === 'all' || e.kind === f.kind) && (f.state === 'all' || e.bucket === f.state)
  && (f.direction === 'all' || directionOf(e) === f.direction)

/** An amount range in paise (ends included) and a date range in India days (ends included); null is an open end. */
export interface Ranges { min: number | null; max: number | null; first: string | null; last: string | null }
export const NO_RANGES: Ranges = { min: null, max: null, first: null, last: null }
/**
 * A row's amount as a share of a rupee, exactly (numerator, denominator): paise over 100, test rupees over 10 to the
 * power of their decimals. Null when the row states no amount in rupees (nothing asked, or another token).
 */
function rupeeShare(e: DayEvent): [bigint, bigint] | null {
  if (e.amount === null) return null
  const mag = BigInt(Math.abs(Math.trunc(e.amount)))
  if (e.unit.kind === 'inr') return [mag, 100n]
  return e.unit.symbol === 'tINR' ? [mag, 10n ** BigInt(e.unit.decimals)] : null
}
/** Whether a row lies within the amount range (the amount it shows, moved or asked) and the date range (its time, India days). */
export const inRanges = (r: Ranges) => (e: DayEvent): boolean => {
  if (r.min !== null || r.max !== null) {
    const share = rupeeShare(e)
    if (!share) return false
    const [n, d] = share
    if (r.min !== null && n * 100n < BigInt(r.min) * d) return false
    if (r.max !== null && n * 100n > BigInt(r.max) * d) return false
  }
  if (r.first !== null && e.ts < dayStartIst(r.first)) return false
  if (r.last !== null && e.ts >= dayStartIst(nextDay(r.last))) return false
  return true
}

/** The four range fields as typed: amounts in rupees, days as YYYY-MM-DD (a date field's own value). */
export interface RangeText { min: string; max: string; first: string; last: string }
export const NO_RANGE_TEXT: RangeText = { min: '', max: '', first: '', last: '' }
/**
 * The ranges the typed fields make, and the words for each field that is wrong. A field that is not an amount or a date,
 * or a pair the wrong way round, is not applied at all (both ends of that pair stay open) until it is put right.
 */
export function rangesFrom(t: RangeText): { ranges: Ranges; errors: Partial<Record<keyof RangeText, string>> } {
  const errors: Partial<Record<keyof RangeText, string>> = {}
  const money = (k: 'min' | 'max'): number | null => { const v = t[k].trim(); if (!v) return null; const p = rupeesToPaise(v); if (p === null) errors[k] = `Give an amount in ${UNITS_WORD[homeCurrency()]}, like 1,500 or 250.50.`; return p }
  let min = money('min'), max = money('max')
  if (errors.min || errors.max) { min = null; max = null }
  if (min !== null && max !== null && max < min) { errors.max = `The most, ${homeMoneyExact(max)}, is less than the least, ${homeMoneyExact(min)}.`; min = null; max = null }
  let first: string | null = t.first.trim() || null, last: string | null = t.last.trim() || null
  if (first !== null && !isDate(first)) errors.first = 'Give the first day as a date.'
  if (last !== null && !isDate(last)) errors.last = 'Give the last day as a date.'
  if (!errors.first && !errors.last && first !== null && last !== null) Object.assign(errors, checkDates(first, last) ?? {})
  if (errors.first || errors.last) { first = null; last = null }
  return { ranges: { min, max, first, last }, errors }
}

/** What Activity is asked to find: the search, the filters and the four range fields as typed. */
export interface Find { q: string; f: Filters; rt: RangeText }
const FILTER_KEYS = ['account', 'who', 'state', 'kind', 'direction'] as const
const RANGE_KEYS = ['min', 'max', 'first', 'last'] as const
/** The search and filters a link asks for (?q=, ?direction=out, ?min=1000, ?first=2026-11-02 …); a value it does not know is left out. */
export function findFrom(q: URLSearchParams): Find {
  const f: Filters = { ...NO_FILTER }
  for (const k of FILTER_KEYS) { const v = q.get(k); if (v !== null && (FILTER_CHOICES[k].options as [string, string][]).some(([o]) => o === v)) (f as unknown as Record<string, string>)[k] = v }
  const rt: RangeText = { ...NO_RANGE_TEXT }
  for (const k of RANGE_KEYS) rt[k] = (q.get(k) ?? '').slice(0, 40)
  return { q: (q.get('q') ?? '').slice(0, 200), f, rt }
}
/** The search and filters as the address writes them: only what differs from showing everything, in a fixed order. */
export function findQuery(x: Find): string {
  const p = new URLSearchParams()
  if (x.q) p.set('q', x.q)
  for (const k of FILTER_KEYS) if (x.f[k] !== 'all') p.set(k, x.f[k])
  for (const k of RANGE_KEYS) if (x.rt[k]) p.set(k, x.rt[k])
  return p.toString()
}

/** One filter in force, in words ("Direction: Money out"), with what clearing it alone resets. */
export interface InForce { key: 'q' | keyof Filters | 'amount' | 'dates'; words: string; clear: { q?: ''; filters?: Partial<Filters>; ranges?: Partial<Ranges> } }
/** Every filter in force, the search first, in the order the controls stand, each in words a person can read back. */
export function inForce(f: Filters, r: Ranges, q: string): InForce[] {
  const out: InForce[] = []
  const typed = q.trim().replace(/\s+/g, ' ')
  if (typed) out.push({ key: 'q', words: `Search: “${typed}”`, clear: { q: '' } })
  for (const k of ['account', 'who', 'state', 'kind', 'direction'] as const) {
    if (f[k] === 'all') continue
    const c = FILTER_CHOICES[k]
    out.push({ key: k, words: `${c.label}: ${(c.options as [string, string][]).find(([v]) => v === f[k])?.[1] ?? f[k]}`, clear: { filters: { [k]: 'all' } } })
  }
  if (r.min !== null || r.max !== null) {
    const words = r.min !== null && r.max !== null ? `${homeMoneyExact(r.min)} to ${homeMoneyExact(r.max)}` : r.min !== null ? `at least ${homeMoneyExact(r.min)}` : `at most ${homeMoneyExact(r.max!)}`
    out.push({ key: 'amount', words: `Amount: ${words}`, clear: { ranges: { min: null, max: null } } })
  }
  if (r.first !== null || r.last !== null) {
    const words = r.first !== null && r.last !== null ? (r.first === r.last ? fmt.isoDay(r.first) : `${fmt.isoDay(r.first)} to ${fmt.isoDay(r.last)}`) : r.first !== null ? `from ${fmt.isoDay(r.first)}` : `up to ${fmt.isoDay(r.last)}`
    out.push({ key: 'dates', words: `Dates: ${words}`, clear: { ranges: { first: null, last: null } } })
  }
  return out
}

const KIND_WORD: Record<Kind, string> = { payment: 'payment', order: 'order conversion', run: 'run nothing sent', authority: 'change of authority', dispute: 'dispute' }
/** A row's state in the words it shows: its own stamp, "needs attention" when the venue's record differs, else the state's. */
export const stateText = (e: DayEvent): string => (e.stamp ? e.stamp.word : needsAttention(e.state, e.recon) ? NEEDS_ATTENTION : stateWord(e.state))
/**
 * Everything a row says, in lower case, for searching: its words, who acted and in which account, its kind and state,
 * the day, and its amounts twice, as written (₹25,000.00) and as bare digits (25000.00), so that "25000", "25,000" and
 * "₹25,000" all find it.
 */
export function searchText(e: DayEvent): string {
  const amounts = [e.amount === null ? '' : amountText(e.amount, e.unit, e.moved), e.received ? amountText(e.received.amount, e.received.unit, true) : ''].filter(Boolean)
  const words = [e.what, ...e.detail, e.under, e.after, e.who === 'you' ? 'you' : e.who === 'chain' ? `${e.by ?? 'the chain'} chain` : 'qed', e.account === 'bank' ? 'bank account' : 'on-chain wallet', KIND_WORD[e.kind], stateText(e), fmt.dayTime(e.ts), ...amounts, ...amounts.map((a) => a.replace(/[^\d.\s]/g, ''))]
  return words.join(' \u0001 ').toLowerCase()
}
/** The words of a search: lower case, and a figure without its sign, rupee sign or separators ("₹25,000" is "25000"). */
export function queryTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean).map((t) => (/^[−+₹$-]?[\d,]*\d(?:\.\d+)?$/.test(t) ? t.replace(/[−+₹$,-]/g, '') : t))
}
/**
 * A row matches a search when it says every word of it, in any order: as typed, or, for a word of letters 4 or more long,
 * as a close spelling of one of the names the row is about (src/lib/fuzzy.ts: one edit for 4 to 7 letters, two for 8 or
 * more, a swap of neighbours counted as one), so "Meera Nari" finds Meera Nair and "bitcon" finds bitcoin.
 */
export const matchesQuery = (q: string) => {
  const terms = queryTerms(q)
  return (e: DayEvent): boolean => {
    if (!terms.length) return true
    const t = searchText(e)
    let words: string[] | null = null
    return terms.every((x) => t.includes(x) || closeTo(x, (words ??= nameWords(e.names))) !== null)
  }
}
/**
 * The close spellings a search relied on among the rows it found: each typed word that no row says as typed, with the name
 * word it was taken for ([["nari", "nair"]]), so the page can say why a row was found.
 */
export function closeSpellings(q: string, rows: DayEvent[]): [string, string][] {
  const out: [string, string][] = []
  for (const x of queryTerms(q)) {
    if (rows.some((e) => searchText(e).includes(x))) continue
    for (const e of rows) { const w = closeTo(x, nameWords(e.names)); if (w && !out.some(([a, b]) => a === x && b === w)) out.push([x, w]) }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ what the rows came to

/** What the bank account's rows shown came to; every count is the sum of its parts, every sum the sum of its rows. */
export interface BankSum { rows: number; actions: number; byYou: number; byQed: number; done: number; waiting: number; trouble: number; other: number; outByYou: number; outByQed: number; inByYou: number; inByQed: number; finished: number; receipts: number; runs: number; disputes: number }
/** What the wallet's rows shown came to, in its own units. */
export interface WalletSum { rows: number; byYou: number; byQed: number; done: number; waiting: number; trouble: number; other: number; idle: number; paid: number; setAside: number; converted: number; received: number; bountyIn: number; arrived: number; unit: Unit | null; reserveUnit: Unit | null }
const FINISHED = new Set(['done', 'partial', 'blocked', 'failed', 'rejected', 'cancelled', 'expired'])
export function summarise(events: DayEvent[]): { bank: BankSum; wallet: WalletSum } {
  const bank = events.filter((e) => e.account === 'bank'), acts = bank.filter((e) => e.kind === 'payment' || e.kind === 'order')
  const sumOf = (xs: DayEvent[], sign: 1 | -1) => xs.reduce((t, e) => t + (e.moved && e.amount !== null && Math.sign(e.amount) === sign ? Math.abs(e.amount) : 0), 0)
  const finished = acts.filter((e) => FINISHED.has(e.state))
  const w = events.filter((e) => e.account === 'wallet')
  const wSum = (pred: (e: DayEvent) => boolean) => w.filter(pred).reduce((t, e) => t + Math.abs(e.amount ?? 0), 0)
  return {
    bank: {
      rows: bank.length, actions: acts.length, byYou: acts.filter((e) => e.who === 'you').length, byQed: acts.filter((e) => e.who === 'qed').length,
      done: acts.filter((e) => e.bucket === 'done').length, waiting: acts.filter((e) => e.bucket === 'waiting').length, trouble: acts.filter((e) => e.bucket === 'trouble').length, other: acts.filter((e) => e.bucket === 'other').length,
      outByYou: sumOf(acts.filter((e) => e.who === 'you'), -1), outByQed: sumOf(acts.filter((e) => e.who === 'qed'), -1),
      inByYou: sumOf(acts.filter((e) => e.who === 'you'), 1), inByQed: sumOf(acts.filter((e) => e.who === 'qed'), 1),
      finished: finished.length, receipts: finished.filter((e) => e.receipt).length,
      runs: bank.filter((e) => e.kind === 'run').length, disputes: bank.filter((e) => e.kind === 'dispute').length,
    },
    wallet: {
      rows: w.length, byYou: w.filter((e) => e.who === 'you').length, byQed: w.filter((e) => e.who === 'qed').length, done: w.filter((e) => e.bucket === 'done').length, waiting: w.filter((e) => e.bucket === 'waiting').length, trouble: w.filter((e) => e.bucket === 'trouble').length, other: w.filter((e) => e.bucket === 'other').length,
      idle: w.filter((e) => e.state === 'no-action').length,
      paid: wSum((e) => e.moved && e.kind === 'payment'), setAside: wSum((e) => !e.moved && e.bucket === 'done' && e.after.startsWith('Set aside')),
      converted: wSum((e) => e.moved && e.received !== null && e.kind === 'order'), received: w.reduce((t, e) => t + (e.moved && e.received && e.kind === 'order' ? e.received.amount : 0), 0),
      bountyIn: w.reduce((t, e) => t + (e.moved && e.received && e.kind === 'payment' ? e.received.amount : 0), 0),
      arrived: wSum((e) => e.moved && (e.amount ?? 0) > 0),
      unit: w.find((e) => e.unit.kind === 'token')?.unit ?? null, reserveUnit: w.find((e) => e.received)?.received?.unit ?? null,
    },
  }
}
/** A count as the sum of its non-zero parts: "2 done + 1 waiting + 1 refused or failed". */
export function partsLine(parts: [number, string][]): string {
  const shown = parts.filter(([k]) => k > 0)
  return shown.length ? shown.map(([k, w]) => `${k} ${w}`).join(' + ') : 'none'
}

// ------------------------------------------------------------------------------------------------ export

/** A whole number of a unit's smallest steps as a plain decimal ("19465" at 2 places is "194.65"), digit by digit. */
const decimal = (raw: number, places: number): string => {
  const s = String(Math.abs(Math.trunc(raw))).padStart(places + 1, '0')
  return places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s
}
/**
 * A row's details as sentences: each fragment with a capital and one full stop (none added after a question or an
 * exclamation), joined by a space. The screen and the CSV file both write details through this.
 */
export function detailText(detail: string[]): string {
  return detail.map((d) => d.trim()).filter(Boolean).map((d) => d.replace(/^./, (c) => c.toUpperCase())).map((d) => (/[.!?…]$/.test(d) ? d : `${d}.`)).join(' ')
}
/** What a day book file says before its table: the days it covers, the rows chosen, and when it was read. */
export interface DayBookAbout { period: string; rows: string; readAt: string }
/**
 * The order of the day book's rows, said on the screen and in the file (R13: the ordering is labelled): by when each was
 * asked for (an order or payment), fell due (a run with nothing sent) or was raised (a dispute). Its money and the
 * balance after it are the bank statement's, entered when the money moved, which may be later (a redemption's payout).
 */
export const DAY_BOOK_ORDER = 'Oldest first, by when each was asked for, fell due or was raised. The money and the balance after it are your bank statement\'s, from when the money moved, which can be later.'
/**
 * The rows as a CSV file, oldest first (its order said in the file's head, DAY_BOOK_ORDER): when each was asked for, fell
 * due or was raised, in India time, the account, who acted, what happened, its details and
 * authority, then the money in its own unit with out, in and "asked for, nothing moved" kept apart (as the statement
 * keeps them), what came back for it, the consequence, the state in the words the page shows, and the addresses of its
 * record and receipt. A cell a spreadsheet would run as a formula (one starting with =, +, -, @, a tab or a return) is
 * written as text; amounts are written here from whole numbers of paise or token steps, never through a float.
 */
export function dayBookCsv(events: DayEvent[], about?: DayBookAbout): string {
  const cell = (v: string) => { const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const iso = zoneIso
  const places = (u: Unit) => (u.kind === 'inr' ? 2 : u.decimals)
  const unitName = (u: Unit) => (u.kind === 'inr' ? 'INR' : `${u.symbol} (${u.words} of no value)`)
  const head = [`Asked for, due or raised (${zoneHead()})`, 'Account', 'Who acted', 'What', 'Details', 'Under', 'Out', 'In', 'Asked, nothing moved', 'Unit', 'Came back', 'Came back unit', 'After', 'State', 'Record', 'Receipt']
  // the file says first which days it covers, which rows were chosen and when it was read; a blank line, then the table
  const rows = about ? [['Day book', `${about.period} (${zoneName()})`], ['Rows', about.rows], ['Read at', about.readAt], ['Order', DAY_BOOK_ORDER], []].map((r) => r.map(cell).join(',')) : []
  rows.push(head.map(cell).join(','))
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const a = e.amount, u = e.unit
    const out = a !== null && e.moved && a < 0 ? decimal(a, places(u)) : ''
    const inn = a !== null && e.moved && a > 0 ? decimal(a, places(u)) : ''
    const asked = a !== null && !e.moved ? decimal(a, places(u)) : ''
    const text = [iso(e.ts), e.account === 'bank' ? 'Bank account' : 'On-chain wallet', whoName(e), e.what, detailText(e.detail), e.under]
    const tail = [a === null ? '' : unitName(u), e.received ? decimal(e.received.amount, places(e.received.unit)) : '', e.received ? unitName(e.received.unit) : '', e.after, stateText(e), e.to, e.receiptId ? `/receipts/${e.receiptId}` : '']
    // the three amount columns are numbers this code wrote; every other cell is text from a record and is escaped
    rows.push([...text.map(cell), out, inn, asked, ...tail.map(cell)].join(','))
  }
  return `${rows.join('\r\n')}\r\n`
}
/** Hand a file to the browser to save. */
function save(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ------------------------------------------------------------------------------------------------ the screen

const MINUS = '−'
/** An amount in its own unit: rupees with a sign when it moved; a test token with its unit in words. */
export function amountText(amount: number, unit: Unit, moved: boolean): string {
  const sign = moved ? (amount < 0 ? MINUS : '+') : ''
  if (unit.kind === 'inr') return `${sign}${fmt.money(Math.abs(amount), true)}`
  return `${sign}${tokenFigure(Math.abs(amount), unit.decimals, unit.symbol)} ${unit.words}`
}
/** The same, drawn: the figure never breaks; a token's unit words may go under it on a narrow screen. */
function Amount({ amount, unit, moved }: { amount: number; unit: Unit; moved: boolean }) {
  const t = amountText(amount, unit, moved)
  if (unit.kind === 'inr') return <span className="ac-fig">{t}</span>
  const k = t.indexOf(' ')
  return <><span className="ac-fig">{t.slice(0, k)}</span> <span className="ac-unit">{t.slice(k + 1)}</span></>
}
const total = (all: DayEvent[]): number | null => (all.every((e) => e.amount !== null) ? all.reduce((t, e) => t + (e.amount ?? 0), 0) : null)

/** Which of the shared columns the width allows; what a hidden column says moves into the What cell, said once. */
interface Cols { when: boolean; who: boolean; under: boolean; state: boolean }
/** Whether a media query holds, kept current as the window changes. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => { const m = matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }, [query])
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false)
}

/** Where a row can be followed: its receipt and its evidence case, when it has them. */
function Trace({ e, cases }: { e: DayEvent; cases: Set<string> }) {
  const receipt = e.receiptId ? <Link className="ac-trace-link" to={`/receipts/${e.receiptId}`}><Seal />Receipt kept</Link> : e.receipt ? <span className="ac-trace-link"><Seal />Receipt kept</span> : null
  const evidence = e.caseId && cases.has(e.caseId) ? <Link className="ac-trace-link" to={`/evidence/${encodeURIComponent(e.caseId)}`}><FileSearch aria-hidden="true" />Evidence case</Link> : null
  return receipt || evidence ? <span className="ac-trace">{receipt}{evidence}</span> : null
}

/** The cells of one row of the day book; more than one in `all` makes it the line for a fold. */
function RowCells({ e, all, open, onToggle, toggleId, cols, cases }: { e: DayEvent; all: DayEvent[]; open: boolean; onToggle: () => void; toggleId: string; cols: Cols; cases: Set<string> }) {
  const many = all.length > 1
  const sum = many ? total(all) : e.amount
  const by = whoName(e)
  const detail = detailText(e.detail)
  const first = all[all.length - 1]!
  const state = e.stamp ? <Stamp tone={e.stamp.tone}>{e.stamp.word}</Stamp> : <StateStamp state={e.state} recon={e.recon} />
  const trace = many ? null : <Trace e={e} cases={cases} />
  const time = <time dateTime={new Date(e.ts).toISOString()}>{many && fmt.time(first.ts) !== fmt.time(e.ts) ? `${fmt.time(first.ts)}–${fmt.time(e.ts)}` : fmt.time(e.ts)}</time>
  return <>
    {cols.when ? <td className="ac-when">{time}</td> : null}
    <td className="ac-what">
      {!cols.when ? <span className="ac-when-in">{time}</span> : null}
      <span className="ac-what-line">
        <Link to={e.to}>{e.what}<span className="sr">{many ? `, the latest of ${all.length}, at ${fmt.time(e.ts)}` : `, at ${fmt.time(e.ts)}`}</span></Link>
        {e.account === 'wallet' ? <span className="chip ac-acct">On-chain wallet</span> : null}
        {many ? <span className="ac-times">{all.length} times</span> : null}
      </span>
      {detail ? <span className="ac-detail">{detail}</span> : null}
      {!cols.who ? <span className="ac-by"><b className={whoClass(e.who)}>{by}</b>, under {e.account === 'wallet' ? lower(e.under) : e.under === 'Your approval' ? 'your approval' : e.under === 'Your request' ? 'your own request' : `“${e.under}”`}</span> : null}
      {!cols.state ? <span className="ac-state-in">{state}{trace}</span> : null}
      {many ? <button type="button" className="linkish ac-each" aria-expanded={open} aria-controls={open ? toggleId : undefined} onClick={onToggle}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{open ? 'Hide each' : `Show each of the ${all.length}`}</button> : null}
    </td>
    {cols.who ? <td className="ac-who"><span className={whoClass(e.who)}>{by}</span></td> : null}
    {cols.under ? <td className="ac-under">{e.under}</td> : null}
    <td className={`ac-amt ${sum === null ? 'none' : !e.moved ? 'unmoved' : sum > 0 ? 'in' : ''}`}>
      {sum === null ? (e.after ? <span className="ac-noamt">{e.after}</span> : null) : <>
        <Amount amount={sum} unit={e.unit} moved={e.moved} />
        {e.received && !many ? <small className="ac-recv"><Amount amount={e.received.amount} unit={e.received.unit} moved /></small> : null}
        <small>{many ? `${all.length} times, ${e.moved ? 'in all' : e.after.startsWith('Set aside') ? 'set aside in all' : 'asked in all'}` : e.after}</small>
      </>}
    </td>
    {cols.state ? <td className="ac-state">{state}{trace}</td> : null}
  </>
}

/** One line of the day book, or a fold of repeats with each one a press away. */
function Line({ lead, all, cols, cases }: { lead: DayEvent; all: DayEvent[]; cols: Cols; cases: Set<string> }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const go = (to: string) => (ev: MouseEvent<HTMLTableRowElement>) => { if ((ev.target as HTMLElement).closest('a, button')) return; if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; navigate(to) }
  return <>
    <tr className={`clickable ac-row ${lead.trouble ? 'trouble' : ''} ${all.length > 1 ? 'is-fold' : ''}`} onClick={go(lead.to)}>
      <RowCells e={lead} all={all} open={open} onToggle={() => setOpen((x) => !x)} toggleId={id} cols={cols} cases={cases} />
    </tr>
    {all.length > 1 && open ? all.map((e, i) => (
      <tr key={e.key} id={i === 0 ? id : undefined} className="clickable ac-row member" onClick={go(e.to)}>
        <RowCells e={e} all={[e]} open={false} onToggle={() => undefined} toggleId="" cols={cols} cases={cases} />
      </tr>
    )) : null}
  </>
}

function LogSkeleton() {
  return (
    <div className="panel ac-book" aria-busy="true">
      <p className="loading-line">Reading what was done…</p>
      {[0, 1, 2].map((i) => <div key={i} className="ac-skel"><span className="skel" /><span className="skel" /><span className="skel" /></div>)}
    </div>
  )
}

/** How many of the wallet's jobs are read: the most its list gives at once. */
const WALLET_READ = 200
/** The activity list's fixed limits for runs and disputes (server/api.ts). */
const RUNS_READ = 80, DISPUTES_READ = 40

interface VaultBrief { available?: boolean; setUp: boolean; workspace?: { asset: { symbol: string; decimals: number }; reserveAsset: { symbol: string; decimals: number } } | null; state?: { provisioned: boolean } | null }
type Chain = { ok: boolean; count: number; brokenAt: number | null; head?: string }

/**
 * The records QED keeps, one folder for each kind, with the figure and the check each carries and its latest records:
 * receipts (the chain the server verified), evidence cases (how each ended), the instructions signed (how many are in
 * force) and, with a wallet, the wallet's own requests and its chained decision records.
 */
function recordFolders(p: { receipts: { list: Receipt[]; chain: Chain } | null; receiptsError: boolean; cases: CaseSummary[] | null; casesError: boolean; programs: ProgramSummary[] | null; programsError: boolean; hasWallet: boolean | null; wallet: DayEvent[] | null; walletError: boolean; decisions: { ok: boolean; records: number; brokenAt: number | null } | null }): Folder[] {
  const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  const when = (iso: string | null) => (iso ? fmt.dayTime(Date.parse(iso)) : '')
  const folders: Folder[] = []

  const rc = p.receipts
  folders.push({
    kind: 'receipts', name: 'Receipts', icon: ReceiptText,
    count: rc ? (rc.chain.count ? `${rc.chain.count} kept` : 'None yet') : p.receiptsError ? 'Could not be read' : 'Reading…',
    note: rc && rc.chain.count ? (rc.chain.ok ? 'Chain intact' : `Chain broken at no. ${rc.chain.brokenAt}`) : undefined,
    noteTone: rc && !rc.chain.ok ? 'void' : 'ok', sealed: !!rc?.chain.ok && rc.chain.count > 0,
    describe: 'A receipt is issued when an order or payment finishes, whatever the outcome, and each is chained to the one before it.',
    files: (rc?.list ?? []).map((r) => { const [word, tone] = receiptOutcome(r.body); return { id: r.id, name: `No. ${r.seq}: ${String(r.body.what ?? r.kind)}`, meta: `${fmt.dayTime(r.ts)}, ${word.toLowerCase()}`, tone, to: `/receipts/${r.id}` } }),
    all: { to: '/safeguards#records', label: 'Check the whole receipt chain' },
    art: { palette: ['--well', '--ground', '--sheet-2', '--act', '--ground', '--c3', '--well'], warp: 3.4, scale: 0.95, angle: -0.6, gloss: 0.4 },
    state: rc ? undefined : p.receiptsError ? 'error' : 'loading',
  })

  const cs = p.cases
  const refused = (cs ?? []).filter((c) => caseOutcome(c.outcome)[1] === 'void').length
  // a wallet case is named by what the wallet did, as its row in the day book is; cases alike in a row are one file
  const did = new Map((p.wallet ?? []).map((e) => [e.caseId ?? '', e.what]))
  folders.push({
    kind: 'evidence', name: 'Evidence', icon: FileSearch,
    count: cs ? (cs.length ? plural(cs.length, 'case') : 'None yet') : p.casesError ? 'Could not be read' : 'Reading…',
    note: cs && cs.length ? (refused ? `${refused} refused` : 'None refused') : undefined, noteTone: refused ? 'void' : undefined,
    describe: 'Each case is one thing QED did or refused, assembled from its own records: who decided, what checked it, what executed and what reconciled.',
    files: groupCases(cs ?? []).map(({ lead: c, all }) => { const [word, tone] = caseOutcome(c.outcome); return { id: c.id, name: did.get(c.id) ?? readable(c.title), meta: `${CASE_KIND[c.kind] ?? c.kind}, ${when(c.at)}, ${word.toLowerCase()}${all.length > 1 ? `, ${all.length} alike` : ''}`, tone, to: `/evidence/${encodeURIComponent(c.id)}` } }),
    all: { to: '/evidence', label: 'All evidence' },
    art: { palette: ['--well', '--ground', '--brand', '--sheet-2', '--ground', '--ink-3', '--well'], warp: 2.2, scale: 0.75, angle: 0.35, gloss: 0.25, streak: true },
    state: cs ? undefined : p.casesError ? 'error' : 'loading',
  })

  const signed = (p.programs ?? []).filter((x) => x.approvedAt !== null).sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
  const inForce = signed.filter((x) => x.state === 'active').length
  folders.push({
    kind: 'instructions', name: 'Instructions', icon: ScrollText,
    count: p.programs ? (signed.length ? `${signed.length} signed` : 'None signed') : p.programsError ? 'Could not be read' : 'Reading…',
    note: signed.length ? `${inForce} in force` : undefined, noteTone: inForce ? 'ok' : undefined,
    describe: 'The standing instructions you signed: what QED may do on its own, each within the limits written on it, until it ends or you stop it.',
    files: signed.map((x) => ({ id: x.id, name: x.title, meta: `${stateWord(x.state)}${x.liveVersion ? `, version ${x.liveVersion}` : ''}${x.approvedAt ? `, signed ${fmt.day(x.approvedAt)}` : ''}`, tone: x.state === 'active' ? 'ok' as const : x.state === 'revoked' ? 'void' as const : 'plain' as const, to: `/instructions/${x.id}` })),
    all: { to: '/instructions', label: 'All instructions' },
    art: { palette: ['--well', '--ground', '--act-2', '--sheet-2', '--ground', '--act', '--well'], warp: 3.8, scale: 1.05, angle: 1.9, gloss: 0.4 },
    state: p.programs ? undefined : p.programsError ? 'error' : 'loading',
  })

  // the wallet's folder is always on the shelf (so the shelf does not reflow when the wallet answers): its records, or
  // that it is still being read, or that there is no wallet yet and where to set one up
  {
    const dv = p.decisions, none = p.hasWallet === false
    folders.push({
      kind: 'wallet', name: 'On-chain wallet', icon: Wallet,
      count: none ? 'Not set up' : p.wallet ? (p.wallet.length ? plural(p.wallet.length, 'request') : 'None yet') : p.walletError ? 'Could not be read' : 'Reading…',
      note: dv ? (dv.ok ? `${plural(dv.records, 'decision record')} intact` : `Records broken at no. ${dv.brokenAt}`) : undefined,
      noteTone: dv && !dv.ok ? 'void' : 'ok', sealed: !!dv?.ok,
      describe: 'What the on-chain wallet was asked to do, in test tokens of no value, each with the decision record its co-signer chained to the one before.',
      files: foldRepeats(p.wallet ?? []).map(({ lead: e, all }) => ({ id: e.key, name: e.what, meta: `${fmt.dayTime(e.ts)}, ${(e.stamp?.word ?? stateWord(e.state)).toLowerCase()}${all.length > 1 ? `, ${all.length} times` : ''}`, tone: e.stamp?.tone, to: e.to })),
      all: none ? { to: '/vault', label: 'Set up the on-chain wallet' } : { to: '/vault/records', label: 'The on-chain wallet\'s own records' },
      art: { palette: ['--well', '--ground', '--due', '--sheet-2', '--c3', '--ground', '--well'], warp: 3, scale: 0.85, angle: -1.2, gloss: 0.45 },
      state: none || p.wallet ? undefined : p.walletError ? 'error' : 'loading',
    })
  }
  return folders
}

export function ActivityScreen() {
  const now = useNow(30_000)
  const [limit, setLimit] = useState(100)
  // the search, the filters and the range fields as typed, kept in the address; what the fields make is applied, and a
  // field that is wrong says so and is not (rangesFrom)
  const [find, setFind] = useUrlState<Find>('/activity', findFrom, findQuery)
  const { f, q, rt } = find
  const setF = (u: (x: Filters) => Filters) => setFind((v) => ({ ...v, f: u(v.f) }))
  const setQ = (t: string) => setFind((v) => ({ ...v, q: t }))
  const setRt = (u: (x: RangeText) => RangeText) => setFind((v) => ({ ...v, rt: u(v.rt) }))
  const { ranges, errors: rangeErrors } = rangesFrom(rt)
  const ranged = ranges.first !== null || ranges.last !== null
  const searchRef = useRef<HTMLInputElement>(null)
  const searchId = useId(), statesId = useId(), filtersId = useId(), rangesId = useId()
  const [statesOpen, setStatesOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const mid = useMedia('(max-width: 1099px)'), narrow = useMedia('(max-width: 759px)')
  const cols: Cols = { when: !narrow, who: !mid, under: !mid, state: !narrow }
  const span = 2 + Number(cols.when) + Number(cols.who) + Number(cols.under) + Number(cols.state)
  // with dates chosen, the server reads what was done in those days (server/statement.ts spanFromQuery), not only the latest
  const days_ = `${ranges.first ? `&first=${ranges.first}` : ''}${ranges.last ? `&last=${ranges.last}` : ''}`
  const data = useData<{ actions: ActivityAction[]; runs: RunView[]; disputes?: Dispute[] }>(`/api/activity?limit=${limit}${days_}`, ['action', 'run', 'dispute', 'recon'])
  // the bank statement's own lines give each action's money and the balance it left: with dates, the lines entered in those
  // days and the day after (a payment made before midnight may settle after it); else the latest
  const book = useData<Pick<PassbookView, 'lines'>>(ranged ? `/api/passbook?period=dates&first=${ranges.first ?? '1970-01-01'}&last=${nextDay(ranges.last ?? istDate(now))}&limit=2000` : `/api/passbook?limit=${Math.max(200, limit * 3)}`, ['action', 'run', 'bill', 'program', 'profile'])
  const receipts = useData<{ receipts: Receipt[]; chain: Chain }>('/api/receipts?limit=8', ['action', 'receipt'])
  const cases = useData<{ cases: CaseSummary[] }>('/api/evidence/cases', ['action', 'run', 'vault'])
  const programs = useData<{ programs: ProgramSummary[] }>('/api/programs', ['program'])
  // the on-chain wallet's own list of what it was asked to do, read only when there is a wallet (its records page reads the same)
  const vault = useData<VaultBrief>('/api/vault', ['vault'])
  const hasWallet = !!vault.data?.setUp
  const wallet = useData<{ jobs: WalletJob[] }>(hasWallet ? `/api/vault/jobs?limit=${WALLET_READ}` : null, ['vault'])
  const decisions = useData<{ ok: boolean; records: number; brokenAt: number | null }>(hasWallet ? '/api/vault/decisions-verify' : null, ['vault'])
  const ws = vault.data?.workspace
  const units: WalletUnits | null = ws ? { asset: ws.asset, reserve: ws.reserveAsset ?? null } : null
  const jobs = wallet.data && !wallet.error ? wallet.data.jobs : []
  // the books of the wallet: each entry with when it took effect and when QED entered it (server/chain-books.ts)
  const books = useData<ChainBooksView>(hasWallet ? '/api/chain-books' : null, ['vault', 'recon'])
  const walletRows = withBooks(walletEvents(jobs, units), books.data ?? null)
  const caseIds = new Set((cases.data?.cases ?? []).map((c) => c.id))

  // every receipt, oldest first, with the chain as the server verified it: a file anyone can check offline
  const receiptFile = useAction(async () => {
    const all: Receipt[] = []
    let before: number | undefined, chain: Chain | null = null
    for (;;) {
      const r = await api<{ receipts: Receipt[]; chain: Chain }>('GET', `/api/receipts?limit=500${before ? `&before=${before}` : ''}`)
      all.push(...r.receipts); chain = r.chain
      if (r.receipts.length < 500) break
      before = r.receipts[r.receipts.length - 1]!.seq
    }
    const file = { format: 'qed-receipts-v1', exportedAt: new Date().toISOString(), howToCheck: 'Each receipt\'s hash is the SHA-256 of the hash before it, a newline, and the canonical JSON of its body (keys sorted, no spaces; shared/sha256.ts). The first receipt follows the chain\'s own starting value. The execution these receipts record was on paper: no real money moved.', chain, receipts: all.reverse() }
    save(`qed-receipts-${istDay(Date.now())}.json`, `${JSON.stringify(file, null, 2)}\n`, 'application/json')
  })

  const folders = recordFolders({
    receipts: receipts.data ? { list: receipts.data.receipts, chain: receipts.data.chain } : null, receiptsError: !!receipts.error && !receipts.data,
    cases: cases.data?.cases ?? null, casesError: !!cases.error && !cases.data, programs: programs.data?.programs ?? null, programsError: !!programs.error && !programs.data,
    hasWallet: vault.data ? hasWallet : vault.error ? false : null, wallet: hasWallet ? (wallet.data ? walletRows : null) : null, walletError: (hasWallet && !!wallet.error && !wallet.data) || (!vault.data && !!vault.error), decisions: decisions.data ?? null,
  })
  const shelf = <FolderShelf title="Your records, filed" intro="Each kind of record QED keeps, with the check it carries. Open a folder for the latest; its corner leads to all of them." folders={folders} />
  const records = <Link to="/vault/records">The on-chain wallet's own records</Link>
  const sentence = 'Everything done in your name, by you and by QED under what you signed, in your bank account and on your on-chain wallet. Each row opens its record, with every check and its receipt.'

  const receiptsButton = <Btn busy={receiptFile.busy} disabled={!receipts.data?.chain.count} onClick={() => void receiptFile.run()}><Download aria-hidden="true" />Every receipt (JSON)</Btn>
  if (!data.data) {
    return (
      <div className="ac">
        <ActivityHead at="actions" actions={<><Btn disabled><Download aria-hidden="true" />Download the day book (CSV)</Btn>{receiptsButton}</>} aside={hasWallet ? <span className="ac-head-link">{records}</span> : null}>{sentence}</ActivityHead>
        {data.error ? <div className="ac-problem"><Problem error={data.error} /><Btn small onClick={data.reload}>Try again</Btn></div> : <LogSkeleton />}
        {shelf}
      </div>
    )
  }

  const { actions, runs, disputes = [] } = data.data
  const bankRows = toEvents(data.data, book.data?.lines ?? [])
  const oldest = (xs: number[]) => (xs.length ? Math.min(...xs) : null)
  // with dates chosen the runs come in the order they were due (server/api.ts), so their reach is their oldest due time
  const bankLists = [{ count: actions.length, asked: limit, oldest: oldest(actions.map((a) => a.createdAt)) }, { count: runs.length, asked: RUNS_READ, oldest: oldest(runs.map((r) => (ranged ? r.dueAt : r.createdAt))) }, { count: disputes.length, asked: DISPUTES_READ, oldest: oldest(disputes.map((x) => x.created_at)) }]
  const walletLists = wallet.data ? [{ count: jobs.length, asked: WALLET_READ, oldest: oldest(jobs.map((j) => Date.parse(j.createdAt))) }] : []
  const lists = f.account === 'bank' ? bankLists : f.account === 'wallet' ? walletLists : [...bankLists, ...walletLists]
  const from = periodStart(lists)
  const inPeriod = [...bankRows, ...walletRows].filter((e) => from === null || e.ts >= from).sort((a, b) => b.ts - a.ts)
  const forced = inForce(f, ranges, q)
  const filtersOn = forced.filter((x) => x.key !== 'q').length
  const filtered = filtersOn > 0
  const searching = queryTerms(q).length > 0
  const shown = inPeriod.filter(matches(f)).filter(inRanges(ranges)).filter(matchesQuery(q))
  const close = searching ? closeSpellings(q, shown) : []
  const days = byDay(shown, now)
  const s = summarise(shown)
  const bankCut = periodStart(bankLists) !== null && from === periodStart(bankLists)
  const walletCut = walletLists.length > 0 && periodStart(walletLists) !== null && from === periodStart(walletLists)
  const start = shown.length ? Math.min(...shown.map((e) => e.ts)) : null
  // the days the page covers: the dates chosen, else from where every list was read in full (or the oldest row) to today;
  // when the lists do not reach back to the first day chosen, the period starts where they do, and says so
  const reach = from ?? (inPeriod.length ? Math.min(...inPeriod.map((e) => e.ts)) : null)
  const cut = from !== null && (ranges.first === null || from > dayStartIst(ranges.first))
  const today = istDate(now)
  const first = cut || ranges.first === null ? (reach !== null ? istDate(reach) : ranges.first ?? today) : ranges.first
  const period = periodOf('dates', now, { first, last: ranges.last !== null && ranges.last >= first ? ranges.last : today < first ? first : today })
  const periodText = `${periodWords(period, now)}${cut && from !== null ? `; rows before ${fmt.dayTime(from)} were not read` : ''}`
  const refocus = () => searchRef.current?.focus()
  const everything = () => { setFind({ q: '', f: NO_FILTER, rt: NO_RANGE_TEXT }); refocus() }
  const clearOne = (x: InForce) => {
    if (x.clear.q !== undefined) setQ('')
    if (x.clear.filters) setF((v) => ({ ...v, ...x.clear.filters }))
    if (x.key === 'amount') setRt((v) => ({ ...v, min: '', max: '' }))
    if (x.key === 'dates') setRt((v) => ({ ...v, first: '', last: '' }))
    refocus()
  }
  const csv = () => save(periodFileName('qed-day-book', period, now).replace(/\.csv$/, filtered || searching ? '-selection.csv' : '.csv'), dayBookCsv(shown, { period: periodText, rows: forced.length ? forced.map((x) => x.words).join('; ') : 'Every row in the period', readAt: fmt.full(now) }), 'text/csv;charset=utf-8')

  const actions_ = <><Btn onClick={csv} disabled={!shown.length}><Download aria-hidden="true" />Download {filtered || searching ? 'the rows found' : 'the day book'} (CSV)</Btn>{receiptsButton}</>

  return (
    <div className="ac">
      <ActivityHead at="actions" actions={actions_} aside={hasWallet ? <span className="ac-head-link">{records}</span> : null}>{sentence}</ActivityHead>
      <Problem error={receiptFile.error} />
      {/* what happened comes first; with nothing yet, the shelf of records stands in for it */}
      {inPeriod.length === 0 && !ranged ? shelf : null}
      {inPeriod.length === 0 && !ranged ? (
        <div className="empty-state ac-empty">
          <span className="glyph"><ReceiptText aria-hidden="true" /></span>
          <h2>Nothing has happened yet</h2>
          <p>What you do, and what QED does under what you sign, appears here as it happens: each payment, order and change of authority with its checks, its receipt and what it left in your account.</p>
          <div className="row"><Link className="btn fill" to="/pay">Pay someone</Link><Link className="btn" to="/instructions/new">Write an instruction</Link></div>
        </div>
      ) : <>
        <form className="ac-find" role="search" aria-label="Find in the day book" onSubmit={(e) => e.preventDefault()}>
          <div className="ac-search">
            <label htmlFor={searchId}>Search</label>
            <div className="ac-search-box">
              <Search aria-hidden="true" />
              <input ref={searchRef} id={searchId} type="search" className="input" value={q} placeholder="Payee, amount, instruction, check" autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
              {q ? <button type="button" className="icon-btn ac-search-clear" aria-label="Clear the search" onClick={() => { setQ(''); searchRef.current?.focus() }}><X aria-hidden="true" /></button> : null}
            </div>
          </div>
          {/* on a phone the filters fold under one button that says how many are on; the search stays open */}
          {narrow ? <button type="button" className="btn sm ac-filters-toggle" aria-expanded={filtersOpen} aria-controls={`${filtersId} ${rangesId}`} onClick={() => setFiltersOpen((x) => !x)}>
            <SlidersHorizontal aria-hidden="true" />{filtersOn ? `Filters: ${filtersOn} on` : 'Filters'}<ChevronDown aria-hidden="true" />
          </button> : null}
          <div id={filtersId} className="ac-filters" role="group" aria-label="Filter the day book" hidden={narrow && !filtersOpen}>
            {(['account', 'who', 'state', 'kind', 'direction'] as (keyof Filters)[]).filter((k) => k !== 'account' || hasWallet).map((k) => (
              <FilterSelect key={k} name={k} value={f[k]} onChange={(v) => setF((x) => ({ ...x, [k]: v } as Filters))} />
            ))}
          </div>
          {/* the amount and the dates, each a pair of fields, on a row of their own across the bar */}
          <div id={rangesId} className="ac-ranges" role="group" aria-label="Narrow by amount and dates" hidden={narrow && !filtersOpen}>
            <RangePair legend={`Amount, in ${UNITS_WORD[homeCurrency()]}`} hint="Test rupees on the on-chain wallet" kind="amount" text={rt} errors={rangeErrors} onChange={(k, v) => setRt((x) => ({ ...x, [k]: v }))} />
            <RangePair legend="Dates, India time" kind="dates" text={rt} errors={rangeErrors} onChange={(k, v) => setRt((x) => ({ ...x, [k]: v }))} />
          </div>
          {/* how many rows that leaves, and what the state words mean, on one line under the filters */}
          <div className="ac-find-foot">
            {/* the number found, announced as it changes (WCAG 4.1.3); the button that clears sits beside it, outside what is announced */}
            <p className="ac-count" role="status">{filtered || searching ? `Showing ${shown.length} of ${inPeriod.length} ${inPeriod.length === 1 ? 'entry' : 'entries'}.` : `${inPeriod.length} entr${inPeriod.length === 1 ? 'y' : 'ies'}`}{close.length ? ` Close spellings included: ${close.map(([t, w]) => `“${t}” read as “${w}”`).join(', ')}.` : ''}</p>
            {filtered || searching ? <button type="button" className="linkish ac-count-clear" onClick={everything}>Show everything</button> : null}
            <button type="button" className="ac-states-toggle" aria-expanded={statesOpen} aria-controls={statesId} onClick={() => setStatesOpen((x) => !x)}>What the states mean<ChevronDown aria-hidden="true" /></button>
          </div>
          {/* every status word in one sentence, in the order an action moves (kit.tsx STATUS_GLOSSARY) */}
          <dl id={statesId} className="ac-glossary" hidden={!statesOpen}>{STATUS_GLOSSARY.map(([w, m]) => <div key={w}><dt>{w}</dt><dd>{m}</dd></div>)}</dl>
        </form>

        <Totals s={s} from={start} period={ranged ? periodWords(period, now) : null} filtered={filtered || searching} receiptsChain={receipts.data?.chain ?? null} decisionChain={decisions.data ?? null} showBank={f.account !== 'wallet' && s.bank.rows > 0} showWallet={f.account !== 'bank' && s.wallet.rows > 0} narrow={narrow} />

        {days.length === 0 ? (
          <div className="panel ac-none">
            {/* what was asked for, named, each part removable on its own, and a way to clear them all */}
            <p>{forced.length ? `Nothing in the period shown matches ${forced.length === 1 ? 'this' : 'all of these'}:` : 'Nothing has happened in the period shown.'}</p>
            {forced.length ? <ul className="ac-in-force">{forced.map((x) => <li key={x.key}><span>{x.words}</span><button type="button" className="linkish ac-in-force-off" aria-label={`Remove ${x.words}`} onClick={() => clearOne(x)}>Remove</button></li>)}</ul> : null}
            <Btn small onClick={everything}>{forced.length > 1 ? 'Clear the search and every filter' : 'Show everything'}</Btn>
          </div>
        ) : (
          <section className="panel ac-book" aria-labelledby="ac-book-h">
            <div className="panel-head ac-book-head"><h2 id="ac-book-h">Day book</h2><p>Newest first by when each was asked for, fell due or was raised, a day at a time; each row opens its record</p></div>
            <table className="ledger ac-table">
              <caption className="sr">Day book: what was done, newest first, grouped by day</caption>
              <thead><tr>{cols.when ? <th scope="col" className="ac-when">When</th> : null}<th scope="col">{cols.when ? 'What' : 'When and what'}</th>{cols.who ? <th scope="col">Who acted</th> : null}{cols.under ? <th scope="col">Under</th> : null}<th scope="col" className="num">Amount</th>{cols.state ? <th scope="col" className="ac-state">State</th> : null}</tr></thead>
              {days.map((d) => (
                <tbody key={d.key}>
                  <tr className="ac-day"><th scope="rowgroup" colSpan={span}><span className="ac-day-name">{d.name}</span>{d.date ? <span className="ac-day-date">{d.date}</span> : null}</th></tr>
                  {foldRepeats(d.events).map(({ lead, all }) => <Line key={lead.key} lead={lead} all={all} cols={cols} cases={caseIds} />)}
                </tbody>
              ))}
            </table>
          </section>
        )}
      </>}
      {book.error ? <p className="small faint">The bank statement could not be read just now, so the balance after each payment and order is not shown. {book.error.message}</p> : null}
      {hasWallet && wallet.error ? <p className="small faint">The on-chain wallet's own list could not be read just now, so its rows are missing here. {wallet.error.message} {records}</p> : null}
      {from !== null && inPeriod.length > 0 ? (
        <div className="ac-earlier">
          <p className="small muted">Shown from {fmt.dayTime(from)}, as far back as {bankCut && walletCut ? 'both accounts\' lists' : walletCut ? 'the on-chain wallet\'s list' : 'the bank account\'s lists'} were read.{walletCut && !bankCut ? <> Its earlier requests are in {records}; earlier bank rows show with Account set to Bank account.</> : null}</p>
          {bankCut && limit < 300 ? <Btn onClick={() => setLimit(Math.min(300, limit + 100))}>Show earlier than {fmt.dayTime(from)}</Btn> : null}
        </div>
      ) : null}
      {/* the records filed by kind: a second way in, after the day book (R11 review: the day book led only below two screens of folders on a phone) */}
      {inPeriod.length > 0 ? shelf : null}
      {inPeriod.length > 0 ? <p className="ac-foot small faint">“Checks passed” counts the checks recorded for an action at the moment it was decided: the instruction in force and inside its limits, fresh and confirmed prices, the money there, the reserve and the floor. A refusal is a check that failed, and nothing was sent.</p> : null}
    </div>
  )
}

/**
 * Two fields that make one range, in a group with its legend: the least and most amount in rupees, or the first and last
 * day. Each field is labelled, and says what is wrong with it beside it.
 */
function RangePair({ legend, hint, kind, text, errors, onChange }: { legend: string; hint?: string; kind: 'amount' | 'dates'; text: RangeText; errors: Partial<Record<keyof RangeText, string>>; onChange: (k: keyof RangeText, v: string) => void }) {
  const id = useId()
  const keys = kind === 'amount' ? (['min', 'max'] as const) : (['first', 'last'] as const)
  const words = kind === 'amount' ? ['At least', 'At most'] : ['From', 'To']
  return (
    <fieldset className={`ac-range ac-range-${kind}`}>
      {/* the hint in the legend, as a parenthesis, so the fields are the last row before the count (R13: under the fields
          it opened a near-empty row above the count, about 80 px of space around one number); it is part of the group's name */}
      <legend>{legend}{hint ? <span className="ac-range-hint"> ({hint.charAt(0).toLowerCase()}{hint.slice(1)})</span> : null}</legend>
      <div className="ac-range-pair">
        {keys.map((k, i) => (
          <div key={k} className="ac-range-end">
            <label htmlFor={`${id}-${k}`}>{words[i]}</label>
            <input id={`${id}-${k}`} className="input" {...(kind === 'amount' ? { type: 'text', inputMode: 'decimal' as const, autoComplete: 'off', placeholder: homeSign() } : { type: 'date' })} value={text[k]} aria-invalid={errors[k] ? true : undefined} aria-describedby={errors[k] ? `${id}-${k}-e` : undefined} onChange={(e) => onChange(k, e.target.value)} />
            {errors[k] ? <span className="ac-range-err" id={`${id}-${k}-e`}>{errors[k]}</span> : null}
          </div>
        ))}
      </div>
    </fieldset>
  )
}

function FilterSelect<K extends keyof Filters>({ name, value, onChange }: { name: K; value: Filters[K]; onChange: (v: Filters[K]) => void }) {
  const id = useId()
  const c = FILTER_CHOICES[name]
  return (
    <div className={`ac-filter ac-filter-${name}`}>
      <label htmlFor={id}>{c.label}</label>
      <select id={id} className="input" value={String(value)} onChange={(e) => onChange(e.target.value as Filters[K])}>
        {c.options.map(([v, w]) => <option key={String(v)} value={String(v)}>{w}</option>)}
      </select>
    </div>
  )
}

/** A sum of rupees with its direction: "+₹1,500.00" in, "−₹30,194.65" out, "₹0.00" when nothing moved. */
export const signed = (v: number): string => (v === 0 ? fmt.money(0, true) : `${v < 0 ? MINUS : '+'}${fmt.money(Math.abs(v), true)}`)

/**
 * The net change as a statement: what came in, what went out (negative), and the net, each split by who moved it.
 * Every total is the sum of its row; the net row is the sum of the two above it, column by column.
 */
export function netRows(b: BankSum): { k: 'in' | 'out' | 'net'; label: string; you: number; qed: number; all: number }[] {
  const inn = b.inByYou + b.inByQed, out = b.outByYou + b.outByQed
  return [
    { k: 'in', label: 'Into your bank', you: b.inByYou, qed: b.inByQed, all: inn },
    // 0 - x, not -x: nothing out is 0, never -0
    { k: 'out', label: 'Out of your bank', you: 0 - b.outByYou, qed: 0 - b.outByQed, all: 0 - out },
    { k: 'net', label: 'Net change', you: b.inByYou - b.outByYou, qed: b.inByQed - b.outByQed, all: inn - out },
  ]
}

/**
 * How the bank account's net change is made up, as a statement: what came in, less what went out, equals the net
 * change, each split by who moved it. On a computer one table (the rows: in, out, net; the columns: by you, by QED,
 * total), so every figure sits under its kind and every total is the sum of its row; the net row is the statement's sum
 * line and its total is the panel's lead figure, said once (R13: the lead stood beside the table and repeated its net
 * row, level with "Into your bank"). On a phone the net leads, then what came in and what went out, one line each, who
 * moved each part under it; the net is not repeated below. Every figure is the sum of the rows shown (summarise).
 */
function NetStatement({ b, narrow }: { b: BankSum; narrow: boolean }) {
  const rows = netRows(b)
  const net = rows.find((r) => r.k === 'net')!
  const split = (r: (typeof rows)[number]): ReactNode => (r.you && r.qed ? <>{signed(r.you)} by you, {signed(r.qed)} <span className="by-qed">by QED</span></> : r.all ? (r.you ? 'All by you' : <span className="by-qed">All by QED</span>) : null)
  if (narrow) {
    return (
      <>
        <div className="ac-lead">
          <p className="ac-lead-k">Net change</p>
          <p className={`ac-lead-v ${net.all > 0 ? 'in' : ''}`} data-resolve="">{signed(net.all)}</p>
          {/* who moved the net, only when it is not the same as the one line below that moved (nothing came in, say) */}
          <p className="ac-lead-s">What came in, less what went out{net.you && net.qed && rows.every((r) => r.k === 'net' || r.all !== 0) ? <>: {split(net)}</> : null}</p>
        </div>
        <dl className="ac-net-list">
          {rows.filter((r) => r.k !== 'net').map((r) => (
            <div key={r.k}>
              <dt>{r.label}</dt><dd className={`v ${r.all > 0 ? 'in' : ''}`}>{signed(r.all)}</dd>
              {r.you && r.qed ? <dd className="s">{split(r)}</dd> : null}
            </div>
          ))}
        </dl>
      </>
    )
  }
  const line = (r: (typeof rows)[number]) => (
    <tr key={r.k}><th scope="row">{r.label}</th><td className={r.you > 0 ? 'in' : ''}>{signed(r.you)}</td><td className={r.qed > 0 ? 'in' : ''}>{signed(r.qed)}</td><td className={`all ${r.all > 0 ? 'in' : ''}`}>{signed(r.all)}</td></tr>
  )
  return (
    <table className="ac-net">
      <caption className="sr">How the net change is made up: what came into your bank and what went out of it, by who moved it</caption>
      <thead><tr><td /><th scope="col">By you</th><th scope="col"><span className="by-qed">By QED</span></th><th scope="col">Total</th></tr></thead>
      <tbody>{rows.filter((r) => r.k !== 'net').map(line)}</tbody>
      <tfoot>
        <tr className="ac-net-sum">
          <th scope="row"><span className="ac-net-k">Net change</span><span className="ac-net-s">What came in, less what went out</span></th>
          <td className={net.you > 0 ? 'in' : ''}>{signed(net.you)}</td>
          <td className={net.qed > 0 ? 'in' : ''}>{signed(net.qed)}</td>
          <td className="all"><span className={`ac-lead-v ${net.all > 0 ? 'in' : ''}`} data-resolve="">{signed(net.all)}</span></td>
        </tr>
      </tfoot>
    </table>
  )
}

/**
 * What the rows shown came to, per account. The bank account: the statement of its net change (in, out, net, by who;
 * NetStatement), whose net is the lead figure; then how many orders and payments that was and the checks that hold over
 * them. The on-chain wallet, in its own units: what was paid out leads, beside its other figures on the same ruled lines.
 */
function Totals({ s, from, period, filtered, receiptsChain, decisionChain, showBank, showWallet, narrow }: { s: ReturnType<typeof summarise>; from: number | null; period: string | null; filtered: boolean; receiptsChain: Chain | null; decisionChain: { ok: boolean; records: number; brokenAt: number | null } | null; showBank: boolean; showWallet: boolean; narrow: boolean }) {
  const b = s.bank, w = s.wallet
  const tok = (v: number, u: Unit | null, sign = ''): ReactNode => (u && u.kind === 'token' ? <>{sign}{tokenFigure(v, u.decimals, u.symbol)}<span className="u">{u.words}</span></> : String(v))
  const tokText = (v: number, u: Unit | null): string => (u && u.kind === 'token' ? `${tokenFigure(v, u.decimals, u.symbol)} ${u.words}` : String(v))
  if (!showBank && !showWallet) return null
  return (
    <section className="panel ac-sum" aria-labelledby="tot-h">
      <div className="panel-head"><h2 id="tot-h">What this came to</h2><p>{period ?? (from ? `From ${fmt.dayTime(from)} to now` : 'Everything')}{filtered ? ', for the rows found' : ''}</p></div>
      {showBank ? (
        <div className="ac-acct-block ac-bank">
          <h3 className="ac-acct-h">Bank account</h3>
          <NetStatement b={b} narrow={narrow} />
          <p className="ac-chain">
            <span>{b.actions === 1 ? '1 order or payment' : `${b.actions} orders and payments`}: {partsLine([[b.done, 'completed'], [b.waiting, 'not finished yet'], [b.trouble, 'refused, rejected, failed or partly completed'], [b.other, 'cancelled']])}; {partsLine([[b.byYou, 'by you'], [b.byQed, 'by QED']])}</span>
            {b.finished ? <span>{b.receipts === b.finished ? <Seal /> : null}{b.receipts === b.finished ? (b.finished === 1 ? 'The one that finished kept its receipt' : `Each of the ${b.finished} that finished kept its receipt`) : `${b.receipts} of the ${b.finished} that finished kept a receipt`}</span> : null}
            {receiptsChain ? (receiptsChain.ok ? <span>{receiptsChain.count} receipt{receiptsChain.count === 1 ? '' : 's'} in your chain, intact</span> : <span className="void">Your receipt chain is broken at no. {receiptsChain.brokenAt}</span>) : null}
            {b.runs || b.disputes ? <span>{[b.runs ? `${b.runs} run${b.runs === 1 ? '' : 's'} with nothing sent` : '', b.disputes ? `${b.disputes} dispute${b.disputes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}, not counted above</span> : null}
          </p>
        </div>
      ) : null}
      {showWallet ? (
        <div className="ac-acct-block ac-wallet">
          <h3 className="ac-acct-h">On-chain wallet, in test tokens of no value</h3>
          {/* what was paid out leads: on a phone above the other figures, on a computer as their first line, its figure at
              the same right edge as the bank's (R13: one column of figures per panel, the leads at one size) */}
          {narrow ? (
            <div className="ac-lead">
              <p className="ac-lead-k">Paid out</p>
              <p className="ac-lead-v" data-resolve="">{tok(w.paid, w.unit, w.paid ? MINUS : '')}</p>
              <p className="ac-lead-s">Payments that left the wallet</p>
            </div>
          ) : null}
          <dl className="ac-rows-sum">
            {narrow ? null : <div className="ac-rows-lead"><dt>Paid out</dt><dd className="v"><span className="ac-lead-v" data-resolve="">{tok(w.paid, w.unit, w.paid ? MINUS : '')}</span></dd><dd className="s">Payments that left the wallet</dd></div>}
            <div><dt>Set aside</dt><dd className="v">{tok(w.setAside, w.unit)}</dd><dd className="s">For promised payments, still in the wallet</dd></div>
            <div><dt>Converted</dt><dd className="v">{tok(w.converted, w.unit)}</dd><dd className="s">{w.converted ? `Into ${tokText(w.received, w.reserveUnit)}` : 'None'}</dd></div>
            <div><dt>Requests</dt><dd className="v">{w.rows}</dd><dd className="s">{partsLine([[w.done, 'done'], [w.waiting, 'waiting'], [w.trouble, 'refused or failed'], [w.idle, 'nothing to do'], [w.other - w.idle, 'other']])}; {partsLine([[w.byYou, 'by you'], [w.byQed, 'by QED']])}</dd></div>
          </dl>
          <p className="ac-chain">
            {w.arrived ? <span>{tokText(w.arrived, w.unit)} arrived as the opening grant</span> : null}
            {w.bountyIn ? <span>{tokText(w.bountyIn, w.reserveUnit)} paid into the reserve by a bounty</span> : null}
            {decisionChain ? (decisionChain.ok ? <span>{decisionChain.records} decision record{decisionChain.records === 1 ? '' : 's'} on the wallet, chained and intact</span> : <span className="void">The wallet's decision records are broken at no. {decisionChain.brokenAt}</span>) : null}
          </p>
        </div>
      ) : null}
    </section>
  )
}
