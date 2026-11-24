/**
 * Incidents (R13, RE6): opened with a time, a timeline, what they affected, and a resolution with its time; one open per
 * key; held in memory while the disk cannot be written and written, with their own times, when it can.
 * QED_SEED_FAIL=1 makes the last test fail on purpose.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './core.ts'
import { flushHeld, heldCount, incidentOpen, incidentsView, noteIncident, openIncident, probeStorage, resolveIncident, storageErrorKind } from './incidents.ts'
import { toSchemaV7 } from './schema-fixture.ts'

const T = 1_800_000_000_000
const tmp = () => mkdtempSync(join(tmpdir(), 'qed-incidents-'))

describe('the incident log', () => {
  it('records opened, events, what was affected, resolved and when; one open incident per key', () => {
    const db = openDb(':memory:')
    openIncident(db, T, { key: 'wallet-service', source: 'wallet-service', title: 'The wallet service did not answer the engine', detail: 'tick not accepted (no answer)', affected: { missedTicks: 1 } })
    openIncident(db, T + 300_000, { key: 'wallet-service', source: 'wallet-service', title: 'x', detail: 'again', affected: { missedTicks: 2 } })
    noteIncident(db, T + 400_000, 'wallet-service', 'The engine tried the next slot')
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM incidents')!.n).toBe(1)
    expect(incidentOpen(db, 'wallet-service')).toBe(true)
    resolveIncident(db, T + 600_000, 'wallet-service', 'The wallet service answered.', { missedTicks: 2 })
    const v = incidentsView(db)
    expect(v.open).toEqual([])
    expect(v.recent).toHaveLength(1)
    const i = v.recent[0]!
    expect([i.openedAt, i.resolvedAt, i.resolution, i.affected]).toEqual([T, T + 600_000, 'The wallet service answered.', { missedTicks: 2 }])
    expect(i.events.map((e) => [e.ts - T, e.event])).toEqual([[0, 'opened'], [300_000, 'again'], [400_000, 'The engine tried the next slot'], [600_000, 'resolved']])
    // a new fault of the same kind is a new incident
    openIncident(db, T + 900_000, { key: 'wallet-service', source: 'wallet-service', title: 't', detail: 'd' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM incidents')!.n).toBe(2)
    expect(incidentsView(db).open).toHaveLength(1)
    // resolving what is not open is nothing
    resolveIncident(db, T, 'nothing', 'x')
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM incidents')!.n).toBe(2)
  })

  it('keeps only a short history, newest first, and caps a long fault\'s events', () => {
    const db = openDb(':memory:')
    for (let n = 0; n < 8; n++) { openIncident(db, T + n * 1000, { key: `k${n}`, source: 'engine', title: `t${n}`, detail: 'd' }); resolveIncident(db, T + n * 1000 + 10, `k${n}`, 'ok') }
    expect(incidentsView(db, 5).recent.map((x) => x.title)).toEqual(['t7', 't6', 't5', 't4', 't3'])
    for (let n = 0; n < 300; n++) openIncident(db, T + n, { key: 'long', source: 'engine', title: 'long', detail: `again ${n}`, affected: { failedRequests: n } })
    const long = incidentsView(db).open[0]!
    expect(long.events.length).toBeLessThanOrEqual(101)
    expect(long.affected.failedRequests).toBe(299)
  })

  it('classifies SQLite\'s own codes: full, I/O, read-only; anything else is not a storage error', () => {
    expect(storageErrorKind({ errcode: 13 })).toBe('full')
    expect(storageErrorKind({ errcode: 10 | (6 << 8) })).toBe('io')
    expect(storageErrorKind({ errcode: 8 })).toBe('io')
    expect(storageErrorKind({ errcode: 19, message: 'constraint failed' })).toBeNull()
    expect(storageErrorKind(new Error('ENOSPC: no space left on device'))).toBe('full')
    expect(storageErrorKind(new Error('boom'))).toBeNull()
  })

  it('a full disk: the incident is held, shown, and written with its own times once a write succeeds', () => {
    const dir = tmp()
    try {
      const db = openDb(join(dir, 'qed.db'))
      const pages = (db.get<{ page_count: number }>('PRAGMA page_count')!).page_count
      db.exec(`PRAGMA max_page_count = ${pages}`)
      for (let n = 0; n < 200; n++) { try { db.run('INSERT INTO meta (key, value) VALUES (?, hex(zeroblob(4000)))', `filler${n}`) } catch (e) { expect(storageErrorKind(e)).toBe('full'); break } }
      expect(storageErrorKind(probeStorage(db))).toBe('full')
      // the opening cannot be written: a big incident row needs room too, so fill what is left
      openIncident(db, T, { key: 'disk', source: 'engine', title: 'The disk is full', detail: 'x'.repeat(20000) })
      expect(heldCount(db), 'the incident could not be written and is held').toBe(1)
      expect(incidentOpen(db, 'disk')).toBe(true)
      expect(incidentsView(db).open.map((i) => [i.key, i.openedAt])).toEqual([['disk', T]])
      resolveIncident(db, T + 5000, 'disk', 'Space returned.')
      const during = incidentsView(db)
      expect(during.open).toEqual([])
      expect(during.recent[0]).toMatchObject({ key: 'disk', openedAt: T, resolvedAt: T + 5000, resolution: 'Space returned.' })
      // space returns
      db.exec('PRAGMA max_page_count = 1000000')
      expect(probeStorage(db)).toBeNull()
      flushHeld(db)
      expect(heldCount(db)).toBe(0)
      const after = incidentsView(db).recent[0]!
      expect([after.openedAt, after.resolvedAt, after.held]).toEqual([T, T + 5000, false])
      expect(after.events.map((e) => e.event)).toEqual(['opened', 'resolved'])
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the tables are part of the one v7 to v8 step: a v7 file gets them on opening, and toSchemaV7 takes them out', () => {
    const dir = tmp()
    try {
      const path = join(dir, 'qed.db')
      openDb(path).close()
      toSchemaV7(path)
      const v7 = openDb(path)   // migrates back up (a sealed copy is not needed for an empty database)
      expect(v7.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE name IN ('incidents', 'incident_events')`).map((r) => r.name).sort()).toEqual(['incident_events', 'incidents'])
      v7.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('seeded failure: false when QED_SEED_FAIL=1', () => {
    expect(process.env.QED_SEED_FAIL === '1').toBe(false)
  })
})
