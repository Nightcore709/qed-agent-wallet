/**
 * Watch the engine work while no interface is open, and write down what was observed.
 *
 *   node scripts/unattended.ts <minutes> [output.json]
 *
 * Every few seconds it records two things that say whether an interface is open: whether anything is listening on
 * the interface's port, and how many live interface connections the API reports. It also reads the database for
 * runs and actions that happen during the watch. The result shows, minute by minute, that runs executed while both
 * of those were zero. It changes nothing.
 */
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { loadConfig, openDb, parse } from '../server/core.ts'

const cfg = loadConfig()
const webPort = Number(process.env.QED_WEB_PORT ?? 5174)
const minutes = Number(process.argv[2] ?? 10)
const out = process.argv[3] ?? 'unattended.json'
const db = openDb(cfg.dbPath)
const ist = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST'))
const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => { const s = connect({ host: '127.0.0.1', port }); const done = (v: boolean) => { s.destroy(); resolve(v) }; s.setTimeout(800, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false)) })

const started = Date.now()
const until = started + minutes * 60_000
const samples: { at: string | null; interfacePortOpen: boolean; interfaceConnections: number | null; engineRunning: boolean | null }[] = []
let anyOpen = 0

async function sample(): Promise<void> {
  const open = await portOpen(webPort)
  let conns: number | null = null, running: boolean | null = null
  try { const r = await fetch(`http://127.0.0.1:${cfg.apiPort}/api/health`, { headers: { Host: `127.0.0.1:${cfg.apiPort}` } }); const j = (await r.json()) as { interfaces?: number; engine?: { running?: boolean } }; conns = j.interfaces ?? null; running = j.engine?.running ?? null } catch { /* the API not answering is itself recorded as null */ }
  if (open || (conns ?? 0) > 0) anyOpen++
  samples.push({ at: ist(Date.now()), interfacePortOpen: open, interfaceConnections: conns, engineRunning: running })
}

console.log(`[unattended] watching for ${minutes} minutes from ${ist(started)}; interface port ${webPort}, API port ${cfg.apiPort}`)
await sample()
const timer = setInterval(() => { void sample() }, 5000)
await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())))
clearInterval(timer)
await sample()

const runs = db.all<Record<string, unknown>>('SELECT r.id, r.program_id, p.kind, p.title, r.state, r.due_at, r.created_at, r.started_at, r.finished_at, r.deadline_at, r.reason FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.created_at >= ? ORDER BY r.created_at', started)
const actions = db.all<Record<string, unknown>>('SELECT id, run_id, origin, kind, state, economic_id, times_json, recon_state, receipt_id, error, created_at FROM actions WHERE created_at >= ? ORDER BY created_at', started)
const report = {
  what: 'QED paper engine watched with no interface open',
  from: ist(started), to: ist(Date.now()), minutes,
  interface: {
    samples: samples.length,
    samplesWithAnInterfaceOpen: anyOpen,
    verdict: anyOpen === 0 ? 'No interface was open at any sample: nothing listened on the interface port and the API held no interface connection.' : `An interface was open in ${anyOpen} of ${samples.length} samples.`,
    everyMinute: samples.filter((_, i) => i % 12 === 0),
  },
  engineRunningThroughout: samples.every((s) => s.engineRunning === true),
  runs: runs.map((r) => ({ id: r.id, instruction: r.title, kind: r.kind, due: ist(r.due_at as number), claimed: ist(r.created_at as number), started: ist(r.started_at as number | null), finished: ist(r.finished_at as number | null), outcome: r.state, waitingUntil: ist(r.deadline_at as number | null), reason: r.reason })),
  actions: actions.map((a) => { const t = parse<Record<string, number>>(a.times_json, {}); return { id: a.id, run: a.run_id, origin: a.origin, kind: a.kind, outcome: a.state, reference: a.economic_id, asked: ist(a.created_at as number), decided: ist(t.decided), submitted: ist(t.submitted), executed: ist(t.executed), finished: ist(t.finished), reconciled: ist(t.reconciled), comparedWithVenue: a.recon_state, receipt: a.receipt_id, error: a.error } }),
}
writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`)
db.close()
console.log(`[unattended] ${out}: ${report.interface.verdict} Runs: ${runs.map((r) => `${String(r.kind)}=${String(r.state)}`).join(', ') || 'none'}. Actions: ${actions.map((a) => String(a.state)).join(', ') || 'none'}.`)
