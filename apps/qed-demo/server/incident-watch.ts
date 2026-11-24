/**
 * What the API itself notices for the incident log (R13, RE6): its own failed writes (a full disk, an I/O error), and
 * the engine's heartbeat going stale, which is the readiness of the engine as the API sees it. Everything else is
 * recorded where it happens (server/engine.ts).
 */
import type { Db } from './core.ts'
import { engineStatus } from './engine.ts'
import { flushHeld, incidentOpen, incidentsView, openIncident, probeStorage, resolveIncident, storageErrorKind, storageMessage } from './incidents.ts'

const failed = new WeakMap<Db, number>()
const probedAt = new WeakMap<Db, number>()

/** A request could not be saved. Opens (or adds to) the API's incident, and returns what to tell the person. */
export function apiStorageFailure(db: Db, now: number, kind: 'full' | 'io', what: string): string {
  const n = (failed.get(db) ?? 0) + 1
  failed.set(db, n)
  openIncident(db, now, {
    key: 'api-storage', source: 'api', title: kind === 'full' ? 'The disk is full: requests could not be saved' : 'The disk reported an error: requests could not be saved',
    detail: `${what} could not be saved; the request was rolled back and changed nothing.`, affected: { failedRequests: n },
  })
  return storageMessage(kind)
}

/** The API's recovery: once a write succeeds again, what was held is written and the incident closed. At most one probe every 5 s. */
export function recoverStorage(db: Db, now: number): void {
  if (!incidentOpen(db, 'api-storage')) return
  if (now - (probedAt.get(db) ?? 0) < 5000) return
  probedAt.set(db, now)
  const err = probeStorage(db)
  if (err) { if (!storageErrorKind(err)) throw err; return }
  try { flushHeld(db) } catch { return }
  resolveIncident(db, now, 'api-storage', `A write succeeded again. ${failed.get(db) ?? 0} request${failed.get(db) === 1 ? '' : 's'} could not be saved meanwhile and changed nothing.`, { failedRequests: failed.get(db) ?? 0 })
  failed.delete(db)
}

/** The incidents for Protect: the API's own fault checked first, and the engine's heartbeat read. */
export function incidentsFor(db: Db, now: number): { open: ReturnType<typeof incidentsView>['open']; recent: ReturnType<typeof incidentsView>['recent'] } {
  recoverStorage(db, now)
  try {
    const e = engineStatus(db, now)
    if (e.lastBeat !== null && !e.running) {
      const due = db.get<{ n: number }>(`SELECT COUNT(*) n FROM programs WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at BETWEEN ? AND ?`, e.lastBeat, now)?.n ?? 0
      openIncident(db, e.lastBeat, { key: 'engine-down', source: 'readiness', title: 'QED’s engine is not running', detail: `Its last heartbeat was at ${new Date(e.lastBeat).toISOString()}. Nothing is watched or carried out while it is down.`, affected: { missedRuns: due } })
    } else if (e.running && incidentOpen(db, 'engine-down')) resolveIncident(db, now, 'engine-down', 'The engine is running again.')
  } catch { /* the incident log is never the reason a page fails */ }
  return incidentsView(db)
}
