/**
 * The browser suite's own rules (docs/research/qed-qa-reliability/20261124-suite-reliability.md).
 *
 * Every journey takes `test` and `expect` from browser/support/test.ts, whose automatic fixture closes the browser
 * contexts a test opened with `browser.newContext()` and left open. A spec that took `test` from '@playwright/test'
 * directly would leave such contexts open for the rest of its worker's life, their pages live and traced again at the
 * start of every later test. The same module checks that a freshly launched browser opens a page before a worker's
 * first journey (browser/support/browser-check.ts), tested here with stand-in browsers.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Opener, opensPageWithin } from '../browser/support/browser-check.ts'

const SPECS = join(import.meta.dirname, '..', 'browser', 'tests')

/** Where a spec takes `test` or `expect` from Playwright directly, as file:line. Type-only imports are fine. */
export function directPlaywrightImports(files: { name: string; text: string }[]): string[] {
  const out: string[] = []
  for (const f of files) {
    f.text.split('\n').forEach((line, i) => {
      const m = line.match(/^import\s+\{([^}]*)\}\s+from\s+['"]@playwright\/test['"]/)
      const names = m ? m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()) : []
      if (names.includes('test') || names.includes('expect')) out.push(`${f.name}:${i + 1}`)
    })
  }
  return out
}

/**
 * The journeys' own stacks, by offset from the suite's port: each takes its port and the next (the API and the wallet
 * service; their chains +3300 and +3301), so two journeys must not share an offset or sit one apart. Two journeys that
 * did (new-payee and goals at 22; bounties, earn-states and lab at 18) failed under more than one worker with "port in
 * use" (24 Nov). Returns the clashes, as "a.spec.ts and b.spec.ts".
 */
export function portClashes(files: { name: string; text: string }[]): string[] {
  const used = files.flatMap((f) => [...f.text.matchAll(/extraPort\((\d+)\)/g)].map((m) => ({ name: f.name, at: Number(m[1]) })))
  const out: string[] = []
  for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) if (Math.abs(used[i]!.at - used[j]!.at) < 2) out.push(`${used[i]!.name} and ${used[j]!.name}`)
  return out
}

/** Specs whose own stack starts in beforeAll with more than one test and no serial mode: under fullyParallel two workers would each start that stack on one port. */
export function sharedStackNotSerial(files: { name: string; text: string }[]): string[] {
  return files.filter((f) => /beforeAll\([^\n]*startExtraStack/.test(f.text) && (f.text.match(/^test\(/gm) ?? []).length > 1 && !/describe\.configure\(\{ mode: 'serial' \}\)/.test(f.text)).map((f) => f.name)
}
/** Machine-specific folders a spec or its support must not name (the CI runner is Linux and has none of them). */
export function machineSpecificPaths(files: { name: string; text: string }[]): string[] {
  return files.filter((f) => /['"`](\/private\/tmp|\/Users\/|\/home\/[a-z])/.test(f.text)).map((f) => f.name)
}

describe('the browser suite', () => {
  it('gives every journey with a stack of its own a pair of ports no other journey uses', () => {
    const files = readdirSync(SPECS).filter((n) => n.endsWith('.spec.ts')).map((name) => ({ name, text: readFileSync(join(SPECS, name), 'utf8') }))
    expect(portClashes(files)).toEqual([])
    // and the check finds a clash when there is one
    expect(portClashes([{ name: 'a.spec.ts', text: 'extraPort(22)' }, { name: 'b.spec.ts', text: 'extraPort(23)' }])).toEqual(['a.spec.ts and b.spec.ts'])
  })

  const specs = readdirSync(SPECS).filter((n) => n.endsWith('.spec.ts')).map((name) => ({ name, text: readFileSync(join(SPECS, name), 'utf8') }))

  it('takes test and expect from browser/support/test.ts in every spec', () => {
    expect(specs.length).toBeGreaterThanOrEqual(34)
    expect(directPlaywrightImports(specs)).toEqual([])
    expect(specs.filter((s) => !/^import \{[^}]*\btest\b[^}]*\} from '\.\.\/support\/test\.ts'$/m.test(s.text)).map((s) => s.name)).toEqual([])
  })

  it('runs a spec that starts one stack for several tests on one worker only (CI run: two workers met on one port)', () => {
    expect(sharedStackNotSerial(specs)).toEqual([])
    const bad = "test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })\ntest('a', async () => {})\ntest('b', async () => {})"
    expect(sharedStackNotSerial([{ name: 'x.spec.ts', text: bad }])).toEqual(['x.spec.ts'])
    expect(sharedStackNotSerial([{ name: 'x.spec.ts', text: `test.describe.configure({ mode: 'serial' })\n${bad}` }])).toEqual([])
  })

  it('names no machine-specific folder in a spec or in the support code (CI run: a macOS path failed with EACCES on Linux)', () => {
    const support = readdirSync(join(SPECS, '..', 'support')).filter((n) => n.endsWith('.ts')).map((name) => ({ name, text: readFileSync(join(SPECS, '..', 'support', name), 'utf8') }))
    expect(machineSpecificPaths([...specs, ...support])).toEqual([])
    expect(machineSpecificPaths([{ name: 'x.ts', text: "const A = '/private/tmp/claude-501/shots'" }])).toEqual(['x.ts'])
  })

  it('reports a spec that takes test or expect from Playwright directly (the check can fail)', () => {
    expect(directPlaywrightImports([
      { name: 'seeded-test.spec.ts', text: "import { expect, type Page, test } from '@playwright/test'\n" },
      { name: 'seeded-alias.spec.ts', text: "// a journey\nimport { test as it } from '@playwright/test'\n" },
      { name: 'types-only.spec.ts', text: "import type { Page } from '@playwright/test'\n" },
      { name: 'suite.spec.ts', text: "import { expect, test } from '../support/test.ts'\n" },
    ])).toEqual(['seeded-test.spec.ts:1', 'seeded-alias.spec.ts:2'])
  })
})

describe('the start check of a launched browser', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => {})
  /** A stand-in browser: `context` and `page` say what opening each does; closes are counted. */
  function standIn(context: 'opens' | 'hangs' | 'fails', page: 'opens' | 'hangs' = 'opens'): { browser: Opener; closed: () => number } {
    let closed = 0
    const ctx = { newPage: () => (page === 'opens' ? Promise.resolve({}) : never()), close: async () => { closed++ } }
    const newContext = () => (context === 'opens' ? Promise.resolve(ctx) : context === 'hangs' ? never() : Promise.reject(new Error('Target closed')))
    return { browser: { newContext } as unknown as Opener, closed: () => closed }
  }

  it('passes a browser that opens a context and a page, and closes the context again', async () => {
    const b = standIn('opens')
    expect(await opensPageWithin(b.browser, 1_000)).toBe(true)
    expect(b.closed()).toBe(1)
  })

  it('fails a browser that never opens a context, or never a page, within the bound (the check can fail)', async () => {
    for (const b of [standIn('hangs'), standIn('opens', 'hangs')]) {
      const t0 = performance.now()
      expect(await opensPageWithin(b.browser, 50)).toBe(false)
      expect(performance.now() - t0).toBeLessThan(1_000)
    }
  })

  it('fails a browser whose context cannot be opened at all', async () => {
    expect(await opensPageWithin(standIn('fails').browser, 1_000)).toBe(false)
  })
})
