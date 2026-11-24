/**
 * The copy taken before a schema migration (R11 section 11; docs/ENCRYPTION.md section 4): sealed under the
 * migration-copy key (separate from the backup key and from the database's own key), verified after it is written, never
 * left in plaintext; a migration that cannot make it does not run, and nothing changes. Every database here is an
 * isolated fixture (backup-fixture.ts) in a scratch folder with its own generated keys; none is the review database.
 * The calls here seal a copy directly, so they do not depend on what any one migration does; the copy as openDb takes it
 * on a real older database is checked in canonical-ids.test.ts.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { BackupError, reencryptBackup, restoreBackup } from './backup.ts'
import { buildFixture, SENSITIVE } from './backup-fixture.ts'
import { APP_ROOT, openDb, SCHEMA_VERSION } from './core.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { FileKekProvider, KeyError } from './keys.ts'
import { MigrationRefused, sealMigrationCopy } from './migration-copy.ts'
import { listManifests } from './sealed.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-migcopy-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}
const markersIn = (p: string): string[] => { const b = readFileSync(p); return SENSITIVE.filter((m) => b.includes(Buffer.from(m, 'utf8'))) }
const state = (dir: string): Record<string, string> => Object.fromEntries(filesUnder(dir).map((f) => [f, sha256(f)]))
function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof KeyError || e instanceof BackupError) return e.code; throw e }
  return 'none'
}
function refusal(fn: () => unknown): { reason: string; message: string } {
  try { fn() } catch (e) { if (e instanceof MigrationRefused) return { reason: e.reason, message: e.message }; throw e }
  return { reason: 'none', message: '' }
}

/** A fixture database in a private data folder, and (unless keys: false) a key folder laid out as `npm run keys:init` makes it. */
function world(o: { keys?: boolean } = {}) {
  const root = scratch()
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { mode: 0o700 })
  const db = join(dataDir, 'qed.db')
  buildFixture(db)
  const keys = o.keys === false ? undefined : testKeys(root)
  const env: Record<string, string> = keys?.env ?? { HOME: root, QED_KEY_DIR: join(root, 'keys') }
  const logs: string[] = []
  return { root, dataDir, db, keys, env, logs, log: (l: string) => { logs.push(l) }, copies: join(dataDir, 'migration-copies') }
}
type World = ReturnType<typeof world>
// The copy does not depend on what a migration does, so these calls name the current version and a next one.
const FROM = SCHEMA_VERSION, TO = String(Number(SCHEMA_VERSION) + 1)
const seal = (w: World, extra: Partial<Parameters<typeof sealMigrationCopy>[3]> = {}) => sealMigrationCopy(w.db, FROM, TO, { env: w.env, log: w.log, ...extra })

describe('the copy taken before a migration', () => {
  it('is sealed under the migration-copy key, names the schema versions, is verified after writing, and leaves no plaintext', () => {
    const w = world()
    const r = seal(w)
    const m = r.manifest
    expect(m).toMatchObject({ format: 'qed-backup/1', purpose: 'migration-copy', migration: { from: FROM, to: TO }, schemaVersion: FROM, source: 'qed.db', algorithm: 'AES-256-GCM' })
    expect(m.id).toMatch(/^mc-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    expect(m.key.kid).toMatch(/^dek_migration-copy_[0-9a-f]{16}$/)
    expect(m.key.version).toBe(1)
    expect(dirname(r.manifestPath)).toBe(w.copies)
    expect(readdirSync(w.copies).sort()).toEqual([`${m.id}.manifest.json`, `${m.id}.qedbak`, 'keyring.json'].sort())
    expect(mode(w.copies)).toBe('700')
    for (const f of readdirSync(w.copies)) expect([f, mode(join(w.copies, f))]).toEqual([f, '600'])
    // Beside the database: the folder of copies, and no temporary folder, journal or plaintext copy.
    expect(readdirSync(w.dataDir).sort()).toEqual(['migration-copies', 'qed.db'])
    expect(w.logs.join('\n')).toContain(`migration copy ${m.id}`)
    // It opens with the migration-copy keyring, and is the database as it was, byte for byte as recorded.
    const rr = restoreBackup({ manifest: r.manifestPath, keyring: openKeyring('migration-copy', { env: w.env }), target: join(w.root, 'restored', 'qed.db') })
    expect(rr.verification).toMatchObject({ ok: true, integrity: 'ok', schemaVersion: FROM })
    expect(sha256(rr.target)).toBe(m.plaintext.sha256)
  })

  it('key separation: the backup key cannot open it, and the backup keyring is refused in the migration-copy keyring\'s place', () => {
    const w = world()
    const r = seal(w)
    const backupRing = openKeyring('backup', { env: w.env })
    expect(codeOf(() => restoreBackup({ manifest: r.manifestPath, keyring: backupRing, target: join(w.root, 'x', 'qed.db') }))).toBe('key_purpose')
    // Even past the purpose check, the backup keyring does not hold the data key the copy was sealed under.
    expect(codeOf(() => backupRing.verifyFile(r.backupPath, `qed/migration-copy/v1:${r.manifest.id}`))).toBe('unknown_key')
    expect(existsSync(join(w.root, 'x'))).toBe(false)
    const before = state(w.dataDir)
    const wrong = refusal(() => sealMigrationCopy(w.db, FROM, TO, { env: { ...w.env, QED_MIGRATION_KEYRING: w.keys!.keyring.backup } }))
    expect(wrong.reason).toBe('key_purpose')
    expect(state(w.dataDir)).toEqual(before)
  })

  it('fails closed when the key is missing, unreadable, wrong or altered: nothing is read or written, and the message says what to do', () => {
    const other = world()
    const cases: [string, (w: World) => Record<string, string>][] = [
      ['key_missing', (w) => w.env], // no key folder at all
      ['key_permissions', (w) => { chmodSync(w.keys!.kekFile, 0o644); return w.env }],
      ['keyring_missing', (w) => { rmSync(w.keys!.keyring['migration-copy']); return w.env }],
      ['wrong_key', (w) => ({ ...w.env, QED_KEY_FILE: other.keys!.kekFile })],
      ['keyring_tampered', (w) => { const p = w.keys!.keyring['migration-copy']; const f = JSON.parse(readFileSync(p, 'utf8')) as { active: number }; writeFileSync(p, JSON.stringify({ ...f, active: 2 })); return w.env }],
      ['key_malformed', (w) => ({ ...w.env, QED_KEK: 'qedkek1:not-a-key-but-a-secret-looking-value' })],
      ['key_location', (w) => { const k = join(w.dataDir, 'qed.kek'); FileKekProvider.generate(join(w.root, 'elsewhere', 'qed.kek')); writeFileSync(k, readFileSync(join(w.root, 'elsewhere', 'qed.kek')), { mode: 0o600 }); return { ...w.env, QED_KEY_FILE: k } }],
    ]
    for (const [code, setup] of cases) {
      const w = world({ keys: code !== 'key_missing' })
      const env = setup(w)
      const db = sha256(w.db)
      const files = state(w.dataDir)
      const r = refusal(() => sealMigrationCopy(w.db, FROM, TO, { env }))
      expect([code, r.reason]).toEqual([code, code])
      expect(r.message).toContain('Nothing was changed')
      expect(r.message).toContain(`schema version ${FROM}`)
      expect(r.message).not.toContain('secret-looking')
      expect(r.message).toMatch(/npm run keys:init|QED_KEY_DIR|chmod|key-encryption key/)
      expect(sha256(w.db)).toBe(db)
      expect(state(w.dataDir)).toEqual(files)
      expect(existsSync(w.copies)).toBe(false)
    }
  })

  it('a copy that does not decrypt to the database after it is written is not recorded, and the migration is refused', () => {
    const w = world()
    const db = sha256(w.db)
    // Alter the sealed file between writing and checking: the check must catch it.
    const r = refusal(() => seal(w, { afterSeal: (p) => { const x = readFileSync(p); x[x.length >> 1] = x[x.length >> 1]! ^ 1; writeFileSync(p, x) } }))
    expect(r.reason).toBe('verification_failed')
    expect(filesUnder(w.copies).filter((f) => !f.endsWith('keyring.json'))).toEqual([])
    expect(readdirSync(w.dataDir).filter((f) => f.startsWith('.qed-'))).toEqual([])
    expect(sha256(w.db)).toBe(db)
  })

  it('refuses when its private temporary folder cannot be used, or when the plaintext snapshot cannot be removed', () => {
    const w = world()
    const ro = join(w.root, 'read-only')
    mkdirSync(ro, { mode: 0o500 })
    expect(refusal(() => seal(w, { tempParent: ro })).reason).toBe('temp_unavailable')
    let left = ''
    const r = refusal(() => seal(w, { remove: (p) => { left = p } }))
    expect(r.reason).toBe('plaintext_left_behind')
    expect(r.message).toContain(dirname(left))
    expect(filesUnder(w.copies).filter((f) => f.endsWith('.manifest.json') || f.endsWith('.qedbak'))).toEqual([])
    rmSync(dirname(left), { recursive: true, force: true })
    chmodSync(ro, 0o700)
  })

  it('leaves no plaintext: no database page, sensitive value or key material in any file it wrote or line it logged', () => {
    const w = world()
    const pre = readFileSync(w.db)
    const pageSize = pre.readUInt16BE(16) === 1 ? 65536 : pre.readUInt16BE(16)
    // From every page with content, its last 48 bytes (where a b-tree page keeps its cells), if they are not filler.
    const samples: Buffer[] = []
    for (let off = 0; off + pageSize <= pre.length; off += pageSize) {
      const s = pre.subarray(off + pageSize - 48, off + pageSize)
      if (new Set(s).size >= 12) samples.push(Buffer.from(s))
    }
    expect(samples.length).toBeGreaterThan(20)
    let snapMarkers: string[] = []
    const r = seal(w, { remove: (p) => { if (basename(p) === 'snapshot.db') snapMarkers = markersIn(p); rmSync(p, { recursive: true, force: true }) } })
    expect(snapMarkers).toEqual(SENSITIVE) // positive control: the temporary plaintext held every marker
    const kekPart = Buffer.from(readFileSync(w.keys!.kekFile, 'utf8').trim().split(':')[2]!, 'utf8')
    const written = filesUnder(w.root).filter((f) => !f.startsWith(w.db) && f !== w.keys!.kekFile)
    expect(written.length).toBeGreaterThanOrEqual(5) // the copy, its manifest and keyring copy; the two keyrings
    for (const f of written) {
      const b = readFileSync(f)
      expect([f, SENSITIVE.filter((m) => b.includes(Buffer.from(m, 'utf8')))]).toEqual([f, []])
      expect([f, b.includes(Buffer.from('SQLite format 3\0', 'latin1'))]).toEqual([f, false])
      expect([f, samples.filter((s) => b.includes(s)).length]).toEqual([f, 0])
      expect([f, b.includes(kekPart)]).toEqual([f, false])
    }
    // The sealed copy reads as random bytes: it does not compress.
    const sealed = readFileSync(r.backupPath)
    expect(deflateSync(sealed).length / sealed.length).toBeGreaterThan(0.99)
    const logs = w.logs.join('\n')
    for (const m of SENSITIVE) expect(logs).not.toContain(m)
    expect(logs).not.toContain(kekPart.toString())
  })

  it('rotation: the migration-copy key rotates, the copy is re-encrypted under the new version without plaintext on disk, the old version is revoked', () => {
    const w = world()
    const r1 = seal(w)
    const ring = openKeyring('migration-copy', { env: w.env })
    ring.rotate()
    const r2 = reencryptBackup({ manifest: r1.manifestPath, keyring: ring, outDir: w.copies, log: w.log })
    expect(r2.manifest).toMatchObject({ purpose: 'migration-copy', reencryptedFrom: r1.manifest.id, migration: r1.manifest.migration, snapshotAtMs: r1.manifest.snapshotAtMs, plaintext: r1.manifest.plaintext })
    expect(r2.manifest.id).toMatch(/^mc-/)
    expect(r2.manifest.key).toEqual({ kid: ring.list()[1]!.kid, version: 2 })
    // Re-encrypted stream to stream: no temporary folder was made anywhere under the scratch root.
    expect(filesUnder(w.root).filter((f) => f.includes('.qed-backup-'))).toEqual([])
    ring.revoke(1)
    expect(codeOf(() => restoreBackup({ manifest: r1.manifestPath, keyring: ring, target: join(w.root, 'old', 'qed.db') }))).toBe('key_revoked')
    expect(existsSync(join(w.root, 'old', 'qed.db'))).toBe(false)
    expect(restoreBackup({ manifest: r2.manifestPath, keyring: ring, target: join(w.root, 'new', 'qed.db') }).verification.ok).toBe(true)
    // The next migration seals under the new version.
    expect(seal(w).manifest.key.version).toBe(2)
  })
})

describe('a restart, and the entry points', () => {
  it('a separate process with only the key folder verifies the copy, printing no key and no stored value', () => {
    const w = world()
    const r = seal(w)
    const out = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'backup.ts'), 'verify', '--dir', w.copies], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...w.env } })
    expect([out.status, out.stderr]).toEqual([0, ''])
    expect(out.stdout).toContain(r.manifest.id)
    expect(out.stdout).toMatch(/1 of 1 sealed sets? verified/)
    const kekPart = readFileSync(w.keys!.kekFile, 'utf8').trim().split(':')[2]!
    expect(out.stdout).not.toContain(kekPart)
    for (const m of SENSITIVE) expect(out.stdout).not.toContain(m)
  }, 30_000)

  it('openDb does not migrate an older database without the migration-copy key, and changes nothing about it', () => {
    const w = world({ keys: false })
    // Recorded as written by schema 1: openDb plans every migration from there; the refusal comes before the first.
    const raw = new DatabaseSync(w.db)
    raw.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`)
    raw.close()
    const db = sha256(w.db)
    const files = readdirSync(w.dataDir).sort()
    const saved = { QED_KEY_DIR: process.env.QED_KEY_DIR, HOME: process.env.HOME }
    process.env.QED_KEY_DIR = join(w.root, 'keys')
    process.env.HOME = w.root
    try {
      const r = refusal(() => openDb(w.db))
      expect(r.reason).toBe('key_missing')
      expect(r.message).toContain('schema version 1')
      expect(r.message).toContain('npm run keys:init')
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
    expect(sha256(w.db)).toBe(db)
    expect(readdirSync(w.dataDir).sort()).toEqual(files)
    const check = new DatabaseSync(w.db, { readOnly: true })
    expect(check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: '1' })
    check.close()
  })

  it('`node server/main.ts verify` on an older database without the key exits 1 with the refusal alone, and changes nothing', () => {
    const w = world({ keys: false })
    const raw = new DatabaseSync(w.db)
    raw.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`)
    raw.close()
    const db = sha256(w.db)
    const out = spawnSync(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: w.root, QED_DB: w.db, QED_KEY_DIR: join(w.root, 'keys') } })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('Nothing was changed')
    expect(out.stderr).toContain('key_missing')
    expect(out.stderr).not.toMatch(/\n\s+at /) // the message, not a stack trace
    expect(sha256(w.db)).toBe(db)
    expect(existsSync(w.copies)).toBe(false)
  }, 30_000)
})

describe('a refusal leaves the database as it found it (independent review of cb85271, finding 5)', () => {
  it('with a committed write-ahead log still waiting (an earlier start was killed): the database file and its log byte for byte, the row still there', () => {
    const w = world({ keys: false })
    // A process commits a change into the log, then is killed before any checkpoint (as a crashed earlier start would be).
    const crash = `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(w.db)}); d.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE meta SET value = '1' WHERE key = 'schema_version'"); process.kill(process.pid, 'SIGKILL')`
    spawnSync(process.execPath, ['-e', crash])
    expect(statSync(`${w.db}-wal`).size).toBeGreaterThan(0)
    const before = { db: sha256(w.db), wal: sha256(`${w.db}-wal`) }
    const out = spawnSync(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), 'verify'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: w.root, QED_DB: w.db, QED_KEY_DIR: join(w.root, 'keys') } })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('key_missing')
    expect(out.stderr).toContain('its file and its write-ahead log are as they were')
    expect({ db: sha256(w.db), wal: sha256(`${w.db}-wal`) }).toEqual(before)
    expect(existsSync(`${w.db}-shm`)).toBe(true)
    const ro = new DatabaseSync(w.db, { readOnly: true }) // read-only: it cannot checkpoint either
    expect(ro.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: '1' })
    ro.close()
    expect(sha256(w.db)).toBe(before.db)
  }, 30_000)
})

describe('a restart loop after a failed migration does not pile up copies (merge note, claude/r11-money-s3)', () => {
  it('an unchanged database reuses its migration copy (checked again); a changed one gets a new copy', () => {
    const w = world()
    const first = seal(w)
    const again = seal(w)
    expect(again.manifest.id).toBe(first.manifest.id)
    expect(w.logs.join('\n')).toContain(`reused migration copy ${first.manifest.id}`)
    expect(listManifests(w.copies)).toHaveLength(1)
    expect(readdirSync(w.dataDir).filter((n) => n.startsWith('.qed-'))).toEqual([])
    const d = new DatabaseSync(w.db)
    d.exec(`INSERT INTO meta (key, value) VALUES ('changed', 'yes')`)
    d.close()
    expect(seal(w).manifest.id).not.toBe(first.manifest.id)
    expect(listManifests(w.copies)).toHaveLength(2)
  })

  it('a copy that no longer verifies is not reused: a new one is made', () => {
    const w = world()
    const first = seal(w)
    const x = readFileSync(first.backupPath)
    x[x.length - 40] = x[x.length - 40]! ^ 1
    writeFileSync(first.backupPath, x)
    const next = seal(w)
    expect(next.manifest.id).not.toBe(first.manifest.id)
    expect(w.logs.join('\n')).toContain(`did not verify (backup_altered)`)
  })
})
