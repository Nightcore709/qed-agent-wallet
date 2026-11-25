/**
 * Safeguards: what protects the owner and how far each protection can be relied on right now (DESIGN.md "Meridian").
 * The page opens on how each safeguard stands, each with its kind (ui/kinds.tsx: watched, set by you, enforced, and by
 * whom), then the floor as one rule with its figures (what would be left if markets fell to the owner's limits, the
 * floor, and the room between them that QED's purchases may not cross), then what must stay in the bank, then three
 * bands of glass rows: what protects you, what QED depends on now, and the records you can check yourself.
 *
 * The bank reserve's parts live here too (`ReserveFigures`, `ReserveWhy`, `ReserveAllows`, `Envelope`): Save builds its
 * instrument from them, and this page shows them in brief, with a link to Save for each day.
 */
import { ChevronRight, ListChecks, ShieldCheck } from 'lucide-react'
import { KindTag } from '../ui/kinds.tsx'
import { type ReactNode, useState } from 'react'
import { calibrated } from '../lib/limits.ts'
import { canonical, sha256 } from '../../shared/sha256.ts'
import { api, beginSignOut, endSignOut, fmt, httpsOnly, navigate, useData, useNow } from '../lib/core.ts'
import { confirmWithPasskey } from '../lib/passkey.ts'
import type { AuthorityEnvelope, Home, Liquidity, Market, Receipt, Term } from '../lib/types.ts'
import { FloorRule, Paise } from '../ui/charts.tsx'
import { Basis, Btn, Field, Link, MoneyBar, MoneyInput, Note, Problem, Stamp, Swatch, useAction, useStepUpWhenAsked, useSession } from '../ui/kit.tsx'
import { ReserveBasis } from '../ui/reserve.tsx'
import { profileChangeLines, protectionDelayWords, SOURCE, sessionDevice, statusLine } from '../lib/words.ts'
import { Skel, useHashTarget } from '../ui/page.tsx'

interface System {
  now: number
  engine: { running: boolean; pid: number | null; startedAt: number | null; lastBeat: number | null; ageMs: number | null; ticks: number | null; lastTickMs: number | null }
  providers: Market['providers']
  clock: { ts: number; reference: string; offset_ms: number; uncertainty_ms: number }[]
  downtime: { id: number; service: string; from_ts: number; to_ts: number; missed_runs: number; note: string | null }[]
  downtimeDay: { gaps: number; ms: number; missed: number }
  counts: { quotes: number; samples: number; dailyValues: number; entries: number; receipts: number }
  recon: Home['recon']; receipts: Home['receipts']; ledger: { breaks: { check: string; detail: string }[] }
  ai: { provider: string; model: string; detail: string }
}

// SOURCE, statusLine and sessionDevice live in lib/words.ts, Skel and useHashTarget in ui/page.tsx (R12 perf: taken from
// here, Instructions and Security, they brought Protect and the on-chain wallet into Save, Grow and the Statement).
export { SOURCE, Skel, useHashTarget }
const STATUS: Record<string, [string, 'ok' | 'wait' | 'plain', string]> = {
  verified: ['Checked against its source', 'ok', 'read from a published source on the date shown'],
  unverified: ['Not yet checked', 'wait', 'taken from a source that has not been re-read for this build'],
  modelled: ['Modelled', 'plain', 'an assumption QED states; no published term stands behind it'],
}
const span = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} seconds` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} minutes` : `${(ms / 3_600_000).toFixed(1)} hours`)
const pct = (x: unknown): string => `${+(Number(x) * 100).toFixed(4)}%`
function termFigure(v: Record<string, unknown>): string {
  if (v.apr !== undefined) return `${pct(v.apr)} a year${Array.isArray(v.box) ? `; checks allow ${pct(v.box[0])} to ${pct(v.box[1])}` : ''}${v.prepayCharge !== undefined ? `; ${pct(v.prepayCharge)} to prepay` : ''}${v.breakPenalty !== undefined ? `; ${pct(v.breakPenalty)} less if broken early` : ''}`
  if (v.amount !== undefined) return fmt.money(Number(v.amount))
  if (v.rate !== undefined) return pct(v.rate)
  return ''
}
/**
 * What the pause is doing now, named: "it" beside QED's own name read as QED being off (finish review, 23 Nov). A pause
 * someone else made (a recovery contact, a saved code from the signed-out page) keeps protective selling that runs without
 * asking going by rule (one set to ask first still waits for a passkey approval before each sale: server/policy.ts run-approved),
 * so it is not said to be the owner's choice (R13: attribution on every screen); who made it is said instead.
 */
export function pauseWords(stop: { protectiveContinues?: boolean; reason?: string | null } | null): string {
  if (!stop) return 'The pause is off: instructions in force run as signed.'
  const other = !!stop.reason && !/^(Paused|Stopped) by you$/.test(stop.reason)
  if (!other) return stop.protectiveContinues ? 'The pause is on: nothing runs except protective selling, as you chose.' : 'The pause is on: nothing runs.'
  return stop.protectiveContinues ? `The pause is on: nothing runs except protective selling. ${stop.reason}; a pause made that way keeps protective selling that runs without asking going, and one set to ask first still waits for a passkey approval before each sale.` : `The pause is on: nothing runs. ${stop.reason}.`
}
const minus = (paise: number): string => `−${fmt.money(Math.abs(paise), true)}`

// ------------------------------------------------------------------------------------------------ page helpers shared by Save and Grow

/**
 * Figures written so that they add up, the way the instrument writes them: each term with its label and one line
 * under it, the operators between them, and on a phone the same terms as rows with the operator in front.
 */
export function Terms({ terms, label }: { terms: { op?: '−' | '=' | '+'; k: ReactNode; v: ReactNode; s?: ReactNode; hero?: boolean; tone?: 'short' }[]; label: string }) {
  return (
    <dl className="rv-terms" aria-label={label}>
      {terms.map((t, i) => (
        <div key={i} className={`rv-term ${t.hero ? 'hero' : ''}`}>
          <dt>{t.op ? <span className="rv-op-in">{t.op} </span> : null}{t.k}</dt>
          <dd className={`v ${t.tone ?? ''}`}>{t.v}</dd>
          {t.s ? <dd className="s">{t.s}</dd> : null}
        </div>
      ))}
    </dl>
  )
}

// ------------------------------------------------------------------------------------------------ the floor

function FloorForm({ line, worst, onSaved }: { line: number; worst: number; onSaved: () => void }) {
  const { session, reload } = useSession()
  const [v, setV] = useState<number | null>(line)
  const lowering = v !== null && v < line
  const needPasskey = lowering && !session.stepUpFresh
  const save = useAction(async () => {
    if (v === null) return
    if (needPasskey) await confirmWithPasskey()
    await api('PATCH', '/api/profile', { line: v })
    await reload(); onSaved()
  })
  return (
    <form className="stack pr-sg-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
      <Field label="Keep at least this if markets fell to your limits" hint="QED refuses its own purchases that would go below this. You can still go below it by hand." error={save.error?.fields.line}>{(p) => <MoneyInput {...p} value={v} onChange={setV} />}</Field>
      {v !== null && v > worst ? <Note tone="wait">That is more than you would keep today if markets fell to your limits ({fmt.money(worst, true)}). QED could buy nothing for you, and an instruction that holds your floor would start selling.</Note> : null}
      {lowering ? <p className="small muted">Lowering the floor weakens your protection, so your passkey confirms it and it takes effect only after {protectionDelayWords(session.delays?.protectionMs ?? DELAY_MS)}; until then any of your passkeys can cancel it, and you, and any recovery contacts you have, are told in QED. Raising it takes effect at once.</p> : null}
      {save.error && !save.error.fields.line ? <Problem error={save.error} /> : null}
      <div><Btn type="submit" busy={save.busy} disabled={v === null || v === line}>{needPasskey ? 'Confirm with your passkey and set the floor' : 'Set the floor'}</Btn></div>
    </form>
  )
}

/** The floor as one rule with its figures: what would be left, the floor, and the room between them; then what it counts. */
function Floor({ o, now, onSaved }: { o: Home['overview']; now: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const w = o.worst
  const fall = w.holdingsValue - w.holdingsWorst
  const above = w.cushion >= 0
  return (
    <section className="panel pr-sg-panel pr-sg-floor" id="floor" aria-labelledby="floor-h">
      <div className="pr-sg-head"><h2 id="floor-h">If markets fell to your limits</h2><span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span><span className="pr-sg-asof">As of {fmt.time(o.asOf, true)} IST{now - o.asOf > 120_000 ? `, ${fmt.age(now - o.asOf)}` : ''}</span></div>
      <Terms label="Your floor, as a subtraction" terms={[
        { k: <>Left if markets fell to your limits <Basis kind="limit" /></>, v: fmt.money(w.gHat, true), s: 'If every holding fell by its limit at once and everything due in the next 30 days were paid' },
        { op: '−', k: 'Your floor', v: fmt.money(w.line, true), s: 'You set it. QED refuses its own purchases that would take you below it' },
        { op: '=', hero: true, k: above ? 'Above your floor' : 'Below your floor', v: <Paise paise={Math.abs(w.cushion)} />, tone: above ? undefined : 'short', s: above ? 'Room QED\'s own purchases may use up, and no more' : 'QED buys nothing for you until this is made up' },
      ]} />
      <FloorRule worst={w.gHat} fall={fall} floor={w.line} />
      <p className="pr-sg-legend">Solid is what you would still have; hatched is what your holdings would lose if each fell by its limit at once{fall > 0 ? ` (${fmt.money(fall, true)})` : ''}. The upright mark is your floor, and QED's bracket the room {above ? 'above' : 'below'} it.</p>
      {!w.valid ? <Note tone="void" title="This figure cannot be relied on right now">{w.invalidReasons.join('. ')}. While that lasts QED refuses purchases that depend on it.</Note> : null}
      {w.illustrative ? <p className="small wait">Some limits below are illustrative. They have not been calibrated against price history, so a real fall could be larger than this page allows for.</p> : null}
      <div className="pr-sg-parts">
        <h3>What it counts</h3>
        <dl className="pr-sg-lines">
          {w.parts.map((p, i) => <div key={i}><dt>{p.label}<small>{p.note}</small></dt><dd className={p.amount < 0 ? 'neg' : ''}>{p.amount < 0 ? minus(p.amount) : fmt.money(p.amount, true)}</dd></div>)}
          <div className="total"><dt>If markets fell to your limits</dt><dd>{fmt.money(w.gHat, true)}</dd></div>
          <div><dt>Your floor</dt><dd>{fmt.money(w.line, true)}</dd></div>
          <div className={`total ${above ? '' : 'short'}`}><dt>{above ? 'Above the floor by' : 'Below the floor by'}</dt><dd>{fmt.money(Math.abs(w.cushion), true)}</dd></div>
        </dl>
        <p className="small muted">Loans are not subtracted: only the instalments due in the next 30 days are. This is a test of what you could lay hands on, not your net worth ({fmt.money(o.netWorth)}).</p>
      </div>
      <p className="pr-sg-said"><b>How it holds:</b> QED's server refuses its own purchases that would take you below it. You can still go below it by hand.</p>
      <WaitingLine keys={['line']} />
      <div className="pr-sg-act">{editing ? <><FloorForm line={w.line} worst={w.gHat} onSaved={() => { setEditing(false); onSaved() }} /><p><Btn small tone="quiet" onClick={() => setEditing(false)}>Close</Btn></p></> : <Btn onClick={() => setEditing(true)}>Change your floor</Btn>}</div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ payments to new payees

/** The waits a household may choose, in hours: the server's list (server/new-payee.ts HOLD_HOURS; spend.test.ts holds them equal). */
export const HOLD_CHOICES: readonly number[] = [1, 4, 12, 24, 48, 72]
/** No wait at all (server/new-payee.ts HOLD_OFF). */
export const HOLD_OFF = 0
const hoursWord = (h: number): string => (h === HOLD_OFF ? 'no wait' : `${h} hour${h === 1 ? '' : 's'}`)
/** The protection delay when the server has not said (server/passkeys.ts PROTECTION_DELAY_MS). */
const DELAY_MS = 72 * 3600_000
/** Only what the person changed: a key sent unchanged would replace what a change waiting would set for it (server/loosening.ts). */
const changedOnly = <T extends Record<string, unknown>>(next: T, was: Record<string, unknown>): Partial<T> => Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== was[k])) as Partial<T>

/**
 * A change that loosens a protection, waiting out the protection delay (server/loosening.ts): each thing it sets, when,
 * and its cancel, which any of the person's passkeys can make. Shown once, at the top of Safeguards; each part of the
 * page it touches says so in a line that points here.
 */
function WaitingChange() {
  const { session, reload } = useSession()
  const c = session.profileChange
  const cancel = useAction(async () => {
    if (!c) return
    if (!session.stepUpFresh) await confirmWithPasskey()
    await api('POST', `/api/security/changes/${c.id}/cancel`)
    await reload()
  })
  if (!c) return null
  return (
    <section className="pr-sg-waiting" id="waiting" aria-labelledby="waiting-h">
      <Note tone="wait">
        <h2 id="waiting-h" className="pr-sg-waiting-h">Waiting until {fmt.full(c.effectiveAt)}: a change that loosens your protections</h2>
        <ul className="pr-sg-waiting-list">{profileChangeLines(c).map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="small">You asked for it {fmt.dayTime(c.requestedAt)}. Until the time above, what is in force now still applies, and any of your passkeys can cancel it; after that it applies by itself. It was announced in your notices, and in your recovery contacts' notices if you have any.</p>
        <div><Btn small tone="void" busy={cancel.busy} onClick={() => void cancel.run()}>{session.stepUpFresh ? 'Cancel this change' : 'Confirm with your passkey and cancel this change'}</Btn></div>
        <Problem error={cancel.error} />
      </Note>
    </section>
  )
}
/** The part of the waiting change one part of the page is about, in one line pointing to the whole change. */
function WaitingLine({ keys }: { keys: readonly string[] }) {
  const { session } = useSession()
  const c = session.profileChange
  const lines = c ? profileChangeLines(c, keys) : []
  if (!c || !lines.length) return null
  return <p className="small wait pr-sg-waiting-line">Waiting until {fmt.full(c.effectiveAt)}, unless cancelled. {lines.join('. ')}. <a href="#waiting">See the change</a></p>
}

/**
 * A payee's first day (server/new-payee.ts): above what amount a payment waits, and for how long. Your passkey confirms any
 * change, either way; a session opened with a password cannot make one (the server refuses it).
 */
function NewPayeeForm({ profile, onSaved }: { profile: Home['profile']; onSaved: () => void }) {
  const { session, reload } = useSession()
  const [above, setAbove] = useState<number | null>(profile.newPayeeHoldAbove)
  const [hours, setHours] = useState(String(profile.newPayeeHoldHours))
  const changed = above !== profile.newPayeeHoldAbove || Number(hours) !== profile.newPayeeHoldHours
  const strict = (h: number): number => (h === HOLD_OFF ? -1 : h)
  const looser = (above ?? 0) > profile.newPayeeHoldAbove || strict(Number(hours)) < strict(profile.newPayeeHoldHours)
  const save = useAction(async () => {
    if (above === null) return
    if (!session.stepUpFresh) await confirmWithPasskey()
    await api('PATCH', '/api/profile', changedOnly({ newPayeeHoldAbove: above, newPayeeHoldHours: Number(hours) }, profile))
    await reload(); onSaved()
  })
  return (
    <form className="stack pr-sg-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
      <div className="form-grid">
        <Field label="Payments wait above" hint={`What you send a new payee in its first 24 hours, counted together. ${fmt.money(0)} makes every payment to it wait.`} error={save.error?.fields.newPayeeHoldAbove}>{(p) => <MoneyInput {...p} value={above} onChange={setAbove} />}</Field>
        <Field label="For how long" hint="From when you ask for the payment. 24 hours is suggested." error={save.error?.fields.newPayeeHoldHours}>{(p) => <select {...p} className="input" value={hours} onChange={(e) => setHours(e.target.value)}>{HOLD_CHOICES.map((h) => <option key={h} value={h}>{hoursWord(h)}</option>)}<option value={HOLD_OFF}>No wait (off)</option></select>}</Field>
      </div>
      {looser ? <p className="small wait">A higher amount, a shorter wait or no wait lets more money reach a new payee sooner, so it takes effect only after {protectionDelayWords(session.delays?.protectionMs ?? DELAY_MS)}; until then any of your passkeys can cancel it, and you, and any recovery contacts you have, are told in QED. If someone is telling you to change this so that a payment goes faster, stop: that is how this kind of fraud works.</p> : null}
      <p className="small muted">Your passkey confirms any change to this, either way. A lower amount or a longer wait takes effect at once. A session opened with a password cannot change it.</p>
      {save.error && Object.keys(save.error.fields).length === 0 ? <Problem error={save.error} /> : null}
      <div><Btn type="submit" busy={save.busy} disabled={!changed || above === null}>{session.stepUpFresh ? 'Save' : 'Confirm with your passkey and save'}</Btn></div>
    </form>
  )
}

// ------------------------------------------------------------------------------------------------ the bank reserve

const hardship = (a: { lateDays: number; lostSalaries: number }): string =>
  [a.lateDays > 0 ? `income up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : '', a.lostSalaries > 0 ? `${a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} not arriving` : ''].filter(Boolean).join(' and ')

/**
 * A salary that is past the last day the owner allowed for. Said plainly, because the figure above has changed on
 * account of it: the salary is now counted as one that never arrives. When more have gone missing than the owner
 * allowed to be lost, what has happened is worse than the assumption, and that is said in red.
 */
export function LateSalary({ a, elsewhere }: { a: Liquidity['assumptions']; /** Shown away from the form that changes the assumption. */ elsewhere?: boolean }) {
  const late = a.late!
  const days = `${a.lateDays} day${a.lateDays === 1 ? '' : 's'}`
  // The allowance for lost salaries is counted over the life of the household (it does not renew each month); once it is
  // used, what must stay counts on every later salary arriving, and the owner is told so (Q-045, decision of 22 Nov).
  if (late.beyondAllowance === 0 && a.allowanceLeft === 0 && a.lostSoFar > 0) return <Note tone="wait" title="Your allowance for lost salaries is used up">The salary due {fmt.isoDay(late.due)} did not arrive, and you allowed for {a.lostSalaries === 1 ? 'one salary' : `${a.lostSalaries} salaries`} to be lost. What must stay now counts on every later salary arriving. If another could be lost, allow for more {elsewhere ? <Link to="/safeguards">in Safeguards</Link> : 'below'}: what must stay rises at once when you do, not on a later date.</Note>
  return late.beyondAllowance > 0
    ? <Note tone="void" title={`The salary due ${fmt.isoDay(late.due)} has not arrived, and that is worse than you allowed for`}>It is more than {days} late, and you allowed for {a.lostSalaries === 0 ? 'no salary' : a.lostSalaries === 1 ? 'only one salary' : `only ${a.lostSalaries} salaries`} to be lost. What must stay now counts on no income until the next salary due. If this is how your income behaves, change what you allow for {elsewhere ? <Link to="/safeguards">in Safeguards</Link> : 'below'}.</Note>
    : <Note tone="wait" title={`The salary due ${fmt.isoDay(late.due)} has not arrived`}>It is more than {days} late, so it is now counted as {a.lostSalaries === 1 ? 'the salary' : 'one of the salaries'} you allowed to be lost. What must stay counts on the next one due.</Note>
}

function ReserveForm({ profile, lostSoFar, onSaved }: { profile: Home['profile']; lostSoFar: number; onSaved: () => void }) {
  const { session, reload } = useSession()
  const [late, setLate] = useState(String(profile.lateDays)), [lost, setLost] = useState(String(profile.lostSalaries))
  const weaker = Number(late) < profile.lateDays || Number(lost) < profile.lostSalaries
  const changed = Number(late) !== profile.lateDays || Number(lost) !== profile.lostSalaries
  const needPasskey = weaker && !session.stepUpFresh
  const save = useAction(async () => {
    if (needPasskey) await confirmWithPasskey()
    await api('PATCH', '/api/profile', changedOnly({ lateDays: Number(late), lostSalaries: Number(lost) }, profile))
    await reload(); onSaved()
  })
  return (
    <form className="stack sg-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
      <div className="form-grid">
        <Field label="Allow for income arriving late by" error={save.error?.fields.lateDays}>{(p) => <select {...p} className="input" value={late} onChange={(e) => setLate(e.target.value)}>{Array.from({ length: 16 }, (_, d) => <option key={d} value={d}>{d === 0 ? 'Not at all: it comes on its day' : `${d} day${d === 1 ? '' : 's'}`}</option>)}</select>}</Field>
        <Field label="Allow for salaries that never arrive" hint={`The next ones due are assumed to be the ones lost, which is the hardest case. Counted since you opened QED: ${lostSoFar} lost so far.`} error={save.error?.fields.lostSalaries}>{(p) => <select {...p} className="input" value={lost} onChange={(e) => setLost(e.target.value)}>{['None', 'One', 'Two', 'Three'].map((t, n) => <option key={n} value={n}>{t}</option>)}</select>}</Field>
      </div>
      {weaker ? <p className="small muted">Allowing for less frees money for QED's instructions to use and weakens your protection, so your passkey confirms it and it takes effect only after {protectionDelayWords(session.delays?.protectionMs ?? DELAY_MS)}; until then any of your passkeys can cancel it, and you, and any recovery contacts you have, are told in QED. Allowing for more takes effect at once.</p> : null}
      {save.error && Object.keys(save.error.fields).length === 0 ? <Problem error={save.error} /> : null}
      <div><Btn type="submit" busy={save.busy} disabled={!changed}>{needPasskey ? 'Confirm with your passkey and save' : 'Save what it allows for'}</Btn></div>
    </form>
  )
}

export type ReserveData = { liquidity: Liquidity; envelope: AuthorityEnvelope }

/**
 * In your bank, less what must stay, is what is free (or what is short): three figures that add up, then the bank at
 * true scale on the money bar (kit.tsx, DESIGN.md M14) with the span of the most QED's instructions may move in 30
 * days under the free part it may come from.
 */
export function ReserveFigures({ l, held, may, asOf }: { l: Liquidity; held: number; may: number; asOf: number }) {
  const short = l.short > 0
  const free = short ? 0 : l.free
  const kept = Math.min(l.available, l.need)
  const label = short
    ? `${fmt.money(l.available, true)} in your bank, and ${fmt.money(l.need, true)} must stay: ${fmt.money(l.short, true)} short. QED's instructions may move nothing from the bank until that is covered.`
    : `${fmt.money(free, true)} free and ${fmt.money(kept, true)} kept make the ${fmt.money(l.available, true)} in your bank.${may > 0 ? ` QED may move at most ${fmt.money(may)} in 30 days, from the free part only.` : ''}`
  return (
    <div className="rv-figs">
      <Terms label="What is free, as a subtraction" terms={[
        { k: 'In your bank', v: fmt.money(l.available, true), s: held > 0 ? `Not counting ${fmt.money(held, true)} held for orders in flight and payments on hold` : `Paper money for practice, as of ${fmt.time(asOf)}` },
        { op: '−', k: <><Swatch tone="kept" />Must stay in the bank</>, v: <span data-reserve="need">{fmt.money(l.need, true)}</span>, s: l.binding ? `For what falls due to ${fmt.isoDay(l.binding.date)}, at worst` : 'Nothing due needs money that is not certain to arrive first' },
        { op: '=', hero: true, k: <><Swatch tone={short ? 'short' : 'free'} />{short ? 'Short' : 'Free to use'}</>, v: short ? fmt.money(l.short, true) : <Paise paise={free} />, tone: short ? 'short' : undefined, s: short ? 'If the worst you allow for happens, something due could not be paid. Nothing has failed yet' : 'No day needs it, even at worst' },
      ]} />
      <MoneyBar className="rv-bar" label={label} parts={[{ tone: 'free', value: free, reach: may > 0 ? may : 0 }, { tone: 'kept', value: kept }, { tone: 'short', value: l.short }]} />
      <p className="rv-sum" aria-hidden="true">{short
        ? <><b>{fmt.money(l.available, true)}</b> in your bank − <b>{fmt.money(l.need, true)}</b> must stay leaves you <b className="short">{fmt.money(l.short, true)}</b> short.</>
        : <><b>{fmt.money(l.available, true)}</b> in your bank − <b>{fmt.money(l.need, true)}</b> must stay = <b>{fmt.money(free, true)}</b> free.{may > 0 ? <> The line under the bar is the most QED may move in 30 days, <b>{fmt.money(may)}</b>, all instructions together, always from the free part.</> : ' No instruction in force can take money from the bank.'}</>}</p>
    </div>
  )
}

/** The note when the bank holds less than must stay. */
export function ReserveShort({ l }: { l: Liquidity }) {
  const b = l.binding
  if (l.short <= 0) return null
  // to the paisa, as the figures above it are written (D-097: one sum, one way)
  return <Note tone="void" title={`${fmt.money(l.short, true)} short`}>{fmt.money(l.need, true)} needs to be in your bank account today for everything already due to be paid on its day, and {fmt.money(l.available, true)} is there. Nothing has failed. If the worst you allow for happens, something due {b ? `on or before ${fmt.isoDay(b.date)} ` : ''}could not be paid. QED's instructions will buy nothing until this is covered, and will pay a bill ahead of its day only if everything due before it stays covered. Bills are still paid on the day they fall due.</Note>
}

const KINDS = [['emi', 'Loan instalments'], ['bill', 'Registered bills']] as const
/** "24 Nov", kept on one line. */
const shortDay = (iso: string): string => { const [, m, d] = iso.split('-').map(Number); return `${d}\u00a0${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m! - 1]}` }

/** Each obligation to the hardest day, with its day and amount: the lines the figure's parts are made of. */
function EachDue({ l }: { l: Liquidity }) {
  const b = l.binding
  if (!b || b.items.length === 0) return null
  return (
    <details className="rv-each">
      <summary>Each bill and instalment, with its day ({b.items.length})</summary>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Each bill and instalment to the hardest day">
        <table className="ledger rv-each-table">
          <caption className="sr">Every bill and instalment due to {fmt.isoDay(b.date)}, each with its day</caption>
          <thead><tr><th scope="col">Due</th><th scope="col">What</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>{b.items.map((d, i) => <tr key={i}><td className="date">{d.step === 0 ? 'Today' : fmt.isoDay(d.date)}</td><td>{d.label}</td><td className="num">{fmt.money(d.amount, true)}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  )
}

/** What the figure is as good as, in words: which salary is counted on first, and what lies outside the list. */
function whyWords(l: Liquidity): ReactNode {
  const b = l.binding
  return <>
    {l.assumptions.income > 0 ? <p className="small muted rv-explain">{l.assumptions.firstCounted ? <>The first salary counted on is the one due {fmt.isoDay(l.assumptions.firstCounted.due)}{l.assumptions.firstCounted.by !== l.assumptions.firstCounted.due ? `, by ${fmt.isoDay(l.assumptions.firstCounted.by)}` : ''}.{l.assumptions.lostSalaries > 0 ? ` ${l.assumptions.lostSalaries === 1 ? 'The one before it is the one' : 'The ones before it are those'} allowed for as lost.` : ''}</> : `No salary is counted on in the next ${l.horizonDays} days.`} The figure is the least that covers everything listed here, each at its worst, through {b ? fmt.isoDay(b.date) : 'the days looked at'}. It is as good as the list: a bill that is not registered here, or spending above your figure, is outside it.</p> : null}
    {!l.sustainable ? <Note tone="wait" title="More may be needed than this">The hardest day found is at the end of the {l.horizonDays} days QED looks ahead, so the figure is still rising where the look-ahead stops. The usual reason is that your recorded outgoings are larger than your income.</Note> : null}
  </>
}

/**
 * Why the figure: what falls due through the hardest day, by kind and by when, less income certain to have arrived
 * first, adding up to what must stay; each obligation one press away.
 */
export function ReserveWhy({ l, brief = false }: { l: Liquidity; /** On Safeguards: the lines one press away, with a link to Save. */ brief?: boolean }) {
  const b = l.binding
  const living = b?.parts.find((p) => p.kind === 'living')
  const allowing = hardship(l.assumptions)
  const lines = b ? (
    <dl className="lines rv-lines">
      {KINDS.map(([kind, label]) => {
        const items = b.items.filter((i) => i.kind === kind)
        if (items.length === 0) return null
        return <div key={kind}><dt>{label}<small>{items.map((i) => `${i.label.replace(/ instalment$/, '')} ${i.step === 0 ? 'today' : shortDay(i.date)}`).join(', ')}</small></dt><dd>{fmt.money(items.reduce((s, i) => s + i.amount, 0), true)}</dd></div>
      })}
      {living ? <div><dt>Everyday spending to {fmt.isoDay(b.date)}<small>Your figure of {fmt.money(l.assumptions.spending)} a month, spread over the days of each month</small></dt><dd>{fmt.money(living.amount, true)}</dd></div> : null}
      {b.inflows > 0 ? <div><dt>Income certain to have arrived before then</dt><dd>{minus(b.inflows)}</dd></div> : null}
      <div className="total"><dt>Must be in the bank today</dt><dd data-reserve="need">{fmt.money(l.need, true)}</dd></div>
    </dl>
  ) : null
  return (
    <section className="rv-why" aria-labelledby="why-h">
      <div className="rv-sub-head"><h3 id="why-h">What the figure pays for</h3><p>{b ? `Everything due to ${fmt.isoDay(b.date)}, the hardest day${allowing ? `, with ${allowing}` : ''}` : `The next ${l.horizonDays} days`}</p></div>
      {!b ? <p className="small muted">Nothing due in the next {l.horizonDays} days needs money that is not certain to arrive first.</p>
        : brief ? <details className="rv-each"><summary>The {b.items.length + (living ? 1 : 0) + (b.inflows > 0 ? 1 : 0)} lines that add up to {fmt.money(l.need, true)}, everything due to {fmt.isoDay(b.date)}</summary>{lines}</details>
        : <>{lines}<EachDue l={l} /></>}
      {whyWords(l)}
    </section>
  )
}

/** What the figure allows for, how to change it, and what it does not count. */
export function ReserveAllows({ l, profile, onSaved, here = false, notCounted = true }: { l: Liquidity; profile: Home['profile']; onSaved: () => void; /** Shown on Safeguards, where the household figures are further down the same page. */ here?: boolean
  /** Save draws what the figure does not count beside what it pays for (NotCounted below), so it is not repeated here. */ notCounted?: boolean }) {
  const [editing, setEditing] = useState(false)
  const a = l.assumptions
  return (
    <section className="rv-allow" aria-labelledby="allow-h">
      {/* R14: the heading with its line on the left and the change on the right of the same row, so the button never
          stands alone on a row with nothing beside it */}
      <div className="rv-sub-head rv-allow-head"><div><h3 id="allow-h">What it allows for</h3><p>The worst you told QED to expect</p></div>
        {editing ? null : <Btn small onClick={() => setEditing(true)}>Change what it allows for</Btn>}</div>
      <ul className="rv-allows">
        <li><b>{a.lateDays > 0 ? `Income up to ${a.lateDays} day${a.lateDays === 1 ? '' : 's'} late` : 'Income on its day'}</b><span>{a.lateDays > 0 ? 'A salary is counted on only once the latest day it may arrive has passed.' : 'A salary is counted on from the day it is due.'}</span></li>
        <li><b>{a.lostSalaries === 0 ? 'No salary lost' : `${a.lostSalaries === 1 ? 'One salary' : `${a.lostSalaries} salaries`} not arriving`}</b><span>{a.lostSalaries === 0 ? 'Every salary due is counted on.' : a.allowanceLeft > 0 ? `The next ${a.allowanceLeft === 1 ? 'salary due is' : `${a.allowanceLeft} salaries due are`} treated as lost, the hardest case. Lost so far: ${a.lostSoFar}.` : `${a.lostSalaries === 1 ? 'The one' : `All ${a.lostSalaries}`} allowed for ${a.lostSalaries === 1 ? 'has' : 'have'} been lost already, so every salary due is counted on now.`}</span></li>
        <li><b>Everyday spending of {fmt.money(a.spending)} a month</b><span>Your own figure, spread over the days of each month. {here ? <a href="#household">Change it</a> : <Link to="/safeguards#household">Change it</Link>}</span></li>
      </ul>
      {a.late ? <LateSalary a={a} /> : null}
      {here ? <WaitingLine keys={['lateDays', 'lostSalaries']} /> : null}
      {editing ? <div className="rv-change"><ReserveForm profile={profile} lostSoFar={a.lostSoFar} onSaved={() => { setEditing(false); onSaved() }} /><p><Btn small tone="quiet" onClick={() => setEditing(false)}>Close</Btn></p></div> : null}
      {notCounted ? <NotCounted l={l} /> : null}
    </section>
  )
}
/** What the reserve figure does not count, behind its disclosure: under what it allows for on Safeguards, beside what it pays for on Save. */
export function NotCounted({ l }: { l: Liquidity }) {
  return <details className="rv-not"><summary>What it does not count</summary><ul className="small muted">{l.notCounted.map((t) => <li key={t}>{t}</li>)}</ul></details>
}

/** The most the signed instructions could take, by their limits, over three windows: the bracket's figure, line by line. */
export function Envelope({ env }: { env: AuthorityEnvelope }) {
  return (
    <section className="panel env" aria-labelledby="take-h">
      <div className="panel-head"><h2 id="take-h">The most your instructions could take</h2><p>By the limits you signed</p></div>
      {env.instructions.length === 0 ? <div className="empty-state slim"><span className="glyph"><ListChecks aria-hidden="true" /></span><p>No instruction in force can take money from your bank account.</p></div> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="The most your instructions could take; scroll sideways on a narrow screen">
          <table className="ledger env-table">
            <colgroup><col /><col className="c-fig" /><col className="c-fig" /><col className="c-fig" /></colgroup>
            <thead><tr><th scope="col">Instruction</th>{env.windows.map((w) => <th key={w.days} scope="col" className="num">{w.days === 1 ? 'Today' : `In ${w.days} days`}</th>)}</tr></thead>
            <tbody>
              {env.instructions.map((i) => <tr key={i.id}><th scope="row"><Link to={`/instructions/${i.id}`}>{i.title}</Link></th>{i.most.map((m, k) => <td key={k} className="num">{fmt.money(m)}</td>)}</tr>)}
              {env.instructions.length > 1 ? <tr className="total"><th scope="row">All of them together</th>{env.windows.map((w) => <td key={w.days} className="num">{fmt.money(w.most)}</td>)}</tr> : null}
            </tbody>
          </table>
        </div>
      )}
      {env.instructions.length ? (
        <ul className="env-list">
          {env.instructions.map((i) => <li key={i.id}><Link to={`/instructions/${i.id}`}>{i.title}</Link><dl>{env.windows.map((w, k) => <div key={w.days}><dt>{w.days === 1 ? 'Today' : `In ${w.days} days`}</dt><dd>{fmt.money(i.most[k] ?? 0)}</dd></div>)}</dl></li>)}
          {env.instructions.length > 1 ? <li className="total"><b>All of them together</b><dl>{env.windows.map((w) => <div key={w.days}><dt>{w.days === 1 ? 'Today' : `In ${w.days} days`}</dt><dd>{fmt.money(w.most)}</dd></div>)}</dl></li> : null}
        </ul>
      ) : null}
      <p className="small muted env-note">These are the most each signed instruction's limits allow, not what it usually does. A monthly limit counts calendar months, so 30 days that run across a month's end can allow two months' limits. None of it can come out of what must stay in the bank: QED refuses a run that would.</p>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the household, the records, the sessions

function HouseholdForm({ profile, onSaved }: { profile: Home['profile']; onSaved: () => void }) {
  const { session, reload } = useSession()
  const [m, setM] = useState<Record<string, number | null>>({ income: profile.income, spending: profile.spending, personalLoanEmi: profile.personalLoanEmi, homeLoanEmi: profile.homeLoanEmi })
  const [incomeDay, setIncomeDay] = useState(String(profile.incomeDay)), [emiDay, setEmiDay] = useState(String(profile.emiDay))
  const [saved, setSaved] = useState(false)
  // A change here that lowers what must stay in the bank needs the passkey, and waits out the protection delay; the server
  // says when, and why (server/loosening.ts).
  const [waits, setWaits] = useState(false)
  const save = useStepUpWhenAsked(async () => {
    const r = await api<{ deferred: boolean }>('PATCH', '/api/profile', changedOnly({ income: m.income ?? 0, spending: m.spending ?? 0, personalLoanEmi: m.personalLoanEmi ?? 0, homeLoanEmi: m.homeLoanEmi ?? 0, incomeDay: Number(incomeDay), emiDay: Number(emiDay) }, profile))
    setWaits(r.deferred); setSaved(true); await reload(); onSaved()
  })
  const f = save.error?.fields ?? {}
  const money = (k: string, label: string, hint?: string) => <Field label={label} hint={hint} error={f[k]}>{(p) => <MoneyInput {...p} value={m[k] ?? null} onChange={(x) => { setSaved(false); setM((s) => ({ ...s, [k]: x })) }} />}</Field>
  const day = (v: string, set: (s: string) => void, label: string, k: string) => <Field label={label} hint="1 to 28." error={f[k]}>{(p) => <input {...p} className="input" inputMode="numeric" value={v} onChange={(e) => { setSaved(false); set(e.target.value) }} />}</Field>
  return (
    <form className="stack pr-sg-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
      <div className="form-grid">
        {money('income', 'Salary, each month')}
        {day(incomeDay, setIncomeDay, 'Salary arrives on day', 'incomeDay')}
      </div>
      {money('spending', 'Everyday spending, each month', 'The no-regret check and the bank reserve both count this figure.')}
      <div className="form-grid">
        {money('personalLoanEmi', 'Personal loan instalment')}
        {money('homeLoanEmi', 'Home loan instalment')}
      </div>
      {day(emiDay, setEmiDay, 'Instalments leave on day', 'emiDay')}
      {save.field}
      {save.error && Object.keys(f).length === 0 ? <Problem error={save.error} /> : null}
      {saved ? waits
        ? <p className="small wait">These figures lower what must stay in your bank, so they take effect only after {protectionDelayWords(session.delays?.protectionMs ?? DELAY_MS)}: see the change waiting at the top of this page.</p>
        : <p className="small ok">Saved. Checks made from now on use these figures; instructions already signed keep the figures they were signed with.</p> : null}
      <p className="small muted">Figures that lower what must stay in your bank free money for QED's instructions, so your passkey confirms them and they take effect only after {protectionDelayWords(session.delays?.protectionMs ?? DELAY_MS)}. Others take effect at once.</p>
      <div><Btn type="submit" busy={save.busy}>Save these figures</Btn></div>
    </form>
  )
}

/** Recompute the whole receipt chain in the browser from the first receipt. Nothing here asks the server whether it is intact. */
function ChainCheck({ userId }: { userId: string }) {
  const [result, setResult] = useState<{ ok: boolean; count: number; at?: number; head?: string; when: number } | null>(null)
  const run = useAction(async () => {
    const all: Receipt[] = []
    let before: number | undefined
    for (;;) {
      const r = await api<{ receipts: Receipt[] }>('GET', `/api/receipts?limit=500${before ? `&before=${before}` : ''}`)
      all.push(...r.receipts)
      if (r.receipts.length < 500) break
      before = r.receipts[r.receipts.length - 1]!.seq
    }
    all.sort((a, b) => a.seq - b.seq)
    let prev = sha256(`qed-receipts-v1:${userId}`)
    let expect = 1
    for (const r of all) {
      if (r.seq !== expect || r.prev_hash !== prev || sha256(`${prev}\n${canonical(r.body)}`) !== r.hash) { setResult({ ok: false, count: all.length, at: r.seq, when: Date.now() }); return }
      prev = r.hash; expect++
    }
    setResult({ ok: true, count: all.length, head: prev, when: Date.now() })
  })
  return (
    <div className="stack pr-sg-chain">
      <div><Btn busy={run.busy} onClick={() => void run.run()}>Check every receipt in this browser</Btn></div>
      {result ? (result.ok
        ? <Note tone="ok">All {result.count} receipts were fetched and their fingerprints recomputed here, each from the one before it, starting from the first. They are in order and unchanged. The latest fingerprint is <span className="code">{fmt.hash(result.head)}</span>. Checked {fmt.time(result.when, true)}.</Note>
        : <Note tone="void" title="The chain does not hold">Receipt no. {result.at} does not follow from the one before it. A receipt at or before that point was changed, removed or inserted after it was issued. Do not rely on receipts from no. {result.at} onward.</Note>) : null}
      <Problem error={run.error} />
    </div>
  )
}

function Sessions() {
  const { session, reload } = useSession()
  const [asking, setAsking] = useState(false)
  const out = useAction(async () => { if (!session.stepUpFresh) await confirmWithPasskey(); beginSignOut(); try { await api('POST', '/api/auth/logout-everywhere') } catch (e) { endSignOut(); throw e } await reload(); navigate('/', true) })
  const list = session.sessions ?? []
  return (
    <>
      <ul className="pr-sg-list">
        {list.map((s, i) => <li key={i}><div><b>{sessionDevice(s.ua)}</b>{s.current ? <span className="small by-you"> this one</span> : null}<span className="sub">Signed in {fmt.dayTime(s.created_at)}; last used {fmt.dayTime(s.last_seen_at)}</span></div></li>)}
      </ul>
      {asking ? (
        <form className="stack pr-sg-form" onSubmit={(e) => { e.preventDefault(); void out.run() }}>
          <p className="small">Every session of this account ends, this one too{session.stepUpFresh ? '' : '; your passkey confirms it'}. You then sign in again with a passkey.</p>
          {out.error ? <Problem error={out.error} /> : null}
          <div className="row"><Btn tone="void" type="submit" busy={out.busy}>End every session, this one too</Btn><Btn onClick={() => setAsking(false)}>Keep them</Btn></div>
        </form>
      ) : <p className="pr-sg-act"><Btn small onClick={() => setAsking(true)}>End every session</Btn></p>}
      <p className="small muted">Signing out does not stop QED. Instructions in force keep running on the engine. To stop them, pause QED with the status button in the bar at the top of every page.</p>
    </>
  )
}

/** One safeguard as a full-width row of its band: its name and how it stands on the left, what it is on the right. */
export function BandRow({ id, title, hid, status, aside, children }: { id?: string; title: string; hid: string; status?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="sg-row" id={id} aria-labelledby={hid}>
      <div className="sg-row-head"><h3 id={hid}>{title}</h3>{status ? <div className="sg-row-status">{status}</div> : null}{aside ? <p>{aside}</p> : null}</div>
      <div className="sg-row-body">{children}</div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the page

/** One safeguard as a glass row of its band: its name, its kind, how it stands, and what it is. */
function SgRow({ id, title, hid, tags, status, aside, wide, children }: { id?: string; title: string; hid: string; tags?: ReactNode; status?: ReactNode; aside?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`pr-sg-row ${wide ? 'wide' : ''}`} id={id} aria-labelledby={hid}>
      <div className="pr-sg-row-head"><h3 id={hid}>{title}</h3>{tags}{status ? <div className="pr-sg-row-status">{status}</div> : null}</div>
      {aside ? <p className="pr-sg-aside">{aside}</p> : null}
      <div className="pr-sg-row-body">{children}</div>
    </section>
  )
}

export function SafeguardsScreen() {
  const now = useNow(1000)
  const { session } = useSession()
  const home = useData<Home>('/api/home', ['action', 'program', 'profile', 'recon', 'nav', 'stop'])
  const sys = useData<System>('/api/system', ['engine', 'recon', 'receipt', 'provider'])
  const market = useData<Market>('/api/market', ['provider', 'nav'])
  const recent = useData<{ receipts: Receipt[] }>('/api/receipts?limit=6', ['receipt'])
  const liq = useData<ReserveData>('/api/liquidity', ['action', 'program', 'profile', 'bill', 'run'])
  const [household, setHousehold] = useState(false), [newPayees, setNewPayees] = useState(false)
  const ready = !!(home.data && sys.data && liq.data)
  useHashTarget(ready, (target) => { if (target === 'household') setHousehold(true) })
  const error = home.error ?? sys.error ?? liq.error
  if (!home.data || !sys.data || !liq.data) return <div className="pr pr-sg"><SafeguardsHead />{error ? <Problem error={error} /> : <SafeguardsSkeleton />}</div>

  const o = home.data.overview, w = o.worst, s = sys.data, l = liq.data.liquidity
  const guards = home.data.programs.filter((p) => p.pillar === 'protect')
  const terms: Term[] = (market.data?.terms ?? []).filter((t) => !t.id.startsWith('limit.'))
  const tally = terms.reduce<Record<string, number>>((a, t) => { a[t.status] = (a[t.status] ?? 0) + 1; return a }, {})
  const clock = s.clock[0]
  const e = s.engine
  const live = s.providers.filter((p) => p.state === 'live').length
  const records = s.ledger.breaks.length === 0 && s.receipts.ok && (s.recon ? s.recon.ok : true)
  const may = liq.data.envelope.windows.find((x) => x.days === 30)?.most ?? 0
  const reload = () => { liq.reload(); home.reload() }

  return (
    <div className="pr pr-sg">
      <SafeguardsHead />

      <nav className="pr-sg-glance" aria-label="How each safeguard stands now">
        <a href="#floor"><span className="g-k">Your floor<KindTag kind="set" /></span>{w.valid ? <Stamp tone={w.cushion >= 0 ? 'ok' : 'void'}>{w.cushion >= 0 ? 'Above it' : 'Below it'}</Stamp> : <Stamp tone="void">Cannot be relied on</Stamp>}<span className="g-v">{w.cushion >= 0 ? `${fmt.money(w.cushion, true)} above` : `${fmt.money(-w.cushion, true)} below`}</span></a>
        <a href="#engine"><span className="g-k">The engine<KindTag kind="watched" /></span>{e.running ? <Stamp tone="ok">Running</Stamp> : <Stamp tone="void">Not running</Stamp>}<span className="g-v">{e.lastBeat ? `Heartbeat ${fmt.age(now - e.lastBeat)}` : 'No heartbeat yet'}</span></a>
        <a href="#sources"><span className="g-k">Prices<KindTag kind="watched" /></span>{live === s.providers.length ? <Stamp tone="ok">All live</Stamp> : <Stamp tone="wait">{`${s.providers.length - live} not live`}</Stamp>}<span className="g-v">{live} of {s.providers.length} sources</span></a>
        <a href="#records"><span className="g-k">Records<KindTag kind="watched" /></span>{records ? <Stamp tone="ok">Consistent</Stamp> : <Stamp tone="void">Needs attention</Stamp>}<span className="g-v">{s.receipts.count} receipt{s.receipts.count === 1 ? '' : 's'}, {s.receipts.ok ? 'chain intact' : `broken at no. ${s.receipts.brokenAt}`}</span></a>
      </nav>

      <WaitingChange />

      <Floor o={o} now={now} onSaved={() => home.reload()} />

      <section className="panel pr-sg-panel" id="reserve" aria-labelledby="reserve-h">
        <div className="pr-sg-head"><h2 id="reserve-h">What must stay in the bank</h2><span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span><span className="pr-sg-asof">Worked out for {fmt.isoDay(l.today)}</span></div>
        <ReserveFigures l={l} held={o.bankHeld} may={may} asOf={o.asOf} />
        <ReserveBasis l={l} />
        <ReserveShort l={l} />
        <ReserveWhy l={l} brief />
        <ReserveAllows l={l} profile={home.data.profile} here onSaved={reload} />
        <p className="pr-sg-said"><b>How it holds:</b> whatever your instructions' limits say, none of it can come out of what must stay; QED's server refuses a run that would.</p>
        <p className="pr-sg-more"><Link to="/save">Each day, with every bill and instalment, on Save<ChevronRight aria-hidden="true" /></Link></p>
      </section>

      <Envelope env={liq.data.envelope} />

      <section className="panel pr-sg-band" aria-labelledby="band-protect-h">
        <h2 id="band-protect-h" className="pr-sg-band-h">What protects you</h2>
        <div className="pr-sg-rows">
          <SgRow title="What acts to protect you" hid="guards-h" wide tags={<span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span>} aside="Instructions that only ever sell, carried out by QED's engine">
            {guards.length ? <ul className="pr-sg-list">{guards.map((p) => <li key={p.id}><Link to={`/instructions/${p.id}`} className="cover"><b className="t">{p.title}</b><span className={`sub ${p.watching ? 'wait' : ''}`}>{statusLine(p, now, session.stop)}</span></Link></li>)}</ul>
              : <div className="empty-state compact"><span className="glyph"><ShieldCheck aria-hidden="true" /></span><p>Nothing is watching your floor or your prices. <Link to="/instructions/new?kind=floor">Write an instruction to hold your floor</Link>, or one to <Link to="/instructions/new?kind=exit">sell if a price falls</Link>.</p></div>}
            <dl className="pr-sg-how">
              <div><dt>Pause QED<KindTag kind="set" /></dt><dd>The status button in the bar at the top of every page, on a wide screen and on a phone. It halts every instruction at once, protective selling included, unless you choose when stopping to keep protective selling running. It needs no confirmation to stop; resuming needs your passkey. {session.stop ? <strong className="wait">{pauseWords(session.stop)}</strong> : pauseWords(null)}</dd></div>
              <div><dt>Approval<KindTag kind="enforced" by="server" /></dt><dd>Every approval is your passkey signing the exact terms shown, after your device's own check, such as a fingerprint, a face or a PIN. The signature covers that one document and is spent when used.</dd></div>
              <div><dt>Two price sources<KindTag kind="enforced" by="server" /></dt><dd>A digital-asset order is refused if the venue's price and an independent price disagree by more than 3%.</dd></div>
            </dl>
          </SgRow>
          <SgRow title="The limit on each holding" hid="limits-h" wide tags={<Stamp tone="plain">An assumption</Stamp>} aside="How far QED assumes each could fall; your floor and every worst case rest on it">
            {o.holdings.length === 0 ? <div className="empty-state compact"><span className="glyph"><ShieldCheck aria-hidden="true" /></span><p>You hold nothing that can fall in value.</p></div> : (
              <div className="pr-sg-scroll pr-sg-limits-wrap" tabIndex={0} role="region" aria-label="The limit on each holding; scroll sideways on a narrow screen">
                <table className="ledger pr-sg-limits">
                  <thead><tr><th scope="col">Holding</th><th scope="col" className="num">Worth now</th><th scope="col" className="num">Assumed fall</th><th scope="col" className="num">Worth after it</th></tr></thead>
                  <tbody>{o.holdings.map((h) => <tr key={h.instrumentId}><th scope="row">{h.name}<span className={`sub ${calibrated(h.limitStatus) ? '' : 'wait'}`}>{calibrated(h.limitStatus) ? 'Calibrated limit, not a worst case' : 'Illustrative limit, not calibrated'}{h.fresh.stale ? '. Its price is stale, so the limit does not hold.' : ''}</span></th><td className="num">{h.value === null ? 'No price' : fmt.money(h.value, true)}</td><td className="num">{fmt.pct(h.limit, 0)}</td><td className="num">{h.worst === null ? 'Unknown' : fmt.money(h.worst, true)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            {o.holdings.length ? (
              <ul className="pr-sg-limit-list" aria-label="The limit on each holding">
                {o.holdings.map((h) => <li key={h.instrumentId}><b>{h.name}</b><span className={`sub ${calibrated(h.limitStatus) ? '' : 'wait'}`}>{calibrated(h.limitStatus) ? 'Calibrated limit, not a worst case' : 'Illustrative limit, not calibrated'}{h.fresh.stale ? '. Its price is stale, so the limit does not hold.' : ''}</span>
                  <dl><div><dt>Worth now</dt><dd>{h.value === null ? 'No price' : fmt.money(h.value, true)}</dd></div><div><dt>Assumed fall</dt><dd>{fmt.pct(h.limit, 0)}</dd></div><div><dt>Worth after it</dt><dd>{h.worst === null ? 'Unknown' : fmt.money(h.worst, true)}</dd></div></dl></li>)}
              </ul>
            ) : null}
          </SgRow>
          <SgRow id="new-payees" title="Payments to new payees" hid="new-payees-h" wide tags={<span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by="server" /></span>} aside="Before a payee is saved, and in its first day">
            <dl className="pr-sg-how">
              <div><dt>The name check, on paper<KindTag kind="enforced" by="server" /></dt><dd>Before a payee is saved, the paper bank compares the name you give with the name it holds for the address: a match, a close match (with its name, which you can take instead), no match, or could not check. Anything but a match is added only once you say you checked the address with the payee yourself, and every payment's terms say what it answered. It is the paper bank's own directory on this computer: no real bank or NPCI is asked, and a match cannot tell who controls the account or whether someone is pressing you to pay.</dd></div>
              <div><dt>The first day<KindTag kind="set" /></dt><dd>{home.data.profile.newPayeeHoldHours === HOLD_OFF
                ? <>Off: a payment to a new payee does not wait, whatever its size. Its first payment's terms still carry the caution to check the address with them yourself.</>
                : <>In a payee's first 24 hours, a payment that takes what you send it above <strong>{fmt.money(home.data.profile.newPayeeHoldAbove)}</strong> waits <strong>{hoursWord(home.data.profile.newPayeeHoldHours)}</strong> before it is sent. Its money is set aside meanwhile, you can cancel it on its record, and while QED is paused it keeps waiting. The time it is sent is in the terms your passkey signs, and nothing sends it sooner.</>}</dd></div>
            </dl>
            <WaitingLine keys={['newPayeeHoldAbove', 'newPayeeHoldHours']} />
            {session.delays?.newPayeeHoldTestMs ? <p className="small wait">Test mode: on this installation every such wait lasts {Math.round(session.delays.newPayeeHoldTestMs / 1000)} seconds, whatever is set here.</p> : null}
            {newPayees ? <div className="pr-sg-act"><NewPayeeForm profile={home.data.profile} onSaved={() => { setNewPayees(false); home.reload() }} /><p><Btn small tone="quiet" onClick={() => setNewPayees(false)}>Close</Btn></p></div>
              : <p className="pr-sg-act"><Btn small onClick={() => setNewPayees(true)}>Change the amount or the wait</Btn></p>}
          </SgRow>
          <SgRow id="household" title="Your household figures" hid="household-h" wide tags={<KindTag kind="set" />} aside="What the checks count on">
            <dl className="kv small">
              <dt>Salary</dt><dd>{fmt.money(home.data.profile.income)} a month, on day {home.data.profile.incomeDay}</dd>
              <dt>Everyday spending</dt><dd>{fmt.money(home.data.profile.spending)} a month</dd>
              <dt>Instalments</dt><dd>{fmt.money(home.data.profile.personalLoanEmi + home.data.profile.homeLoanEmi)} a month, on day {home.data.profile.emiDay}</dd>
            </dl>
            <WaitingLine keys={['income', 'incomeDay', 'spending', 'personalLoanEmi', 'homeLoanEmi', 'emiDay']} />
            {household ? <div className="pr-sg-act"><HouseholdForm profile={home.data.profile} onSaved={() => home.reload()} /><p><Btn small tone="quiet" onClick={() => setHousehold(false)}>Close</Btn></p></div>
              : <p className="pr-sg-act"><Btn small onClick={() => setHousehold(true)}>Change these figures</Btn></p>}
          </SgRow>
        </div>
      </section>

      <section className="panel pr-sg-band" aria-labelledby="band-depends-h">
        <h2 id="band-depends-h" className="pr-sg-band-h">What QED depends on, now</h2>
        <div className="pr-sg-rows">
          <SgRow id="engine" title="The engine" hid="engine-h" tags={<KindTag kind="watched" />} status={e.running ? <Stamp tone="ok">Running</Stamp> : <Stamp tone="void">Not running</Stamp>} aside="QED acts only while it runs">
            <dl className="kv small">
              {e.startedAt ? <><dt>Started</dt><dd>{fmt.dayTime(e.startedAt)} ({fmt.rel(e.startedAt, now)})</dd></> : null}
              <dt>Last heartbeat</dt><dd className="tabular">{e.lastBeat ? fmt.age(now - e.lastBeat) : 'never'}</dd>
              {e.ticks !== null ? <><dt>Work done</dt><dd className="tabular">{e.ticks.toLocaleString('en-IN')} cycles; the last took {e.lastTickMs ?? 0} ms</dd></> : null}
            </dl>
            <p className="small muted">QED acts only while the engine runs. It is its own process on this computer: closing this page or signing out does not stop it; shutting the computer down or letting it sleep does.</p>
            <h4 className="pr-sg-sub">Time it was not running</h4>
            {s.downtime.length === 0 ? <p className="small muted">None on record.</p> : <>
              <p className="small">{s.downtimeDay.gaps ? <>In the last 24 hours: <strong>{span(s.downtimeDay.ms)}</strong> in {s.downtimeDay.gaps} gap{s.downtimeDay.gaps === 1 ? '' : 's'}. {s.downtimeDay.missed ? `${s.downtimeDay.missed} of your scheduled runs fell in them, were missed, and were not run late.` : 'None of your scheduled runs was missed.'}</> : 'None in the last 24 hours.'}</p>
              <details className="pr-sg-more-d">
                <summary>Each gap, newest first ({s.downtime.length}{s.downtime.length === 40 ? ' most recent' : ''})</summary>
                <ul className="pr-sg-list small">
                  {s.downtime.map((d) => <li key={d.id}><span>{fmt.dayTime(d.from_ts)} to {fmt.time(d.to_ts)} ({span(d.to_ts - d.from_ts)}){d.missed_runs ? <strong>, {d.missed_runs} run{d.missed_runs === 1 ? '' : 's'} missed</strong> : ''}{d.note ? <span className="muted">. {d.note}</span> : null}</span></li>)}
                </ul>
              </details>
            </>}
            <p className="small muted">A gap is written down when the engine returns. Nothing is ever executed for a time it was not running.</p>
          </SgRow>
          <SgRow id="sources" title="Where the figures come from" hid="src-h" tags={<KindTag kind="watched" />} status={live === s.providers.length ? <Stamp tone="ok">All live</Stamp> : <Stamp tone="wait">{`${s.providers.length - live} not live`}</Stamp>} aside={`${live} of ${s.providers.length} live`}>
            <ul className="pr-sg-list pr-sg-sources">
              {s.providers.map((p) => { const n = SOURCE[p.provider] ?? [p.provider, '']; const on = p.state === 'live'; return (
                <li key={p.provider}><div className="src"><b>{n[0]}</b><Stamp tone={on ? 'ok' : 'void'}>{on ? 'Live' : p.state[0]!.toUpperCase() + p.state.slice(1)}</Stamp></div>
                  <span className="sub">{n[1]}. Last heard <span className="tabular">{p.last_ok ? fmt.age(now - p.last_ok) : 'never'}</span>{p.reconnects ? `; reconnected ${p.reconnects} time${p.reconnects === 1 ? '' : 's'}` : ''}.{!on && p.last_error ? ` ${p.last_error}` : ''}</span></li>) })}
            </ul>
            <p className="small muted">All are public feeds that need no account. A price older than its limit is marked stale and cannot be used to execute. {s.counts.samples.toLocaleString('en-IN')} price samples and {s.counts.dailyValues.toLocaleString('en-IN')} daily values are stored on this computer.</p>
            {clock ? <p className="small muted">This computer's clock is {Math.abs(clock.offset_ms).toFixed(0)} ms {clock.offset_ms > 0 ? 'behind' : 'ahead of'} {clock.reference.replace(/^binance/, 'Binance\'s')}, give or take {clock.uncertainty_ms.toFixed(0)} ms (checked {fmt.age(now - clock.ts)}). Every time on a record is this computer's.</p> : <p className="small wait">This computer's clock has not been checked against an outside reference yet.</p>}
          </SgRow>
          <SgRow title="Rates and rules QED relies on" hid="terms-h" tags={<Stamp tone="plain">Relied on</Stamp>} aside={`${terms.length} on record`}>
            <p className="small muted">{(['verified', 'unverified', 'modelled'] as const).filter((k) => tally[k]).map((k) => `${tally[k]} ${STATUS[k]![0].toLowerCase()} (${STATUS[k]![2]})`).join('; ')}.</p>
            <details className="pr-sg-more-d">
              <summary>Show all {terms.length}</summary>
              <div className="pr-sg-scroll" tabIndex={0} role="region" aria-label="Rates and rules; scroll sideways on a narrow screen">
                <table className="ledger pr-sg-terms">
                  <thead><tr><th scope="col">What</th><th scope="col">Standing</th><th scope="col" className="wide-only">Source</th></tr></thead>
                  <tbody>{terms.map((t) => { const st = STATUS[t.status] ?? [t.status, 'plain' as const, '']; const fig = termFigure(t.value); return (
                    <tr key={t.id}><td>{t.name}{fig ? <span className="sub"><strong>{fig}</strong></span> : null}</td><td><Stamp tone={st[1]}>{st[0]}</Stamp><span className="sub muted">as of {t.as_of}</span></td>
                      <td className="wide-only small">{httpsOnly(t.source_url) ? <a href={httpsOnly(t.source_url)} target="_blank" rel="noreferrer noopener">{t.source}<span className="sr"> (another site, in a new tab)</span></a> : t.source}</td></tr>) })}</tbody>
                </table>
              </div>
            </details>
          </SgRow>
          <SgRow title="The model behind Ask" hid="ai-h" tags={<Stamp tone="plain">Enforces nothing</Stamp>} status={s.ai.provider === 'none' ? <Stamp tone="plain">None configured</Stamp> : null}>
            {s.ai.provider === 'none' ? null : <p className="small"><strong>{s.ai.model}</strong></p>}
            <p className="small muted">{s.ai.detail} It only proposes. It holds no credential, calls no tool and cannot approve, send or change anything.</p>
          </SgRow>
        </div>
      </section>

      <section className="panel pr-sg-band" aria-labelledby="band-records-h">
        <h2 id="band-records-h" className="pr-sg-band-h">Your records, and who is signed in</h2>
        <div className="pr-sg-rows">
          <SgRow id="records" title="The records, and how to check them" hid="records-h" wide tags={<span className="pr-kinds"><KindTag kind="watched" /><KindTag kind="enforced" by="server" /></span>} status={records ? <Stamp tone="ok">Consistent</Stamp> : <Stamp tone="void">Needs attention</Stamp>} aside="Checked by the server, and once more here if you ask">
            <dl className="kv pr-sg-records">
              <dt>Ledger</dt><dd>{s.ledger.breaks.length === 0 ? <><Stamp tone="ok">Consistent</Stamp> {s.counts.entries.toLocaleString('en-IN')} entries across all accounts. Each balances to zero in every currency and unit, the balances equal the sum of their entries, and no entry number is missing. Entries cannot be edited or deleted; the database refuses.</> : <><Stamp tone="void">Inconsistent</Stamp> {s.ledger.breaks.map((b) => b.detail).join('; ')}</>}</dd>
              <dt>Against the venues</dt><dd>{s.recon ? <>{s.recon.ok ? <Stamp tone="ok">Agrees</Stamp> : <Stamp tone="void">Does not agree</Stamp>} Last compared {fmt.age(now - s.recon.ts)}: {s.recon.checked.length} finished order{s.recon.checked.length === 1 ? '' : 's'} and payment{s.recon.checked.length === 1 ? '' : 's'} against the venues' own books{s.recon.inFlight.length ? `, ${s.recon.inFlight.length} still in progress` : ''}.{s.recon.repaired.length ? ` Put right: ${s.recon.repaired.join(' ')}` : ''}{s.recon.breaks.length ? ` Not matching: ${s.recon.breaks.join(' ')}` : ''}</> : 'Not compared yet. The engine does this every few seconds while it runs.'}</dd>
              <dt>Receipts</dt><dd>{s.receipts.ok ? <Stamp tone="ok">Chain intact</Stamp> : <Stamp tone="void">Chain broken at no. {s.receipts.brokenAt}</Stamp>} {s.receipts.count} receipts, each fingerprinted together with the one before it. That is the server's own check. The button below repeats it here, without asking the server.</dd>
            </dl>
            {session.user ? <ChainCheck userId={session.user.id} /> : null}
            {recent.data?.receipts.length ? (
              <details className="pr-sg-more-d">
                <summary>The latest {recent.data.receipts.length} receipts, with their fingerprints</summary>
                <ul className="pr-sg-list">
                  {recent.data.receipts.map((r) => <li key={r.id}><Link to={`/receipts/${r.id}`} className="cover"><b className="t">No. {r.seq}: {String(r.body.what ?? r.kind)}</b><span className="sub">{fmt.dayTime(r.ts)}, fingerprint <span className="code">{fmt.hash(r.hash)}</span></span></Link></li>)}
                </ul>
              </details>
            ) : null}
          </SgRow>
          <SgRow title="Where you are signed in" hid="sess-h" wide tags={<KindTag kind="watched" />}><Sessions /></SgRow>
        </div>
      </section>
    </div>
  )
}

/** The page's head, drawn before any of its data (DESIGN.md M11). */
function SafeguardsHead() {
  return <header className="page-head"><div><h1>Safeguards</h1><p>What stands between you and a bad outcome, and how far each safeguard can be relied on at this moment. Where something is an assumption, an estimate or simply not running, this page says so. Why the build as a whole is not ready for real money: <Link to="/readiness">Readiness</Link>.</p></div></header>
}

function SafeguardsSkeleton() {
  return (
    <div className="pr-sg-skel" aria-busy="true">
      <p className="loading-line">Reading the safeguards…</p>
      <Skel h={96} r={24} />
      <Skel h={420} r={24} />
      <Skel h={560} r={24} />
    </div>
  )
}
