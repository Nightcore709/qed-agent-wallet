/**
 * What a screen's first draw waits for (R11 and R12 perf, the phone profile: 390 px, CPU 4x, a slow 4G link). A screen
 * runs only once every file it imports statically has arrived, so the on-chain wallet's page (Vault.tsx, about 33 KB
 * compressed, the largest screen) and its inline parts (WalletInline.tsx, which imports it) are fetched as their own
 * chunk, once the screen has drawn: Spend, Save and Grow already did. Protect imported the inline mandate statically,
 * and its first draw waited for the wallet's page, the last of its files to arrive (R12: 2.12 s, after its own code at
 * 1.62 s). Checked on the source: the static import closure of each screen a person opens first.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')
/** Every file a file imports statically, and theirs (relative imports of code; `import type` and import() do not count). */
function closure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const m of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+\.tsx?)['"]/gm)) {
    const next = resolve(dirname(file), m[1]!)
    if (existsSync(next)) closure(next, seen)
  }
  return seen
}
const waitsFor = (screen: string): string[] => [...closure(join(SRC, screen))].map((f) => relative(SRC, f))

describe('what a screen draws first without', () => {
  for (const screen of ['app/App.tsx', 'screens/Home.tsx', 'screens/Pay.tsx', 'screens/Save.tsx', 'screens/Holdings.tsx', 'screens/Protect.tsx', 'screens/Activity.tsx', 'screens/Earn.tsx']) {
    it(`${screen} does not wait for the on-chain wallet's page or its inline parts`, () => {
      expect(waitsFor(screen).filter((f) => f === 'screens/Vault.tsx' || f === 'screens/WalletInline.tsx')).toEqual([])
    })
  }

  it('finds what it should: the closure follows static imports and re-exports, not import()', () => {
    const vault = waitsFor('screens/Vault.tsx')
    expect(vault).toContain('lib/core.ts')
    expect(vault).toContain('ui/kit.tsx')
    expect(waitsFor('screens/WalletInline.tsx')).toContain('screens/Vault.tsx')
    expect(waitsFor('screens/Save.tsx')).not.toContain('screens/WalletInline.tsx') // Save asks for it with import()
  })
})
