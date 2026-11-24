/**
 * Two defences of the API's one thread and its records, in front of every handler (server/api.ts), R13 hardening.
 *
 * Cost-aware throttle (lead L-14 of docs/SECURITY-REVIEW-R13.md; ASVS 5.0 V2.4.1, V15.2.2, V15.4.4). The request limit
 * (1,500 a minute per address) counts requests, not their cost: a route that holds the thread for 40 ms could be asked
 * for 1,500 times a minute and hold it for the whole minute. So each address and each signed-in person also has a budget of
 * the thread's time, COST_MS_PER_MINUTE of every minute (by default a third of it: 20,000 ms), measured as the time each
 * request held the thread (its handler's synchronous part and the writing of its answer). Past the budget, requests are
 * refused 429 `too_costly` with Retry-After until the minute turns. Waiting on another service (the wallet service, a
 * model) does not hold the thread and is not counted.
 *
 * Refusal log and alert (ASVS 5.0 V16.3.2, V16.3.3; NIST SP 800-92). Every refusal that is a security control working
 * (401, 403, 413, 415, 421, 429, and 400 for input that failed validation) is written to the operational log
 * (server/log.ts, redacted; standard output: a control working is not a fault) as one `refused` line with the status, the code, the route (never the query string or the body),
 * the address and the person if signed in; at most LOG_PER_KEY_MINUTE lines a minute for one address and code, and then
 * one line saying how many more were not written, so a flood of refusals cannot flood the log. When refusals pass
 * ALERT_THRESHOLD in ALERT_WINDOW_MS installation-wide, an incident is opened (server/incidents.ts, key
 * `security-refusals`), which Protect's status area shows; it is resolved once a window passes below the threshold.
 */
import { type Db } from './core.ts'
import { incidentOpen, openIncident, resolveIncident } from './incidents.ts'
import { log } from './log.ts'

// ---------------------------------------------------------------------------------------------- the cost-aware throttle

export const DEFAULT_COST_MS_PER_MINUTE = 20_000
interface Window { t: number; ms: number }
export class CostMeter {
  private readonly windows = new Map<string, Window>()
  readonly budgetMs: number
  private readonly windowMs: number
  constructor(budgetMs: number, windowMs = 60_000) { this.budgetMs = budgetMs; this.windowMs = windowMs }
  private at(key: string, now: number): Window {
    let w = this.windows.get(key)
    if (!w || now - w.t >= this.windowMs) { w = { t: now, ms: 0 }; this.windows.set(key, w) }
    if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (now - v.t >= this.windowMs) this.windows.delete(k)
    return w
  }
  /** Milliseconds until the key may be served again; 0 when it is within its budget. */
  retryAfterMs(key: string, now: number): number {
    const w = this.at(key, now)
    return w.ms >= this.budgetMs ? Math.max(1, this.windowMs - (now - w.t)) : 0
  }
  charge(key: string, now: number, ms: number): void { if (ms > 0) this.at(key, now).ms += ms }
  used(key: string, now: number): number { return this.at(key, now).ms }
}

/** The budget from the environment: lower anywhere; higher than the default only on an isolated test stack. */
export function costBudget(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env.QED_COST_MS_PER_MINUTE)
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_COST_MS_PER_MINUTE
  const v = Math.max(1000, Math.round(asked))
  return env.QED_TEST_STACK === '1' ? v : Math.min(DEFAULT_COST_MS_PER_MINUTE, v)
}

// ---------------------------------------------------------------------------------------------- refusals: log and alert

export const LOG_PER_KEY_MINUTE = 20
export const ALERT_WINDOW_MS = 5 * 60_000
export const ALERT_THRESHOLD = 500
/** The statuses that are a security control refusing something. 404 is not among them: it is also every mistyped address. */
export const SECURITY_STATUSES = new Set([400, 401, 403, 413, 415, 421, 429])

export class RefusalMonitor {
  private readonly lines = new Map<string, { t: number; n: number; dropped: number }>()
  private window = { t: 0, n: 0 }
  private last = { t: 0, n: 0 }
  private readonly db: Db
  private readonly threshold: number
  private readonly windowMs: number
  constructor(db: Db, threshold = ALERT_THRESHOLD, windowMs = ALERT_WINDOW_MS) { this.db = db; this.threshold = threshold; this.windowMs = windowMs }

  /** One refusal. `code` is the error code sent; `path` the route without its query. */
  record(now: number, r: { status: number; code: string; method: string; path: string; ip: string; person?: string | null }): void {
    if (!SECURITY_STATUSES.has(r.status)) return
    const key = `${r.ip}|${r.code}`
    let l = this.lines.get(key)
    if (!l || now - l.t >= 60_000) {
      if (l?.dropped) log('api', 'info', 'refused (more, not written)', { status: r.status, code: r.code, ip: r.ip, notWritten: l.dropped })
      l = { t: now, n: 0, dropped: 0 }
      this.lines.set(key, l)
      if (this.lines.size > 10_000) for (const [k, v] of this.lines) if (now - v.t >= 60_000) this.lines.delete(k)
    }
    // a refusal is a control working as it should: an `info` line (standard output); a fault is a warning or an error
    if (l.n++ < LOG_PER_KEY_MINUTE) log('api', 'info', 'refused', { status: r.status, code: r.code, method: r.method, path: r.path, ip: r.ip, person: r.person ?? undefined })
    else l.dropped++
    this.tick(now)
    this.window.n++
    if (this.window.n === this.threshold) {
      try {
        openIncident(this.db, now, { key: 'security-refusals', source: 'api', title: 'Many requests were refused: someone may be probing QED', detail: `${this.threshold} requests were refused by QED's security checks (sign-in, cross-site, rate limits, permissions) in ${Math.round(this.windowMs / 60_000)} minutes, across every address. The operational log lists them (event "refused").` })
      } catch { /* an alert must not become a second fault */ }
    }
  }

  /** Turns the window when it has run out (called on every request, so a quiet spell also turns it). */
  tick(now: number): void {
    if (now - this.window.t < this.windowMs) return
    // a gap of more than a window means the window before this one was quiet
    this.last = now - this.window.t >= 2 * this.windowMs ? { t: now - this.windowMs, n: 0 } : this.window
    this.window = { t: now, n: 0 }
    this.settle(now)
  }
  /** Refusals in the current window (for tests and the record). */
  get inWindow(): number { return this.window.n }

  /** At the turn of a window: an open alert whose last window stayed below the threshold is resolved. */
  private settle(now: number): void {
    try {
      if (this.last.n < this.threshold && incidentOpen(this.db, 'security-refusals')) resolveIncident(this.db, now, 'security-refusals', `Fewer than ${this.threshold} refusals in the last ${Math.round(this.windowMs / 60_000)} minutes.`)
    } catch { /* as above */ }
  }
}
