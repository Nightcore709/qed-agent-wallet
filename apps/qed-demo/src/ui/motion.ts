/**
 * Motion and atmosphere for Meridian (DESIGN.md M5). Four things, all optional to the content:
 *
 *  - Arrival: when a page is opened, its blocks (panels, the page head, documents, tables) rise into place in reading
 *    order, 60 ms apart; blocks below the fold wait and arrive as they are scrolled to, so information unfolds down the
 *    page. A block is never hidden from assistive technology, find-in-page or print, and with reduced motion nothing waits.
 *  - The section's light: the atmosphere's colours glide to the section's (base.css, html[data-section]).
 *  - The dock's indicator: a drop of lit glass whose leading edge travels first (shell.css .dock-ind).
 *  - Effects level: "plain" (no frosting, no drifting lights) on a device that asks for less data, has little memory or
 *    few cores, or when the person chooses it; their choice wins either way.
 *
 * Nothing here signals a financial outcome: a figure resolves into focus when it is shown, it never counts up.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'

const BLOCKS = '.page-head, .secnav, .panel, .card, .tablet, .instrument, .ledger-wrap, .plain-list, .weeks, .empty-state, .note, .crumb, [data-block]'

const reduced = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The outermost blocks of a page, in document order (a panel inside a panel moves with its parent). */
function blocksIn(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(BLOCKS))
  return all.filter((el) => { const up = el.parentElement?.closest(BLOCKS); return !up || !root.contains(up) })
}

/**
 * Arrival for the page under `root`, run when `key` changes (a new page) and again when the page first draws its
 * content (`ready`): pages that wait for data arrive when the data does, not as an empty frame.
 */
export function useArrival(root: React.RefObject<HTMLElement | null>, key: string): void {
  const seen = useRef(new WeakSet<Element>())
  const io = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return undefined
    seen.current = new WeakSet()
    if (reduced()) return undefined
    let batch = 0
    io.current = new IntersectionObserver((entries) => {
      let i = 0
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const b = e.target as HTMLElement
        io.current?.unobserve(b)
        b.removeAttribute('data-pending')
        b.style.setProperty('--i', String(i++))
        b.setAttribute('data-arrive', '')
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 })
    const vh = window.innerHeight
    const sweep = () => {
      for (const b of blocksIn(el)) {
        if (seen.current.has(b)) continue
        seen.current.add(b)
        const top = b.getBoundingClientRect().top
        if (top < vh * 0.94) { b.style.setProperty('--i', String(batch++)); b.setAttribute('data-arrive', '') }
        else { b.setAttribute('data-pending', ''); io.current?.observe(b) }
      }
    }
    sweep()
    // a page that draws in stages (its data arrives after the first frame) adds blocks: they arrive in turn, for the
    // first few seconds; after that a block that appears (a live update) simply appears
    let queued = 0
    const mo = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; sweep() }) })
    mo.observe(el, { childList: true, subtree: true })
    const settle = window.setTimeout(() => mo.disconnect(), 5000)
    // whatever is still waiting is shown before printing
    const print = () => el.querySelectorAll('[data-pending]').forEach((b) => b.removeAttribute('data-pending'))
    window.addEventListener('beforeprint', print)
    // a block arrives once: its animation is removed when it ends, so a later re-render cannot replay it
    const done = (e: AnimationEvent) => { const t = e.target as HTMLElement; if (e.animationName === 'arrive' && t.hasAttribute('data-arrive')) { t.removeAttribute('data-arrive'); t.style.removeProperty('--i') } }
    el.addEventListener('animationend', done)
    return () => { mo.disconnect(); window.clearTimeout(settle); cancelAnimationFrame(queued); io.current?.disconnect(); window.removeEventListener('beforeprint', print); el.removeEventListener('animationend', done) }
  }, [root, key])
}

/** The section a path belongs to, for the atmosphere's light. */
export function sectionOf(path: string): string {
  if (path === '/' || path === '') return 'home'
  if (path.startsWith('/pay')) return 'spend'
  if (path.startsWith('/save') || path.startsWith('/passbook')) return 'save'
  if (path.startsWith('/holdings')) return 'grow'
  if (path.startsWith('/earn')) return 'earn'
  if (path.startsWith('/ask')) return 'ask'
  if (['/activity', '/record', '/receipts', '/evidence', '/judge'].some((p) => path.startsWith(p))) return 'activity'
  return 'protect'
}
type Root = Pick<HTMLElement, 'dataset' | 'style'>
/**
 * Put the atmosphere's light on a section. Between sections the lights glide (base.css: the root transitions the
 * registered --glow-a/b/c over 1.1 s). The first section a page opens on is placed at once: there is nowhere to glide
 * from, and because the lights are inherited, every element on the page is restyled on every frame of a glide, which
 * on a phone kept the main thread busy for the 1.1 s in which the page became usable (R12 perf, Protect on the phone
 * profile: a press then waited 75 to 110 ms before it was handled). Transitions are off for the one style change, the
 * new colours are taken (`settle` reads the computed style), and transitions are back for the next section.
 */
export function placeSection(root: Root, section: string, glide: boolean, settle: (root: Root) => void = (r) => { getComputedStyle(r as HTMLElement).getPropertyValue('--glow-a') }): void {
  if (glide || root.dataset.section === section) { root.dataset.section = section; return }
  root.style.transition = 'none'
  root.dataset.section = section
  settle(root)
  root.style.removeProperty('transition')
}
let placed = false
export function useSection(path: string): void {
  useEffect(() => { placeSection(document.documentElement, sectionOf(path), placed); placed = true }, [path])
}

/** The dock's indicator: under the current section's item, its leading edge moving first. */
export function useDockIndicator(nav: React.RefObject<HTMLElement | null>, current: string): void {
  const last = useRef<number | null>(null)
  useLayoutEffect(() => {
    const n = nav.current
    const ind = n?.querySelector<HTMLElement>('.dock-ind')
    if (!n || !ind) return undefined
    const place = (animate: boolean) => {
      // the current item this size shows (a phone shows More where a computer shows Save)
      const cur = Array.from(n.querySelectorAll<HTMLElement>('a[aria-current="page"]')).find((a) => a.offsetParent !== null)
      if (!cur) { ind.removeAttribute('data-ready'); return }
      const left = cur.offsetLeft, right = n.clientWidth - (cur.offsetLeft + cur.offsetWidth)
      if (animate && last.current !== null && last.current !== left) ind.dataset.moving = left > last.current ? 'right' : 'left'
      else delete ind.dataset.moving
      last.current = left
      ind.style.setProperty('--l', `${left}px`); ind.style.setProperty('--r', `${right}px`)
      ind.setAttribute('data-ready', '')
    }
    place(!reduced())
    const ro = new ResizeObserver(() => place(false))
    ro.observe(n)
    return () => ro.disconnect()
  }, [nav, current])
}

/** The effects level: the person's choice, else plain on a device that asks for less. */
export type Fx = 'auto' | 'full' | 'plain'
export const readFx = (): Fx => { try { const v = localStorage.getItem('qed-fx'); return v === 'full' || v === 'plain' ? v : 'auto' } catch { return 'auto' } }
export function applyFx(choice: Fx = readFx()): void {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  const weak = (nav.hardwareConcurrency ?? 8) <= 2 || (nav.deviceMemory ?? 8) <= 2 || !!nav.connection?.saveData
  const plain = choice === 'plain' || (choice === 'auto' && weak) || (typeof CSS !== 'undefined' && !CSS.supports('backdrop-filter', 'blur(1px)') && !CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))
  if (plain) document.documentElement.dataset.fx = 'plain'; else delete document.documentElement.dataset.fx
}
export function setFx(choice: Fx): void {
  try { if (choice === 'auto') localStorage.removeItem('qed-fx'); else localStorage.setItem('qed-fx', choice) } catch { /* a private window keeps it for this page */ }
  applyFx(choice)
}
