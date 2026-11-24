/**
 * Setting up an institution for a workspace (N-020), SIMULATED institutions only. A business's authority at its bank is the
 * bank's own entitlements (its sub-users and dual control), and the risk of a payment order the bank accepts under the agreed
 * security procedure sits with the customer (UCC Article 4A, sections 4A-202 and 4A-203; model text, state enactments vary: not
 * legal advice, and counsel's review is EXT-06). So:
 *
 *   - the workspace's roles are mapped to bank entitlements (entitlementFor), and the mapping is recorded with the set-up;
 *   - a business needs dual control: one person who can start payments and a different one who can approve them;
 *   - a US business workspace is shown the Article 4A disclosure and must acknowledge it;
 *   - the terms the person was shown must still be the registry's current ones (institution-terms.ts).
 * Without those, the set-up is refused. Only an owner or an admin sets an institution up. No real bank is set up: a real
 * institution is refused by assertConnectable (no connector, EXT-14).
 */
import { audit, type Db, newId, refused } from './core.ts'
import { getProfile, jurisdictionOf } from './household.ts'
import { assertConnectable, connectionSummary } from './institution-terms.ts'
import { canAdminister, type Role } from './workspaces.ts'

export interface Entitlement { role: Role; bankRole: string; canView: boolean; canInitiate: boolean; canApprove: boolean; canAdministerUsers: boolean }
/** A workspace role as the bank's own entitlement: what that person could be given at the bank, never more than the role has here. */
export function entitlementFor(role: Role): Entitlement {
  switch (role) {
    case 'owner': return { role, bankRole: 'company administrator', canView: true, canInitiate: true, canApprove: true, canAdministerUsers: true }
    case 'admin': return { role, bankRole: 'user administrator', canView: true, canInitiate: false, canApprove: false, canAdministerUsers: true }
    case 'approver': return { role, bankRole: 'approver', canView: true, canInitiate: false, canApprove: true, canAdministerUsers: false }
    case 'operator': return { role, bankRole: 'initiator', canView: true, canInitiate: true, canApprove: false, canAdministerUsers: false }
    case 'viewer': return { role, bankRole: 'view only', canView: true, canInitiate: false, canApprove: false, canAdministerUsers: false }
  }
}

export interface EntitlementRecord { kind: 'person' | 'business'; members: (Entitlement & { personId: string })[]; dualControl: boolean; why: string }
/** The workspace's members mapped to bank entitlements, and whether dual control holds: a person who can start and a different one who can approve. */
export function entitlementRecord(db: Db, workspaceId: string): EntitlementRecord {
  const kind = db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', workspaceId)?.kind === 'business' ? 'business' : 'person'
  const members = db.all<{ person_id: string; role: Role }>('SELECT person_id, role FROM memberships WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at, rowid', workspaceId).map((m) => ({ personId: m.person_id, ...entitlementFor(m.role) }))
  const initiators = members.filter((m) => m.canInitiate), approvers = members.filter((m) => m.canApprove)
  const dualControl = initiators.some((i) => approvers.some((a) => a.personId !== i.personId))
  return { kind, members, dualControl, why: dualControl ? 'One person can start a payment and a different person can approve it.' : 'No two different people hold the start and approve entitlements.' }
}

export const UCC_4A = {
  version: 'ucc-4a-disclosure-v1',
  text: 'In the United States, a business\'s bank agreement sets a security procedure for payment orders. A payment order the bank accepts in good faith under that procedure can be the customer\'s responsibility, even if the customer did not send it (UCC Article 4A, sections 4A-202 and 4A-203; state enactments vary). Giving access to software that can send payment orders does not change that: the risk stays with your business. QED cannot change your bank\'s agreement, and your bank decides. This is not legal advice.',
  source: 'UCC 4A-202 and 4A-203, model text through Cornell LII, read 23 Nov 2026; Hypothesis-R (state enactments vary); counsel\'s review is EXT-06',
}
const needsDisclosure = (db: Db, workspaceId: string, kind: string): boolean => kind === 'business' && jurisdictionOf(getProfile(db, workspaceId)) === 'US'

export interface Setup { id: string; institution: string; termsVersion: string; entitlement: EntitlementRecord; disclosure: { version: string; acknowledgedAt: number } | null; setUpBy: string; createdAt: number }
export interface SetupInput { institution?: unknown; termsVersion?: unknown; disclosureAcknowledged?: unknown }

export function setUpInstitution(db: Db, asker: { workspaceId: string; personId: string; role: Role }, input: SetupInput, now: number): Setup {
  if (!canAdminister(asker.role)) throw refused('not_permitted', 'Only an owner or an admin can set up an institution.')
  const t = assertConnectable(String(input.institution ?? ''))
  if (input.termsVersion !== t.termsVersion) throw refused('terms_changed', `The terms you were shown (${String(input.termsVersion ?? 'none')}) are not the current ones (${t.termsVersion}). Read the summary again before connecting.`)
  const ent = entitlementRecord(db, asker.workspaceId)
  if (ent.kind === 'business' && !ent.dualControl) throw refused('entitlement_missing', 'A business\'s bank connection uses the bank\'s own entitlements: one person who can start payments and a different person who can approve them. This workspace has not got both yet. Add a member with the missing role first.')
  let disclosure: Setup['disclosure'] = null
  if (needsDisclosure(db, asker.workspaceId, ent.kind)) {
    if (input.disclosureAcknowledged !== true) throw refused('disclosure_required', `Read and acknowledge this before setting up a bank for a US business: ${UCC_4A.text}`)
    disclosure = { version: UCC_4A.version, acknowledgedAt: now }
  }
  if (db.get('SELECT 1 FROM institution_setups WHERE user_id = ? AND institution = ?', asker.workspaceId, t.id)) throw refused('already_set_up', `${t.name} is already set up for this workspace.`)
  const id = newId('ins', now)
  db.run('INSERT INTO institution_setups (id, user_id, institution, terms_version, entitlement_json, disclosure_json, set_up_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, asker.workspaceId, t.id, t.termsVersion, JSON.stringify(ent), disclosure ? JSON.stringify(disclosure) : null, asker.personId, now)
  audit(db, now, asker.workspaceId, 'owner', 'institution.setup', id, { institution: t.id, termsVersion: t.termsVersion, dualControl: ent.dualControl, disclosure: !!disclosure, by: asker.personId })
  return setupOf(db, asker.workspaceId, id)!
}

const row = (r: { id: string; institution: string; terms_version: string; entitlement_json: string; disclosure_json: string | null; set_up_by: string; created_at: number }): Setup => ({ id: r.id, institution: r.institution, termsVersion: r.terms_version, entitlement: JSON.parse(r.entitlement_json), disclosure: r.disclosure_json ? JSON.parse(r.disclosure_json) : null, setUpBy: r.set_up_by, createdAt: r.created_at })
const COLS = 'id, institution, terms_version, entitlement_json, disclosure_json, set_up_by, created_at'
export function setupOf(db: Db, workspaceId: string, id: string): Setup | undefined {
  const r = db.get<Parameters<typeof row>[0]>(`SELECT ${COLS} FROM institution_setups WHERE id = ? AND user_id = ?`, id, workspaceId)
  return r ? row(r) : undefined
}
export function setupsOf(db: Db, workspaceId: string): Setup[] {
  return db.all<Parameters<typeof row>[0]>(`SELECT ${COLS} FROM institution_setups WHERE user_id = ? ORDER BY created_at`, workspaceId).map(row)
}
/** What the screen or an API shows before connecting: each institution's summary, whether it is set up, and the Article 4A disclosure where it applies. */
export function institutionsView(db: Db, workspaceId: string, terms: readonly Parameters<typeof connectionSummary>[0][]) {
  const kind = db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', workspaceId)?.kind === 'business' ? 'business' : 'person'
  const done = new Map(setupsOf(db, workspaceId).map((s) => [s.institution, s]))
  return { entitlement: entitlementRecord(db, workspaceId), disclosure: needsDisclosure(db, workspaceId, kind) ? UCC_4A : null, institutions: terms.map((t) => ({ ...connectionSummary(t), setUp: done.get(t.id) ?? null })) }
}
