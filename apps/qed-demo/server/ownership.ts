/**
 * Ownership transfer, and a creditor's release or assignment of a claim, from the Vault screen (R13, audit item S5;
 * R7-050, R7-097; F-021, F-026). The release's QEDVault has all four; the vault service performs each through the
 * household's passkey owner account (chain/rail/ownership.ts):
 *
 *   transfer   both vaults are offered to another QED household. The call waits the owner account's delay (any one
 *              member can cancel it meanwhile); applied, it is an offer, and the vaults change hands only when that
 *              household accepts with its own passkeys.
 *   accept     a household accepts a wallet offered to it.
 *   release    a creditor forgives money another household's vault set aside for it; the money goes back to that
 *              household's free funds. QED makes it wait the same delay, so that one passkey cannot give it away unseen.
 *   assign     a creditor moves such a claim to its own vault, or to another household. Waits the same delay.
 *   promise    a household sets money aside for another household (a ring-fence naming that household's account), which
 *              then holds a claim it can release or assign.
 *
 * The other side is always named by its QED handle and resolved here to its account on the chain; no address is typed
 * in. Before anything is signed, the approval shows the terms the vault service prepared, the delay included. Names:
 * a household is shown by name only to a household it has acted toward (it offered its wallet, or set money aside for
 * it); otherwise by the handle the person typed (RISK-071).
 */
import { bad, type Db, refused } from './core.ts'
import { type Asker, at, must, mustVault, proposeOnRail, type RailCfg, vaultOf } from './rail.ts'

type Json = Record<string, unknown>
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const ADDR = /^0x[0-9a-fA-F]{40}$/
const ID = /^\d{1,9}$/

/** The QED household a rail workspace belongs to. */
function householdOfRail(db: Db, railId: string): { id: string; name: string; handle: string } | null {
  for (const row of db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'vault.workspace:%'`)) {
    let rec: { railId?: string } | null = null
    try { rec = JSON.parse(row.value) } catch { continue }
    if (rec?.railId !== railId) continue
    const id = row.key.slice('vault.workspace:'.length)
    const u = db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM users WHERE id = ?', id)
    return u ? { id, name: u.display_name, handle: u.handle } : null
  }
  return null
}
/** Another household with an on-chain wallet, by its handle; the same answer for "no such handle" and "no wallet". */
async function householdByHandle(cfg: RailCfg, db: Db, who: Asker, raw: unknown): Promise<{ id: string; handle: string; ownerAccount: string; vault: string }> {
  const handle = clean(raw, 40).toLowerCase().replace(/^@/, '')
  if (!/^[a-z0-9_.-]{2,40}$/.test(handle)) throw bad('Name the other household by its QED handle.', { handle: 'Type the household\'s handle, for example @meera.' })
  const u = db.get<{ id: string; handle: string }>(`SELECT id, handle FROM users WHERE handle = ?`, handle)
  if (u?.id === who.workspaceId) throw refused('same_household', 'That is this household. Name another one.')
  const v = u ? vaultOf(db, u.id) : null
  if (!u || !v) throw refused('household_unavailable', 'No QED household with an on-chain wallet answers to that handle. Check it with them.')
  const w = await must(cfg, 'GET', at(v, ''))
  if (typeof w.ownerAccount !== 'string' || !ADDR.test(w.ownerAccount)) throw refused('household_unavailable', 'That household\'s wallet is not ready yet.')
  return { id: u.id, handle: u.handle, ownerAccount: w.ownerAccount, vault: String((w.contracts as Json | undefined)?.vault ?? '') }
}

/** Who owns the wallet, offers either way, the claims this household holds on other vaults, and the delay. */
export async function ownershipView(cfg: RailCfg, db: Db, who: Asker): Promise<Json> {
  const v = mustVault(db, who.workspaceId)
  const [state, claims] = await Promise.all([must(cfg, 'GET', at(v, '/ownership')), must(cfg, 'GET', at(v, '/claims'))])
  const byRail = (id: unknown) => (typeof id === 'string' ? householdOfRail(db, id) : null)
  const handleOnly = (h: ReturnType<typeof householdOfRail>) => (h ? { handle: h.handle } : null)
  const named = (h: ReturnType<typeof householdOfRail>) => (h ? { name: h.name, handle: h.handle } : null)
  return {
    delaySeconds: state.delaySeconds,
    // an offer this household made: the other side by the handle it was offered to
    mine: ((state.mine ?? []) as Json[]).map((m) => ({ which: m.which, vault: m.vault, ownedByYou: m.ownedByThisAccount, offeredTo: m.pendingOwner ? handleOnly(byRail(m.pendingWorkspace)) ?? { handle: null } : null, owner: m.ownedByThisAccount ? null : handleOnly(byRail(m.ownerWorkspace)) ?? { handle: null } })),
    // the other household acted toward this one: shown by name
    offeredToYou: ((state.offeredToMe ?? []) as Json[]).map((o) => ({ which: o.which, vault: o.vault, from: named(byRail(o.fromWorkspace)), balance: o.balance })),
    ownedHere: ((state.ownedHere ?? []) as Json[]).map((o) => ({ which: o.which, vault: o.vault, from: named(byRail(o.fromWorkspace)), balance: o.balance })),
    claims: ((claims.claims ?? []) as Json[]).map((c) => ({ vault: c.vault, liabilityId: c.liabilityId, debtor: named(byRail(c.debtorWorkspace)), amount: c.amount, dueAt: c.dueAt, status: c.status, due: c.due, yours: c.mine, assignedAway: !c.mine })),
  }
}

/** Offer both vaults to another household: scheduled behind the owner account's delay, then an offer it must accept. */
export async function proposeTransfer(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => k !== 'handle')) throw bad('A transfer takes { handle }.')
  const to = await householdByHandle(cfg, db, who, b.handle)
  return proposeOnRail(cfg, db, who, 'transfer-ownership', { newOwner: to.ownerAccount }, now, { ownership: { to: `@${to.handle}`, what: 'both vaults of this wallet, with everything in them' } })
}

/** Accept a wallet another household offered to this one. */
export async function proposeAccept(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => k !== 'vault') || typeof b.vault !== 'string' || !ADDR.test(b.vault)) throw bad('Accepting takes { vault }: the address of the vault offered to you.')
  return proposeOnRail(cfg, db, who, 'accept-ownership', { vault: b.vault }, now)
}

/** Release a claim this household holds on another household's vault. */
export async function proposeRelease(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => k !== 'vault' && k !== 'liabilityId') || typeof b.vault !== 'string' || !ADDR.test(b.vault) || typeof b.liabilityId !== 'string' || !ID.test(b.liabilityId)) throw bad('Releasing takes { vault, liabilityId }.')
  return proposeOnRail(cfg, db, who, 'release-claim', { vault: b.vault, liabilityId: b.liabilityId }, now)
}

/** Assign a claim to this household's own vault, or to another household by handle. */
export async function proposeAssign(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => !['vault', 'liabilityId', 'to'].includes(k)) || typeof b.vault !== 'string' || !ADDR.test(b.vault) || typeof b.liabilityId !== 'string' || !ID.test(b.liabilityId)) throw bad('Assigning takes { vault, liabilityId, to }.')
  let newCreditor: string, shown: string
  if (b.to === 'my-vault') {
    const w = await must(cfg, 'GET', at(mustVault(db, who.workspaceId), ''))
    const vault = (w.contracts as Json | undefined)?.vault
    if (typeof vault !== 'string' || !ADDR.test(vault)) throw refused('wallet_not_ready', 'Your wallet\'s vault is not ready yet.')
    newCreditor = vault
    shown = 'your own treasury vault'
  } else {
    const h = await householdByHandle(cfg, db, who, b.to)
    newCreditor = h.ownerAccount
    shown = `@${h.handle}`
  }
  return proposeOnRail(cfg, db, who, 'assign-claim', { vault: b.vault, liabilityId: b.liabilityId, newCreditor }, now, { claim: { to: shown } })
}

/** Set money aside for another household: a ring-fence naming its account, which it can then release or assign. */
export async function proposePromise(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = (raw ?? {}) as Json
  if (Object.keys(b).some((k) => !['handle', 'amount', 'dueInDays'].includes(k))) throw bad('Setting money aside takes { handle, amount, dueInDays }.')
  if (typeof b.amount !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(b.amount) || Number(b.amount) <= 0) throw bad('Say how much, in rupees.', { amount: 'An amount above ₹0, at most two decimals.' })
  if (!Number.isInteger(b.dueInDays) || (b.dueInDays as number) < 1 || (b.dueInDays as number) > 365) throw bad('Say when it falls due.', { dueInDays: 'A whole number of days from 1 to 365.' })
  const to = await householdByHandle(cfg, db, who, b.handle)
  return proposeOnRail(cfg, db, who, 'ring-fence', { creditor: to.ownerAccount, amount: b.amount, dueInDays: b.dueInDays }, now, { promise: { to: `@${to.handle}` } })
}
