/**
 * Which file a path names (independent review of cb85271, findings 2 and 6). macOS's default APFS is case-insensitive, and
 * node's realpathSync keeps the letter case it is given, so a guard that compared paths as strings could be passed by
 * writing a name in another case (or through a hard link). The guards compare files by device and inode, and folders by
 * walking up to the folder's own device and inode; a path that does not exist yet is compared by its canonical form
 * (the case the operating system gives, then case-folded on macOS and Windows). Synthetic fixtures in scratch folders.
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

// These tests are about a case-insensitive volume: they check that the scratch folder is one (macOS's default).
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
  return { root, data, live, keys, ring, out: join(root, 'backups', 'archives'), caseLive: join(root, 'DATA', 'QED.db') }
}
const caseInsensitive = (): boolean => { const d = scratch(); writeFileSync(join(d, 'probe'), ''); return existsSync(join(d, 'PROBE')) }

describe('the volume', () => {
  it('is case-insensitive (else these tests prove nothing)', () => { expect(caseInsensitive()).toBe(true) })
})

describe('samePath and inside', () => {
  it('a file in another letter case, through a symbolic link, or through a hard link is the same file; a sibling is not', () => {
    const w = world()
    symlinkSync(w.data, join(w.root, 'via-link'))
    linkSync(w.live, join(w.root, 'hard.db'))
    expect(samePath(w.caseLive, w.live)).toBe(true)
    expect(samePath(join(w.root, 'via-link', 'qed.db'), w.live)).toBe(true)
    expect(samePath(join(w.root, 'hard.db'), w.live)).toBe(true)
    copyFileSync(w.live, join(w.root, 'copy.db'))
    expect(samePath(join(w.root, 'copy.db'), w.live)).toBe(false)
    // Not there yet: compared by canonical path, ignoring case on this volume.
    expect(samePath(join(w.root, 'DATA', 'NEW.db'), join(w.data, 'new.db'))).toBe(true)
    expect(samePath(join(w.root, 'DATA', 'NEW.db'), join(w.data, 'other.db'))).toBe(false)
  })

  it('inside: a path under the folder named in another case, through a link, or not existing yet, is inside', () => {
    const w = world()
    symlinkSync(w.data, join(w.root, 'via-link'))
    expect(inside(join(w.root, 'DATA', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'data', 'sub', 'deeper', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'via-link', 'x.kek'), w.data)).toBe(true)
    expect(inside(join(w.root, 'Datum', 'x.kek'), w.data)).toBe(false)
    expect(inside(join(w.root, 'NOT-YET', 'x'), join(w.root, 'not-yet'))).toBe(true)
  })
})

describe('the key file is never inside the database or backup folders (finding 2, p2b)', () => {
  it('generate and load refuse a key path that reaches the data folder by another letter case or a link', () => {
    const w = world()
    symlinkSync(w.data, join(w.root, 'via-link'))
    for (const p of [join(w.root, 'DATA', 'b.kek'), join(w.root, 'data', 'c.kek'), join(w.root, 'via-link', 'd.kek')]) {
      expect([p, failure(() => FileKekProvider.generate(p, { forbiddenFolders: [w.data] }))]).toEqual([p, 'key_location'])
      expect(existsSync(p)).toBe(false)
    }
    // A key already inside, named in another case: load refuses it too.
    const k = join(w.data, 'inside.kek')
    FileKekProvider.generate(k)
    expect(failure(() => new FileKekProvider(join(w.root, 'DATA', 'INSIDE.kek'), { forbiddenFolders: [w.data] }).load())).toBe('key_location')
  })
})

describe('the live database is never archived or removed (finding 2, p2)', () => {
  it('archive refuses the live database named in another case, through a hard link, and its journal in another case', () => {
    const w = world()
    linkSync(w.live, join(w.root, 'hard.db'))
    expect(failure(() => archivePlaintext({ inputs: [w.caseLive], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
    expect(failure(() => archivePlaintext({ inputs: [join(w.root, 'hard.db')], outDir: w.out, keyring: w.ring, live: [w.live] }))).toBe('live_database')
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
    // Later the configuration names one of them as the live database (in another letter case).
    expect(failure(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [join(w.root, 'DATA', 'QED.DB.PRE-V5-2026-11-23T14-35-22-815Z.BAK')] }))).toBe('live_database')
    expect(existsSync(old) && existsSync(other)).toBe(true)
    // An original that looks open just before its removal (a -wal appears) stops the removal there, with a record.
    let opened = ''
    const seam = (p: string): void => { if (p === other) { writeFileSync(`${other}-wal`, ''); opened = p } }
    expect(failure(() => removeOriginals({ manifest: a.manifestPath, keyring: w.ring, confirm: a.manifest.id, live: [w.live], beforeUnlink: seam }))).toBe('in_use')
    expect(opened).toBe(other)
    expect(existsSync(other)).toBe(true)
    expect(readdirSync(a.dir).filter((f) => f.startsWith('removal-'))).toHaveLength(1) // what was removed before the stop is recorded
  })

  it('scan names the live database as live when the configured path is in another case', () => {
    const w = world()
    copyFileSync(w.live, join(w.data, 'qed.db.2026-11-20T07-44-18-335Z.bak'))
    const found = scanPlaintext(w.data, { live: [w.caseLive] })
    expect(found.find((f) => f.path === w.live)?.kind).toBe('live')
    expect(found.find((f) => f.path.endsWith('.bak'))).toMatchObject({ kind: 'plaintext-copy', recorded: true })
  })
})

describe('one file named twice (finding 6, p6)', () => {
  it('in two letter cases is one entry; removal removes it once and records it', () => {
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

describe('a restore into the live path named in another case (finding 2)', () => {
  it('needs --overwrite-live even when the live file does not exist yet', () => {
    const w = world()
    const b = createBackup({ db: w.live, outDir: join(w.root, 'backups'), keyring: w.ring })
    const fresh = join(w.root, 'Fresh')
    mkdirSync(fresh, { mode: 0o700 })
    expect(failure(() => restoreBackup({ manifest: b.manifestPath, keyring: w.ring, target: join(w.root, 'FRESH', 'QED.db'), live: join(fresh, 'qed.db') }))).toBe('would_overwrite_live')
    expect(readdirSync(fresh)).toEqual([])
  })
})
