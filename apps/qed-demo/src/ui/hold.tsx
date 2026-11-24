/**
 * Hold to approve (DESIGN.md M8), with the behaviour of the supplied "Hold to confirm" experiment (dqnamo.com), written for QED and not copied from it: a fill crosses
 * the button while it is held and runs back the moment it is let go. It is a deliberate gesture, not an authorisation:
 * when the hold completes, `onConfirm` asks the passkey, and only the passkey's signature over the exact terms approves.
 *
 *  - Pointer: the press is captured; moving more than 8 px outside the button, lifting early, or the browser taking the
 *    pointer away cancels it.
 *  - Keyboard: Enter or Space held down works the same; releasing early cancels.
 *  - Untimed: the one-step control beside it ("… with your passkey") does the same with one press (WCAG 2.2.1, 2.5.1), and
 *    a click that arrives without a hold (a screen reader's activation), or a press let go before the fill completes,
 *    says so, shown and announced, instead of doing nothing silently (R12 task comparison, gap 19). Moving off the
 *    button or leaving it cancels quietly: that is a choice, not a slip.
 *  - Bound to the terms: `termsKey` (the document's fingerprint) resets a hold in progress if the terms change under it.
 *  - Once: a completed hold cannot fire again until `onConfirm` settles (`busy`), and never twice for one press.
 */
import { Fingerprint } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'

type State = 'idle' | 'holding' | 'done'
const HINT = 'Hold the button down until it fills, or use the one-step button below it.'

export function HoldButton({ label, onConfirm, disabled, busy, duration = 900, termsKey, describedBy }: {
  label: string; onConfirm: () => void; disabled?: boolean; busy?: boolean; duration?: number; termsKey: string; describedBy?: string
}) {
  const [state, setState] = useState<State>('idle')
  const [hint, setHint] = useState(false)
  const timer = useRef<number | null>(null)
  const pointer = useRef<number | null>(null)
  const holding = useRef(false)
  const fired = useRef(false)
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const clear = useCallback(() => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null } }, [])
  const cancel = useCallback(() => { if (!holding.current) return; holding.current = false; pointer.current = null; clear(); setState('idle') }, [clear])
  // let go too soon: cancelled, and told how to finish
  const release = useCallback(() => { if (!holding.current) return; cancel(); setHint(true) }, [cancel])
  const complete = useCallback(() => {
    if (!holding.current || fired.current) return
    holding.current = false; fired.current = true; clear(); setState('done')
    try { navigator.vibrate?.(12) } catch { /* not every device */ }
    onConfirm()
  }, [clear, onConfirm])
  const start = useCallback(() => {
    if (disabled || busy || holding.current || fired.current) return
    holding.current = true; setHint(false); setState('holding')
    timer.current = window.setTimeout(complete, duration)
  }, [busy, complete, disabled, duration])

  // a new document (new terms, a refreshed price) or the end of the attempt makes the button ready again
  useEffect(() => { cancel(); fired.current = false; setState('idle') }, [termsKey, cancel])
  useEffect(() => { if (!busy && state === 'done') { fired.current = false; setState('idle') } }, [busy, state])
  useEffect(() => { if (disabled) cancel() }, [disabled, cancel])
  useEffect(() => () => clear(), [clear])

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary || e.button !== 0) return
    pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); start()
  }
  const moveOut = (e: PointerEvent<HTMLButtonElement>) => {
    if (!holding.current || pointer.current !== e.pointerId) return
    const r = e.currentTarget.getBoundingClientRect(), pad = 8
    if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) { cancel(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }
  }
  const up = (e: PointerEvent<HTMLButtonElement>) => { if (pointer.current === e.pointerId) { release(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } }
  const taken = (e: PointerEvent<HTMLButtonElement>) => { if (pointer.current === e.pointerId) cancel() }
  const keyDown = (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); if (!e.repeat) start() }
  const keyUp = (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); release() }
  // a click with no hold behind it (detail 0 is a keyboard or assistive activation) explains rather than acting
  const click = () => { if (state === 'idle' && !holding.current && !fired.current) setHint(true) }

  const fillStyle = { clipPath: state === 'idle' ? 'inset(0 100% 0 0)' : 'inset(0 0 0 0)', transition: `clip-path ${state === 'holding' ? `${reduced ? 0 : duration}ms linear` : state === 'done' ? '0ms' : '200ms cubic-bezier(.23,1,.32,1)'}` }
  return (
    <span className="hold-wrap">
      <button type="button" className={`btn fill lg hold ${busy ? 'busy' : ''}`} data-state={state} disabled={disabled} aria-busy={busy || undefined}
        aria-describedby={describedBy} onPointerDown={down} onPointerMove={moveOut} onPointerUp={up} onPointerCancel={taken} onLostPointerCapture={cancel}
        onKeyDown={keyDown} onKeyUp={keyUp} onBlur={cancel} onClick={click} onContextMenu={(e) => e.preventDefault()}>
        <span className="hold-fill" style={fillStyle} aria-hidden="true" />
        <span className="hold-label"><Fingerprint aria-hidden="true" />{busy ? 'Waiting for your passkey' : state === 'holding' ? 'Keep holding' : label}</span>
      </button>
      {hint ? <span className="hold-hint" aria-hidden="true">{HINT}</span> : null}
      {/* the live region is there before its words, so the hint is announced each time it appears */}
      <span className="sr" role="status">{hint ? HINT : ''}</span>
    </span>
  )
}
