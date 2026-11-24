/**
 * Liveness and readiness of the API process (docs/DEPLOY.md, "Health and readiness"). Distinct from the product's
 * readiness page (server/readiness.ts, GET /api/readiness), which says why this build is not ready for real money.
 *
 *   GET /api/live    the process answers. Nothing else is checked: a platform restarts a process that does not.
 *   GET /api/ready   it can serve: the database answers, it is at this build's schema (no other build migrated it under
 *                    this process), the engine's heartbeat is fresh (server/engine.ts), and the API is not draining for a
 *                    shutdown. The wallet service is reported beside them; it gates readiness only when
 *                    QED_READY_REQUIRES_WALLET=1, because everything but the on-chain wallet works without it.
 *   GET /api/health  kept as before for the scripts and the interface (the engine's status), reduced under a public
 *                    origin to what a stranger may see (PRODUCTION.md section 10, ASVS 13.4.5).
 *
 * Under a public origin the answers carry check names and booleans only; locally they say why.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Db, SCHEMA_VERSION } from './core.ts'
import { engineStatus } from './engine.ts'

export type WalletState = 'up' | 'down' | 'not configured'
export interface Check { name: 'database' | 'schema' | 'engine' | 'accepting' | 'wallet'; ok: boolean; gating: boolean; detail: string }
export interface ReadyReport { ready: boolean; checks: Check[] }

/** The readiness of one API process. Never throws: a check that cannot run is a failed check. */
export function readinessReport(o: { db: Db; now: number; draining: boolean; wallet: WalletState; requireWallet: boolean }): ReadyReport {
  const checks: Check[] = []
  let dbOk = false
  try { dbOk = o.db.get<{ one: number }>('SELECT 1 AS one')?.one === 1; checks.push({ name: 'database', ok: dbOk, gating: true, detail: dbOk ? 'answers' : 'no answer' }) } catch (e) {
    checks.push({ name: 'database', ok: false, gating: true, detail: `does not answer (${e instanceof Error ? e.name : 'error'})` })
  }
  if (dbOk) {
    let have: string | undefined
    try { have = o.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value } catch { have = undefined }
    checks.push({ name: 'schema', ok: have === SCHEMA_VERSION, gating: true, detail: have === SCHEMA_VERSION ? `version ${have}, this build's` : `the database is at version ${have ?? 'none'}; this build is at ${SCHEMA_VERSION}` })
    let engine: Check
    try {
      const e = engineStatus(o.db, o.now)
      const age = e.ageMs === null ? null : Math.round(e.ageMs / 1000)
      engine = { name: 'engine', ok: e.running, gating: true, detail: e.running ? `heartbeat ${age} s old` : e.lastBeat === null ? 'no engine has run on this database' : `not running (last heartbeat ${age} s ago)` }
    } catch (e) { engine = { name: 'engine', ok: false, gating: true, detail: `heartbeat unreadable (${e instanceof Error ? e.name : 'error'})` } }
    checks.push(engine)
  } else {
    checks.push({ name: 'schema', ok: false, gating: true, detail: 'not checked: the database does not answer' })
    checks.push({ name: 'engine', ok: false, gating: true, detail: 'not checked: the database does not answer' })
  }
  checks.push({ name: 'accepting', ok: !o.draining, gating: true, detail: o.draining ? 'draining for a shutdown: no new work is accepted' : 'accepting requests' })
  checks.push({ name: 'wallet', ok: o.wallet === 'up', gating: o.requireWallet, detail: o.wallet === 'up' ? 'the wallet service answers ready' : o.wallet === 'down' ? 'the wallet service does not answer ready; the on-chain wallet is unavailable' : 'no wallet service is configured' })
  return { ready: checks.every((c) => c.ok || !c.gating), checks }
}

/** What a stranger may see: the verdict and each check's name and result, no detail. */
export function publicReport(r: ReadyReport): { ready: boolean; checks: Record<string, boolean> } {
  return { ready: r.ready, checks: Object.fromEntries(r.checks.map((c) => [c.name, c.ok])) }
}

/**
 * The wallet service's own readiness (its GET /health, which needs no token), asked at most every `everyMs` and with a
 * short timeout so that a probe never waits on it. "not configured": no bearer token file, so this API never uses it.
 */
export function walletProbe(o: { dbPath: string; env?: NodeJS.ProcessEnv; everyMs?: number; timeoutMs?: number }): () => Promise<WalletState> {
  const env = o.env ?? process.env
  const tokenFile = env.QED_RAIL_TOKEN_FILE ?? join(dirname(o.dbPath), 'rail.token')
  // the same rule as server/rail.ts: the wallet service is asked only on this machine's loopback address
  let url: string | null = null
  try { const u = new URL(env.QED_RAIL_URL ?? 'http://127.0.0.1:5176'); if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) url = `${u.origin}/health` } catch { url = null }
  let last: { at: number; state: WalletState } | null = null
  return async () => {
    const now = Date.now()
    if (last && now - last.at < (o.everyMs ?? 5_000)) return last.state
    let state: WalletState
    if (!existsSync(tokenFile)) state = 'not configured'
    else if (url === null) state = 'down'
    else {
      try { state = (await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 1_000), redirect: 'error' })).status === 200 ? 'up' : 'down' } catch { state = 'down' }
    }
    last = { at: now, state }
    return state
  }
}
