import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRegister } from '../scripts/register.ts'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('the requirements and evidence register', () => {
  it('the register is consistent with its sources', () => {
    const r = buildRegister()
    expect(r.problems).toEqual([])
    expect(r.inherited).toHaveLength(86)
    // REGISTER.md is generated; a stale copy would show the owner something the sources no longer say.
    expect(readFileSync(join(app, 'REGISTER.md'), 'utf8')).toBe(r.markdown)
  })
  it('refuses to call a journey Met on component evidence alone', () => {
    const r = buildRegister()
    for (const e of r.source.entries.filter((x) => x.status === 'Met' && x.needs === 'P')) expect(e.level).toBe('P')
  })
})
