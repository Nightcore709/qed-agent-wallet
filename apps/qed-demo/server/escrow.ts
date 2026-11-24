/**
 * Paper escrow under terms both sides accepted (R13 section 2, on R12 task comparison gap 16). On paper the client is
 * played by the household, and so is the mediator of a dispute: every text says so, and neither is ever presented as a
 * real client, arbitrator, court or regulated dispute service.
 *
 * Terms come before commitment and are bound to the record. A new job shows its complete terms before it is opened: the
 * delivery date; the client's review, the earner's time to answer a request for the money back, each side's time for
 * evidence in a dispute and the decision deadline, each with what happens when it runs out; who decides a dispute and
 * what it may do; who plays each role; how a split is rounded. Each period and each timeout outcome is a choice within
 * stated bounds (POLICY), its default shown with the reason for it and its source. The terms are stored as canonical
 * JSON with a version and a SHA-256 (earn_terms, append-only), and they are in force once both sides have accepted that
 * hash (earn_terms_accepts: who accepted, in which role, when). Opening a job checks that the hash accepted is the hash
 * of the terms the request describes, as an approval is bound to its document. Each milestone points at its terms
 * (earn_milestones.terms_id), and a trigger refuses to change that pointer once set.
 *
 * Deadlines come from the stored terms and the steps that start them, never from current settings: a review from the
 * step that submitted the work, an answer from the step that asked for the money back, a dispute's evidence and decision
 * from when it was raised; none counts from before the terms were agreed. due_at is a cache of the next one, and before
 * the engine applies anything it works the deadline out again from the terms and those steps (applyDue). A restart or a
 * migration changes neither, so no timer restarts.
 *
 * Milestones from before terms were recorded (terms_id NULL) keep the terms they were opened on: no deadline and no
 * default. Nothing happens to them on its own. The moves those terms allowed stay open (the earner submits; the paper
 * client accepts, marks a dispute or takes the money back), and the two sides may agree terms for the milestone, one
 * proposing and the other accepting; its timers then start at the agreement, never before.
 *
 * The roles: the earner, the paper client and the simulated mediator. In a personal workspace the household plays each,
 * and every step records the role it was taken in. In a business workspace each role is a named member (the earner who
 * opens the job; a member who may approve for the client; another for the mediator, all three different), the client's
 * member accepts the terms and funds the escrow, and a step is refused from anyone but the member who plays its role.
 * The mediator may release, refund or split the escrowed amount of the disputed milestone, nothing else, and its
 * decision binds no one outside this practice build.
 *
 * The engine applies each due default once, whichever process gets there first: every step re-reads the milestone inside
 * one write transaction and changes it only from the state it read, and a milestone's money is posted under one ledger
 * reference (earn:<milestone>), which refuses a second posting. An engine that was not running at a deadline applies it
 * when it starts, dated at the deadline and marked as recorded late. These deadlines run whether or not QED is paused: a
 * pause stops QED's instructions, not an escrow's terms. Where the terms say the money stays locked at a deadline,
 * nothing more happens on its own: the two sides may settle by agreement (one offers an outcome, the other accepts the
 * same), and either side may still give way.
 *
 * Money: the client's money is never in the household's books (no account holds the escrow; QED keeps the record). What
 * the earner receives is one ledger entry, bank against earnings; what goes back to the client moves nothing in the
 * household's books. In a split the client's part is rounded down to the paisa and the earner receives the rest, so the
 * two always add up to the milestone exactly. Every step is recorded with the role it was taken in, the member and when.
 */
import { inrExact } from '../shared/money.ts'
import { canonical } from '../shared/sha256.ts'
import { addDays, AppError, audit, bad, type Db, emit, istInstant, newId, notFound, parse, refused, whenIst } from './core.ts'
import { notice, resolveNotices } from './execute.ts'
import { post } from './ledger.ts'
import { issueReceipt, sha256hex } from './receipts.ts'
import type { Ctx } from './types.ts'
import { actor, membership, type Role } from './workspaces.ts'

type Raw = Record<string, unknown>
type Env = Record<string, string | undefined>
const DAY = 86_400_000
const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 100_000_000_000
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '')

// ------------------------------------------------------------------------------------------------ the policies a job chooses

export type OutcomeKind = 'release' | 'refund' | 'split' | 'locked' | 'raiser'
/** What happens when a period runs out. earnerPct: a split's share to the earner, in whole per cent. */
export interface Outcome { kind: OutcomeKind; earnerPct?: number }
export type Period = 'review' | 'answer' | 'evidence' | 'decision'
export const PERIODS: readonly Period[] = ['review', 'answer', 'evidence', 'decision']
export interface PolicySpec { label: string; days: { default: number; min: number; max: number }; outcomes: OutcomeKind[]; onTimeout: Outcome; why: string; timeoutWhy: string; source: string }
const MARKETS = 'NOT VERIFIED. Excerpts of Upwork\'s and Fiverr\'s help pages as a search returned them on 24 Nov 2026; both providers\' own pages refused automated reading (HTTP 403), so neither was read in full. Excerpts: Upwork, funds of a fixed-price milestone release automatically after 14 days with no client action, and a client has 5 days to respond to a freelancer\'s dispute or the funds go to the freelancer; Fiverr, an order completes 3 days after delivery with no buyer action (14 for a gig that ships), and a cancellation request left unanswered for 48 hours is accepted on one help page and cancelled on another (the providers\' pages disagree). QED\'s periods are its own policy choices, not law and not either provider\'s rule.'
/**
 * Each period's default, its bounds, its timeout options and default, and why: choices a job makes and shows, never
 * universal standards. The defaults follow what two freelance marketplaces are reported to do, where they say anything;
 * the decision deadline and its fallback are QED's own choice, said so.
 */
export const POLICY: Record<Period, PolicySpec> = {
  review: {
    label: 'The client\'s review of submitted work', days: { default: 7, min: 1, max: 14 }, outcomes: ['release', 'refund', 'split', 'locked'], onTimeout: { kind: 'release' },
    why: '7 days lies between a marketplace that completes an order 3 days after delivery unless the client acts (Fiverr) and one that releases fixed-price work when a review of up to 14 days ends (Upwork): long enough to check work across a weekend, short enough not to keep the earner waiting two weeks.',
    timeoutWhy: 'Both marketplaces are reported to release the money when the review ends without an answer: the earner has delivered and asked to be paid.',
    source: MARKETS,
  },
  answer: {
    label: 'Your time to answer the client asking for the money back', days: { default: 3, min: 1, max: 7 }, outcomes: ['refund', 'release', 'split', 'locked'], onTimeout: { kind: 'refund' },
    why: '3 days lies between Fiverr, reported to accept an unanswered request after 48 hours, and Upwork, reported to give the other party 5 days to answer a dispute.',
    timeoutWhy: 'An unanswered request stands, as one Fiverr help page is reported to accept one after 48 hours (another says the order is cancelled, which also ends in a refund): the earner had the stated time to object.',
    source: MARKETS,
  },
  evidence: {
    label: 'Each side\'s time for evidence in a dispute', days: { default: 3, min: 1, max: 7 }, outcomes: ['raiser', 'split', 'locked'], onTimeout: { kind: 'raiser' },
    why: 'The same 3 days as an answer: Upwork is reported to give the other party 5 days to respond to a dispute, Fiverr 48 hours to a request.',
    timeoutWhy: 'If the side that did not raise the dispute never answers, the side that raised it has its way, as Upwork is reported to release the funds to the party who asked when the other does not respond.',
    source: MARKETS,
  },
  decision: {
    label: 'The mediator\'s deadline, counted from the dispute', days: { default: 5, min: 2, max: 21 }, outcomes: ['split', 'release', 'refund', 'locked'], onTimeout: { kind: 'split', earnerPct: 50 },
    why: 'QED\'s own choice, with no outside source: two days after the usual evidence window closes.',
    timeoutWhy: 'A stated fallback, so that the money is not locked for ever when no decision comes. Half each is not a judgement of who is right and is not fair by itself: choose another outcome, or "stays locked until both agree", if it does not suit this work.',
    source: 'QED\'s own choice, with no outside source.',
  },
}

// ------------------------------------------------------------------------------------------------ the terms

/** The terms of a paper job, exactly as shown and accepted (version 2). Periods in milliseconds; amounts in paise. */
export interface Terms {
  version: 2
  job: { title: string; client: string }
  milestones: { title: string; amount: number }[]
  /** The end of the delivery day in India (ms), or null: no delivery date. */
  deliverBy: number | null
  review: { ms: number; onTimeout: Outcome }
  answer: { ms: number; onTimeout: Outcome }
  evidence: { ms: number; onTimeout: Outcome }
  decision: { ms: number; onTimeout: Outcome }
  mediator: { simulated: true; may: ('release' | 'refund' | 'split')[] }
  /** The person who plays each role: in a personal workspace the household (the workspace's own person) plays all three. */
  roles: { earner: string; client: string; mediator: string }
  rounding: 'client-part-down'
  /** Periods given in seconds, on an isolated test stack only. */
  test?: true
}
export const TERMS_VERSION = 2

type RoleName = 'earner' | 'client' | 'mediator'
type Side = 'earner' | 'client'
const RANK: Record<Role, number> = { owner: 4, admin: 3, approver: 2, operator: 1, viewer: 0 }
/** The least workspace role a member needs to play each part in a business workspace. */
const NEEDS: Record<RoleName, Role> = { earner: 'operator', client: 'approver', mediator: 'approver' }
const ROLE_WORDS: Record<RoleName | 'rule', string> = { earner: 'the earner', client: 'the paper client', mediator: 'the simulated mediator', rule: 'the escrow, by its terms' }
const nameOf = (db: Db, personId: string): string => db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', personId)?.display_name ?? 'another member'
const isBusiness = (db: Db, ws: string): boolean => db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', ws)?.kind === 'business'
const mayPlay = (db: Db, ws: string, person: string, role: RoleName): boolean => { const m = membership(db, ws, person); return !!m && RANK[m.role] >= RANK[NEEDS[role]] }

/** In a split, the client's part rounded down to the paisa and the earner's the rest: the two add up to the amount exactly. */
export function splitOf(amount: number, earnerPct: number): { earner: number; client: number } {
  const client = Number((BigInt(amount) * BigInt(100 - earnerPct)) / 100n)
  return { earner: amount - client, client }
}

/** Who plays each role: the household in a personal workspace; in a business, three different members who may. */
function rolesFor(db: Db, ws: string, raw: Raw, fields: Record<string, string>, proposer: { side: Side; person: string } | null): Terms['roles'] {
  if (!isBusiness(db, ws)) return { earner: ws, client: ws, mediator: ws }
  const r = (raw.roles ?? {}) as Raw
  const pick = (k: RoleName): string => (typeof r[k] === 'string' ? r[k] as string : '')
  // the member who proposes the terms plays the side they propose for (opening a job, the earner)
  const earner = proposer?.side === 'earner' ? proposer.person : pick('earner')
  const client = proposer?.side === 'client' ? proposer.person : pick('client')
  const mediator = pick('mediator')
  for (const [k, p] of [['earner', earner], ['client', client], ['mediator', mediator]] as [RoleName, string][]) {
    if (!p || !mayPlay(db, ws, p, k)) fields[`role_${k}`] = `Choose a member who may ${k === 'earner' ? 'prepare work (an operator or above)' : 'approve (an approver, admin or owner)'} to play ${ROLE_WORDS[k]}.`
  }
  if (earner && client && mediator && new Set([earner, client, mediator]).size !== 3) fields.roles = 'The earner, the paper client and the mediator must be three different members.'
  return { earner, client, mediator }
}

interface Scope { job: { title: string; client: string }; milestones: { title: string; amount: number }[]; proposer: { side: Side; person: string } | null }
/**
 * The complete terms a request describes, their canonical JSON and its SHA-256, and the fields it got wrong. Every value
 * not given takes its stated default; every value given is checked against its bounds and options.
 */
export function buildTerms(db: Db, ws: string, raw: Raw, now: number, scope: Partial<Scope> = {}, env: Env = process.env): { terms: Terms; json: string; hash: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  const job = scope.job ?? { title: clean(raw.title, 80), client: clean(raw.client, 60) }
  if (!scope.job) {
    if (job.title.length < 3) fields.title = 'Describe the work.'
    if (job.client.length < 2) fields.client = 'Name the client.'
  }
  let milestones = scope.milestones
  if (!milestones) {
    const ms = Array.isArray(raw.milestones) ? (raw.milestones as Raw[]) : []
    if (ms.length < 1 || ms.length > 8 || ms.some((m) => !isPaise(m.amount) || clean(m.title, 80).length < 2)) fields.milestones = 'Add one to eight milestones, each with a name and an amount.'
    milestones = ms.map((m) => ({ title: clean(m.title, 80), amount: m.amount as number }))
  }
  // periods: whole days within each stated range; on an isolated test stack, seconds, and the terms say so
  const secs = raw.testSeconds && typeof raw.testSeconds === 'object' ? (raw.testSeconds as Raw) : null
  const test = !!secs && Object.keys(secs).length > 0
  if (test && env.QED_TEST_STACK !== '1') fields.testSeconds = 'Periods in seconds are for an isolated test stack only. Set them in days.'
  const ms = {} as Record<Period, number>
  for (const p of PERIODS) {
    const spec = POLICY[p]
    const s = test && env.QED_TEST_STACK === '1' ? secs![p] : undefined
    if (s !== undefined) {
      if (!Number.isInteger(s) || (s as number) < 5 || (s as number) > 3600) fields[`${p}Days`] = 'On a test stack a period lasts 5 to 3600 seconds.'
      else ms[p] = (s as number) * 1000
      continue
    }
    const d = raw[`${p}Days`]
    if (d === undefined || d === null) ms[p] = spec.days.default * DAY
    else if (!Number.isInteger(d) || (d as number) < spec.days.min || (d as number) > spec.days.max) fields[`${p}Days`] = `${spec.label}: ${spec.days.min} to ${spec.days.max} days, in whole days.`
    else ms[p] = (d as number) * DAY
  }
  if (!fields.evidenceDays && !fields.decisionDays && ms.decision <= ms.evidence) fields.decisionDays = 'The decision deadline must come after the evidence closes.'
  // what happens when each period runs out: one of the stated options
  const given = (raw.onTimeout && typeof raw.onTimeout === 'object' ? raw.onTimeout : {}) as Raw
  const outcome = {} as Record<Period, Outcome>
  for (const p of PERIODS) {
    const spec = POLICY[p]
    const o = given[p] as Raw | undefined
    if (o === undefined || o === null) { outcome[p] = { ...spec.onTimeout }; continue }
    const kind = o.kind as OutcomeKind
    if (!spec.outcomes.includes(kind)) { fields[`${p}OnTimeout`] = 'Choose one of the stated outcomes.'; outcome[p] = { ...spec.onTimeout }; continue }
    if (kind !== 'split') { outcome[p] = { kind }; continue }
    const pct = o.earnerPct
    if (!Number.isInteger(pct) || (pct as number) < 1 || (pct as number) > 99) { fields[`${p}OnTimeout`] = 'A split gives the earner 1 to 99 per cent, in whole per cent.'; outcome[p] = { ...spec.onTimeout } } else outcome[p] = { kind, earnerPct: pct as number }
  }
  // the delivery date: the work is due by the end of that day in India
  let deliverBy: number | null = null
  const by = raw.deliverBy
  if (by !== undefined && by !== null && by !== '') {
    const iso = typeof by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(by) && new Date(`${by}T00:00:00Z`).toISOString().startsWith(by) ? by : null
    if (!iso) fields.deliverBy = 'Give the delivery date as a date, such as 2026-12-04.'
    else {
      const end = istInstant(addDays(iso, 1), '00:00') - 1
      if (end <= now) fields.deliverBy = 'The delivery date must be today or later.'
      else if (end > now + 366 * DAY) fields.deliverBy = 'The delivery date must be within a year.'
      else deliverBy = end
    }
  }
  const roles = rolesFor(db, ws, raw, fields, scope.proposer ?? null)
  const terms: Terms = {
    version: 2, job, milestones, deliverBy,
    review: { ms: ms.review ?? 0, onTimeout: outcome.review }, answer: { ms: ms.answer ?? 0, onTimeout: outcome.answer },
    evidence: { ms: ms.evidence ?? 0, onTimeout: outcome.evidence }, decision: { ms: ms.decision ?? 0, onTimeout: outcome.decision },
    mediator: { simulated: true, may: ['release', 'refund', 'split'] }, roles, rounding: 'client-part-down', ...(test ? { test: true as const } : {}),
  }
  const json = canonical(terms)
  return { terms, json, hash: sha256hex(json), fields }
}

/** The person acting: the signed-in member (from the request), or, for an in-process caller in a personal workspace, its own person. */
function acting(db: Db, ws: string): string | null {
  const a = actor.getStore()
  if (a) return a.personId
  return isBusiness(db, ws) ? null : ws
}
/**
 * The member taking a step in a role, or a refusal. In a personal workspace the household plays every role and only its
 * own person acts. In a business workspace the step must come from the member the terms name for the role (without terms,
 * from a member allowed to play it), so the earner never acts as its own client or mediator.
 */
function mustPlay(db: Db, ws: string, role: RoleName, terms: Terms | null): string {
  const person = acting(db, ws)
  if (!isBusiness(db, ws)) {
    if (person !== ws) throw new AppError(403, 'not_your_role', 'Only this workspace\'s own person may take its steps.')
    return ws
  }
  if (!person) throw new AppError(403, 'not_your_role', 'In a business workspace each role is played by a named member, who signs in to take its steps.')
  if (!mayPlay(db, ws, person, role)) throw new AppError(403, 'not_your_role', `To act as ${ROLE_WORDS[role]} a member must be ${NEEDS[role] === 'operator' ? 'an operator or above' : 'an approver, admin or owner'}. Nothing was done.`)
  if (terms && terms.roles[role] !== person) throw new AppError(403, 'not_your_role', `On this job ${ROLE_WORDS[role]} is played by ${nameOf(db, terms.roles[role])}. Nothing was done.`)
  return person
}

// ------------------------------------------------------------------------------------------------ records

interface Ms { id: string; job_id: string; user_id: string; title: string; amount: number; state: string; evidence_hash: string | null; due_at: number | null; updated_at: number; terms_id: string | null }
interface Dsp { id: string; milestone_id: string; raised_by: Side; against: 'work' | 'refund'; reason: string; raised_at: number; evidence_due_at: number; decide_by: number; heard_at: number | null; state: 'open' | 'decided'; outcome: string | null; earner_paise: number | null; client_paise: number | null; decided_by: string | null; decided_at: number | null }
/** Terms bound to a milestone, checked against their fingerprint; agreedAt: when the second side accepted (null: not yet). */
interface Bound { id: string; terms: Terms; hash: string; agreedAt: number | null; accepts: { side: Side; person: string | null; at: number }[] }
const MS_COLS = 'id, job_id, user_id, title, amount, state, evidence_hash, due_at, updated_at, terms_id'
const FINAL = new Set(['released', 'refunded', 'split'])
const OPEN = new Set(['funded', 'submitted', 'refund-asked', 'disputed'])

function load(db: Db, ws: string, id: string): Ms {
  const m = db.get<Ms>(`SELECT ${MS_COLS} FROM earn_milestones WHERE id = ? AND user_id = ?`, id, ws)
  if (!m || m.state.startsWith('chain-')) throw notFound('That milestone')
  return m
}
const disputeOf = (db: Db, milestoneId: string): Dsp | undefined => db.get<Dsp>('SELECT * FROM earn_disputes WHERE milestone_id = ?', milestoneId)

/** A terms row, its fingerprint checked: a row whose JSON no longer hashes to its stored hash is never acted on. */
function termsRow(db: Db, ws: string, termsId: string): Bound {
  const t = db.get<{ id: string; terms_json: string; hash: string; version: number }>('SELECT id, terms_json, hash, version FROM earn_terms WHERE id = ? AND user_id = ?', termsId, ws)
  if (!t || t.version !== TERMS_VERSION || sha256hex(t.terms_json) !== t.hash) throw new AppError(409, 'terms_invalid', 'The terms on record for this milestone do not match their fingerprint. Nothing was done, and nothing happens to it on its own.')
  const accepts = db.all<{ side: Side; person_id: string | null; at: number }>('SELECT side, person_id, at FROM earn_terms_accepts WHERE terms_id = ? ORDER BY at, rowid', t.id).map((a) => ({ side: a.side, person: a.person_id, at: a.at }))
  const agreed = accepts.some((a) => a.side === 'earner') && accepts.some((a) => a.side === 'client')
  return { id: t.id, terms: JSON.parse(t.terms_json) as Terms, hash: t.hash, agreedAt: agreed ? Math.max(...accepts.map((a) => a.at)) : null, accepts }
}
/** A milestone's terms, or null when it has none (a milestone from before terms were recorded). */
const boundOf = (db: Db, m: Ms): Bound | null => (m.terms_id ? termsRow(db, m.user_id, m.terms_id) : null)

/** One step on a milestone: the role it was taken in, the member who took it, and when. */
function step(db: Db, m: Pick<Ms, 'id' | 'user_id'>, role: RoleName | 'rule', name: string, now: number, person: string | null, detail: Raw = {}): void {
  db.run('INSERT INTO earn_steps (milestone_id, user_id, ts, actor, step, person_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)', m.id, m.user_id, now, role, name, role === 'rule' ? null : person, canonical(detail))
}
/** Move a milestone on from the state it was read in, or refuse: a step never acts on a state it did not see. */
function move(db: Db, m: Ms, state: string, dueAt: number | null, now: number, evidence?: string): void {
  const changed = db.run('UPDATE earn_milestones SET state = ?, due_at = ?, updated_at = ?, evidence_hash = COALESCE(?, evidence_hash) WHERE id = ? AND user_id = ? AND state = ?', state, dueAt, now, evidence ?? null, m.id, m.user_id, m.state).changes
  if (changed !== 1) throw refused('changed', 'This milestone changed meanwhile. Nothing was done; read it again.')
}

// ------------------------------------------------------------------------------------------------ deadlines, from the terms and the steps

/** The steps that start a period; a period never starts before its terms were agreed. */
const STARTS: Partial<Record<string, string[]>> = { submitted: ['submitted', 'terms-agreed'], 'refund-asked': ['asked-refund', 'terms-agreed'] }
/**
 * The deadline a milestone waits on, worked out from its accepted terms and the step that started the period (or the
 * dispute's raising): never from current settings or from due_at, which only caches it. Null: nothing is scheduled.
 */
export function deadlineOf(db: Db, m: Ms, b: Bound | null, d: Dsp | undefined): { period: Period; at: number } | null {
  if (!b || b.agreedAt === null) return null
  if (m.state === 'disputed') {
    if (!d || d.state !== 'open') return null
    return d.heard_at === null ? { period: 'evidence', at: d.raised_at + b.terms.evidence.ms } : { period: 'decision', at: d.raised_at + b.terms.decision.ms }
  }
  const names = STARTS[m.state]
  if (!names) return null
  const s = db.get<{ ts: number }>(`SELECT ts FROM earn_steps WHERE milestone_id = ? AND step IN (${names.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`, m.id, ...names)
  if (!s) return null
  return { period: m.state === 'submitted' ? 'review' : 'answer', at: Math.max(s.ts, b.agreedAt) + b.terms[m.state === 'submitted' ? 'review' : 'answer'].ms }
}
/** Whether the milestone's period ran out with the terms saying the money stays locked: nothing more happens on its own. */
const lockedAt = (b: Bound | null, dl: { period: Period; at: number } | null, now: number): boolean => !!b && !!dl && now >= dl.at && b.terms[dl.period].onTimeout.kind === 'locked'

// ------------------------------------------------------------------------------------------------ whose move

type Move = 'submit' | 'give-back' | 'agree' | 'dispute' | 'evidence' | 'accept' | 'refund' | 'decide' | 'settle' | 'propose-terms' | 'accept-terms'
const MOVES: Record<RoleName, Move[]> = { earner: ['submit', 'give-back', 'agree', 'dispute', 'evidence', 'settle', 'propose-terms', 'accept-terms'], client: ['accept', 'dispute', 'refund', 'evidence', 'settle', 'propose-terms', 'accept-terms'], mediator: ['decide'] }
const SETTLED: Record<string, string> = { released: 'released to the earner', refunded: 'refunded to the client', split: 'split between the two' }
const NO_TERMS = 'This milestone was opened before terms were recorded: it has no deadlines, no mediator and no default. The two sides may agree terms for it.'

interface Seen { m: Ms; b: Bound | null; d: Dsp | undefined; dl: { period: Period; at: number } | null; proposal: Proposal | null }
/** Why a role may not make a move now, or null when it may: refusals and the moves the page offers both come from here. */
function refusal(s: Seen, now: number, role: RoleName, mv: Move): AppError | null {
  const { m, b, d, dl } = s
  if (FINAL.has(m.state)) return refused('wrong_state', `"${m.title}" is settled, ${SETTLED[m.state]}. Nothing more can be done on it.`)
  if (mv === 'settle') return m.state === 'proposed' ? refused('not_funded', 'The paper client has not accepted the terms, so nothing is in escrow.') : null
  if (!b) {
    // the terms it was opened on: the earner submits; the client accepts, marks a dispute or takes the money back; and the
    // two may agree terms
    // either side may propose terms, and a later proposal replaces an earlier one; only the other side may accept it
    if (mv === 'propose-terms') return OPEN.has(m.state) ? null : refused('wrong_state', 'There is nothing in escrow to agree terms for.')
    if (mv === 'accept-terms') return s.proposal && !s.proposal.decided && s.proposal.by !== role ? null : refused('no_proposal', 'There are no terms proposed by the other side to accept.')
    if (role === 'earner' && mv === 'submit') return m.state === 'funded' ? null : refused('wrong_state', `The work for "${m.title}" is already submitted.`)
    if (role === 'client' && mv === 'accept') return m.state === 'submitted' || m.state === 'disputed' ? null : refused('wrong_state', 'There is no submitted work to accept.')
    if (role === 'client' && mv === 'dispute') return m.state === 'submitted' ? null : refused('wrong_state', 'Only submitted work can be disputed.')
    if (role === 'client' && mv === 'refund') return null
    return refused('no_terms', NO_TERMS)
  }
  if (mv === 'propose-terms' || mv === 'accept-terms') return mv === 'accept-terms' && m.state === 'proposed' && role === 'client' ? null : refused('has_terms', 'This milestone already runs under accepted terms.')
  if (m.state === 'proposed') return refused('not_funded', 'The paper client has not accepted the terms, so nothing is in escrow yet.')
  const t = b.terms
  const open = m.state === 'disputed' && d?.state === 'open'
  const due = dl?.at ?? 0
  const locked = lockedAt(b, dl, now)
  switch (`${role}:${mv}`) {
    case 'earner:submit':
      if (m.state === 'refund-asked') return refused('wrong_state', 'The client has asked for the money back: agree to it or dispute it first.')
      return m.state === 'funded' ? null : refused('wrong_state', `The work for "${m.title}" is already submitted.`)
    case 'earner:give-back':
      return m.state === 'funded' ? null : refused('wrong_state', 'You can give the money back only before you submit the work. In a dispute, give way instead.')
    case 'earner:agree':
      if (m.state === 'refund-asked') return now < due || locked ? null : refused('answer_ended', `Your time to answer ended ${whenIst(due)}: the terms decide what happens now.`)
      return open ? null : refused('wrong_state', 'The client has not asked for the money back, and there is no dispute to give way in.')
    case 'earner:dispute':
      if (m.state !== 'refund-asked') return refused('wrong_state', 'You can dispute the client taking the money back, while you have time to answer it.')
      return now < due ? null : refused('answer_ended', `Your time to answer ended ${whenIst(due)}: the terms decide what happens now.`)
    case 'earner:evidence': case 'client:evidence':
      if (!open) return refused('wrong_state', 'There is no open dispute on this milestone.')
      return now < d!.raised_at + t.evidence.ms ? null : refused('evidence_closed', `Evidence closed ${whenIst(d!.raised_at + t.evidence.ms)}.`)
    case 'client:accept':
      if (m.state === 'submitted') return now < due || locked ? null : refused('review_ended', `The client's review ended ${whenIst(due)}: the terms decide what happens now.`)
      return open ? null : refused('wrong_state', 'There is no submitted work to accept.')
    case 'client:dispute':
      if (m.state !== 'submitted') return refused('wrong_state', 'The client can dispute submitted work only, during its review.')
      return now < due ? null : refused('review_ended', `The client's review ended ${whenIst(due)}: the terms decide what happens now.`)
    case 'client:refund':
      if (m.state === 'submitted') return refused('wrong_state', 'The work is submitted: the client accepts it or disputes it. The money does not go back without a decision.')
      if (m.state === 'refund-asked') return refused('wrong_state', 'The client has already asked for the money back.')
      if (m.state !== 'funded') return refused('wrong_state', 'In a dispute the decision says where the money goes.')
      return t.deliverBy !== null && now <= t.deliverBy ? refused('not_yet', `The earner has until ${whenIst(t.deliverBy)} to deliver; before then only the earner can give the money back.`) : null
    case 'mediator:decide':
      if (!open) return refused('wrong_state', 'There is no open dispute to decide.')
      if (now >= d!.raised_at + t.decision.ms) return refused('decision_closed', `The decision was due ${whenIst(d!.raised_at + t.decision.ms)}: the terms decide what happens now.`)
      return d!.heard_at === null ? refused('not_heard', `The mediator decides once both sides are heard. ${d!.raised_by === 'client' ? 'The earner' : 'The client'} has until ${whenIst(d!.raised_at + t.evidence.ms)} to answer.`) : null
  }
  return bad('That is not a step on a paper milestone.')
}
const can = (s: Seen, now: number): Record<RoleName, Move[]> => ({
  earner: MOVES.earner.filter((x) => !refusal(s, now, 'earner', x)), client: MOVES.client.filter((x) => !refusal(s, now, 'client', x)), mediator: MOVES.mediator.filter((x) => !refusal(s, now, 'mediator', x)),
})
function seen(db: Db, m: Ms): Seen {
  const b = boundOf(db, m)
  const d = m.state === 'disputed' ? disputeOf(db, m.id) : undefined
  return { m, b, d, dl: deadlineOf(db, m, b, d), proposal: b ? null : proposalOf(db, m) }
}
function must(s: Seen, now: number, role: RoleName, mv: Move): void {
  const no = refusal(s, now, role, mv)
  if (no) throw no
}

// ------------------------------------------------------------------------------------------------ settling: the one place money moves

const outcomeWords = (o: 'released' | 'refunded' | 'split', toEarner: number, toClient: number): string =>
  (o === 'released' ? `released to you in full, ${inrExact(toEarner)}` : o === 'refunded' ? `refunded to the client in full, ${inrExact(toClient)}` : `${inrExact(toEarner)} to you and ${inrExact(toClient)} back to the client`)
/** The rule a timeout outcome applies, in words, for the receipt (the terms themselves are bound by their hash). */
function ruleWords(period: Period, o: Outcome): string {
  const what = o.kind === 'release' ? 'it is released to the earner' : o.kind === 'refund' ? 'it goes back to the client' : o.kind === 'split' ? `it is split, ${o.earnerPct}% to the earner (the client's part rounded down to the paisa)` : o.kind === 'raiser' ? 'the side that raised the dispute has its way' : 'it stays locked until both sides agree'
  return `${POLICY[period].label} ran out; the accepted terms say ${what}.`
}

interface Settle { outcome: 'released' | 'refunded' | 'split'; toEarner: number; by: RoleName | 'rule' | 'agreement'; why: string; rule?: string; at?: number; period?: Period }
/**
 * Settle a milestone: its final state, the earner's part posted to the bank (one entry, reference earn:<milestone>), the
 * dispute decided, one receipt naming the terms by their fingerprint. Inside the caller's transaction, from the state the
 * caller read: a milestone is settled once. `at` is when the settlement took effect (a deadline), when QED records it later.
 */
function settle(db: Db, m: Ms, b: Bound | null, d: Dsp | undefined, s: Settle, now: number): void {
  const at = s.at ?? now
  const toClient = m.amount - s.toEarner
  if (s.toEarner < 0 || toClient < 0 || !Number.isSafeInteger(s.toEarner)) throw new Error(`An escrow settlement of ${m.id} would not conserve its amount.`)
  move(db, m, s.outcome, null, now)
  const job = db.get<{ title: string; client: string }>('SELECT title, client FROM earn_jobs WHERE id = ?', m.job_id)!
  const late = now - at > 10 * 60_000
  const why = late ? `${s.why} It was recorded late, at ${whenIst(now)}: the engine was not running at the deadline.` : s.why
  let seq: number | null = null
  if (s.toEarner > 0) {
    const memo = s.outcome === 'split' ? `${m.title}: ${inrExact(s.toEarner)} of ${inrExact(m.amount)}, settled between you and ${job.client} (paper escrow)` : `${job.client} released ${m.title} (paper escrow)`
    const e = post(db, { userId: m.user_id, ts: now, effectiveTs: at, kind: 'income-earn', ref: `earn:${m.id}`, memo,
      meta: { paper: true, jobId: m.job_id, milestoneId: m.id, evidenceHash: m.evidence_hash, outcome: s.outcome, decidedBy: s.by, ...(b ? { termsHash: b.hash } : {}), ...(s.period ? { period: s.period } : {}), ...(d ? { disputeId: d.id } : {}), ...(late ? { recordedLate: true, scheduledAt: at, note: 'Recorded late: the engine was not running at the deadline.' } : {}) },
      lines: [{ account: 'bank', amount: BigInt(s.toEarner) }, { account: 'inc:earn', amount: -BigInt(s.toEarner) }] })
    // the escrow pays a milestone once: an entry already under its reference is a fault, and nothing is recorded twice
    if (e.duplicate) throw new Error(`The escrow already paid ${m.id} (ledger entry ${e.seq}); nothing was recorded again.`)
    seq = e.seq
  }
  if (d && d.state === 'open') db.run(`UPDATE earn_disputes SET state = 'decided', outcome = ?, earner_paise = ?, client_paise = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'`, s.outcome, s.toEarner, toClient, s.by, now, d.id)
  issueReceipt(db, m.user_id, 'earning', m.id, {
    what: s.outcome === 'released' ? `Escrow released: ${m.title}` : s.outcome === 'refunded' ? `Escrow refunded to the client: ${m.title}` : `Escrow split: ${m.title}`,
    outcome: s.outcome, client: job.client, amount: String(m.amount),
    ...(s.outcome === 'split' ? { toEarner: String(s.toEarner), toClient: String(toClient) } : {}),
    ...(m.evidence_hash ? { evidenceHash: m.evidence_hash } : {}),
    ...(seq !== null ? { ledgerEntry: seq } : {}),
    counterparty: 'paper client (played by the owner)', decidedBy: s.by, resolution: why,
    ...(s.rule ? { rule: s.rule } : {}),
    terms: b ? { fingerprint: b.hash, version: b.terms.version } : 'opened before terms were recorded: no deadline and no default',
    ...(d ? { dispute: { raisedBy: d.raised_by, against: d.against, reason: d.reason, raisedAt: d.raised_at, decider: 'a simulated mediator, played by the owner; not an arbitrator, a court or a regulated dispute service' } } : {}),
  }, now)
  if (d) resolveNotices(db, m.user_id, `milestone:${m.id}`, now)
  // a default the terms applied happened while nobody was looking: the household is told, in QED only
  if (s.by === 'rule') notice(db, m.user_id, { level: 'info', kind: 'milestone-settled', title: s.outcome === 'released' ? `Released to you: ${m.title}` : s.outcome === 'refunded' ? `Refunded to the client: ${m.title}` : `Split: ${m.title}`, body: `${why} Practice money, on paper.`, subject: m.id, dedupe: `escrow-settled:${m.id}` }, now)
  if (db.get<{ n: number }>(`SELECT COUNT(*) n FROM earn_milestones WHERE job_id = ? AND state NOT IN ('released', 'refunded', 'split')`, m.job_id)!.n === 0) db.run(`UPDATE earn_jobs SET state = 'complete' WHERE id = ?`, m.job_id)
  audit(db, now, m.user_id, s.by === 'rule' ? 'engine' : 'owner', `earn.paper.${s.outcome}`, m.id, { toEarner: s.toEarner, toClient, by: s.by, termsHash: b?.hash ?? null })
}

// ------------------------------------------------------------------------------------------------ opening a job

/** The complete terms a new job would be opened on, and their fingerprint, before anything is committed. */
export function previewTerms(db: Db, ws: string, raw: Raw, now: number, env: Env = process.env): { terms: Terms; hash: string } {
  const person = mustPlay(db, ws, 'earner', null)
  const t = buildTerms(db, ws, raw, now, { proposer: { side: 'earner', person } }, env)
  if (Object.keys(t.fields).length) throw bad('Check the highlighted fields.', t.fields)
  return { terms: t.terms, hash: t.hash }
}

/**
 * Open a paper job on the terms it was shown with. termsHash must be the fingerprint of the terms this request describes,
 * and accept.earner (and, in a personal workspace, accept.client: the household plays the client) must be given: the
 * terms are then in force and the paper client's money is in escrow. In a business workspace the client's member accepts
 * later (acceptJobTerms); until then the milestones are proposed and nothing is in escrow.
 */
export function openJob(db: Db, ws: string, raw: Raw, now: number, env: Env = process.env): { id: string; termsHash: string; state: 'funded' | 'proposed' } {
  const person = mustPlay(db, ws, 'earner', null)
  const t = buildTerms(db, ws, raw, now, { proposer: { side: 'earner', person } }, env)
  if (Object.keys(t.fields).length) throw bad('Check the highlighted fields.', t.fields)
  if (raw.termsHash !== t.hash) throw refused('terms_changed', 'These are not the terms that were shown. Read the terms again and accept them as they are now; nothing was opened.')
  const acc = (raw.accept && typeof raw.accept === 'object' ? raw.accept : {}) as Raw
  const both = !isBusiness(db, ws)
  if (acc.earner !== true || (both && acc.client !== true)) {
    const ask = both ? 'Accept the terms as the earner and as the paper client: on paper you play the client too.' : 'Accept the terms as the earner.'
    throw bad(ask, { accept: ask })
  }
  const id = newId('job', now), termsId = newId('etm', now)
  const state = both ? 'funded' : 'proposed'
  db.tx(() => {
    db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES (?, ?, ?, ?, 'open', ?, ?)`, id, ws, t.terms.job.title, t.terms.job.client, now, canonical({ paperClient: true, termsId }))
    db.run('INSERT INTO earn_terms (id, user_id, job_id, milestone_id, version, terms_json, hash, proposed_by, proposed_at, person_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)', termsId, ws, id, TERMS_VERSION, t.json, t.hash, 'earner', now, person)
    db.run('INSERT INTO earn_terms_accepts (terms_id, side, person_id, at) VALUES (?, ?, ?, ?)', termsId, 'earner', person, now)
    if (both) db.run('INSERT INTO earn_terms_accepts (terms_id, side, person_id, at) VALUES (?, ?, ?, ?)', termsId, 'client', person, now)
    for (const ms of t.terms.milestones) {
      const mid = newId('mil', now)
      db.run(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, updated_at, terms_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, mid, id, ws, ms.title, ms.amount, state, now, termsId)
      if (both) step(db, { id: mid, user_id: ws }, 'client', 'opened', now, person, { amount: ms.amount, termsHash: t.hash })
    }
    audit(db, now, ws, 'owner', 'earn.paper.open', id, { termsHash: t.hash, state })
    emit(db, now, ws, 'earn', { jobId: id })
  })
  return { id, termsHash: t.hash, state }
}

/** In a business workspace, the paper client's member accepts a job's terms (by their fingerprint) and so puts its money in escrow. */
export function acceptJobTerms(ctx: Ctx, ws: string, jobId: string, raw: Raw): void {
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const ms = db.all<Ms>(`SELECT ${MS_COLS} FROM earn_milestones WHERE job_id = ? AND user_id = ? ORDER BY rowid`, jobId, ws)
    if (!ms.length || !ms[0]!.terms_id) throw notFound('That job')
    const b = termsRow(db, ws, ms[0]!.terms_id)
    if (raw.hash !== b.hash) throw refused('terms_changed', 'These are not the terms on record for this job. Read them again; nothing was accepted.')
    if (b.accepts.some((a) => a.side === 'client')) throw refused('wrong_state', 'The paper client has already accepted these terms.')
    const person = mustPlay(db, ws, 'client', b.terms)
    db.run('INSERT INTO earn_terms_accepts (terms_id, side, person_id, at) VALUES (?, ?, ?, ?)', b.id, 'client', person, now)
    for (const m of ms) {
      if (m.state !== 'proposed') continue
      move(db, m, 'funded', null, now)
      step(db, m, 'client', 'opened', now, person, { amount: m.amount, termsHash: b.hash })
    }
    emit(db, now, ws, 'earn', { jobId })
  })
}

// ------------------------------------------------------------------------------------------------ the steps

const reasonOf = (raw: Raw, ask: string): string => {
  const r = clean(raw.reason, 300)
  if (r.length < 5) throw bad(ask, { reason: ask })
  return r
}

function raise(db: Db, m: Ms, b: Bound, by: Side, against: 'work' | 'refund', reason: string, now: number, person: string): void {
  const evidenceDueAt = now + b.terms.evidence.ms, decideBy = now + b.terms.decision.ms
  db.run(`INSERT INTO earn_disputes (id, milestone_id, user_id, raised_by, against, reason, raised_at, evidence_due_at, decide_by, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`, newId('edp', now), m.id, m.user_id, by, against, reason, now, evidenceDueAt, decideBy)
  move(db, m, 'disputed', evidenceDueAt, now)
  step(db, m, by, 'disputed', now, person, { reason, against, evidenceDueAt, decideBy })
  notice(db, m.user_id, { level: 'action', kind: 'milestone-disputed', title: by === 'client' ? `The client disputes "${m.title}"` : `You dispute the client taking back "${m.title}"`,
    body: `${inrExact(m.amount)} stays locked in escrow until it is decided. ${by === 'client' ? 'The earner' : 'The client'} may answer with evidence until ${whenIst(evidenceDueAt)}; the simulated mediator decides by ${whenIst(decideBy)}. The accepted terms say what happens if either does not.`,
    subject: m.id, dedupe: `milestone:${m.id}` }, now)
}

/** The earner submits the work (server/owner.ts submitMilestone hands paper milestones here, with the evidence's fingerprint). */
export function submitPaper(db: Db, ws: string, id: string, evidenceHash: string, now: number): void {
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const person = mustPlay(db, ws, 'earner', s.b?.terms ?? null)
    must(s, now, 'earner', 'submit')
    const t = s.b?.terms
    // under accepted terms the review runs from this step; without terms nothing is scheduled
    const due = t ? now + t.review.ms : null
    const late = !!t && t.deliverBy !== null && now > t.deliverBy
    move(db, s.m, 'submitted', due, now, evidenceHash)
    step(db, s.m, 'earner', 'submitted', now, person, { evidenceHash, ...(due !== null ? { reviewUntil: due } : {}), ...(late ? { late: true, deliverBy: t!.deliverBy } : {}) })
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

/**
 * The paper client's step: accept (in the review, giving way in a dispute, or after a review that left the money locked),
 * dispute the submitted work with a reason, or take the money back. Under the terms a milestone was opened on before terms
 * were recorded, accept and take back act at once and a dispute only marks it, as they always did.
 */
export function clientPaper(ctx: Ctx, ws: string, id: string, decision: unknown, raw: Raw = {}): void {
  if (decision !== 'accept' && decision !== 'dispute' && decision !== 'refund') throw bad('The client\'s decision is accept, dispute or refund.')
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const person = mustPlay(db, ws, 'client', s.b?.terms ?? null)
    must(s, now, 'client', decision)
    const { m, b, d } = s
    if (decision === 'accept') {
      const giving = m.state === 'disputed'
      settle(db, m, b, d, { outcome: 'released', toEarner: m.amount, by: 'client', why: giving ? 'The client, played by you, released it after all.' : 'The client, played by you, accepted the work.' }, now)
      step(db, m, 'client', giving ? 'gave-way' : 'accepted', now, person, { toEarner: m.amount })
    } else if (decision === 'dispute') {
      const reason = b ? reasonOf(raw, 'Say what is wrong with the work, in a sentence.') : clean(raw.reason, 300)
      if (b) raise(db, m, b, 'client', 'work', reason, now, person)
      else {
        // the terms it was opened on: a dispute marks it, with no decider and no deadline
        move(db, m, 'disputed', null, now)
        step(db, m, 'client', 'disputed', now, person, { against: 'work', ...(reason ? { reason } : {}), noTerms: true })
      }
    } else if (b) {
      const due = now + b.terms.answer.ms
      move(db, m, 'refund-asked', due, now)
      step(db, m, 'client', 'asked-refund', now, person, { answerBy: due })
    } else {
      settle(db, m, null, d, { outcome: 'refunded', toEarner: 0, by: 'client', why: 'The client, played by you, took the money back, as the terms this job was opened on allowed at any time.' }, now)
      step(db, m, 'client', 'took-back', now, person, { toClient: m.amount })
    }
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

/** The earner's step: agree to the client taking the money back (or give way in a dispute), dispute it with a reason, or give the money back before submitting. */
export function earnerStep(ctx: Ctx, ws: string, id: string, what: unknown, raw: Raw = {}): void {
  if (what !== 'agree' && what !== 'dispute' && what !== 'give-back') throw bad('The earner\'s step is agree, dispute or give-back.')
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const person = mustPlay(db, ws, 'earner', s.b?.terms ?? null)
    must(s, now, 'earner', what)
    const { m, b, d } = s
    if (what === 'dispute') raise(db, m, b!, 'earner', 'refund', reasonOf(raw, 'Say what is wrong with taking the money back, in a sentence.'), now, person)
    else {
      const name = what === 'give-back' ? 'gave-back' : m.state === 'disputed' ? 'gave-way' : 'agreed'
      const why = name === 'gave-back' ? 'You gave the money back to the client before submitting the work.' : name === 'gave-way' ? 'You let the client have the money back, ending the dispute.' : 'You agreed to give the money back to the client.'
      settle(db, m, b, d, { outcome: 'refunded', toEarner: 0, by: 'earner', why }, now)
      step(db, m, 'earner', name, now, person, { toClient: m.amount })
    }
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

/** A statement of evidence in an open dispute, from the earner or the client, until the evidence closes: at most five a side. */
export function addEvidence(ctx: Ctx, ws: string, id: string, raw: Raw): void {
  const side = raw.side
  if (side !== 'earner' && side !== 'client') throw bad('Evidence comes from the earner or the client.')
  const said = text(raw.text)
  if (said.length < 3 || said.length > 600) throw bad('Write the evidence in 3 to 600 characters.', { text: 'Write the evidence in 3 to 600 characters.' })
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const person = mustPlay(db, ws, side, s.b?.terms ?? null)
    must(s, now, side, 'evidence')
    const { m, b, d } = s
    if (db.get<{ n: number }>(`SELECT COUNT(*) n FROM earn_steps WHERE milestone_id = ? AND step = 'evidence' AND actor = ?`, id, side)!.n >= 5) throw refused('evidence_limit', 'Each side may send 5 statements of evidence.')
    step(db, m, side, 'evidence', now, person, { text: said })
    // the side that did not raise it has answered: both are heard, and the mediator's deadline is the one that waits
    if (d!.heard_at === null && side !== d!.raised_by) {
      db.run('UPDATE earn_disputes SET heard_at = ? WHERE id = ? AND heard_at IS NULL', now, d!.id)
      db.run('UPDATE earn_milestones SET due_at = ?, updated_at = ? WHERE id = ?', d!.raised_at + b!.terms.decision.ms, now, id)
    }
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

/**
 * The simulated mediator's decision: released, refunded, or split in whole paise. It may do only what the accepted terms
 * let it, on this milestone's escrowed amount, and only once both sides are heard and before its deadline.
 */
export function decide(ctx: Ctx, ws: string, id: string, raw: Raw): void {
  const outcome = raw.outcome
  if (outcome !== 'released' && outcome !== 'refunded' && outcome !== 'split') throw bad('The decision is released, refunded or split.')
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const { m, b, d } = s
    const x = raw.earnerPaise
    if (outcome === 'split' && (!Number.isSafeInteger(x) || (x as number) < 1 || (x as number) > m.amount - 1)) throw bad('A split gives each side a part: the earner from 1 paisa to all but 1 paisa.', { earnerPaise: `From ₹0.01 to ${inrExact(m.amount - 1)}.` })
    if (!b) throw refused('no_terms', NO_TERMS)
    const person = mustPlay(db, ws, 'mediator', b.terms)
    must(s, now, 'mediator', 'decide')
    const power = outcome === 'released' ? 'release' : outcome === 'refunded' ? 'refund' : 'split'
    if (!b.terms.mediator.may.includes(power)) throw refused('not_permitted', 'The accepted terms do not let the mediator decide that.')
    const toEarner = outcome === 'released' ? m.amount : outcome === 'refunded' ? 0 : (x as number)
    settle(db, m, b, d, { outcome, toEarner, by: 'mediator', why: `Decided by the simulated mediator, played by you: ${outcomeWords(outcome, toEarner, m.amount - toEarner)}.` }, now)
    step(db, m, 'mediator', 'decided', now, person, { outcome, toEarner, toClient: m.amount - toEarner })
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

// ------------------------------------------------------------------------------------------------ settling by agreement

/** Steps that begin a phase: an offer made before the latest of them no longer stands. */
const PHASES = ['opened', 'submitted', 'asked-refund', 'disputed', 'terms-agreed']
/** The latest settlement each side has offered in the milestone's present phase. */
function offersOf(db: Db, m: Ms): Record<Side, { outcome: 'released' | 'refunded' | 'split'; toEarner: number; toClient: number; at: number } | null> {
  const since = db.get<{ id: number }>(`SELECT id FROM earn_steps WHERE milestone_id = ? AND step IN (${PHASES.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`, m.id, ...PHASES)?.id ?? 0
  const latest = (side: Side) => {
    const r = db.get<{ ts: number; detail_json: string }>(`SELECT ts, detail_json FROM earn_steps WHERE milestone_id = ? AND actor = ? AND step = 'offered-settlement' AND id > ? ORDER BY id DESC LIMIT 1`, m.id, side, since)
    if (!r) return null
    const o = parse<{ outcome: 'released' | 'refunded' | 'split'; toEarner: number; toClient: number }>(r.detail_json, { outcome: 'released', toEarner: 0, toClient: 0 })
    return { ...o, at: r.ts }
  }
  return { earner: latest('earner'), client: latest('client') }
}
/**
 * One side offers to settle the milestone (released, refunded, or a split in whole paise); when the other side has offered
 * exactly the same in this phase, it is settled at once. This is how money a timeout left locked is freed, and the two sides
 * may use it at any time; on paper the household offers for one side and accepts for the other, each recorded in its role.
 */
export function settleByAgreement(ctx: Ctx, ws: string, id: string, raw: Raw): { settled: boolean } {
  const side = raw.side, outcome = raw.outcome
  if (side !== 'earner' && side !== 'client') throw bad('A settlement is offered by the earner or the client.')
  if (outcome !== 'released' && outcome !== 'refunded' && outcome !== 'split') throw bad('A settlement releases, refunds or splits the milestone.')
  const { db } = ctx
  const now = ctx.clock.now()
  return db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const { m, b, d } = s
    const x = raw.earnerPaise
    if (outcome === 'split' && (!Number.isSafeInteger(x) || (x as number) < 1 || (x as number) > m.amount - 1)) throw bad('A split gives each side a part: the earner from 1 paisa to all but 1 paisa.', { earnerPaise: `From ₹0.01 to ${inrExact(m.amount - 1)}.` })
    const person = mustPlay(db, ws, side, b?.terms ?? null)
    must(s, now, side, 'settle')
    const toEarner = outcome === 'released' ? m.amount : outcome === 'refunded' ? 0 : (x as number)
    const theirs = offersOf(db, m)[side === 'earner' ? 'client' : 'earner']
    step(db, m, side, 'offered-settlement', now, person, { outcome, toEarner, toClient: m.amount - toEarner })
    const agreed = !!theirs && theirs.outcome === outcome && theirs.toEarner === toEarner
    if (agreed) {
      settle(db, m, b, d, { outcome, toEarner, by: 'agreement', why: `Both sides agreed: ${outcomeWords(outcome, toEarner, m.amount - toEarner)}.` }, now)
      step(db, m, side, 'settled-by-agreement', now, person, { outcome, toEarner, toClient: m.amount - toEarner })
    }
    emit(db, now, ws, 'earn', { milestoneId: id })
    return { settled: agreed }
  })
}

// ------------------------------------------------------------------------------------------------ agreeing terms for a milestone from before

interface Proposal { id: string; hash: string; terms: Terms; by: Side; at: number; decided: boolean }
/** The latest terms proposed for a milestone that had none, and whether they were accepted (bound). */
function proposalOf(db: Db, m: Ms): Proposal | null {
  const r = db.get<{ id: string; terms_json: string; hash: string; proposed_by: Side; proposed_at: number }>('SELECT id, terms_json, hash, proposed_by, proposed_at FROM earn_terms WHERE milestone_id = ? AND user_id = ? ORDER BY proposed_at DESC, rowid DESC LIMIT 1', m.id, m.user_id)
  if (!r || sha256hex(r.terms_json) !== r.hash) return null
  return { id: r.id, hash: r.hash, terms: JSON.parse(r.terms_json) as Terms, by: r.proposed_by, at: r.proposed_at, decided: m.terms_id === r.id }
}
/**
 * The complete terms one side would propose for a milestone opened before terms were recorded: the same choices as a new
 * job, for this milestone's amount alone. Refused for a milestone that has terms, is settled, or carries a dispute record
 * from an earlier draft of QED.
 */
function proposalTerms(db: Db, ws: string, m: Ms, raw: Raw, now: number, env: Env): { side: Side; person: string; t: ReturnType<typeof buildTerms> } {
  const side = raw.side
  if (side !== 'earner' && side !== 'client') throw bad('Terms are proposed by the earner or the client.')
  if (m.terms_id) throw refused('has_terms', 'This milestone already runs under accepted terms.')
  if (!OPEN.has(m.state)) throw refused('wrong_state', `"${m.title}" is ${FINAL.has(m.state) ? `settled, ${SETTLED[m.state]}` : 'not in escrow'}: there is nothing to agree terms for.`)
  if (m.state === 'disputed' && disputeOf(db, m.id)) throw refused('wrong_state', 'This dispute already has a record from an earlier draft of QED; settle it by agreement instead.')
  const person = mustPlay(db, ws, side, null)
  const job = db.get<{ title: string; client: string }>('SELECT title, client FROM earn_jobs WHERE id = ?', m.job_id)!
  const t = buildTerms(db, ws, raw, now, { job: { title: job.title, client: job.client }, milestones: [{ title: m.title, amount: m.amount }], proposer: { side, person } }, env)
  if (Object.keys(t.fields).length) throw bad('Check the highlighted fields.', t.fields)
  return { side, person, t }
}
/** The complete terms one side would propose for a milestone from before terms were recorded, and their fingerprint: nothing is recorded. */
export function previewProposal(db: Db, ws: string, id: string, raw: Raw, now: number, env: Env = process.env): { terms: Terms; hash: string } {
  const { t } = proposalTerms(db, ws, load(db, ws, id), raw, now, env)
  return { terms: t.terms, hash: t.hash }
}
/**
 * One side proposes complete terms for a milestone opened before terms were recorded, accepting them itself, by the
 * fingerprint of the terms it was shown (previewProposal), as a job is opened. Nothing changes until the other side
 * accepts them; a later proposal from either side replaces this one.
 */
export function proposeTerms(ctx: Ctx, ws: string, id: string, raw: Raw, env: Env = process.env): { termsId: string; hash: string; terms: Terms } {
  const { db } = ctx
  const now = ctx.clock.now()
  return db.tx(() => {
    const m = load(db, ws, id)
    const { side, person, t } = proposalTerms(db, ws, m, raw, now, env)
    if (raw.termsHash !== t.hash) throw refused('terms_changed', 'These are not the terms that were shown. Read them again and propose them as they are now; nothing was proposed.')
    const termsId = newId('etm', now)
    db.run('INSERT INTO earn_terms (id, user_id, job_id, milestone_id, version, terms_json, hash, proposed_by, proposed_at, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', termsId, ws, m.job_id, m.id, TERMS_VERSION, t.json, t.hash, side, now, person)
    db.run('INSERT INTO earn_terms_accepts (terms_id, side, person_id, at) VALUES (?, ?, ?, ?)', termsId, side, person, now)
    step(db, m, side, 'terms-proposed', now, person, { termsHash: t.hash })
    emit(db, now, ws, 'earn', { milestoneId: id })
    return { termsId, hash: t.hash, terms: t.terms }
  })
}

/**
 * The other side accepts the terms proposed for a milestone, by their fingerprint. They are bound to it for good and its
 * timers start now: a review of work submitted before starts at this acceptance, and a dispute from before is decided
 * under them from now. Nothing counts from before the agreement.
 */
export function acceptTerms(ctx: Ctx, ws: string, id: string, raw: Raw): void {
  const side = raw.side
  if (side !== 'earner' && side !== 'client') throw bad('Terms are accepted by the earner or the client.')
  const { db } = ctx
  const now = ctx.clock.now()
  db.tx(() => {
    const s = seen(db, load(db, ws, id))
    const { m, proposal: p } = s
    if (m.terms_id) throw refused('has_terms', 'This milestone already runs under accepted terms.')
    must(s, now, side, 'accept-terms')
    if (raw.hash !== p!.hash) throw refused('terms_changed', 'These are not the terms proposed now. Read them again; nothing was accepted.')
    const person = mustPlay(db, ws, side, p!.terms)
    db.run('INSERT INTO earn_terms_accepts (terms_id, side, person_id, at) VALUES (?, ?, ?, ?)', p!.id, side, person, now)
    if (db.run('UPDATE earn_milestones SET terms_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND terms_id IS NULL AND state = ?', p!.id, now, m.id, ws, m.state).changes !== 1) throw refused('changed', 'This milestone changed meanwhile. Nothing was accepted; read it again.')
    step(db, m, side, 'terms-agreed', now, person, { termsHash: p!.hash })
    const t = p!.terms
    if (m.state === 'submitted') db.run('UPDATE earn_milestones SET due_at = ? WHERE id = ?', now + t.review.ms, m.id)
    if (m.state === 'disputed') {
      // a dispute from before, decided under the agreed terms from now; the client had raised it
      const evidenceDueAt = now + t.evidence.ms, decideBy = now + t.decision.ms
      db.run(`INSERT INTO earn_disputes (id, milestone_id, user_id, raised_by, against, reason, raised_at, evidence_due_at, decide_by, state) VALUES (?, ?, ?, 'client', 'work', ?, ?, ?, ?, 'open')`, newId('edp', now), m.id, ws, 'Raised before terms were recorded; decided under the terms agreed later.', now, evidenceDueAt, decideBy)
      db.run('UPDATE earn_milestones SET due_at = ? WHERE id = ?', evidenceDueAt, m.id)
    }
    emit(db, now, ws, 'earn', { milestoneId: id })
  })
}

// ------------------------------------------------------------------------------------------------ the deadlines

/** Paper milestones whose cached deadline has come: read without a lock, so each is checked again, from its terms, when applied. */
export function dueMilestones(db: Db, now: number): { id: string; user_id: string }[] {
  return db.all<{ id: string; user_id: string }>(`SELECT id, user_id FROM earn_milestones WHERE due_at IS NOT NULL AND due_at <= ? AND terms_id IS NOT NULL AND state IN ('submitted', 'refund-asked', 'disputed') ORDER BY due_at LIMIT 200`, now)
}

/**
 * Apply a milestone's timeout outcome if, by its accepted terms and the step that started the period, it is due: in one
 * write transaction that reads it first. True when this call applied it (a settlement, or the money left locked), false
 * when there was nothing to do: another pass got there first, a side acted in time, nothing is due, or there are no
 * accepted terms (then nothing ever happens on its own).
 */
export function applyDue(db: Db, ws: string, id: string, now: number): boolean {
  const done = db.tx(() => applyDueIn(db, ws, id, now))
  // a page open on Earn reads the milestone again
  if (done) emit(db, now, ws, 'earn', { milestoneId: id })
  return done
}
function applyDueIn(db: Db, ws: string, id: string, now: number): boolean {
  const m = db.get<Ms>(`SELECT ${MS_COLS} FROM earn_milestones WHERE id = ? AND user_id = ?`, id, ws)
  if (!m || m.due_at === null || !OPEN.has(m.state)) return false
  const s = seen(db, m)
  const { b, d, dl } = s
  // scheduled actions run only under accepted terms, by the deadline those terms and the starting step give
  if (!b || b.agreedAt === null || !dl || dl.at > now) return false
  const o = b.terms[dl.period].onTimeout
  const at = dl.at
  const rule = ruleWords(dl.period, o)
  if (o.kind === 'locked') {
    move(db, m, m.state, null, now)
    step(db, m, 'rule', 'locked', now, null, { at, period: dl.period })
    notice(db, m.user_id, { level: 'info', kind: 'milestone-locked', title: `Locked in escrow: ${m.title}`, body: `${rule} Nothing more happens on its own: the two sides may settle it by agreement. Practice money, on paper.`, subject: m.id, dedupe: `escrow-locked:${m.id}:${at}` }, now)
    return true
  }
  // raiser: the side that raised the dispute has its way
  const kind = o.kind === 'raiser' ? (d?.raised_by === 'earner' ? 'release' : 'refund') : o.kind
  const parts = kind === 'release' ? { earner: m.amount, client: 0 } : kind === 'refund' ? { earner: 0, client: m.amount } : splitOf(m.amount, o.earnerPct!)
  const outcome: Settle['outcome'] = parts.client === 0 ? 'released' : parts.earner === 0 ? 'refunded' : 'split'
  const why = dl.period === 'review' ? `The client's review ended on ${whenIst(at)} with no answer, so, as the accepted terms say, ${outcomeWords(outcome, parts.earner, parts.client)}.`
    : dl.period === 'answer' ? `You did not answer the client taking the money back by ${whenIst(at)}, so, as the accepted terms say, ${outcomeWords(outcome, parts.earner, parts.client)}.`
    : dl.period === 'evidence' ? `${d?.raised_by === 'client' ? 'You' : 'The client, played by you,'} did not answer the dispute by ${whenIst(at)}, so, as the accepted terms say, ${outcomeWords(outcome, parts.earner, parts.client)}.`
    : `The mediator had not decided by ${whenIst(at)}, so, as the accepted terms say, ${outcomeWords(outcome, parts.earner, parts.client)}.`
  settle(db, m, b, d, { outcome, toEarner: parts.earner, by: 'rule', at, rule, why, period: dl.period }, now)
  // one name for every period's end: what it gave each side is in the detail, whatever the terms chose
  step(db, m, 'rule', 'timed-out', now, null, { at, period: dl.period, outcome, toEarner: parts.earner, toClient: parts.client })
  return true
}

const reported = new Set<string>()
/** One pass of the engine over the paper escrow's deadlines: each due default applied once. Returns how many were applied. */
export function escrowTick(ctx: Ctx): number {
  const now = ctx.clock.now()
  let n = 0
  for (const m of dueMilestones(ctx.db, now)) {
    try { if (applyDue(ctx.db, m.user_id, m.id, now)) n++ }
    catch (e) {
      // left as it was and tried again on the next pass; said once, not every second
      if (!reported.has(m.id)) { reported.add(m.id); try { emit(ctx.db, now, m.user_id, 'engine', { state: 'escrow-error', milestoneId: m.id, error: e instanceof Error ? e.message : String(e) }) } catch { /* nothing more can be recorded */ } }
    }
  }
  return n
}

// ------------------------------------------------------------------------------------------------ what the page reads

/**
 * Who acts next on a paper milestone, the step, its deadline, and what happens if nobody acts: `then` with the exact
 * amounts the terms give (the page puts the codes in words).
 */
export interface Next { actor: RoleName | 'rule' | 'both'; step: string; by: number | null; then: { kind: string; toEarner?: number; toClient?: number } }
function resolved(o: Outcome, amount: number, d: Dsp | undefined): Next['then'] {
  if (o.kind === 'locked') return { kind: 'locked' }
  const kind = o.kind === 'raiser' ? (d?.raised_by === 'earner' ? 'release' : 'refund') : o.kind
  if (kind === 'split') { const p = splitOf(amount, o.earnerPct!); return { kind: 'split', toEarner: p.earner, toClient: p.client } }
  return kind === 'release' ? { kind: 'release', toEarner: amount, toClient: 0 } : { kind: 'refund', toEarner: 0, toClient: amount }
}
function nextOf(s: Seen, now: number): Next | null {
  const { m, b, d, dl } = s
  if (FINAL.has(m.state)) return null
  if (!b) return { actor: 'both', step: s.proposal && !s.proposal.decided ? 'accept-terms' : 'agree-terms', by: null, then: { kind: 'nothing' } }
  if (m.state === 'proposed') return { actor: 'client', step: 'accept-job-terms', by: null, then: { kind: 'not-funded' } }
  const t = b.terms
  if (m.state === 'funded') {
    if (t.deliverBy === null) return { actor: 'earner', step: 'submit', by: null, then: { kind: 'stays' } }
    return now <= t.deliverBy ? { actor: 'earner', step: 'submit', by: t.deliverBy, then: { kind: 'client-may-take' } } : { actor: 'earner', step: 'submit-late', by: t.deliverBy, then: { kind: 'client-may-take-now' } }
  }
  if (!dl) return null
  if (lockedAt(b, dl, now)) return { actor: 'both', step: 'agree-outcome', by: null, then: { kind: 'locked' } }
  const then = resolved(t[dl.period].onTimeout, m.amount, d)
  // due and not yet applied: the escrow's own step, named by the period that ended (what it gives is in then)
  if (now >= dl.at) return { actor: 'rule', step: `${dl.period}-ended`, by: dl.at, then }
  if (dl.period === 'review') return { actor: 'client', step: 'review', by: dl.at, then }
  if (dl.period === 'answer') return { actor: 'earner', step: 'answer-refund', by: dl.at, then }
  if (dl.period === 'evidence') return { actor: d!.raised_by === 'client' ? 'earner' : 'client', step: 'answer-dispute', by: dl.at, then }
  return { actor: 'mediator', step: 'decide', by: dl.at, then }
}

/** Which roles the signed-in member plays on terms (in a personal workspace the household plays all three). */
function yourRoles(db: Db, ws: string, terms: Terms | null): RoleName[] {
  const person = acting(db, ws)
  if (!isBusiness(db, ws)) return person === ws ? ['earner', 'client', 'mediator'] : []
  if (!person) return []
  if (!terms) return (['earner', 'client', 'mediator'] as RoleName[]).filter((r) => mayPlay(db, ws, person, r))
  return (['earner', 'client', 'mediator'] as RoleName[]).filter((r) => terms.roles[r] === person)
}
const termsView = (db: Db, b: Bound) => ({
  id: b.id, hash: b.hash, version: b.terms.version, terms: b.terms, agreedAt: b.agreedAt,
  accepts: b.accepts.map((a) => ({ side: a.side, at: a.at, name: a.person ? nameOf(db, a.person) : null })),
  roleNames: { earner: nameOf(db, b.terms.roles.earner), client: nameOf(db, b.terms.roles.client), mediator: nameOf(db, b.terms.roles.mediator) },
})

/** What the escrow paid the earner for a milestone: the bank posting of its one entry (reference earn:<milestone>), or nothing. */
function paidOf(db: Db, m: Ms): number {
  const r = db.get<{ t: string | null }>(`SELECT amount_sum(p.amount_text) t FROM entries e JOIN postings p ON p.entry_id = e.id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND e.ref = ? AND a.code = 'bank'`, m.user_id, `earn:${m.id}`)
  return r?.t ? Number(r.t) : 0
}

function milestoneView(db: Db, m: Ms, now: number): Raw {
  let s: Seen
  try { s = seen(db, m) } catch (e) {
    // terms that do not match their fingerprint: shown as such, and nothing is offered or scheduled
    return { id: m.id, title: m.title, amount: m.amount, state: m.state, evidence_hash: m.evidence_hash, updated_at: m.updated_at, dueAt: null, paid: 0, back: 0, terms: null, legacy: false, problem: e instanceof Error ? e.message : String(e), dispute: null, steps: [], next: null, can: { earner: [], client: [], mediator: [] }, offers: { earner: null, client: null }, proposal: null, you: [] }
  }
  const { b } = s
  // a dispute is shown after it is decided too; and what a settled milestone paid is what the ledger holds for it, so the
  // page's figures are the books' own (a split by agreement has no dispute to read them from)
  const d = disputeOf(db, m.id)
  const paid = FINAL.has(m.state) ? paidOf(db, m) : 0
  const back = FINAL.has(m.state) ? m.amount - paid : 0
  return {
    id: m.id, title: m.title, amount: m.amount, state: m.state, evidence_hash: m.evidence_hash, updated_at: m.updated_at, paid, back,
    // the deadline a person reads is the one the terms and the starting step give, never the cache
    dueAt: s.dl?.at ?? null,
    // the terms in full, as the job's are: a milestone that agreed terms later has its own, and its job none
    terms: b ? termsView(db, b) : null, legacy: !b, problem: null,
    proposal: s.proposal && !s.proposal.decided ? { termsId: s.proposal.id, hash: s.proposal.hash, terms: s.proposal.terms, by: s.proposal.by, at: s.proposal.at } : null,
    dispute: d ? { raisedBy: d.raised_by, against: d.against, reason: d.reason, raisedAt: d.raised_at, evidenceDueAt: b ? d.raised_at + b.terms.evidence.ms : d.evidence_due_at, decideBy: b ? d.raised_at + b.terms.decision.ms : d.decide_by, heardAt: d.heard_at, state: d.state, outcome: d.outcome, toEarner: d.earner_paise, toClient: d.client_paise, decidedBy: d.decided_by, decidedAt: d.decided_at } : null,
    steps: db.all<{ ts: number; actor: string; step: string; person_id: string | null; detail_json: string }>('SELECT ts, actor, step, person_id, detail_json FROM earn_steps WHERE milestone_id = ? ORDER BY id', m.id)
      .map((x) => ({ ts: x.ts, actor: x.actor, step: x.step, person: x.person_id && isBusiness(db, m.user_id) ? nameOf(db, x.person_id) : null, detail: parse<Raw>(x.detail_json, {}) })),
    next: nextOf(s, now), can: can(s, now), offers: offersOf(db, m), you: yourRoles(db, m.user_id, b?.terms ?? s.proposal?.terms ?? null),
  }
}

/** GET /api/earn: the policies a job chooses from; every job and milestone; each paper job's accepted terms; each paper milestone with its deadline, dispute, steps, who acts next and the moves open now. */
export function paperView(db: Db, ws: string, now: number): Raw {
  const jobs = db.all<{ id: string; title: string; client: string; state: string; created_at: number; meta_json: string }>('SELECT id, title, client, state, created_at, meta_json FROM earn_jobs WHERE user_id = ? ORDER BY created_at DESC', ws)
  const business = isBusiness(db, ws)
  return {
    policy: POLICY,
    business,
    // in a business workspace, the members who may play each role (the form chooses the client's and the mediator's)
    members: business ? db.all<{ personId: string; name: string; role: Role }>('SELECT m.person_id personId, u.display_name name, m.role FROM memberships m JOIN users u ON u.id = m.person_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at', ws) : [],
    you: acting(db, ws),
    jobs: jobs.map((jb) => {
      const rows = db.all<Ms>(`SELECT ${MS_COLS} FROM earn_milestones WHERE job_id = ? ORDER BY rowid`, jb.id)
      const chain = rows.some((m) => m.state.startsWith('chain-'))
      const jobTerms = (() => { if (chain) return null; const tid = parse<{ termsId?: string }>(jb.meta_json, {}).termsId; if (!tid) return null; try { return termsView(db, termsRow(db, ws, tid)) } catch { return null } })()
      return {
        id: jb.id, title: jb.title, client: jb.client, state: jb.state, created_at: jb.created_at, ...(chain ? {} : { terms: jobTerms }),
        milestones: rows.map((m) => (m.state.startsWith('chain-') ? { id: m.id, title: m.title, amount: m.amount, state: m.state, evidence_hash: m.evidence_hash, updated_at: m.updated_at } : milestoneView(db, m, now))),
      }
    }),
  }
}

/** What a paper milestone needs from the household (Home's "Needs you"): each item with its deadline and what happens without an answer. */
export function escrowNeeds(db: Db, ws: string, now: number): Raw[] {
  const out: Raw[] = []
  for (const m of db.all<Ms>(`SELECT ${MS_COLS} FROM earn_milestones WHERE user_id = ? AND state IN ('refund-asked', 'disputed', 'submitted') ORDER BY due_at`, ws)) {
    let s: Seen
    try { s = seen(db, m) } catch { continue }
    const n = nextOf(s, now)
    if (!n) continue
    const words = (t: Next['then']): string => t.kind === 'release' ? 'it is released to you' : t.kind === 'refund' ? 'it goes back to the client' : t.kind === 'split' ? `it is split: ${inrExact(t.toEarner!)} to you and ${inrExact(t.toClient!)} to the client` : 'it stays locked in escrow until both sides agree'
    if (n.actor === 'both' && n.then.kind === 'locked') out.push({ type: 'milestone-locked', milestoneId: m.id, title: `Locked in escrow: ${m.title}`, detail: `${inrExact(m.amount)} stays in escrow: a deadline ran out and the accepted terms keep it locked.`, deadline: null, ifNothing: 'Nothing happens on its own until both sides agree how to settle it.' })
    else if (m.state === 'refund-asked' && n.actor === 'earner') out.push({ type: 'milestone-refund', milestoneId: m.id, title: `The client asked for the money for ${m.title} back`, detail: `${inrExact(m.amount)} goes back to the client unless you dispute it. On paper you play the client too.`, deadline: n.by, ifNothing: `If you do nothing by then, ${words(n.then)}.` })
    else if (m.state === 'disputed' && s.d && s.d.state === 'open' && n.actor !== 'rule') {
      const said = s.d.raised_by === 'earner' ? 'You dispute the client taking the money back' : 'The client disputes the work'
      const who = n.actor === 'mediator' ? 'If the simulated mediator, played by you, has not decided by then' : n.actor === 'earner' ? 'If you do not answer with evidence by then' : 'If the client, played by you, does not answer by then'
      out.push({ type: 'milestone-disputed', milestoneId: m.id, title: `Disputed: ${m.title}`, detail: `${said}: “${/[.!?]$/.test(s.d.reason) ? s.d.reason : `${s.d.reason}.`}” ${inrExact(m.amount)} stays locked in escrow until it is decided.`, deadline: n.by, ifNothing: `${who}, ${words(n.then)}.` })
    }
  }
  return out
}
