/**
 * Earn's work paid through the escrow on the chain (design system "Meridian"; the page is src/screens/Earn.tsx): the
 * section, its escrow at true scale, each job on its route, the steps each side takes, and the form for a new job.
 * It is its own module because it brings the on-chain wallet's approval (useVaultApproval, src/screens/Vault.tsx) with
 * it: Earn loads it after its head has drawn, so the head does not wait for the wallet's code (DESIGN.md M11).
 * A step is approved by the passkey's signature over its exact terms in the wallet's approval sheet; pressing a button
 * here only asks for those terms.
 */
import { Plus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { Job as VaultJob } from '../../chain/types.ts'
import { api, fmt, type Resource } from '../lib/core.ts'
import { chainPlace, type ChainDispute, type ChainJob, type ChainMilestone, type ChainView, Composer, type DisputeDefaults, DOING, JobCard, listed, MsRow, otherOf, type Parts, partsOf, type Role, whose, WorkSkeleton } from '../screens/Earn.tsx'
import { useVaultApproval } from '../screens/Vault.tsx'
import { Btn, Field, Link, MoneyInput, Note, Problem, Seal, useAction } from './kit.tsx'

/** A chain milestone's money in words; its stamp's colour is whose move it is (moveTone). */
const C_STATE: Record<string, string> = { 'chain-draft': 'Not offered yet', 'chain-offered': 'Offered', 'chain-expired': 'Offer lapsed', 'chain-funded': 'In escrow', 'chain-review': 'Verified, under review', 'chain-disputed': 'Disputed', 'chain-released': 'Paid, verified', 'chain-refunded': 'Refunded', 'chain-split': 'Split' }
/** The service's sentence with its times in India time. */
const inWords = (t: string): string => t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (x) => fmt.dayTime(Date.parse(x)))
/** The wallet service's own sentence in this page's terms: India time, rupees, and no raw identifiers (the record keeps those). */
const plain = (t: string): string => inWords(t).replace(/\s*\(?0x[0-9a-fA-F]{6,}…?\)?/g, '').replace(/(\d[\d,]*\.\d{2}) tINR/g, (_x, n: string) => fmt.inr(Math.round(Number(n.replace(/,/g, '')) * 100), true))
const when = (iso: string | null): string => (iso ? fmt.dayTime(Date.parse(iso)) : '')
const uuidKey = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
/** A step asked for and not yet signed, as the rest of its sentence: "You asked to fund it and have not signed yet." */
const ASKED: Record<string, string> = { quote: 'offer it', fund: 'fund it', deliver: 'deliver it', release: 'release it', accept: 'accept it', dispute: 'dispute it', evidence: 'add evidence', decide: 'rule on it', 'give-way': 'refund the client' }

/**
 * A step waiting for a signature, or being recorded, in plain words: whose signature, that nothing moves without it,
 * and for this side's own request when it lapses by itself. Exported for the unit test.
 */
export function waitingWords(p: NonNullable<ChainMilestone['pending']>, other: string): string {
  const asked = ASKED[p.action] ?? p.action
  if (p.status === 'sending') return `Being recorded on the chain: ${DOING[p.action] ?? p.action}.`
  if (!p.yours) return `${other} has asked to ${asked} and has not signed yet. Nothing moves until they do.`
  const lapses = p.expiresAt ? `; if you leave it, the request lapses by itself at ${fmt.time(Date.parse(p.expiresAt))}` : '; if you leave it, the request lapses by itself'
  return `You asked to ${asked} and have not signed yet. Nothing moves until your passkey signs it${lapses}.`
}

/**
 * A kind of work's money through the escrow at true scale: paid, held, gone back and not funded yet on one bar, then
 * the same parts as figures that add up, then who holds what is held. Held money is never yours until it is paid.
 */
function EscrowSum({ parts, role, who }: { parts: Parts; role: Role; who: ReactNode }) {
  const total = parts.paid + parts.held + parts.back + parts.open
  if (total <= 0) return null
  const pc = (v: number) => `${((v / total) * 100).toFixed(3)}%`
  const terms: [keyof Parts, number, string][] = [
    ['paid', parts.paid, role === 'client' ? 'Paid to them' : 'Paid to your wallet'],
    ['held', parts.held, role === 'client' ? 'Held from your wallet' : 'Held by the escrow'],
    ['back', parts.back, role === 'client' ? 'Back to you' : 'Back to the client'],
    ['open', parts.open, role === 'client' ? 'Offered, not funded' : 'Not funded yet'],
  ]
  const shown = terms.filter(([k, v]) => v > 0 || k === 'paid' || k === 'held')
  return (
    <div className="panel er-sum">
      <span className="er-segs er-sum-bar" aria-hidden="true">{terms.filter(([, v]) => v > 0).map(([k, v]) => <span key={k} className={`er-seg ${k === 'held' ? 'them' : k}`} style={{ width: pc(v) }} />)}</span>
      <dl className="er-sum-figs">
        {shown.map(([k, v, w]) => <div key={k}><dt><i className={`er-sw ${k === 'held' ? 'them' : k}`} aria-hidden="true" />{w}</dt><dd>{fmt.inr(v, true)}</dd></div>)}
        <div className="all"><dt>In all, in test rupees</dt><dd>{fmt.inr(total, true)}</dd></div>
      </dl>
      <p className="er-sum-who">{who}</p>
    </div>
  )
}

/**
 * Work paid through the escrow on the chain (R7-054): a job for another QED account, each milestone one job of the
 * release's proof escrow between the two wallets. The provider offers it (its passkey signs the quote), the client funds
 * it from its own wallet, the provider delivers a certificate the verifier on the chain checks, and the escrow pays at
 * once. There is no acceptance or dispute: without verified work by the deadline, the client takes the money back.
 * Titles and asset names come from the other party and are shown as they wrote them, as plain text.
 */
export function ChainWork({ v, primary }: { v: Resource<ChainView>; primary: string | null }) {
  const [adding, setAdding] = useState(false)
  const busyOnChain = !!v.data && [...v.data.asProvider, ...v.data.asClient, ...(v.data.asDecider ?? [])].some((j) => j.milestones.some((m) => m.pending || m.state === 'chain-offered' || m.state === 'chain-funded' || m.state === 'chain-review' || m.state === 'chain-disputed' || m.authority?.status === 'pending'))
  useEffect(() => { if (!busyOnChain) return undefined; const t = setInterval(v.reload, 4000); return () => clearInterval(t) }, [busyOnChain, v.reload])
  const va = useVaultApproval({ stay: true, onDone: () => v.reload() })
  const [asked, setAsked] = useState<Asked | null>(null)
  // a step that needs words or an amount first (a dispute, evidence, a ruling) opens its form in the row
  const [asking, setAsking] = useState<{ id: string; action: 'dispute' | 'evidence' | 'decide' } | null>(null)
  const step = useAction(async (m: ChainMilestone, action: string, other: string, role: Role, body: Record<string, unknown> = {}) => {
    const path = `/api/earn/chain/milestones/${m.id}/${action}`
    va.clear() // an earlier step's outcome never stands for this one
    setAsked({ id: m.id, action, amount: m.amount, other, role, deliverBy: m.deliverBy })
    // anyone may apply a refund or a timeout once it is due: no passkey, the rail's relayer sends it
    if (action === 'refund' || action === 'finish') { const a = await api<{ jobId: string }>('POST', path, { key: uuidKey() }); va.watch(a.jobId); v.reload(); return }
    const t = m.dispute?.terms
    const titles: Record<string, string> = { quote: 'Approve: offer this work', fund: 'Approve: fund this work from your wallet', deliver: 'Approve: deliver the work', release: 'Approve: release the client', accept: 'Approve: accept the work', dispute: 'Approve: dispute the work', evidence: 'Approve: add your evidence', decide: 'Approve: your ruling', 'give-way': 'Approve: refund the client' }
    const intro: Record<string, string> = {
      quote: `Your passkey signs an offer to ${other}: ${fmt.inr(m.amount, true)} for this milestone, delivered within ${m.deliverWithinHours} hours. Nothing moves until ${other} funds it from their wallet.`,
      fund: m.dispute ? `${fmt.inr(m.amount, true)} leaves your wallet's free money and is held by the escrow. Once the verifier on the chain accepts the work, delivered by ${when(m.deliverBy)}, QED's dispute escrow holds it for your review; without verified work by then you can take it back. @${m.dispute.decider.handle} decides a dispute. The terms, which ${other}'s signature binds:` : `${fmt.inr(m.amount, true)} leaves your wallet's free money and is held by the escrow. It is paid to ${other} only for work the verifier on the chain accepts by ${when(m.deliverBy)}; after that you can take it back.`,
      deliver: `The certified answer goes to the escrow. The verifier on the chain checks it first; if it holds, ${fmt.inr(m.amount, true)} is paid into your wallet in the same step.`,
      release: `The escrow returns ${fmt.inr(m.amount, true)} to ${other} now, and you give up this milestone.`,
      accept: `The dispute escrow pays ${fmt.inr(m.amount, true)} to ${other} now${m.state === 'chain-disputed' ? ', and your dispute ends' : ''}. This cannot be undone.`,
      dispute: `The money stays in the dispute escrow. Both sides have ${t?.evidence ?? 'the evidence period'} to add evidence; then @${m.dispute?.decider.handle ?? 'the decider'} rules, at the latest ${t?.decision ?? 'by the deadline'} from now. With no ruling by then, ${t ? `${t.onDecisionPct}%` : 'the terms\' share'} goes to ${other}. Your reason is kept by QED; only its fingerprint goes on the chain.`,
      evidence: 'Your evidence is kept by QED and shown to the other side and the decider; only its fingerprint goes on the chain. It moves no money.',
      decide: `As the named decider you rule: ${typeof body.toProvider === 'number' ? `${fmt.inr(body.toProvider, true)} to the provider and ${fmt.inr(m.amount - body.toProvider, true)} to the client` : 'how the price is shared'}, paid by the dispute escrow now. The ruling is final on the chain, and you receive nothing.`,
      'give-way': `The dispute escrow refunds ${fmt.inr(m.amount, true)} to ${other} now, and you give up the payment for this work. This cannot be undone.`,
    }
    await va.start(path, body, { title: titles[action] ?? 'Approve', intro: <>{<p>{intro[action]}</p>}{action === 'fund' && t?.words ? <DisputeTermsList words={t.words} /> : null}</> })
    setAsking(null)
    v.reload()
  })
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const withdraw = useAction(async (m: ChainMilestone) => {
    setWithdrawing(m.id)
    if (m.pending?.approvalId) await api('POST', `/api/approvals/${m.pending.approvalId}/cancel`).catch(() => {})
    if (m.pending?.proposalId) await api('POST', `/api/vault/proposals/${m.pending.proposalId}/cancel`).catch(() => {})
    v.reload()
  })
  /*
   * Signing a step asked for earlier (the page was left with its approval open, or it was asked for elsewhere): the
   * earlier request is withdrawn, the server reads the withdrawal back, and only then is the step asked for again, so
   * the passkey signs the terms as they stand now and the two requests never cross.
   */
  const resume = useAction(async (m: ChainMilestone, other: string, role: Role) => {
    const action = m.pending?.action
    if (!action) return
    setWithdrawing(m.id)
    if (m.pending?.approvalId) await api('POST', `/api/approvals/${m.pending.approvalId}/cancel`).catch(() => {})
    if (m.pending?.proposalId) await api('POST', `/api/vault/proposals/${m.pending.proposalId}/cancel`).catch(() => {})
    await api('GET', '/api/earn/chain').catch(() => {})
    await step.run(m, action, other, role)
  })
  const prepare = <Btn onClick={() => setAdding(true)}><Plus aria-hidden="true" />Prepare a job for another account</Btn>
  const all = v.data ? [...v.data.asProvider.map((j) => ({ j, role: 'provider' as const })), ...v.data.asClient.map((j) => ({ j, role: 'client' as const }))] : []
  // jobs this household was named to decide on: shown with the client's view of the route, and its own steps
  const deciding = v.data?.asDecider ?? []
  const head = (
    <div className="er-kind-head">
      <div><h2 id="cw-h">Work paid through escrow on the chain</h2><p>In test rupees, between two QED accounts in this installation. You offer each milestone with your passkey; the client funds it from their wallet; the escrow pays you the moment the verifier on the chain accepts the certificate you deliver. Without checked work by the deadline, the client takes the money back.</p></div>
      {v.data && all.length && !adding ? prepare : null}
    </div>
  )
  const composer = adding ? <Composer title="A new job, for another QED account" onClose={() => setAdding(false)}><NewChainJob defaults={v.data?.disputeDefaults ?? null} testStack={!!v.data?.testStack} onDone={() => { setAdding(false); v.reload() }} /></Composer> : null
  if (!v.data) return <section aria-labelledby="cw-h" className="er-kind chain-work">{head}{composer}{v.error ? <div className="er-problem"><Problem error={v.error} /><Btn small onClick={v.reload}>Try again</Btn></div> : <WorkSkeleton what="Reading work in the escrow from the chain" />}</section>
  const d = v.data
  const asProvider = d.asProvider.flatMap((j) => j.milestones.map((m) => ({ amount: m.amount, place: chainPlace(m, d.reachable) })))
  const asClient = d.asClient.flatMap((j) => j.milestones.map((m) => ({ amount: m.amount, place: chainPlace(m, d.reachable) })))
  // an error shows in the row the step was taken from; one whose row has gone shows under the section
  const failed = step.error ?? va.error ?? resume.error
  const inRow = (id: string) => (asked?.id === id ? failed : null) ?? (withdrawing === id ? withdraw.error : null)
  const rowless = (failed && !all.some(({ j }) => j.milestones.some((m) => m.id === asked?.id)) ? failed : null) ?? (withdraw.error && !all.some(({ j }) => j.milestones.some((m) => m.id === withdrawing)) ? withdraw.error : null)
  return (
    <section aria-labelledby="cw-h" className="er-kind chain-work">
      {head}
      {composer}
      {!d.reachable ? (
        <div className="er-down">
          <Note tone="wait" title="The on-chain wallet's service is not answering">
            <p>This is what QED last read from it, and it may have moved on. Until the service answers, nothing here can be offered, funded, delivered or refunded, and whose move each milestone is cannot be known.</p>
            <p>QED cannot send anything to the chain meanwhile, but the deadlines keep running: an offer can lapse, or a delivery time pass. Your work on paper is not affected.</p>
          </Note>
          <Btn small onClick={v.reload}>Try again</Btn>
        </div>
      ) : null}
      {all.length === 0 && !adding ? (
        <div className="panel er-empty">
          <p>No work through the escrow yet. Prepare a job for another QED account that has an on-chain wallet: nothing is offered until your passkey signs each milestone's offer, and nothing moves until they fund it.</p>
          {prepare}
        </div>
      ) : null}
      {all.length ? (
        <details className="er-how small">
          <summary>How work through the escrow is paid</summary>
          <p>For work a verifier on the chain can check: you offer it to another QED account, they put the money in escrow from their wallet, and the escrow pays you as soon as the certificate you deliver checks out. There is no approving or disputing: without checked work by the deadline, they take the money back. A payment from a client outside your own accounts also adds half its price to what QED may pay out on its own.</p>
        </details>
      ) : null}
      {asProvider.length ? <EscrowSum parts={partsOf(asProvider)} role="provider" who={partsOf(asProvider).held > 0 ? 'Held by the escrow contract on the test chain on this QED installation, from the client\'s wallet: paid into your wallet the moment the verifier accepts your certificate, and refundable to the client once the deadline has passed.' : 'Nothing is held now. The escrow holds money only once a client funds an offer, and pays it into your wallet the moment the verifier accepts your certificate.'} /> : null}
      {all.filter((x) => x.role === 'provider').map(({ j, role }) => job(j, role))}
      {asClient.length ? <>
        <h3 className="er-sub">Work you pay for</h3>
        <EscrowSum parts={partsOf(asClient)} role="client" who={partsOf(asClient).held > 0 ? 'Held by the escrow contract, from your wallet: paid to the provider only for work the verifier accepts by the deadline; after it you can take the money back.' : 'Nothing of yours is held now: money leaves your wallet only when you fund an offer.'} />
      </> : null}
      {all.filter((x) => x.role === 'client').map(({ j, role }) => job(j, role))}
      {deciding.length ? <>
        <h3 className="er-sub">Disputes you were named to decide</h3>
        <p className="small faint">Each was named in terms both sides accepted. You may rule only on a dispute, after its evidence period and by its deadline, and only as the terms allow; you are paid nothing, and the money can go only to the two of them.</p>
      </> : null}
      {deciding.map((j) => job(j, 'client', true))}
      {asked && ![...all.map(({ j }) => j), ...deciding].some((j) => j.milestones.some((m) => m.id === asked.id)) ? <ChainOutcome job={va.job} asked={asked} /> : null}
      <Problem error={rowless} />
      {va.sheet}
    </section>
  )

  /** One job on the chain, as this side sees it: a card with its route, its milestones on it. */
  function job(j: ChainJob, role: Role, decider = false) {
    const { named, other } = otherOf(j, role)
    const places = j.milestones.map((m) => chainPlace(m, d.reachable))
    return (
      <JobCard key={`${decider ? 'decider' : role}-${j.id}`} id={j.id} kind="chain" role={role} title={j.title} test items={j.milestones.map((m, i) => ({ amount: m.amount, place: places[i]! }))}
        who={decider ? `You decide disputes on this work, between ${j.provider!.name} (@${j.provider!.handle}), who delivers it, and ${j.clientName ?? 'the client'}, who pays for it` : role === 'provider' ? (named ? `For ${named} (@${j.client!.handle})` : `For @${j.client!.handle}; their name shows once they fund a milestone`) : `You pay. Offered by ${other} (@${j.provider!.handle}), in their words`}
        terms={j.problem.kind === 'helix' ? 'The work: the lowest-risk mix of the six assets of the illustrative Helix model, certified on the chain.' : `The work: the lowest-risk mix of ${listed((j.problem.assets ?? []).map((a) => a.name))}, certified on the chain.`}
        note={role === 'provider' && j.authority && !j.authority.counts ? <Note tone="wait">{j.authority.why}</Note> : null}>
        {j.milestones.map((m, i) => {
          const place = places[i]!
          const problem = inRow(m.id)
          const p = m.pending
          // a step this side asked for and has not signed: it can be signed now (asked for again, with the terms as they
          // stand) or withdrawn; while the service does not answer it can only be withdrawn
          const mineWaiting = !!p && p.status === 'awaiting-signature' && p.yours
          return (
            <MsRow key={m.id} id={m.id} kind="chain" place={place} title={m.title} stamp={C_STATE[m.state] ?? m.state} whoseMove={whose(place, role, p?.status === 'sending')} amount={m.amount}
              say={<>{mineWaiting && p.action === 'quote' ? null : <p className="er-ms-next">{inWords(m.status)}</p>}
                {p ? <p className={`er-ms-wait ${mineWaiting ? 'mine' : p.status === 'sending' ? '' : 'theirs'}`} aria-live="polite">{waitingWords(p, other)}</p> : null}
                {role === 'client' && m.state === 'chain-expired' && !p ? <p className="er-ms-wait">To go ahead, ask {other} to offer it again: it cannot be funded until they do.</p> : null}
                {m.state === 'chain-released' && m.evidence ? <p className="er-ms-proof"><Seal /> The certificate was verified on the chain.</p> : null}
                {m.dispute ? <DisputeBlock d={m.dispute} role={decider ? 'decider' : role} other={other} /> : null}
                {role === 'provider' && m.authority && m.authority.status !== 'not-settled' ? <p className="er-auth small">{m.authority.status === 'credited' ? <>Adds <strong>{fmt.inr(Number(m.authority.credit), true)}</strong> to what QED may pay out on its own: half the price, earned from a client outside this workspace.</> : m.authority.status === 'pending' ? `Will add half the price to what QED may pay out on its own once the chain has confirmed it (${m.authority.confirmations} of ${m.authority.needed} confirmations so far).` : `Adds nothing to what QED may pay out on its own. ${inWords(m.authority.why)}`}</p> : null}
                {m.escrowJobId || m.quoteHash ? <details className="er-tech small"><summary>Technical details</summary><dl className="kv">
                {m.escrowJobId ? <><dt>Escrow job</dt><dd>No. {m.escrowJobId}</dd></> : null}
                {m.quoteHash ? <><dt>Quote</dt><dd className="code">{m.quoteHash}</dd></> : null}
                {m.deliverBy ? <><dt>Deliver by</dt><dd>{fmt.full(Date.parse(m.deliverBy))}</dd></> : null}
                {m.txs.opened ? <><dt>Funding transaction</dt><dd className="code">{m.txs.opened.tx}</dd></> : null}
                {m.txs.settled ? <><dt>Payment transaction</dt><dd><span className="code">{m.txs.settled.tx}</span> <span className="muted">({m.txs.settled.confirmations} confirmation{m.txs.settled.confirmations === 1 ? '' : 's'})</span></dd></> : null}
                {m.txs.refunded ? <><dt>Refund transaction</dt><dd className="code">{m.txs.refunded.tx}</dd></> : null}
                {m.evidence ? <><dt>Certificate</dt><dd className="code">{m.evidence.solutionHash}</dd></> : null}
              </dl></details> : null}</>}
              actions={mineWaiting ? <>
                {d.reachable ? <Btn small busy={resume.busy || step.busy || va.busy} onClick={() => void resume.run(m, other, role)}>Review and sign</Btn> : null}
                <Btn small tone="quiet" busy={withdraw.busy} onClick={() => void withdraw.run(m)}>Withdraw it</Btn>
              </> : m.actions.length ? m.actions.map((a, k) => (
                <Btn key={a} small tone={a === 'release' || a === 'give-way' || (a === 'refund' && role === 'provider') ? 'quiet' : m.id === primary && k === 0 ? 'fill' : undefined} busy={step.busy || va.busy}
                  onClick={() => (a === 'dispute' || a === 'evidence' || a === 'decide' ? setAsking({ id: m.id, action: a }) : void step.run(m, a, other, role))}>
                  {a === 'quote' ? (m.state === 'chain-expired' ? 'Offer it again' : `Offer it to ${other}`) : a === 'fund' ? 'Fund it from your wallet' : a === 'deliver' ? 'Deliver the work' : a === 'release' ? `Release ${other} instead`
                    : a === 'accept' ? 'Accept the work' : a === 'dispute' ? 'Dispute it' : a === 'evidence' ? 'Add evidence' : a === 'decide' ? 'Rule on the dispute' : a === 'give-way' ? `Refund ${other} in full` : a === 'finish' ? 'Apply the timeout' : role === 'client' ? 'Take the money back' : `Refund ${other}`}
                </Btn>)) : null}>
              {asking?.id === m.id ? <div className="er-wide"><DisputeAsk m={m} action={asking.action} busy={step.busy || va.busy} onCancel={() => setAsking(null)} onSend={(body) => void step.run(m, asking.action, other, role, body)} /></div> : null}
              {/* an earlier step's outcome, until a newer step is asked for: then it no longer describes where the milestone is */}
              {m.last && m.last.outcome !== 'executed' && !p ? <div className="er-wide"><LastStep last={m.last} theirs={stepIsTheirs(role, m.last.action)} other={other} /></div> : null}
              {role === 'client' && m.state === 'chain-refunded' ? <p className="er-wide er-line small"><Link to="/vault/treasury">Deposit it on the wallet's page</Link></p> : null}
              {problem ? <div className="er-wide"><Problem error={problem} /></div> : null}
              {asked?.id === m.id ? <div className="er-wide"><ChainOutcome job={va.job} asked={asked} /></div> : null}
            </MsRow>
          )
        })}
      </JobCard>
    )
  }
}

/** Whose a step is, from this side: the client funds, accepts and disputes; the provider offers, delivers, releases and gives way; either refunds. */
export const stepIsTheirs = (role: Role, action: string): boolean => (role === 'provider' ? action === 'fund' || action === 'accept' || action === 'dispute' : action === 'quote' || action === 'deliver' || action === 'release' || action === 'give-way')

/** The dispute terms in the sentences both sides signed. */
function DisputeTermsList({ words }: { words: string[] }) {
  return <ul className="er-dispute-terms small">{words.map((w) => <li key={w}>{plain(w)}</li>)}</ul>
}
const pctWords = (p: number, other: string): string => (p === 100 ? `all of it to ${other}` : p === 0 ? 'all of it back to the client' : `${p}% to ${other}, the rest to the client`)

/**
 * The review and dispute step of a milestone (R13 E3): the terms both sides accepted (who decides, with what powers,
 * each period and what happens when it runs out), the deadlines that apply now, the reason and evidence as each side
 * wrote them (recorded on the chain as fingerprints), and how it ended.
 */
function DisputeBlock({ d, role, other }: { d: ChainDispute; role: Role | 'decider'; other: string }) {
  const t = d.terms
  const powers = [t.may.pay ? 'pay the provider in full' : '', t.may.refund ? 'refund the client in full' : '', t.may.split ? 'split the price' : ''].filter(Boolean)
  const provider = role === 'provider' ? 'you' : role === 'client' ? other : 'the provider'
  return (
    <div className="er-dispute">
      <p className="small"><strong>Review and dispute step.</strong> {role === 'decider' ? 'You decide' : `@${d.decider.handle}${d.decider.name ? ` (${d.decider.name})` : ''} decides`} a dispute, and may {listed(powers)}; the decider is paid nothing. {t.test ? 'Periods in seconds: a test stack only.' : ''}</p>
      <dl className="kv small er-dispute-kv">
        <dt>The client's review</dt><dd>{t.review} from the verified delivery; with no answer, {pctWords(t.onReviewPct, provider)}{d.deadlines.reviewEnds ? `. Ends ${when(d.deadlines.reviewEnds)}` : ''}</dd>
        <dt>Evidence</dt><dd>{t.evidence} for both sides after a dispute{d.deadlines.evidenceEnds ? `; until ${when(d.deadlines.evidenceEnds)}` : ''}</dd>
        <dt>The ruling</dt><dd>At the latest {t.decision} after a dispute; with none by then, {pctWords(t.onDecisionPct, provider)}{d.deadlines.decideBy ? `. Due by ${when(d.deadlines.decideBy)}` : ''}</dd>
      </dl>
      {d.reason ? <div className="er-dispute-text"><p className="small"><strong>The client's reason</strong>{d.reason.onChain ? ' (its fingerprint is on the chain)' : ''}</p><blockquote className="small">{d.reason.text}</blockquote></div> : null}
      {d.evidence.map((e, i) => <div key={i} className="er-dispute-text"><p className="small"><strong>Evidence from the {e.by}</strong>, {fmt.dayTime(e.at)}{e.onChain ? ' (its fingerprint is on the chain)' : ''}</p><blockquote className="small">{e.text}</blockquote></div>)}
      {d.outcome ? <p className="small er-dispute-out"><strong>Settled: {d.outcome.words}.</strong> {fmt.inr(d.outcome.toProvider, true)} to the provider, {fmt.inr(d.outcome.toClient, true)} to the client.</p> : null}
    </div>
  )
}

/** The words or the amount a dispute step needs before its terms are prepared: a reason, evidence, or a ruling. */
function DisputeAsk({ m, action, busy, onCancel, onSend }: { m: ChainMilestone; action: 'dispute' | 'evidence' | 'decide'; busy: boolean; onCancel: () => void; onSend: (body: Record<string, unknown>) => void }) {
  const [text, setText] = useState('')
  const [toProvider, setToProvider] = useState<number | null>(null)
  const may = m.dispute?.terms.may ?? { pay: true, refund: true, split: true }
  const label = action === 'dispute' ? 'Why you dispute the work' : action === 'evidence' ? 'Your evidence' : 'The provider\'s part'
  const ok = action === 'decide' ? toProvider !== null && toProvider >= 0 && toProvider <= m.amount && (toProvider === m.amount ? may.pay : toProvider === 0 ? may.refund : may.split) : text.trim().length >= 10
  return (
    <form className="er-form er-dispute-ask" aria-label={action === 'dispute' ? 'Dispute the work' : action === 'evidence' ? 'Add evidence' : 'Rule on the dispute'} onSubmit={(e) => { e.preventDefault(); if (ok) onSend(action === 'decide' ? { toProvider } : action === 'dispute' ? { reason: text } : { text }) }}>
      {action === 'decide' ? <>
        <Field label={label} hint={`From ₹0 to ${fmt.inr(m.amount, true)}; the rest goes to the client. The terms let you ${[may.pay ? 'pay in full' : '', may.refund ? 'refund in full' : '', may.split ? 'split' : ''].filter(Boolean).join(', ')}.`}>{(p) => <MoneyInput {...p} value={toProvider} onChange={setToProvider} />}</Field>
        <div className="er-dispute-quick">{may.pay ? <Btn small tone="quiet" onClick={() => setToProvider(m.amount)}>All to the provider</Btn> : null}{may.refund ? <Btn small tone="quiet" onClick={() => setToProvider(0)}>All back to the client</Btn> : null}{may.split ? <Btn small tone="quiet" onClick={() => setToProvider(Math.round(m.amount / 2))}>Half each</Btn> : null}</div>
      </> : <Field label={label} hint="10 to 2000 characters. QED keeps the text and shows it to the other side and the decider; only its fingerprint goes on the chain.">{(p) => <textarea {...p} className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
      <div className="er-form-go"><Btn tone="fill" type="submit" busy={busy} disabled={!ok}>{action === 'dispute' ? 'Prepare the dispute' : action === 'evidence' ? 'Prepare the evidence' : 'Prepare the ruling'}</Btn><Btn tone="quiet" onClick={onCancel}>Not now</Btn></div>
    </form>
  )
}

/**
 * How a milestone's last step ended when it did not complete. One this side asked for and did not sign is theirs to
 * notice (amber); the other side's unsigned step is only news (neutral), named as theirs; a refusal or a failure is red.
 */
function LastStep({ last, theirs, other }: { last: NonNullable<ChainMilestone['last']>; theirs: boolean; other: string }) {
  const doing = DOING[last.action] ?? last.action
  const Doing = doing.replace(/^./, (c) => c.toUpperCase())
  if (last.outcome === 'expired') return theirs ? <Note title={`${other} did not sign ${doing}`}>{plain(last.summary)}</Note> : <Note tone="wait" title={`${Doing} was not signed`}>{plain(last.summary)}</Note>
  return <Note tone="void" title={last.outcome === 'refused' ? `QED refused ${doing}` : `${Doing} did not complete`}>{plain(last.summary)}</Note>
}

/** What the person last asked the escrow to do, as the page knew it when they asked. */
interface Asked { id: string; action: string; amount: number; other: string; role: Role; deliverBy: string | null }

/** The outcome of the last step, in plain words, in the row it was taken from; the wallet service's own account of it is in the record. */
function ChainOutcome({ job, asked }: { job: VaultJob | null; asked: Asked | null }) {
  if (!job) return null
  if (job.status === 'accepted' || job.status === 'running' || job.status === 'confirming') return <Note tone="qed" title="Sent to the chain">{job.status === 'confirming' ? 'Recorded there; waiting for its confirmations before it is reported done.' : 'Waiting for it to be recorded there.'}</Note>
  const r = job.result
  if (job.status !== 'done' || !r) return <Note tone="void" title="It did not complete">{plain(job.error ?? 'No result came back.')} {job.guidance ?? ''}</Note>
  const tone = r.outcome === 'executed' ? 'ok' : r.outcome === 'refused' || r.outcome === 'reverted' ? 'void' : 'wait'
  const said = r.outcome === 'executed' && asked ? done(asked) : null
  return <Note tone={tone} title={r.outcome === 'executed' ? 'Completed' : r.outcome === 'refused' ? 'Refused by QED\'s checks; nothing was sent' : 'Nothing needed doing'}>{said ?? plain(r.summary)} <Link to={`/vault/job/${job.id}`}>Open the record</Link></Note>
}
function done(a: Asked): string | null {
  const amount = fmt.inr(a.amount, true)
  switch (a.action) {
    case 'quote': return `Offered to ${a.other}. Nothing moves until they fund it from their wallet.`
    case 'fund': return `${amount} left your wallet and is held by the escrow. It is paid to ${a.other} only for work the verifier on the chain accepts${a.deliverBy ? ` by ${when(a.deliverBy)}` : ''}; after that you can take it back.`
    case 'deliver': return `The verifier on the chain accepted the certificate, and the escrow paid ${amount} into your wallet.`
    case 'release': return `The escrow returned ${amount} to ${a.other}. Nothing was paid to your wallet.`
    case 'refund': return a.role === 'client' ? `The escrow returned ${amount} to your wallet's own account on the chain. Move it back into the wallet with Deposit, on the wallet's page.` : `The escrow returned ${amount} to ${a.other}: no checked work arrived in time, so nothing was paid to your wallet.`
    case 'accept': return `You accepted the work: the dispute escrow paid ${amount} to ${a.other}.`
    case 'dispute': return 'Disputed. The money stays in the dispute escrow while both sides add evidence; then the decider rules.'
    case 'evidence': return 'Your evidence is recorded: its fingerprint is on the chain, and QED shows the text to the other side and the decider.'
    case 'decide': return 'Your ruling is on the chain, and the dispute escrow paid both sides as you ruled.'
    case 'give-way': return `You refunded ${amount} to ${a.other} through the dispute escrow.`
    case 'finish': return 'The timeout applied as the terms say: the dispute escrow paid each side its share.'
    default: return null
  }
}

/** The release's solver's answer to a problem, read before anything is prepared (POST /api/earn/chain/problems/preview). */
interface Answer { certified: boolean; weights: { asset: string; weight: string }[] }

function NewChainJob({ defaults, testStack, onDone }: { defaults: DisputeDefaults | null; testStack: boolean; onDone: () => void }) {
  const [key] = useState(uuidKey)
  // the review and dispute step (R13 E3): the paper escrow's defaults, each a choice within its bounds
  const D = defaults ?? { reviewDays: 7, evidenceDays: 3, decisionDays: 5, onReviewPct: 100, onDecisionPct: 50 }
  const [withDispute, setWithDispute] = useState(false)
  const [dispute, setDispute] = useState({ decider: '', review: String(D.reviewDays), evidence: String(D.evidenceDays), decision: String(D.decisionDays), onReview: String(D.onReviewPct), onDecision: String(D.onDecisionPct), pay: true, refund: true, split: true, seconds: false, rs: '120', es: '90', ds: '600' })
  const dp = (p: Partial<typeof dispute>) => setDispute((x) => ({ ...x, ...p }))
  const [title, setTitle] = useState(''), [client, setClient] = useState(''), [kind, setKind] = useState<'helix' | 'custom'>('custom')
  const [assets, setAssets] = useState<{ name: string; pct: string }[]>([{ name: '', pct: '' }, { name: '', pct: '' }])
  const [ms, setMs] = useState<{ title: string; amount: number | null; hours: string; stands: string }[]>([{ title: '', amount: null, hours: '24', stands: '24' }])
  const patch = (i: number, p: Partial<{ title: string; amount: number | null; hours: string; stands: string }>) => setMs((s) => s.map((m, j) => (j === i ? { ...m, ...p } : m)))
  const problem = kind === 'helix' ? { kind } : { kind, assets: assets.map((a) => ({ name: a.name, volatilityBps: Math.round(Number(a.pct) * 100) })) }
  const asked = JSON.stringify(problem)
  const [answer, setAnswer] = useState<{ for: string; a: Answer } | null>(null)
  const preview = useAction(async () => { setAnswer({ for: asked, a: await api<Answer>('POST', '/api/earn/chain/problems/preview', { problem }) }) })
  const add = useAction(async () => {
    const disputeBody = withDispute ? { deciderHandle: dispute.decider.replace(/^@/, ''), reviewDays: Number(dispute.review), evidenceDays: Number(dispute.evidence), decisionDays: Number(dispute.decision), onReviewPct: Number(dispute.onReview), onDecisionPct: Number(dispute.onDecision), may: { pay: dispute.pay, refund: dispute.refund, split: dispute.split }, ...(testStack && dispute.seconds ? { testSeconds: { review: Number(dispute.rs), evidence: Number(dispute.es), decision: Number(dispute.ds) } } : {}) } : undefined
    await api('POST', '/api/earn/chain/jobs', { key, title, clientHandle: client.replace(/^@/, ''), problem, milestones: ms.map((m) => ({ title: m.title, amount: m.amount ?? 0, deliverWithinHours: Number(m.hours), ...(m.stands.trim() ? { validForHours: Number(m.stands) } : {}) })), ...(disputeBody ? { dispute: disputeBody } : {}) })
    onDone()
  })
  const f = add.error?.fields ?? {}
  const shown = answer && answer.for === asked ? answer.a : null
  return (
    <form className="er-form" onSubmit={(e) => { e.preventDefault(); void add.run() }} aria-label="Prepare a job paid through the escrow">
      <div className="form-grid">
        <Field label="The work" error={f.title}>{(p) => <input {...p} className="input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="The client's handle" hint="Another QED account, with its own on-chain wallet." error={f.client}>{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={client} onChange={(e) => setClient(e.target.value)} />}</Field>
      </div>
      <div className="field"><span className="legend">What the verifier on the chain will check</span>
        <div className="seg" role="group" aria-label="The problem">
          <button type="button" aria-pressed={kind === 'custom'} onClick={() => setKind('custom')}>Assets you name</button>
          <button type="button" aria-pressed={kind === 'helix'} onClick={() => setKind('helix')}>The Helix model</button>
        </div>
        <span className="hint">{kind === 'helix' ? 'The lowest-risk mix of six asset classes of an illustrative model: synthetic figures, not market data or advice.' : 'The lowest-risk mix of 2 to 6 assets from their yearly swings (volatility), taken as unrelated to each other: figures you and the client agree, not market data or advice.'}</span>
      </div>
      {kind === 'custom' ? <fieldset className="er-ms-fields">
        <legend className="legend">The assets</legend>
        {assets.map((a, i) => (
          <div className="er-fields" key={i}>
            <Field label={`Asset ${i + 1}`}>{(p) => <input {...p} className="input" maxLength={40} value={a.name} onChange={(e) => setAssets((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}</Field>
            <Field label="Yearly swing, %">{(p) => <input {...p} className="input" inputMode="decimal" value={a.pct} onChange={(e) => setAssets((s) => s.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />}</Field>
            {assets.length > 2 ? <div className="er-fields-x"><Btn small tone="quiet" onClick={() => setAssets((s) => s.filter((_, j) => j !== i))}>Remove</Btn></div> : null}
          </div>
        ))}
        {assets.length < 6 ? <div><Btn small onClick={() => setAssets((s) => [...s, { name: '', pct: '' }])}><Plus aria-hidden="true" />Add an asset</Btn></div> : null}
      </fieldset> : null}
      {f.problem ? <span className="err small void">{f.problem}</span> : null}
      <div className="er-answer" aria-live="polite">
        <Btn small busy={preview.busy} onClick={() => void preview.run()}>See the certified answer</Btn>
        {shown ? <p className="small">{shown.certified ? 'The answer the verifier on the chain will check: ' : 'The solver\'s answer does not pass the check, so the escrow would not pay for it: '}{listed(shown.weights.map((w) => `${w.asset} ${w.weight}`))}. Nothing is prepared or sent.</p>
          : <p className="small faint">What you will deliver, worked out before anything is offered.</p>}
        {preview.error ? <Problem error={preview.error} /> : null}
      </div>
      <fieldset className="er-ms-fields">
        <legend className="legend">Milestones, each its own escrow</legend>
        {ms.map((m, i) => (
          <div className="er-fields four" key={i}>
            <Field label={`Milestone ${i + 1}`}>{(p) => <input {...p} className="input" maxLength={80} value={m.title} onChange={(e) => patch(i, { title: e.target.value })} />}</Field>
            <Field label="Paid when the work checks out">{(p) => <MoneyInput {...p} value={m.amount} onChange={(v) => patch(i, { amount: v })} />}</Field>
            <Field label="Deliver within, hours">{(p) => <input {...p} className="input" inputMode="numeric" value={m.hours} onChange={(e) => patch(i, { hours: e.target.value })} />}</Field>
            <Field label="Offer stands for, hours">{(p) => <input {...p} className="input" inputMode="numeric" value={m.stands} onChange={(e) => patch(i, { stands: e.target.value })} />}</Field>
            {ms.length > 1 ? <div className="er-fields-x"><Btn small tone="quiet" onClick={() => setMs((s) => s.filter((_, j) => j !== i))}>Remove</Btn></div> : null}
          </div>
        ))}
        <p className="small faint">The client has as long as the offer stands to fund each milestone: 1 to 168 hours, and never longer than its delivery time less 15 minutes.</p>
        {f.milestones ? <span className="err small void">{f.milestones}</span> : null}
        {ms.length < 4 ? <div><Btn small onClick={() => setMs((s) => [...s, { title: '', amount: null, hours: '24', stands: '24' }])}><Plus aria-hidden="true" />Add a milestone</Btn></div> : null}
      </fieldset>
      <fieldset className="er-ms-fields er-dispute-fields">
        <legend className="legend">A review and a dispute step</legend>
        <label className="check"><input type="checkbox" checked={withDispute} onChange={(e) => setWithDispute(e.target.checked)} /> The client reviews verified work before you are paid, and may dispute it; a third household decides</label>
        <p className="small faint">Without it, the escrow pays you the moment the verifier accepts the certificate, and there is nothing to review or dispute. With it, the money waits in QED's dispute escrow for the client's review, under the terms below, which your signature on the offer binds.</p>
        {withDispute ? <>
          <div className="form-grid">
            <Field label="Who decides a dispute" hint="A third household's handle: it needs an on-chain wallet and no member in common with you or the client. It is paid nothing." error={f.deciderHandle}>{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={dispute.decider} onChange={(e) => dp({ decider: e.target.value })} />}</Field>
          </div>
          <div className="er-fields four">
            <Field label="Client's review, days" hint="1 to 14; 7 by default" error={f.reviewDays}>{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.review} onChange={(e) => dp({ review: e.target.value })} />}</Field>
            <Field label="Evidence, days" hint="1 to 7; 3 by default" error={f.evidenceDays}>{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.evidence} onChange={(e) => dp({ evidence: e.target.value })} />}</Field>
            <Field label="Ruling within, days" hint="2 to 21 from the dispute; 5 by default" error={f.decisionDays}>{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.decision} onChange={(e) => dp({ decision: e.target.value })} />}</Field>
          </div>
          <div className="er-fields">
            <Field label="If the review ends with no answer, % to you" hint="100 by default: you delivered verified work and asked to be paid" error={f.onReviewPct}>{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.onReview} onChange={(e) => dp({ onReview: e.target.value })} />}</Field>
            <Field label="If no ruling comes in time, % to you" hint="50 by default: not a judgement, a stated fallback so the money is never locked" error={f.onDecisionPct}>{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.onDecision} onChange={(e) => dp({ onDecision: e.target.value })} />}</Field>
          </div>
          <div className="field" role="group" aria-label="What the decider may do"><span className="legend">What the decider may do</span>
            <label className="check"><input type="checkbox" checked={dispute.pay} onChange={(e) => dp({ pay: e.target.checked })} /> Pay you in full</label>
            <label className="check"><input type="checkbox" checked={dispute.refund} onChange={(e) => dp({ refund: e.target.checked })} /> Refund the client in full</label>
            <label className="check"><input type="checkbox" checked={dispute.split} onChange={(e) => dp({ split: e.target.checked })} /> Split the price</label>
            {f.may ? <span className="err small void">{f.may}</span> : null}
          </div>
          {testStack ? <div className="field"><label className="check"><input type="checkbox" checked={dispute.seconds} onChange={(e) => dp({ seconds: e.target.checked })} /> Periods in seconds (an isolated test stack only)</label>
            {dispute.seconds ? <div className="er-fields four">
              <Field label="Review, seconds">{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.rs} onChange={(e) => dp({ rs: e.target.value })} />}</Field>
              <Field label="Evidence, seconds">{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.es} onChange={(e) => dp({ es: e.target.value })} />}</Field>
              <Field label="Ruling within, seconds">{(p) => <input {...p} className="input" inputMode="numeric" value={dispute.ds} onChange={(e) => dp({ ds: e.target.value })} />}</Field>
            </div> : null}
            {f.testSeconds ? <span className="err small void">{f.testSeconds}</span> : null}</div> : null}
          <p className="small faint">The periods and their defaults are the paper escrow's (between what two freelance marketplaces are reported to do; the ruling's deadline and its fallback are QED's own choice). Each is a choice for this job, not a standard.</p>
        </> : null}
      </fieldset>
      {add.error && Object.keys(f).length === 0 ? <Problem error={add.error} /> : null}
      <div className="er-form-go"><Btn tone="fill" type="submit" busy={add.busy}>Prepare the job</Btn><p className="small faint">Preparing it moves no money and offers nothing yet: you offer each milestone with your passkey next.</p></div>
    </form>
  )
}
