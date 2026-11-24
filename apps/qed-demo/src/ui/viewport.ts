/**
 * The window as a conversation needs it (Ask, DESIGN.md M3 and M4): whether the window is wide enough for side rails,
 * and how much of it a phone's on-screen keyboard covers. Both are read from the browser as they change; neither is
 * stored anywhere.
 */
import { useEffect, useState } from 'react'

/** True while the window matches the media query, following it as the window changes. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return undefined
    const m = matchMedia(query)
    const change = () => setOn(m.matches)
    change()
    m.addEventListener('change', change)
    return () => m.removeEventListener('change', change)
  }, [query])
  return on
}

/**
 * The height of the window that a phone's on-screen keyboard covers, kept in the CSS variable `--ak-kb` on the root
 * while the component that calls this is on the page. Safari, and Chrome by default, lay the page out as if the
 * keyboard were not there and shrink only the visual viewport, so a control pinned to the bottom of the page would sit
 * under the keyboard; with this, Ask's composer stands on the keyboard's top edge instead. A pinch zoom also shrinks
 * the visual viewport: then nothing is added, since the page is being read, not typed into.
 *
 * Measured in Chromium's emulation only (where the visual and layout viewports are the same, so the inset is 0); the
 * behaviour on a real phone's keyboard is not verified here.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const root = document.documentElement
    if (!vv) return undefined
    let frame = 0
    const measure = () => {
      frame = 0
      // the layout viewport: the larger of the two, as one browser reports the visual height in innerHeight
      const layout = Math.max(window.innerHeight, root.clientHeight)
      const covered = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(layout - vv.height - vv.offsetTop))
      root.style.setProperty('--ak-kb', `${covered}px`)
    }
    const queue = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    vv.addEventListener('resize', queue)
    vv.addEventListener('scroll', queue)
    return () => { cancelAnimationFrame(frame); vv.removeEventListener('resize', queue); vv.removeEventListener('scroll', queue); root.style.removeProperty('--ak-kb') }
  }, [])
}
