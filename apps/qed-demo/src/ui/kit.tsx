/** Interface primitives. Small on purpose: every screen is built from these and from plain HTML. */
import { ArrowLeft, Check, Clock, Eye, EyeOff, Minus, X } from 'lucide-react'
import { type ButtonHTMLAttributes, createContext, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, ApiError, fmt, navigate, paiseToRupees, rupeesToPaise } from '../lib/core.ts'
import { homeCurrency } from '../../shared/home-money.ts'
import { confirmWithPasskey } from '../lib/passkey.ts'
import { SOURCES, type SourceKind, sourcesOfPath } from '../lib/sources.ts'

export interface SessionInfo {
  authenticated: boolean; presentation?: boolean; csrf?: string; stepUpFresh?: boolean; setup?: boolean; authMethod?: string; hasPasskey?: boolean; openRecoveries?: number
  /** R12: 'restricted' while every passkey of the account signs in only (after a recovery), with its request, if any. */
  authority?: 'full' | 'restricted' | 'none'; authorityRequest?: { id: string; effective_at: number } | null
  /** The authority of the passkey this session was opened with ('signin' after a recovery), or null for a password session. */
  passkeyAuthority?: 'full' | 'signin' | null
  /** How email and text messages leave QED: 'outbox' is the local test outbox (nothing is sent), 'none' no adapter. */
  delivery?: 'outbox' | 'none'
  /** How long a recovery and a protection-lowering change wait on this installation; a test stack's shortened wait on payments to new payees, or null. */
  delays?: { recoveryMs: number; protectionMs: number; newPayeeHoldTestMs?: number | null }
  workspace?: { id: string; name: string; kind: string; role: string; policy: { signers: number; makerChecker: boolean } }
  workspaces?: { id: string; name: string; kind: string; role: string; members: number }[]
  user?: { id: string; handle: string; displayName: string; createdAt: number }
  profile?: { timeZone?: string; income: number; incomeDay: number; spending: number; line: number; personalLoanEmi: number; homeLoanEmi: number; emiDay: number; setup: boolean; newPayeeHoldAbove?: number; newPayeeHoldHours?: number }
  /** A change that loosens a protection, waiting out the protection delay (server/loosening.ts): what it sets, and what is in force until then. */
  profileChange?: ProfileChange | null
  stop?: { at: number; reason: string | null; protectiveContinues?: boolean } | null
  ai?: { provider: string; model: string; detail: string }
  engine?: { running: boolean; lastBeat: number | null; startedAt: number | null }
  defaults?: { opening: Record<string, number>; profile: Record<string, number> }
  /** R13 S7: the household's home currency (the rupee for a household that chose none) and the ones it may choose at set-up. */
  homeCurrency?: string; homeCurrencies?: { code: string; name: string }[]
  sessions?: { created_at: number; last_seen_at: number; ua: string | null; current: number }[]
}
export interface ProfileChange { id: string; requestedAt: number; effectiveAt: number; after: Record<string, number>; before: Record<string, number> }
export const SessionCtx = createContext<{ session: SessionInfo; reload: () => Promise<void> }>({ session: { authenticated: false }, reload: async () => {} })
export const useSession = () => useContext(SessionCtx)

/** A check's result, drawn: a tick for passed, a cross for failed (the words beside it say which, for a screen reader). */
export const Mark = ({ pass }: { pass: boolean }) => <span className="mark" aria-hidden="true">{pass ? <Check /> : <X />}</span>

/** The way back to the page this one belongs to: a breadcrumb, not a label over the heading. */
export function Crumb({ to, children }: { to: string; children: ReactNode }) {
  return <nav className="crumb" aria-label="Breadcrumb"><Link to={to}><ArrowLeft aria-hidden="true" />{children}</Link></nav>
}

/** The pages of one section (Protect, Activity) as tabs at the top of the page; the shell draws it once. */
export function SectionNav({ label, items, path }: { label: string; items: { to: string; label: string; on: (p: string) => boolean }[]; path: string }) {
  const ref = useRef<HTMLElement>(null)
  // On a narrow screen the tabs scroll sideways: the current one is brought into view, and an edge with more tabs
  // beyond it fades (data-more), so it is plain that there are more.
  useEffect(() => {
    const nav = ref.current
    if (!nav) return undefined
    const cur = nav.querySelector<HTMLElement>('[aria-current="page"]')
    if (cur && nav.scrollWidth > nav.clientWidth) {
      const left = cur.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft
      nav.scrollLeft = Math.max(0, left - (nav.clientWidth - cur.offsetWidth) / 2)
    }
    const edges = () => { nav.dataset.more = [nav.scrollLeft > 1 ? 'left' : '', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 ? 'right' : ''].join(' ').trim() }
    edges()
    nav.addEventListener('scroll', edges, { passive: true })
    window.addEventListener('resize', edges)
    return () => { nav.removeEventListener('scroll', edges); window.removeEventListener('resize', edges) }
  }, [path])
  return <nav ref={ref} className="secnav" aria-label={label}>{items.map((i) => <Link key={i.to} to={i.to} current={i.on(path)}>{i.label}</Link>)}</nav>
}

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return <a href={to} className={className} aria-current={current ? 'page' : undefined} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to) }}>{children}</a>
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'fill' | 'quiet' | 'void' | 'void-fill'; small?: boolean; busy?: boolean }
export function Btn({ tone, small, busy, className, children, disabled, onClick, ...rest }: BtnProps) {
  const cls = ['btn', tone === 'fill' ? 'fill' : tone === 'quiet' ? 'quiet' : tone === 'void' ? 'void' : tone === 'void-fill' ? 'void fill' : '', small ? 'sm' : '', busy ? 'busy' : '', className ?? ''].filter(Boolean).join(' ')
  // While its action runs, a button stays focusable and stops acting. Disabling it would take focus away from under
  // the keyboard, and the approval sheet that opens next could not then give focus back to it when it closes.
  return <button type="button" {...rest} className={cls} disabled={disabled} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={busy ? (e) => e.preventDefault() : onClick}>{children}</button>
}

/**
 * Two columns that stack independently: each section keeps its column and sits under the one before it in that column,
 * whatever the heights, so no row leaves a hole beside a short neighbour. The document order stays the order of
 * importance (on Home: position, what needs you, what QED may do, what is coming, where the money is, what happened), and on a
 * narrow screen it is the reading order too.
 */
export function useMasonry() {
  const board = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = board.current
    if (!el) return undefined
    const UNIT = 4
    const apply = () => {
      const on = getComputedStyle(el).display === 'grid'
      // how far down each column already reaches; a section marked data-col="auto" goes under the shorter one, so the
      // last section evens the two columns' feet instead of lengthening the longer one (R12, Home's "Ways to do better")
      const reach = [0, 0]
      for (const c of Array.from(el.children) as HTMLElement[]) {
        if (!on) { c.style.gridRowEnd = ''; if (c.dataset.col === 'auto') c.style.gridColumn = ''; continue }
        const h = c.getBoundingClientRect().height + parseFloat(getComputedStyle(c).marginBottom || '0')
        const span = Math.max(1, Math.ceil(h / UNIT))
        c.style.gridRowEnd = `span ${span}`
        const col = c.dataset.col === 'auto' ? (reach[0]! <= reach[1]! ? 0 : 1) : c.dataset.col === '2' ? 1 : c.dataset.col === '1' ? 0 : -1
        if (c.dataset.col === 'auto') c.style.gridColumn = String(col + 1)
        if (col >= 0) reach[col]! += span
      }
    }
    const ro = new ResizeObserver(apply)
    for (const c of Array.from(el.children)) ro.observe(c)
    ro.observe(el)
    apply()
    return () => ro.disconnect()
  })
  return board
}

/** Run an async action with busy and error state. The error is shown where the action was taken. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>): { run: (...a: A) => Promise<boolean>; busy: boolean; error: ApiError | null; clear: () => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const ref = useRef(fn)
  ref.current = fn
  const running = useRef(false)
  const run = useCallback(async (...a: A) => {
    if (running.current) return false // one at a time, whatever the button looks like: a second press while it runs does nothing
    running.current = true
    setBusy(true); setError(null)
    try { await ref.current(...a); return true }
    catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'error', e instanceof Error ? e.message : String(e))); return false }
    finally { running.current = false; setBusy(false) }
  }, [])
  return { run, busy, error, clear: () => setError(null) }
}

/**
 * For a change the server makes only after a fresh passkey confirmation (because it weakens a protection), and without
 * one otherwise. The change is tried. If the server asks, its reason is shown with a button that confirms with the
 * passkey and tries again.
 */
export function useStepUpWhenAsked<A extends unknown[]>(fn: (...a: A) => Promise<unknown>): { run: (...a: A) => Promise<boolean>; busy: boolean; error: ApiError | null; field: ReactNode } {
  const [why, setWhy] = useState<string | null>(null)
  const [last, setLast] = useState<A | null>(null)
  const act = useAction(async (...a: A) => {
    setLast(a)
    try { await fn(...a); setWhy(null) }
    catch (e) { if (e instanceof ApiError && e.code === 'stepup_required') { setWhy(e.message); return } throw e }
  })
  const confirm = useAction(async () => { await confirmWithPasskey(); setWhy(null); if (last) await act.run(...last) })
  const field = why === null ? null : (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <p className="small">{why}</p>
      <div><Btn tone="fill" busy={confirm.busy} onClick={() => void confirm.run()}>Confirm with your passkey</Btn></div>
      {confirm.error ? <Problem error={confirm.error} /> : null}
    </div>
  )
  return { run: act.run, busy: act.busy || confirm.busy, error: act.error, field }
}

export function Note({ tone, title, children }: { tone?: 'wait' | 'void' | 'ok' | 'qed'; title?: string; children?: ReactNode }) {
  // The title is the note's own first line, not a heading: a note can appear anywhere on a page, and a heading here would break the page's outline.
  return <div className={`note ${tone ?? ''}`} role={tone === 'void' ? 'alert' : undefined}>{title ? <p className="note-title">{title}</p> : null}{children}</div>
}
export function Problem({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null
  return <Note tone="void" title={error.code === 'unreachable' ? 'QED is not answering' : undefined}>{error.message}</Note>
}
export const Loading = ({ what = 'Loading' }: { what?: string }) => <p className="loading-line" aria-busy="true">{what}…</p>
/**
 * QED's mark (Meridian): a globe with one meridian, its tail making the Q. The world the wallet works across, the line
 * the light falls on, and the letter. The meridian takes the agent's tide colour (shell.css).
 */
export const Logo = ({ className }: { className?: string }) => (
  <svg className={`logo${className ? ` ${className}` : ''}`} viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none">
    <circle className="logo-ring" cx="15" cy="15" r="10.4" strokeWidth="2.6" />
    <ellipse className="logo-meridian" cx="15" cy="15" rx="4.3" ry="10.4" strokeWidth="1.8" />
    <path className="logo-tail" d="M22.4 22.4L28.4 28.4" strokeWidth="2.8" strokeLinecap="round" />
  </svg>
)
/**
 * The checked mark: QED's mark in the agent's colour, on whatever its independent checks passed (a receipt, a signed
 * instruction, a verified record). Never decoration. `live` marks a check that is re-run while the page is open.
 */
export const Seal = ({ size, live, label }: { size?: 'lg' | 'xl'; live?: boolean; label?: string }) => (
  <span className={`seal ${size ?? ''} ${live ? 'live' : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
    <svg viewBox="0 0 32 32" focusable="false" fill="none" stroke="currentColor"><circle cx="15" cy="15" r="10.4" strokeWidth="3.2" /><ellipse cx="15" cy="15" rx="4.3" ry="10.4" strokeWidth="2.2" /><path d="M22.4 22.4L28.4 28.4" strokeWidth="3.4" strokeLinecap="round" /></svg>
  </span>
)
/** QED's presence: the orb. `busy` turns its highlight while QED works on something for the person. */
export const Orb = ({ busy, size, label }: { busy?: boolean; size?: 'sm' | 'lg'; label?: string }) => (
  <span className={`orb ${size ?? ''} ${busy ? 'busy' : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} />
)
const STAMP_ICON = { ok: Check, wait: Clock, void: X, you: Check, plain: Minus, info: Clock, qed: Check } as const
export const Stamp = ({ tone, children, big, sub }: { tone?: 'ok' | 'wait' | 'void' | 'you' | 'plain' | 'info'; children: ReactNode; big?: boolean; sub?: string }) => {
  // A status always carries its icon as well as its word (DESIGN.md P2): a stamp with no tone is a state in progress.
  const I = tone ? STAMP_ICON[tone] : Clock
  return <span className={`stamp ${tone ?? ''} ${big ? 'big' : ''}`}><I aria-hidden="true" />{children}{sub ? <small>{sub}</small> : null}</span>
}

const BASIS: Record<string, [string, string]> = {
  recorded: ['from your records', 'Read from your ledger and profile as they stand now.'],
  exact: ['exact', 'Fixed by what you are approving.'],
  live: ['live price', 'A price received from the market source moments ago. It moves.'],
  estimate: ['an estimate', 'Worked out from current prices and rules. The real figure can differ.'],
  modelled: ['modelled', 'From an assumption QED states, not from a published term.'],
  historical: ['past data', 'What happened in the past. It does not predict what will happen.'],
  limit: ['if limits hold', 'Worked out by assuming each holding falls by its limit and no further. Limits marked illustrative are not calibrated.'],
  rule: ['by rule', 'Set by the rules of the fund, rail or venue.'],
  reference: ['reference', 'A published reference rate: what a currency was worth by a benchmark. Nobody can trade at it.'],
}
/**
 * What kind of figure this is ("if limits hold", "exact"), with its explanation one press away: a button that shows the
 * explanation beside it, for keyboard and touch as well as a pointer (it was a hover title only, which neither reaches).
 */
export function Basis({ kind }: { kind: string }) {
  const b = BASIS[kind] ?? [kind, '']
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!b[1]) return <span className="basis">{b[0]}</span>
  return (
    <span className="basis-wrap">
      <button type="button" className="basis" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}>{b[0]}</button>
      {open ? <span id={id} role="note" className="basis-pop">{b[1]}</span> : null}
    </span>
  )
}

/** A figure's source, beside the figure (R7-031): "Test chain" beside test tokens, so they never read as money. */
export function Src({ kind }: { kind: SourceKind }) {
  return <span className="src" data-source={kind} title={SOURCES[kind].says}>{SOURCES[kind].label}</span>
}
/**
 * What the money figures on this page come from, under its content, in the words of src/lib/sources.ts. One note per
 * page (App), from the registry that a scan keeps complete; nothing on the page can claim a source it is not listed with.
 */
export function SourceNote({ path }: { path: string }) {
  const kinds = sourcesOfPath(path)
  if (!kinds.length) return null
  return (
    <aside className="source-note" aria-label="Where the figures on this page come from" data-source-note>
      <h2 className="source-note-h">Where these figures come from</h2>
      <ul>{kinds.map((k) => <li key={k}><Src kind={k} /> <span>{SOURCES[k].says}</span></li>)}</ul>
    </aside>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? <span className="hint" id={`${id}-h`}>{hint}</span> : null}
      {children({ id, ...(error ? { 'aria-invalid': true } : {}), ...(hint || error ? { 'aria-describedby': `${error ? `${id}-e ` : ''}${hint ? `${id}-h` : ''}`.trim() } : {}) })}
      {error ? <span className="err" id={`${id}-e`}>{error}</span> : null}
    </div>
  )
}

/**
 * A password, with a button that shows or hides it (sign-in, sign-up, and changing a password under Security). The
 * button is named after its field ("Show the new password"), so two in one form are told apart.
 */
export function PasswordField({ label = 'Password', value, onChange, show, onShow, autoComplete, error, hint }: { label?: string; value: string; onChange: (v: string) => void; show: boolean; onShow: (v: boolean) => void; autoComplete: string; error?: string; hint?: string }) {
  const what = label.toLowerCase()
  return (
    <Field label={label} hint={hint} error={error}>{(p) => (
      <div className="pw">
        <input {...p} className="input" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="icon-btn" aria-label={show ? `Hide the ${what}` : `Show the ${what}`} aria-pressed={show} onClick={() => onShow(!show)}>{show ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>
      </div>
    )}</Field>
  )
}

/** Rupee amount entry. The value is paise or null; the text the person typed is kept until it parses. */
export function MoneyInput({ value, onChange, ...p }: { value: number | null; onChange: (paise: number | null) => void; id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; placeholder?: string }) {
  // Shown grouped the Indian way (8,00,000) when it is not being typed; typing keeps exactly what the person types.
  const [text, setText] = useState(value === null ? '' : grouped(value))
  const last = useRef(value)
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value === null ? '' : grouped(value)) } }, [value])
  return (
    <div className="money">
      <input className="input" inputMode="decimal" autoComplete="off" {...p} value={text}
        onChange={(e) => { setText(e.target.value); const v = e.target.value.trim() === '' ? null : rupeesToPaise(e.target.value); last.current = v; onChange(v) }}
        onBlur={() => { if (last.current !== null) setText(grouped(last.current)) }} />
    </div>
  )
}
/** Rupees from paise with Indian grouping and no rupee sign, for a field the person may edit: 8,00,000 or 2,450.50. */
function grouped(paise: number): string {
  const r = paiseToRupees(paise)
  const [whole, frac] = r.split('.')
  // the lakh grouping is the rupee's alone: every other home currency groups in threes
  const w = homeCurrency() !== 'INR' ? whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole!.length > 3 ? `${whole!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole!.slice(-3)}` : whole!
  return frac ? `${w}.${frac}` : w
}

export function Sheet({ open, title, onClose, children, foot }: { open: boolean; title: string; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  // the elements around the control that opened the sheet, nearest first: after an approval that control is often
  // gone (its card re-rendered, or replaced once the data reloads), and focus then goes to the nearest of these
  const around = useRef<Element[]>([])
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      opener.current = document.activeElement
      around.current = []
      for (let e = opener.current?.parentElement ?? null; e && e !== document.body; e = e.parentElement) around.current.push(e)
      d.showModal()
    }
    if (!open && d.open) d.close()
    // The browser gives focus back to whatever had it when the sheet opened. If that was lost, put it back by hand, or,
    // when that control no longer exists, on the nearest part of the page that does (its heading, or the part itself),
    // so that closing a sheet never leaves a keyboard user at the top of the page (R12 task comparison, WCAG 2.4.3).
    if (!open && opener.current) {
      const o = opener.current as HTMLElement, near = around.current
      opener.current = null
      const lost = () => document.activeElement === document.body || document.activeElement === null
      const land = () => {
        if (!lost()) return
        if (o.isConnected && o !== document.body) { o.focus(); return }
        const part = near.find((e) => e.isConnected) as HTMLElement | undefined
        if (!part) return
        const target = part.querySelector<HTMLElement>('h2, h3') ?? part
        if (!target.matches('a, button, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1')
        target.focus()
      }
      land()
      // the outcome often arrives a moment later, replacing what had focus: look again once it has
      window.setTimeout(land, 700)
    }
  }, [open])
  const hid = useId()
  return (
    // The dialog's "close" event is queued when it closes. If the sheet is opened again before that event arrives (a quick
    // Enter right after closing), the stale event must not close the new one: it is honoured only while the dialog is shut.
    <dialog ref={ref} className="sheet" aria-labelledby={hid} onClose={() => { if (!ref.current?.open) onClose() }} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      {open ? <>
        <div className="sheet-head"><h2 id={hid}>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button></div>
        <div className="sheet-body stack">{children}</div>
        {foot ? <div className="sheet-foot">{foot}</div> : null}
      </> : null}
    </dialog>
  )
}

/**
 * The money bar (DESIGN.md M14): the parts of one sum at true scale, in a fixed order, on one track. Each part has one
 * material: free to use solid and brightest; kept for what is due hatched; committed (held for orders and payments on hold) slate; this
 * payment (Spend) bronze; taken from what is kept, red; short, a dashed hollow (money that is not there). Parts are
 * told apart by lightness and pattern as well as hue, and stand 3:1 or more against the panel. A gap of the panel
 * separates them, so no part needs an outline, and nothing glows.
 *
 * What QED may move is a span, not a part: a tide line with end ticks under the right end of the part it may come from
 * (the free part), as wide as the most it may move. A part with a value under the bar's resolution is drawn 4 px wide
 * so it can be seen; the figures beside the bar are exact. The bar is one image with a sentence that says all of it
 * (`label`); its key, when shown, is that sentence's visible form and is hidden from a screen reader.
 */
export type PartTone = 'free' | 'kept' | 'held' | 'pay' | 'over' | 'short'
export interface BarPart { tone: PartTone; value: number; reach?: number }
export interface BarKey { tone?: PartTone | 'reach'; text: ReactNode }
export function MoneyBar({ parts, label, keys, className }: { parts: BarPart[]; label: string; keys?: BarKey[]; className?: string }) {
  const shown = parts.filter((p) => p.value > 0)
  const reach = shown.some((p) => (p.reach ?? 0) > 0)
  return (
    <div className={`mbar${reach ? ' has-reach' : ''}${className ? ` ${className}` : ''}`}>
      <div className="mbar-row" role="img" aria-label={label}>
        {shown.length === 0 ? <span className="mbar-part none" /> : shown.map((p, i) => (
          <span key={`${p.tone}-${i}`} className={`mbar-part ${p.tone}`} style={{ flexGrow: p.value }}>
            {p.reach && p.reach > 0 ? <span className="mbar-reach" style={{ width: `${Math.min(100, (p.reach / p.value) * 100).toFixed(3)}%` }} /> : null}
          </span>
        ))}
      </div>
      {keys?.length ? <p className="mbar-key" aria-hidden="true">{keys.map((k, i) => <span key={i}>{k.tone ? <Swatch tone={k.tone} /> : null}<span>{k.text}</span></span>)}</p> : null}
    </div>
  )
}
/** A part's material, small, beside the words that name it (a tile's label, a term, a key). */
export const Swatch = ({ tone }: { tone: PartTone | 'reach' }) => <i className={`mbar-sw ${tone}`} aria-hidden="true" />

export const WHO: Record<string, [string, string]> = { you: ['You', 'by-you'], qed: ['QED', 'by-qed'], bank: ['Your bank', 'muted'], employer: ['Your employer', 'muted'], client: ['Paper client', 'muted'], rail: ['The payment rail', 'muted'], payee: ['The payee', 'muted'], 'fund house': ['The fund house', 'muted'] }

/**
 * One vocabulary for where an action stands, in the order it moves (R11, the owner's list: proposed, awaiting approval,
 * submitted, pending, completed, rejected, failed). "Refused" is always QED's own guard saying no before anything was
 * sent; "Rejected" is the bank, rail or venue saying no after it was sent. STATUS_GLOSSARY says each one in a sentence.
 */
const STATE_WORDS: Record<string, [string, 'ok' | 'wait' | 'void' | 'plain' | undefined]> = {
  planned: ['Being checked', undefined], awaiting_approval: ['Awaiting your approval', 'wait'], held: ['On hold', 'wait'], submitting: ['Submitted', undefined], working: ['Pending', undefined], done: ['Completed', 'ok'], partial: ['Partly completed', 'wait'],
  rejected: ['Rejected by the venue', 'void'], failed: ['Failed', 'void'], cancelled: ['Cancelled', 'plain'], expired: ['Expired', 'plain'], blocked: ['Refused by QED\'s checks', 'void'],
  due: ['Starting', undefined], objection_window: ['Announced', 'wait'], executing: ['Running', undefined], skipped: ['Nothing to do', 'plain'], missed: ['Missed', 'void'],
  active: ['In force', 'ok'], paused: ['Paused', 'wait'], draft: ['Draft', 'plain'], completed: ['Ended', 'plain'], revoked: ['Revoked', 'void'],
}
/**
 * How an action ended. When the venue's own record does not agree with the ledger, the outcome is not shown as a plain
 * "done": the money moved, and the books disagree about it, and both are said in one stamp.
 */
/** A finished action whose venue or rail record differs from the ledger is never shown as done (R7-095). */
export const needsAttention = (state: string, recon?: string | null): boolean => recon === 'break' && (state === 'done' || state === 'partial')
export const NEEDS_ATTENTION = 'Needs attention: the venue\'s record differs'
export function StateStamp({ state, recon }: { state: string; recon?: string | null }) {
  const s = STATE_WORDS[state] ?? [state, undefined]
  if (needsAttention(state, recon)) return <Stamp tone="void">{NEEDS_ATTENTION}</Stamp>
  return <Stamp tone={s[1]}>{s[0]}</Stamp>
}
export const stateWord = (state: string): string => (STATE_WORDS[state] ?? [state])[0]
/** Each status word in one sentence, in the order an action moves; shown where actions are listed (Activity). */
export const STATUS_GLOSSARY: [string, string][] = [
  ['Proposed', 'QED or Ask has drafted it for you to look at. Nothing is checked, signed or sent until you take it up.'],
  ['Being checked', 'QED\'s checks are running on it. Nothing has been sent.'],
  ['Awaiting your approval', 'It passed the checks and waits for your passkey. Nothing moves unless you approve it.'],
  ['On hold', 'You approved it, and it waits a stated time before it is sent: a large first-day payment to a new payee. Its money is set aside, and you can cancel it until then.'],
  ['Submitted', 'Sent to the bank, rail, venue or chain; no answer yet.'],
  ['Pending', 'Accepted there and not finished yet, such as a NEFT batch or an order resting at the venue.'],
  ['Completed', 'Finished, with its receipt kept. Partly completed: only part was done; the rest did not happen.'],
  ['Refused by QED\'s checks', 'One of QED\'s own checks said no before anything was sent. Nothing moved.'],
  ['Rejected by the venue', 'The bank, rail or venue said no after it was sent. Money it held comes back.'],
  ['Failed', 'Something went wrong while it was being done. The record says what, and what moved.'],
  ['Cancelled or expired', 'Stopped by you or by its own time limit before it was done.'],
  ['Needs attention', 'It finished, but the venue\'s own record differs from QED\'s books. Never shown as completed.'],
]
