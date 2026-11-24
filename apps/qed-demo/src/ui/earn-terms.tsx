/**
 * The terms of paper escrow, on Earn (R13 section 2; the server is server/escrow.ts). Choosing them, each policy a choice
 * within its stated bounds with the reason and source of its default one press away; reading them complete, in words,
 * with their fingerprint, before anything is committed; and accepting them for both sides, which on paper the household
 * plays, by that fingerprint. The same parts serve a new job and a milestone from before terms were recorded, whose two
 * sides agree terms later. It imports nothing from the Earn screen, which imports it.
 */
import { useEffect, useId, useState } from 'react'
import { api, fmt } from '../lib/core.ts'
import { nearDay } from '../lib/words.ts'
import { Field } from './kit.tsx'

export type OutcomeKind = 'release' | 'refund' | 'split' | 'locked' | 'raiser'
export interface Outcome { kind: OutcomeKind; earnerPct?: number }
export type Period = 'review' | 'answer' | 'evidence' | 'decision'
export const PERIODS: readonly Period[] = ['review', 'answer', 'evidence', 'decision']
export interface PolicySpec { label: string; days: { default: number; min: number; max: number }; outcomes: OutcomeKind[]; onTimeout: Outcome; why: string; timeoutWhy: string; source: string }
export type Policy = Record<Period, PolicySpec>
/** The terms as the server stores and hashes them (server/escrow.ts Terms). */
export interface TermsDoc {
  version: 2; job: { title: string; client: string }; milestones: { title: string; amount: number }[]; deliverBy: number | null
  review: { ms: number; onTimeout: Outcome }; answer: { ms: number; onTimeout: Outcome }; evidence: { ms: number; onTimeout: Outcome }; decision: { ms: number; onTimeout: Outcome }
  mediator: { simulated: true; may: string[] }; roles: { earner: string; client: string; mediator: string }; rounding: string; test?: true
}
/** A job's accepted terms as GET /api/earn gives them. */
export interface TermsView { id: string; hash: string; version: number; terms: TermsDoc; agreedAt: number | null; accepts: { side: 'earner' | 'client'; at: number; name: string | null }[]; roleNames: { earner: string; client: string; mediator: string } }

const DAY = 86_400_000
/** A moment in a sentence, near days by name, in India time: "today, 17:43", "Fri 27 Nov, 17:43". */
export const momentWords = (ms: number, now: number): string => { const d = nearDay(ms, now); return `${/^(Today|Tomorrow|Yesterday)$/.test(d) ? d.toLowerCase() : d}, ${fmt.time(ms)}` }
/** In a split the client's part is rounded down to the paisa and the earner receives the rest (server/escrow.ts splitOf). */
export function splitOf(amount: number, earnerPct: number): { earner: number; client: number } {
  const client = Number((BigInt(amount) * BigInt(100 - earnerPct)) / 100n)
  return { earner: amount - client, client }
}
/** A period in words: "7 days", "1 day", or on a test stack "8 seconds". */
export const periodWords = (ms: number): string => (ms % DAY === 0 ? `${ms / DAY} day${ms === DAY ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`)

/** What an outcome does, in a sentence's words; with an amount, a split's two parts in exact paise. */
export function outcomeWords(o: Outcome, amount?: number): string {
  switch (o.kind) {
    case 'release': return 'it is released to you'
    case 'refund': return 'it goes back to the client'
    case 'locked': return 'it stays locked in escrow until both sides agree'
    case 'raiser': return 'the side that raised the dispute has its way'
    case 'split': {
      const pct = o.earnerPct ?? 50
      if (amount === undefined) return `it is split, ${pct}% to you and the rest to the client`
      const p = splitOf(amount, pct)
      return `it is split, ${pct}% to you: ${fmt.inr(p.earner, true)} to you and ${fmt.inr(p.client, true)} to the client`
    }
  }
}
/** The question each period's timeout answers, for the chooser. */
const ASKS: Record<Period, string> = {
  review: 'If the client neither accepts nor disputes by then',
  answer: 'If you neither agree nor dispute by then',
  evidence: 'If the other side sends no evidence by then',
  decision: 'If the mediator has not decided by then',
}
const OPTION: Record<OutcomeKind, string> = { release: 'It is released to you', refund: 'It goes back to the client', split: 'It is split: a share you state', locked: 'It stays locked until both sides agree', raiser: 'The side that raised the dispute has its way' }
const FROM: Record<Period, string> = { review: 'from each submission of the work', answer: 'from the client asking for the money back', evidence: 'from the dispute, for each side', decision: 'from the dispute' }

/**
 * The complete terms in words, as rows: what each period is, when it starts, and what happens when it runs out; the
 * delivery date; who decides a dispute, its powers and its limits; who plays each role; how a split is rounded; the
 * milestones. The same rows before commitment and on the job.
 */
export function termsLines(t: TermsDoc, now: number, roleNames: { earner: string; client: string; mediator: string } | null): { key: string; label: string; value: string }[] {
  const amount = t.milestones.length === 1 ? t.milestones[0]!.amount : undefined
  const rows: { key: string; label: string; value: string }[] = [
    { key: 'milestones', label: t.milestones.length === 1 ? 'The milestone' : 'The milestones', value: t.milestones.map((m) => `${m.title}, ${fmt.inr(m.amount, true)}`).join('; ') },
    { key: 'delivery', label: 'Delivery', value: t.deliverBy === null ? 'No delivery date. Until work is submitted, the client may ask for the money back at any time; you then have the answer period below.' : `By ${momentWords(t.deliverBy, now)}. Before then only you can give the money back; after it, with no work submitted, the client may ask for it back.` },
  ]
  for (const p of PERIODS) {
    const x = t[p]
    rows.push({ key: p, label: LABEL[p], value: `${periodWords(x.ms)}, ${FROM[p]}. ${ASKS[p]}: ${outcomeWords(x.onTimeout, amount)}.` })
  }
  rows.push(
    { key: 'mediator', label: 'Who decides a dispute', value: `A simulated mediator, played by ${roleNames ? roleNames.mediator : 'you'}. Once both sides are heard it may release the disputed milestone, refund it, or split it in whole paise: only as these terms allow, and no other money. It is not an arbitrator, a court or a regulated dispute service, and its decision binds no one outside this practice build.` },
    { key: 'roles', label: 'Who plays each part', value: roleNames ? `The earner: ${roleNames.earner}. The paper client: ${roleNames.client}. The mediator: ${roleNames.mediator}. Each step is taken only by its member.` : 'You play the earner, the paper client and the mediator. Each step records the part it was taken in.' },
    { key: 'rounding', label: 'Rounding', value: 'In any split the client\'s part is rounded down to the paisa and you receive the rest, so the two always add up to the milestone.' },
  )
  if (t.test) rows.push({ key: 'test', label: 'Test mode', value: 'Some periods are in seconds: allowed on an isolated test stack only.' })
  return rows
}
const LABEL: Record<Period, string> = { review: 'The client\'s review', answer: 'Your answer to a refund request', evidence: 'Evidence in a dispute', decision: 'The decision' }

/** The complete terms as a list, with their fingerprint one press away. */
export function TermsList({ terms, hash, now, roleNames, accepts }: { terms: TermsDoc; hash: string; now: number; roleNames: { earner: string; client: string; mediator: string } | null; accepts?: TermsView['accepts'] }) {
  return (
    <div className="er-terms">
      <dl className="er-terms-list">
        {termsLines(terms, now, roleNames).map((r) => <div key={r.key}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
        {accepts?.length ? <div><dt>Accepted</dt><dd>{accepts.map((a) => `${a.side === 'earner' ? 'As the earner' : 'As the paper client'}${a.name ? ` by ${a.name}` : ''}, ${fmt.dayTime(a.at)}`).join('; ')}.</dd></div> : null}
      </dl>
      <details className="er-tech small"><summary>Fingerprint of these terms</summary><p>SHA-256 of the terms exactly as shown, version {terms.version}: <span className="code">{hash}</span>. Every deadline and every outcome on this work is worked out from them.</p></details>
    </div>
  )
}

/** The choices a job makes: each period, what happens when it runs out, a delivery date, and in a business who plays each part. */
export interface Choice { days: Record<Period, number>; onTimeout: Record<Period, Outcome>; deliverBy: string; roles: { earner: string; client: string; mediator: string } }
export const defaultChoice = (policy: Policy): Choice => ({
  days: { review: policy.review.days.default, answer: policy.answer.days.default, evidence: policy.evidence.days.default, decision: policy.decision.days.default },
  onTimeout: { review: { ...policy.review.onTimeout }, answer: { ...policy.answer.onTimeout }, evidence: { ...policy.evidence.onTimeout }, decision: { ...policy.decision.onTimeout } },
  deliverBy: '', roles: { earner: '', client: '', mediator: '' },
})
/** The request fields a choice makes (server/escrow.ts buildTerms). */
export const choiceFields = (c: Choice, business: boolean, delivery = true): Record<string, unknown> => ({
  reviewDays: c.days.review, answerDays: c.days.answer, evidenceDays: c.days.evidence, decisionDays: c.days.decision, onTimeout: c.onTimeout,
  ...(delivery && c.deliverBy ? { deliverBy: c.deliverBy } : {}), ...(business ? { roles: c.roles } : {}),
})
const istDay = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10)

/** The parts of a paper job, as a form names them. */
const PART_LABEL: Record<'earner' | 'client' | 'mediator', string> = { earner: 'The earner', client: 'The paper client', mediator: 'The simulated mediator' }
/**
 * The terms' choices. Each period is a choice within its stated bounds, and what happens when it runs out is one of the
 * stated options; the usual choice is marked, and why it is usual, and where that comes from, is one press away. A split's
 * share is in whole per cent. `members`: in a business, who may play the two parts the proposer does not (`pick`).
 */
export function TermsChooser({ policy, value, onChange, errors, delivery = true, members, pick = ['client', 'mediator'] }: { policy: Policy; value: Choice; onChange: (c: Choice) => void; errors: Record<string, string>; delivery?: boolean; members?: { personId: string; name: string; role: string }[]; pick?: ('earner' | 'client' | 'mediator')[] }) {
  const set = (p: Partial<Choice>) => onChange({ ...value, ...p })
  return (
    <div className="er-choose">
      {delivery ? (
        <Field label="Deliver the work by (optional)" hint="Without work by the end of that day, the client may ask for the money back. Before it, only you can give it back." error={errors.deliverBy}>
          {(p) => <input {...p} className="input" type="date" min={istDay(Date.now())} value={value.deliverBy} onChange={(e) => set({ deliverBy: e.target.value })} />}
        </Field>
      ) : null}
      {PERIODS.map((k) => {
        const spec = policy[k], o = value.onTimeout[k]
        return (
          <fieldset className="er-pol" key={k}>
            <legend className="legend">{spec.label}</legend>
            <div className="er-pol-row">
              <Field label="How long" error={errors[`${k}Days`]}>
                {(p) => <select {...p} className="input" value={value.days[k]} onChange={(e) => set({ days: { ...value.days, [k]: Number(e.target.value) } })}>
                  {Array.from({ length: spec.days.max - spec.days.min + 1 }, (_, i) => spec.days.min + i).map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}{d === spec.days.default ? ', the usual' : ''}</option>)}
                </select>}
              </Field>
              <Field label={ASKS[k]} error={errors[`${k}OnTimeout`]}>
                {(p) => <select {...p} className="input" value={o.kind} onChange={(e) => { const kind = e.target.value as OutcomeKind; set({ onTimeout: { ...value.onTimeout, [k]: kind === 'split' ? { kind, earnerPct: o.earnerPct ?? 50 } : { kind } } }) }}>
                  {spec.outcomes.map((x) => <option key={x} value={x}>{OPTION[x]}{x === spec.onTimeout.kind ? ', the usual' : ''}</option>)}
                </select>}
              </Field>
              {o.kind === 'split' ? (
                <Field label="Your share, per cent" hint="1 to 99. The client's part is rounded down to the paisa.">
                  {(p) => <input {...p} className="input" type="number" inputMode="numeric" min={1} max={99} value={o.earnerPct ?? 50} onChange={(e) => set({ onTimeout: { ...value.onTimeout, [k]: { kind: 'split', earnerPct: Math.round(Number(e.target.value)) } } })} />}
                </Field>
              ) : null}
            </div>
            <details className="er-why small">
              <summary>Why {spec.days.default} days and “{OPTION[spec.onTimeout.kind].toLowerCase()}” are the usual choice</summary>
              <p>{spec.why}</p><p>{spec.timeoutWhy}</p><p className="faint">Source: {spec.source}</p>
            </details>
          </fieldset>
        )
      })}
      {members ? (
        <fieldset className="er-pol">
          <legend className="legend">Who plays each part</legend>
          <p className="small faint">You play {pick.includes('earner') ? 'the paper client' : 'the earner'}. Two other members play {pick.map((r) => PART_LABEL[r].toLowerCase()).join(' and ')}: the earner may be an operator or above, the client and the mediator must be able to approve. Each step is taken only by its member.</p>
          <div className="er-pol-row">
            {pick.map((r) => (
              <Field key={r} label={PART_LABEL[r]} error={errors[`role_${r}`] ?? errors.roles}>
                {(p) => <select {...p} className="input" value={value.roles[r]} onChange={(e) => set({ roles: { ...value.roles, [r]: e.target.value } })}>
                  <option value="">Choose a member</option>
                  {members.filter((m) => m.role === 'owner' || m.role === 'admin' || m.role === 'approver' || (r === 'earner' && m.role === 'operator')).map((m) => <option key={m.personId} value={m.personId}>{m.name}</option>)}
                </select>}
              </Field>
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  )
}

/**
 * Accepting terms: the complete terms, read from the server with their fingerprint for exactly these choices, then the
 * acceptance in each part the household plays, then the button. Changing a choice reads the terms again, and nothing can
 * be accepted until they are read: what is accepted is what was shown.
 */
export function useTermsPreview(path: string, body: Record<string, unknown> | null): { read: { terms: TermsDoc; hash: string } | null; error: { message: string; fields: Record<string, string> } | null; reading: boolean } {
  const key = body ? JSON.stringify(body) : ''
  const [state, setState] = useState<{ key: string; read: { terms: TermsDoc; hash: string } | null; error: { message: string; fields: Record<string, string> } | null }>({ key: '', read: null, error: null })
  useEffect(() => {
    if (!body) return undefined
    let live = true
    const t = setTimeout(() => {
      api<{ terms: TermsDoc; hash: string }>('POST', path, body).then((r) => { if (live) setState({ key, read: r, error: null }) }, (e: { message?: string; fields?: Record<string, string> }) => { if (live) setState({ key, read: null, error: { message: e?.message ?? 'The terms could not be read.', fields: e?.fields ?? {} } }) })
    }, 250)
    return () => { live = false; clearTimeout(t) }
    // the body is compared by its JSON (key)
  }, [path, key])
  const current = state.key === key
  return { read: current ? state.read : null, error: current ? state.error : null, reading: !!body && !current }
}

/**
 * The acceptances given, one for each side the person plays, each saying what it accepts. Until the terms are read
 * (`waiting`) there is nothing to accept, and the boxes say so.
 */
export function Acceptances({ sides, value, onChange, error, waiting }: { sides: ('earner' | 'client')[]; value: Record<'earner' | 'client', boolean>; onChange: (v: Record<'earner' | 'client', boolean>) => void; error?: string | undefined; waiting?: boolean }) {
  const id = useId()
  const said = [waiting ? `${id}-w` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ')
  return (
    <fieldset className="er-accept" aria-describedby={said || undefined}>
      <legend className="legend">Accepting these terms</legend>
      {sides.map((s) => (
        <label key={s} className="er-accept-row">
          <input type="checkbox" checked={value[s]} disabled={waiting} onChange={(e) => onChange({ ...value, [s]: e.target.checked })} />
          <span>{s === 'earner' ? 'As the earner, I accept these terms.' : 'As the paper client, which on paper I play too, I accept these terms.'}</span>
        </label>
      ))}
      {waiting ? <span className="small faint" id={`${id}-w`}>The terms are shown in full above first: then they can be accepted.</span> : null}
      {error ? <span className="err small" id={`${id}-e`}>{error}</span> : null}
    </fieldset>
  )
}
