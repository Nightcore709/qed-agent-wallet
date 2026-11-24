/**
 * Sealed copies of the QED database (R7-085, R7-076, R11 section 11; docs/ENCRYPTION.md section 4): a consistent copy,
 * encrypted and authenticated in one AES-256-GCM message under a keyring's active data key, and its manifest. Two kinds,
 * each under a keyring of its own purpose (key separation):
 *   - a backup (`npm run backup`, `npm run reset`), under the backup key;
 *   - the copy taken before a schema migration (server/migration-copy.ts), under the migration-copy key.
 *
 * Order, the same for both: a consistent copy with VACUUM INTO into an empty file (mode 600) in a private temporary
 * folder (mode 700) on the database's own volume; sealed into a partial file; the partial is read back and must decrypt
 * to exactly the copy (verified after writing); only then is it renamed into place, the plaintext copy removed and shown
 * to be gone, and the manifest written: SHA-256 of the plaintext and the ciphertext, the data key's id and version, the
 * time and the schema version. The same facts are in the sealed file's authenticated header, so an edited manifest is
 * detected. If any step fails nothing is recorded; a plaintext copy that cannot be removed fails the whole operation.
 * Re-encryption (after a rotation) streams from the old sealed file to the new one: its plaintext never reaches the disk.
 *
 * This module imports nothing from the server but keys.ts, so that core.ts can reach it (through migration-copy.ts)
 * without an import cycle. Verifying a restored database's ledgers and receipt chains, and the restore, are in backup.ts.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { headerOfFile, inside, KeyError, type Header, type Keyring, type KeyPurpose, replacePrivateFile } from './keys.ts'
import { makeScratch, sweepScratch, type Sweep } from './scratch.ts'

export type BackupErrorCode =
  | 'source_missing' | 'folder_permissions' | 'temp_unavailable' | 'temp_location' | 'plaintext_left_behind' | 'snapshot_changed'
  | 'manifest_missing' | 'manifest_malformed' | 'manifest_mismatch' | 'backup_missing' | 'backup_truncated' | 'backup_altered'
  | 'target_exists' | 'would_overwrite_live' | 'live_backup_required' | 'live_in_use' | 'verification_failed'

/** A refusal about a backup or a restore. Messages name files, ids and checks; never key material or stored values. */
export class BackupError extends Error {
  readonly code: BackupErrorCode
  constructor(code: BackupErrorCode, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

/** What a sealed copy is for; each is sealed under the keyring of the same purpose. */
export type SealedPurpose = Extract<KeyPurpose, 'backup' | 'migration-copy'>
interface Kind { prefix: string; context: string; meta: string; label: string }
const KINDS: Record<SealedPurpose, Kind> = {
  backup: { prefix: 'bk', context: 'qed/backup/v1', meta: 'qed-backup', label: 'backup' },
  'migration-copy': { prefix: 'mc', context: 'qed/migration-copy/v1', meta: 'qed-migration-copy', label: 'migration copy' },
}

export const MANIFEST_FORMAT = 'qed-backup/1'
export interface Manifest {
  format: typeof MANIFEST_FORMAT
  /** Absent in manifests written before 24 Nov 2026: those are all backups. */
  purpose?: SealedPurpose
  id: string
  /** The sealed file, beside the manifest: always `${id}.qedbak`. */
  file: string
  createdAt: string
  createdAtMs: number
  /** When the data was captured (the same as createdAtMs, except for a re-encrypted copy). */
  snapshotAtMs: number
  schemaVersion: string | null
  /** The database file's name (not its path). */
  source: string
  algorithm: 'AES-256-GCM'
  key: { kid: string; version: number }
  plaintext: { bytes: number; sha256: string }
  ciphertext: { bytes: number; sha256: string }
  /** A migration copy: the schema version the database had, and the one the migration was taking it to. */
  migration?: { from: string; to: string }
  reencryptedFrom?: string
}
export const purposeOf = (m: Pick<Manifest, 'purpose'>): SealedPurpose => m.purpose ?? 'backup'
/** The context a sealed file is bound to: its purpose and its id. A file cannot be opened as another kind or another copy. */
export const contextOf = (m: Pick<Manifest, 'purpose' | 'id'>): string => `${KINDS[purposeOf(m)].context}:${m.id}`

export interface BackupOptions {
  /** The database file; opened for VACUUM INTO only. */
  db: string
  /** Where the backup set goes (created mode 700). */
  outDir: string
  keyring: Keyring
  /** Where the private temporary folder is made. Default: the database's folder (the same volume and protection). */
  tempParent?: string
  /** Keep a copy of the keyring (wrapped keys only) beside the copies, so a restore needs only the KEK. Default true. */
  copyKeyring?: boolean
  now?: () => number
  log?: (line: string) => void
  /** Test seam: how the plaintext copy is removed. */
  remove?: (path: string) => void
  /** Test seam: called with the sealed partial file before it is read back (a test alters it to show the check is real). */
  afterSeal?: (path: string) => void
}
export interface BackupResult { manifest: Manifest; manifestPath: string; backupPath: string; timings: { snapshotMs: number; sealMs: number; verifyMs: number; totalMs: number } }

const ID_RE = /^(bk|mc)-\d{8}T\d{6}Z-[0-9a-f]{6}$/
const SHA_RE = /^[0-9a-f]{64}$/
const newId = (p: SealedPurpose, at: number): string => `${KINDS[p].prefix}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(3).toString('hex')}`
const ms = (t: number): number => Math.round((performance.now() - t) * 10) / 10
const noop = (): void => {}

export function sha256File(path: string): { bytes: number; sha256: string } {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(1 << 20)
  let bytes = 0
  try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) { h.update(buf.subarray(0, n)); bytes += n } } finally { closeSync(fd); buf.fill(0) }
  return { bytes, sha256: h.digest('hex') }
}

/** A folder for sealed copies or restored databases: created mode 700, or an existing one that only its owner can use. */
export function privateFolder(path: string, what: string): string {
  const p = resolve(path)
  if (!existsSync(p)) { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700) }
  const st = statSync(p)
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!st.isDirectory()) throw new BackupError('folder_permissions', `${what} ${p} is not a folder.`)
  if (me !== undefined && st.uid !== me) throw new BackupError('folder_permissions', `${what} ${p} belongs to uid ${st.uid}, not to this user (uid ${me}).`)
  if ((st.mode & 0o077) !== 0) throw new BackupError('folder_permissions', `${what} ${p} has mode ${(st.mode & 0o777).toString(8)}; it must be usable by its owner only. Run: chmod 700 '${p}'`)
  return p
}

/** The private temporary folders that hold a plaintext snapshot while it is sealed, beside the database. */
export const TEMP_PREFIX = '.qed-backup-'

/**
 * Sweep parent for scratch folders an interrupted operation left (scratch.ts). If one could not be removed, refuse: a
 * plaintext copy stays where it is not expected, and the operator must see it.
 */
export function sweepOrRefuse(parent: string, prefix: string, log: (line: string) => void): Sweep {
  let swept: Sweep
  try { swept = sweepScratch(parent, prefix, log) } catch (e) {
    throw new BackupError('temp_unavailable', `Cannot check ${parent} for plaintext left by an interrupted operation (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); refusing to go on.`)
  }
  if (swept.failed.length) throw new BackupError('plaintext_left_behind', `An interrupted operation left plaintext that could not be removed: ${swept.failed.map((f) => `${f.path} (${f.why})`).join(', ')}. Nothing was done. Remove it, then try again: ${swept.failed.map((f) => `rm -rf '${f.path}'`).join('; ')}`)
  return swept
}

/**
 * A private temporary folder (mode 700) in parent that records its owner, proven usable before any plaintext exists: a
 * probe file is made and removed. First the folders an interrupted seal left in parent are swept (scratch.ts). If the new
 * folder cannot be used the operation refuses to run, because a plaintext copy it could not remove would stay behind.
 */
export function tempFolder(parent: string, what = 'seal', log: (line: string) => void = noop): string {
  sweepOrRefuse(parent, TEMP_PREFIX, log)
  let dir: string | undefined
  try {
    dir = makeScratch(parent, TEMP_PREFIX, what)
    const probe = join(dir, 'probe')
    closeSync(openSync(probe, 'wx', 0o600))
    unlinkSync(probe)
    if (existsSync(probe)) throw new Error('a probe file could not be removed')
    if ((statSync(dir).mode & 0o077) !== 0) throw new Error('the folder is not private')
    return dir
  } catch (e) {
    if (dir) rmSync(dir, { recursive: true, force: true })
    throw new BackupError('temp_unavailable', `Cannot use a private temporary folder in ${parent} (${(e as Error).message}); refusing to make a plaintext copy that might not be removable.`)
  }
}

/** Remove the temporary folder and everything in it, then prove it is gone. */
export function removeTemp(dir: string, remove: (p: string) => void): void {
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) { try { remove(join(dir, name)) } catch { /* proven below */ } }
    try { rmdirSync(dir) } catch { /* proven below */ }
  }
  if (existsSync(dir)) throw new BackupError('plaintext_left_behind', `The plaintext copy in ${dir} could not be removed, so nothing was recorded. Remove it now: rm -rf '${dir}'`)
}

function readOnly<T>(path: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(path, { readOnly: true })
  try { return fn(d) } finally { d.close() }
}
export function schemaOf(path: string): string | null {
  try { return readOnly(path, (d) => (d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: string } | undefined)?.value ?? null) } catch { return null }
}

interface Capture { snapshotAtMs: number; schemaVersion: string | null; source: string; migration?: { from: string; to: string } }
type ProduceOptions = Omit<BackupOptions, 'db' | 'tempParent'> & {
  purpose: SealedPurpose
  tempParent: string
  /** Given the snapshot's size and SHA-256, an existing sealed set to use instead of sealing it again, or null. */
  reuse?: (plain: { bytes: number; sha256: string }) => BackupResult | null
}

/** The private folders a sealed file is written into before it is moved into place (ciphertext only), in the out folder. */
export const SEALING_PREFIX = '.qed-sealing-'
const STALE_PARTIAL_MS = 60_000
/**
 * Before writing into a folder of sealed copies: remove what an interrupted run left there (review of cb85271, suspicion
 * 3: orphaned partials were never cleaned). Sealing folders whose owner is gone are swept (scratch.ts); a loose
 * `….partial` file written by the code of 22 to 24 Nov, older than a minute, is removed. Both hold ciphertext only.
 */
function sweepPartials(dir: string, log: (line: string) => void): void {
  sweepOrRefuse(dir, SEALING_PREFIX, log)
  for (const n of readdirSync(dir)) {
    if (!/\.(qedbak|qedseal)\.partial$/.test(n)) continue
    const p = join(dir, n)
    const st = lstatSync(p)
    if (!st.isFile() || Date.now() - st.mtimeMs < STALE_PARTIAL_MS) continue
    rmSync(p, { force: true })
    log(`removed ${p}: a partly written sealed file left by an interrupted run (ciphertext only)`)
  }
}

/**
 * Read a sealed partial back before it counts: it must decrypt, under its context, to exactly the plaintext that was
 * sealed (SHA-256 and length), and still be the bytes that were written.
 */
function verifyWritten(keyring: Keyring, path: string, context: string, plain: { bytes: number; sha256: string }, cipherSha: string, label: string): void {
  let back: { plaintextBytes: number; plaintextSha256: string }
  try { back = keyring.verifyFile(path, context) } catch (e) {
    throw new BackupError('verification_failed', `The sealed ${label} did not verify after it was written (${e instanceof KeyError ? e.code : (e as Error).message}); it was removed and nothing was recorded.`)
  }
  if (back.plaintextSha256 !== plain.sha256 || back.plaintextBytes !== plain.bytes || sha256File(path).sha256 !== cipherSha) {
    throw new BackupError('verification_failed', `The sealed ${label} does not decrypt to the copy that was sealed; it was removed and nothing was recorded.`)
  }
}

/** The manifest, the keyring copy and the log line: written only once the sealed file is verified and in place. */
function record(o: Pick<ProduceOptions, 'keyring' | 'copyKeyring' | 'log'>, outDir: string, m: Manifest, label: string, timings: BackupResult['timings']): BackupResult {
  const manifestPath = join(outDir, `${m.id}.manifest.json`)
  replacePrivateFile(manifestPath, Buffer.from(`${JSON.stringify(m, null, 1)}\n`, 'utf8'))
  if (o.copyKeyring !== false) o.keyring.copyTo(join(outDir, 'keyring.json'))
  ;(o.log ?? noop)(`${label} ${m.id}: ${m.plaintext.bytes} bytes sealed under data key ${m.key.kid} (version ${m.key.version}) and verified in ${timings.totalMs} ms (copy ${timings.snapshotMs} ms, seal ${timings.sealMs} ms, check ${timings.verifyMs} ms); no plaintext copy is left`)
  return { manifest: m, manifestPath, backupPath: join(outDir, m.file), timings }
}

/** Make a sealed set from a plaintext snapshot that `fill` writes into an empty private file. See the module comment. */
function produce(o: ProduceOptions, fill: (snap: string) => Capture): BackupResult {
  const t0 = performance.now()
  const kind = KINDS[o.purpose]
  o.keyring.requirePurpose(o.purpose)
  const remove = o.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }))
  const log = o.log ?? noop
  const outDir = privateFolder(o.outDir, `The ${kind.label} folder`)
  o.keyring.notePlace(outDir) // so that revoking a key and re-encrypting find this folder (finding 3)
  if (inside(o.tempParent, outDir)) throw new BackupError('temp_location', `The temporary folder may not be inside the ${kind.label} folder ${outDir}: a plaintext copy must never reach where sealed copies are kept.`)
  sweepPartials(outDir, log)
  const at = (o.now ?? Date.now)()
  const id = newId(o.purpose, at)
  const context = `${kind.context}:${id}`
  const tmp = tempFolder(o.tempParent, kind.label, log)
  const snap = join(tmp, 'snapshot.db')
  let sealing: string | undefined
  const backupPath = join(outDir, `${id}.qedbak`)
  let placed = false
  try {
    const t1 = performance.now()
    closeSync(openSync(snap, 'wx', 0o600))
    const cap = fill(snap)
    const snapshotMs = ms(t1)
    const t2 = performance.now()
    const plain = sha256File(snap)
    const reused = o.reuse?.(plain)
    if (reused) { removeTemp(tmp, remove); return reused }
    sealing = makeScratch(outDir, SEALING_PREFIX, kind.label)
    const partial = join(sealing, `${id}.qedbak.partial`)
    const meta = { purpose: kind.meta, format: MANIFEST_FORMAT, id, createdAtMs: at, snapshotAtMs: cap.snapshotAtMs, schemaVersion: cap.schemaVersion, source: cap.source, plaintext: plain, ...(cap.migration ? { migration: cap.migration } : {}) }
    const sealed = o.keyring.encryptFile(snap, partial, context, meta)
    if (sealed.plaintextSha256 !== plain.sha256 || sealed.plaintextBytes !== plain.bytes) throw new BackupError('snapshot_changed', `The snapshot changed while it was being sealed; nothing was recorded.`)
    const sealMs = ms(t2)
    const t3 = performance.now()
    o.afterSeal?.(partial)
    verifyWritten(o.keyring, partial, context, plain, sealed.ciphertextSha256, kind.label)
    const verifyMs = ms(t3)
    renameSync(partial, backupPath)
    placed = true
    rmSync(sealing, { recursive: true, force: true })
    removeTemp(tmp, remove)
    const m: Manifest = {
      format: MANIFEST_FORMAT, purpose: o.purpose, id, file: basename(backupPath), createdAt: new Date(at).toISOString(), createdAtMs: at, snapshotAtMs: cap.snapshotAtMs,
      schemaVersion: cap.schemaVersion, source: cap.source, algorithm: 'AES-256-GCM', key: { kid: sealed.header.kid, version: sealed.header.version },
      plaintext: plain, ciphertext: { bytes: sealed.ciphertextBytes, sha256: sealed.ciphertextSha256 }, ...(cap.migration ? { migration: cap.migration } : {}),
    }
    return record(o, outDir, m, kind.label, { snapshotMs, sealMs, verifyMs, totalMs: ms(t0) })
  } catch (err) {
    if (sealing) rmSync(sealing, { recursive: true, force: true })
    if (placed && !existsSync(join(outDir, `${id}.manifest.json`))) rmSync(backupPath, { force: true })
    try { removeTemp(tmp, remove) } catch (left) {
      if (err instanceof BackupError && err.code === 'plaintext_left_behind') throw err
      throw new BackupError('plaintext_left_behind', `${(left as Error).message} The ${kind.label} had failed first: ${(err as Error).message}`)
    }
    throw err
  }
}

/** One connection that runs VACUUM INTO and nothing else; see createBackup on why it is not a read-only one. */
function vacuumInto(db: string, snap: string): void {
  const src = new DatabaseSync(db, { timeout: 8000 })
  try { src.prepare('VACUUM INTO ?').run(snap) } finally { src.close() }
}

/**
 * Back up a database: a consistent copy, sealed under the backup key, recorded in a manifest. Runs beside a live service.
 * The connection runs VACUUM INTO and nothing else. It is not opened read-only on purpose: a read-only connection to a
 * WAL database that no one else has open leaves a -shm and an empty -wal file behind when it closes (checked on
 * SQLite 3.54), and PRAGMA query_only refuses VACUUM INTO. An ordinary connection that closes last removes them itself,
 * and leaves a running service's files alone.
 */
export function createBackup(o: BackupOptions): BackupResult {
  const db = resolve(o.db)
  if (!existsSync(db)) throw new BackupError('source_missing', `No database at ${db}.`)
  return produce({ ...o, purpose: 'backup', tempParent: o.tempParent ?? dirname(db) }, (snap) => {
    // The copy is the database as of the start of VACUUM INTO's read transaction: later commits are not in it.
    const snapshotAtMs = (o.now ?? Date.now)()
    vacuumInto(db, snap)
    return { snapshotAtMs, schemaVersion: schemaOf(snap), source: basename(db) }
  })
}

export type MigrationCopyOptions = BackupOptions & { from: string; to: string }

/**
 * The copy taken before a schema migration, sealed under the migration-copy key. The copy must be at the schema version
 * the migration starts from and pass SQLite's quick check, or nothing is recorded (and the migration does not run).
 */
export function createMigrationCopy(o: MigrationCopyOptions): BackupResult {
  const db = resolve(o.db)
  if (!existsSync(db)) throw new BackupError('source_missing', `No database at ${db}.`)
  const outDir = resolve(o.outDir)
  const log = o.log ?? noop
  // A restart loop after a migration that fails past its copy (the copy is taken, the migration throws, the service is
  // restarted) would leave one copy per attempt: an unchanged database reuses the newest copy of it, checked again.
  // VACUUM INTO gives the same bytes for the same content, so equal SHA-256 means the same database (merge note).
  const reuse = (plain: { bytes: number; sha256: string }): BackupResult | null => {
    for (const path of listManifests(outDir).reverse()) {
      let m: Manifest
      try { m = readManifest(path).m } catch { continue }
      if (purposeOf(m) !== 'migration-copy' || m.migration?.from !== o.from || m.migration?.to !== o.to || m.plaintext.sha256 !== plain.sha256 || m.plaintext.bytes !== plain.bytes) continue
      try {
        const t0 = performance.now()
        verifySealed(path, o.keyring)
        log(`reused migration copy ${m.id}: the database is unchanged since it was taken, and the copy was checked again`)
        return { manifest: m, manifestPath: path, backupPath: join(outDir, m.file), timings: { snapshotMs: 0, sealMs: 0, verifyMs: ms(t0), totalMs: ms(t0) } }
      } catch (e) {
        if (!(e instanceof KeyError || e instanceof BackupError)) throw e
        log(`migration copy ${m.id} matches the database but did not verify (${e.code}); a new copy is made`)
      }
    }
    return null
  }
  return produce({ ...o, purpose: 'migration-copy', tempParent: o.tempParent ?? dirname(db), reuse }, (snap) => {
    const snapshotAtMs = (o.now ?? Date.now)()
    vacuumInto(db, snap)
    const schemaVersion = schemaOf(snap)
    if (schemaVersion !== o.from) throw new BackupError('snapshot_changed', `The copy of ${basename(db)} is at schema version ${schemaVersion ?? 'unknown'}, not ${o.from} as the migration expects; nothing was recorded.`)
    const quick = readOnly(snap, (d) => (d.prepare('PRAGMA quick_check').all() as { quick_check: string }[]).map((r) => r.quick_check).join('; '))
    if (quick !== 'ok') throw new BackupError('verification_failed', `The copy of ${basename(db)} failed SQLite's quick check (${quick.slice(0, 200)}); nothing was recorded.`)
    return { snapshotAtMs, schemaVersion, source: basename(db), migration: { from: o.from, to: o.to } }
  })
}

// ------------------------------------------------------------------------------------------------ reading a sealed set

export function readManifest(path: string): { m: Manifest; manifestPath: string; backupPath: string } {
  const manifestPath = resolve(path)
  if (!existsSync(manifestPath)) throw new BackupError('manifest_missing', `No manifest at ${manifestPath}.`)
  let m: Manifest
  try { m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest } catch { throw new BackupError('manifest_malformed', `The manifest ${manifestPath} is not valid JSON.`) }
  const purpose = typeof m === 'object' && m !== null ? (m.purpose ?? 'backup') : undefined
  const ok = typeof m === 'object' && m !== null && m.format === MANIFEST_FORMAT && (purpose === 'backup' || purpose === 'migration-copy')
    && typeof m.id === 'string' && ID_RE.test(m.id) && m.id.startsWith(`${KINDS[purpose].prefix}-`)
    // The file is named by the id, never by a path: a manifest cannot point a restore at any other file.
    && m.file === `${m.id}.qedbak` && Number.isSafeInteger(m.createdAtMs) && Number.isSafeInteger(m.snapshotAtMs)
    && (m.schemaVersion === null || typeof m.schemaVersion === 'string') && typeof m.source === 'string' && m.algorithm === 'AES-256-GCM'
    && typeof m.key?.kid === 'string' && Number.isSafeInteger(m.key?.version)
    && Number.isSafeInteger(m.plaintext?.bytes) && SHA_RE.test(m.plaintext?.sha256 ?? '') && Number.isSafeInteger(m.ciphertext?.bytes) && SHA_RE.test(m.ciphertext?.sha256 ?? '')
    && (purpose === 'migration-copy' ? typeof m.migration?.from === 'string' && typeof m.migration?.to === 'string' : m.migration === undefined)
  if (!ok) throw new BackupError('manifest_malformed', `The manifest ${manifestPath} is not a ${MANIFEST_FORMAT} manifest this build can read.`)
  return { m, manifestPath, backupPath: join(dirname(manifestPath), m.file) }
}

/** The file against its manifest, then the manifest against the file's authenticated header. Nothing is decrypted yet. */
export function checkSealed(m: Manifest, backupPath: string): Header {
  if (!existsSync(backupPath)) throw new BackupError('backup_missing', `The sealed file ${backupPath} named by manifest ${m.id} is missing.`)
  const size = statSync(backupPath).size
  if (size < m.ciphertext.bytes) throw new BackupError('backup_truncated', `The sealed file ${backupPath} is truncated: ${size} bytes where the manifest records ${m.ciphertext.bytes}.`)
  if (size !== m.ciphertext.bytes || sha256File(backupPath).sha256 !== m.ciphertext.sha256) throw new BackupError('backup_altered', `The sealed file ${backupPath} does not match its manifest (size or SHA-256): it was altered.`)
  const h = headerOfFile(backupPath)
  const meta = h.meta as Partial<Manifest> & { purpose?: string }
  const same = meta.purpose === KINDS[purposeOf(m)].meta && meta.format === m.format && meta.id === m.id && meta.createdAtMs === m.createdAtMs && meta.snapshotAtMs === m.snapshotAtMs
    && meta.schemaVersion === m.schemaVersion && meta.source === m.source && meta.plaintext?.bytes === m.plaintext.bytes && meta.plaintext?.sha256 === m.plaintext.sha256
    && (meta.reencryptedFrom ?? null) === (m.reencryptedFrom ?? null) && (meta.migration?.from ?? null) === (m.migration?.from ?? null) && (meta.migration?.to ?? null) === (m.migration?.to ?? null)
    && h.kid === m.key.kid && h.version === m.key.version
  if (!same) throw new BackupError('manifest_mismatch', `The manifest ${m.id} does not agree with the sealed file's authenticated header: the manifest was edited, or belongs to another copy.`)
  return h
}

/**
 * Check a sealed set end to end without writing any plaintext: the manifest, the file against it and its header, then a
 * full decryption in memory under the keyring of its purpose, which must give the recorded plaintext SHA-256.
 */
export function verifySealed(manifest: string, keyring: Keyring): { manifest: Manifest; ms: number } {
  const t0 = performance.now()
  const { m, backupPath } = readManifest(manifest)
  checkSealed(m, backupPath)
  keyring.requirePurpose(purposeOf(m))
  const r = keyring.verifyFile(backupPath, contextOf(m))
  if (r.plaintextSha256 !== m.plaintext.sha256 || r.plaintextBytes !== m.plaintext.bytes) throw new BackupError('backup_altered', `The sealed file of ${m.id} does not decrypt to the plaintext its manifest records.`)
  return { manifest: m, ms: ms(t0) }
}

/** The manifests in a folder, oldest first (by creation time, then id). */
export function listManifests(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found = readdirSync(dir).filter((f) => /^(bk|mc)-.*\.manifest\.json$/.test(f)).map((f) => {
    const path = join(dir, f)
    let at = Number.MAX_SAFE_INTEGER
    try { at = Number((JSON.parse(readFileSync(path, 'utf8')) as { createdAtMs?: number }).createdAtMs ?? at) } catch { /* reported when it is read */ }
    return { path, at }
  })
  return found.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path)).map((x) => x.path)
}

/**
 * Compromise response, step two (after rotating): the same snapshot sealed again under the active data key, as a new
 * sealed set of the same kind, streaming from the old sealed file (its plaintext passes through memory only). Once every
 * copy is re-encrypted the old version can be revoked.
 */
export function reencryptSealed(o: { manifest: string; keyring: Keyring; outDir: string; copyKeyring?: boolean; now?: () => number; log?: (l: string) => void; afterSeal?: (path: string) => void }): BackupResult {
  const t0 = performance.now()
  const { m, backupPath: src } = readManifest(o.manifest)
  checkSealed(m, src)
  const purpose = purposeOf(m)
  const kind = KINDS[purpose]
  o.keyring.requirePurpose(purpose)
  const outDir = privateFolder(o.outDir, `The ${kind.label} folder`)
  o.keyring.notePlace(outDir)
  sweepPartials(outDir, o.log ?? noop)
  const at = (o.now ?? Date.now)()
  const id = newId(purpose, at)
  const context = `${kind.context}:${id}`
  const sealing = makeScratch(outDir, SEALING_PREFIX, `re-encrypted ${kind.label}`)
  const partial = join(sealing, `${id}.qedbak.partial`)
  const backupPath = join(outDir, `${id}.qedbak`)
  try {
    const meta = { purpose: kind.meta, format: MANIFEST_FORMAT, id, createdAtMs: at, snapshotAtMs: m.snapshotAtMs, schemaVersion: m.schemaVersion, source: m.source, plaintext: m.plaintext, reencryptedFrom: m.id, ...(m.migration ? { migration: m.migration } : {}) }
    const sealed = o.keyring.resealFile(src, contextOf(m), partial, context, meta)
    if (sealed.plaintextSha256 !== m.plaintext.sha256 || sealed.plaintextBytes !== m.plaintext.bytes) throw new BackupError('backup_altered', `The sealed file of ${m.id} does not decrypt to the plaintext its manifest records; nothing was re-encrypted.`)
    const sealMs = ms(t0)
    const t1 = performance.now()
    o.afterSeal?.(partial)
    verifyWritten(o.keyring, partial, context, m.plaintext, sealed.ciphertextSha256, kind.label)
    const verifyMs = ms(t1)
    renameSync(partial, backupPath)
    rmSync(sealing, { recursive: true, force: true })
    const next: Manifest = {
      format: MANIFEST_FORMAT, purpose, id, file: basename(backupPath), createdAt: new Date(at).toISOString(), createdAtMs: at, snapshotAtMs: m.snapshotAtMs,
      schemaVersion: m.schemaVersion, source: m.source, algorithm: 'AES-256-GCM', key: { kid: sealed.header.kid, version: sealed.header.version },
      plaintext: m.plaintext, ciphertext: { bytes: sealed.ciphertextBytes, sha256: sealed.ciphertextSha256 }, ...(m.migration ? { migration: m.migration } : {}), reencryptedFrom: m.id,
    }
    return record(o, outDir, next, `re-encrypted ${kind.label}`, { snapshotMs: 0, sealMs, verifyMs, totalMs: ms(t0) })
  } catch (err) {
    rmSync(sealing, { recursive: true, force: true })
    if (!existsSync(join(outDir, `${id}.manifest.json`))) rmSync(backupPath, { force: true })
    throw err
  }
}
