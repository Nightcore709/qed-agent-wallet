/**
 * A savings goal, as Save lists it and as its instruction's record shows it (R12 task comparison, gap 5; T3-a to T3-d).
 *
 * One figure leads: what is set aside. Under it the goal at true scale on the money bar (DESIGN.md M14): set aside, the
 * contributions still scheduled, and what would be short on the date. Then the monthly figure QED worked out, when it
 * next moves, and the rule "on track" follows, in the words the server writes. When the goal is behind, the remedies come
 * as figures, each one press from being done: more a month or a later date (the goal signed again, the passkey signing
 * the new document), or a sum now (a payment by hand into the set-aside, approved with the passkey). When it is reached,
 * its date has passed or it was stopped, what happens to the money is said, with releasing it (the passkey again).
 *
 * Every figure is the server's (server/goals.ts); nothing is worked out here. The approval sheets are UX only: what
 * authorises is the server's check of the passkey's signature over each document's fingerprint.
 */
import { useId, useState } from 'react'
import { api, fmt, navigate } from '../lib/core.ts'
import { withPasskeyIfAsked } from '../lib/stepup.ts'
import type { ActionPreview, GoalView } from '../lib/types.ts'
import { ActionDoc, ApprovalSheet, type AuthDoc, InstrumentDoc, type PendingApproval } from './instrument.tsx'
import { Btn, Field, Link, MoneyBar, MoneyInput, Problem, Sheet, Stamp, useAction, useSession } from './kit.tsx'

const STAMP: Record<GoalView['status'], [string, 'ok' | 'wait' | 'plain']> = {
  'on-track': ['On track', 'ok'], behind: ['Behind', 'wait'], reached: ['Reached', 'ok'], 'date-passed': ['Its date has passed', 'plain'], stopped: ['Stopped', 'plain'], draft: ['Not signed yet', 'plain'],
}
const MODE: Record<string, string> = { approve: 'it asks you first', notify: 'it tells you first', auto: 'on its own' }
const ordinal = (d: number): string => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`
const day = (iso: string): string => fmt.isoDay(iso)
/** A sum in words: whole rupees, or to the paisa when it has paise (never "₹12,000.00"). */
const rs = (paise: number): string => fmt.money(paise, paise % 100 !== 0)

/** A sum with its paise set smaller (Home's way of writing the figure a person reads first). */
function Sum({ paise }: { paise: number }) {
  const s = fmt.money(paise, true), dot = s.lastIndexOf('.')
  return dot < 0 ? <>{s}</> : <>{s.slice(0, dot)}<span className="paise">{s.slice(dot)}</span></>
}

type Pending =
  | { kind: 'sign'; approval: PendingApproval; doc: AuthDoc; version: number; said: string }
  | { kind: 'now'; approval: PendingApproval; preview: ActionPreview; amount: number }
  | { kind: 'release'; approval: PendingApproval; preview: { summary: string; lines: ActionPreview['lines']; document: string; amount: number } }

/** The goal at true scale: set aside, still to come, and short; its label says every part with its figure. */
function GoalBar({ g }: { g: GoalView }) {
  const held = g.setAside + g.onItsWay
  const live = g.status === 'on-track' || g.status === 'behind' || g.status === 'draft'
  const coming = live ? g.scheduled.amount + g.growth : 0
  const short = g.status === 'reached' ? 0 : g.shortfall
  const label = g.status === 'reached'
    ? `${rs(held)} set aside, the whole of ${rs(g.target)}.`
    : `${held ? `${rs(held)} set aside` : 'Nothing set aside yet'}${coming ? `${held ? ' and' : ','} ${rs(coming)} still to come` : ''}: ${rs(g.projected)} by ${day(g.date)}${short ? `, ${rs(short)} short of ${rs(g.target)}` : `, the whole of ${rs(g.target)}`}.`
  return (
    <MoneyBar className="sv-goal-bar" label={label} parts={[{ tone: 'kept', value: held }, { tone: 'pay', value: coming }, { tone: 'short', value: short }]} keys={[
      { tone: 'kept', text: <>Set aside <b>{rs(held)}</b></> },
      ...(coming > 0 ? [{ tone: 'pay' as const, text: <>{g.growth > 0 ? 'Still to come, with the growth you assume' : 'Still scheduled'} <b>{rs(coming)}</b></> }] : []),
      ...(short > 0 ? [{ tone: 'short' as const, text: <>Short on {day(g.date)} <b>{rs(short)}</b></> }] : []),
    ]} />
  )
}

export function GoalCard({ g, onChanged, onRecord = false }: { g: GoalView; onChanged: () => void; onRecord?: boolean }) {
  const { session } = useSession()
  const hid = useId(), fixId = useId()
  const [pending, setPending] = useState<Pending | null>(null)
  const [releasing, setReleasing] = useState<number | null>(null)
  const [said, setSaid] = useState('')
  const held = g.setAside + g.onItsWay
  const r = g.remedies
  const inForce = g.state === 'active' || g.state === 'paused'
  const [stampWord, stampTone] = g.status === 'behind' && g.paused ? ['Paused, and behind', 'wait' as const] : g.status === 'stopped' && g.state !== 'revoked' ? ['Ended', 'plain' as const] : STAMP[g.status]

  // more a month, or a later date: the goal signed again; the server works out the monthly figure from what is set aside
  const resign = useAction(async (date?: string) => {
    setSaid('')
    const params = { name: g.name, target: g.target, date: date ?? g.date, schedule: { type: 'monthly', day: g.day, at: '10:00' }, growthBps: g.growthBps, ...(date ? { amount: g.monthly } : {}) }
    const authority = { runMode: g.runMode ?? 'approve', ...(g.runMode === 'notify' ? { noticeSec: g.noticeSec } : {}) }
    const saved = await api<{ programId: string; contradictions: { id: string; text: string }[] }>('POST', `/api/programs/${g.id}/draft`, { params, authority })
    // a contradiction is the owner's to accept, on the instruction's own page; it is never accepted for them here
    if (saved.contradictions.length) { navigate(`/instructions/${g.id}`); return }
    const a = await api<PendingApproval & { doc: AuthDoc; version: number }>('POST', `/api/programs/${g.id}/approval`, {})
    setPending({ kind: 'sign', approval: a, doc: a.doc, version: a.version, said: date ? `Signed: ${g.name} by ${day(date)}.` : 'Signed: the new monthly figure is in force.' })
  })
  const topUp = useAction(async (amount: number) => {
    setSaid('')
    const pv = await api<PendingApproval & ActionPreview>('POST', '/api/actions/preview', { kind: 'payment', purpose: 'goal', goalId: g.id, amount })
    setPending({ kind: 'now', approval: pv, preview: pv, amount })
  })
  const prepare = useAction(async () => {
    const amount = releasing ?? held
    const p = await api<PendingApproval & { summary: string; lines: ActionPreview['lines']; document: string }>('POST', `/api/goals/${g.id}/release/prepare`, { amount })
    setReleasing(null)
    setPending({ kind: 'release', approval: p, preview: { summary: p.summary, lines: p.lines, document: p.document, amount } })
  })
  const resume = useAction(async () => { await withPasskeyIfAsked(() => api('POST', `/api/programs/${g.id}/resume`), session.hasPasskey); setSaid(`Resumed: ${g.name} sets money aside again from its next day.`); onChanged() })

  const next = g.waiting ? `Waiting for your approval${g.waiting.deadline ? `, until ${fmt.dayTime(g.waiting.deadline)}` : ''}` : g.state === 'active' && g.next ? fmt.dayTime(g.next) : g.paused ? 'None while it is paused' : g.status === 'draft' ? 'Not until you sign it' : 'None: nothing more is moved'
  return (
    <article className={`sv-goal ${g.status}`} id={`goal-${g.id}`} aria-labelledby={hid}>
      <div className="sv-goal-head">
        <h3 id={hid}>{g.name}</h3>
        <Stamp tone={stampTone}>{stampWord}</Stamp>
      </div>
      <p className="sv-goal-by">{fmt.money(g.target)} by {day(g.date)}</p>
      <p className="sv-goal-k">Set aside</p>
      <p className="sv-goal-v" data-resolve=""><Sum paise={held} /></p>
      {g.onItsWay > 0 ? <p className="sv-goal-s">{rs(g.onItsWay)} of it is on its way from your bank account.</p> : null}
      <GoalBar g={g} />
      <dl className="sv-goal-facts">
        <div><dt>Each month</dt><dd>{rs(g.monthly)} on the {ordinal(g.day)}</dd><dd className="sv-goal-note">Worked out by QED; {MODE[g.runMode ?? 'approve'] ?? 'it asks you first'}</dd></div>
        <div><dt>Next</dt><dd>{next}</dd></div>
        <div><dt>On {day(g.date)}</dt><dd className={g.shortfall > 0 && g.status !== 'reached' ? 'short' : ''}>{rs(g.projected)}</dd><dd className="sv-goal-note">{g.status === 'reached' ? 'Reached' : g.shortfall > 0 ? `${rs(g.shortfall)} short` : 'The whole amount'}</dd></div>
      </dl>
      <p className="sv-goal-rule">{g.rule}</p>

      {g.status === 'behind' ? (
        <div className="sv-goal-fix">
          <p className="sv-goal-fix-h" id={fixId}>{g.paused ? 'It is paused. To catch up' : 'To catch up, any one of these'}</p>
          <ul aria-labelledby={fixId}>
            {g.paused ? <li><span><b>Resume it</b><small>{g.resumeEnough ? `${fmt.money(g.monthly)} a month then reaches ${fmt.money(g.target)} by ${day(g.date)}.` : 'Then one of the figures below as well.'}</small></span><Btn small tone="fill" busy={resume.busy} onClick={() => void resume.run()}>Resume<span className="sr"> {g.name}</span></Btn></li> : null}
            {r?.more ? <li><span><b>{fmt.money(r.more.extra)} more a month</b><small>{fmt.money(r.more.monthly)} a month from the next contribution, signed again with your passkey{g.paused ? ', which resumes it' : ''}.</small></span><Btn small busy={resign.busy} onClick={() => void resign.run()}>Sign {fmt.money(r.more.monthly)} a month<span className="sr"> for {g.name}</span></Btn></li> : null}
            {r?.later ? <li><span><b>{day(r.later.date)} instead of {day(g.date)}</b><small>The same {fmt.money(g.monthly)} a month, carried on, signed again with your passkey{g.paused ? ', which resumes it' : ''}.</small></span><Btn small busy={resign.busy} onClick={() => void resign.run(r.later!.date)}>Sign the later date<span className="sr"> of {day(r.later.date)} for {g.name}</span></Btn></li> : null}
            {r?.now ? <li><span><b>{fmt.money(r.now.amount)} now</b><small>From your bank account into the set-aside, once, approved with your passkey.</small></span><Btn small busy={topUp.busy} onClick={() => void topUp.run(r.now!.amount)}>Set aside {fmt.money(r.now.amount)}<span className="sr"> now for {g.name}</span></Btn></li> : null}
          </ul>
          <p className="sv-goal-if">{g.ifNothing}</p>
        </div>
      ) : g.status !== 'on-track' ? <p className="sv-goal-if">{g.ifNothing}</p> : null}

      <div className="sv-goal-acts">
        {g.status === 'draft' ? <Link className="btn sm fill" to={`/instructions/${g.id}`}>Review and sign<span className="sr"> “{g.name}”</span></Link> : null}
        {inForce ? <Link className="btn sm" to={`/instructions/${g.id}/amend`}>Change it<span className="sr">: {g.name}</span></Link> : null}
        {g.setAside > 0 ? <Btn small onClick={() => { setSaid(''); setReleasing(g.setAside) }}>Release<span className="sr"> money set aside for {g.name}</span></Btn> : null}
        {onRecord ? null : <Link className="btn sm quiet" to={`/instructions/${g.id}`}>Its instruction<span className="sr">: {g.name}</span></Link>}
      </div>
      <Problem error={resign.error ?? topUp.error ?? resume.error} />
      <p className="sr" role="status">{said}</p>

      <Sheet open={releasing !== null} title={`Release money set aside for ${g.name}`} onClose={() => setReleasing(null)}
        foot={<><Btn onClick={() => setReleasing(null)}>Not now</Btn><Btn tone="fill" busy={prepare.busy} disabled={!releasing || releasing > g.setAside} onClick={() => void prepare.run()}>Review the release</Btn></>}>
        <p>It goes back to your bank account at once, where it is free to use. {inForce ? 'The goal\'s instruction carries on as you signed it; to stop saving for this, revoke it on its page.' : 'Nothing more is set aside for this goal.'}</p>
        <Field label="How much to release" hint={`${rs(g.setAside)} is set aside`} error={prepare.error?.fields.amount}>{(p) => <MoneyInput {...p} value={releasing} onChange={setReleasing} />}</Field>
        <Problem error={prepare.error && !prepare.error.fields.amount ? prepare.error : null} />
      </Sheet>

      <ApprovalSheet approval={pending?.approval ?? null}
        title={pending?.kind === 'sign' ? `Sign "${g.name}" again` : pending?.kind === 'now' ? 'Set money aside now' : 'Release money set aside'}
        action={pending?.kind === 'sign' ? 'Sign and put in force' : pending?.kind === 'now' ? 'Set it aside' : 'Release it'}
        onClose={() => setPending(null)}
        onApproved={async (approvalId) => {
          const p = pending!
          if (p.kind === 'sign') { await api('POST', `/api/programs/${g.id}/activate`, { approvalId }); setSaid(p.said) }
          else if (p.kind === 'now') { await api('POST', '/api/actions', { approvalId }); setSaid(`Approved: ${fmt.money(p.amount)} is being set aside for ${g.name}.`) }
          else { await api('POST', `/api/goals/${g.id}/release`, { approvalId }); setSaid(`Released ${rs(p.preview.amount)} to your bank account.`) }
          setPending(null)
          onChanged()
        }}>
        {pending?.kind === 'sign' ? <InstrumentDoc doc={pending.doc} version={pending.version} state="review" /> : null}
        {pending?.kind === 'now' ? <ActionDoc summary={pending.preview.summary} lines={pending.preview.lines} warnings={pending.preview.warnings} worst={pending.preview.worst} document={pending.preview.document} /> : null}
        {pending?.kind === 'release' ? <ActionDoc summary={pending.preview.summary} lines={pending.preview.lines} warnings={[]} document={pending.preview.document} /> : null}
      </ApprovalSheet>
    </article>
  )
}
