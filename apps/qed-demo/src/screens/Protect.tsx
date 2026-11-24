/**
 * Protect: what stands between the owner's money and a bad outcome, told apart by kind (DESIGN.md "Meridian"; the
 * owner's R11 regression criterion: "distinguish observations, configured policies and independently enforced
 * protections"). It opens on what QED may move (the most its instructions may take from the bank account, the bank at
 * true scale with QED's bracket over the free part) beside who enforces what: a ladder from the model behind Ask, which
 * enforces nothing, through QED's server and the co-signer to the chain, ending with the bank, rails and venues, which
 * are paper in this build. Then three bands, each with its mark and its words:
 *
 *  - Watched: what QED sees and tells you; none of it stops anything (the engine, passkeys, sessions, recovery,
 *    changes waiting, the records). Its lead is where the account stands.
 *  - Set by you: the rules you chose for your bank account, each with what enforces it (QED's server) and what happens
 *    if that fails.
 *  - Enforced: what refuses, not just tells. QED's server on every action, whatever you set; and on the on-chain wallet
 *    the chain, which holds even if QED is wrong or taken over. Its lead is the most that could leave the wallet then.
 *
 * Anything that needs the owner is listed under the head, each a link to its place. The one control that pauses QED is
 * the shell's status control (App.tsx QedStatus, D-073): named here, never repeated; one instruction is paused on its own
 * line. The helpers at the top are shared by the other Protect screens and by Home, Pay, Security and Workspace.
 */
import { Check, ChevronRight, Clock, Landmark, Link2, MessagesSquare, Minus, Plus, Server, Signature, X } from 'lucide-react'
import { createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useState } from 'react'
import { api, ApiError, fmt, useData, useNow } from '../lib/core.ts'
import { withPasskeyIfAsked } from '../lib/stepup.ts'
import { atomsToPaise, clock, heldByPause, MODE_WORD, monthLeft, nearDay } from '../lib/words.ts'
import type { AuthorityEnvelope, Home, Liquidity, ProgramSummary } from '../lib/types.ts'
import { KindSeal, KindTag, type Kind } from '../ui/kinds.tsx'
import { ReserveBasis } from '../ui/reserve.tsx'
import { Btn, Link, Loading, MoneyBar, Problem, Seal, Stamp, useAction, useSession } from '../ui/kit.tsx'
/**
 * The on-chain wallet's mandate, written in place: its own chunk (with the wallet's page, which WalletInline brings),
 * asked for once the page has drawn, as Spend, Save and Grow ask for their wallet parts. Imported statically, it was the
 * last of Protect's files to arrive on the phone profile (33 KB compressed), and the page's first draw waited for it
 * (R12 perf). It already drew nothing until its own reading of the wallet came back, so it shows nothing while it loads.
 */
const YourData = lazy(() => import('./YourData.tsx').then((m) => ({ default: m.YourData })))
const WalletMandate = lazy(() => import('./WalletInline.tsx').then((m) => ({ default: m.WalletMandate })))

// ------------------------------------------------------------------------------------------------ shared by the Protect screens

// MODE_WORD, nearDay, clock and monthLeft have one definition each, in lib/words.ts (so a screen that needs them does not
// download this one); this page re-exports them for its other callers.
export { MODE_WORD, clock, monthLeft, nearDay } from '../lib/words.ts'
/** The same inside a sentence: "today", "tomorrow", "on Tue 24 Nov". */
export const nearDayIn = (ms: number, now: number): string => { const d = nearDay(ms, now); return ['Today', 'Tomorrow', 'Yesterday'].includes(d) ? d.toLowerCase() : `on ${d}` }

export const sellsOnly = (kind: string): boolean => kind === 'floor' || kind === 'exit'

/** A status mark: an icon with its meaning carried by the words beside it, never by colour alone (Security uses it). */
export function Mark({ tone }: { tone: 'ok' | 'wait' | 'void' | 'plain' }) {
  const I = tone === 'ok' ? Check : tone === 'wait' ? Clock : tone === 'void' ? X : Minus
  return <span className={`mark-p ${tone}`} aria-hidden="true"><I /></span>
}

/**
 * Resume one paused instruction. Resuming restores authority, so the server asks a session opened with a password for
 * a fresh passkey confirmation first (401 stepup_required): the passkey confirms and the request is tried once more.
 * An account without a passkey cannot confirm, and the server's own message is shown where the action was taken.
 */
export async function resumeInstruction(id: string, hasPasskey: boolean | undefined): Promise<void> {
  await withPasskeyIfAsked(() => api('POST', `/api/programs/${id}/resume`), hasPasskey)
}

/**
 * Makes a request; when the server asks for a fresh passkey confirmation (a session opened with a password pausing or
 * revoking an instruction that sells to protect, or declining one of its runs: the review of D-094, M3) and the
 * account has a passkey, confirms with it and tries once more. Otherwise the server's message is shown where it was
 * asked.
 */
export { withPasskeyIfAsked } from '../lib/stepup.ts'

/** A length of time in words, in hours, minutes or seconds; never rounded to zero (test mode shortens delays to seconds). */
const dur = (ms: number): string => {
  const [n, unit] = ms >= 3600_000 ? [Math.round(ms / 3600_000), 'hour'] : ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}
/**
 * Every delay on these pages, the account's and the on-chain wallet's, is 72 hours unless an installation shortens it
 * for testing (server/passkeys.ts and chain/rail/config.ts both default to 72 hours).
 */
export const NORMAL_DELAY_MS = 72 * 3600_000
/** A delay in words; a shortened one says so, with what it normally is: "6 seconds here (72 hours normally)". */
export const delayWords = (ms: number): string => (ms < NORMAL_DELAY_MS ? `${dur(ms)} here (${dur(NORMAL_DELAY_MS)} normally)` : dur(ms))
/** A length of time without the comparison, for a sentence that already says the delay is shortened. */
export const durationWords = dur

// A session as a person names it: one definition, in lib/words.ts, so Safeguards need not download Security and this
// screen to name one (R12 perf); re-exported here for Security and the other callers.
export { sessionDevice } from '../lib/words.ts'

/** Names joined as a person would list them: "A", "A and B", "A, B and C". */
export const listed = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ------------------------------------------------------------------------------------------------ the page's parts

type Tone = 'ok' | 'wait' | 'void'

/** What is left of a limit: the meter (for the eye; the words beside it say the same) and the figure in words. */
function Left({ left, of, period, note, exact }: { left: number; of: number; period: string; note?: ReactNode; exact?: boolean }) {
  const share = of > 0 ? Math.max(0, Math.min(1, left / of)) : 0
  return (
    <div className="pr-left">
      <div className={`meter ${share < 0.1 ? 'warn' : ''}`} aria-hidden="true"><i style={{ width: `${(share * 100).toFixed(1)}%` }} /></div>
      <p className="pr-left-fig"><b>{fmt.money(left, exact)} left</b> of {fmt.money(of, exact)} {period}</p>
      {note ? <p className="pr-left-note">{note}</p> : null}
    </div>
  )
}

/** True on a phone-sized screen, where a tile keeps its status and action in view and folds its explanation away. */
export function useNarrow(query = '(max-width: 759px)'): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return narrow
}
const Narrow = createContext(false)

/**
 * Where a rule holds, in words with its enforcer's mark: a neutral chip, never the green of a passed check. What
 * enforces a rule says how far it reaches, not that the owner is safe (R13: no reassuring badge stronger than the
 * evidence; QED's server holds only while QED is sound, and the chain here is a test chain on this computer).
 */
function Scope({ by, children }: { by: 'server' | 'cosigner' | 'chain'; children: ReactNode }) {
  const I = by === 'server' ? Server : by === 'cosigner' ? Signature : Link2
  return <span className="chip pr-scope"><I aria-hidden="true" />{children}</span>
}

/** A link to where something is done, at the foot of its tile. */
const Go = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to} className="pr-go">{children}<ChevronRight aria-hidden="true" /></Link>

/** One band of one kind: its mark, its name and what that kind means, its lead figure, then its tiles. */
function Band({ kind, id, title, lead, figure, busy, children }: { kind: Kind; id: string; title: string; lead: string; figure?: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <section className="panel pr-band" data-kind={kind} id={id} aria-labelledby={`${id}-h`} aria-busy={busy || undefined}>
      <header className="pr-band-head">
        <KindSeal kind={kind} />
        <div className="pr-band-t"><h2 id={`${id}-h`}>{title}</h2><p>{lead}</p></div>
        {figure ? <div className="pr-band-fig">{figure}</div> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * One protection as a tile: what it is, where it stands, what it is in a sentence, and the two facts that tell its kind
 * apart (who sees or enforces it, and what happens if that fails); the one action that improves it last.
 */
function Tile({ id, title, tag, now, what, meta, act, tone, wide, children }: {
  id?: string; title: string; tag?: ReactNode; now?: ReactNode; what?: ReactNode; meta?: [string, ReactNode][]; act?: ReactNode; tone?: Tone; wide?: boolean; children?: ReactNode
}) {
  const narrow = useContext(Narrow)
  const facts = meta?.length ? <dl className="pr-meta">{meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null
  // on a phone the explanation and the two facts fold behind one line that names them; the kind and status stay in view
  const said = listed([...(what ? ['What it is'] : []), ...(meta ?? []).map(([k]) => k.replace(/^./, (c) => c.toLowerCase()))]).replace(/^./, (c) => c.toUpperCase())
  return (
    <li className={`pr-tile ${wide ? 'wide' : ''}`} id={id} data-tone={tone === 'wait' || tone === 'void' ? tone : undefined}>
      <div className="pr-tile-top"><h3>{title}</h3>{tag}</div>
      {now ? <div className="pr-tile-now">{now}</div> : null}
      {narrow && (what || facts) ? <details className="pr-more"><summary>{said}</summary>{what ? <p className="pr-tile-d">{what}</p> : null}{facts}</details> : <>{what ? <p className="pr-tile-d">{what}</p> : null}{facts}</>}
      {children}
      {act ? <div className="pr-tile-act">{act}</div> : null}
    </li>
  )
}

/** A tile in a band's shape while its figures are read, or with what went wrong in reading them. */
function Pending({ error, n = 2 }: { error: ApiError | null | undefined; n?: number }) {
  if (error) return <li className="pr-tile wide"><Problem error={error} /></li>
  return <>{Array.from({ length: n }, (_, i) => <li key={i} className="pr-tile" aria-hidden="true"><span className="skel pr-skel" /></li>)}</>
}

// ------------------------------------------------------------------------------------------------ the screen

interface SecurityBrief {
  passkeys: { name: string; removedAt: number | null; suspendedAt: number | null; current: boolean }[]
  contacts: { handle: string; active: boolean; acceptedAt: number | null; hasPasskey?: boolean }[]
  sessions: { current: boolean; method: string; device: string | null }[]
  recoveryCodesLeft: number
  recoveries: { started_at: number; available_at: number; cancelled_at: number | null; completed_at: number | null }[]
  scheduled: { kind: string; effective_at: number }[]
  secondMethod: { contacts: number; password: boolean }
  delays: { recoveryMs: number; protectionMs: number; testMode: boolean }
}
type Raw = string
interface VaultBrief {
  available: boolean; setUp: boolean
  workspace: { asset: { decimals: number }; threshold: number | null; signers: { role: string }[] } | null
  state: {
    provisioned: boolean
    treasury: { paused: boolean; worstCaseLoss24h: Raw }
    roles: { cosignerIsolation: string }
    venues: unknown[]
    mandate: { status: string; fields: { requireCosign: boolean }; usage: { period: { remaining: Raw }; lifetime: { limit: Raw; remaining: Raw }; validity: { validUntil: number } } } | null
  } | null
}
interface SignersBrief { delaySeconds: number }
interface EngineView { running: boolean; lastBeat: number | null }
/** One fault and how it went (server/incidents.ts): when it opened, what happened, what it affected, how and when it ended. */
export interface IncidentBrief { id: string; key: string; title: string; openedAt: number; resolvedAt: number | null; resolution: string | null; affected: { missedRuns?: number; missedTicks?: number; differences?: number; failedRequests?: number }; events: { ts: number; event: string; detail: string | null }[] }
export interface IncidentsBrief { open: IncidentBrief[]; recent: IncidentBrief[] }

/** What an incident cost, in words: missed runs, missed ticks, differences, refused requests. */
export function affectedWords(a: IncidentBrief['affected']): string {
  const out: string[] = []
  const one = (n: number | undefined, w: string, many = `${w}s`) => { if (n) out.push(`${n} ${n === 1 ? w : many}`) }
  one(a.missedRuns, 'missed run'); one(a.missedTicks, 'missed wallet tick'); one(a.differences, 'difference with a venue'); one(a.failedRequests, 'request not saved', 'requests not saved')
  return out.length ? out.join(', ') : 'Nothing lost'
}
type Chain = VaultBrief['state']

/** Where the account stands, in one sentence, from what QED observes (the strictest rule first). */
function verdict(sec: SecurityBrief | null): { text: string; tone: Tone; facts: string } | null {
  if (!sec) return null
  const keys = sec.passkeys.filter((p) => !p.removedAt && !p.suspendedAt).length
  const issuer = sec.contacts.find((c) => c.active && c.hasPasskey)
  const noSecond = !issuer && !sec.secondMethod.password
  const open = sec.recoveries.some((r) => !r.cancelled_at && !r.completed_at)
  const [text, tone]: [string, Tone] = open ? ['Someone may be recovering this account', 'void']
    : keys === 0 ? ['No passkey can sign for you yet', 'void']
    : keys === 1 && noSecond ? ['One lost device would lose this account', 'wait']
    : noSecond ? ['A saved code alone cannot recover this account', 'wait']
    : sec.recoveryCodesLeft === 0 ? ['No saved recovery codes are left', 'wait']
    : keys === 1 ? ['You can get back in if you lose your device', 'ok']
    : ['Every safeguard here is in place', 'ok']
  const second = issuer ? `@${issuer.handle} can help you recover` : sec.secondMethod.password ? 'your password stands in for a recovery contact' : 'no recovery contact'
  return { text, tone, facts: `${plural(keys, 'passkey')}, ${sec.recoveryCodesLeft} of 10 saved codes, ${second}.` }
}
const VerdictMark = ({ tone }: { tone: Tone }) => { const I = tone === 'ok' ? Check : tone === 'wait' ? Clock : X; return <I aria-hidden="true" /> }

/** What needs the owner on this page, each with the tile it is about. */
function needsOf({ sec, engine, home, chain, recoveryKeys }: { sec: SecurityBrief | null; engine: EngineView | null; home: Home | null; chain: Chain; recoveryKeys: number }): { to: string; text: string; tone: Tone }[] {
  const out: { to: string; text: string; tone: Tone }[] = []
  if (engine && !engine.running) out.push({ to: 'pr-engine', text: "QED's engine is not running", tone: 'void' })
  if (sec) {
    const keys = sec.passkeys.filter((p) => !p.removedAt && !p.suspendedAt).length
    const issuer = sec.contacts.find((c) => c.active && c.hasPasskey)
    const open = sec.recoveries.some((r) => !r.cancelled_at && !r.completed_at)
    if (open) out.push({ to: 'pr-recovery', text: 'A recovery has started: stop it if it was not you', tone: 'void' })
    if (keys === 0) out.push({ to: 'pr-passkeys', text: 'Add a passkey: nothing can be approved yet', tone: 'void' })
    else if (keys === 1) out.push({ to: 'pr-passkeys', text: 'Add a second passkey', tone: 'wait' })
    if (!open && !(sec.recoveryCodesLeft > 0 && (issuer || sec.secondMethod.password))) out.push({ to: 'pr-recovery', text: sec.recoveryCodesLeft === 0 ? 'Make new recovery codes' : 'Name a recovery contact', tone: 'wait' })
    if (sec.scheduled.length) out.push({ to: 'pr-waiting', text: `Check ${sec.scheduled.length === 1 ? 'the change' : `the ${sec.scheduled.length} changes`} waiting to take effect`, tone: 'wait' })
    const byPassword = sec.sessions.filter((x) => x.method === 'password').length
    if (byPassword && sec.sessions.length > 1) out.push({ to: 'pr-sessions', text: `Check ${byPassword === 1 ? 'the session' : `the ${byPassword} sessions`} opened with a password`, tone: 'wait' })
  }
  if (home && !home.receipts.ok) out.push({ to: 'pr-records', text: 'Your receipt chain is broken: see where', tone: 'void' })
  if (home?.overview.worst.valid && home.overview.worst.cushion < 0) out.push({ to: 'pr-floor', text: 'You are below your floor', tone: 'void' })
  if (chain?.treasury.paused) out.push({ to: 'pr-chain', text: "Your on-chain wallet's contract is paused", tone: 'wait' })
  // R7-036: an operation a reorganisation of the chain undid is not done; it is told on Home too (vault-watch.ts)
  const undone = home?.notices.filter((n) => n.kind === 'vault-job-reorged').length ?? 0
  if (undone) out.push({ to: 'pr-chain', text: undone === 1 ? 'An operation on your on-chain wallet is not done: a chain reorganisation undid it' : `${undone} operations on your on-chain wallet are not done: a chain reorganisation undid them`, tone: 'void' })
  if (chain && recoveryKeys === 0) out.push({ to: 'pr-wallet-signers', text: 'Add a recovery key to your on-chain wallet', tone: 'wait' })
  return out
}

export function ProtectScreen() {
  const now = useNow(10_000)
  const { session } = useSession()
  const progs = useData<{ programs: ProgramSummary[] }>('/api/programs', ['program', 'run', 'stop'])
  const liq = useData<{ liquidity: Liquidity; envelope: AuthorityEnvelope }>('/api/liquidity', ['action', 'run', 'program', 'bill', 'profile'])
  const home = useData<Home>('/api/home', ['action', 'run', 'program', 'recon', 'profile'])
  const sec = useData<SecurityBrief>('/api/security', ['security'])
  const vault = useData<VaultBrief>('/api/vault', ['vault'])
  const payees = useData<{ payees: { id: string; name: string }[] }>('/api/payees')
  const engine = useData<{ engine: EngineView }>('/api/engine', ['beat', 'engine'])
  const incidents = useData<IncidentsBrief>('/api/incidents', ['beat', 'engine'])
  // the wallet's own account is asked for its delay only when there is a wallet (it answers 409 otherwise)
  const chain = vault.data?.available && vault.data.setUp && vault.data.state?.provisioned ? vault.data.state : null
  const signers = useData<SignersBrief>(chain ? '/api/vault/signers' : null, ['vault'])
  const [acting, setActing] = useState<string | null>(null)
  const narrow = useNarrow()
  const pause = useAction(async (p: ProgramSummary) => {
    setActing(p.id)
    try { if (p.state === 'paused') await resumeInstruction(p.id, session.hasPasskey); else await withPasskeyIfAsked(() => api('POST', `/api/programs/${p.id}/pause`), session.hasPasskey); progs.reload(); liq.reload() } finally { setActing(null) }
  })

  const head = (
    <header className="page-head pr-head">
      <div>
        <h1>Protect</h1>
        <p>What QED watches, what you have set, and who enforces each rule, down to what still holds if QED itself fails.</p>
      </div>
      <Link className="btn fill" to="/instructions/new"><Plus aria-hidden="true" />New instruction</Link>
    </header>
  )
  // One draw: the requests that shape the bands settle first (an answer or an error), so a band arriving late does not
  // push the bands below it (drawn in pieces, the page's lab layout shift was 0.12, over the 0.1 budget).
  const settled = (r: { data: unknown; error: unknown }) => r.data !== null || r.error !== null
  if (![progs, liq, home, sec, vault, engine, payees].every(settled)) return <div className="pr">{head}<div className="page-wait"><Loading what="Opening Protect" /></div></div>

  const list = progs.data?.programs.filter((p) => p.state === 'active' || p.state === 'paused') ?? []
  const month = progs.data && list.length === 0 ? 0 : liq.data?.envelope.windows.find((w) => w.days === 30)?.most ?? null
  const spenders = liq.data?.envelope.instructions.filter((i) => (i.most[i.most.length - 1] ?? 0) > 0).length ?? 0
  const sellers = list.filter((p) => sellsOnly(p.kind)).length
  const paused = list.filter((p) => p.state === 'paused').length
  const eng = engine.data?.engine ?? session.engine ?? null
  const recoveryKeys = (vault.data?.workspace?.signers ?? []).filter((s) => s.role === 'recovery').length
  const needs = needsOf({ sec: sec.data, engine: eng, home: home.data, chain, recoveryKeys })
  const v = verdict(sec.data)

  return (
    <Narrow.Provider value={narrow}>
    <div className="pr">
      {head}
      {needs.length ? (
        <nav className="pr-needs" aria-label="What needs you on this page">
          <span className="count" aria-hidden="true">{needs.length}</span>
          <span className="pr-needs-k">{needs.length === 1 ? 'One thing needs you:' : `${needs.length} things need you:`}</span>
          <ul>{needs.map((n) => <li key={n.to + n.text} data-tone={n.tone}><a href={`#${n.to}`}>{n.text}</a></li>)}</ul>
        </nav>
      ) : null}

      <div className="pr-top">
        <May month={month} instructions={list.length} spenders={spenders} home={home.data} liq={liq.data?.liquidity ?? null} envelope={liq.data?.envelope ?? null} error={liq.error ?? progs.error} />
        <EvenIfFails vault={vault.data} chain={chain} error={vault.error} />
      </div>
      <Ladder vault={vault.data} chain={chain} error={vault.error} />

      <Band kind="watched" id="watched" title="Watched" lead="QED sees these and tells you, here and in Notifications. None of them stops anything on its own." busy={!sec.data && !sec.error}
        figure={<><p className="k">Your account</p>{v ? <p className="v words" data-tone={v.tone}><VerdictMark tone={v.tone} />{v.text}</p> : <p className="v words">Not known now</p>}<p className="s">{v ? v.facts : sec.error ? `Your passkeys and recovery could not be read: ${sec.error.message}` : ''}</p></>}>
        <Watched sec={sec.data} secError={sec.error} home={home.data} engine={eng} incidents={incidents.data} now={now} />
      </Band>

      <Band kind="set" id="yours" title="Set by you" lead="The rules you chose for your bank account. Each is only as strong as what enforces it, named on it: here that is QED's server, which checks every action before it is sent. No model decides." busy={!progs.data && !progs.error}
        figure={<><p className="k">In force</p><p className="v">{plural(list.length, 'instruction')}</p><p className="s">{list.length ? `Signed by you: ${spenders} can spend from your bank account${sellers ? `, ${sellers} only sell, to protect you` : ''}${paused ? `; ${paused} paused` : ''}.` : 'QED may take nothing from your bank account until your passkey signs an instruction.'}</p></>}>
        <Yours progs={progs} envelope={liq.data?.envelope ?? null} liq={liq.data?.liquidity ?? null} home={home.data} payees={payees.data?.payees ?? null} now={now} acting={acting} pause={pause} />
      </Band>

      <Band kind="enforced" id="enforced" title="Enforced" lead="What refuses, not just tells: QED's server on every action, whatever you set, and on your on-chain wallet the chain, which holds even if QED is wrong or taken over. Test money, on a chain on this computer." busy={!vault.data && !vault.error}>
        <Enforced sec={sec.data} vault={vault.data} error={vault.error} chain={chain} delay={signers.data?.delaySeconds ?? null} />
      </Band>

      <Suspense fallback={null}><YourData /></Suspense>
    </div>
    </Narrow.Provider>
  )
}

/** The most QED may move, at true scale against the bank account, and how it builds up over a day, a week and a month. */
function May({ month, instructions, spenders, home, liq, envelope, error }: { month: number | null; instructions: number; spenders: number; home: Home | null; liq: Liquidity | null; envelope: AuthorityEnvelope | null; error: ApiError | null }) {
  const win = (d: number) => envelope?.windows.find((w) => w.days === d)?.most ?? null
  return (
    <section className="panel pr-may" aria-labelledby="pr-may-h">
      <div className="pr-may-head"><h2 id="pr-may-h">QED may move</h2><span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span></div>
      {month === null ? (error ? <p className="pr-hero words">Not known now</p> : <span className="skel pr-skel-fig" />) : <p className="pr-hero" data-resolve="">{fmt.money(month)}</p>}
      <p className="pr-hero-sub">{month === null && error ? `Your instructions could not be read: ${error.message}` : month ? `At most, from your bank account, in the next 30 days, under the ${spenders === 1 ? 'one instruction' : `${spenders} instructions`} that can spend from it. Never from what is kept for what is due.` : month === 0 ? (instructions ? 'Nothing from your bank account: the instructions in force only sell, to protect you.' : 'Nothing: no instruction is signed. QED acts only within limits your passkey signs.') : 'Adding up what your instructions may take together.'}</p>
      {home && liq && month !== null ? <BankBound home={home} liq={liq} may={month} /> : null}
      {month ? (
        <dl className="pr-wins" aria-label="At most, all instructions together">
          {[1, 7, 30].map((d) => <div key={d}><dt>{d === 1 ? 'Today' : `Next ${d} days`}</dt><dd>{win(d) === null ? '…' : fmt.money(win(d)!)}</dd></div>)}
        </dl>
      ) : null}
    </section>
  )
}

/**
 * The bank at true scale on the money bar (DESIGN.md M14): what is free, kept and held (or short), with the span of the
 * most QED may move under the free part it may come from. The key says each part with its figure.
 */
function BankBound({ home, liq, may }: { home: Home; liq: Liquidity; may: number }) {
  const o = home.overview
  const short = liq.short > 0 ? liq.short : 0
  const free = short ? 0 : liq.free
  const kept = Math.min(o.bankAvailable, liq.need)
  const held = o.bankHeld
  const reach = may > 0 && free > 0
  const label = short
    ? `Your bank is ${fmt.money(short, true)} short of what is due: all of the ${fmt.money(kept, true)} in it is kept for what is due, so QED may move none of it.`
    : `${fmt.money(free, true)} free, ${fmt.money(kept, true)} kept${held ? `, ${fmt.money(held, true)} held for orders and payments on hold` : ''}. ${reach ? `QED may move at most ${fmt.money(may)} in 30 days, from the free part only.` : 'QED may move none of it.'}`
  return (
    <div className="pr-bar-wrap">
      <MoneyBar label={label} parts={[{ tone: 'free', value: free, reach: reach ? may : 0 }, { tone: 'kept', value: kept }, { tone: 'held', value: held }, { tone: 'short', value: short }]} keys={[
        ...(free > 0 ? [{ tone: 'free' as const, text: <>Free <b>{fmt.money(free, true)}</b></> }] : []),
        { tone: 'kept', text: <>Kept for what is due <b>{fmt.money(kept, true)}</b>, never used by QED</> },
        ...(held ? [{ tone: 'held' as const, text: <>Held for orders and payments on hold <b>{fmt.money(held, true)}</b></> }] : []),
        ...(short ? [{ tone: 'short' as const, text: <>Short <b>{fmt.money(short, true)}</b></> }] : []),
        ...(reach ? [{ tone: 'reach' as const, text: 'The most QED may move, from the free part' }] : []),
      ]} />
    </div>
  )
}

/**
 * Who enforces what, from inside QED to outside it: the model (nothing), QED's server (every action), the co-signer and
 * the chain (the on-chain wallet, even if QED fails), and the bank, rails and venues (paper in this build).
 */
function Ladder({ vault, chain, error }: { vault: VaultBrief | null; chain: Chain; error: ApiError | null }) {
  const m = chain?.mandate?.status === 'active' ? chain.mandate : null
  const own = chain?.roles.cosignerIsolation === 'separate-process'
  const noWallet = error ? 'The on-chain wallet could not be read just now.' : !vault?.available ? "The on-chain wallet's service is not running, so nothing on the chain can be read now." : 'Only with an on-chain wallet, and you have none set up yet.'
  const stops: { key: string; icon: ReactNode; name: string; does: string; chip: ReactNode }[] = [
    { key: 'model', icon: <MessagesSquare />, name: 'The model behind Ask', does: 'Only proposes. It holds no credential and can approve, send or change nothing.', chip: <Stamp tone="plain">Enforces nothing</Stamp> },
    { key: 'server', icon: <Server />, name: "QED's server", does: 'Fixed code checks every action against your rules and its own before anything is sent. No model decides. It holds only while QED itself is sound.', chip: <Scope by="server">Every action</Scope> },
    { key: 'cosigner', icon: <Signature />, name: 'The co-signer', does: chain ? (m?.fields.requireCosign === false ? 'Your mandate in force does not ask for its signature.' : `A second key${own ? ', in its own process,' : ''} signs each payment and conversion from your on-chain wallet, by its own rules.`) : noWallet, chip: chain ? (m?.fields.requireCosign === false ? <Stamp tone="plain">Not required</Stamp> : <Scope by="cosigner">Each payment</Scope>) : <Stamp tone="plain">No wallet</Stamp> },
    { key: 'chain', icon: <Link2 />, name: 'The chain', does: chain ? "The wallet's contract refuses a payment beyond your mandate and a conversion at a worse price; its own account takes only your passkeys' signatures. Here it is a test chain on this computer, and the contracts are not externally audited." : noWallet, chip: chain ? <Scope by="chain">Even if QED's server fails</Scope> : <Stamp tone="plain">No wallet</Stamp> },
    { key: 'paper', icon: <Landmark />, name: 'Your bank, rails and venues', does: "Paper in this build: QED's own ledger stands in for them, so they add no check of their own.", chip: <Stamp tone="plain">Paper</Stamp> },
  ]
  return (
    <section className="panel pr-ladder" aria-labelledby="pr-ladder-h">
      <div className="pr-ladder-head"><h2 id="pr-ladder-h">Who enforces what</h2><p>From inside QED to outside it</p></div>
      <ol className="pr-steps">
        {stops.map((s) => (
          <li key={s.key} data-stop={s.key}>
            <span className="pr-node" aria-hidden="true">{s.icon}</span>
            <p className="pr-step-n">{s.name}</p>
            <span className="pr-step-c">{s.chip}</span>
            <p className="pr-step-d">{s.does}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Beside what QED may move: the most that could leave the on-chain wallet if QED and its co-signer were both taken
 * over, which the chain enforces, and what holds there.
 */
function EvenIfFails({ vault, chain, error }: { vault: VaultBrief | null; chain: Chain; error: ApiError | null }) {
  const dec = vault?.workspace?.asset.decimals ?? 2
  const worst = chain ? atomsToPaise(chain.treasury.worstCaseLoss24h, dec) : null
  const mandate = chain?.mandate?.status === 'active'
  const cosign = chain?.mandate?.fields.requireCosign !== false
  return (
    <section className="panel pr-fails" aria-labelledby="pr-fails-h">
      <div className="pr-may-head"><h2 id="pr-fails-h">Even if QED fails</h2><KindTag kind="enforced" by="chain" /></div>
      {!vault ? <p className="pr-hero words">{error ? 'Not known now' : '…'}</p>
        : chain && worst !== null && mandate ? <p className="pr-hero" data-resolve="">{fmt.money(worst, true)}</p>
        : <p className="pr-hero words">{chain ? 'Nothing can leave the wallet' : 'No on-chain wallet yet'}</p>}
      <p className="pr-hero-sub">{!vault ? (error ? 'The on-chain wallet could not be read.' : '')
        : chain && mandate ? 'The most that could leave your on-chain wallet in 24 hours if QED and its co-signer were both taken over, and only to payees you approved. It does not count price moves inside your venues.'
        : chain ? 'No mandate is in force on your on-chain wallet, so the agent can pay no one from it.'
        : !vault.available ? 'The on-chain wallet\'s service is not running, so nothing on the chain can be read now.'
        : 'Only an on-chain wallet\'s contract holds limits outside QED\'s server. Without one, everything QED may do rests on its own checks.'}</p>
      {chain ? (
        <ul className="pr-holds" aria-label="What holds on the chain">
          <li>{mandate ? 'Your mandate\'s limits and payees' : 'No payment without a mandate'}</li>
          <li>{cosign ? 'A second signature on each payment' : 'No second signature asked for'}</li>
          <li>The best price on each conversion</li>
          <li>Only your passkeys sign for it</li>
        </ul>
      ) : null}
      <p className="pr-fails-go"><a className="pr-go" href="#enforced">What is enforced, and by whom<ChevronRight aria-hidden="true" /></a></p>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ watched

function Watched({ sec, secError, home, engine, incidents, now }: { sec: SecurityBrief | null; secError: ApiError | null; home: Home | null; engine: EngineView | null; incidents: IncidentsBrief | null; now: number }) {
  const { session } = useSession()
  const stop = session.stop
  const down = !!engine && !engine.running
  const beat = engine?.lastBeat ?? null
  const tiles: ReactNode[] = [
    <Tile key="engine" id="pr-engine" title="QED's engine" tone={down ? 'void' : stop ? 'wait' : undefined}
      now={down ? <><Stamp tone="void">Not running</Stamp><span>{beat ? `Last heartbeat ${fmt.rel(beat, now)}.` : 'No heartbeat on record.'} Nothing is watched or carried out.</span></>
        : stop ? <><Stamp tone="wait">{stop.protectiveContinues ? 'Paused, protection on' : 'Paused'}</Stamp><span>Since {fmt.dayTime(stop.at)}. {stop.protectiveContinues ? 'Only protective selling can run.' : 'Nothing runs.'}</span></>
        : engine ? <><Stamp tone="ok">Running</Stamp><span>Heartbeat {beat ? fmt.age(Math.max(0, now - beat)) : 'not yet heard'}.</span></> : <span className="skel pr-skel-line" />}
      what="Carries out your instructions and watches prices, on this computer; QED sees it from the engine's own heartbeat. Its one pause control is the status button in the top bar."
      meta={[['If it goes wrong', 'Nothing runs, protective selling included. Runs it misses are skipped, not made up later.']]} />,
    <Tile key="incidents" id="pr-incidents" title="Faults and how they ended" tone={incidents?.open.length ? 'void' : undefined}
      now={!incidents ? <span className="skel pr-skel-line" /> : incidents.open.length
        ? <><Stamp tone="void">{plural(incidents.open.length, 'fault')} open</Stamp><span>{incidents.open[0]!.title}, since {fmt.dayTime(incidents.open[0]!.openedAt)}. {affectedWords(incidents.open[0]!.affected)} so far.</span></>
        : <><Stamp tone="ok">None open</Stamp><span>{incidents.recent.length ? `The last ended ${fmt.rel(incidents.recent[0]!.resolvedAt!, now)}.` : 'No fault has been recorded.'}</span></>}
      what="A fault of the engine, the wallet service, the engine's readiness or reconciliation is recorded from the moment it opens until it ends, with what it cost."
      meta={[['If it goes wrong', 'A fault that cannot be recorded because the disk is full is shown from memory and written when there is room.']]}>
      {incidents && (incidents.open.length || incidents.recent.length) ? (
        <ul className="pr-incidents" aria-label="Recent faults">
          {[...incidents.open, ...incidents.recent.slice(0, 3)].map((i) => (
            <li key={i.id} data-open={i.resolvedAt === null ? 'true' : undefined}>
              <p className="pr-inc-t"><strong>{i.title}</strong> <span>{i.resolvedAt === null ? `open since ${fmt.dayTime(i.openedAt)}` : `${fmt.dayTime(i.openedAt)} to ${fmt.dayTime(i.resolvedAt)}`}</span></p>
              <p className="pr-inc-a">{affectedWords(i.affected)}.{i.resolution ? ` ${i.resolution}` : ''}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </Tile>,
  ]
  if (!sec) return <ul className="pr-tiles" data-n="3">{tiles}<Pending error={secError} n={2} /></ul>
  const keys = sec.passkeys.filter((p) => !p.removedAt && !p.suspendedAt)
  const suspended = sec.passkeys.filter((p) => !p.removedAt && p.suspendedAt).length
  const issuer = sec.contacts.find((c) => c.active && c.hasPasskey)
  const noSecond = !issuer && !sec.secondMethod.password
  const open = sec.recoveries.filter((r) => !r.cancelled_at && !r.completed_at)
  const codes = sec.recoveryCodesLeft
  const ready = codes > 0 && !noSecond
  const byPassword = sec.sessions.filter((x) => x.method === 'password').length
  const names = keys.map((k) => k.name)
  tiles.push(
    <Tile key="passkeys" id="pr-passkeys" title="Your passkeys" tone={keys.length === 0 ? 'void' : keys.length === 1 ? 'wait' : undefined}
      now={<><Stamp tone={keys.length === 0 ? 'void' : keys.length === 1 ? 'wait' : 'ok'}>{keys.length === 0 ? 'None yet' : keys.length === 1 ? 'Only one' : plural(keys.length, 'passkey')}</Stamp>{names.length ? <span>{listed(names.slice(0, 3).map((n) => `“${n}”`))}{names.length > 3 ? ` and ${names.length - 3} more` : ''}{suspended ? `; ${suspended} suspended` : ''}.</span> : <span>Nothing can be approved until you add one.</span>}</>}
      what="Each is held by a device and unlocked there; whatever you approve is its signature. QED's sign-in sees them."
      meta={[['If it goes wrong', keys.length > 1 ? 'Lose one device: suspend its passkey under Security; another still signs.' : keys.length === 1 ? 'Lose this device: suspend its passkey under Security. With no second passkey, getting back in takes a recovery.' : 'Without a passkey nothing can be approved, by you or by QED.']]}
      act={<Go to="/security#passkeys">{keys.length < 2 ? 'Add a passkey' : 'Your passkeys'}</Go>} />,
    <Tile key="sessions" id="pr-sessions" title="Where you are signed in" tone={byPassword && sec.sessions.length > 1 ? 'wait' : undefined}
      now={sec.sessions.length <= 1 ? <><Stamp tone="ok">Here only</Stamp><span>This session, opened with {sec.sessions[0]?.method === 'password' ? 'a password' : 'a passkey'}.</span></>
        : <><Stamp tone="plain">{plural(sec.sessions.length, 'session')}</Stamp><span>{byPassword ? `${byPassword} opened with a password.` : 'All opened with a passkey.'}</span></>}
      what="Every browser or program signed in to this account, as QED's sign-in sees them."
      meta={[['If it goes wrong', 'A session you do not know can look and prepare, never approve: approving takes your passkey. End it under Security.']]}
      act={sec.sessions.length > 1 ? <Go to="/security#sessions">Review them</Go> : undefined} />,
    <Tile key="recovery" id="pr-recovery" title="If you lose every device" tone={open.length ? 'void' : ready ? undefined : 'wait'}
      now={open.length ? <><Stamp tone="void">Under way</Stamp><span>Started {fmt.dayTime(open[0]!.started_at)}; a new passkey can be added from {fmt.dayTime(open[0]!.available_at)}.</span></>
        : <><Stamp tone={ready ? 'ok' : 'wait'}>{ready ? 'Ready' : 'Not ready'}</Stamp><span>{codes} of 10 saved codes; {issuer ? `@${issuer.handle} can issue the second code` : sec.secondMethod.password ? 'your password is the second proof' : 'no recovery contact'}.</span></>}
      what="A recovery takes a saved code, a second proof and a wait, which QED's server enforces (under Enforced)."
      meta={[['If it goes wrong', open.length ? 'Any of your passkeys can stop it until the wait ends.' : ready ? 'Someone with your codes still has to wait, seen by every session, and any passkey can stop them.' : 'A saved code alone cannot get you back in: the account would be lost.']]}
      act={open.length ? <Go to="/security">Cancel it if it was not you</Go> : noSecond ? <Go to="/security#recovery">Name a recovery contact</Go> : codes <= 3 ? <Go to="/security#recovery">Make new codes</Go> : undefined} />,
  )
  if (sec.scheduled.length) {
    const first = Math.min(...sec.scheduled.map((c) => c.effective_at))
    tiles.push(
      <Tile key="waiting" id="pr-waiting" title="Changes waiting to take effect" tone="wait"
        now={<><Stamp tone="wait">{sec.scheduled.length} waiting</Stamp><span>The first applies {fmt.rel(first, now)}.</span></>}
        what={`Each weakens a protection, so QED's server holds it for ${delayWords(sec.delays.protectionMs)}.`}
        meta={[['If nobody acts', 'It applies by itself when the wait ends, unless one of your passkeys cancels it.']]}
        act={<Go to="/security">Review them</Go>} />,
    )
  }
  tiles.push(
    <Tile key="records" id="pr-records" title="Your records" tone={home && (!home.receipts.ok || home.chainBooks?.comparison?.state === 'disagrees') ? 'void' : undefined}
      now={!home ? <span className="skel pr-skel-line" /> : <>
        {!home.receipts.ok ? <Stamp tone="void">Broken at no. {home.receipts.brokenAt}</Stamp> : home.receipts.count ? <span className="pr-sealed"><Seal />{plural(home.receipts.count, 'receipt')}, chain intact</span> : <span className="pr-v">No receipts yet</span>}
        {home.recon ? <span>{home.recon.ok ? `Books agree with the venues, checked ${fmt.rel(home.recon.ts, now)}.` : `${plural(home.recon.breaks.length, 'difference')} with the venues, found ${fmt.rel(home.recon.ts, now)}.`}</span> : null}
        <ChainBooksLine home={home} now={now} />
      </>}
      what="Every action leaves a receipt that seals the one before it, and the books are compared with each venue's. QED checks them, and your browser can repeat the check."
      meta={[['If it goes wrong', 'The first entry that does not match is named, and an action whose records differ is never shown as done.']]}
      act={<Go to="/safeguards">Check them in your browser</Go>} />,
  )
  return <ul className="pr-tiles" data-n={tiles.length}>{tiles}</ul>
}

/** The on-chain wallet's books against the chain, as last compared (server/chain-books.ts): a disagreement with its figures, never corrected. */
function ChainBooksLine({ home, now }: { home: Home; now: number }) {
  const c = home.chainBooks?.comparison
  if (!c) return null
  const words = home.chainBooks!.words
  if (c.state === 'agrees') return <span>The on-chain wallet's books agree with the chain, checked {fmt.rel(c.at, now)} ({words}).</span>
  if (c.state === 'unknown') return <span>The on-chain wallet's books were not compared {fmt.rel(c.at, now)}: {c.why ?? 'the wallet service did not answer'}.</span>
  const off = c.assets.filter((a) => a.difference !== '0')
  const amt = (raw: string | null, a: { decimals: number; words: string }): string => (raw === null ? 'not known' : `${(Number(raw) / 10 ** a.decimals).toFixed(a.decimals)} ${a.words}`)
  return <span className="pr-chain-books"><Stamp tone="void">Books and chain disagree</Stamp> Your books and your on-chain wallet disagree, found {fmt.rel(c.at, now)}{c.why ? `: ${c.why}` : ''}{off.map((a) => `; ${a.words}: the books hold ${amt(a.books, a)} with ${amt(a.inFlight, a)} in flight, the chain ${amt(a.chain, a)}`).join('')}. Nothing was corrected; these are {words}.</span>
}

// ------------------------------------------------------------------------------------------------ set by you

function Yours({ progs, envelope, liq, home, payees, now, acting, pause }: {
  progs: { data: { programs: ProgramSummary[] } | null; error: ApiError | null }
  envelope: AuthorityEnvelope | null; liq: Liquidity | null; home: Home | null; payees: { id: string; name: string }[] | null; now: number; acting: string | null
  pause: { run: (p: ProgramSummary) => Promise<boolean>; busy: boolean; error: ApiError | null }
}) {
  const { session } = useSession()
  if (!progs.data) return <ul className="pr-tiles"><Pending error={progs.error} n={3} /></ul>
  // only what is signed is authority (R7-111 F1): drafts are listed apart, as what QED may NOT do yet
  const list = progs.data.programs.filter((p) => p.state === 'active' || p.state === 'paused')
  const drafts = progs.data.programs.filter((p) => p.state === 'draft')
  const ended = progs.data.programs.filter((p) => !['active', 'paused', 'draft'].includes(p.state))
  const most30 = (id: string) => envelope?.instructions.find((i) => i.id === id)?.most[2] ?? null
  const worst = home?.overview.worst
  const floor = list.find((p) => p.kind === 'floor' && p.state === 'active')
  const ws = session.workspace
  const pol = ws?.policy as { signers: number; makerChecker: boolean; largePaise?: number | null; largeSigners?: number | null } | undefined
  const business = ws?.kind === 'business'
  const names = (payees ?? []).map((p) => p.name)
  return (
    <>
      <div className="pr-ins" id="pr-instructions">
        <div className="pr-ins-head">
          <h3>Standing instructions</h3>
          <KindTag kind="enforced" by="server" />
          {list.length ? <Go to="/instructions">All instructions{ended.length ? `, ${ended.length} ended` : ''}</Go> : <Go to="/instructions/new">Write an instruction</Go>}
        </div>
        {list.length ? (
          <ul className="pr-lanes" aria-label="Signed instructions">
            {list.map((p) => {
              const a = p.authority
              const l = monthLeft(p)
              const off = p.state === 'paused'
              // QED's own pause holds it too (all but protective selling the owner kept): said, and no next run (gap 15)
              const held = !off && p.state === 'active' && heldByPause(p.kind, session.stop)
              const m30 = most30(p.id)
              const mode = off || held ? 'paused' : sellsOnly(p.kind) ? 'watch' : a?.runMode ?? 'auto'
              return (
                <li key={p.id} className={`pr-lane ${off ? 'is-paused' : ''}`}>
                  <div className="pr-lane-top">
                    <h4><Link to={`/instructions/${p.id}`}>{p.title}</Link></h4>
                    <Btn small busy={pause.busy && acting === p.id} onClick={() => void pause.run(p)}>{off ? 'Resume' : 'Pause'}<span className="sr"> “{p.title}”</span></Btn>
                  </div>
                  <p className="pr-lane-mode"><b className={`m-${mode}`}>{off ? `Paused${p.pausedReason ? `: ${p.pausedReason.toLowerCase()}` : ''}. No new runs start.` : held ? 'QED is paused. No new runs start.' : a ? MODE_WORD[a.runMode] ?? 'In force' : 'In force'}</b> {[p.scheduleText ?? '', a ? `until ${fmt.dayYear(a.expiresAt)}` : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase())}.{p.nextDueAt && !off && !held ? ` Next run ${nearDayIn(p.nextDueAt, now)} at ${clock(p.nextDueAt)}.` : ''}</p>
                  {l && a && !sellsOnly(p.kind) ? <Left left={l.left} of={l.of} period="this month" note={`${fmt.money(a.maxPerRun)} a run at most${m30 ? `; ${fmt.money(m30)} at most in the next 30 days` : ''}`} />
                    : <p className="pr-lane-sells">{sellsOnly(p.kind) ? 'Sells only, to protect you. It can never buy or pay anyone.' : 'No monthly limit to count yet.'}</p>}
                </li>
              )
            })}
          </ul>
        ) : <p className="pr-ins-none"><b>Nothing is signed.</b> QED may take nothing from your bank account until your passkey signs an instruction. An instruction says what QED may do, how much at most, how it runs and when it ends.</p>}
        {pause.error ? <Problem error={pause.error} /> : null}
        <dl className="pr-meta">
          <div><dt>What enforces it</dt><dd>QED's check before every action: your signed limits, the payees named and what must stay in the bank. No model decides.</dd></div>
          <div><dt>If that fails</dt><dd>Nothing outside QED would stop a larger run from your bank account.</dd></div>
        </dl>
        <p className="pr-ins-note">{drafts.length ? <><b>Not in force:</b> QED can do nothing under {drafts.length === 1 ? 'this draft' : `these ${drafts.length} drafts`} until you sign {drafts.length === 1 ? 'it' : 'them'}: {drafts.map((p, i) => <span key={p.id}>{i ? '; ' : ''}<Link to={`/instructions/${p.id}`}>{p.title}</Link></span>)}. </> : null}Changing an instruction makes a new version, which you sign with your passkey before it is in force.</p>
      </div>

      <ul className="pr-tiles" data-n="4">
        <Tile title="What must stay in your bank" tag={<KindTag kind="enforced" by="server" />}
          now={liq ? <><span className="pr-v" data-reserve="need">{fmt.money(liq.need, true)}</span><span>{liq.binding ? `For what falls due to ${fmt.isoDay(liq.binding.date)}, at worst, as you told QED to allow for.` : 'Nothing due needs money that is not certain to arrive first.'}</span><ReserveBasis l={liq} /></> : <span className="skel pr-skel-line" />}
          meta={[['What enforces it', 'QED\'s server: whatever your instructions\' limits say, none of it can come out of what must stay; a run that would is refused'], ['If that fails', 'It is as good as its list: a bill that is not registered, or spending above your figure, is outside it.']]}
          act={<Go to="/safeguards#reserve">What it allows for</Go>} />
        <Tile title="Payees" tag={<KindTag kind="enforced" by="server" />}
          now={payees === null ? <span className="skel pr-skel-line" /> : names.length ? <><span className="pr-v">{plural(names.length, 'payee')}</span><span>{listed(names.slice(0, 3))}{names.length > 3 ? ` and ${names.length - 3} more` : ''}.</span></> : <><span className="pr-v">None yet</span><span>You add one when you first pay them.</span></>}
          what="Who your payments and instructions may pay. Before a payee is saved, the paper bank checks the name behind its address; in its first day, a large payment to it waits before it is sent."
          meta={[['What enforces it', 'QED\'s server: an instruction pays only the payees it names'], ['Name check', 'The paper bank\'s, on paper: anything but a match is added only once you say you checked the address yourself, and every payment says what it answered'], ['Look-alikes', 'One that looks like a payee you already have is flagged, and added only once you say you checked it; a payment to it says what it looks like before your passkey signs'], ['New payees', 'In a payee\'s first day, a payment above the amount you set waits before it is sent, and you can cancel it meanwhile'], ['If that fails', 'A payment could go to an address you did not mean.']]}
          act={<Go to="/pay">Your payees, in Spend</Go>} />
        <Tile id="pr-floor" title="Your floor" tag={<KindTag kind="enforced" by="server" />} tone={worst?.valid && worst.cushion < 0 ? 'void' : undefined}
          now={!worst ? <span className="skel pr-skel-line" /> : <><span className="pr-v">{fmt.money(worst.line)}</span><span>{worst.valid ? <>If every holding fell to its limit you would have {fmt.money(worst.gHat, true)}, {fmt.money(Math.abs(worst.cushion), true)} {worst.cushion >= 0 ? 'above' : 'below'} it.</> : `Your worst case cannot be worked out now: ${worst.invalidReasons.join('; ') || 'a price is missing'}.`}</span></>}
          what="The least you want to keep if markets fall."
          meta={[['What enforces it', `QED's server: it refuses its own buys that would take you below it${floor ? `, and “${floor.title}” sells to restore it` : ''}. You can still go below it by hand`], ['If that fails', 'A price gap larger than the limits assume, or QED not running when it has to act, can take you below it.']]}
          act={<Go to="/safeguards">Change your floor</Go>} />
        <Tile title="Who must sign" tag={<KindTag kind="enforced" by="server" />}
          now={business && pol ? <><span className="pr-v">{plural(pol.signers, 'signature')}</span><span>For every request{pol.makerChecker ? ', never from whoever prepared it' : ''}{pol.largePaise != null && pol.largeSigners != null ? `; ${pol.largeSigners} from ${fmt.money(pol.largePaise)}` : ''}.</span></> : <><span className="pr-v">You alone</span><span>With your passkey, for every request.</span></>}
          what={business ? `${ws!.name}, a business workspace.` : 'Your personal workspace.'}
          meta={[['What enforces it', 'QED\'s approval check, against your passkey\'s signature'], ['If that fails', 'On your bank account nothing else checks it; on your on-chain wallet the chain checks it again.']]}
          act={<Go to="/workspace">Workspace and members</Go>} />
      </ul>
    </>
  )
}

// ------------------------------------------------------------------------------------------------ enforced

function Enforced({ sec, vault, error, chain, delay }: { sec: SecurityBrief | null; vault: VaultBrief | null; error: ApiError | null; chain: Chain; delay: number | null }) {
  const keys = sec ? sec.passkeys.filter((p) => !p.removedAt && !p.suspendedAt).length : null
  return (
    <>
      <div className="pr-group">
        <div className="pr-group-head"><h3><Server aria-hidden="true" />On QED's server, whatever you set</h3><p>Fixed code, on every action. If QED's server were wrong or taken over, these would not hold; what is enforced on the chain, below, still would.</p></div>
        <ul className="pr-rules" data-n="5">
          <li><span className="pr-rule-t">Approvals need your passkey</span>{keys === 0 ? <Stamp tone="void">No passkey yet</Stamp> : null}<span className="pr-rule-d">Every approval is your passkey signing the exact terms shown, after your device's own check, such as a fingerprint, a face or a PIN; QED's server checks that signature. It covers that one document and is spent when used.</span></li>
          <li><span className="pr-rule-t">A recovery waits</span><span className="pr-rule-d">{sec ? delayWords(sec.delays.recoveryMs) : '72 hours'} before a new passkey can be added, seen by every session; any of your passkeys can stop it.</span></li>
          <li><span className="pr-rule-t">Weakening your account waits</span><span className="pr-rule-d">Removing a passkey, allowing a suspended one again, a new recovery contact, or fewer signatures in a workspace: each waits {sec ? delayWords(sec.delays.protectionMs) : '72 hours'} and can be cancelled meanwhile.</span></li>
          <li><span className="pr-rule-t">Two price sources</span><span className="pr-rule-d">A digital-asset order is refused if the venue's price and an independent price disagree by more than 3%.</span></li>
          <li><span className="pr-rule-t">Records stay as written</span><span className="pr-rule-d">Ledger entries cannot be edited or deleted; the database refuses. Each receipt seals the one before it.</span></li>
        </ul>
      </div>
      <div className="pr-group" id="pr-chain">
        <div className="pr-group-head"><h3><Link2 aria-hidden="true" />On the chain, even if QED fails</h3><p>Your on-chain wallet's contract, its co-signer and its own account hold these even if QED's server is wrong or taken over.</p></div>
        <OnChain vault={vault} error={error} chain={chain} delay={delay} />
      </div>
    </>
  )
}

function OnChain({ vault, error, chain, delay }: { vault: VaultBrief | null; error: ApiError | null; chain: Chain; delay: number | null }) {
  if (!vault) return <ul className="pr-tiles"><Pending error={error} n={2} /></ul>
  if (!vault.available) return <p className="pr-empty">The on-chain wallet's service is not running, so nothing on the chain can be read now. Everything QED may do from your bank account rests on its own checks, above.</p>
  if (!vault.setUp || !chain) {
    return (
      <div className="pr-empty">
        <p><b>{vault.setUp ? 'Your on-chain wallet is waiting for you to accept it.' : 'Nothing here yet.'}</b> An on-chain wallet's contract holds its limits outside QED's server, so they hold even if QED is wrong or taken over. Without one, everything QED may do rests on its own checks, above.</p>
        <Link className="btn sm" to="/vault">{vault.setUp ? 'Accept it' : 'Set up the on-chain wallet'}</Link>
      </div>
    )
  }
  const dec = vault.workspace?.asset.decimals ?? 2
  const paise = (raw: Raw) => atomsToPaise(raw, dec)
  const m = chain.mandate?.status === 'active' ? chain.mandate : null
  const members = (vault.workspace?.signers ?? []).filter((s) => s.role === 'member').length
  const keys = (vault.workspace?.signers ?? []).filter((s) => s.role === 'recovery').length
  const threshold = vault.workspace?.threshold ?? 1
  const worst = paise(chain.treasury.worstCaseLoss24h)
  const own = chain.roles.cosignerIsolation === 'separate-process'
  return (
    <>
      {chain.treasury.paused ? <p className="pr-empty" data-tone="wait"><Stamp tone="wait">Paused</Stamp> The wallet's contract is paused: nothing can be paid from it until it is resumed on <Link to="/vault">the wallet's page</Link>.</p> : null}
      <ul className="pr-tiles" data-n="3">
        <Tile wide title="Payments from your on-chain wallet" tag={<span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="chain" /></span>}
          now={m ? <Left exact left={paise(m.usage.lifetime.remaining)} of={paise(m.usage.lifetime.limit)} period="in all" note={`${fmt.money(paise(m.usage.period.remaining), true)} left today; until ${fmt.dayYear(m.usage.validity.validUntil * 1000)}.`} /> : <Stamp tone="plain">No mandate</Stamp>}
          what={m ? 'Only to the payees your signed mandate names, within its limits, until it ends.' : 'No mandate is in force, so the agent may pay no one from the wallet.'}
          meta={[['What enforces it', 'The wallet\'s contract, on the chain'], ['If QED fails', m ? 'The contract still refuses a payment over these limits, or to anyone the mandate does not name.' : 'Without a mandate the contract lets the agent pay no one.']]}>
          <div className="pr-mandate"><Suspense fallback={null}><WalletMandate /></Suspense></div>
        </Tile>
        <Tile title="A second signature on every payment" tag={<KindTag kind="enforced" by="cosigner" />}
          now={<>{m?.fields.requireCosign === false ? <Stamp tone="plain">Not required</Stamp> : <Scope by="cosigner">Required</Scope>}<span>{own ? 'The co-signer runs as its own process on this computer, with its own key.' : 'The co-signer runs inside the wallet service, with its own key.'}</span></>}
          what="Every payment and conversion from the wallet also needs the co-signer's signature."
          meta={[['What enforces it', 'The co-signer, by its own rules, your authority budget among them; the contract refuses what it has not signed'], ['If QED fails', m ? `The co-signer still refuses what breaks its rules. Taken over too: at most ${fmt.money(worst, true)} in 24 hours, only to payees you approved.` : 'The co-signer still refuses what breaks its rules.']]} />
        <Tile title="The best price on every conversion" tag={<KindTag kind="enforced" by="chain" />}
          now={<><Scope by="chain">Checked on the chain</Scope><span>{plural(chain.venues.length, 'venue')} named.</span></>}
          what="Each conversion carries a proof that its price is the best your named venues offer."
          meta={[['What enforces it', 'The execution contract'], ['If QED fails', 'A conversion at a worse price is refused on the chain, not made. The check covers simple pools and the venues you name, nothing else.']]} />
        <Tile id="pr-wallet-signers" title="Who can sign for the wallet" tag={<KindTag kind="enforced" by="chain" />} tone={keys ? undefined : 'wait'}
          now={<><span className="pr-v">{plural(members, 'passkey')}</span><span>{plural(threshold, 'signature')} for each request{keys ? `; ${plural(keys, 'recovery key')}` : ''}.</span>{keys ? null : <Stamp tone="wait">No recovery key</Stamp>}</>}
          what="Its own account on the chain takes only your passkeys' signatures. QED holds no key that can sign as you."
          meta={[['What enforces it', 'The wallet\'s own account on the chain'], ['If QED fails', `Changing who signs waits${delay !== null ? ` ${delayWords(delay * 1000)}` : ''} on the chain, and any signer can cancel it.`]]}
          act={<Go to="/security#wallet-signers">Who signs, and its recovery key</Go>} />
      </ul>
    </>
  )
}
