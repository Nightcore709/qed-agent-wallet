/**
 * Refutation bounties in the wallet (R11 section 9; R10-008, R10-009).
 *
 *   - The two original 1,000-tUSD bounties of the release, stated exactly: what each invites people to refute, its
 *     limits, the five claims recorded against them on Sepolia (read from the vendored evidence, not retyped), and their
 *     dated status. They are historical records (D-104): this wallet never reads, claims, funds or announces them, and
 *     no text here says "unclaimed today" (the last record is 22:45:45 UTC, 19 Oct 2026; not re-verified, Q-072).
 *   - The local board on this installation's chain (chain/rail/bounties.ts): the same two contracts, unmodified, judge
 *     claims on pools of 1,000 tUSD each, and pay only the committed finder (commit, reveal after a delay and before
 *     expiry, an older commitment wins a contest, anyone settles). The household claims through its own vault service
 *     workspace; the payout goes to the household's tUSD reserve vault unless it asks for its owner account.
 *
 * Each POST returns the vault service's job ({ jobId, kind, status }), followed with GET /api/vault/jobs/:id. The claim
 * is the judge's claim, as calldata or as its fields (chain/README.md, "Refutation bounties"). Nothing here reaches a
 * public network; every token is a valueless test token.
 */
import { readFileSync } from 'node:fs'
import { AppError, audit, bad, type Db } from './core.ts'
import { type Asker, at, must, type RailCfg, vaultOf } from './rail.ts'

type Json = Record<string, unknown>
const KEY = /^[A-Za-z0-9-]{8,80}$/
const BOUNTY_ID = /^\d{1,6}$/
const CLAIM_ID = /^0x[0-9a-f]{64}$/

// ------------------------------------------------------------------------------------------------ the originals

/** The release's recorded Run 3 on Sepolia, vendored byte for byte (chain/VENDORED.json). */
const EVIDENCE = new URL('../chain/vendor/evidence/ethereum-sepolia/private/', import.meta.url)
interface Step { id: string; title: string; actor: string; actorAddress: string; tx: { hash: string; status: string; blockNumber: string; gasUsed: string; timestamp: number }; error?: { name: string; args: string[] } }
let cache: { steps: Map<string, Step>; contracts: Json; fetchedAt: string } | null = null
function evidence() {
  if (cache) return cache
  const m = JSON.parse(readFileSync(new URL('manifest.json', EVIDENCE), 'utf8')) as { steps: Step[]; contracts: Json }
  const r = JSON.parse(readFileSync(new URL('receipts.json', EVIDENCE), 'utf8')) as { fetchedAt: string }
  cache = { steps: new Map(m.steps.map((s) => [s.id, s])), contracts: m.contracts, fetchedAt: r.fetchedAt }
  return cache
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const utc = (unix: number): string => new Date(unix * 1000).toISOString().replace('.000Z', 'Z')
const tx = (id: string) => {
  const s = evidence().steps.get(id)
  if (!s) throw new Error(`the vendored Run 3 manifest has no step ${id}`)
  return { step: id, title: s.title, by: s.actor, from: s.actorAddress, hash: s.tx.hash, block: s.tx.blockNumber, at: utc(s.tx.timestamp), status: s.tx.status, gasUsed: s.tx.gasUsed, ...(s.error ? { error: { name: s.error.name, args: s.error.args } } : {}) }
}

/**
 * The limits each contract enforces, as numbers (server/bounties.test.ts compares them with the vendored Solidity).
 * Sources: MinVarianceVerifier.sol:29-32, 59-152; OptimalityBounty.sol:27, 61-67; MaximalityBounty.sol:21-24, 60-111;
 * TestUSD.sol:25-27.
 */
export const LIMITS = {
  optimality: { scale: '1000000000000000000', minAssets: 2, maxAssets: 16, maxTolerance: '10000000000000000', maxMagnitude: '1000000000000000000000000000' },
  maximality: { maxDebts: 128, minMembers: 2, maxMembers: 64, potentialBound: '18446744073709551616', yBound: '18446744073709551616', maxDebt: '340282366920938463463374607431768211455' },
  token: { symbol: 'tUSD', decimals: 6, pool: '1000000000' },
} as const

/** What each of the two original bounties states, with its record. Nothing in it describes their present state. */
export function originalBounties(): Json[] {
  const c = evidence().contracts
  const last = new Date(evidence().fetchedAt)
  const when = `${last.toISOString().slice(11, 19)} UTC, ${last.getUTCDate()} ${MONTHS[last.getUTCMonth()]} ${last.getUTCFullYear()}`
  const status = `Last recorded ${when}: 1,000 tUSD in the pool and no successful claim; not re-verified since. Reading Sepolia today needs the owner's approval (Q-072).`
  return [
    {
      key: 'optimality', name: 'OptimalityBounty', network: 'Ethereum Sepolia (11155111): a public test network; the token has no value', address: c.optimalityBounty, verifier: c.verifier, token: c.token,
      theorem: 'Theorem 4.4 of the release (docs/ALGORITHMS.md): if MinVarianceVerifier accepts a certificate (w, ν, μ, L) with tolerance τ, then for every feasible portfolio x, ½wᵀΣw − ½xᵀΣx ≤ τ(|ν| + 3 + τ) + ½·n·τ·(2 + τ)².',
      invites: 'A certificate the deployed MinVarianceVerifier accepts, together with a long-only, fully invested portfolio x that beats the certified portfolio by more than that bound. The claimant chooses the problem (n, Σ, τ).',
      test: 'In the contract\'s integers (W = 10¹⁸): F(w) − F(x) > 2·t·W·(|ν| + 3W + t) + n·t·(2W + t)², with F(v) = vᵀΣv and t = τ·W, which is the inequality above multiplied by 2W³. No rounding.',
      limits: [`n from ${LIMITS.optimality.minAssets} to ${LIMITS.optimality.maxAssets} assets`, 'tolerance τ above 0 and at most 1% (10¹⁶ at W = 10¹⁸)', 'every |Σᵢⱼ|, |ν|, |wᵢ|, |μᵢ| and |L| at most 10²⁷ (10⁹ in real units)', 'Σ exactly symmetric with a positive diagonal; w ≥ 0 within τ of a full budget; the stationarity, complementary-slackness and convexity checks within τ', 'x: n weights, each at least 0, summing to exactly 10¹⁸', 'no deadline, no owner, no withdrawal'],
      pays: 'Its whole balance, to the address that sends the first valid claim, in that transaction, with no human involved. A copied pending claim therefore pays the copier, contrary to the release\'s security notes (SECURITY.md lines 218 to 221), which no longer stand for these contracts.',
      funded: { ...tx('B1'), amount: '1000000000', amountText: '1,000.00 tUSD' }, deployed: tx('K5'),
      attempts: ['BA1', 'BA2', 'BA3'].map(tx),
      status,
    },
    {
      key: 'maximality', name: 'MaximalityBounty', network: 'Ethereum Sepolia (11155111): a public test network; the token has no value', address: c.maximalityBounty, token: c.token,
      theorem: 'Weak LP duality for netting (docs/ALGORITHMS.md §9.2): for every circulation x′ with 0 ≤ x′ ≤ d, Σx′ ≤ Σ d·y whenever π_u − π_v + y_e ≥ 1 and y ≥ 0.',
      invites: 'A debt economy, a netting that the clearing house\'s acceptance rule would execute as proven maximal (its own copy of the rule, over calldata), and a strictly larger valid netting of the same debts.',
      test: 'accepts(e, accepted) returns what the certified netting cancels; validNetting(e, larger) must leave every net position unchanged with 0 ≤ x′ ≤ d; the claim pays only if the larger netting cancels strictly more. Integers, no tolerance.',
      limits: [`${LIMITS.maximality.minMembers} to ${LIMITS.maximality.maxMembers} members and 1 to ${LIMITS.maximality.maxDebts} debts`, 'each debt above 0 and below 2¹²⁸, between two different members', '|π| at most 2⁶⁴; 0 ≤ y ≤ 2⁶⁴; x ≤ d for every debt', 'the certified netting must cancel exactly Σ d·y', 'the economy is the claimant\'s; it is not read from the deployed QEDClearing', 'no deadline, no owner, no withdrawal'],
      pays: 'Its whole balance, to the address that sends the first valid claim, in that transaction, with no human involved. A copied pending claim therefore pays the copier.',
      funded: { ...tx('B2'), amount: '1000000000', amountText: '1,000.00 tUSD' }, deployed: tx('K6'),
      attempts: ['BM1', 'BM2'].map(tx),
      status,
    },
  ]
}

// ------------------------------------------------------------------------------------------------ the local board

/** `code` names the next step for the screen (set the vault up, wait for the service); `reason` says it in words. */
const UNAVAILABLE = (code: string, why: string) => ({ available: false, code, reason: why })

/**
 * Everything the bounties page needs: the two originals as recorded, and the local board with this household's claims.
 * The originals never depend on the vault service: when it cannot answer for this household, `local` says why instead.
 */
export async function bountiesView(cfg: RailCfg, db: Db, who: Asker): Promise<Json> {
  const originals = originalBounties()
  const v = vaultOf(db, who.workspaceId)
  let local: Json
  if (!v) local = UNAVAILABLE('vault_not_set_up', 'This household has no on-chain vault yet. Set it up to claim a local bounty: the claim is made by a key of the vault service for this household, and the payout goes into the vault.')
  else {
    try {
      local = { available: true, ...(await must(cfg, 'GET', at(v, '/bounties'))) }
      if (local.status !== 'ready') local = { ...local, available: false, code: `bounties_${String(local.status)}` }
    } catch (e) {
      // not running or starting (503), or a vault the service no longer knows after its data folder was replaced (404)
      if (e instanceof AppError) local = UNAVAILABLE(e.code, e.message)
      else throw e
    }
  }
  return {
    originals,
    local,
    howItPays: 'On this computer\'s chain the two original contracts, unmodified, judge each claim, and a board holds the pool and pays only the claimant who committed first: the claim is committed as a hash that binds the claimant, the recipient, the claim, a secret salt, the bounty, the chain and the board; it is revealed after a short delay and before the commitment expires; an older commitment revealed during the contest takes over; anyone may then settle, and only the recorded recipient is paid. A copied claim or a copied commitment is worth nothing to the copier.',
    scope: 'Local chain only, valueless test tokens. The Sepolia bounties above are records of 19 Oct 2026; nothing here reads, claims or funds them.',
  }
}

function vault(db: Db, who: Asker) {
  const v = vaultOf(db, who.workspaceId)
  if (!v) throw new AppError(409, 'vault_not_set_up', 'This household has no on-chain vault yet. Set it up first.')
  return v
}
const idOf = (raw: string): string => { if (!BOUNTY_ID.test(raw)) throw bad('Name a bounty by its number.'); return raw }
const keyOf = (raw: unknown): string => {
  const k = (raw as Json | null)?.key
  if (typeof k !== 'string' || !KEY.test(k)) throw bad('The request is missing its key.')
  return k
}
const claimOf = (raw: unknown): Json => {
  const c = (raw as Json | null)?.claim
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('Send the claim: { claim: { calldata } } or its fields.', { claim: 'Send the claim.' })
  return c as Json
}

/** Is this claim a refutation? The bounty's judge answers on the local chain; nothing is recorded or sent. */
export async function checkBountyClaim(cfg: RailCfg, db: Db, who: Asker, bountyId: string, raw: unknown): Promise<Json> {
  return must(cfg, 'POST', at(vault(db, who), `/bounties/${idOf(bountyId)}/check`), { claim: claimOf(raw) })
}

/** Commit a claim. A claim the judge rejects is refused with its error, and nothing is recorded. */
export async function submitBountyClaim(cfg: RailCfg, db: Db, who: Asker, bountyId: string, raw: unknown, now: number): Promise<Json> {
  const id = idOf(bountyId), key = keyOf(raw), claim = claimOf(raw)
  const payTo = (raw as Json).payTo
  if (payTo !== undefined && payTo !== 'reserve' && payTo !== 'owner-account') throw bad('Pay to "reserve" (the vault\'s tUSD reserve) or "owner-account".', { payTo: 'Choose where the payout goes.' })
  const accepted = await must(cfg, 'POST', at(vault(db, who), `/bounties/${id}/claims`), { claim, ...(payTo ? { payTo } : {}) }, { 'Idempotency-Key': `ui-${key}` })
  audit(db, now, who.workspaceId, who.personId, 'bounty.claim', id, { jobId: accepted.jobId })
  return accepted
}

/** Reveal a committed claim of this household (also done by the vault service on its own once it may be revealed). */
export async function revealBountyClaim(cfg: RailCfg, db: Db, who: Asker, claimId: string, raw: unknown, now: number): Promise<Json> {
  if (!CLAIM_ID.test(claimId)) throw bad('Name the claim by its id (0x and 64 hexadecimal characters).')
  const accepted = await must(cfg, 'POST', at(vault(db, who), `/bounties/claims/${claimId}/reveal`), {}, { 'Idempotency-Key': `ui-${keyOf(raw)}` })
  audit(db, now, who.workspaceId, who.personId, 'bounty.reveal', claimId, { jobId: accepted.jobId })
  return accepted
}

/** Settle a bounty whose contest has closed. Anyone may; the board pays only the winner's recorded recipient. */
export async function settleBounty(cfg: RailCfg, db: Db, who: Asker, bountyId: string, raw: unknown, now: number): Promise<Json> {
  const id = idOf(bountyId)
  const accepted = await must(cfg, 'POST', at(vault(db, who), `/bounties/${id}/settle`), {}, { 'Idempotency-Key': `ui-${keyOf(raw)}` })
  audit(db, now, who.workspaceId, who.personId, 'bounty.settle', id, { jobId: accepted.jobId })
  return accepted
}
