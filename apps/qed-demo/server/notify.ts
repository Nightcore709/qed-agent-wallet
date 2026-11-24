/**
 * Notifications (R10 section 11; register R10-006). Notices are what QED has to say (server/execute.ts `notice`); this
 * decides when each reaches its person and what happens when nobody answers.
 *
 *  - Urgency. Critical: a change to who can act or to the record of money (a signer or recovery on the wallet, a
 *    payment reversed, a ledger that disagrees with the venue, a protective instruction not watching). Action: it needs
 *    an answer (a run to approve or object to, a bill over a cap, an unpaid instalment, a disputed milestone, a refused
 *    standing policy). Warning and info: everything else, by the notice's own level.
 *  - Quiet hours. In the owner's quiet hours (Indian time, a window that may cross midnight) warnings wait until the
 *    window ends. Critical and action notices are never held: an approval held overnight could lapse.
 *  - Grouping and deduplication. Notices that say the same thing are already one row with a count (views.ts
 *    `noticesView`, the dedupe key in `notice`); nothing here sends a second copy.
 *  - Acknowledgement. A critical or action notice is acknowledged explicitly; reading it is not acknowledging it.
 *  - Escalation. A critical or action notice unacknowledged for the owner's delay (30 minutes unless set) is raised
 *    again as a critical notice of its own, so it stands first; it is escalated once.
 *  - Digest. Info notices are gathered into one digest a day at the owner's chosen time, grouped by kind with counts.
 *
 * In this build every notice is shown inside QED only: nothing leaves this computer. Email, text messages or phone
 * notifications would need a provider and the owner's approval. A notice does not stop or undo anything; the pause
 * control and the limits the owner signs do.
 */
import { AppError, type Db, ist, istInstant, newId } from './core.ts'
import { notice } from './execute.ts'

export type Urgency = 'critical' | 'action' | 'warning' | 'info'
const CRITICAL = new Set(['vault-signer-added', 'vault-recovery', 'recon-break', 'payment-reversed', 'not-watching', 'escalation', 'security-change'])

/** How urgent a notice is, from its kind and the level it was raised at. */
export function urgencyOf(kind: string, level: string): Urgency {
  if (CRITICAL.has(kind)) return 'critical'
  return level === 'action' ? 'action' : level === 'warning' ? 'warning' : 'info'
}

export interface Prefs { quietFrom: string | null; quietTo: string | null; digestAt: string; escalateMin: number }
export const DEFAULT_PREFS: Prefs = { quietFrom: null, quietTo: null, digestAt: '08:00', escalateMin: 30 }
const HM = /^([01]\d|2[0-3]):[0-5]\d$/
const ESCALATE_CHOICES = [15, 30, 60, 120, 240]
const minutesOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))

/** The owner's preferences, checked: times as HH:MM, quiet hours both set or both empty, a known escalation delay. */
export function checkPrefs(p: Partial<Record<keyof Prefs, unknown>>): Prefs {
  const fields: Record<string, string> = {}
  const time = (v: unknown, key: string, optional: boolean): string | null => {
    if ((v === null || v === undefined || v === '') && optional) return null
    if (typeof v !== 'string' || !HM.test(v)) { fields[key] = 'A time of day, such as 22:00.'; return null }
    return v
  }
  const quietFrom = time(p.quietFrom, 'quietFrom', true), quietTo = time(p.quietTo, 'quietTo', true)
  const digestAt = time(p.digestAt ?? DEFAULT_PREFS.digestAt, 'digestAt', false)
  if ((quietFrom === null) !== (quietTo === null) && !fields.quietFrom && !fields.quietTo) fields[quietFrom === null ? 'quietFrom' : 'quietTo'] = 'Set both ends of the quiet hours, or neither.'
  if (quietFrom !== null && quietFrom === quietTo) fields.quietTo = 'The quiet hours must end at a different time from when they start.'
  const escalateMin = Number(p.escalateMin ?? DEFAULT_PREFS.escalateMin)
  if (!ESCALATE_CHOICES.includes(escalateMin)) fields.escalateMin = `One of ${ESCALATE_CHOICES.join(', ')} minutes.`
  if (Object.keys(fields).length) throw new AppError(400, 'invalid_prefs', 'Some notification settings are not valid.', fields)
  return { quietFrom, quietTo, digestAt: digestAt!, escalateMin }
}

export function getPrefs(db: Db, userId: string): Prefs {
  const r = db.get<{ quiet_from: string | null; quiet_to: string | null; digest_at: string; escalate_min: number }>('SELECT quiet_from, quiet_to, digest_at, escalate_min FROM notify_prefs WHERE user_id = ?', userId)
  return r ? { quietFrom: r.quiet_from, quietTo: r.quiet_to, digestAt: r.digest_at, escalateMin: r.escalate_min } : DEFAULT_PREFS
}

export function setPrefs(db: Db, userId: string, input: Partial<Record<keyof Prefs, unknown>>, now: number): Prefs {
  const p = checkPrefs(input)
  db.run(`INSERT INTO notify_prefs (user_id, quiet_from, quiet_to, digest_at, escalate_min, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to, digest_at = excluded.digest_at, escalate_min = excluded.escalate_min, updated_at = excluded.updated_at`,
  userId, p.quietFrom, p.quietTo, p.digestAt, p.escalateMin, now)
  // Warnings held under the old quiet hours are planned again under the new ones.
  for (const r of db.all<{ notice_id: string; ts: number; urgency: Urgency }>(`SELECT d.notice_id, n.ts, d.urgency FROM notice_delivery d JOIN notices n ON n.id = d.notice_id WHERE d.user_id = ? AND d.surface_at > ? AND d.digest_id IS NULL`, userId, now)) {
    db.run('UPDATE notice_delivery SET surface_at = ? WHERE notice_id = ?', Math.max(now, surfaceAt(r.urgency, Math.max(r.ts, now), p)), r.notice_id)
  }
  return p
}

/** Whether an instant falls in the quiet hours (Indian time; the window may cross midnight). */
export function inQuiet(ms: number, p: Prefs): boolean {
  if (!p.quietFrom || !p.quietTo || p.quietFrom === p.quietTo) return false
  const m = ist(ms).minutes, a = minutesOf(p.quietFrom), b = minutesOf(p.quietTo)
  return a < b ? m >= a && m < b : m >= a || m < b
}

/** The first instant at or after `ms` whose Indian clock reads `hm`. */
export function nextAt(ms: number, hm: string): number {
  const today = istInstant(ist(ms).date, hm)
  if (today >= ms) return today
  return istInstant(ist(ms + 86_400_000).date, hm)
}

/**
 * When a notice raised at `ts` is surfaced as new: critical and action at once; a warning at once, or when the quiet
 * hours end if it was raised inside them; info with the next digest.
 */
export function surfaceAt(u: Urgency, ts: number, p: Prefs): number {
  if (u === 'critical' || u === 'action') return ts
  if (u === 'info') return nextAt(ts, p.digestAt)
  return inQuiet(ts, p) ? nextAt(ts, p.quietTo!) : ts
}

/**
 * One pass, from the engine's tick: plan the notices that have no plan yet, escalate what has waited too long for an
 * acknowledgement, and gather the info notices that have reached their digest. Idempotent.
 */
export function notifyTick(db: Db, now: number): { planned: number; escalated: number; digests: number } {
  const prefs = new Map<string, Prefs>()
  const prefsOf = (u: string): Prefs => { let p = prefs.get(u); if (!p) { p = getPrefs(db, u); prefs.set(u, p) } return p }
  let planned = 0, escalated = 0, digests = 0
  for (const n of db.all<{ id: string; user_id: string; ts: number; kind: string; level: string }>(
    `SELECT n.id, n.user_id, n.ts, n.kind, n.level FROM notices n LEFT JOIN notice_delivery d ON d.notice_id = n.id
     WHERE d.notice_id IS NULL AND n.resolved_at IS NULL ORDER BY n.ts LIMIT 500`)) {
    const u = urgencyOf(n.kind, n.level)
    db.run('INSERT OR IGNORE INTO notice_delivery (notice_id, user_id, urgency, surface_at) VALUES (?, ?, ?, ?)', n.id, n.user_id, u, surfaceAt(u, n.ts, prefsOf(n.user_id)))
    planned++
  }
  for (const d of db.all<{ notice_id: string; user_id: string; surface_at: number; title: string; kind: string }>(
    `SELECT d.notice_id, d.user_id, d.surface_at, n.title, n.kind FROM notice_delivery d JOIN notices n ON n.id = d.notice_id
     WHERE d.urgency IN ('critical', 'action') AND d.acked_at IS NULL AND d.escalated_at IS NULL AND n.resolved_at IS NULL AND n.kind != 'escalation'`)) {
    const p = prefsOf(d.user_id)
    if (d.surface_at + p.escalateMin * 60_000 > now) continue
    db.tx(() => {
      db.run('UPDATE notice_delivery SET escalated_at = ? WHERE notice_id = ?', now, d.notice_id)
      notice(db, d.user_id, { level: 'action', kind: 'escalation', subject: d.notice_id, dedupe: `escalation:${d.notice_id}`,
        title: `Not acknowledged for ${p.escalateMin} minutes: ${d.title}`,
        body: 'This was raised as urgent and nobody has acknowledged it yet. Open it and acknowledge it once you have read it; acknowledging does not change or undo anything.' }, now)
    })
    escalated++
  }
  const due = db.all<{ notice_id: string; user_id: string; ts: number; kind: string; title: string }>(
    `SELECT d.notice_id, d.user_id, n.ts, n.kind, n.title FROM notice_delivery d JOIN notices n ON n.id = d.notice_id
     WHERE d.urgency = 'info' AND d.digest_id IS NULL AND d.surface_at <= ? ORDER BY d.user_id, n.ts`, now)
  const byUser = new Map<string, typeof due>()
  for (const r of due) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r])
  for (const [userId, rows] of byUser) {
    const groups = new Map<string, { kind: string; title: string; count: number; first: number; last: number }>()
    for (const r of rows) {
      const g = groups.get(r.kind) ?? { kind: r.kind, title: r.title, count: 0, first: r.ts, last: r.ts }
      g.count++; g.first = Math.min(g.first, r.ts); g.last = Math.max(g.last, r.ts); g.title = r.title
      groups.set(r.kind, g)
    }
    const id = newId('dig', now)
    db.tx(() => {
      db.run('INSERT INTO digests (id, user_id, at, from_ts, body_json) VALUES (?, ?, ?, ?, ?)', id, userId, now, Math.min(...rows.map((r) => r.ts)), JSON.stringify([...groups.values()]))
      for (const r of rows) db.run('UPDATE notice_delivery SET digest_id = ? WHERE notice_id = ?', id, r.notice_id)
    })
    digests++
  }
  return { planned, escalated, digests }
}

/** Acknowledge a critical or action notice: it is read and understood. Acknowledging changes nothing else. */
/**
 * Acknowledge a notice. `may.settleSecurity` says whether this session may clear a change to the account's security
 * (a security change, or the escalation of one): a phished password session must not hide the notice that warns of
 * it, so the API passes false for a password session of an account that has a passkey, until it confirms with one.
 */
/** Notices of a change to who can act for the account or its wallet: the ones a password session may not clear. */
const WHO_CAN_ACT = new Set(['security-change', 'vault-signer-added', 'vault-recovery'])
/**
 * Whether a notice is about a change to who can act (or is the escalation of one): such a notice is neither acknowledged
 * nor dismissed by a session that may not settle it (api.ts maySettleSecurity; review M3: the wallet's own notices are
 * raised as warnings, which any session could dismiss).
 */
export function isWhoCanAct(db: Db, userId: string, noticeId: string): boolean {
  const n = db.get<{ kind: string; subject: string | null }>('SELECT kind, subject FROM notices WHERE id = ? AND user_id = ?', noticeId, userId)
  if (!n) return false
  if (WHO_CAN_ACT.has(n.kind)) return true
  return n.kind === 'escalation' && WHO_CAN_ACT.has(db.get<{ kind: string }>('SELECT kind FROM notices WHERE id = ?', n.subject ?? '')?.kind ?? '')
}
export function acknowledge(db: Db, userId: string, noticeId: string, now: number, may: { settleSecurity: boolean }): void {
  const d = db.get<{ urgency: Urgency }>('SELECT urgency FROM notice_delivery WHERE notice_id = ? AND user_id = ?', noticeId, userId)
  const n = db.get<{ kind: string; level: string }>('SELECT kind, level FROM notices WHERE id = ? AND user_id = ?', noticeId, userId)
  if (!n) throw new AppError(404, 'not_found', 'No such notice.')
  const u = d?.urgency ?? urgencyOf(n.kind, n.level)
  if (u !== 'critical' && u !== 'action') throw new AppError(400, 'not_acknowledgeable', 'Only urgent notices and notices that need an answer are acknowledged; others can simply be dismissed.')
  const subjectKind = n.kind === 'escalation' ? db.get<{ kind: string }>('SELECT n2.kind FROM notices n1 JOIN notices n2 ON n2.id = n1.subject WHERE n1.id = ?', noticeId)?.kind : null
  if ((WHO_CAN_ACT.has(n.kind) || WHO_CAN_ACT.has(subjectKind ?? '')) && !may.settleSecurity) {
    throw new AppError(401, 'stepup_required', 'Confirm with one of your passkeys to acknowledge a change to your account’s security. A session opened with a password cannot clear it.')
  }
  db.tx(() => {
    // not planned by the engine yet: planned now as the engine would have, delivered when it surfaced, not when it was
    // acknowledged (R13: the delivered and acknowledged states keep their own times)
    if (!d) db.run('INSERT OR IGNORE INTO notice_delivery (notice_id, user_id, urgency, surface_at) VALUES (?, ?, ?, ?)', noticeId, userId, u, surfaceAt(u, db.get<{ ts: number }>('SELECT ts FROM notices WHERE id = ?', noticeId)?.ts ?? now, getPrefs(db, userId)))
    db.run('UPDATE notice_delivery SET acked_at = COALESCE(acked_at, ?) WHERE notice_id = ?', now, noticeId)
    db.run('UPDATE notices SET read_at = COALESCE(read_at, ?) WHERE id = ?', now, noticeId)
    // An escalation is settled by acknowledging the notice it was about, and the other way round.
    const about = db.get<{ subject: string | null; kind: string }>('SELECT subject, kind FROM notices WHERE id = ?', noticeId)
    if (about?.kind === 'escalation' && about.subject) db.run('UPDATE notice_delivery SET acked_at = COALESCE(acked_at, ?) WHERE notice_id = ?', now, about.subject)
    db.run(`UPDATE notices SET resolved_at = COALESCE(resolved_at, ?) WHERE user_id = ? AND kind = 'escalation' AND subject = ?`, now, userId, about?.kind === 'escalation' ? about.subject : noticeId)
    // A notice that only tells (a security change, an escalation of one) is settled by acknowledging it.
    const settled = about?.kind === 'escalation' ? db.get<{ kind: string }>('SELECT kind FROM notices WHERE id = ?', about.subject ?? '')?.kind : about?.kind
    // so is a wallet operation a reorganisation undid (vault-watch.ts): the owner has read that it is not done
    if (settled === 'security-change' || settled === 'vault-job-reorged') db.run('UPDATE notices SET resolved_at = COALESCE(resolved_at, ?) WHERE id IN (?, ?)', now, noticeId, about?.kind === 'escalation' ? about.subject ?? '' : noticeId)
  })
}

/** What the Notifications page shows: the settings, what waits for an acknowledgement, what is held, the latest digests. */
export function notifyView(db: Db, userId: string, now: number): Record<string, unknown> {
  const rows = (sql: string, ...args: (string | number)[]) => db.all<Record<string, unknown>>(sql, ...args)
  return {
    prefs: getPrefs(db, userId),
    delivery: 'Nothing leaves this computer in this build. Email, text messages or phone notifications would need a provider and your approval.',
    unacknowledged: [...rows(`SELECT n.id, n.ts, n.kind, n.title, n.body, d.urgency, d.escalated_at AS escalatedAt FROM notice_delivery d JOIN notices n ON n.id = d.notice_id
      WHERE d.user_id = ? AND d.urgency IN ('critical', 'action') AND d.acked_at IS NULL AND n.resolved_at IS NULL`, userId),
      // an urgent notice the engine has not planned yet waits for an acknowledgement too (it surfaces at once)
      ...unplanned(db, userId).filter((n) => n.urgency === 'critical' || n.urgency === 'action').map((n) => ({ id: n.id, ts: n.ts, kind: n.kind, title: n.title, body: db.get<{ body: string }>('SELECT body FROM notices WHERE id = ?', n.id)?.body ?? '', urgency: n.urgency, escalatedAt: null }))]
      .sort((a, b) => (a.urgency === b.urgency ? Number(b.ts) - Number(a.ts) : a.urgency === 'critical' ? -1 : 1)).slice(0, 50),
    // What the person acknowledged in the last seven days, and when: the other half of "what waits for you".
    acknowledged: rows(`SELECT n.id, n.ts, n.kind, n.title, d.urgency, d.acked_at AS ackedAt FROM notice_delivery d JOIN notices n ON n.id = d.notice_id
      WHERE d.user_id = ? AND d.acked_at IS NOT NULL AND d.acked_at > ? ORDER BY d.acked_at DESC LIMIT 10`, userId, now - 7 * 86_400_000),
    held: [...rows(`SELECT n.id, n.ts, n.kind, n.title, d.urgency, d.surface_at AS surfaceAt FROM notice_delivery d JOIN notices n ON n.id = d.notice_id
      WHERE d.user_id = ? AND d.surface_at > ? AND n.resolved_at IS NULL ORDER BY d.surface_at LIMIT 50`, userId, now),
      // and those the engine has not planned yet that it would hold
      ...unplanned(db, userId).filter((n) => n.surfaceAt > now).map((n) => ({ id: n.id, ts: n.ts, kind: n.kind, title: n.title, urgency: n.urgency, surfaceAt: n.surfaceAt }))]
      .sort((a, b) => Number(a.surfaceAt) - Number(b.surfaceAt)).slice(0, 50),
    digests: rows('SELECT id, at, from_ts AS fromTs, body_json AS body FROM digests WHERE user_id = ? ORDER BY at DESC LIMIT 3', userId).map((d) => ({ ...d, body: JSON.parse(String(d.body)) as unknown })),
  }
}

/**
 * Notices the engine has not planned yet (it plans each on its next pass; with the engine stopped, not at all): when each
 * would surface, worked out as the engine would. Read only; nothing is written.
 */
function unplanned(db: Db, userId: string): { id: string; ts: number; kind: string; title: string; urgency: Urgency; surfaceAt: number }[] {
  const p = getPrefs(db, userId)
  return db.all<{ id: string; ts: number; kind: string; level: string; title: string }>(`SELECT n.id, n.ts, n.kind, n.level, n.title FROM notices n LEFT JOIN notice_delivery d ON d.notice_id = n.id WHERE n.user_id = ? AND d.notice_id IS NULL AND n.resolved_at IS NULL`, userId)
    .map((n) => { const u = urgencyOf(n.kind, n.level); return { id: n.id, ts: n.ts, kind: n.kind, title: n.title, urgency: u, surfaceAt: surfaceAt(u, n.ts, p) } })
}

/**
 * The notices not yet due to be surfaced (held for the quiet hours or the digest), which the lists leave out: those the
 * engine planned so, and those it has not planned yet that it would (until R13 an unplanned one was shown at once, an
 * info notice before its digest and a warning inside the quiet hours, until the engine's next pass hid it again).
 */
export function heldIds(db: Db, userId: string, now: number): Set<string> {
  const planned = db.all<{ notice_id: string }>('SELECT notice_id FROM notice_delivery WHERE user_id = ? AND surface_at > ?', userId, now).map((r) => r.notice_id)
  return new Set([...planned, ...unplanned(db, userId).filter((n) => n.surfaceAt > now).map((n) => n.id)])
}
