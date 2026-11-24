/**
 * Export what the database records about background execution, as evidence that can be read without the interface.
 *
 *   node scripts/evidence.ts [output.json] [hours]
 *
 * It reads the database named by QED_DB (default data/qed.db) and writes: the engine's heartbeat, every recorded gap
 * in which the engine did not run, every run of every instruction with its outcome and reason, every action with the
 * time of each stage, the result of re-deriving the ledger's invariants, and the result of re-hashing the receipt
 * chain. Nothing is modified. Account names and handles are not included; ids are.
 */
import { writeFileSync } from 'node:fs'
import { loadConfig, openDb, parse } from '../server/core.ts'
import { engineStatus } from '../server/engine.ts'
import { verifyLedger } from '../server/ledger.ts'
import { verifyChain } from '../server/receipts.ts'

const cfg = loadConfig()
const out = process.argv[2] ?? 'evidence.json'
const hours = Number(process.argv[3] ?? 24)
const db = openDb(cfg.dbPath)
const now = Date.now()
const since = now - hours * 3600_000
const ist = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST'))
type Row = Record<string, unknown>

const users = db.all<{ id: string }>('SELECT id FROM users')
const gaps = db.all<{ id: number; from_ts: number; to_ts: number; note: string | null }>('SELECT id, from_ts, to_ts, note FROM downtime WHERE to_ts > ? ORDER BY id', since)
const runs = db.all<Row>('SELECT r.id, r.program_id, p.kind, r.version, r.occurrence, r.state, r.due_at, r.created_at, r.started_at, r.finished_at, r.reason FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.due_at > ? ORDER BY r.due_at', since)
const actions = db.all<Row>('SELECT id, run_id, program_id, origin, kind, venue, state, economic_id, times_json, recon_state, receipt_id, error, created_at FROM actions WHERE created_at > ? ORDER BY created_at', since)
const tally = (rows: Row[]): Record<string, number> => rows.reduce<Record<string, number>>((a, r) => { const k = String(r.state); a[k] = (a[k] ?? 0) + 1; return a }, {})

const report = {
  what: 'QED paper engine: recorded background execution',
  producedAt: ist(now), windowHours: hours, database: cfg.dbPath,
  howToReproduce: 'node scripts/evidence.ts <file> <hours>, against the same database. Every figure below is read from, or recomputed from, recorded rows.',
  engine: (() => { const e = engineStatus(db, now); return { ...e, startedAt: ist(e.startedAt), lastBeat: ist(e.lastBeat) } })(),
  gaps: {
    count: gaps.length,
    totalMinutes: Math.round(gaps.reduce((s, g) => s + (g.to_ts - g.from_ts), 0) / 60_000),
    list: gaps.map((g) => ({ from: ist(g.from_ts), to: ist(g.to_ts), minutes: +((g.to_ts - g.from_ts) / 60_000).toFixed(1), note: g.note, runsRecordedMissedInside: db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE state = 'missed' AND due_at >= ? AND due_at <= ?`, g.from_ts, g.to_ts)!.n })),
  },
  runs: {
    byOutcome: tally(runs),
    // A run is late if it started more than two minutes after it was due. There should be none: late occurrences are recorded as missed instead.
    startedMoreThanTwoMinutesLate: runs.filter((r) => typeof r.started_at === 'number' && typeof r.due_at === 'number' && r.state !== 'missed' && (r.started_at as number) - (r.due_at as number) > 120_000).length,
    list: runs.map((r) => ({ id: r.id, instruction: r.program_id, kind: r.kind, version: r.version, due: ist(r.due_at as number), claimed: ist(r.created_at as number), started: ist(r.started_at as number | null), finished: ist(r.finished_at as number | null), outcome: r.state, reason: r.reason })),
  },
  actions: {
    byOutcome: tally(actions),
    list: actions.map((a) => { const t = parse<Record<string, number>>(a.times_json, {}); return { id: a.id, run: a.run_id, origin: a.origin, kind: a.kind, venue: a.venue, outcome: a.state, reference: a.economic_id, asked: ist(a.created_at as number), decided: ist(t.decided), submitted: ist(t.submitted), executed: ist(t.executed), finished: ist(t.finished), reconciled: ist(t.reconciled), msFromAskedToExecuted: t.executed ? t.executed - (a.created_at as number) : null, comparedWithVenue: a.recon_state, receipt: a.receipt_id, error: a.error } }),
  },
  duplicates: {
    // The same occurrence of the same instruction, or the same economic reference, appearing twice would be a duplicate execution.
    occurrencesClaimedTwice: db.get<{ n: number }>('SELECT COUNT(*) n FROM (SELECT program_id, occurrence FROM runs GROUP BY program_id, occurrence HAVING COUNT(*) > 1)')!.n,
    referencesUsedTwice: db.get<{ n: number }>('SELECT COUNT(*) n FROM (SELECT user_id, economic_id FROM actions GROUP BY user_id, economic_id HAVING COUNT(*) > 1)')!.n,
    venueOrdersPerReferenceAboveOne: db.get<{ n: number }>('SELECT COUNT(*) n FROM (SELECT client_ref FROM pv_orders GROUP BY client_ref HAVING COUNT(*) > 1)')!.n,
  },
  integrity: users.map((u) => { const c = verifyChain(db, u.id); return { owner: u.id, ledgerBreaks: verifyLedger(db, u.id), receiptChain: { intact: c.ok, receipts: c.count, brokenAt: c.brokenAt, head: c.head } } }),
  sources: db.all<Row>('SELECT provider, state, last_ok, messages, reconnects FROM provider_status ORDER BY provider').map((p) => ({ ...p, last_ok: ist(p.last_ok as number | null) })),
  clock: db.get<Row>('SELECT ts, reference, offset_ms, uncertainty_ms FROM clock_checks ORDER BY id DESC LIMIT 1') ?? null,
}
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
db.close()
console.log(`[evidence] ${out}: ${gaps.length} gaps, runs ${JSON.stringify(report.runs.byOutcome)}, actions ${JSON.stringify(report.actions.byOutcome)}, late starts ${report.runs.startedMoreThanTwoMinutesLate}, duplicates ${JSON.stringify(report.duplicates)}`)
