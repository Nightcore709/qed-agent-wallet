/**
 * What the owner is told about their on-chain wallet that only the wallet service knows (R13). The engine runs it every
 * half minute (engine.ts), beside the books' comparison; each vault is read once.
 *
 *   A reorganised job (R7-036). The wallet service reports a job "reorged" when a chain reorganisation replaced the block
 *   that held its transaction: before its confirmations (it was never reported done) or after. Either way the operation is
 *   not done and nothing was sent again. The owner gets one notice for each such job, under "Needs you" on Home and on
 *   Protect, with a link to the operation; acknowledging it settles it. If the same transaction is later mined again and
 *   the job is done, its notice is resolved, since the operation did happen.
 *
 *   A raise of the caps on earned authority that has come into force (D-K1b). A raise is a loosening: the owner and their
 *   recovery contacts are told when it is signed (rail.ts announceCapsRaise), and the owner again when it takes effect,
 *   which is when its delay has ended and no lower cap was signed meanwhile (the wallet service's own view of the caps says
 *   which). A raise that a lower cap dropped is forgotten without a notice.
 */
import { type Db, parse } from './core.ts'
import { notice, resolveNotices } from './execute.ts'
import { securityEvent } from './passkeys.ts'
import { at, rail, type RailCfg, railToken, type VaultRecord } from './rail.ts'

const KIND_WORDS: Record<string, string> = {
  convert: 'A conversion', pay: 'A payment', 'ring-fence': 'Money set aside for a creditor', withdraw: 'A withdrawal', deposit: 'A deposit', mandate: 'Signing a mandate',
  'revoke-mandate': 'Revoking the mandate', policy: 'Signing a standing policy', 'policy-tick': 'An automatic conversion', 'policy-run': 'An automatic conversion', provision: 'Setting up the wallet',
  venues: 'Changing the venues', settle: 'Paying a promise', grant: 'A grant of authority', 'earned-caps': 'Setting the caps on earned authority',
}
const words = (kind: string): string => KIND_WORDS[kind] ?? `An operation (${kind})`

interface JobBrief { id: string; kind: string; status: string; error?: string | null; guidance?: string | null }

/** One vault: notices for reorganised jobs, resolved again for a job the chain holds once more. Returns how many were raised. */
export function reorgNotices(db: Db, ws: string, jobs: JobBrief[], now: number): number {
  let raised = 0
  for (const j of jobs) {
    const dedupe = `vault-job-reorged:${j.id}`
    if (j.status === 'reorged') {
      const before = db.get<{ n: number }>('SELECT COUNT(*) n FROM notices WHERE user_id = ? AND dedupe = ?', ws, dedupe)!.n
      notice(db, ws, {
        level: 'action', kind: 'vault-job-reorged', subject: j.id, dedupe,
        title: `${words(j.kind)} on your on-chain wallet is not done`,
        body: `A reorganisation of the local test chain replaced the block that held its transaction, so it did not happen there. ${j.error ? `${j.error} ` : ''}Nothing was sent again. Check the wallet, and if you still want it, ask for it again. These are valueless test tokens on a local chain.`,
      }, now)
      if (!before) raised++
    } else if (j.status === 'done') resolveNotices(db, ws, dedupe, now)
  }
  return raised
}

interface CapsRaise { workspaceId: string; nonce: string; effectiveAt: number; people: string[]; caps: string[]; values: Record<string, string>; raises: string[] }
interface CapsView { inForce?: Record<string, string>; pending?: { cap: string; nonce: string }[] }

/** One vault: raises whose delay has ended. Told once if in force; forgotten if a lower cap dropped them. Returns how many were told. */
export function capsRaiseNotices(db: Db, ws: string, caps: CapsView | null, now: number): number {
  let told = 0
  for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE ?`, `vault.caps-raise:${ws}:%`)) {
    const raise = parse<CapsRaise | null>(r.value, null)
    if (!raise || raise.effectiveAt > now || !caps) continue
    // still waiting by the service's own clock: asked again at the next pass
    if (caps.pending?.some((p) => p.nonce === raise.nonce)) continue
    db.tx(() => {
      db.run('DELETE FROM meta WHERE key = ?', r.key)
      // in force: each raised cap is now what the raise asked; otherwise a lower cap signed meanwhile dropped it
      const inForce = (caps.inForce ?? {}) as Record<string, string>
      if (!raise.caps.length || !raise.caps.every((c) => inForce[c] !== undefined && inForce[c] === raise.values?.[c])) return
      for (const person of raise.people) securityEvent(db, person, 'vault-earned-caps-raised', { workspaceId: ws, nonce: raise.nonce, raises: raise.raises, inForce }, now)
      told++
    })
  }
  return told
}

/** Every vault: its recent jobs and its caps, read from the wallet service; the notices above. For the engine's record. */
export async function vaultWatch(cfg: RailCfg, db: Db, now: number): Promise<string> {
  if (!railToken(cfg)) return 'no vault service'
  const vaults = db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'vault.workspace:%' ORDER BY key`)
    .map((r) => ({ ws: r.key.slice('vault.workspace:'.length), v: parse<VaultRecord | null>(r.value, null) })).filter((x): x is { ws: string; v: VaultRecord } => !!x.v)
  let reorged = 0, raised = 0
  for (const { ws, v } of vaults) {
    if (!db.get('SELECT 1 x FROM users WHERE id = ?', ws)) continue
    const jobs = await rail(cfg, 'GET', at(v, '/jobs?limit=50')).catch(() => null)
    if (jobs?.status === 200) reorged += reorgNotices(db, ws, (jobs.json.jobs ?? []) as JobBrief[], now)
    if (db.get(`SELECT 1 x FROM meta WHERE key LIKE ? AND CAST(json_extract(value, '$.effectiveAt') AS INTEGER) <= ?`, `vault.caps-raise:${ws}:%`, now)) {
      const lim = await rail(cfg, 'GET', at(v, '/payments/limits')).catch(() => null)
      const caps = lim?.status === 200 ? ((lim.json.authority as { earnedCaps?: CapsView } | null)?.earnedCaps ?? null) : null
      raised += capsRaiseNotices(db, ws, caps, now)
    }
  }
  return `${vaults.length} wallet${vaults.length === 1 ? '' : 's'} watched: ${reorged} reorganised job${reorged === 1 ? '' : 's'} told, ${raised} raise${raised === 1 ? '' : 's'} in force told`
}
