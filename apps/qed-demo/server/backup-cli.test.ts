/**
 * The operator's commands (docs/ENCRYPTION.md section 4): `npm run keys:init`, `keys:status`, `backup`, `backup:verify`,
 * `backup:drill`, `restore`, and key rotation, re-wrapping and revocation, each run as its own process with the
 * defaults an operator gets (the key folder, the backup folder and the database found from QED_KEY_DIR, HOME and
 * QED_DB). Every database is an isolated fixture in a scratch folder; no output may carry a key or a stored value.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildFixture, SENSITIVE } from './backup-fixture.ts'
import { APP_ROOT, SCHEMA_VERSION } from './core.ts'
import { listManifests, type Manifest } from './sealed.ts'
import { sealMigrationCopy } from './migration-copy.ts'
import { FileKekProvider, Keyring, realish } from './keys.ts'
import { openKeyring } from './key-config.ts'
import { readSecret, writeSecret } from '../chain/rail/sealed-at-rest.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const manifestOf = (p: string): Manifest => JSON.parse(readFileSync(p, 'utf8')) as Manifest

/** A scratch home with a fixture database; the commands run with HOME, QED_DB and QED_KEY_DIR pointing into it. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'qed-cli-'))
  chmodSync(root, 0o700)
  made.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { mode: 0o700 })
  const db = join(dataDir, 'qed.db')
  buildFixture(db)
  const env = { PATH: process.env.PATH ?? '', HOME: root, QED_DB: db, QED_KEY_DIR: join(root, 'keys') }
  const outputs: SpawnSyncReturns<string>[] = []
  const run = (script: 'backup' | 'main', args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> => {
    const file = script === 'backup' ? join(APP_ROOT, 'scripts', 'backup.ts') : join(APP_ROOT, 'server', 'main.ts')
    const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { ...env, ...extra } })
    outputs.push(r)
    return r
  }
  const backups = join(root, '.qed', 'backups')
  /** No output so far has printed key material or a stored value. */
  const clean = (): void => {
    const keyFile = join(root, 'keys', 'qed.kek')
    const parts = existsSync(keyFile) ? [readFileSync(keyFile, 'utf8').trim().split(':')[2]!] : []
    for (const o of outputs) {
      const text = o.stdout + o.stderr
      for (const k of parts) expect(text).not.toContain(k)
      for (const m of SENSITIVE) expect(text).not.toContain(m)
    }
  }
  return { root, dataDir, db, env, run, backups, keyDir: join(root, 'keys'), clean }
}

describe('keys:init and keys:status', () => {
  it('make a private key folder with a key-encryption key and one keyring per purpose; again, change nothing; print no key', () => {
    const w = world()
    const first = w.run('backup', ['init-keys'])
    expect([first.status, first.stderr]).toEqual([0, ''])
    expect(first.stdout).toMatch(/new key-encryption key kek_[0-9a-f]{16}/)
    expect(first.stdout).toContain('Escrow')
    expect(mode(w.keyDir)).toBe('700')
    // Each keyring and, beside it, the highest generation written (a keyring put back from an older copy is refused).
    expect(readdirSync(w.keyDir).sort()).toEqual(['backup.keyring.generation', 'backup.keyring.json', 'migration-copy.keyring.generation', 'migration-copy.keyring.json', 'qed.kek', 'wallet-secret.keyring.generation', 'wallet-secret.keyring.json'])
    for (const f of readdirSync(w.keyDir)) expect([f, mode(join(w.keyDir, f))]).toEqual([f, '600'])
    const files = Object.fromEntries(readdirSync(w.keyDir).map((f) => [f, sha256(join(w.keyDir, f))]))
    const again = w.run('backup', ['init-keys'])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('already')
    expect(Object.fromEntries(readdirSync(w.keyDir).map((f) => [f, sha256(join(w.keyDir, f))]))).toEqual(files)
    const status = w.run('backup', ['status'])
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(/backup keyring .* version 1 active, check [0-9a-f]{16}/)
    expect(status.stdout).toMatch(/migration-copy keyring .* version 1 active, check [0-9a-f]{16}/)
    expect(status.stdout).toContain(w.backups)
    w.clean()
  }, 30_000)

  it('without keys, status and backup say how to set them up, exit 1, and write nothing', () => {
    const w = world()
    const status = w.run('backup', ['status'])
    expect(status.status).toBe(1)
    expect(status.stdout + status.stderr).toContain('npm run keys:init')
    const backup = w.run('backup', ['create'])
    expect(backup.status).toBe(1)
    expect(backup.stderr).toContain('key_missing')
    expect(backup.stderr).toContain('npm run keys:init')
    expect(existsSync(w.backups)).toBe(false)
  }, 30_000)
})

describe('backup, verify, drill and restore with the defaults', () => {
  it('backup seals the configured database into the backup folder; verify checks every sealed set end to end; a damaged one fails', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const made1 = w.run('backup', ['create'])
    expect([made1.status, made1.stderr]).toEqual([0, ''])
    expect(listManifests(w.backups)).toHaveLength(1)
    // A migration copy beside the database is verified too, under its own key.
    sealMigrationCopy(w.db, SCHEMA_VERSION, String(Number(SCHEMA_VERSION) + 1), { env: { HOME: w.root, QED_KEY_DIR: w.keyDir }, log: () => {} })
    const ok = w.run('backup', ['verify'])
    expect([ok.status, ok.stderr]).toEqual([0, ''])
    expect(ok.stdout).toMatch(/2 of 2 sealed sets verified/)
    expect(ok.stdout).toMatch(/OK bk-.* backup, key version 1/)
    expect(ok.stdout).toMatch(/OK mc-.* migration-copy, key version 1/)
    expect(ok.stdout).toMatch(/keyring copy .* covers every key version used/)
    const sealedFile = join(w.backups, manifestOf(listManifests(w.backups)[0]!).file)
    const x = readFileSync(sealedFile)
    x[x.length - 30] = x[x.length - 30]! ^ 1
    writeFileSync(sealedFile, x)
    const bad = w.run('backup', ['verify'])
    expect(bad.status).toBe(1)
    expect(bad.stdout).toMatch(/FAIL bk-.*backup_altered/)
    expect(bad.stdout).toMatch(/1 of 2 sealed sets verified/)
    w.clean()
  }, 60_000)

  it('expire without --confirm only says what it would do; with it, a fresh set and key are left alone and nothing physical is claimed', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    w.run('backup', ['create'])
    const before = readdirSync(w.backups).sort()
    const dry = w.run('backup', ['expire'])
    expect([dry.status, dry.stderr]).toEqual([0, ''])
    expect(dry.stdout).toMatch(/Dry run \(add --confirm to do it\)/)
    expect(dry.stdout).toMatch(/no rotation due/)
    expect(dry.stdout).toMatch(/does not claim physical erasure/)
    const real = w.run('backup', ['expire', '--confirm'])
    expect([real.status, real.stderr]).toEqual([0, ''])
    expect(real.stdout).not.toMatch(/Dry run/)
    expect(readdirSync(w.backups).sort()).toEqual(before)
    expect(w.run('backup', ['verify']).status).toBe(0)
    w.clean()
  }, 30_000)

  it('drill restores the newest backup into a private scratch folder, runs `node server/main.ts verify` on it, and removes it', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    w.run('backup', ['create'])
    const drill = w.run('backup', ['drill', '--json'])
    expect([drill.status, drill.stderr]).toEqual([0, ''])
    const report = JSON.parse(drill.stdout) as { ok: boolean; manifest: string; restore: { verification: { ok: boolean; users: number } }; appVerify: { exit: number; lines: string[] }; scratch: string; timings: Record<string, number> }
    expect(report.ok).toBe(true)
    expect(report.restore.verification).toMatchObject({ ok: true, users: 2 })
    expect(report.appVerify.exit).toBe(0)
    expect(report.appVerify.lines).toHaveLength(2)
    for (const l of report.appVerify.lines) expect(l).toMatch(/ledger consistent; receipts \d+ intact/)
    expect(report.timings.totalMs).toBeGreaterThan(0)
    expect(existsSync(report.scratch)).toBe(false)
    w.clean()
  }, 60_000)

  it('restore picks the keyring by the copy\'s purpose; it never writes over the live database without the flag', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const copy = sealMigrationCopy(w.db, SCHEMA_VERSION, String(Number(SCHEMA_VERSION) + 1), { env: { HOME: w.root, QED_KEY_DIR: w.keyDir }, log: () => {} })
    const target = join(w.root, 'restored', 'qed.db')
    const r = w.run('backup', ['restore', '--manifest', copy.manifestPath, '--target', target])
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(sha256(target)).toBe(copy.manifest.plaintext.sha256)
    const over = w.run('backup', ['restore', '--manifest', copy.manifestPath, '--target', w.db])
    expect(over.status).toBe(1)
    expect(over.stderr).toContain('would_overwrite_live')
    w.clean()
  }, 60_000)
})

describe('rotation, re-encryption, revocation and re-wrapping from the command line', () => {
  it('a keyring of another purpose given with --keyring is refused: the wallet service\'s keyring cannot be rotated or revoked through here (review of 09db70b, M-1)', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const ring = join(w.keyDir, 'wallet-secret.keyring.json')
    const before = sha256(ring)
    for (const args of [['revoke', '--keyring', ring, '--version', '1', '--confirm'], ['rotate', '--keyring', ring]]) {
      const r = w.run('backup', args)
      expect(r.status, args[0]).not.toBe(0)
      expect(r.stderr, args[0]).toMatch(/wallet-secret/)
    }
    expect(sha256(ring)).toBe(before)
    w.clean()
  })

  it('rotate, re-encrypt every older set, then revoke: refused while a set still needs the old key; the keyring copy is refreshed', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    w.run('backup', ['create'])
    const rot = w.run('backup', ['rotate'])
    expect([rot.status, rot.stderr]).toEqual([0, ''])
    expect(rot.stdout).toContain('version 2')
    const early = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect(early.status).toBe(1)
    expect(early.stderr).toContain('still sealed under version 1')
    const re = w.run('backup', ['reencrypt', '--all'])
    expect([re.status, re.stderr]).toEqual([0, ''])
    expect(listManifests(w.backups).map((p) => manifestOf(p).key.version).sort()).toEqual([1, 2])
    const rev = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect([rev.status, rev.stderr]).toEqual([0, ''])
    // The copy beside the backups no longer holds version 1's wrapped key.
    const copy = JSON.parse(readFileSync(join(w.backups, 'keyring.json'), 'utf8')) as { keys: { version: number; state: string; wrapped: string | null }[] }
    expect(copy.keys.find((k) => k.version === 1)).toMatchObject({ state: 'revoked', wrapped: null })
    const v = w.run('backup', ['verify'])
    expect(v.status).toBe(0)
    expect(v.stdout).toMatch(/superseded bk-.* re-encrypted as bk-/)
    expect(v.stdout).toMatch(/1 of 1 sealed sets? verified/)
    w.clean()
  }, 60_000)

  it('archives of plaintext copies count too: verify checks them, revoke refuses while one needs the old version, reencrypt --all moves them', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const bak = join(w.dataDir, 'qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak')
    writeFileSync(bak, readFileSync(w.db), { mode: 0o600 })
    const archived = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'plaintext-copies.ts'), 'archive', '--json'], { encoding: 'utf8', env: w.env })
    expect([archived.status, archived.stderr]).toEqual([0, ''])
    const v1 = w.run('backup', ['verify'])
    expect(v1.status).toBe(0)
    expect(v1.stdout).toMatch(/OK archive ar-.*: 1 of 1 entries/)
    w.run('backup', ['rotate'])
    const early = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect(early.status).toBe(1)
    expect(early.stderr).toMatch(/still sealed under version 1 .*ar-/)
    const re = w.run('backup', ['reencrypt', '--all'])
    expect([re.status, re.stderr]).toEqual([0, ''])
    expect(re.stdout).toMatch(/1 archive.* re-encrypted/)
    const rev = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect([rev.status, rev.stderr]).toEqual([0, ''])
    const v2 = w.run('backup', ['verify'])
    expect([v2.status, v2.stderr]).toEqual([0, ''])
    expect(v2.stdout).toMatch(/superseded archive ar-.* re-encrypted as ar-/)
    expect(v2.stdout).toMatch(/OK archive ar-.*: 1 of 1 entries/)
    expect(existsSync(bak)).toBe(true) // the original is never touched by any of this
    w.clean()
  }, 90_000)

  it('rewrap moves every keyring in the key folder under a new key-encryption key; the old key opens none of them', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const next = join(w.root, 'keys-2', 'qed.kek')
    const rw = w.run('backup', ['rewrap', '--new-key-file', next])
    expect([rw.status, rw.stderr]).toEqual([0, ''])
    expect(rw.stdout).toContain('backup keyring')
    expect(rw.stdout).toContain('migration-copy keyring')
    const old = w.run('backup', ['status'])
    expect(old.status).toBe(1)
    expect(old.stdout + old.stderr).toContain('wrong_key')
    const fresh = w.run('backup', ['status'], { QED_KEY_FILE: next })
    expect(fresh.status).toBe(0)
    w.clean()
  }, 60_000)

  it('rewrap also re-wraps the wallet-secret keyring and refreshes its copy beside the sealed wallet secrets, which then open under the new key only', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const rail = join(w.root, 'data', 'rail')
    const secret = Buffer.from(`${'c3'.repeat(32)}\n`)
    writeSecret(join(rail, 'master.key'), secret, { seal: true, fresh: true, ring: () => openKeyring('wallet-secret', { env: w.env }) })
    const before = JSON.parse(readFileSync(join(rail, 'keyring.json'), 'utf8')) as { kekId: string }
    const next = join(w.root, 'keys-2', 'qed.kek')
    const rw = w.run('backup', ['rewrap', '--new-key-file', next])
    expect([rw.status, rw.stderr]).toEqual([0, ''])
    expect(rw.stdout).toContain('wallet-secret keyring')
    const after = JSON.parse(readFileSync(join(rail, 'keyring.json'), 'utf8')) as { kekId: string }
    const nextKek = new FileKekProvider(next).load()
    expect([after.kekId === before.kekId, after.kekId]).toEqual([false, nextKek.id])
    const copy = Keyring.load(join(rail, 'keyring.json'), nextKek, 'wallet-secret')
    expect(readSecret(join(rail, 'master.key'), { seal: false, ring: () => copy })!.equals(secret)).toBe(true)
    w.clean()
  }, 60_000)
})

describe('npm run reset', () => {
  it('without the backup key refuses and changes nothing; with it, seals the database into the backup folder and removes it', () => {
    const w = world()
    const before = sha256(w.db)
    const refused = w.run('main', ['reset'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('Nothing was changed')
    expect(sha256(w.db)).toBe(before)
    expect(readdirSync(w.dataDir)).toEqual(['qed.db'])
    w.run('backup', ['init-keys'])
    const done = w.run('main', ['reset'])
    expect([done.status, done.stderr]).toEqual([0, ''])
    expect(readdirSync(w.dataDir)).toEqual([])
    const [m] = listManifests(w.backups)
    const back = w.run('backup', ['restore', '--manifest', m!, '--target', join(w.root, 'after-reset', 'qed.db'), '--json'])
    expect(back.status).toBe(0)
    expect((JSON.parse(back.stdout) as { verification: { ok: boolean; users: number } }).verification).toMatchObject({ ok: true, users: 2 })
    w.clean()
  }, 60_000)
})

describe('revocation reaches every copy (independent review of cb85271, finding 3)', () => {
  it('a backup made with --out elsewhere is found: revoke refuses while it needs the old version; reencrypt --all moves it; verify covers it', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const alt = join(w.root, 'alt')
    const made = w.run('backup', ['create', '--out', alt])
    expect([made.status, made.stderr]).toEqual([0, ''])
    w.run('backup', ['rotate'])
    const early = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect(early.status).toBe(1)
    expect(early.stderr).toContain('key_in_use')
    expect(early.stderr).toContain(manifestOf(listManifests(alt)[0]!).id)
    const re = w.run('backup', ['reencrypt', '--all'])
    expect([re.status, re.stderr]).toEqual([0, ''])
    expect(listManifests(alt).map((p) => manifestOf(p).key.version).sort()).toEqual([1, 2])
    const rev = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect([rev.status, rev.stderr]).toEqual([0, ''])
    const all = w.run('backup', ['verify'])
    expect([all.status, all.stderr]).toEqual([0, ''])
    expect(all.stdout).toContain(alt)
    const one = w.run('backup', ['verify', '--dir', alt])
    expect([one.status, one.stderr]).toEqual([0, ''])
    expect(one.stdout).toMatch(/superseded bk-.* re-encrypted as bk-/)
    w.clean()
  }, 90_000)

  it('after revoke no keyring copy it knows of still holds the revoked key, an archive\'s own copy included; the old archive no longer opens', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const bak = join(w.dataDir, 'qed.db.2026-11-20T07-44-18-335Z.bak')
    writeFileSync(bak, readFileSync(w.db), { mode: 0o600 })
    const archived = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'plaintext-copies.ts'), 'archive', '--json'], { encoding: 'utf8', env: w.env })
    expect([archived.status, archived.stderr]).toEqual([0, ''])
    const oldArchive = (JSON.parse(archived.stdout) as { dir: string }).dir
    w.run('backup', ['create'])
    w.run('backup', ['rotate'])
    w.run('backup', ['reencrypt', '--all'])
    const rev = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect([rev.status, rev.stderr]).toEqual([0, ''])
    expect(rev.stdout).toContain(join(oldArchive, 'keyring.json'))
    expect(rev.stdout).toMatch(/copies made elsewhere/)
    const copies = [join(w.backups, 'keyring.json'), ...readdirSync(join(w.backups, 'archives')).map((d) => join(w.backups, 'archives', d, 'keyring.json'))]
    expect(copies.length).toBeGreaterThanOrEqual(3)
    for (const c of copies) {
      const f = JSON.parse(readFileSync(c, 'utf8')) as { keys: { version: number; state: string; wrapped: string | null }[] }
      expect([c, f.keys.find((k) => k.version === 1)]).toEqual([c, expect.objectContaining({ state: 'revoked', wrapped: null })])
    }
    const v = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'plaintext-copies.ts'), 'verify', '--archive', oldArchive], { encoding: 'utf8', env: w.env })
    expect(v.status).toBe(1)
    expect(v.stdout).toContain('key_revoked')
    w.clean()
  }, 90_000)

  it('an older keyring copy put back over the keyring is refused: nothing is sealed under the revoked version', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const ringFile = join(w.keyDir, 'backup.keyring.json')
    const old = readFileSync(ringFile)
    w.run('backup', ['create'])
    w.run('backup', ['rotate'])
    w.run('backup', ['reencrypt', '--all'])
    expect(w.run('backup', ['revoke', '--version', '1', '--confirm']).status).toBe(0)
    const before = listManifests(w.backups).length
    writeFileSync(ringFile, old)
    for (const args of [['create'], ['list'], ['status']]) {
      const r = w.run('backup', args)
      expect([args[0], r.status]).toEqual([args[0], 1])
      expect(r.stdout + r.stderr).toContain('keyring_rolled_back')
    }
    expect(listManifests(w.backups)).toHaveLength(before)
    w.clean()
  }, 90_000)

  it('a recorded folder that cannot be reached (an unmounted disk) stops revoke and fails verify, until it is reachable or forgotten', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    const alt = join(w.root, 'external', 'qed-backups')
    expect(w.run('backup', ['create', '--out', alt]).status).toBe(0)
    w.run('backup', ['rotate'])
    w.run('backup', ['reencrypt', '--all'])
    const away = join(w.root, 'unmounted')
    renameSync(join(w.root, 'external'), away)
    const rev = w.run('backup', ['revoke', '--version', '1', '--confirm'])
    expect(rev.status).toBe(1)
    expect(rev.stderr).toContain('place_unreachable')
    expect(rev.stderr).toContain(realish(alt)) // reported by its canonical path
    const ver = w.run('backup', ['verify'])
    expect(ver.status).toBe(1)
    expect(ver.stdout).toContain(`FAIL ${realish(alt)}`)
    renameSync(away, join(w.root, 'external'))
    expect(w.run('backup', ['revoke', '--version', '1', '--confirm']).status).toBe(0)
    rmSync(join(w.root, 'external'), { recursive: true })
    expect(w.run('backup', ['verify']).status).toBe(1)
    const forgot = w.run('backup', ['forget', '--dir', alt])
    expect([forgot.status, forgot.stderr]).toEqual([0, ''])
    expect(w.run('backup', ['verify']).status).toBe(0)
    w.clean()
  }, 90_000)

  it('a lost keyring: the message says how to set keys up and to put back only the newest copy', () => {
    const w = world()
    w.run('backup', ['init-keys'])
    rmSync(join(w.keyDir, 'backup.keyring.json'))
    const r = w.run('backup', ['create'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('keyring_missing')
    expect(r.stderr).toContain('npm run keys:init')
    expect(r.stderr).toContain('newest copy')
    expect(r.stderr).not.toContain('Restore it (a copy is kept beside each backup set)')
  }, 30_000)
})
