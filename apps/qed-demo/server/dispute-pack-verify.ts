/**
 * Offline verification of a dispute pack (N-018). Pure: no database and no server, and it re-implements the hash rules it
 * checks (the pack's own digest, the receipt chain of server/receipts.ts, the approval's fingerprint) rather than importing
 * them, so that it does not trust what it verifies. What it cannot catch: someone who rewrites a pack and recomputes the
 * digest, every receipt hash and the chain after it. The receipt chain's head, obtained from the QED instance
 * independently, is what catches that.
 */
import { createHash } from 'node:crypto'
import { canonical } from '../shared/sha256.ts'

export const PACK_FORMAT = 'qed-dispute-pack/v1'
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
type Pack = Record<string, any>
export interface PackCheck { name: string; ok: boolean; detail: string }

/** The digest a pack carries: SHA-256 over its canonical form without the integrity block itself. */
export function packDigest(pack: Pack): string {
  const { integrity: _omit, ...rest } = pack
  return sha(canonical(rest))
}

export function verifyDisputePack(pack: Pack): { ok: boolean; checks: PackCheck[] } {
  const checks: PackCheck[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  add('format', pack?.format === PACK_FORMAT && pack?.simulated === true && typeof pack?.notice === 'string', pack?.format === PACK_FORMAT ? 'A QED dispute pack, labelled simulated.' : 'Not a QED dispute pack of this format.')
  if (pack?.format !== PACK_FORMAT) return { ok: false, checks }
  const digest = packDigest(pack)
  add('digest', pack.integrity?.sha256 === digest, pack.integrity?.sha256 === digest ? 'The pack\'s digest matches its contents.' : 'The pack\'s contents do not match its digest: something was changed.')
  const rs: { seq: number; hash: string; prevHash: string; body: unknown }[] = Array.isArray(pack.receipts) ? pack.receipts : []
  const bad = rs.filter((r) => sha(`${r.prevHash}\n${canonical(r.body)}`) !== r.hash)
  add('receipt hashes', bad.length === 0, bad.length ? `Receipt ${bad.map((r) => `#${r.seq}`).join(', ')} does not match its hash.` : `${rs.length} receipt hash${rs.length === 1 ? '' : 'es'} recomputed and matching.`)
  const broken = rs.slice(1).filter((r, i) => r.seq === rs[i]!.seq + 1 && r.prevHash !== rs[i]!.hash)
  add('receipt links', broken.length === 0, broken.length ? `Receipt #${broken[0]!.seq} does not follow the one before it.` : 'Consecutive receipts follow each other.')
  const ap = pack.approval
  if (ap && typeof ap === 'object' && 'docHash' in ap) add('approval', sha(canonical(ap.document)) === ap.docHash, sha(canonical(ap.document)) === ap.docHash ? 'The signed approval matches its fingerprint.' : 'The approval document does not match the fingerprint the passkey signed.')
  const tl: { at: number; iso: string }[] = Array.isArray(pack.timeline) ? pack.timeline : []
  const ordered = tl.every((t, i) => typeof t.at === 'number' && new Date(t.at).toISOString() === t.iso && (i === 0 || tl[i - 1]!.at <= t.at))
  add('timestamps', ordered && tl.length > 0, ordered && tl.length > 0 ? `${tl.length} timeline steps, each timestamped, in order.` : 'A timeline step has no time, a time that does not match its date, or is out of order.')
  return { ok: checks.every((c) => c.ok), checks }
}
