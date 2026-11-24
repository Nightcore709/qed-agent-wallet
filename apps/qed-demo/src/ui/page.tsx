/**
 * Page helpers shared by Save, Grow and Safeguards: a region's shape while its data loads, and a link into the page that
 * brings its target into view. Kept outside any one screen so a screen that needs them does not download another
 * screen with them (R12 perf: Grow took these from Safeguards, which brought Instructions, Protect, Security and the
 * on-chain wallet). screens/Safeguards.tsx re-exports both for its other callers.
 */
import { useEffect, useRef } from 'react'

/**
 * A link into the page (/safeguards#household, /holdings#ticket): the router keeps the page at the top, so the target
 * is brought into view here once its content is drawn, and keyboard focus goes to its heading.
 */
export function useHashTarget(ready: boolean, onTarget?: (id: string) => void): void {
  const done = useRef(false)
  const cb = useRef(onTarget)
  cb.current = onTarget
  useEffect(() => {
    if (!ready || done.current) return undefined
    const id = decodeURIComponent(location.hash.slice(1))
    if (!id) return undefined
    done.current = true
    cb.current?.(id)
    const t = setTimeout(() => {
      const el = document.getElementById(id)
      if (!el) return
      el.scrollIntoView({ block: 'start' })
      const h = el.matches('h1, h2, h3') ? el : el.querySelector<HTMLElement>('h2, h3')
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }) }
    }, 60)
    return () => clearTimeout(t)
  }, [ready])
}

/** A region's shape while it loads: the same height it will have, so nothing below it moves when it arrives. */
export const Skel = ({ h, r = 16, className = '' }: { h: number; r?: number; className?: string }) => <div className={`skel ${className}`} style={{ height: h, borderRadius: r }} aria-hidden="true" />
