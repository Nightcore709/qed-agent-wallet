/**
 * The isolated stack the browser suite runs against: its own database in a scratch directory, its own engine and API
 * on their own port, the built interface served by that API. Nothing here touches the review database or the
 * services on 5174 to 5176. Delays for recovery and passkey removal are shortened (labelled test mode in the
 * interface) so those journeys can be completed inside a test. Ask is answered by a scripted test double (labelled).
 *
 * The stack has its own vault service too (apps/qed-demo/chain, multi-tenant): its own data folder, local chain and
 * ports, so every household a test creates gets a vault on a chain no other run shares. The owner account's delay is
 * the shortest the account allows (60 s), which the interface states wherever a delay applies.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { registerAmountSql } from '../../server/amount-sql.ts'

export const APP = join(import.meta.dirname, '..', '..')
export const PORT = Number(process.env.QED_BROWSER_PORT ?? 5291)
export const BASE = `http://localhost:${PORT}`
const STATE = join(tmpdir(), `qed-browser-suite-${PORT}.json`)
/**
 * The stack's vault service: HTTP; the port its chain listened on before R13 (QED_RAIL_ANVIL_PORT, now only to recognise
 * such a chain left running: the chain listens on a port browsers refuse and is reached over its socket, support/vault.ts
 * chainCall); and the guarded front of the chain a scripted economy uses while it runs.
 */
export const RAIL_PORT = PORT + 1
const railPorts = (port: number) => ({ http: port, anvil: port + 3300, economy: port + 3301 })
/** A journey's own extra stack: a port derived from the suite's, so two worktrees' runs (different QED_BROWSER_PORT)
 * and two journeys of one run (different offsets) never meet. Each extra stack with a vault service also uses the next
 * port and that port + 3300 and + 3301 (RISK-078: chart and vault-restart once shared 5296). */
export const extraPort = (offset: number): number => PORT + offset

/**
 * Refuse a port another process holds. A server already answering there (another worktree's stack, a design fixture)
 * would take this suite's journeys while their checks read this stack's database, and every journey would fail for a
 * reason that is not in the code (RISK-078; found on 23 Nov when 6301 belonged to another worktree).
 */
async function mustBeFree(...ports: number[]): Promise<void> {
  for (const port of ports) {
    const free = await new Promise<boolean>((done) => { const s = createServer(); s.once('error', () => done(false)); s.listen(port, '127.0.0.1', () => s.close(() => done(true))) })
    if (!free) throw new Error(`Port ${port} is already in use (another stack, fixture or worktree?). Set QED_BROWSER_PORT to a free port: the suite uses it, the next one, +3300 and +3301 for its chains, and +10 to +45 for the journeys' own stacks.`)
  }
}

export interface StackState { dir: string; db: string; pids: number[] }

/**
 * Starts a Node process of the stack with its output appended to `log`, a file in the stack's scratch folder, so a failed
 * journey can be read against what the vault service, engine and API said at the time (it was discarded before).
 */
function spawnLogged(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const fd = openSync(log, 'a', 0o600)
  try { return spawn(process.execPath, args, { cwd, env, stdio: ['ignore', fd, fd], detached: false }) } finally { closeSync(fd) }
}

/**
 * Start a vault service on its own data folder and ports, and wait until it answers ready (a fresh chain deploys its
 * contracts first). Returns the process and the settings that point QED's engine and API at it. `extra` is the vault
 * service's own settings for one journey (the bounties journey opens the positive controls with short periods).
 */
export async function startRail(dir: string, port: number, extra: Record<string, string> = {}): Promise<{ proc: ChildProcess; env: Record<string, string> }> {
  const p = railPorts(port)
  const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`, QED_RAIL_DATA: dir, QED_RAIL_PORT: String(p.http), QED_RAIL_ANVIL_PORT: String(p.anvil), QED_RAIL_ECONOMY_ANVIL_PORT: String(p.economy), QED_RAIL_ACCOUNT_DELAY_S: '60', ...extra }
  const proc = spawnLogged([join(APP, 'chain', 'serve.ts')], join(APP, 'chain'), env, `${dir}.log`)
  for (let i = 0; i < 240; i++) {
    try { const h = await fetch(`http://127.0.0.1:${p.http}/health`); if (h.status === 200 && ((await h.json()) as { ready?: boolean }).ready) break } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`The vault service stopped at start (exit ${proc.exitCode}).`)
    await new Promise((r) => setTimeout(r, 250))
  }
  return { proc, env: { QED_RAIL_URL: `http://127.0.0.1:${p.http}`, QED_RAIL_TOKEN_FILE: join(dir, 'rail.token') } }
}

export function readState(): StackState { return JSON.parse(readFileSync(STATE, 'utf8')) as StackState }

/**
 * Read-only queries against the stack's database: what the tests compare the screen with. Amounts are read from their text
 * and summed with amount_sum, as the server does (stage S3): the INTEGER copy is NULL past 64 bits.
 */
export function query<T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[] {
  const d = new DatabaseSync(readState().db, { readOnly: true })
  registerAmountSql(d)
  try { return d.prepare(sql).all(...params) as T[] } finally { d.close() }
}

export async function startStack(): Promise<StackState> {
  if (!existsSync(join(APP, 'dist', 'index.html'))) throw new Error('Build the interface first (npm run build): the suite opens the built interface served by its own API.')
  const rp = railPorts(RAIL_PORT)
  await mustBeFree(PORT, rp.http, rp.anvil, rp.economy)
  const dir = mkdtempSync(join(tmpdir(), 'qed-browser-'))
  const db = join(dir, 'qed.db')
  const rail = await startRail(join(dir, 'vault'), RAIL_PORT)
  // the delays in their labelled test mode, a new passkey's 24-hour cool-off (server/passkeys.ts) among them: 6 seconds here
  const env = { ...process.env, QED_DB: db, QED_API_PORT: String(PORT), QED_WEB_PORT: String(PORT), QED_RECOVERY_DELAY_SEC: '6', QED_PROTECTION_DELAY_SEC: '6', QED_COOL_OFF_SEC: '6',
    // Ask is answered by a scripted test double on this stack only; the interface labels it as not a model.
    QED_AI_PROVIDER: 'scripted', QED_AI_SCRIPT: join(APP, 'browser', 'support', 'ask-script.json'), QED_TEST_STACK: '1',
    // three journeys at once from one address: the product's 1,500 requests a minute per address is one person's guard
    QED_REQUESTS_PER_MINUTE: '6000', ...rail.env }
  const procs: ChildProcess[] = [rail.proc]
  for (const cmd of ['engine', 'api']) {
    const c = spawnLogged([join(APP, 'server', 'main.ts'), cmd], APP, env, join(dir, `${cmd}.log`))
    procs.push(c)
    if (cmd === 'engine') await new Promise((r) => setTimeout(r, 800)) // the engine creates the database first
  }
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).status === 200) break } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  const state = { dir, db, pids: procs.map((p) => p.pid!).filter(Boolean) }
  writeFileSync(STATE, JSON.stringify(state))
  return state
}

export function stopStack(): void {
  try { for (const pid of readState().pids) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } } } catch { /* never started */ }
}

/**
 * A second, separate stack for one test file: its own database, port and settings (for example presentation mode),
 * and with `rail: true` its own vault service (`railEnv`: settings for that service alone). The caller stops it. Its
 * database is read with `query` exactly as the main stack's is. `restart()` stops every process and starts them again
 * on the same data: what a power cut and a fresh start look like to the owner. `railDown()` (also `stopRail()`) stops
 * only the vault service (its chain with it) while QED's engine and API keep running, which is what the owner sees when
 * the on-chain wallet's service does not answer; `railUp()` starts it again on the same data, with the same settings.
 */
export async function startExtraStack(port: number, extraEnv: Record<string, string>, opts: { rail?: boolean; railEnv?: Record<string, string> } = {}): Promise<{ base: string; db: string; dir: string; railPort: number; query<T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[]; stop(): Promise<void>; restart(): Promise<void>; railDown(): Promise<void>; stopRail(): Promise<void>; railUp(): Promise<void> }> {
  const rp = railPorts(port + 1)
  await mustBeFree(port, ...(opts.rail ? [rp.http, rp.anvil, rp.economy] : []))
  const dir = mkdtempSync(join(tmpdir(), 'qed-browser-extra-'))
  const db = join(dir, 'qed.db')
  const base = `http://localhost:${port}`
  let procs: ChildProcess[] = []
  let railProc: ChildProcess | null = null
  const ended = (p: ChildProcess): Promise<void> => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once('exit', () => r()); try { p.kill('SIGTERM') } catch { r() } })
  const up = async (): Promise<void> => {
    const rail = opts.rail ? await startRail(join(dir, 'vault'), port + 1, opts.railEnv) : null
    railProc = rail?.proc ?? null
    const env = { ...process.env, QED_DB: db, QED_API_PORT: String(port), QED_WEB_PORT: String(port), QED_RECOVERY_DELAY_SEC: '6', QED_PROTECTION_DELAY_SEC: '6', QED_COOL_OFF_SEC: '6', QED_AI_PROVIDER: 'none', QED_TEST_STACK: '1', QED_REQUESTS_PER_MINUTE: '6000', ...(rail?.env ?? {}), ...extraEnv }
    procs = rail ? [rail.proc] : []
    for (const cmd of ['engine', 'api']) {
      procs.push(spawnLogged([join(APP, 'server', 'main.ts'), cmd], APP, env, join(dir, `${cmd}.log`)))
      if (cmd === 'engine') await new Promise((r) => setTimeout(r, 800))
    }
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${base}/api/health`)).status === 200) break } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const down = async (): Promise<void> => {
    await Promise.all(procs.map(ended))
    procs = []
    railProc = null
  }
  await up()
  return {
    base, db, dir, railPort: port + 1,
    query: <T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[] => { const d = new DatabaseSync(db, { readOnly: true }); registerAmountSql(d); try { return d.prepare(sql).all(...params) as T[] } finally { d.close() } },
    stop: down,
    restart: async () => { await down(); await up() },
    railDown: async () => {
      const p = railProc
      if (!p) return
      await ended(p)
      procs = procs.filter((x) => x !== p)
      railProc = null
    },
    railUp: async () => {
      if (!opts.rail || railProc) return
      const rail = await startRail(join(dir, 'vault'), port + 1, opts.railEnv)
      railProc = rail.proc
      procs = [rail.proc, ...procs]
    },
    // the bounty journeys' name for the same thing
    stopRail: async () => { const p = railProc; if (!p) return; await ended(p); procs = procs.filter((x) => x !== p); railProc = null },
  }
}

/**
 * Write to the stack's database. Only for a test that must force a state the product cannot be driven into from the
 * interface (a discrepancy found by reconciliation); every such write is named in the test.
 */
export function force(sql: string, ...params: (string | number)[]): number {
  const d = new DatabaseSync(readState().db)
  try { d.exec('PRAGMA busy_timeout = 5000'); return Number(d.prepare(sql).run(...params).changes) } finally { d.close() }
}

/**
 * The API allows 20 new accounts an hour from one address (server/passkeys.ts, checked in server/passkeys.test.ts).
 * The whole suite creates more than that from 127.0.0.1 on one stack, so before each test creates an account the
 * counter is cleared in the stack's own scratch database. Nothing else is touched; the limit stays in the product.
 */
export function allowSignups(): void {
  try { force("DELETE FROM rate_limits WHERE key LIKE 'signup:%'") } catch { /* no main stack (an extra stack's test) */ }
}

