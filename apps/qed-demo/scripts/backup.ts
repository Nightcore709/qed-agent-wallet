/**
 * Encrypted backups, the copies taken before a migration, and the keys that seal them (R7-076, R7-085, R11 section 11;
 * docs/ENCRYPTION.md). Nothing here prints a key: keys are written to files (mode 600) or read from the environment.
 *
 *   npm run keys:init       init-keys                     a key-encryption key file and one keyring per purpose; safe to rerun
 *   npm run keys:status     status                        where the keys are; each keyring's versions and check values
 *   npm run backup          create [--db <path>] [--out <dir>] [--temp <dir>] [--json]
 *   npm run backup:verify   verify [--dir <folder>]... [--json]      every sealed set decrypted in memory and checked
 *   npm run backup:drill    drill [--manifest <path>] [--keep] [--json]
 *                           restore into a private scratch folder, then `node server/main.ts verify` on it
 *   npm run restore --      restore --manifest <path> --target <path> [--live <path>] [--overwrite-live --backup-live-to <dir>] [--json]
 *                           reencrypt (--manifest <path> [--out <dir>] | --all [--purpose <p>]) [--json]
 *                           rotate [--purpose <p>] [--copy-to <dir>]...
 *                           rewrap (--new-key-file <path> | --new-key-env <NAME>) [--copy-to <dir>]...
 *                           revoke [--purpose <p>] --version <n> --confirm [--copy-to <dir>]...
 *                           expire [--purpose <p>] [--confirm]   rotate the key when due, destroy keys past the window (without --confirm: say what it would do)
 *                           list [--purpose <p>]
 *                           forget --dir <folder> [--purpose <p>]   stop recording a folder whose copies are gone for good
 *   The forms of 22 Nov are still accepted: init-key --key-file <path>; init --keyring <path> KEY; --keyring <path>.
 *
 * Defaults (server/key-config.ts): the key folder QED_KEY_DIR (default ~/.qed/keys) holding qed.kek and one keyring per
 * purpose; the backup folder QED_BACKUP_DIR (default ~/.qed/backups); the database QED_DB (default data/qed.db), whose
 * migration copies are in migration-copies/ beside it. KEY overrides the key-encryption key: --key-file <path> or
 * --key-env <NAME>. --purpose is backup (the default) or migration-copy; a restore or re-encryption takes the purpose of
 * the copy it is given. A restore never writes the live database without --overwrite-live. The archives of plaintext copies
 * (scripts/plaintext-copies.ts, in <backup folder>/archives) are sealed under the backup key: verify checks them,
 * reencrypt --all moves them to the new version, and revoke refuses while one still needs the old version.
 * Exit codes: 0 done; 1 refused or failed (the code and the message say why); 2 usage.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { BackupError, createBackup, listManifests, type Manifest, purposeOf, readManifest, reencryptBackup, restoreBackup, verifySealed } from '../server/backup.ts'
import { APP_ROOT, loadConfig } from '../server/core.ts'
import { initKeys, kekProvider, keyPaths, migrationCopyDir } from '../server/key-config.ts'
import { EnvKekProvider, FileKekProvider, KEY_PURPOSES, KeyError, Keyring, type Kek, type KeyPurpose, samePath } from '../server/keys.ts'
import { type ArchiveManifest, ArchiveError, listArchives, readArchive, reencryptArchive, verifyArchive } from '../server/plaintext-archive.ts'
import { keepScratch, makeScratch } from '../server/scratch.ts'
import { applyExpiry, SEALED_WINDOW_DAYS } from '../server/sealed-expiry.ts'
import { sweepOrRefuse } from '../server/sealed.ts'

// SIGINT, SIGTERM and SIGHUP wait for the step under way to finish. Every step here is synchronous (a seal, a restore, a
// drill and its child), so with a handler in place a signal is acted on only once the step and its own clean-up are done,
// and none is cut off with plaintext on disk (independent review of cb85271, findings 1 and 4). What a SIGKILL leaves is
// swept by the next run in the same place (server/scratch.ts).
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => {})
/** The private folders a drill restores into, in the system's temporary folder. */
const DRILL_PREFIX = 'qed-drill-'

const USAGE = 'Usage: node scripts/backup.ts <init-keys | status | create | verify | drill | restore | reencrypt | rotate | rewrap | revoke | expire | list | forget | init-key | init> [options] (see the comment at the top of this file)'
const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    'key-file': { type: 'string' }, 'key-env': { type: 'string' }, keyring: { type: 'string' },
    db: { type: 'string' }, out: { type: 'string' }, temp: { type: 'string' }, dir: { type: 'string', multiple: true },
    manifest: { type: 'string' }, target: { type: 'string' }, live: { type: 'string' },
    'overwrite-live': { type: 'boolean' }, 'backup-live-to': { type: 'string' },
    'new-key-file': { type: 'string' }, 'new-key-env': { type: 'string' }, purpose: { type: 'string' }, all: { type: 'boolean' },
    'copy-to': { type: 'string', multiple: true }, version: { type: 'string' }, confirm: { type: 'boolean' }, json: { type: 'boolean' }, keep: { type: 'boolean' },
  },
})
const cmd = positionals[0]
const usage = (why: string): never => { console.error(`backup: ${why}\n${USAGE}`); process.exit(2) }
const need = (name: keyof typeof v): string => { const x = v[name]; if (typeof x !== 'string' || x === '') usage(`--${name} is required for "${cmd}"`); return x as string }
const say = (line: string): void => { if (!v.json) console.log(line) }
const print = (human: string, json: unknown): void => { console.log(v.json ? JSON.stringify(json, null, 1) : human) }
/** On a machine where no key was ever made, "restore it from escrow" is the wrong advice: say how to set keys up. */
const SETUP_HINT = (code: string): string => (code === 'key_missing' || code === 'keyring_missing' ? ' If keys were never set up here, run `npm run keys:init` first (docs/ENCRYPTION.md, section 4).' : '')
/** A refusal of this tool's own (beside KeyError and BackupError): printed as "backup: <code>: <message>", exit 1. */
class Refusal extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code } }

const cfg = loadConfig()
const paths = keyPaths()
const dbPath = v.db ?? cfg.dbPath
const copiesDir = migrationCopyDir(dbPath)
const folderOf = (p: KeyPurpose): string => (p === 'migration-copy' ? copiesDir : paths.backupDir)
const archivesDir = join(paths.backupDir, 'archives')
const archivesIn = (dir: string): ArchiveManifest[] => listArchives(dir).flatMap((p) => { try { return [readArchive(p).m] } catch { return [] } })
function purposeArg(): KeyPurpose {
  const p = v.purpose ?? 'backup'
  if (p !== 'backup' && p !== 'migration-copy') usage('--purpose is backup or migration-copy')
  return p as KeyPurpose
}

/** Folders a key file must never be inside: the database's, the backups', the migration copies' and any given here. */
function forbidden(): string[] {
  return [dirname(cfg.dbPath), dirname(dbPath), paths.backupDir, copiesDir, ...(v.out ? [v.out] : []), ...(v.manifest ? [dirname(v.manifest)] : []), ...(v.dir ?? []), ...(v['copy-to'] ?? [])]
}
let kekCache: Kek | undefined
/** The key-encryption key: --key-file or --key-env if given, else as configured (QED_KEK, QED_KEY_FILE, the key folder). */
function kek(): Kek {
  if (kekCache) return kekCache
  if (v['key-file'] && v['key-env']) usage('give --key-file or --key-env, not both')
  const p = v['key-file'] ? new FileKekProvider(v['key-file'], { forbiddenFolders: forbidden() }) : v['key-env'] ? new EnvKekProvider(v['key-env']) : kekProvider(process.env, forbidden())
  return (kekCache = p.load())
}
const rings = new Map<KeyPurpose, Keyring>()
/** The keyring of a purpose: --keyring if given (each use checks its purpose), else the key folder's, which must be of that purpose. */
function ring(p: KeyPurpose): Keyring {
  let r = rings.get(p)
  // --keyring must be of the purpose asked for: the wallet-secret keyring, revoked through here, would have its sealed
  // secrets checked nowhere (independent review of 09db70b, M-1); it is the wallet service's (ENCRYPTION.md section 9)
  if (!r) { r = v.keyring ? Keyring.load(v.keyring, kek(), p) : Keyring.load(paths.keyring[p], kek(), p); rings.set(p, r) }
  return r
}
const manifestsIn = (dir: string): Manifest[] => listManifests(dir).flatMap((p) => { try { return [readManifest(p).m] } catch { return [] } })
const successorOf = (all: Manifest[], id: string): Manifest | undefined => all.find((m) => m.reencryptedFrom === id)
const ARCHIVE_DIR = /^ar-\d{8}T\d{6}Z-[0-9a-f]{6}$/

/**
 * Every folder known to hold copies sealed under the keyring of purpose p, or copies of that keyring (independent review
 * of cb85271, finding 3): its default folder (for backups, also the archives folder), the folders the keyring recorded
 * when copies were made there (<keyring>.places: --out folders, archives, a restore's backup of the live database), and
 * --copy-to. An archive's own folder counts as its archives folder. Each is listed once, by identity. `missing`: recorded
 * folders that cannot be reached now (deleted, or on a disk that is not mounted).
 */
function knownFolders(p: KeyPurpose, loaded?: Keyring): { folders: string[]; missing: string[] } {
  const folders: string[] = [], missing: string[] = []
  const add = (d0: string, recorded: boolean): void => {
    const d = ARCHIVE_DIR.test(basename(d0)) ? dirname(d0) : d0
    if (!existsSync(d)) { if (recorded && !missing.some((x) => samePath(x, d))) missing.push(d); return }
    if (!folders.some((x) => samePath(x, d))) folders.push(resolve(d))
  }
  add(folderOf(p), false)
  if (p === 'backup') add(archivesDir, false)
  let recorded: string[] = []
  // the keyring in hand when there is one: after a rewrap the key folder's keyring no longer opens under the old key, and
  // its recorded places were then silently skipped, so copies outside the default folder were not refreshed (24 Nov)
  try { recorded = (loaded ?? ring(p)).places() } catch (e) { if (!(e instanceof KeyError)) throw e }
  for (const d of recorded) add(d, true)
  for (const d of v['copy-to'] ?? []) add(d, false)
  return { folders, missing }
}

/** The copies of keyring r in these folders and in the archives in them: each keyring.json of r's purpose holding r's keys. */
function copiesOf(r: Keyring, folders: string[]): string[] {
  const mine = new Set(r.list().map((k) => k.kid))
  const out: string[] = []
  const consider = (c: string): void => {
    if (!existsSync(c) || out.some((x) => samePath(x, c))) return
    try {
      const f = JSON.parse(readFileSync(c, 'utf8')) as { purpose?: string; keys?: { kid?: string }[] }
      if ((f.purpose ?? 'backup') === r.purpose && (f.keys ?? []).some((k) => mine.has(k.kid ?? ''))) out.push(c)
    } catch { /* not a keyring copy */ }
  }
  for (const d of folders) {
    consider(join(d, 'keyring.json'))
    for (const a of listArchives(d)) consider(join(dirname(a), 'keyring.json'))
  }
  return out
}

/**
 * After a change to a keyring, rewrite every copy of it that is known (copiesOf the known folders; with --keyring, only
 * --copy-to), and write one into each --copy-to folder. A copy that cannot be rewritten is reported, not hidden.
 */
function refreshCopies(r: Keyring): { refreshed: string[]; failed: string[] } {
  const targets = v.keyring ? [] : copiesOf(r, knownFolders(r.purpose, r).folders)
  for (const d of v['copy-to'] ?? []) { const c = join(d, 'keyring.json'); if (!targets.some((x) => samePath(x, c))) targets.push(c) }
  const refreshed: string[] = [], failed: string[] = []
  for (const t of targets) {
    try { r.copyTo(t); refreshed.push(t) } catch (e) { failed.push(`${t} (${e instanceof KeyError ? e.code : (e as NodeJS.ErrnoException).code ?? (e as Error).message})`) }
  }
  return { refreshed, failed }
}
const listed = (label: string, items: string[]): string => items.map((x) => `\n  ${label} ${x}`).join('')
function reportCopies(c: { refreshed: string[]; failed: string[] }, what: string): void {
  if (c.failed.length) { console.error(`backup: copies_not_refreshed: ${c.failed.join(', ')} could not be rewritten and still ${what}; rewrite them (rotate refreshes copies) or remove them.`); process.exitCode = 1 }
}

function initKeysCmd(): void {
  const r = initKeys({ forbidden: forbidden() })
  const lines = [r.kek.created
    ? `Made a new key-encryption key ${r.kek.id} at ${r.kek.where.replace(/^The key file /, '')} (mode 600). Escrow a copy offline now (docs/ENCRYPTION.md, section 3): without it nothing sealed under these keyrings can be opened. Never keep the copy beside the backups.`
    : `The key-encryption key ${r.kek.id} (${r.kek.where}) is already set up.`]
  for (const k of r.keyrings) lines.push(k.created ? `Made the ${k.purpose} keyring ${k.path}: data key ${k.kid}, version ${k.version}, check ${k.check}.` : `The ${k.purpose} keyring ${k.path} is already set up (version ${k.version} active, check ${k.check}).`)
  print(lines.join('\n'), r)
}

function statusCmd(): void {
  const lines = [`key folder ${paths.dir}`]
  let ok = true
  try {
    const k = kek()
    lines.push(`key-encryption key ${k.id}: ${paths.kekEnv ? 'from the environment variable QED_KEK' : `the file ${paths.kekFile}`}`)
    for (const p of ['backup', 'migration-copy', 'wallet-secret'] as const) {
      try {
        const r = ring(p)
        lines.push(`${p} keyring ${r.path} (generation ${r.generation}): ${r.list().map((x) => `version ${x.version} ${x.state}${x.check ? `, check ${x.check}` : ''}`).join('; ')}`)
      } catch (e) { if (!(e instanceof KeyError)) throw e; ok = false; lines.push(`${p} keyring: not available (${e.code}): ${e.message}`) }
    }
  } catch (e) { if (!(e instanceof KeyError)) throw e; ok = false; lines.push(`key-encryption key: not available (${e.code}): ${e.message}`) }
  lines.push(`backups ${paths.backupDir}: ${listManifests(paths.backupDir).length} sealed sets`, `migration copies ${copiesDir}: ${listManifests(copiesDir).length} sealed sets`)
  if (!ok) lines.push('Set the keys up with `npm run keys:init` (docs/ENCRYPTION.md, section 4), or point QED_KEY_DIR at them.')
  console.log(lines.join('\n'))
  if (!ok) process.exitCode = 1
}

interface SetResult { id: string; purpose: string; folder: string; state: 'ok' | 'failed' | 'superseded'; keyVersion: number; code?: string; detail: string; ms?: number }
function verifyCmd(): void {
  const known = [knownFolders('backup'), knownFolders('migration-copy')]
  const dirs = v.dir?.length ? v.dir : known.flatMap((k) => k.folders).filter((d, i, all) => all.findIndex((x) => samePath(x, d)) === i)
  const unreachable = v.dir?.length ? [] : known.flatMap((k) => k.missing)
  const sets: SetResult[] = []
  const copies: { path: string; ok: boolean; detail: string }[] = []
  for (const dir of dirs) {
    const all = manifestsIn(dir)
    const used: Manifest[] = []
    for (const path of listManifests(dir)) {
      let m: Manifest | undefined
      try {
        m = readManifest(path).m
        const r = verifySealed(path, ring(purposeOf(m)))
        used.push(m)
        sets.push({ id: m.id, purpose: purposeOf(m), folder: dir, state: 'ok', keyVersion: m.key.version, detail: `${m.plaintext.bytes} bytes, snapshot ${new Date(m.snapshotAtMs).toISOString()}${m.migration ? `, schema ${m.migration.from} before a migration to ${m.migration.to}` : ''}`, ms: r.ms })
      } catch (e) {
        if (!(e instanceof KeyError || e instanceof BackupError)) throw e
        const next = m && e.code === 'key_revoked' ? successorOf(all, m.id) : undefined
        sets.push({ id: m?.id ?? path, purpose: m ? purposeOf(m) : 'unknown', folder: dir, state: next ? 'superseded' : 'failed', keyVersion: m?.key.version ?? 0, code: e.code, detail: next ? `re-encrypted as ${next.id}; its key version is revoked, so it can be deleted` : e.message })
      }
    }
    // Archives of plaintext copies, each a folder of sealed entries under the backup key.
    const archives = archivesIn(dir)
    for (const a of archives) {
      const r = verifyArchive({ manifest: join(dir, a.id, 'archive.json'), keyring: ring('backup') })
      const ok = r.entries.filter((e) => e.sealed === 'ok').length
      const next = archives.find((x) => x.reencryptedFrom === a.id)
      const superseded = !r.ok && next !== undefined && r.entries.every((e) => e.sealed === 'key_revoked')
      sets.push({ id: `archive ${a.id}`, purpose: 'backup', folder: dir, state: r.ok ? 'ok' : superseded ? 'superseded' : 'failed', keyVersion: a.key.version, detail: superseded ? `re-encrypted as ${next!.id}; its key version is revoked, so it can be deleted` : `${ok} of ${r.entries.length} entries decrypt to their recorded contents (key version ${a.key.version})${r.ok ? '' : `: ${[...(r.record === 'ok' ? [] : [`record ${r.record}`]), ...r.entries.filter((e) => e.sealed !== 'ok').map((e) => `entry ${e.index} ${e.sealed}`)].join(', ')}`}` })
    }
    // The keyring copy beside the sets is what a fresh host restores with: it must hold every key version they use.
    const copy = join(dir, 'keyring.json')
    if (existsSync(copy) && used.length) {
      try {
        const c = Keyring.load(copy, kek(), purposeOf(used[0]!))
        const missing = [...new Set(used.map((m) => m.key.version))].filter((ver) => { const k = c.list().find((x) => x.version === ver); const main = ring(purposeOf(used[0]!)).list().find((x) => x.version === ver); return !k || k.check === null || k.check !== main?.check })
        copies.push({ path: copy, ok: missing.length === 0, detail: missing.length ? `lacks key version ${missing.join(', ')} used here; refresh it (rotate or revoke refresh it; or --copy-to)` : `covers every key version used here (${[...new Set(used.map((m) => m.key.version))].join(', ')})` })
      } catch (e) { if (!(e instanceof KeyError)) throw e; copies.push({ path: copy, ok: false, detail: `${e.code}: ${e.message}` }) }
    }
  }
  const counted = sets.filter((s) => s.state !== 'superseded')
  const verified = counted.filter((s) => s.state === 'ok').length
  const ok = verified === counted.length && copies.every((c) => c.ok) && unreachable.length === 0
  const lines = [
    ...unreachable.map((d) => `FAIL ${d}: copies were made under a keyring here, and it cannot be reached now (deleted, or a disk not mounted). Make it reachable; if its copies are gone for good: node scripts/backup.ts forget --dir '${d}' --purpose <backup|migration-copy>`),
    ...sets.map((s) => s.id.startsWith('archive ')
      ? `${s.state === 'ok' ? 'OK' : s.state === 'superseded' ? 'superseded' : 'FAIL'} ${s.id}: ${s.detail}`
      : s.state === 'ok' ? `OK ${s.id} ${s.purpose}, key version ${s.keyVersion}: ${s.detail} (checked in ${s.ms} ms)` : s.state === 'superseded' ? `superseded ${s.id} ${s.purpose}: ${s.detail}` : `FAIL ${s.id} ${s.purpose}: ${s.code}: ${s.detail}`),
    ...copies.map((c) => `${c.ok ? 'OK' : 'FAIL'} keyring copy ${c.path}: ${c.detail}`),
    `${verified} of ${counted.length} sealed sets verified in ${dirs.join(', ')}${counted.length === 0 ? ' (none found)' : ''}`,
  ]
  print(lines.join('\n'), { ok, verified, total: counted.length, sets, keyringCopies: copies, unreachable })
  if (!ok) process.exitCode = 1
}

function drillCmd(): void {
  const t0 = performance.now()
  const manifest = v.manifest ?? listManifests(paths.backupDir).at(-1)
  if (!manifest) throw new Refusal('no_backup', `There is no backup in ${paths.backupDir} to drill; make one with \`npm run backup\`.`)
  const { m } = readManifest(manifest)
  // A drill folder an interrupted drill left (its owner gone) holds a restored plaintext copy: removed first, and said.
  const swept = sweepOrRefuse(tmpdir(), DRILL_PREFIX, say)
  const scratch = makeScratch(tmpdir(), DRILL_PREFIX, 'drill')
  try {
    const target = join(scratch, 'data', 'qed.db')
    const rr = restoreBackup({ manifest, keyring: ring(purposeOf(m)), target, live: cfg.dbPath, log: say })
    const t1 = performance.now()
    // The application's own check, in its own process, on the restored file. The key settings pass through so that an
    // older copy can be migrated (its migration copy lands in the scratch folder, removed below).
    const pass = ['PATH', 'HOME', 'QED_KEY_DIR', 'QED_KEY_FILE', 'QED_MIGRATION_KEYRING'].filter((k) => process.env[k] !== undefined)
    const child = spawnSync(process.execPath, [join(APP_ROOT, 'server', 'main.ts'), 'verify'], { encoding: 'utf8', env: { ...Object.fromEntries(pass.map((k) => [k, process.env[k]!])), QED_DB: target } })
    const appVerifyMs = Math.round((performance.now() - t1) * 10) / 10
    const lines = child.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('[migration]'))
    const ok = rr.verification.ok && child.status === 0
    const report = {
      drill: 'restore', at: new Date().toISOString(), manifest: m.id, purpose: purposeOf(m), keyVersion: m.key.version, snapshotAt: new Date(m.snapshotAtMs).toISOString(),
      restore: { verification: rr.verification, timings: rr.timings }, appVerify: { command: 'node server/main.ts verify', exit: child.status, lines, stderr: child.stderr.trim() },
      scratch, kept: v.keep === true, swept: swept.removed, timings: { restoreMs: rr.timings.totalMs, appVerifyMs, totalMs: Math.round((performance.now() - t0) * 10) / 10 }, ok,
    }
    print([...lines.map((l) => `  ${l}`), `${ok ? 'DRILL PASSED' : 'DRILL FAILED'}: ${m.id} restored and verified in ${rr.timings.totalMs} ms; \`node server/main.ts verify\` on the restored copy exited ${child.status} in ${appVerifyMs} ms; total ${report.timings.totalMs} ms${v.keep ? `; kept in ${scratch}` : '; the restored copy is removed'}`].join('\n'), report)
    if (!ok) process.exitCode = 1
  } finally { if (v.keep) keepScratch(scratch); else rmSync(scratch, { recursive: true, force: true }) }
}

function reencryptCmd(): void {
  if (!v.all) {
    const { m, manifestPath } = readManifest(need('manifest'))
    const r = reencryptBackup({ manifest: manifestPath, keyring: ring(purposeOf(m)), outDir: v.out ?? dirname(manifestPath), log: say })
    if (v.json) print('', r)
    return
  }
  const p = purposeArg()
  const r = ring(p)
  // Every folder known to hold copies under this keyring, each copy re-encrypted where it is (finding 3).
  const { folders, missing } = knownFolders(p)
  const sets = folders.flatMap((d) => manifestsIn(d).filter((m) => purposeOf(m) === p).map((m) => ({ m, d })))
  const all = sets.map((x) => x.m)
  const done = sets.filter(({ m }) => m.key.version !== r.activeVersion && !successorOf(all, m.id))
    .map(({ m, d }) => reencryptBackup({ manifest: join(d, `${m.id}.manifest.json`), keyring: r, outDir: d, log: say }).manifest.id)
  const archives = p === 'backup' ? folders.flatMap((d) => archivesIn(d).map((a) => ({ a, d }))) : []
  const moved = archives.filter(({ a }) => a.key.version !== r.activeVersion && !archives.some((x) => x.a.reencryptedFrom === a.id))
    .map(({ a, d }) => reencryptArchive({ manifest: join(d, a.id, 'archive.json'), keyring: r, outDir: d, log: say }).manifest.id)
  print(`${done.length} of ${all.length} ${p} sets re-encrypted under version ${r.activeVersion} in ${folders.join(', ')}${done.length ? '' : ' (none needed it)'}${p === 'backup' ? `; ${moved.length} archive${moved.length === 1 ? '' : 's'} of plaintext copies re-encrypted` : ''}.`, { reencrypted: done, archives: moved, folders, unreachable: missing })
  if (missing.length) { console.error(`backup: place_unreachable: ${missing.join(', ')} held copies under this keyring and cannot be reached now; they were not re-encrypted.`); process.exitCode = 1 }
}

function rewrapCmd(): void {
  // Every keyring this key-encryption key wraps is loaded first: if one fails, none is changed.
  const targets = v.keyring ? [Keyring.load(v.keyring, kek())] : KEY_PURPOSES.filter((p) => existsSync(paths.keyring[p])).map((p) => Keyring.load(paths.keyring[p], kek(), p))
  const next = v['new-key-file'] ? FileKekProvider.generate(v['new-key-file'], { forbiddenFolders: forbidden() }).load() : v['new-key-env'] ? new EnvKekProvider(v['new-key-env']).load() : usage('--new-key-file <path> or --new-key-env <NAME> is required')
  const old = kek().id
  const lines: string[] = []
  for (const r of targets) {
    r.rewrap(next)
    const c = refreshCopies(r)
    lines.push(`The ${r.purpose} keyring ${r.path} is re-wrapped under ${next.id} (generation ${r.generation})${listed('copy refreshed:', c.refreshed)}`)
    reportCopies(c, `open with ${old}`)
  }
  lines.push(`${old} no longer opens ${targets.length === 1 ? 'it' : 'them'}. Escrow the new key now; then use it (QED_KEY_FILE=${v['new-key-file'] ?? '<its file>'}, or move it into place as ${paths.kekFile ?? 'the key file'}); then destroy the old key and its escrow copies, and any keyring copy not refreshed above.`)
  print(lines.join('\n'), { kekId: next.id, previous: old, keyrings: targets.map((r) => r.path) })
}

function revokeCmd(): void {
  const version = Number(need('version'))
  if (!Number.isSafeInteger(version)) usage('--version must be a whole number')
  if (v.confirm !== true) usage('revoking destroys the key: re-encrypt every copy it sealed first (reencrypt --all), then pass --confirm')
  const p = purposeArg()
  const r = ring(p)
  const kid = r.list().find((k) => k.version === version)?.kid
  // Every folder known to hold copies under this keyring (finding 3): a copy anywhere still sealed under the version stops
  // the revocation, and so does a recorded folder that cannot be reached, since what it holds cannot be checked.
  const { folders, missing } = knownFolders(p)
  if (missing.length) throw new Refusal('place_unreachable', `Copies were made under this keyring in ${missing.join(', ')}, which cannot be reached now (deleted, or a disk that is not mounted), so it cannot be shown that none of them still needs version ${version}. Make it reachable and run this again; if those copies are gone for good, first: node scripts/backup.ts forget --dir <folder> --purpose ${p}`)
  const sets = folders.flatMap((d) => manifestsIn(d).filter((m) => purposeOf(m) === p))
  const archives = p === 'backup' ? folders.flatMap(archivesIn) : []
  const still = [
    ...sets.filter((m) => m.key.version === version && m.key.kid === kid && !successorOf(sets, m.id)).map((m) => m.id),
    ...archives.filter((a) => a.key.version === version && a.key.kid === kid && !archives.some((x) => x.reencryptedFrom === a.id)).map((a) => a.id),
  ]
  if (still.length) throw new Refusal('key_in_use', `${still.length} ${p} set(s) or archive(s) are still sealed under version ${version} (${still.join(', ')}; in ${folders.join(', ')}), and revoking would make them unreadable. Re-encrypt them first: node scripts/backup.ts reencrypt --all --purpose ${p}`)
  r.revoke(version)
  const c = refreshCopies(r)
  print(`Data key version ${version} of the ${p} keyring is revoked (generation ${r.generation}): its key material is destroyed in the keyring and in the ${c.refreshed.length} copies of it in the folders it knows of${listed('rewritten:', c.refreshed)}\nThe sets and archives it sealed can no longer be opened; copies made elsewhere (outside these folders, or off this computer) still hold it: destroy them.`, { keys: r.list(), generation: r.generation, copiesRewritten: c.refreshed, copiesNotRewritten: c.failed })
  reportCopies(c, `hold version ${version}`)
}

/**
 * Rotate the data key when it is due and destroy the keys whose copies are past the window (server/sealed-expiry.ts); the
 * copies under a destroyed key are removed. Without --confirm it only says what it would do.
 */
function expireCmd(): void {
  const p = purposeArg()
  const r = ring(p)
  const { folders, missing } = knownFolders(p)
  if (missing.length) throw new Refusal('place_unreachable', `Copies were made under this keyring in ${missing.join(', ')}, which cannot be reached now, so it cannot be shown which keys are still needed. Make it reachable and run this again.`)
  const sets = folders.flatMap((d) => manifestsIn(d).map((m) => ({ m, folder: d })))
  // a plaintext archive's own copy is sealed under a backup key too: that key is never destroyed here
  const pinned = p === 'backup' ? folders.flatMap(archivesIn).filter((a) => !folders.flatMap(archivesIn).some((x) => x.reencryptedFrom === a.id)).map((a) => ({ version: a.key.version, kid: a.key.kid })) : []
  const confirm = v.confirm === true
  const res = applyExpiry(r, sets, Date.now(), { dryRun: !confirm, pinned })
  const c = confirm && (res.rotated || res.destroyed.length) ? refreshCopies(r) : { refreshed: [], failed: [] }
  const days = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  print([
    `${confirm ? '' : 'Dry run (add --confirm to do it). '}${p}: ${confirm ? (res.rotated ? 'rotated to a new data key; ' : 'no rotation due; ') : (res.rotate ? 'a rotation is due; ' : 'no rotation due; ')}${res.revoke.length} key(s) past the ${SEALED_WINDOW_DAYS}-day window${confirm ? `, destroyed (${res.destroyed.join(', ') || 'none'}) with ${res.removed.length} sealed set(s) removed` : `: ${res.revoke.map((x) => `version ${x.version} (${x.copies.length} set(s))`).join(', ') || 'none'}`}.`,
    ...res.waiting.map((w) => `version ${w.version}: ${w.copies} set(s), can go ${w.revokableAt >= Number.MAX_SAFE_INTEGER ? 'never until its archives are re-encrypted' : days(w.revokableAt)}.`),
    'This destroys keys and removes files; it does not claim physical erasure, and it cannot reach copies kept elsewhere.',
  ].join('\n'), { dryRun: !confirm, ...res, copiesRewritten: c.refreshed, copiesNotRewritten: c.failed })
  reportCopies(c, 'hold a destroyed key')
}

/** Stop recording a folder as holding copies under a keyring (its copies are gone for good). */
function forgetCmd(): void {
  const p = purposeArg()
  const dir = v.dir?.[0] ?? usage('--dir <folder> is required for "forget"')
  const r = ring(p)
  print(r.forgetPlace(dir) ? `${dir} is no longer recorded as holding copies under the ${p} keyring.` : `${dir} was not recorded for the ${p} keyring.`, { forgotten: dir })
}

try {
  if (cmd === 'init-keys') initKeysCmd()
  else if (cmd === 'status') statusCmd()
  else if (cmd === 'create') {
    const r = createBackup({ db: dbPath, outDir: v.out ?? paths.backupDir, keyring: ring('backup'), ...(v.temp ? { tempParent: v.temp } : {}), log: say })
    if (v.json) print('', r)
  } else if (cmd === 'verify') verifyCmd()
  else if (cmd === 'drill') drillCmd()
  else if (cmd === 'restore') {
    const { m } = readManifest(need('manifest'))
    const overwriteLive = v['overwrite-live'] === true
    const r = restoreBackup({
      manifest: need('manifest'), keyring: ring(purposeOf(m)), target: need('target'), live: v.live ?? cfg.dbPath,
      overwriteLive, ...(v['backup-live-to'] ? { backupLiveTo: v['backup-live-to'] } : {}),
      ...(overwriteLive && purposeOf(m) !== 'backup' ? { backupKeyring: ring('backup') } : {}), log: say,
    })
    if (v.json) print('', r)
    if (!r.verification.ok) { console.error(`backup: verification_failed: the restored copy at ${r.target} did not verify (${r.verification.firstFailure ?? r.verification.integrity}); it is kept for inspection.`); process.exitCode = 1 }
  } else if (cmd === 'reencrypt') reencryptCmd()
  else if (cmd === 'rotate') {
    const p = purposeArg()
    const r = ring(p)
    const k = r.rotate()
    const c = refreshCopies(r)
    print(`The ${r.purpose} keyring now seals with data key version ${k.version} (${k.kid}, check ${k.check}; generation ${r.generation}); earlier versions still open what they sealed. Re-encrypt the older copies: node scripts/backup.ts reencrypt --all --purpose ${r.purpose}${listed('copy refreshed:', c.refreshed)}`, { keys: r.list(), generation: r.generation, copiesRewritten: c.refreshed })
    reportCopies(c, 'lack the new version')
  } else if (cmd === 'rewrap') rewrapCmd()
  else if (cmd === 'forget') forgetCmd()
  else if (cmd === 'revoke') revokeCmd()
  else if (cmd === 'expire') expireCmd()
  else if (cmd === 'list') {
    const r = ring(purposeArg())
    print(r.list().map((k) => `version ${k.version} ${k.kid} ${k.state}, created ${new Date(k.createdAt).toISOString()}${k.check ? `, check ${k.check}` : ''}`).join('\n') + `\n${r.purpose} keyring ${r.path}, generation ${r.generation}, wrapped by ${r.kekId}`, { purpose: r.purpose, generation: r.generation, kekId: r.kekId, keys: r.list() })
  } else if (cmd === 'init-key') {
    const p = FileKekProvider.generate(need('key-file'), { forbiddenFolders: forbidden() })
    print(`New key-encryption key ${p.load().id} written to ${p.path} (mode 600). Escrow a copy offline now; without it no backup sealed under its keyring can be opened.`, { kekId: p.load().id, path: p.path })
  } else if (cmd === 'init') {
    const r = Keyring.create(need('keyring'), kek(), Date.now(), purposeArg())
    print(`New ${r.purpose} keyring ${r.path}, data key version ${r.activeVersion}, wrapped by ${r.kekId}.`, { keyring: r.path, purpose: r.purpose, kekId: r.kekId, keys: r.list() })
  } else usage(cmd ? `unknown command "${cmd}"` : 'no command')
} catch (e) {
  if (e instanceof KeyError || e instanceof BackupError || e instanceof ArchiveError || e instanceof Refusal) { console.error(`backup: ${e.code}: ${e.message}${SETUP_HINT(e.code)}`); process.exit(1) }
  throw e
}
