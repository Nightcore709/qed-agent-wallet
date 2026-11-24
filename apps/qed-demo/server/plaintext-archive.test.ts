/**
 * The plaintext copies made before 24 Nov (R11 section 11; docs/ENCRYPTION.md section 7): an encrypted archive under the
 * backup key, checked byte for byte against every original, with the originals left where they are; their removal only
 * with an explicit flag and the archive's id typed back, after every original is checked against the archive again.
 * Every file here is an isolated fixture in a scratch folder with its own generated keys.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyDatabase } from './backup.ts'
import { buildFixture, SENSITIVE } from './backup-fixture.ts'
import { APP_ROOT } from './core.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { KeyError } from './keys.ts'
import { ArchiveError, archivePlaintext, extractEntry, reencryptArchive, removeOriginals, scanPlaintext, verifyArchive } from './plaintext-archive.ts'
import { BackupError } from './sealed.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]))
}
function codeOf(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof ArchiveError || e instanceof KeyError || e instanceof BackupError) return e.code; throw e }
  return 'none'
}

/**
 * A data folder as the review machine's looked on 24 Nov, in miniature: the live database (open, with its -wal), plaintext
 * copies of it named as the migrations and `npm run reset` named theirs, a scratch folder of loose files, and keys.
 */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'qed-archive-'))
  chmodSync(root, 0o700)
  made.push(root)
  const data = join(root, 'data')
  mkdirSync(data, { mode: 0o700 })
  const live = join(data, 'qed.db')
  buildFixture(live)
  const preV5 = join(data, 'qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak')
  const reset = join(data, 'qed.db.2026-11-20T07-44-18-335Z.bak')
  copyFileSync(live, preV5)
  copyFileSync(live, reset)
  chmodSync(preV5, 0o600)
  chmodSync(reset, 0o600)
  const scratchDir = join(data, 'scratch-backup-20261120')
  mkdirSync(join(scratchDir, 'baseline'), { recursive: true, mode: 0o700 })
  writeFileSync(join(scratchDir, 'notes.txt'), `${SENSITIVE[0]} in a scratch note\n`)
  writeFileSync(join(scratchDir, 'baseline', 'figures.json'), JSON.stringify({ payee: SENSITIVE[1], amount: 1234 }))
  copyFileSync(live, join(scratchDir, 'baseline', 'copy.db'))
  symlinkSync('/etc/hosts', join(scratchDir, 'a-link'))
  const keys = testKeys(root)
  const ring = openKeyring('backup', { env: keys.env })
  const out = join(root, 'backups', 'archives')
  return { root, data, live, preV5, reset, scratchDir, keys, ring, out }
}
type World = ReturnType<typeof world>
const archive = (w: World, inputs: string[]) => archivePlaintext({ inputs, outDir: w.out, keyring: w.ring, live: [w.live] })

describe('scanning for plaintext copies', () => {
  it('finds the plaintext database copies beside the live database, names the live and open ones as such, and reads no rows', () => {
    const w = world()
    const open = new DatabaseSync(w.live)
    open.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1)') // leaves a -wal while open
    try {
      const found = scanPlaintext(w.data, { live: [w.live] })
      const by = Object.fromEntries(found.map((f) => [basename(f.path), f.kind]))
      expect(by['qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak']).toBe('plaintext-copy')
      expect(by['qed.db.2026-11-20T07-44-18-335Z.bak']).toBe('plaintext-copy')
      expect(by['copy.db']).toBe('plaintext-copy')
      expect(by['qed.db']).toBe('live')
      expect(found.filter((f) => f.kind === 'plaintext-copy').every((f) => f.sqlite && f.bytes > 0)).toBe(true)
    } finally { open.close() }
  })
})

describe('archiving plaintext copies', () => {
  it('seals each original under the backup key into a private archive, checks it byte for byte, and leaves every original as it was', () => {
    const w = world()
    const before = Object.fromEntries([w.preV5, w.reset, ...filesUnder(w.scratchDir)].map((f) => [f, { sha: sha256(f), mtime: statSync(f).mtimeMs, mode: mode(f) }]))
    const a = archive(w, [w.preV5, w.reset, w.scratchDir])
    const m = a.manifest
    expect(m).toMatchObject({ format: 'qed-archive/1', purpose: 'plaintext-archive', key: { version: 1 } })
    expect(m.id).toMatch(/^ar-\d{8}T\d{6}Z-[0-9a-f]{6}$/)
    expect(m.key.kid).toMatch(/^dek_backup_/)
    expect(m.entries.map((e) => e.name)).toEqual([basename(w.preV5), basename(w.reset), 'scratch-backup-20261120/baseline/copy.db', 'scratch-backup-20261120/baseline/figures.json', 'scratch-backup-20261120/notes.txt'])
    expect(m.skipped).toEqual([{ path: join(w.scratchDir, 'a-link'), why: 'a symbolic link (not followed)' }])
    for (const e of m.entries) { expect(e.sha256).toBe(before[e.path]!.sha); expect(e.identical).toBe(true) }
    expect(mode(a.dir)).toBe('700')
    for (const f of readdirSync(a.dir)) expect([f, mode(join(a.dir, f))]).toEqual([f, '600'])
    // Every original is still there, unchanged in content, time and mode.
    for (const [f, b] of Object.entries(before)) expect([f, sha256(f), statSync(f).mtimeMs, mode(f)]).toEqual([f, b.sha, b.mtime, b.mode])
    // Nothing in the archive is plaintext: no SQLite header, no marker, and the sealed files do not compress.
    for (const f of filesUnder(a.dir)) {
      const b = readFileSync(f)
      expect([basename(f), b.includes(Buffer.from('SQLite format 3\0', 'latin1')), SENSITIVE.filter((x) => b.includes(Buffer.from(x)))]).toEqual([basename(f), false, []])
      if (f.endsWith('.qedseal') && b.length > 4096) expect(deflateSync(b).length / b.length).toBeGreaterThan(0.99)
    }
  })

  it('verify decrypts every entry in memory against its record and, where the original is still present, byte for byte against it', () => {
    const w = world()
    const a = archive(w, [w.preV5, w.scratchDir])
    const r = verifyArchive({ manifest: a.manifestPath, keyring: w.ring })
    expect(r.ok).toBe(true)
    expect(r.entries.map((e) => [e.index, e.sealed, e.original])).toEqual(a.manifest.entries.map((e) => [e.index, 'ok', 'identical']))
    writeFileSync(join(w.scratchDir, 'notes.txt'), 'changed since it was archived\n')
    rmSync(w.preV5)
    const later = verifyArchive({ manifest: a.manifestPath, keyring: w.ring })
    expect(later.ok).toBe(true) // the archive itself is sound
    expect(later.entries.find((e) => e.name.endsWith('notes.txt'))!.original).toBe('differs')
    expect(later.entries.find((e) => e.name === basename(w.preV5))!.original).toBe('absent')
  })

  it('an entry extracts to a new private file identical to its original; a database entry verifies', () => {
    const w = world()
    const a = archive(w, [w.preV5])
    const target = join(w.root, 'extracted', 'qed.db')
    const x = extractEntry({ manifest: a.manifestPath, keyring: w.ring, index: 1, target })
    expect(x.sha256).toBe(sha256(w.preV5))
    expect(sha256(target)).toBe(sha256(w.preV5))
    expect(mode(target)).toBe('600')
    expect(verifyDatabase(target).ok).toBe(true)
    expect(codeOf(() => extractEntry({ manifest: a.manifestPath, keyring: w.ring, index: 1, target }))).toBe('target_exists')
    expect(codeOf(() => extractEntry({ manifest: a.manifestPath, keyring: w.ring, index: 9, target: join(w.root, 'none') }))).toBe('entry_unknown')
  })

  it('refuses the live database, a database another process may have open, and an archive inside what it archives; nothing is written', () => {
    const w = world()
    expect(codeOf(() => archive(w, [w.live]))).toBe('live_database')
    expect(codeOf(() => archive(w, [w.data]))).toBe('live_database')
    const busy = join(w.root, 'busy.db')
    copyFileSync(w.live, busy)
    writeFileSync(`${busy}-wal`, '')
    expect(codeOf(() => archive(w, [busy]))).toBe('in_use')
    expect(codeOf(() => archivePlaintext({ inputs: [w.scratchDir], outDir: join(w.scratchDir, 'archives'), keyring: w.ring, live: [w.live] }))).toBe('archive_location')
    expect(codeOf(() => archive(w, []))).toBe('nothing_to_archive')
    expect(codeOf(() => archivePlaintext({ inputs: [w.preV5], outDir: w.out, keyring: openKeyring('migration-copy', { env: w.keys.env }), live: [w.live] }))).toBe('key_purpose')
    expect(existsSync(w.out) ? filesUnder(w.out) : []).toEqual([])
  })

  it('tampering is detected: an altered, truncated or swapped entry, an edited record; a wrong or missing key fails closed', () => {
    const w = world()
    const a = archive(w, [w.preV5, w.reset])
    const copyOf = (name: string): { dir: string; manifest: string } => {
      const dir = join(w.root, 'tamper', name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const f of readdirSync(a.dir)) copyFileSync(join(a.dir, f), join(dir, f))
      return { dir, manifest: join(dir, 'archive.json') }
    }
    const flip = (p: string) => { const x = readFileSync(p); x[x.length >> 1] = x[x.length >> 1]! ^ 1; writeFileSync(p, x) }
    const [e1, e2] = a.manifest.entries
    const altered = copyOf('altered'); flip(join(altered.dir, e1!.sealed.file))
    expect(verifyArchive({ manifest: altered.manifest, keyring: w.ring }).entries[0]!.sealed).toBe('altered')
    const truncated = copyOf('truncated'); writeFileSync(join(truncated.dir, e1!.sealed.file), readFileSync(join(truncated.dir, e1!.sealed.file)).subarray(0, 100))
    expect(verifyArchive({ manifest: truncated.manifest, keyring: w.ring }).entries[0]!.sealed).toBe('altered')
    // Two entries swapped, the record re-hashed to match: each sealed file is bound to its archive and index.
    const swapped = copyOf('swapped')
    const m = JSON.parse(readFileSync(swapped.manifest, 'utf8')) as typeof a.manifest
    ;[m.entries[0]!.sealed, m.entries[1]!.sealed] = [m.entries[1]!.sealed, m.entries[0]!.sealed]
    writeFileSync(swapped.manifest, JSON.stringify(m))
    expect(verifyArchive({ manifest: swapped.manifest, keyring: w.ring }).entries.map((e) => e.sealed)).toEqual(['mismatch', 'mismatch'])
    const edited = copyOf('edited')
    const m2 = JSON.parse(readFileSync(edited.manifest, 'utf8')) as typeof a.manifest
    m2.entries[1]!.sha256 = '0'.repeat(64)
    writeFileSync(edited.manifest, JSON.stringify(m2))
    expect(verifyArchive({ manifest: edited.manifest, keyring: w.ring }).entries[1]!.sealed).toBe('mismatch')
    expect(verifyArchive({ manifest: edited.manifest, keyring: w.ring }).ok).toBe(false)
    // Another installation's backup key opens nothing here, and extracts nothing.
    const other = world()
    expect(verifyArchive({ manifest: a.manifestPath, keyring: other.ring }).entries.map((e) => e.sealed)).toEqual(['unknown_key', 'unknown_key'])
    expect(codeOf(() => extractEntry({ manifest: a.manifestPath, keyring: other.ring, index: 1, target: join(w.root, 'nope', 'qed.db') }))).toBe('unknown_key')
    expect(existsSync(join(w.root, 'nope', 'qed.db'))).toBe(false)
    void e2
  })
})

describe('databases with a -wal or -shm beside them', () => {
  it('are refused unless named as closed; then archived with their journal files byte for byte; removal re-checks that nothing else looks open', () => {
    const w = world()
    const stale = join(w.scratchDir, 'probe', 'live-probe.db')
    mkdirSync(dirname(stale), { mode: 0o700 })
    copyFileSync(w.live, stale)
    writeFileSync(`${stale}-shm`, Buffer.alloc(32768, 1))
    writeFileSync(`${stale}-wal`, '')
    expect(codeOf(() => archive(w, [w.scratchDir]))).toBe('in_use')
    const a = archivePlaintext({ inputs: [w.scratchDir], outDir: w.out, keyring: w.ring, live: [w.live], assumeClosed: [stale] })
    expect(a.manifest.assumedClosed).toEqual([stale])
    expect(a.manifest.entries.map((e) => e.name).filter((n) => n.includes('live-probe'))).toEqual(['scratch-backup-20261120/probe/live-probe.db', 'scratch-backup-20261120/probe/live-probe.db-shm', 'scratch-backup-20261120/probe/live-probe.db-wal'])
    // A database not named as closed that grows a -wal after archiving is not removed, and nothing else is either.
    const copy = join(w.scratchDir, 'baseline', 'copy.db')
    writeFileSync(`${copy}-wal`, '')
    expect(codeOf(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] }))).toBe('in_use')
    expect(existsSync(stale) && existsSync(copy)).toBe(true)
    rmSync(`${copy}-wal`)
    const r = removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] })
    expect(r.removed.map((x) => basename(x.path))).toEqual(expect.arrayContaining(['live-probe.db', 'live-probe.db-shm', 'live-probe.db-wal', 'copy.db']))
    expect(existsSync(join(w.scratchDir, 'probe'))).toBe(false)
  })
})

describe('removing the originals', () => {
  it('needs the archive\'s id typed back; refuses if any original differs from the archive; then removes exactly the originals and records it', () => {
    const w = world()
    const a = archive(w, [w.preV5, w.reset, w.scratchDir])
    expect(codeOf(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: '', live: [w.live] }))).toBe('confirmation_required')
    expect(codeOf(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: 'ar-wrong', live: [w.live] }))).toBe('confirmation_required')
    writeFileSync(join(w.scratchDir, 'notes.txt'), 'changed since it was archived\n')
    expect(codeOf(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] }))).toBe('original_changed')
    expect(existsSync(w.preV5) && existsSync(w.reset)).toBe(true) // nothing removed when one differs
    rmSync(join(w.scratchDir, 'notes.txt'))
    const r = removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] })
    expect(r.removed.map((x) => x.path).sort()).toEqual(a.manifest.entries.filter((e) => !e.name.endsWith('notes.txt')).map((e) => e.path).sort())
    expect(r.alreadyGone.map((x) => x.path)).toEqual([join(w.scratchDir, 'notes.txt')])
    expect(existsSync(w.preV5) || existsSync(w.reset)).toBe(false)
    // The scratch folder keeps only what was never archived (the link); emptied folders are removed.
    expect(readdirSync(w.scratchDir)).toEqual(['a-link'])
    expect(readdirSync(w.data).sort()).toEqual(['qed.db', 'scratch-backup-20261120'])
    expect(readdirSync(a.dir).filter((f) => f.startsWith('removal-'))).toHaveLength(1)
    // What was removed is still recoverable from the archive.
    expect(verifyArchive({ manifest: a.manifestPath, keyring: w.ring }).ok).toBe(true)
    const back = join(w.root, 'back', 'qed.db')
    extractEntry({ manifest: a.manifestPath, keyring: w.ring, index: 1, target: back })
    expect(sha256(back)).toBe(a.manifest.entries[0]!.sha256)
  })
})

describe('rotation of the backup key', () => {
  it('an archive is re-encrypted under the new version stream to stream; after the old version is revoked only the new one opens', () => {
    const w = world()
    const a = archive(w, [w.preV5, w.scratchDir])
    w.ring.rotate()
    const b = reencryptArchive({ manifest: a.manifestPath, keyring: w.ring, outDir: w.out })
    expect(b.manifest).toMatchObject({ reencryptedFrom: a.manifest.id, key: { version: 2 } })
    expect(b.manifest.entries.map((e) => [e.name, e.sha256])).toEqual(a.manifest.entries.map((e) => [e.name, e.sha256]))
    w.ring.revoke(1)
    expect(verifyArchive({ manifest: a.manifestPath, keyring: w.ring }).entries.every((e) => e.sealed === 'key_revoked')).toBe(true)
    expect(verifyArchive({ manifest: b.manifestPath, keyring: w.ring }).ok).toBe(true)
    expect(filesUnder(w.root).filter((f) => basename(dirname(f)).startsWith('.qed-'))).toEqual([])
  })
})

describe('the command line', () => {
  it('scan, archive (the recorded copies by default), verify and remove, printing no key and no stored value', () => {
    const w = world()
    const env = { PATH: process.env.PATH ?? '', HOME: w.root, QED_DB: w.live, ...w.keys.env, QED_BACKUP_DIR: join(w.root, 'backups') }
    const cli = (args: string[]) => spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'plaintext-copies.ts'), ...args], { encoding: 'utf8', env })
    const scan = cli(['scan'])
    expect([scan.status, scan.stderr]).toEqual([0, ''])
    expect(scan.stdout).toContain(basename(w.preV5))
    expect(scan.stdout).toMatch(/2 plaintext copies of a QED database named as migration or reset copies/)
    const made = cli(['archive', '--json'])
    expect([made.status, made.stderr]).toEqual([0, ''])
    const r = JSON.parse(made.stdout) as { manifestPath: string; manifest: { id: string; entries: { name: string }[] } }
    expect(r.manifest.entries.map((e) => e.name).sort()).toEqual([basename(w.preV5), basename(w.reset)].sort())
    expect(existsSync(w.preV5) && existsSync(w.reset)).toBe(true)
    const verified = cli(['verify', '--archive', r.manifestPath])
    expect([verified.status, verified.stderr]).toEqual([0, ''])
    expect(verified.stdout).toMatch(/2 of 2 entries decrypt to their recorded contents/)
    const after = cli(['scan'])
    expect(after.stdout).toContain(`archived in ${r.manifest.id}`)
    const noFlag = cli(['remove', '--archive', r.manifestPath, '--confirm', r.manifest.id])
    expect(noFlag.status).toBe(2)
    expect(noFlag.stderr).toContain('--remove-plaintext')
    const removed = cli(['remove', '--archive', r.manifestPath, '--remove-plaintext', '--confirm', r.manifest.id])
    expect([removed.status, removed.stderr]).toEqual([0, ''])
    expect(existsSync(w.preV5) || existsSync(w.reset)).toBe(false)
    const keyPart = readFileSync(w.keys.kekFile, 'utf8').trim().split(':')[2]!
    for (const o of [scan, made, verified, after, noFlag, removed]) {
      const text = o.stdout + o.stderr
      expect(text).not.toContain(keyPart)
      for (const m of SENSITIVE) expect(text).not.toContain(m)
    }
  }, 60_000)
})

describe('the archive record is authenticated (review suspicion: archive.json was not)', () => {
  it('an edited record (a root added, a database named closed, an entry\'s path changed) fails verify, and nothing is removed', () => {
    const edits: [string, (m: Record<string, unknown> & { entries: { path: string }[]; roots: unknown[]; assumedClosed: string[] }, w: World) => void][] = [
      ['roots', (m, w) => { m.roots.push({ path: w.root, kind: 'folder' }) }],
      ['assumedClosed', (m, w) => { m.assumedClosed.push(w.live) }],
      ['entry path', (m, w) => { m.entries[0]!.path = join(w.data, 'elsewhere.bak') }],
    ]
    for (const [what, edit] of edits) {
      const w = world()
      const a = archive(w, [w.preV5])
      const m = JSON.parse(readFileSync(a.manifestPath, 'utf8')) as Parameters<typeof edit>[0]
      edit(m, w)
      writeFileSync(a.manifestPath, JSON.stringify(m, null, 1))
      const r = verifyArchive({ manifest: a.manifestPath, keyring: w.ring })
      expect([what, r.ok, r.record]).toEqual([what, false, 'altered'])
      expect([what, codeOf(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] }))]).toEqual([what, 'verification_failed'])
      expect(existsSync(w.preV5)).toBe(true)
    }
  })

  it('a sealed record that is missing fails verify; an intact one passes, also after re-encryption', () => {
    const w = world()
    const a = archive(w, [w.preV5])
    expect(verifyArchive({ manifest: a.manifestPath, keyring: w.ring })).toMatchObject({ ok: true, record: 'ok' })
    w.ring.rotate()
    const b = reencryptArchive({ manifest: a.manifestPath, keyring: w.ring, outDir: w.out })
    expect(verifyArchive({ manifest: b.manifestPath, keyring: w.ring })).toMatchObject({ ok: true, record: 'ok' })
    rmSync(join(a.dir, 'record.qedseal'))
    expect(verifyArchive({ manifest: a.manifestPath, keyring: w.ring })).toMatchObject({ ok: false, record: 'missing' })
  })
})
