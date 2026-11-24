/**
 * Cryptographic discovery (R13 hardening; ASVS 5.0 V11.1.3): every place in QED's own code that uses cryptography, found
 * by reading the code, compared with the inventory kept in docs/crypto-inventory.json (V11.1.2), which docs/CRYPTO.md
 * explains. server/crypto-inventory.test.ts fails when code uses a primitive the inventory does not describe, or a file
 * starts or stops using cryptography without the inventory saying so.
 *
 *   node scripts/crypto-inventory.ts           print what the code uses, as the inventory's `sites`
 *   node scripts/crypto-inventory.ts --check   compare with docs/crypto-inventory.json; exit 1 on a difference
 *
 * What counts: imports from node:crypto (by name), WebCrypto (crypto.subtle, crypto.getRandomValues), WebAuthn libraries
 * (@simplewebauthn), the noble libraries (@noble/curves, @noble/hashes), viem's key, signing and hashing functions, and
 * Solidity signature checks (ecrecover, ECDSA, P-256, EIP-712). Tests are not counted; the vendored release
 * (chain/vendor) is the release's own code, inventoried by its hashes (chain/VENDORED.json), not here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const ROOTS = ['server', 'shared', 'src', 'chain/rail', 'chain/accounts/src', 'chain/bounties/src', 'chain/disputes/src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.build', 'out', 'cache', 'evidence', 'results'])
/** Forge's dependency folders (lib under chain) are other projects' code; src/lib and scripts/lib are QED's own. */
const isForgeLib = (dir: string, name: string): boolean => name === 'lib' && /[\\/]chain[\\/]/.test(dir)
/** This file names the patterns it looks for; it uses no cryptography itself. */
const SELF = 'crypto-inventory.ts'
const VIEM = ['privateKeyToAccount', 'generatePrivateKey', 'signTypedData', 'signMessage', 'hashTypedData', 'recoverTypedDataAddress', 'recoverAddress', 'recoverMessageAddress', 'keccak256', 'sha256', 'verifyTypedData']

function files(app: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(n) && !isForgeLib(d, n)) walk(p) } else if (/\.(ts|tsx|mts|mjs|sol)$/.test(n) && !/\.(test|spec)\.(ts|tsx|mjs)$/.test(n) && !/\.t\.sol$/.test(n) && n !== SELF) out.push(p)
    }
  }
  for (const r of ROOTS) walk(join(app, r))
  return out.sort()
}

/** The primitives one file's text uses. */
export function primitivesIn(text: string, isSolidity = false): string[] {
  const found = new Set<string>()
  for (const imp of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/g)) {
    for (const raw of imp[1]!.split(',')) { const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim(); if (n) found.add(`node:crypto.${n}`) }
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*["']node:crypto["']|import\s+\w+\s+from\s*["']node:crypto["']/.test(text)) found.add('node:crypto.*')
  if (/\bcrypto\.subtle\b/.test(text)) found.add('webcrypto.subtle')
  if (/\bcrypto\.getRandomValues\b/.test(text)) found.add('webcrypto.getRandomValues')
  if (/\bcrypto\.randomUUID\b/.test(text)) found.add('webcrypto.randomUUID')
  if (/["']@simplewebauthn\/server(\/[a-z]+)?["']/.test(text)) found.add('@simplewebauthn/server')
  if (/["']@simplewebauthn\/browser["']/.test(text)) found.add('@simplewebauthn/browser')
  for (const m of text.matchAll(/["'](@noble\/[a-z0-9-]+\/[a-z0-9-]+)(\.js)?["']/g)) found.add(m[1]!)
  if (/from\s*["']viem(\/accounts|\/utils)?["']/.test(text)) for (const n of VIEM) if (new RegExp(`\\b${n}\\b`).test(text)) found.add(`viem.${n}`)
  if (isSolidity && /\becrecover\b|\bECDSA\b|\bP256\b|EIP712|SignatureChecker|\bkeccak256\b/.test(text)) found.add('solidity.signatures-or-hashes')
  return [...found].sort()
}

/** Every file of QED's own code that uses cryptography, with what it uses. */
export function discover(app: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const f of files(app)) {
    const p = primitivesIn(readFileSync(f, 'utf8'), f.endsWith('.sol'))
    if (p.length) out[relative(app, f).split('\\').join('/')] = p
  }
  return out
}

export interface Inventory { primitives: Record<string, string>; sites: Record<string, string[]> }
/** Differences between what the code uses and the inventory: each a sentence. */
export function compare(found: Record<string, string[]>, inv: Inventory): string[] {
  const out: string[] = []
  for (const [f, ps] of Object.entries(found)) {
    const listed = inv.sites[f]
    if (!listed) { out.push(`${f} uses ${ps.join(', ')} and is not in the inventory`); continue }
    for (const p of ps) if (!listed.includes(p)) out.push(`${f} uses ${p}, which the inventory does not list for it`)
    for (const p of listed) if (!ps.includes(p)) out.push(`${f} is listed with ${p}, which it no longer uses`)
  }
  for (const f of Object.keys(inv.sites)) if (!found[f]) out.push(`${f} is in the inventory but uses no cryptography now (or was moved)`)
  for (const p of new Set(Object.values(found).flat())) if (!inv.primitives[p]) out.push(`${p} is used but the inventory does not say what for`)
  return out
}

if (import.meta.main) {
  const app = join(import.meta.dirname, '..')
  const found = discover(app)
  if (process.argv.includes('--check')) {
    const inv = JSON.parse(readFileSync(join(app, 'docs', 'crypto-inventory.json'), 'utf8')) as Inventory
    const diff = compare(found, inv)
    console.log(diff.length ? diff.join('\n') : `The inventory matches the code: ${Object.keys(found).length} files, ${new Set(Object.values(found).flat()).size} primitives.`)
    process.exit(diff.length ? 1 : 0)
  }
  console.log(JSON.stringify(found, null, 1))
}
