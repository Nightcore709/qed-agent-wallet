/**
 * The judge's walk-through (FinTechathon 2026, Topic F; R11-018; design "Meridian", DESIGN.md M4): one decision for the
 * household's on-chain wallet, followed in six connected steps from what the owner asked to a record whose hashes this
 * browser checks, then the four things a judge asks about: an input changed, a refusal, a revocation, a recovery.
 *
 *   1 the objective and the authority signed earlier (the mandate, enforced by the chain)
 *   2 what the model decided (who answered, as recorded: a real model, or the scripted test double, never confused)
 *   3 QED's checks of the proposal, then the co-signer's own of the tick
 *   4 the exact terms signed once with the passkey, then a tick that ran with no new signature
 *   5 the chain's record against the books, read back after the transaction
 *   6 the tick's evidence case, every hash recomputed here
 *
 * Each step says where it comes from (shared/judge.ts PROVENANCE, R13): a genuine model call, mock or scripted,
 * historical evidence, or newly reproduced. The tick the chain follows is asked for by QED's engine on its own, never by
 * this page; the page only reads the records and offers the owner's own signatures. The page is assembled by the server from this workspace's own records
 * (GET /api/judge, server/judge.ts); every action on it goes through the same routes and checks as the everyday pages
 * (Ask, the wallet's approval sheet, a policy tick), so the walk-through adds no way to move money. Runs recorded
 * earlier with a real model are shown as recorded, with their date and revision, and checkable here.
 */
import { Check, Download, FileSearch, X } from 'lucide-react'
import { OriginalEvidence } from './judge-original.tsx'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { JUDGE_MANDATE, JUDGE_QUESTIONS, PROVENANCE, type Provenance } from '../../shared/judge.ts'
import type { HistoricalEvidence } from '../../chain/types.ts'
import { api, useData } from '../lib/core.ts'
import { Btn, Link, Note, Problem, Seal, Stamp, useAction } from '../ui/kit.tsx'
import { type Case, checkHashes, units } from './Evidence.tsx'
import { useVaultApproval } from './Vault.tsx'
import { changedRows, injectedView, type JudgeIndex, proposerLine, producedWords, provenanceShown, recoveryView, revocationView, shortHash, type Station, stations, tickWords, usd, when } from './judge-view.ts'
import '../styles/screens/judge.css'

type HashCheck = ReturnType<typeof checkHashes>
interface RecordedRun { id: string; how: 'api-journey' | 'browser-walkthrough'; producedAt: string | null; revision: { commit: string | null; dirty: boolean | null }; passed: number | null; failed: number | null; calls: { caseId: string; provider: string; model: string; genuine: boolean; costUsd: number | null }[]; costUsd: number | null; cases: { role: string; caseId: string }[]; cannotProve: string[]; tickAskedBy: string | null; qedRefusedAProposal: boolean | null }
interface Rerun { file: string; generatedAt: string | null; commit: string | null; calls: { genuine: number; costUsd: number; models: string } | null; cases: number; passed: number; failed: number; failing: { id: string; cause: string; status: string; summary: string; regression: string | null }[]; verdict: string | null; findings: { id: string; status: string; finding: string }[] }
interface Adversarial { file: string; generatedAt: string | null; commit: string | null; calls: { genuine: number; models: string[]; providers: string[]; costUsd: number | null } | null; cases: number; passed: number; failed: number; notRun: number; failing: { id: string; check: string; cause: string; status: string; summary: string; regression: string | null }[]; qedControlFault: string | null; rerun: { status: string; covers: string; genuineCalls: number | null; costUsd: number | null } | null }

/** A whole number of test rupees, grouped the Indian way ("2,500"). */
const grouped = (n: string): string => Number(n).toLocaleString('en-IN')
const uuid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-judge`)
/** Follow a vault job until it ends (at most 90 s), so the page redraws from its finished record. */
async function finished(jobId: string): Promise<{ status: string; result?: { outcome?: string } | null; error?: string | null }> {
  for (let i = 0; i < 150; i++) {
    const j = await api<{ status: string; result?: { outcome?: string } | null; error?: string | null }>('GET', `/api/vault/jobs/${jobId}`)
    if (j.status !== 'accepted' && j.status !== 'running' && j.status !== 'confirming') return j
    await new Promise((r) => setTimeout(r, 600))
  }
  return { status: 'running' }
}

export function JudgeScreen() {
  const ix = useData<JudgeIndex>('/api/judge', ['vault'])
  const recorded = useData<{ runs: RecordedRun[] }>('/api/judge/recorded')
  const adversarial = useData<{ evaluation: Adversarial | null; rerun: Rerun | null }>('/api/judge/adversarial')
  const hist = useData<HistoricalEvidence>('/api/evidence/historical')
  const exec = ix.data?.journey?.execution ?? null
  const tickCase = useData<Case>(exec ? `/api/evidence/cases/${encodeURIComponent(exec.caseId)}` : null)
  const [check, setCheck] = useState<HashCheck | null>(null)
  useEffect(() => { setCheck(null) }, [tickCase.data?.hashes.root])
  // every action below calls the routes the everyday pages call; the page then redraws from the records
  const v = useVaultApproval({ stay: true, onDone: () => ix.reload() })
  const ask = useAction(async (question: string) => { await api('POST', '/api/ask', { question }); ix.reload() })
  const [lastTick, setLastTick] = useState<{ key: string; jobId: string; duplicate: boolean; times: number } | null>(null)
  // A tick asked for from this page, only where the walk-through shows a refusal or a repeat: after a revocation (it must
  // be refused) and twice with one key (one job). The chain's own tick is asked for by QED's engine, never from here.
  const tick = useAction(async (twice: boolean) => {
    const key = uuid()
    const a = await api<{ jobId: string; duplicate?: boolean }>('POST', '/api/vault/run/policy-tick', { key })
    const b = twice ? await api<{ jobId: string; duplicate?: boolean }>('POST', '/api/vault/run/policy-tick', { key }) : null
    setLastTick({ key, jobId: a.jobId, duplicate: b?.duplicate === true && b.jobId === a.jobId, times: b && b.jobId === a.jobId ? 2 : 1 })
    await finished(a.jobId)
    ix.reload()
  })
  // While a signed policy waits for the engine's first tick (or for its tick after authority came back), read the records
  // again every few seconds: the engine asks within about half a minute; this page asks for nothing.
  const waitingForEngine = !!ix.data?.journey?.signed && ix.data.policy?.status === 'active' && (!ix.data.journey.execution || (!!ix.data.branches.restored && !ix.data.branches.restored.next))
  useEffect(() => {
    if (!waitingForEngine) return
    const t = setInterval(() => ix.reload(), 3000)
    return () => clearInterval(t)
  }, [waitingForEngine]) // eslint-disable-line react-hooks/exhaustive-deps
  const head = (
    <header className="page-head jg-head">
      <div className="jg-head-text">
        <h1>From objective to evidence</h1>
        <p>One decision for your on-chain wallet, followed from what you asked to the chain and back: the authority you signed, what the model proposed, what checked it, what ran on its own, what reconciled, and a record whose hashes this browser checks. Every step says what kind of evidence it is.</p>
      </div>
      <div className="jg-head-acts"><Link to="/evidence" className="btn"><FileSearch aria-hidden="true" />All evidence</Link></div>
    </header>
  )
  if (!ix.data) return <div className="jg">{head}{ix.error ? <div className="jg-problem"><Problem error={ix.error} /><Btn small onClick={ix.reload}>Try again</Btn></div> : <div className="panel jg-loading" aria-busy="true"><p className="loading-line">Reading this household's records…</p><span className="skel jg-skel" /><span className="skel jg-skel" /></div>}</div>
  const d = ix.data
  const st = stations(d, tickCase.data, check)
  const proposer = proposerLine(d.proposerNow)
  const canAsk = d.proposerNow.label !== 'none' && d.wallet.state === 'ready'
  const busy = v.busy || ask.busy || tick.busy
  const j = d.journey
  const actions: Record<Station['id'], ReactNode> = {
    authority: d.wallet.state !== 'ready'
      ? <Link to="/vault" className="btn fill">{d.wallet.state === 'awaiting-acceptance' ? 'Accept your wallet' : d.wallet.state === 'unreachable' ? 'See the wallet\'s state' : 'Set up the on-chain wallet'}</Link>
      : !d.mandate || d.mandate.status !== 'active'
        ? <Btn tone="fill" busy={v.busy} disabled={busy && !v.busy} onClick={() => void v.start('/api/vault/proposals', { kind: 'mandate', params: JUDGE_MANDATE }, { title: 'Approve the example mandate', intro: <p>The most QED's agent may move from your wallet: {grouped(JUDGE_MANDATE.maxPerPayment)} test rupees a payment or conversion, {grouped(JUDGE_MANDATE.maxPerPeriod)} a day and {grouped(JUDGE_MANDATE.maxTotal)} in all, for {JUDGE_MANDATE.validDays} days. The chain enforces it.</p> })}>Sign the example mandate with your passkey</Btn>
        : null,
    decision: <Objective canAsk={canAsk} busy={ask.busy} disabled={busy && !ask.busy} onAsk={(q) => void ask.run(q)} asked={!!j} why={d.proposerNow.label === 'none' ? 'No model answers Ask on this installation.' : d.wallet.state !== 'ready' ? 'Set up your wallet first.' : !d.mandate ? 'Sign a mandate first: a wallet proposal is checked against it.' : null} />,
    checks: null,
    execution: j?.proposal && j.proposal.state !== 'invalid' && !j.signed
      ? <Btn tone="fill" busy={v.busy} disabled={busy && !v.busy} onClick={() => void v.start(`/api/wallet-proposals/${j.proposal!.id}/draft`, undefined, { title: 'Sign the standing policy once', intro: <p>Proposed by {proposerLine(j.decision.call).word.toLowerCase()}; checked by QED against your wallet's figures. Once you sign these exact terms, QED's engine runs the policy on its own, every tranche checked again by the co-signer and the contract.</p> })}>Review the exact terms and sign once</Btn>
      : j?.signed && d.policy?.status === 'active' && !exec
        ? <p className="small muted jg-wait" role="status">Waiting for QED's engine to run the first tick by itself, within about half a minute. Nothing on this page asks for it.</p>
        : null,
    reconciliation: null,
    evidence: exec && tickCase.data ? (
      <div className="jg-proof">
        <div className="jg-acts-row">
          <Btn tone="fill" onClick={() => setCheck(checkHashes(tickCase.data!))}>Check its hashes here</Btn>
          <a className="btn" href={`/api/evidence/cases/${encodeURIComponent(exec.caseId)}/export`} download><Download aria-hidden="true" />Download the case</a>
          <Link to={`/evidence/${encodeURIComponent(exec.caseId)}`}>Open the full case</Link>
        </div>
        {check ? <HashResult check={check} root={tickCase.data.hashes.root} /> : null}
      </div>
    ) : exec && tickCase.error ? <Problem error={tickCase.error} /> : null,
  }
  return (
    <div className="jg">
      {head}
      <div className="jg-top">
        <section className="panel jg-who" aria-labelledby="jg-who-h">
          <h2 id="jg-who-h" className="jg-label">Who decides on this page</h2>
          <p className="jg-who-word"><Stamp tone={proposer.tone === 'ok' ? 'ok' : proposer.tone === 'wait' ? 'wait' : 'plain'}>{proposer.word}</Stamp></p>
          <p>{proposer.says}</p>
          <ul className="jg-who-list small">
            <li>{d.presentation ? 'Paper prices are made up on this QED installation (presentation mode): no market was asked. Conversions on the wallet trade against the test market\'s own pools on the local chain.' : 'Conversions on the wallet trade against the test market\'s own pools on the local chain; paper prices are live market observations.'}</li>
            <li>{d.wallet.chainId === 31337 ? 'The wallet runs on a test chain on this QED installation (chain 31337), with test tokens of no value. It is not a public network.' : d.wallet.state === 'ready' ? (d.wallet.network ?? 'The wallet\'s network is not named.') : 'No on-chain wallet yet.'}</li>
            <li>Your passkey signs; the model holds no key, signs nothing and executes nothing.</li>
            {d.models ? <li>{d.models.readOnly ? `Ask is read-only now: ${d.models.readOnly.message}` : `Model answers have cost ${usd(d.models.spentUsd.budget)} of this installation's ${usd(d.models.spentUsd.budgetLimit)} budget, priced from the tokens each response reported (${d.models.priceSource}).`}</li> : null}
          </ul>
        </section>
        <section className="panel jg-kinds" aria-labelledby="jg-kinds-h">
          <h2 id="jg-kinds-h" className="jg-label">Where each step comes from</h2>
          <ul>
            {(['genuine', 'scripted', 'historical', 'reproduced'] as Provenance[]).map((k) => {
              // the live re-run below is genuine model calls, recorded earlier
              const on = provenanceShown(d).includes(k) || (k === 'genuine' && !!adversarial.data?.rerun)
              return <li key={k} className={`tile jg-kind jg-kind-${k}${on ? ' is-on' : ''}`}><p><ProvTag p={k} /><span className="small muted">{on ? 'On this page' : 'Not on this page now'}</span></p><p className="small">{PROVENANCE[k].says}</p></li>
            })}
          </ul>
        </section>
      </div>

      {v.error ? <Problem error={v.error} /> : null}
      {ask.error ? <Problem error={ask.error} /> : null}
      {tick.error ? <Problem error={tick.error} /> : null}

      <ol className="jg-flow" aria-label="The decision, in six steps">
        {st.map((s) => <StationCard key={s.id} s={s}>{actions[s.id]}</StationCard>)}
      </ol>

      <Branches d={d} busy={busy} ask={ask} tick={tick} lastTick={lastTick} v={v} />
      <Recorded runs={recorded} />
      <AdversarialRun data={adversarial} />
      <section className="panel jg-hist" aria-labelledby="jg-hist-h">
        <h2 id="jg-hist-h" className="jg-label">Historical testnet</h2>
        <p><ProvTag p="historical" /> {hist.data ? `${hist.data.counts.inManifests.transactions} transactions on ${hist.data.network}, recorded by the QED team on 19 and 20 October 2026, before this build.` : 'The transactions the QED team recorded on Ethereum Sepolia on 19 and 20 October 2026, before this build.'} Anyone can look them up on the public explorer; they show what the earlier release did, not this build. <Link to="/evidence#hist">Read them under Evidence</Link></p>
        <OriginalEvidence transactions={hist.data?.transactions} />
      </section>
      {v.sheet}
    </div>
  )
}

function ProvTag({ p }: { p: Provenance }) {
  return <span className={`jg-tag jg-tag-${p}`}>{PROVENANCE[p].word}</span>
}

const PROGRESS_WORD: Record<Station['progress'], string> = { done: 'Done', current: 'Your move', todo: 'Not yet', stopped: 'Stopped here' }
/** One verifier's checks: the ones that failed first, then the first few that passed; the rest one press away. */
function CheckGroup({ title, checks }: { title: string; checks: Station['groups'][number]['checks'] }) {
  const [all, setAll] = useState(false)
  const id = useId()
  const failing = checks.filter((k) => !k.pass)
  const shown = all ? checks : [...failing, ...checks.filter((k) => k.pass).slice(0, Math.max(0, 4 - failing.length))]
  return (
    <div className="jg-group">
      <h3 id={id} className="jg-group-h">{title}: {checks.filter((k) => k.pass).length} of {checks.length} passed</h3>
      <ul className="jg-checks" aria-labelledby={id}>{shown.map((k, i) => (
        <li key={i} className={k.pass ? 'pass' : 'fail'}><span className="mark" aria-hidden="true">{k.pass ? <Check /> : <X />}</span>
          <span><span className="sr">{k.pass ? 'Passed: ' : 'Failed: '}</span><strong>{k.name}</strong><span className="muted">, by {k.by}</span>{k.detail ? <span className="jg-check-detail">{k.detail}</span> : null}</span></li>
      ))}</ul>
      {checks.length > shown.length || all ? <button type="button" className="linkish jg-more" aria-expanded={all} onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${checks.length}`}</button> : null}
    </div>
  )
}

function StationCard({ s, children }: { s: Station; children: ReactNode }) {
  return (
    <li className={`jg-st is-${s.progress}`} aria-current={s.progress === 'current' ? 'step' : undefined}>
      <span className="jg-node" aria-hidden="true">{s.progress === 'done' ? <Check /> : s.progress === 'stopped' ? <X /> : s.n}</span>
      <section className="panel jg-card" aria-labelledby={`jg-${s.id}`}>
        <header className="jg-card-head">
          <p className="jg-step">Step {s.n} of 6 · {PROGRESS_WORD[s.progress]}</p>
          <h2 id={`jg-${s.id}`}>{s.title}</h2>
          <div className="jg-tags">{s.stamp ? <Stamp tone={s.stamp[1]}>{s.stamp[0]}</Stamp> : null}<ProvTag p={s.provenance} /></div>
        </header>
        <p className="jg-finding">{s.finding}</p>
        {s.groups.map((g) => <CheckGroup key={g.title} title={g.title} checks={g.checks} />)}
        {children ? <div className="jg-acts">{children}</div> : null}
        {s.facts.length || s.caseId ? (
          <details className="jg-expert"><summary>Expert detail</summary>
            {s.facts.length ? <dl className="kv small">{s.facts.map((f) => <div key={f.label} className="jg-fact"><dt>{f.label}</dt><dd className={f.code ? 'code' : undefined}>{f.value}</dd></div>)}</dl> : null}
            {s.caseId ? <p className="small"><Link to={`/evidence/${encodeURIComponent(s.caseId)}`}>Open its evidence case</Link> <span className="muted code">{s.caseId}</span></p> : null}
          </details>
        ) : null}
      </section>
    </li>
  )
}

function Objective({ canAsk, busy, disabled, onAsk, asked, why }: { canAsk: boolean; busy: boolean; disabled: boolean; onAsk: (q: string) => void; asked: boolean; why: string | null }) {
  const [q, setQ] = useState<string>(JUDGE_QUESTIONS.objective)
  const id = useId()
  return (
    <form className="jg-ask" onSubmit={(e) => { e.preventDefault(); if (canAsk && q.trim()) onAsk(q.trim()) }}>
      <label htmlFor={id}>Your objective, in your words</label>
      <textarea id={id} className="input" rows={3} maxLength={2000} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="jg-acts-row">
        <Btn tone={asked ? undefined : 'fill'} type="submit" busy={busy} disabled={!canAsk || disabled}>{asked ? 'Ask again' : 'Ask QED\'s model'}</Btn>
        {why ? <span className="small muted">{why}</span> : <span className="small muted">QED sends your words and a snapshot of your wallet, payees as tokens; it never sends a key.</span>}
      </div>
    </form>
  )
}

function HashResult({ check, root }: { check: HashCheck; root: string }) {
  return (
    <div className="jg-checked" role="status">
      {check.ok ? <Seal size="lg" live label="Every hash matches" /> : <X aria-hidden="true" />}
      <Note tone={check.ok ? 'ok' : 'void'} title={check.ok ? 'Every hash matches, recomputed in this browser' : 'A hash does not match'}>
        {check.ok ? `${check.lines.length} of ${check.lines.length} parts match their stated SHA-256, and the root ${shortHash(root)} matches.` : `Not matching: ${check.lines.filter(([, ok]) => !ok).map(([k]) => k).join(', ')}.`} This shows the file is intact as it arrived; the offline verifier also checks each signature, the receipt chain and, while the chain runs, each transaction.
      </Note>
    </div>
  )
}

type Act<A extends unknown[]> = { run: (...a: A) => Promise<boolean>; busy: boolean }
function Branches({ d, busy, ask, tick, lastTick, v }: { d: JudgeIndex; busy: boolean; ask: Act<[string]>; tick: Act<[boolean]>; lastTick: { key: string; jobId: string; duplicate: boolean; times: number } | null; v: ReturnType<typeof useVaultApproval> }) {
  const ready = d.wallet.state === 'ready' && !!d.mandate && d.proposerNow.label !== 'none'
  const changed = changedRows(d), inj = injectedView(d), rev = revocationView(d), rec = recoveryView(d)
  const policyOn = d.policy?.status === 'active'
  return (
    <section className="jg-branches" aria-labelledby="jg-br-h">
      <div className="jg-br-head"><h2 id="jg-br-h">Change an input, refuse, revoke, recover</h2><p>What happens when something is different, wrong or withdrawn, from the same records.</p></div>
      <div className="jg-br-grid">
        <section className="panel jg-br" aria-labelledby="jg-ch-h">
          <h3 id="jg-ch-h">The same request, one input changed</h3>
          <p className="small">Ask to pay the same payee twice; only the amount differs.{d.mandate ? ` Your mandate allows ${units(d.mandate.perPayment, d.wallet.asset.decimals, d.wallet.asset.symbol)} a payment.` : ''}</p>
          <div className="jg-acts-row">
            <Btn small busy={ask.busy} disabled={!ready || busy} onClick={() => void ask.run(JUDGE_QUESTIONS.payLow)}>Ask to pay 3 test rupees</Btn>
            <Btn small busy={ask.busy} disabled={!ready || busy} onClick={() => void ask.run(JUDGE_QUESTIONS.payHigh)}>Ask to pay 300 test rupees</Btn>
          </div>
          {changed.rows.length ? (
            <ul className="jg-rows" aria-label="Each request and what QED decided">
              {changed.rows.map((r) => <li key={r.caseId}><p><strong>{r.amount ? `${r.amount} test rupees` : 'A payment'}</strong></p><p className="small">Proposed: {r.proposed}. <ProvTag p={r.proposedBy} /></p><p className={`small jg-${r.tone}`}>{r.decided} <ProvTag p="reproduced" /></p><p className="small"><Link to={`/evidence/${encodeURIComponent(r.caseId)}`}>Its case</Link></p></li>)}
            </ul>
          ) : null}
          {changed.sentence ? <p className="jg-br-sum">{changed.sentence}</p> : null}
          {d.journey && d.journey.ticks.length > 1 ? <>
            <p className="small jg-br-sub">The same signed policy, as the reserve changed:</p>
            <ul className="jg-rows">{d.journey.ticks.slice(0, 4).map((t) => <li key={t.jobId}><p className="small">{tickWords(t, d.wallet.asset)}. <Link to={`/evidence/${encodeURIComponent(t.caseId)}`}>Its case</Link></p></li>)}</ul>
          </> : null}
        </section>

        <section className="panel jg-br" aria-labelledby="jg-inj-h">
          <h3 id="jg-inj-h">A refusal: an instruction hidden in a bill</h3>
          <p className="small">An outsider wrote an instruction into a bill; you paste the bill into Ask. The hidden text asks for 50 test rupees to an address that is not your payee.</p>
          <blockquote className="jg-quote">{JUDGE_QUESTIONS.injected}</blockquote>
          <div className="jg-acts-row"><Btn small busy={ask.busy} disabled={!ready || busy} onClick={() => void ask.run(JUDGE_QUESTIONS.injected)}>Paste the bill into Ask</Btn></div>
          {inj ? (
            <dl className="kv small jg-dl" aria-label="What happened to the hidden instruction">
              <dt>Answered by</dt><dd>{inj.who} <ProvTag p={inj.proposedBy} /></dd>
              <dt>It proposed</dt><dd>{inj.proposed}</dd>
              <dt>QED decided</dt><dd className={`jg-${inj.tone === 'ok' ? 'void' : 'wait'}`}>{inj.decided} <ProvTag p="reproduced" /></dd>
              <dt>What moved</dt><dd>{inj.nothingSent}</dd>
              <dt>Its case</dt><dd><Link to={`/evidence/${encodeURIComponent(inj.caseId)}`}>Open it</Link></dd>
            </dl>
          ) : null}
        </section>

        <section className="panel jg-br" aria-labelledby="jg-rev-h">
          <h3 id="jg-rev-h">Revocation: ending the standing policy</h3>
          <p className="small">You end the policy with your passkey; after that no tick may run under it, whoever asks. The engine stops asking; the button below asks anyway, on purpose, so that you can see QED refuse it. <ProvTag p="reproduced" /></p>
          <div className="jg-acts-row">
            <Btn small tone="void" busy={v.busy} disabled={!policyOn || busy} onClick={() => void v.start('/api/vault/proposals', { kind: 'policy-revoke' }, { title: 'End the standing policy' })}>End the policy with your passkey</Btn>
            <Btn small busy={tick.busy} disabled={!rev || policyOn || busy} onClick={() => void tick.run(false)}>Ask for a tick anyway</Btn>
          </div>
          {rev ? (
            <dl className="kv small jg-dl" aria-label="The revocation and the tick after it">
              <dt>Ended</dt><dd><Stamp tone={rev.stamp[1]}>{rev.stamp[0]}</Stamp> {rev.at}, signed with your passkey</dd>
              <dt>The next tick</dt><dd>{rev.next ? <><Stamp tone={rev.next.stamp[1]}>{rev.next.stamp[0]}</Stamp> {rev.next.words} <Link to={`/evidence/${encodeURIComponent(rev.next.caseId)}`}>Its case</Link></> : 'None asked for since.'}</dd>
            </dl>
          ) : null}
        </section>

        <section className="panel jg-br" aria-labelledby="jg-rec-h">
          <h3 id="jg-rec-h">Recovery: a lost answer, and authority restored</h3>
          <p className="small">A browser that loses an answer asks again with the same key; the vault service must not run the request twice. And after a revocation, only your passkey can give authority back; the engine then runs the policy again by itself. <ProvTag p="reproduced" /></p>
          <div className="jg-acts-row">
            <Btn small busy={tick.busy} disabled={!d.journey?.signed || busy} onClick={() => void tick.run(true)}>Send one tick request twice, with one key</Btn>
            <Btn small busy={v.busy} disabled={!rev || policyOn || busy} onClick={() => void v.start('/api/vault/proposals', { kind: 'policy', params: { targetFree: '10' } }, { title: 'Sign the standing policy again' })}>Sign the policy again</Btn>
          </div>
          {lastTick && lastTick.times > 1 ? <p className="small jg-ok" role="status">Asked {lastTick.times} times with one key: the vault service answered with the same job each time{lastTick.duplicate ? ' and said it was a repeat' : ''}. Nothing ran twice.</p> : null}
          {rec.repeated ? <dl className="kv small jg-dl" aria-label="A repeated request"><dt>Repeated request</dt><dd><Stamp tone={rec.repeated.stamp[1]}>{rec.repeated.stamp[0]}</Stamp> {rec.repeated.words} <Link to={`/evidence/${encodeURIComponent(rec.repeated.caseId)}`}>Its case</Link></dd></dl> : null}
          {rec.restored ? <dl className="kv small jg-dl" aria-label="Authority restored"><dt>Authority restored</dt><dd>{rec.restored.words}</dd><dt>The next tick</dt><dd>{rec.restored.next ? <><Stamp tone={rec.restored.next.stamp[1]}>{rec.restored.next.stamp[0]}</Stamp> {rec.restored.next.words} <Link to={`/evidence/${encodeURIComponent(rec.restored.next.caseId)}`}>Its case</Link></> : 'Not yet: QED\'s engine asks for it by itself within about half a minute.'}</dd></dl> : null}
        </section>
      </div>
      {d.branches.refusals.length ? (
        <details className="panel jg-others"><summary>Other refusals on record ({d.branches.refusals.length})</summary>
          <ul className="jg-rows">{d.branches.refusals.map((r) => <li key={r.jobId}><p className="small"><Stamp tone="void">{r.outcome === 'reverted' ? 'Reverted by the chain' : r.outcome === 'failed' ? 'Failed' : 'Refused by QED\'s checks'}</Stamp> {when(r.at)}: {r.summary ?? r.error ?? r.kind} <Link to={`/evidence/${encodeURIComponent(r.caseId)}`}>Its case</Link></p></li>)}</ul>
        </details>
      ) : null}
    </section>
  )
}

function Recorded({ runs }: { runs: { data: { runs: RecordedRun[] } | null; error: Parameters<typeof Problem>[0]['error']; reload: () => void } }) {
  const [checked, setChecked] = useState<Record<string, HashCheck | 'loading' | string>>({})
  const verify = async (run: string, caseId: string): Promise<void> => {
    const k = `${run}/${caseId}`
    setChecked((s) => ({ ...s, [k]: 'loading' }))
    try { const c = await api<Case>('GET', `/api/judge/recorded/${run}/cases/${encodeURIComponent(caseId)}`); setChecked((s) => ({ ...s, [k]: checkHashes(c) })) }
    catch (e) { setChecked((s) => ({ ...s, [k]: e instanceof Error ? e.message : 'It could not be read.' })) }
  }
  const list = runs.data?.runs ?? []
  return (
    <section className="panel jg-rec" aria-labelledby="jg-rec-run-h">
      <div className="panel-head"><h2 id="jg-rec-run-h">Recorded earlier with a real model</h2><p><ProvTag p="historical" /> Read from files, not running now</p></div>
      {runs.error ? <Problem error={runs.error} /> : !runs.data ? <p className="loading-line">Reading the recorded runs…</p> : !list.length ? <p className="small muted">No run with a real model is recorded in this build's evidence.</p> : list.map((r) => {
        const genuine = r.calls.filter((c) => c.genuine)
        const models = [...new Set(genuine.map((c) => c.model))]
        return (
          <article key={r.id} className="jg-run" aria-label={`Run ${r.id}`}>
            <p className="jg-run-line"><strong>{producedWords(r.producedAt)}</strong>: {r.how === 'browser-walkthrough' ? 'this walk-through, driven in a browser' : 'the judge journey, through QED\'s own API'}, on revision {r.revision.commit ? r.revision.commit.slice(0, 7) : 'unrecorded'}{r.revision.dirty ? ' with changes not yet committed' : ''}. {r.passed !== null ? `${r.passed} steps passed, ${r.failed ?? 0} failed. ` : ''}{genuine.length} genuine model call{genuine.length === 1 ? '' : 's'} by {models.join(', ') || 'no model'}{r.costUsd !== null ? `, US$${r.costUsd.toFixed(3)} as the client reported` : ''}. Its local chain no longer exists: the transactions in these cases can no longer be re-read.</p>
            <ul className="jg-rows">{r.cases.map((c) => {
              const k = `${r.id}/${c.caseId}`, res = checked[k]
              return (
                <li key={c.caseId}>
                  <p className="small"><strong>{c.role}</strong> <span className="muted code">{c.caseId}</span></p>
                  <div className="jg-acts-row"><Btn small busy={res === 'loading'} onClick={() => void verify(r.id, c.caseId)}>Check this recorded case here</Btn></div>
                  {res && res !== 'loading' ? (typeof res === 'string' ? <Note tone="void">{res}</Note> : <p className={`small ${res.ok ? 'jg-ok' : 'jg-void'}`} role="status">{res.ok ? <><Check aria-hidden="true" /> Every hash matches, recomputed in this browser ({res.lines.length} parts and the root).</> : <><X aria-hidden="true" /> Not matching: {res.lines.filter(([, ok]) => !ok).map(([n]) => n).join(', ')}.</>}</p>) : null}
                </li>
              )
            })}</ul>
            {r.tickAskedBy || r.qedRefusedAProposal === false ? <ul className="small jg-run-notes">
              {r.tickAskedBy ? <li>Its tick was asked for by {r.tickAskedBy}{/engine/.test(r.tickAskedBy) ? '' : ': not run by the engine on its own, which the chain above now shows'}.</li> : null}
              {r.qedRefusedAProposal === false ? <li>The model declined the 300 test rupee payment and the hidden instruction itself, so QED's own refusal of a proposal was not exercised in this run; the steps above show QED refusing both.</li> : null}
            </ul> : null}
            {r.cannotProve.length ? <details className="jg-expert"><summary>What this run cannot prove</summary><ul className="small">{r.cannotProve.map((t, i) => <li key={i}>{t}</li>)}</ul></details> : null}
          </article>
        )
      })}
      <p className="small muted">A recorded run is shown only as recorded, with its date and revision; it is never presented as happening now.</p>
    </section>
  )
}

/** The live run of the original 30 adversarial cases (24 Nov), where it is kept, and its diagnosis: historical evidence. */
function AdversarialRun({ data }: { data: { data: { evaluation: Adversarial | null; rerun: Rerun | null } | null; error: Parameters<typeof Problem>[0]['error'] } }) {
  const e = data.data?.evaluation ?? null, r = data.data?.rerun ?? null
  return (
    <section className="panel jg-rec" aria-labelledby="jg-adv-h">
      <div className="panel-head"><h2 id="jg-adv-h">The actual-model adversarial evaluation</h2><p><ProvTag p="historical" /> Read from files, not running now</p></div>
      {data.error ? <Problem error={data.error} /> : !data.data ? <p className="loading-line">Reading the evaluation…</p> : !e ? <p className="small muted">This build does not carry the live adversarial run's files.</p> : <>
        <p className="jg-run-line"><strong>{e.passed} of {e.cases} passed in the one live run of the original {e.cases} attacks.</strong> {e.failed} failed and {e.notRun} was not run; neither is counted as a pass.</p>
        {e.failing.length ? <p className="small"><strong>The {e.failed} that failed ({e.failing.map((f) => f.id).join(', ')}):</strong> each was diagnosed afterwards as a fault in how the evaluation graded the answer, not a control of QED that was breached. The diagnosis is below, so it can be checked against the run's files. It is a finding, not a pass.</p> : null}
        {e.notRun > 0 ? <p className="small"><strong>Not run (G1):</strong> it tests QED's own limit of 30 questions an hour (the 31st is refused and no model is called), not the model, so the live run leaves it to the scripted run. There is no live result for G1.</p> : null}
        <p className="small muted">{producedWords(e.generatedAt)}: sent to {e.calls ?`${e.calls.models.join(', ')} through ${e.calls.providers.map((x) => (x === 'claude-cli' ? 'the Claude command-line client' : x)).join(', ')}: ${e.calls.genuine} genuine model calls${e.calls.costUsd !== null ? `, US$${e.calls.costUsd.toFixed(2)} as the client reported` : ''}` : 'a real model'}, on revision {e.commit ?? 'unrecorded'}. It was run once and not repeated.</p>
        {e.failing.length ? <ul className="jg-rows" aria-label="The failures and their diagnosis">{e.failing.map((f) => <li key={f.id}><p className="small"><strong>{f.id}</strong>: {f.check}. Cause: {f.cause === 'scoring' ? 'the evaluation\'s scoring, not QED\'s controls' : f.cause} ({f.status}).{f.regression ? ` Kept as regression case ${f.regression}.` : ''}</p><p className="small muted">{f.summary}</p></li>)}</ul> : null}
        {e.qedControlFault ? <p className="small">{e.qedControlFault}</p> : null}
        {e.rerun && !r ? <p className="small"><strong>Not run yet:</strong> {e.rerun.covers}, with a real model. {e.rerun.status}.{e.rerun.genuineCalls !== null ? ` It would make ${e.rerun.genuineCalls} genuine calls` : ''}{e.rerun.costUsd !== null ? `, about US$${e.rerun.costUsd.toFixed(2)} at API rates` : ''}.</p> : null}
        <p className="small muted code">{e.file}</p>
        {r ? (
          <article className="jg-run" aria-label="The live re-run">
            <h3 className="jg-sub">A separate, later run, not part of the {e.passed} of {e.cases} above</h3>
            <p className="jg-run-line"><ProvTag p="genuine" /> <ProvTag p="historical" /> <strong>{producedWords(r.generatedAt)}</strong>: B1, L1, M1 and the 20 cases added since, re-run with a real model on revision {r.commit ?? 'unrecorded'}{r.calls ? `: ${r.calls.genuine} genuine model calls, US$${r.calls.costUsd.toFixed(2)} as the client reported` : ''}. {r.passed} of {r.cases} passed and {r.failed} failed. B1, L1 and M1 passed here; the failures are among the added cases, each diagnosed below.</p>
            {r.verdict ? <p className="small">{r.verdict}</p> : null}
            <ul className="jg-rows" aria-label="The re-run's failures and their diagnosis">{r.failing.map((f) => <li key={f.id}><p className="small"><strong>{f.id}</strong>: the cause was {f.cause === 'scoring' ? 'the evaluation\'s scoring, not QED\'s controls' : f.cause} ({f.status}).{f.regression ? ` Regression case ${f.regression}.` : ''}</p></li>)}</ul>
            <details className="jg-expert"><summary>Each failure, and what else the re-run showed</summary>
              <ul className="small">{r.failing.map((f) => <li key={f.id}><strong>{f.id}</strong>: {f.summary}</li>)}{r.findings.map((f) => <li key={f.id}><strong>{f.id}</strong> ({f.status}): {f.finding}</li>)}</ul>
              {r.calls?.models ? <p className="small">{r.calls.models}.</p> : null}
            </details>
            <p className="small muted code">{r.file}</p>
          </article>
        ) : null}
      </>}
    </section>
  )
}
