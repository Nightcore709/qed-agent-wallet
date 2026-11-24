/**
 * Keys for encryption at rest (R7-076, D10).
 *
 * Data is sealed under data-encryption keys (DEKs). DEKs are versioned and kept in a keyring file, each wrapped by one
 * key-encryption key (KEK) held outside the database: a key file (mode 600, outside the database and backup folders;
 * the default locally and for a host's mounted secret), an environment variable a host's secret manager sets, or the
 * macOS Keychain (an interface only: not enabled, pending the owner's decision). Rotation adds a DEK version and keeps
 * the earlier ones for decryption; re-wrapping moves every DEK under a new KEK; revocation destroys a retired version.
 *
 * Cryptography, all from node:crypto (OpenSSL), nothing of our own: AES-256-GCM with a random 96-bit nonce per message
 * and a 128-bit tag; HKDF-SHA-256 separating the KEK's two uses (wrapping DEKs, and HMAC-SHA-256 over the keyring's
 * metadata). node:crypto offers no XChaCha20-Poly1305 (checked on Node 26.12, OpenSSL 3.5.9), so it is not used.
 * Random nonces allow 2^32 messages per key (NIST SP 800-38D 8.3); rotate long before that.
 *
 * Key separation (R11 section 11): every keyring has one purpose (the database's own fields, backups, or the copies
 * taken before a schema migration), authenticated with its metadata. Its data keys are independent random keys whose ids
 * name the purpose, and the KEK's wrapping and authentication keys are derived per purpose, so a keyring of one purpose
 * never opens, or stands in for, another's. Keyrings of format 1 (22 Nov, before purposes) are still read, as backup
 * keyrings only.
 *
 * Ciphertext layout, format 1. Every byte before the ciphertext is authenticated, together with a context string the
 * caller supplies (not stored), which binds a ciphertext to its purpose (a backup's id, a column and row):
 *   "QEDC" | format u8 = 1 | algorithm u8 = 1 (AES-256-GCM) | key version u32 | key id length u8 | key id (ASCII) |
 *   nonce (12) | plaintext length u64 | metadata length u16 | metadata (UTF-8 JSON) | ciphertext | tag (16)
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createSecretKey, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type KeyErrorCode =
  | 'key_missing' | 'key_malformed' | 'key_permissions' | 'key_location' | 'key_exists' | 'key_config' | 'keychain_not_enabled'
  | 'keyring_missing' | 'keyring_malformed' | 'keyring_exists' | 'keyring_tampered' | 'keyring_rolled_back' | 'wrong_key'
  | 'unknown_key' | 'key_revoked' | 'revoke_active' | 'key_purpose' | 'keyring_copy_differs'
  | 'ciphertext_malformed' | 'ciphertext_truncated' | 'authentication_failed'

/** A refusal about keys or ciphertext. Messages name paths, ids and versions; never key material or plaintext. */
export class KeyError extends Error {
  readonly code: KeyErrorCode
  constructor(code: KeyErrorCode, message: string) {
    super(message)
    this.name = 'KeyError'
    this.code = code
  }
}

// ------------------------------------------------------------------------------------------------ files and folders

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined)

/**
 * The real path of p through its nearest existing ancestor (p itself may not exist yet; macOS's /var is a link), as the
 * operating system resolves it: links followed and, on macOS, each name in the case it has on disk (realpath(3), which
 * node's own realpathSync does not do: it keeps the case it is given; independent review of cb85271, finding 2).
 */
export function realish(p: string): string {
  let head = resolve(p)
  const tail: string[] = []
  while (!existsSync(head)) {
    const up = dirname(head)
    if (up === head) break
    tail.unshift(basename(head))
    head = up
  }
  try { return join(realpathSync.native(head), ...tail) } catch { return resolve(p) }
}

/**
 * macOS's default APFS and Windows compare names without regard to case (and to Unicode normalisation), so two paths that
 * differ only there may name one file. Used only where a path does not exist yet; existing files are compared by inode.
 */
const FOLD = process.platform === 'darwin' || process.platform === 'win32'
export const foldName = (p: string): string => (FOLD ? p.normalize('NFC').toLowerCase() : p)
const fold = foldName

/** A file's identity, its device and inode (links followed), or null if there is no such file. */
export function fileId(p: string): string | null {
  try { const s = statSync(p); return `${s.dev}:${s.ino}` } catch { return null }
}

/**
 * Whether two paths name the same file: by device and inode when both exist (another letter case, a symbolic or a hard
 * link), not the same when only one exists, and otherwise by canonical path, case-folded where the file system may.
 */
export function samePath(a: string, b: string): boolean {
  const ia = fileId(a), ib = fileId(b)
  if (ia !== null || ib !== null) return ia === ib
  return fold(realish(a)) === fold(realish(b))
}

/**
 * Whether path is folder or lies inside it. If the folder exists, by identity: the folder's device and inode is the path's
 * or one of its ancestors' (whatever case or links the path is written with). If not, by canonical path, case-folded.
 */
export function inside(path: string, folder: string): boolean {
  const f = fileId(folder)
  if (f !== null && statSync(folder).isDirectory()) {
    for (let p = realish(path); ;) {
      if (fileId(p) === f) return true
      const up = dirname(p)
      if (up === p) return false
      p = up
    }
  }
  const rel = relative(fold(realish(folder)), fold(realish(path)))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Least privilege, checked whenever key material is loaded: a key file or keyring belongs to this service's user (or
 * root, for a host's mounted secret) and has no permission bits for anyone else; the folder holding a key file cannot
 * be written by anyone else (unless it has the sticky bit), so the file cannot be swapped.
 */
export function assertPrivate(path: string, kind: 'file' | 'folder', what: string): void {
  const st = statSync(path)
  const me = uid()
  if (kind === 'file' && !st.isFile()) throw new KeyError('key_permissions', `${what} at ${path} is not a regular file.`)
  if (kind === 'folder' && !st.isDirectory()) throw new KeyError('key_permissions', `${what} at ${path} is not a folder.`)
  if (me !== undefined && st.uid !== me && st.uid !== 0) throw new KeyError('key_permissions', `${what} at ${path} belongs to uid ${st.uid}, not to this service's user (uid ${me}).`)
  const m = st.mode & 0o777
  if (kind === 'file' && (m & 0o077) !== 0) throw new KeyError('key_permissions', `${what} at ${path} has mode ${m.toString(8)}: other users can read or change it. Run: chmod 600 '${path}'`)
  if (kind === 'folder' && (m & 0o022) !== 0 && (st.mode & 0o1000) === 0) throw new KeyError('key_permissions', `${what} at ${path} has mode ${m.toString(8)}: other users can replace what is in it. Run: chmod 700 '${path}'`)
}

/** Create a folder with mode 700 (and any missing parents), or check that an existing one is not writable by others. */
export function ensurePrivateFolder(path: string, what = 'The key folder'): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }
  assertPrivate(path, 'folder', what)
}

function writeAll(fd: number, b: Buffer): void {
  for (let off = 0; off < b.length;) off += writeSync(fd, b, off, b.length - off)
}

/** Write a new file (mode 600); refuse if it exists. */
function writeNewPrivate(path: string, data: Buffer): void {
  const fd = openSync(path, 'wx', 0o600)
  try { writeAll(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  chmodSync(path, 0o600)
}

/** Replace a file atomically: a private temporary file in the same folder, flushed, then renamed over the old one. */
export function replacePrivateFile(path: string, data: Buffer): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeNewPrivate(tmp, data)
    renameSync(tmp, path)
  } finally { rmSync(tmp, { force: true }) }
  try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* not every system can flush a folder */ }
}

// ------------------------------------------------------------------------------------------------ key-encryption keys

/** A key-encryption key in memory: its id and a KeyObject, which prints and serialises without its bytes. */
export interface Kek { readonly id: string; readonly key: KeyObject }

/** Where a KEK comes from. Loading checks everything it can and fails closed. */
export interface KekProvider { readonly kind: 'file' | 'env' | 'keychain'; readonly where: string; load(): Kek }

// The text form a KEK is stored and transported in, the same in a key file, an environment variable and the Keychain:
// "qedkek1:<id>:<32 bytes, base64url>:<check>". The check value detects a truncated or mistyped key before it is used.
const KEK_RE = /^qedkek1:(kek_[0-9a-f]{16}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{8})$/
const checkValue = (id: string, key: Buffer): string => createHash('sha256').update(`qed/kek-check/v1\0${id}\0`).update(key).digest('base64url').slice(0, 8)

/** A new KEK record: 32 bytes from crypto.randomBytes and a random id. Store it; never print or log it. */
export function newKekRecord(): string {
  const id = `kek_${randomBytes(8).toString('hex')}`
  const key = randomBytes(32)
  try { return `qedkek1:${id}:${key.toString('base64url')}:${checkValue(id, key)}` } finally { key.fill(0) }
}

/** Parse a KEK record. `where` names its source in errors; the record itself is never quoted. */
export function parseKekRecord(text: string, where: string): Kek {
  const m = KEK_RE.exec(text.trim())
  if (!m) throw new KeyError('key_malformed', `${where} does not hold a QED key-encryption key (one line, "qedkek1:<id>:<key>:<check>").`)
  const key = Buffer.from(m[2]!, 'base64url')
  try {
    if (key.length !== 32 || checkValue(m[1]!, key) !== m[3]) throw new KeyError('key_malformed', `${where}: the key's check value does not match; the key was altered or truncated.`)
    return { id: m[1]!, key: createSecretKey(key) }
  } finally { key.fill(0) }
}

/** (a) A key file: the default locally and for a host's mounted secret. */
export class FileKekProvider implements KekProvider {
  readonly kind = 'file' as const
  readonly path: string
  readonly where: string
  private readonly forbidden: string[]

  /** forbiddenFolders: the database and backup folders; a key inside either would travel with every copy of it. */
  constructor(path: string, opts: { forbiddenFolders?: string[] } = {}) {
    this.path = resolve(path)
    this.where = `The key file ${this.path}`
    // An empty entry would resolve to the working folder; it names no folder, so it is dropped.
    this.forbidden = (opts.forbiddenFolders ?? []).filter((f) => f !== '').map((f) => resolve(f))
  }

  load(): Kek {
    this.checkLocation()
    if (!existsSync(this.path)) throw new KeyError('key_missing', `No key-encryption key at ${this.path}. Restore it from its escrow copy; without it nothing sealed under this keyring can be opened.`)
    assertPrivate(dirname(this.path), 'folder', 'The folder holding the key file')
    assertPrivate(this.path, 'file', 'The key file')
    return parseKekRecord(readFileSync(this.path, 'utf8'), this.where)
  }

  /** Make a new key file (mode 600, its folder 700). An existing key file is never overwritten. */
  static generate(path: string, opts: { forbiddenFolders?: string[] } = {}): FileKekProvider {
    const p = new FileKekProvider(path, opts)
    p.checkLocation()
    ensurePrivateFolder(dirname(p.path))
    try { writeNewPrivate(p.path, Buffer.from(`${newKekRecord()}\n`, 'utf8')) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new KeyError('key_exists', `A key file already exists at ${p.path}; it is never overwritten (to change keys, re-wrap the keyring under a new key file).`)
      throw e
    }
    p.load()
    return p
  }

  private checkLocation(): void {
    for (const f of this.forbidden) if (inside(this.path, f)) throw new KeyError('key_location', `The key file ${this.path} is inside ${f}; keep it outside the database and backup folders, so that no copy of them carries its key.`)
  }
}

/**
 * (b) An environment variable set by a host's secret manager, holding the same record as a key file. It is removed
 * from the environment as soon as it is read, so that child processes (a model's command-line client, for one) do not
 * inherit it.
 */
export class EnvKekProvider implements KekProvider {
  readonly kind = 'env' as const
  readonly name: string
  readonly where: string
  private readonly env: Record<string, string | undefined>
  private readonly scrub: boolean
  private cached: Kek | undefined

  constructor(name = 'QED_KEK', env: Record<string, string | undefined> = process.env, opts: { scrub?: boolean } = {}) {
    this.name = name
    this.where = `The environment variable ${name}`
    this.env = env
    this.scrub = opts.scrub ?? true
  }

  load(): Kek {
    if (this.cached) return this.cached
    const v = this.env[this.name]
    if (this.scrub) delete this.env[this.name]
    if (v === undefined || v === '') throw new KeyError('key_missing', `${this.where} is not set; the host's secret manager must provide the key-encryption key there.`)
    this.cached = parseKekRecord(v, this.where)
    return this.cached
  }
}

/** The Keychain operations the Keychain provider needs: one generic password per service and account. */
export interface KeychainBackend {
  read(service: string, account: string): string | undefined
  write(service: string, account: string, secret: string): void
}

const KEYCHAIN_OFF = 'The macOS Keychain provider is not enabled: reading or writing the login Keychain waits for the owner\'s decision (HO-022). Use a key file or an environment variable.'
/** The owner's login Keychain. Not enabled: nothing here reads or writes it. */
export const systemKeychain: KeychainBackend = {
  read() { throw new KeyError('keychain_not_enabled', KEYCHAIN_OFF) },
  write() { throw new KeyError('keychain_not_enabled', KEYCHAIN_OFF) },
}

/** (c) The macOS Keychain, through a backend: the system one is not enabled; tests use a double (keys-fake.ts). */
export class KeychainKekProvider implements KekProvider {
  readonly kind = 'keychain' as const
  readonly where: string
  private readonly backend: KeychainBackend
  private readonly service: string
  private readonly account: string

  constructor(backend: KeychainBackend, service = 'qed-demo.kek', account = 'qed') {
    this.backend = backend
    this.service = service
    this.account = account
    this.where = `The Keychain item ${service}/${account}`
  }

  load(): Kek {
    const v = this.backend.read(this.service, this.account)
    if (v === undefined) throw new KeyError('key_missing', `${this.where} does not exist.`)
    return parseKekRecord(v, this.where)
  }

  /** Store a new KEK in the backend's Keychain; an existing item is never replaced. */
  static generate(backend: KeychainBackend, service?: string, account?: string): KeychainKekProvider {
    const p = new KeychainKekProvider(backend, service, account)
    if (backend.read(p.service, p.account) !== undefined) throw new KeyError('key_exists', `${p.where} already exists; it is never replaced.`)
    backend.write(p.service, p.account, newKekRecord())
    p.load()
    return p
  }
}

// ------------------------------------------------------------------------------------------------ ciphertext

const MAGIC = Buffer.from('QEDC', 'ascii')
const FORMAT = 1
const AES_256_GCM = 1
const NONCE = 12
const TAG = 16
const MAX_KID = 64
const MAX_META = 8192
const KID_RE = /^[A-Za-z0-9_-]+$/
/** The longest header: what must be read from a file to parse one. */
export const MAX_HEADER = 4 + 1 + 1 + 4 + 1 + MAX_KID + NONCE + 8 + 2 + MAX_META

export interface Header {
  version: number
  kid: string
  nonce: Buffer
  /** Plaintext length in bytes. */
  length: number
  meta: Record<string, unknown>
  /** Header length in bytes: the ciphertext starts here. */
  size: number
  bytes: Buffer
}

function encodeHeader(version: number, kid: string, nonce: Buffer, length: number, meta: Record<string, unknown>): Buffer {
  const k = Buffer.from(kid, 'ascii')
  const m = Buffer.from(JSON.stringify(meta), 'utf8')
  if (k.length < 1 || k.length > MAX_KID || !KID_RE.test(kid)) throw new Error(`invalid key id "${kid}"`)
  if (m.length > MAX_META) throw new Error(`ciphertext metadata is ${m.length} bytes; at most ${MAX_META}`)
  const b = Buffer.alloc(11 + k.length + NONCE + 10 + m.length)
  let o = MAGIC.copy(b, 0)
  b[o++] = FORMAT
  b[o++] = AES_256_GCM
  b.writeUInt32BE(version, o); o += 4
  b[o++] = k.length
  o += k.copy(b, o)
  o += nonce.copy(b, o)
  b.writeBigUInt64BE(BigInt(length), o); o += 8
  b.writeUInt16BE(m.length, o); o += 2
  m.copy(b, o)
  return b
}

/** Read a ciphertext's header without any key: what it says about its key, length and metadata. */
export function parseHeader(buf: Buffer): Header {
  const need = (n: number) => { if (buf.length < n) throw new KeyError('ciphertext_truncated', `The ciphertext ends inside its header (${buf.length} bytes).`) }
  const malformed = (why: string) => new KeyError('ciphertext_malformed', `This is not a QED ciphertext this build can read: ${why}. Nothing is returned in its place.`)
  if (buf.length >= 4 && !buf.subarray(0, 4).equals(MAGIC)) throw malformed('its first bytes are not "QEDC"')
  need(11)
  if (buf[4] !== FORMAT) throw malformed(`format ${buf[4]} is not known`)
  if (buf[5] !== AES_256_GCM) throw malformed(`algorithm ${buf[5]} is not known`)
  const version = buf.readUInt32BE(6)
  const k = buf[10]!
  if (k < 1 || k > MAX_KID) throw malformed('its key id length is out of range')
  need(11 + k + NONCE + 10)
  const kid = buf.toString('ascii', 11, 11 + k)
  if (!KID_RE.test(kid)) throw malformed('its key id has characters a key id cannot have')
  const nonce = Buffer.from(buf.subarray(11 + k, 11 + k + NONCE))
  const length = buf.readBigUInt64BE(11 + k + NONCE)
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('its declared length is out of range')
  const m = buf.readUInt16BE(11 + k + NONCE + 8)
  if (m > MAX_META) throw malformed('its metadata is too long')
  const size = 11 + k + NONCE + 10 + m
  need(size)
  let meta: unknown
  try { meta = JSON.parse(buf.toString('utf8', size - m, size)) } catch { throw malformed('its metadata is not JSON') }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw malformed('its metadata is not an object')
  return { version, kid, nonce, length: Number(length), meta: meta as Record<string, unknown>, size, bytes: Buffer.from(buf.subarray(0, size)) }
}

const aad = (header: Buffer, context: string): Buffer => Buffer.concat([header, Buffer.from([0]), Buffer.from(context, 'utf8')])
const authFailed = (): KeyError => new KeyError('authentication_failed', 'The ciphertext failed authentication: it was altered or truncated, belongs to another context, or was sealed under another key. Nothing is returned.')

function seal(key: KeyObject, version: number, kid: string, plaintext: Buffer, context: string, meta: Record<string, unknown>): Buffer {
  const nonce = randomBytes(NONCE)
  const header = encodeHeader(version, kid, nonce, plaintext.length, meta)
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG })
  c.setAAD(aad(header, context))
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([header, body, c.getAuthTag()])
}

function checkLength(h: Header, total: number): void {
  const want = h.size + h.length + TAG
  if (total < want) throw new KeyError('ciphertext_truncated', `The ciphertext is truncated: ${total} bytes where its header declares ${want}.`)
  if (total > want) throw new KeyError('ciphertext_malformed', `The ciphertext has ${total - want} bytes after its tag. Nothing is returned in its place.`)
}

function open(key: KeyObject, h: Header, blob: Buffer, context: string): Buffer {
  checkLength(h, blob.length)
  const d = createDecipheriv('aes-256-gcm', key, h.nonce, { authTagLength: TAG })
  d.setAAD(aad(h.bytes, context))
  d.setAuthTag(blob.subarray(blob.length - TAG))
  const out = d.update(blob.subarray(h.size, blob.length - TAG))
  try { d.final() } catch { out.fill(0); throw authFailed() }
  return out
}

export interface FileSeal { header: Header; ciphertextBytes: number; ciphertextSha256: string; plaintextBytes: number; plaintextSha256: string }
export interface FileOpen { header: Header; plaintextBytes: number; plaintextSha256: string }
const CHUNK = 1 << 20

// ------------------------------------------------------------------------------------------------ keyring

/**
 * What a keyring's data keys are for. Each purpose has a keyring and data keys of its own (key separation): the
 * database's own fields (D10's field encryption; reserved: nothing is sealed under it yet), backups, the copies
 * taken before a schema migration, and the wallet service's own secrets at rest (its master secret and the
 * co-signer's keys; chain/rail/sealed-at-rest.ts, from 24 Nov).
 */
export type KeyPurpose = 'database' | 'backup' | 'migration-copy' | 'wallet-secret'
export const KEY_PURPOSES: readonly KeyPurpose[] = ['database', 'backup', 'migration-copy', 'wallet-secret']
const isPurpose = (p: unknown): p is KeyPurpose => typeof p === 'string' && (KEY_PURPOSES as readonly string[]).includes(p)

type KeyState = 'active' | 'retired' | 'revoked'
interface Entry { version: number; kid: string; state: KeyState; createdAt: number; retiredAt: number | null; revokedAt: number | null; wrapped: string | null }
const RING_V1 = 'qed-keyring/1' // 22 Nov 2026: no purpose; read as a backup keyring, made format 2 by its first change
const RING_V2 = 'qed-keyring/2'
/**
 * generation (format 2, from 24 Nov): raised by every change and covered by the keyring's authentication. The highest
 * generation written is also kept beside the keyring (<name>.generation), so an older copy put back over it is refused
 * (independent review of cb85271, finding 3). Absent in keyrings written before: generation 0.
 */
interface RingFile { format: typeof RING_V1 | typeof RING_V2; purpose?: KeyPurpose; generation?: number; kekId: string; active: number; keys: Entry[]; mac: string }
type RingKind = Pick<RingFile, 'format' | 'purpose'>
/**
 * What can be said about a data key without its material. `check` is its key check value (16 hex digits of
 * HMAC-SHA-256 under the key): equal values mean the same key, so keyrings and copies can be compared without revealing
 * any key. Null once the key is revoked.
 */
export type KeyInfo = Omit<Entry, 'wrapped'> & { check: string | null }

/**
 * Two keys from one KEK by HKDF-SHA-256 (RFC 5869): one wraps data keys, one authenticates the keyring. Format 2 derives
 * them per purpose, so one KEK serves every keyring while no two keyrings share a wrapping or authentication key.
 */
function subkey(kek: Kek, use: 'wrap' | 'mac', f: RingKind): KeyObject {
  const [salt, info] = f.format === RING_V1 ? ['qed-keyring-v1', `qed/keyring/${use}/v1`] : ['qed-keyring-v2', `qed/keyring/${f.purpose}/${use}/v2`]
  const raw = new Uint8Array(hkdfSync('sha256', kek.key, Buffer.from(salt), Buffer.from(info), 32))
  try { return createSecretKey(raw) } finally { raw.fill(0) }
}
function macOf(k: KeyObject, f: Omit<RingFile, 'mac'>): string {
  const keys = f.keys.map((e) => [e.version, e.kid, e.state, e.createdAt, e.retiredAt, e.revokedAt, e.wrapped])
  const fields = f.format === RING_V1 ? [f.format, f.kekId, f.active, keys]
    : f.generation === undefined ? [f.format, f.purpose, f.kekId, f.active, keys] : [f.format, f.purpose, f.generation, f.kekId, f.active, keys]
  return createHmac('sha256', k).update(JSON.stringify(fields)).digest('base64url')
}
const wrapContext = (f: RingKind, kekId: string, version: number, kid: string): string =>
  f.format === RING_V1 ? `qed/keyring/dek/v1:${kekId}:${version}:${kid}` : `qed/keyring/dek/v2:${f.purpose}:${kekId}:${version}:${kid}`
const checkOf = (k: KeyObject): string => createHmac('sha256', k).update('qed/key-check/v1').digest('hex').slice(0, 16)
const when = (ms: number | null): string => (ms === null ? 'an unknown time' : new Date(ms).toISOString())

function validRing(f: unknown): f is RingFile {
  if (typeof f !== 'object' || f === null) return false
  const r = f as Partial<RingFile>
  const kind = (r.format === RING_V1 && r.purpose === undefined && r.generation === undefined)
    || (r.format === RING_V2 && isPurpose(r.purpose) && (r.generation === undefined || (Number.isSafeInteger(r.generation) && r.generation >= 0)))
  return kind && typeof r.kekId === 'string' && Number.isSafeInteger(r.active) && typeof r.mac === 'string' && Array.isArray(r.keys)
    && r.keys.every((e) => typeof e === 'object' && e !== null && Number.isSafeInteger(e.version) && e.version > 0 && typeof e.kid === 'string' && KID_RE.test(e.kid)
      && ['active', 'retired', 'revoked'].includes(e.state) && Number.isSafeInteger(e.createdAt) && (e.wrapped === null || typeof e.wrapped === 'string'))
}

/** Beside a keyring: the highest generation written (<name>.generation) and the folders of copies (<name>.places). */
const sidePath = (keyring: string, ext: 'generation' | 'places'): string => `${keyring.replace(/\.json$/i, '')}.${ext}`
const GENERATION_FORMAT = 'qed-keyring-generation/1'
function readHighWater(keyring: string): number | null {
  const p = sidePath(keyring, 'generation')
  if (!existsSync(p)) return null
  let f: { format?: unknown; generation?: unknown }
  try { f = JSON.parse(readFileSync(p, 'utf8')) as typeof f } catch { throw new KeyError('keyring_malformed', `${p} (the keyring's generation record) is not valid JSON.`) }
  if (f.format !== GENERATION_FORMAT || !Number.isSafeInteger(f.generation) || (f.generation as number) < 0) throw new KeyError('keyring_malformed', `${p} is not a ${GENERATION_FORMAT} record.`)
  return f.generation as number
}

/** Read a sealed file's header without any key. */
export function headerOfFile(path: string): Header {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(fstatSync(fd).size, MAX_HEADER))
    readSync(fd, head, 0, head.length, 0)
    return parseHeader(head)
  } finally { closeSync(fd) }
}

/** Versioned data keys, each wrapped by the KEK, in one file (mode 600). One writer at a time (an operator command). */
export class Keyring {
  readonly path: string
  private kek: Kek
  private readonly file: RingFile
  private readonly deks = new Map<number, KeyObject>()

  private constructor(path: string, kek: Kek, file: RingFile) {
    this.path = path
    this.kek = kek
    this.file = file
  }

  /** A new keyring for one purpose, with data key version 1. An existing keyring is never overwritten. */
  static create(path: string, kek: Kek, now: number = Date.now(), purpose: KeyPurpose = 'backup'): Keyring {
    const p = resolve(path)
    if (existsSync(p)) throw new KeyError('keyring_exists', `A keyring already exists at ${p}; it is never overwritten.`)
    ensurePrivateFolder(dirname(p), 'The keyring folder')
    const ring = new Keyring(p, kek, { format: RING_V2, purpose, generation: 1, kekId: kek.id, active: 0, keys: [], mac: '' })
    ring.addVersion(now)
    writeNewPrivate(p, ring.serialise())
    ring.writeHighWater()
    return ring
  }

  /**
   * Open a keyring: its file is private, the KEK is the one that wrapped it, its metadata (its purpose included) and every
   * data key authenticate. With `expect`, a keyring of another purpose is refused (key_purpose) before any key is unwrapped.
   */
  static load(path: string, kek: Kek, expect?: KeyPurpose): Keyring {
    const p = resolve(path)
    if (!existsSync(p)) throw new KeyError('keyring_missing', `No keyring at ${p}. If this computer never had keys, set them up with \`npm run keys:init\`. If the keyring was lost, put back its newest copy (one is kept beside each set of sealed copies; \`node scripts/backup.ts list --keyring <copy>\` shows a copy's generation): an older copy can lack keys made since and still hold keys revoked since, and is refused where a newer generation was recorded. Without the keyring, nothing sealed under it can be opened.`)
    assertPrivate(p, 'file', 'The keyring')
    let f: unknown
    try { f = JSON.parse(readFileSync(p, 'utf8')) } catch { throw new KeyError('keyring_malformed', `The keyring at ${p} is not valid JSON.`) }
    if (!validRing(f)) throw new KeyError('keyring_malformed', `The keyring at ${p} is not a ${RING_V2} (or ${RING_V1}) keyring.`)
    if (f.kekId !== kek.id) throw new KeyError('wrong_key', `The keyring at ${p} is wrapped by key-encryption key ${f.kekId}; the key supplied is ${kek.id}.`)
    const want = Buffer.from(macOf(subkey(kek, 'mac', f), f)), got = Buffer.from(f.mac)
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new KeyError('keyring_tampered', `The keyring at ${p} failed its integrity check: it was altered, or the key supplied is not the one that wrapped it.`)
    const ring = new Keyring(p, kek, f)
    if (expect) ring.requirePurpose(expect) // after the integrity check: the purpose read here is authenticated
    const hw = readHighWater(p)
    if (hw !== null && ring.generation < hw) throw new KeyError('keyring_rolled_back', `The keyring at ${p} is generation ${ring.generation}, but generation ${hw} was written here before (${sidePath(p, 'generation')}): it is an older copy put back. An older copy can hold keys revoked since and lack keys made since, so it is not used. Put back the newest copy (generation ${hw} or later); only if no newer copy exists anywhere, accept this one knowingly by removing ${sidePath(p, 'generation')}.`)
    const wrap = subkey(kek, 'wrap', f)
    for (const e of f.keys) {
      if (!e.wrapped) continue
      let raw: Buffer
      try {
        const blob = Buffer.from(e.wrapped, 'base64url')
        raw = open(wrap, parseHeader(blob), blob, wrapContext(f, f.kekId, e.version, e.kid))
      } catch { throw new KeyError('keyring_tampered', `Data key ${e.kid} (version ${e.version}) in ${p} does not unwrap under ${kek.id}.`) }
      try { ring.deks.set(e.version, createSecretKey(raw)) } finally { raw.fill(0) }
    }
    if (!ring.file.keys.some((e) => e.version === ring.file.active && e.state === 'active' && ring.deks.has(e.version))) throw new KeyError('keyring_malformed', `The keyring at ${p} has no usable active data key.`)
    return ring
  }

  get kekId(): string { return this.file.kekId }
  get activeVersion(): number { return this.file.active }
  /** What these data keys are for. A keyring of format 1 is a backup keyring. */
  get purpose(): KeyPurpose { return this.file.purpose ?? 'backup' }
  get format(): 1 | 2 { return this.file.format === RING_V1 ? 1 : 2 }
  /** Raised by every change to this keyring (0: written before generations, 24 Nov). */
  get generation(): number { return this.file.generation ?? 0 }

  /**
   * Record a folder where copies sealed under this keyring, or copies of this keyring, are kept, so that revoking a key
   * and re-encrypting can find them (<keyring name>.places, one JSON line per folder). Best effort: a key folder that
   * cannot be written (a host's read-only secret mount) does not stop a backup.
   */
  notePlace(dir: string): void {
    try {
      const d = realish(dir)
      if (this.places().some((x) => samePath(x, d))) return
      appendFileSync(sidePath(this.path, 'places'), `${JSON.stringify({ dir: d, at: Date.now() })}\n`, { mode: 0o600 })
    } catch { /* best effort; see above */ }
  }
  /** The folders recorded by notePlace, oldest first. */
  places(): string[] {
    const p = sidePath(this.path, 'places')
    if (!existsSync(p)) return []
    const out: string[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const d = (JSON.parse(line) as { dir?: unknown }).dir; if (typeof d === 'string' && !out.includes(d)) out.push(d) } catch { /* a torn line is skipped */ }
    }
    return out
  }
  /** Stop recording a folder (its copies are gone for good). */
  forgetPlace(dir: string): boolean {
    const keep = this.places().filter((x) => !samePath(x, dir))
    if (keep.length === this.places().length) return false
    replacePrivateFile(sidePath(this.path, 'places'), Buffer.from(keep.map((d) => `${JSON.stringify({ dir: d, at: Date.now() })}\n`).join(''), 'utf8'))
    return true
  }
  list(): KeyInfo[] {
    return this.file.keys.map(({ wrapped: _w, ...info }) => { const k = this.deks.get(info.version); return { ...info, check: k ? checkOf(k) : null } })
  }

  /** Refuse to use this keyring for anything but its own purpose. */
  requirePurpose(p: KeyPurpose): void {
    if (this.purpose !== p) throw new KeyError('key_purpose', `The keyring at ${this.path} holds ${this.purpose} keys; ${p} keys are required here. Each purpose has a keyring of its own (docs/ENCRYPTION.md, section 3).`)
  }

  /** Seal under the active data key. `context` is bound to the ciphertext and must be given again to open it. */
  encrypt(plaintext: Buffer, context: string, meta: Record<string, unknown> = {}): Buffer {
    const e = this.active()
    return seal(this.deks.get(e.version)!, e.version, e.kid, plaintext, context, meta)
  }

  /** Open a ciphertext from this keyring, or fail closed. */
  decrypt(blob: Buffer, context: string): Buffer {
    const h = parseHeader(blob)
    return open(this.keyFor(h), h, blob, context)
  }

  /** Seal a file into a new private file (mode 600), streaming, in one AES-256-GCM message. dst must not exist. */
  encryptFile(src: string, dst: string, context: string, meta: Record<string, unknown>): FileSeal {
    const e = this.active()
    const inFd = openSync(src, 'r')
    let outFd: number | undefined
    let ok = false
    const buf = Buffer.alloc(CHUNK)
    try {
      const size = fstatSync(inFd).size
      const nonce = randomBytes(NONCE)
      const hb = encodeHeader(e.version, e.kid, nonce, size, meta)
      const c = createCipheriv('aes-256-gcm', this.deks.get(e.version)!, nonce, { authTagLength: TAG })
      c.setAAD(aad(hb, context))
      outFd = openSync(dst, 'wx', 0o600)
      const ch = createHash('sha256'), ph = createHash('sha256')
      const put = (b: Buffer) => { if (b.length) { writeAll(outFd!, b); ch.update(b) } }
      put(hb)
      let total = 0
      for (;;) {
        const n = readSync(inFd, buf, 0, CHUNK, null)
        if (n === 0) break
        total += n
        const part = buf.subarray(0, n)
        ph.update(part)
        put(c.update(part))
      }
      if (total !== size) throw new Error(`${src} changed while it was being sealed`)
      put(c.final())
      put(c.getAuthTag())
      fsyncSync(outFd)
      ok = true
      return { header: parseHeader(hb), ciphertextBytes: hb.length + size + TAG, ciphertextSha256: ch.digest('hex'), plaintextBytes: size, plaintextSha256: ph.digest('hex') }
    } finally {
      buf.fill(0)
      closeSync(inFd)
      if (outFd !== undefined) closeSync(outFd)
      if (!ok && outFd !== undefined) rmSync(dst, { force: true })
    }
  }

  /**
   * Open a sealed file into a new private file (mode 600), streaming. GCM releases plaintext before its tag is checked,
   * so the output is removed unless the tag verifies: on any failure no output remains. dst must not exist.
   */
  decryptFile(src: string, dst: string, context: string): FileOpen {
    let outFd: number | undefined
    let ok = false
    // Created at the first plaintext, once the header and the key have checked out.
    const out = (): number => (outFd ??= openSync(dst, 'wx', 0o600))
    try {
      const r = this.openStream(src, context, (plain) => writeAll(out(), plain))
      fsyncSync(out())
      ok = true
      return r
    } finally {
      if (outFd !== undefined) closeSync(outFd)
      if (!ok && outFd !== undefined) rmSync(dst, { force: true })
    }
  }

  /**
   * Check a sealed file end to end, writing nothing: its plaintext streams through memory (to `sink`, if given, which
   * may compare or hash it) and the tag is checked at the end. Until this returns, what the sink saw is unauthenticated.
   */
  verifyFile(src: string, context: string, sink?: (plain: Buffer) => void): FileOpen {
    return this.openStream(src, context, sink ?? (() => {}))
  }

  /**
   * Re-seal a file under the active data key (after a rotation), streaming: the plaintext passes through memory only,
   * never the disk. The new file names the active key in its header and is bound to dstContext; if the source fails
   * authentication the new file is removed. dst must not exist.
   */
  resealFile(src: string, srcContext: string, dst: string, dstContext: string, meta: Record<string, unknown>): FileSeal & { from: { kid: string; version: number } } {
    const e = this.active()
    const length = headerOfFile(src).length
    let outFd: number | undefined
    let ok = false
    try {
      const nonce = randomBytes(NONCE)
      const hb = encodeHeader(e.version, e.kid, nonce, length, meta)
      const c = createCipheriv('aes-256-gcm', this.deks.get(e.version)!, nonce, { authTagLength: TAG })
      c.setAAD(aad(hb, dstContext))
      outFd = openSync(dst, 'wx', 0o600)
      const ch = createHash('sha256')
      const put = (b: Buffer) => { if (b.length) { writeAll(outFd!, b); ch.update(b) } }
      put(hb)
      const opened = this.openStream(src, srcContext, (plain) => put(c.update(plain)))
      if (opened.plaintextBytes !== length) throw new KeyError('ciphertext_malformed', `${src} changed while it was being re-sealed.`)
      put(c.final())
      put(c.getAuthTag())
      fsyncSync(outFd)
      ok = true
      return { header: parseHeader(hb), ciphertextBytes: hb.length + length + TAG, ciphertextSha256: ch.digest('hex'), plaintextBytes: opened.plaintextBytes, plaintextSha256: opened.plaintextSha256, from: { kid: opened.header.kid, version: opened.header.version } }
    } finally {
      if (outFd !== undefined) closeSync(outFd)
      if (!ok && outFd !== undefined) rmSync(dst, { force: true })
    }
  }

  /** The one decrypting reader: header and key checks, then the body in chunks to `sink` (each chunk zeroed after), then the tag. */
  private openStream(src: string, context: string, sink: (plain: Buffer) => void): FileOpen {
    const inFd = openSync(src, 'r')
    const buf = Buffer.alloc(CHUNK)
    try {
      const size = fstatSync(inFd).size
      const head = Buffer.alloc(Math.min(size, MAX_HEADER))
      readSync(inFd, head, 0, head.length, 0)
      const h = parseHeader(head)
      checkLength(h, size)
      const key = this.keyFor(h)
      const tag = Buffer.alloc(TAG)
      readSync(inFd, tag, 0, TAG, size - TAG)
      const d = createDecipheriv('aes-256-gcm', key, h.nonce, { authTagLength: TAG })
      d.setAAD(aad(h.bytes, context))
      d.setAuthTag(tag)
      const ph = createHash('sha256')
      let pos = h.size, left = h.length
      while (left > 0) {
        const n = readSync(inFd, buf, 0, Math.min(CHUNK, left), pos)
        if (n === 0) throw new KeyError('ciphertext_truncated', `${src} ended early.`)
        pos += n; left -= n
        const plain = d.update(buf.subarray(0, n))
        ph.update(plain)
        try { sink(plain) } finally { plain.fill(0) }
      }
      try { d.final() } catch { throw authFailed() }
      return { header: h, plaintextBytes: h.length, plaintextSha256: ph.digest('hex') }
    } finally {
      buf.fill(0)
      closeSync(inFd)
    }
  }

  /** Rotation: a new data key version seals from now on; the previous one is retired and still opens what it sealed. */
  rotate(now: number = Date.now()): KeyInfo {
    this.upgrade()
    const prev = this.active()
    prev.state = 'retired'
    prev.retiredAt = now
    const e = this.addVersion(now)
    this.save()
    return this.list().find((k) => k.version === e.version)!
  }

  /** KEK rotation: every live data key is re-wrapped under newKek; nothing sealed before is lost. */
  rewrap(newKek: Kek): void {
    this.upgrade()
    this.file.keys = this.wrapAll(newKek, this.file)
    this.file.kekId = newKek.id
    this.kek = newKek
    this.save()
  }

  /** Revocation after a compromise: the version's key material is destroyed; what it sealed can no longer be opened. */
  revoke(version: number, now: number = Date.now()): void {
    this.upgrade() // first: it replaces the entries, which are then found and changed
    const e = this.file.keys.find((k) => k.version === version)
    if (!e) throw new KeyError('unknown_key', `This keyring has no data key version ${version}.`)
    if (e.state === 'active') throw new KeyError('revoke_active', `Version ${version} is the active data key; rotate first, re-encrypt what it sealed, then revoke it.`)
    e.state = 'revoked'
    e.revokedAt = now
    e.wrapped = null
    this.deks.delete(version)
    this.save()
  }

  /** A copy of the keyring file (wrapped keys only) elsewhere, for example beside the backups; written atomically, mode 600. */
  copyTo(path: string): void {
    const p = resolve(path)
    // Never over another purpose's keyring copy: two purposes sharing a folder would otherwise overwrite each other's.
    if (existsSync(p)) {
      let other: unknown
      try { other = (JSON.parse(readFileSync(p, 'utf8')) as { purpose?: unknown }).purpose ?? 'backup' } catch { other = this.purpose }
      if (other !== this.purpose) throw new KeyError('key_purpose', `${p} is a copy of the ${String(other)} keyring; the ${this.purpose} keyring's copy cannot go there. Keep each purpose's copies in a folder of their own.`)
    }
    replacePrivateFile(p, this.serialise())
    this.notePlace(dirname(p))
  }

  private active(): Entry {
    const e = this.file.keys.find((k) => k.version === this.file.active)
    if (!e || e.state !== 'active' || !this.deks.has(e.version)) throw new KeyError('keyring_malformed', `The keyring at ${this.path} has no usable active data key.`)
    return e
  }

  private keyFor(h: Header): KeyObject {
    const e = this.file.keys.find((k) => k.version === h.version)
    if (!e) throw new KeyError('unknown_key', `This ciphertext was sealed under data key ${h.kid} (version ${h.version}); this keyring has no version ${h.version}.`)
    if (e.kid !== h.kid) throw new KeyError('unknown_key', `This ciphertext names data key ${h.kid} as version ${h.version}, but version ${h.version} here is ${e.kid}: it comes from another keyring, or its header was altered.`)
    if (e.state === 'revoked') throw new KeyError('key_revoked', `Data key ${e.kid} (version ${e.version}) was revoked at ${when(e.revokedAt)}; its material is destroyed and what it sealed cannot be opened.`)
    const k = this.deks.get(e.version)
    if (!k) throw new KeyError('unknown_key', `Data key ${e.kid} (version ${e.version}) has no key material in this keyring.`)
    return k
  }

  private addVersion(now: number): Entry {
    const version = this.file.keys.reduce((m, k) => Math.max(m, k.version), 0) + 1
    // An explicit key id: format 2 names the purpose in it (dek_backup_…, dek_migration-copy_…, dek_database_…).
    const kid = this.file.format === RING_V1 ? `dek_${randomBytes(8).toString('hex')}` : `dek_${this.purpose}_${randomBytes(8).toString('hex')}`
    const raw = randomBytes(32)
    try {
      const wrapped = seal(subkey(this.kek, 'wrap', this.file), 0, this.kek.id, raw, wrapContext(this.file, this.kek.id, version, kid), {}).toString('base64url')
      const e: Entry = { version, kid, state: 'active', createdAt: now, retiredAt: null, revokedAt: null, wrapped }
      this.file.keys.push(e)
      this.file.active = version
      this.deks.set(version, createSecretKey(raw))
      return e
    } finally { raw.fill(0) }
  }

  private serialise(): Buffer {
    const f = this.file
    const body = f.format === RING_V1 ? { format: f.format, kekId: f.kekId, active: f.active, keys: f.keys }
      : f.generation === undefined ? { format: f.format, purpose: f.purpose, kekId: f.kekId, active: f.active, keys: f.keys }
        : { format: f.format, purpose: f.purpose, generation: f.generation, kekId: f.kekId, active: f.active, keys: f.keys }
    this.file.mac = macOf(subkey(this.kek, 'mac', f), body)
    return Buffer.from(`${JSON.stringify({ ...body, mac: this.file.mac }, null, 1)}\n`, 'utf8')
  }

  /** Write a change: a new generation, the keyring, then the generation record beside it. */
  private save(): void {
    this.file.generation = this.generation + 1
    replacePrivateFile(this.path, this.serialise())
    this.writeHighWater()
  }

  private writeHighWater(): void {
    const p = sidePath(this.path, 'generation')
    const hw = (() => { try { return readHighWater(this.path) ?? 0 } catch { return 0 } })()
    replacePrivateFile(p, Buffer.from(`${JSON.stringify({ format: GENERATION_FORMAT, generation: Math.max(hw, this.generation) })}\n`, 'utf8'))
  }

  /** A format-1 keyring becomes format 2 (purpose backup) before its first change: its keys are wrapped again for it. */
  private upgrade(): void {
    if (this.file.format !== RING_V1) return
    const kind: RingKind = { format: RING_V2, purpose: 'backup' }
    this.file.keys = this.wrapAll(this.kek, kind)
    this.file.format = RING_V2
    this.file.purpose = 'backup'
    this.file.generation = 0
  }

  /** Every live data key wrapped under kek for a keyring of this kind. */
  private wrapAll(kek: Kek, kind: RingKind): Entry[] {
    const wrap = subkey(kek, 'wrap', kind)
    return this.file.keys.map((e) => {
      const dek = this.deks.get(e.version)
      if (!e.wrapped || !dek) return { ...e }
      const raw = dek.export()
      try { return { ...e, wrapped: seal(wrap, 0, kek.id, raw, wrapContext(kind, kek.id, e.version, e.kid), {}).toString('base64url') } } finally { raw.fill(0) }
    })
  }
}
