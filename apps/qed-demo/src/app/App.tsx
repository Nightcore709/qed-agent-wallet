/**
 * The application frame: sign-in and account creation, the first-run setup, and the shell every signed-in screen sits
 * in: the atmosphere, a glass bar with Ask at its centre, one frosted stage for the page, and a dock with the seven
 * sections (five on a phone, Ask in the middle). Design system "Meridian" (DESIGN.md).
 */
import {
  ArrowLeft, ArrowRight, Bell, Building2, ChartLine, Check, ChevronDown, ChevronRight, Fingerprint, HandCoins, House, KeyRound, ListChecks, LogOut, Menu,
  Monitor, Moon, PiggyBank, ReceiptText, Route, ShieldCheck, Sparkles, Sun, Users, Wallet, ArrowUpRight, FileText, Settings2, X,
} from 'lucide-react'
import { type ComponentType, lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { type Id, t, useT } from '../lib/i18n.ts'
import { api, ApiError, beginSignOut, endSignOut, fmt, handAsk, match, navigate, onSignedOut, setCsrf, setDisplayZone, setHomeCurrency, startLive, stopLive, useData, useLocation, useNow } from '../lib/core.ts'
import { addPasskey, beginGoogle, confirmWithPasskey, holdCodes, takeCodes, type DeviceCheck, deviceCheck, deviceWords, passkeyAutofillAvailable, passkeysAvailable, signIn, signInWithAutofill, signInWithPassword, signUp, signUpWithEmail, stopAutofill } from '../lib/passkey.ts'
import { DEVICE_SIGN_IN, NO_DEVICE_CHECK, NO_PASSKEYS_AT_ALL, ORDINARY_SIGN_IN_LIMIT } from '../../shared/access-operations.ts'
import { outboxWords } from '../../shared/delivery-words.ts'
import { homeCurrency } from '../../shared/home-money.ts'
import { entryFormat } from '../lib/money-entry.ts'
import { Btn, Crumb, Field, Link, Loading, Logo, MoneyInput, Note, Orb, PasswordField, Problem, Seal, SectionNav, type SessionInfo, SessionCtx, Sheet, SourceNote, useAction, useSession, useStickySide } from '../ui/kit.tsx'
import { SavedCodes } from '../ui/SavedCodes.tsx'
import { applyFx, type Fx, readFx, setFx, useArrival, useDockIndicator, useSection } from '../ui/motion.ts'
import { HomeScreen } from '../screens/Home.tsx'

/**
 * Every screen but Home is fetched when it is first opened (and, once Home has drawn and the browser is idle, ahead of
 * time): a phone on a slow link downloads only the shell and Home before it can show the money (R11 perf, the phone
 * profile). Each is a named export, wrapped for React.lazy.
 */
const named = <M, K extends keyof M>(load: () => Promise<M>, key: K) => lazy(async () => ({ default: (await load())[key] as unknown as ComponentType<Record<string, unknown>> }))
const LOADERS: (() => Promise<unknown>)[] = []
function screen<M, K extends keyof M>(load: () => Promise<M>, key: K) { LOADERS.push(load); return named(load, key) as unknown as M[K] }
const ActivityScreen = screen(() => import('../screens/Activity.tsx'), 'ActivityScreen')
/**
 * Getting back in (R12): resetting a password, recovering an account, the step after a recovery, the pages a message's
 * link opens and the developer outbox. Fetched only when one is opened (src/app/Access.tsx).
 */
const accessMod = () => import('./Access.tsx')
const ForgotPassword = lazy(async () => ({ default: (await accessMod()).ForgotPassword }))
const LostPasskey = lazy(async () => ({ default: (await accessMod()).LostPasskey }))
const RecoveredStep = lazy(async () => ({ default: (await accessMod()).RecoveredStep }))
const AccessPage = lazy(async () => ({ default: (await accessMod()).AccessPage }))
// the pause sheet's "Also pause the on-chain wallet": the wallet page's code, fetched only when asked for
const WalletPauseNow = lazy(async () => ({ default: (await import('../ui/wallet-pause.tsx')).WalletPauseNow }))
/** The pages a message's link opens, and the developer outbox: drawn on their own, signed in or out. */
const ACCESS_PATHS = ['/reset-password', '/recover', '/verify-email', '/dev/outbox', '/auth/google/callback']
const EvidenceCaseScreen = screen(() => import('../screens/Evidence.tsx'), 'EvidenceCaseScreen')
const EvidenceListScreen = screen(() => import('../screens/Evidence.tsx'), 'EvidenceListScreen')
// the judge's walk-through (Topic F, R11-018): on demand only, not fetched ahead with the everyday screens
const JudgeScreen = named(() => import('../screens/Judge.tsx'), 'JudgeScreen')
const ProtectScreen = screen(() => import('../screens/Protect.tsx'), 'ProtectScreen')
const SaveScreen = screen(() => import('../screens/Save.tsx'), 'SaveScreen')
const AskScreen = screen(() => import('../screens/Ask.tsx'), 'AskScreen')
const ComposeScreen = screen(() => import('../screens/Compose.tsx'), 'ComposeScreen')
const EarnScreen = screen(() => import('../screens/Earn.tsx'), 'EarnScreen')
const BountiesScreen = screen(() => import('../screens/Bounties.tsx'), 'BountiesScreen')
const HoldingsScreen = screen(() => import('../screens/Holdings.tsx'), 'HoldingsScreen')
const LabScreen = screen(() => import('../screens/Lab.tsx'), 'LabScreen')
const IdeaScreen = screen(() => import('../screens/Idea.tsx'), 'IdeaScreen')
const IdeaRecordScreen = screen(() => import('../screens/Idea.tsx'), 'IdeaRecordScreen')
const InstructionScreen = screen(() => import('../screens/Instructions.tsx'), 'InstructionScreen')
const InstructionsScreen = screen(() => import('../screens/Instructions.tsx'), 'InstructionsScreen')
const TaxScreen = screen(() => import('../screens/Tax.tsx'), 'TaxScreen')
const PassbookScreen = screen(() => import('../screens/Passbook.tsx'), 'PassbookScreen')
const PayScreen = screen(() => import('../screens/Pay.tsx'), 'PayScreen')
const RecordScreen = screen(() => import('../screens/Record.tsx'), 'RecordScreen')
const DisputePackScreen = screen(() => import('../screens/DisputePack.tsx'), 'DisputePackScreen')
const ReceiptScreen = screen(() => import('../screens/Record.tsx'), 'ReceiptScreen')
const SafeguardsScreen = screen(() => import('../screens/Safeguards.tsx'), 'SafeguardsScreen')
const ReadinessScreen = screen(() => import('../screens/Readiness.tsx'), 'ReadinessScreen')
const SecurityScreen = screen(() => import('../screens/Security.tsx'), 'SecurityScreen')
const WorkspaceScreen = screen(() => import('../screens/Workspace.tsx'), 'WorkspaceScreen')
const DeskScreen = screen(() => import('../screens/Desk.tsx'), 'DeskScreen')
const NotificationsScreen = screen(() => import('../screens/Notifications.tsx'), 'NotificationsScreen')
const VaultJobScreen = screen(() => import('../screens/Vault.tsx'), 'VaultJobScreen')
const VaultScreen = screen(() => import('../screens/Vault.tsx'), 'VaultScreen')
/**
 * Fetch the other screens ahead of time, but only well after the page has drawn and its data arrived (6 s after load,
 * then when idle), one at a time, and never on Save-Data or a 2G or 3G link: fetched early they competed with the open
 * screen's own requests on a slow link (R11 perf, the phone profile: Spend's LCP 3.9 s).
 */
/**
 * The session check, sent first, before the opened screen's code (BOOT, below). A browser keeps six connections to one
 * server and the screen's code is a dozen files: sent after them, the check waited for a free connection, and the shell,
 * the live stream and the screen's data waited with it (R12, Protect on the phone profile: the check answered 0.2 s
 * later than on R11, and the stream's first hello then came after the page's reads had gone out and reloaded them all).
 * It is the request App sends when it starts; App takes this answer once, and asks again on every later check.
 */
let firstSession: Promise<SessionInfo> | null = typeof location !== 'undefined' ? api<SessionInfo>('GET', '/api/session') : null
firstSession?.catch(() => {}) // a failure is reported where App reads it
/**
 * The screen opened first, asked for at once, in parallel with the session check (R11, RISK-086: on the phone profile
 * each screen's code waited for the session check, and its figure for the code). Only code, which is the same for
 * everyone: asking for the screen's data before the session is known made signed-out visits log refused requests, and
 * asking for other screens' data early competed with their code on a slow link (both measured and refused, 24 Nov).
 */
const BOOT: { test: (p: string) => boolean; load: () => Promise<unknown> }[] = [
  { test: (p) => p.startsWith('/pay'), load: () => import('../screens/Pay.tsx') },
  { test: (p) => p.startsWith('/save'), load: () => import('../screens/Save.tsx') },
  { test: (p) => p.startsWith('/holdings/lab'), load: () => import('../screens/Lab.tsx') },
  { test: (p) => p.startsWith('/workspace/desk'), load: () => import('../screens/Desk.tsx') },
  { test: (p) => p.startsWith('/holdings/idea'), load: () => import('../screens/Idea.tsx') },
  { test: (p) => p.startsWith('/holdings'), load: () => import('../screens/Holdings.tsx') },
  { test: (p) => p.startsWith('/protect'), load: () => import('../screens/Protect.tsx') },
  { test: (p) => p.startsWith('/activity'), load: () => import('../screens/Activity.tsx') },
  { test: (p) => p.startsWith('/earn/bounties'), load: () => import('../screens/Bounties.tsx') },
  { test: (p) => p.startsWith('/earn'), load: () => import('../screens/Earn.tsx') },
  { test: (p) => p.startsWith('/ask'), load: () => import('../screens/Ask.tsx') },
  { test: (p) => p.startsWith('/vault'), load: () => import('../screens/Vault.tsx') },
]
if (typeof location !== 'undefined') void BOOT.find((b) => b.test(location.pathname))?.load().catch(() => {})

let prefetched = false
function prefetchScreens(): void {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  if (prefetched || nav.connection?.saveData || /(^|-)2g$|^3g$/.test(nav.connection?.effectiveType ?? '')) return
  prefetched = true
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 5000 }) : setTimeout(cb, 500))
  const next = (i: number) => { if (i < LOADERS.length) idle(() => { void LOADERS[i]!().catch(() => {}).finally(() => next(i + 1)) }) }
  const start = () => setTimeout(() => next(0), 6000)
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true })
}

type Icon = typeof House
interface NavItem { to: string; label: Id; icon: Icon; on: (p: string) => boolean }
/**
 * The seven sections, in the order a person meets their money: the overview, the five things money does, and the record.
 * Ask is not a section: it is docked on every page (wide screens) or the middle tab (narrow ones). The on-chain wallet's
 * own pages sit under Protect (set-up, mandate, signers, records); it is used from the everyday pages (D-080).
 */
const NAV: NavItem[] = [
  { to: '/', label: 'nav.home', icon: House, on: (p) => p === '/' },
  { to: '/pay', label: 'nav.spend', icon: ArrowUpRight, on: (p) => p.startsWith('/pay') },
  { to: '/save', label: 'nav.save', icon: PiggyBank, on: (p) => p.startsWith('/save') },
  { to: '/holdings', label: 'nav.grow', icon: ChartLine, on: (p) => p.startsWith('/holdings') },
  { to: '/earn', label: 'nav.earn', icon: HandCoins, on: (p) => p.startsWith('/earn') },
  { to: '/protect', label: 'nav.protect', icon: ShieldCheck, on: (p) => ['/protect', '/instructions', '/safeguards', '/security', '/workspace', '/readiness', '/vault', '/notifications'].some((x) => p.startsWith(x)) },
  { to: '/activity', label: 'nav.activity', icon: ReceiptText, on: (p) => ['/activity', '/record', '/receipts', '/passbook', '/tax', '/evidence', '/judge'].some((x) => p.startsWith(x)) },
]
const ASK_TAB: NavItem = { to: '/ask', label: 'nav.ask', icon: Sparkles, on: (p) => p.startsWith('/ask') }
/** The pages inside Protect and Activity, drawn as tabs at the top of each of their pages. */
const SECTIONS: { label: Id; on: (p: string) => boolean; items: { to: string; label: Id; on: (p: string) => boolean }[] }[] = [
  { label: 'nav.protectPages', on: NAV[5]!.on, items: [
    { to: '/protect', label: 'nav.overview', on: (p) => p === '/protect' },
    { to: '/instructions', label: 'nav.instructions', on: (p) => p.startsWith('/instructions') },
    { to: '/vault', label: 'nav.onchainWallet', on: (p) => p.startsWith('/vault') },
    { to: '/security', label: 'nav.security', on: (p) => p.startsWith('/security') },
    { to: '/workspace', label: 'nav.workspace', on: (p) => p === '/workspace' },
    { to: '/workspace/desk', label: 'nav.desk', on: (p) => p.startsWith('/workspace/desk') },
    { to: '/safeguards', label: 'nav.safeguards', on: (p) => p.startsWith('/safeguards') },
    { to: '/notifications', label: 'nav.notifications', on: (p) => p.startsWith('/notifications') },
    { to: '/readiness', label: 'nav.thisBuild', on: (p) => p.startsWith('/readiness') },
  ] },
  { label: 'nav.activityPages', on: NAV[6]!.on, items: [
    { to: '/activity', label: 'nav.activity', on: (p) => ['/activity', '/record', '/receipts'].some((x) => p.startsWith(x)) },
    { to: '/passbook', label: 'nav.statement', on: (p) => p.startsWith('/passbook') },
    { to: '/tax', label: 'nav.tax', on: (p) => p.startsWith('/tax') },
    { to: '/evidence', label: 'nav.evidence', on: (p) => p.startsWith('/evidence') || p.startsWith('/judge') },
  ] },
]

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const first = firstSession
    firstSession = null
    try { const s = await (first ?? api<SessionInfo>('GET', '/api/session')); if (s.csrf) setCsrf(s.csrf); if (s.authenticated) endSignOut(); setDisplayZone(s.profile?.timeZone); setHomeCurrency(s.homeCurrency); setSession(s); setFailed(null) }
    catch (e) { setFailed(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => onSignedOut(() => { void reload() }), [reload])
  useEffect(() => { if (session?.authenticated && session.setup) { startLive(); return () => stopLive() } return undefined }, [session?.authenticated, session?.setup])
  useTheme()

  if (failed && !session) return (
    <><Atmosphere /><main className="solo"><div className="solo-card stack" style={{ ['--gap' as string]: '16px' }}>
      <Brand /><h1>QED is not answering</h1><Note tone="void">{failed}</Note>
      <p className="muted">Start the two services in a terminal, then reload this page.</p><div><Btn tone="fill" onClick={() => void reload()}>Try again</Btn></div>
    </div></main></>
  )
  if (!session) return <><Atmosphere /><main className="solo"><Loading what="Opening QED" /></main></>
  return (
    <SessionCtx.Provider value={{ session, reload }}>
      <Atmosphere />
      <AppBody />
    </SessionCtx.Provider>
  )
}

function AppBody() {
  const { session } = useSession()
  const { path } = useLocation()
  if (ACCESS_PATHS.includes(path)) return <Suspense fallback={<main className="solo"><Loading what="Opening the page" /></main>}><AccessPage path={path} /></Suspense>
  return !session.authenticated ? <Welcome /> : !session.setup ? <BeforeSetup /> : <Shell />
}

/**
 * The atmosphere behind every screen (base.css): three lights and the meridian, an arc of light on the horizon. It
 * carries no information and is hidden from assistive technology.
 */
function Atmosphere() {
  return (
    <div className="atmos" aria-hidden="true">
      <i className="lc" /><i className="la" /><i className="lb" />
      <svg className="meridian" viewBox="0 0 1600 400" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="mer-line" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--meridian)" stopOpacity="0" />
            <stop offset=".5" stopColor="var(--meridian)" stopOpacity="1" />
            <stop offset="1" stopColor="var(--meridian)" stopOpacity="0" />
          </linearGradient>
          <filter id="mer-glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="9" /></filter>
        </defs>
        <g className="arc">
          <path d="M-40 390 Q800 -10 1640 390" stroke="url(#mer-line)" strokeWidth="10" fill="none" filter="url(#mer-glow)" opacity=".7" />
          <path d="M-40 390 Q800 -10 1640 390" stroke="url(#mer-line)" strokeWidth="1.4" fill="none" />
        </g>
      </svg>
      <div className="grain" />
    </div>
  )
}

/** The wordmark: the mark, then the name. */
function Brand({ to }: { to?: string }) {
  const inner = <><Logo /><b>QED</b></>
  return to ? <Link to={to} className="brand">{inner}</Link> : <span className="brand">{inner}</span>
}

// ------------------------------------------------------------------------------------------------ appearance
type Theme = 'system' | 'light' | 'dark'
const readTheme = (): Theme => { try { const t = localStorage.getItem('qed-theme'); return t === 'light' || t === 'dark' ? t : 'system' } catch { return 'system' } }
function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  // The browser bar follows the person's own choice too, not only the system's (index.html carries the system pair).
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const light = m.media.includes('light')
    m.content = t === 'system' ? (light ? '#F4EEE6' : '#070604') : t === 'light' ? '#F4EEE6' : '#070604'
  })
}
function useTheme(): void { useEffect(() => { applyTheme(readTheme()); applyFx() }, []) }

// ------------------------------------------------------------------------------------------------ sign-in and account creation

/**
 * Signing in and opening an account (R14, Priority 1): one screen, with the ordinary ways first.
 *
 *   Sign in            email (or handle) and password; or the device ("your fingerprint, Face ID or device PIN", a passkey);
 *                      or Google, rendered only where this installation has it configured. Phone sign-in has no provider
 *                      here, so nothing is shown for it.
 *   Create an account  name, email and password; or Google; or, for someone who wants no password, a passkey.
 *
 * Signing in is one of five separate operations (shared/access-operations.ts): it lets a person look and prepare. The
 * page says so, and says where money is approved: on the device.
 */
function Welcome() {
  const { session, reload } = useSession()
  const { query } = useLocation()
  // "?help=recover" or "?help=forgot" (a message's "ask for a new link") opens that journey at once
  const [mode, setMode] = useState<'in' | 'new' | 'new-passkey' | 'forgot' | 'recover'>(() => (query.get('help') === 'recover' ? 'recover' : query.get('help') === 'forgot' ? 'forgot' : 'in'))
  const [id, setId] = useState(''), [email, setEmail] = useState(''), [handle, setHandle] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  // after a recovery: the step that says the new passkey signs in only, and how approving comes back (R12)
  const [recovered, setRecovered] = useState<string[] | null>(null)
  const supported = passkeysAvailable()
  const check = useDeviceCheck()
  const google = session.signIn?.google ?? false
  const signin = useAction(async () => { await signIn(); await reload() })
  const byPassword = useAction(async () => { await signInWithPassword(id, password); await reload() })
  const signup = useAction(async () => { await signUpWithEmail(email, name, password, handle); await reload() })
  // an account opened with a passkey has its device from the start: the next screen says so, and offers a way back in
  const signupPasskey = useAction(async () => { await signUp(handle, name); justEnrolled(true); await reload() })
  const withGoogle = useAction(async () => { await beginGoogle('signin') })
  const f = { ...(signup.error?.fields ?? {}), ...(signupPasskey.error?.fields ?? {}), ...(byPassword.error?.fields ?? {}) }
  const go = (m: typeof mode) => { setMode(m); signin.clear(); signup.clear(); signupPasskey.clear(); byPassword.clear(); withGoogle.clear(); if (query.get('help')) navigate('/', true) }
  // On the sign-in form the first field also offers this device's passkeys for QED (the browser's own suggestions):
  // choosing one signs in with no further step. Pressing the button instead replaces this request; leaving the form ends it.
  useEffect(() => {
    // The browser suite's virtual authenticators answer this request with no person present, which would sign a journey
    // in before it presses anything: the suite's authenticator helper opts its pages out (qedTestAutofill = false), and
    // the one journey about autofill opts back in. Nobody else sets the flag.
    const optedOut = (window as unknown as { qedTestAutofill?: boolean }).qedTestAutofill === false
    if (mode !== 'in' || !supported || optedOut) return undefined
    let live = true
    void passkeyAutofillAvailable().then((ok) => { if (ok && live) signInWithAutofill().then(() => reload()).catch(() => { /* replaced, closed or expired: the button still works */ }) })
    return () => { live = false; stopAutofill() }
  }, [mode, supported, reload])

  if (recovered) return <Suspense fallback={<main className="solo"><Loading what="Opening" /></main>}><RecoveredStep codes={recovered} onDone={() => void reload()} /></Suspense>

  // rendered only where this installation has Google configured; inside .access-act so a wrapped label keeps its mark beside it
  const googleButton = google ? (
    <div className="access-act"><Btn className="lg block" busy={withGoogle.busy} onClick={() => void withGoogle.run()}><GoogleMark />Continue with Google{google === 'stand-in' ? ' (test stand-in)' : ''}</Btn></div>
  ) : null
  const creating = mode === 'new' || mode === 'new-passkey'
  return (
    <>
      <PresentationBanner />
      <div className="welcome">
        <section className="welcome-field" aria-labelledby="pitch-h">
          <div className="welcome-brand"><Brand /><span className="practice-chip">Practice money</span></div>
          <div className="welcome-pitch">
            <h1 id="pitch-h">Money that moves <span className="dim">only with proof.</span></h1>
            <p>QED pays, saves, invests and earns for you within limits you sign. Code the assistant cannot change enforces every limit, and every action keeps who did it, why, and the checks it passed.</p>
          </div>
          <Vignette />
          <p className="welcome-fine">Examples. This build uses practice money: paper balances, valueless test tokens on a chain on this computer, and live market prices.</p>
        </section>

        <main className="welcome-access" id="content">
          <div className="access">
            {mode === 'in' || creating ? <>
              <div className="seg access-seg" role="group" aria-label="Sign in or create an account">
                <button type="button" aria-pressed={mode === 'in'} onClick={() => go('in')}>Sign in</button>
                <button type="button" aria-pressed={creating} onClick={() => go('new')}>Create an account</button>
              </div>
              <h2 className="access-title">{mode === 'in' ? 'Sign in to QED' : mode === 'new' ? 'Create your account' : 'Create your account with a passkey'}</h2>
            </> : null}

            {mode === 'in' ? <div className="stack" style={{ ['--gap' as string]: '14px' }}>
              <form className="stack" style={{ ['--gap' as string]: '12px' }} onSubmit={(e) => { e.preventDefault(); void byPassword.run() }}>
                <Field label="Email or handle" error={f.handle}>{(p) => <input {...p} className="input" autoComplete="username webauthn" autoCapitalize="none" spellCheck={false} inputMode="email" value={id} onChange={(e) => setId(e.target.value)} />}</Field>
                <PasswordField value={password} onChange={setPassword} show={show} onShow={setShow} autoComplete="current-password" error={f.password} />
                {byPassword.error && !f.handle && !f.password ? <Problem error={byPassword.error} /> : null}
                <Btn tone="fill" type="submit" className="lg block" busy={byPassword.busy}>Sign in with your password</Btn>
              </form>
              <div className="or"><span>or</span></div>
              {/* the device, first-class beside the password: the button and what the device will ask for, read as one group */}
              <div className="access-act">
                <Btn className="lg block" busy={signin.busy} disabled={!supported} onClick={() => void signin.run()}><Fingerprint aria-hidden="true" />{DEVICE_SIGN_IN}</Btn>
                {!supported ? <p className="access-explain">{NO_PASSKEYS_AT_ALL}</p>
                  : check === 'other-device' ? <p className="access-explain">{NO_DEVICE_CHECK}</p>
                    : <p className="access-explain">For a device you have set up. It asks for {deviceWords()}; QED never receives it, only a signature.</p>}
              </div>
              <Problem error={signin.error} />
              {googleButton}
              <Problem error={withGoogle.error} />
              <div className="access-foot access-help">
                <p className="small muted">Forgotten your password? <button type="button" className="linkish" onClick={() => go('forgot')}>Reset your password</button></p>
                <p className="small muted">Lost your device? <button type="button" className="linkish" onClick={() => go('recover')}>Recover your account</button></p>
              </div>
              <p className="small faint">{ORDINARY_SIGN_IN_LIMIT}</p>
            </div> : null}

            {mode === 'new' ? <div className="stack" style={{ ['--gap' as string]: '14px' }}>
              <form className="stack" style={{ ['--gap' as string]: '12px' }} onSubmit={(e) => { e.preventDefault(); void signup.run() }}>
                <Field label="Name to sign with" hint="Shown as your signature on what you approve.">{(p) => <input {...p} className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                <Field label="Email" hint="You sign in with it. Others never see it." error={f.email}>{(p) => <input {...p} className="input" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
                <PasswordField value={password} onChange={setPassword} show={show} onShow={setShow} autoComplete="new-password" error={f.password} hint="At least 10 characters. A phrase of a few words works well." />
                <details className="access-more" open={!!f.handle || undefined}>
                  <summary>Choose your handle (optional)</summary>
                  <Field label="Handle" hint="The name others pay you with: 3 to 32 letters, digits, dots, dashes or underscores. Left empty, QED makes one from your name." error={f.handle}>{(p) => <input {...p} className="input" autoComplete="off" autoCapitalize="none" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
                </details>
                {signup.error && !f.handle && !f.password && !f.email ? <Problem error={signup.error} /> : null}
                <div className="access-act">
                  <Btn tone="fill" className="lg block" type="submit" busy={signup.busy}>Create account</Btn>
                  <p className="access-explain">Next, you can set up your fingerprint, Face ID or device PIN for faster, more secure access. QED keeps your password in a form it cannot read back.</p>
                </div>
              </form>
              <div className="or"><span>or</span></div>
              {googleButton}
              <Problem error={withGoogle.error} />
              <div className="access-act">
                <Btn className="block" disabled={!supported} onClick={() => go('new-passkey')}><Fingerprint aria-hidden="true" />Use a passkey instead</Btn>
                <p className="access-explain">{supported ? 'No password: a passkey is your device\'s own fingerprint, Face ID or PIN check, kept for QED.' : NO_PASSKEYS_AT_ALL}</p>
              </div>
              <p className="small faint">{ORDINARY_SIGN_IN_LIMIT}</p>
            </div> : null}

            {mode === 'new-passkey' ? <form className="stack" style={{ ['--gap' as string]: '14px' }} onSubmit={(e) => { e.preventDefault(); void signupPasskey.run() }}>
              <button type="button" className="back-link" onClick={() => go('new')}><ArrowLeft size={16} aria-hidden="true" />Use an email and a password</button>
              <Field label="Handle" hint="3 to 32 letters, digits, dots, dashes or underscores. Others pay you with it." error={f.handle}>{(p) => <input {...p} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
              <Field label="Name to sign with" hint="Shown as your signature on what you approve.">{(p) => <input {...p} className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              {check === 'other-device' ? <Note tone="wait" title="No fingerprint, face or PIN check on this device">{NO_DEVICE_CHECK}</Note> : null}
              {signupPasskey.error && !f.handle ? <Problem error={signupPasskey.error} /> : null}
              <div className="access-act">
                <Btn tone="fill" className="lg block" type="submit" busy={signupPasskey.busy} disabled={!supported}><Fingerprint aria-hidden="true" />Create account with a passkey</Btn>
                <p className="access-explain">Your device makes a passkey for QED and asks for {deviceWords()}. QED never receives your face, fingerprint or PIN, only the passkey's public key. This account has no password.</p>
              </div>
            </form> : null}

            {mode === 'forgot' || mode === 'recover' ? <Suspense fallback={<Loading what="Opening" />}>
              {mode === 'forgot'
                ? <ForgotPassword onBack={() => go('in')} onRecover={() => go('recover')} />
                : <LostPasskey onBack={() => go('in')} onRecovered={(c: string[]) => setRecovered(c)} />}
            </Suspense> : null}
          </div>
        </main>
      </div>
    </>
  )
}

/**
 * A plain letter for Google's button. Before sign-in with Google is switched on with a real client, this button is to be
 * replaced by Google's own branded button, as its sign-in branding guidelines ask (design note, open items).
 */
function GoogleMark() {
  return <span className="g-mark" aria-hidden="true">G</span>
}

/** What this device can offer for "your fingerprint, Face ID or device PIN"; null until the browser has answered. */
function useDeviceCheck(): DeviceCheck | null {
  const [c, setC] = useState<DeviceCheck | null>(null)
  useEffect(() => { let live = true; void deviceCheck().then((v) => { if (live) setC(v) }); return () => { live = false } }, [])
  return c
}

/**
 * Whether a device was set up a moment ago in this tab (at sign-up with a passkey, or in the step after it): the next
 * screen then says it worked and offers a way back in, once. Kept for the tab, so a reload does not lose it.
 */
const ENROLLED_KEY = 'qed.enrolled'
function justEnrolled(set?: boolean): boolean {
  try {
    if (set === true) sessionStorage.setItem(ENROLLED_KEY, '1')
    if (set === false) sessionStorage.removeItem(ENROLLED_KEY)
    return sessionStorage.getItem(ENROLLED_KEY) === '1'
  } catch { return false }
}

/**
 * What QED shows, with example figures (labelled so): the position as Home draws it, free to use with the liquid bar
 * and QED's bracket over the free part, what is kept and what QED may move, one standing instruction with what is left
 * of its limit, and a receipt.
 */
function Vignette() {
  return (
    <figure className="vignette" aria-label="An example of what QED shows, with example figures">
      <div className="v-card">
        <div className="v-top"><p className="v-label">Free to use</p><span className="v-ex">Example household</span></div>
        <p className="v-figure">₹6,97,900<span className="paise">.00</span></p>
        <div className="v-bar" aria-hidden="true"><span className="free" style={{ width: '80%' }} /><span className="kept" style={{ width: '20%' }} /><span className="bound" style={{ left: '70.5%', width: '9.5%' }} /></div>
        <div className="v-tiles">
          <div><small>Kept for what is due</small><b>₹1,74,118</b></div>
          <div className="qed"><small>QED may move, 30 days</small><b>₹82,000</b></div>
        </div>
        <div className="v-lane"><div className="v-lt"><b>Pay bills up to ₹3,000 each</b><small>tells you first, then acts</small></div><div className="v-meter" aria-hidden="true"><i style={{ width: '64%' }} /></div><span className="v-left">₹6,400 left of ₹10,000 this month</span></div>
        <div className="v-receipt"><Seal size="lg" /><div><p className="v-title">Paid City Power ₹2,450</p><p className="v-sub">Under your bills instruction. 8 of 8 checks passed; receipt kept.</p></div></div>
      </div>
    </figure>
  )
}

/**
 * The address the account was opened with, and whether it is confirmed, said plainly (R14). Where this installation cannot
 * send email, it says that confirming is unavailable here and that the account works without it; it never says a message
 * was sent. With the local test outbox it says the message is kept there, not sent.
 */
function EmailLine() {
  const { session } = useSession()
  const e = session.email
  if (!e?.address || e.verified) return null
  if (!e.canVerify) return <div role="status"><Note tone="wait" title={`${e.address} is not verified`}>This build of QED cannot send email, so it cannot verify your address here. Your account works without it: you sign in with this address and your password. Nothing was sent to it.</Note></div>
  if (!e.pending) return <div role="status"><Note tone="wait" title={`${e.address} is not verified`}>Send its confirmation again under Security.</Note></div>
  const w = e.simulated ? outboxWords('confirm', e.address) : { title: `Confirm ${e.address}`, body: 'A message with a link is on its way to it. Until you open it, the address is not verified.' }
  return <div role="status"><Note tone="qed" title={w.title}>{w.body}{e.simulated ? <> <a href="/dev/outbox" target="_blank" rel="noopener">Open the simulated outbox</a>.</> : null}</Note></div>
}

/** The steps of opening an account, with where this person is. */
function OnboardTop({ step, skippedDevice }: { step: 'account' | 'device' | 'household' | null; skippedDevice?: boolean }) {
  const { session, reload } = useSession()
  const out = useAction(async () => { beginSignOut(); try { await api('POST', '/api/auth/logout') } catch (e) { endSignOut(); throw e } await reload(); navigate('/', true) })
  const order = ['account', 'device', 'household'] as const
  const at = step ? order.indexOf(step) : -1
  const label = { account: 'Your account', device: 'Your device', household: 'Your household' }
  return (
    <header className="onboard-top">
      <Brand />
      {step ? <ol className="steps" aria-label="Setting up">{order.map((s, i) => {
        const skipped = s === 'device' && skippedDevice && i < at
        return <li key={s} className={skipped ? 'skipped' : i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}><i aria-hidden="true">{skipped ? '–' : i < at ? <Check size={12} strokeWidth={3} /> : i + 1}</i><span className="step-name">{label[s]}{skipped ? ', later' : ''}</span></li>
      })}</ol> : <span />}
      {session.authenticated ? <span className="row onboard-who"><span className="small muted">Signed in as {session.user?.displayName}</span><Btn small tone="quiet" busy={out.busy} onClick={() => void out.run()}>Sign out</Btn></span> : <span />}
    </header>
  )
}

/**
 * Before the household is opened, the account still has its security screen, a way to sign out, and the warning about
 * a recovery somebody started: an account with nothing set up is still an account someone may be trying to take.
 *
 * After an account is opened (R14): one optional step offers the device, "Use your fingerprint, Face ID or device PIN
 * for faster, more secure access"; when a device has just been set up, one screen says so and offers a way back in
 * (saved recovery codes, made only if asked for). Nothing here is a wall: each can be left for later.
 */
function BeforeSetup() {
  const { session } = useSession()
  const { path } = useLocation()
  const [later, setLater] = useState(false)
  const [enrolled, setEnrolled] = useState(() => justEnrolled())
  const needsDevice = !session.hasPasskey && !later
  const showEnrolled = !!session.hasPasskey && enrolled
  return (
    <div className="onboard">
      <PresentationBanner />
      <RecoveryBanner />
      <AuthorityBanner />
      <OnboardTop step={needsDevice || showEnrolled ? 'device' : 'household'} skippedDevice={!session.hasPasskey} />
      {path === '/security'
        ? <main className="main" id="content"><Crumb to="/">Back to setting up</Crumb><Suspense fallback={<Loading what="Opening security" />}><SecurityScreen /></Suspense></main>
        : needsDevice ? <DeviceStep onLater={() => setLater(true)} onDone={() => { justEnrolled(true); setEnrolled(true) }} />
          : showEnrolled ? <DeviceReady onDone={() => { justEnrolled(false); setEnrolled(false) }} />
            : <Setup />}
    </div>
  )
}

/**
 * The step after an ordinary sign-up: set up device sign-in for faster, more secure access, or leave it for later. (The
 * button does not say "this device": the browser also offers a phone nearby or a security key, and QED does not tie a passkey to one.) Enrolling
 * a device is its own operation: the server takes the password typed in the last five minutes (the sign-up's own counts),
 * or Google confirmed again, for the account's first device only.
 */
function DeviceStep({ onLater, onDone }: { onLater: () => void; onDone: () => void }) {
  const { t } = useT()
  const { session, reload } = useSession()
  const check = useDeviceCheck()
  // The password typed at sign-up unlocks this for five minutes; after that, or after signing in again with the
  // password, the server asks for it once more (the review of D-094, M4). An account Google signs in to confirms with Google.
  const [askPw, setAskPw] = useState(false), [askGoogle, setAskGoogle] = useState(false), [pw, setPw] = useState(''), [show, setShow] = useState(false)
  const add = useAction(async () => {
    if (askPw) await api('POST', '/api/auth/stepup', { password: pw })
    try { const made = await addPasskey(); holdCodes(made.recoveryCodes, made.replacedEarlier === true) }
    catch (e) {
      if (e instanceof ApiError && e.code === 'stepup_required') {
        if (session.hasPassword === false) { setAskGoogle(true); throw new ApiError(401, 'stepup_required', 'Confirm with Google again, then set up your device: a device is set up only right after you have signed in.') }
        setAskPw(true); throw new ApiError(401, 'stepup_required', t('passkey.stepup'))
      }
      throw e
    }
    setPw(''); onDone(); await reload()
  })
  const again = useAction(async () => { await beginGoogle('confirm', '/') })
  const none = check === 'none'
  return (
    <main className="onboard-main" id="content">
      <section className="onboard-card stack" style={{ ['--gap' as string]: '18px' }}>
        <div className="onboard-icon"><Fingerprint aria-hidden="true" /></div>
        <div className="stack" style={{ ['--gap' as string]: '8px' }}>
          <h1>{t('passkey.title')}</h1>
          <p className="onboard-lead">{t('passkey.lead')}</p>
        </div>
        <ul className="ticks">
          <li><Check aria-hidden="true" />{t('passkey.tick1')}</li>
          <li><Check aria-hidden="true" />{t('passkey.tick2')}</li>
          <li><Check aria-hidden="true" />{t('passkey.tick3')}</li>
        </ul>
        {none ? <Note tone="wait" title="This browser cannot set up a device">{NO_PASSKEYS_AT_ALL}</Note>
          : check === 'other-device' ? <Note tone="wait" title="No fingerprint, face or PIN check on this device">{NO_DEVICE_CHECK} Press the button and your browser offers them.</Note> : null}
        {askPw ? <PasswordField value={pw} onChange={setPw} show={show} onShow={setShow} autoComplete="current-password" hint={t('passkey.again')} /> : null}
        <Problem error={add.error} />
        {askGoogle ? <div><Btn busy={again.busy} onClick={() => void again.run()}>Confirm with Google again</Btn><Problem error={again.error} /></div> : null}
        <div className="row"><Btn tone="fill" className="lg" busy={add.busy} disabled={none} onClick={() => void add.run()}><Fingerprint aria-hidden="true" />{check === 'other-device' ? t('passkey.addOther') : t('passkey.add')}</Btn><Btn className="lg" onClick={onLater}>{t('passkey.later')}</Btn></div>
        <p className="small faint">{session.hasPassword === false ? t('passkey.withoutGoogle') : t('passkey.without')}</p>
        <EmailLine />
      </section>
    </main>
  )
}

/**
 * Right after a device is set up: it worked, what it now does, and, once, the saved recovery codes that came with it (R14,
 * review F1: they are made with the first device so that nobody can hold two without them; no confirmation box and no
 * forced step: Copy, Download or just Continue). After a password reset the device signs in only, and the page says so.
 */
function DeviceReady({ onDone }: { onDone: () => void }) {
  const { session } = useSession()
  const [held] = useState(() => takeCodes())
  const codes = held?.codes ?? null
  const has = (session.recoveryCodesLeft ?? 0) > 0
  const signinOnly = session.authority === 'restricted'
  return (
    <main className="onboard-main" id="content">
      <section className="onboard-card stack" style={{ ['--gap' as string]: '18px' }}>
        <div className="onboard-icon"><ShieldCheck aria-hidden="true" /></div>
        <div className="stack" style={{ ['--gap' as string]: '8px' }}>
          <h1>Device sign-in is set up</h1>
          {signinOnly
            ? <p className="muted">Your device now signs you in. It cannot approve payments yet: it was added after a password reset or a recovery, so approving waits until you ask for it under Security and recovery, after a wait that your other devices and contacts can stop. QED never receives your fingerprint, face or PIN.</p>
            : <p className="muted">Your device now signs you in, and it approves what you pay: each approval is the device signing that payment's exact amount, payee and terms. QED never receives your fingerprint, face or PIN.</p>}
        </div>
        <section className="stack ax-codes" style={{ ['--gap' as string]: '10px' }} aria-labelledby="back-h">
          <h2 id="back-h" className="ax-h2">Keep a way back in</h2>
          {codes ? <>
            {session.email?.canVerify === false ? <p className="small muted">This installation cannot send email, so the codes are the way back if you lose your device.</p> : null}
            <SavedCodes codes={codes} replaced={held?.replaced} onContinue={onDone} />
          </>
            : has ? <p className="small muted">You have saved recovery codes. Under Security you can add a second device and name a recovery contact.</p>
              : <p className="small muted">This account holds no saved recovery codes. Under Security and recovery you can make them once your device can confirm it.</p>}
        </section>
        {codes ? null : <div className="row"><Btn tone="fill" className="lg" onClick={onDone}>Continue</Btn></div>}
      </section>
    </main>
  )
}

/** Presentation mode (N-003): every page, the sign-in page included, says that the values are synthetic. */
function PresentationBanner() {
  const { session } = useSession()
  if (!session.presentation) return null
  // Claims review F2: what is synthetic is the market data; the wallet's transactions are real on a local test chain
  return <div className="banner wait" role="note">Presentation mode: market prices, NAVs, rates and their history are synthetic, generated on this computer; no data from CoinDCX, AMFI, Binance, Coinbase or any other market data provider is used. On-chain wallet transactions are real, on a test chain running on this computer, with valueless test tokens. The 19-20 October record is historical.</div>
}

/** Shown on every page while a recovery somebody started is open. */
function RecoveryBanner() {
  const { session } = useSession()
  if (!session.openRecoveries) return null
  return <div className="banner" role="alert">Someone started a recovery of this account. If it was not you, <Link to="/security">cancel it on the security page</Link>.</div>
}

/**
 * Shown on every page while this account's passkeys sign in only (after a recovery, R12): what that means, and the one
 * step that brings approving back. A waiting request says when; it is not an alarm, so it is a status, not an alert.
 */
function AuthorityBanner() {
  const { session } = useSession()
  if (session.authority !== 'restricted' && session.passkeyAuthority !== 'signin') return null
  const r = session.authorityRequest
  return <div className="banner wait" role="status">{r ? `Your passkey signs you in. It can approve payments from ${fmt.dayTime(r.effective_at)}, unless the request is stopped.` : 'Your passkey signs you in, but cannot approve payments yet.'} <Link to="/security#authority">{r ? 'See the request' : 'Ask for approval authority'}</Link></div>
}

function Setup() {
  const { session, reload } = useSession()
  const d = session.defaults ?? { opening: {}, profile: {} }
  const [v, setV] = useState<Record<string, number | null>>({ bank: d.opening.bank ?? 0, card: d.opening.card ?? 0, personalLoan: d.opening.personalLoan ?? 0, homeLoan: d.opening.homeLoan ?? 0, fd: d.opening.fd ?? 0, income: d.profile.income ?? 0, spending: d.profile.spending ?? 0, line: d.profile.line ?? 0, personalLoanEmi: d.profile.personalLoanEmi ?? 0, homeLoanEmi: d.profile.homeLoanEmi ?? 0 })
  const set = (k: string) => (x: number | null) => setV((s) => ({ ...s, [k]: x }))
  // R13 S7: the home currency is chosen here and not changed afterwards. The rupee writes nothing; another converts the example's figures once, at a recorded rate that is named beside them.
  const [ccy, setCcy] = useState<string>('INR')
  // Until the household is opened, this form is where the home currency is chosen: every draw of it writes the figures in
  // the currency chosen here, whatever the session last said (a session read again mid-form reads the rupee, R14).
  setHomeCurrency(ccy)
  const [basis, setBasis] = useState<HomeBasisView | null>(null)
  const [ccyError, setCcyError] = useState<string | null>(null)
  const pick = async (c: string) => {
    setCcyError(null)
    try {
      const r = await api<{ opening: Record<string, number>; profile: Record<string, number>; basis: HomeBasisView | null }>('GET', `/api/household/defaults?currency=${encodeURIComponent(c)}`)
      setHomeCurrency(c); setCcy(c); setBasis(r.basis)
      setV({ bank: r.opening.bank ?? 0, card: r.opening.card ?? 0, personalLoan: r.opening.personalLoan ?? 0, homeLoan: r.opening.homeLoan ?? 0, fd: r.opening.fd ?? 0, income: r.profile.income ?? 0, spending: r.profile.spending ?? 0, line: r.profile.line ?? 0, personalLoanEmi: r.profile.personalLoanEmi ?? 0, homeLoanEmi: r.profile.homeLoanEmi ?? 0 })
    } catch (e) { setCcyError(e instanceof Error ? e.message : 'The example figures could not be read.') }
  }
  const go = useAction(async () => {
    const n = (k: string) => v[k] ?? 0
    await api('POST', '/api/household', { opening: { bank: n('bank'), fd: n('fd'), card: n('card'), personalLoan: n('personalLoan'), homeLoan: n('homeLoan') }, profile: { income: n('income'), spending: n('spending'), line: n('line'), personalLoanEmi: n('personalLoanEmi'), homeLoanEmi: n('homeLoanEmi'), ...(ccy !== 'INR' ? { homeCurrency: ccy } : {}) } })
    await reload()
  })
  const n = (k: string) => v[k] ?? 0
  const money = (k: string, label: string, hint?: string) => <Field label={label} hint={hint} error={go.error?.fields[k]}>{(p) => <MoneyInput {...p} value={v[k] ?? null} onChange={set(k)} />}</Field>
  const have = n('bank') + n('fd'), owe = n('card') + n('personalLoan') + n('homeLoan')
  const worst = n('bank') + n('fd') - n('card') - n('personalLoanEmi') - n('homeLoanEmi')
  const monthly = n('income') - n('spending') - n('personalLoanEmi') - n('homeLoanEmi')
  const above = n('line') > worst
  const currencies = session.homeCurrencies ?? [{ code: 'INR', name: 'Indian rupee' }]
  const ccyName = currencies.find((c) => c.code === ccy)?.name ?? ccy
  // R14 L2: the summary and the one action stay in view beside the form and end level with it (kit.tsx useStickySide)
  const side = useStickySide<HTMLElement>()
  return (
    <main className="onboard-main wide" id="content">
      <div className="stack setup-head" style={{ ['--gap' as string]: '8px' }}>
        <h1>Open your paper household</h1>
        <p className="muted">QED starts from these figures and checks every action against them. They are practice money: change them to resemble your own, or keep the example.</p>
      </div>
      {/* the form is the two columns: the figures on the left; beside them, where they leave you and the one action */}
      <form className="setup" onSubmit={(e) => { e.preventDefault(); void go.run() }}>
        <div className="setup-form">
          <fieldset className="setup-group"><legend>Your home currency</legend>
            <div className="setup-ccy">
              <Field label="Home currency" hint="It cannot be changed after you open the household." error={ccyError ?? go.error?.fields.homeCurrency}>{(p) => <select className="input" {...p} value={ccy} onChange={(e) => void pick(e.target.value)}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}</select>}</Field>
              <div className="setup-ccy-says">
                <p>Every figure below, and everything QED writes to you, is in this currency.</p>
                <p className="muted small">Buying funds, shares and coins, the rupee desk and payments abroad work in rupees only, and stay closed to a household in another currency.</p>
              </div>
            </div>
            {/* the rate the example was converted at, then where it comes from: the figure first, its source under it (R14) */}
            {basis ? (
              <div className="setup-basis" role="status">
                <p><b>The example figures are converted at {basis.rupeesPerUnit} rupees to one {ccyName}.</b> Change any of them to your own.</p>
                <p className="small muted">Rate: {basis.source} ({basis.label}). Rounded {basis.rounding}.</p>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="setup-group"><legend>What you have and owe today</legend>
            <div className="setup-sub" role="group" aria-labelledby="su-have"><p className="setup-sub-h" id="su-have">You have</p><div className="form-grid cols-2">{money('bank', 'In your bank account')}{money('fd', 'In a fixed deposit')}</div></div>
            <div className="setup-sub" role="group" aria-labelledby="su-owe"><p className="setup-sub-h" id="su-owe">You owe</p><div className="form-grid cols-3">{money('card', 'On your credit card')}{money('personalLoan', 'On a personal loan')}{money('homeLoan', 'On a home loan')}</div></div>
          </fieldset>
          <fieldset className="setup-group"><legend>What comes in and goes out each month</legend><div className="form-grid cols-2">{money('income', 'Salary, each month')}{money('spending', 'Everyday spending, each month')}{money('personalLoanEmi', 'Personal loan instalment')}{money('homeLoanEmi', 'Home loan instalment')}</div></fieldset>
          <fieldset className="setup-group"><legend>Your floor</legend>
            <div className="setup-ccy">
              {money('line', 'Worst case must stay above')}
              <div className="setup-ccy-says"><p className="muted small">QED's own purchases are refused if they would take your worst case below this. You can still go below it by hand.</p></div>
            </div>
            {above ? <Note tone="wait">This floor is above where you start, so QED could not buy anything for you until that changes.</Note> : null}</fieldset>
          {go.error && Object.keys(go.error.fields).length === 0 ? <Problem error={go.error} /> : null}
        </div>
        <aside className="setup-side sticky-side" ref={side} aria-label="Where these figures leave you">
          <div className="setup-preview field-hero">
            <p className="sp-label">Room above your floor</p>
            <p className="sp-figure">{fmt.money(Math.max(0, worst - n('line')))}</p>
            <p className="sp-sub">What QED could spend for you, only under instructions you sign, before your worst case reaches your floor</p>
            <dl className="sp-rows">
              <div><dt>You have, less what you owe</dt><dd className={have - owe < 0 ? 'neg' : ''}>{fmt.money(have - owe)}</dd><dd className="sp-note">{fmt.money(have)} less {fmt.money(owe)}; a home is not counted, only its loan</dd></div>
              <div><dt>Coming in each month</dt><dd>{fmt.money(n('income'))}</dd></div>
              <div><dt>Going out each month</dt><dd>{fmt.money(n('spending') + n('personalLoanEmi') + n('homeLoanEmi'))}</dd></div>
              <div><dt>Left over each month</dt><dd className={monthly < 0 ? 'neg' : ''}>{fmt.money(monthly)}</dd></div>
              <div><dt>Worst case after this month's dues</dt><dd>{fmt.money(worst)}</dd></div>
              <div><dt>Your floor</dt><dd>{fmt.money(n('line'))}</dd></div>
            </dl>
            {above ? <p className="sp-verdict warn">Your floor is above your worst case: QED would refuse every purchase.</p> : null}
          </div>
          <div className="setup-go"><Btn tone="fill" className="lg block" type="submit" busy={go.busy}>Open the household</Btn><p className="small faint">You can change every figure later.</p></div>
        </aside>
      </form>
    </main>
  )
}
/** The rate a household's example figures were converted at, as the server recorded it (server/home-currency.ts HomeBasis). */
interface HomeBasisView { currency: string; rupeesPerUnit: string; source: string; label: string; rounding: string }

/**
 * The one control that pauses QED, in the sidebar on every page and in the top bar on a phone. Its label is QED's state;
 * it opens a sheet that says exactly what pausing stops, what can keep running, and what cannot be recalled. Pausing
 * needs no confirmation; resuming needs the passkey. Single instructions are paused on their own pages.
 * In an emergency one place stops everything (R12 task comparison, gaps 2 and 15): the sheet names the runs and bills
 * of the next two weeks that will not happen and what happens anyway; it can also sign out every other session (no
 * confirmation, as ending one session needs none: it only takes access away) and pause the on-chain wallet's contract
 * (its exact terms, signed with the passkey, once QED is paused). While paused, it says whether the wallet is paused too.
 */
interface StopItem { label: string; amount: number | null; dueAt: number; why: string }
interface StopPreview { skipped: StopItem[]; yours: StopItem[]; continues: StopItem[]; horizonDays: number }
interface WalletBrief { setUp: boolean; state: { provisioned: boolean; treasury: { paused: boolean } } | null }
function Effects({ title, items }: { title: string; items: StopItem[] }) {
  if (!items.length) return null
  const shown = items.slice(0, 4)
  return (
    <div className="qs-effects">
      <h3>{title}</h3>
      <ul>{shown.map((i, n) => <li key={n}><span className="qs-what"><b>{i.label}</b><small>{i.why}</small></span><span className="qs-when">{i.amount === null ? 'As it runs' : fmt.money(i.amount)}<small>{fmt.dayTime(i.dueAt)}</small></span></li>)}</ul>
      {items.length > shown.length ? <p className="small muted">And {items.length - shown.length} more in the same two weeks.</p> : null}
    </div>
  )
}
function QedStatus({ engineRunning, compact, inForce }: { engineRunning: boolean; compact?: boolean; inForce: number | null }) {
  const { session, reload } = useSession()
  const [open, setOpen] = useState(false)
  // A session opened with a passkey that signs in only (after a recovery or a password reset) cannot switch protective
  // selling off at all (review H2): the sheet keeps it running and says why. A password session confirms with a passkey
  // first when the account has one; without one, protective selling continues (the server keeps it and says so).
  const signinOnly = session.passkeyAuthority === 'signin' && !session.stepUpFresh
  const [keepChoice, setKeepProtective] = useState(false)
  const keepProtective = keepChoice || signinOnly
  const pwOnly = session.authMethod === 'password' && !session.stepUpFresh
  const stopped = !!session.stop
  const [alsoSessions, setAlsoSessions] = useState(false)
  const [alsoWallet, setAlsoWallet] = useState(false)
  // the wallet's own pause, asked for once QED is paused; `walletLeft` says why it was not paused, when it was not
  const [walletAsk, setWalletAsk] = useState(false)
  const [walletLeft, setWalletLeft] = useState<{ error?: ApiError } | null>(null)
  const [ended, setEnded] = useState<number | null>(null)
  const preview = useData<StopPreview>(open && !stopped ? '/api/stop/preview' : null)
  const wallet = useData<WalletBrief>(open ? '/api/vault' : null, ['vault'])
  const hasWallet = !!wallet.data?.setUp && !!wallet.data.state?.provisioned
  const walletPaused = hasWallet && !!wallet.data!.state!.treasury.paused
  const stop = useAction(async () => {
    if (!keepProtective && pwOnly && session.hasPasskey) await confirmWithPasskey()
    await api('POST', '/api/stop', { reason: 'Paused by you', keepProtective })
    setEnded(alsoSessions ? (await api<{ ended: number }>('POST', '/api/security/sessions/end-others')).ended : null)
    await reload(); setOpen(false); setKeepProtective(false); setAlsoSessions(false)
    if (alsoWallet && hasWallet && !walletPaused) { setWalletLeft(null); setWalletAsk(true) }
    setAlsoWallet(false)
  })
  const resume = useAction(async () => { if (!session.stepUpFresh) await confirmWithPasskey(); await api('POST', '/api/stop/clear'); await reload(); setOpen(false); setEnded(null) }) 
  const label = !engineRunning ? 'QED not running' : stopped ? (session.stop!.protectiveContinues ? 'Paused, protection on' : 'QED paused') : 'QED active'
  const tone = !engineRunning ? 'down' : stopped ? 'paused' : 'on'
  const sub = !engineRunning ? 'Nothing is watched' : stopped ? `Since ${fmt.dayTime(session.stop!.at)}` : inForce === null ? 'Acting only as you signed' : `${inForce} instruction${inForce === 1 ? '' : 's'} in force`
  return (
    <>
      <button type="button" className={`autonomy ${tone} ${compact ? 'compact' : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)} title={stopped ? 'Resume what QED does on its own' : 'Pause what QED does on its own'}>
        {/* R7-111 F5: the state and the action it offers, both in words, so in a hurry it reads as the stop control */}
        <span className="a-state"><i aria-hidden="true" /><span>{label}</span></span>
        {compact ? null : <span className="a-sub">{sub}</span>}
        {engineRunning ? <span className="a-act">{stopped ? 'Resume' : 'Pause'}</span> : null}
      </button>
      <Sheet open={open} title={stopped ? 'Resume QED' : 'Pause QED'} onClose={() => setOpen(false)}
        foot={stopped
          ? <><Btn onClick={() => setOpen(false)}>Keep it paused</Btn><Btn tone="fill" busy={resume.busy} onClick={() => void resume.run()}>{session.stepUpFresh ? 'Resume QED' : 'Resume with your passkey'}</Btn></>
          : <><Btn onClick={() => setOpen(false)}>Cancel</Btn><Btn tone="void-fill" busy={stop.busy} onClick={() => void stop.run()}>{keepProtective ? 'Pause all but protective selling' : 'Pause everything now'}</Btn></>}>
        {stopped ? <>
          {/* who paused it, when it was not the person themselves (a saved code, a recovery contact: review of R12, M4) */}
          <p>Paused {fmt.dayTime(session.stop!.at)}{session.stop!.reason && !/^(Paused|Stopped) by you$/.test(session.stop!.reason) ? `: ${session.stop!.reason.replace(/^Paused /, 'paused ')}` : ''}{session.stop!.protectiveContinues ? (session.stop!.reason && !/^(Paused|Stopped) by you$/.test(session.stop!.reason) ? '; protective selling that runs without asking carries on, and one set to ask first still waits for a passkey approval before each sale' : '; protective selling kept running, as you chose') : ''}. Resuming lets every instruction in force start runs again from its next scheduled time. Runs that fell due while QED was paused were skipped and stay skipped. A payment on hold whose wait has ended is sent when you resume, unless you cancel it first on its record.</p>
          {ended !== null ? <p className="small">When you paused, {ended === 0 ? 'no other session was signed in.' : `${ended} other session${ended === 1 ? ' was' : 's were'} signed out.`}</p> : null}
          {hasWallet ? (walletPaused
            ? <p className="small">The on-chain wallet is paused too. Resuming QED does not resume it: you resume it under <Link to="/vault">On-chain wallet</Link>.</p>
            : <Note tone="wait" title="The on-chain wallet's mandate is still in force">
              <p>{walletLeft ? 'Its pause was not signed, so ' : ''}QED's agent can still pay from the wallet, within the mandate's limits, until the wallet itself is paused.</p>
              {walletLeft?.error ? <Problem error={walletLeft.error} /> : null}
              <div><Btn onClick={() => { setOpen(false); setWalletLeft(null); setWalletAsk(true) }}>Pause the on-chain wallet too</Btn></div>
            </Note>) : null}
          <Problem error={resume.error} />
        </> : <>
          <p>Takes effect at once. Pausing needs no confirmation; resuming needs your passkey.</p>
          <fieldset className="choice"><legend className="sr">What to pause</legend>
            <label><input type="radio" name="pause-scope" checked={!keepProtective} disabled={signinOnly} onChange={() => setKeepProtective(false)} /><b>Everything QED does on its own</b><small>{signinOnly ? 'Not from this session: its passkey signs in only, so it cannot switch protective selling off. A passkey that can approve can.' : 'No instruction starts a new run, protective selling included. Runs waiting for your approval or in a notice period are cancelled. Your on-chain wallet\'s standing conversions stop too.'}</small></label>
            <label><input type="radio" name="pause-scope" checked={keepProtective} onChange={() => setKeepProtective(true)} /><b>Everything except protective selling</b><small>Instructions that sell to hold your floor, or when a price falls, keep watching and can still sell. Everything else stops.</small></label>
          </fieldset>
          {preview.data ? <>
            <Effects title={`Will not happen while paused, in the next ${preview.data.horizonDays} days`} items={preview.data.skipped} />
            <Effects title="Still yours to pay" items={preview.data.yours ?? []} />
            <Effects title="Happens anyway" items={preview.data.continues} />
          </> : null}
          <fieldset className="choice qs-also"><legend>Also, in an emergency</legend>
            <label><input type="checkbox" checked={alsoSessions} onChange={(e) => setAlsoSessions(e.target.checked)} /><b>Sign out every other session</b><small>Every other browser and device signed in to this account is signed out; this one stays. Whoever is signed out signs in again with their passkey.</small></label>
            {hasWallet && !walletPaused ? <label><input type="checkbox" checked={alsoWallet} onChange={(e) => setAlsoWallet(e.target.checked)} /><b>Pause the on-chain wallet too</b><small>Its contract then refuses every payment QED would make from it, even with QED's own keys. Once QED is paused, your passkey signs the wallet's pause.</small></label> : null}
          </fieldset>
          <dl className="kv small"><dt>Cannot be recalled</dt><dd>A payment or order already sent to a bank rail, a venue or the chain. It finishes, and you see it in Activity.</dd>
            <dt>Payments on hold</dt><dd>A payment to a new payee that is waiting before it is sent stays on hold, even past the end of its wait, until you resume or cancel it.</dd>
            <dt>Still yours to do</dt><dd>Anything you sign yourself: a payment, an order, a conversion on the on-chain wallet.</dd>
            <dt>Paused elsewhere</dt><dd>One instruction alone: on its own page.{hasWallet ? (walletPaused ? ' The on-chain wallet is already paused.' : '') : ' The on-chain wallet: under On-chain wallet.'}</dd></dl>
          <Problem error={stop.error} />
        </>}
      </Sheet>
      {walletAsk ? <Suspense fallback={null}><WalletPauseNow onClosed={(sent, error) => { setWalletAsk(false); if (!sent) { setWalletLeft({ error }); setOpen(true) } }} /></Suspense> : null}
    </>
  )
}

/** The account's own menu: who is signed in, which workspace, the account's pages, appearance, signing out. */
function AccountMenu({ up }: { up?: boolean }) {
  const { session, reload } = useSession()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [fx, setFxState] = useState<Fx>(readFx)
  const box = useRef<HTMLDivElement>(null)
  const out = useAction(async () => { beginSignOut(); try { await api('POST', '/api/auth/logout') } catch (e) { endSignOut(); throw e } await reload(); navigate('/', true) })
  useEffect(() => {
    if (!open) return undefined
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); box.current?.querySelector<HTMLButtonElement>('button')?.focus() } }
    // focus leaving the menu (Tab past its last item, or Shift+Tab before its button) closes it, as a click outside does (F30)
    const left = (e: FocusEvent) => { if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc); document.addEventListener('focusin', left)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); document.removeEventListener('focusin', left) }
  }, [open])
  const name = session.user?.displayName ?? ''
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'Me'
  const go = (to: string) => () => { setOpen(false); navigate(to) }
  const pick = (t: Theme) => { setTheme(t); applyTheme(t); try { if (t === 'system') localStorage.removeItem('qed-theme'); else localStorage.setItem('qed-theme', t) } catch { /* a private window keeps the choice for this page only */ } }
  const where = session.workspace?.kind === 'business' ? `${session.workspace.name}, ${session.workspace.role}` : `@${session.user?.handle ?? ''}`
  return (
    <div className={`menu account ${up ? 'up' : ''}`} ref={box}>
      {/* The name comes from what the button shows (the name and handle) and a hidden ", account menu": an aria-label
          could never match the visible text, which axe reads as one run ("ARAsha Rao@asha.rao"; WCAG 2.5.3). */}
      <button type="button" className="account-btn" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span className="account-who"><b>{name}</b> <small>{where}</small></span><span className="sr">, account menu</span>
        <ChevronDown className="account-chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu-pop" id="account-menu">
          <div className="who"><strong>{name}</strong><div className="small muted">{where}</div></div>
          <WorkspaceSwitch />
          <a href="/security" onClick={(e) => { e.preventDefault(); go('/security')() }}><KeyRound aria-hidden="true" />Security and recovery</a>
          <a href="/workspace" onClick={(e) => { e.preventDefault(); go('/workspace')() }}><Users aria-hidden="true" />Workspace and members</a>
          <a href="/workspace/desk" onClick={(e) => { e.preventDefault(); go('/workspace/desk')() }}><Building2 aria-hidden="true" />Institutional desk</a>
          <a href="/safeguards" onClick={(e) => { e.preventDefault(); go('/safeguards')() }}><Settings2 aria-hidden="true" />Safeguards and records</a>
          <a href="/readiness" onClick={(e) => { e.preventDefault(); go('/readiness')() }}><FileText aria-hidden="true" />What this build is</a>
          <hr />
          <div className="theme-pick" role="group" aria-label="Appearance">
            {([['system', 'System', Monitor], ['light', 'Day', Sun], ['dark', 'Night', Moon]] as const).map(([t, l, I]) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => pick(t)}><I aria-hidden="true" />{l}</button>)}
          </div>
          <label className="fx-pick"><span>Glass and moving light</span>
            <select className="input" style={{ width: 'auto', minHeight: 34, padding: '4px 34px 4px 12px' }} value={fx} onChange={(e) => { const v = e.target.value as Fx; setFxState(v); setFx(v) }}>
              <option value="auto">Automatic</option><option value="full">On</option><option value="plain">Off (plain)</option>
            </select>
          </label>
          <hr />
          <button type="button" className="item" onClick={() => void out.run()}><LogOut aria-hidden="true" />Sign out</button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The heights of the bars pinned to the window, kept where the stylesheet can read them (base.css, html). With them
 * the browser scrolls a control that takes focus clear of the bars, so it never sits hidden under one.
 */
function usePinnedBars(): void {
  useEffect(() => {
    const root = document.documentElement
    // both bars float 12 to 16 px from the window's edge: the gap is counted with them
    const bars: [string[], string, number][] = [[['.topbar'], '--bar-top', 14], [['.dock'], '--bar-bottom', 16]]
    const measure = () => {
      for (const [sels, name, gap] of bars) {
        const h = Math.max(0, ...sels.map((sel) => { const el = document.querySelector<HTMLElement>(sel); return el && getComputedStyle(el).display !== 'none' ? Math.ceil(el.getBoundingClientRect().height) + gap : 0 }))
        root.style.setProperty(name, `${h}px`)
      }
    }
    measure()
    const watcher = new ResizeObserver(measure)
    for (const [sels] of bars) for (const sel of sels) { const el = document.querySelector(sel); if (el) watcher.observe(el) }
    window.addEventListener('resize', measure)
    return () => { watcher.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
}

function Shell() {
  useT() // the shell's own strings come from the catalogue; a change of locale redraws it
  const { session } = useSession()
  const { path } = useLocation()
  usePinnedBars()
  const now = useNow(5000)
  const sys = useData<{ engine: { running: boolean; lastBeat: number | null; startedAt: number | null } }>('/api/engine', ['beat', 'engine'])
  const progs = useData<{ programs: { state: string }[] }>('/api/programs', ['program'])
  const engine = sys.data?.engine ?? session.engine
  const inForce = progs.data ? progs.data.programs.filter((p) => p.state === 'active').length : null
  // what waits for the owner's acknowledgement (server/notify.ts); the bell marks it and says how many
  const notify = useData<{ unacknowledged: unknown[] }>('/api/notify', ['notice'])
  const waiting = notify.data?.unacknowledged.length ?? 0
  const onAsk = path.startsWith('/ask')
  const stage = useRef<HTMLElement>(null)
  useSection(path)
  useArrival(stage, path)
  useEffect(() => { prefetchScreens() }, [])
  return (
    <div className={`app${onAsk ? ' is-ask' : ''}`}>
      <a className="skip-link" href="#content">Skip to the page</a>
      <header className="topbar">
        <span className="topbar-start">
          <Brand to="/" />
          <span className="practice-chip" title={session.presentation ? 'Every price and value is synthetic, generated on this computer.' : 'The bank account is paper money and the on-chain wallet holds valueless test tokens. Prices are live market observations.'}><span className="long">{session.presentation ? 'Synthetic prices' : 'Practice money'}</span><span className="short">Practice</span></span>
        </span>
        {onAsk ? <span className="ask-gap" aria-hidden="true" /> : <AskField path={path} />}
        <span className="topbar-tools">
          <QedStatus engineRunning={!!engine?.running} compact inForce={inForce} />
          <Link to="/notifications" className="icon-btn bell desk-only" current={path.startsWith('/notifications')}><Bell aria-hidden="true" />{waiting ? <i aria-hidden="true" /> : null}<span className="sr">{waiting ? `Notifications, ${waiting} waiting for you` : 'Notifications'}</span></Link>
          <AccountMenu />
        </span>
      </header>
      {engine && !engine.running ? <div className="banner" role="status">QED's engine is not running{engine.lastBeat ? ` (last heartbeat ${fmt.rel(engine.lastBeat, now)})` : ''}. Nothing is watched or carried out. Start it with <code>npm run engine</code>; what it missed is listed when it returns.</div> : null}
      <PresentationBanner />
      <RecoveryBanner />
      <AuthorityBanner />
      {session.stop ? <div className="banner wait" role="status">{session.stop.protectiveContinues ? `QED is paused, except protective selling, since ${fmt.dayTime(session.stop.at)}.` : `QED is paused since ${fmt.dayTime(session.stop.at)}: it does nothing on its own.`} Resume it from the status control.</div> : null}
      <main className="main" id="content" ref={stage}>{(() => { const sec = SECTIONS.find((x) => x.on(path)); return sec ? <SectionNav label={t(sec.label)} items={sec.items.map((i) => ({ ...i, label: t(i.label) }))} path={path} /> : null })()}<Suspense fallback={<Loading what="Opening this page" />}><Routes path={path} /><SourceNote path={path} /></Suspense></main>
      <Dock path={path} />
    </div>
  )
}

const MORE_PATHS = ['/save', '/holdings', '/earn', '/protect', '/instructions', '/safeguards', '/security', '/workspace', '/vault', '/readiness', '/notifications', '/more']
/**
 * The dock: the seven sections on a computer or tablet; on a phone, Home, Spend, Ask, Activity and More. One list, so a
 * person who resizes the window keeps their place; the items a size does not show are not displayed at that size.
 */
function Dock({ path }: { path: string }) {
  const { t } = useT()
  const nav = useRef<HTMLElement>(null)
  const items: (NavItem & { phone: boolean; wide: boolean; short?: string })[] = [
    { ...NAV[0]!, phone: true, wide: true },
    { ...NAV[1]!, phone: true, wide: true },
    { ...NAV[2]!, phone: false, wide: true },
    { ...NAV[3]!, phone: false, wide: true },
    { ...NAV[4]!, phone: false, wide: true },
    { ...NAV[5]!, phone: false, wide: true },
    { ...ASK_TAB, phone: true, wide: false },
    { ...NAV[6]!, phone: true, wide: true },
    { to: '/more', label: 'nav.more', icon: Menu, on: (p) => MORE_PATHS.some((x) => p.startsWith(x)), phone: true, wide: false },
  ]
  const current = items.map((i) => (i.on(path) ? i.to : '')).join('|')
  useDockIndicator(nav, current)
  return (
    <nav className="dock" aria-label={t('nav.sections')} ref={nav}>
      <span className="dock-ind" aria-hidden="true" />
      {items.map((n) => {
        const I = n.icon
        const cls = [n.phone ? '' : 'wide-only', n.wide ? '' : 'phone-only', n.to === '/ask' ? 'tab-ask' : ''].filter(Boolean).join(' ')
        return <Link key={n.to} to={n.to} current={n.on(path)} className={cls || undefined}>{n.to === '/ask' ? <Orb /> : <I aria-hidden="true" />}<span>{t(n.label)}</span></Link>
      })}
    </nav>
  )
}

/** What a person on each page is likely to ask. None names a payee: Ask sends a question exactly as written. */
const DOCK_SUGGEST: [string, string[]][] = [
  ['/pay', ['Can I afford a payment of {AMOUNT} today?', 'Which of my bills does no instruction pay?']],
  ['/save', ['How long would my money last if my salary stopped?', 'How much could I set aside each month?']],
  ['/holdings', ['How much could my investments lose in a bad month?', 'What happens if Bitcoin falls 20%?']],
  ['/earn', ['Which client payments are still held in escrow?', 'What is left to deliver this month?']],
  ['/protect', ['What can QED do without asking me?', 'What happens if I lose this phone?']],
  ['/vault', ['What can QED do with my on-chain wallet?', 'What happens if I lose this phone?']],
  ['/activity', ['What did QED do on its own this week?', 'Why was a payment refused?']],
  ['/', ['Why is part of my money kept aside?', 'What will QED do for me this week?', 'What could go wrong this month?']],
]

/**
 * Ask, at the centre of the bar on every page but its own. Focused, it offers this page's questions and the earlier
 * conversations; sending opens the conversation on the Ask page (the question travels in memory, never in the address).
 * Cmd-K or Ctrl-K focuses it from anywhere, or opens Ask where the field is not shown (a phone).
 */
function AskField({ path }: { path: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      e.preventDefault()
      if (input.current && input.current.offsetParent) input.current.focus(); else navigate('/ask')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  // a round sum in the household's own currency (₹50,000, $500, ¥50,000), written as the screens write money
  const round = fmt.money((entryFormat().places === 0 || homeCurrency() === 'INR' ? 50_000 : 500) * entryFormat().unit)
  const chips = (DOCK_SUGGEST.find(([p]) => (p === '/' ? path === '/' : path.startsWith(p))) ?? DOCK_SUGGEST[DOCK_SUGGEST.length - 1]!)[1].map((c) => c.replace('{AMOUNT}', round))
  const send = (t: string) => { setQ(''); setOpen(false); input.current?.blur(); handAsk(t) }
  return (
    <form className="ask-field" role="search" aria-label="Ask QED" onSubmit={(e) => { e.preventDefault(); if (q.trim()) send(q.trim()) }}
      onFocus={() => setOpen(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); input.current?.blur() } }}>
      <div className="ask-row">
        <Orb />
        <label className="sr" htmlFor="ask-q">Ask QED</label>
        <input id="ask-q" ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask QED to pay, explain, plan or change something" autoComplete="off" maxLength={2000} />
        {q ? <Btn tone="fill" small type="submit" className="ask-send">Ask</Btn> : <kbd aria-hidden="true">⌘K</kbd>}
      </div>
      {open && !q ? (
        <div className="ask-pop">
          <p id="ask-sugg">For this page</p>
          <div role="group" aria-labelledby="ask-sugg">{chips.map((c) => <button key={c} type="button" onClick={() => send(c)}><Sparkles aria-hidden="true" />{c}</button>)}</div>
          <Link to="/ask"><ArrowRight aria-hidden="true" />Your conversations with QED</Link>
        </div>
      ) : null}
    </form>
  )
}

/** Every part of QED not in the phone's tab bar, grouped by what it is for. */
const MORE: [string, [string, string, string, Icon][]][] = [
  ['Money', [
    ['/save', 'Save', 'What is kept for what is due, money set aside, what if', PiggyBank],
    ['/holdings', 'Grow', 'Holdings at live prices, buying and selling, your worst case', ChartLine],
    ['/earn', 'Earn', 'Work for clients, escrow, money in', HandCoins],
  ]],
  ['Protect', [
    ['/protect', 'Protect', 'What QED may do, what watches it, what enforces it', ShieldCheck],
    ['/instructions', 'Instructions', 'Each standing instruction, its limits and what it has done', ListChecks],
    ['/vault', 'On-chain wallet', 'Test money on a local chain, owned by your passkey', Wallet],
    ['/security', 'Security and recovery', 'Passkeys, sessions, recovery', KeyRound],
    ['/workspace', 'Workspace and members', 'Business workspaces, who must sign', Users],
    ['/workspace/desk', 'Institutional desk', 'Netting, quotes and client reports', Building2],
    ['/safeguards', 'Safeguards and records', 'Your floor, the engine, data sources, records', Settings2],
    ['/notifications', 'Notifications', 'What waits for you, quiet hours, the daily digest', Bell],
  ]],
  ['Records', [
    ['/passbook', 'Statement', 'Your bank account, line by line, with what is expected', ReceiptText],
    ['/tax', 'Tax statement', 'Realised gains by year and kind of asset, tied to the ledger (modelled, not tax advice)', FileText],
    ['/evidence', 'Evidence', 'What happened, who decided and what checked it, on demand', FileText],
    ['/judge', 'From objective to evidence', 'One decision followed from what you asked to the chain and back', Route],
  ]],
]

function Routes({ path }: { path: string }): ReactNode {
  const { session } = useSession()
  let m: Record<string, string> | null
  if (path === '/') return <HomeScreen />
  if (path === '/passbook') return <PassbookScreen />
  if (path === '/tax') return <TaxScreen />
  if (path === '/save') return <SaveScreen />
  if (path === '/protect') return <ProtectScreen />
  if (path === '/evidence') return <EvidenceListScreen />
  if ((m = match('/evidence/:id', path))) return <EvidenceCaseScreen id={decodeURIComponent(m.id!)} />
  if (path === '/judge') return <JudgeScreen />
  if (path === '/activity') return <ActivityScreen />
  if (path === '/pay') return <PayScreen />
  if (path === '/instructions') return <InstructionsScreen />
  if (path === '/instructions/new') return <ComposeScreen />
  if ((m = match('/instructions/:id/amend', path))) return <ComposeScreen amendId={m.id!} />
  if ((m = match('/instructions/:id', path))) return <InstructionScreen id={m.id!} />
  if (path === '/holdings') return <HoldingsScreen />
  if (path === '/holdings/lab') return <LabScreen />
  if (path === '/holdings/idea') return <IdeaScreen />
  if ((m = match('/holdings/idea/:id', path))) return <IdeaRecordScreen id={m.id!} />
  if (path === '/earn') return <EarnScreen />
  if (path === '/earn/bounties') return <BountiesScreen />
  if (path === '/safeguards') return <SafeguardsScreen />
  if (path === '/readiness') return <ReadinessScreen />
  if (path === '/security') return <SecurityScreen />
  if (path === '/workspace') return <WorkspaceScreen />
  if (path === '/workspace/desk') return <DeskScreen />
  if (path === '/notifications') return <NotificationsScreen />
  if (path === '/vault') return <VaultScreen sub="" />
  if ((m = match('/vault/job/:id', path))) return <VaultJobScreen id={m.id!} />
  if ((m = match('/vault/:sub', path))) return <VaultScreen sub={m.sub!} />
  if (path === '/ask') return <AskScreen />
  if ((m = match('/record/:id/pack', path))) return <DisputePackScreen id={m.id!} />
  if ((m = match('/record/:id', path))) return <RecordScreen id={m.id!} />
  if ((m = match('/receipts/:id', path))) return <ReceiptScreen id={m.id!} />
  if (path === '/more') return (
    <div className="more">
      <div className="page-head"><div><h1>More</h1><p><span className="narrow-only">Every part of QED that is not in the bar below.</span><span className="desk">Every part of QED in one place.</span></p></div></div>
      {[...MORE, ['This build', [['/readiness', 'What this build is', session.presentation ? 'Presentation mode, and why it is not for real money' : 'Why it is not ready for real money', FileText]]] as [string, [string, string, string, Icon][]]].map(([group, items]) => (
        <section key={group} className="more-group" aria-labelledby={`more-${group}`}>
          <h2 id={`more-${group}`} className="more-h">{group}</h2>
          <ul className="more-list">{items.map(([to, t, d, I]) => <li key={to}><Link to={to} className="more-row"><span className="glyph"><I aria-hidden="true" /></span><span className="more-t"><strong>{t}</strong><span className="small muted">{d}</span></span><ChevronRight className="more-chev" aria-hidden="true" /></Link></li>)}</ul>
        </section>
      ))}
      <SignOutRow />
    </div>
  )
  return <div className="empty-state"><span className="glyph"><X aria-hidden="true" /></span><h1>Nothing at this address</h1><p>The page you asked for does not exist.</p><Link to="/" className="btn">Back to home</Link></div>
}

function SignOutRow() {
  const { session, reload } = useSession()
  const out = useAction(async () => { beginSignOut(); try { await api('POST', '/api/auth/logout') } catch (e) { endSignOut(); throw e } await reload(); navigate('/', true) })
  return <p className="row" style={{ marginTop: 28 }}><Btn busy={out.busy} onClick={() => void out.run()}><LogOut aria-hidden="true" />Sign out</Btn><span className="small muted">Signed in as {session.user?.displayName}. Signing out does not pause QED.</span></p>
}

/** Which workspace the session acts in. Shown only to someone who belongs to more than one. */
function WorkspaceSwitch() {
  const { session, reload } = useSession()
  const list = session.workspaces ?? []
  const go = useAction(async (id: string) => { await api('POST', `/api/workspaces/${id}/switch`); await reload(); navigate('/', true) })
  if (list.length < 2) return null
  return (
    <label className="ws-switch small"><span className="sr-only">Workspace</span>
      <select className="input" value={session.workspace?.id} disabled={go.busy} onChange={(e) => void go.run(e.target.value)}>
        {list.map((w) => <option key={w.id} value={w.id}>{w.kind === 'business' ? w.name : 'Personal'}{w.kind === 'business' ? ` (${w.role})` : ''}</option>)}
      </select>
    </label>
  )
}
