/**
 * Check that ~/qed-approved-release is unchanged (R13 SE5; R7-003). Read-only on the release.
 *
 *   node scripts/release-unchanged.ts            hash the release's tracked files and compare them with the recorded manifest
 *   node scripts/release-unchanged.ts --json     the same, as JSON
 *   node scripts/release-unchanged.ts --record   write a NEW manifest from the release's present state (to register/, never to the
 *                                                 release). Do this only when the owner has accepted a change to the release.
 *
 * The release folder is QED_RELEASE_DIR or ~/qed-approved-release. Exit codes: 0 unchanged; 1 drift (added, removed or
 * changed files are listed); 2 usage or a missing folder or manifest.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, checkRelease, isUnchanged, readManifest, writeManifest } from '../server/release-integrity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(here, '..', 'register', 'approved-release-manifest.json')
const root = process.env.QED_RELEASE_DIR ?? join(homedir(), 'qed-approved-release')
const args = process.argv.slice(2)
const json = args.includes('--json')

if (!existsSync(root)) {
  console.error(`release folder not found: ${root}`)
  process.exit(2)
}
if (args.includes('--record')) {
  const m = buildManifest(root, new Date().toISOString(), '~/qed-approved-release')
  writeManifest(root, MANIFEST, m)
  console.log(`recorded ${m.fileCount} files, tree ${m.treeSha256}, at ${m.recordedAt}: ${MANIFEST}`)
  process.exit(0)
}
if (args.some((a) => a !== '--json')) {
  console.error('usage: node scripts/release-unchanged.ts [--json | --record]')
  process.exit(2)
}
let manifest
try {
  manifest = readManifest(MANIFEST)
} catch (e) {
  console.error(String((e as Error).message))
  process.exit(2)
}
const drift = checkRelease(root, manifest)
const ok = isUnchanged(drift)
if (json) console.log(JSON.stringify({ ok, recordedAt: manifest.recordedAt, fileCount: manifest.fileCount, ...drift }, null, 1))
else if (ok) console.log(`unchanged: ${manifest.fileCount} files match the manifest recorded ${manifest.recordedAt}`)
else {
  console.log(`CHANGED since ${manifest.recordedAt}: ${drift.changed.length} changed, ${drift.added.length} added, ${drift.removed.length} removed`)
  for (const [k, v] of Object.entries(drift)) for (const p of v.slice(0, 50)) console.log(`  ${k}: ${p}`)
}
process.exit(ok ? 0 : 1)
