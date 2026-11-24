/**
 * Incidents (R13, RE6): a fault of the engine, the wallet service, readiness (the engine's heartbeat as the API sees it)
 * or reconciliation, recorded from the time it opened to its resolution, with a timeline of events and what it affected
 * (missed runs, for one). Protect's status area shows the open ones and a short history.
 *
 * One open incident per key: a fault that goes on adds events to its incident, it does not open another. Recording never
 * throws into the caller, which has its own work to do. When the fault is the disk itself (storage errors below), the
 * incident cannot be written: it is held in this process, shown from there, and written, with its own times, as soon as
 * a write succeeds again (probeStorage).
 */
import { type Db, j, newId, parse } from './core.ts'

export type IncidentSource = 'engine' | 'wallet-service' | 'readiness' | 'reconciliation' | 'api'
export interface Affected { missedRuns?: number; missedTicks?: number; differences?: number; failedRequests?: number }
export interface IncidentEvent { ts: number; event: string; detail: string | null }
export interface IncidentView { id: string; key: string; source: IncidentSource; title: string; openedAt: number; resolvedAt: number | null; resolution: string | null; affected: Affected; events: IncidentEvent[]; held: boolean }

/** SQLite's own result codes (https://sqlite.org/rescode.html): SQLITE_IOERR 10, SQLITE_FULL 13, SQLITE_READONLY 8 (a read-only file system). */
export function storageErrorKind(e: unknown): 'full' | 'io' | null {
  const code = (e as { errcode?: number } | null)?.errcode
  if (typeof code === 'number') {
    const primary = code & 0xff
    if (primary === 13) return 'full'
    if (primary === 10 || primary === 8) return 'io'
  }
  const m = e instanceof Error ? e.message : ''
  if (/database or disk is full|ENOSPC|no space left/i.test(m)) return 'full'
  if (/disk I\/O error|EIO\b/i.test(m)) return 'io'
  return null
}

/** What a person is told when a request could not be saved. Nothing of the request was kept. */
export const storageMessage = (kind: 'full' | 'io'): string => kind === 'full'
  ? 'QED could not save this: the disk it keeps its records on is full. Nothing was changed by this request. Free some space and try again; QED carries on by itself once there is room.'
  : 'QED could not save this: the disk it keeps its records on reported an error. Nothing was changed by this request. Try again shortly; if it keeps happening, check the disk.'

type Op =
  | { op: 'open'; ts: number; key: string; source: IncidentSource; title: string; detail: string; affected?: Affected }
  | { op: 'event'; ts: number; key: string; event: string; affected?: Affected }
  | { op: 'resolve'; ts: number; key: string; resolution: string; affected?: Affected }
/** Operations that could not be written, in order, per database. */
const held = new WeakMap<Db, Op[]>()

function apply(db: Db, o: Op): void {
  db.tx(() => {
    const open = db.get<{ id: string; affected_json: string }>('SELECT id, affected_json FROM incidents WHERE key = ? AND resolved_at IS NULL', o.key)
    const merge = (id: string, prev: string): void => { if (o.affected) db.run('UPDATE incidents SET affected_json = ? WHERE id = ?', j({ ...parse<Affected>(prev, {}), ...o.affected }), id) }
    const add = (id: string, ts: number, event: string, detail: string | null): void => { db.run('INSERT INTO incident_events (incident_id, ts, event, detail) VALUES (?, ?, ?, ?)', id, ts, event, detail) }
    if (o.op === 'open') {
      if (open) {
        // a long fault does not fill the log: the first 100 events are kept, then only the figures are updated
        if ((db.get<{ n: number }>('SELECT COUNT(*) n FROM incident_events WHERE incident_id = ?', open.id)?.n ?? 0) < 100) add(open.id, o.ts, 'again', o.detail)
        merge(open.id, open.affected_json); return
      }
      const id = newId('inc', o.ts)
      db.run('INSERT INTO incidents (id, key, source, title, opened_at, affected_json) VALUES (?, ?, ?, ?, ?, ?)', id, o.key, o.source, o.title, o.ts, j(o.affected ?? {}))
      add(id, o.ts, 'opened', o.detail)
    } else if (open) {
      if (o.op === 'event') { add(open.id, o.ts, o.event, null); merge(open.id, open.affected_json) }
      else { merge(open.id, open.affected_json); db.run('UPDATE incidents SET resolved_at = ?, resolution = ? WHERE id = ?', o.ts, o.resolution, open.id); add(open.id, o.ts, 'resolved', o.resolution) }
    }
  })
}

function record(db: Db, o: Op): void {
  try {
    if (held.get(db)?.length) flushHeld(db)
    apply(db, o)
  } catch (e) {
    if (storageErrorKind(e)) held.set(db, [...(held.get(db) ?? []), o])
    // any other failure of the record itself is dropped: an incident log must not become a second fault
  }
}

/** Opens the incident for `key`, or adds a line to it if it is open already. */
export function openIncident(db: Db, ts: number, i: { key: string; source: IncidentSource; title: string; detail: string; affected?: Affected }): void { record(db, { op: 'open', ts, ...i }) }
/** Adds an event (and, if given, newer figures of what is affected) to the open incident for `key`; nothing if none is open. */
export function noteIncident(db: Db, ts: number, key: string, event: string, affected?: Affected): void { record(db, { op: 'event', ts, key, event, affected }) }
/** Closes the open incident for `key`, saying how it ended. Nothing if none is open. */
export function resolveIncident(db: Db, ts: number, key: string, resolution: string, affected?: Affected): void { record(db, { op: 'resolve', ts, key, resolution, affected }) }
export function incidentOpen(db: Db, key: string): boolean {
  try { if (db.get('SELECT 1 FROM incidents WHERE key = ? AND resolved_at IS NULL', key)) return true } catch { /* unreadable: fall to what is held */ }
  return (held.get(db) ?? []).some((o) => o.key === key && o.op === 'open')
}
export const heldCount = (db: Db): number => held.get(db)?.length ?? 0

/** Writes what was held, in order, with its own times. Stops at the first failure and keeps the rest. */
export function flushHeld(db: Db): void {
  const queue = held.get(db)
  if (!queue?.length) return
  held.delete(db)
  for (let n = 0; n < queue.length; n++) {
    try { apply(db, queue[n]!) } catch (e) { if (storageErrorKind(e)) { held.set(db, queue.slice(n)); throw e } }
  }
}

/**
 * Tries a real write that needs room (64 KiB of new pages, taken back at once). Null: there is room and the disk works.
 * Otherwise the error. A write that fits in a page already allocated would not show a full disk.
 */
export function probeStorage(db: Db): unknown {
  try {
    db.tx(() => {
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('storage.probe', hex(zeroblob(32768)))`)
      db.run(`DELETE FROM meta WHERE key = 'storage.probe'`)
    })
    return null
  } catch (e) { return e }
}

const rowView = (db: Db, r: { id: string; key: string; source: string; title: string; opened_at: number; resolved_at: number | null; resolution: string | null; affected_json: string }): IncidentView => ({
  id: r.id, key: r.key, source: r.source as IncidentSource, title: r.title, openedAt: r.opened_at, resolvedAt: r.resolved_at, resolution: r.resolution, affected: parse<Affected>(r.affected_json, {}), held: false,
  events: db.all<{ ts: number; event: string; detail: string | null }>('SELECT ts, event, detail FROM incident_events WHERE incident_id = ? ORDER BY id', r.id).map((e) => ({ ts: e.ts, event: e.event, detail: e.detail })),
})

/** The open incidents (the held ones included) and the last `history` resolved ones, newest first. */
export function incidentsView(db: Db, history = 5): { open: IncidentView[]; recent: IncidentView[] } {
  type Row = Parameters<typeof rowView>[1]
  const open = db.all<Row>('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY opened_at DESC').map((r) => rowView(db, r))
  const recent = db.all<Row>('SELECT * FROM incidents WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?', history).map((r) => rowView(db, r))
  for (const o of held.get(db) ?? []) {
    const v = open.find((x) => x.key === o.key)
    if (o.op === 'open' && !v) open.unshift({ id: `held:${o.key}`, key: o.key, source: o.source, title: o.title, openedAt: o.ts, resolvedAt: null, resolution: null, affected: o.affected ?? {}, events: [{ ts: o.ts, event: 'opened', detail: o.detail }], held: true })
    else if (v && o.op === 'event') { v.events.push({ ts: o.ts, event: o.event, detail: null }); v.affected = { ...v.affected, ...o.affected } }
    else if (v && o.op === 'open') v.events.push({ ts: o.ts, event: 'again', detail: o.detail })
    else if (o.op === 'resolve') { const i = open.findIndex((x) => x.key === o.key); if (i >= 0) { const [done] = open.splice(i, 1); recent.unshift({ ...done!, resolvedAt: o.ts, resolution: o.resolution, held: true }) } }
  }
  return { open, recent: recent.slice(0, history) }
}
