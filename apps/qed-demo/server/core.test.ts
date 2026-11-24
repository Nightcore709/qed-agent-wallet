/** Files that hold every account's records are readable by this user only. */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, testClockOffset } from './core.ts'

describe('database files', () => {
  it('a database file is created readable and writable by its user only (mode 600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-mode-'))
    const path = join(dir, 'qed.db')
    openDb(path).close()
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600')
  })
})

describe('the per-address request limit', () => {
  it('is 1,500 a minute; a setting can lower it anywhere and raise it only on an isolated test stack', async () => {
    const { loadConfig } = await import('./core.ts')
    expect(loadConfig({}).requestsPerMinute).toBe(1500)
    expect(loadConfig({ QED_REQUESTS_PER_MINUTE: '600' }).requestsPerMinute).toBe(600)
    expect(loadConfig({ QED_REQUESTS_PER_MINUTE: '6000' }).requestsPerMinute).toBe(1500)
    expect(loadConfig({ QED_REQUESTS_PER_MINUTE: '6000', QED_TEST_STACK: '1' }).requestsPerMinute).toBe(6000)
    expect(loadConfig({ QED_REQUESTS_PER_MINUTE: '5' }).requestsPerMinute).toBe(60)
  })
})

describe('the clock a browser journey may move forward (isolated test stacks only)', () => {
  // A journey that needs a contribution day to arrive, or a request to lapse, moves its own stack's clock forward instead
  // of waiting (browser/tests/goals.spec.ts). The services read the offset from a file; nothing else can move it.
  const dir = mkdtempSync(join(tmpdir(), 'qed-clock-'))
  const file = join(dir, 'offset')
  let at = 1_000_000
  const read = (env: Record<string, string>) => { at += 1_000; return testClockOffset(env, at) } // past the quarter-second reuse
  it('adds the whole milliseconds the file holds, on a test stack only', () => {
    writeFileSync(file, '691200000\n')
    expect(read({ QED_TEST_STACK: '1', QED_TEST_CLOCK_FILE: file })).toBe(691_200_000)
    expect(read({ QED_TEST_CLOCK_FILE: file })).toBe(0)
    expect(read({ QED_TEST_STACK: '0', QED_TEST_CLOCK_FILE: file })).toBe(0)
    expect(read({})).toBe(0)
  })
  it('never moves the clock back, and ignores what is not a whole number', () => {
    for (const bad of ['-5000', '12.5', 'soon', '']) { writeFileSync(file, bad); expect(read({ QED_TEST_STACK: '1', QED_TEST_CLOCK_FILE: file })).toBe(0) }
    expect(read({ QED_TEST_STACK: '1', QED_TEST_CLOCK_FILE: join(dir, 'missing') })).toBe(0)
  })
})
