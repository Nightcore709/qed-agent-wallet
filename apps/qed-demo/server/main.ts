/**
 * Entry point.  node server/main.ts <engine | api | status | verify | reset>
 *
 *   engine   the continuously running service (data, scheduling, execution, reconciliation)
 *   api      the authenticated HTTP service the interface talks to; it also serves the built interface
 *   status   print what the database says about the engine, providers and clock
 *   verify   re-check every owner's ledger and receipt chain; exit code 1 if anything is broken
 *   reset    seal the database into an encrypted backup (the backup key, docs/ENCRYPTION.md), then remove its files, so
 *            the next start begins empty and no plaintext copy is left; without the backup key it refuses and changes nothing
 *
 * A database at an older schema is migrated when it is opened, after an encrypted copy of it is sealed and checked
 * (server/migration-copy.ts); without the migration-copy key the process stops with the reason and leaves the database
 * as it was.
 *
 * SIGTERM (a platform stopping or replacing the container), SIGINT and SIGHUP stop the engine and the API gracefully
 * (docs/DEPLOY.md, "Graceful shutdown"): no new work, the work under way finished or safely abandoned within
 * QED_STOP_GRACE_MS (default 15000), the database closed, exit 0. A second signal during that wait exits at once.
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createBackup } from './backup.ts'
import { loadConfig, openDb } from './core.ts'
import { Engine, engineStatus } from './engine.ts'
import { keyPaths, migrationCopyDir, openKeyring } from './key-config.ts'
import { KeyError } from './keys.ts'
import { verifyLedger } from './ledger.ts'
import { log } from './log.ts'
import { MigrationRefused } from './migration-copy.ts'
import { verifyChain } from './receipts.ts'

const cmd = process.argv[2] ?? 'status'
const cfg = loadConfig()
// A refused migration is an expected, explained stop: its message alone, not a stack trace. Anything else is printed as before.
process.on('uncaughtException', (e) => {
  if (process.env.QED_LOG_FORMAT === 'json') log('qed', 'error', e instanceof MigrationRefused ? 'refused to start' : 'uncaught exception', { reason: e instanceof MigrationRefused ? e.reason : undefined, error: e instanceof Error ? e : String(e), stack: e instanceof Error && !(e instanceof MigrationRefused) ? e.stack?.split('\n').slice(1, 6).map((l) => l.trim()).join(' < ') : undefined })
  else console.error(e instanceof MigrationRefused ? `[qed] ${e.message}` : e)
  process.exit(1)
})

// SIGINT, SIGTERM and SIGHUP are taken from the start, before the database is opened. Opening it may seal a migration's
// copy, and a reset seals a backup: both synchronous, with a plaintext snapshot on disk for a moment, so a signal now waits
// for the step to finish and clean up instead of killing the process half-way (independent review of cb85271, finding 1).
// Then the running service, if there is one, is stopped gracefully. What a SIGKILL leaves is swept by the next seal
// (scratch.ts); what a SIGKILL interrupts in the engine is resumed by the next engine (PRODUCTION.md section 8).
const GRACE_MS = ((v: string | undefined): number => {
  if (v === undefined || v === '') return 15_000
  if (!/^\d{1,6}$/.test(v) || Number(v) > 120_000) { console.error(`Configuration: QED_STOP_GRACE_MS must be whole milliseconds from 0 to 120000 (it was "${v.slice(0, 20)}").`); process.exit(2) }
  return Number(v)
})(process.env.QED_STOP_GRACE_MS)
let stopService: (() => Promise<void> | void) | undefined
let stopping = false
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(s, () => {
    if (stopping) { log('qed', 'warn', `${s} again while stopping: exiting now`); process.exit(1) }
    stopping = true
    Promise.resolve().then(() => stopService?.()).then(() => process.exit(0), (e: unknown) => { log('qed', 'error', 'stop failed', { error: e instanceof Error ? e : String(e) }); process.exit(1) })
  })
}
function onSignals(stop: () => Promise<void> | void): void { stopService = stop }

if (cmd === 'engine') {
  // An engine that finds another engine has taken its database stops acting and exits (75, "try again later"), so that
  // its supervisor restarts it; the restart then meets the other engine's lock and refuses to start beside it (ADR-0013).
  const engine = new Engine(cfg, { onFenced: (why) => { log('engine', 'error', 'stopped acting; exiting', { why, exitCode: 75 }); process.exit(75) } })
  engine.start()
  log('engine', 'info', 'running', { pid: process.pid, database: cfg.dbPath })
  onSignals(async () => {
    const r = await engine.stopGracefully(GRACE_MS)
    log('engine', r.abandoned ? 'warn' : 'info', 'stopped', { waitedMs: r.waitedMs, abandonedStep: r.abandoned, graceMs: GRACE_MS })
  })
} else if (cmd === 'api') {
  const { startApi } = await import('./api.ts')
  const api = startApi(cfg)
  log('api', 'info', 'listening', { url: `${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.apiPort}`, publicOrigin: cfg.publicOrigin ?? 'none (local build)', pid: process.pid })
  onSignals(async () => {
    const r = await api.drain(GRACE_MS)
    log('api', r.abandoned ? 'warn' : 'info', 'stopped', { waitedMs: r.waitedMs, abandonedRequests: r.abandoned, graceMs: GRACE_MS })
  })
} else if (cmd === 'status') {
  const db = openDb(cfg.dbPath)
  const now = Date.now()
  console.log(JSON.stringify({
    engine: engineStatus(db, now),
    providers: db.all('SELECT provider, state, since, last_ok, last_error, messages, reconnects FROM provider_status ORDER BY provider'),
    quotes: db.all('SELECT instrument_id, price_type, price, source_ts, recv_ts, provider FROM quotes ORDER BY instrument_id, price_type'),
    clock: db.get('SELECT ts, reference, offset_ms, uncertainty_ms FROM clock_checks ORDER BY id DESC LIMIT 1') ?? null,
    downtime: db.all('SELECT service, from_ts, to_ts, missed_runs FROM downtime ORDER BY id DESC LIMIT 5'),
  }, null, 1))
  db.close()
} else if (cmd === 'verify') {
  const db = openDb(cfg.dbPath)
  let bad = 0
  for (const u of db.all<{ id: string; handle: string }>('SELECT id, handle FROM users')) {
    const breaks = verifyLedger(db, u.id)
    const chain = verifyChain(db, u.id)
    console.log(`${u.handle}: ledger ${breaks.length ? `${breaks.length} break(s)` : 'consistent'}; receipts ${chain.ok ? `${chain.count} intact` : `broken at ${chain.brokenAt}`}`)
    for (const b of breaks) console.log(`  ${b.check}: ${b.detail}`)
    if (breaks.length || !chain.ok) bad++
  }
  db.close()
  process.exit(bad ? 1 : 0)
} else if (cmd === 'reset') {
  if (!existsSync(cfg.dbPath)) console.log('No database to reset.')
  else {
    // Sealed rather than moved aside in plaintext: the data survives, encrypted; the database files are removed. Not while
    // a service may have them open: its later writes would go to removed files. No backup key, no reset.
    if (existsSync(`${cfg.dbPath}-wal`) || existsSync(`${cfg.dbPath}-shm`)) { console.error(`${cfg.dbPath} may still be open (it has a -wal or -shm file). Stop the API and the engine first.`); process.exit(1) }
    const backupDir = keyPaths().backupDir
    let ring
    try { ring = openKeyring('backup', { forbidden: [dirname(cfg.dbPath), backupDir, migrationCopyDir(cfg.dbPath)] }) } catch (e) {
      if (!(e instanceof KeyError)) throw e
      console.error(`reset seals the database into an encrypted backup before removing it, and the backup key is not available (${e.code}): ${e.message} Nothing was changed. Set the keys up with \`npm run keys:init\` (or point QED_KEY_DIR at them), then run reset again.`)
      process.exit(1)
    }
    const r = createBackup({ db: cfg.dbPath, outDir: backupDir, keyring: ring })
    for (const ext of ['', '-wal', '-shm']) rmSync(cfg.dbPath + ext, { force: true })
    console.log(`Backed the database up encrypted (${r.manifestPath}) and removed it. The next start begins empty.`)
  }
} else if (cmd === 'sessions') {
  // The installation operator ends sessions (ASVS 5.0 V7.4.5): one person's, by handle, or everyone's. Each person is told
  // in their security history and the audit keeps the operator's act. Nothing else changes: passkeys and data stay.
  //   node server/main.ts sessions end <handle>      node server/main.ts sessions end --all
  const [verb, who] = process.argv.slice(3)
  if (verb !== 'end' || !who) { console.error('Usage: node server/main.ts sessions end <handle> | --all'); process.exit(2) }
  const db = openDb(cfg.dbPath)
  const now = Date.now()
  const people = who === '--all' ? db.all<{ id: string; handle: string }>(`SELECT id, handle FROM users WHERE kind = 'person'`) : db.all<{ id: string; handle: string }>(`SELECT id, handle FROM users WHERE kind = 'person' AND handle = ?`, who.toLowerCase())
  if (!people.length) { console.error(`No person has the handle "${who}". Nothing was changed.`); db.close(); process.exit(1) }
  let ended = 0
  db.tx(() => {
    for (const p of people) {
      const n = db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, p.id).changes
      ended += n
      if (n) {
        db.run('INSERT INTO security_events (person_id, ts, kind, detail_json) VALUES (?, ?, ?, ?)', p.id, now, 'sessions-ended-by-operator', JSON.stringify({ n }))
        db.run('INSERT INTO audit (ts, user_id, actor, action, subject, detail_json, ip) VALUES (?, ?, ?, ?, ?, ?, ?)', now, p.id, 'operator', 'sessions.end', p.id, JSON.stringify({ n, scope: who === '--all' ? 'everyone' : 'one person' }), null)
      }
    }
  })
  console.log(`Ended ${ended} session${ended === 1 ? '' : 's'} of ${people.length} ${people.length === 1 ? 'person' : 'people'}.`)
  db.close()
} else {
  console.error('Usage: node server/main.ts <engine | api | status | verify | reset | sessions end <handle>|--all>')
  process.exit(2)
}
