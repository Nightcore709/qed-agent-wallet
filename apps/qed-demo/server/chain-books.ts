/**
 * The on-chain wallet in the household's books (R13; RISK-084 and F-068). The wallet's double-entry ledger is the system
 * of record for the household's books and the chain is the custodian of record for its test tokens (R7 decision D6).
 *
 * What is booked. Every value movement of the household's wallet that QED submits or observes, as the wallet service reads
 * it from the chain's own logs (GET /workspaces/:id/movements, chain/rail/movements.ts): each Transfer of its two tokens
 * into or out of its treasury vault, reserve vault or owner account, and the escrow's settlement of work it commissioned.
 * One ledger entry per log, balanced in its asset, with the account that says what it was: paid to others, a conversion
 * (the venue's fee apart, see below), held by the escrow, paid for work, money received for work (not decided as income:
 * the owner's question Q-075), received from outside, the faucet's grant, or a move between the wallet's own holders.
 *
 * Test tokens are never money. Each token is an asset of its own, named by its chain and contract
 * (eip155:31337/erc20:<address>), kind 'test_token' in the assets table, never 'INR'. Every figure that adds up rupees
 * names its accounts (bank, card, fund clearing, and so on), and none of those is a chain account
 * (server/test-tokens.test.ts scans for that).
 *
 * When a movement counts. Once its block has two confirmations (the latest block counts as one), the finality rule
 * shared/instrument.ts gives eip155:31337 (R7 decision D6); the co-signer's authority budget counts a settlement after the
 * same two. Anvil mines a block for each transaction, so on a quiet chain the latest movement waits for the next block and
 * is shown meanwhile as in flight. A reorganisation deeper than that, or a chain restored from an older state, must still
 * not leave a wrong entry: the books keep the hash of the last block they booked from, and when the chain holds another
 * block at that height they find the highest booked block still on the chain and reverse every entry above it with a new
 * entry ("reversed: no longer on the chain"), effective when QED found it, and tell the owner. Nothing is deleted. A
 * transfer mined again in another block is then booked again, once: at most one live booking of a log, enforced by the
 * database (chain_movements_live).
 *
 * Exactly once. The entry's reference is the network, transaction hash, log index and block hash; the ledger refuses a
 * second entry with one reference, and the registry refuses a second live booking of a transaction hash and log index.
 * A lease in chain_books keeps one sync per household at a time across the API and the engine; the two guards hold
 * without it.
 *
 * Times. The effective time is the block's timestamp; the entry time is when QED posted it. Entries are posted in block
 * order (block, then log index), so a wallet's entries are in the same order by either time; a reversal is entered, and
 * takes effect, when QED finds its block gone. A history booked late (the backfill) says so on each entry.
 *
 * Reconciliation. The books' balance of each token (the three holders) plus what is on the chain and not yet final must
 * equal the wallet service's balances in /state at the same block. A difference is stored as an error state with its
 * figures (chain_recon, append-only), raised to the owner, recorded by the scheduled reconciliation, and never corrected:
 * nothing is posted to make the books agree. An unanswered service is "unknown", not a difference. A service now on
 * another chain (its data folder was replaced) is a difference, and nothing is booked or reversed against it.
 */
import { fromAmountText } from '../shared/amount-text.ts'
import { tokenBySymbol } from '../shared/chain-assets.ts'
import { canonicalAddress, NETWORKS } from '../shared/instrument.ts'
import { consumeApproval, createApproval, getApproval } from './approvals.ts'
import { AppError, audit, type Db, j, newId, parse } from './core.ts'
import { sha256hex } from './receipts.ts'
import { canonical } from '../shared/sha256.ts'
import { notice, resolveNotices } from './execute.ts'
import { type AccountKind, balance, ensureAccount, listEntries, post } from './ledger.ts'
import { at, rail, type RailCfg, type VaultRecord, vaultOf } from './rail.ts'

export const CHAIN_NETWORK = 'eip155:31337'
const FINALITY = NETWORKS.find((n) => n.id === CHAIN_NETWORK)!.finality
/** Confirmations a movement needs before it is booked (the latest block counts as one). */
export const CHAIN_DEPTH = FINALITY.kind === 'confirmations' ? FINALITY.depth : 2
/** How every place that shows a test token labels it. */
export const TEST_TOKEN_WORDS = 'valueless test tokens on a local chain'
/** "test rupees", "test yen", "test dinars": each test token's words (shared/chain-assets.ts, S5: the eight currencies' tokens and tETH). */
const wordsOf = (symbol: string): string => tokenBySymbol(symbol)?.many ?? `${symbol} test tokens`
const LEASE_MS = 120_000
const LATE_MS = 10 * 60_000

type Role = 'treasury' | 'reserve' | 'owner-account'
export interface Movement {
  txHash: string; logIndex: number; blockNumber: string; blockHash: string; blockTimestamp: number; confirmations: number
  kind: 'transfer' | 'escrow-settled'; token: string; symbol: string; decimals: number; amount: string
  from: string; to: string; fromRole: Role | null; toRole: Role | null
  counterparty: { address: string; kind: string; label: string | null }
  jobId: string | null
  escrow: { jobId: string; event: 'opened' | 'settled' | 'refunded'; role: 'client' | 'provider' } | null
  conversion: { hops: { tokenIn: string; tokenOut: string; feeBps: number; amountIn: string; amountOut: string; reserveInBefore: string; reserveOutBefore: string; label?: string }[]; spent: string | null; amountOut: string | null; tokenOut: string | null } | null
}
interface Movements {
  network: string; genesisId: string | null; head: { number: string; hash: string; timestamp: number }; range: { from: string; to: string; complete: boolean }
  tokens: { symbol: string; address: string; decimals: number }[]; movements: Movement[]; canonical: Record<string, string | null>
}
export interface SyncOutcome { state: 'synced' | 'no-vault' | 'busy' | 'unreachable' | 'chain-replaced'; posted: number; reversed: number; pending: { txHash: string; logIndex: number; confirmations: number }[]; why: string | null }
export interface AssetFigures { asset: string; symbol: string; decimals: number; words: string; books: string; inFlight: string; chain: string | null; difference: string | null }
export interface Comparison { state: 'agrees' | 'disagrees' | 'unknown'; at: number; block: number | null; assets: AssetFigures[]; why: string | null }

class Unreachable extends Error {}
async function railJson(cfg: RailCfg, v: VaultRecord, path: string): Promise<Record<string, unknown>> {
  let r: { status: number; json: Record<string, unknown> }
  try { r = await rail(cfg, 'GET', at(v, path)) } catch (e) { throw new Unreachable(e instanceof Error ? e.message : String(e)) }
  if (r.status !== 200) throw new Unreachable(String((r.json.error as { message?: string } | undefined)?.message ?? `the wallet service answered ${r.status}`))
  return r.json
}
const readMovements = async (cfg: RailCfg, v: VaultRecord, q: { fromBlock?: number; toBlock?: number; blocks?: number[] }): Promise<Movements> => {
  const s = new URLSearchParams()
  if (q.fromBlock !== undefined) s.set('fromBlock', String(Math.max(0, q.fromBlock)))
  if (q.toBlock !== undefined) s.set('toBlock', String(q.toBlock))
  if (q.blocks?.length) s.set('blocks', q.blocks.join(','))
  return (await railJson(cfg, v, `/movements${s.size ? `?${s}` : ''}`)) as unknown as Movements
}

// ------------------------------------------------------------------------------------------------ assets and accounts

/** The token's own asset: registered once, named as a test token, never rupees. Returns its id. */
function tokenAsset(db: Db, t: { symbol: string; address: string; decimals: number }): string {
  const id = `${CHAIN_NETWORK}/erc20:${canonicalAddress(t.address)}`
  db.run('INSERT OR IGNORE INTO assets (id, kind, name, scale) VALUES (?, ?, ?, ?)', id, 'test_token', `${t.symbol} (${wordsOf(t.symbol)}) on the local Anvil chain 31337: a test token with no value`, t.decimals)
  return id
}
type Place = 'treasury' | 'reserve' | 'owner' | 'grant' | 'conversion' | 'fee' | 'paid' | 'escrow' | 'work-paid' | 'work-received' | 'received' | 'closed'
const PLACES: Record<Place, { kind: AccountKind; name: string; meta?: Record<string, unknown> }> = {
  treasury: { kind: 'asset', name: 'On-chain wallet: treasury vault' },
  reserve: { kind: 'asset', name: 'On-chain wallet: reserve vault' },
  owner: { kind: 'asset', name: 'On-chain wallet: its own account' },
  grant: { kind: 'equity', name: 'Granted by the local chain\'s faucet' },
  conversion: { kind: 'trading', name: 'Conversions on the chain' },
  fee: { kind: 'expense', name: 'Venue fees on conversions on the chain' },
  paid: { kind: 'expense', name: 'Paid from the on-chain wallet to others' },
  escrow: { kind: 'asset', name: 'Held by the escrow for work you commissioned' },
  'work-paid': { kind: 'expense', name: 'Paid for work through the escrow' },
  // Not 'income': whether money received for work counts as income (the split instruction, Home's figures) is Q-075.
  'work-received': { kind: 'clearing', name: 'Money received for work through the escrow (whether it is income is an open question for you, Q-075)', meta: { classification: 'undecided', question: 'Q-075' } },
  received: { kind: 'clearing', name: 'Received from outside the wallet, not classified' },
  // closing the books of a chain the wallet service no longer runs (closeReplacedChain): what they held there, closed
  closed: { kind: 'equity', name: 'Closed: held on a chain the wallet service no longer runs (closed on your approval)' },
}
const HOLDER: Record<Role, Place> = { treasury: 'treasury', reserve: 'reserve', 'owner-account': 'owner' }
const code = (place: Place, asset: string): string => `chain:${place}:${asset}`
function open(db: Db, userId: string, place: Place, asset: string, symbol: string): string {
  const p = PLACES[place]
  ensureAccount(db, userId, code(place, asset), p.kind, asset, `${p.name} (${wordsOf(symbol)}; ${TEST_TOKEN_WORDS})`, false, { ...p.meta, symbol, network: CHAIN_NETWORK, test: TEST_TOKEN_WORDS })
  return code(place, asset)
}

// ------------------------------------------------------------------------------------------------ what each movement is

const lower = (s: string) => s.toLowerCase()
const floorDiv = (n: bigint, d: bigint): bigint => (n >= 0n ? n / d : -((-n + d - 1n) / d))
/**
 * The conversion's fee and spread, from the pool hops the chain gives: the fee is the pool's own (feeBps of what went in,
 * charged in the input token), rounded down to the token's smallest unit; the spread is what the net input was worth at
 * the pool's price just before the trade, less what came out, in the output token, rounded down. Without hops the two
 * cannot be told apart from the rate.
 */
function conversionCosts(db: Db, m: Movement): Record<string, unknown> {
  const hops = m.conversion?.hops ?? []
  if (!hops.length) return { fee: null, spread: [], inseparable: 'The chain gives no pool records for this conversion, so its venue fee and its spread cannot be separated: both are inside the rate it got.' }
  const asset = (address: string) => db.get<{ id: string }>(`SELECT id FROM assets WHERE id = ?`, `${CHAIN_NETWORK}/erc20:${canonicalAddress(address)}`)?.id ?? `${CHAIN_NETWORK}/erc20:${canonicalAddress(address)}`
  let fee = 0n
  const spread = new Map<string, bigint>(), otherFees: Record<string, unknown>[] = []
  for (const h of hops) {
    const f = BigInt(h.feeBps), input = BigInt(h.amountIn), out = BigInt(h.amountOut), rIn = BigInt(h.reserveInBefore), rOut = BigInt(h.reserveOutBefore)
    if (lower(h.tokenIn) === lower(m.token)) fee += (input * f) / 10_000n
    else otherFees.push({ asset: asset(h.tokenIn), amount: ((input * f) / 10_000n).toString(), note: 'in a token the wallet does not hold; not booked' })
    if (rIn > 0n) spread.set(asset(h.tokenOut), (spread.get(asset(h.tokenOut)) ?? 0n) + floorDiv(input * (10_000n - f) * rOut - out * rIn * 10_000n, rIn * 10_000n))
  }
  return {
    fee: { asset: asset(m.token), amount: fee.toString(), rounding: 'down', from: 'each pool\'s own fee, read from the chain' },
    spread: [...spread].map(([a, s]) => ({ asset: a, amount: s.toString(), rounding: 'down', against: 'the pool\'s own price just before the trade' })),
    ...(otherFees.length ? { otherFees } : {}), hops,
  }
}

interface Booking { kind: string; memo: string; lines: { account: string; amount: bigint }[]; extra?: Record<string, unknown> }
/** The entry for one movement, in the household's own words. */
function booking(db: Db, userId: string, m: Movement, asset: string, firstOut: boolean): Booking {
  const x = BigInt(m.amount)
  const acc = (p: Place) => open(db, userId, p, asset, m.symbol)
  const w = wordsOf(m.symbol)
  const job = m.escrow ? `escrow job #${m.escrow.jobId}` : 'an escrow job'
  if (m.kind === 'escrow-settled') return { kind: 'chain-escrow-settled', memo: `Paid for work you commissioned: ${job} settled`, lines: [{ account: acc('work-paid'), amount: x }, { account: acc('escrow'), amount: -x }] }
  const into = m.toRole ? acc(HOLDER[m.toRole]) : null, outOf = m.fromRole ? acc(HOLDER[m.fromRole]) : null
  if (into && outOf) return { kind: 'chain-own-transfer', memo: `Moved within the on-chain wallet: from its ${PLACE_WORDS[m.fromRole!]} to its ${PLACE_WORDS[m.toRole!]}`, lines: [{ account: into, amount: x }, { account: outOf, amount: -x }] }
  const cp = m.counterparty
  if (into) {
    if (cp.kind === 'faucet') return { kind: 'chain-grant', memo: 'Opening grant from the local chain\'s faucet', lines: [{ account: into, amount: x }, { account: acc('grant'), amount: -x }] }
    if (cp.kind === 'conversion') return { kind: 'chain-conversion-in', memo: lower(m.conversion?.tokenOut ?? '') === lower(m.token) ? `Conversion: ${w} received` : `Conversion: unspent ${w} back`, lines: [{ account: into, amount: x }, { account: acc('conversion'), amount: -x }] }
    if (cp.kind === 'escrow' && m.escrow?.event === 'settled') return { kind: 'chain-escrow-earning', memo: `Received for work: ${job}`, lines: [{ account: into, amount: x }, { account: acc('work-received'), amount: -x }] }
    if (cp.kind === 'escrow' && m.escrow?.event === 'refunded') return { kind: 'chain-escrow-refund', memo: `Refunded to you: ${job}`, lines: [{ account: into, amount: x }, { account: acc('escrow'), amount: -x }] }
    return { kind: 'chain-receipt', memo: cp.kind === 'workspace' ? 'Received from another wallet on this computer' : 'Received from outside the wallet', lines: [{ account: into, amount: x }, { account: acc('received'), amount: -x }] }
  }
  if (cp.kind === 'conversion') {
    const costs = firstOut ? conversionCosts(db, m) : { fee: null, spread: [], note: 'This conversion\'s fee and spread are on its first leg.' }
    const fee = (costs.fee as { amount: string } | null) ? BigInt((costs.fee as { amount: string }).amount) : 0n
    return { kind: 'chain-conversion-out', memo: `Conversion: ${w} paid in`, lines: [{ account: outOf!, amount: -x }, ...(fee > 0n ? [{ account: acc('fee'), amount: fee }] : []), { account: acc('conversion'), amount: x - fee }], extra: { conversion: costs } }
  }
  if (cp.kind === 'escrow' && m.escrow?.event === 'opened') return { kind: 'chain-escrow-fund', memo: `Funded ${job} for work you commissioned`, lines: [{ account: acc('escrow'), amount: x }, { account: outOf!, amount: -x }] }
  return { kind: 'chain-payment', memo: `Paid ${cp.label ?? (cp.kind === 'workspace' ? 'another wallet on this computer' : 'an address outside the wallet')}`, lines: [{ account: acc('paid'), amount: x }, { account: outOf!, amount: -x }] }
}
const PLACE_WORDS: Record<Role, string> = { treasury: 'treasury vault', reserve: 'reserve vault', 'owner-account': 'own account' }
/** The movement's effect on what the wallet's holders hold of its token. */
const holderEffect = (m: Movement): bigint => (m.kind !== 'transfer' || (m.fromRole && m.toRole) ? 0n : m.toRole ? BigInt(m.amount) : m.fromRole ? -BigInt(m.amount) : 0n)

/**
 * Book one final movement, once. Skipped when this log in this block is already booked (live or reversed), or when the
 * log is booked live from another block (the reorganisation check reverses that first). Returns whether it was booked.
 */
function bookOne(db: Db, userId: string, m: Movement, firstOut: boolean, now: number, source: 'sync' | 'backfill'): boolean {
  const tx = lower(m.txHash), bh = lower(m.blockHash)
  return db.tx(() => {
    if (db.get('SELECT 1 x FROM chain_movements WHERE user_id = ? AND network = ? AND tx_hash = ? AND log_index = ? AND (block_hash = ? OR reversed_at IS NULL)', userId, CHAIN_NETWORK, tx, m.logIndex, bh)) return false
    const asset = tokenAsset(db, { symbol: m.symbol, address: m.token, decimals: m.decimals })
    const b = booking(db, userId, m, asset, firstOut)
    const effective = m.blockTimestamp * 1000
    const ref = `chain:${CHAIN_NETWORK}:${tx}:${m.logIndex}@${bh}`
    const e = post(db, {
      userId, ts: now, effectiveTs: effective, kind: b.kind, ref, memo: b.memo, lines: b.lines,
      meta: { network: CHAIN_NETWORK, txHash: tx, logIndex: m.logIndex, blockNumber: m.blockNumber, blockHash: bh, blockTimestamp: m.blockTimestamp, token: m.token, symbol: m.symbol, decimals: m.decimals, amount: m.amount, from: m.from, to: m.to, counterparty: m.counterparty, jobId: m.jobId, escrow: m.escrow, source, recordedLate: source === 'backfill' || now - effective > LATE_MS, test: TEST_TOKEN_WORDS, ...b.extra },
    })
    if (e.duplicate) return false
    db.run('INSERT INTO chain_movements (user_id, network, tx_hash, log_index, block_number, block_hash, block_ts, kind, asset_id, amount_text, entry_id, posted_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      userId, CHAIN_NETWORK, tx, m.logIndex, Number(m.blockNumber), bh, effective, b.kind, asset, m.amount, e.id, now, source)
    return true
  })
}

/** Reverse every live booking from a block above `keepUpTo`: those blocks are no longer on the chain. */
function reverseAbove(db: Db, userId: string, keepUpTo: number, now: number): number {
  const gone = db.all<{ id: number; entry_id: string; tx_hash: string; log_index: number; block_number: number }>('SELECT id, entry_id, tx_hash, log_index, block_number FROM chain_movements WHERE user_id = ? AND network = ? AND reversed_at IS NULL AND block_number > ? ORDER BY block_number DESC, log_index DESC', userId, CHAIN_NETWORK, keepUpTo)
  for (const g of gone) {
    db.tx(() => {
      const orig = db.get<{ ref: string; memo: string }>('SELECT ref, memo FROM entries WHERE id = ?', g.entry_id)!
      const lines = db.all<{ code: string; t: string }>('SELECT a.code, p.amount_text t FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = ?', g.entry_id).map((l) => ({ account: l.code, amount: -fromAmountText(l.t, `a line of ${orig.ref}`) }))
      const r = post(db, { userId, ts: now, effectiveTs: now, kind: 'chain-reversal', ref: `reversal:${orig.ref}`, memo: `Reversed: block ${g.block_number} is no longer on the chain (${orig.memo})`, lines, meta: { reverses: orig.ref, txHash: g.tx_hash, logIndex: g.log_index, blockNumber: String(g.block_number), test: TEST_TOKEN_WORDS } })
      db.run('UPDATE chain_movements SET reversed_at = ?, reversal_entry_id = ? WHERE id = ?', now, r.id, g.id)
      notice(db, userId, { level: 'warning', kind: 'chain-reorganised', title: 'A movement on your on-chain wallet is no longer on the chain', body: `Block ${g.block_number} was replaced on the local chain, so “${orig.memo}” no longer happened there. Your books reverse it with a new entry; nothing was deleted. If the chain holds it again in another block, it is entered again once. These are ${TEST_TOKEN_WORDS}.`, subject: g.entry_id, dedupe: `chain-reorg:${g.tx_hash}:${g.log_index}` }, now)
    })
  }
  return gone.length
}

// ------------------------------------------------------------------------------------------------ syncing

interface BooksRow { cursor_block: number; cursor_hash: string | null; genesis_id: string | null; backfill: string | null }
const row = (db: Db, userId: string): BooksRow | undefined => db.get<BooksRow>('SELECT cursor_block, cursor_hash, genesis_id, backfill FROM chain_books WHERE user_id = ? AND network = ?', userId, CHAIN_NETWORK)

/**
 * Book the household's wallet's final movements that are not yet booked, after checking that the block the books last
 * booked from is still on the chain. One at a time per household (a lease); each booking is its own transaction.
 */
export async function syncChainBooks(cfg: RailCfg, db: Db, userId: string, now: number): Promise<SyncOutcome> {
  const none = (state: SyncOutcome['state'], why: string | null = null): SyncOutcome => ({ state, posted: 0, reversed: 0, pending: [], why })
  const v = vaultOf(db, userId)
  if (!v) return none('no-vault')
  db.run('INSERT OR IGNORE INTO chain_books (user_id, network, rail_workspace) VALUES (?, ?, ?)', userId, CHAIN_NETWORK, v.railId)
  const me = newId('lease', now)
  if (db.run('UPDATE chain_books SET lease_until = ?, lease_owner = ? WHERE user_id = ? AND network = ? AND lease_until <= ?', now + LEASE_MS, me, userId, CHAIN_NETWORK, now).changes === 0) return none('busy', 'Another sync of this wallet is running.')
  try {
    let st = row(db, userId)!
    let reversed = 0
    let ans: Movements
    try { ans = await readMovements(cfg, v, { fromBlock: st.cursor_block + 1, blocks: st.cursor_block >= 0 ? [st.cursor_block] : [] }) } catch (e) { if (e instanceof Unreachable) return none('unreachable', `The wallet service did not answer: ${e.message}`); throw e }
    if (st.genesis_id && ans.genesisId !== st.genesis_id) return none('chain-replaced', `The wallet service now runs a different chain (its data folder was replaced): the books were kept against ${st.genesis_id}, the service answers for ${String(ans.genesisId)}. Nothing is entered or reversed against it.`)
    if (!st.genesis_id) db.run('UPDATE chain_books SET genesis_id = ? WHERE user_id = ? AND network = ?', ans.genesisId, userId, CHAIN_NETWORK)
    // the last block booked from is no longer the chain's: find the highest booked block still on it, reverse what is above
    if (st.cursor_block >= 0 && lower(ans.canonical[String(st.cursor_block)] ?? '') !== lower(st.cursor_hash ?? '')) {
      const live = db.all<{ b: number; h: string }>('SELECT DISTINCT block_number b, block_hash h FROM chain_movements WHERE user_id = ? AND network = ? AND reversed_at IS NULL ORDER BY block_number DESC', userId, CHAIN_NETWORK)
      let keep = -1, keepHash: string | null = null
      for (let i = 0; i < live.length && keep < 0; i += 64) {
        const part = live.slice(i, i + 64)
        const c = (await readMovements(cfg, v, { fromBlock: Number(ans.head.number) + 1, blocks: part.map((x) => x.b) })).canonical
        const hit = part.find((x) => lower(c[String(x.b)] ?? '') === lower(x.h))
        if (hit) { keep = hit.b; keepHash = hit.h }
      }
      reversed = reverseAbove(db, userId, keep, now)
      db.run('UPDATE chain_books SET cursor_block = ?, cursor_hash = ? WHERE user_id = ? AND network = ?', keep, keepHash, userId, CHAIN_NETWORK)
      st = row(db, userId)!
      ans = await readMovements(cfg, v, { fromBlock: st.cursor_block + 1 })
    }
    const source = st.backfill === 'needed' ? 'backfill' : 'sync'
    let posted = 0, cursor = st.cursor_block, cursorHash = st.cursor_hash
    const pending: SyncOutcome['pending'] = []
    const firstOut = new Set<string>()
    for (const m of ans.movements) {
      if (m.confirmations < CHAIN_DEPTH) { pending.push({ txHash: lower(m.txHash), logIndex: m.logIndex, confirmations: m.confirmations }); continue }
      const leg = `${lower(m.txHash)}:${lower(m.token)}`
      const first = m.fromRole !== null && m.toRole === null && m.counterparty.kind === 'conversion' && !firstOut.has(leg)
      if (first) firstOut.add(leg)
      if (bookOne(db, userId, m, first, now, source)) posted++
      if (Number(m.blockNumber) > cursor) { cursor = Number(m.blockNumber); cursorHash = lower(m.blockHash) }
    }
    db.tx(() => {
      db.run('UPDATE chain_books SET cursor_block = ?, cursor_hash = ?, synced_at = ? WHERE user_id = ? AND network = ? AND cursor_block <= ?', cursor, cursorHash, now, userId, CHAIN_NETWORK, cursor)
      if (source === 'backfill' && ans.range.complete) {
        db.run(`UPDATE chain_books SET backfill = 'done', backfill_at = ? WHERE user_id = ? AND network = ?`, now, userId, CHAIN_NETWORK)
        audit(db, now, userId, 'system', 'chain-books.backfill', v.railId, { posted, through: cursor, pending: pending.length, from: 'the wallet service\'s own records (GET /movements)' })
      }
    })
    return { state: 'synced', posted, reversed, pending, why: null }
  } finally {
    db.run('UPDATE chain_books SET lease_until = 0, lease_owner = NULL WHERE user_id = ? AND network = ? AND lease_owner = ?', userId, CHAIN_NETWORK, me)
  }
}

// ------------------------------------------------------------------------------------------------ reconciling

/** The books' balance of each token the wallet has accounts in: its three holders together. */
function booksByAsset(db: Db, userId: string): Map<string, { symbol: string; decimals: number; books: bigint }> {
  const out = new Map<string, { symbol: string; decimals: number; books: bigint }>()
  for (const a of db.all<{ code: string; asset_id: string; meta_json: string; scale: number }>(`SELECT a.code, a.asset_id, a.meta_json, s.scale FROM accounts a JOIN assets s ON s.id = a.asset_id WHERE a.user_id = ? AND (a.code LIKE 'chain:treasury:%' OR a.code LIKE 'chain:reserve:%' OR a.code LIKE 'chain:owner:%') ORDER BY a.asset_id`, userId)) {
    const symbol = String(parse<{ symbol?: string }>(a.meta_json, {}).symbol ?? '')
    const have = out.get(a.asset_id) ?? { symbol, decimals: a.scale, books: 0n }
    have.books += balance(db, userId, a.code)
    out.set(a.asset_id, have)
  }
  return out
}

/** "1,496.50 test rupees": a token amount in its own decimals and words, never with a currency sign. */
export function tokenText(raw: bigint, decimals: number, symbol: string): string {
  const neg = raw < 0n, s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0')
  const int = decimals ? s.slice(0, -decimals) : s, frac = decimals ? `.${s.slice(-decimals)}` : ''
  return `${neg ? '−' : ''}${BigInt(int).toLocaleString(symbol === 'tINR' ? 'en-IN' : 'en-US')}${frac} ${wordsOf(symbol)}`
}
/** The disagreement in one sentence, with its figures. */
export function disagreementText(c: Comparison): string {
  const parts = c.assets.filter((a) => a.difference !== '0').map((a) => a.chain === null ? `${wordsOf(a.symbol)}: the books hold ${tokenText(BigInt(a.books), a.decimals, a.symbol)}; the chain's balance is not known` : `${wordsOf(a.symbol)}: the books hold ${tokenText(BigInt(a.books), a.decimals, a.symbol)} with ${tokenText(BigInt(a.inFlight), a.decimals, a.symbol)} in flight, the chain ${tokenText(BigInt(a.chain), a.decimals, a.symbol)} (a difference of ${tokenText(BigInt(a.difference ?? '0'), a.decimals, a.symbol)})`)
  return `Your books and your on-chain wallet disagree${c.why ? `: ${c.why}` : ''}${parts.length ? `${c.why ? ' ' : ': '}${parts.join('; ')}` : ''}. These are ${TEST_TOKEN_WORDS}; nothing was corrected.`
}

function store(db: Db, userId: string, c: Comparison): void {
  db.tx(() => {
    const last = db.get<{ state: string; figures_json: string; why: string | null }>('SELECT state, figures_json, why FROM chain_recon WHERE user_id = ? AND network = ? ORDER BY ts DESC, rowid DESC LIMIT 1', userId, CHAIN_NETWORK)
    if (!last || last.state !== c.state || last.figures_json !== j(c.assets) || (last.why ?? null) !== c.why) {
      db.run('INSERT INTO chain_recon (id, user_id, network, ts, state, block_number, figures_json, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('crc', c.at), userId, CHAIN_NETWORK, c.at, c.state, c.block, j(c.assets), c.why)
    }
    db.run('UPDATE chain_books SET compared_at = ?, compare_state = ?, compare_json = ? WHERE user_id = ? AND network = ?', c.at, c.state, j(c), userId, CHAIN_NETWORK)
    if (c.state === 'disagrees') notice(db, userId, { level: 'action', kind: 'chain-books-disagree', title: 'Your books and your on-chain wallet disagree', body: `${disagreementText(c)} Look at the on-chain wallet's records before relying on either figure.`, dedupe: `chain-books:${userId}`, rolling: true }, c.at)
    else if (c.state === 'agrees') resolveNotices(db, userId, `chain-books:${userId}`, c.at)
  })
}

/**
 * Sync, then compare the books with the wallet service's balances (/state) at the same block. The result is stored
 * (chain_recon keeps every change) and a disagreement is raised; nothing is ever posted to make them agree.
 */
export async function compareChainBooks(cfg: RailCfg, db: Db, userId: string, now: number): Promise<Comparison> {
  const v = vaultOf(db, userId)
  const books = () => [...booksByAsset(db, userId)].map(([asset, b]): AssetFigures => ({ asset, symbol: b.symbol, decimals: b.decimals, words: wordsOf(b.symbol), books: b.books.toString(), inFlight: '0', chain: null, difference: null }))
  if (!v) return { state: 'unknown', at: now, block: null, assets: [], why: 'This household has no on-chain wallet.' }
  const s = await syncChainBooks(cfg, db, userId, now)
  if (s.state === 'busy') return lastChainComparison(db, userId) ?? { state: 'unknown', at: now, block: null, assets: books(), why: s.why }
  const finish = (c: Comparison): Comparison => { store(db, userId, c); return c }
  if (s.state === 'unreachable') return finish({ state: 'unknown', at: now, block: null, assets: books(), why: s.why })
  if (s.state === 'chain-replaced') return finish({ state: 'disagrees', at: now, block: null, assets: books(), why: s.why })
  for (let attempt = 0; ; attempt++) {
    let st: Record<string, unknown>, mv: Movements
    try {
      st = await railJson(cfg, v, '/state')
      const block = Number((st.network as { block?: string } | undefined)?.block ?? NaN)
      mv = await readMovements(cfg, v, { fromBlock: Math.max(0, row(db, userId)!.cursor_block + 1), toBlock: block })
    } catch (e) { if (e instanceof Unreachable) return finish({ state: 'unknown', at: now, block: null, assets: books(), why: `The wallet service did not answer: ${e.message}` }); throw e }
    const block = Number((st.network as { block?: string }).block)
    const contracts = (st.contracts ?? {}) as { asset?: string; reserveAsset?: string }
    const chainOf = (address: string): bigint | null => {
      const a = lower(address)
      const tre = (st.treasury ?? {}) as { balance?: string }, res = (st.reserve ?? {}) as { balance?: string }, own = (st.ownerHolds ?? {}) as { asset?: string; reserveAsset?: string }
      if (contracts.asset && a === lower(contracts.asset)) return BigInt(tre.balance ?? '0') + BigInt(own.asset ?? '0')
      if (contracts.reserveAsset && a === lower(contracts.reserveAsset)) return BigInt(res.balance ?? '0') + BigInt(own.reserveAsset ?? '0')
      return null
    }
    const have = booksByAsset(db, userId)
    for (const t of mv.tokens) { const id = tokenAsset(db, t); if (!have.has(id)) have.set(id, { symbol: t.symbol, decimals: t.decimals, books: 0n }) }
    const assets: AssetFigures[] = [...have].sort(([a], [b]) => (have.get(a)!.symbol < have.get(b)!.symbol ? -1 : 1)).map(([asset, b]) => {
      const token = mv.tokens.find((t) => `${CHAIN_NETWORK}/erc20:${canonicalAddress(t.address)}` === asset)
      // in flight: on the chain up to the compared block and not booked
      const inFlight = mv.movements.filter((m) => lower(m.token) === lower(token?.address ?? '') && !db.get('SELECT 1 x FROM chain_movements WHERE user_id = ? AND network = ? AND tx_hash = ? AND log_index = ? AND block_hash = ? AND reversed_at IS NULL', userId, CHAIN_NETWORK, lower(m.txHash), m.logIndex, lower(m.blockHash))).reduce((t, m) => t + holderEffect(m), 0n)
      const chain = token ? chainOf(token.address) : null
      return { asset, symbol: b.symbol, decimals: b.decimals, words: wordsOf(b.symbol), books: b.books.toString(), inFlight: inFlight.toString(), chain: chain === null ? null : chain.toString(), difference: chain === null ? null : (chain - b.books - inFlight).toString() }
    })
    const agrees = assets.every((a) => a.difference === '0' || (a.chain === null && a.books === '0'))
    // the service read its balances a moment after the block it named: asked once more before a difference is stored
    if (!agrees && attempt === 0) continue
    return finish({ state: agrees ? 'agrees' : 'disagrees', at: now, block, assets, why: null })
  }
}

export function lastChainComparison(db: Db, userId: string): Comparison | null {
  const r = db.get<{ compare_json: string | null }>('SELECT compare_json FROM chain_books WHERE user_id = ? AND network = ?', userId, CHAIN_NETWORK)
  return r?.compare_json ? parse<Comparison | null>(r.compare_json, null) : null
}

/** Every household with a vault: synced and compared. The engine runs it on the reconciliation's cadence. */
export async function chainBooksSchedule(cfg: RailCfg, db: Db, now: number): Promise<string> {
  const ids = db.all<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'vault.workspace:%' ORDER BY key`).map((r) => r.key.slice('vault.workspace:'.length))
  const states: string[] = []
  for (const id of ids) {
    if (!db.get('SELECT 1 x FROM users WHERE id = ?', id)) continue
    states.push((await compareChainBooks(cfg, db, id, now).catch(() => ({ state: 'unknown' }))).state)
  }
  return `${states.length} wallet${states.length === 1 ? '' : 's'} compared: ${['agrees', 'disagrees', 'unknown'].map((s) => `${states.filter((x) => x === s).length} ${s}`).join(', ')}`
}

// ------------------------------------------------------------------------------------------------ what the screens read

export const CHAIN_ORDERING = 'Listed in the order QED entered them in your books. QED enters a wallet\'s movements in the order the chain made them (block, then position in the block), after the block has two confirmations, so the order by when each took effect is the same; a reversal of a block that is no longer on the chain is entered, and takes effect, when QED finds it.'
export const CHAIN_RULE = `A movement on the chain enters your books once its block has ${CHAIN_DEPTH} confirmations (R7 decision D6). Until then it is shown as in flight.`

export interface ChainEntryLine { code: string; name: string; asset: string; symbol: string; decimals: number; words: string; amount_text: string; holder: boolean }
export interface ChainEntryView {
  seq: number; entryTs: number; effectiveTs: number; kind: string; memo: string; txHash: unknown; logIndex: unknown; blockNumber: unknown; blockTimestamp: unknown
  jobId: unknown; escrow: unknown; counterparty: unknown; recordedLate: boolean; conversion: unknown; reverses: unknown; lines: ChainEntryLine[]
}
export interface ChainBooksView {
  network: string; words: string; ordering: string; rule: string; now: number
  assets: { asset: string; symbol: string; decimals: number; words: string; books: string; label: string }[]
  entries: ChainEntryView[]; comparison: Comparison | null
  disagreements: { ts: number; block: number | null; assets: unknown; why: string | null }[]
  books: { backfill: string | null; backfillAt: number | null; syncedAt: number | null; cursorBlock: number } | null
}
/** The on-chain wallet as the books hold it: each token's balance, each entry with both times, and the last comparison. */
export function chainBooksView(db: Db, userId: string, now: number, limit = 200): ChainBooksView {
  const assets = [...booksByAsset(db, userId)].sort(([, a], [, b]) => (a.symbol < b.symbol ? -1 : 1)).map(([asset, b]) => ({ asset, symbol: b.symbol, decimals: b.decimals, words: wordsOf(b.symbol), books: b.books.toString(), label: TEST_TOKEN_WORDS }))
  const entries = listEntries(db, userId, { limit: 500 }).filter((e) => e.kind.startsWith('chain-')).slice(0, limit).reverse().map((e) => {
    const m = e.meta as Record<string, unknown>
    return {
      seq: e.seq, entryTs: e.ts, effectiveTs: e.effective_ts, kind: e.kind, memo: e.memo, txHash: m.txHash ?? null, logIndex: m.logIndex ?? null, blockNumber: m.blockNumber ?? null, blockTimestamp: m.blockTimestamp ?? null,
      jobId: m.jobId ?? null, escrow: m.escrow ?? null, counterparty: m.counterparty ?? null, recordedLate: m.recordedLate === true, conversion: m.conversion ?? null, reverses: m.reverses ?? null,
      lines: e.lines.map((l) => { const a = db.get<{ meta_json: string; scale: number }>('SELECT a.meta_json, s.scale FROM accounts a JOIN assets s ON s.id = a.asset_id WHERE a.user_id = ? AND a.code = ?', userId, l.code); const symbol = String(parse<{ symbol?: string }>(a?.meta_json, {}).symbol ?? ''); return { code: l.code, name: l.name, asset: l.asset, symbol, decimals: a?.scale ?? 0, words: wordsOf(symbol), amount_text: l.amount_text, holder: /^chain:(treasury|reserve|owner):/.test(l.code) } }),
    }
  })
  const b = db.get<{ backfill: string | null; backfill_at: number | null; synced_at: number | null; cursor_block: number }>('SELECT backfill, backfill_at, synced_at, cursor_block FROM chain_books WHERE user_id = ? AND network = ?', userId, CHAIN_NETWORK)
  return {
    network: CHAIN_NETWORK, words: TEST_TOKEN_WORDS, ordering: CHAIN_ORDERING, rule: CHAIN_RULE, now, assets, entries,
    comparison: lastChainComparison(db, userId),
    disagreements: db.all<{ ts: number; state: string; block_number: number | null; figures_json: string; why: string | null }>(`SELECT ts, state, block_number, figures_json, why FROM chain_recon WHERE user_id = ? AND network = ? AND state = 'disagrees' ORDER BY ts DESC LIMIT 20`, userId, CHAIN_NETWORK).map((r) => ({ ts: r.ts, block: r.block_number, assets: parse(r.figures_json, []), why: r.why })),
    books: b ? { backfill: b.backfill, backfillAt: b.backfill_at, syncedAt: b.synced_at, cursorBlock: b.cursor_block } : null,
  }
}

// ------------------------------------------------------------------------------------------------ closing a replaced chain

/**
 * A wallet service whose data folder was replaced runs another chain (another genesis). The books keep what they booked
 * from the old one, the comparison then disagrees for good, and nothing is booked or reversed against the new chain
 * (syncChainBooks). Closing ends that, on the owner's approval only, never automatically:
 *   - one ledger entry takes each holder account's balance of the old chain to an equity account named for what it is
 *     ("closed: held on a chain the wallet service no longer runs"), balanced in each token; nothing is deleted;
 *   - the old chain's live bookings leave the live set (marked with the closing entry), so that the new chain's
 *     movements, which can carry the same transaction hashes on a fresh local chain, are booked once each;
 *   - the books are then kept against the new chain, from its first block, booked as a late history (backfill);
 *   - the closing is recorded (chain_closings, append-only) with the preview the owner approved by passkey, and audited.
 * The preview binds the approval: if anything in it changed (a booking, a balance, the chain the service answers for),
 * the approval no longer matches and nothing is done.
 */
export interface ClosingPreview {
  network: string; oldGenesis: string; newGenesis: string
  accounts: { code: string; asset: string; symbol: string; decimals: number; amount: string; text: string }[]
  movements: number; previewDigest: string; words: string
}

/** What closing would do now, with nothing changed; null unless the wallet service answers for another chain. */
export async function closingPreview(cfg: RailCfg, db: Db, userId: string): Promise<ClosingPreview | null> {
  const v = vaultOf(db, userId)
  const st = row(db, userId)
  if (!v || !st?.genesis_id) return null
  let state: Record<string, unknown>
  try { state = await railJson(cfg, v, '/state') } catch (e) { if (e instanceof Unreachable) throw new AppError(503, 'rail_unreachable', `The wallet service did not answer: ${e.message}. Nothing was closed.`); throw e }
  const now = typeof state.genesisId === 'string' ? state.genesisId : null
  if (!now || now === st.genesis_id) return null
  const accounts = db.all<{ code: string; asset_id: string; meta_json: string; scale: number }>(`SELECT a.code, a.asset_id, a.meta_json, s.scale FROM accounts a JOIN assets s ON s.id = a.asset_id WHERE a.user_id = ? AND (a.code LIKE 'chain:treasury:%' OR a.code LIKE 'chain:reserve:%' OR a.code LIKE 'chain:owner:%') ORDER BY a.code`, userId)
    .map((a) => ({ a, held: balance(db, userId, a.code) })).filter((x) => x.held !== 0n)
    .map(({ a, held }) => { const symbol = String(parse<{ symbol?: string }>(a.meta_json, {}).symbol ?? ''); return { code: a.code, asset: a.asset_id, symbol, decimals: a.scale, amount: held.toString(), text: tokenText(held, a.scale, symbol) } })
  const movements = db.get<{ n: number }>('SELECT COUNT(*) n FROM chain_movements WHERE user_id = ? AND network = ? AND reversed_at IS NULL', userId, CHAIN_NETWORK)!.n
  const core = { network: CHAIN_NETWORK, oldGenesis: st.genesis_id, newGenesis: now, accounts: accounts.map((x) => [x.code, x.amount]), movements }
  const words = `The wallet service now runs another chain (${now}) than the one your books were kept against (${st.genesis_id}). Closing takes what the books held there (${accounts.length ? accounts.map((x) => x.text).join(', ') : 'nothing'}) out of your wallet's figures with one entry, marks its ${movements} booking${movements === 1 ? '' : 's'} as closed, and keeps the books against the new chain from its first block. Nothing is deleted, and nothing moves on any chain. These are ${TEST_TOKEN_WORDS}.`
  return { network: CHAIN_NETWORK, oldGenesis: st.genesis_id, newGenesis: now, accounts, movements, previewDigest: sha256hex(canonical(core)), words }
}

/** Ask the owner to approve the closing: an approval of the preview's exact text, confirmed with a passkey. Nothing changes. */
export async function prepareClosing(cfg: RailCfg, db: Db, userId: string, now: number): Promise<{ approvalId: string; document: string; docHash: string; expiresAt: number; requiresStepUp: boolean; preview: ClosingPreview }> {
  const p = await closingPreview(cfg, db, userId)
  if (!p) throw new AppError(409, 'not_replaced', 'The wallet service answers for the chain your books are kept against, so there is nothing to close.')
  const document = canonical({ v: 1, kind: 'chain-closing', network: p.network, oldGenesis: p.oldGenesis, newGenesis: p.newGenesis, accounts: p.accounts.map((a) => ({ account: a.code, amount: a.amount, text: a.text })), movements: p.movements, previewDigest: p.previewDigest, what: p.words, note: 'Your passkey approves exactly this closing. It is recorded, with this text, and cannot be undone or deleted; the old entries stay in your books.' })
  const a = createApproval(db, userId, { purpose: 'chain-closing', subject: `chain-closing:${userId}:${p.newGenesis}`, document, requiresStepUp: true }, now)
  return { approvalId: a.id, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, requiresStepUp: true, preview: p }
}

/** Close the old chain's books, from a passkey-confirmed approval of the preview that is still what closing would do. */
export async function closeReplacedChain(cfg: RailCfg, db: Db, userId: string, personId: string, approvalId: string, now: number): Promise<{ closingId: string; entryId: string | null; movements: number; closed: ClosingPreview['accounts'] }> {
  const a = getApproval(db, userId, approvalId)
  if (!a || a.purpose !== 'chain-closing') throw new AppError(404, 'not_found', 'That approval was not found.')
  if (a.method !== 'passkey') throw new AppError(409, 'passkey_required', 'Closing the books of a chain needs an approval confirmed with a passkey. Nothing was closed.')
  const doc = parse<{ previewDigest?: string; newGenesis?: string }>(a.document, {})
  const p = await closingPreview(cfg, db, userId)
  if (!p) throw new AppError(409, 'not_replaced', 'The wallet service answers for the chain your books are kept against, so there is nothing to close.')
  if (doc.previewDigest !== p.previewDigest) throw new AppError(409, 'preview_changed', 'What closing would do is not what you approved. Look at it again. Nothing was closed.')
  return db.tx(() => {
    consumeApproval(db, userId, approvalId, `chain-closing:${userId}:${p.newGenesis}`, a.doc_hash, now)
    const closingId = newId('ccl', now)
    let entryId: string | null = null
    if (p.accounts.length) {
      const lines = p.accounts.flatMap((x) => [{ account: x.code, amount: -BigInt(x.amount) }, { account: open(db, userId, 'closed', x.asset, x.symbol), amount: BigInt(x.amount) }])
      entryId = post(db, { userId, ts: now, effectiveTs: now, kind: 'chain-closing', ref: `closing:${p.oldGenesis}:${p.newGenesis}`, memo: `Closed on your approval: what the books held on a chain the wallet service no longer runs (${p.accounts.map((x) => x.text).join(', ')})`, lines, meta: { network: CHAIN_NETWORK, oldGenesis: p.oldGenesis, newGenesis: p.newGenesis, closingId, approvalId, test: TEST_TOKEN_WORDS } }).id
    }
    const movements = db.run('UPDATE chain_movements SET reversed_at = ?, reversal_entry_id = ? WHERE user_id = ? AND network = ? AND reversed_at IS NULL', now, entryId ?? `closing:${closingId}`, userId, CHAIN_NETWORK).changes
    db.run('INSERT INTO chain_closings (id, user_id, network, old_genesis, new_genesis, closed_at, approved_by, approval_id, approval_method, entry_id, figures_json, movements, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      closingId, userId, CHAIN_NETWORK, p.oldGenesis, p.newGenesis, now, personId, approvalId, 'passkey', entryId, j(p.accounts), Number(movements), p.previewDigest)
    db.run(`UPDATE chain_books SET genesis_id = ?, cursor_block = -1, cursor_hash = NULL, backfill = 'needed', backfill_at = NULL, synced_at = NULL, compare_state = NULL, compare_json = NULL WHERE user_id = ? AND network = ?`, p.newGenesis, userId, CHAIN_NETWORK)
    resolveNotices(db, userId, `chain-books:${userId}`, now)
    audit(db, now, personId, 'owner', 'chain-books.closed', userId, { closingId, entryId, oldGenesis: p.oldGenesis, newGenesis: p.newGenesis, movements: Number(movements), approvalId })
    return { closingId, entryId, movements: Number(movements), closed: p.accounts }
  })
}

export function chainClosings(db: Db, userId: string): { id: string; oldGenesis: string; newGenesis: string; closedAt: number; approvedBy: string; entryId: string | null; figures: unknown; movements: number }[] {
  return db.all<{ id: string; old_genesis: string; new_genesis: string; closed_at: number; approved_by: string; entry_id: string | null; figures_json: string; movements: number }>('SELECT * FROM chain_closings WHERE user_id = ? ORDER BY closed_at DESC', userId)
    .map((r) => ({ id: r.id, oldGenesis: r.old_genesis, newGenesis: r.new_genesis, closedAt: r.closed_at, approvedBy: r.approved_by, entryId: r.entry_id, figures: parse(r.figures_json, []), movements: r.movements }))
}
