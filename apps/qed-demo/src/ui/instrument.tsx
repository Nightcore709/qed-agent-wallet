/**
 * The instrument: the one shape in which authority is shown. A standing instruction, a run that needs approval and
 * a manual order all use it, so the owner always finds the same things in the same places: what may be done, the
 * bound (the most it may ever move, and until when), the terms, what is never allowed, how it runs, when it ends, the
 * signature, the stamp. Design system "Bounds" (DESIGN.md B5): a limit is drawn as a bracket at the limit, with what
 * is used inside it; a draft has a dashed edge and no signature; an ended instruction's bound is hatched.
 *
 * The approval sheet below is UX only: what authorises is the server's check of the passkey's signature over the
 * document's fingerprint, and the checks run again when the action is sent.
 */
import { Fingerprint } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { api, fmt, useData, useNow } from '../lib/core.ts'
import { approveWithPasskey } from '../lib/passkey.ts'
import { Basis, Btn, Link, Note, Problem, Seal, Sheet, Stamp, useAction, useSession } from './kit.tsx'
import { HoldButton } from './hold.tsx'

export interface AuthDoc {
  v: number; kind: string; title: string; may: string[]; limits: string[]; ceiling: string; ceilingPaise: number | null; notLimited: string[]
  conditions: string[]; never: string[]; mode: string; ends: string; stop: string; consequences: string[]; basis: string[]
  /** Contradictions the owner accepted before signing (R7-093); part of what the passkey signs. */
  accepted?: string[]
  /** Who drafted it, when a model did (N-006); part of what the passkey signs. */
  drafted?: string
  params: Record<string, unknown>; authority: { maxPerRun: number; maxPerDay: number | null; maxPerMonth: number; expiresAt: number; runMode: string; noticeSec: number; maxSlippageBps: number; maxRuns: number | null }
}

function amountInWords(doc: AuthDoc): string | null {
  const p = doc.params as { amount?: number; plan?: Record<string, number>; capPerBill?: number }
  if (typeof p.amount === 'number') return `${fmt.words(p.amount)}, each time.`
  if (p.plan) { const total = Object.values(p.plan).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) * 100; return total > 0 ? `${fmt.words(total)} in all.` : null }
  if (typeof p.capPerBill === 'number') return `No bill above ${fmt.words(p.capPerBill).replace(/^Rupees /, 'rupees ').replace(/ only$/i, '')}.`
  return null
}

export interface Signature { name: string; at: number; hash: string; method?: string | null }
export function InstrumentDoc({ doc, state, version, signature, stamp, counterfoil }: {
  doc: AuthDoc; state: 'draft' | 'review' | 'inforce' | 'held' | 'ended'; version?: number
  signature?: Signature | null; stamp?: { label: string; sub?: string; tone?: 'ok' | 'wait' | 'void' | 'plain' } | null; counterfoil?: ReactNode
}) {
  const words = amountInWords(doc)
  // Documents signed before the ceiling was stored as a figure carry it as a sentence only. The sentence is the signed
  // text, so the same line is read out of it; if it cannot be, the sentence is shown whole, never a blank.
  const old = /at most (₹[\d,]+(?:\.\d+)?) before (\d{1,2} [A-Za-z]{3} \d{4})/.exec(doc.ceiling ?? '')
  const crossing = doc.ceilingPaise === null || /can sell up to everything/.test(doc.ceiling ?? '') && typeof doc.ceilingPaise !== 'number' ? 'Sells only. Never buys, never pays anyone.'
    : typeof doc.ceilingPaise === 'number' ? `Not over ${fmt.money(doc.ceilingPaise)} before ${fmt.dayYear(doc.authority.expiresAt)}` : old ? `Not over ${old[1]} before ${old[2]}` : doc.ceiling
  const term = (name: string, body: ReactNode, cls?: string) => <div className={cls}><dt>{name}</dt><dd>{body}</dd></div>
  const list = (xs: string[]) => <ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul>
  return (
    <article className={`idoc ${state}`} aria-label={`Instruction: ${doc.title}`}>
      <div className="doc-head">
        <span>Standing instruction{version ? `, version ${version}` : ''}</span>
        <span>{signature ? `Signed ${fmt.dayTime(signature.at)}` : state === 'review' ? 'Not signed yet' : 'Draft, not signed'}</span>
      </div>
      <div className="doc-body">
        {doc.may.map((m, i) => <p className="doc-pay" key={i}>{m}</p>)}
        {words ? <p className="doc-words">{words}</p> : null}
        <p className="doc-bound"><i aria-hidden="true" /><span>{crossing}</span></p>
        <dl className="doc-terms">
          {doc.limits.length ? term('Limits', list(doc.limits)) : null}
          {term('Only if', list(doc.conditions))}
          {term('Never', list(doc.never), 'never')}
          {term('Not limited', list(doc.notLimited))}
          {term('How', doc.mode)}
          {term('Ends', doc.ends)}
          {term('Stopping', doc.stop)}
          {doc.drafted ? term('Drafted by', doc.drafted) : null}
          {doc.accepted?.length ? term('You accepted', list(doc.accepted), 'accepted') : null}
          {/* R12: what signing means, from the signed document itself, on the sheet where it is signed */}
          {state === 'review' && doc.consequences?.length ? term('What signing it means', list(doc.consequences)) : null}
        </dl>
        <div className="doc-sign">
          {signature
            ? <div className="signature doc-signature"><div className="name">{signature.name}</div><small>Signed {signature.method === 'passkey' ? 'with your passkey' : signature.method === 'password' || signature.method === 'recent-password' ? 'with your password' : 'by you'}, {fmt.full(signature.at)}.<br />Document <span className="code">{fmt.hash(signature.hash)}</span></small></div>
            : <div className="signature unsigned doc-signature"><div className="name">Your signature</div></div>}
          {stamp ? <Stamp big tone={stamp.tone} sub={stamp.sub}>{stamp.label}</Stamp> : null}
        </div>
      </div>
      {counterfoil ? <div className="doc-foil">{counterfoil}</div> : null}
    </article>
  )
}

export interface PendingApproval { approvalId: string; docHash: string; expiresAt: number; requiresStepUp: boolean }
/** The last two minutes, counted exactly: "1 minute 50 seconds" (a rounded "2 minutes" beside "less than two minutes left" reads as a contradiction). */
const exactly = (ms: number): string => {
  const t = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(t / 60), r = t % 60
  const secs = `${r} second${r === 1 ? '' : 's'}`
  return m ? `${m} minute${m === 1 ? '' : 's'}${r ? ` ${secs}` : ''}` : secs
}

/**
 * What a request relies on that was prepared in a session opened with a password, not with a passkey (RISK-076): the
 * server writes one sentence for each such part into the document the passkey signs, and the approval's view returns
 * them. They are said first, and the passkey is offered only once they have been read for this request.
 */
function usePrepared(approvalId: string | null): { read: boolean; note: ReactNode; renewable: boolean; skew: number } {
  const v = useData<{ id: string; prepared: string[]; renewable?: boolean; serverNow?: number }>(approvalId ? `/api/approvals/${approvalId}` : null)
  const mine = v.data?.id === approvalId ? v.data : null
  // the server's time when this read was answered, against the page's: the countdown runs on the server's clock, so a
  // page whose clock is behind still warns before the server lapses the request (review of R12, L1)
  const [skew, setSkew] = useState(0)
  useEffect(() => { if (typeof mine?.serverNow === 'number') setSkew(mine.serverNow - Date.now()) }, [mine?.serverNow]) // eslint-disable-line react-hooks/exhaustive-deps
  return {
    skew,
    read: !!mine,
    // whether the server would keep this request open with the same terms (server/approvals.ts renewTtl)
    renewable: !!mine?.renewable,
    note: mine?.prepared.length ? <Note tone="wait" title="Not all of this was prepared with a passkey">{mine.prepared.map((p) => <p key={p}>{p}</p>)}<p>If this is not your own work, do not approve it.</p></Note> : !mine && v.error ? <Problem error={v.error} /> : null,
  }
}

/**
 * The signing step. It shows exactly what will be approved (the children), names the document's fingerprint, and asks
 * the owner's passkey to sign those exact terms (the device makes its own check, whichever it uses; the
 * signature covers this approval and nothing else). Declining needs no ceremony.
 */
export function ApprovalSheet({ approval, title, action, children, onApproved, onClose, signer, prompts = 1, devices = 1, withdrawOnClose = true }: {
  approval: PendingApproval | null; title: string; action: string; children: ReactNode; onApproved: (approvalId: string) => Promise<void>
  /** `stillOpen` is true when the request was signed in part and stays open for the other members: nothing is withdrawn. */
  onClose: (stillOpen?: boolean) => void
  /** How the passkey signs. Defaults to one signature over the approval document; an on-chain vault signs its own digests. */
  signer?: (approvalId: string, docHash: string, onNextDevice?: (done: number, needed: number) => void) => Promise<{ complete: boolean; signed: number; required: number }>
  /** How many passkey prompts signing takes (one per digest for a vault), said before the first one appears. */
  prompts?: number
  /** R13: how many of the person's own devices sign each digest ("Require two of your devices"); said before, and between rounds. */
  devices?: number
  /** False when someone reviews another member's request: closing it, or "Not now", withdraws nothing. */
  withdrawOnClose?: boolean
}) {
  const { session, reload } = useSession()
  const now = useNow(1000)
  const [waiting, setWaiting] = useState<{ signed: number; required: number } | null>(null)
  // the three steps of approving, said as they happen: confirming is the person's intent, signing is the passkey's
  // signature over the document, sending is QED carrying it out; settling and the receipt come after, on the record
  const [phase, setPhase] = useState<'confirm' | 'sign' | 'send'>('confirm')
  // R13: after one device has signed, the sheet says so and asks for the next (the prompts are the operating system's)
  const [nextDevice, setNextDevice] = useState<{ done: number; needed: number } | null>(null)
  // "Keep it open" (WCAG 2.2.1; R12 task comparison, gap 10): the server issues a fresh request for the same document,
  // the same fingerprint; from then on the sheet signs, sends and withdraws that one
  const [renewed, setRenewed] = useState<{ of: string; id: string; expiresAt: number } | null>(null)
  useEffect(() => { setWaiting(null); setPhase('confirm'); setRenewed(null); setNextDevice(null) }, [approval?.approvalId])
  const cur = approval && renewed?.of === approval.approvalId ? { ...approval, approvalId: renewed.id, expiresAt: renewed.expiresAt } : approval
  const sign = useAction(async () => {
    if (!cur) return
    setPhase('sign')
    try {
      const r = signer ? await signer(cur.approvalId, cur.docHash, (done, needed) => setNextDevice({ done, needed })) : await approveWithPasskey(cur.approvalId, cur.docHash)
      // In a business workspace other members may still have to sign; it takes effect when the last one does.
      if (!r.complete) { setWaiting({ signed: r.signed, required: r.required }); setPhase('confirm'); return }
      setPhase('send')
      await onApproved(cur.approvalId)
      void reload()
    } catch (e) { setPhase('confirm'); setNextDevice(null); throw e }
  })
  const prepared = usePrepared(cur?.approvalId ?? null)
  const left = cur ? cur.expiresAt - (now + prepared.skew) : 0
  const expired = !!cur && left <= 0
  const noPasskey = session.authenticated && session.hasPasskey === false
  // R12: the passkey this session was opened with, or every passkey of the account, signs in only (added by a recovery
  // or after a password reset): nothing is approved from here until its authority is restored
  const restricted = session.authenticated && (session.authority === 'restricted' || session.passkeyAuthority === 'signin')
  const renew = useAction(async () => {
    if (!approval || !cur) return
    const r = await api<{ approvalId: string; docHash: string; expiresAt: number }>('POST', `/api/approvals/${cur.approvalId}/renew`)
    setRenewed({ of: approval.approvalId, id: r.approvalId, expiresAt: r.expiresAt })
  })
  // two minutes before it lapses, said once and shown with the way to keep it open; its lapse is said too
  const warn = !!cur && !waiting && !expired && left <= 120_000 && prepared.renewable
  const spoken = expired ? 'This request has expired. Close it and prepare it again.'
    : warn ? 'Less than two minutes are left to approve this. Choose “Keep it open” for ten more minutes with the same terms.'
    : renewed && cur ? `Kept open with the same terms. It now expires at ${fmt.time(cur.expiresAt)}.` : ''
  return (
    // A request signed in part waits for the other members: closing the sheet then withdraws nothing.
    <Sheet open={!!approval} title={title} onClose={() => { if (waiting || !withdrawOnClose) { onClose(true); return } if (cur && !sign.busy) void api('POST', `/api/approvals/${cur.approvalId}/cancel`).catch(() => {}); onClose() }}
      foot={approval ? <>
        {waiting ? null : <Btn onClick={() => { if (!withdrawOnClose) { onClose(true); return } void api('POST', `/api/approvals/${(cur ?? approval).approvalId}/cancel`).catch(() => {}); onClose() }}>Not now</Btn>}
        {waiting ? <Btn tone="fill" onClick={() => onClose(true)}>Close</Btn> : <span className="approve-act">
          <HoldButton label={`Hold to ${action.charAt(0).toLowerCase()}${action.slice(1)}`} termsKey={approval.docHash} busy={sign.busy} disabled={expired || noPasskey || restricted || !prepared.read} describedBy="hold-why" onConfirm={() => void sign.run()} />
          <span className="approve-once">or, in one step, <button type="button" className="linkish" disabled={sign.busy || expired || noPasskey || restricted || !prepared.read} onClick={() => void sign.run()}>{`${action} with your passkey`}</button></span>
        </span>}
      </> : null}>
      {approval ? <>
        <ol className="phases" aria-label="Approving">
          {(['confirm', 'sign', 'send'] as const).map((p, i) => {
            const at = ['confirm', 'sign', 'send'].indexOf(phase)
            return <li key={p} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}><i aria-hidden="true">{i + 1}</i>{p === 'confirm' ? 'You confirm' : p === 'sign' ? 'Your passkey signs' : 'QED sends it'}</li>
          })}
        </ol>
        <div className={`signing ${expired ? 'expired' : ''}`}>
          <span className="signing-icon" aria-hidden="true"><Fingerprint /></span>
          <p><strong>{signer ? 'Your passkey signs the digests listed below and nothing else' : 'Your passkey signs exactly what is shown below and nothing else'}</strong>
            <span>{expired ? <strong>This request has expired; close it and prepare it again.</strong> : <>This request expires {left <= 120_000 ? `in ${exactly(left)}` : fmt.rel((cur ?? approval).expiresAt, now)}.</>}</span></p>
        </div>
        <p className="sr" role="status">{spoken}</p>
        {warn ? <Note tone="wait" title="Less than two minutes left">
          <p>Keep it open to have ten more minutes. The terms and their fingerprint stay exactly the same.</p>
          <div><Btn busy={renew.busy} onClick={() => void renew.run()}>Keep it open</Btn></div>
        </Note> : null}
        {renew.error ? <Problem error={renew.error} /> : null}
        {/* said before the terms, where it is seen first: the approval cannot be given from this session (R12) */}
        {restricted ? <Note tone="wait" title="Your passkey cannot approve this yet">It was added by a recovery or after a password reset, so it signs you in but approves nothing until it is given approval authority, after a wait that your other devices and recovery contacts can stop. <Link to="/security#authority">Ask for approval authority</Link></Note> : null}
        {prepared.note}
        {children}
        {prompts > 1 ? <p className="small"><strong>Your passkey will ask {prompts} times</strong>, once for each digest listed above. Nothing is sent until all {prompts} are signed.</p> : null}
        {devices > 1 ? <p className="small"><strong>This wallet needs {devices} of your devices.</strong> Sign with one passkey, then with {devices === 2 ? 'another' : 'each of the others'} when asked: the chain counts different passkeys, and one alone moves nothing.</p> : null}
        {nextDevice ? <p className="small" role="status"><strong>Signed with {nextDevice.done} of {nextDevice.needed} devices.</strong> Now confirm with your other device: a passkey of yours you have not used for this request.</p> : null}
        <p className="small muted" id="hold-why">Holding the button is how you say you mean it; your passkey is what approves. Letting go before it fills cancels. Settling and the receipt follow on the record.</p>
        <p className="small muted fingerprint"><Seal /><span>{signer ? <>Each digest commits to exactly these terms on the chain. This approval's document has the fingerprint <span className="code">{fmt.hash(approval.docHash)}</span>, stored with whatever runs under it.</> : <>The document's fingerprint is <span className="code">{fmt.hash(approval.docHash)}</span>; the same fingerprint is stored with whatever runs under it.</>}</span></p>
        {waiting ? <Note tone="ok" title={`Signed: ${waiting.signed} of ${waiting.required}`}>This workspace needs {waiting.required} members to sign. It takes effect when {waiting.required - waiting.signed === 1 ? 'one more member signs' : `${waiting.required - waiting.signed} more members sign`}; they will find it under Workspace, in the requests waiting for signatures.</Note> : null}
        {noPasskey ? <Note tone="wait" title="This account has no passkey yet">Approvals need a passkey. Add one under <Link to="/security">Security</Link>.</Note> : null}
        {sign.error ? <Problem error={sign.error} /> : null}
      </> : null}
    </Sheet>
  )
}

/** The basis lines of an approval document (what its figures rest on), or none when it cannot be read. */
export function basisOf(document: string | undefined): string[] {
  if (!document) return []
  try { const b = (JSON.parse(document) as { basis?: unknown }).basis; return Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
const RESERVE = 'Bank reserve: '

/**
 * Lines of a preview for a manual action: the action as one sentence, then each term with what kind of figure it is,
 * then what it leaves in the bank and in the worst case. Every row is a figure of the document the passkey signs: the
 * bank row is the document's own sentence about what must stay (its basis), not a figure worked out here.
 */
export function ActionDoc({ summary, lines, warnings, worst, document }: { summary: string; lines: { label: string; value: string; basis: string; note?: string }[]; warnings: string[]; worst?: { before: number; after: number; line: number }; document?: string }) {
  const basis = basisOf(document)
  const reserve = basis.find((b) => b.startsWith(RESERVE))
  const rest = basis.filter((b) => b !== reserve)
  const falls = worst ? worst.before - worst.after : 0
  return (
    <article className="adoc" aria-label={summary}>
      <div className="doc-head"><span>One action, by your hand</span><span>Not signed yet</span></div>
      <div className="doc-body">
        <p className="doc-pay">{summary}.</p>
        {warnings.map((w, i) => <p key={i} className="doc-warn">{w}</p>)}
        <dl className="doc-lines">
          {lines.map((l, i) => <div key={i}><dt>{l.label}</dt><dd><strong>{l.value}</strong>{l.basis ? <Basis kind={l.basis} /> : null}{l.note ? <span className="doc-note">{l.note}</span> : null}</dd></div>)}
          {reserve ? <div><dt>Your bank</dt><dd><span className="doc-said">{reserve.slice(RESERVE.length)}</span></dd></div> : null}
          {worst ? <div><dt>Worst case</dt><dd><strong>{fmt.money(worst.before)} now, {fmt.money(worst.after)} after</strong><span className="doc-note">{falls > 0 ? `It falls by ${fmt.money(falls, true)}. ` : falls < 0 ? `It rises by ${fmt.money(-falls, true)}. ` : 'It does not change. '}All you have if prices fall to your limits, less what you owe. Your floor is {fmt.money(worst.line)}.</span></dd></div> : null}
        </dl>
        <p className="doc-foot">Done once, on paper. It is checked again against prices and your balance at the moment it is sent.</p>
        {rest.length ? <details className="doc-basis"><summary>What these figures rest on</summary><ul>{rest.map((b, i) => <li key={i}>{b}</li>)}</ul></details> : null}
      </div>
    </article>
  )
}

/**
 * A limit in one row (DESIGN.md B5): the bracket is the limit, the fill inside it is what has been used, and the words
 * say used, left, limit and period, so the bar never carries a figure alone (it is hidden from screen readers).
 */
export function Bound({ used, limit, period }: { used: number; limit: number; period: string }) {
  const u = Math.max(0, Math.min(used, limit)), left = Math.max(0, limit - used)
  return (
    <div className="bnd">
      <span className="bnd-bar" aria-hidden="true"><i style={{ width: `${limit > 0 ? ((u / limit) * 100).toFixed(2) : 0}%` }} /></span>
      <span className="bnd-text">{fmt.money(Math.max(0, used))} used, <b>{fmt.money(left)} left</b> of {fmt.money(limit)} {period}</span>
    </div>
  )
}
