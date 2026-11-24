/**
 * The rail's durable store (node:sqlite, one file). Proposals, idempotency keys, jobs and their steps, the
 * transaction-attempt journal, decision records, mandates, policies, receipts, history and clock events all live
 * here, so a restart loses nothing that was accepted.
 *
 * Decision records, receipts, history and clock events are append-only: triggers refuse UPDATE and DELETE.
 * Decision records are hash-chained; verifyDecisions() recomputes the chain.
 *
 * The rail's own request budget is here too (quota_events): one row per counted request, so the count survives a
 * restart. It is the one table that is pruned, when its rows leave the rolling window.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalTerms } from "../terms.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, params TEXT NOT NULL, terms TEXT NOT NULL, terms_hash TEXT NOT NULL,
  summary TEXT NOT NULL, allowed INTEGER NOT NULL, checks TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, genesis_id TEXT NOT NULL, status TEXT NOT NULL, job_id TEXT);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, job_id TEXT NOT NULL, approval TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, proposal_id TEXT,
  approval TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, result TEXT, error TEXT, guidance TEXT);
CREATE TABLE IF NOT EXISTS job_steps (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
  detail TEXT NOT NULL, data TEXT, at TEXT NOT NULL, PRIMARY KEY (job_id, seq));
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, purpose TEXT NOT NULL, intent_id TEXT,
  sender TEXT NOT NULL, target TEXT NOT NULL, data_hash TEXT NOT NULL, tx_hash TEXT, status TEXT NOT NULL,
  block_number TEXT, error_name TEXT, from_block TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT, verdict TEXT NOT NULL,
  clock TEXT, approval TEXT, terms_hash TEXT, record TEXT NOT NULL, evidence_hash TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mandates (
  version INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, mandate TEXT NOT NULL, owner_sig TEXT NOT NULL,
  status TEXT NOT NULL, signed_at TEXT NOT NULL, ended_at TEXT, end_tx TEXT, approval_id TEXT, purpose_text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nonce TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, message TEXT NOT NULL,
  policy_sig TEXT NOT NULL, enforcement TEXT NOT NULL, need_slack_bps INTEGER, status TEXT NOT NULL,
  signed_at TEXT NOT NULL, ended_at TEXT, ticks INTEGER NOT NULL DEFAULT 0, approval_id TEXT);
CREATE TABLE IF NOT EXISTS ticks (
  n INTEGER PRIMARY KEY AUTOINCREMENT, policy_id INTEGER NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL, job_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  tx_hash TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL, block_number TEXT NOT NULL, gas_used TEXT NOT NULL,
  sender TEXT NOT NULL, target TEXT, error_name TEXT, error_args TEXT, events TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (
  n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  outcome TEXT NOT NULL, tx TEXT, trade TEXT, job_id TEXT);
CREATE TABLE IF NOT EXISTS clock_events (
  n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, event TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quota_events (
  n INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_changes (
  change_id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, calls TEXT NOT NULL,
  ready_at INTEGER NOT NULL, hook TEXT NOT NULL, proposal_id TEXT NOT NULL, job_id TEXT NOT NULL,
  applied_job TEXT, cancelled_job TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, spec TEXT NOT NULL, request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS attempts_job ON attempts (job_id);
CREATE INDEX IF NOT EXISTS quota_class_at ON quota_events (class, at);
`;
const APPEND_ONLY = ["decisions", "receipts", "history", "clock_events", "ticks", "approvals"];

export type Row = Record<string, unknown>;
const j = (x: unknown) => (x === undefined || x === null ? null : JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const p = <T = unknown>(s: unknown): T | null => (typeof s === "string" ? (JSON.parse(s) as T) : null);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const GENESIS_HASH = "0".repeat(64);

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // The database and its journal are readable by this service's user only (they were mode 644: docs/ENCRYPTION.md).
    if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) { try { chmodSync(f, 0o600); } catch { /* not ours to change */ } }
    this.db.exec(SCHEMA);
    // Receipts name the chain they come from: the shared chain, or an ephemeral chain of one Security Lab or scenario
    // run that no longer exists. Added to databases created before that column existed (the value is then the shared chain's).
    if (!this.all("PRAGMA table_info(receipts)").some((c) => c.name === "network")) this.db.exec("ALTER TABLE receipts ADD COLUMN network TEXT");
    // Attempts name the chain they were sent on the same way: NULL is the shared chain; an ephemeral chain's run (Security
    // Lab, scenarios) names its own, which is destroyed after the run, so the reorganisation check never looks for its
    // transactions on the shared chain (R13: it did, and marked those jobs "reorged"). An attempt written before the column
    // existed is an ephemeral one exactly when its purpose says so; it takes its receipt's network, or "ephemeral".
    if (!this.all("PRAGMA table_info(attempts)").some((c) => c.name === "network")) this.db.exec("ALTER TABLE attempts ADD COLUMN network TEXT");
    // R7-036: how deep a job's transactions were when last measured ({ have, need, block }), so that a job waiting for its
    // confirmations says how far it is. The job's steps stay the operation's own.
    if (!this.all("PRAGMA table_info(jobs)").some((c) => c.name === "depth")) this.db.exec("ALTER TABLE jobs ADD COLUMN depth TEXT");
    this.db.exec("UPDATE attempts SET network = COALESCE((SELECT r.network FROM receipts r WHERE r.tx_hash = attempts.tx_hash AND r.network IS NOT NULL), 'ephemeral') WHERE network IS NULL AND purpose LIKE 'ephemeral:%'");
    for (const t of APPEND_ONLY) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`);
    }
  }
  close() {
    this.db.close();
  }

  /** Runs `f` in one immediate transaction; rolls back if it throws. */
  tx<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = f();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...(args as never[]));
  }
  private get(sql: string, ...args: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(args as never[])) as Row | undefined;
  }
  private all(sql: string, ...args: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(args as never[])) as Row[];
  }

  // ───────────── meta ─────────────
  meta<T = unknown>(key: string): T | null {
    return p<T>(this.get("SELECT value FROM meta WHERE key = ?", key)?.value);
  }
  setMeta(key: string, value: unknown) {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, j(value));
  }
  /** Durable counter: returns the next value (1, 2, 3 …). */
  next(counter: string): number {
    return this.tx(() => {
      const n = (this.meta<number>(`counter:${counter}`) ?? 0) + 1;
      this.setMeta(`counter:${counter}`, n);
      return n;
    });
  }

  // ───────────── proposals ─────────────
  insertProposal(r: { id: string; kind: string; params: unknown; terms: unknown; termsHash: string; summary: string; allowed: boolean; checks: unknown; createdAt: string; expiresAt: string; genesisId: string }) {
    this.run("INSERT INTO proposals (id, kind, params, terms, terms_hash, summary, allowed, checks, created_at, expires_at, genesis_id, status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open')",
      r.id, r.kind, j(r.params), canonicalTerms(r.terms), r.termsHash, r.summary, r.allowed ? 1 : 0, j(r.checks), r.createdAt, r.expiresAt, r.genesisId);
  }
  proposal(id: string): Row | undefined {
    return this.get("SELECT * FROM proposals WHERE id = ?", id);
  }
  setProposalStatus(id: string, status: string, jobId: string | null = null) {
    this.run("UPDATE proposals SET status = ?, job_id = COALESCE(?, job_id) WHERE id = ?", status, jobId, id);
  }
  /** Open proposals of the given kinds are cancelled, e.g. when a newer proposal replaces them. */
  cancelOpenProposals(kinds: string[]) {
    for (const k of kinds) this.run("UPDATE proposals SET status = 'cancelled' WHERE status = 'open' AND kind = ?", k);
  }

  // ───────────── idempotency, approvals, jobs ─────────────
  submission(key: string): Row | undefined {
    return this.get("SELECT * FROM submissions WHERE key = ?", key);
  }
  insertSubmission(key: string, fingerprint: string, jobId: string, at: string) {
    this.run("INSERT INTO submissions (key, fingerprint, job_id, created_at) VALUES (?,?,?,?)", key, fingerprint, jobId, at);
  }
  approvalUse(approvalId: string): Row | undefined {
    return this.get("SELECT * FROM approvals WHERE approval_id = ?", approvalId);
  }
  insertApproval(approvalId: string, proposalId: string, jobId: string, approval: unknown, at: string) {
    this.run("INSERT INTO approvals (approval_id, proposal_id, job_id, approval, at) VALUES (?,?,?,?,?)", approvalId, proposalId, jobId, j(approval), at);
  }
  insertJob(r: { id: string; kind: string; request: unknown; proposalId: string | null; approval: unknown; createdAt: string }) {
    this.run("INSERT INTO jobs (id, kind, status, request, proposal_id, approval, created_at) VALUES (?,?, 'accepted', ?,?,?,?)", r.id, r.kind, j(r.request), r.proposalId, j(r.approval), r.createdAt);
  }
  job(id: string): Row | undefined {
    return this.get("SELECT * FROM jobs WHERE id = ?", id);
  }
  jobs(limit: number): Row[] {
    return this.all("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?", limit);
  }
  jobsByStatus(status: string): Row[] {
    return this.all("SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC, rowid ASC", status);
  }
  startJob(id: string, at: string) {
    this.run("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", at, id);
  }
  finishJob(id: string, status: string, at: string, result: unknown, error: string | null, guidance: string | null = null) {
    this.run("UPDATE jobs SET status = ?, finished_at = ?, result = ?, error = ?, guidance = ? WHERE id = ?", status, at, j(result), error, guidance, id);
  }
  putStep(jobId: string, seq: number, s: { key: string; label: string; status: string; detail: string; data?: unknown; at: string }) {
    this.run("INSERT INTO job_steps (job_id, seq, key, label, status, detail, data, at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id, seq) DO UPDATE SET key = excluded.key, label = excluded.label, status = excluded.status, detail = excluded.detail, data = excluded.data, at = excluded.at",
      jobId, seq, s.key, s.label, s.status, s.detail, j(s.data), s.at);
  }
  steps(jobId: string): Row[] {
    return this.all("SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq ASC", jobId);
  }

  // ───────────── attempt journal ─────────────
  /** `network`: the chain the transaction is sent on; null (the default) is the shared chain, otherwise an ephemeral chain's name. */
  insertAttempt(r: { jobId: string; purpose: string; intentId: string | null; sender: string; target: string; dataHash: string; fromBlock: string; at: string; network?: string | null }): number {
    return Number(this.run("INSERT INTO attempts (job_id, purpose, intent_id, sender, target, data_hash, status, from_block, created_at, updated_at, network) VALUES (?,?,?,?,?,?, 'prepared', ?,?,?,?)",
      r.jobId, r.purpose, r.intentId, r.sender, r.target, r.dataHash, r.fromBlock, r.at, r.at, r.network ?? null).lastInsertRowid);
  }
  updateAttempt(id: number, r: { status: string; txHash?: string | null; blockNumber?: string | null; errorName?: string | null; at: string }) {
    this.run("UPDATE attempts SET status = ?, tx_hash = COALESCE(?, tx_hash), block_number = COALESCE(?, block_number), error_name = COALESCE(?, error_name), updated_at = ? WHERE id = ?",
      r.status, r.txHash ?? null, r.blockNumber ?? null, r.errorName ?? null, r.at, id);
  }
  attempts(jobId: string): Row[] {
    return this.all("SELECT * FROM attempts WHERE job_id = ? ORDER BY id ASC", jobId);
  }

  /**
   * The newest attempts on the shared chain that reached a transaction, for the check against the chain (a reorganisation
   * may have replaced one). An ephemeral chain's attempts are never among them: that chain no longer exists.
   */
  minedAttempts(limit: number): Row[] {
    return this.all("SELECT a.*, j.status AS job_status, j.kind AS job_kind FROM attempts a JOIN jobs j ON j.id = a.job_id WHERE a.network IS NULL AND a.tx_hash IS NOT NULL AND a.status IN ('mined-success','mined-revert','replaced') ORDER BY a.id DESC LIMIT ?", limit);
  }
  /** One job's transactions on the shared chain that were mined (R7-036: each must reach the confirmation depth). */
  sharedMined(jobId: string): Row[] {
    return this.all("SELECT * FROM attempts WHERE job_id = ? AND network IS NULL AND tx_hash IS NOT NULL AND status IN ('mined-success','mined-revert','replaced') ORDER BY id ASC", jobId);
  }
  /** Ephemeral-chain attempts the reorganisation check wrongly marked replaced before R13 (see the constructor). */
  ephemeralReplaced(): Row[] {
    return this.all("SELECT a.*, j.status AS job_status, j.kind AS job_kind, r.status AS receipt_status FROM attempts a JOIN jobs j ON j.id = a.job_id LEFT JOIN receipts r ON r.tx_hash = a.tx_hash WHERE a.network IS NOT NULL AND a.status = 'replaced' ORDER BY a.id ASC");
  }
  setJobStatus(id: string, status: string, error: string | null, guidance: string | null) {
    this.run("UPDATE jobs SET status = ?, error = ?, guidance = ? WHERE id = ?", status, error, guidance, id);
  }
  setDepth(id: string, depth: { have: number; need: number; block: string | null }) {
    this.run("UPDATE jobs SET depth = ? WHERE id = ?", j(depth), id);
  }
  /** A job that was waiting for its confirmations ends: done, or reorganised away first. Nothing else is moved by it. */
  endConfirming(id: string, status: "done" | "reorged", at: string, error: string | null, guidance: string | null): boolean {
    return this.run("UPDATE jobs SET status = ?, finished_at = ?, error = COALESCE(?, error), guidance = COALESCE(?, guidance) WHERE id = ? AND status = 'confirming'", status, at, error, guidance, id).changes > 0;
  }

  // ───────────── decision records (hash-chained, append-only) ─────────────
  appendDecision(r: { at: string; kind: string; jobId: string | null; verdict: string; clock?: unknown; approval?: unknown; termsHash?: string | null; record: unknown; evidenceHash?: string | null }): { n: number; hash: string } {
    return this.tx(() => {
      const prev = (this.get("SELECT hash FROM decisions ORDER BY n DESC LIMIT 1")?.hash as string | undefined) ?? GENESIS_HASH;
      const body = canonicalTerms({ at: r.at, kind: r.kind, jobId: r.jobId, verdict: r.verdict, clock: r.clock ?? null, approval: r.approval ?? null, termsHash: r.termsHash ?? null, record: r.record, evidenceHash: r.evidenceHash ?? null });
      const hash = sha(prev + "\n" + body);
      const out = this.run("INSERT INTO decisions (at, kind, job_id, verdict, clock, approval, terms_hash, record, evidence_hash, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        r.at, r.kind, r.jobId, r.verdict, j(r.clock), j(r.approval), r.termsHash ?? null, canonicalTerms(r.record), r.evidenceHash ?? null, prev, hash);
      return { n: Number(out.lastInsertRowid), hash };
    });
  }
  decisions(limit: number, jobId?: string): Row[] {
    return jobId ? this.all("SELECT * FROM decisions WHERE job_id = ? ORDER BY n ASC", jobId) : this.all("SELECT * FROM decisions ORDER BY n DESC LIMIT ?", limit);
  }
  /** Recomputes the whole chain. `brokenAt` is the first record whose hash or link does not hold. */
  verifyDecisions(): { ok: boolean; records: number; brokenAt: number | null; head: string } {
    let prev = GENESIS_HASH, count = 0;
    for (const r of this.all("SELECT * FROM decisions ORDER BY n ASC")) {
      count++;
      const body = canonicalTerms({ at: r.at, kind: r.kind, jobId: r.job_id, verdict: r.verdict, clock: p(r.clock), approval: p(r.approval), termsHash: r.terms_hash, record: p(r.record), evidenceHash: r.evidence_hash });
      if (r.prev_hash !== prev || r.hash !== sha(prev + "\n" + body)) return { ok: false, records: count, brokenAt: Number(r.n), head: prev };
      prev = r.hash as string;
    }
    return { ok: true, records: count, brokenAt: null, head: prev };
  }

  // ───────────── mandates and policies ─────────────
  insertMandate(r: { version: number; hash: string; mandate: unknown; ownerSig: string; signedAt: string; approvalId: string | null; purposeText: string }) {
    this.run("INSERT INTO mandates (version, hash, mandate, owner_sig, status, signed_at, approval_id, purpose_text) VALUES (?,?,?,?, 'active', ?,?,?)", r.version, r.hash, j(r.mandate), r.ownerSig, r.signedAt, r.approvalId, r.purposeText);
  }
  endMandate(version: number, status: string, at: string, tx: string | null) {
    this.run("UPDATE mandates SET status = ?, ended_at = ?, end_tx = ? WHERE version = ? AND status = 'active'", status, at, tx, version);
  }
  endAllMandates(status: string, at: string, tx: string | null) {
    this.run("UPDATE mandates SET status = ?, ended_at = ?, end_tx = ? WHERE status = 'active'", status, at, tx);
  }
  activeMandate(): Row | undefined {
    return this.get("SELECT * FROM mandates WHERE status = 'active' ORDER BY version DESC LIMIT 1");
  }
  mandateByHash(hash: string): Row | undefined {
    return this.get("SELECT * FROM mandates WHERE hash = ?", hash);
  }
  mandates(): Row[] {
    return this.all("SELECT * FROM mandates ORDER BY version DESC");
  }
  lastMandateVersion(): number {
    return Number(this.get("SELECT COALESCE(MAX(version), 0) AS v FROM mandates")?.v ?? 0);
  }
  insertPolicy(r: { nonce: string; policy: unknown; message: string; policySig: string; enforcement: string; needSlackBps: number | null; signedAt: string; approvalId: string | null }): number {
    return Number(this.run("INSERT INTO policies (nonce, policy, message, policy_sig, enforcement, need_slack_bps, status, signed_at, approval_id) VALUES (?,?,?,?,?,?, 'active', ?,?)",
      r.nonce, j(r.policy), r.message, r.policySig, r.enforcement, r.needSlackBps, r.signedAt, r.approvalId).lastInsertRowid);
  }
  endActivePolicies(status: string, at: string) {
    this.run("UPDATE policies SET status = ?, ended_at = ? WHERE status = 'active'", status, at);
  }
  activePolicy(): Row | undefined {
    return this.get("SELECT * FROM policies WHERE status = 'active' ORDER BY id DESC LIMIT 1");
  }
  policies(): Row[] {
    return this.all("SELECT * FROM policies ORDER BY id DESC");
  }
  bumpPolicyTicks(id: number): number {
    this.run("UPDATE policies SET ticks = ticks + 1 WHERE id = ?", id);
    return Number(this.get("SELECT ticks FROM policies WHERE id = ?", id)?.ticks ?? 0);
  }
  insertTick(policyId: number, at: string, record: unknown, jobId: string) {
    this.run("INSERT INTO ticks (policy_id, at, record, job_id) VALUES (?,?,?,?)", policyId, at, j(record), jobId);
  }
  ticks(limit: number): Row[] {
    return this.all("SELECT * FROM ticks ORDER BY n DESC LIMIT ?", limit);
  }

  // ───────────── receipts, history, clock events ─────────────
  insertReceipt(r: { txHash: string; jobId: string | null; status: string; blockNumber: string; gasUsed: string; sender: string; target: string | null; errorName: string | null; errorArgs: unknown; events: unknown; at: string; network?: string | null }) {
    this.run("INSERT OR IGNORE INTO receipts (tx_hash, job_id, status, block_number, gas_used, sender, target, error_name, error_args, events, at, network) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      r.txHash, r.jobId, r.status, r.blockNumber, r.gasUsed, r.sender, r.target, r.errorName, j(r.errorArgs), j(r.events) ?? "[]", r.at, r.network ?? null);
  }
  receipt(hash: string): Row | undefined {
    return this.get("SELECT * FROM receipts WHERE tx_hash = ?", hash);
  }
  receiptCount(): number {
    return Number(this.get("SELECT COUNT(*) AS c FROM receipts")?.c ?? 0);
  }
  appendHistory(r: { at: string; kind: string; title: string; outcome: string; tx?: unknown; trade?: unknown; jobId: string | null }) {
    this.run("INSERT INTO history (at, kind, title, outcome, tx, trade, job_id) VALUES (?,?,?,?,?,?,?)", r.at, r.kind, r.title, r.outcome, j(r.tx), j(r.trade), r.jobId);
  }
  historyForJob(jobId: string): Row[] {
    return this.all("SELECT * FROM history WHERE job_id = ? ORDER BY n ASC", jobId);
  }
  history(limit: number): Row[] {
    return this.all("SELECT * FROM history ORDER BY n DESC LIMIT ?", limit);
  }
  appendClockEvent(at: string, kind: string, event: unknown): number {
    return Number(this.run("INSERT INTO clock_events (at, kind, event) VALUES (?,?,?)", at, kind, j(event)).lastInsertRowid);
  }
  clockEvents(limit: number): Row[] {
    return this.all("SELECT * FROM clock_events ORDER BY n DESC LIMIT ?", limit);
  }

  // ───────────── the rail's own budget (rolling window; one row per counted request) ─────────────
  /** Requests of one class counted after `since` (milliseconds): how many, and when the oldest of them was made. */
  quotaWindow(cls: string, since: number): { used: number; oldest: number | null } {
    const r = this.get("SELECT COUNT(*) AS used, MIN(at) AS oldest FROM quota_events WHERE class = ? AND at > ?", cls, since)!;
    return { used: Number(r.used), oldest: r.oldest === null ? null : Number(r.oldest) };
  }
  /** Counts one request and drops the rows of this class that have left the window, so the table stays bounded. */
  quotaAdd(cls: string, at: number, since: number) {
    this.run("DELETE FROM quota_events WHERE class = ? AND at <= ?", cls, since);
    this.run("INSERT INTO quota_events (class, at) VALUES (?, ?)", cls, at);
  }

  // ───────────── changes scheduled behind the owner account's delay ─────────────
  insertScheduled(r: { changeId: string; kind: string; summary: string; calls: unknown; readyAt: number; hook: unknown; proposalId: string; jobId: string; at: string }) {
    this.run("INSERT OR IGNORE INTO scheduled_changes (change_id, kind, summary, status, calls, ready_at, hook, proposal_id, job_id, created_at, updated_at) VALUES (?,?,?, 'pending', ?,?,?,?,?,?,?)", r.changeId, r.kind, r.summary, j(r.calls), r.readyAt, j(r.hook), r.proposalId, r.jobId, r.at, r.at);
  }
  scheduled(changeId: string): Row | undefined {
    return this.get("SELECT * FROM scheduled_changes WHERE change_id = ?", changeId);
  }
  scheduledAll(): Row[] {
    return this.all("SELECT * FROM scheduled_changes ORDER BY created_at DESC, rowid DESC");
  }
  finishScheduled(changeId: string, status: "applied" | "cancelled", jobId: string, at: string) {
    this.run(`UPDATE scheduled_changes SET status = ?, ${status === "applied" ? "applied_job" : "cancelled_job"} = ?, updated_at = ? WHERE change_id = ? AND status = 'pending'`, status, jobId, at, changeId);
  }

  // ───────────── the host's workspace registry (used in the host's store only) ─────────────
  workspace(id: string): Row | undefined {
    return this.get("SELECT * FROM workspaces WHERE id = ?", id);
  }
  workspaceRows(): Row[] {
    return this.all("SELECT * FROM workspaces ORDER BY created_at ASC, rowid ASC");
  }
  insertWorkspace(r: { id: string; status: string; spec: unknown; requestHash: string; at: string }) {
    this.run("INSERT INTO workspaces (id, status, spec, request_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)", r.id, r.status, j(r.spec), r.requestHash, r.at, r.at);
  }
  updateWorkspace(id: string, status: string, spec: unknown, at: string) {
    this.run("UPDATE workspaces SET status = ?, spec = ?, updated_at = ? WHERE id = ?", status, j(spec), at, id);
  }
}

export const parse = p;
