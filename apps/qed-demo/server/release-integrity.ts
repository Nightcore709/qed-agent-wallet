/**
 * Is the approved release unchanged? (R13 SE5; R7-003.)
 *
 * Strictly read-only on the release: this module only lists directories, reads files and reads link targets there. It
 * never opens a file for writing, creates, renames or removes anything under the release, and the one function that
 * writes (writeManifest) refuses a destination inside the release folder. The release is not a git repository, so
 * "tracked" here means every file and link under the folder except `node_modules/` (installed, not part of the release's
 * own source) and `.git/` (absent today). A manifest records each file's SHA-256 and size, or a link's target.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const EXCLUDED_DIRS: readonly string[] = ['node_modules', '.git']

export interface ManifestEntry {
  /** SHA-256 of the file's bytes, or for a symbolic link the string "link:" and its target. */
  sha256: string
  bytes: number
}
export interface ReleaseManifest {
  recordedAt: string
  root: string
  excluded: string[]
  fileCount: number
  /** SHA-256 of the sorted "path NUL digest" lines: one value that changes if anything does. */
  treeSha256: string
  files: Record<string, ManifestEntry>
}
export interface Drift {
  added: string[]
  removed: string[]
  changed: string[]
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = lstatSync(full)
    const rel = relative(root, full).split(sep).join('/')
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.includes(name)) continue
      walk(root, full, out)
    } else if (st.isFile() || st.isSymbolicLink()) out.push(rel)
  }
}

function entryOf(root: string, rel: string): ManifestEntry {
  const full = join(root, rel)
  const st = lstatSync(full)
  if (st.isSymbolicLink()) {
    const target = readlinkSync(full)
    return { sha256: 'link:' + target, bytes: 0 }
  }
  return { sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), bytes: st.size }
}

export function treeDigest(files: Record<string, ManifestEntry>): string {
  const h = createHash('sha256')
  for (const p of Object.keys(files).sort()) h.update(p + '\0' + files[p]!.sha256 + '\n')
  return h.digest('hex')
}

/** Hash every tracked file under `root`. Reads only. */
export function hashTree(root: string): Record<string, ManifestEntry> {
  const paths: string[] = []
  walk(root, root, paths)
  const files: Record<string, ManifestEntry> = {}
  for (const rel of paths) files[rel] = entryOf(root, rel)
  return files
}

export function buildManifest(root: string, recordedAt: string, label = root): ReleaseManifest {
  const files = hashTree(root)
  return { recordedAt, root: label, excluded: [...EXCLUDED_DIRS], fileCount: Object.keys(files).length, treeSha256: treeDigest(files), files }
}

export function compare(manifest: ReleaseManifest, current: Record<string, ManifestEntry>): Drift {
  const added = Object.keys(current).filter((p) => !(p in manifest.files)).sort()
  const removed = Object.keys(manifest.files).filter((p) => !(p in current)).sort()
  const changed = Object.keys(manifest.files).filter((p) => p in current && current[p]!.sha256 !== manifest.files[p]!.sha256).sort()
  return { added, removed, changed }
}

export const isUnchanged = (d: Drift): boolean => d.added.length + d.removed.length + d.changed.length === 0

export function checkRelease(root: string, manifest: ReleaseManifest): Drift {
  return compare(manifest, hashTree(root))
}

/** Refuses any destination inside the release. `destination` may not exist yet: its folder is resolved instead. */
export function assertOutsideRelease(root: string, destination: string): void {
  const real = realpathSync(root)
  const dir = realpathSync(dirname(resolve(destination)))
  const dest = join(dir, resolve(destination).split(sep).pop()!)
  if (dest === real || dest.startsWith(real + sep)) throw new Error(`refusing to write inside the release: ${destination}`)
}

export function writeManifest(root: string, destination: string, manifest: ReleaseManifest): void {
  assertOutsideRelease(root, destination)
  const tmp = destination + '.tmp'
  writeFileSync(tmp, JSON.stringify(manifest, null, 1) + '\n')
  renameSync(tmp, destination)
}

export function readManifest(path: string): ReleaseManifest {
  if (!existsSync(path)) throw new Error(`no manifest at ${path}`)
  const m = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest
  if (!m.files || m.fileCount !== Object.keys(m.files).length || m.treeSha256 !== treeDigest(m.files)) throw new Error('the manifest is not consistent with itself')
  return m
}
