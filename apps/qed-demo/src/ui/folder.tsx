/**
 * Glass folders (DESIGN.md M1, "Glass Folder Cards", adapted for QED's records): a shelf of folders, one per kind of
 * record (receipts, evidence cases, signed instructions, the on-chain wallet's records), each an object of three
 * layers: a back panel holding generated art (folder-art.ts), the files themselves, and a frosted glass front on a
 * bottom hinge. The files are real links to real records, frosted by the glass until the folder is opened.
 *
 *  - Rest: closed; the tops of the files show through the thumb cut in the glass.
 *  - Hover or focus: the glass leans forward on its hinge and the files lift a little.
 *  - Open (press the folder, Enter or Space): the glass falls further and the files rise and fan, each a link with its
 *    name, when and how it ended. Escape, a press outside or the folder again closes it; arrow keys move between files.
 *  - A record that arrives while the page is open drops into its folder and the count rolls over to the new figure.
 *  - The key at the corner goes to the full list of that kind of record.
 *
 * The same contents are one press away as a plain list ("List"), which is also what the folders say to a screen
 * reader: the folder is a button that says its name and count, and its files are a list that is inert while closed.
 * Reduced motion: nothing moves (base.css); the folder still opens. The plain look (html[data-fx="plain"]), reduced
 * transparency and forced colours: no art, no frosting, opaque glass.
 */
import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { artAllowed, paint, type Recipe, textSeed, themeColors } from './folder-art.ts'
import { Link, Seal } from './kit.tsx'

export interface FolderFile {
  id: string
  /** The file's name: what the record is. */
  name: string
  /** Its second line: when, and how it ended. */
  meta?: string
  /** A figure set at the end of the file's head (an amount, a count). */
  figure?: string
  /** How it ended, for the small mark beside the meta. */
  tone?: 'ok' | 'void' | 'wait' | 'plain'
  to: string
}
/** The art on a folder's back panel: custom properties of tokens.css, in the order the field passes through them. */
export interface FolderArt { palette: readonly string[]; warp?: number; scale?: number; angle?: number; gloss?: number; streak?: boolean }
export interface Folder {
  kind: string
  name: string
  /** The figure on the front: "2 kept", "11 cases". */
  count: string
  /** One more fact on the front: "Chain intact". */
  note?: string
  noteTone?: 'ok' | 'void' | 'wait'
  /** The note is a check QED made and passed: it carries the seal. */
  sealed?: boolean
  /** What this kind of record is, in one sentence (the list view and the folder's description). */
  describe: string
  /** Newest first; the folder shows the first four. */
  files: FolderFile[]
  /** Where every record of this kind is. */
  all: { to: string; label: string }
  icon: LucideIcon
  art: FolderArt
  /** Still being read, or could not be read (the count says so in words). */
  state?: 'loading' | 'error'
}

const SHOWN = 4
const VIEW_KEY = 'qed-records-view'
const readView = (): 'folders' | 'list' => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'folders' } catch { return 'folders' } }
const reduced = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The shapes, in a box one unit wide and one tall (clipPathUnits="objectBoundingBox"). The back panel is 100 by 80 with
 * a tab on its left; the glass front is 100 by 58 with a thumb cut at the middle of its top edge, where the files show.
 * The corners are 6 units round in both directions, which in a box of fixed proportions stays round.
 */
const BACK = (() => { const X = (x: number) => +(x / 100).toFixed(5), Y = (y: number) => +(y / 80).toFixed(5), rx = X(6), ry = Y(6)
  return `M0 ${Y(6)}A${rx} ${ry} 0 0 1 ${X(6)} 0L${X(28)} 0C${X(34)} 0 ${X(34)} ${Y(8)} ${X(40)} ${Y(8)}L${X(94)} ${Y(8)}A${rx} ${ry} 0 0 1 1 ${Y(14)}L1 ${Y(74)}A${rx} ${ry} 0 0 1 ${X(94)} 1L${X(6)} 1A${rx} ${ry} 0 0 1 0 ${Y(74)}Z` })()
const FRONT = (() => { const X = (x: number) => +(x / 100).toFixed(5), Y = (y: number) => +(y / 58).toFixed(5), rx = X(6), ry = Y(6)
  return `M0 ${Y(6)}A${rx} ${ry} 0 0 1 ${X(6)} 0L${X(37)} 0C${X(42)} 0 ${X(43)} ${Y(6)} ${X(50)} ${Y(6)}C${X(57)} ${Y(6)} ${X(58)} 0 ${X(63)} 0L${X(94)} 0A${rx} ${ry} 0 0 1 1 ${Y(6)}L1 ${Y(52)}A${rx} ${ry} 0 0 1 ${X(94)} 1L${X(6)} 1A${rx} ${ry} 0 0 1 0 ${Y(52)}Z` })()
/** The same shapes at the size they are drawn (100 by 80 and 100 by 58), for the lit rims. */
const scaled = (d: string, w: number, h: number): string => d.replace(/([AMLCZ])([^AMLCZ]*)/g, (_, c: string, args: string) => {
  const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : []
  if (c === 'A') return `A${n[0]! * w} ${n[1]! * h} ${n[2]} ${n[3]} ${n[4]} ${n[5]! * w} ${n[6]! * h}`
  return c + n.map((v, i) => (i % 2 === 0 ? v * w : v * h)).map((v) => +v.toFixed(3)).join(' ')
})
const BACK_RIM = scaled(BACK, 100, 80), FRONT_RIM = scaled(FRONT, 100, 58)

/** The shelf: a head with the view switch, then the folders (or the same contents as a plain list). */
export function FolderShelf({ title, intro, folders }: { title: string; intro: ReactNode; folders: Folder[] }) {
  const hid = useId()
  const [view, setView] = useState<'folders' | 'list'>(readView)
  const [open, setOpen] = useState<string | null>(null)
  // the first time the shelf is on screen each folder assembles itself, one after another; at once with reduced motion
  const shelf = useRef<HTMLUListElement>(null)
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const el = shelf.current
    if (entered || !el) return undefined
    if (reduced() || typeof IntersectionObserver === 'undefined') { setEntered(true); return undefined }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); setEntered(true) } }, { threshold: 0.2 })
    io.observe(el)
    const print = () => setEntered(true)
    window.addEventListener('beforeprint', print)
    return () => { io.disconnect(); window.removeEventListener('beforeprint', print) }
  }, [entered, view])
  const choose = (v: 'folders' | 'list') => { setView(v); setOpen(null); try { localStorage.setItem(VIEW_KEY, v) } catch { /* kept for this page only */ } }
  return (
    <section className="fold-room" aria-labelledby={hid} data-block="">
      <svg className="fold-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id="fold-back" clipPathUnits="objectBoundingBox"><path d={BACK} /></clipPath>
          <clipPath id="fold-front" clipPathUnits="objectBoundingBox"><path d={FRONT} /></clipPath>
        </defs>
      </svg>
      <div className="fold-room-head">
        <h2 id={hid}>{title}</h2>
        <div className="seg fold-view" role="group" aria-label="Show the records as">
          <button type="button" aria-pressed={view === 'folders'} onClick={() => choose('folders')}>Folders</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => choose('list')}>List</button>
        </div>
        <p>{intro}</p>
      </div>
      {view === 'folders'
        ? <ul ref={shelf} className="fold-shelf" data-n={folders.length} data-entered={entered || undefined} aria-label={title}>{folders.map((f, i) => <GlassFolder key={f.kind} f={f} index={i} open={open === f.kind} onOpen={(o) => setOpen(o ? f.kind : null)} />)}</ul>
        : <FolderList folders={folders} />}
    </section>
  )
}

/** The plain equivalent: each kind of record with its figure, what it is, its latest records and the way to all of them. */
function FolderList({ folders }: { folders: Folder[] }) {
  return (
    <div className="fold-list">
      {folders.map((f) => (
        <section key={f.kind} className="panel fold-list-group" aria-labelledby={`fold-list-${f.kind}`}>
          <div className="fold-list-head">
            <span className="fold-list-icon" aria-hidden="true"><f.icon /></span>
            <h3 id={`fold-list-${f.kind}`}>{f.name}</h3>
            <p className="fold-list-count">{f.count}{f.note ? <span className={`fold-list-note ${f.noteTone ?? ''}`}>{f.sealed ? <Seal /> : null}{f.note}</span> : null}</p>
          </div>
          <p className="fold-list-says">{f.describe}</p>
          {f.files.length ? (
            <ul className="fold-list-files">{f.files.slice(0, SHOWN).map((x) => (
              <li key={x.id}><Link to={x.to}>{x.name}</Link>{x.meta ? <span className="fold-list-meta">{x.meta}</span> : null}{x.figure ? <span className="fold-list-fig">{x.figure}</span> : null}</li>
            ))}</ul>
          ) : <p className="fold-list-none">{f.state === 'loading' ? 'Reading…' : 'None yet.'}</p>}
          <p className="fold-list-all"><Link to={f.all.to}>{f.all.label}</Link></p>
        </section>
      ))}
    </div>
  )
}

/** The art for one folder, painted when the folder first shows and again when the theme or the effects level change. */
function useArt(canvas: RefObject<HTMLCanvasElement | null>, art: FolderArt, seed: number): void {
  const [look, setLook] = useState(0)
  useEffect(() => {
    const again = () => setLook((n) => n + 1)
    const dark = matchMedia('(prefers-color-scheme: dark)')
    dark.addEventListener('change', again)
    const mo = new MutationObserver(again)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-fx'] })
    return () => { dark.removeEventListener('change', again); mo.disconnect() }
  }, [])
  const key = JSON.stringify(art)
  useEffect(() => {
    const c = canvas.current
    if (!c) return undefined
    if (!artAllowed()) { c.removeAttribute('data-ready'); return undefined }
    const a = JSON.parse(key) as FolderArt
    const colors = themeColors(a.palette)
    if (colors.length < 2) return undefined
    const recipe: Recipe = { colors, scale: a.scale ?? 1, warp: a.warp ?? 3, angle: a.angle ?? -0.5, gloss: a.gloss ?? 0.45, streak: a.streak ?? false }
    let live = true
    // a small picture, drawn larger: the forms are soft and most of it is seen through frosted glass
    void paint(recipe, seed, 180, 144).then((src) => {
      if (!live) return
      c.width = src.width; c.height = src.height
      c.getContext('2d')?.drawImage(src, 0, 0)
      c.setAttribute('data-ready', '')
    })
    return () => { live = false }
  }, [canvas, key, seed, look])
}

function GlassFolder({ f, index, open, onOpen }: { f: Folder; index: number; open: boolean; onOpen: (open: boolean) => void }) {
  const root = useRef<HTMLLIElement>(null)
  const hit = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const art = useRef<HTMLCanvasElement>(null)
  const filesId = useId(), descId = useId()
  useArt(art, f.art, textSeed(f.kind))

  // files that arrive after the first reading drop in; the count rolls when it changes
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  // the glass gives a little under a file that drops in; a class, not a new element, so focus on the folder stays put
  const [bumped, setBumped] = useState(false)
  const ids = f.files.slice(0, SHOWN).map((x) => x.id).join('\u0000')
  useEffect(() => {
    if (f.state === 'loading') return
    const now = new Set(ids ? ids.split('\u0000') : [])
    if (seen.current === null) { seen.current = now; return }
    const added = [...now].filter((x) => !seen.current!.has(x))
    seen.current = now
    if (added.length && !reduced()) { setFresh(new Set(added)); setBumped(true) }
  }, [ids, f.state])
  const lastCount = useRef(f.count)
  const [rolled, setRolled] = useState(false)
  useEffect(() => { if (lastCount.current !== f.count) { if (f.state !== 'loading' && lastCount.current !== '') setRolled(true); lastCount.current = f.count } }, [f.count, f.state])

  // the light and the lean follow the pointer (never a finger), on the compositor, without re-rendering
  useEffect(() => {
    const el = root.current
    if (!el || reduced()) return undefined
    let raf = 0, px = 0, py = 0
    const write = () => { raf = 0; el.style.setProperty('--fold-px', px.toFixed(3)); el.style.setProperty('--fold-py', py.toFixed(3)) }
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || document.documentElement.dataset.fx === 'plain') return
      const r = el.getBoundingClientRect()
      px = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)); py = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1))
      if (!raf) raf = requestAnimationFrame(write)
    }
    const leave = () => { px = 0; py = 0; if (!raf) raf = requestAnimationFrame(write) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); cancelAnimationFrame(raf) }
  }, [])

  // closed files are out of the tab order and out of the accessibility tree
  useEffect(() => { list.current?.toggleAttribute('inert', !open) }, [open])

  // Escape closes the open folder and gives focus back to it; a press anywhere else closes it
  useEffect(() => {
    if (!open) return undefined
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && root.current?.contains(document.activeElement)) { onOpen(false); hit.current?.focus() } }
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', down)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down) }
  }, [open, onOpen])

  // arrow keys move between the files of an open folder
  const onFilesKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const links = Array.from(list.current?.querySelectorAll<HTMLElement>('a') ?? [])
    const at = links.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const go = (i: number) => { e.preventDefault(); links[(i + links.length) % links.length]?.focus() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(at + 1)
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(links.length - 1)
  }
  // a press on the paper that shows above the glass opens the folder too (the glass itself is the button)
  const onStage = (e: MouseEvent<HTMLDivElement>) => { if (!open && !(e.target as HTMLElement).closest('a, button')) onOpen(true) }

  const files = f.files.slice(0, SHOWN)
  const n = files.length
  return (
    <li ref={root} className={`fold fold-${f.kind}`} data-open={open || undefined} data-state={f.state} style={{ '--fold-i': index } as CSSProperties}>
      <div className="fold-stage" onClick={onStage}>
        <div className="fold-tilt">
          <div className="fold-shadow" aria-hidden="true" />
          <div className="fold-back" aria-hidden="true"><canvas ref={art} className="fold-art" width={2} height={2} /><span className="fold-sheen" /></div>
          <svg className="fold-rim fold-back-rim" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d={BACK_RIM} /></svg>

          <div className={`fold-front ${bumped ? 'bumped' : ''}`} onAnimationEnd={(e) => { if (e.animationName === 'fold-bump') setBumped(false) }}>
            <span className="fold-tint" aria-hidden="true" />
            <span className="fold-light" aria-hidden="true" />
            <svg className="fold-rim fold-front-rim" viewBox="0 0 100 58" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d={FRONT_RIM} /></svg>
            <button ref={hit} type="button" className="fold-hit" aria-expanded={open} aria-controls={filesId} aria-describedby={descId} onClick={() => onOpen(!open)}>
              <span className="fold-icon" aria-hidden="true"><f.icon /></span>
              <span className="fold-label">
                <span className="fold-name">{f.name}</span>
                <span key={f.count} className={`fold-count ${rolled ? 'rolled' : ''}`}>{f.count}</span>
                {f.note ? <span className={`fold-note ${f.noteTone ?? ''}`}>{f.sealed ? <Seal /> : null}{f.note}</span> : null}
              </span>
            </button>
            <span id={descId} className="sr">{f.describe} {n ? `Opens to the latest ${n === 1 ? 'one' : n}.` : ''}</span>
          </div>

          {/* the contents: after the glass in the reading order, beneath it on the screen */}
          <ul ref={list} id={filesId} className="fold-files" aria-label={`${f.name}, the latest`} onKeyDown={onFilesKey} style={{ '--fold-n': n } as CSSProperties}>
            {n ? files.map((x, i) => (
              <li key={x.id} className={`fold-file ${fresh.has(x.id) ? 'fresh' : ''}`} style={{ '--d': i, '--slot': n <= 1 ? 0 : (i / (n - 1)) * 2 - 1, '--jit': ((textSeed(x.id) % 1000) / 1000 - 0.5).toFixed(3) } as CSSProperties} onAnimationEnd={() => { if (fresh.has(x.id)) setFresh(new Set()) }}>
                <Link to={x.to} className="fold-sheet">
                  <span className="fold-sheet-head"><span className="fold-sheet-name">{x.name}</span>{x.figure ? <span className="fold-sheet-fig">{x.figure}</span> : null}</span>
                  {x.meta ? <span className="fold-sheet-meta">{x.tone ? <i className={`fold-dot ${x.tone}`} aria-hidden="true" /> : null}<span className="fold-sheet-meta-t">{x.meta}</span></span> : null}
                  <span className="fold-lines" aria-hidden="true"><i /><i /><i /></span>
                </Link>
              </li>
            )) : <li className="fold-file empty" style={{ '--d': 0, '--slot': 0, '--jit': 0 } as CSSProperties}><span className="fold-sheet"><span className="fold-sheet-name">{f.state === 'loading' ? 'Reading…' : 'Nothing filed yet'}</span><span className="fold-sheet-meta">{f.describe}</span></span></li>}
          </ul>

          <Link to={f.all.to} className="fold-key"><ArrowUpRight aria-hidden="true" /><span className="sr">{f.all.label}</span></Link>
        </div>
      </div>
    </li>
  )
}
