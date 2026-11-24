/**
 * The on-chain wallet inside the everyday pages (R7-045), in design "Meridian": pay from it in Spend, convert into its
 * dollar reserve and sign its standing conversion policy in Grow, set money aside on it in Save, and its mandate in
 * Protect. No trip to a separate wallet area. Each goes the way every wallet action goes: the wallet service prepares
 * the exact terms, the sheet shows them, the passkey signs, the terms are sent once and followed on the same page until
 * they finish, and the finished action links to its record, which holds the chain proof. Amounts are test rupees and
 * test dollars on a local chain; they are said so where they appear.
 *
 * Each part is content without chrome of its own: the page that holds it gives it its panel, and it fits itself to the
 * width it is given (a container query, `vt-inline` in vault.css), from a phone to the widest column. Each rule it shows
 * says who enforces it (src/ui/enforced.tsx). The sheet is UX only: the passkey's signature over the exact digests is
 * what the chain checks.
 */
import { useState } from 'react'
import type { LimitsResult, PaymentLimits, QuoteResult, RailState } from '../../chain/types.ts'
import { api, fmt, useData } from '../lib/core.ts'
import { atomsToPaise } from '../lib/words.ts'
import { EnforcedBy } from '../ui/enforced.tsx'
import { Btn, Field, Link, Mark, Note, Problem, Src, useAction } from '../ui/kit.tsx'
import { headline, payeesInWords, plain, useVaultApproval } from './Vault.tsx'

const PAYEE = 'CloudCo'
interface WalletOverview { available: boolean; setUp: boolean; state: RailState | null; workspace: { asset: { symbol: string; decimals: number }; reserveAsset: { symbol: string; decimals: number } } | null }
type Approval = ReturnType<typeof useVaultApproval>

// Token atoms as paise: one definition, in lib/words.ts, so Protect need not download this file to read its figures.
export { atomsToPaise } from '../lib/words.ts'
/** Test dollars as a person reads them: to the cent, rounded half up exactly, grouped as the wallet's own page writes them. */
const dollars = (raw: string, decimals: number): string => headline(raw, { symbol: 'tUSD', decimals }).text
const rupees = (raw: string, decimals: number): string => fmt.inr(atomsToPaise(raw, decimals), true)

function useWallet() {
  const o = useData<WalletOverview>('/api/vault')
  const d = o.data
  return { o, st: d?.state ?? null, main: d?.workspace?.asset.decimals ?? 2, res: d?.workspace?.reserveAsset.decimals ?? 6 }
}

/** What stops a wallet part from showing its form: no service, no wallet, no mandate. Null when the form can show. */
function Missing({ w, needsMandate }: { w: ReturnType<typeof useWallet>; needsMandate: boolean }) {
  if (!w.o.data) return null
  if (!w.o.data.available) return <p className="vt-inline vt-wmissing">The on-chain wallet's service is not running, so nothing on the chain can be done from here now.</p>
  if (!w.o.data.setUp || !w.st) return <p className="vt-inline vt-wmissing">Your on-chain wallet is not set up. <Link to="/vault">Set it up</Link>, then use it from here.</p>
  if (needsMandate && !w.st.mandate) return <p className="vt-inline vt-wmissing">Before QED can act on your on-chain wallet, sign a mandate saying how much and to whom. <Link to="/vault">Write the mandate</Link>.</p>
  return null
}

/** The line that follows a sent action until it finishes, with its record. */
function Outcome({ v, said }: { v: Approval; said: (outcome: string) => string | null }) {
  const job = v.job
  if (!job) return null
  const finished = job.status === 'done' || job.status === 'failed' || job.status === 'interrupted' || job.status === 'reorged'
  const good = finished && job.status === 'done' && (job.result?.outcome === 'executed' || job.result?.outcome === 'scheduled')
  return (
    <Note tone={!finished ? 'wait' : good ? 'ok' : 'void'}>
      {!finished ? (job.status === 'confirming' ? `Mined; waiting for its confirmations (${job.confirmations?.have ?? 0} of ${job.confirmations?.need ?? 2}) before it is reported done…` : 'Sending to the wallet…') : (good ? said(job.result!.outcome) : null) ?? (job.result?.summary ? plain(job.result.summary) : null) ?? (job.error ? plain(job.error) : null) ?? `Finished: ${job.status}.`} <Link to={`/vault/job/${job.id}`}>Open its record</Link>
    </Note>
  )
}

const amountOk = (s: string): boolean => /^\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) > 0
const daysOf = (s: string): number | null => (s.trim() === '' ? null : /^\d{1,3}$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 365 ? Number(s) : NaN)
/** The earned-authority cap's window in words (K1): "30 days", "12 hours". */
const capWindow = (seconds: number): string => (seconds % 86_400 === 0 ? `${String(seconds / 86_400)} day${seconds === 86_400 ? '' : 's'}` : `${String(Math.round(seconds / 3_600))} hours`)
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

/** Spend: pay the payee the mandate names, now or on a later day. */
export function WalletPay({ onPaid }: { onPaid?: () => void }) {
  const w = useWallet()
  const room = useData<PaymentLimits>(w.st?.mandate ? '/api/vault/payment-limits' : null)
  const v = useVaultApproval({ stay: true, onDone: () => { room.reload(); w.o.reload(); onPaid?.() } })
  const [amount, setAmount] = useState(''), [days, setDays] = useState('')
  const [sent, setSent] = useState<{ paise: number; days: number | null } | null>(null)
  const missing = <Missing w={w} needsMandate />
  if (!w.st?.mandate || !w.o.data?.available) return missing
  const later = daysOf(days)
  const most = room.data ? atomsToPaise(room.data.maximum, w.main) : null
  const lower = !!room.data?.authority && most !== null && most < atomsToPaise(w.st.mandate.usage.perPayment.limit, w.main)
  return (<>
    <form className="vt-inline vt-wpay" aria-label="Pay from your on-chain wallet" onSubmit={(e) => {
      e.preventDefault()
      if (!amountOk(amount) || Number.isNaN(later)) return
      setSent({ paise: Math.round(Number(amount.trim()) * 100), days: later })
      void v.start('/api/vault/proposals', { kind: 'pay', params: { payee: PAYEE, amount: amount.trim(), ...(later ? { dueInDays: later } : {}) } }, { title: `Pay ${PAYEE} from your on-chain wallet` })
    }}>
      <div className="vt-wto">
        <span className="vt-wto-av" aria-hidden="true">{initials(PAYEE)}</span>
        <span className="vt-wto-who"><b>To {PAYEE}</b><Src kind="chain" /><small>The payee your mandate names, in test rupees on the local chain; they have no value</small></span>
        <EnforcedBy by="contract" />
      </div>
      <div className="vt-wfields">
        <Field label="How much, in test rupees" error={amount.trim() !== '' && !amountOk(amount) ? 'Enter an amount in rupees, with at most two decimals.' : undefined}>{(p) => <div className="money"><input {...p} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}</Field>
        <Field label="Pay it in this many days" error={Number.isNaN(later) ? 'A whole number of days from 1 to 365, or empty to pay now.' : undefined}>{(p) => <input {...p} className="input" inputMode="numeric" placeholder="Now" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
      </div>
      {most !== null ? (most === 0
        ? <Note tone="void">Nothing can be paid from the wallet right now: {plain(room.data!.checks.filter((c) => !c.pass)[0]?.detail ?? 'a limit is used up')}. <Link to="/vault/treasury">See its limits</Link>.</Note>
        : <div className="vt-wroom">
          <p className="vt-wroom-k">Most that can be paid now</p>
          <p className="vt-wroom-v">{fmt.inr(most, true)}<small> in test rupees</small></p>
          {lower ? <p className="vt-wroom-s">The mandate allows {rupees(w.st.mandate.usage.perPayment.limit, w.main)} a payment; what is lower now is your authority budget: {rupees(room.data!.authority!.available, w.main)} left of {rupees(room.data!.authority!.granted, w.main)} granted and {rupees(room.data!.authority!.earned, w.main)} earned, after what payments and conversions have used.{room.data!.authority!.earnedLimit ? <> Earned counts at most {rupees(room.data!.authority!.earnedLimit.perWindow, w.main)} in any {capWindow(room.data!.authority!.earnedLimit.windowSeconds)}, {rupees(room.data!.authority!.earnedLimit.perPayer, w.main)} from any one payer, and nothing of what your wallet had sent the payer first.</> : null} <Link to="/vault/treasury">Grant more</Link>.</p> : null}
          <p className="vt-wroom-by"><EnforcedBy by="contract" /><EnforcedBy by="qed" /><span>The agent's key sends it after QED's co-signer and the wallet's contract have checked it against your limits.</span></p>
        </div>) : room.error ? <Problem error={room.error} /> : null}
      {most !== null && most > 0 && amountOk(amount) && Math.round(Number(amount) * 100) > most ? <Note tone="void">That is more than can be paid now, so the wallet would refuse it. You can still send it to see the refusal; it is recorded with the rule that refused it.</Note> : null}
      <div className="vt-wgo"><Btn tone="fill" type="submit" busy={v.busy} disabled={!amountOk(amount) || Number.isNaN(later) || most === 0}>Review and sign</Btn></div>
      <Problem error={v.error} />
      <Outcome v={v} said={(out) => !sent ? null : out === 'scheduled' ? `${fmt.inr(sent.paise, true)} in test rupees is set aside for ${PAYEE}, to be paid in ${String(sent.days)} days.` : `Paid ${fmt.inr(sent.paise, true)} in test rupees to ${PAYEE} from your on-chain wallet.`} />
    </form>
    {v.sheet}
  </>)
}

/** Grow: convert test rupees into the wallet's dollar reserve, after its limits and a price are read. */
export function WalletConvert({ onDone }: { onDone?: () => void }) {
  const w = useWallet()
  const v = useVaultApproval({ stay: true, onDone: () => { w.o.reload(); onDone?.() } })
  const [amount, setAmount] = useState('')
  const [checked, setChecked] = useState<{ amount: string; limits: LimitsResult; quote: QuoteResult | null } | null>(null)
  const check = useAction(async () => {
    const a = amount.trim()
    const [limits, quote] = await Promise.all([api<LimitsResult>('GET', `/api/vault/limits?amount=${encodeURIComponent(a)}`), api<QuoteResult>('GET', `/api/vault/quote?amount=${encodeURIComponent(a)}`).catch(() => null)])
    setChecked({ amount: a, limits, quote })
  })
  const missing = <Missing w={w} needsMandate />
  if (!w.st?.mandate || !w.o.data?.available) return missing
  const t = w.st.treasury, r = w.st.reserve
  const fresh = checked && checked.amount === amount.trim()
  return (<>
    <form className="vt-inline vt-wconv" aria-label="Convert into your dollar reserve" onSubmit={(e) => { e.preventDefault(); if (amountOk(amount)) void check.run() }}>
      <dl className="vt-wfree">
        <div><dt>Free in the treasury</dt><dd>{rupees(t.free, w.main)}<small>test rupees</small></dd></div>
        <div><dt>In the reserve, free</dt><dd>{dollars(r.free, w.res)}<small>test dollars</small></dd></div>
      </dl>
      <p className="vt-wsay">Test rupees from your on-chain wallet into its reserve of test dollars, at a price read now and checked again when it is sent.</p>
      <Field label="Convert how much, in test rupees" error={amount.trim() !== '' && !amountOk(amount) ? 'Enter an amount in rupees, with at most two decimals.' : undefined}>{(p) => <div className="money"><input {...p} className="input" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setChecked(null) }} /></div>}</Field>
      {fresh ? (
        <div className="vt-wcheck">
          {checked.quote?.expectedOut ? <p className="vt-wget">You would receive about <strong>{dollars(checked.quote.expectedOut, w.res)}</strong> in test dollars{checked.quote.bound ? <>, and no less than {dollars(checked.quote.bound, w.res)}</> : null}.</p> : <p className="vt-wsay">No price could be read for this amount now.</p>}
          <ul className="checks">{checked.limits.checks.map((c, i) => <li key={i} className={c.pass ? '' : 'no'}><Mark pass={c.pass} /><span>{plain(c.detail || c.rule)}<span className="sr">{c.pass ? ' passed' : ' failed'}</span></span></li>)}</ul>
          <p className="vt-wroom-by"><EnforcedBy by="contract" /><span>The wallet's contract refuses a conversion over these limits, or further from the provable best price than the order allows.</span></p>
          {!checked.limits.allowed ? <Note tone="void">Your limits would refuse this now. You can still send it; the refusal is then recorded on its own record.</Note> : null}
        </div>
      ) : null}
      <div className="vt-wgo">
        {fresh
          ? <Btn tone="fill" type="button" busy={v.busy} onClick={() => void v.start('/api/vault/proposals', { kind: 'convert', params: { amount: checked.amount } }, { title: 'Convert into your dollar reserve' })}>Review and sign</Btn>
          : <Btn tone="fill" type="submit" busy={check.busy} disabled={!amountOk(amount)}>Check the limits and the price</Btn>}
      </div>
      <Problem error={check.error ?? v.error} />
      <Outcome v={v} said={() => (checked ? `Converted ${fmt.inr(Math.round(Number(checked.amount) * 100), true)} in test rupees into your dollar reserve.` : null)} />
    </form>
    {v.sheet}
  </>)
}

/** Grow: the standing conversion policy, signed once; QED's engine then keeps the reserve topped up on its own. */
export function WalletPolicy() {
  const w = useWallet()
  const v = useVaultApproval({ stay: true, onDone: () => w.o.reload() })
  const [target, setTarget] = useState('5')
  const missing = <Missing w={w} needsMandate />
  if (!w.st?.mandate || !w.o.data?.available) return missing
  const p = w.st.policy && w.st.policy.status === 'active' ? w.st.policy : null
  return (<>
    {p ? (
      <div className="vt-inline vt-wpol">
        <p className="vt-wpol-lead"><strong>In force:</strong> keep {dollars(p.targetFree, w.res)} in test dollars free in the reserve, converting test rupees when it falls below that.</p>
        <p className="vt-wroom-by"><EnforcedBy by={p.enforcement === 'contract' ? 'contract' : 'qed'} /><span>{p.enforcement === 'contract' ? 'A policy contract on the chain refuses any other tranche.' : 'QED\'s co-signer works each tranche out again before it signs.'}</span></p>
        <p className="vt-wsay">Signed {fmt.dayTime(Date.parse(p.signedAt))}; ticked {String(p.ticks)} {p.ticks === 1 ? 'time' : 'times'}; reserve free now {dollars(p.reserveFree, w.res)}{BigInt(p.reserveFree) < BigInt(p.targetFree) ? ', below the target: each tick\'s record says why it did not convert' : ''}. QED's engine ticks it on its own every five minutes while QED runs; pausing QED stops it. <Link to="/vault/policy">Change or revoke it</Link></p>
      </div>
    ) : (
      <form className="vt-inline vt-wpol" aria-label="Keep a dollar reserve topped up" onSubmit={(e) => { e.preventDefault(); if (amountOk(target)) void v.start('/api/vault/proposals', { kind: 'policy', params: { targetFree: target.trim(), enforcement: 'cosigner' } }, { title: 'Keep your dollar reserve topped up' }) }}>
        <p className="vt-wsay">Sign once; QED's engine then converts test rupees on its own when the reserve's free test dollars fall below this, in tranches the co-signer re-checks, within your mandate. Pausing QED stops it.</p>
        <Field label="Keep this much free in the reserve, in test dollars">{(f) => <input {...f} className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
        <p className="vt-wroom-by"><EnforcedBy by="qed" /><span>QED's co-signer refuses any tranche the policy does not call for.</span></p>
        <div className="vt-wgo"><Btn tone="fill" type="submit" busy={v.busy} disabled={!amountOk(target)}>Review and sign</Btn></div>
        <Problem error={v.error} />
        <Outcome v={v} said={() => `Signed: QED keeps $${Number(target).toFixed(2)} in test dollars free in your reserve from now on.`} />
      </form>
    )}
    {v.sheet}
  </>)
}

/** Save: money set aside on the wallet for a creditor; it can only ever be paid to them. */
export function WalletSetAside() {
  const w = useWallet()
  const v = useVaultApproval({ stay: true, onDone: () => w.o.reload() })
  const [amount, setAmount] = useState(''), [days, setDays] = useState('30')
  const missing = <Missing w={w} needsMandate={false} />
  if (!w.st || !w.o.data?.available || !w.o.data.setUp) return missing
  const t = w.st.treasury
  const due = daysOf(days)
  return (<>
    <form className="vt-inline vt-waside" aria-label="Set money aside on your on-chain wallet" onSubmit={(e) => { e.preventDefault(); if (amountOk(amount) && due && !Number.isNaN(due)) void v.start('/api/vault/proposals', { kind: 'ring-fence', params: { creditor: PAYEE, amount: amount.trim(), dueInDays: due } }, { title: `Set money aside for ${PAYEE}` }) }}>
      <dl className="vt-wfree">
        <div><dt>On the wallet</dt><dd>{rupees(t.balance, w.main)}<small>test rupees, no value</small></dd></div>
        <div><dt>Set aside for creditors</dt><dd>{rupees(t.ringFenced, w.main)}</dd></div>
        <div><dt>Free</dt><dd>{rupees(t.free, w.main)}</dd></div>
      </dl>
      <p className="vt-wroom-by"><EnforcedBy by="contract" /><span>Money set aside cannot be taken back, by you or anyone, and can only be paid to {PAYEE}.</span></p>
      <div className="vt-wfields">
        <Field label={`How much to set aside for ${PAYEE}, in test rupees`} error={amount.trim() !== '' && !amountOk(amount) ? 'Enter an amount in rupees, with at most two decimals.' : undefined}>{(p) => <div className="money"><input {...p} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}</Field>
        <Field label="Due in this many days" error={due === null || Number.isNaN(due) ? 'A whole number of days from 1 to 365.' : undefined}>{(p) => <input {...p} className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
      </div>
      <div className="vt-wgo"><Btn tone="fill" type="submit" busy={v.busy} disabled={!amountOk(amount) || due === null || Number.isNaN(due)}>Review and sign</Btn></div>
      <Problem error={v.error} />
      <Outcome v={v} said={() => `${fmt.inr(Math.round(Number(amount) * 100), true)} in test rupees is set aside for ${PAYEE}, due in ${String(due)} days.`} />
    </form>
    {v.sheet}
  </>)
}

/** Grow's section for the wallet's dollar reserve: one message when the wallet cannot be used yet, else both parts. */
export function WalletGrowSection() {
  const w = useWallet()
  const ready = !!(w.o.data?.available && w.o.data.setUp && w.st?.mandate)
  return (
    <section className="vt-wgrow" aria-labelledby="h-reserve">
      <div className="vt-whead"><h2 id="h-reserve">Dollar reserve on the chain</h2><span className="vt-test">Test dollars on a local chain, no value</span></div>
      {!ready ? <Missing w={w} needsMandate /> : (
        <div className="vt-wgrow-cols">
          <div className="vt-wgrow-col"><h3>Convert by hand</h3><WalletConvert /></div>
          <div className="vt-wgrow-col"><h3>Keep it topped up on its own</h3><WalletPolicy /></div>
        </div>
      )}
    </section>
  )
}

/**
 * Protect: what QED may pay from the on-chain wallet (its mandate), in words with what is left, and a new mandate
 * signed in place. A new mandate revokes the one in force, on the chain, first.
 */
export function WalletMandate() {
  const w = useWallet()
  const v = useVaultApproval({ stay: true, onDone: () => w.o.reload() })
  const [open, setOpen] = useState(false)
  const [per, setPer] = useState(''), [day, setDay] = useState(''), [all, setAll] = useState(''), [days, setDays] = useState('30')
  if (!w.o.data?.available || !w.o.data.setUp || !w.st) return <Missing w={w} needsMandate={false} />
  const m = w.st.mandate && w.st.mandate.status === 'active' ? w.st.mandate : null
  const u = m?.usage
  const until = u ? fmt.day(u.validity.validUntil * 1000) : ''
  const okDays = /^\d{1,2}$/.test(days.trim()) && Number(days) >= 1 && Number(days) <= 30
  const opt = (s: string) => s.trim() === '' || amountOk(s)
  const ready = amountOk(per) && opt(day) && opt(all) && okDays
  return (<>
    <div className="vt-inline vt-wmandate">
      {m && u ? <>
        {/* the contract's names for its parts ("QEDExecution (conversion module)") in the owner's words, as on the wallet's own page */}
        <p className="vt-wmandate-lead">QED may pay {payeesInWords(m.payeeLabels) || PAYEE} from your on-chain wallet: at most <strong>{rupees(u.perPayment.limit, w.main)}</strong> a payment, {rupees(u.period.limit, w.main)} a day ({rupees(u.period.remaining, w.main)} left today) and {rupees(u.lifetime.limit, w.main)} in all ({rupees(u.lifetime.remaining, w.main)} left), until {until}. In test rupees; the wallet's contract enforces every limit.</p>
      </> : <p className="vt-wmandate-lead">QED may not pay from your on-chain wallet: no mandate is in force. Without one, the agent can do nothing with it.</p>}
      {w.st.policy && w.st.policy.status === 'active' ? <p className="vt-wsay">A standing conversion policy is in force: QED's engine converts test rupees on its own, every five minutes while QED runs, to keep {dollars(w.st.policy.targetFree, w.res)} in test dollars free in the reserve. Pausing QED stops it. <Link to="/holdings">Change it in Grow</Link>.</p> : null}
      {!open ? <div className="vt-wgo"><Btn onClick={() => setOpen(true)}>{m ? 'Change these limits' : 'Write a mandate'}</Btn><Link className="vt-wlink" to="/vault">All of the on-chain wallet</Link></div> : (
        <form className="vt-wform" aria-label="A new mandate for your on-chain wallet" onSubmit={(e) => { e.preventDefault(); if (ready) void v.start('/api/vault/proposals', { kind: 'mandate', params: { maxPerPayment: per.trim(), ...(day.trim() ? { maxPerPeriod: day.trim() } : {}), ...(all.trim() ? { maxTotal: all.trim() } : {}), validDays: Number(days) } }, { title: 'A new mandate for your on-chain wallet' }) }}>
          <div className="vt-wfields four">
            <Field label="Most in one payment, in test rupees">{(f) => <div className="money"><input {...f} className="input" inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} /></div>}</Field>
            <Field label="Most in a day, in test rupees" hint="Optional.">{(f) => <div className="money"><input {...f} className="input" inputMode="decimal" value={day} onChange={(e) => setDay(e.target.value)} /></div>}</Field>
            <Field label="Most in all, in test rupees" hint="Optional.">{(f) => <div className="money"><input {...f} className="input" inputMode="decimal" value={all} onChange={(e) => setAll(e.target.value)} /></div>}</Field>
            <Field label="Valid for how many days" hint="1 to 30." error={days.trim() !== '' && !okDays ? 'A whole number of days from 1 to 30.' : undefined}>{(f) => <input {...f} className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
          </div>
          <p className="vt-wsay">{m ? 'Signing a new mandate revokes the one in force, on the chain, first.' : 'It names what the agent may pay, to whom, and until when.'}</p>
          <div className="vt-wgo"><Btn tone="fill" type="submit" busy={v.busy} disabled={!ready}>Review and sign</Btn><Btn tone="quiet" type="button" onClick={() => setOpen(false)}>Close</Btn></div>
        </form>
      )}
      <Problem error={v.error} />
      <Outcome v={v} said={() => 'Signed: the new mandate is in force on the chain.'} />
    </div>
    {v.sheet}
  </>)
}
