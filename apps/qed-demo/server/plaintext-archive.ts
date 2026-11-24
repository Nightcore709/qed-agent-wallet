/**
 * The plaintext copies made before 24 Nov 2026 (R11 section 11; docs/ENCRYPTION.md section 7): the copies the migrations
 * left beside the database (qed.db.pre-vN-….bak), the ones `npm run reset` moved aside (qed.db.<time>.bak) and scratch
 * folders. This seals them into an encrypted archive under the backup key, checks every entry byte for byte against its
 * original, and leaves every original where it is: they are recovery material, and deleting them is the owner's decision.
 *
 * Removal is a separate step (removeOriginals) that needs the archive's id typed back as confirmation (and, on the
 * command line, an explicit --remove-plaintext). It checks the whole archive again and every original against it byte
 * for byte; if any original differs, nothing is removed. It records what it removed. Removing a file unlinks it; on an
 * SSD with APFS its blocks are not overwritten and may survive in local snapshots: FileVault is what protects them.
 *
 * Archive layout (format qed-archive/1), a private folder (mode 700) per archive:
 *   archive.json     the record: id, key id and version, and per entry its original path, name, size, SHA-256, mode, time
 *   NNNN.qedseal     each original sealed on its own, streaming (no plaintext copy is made), in one AES-256-GCM message
 *                    bound to the archive's id and the entry's index; its header repeats the entry's name, size and hash
 *   keyring.json     a copy of the backup keyring (wrapped keys only), so a restore elsewhere needs only the KEK
 *   removal-….json   written by removeOriginals
 */
import { randomBytes } from 'node:crypto'
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileId, foldName, headerOfFile, inside, KeyError, type Keyring, realish, replacePrivateFile, samePath } from './keys.ts'
import { makeScratch, OWNER_FILE } from './scratch.ts'
import { privateFolder, sha256File, sweepOrRefuse } from './sealed.ts'

export type ArchiveErrorCode =
  | 'nothing_to_archive' | 'input_missing' | 'live_database' | 'in_use' | 'archive_location' | 'archive_malformed' | 'entry_unknown'
  | 'target_exists' | 'confirmation_required' | 'original_changed' | 'not_removable' | 'verification_failed'

/** A refusal about an archive. Messages name files, ids and checks; never key material or file contents. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  constructor(code: ArchiveErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

export const ARCHIVE_FORMAT = 'qed-archive/1'
export interface ArchiveEntry {
  index: number
  /** The original's absolute path when it was archived. */
  path: string
  /** Its name: a file's own name, or for a file inside an archived folder, the folder's name and the path within it. */
  name: string
  bytes: number
  sha256: string
  mode: string
  mtimeMs: number
  /** It begins with the SQLite header: a database. */
  sqlite: boolean
  /** Checked byte for byte against the original when it was archived. */
  identical: true
  sealed: { file: string; bytes: number; sha256: string }
}
export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT
  purpose: 'plaintext-archive'
  id: string
  createdAt: string
  createdAtMs: number
  key: { kid: string; version: number }
  /** What was given to archive: files, and folders whose emptied subfolders removal may remove. */
  roots: { path: string; kind: 'file' | 'folder' }[]
  entries: ArchiveEntry[]
  skipped: { path: string; why: string }[]
  /** Databases with a -wal or -shm beside them that the operator stated no process had open (archived with those files). */
  assumedClosed: string[]
  reencryptedFrom?: string
}
export interface ArchiveResult { manifest: ArchiveManifest; manifestPath: string; dir: string }

const ID_RE = /^ar-\d{8}T\d{6}Z-[0-9a-f]{6}$/
const SQLITE = Buffer.from('SQLite format 3\0', 'latin1')
const CHUNK = 1 << 20
const newId = (at: number): string => `ar-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(3).toString('hex')}`
const contextFor = (id: string, index: number): string => `qed/archive/v1:${id}:${index}`
const sealedName = (index: number): string => `${String(index).padStart(4, '0')}.qedseal`
const noop = (): void => {}

function head(path: string, n: number): Buffer {
  const fd = openSync(path, 'r')
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got) } finally { closeSync(fd) }
}
const isSqlite = (path: string): boolean => head(path, 16).equals(SQLITE)
const isWal = (path: string): boolean => { const b = head(path, 4); return b.length === 4 && (b.readUInt32BE(0) === 0x377f0682 || b.readUInt32BE(0) === 0x377f0683) }
/**
 * A database with a -wal, -shm or -journal beside it may be open in another process (or was left by one that crashed).
 * Whatever its name: QED never opens its .bak copies, but anyone may (the review of cb85271 asked why they were exempt).
 */
const looksOpen = (db: string): boolean => existsSync(`${db}-wal`) || existsSync(`${db}-shm`) || existsSync(`${db}-journal`)
const JOURNAL = /-(wal|shm|journal)$/i

/**
 * The live databases, by identity (device and inode): each one, and its journal files that exist. Paths are not compared
 * as text: on macOS's case-insensitive APFS the live database can be named in any letter case, or through a link
 * (independent review of cb85271, finding 2).
 */
interface Live { dbs: Set<string>; files: Set<string> }
function liveSet(paths: string[]): Live {
  const dbs = new Set<string>(), files = new Set<string>()
  for (const l of paths) {
    const id = fileId(l)
    if (id !== null) { dbs.add(id); files.add(id) }
    for (const j of ['-wal', '-shm', '-journal']) { const jid = fileId(`${l}${j}`); if (jid !== null) files.add(jid) }
  }
  return { dbs, files }
}
/** Whether p is a live database or one of its journal files. */
function isLive(live: Live, p: string): boolean {
  const id = fileId(p)
  if (id !== null && live.files.has(id)) return true
  if (!JOURNAL.test(p)) return false
  const base = fileId(p.replace(JOURNAL, ''))
  return base !== null && live.dbs.has(base)
}
/** Whether the database p (or the database of the journal p) may be open: a -wal or -shm beside it, unless named closed. */
function mayBeOpen(p: string, closed: Set<string | null>): string | null {
  const db = p.replace(JOURNAL, '')
  return existsSync(db) && isSqlite(db) && looksOpen(db) && !closed.has(fileId(db)) ? db : null
}

// ------------------------------------------------------------------------------------------------ scanning

export type FindingKind = 'plaintext-copy' | 'live' | 'in-use' | 'temporary'
export interface ScanFinding {
  path: string
  kind: FindingKind
  /** A SQLite database or write-ahead log by its first bytes. */
  sqlite: boolean
  bytes: number
  /** Named as the migrations and `npm run reset` named their plaintext copies of the live database (<name>.….bak). */
  recorded: boolean
}

/**
 * The plaintext database files under dir, by their first bytes (no row is read): copies, the live database and its
 * journal, databases another process may have open (a -wal or -shm beside them), and what a crashed operation left in a
 * private temporary folder. Symbolic links are not followed. Encrypted files (beginning "QEDC") are not reported.
 */
export function scanPlaintext(dir: string, o: { live: string[] }): ScanFinding[] {
  const live = liveSet(o.live)
  const liveNames = o.live.map((l) => realish(l))
  // Named <live name>.….bak beside the live database, in any letter case.
  const recordedName = (p: string): boolean => /\.bak(-wal|-shm)?$/i.test(p) && liveNames.some((l) => samePath(dirname(l), dirname(p)) && foldName(basename(p)).startsWith(`${foldName(basename(l))}.`))
  const out: ScanFinding[] = []
  const walk = (d: string, temp: boolean): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isDirectory()) { walk(p, temp || /^(\.qed-(backup|restore|extract)-|qed-drill-)/.test(name)); continue }
      if (!st.isFile()) continue
      const sqlite = st.size > 0 && (isSqlite(p) || isWal(p))
      const base = p.replace(JOURNAL, '')
      let kind: FindingKind | undefined
      if (isLive(live, p)) kind = 'live'
      else if (temp || name.endsWith('.restoring')) kind = 'temporary'
      else if (JOURNAL.test(p) && existsSync(base) && isSqlite(base)) kind = looksOpen(base) ? 'in-use' : 'plaintext-copy'
      else if (sqlite) kind = isSqlite(p) && looksOpen(p) ? 'in-use' : 'plaintext-copy'
      if (kind) out.push({ path: p, kind, sqlite, bytes: st.size, recorded: kind === 'plaintext-copy' && recordedName(p) })
    }
  }
  walk(resolve(dir), false)
  return out
}

// ------------------------------------------------------------------------------------------------ archiving

/** Compare a sealed entry's plaintext, decrypted in memory, with a file on disk, byte for byte. Writes nothing. */
function sameAs(keyring: Keyring, sealed: string, context: string, original: string): { identical: boolean; bytes: number; sha256: string } {
  const fd = openSync(original, 'r')
  const buf = Buffer.alloc(CHUNK)
  let pos = 0, same = true
  try {
    const r = keyring.verifyFile(sealed, context, (plain) => {
      for (let off = 0; same && off < plain.length;) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, plain.length - off), pos)
        if (n === 0 || !buf.subarray(0, n).equals(plain.subarray(off, off + n))) { same = false; break }
        off += n; pos += n
      }
    })
    // The original must also end where the plaintext ends.
    return { identical: same && readSync(fd, buf, 0, 1, pos) === 0, bytes: r.plaintextBytes, sha256: r.plaintextSha256 }
  } finally { buf.fill(0); closeSync(fd) }
}

interface Candidate { path: string; name: string; root: string }

/** The files to archive, in order: each given file, then each given folder's regular files (sorted, links not followed). */
function collect(inputs: string[], skipped: ArchiveManifest['skipped']): { candidates: Candidate[]; roots: ArchiveManifest['roots'] } {
  const candidates: Candidate[] = []
  const roots: ArchiveManifest['roots'] = []
  const seen = new Set<string>()
  // One file, however it is named (another letter case, a hard link), is one entry (finding 6).
  const add = (path: string, name: string, root: string) => { const id = fileId(path) ?? realish(path); if (!seen.has(id)) { seen.add(id); candidates.push({ path, name, root }) } }
  const walk = (root: string, d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) skipped.push({ path: p, why: 'a symbolic link (not followed)' })
      else if (st.isDirectory()) walk(root, p)
      else if (st.isFile()) add(p, `${basename(root)}/${relative(root, p).split(sep).join('/')}`, root)
      else skipped.push({ path: p, why: 'not a regular file' })
    }
  }
  for (const input of inputs.map((i) => resolve(i))) {
    if (!existsSync(input)) throw new ArchiveError('input_missing', `${input} does not exist. Nothing was written.`)
    const st = lstatSync(input)
    if (st.isSymbolicLink()) { skipped.push({ path: input, why: 'a symbolic link (not followed)' }); continue }
    if (st.isDirectory()) { roots.push({ path: input, kind: 'folder' }); walk(input, input) }
    else if (st.isFile()) { roots.push({ path: input, kind: 'file' }); add(input, basename(input), input) }
    else skipped.push({ path: input, why: 'not a regular file' })
  }
  return { candidates, roots }
}

/**
 * Seal plaintext files and folders into a new archive under the backup key. Every original is opened read-only and left
 * as it is. Refused before anything is written: the live database (or a folder holding it), a database with a -wal or
 * -shm beside it (it may be open: archive a VACUUM INTO copy instead) unless the operator names it in assumeClosed (a
 * leftover nobody has open; it is archived with its -wal and -shm, byte for byte), and an archive folder inside what is
 * archived.
 */
export function archivePlaintext(o: { inputs: string[]; outDir: string; keyring: Keyring; live: string[]; assumeClosed?: string[]; now?: () => number; log?: (l: string) => void }): ArchiveResult {
  o.keyring.requirePurpose('backup')
  const log = o.log ?? noop
  const skipped: ArchiveManifest['skipped'] = []
  const { candidates, roots } = collect(o.inputs, skipped)
  if (!candidates.length) throw new ArchiveError('nothing_to_archive', 'There is no regular file to archive in what was given.')
  const live = liveSet(o.live)
  const assumedClosed = (o.assumeClosed ?? []).map((p) => resolve(p))
  const closed = new Set(assumedClosed.map(fileId))
  for (const c of candidates) {
    if (isLive(live, c.path)) throw new ArchiveError('live_database', `${c.path} is the live database (or its journal); it is backed up with \`npm run backup\`, never archived. Nothing was written.`)
    const db = mayBeOpen(c.path, closed)
    if (db) throw new ArchiveError('in_use', `${db} has a -wal, -shm or -journal file beside it, so a process may have it open. Archive a consistent copy instead (sqlite3 '${db}' "VACUUM INTO '<copy>'"), or, if you know no process has it open (a leftover), name it with --assume-closed '${db}'. Nothing was written.`)
  }
  const outDir = resolve(o.outDir)
  for (const r of roots) if (inside(outDir, r.path) || inside(r.path, outDir)) throw new ArchiveError('archive_location', `The archive folder ${outDir} and ${r.path} may not contain one another: removing the originals would remove the archive. Nothing was written.`)
  const at = (o.now ?? Date.now)()
  const id = newId(at)
  const parent = privateFolder(outDir, 'The archive folder')
  o.keyring.notePlace(outDir) // so that revoking a key and re-encrypting find the archives here (finding 3)
  // Built in a private folder that records its owner and moved into place whole: an interrupted run leaves no half-made
  // archive under an archive's name, and the next archive sweeps what it left (ciphertext only).
  sweepOrRefuse(parent, ARCHIVING_PREFIX, log)
  const work = makeScratch(parent, ARCHIVING_PREFIX, 'archive')
  const dir = join(parent, id)
  try {
    const entries: ArchiveEntry[] = candidates.map((c, i) => {
      const index = i + 1
      const st = statSync(c.path)
      const file = sealedName(index)
      const partial = join(work, `${file}.partial`)
      const context = contextFor(id, index)
      const plain = sha256File(c.path)
      const sealed = o.keyring.encryptFile(c.path, partial, context, { purpose: 'qed-archive', archive: id, index, name: c.name, bytes: plain.bytes, sha256: plain.sha256 })
      if (sealed.plaintextSha256 !== plain.sha256 || sealed.plaintextBytes !== plain.bytes) throw new ArchiveError('verification_failed', `${c.path} changed while it was being archived; nothing was recorded.`)
      // Byte for byte against the original, decrypting in memory: the archive counts only if every entry gives it back.
      const back = sameAs(o.keyring, partial, context, c.path)
      if (!back.identical || back.sha256 !== plain.sha256) throw new ArchiveError('verification_failed', `The sealed copy of ${c.path} does not decrypt to the original byte for byte; nothing was recorded.`)
      renameSync(partial, join(work, file))
      log(`entry ${index} ${c.name}: ${plain.bytes} bytes sealed and checked byte for byte against the original`)
      return { index, path: c.path, name: c.name, bytes: plain.bytes, sha256: plain.sha256, mode: (st.mode & 0o777).toString(8), mtimeMs: st.mtimeMs, sqlite: plain.bytes > 0 && isSqlite(c.path), identical: true, sealed: { file, bytes: sealed.ciphertextBytes, sha256: sealed.ciphertextSha256 } }
    })
    const active = o.keyring.list().find((k) => k.version === o.keyring.activeVersion)!
    const manifest: ArchiveManifest = { format: ARCHIVE_FORMAT, purpose: 'plaintext-archive', id, createdAt: new Date(at).toISOString(), createdAtMs: at, key: { kid: active.kid, version: active.version }, roots, entries, skipped, assumedClosed }
    finish(o.keyring, work, dir, manifest)
    log(`archive ${id}: ${entries.length} entries sealed under data key ${active.kid} (version ${active.version}) and checked; the originals are left where they are`)
    return { manifest, manifestPath: join(dir, 'archive.json'), dir }
  } catch (e) {
    rmSync(work, { recursive: true, force: true }) // sealed partials only: never plaintext
    throw e
  }
}

/** The private folders an archive is built in, beside the archives. */
const ARCHIVING_PREFIX = '.qed-archiving-'
/** The record sealed beside archive.json, so that an edited record is detected (review of cb85271, suspicion 1). */
const RECORD_FILE = 'record.qedseal'
const recordContext = (id: string): string => `qed/archive/v1:${id}:record`

/**
 * Complete an archive built in `work`: its record (archive.json), the same record sealed (record.qedseal: the path of each
 * original, the folders whose emptied subfolders removal may remove, and the databases named closed are all in it and
 * steer removal, so they are authenticated), then the folder is moved into place as `dir`, and a copy of the keyring
 * (wrapped keys only) is put in it.
 */
function finish(keyring: Keyring, work: string, dir: string, manifest: ArchiveManifest): void {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8')
  replacePrivateFile(join(work, 'archive.json'), bytes)
  replacePrivateFile(join(work, RECORD_FILE), keyring.encrypt(bytes, recordContext(manifest.id), { purpose: 'qed-archive-record', archive: manifest.id }))
  rmSync(join(work, OWNER_FILE), { force: true })
  renameSync(work, dir)
  keyring.copyTo(join(dir, 'keyring.json'))
}

/** Whether archive.json is the record sealed beside it: 'ok', 'missing', 'altered', or the key's refusal (key_revoked …). */
function authenticRecord(m: ArchiveManifest, manifestPath: string, dir: string, keyring: Keyring): string {
  const p = join(dir, RECORD_FILE)
  if (!existsSync(p)) return 'missing'
  try {
    const sealed = keyring.decrypt(readFileSync(p), recordContext(m.id))
    return sealed.equals(readFileSync(manifestPath)) ? 'ok' : 'altered'
  } catch (e) {
    if (!(e instanceof KeyError)) throw e
    return ['authentication_failed', 'ciphertext_malformed', 'ciphertext_truncated'].includes(e.code) ? 'altered' : e.code
  }
}

// ------------------------------------------------------------------------------------------------ reading an archive

export function readArchive(path: string): { m: ArchiveManifest; manifestPath: string; dir: string } {
  const p = resolve(path)
  const manifestPath = existsSync(p) && statSync(p).isDirectory() ? join(p, 'archive.json') : p
  let m: ArchiveManifest
  try { m = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest } catch { throw new ArchiveError('archive_malformed', `There is no readable archive record at ${manifestPath}.`) }
  const ok = typeof m === 'object' && m !== null && m.format === ARCHIVE_FORMAT && m.purpose === 'plaintext-archive' && typeof m.id === 'string' && ID_RE.test(m.id)
    && typeof m.key?.kid === 'string' && Number.isSafeInteger(m.key?.version) && Array.isArray(m.entries) && Array.isArray(m.roots)
    && m.entries.every((e, i) => e.index === i + 1 && typeof e.path === 'string' && typeof e.name === 'string' && Number.isSafeInteger(e.bytes) && /^[0-9a-f]{64}$/.test(e.sha256)
      // Each sealed file is named by its index alone: a record cannot point anywhere else.
      && /^\d{4,}\.qedseal$/.test(e.sealed?.file ?? '') && Number.isSafeInteger(e.sealed?.bytes) && /^[0-9a-f]{64}$/.test(e.sealed?.sha256 ?? ''))
  if (!ok) throw new ArchiveError('archive_malformed', `${manifestPath} is not a ${ARCHIVE_FORMAT} record this build can read.`)
  return { m, manifestPath, dir: dirname(manifestPath) }
}

export type SealedState = 'ok' | 'altered' | 'mismatch' | string
/** An entry's sealed file against its record (size, SHA-256), then its authenticated header against the record. */
function checkEntry(m: ArchiveManifest, dir: string, e: ArchiveEntry): 'ok' | 'altered' | 'mismatch' {
  const p = join(dir, e.sealed.file)
  if (!existsSync(p) || statSync(p).size !== e.sealed.bytes || sha256File(p).sha256 !== e.sealed.sha256) return 'altered'
  let meta: Record<string, unknown>
  try { meta = headerOfFile(p).meta } catch { return 'altered' }
  const same = meta.purpose === 'qed-archive' && meta.archive === m.id && meta.index === e.index && meta.name === e.name && meta.bytes === e.bytes && meta.sha256 === e.sha256
  return same ? 'ok' : 'mismatch'
}

export interface ArchiveCheck {
  ok: boolean
  id: string
  /** archive.json against the record sealed beside it: 'ok', 'missing', 'altered', or the key's refusal. */
  record: string
  entries: { index: number; name: string; path: string; bytes: number; sealed: SealedState; original: 'identical' | 'differs' | 'absent' }[]
}

/**
 * Check an archive end to end, writing nothing: every sealed file against its record, then decrypted in memory under the
 * backup key; where the original is still at its path, byte for byte against it (that does not affect `ok`: the archive
 * is sound whether or not the originals are still there).
 */
export function verifyArchive(o: { manifest: string; keyring: Keyring }): ArchiveCheck {
  const { m, dir, manifestPath } = readArchive(o.manifest)
  o.keyring.requirePurpose('backup')
  const record = authenticRecord(m, manifestPath, dir, o.keyring)
  const entries = m.entries.map((e) => {
    let sealed: SealedState = checkEntry(m, dir, e)
    let original: 'identical' | 'differs' | 'absent' = existsSync(e.path) ? 'differs' : 'absent'
    if (sealed === 'ok') {
      const file = join(dir, e.sealed.file), context = contextFor(m.id, e.index)
      try {
        if (original !== 'absent' && lstatSync(e.path).isFile()) {
          const r = sameAs(o.keyring, file, context, e.path)
          sealed = r.sha256 === e.sha256 ? 'ok' : 'mismatch'
          original = r.identical ? 'identical' : 'differs'
        } else sealed = o.keyring.verifyFile(file, context).plaintextSha256 === e.sha256 ? 'ok' : 'mismatch'
      } catch (err) {
        if (!(err instanceof KeyError)) throw err
        sealed = err.code
      }
    }
    return { index: e.index, name: e.name, path: e.path, bytes: e.bytes, sealed, original }
  })
  return { ok: record === 'ok' && entries.every((e) => e.sealed === 'ok'), id: m.id, record, entries }
}

/** Decrypt one entry into a new private file (mode 600) and check it against its record. No existing file is written over. */
export function extractEntry(o: { manifest: string; keyring: Keyring; index: number; target: string; log?: (l: string) => void }): { target: string; bytes: number; sha256: string } {
  const { m, dir } = readArchive(o.manifest)
  const e = m.entries.find((x) => x.index === o.index)
  if (!e) throw new ArchiveError('entry_unknown', `Archive ${m.id} has no entry ${o.index} (it has 1 to ${m.entries.length}).`)
  const state = checkEntry(m, dir, e)
  if (state !== 'ok') throw new ArchiveError('verification_failed', `Entry ${e.index} of archive ${m.id} does not match its record (${state}); nothing was extracted.`)
  o.keyring.requirePurpose('backup')
  // The record must be authentic; a wrong or revoked key is reported as itself (its KeyError), not as a damaged record.
  const record = authenticRecord(m, join(dir, 'archive.json'), dir, o.keyring)
  if (record !== 'ok') {
    if (record !== 'altered' && record !== 'missing') o.keyring.decrypt(readFileSync(join(dir, RECORD_FILE)), recordContext(m.id)) // throws the key's own refusal
    throw new ArchiveError('verification_failed', `The record of archive ${m.id} does not authenticate (${record}); nothing was extracted.`)
  }
  const target = resolve(o.target)
  if (existsSync(target)) throw new ArchiveError('target_exists', `${target} already exists; an extraction never writes over a file.`)
  const into = privateFolder(dirname(target), 'The folder an entry is extracted into')
  // Decrypted into a private folder that records its owner, then moved into place; one an interrupted extraction left is swept first.
  sweepOrRefuse(into, EXTRACT_PREFIX, o.log ?? noop)
  const work = makeScratch(into, EXTRACT_PREFIX, 'extraction')
  try {
    const partial = join(work, 'extracting')
    const r = o.keyring.decryptFile(join(dir, e.sealed.file), partial, contextFor(m.id, e.index))
    if (r.plaintextSha256 !== e.sha256 || r.plaintextBytes !== e.bytes) throw new ArchiveError('verification_failed', `Entry ${e.index} of archive ${m.id} did not decrypt to its recorded contents; nothing was kept.`)
    if (existsSync(target)) throw new ArchiveError('target_exists', `${target} appeared during the extraction; it was not written over.`)
    renameSync(partial, target)
    return { target, bytes: r.plaintextBytes, sha256: r.plaintextSha256 }
  } finally { rmSync(work, { recursive: true, force: true }) }
}
/** The private folders an extraction decrypts into, beside its target. */
const EXTRACT_PREFIX = '.qed-extract-'

export interface RemovalRecord {
  archive: string
  removedAt: string
  removed: { index: number; path: string; sha256: string; otherNames: number }[]
  alreadyGone: { index: number; path: string }[]
  foldersRemoved: string[]
  /** Set when the removal stopped part-way: why, and which original it stopped at. What was removed before is listed. */
  stopped: { index: number; path: string; code: string } | null
  recordPath: string
}

/** What a file is, to see that it has not changed between being checked and being removed: identity, size and time. */
const stamp = (p: string): string | null => { try { const s = lstatSync(p); return s.isFile() ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}` : `not a regular file` } catch { return null } }

/**
 * Remove the originals of an archive, only with its id typed back as `confirm`. First the whole archive is checked, and
 * every original still present is compared byte for byte with its sealed entry; if any differs (or is not a regular
 * file), is the live database (by identity, however it is named: `live` is the configured database), may be open, or
 * sits in a folder that cannot be written, nothing is removed. Then each original is checked once more immediately
 * before it is unlinked: still the file that was compared (identity, size, time), still not the live database, still not
 * open. If one fails, the removal stops there. Folders that were archived and are now empty are removed, and a record
 * of what was removed (and where it stopped) is written into the archive.
 */
export function removeOriginals(o: { manifest: string; keyring: Keyring; confirm: string; live: string[]; now?: () => number; beforeUnlink?: (path: string) => void }): RemovalRecord {
  const { m, dir } = readArchive(o.manifest)
  if (o.confirm !== m.id) throw new ArchiveError('confirmation_required', `Removing the originals of archive ${m.id} needs its id typed back as confirmation (--confirm ${m.id}). Nothing was removed.`)
  const before = new Map(m.entries.map((e) => [e.index, stamp(e.path)]))
  const check = verifyArchive({ manifest: o.manifest, keyring: o.keyring })
  if (!check.ok) throw new ArchiveError('verification_failed', `Archive ${m.id} does not verify (${[...(check.record === 'ok' ? [] : [`its record: ${check.record}`]), ...check.entries.filter((e) => e.sealed !== 'ok').map((e) => `entry ${e.index}: ${e.sealed}`)].join(', ')}); nothing was removed.`)
  const present = check.entries.filter((e) => e.original !== 'absent')
  const differ = present.filter((e) => e.original !== 'identical' || !lstatSync(e.path).isFile() || stamp(e.path) !== before.get(e.index))
  if (differ.length) throw new ArchiveError('original_changed', `${differ.map((e) => e.path).join(', ')} no longer match${differ.length === 1 ? 'es' : ''} the archive (or changed while being compared); nothing was removed. Archive again, then remove with the new archive's id.`)
  const live = liveSet(o.live)
  // A database that looks open now (a -wal or -shm appeared) and was not named as closed when archived is never removed.
  const closed = new Set((m.assumedClosed ?? []).map(fileId))
  const refusal = (e: { path: string }): ArchiveError | null => {
    if (isLive(live, e.path)) return new ArchiveError('live_database', `${e.path} is the live database (or its journal) as configured now; it is never removed.`)
    const db = mayBeOpen(e.path, closed)
    if (db) return new ArchiveError('in_use', `${db} has a -wal, -shm or -journal beside it, so a process may have it open; it is not removed.`)
    return null
  }
  for (const e of present) { const r = refusal(e); if (r) { r.message += ' Nothing was removed.'; throw r } }
  for (const e of present) {
    try { accessSync(dirname(e.path), constants.W_OK) } catch { throw new ArchiveError('not_removable', `${e.path} cannot be removed: its folder ${dirname(e.path)} is not writable by this user. Nothing was removed.`) }
  }
  const removed: RemovalRecord['removed'] = []
  const alreadyGone: RemovalRecord['alreadyGone'] = check.entries.filter((e) => e.original === 'absent').map((e) => ({ index: e.index, path: e.path }))
  const foldersRemoved: string[] = []
  let stopped: RemovalRecord['stopped'] = null
  let failure: unknown
  try {
    for (const e of present) {
      o.beforeUnlink?.(e.path)
      const now = stamp(e.path)
      if (now === null) { alreadyGone.push({ index: e.index, path: e.path }); continue }
      const r = now !== before.get(e.index) ? new ArchiveError('original_changed', `${e.path} changed after it was compared with the archive; it was not removed.`) : refusal(e)
      if (r) { stopped = { index: e.index, path: e.path, code: r.code }; throw r }
      const links = lstatSync(e.path).nlink
      try { unlinkSync(e.path) } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { alreadyGone.push({ index: e.index, path: e.path }); continue }
        stopped = { index: e.index, path: e.path, code: (err as NodeJS.ErrnoException).code ?? 'error' }
        throw err
      }
      removed.push({ index: e.index, path: e.path, sha256: m.entries[e.index - 1]!.sha256, otherNames: links - 1 })
    }
    const prune = (d: string): void => {
      for (const n of readdirSync(d)) { const p = join(d, n); if (lstatSync(p).isDirectory()) prune(p) }
      if (readdirSync(d).length === 0) { rmdirSync(d); foldersRemoved.push(d) }
    }
    for (const r of m.roots) if (r.kind === 'folder' && existsSync(r.path) && lstatSync(r.path).isDirectory()) prune(r.path)
  } catch (err) { failure = err }
  if (failure && removed.length === 0) throw failure
  const at = (o.now ?? Date.now)()
  const recordPath = join(dir, `removal-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`)
  const record = { archive: m.id, removedAt: new Date(at).toISOString(), removed, alreadyGone, foldersRemoved, stopped }
  replacePrivateFile(recordPath, Buffer.from(`${JSON.stringify(record, null, 1)}\n`, 'utf8'))
  if (failure) {
    if (failure instanceof ArchiveError) failure.message += ` ${removed.length} original(s) were removed before it; the record is ${recordPath}.`
    throw failure
  }
  return { ...record, recordPath }
}

/**
 * After the backup key is rotated: the archive sealed again under the active version as a new archive, entry by entry,
 * stream to stream (no plaintext reaches the disk); each new entry is checked against its record. The old archive is
 * left; once every archive and backup is re-encrypted the old version can be revoked.
 */
export function reencryptArchive(o: { manifest: string; keyring: Keyring; outDir: string; now?: () => number; log?: (l: string) => void }): ArchiveResult {
  const { m, dir: from, manifestPath: fromRecord } = readArchive(o.manifest)
  o.keyring.requirePurpose('backup')
  // The record is carried into the new archive and sealed again there, so it must be authentic now: an edited record is
  // never laundered into a freshly sealed one.
  const record = authenticRecord(m, fromRecord, from, o.keyring)
  if (record !== 'ok') throw new ArchiveError('verification_failed', `The record of archive ${m.id} does not authenticate (${record}); nothing was re-encrypted.`)
  for (const e of m.entries) { const s = checkEntry(m, from, e); if (s !== 'ok') throw new ArchiveError('verification_failed', `Entry ${e.index} of archive ${m.id} does not match its record (${s}); nothing was re-encrypted.`) }
  const at = (o.now ?? Date.now)()
  const id = newId(at)
  const parent = privateFolder(o.outDir, 'The archive folder')
  o.keyring.notePlace(o.outDir)
  sweepOrRefuse(parent, ARCHIVING_PREFIX, o.log ?? noop)
  const work = makeScratch(parent, ARCHIVING_PREFIX, 're-encrypted archive')
  const dir = join(parent, id)
  try {
    const entries = m.entries.map((e) => {
      const partial = join(work, `${e.sealed.file}.partial`)
      const context = contextFor(id, e.index)
      const sealed = o.keyring.resealFile(join(from, e.sealed.file), contextFor(m.id, e.index), partial, context, { purpose: 'qed-archive', archive: id, index: e.index, name: e.name, bytes: e.bytes, sha256: e.sha256 })
      const back = o.keyring.verifyFile(partial, context)
      if (sealed.plaintextSha256 !== e.sha256 || back.plaintextSha256 !== e.sha256) throw new ArchiveError('verification_failed', `Entry ${e.index} of archive ${m.id} did not re-encrypt to its recorded contents; nothing was recorded.`)
      renameSync(partial, join(work, e.sealed.file))
      return { ...e, sealed: { file: e.sealed.file, bytes: sealed.ciphertextBytes, sha256: sealed.ciphertextSha256 } }
    })
    const active = o.keyring.list().find((k) => k.version === o.keyring.activeVersion)!
    const manifest: ArchiveManifest = { ...m, id, createdAt: new Date(at).toISOString(), createdAtMs: at, key: { kid: active.kid, version: active.version }, entries, reencryptedFrom: m.id }
    finish(o.keyring, work, dir, manifest)
    ;(o.log ?? noop)(`archive ${m.id} re-encrypted as ${id} under data key ${active.kid} (version ${active.version}); ${entries.length} entries checked`)
    return { manifest, manifestPath: join(dir, 'archive.json'), dir }
  } catch (e) {
    rmSync(work, { recursive: true, force: true })
    throw e
  }
}

/** The archives in a folder (each a subfolder holding archive.json), oldest first. */
export function listArchives(outDir: string): string[] {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir).filter((n) => ID_RE.test(n) && existsSync(join(outDir, n, 'archive.json'))).sort().map((n) => join(outDir, n, 'archive.json'))
}
