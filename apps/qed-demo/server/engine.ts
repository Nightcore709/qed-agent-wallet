/**
 * The engine: the continuously running service. It ingests market data, claims due runs, enforces authority, executes
 * on the paper venues, books the ledger, reconciles and issues receipts. It has no connection to any browser: a
 * program signed yesterday runs today whether or not anyone is looking.
 *
 * Honesty about downtime is built in. The engine writes a heartbeat every few seconds. When it starts and finds the
 * last heartbeat old, it records the gap, tells every owner, and marks the scheduled runs inside the gap as missed.
 * Nothing is executed for the time it was not running.
 *
 * One engine per database (ADR-0013, docs/research/qed-systems-architect/adr/). Three guards, strongest first:
 *   1. An exclusive lock on `<database>.engine-lock`, an empty file, held through SQLite (so by the operating system)
 *      for as long as the engine runs. The operating system releases it when the process exits in any way, a kill
 *      included; a process that is merely stalled or suspended keeps it, so nothing takes over from it. Two engines
 *      started together, two engines with the same pid (every container's first process is pid 1) and an engine
 *      whose heartbeat only looks old (a stalled process, a clock step) are all refused.
 *   2. The heartbeat check at start: a fresh heartbeat of another live process on this QED installation refuses the start.
 *   3. Ownership on every tick and beat: the heartbeat row names this engine's instance. If another engine has
 *      written it (a lock that could not exclude: a network file system, a lock file deleted while held), this engine
 *      stops acting at once and reports it, rather than acting beside the other.
 * Guards 1 and 2 hold only on one computer, as SQLite itself does: the database must not be shared over a network.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { bankTick } from './bank.ts'
import { reconcileAllPurchases } from './commerce.ts'
import { abroadTick } from './abroad.ts'
import { type Clock, type Config, type Db, emit, ist, j, openDb, parse, systemClock } from './core.ts'
import { applyDueChanges } from './passkeys.ts'
import { applyDueDeletions } from './records.ts'
import { recoveryTick } from './recovery.ts'
import { configureDelivery, dispatchQueued } from './delivery.ts'
import { postmarkAdapter } from './postmark.ts'
import { log } from './log.ts'
import { notice, stepAllActions } from './execute.ts'
import { disputeTick } from './owner.ts'
import { retryRevocations } from './revocation.ts'
import { escrowTick } from './escrow.ts'
import { buildProviders, checkClock, Market, type Provider, refreshCoindcxRules } from './market.ts'
import { assertPresentationDb, SyntheticProvider, syntheticBook } from './synthetic.ts'
import { flushHeld, incidentOpen, openIncident, probeStorage, resolveIncident, storageErrorKind } from './incidents.ts'
import { railPolicySchedule } from './rail.ts'
import { chainBooksSchedule } from './chain-books.ts'
import { vaultWatch } from './vault-watch.ts'
import { reconcileUser } from './recon.ts'
import { instruments, seedRegistry } from './registry.ts'
import { notifyTick } from './notify.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import type { Ctx } from './types.ts'
import { buildVenues } from './venues.ts'
import { SecuritiesProvider } from './securities.ts'
import { securitiesTick } from './securities-books.ts'

export const HEARTBEAT_MS = 3000
/** A heartbeat older than this at start-up means the engine was down. */
export const DOWN_AFTER_MS = 20_000

/** The file whose exclusive lock the running engine of `dbPath` holds. It stays empty: it holds no data. */
export const engineLockPath = (dbPath: string): string => `${dbPath}.engine-lock`

/** Another engine holds this database's lock: this one must not start. */
export class EngineLocked extends Error {
  readonly lockPath: string
  constructor(lockPath: string, holder: { pid: number; beatAgoMs: number; host: string | null } | null) {
    super(`Another engine holds this database's engine lock (${lockPath})${holder ? `; its heartbeat names pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}, ${Math.round(holder.beatAgoMs / 1000)} s ago` : ''}. Two engines would both claim runs: start only one. The lock is released by the operating system when its holder exits, so if no engine is running it is free.`)
    this.name = 'EngineLocked'
    this.lockPath = lockPath
  }
}

/**
 * Take the engine lock of `dbPath`, or throw EngineLocked. The lock is an exclusive transaction that is never committed,
 * on an empty file: SQLite takes the operating system's lock at BEGIN EXCLUSIVE and writes nothing, so the file stays
 * empty (no journal, no database page) and is never mistaken for a copy of the database. Closing the returned connection,
 * or the process ending, releases it.
 */
function holdEngineLock(dbPath: string, db: Db, now: number): DatabaseSync | null {
  if (dbPath === ':memory:') return null
  const path = engineLockPath(dbPath)
  const lock = new DatabaseSync(path)
  try {
    lock.exec('PRAGMA busy_timeout = 0')
    lock.exec('BEGIN EXCLUSIVE')
  } catch (e) {
    try { lock.close() } catch { /* nothing held */ }
    const code = (e as { errcode?: number }).errcode
    if (code === 5 || code === 6 || /locked|busy/i.test(e instanceof Error ? e.message : '')) {
      const hb = db.get<{ pid: number; beat_at: number; detail_json: string }>(`SELECT pid, beat_at, detail_json FROM heartbeats WHERE service = 'engine'`)
      throw new EngineLocked(path, hb ? { pid: hb.pid, beatAgoMs: now - hb.beat_at, host: (parse<{ host?: string }>(hb.detail_json, {}).host) ?? null } : null)
    }
    throw e
  }
  try { chmodSync(path, 0o600) } catch { /* not ours to change */ }
  return lock
}

export interface EngineOptions {
  clock?: Clock
  live?: boolean
  /** Called once if this engine finds that another engine has taken its heartbeat; it has already stopped acting. */
  onFenced?: (why: string) => void
}

export class Engine {
  readonly ctx: Ctx
  readonly db: Db
  private readonly clock: Clock
  private providers: Provider[] = []
  private timer: NodeJS.Timeout | null = null
  private mailTimer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = false
  /** A graceful stop was asked for: no new tick starts, and a tick under way stops at its next step boundary. */
  private stopping = false
  /** The database is closed: stop() has run (a second call does nothing). */
  private closed = false
  private last = { heartbeat: 0, funds: 0, bank: 0, recon: 0, clock: 0, prune: 0, rules: 0, vault: 0, notify: 0, chainBooks: 0, commerce: 0 }
  /** The vault policy slots this engine has asked for (railPolicySchedule prunes past slots), and whether a pass is running. */
  private readonly vaultAsked = new Set<string>()
  private vaultBusy = false
  /** The slot whose missed tick was last recorded (one record per slot). */
  private vaultMissSlot = -1
  private readonly cfg: Pick<Config, 'dbPath'> & { presentation?: boolean }
  private ticks = 0
  private lastTickMs = 0
  /** Wall-clock time of the previous tick. A long gap means this process was suspended (the machine slept) or stalled. */
  private lastTickAt = 0
  private readonly live: boolean
  readonly startedAt: number
  /** This engine's own identity in the heartbeat row: random, so two engines with the same pid are told apart. */
  readonly instance = randomBytes(12).toString('base64url')
  /** 'none' until start(); 'held' while this engine is the one engine; 'lost' once another engine took the heartbeat. */
  private lease: 'none' | 'held' | 'lost' = 'none'
  private lock: DatabaseSync | null = null
  private readonly onFenced: ((why: string) => void) | undefined
  /** Set while the database cannot be written (a full disk, an I/O error): the engine acts on nothing until a write succeeds again. */
  private storageFault: { since: number; kind: 'full' | 'io'; lastProbe: number; skipped: number } | null = null
  private vaultMisses = 0
  private tickFailing = false

  constructor(cfg: Pick<Config, 'dbPath'> & { presentation?: boolean }, opts: EngineOptions = {}) {
    this.cfg = cfg
    // Messages the engine sends (a recovery's "ready" link) go through the configured adapter, with links to its origin.
    if ('delivery' in cfg && 'linkOrigin' in cfg) configureDelivery(cfg as Pick<Config, 'delivery' | 'linkOrigin'>)
    this.clock = opts.clock ?? systemClock
    this.live = opts.live ?? true
    this.onFenced = opts.onFenced
    this.db = openDb(cfg.dbPath)
    // Presentation mode: a database of its own, no limits calibrated on provider history, synthetic prices only.
    if (cfg.presentation) assertPresentationDb(this.db)
    seedRegistry(this.db, { presentation: !!cfg.presentation })
    const market = new Market(this.db, this.clock)
    this.ctx = { db: this.db, clock: this.clock, market, venues: buildVenues(this.db, market, this.clock, cfg.presentation ? syntheticBook : undefined) }
    this.startedAt = this.clock.now()
  }

  /** Refuse to start beside another live engine on the same database; record any downtime since the last one stopped. */
  start(): void {
    const now = this.clock.now()
    // Guard 1: the operating system's lock. Throws EngineLocked while another engine (any pid, any clock) holds it.
    this.lock = holdEngineLock(this.cfg.dbPath, this.db, now)
    try {
      // Guard 2: a fresh heartbeat of another live process here. One that stopped cleanly said so and does not count.
      const hb = this.db.get<{ pid: number; beat_at: number; started_at: number; detail_json: string }>(`SELECT pid, beat_at, started_at, detail_json FROM heartbeats WHERE service = 'engine'`)
      const said = parse<{ stopped?: boolean }>(hb?.detail_json, {})
      if (hb && !said.stopped && now - hb.beat_at < DOWN_AFTER_MS / 2 && hb.pid !== process.pid && pidAlive(hb.pid)) {
        throw new Error(`Another engine (pid ${hb.pid}) is already running on this database. Two engines would both claim runs; start only one.`)
      }
      if (hb && now - hb.beat_at > DOWN_AFTER_MS) this.recordDowntime(hb.beat_at, now, 'stopped')
    } catch (e) {
      this.releaseLock()
      throw e
    }
    this.lease = 'held'
    this.lastTickAt = now
    this.beat(true)
    emit(this.db, now, null, 'engine', { state: 'started', pid: process.pid })
    if (this.live) {
      // the paper securities desks' prices are synthetic in both modes (securities.ts): no live data exists for them
      this.providers = [...(this.cfg.presentation ? [new SyntheticProvider(this.ctx.market)] : buildProviders(this.ctx.market)), new SecuritiesProvider(this.ctx.market)]
      for (const p of this.providers) p.start()
    }
    this.timer = setInterval(() => void this.tick(), 1000)
    // Email through Postmark (QED_DELIVERY=postmark): its own loop, apart from the tick, because a send may wait 10 seconds
    // for an answer and the tick must not. Several engines or APIs cannot send one message twice: dispatchQueued claims it.
    const pm = (this.cfg as Partial<Pick<Config, 'delivery' | 'postmark'>>)
    if (pm.delivery === 'postmark' && pm.postmark) {
      const adapter = postmarkAdapter(pm.postmark)
      let mailing = false
      this.mailTimer = setInterval(() => {
        if (mailing || this.stopped || this.stopping) return
        mailing = true
        dispatchQueued(this.db, adapter, this.clock.now()).then((r) => {
          // counts only: never an address, a body or a link
          if (r.sent || r.failed || r.retrying) log('engine', r.failed ? 'warn' : 'info', 'email dispatch', { sent: r.sent, failed: r.failed, retrying: r.retrying })
        }).catch((e: unknown) => log('engine', 'error', 'email dispatch stopped by an error', { error: e instanceof Error ? e.name : 'error' })).finally(() => { mailing = false })
      }, 1000)
    }
    void this.tick()
  }

  /**
   * Record a period in which the engine did not run, and tell every owner. `how` says what is known about the cause:
   * the process had been stopped and was started again, or it stayed alive but did not tick (the machine slept, or
   * the process was stalled). Either way nothing was watched and nothing was executed in that period.
   */
  private recordDowntime(from: number, to: number, how: 'stopped' | 'suspended' | 'storage'): void {
    const due = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM programs WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at BETWEEN ? AND ?`, from, to)?.n ?? 0
    this.db.run('INSERT INTO downtime (service, from_ts, to_ts, missed_runs, note) VALUES (?, ?, ?, ?, ?)', 'engine', from, to, due,
      how === 'stopped' ? 'The engine process was not running. Detected at start-up from the last heartbeat.' : how === 'storage' ? 'The engine could not write to its database (the disk was full or reported an error), so it acted on nothing until a write succeeded again.' : 'The engine process was alive but did not run: the machine was asleep or the process was stalled. Detected from the gap between two ticks.')
    // the incident of this gap: opened when it began, closed now, with what it cost (an open one, seen by the API, is closed here)
    const why = how === 'stopped' ? 'The engine was not running' : how === 'storage' ? 'The engine could not save to its database' : 'The engine did not run: the machine was asleep or the process stalled'
    if (how !== 'storage') {
      openIncident(this.db, from, { key: 'engine-down', source: 'engine', title: 'QED’s engine was not running', detail: `${why}. Found from the last heartbeat.`, affected: { missedRuns: due } })
      resolveIncident(this.db, to, 'engine-down', `The engine is running again. ${due} scheduled run${due === 1 ? '' : 's'} inside the gap ${due === 1 ? 'was' : 'were'} marked missed and will not be run late.`, { missedRuns: due })
    }
    emit(this.db, to, null, 'engine', { state: 'gap', from, to, how })
    const span = (ms: number): string => { const m = Math.max(1, Math.round(ms / 60_000)); return m >= 2880 ? `${Math.round(m / 1440)} days` : m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minute${m === 1 ? '' : 's'}` }
    const when = (ms: number): string => { const t = ist(ms); return `${t.date} ${t.hm}` }
    for (const u of this.db.all<{ id: string }>('SELECT id FROM users')) {
      // One open notice per owner, rewritten as gaps accumulate, so a night of sleeping does not become a wall of warnings.
      const open = this.db.get<{ id: string; ts: number }>(`SELECT id, ts FROM notices WHERE user_id = ? AND kind = 'engine-was-down' AND resolved_at IS NULL ORDER BY ts DESC LIMIT 1`, u.id)
      const since = open ? Math.min(open.ts, from) : from
      const gaps = this.db.all<{ from_ts: number; to_ts: number }>('SELECT from_ts, to_ts FROM downtime WHERE service = ? AND to_ts >= ? ORDER BY from_ts', 'engine', since)
      const total = gaps.reduce((t, g) => t + (g.to_ts - g.from_ts), 0)
      const title = gaps.length > 1 ? `QED was not running for ${span(total)} in ${gaps.length} periods` : `QED was not running for ${span(to - from)}`
      const list = gaps.slice(-4).map((g) => `${when(g.from_ts)} to ${when(g.to_ts)} IST`).join('; ')
      const body = `${gaps.length > 4 ? 'Most recently: ' : ''}${list}. ${how === 'suspended' ? 'This computer was asleep or the engine was stalled.' : how === 'storage' ? 'It could not save to its disk.' : 'The engine had been stopped.'} In those periods nothing was watched and nothing was executed. Scheduled runs that fell inside them are listed as missed and will not be run late. Price-triggered instructions were not evaluated. Fund orders already placed are still allotted by their NAV date.`
      if (open) this.db.run('UPDATE notices SET title = ?, body = ?, read_at = NULL WHERE id = ?', title, body, open.id)
      else notice(this.db, u.id, { level: 'warning', kind: 'engine-was-down', title, body, dedupe: `down:${from}` }, since)
    }
  }

  /**
   * Write the heartbeat. A started engine writes it only while the row still names it (guard 3): if another engine has
   * taken the row, nothing is written and this engine stops acting. `last` marks the final beat of a clean stop, so a
   * successor may start at once and the health check reports the engine down at once.
   */
  private beat(first = false, last = false): boolean {
    const now = this.clock.now()
    const detail = j({ ticks: this.ticks, lastTickMs: Math.round(this.lastTickMs), live: this.live, instance: this.instance, host: hostname(), ...(last ? { stopped: true } : {}) })
    this.last.heartbeat = now
    if (first) this.db.run(`INSERT INTO heartbeats (service, pid, started_at, beat_at, detail_json) VALUES ('engine', ?, ?, ?, ?) ON CONFLICT(service) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, beat_at = excluded.beat_at, detail_json = excluded.detail_json`, process.pid, now, now, detail)
    else if (this.lease === 'held') {
      const r = this.db.run(`UPDATE heartbeats SET beat_at = ?, detail_json = ? WHERE service = 'engine' AND pid = ? AND json_extract(detail_json, '$.instance') = ?`, now, detail, process.pid, this.instance)
      if (r.changes === 0) { this.fence('The heartbeat row names another engine.'); return false }
    } else return false // never started, refused, or fenced: the row is not this engine's to write
    return true
  }

  /** Guard 3: whether the heartbeat row still names this engine. Always true for an engine that was never started. */
  private stillOwner(): boolean {
    if (this.lease !== 'held') return this.lease === 'none'
    const hb = this.db.get<{ pid: number; detail_json: string }>(`SELECT pid, detail_json FROM heartbeats WHERE service = 'engine'`)
    return !!hb && hb.pid === process.pid && parse<{ instance?: string }>(hb.detail_json, {}).instance === this.instance
  }

  /**
   * Stop acting because another engine has taken over this database: no further tick, no heartbeat written (the row is
   * the other engine's now), the lock let go. The caller is told so that the process can exit and be restarted by its
   * supervisor, which will then find the other engine and refuse to start beside it.
   */
  private fence(why: string): void {
    if (this.lease === 'lost') return
    this.lease = 'lost'
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.mailTimer) clearInterval(this.mailTimer)
    for (const p of this.providers) p.stop()
    try { emit(this.db, this.clock.now(), null, 'engine', { state: 'fenced', pid: process.pid, instance: this.instance, why }) } catch { /* recorded in the caller's log instead */ }
    this.releaseLock()
    this.onFenced?.(why)
  }

  private releaseLock(): void {
    if (!this.lock) return
    try { this.lock.close() } catch { /* the operating system releases it when the process ends */ }
    this.lock = null
  }

  /** One pass over everything that may have become due. Never overlaps with itself. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped || this.stopping) return
    // Guard 3, before anything is read or done: an engine that is no longer the one engine does nothing.
    if (!this.stillOwner()) { this.fence('Another engine has written the heartbeat row since this engine last did.'); return }
    // The database cannot be written: act on nothing, and try a write now and then (every 5 s) until one succeeds.
    if (this.storageFault && !this.tryRecoverStorage(this.clock.now())) return
    this.busy = true
    const t0 = performance.now()
    const now = this.clock.now()
    const { ctx } = this
    // A process that is suspended (the machine sleeps) does not restart, so the gap has to be noticed here, not only at start-up.
    if (this.lastTickAt > 0 && now - this.lastTickAt > DOWN_AFTER_MS) {
      try { this.recordDowntime(this.lastTickAt, now, 'suspended') } catch { /* the gap is still visible in the missed runs */ }
    }
    this.lastTickAt = now
    try {
      ctx.market.flush()
      // Changes that reduce protection take effect when their delay ends, whether or not anyone is looking.
      applyDueChanges(ctx.db, now)
      // Account deletions whose delay has ended (server/records.ts); one that finds money in flight is cancelled, not applied.
      applyDueDeletions(ctx.db, now)
      // A recovery started by email whose wait has ended: its "ready to finish" link goes out once (server/recovery.ts).
      recoveryTick(ctx.db, now)
      schedulerTick(ctx)
      triggerTick(ctx)
      runTick(ctx)
      // The paper escrow's stated defaults whose deadline has come (a review that ended, a refund unanswered, a dispute
      // unanswered or undecided), each applied once, whether or not the owner has paused QED (server/escrow.ts).
      escrowTick(ctx)
      // Guard 3 again after every wait: another engine may have taken over while this one was waiting, and a pass that
      // started as the one engine must not finish as a second one. A graceful stop also ends the pass here, at a step
      // boundary: every step is written before the next begins (execute.ts), so what is left is resumed by the next start.
      const mine = (): boolean => { if (this.stopping) return false; if (this.stillOwner()) return true; this.fence('Another engine wrote the heartbeat row during this pass.'); return false }
      await stepAllActions(ctx, () => !this.stopping)
      if (!mine()) return
      await ctx.venues.crypto.tick()
      if (!mine()) return
      await ctx.venues.rail.tick()
      if (!mine()) return
      await securitiesTick(ctx)
      if (!mine()) return
      if (now - this.last.funds >= 10_000) { await ctx.venues.funds.tick(); this.last.funds = now; if (!mine()) return }
      await stepAllActions(ctx, () => !this.stopping)
      if (!mine()) return
      // Purchases an agent made that were left 'paying' (the paper rail settled after the request had ended): delivered or ended (server/commerce.ts).
      if (now - this.last.commerce >= 10_000) { this.last.commerce = now; await reconcileAllPurchases(ctx); if (!mine()) return }
      runTick(ctx)
      // abroadTick: payments abroad whose value date has begun are credited on paper (server/abroad.ts, R13)
      if (now - this.last.bank >= 30_000) { bankTick(ctx); disputeTick(ctx); retryRevocations(ctx); abroadTick(ctx); this.last.bank = now }
      if (now - this.last.recon >= 30_000) { for (const u of this.db.all<{ id: string }>(`SELECT id FROM users`)) this.recordRecon(u.id, reconcileUser(ctx, u.id), now); this.last.recon = now }
      // The on-chain wallets' books, on the same cadence: final movements booked and the books compared with the wallet
      // service's balances (server/chain-books.ts). Not awaited: the comparison it stores is read by the next reconciliation.
      if (this.live && now - this.last.chainBooks >= 30_000) {
        this.last.chainBooks = now
        chainBooksSchedule(this.cfg, this.db, now).catch(() => { /* tried again in the next half minute */ })
        // R13: a wallet operation a reorganisation undid, and a raise of the earned caps now in force (vault-watch.ts)
        vaultWatch(this.cfg, this.db, now).catch(() => { /* tried again in the next half minute */ })
      }
      // Notifications: plan new notices, escalate what waited too long for an acknowledgement, gather digests (notify.ts).
      if (now - this.last.notify >= 60_000) { notifyTick(this.db, now); this.last.notify = now }
      // The clock check asks Binance for its time: in presentation mode no provider is contacted, so it is not run.
      if (this.live && !this.cfg.presentation && now - this.last.clock >= 10 * 60_000) { this.last.clock = now; checkClock(this.db, this.clock).catch(() => { /* recorded as absent; the status page shows the last successful check */ }) }
      if (this.live && !this.cfg.presentation && now - this.last.rules >= 6 * 3600_000) { this.last.rules = now; refreshCoindcxRules(this.db, instruments(this.db).filter((i) => i.provider === 'coindcx'), now).catch(() => { /* seeded rules stay in force */ }) }
      if (now - this.last.prune >= 3600_000) { this.prune(now); this.last.prune = now }
      // A standing policy on the on-chain vault is ticked on a five-minute grid, once per slot. The owner signed the
      // policy; the vault service decides each tranche. If that service is not running this does nothing. Looked at every
      // half minute, so a policy signed just now is ticked by the engine within about 30 s (R13, Topic F), not at the
      // next slot: vaultAsked holds the slot keys already asked for, so no policy is asked twice in one slot.
      if (this.live && !this.vaultBusy && now - this.last.vault >= 30_000) {
        this.last.vault = now
        this.vaultBusy = true
        const slot = Math.floor(now / 300_000)
        // a miss is recorded once per slot (the incident counts scheduled ticks; a pass every half minute would count one
        // slot's miss up to ten times); an accepted tick is recorded at once, which resolves the incident
        const missed = (w: string): boolean => w.startsWith('failed') || w.includes('(no answer)')
        railPolicySchedule(this.cfg, this.db, now, this.vaultAsked).then((what) => {
          if (this.stopped) return
          if (!missed(what) || this.vaultMissSlot !== slot) { if (missed(what)) this.vaultMissSlot = slot; this.recordVault(what, this.clock.now()) }
          // what each workspace's vault was asked is that workspace's own event (rail.ts railPolicySchedule); the line every
          // session reads says only that the scheduler ran, with counts (R13 review, lead L-08)
          if (what.startsWith('tick')) { try { emit(this.db, this.clock.now(), null, 'vault', { what: 'tick', asked: (what.match(/(^|; )tick /g) ?? []).length }) } catch { /* closing */ } }
        }, (e) => { if (!this.stopped && this.vaultMissSlot !== slot) { this.vaultMissSlot = slot; this.recordVault(`failed: ${e instanceof Error ? e.message : String(e)}`, this.clock.now()) } /* tried again in the next half minute */ }).finally(() => { this.vaultBusy = false })
      }
      if (this.tickFailing) { this.tickFailing = false; resolveIncident(this.db, this.clock.now(), 'engine-tick', 'The next pass completed without an error.') }
    } catch (e) {
      // A tick that was in flight when the engine was told to stop finds the database closed; that is not an error to report.
      if (!this.stopped) {
        if (!this.noteStorage(e, now)) {
          // every session is told the pass failed; its error text (which can name any workspace's data) goes to the
          // incident below and the engine's own log, not to everyone's event stream (lead L-08)
          try { emit(this.db, now, null, 'engine', { state: 'tick-error' }) } catch { /* nothing more can be recorded */ }
          if (!this.tickFailing) openIncident(this.db, now, { key: 'engine-tick', source: 'engine', title: 'The engine hit an error in a pass', detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
          this.tickFailing = true
        }
      }
    } finally {
      this.ticks++
      this.lastTickMs = performance.now() - t0
      // a failed heartbeat must not end the process: an unwritable database is a fault to report and wait out
      if (!this.stopped && this.clock.now() - this.last.heartbeat >= HEARTBEAT_MS) { try { this.beat() } catch (e) { if (!this.noteStorage(e, this.clock.now())) throw e } }
      this.busy = false
    }
  }

  /** If `e` is a storage error: enter the fault state (once), and say so. False: not a storage error. */
  private noteStorage(e: unknown, now: number): boolean {
    const kind = storageErrorKind(e)
    if (!kind) return false
    if (!this.storageFault) {
      this.storageFault = { since: now, kind, lastProbe: now, skipped: 0 }
      console.error(`[engine] ${now} cannot write to the database (${kind === 'full' ? 'disk full' : 'I/O error'}); acting on nothing until it can`)
      openIncident(this.db, now, {
        key: 'engine-storage', source: 'engine',
        title: kind === 'full' ? 'The disk is full: the engine stopped acting' : 'The disk reported an error: the engine stopped acting',
        detail: `${e instanceof Error ? e.message : String(e)}. The pass that hit it was rolled back; the engine acts on nothing until a write succeeds.`,
      })
    }
    return true
  }

  /** Writes a probe at most every 5 s. On success the fault ends: held records are written, the gap is recorded, the incident closed. */
  private tryRecoverStorage(now: number): boolean {
    const f = this.storageFault!
    if (now - f.lastProbe < 5000) { f.skipped++; return false }
    f.lastProbe = now
    const err = probeStorage(this.db)
    if (err) { if (!storageErrorKind(err)) throw err; return false }
    this.storageFault = null
    try { flushHeld(this.db) } catch { this.storageFault = f; return false }
    const missed = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM programs WHERE state = 'active' AND next_due_at IS NOT NULL AND next_due_at BETWEEN ? AND ?`, f.since, now)?.n ?? 0
    try {
      this.recordDowntime(f.since, now, 'storage')
      this.last.heartbeat = 0
      this.beat()
      emit(this.db, now, null, 'engine', { state: 'storage-recovered', since: f.since })
    } catch (e) { if (storageErrorKind(e)) { this.storageFault = f; return false } throw e }
    resolveIncident(this.db, now, 'engine-storage', `Space returned and a write succeeded. The engine is acting again. ${missed} scheduled run${missed === 1 ? '' : 's'} inside the gap ${missed === 1 ? 'was' : 'were'} marked missed and will not be run late; ${f.skipped} pass${f.skipped === 1 ? '' : 'es'} did nothing meanwhile.`, { missedRuns: missed })
    console.error(`[engine] ${now} the database can be written again`)
    return true
  }

  /** Reconciliation: a difference with a venue opens an incident for that owner; agreement closes it. */
  private recordRecon(userId: string, r: { ok: boolean; breaks: string[]; repaired: string[] }, now: number): void {
    const key = `recon:${userId}`
    if (!r.ok) { if (!incidentOpen(this.db, key)) openIncident(this.db, now, { key, source: 'reconciliation', title: 'The books and a venue differ', detail: r.breaks.slice(0, 3).join(' | ').slice(0, 400), affected: { differences: r.breaks.length } }) }
    else if (incidentOpen(this.db, key)) resolveIncident(this.db, now, key, `The books and the venues agree again${r.repaired.length ? `; repaired: ${r.repaired.slice(0, 2).join(' | ').slice(0, 200)}` : ''}.`, { differences: 0 })
  }

  /** The wallet service as the engine meets it on each policy tick: no answer opens an incident, a tick that was accepted closes it. */
  private recordVault(what: string, now: number): void {
    const failed = what.startsWith('failed') || what.includes('(no answer)')
    if (failed) { this.vaultMisses++; openIncident(this.db, now, { key: 'wallet-service', source: 'wallet-service', title: 'The wallet service did not answer the engine', detail: what.slice(0, 300), affected: { missedTicks: this.vaultMisses } }) }
    else if (what.startsWith('tick') && incidentOpen(this.db, 'wallet-service')) { resolveIncident(this.db, now, 'wallet-service', `The wallet service answered and a tick was accepted. ${this.vaultMisses} scheduled tick${this.vaultMisses === 1 ? '' : 's'} had been missed.`, { missedTicks: this.vaultMisses }); this.vaultMisses = 0 }
  }

  private prune(now: number): void {
    this.db.run('DELETE FROM events WHERE ts < ?', now - 2 * 86_400_000)
    this.db.run('DELETE FROM quote_history WHERE recv_ts < ?', now - 14 * 86_400_000)
    this.db.run('DELETE FROM rate_limits WHERE window_start < ?', now - 86_400_000)
  }

  /**
   * Stop on SIGTERM (docs/DEPLOY.md, "Graceful shutdown"): no new tick starts; a tick under way finishes the step it is
   * in and stops at the next step boundary; after at most `graceMs` the engine stops anyway. Either way it then flushes,
   * writes its last heartbeat (so a successor starts at once), lets go of its lock and closes the database. A step cut off
   * by the grace running out is abandoned safely: it was written before its effect was sent, and the next engine resumes
   * it under the same economic id, which every venue and the ledger key on (PRODUCTION.md section 8).
   */
  async stopGracefully(graceMs: number): Promise<{ abandoned: boolean; waitedMs: number }> {
    this.stopping = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.mailTimer) { clearInterval(this.mailTimer); this.mailTimer = null }
    const t0 = performance.now()
    while (this.busy && performance.now() - t0 < graceMs) await new Promise((r) => setTimeout(r, 20))
    const abandoned = this.busy
    this.stop()
    return { abandoned, waitedMs: Math.round(performance.now() - t0) }
  }

  stop(): void {
    if (this.closed) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.mailTimer) clearInterval(this.mailTimer)
    for (const p of this.providers) p.stop()
    // Only the one engine writes its last beat and its stop. One that was fenced, refused or never started writes
    // nothing: the heartbeat row belongs to whichever engine holds the database.
    if (this.lease !== 'lost') { try { this.ctx.market.flush() } catch { /* closing anyway */ } }
    if (this.lease === 'held') {
      try { this.beat(false, true); emit(this.db, this.clock.now(), null, 'engine', { state: 'stopped', pid: process.pid }) } catch { /* closing anyway */ }
    }
    this.releaseLock()
    this.db.close()
    this.closed = true
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export interface EngineStatus { running: boolean; pid: number | null; startedAt: number | null; lastBeat: number | null; ageMs: number | null; ticks: number | null; lastTickMs: number | null }
/**
 * What another process (the API) can know about the engine: only what the heartbeat row says. An engine that stopped
 * cleanly said so in its last beat and is reported down at once; one that died or stalls is reported down once its
 * heartbeat is DOWN_AFTER_MS old.
 */
export function engineStatus(db: Db, now: number): EngineStatus {
  const hb = db.get<{ pid: number; started_at: number; beat_at: number; detail_json: string }>(`SELECT pid, started_at, beat_at, detail_json FROM heartbeats WHERE service = 'engine'`)
  if (!hb) return { running: false, pid: null, startedAt: null, lastBeat: null, ageMs: null, ticks: null, lastTickMs: null }
  const d = JSON.parse(hb.detail_json) as { ticks?: number; lastTickMs?: number; stopped?: boolean }
  const age = now - hb.beat_at
  return { running: age < DOWN_AFTER_MS && d.stopped !== true, pid: hb.pid, startedAt: hb.started_at, lastBeat: hb.beat_at, ageMs: age, ticks: d.ticks ?? null, lastTickMs: d.lastTickMs ?? null }
}
