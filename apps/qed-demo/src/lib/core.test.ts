/**
 * The order a resource's answers are shown in (useData, src/lib/core.ts). The live stream's first hello reloads every
 * resource read before it; on the phone profile that reload went out while Protect's first answers were still on their
 * way, threw them away when they came, and the page's single draw waited for the second round instead (R12: the key
 * figure at 2.98 s against 2.44 s for the same data on R11). An answer that comes first is shown unless a newer one
 * already is; an older one never replaces a newer one; a failure counts only for the latest request; and a new path
 * forgets what was sent for the old one.
 */
import { describe, expect, it } from 'vitest'
import { answerOrder } from './core.ts'

describe('the order a resource shows its answers in', () => {
  it('shows the answer to its only request', () => {
    const o = answerOrder()
    expect(o.data(o.send())).toBe(true)
  })

  it('shows the first answer when a reload went out before it came back, then the reload\'s', () => {
    const o = answerOrder()
    const first = o.send(), reload = o.send()
    expect(o.data(first)).toBe(true)
    expect(o.data(reload)).toBe(true)
  })

  it('never lets an older answer replace a newer one', () => {
    const o = answerOrder()
    const first = o.send(), reload = o.send()
    expect(o.data(reload)).toBe(true)
    expect(o.data(first)).toBe(false)
  })

  it('does not show an earlier request\'s failure while a later request is out', () => {
    const o = answerOrder()
    const first = o.send(), reload = o.send()
    expect(o.error(first)).toBe(false)
    expect(o.data(reload)).toBe(true)
  })

  it('shows the latest request\'s failure, and no older answer after it', () => {
    const o = answerOrder()
    const first = o.send(), reload = o.send()
    expect(o.error(reload)).toBe(true)
    expect(o.data(first)).toBe(false)
  })

  it('after a new path, shows nothing that was sent for the old one', () => {
    const o = answerOrder()
    const old = o.send()
    o.reset()
    const now = o.send()
    expect(o.data(old)).toBe(false)
    expect(o.error(old)).toBe(false)
    expect(o.data(now)).toBe(true)
  })

  it('shows each answer at most once', () => {
    const o = answerOrder()
    const n = o.send()
    expect(o.data(n)).toBe(true)
    expect(o.data(n)).toBe(false)
    expect(o.error(n)).toBe(false)
  })
})
