/**
 * The folders' art (folder-art.ts) is the same picture for the same recipe and seed on every machine, opaque, and made
 * from the colours it is given; the numbers under it are seeded and bounded.
 */
import { describe, expect, it } from 'vitest'
import { noise, paintJob, parseRgb, type Recipe, seeded, textSeed } from './folder-art.ts'

const recipe: Recipe = { colors: [[20, 18, 16], [230, 220, 200], [40, 120, 160]], scale: 1, warp: 3, angle: -0.5, gloss: 0.4 }
const finish = (seed: number) => { const job = paintJob(24, 18, recipe, seed); let done = false; for (let i = 0; i < 100 && !done; i++) done = job.step(4); return { job, done } }

describe('the folders\' art', () => {
  it('draws the same numbers for the same seed, each in [0, 1)', () => {
    const a = seeded(7), b = seeded(7)
    const xs = Array.from({ length: 50 }, () => a())
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()))
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(seeded(8)()).not.toBe(xs[0])
    expect(textSeed('receipts')).toBe(textSeed('receipts'))
    expect(textSeed('receipts')).not.toBe(textSeed('evidence'))
  })

  it('makes gradient noise that is zero on the lattice and bounded between it', () => {
    expect(noise(3, 7, 11)).toBe(0)
    let lo = 0, hi = 0
    for (let i = 0; i < 2000; i++) { const v = noise(i * 0.173, i * 0.311, 5); lo = Math.min(lo, v); hi = Math.max(hi, v) }
    expect(lo).toBeGreaterThan(-1); expect(hi).toBeLessThan(1); expect(hi - lo).toBeGreaterThan(0.5)
  })

  it('paints an opaque picture, the same for the same seed and a different one for another', () => {
    const one = finish(3), again = finish(3), other = finish(4)
    expect(one.done).toBe(true)
    expect(one.job.pixels).toHaveLength(24 * 18 * 4)
    expect(Array.from(one.job.pixels).filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true)
    expect(Array.from(again.job.pixels)).toEqual(Array.from(one.job.pixels))
    expect(Array.from(other.job.pixels)).not.toEqual(Array.from(one.job.pixels))
  })

  it('reads a colour the browser has resolved, dropping its alpha', () => {
    expect(parseRgb('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseRgb('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30])
    expect(parseRgb('oklch(50% .1 20)')).toBeNull()
  })
})
