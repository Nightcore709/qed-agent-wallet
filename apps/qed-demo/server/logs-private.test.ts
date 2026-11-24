/**
 * SE8: every log the review build writes is owner-only (mode 600). The script sets umask 077, makes logs that exist
 * already private, and no service source opens a log file of its own. QED_SEED_FAIL=1 makes the last test fail.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = join(import.meta.dirname, '..')
const SCRIPT = join(APP, 'scripts', 'review-build.sh')
const mode = (p: string) => statSync(p).mode & 0o777

describe('review build logs are owner-only', () => {
  it('logs-private turns logs already there (mode 644) into mode 600 and leaves other files alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-logs-'))
    try {
      for (const n of ['rail.log', 'review-api.log', 'review-engine.log', 'vite-dev.log', 'review-build.log']) { writeFileSync(join(dir, n), 'x'); chmodSync(join(dir, n), 0o644) }
      writeFileSync(join(dir, 'notes.txt'), 'x'); chmodSync(join(dir, 'notes.txt'), 0o644)
      execFileSync('bash', [SCRIPT, 'logs-private'], { env: { ...process.env, QED_LOG_DIR: dir } })
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.log'))) expect(mode(join(dir, f)), f).toBe(0o600)
      expect(mode(join(dir, 'notes.txt'))).toBe(0o644)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a log the script creates is made under umask 077: mode 600 (a redirect in the script, run with the script\'s own umask line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-logs-'))
    try {
      const text = readFileSync(SCRIPT, 'utf8')
      const line = text.split('\n').find((l) => /^umask 0?77$/.test(l.trim()))
      expect(line, 'the script sets umask 077').toBeTruthy()
      // the first redirect to a log comes after the umask line
      expect(text.indexOf(line!)).toBeLessThan(text.search(/>>? "\$LOGS\//))
      // the same umask, the same kind of redirect as the script's, run in a shell: the file it creates is private
      execFileSync('bash', ['-c', `umask 077; echo hi >> "${dir}/new.log"`])
      expect(mode(join(dir, 'new.log'))).toBe(0o600)
      // every service log of the script goes to $LOGS
      const redirects = text.split('\n').filter((l) => /nohup|npm run -s build/.test(l) && />>? /.test(l))
      expect(redirects.length).toBeGreaterThanOrEqual(5)
      for (const l of redirects) expect(l, l).toMatch(/>>? "\$LOGS\//)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('no service source opens a log file of its own (they write to standard output, which the script redirects)', () => {
    const files = [...readdirSync(join(APP, 'server')).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts')).map((n) => join(APP, 'server', n)), join(APP, 'chain', 'serve.ts'), ...readdirSync(join(APP, 'chain', 'rail')).filter((n) => n.endsWith('.ts')).map((n) => join(APP, 'chain', 'rail', n))]
    const bad = files.filter((f) => /(createWriteStream|appendFileSync|writeFileSync|openSync)\([^)]*\.log['"`]/.test(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })

  it('seeded failure: false when QED_SEED_FAIL=1', () => { expect(process.env.QED_SEED_FAIL === '1').toBe(false) })
})
