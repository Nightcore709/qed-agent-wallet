/**
 * A vault's signers and recovery, from QED (RISK-053). The vault's owner account (QEDOwnerAccount, chain/accounts)
 * decides everything on the chain; this layer decides which passkey QED lets become a signer and says why it refuses.
 *
 *   add a signer     a usable passkey of the same person (a household) or of a member who may sign (a shared
 *                    workspace, one passkey per member so that the threshold counts people). The account's admin
 *                    threshold of current signers signs the exact terms, which name the key; the account adds it at
 *                    once, because the contract makes additions immediate (they lower no threshold).
 *   remove signers   by passkey or by signer id (a key that is nobody's passkey here, for instance one a thief added,
 *                    is shown and can be removed with the others in ONE change, which none of them can cancel). The
 *                    account schedules it behind its delay; any other signer can cancel; never below the admin
 *                    threshold, never zero. QED refuses before asking the rail when it can tell.
 *   thresholds       raising is immediate, lowering waits the delay; in a shared workspace never below the number of
 *                    signatures the workspace's own policy asks for.
 *   recovery key     a raw P-256 key the owner's device derives from a recovery code it shows once (26 Crockford
 *                    base-32 characters, 130 bits; scrypt N = 2^15, r = 8, p = 1, as chain/accounts RecoveryKey). QED
 *                    receives only its public key and a proof that the device holds it; never the code.
 *   vault recovery   for a passkey of the same person that is not a signer (after QED's own account recovery, or one
 *                    added later): the device signs the account's recovery digest with the recovery key; QED checks
 *                    the signature, relays it, and every member is told. The passkey becomes a signer only after the
 *                    account's recovery delay (72 hours), during which any signer can cancel; the key is spent.
 *                    (R13) QED relays it only when the passkey being added has itself confirmed this very request: an
 *                    assertion by that passkey, and no other, over a challenge bound to the request and its digest.
 *                    A session confirmed with another of the person's passkeys cannot make a different key a signer.
 *
 *   (R13 owner options, on wallets set up from R13; earlier ones keep their bytecode and gain nothing, and say so)
 *   two devices      "Require two of your devices": the thresholds raised to 2 and 2 in a household with two or more
 *                    passkeys on the vault; QED then asks the person for two different passkeys per approval
 *                    (rail.ts railSignBegin/railSignFinish). Turning it off is lowering the thresholds: it waits the delay.
 *   guardian         a passkey of the person's active recovery contact (passkeys.ts activeContacts), set or removed only
 *                    behind the account's delay. While it is set, a vault recovery is relayed only once the contact has
 *                    co-signed that very recovery in their own session (a WebAuthn assertion over the same digest); a
 *                    frozen passkey then cannot cancel it. The contact's passkey signs nothing else for the vault.
 *   time-lock        chosen at set-up (rail.ts railSetup) and changed here: on at once; off after the delay. While on,
 *                    withdraw, ring-fence, resume and replacing the vault's guardian wait the delay.
 *
 * The vault service (the rail) never holds a key that can satisfy the account, and never sees the code.
 */
import { createHash, createPublicKey, randomBytes, verify as ecVerify } from 'node:crypto'
import { AppError, audit, bad, type Db, j, notFound, parse, refused, whenIst } from './core.ts'
import { notice } from './execute.ts'
import { activeContacts, approvingCredentials, beginReauth, COOL_OFF_MS, coolingOffUntil, type Credential, finishReauth, type RelyingParty, RESTRICTED_WORDS, securityEvent, settledCredentials } from './passkeys.ts'
import { at, type Asker, must, mustVault, proposeOnRail, type RailCfg, rail as railCall, rememberSigners, sameKey, vaultOf } from './rail.ts'
import { canSign, policyOf } from './workspaces.ts'

type Json = Record<string, unknown>
interface RailSigner { signerId: string; x: string; y: string; role: 'member' | 'recovery' | 'guardian'; frozen?: boolean; pendingRemoval: string | null; pendingRecovery: string | null }
/**
 * `containment` (R13): absent from a vault service before R13; `byThisService` when the service can freeze a member there.
 * `guardian`, `timeLock` (R13 owner options): absent from a vault service before them; `supported` false for an account
 * built before them.
 */
interface RailSigners {
  account: string; signers: RailSigner[]; threshold: number; adminThreshold: number; memberCount: number; delaySeconds: number; recoveryDelaySeconds: number; pending: Json[]; rules: string[]
  containment?: { sentinel: string | null; byThisService: boolean; protect: boolean }
  guardian?: { supported: boolean; signerId: string | null; x: string | null; y: string | null }
  timeLock?: { supported: boolean; on: boolean }
}
interface Person { id: string; name: string; handle: string }

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const span = (s: number): string => (s % 3600 === 0 ? `${s / 3600} hours` : s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`)
const only = (raw: unknown, keys: string[], what: string): Json => {
  const o = raw as Json | null
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !keys.includes(k))) throw bad(`${what} takes ${keys.join(', ')} and nothing else.`)
  return o
}
const isShared = (db: Db, ws: string): boolean => db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', ws)?.kind === 'business'
/** In a household its person; in a shared workspace an owner or admin. Changing who signs for a vault is a change of authority. */
function mayAdminister(db: Db, who: Asker): void {
  if (isShared(db, who.workspaceId) ? !(who.role === 'owner' || who.role === 'admin') : who.workspaceId !== who.personId) throw new AppError(403, 'not_permitted', 'Only the household\'s own person, or an owner or admin of this workspace, can change who signs for its vault.')
}
const personOf = (db: Db, id: string): Person => { const u = db.get<{ display_name: string; handle: string }>('SELECT display_name, handle FROM users WHERE id = ?', id); return { id, name: u?.display_name ?? 'Someone', handle: u?.handle ?? '' } }
/** The people whose passkeys may be on this vault: the household's person, or every member ever (former ones too, so their keys are named). */
const peopleOf = (db: Db, ws: string): { personId: string; current: boolean }[] =>
  db.all<{ person_id: string; removed_at: number | null }>('SELECT person_id, removed_at FROM memberships WHERE workspace_id = ?', ws).map((m) => ({ personId: m.person_id, current: m.removed_at === null }))
const credentialsOf = (db: Db, people: string[]): Credential[] => people.length ? db.all<Credential>(`SELECT * FROM webauthn_credentials WHERE person_id IN (${people.map(() => '?').join(',')}) ORDER BY created_at`, ...people) : []
const pub = (c: Credential): { x: string; y: string } => ({ x: `0x${c.x}`, y: `0x${c.y}` })
const stateOf = (c: Credential): 'active' | 'suspended' | 'removed' => (c.removed_at !== null ? 'removed' : c.suspended_at !== null ? 'suspended' : 'active')

/** The owner account's signers as the chain holds them now; the vault record keeps a copy for signing decisions. */
async function chainSigners(cfg: RailCfg, db: Db, ws: string, now: number): Promise<RailSigners> {
  const v = mustVault(db, ws)
  const s = (await must(cfg, 'GET', at(v, '/signers'))) as unknown as RailSigners
  const before = v.current?.signers ?? null
  rememberSigners(db, ws, s, now)
  // every change of the signer set, whoever made it (through QED or not), is told to the workspace (NIST 800-63B-4 §4.1.2.1, §4.6: in-app only)
  if (before) {
    const was = (k: { x: string; y: string }) => before.some((b) => sameKey({ x: b.x.slice(2), y: b.y.slice(2) }, k))
    for (const k of s.signers.filter((k) => !was(k))) notice(db, ws, { level: 'warning', kind: 'vault-signer-added', title: k.role === 'member' ? 'A passkey was added as a signer of the vault' : 'A recovery key was added to the vault', body: `${k.role === 'member' ? 'A new key now signs for this on-chain wallet' : 'A new recovery key is on this on-chain wallet'}. If nobody here added it, remove it under Security, "Who can sign for your on-chain wallet".`, dedupe: `vault-signer:${k.signerId}` }, now)
  }
  return s
}

// ------------------------------------------------------------------------------------------------ the view

export async function vaultSignersView(cfg: RailCfg, db: Db, who: Asker): Promise<Json> {
  const now = Date.now()
  const v = mustVault(db, who.workspaceId)
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  const shared = isShared(db, who.workspaceId)
  const people = peopleOf(db, who.workspaceId)
  const creds = credentialsOf(db, people.map((p) => p.personId))
  const recoveryRecords = parse<{ x: string; registeredBy: string; registeredAt: number }[]>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', `vault.recovery-keys:${who.workspaceId}`)?.value ?? '[]', [])
  const warnings: string[] = []
  const signers = s.signers.map((k) => {
    if (k.role === 'guardian') {
      // R13: the recovery contact's passkey; named by its person only (the household does not see the contact's devices)
      const g = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE lower(x) = ? AND lower(y) = ?', k.x.slice(2).toLowerCase(), k.y.slice(2).toLowerCase())
      return { signerId: k.signerId, role: 'guardian', guardian: g ? { person: personOf(db, g.person_id).name, handle: personOf(db, g.person_id).handle, state: stateOf(g) } : null }
    }
    if (k.role === 'recovery') {
      const rec = recoveryRecords.find((r) => BigInt(r.x) === BigInt(k.x))
      return { signerId: k.signerId, role: 'recovery', recoveryKey: rec ? { registeredBy: personOf(db, rec.registeredBy).name, registeredAt: rec.registeredAt } : null, pendingRecovery: k.pendingRecovery }
    }
    const c = creds.find((x) => sameKey(x, k))
    if (!c) { warnings.push(`A signer of this wallet is not a passkey of anyone in this workspace. If nobody here added it, remove it, together with any passkey you have lost, in one removal: none of the keys a removal removes can cancel it.`); return { signerId: k.signerId, role: 'member', frozen: k.frozen === true, passkey: null, unknown: true, pendingRemoval: k.pendingRemoval } }
    const p = personOf(db, c.person_id), state = stateOf(c)
    const former = shared && !people.some((x) => x.personId === c.person_id && x.current)
    const whose = `${c.person_id === who.personId ? 'Your' : `${p.name}'s`} passkey "${c.name}"`
    // R13: a suspended or removed passkey is frozen on the chain at once where the wallet has QED's sentinel
    if (state !== 'active' && !k.pendingRemoval) warnings.push(k.frozen
      ? `${whose} is ${state} in QED and frozen on the chain: its signature moves no money and changes nothing on this wallet, but it can still cancel a change and stop things until it is removed. Schedule its removal.`
      : s.containment?.byThisService
        ? `${whose} is ${state} in QED and still a signer on the chain. QED is freezing it there; if this stays, schedule its removal. Until it is frozen or removed, the chain would still accept it.`
        : `${whose} is ${state} in QED but is still a signer of this wallet on the chain, and this wallet was set up before QED could freeze a passkey there: schedule its removal. Until it applies, QED sends nothing it signs, but the chain would still accept it.`)
    if (former && !k.pendingRemoval) warnings.push(`${p.name} is no longer a member, but their passkey "${c.name}" is still a signer of this wallet: schedule its removal.`)
    return { signerId: k.signerId, role: 'member', frozen: k.frozen === true, passkey: { credentialId: c.id, name: c.name, person: { name: p.name, handle: p.handle }, you: c.person_id === who.personId, state, registeredAt: c.created_at, ...(former ? { formerMember: true } : {}) }, unknown: false, pendingRemoval: k.pendingRemoval }
  })
  const onAccount = (c: Credential) => s.signers.some((k) => sameKey(c, k))
  const canAdd = shared
    ? people.filter((p) => p.current && canSign((db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ?', who.workspaceId, p.personId)?.role ?? 'viewer') as never))
      .filter((p) => !credentialsOf(db, [p.personId]).some(onAccount))
      .map((p) => settledCredentials(db, p.personId, now)[0]).filter((c): c is Credential => !!c)
    : settledCredentials(db, who.personId, now).filter((c) => !onAccount(c))
  const recoveryKeys = s.signers.filter((k) => k.role === 'recovery').length
  if (!recoveryKeys) warnings.push('This wallet has no recovery key. If every passkey that signs for it is lost, nobody can act for it again. Set one up below, under Recovery key.')
  // R13 owner options: what this wallet's account supports, as the chain says
  const options = ownerOptions(db, who, s, now)
  if (options.guardian.set?.state && options.guardian.set.state !== 'active') warnings.push(`The guardian's passkey is ${options.guardian.set.state} in QED. While it is the guardian, no recovery of this wallet can start without it: replace or remove the guardian (that waits the wallet's delay).`)
  return {
    setUp: true, account: s.account, threshold: s.threshold, adminThreshold: s.adminThreshold, memberCount: s.memberCount, delaySeconds: s.delaySeconds, recoveryDelaySeconds: s.recoveryDelaySeconds,
    signers, canAdd: canAdd.map((c) => ({ credentialId: c.id, name: c.name, person: { name: personOf(db, c.person_id).name, handle: personOf(db, c.person_id).handle } })),
    pending: s.pending, recovery: { keys: recoveryKeys, hasKey: recoveryKeys > 0 }, warnings, rules: s.rules, origin: v.request.origin,
    // R13: whether QED can freeze a suspended passkey on this wallet's chain account at once
    containment: { freezes: s.containment?.byThisService === true, protect: s.containment?.protect === true },
    // R13 owner options: two devices, the guardian, the time-lock (absent or unsupported on a wallet built before them)
    options,
  }
}

/**
 * R13 owner options for the Security screen, from the chain's view: whether the account has them at all (a wallet set up
 * before them keeps its bytecode and gains nothing), "Require two of your devices" (a household's thresholds at 2 or more,
 * offered when two or more of the person's passkeys sign), the guardian (whose contact it is, and the contacts who could
 * be one), and the time-lock.
 */
function ownerOptions(db: Db, who: Asker, s: RailSigners, now: number): Json & { guardian: Json & { set: { person: string; handle: string; state: string } | null } } {
  const supported = s.guardian?.supported === true && s.timeLock?.supported === true
  const shared = isShared(db, who.workspaceId)
  const pendingOf = (kind: string) => (s.pending as { kind?: string; changeId?: string; readyAt?: number }[]).find((c) => c.kind === kind) ?? null
  const g = s.guardian?.signerId && s.guardian.x && s.guardian.y ? db.get<Credential>('SELECT * FROM webauthn_credentials WHERE lower(x) = ? AND lower(y) = ?', s.guardian.x.slice(2).toLowerCase(), s.guardian.y.slice(2).toLowerCase()) : undefined
  const members = s.signers.filter((k) => k.role === 'member').length
  return {
    supported,
    why: supported ? null : 'This wallet was set up before these options existed. Its owner account keeps the bytecode it was created with and gains nothing: a new wallet (a new account and vault set, its funds moved by its own passkeys) has them.',
    twoDevices: {
      offered: !shared,
      on: !shared && s.threshold >= 2,
      possible: !shared && members >= 2,
      lowering: !!pendingOf('set-thresholds'),
      tradeOff: 'Every payment, mandate and change then needs two of your devices. A lost or stolen device alone can only cancel a change or stop the agent: it cannot spend. But with exactly two devices, losing one leaves you only that veto until a recovery adds another device (it waits the recovery delay). Three devices, or a guardian, avoid that.',
    },
    guardian: {
      offered: supported && !shared,
      set: g ? { person: personOf(db, g.person_id).name, handle: personOf(db, g.person_id).handle, state: stateOf(g) } : s.guardian?.signerId ? { person: 'someone outside QED', handle: '', state: 'unknown' } : null,
      pending: pendingOf('set-guardian'),
      contacts: shared ? [] : activeContacts(db, who.personId, now).map((id) => ({ contactId: id, ...personOf(db, id), hasPasskey: approvingCredentials(db, id).length > 0 })),
      words: 'A guardian is a passkey of your recovery contact. While one is set, a recovery of this wallet starts only when your contact co-signs that very recovery in their own QED session, so a stolen recovery code alone starts nothing. A passkey QED froze cannot cancel a recovery your contact co-signed; your contact can withdraw their co-signature until the recovery finishes, and can approve or move nothing. Such a recovery finishes only after its whole delay has passed with at least one of your passkeys not frozen, or with your wallet\'s sentinel (QED\'s key) unchanged all along: then, even if every passkey of this wallet is frozen, you can stop it from QED under Security with a passkey that is not suspended, and it finishes only if nobody stops it. If your contact cannot be reached, no recovery can start until you replace them. A contact who colludes with someone holding your recovery code could give that person a seat, unless one of your passkeys that is not frozen cancels in time.',
    },
    timeLock: { offered: supported, on: s.timeLock?.on === true, pending: pendingOf('set-time-lock') },
  }
}

// ------------------------------------------------------------------------------------------------ R13: contain a suspended passkey

/**
 * Freeze on the chain, at once, every signer of this vault that is a passkey QED has suspended or removed (R13). The
 * vault service's sentinel key sends QEDOwnerAccount.freeze: from the next block that passkey's signature moves no money,
 * signs no mandate and changes nothing on the wallet; it keeps its veto (it can cancel a change) and can still stop
 * things. Only the vault's unfrozen signers can unfreeze it. Called when a passkey is suspended and on every vault round
 * of the engine (five minutes), so a freeze that could not be sent is sent later; each round asks under its own key. A
 * vault set up before R13 has no sentinel: nothing is sent, and its signers view says so. Never throws.
 */
export async function containVault(cfg: RailCfg, db: Db, ws: string, now: number): Promise<{ frozen: string[]; failed: string[]; unavailable: boolean }> {
  const out = { frozen: [] as string[], failed: [] as string[], unavailable: false }
  const v = vaultOf(db, ws)
  if (!v) return out
  let s: RailSigners
  try { s = await chainSigners(cfg, db, ws, now) } catch { out.unavailable = true; return out }
  if (!s.containment?.byThisService) { out.unavailable = true; return out }
  const creds = credentialsOf(db, peopleOf(db, ws).map((p) => p.personId))
  for (const k of s.signers.filter((x) => x.role === 'member' && !x.frozen)) {
    const c = creds.find((x) => sameKey(x, k))
    if (!c || stateOf(c) === 'active') continue
    try {
      const a = await must(cfg, 'POST', at(v, '/signers/freeze'), { signerId: k.signerId.toLowerCase() }, { 'Idempotency-Key': `freeze-${v.railId}-${k.signerId.toLowerCase()}-${Math.floor(now / 300_000)}` })
      const job = await settled(cfg, v, String(a.jobId))
      const outcome = (job?.result as { outcome?: string } | undefined)?.outcome
      if (outcome !== 'executed' && outcome !== 'no-action') { out.failed.push(c.name); continue }
      out.frozen.push(c.name)
      if (outcome === 'executed') {
        db.tx(() => {
          notice(db, ws, { level: 'warning', kind: 'vault-signer-frozen', title: 'A suspended passkey was frozen on the on-chain wallet', body: `"${c.name}" is ${stateOf(c)} in QED, so QED froze it on the chain: its signature moves no money and changes nothing on this wallet from now. It can still cancel a change and stop things until it is removed under Security, "Who can sign for your on-chain wallet".`, dedupe: `vault-frozen:${k.signerId}` }, now)
          securityEvent(db, c.person_id, 'vault-signer-frozen', { workspace: ws, passkey: c.name }, now)
          audit(db, now, ws, 'system', 'vault.signer-freeze', c.id, { signerId: k.signerId, jobId: a.jobId })
        })
      }
    } catch { out.failed.push(c.name) }
  }
  return out
}

/** The vault service's job once it has finished, waiting up to ten seconds; null if it has not. */
async function settled(cfg: RailCfg, v: { railId: string }, jobId: string): Promise<Json | null> {
  for (let i = 0; i < 40; i++) {
    const r = await railCall(cfg, 'GET', `/workspaces/${v.railId}/jobs/${jobId}`).catch(() => null)
    if (r?.status === 200 && (r.json.status === 'done' || r.json.status === 'failed')) return r.json
    await new Promise((res) => setTimeout(res, 250))
  }
  return null
}

/** Every vault a person's passkey may sign for: their household's and every shared workspace they belong to (R13). */
export async function containPerson(cfg: RailCfg, db: Db, personId: string, now: number): Promise<{ frozen: string[]; failed: string[]; unavailable: boolean }> {
  const all = { frozen: [] as string[], failed: [] as string[], unavailable: false }
  const spaces = [personId, ...db.all<{ workspace_id: string }>('SELECT workspace_id FROM memberships WHERE person_id = ?', personId).map((m) => m.workspace_id)]
  for (const ws of [...new Set(spaces)]) {
    if (!vaultOf(db, ws)) continue
    const r = await containVault(cfg, db, ws, now)
    all.frozen.push(...r.frozen); all.failed.push(...r.failed); all.unavailable ||= r.unavailable
  }
  return all
}

// ------------------------------------------------------------------------------------------------ add, remove, thresholds

export async function proposeAddSigner(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['credentialId'], 'Adding a signer')
  mayAdminister(db, who)
  const shared = isShared(db, who.workspaceId)
  const c = typeof b.credentialId === 'string' ? db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', b.credentialId) : undefined
  const member = c ? db.get<{ role: string; removed_at: number | null }>('SELECT role, removed_at FROM memberships WHERE workspace_id = ? AND person_id = ?', who.workspaceId, c.person_id) : undefined
  const belongs = !!c && (shared ? !!member && member.removed_at === null && canSign(member.role as never) : c.person_id === who.personId)
  if (!c || !belongs) throw notFound('That passkey')
  if (stateOf(c) !== 'active') throw refused('passkey_not_usable', `The passkey "${c.name}" is ${stateOf(c)} in QED: it cannot become a signer of the vault.`)
  // A passkey a recovery registered becomes a signer only after its approval authority is restored (R12).
  if (c.authority !== 'full') throw refused('authority_restricted', RESTRICTED_WORDS)
  // A passkey added in the last 24 hours becomes a signer only after its cool-off (RISK-068, Q-062; server/passkeys.ts).
  const cooling = coolingOffUntil(db, c.id, now)
  if (cooling !== null) throw refused('passkey_cooling_off', `The passkey "${c.name}" was added in the last ${Math.round(COOL_OFF_MS / 3600_000)} hours. It can become a signer of the vault from ${whenIst(cooling)}.`)
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  if (s.signers.some((k) => sameKey(c, k))) throw refused('already_a_signer', `The passkey "${c.name}" is already a signer of this vault.`)
  if (shared && credentialsOf(db, [c.person_id]).some((x) => s.signers.some((k) => sameKey(x, k)))) throw refused('one_key_per_member', `${personOf(db, c.person_id).name} already has a passkey on this vault. It takes one passkey per member, so that its threshold counts people: remove that one first (after the vault's delay), then add this one.`)
  const p = personOf(db, c.person_id)
  const out = await proposeOnRail(cfg, db, who, 'add-signer', { ...pub(c), role: 'member' }, now, { passkey: { name: c.name, person: p.name, handle: p.handle, registeredAt: c.created_at, deviceType: c.device_type } })
  audit(db, now, who.workspaceId, 'owner', 'vault.signer-add.propose', c.id, { person: c.person_id })
  return out
}

export async function proposeRemoveSigners(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['credentialIds', 'signerIds'], 'Removing signers')
  mayAdminister(db, who)
  const credIds = b.credentialIds === undefined ? [] : b.credentialIds, ids = b.signerIds === undefined ? [] : b.signerIds
  if (!Array.isArray(credIds) || !Array.isArray(ids) || credIds.length + ids.length < 1 || credIds.length + ids.length > 16 || credIds.some((x) => typeof x !== 'string') || ids.some((x) => typeof x !== 'string' || !HEX32.test(x))) throw bad('Name 1 to 16 signers to remove: credentialIds (passkeys) and signerIds (any key on the vault).')
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  const targets = new Map<string, RailSigner>()
  for (const id of credIds as string[]) {
    const c = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', id)
    const k = c && s.signers.find((x) => sameKey(c, x))
    if (!k) throw refused('not_a_signer', 'One of those passkeys is not a signer of this vault. Nothing was prepared.')
    targets.set(k.signerId, k)
  }
  for (const id of ids as string[]) {
    const k = s.signers.find((x) => x.signerId.toLowerCase() === id.toLowerCase())
    if (!k) throw refused('not_a_signer', `${id.slice(0, 10)}… is not a signer of this vault. Nothing was prepared.`)
    targets.set(k.signerId, k)
  }
  const left = s.memberCount - [...targets.values()].filter((k) => k.role === 'member').length
  if (left < s.adminThreshold) throw refused('would_break_quorum', `That would leave ${left} signer${left === 1 ? '' : 's'}, and this vault needs at least ${s.adminThreshold}. Add a passkey first${s.threshold > 1 ? ', or lower its thresholds first' : ''}. Nothing was prepared.`)
  const out = await proposeOnRail(cfg, db, who, 'remove-signers', { signerIds: [...targets.keys()].map((x) => x.toLowerCase()).sort() }, now, { remove: [...targets.values()].map((k) => ({ signerId: k.signerId, role: k.role })), delaySeconds: s.delaySeconds })
  audit(db, now, who.workspaceId, 'owner', 'vault.signer-remove.propose', null, { signers: [...targets.keys()] })
  return out
}

export async function proposeThresholds(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['threshold', 'adminThreshold'], 'Thresholds')
  mayAdminister(db, who)
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  const t = b.threshold, a = b.adminThreshold === undefined ? b.threshold : b.adminThreshold
  if (!Number.isInteger(t) || !Number.isInteger(a) || (t as number) < 1 || (t as number) > (a as number) || (a as number) > s.memberCount) throw bad(`Thresholds must be whole numbers with 1 ≤ threshold ≤ admin threshold ≤ signers (${s.memberCount}).`, { threshold: 'Out of range.' })
  if (isShared(db, who.workspaceId) && (t as number) < policyOf(db, who.workspaceId).signers) throw refused('below_workspace_policy', `This workspace asks for ${policyOf(db, who.workspaceId).signers} signatures; the vault's threshold cannot be lower. Lower the workspace's policy first (that waits its own delay).`)
  if (t === s.threshold && a === s.adminThreshold) throw refused('nothing_to_change', `The thresholds are already ${s.threshold} and ${s.adminThreshold}.`)
  const out = await proposeOnRail(cfg, db, who, 'set-thresholds', { threshold: t, adminThreshold: a }, now, { before: { threshold: s.threshold, adminThreshold: s.adminThreshold }, lowering: (t as number) < s.threshold || (a as number) < s.adminThreshold, delaySeconds: s.delaySeconds })
  audit(db, now, who.workspaceId, 'owner', 'vault.thresholds.propose', null, { threshold: t, adminThreshold: a })
  return out
}

// ------------------------------------------------------------------------------------------------ the recovery key

/** How the device makes the recovery key: what the interface implements. The server never runs it and never sees the code. */
export const RECOVERY_DERIVATION = {
  code: { characters: 26, alphabet: 'Crockford base 32', bits: 130, grouping: '5-5-5-5-6, joined with "-"', normalise: 'upper-case; remove spaces and "-"; O → 0; I and L → 1', source: 'crypto.getRandomValues: 17 random bytes, the top 130 bits' },
  kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: 'QEDOwnerAccount recovery v1', bytes: 48, input: 'the normalised code as UTF-8' },
  key: 'd = (the 48 bytes as a big-endian integer mod (n − 1)) + 1, n the order of P-256; the public key is d·G',
  sign: 'ECDSA P-256 with SHA-256 over the bytes given (WebCrypto { name: "ECDSA", hash: "SHA-256" }), r||s; the vault service makes s low',
  reference: 'chain/accounts/webauthn.ts, generateRecoveryCode and RecoveryKey',
  libraries: 'WebCrypto has no scrypt and cannot derive a P-256 key from a scalar; @noble/hashes (scrypt) and @noble/curves (p256), already in chain/package-lock.json through viem, do both.',
}

export function beginRecoveryKey(db: Db, who: Asker, now: number): Json & { challengeId: string; challenge: string } {
  mayAdminister(db, who)
  mustVault(db, who.workspaceId)
  const challengeId = `rkc-${randomBytes(12).toString('hex')}`, challenge = `0x${randomBytes(32).toString('hex')}`
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `vault.recovery-challenge:${challengeId}`, j({ ws: who.workspaceId, person: who.personId, challenge, expiresAt: now + 10 * 60_000 }))
  return { challengeId, challenge, expiresAt: now + 10 * 60_000, derivation: RECOVERY_DERIVATION, note: 'Make the code on this device, show it once, derive the key, and sign this challenge with it. Send only the public key and the signature: never the code.' }
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
/** A P-256 public key from { x, y } (0x hex), as a key object; refused when it is not on the curve. */
function p256(k: unknown, what: string): { x: string; y: string; key: ReturnType<typeof createPublicKey> } {
  const o = k as Json | null
  if (!o || typeof o !== 'object' || typeof o.x !== 'string' || typeof o.y !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(o.x) || !/^0x[0-9a-fA-F]{1,64}$/.test(o.y) || Object.keys(o).length !== 2) throw bad(`${what} is { x, y }: a P-256 public key in hexadecimal.`)
  const x = `0x${BigInt(o.x).toString(16).padStart(64, '0')}`, y = `0x${BigInt(o.y).toString(16).padStart(64, '0')}`
  try { return { x, y, key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(x.slice(2), 'hex').toString('base64url'), y: Buffer.from(y.slice(2), 'hex').toString('base64url') }, format: 'jwk' }) } } catch { throw bad(`${what} is not a point on the P-256 curve.`) }
}
/** A raw signature { r, s } by `key` over `message` (ECDSA P-256, SHA-256). */
function verifies(key: ReturnType<typeof createPublicKey>, message: Buffer, sig: unknown): boolean {
  const o = sig as Json | null
  if (!o || typeof o.r !== 'string' || typeof o.s !== 'string' || !HEX32.test(o.r) || !HEX32.test(o.s)) return false
  const r = BigInt(o.r), s = BigInt(o.s)
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) return false
  return ecVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.concat([Buffer.from(o.r.slice(2), 'hex'), Buffer.from(o.s.slice(2), 'hex')]))
}

export async function proposeRecoveryKey(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['challengeId', 'publicKey', 'proof'], 'A recovery key')
  mayAdminister(db, who)
  const k = p256(b.publicKey, 'publicKey')
  const key = `vault.recovery-challenge:${typeof b.challengeId === 'string' ? b.challengeId : ''}`
  const ch = parse<{ ws: string; person: string; challenge: string; expiresAt: number } | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? 'null', null)
  if (!ch || ch.ws !== who.workspaceId || ch.person !== who.personId || now > ch.expiresAt) throw notFound('That recovery key request')
  if (!verifies(k.key, Buffer.from(ch.challenge.slice(2), 'hex'), b.proof)) throw new AppError(422, 'recovery_key_proof', 'The proof was not made with this recovery key over this request. Nothing was prepared.')
  db.run('DELETE FROM meta WHERE key = ?', key)
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  if (s.signers.some((x) => BigInt(x.x) === BigInt(k.x) && BigInt(x.y) === BigInt(k.y))) throw refused('already_a_signer', 'That key is already on the vault.')
  const out = await proposeOnRail(cfg, db, who, 'add-signer', { x: k.x, y: k.y, role: 'recovery' }, now, { recoveryKey: { registeredBy: personOf(db, who.personId).name, recoveryDelaySeconds: s.recoveryDelaySeconds } })
  const recKey = `vault.recovery-keys:${who.workspaceId}`
  const list = parse<{ x: string; y: string; registeredBy: string; registeredAt: number }[]>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', recKey)?.value ?? '[]', [])
  list.push({ x: k.x, y: k.y, registeredBy: who.personId, registeredAt: now })
  // one transaction after the wait: its writes together, or none (brief item 2)
  db.tx(() => {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', recKey, j(list))
    audit(db, now, who.workspaceId, 'owner', 'vault.recovery-key.propose', null, {})
  })
  return out
}

// ------------------------------------------------------------------------------------------------ recovering the vault

/** R13: the challenge the passkey being added signs to confirm one recovery request: bound to the request and its digest. */
const recoveryConfirmation = (requestId: string, digest: string): Uint8Array => new Uint8Array(createHash('sha256').update(`qed/vault-recovery/v1\n${requestId}\n${digest.toLowerCase()}`).digest())

/** Recovery must not be started by someone who could simply act: the passkey to recover must be the person's own and not a signer. */
export async function beginVaultRecovery(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, raw: unknown, now: number): Promise<Json & { requestId: string; digest: string; deadline: string; confirm: { challengeId: string; options: unknown } }> {
  const b = only(raw, ['recoveryKey', 'credentialId'], 'A vault recovery')
  const shared = isShared(db, who.workspaceId)
  if (shared ? !canSign(who.role) : who.workspaceId !== who.personId) throw new AppError(403, 'not_permitted', 'Only a person who may sign for this vault can recover it for their own passkey.')
  const v = mustVault(db, who.workspaceId)
  const c = typeof b.credentialId === 'string' ? db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ?', b.credentialId, who.personId) : undefined
  if (!c) throw notFound('That passkey')
  if (stateOf(c) !== 'active') throw refused('passkey_not_usable', `The passkey "${c.name}" is ${stateOf(c)} in QED.`)
  if (c.authority !== 'full') throw refused('authority_restricted', RESTRICTED_WORDS)
  const rk = p256(b.recoveryKey, 'recoveryKey')
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  if (s.signers.some((k) => sameKey(c, k))) throw refused('already_a_signer', `The passkey "${c.name}" already signs for this vault: there is nothing to recover. Use it.`)
  if (shared && credentialsOf(db, [who.personId]).some((x) => s.signers.some((k) => sameKey(x, k)))) throw refused('one_key_per_member', 'You already have a passkey on this vault.')
  const signer = s.signers.find((k) => k.role === 'recovery' && BigInt(k.x) === BigInt(rk.x) && BigInt(k.y) === BigInt(rk.y))
  if (!signer) throw refused('not_a_recovery_key', 'That recovery code is not one of this vault\'s recovery keys (or it was used already). Check the code; nothing was started.')
  if (signer.pendingRecovery) throw refused('recovery_pending', 'A recovery with this key is already under way.')
  // R13: with a guardian, the recovery also waits for the recovery contact's co-signature, so it stands for a day
  const g = guardianOf(db, s)
  if (s.guardian?.signerId && !g) throw refused('guardian_outside_qed', 'This wallet\'s guardian is not a passkey anyone has in QED, so QED cannot ask for its co-signature: its holder must co-sign on the chain directly. Nothing was started.')
  if (g && stateOf(g.credential) !== 'active') throw refused('guardian_unusable', `The guardian's passkey (${personOf(db, g.credential.person_id).name}'s) is ${stateOf(g.credential)} in QED, so it cannot co-sign. Replace the guardian first (that waits the wallet's delay). Nothing was started.`)
  const window = g ? 23 * 3600 : 15 * 60
  const deadline = String(Math.floor(now / 1000) + window)
  const q = new URLSearchParams({ recoverySignerId: signer.signerId, x: pub(c).x, y: pub(c).y, deadline })
  const d = await must(cfg, 'GET', at(v, `/recovery/digest?${q}`))
  const requestId = `vrq-${randomBytes(12).toString('hex')}`
  // R13: the passkey being added confirms this very request; the prompt is offered to it alone
  const confirm = await beginReauth(db, rp, who.personId, 'approval', recoveryConfirmation(requestId, String(d.digest)), { purpose: 'vault-recovery', requestId }, now, [c.id])
  const guardian = g ? { signerId: String(s.guardian!.signerId), x: `0x${g.credential.x}`, y: `0x${g.credential.y}`, personId: g.credential.person_id, credentialId: g.credential.id } : undefined
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `vault.recovery-request:${requestId}`, j({ ws: who.workspaceId, person: who.personId, credentialId: c.id, recoverySignerId: signer.signerId, recoveryKey: { x: rk.x, y: rk.y }, newKey: pub(c), deadline, digest: d.digest, confirmChallengeId: confirm.challengeId, expiresAt: now + window * 1000, ...(guardian ? { guardian } : {}) }))
  const contact = guardian ? personOf(db, guardian.personId).name : null
  return { requestId, digest: String(d.digest), deadline, recoveryDelaySeconds: Number(d.recoveryDelaySeconds), passkey: { credentialId: c.id, name: c.name }, expiresAt: now + window * 1000, confirm, ...(contact ? { guardian: { person: contact } } : {}), note: `Confirm with "${c.name}" itself (no other passkey can confirm its recovery), and sign the digest with the recovery key derived from your code (ECDSA P-256, SHA-256).${contact ? ` This wallet has a guardian: ${contact} must then co-sign this very recovery in their own QED session within a day; until they do, nothing is sent.` : ''} Then "${c.name}" becomes a signer of this vault after ${span(Number(d.recoveryDelaySeconds))}, unless a signer cancels; the code is spent either way.` }
}

export async function finishVaultRecovery(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['requestId', 'signature', 'confirmation'], 'A vault recovery')
  const key = `vault.recovery-request:${typeof b.requestId === 'string' ? b.requestId : ''}`
  const r = parse<RecoveryRequest | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? 'null', null)
  if (!r || r.ws !== who.workspaceId || r.person !== who.personId) throw notFound('That recovery request')
  if (!r.jobId && now > r.expiresAt) throw refused('request_expired', `This recovery request lapsed after ${r.guardian ? 'a day' : '15 minutes'}. Start again.`)
  if (!verifies(p256(r.recoveryKey, 'recoveryKey').key, Buffer.from(r.digest.slice(2), 'hex'), b.signature)) throw new AppError(422, 'recovery_signature', 'That signature was not made with this vault\'s recovery key over this recovery. Check the code. Nothing was sent.')
  // R13: before anything is relayed, the passkey being added must have confirmed this very request. A request already
  // relayed (a lost reply asked again) sends nothing new: the vault service answers with the same job.
  if (!r.jobId) {
    const conf = b.confirmation as { challengeId?: unknown; response?: unknown } | undefined
    if (!conf || typeof conf !== 'object') throw refused('confirmation_needed', 'Confirm this recovery with the passkey it adds. Nothing was sent.')
    const name = db.get<{ name: string }>('SELECT name FROM webauthn_credentials WHERE id = ?', r.credentialId)?.name ?? 'the passkey being added'
    const ok = await finishReauth(db, rp, who.session, 'approval', { challengeId: conf.challengeId, response: conf.response }, now)
    if (ok.credential.id !== r.credentialId || ok.context.purpose !== 'vault-recovery' || ok.context.requestId !== b.requestId || conf.challengeId !== r.confirmChallengeId) {
      securityEvent(db, who.personId, 'vault-recovery-refused', { workspace: who.workspaceId, passkey: name, confirmedWith: ok.credential.name }, now)
      throw refused('confirm_with_added_passkey', `Only "${name}", the passkey this recovery adds, can confirm it, and only for this request. It was confirmed with "${ok.credential.name}"${ok.context.requestId !== b.requestId ? ' for another request' : ''}. Nothing was sent: start again and confirm with "${name}".`)
    }
  }
  const v = mustVault(db, who.workspaceId)
  const sig = b.signature as { r: string; s: string }
  // R13: with a guardian, nothing is relayed yet: the request waits for the recovery contact's co-signature
  if (r.guardian && !r.jobId) {
    if (!r.awaitingGuardianSince) {
      r.signature = { r: sig.r, s: sig.s }
      r.awaitingGuardianSince = now
      const contact = personOf(db, r.guardian.personId), me = personOf(db, who.personId)
      db.tx(() => {
        db.run('UPDATE meta SET value = ? WHERE key = ?', j(r), key)
        notice(db, r.guardian!.personId, { level: 'warning', kind: 'vault-guardian-request', title: `${me.name} asks you to co-sign a recovery of their wallet`, body: `You are the guardian of ${me.name}'s on-chain wallet. A recovery with one of its recovery codes is waiting for your co-signature, until ${new Date(r.expiresAt).toISOString()}. Before you co-sign, check with ${me.name} in person or by a call that they asked for it. Open Security, "Recoveries waiting for you".`, dedupe: `vault-guardian-request:${b.requestId as string}` }, now)
        notice(db, who.workspaceId, { level: 'warning', kind: 'vault-recovery', title: 'A recovery of the vault is waiting for the guardian', body: `${me.name} started a recovery with a recovery code. It is sent only when ${contact.name}, this wallet's guardian, co-signs it. If nobody here started it, tell ${contact.name} not to co-sign; the code itself is not spent until the recovery is sent.`, subject: r.recoverySignerId, dedupe: `vault-recovery-waiting:${b.requestId as string}` }, now)
        securityEvent(db, who.personId, 'vault-recovery-awaiting-guardian', { workspace: who.workspaceId, guardian: contact.name }, now)
        audit(db, now, who.workspaceId, 'owner', 'vault.recovery.awaiting-guardian', null, { requestId: b.requestId, guardian: r.guardian!.personId })
      })
    }
    return { requestId: String(b.requestId), awaitingGuardian: { person: personOf(db, r.guardian.personId).name, until: r.expiresAt } }
  }
  const accepted = await must(cfg, 'POST', at(v, '/recoveries'), { recoverySignerId: r.recoverySignerId, newKey: r.newKey, deadline: r.deadline, signature: { r: sig.r, s: sig.s } }, { 'Idempotency-Key': `vrec-${b.requestId as string}` })
  r.jobId = String(accepted.jobId)
  // one transaction after the wait: its writes together, or none (brief item 2)
  db.tx(() => {
    db.run('UPDATE meta SET value = ? WHERE key = ?', j(r), key)
    const name = db.get<{ name: string }>('SELECT name FROM webauthn_credentials WHERE id = ?', r.credentialId)?.name ?? 'a passkey'
    notice(db, who.workspaceId, { level: 'warning', kind: 'vault-recovery', title: 'A recovery of the vault has started', body: `${personOf(db, who.personId).name} started a recovery with a recovery code: "${name}" becomes a signer of the vault when its delay ends. If nobody here started it, cancel it under Security, "Who can sign for your on-chain wallet", with any passkey that signs for the wallet: that also spends the code.`, subject: r.recoverySignerId, dedupe: `vault-recovery:${b.requestId as string}:by:${who.personId}` }, now) // its starter may not clear it (api.ts mayClearWhoCanAct, lead L-10)
    securityEvent(db, who.personId, 'vault-recovery-started', { workspace: who.workspaceId, passkey: name }, now)
    audit(db, now, who.workspaceId, 'owner', 'vault.recovery.start', String(accepted.jobId), { duplicate: accepted.duplicate === true })
  })
  return { requestId: String(b.requestId), jobId: String(accepted.jobId), duplicate: accepted.duplicate === true }
}

// ------------------------------------------------------------------------------------------------ R13: owner options

/** A vault recovery request as kept in meta (`vault.recovery-request:<id>`) from its start until it is relayed or lapses. */
interface RecoveryRequest {
  ws: string; person: string; credentialId: string; recoverySignerId: string; recoveryKey: { x: string; y: string }; newKey: { x: string; y: string }
  deadline: string; digest: string; confirmChallengeId?: string; expiresAt: number; jobId?: string
  /** R13: the wallet's guardian, a passkey of the person's recovery contact, which must co-sign before anything is relayed. */
  guardian?: { signerId: string; x: string; y: string; personId: string; credentialId: string }
  /** R13: the recovery key's signature, kept until the guardian co-signs; when the person finished their part. */
  signature?: { r: string; s: string }
  awaitingGuardianSince?: number
  cosignedAt?: number
  declinedAt?: number
  /** R13 review fix F1: the guardian withdrew its co-signature (cancelled the recovery on the chain). */
  withdrawnAt?: number
  withdrawJobId?: string
}

/** The guardian's credential in QED, from the chain's view of the account (absent before R13, or when it is no QED passkey). */
function guardianOf(db: Db, s: RailSigners): { credential: Credential } | null {
  if (!s.guardian?.signerId || !s.guardian.x || !s.guardian.y) return null
  const c = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE lower(x) = ? AND lower(y) = ?', s.guardian.x.slice(2).toLowerCase(), s.guardian.y.slice(2).toLowerCase())
  return c ? { credential: c } : null
}

/**
 * Set a guardian (a passkey of one of the person's active recovery contacts: their newest passkey that can sign) or
 * remove it. Always behind the wallet's delay, which any signer can cancel; the chain decides. A household's option only.
 */
export async function proposeGuardian(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['contactId', 'remove'], 'A guardian')
  mayAdminister(db, who)
  if (isShared(db, who.workspaceId)) throw refused('household_only', 'A guardian is a person\'s recovery contact: it is offered for a household\'s wallet. A shared workspace\'s wallet is recovered by its members.')
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  if (s.guardian?.supported !== true) throw refused('owner_options_unavailable', 'This wallet was set up before guardians existed: its owner account keeps the bytecode it was created with and gains nothing. A new wallet has them.')
  if (b.remove === true) {
    if (Object.keys(b).length !== 1) throw bad('Removing the guardian takes { remove: true } and nothing else.')
    if (!s.guardian.signerId) throw refused('no_guardian', 'This wallet has no guardian to remove.')
    const out = await proposeOnRail(cfg, db, who, 'set-guardian', { remove: true }, now, { guardian: { remove: true, delaySeconds: s.delaySeconds } })
    audit(db, now, who.workspaceId, 'owner', 'vault.guardian.remove.propose', null, {})
    return out
  }
  if (typeof b.contactId !== 'string' || !activeContacts(db, who.personId, now).includes(b.contactId)) throw notFound('That recovery contact')
  const c = approvingCredentials(db, b.contactId).filter((x) => stateOf(x) === 'active').sort((p, q) => q.created_at - p.created_at)[0]
  const contact = personOf(db, b.contactId)
  if (!c) throw refused('contact_has_no_passkey', `${contact.name} has no passkey that can sign in QED, so it cannot be a guardian. Ask them to add one first.`)
  if (s.signers.some((k) => sameKey(c, k))) throw refused('already_a_signer', `${contact.name}'s passkey is already on this wallet.`)
  const out = await proposeOnRail(cfg, db, who, 'set-guardian', pub(c), now, { guardian: { person: contact.name, handle: contact.handle, delaySeconds: s.delaySeconds } })
  db.tx(() => {
    notice(db, b.contactId as string, { level: 'info', kind: 'vault-guardian-named', title: `${personOf(db, who.personId).name} is making you the guardian of their wallet`, body: `Once ${personOf(db, who.personId).name} approves it and the wallet's delay has passed, a recovery of their on-chain wallet starts only when you co-sign it with your passkey, in your own QED session. You approve, cancel or move nothing on their wallet. You will be asked only when they start a recovery.`, dedupe: `vault-guardian-named:${who.workspaceId}:${c.id}` }, now)
    audit(db, now, who.workspaceId, 'owner', 'vault.guardian.propose', c.id, { contact: b.contactId })
  })
  return out
}

/** The time-lock of withdraw, ring-fence, resume and the vault's guardian: on at once, off after the wallet's delay. */
export async function proposeTimeLock(cfg: RailCfg, db: Db, who: Asker, raw: unknown, now: number): Promise<Json> {
  const b = only(raw, ['on'], 'The time-lock')
  mayAdminister(db, who)
  if (typeof b.on !== 'boolean') throw bad('The time-lock is { on: true } or { on: false }.')
  const s = await chainSigners(cfg, db, who.workspaceId, now)
  if (s.timeLock?.supported !== true) throw refused('owner_options_unavailable', 'This wallet was set up before the time-lock existed: its owner account keeps the bytecode it was created with and gains nothing. A new wallet has it.')
  if (s.timeLock.on === b.on) throw refused('nothing_to_change', `The time-lock is already ${b.on ? 'on' : 'off'}.`)
  const out = await proposeOnRail(cfg, db, who, 'set-time-lock', { on: b.on }, now, { timeLock: { on: b.on, delaySeconds: s.delaySeconds } })
  audit(db, now, who.workspaceId, 'owner', 'vault.time-lock.propose', null, { on: b.on })
  return out
}

const guardianRequest = (db: Db, who: Asker, id: unknown): { key: string; r: RecoveryRequest } => {
  const key = `vault.recovery-request:${typeof id === 'string' && /^vrq-[0-9a-f]{24}$/.test(id) ? id : ''}`
  const r = parse<RecoveryRequest | null>(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? 'null', null)
  // only the guardian's own person sees or answers it
  if (!r?.guardian || r.guardian.personId !== who.personId) throw notFound('That request')
  return { key, r }
}

/** Recoveries of other people's wallets waiting for this person's co-signature as their guardian (R13). */
export function guardianRequests(db: Db, who: Asker, now: number): Json {
  const out: Json[] = [], cosigned: Json[] = []
  for (const row of db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE 'vault.recovery-request:%'`)) {
    const r = parse<RecoveryRequest | null>(row.value, null)
    if (!r?.guardian || r.guardian.personId !== who.personId) continue
    const asker = personOf(db, r.person), requestId = row.key.slice('vault.recovery-request:'.length)
    // R13 review fix F1: a recovery this person co-signed may be withdrawn until it finishes (the chain decides whether it still can)
    if (r.jobId && r.cosignedAt && !r.withdrawnAt && now - r.cosignedAt < 60 * 86_400_000) { cosigned.push({ requestId, from: { name: asker.name, handle: asker.handle }, cosignedAt: r.cosignedAt }); continue }
    if (!r.awaitingGuardianSince || r.jobId || r.declinedAt || now > r.expiresAt) continue
    out.push({ requestId, from: { name: asker.name, handle: asker.handle }, since: r.awaitingGuardianSince, until: r.expiresAt, digest: r.digest })
  }
  return { requests: out, cosigned, words: 'You are the guardian of these wallets: a recovery of one starts only when you co-sign it. Co-sign only after you have checked with the person, in person or by a call, that they asked for it. A recovery you co-sign cannot be cancelled by a passkey QED froze; any other passkey of theirs can still cancel it, and you can withdraw your co-signature until it finishes. They can also stop it from QED, even while every passkey of theirs is frozen.' }
}

/** The passkey prompt for the guardian's co-signature: the challenge is the recovery's own digest, offered to the guardian's passkey only. */
export async function beginGuardianCosign(db: Db, rp: RelyingParty, who: Asker, id: unknown, now: number): Promise<Json> {
  const { r } = guardianRequest(db, who, id)
  if (!r.awaitingGuardianSince || r.jobId || r.declinedAt || now > r.expiresAt) throw refused('request_closed', 'This recovery is no longer waiting for you.')
  const c = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', r.guardian!.credentialId)
  if (!c || stateOf(c) !== 'active') throw refused('passkey_not_usable', 'The passkey that is this wallet\'s guardian can no longer sign in QED. The wallet\'s owner must replace the guardian.')
  return beginReauth(db, rp, who.personId, 'approval', Uint8Array.from(Buffer.from(r.digest.slice(2), 'hex')), { purpose: 'vault-guardian-cosign', requestId: id }, now, [c.id])
}

const b64 = (v: unknown): Buffer => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v)) throw bad('That passkey response is malformed.'); return Buffer.from(v, 'base64url') }

/**
 * The guardian co-signs: the assertion is checked here (this very request, the guardian's passkey, the wallet's origin),
 * then the recovery is relayed with the recovery key's signature and the co-signature; the chain checks both.
 */
export async function finishGuardianCosign(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, id: unknown, raw: unknown, now: number): Promise<Json> {
  const { key, r } = guardianRequest(db, who, id)
  const b = only(raw, ['challengeId', 'response'], 'A co-signature')
  if (r.jobId) return { requestId: id, jobId: r.jobId, duplicate: true }
  if (!r.awaitingGuardianSince || !r.signature || r.declinedAt || now > r.expiresAt) throw refused('request_closed', 'This recovery is no longer waiting for you.')
  const ok = await finishReauth(db, rp, who.session, 'approval', { challengeId: b.challengeId, response: b.response }, now)
  if (ok.credential.id !== r.guardian!.credentialId || ok.context.purpose !== 'vault-guardian-cosign' || ok.context.requestId !== id) throw refused('approval_mismatch', 'That signature was made for something else, or with a passkey that is not the guardian. Nothing was sent.')
  const v = mustVault(db, r.ws)
  const resp = (b.response as { response?: { authenticatorData?: unknown; clientDataJSON?: unknown; signature?: unknown } }).response ?? {}
  const clientDataJSON = b64(resp.clientDataJSON).toString('utf8')
  const origin = parse<{ origin?: string }>(clientDataJSON, {}).origin
  if (origin !== v.request.origin) throw refused('vault_origin', `This wallet takes signatures made at ${v.request.origin} only; this one was made at ${origin ?? 'an unknown origin'}. Open QED at ${v.request.origin} to co-sign. Nothing was sent.`)
  const cosign = { publicKey: { x: `0x${ok.credential.x}`, y: `0x${ok.credential.y}` }, authenticatorData: `0x${b64(resp.authenticatorData).toString('hex')}`, clientDataJSON, signature: `0x${b64(resp.signature).toString('hex')}` }
  const accepted = await must(cfg, 'POST', at(v, '/recoveries'), { recoverySignerId: r.recoverySignerId, newKey: r.newKey, deadline: r.deadline, signature: r.signature, cosign }, { 'Idempotency-Key': `vrec-${id as string}` })
  r.jobId = String(accepted.jobId)
  r.cosignedAt = now
  const contact = personOf(db, who.personId), owner = personOf(db, r.person)
  db.tx(() => {
    db.run('UPDATE meta SET value = ? WHERE key = ?', j(r), key)
    notice(db, r.ws, { level: 'warning', kind: 'vault-recovery', title: `${contact.name} co-signed the recovery of the vault`, body: `${contact.name}, this wallet's guardian, co-signed the recovery ${owner.name} started with a recovery code. The new passkey becomes a signer when the recovery delay ends, unless a passkey of this wallet that is not frozen cancels it under Security. A passkey QED froze cannot cancel it.`, subject: r.recoverySignerId, dedupe: `vault-recovery-cosigned:${id as string}` }, now)
    securityEvent(db, r.person, 'vault-recovery-cosigned', { workspace: r.ws, guardian: contact.name }, now)
    audit(db, now, r.ws, 'system', 'vault.recovery.cosigned', String(accepted.jobId), { requestId: id, guardian: who.personId })
  })
  return { requestId: id, jobId: String(accepted.jobId), duplicate: accepted.duplicate === true }
}

/** The on-chain id of the recovery a co-signed request started (from the vault service's job that relayed it). */
async function recoveryIdOf(cfg: RailCfg, v: { railId: string }, r: RecoveryRequest): Promise<string> {
  const job = r.jobId ? await settled(cfg, v, r.jobId) : null
  const id = (job?.result as { evidence?: { recoveryId?: unknown } } | undefined)?.evidence?.recoveryId
  if (typeof id !== 'string' || !/^0x[0-9a-f]{64}$/.test(id)) throw refused('recovery_unknown', 'QED cannot find the recovery this co-signature started on the chain. Nothing was sent.')
  return id
}

/**
 * R13 review fix F1: the guardian withdraws its co-signature. The passkey prompt's challenge is the owner account's cancel
 * digest for the recovery it co-signed, offered to the guardian's passkey only; the vault service refuses unless that
 * recovery is still pending and co-signed.
 */
export async function beginGuardianWithdraw(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, id: unknown, now: number): Promise<Json> {
  const { r } = guardianRequest(db, who, id)
  if (!r.jobId || !r.cosignedAt) throw refused('not_cosigned', 'You have not co-signed this recovery: there is nothing to withdraw.')
  if (r.withdrawnAt) throw refused('already_withdrawn', 'You withdrew your co-signature of this recovery already.')
  const c = db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ?', r.guardian!.credentialId)
  if (!c || stateOf(c) !== 'active') throw refused('passkey_not_usable', 'The passkey that co-signed this recovery can no longer sign in QED. Ask the wallet\'s owner to cancel the recovery with one of their passkeys that is not frozen.')
  const v = mustVault(db, r.ws)
  const recoveryId = await recoveryIdOf(cfg, v, r)
  const d = await must(cfg, 'GET', at(v, `/recoveries/${recoveryId}/withdraw-digest`))
  return beginReauth(db, rp, who.personId, 'approval', Uint8Array.from(Buffer.from(String(d.digest).slice(2), 'hex')), { purpose: 'vault-guardian-withdraw', requestId: id, recoveryId }, now, [c.id])
}

/** The guardian's withdrawal, checked here (this request, the guardian's passkey, the wallet's origin), then relayed; the chain checks it again. */
export async function finishGuardianWithdraw(cfg: RailCfg, db: Db, rp: RelyingParty, who: Asker, id: unknown, raw: unknown, now: number): Promise<Json> {
  const { key, r } = guardianRequest(db, who, id)
  const b = only(raw, ['challengeId', 'response'], 'A withdrawal')
  if (r.withdrawJobId) return { requestId: id, jobId: r.withdrawJobId, duplicate: true }
  if (!r.jobId || !r.cosignedAt) throw refused('not_cosigned', 'You have not co-signed this recovery: there is nothing to withdraw.')
  const ok = await finishReauth(db, rp, who.session, 'approval', { challengeId: b.challengeId, response: b.response }, now)
  if (ok.credential.id !== r.guardian!.credentialId || ok.context.purpose !== 'vault-guardian-withdraw' || ok.context.requestId !== id) throw refused('approval_mismatch', 'That signature was made for something else, or with a passkey that is not the guardian. Nothing was sent.')
  const v = mustVault(db, r.ws)
  const resp = (b.response as { response?: { authenticatorData?: unknown; clientDataJSON?: unknown; signature?: unknown } }).response ?? {}
  const clientDataJSON = b64(resp.clientDataJSON).toString('utf8')
  const origin = parse<{ origin?: string }>(clientDataJSON, {}).origin
  if (origin !== v.request.origin) throw refused('vault_origin', `This wallet takes signatures made at ${v.request.origin} only; this one was made at ${origin ?? 'an unknown origin'}. Open QED at ${v.request.origin} to withdraw. Nothing was sent.`)
  const assertion = { publicKey: { x: `0x${ok.credential.x}`, y: `0x${ok.credential.y}` }, authenticatorData: `0x${b64(resp.authenticatorData).toString('hex')}`, clientDataJSON, signature: `0x${b64(resp.signature).toString('hex')}` }
  const accepted = await must(cfg, 'POST', at(v, `/recoveries/${String(ok.context.recoveryId)}/withdraw`), { assertion }, { 'Idempotency-Key': `vwd-${id as string}-${randomBytes(8).toString('hex')}` }) // a new key per attempt: a refused attempt is not replayed (re-check of H1)
  // reported only once the chain has it: a recovery that finished meanwhile is refused there, and nothing is recorded here
  const done = (await settled(cfg, v, String(accepted.jobId)))?.result as { outcome?: string; summary?: string } | undefined
  if (done?.outcome !== 'executed') throw refused('withdraw_refused', done?.summary ?? 'The vault service did not confirm the withdrawal in time. Look at the recovery on their Security page before you try again.')
  r.withdrawJobId = String(accepted.jobId)
  r.withdrawnAt = now
  const contact = personOf(db, who.personId)
  db.tx(() => {
    db.run('UPDATE meta SET value = ? WHERE key = ?', j(r), key)
    notice(db, r.ws, { level: 'warning', kind: 'vault-recovery', title: `${contact.name} withdrew their co-signature of a recovery`, body: `${contact.name}, this wallet's guardian, withdrew the co-signature they gave to the recovery ${personOf(db, r.person).name} started: the recovery is cancelled on the chain and its recovery code is spent. If you did start it, start again with another code; if nobody here did, that code was known to someone else.`, subject: r.recoverySignerId, dedupe: `vault-recovery-withdrawn:${id as string}` }, now)
    securityEvent(db, r.person, 'vault-recovery-withdrawn', { workspace: r.ws, guardian: contact.name }, now)
    audit(db, now, r.ws, 'system', 'vault.recovery.guardian-withdrew', String(accepted.jobId), { requestId: id, guardian: who.personId })
  })
  return { requestId: id, jobId: String(accepted.jobId), duplicate: accepted.duplicate === true }
}

/**
 * R13 H1: stop a pending recovery of this vault that the guardian co-signed, with the vault service's sentinel key: the
 * owner's own way to challenge it through QED, even while every passkey of the wallet is frozen. Only a person who may sign
 * for the vault, confirmed afresh (the route asks for the step-up) with a passkey that is neither suspended nor removed: a
 * suspended passkey, or a password session, cannot. The vault service refuses anything but a pending co-signed recovery.
 */
export async function stopVaultRecovery(cfg: RailCfg, db: Db, who: Asker, id: unknown, now: number): Promise<Json> {
  if (typeof id !== 'string' || !/^0x[0-9a-f]{64}$/.test(id)) throw bad('A recovery is named by its id: 0x followed by 64 hexadecimal characters.')
  const by = who.session.confirmedBy ? db.get<Credential>('SELECT * FROM webauthn_credentials WHERE id = ? AND person_id = ? AND removed_at IS NULL AND suspended_at IS NULL', who.session.confirmedBy, who.personId) : undefined
  if (!by) throw refused('passkey_not_usable', 'Confirm with one of your passkeys that is neither suspended nor removed to stop a recovery. Nothing was sent.')
  if (isShared(db, who.workspaceId) ? !canSign(who.role) : who.workspaceId !== who.personId) throw new AppError(403, 'not_permitted', 'Only a person who may sign for this vault can stop one of its recoveries.')
  const v = mustVault(db, who.workspaceId)
  const accepted = await must(cfg, 'POST', at(v, `/recoveries/${id}/stop`), {}, { 'Idempotency-Key': `vst-${id}-${randomBytes(8).toString('hex')}` }) // a new key per attempt: a refused attempt is not replayed (re-check of H1)
  const done = (await settled(cfg, v, String(accepted.jobId)))?.result as { outcome?: string; summary?: string } | undefined
  if (done?.outcome !== 'executed') throw refused('stop_refused', done?.summary ?? 'The vault service did not confirm in time. Look at the recovery again before you try once more.')
  db.tx(() => {
    notice(db, who.workspaceId, { level: 'warning', kind: 'vault-recovery', title: 'A recovery of the vault was stopped', body: `${personOf(db, who.personId).name} stopped a recovery of this wallet that the guardian had co-signed, from QED with the wallet's sentinel key, confirmed with the passkey "${by.name}". The recovery code it used is spent. If it was yours, start again with another code.`, dedupe: `vault-recovery-stopped:${id}` }, now)
    securityEvent(db, who.personId, 'vault-recovery-stopped', { workspace: who.workspaceId, passkey: by.name }, now)
    audit(db, now, who.workspaceId, 'owner', 'vault.recovery.stop', String(accepted.jobId), { recoveryId: id })
  })
  return { recoveryId: id, jobId: String(accepted.jobId), duplicate: accepted.duplicate === true }
}

/** The guardian declines: nothing is sent, the recovery code is not spent, and the wallet's household is told. */
export function declineGuardianCosign(db: Db, who: Asker, id: unknown, now: number): Json {
  const { key, r } = guardianRequest(db, who, id)
  if (r.jobId) throw refused('already_cosigned', 'You co-signed this recovery already; it was sent.')
  if (r.declinedAt) return { requestId: id, declined: true }
  r.declinedAt = now
  db.tx(() => {
    db.run('UPDATE meta SET value = ? WHERE key = ?', j(r), key)
    notice(db, r.ws, { level: 'warning', kind: 'vault-recovery', title: `${personOf(db, who.personId).name} declined to co-sign a recovery`, body: `The guardian declined the recovery ${personOf(db, r.person).name} started. Nothing was sent and the recovery code was not spent. If nobody here started it, the code may be known to someone else: replace it under Security.`, subject: r.recoverySignerId, dedupe: `vault-recovery-declined:${id as string}` }, now)
    audit(db, now, r.ws, 'system', 'vault.recovery.guardian-declined', null, { requestId: id, guardian: who.personId })
  })
  return { requestId: id, declined: true }
}
