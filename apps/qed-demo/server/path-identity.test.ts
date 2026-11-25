/**
 * Which file a path names (independent review of cb85271, findings 2 and 6). macOS's default APFS is case-insensitive, and
 * node's realpathSync keeps the letter case it is given, so a guard that compared paths as strings could be passed by
 * writing a name in another case (or through a hard link). The guards compare files by device and inode, and folders by
 * walking up to the folder's own device and inode; a path that does not exist yet is compared by its canonical form
 * (the case the operating system gives, then case-folded on macOS and Windows). Synthetic fixtures in scratch folders.
 *
 * Another letter case names the same file only on a case-insensitive volume (macOS's default APFS, Windows). On a
 * case-sensitive one (Linux's ext4: GitHub's ubuntu-24.04 runner, the deployed image) it names another file, so the tests
 * that need case-insensitivity are skipped there, by name, and each guard is still tested through symbolic and hard
 * links, which name the same file on every volume.
 */
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createBackup, restoreBackup } from './backup.ts'
import { buildFixture } from './backup-fixture.ts'
import { openKeyring } from './key-config.ts'
import { testKeys } from './key-fixture.ts'
import { FileKekProvider, inside, KeyError, samePath } from './keys.ts'
import { ArchiveError, archivePlaintext, removeOriginals, scanPlaintext } from './plaintext-archive.ts'
import { BackupError } from './sealed.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'qed-ident-'))
  chmodSync(d, 0o700)
  made.push(d)
  return d
}
function failure(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof KeyError || e instanceof BackupError || e instanceof ArchiveError) return e.code; throw e }
  return 'none'
}
function world() {
  const root = scratch()
  const data = join(root, 'Data')
  mkdirSync(data, { mode: 0o700 })
  const live = join(data, 'qed.db')
  buildFixture(live)
  const keys = testKeys(root)
  const ring = openKeyring('backup', { env: keys.env })
  // via-link: a symbolic link to the data folder, the other name every volume has
  symlinkSync(data, join(root, 'via-link'))
  return { root, data, live, keys, ring, out: join(root, 'backups', 'archives'), caseLive: join(root, 'DATA', 'QED.db'), linkLive: join(root, 'via-link', 'qed.db') }
}
const caseInsensitive = (): boolean => { const d = scratch(); writeFileSync(join(d, 'probe'), ''); return existsSync(join(d, 'PROBE')) }
/** Whether the scratch folders' volume finds a name written in another letter case: macOS's default APFS does, ext4 does not. */
const CASE_INSENSITIVE = caseInsensitive()
/** A test about another letter case: it runs on a case-insensitive volume and is reported as skipped on a case-sensitive one. */
const inAnotherCase = it.runIf(CASE_INSENSITIVE)

describe('the volume', () => {
  // On macOS the code folds letter case and the default volume ignores it: there the letter-case tests are the point,
  // and a scratch folder that is not case-insensitive would leave them proving nothing.
  it.runIf(process.platform === 'darwin')('is case-insensitive on macOS (else the letter-case tests prove nothing)', () => { expect(CASE_INSENSITIVE).toBe(true) })
  it.runIf(!CASE_INSENSITIVE)('is case-sensitive here: another letter case is another file, so the letter-case tests are skipped', () => {
    const w = world()
    expect(existsSync(w.caseLive)).toBe(false)
    expect(samePath(w.caseLive, w.live)).toBe(false)
  })
})

describe('samePath and inside', () => {
  it('a file through a symbolic link or a hard link is the same file; a copy is not; a path not there yet is compared with links resolved', () => {
    const w = world()
    linkSync(w.live, join(w.root, 'hard.db'))
    expect(samePath(w.linkLive, w.live)).toBe(true)
    expect(samePath(join(w.root, 'hard.db'), w.live)).toBe(true)
    copyFileSync(w.live, join(w.root, 'copy.db'))
    expect(samePath(join(w.root, 'copy.db'), w.live)).toBe(false)
    // Not there yet: compared by canonical path.
    expect(samePath(join(w.root, 'via-link', 'new.db'), join(w.data, 'new.db'))).toBe(true)
    expect(samePath(join(w.root, 'via-link', 'new.db'), join(w.data, 'other.db'))).toBe(false)
  })

  inAnotherCase('a file in another letter case is the same file, and so is a path not there yet', () => {
    const w = world()
    expect(samePath(w.caseLive, w.live)).toBe(true)
    // Not there yet: compared by canonical path, ignoring case on this volume.
    expect(samePath(join(w.root, 'DATA', 'NEW.db'), join(w.data, 'new.db'))).toBe(true)
    expect(samePath(join(w.root, 'DATA', 'NEW.db'), join(w.data, 'other.db'))).toBe(false)
  })

  it('inside: a path under the folder through a link, or not existing yet, is inside; a sibling is not', () => {
    const w = world()
    expect(inside(join(w.root, 'via-link', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'via-link', 'sub', 'deeper', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'Datum', 'x.kek'), w.data)).toBe(false)
    expect(inside(join(w.root, 'not-yet', 'x'), join(w.root, 'not-yet'))).toBe(true)
    // the folder not there yet either, named through the link: compared by canonical path
    expect(inside(join(w.root, 'via-link', 'new', 'x'), join(w.data, 'new'))).toBe(true)
  })

  inAnotherCase('inside: a path under the folder named in another letter case, or not existing yet, is inside', () => {
    const w = world()
    expect(inside(join(w.root, 'DATA', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'data', 'sub', 'deeper', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'NOT-YET', 'x'), join(w.root, 'not-yet'))).toBe(true)
  })
})

describe('the key file is never inside the database or backup folders (finding 2, p2b)', () => {
  it('generate and load refuse a key path that reaches the data folder through a link', () => {
    const w = world()
    const p = join(w.root, 'via-link', 'd.kek')
    expect(failure(() => FileKekProvider.generate(p, { forbiddenFolders: [w.data] }))).toBe('key_location')
    expect(existsSync(p)).toBe(false)
    // A key already inside, named through the link: load refuses it too.
    FileKekProvider.generate(join(w.data, 'inside.kek'))
    expect(failure(() => new FileKekProvider(join(w.root, 'via-link', 'inside.kek'), { forbiddenFolders: [w.data] }).load())).toBe('key_location')
  })

  inAnotherCase('generate and load refuse a key path that reaches the data folder by another letter case', () => {
    const w = world()
    for (const p of [join(w.root, 'DATA', 'b.kek'), join(w.root, 'data', 'c.kek')]) {
      expect([p, failure(() => FileKekProvider.generate(p, { forbiddenFolders: [w.data] }))]).toEqual([p, 'key_location'])
      expect(existsSync(p)).toBe(false)
    }
    // A key already inside, named in another case: load refuses it too.
    FileKekProvider.generate(join(w.data, 'inside.kek'))
    expect(failure(() => new FileKekProvider(join(w.root, 'DATA', 'INSIDE.kek'), { forbiddenFolders: [w.data] }).load())).toBe('key_location')
  })
})

describe('the live database is never archived or removed (finding 2, p2)', () => {
  it('archive refuses the live database through a hard link, through a link to its folder, and in its folder', () => {
    const w = world()
    linkSync(w.live, join(w.root, 'hard.db'))
    expect(failure(() => archivePlaintext({ inputs: [join(w.root, 'hard.db')], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    expect(failure(() => archivePlaintext({ inputs: [w.linkLive], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    expect(failure(() => archivePlaintext({ inputs: [w.data], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    // The live database configured through the link: the real file is still recognised.
    expect(failure(() => archivePlaintext({ inputs: [w.live], outDir: w.out, keyring: w.ring, live: [w.linkLive] }))).toBe('live_database')
    expect(existsSync(w.out) ? readdirSync(w.out) : []).toEqual([])
  })

  inAnotherCase('archive refuses the live database named in another letter case, and its folder in another case', () => {
    const w = world()
    expect(failure(() => archivePlaintext({ inputs: [w.caseLive], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    expect(failure(() => archivePlaintext({ inputs: [join(w.root, 'DATA')], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    // The live database given in another case as the configured path: the real file is still recognised.
    expect(failure(() => archivePlaintext({ inputs: [w.live], outDir: w.out, keyring: w.ring, live: [w.caseLive] }))).toBe('live_database')
    expect(existsSync(w.out) ? readdirSync(w.out) : []).toEqual([])
  })

  it('removal re-checks each original just before removing it: one that has become the live database is refused, and nothing is removed', () => {
    const w = world()
    const old = join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak')
    const other = join(w.data, 'qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak')
    copyFileSync(w.live, old); copyFileSync(w.live, other)
    const a = archivePlaintext({ inputs: [old, other], outDir: w.out, keyring: w.ring, live: [w.live] })
    // Later the configuration names one of them as the live database (through the link to its folder).
    expect(failure(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [join(w.root, 'via-link', 'qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak')] }))).toBe('live_database')
    expect(existsSync(old) && existsSync(other)).toBe(true)
    // An original that looks open just before its removal (a -wal appears) stops the removal there, with a record.
    let opened = ''
    const seam = (p: string): void => { if (p === other) { writeFileSync(`${other}-wal`, ''); opened = p } }
    expect(failure(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live], beforeUnlink: seam }))).toBe('in_use')
    expect(opened).toBe(other)
    expect(existsSync(other)).toBe(true)
    expect(readdirSync(a.dir).filter((f) => f.startsWith('removal-'))).toHaveLength(1) // what was removed before the stop is recorded
  })

  inAnotherCase('removal refuses an original that has become the live database named in another letter case, and removes nothing', () => {
    const w = world()
    const old = join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak')
    const other = join(w.data, 'qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak')
    copyFileSync(w.live, old); copyFileSync(w.live, other)
    const a = archivePlaintext({ inputs: [old, other], outDir: w.out, keyring: w.ring, live: [w.live] })
    expect(failure(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [join(w.root, 'DATA', 'QED.DB.PRE-V5-2026-11-23T14-35-22-815Z.BAK')] }))).toBe('live_database')
    expect(existsSync(old) && existsSync(other)).toBe(true)
  })

  it('scan names the live database as live when the configured path reaches it through a link', () => {
    const w = world()
    copyFileSync(w.live, join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak'))
    const found = scanPlaintext(w.data, { live: [w.linkLive] })
    expect(found.find((f) => f.path === w.live)?.kind).toBe('live')
    expect(found.find((f) => f.path.endsWith('.bak'))).toMatchObject({ kind: 'plaintext-copy', recorded: true })
  })

  inAnotherCase('scan names the live database as live when the configured path is in another letter case', () => {
    const w = world()
    copyFileSync(w.live, join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak'))
    const found = scanPlaintext(w.data, { live: [w.caseLive] })
    expect(found.find((f) => f.path === w.live)?.kind).toBe('live')
    expect(found.find((f) => f.path.endsWith('.bak'))).toMatchObject({ kind: 'plaintext-copy', recorded: true })
  })
})

describe('one file named twice (finding 6, p6)', () => {
  it('through a link to its folder is one entry; removal removes it once and records it', () => {
    const w = world()
    const old = join(w.data, 'old.bak')
    copyFileSync(w.live, old)
    const a = archivePlaintext({ inputs: [old, join(w.root, 'via-link', 'old.bak')], outDir: w.out, keyring: w.ring, live: [w.live] })
    expect(a.manifest.entries).toHaveLength(1)
    const r = removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] })
    expect(r.removed.map((x) => x.path)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(r.recordPath)).toBe(true)
  })

  inAnotherCase('in two letter cases is one entry; removal removes it once and records it', () => {
    const w = world()
    const old = join(w.data, 'old.bak')
    copyFileSync(w.live, old)
    const a = archivePlaintext({ inputs: [old, join(w.root, 'DATA', 'OLD.BAK')], outDir: w.out, keyring: w.ring, live: [w.live] })
    expect(a.manifest.entries).toHaveLength(1)
    const r = removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live] })
    expect(r.removed.map((x) => x.path)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(r.recordPath)).toBe(true)
  })

  it('an original that vanishes between the check and its removal is counted as already gone, not a crash', () => {
    const w = world()
    const x = join(w.data, 'x.bak'), y = join(w.data, 'y.bak')
    copyFileSync(w.live, x); writeFileSync(y, 'another file')
    const a = archivePlaintext({ inputs: [x, y], outDir: w.out, keyring: w.ring, live: [w.live] })
    const r = removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live], beforeUnlink: (p) => { if (p === x) rmSync(x) } })
    expect(r.removed.map((e) => e.path)).toEqual([y])
    expect(r.alreadyGone.map((e) => e.path)).toEqual([x])
  })
})

describe('a restore into the live path named another way (finding 2)', () => {
  it('through a link to its folder needs --overwrite-live even when the live file does not exist yet', () => {
    const w = world()
    const b = createBackup({ db: w.live, outDir: join(w.root, 'backups'), keyring: w.ring })
    const fresh = join(w.root, 'Fresh')
    mkdirSync(fresh, { mode: 0o700 })
    symlinkSync(fresh, join(w.root, 'fresh-link'))
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: w.ring, target: join(w.root, 'fresh-link', 'qed.db'), live: join(fresh, 'qed.db') }))).toBe('would_overwrite_live')
    expect(readdirSync(fresh)).toEqual([])
  })

  inAnotherCase('in another letter case needs --overwrite-live even when the live file does not exist yet', () => {
    const w = world()
    const b = createBackup({ db: w.live, outDir: join(w.root, 'backups'), keyring: w.ring })
    const fresh = join(w.root, 'Fresh')
    mkdirSync(fresh, { mode: 0o700 })
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: w.ring, target: join(w.root, 'FRESH', 'QED.db'), live: join(fresh, 'qed.db') }))).toBe('would_overwrite_live')
    expect(readdirSync(fresh)).toEqual([])
  })
})
