/**
 * The container's process supervisor (docs/DEPLOY.md, "Processes"); the local rehearsals run it too.
 *
 *   node scripts/deploy/supervise.ts
 *
 * One container holds QED's three processes, each in its own process, sharing one volume:
 *   wallet   node chain/serve.ts          loopback only (QED_RAIL_PORT, default 5176), its Anvil chain on loopback (8546)
 *   engine   node server/main.ts engine   no port; the one runner of scheduled work (the lock qed.db.engine-lock)
 *   api      node server/main.ts api      the one public port (PORT, else QED_API_PORT), behind the platform's TLS
 * SQLite is shared by the engine and the API through the volume, so they must run on one machine; the wallet service
 * answers on loopback only (server/rail.ts refuses any other address). Nothing else listens.
 *
 * Before anything starts: the configuration is checked (server/core.ts refuses a wrong origin or relying-party id); the
 * key-encryption key must be there (QED_KEK is written to a private file and this process re-executes without it, so
 * that not even its own initial environment keeps it: R13 review fix F3, server/kek-handoff.ts); the
 * backup and migration-copy keyrings are made if missing (first start) or checked; a restore asked for with
 * QED_RESTORE_MANIFEST is applied once; the stopped wallet service's files are archived under the backup key (when
 * changed since the last archive) and its secrets prepared for sealing. Then the wallet service, the engine (which
 * migrates an older database once, after a sealed copy) and, once the engine runs, the API.
 *
 * A child that exits on its own is restarted after 1, 2, 4 ... 30 s; six exits within ten minutes stop everything and
 * the supervisor exits 1, so that the platform restarts the container. SIGTERM or SIGINT stops the API, then the engine,
 * then the wallet service, each gracefully (QED_STOP_GRACE_MS, default 15000, then SIGKILL), and exits 0; a second
 * signal kills them at once. While the maintenance file exists (QED_MAINTENANCE_FILE, default <data>/MAINTENANCE) the
 * services are stopped and the public port answers 503; removing the file starts them again. QED_BACKUP_EVERY_MIN
 * (default 0, off) takes a sealed backup of the database at that interval beside the running services.
 *
 * Settings (all optional; docs/DEPLOY.md and .env.example list every one the services read):
 *   QED_DATA_DIR   the volume: defaults QED_DB=<data>/app/qed.db, QED_RAIL_DATA=<data>/app, QED_KEY_DIR=<data>/keys,
 *                  QED_BACKUP_DIR=<data>/backups (each used only when not set itself)
 *   QED_WALLET     "on" (default) or "off": start the wallet service
 *   QED_SECRETS_DIR  a private folder outside the volume for the key-encryption key's file (default /run/qed)
 * Output is one line per event, JSON when QED_LOG_FORMAT=json, every child's line passed through server/log.ts's redact.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from '../../server/core.ts'
import { initKeys } from '../../server/key-config.ts'
import { withoutCaps } from '../../chain/rail/caps.ts'
import { reexecWithoutKek } from '../../server/kek-handoff.ts'
import { type Level, log, redact } from '../../server/log.ts'

// R13 review fix F3 (i): before anything else, QED_KEK goes to a private file and this process re-executes without it.
try { reexecWithoutKek(process.env.QED_SECRETS_DIR ?? '/run/qed') } catch (e) { log('supervisor', 'error', 'key-encryption key refused', { reason: e instanceof Error ? e.message : String(e) }, process.env); process.exit(2) }

const APP = resolve(import.meta.dirname, '..', '..')
const env: NodeJS.ProcessEnv = { ...process.env }
// The revision this image was built from (the Dockerfile writes REVISION; a checkout has git instead): passed to the
// children, so that the readiness page names it (server/readiness.ts) and every start logs it.
if (!env.QED_REVISION && existsSync(join(APP, 'REVISION'))) { const r = readFileSync(join(APP, 'REVISION'), 'utf8').trim(); if (/^[0-9a-f]{7,40}$/.test(r)) env.QED_REVISION = r }
const say = (level: Level, event: string, fields: Record<string, unknown> = {}): void => log('supervisor', level, event, fields, env)
const fatal = (event: string, fields: Record<string, unknown> = {}): never => { say('error', event, fields); process.exit(2) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------------------------------------------------ settings
const data = env.QED_DATA_DIR ? resolve(env.QED_DATA_DIR) : null
if (data) {
  env.QED_DB ??= join(data, 'app', 'qed.db')
  env.QED_RAIL_DATA ??= join(data, 'app')
  env.QED_KEY_DIR ??= join(data, 'keys')
  env.QED_BACKUP_DIR ??= join(data, 'backups')
}
if (env.PORT && !env.QED_API_PORT) env.QED_API_PORT = env.PORT
const dbPath = resolve(env.QED_DB ?? join(APP, 'data', 'qed.db'))
env.QED_DB = dbPath
const railData = resolve(env.QED_RAIL_DATA ?? dirname(dbPath))
env.QED_RAIL_DATA = railData
const wanted = (env.QED_WALLET ?? 'on').toLowerCase()
if (wanted !== 'on' && wanted !== 'off') fatal('QED_WALLET must be "on" or "off"', { was: wanted })
const walletOn = wanted === 'on'
const whole = (name: string, fallback: number, max: number): number => {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  if (!/^\d{1,7}$/.test(v) || Number(v) > max) fatal(`${name} must be a whole number from 0 to ${max}`, { was: v.slice(0, 20) })
  return Number(v)
}
const GRACE_MS = whole('QED_STOP_GRACE_MS', 15_000, 120_000)
env.QED_STOP_GRACE_MS = String(GRACE_MS)
const BACKUP_EVERY_MIN = whole('QED_BACKUP_EVERY_MIN', 0, 10_080)
// Restore drill schedule (hours; 0 = off, the default; 168 = weekly is recommended). Off-host copies (QED_OFFSITE) and
// retention (QED_BACKUP_RETENTION) are off unless set; scripts/backup-offsite.ts reads their settings. The store's access
// key is held back from every long-running child (API, engine, wallet service) and given only to that script.
const DRILL_EVERY_HOURS = whole('QED_DRILL_EVERY_HOURS', 0, 8_760)
const offsiteSecrets: NodeJS.ProcessEnv = {}
for (const k of ['QED_OFFSITE_ACCESS_KEY_ID', 'QED_OFFSITE_SECRET_ACCESS_KEY']) { if (env[k] !== undefined) offsiteSecrets[k] = env[k]; delete env[k]; delete process.env[k] }
const maintenanceFile = resolve(env.QED_MAINTENANCE_FILE ?? join(data ?? dirname(dbPath), 'MAINTENANCE'))

// The configuration the API and the engine will read: refused here, with its reason, before anything starts.
let cfg: ReturnType<typeof loadConfig>
try { cfg = loadConfig(env) } catch (e) { fatal('configuration refused', { reason: e instanceof Error ? e.message : String(e) }) }
if (!existsSync(join(cfg!.webDist, 'index.html'))) fatal('the interface is not built', { webDist: cfg!.webDist, fix: 'npm run build' })

// ------------------------------------------------------------------------------------------------------------- keys
/** The key-encryption key is required: without it a migration cannot seal its copy, so an upgrade would stop. */
function prepareKeys(): void {
  if (env.QED_KEK) {
    if (env.QED_KEY_FILE) fatal('both QED_KEK and QED_KEY_FILE are set; set one')
    if (!/^qedkek1:[^\s:]+:[^\s:]+:[^\s:]+$/.test(env.QED_KEK.trim())) fatal('QED_KEK is not a key-encryption key record (qedkek1:<id>:<key>:<check>, made by npm run keys:init)')
    const dir = resolve(env.QED_SECRETS_DIR ?? '/run/qed')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const file = join(dir, 'qed.kek')
    writeFileSync(file, `${env.QED_KEK.trim()}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    env.QED_KEY_FILE = file
  }
  delete env.QED_KEK
  delete process.env.QED_KEK
  const kekFile = resolve(env.QED_KEY_FILE ?? join(resolve(env.QED_KEY_DIR ?? join(env.HOME ?? homedir(), '.qed', 'keys')), 'qed.kek'))
  if (!existsSync(kekFile)) fatal('no key-encryption key', { expected: kekFile, fix: 'set QED_KEK to the record made by npm run keys:init (docs/DEPLOY.md, Secrets), or QED_KEY_FILE to its file' })
  try {
    const r = initKeys({ env, purposes: ['backup', 'migration-copy'] })
    for (const k of r.keyrings) say('info', k.created ? 'keyring made (first start)' : 'keyring checked', { purpose: k.purpose, version: k.version, check: k.check ?? 'none', wrappedBy: r.kek.id })
  } catch (e) { fatal('the keys could not be opened', { reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }) }
}

// ---------------------------------------------------------------------------------------------------------- helpers
interface Run { code: number | null; out: string }
/** A one-off command of this app (backup, restore, verify, sealing), its output kept and relayed. */
function runOnce(svc: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolveRun) => {
    const cmd = withoutCaps(process.execPath, args, env) // R13 review fix F3: a one-off command holds no capability
    const c = spawn(cmd.file, cmd.args, { cwd: APP, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const take = (level: Level) => (d: Buffer): void => { const s = d.toString(); out += s; for (const l of s.split('\n')) if (l.trim()) relay(svc, level, l) }
    c.stdout!.on('data', take('info'))
    c.stderr!.on('data', take('warn'))
    c.on('exit', (code) => resolveRun({ code, out }))
    c.on('error', (e) => resolveRun({ code: -1, out: e.message }))
  })
}
/** A child's line: passed on as it is when it is already one of our JSON lines, else wrapped, always redacted. */
function relay(svc: string, level: Level, line: string): void {
  if (line.startsWith('{')) { try { const o = JSON.parse(line) as Record<string, unknown>; if (o && typeof o.svc === 'string') { process.stdout.write(`${line}\n`); return } } catch { /* not ours */ } }
  if (env.QED_LOG_FORMAT === 'json') process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, svc, event: 'output', msg: redact(line) })}\n`)
  else process.stdout.write(`${line.startsWith('[') ? redact(line) : `[${svc}] ${redact(line)}`}\n`)
}
function findAnvil(): string | null {
  if (env.QED_RAIL_ANVIL) return existsSync(env.QED_RAIL_ANVIL) ? env.QED_RAIL_ANVIL : null
  for (const d of [...(env.PATH ?? '').split(delimiter), join(env.HOME ?? homedir(), '.foundry', 'bin')]) if (d && existsSync(join(d, 'anvil'))) return join(d, 'anvil')
  return null
}

// --------------------------------------------------------------------------------------------- restore (asked for)
/** QED_RESTORE_MANIFEST with QED_RESTORE_CONFIRM set to its backup id: restored once, before anything starts. */
async function restoreIfAsked(): Promise<void> {
  const m = env.QED_RESTORE_MANIFEST
  if (!m) return
  let id = ''
  try { id = String((JSON.parse(readFileSync(m, 'utf8')) as { id?: unknown }).id ?? '') } catch (e) { fatal('QED_RESTORE_MANIFEST cannot be read', { manifest: m, reason: e instanceof Error ? e.message : String(e) }) }
  const marker = join(dirname(dbPath), `restored-${id}.json`)
  if (existsSync(marker)) { say('warn', 'restore already applied; remove QED_RESTORE_MANIFEST and QED_RESTORE_CONFIRM', { backup: id, record: marker }); return }
  if (env.QED_RESTORE_CONFIRM !== id) fatal('a restore replaces the live database; set QED_RESTORE_CONFIRM to the backup id to confirm', { backup: id })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // The live database is sealed into a backup before it is replaced. A database left open by a killed container has its
  // log beside it, which a restore refuses (live_in_use): with no service running here it is closed properly first, so
  // that copy holds everything. A damaged one (the usual reason for a restore) cannot be copied that way: it is moved
  // aside whole, with its log files, into a private folder beside it, and kept (deleting it is the owner's decision).
  if (existsSync(dbPath)) {
    let damaged = false
    try {
      const d = new DatabaseSync(dbPath)
      try { damaged = (d.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined)?.quick_check !== 'ok'; if (!damaged) d.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { d.close() }
    } catch { damaged = true }
    if (damaged) {
      const q = join(dirname(dbPath), `damaged-${stamp}`)
      mkdirSync(q, { recursive: true, mode: 0o700 })
      for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, join(q, basename(dbPath) + ext))
      say('warn', 'the live database is damaged: moved aside, kept, not copied', { to: q })
    }
  }
  const keep = join(resolve(env.QED_BACKUP_DIR ?? join(env.HOME ?? homedir(), '.qed', 'backups')), `before-restore-${stamp}`)
  say('info', 'restoring', { backup: id, liveCopyTo: keep })
  const r = await runOnce('restore', [join(APP, 'scripts', 'backup.ts'), 'restore', '--manifest', m, '--target', dbPath, '--overwrite-live', '--backup-live-to', keep])
  if (r.code !== 0) fatal('the restore was refused; nothing was started', { backup: id, exit: r.code })
  const v = await runOnce('verify', [join(APP, 'server', 'main.ts'), 'verify'])
  if (v.code !== 0) fatal('the restored database does not verify; nothing was started', { backup: id, exit: v.code })
  writeFileSync(marker, `${JSON.stringify({ backup: id, manifest: m, restoredAt: new Date().toISOString(), liveCopiedTo: keep })}\n`, { mode: 0o600 })
  say('info', 'restored and verified', { backup: id })
}

// ------------------------------------------------------------------------------------------ the wallet service's data
const WALLET_FILES = ['rail.db', 'rail.db-wal', 'rail.db-shm', 'rail/master.key', 'rail/master.key.sealed', 'rail/cosigner.key', 'rail/cosigner.key.sealed', 'rail/keyring.json', 'rail/cosigner-state.json', 'rail/anvil-state.hex']
/** The stopped wallet service's files, sealed into an archive under the backup key, unless unchanged since the last one. */
async function archiveWallet(): Promise<boolean> {
  const files = WALLET_FILES.map((f) => join(railData, f)).filter((f) => existsSync(f))
  if (!files.length) return true
  const stamp = createHash('sha256').update(files.map((f) => { const s = statSync(f); return `${f}:${s.size}:${s.mtimeMs}` }).join('\n')).digest('hex')
  const out = join(resolve(env.QED_BACKUP_DIR ?? join(env.HOME ?? homedir(), '.qed', 'backups')), 'wallet-service')
  const last = join(out, '.last-archived')
  if (existsSync(last) && readFileSync(last, 'utf8').trim() === stamp) { say('info', 'wallet service data unchanged since its last archive'); return true }
  const r = await runOnce('archive', [join(APP, 'scripts', 'plaintext-copies.ts'), 'archive', ...files.flatMap((f) => ['--file', f]), '--assume-closed', join(railData, 'rail.db'), '--out', out])
  if (r.code !== 0) { say('error', 'the wallet service data could not be archived', { exit: r.code }); return false }
  mkdirSync(out, { recursive: true, mode: 0o700 })
  writeFileSync(last, `${stamp}\n`, { mode: 0o600 })
  return true
}

// -------------------------------------------------------------------------------------------------------- children
/** keepCaps: the wallet service only, which starts the co-signer as its own user (R13 review fix F3, chain/rail/caps.ts). */
interface Spec { name: string; args: string[]; cwd: string; extra?: NodeJS.ProcessEnv; keepCaps?: boolean }
class Child {
  proc: ChildProcess | null = null
  private exits: number[] = []
  private wanted = false
  private restartTimer: NodeJS.Timeout | null = null
  readonly spec: Spec
  constructor(spec: Spec) { this.spec = spec }
  start(): void {
    this.wanted = true
    const cmd = this.spec.keepCaps ? { file: process.execPath, args: this.spec.args } : withoutCaps(process.execPath, this.spec.args, env)
    const c = spawn(cmd.file, cmd.args, { cwd: this.spec.cwd, env: { ...env, ...this.spec.extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = c
    let partial = { out: '', err: '' }
    const take = (k: 'out' | 'err') => (d: Buffer): void => {
      const s = partial[k] + d.toString()
      const lines = s.split('\n')
      partial = { ...partial, [k]: lines.pop() ?? '' }
      for (const l of lines) if (l.trim()) { relay(this.spec.name, k === 'err' ? 'warn' : 'info', l); this.onLine?.(l) }
    }
    c.stdout!.on('data', take('out'))
    c.stderr!.on('data', take('err'))
    c.on('error', (e) => say('error', 'could not start', { child: this.spec.name, reason: e.message }))
    c.on('exit', (code, signal) => {
      if (this.proc === c) this.proc = null
      if (!this.wanted) return
      const now = Date.now()
      this.exits = [...this.exits.filter((t) => now - t < 10 * 60_000), now]
      if (this.exits.length >= 6) { say('error', 'exited six times in ten minutes; stopping everything', { child: this.spec.name, code, signal }); void shutdown(1); return }
      const wait = Math.min(30_000, 1000 * 2 ** (this.exits.length - 1))
      say('error', 'exited unexpectedly; restarting', { child: this.spec.name, code, signal, inMs: wait })
      this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.wanted && !stopping) this.start() }, wait)
    })
    say('info', 'started', { child: this.spec.name, pid: c.pid })
  }
  onLine?: (line: string) => void
  /** SIGTERM, then SIGKILL after the grace and a margin. Resolves when the process has gone. */
  async stop(): Promise<void> {
    this.wanted = false
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const c = this.proc
    if (!c || c.exitCode !== null || c.signalCode !== null) return
    const gone = new Promise<void>((r) => c.once('exit', () => r()))
    c.kill('SIGTERM')
    const t0 = Date.now()
    const killed = await Promise.race([gone.then(() => false), sleep(GRACE_MS + 5_000).then(() => true)])
    if (killed) { say('warn', 'did not stop within the grace; killed', { child: this.spec.name }); c.kill('SIGKILL'); await gone }
    else say('info', 'stopped', { child: this.spec.name, ms: Date.now() - t0 })
  }
  kill(): void { this.wanted = false; this.proc?.kill('SIGKILL') }
}

const wallet = new Child({ name: 'wallet', args: [join(APP, 'chain', 'serve.ts')], cwd: join(APP, 'chain'), extra: { QED_RAIL_SEAL: '1' }, keepCaps: true })
const engine = new Child({ name: 'engine', args: [join(APP, 'server', 'main.ts'), 'engine'], cwd: APP })
const api = new Child({ name: 'api', args: [join(APP, 'server', 'main.ts'), 'api'], cwd: APP })

let stopping = false
let running = false
let maintenance: Server | null = null
let backupTimer: NodeJS.Timeout | null = null
let drillTimer: NodeJS.Timeout | null = null

async function startServices(): Promise<void> {
  if (walletOn) {
    const anvil = findAnvil()
    if (!anvil) fatal('anvil (Foundry v1.7.1) was not found; install it or set QED_WALLET=off', { looked: 'QED_RAIL_ANVIL, PATH, ~/.foundry/bin' })
    wallet.spec.extra = { QED_RAIL_SEAL: '1', QED_RAIL_ANVIL: anvil! }
    // Archived exactly as the stopped service left them, then prepared for sealing (scripts/review-build.sh's order). On a
    // new volume the folders do not exist yet: made private first (sealing writes its keyring's copy into rail/).
    mkdirSync(join(railData, 'rail'), { recursive: true, mode: 0o700 })
    if (!(await archiveWallet())) fatal('not starting: the wallet service data could not be archived first')
    const p = await runOnce('wallet-sealing', [join(APP, 'scripts', 'wallet-sealing.ts'), 'prepare', '--rail-dir', join(railData, 'rail')])
    if (p.code !== 0) fatal('the wallet service secrets cannot be sealed; not starting it with them in plaintext', { exit: p.code })
    wallet.start()
  }
  // The engine first: it opens (and if needed migrates, after a sealed copy) the database before the API does.
  const engineUp = new Promise<boolean>((resolveUp) => {
    const t = setTimeout(() => resolveUp(false), 120_000)
    engine.onLine = (l) => { if (/"event":"running"|\[engine\] running/.test(l)) { clearTimeout(t); engine.onLine = undefined; resolveUp(true) } }
  })
  engine.start()
  if (!(await engineUp)) say('warn', 'the engine has not said it is running after 120 s; starting the API anyway (it reports not ready)')
  api.start()
  running = true
  if (BACKUP_EVERY_MIN > 0 && !backupTimer) backupTimer = setInterval(() => void scheduledBackup(), BACKUP_EVERY_MIN * 60_000)
  if (DRILL_EVERY_HOURS > 0 && !drillTimer) drillTimer = setInterval(() => void scheduledDrill(), DRILL_EVERY_HOURS * 3_600_000)
  if (walletOn) void (async () => {
    const port = Number(env.QED_RAIL_PORT ?? 5176)
    for (let i = 0; i < 360 && running; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).status === 200) { say('info', 'wallet service ready', { afterS: Math.round(i / 2) }); return } } catch { /* not yet */ }
      await sleep(500)
    }
    if (running) say('error', 'the wallet service did not become ready within 180 s; the on-chain wallet is unavailable (its log says why)')
  })()
}

async function stopServices(): Promise<void> {
  running = false
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null }
  if (drillTimer) { clearInterval(drillTimer); drillTimer = null }
  await api.stop()
  await engine.stop()
  await wallet.stop()
}

async function scheduledBackup(): Promise<void> {
  if (!running) return
  const r = await runOnce('backup', [join(APP, 'scripts', 'backup.ts'), 'create'])
  say(r.code === 0 ? 'info' : 'error', r.code === 0 ? 'scheduled backup sealed' : 'scheduled backup failed', { exit: r.code })
  if (r.code !== 0 || !running) return
  // Off-host copy first, then retention (which prunes the store only after the newest backup was pushed). Each is a no-op
  // when its setting is off; a failure is an error line and never stops the services.
  for (const step of ['push', 'prune']) {
    const o = await runOnce('offsite', [join(APP, 'scripts', 'backup-offsite.ts'), step], offsiteSecrets)
    if (o.code !== 0) say('error', `scheduled off-host ${step} failed`, { exit: o.code })
    if (o.code !== 0 && step === 'push') return // never prune after a push that did not finish
  }
}

/** A restore drill of the newest backup (and of the newest off-host copy when that is on), into scratch folders. */
async function scheduledDrill(): Promise<void> {
  if (!running) return
  const d = await runOnce('drill', [join(APP, 'scripts', 'backup.ts'), 'drill'])
  say(d.code === 0 ? 'info' : 'error', d.code === 0 ? 'scheduled restore drill passed' : 'scheduled restore drill FAILED', { exit: d.code })
  if (!running) return
  const o = await runOnce('offsite', [join(APP, 'scripts', 'backup-offsite.ts'), 'drill'], offsiteSecrets)
  if (o.code !== 0) say('error', 'scheduled off-host restore drill FAILED', { exit: o.code })
}

/** While the maintenance file exists: services stopped, the public port answering 503. */
function maintenanceResponder(): Promise<Server> {
  return new Promise((resolveServer) => {
    const s = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '120', ...(cfg.hsts ? { 'Strict-Transport-Security': cfg.hsts } : {}) })
      res.end(JSON.stringify({ maintenance: true, message: 'QED is stopped for maintenance. Nothing is running or being executed; try again later.' }))
    })
    s.listen(cfg.apiPort, cfg.host, () => resolveServer(s))
  })
}
async function watchMaintenance(): Promise<void> {
  for (;;) {
    await sleep(2_000)
    if (stopping) return
    const on = existsSync(maintenanceFile)
    if (on && running) {
      say('warn', 'maintenance file found: stopping the services', { file: maintenanceFile })
      await stopServices()
      if (!stopping) maintenance = await maintenanceResponder()
    } else if (!on && !running && maintenance && !stopping) {
      await new Promise<void>((r) => maintenance!.close(() => r()))
      maintenance = null
      say('info', 'maintenance file removed: starting the services')
      await startServices()
    }
  }
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  say('info', 'stopping', { graceMs: GRACE_MS })
  await stopServices()
  if (maintenance) await new Promise<void>((r) => maintenance!.close(() => r()))
  say('info', 'stopped', { exit: code })
  process.exit(code)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (stopping) { say('warn', `${sig} again: killing the services now`); api.kill(); engine.kill(); wallet.kill(); process.exit(1) }
    say('info', 'signal', { signal: sig })
    void shutdown(0)
  })
}

// --------------------------------------------------------------------------------------------------------- the start
say('info', 'starting', { revision: env.QED_REVISION ?? 'unrecorded', node: process.version, database: dbPath, walletData: railData, wallet: walletOn ? 'on' : 'off', publicOrigin: cfg!.publicOrigin ?? 'none (local build)', port: cfg!.apiPort })
prepareKeys()
if (env.QED_OFFSITE !== undefined || env.QED_BACKUP_RETENTION !== undefined) {
  const c = await runOnce('offsite', [join(APP, 'scripts', 'backup-offsite.ts'), 'check'], offsiteSecrets)
  if (c.code !== 0) fatal('the off-host copy or retention settings were refused; nothing was started', { exit: c.code })
}
await restoreIfAsked()
if (existsSync(maintenanceFile)) { say('warn', 'maintenance file present at start: services not started', { file: maintenanceFile }); maintenance = await maintenanceResponder() }
else await startServices()
void watchMaintenance()
