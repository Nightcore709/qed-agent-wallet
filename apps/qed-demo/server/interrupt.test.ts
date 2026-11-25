/**
 * Interruptions (independent review of cb85271, findings 1 and 4): a seal, a reset, a restore or a drill stopped part-way
 * must not leave a plaintext copy behind. SIGINT, SIGTERM and SIGHUP wait for the synchronous step under way to finish,
 * so its own clean-up runs; what a SIGKILL, a crash or a power cut leaves is swept, and reported, by the next operation
 * in the same place. Every database here is a synthetic fixture in a scratch folder with its own generated keys.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { restoreBackup } from './backup.ts'
import { buildFixture, SENSITIVE } from './backup-fixture.ts'
import { APP_ROOT, SCHEMA_VERSION } from './core.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { MigrationRefused, sealMigrationCopy } from './migration-copy.ts'
import { archivePlaintext } from './plaintext-archive.ts'
import { toSchemaV9 } from './schema-fixture.ts'
import { createBackup, listManifests, verifySealed } from './sealed.ts'
import { sweepOne, sweepScratch } from './scratch.ts'

const made: string[] = []
const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  for (const d of made) { try { chmodSync(d, 0o700) } catch { /* gone */ } rmSync(d, { recursive: true, force: true }) }
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-interrupt-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}
const MARKER = SENSITIVE[0]!
/** A process id that no process has now: a child that has already exited. */
const deadPid = (): number => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
/** A process that keeps running until the test ends. */
function livePid(): number {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
  children.push(c)
  return c.pid!
}
/** A folder as an interrupted run leaves it: an owner record (or none) and a plaintext file holding a sensitive marker. */
function leftover(parent: string, name: string, owner: { pid: number; what: string } | null, file = 'snapshot.db'): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (owner) writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: owner.pid, host: hostname(), startedAt: Date.now() - 3_600_000, what: owner.what }), { mode: 0o600 })
  const f = join(dir, file)
  mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(f, `SQLite format 3\0 ${MARKER} ${'x'.repeat(4096)}`, { mode: 0o600 })
  return dir
}

/**
 * A fixture database in a private data folder, padded with random bytes so that copying and sealing it takes long enough
 * to be interrupted, and keys. `older`: recorded at the schema version before this build's, shaped as that version was
 * (v8: without what v9 added, Grow's watchlist table, server/schema-fixture.ts), so that opening it migrates. The fixture test
 * below checks it is a real database of that version, so a new SCHEMA_VERSION makes this fixture follow it.
 */
function world(o: { padMb?: number; older?: boolean; keys?: boolean } = {}) {
  const root = scratch()
  const data = join(root, 'data')
  mkdirSync(data, { mode: 0o700 })
  const db = join(data, 'qed.db')
  buildFixture(db)
  const raw = new DatabaseSync(db)
  if (o.padMb) {
    raw.exec('CREATE TABLE pad (b BLOB)')
    const st = raw.prepare('INSERT INTO pad (b) VALUES (?)')
    raw.exec('BEGIN')
    for (let i = 0; i < o.padMb; i++) st.run(randomBytes(1 << 20))
    raw.exec('COMMIT')
  }
  raw.close()
  if (o.older) toSchemaV9(db)
  const keys = o.keys === false ? undefined : testKeys(root)
  const env = { PATH: process.env.PATH ?? '', HOME: root, QED_DB: db, QED_KEY_DIR: join(root, 'keys'), QED_BACKUP_DIR: join(root, 'backups'), TMPDIR: join(root, 'tmp') }
  mkdirSync(env.TMPDIR, { mode: 0o700 })
  const logs: string[] = []
  return { root, data, db, keys, env, logs, log: (l: string) => { logs.push(l) } }
}

/** Run a command; once `when()` is true, send it `sig`. Resolves with how it ended and whether the signal was sent first. */
function interrupt(args: string[], env: Record<string, string>, when: () => boolean, sig: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null; sent: boolean; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(c)
    let out = '', sent = false
    c.stdout!.on('data', (d) => { out += d })
    c.stderr!.on('data', (d) => { out += d })
    const timer = setInterval(() => { if (!sent && when()) { sent = true; c.kill(sig) } }, 1)
    c.on('exit', (code, signal) => { clearInterval(timer); resolve({ code, signal, sent, out }) })
  })
}
const snapshotIn = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some((n) => n.startsWith('.qed-backup-') && existsSync(join(dir, n, 'snapshot.db')))
const MAIN = join(APP_ROOT, 'server', 'main.ts')
const BACKUP = join(APP_ROOT, 'scripts', 'backup.ts')

describe('the fixture', () => {
  it('an "older" world is a real database of the version before this build\'s: a start seals its copy, migrates it and verifies', () => {
    const w = world({ older: true })
    const read = (): unknown => { const d = new DatabaseSync(w.db, { readOnly: true }); try { return d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() } finally { d.close() } }
    expect(read()).toEqual({ value: String(Number(SCHEMA_VERSION) - 1) })
    const out = spawnSync(process.execPath, [MAIN, 'verify'], { encoding: 'utf8', env: w.env })
    expect([out.status, out.stderr]).toEqual([0, ''])
    expect(out.stdout).toContain('ledger consistent')
    expect(read()).toEqual({ value: SCHEMA_VERSION })
    expect(listManifests(join(w.data, 'migration-copies'))).toHaveLength(1)
  }, 60_000)
})

describe('a signal during a seal waits for it, so the seal cleans up after itself', () => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`${sig} while a start-up migration seals its copy: the copy is completed and verified, no plaintext snapshot is left`, async () => {
      const w = world({ padMb: 48, older: true })
      const r = await interrupt([MAIN, 'verify'], w.env, () => snapshotIn(w.data), sig)
      expect(r.sent).toBe(true)
      expect(r.signal).toBeNull() // not cut off by the signal
      expect(readdirSync(w.data).filter((n) => n.startsWith('.qed-'))).toEqual([])
      const copies = listManifests(join(w.data, 'migration-copies'))
      expect(copies).toHaveLength(1)
      expect(verifySealed(copies[0]!, openKeyring('migration-copy', { env: w.env })).manifest.purpose).toBe('migration-copy')
    }, 120_000)
  }

  it('SIGTERM while `npm run backup` seals: the backup completes, no plaintext snapshot is left', async () => {
    const w = world({ padMb: 48 })
    const r = await interrupt([BACKUP, 'create'], w.env, () => snapshotIn(w.data), 'SIGTERM')
    expect([r.sent, r.signal]).toEqual([true, null])
    expect(readdirSync(w.data)).toEqual(['qed.db'])
    expect(listManifests(join(w.root, 'backups'))).toHaveLength(1)
  }, 120_000)

  it('SIGHUP while `npm run reset` seals: the reset completes (database sealed and removed), no plaintext snapshot is left', async () => {
    const w = world({ padMb: 48 })
    const r = await interrupt([MAIN, 'reset'], w.env, () => snapshotIn(w.data), 'SIGHUP')
    expect([r.sent, r.signal]).toEqual([true, null])
    expect(readdirSync(w.data)).toEqual([])
    expect(listManifests(join(w.root, 'backups'))).toHaveLength(1)
  }, 120_000)
})

describe('what a SIGKILL or a power cut leaves is swept by the next operation in the same place', () => {
  it('a seal removes the plaintext snapshots of interrupted seals (owner gone, or an old folder with no owner record), says so, and leaves a running one', () => {
    const w = world()
    const dead = leftover(w.data, '.qed-backup-dead01', { pid: deadPid(), what: 'migration copy' })
    const legacy = leftover(w.data, '.qed-backup-legacy', null)
    utimesSync(legacy, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    const busyPid = livePid()
    const busy = leftover(w.data, '.qed-backup-busy01', { pid: busyPid, what: 'backup' })
    const r = sealMigrationCopy(w.db, SCHEMA_VERSION, String(Number(SCHEMA_VERSION) + 1), { env: w.env, log: w.log })
    expect(r.manifest.purpose).toBe('migration-copy')
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(busy)).toBe(true) // another process may still be sealing into it
    const logs = w.logs.join('\n')
    expect(logs).toContain(`removed ${dead}`)
    expect(logs).toContain(`removed ${legacy}`)
    expect(logs).toContain(`left ${busy}`)
    expect(logs).toContain(`process ${busyPid} is still running`)
    expect(logs).not.toContain(MARKER)
  })

  it('a seal refuses, naming the folder, when a stale plaintext snapshot cannot be removed', () => {
    const w = world()
    const stuck = leftover(w.data, '.qed-backup-stuck1', { pid: deadPid(), what: 'backup' })
    chmodSync(stuck, 0o500) // its file cannot be unlinked
    let caught: unknown
    try { sealMigrationCopy(w.db, SCHEMA_VERSION, String(Number(SCHEMA_VERSION) + 1), { env: w.env, log: w.log }) } catch (e) { caught = e }
    chmodSync(stuck, 0o700)
    expect(caught).toBeInstanceOf(MigrationRefused)
    expect((caught as MigrationRefused).reason).toBe('plaintext_left_behind')
    expect((caught as MigrationRefused).message).toContain(stuck)
    expect(existsSync(join(w.data, 'migration-copies')) ? listManifests(join(w.data, 'migration-copies')) : []).toEqual([])
  })

  it('a restore removes an interrupted restore\'s partial plaintext in its folder, and says so', () => {
    const w = world()
    const b = createBackup({ db: w.db, outDir: join(w.root, 'backups'), keyring: openKeyring('backup', { env: w.env }) })
    const into = join(w.root, 'restored')
    mkdirSync(into, { mode: 0o700 })
    const stale = leftover(into, '.qed-restore-dead01', { pid: deadPid(), what: 'restore' }, 'restoring.db')
    const r = restoreBackup({ manifest: b.manifestPath, keyring: openKeyring('backup', { env: w.env }), target: join(into, 'qed.db'), log: w.log })
    expect(r.verification.ok).toBe(true)
    expect(readdirSync(into)).toEqual(['qed.db'])
    expect(w.logs.join('\n')).toContain(`removed ${stale}`)
  })
})

describe('backup:drill (finding 4)', () => {
  it('SIGINT while the drill holds its restored plaintext copy: the drill finishes and removes it', async () => {
    const w = world({ padMb: 32 })
    createBackup({ db: w.db, outDir: join(w.root, 'backups'), keyring: openKeyring('backup', { env: w.env }) })
    const restored = (): boolean => readdirSync(w.env.TMPDIR).some((d) => d.startsWith('qed-drill-') && existsSync(join(w.env.TMPDIR, d, 'data', 'qed.db')))
    const r = await interrupt([BACKUP, 'drill'], w.env, restored, 'SIGINT')
    expect([r.sent, r.signal]).toEqual([true, null])
    expect(readdirSync(w.env.TMPDIR).filter((d) => d.startsWith('qed-drill-'))).toEqual([])
  }, 120_000)

  it('the next drill removes a drill folder an interrupted drill left (its owner gone), and says so', () => {
    const w = world()
    createBackup({ db: w.db, outDir: join(w.root, 'backups'), keyring: openKeyring('backup', { env: w.env }) })
    const stale = leftover(w.env.TMPDIR, 'qed-drill-dead01', { pid: deadPid(), what: 'drill' }, join('data', 'qed.db'))
    const r = spawnSync(process.execPath, [BACKUP, 'drill'], { encoding: 'utf8', env: w.env })
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(r.stdout).toContain(`removed ${stale}`)
    expect(r.stdout).not.toContain(MARKER)
    expect(readdirSync(w.env.TMPDIR).filter((d) => d.startsWith('qed-drill-'))).toEqual([])
    expect(filesUnder(w.env.TMPDIR)).toEqual([])
  }, 60_000)
})

describe('the sweep itself', () => {
  it('overwrites a stale file before removing it, never follows a symbolic link, and leaves folders of other users and other computers', () => {
    const w = world()
    const outside = join(w.root, 'outside.txt')
    writeFileSync(outside, 'keep me', { mode: 0o600 })
    const dead = leftover(w.data, '.qed-backup-link01', { pid: deadPid(), what: 'backup' })
    symlinkSync(outside, join(dead, 'a-link'))
    const remote = leftover(w.data, '.qed-backup-remote', { pid: deadPid(), what: 'backup' })
    writeFileSync(join(remote, 'owner.json'), JSON.stringify({ pid: deadPid(), host: 'another-computer.example', startedAt: 0, what: 'backup' }), { mode: 0o600 })
    sealMigrationCopy(w.db, SCHEMA_VERSION, String(Number(SCHEMA_VERSION) + 1), { env: w.env, log: w.log })
    expect(existsSync(dead)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(statSync(outside).size).toBe(7)
    expect(existsSync(remote)).toBe(true)
    expect(w.logs.join('\n')).toContain(`left ${remote}: made on another-computer.example`)
  })
})

describe('sealed partials an interrupted run left (review suspicion: orphaned .qedbak.partial files)', () => {
  it('the next backup into a folder removes a stale sealing folder (owner gone) and an old loose .partial, and says so', () => {
    const w = world()
    const out = join(w.root, 'backups')
    mkdirSync(out, { mode: 0o700 })
    const stale = leftover(out, '.qed-sealing-dead01', { pid: deadPid(), what: 'backup' }, 'bk-20261124T010203Z-abcdef.qedbak.partial')
    const loose = join(out, 'bk-20261123T010203Z-123456.qedbak.partial')
    writeFileSync(loose, randomBytes(4096), { mode: 0o600 })
    utimesSync(loose, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    const r = createBackup({ db: w.db, outDir: out, keyring: openKeyring('backup', { env: w.env }), log: w.log })
    expect(readdirSync(out).sort()).toEqual([`${r.manifest.id}.manifest.json`, `${r.manifest.id}.qedbak`, 'keyring.json'].sort())
    expect(w.logs.join('\n')).toContain(`removed ${stale}`)
    expect(w.logs.join('\n')).toContain(`removed ${loose}`)
  })

  it('the next archive removes an archive an interrupted run left half-made, and says so', () => {
    const w = world()
    const archives = join(w.root, 'backups', 'archives')
    mkdirSync(archives, { recursive: true, mode: 0o700 })
    const stale = leftover(archives, '.qed-archiving-dead01', { pid: deadPid(), what: 'archive' }, '0001.qedseal.partial')
    const bak = join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak')
    writeFileSync(bak, readFileSync(w.db), { mode: 0o600 })
    const a = archivePlaintext({ inputs: [bak], outDir: archives, keyring: openKeyring('backup', { env: w.env }), live: [w.db], log: w.log })
    expect(readdirSync(archives)).toEqual([a.manifest.id])
    expect(w.logs.join('\n')).toContain(`removed ${stale}`)
  })
})

describe('the sweep and a concurrent operation', () => {
  it('a folder that vanishes while it is being swept (its own operation finished) counts as gone, and stops nothing', () => {
    const w = world()
    const logs: string[] = []
    expect(sweepOne(join(w.data, '.qed-backup-vanished'), (l) => { logs.push(l) })).toBe('gone')
    expect(logs).toEqual([])
    // A whole sweep with a vanished entry in the middle: it carries on, and a seal still runs.
    const dead = leftover(w.data, '.qed-backup-dead02', { pid: deadPid(), what: 'backup' })
    const s = sweepScratch(w.data, '.qed-backup-', (l) => { logs.push(l) }, (name) => (name === '.qed-backup-dead02' ? rmSync(dead, { recursive: true }) : undefined))
    expect(s.failed).toEqual([])
    expect(existsSync(dead)).toBe(false)
  })
})
