/**
 * Every stylesheet loads on every page, so a class defined bare in two of them restyles it everywhere
 * (scripts/css-collisions.ts says how it is detected and what it found). This runs that check in the suite.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('no class is defined bare in more than one stylesheet', () => {
  let out = '', code = 0
  try { out = execFileSync(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'css-collisions.ts')], { encoding: 'utf8' }) }
  catch (e) { const x = e as { status: number; stdout: string }; code = x.status; out = x.stdout }
  expect(out.trim(), out).toBe('No class is defined bare in more than one stylesheet, and no modifier is defined bare elsewhere')
  expect(code).toBe(0)
})
