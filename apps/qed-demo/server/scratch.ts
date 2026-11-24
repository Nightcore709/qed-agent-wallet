/**
 * Private scratch folders that may hold plaintext for a moment: a snapshot being sealed, a database being restored or
 * extracted, a drill's restored copy (docs/ENCRYPTION.md, section 4). Each records its owner (process id, computer, start
 * time, what it is for) in owner.json. Signals cannot cut these operations short (they are synchronous, and the entry
 * points take SIGINT, SIGTERM and SIGHUP), but a SIGKILL, a crash or a power cut can, so the next operation that makes a
 * folder of the same kind in the same place first sweeps the ones whose owner is gone: each file is overwritten with
 * zeros, then removed, and each folder is reported. A folder whose owner may still be running is left, and reported.
 *
 * Overwriting is best effort: on APFS, a copy-on-write file system, it writes new blocks and the old ones are freed, not
 * erased; FileVault is what protects them. Imports only node built-ins (sealed.ts, and through it core.ts, use it).
 */
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

export const OWNER_FILE = 'owner.json'
/** A folder with no owner record is taken as stale only once it is this old: it may have been made a moment ago. */
const NO_OWNER_GRACE_MS = 60_000

interface Owner { pid: number; host: string; startedAt: number; what: string; kept?: boolean }
export interface Sweep {
  removed: { path: string; bytes: number }[]
  left: { path: string; why: string }[]
  /** Stale folders that could not be removed; the caller refuses to go on. */
  failed: { path: string; why: string }[]
}

/** A new private folder (mode 700) in parent, named prefix plus random characters, recording this process as its owner. */
export function makeScratch(parent: string, prefix: string, what: string): string {
  const dir = mkdtempSync(join(resolve(parent), prefix))
  try {
    chmodSync(dir, 0o700)
    const owner: Owner = { pid: process.pid, host: hostname(), startedAt: Date.now(), what }
    writeFileSync(join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' })
    return dir
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/** Mark a scratch folder as kept on request (a drill's --keep): sweeps leave it; removing it is the operator's. */
export function keepScratch(dir: string): void {
  const owner = readOwner(dir)
  if (owner) writeFileSync(join(dir, OWNER_FILE), `${JSON.stringify({ ...owner, kept: true })}\n`, { mode: 0o600 })
}

/**
 * Whether the process that made a folder may still be running. This process is never: its own scratch work is
 * synchronous, so a folder it owns is left from an earlier step of it that failed. EPERM: another user's process, running.
 */
function mayBeRunning(pid: number): boolean {
  if (pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function readOwner(dir: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as Partial<Owner>
    return Number.isSafeInteger(o.pid) && (o.pid as number) > 0 && typeof o.host === 'string' && typeof o.what === 'string' ? (o as Owner) : null
  } catch { return null }
}

/** Overwrite a regular file with zeros, flush, then remove it. A symbolic link (or anything else) is removed, never followed. */
function scrub(path: string): number {
  const st = lstatSync(path)
  if (!st.isFile()) { unlinkSync(path); return 0 }
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    const zeros = Buffer.alloc(Math.min(1 << 20, Math.max(st.size, 1)))
    for (let off = 0; off < st.size;) off += writeSync(fd, zeros, 0, Math.min(zeros.length, st.size - off), off)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  unlinkSync(path)
  return st.size
}

const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** Scrub everything in a folder, depth first, then remove it. Returns the bytes overwritten. What vanishes meanwhile is skipped. */
function clear(dir: string): number {
  let bytes = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try { bytes += lstatSync(p).isDirectory() ? clear(p) : scrub(p) } catch (e) { if (!gone(e)) throw e }
  }
  try { rmdirSync(dir) } catch (e) { if (!gone(e)) throw e }
  return bytes
}

export type SweepOutcome = 'removed' | 'left' | 'gone' | 'failed'

/**
 * Sweep one scratch folder: remove it if its owner is gone (overwriting its files first), else leave it; either way log
 * one line (paths, sizes, process ids; never contents). A folder that vanishes meanwhile (its own operation finished and
 * removed it) is 'gone', not a failure.
 */
export function sweepOne(dir: string, log: (line: string) => void, out: Sweep = { removed: [], left: [], failed: [] }): SweepOutcome {
  let st
  try { st = lstatSync(dir) } catch (e) { if (gone(e)) return 'gone'; throw e }
  const leave = (why: string): SweepOutcome => { out.left.push({ path: dir, why }); log(`left ${dir}: ${why}; if no QED operation is using it, remove it: rm -rf '${dir}'`); return 'left' }
  if (!st.isDirectory()) return leave('not a folder (a link or a file), so it is not followed')
  const me = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (me !== undefined && st.uid !== me) return leave(`it belongs to uid ${st.uid}`)
  const owner = readOwner(dir)
  if (owner?.kept) return leave(`kept on request by ${owner.what} --keep`)
  if (owner && owner.host !== hostname()) return leave(`made on ${owner.host}, whose processes cannot be checked from here`)
  if (owner && mayBeRunning(owner.pid)) return leave(`process ${owner.pid} is still running (a ${owner.what} may be under way)`)
  if (!owner && Date.now() - st.mtimeMs < NO_OWNER_GRACE_MS) return leave('no owner record, and made in the last minute')
  try {
    const bytes = clear(dir)
    out.removed.push({ path: dir, bytes })
    log(`removed ${dir}: left by an interrupted ${owner ? `${owner.what} (process ${owner.pid}, started ${new Date(owner.startedAt).toISOString()})` : 'operation (no owner record)'}; ${bytes} bytes overwritten with zeros and deleted`)
    return 'removed'
  } catch (e) {
    if (!existsSync(dir)) return 'gone'
    const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message
    out.failed.push({ path: dir, why })
    log(`could not remove ${dir} (${why}), left by an interrupted ${owner?.what ?? 'operation'}`)
    return 'failed'
  }
}

/**
 * Remove the folders named `prefix…` in parent whose owner is gone (a dead process on this computer, or no owner record
 * and older than a minute), overwriting their files first; leave and report the others (sweepOne). `beforeOne` is a test
 * seam, called with each name before it is swept.
 */
export function sweepScratch(parent: string, prefix: string, log: (line: string) => void, beforeOne?: (name: string) => void): Sweep {
  const out: Sweep = { removed: [], left: [], failed: [] }
  const p0 = resolve(parent)
  if (!existsSync(p0)) return out
  for (const name of readdirSync(p0).filter((n) => n.startsWith(prefix)).sort()) {
    beforeOne?.(name)
    sweepOne(join(p0, name), log, out)
  }
  return out
}
