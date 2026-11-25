/**
 * Work prepared in a session opened with a password (RISK-076's last item). A password can be phished and a passkey
 * cannot, and a password session may prepare payees, bills, instruction drafts and approval requests that a passkey
 * later approves: a phished password could prepare a payee and a payment that the owner then approves believing it was
 * their own work. So each of them records how the session that made it was opened, and when, read from the server's own
 * session record through the request's actor (never from the request), into a table that is written once and never
 * changed (schema.sql `prepared`). The document the passkey signs then carries one plain sentence for each part of it
 * that a password session prepared; the approval sheet shows those sentences before the passkey is asked, and the
 * approval's record keeps them, because they are part of the document whose hash is signed.
 *
 * A payee added in a password session is also told to every member of the workspace, in their security history: the
 * in-app record that tells them of changes to passkeys, recovery contacts and who must sign. Nothing leaves the app.
 *
 * A session opened with a passkey that signs in only (R12: one a recovery registered, or one added after a password
 * reset) is no better here than a password session (review H2): its work is recorded as 'signin-passkey' and said so in
 * the same places, in its own words.
 */
import { homeMoneyExact } from '../shared/home-money.ts'
import { type Db, ist } from './core.ts'
import { securityEvent } from './passkeys.ts'
import { actor, members } from './workspaces.ts'

export type PreparedKind = 'payee' | 'bill' | 'program-version' | 'approval'
interface Row { person_id: string; method: string; at: number }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "14:02 IST on 23 Nov 2026": a time with its day, since a document may be signed days after it was prepared. */
export function atIst(ms: number): string { const t = ist(ms); return `${t.hm} IST on ${t.d} ${MONTHS[t.m - 1]} ${t.y}` }

/** The session acting now, as the API put it in the request's actor; null outside a request (the engine's own work). */
function acting(): { personId: string; authMethod: string; session: string } | null {
  const a = actor.getStore()
  return a?.authMethod ? { personId: a.personId, authMethod: a.authMethod, session: a.session ?? '' } : null
}

/**
 * Record how the session acting now was opened, for something it has just made: called where the thing is written,
 * inside the same transaction. A thing made outside a request has no session, and no row.
 */
export function recordPrepared(db: Db, kind: PreparedKind, subject: string, workspaceId: string, now: number): void {
  const a = acting()
  if (!a) return
  db.run('INSERT OR IGNORE INTO prepared (kind, subject, workspace_id, person_id, method, session, at) VALUES (?, ?, ?, ?, ?, ?, ?)', kind, subject, workspaceId, a.personId, a.authMethod, a.session, now)
}

const rowOf = (db: Db, kind: PreparedKind, subject: string): Row | undefined => db.get<Row>('SELECT person_id, method, at FROM prepared WHERE kind = ? AND subject = ?', kind, subject)
/** Who prepared it, named in a business workspace, where several people act; a household needs no name. */
function byWhom(db: Db, workspaceId: string, personId: string): string {
  if (db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', workspaceId)?.kind !== 'business') return ''
  const u = db.get<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', personId)
  return u ? ` by ${u.display_name} (@${u.handle})` : ''
}
/** The methods whose work is said in what a passkey signs: a password session, and a sign-in-only passkey session. */
const LABELLED = new Set(['password', 'signin-passkey', 'google'])
const how = (db: Db, workspaceId: string, r: { person_id: string; at: number; method: string }): string => r.method === 'signin-passkey'
  ? `${byWhom(db, workspaceId, r.person_id)} in a sign-in-only passkey session at ${atIst(r.at)}, not with a passkey that can approve`
  : r.method === 'google' ? `${byWhom(db, workspaceId, r.person_id)} in a session opened with Google at ${atIst(r.at)}, not with a passkey`
    : `${byWhom(db, workspaceId, r.person_id)} in a password session at ${atIst(r.at)}, not with a passkey`

/**
 * The sentences a document must carry about what it relies on that a password session prepared: the request itself
 * (when the session asking for the approval was opened with a password), the draft it would put in force, and the
 * payees and bills it pays. Empty when every part was prepared with a passkey, or by QED itself, so that such a document
 * is exactly what it was before. `now` is the time the request is made, which its approval records too.
 */
export function passwordWork(db: Db, workspaceId: string, what: { request?: boolean; draft?: { programId: string; version: number }; payeeHandles?: readonly string[]; billIds?: readonly string[] }, now: number): string[] {
  const out: string[] = []
  const a = acting()
  if (what.request && a && LABELLED.has(a.authMethod)) out.push(`Prepared${how(db, workspaceId, { person_id: a.personId, at: now, method: a.authMethod })}.`)
  if (what.draft) {
    const r = rowOf(db, 'program-version', `${what.draft.programId}@${what.draft.version}`)
    if (r && LABELLED.has(r.method)) out.push(`This draft was saved${how(db, workspaceId, r)}.`)
  }
  for (const handle of new Set(what.payeeHandles ?? [])) {
    const y = db.get<{ id: string; name: string; handle: string }>('SELECT id, name, handle FROM payees WHERE user_id = ? AND handle = ?', workspaceId, handle)
    const r = y ? rowOf(db, 'payee', y.id) : undefined
    if (y && r && LABELLED.has(r.method)) out.push(`The payee ${y.name} (${y.handle}) was added${how(db, workspaceId, r)}.`)
  }
  for (const id of new Set(what.billIds ?? [])) {
    const b = db.get<{ amount: number; memo: string; name: string }>('SELECT b.amount, b.memo, y.name FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.id = ? AND b.user_id = ?', id, workspaceId)
    const r = rowOf(db, 'bill', id)
    if (b && r && LABELLED.has(r.method)) out.push(`The bill ${b.memo ? `"${b.memo}" ` : ''}for ${homeMoneyExact(b.amount)} to ${b.name} was added${how(db, workspaceId, r)}.`)
  }
  return out
}

/** The sentences a stored approval document carries (none for one that carries none, or one from before them). */
export function preparedIn(document: string): string[] {
  try {
    const p = (JSON.parse(document) as { prepared?: unknown }).prepared
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/**
 * A payee added in a password session, or in a sign-in-only passkey session, is told to every member of the workspace
 * (the owner of a household), in their security history and as an urgent notice: a phished password, or a recovery made
 * by someone else, would add the payee it wants paid.
 */
export function tellPayeeAdded(db: Db, workspaceId: string, payee: { name: string; handle: string }, now: number): void {
  const a = acting()
  if (!a || !LABELLED.has(a.authMethod)) return
  const ws = db.get<{ kind: string; display_name: string }>('SELECT kind, display_name FROM users WHERE id = ?', workspaceId)
  const by = db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', a.personId)?.handle ?? ''
  const detail = { payee: `${payee.name} (${payee.handle})`, at: now, by, ...(ws?.kind === 'business' ? { workspace: ws.display_name, workspaceId } : {}) }
  for (const m of members(db, workspaceId)) securityEvent(db, m.personId, a.authMethod === 'signin-passkey' ? 'payee-added-in-signin-session' : a.authMethod === 'google' ? 'payee-added-in-google-session' : 'payee-added-in-password-session', detail, now)
}
