/**
 * Verify a QED dispute pack offline, without the server that made it.
 *
 *   node scripts/verify-dispute-pack.ts <pack.json> [--head HEX]
 *
 * Checks the pack's digest, every receipt's hash and links, the approval's fingerprint and the timeline's timestamps.
 * --head compares the last receipt's hash with a receipt-chain head obtained independently, which is the only defence
 * against someone who recomputes every hash. Exit 0 when everything holds, 1 when anything fails, 2 on bad usage.
 */
import { readFileSync } from 'node:fs'
import { verifyDisputePack } from '../server/dispute-pack-verify.ts'

const args = process.argv.slice(2)
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--head')
const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : undefined
if (!file) { console.error('usage: node scripts/verify-dispute-pack.ts <pack.json> [--head HEX]'); process.exit(2) }
let pack: Record<string, any>
try { pack = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { console.error(`${file}: not a readable JSON file (${(e as Error).message})`); process.exit(2) }
const r = verifyDisputePack(pack)
if (head) { const ok = pack.receiptChain?.head === head; r.checks.push({ name: 'head', ok, detail: ok ? 'The receipt chain head matches the one you supplied.' : 'The receipt chain head differs from the one you supplied.' }); r.ok = r.ok && ok }
for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
console.log(r.ok ? 'The pack verifies.' : 'The pack does NOT verify.')
process.exit(r.ok ? 0 : 1)
