/**
 * The "must never appear" check for private keys that are published (R13 hardening; docs/standards/DECISION-NOTES-SE6.md
 * section 1, R7-083, F-060): the approved release published, on purpose, the agent and co-signer keys of a "honeypot"
 * vault on Ethereum Sepolia. QED never reuses, imports or copies them. This check fails if either key value appears in any
 * file of this repository.
 *
 * The list holds the keys' public ADDRESSES, not the keys: a list of the key values would itself be a copy of them. Every
 * 64-digit hexadecimal string in a file (with or without 0x) is read as a secp256k1 private key, its Ethereum address is
 * worked out, and an address on the list is a hit. A hit names the file and line, never the value. The addresses are
 * public chain data, read from the release's own evidence that this repository carries (chain/vendor/evidence/
 * ethereum-sepolia/manifest.json: actors.hpAgent and actors.hpCosigner, and the honeypot vault's AgentSet and CosignerSet
 * events at its deployment, step D5).
 *
 *   node scripts/never-appear.ts [--json report.json] [--root <folder>]
 *
 * It scans the repository's tracked files and its untracked files that are not ignored (git ls-files), from the
 * repository's root. Not scanned: ignored files (node_modules among them), and the git history (NOT VERIFIED there).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'

export interface NeverAppear { name: string; address: string; source: string }
/** The published keys, named by their addresses. Lower-case comparison; the checksum form is kept for reading. */
export const NEVER_APPEAR: readonly NeverAppear[] = [
  { name: 'the honeypot vault\'s agent key (Ethereum Sepolia, published by the approved release, 20 Oct 2026)', address: '0x22f224dd5Db8344E6474c9d165DC273E96c173F5', source: 'chain/vendor/evidence/ethereum-sepolia/manifest.json actors.hpAgent; AgentSet at step D5' },
  { name: 'the honeypot vault\'s co-signer key (Ethereum Sepolia, published by the approved release, 20 Oct 2026)', address: '0x35b370861B06aA2a372f02BdF027f5E324153ab7', source: 'chain/vendor/evidence/ethereum-sepolia/manifest.json actors.hpCosigner; CosignerSet at step D5' },
]

/** The Ethereum address of a 32-byte private key given as 64 hex digits, or null when it is not a valid key. */
export function addressOf(hex64: string): string | null {
  try {
    const pub = secp256k1.getPublicKey(hex64, false)
    return `0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString('hex')}`
  } catch { return null }
}

const TOKEN = /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g
export interface Hit { file: string; line: number; name: string }
export interface ScanReport { filesScanned: number; filesSkipped: number; candidates: number; hits: Hit[] }

/** Scans the named files (paths relative to `root`) for any value whose address is on `list`. */
export function scan(root: string, files: string[], list: readonly NeverAppear[] = NEVER_APPEAR): ScanReport {
  const wanted = new Map(list.map((x) => [x.address.toLowerCase(), x.name]))
  const seen = new Map<string, string | null>()
  const hits: Hit[] = []
  let scanned = 0, skipped = 0
  for (const f of files) {
    let buf: Buffer
    try { const st = statSync(join(root, f)); if (!st.isFile() || st.size > 50_000_000) { skipped++; continue } buf = readFileSync(join(root, f)) } catch { skipped++; continue }
    const text = buf.toString('latin1')
    scanned++
    for (const m of text.matchAll(TOKEN)) {
      const k = m[1]!.toLowerCase()
      let a = seen.get(k)
      if (a === undefined) { a = addressOf(k); seen.set(k, a) }
      const name = a ? wanted.get(a) : undefined
      if (name) hits.push({ file: f, line: text.slice(0, m.index).split('\n').length, name })
    }
  }
  return { filesScanned: scanned, filesSkipped: skipped, candidates: seen.size, hits }
}

/** The repository's files: tracked, and untracked but not ignored. */
export function repositoryFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
  const root = at('--root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname }).toString().trim()
  const t0 = performance.now()
  const files = repositoryFiles(root)
  const r = scan(root, files)
  const report = { what: 'published private keys that must never appear (scripts/never-appear.ts)', root: relative(process.cwd(), root) || '.', list: NEVER_APPEAR.map(({ name, address, source }) => ({ name, address, source })), ...r, seconds: Math.round((performance.now() - t0) / 100) / 10, notScanned: 'ignored files (node_modules among them) and the git history' }
  const out = at('--json')
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
  console.log(`${r.filesScanned} files scanned (${r.filesSkipped} skipped), ${r.candidates} distinct 64-digit hex strings read as keys, ${r.hits.length} hit${r.hits.length === 1 ? '' : 's'}${r.hits.map((h) => `\n  ${h.file}:${h.line} ${h.name}`).join('')}`)
  process.exit(r.hits.length ? 1 : 0)
}
