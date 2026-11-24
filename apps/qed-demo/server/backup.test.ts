/**
 * Encrypted backups and restore (R7-085, R7-076, D10): a consistent copy sealed under the keyring, a manifest of
 * hashes, key and schema, no plaintext left behind, and a restore into a scratch place that verifies the ledger and the
 * receipt chain. Every database here is an isolated fixture (backup-fixture.ts); none is the review database.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { BackupError, createBackup, reencryptBackup, restoreBackup, type Manifest } from './backup.ts'
import { buildFixture, FIXTURE_T0, lateWrite, SENSITIVE } from './backup-fixture.ts'
import { APP_ROOT, openDb, SCHEMA_VERSION } from './core.ts'
import { EnvKekProvider, FileKekProvider, KeyError, Keyring } from './keys.ts'

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
// Every scratch folder holds generated test keys and a fixture database: none is left behind.
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-backup-test-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
function failure(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof BackupError || e instanceof KeyError) return e.code; throw e }
  return 'none'
}
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}
/** Which sensitive markers occur anywhere in a file's bytes. */
const markersIn = (p: string): string[] => { const b = readFileSync(p); return SENSITIVE.filter((m) => b.includes(Buffer.from(m, 'utf8'))) }
const count = (db: string, sql: string): number => { const d = new DatabaseSync(db, { readOnly: true }); try { return Number((d.prepare(sql).get() as { n: number }).n) } finally { d.close() } }

/** An isolated stack: a fixture database in a private data folder, a key file and keyring outside it, a backup folder. */
function stack(o: { households?: number; entries?: number } = {}) {
  const root = scratch()
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { mode: 0o700 })
  const db = join(dataDir, 'qed.db')
  const fx = buildFixture(db, o)
  const out = join(root, 'backups')
  const keyFile = join(root, 'keys', 'qed.kek')
  const ringPath = join(root, 'keys', 'keyring.json')
  const kek = FileKekProvider.generate(keyFile, { forbiddenFolders: [dataDir, out] }).load()
  const ring = Keyring.create(ringPath, kek)
  const logs: string[] = []
  return { root, dataDir, db, fx, out, keyFile, ringPath, ring, logs, log: (l: string) => { logs.push(l) } }
}
type Stack = ReturnType<typeof stack>
const backup = (s: Stack, extra: Partial<Parameters<typeof createBackup>[0]> = {}) => createBackup({ db: s.db, outDir: s.out, keyring: s.ring, log: s.log, ...extra })
const target = (s: Stack, name = 'restore'): string => join(s.root, name, 'qed.db')

describe('encrypted backup', () => {
  it('is a consistent copy sealed under the active data key; the manifest records hashes, key id and version, time and schema', () => {
    const s = stack()
    const at = FIXTURE_T0 + 3_600_000
    const r = backup(s, { now: () => at })
    const m: Manifest = r.manifest
    expect(m.format).toBe('qed-backup/1')
    expect(m.file).toBe(`${m.id}.qedbak`)
    expect(m.algorithm).toBe('AES-256-GCM')
    expect(m.schemaVersion).toBe(SCHEMA_VERSION)
    expect(m.createdAt).toBe(new Date(at).toISOString())
    expect(m.snapshotAtMs).toBe(at)
    expect(m.key).toEqual({ kid: s.ring.list()[0]!.kid, version: 1 })
    expect(m.ciphertext).toEqual({ bytes: statSync(r.backupPath).size, sha256: sha256(r.backupPath) })
    expect(m.plaintext.bytes).toBeGreaterThan(0)
    expect(m.plaintext.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readdirSync(s.out).sort()).toEqual([`${m.id}.manifest.json`, `${m.id}.qedbak`, 'keyring.json'])
    expect(mode(s.out)).toBe('700')
    for (const f of readdirSync(s.out)) expect(mode(join(s.out, f))).toBe('600')
    // Nothing is left beside the database: no temporary folder, no journal from the read-only connection.
    expect(readdirSync(s.dataDir)).toEqual(['qed.db'])
    expect(r.timings.totalMs).toBeGreaterThan(0)
  })

  it('includes writes still in the write-ahead log of a database the service has open', () => {
    const s = stack()
    const live = openDb(s.db)
    lateWrite(live, 'usr_fx0', FIXTURE_T0 + 9_000_000, 'late-in-wal')
    expect(existsSync(`${s.db}-wal`)).toBe(true)
    const r = backup(s)
    live.close()
    restoreBackup({ manifest: r.manifestPath, keyring: s.ring, target: target(s) })
    expect(count(target(s), `SELECT COUNT(*) n FROM entries WHERE ref = 'late-in-wal'`)).toBe(1)
  })
})

describe('restore', () => {
  it('into a scratch place: verifies SQLite integrity, every ledger and every receipt chain, and reports the time taken', () => {
    const s = stack()
    const r = backup(s)
    const rr = restoreBackup({ manifest: r.manifestPath, keyring: s.ring, target: target(s), log: s.log })
    expect(rr.verification).toMatchObject({ ok: true, integrity: 'ok', foreignKeyIssues: 0, schemaVersion: SCHEMA_VERSION, users: 2, ledgerBreaks: 0, chainsBroken: 0, firstFailure: null })
    expect(rr.verification.receipts).toBe(s.fx.receipts)
    expect(rr.timings.totalMs).toBeGreaterThan(0)
    expect(rr.timings.totalMs).toBeGreaterThanOrEqual(rr.timings.decryptMs)
    // Verified read-only: the restored file is byte for byte the plaintext the manifest names.
    expect(sha256(target(s))).toBe(r.manifest.plaintext.sha256)
    expect(mode(target(s))).toBe('600')
    expect(mode(dirname(target(s)))).toBe('700')
    expect(readdirSync(dirname(target(s)))).toEqual(['qed.db'])
  })

  it('reports a broken receipt chain or ledger in the backed-up data instead of passing it', () => {
    const s = stack()
    const d = openDb(s.db)
    d.exec('DROP TRIGGER receipts_no_update; DROP TRIGGER postings_no_update')
    d.run(`UPDATE receipts SET body_json = replace(body_json, '"amount":', '"amount":1') WHERE user_id = 'usr_fx1' AND seq = 3`)
    d.run(`UPDATE postings SET amount = amount + 1, amount_text = CAST(amount + 1 AS TEXT) WHERE id = (SELECT MIN(p.id) FROM postings p JOIN entries e ON e.id = p.entry_id WHERE e.user_id = 'usr_fx0' AND e.ref = 'fx-0-5')`)
    d.close()
    const rr = restoreBackup({ manifest: backup(s).manifestPath, keyring: s.ring, target: target(s) })
    expect(rr.verification.ok).toBe(false)
    expect(rr.verification.chainsBroken).toBe(1)
    expect(rr.verification.ledgerBreaks).toBeGreaterThan(0)
    expect(rr.verification.firstFailure).toMatch(/usr_fx0: ledger|usr_fx1: receipt chain broken at 3/)
  })

  it('after rotation and re-wrapping, and after a restart, a backup sealed under a retired version still restores', () => {
    const s = stack()
    const b1 = backup(s)
    s.ring.rotate()
    const kek2 = FileKekProvider.generate(join(s.root, 'keys', 'qed-2.kek')).load()
    s.ring.rewrap(kek2)
    const b2 = backup(s)
    expect(b2.manifest.key.version).toBe(2)
    const ring = Keyring.load(s.ringPath, new FileKekProvider(join(s.root, 'keys', 'qed-2.kek')).load())
    expect(restoreBackup({ manifest: b1.manifestPath, keyring: ring, target: target(s, 'r1') }).verification.ok).toBe(true)
    expect(restoreBackup({ manifest: b2.manifestPath, keyring: ring, target: target(s, 'r2') }).verification.ok).toBe(true)
  })

  it('on a host without this machine: the key from an environment variable, the keyring copied beside the backups', () => {
    const s = stack()
    const b = backup(s)
    const env: Record<string, string | undefined> = { QED_KEK: readFileSync(s.keyFile, 'utf8') }
    const ring = Keyring.load(join(s.out, 'keyring.json'), new EnvKekProvider('QED_KEK', env).load())
    const hostB = scratch()
    const rr = restoreBackup({ manifest: b.manifestPath, keyring: ring, target: join(hostB, 'data', 'qed.db') })
    expect(rr.verification.ok).toBe(true)
    expect(env.QED_KEK).toBeUndefined()
  })

  it('never writes the live database without the explicit flag, and never writes over any other file', () => {
    const s = stack()
    const b = backup(s)
    const before = sha256(s.db)
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: s.ring, target: s.db, live: s.db }))).toBe('would_overwrite_live')
    const fresh = join(s.root, 'fresh', 'qed.db')
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: s.ring, target: fresh, live: fresh }))).toBe('would_overwrite_live')
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: s.ring, target: s.db, live: s.db, overwriteLive: true }))).toBe('live_backup_required')
    const other = join(s.root, 'other.db')
    writeFileSync(other, 'someone else\'s file')
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: s.ring, target: other }))).toBe('target_exists')
    expect(readFileSync(other, 'utf8')).toBe('someone else\'s file')
    expect(sha256(s.db)).toBe(before)
    expect(existsSync(fresh)).toBe(false)
  })

  it('with the flag: refused while the live database looks open; otherwise the live one is backed up encrypted, then replaced', () => {
    const s = stack()
    const b = backup(s)
    const live = openDb(s.db)
    lateWrite(live, 'usr_fx0', FIXTURE_T0 + 9_000_000, 'after-backup')
    const opts = { manifest: b.manifestPath, keyring: s.ring, target: s.db, live: s.db, overwriteLive: true, backupLiveTo: join(s.root, 'pre-restore') }
    expect(failure(() => restoreBackup(opts))).toBe('live_in_use')
    live.close()
    const rr = restoreBackup(opts)
    expect(rr.replacedLive).toBe(true)
    expect(count(s.db, `SELECT COUNT(*) n FROM entries WHERE ref = 'after-backup'`)).toBe(0)
    // Nothing the restore replaced is lost: the encrypted copy of the live database still has the later entry.
    restoreBackup({ manifest: rr.liveBackup!, keyring: s.ring, target: target(s, 'pre') })
    expect(count(target(s, 'pre'), `SELECT COUNT(*) n FROM entries WHERE ref = 'after-backup'`)).toBe(1)
    expect(readdirSync(s.dataDir)).toEqual(['qed.db'])
  })

  it('fails closed, precisely, leaving nothing behind: missing key, wrong key, truncated, altered, altered manifest, wrong key version', () => {
    const s = stack()
    const b = backup(s)
    const t = target(s)
    // Missing and wrong keys stop before any data is read.
    expect(failure(() => new FileKekProvider(join(s.root, 'keys', 'gone.kek')).load())).toBe('key_missing')
    const other = stack()
    expect(failure(() => Keyring.load(s.ringPath, new FileKekProvider(other.keyFile).load()))).toBe('wrong_key')
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: other.ring, target: t }))).toBe('unknown_key')
    // Each tampering is tried on its own copy of the backup set.
    const copy = (name: string, edit: (bak: string, man: string, m: Manifest) => void): string => {
      const dir = join(s.root, name)
      mkdirSync(dir, { mode: 0o700 })
      const bak = join(dir, basename(b.backupPath)), man = join(dir, basename(b.manifestPath))
      copyFileSync(b.backupPath, bak); copyFileSync(b.manifestPath, man)
      edit(bak, man, JSON.parse(readFileSync(man, 'utf8')) as Manifest)
      return man
    }
    const rewrite = (man: string, m: Manifest) => writeFileSync(man, JSON.stringify(m))
    const flip = (bak: string, at: number) => { const x = readFileSync(bak); x[at] = x[at]! ^ 0x01; writeFileSync(bak, x) }
    const cases: [string, string][] = [
      [copy('truncated', (bak) => truncateSync(bak, statSync(bak).size - 1)), 'backup_truncated'],
      [copy('altered', (bak) => flip(bak, Math.floor(statSync(bak).size / 2))), 'backup_altered'],
      [copy('altered-and-rehashed', (bak, man, m) => { flip(bak, Math.floor(statSync(bak).size / 2)); m.ciphertext.sha256 = sha256(bak); rewrite(man, m) }), 'authentication_failed'],
      [copy('manifest-time', (_bak, man, m) => { m.snapshotAtMs += 1; rewrite(man, m) }), 'manifest_mismatch'],
      [copy('manifest-plaintext-hash', (_bak, man, m) => { m.plaintext.sha256 = '0'.repeat(64); rewrite(man, m) }), 'manifest_mismatch'],
      [copy('manifest-version', (_bak, man, m) => { m.key.version = 2; rewrite(man, m) }), 'manifest_mismatch'],
      [copy('header-version', (bak, man, m) => { const x = readFileSync(bak); x.writeUInt32BE(2, 6); writeFileSync(bak, x); m.key.version = 2; m.ciphertext.sha256 = sha256(bak); rewrite(man, m) }), 'unknown_key'],
      [copy('missing-file', (bak) => rmSync(bak)), 'backup_missing'],
      [copy('traversal', (_bak, man, m) => { m.file = '../qed.db'; rewrite(man, m) }), 'manifest_malformed'],
    ]
    for (const [man, code] of cases) {
      expect([basename(dirname(man)), failure(() => restoreBackup({ manifest: man, keyring: s.ring, target: t }))]).toEqual([basename(dirname(man)), code])
      expect(existsSync(t)).toBe(false)
      expect(filesUnder(dirname(t))).toEqual([])
    }
  })
})

describe('no plaintext escapes', () => {
  it('refuses to run when its private temporary folder cannot be used, before any plaintext exists', () => {
    const s = stack()
    const ro = join(s.root, 'read-only')
    mkdirSync(ro, { mode: 0o500 })
    expect(failure(() => backup(s, { tempParent: ro }))).toBe('temp_unavailable')
    expect(failure(() => backup(s, { tempParent: s.out }))).toBe('temp_location')
    chmodSync(ro, 0o700)
    expect(filesUnder(ro)).toEqual([])
    expect(filesUnder(s.out).filter((f) => !f.endsWith('keyring.json'))).toEqual([])
  })

  it('if the plaintext copy cannot be removed, the backup fails and records nothing', () => {
    const s = stack()
    let left = ''
    expect(failure(() => backup(s, { remove: (p) => { left = p } }))).toBe('plaintext_left_behind')
    expect(readdirSync(s.out).filter((f) => f.endsWith('.manifest.json') || f.endsWith('.qedbak') || f.endsWith('.partial'))).toEqual([])
    expect(mode(dirname(left))).toBe('700')
    rmSync(dirname(left), { recursive: true })
  })

  it('no sensitive value appears in logs, temporary files, the manifest or the backup folder; the restore has them all', () => {
    const s = stack()
    let snap = '', snapMode = '', folderMode = '', snapMarkers: string[] = []
    const r = backup(s, { remove: (p) => { if (basename(p) === 'snapshot.db') { snap = p; snapMode = mode(p); folderMode = mode(dirname(p)); snapMarkers = markersIn(p) } rmSync(p, { force: true }) } })
    // The temporary copy was plaintext (so the search works), private while it existed, and is gone with its folder.
    expect(snapMarkers).toEqual(SENSITIVE)
    expect([snapMode, folderMode]).toEqual(['600', '700'])
    expect(existsSync(snap)).toBe(false)
    expect(existsSync(dirname(snap))).toBe(false)
    expect(filesUnder(s.dataDir)).toEqual([s.db])
    for (const f of filesUnder(s.out)) expect([basename(f), markersIn(f)]).toEqual([basename(f), []])
    const rr = restoreBackup({ manifest: r.manifestPath, keyring: s.ring, target: target(s), log: s.log })
    expect(rr.verification.ok).toBe(true)
    expect(s.logs.length).toBeGreaterThan(1)
    const logs = s.logs.join('\n')
    for (const m of SENSITIVE) expect(logs).not.toContain(m)
    expect(markersIn(target(s))).toEqual(SENSITIVE)
  })

  it('the command-line tool creates, restores and lists without printing a key or a sensitive value; a missing key fails with exit 1', () => {
    const s = stack()
    const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'backup.ts'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: s.root, ...env } })
    const keyPart = readFileSync(s.keyFile, 'utf8').trim().split(':')[2]!
    const made = cli(['create', '--db', s.db, '--out', s.out, '--keyring', s.ringPath, '--key-file', s.keyFile, '--json'])
    expect([made.status, made.stderr]).toEqual([0, ''])
    const manifest = (JSON.parse(made.stdout) as { manifestPath: string }).manifestPath
    const restored = cli(['restore', '--manifest', manifest, '--target', target(s), '--live', s.db, '--keyring', join(s.out, 'keyring.json'), '--key-env', 'QED_KEK'], { QED_KEK: readFileSync(s.keyFile, 'utf8') })
    expect([restored.status, restored.stderr]).toEqual([0, ''])
    expect(restored.stdout).toContain('verified')
    const listed = cli(['list', '--keyring', s.ringPath, '--key-file', s.keyFile])
    expect(listed.status).toBe(0)
    const over = cli(['restore', '--manifest', manifest, '--target', s.db, '--live', s.db, '--keyring', s.ringPath, '--key-file', s.keyFile])
    expect(over.status).toBe(1)
    expect(over.stderr).toContain('would_overwrite_live')
    const missing = cli(['create', '--db', s.db, '--out', s.out, '--keyring', s.ringPath, '--key-file', join(s.root, 'keys', 'gone.kek')])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('key_missing')
    for (const out of [made, restored, listed, over, missing]) {
      const text = out.stdout + out.stderr
      expect(text).not.toContain(keyPart)
      for (const m of SENSITIVE) expect(text).not.toContain(m)
    }
  }, 30_000)
})

describe('compromise response', () => {
  it('re-encrypt under a new version, then revoke the old one: the old backup fails closed, the new one restores', () => {
    const s = stack()
    const b1 = backup(s)
    s.ring.rotate()
    const b2 = reencryptBackup({ manifest: b1.manifestPath, keyring: s.ring, outDir: s.out, log: s.log })
    expect(b2.manifest.key.version).toBe(2)
    expect(b2.manifest.reencryptedFrom).toBe(b1.manifest.id)
    expect(b2.manifest.plaintext.sha256).toBe(b1.manifest.plaintext.sha256)
    expect(b2.manifest.snapshotAtMs).toBe(b1.manifest.snapshotAtMs)
    s.ring.revoke(1)
    expect(failure(() => restoreBackup({ manifest: b1.manifestPath, keyring: s.ring, target: target(s, 'old') }))).toBe('key_revoked')
    expect(existsSync(target(s, 'old'))).toBe(false)
    expect(restoreBackup({ manifest: b2.manifestPath, keyring: s.ring, target: target(s, 'new') }).verification.ok).toBe(true)
    expect(filesUnder(s.dataDir)).toEqual([s.db])
  })
})
