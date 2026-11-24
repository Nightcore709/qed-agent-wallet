/**
 * Bring the limits that experiment X9 calibrated into the wallet: only the entries it marked loadable (status
 * "calibrated", load true). Writes server/limits.calibrated.json with the source file's SHA-256, so every limit the
 * wallet uses can be traced to the run that produced it; the registry reads that file.
 *
 *   node scripts/import-limits.ts [path to X9's limits.json]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

interface Entry { status?: string; load?: boolean; termDef?: { id: string; kind: string; name: string; value: unknown; source: string; asOf: string; status: string } }
const APP = join(import.meta.dirname, '..')
const REPO = join(APP, '..', '..')
const src = process.argv[2] ?? join(REPO, 'experiments', 'r7', 'X9-calibration', 'limits.json')
const raw = readFileSync(src, 'utf8')
const x9 = JSON.parse(raw) as { computedAt?: string; preregistration?: unknown; deviations?: unknown; instruments: Record<string, Entry> }
const terms = Object.values(x9.instruments).filter((e) => e.load === true && e.status === 'calibrated' && e.termDef?.status === 'calibrated').map((e) => e.termDef!)
const skipped = Object.entries(x9.instruments).filter(([, e]) => !(e.load === true && e.status === 'calibrated')).map(([id]) => id)
const out = {
  about: 'Limits calibrated by experiment X9 on each instrument\'s own history, imported by scripts/import-limits.ts. Only entries whose walk-forward validation was not rejected and whose tail was identifiable are here (rule set by the orchestrator on 22 Nov 2026; X9 DEVIATIONS.md D2). Each is the fall not exceeded in 99.99% of the stated windows of its history; none is a worst case, and the stress episodes that exceeded it are named in its source.',
  source: relative(REPO, src), sourceSha256: createHash('sha256').update(raw).digest('hex'), computedAt: x9.computedAt ?? null, preregistration: x9.preregistration ?? null,
  notLoaded: skipped, terms,
}
writeFileSync(join(APP, 'server', 'limits.calibrated.json'), `${JSON.stringify(out, null, 1)}\n`)
console.log(`${terms.length} calibrated limits written; not loaded (illustrative values stay): ${skipped.join(', ')}`)
