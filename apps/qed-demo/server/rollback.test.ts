/**
 * A rollback of the code without its data (docs/DEPLOY.md, "Rollback"): a build opening a database that a newer build
 * has migrated refuses, changes nothing, and says the way back (restore the copy sealed before that migration, or run
 * the newer build again). It never suggests `npm run reset`, which would seal the newer data away.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_ROOT, openDb, SCHEMA_VERSION } from './core.ts'
import { MigrationRefused } from './migration-copy.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

/** A database this build made, then marked as written by the next build, closed with its log checkpointed. */
function newerDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qed-rollback-'))
  dirs.push(dir)
  const path = join(dir, 'qed.db')
  openDb(path).close()
  const raw = new DatabaseSync(path)
  raw.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(Number(SCHEMA_VERSION) + 1))
  raw.close()
  return path
}

describe('a database written by a newer build', () => {
  it('is refused with the way back, and left byte for byte as it was', () => {
    const path = newerDatabase()
    const before = sha(path)
    let err: unknown
    try { openDb(path).close() } catch (e) { err = e }
    expect(err).toBeInstanceOf(MigrationRefused)
    expect((err as MigrationRefused).reason).toBe('newer_schema')
    expect((err as Error).message).toContain(`written by a newer build of QED; this build is at version ${SCHEMA_VERSION}`)
    expect((err as Error).message).toContain('restore the copy sealed before that migration')
    expect((err as Error).message).not.toMatch(/reset/)
    expect(sha(path)).toBe(before)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(join(path, '..', 'migration-copies'))).toBe(false) // no copy was taken: nothing was to be migrated
  })

  it('stops the entry point with the reason alone, exit 1, before anything is written', () => {
    const path = newerDatabase()
    const before = sha(path)
    const out = spawnSync(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), 'verify'], { encoding: 'utf8', env: { ...process.env, QED_DB: path } })
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/^\[qed\] Database .* is at schema version \d+, written by a newer build/)
    expect(out.stderr).not.toContain('    at ') // no stack trace: an expected, explained stop
    expect(sha(path)).toBe(before)
  })
})
