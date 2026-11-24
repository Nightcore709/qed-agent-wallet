/**
 * The section's light (src/ui/motion.ts placeSection; base.css). The atmosphere's colours are registered, inherited
 * custom properties (tokens.css --glow-a/b/c) that the root element transitions over 1.1 s, so while they glide every
 * element on the page is restyled on every frame. Between sections that is the design: the lights travel. On the first
 * section a page opens on there is nowhere to travel from, and the glide only kept a phone's main thread busy while the
 * page became usable (R12, Protect on the phone profile: about 700 elements restyled a frame, 10 to 13 ms each at a 4x
 * slower CPU, for 1.1 s from when the shell drew; a press in that time waited 75 to 110 ms before it was handled).
 */
import { describe, expect, it } from 'vitest'
import { placeSection } from './motion.ts'

/** A stand-in for the root element that records what is done to it, in order. */
function root(section?: string) {
  const log: string[] = []
  const dataset: Record<string, string> = section ? { section } : {}
  const style = {
    transition: '',
    removeProperty(name: string) { log.push(`remove ${name}`); if (name === 'transition') style.transition = ''; return '' },
  }
  const el = {
    dataset: new Proxy(dataset, { set: (t, k, v) => { log.push(`section ${String(v)} (transition "${style.transition}")`); t[k as string] = v; return true } }),
    style: new Proxy(style, { set: (t, k, v) => { if (k === 'transition') log.push(`transition "${String(v)}"`); (t as Record<string, unknown>)[k as string] = v; return true } }),
  }
  return { el: el as unknown as Parameters<typeof placeSection>[0], log, settle: () => log.push(`settled (transition "${style.transition}")`) }
}

describe('the section\'s light', () => {
  it('places the first section at once: no glide, the new colours taken while transitions are off, then transitions back', () => {
    const r = root()
    placeSection(r.el, 'protect', false, r.settle)
    expect(r.log).toEqual(['transition "none"', 'section protect (transition "none")', 'settled (transition "none")', 'remove transition'])
  })

  it('glides between sections, as designed: only the section changes', () => {
    const r = root('home')
    placeSection(r.el, 'protect', true, r.settle)
    expect(r.log).toEqual(['section protect (transition "")'])
  })

  it('does nothing to the transitions when the section is already the one asked for', () => {
    const r = root('protect')
    placeSection(r.el, 'protect', false, r.settle)
    expect(r.log).toEqual(['section protect (transition "")'])
  })
})
