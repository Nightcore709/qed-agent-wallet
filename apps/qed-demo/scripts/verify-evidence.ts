/**
 * Re-verify an evidence case without trusting the server that assembled it.
 *
 *   node scripts/verify-evidence.ts <case.json> [--rpc URL] [--root HEX] [--head HEX] [--json]
 *
 * Offline (always): each section's SHA-256 and the root; the receipt chain's links and the bodies it carries; each vault
 * decision record's hash; each signed document's hash and each terms hash; each passkey signature (ES256) against the
 * recorded public key and the exact challenge it had to sign; the order of steps; and that the figures agree across
 * sections. With --rpc: every transaction on the vault's chain is re-read from that chain (status, block, from, to,
 * gas, and every recorded event figure in its logs). --root and --head compare the case with a root or a receipt-chain
 * head obtained independently, which is the only defence against a forger who recomputes every hash.
 *
 * Exit code 0 when everything holds, 1 when anything fails (each failure printed with what differs), 2 on bad usage.
 * The logic is server/evidence-verify.ts; this file only reads arguments and prints.
 */
import { readFileSync } from 'node:fs'
import { type EvidenceCase, verifyCase, verifyOnChain } from '../server/evidence-verify.ts'

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const file = args.find((a, i) => !a.startsWith('--') && !['--rpc', '--root', '--head'].includes(args[i - 1] ?? ''))
if (!file) { console.error('usage: node scripts/verify-evidence.ts <case.json> [--rpc URL] [--root HEX] [--head HEX] [--json]'); process.exit(2) }

let c: EvidenceCase
try { c = JSON.parse(readFileSync(file, 'utf8')) as EvidenceCase } catch (e) { console.error(`${file}: not a readable JSON file (${(e as Error).message})`); process.exit(2) }
const root = opt('--root'), head = opt('--head'), rpc = opt('--rpc')
const offline = verifyCase(c, { ...(root ? { root } : {}), ...(head ? { head } : {}) })
const chain = rpc ? await verifyOnChain(c, rpc) : null
const ok = offline.ok && (chain?.ok ?? true)

if (args.includes('--json')) {
  console.log(JSON.stringify({ file, case: c.id, root: c.hashes?.root ?? null, ok, offline, ...(chain ? { onChain: chain } : {}) }, null, 1))
} else {
  console.log(`${c.id}: ${c.title}`)
  console.log(`root ${String(c.hashes?.root)}`)
  for (const x of offline.checks) console.log(`  ${x.ok ? 'ok  ' : 'FAIL'}  ${x.check}${x.ok ? '' : `: ${x.detail}`}`)
  if (chain) for (const x of chain.checks) console.log(`  ${x.ok ? 'ok  ' : 'FAIL'}  on chain: ${x.check}: ${x.detail}`)
  console.log(ok ? `VERIFIED: ${offline.checks.length} offline check${offline.checks.length === 1 ? '' : 's'}${chain ? `, ${chain.checks.length} against ${rpc}` : ''}` : `NOT VERIFIED: ${[...offline.failures, ...(chain?.failures ?? [])].length} failure(s)`)
}
process.exit(ok ? 0 : 1)
