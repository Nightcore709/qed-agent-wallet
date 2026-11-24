/**
 * R13 S8: an Indian household's text is byte for byte what it was before every money call moved to the home-currency
 * formatter. The golden file (server/screen-text.golden.txt) was written by the build before the move, from the journey in
 * screen-text-fixture.ts read through the screens' own view functions; UPDATE_GOLDEN=1 rewrites it (only ever from a build whose
 * text is known good).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flatten, runJourney, screenViews } from './screen-text-fixture.ts'
import { makeKit } from './testkit.ts'

const GOLDEN = join(import.meta.dirname, 'screen-text.golden.txt')

describe('the Indian household reads the same text', () => {
  it('every screen view of the journey equals the golden text', async () => {
    const k = makeKit()
    await runJourney(k)
    const text = flatten(screenViews(k)).join('\n') + '\n'
    expect(text.split('\n').filter((l) => l.includes('₹')).length).toBeGreaterThan(20)
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) { writeFileSync(GOLDEN, text); return }
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'))
  })
})
