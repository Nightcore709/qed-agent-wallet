/**
 * The order the interface asks for things as it starts (App.tsx). A browser keeps six connections to one server; the
 * opened screen's code is a dozen files, and a session check sent after them waited for a free connection (R12, Protect
 * on the phone profile: the check answered 0.2 s later than on R11, the live stream's first hello came after the page's
 * reads had gone out, and their reload held the page's single draw back 0.5 s). The order is in the source, so it is
 * checked there: the check is sent while the module loads, before the screen's code is asked for, and App takes that
 * answer once rather than asking twice. Only the session check is sent early: no screen's data (R11 measured and
 * refused both data variants).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(import.meta.dirname, 'App.tsx'), 'utf8')
/** Lines of the module itself (not indented): what runs when it loads, in order. */
const top = src.split('\n').filter((l) => /^\S/.test(l))

describe('what the interface asks for first', () => {
  it('sends the session check while the module loads, before it asks for the opened screen\'s code', () => {
    const check = top.findIndex((l) => /^let firstSession\b.*api<SessionInfo>\('GET', '\/api\/session'\)/.test(l))
    const code = top.findIndex((l) => /BOOT\.find\(.*\.load\(\)/.test(l))
    expect(check).toBeGreaterThanOrEqual(0)
    expect(code).toBeGreaterThan(check)
  })

  it('takes that answer once in App, and sends a fresh check every later time', () => {
    expect(src).toMatch(/const first = firstSession\n\s+firstSession = null\n\s+try \{ const s = await \(first \?\? api<SessionInfo>\('GET', '\/api\/session'\)\)/)
  })

  it('sends nothing else before the session is known: no data read at the module\'s top level', () => {
    const early = top.filter((l) => /\bapi(<[^>]*>)?\(/.test(l))
    expect(early).toEqual([expect.stringMatching(/^let firstSession\b/)])
  })
})

describe('the shell shows words, never catalogue ids', () => {
  it('translates the section tabs\' label and each tab\'s label before SectionNav draws them (the tabs once read "nav.activityPages", "nav.tax")', () => {
    expect(src).toMatch(/<SectionNav label=\{t\(sec\.label\)\} items=\{sec\.items\.map\(\(i\) => \(\{ \.\.\.i, label: t\(i\.label\) \}\)\)\}/)
  })
})
