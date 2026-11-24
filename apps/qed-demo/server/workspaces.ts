/**
 * Workspaces and who may act in them (R7, D1). A person's personal workspace is their own users row; a business
 * workspace is a users row of kind 'business' that people belong to with a role. Every financial record is keyed by
 * the workspace (the user_id column), and every request is resolved to (person, workspace, role) before any handler
 * runs, so a handler can only ever see the workspace the person is a member of.
 *
 * Roles: owner and admin manage members and policy; owner, admin and approver may sign approvals; operator may
 * prepare but not sign; viewer may only look.
 *
 * Giving a member authority (R13 hardening; Q-048 as the owner decided it): adding a member as an operator, approver, admin
 * or owner, or raising a member's role, is a loosening under the 72-hour rule (server/loosening.ts): it is scheduled
 * (scheduled_changes, kind 'grant-member'), applied by the engine's tick when the protection delay ends
 * (passkeys.ts applyDueChanges), cancellable meanwhile by any member who may sign (cancelScheduledChange), and every
 * member who may sign, the person who asked and that person's recovery contacts are told at once. Adding a viewer, who may
 * only look, grants no authority and applies at once. Narrowing applies at once: lowering a member's role, or removing a
 * member, and it withdraws a grant still waiting for them.
 *
 * Approval policy of a business workspace: how many distinct members must sign, a larger number above a size (the first
 * "large" rule, and amount bands: each band says from what amount how many members must sign, the highest band that the
 * amount reaches applying), a delegated limit for each member (the most that member may prepare or sign alone), and
 * maker-checker (whoever prepared a request cannot be one of its signers). Raising a requirement or lowering a limit takes
 * effect at once; lowering a requirement or raising a limit is a change that reduces protection and waits out the delay
 * (scheduled_changes).
 *
 * Who checks what (R13, I1): QED checks the bands and the limits, always, in this file and approvals.ts. The chain checks
 * only what the vault's owner account supports: one count of distinct member signatures (its threshold) for every owner
 * action, whatever the amount, and the same for every member. It has no amount band and no per-member limit, so a band or
 * limit is never claimed to be enforced on the chain (see enforcementOf).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError, audit, bad, type Db, emit, j, newId, parse } from './core.ts'
import { activeContacts, handleOf, PROTECTION_DELAY_MS, securityEvent } from './passkeys.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

export type Role = 'owner' | 'admin' | 'approver' | 'operator' | 'viewer'
export const ROLES: Role[] = ['owner', 'admin', 'approver', 'operator', 'viewer']
const RANK: Record<Role, number> = { owner: 4, admin: 3, approver: 2, operator: 1, viewer: 0 }
export const canSign = (r: Role): boolean => RANK[r] >= RANK.approver
export const canPrepare = (r: Role): boolean => RANK[r] >= RANK.operator
export const canAdminister = (r: Role): boolean => RANK[r] >= RANK.admin

export interface Band { fromPaise: number; signers: number }
export interface Policy { signers: number; makerChecker: boolean; largePaise: number | null; largeSigners: number | null; bands: Band[]; limits: Record<string, number> }
const PERSONAL: Policy = { signers: 1, makerChecker: false, largePaise: null, largeSigners: null, bands: [], limits: {} }
/** A new business workspace has one member, so one signature; members and stricter rules are added afterwards. */
const NEW_BUSINESS: Policy = { signers: 1, makerChecker: false, largePaise: null, largeSigners: null, bands: [], limits: {} }
export const MAX_BANDS = 6

/**
 * Who is acting, for code below the API that must record it (createApproval records the maker). `authMethod` and
 * `session`: how the request's session was opened and its id as Security lists it, from the server's session record,
 * so that what a password session prepares says so (server/prepared.ts).
 */
export const actor = new AsyncLocalStorage<{ personId: string; workspaceId: string; role: Role; authMethod?: string; session?: string }>()

export function membership(db: Db, workspaceId: string, personId: string): { role: Role } | undefined {
  return db.get<{ role: Role }>('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', workspaceId, personId)
}

export function policyOf(db: Db, workspaceId: string): Policy {
  const w = db.get<{ kind: string; policy_json: string }>('SELECT kind, policy_json FROM users WHERE id = ?', workspaceId)
  if (!w || w.kind !== 'business') return PERSONAL
  return { ...NEW_BUSINESS, ...parse<Partial<Policy>>(w.policy_json, {}) }
}

/** Distinct members who must sign an approval of this size under this policy: the base count, the large rule, and the highest band the size reaches. */
export function requiredFor(p: Policy, sizePaise: number | null): number {
  let n = p.signers
  if (sizePaise === null) return n
  if (p.largePaise !== null && p.largeSigners !== null && sizePaise >= p.largePaise) n = Math.max(n, p.largeSigners)
  for (const b of p.bands) if (sizePaise >= b.fromPaise) n = Math.max(n, b.signers)
  return n
}
/** Distinct members who must sign an approval of this size in this workspace. */
export function requiredSigners(db: Db, workspaceId: string, sizePaise: number | null): number {
  return requiredFor(policyOf(db, workspaceId), sizePaise)
}
/** A member's delegated limit in paise, or null when the workspace set none for them. */
export const limitOf = (p: Policy, personId: string): number | null => (typeof p.limits[personId] === 'number' ? p.limits[personId]! : null)
/** Whether an amount is within a member's delegated limit (a request with no stated amount is not measured). */
export const withinLimit = (p: Policy, personId: string, sizePaise: number | null): boolean => { const l = limitOf(p, personId); return l === null || !sizePaise || sizePaise <= l }
export const overLimitText = (limitPaise: number): string => `That is above your limit of ${homeMoneyExact(limitPaise)}. A member whose limit covers it prepares or signs it.`

/**
 * Who checks the rule, for the screen to say (R13, I1). `vault`: the workspace has an on-chain vault, whose own owner
 * account checks `threshold` distinct member signatures on every owner action. Bands and limits are QED's alone.
 */
export function enforcementOf(vault: { threshold: number } | null): { chain: { checks: string[]; threshold: number | null }; qedAlone: string[]; note: string } {
  const qedAlone = ['A larger count of signatures for a larger amount (the bands and the large-amount rule)', 'Each member\'s limit on what they may prepare or sign']
  return {
    chain: { threshold: vault?.threshold ?? null, checks: vault ? [`${vault.threshold} distinct member signature${vault.threshold === 1 ? '' : 's'} on every action of the on-chain vault, whatever its size`] : [] },
    qedAlone,
    note: vault
      ? `The vault's owner account checks one count of signatures (${vault.threshold}) for every action of the vault. It has no amount bands and no member limits, so QED alone checks those, before it asks the chain. Anyone who could reach the vault's service directly would not meet them.`
      : 'This workspace has no on-chain vault: QED alone checks the count, the bands and the limits, on its own records.',
  }
}

export function listWorkspaces(db: Db, personId: string): { id: string; name: string; kind: string; role: Role; members: number }[] {
  return db.all<{ id: string; name: string; kind: string; role: Role; members: number }>(
    `SELECT u.id, u.display_name name, u.kind, m.role, (SELECT COUNT(*) FROM memberships x WHERE x.workspace_id = u.id AND x.removed_at IS NULL) members
       FROM memberships m JOIN users u ON u.id = m.workspace_id WHERE m.person_id = ? AND m.removed_at IS NULL ORDER BY u.kind DESC, u.created_at`, personId)
}

export function createBusiness(db: Db, personId: string, name: unknown, now: number): string {
  const n = typeof name === 'string' ? name.trim().slice(0, 60) : ''
  if (n.length < 2) throw bad('Give the business a name.', { name: 'At least two characters.' })
  const id = newId('wsp', now)
  db.tx(() => {
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind, policy_json) VALUES (?, ?, ?, '!', ?, 'business', ?)`, id, `ws-${id.slice(4).toLowerCase()}`, n, now, j(NEW_BUSINESS))
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, 'owner', ?, ?)`, id, personId, now, personId)
    audit(db, now, id, 'owner', 'workspace.create', id, { by: personId, name: n })
  })
  return id
}

/** Members, with what each may do. Visible to every member. */
export function members(db: Db, workspaceId: string): { personId: string; handle: string; name: string; role: Role; since: number }[] {
  return db.all('SELECT m.person_id personId, u.handle, u.display_name name, m.role, m.created_at since FROM memberships m JOIN users u ON u.id = m.person_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY m.created_at', workspaceId)
}

/**
 * Put a person in a workspace with a role, at once. Only an owner or admin may, and nobody may grant a role above their own.
 * The route adds members through requestMember, which waits out the protection delay for any role with authority; this is
 * what a grant does when its delay ends, and what tests use to set a workspace up.
 */
export function addMember(db: Db, workspaceId: string, by: { personId: string; role: Role }, handle: unknown, role: unknown, now: number): void {
  const { person, role: r } = checkGrant(db, workspaceId, by, handle, role)
  if (membership(db, workspaceId, person)) throw new AppError(409, 'already_member', 'That person is already a member.')
  db.tx(() => {
    db.run('INSERT INTO memberships (workspace_id, person_id, role, created_at, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, person_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at, added_by = excluded.added_by, removed_at = NULL', workspaceId, person, r, now, by.personId)
    audit(db, now, workspaceId, 'owner', 'member.add', person, { role: r, by: by.personId })
    securityEvent(db, person, 'added-to-workspace', { workspaceId, role: r }, now)
  })
}

/** Who may give whom which role: an owner or admin, never above their own role, to a person who exists. */
function checkGrant(db: Db, workspaceId: string, by: { personId: string; role: Role }, handle: unknown, role: unknown): { person: string; role: Role } {
  if (!canAdminister(by.role)) throw new AppError(403, 'not_permitted', 'Only an owner or an admin can add members or change their roles.')
  const r = role as Role
  if (!ROLES.includes(r)) throw bad('Choose a role.', { role: 'Choose one of the roles.' })
  if (RANK[r] > RANK[by.role]) throw new AppError(403, 'not_permitted', 'You cannot give someone a role above your own.')
  const p = db.get<{ id: string }>(`SELECT id FROM users WHERE handle = ? AND kind = 'person'`, typeof handle === 'string' ? handle.trim().toLowerCase().replace(/^@/, '') : '')
  if (!p) throw new AppError(404, 'not_found', 'Nobody has that handle.', { handle: 'Nobody has that handle.' })
  return { person: p.id, role: r }
}

/** The scheduled change's kind for giving a member authority (scheduled_changes.kind). */
export const GRANT_MEMBER = 'grant-member'
/** A role that gives authority to act: everything but viewer, who may only look. */
export const grantsAuthority = (r: Role): boolean => RANK[r] >= RANK.operator
export interface PendingGrant { id: string; personId: string; handle: string; role: Role; before: Role | null; requestedBy: string; requestedAt: number; effectiveAt: number }
/** Grants waiting out their delay in this workspace. */
export function pendingGrants(db: Db, workspaceId: string): PendingGrant[] {
  return db.all<{ id: string; subject: string; person_id: string; requested_at: number; effective_at: number; detail_json: string }>(`SELECT id, subject, person_id, requested_at, effective_at, detail_json FROM scheduled_changes WHERE workspace_id = ? AND kind = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at`, workspaceId, GRANT_MEMBER)
    .map((c) => { const d = parse<{ role?: Role; before?: Role | null; handle?: string }>(c.detail_json, {}); return { id: c.id, personId: c.subject, handle: d.handle ?? handleOf(db, c.subject), role: d.role ?? 'viewer', before: d.before ?? null, requestedBy: c.person_id, requestedAt: c.requested_at, effectiveAt: c.effective_at } })
}

/**
 * Give a person a role in this workspace: a new member, or a member's role raised. A role with authority (operator and
 * above) is a loosening and waits out the protection delay; a viewer is added at once. A grant asked again for the same
 * person replaces the one waiting and starts its delay again. `beforeLoosening` runs before a grant is scheduled (the route
 * refuses a passkey in its cool-off there). Every member who may sign, the person who asked and that person's recovery
 * contacts are told; the person to be given the role is told too.
 */
export function requestMember(db: Db, workspaceId: string, by: { personId: string; role: Role; beforeLoosening?: () => void }, handle: unknown, role: unknown, now: number): { applied: boolean; changeId: string | null; effectiveAt: number | null } {
  if (db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', workspaceId)?.kind !== 'business') throw new AppError(409, 'personal_workspace', 'Members are added to a shared workspace. Create one under Workspace first.')
  const { person, role: r } = checkGrant(db, workspaceId, by, handle, role)
  const cur = membership(db, workspaceId, person)?.role ?? null
  if (cur !== null && RANK[r] <= RANK[cur]) throw new AppError(409, 'not_a_raise', cur === r ? 'That member already has that role.' : 'That is a lower role than the member has: change their role instead, which takes effect at once.')
  if (cur === null && !grantsAuthority(r)) { addMember(db, workspaceId, by, handle, r, now); return { applied: true, changeId: null, effectiveAt: null } }
  by.beforeLoosening?.()
  return db.tx(() => {
    db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'replaced' WHERE workspace_id = ? AND kind = ? AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, now, workspaceId, GRANT_MEMBER, person)
    const changeId = newId('chg', now), effectiveAt = now + PROTECTION_DELAY_MS
    const h = handleOf(db, person)
    db.run('INSERT INTO scheduled_changes (id, person_id, workspace_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', changeId, by.personId, workspaceId, GRANT_MEMBER, person, j({ role: r, before: cur, handle: h }), now, by.personId, effectiveAt)
    const detail = { workspaceId, changeId, person: h, role: r, before: cur, effectiveAt }
    for (const who of new Set([by.personId, ...members(db, workspaceId).filter((m) => canSign(m.role)).map((m) => m.personId)])) securityEvent(db, who, 'member-grant-scheduled', detail, now)
    for (const c of activeContacts(db, by.personId, now)) securityEvent(db, c, 'contact-grant-scheduled', { for: handleOf(db, by.personId), effectiveAt }, now)
    if (person !== by.personId) securityEvent(db, person, 'workspace-role-pending', detail, now)
    audit(db, now, workspaceId, 'owner', 'member.grant-requested', person, { role: r, before: cur, by: by.personId, changeId, effectiveAt })
    tellMembers(db, workspaceId, now, { grant: changeId })
    return { applied: false, changeId, effectiveAt }
  })
}

/**
 * Change a member's role. Raising it is a grant (requestMember). Lowering it takes effect at once and withdraws any grant
 * waiting for them. Nobody lowers a member whose role is above their own, and a workspace keeps one owner at least.
 * Returns whether the workspace's signing policy can still be met by the members who may sign.
 */
export function changeRole(db: Db, workspaceId: string, by: { personId: string; role: Role; beforeLoosening?: () => void }, personId: string, role: unknown, now: number): { applied: boolean; changeId: string | null; effectiveAt: number | null; policyMet: boolean } {
  if (!canAdminister(by.role)) throw new AppError(403, 'not_permitted', 'Only an owner or an admin can change a member\'s role.')
  const r = role as Role
  if (!ROLES.includes(r)) throw bad('Choose a role.', { role: 'Choose one of the roles.' })
  const cur = membership(db, workspaceId, personId)?.role
  if (!cur) throw new AppError(404, 'not_found', 'That member was not found.')
  if (RANK[r] > RANK[cur]) return { ...requestMember(db, workspaceId, by, handleOf(db, personId), r, now), policyMet: true }
  if (r === cur) throw new AppError(409, 'not_a_change', 'That member already has that role.')
  if (RANK[cur] > RANK[by.role]) throw new AppError(403, 'not_permitted', 'You cannot change the role of a member whose role is above your own.')
  return db.tx(() => {
    if (cur === 'owner' && (db.get<{ n: number }>(`SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND role = 'owner'`, workspaceId)?.n ?? 0) <= 1) throw new AppError(409, 'last_owner', 'A workspace keeps at least one owner. Make another member an owner first.')
    db.run('UPDATE memberships SET role = ? WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', r, workspaceId, personId)
    narrowed(db, workspaceId, by, personId, { role: r, before: cur }, now)
    return { applied: true, changeId: null, effectiveAt: null, policyMet: policyMet(db, workspaceId) }
  })
}

/** Remove a member, at once. Nobody removes a member whose role is above their own, and a workspace keeps one owner at least. */
export function removeMember(db: Db, workspaceId: string, by: { personId: string; role: Role }, personId: string, now: number): { policyMet: boolean } {
  if (!canAdminister(by.role) && personId !== by.personId) throw new AppError(403, 'not_permitted', 'Only an owner or an admin can remove another member.')
  const cur = membership(db, workspaceId, personId)?.role
  if (!cur) throw new AppError(404, 'not_found', 'That member was not found.')
  if (personId !== by.personId && RANK[cur] > RANK[by.role]) throw new AppError(403, 'not_permitted', 'You cannot remove a member whose role is above your own.')
  return db.tx(() => {
    if (cur === 'owner' && (db.get<{ n: number }>(`SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND removed_at IS NULL AND role = 'owner'`, workspaceId)?.n ?? 0) <= 1) throw new AppError(409, 'last_owner', 'A workspace keeps at least one owner. Make another member an owner first.')
    db.run('UPDATE memberships SET removed_at = ? WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', now, workspaceId, personId)
    // a session of theirs acting in this workspace goes back to their own workspace on its next request (api.ts)
    db.run('UPDATE sessions SET workspace_id = user_id WHERE user_id = ? AND workspace_id = ?', personId, workspaceId)
    narrowed(db, workspaceId, by, personId, { role: null, before: cur }, now)
    return { policyMet: policyMet(db, workspaceId) }
  })
}

/** After a narrowing: a grant still waiting for the member is withdrawn, and everyone who may sign, and the member, is told. */
function narrowed(db: Db, workspaceId: string, by: { personId: string }, personId: string, change: { role: Role | null; before: Role }, now: number): void {
  db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'narrowed' WHERE workspace_id = ? AND kind = ? AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL`, now, workspaceId, GRANT_MEMBER, personId)
  audit(db, now, workspaceId, 'owner', change.role ? 'member.narrow' : 'member.remove', personId, { ...change, by: by.personId })
  tellMembers(db, workspaceId, now, { member: personId })
  emit(db, now, personId, 'workspace', { workspaceId, member: personId })
  const detail = { workspaceId, person: handleOf(db, personId), role: change.role, before: change.before }
  for (const who of new Set([personId, ...members(db, workspaceId).filter((m) => canSign(m.role)).map((m) => m.personId)])) securityEvent(db, who, change.role ? 'workspace-role-lowered' : 'workspace-member-removed', detail, now)
}

/** A live page of every member shows the change (a stream carries its person's own events: server/api.ts openStream). */
function tellMembers(db: Db, workspaceId: string, now: number, payload: Record<string, unknown>): void {
  for (const m of members(db, workspaceId)) emit(db, now, m.personId, 'workspace', { workspaceId, ...payload })
}

/** Whether the members who may sign can still meet the policy's highest requirement. */
export function policyMet(db: Db, workspaceId: string): boolean {
  const p = policyOf(db, workspaceId)
  const able = members(db, workspaceId).filter((m) => canSign(m.role)).length - (p.makerChecker ? 1 : 0)
  return probes(p).every((at) => requiredFor(p, at || null) <= able)
}

/** What may be asked of setPolicy: a limit of null removes that member's limit. `bands` replaces the whole list. */
export type PolicyPatch = Partial<Omit<Policy, 'limits'>> & { limits?: Record<string, number | null> }

/** The sizes at which a policy's required count can change: nought, the large rule and each band's start. */
const probes = (p: Policy): number[] => [0, ...(p.largePaise !== null ? [p.largePaise] : []), ...p.bands.map((b) => b.fromPaise)]

/**
 * Change the policy. Raising what is required takes effect at once. Lowering it (fewer signers, maker-checker off, a
 * higher size before more signers are needed, a band taken away or weakened, a member's limit raised or removed) reduces
 * protection: it is scheduled and applies after the delay, and any member who may sign can cancel it in that time. A
 * limit set or lowered, or a band added or strengthened, takes effect at once. A policy that needs more signers than
 * there are members who may sign (and whose limit reaches the amount where the requirement begins) is refused, because
 * nothing could then be approved.
 */
export function setPolicy(db: Db, workspaceId: string, by: { personId: string; role: Role; beforeLoosening?: () => void }, next: PolicyPatch, now: number): { applied: boolean; effectiveAt: number | null; changeId: string | null } {
  if (!canAdminister(by.role)) throw new AppError(403, 'not_permitted', 'Only an owner or an admin can change the approval policy.')
  const cur = policyOf(db, workspaceId)
  const { limits: limitPatch, ...rest } = next
  const limits: Record<string, number> = { ...cur.limits }
  const people = members(db, workspaceId)
  for (const [who, v] of Object.entries(limitPatch ?? {})) {
    if (!people.some((m) => m.personId === who)) throw bad('A limit can be set only for a member of this workspace.', { limits: 'Not a member.' })
    if (v === null) delete limits[who]
    else if (!Number.isSafeInteger(v) || v < 1) throw bad('A limit is a whole number of paise above zero; remove it to leave the member with none.', { limits: 'Not a valid limit.' })
    else limits[who] = v
  }
  const p: Policy = { ...cur, ...rest, limits }
  if (!Number.isInteger(p.signers) || p.signers < 1) throw bad('At least one signature is always needed.', { signers: 'At least 1.' })
  if (!Array.isArray(p.bands) || p.bands.length > MAX_BANDS) throw bad(`At most ${MAX_BANDS} amount bands.`, { bands: 'Too many bands.' })
  const sorted = [...p.bands].sort((a, b) => a.fromPaise - b.fromPaise)
  for (const [i, b] of sorted.entries()) {
    if (!b || !Number.isSafeInteger(b.fromPaise) || b.fromPaise < 1 || !Number.isInteger(b.signers) || b.signers < 1) throw bad('Each band needs an amount above zero and at least one signature.', { bands: 'Not a valid band.' })
    if (i > 0 && b.fromPaise === sorted[i - 1]!.fromPaise) throw bad('Two bands start at the same amount.', { bands: 'Duplicate amount.' })
    if (i > 0 && b.signers < sorted[i - 1]!.signers) throw bad('A higher band cannot ask for fewer signatures than a lower one.', { bands: 'Out of order.' })
  }
  p.bands = sorted
  // At each size where the requirement changes, enough members who may sign (and whose limit reaches that size) must exist.
  for (const at of probes(p)) {
    const need = requiredFor(p, at || null)
    const able = people.filter((m) => canSign(m.role) && (limitOf(p, m.personId) === null || limitOf(p, m.personId)! >= Math.max(at, 1))).length - (p.makerChecker ? 1 : 0)
    if (need > able) throw bad(at ? `From ${homeMoneyExact(at)} that needs ${need} signatures, but only ${Math.max(0, able)} member${able === 1 ? '' : 's'} who may sign${p.makerChecker ? ' (besides whoever prepares a request)' : ''} ${able === 1 ? 'has' : 'have'} a limit that reaches it. Add members, or raise a limit first.` : `That needs more signers than this workspace has${p.makerChecker ? ' besides whoever prepares a request' : ''}. Add members who may sign first.`, { signers: 'Too many for the members who may sign.' })
  }
  const looser = Object.keys(cur.limits).some((m) => limits[m] === undefined || limits[m]! > cur.limits[m]!)
  const weaker = [...new Set([...probes(cur), ...probes(p)])].some((s) => requiredFor(p, s || null) < requiredFor(cur, s || null))
  const lower = looser || weaker || p.signers < cur.signers || (cur.makerChecker && !p.makerChecker) || (cur.largeSigners !== null && (p.largeSigners ?? 0) < cur.largeSigners) || (cur.largePaise !== null && (p.largePaise === null || p.largePaise > cur.largePaise))
  // one transaction: the policy and its audit entry, or the scheduled lowering and everyone's notice, or nothing
  if (!lower) {
    return db.tx(() => {
      db.run('UPDATE users SET policy_json = ? WHERE id = ?', j(p), workspaceId)
      audit(db, now, workspaceId, 'owner', 'policy.raise', workspaceId, { policy: p, by: by.personId })
      return { applied: true, effectiveAt: null, changeId: null }
    })
  }
  by.beforeLoosening?.()
  const effectiveAt = now + PROTECTION_DELAY_MS, changeId = newId('chg', now)
  return db.tx(() => {
    db.run(`INSERT INTO scheduled_changes (id, person_id, workspace_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, ?, 'lower-policy', ?, ?, ?, ?, ?)`, changeId, by.personId, workspaceId, workspaceId, j({ policy: p, before: cur }), now, by.personId, effectiveAt)
    audit(db, now, workspaceId, 'owner', 'policy.lower-requested', workspaceId, { policy: p, by: by.personId, changeId, effectiveAt })
    // Every member is told, with the change's id, so any member who may sign can find and cancel it.
    for (const m of members(db, workspaceId)) securityEvent(db, m.personId, 'policy-lowering-scheduled', { workspaceId, changeId, effectiveAt }, now)
    return { applied: false, effectiveAt, changeId }
  })
}

/** Point the session at a workspace the person belongs to. */
export function switchWorkspace(db: Db, sessionHash: string, personId: string, workspaceId: string): void {
  if (!membership(db, workspaceId, personId)) throw new AppError(404, 'not_found', 'That workspace was not found.')
  db.run('UPDATE sessions SET workspace_id = ? WHERE id_hash = ? AND user_id = ?', workspaceId, sessionHash, personId)
}
