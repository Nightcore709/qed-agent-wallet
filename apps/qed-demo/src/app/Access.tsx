/**
 * Getting back in (R12 section 4), in three separate journeys with their own words and screens:
 *
 *   Reset your password      for an account that signs in with a password and has no passkey: a link by email sets a
 *                            new one, signs out every session, and does not sign anyone in (server/recovery.ts).
 *   Recover your account     every passkey lost: a link by email and one more proof start a recovery that waits, is
 *                            told to every device, address and recovery contact, and can be stopped by any of them;
 *                            then the newest link, opened in the browser that started it (which keeps its finishing
 *                            key), makes a new passkey, which signs in only. Saved codes with a contact's code, without
 *                            email, stay as the backup path, never the first thing offered unless this installation
 *                            cannot send email at all (then every page says so, and offers the codes).
 *   Approve payments again   the recovered passkey asks for approval authority; it is given after a further wait,
 *                            unless another passkey or a recovery contact stops it.
 *
 * Also the pages a link opens (reset, recover, confirm an email address) and the developer page of the local test
 * outbox, which says above everything that no email or text message was sent. Loaded only when one of these is opened.
 * Every link's token is read from the address's fragment and removed from the address bar at once.
 */
import { ArrowLeft, Check, Copy, Download, Fingerprint, KeyRound, LifeBuoy, Mail, RefreshCw, ShieldCheck } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { api, ApiError, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { deviceWords, finishRecovery, finishRecoveryWithLink, passkeysAvailable, requestAuthority, startRecovery } from '../lib/passkey.ts'
import { Btn, Field, Logo, Note, PasswordField, Problem, useAction, useSession } from '../ui/kit.tsx'
import { noDeliveryWords, type OutboxCase, outboxWords } from '../../shared/delivery-words.ts'

// ------------------------------------------------------------------------------------------------ small parts

/** How long a wait is, in plain words. */
export function waitWords(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)} seconds`
  if (ms < 2 * 3600_000) return `${Math.round(ms / 60_000)} minutes`
  if (ms < 72 * 3600_000 && ms % 86_400_000 !== 0) return `${Math.round(ms / 3600_000)} hours`
  return `${Math.round(ms / 86_400_000)} days`
}
/** A wait shortened on a test installation says so, so that "6 seconds" is never read as the product's real delay. */
const said = (ms: number): string => `${waitWords(ms)}${ms < 72 * 3600_000 ? ' (shortened on this test installation)' : ''}`
const recoveryWait = (d?: { recoveryMs: number }): string => said(d?.recoveryMs ?? 72 * 3600_000)
const authorityWait = (d?: { protectionMs: number }): string => said(d?.protectionMs ?? 72 * 3600_000)

/** The token a link carries in its fragment, taken once per page and removed from the address bar and its history. */
let taken: { path: string; token: string } | null = null
function linkToken(): string {
  if (typeof location === 'undefined') return ''
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{20,100})/.exec(location.hash)
  // a new link opened in the same tab changes only the fragment: its token replaces the one taken before
  if (taken?.path === location.pathname && !m) return taken.token
  taken = { path: location.pathname, token: m?.[1] ?? '' }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
  return taken.token
}
/** The page's link token, read again when a newer link is opened in the same tab (only the fragment changes then). */
function useLinkToken(): string {
  const [token, setToken] = useState(linkToken)
  useEffect(() => {
    const on = () => setToken(linkToken())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return token
}

/** In this build messages go to the local test outbox: said where a message is promised, with the way to it. */
/**
 * What was done with a message the page promised. In this build every message is kept in the simulated outbox and none is
 * sent, so none is said to be on its way or sent (R13: simulated delivery is never presented as a real message); with a
 * provider (not in this build) the message is on its way.
 */
function Sent({ what, typed }: { what: OutboxCase; typed: string }) {
  const { session } = useSession()
  if (session.delivery === 'outbox') { const w = outboxWords(what, typed); return <Note tone="ok" title={w.title}>{w.body}</Note> }
  return what === 'confirm'
    ? <Note tone="ok" title={`Confirmation sent to ${typed}`}>Open the link in it, or type its code under Security and recovery. It receives your security notices once confirmed.</Note>
    : <Note tone="ok" title="Check your email">If an account with a confirmed email address matches “{typed}”, {what === 'reset' ? 'a message is on its way to that address. Its link works once, for 30 minutes.' : 'a recovery link is on its way to that address. It works once, for an hour.'}</Note>
}

function OutboxPointer() {
  const { session } = useSession()
  if (session.delivery !== 'outbox') return null
  return <Note tone="qed" title="Simulated delivery in this build">No email or text message is sent from this computer. QED keeps each message it would send in a <a href="/dev/outbox" target="_blank" rel="noopener">simulated outbox</a> instead, for testing.</Note>
}

/** With no way to send messages on this installation (review M4): what is not available here, and what to use instead. */
function NoDelivery({ what }: { what: 'reset' | 'recover' | 'address' }) {
  return <div role="status"><Note tone="wait" title="Email is not available here">{noDeliveryWords(what)}</Note></div>
}

/** A link that no longer works: what happened, in plain words, and what to do. */
function LinkGone({ error, again, againLabel }: { error: ApiError; again: string; againLabel: string }) {
  const title = { link_expired: 'This link has expired', link_used: 'This link was already used', link_replaced: 'A newer link replaced this one', link_invalid: 'This link does not work', recovery_cancelled: 'This recovery was stopped', recovery_lapsed: 'This recovery lapsed', recovery_unavailable: 'No recovery to finish' }[error.code] ?? 'This link cannot be used'
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <h1 className="access-title" tabIndex={-1}>{title}</h1>
      <Note tone={error.code === 'recovery_cancelled' || error.code === 'recovery_lapsed' ? 'wait' : 'void'}>{error.message}</Note>
      <div><Btn tone="fill" onClick={() => navigate(again, true)}>{againLabel}</Btn></div>
    </div>
  )
}

/** The page frame for a link's page: the wordmark, then one glass card. */
function Solo({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="solo" id="content">
      <div className={`solo-card stack access-solo${wide ? ' wide' : ''}`} style={{ ['--gap' as string]: '18px' }}>
        <span className="brand"><Logo /><b>QED</b></span>
        {children}
      </div>
    </main>
  )
}

/** Focus the page's heading when its step changes, so a screen reader and the keyboard start at the new step. */
function useFocusHeading(step: unknown): RefObject<HTMLHeadingElement | null> {
  const h = useRef<HTMLHeadingElement>(null)
  useEffect(() => { h.current?.focus({ preventScroll: false }) }, [step])
  return h
}

// ------------------------------------------------------------------------------------------------ the pages links open

/** The pages a message's link opens, and the developer outbox. Shown signed in or out. */
export function AccessPage({ path }: { path: string }) {
  if (path === '/reset-password') return <ResetPasswordPage />
  if (path === '/recover') return <RecoverPage />
  if (path === '/verify-email') return <VerifyEmailPage />
  if (path === '/dev/outbox') return <OutboxPage />
  return null
}
export const ACCESS_PATHS = ['/reset-password', '/recover', '/verify-email', '/dev/outbox']

function ResetPasswordPage() {
  const { reload } = useSession()
  const token = useLinkToken()
  const [state, setState] = useState<{ handle: string; expiresAt: number } | null>(null)
  const [gone, setGone] = useState<ApiError | null>(null)
  const [pw, setPw] = useState(''), [again, setAgain] = useState(''), [show, setShow] = useState(false)
  const [done, setDone] = useState<{ ended: number } | null>(null)
  useEffect(() => {
    api<{ handle: string; expiresAt: number }>('POST', '/api/auth/password/reset/state', { token }).then(setState, (e: unknown) => setGone(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))))
  }, [token])
  const reset = useAction(async () => {
    try { setDone(await api<{ ended: number }>('POST', '/api/auth/password/reset', { token, password: pw, confirm: again })) }
    catch (e) { if (e instanceof ApiError && e.code.startsWith('link_')) setGone(e); throw e }
  })
  const h = useFocusHeading(done ? 'done' : gone ? 'gone' : state ? 'form' : 'wait')
  if (gone) return <Solo><LinkGone error={gone} again="/?help=forgot" againLabel="Ask for a new link" /></Solo>
  if (!state) return <Solo><p className="loading-line" aria-busy="true">Checking the link…</p></Solo>
  if (done) return (
    <Solo>
      <h1 className="access-title" ref={h} tabIndex={-1}>Your password was changed</h1>
      <div role="status"><Note tone="ok" title={`@${state.handle} has a new password`}>{done.ended ? `${done.ended === 1 ? 'The one session' : `All ${done.ended} sessions`} signed in to the account ${done.ended === 1 ? 'was' : 'were'} signed out.` : 'No session was signed in.'} Every email address of the account has been told.</Note></div>
      <p className="muted">Sign in with the new password. You were not signed in by this link: whoever follows a link should not get in by it alone.</p>
      <div><Btn tone="fill" onClick={() => { navigate('/', true); void reload() }}>Go to sign in</Btn></div>
    </Solo>
  )
  const f = reset.error?.fields ?? {}
  return (
    <Solo>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h1 className="access-title" ref={h} tabIndex={-1}>Set a new password</h1>
        <p className="muted">For the account @{state.handle}. This link works once, until {fmt.dayTime(state.expiresAt)}.</p>
      </div>
      <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void reset.run() }}>
        <input type="text" name="username" autoComplete="username" value={state.handle} readOnly hidden />
        <PasswordField label="New password" value={pw} onChange={setPw} show={show} onShow={setShow} autoComplete="new-password" error={f.password} hint="At least 10 characters, not your handle, not a common password. A phrase of a few words works well." />
        <PasswordField label="Type it again" value={again} onChange={setAgain} show={show} onShow={setShow} autoComplete="new-password" error={f.confirm} />
        {reset.error && !f.password && !f.confirm && !reset.error.code.startsWith('link_') ? <Problem error={reset.error} /> : null}
        <Btn tone="fill" className="block" type="submit" busy={reset.busy} disabled={!pw || !again}>Set the new password</Btn>
        <p className="small faint">Setting it signs out every session of the account. A passkey added after a reset signs in only, until it is given approval authority after a wait.</p>
      </form>
    </Solo>
  )
}

type LinkState =
  | { state: 'start'; handle: string; proofs: { savedCode: boolean; contact: boolean; password: boolean }; expiresAt: number }
  | { state: 'waiting' | 'ready' | 'codes'; handle: string; requestId: string; startedAt: number; availableAt: number; finishBy: number; expiresAt: number }

/**
 * The finishing key of a recovery started from an email link: given only to the browser that started it (the server keeps
 * its hash), and asked for with the link that finishes it (review H1: a mailbox alone never finishes a recovery). Kept
 * here so that finishing in this browser needs no copying; shown too, for finishing on another device.
 */
interface FinishKey { requestId: string; handle: string; finishKey: string; finishBy: number }
const KEYS = 'qed-recovery-keys'
function finishKeys(): FinishKey[] { try { const v = JSON.parse(localStorage.getItem(KEYS) ?? '[]') as unknown; return Array.isArray(v) ? (v as FinishKey[]).filter((k) => typeof k?.requestId === 'string' && typeof k.finishKey === 'string' && k.finishBy > Date.now()) : [] } catch { return [] } }
function keepKey(k: FinishKey): void { try { localStorage.setItem(KEYS, JSON.stringify([k, ...finishKeys().filter((x) => x.requestId !== k.requestId)].slice(0, 5))) } catch { /* a private window: the key is shown to keep instead */ } }
function dropKey(requestId: string): void { try { localStorage.setItem(KEYS, JSON.stringify(finishKeys().filter((x) => x.requestId !== requestId))) } catch { /* nothing kept */ } }
const keyFor = (requestId: string): string => finishKeys().find((k) => k.requestId === requestId)?.finishKey ?? ''

/** The finishing key, shown once the recovery has started, for finishing it on another device. */
function ShowKey({ finishKey }: { finishKey: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <details className="ax-key">
      <summary>Finishing on another device?</summary>
      <p className="small muted">This browser keeps the key that finishes the recovery. To finish on another device instead, keep this key and enter it there with the newest link: the link alone cannot finish it.</p>
      <p className="code recovery-ref">{finishKey}</p>
      <Btn small onClick={() => void navigator.clipboard?.writeText(finishKey).then(() => setCopied(true)).catch(() => {})}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy the key'}</Btn>
    </details>
  )
}

function RecoverPage() {
  const { session, reload } = useSession()
  const now = useNow(1000)
  const token = useLinkToken()
  const [st, setSt] = useState<LinkState | null>(null)
  const [gone, setGone] = useState<ApiError | null>(null)
  const [proof, setProof] = useState<'savedCode' | 'contact' | 'password'>('savedCode')
  const [value, setValue] = useState(''), [show, setShow] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  // a link that started the recovery is spent: it shows the wait, and the newer link that QED sends finishes it
  const [spent, setSpent] = useState<string | null>(null)
  const [typedKey, setTypedKey] = useState('')
  const load = async () => { try { setSt(await api<LinkState>('POST', '/api/auth/recovery/link/state', { token })) } catch (e) { setGone(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))) } }
  useEffect(() => { setSt(null); setGone(null); setSpent(null); setTypedKey(''); void load() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (st?.state === 'start') setProof(st.proofs.savedCode ? 'savedCode' : st.proofs.contact ? 'contact' : 'password') }, [st?.state]) // eslint-disable-line react-hooks/exhaustive-deps
  const start = useAction(async () => {
    try {
      const body = proof === 'savedCode' ? { code: value } : proof === 'contact' ? { contactCode: value } : { password: value }
      const r = await api<{ requestId: string; availableAt: number; finishBy: number; finishKey: string }>('POST', '/api/auth/recovery/link/start', { token, ...body })
      setValue('')
      if (st) keepKey({ requestId: r.requestId, handle: st.handle, finishKey: r.finishKey, finishBy: r.finishBy })
      setSpent(r.finishKey)
      // the link is spent: what it shows now comes from the answer (asking with it again would be refused)
      if (st) setSt({ state: 'waiting', handle: st.handle, requestId: r.requestId, startedAt: Date.now(), availableAt: r.availableAt, finishBy: r.finishBy, expiresAt: 0 })
    } catch (e) { if (e instanceof ApiError && e.code.startsWith('link_')) setGone(e); throw e }
  })
  const kept = st && st.state !== 'start' ? keyFor(st.requestId) : ''
  const finish = useAction(async () => {
    if (!st || st.state === 'start') return
    try { const c = await finishRecoveryWithLink(token, kept || typedKey); dropKey(st.requestId); setCodes(c) }
    catch (e) { if (e instanceof ApiError && (e.code.startsWith('link_') || e.code === 'recovery_unavailable' || e.code === 'recovery_lapsed' || e.code === 'recovery_cancelled')) setGone(e); throw e }
  })
  const h = useFocusHeading(codes ? 'done' : gone ? 'gone' : st?.state ?? 'wait')
  if (codes) return <RecoveredStep codes={codes} onDone={() => { navigate('/', true); void reload() }} />
  if (gone) return <Solo><LinkGone error={gone} again="/?help=recover" againLabel="Ask for a new link" /></Solo>
  if (!st) return <Solo><p className="loading-line" aria-busy="true">Checking the link…</p></Solo>
  if (st.state === 'codes') return (
    <Solo>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h1 className="access-title" ref={h} tabIndex={-1}>A recovery with saved codes is under way</h1>
        <p className="muted">For the account @{st.handle}. Started {fmt.dayTime(st.startedAt)}; it can be finished from {fmt.full(st.availableAt)}.</p>
      </div>
      <div role="status"><Note tone="wait">It was started with saved codes, not by email, so an email link cannot finish it. Finish it in the browser that started it, with its reference: "Lost your passkey?", then "Finish it here", on the sign-in page. If you did not start it, sign in with a passkey of yours and cancel it under Security and recovery.</Note></div>
      <div><Btn onClick={() => navigate('/?help=recover', true)}>Go to "Lost your passkey?"</Btn></div>
    </Solo>
  )
  if (st.state !== 'start') {
    const ready = !spent && (st.state === 'ready' || now >= st.availableAt)
    const over = !!spent && now >= st.availableAt
    const finishKey = kept || typedKey.trim()
    return (
      <Solo>
        <div className="stack" style={{ ['--gap' as string]: '8px' }}>
          <h1 className="access-title" ref={h} tabIndex={-1}>{ready ? 'Make your new passkey' : 'Your recovery is waiting'}</h1>
          <p className="muted">For the account @{st.handle}. Started {fmt.dayTime(st.startedAt)}.</p>
        </div>
        {ready ? <>
          <ol className="ax-steps" aria-label="What finishing does">
            <li className="done"><Check aria-hidden="true" /><span>The wait is over and nobody stopped the recovery.</span></li>
            <li className="now"><Fingerprint aria-hidden="true" /><span>This device makes a new passkey for the account and asks for {deviceWords()}. QED receives only the passkey's public key.</span></li>
            <li><KeyRound aria-hidden="true" /><span>The new passkey signs you in. Approving payments again takes one more request, which waits too.</span></li>
          </ol>
          {kept ? null : <>
            <Note tone="wait" title="This browser did not start this recovery">The link finishes a recovery only with the key kept by the browser that started it. Open this link in that browser, or enter the finishing key it showed.</Note>
            <Field label="Finishing key" error={finish.error?.fields.finishKey}>{(p) => <input {...p} className="input code" autoComplete="off" spellCheck={false} value={typedKey} onChange={(e) => setTypedKey(e.target.value)} />}</Field>
          </>}
          {!passkeysAvailable() ? <Note tone="wait">This browser cannot make passkeys. Open this link in a current Safari, Chrome, Edge or Firefox.</Note> : null}
          <Problem error={finish.error && !finish.error.fields.finishKey ? finish.error : null} />
          <Btn tone="fill" className="lg block" busy={finish.busy} disabled={!passkeysAvailable() || !finishKey} onClick={() => void finish.run()}><Fingerprint aria-hidden="true" />Create a new passkey on this device</Btn>
          <p className="small faint">It can be finished until {fmt.full(st.finishBy)}; after that it lapses and would have to start again.</p>
        </> : over ? <>
          <div role="status"><Note tone="ok" title="The wait is over">Open the newest message from QED, "Your QED recovery can be finished", in this browser: it keeps the key that, with that message's link, finishes the recovery. This link started it and is spent.</Note></div>
          <OutboxPointer />
          {spent ? <ShowKey finishKey={spent} /> : null}
        </> : <>
          <div role="status"><Note tone="wait" title={`It can be finished from ${fmt.full(st.availableAt)}`}>That is {fmt.rel(st.availableAt, now)}. Until then every signed-in device of the account, every confirmed email address and every recovery contact has been told, and any of them can stop it. Nothing more is needed from you now.</Note></div>
          <p className="muted">When the wait ends, QED emails you a new link to finish. Open it in {spent || kept ? 'this browser, which keeps the key that finishes the recovery' : 'the browser that started the recovery, which keeps the key that finishes it'}. This link shows the recovery until it expires; if it has, ask for a new one from "Lost your passkey?" on the sign-in page.</p>
          <OutboxPointer />
          {spent ? <ShowKey finishKey={spent} /> : null}
          <Btn onClick={() => void load()}><RefreshCw aria-hidden="true" />Check again</Btn>
        </>}
      </Solo>
    )
  }
  const proofs = st.proofs
  const options = ([['savedCode', 'One of your saved recovery codes', 'One of the codes you kept when the account was made, or after its last recovery.'], ['contact', 'A code from your recovery contact', 'Ask them on a call you make. They issue it from their own account, and it lasts a day.'], ['password', 'The account\'s password', 'If the account signs in with a password too.']] as const).filter(([k]) => proofs[k])
  const label = proof === 'savedCode' ? 'Saved recovery code' : proof === 'contact' ? 'Code from your recovery contact' : 'The account\'s password'
  const fieldError = start.error?.fields.code ?? start.error?.fields.contactCode ?? start.error?.fields.password
  return (
    <Solo>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h1 className="access-title" ref={h} tabIndex={-1}>Recover @{st.handle}</h1>
        <p className="muted">Your email is confirmed by this link. One more proof, obtained another way, starts the recovery. It then waits {recoveryWait(session.delays)} before you can make a new passkey, so that you, your devices and your recovery contacts can stop it if it is not you.</p>
      </div>
      {options.length === 0 ? <Note tone="void" title="QED cannot recover this account by email alone">It has no saved codes left, no recovery contact who can issue a code, and no password, and an email address is never enough on its own. If a device still holds one of its passkeys, sign in with it there.</Note> : (
        <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void start.run() }}>
          <fieldset className="choice method">
            <legend className="legend">Your second proof</legend>
            {options.map(([k, t, d]) => <label key={k}><input type="radio" name="proof" checked={proof === k} onChange={() => { setProof(k); setValue(''); start.clear() }} /><b>{t}</b><small>{d}</small></label>)}
          </fieldset>
          {proof === 'password'
            ? <PasswordField label={label} value={value} onChange={setValue} show={show} onShow={setShow} autoComplete="current-password" error={fieldError} />
            : <Field label={label} error={fieldError}>{(p) => <input {...p} className="input code" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />}</Field>}
          {start.error ? <Problem error={start.error} /> : null}
          <Btn tone="fill" className="block" type="submit" busy={start.busy} disabled={!value.trim()}>Start the recovery</Btn>
        </form>
      )}
      <p className="small faint">A recovered passkey signs you in. It approves no payment, instruction or wallet change until you ask for approval authority and that request waits too.</p>
    </Solo>
  )
}

function VerifyEmailPage() {
  const { session } = useSession()
  const token = useLinkToken()
  const [done, setDone] = useState<{ address: string; usableFrom: number | null } | null>(null)
  const [gone, setGone] = useState<ApiError | null>(null)
  const confirm = useAction(async () => {
    try { setDone(await api<{ address: string; usableFrom: number | null }>('POST', '/api/auth/email/confirm', { token })) }
    catch (e) { if (e instanceof ApiError && e.code.startsWith('link_')) setGone(e); throw e }
  })
  const h = useFocusHeading(done ? 'done' : gone ? 'gone' : 'ask')
  if (gone) return <Solo><LinkGone error={gone} again={session.authenticated ? '/security#addresses' : '/'} againLabel={session.authenticated ? 'Add the address again' : 'Go to sign in'} /></Solo>
  if (done) return (
    <Solo>
      <h1 className="access-title" ref={h} tabIndex={-1}>Email address confirmed</h1>
      <div role="status"><Note tone="ok" title={done.address}>It receives your security notices from now on.{done.usableFrom ? ` It can start a password reset or a recovery from ${fmt.full(done.usableFrom)}: a new address waits, so that someone who adds theirs cannot use it at once.` : ''}</Note></div>
      <div><Btn tone="fill" onClick={() => navigate(session.authenticated ? '/security' : '/', true)}>{session.authenticated ? 'Back to Security and recovery' : 'Go to sign in'}</Btn></div>
    </Solo>
  )
  return (
    <Solo>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <h1 className="access-title" ref={h} tabIndex={-1}>Confirm this email address</h1>
        <p className="muted">Confirming lets QED send this address your security notices and, after a protection delay, a way back in. Confirm only if you asked for it.</p>
      </div>
      <Problem error={confirm.error && !confirm.error.code.startsWith('link_') ? confirm.error : null} />
      <Btn tone="fill" className="block" busy={confirm.busy} disabled={!token} onClick={() => void confirm.run()}><Mail aria-hidden="true" />Confirm the address</Btn>
    </Solo>
  )
}

interface OutboxMessage { id: string; channel: 'email' | 'sms'; to: string; purpose: string; subject: string; body: string; createdAt: number; status: string }

/** Turn the links in a simulated message into links, so that a tester can open them; everything else stays text. */
function withLinks(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part}>{part}</a> : part))
}

/**
 * The local test outbox's developer page. It says first, and on every message, that nothing was sent: QED in this
 * build has no email or text-message provider. Each message is what would have been sent, for testing on this computer.
 */
function OutboxPage() {
  const v = useData<{ notice: string; messages: OutboxMessage[] }>('/api/dev/outbox?limit=80')
  const [q, setQ] = useState('')
  useEffect(() => { const t = setInterval(v.reload, 3000); return () => clearInterval(t) }, [v.reload])
  const list = (v.data?.messages ?? []).filter((m) => !q.trim() || m.to.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <main className="outbox" id="content">
      <header className="outbox-head">
        <span className="brand"><Logo /><b>QED</b></span>
        <span className="practice-chip">Developer page</span>
      </header>
      <section className="outbox-intro" aria-labelledby="ob-h">
        <h1 id="ob-h">Simulated outbox</h1>
        <p className="outbox-banner" role="note"><b>Simulated delivery: no email or text message was sent.</b> This build of QED has no email or text-message provider. Each message it would have sent is kept here instead, for testing on this computer. Sending real messages needs a provider account, its credentials and the owner's approval.</p>
        <div className="row">
          <Field label="Filter by address">{(p) => <input {...p} className="input" type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          <Btn onClick={() => v.reload()}><RefreshCw aria-hidden="true" />Refresh</Btn>
        </div>
      </section>
      {v.error ? <Problem error={v.error} /> : !v.data ? <p className="loading-line" aria-busy="true">Reading the outbox…</p> : list.length === 0 ? <p className="muted">No simulated messages{q ? ' to that address' : ' yet'}.</p> : (
        <ol className="outbox-list" aria-label="Simulated messages, newest first">
          {list.map((m) => (
            <li key={m.id}>
              <article className="outbox-msg" aria-label={`Simulated ${m.channel === 'email' ? 'email' : 'text message'} to ${m.to}, not sent: ${m.subject}`}>
                <p className="outbox-tag"><span>{m.channel === 'email' ? 'Simulated email' : 'Simulated text message'}</span><span>Not sent</span></p>
                <h2>{m.subject}</h2>
                <dl className="kv small"><dt>To</dt><dd>{m.to}</dd><dt>Kept</dt><dd>{fmt.full(m.createdAt)}</dd></dl>
                <p className="outbox-body">{withLinks(m.body)}</p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}

// ------------------------------------------------------------------------------------------------ from the sign-in page

/** "Forgotten your password?": a link by email sets a new one. Said apart from recovering an account. */
export function ForgotPassword({ onBack, onRecover }: { onBack: () => void; onRecover: () => void }) {
  const { session } = useSession()
  const [id, setId] = useState(''), [sent, setSent] = useState<string | null>(null)
  const ask = useAction(async () => { await api('POST', '/api/auth/password/forgot', { identifier: id }); setSent(id.trim()) })
  const h = useFocusHeading(sent)
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <button type="button" className="back-link" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back to sign in</button>
      <h2 className="access-title" ref={h} tabIndex={-1}>Reset your password</h2>
      {session.delivery === 'none' ? <>
        <NoDelivery what="reset" />
        <div><Btn tone="fill" onClick={onRecover}>Recover with your saved codes</Btn></div>
      </> : sent ? <>
        <div role="status"><Sent what="reset" typed={sent} /></div>
        <OutboxPointer />
        <p className="small muted">No message? An account that has a passkey is told to sign in with it instead. An account with no confirmed email address cannot reset its password: <button type="button" className="linkish" onClick={onRecover}>recover the account</button> with a saved code and a recovery contact.</p>
        <div><Btn onClick={() => { setSent(null); ask.clear() }}>Use another handle or address</Btn></div>
      </> : (
        <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void ask.run() }}>
          <p className="muted">For an account that signs in with a password. Enter its handle or its confirmed email address, such as a Gmail address; a link to set a new password goes to that email.</p>
          <Field label="Handle or email address">{(p) => <input {...p} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} />}</Field>
          <Problem error={ask.error} />
          <Btn tone="fill" className="block" type="submit" busy={ask.busy} disabled={!id.trim()}>Email me a reset link</Btn>
          <p className="small faint">A new password signs out every session. It never approves a payment: that always takes a passkey.</p>
        </form>
      )}
    </div>
  )
}

interface Pending { handle: string; reference: string; availableAt: number }
const REFS = 'qed-recovery-refs'
function pendingRefs(): Pending[] { try { const v = JSON.parse(localStorage.getItem(REFS) ?? '[]') as unknown; return Array.isArray(v) ? (v as Pending[]).filter((p) => typeof p?.reference === 'string') : [] } catch { return [] } }
function keepRef(p: Pending): void { try { localStorage.setItem(REFS, JSON.stringify([p, ...pendingRefs().filter((x) => x.reference !== p.reference)].slice(0, 5))) } catch { /* a private window: the reference is shown to keep instead */ } }
function dropRef(reference: string): void { try { localStorage.setItem(REFS, JSON.stringify(pendingRefs().filter((x) => x.reference !== reference))) } catch { /* nothing kept */ } }

/**
 * "Lost your passkey?": the recovery link by email first. Without access to that email, the backup path: a saved code
 * and a code from a recovery contact (or the password), whose reference this browser keeps so that finishing here needs
 * no copying; it is shown too, for finishing on another device.
 */
/**
 * A lost or stolen device: before (or instead of) recovering, a saved recovery code pauses QED from here (R12 task
 * comparison, T6-a and T6-d; server/stop-with-code.ts). It stops everything QED does on its own except protective
 * selling, opens no session, resumes nothing and moves no money, and the code still works for a recovery. The answer is
 * the same whether or not the handle and code matched, so this page says what happens if they did.
 */
function PauseWithCode() {
  const [handle, setHandle] = useState(''), [code, setCode] = useState('')
  const [asked, setAsked] = useState(false)
  const pause = useAction(async () => { await api('POST', '/api/auth/pause-with-code', { handle, code }); setAsked(true) })
  return (
    <details className="ax-pause">
      <summary>Lost or stolen device? Pause QED first, with a saved code</summary>
      {asked ? <div role="status"><Note tone="ok" title="If the handle and the code matched, QED is paused">It starts nothing on its own. Protective selling that runs without asking carries on; a protective instruction set to ask first still waits for a passkey approval before each sale. No one was signed in, nothing was resumed and no money moved, and the code still works for a recovery. To resume, sign in with a passkey. This page says the same whether or not they matched, so that it tells no one whether an account or a code exists.</Note></div> : (
        <form className="stack" style={{ ['--gap' as string]: '12px' }} onSubmit={(e) => { e.preventDefault(); void pause.run() }}>
          <p className="muted">Pausing stops every instruction of your own household starting a new run, except selling to protect your floor. It moves no money and opens no session. It does not sign the lost device out: from another device of yours, end its session and suspend its passkey under Security and recovery. Only a passkey can resume QED. Workspaces you belong to are paused from inside them.</p>
          <Field label="Handle">{(p) => <input {...p} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
          <Field label="One of your saved recovery codes">{(p) => <input {...p} className="input code" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
          {pause.error ? <Problem error={pause.error} /> : null}
          <div><Btn tone="void-fill" type="submit" busy={pause.busy} disabled={!handle.trim() || !code.trim()}>Pause QED</Btn></div>
        </form>
      )}
    </details>
  )
}

export function LostPasskey({ onBack, onRecovered }: { onBack: () => void; onRecovered: (codes: string[]) => void }) {
  const { session } = useSession()
  const now = useNow(1000)
  // With no way to send email here (review M4), the saved codes are the way in, offered first and said why.
  const noEmail = session.delivery === 'none'
  const [view, setView] = useState<'email' | 'codes' | 'finish'>(noEmail ? 'codes' : 'email')
  const [id, setId] = useState(''), [sent, setSent] = useState<string | null>(null)
  const [handle, setHandle] = useState(''), [code, setCode] = useState(''), [contactCode, setContactCode] = useState(''), [password, setPassword] = useState(''), [withPassword, setWithPassword] = useState(false), [show, setShow] = useState(false)
  const [started, setStarted] = useState<Pending | null>(null)
  const [reference, setReference] = useState(() => pendingRefs()[0]?.reference ?? '')
  const [copied, setCopied] = useState(false)
  const ask = useAction(async () => { await api('POST', '/api/auth/recovery/link', { identifier: id }); setSent(id.trim()) })
  const begin = useAction(async () => {
    const r = await startRecovery(handle, code, withPassword ? { password } : { contactCode })
    const p = { handle: handle.trim().toLowerCase().replace(/^@/, ''), reference: r.reference, availableAt: r.availableAt }
    keepRef(p); setStarted(p); setReference(p.reference)
  })
  const finish = useAction(async () => { const ref = started?.reference ?? reference; const codes = await finishRecovery(ref); dropRef(ref); onRecovered(codes) })
  const h = useFocusHeading(`${view}:${sent ?? ''}:${started?.reference ?? ''}`)
  const go = (v: typeof view) => { setView(v); ask.clear(); begin.clear(); finish.clear() }
  const waiting = started ? now < started.availableAt : false
  const kept = pendingRefs()
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <button type="button" className="back-link" onClick={view === 'email' || (noEmail && view === 'codes') ? onBack : () => go(noEmail ? 'codes' : 'email')}><ArrowLeft size={16} aria-hidden="true" />{view === 'email' || (noEmail && view === 'codes') ? 'Back to sign in' : noEmail ? 'Back to recovery with saved codes' : 'Back to recovery by email'}</button>
      <h2 className="access-title" ref={h} tabIndex={-1}>{view === 'email' ? 'Recover your account' : view === 'codes' ? 'Recover with your saved codes' : 'Finish your recovery'}</h2>
      {view !== 'finish' && !started ? <PauseWithCode /> : null}
      {noEmail && view === 'codes' && !started ? <NoDelivery what="recover" /> : null}

      {view === 'email' ? (sent ? <>
        <div role="status"><Sent what="recover" typed={sent} /></div>
        <OutboxPointer />
        <ol className="ax-steps" aria-label="What happens next">
          <li><Mail aria-hidden="true" /><span>Open the link, and give one more proof: a saved code, a code from your recovery contact, or your password.</span></li>
          <li><LifeBuoy aria-hidden="true" /><span>The recovery waits {recoveryWait(session.delays)}. Your devices, email addresses and recovery contacts are told and can stop it.</span></li>
          <li><Fingerprint aria-hidden="true" /><span>A new link lets you make a new passkey. It signs you in; approving payments again takes one more wait.</span></li>
        </ol>
        <div><Btn onClick={() => { setSent(null); ask.clear() }}>Use another handle or address</Btn></div>
      </> : (
        <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void ask.run() }}>
          <p className="muted">Lost every passkey, or the device that held them? QED emails a link to the address your account has confirmed, such as a Gmail address. It only sends to that address: it never needs to read your mailbox.</p>
          <Field label="Handle or email address">{(p) => <input {...p} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} />}</Field>
          <Problem error={ask.error} />
          <Btn tone="fill" className="block" type="submit" busy={ask.busy} disabled={!id.trim()}>Email me a recovery link</Btn>
        </form>
      )) : null}

      {view === 'codes' ? (started ? <>
        <div role="status"><Note tone="wait" title="If the handle and both codes were right, a recovery has started">It can be completed from {fmt.full(started.availableAt)}. Until then every signed-in session of the account, every recovery contact and every confirmed email address hears of it, and any of them can stop it.</Note></div>
        <p className="muted">This browser remembers the recovery, so you can finish it here. To finish on another device instead, keep this reference: only you have it.</p>
        <p className="code recovery-ref">{started.reference}</p>
        <div><Btn small onClick={() => void navigator.clipboard?.writeText(started.reference).then(() => setCopied(true)).catch(() => {})}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy the reference'}</Btn></div>
        <Problem error={finish.error} />
        <Btn tone="fill" className="block" busy={finish.busy} disabled={waiting} onClick={() => void finish.run()}>{waiting ? `Ready ${fmt.rel(started.availableAt, now)}` : 'Create a new passkey now'}</Btn>
      </> : (
        <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void begin.run() }}>
          <p className="muted">{noEmail ? 'Two codes obtained differently' : 'The backup way, without email: two codes obtained differently'}. One of your saved recovery codes, and a code from your recovery contact or, for an account with a password, that password.</p>
          <Field label="Handle">{(p) => <input {...p} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
          <Field label="Saved recovery code" hint="One of the codes shown when the account was made, or after its last recovery.">{(p) => <input {...p} className="input code" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
          {withPassword
            ? <PasswordField label="The account's password" value={password} onChange={setPassword} show={show} onShow={setShow} autoComplete="current-password" />
            : <Field label="Code from your recovery contact" hint="Ask them in person or on a call you make. They issue it after confirming with their own passkey; it lasts 24 hours.">{(p) => <input {...p} className="input code" autoComplete="off" value={contactCode} onChange={(e) => setContactCode(e.target.value)} />}</Field>}
          <p className="small"><button type="button" className="linkish" onClick={() => setWithPassword((v) => !v)}>{withPassword ? 'Use a code from a recovery contact instead' : 'My account has a password: use it instead'}</button></p>
          <Problem error={begin.error} />
          <Btn tone="fill" className="block" type="submit" busy={begin.busy}>Start recovery</Btn>
          <p className="small faint">A recovery waits {recoveryWait(session.delays)} before a new passkey can be added, and any of your passkeys or recovery contacts can stop it. A saved code alone cannot recover an account, and neither can QED: that is what stops someone who finds your codes.</p>
        </form>
      )) : null}

      {view === 'finish' ? (
        <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void finish.run() }}>
          <p className="muted">{kept.length ? 'This browser kept the recovery you started here.' : 'Paste the reference you were given when you started the recovery with your saved codes.'} Once its wait is over, this device makes the account's new passkey.</p>
          <Field label="Recovery reference">{(p) => <input {...p} className="input code" autoComplete="off" spellCheck={false} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          <Problem error={finish.error} />
          <Btn tone="fill" className="block" type="submit" busy={finish.busy} disabled={!reference.trim()}>Create a new passkey now</Btn>
        </form>
      ) : null}

      {noEmail && view === 'codes' && !started ? <div className="ax-other">
        <p className="small">Started one with saved codes? <button type="button" className="linkish" onClick={() => go('finish')}>Finish it here</button></p>
      </div> : null}
      {view === 'email' ? <div className="ax-other">
        <p className="small">No access to that email? <button type="button" className="linkish" onClick={() => go('codes')}>Use your saved codes instead</button></p>
        <p className="small">Started one with saved codes? <button type="button" className="linkish" onClick={() => go('finish')}>Finish it here</button></p>
        <p className="small faint">Signed in on another device? Suspend the lost device's passkey there, under Security and recovery: that takes effect at once.</p>
      </div> : null}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ after a recovery

/**
 * After a recovery: the person is signed in with a passkey that signs in only. What that means, the one step that
 * restores approval authority (it waits, and anyone of theirs can stop it), and the new saved codes if the recovery
 * spent one, offered rather than imposed.
 */
export function RecoveredStep({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { session } = useSession()
  const [asked, setAsked] = useState<{ effectiveAt: number } | null>(null)
  const [showCodes, setShowCodes] = useState(false), [copied, setCopied] = useState(false)
  const ask = useAction(async () => { setAsked(await requestAuthority()) })
  const h = useFocusHeading(asked ? 'asked' : 'back')
  const download = () => {
    const blob = new Blob([`QED recovery codes, made ${new Date().toISOString().slice(0, 10)}. Each works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'qed-recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="onboard">
      <main className="onboard-main" id="content">
        <section className="onboard-card stack" style={{ ['--gap' as string]: '18px' }}>
          <div className="onboard-icon"><ShieldCheck aria-hidden="true" /></div>
          <div className="stack" style={{ ['--gap' as string]: '8px' }}>
            <h1 ref={h} tabIndex={-1}>You are back in</h1>
            <p className="muted">Your new passkey signs you in to this account. To protect your money while a recovery could still have been someone else, it cannot approve payments, instructions or changes to your on-chain wallet yet.</p>
          </div>
          <ol className="ax-steps" aria-label="Approving payments again">
            <li className="done"><Check aria-hidden="true" /><span>Signed in with your new passkey.</span></li>
            <li className={asked ? 'done' : 'now'}><Fingerprint aria-hidden="true" /><span>{asked ? `Approval authority asked for: it is given ${fmt.full(asked.effectiveAt)}, unless it is stopped.` : 'Ask for approval authority with this passkey.'}</span></li>
            <li><LifeBuoy aria-hidden="true" /><span>It waits {authorityWait(session.delays)}. Your other devices, email addresses and recovery contacts are told, and any of them can stop it.</span></li>
            <li><KeyRound aria-hidden="true" /><span>Your on-chain wallet then accepts this passkey only under its own rules: its recovery key and its delay, or its other signers.</span></li>
          </ol>
          {asked ? <div role="status"><Note tone="ok" title="Asked">You can look at everything and prepare payments meanwhile. Security and recovery shows the request, and stops it if it was not you.</Note></div> : null}
          <Problem error={ask.error} />
          {codes.length ? (
            <div className="stack" style={{ ['--gap' as string]: '10px' }}>
              <p className="small"><b>Your saved recovery codes were replaced.</b> The recovery spent one, so every earlier code stopped working. These are kept only now.</p>
              {showCodes ? <>
                <ol className="codes" aria-label="Recovery codes">{codes.map((c) => <li key={c} className="code">{c}</li>)}</ol>
                <div className="row">
                  <Btn small onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true)).catch(() => {})}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy them'}</Btn>
                  <Btn small onClick={download}><Download aria-hidden="true" />Download as a text file</Btn>
                </div>
              </> : <div><Btn small onClick={() => setShowCodes(true)}>Show the new codes</Btn></div>}
            </div>
          ) : null}
          <div className="row">
            {asked ? null : <Btn tone="fill" className="lg" busy={ask.busy} onClick={() => void ask.run()}><Fingerprint aria-hidden="true" />Ask for approval authority</Btn>}
            <Btn className="lg" tone={asked ? 'fill' : undefined} onClick={onDone}>{asked ? 'Continue' : 'Later'}</Btn>
          </div>
        </section>
      </main>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ at sign-up

/**
 * The first way back in, offered at sign-up before the saved codes: an email address, confirmed by a link or a code.
 * Sending the confirmation is enough to continue; the address is used once it is confirmed.
 */
export function EmailSetup({ onSent }: { onSent: (address: string) => void }) {
  const { session } = useSession()
  const [address, setAddress] = useState(''), [sent, setSent] = useState<string | null>(null)
  const add = useAction(async () => { await api('POST', '/api/security/addresses', { kind: 'email', address }); setSent(address.trim()); onSent(address.trim()) })
  // With no way to send messages here (review M4), no address is offered: it could not be confirmed.
  if (session.delivery === 'none') return <NoDelivery what="address" />
  return (
    <section className="stack ax-email" style={{ ['--gap' as string]: '10px' }} aria-labelledby="ax-email-h">
      <h2 id="ax-email-h" className="ax-h2">Add an email address <span className="ax-rec">Recommended</span></h2>
      <p className="small muted">If you lose your devices, a link to this address starts getting you back in, with one more proof and a wait. Any ordinary address works, Gmail included.</p>
      {sent ? <div role="status"><Sent what="confirm" typed={sent} /><OutboxPointer /></div> : (
        <form className="ax-email-row" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
          <Field label="Email address" error={add.error?.fields.address}>{(p) => <input {...p} className="input" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
          <Btn type="submit" busy={add.busy} disabled={!address.trim()}>Send a confirmation</Btn>
        </form>
      )}
      {add.error && !add.error.fields.address ? <Problem error={add.error} /> : null}
    </section>
  )
}
