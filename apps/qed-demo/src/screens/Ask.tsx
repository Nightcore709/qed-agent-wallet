/**
 * Ask (Meridian, DESIGN.md M1 to M11): the conversation with QED as one surface. The thread reads down; the person's
 * turns are plain, QED's carry the orb. A proposal arrives inside QED's reply as a glass card with its bound, its
 * figures and its next step, and the card follows that step to its end in the thread: a draft and its signature for an
 * instruction; the vault's exact terms, the passkey, the job and its record for the on-chain wallet. A later message can
 * correct a proposal ("make it ₹3,000 instead"; both cards say so and link to each other), withdraw them ("cancel
 * that"; QED's own code does it, no model is asked), or ask for several things at once. The composer is docked at the
 * foot of the conversation, above the dock and above a phone's keyboard; the page scrolls as one, with nothing empty
 * below the composer.
 *
 * Every proposal says who wrote it and how far QED's own code could check it; every rupee figure in a reply is looked
 * for in your records; the records a reply rests on are shown with their values. Nothing here can act: a proposal
 * becomes a draft instruction or the vault's exact terms, and nothing is done until the passkey signs those terms. The
 * buttons and the hold are how a person says they mean it; the passkey's signature is what authorises, and the checks
 * run again when anything is sent.
 */
import { ArrowUp, ArrowUpRight, Check, CornerDownRight, MessagesSquare, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { takeHandedAsk, api, fmt, navigate, useData, useLocation } from '../lib/core.ts'
import type { Home as HomeView, ProgramSummary, Proposal } from '../lib/types.ts'
import { signForVault } from '../lib/passkey.ts'
import { ActionDoc, ApprovalSheet, type PendingApproval } from '../ui/instrument.tsx'
import { Basis, Btn, Link, Loading, Mark, Note, Orb, Problem, Seal, Stamp, stateWord, useAction } from '../ui/kit.tsx'
import { caseOutcome } from '../ui/records.ts'
import { useKeyboardInset, useMedia } from '../ui/viewport.ts'
import { type Engine, modelWords, writtenBy } from './ask-words.ts'

type Prop = Proposal & { supersedes?: string | null; supersededBy?: string | null; programId?: string | null; programState?: string | null }
/** A structured question Ask put (server/ask-kinds.ts): choices to offer, whether a typed answer is allowed, and the answer once given. */
interface Clarify { id: string; field: string; question: string; choices: string[]; allowTyped: boolean; answer: { value: string; typed: boolean; at: number } | null }
interface Turn {
  id: string; ts: number; question: string; kind: 'model' | 'cancel' | 'guard'
  answer: string | null; refusal: string | null; questions: string[]; clarify?: Clarify[]; proposals: Prop[]
  withdrawn: string[]; superseded: { from: string; to: string }[]
  cites: { path: string; label: string; value: string }[]; citesUnresolved: number
  grounding: { checked: number; ungrounded: { text: string; paise: number }[] }
  links: { to: string; label: string }[]; engine: Engine
}
interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; turns: Turn[] }
/** On the Anthropic API (server/ask-models.ts ModelsView, the fields read here): where a question would go now, and why Ask is read-only when it is. */
interface ModelsLine { demanding: string | null; routine: string | null; readOnly: { code: string; message: string } | null }
interface ProposalsView { proposals: Prop[]; ai: { provider: string; model: string; detail: string }; models?: ModelsLine | null; observed: { ts: number; provider: string; model: string; latency_ms: number } | null }
interface ConvItem { id: string; title: string; updatedAt: number; turns: number }
interface Drafted { drafted: { proposalId: string; programId: string; title: string }[]; skipped: { proposalId: string; reason: string }[] }

const TIER: Record<string, [string, 'ok' | 'plain' | undefined]> = { certified: ['Certified no-regret', 'ok'], bounded: ['Bounded by its limits', undefined], 'each-time': ['Checked each time it runs', 'plain'] }
const MODE: Record<string, string> = { auto: 'Runs on its own, inside its limits', approve: 'Asks you before every run', notify: 'Tells you a day ahead, then runs unless you object' }
const STARTERS = ['What should I do with the cash sitting in my bank account?', 'How much of my credit card can I pay off without leaving myself short?', 'I want to invest a fixed amount every month. What would that look like?']
/** The width from which the conversations and this conversation's proposals stand in rails beside the thread. */
const WIDE = '(min-width: 1200px)'
const reduced = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
/**
 * Runs after the next paint. A long thread drawn and scrolled to its end in one frame is scored by the browser as the
 * whole page shifting (CLS 0.9 measured on the phone profile); drawn first and scrolled a frame later, it is a scroll.
 */
const afterPaint = (fn: () => void): void => { requestAnimationFrame(() => requestAnimationFrame(fn)) }

/** A record's name as a person reads it: a path such as "wallet.mandate" becomes "Wallet mandate". */
const citeLabel = (label: string): string => (/^[a-z]+(\.[A-Za-z]+)+$/.test(label) ? label.split('.').map((w) => w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(' ').replace(/^./, (c) => c.toUpperCase()) : label)

/**
 * A record's value as a person reads it. Most are figures and are shown as they are; a few records are structures the
 * server sends as JSON (a mandate, say), which are shown as labelled lines rather than one unbreakable string (the
 * finish review found one pushing the conversation off the side of a phone).
 */
function CiteValue({ value }: { value: string }) {
  let obj: Record<string, unknown> | null = null
  if (/^\s*\{/.test(value)) {
    try { const o = JSON.parse(value) as unknown; if (o && typeof o === 'object' && !Array.isArray(o)) obj = o as Record<string, unknown> }
    catch {
      // the server shortens long values, which can cut the JSON off: read the complete "key": value pairs it still has
      const pairs = [...value.matchAll(/"([A-Za-z_][\w]*)"\s*:\s*("([^"]*)"|-?\d+(?:\.\d+)?|true|false)/g)].map((m) => [m[1]!, m[3] ?? m[2]!] as const)
      if (pairs.length) obj = Object.fromEntries(pairs)
    }
  }
  if (!obj) return <dd>{value}</dd>
  const words = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
  return <dd className="ak-obj"><ul>{entries.slice(0, 8).map(([k, v]) => <li key={k}><span>{words(k)}</span> <b>{String(v)}</b></li>)}</ul></dd>
}

/** Who proposed, from the call's own provider (claims review F5): the suite's scripted double is never called a model. */
type Proposer = 'model' | 'double'
const proposerOf = (e: Engine): Proposer => (e.provider === 'scripted' || e.provider === 'injected' ? 'double' : 'model')
const PROPOSED: Record<Proposer, string> = { model: 'Proposed by the model', double: 'Proposed by a scripted test double, not a model' }
const DRAFTED: Record<Proposer, string> = { model: 'Drafted by a model', double: 'Drafted by a scripted test double, not a model' }
const WROTE: Record<Proposer, string> = { model: 'the model', double: 'the scripted test double' }


/** A proposal for the on-chain wallet (N-009) in words: what it would do, with the wallet's own units. */
function walletWords(p: Prop): string {
  const q = p.params as Record<string, string | number | undefined>
  const r = (v: unknown) => fmt.money(Math.round(Number(v ?? 0) * 100), true)
  if (p.kind === 'wallet-policy') return `Keep $${Number(q.targetFree ?? 0).toFixed(2)} in test dollars free in your dollar reserve, converting test rupees when it falls below that, within your signed mandate. Once you sign it, QED's engine runs it on its own and each conversion is checked by the co-signer and the wallet's contract.`
  if (p.kind === 'wallet-pay') return `Pay ${r(q.amount)} in test rupees to ${String(q.payee ?? 'a payee')} from your on-chain wallet${q.dueInDays ? `, promised for ${String(q.dueInDays)} days from now` : ', now'}.`
  if (p.kind === 'wallet-ring-fence') return `Set aside ${r(q.amount)} in test rupees for ${String(q.creditor ?? 'a creditor')}, due in ${String(q.dueInDays ?? '?')} days; only they can receive it.`
  return p.title
}
/** The one figure a wallet proposal leads with, in the wallet's own units, as proposed. */
function walletLead(p: Prop): { k: string; v: string; s: string } | null {
  const q = p.params as Record<string, string | number | undefined>
  if (p.kind === 'wallet-policy' && q.targetFree !== undefined) return { k: 'Kept free in your dollar reserve', v: `$${Number(q.targetFree).toFixed(2)}`, s: 'in test dollars, as proposed' }
  if (p.kind === 'wallet-pay' && q.amount !== undefined) return { k: 'Pays', v: fmt.money(Math.round(Number(q.amount) * 100), true), s: 'in test rupees, as proposed' }
  if (p.kind === 'wallet-ring-fence' && q.amount !== undefined) return { k: 'Sets aside', v: fmt.money(Math.round(Number(q.amount) * 100), true), s: 'in test rupees, as proposed' }
  return null
}

// ------------------------------------------------------------------------------------------------ where a proposal stands
/**
 * Where a proposal stands on its way from words to what it does, read only from records: the proposal's own state, the
 * instruction made from it (its state and runs), and for the on-chain wallet the vault's terms and the job that sent
 * them. A step is shown reached only when a record says so; an ending other than the hoped-for one is said in its own
 * words (a refused or reverted job is never shown as executed).
 */
type StepMark = 'done' | 'now' | 'work' | 'todo' | 'fail'
type Tone = 'ok' | 'wait' | 'void' | 'plain' | 'info'
type Group = 'open' | 'draft' | 'signed' | 'replaced' | 'withdrawn' | 'invalid' | 'cancelled' | 'expired'
interface Journey { steps: { label: string; mark: StepMark }[]; status: { label: string; tone: Tone }; group: Group }
interface VaultProposal { id: string; status: string; jobId?: string }
interface VaultJob { id: string; status: string; result: { outcome: string } | null; error: string | null }
interface Trail { vp: VaultProposal | null; job: VaultJob | null; jobId: string | null; unread: boolean }

/**
 * A vault job's outcome in the shared words (records.ts, CASE_OUTCOME: executed is Completed, refused is Refused, and so
 * on); a change waiting out its delay is Pending, and an error after sending is Failed (DESIGN.md, one status vocabulary).
 */
const outcomeOf = (outcome: string): [string, Tone] => (outcome === 'scheduled' ? ['Pending', 'wait'] : outcome === 'error' ? ['Failed', 'void'] : caseOutcome(outcome))
const ended = (label: string, tone: Tone, group: Group): Journey => ({ steps: [], status: { label, tone }, group })
/** A step's words when reached and before it: "Opened as a draft" once it is, "Open as a draft" while it is the next one. */
type Label = string | readonly [string, string]
const steps = (labels: readonly Label[], marks: StepMark[]) => labels.map((l, i) => { const mark = marks[i] ?? 'todo'; const [reached, before] = typeof l === 'string' ? [l, l] : l; return { label: mark === 'done' || mark === 'fail' ? reached : before, mark } })
const DRAFT = ['Opened as a draft', 'Open as a draft'] as const, SIGN = ['Signed, in force', 'Sign it'] as const
const TERMS = ['Terms prepared', 'Prepare the terms'] as const, PASSKEY = ['Signed', 'Sign with your passkey'] as const, SENT = ['Sent', 'Send'] as const
/** The last time QED prepared the vault's terms for this proposal, if it did (server/ai.ts draftWalletProposal). */
function lastTerms(p: Prop): { vaultProposalId: string } | null {
  const drafts = (p.analysis as unknown as { wallet?: { drafts?: { ok?: boolean; vaultProposalId?: string }[] } } | null)?.wallet?.drafts ?? []
  const d = [...drafts].reverse().find((x) => x.ok && typeof x.vaultProposalId === 'string')
  return d ? { vaultProposalId: d.vaultProposalId! } : null
}

function paperJourney(p: Prop, prog: ProgramSummary | undefined): Journey {
  const ps = p.programState ?? prog?.state ?? null
  const signed = ps === 'active' || ps === 'paused' || ps === 'completed' || ps === 'revoked'
  if (p.state === 'invalid') return ended('Not valid', 'void', 'invalid')
  if (p.state === 'declined') return ended('Declined by an adviser', 'void', 'invalid')
  if (p.state === 'superseded') return ended('Replaced', 'plain', signed ? 'signed' : 'replaced')
  if (p.state === 'dismissed') return ended('Withdrawn', 'plain', signed ? 'signed' : 'withdrawn')
  const L: Label[] = ['Proposed', DRAFT, SIGN]
  if (p.state === 'review') return { steps: steps(['Proposed', 'An adviser reviews it', DRAFT, SIGN], ['done', 'work']), status: { label: 'Awaiting an adviser\'s review', tone: 'wait' }, group: 'open' }
  if (signed) {
    const runs = prog?.counts.done ?? 0
    const runLabel = runs ? `${runs} run${runs === 1 ? '' : 's'} done` : prog?.nextDueAt ? `First run ${fmt.day(prog.nextDueAt)}` : 'Runs on its schedule'
    const status: [string, Tone] = [stateWord(ps ?? 'active'), ps === 'paused' ? 'wait' : ps === 'revoked' ? 'void' : ps === 'completed' ? 'plain' : 'ok']
    return { steps: steps([...L, runLabel], ['done', 'done', 'done', runs ? 'done' : ps === 'active' ? 'work' : 'todo']), status: { label: status[0], tone: status[1] }, group: 'signed' }
  }
  if (p.state === 'drafted' && p.programId) return { steps: steps([...L, 'Runs'], ['done', 'done', 'now']), status: { label: stateWord('draft'), tone: 'wait' }, group: 'draft' }
  return { steps: steps([...L, 'Runs'], ['done', 'now']), status: { label: 'Proposed', tone: 'wait' }, group: 'open' }
}

function walletJourney(p: Prop, t: Trail | undefined): Journey {
  if (p.state === 'superseded') return ended('Replaced', 'plain', 'replaced')
  if (p.state === 'dismissed') return ended('Withdrawn', 'plain', 'withdrawn')
  if (p.state === 'invalid') return ended('Not valid', 'void', 'invalid')
  const L: Label[] = ['Proposed', TERMS, PASSKEY, SENT]
  const job = t?.job
  if (job) {
    if (job.status === 'accepted' || job.status === 'running' || job.status === 'confirming') { const w = job.status === 'accepted' ? 'Submitted' : 'Pending'; return { steps: steps([...L, w], ['done', 'done', 'done', 'done', 'work']), status: { label: w, tone: 'info' }, group: 'signed' } }
    if (job.status === 'failed' || job.status === 'interrupted') {
      const w = job.status === 'interrupted' ? 'Interrupted' : 'Failed'
      return { steps: steps([...L, w], ['done', 'done', 'done', 'done', 'fail']), status: { label: w, tone: 'void' }, group: 'signed' }
    }
    const out: [string, Tone] = job.result ? outcomeOf(job.result.outcome) : ['Finished', 'plain']
    return { steps: steps([...L, out[0]], ['done', 'done', 'done', 'done', out[1] === 'void' ? 'fail' : 'done']), status: { label: out[0], tone: out[1] }, group: 'signed' }
  }
  if (t?.vp?.status === 'open') return { steps: steps([...L, 'Outcome'], ['done', 'done', 'now']), status: { label: 'Awaiting your approval', tone: 'wait' }, group: 'draft' }
  if (t?.vp && (t.vp.status === 'cancelled' || t.vp.status === 'expired')) return { steps: steps([...L, 'Outcome'], ['done', 'now']), status: { label: t.vp.status === 'expired' ? 'Expired' : 'Cancelled', tone: 'plain' }, group: t.vp.status === 'expired' ? 'expired' : 'cancelled' }
  if (p.state === 'drafted') return { steps: steps([...L, 'Outcome'], ['done', 'done', 'now']), status: { label: 'Terms prepared', tone: 'wait' }, group: 'draft' }
  return { steps: steps([...L, 'Outcome'], ['done', 'now']), status: { label: 'Proposed', tone: 'wait' }, group: 'open' }
}

/** The wallet proposals' trails: the vault's terms and the job, read from the vault service; a running job is followed. */
function useWalletTrails(list: Prop[], sent: Record<string, string>, reading: unknown): Map<string, Trail> {
  const [trails, setTrails] = useState<Map<string, Trail>>(() => new Map())
  // read again whenever the conversation is (`reading` is its latest copy): a terms request withdrawn by "Not now"
  // changes the vault's record and nothing in the proposal's own
  const reads = useRef<{ of: unknown; n: number }>({ of: reading, n: 0 })
  if (reads.current.of !== reading) reads.current = { of: reading, n: reads.current.n + 1 }
  const key = `${reads.current.n}|${list.map((p) => `${p.id}:${p.state}:${lastTerms(p)?.vaultProposalId ?? ''}:${sent[p.id] ?? ''}`).join('|')}`
  useEffect(() => {
    let alive = true, timer = 0
    const load = async () => {
      const next = new Map<string, Trail>()
      let running = false
      for (const p of list) {
        const terms = lastTerms(p), given = sent[p.id] ?? null
        if (!given && !(terms && p.state === 'drafted')) continue
        let vp: VaultProposal | null = null, job: VaultJob | null = null, unread = false
        try {
          if (!given && terms) vp = await api<VaultProposal>('GET', `/api/vault/proposals/${terms.vaultProposalId}`)
          const id = given ?? vp?.jobId ?? null
          if (id) job = await api<VaultJob>('GET', `/api/vault/jobs/${id}`)
        } catch { unread = true }
        if (job && (job.status === 'accepted' || job.status === 'running' || job.status === 'confirming')) running = true
        next.set(p.id, { vp, job, jobId: given ?? vp?.jobId ?? null, unread })
      }
      if (!alive) return
      setTrails(next)
      if (running) timer = window.setTimeout(() => { void load() }, 1200)
    }
    void load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return trails
}

/** "5 proposals: 1 replaced, 4 withdrawn. Nothing signed." */
function tally(js: Journey[]): string {
  if (!js.length) return 'No proposals yet. A reply may propose instructions; nothing runs until you sign one.'
  const n = (g: Group) => js.filter((j) => j.group === g).length
  const parts = ([['signed', 'signed'], ['draft', 'awaiting your signature'], ['open', 'proposed'], ['cancelled', 'cancelled'], ['expired', 'expired'], ['replaced', 'replaced'], ['withdrawn', 'withdrawn'], ['invalid', 'not valid']] as const).filter(([g]) => n(g)).map(([g, w]) => `${n(g)} ${w}`)
  return `${js.length} proposal${js.length === 1 ? '' : 's'}: ${parts.join(', ')}.${n('signed') ? '' : ' Nothing signed.'}`
}

/** A link to a place further up or down the conversation: it scrolls there and gives it focus, without leaving the page. */
function Jump({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={`#${to}`} className={className} onClick={(e) => {
    const el = document.getElementById(to)
    if (!el) return
    e.preventDefault()
    el.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1
    el.focus({ preventScroll: true })
  }}>{children}</a>
}

function JourneyRail({ j }: { j: Journey }) {
  if (!j.steps.length) return null
  return (
    <ol className="ak-steps" aria-label={`Where it stands: ${j.status.label}`}>
      {j.steps.map((s, i) => (
        <li key={i} className={s.mark} aria-current={s.mark === 'now' || s.mark === 'work' || s.mark === 'fail' ? 'step' : undefined}>
          <i aria-hidden="true">{s.mark === 'done' ? <Check /> : s.mark === 'fail' ? <X /> : i + 1}</i><span className="ak-step-t">{s.label}</span>{s.mark === 'done' ? <span className="sr">, done</span> : null}
        </li>
      ))}
    </ol>
  )
}

// ------------------------------------------------------------------------------------------------ the on-chain wallet
/**
 * Signing a wallet proposal: the exact vault terms are prepared from the proposal (checked again on the wallet's figures
 * now), signed with the passkey over the digests the chain checks, then sent once. The card then follows the job on the
 * chain to its outcome, with its record one link away.
 */
function WalletActions({ p, j, trail, onDismiss, busy, proposer, onSent, onChanged }: { p: Prop; j: Journey; trail: Trail | undefined; onDismiss: (id: string) => void; busy: boolean; proposer: Proposer; onSent: (proposalId: string, jobId: string) => void; onChanged: () => void }) {
  type Terms = PendingApproval & { proposal: { id: string; summary: string; allowed: boolean; checks: { rule: string; pass: boolean; detail?: string }[]; terms?: Record<string, unknown>; termsHash?: string }; sign: unknown[]; devices?: number }
  const [pending, setPending] = useState<Terms | null>(null)
  // preparing the terms changes the proposal's record (drafted, with the vault's terms): the thread is read again
  const prepare = useAction(async () => { setPending(await api<Terms>('POST', `/api/wallet-proposals/${p.id}/draft`)); onChanged() })
  const checks = ((p.analysis as unknown as { wallet?: { checks?: { name: string; pass: boolean; detail: string }[] } } | null)?.wallet?.checks) ?? []
  const digests = pending?.sign.length ?? 0
  const signed = j.group === 'signed'
  return (
    <>
      {checks.length > 0 && !signed ? <ul className="checks ak-checks" aria-label="QED's own checks of this proposal">{checks.map((c, i) => <li key={i} className={c.pass ? '' : 'no'}><Mark pass={c.pass} /><span>{c.detail || c.name}<span className="sr">{c.pass ? ' passed' : ' failed'}</span></span></li>)}</ul> : null}
      {trail?.unread && !trail.job ? <p className="ak-quiet">The wallet's service did not answer just now. What it has done is kept under <Link to="/vault/records">On-chain wallet, records</Link>.</p> : null}
      <footer className="ak-card-foot">
        <JourneyRail j={j} />
        <div className="ak-card-acts">
          {trail?.jobId ? <Link className={`btn sm${j.status.tone === 'ok' ? ' fill' : ''}`} to={`/vault/job/${trail.jobId}`}><ArrowUpRight aria-hidden="true" />Its record on the chain</Link> : null}
          {!signed && p.state !== 'invalid' ? <Btn small tone="fill" busy={prepare.busy} onClick={() => void prepare.run()}>Review the exact terms and sign</Btn> : null}
          {!signed ? <Btn small tone="quiet" busy={busy} onClick={() => onDismiss(p.id)}>Dismiss</Btn> : null}
        </div>
      </footer>
      <Problem error={prepare.error} />
      <ApprovalSheet approval={pending} title="Approve on your on-chain wallet" action="Approve and send to the wallet" signer={digests ? signForVault : undefined} prompts={Math.max(1, digests)} devices={pending?.devices ?? 1}
        onClose={(stillOpen) => { if (pending && !stillOpen) void api('POST', `/api/vault/proposals/${pending.proposal.id}/cancel`).catch(() => {}).finally(onChanged); setPending(null) }}
        onApproved={async (approvalId) => { if (!pending) return; const a = await api<{ jobId: string }>('POST', `/api/vault/proposals/${pending.proposal.id}/execute`, { approvalId }); setPending(null); onSent(p.id, a.jobId) }}>
        {pending ? (
          <article className="instrument"><div className="i-head"><span>On-chain wallet, {proposer === 'double' ? 'proposed by a scripted test double, not a model' : 'proposed by the model'}</span><span>Not signed yet</span></div>
            <div className="i-body">
              <p className="i-pay">{pending.proposal.summary}</p>
              {/* the network, as the wallet's own sheet names it (R12 section 4) */}
              <p className="small ak-sheet-where">On a test chain on this computer{typeof pending.proposal.terms?.chainId === 'number' || typeof pending.proposal.terms?.chainId === 'string' ? ` (chain ${String(pending.proposal.terms.chainId)})` : ''}: the tokens have no value. These terms lapse {new Date(pending.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
              {!pending.proposal.allowed ? <Note tone="void">Under the wallet's limits as they stand this would be refused. You can still send it; the refusal is then recorded.</Note> : null}
              {pending.proposal.checks.length ? <ul className="checks ak-sheet-checks">{pending.proposal.checks.map((c, i) => <li key={i} className={c.pass ? '' : 'no'}><Mark pass={c.pass} /><span>{c.rule}{c.detail ? <span className="muted">. {c.detail}</span> : null}</span></li>)}</ul> : null}
              <details className="ak-sheet-fields"><summary>Every field of the terms ({Object.keys(pending.proposal.terms ?? {}).length})</summary>
                <dl className="kv small">{Object.entries(pending.proposal.terms ?? {}).filter(([k]) => k !== 'message').map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="code">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>)}</dl>
                <p className="small muted">Their fingerprint is <span className="code">{String(pending.proposal.termsHash ?? '').replace('sha256:', '').slice(0, 16)}</span>; the wallet service recomputes it before it signs and refuses if it differs.</p>
              </details>
              <p className="small muted ak-sheet-said">{DRAFTED[proposer]}; no licensed adviser reviewed it. Your passkey signs these exact terms{digests ? `, over the ${digests === 1 ? 'digest' : `${digests} digests`} the chain checks` : ''}, and nothing else. Who proposed it is part of what you sign.</p>
            </div>
          </article>
        ) : null}
      </ApprovalSheet>
    </>
  )
}


// ------------------------------------------------------------------------------------------------ one-off kinds and the goal
/**
 * A payment to a payee the household has, a fund order, adding a payee, an idea for Grow (server/ask-kinds.ts). Each card
 * opens the same flow a request of the person's own goes through: the payment and the order become the preview and the
 * passkey approval of Pay and Grow; a payee is checked and waits for the person's own confirmation; an idea is handed to Grow.
 * Nothing here acts: the proposal is words until the passkey signs, and the engine decides again when it is sent.
 */
const ONE_OFF = new Set(['pay', 'order', 'add-payee', 'idea'])
const ONE_OFF_NAME: Record<string, string> = { pay: 'One-off payment', order: 'One-off fund order', 'add-payee': 'New payee', idea: 'Idea for Grow' }
interface Opened { type?: string; approval?: string; actionId?: string | null; actionState?: string | null; payeeId?: string; text?: string }
const openedOf = (p: Prop): Opened | null => ((p.analysis as unknown as { opened?: Opened } | null)?.opened) ?? null
function oneOffJourney(p: Prop): Journey {
  if (p.state === 'invalid') return ended('Not valid', 'void', 'invalid')
  if (p.state === 'superseded') return ended('Replaced', 'plain', 'replaced')
  if (p.state === 'dismissed') return ended('Withdrawn', 'plain', 'withdrawn')
  const o = openedOf(p)
  const L: Label[] = p.kind === 'add-payee' ? ['Proposed', ['Checked', 'Check it'], ['Added by you', 'Confirm and add']] : p.kind === 'idea' ? ['Proposed', ['Handed to Grow', 'Hand it to Grow']] : ['Proposed', ['Preview opened', 'Review the preview'], PASSKEY, ['Carried out', 'Sent']]
  if (!o) return { steps: steps(L, ['done', 'now']), status: { label: 'Proposed', tone: 'wait' }, group: 'open' }
  if (p.kind === 'add-payee') return o.payeeId ? { steps: steps(L, ['done', 'done', 'done']), status: { label: 'Added', tone: 'ok' }, group: 'signed' } : { steps: steps(L, ['done', 'done', 'now']), status: { label: 'Awaiting your confirmation', tone: 'wait' }, group: 'draft' }
  if (p.kind === 'idea') return { steps: steps(L, ['done', 'done']), status: { label: 'In Grow', tone: 'ok' }, group: 'signed' }
  if (o.actionId) { const [w, tone] = o.actionState === 'done' ? ['Completed', 'ok' as Tone] : o.actionState && ['failed', 'rejected', 'blocked', 'expired', 'cancelled'].includes(o.actionState) ? ['Refused', 'void' as Tone] : ['Pending', 'info' as Tone]; return { steps: steps(L, ['done', 'done', 'done', tone === 'void' ? 'fail' : tone === 'ok' ? 'done' : 'work']), status: { label: w, tone }, group: 'signed' } }
  if (o.approval === 'cancelled' || o.approval === 'expired') return { steps: steps(L, ['done', 'done', 'now']), status: { label: o.approval === 'expired' ? 'Expired' : 'Cancelled', tone: 'plain' }, group: o.approval === 'expired' ? 'expired' : 'cancelled' }
  return { steps: steps(L, ['done', 'done', 'now']), status: { label: 'Awaiting your approval', tone: 'wait' }, group: 'draft' }
}
interface Preview extends PendingApproval { summary: string; lines: { label: string; value: string; basis: string; note?: string }[]; warnings: string[]; worst: { before: number; after: number; line: number }; document: string }
type OpenedReply = { type: 'approval'; preview: Preview } | { type: 'payee'; check: { nameCheck: { outcome: string; registeredName: string | null; message: string | null }; lookalike: string | null; needsConfirmation: boolean }; name: string; handle: string } | { type: 'idea'; text: string; heard: string[]; questions: number }

function OneOffCard({ p, j, proposer, onDismiss, busy, onChanged }: { p: Prop; j: Journey; proposer: Proposer; onDismiss: (id: string) => void; busy: boolean; onChanged: () => void }) {
  const a = p.analysis
  const closed = p.state === 'superseded' || p.state === 'dismissed'
  const [pv, setPv] = useState<Preview | null>(null)
  const [check, setCheck] = useState<Extract<OpenedReply, { type: 'payee' }> | null>(null)
  const [sure, setSure] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const open = useAction(async () => {
    const r = await api<OpenedReply>('POST', `/api/proposals/${p.id}/open`)
    if (r.type === 'approval') setPv(r.preview)
    else if (r.type === 'payee') { setCheck(r); setSure(false) }
    else navigate(`/holdings/idea?text=${encodeURIComponent(r.text)}`)
    onChanged()
  })
  const add = useAction(async () => {
    if (!check) return
    const r = await api<{ name: string }>('POST', `/api/proposals/${p.id}/confirm-payee`, { lookalikeChecked: !!check.check.lookalike && sure, nameCheckAccepted: check.check.nameCheck.message ? check.check.nameCheck.outcome : undefined })
    setDone(r.name); setCheck(null); onChanged()
  })
  const o = openedOf(p)
  const ended = j.group === 'signed'
  const by = <p className="ak-card-by"><span className={p.origin === 'model' ? 'by-qed' : ''}>{PROPOSED[proposer]}</span><span>, {fmt.dayTime(p.ts)}. {ONE_OFF_NAME[p.kind]}</span></p>
  const figures = a && a.figures.length ? <dl className="ak-figs">{a.figures.map((f, i) => <div key={i}><dt>{f.label}</dt><dd className="v">{f.value}</dd><dd className="n"><Basis kind={f.basis} />{f.note ? <span> {f.note}</span> : null}</dd></div>)}</dl> : null
  return (
    <article id={`ak-${p.id}`} tabIndex={-1} className={`ak-card${closed ? ' closed' : ''}`} aria-label={a?.title ?? p.title}>
      <header className="ak-card-head">{by}<span className="ak-state"><Stamp tone={j.status.tone}>{j.status.label}</Stamp></span></header>
      <h3 className="ak-card-t">{a?.title ?? p.title}</h3>
      {closed ? <p className="ak-closed">{p.state === 'superseded' ? 'Replaced after your correction.' : 'Nothing was signed, and nothing will run from it.'}</p> : <>
        <p className="ak-card-what">{p.rationale}</p>
        {p.state === 'invalid' ? <Note tone="void" title="Not valid, so it cannot be opened or signed">{p.invalidReason}</Note> : <>
          {figures}
          {(a?.warnings ?? []).map((w, i) => <Note key={i} tone="wait">{w}</Note>)}
          <p className="ak-drafted">{DRAFTED[proposer]}. QED checked it with fixed code. {p.kind === 'pay' || p.kind === 'order' ? 'Opening it makes the same preview and passkey approval as a request of your own, and the checks run again when it is sent.' : p.kind === 'add-payee' ? 'Adding it goes through the paper bank\'s name check and the look-alike check, and only your own confirmation adds it.' : 'It moves no money: Grow asks what it still needs and tests the idea on your books.'}</p>
        </>}
        {done ? <Note tone="ok" title={`${done} was added to your payees`}>The look-alike and name check answers are kept with the payee.</Note> : null}
        {check ? <div className="ak-payee-check">
          {check.check.lookalike ? <Note tone="wait" title="Looks like a payee you already have">{check.check.lookalike}</Note> : null}
          {check.check.nameCheck.message ? <Note tone="wait" title="The paper bank's name check">{check.check.nameCheck.message}</Note> : <p className="ak-quiet">The paper bank's name check matched {check.check.nameCheck.registeredName ?? 'the name'}.</p>}
          {check.check.lookalike ? <label className="ak-sure"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I have checked this address with the payee myself, and it is not the look-alike.</label> : null}
          <div className="ak-card-acts"><Btn small tone="fill" busy={add.busy} disabled={!!check.check.lookalike && !sure} onClick={() => void add.run()}>Add {check.name}</Btn><Btn small tone="quiet" onClick={() => setCheck(null)}>Not now</Btn></div>
          <Problem error={add.error} />
        </div> : null}
      </>}
      <footer className="ak-card-foot">
        <JourneyRail j={j} />
        <div className="ak-card-acts">
          {!closed && !ended && p.state !== 'invalid' && !check && !done ? <Btn small tone="fill" busy={open.busy} onClick={() => void open.run()}>{p.kind === 'pay' ? 'Review the payment and approve' : p.kind === 'order' ? 'Review the order and approve' : p.kind === 'add-payee' ? 'Check this payee' : 'Continue in Grow'}</Btn> : null}
          {o?.actionId ? <Link className="btn sm" to={`/record/${o.actionId}`}><ArrowUpRight aria-hidden="true" />Its record</Link> : null}
          {!closed && !ended && !done ? <Btn small tone="quiet" busy={busy} onClick={() => onDismiss(p.id)}>Dismiss</Btn> : null}
        </div>
      </footer>
      <Problem error={open.error} />
      <ApprovalSheet approval={pv} title={p.kind === 'order' ? 'Approve this order' : 'Approve this payment'} action="Approve and send" onClose={() => { setPv(null); onChanged() }}
        onApproved={async (approvalId) => { await api('POST', '/api/actions', { approvalId }); setPv(null); onChanged() }}>
        {pv ? <ActionDoc summary={pv.summary} lines={pv.lines} warnings={pv.warnings} worst={pv.worst} document={pv.document} /> : null}
      </ApprovalSheet>
    </article>
  )
}

/** The structured questions Ask put in a reply: choices and a typed answer, each answered once and kept with its question. */
function Clarifying({ list, onAnswer, busy }: { list: Clarify[]; onAnswer: (c: Clarify, value: string) => void; busy: boolean }) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  return (
    <div className="ak-clar" role="group" aria-label="Questions QED needs answered">
      <span className="ak-clar-h">QED needs to know:</span>
      {list.map((c) => (
        <form key={c.id} className="ak-clar-q" onSubmit={(e) => { e.preventDefault(); const v = (typed[c.id] ?? '').trim(); if (v) onAnswer(c, v) }}>
          <p className="ak-clar-t" id={`clar-${c.id}`}>{c.question}</p>
          {c.answer ? <p className="ak-clar-a"><Check aria-hidden="true" /> You answered: <b>{c.answer.value}</b>{c.answer.typed ? ' (typed)' : ''}</p> : <>
            {c.choices.length ? <ul className="ak-clar-ch" aria-labelledby={`clar-${c.id}`}>{c.choices.map((x) => <li key={x}><button type="button" className="ak-q" disabled={busy} onClick={() => onAnswer(c, x)}>{x}</button></li>)}</ul> : null}
            {c.allowTyped ? <div className="ak-clar-typed"><input className="input" aria-label={`${c.question} Type your own answer`} placeholder={c.choices.length ? 'Or type your own answer' : 'Type your answer'} maxLength={300} value={typed[c.id] ?? ''} onChange={(e) => setTyped((t) => ({ ...t, [c.id]: e.target.value }))} /><Btn small tone="fill" type="submit" disabled={busy || !(typed[c.id] ?? '').trim()}>Answer</Btn></div> : null}
          </>}
        </form>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ a proposal, as a card in the thread
function ProposalCard({ p, j, byModel, onDismiss, busy, titleOf, proposer = 'model', trail, onSent, onChanged }: {
  p: Prop; j: Journey; byModel: boolean; onDismiss: (id: string) => void; busy: boolean; titleOf: (id: string) => string | undefined; proposer?: Proposer
  trail?: Trail; onSent: (proposalId: string, jobId: string) => void; onChanged: () => void
}) {
  const a = p.analysis
  const tier = a ? TIER[a.tier] ?? [a.tier, 'plain' as const] : null
  // N-006 (production setting): a registered adviser's review of a model's investment proposal, when there was one
  const review = (a as unknown as { review?: { by: string; registration: string; note?: string; decision: string } } | null)?.review
  const closed = p.state === 'superseded' || p.state === 'dismissed'
  const by = <p className="ak-card-by"><span className={p.origin === 'model' ? 'by-qed' : ''}>{p.origin === 'model' ? PROPOSED[proposer] : 'Worked out by fixed rules, no model'}</span><span>, {fmt.dayTime(p.ts)}{p.kind.startsWith('wallet-') ? ', for your on-chain wallet' : ''}</span></p>
  const stamp = <span className="ak-state"><Stamp tone={j.status.tone}>{j.status.label}</Stamp></span>

  if (ONE_OFF.has(p.kind)) return <OneOffCard p={p} j={j} proposer={proposer} onDismiss={onDismiss} busy={busy} onChanged={onChanged} />
  if (p.kind.startsWith('wallet-')) {
    const lead = walletLead(p)
    return (
      <article id={`ak-${p.id}`} tabIndex={-1} className={`ak-card wallet${closed ? ' closed' : ''}`} aria-label={p.title}>
        <header className="ak-card-head">{by}{stamp}</header>
        <h3 className="ak-card-t">{p.title}</h3>
        {lead && !closed ? <p className="ak-bound"><span className="k">{lead.k}</span> <strong className="v">{lead.v}</strong> <span className="s">{lead.s}</span></p> : null}
        <p className="ak-card-what">{walletWords(p)}</p>
        {p.rationale ? <p className="ak-card-why">{p.rationale}</p> : null}
        {p.state === 'invalid' ? <Note tone="void" title="Not valid, so it cannot be signed">{p.invalidReason}</Note> : null}
        {closed ? <p className="ak-closed">{p.state === 'superseded' ? 'Replaced after your correction.' : 'Nothing was signed, and nothing will run from it.'}</p>
          : <WalletActions p={p} j={j} trail={trail} onDismiss={onDismiss} busy={busy} proposer={proposer} onSent={onSent} onChanged={onChanged} />}
      </article>
    )
  }

  const bound = a && p.state !== 'invalid' && (typeof a.ceilingPaise === 'number' || a.ceilingPaise === null)
    ? <p className="ak-bound">{typeof a.ceilingPaise === 'number' && a.expiresAt
      ? <><span className="k">Not over</span> <strong className="v">{fmt.money(a.ceilingPaise)}</strong> <span className="s">in all before {fmt.dayYear(a.expiresAt)}, as proposed: its monthly limit for every month it can run, or less where a daily or per-run limit binds. It is the bound its limits set, not a plan of what it will move, and you can tighten every limit before you sign.</span></>
      : <><span className="k">What it can do</span> <strong className="v words">It can only sell.</strong> <span className="s">It never buys and never pays anyone.</span></>}</p>
    : null
  const figures = a && a.figures.length ? <dl className="ak-figs">{a.figures.slice(0, 6).map((f, i) => <div key={i}><dt>{f.label}</dt><dd className="v">{f.value}</dd><dd className="n"><Basis kind={f.basis} />{f.note ? <span> {f.note}</span> : null}</dd></div>)}</dl> : null
  const ps = p.programState
  const acts = p.programId && ps && (p.state === 'drafted' || closed)
    ? (ps === 'draft' ? <Link className="btn sm fill" to={`/instructions/${p.programId}`}>Open the draft</Link> : <Link className="btn sm" to={`/instructions/${p.programId}`}><ArrowUpRight aria-hidden="true" />Its runs and receipts</Link>)
    : closed ? null : <>
      {p.state !== 'invalid' && p.state !== 'review' && p.state !== 'declined' ? <Link className={`btn sm ${a?.refusals.length ? '' : 'fill'}`} to={`/instructions/new?proposal=${p.id}`}>{a?.refusals.length ? 'Open it to change it' : 'Open as a draft to review'}</Link> : null}
      {p.state !== 'drafted' ? <Btn small tone="quiet" busy={busy} onClick={() => onDismiss(p.id)}>Dismiss</Btn> : null}
    </>
  const supersededBy = titleOf(p.supersededBy ?? '')
  const corrected = p.supersedes ? titleOf(p.supersedes) : undefined
  return (
    <article id={`ak-${p.id}`} tabIndex={-1} className={`ak-card${closed ? ' closed' : ''}`} aria-label={a?.title ?? p.title}>
      <header className="ak-card-head">{by}{stamp}</header>
      <h3 className="ak-card-t">{a?.title ?? p.title}</h3>
      {p.state === 'superseded' ? <p className="ak-closed"><b>Replaced after your correction</b> {supersededBy ? <>by "<Jump to={`ak-${p.supersededBy}`}>{supersededBy}</Jump>", below.</> : 'by a later proposal.'}{p.programId ? (ps === 'draft' ? ' You had opened this version as a draft; that draft is unchanged and does nothing unless you sign it.' : ' An instruction was made from this version; it is unchanged. Change it under Instructions.') : ''}</p> : null}
      {p.state === 'dismissed' ? <p className="ak-closed">Nothing was signed, and nothing will run from it.</p> : null}
      {p.supersedes ? <p className="ak-corrects">Corrects "{corrected ? <Jump to={`ak-${p.supersedes}`}>{corrected}</Jump> : 'an earlier proposal'}".</p> : null}
      {!closed ? <>
        <p className="ak-card-what">{p.rationale}</p>
        {bound}
        {p.state === 'review' ? <Note tone="wait" title="Waiting for a registered investment adviser">A model proposed an investment, so a registered adviser reviews it before you can open or sign it. Nothing runs meanwhile.</Note> : null}
        {p.state === 'declined' ? <Note tone="void" title="Declined by a registered investment adviser, so it cannot be opened or signed">{p.invalidReason}</Note> : null}
        {p.state === 'invalid' ? <Note tone="void" title="Not valid, so it cannot be drafted or signed">{p.invalidReason}</Note> : a ? <>
          <div className="ak-tier">{tier ? <Stamp tone={tier[1]}>{tier[0]}</Stamp> : null}<span>{a.tierReason}</span>{p.runMode ? <span><b>Would run:</b> {MODE[p.runMode] ?? p.runMode}</span> : null}</div>
          {figures}
          {a.refusals.map((r, i) => <Note key={`r${i}`} tone="void" title="Cannot be signed as it stands">{r}</Note>)}
          {a.warnings.map((w, i) => <Note key={`w${i}`} tone="wait">{w}</Note>)}
        </> : null}
        {byModel ? <p className="ak-drafted">{DRAFTED[proposer]}. {review?.decision === 'approved' ? `A registered investment adviser, ${review.by} (SEBI registration ${review.registration}), reviewed it${review.note ? `: "${review.note}"` : ''}.` : 'No licensed adviser has reviewed it, and QED does not give investment advice.'}</p> : null}
      </> : a ? (
        <details className="ak-was">
          <summary>What it proposed, as it stood</summary>
          <div className="ak-was-body"><p className="ak-card-what">{p.rationale}</p>{bound}{figures}</div>
        </details>
      ) : null}
      {j.steps.length || acts ? <footer className="ak-card-foot"><JourneyRail j={j} />{acts ? <div className="ak-card-acts">{acts}</div> : null}</footer> : null}
    </article>
  )
}

// ------------------------------------------------------------------------------------------------ a turn: the person's words, then QED's
function TurnView({ t, fresh, all, journeys, trails, onDismiss, dismissing, onDraftAll, drafting, drafted, onAsk, onAnswer, answering, onSent, onChanged }: {
  t: Turn; fresh: boolean; all: Map<string, Prop>; journeys: Map<string, Journey>; trails: Map<string, Trail>
  onDismiss: (id: string) => void; dismissing: boolean; onDraftAll: (turn: string, ids: string[]) => void; drafting: boolean; drafted: Drafted | null
  onAsk: (q: string) => void; onAnswer: (turn: Turn, c: Clarify, value: string) => void; answering: boolean; onSent: (proposalId: string, jobId: string) => void; onChanged: () => void
}) {
  const titleOf = (id: string) => { const p = all.get(id); return p ? (p.analysis?.title ?? p.title) : undefined }
  const draftable = t.proposals.filter((p) => p.state === 'new' && !p.kind.startsWith('wallet-') && !ONE_OFF.has(p.kind) && !p.analysis?.refusals?.length)
  const byModel = t.engine.provider !== 'qed'
  const proposer = proposerOf(t.engine)
  const note = useRef<HTMLDivElement>(null)
  // after "Open all as drafts" the button is gone: focus goes to what it did, so a keyboard is not left on nothing
  useEffect(() => { if (drafted) note.current?.focus({ preventScroll: true }) }, [drafted])
  const n = t.grounding.ungrounded.length
  return (
    <li className={`ak-turn${fresh ? ' ak-fresh' : ''}`} id={`ak-t-${t.id}`} data-block="">
      <div className="ak-you"><p className="ak-you-text">{t.question}</p><span className="ak-when">You, {fmt.dayTime(t.ts)}</span></div>
      <div className={`ak-reply${t.kind !== 'model' ? ' own' : ''}`}>
        <p className="ak-by"><Orb /><span>{writtenBy(t.engine)}</span></p>
        {t.answer
          ? <div className="ak-answer">{t.answer.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>
          : <Note tone="void" title={`${proposer === 'double' ? 'The scripted test double' : 'The model'} gave no usable reply`}>{t.refusal ?? 'It returned nothing.'}</Note>}
        {n ? <Note tone="wait" title="Not found in your records">{t.grounding.ungrounded.map((u) => u.text).join(', ')}: {WROTE[proposer]} may have worked {n === 1 ? 'this' : 'these'} out or assumed {n === 1 ? 'it' : 'them'}. Check before relying on {n === 1 ? 'it' : 'them'}.</Note>
          : byModel && t.grounding.checked ? <p className="ak-grounded"><Seal />QED found every rupee figure in this reply in your records or in its own calculations ({t.grounding.checked} checked). Percentages and other numbers are not checked.</p> : null}
        {t.cites.length ? <details className="ak-cites" open={t.cites.length <= 4}><summary>Rests on {t.cites.length} record{t.cites.length === 1 ? '' : 's'}, as they stood when it was asked</summary><dl className="ak-rests">{t.cites.map((c) => <div key={c.path} className="ak-cite"><dt>{citeLabel(c.label)}</dt><CiteValue value={c.value} /></div>)}</dl>{t.citesUnresolved ? <p className="ak-quiet">It also cited {t.citesUnresolved} record{t.citesUnresolved === 1 ? '' : 's'} that do not exist; {t.citesUnresolved === 1 ? 'it is' : 'they are'} not shown.</p> : null}</details> : null}
        {t.links.length ? <div className="ak-where"><span>Where to act:</span>{t.links.map((l) => <Link key={l.to} to={l.to} className="ak-to">{l.label}<ArrowUpRight aria-hidden="true" /></Link>)}</div> : null}
        {t.clarify?.length ? <Clarifying list={t.clarify} busy={answering} onAnswer={(c, v) => onAnswer(t, c, v)} /> : null}
        {t.questions.length ? <div className="ak-asks"><span>It would like to know:</span><ul>{t.questions.map((q, i) => <li key={i}><button type="button" className="ak-q" onClick={() => onAsk(q)}>{q}</button></li>)}</ul></div> : null}
        {t.proposals.length ? <div className="ak-cards">{t.proposals.map((p) => <ProposalCard key={p.id} p={p} j={journeys.get(p.id) ?? paperJourney(p, undefined)} byModel={p.origin === 'model'} busy={dismissing} onDismiss={onDismiss} titleOf={titleOf} proposer={proposer} trail={trails.get(p.id)} onSent={onSent} onChanged={onChanged} />)}</div>
          : t.kind === 'model' && t.answer ? <p className="ak-none">It proposed no instruction. That is a legitimate answer.</p> : null}
        {draftable.length > 1 ? <div className="ak-all"><Btn busy={drafting} onClick={() => onDraftAll(t.id, draftable.map((p) => p.id))}>Open all {draftable.length} as drafts</Btn><span>Each is checked as if you had written it, and does nothing until you sign it.</span></div> : null}
        {drafted ? <div ref={note} tabIndex={-1} className="ak-drafted-note"><Note tone="ok" title={`Opened ${drafted.drafted.length} draft${drafted.drafted.length === 1 ? '' : 's'}`}>{drafted.drafted.map((d) => <div key={d.programId}><Link to={`/instructions/${d.programId}`}>{d.title}</Link></div>)}{drafted.skipped.map((s) => <div key={s.proposalId} className="small">Not drafted: {s.reason}</div>)}<div className="small muted ak-gap">Each does nothing until you sign it.</div></Note></div> : null}
      </div>
    </li>
  )
}

// ------------------------------------------------------------------------------------------------ the page
export function AskScreen() {
  const { query } = useLocation()
  const current = query.get('c')
  const wide = useMedia(WIDE)
  const stored = useData<ProposalsView>('/api/proposals')
  // What is waiting on the account, so Ask opens on the owner's own position rather than on canned prompts (the finish
  // review: "Ask still looks like a chatbot"). The question each one fills in names no payee: Ask's promise is that
  // payees reach the model only as anonymous labels, and the owner's question is sent as written.
  const home = useData<HomeView>(current ? null : '/api/home')
  // the instructions, for drafts waiting on the owner and for how far each proposal's instruction has gone
  const progs = useData<{ programs: ProgramSummary[] }>('/api/programs', ['program', 'run'])
  const list = useData<{ conversations: ConvItem[] }>('/api/conversations')
  const conv = useData<Conversation>(current ? `/api/conversations/${current}` : null)
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState<{ q: string; conv: string | null; after: number } | null>(null)
  const [drafted, setDrafted] = useState<(Drafted & { turn: string }) | null>(null)
  const [sent, setSent] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const opened = useRef<string | null>(null)
  const leftRail = useEdges<HTMLDivElement>()
  const rightRail = useEdges<HTMLElement>()
  const page = useFillWindow()
  useEffect(() => { setDrafted(null); setFresh(null) }, [current])

  // the conversation on screen is the one in the address: while another loads, the last one is not shown under it
  const c = conv.data && conv.data.id === current ? conv.data : null
  const turns = c?.turns ?? []
  const at = useRef(current)
  at.current = current
  const ask = useAction(async (q: string, clarification?: { turnId: string; id: string; value: string }) => {
    const from = current
    const r = await api<{ conversationId: string }>('POST', '/api/ask', { question: q, ...(from ? { conversationId: from } : {}), ...(clarification ? { clarification } : {}) })
    list.reload(); stored.reload()
    // a person who opened another conversation while this one was answered is left where they are
    if (at.current !== from) return
    if (r.conversationId !== from) navigate(`/ask?c=${r.conversationId}`)
    else conv.reload()
  })
  /** Sending: the words move from the composer into the thread at once; if sending fails they go back to the composer. */
  const send = (text?: string) => {
    const q = (text ?? question).trim()
    if (!q || ask.busy) return
    setPending({ q, conv: current, after: turns.length })
    if (text === undefined) setQuestion('')
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }))
    void ask.run(q).then((ok) => { if (!ok) { setPending(null); setQuestion((cur) => (cur.trim() ? cur : q)) } })
  }
  /** An answer to one of QED's structured questions: the choice or the typed words go in as the person's own, and are kept with the question. */
  const answer = (t: Turn, cl: Clarify, value: string) => {
    if (ask.busy) return
    const q = `${cl.question} ${value}`
    setPending({ q, conv: current, after: turns.length })
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }))
    void ask.run(q, { turnId: t.id, id: cl.id, value }).then((ok) => { if (!ok) setPending(null) })
  }
  // A question sent from the composer docked on another page arrives here and is sent once, as typed.
  useEffect(() => { const q = takeHandedAsk(); if (q) send(q) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // the reply has arrived (or the conversation could not be read): the pending turn gives way to the real one
  useEffect(() => { if (pending && !ask.busy && conv.error) setPending(null) }, [pending, ask.busy, conv.error])

  // Where the page stands when a conversation opens or a reply arrives: an opened conversation shows its latest turn
  // (the composer is right under it); a reply is brought into view from its question down, and said to a screen reader.
  useLayoutEffect(() => {
    if (!c) return
    const last = c.turns.at(-1)
    const replied = !!pending && c.turns.length > pending.after && (pending.conv === null || pending.conv === c.id)
    if (replied && last) {
      setPending(null); setFresh(last.id); opened.current = c.id
      const props = last.proposals.length
      const words = last.answer ? last.answer.replace(/\s+/g, ' ').slice(0, 280) : `There was no usable reply. ${last.refusal ?? ''}`
      setSaid(`QED replied${props ? `, with ${props} proposal${props === 1 ? '' : 's'}` : ''}: ${words}`)
      afterPaint(() => document.getElementById(`ak-t-${last.id}`)?.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }))
    } else if (opened.current !== c.id) {
      opened.current = c.id
      if (c.turns.length > 1 && last) afterPaint(() => document.getElementById(`ak-t-${last.id}`)?.scrollIntoView({ block: 'start' }))
    }
  }, [c]) // eslint-disable-line react-hooks/exhaustive-deps

  const suggest = useAction(async () => { await api('POST', '/api/proposals/suggest'); stored.reload() })
  const focusCard = (id: string) => requestAnimationFrame(() => document.getElementById(`ak-${id}`)?.focus({ preventScroll: true }))
  const dismiss = useAction(async (id: string) => { await api('POST', `/api/proposals/${id}/dismiss`); conv.reload(); stored.reload(); focusCard(id) })
  const draftAll = useAction(async (turn: string, ids: string[]) => { setDrafted({ ...(await api<Drafted>('POST', '/api/proposals/drafts', { ids })), turn }); conv.reload(); stored.reload(); progs.reload() })
  const onSent = (proposalId: string, jobId: string) => { setSent((s) => ({ ...s, [proposalId]: jobId })); conv.reload(); focusCard(proposalId) }
  /** A starting point or one of QED's questions goes into the composer, to be read and sent by the person. */
  const fill = (q: string, add = false) => {
    setQuestion((cur) => (add ? `${cur.trim()}\n${q} `.trimStart() : q))
    requestAnimationFrame(() => { const t = box.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) } })
  }

  const ai = stored.data?.ai ?? null
  const models = stored.data?.models ?? null
  // read-only when the spending limits leave not even a routine question (server/ask-models.ts): the composer closes as it does with no model
  const readOnly = models?.readOnly ?? null
  const none = ai?.provider === 'none' || !!readOnly
  const programs = new Map((progs.data?.programs ?? []).map((x) => [x.id, x]))
  const all = new Map(turns.flatMap((t) => t.proposals).map((p) => [p.id, p]))
  const props = [...all.values()]
  const trails = useWalletTrails(props.filter((p) => p.kind.startsWith('wallet-')), sent, c)
  const inThread = new Set(all.keys())
  const earlier = (stored.data?.proposals ?? []).filter((p) => !inThread.has(p.id) && p.origin === 'rules')
  const journeyOf = (p: Prop): Journey => (ONE_OFF.has(p.kind) ? oneOffJourney(p) : p.kind.startsWith('wallet-') ? walletJourney(p, trails.get(p.id)) : paperJourney(p, p.programId ? programs.get(p.programId) : undefined))
  const journeys = new Map([...props, ...earlier].map((p) => [p.id, journeyOf(p)]))
  const label = current ? 'Reply, correct a proposal, or say “cancel”' : 'Your question'
  const amountIn = (t: string): string => /₹[\d,]+(\.\d+)?/.exec(t)?.[0] ?? 'a bill'
  const waiting: { key: string; title: string; q: string }[] = [
    ...(home.data?.needsYou ?? []).map((n) => ({ key: `n-${n.type}-${n.runId ?? n.billId ?? n.milestoneId ?? ''}`, title: n.title,
      q: n.type === 'pay-bill' ? `A bill of ${amountIn(n.title)} is due that QED will not pay on its own. Should I pay it now, and should my bills instruction cover bills like it?`
        : n.type === 'account-safety' ? 'One lost device would lose my account. What is the safest way to fix that?'
        : n.type === 'approve-run' ? 'A run of one of my instructions is waiting for my approval. What would it do, and is it still a good idea?'
        : `${n.title}. What should I do about it, and what happens if I do nothing?` })),
    ...(home.data?.notices ?? []).filter((n) => n.level === 'action' && !['run-approval', 'run-notice', 'bill-waiting', 'milestone-disputed'].includes(n.kind)).map((n) => ({ key: `x-${n.id}`, title: n.title, q: `${n.title}. What does this mean, and what can I change?` })),
    ...(current ? [] : (progs.data?.programs ?? []).filter((p) => p.state === 'draft').map((p) => ({ key: `d-${p.id}`, title: `Not signed yet: ${p.title}`, q: `What would my unsigned draft "${p.title}" do, and what is the most it could cost me?` }))),
  ].slice(0, 4)
  const convs = list.data?.conversations ?? null
  const title = c?.title ?? convs?.find((x) => x.id === current)?.title ?? 'Your conversation'
  const showPending = !!pending && (pending.conv === current || (pending.conv === null && !c))
  // the first view's body waits for what it shows of the account (what waits on the owner, unsigned drafts, the fixed
  // rules' suggestions), so it arrives whole instead of pushing its own starting points down as each part loads
  const startReady = (!!home.data || !!home.error) && (!!progs.data || !!progs.error) && (!!stored.data || !!stored.error)

  const waitingPanel = !none && waiting.length ? (
    <section className="ak-waiting" aria-labelledby="ak-wait-h" data-block="">
      <h2 id="ak-wait-h" className="ak-sec-h">Waiting on you</h2>
      <ul className="ak-wait-list">{waiting.map((w) => <li key={w.key}><button type="button" onClick={() => fill(w.q)}><span className="t">{w.title}</span><span className="a"><CornerDownRight aria-hidden="true" />Ask about this</span></button></li>)}</ul>
    </section>
  ) : null
  const guide = (
    <section className="ak-rail ak-guide" aria-labelledby="ak-guide-h">
      <h2 id="ak-guide-h">{current ? 'Carry on in your own words' : 'What you can ask'}</h2>
      {current ? (
        <ul>
          <li><b>“Make it {fmt.money(300_000)} instead”</b> replaces a proposal with a corrected one; both cards say so.</li>
          <li><b>“Why that much?”</b> asks for the reasoning behind a reply.</li>
          <li><b>“Cancel that”</b> withdraws what is still open. QED's own code does it; no model is asked.</li>
        </ul>
      ) : (
        <ul>
          <li><b>Several things at once</b> “Invest {fmt.money(200_000)} every month and park my idle cash.”</li>
          <li><b>Two limits together</b> “{fmt.money(200_000)} a week, but never more than {fmt.money(500_000)} a month.” The card says what they do together.</li>
          <li><b>Your on-chain wallet</b> “Keep 10 test dollars in my dollar reserve.”</li>
          <li><b>Then carry on</b> Correct a proposal, ask why, change a limit, or say “cancel that”.</li>
        </ul>
      )}
    </section>
  )
  const rulesLink = current ? <Link to="/ask#ak-rules" className="ak-rules-link">Suggestions without a model</Link> : <Jump to="ak-rules" className="ak-rules-link">Suggestions without a model</Jump>

  return (
    <div className={`ak${wide ? ' ak-wide' : ''}`} ref={page}>
      {wide ? (
        <div className="ak-side ak-left" ref={leftRail} data-block="">
          <nav className="ak-rail ak-convs-rail" aria-label="Conversations">
            <div className="ak-rail-head"><h2>Conversations</h2>{current ? <Link to="/ask" className="btn sm ak-new"><Plus aria-hidden="true" />New<span className="sr"> conversation</span></Link> : null}</div>
            <ConvList list={convs} current={current} />
            <div className="ak-rail-foot">{rulesLink}</div>
          </nav>
        </div>
      ) : null}

      <section className="ak-conv" aria-labelledby="ak-h1">
        {current ? (
          <header className="ak-head">
            {!wide ? <div className="ak-tools"><ConvMenu list={convs} current={current} rules={rulesLink} /><Link to="/ask" className="btn sm ak-new"><Plus aria-hidden="true" />New<span className="sr"> conversation</span></Link></div> : null}
            <h1 id="ak-h1" className="ak-title">{title}</h1>
            <div className="ak-meta"><EngineChip ai={ai} models={models} /><span className="ak-count">{c ? `${c.turns.length} turn${c.turns.length === 1 ? '' : 's'}, since ${fmt.dayTime(c.createdAt)}` : 'Reading it…'}</span></div>
            {!wide ? <p className="ak-tally">{c ? tally(props.map((p) => journeys.get(p.id)!)) : ''}</p> : null}
          </header>
        ) : (
          <header className="ak-hero">
            {!wide ? <div className="ak-tools"><ConvMenu list={convs} current={null} rules={rulesLink} /></div> : null}
            <Orb size="lg" busy={ask.busy} />
            <h1 id="ak-h1">Ask QED.<span className="dim"> What should it work out for you?</span></h1>
            <p className="ak-lede">Ask in your own words. QED answers from the figures in your records and may draft a proposal. Asking moves no money and a reply cannot act: nothing runs until you read the proposal and approve it with your passkey, and you can say “cancel” at any point before that.</p>
            <details className="disclose ak-more"><summary>How a proposal is checked</summary><p>Every proposal is checked by the same code as an instruction you write by hand, then shown to you with its limits. You can correct it, ask why, or cancel it in the same conversation. This page is a convenience: the passkey approval and the limits you signed are what authorise anything.</p></details>
            <div className="ak-meta"><EngineChip ai={ai} models={models} /></div>
          </header>
        )}

        <div className="ak-body">
          {stored.error ? <Problem error={stored.error} /> : null}
          {current && !c ? (conv.error ? <Problem error={conv.error} /> : showPending ? null : <Loading what="Opening the conversation" />) : null}
          {!current && !showPending && !startReady ? <p className="loading-line ak-start-wait" aria-busy="true">Reading what is waiting on you…</p> : null}
          {!current && !showPending && startReady ? <>
            {waitingPanel}
            {!none ? (
              <section className="ak-starters" aria-labelledby="ak-start-h" data-block="">
                <h2 id="ak-start-h" className="ak-sec-h">Start with</h2>
                <ul>{STARTERS.map((q) => <li key={q}><button type="button" onClick={() => fill(q)}><CornerDownRight aria-hidden="true" />{q}</button></li>)}</ul>
              </section>
            ) : null}
            <section id="ak-rules" tabIndex={-1} className="ak-rules" aria-labelledby="ak-rules-h" data-block="">
              <div className="ak-rules-top"><h2 id="ak-rules-h" className="ak-sec-h">Suggestions without a model</h2><p>Worked out by fixed rules from your records; each says who wrote it</p></div>
              {earlier.length ? <div className="ak-cards">{earlier.map((p) => <ProposalCard key={p.id} p={p} j={journeys.get(p.id)!} byModel={false} busy={dismiss.busy} onDismiss={(id) => void dismiss.run(id)} titleOf={() => undefined} onSent={onSent} onChanged={() => stored.reload()} />)}</div> : stored.data ? <p className="ak-quiet">Nothing on file.</p> : null}
              <div className="ak-rules-act"><Btn small busy={suggest.busy} onClick={() => void suggest.run()}>Work out suggestions by fixed rules</Btn><span>Uses only your records and arithmetic. No model is involved, and they are labelled so.</span></div>
              <Problem error={suggest.error} />
            </section>
          </> : null}

          {turns.length ? <h2 className="sr">The conversation</h2> : null}
          {turns.length ? <ol className="thread ak-thread" aria-label="The conversation">{turns.map((t) => <TurnView key={t.id} t={t} fresh={t.id === fresh} all={all} journeys={journeys} trails={trails} onDismiss={(id) => void dismiss.run(id)} dismissing={dismiss.busy} onDraftAll={(turn, ids) => void draftAll.run(turn, ids)} drafting={draftAll.busy} drafted={drafted && drafted.turn === t.id ? drafted : null} onAnswer={answer} answering={ask.busy} onAsk={(q) => fill(q, true)} onSent={onSent} onChanged={() => { conv.reload(); stored.reload() }} />)}</ol> : null}
          {showPending && pending ? (
            <div className="ak-turn ak-pending ak-fresh">
              <div className="ak-you"><p className="ak-you-text">{pending.q}</p><span className="ak-when">You, just now</span></div>
              <div className="ak-reply"><p className="ak-by"><Orb busy /><span role="status">Waiting for the reply. Nothing in your account changes while it is written.</span></p><div className="ak-wait" aria-hidden="true"><span className="skel" /><span className="skel" /><span className="skel" /></div></div>
            </div>
          ) : null}
          <Problem error={dismiss.error ?? draftAll.error} />
          <p className="sr" role="status">{said}</p>
        </div>

        <Composer box={box} label={label} none={none} current={current} question={question} setQuestion={setQuestion} busy={ask.busy} error={ask.error} onSend={() => send()}
          foot={!ai || none ? '' : ai.provider === 'scripted' ? 'Answered by a scripted test double, not a model.' : models ? <>Demanding questions go to <strong>{modelWords(models.demanding ?? models.routine ?? ai.model)}</strong>, routine ones to <strong>{modelWords(models.routine ?? ai.model)}</strong>, within QED's spending limits; each reply names the model that answered and what it cost. A demanding question can take a minute or two.</> : <>Answered by <strong>{ai.model}</strong>.{stored.data?.observed ? ` Its last reply here took ${(stored.data.observed.latency_ms / 1000).toFixed(0)} seconds.` : ' A reply can take a minute.'}</>}
          noneNote={readOnly ? <Note tone="wait" title="Ask is read-only for now">{readOnly.message}{current ? ' "Cancel" still works here, because QED handles it itself.' : ''}</Note> : none && ai ? <Note tone="wait" title="No model is connected on this computer">Ask needs a language model to draft from your words, and none is connected here. <span className="ak-detail">{ai.detail}</span> Until one is, QED can only offer suggestions worked out by fixed rules{current ? <>, under {rulesLink}; "cancel" still works here, because QED handles it itself</> : ', above'}.</Note> : null} />
      </section>

      {wide ? (
        <aside className="ak-side ak-right" ref={rightRail} aria-label={current ? 'In this conversation' : 'What you can ask'} data-block="">
          {current ? (
            <section className="ak-rail ak-sum" aria-labelledby="ak-sum-h">
              <h2 id="ak-sum-h">In this conversation</h2>
              <p className="ak-tally">{c ? tally(props.map((p) => journeys.get(p.id)!)) : 'Reading it…'}</p>
              {props.length ? <ol className="ak-sum-list">{props.map((p) => { const j = journeys.get(p.id)!; return <li key={p.id}><Jump to={`ak-${p.id}`}><span className="t">{p.analysis?.title ?? p.title}</span><Stamp tone={j.status.tone}>{j.status.label}</Stamp></Jump></li> })}</ol> : null}
            </section>
          ) : null}
          {guide}
        </aside>
      ) : null}
    </div>
  )
}

/**
 * The page fills the window: its top is measured (with any banner above it) before it is painted and kept as --ak-top,
 * so the conversation runs to the window's bottom edge and the composer rests there, with nothing to scroll below it.
 */
function useFillWindow(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => el.style.setProperty('--ak-top', `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`)
    measure()
    const watcher = new ResizeObserver(measure)
    const bar = document.querySelector('.topbar')
    if (bar) watcher.observe(bar)
    const app = el.closest('.app')
    const banners = new MutationObserver(measure)
    if (app) banners.observe(app, { childList: true })
    window.addEventListener('resize', measure)
    return () => { watcher.disconnect(); banners.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return ref
}

/** A rail that scrolls inside itself says so: the edge with more beyond it fades (data-more, ask.css). */
function useEdges<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const edges = () => { el.dataset.more = [el.scrollTop > 1 ? 'top' : '', el.scrollTop + el.clientHeight < el.scrollHeight - 1 ? 'bottom' : ''].join(' ').trim() }
    edges()
    el.addEventListener('scroll', edges, { passive: true })
    const watcher = new ResizeObserver(edges)
    watcher.observe(el)
    for (const child of Array.from(el.children)) watcher.observe(child)
    return () => { el.removeEventListener('scroll', edges); watcher.disconnect() }
  })
  return ref
}

function EngineChip({ ai, models }: { ai: ProposalsView['ai'] | null; models: ModelsLine | null }) {
  if (!ai) return <span className="ak-engine wait" aria-hidden="true" />
  const none = ai.provider === 'none'
  if (models) {
    const top = models.demanding ?? models.routine
    return <p className={`ak-engine${models.readOnly || !top ? ' off' : ''}`}>{models.readOnly || !top ? 'Read-only: the model spending limit is reached' : models.routine && models.routine !== top ? <>Answered by <b>{modelWords(top)}</b> or <b>{modelWords(models.routine)}</b></> : <>Answered by <b>{modelWords(top)}</b></>}</p>
  }
  return <p className={`ak-engine${none ? ' off' : ''}`}>{none ? 'No model connected' : ai.provider === 'scripted' ? 'Scripted test double, not a model' : <>Answered by <b>{ai.model}</b></>}</p>
}

function ConvList({ list, current }: { list: ConvItem[] | null; current: string | null }) {
  if (!list) return <p className="ak-quiet">Reading your conversations…</p>
  if (!list.length) return <p className="ak-quiet">None yet. Each question you ask starts one.</p>
  return <ol className="ak-convs">{list.map((c) => <li key={c.id}><Link to={`/ask?c=${c.id}`} current={c.id === current} className="ak-conv-link"><span className="t">{c.title}</span><span className="m">{c.turns} turn{c.turns === 1 ? '' : 's'}, {fmt.dayTime(c.updatedAt)}</span></Link></li>)}</ol>
}

/** The conversations behind one button, where the window is too narrow for the rail beside the thread. */
function ConvMenu({ list, current, rules }: { list: ConvItem[] | null; current: string | null; rules: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => { setOpen(false) }, [current])
  useEffect(() => {
    if (!open) return undefined
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="menu ak-menu" ref={box}>
      <button ref={btn} type="button" className="btn sm ak-menu-btn" aria-expanded={open} aria-controls="ak-convs-pop" onClick={() => setOpen((o) => !o)}><MessagesSquare aria-hidden="true" />Conversations{list?.length ? <span className="count">{list.length}</span> : null}</button>
      {open ? (
        <nav className="menu-pop ak-pop" id="ak-convs-pop" aria-label="Conversations">
          <ConvList list={list} current={current} />
          <div className="ak-pop-foot"><Link to="/ask" className="btn sm block"><Plus aria-hidden="true" />New conversation</Link>{rules}</div>
        </nav>
      ) : null}
    </div>
  )
}

/**
 * The composer, docked at the foot of the conversation: above the dock, and on a phone above the keyboard (the dock
 * steps aside while it is in use). It grows with what is typed, up to eight lines. Its height joins the window's scroll
 * padding (base.css) so a control taking focus is never left under it (WCAG 2.4.11).
 */
function Composer({ box, label, none, current, question, setQuestion, busy, error, onSend, foot, noneNote }: {
  box: React.RefObject<HTMLTextAreaElement | null>; label: string; none: boolean; current: string | null; question: string; setQuestion: (q: string) => void; busy: boolean
  error: ReturnType<typeof useAction>['error']; onSend: () => void; foot: ReactNode; noneNote: ReactNode
}) {
  const form = useRef<HTMLFormElement>(null)
  useKeyboardInset()
  useLayoutEffect(() => { const t = box.current; if (!t) return; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 8 * 24 + 20)}px` }, [question, box])
  useEffect(() => {
    const f = form.current, root = document.documentElement
    if (!f) return undefined
    // what the composer covers above the dock: the form and the fade above it
    const measure = () => root.style.setProperty('--composer-h', `${Math.ceil(f.getBoundingClientRect().height) + 40}px`)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(f)
    return () => { watcher.disconnect(); root.style.removeProperty('--composer-h') }
  }, [])
  // Cmd-K or Ctrl-K, which focuses Ask from every other page, focuses the composer here
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box.current?.focus() } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [box])
  return (
    <div className="ak-foot" data-block="">
      <form ref={form} className="composer ak-composer" data-composer="" onSubmit={(e) => { e.preventDefault(); if (question.trim()) onSend() }}>
        <label htmlFor="ask-q" className="sr">{label}</label>
        <div className="ak-field">
          <Orb busy={busy} />
          <textarea id="ask-q" ref={box} rows={1} maxLength={2000} placeholder={label} disabled={none && !current} value={question} aria-invalid={error?.fields.question ? true : undefined} aria-describedby="ask-q-hint"
            onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && question.trim()) { e.preventDefault(); onSend() } }} />
          <Btn tone="fill" type="submit" className="ak-send" busy={busy} disabled={(none && !current) || !question.trim()}><ArrowUp aria-hidden="true" /><span className="ak-send-t">{current ? 'Send' : 'Ask'}</span></Btn>
        </div>
        {error?.fields.question ? <p className="ak-err">{error.fields.question}</p> : null}
        <p className="ak-hint" id="ask-q-hint">{none ? null : <>Sent with a summary of your recorded position: balances, holdings, what is due. Payees are sent only as anonymous labels, never their names or addresses; earlier turns of this conversation go with it. </>}{foot} <span className="ak-keys"><kbd>⌘</kbd> or <kbd>Ctrl</kbd> with <kbd>Enter</kbd> sends.</span></p>
        {noneNote}
        {error && !error.fields.question ? <Problem error={error} /> : null}
      </form>
    </div>
  )
}
