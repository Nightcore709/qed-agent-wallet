/**
 * RailService: ONE WORKSPACE of the chain rail (R7 D1).
 *
 * The shared chain, its clock, its persistence and the co-signer service belong to the host (rail/host.ts). A
 * workspace holds its own store, keys, owner authority and vault set, and looks up every proposal, job, receipt,
 * decision record and submission key in its own store only: an identifier from another workspace finds nothing here.
 *
 * What it adds around the release's unmodified contracts is what the release lacked (baseline section 6): durable
 * proposals, jobs, decision records and receipts; mandatory, durable idempotency; owner approvals bound to the exact
 * terms; supersession of mandates; one clock, recorded with each decision; chain state that survives a restart.
 *
 * Owner authority goes through OwnerAuthority (rail/owner.ts): for a workspace created through POST /workspaces it is
 * the workspace's passkey account, which the service cannot satisfy; the proposal says what the passkey must sign
 * (terms.toSign) and the approval carries the assertions, checked on chain before anything is relayed. The release's
 * development owner exists only in the baseline-parity host.
 *
 * Nothing here calls any network other than 127.0.0.1. The language step uses the release's labelled offline
 * parser and guard only; a real model, if any, is the backend's business upstream of the rail.
 */
import { randomUUID, createHash } from "node:crypto";
import { getAddress, keccak256, toHex, type Abi, type Address, type Hex, type LocalAccount } from "viem";
import { canonicalTerms, hashTerms, checkApproval, ApprovalError } from "../terms.ts";
import { executableQuote, expiredText, expiryVerdict } from "./quote-kinds.ts";
import type { Accepted, Approval, AttackInfo, ClockReading, DecisionRecord, Health, HistoryEntry, Job, JobKind, LimitCheck, LimitsResult, MandateFields, MandateView, OpResult, PlanView, Proposal, ProposalKind, ProposalRequest, QuotaClass, QuotaView, QuoteResult, RailState, Raw, ScheduledChange, Step, StepStatus, ToSign, TradeView, TxBrief, VaultView, VenueView, WorkspaceSummary, WorkspaceView } from "../types.ts";
import { notMet } from "./words.ts";
import { reading } from "./clock.ts";
import { BASELINE_WORKSPACE, CHAIN_ID, RELEASE_ID } from "./config.ts";
import { devAccount, type ApprovalWindow, type OwnerAction, type Role } from "./keys.ts";
import { Store, parse, type Row } from "./store.ts";
import type { CosignerPort } from "./cosigner.ts";
import { OwnerAuthorityError, PasskeyAccountOwner, encodeOwnerAction, type OwnerAuthority } from "./owner.ts";
import type { Addresses } from "./deploy.ts";
import { CHAIN_TOKENS, DEFAULT_ASSET_SET, isDefaultSet, type AssetSet } from "../../shared/chain-assets.ts";
import type { RailHost } from "./host.ts";
import { RailError, publicError } from "./errors.ts";

export { RailError, publicError };

export const ATTACKS: Record<AttackInfo["kind"], Omit<AttackInfo, "kind">> = {
  "inferior-route": { title: "Route over the direct pools only (what a single-pair router would pick)", expect: "NotBestExecution", layer: "QEDExecution: realised output below the dual bound" },
  skim: { title: "Skim: the optimal route with 5% of one leg moved", expect: "NotBestExecution", layer: "QEDExecution: best-execution tolerance of the co-signed order" },
  "forged-proof": { title: "“Forged proof”: prices chosen to make the direct route look optimal", expect: "NotBestExecution", layer: "Weak duality: any price vector is a valid upper bound" },
  "single-pool": { title: "Everything through one pool (the naive router)", expect: "NotBestExecution", layer: "Dual bound (and the co-signed floor, if the output falls below it)" },
  redirect: { title: "Redirect the order's output to Mallory", expect: "OrderMismatch", layer: "Co-signer certificate commits to the order hash" },
  "stolen-order": { title: "Mallory replays the genuine co-signed order without the agent key", expect: "NotOperator", layer: "Only the operator key may trade" },
};
export const ATTACK_KINDS = Object.keys(ATTACKS) as AttackInfo["kind"][];

/** What each class of the rail's own budget counts (rail/config.ts → quota). */
const QUOTA_COUNTS: Record<QuotaClass, string> = { proposals: "proposals prepared", operations: "operations accepted", economies: "scripted economies started" };
const MANDATE_PURPOSE = "Convert surplus tUSD into the euro operating reserve, with best execution proved on-chain";
const PAYEE_LABELS = ["QEDExecution (conversion module)", "Euro reserve", "CloudCo"];
/** A workspace's treasury holds tINR with a tUSD reserve: its mandates say so. The baseline keeps the release's words. */
const WORKSPACE_MANDATE_PURPOSE = "Convert surplus tINR into the dollar reserve and pay approved payees, with best execution proved on-chain";
const WORKSPACE_PAYEE_LABELS = ["QEDExecution (conversion module)", "Dollar reserve", "CloudCo"];
const WORST_CASE_SCOPE = "Transfers to payees the owner approved, within the vault's daily cap. It does not cover value lost to price moves inside the approved venues (baseline W-09).";
const ser = <T = any>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const ppm = (out: bigint, bound: bigint) => (bound > 0n ? (Number(bound - out) / Number(bound)) * 1e6 : 0);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Brain = { engine: string; interpret: (m: string, ctx: any, ch: "owner" | "counterparty") => Promise<{ result: any; transcript: any }> };
/** Kinds that never write to the shared chain: they run on an ephemeral chain of their own (R7 D4) and do not wait for its writer. */
export const OFF_SHARED_CHAIN = new Set<JobKind>(["attack", "scenario"]);

export interface Ctx {
  jobId: string;
  kind: JobKind;
  request: any;
  proposal: Proposal | null;
  terms: any;
  approval: Approval | null;
  window: ApprovalWindow;
  clock: ClockReading | null;
  push(s: { key: string; label: string; status: StepStatus; detail: string; data?: Record<string, unknown> }): number;
  replace(seq: number, s: { key: string; label: string; status: StepStatus; detail: string; data?: Record<string, unknown> }): void;
}
export type Handler = (ctx: Ctx) => Promise<OpResult>;
export type Proposer = (params: Record<string, unknown>) => Promise<{ terms: Record<string, unknown>; summary: string; allowed: boolean; checks: LimitCheck[]; replaces?: ProposalKind[] }>;
export type { Addresses };

export class RailService {
  readonly host: RailHost;
  /** The workspace id: "baseline" in the baseline-parity host, the backend's id otherwise. */
  readonly id: string;
  store!: Store;
  a!: Addresses;
  K!: Record<Exclude<Role, "OWNER" | "COSIGNER">, LocalAccount>;
  owner!: OwnerAuthority;
  cosigner!: CosignerPort;
  /** The key that relays a passkey account's transactions and pays their gas. It is not a signer of the account. */
  relayer: LocalAccount | null = null;
  /** The owner account's sentinel (R13): the one key that may freeze a member there and stop a pending recovery the guardian co-signed (H1), and nothing else. */
  sentinel: LocalAccount | null = null;
  recordsDir = "";
  /** The agent (operator) and guardian keys by version: development keys in the baseline, HKDF-derived otherwise. */
  roleKey: (role: "OPERATOR" | "GUARDIAN", version: number) => LocalAccount = (role, version) => devAccount(role, version);
  /** The treasury vault's asset and the reserve vault's: tUSD and tEUR in the baseline; tINR (paise) and tUSD in a workspace. */
  asset = { symbol: "tUSD", decimals: 6 };
  reserveAsset = { symbol: "tEUR", decimals: 6 };
  /** S5: a workspace's currency set (shared/chain-assets.ts); the default for every workspace created without one. The baseline holds the release's tUSD and tEUR and keeps the release's words. */
  currencies: AssetSet = DEFAULT_ASSET_SET;
  /** Symbols and decimals of the workspace's three test tokens, by checksummed address (set by the host). */
  tokenSymbols = new Map<string, { symbol: string; decimals: number }>();
  /** Labels and fees of the deployed pools in `a.pools`, in order. */
  venueDefs: { label: string; feeBps: number }[] = [];
  /** What the co-signer's check C12 is here: "release" (the baseline-parity workspace) or "d7", the authority budget (set by the host). */
  authorityRule: "release" | "d7" = "release";
  summary!: WorkspaceSummary;
  readonly proposers = new Map<ProposalKind, Proposer>();
  readonly handlers = new Map<JobKind, Handler>();
  /** Kinds whose handler may be run again after an interruption because each of its steps checks the chain first. */
  readonly rerunnable = new Set<JobKind>(["provision", "mandate"]);
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private waiters = new Map<string, ((j: Job) => void)[]>();
  private listeners = new Map<string, Set<(s: Step | { done: true }) => void>>();

  constructor(host: RailHost, id: string) {
    this.host = host;
    this.id = id;
    this.proposers.set("provision", (p) => this.proposeProvision(p));
    this.proposers.set("mandate", (p) => this.proposeMandate(p));
    this.proposers.set("convert", (p) => this.proposeConvert(p));
    this.handlers.set("provision", (c) => this.runProvision(c));
    this.handlers.set("mandate", (c) => this.runMandate(c));
    this.handlers.set("convert", (c) => this.runConvert(c));
    this.proposers.set("cancel-change", (p) => this.proposeCancelChange(p));
    this.handlers.set("cancel-change", (c) => this.runCancelChange(c));
    this.handlers.set("apply-change", (c) => this.runApplyChange(c));
    this.rerunnable.add("cancel-change").add("apply-change");
  }

  // ───────────────────────────── what belongs to the host ─────────────────────────────
  get cfg() { return this.host.cfg; }
  get status() { return this.host.status; }
  get error() { return this.host.error; }
  get startedAt() { return this.host.startedAt; }
  get restoredFromState() { return this.host.restoredFromState; }
  get vendoredOk() { return this.host.vendoredOk; }
  get genesisId() { return this.host.genesisId; }
  get v() { return this.host.v; }
  get c(): any { return this.host.c; }
  get anvil() { return this.host.anvil; }
  get brain(): Brain { return this.host.brain; }
  get pub(): any { return this.c.pub; }
  /** In the baseline-parity host, starting or stopping the one workspace starts or stops the host. */
  start = () => this.host.start();
  stop = () => this.host.stop();
  /** Waits until this workspace's own lane is empty. */
  drain = async () => { try { await this.queue; } catch { /* recorded */ } };
  rpc = (method: string, params: unknown[] = []) => this.host.rpc(method, params);
  checkpoint = () => this.host.checkpoint();
  tick = () => this.host.tick();
  align = (): Promise<ClockReading> => this.host.align();
  clock = (): Promise<ClockReading> => this.host.clock();
  chainNow = (): Promise<bigint> => this.host.chainNow();
  health = (): Promise<Health> => this.host.health();
  clockEvents = (limit = 50) => this.host.clockEvents(limit);
  get isBaseline() { return this.id === BASELINE_WORKSPACE; }
  /** What a mandate of this workspace states as its purpose (hashed into the mandate), and how its payees are labelled. */
  /** A workspace whose currency set is the default (or the baseline): its words are exactly those it always had. */
  get defaultSet() { return this.isBaseline || isDefaultSet(this.currencies); }
  get mandatePurpose() { return this.isBaseline ? MANDATE_PURPOSE : this.defaultSet ? WORKSPACE_MANDATE_PURPOSE : `Convert surplus ${this.asset.symbol} into the ${this.reserveName} and pay approved payees, with best execution proved on-chain`; }
  get payeeLabels() { return this.isBaseline ? PAYEE_LABELS : this.defaultSet ? WORKSPACE_PAYEE_LABELS : [WORKSPACE_PAYEE_LABELS[0], this.reserveLabel, WORKSPACE_PAYEE_LABELS[2]]; }
  /** "Dollar reserve": the reserve's name as a label. */
  get reserveLabel() { const n = this.reserveName; return n.charAt(0).toUpperCase() + n.slice(1); }

  // ───────────────────────────── helpers ─────────────────────────────
  now = () => this.cfg.wallClock();
  iso = () => new Date(this.cfg.wallClock()).toISOString();
  /** An amount of the treasury asset in its own units ("10.00", "1,250.50"), without floating point. */
  fmt = (x: bigint | string) => this.units(x, this.asset.decimals);
  /** An amount of the reserve asset. */
  fmtR = (x: bigint | string) => this.units(x, this.reserveAsset.decimals);
  units(x: bigint | string, decimals: number): string {
    // the release's formatter works in micro-units; a 2-decimal amount is the same number of micro-units times 10^4
    const text = this.v.amounts.formatMicro(BigInt(x) * 10n ** BigInt(6 - decimals));
    // S5: a 0-decimal token (tJPY) has no fraction to show
    return decimals === 0 ? text.replace(/\.0+$/, "") : text;
  }
  private latestTs = async () => Number((await this.pub.getBlock()).timestamp);
  read = (address: Address, abi: unknown, functionName: string, args: unknown[] = [], blockTag: "latest" | "pending" = "latest") => this.pub.readContract({ address, abi, functionName, args, blockTag });
  bal = (token: Address, who: Address) => this.read(token, this.v.abi.TestUSDAbi, "balanceOf", [who]) as Promise<bigint>;
  snap = (vault: Address) => this.read(this.a.lens, this.v.abi.QEDLensAbi, "snapshot", [vault], "pending") as Promise<any>;
  sym = (t: Address) => { const x = getAddress(t); return this.tokenSymbols.get(x)?.symbol ?? (x === this.a.asset ? this.asset.symbol : x === this.a.reserveAsset ? this.reserveAsset.symbol : x === this.a.usd ? "tUSD" : x === this.a.eur ? "tEUR" : "tETH"); };
  /**
   * Human decimal ("22.5") to raw units of an asset (the treasury's unless `decimals` is given), through the release's
   * exact parser: it reads micro-units, and an amount of a 2-decimal asset must be a whole number of paise.
   */
  raw(amount: unknown, what = "Amount", decimals = this.asset.decimals): bigint {
    const s = typeof amount === "string" ? this.v.amounts.scanAmount(amount) : { kind: "invalid" as const };
    if (s.kind !== "valid" || s.raw <= 0n) throw new RailError("invalid_amount", decimals === 6 ? `${what}: use one exact positive decimal with at most six decimals, as a string (for example "22.5").` : `${what}: use one exact positive decimal with at most ${decimals} decimals, as a string (for example "22.5").`, 422);
    const scale = 10n ** BigInt(6 - decimals);
    if (s.raw % scale !== 0n) throw new RailError("invalid_amount", `${what}: ${this.asset.symbol} has ${decimals} decimals; use at most ${decimals} (for example "22.5").`, 422);
    return s.raw / scale;
  }
  /** A whole number of the asset's units, as "1,000" (used in limits messages). */
  whole = (x: bigint, decimals = this.asset.decimals) => (x / 10n ** BigInt(decimals)).toLocaleString("en-US");
  /** The free balance the co-signer keeps in the vault: the release's 5 tUSD, in the units of this vault's asset. */
  get reserveBuffer(): bigint {
    return this.isBaseline ? (this.v.economics.POLICY.reserveBuffer as bigint) : 5n * 10n ** BigInt(this.asset.decimals);
  }
  /** Test seam (off unless QED_RAIL_ALLOW_FAULTS=1): QED_RAIL_FAULT="after-accept" or "after-accept:convert" kills the process there. */
  fault(name: string, kind?: string) {
    if (!this.cfg.allowFaults) return;
    const f = process.env.QED_RAIL_FAULT;
    if (f === name || (kind && f === `${name}:${kind}`)) process.kill(process.pid, "SIGKILL");
  }
  private requireReady() {
    this.host.requireReady();
  }
  private requireProvisioned() {
    this.requireReady();
    if (!this.provisioned) throw new RailError("not_provisioned", "The contracts are deployed but not yet wired. The owner must approve the `provision` proposal first.", 409);
  }
  get provisioned(): boolean {
    return this.store?.meta<boolean>("provisioned") === true;
  }
  /** The ABI of a contract named in an owner action's terms. */
  abiFor = (contract: string): Abi => {
    const A = this.v.abi;
    if (contract.startsWith("QEDVault")) return A.QEDVaultAbi as Abi;
    if (contract.startsWith("QEDExecution")) return A.QEDExecutionAbi as Abi;
    if (contract.startsWith("QEDTreasuryPolicy")) return A.QEDTreasuryPolicyAbi as Abi;
    if (contract.startsWith("TestUSD")) return A.TestUSDAbi as Abi;
    if (contract.startsWith("TestToken")) return A.TestTokenAbi as Abi;
    if (contract.startsWith("ProofEscrow")) return A.ProofEscrowAbi as Abi;
    if (contract.startsWith("QEDDisputeEscrow") && this.host?.disputes) return this.host.disputes.abi;
    if (contract.startsWith("QEDOwnerAccount") && this.owner.kind === "passkey-account") return (this.owner as PasskeyAccountOwner).abi;
    throw new Error(`no ABI for ${contract}`);
  };
  /** The token contract's label in terms ("TestUSD (tUSD)" in the baseline, "TestToken (tINR)" in a workspace). */
  get assetContract() { return this.isBaseline || (this.a?.asset && this.a.usd && getAddress(this.a.asset) === getAddress(this.a.usd)) ? "TestUSD (tUSD)" : `TestToken (${this.asset.symbol})`; }

  // ───────────────────────────── single writer ─────────────────────────────
  /** One operation of this workspace at a time. Shared-chain operations also take the host's writer (dispatch). */
  exclusive<T>(f: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined).finally(() => { this.queued--; });
    return run;
  }

  // ───────────────────────────── budgets: this workspace's, and the host's over all of them ─────────────────────────────
  private budget(cls: QuotaClass) {
    const windowMs = this.cfg.quota.windowSeconds * 1000, now = this.now(), limit = this.cfg.quota[cls];
    const { used, oldest } = this.store.quotaWindow(cls, now - windowMs);
    return { limit, used, now, windowMs, nextFreeAt: used >= limit && oldest !== null ? oldest + windowMs : null };
  }
  /** Refuses (429) when this class's rolling window is spent, here or over all workspaces. Called before any work is done. */
  private requireBudget(cls: QuotaClass) {
    const b = this.budget(cls);
    if (b.used >= b.limit) {
      const s = this.cfg.quota.windowSeconds;
      const span = s === 3600 ? "hour" : s % 3600 === 0 ? `${s / 3600} hours` : s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`;
      const retryAfterSeconds = b.nextFreeAt === null ? s : Math.max(1, Math.ceil((b.nextFreeAt - b.now) / 1000));
      throw new RailError("quota_exceeded", `The rail's budget for ${QUOTA_COUNTS[cls]} is spent: ${b.limit} in any ${span}. Nothing was stored or started${b.limit ? `; the next one is allowed at ${new Date(b.now + retryAfterSeconds * 1000).toISOString()}` : ""}.`, 429, { class: cls, limit: b.limit, used: b.used, windowSeconds: s, retryAfterSeconds, nextFreeAt: b.nextFreeAt === null ? null : new Date(b.nextFreeAt).toISOString() });
    }
    this.host.requireGlobal(cls);
    return b;
  }
  /** Counts one request, here and in the host's budget. Called inside the database transaction that stores what it created. */
  private spend(cls: QuotaClass) {
    const b = this.requireBudget(cls);
    this.store.quotaAdd(cls, b.now, b.now - b.windowMs);
    this.host.spendGlobal(cls);
  }
  quota(): QuotaView {
    this.requireReady();
    return { windowSeconds: this.cfg.quota.windowSeconds, classes: (Object.keys(QUOTA_COUNTS) as QuotaClass[]).map((cls) => { const b = this.budget(cls); return { class: cls, counts: QUOTA_COUNTS[cls], limit: b.limit, used: b.used, remaining: Math.max(0, b.limit - b.used), nextFreeAt: b.nextFreeAt === null ? null : new Date(b.nextFreeAt).toISOString() }; }), global: this.host.globalQuota() };
  }

  // ───────────────────────────── the workspace itself ─────────────────────────────
  view(): WorkspaceView {
    return { ...this.summary, contracts: { ownerAccount: this.a.ownerAccount ?? null, vault: this.a.vault, reserve: this.a.reserve, execution: this.a.exec, treasuryPolicy: this.a.treasuryPolicy }, keys: { agent: this.K.OPERATOR.address, guardian: this.K.GUARDIAN.address, relayer: this.relayer?.address ?? null, derivation: this.isBaseline ? "release development keys from public strings (baseline parity only)" : "HKDF-SHA256 from this installation's master secret (mode 600); none of them is a signer of the owner account" } };
  }

  private vaultView(s: any, address: Address, asset: { symbol: string; decimals: number }, mandateCap: bigint | null): VaultView {
    const cap = mandateCap !== null && mandateCap < s.dailyCap ? mandateCap : s.dailyCap;
    const left = cap > s.spentInWindow ? cap - s.spentInWindow : 0n;
    return ser({ address, token: asset.symbol, decimals: asset.decimals, balance: s.balance, ringFenced: s.protectedBalance, free: s.freeBalance, dailyCap: s.dailyCap, spentInWindow: s.spentInWindow, windowStart: Number(s.windowStart), availableToday: left, worstCaseLoss24h: s.blastRadius24h, worstCaseScope: WORST_CASE_SCOPE, paused: s.paused, epoch: s.epoch, openLiabilities: s.openLiabilities, owner: s.owner, agent: s.agent, cosigner: s.cosigner, guardian: s.guardian });
  }

  activeMandate(): { version: number; hash: Hex; mandate: any; fields: MandateFields; ownerSig: Hex; row: Row } | null {
    const row = this.store.activeMandate();
    if (!row) return null;
    const fields = parse<MandateFields>(row.mandate)!;
    return { version: Number(row.version), hash: row.hash as Hex, mandate: this.toMandate(fields), fields, ownerSig: row.owner_sig as Hex, row };
  }
  toMandate = (f: any) => ({ vault: f.vault, agent: f.agent, payees: f.payees, maxPerPayment: BigInt(f.maxPerPayment), maxPerPeriod: BigInt(f.maxPerPeriod), period: BigInt(f.period), maxTotal: BigInt(f.maxTotal), validFrom: BigInt(f.validFrom), validUntil: BigInt(f.validUntil), epoch: BigInt(f.epoch), requireCosign: f.requireCosign, purpose: f.purpose, salt: f.salt });

  /** Usage of one mandate as the vault would account for it at the next block. */
  async mandateUsage(fields: MandateFields, hash: Hex, snapshot: any) {
    const m = this.toMandate(fields);
    const [spentTotal, spentInPeriodRaw, periodStart, revoked] = (await this.read(this.a.vault, this.v.abi.QEDVaultAbi, "mandateState", [hash])) as [bigint, bigint, bigint, boolean];
    const now = await this.chainNow();
    const periodOpen = now < periodStart + m.period;
    const spentInPeriod = periodOpen ? spentInPeriodRaw : 0n;
    const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
    const active = now >= m.validFrom && now <= m.validUntil;
    return {
      perPayment: { limit: m.maxPerPayment },
      period: { limit: m.maxPerPeriod, spent: spentInPeriod, remaining: sub(m.maxPerPeriod, spentInPeriod), periodStart: Number(periodOpen ? periodStart : 0n), seconds: Number(m.period), note: "Fixed window: it restarts at the first payment after the previous window ended, so up to twice the limit can be spent around a boundary (baseline W-13)." },
      lifetime: { limit: m.maxTotal, spent: spentTotal, remaining: sub(m.maxTotal, spentTotal) },
      validity: { validFrom: Number(m.validFrom), validUntil: Number(m.validUntil), active, secondsLeft: active ? Number(m.validUntil - now) : 0 },
      vaultDaily: { limit: snapshot.dailyCap as bigint, spent: snapshot.spentInWindow as bigint, remaining: sub(snapshot.dailyCap, snapshot.spentInWindow), note: "The vault's own cap over every mandate, in a fixed one-day window." },
      revokedOnChain: revoked,
      epochCurrent: BigInt(snapshot.epoch) === m.epoch,
    };
  }
  async mandateView(row: Row, snapshot: any): Promise<MandateView> {
    const fields = parse<MandateFields>(row.mandate)!;
    const usage = await this.mandateUsage(fields, row.hash as Hex, snapshot);
    let status = row.status as MandateView["status"];
    if (status === "active" && !usage.validity.active && (await this.chainNow()) > BigInt(fields.validUntil)) status = "expired";
    return ser({ version: Number(row.version), hash: row.hash, status, fields, payeeLabels: this.payeeLabels, purposeText: row.purpose_text, signedAt: row.signed_at, approvalId: row.approval_id ?? null, usage });
  }

  async state(): Promise<RailState> {
    const base = { status: this.status, error: this.error, startedAt: this.startedAt, restoredFromState: this.restoredFromState, genesisId: this.genesisId, zkOptional: this.cfg.zk, workspace: this.summary };
    if (this.status !== "ready") throw new RailError(this.status === "starting" ? "rail_starting" : "rail_unavailable", `The local chain is ${this.status}${this.error ? `: ${this.error}` : ""}.`, 503, base);
    const [v, r, block, venues, holdsAsset, holdsReserve] = await Promise.all([this.snap(this.a.vault), this.snap(this.a.reserve), this.pub.getBlock(), this.v.trader.readVenues(this.pub, this.a.exec), this.a.asset ? this.bal(this.a.asset, this.owner.address) : 0n, this.a.reserveAsset ? this.bal(this.a.reserveAsset, this.owner.address) : 0n]);
    const am = this.activeMandate();
    const venueViews: VenueView[] = ser(venues.map((x: any, i: number) => ({ i, label: this.venueLabel(x.pool), pool: x.pool, feeBps: x.feeBps, token0: this.sym(x.token0), token1: this.sym(x.token1), r0: x.r0, r1: x.r1 })));
    return {
      ...base,
      status: "ready",
      network: { chainId: CHAIN_ID, name: this.host.networkLabel, block: block.number.toString(), timestamp: Number(block.timestamp), valueless: true, rpc: "127.0.0.1 (loopback only)" },
      provisioned: this.provisioned,
      clock: reading(Number(block.timestamp), this.now(), this.cfg.maxClockLeadSeconds),
      roles: { owner: this.owner.address, ownerCustody: this.owner.custody, operator: this.K.OPERATOR.address, cosigner: v.cosigner, guardian: v.guardian, attacker: this.isBaseline ? this.K.MALLORY.address : null, creditor: this.K.CLOUDCO.address, cosignerIsolation: this.cosigner.isolation },
      contracts: { vault: this.a.vault, reserve: this.a.reserve, execution: this.a.exec, lens: this.a.lens, tUSD: this.a.usd, tEUR: this.a.eur, tETH: this.a.eth, pools: this.a.pools, treasuryPolicy: this.a.treasuryPolicy, asset: this.a.asset!, reserveAsset: this.a.reserveAsset!, ownerAccount: this.a.ownerAccount ?? null },
      treasury: this.vaultView(v, this.a.vault, this.asset, am ? am.mandate.maxPerPeriod : null),
      reserve: this.vaultView(r, this.a.reserve, this.reserveAsset, null),
      ownerHolds: { asset: holdsAsset.toString(), reserveAsset: holdsReserve.toString() },
      mandate: am ? await this.mandateView(am.row, v) : null,
      policy: await this.policyView(),
      venues: venueViews,
      plannedVenues: venueViews.length ? [] : await this.plannedVenues(),
      lastTrade: this.store.meta<TradeView>("lastTrade"),
    };
  }
  /** A venue is one of the five deployed pools; its label is the release's, whatever its place in the named set. */
  venueLabel = (pool: Address) => this.venueDefs[this.a.pools.indexOf(getAddress(pool))]?.label ?? `venue ${pool}`;
  /** Before the owner has named any venue: the five deployed pools, read directly, as the `provision` proposal lists them. */
  private async plannedVenues(): Promise<VenueView[]> {
    const P = this.v.abi.CPMMPoolAbi, E = this.venueDefs;
    return ser(await Promise.all(this.a.pools.map(async (pool, i) => {
      const [t0, t1, res] = (await Promise.all([this.read(pool, P, "token0"), this.read(pool, P, "token1"), this.read(pool, P, "getReserves")])) as [Address, Address, readonly [bigint, bigint, number]];
      return { i, label: E[i].label, pool, feeBps: E[i].feeBps, token0: this.sym(t0), token1: this.sym(t1), r0: res[0], r1: res[1] };
    })));
  }
  /** The venue set as named on-chain right now, as indices into the five deployed pools (−1 for anything else). */
  async namedVenues(): Promise<number[]> {
    const vs = (await this.read(this.a.exec, this.v.abi.QEDExecutionAbi, "venues")) as readonly { pool: Address }[];
    return vs.map((x) => this.a.pools.indexOf(getAddress(x.pool)));
  }
  /** The Security Lab's six attacks are constructed on the five-venue market of the release (two-hop path, decoy pool). */
  async requireFullVenueSet() {
    const named = await this.namedVenues();
    if (named.length !== this.a.pools.length || named.some((k, i) => k !== i)) throw new RailError("venue_set_changed", "The Security Lab's attacks are built on the five-venue market named at provisioning. The owner has named a different venue set; name the five again to run them.", 409, { named });
  }
  /** Overridden once the standing policy is implemented (rail/policy.ts). */
  policyView: () => Promise<RailState["policy"]> = async () => null;

  /** One limits function for preview and for enforcement: every rule with its usage and what remains. */
  async checkLimits(amount: bigint): Promise<LimitsResult> {
    this.requireReady();
    const s = await this.snap(this.a.vault);
    const am = this.activeMandate();
    const buffer = this.reserveBuffer;
    const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
    const checks: any[] = [{ id: "amount", rule: "Amount is positive and at most 6 decimals", limit: 1n, used: null, remaining: null, pass: amount > 0n }];
    const caps: bigint[] = [];
    if (!this.provisioned) checks.push({ id: "provisioned", rule: "The contracts are wired by the owner", limit: null, used: null, remaining: null, pass: false, detail: "The owner has not approved the provisioning proposal yet." });
    if (!am) {
      checks.push({ id: "mandate-valid", rule: "A signed mandate is active (validity window, not revoked, current epoch)", limit: null, used: null, remaining: null, pass: false, detail: "No active mandate: the owner must sign one." });
      caps.push(0n);
    } else {
      const u = await this.mandateUsage(am.fields, am.hash, s);
      const valid = u.validity.active && !u.revokedOnChain && u.epochCurrent;
      checks.push({ id: "mandate-valid", rule: "A signed mandate is active (validity window, not revoked, current epoch)", limit: null, used: null, remaining: null, pass: valid, detail: valid ? `mandate v${am.version}, valid until ${new Date(u.validity.validUntil * 1000).toISOString()}` : !u.validity.active ? "The mandate's validity window is not open." : u.revokedOnChain ? "The mandate was revoked on-chain." : "The vault's epoch changed: every earlier mandate is void." });
      checks.push({ id: "per-conversion", rule: "Per-conversion limit in the owner's signed mandate", limit: u.perPayment.limit, used: null, remaining: u.perPayment.limit, pass: amount <= u.perPayment.limit });
      checks.push({ id: "mandate-period", rule: "Left in the mandate's current period", limit: u.period.limit, used: u.period.spent, remaining: u.period.remaining, pass: amount <= u.period.remaining });
      checks.push({ id: "mandate-lifetime", rule: "Left in the mandate's lifetime total", limit: u.lifetime.limit, used: u.lifetime.spent, remaining: u.lifetime.remaining, pass: amount <= u.lifetime.remaining });
      caps.push(valid ? u.perPayment.limit : 0n, u.period.remaining, u.lifetime.remaining);
    }
    const dailyLeft = sub(s.dailyCap, s.spentInWindow);
    checks.push({ id: "vault-daily", rule: "Left in today's spending window of the vault", limit: s.dailyCap, used: s.spentInWindow, remaining: dailyLeft, pass: amount <= dailyLeft });
    const spendable = sub(s.freeBalance, buffer);
    checks.push({ id: "free-buffer", rule: `Free treasury balance, keeping the ${this.fmt(buffer)} ${this.asset.symbol} buffer the co-signer requires`, limit: spendable, used: null, remaining: spendable, pass: amount + buffer <= s.freeBalance });
    checks.push({ id: "not-paused", rule: "The treasury vault is not paused", limit: null, used: null, remaining: null, pass: !s.paused, detail: s.paused ? "Paused: only the owner can resume it." : undefined });
    caps.push(dailyLeft, spendable);
    const maximum = s.paused || !this.provisioned ? 0n : caps.reduce((a, b) => (b < a ? b : a));
    return ser({ amount, allowed: checks.every((c) => c.pass), checks, maximum, execution: "none" });
  }
  limits = (amount: unknown) => this.checkLimits(this.raw(amount));
  async maximum(): Promise<{ maximum: Raw; checks: LimitCheck[]; note: string; execution: "none" }> {
    const l = await this.checkLimits(1n);
    return { maximum: l.maximum, checks: l.checks, note: "The largest amount every signed limit, the free balance and the remaining windows allow right now. An authorisation ceiling, not a guaranteed executable quote: liquidity, the co-signer and the execution proof are checked at submission.", execution: "none" };
  }

  planData(tp: any): PlanView {
    return ser({
      expectedOut: tp.plan.sim.amountOut,
      bound: tp.onchainBound,
      gapPpm: tp.plan.gapPpm,
      sweeps: tp.plan.iterations,
      hops: tp.plan.sim.perHop.map((h: any) => ({ venue: h.venue, label: this.venueLabel(tp.venues[h.venue].pool), tokenIn: this.sym(h.tokenIn), tokenOut: this.sym(h.tokenOut), amountIn: h.amountIn, amountOut: h.amountOut })),
      prices: Object.fromEntries(Object.entries(tp.plan.nu).map(([k, x]) => [this.sym(k as Address), x])),
      alternatives: tp.alternatives.map((a: any) => ({ policy: a.policy, description: a.description, amountOut: a.amountOut, shortfallBps: a.shortfallBps, passesFloor: a.passesFloor ?? null })),
    });
  }
  async quote(amountText: unknown): Promise<QuoteResult> {
    this.requireProvisioned();
    const amount = this.raw(amountText);
    const limits = await this.checkLimits(amount);
    const block = await this.pub.getBlock();
    const source = { provider: "QEDExecution.quoteBound and pool reserves on the local Anvil chain", instrument: `${this.asset.symbol} → ${this.reserveAsset.symbol} over the five owner-approved constant-product venues`, priceType: "indicative reading of current pool reserves (not executable, not a public market price)", block: block.number.toString(), sourceTime: Number(block.timestamp), receivedAt: this.iso(), freshness: "current block; rechecked at execution" };
    if (!limits.allowed) return { kind: "indicative", allowed: false, checks: limits.checks, source, execution: "none", notice: "This amount exceeds current signed limits. No quote or transaction was created." };
    const tp = await this.v.trader.planTrade(this.pub, this.a.exec, this.a.asset!, this.a.reserveAsset!, amount);
    return ser({ kind: "indicative", allowed: true, checks: limits.checks, amountIn: amount, expectedOut: tp.plan.sim.amountOut, bound: tp.onchainBound, gapPpm: tp.plan.gapPpm, plan: this.planData(tp), source, execution: "none", notice: "Read-only indicative quote. It is not an offer: it has no floor and no expiry. The executable quote (a floor and a certificate with a validity window) is made only when you approve; live reserves, authorization and certificate are rechecked at execution." });
  }

  history(limit = 40): HistoryEntry[] {
    return this.store.history(Math.min(Math.max(1, limit), 200)).map((r) => ({ n: Number(r.n), at: r.at as string, kind: r.kind as string, title: r.title as string, outcome: r.outcome as HistoryEntry["outcome"], tx: parse<TxBrief>(r.tx) ?? undefined, trade: parse<HistoryEntry["trade"]>(r.trade) ?? undefined, jobId: (r.job_id as string) ?? null }));
  }
  decisions(limit = 50, jobId?: string): DecisionRecord[] {
    return this.store.decisions(Math.min(Math.max(1, limit), 500), jobId).map((r) => ({ n: Number(r.n), at: r.at as string, kind: r.kind as string, jobId: (r.job_id as string) ?? null, verdict: r.verdict as string, clock: parse<ClockReading>(r.clock), approval: parse<Approval>(r.approval), termsHash: (r.terms_hash as string) ?? null, record: parse(r.record), evidenceHash: (r.evidence_hash as string) ?? null, prevHash: r.prev_hash as string, hash: r.hash as string }));
  }
  verifyDecisions = () => this.store.verifyDecisions();
  mandates = async (): Promise<MandateView[]> => { const s = await this.snap(this.a.vault); return Promise.all(this.store.mandates().map((r) => this.mandateView(r, s))); };
  attacks = (): AttackInfo[] => ATTACK_KINDS.map((kind) => ({ kind, ...ATTACKS[kind] }));
  async receipt(hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new RailError("invalid_hash", "A transaction hash is 0x followed by 64 hexadecimal characters.", 422);
    // Only a transaction this workspace recorded is answered: another workspace's hash finds nothing here, even though
    // the shared chain holds it. A receipt from an ephemeral chain is answered from the record; that chain is gone.
    const stored = this.store.receipt(hash);
    if (!stored) throw new RailError("unknown_receipt", "No such transaction in this workspace's records.", 404);
    const ephemeral = typeof stored.network === "string" && stored.network.length > 0;
    let chain: unknown = null;
    if (!ephemeral) try { const r = await this.pub.getTransactionReceipt({ hash }); chain = ser({ status: r.status, block: r.blockNumber, gasUsed: r.gasUsed, from: r.from, to: r.to, logs: r.logs.length }); } catch { chain = null; }
    return { network: ephemeral ? (stored.network as string) : this.host.networkLabel, stored: stored ? { hash: stored.tx_hash, jobId: stored.job_id, status: stored.status, block: stored.block_number, gasUsed: stored.gas_used, from: stored.sender, to: stored.target, error: stored.error_name, errorArgs: parse(stored.error_args), events: parse(stored.events), at: stored.at } : null, chain };
  }

  // ───────────────────────────── proposals ─────────────────────────────
  private proposalView(r: Row): Proposal {
    let status = r.status as Proposal["status"];
    if (status === "open" && Date.parse(r.expires_at as string) < this.now()) status = "expired";
    return { id: r.id as string, kind: r.kind as ProposalKind, status, terms: parse<Record<string, unknown>>(r.terms)!, termsHash: r.terms_hash as string, summary: r.summary as string, allowed: r.allowed === 1, checks: parse<LimitCheck[]>(r.checks) ?? [], createdAt: r.created_at as string, expiresAt: r.expires_at as string, genesisId: r.genesis_id as string, jobId: (r.job_id as string) ?? undefined, network: this.host.networkLabel };
  }
  async propose(req: ProposalRequest): Promise<Proposal> {
    this.requireReady();
    if (!req || typeof req !== "object" || typeof req.kind !== "string") throw new RailError("invalid_request", "Supply { kind, params }.", 422);
    const proposer = this.proposers.get(req.kind);
    if (!proposer) throw new RailError("unsupported_proposal", "Unsupported proposal kind. No arbitrary scripts, destinations or RPC endpoints are accepted.", 422);
    if (req.kind !== "provision") this.requireProvisioned();
    this.requireBudget("proposals");
    const params = req.params && typeof req.params === "object" && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};
    const built = await proposer(params);
    await this.refuseTransferredVault(req.kind, built.terms as Record<string, unknown>);
    const id = randomUUID(), createdAt = this.iso();
    const terms = ser<Record<string, unknown>>(built.terms);
    if (this.owner.needsSignatures) {
      // The passkey signs a digest of exactly these terms' owner calls (the account's execute digest, nonce and deadline
      // fixed now) and the ERC-1271 hash of the mandate or message. termsHash covers toSign.
      const toSign = await this.owner.prepare(terms, { chainId: CHAIN_ID, deadline: BigInt(Math.floor((this.now() + 2 * this.cfg.proposalTtlMs) / 1000)), encodeAction: (a) => encodeOwnerAction(this.abiFor, a), mandateDigest: async (m) => (await this.read(this.a.lens, this.v.abi.QEDLensAbi, "mandateDigest", [this.a.vault, this.toMandate(m)])) as Hex });
      if (toSign.length) terms.toSign = ser(toSign);
    }
    this.store.tx(() => {
      this.spend("proposals");
      if (built.replaces) this.store.cancelOpenProposals(built.replaces);
      this.store.insertProposal({ id, kind: req.kind, params, terms, termsHash: hashTerms(terms), summary: built.summary, allowed: built.allowed, checks: ser(built.checks), createdAt, expiresAt: new Date(this.now() + this.cfg.proposalTtlMs).toISOString(), genesisId: this.genesisId! });
    });
    return this.proposalView(this.store.proposal(id)!);
  }
  /**
   * R13 S5: once a transfer of ownership has completed, this workspace's passkeys no longer control its vaults. An owner
   * action on either vault is refused before anything is signed, rather than reverting on the chain (NotOwner).
   */
  private async refuseTransferredVault(kind: string, terms: Record<string, unknown>): Promise<void> {
    if (kind === "provision" || this.owner.kind !== "passkey-account" || !this.a?.vault) return;
    const acts = (terms.actions as OwnerAction[] | undefined) ?? [];
    for (const v of [this.a.vault, this.a.reserve].filter(Boolean).map((x) => getAddress(x as string))) {
      if (!acts.some((x) => getAddress(x.to) === v)) continue;
      const ownerNow = getAddress((await this.read(v, this.v.abi.QEDVaultAbi, "owner")) as string);
      if (ownerNow !== this.owner.address) throw new RailError("vault_transferred", `This vault (${v.slice(0, 10)}…) now belongs to ${ownerNow.slice(0, 10)}…: its transfer of ownership was accepted, and this workspace's passkeys no longer control it. Nothing was prepared.`, 409);
    }
  }
  proposal(id: string): Proposal {
    const r = this.store.proposal(id);
    if (!r) throw new RailError("unknown_proposal", "Unknown proposal.", 404);
    return this.proposalView(r);
  }
  cancelProposal(id: string): Proposal {
    const p = this.proposal(id);
    if (p.status === "open") this.store.setProposalStatus(id, "cancelled");
    return this.proposal(id);
  }

  // ───────────────────────────── jobs and idempotency ─────────────────────────────
  private checkKey(key: unknown): string {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new RailError("idempotency_key_required", "Every state-changing request needs an Idempotency-Key: 8 to 128 characters of letters, digits, dot, underscore, colon or hyphen (a UUID is fine).", 400);
    return key;
  }
  /** Accepts a request durably and exactly once. Runs nothing itself; the job is queued after the commit. */
  private accept(kind: JobKind, request: unknown, keyIn: unknown, proposalId: string | null, approvalIn: unknown): Accepted {
    this.requireReady();
    const key = this.checkKey(keyIn);
    const fingerprint = sha(canonicalTerms([kind, proposalId, request ?? null, approvalIn ?? null]));
    const at = this.iso();
    const out = this.store.tx((): Accepted => {
      const prev = this.store.submission(key);
      if (prev) {
        if (prev.fingerprint !== fingerprint) throw new RailError("idempotency_conflict", "That Idempotency-Key was already used for a different request. No new job was started.", 409, { jobId: prev.job_id });
        const j = this.store.job(prev.job_id as string)!;
        return { jobId: j.id as string, kind: j.kind as JobKind, status: j.status as Job["status"], duplicate: true };
      }
      // A new request: the writer's queue is bounded, and the rail's budget must have room. Both refuse before anything is stored.
      if (!this.unqueued.has(kind) && this.queued >= this.cfg.maxQueued) throw new RailError("busy", "The rail is busy with other operations; try again shortly.", 429, { waiting: this.queued, limit: this.cfg.maxQueued });
      if (!this.unqueued.has(kind) && !OFF_SHARED_CHAIN.has(kind) && this.host.writerQueued >= this.cfg.maxQueuedGlobal) throw new RailError("busy", "The shared chain's writer is busy with other workspaces' operations; try again shortly.", 429, { scope: "global", waiting: this.host.writerQueued, limit: this.cfg.maxQueuedGlobal });
      const cls: QuotaClass = kind === "economy" ? "economies" : "operations";
      this.requireBudget(cls);
      let approval: Approval | null = null;
      if (proposalId) {
        const p = this.store.proposal(proposalId);
        if (!p) throw new RailError("unknown_proposal", "Unknown proposal.", 404);
        if (p.status === "used") throw new RailError("proposal_used", "This proposal was already submitted. Recover its original job; do not repeat it.", 409, { jobId: p.job_id });
        if (p.status === "cancelled") throw new RailError("proposal_cancelled", "This proposal was cancelled or replaced. Prepare and review a new one.", 409);
        if (Date.parse(p.expires_at as string) < this.now()) throw new RailError("proposal_expired", "Proposal expired. Prepare it again against current chain state.", 409);
        if (p.genesis_id !== this.genesisId) throw new RailError("proposal_stale", "The chain was re-created since this proposal. Prepare and review a new proposal.", 409);
        const pt = parse<Record<string, unknown>>(p.terms)!;
        approval = checkApproval(approvalIn, pt, { notBeforeMs: Date.parse(p.created_at as string), notAfterMs: Date.parse(p.expires_at as string), nowMs: this.now(), signatures: this.signatureMode(pt) });
        if (this.store.approvalUse(approval.approvalId)) throw new RailError("approval_replayed", "This approval was already used. An approval authorises one proposal once.", 409);
      }
      const jobId = randomUUID();
      this.spend(cls);
      this.store.insertJob({ id: jobId, kind, request, proposalId, approval, createdAt: at });
      this.store.insertSubmission(key, fingerprint, jobId, at);
      if (proposalId && approval) {
        this.store.setProposalStatus(proposalId, "used", jobId);
        this.store.insertApproval(approval.approvalId, proposalId, jobId, approval, at);
      }
      return { jobId, kind, status: "accepted", duplicate: false };
    });
    if (!out.duplicate) {
      this.fault("after-accept", kind);
      this.dispatch(out.jobId, kind);
    }
    return out;
  }
  /** Kinds that never touch the rail's own chain (scripted economies run on their own Anvil) do not wait for the writer. */
  readonly unqueued = new Set<JobKind>();
  private dispatch(jobId: string, kind: JobKind) {
    if (this.unqueued.has(kind)) void this.runJob(jobId).catch(() => undefined);
    // an ephemeral-chain run holds only this workspace's lane: every other workspace keeps using the shared chain
    else if (OFF_SHARED_CHAIN.has(kind)) void this.exclusive(() => this.runJob(jobId)).catch(() => undefined);
    else void this.exclusive(() => this.host.writer(() => this.runJob(jobId))).catch(() => undefined);
  }
  /** "required" when the owner is a passkey account and the terms list what it must sign; otherwise the five-field rule. */
  private signatureMode(terms: Record<string, unknown>): "required" | "forbidden" {
    return this.owner.needsSignatures && Array.isArray(terms.toSign) && terms.toSign.length > 0 ? "required" : "forbidden";
  }

  /** Owner- or guardian-authorised operations: a reviewed proposal plus an approval bound to its exact terms. */
  execute(proposalId: string, approval: unknown, idempotencyKey: unknown): Accepted {
    const p = this.store.proposal(proposalId);
    if (!p) throw new RailError("unknown_proposal", "Unknown proposal.", 404);
    try {
      return this.accept(p.kind as JobKind, { proposalId }, idempotencyKey, proposalId, approval);
    } catch (e) {
      if (e instanceof ApprovalError) {
        this.store.appendDecision({ at: this.iso(), kind: "approval-refused", jobId: null, verdict: "REFUSED", termsHash: p.terms_hash as string, record: { proposalId, kind: p.kind, code: e.code, reason: e.message, details: e.details } });
        throw new RailError(e.code, e.message, e.code === "approval_required" || e.code === "approval_malformed" ? 422 : 409, e.details);
      }
      throw e;
    }
  }
  /**
   * The same, for a passkey-owned workspace: before anything is stored, the approval's passkey signatures are checked
   * on chain against the owner account (a simulated execute, and isValidSignature). A signature the account would
   * refuse is answered 409 or 422 and stores nothing, so the key stays free; the refusal is in the decision records.
   * A request repeated under a key that was already accepted returns the original job, as execute() does.
   */
  async executeChecked(proposalId: string, approval: unknown, idempotencyKey: unknown): Promise<Accepted> {
    const p = this.store.proposal(proposalId);
    if (!p) throw new RailError("unknown_proposal", "Unknown proposal.", 404);
    const terms = parse<Record<string, unknown>>(p.terms)!;
    const prior = typeof idempotencyKey === "string" ? this.store.submission(idempotencyKey) : undefined;
    if (!prior && this.signatureMode(terms) === "required" && p.status === "open") {
      const refuse = (code: string, message: string, details: Record<string, unknown>) => this.store.appendDecision({ at: this.iso(), kind: "approval-refused", jobId: null, verdict: "REFUSED", termsHash: p.terms_hash as string, record: { proposalId, kind: p.kind, code, reason: message, details } });
      let a: Approval;
      try {
        a = checkApproval(approval, terms, { notBeforeMs: Date.parse(p.created_at as string), notAfterMs: Date.parse(p.expires_at as string), nowMs: this.now(), signatures: "required" });
      } catch (e) {
        if (e instanceof ApprovalError) { refuse(e.code, e.message, e.details); throw new RailError(e.code, e.message, e.code === "approval_required" || e.code === "approval_malformed" || e.code === "approval_signature_missing" ? 422 : 409, e.details); }
        throw e;
      }
      try {
        await this.owner.verify(terms, a);
      } catch (e) {
        if (e instanceof OwnerAuthorityError) { refuse(e.code, e.message, e.details); throw new RailError(e.code, e.message, e.http, e.details); }
        throw e;
      }
    }
    return this.execute(proposalId, approval, idempotencyKey);
  }
  /** Automation without a principal's signature (policy ticks, scripted economies): idempotency key only. */
  submit(kind: JobKind, request: unknown, idempotencyKey: unknown): Accepted {
    if (!this.handlers.has(kind)) throw new RailError("unsupported_operation", "Unsupported operation.", 404);
    return this.accept(kind, request, idempotencyKey, null, null);
  }

  private jobView(r: Row): Job {
    const steps: Step[] = this.store.steps(r.id as string).map((s) => ({ seq: Number(s.seq), key: s.key as string, label: s.label as string, status: s.status as StepStatus, detail: s.detail as string, data: parse<Record<string, unknown>>(s.data) ?? undefined, at: s.at as string }));
    const depth = parse<Job["confirmations"]>(r.depth) ?? undefined;
    return { id: r.id as string, kind: r.kind as JobKind, status: r.status as Job["status"], createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null, finishedAt: (r.finished_at as string) ?? null, proposalId: (r.proposal_id as string) ?? null, steps, result: parse<OpResult>(r.result), error: (r.error as string) ?? null, guidance: (r.guidance as string) ?? undefined, network: this.host.networkLabel, ...(depth ? { confirmations: depth } : {}) };
  }
  job(id: string): Job {
    const r = this.store.job(id);
    if (!r) throw new RailError("unknown_job", "Unknown job.", 404);
    return this.jobView(r);
  }
  jobs = (limit = 30): Job[] => this.store.jobs(Math.min(Math.max(1, limit), 200)).map((r) => this.jobView(r));
  /** Recovery by lookup: which job did this key start? Never a reason to send anything again. */
  submission(key: string): { jobId: string; kind: JobKind; status: Job["status"] } {
    const s = this.store.submission(key);
    if (!s) throw new RailError("unknown_submission", "No accepted submission is stored under this key. Nothing was started for it; it is safe to submit it.", 404);
    const j = this.store.job(s.job_id as string)!;
    return { jobId: j.id as string, kind: j.kind as JobKind, status: j.status as Job["status"] };
  }
  waitForJob(id: string, timeoutMs = 120_000): Promise<Job> {
    const j = this.job(id);
    if (["done", "failed", "interrupted", "reorged"].includes(j.status)) return Promise.resolve(j);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`job ${id} did not finish within ${timeoutMs} ms`)), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push((done) => { clearTimeout(t); resolve(done); });
      this.waiters.set(id, list);
    });
  }
  /** Step stream for one job: past steps first, then live ones, then { done: true }. Returns an unsubscribe. */
  subscribe(id: string, f: (s: Step | { done: true }) => void): () => void {
    const j = this.job(id);
    for (const s of j.steps) f(s);
    if (["done", "failed", "interrupted", "reorged"].includes(j.status)) { f({ done: true }); return () => {}; }
    const set = this.listeners.get(id) ?? new Set();
    set.add(f);
    this.listeners.set(id, set);
    return () => set.delete(f);
  }
  private settle(id: string) {
    const j = this.job(id);
    for (const w of this.waiters.get(id) ?? []) w(j);
    this.waiters.delete(id);
    for (const f of this.listeners.get(id) ?? []) f({ done: true });
    this.listeners.delete(id);
  }

  private async runJob(jobId: string): Promise<void> {
    const row = this.store.job(jobId);
    if (!row || row.status !== "accepted") return;
    const kind = row.kind as JobKind;
    const proposal = row.proposal_id ? this.proposalView(this.store.proposal(row.proposal_id as string)!) : null;
    let seq = this.store.steps(jobId).length;
    const emit = (n: number, s: { key: string; label: string; status: StepStatus; detail: string; data?: Record<string, unknown> }) => {
      const step: Step = { seq: n, ...s, at: this.iso() };
      this.store.putStep(jobId, n, step);
      for (const f of this.listeners.get(jobId) ?? []) f(step);
    };
    const ctx: Ctx = {
      jobId, kind, request: parse(row.request), proposal, terms: proposal?.terms ?? null, approval: parse<Approval>(row.approval),
      window: proposal ? { notBeforeMs: Date.parse(proposal.createdAt), notAfterMs: Date.parse(proposal.expiresAt), nowMs: Date.parse(parse<Approval>(row.approval)?.confirmedAt ?? proposal.createdAt) } : { notBeforeMs: 0, notAfterMs: 0, nowMs: 0 },
      clock: null,
      push: (s) => { emit(seq, s); return seq++; },
      replace: (n, s) => emit(n, s),
    };
    this.store.startJob(jobId, this.iso());
    let status: Job["status"] = "done", result: OpResult | null = null, error: string | null = null, guidance: string | null = null;
    try {
      const handler = this.handlers.get(kind);
      if (!handler) throw new RailError("unsupported_operation", "Unsupported operation.", 404);
      if (this.now() - Date.parse(row.created_at as string) > this.cfg.proposalTtlMs * 2) throw new RailError("stale_job", "This request was accepted too long ago to be started safely. Nothing was signed or sent; prepare it again.", 409);
      result = await handler(ctx);
      if (result.doNotRetry) guidance = "The transaction was mined but the balances did not reconcile. Do not retry; inspect the receipt.";
    } catch (e) {
      status = "failed";
      error = publicError(e);
      const mined = this.store.attempts(jobId).some((a) => a.tx_hash);
      guidance = mined ? "A transaction was broadcast for this operation. Inspect its receipt before taking another action; do not submit it again." : "Nothing was mined for this operation. No money moved.";
      this.store.appendHistory({ at: this.iso(), kind: String(kind), title: `${kind} did not complete: ${error}`, outcome: "error", jobId });
    }
    // R7-036: a job is reported done only once every transaction it sent on the shared chain has the stated confirmations.
    // The depth is measured (and, on the local chain, the empty blocks it needs mined) before the state is saved.
    let held: Job["status"] | null = null;
    if (status === "done" && this.store.sharedMined(jobId).length) {
      const d = await this.depth(jobId, true).catch(() => null);
      if (!d || d.missing.length || d.have < d.need) held = "confirming";
      this.store.setDepth(jobId, { have: d && !d.missing.length ? d.have : 0, need: this.cfg.confirmations, block: d?.block ?? null });
    }
    try { if (!this.unqueued.has(kind) && !OFF_SHARED_CHAIN.has(kind)) await this.checkpoint(); } catch (e) { if (status === "done") { status = "failed"; held = null; error = `The operation finished but the chain state could not be saved: ${publicError(e)}`; guidance = "Do not retry; the service must be checked."; } }
    this.fault("before-done", kind);
    this.store.finishJob(jobId, held ?? status, this.iso(), result, error, guidance);
    // a job waiting for its confirmations is not finished: its waiters are answered when the heartbeat's check
    // (reconcileChain) finds it deep enough, or finds its transaction gone
    if (!held) this.settle(jobId);
  }

  /**
   * R7-036: how deep this job's transactions on the shared chain are: the shallowest of them, against the depth a job
   * needs. A transaction the chain no longer holds is `missing` (a reorganisation replaced its block). With `mine`, on the
   * local chain, the empty blocks the depth still needs are mined first (rail/config.ts confirmMining).
   */
  private async depth(jobId: string, mine: boolean): Promise<{ need: number; have: number; block: string | null; missing: Row[] }> {
    const need = this.cfg.confirmations, rows = this.store.sharedMined(jobId);
    const measure = async () => {
      // uncached: viem keeps a block number for seconds, and a depth must be measured against the chain as it is now
      const latest = BigInt(await this.pub.getBlockNumber({ cacheTime: 0 }));
      let have = Number.MAX_SAFE_INTEGER, block: string | null = null;
      const missing: Row[] = [];
      for (const a of rows) {
        const r = await this.receiptOf(a.tx_hash as Hex);
        if (!r) { missing.push(a); continue; }
        const c = Number(latest - BigInt(r.blockNumber) + 1n);
        if (c < have) { have = c; block = r.blockNumber.toString(); }
      }
      return { need, have: rows.length && have !== Number.MAX_SAFE_INTEGER ? have : missing.length ? 0 : need, block, missing };
    };
    let d = await measure();
    if (mine && this.cfg.confirmMining && !d.missing.length && d.have < d.need) {
      for (let k = d.have; k < d.need; k++) if (!(await this.mineOne())) break;
      d = await measure();
    }
    return d;
  }
  /** A receipt, or null when the chain holds no such transaction. Any other failure (the chain not answering) is thrown. */
  private async receiptOf(hash: Hex): Promise<any | null> {
    try { return await this.pub.getTransactionReceipt({ hash }); } catch (e) {
      if ((e as Error)?.name === "TransactionReceiptNotFoundError" || /could not be found|not found/i.test(String((e as Error)?.message))) return null;
      throw e;
    }
  }
  /**
   * One empty block: the local chain's next block, so that a transaction can gain its confirmations on a quiet chain.
   * Anvil stamps it with its own clock and gives blocks mined within one second the same time (checked on Anvil 1.7.1),
   * so mining never takes the chain's clock ahead of the wall clock (transactions are refused beyond maxClockLeadSeconds).
   */
  private async mineOne(): Promise<boolean> {
    await this.rpc("evm_mine", []);
    return true;
  }
  /**
   * R7-036: a job waiting for its confirmations is done once its transactions are deep enough; if one of them is gone first
   * (a reorganisation replaced its block), it is "reorged", never done. Returns what it is now.
   */
  private async confirmJob(jobId: string): Promise<"done" | "reorged" | "confirming"> {
    const d = await this.depth(jobId, true);
    const row = this.store.job(jobId);
    if (!row || row.status !== "confirming") return row?.status === "done" ? "done" : "reorged";
    if (d.missing.length) {
      for (const a of d.missing) if (a.status !== "replaced") this.store.updateAttempt(Number(a.id), { status: "replaced", at: this.iso() });
      const hash = String(d.missing[0]!.tx_hash);
      if (this.store.endConfirming(jobId, "reorged", this.iso(), `A chain reorganisation replaced the block that held this operation's transaction (${hash}) before it had ${d.need} confirmations. It was never done.`, "Nothing was sent again. Check the state, and if you still want this, prepare and confirm a new request; this one will not run again.")) {
        this.store.appendHistory({ at: this.iso(), kind: String(row.kind), title: `${String(row.kind)} was undone by a chain reorganisation before it had ${d.need} confirmations: its transaction ${hash} is no longer on the chain; it was never reported done and nothing was re-sent`, outcome: "reorged", tx: { hash }, jobId });
        this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "REPLACED", record: { tx: hash, wasInBlock: d.missing[0]!.block_number, jobWas: "confirming", confirmationsNeeded: d.need } });
        this.store.setDepth(jobId, { have: 0, need: d.need, block: d.block });
        this.settle(jobId);
      }
      return "reorged";
    }
    this.store.setDepth(jobId, { have: d.have, need: d.need, block: d.block });
    if (d.have < d.need) return "confirming";
    if (this.store.endConfirming(jobId, "done", this.iso(), null, null)) this.settle(jobId);
    return "done";
  }

  private reconciling: Promise<unknown> | null = null;
  private reconcileAt = 0;
  /**
   * Checks the transactions this workspace recorded as mined on the shared chain against the chain as it is now. A
   * reorganisation can replace the block that held one. Then the attempt is marked replaced and the job becomes "reorged":
   * not done (R7-036: a job still waiting for its confirmations is never reported done), and never sent again by the rail
   * (its Idempotency-Key still names it, so a retry finds this job, not a second transaction). If the same transaction is
   * mined again in a later block, the job waits for its confirmations again and is then done, with the new block. Every
   * change is written to the history and the decision chain.
   *
   * Transactions sent on an ephemeral chain (a Security Lab attack, a scenario) are never checked: that chain was
   * destroyed after its run, so they are never on the shared chain and never were (R13: they were, and those jobs were
   * marked "reorged" with a false history line).
   *
   * Runs on the host's heartbeat: jobs waiting for their confirmations on every call, the full check at most every
   * `everyMs`; `force` runs the full check now. One check runs at a time: a forced call waits for one already running and
   * then runs itself, so it never reports "nothing changed" for a check it did not run (R13: the heartbeat's check could
   * take the work while a forced call returned zeros, which made the reorganisation test flaky).
   */
  async reconcileChain(opts: { force?: boolean; everyMs?: number; limit?: number } = {}): Promise<{ checked: number; replaced: number; restored: number; moved: number; confirmed: number }> {
    while (this.reconciling) {
      if (!opts.force) return { checked: 0, replaced: 0, restored: 0, moved: 0, confirmed: 0 };
      await this.reconciling.catch(() => undefined);
    }
    const run = this.reconcileOnce(opts);
    this.reconciling = run;
    try { return await run; } finally { if (this.reconciling === run) this.reconciling = null; }
  }
  private async reconcileOnce(opts: { force?: boolean; everyMs?: number; limit?: number }): Promise<{ checked: number; replaced: number; restored: number; moved: number; confirmed: number }> {
    const out = { checked: 0, replaced: 0, restored: 0, moved: 0, confirmed: 0 };
    // R7-036: the jobs waiting for their confirmations, at every heartbeat
    for (const j of this.store.jobsByStatus("confirming")) {
      const now = await this.confirmJob(j.id as string).catch(() => "confirming" as const);
      if (now === "done") out.confirmed++;
      else if (now === "reorged") out.replaced++;
    }
    if (!opts.force && this.now() - this.reconcileAt < (opts.everyMs ?? 10_000)) return out;
    this.reconcileAt = this.now();
    for (const a of this.store.minedAttempts(opts.limit ?? 50)) {
      const hash = a.tx_hash as Hex, jobId = a.job_id as string, status = this.store.job(jobId)?.status as string;
      const r = await this.receiptOf(hash);
      out.checked++;
      if (!r) {
        if (a.status === "replaced") continue;
        this.store.updateAttempt(Number(a.id), { status: "replaced", at: this.iso() });
        out.replaced++;
        if (status === "done") {
          this.store.setJobStatus(jobId, "reorged", `A chain reorganisation replaced the block that held this operation's transaction (${hash}). It is not done.`, "Nothing was sent again. Check the state, and if you still want this, prepare and confirm a new request; this one will not run again.");
          this.store.appendHistory({ at: this.iso(), kind: String(a.job_kind), title: `${String(a.job_kind)} was undone by a chain reorganisation: its transaction ${hash} is no longer on the chain; nothing was re-sent`, outcome: "reorged", tx: { hash }, jobId });
          this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "REPLACED", record: { tx: hash, wasInBlock: a.block_number, jobWas: status } });
          this.settle(jobId);
        } else if (status === "confirming") {
          await this.confirmJob(jobId); // ends it as reorged, never done, with its own history line and decision
        } else this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "REPLACED", record: { tx: hash, wasInBlock: a.block_number, jobWas: status } });
        continue;
      }
      if (a.status === "replaced") {
        this.store.updateAttempt(Number(a.id), { status: r.status === "success" ? "mined-success" : "mined-revert", blockNumber: r.blockNumber.toString(), at: this.iso() });
        out.restored++;
        this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "RESTORED", record: { tx: hash, nowInBlock: r.blockNumber.toString() } });
        if (status === "reorged" && r.status === "success") {
          // mined again: done again once it has its confirmations, with the new block
          this.store.setJobStatus(jobId, "confirming", null, `The transaction was mined again after the reorganisation; nothing was sent twice. It is reported done once it has ${this.cfg.confirmations} confirmations.`);
          this.store.appendHistory({ at: this.iso(), kind: String(a.job_kind), title: `${String(a.job_kind)}: transaction ${hash} is on the chain again, in block ${r.blockNumber}`, outcome: "executed", tx: { hash, block: r.blockNumber.toString() }, jobId });
          if ((await this.confirmJob(jobId)) === "done") out.confirmed++;
        }
      } else if (String(a.block_number) !== r.blockNumber.toString()) {
        // the transaction survived, in another block: the record follows the chain
        this.store.updateAttempt(Number(a.id), { status: a.status as string, blockNumber: r.blockNumber.toString(), at: this.iso() });
        out.moved++;
        this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "MOVED", record: { tx: hash, was: a.block_number, now: r.blockNumber.toString() } });
      }
    }
    return out;
  }

  /**
   * Before R13 the reorganisation check also looked for ephemeral chains' transactions on the shared chain, did not find
   * them, and marked their attempts replaced and their jobs "reorged", with a history line saying a reorganisation undid
   * them. None was: each ran on its own chain, as its receipt says. Each such attempt is put back to its receipt's state;
   * a job it alone made "reorged" is put back to done, and the history and the decision chain say why (append-only:
   * the false line stays, followed by its correction). Runs at start; finds nothing the second time.
   */
  private repairEphemeralReorgs(): number {
    let fixed = 0;
    for (const a of this.store.ephemeralReplaced()) {
      const jobId = a.job_id as string, hash = a.tx_hash as string;
      this.store.updateAttempt(Number(a.id), { status: a.receipt_status === "reverted" ? "mined-revert" : "mined-success", at: this.iso() });
      const sharedGone = this.store.sharedMined(jobId).some((x) => x.status === "replaced");
      if (a.job_status === "reorged" && !sharedGone) {
        // back to done; a job that also sent transactions on the shared chain is reported done only after their confirmations
        this.store.setJobStatus(jobId, this.store.sharedMined(jobId).length ? "confirming" : "done", null, null);
        this.store.appendHistory({ at: this.iso(), kind: String(a.job_kind), title: `Correction: ${String(a.job_kind)} was not undone by a reorganisation. Its transaction ${hash} ran on the run's own ephemeral chain (${String(a.network)}), which the reorganisation check should never have read; the earlier line saying otherwise was wrong`, outcome: "no-action", tx: { hash }, jobId });
        fixed++;
      }
      this.store.appendDecision({ at: this.iso(), kind: "reorg", jobId, verdict: "CORRECTED", record: { tx: hash, network: a.network, reason: "an ephemeral chain's transaction was looked for on the shared chain (fixed in R13); it was never replaced" } });
    }
    return fixed;
  }

  /** After a restart: start what was accepted but never started; resolve what was running by lookup only. */
  async recoverJobs(): Promise<void> {
    this.repairEphemeralReorgs();
    for (const r of this.store.jobsByStatus("running")) {
      const id = r.id as string, kind = r.kind as JobKind;
      if (this.rerunnable.has(kind)) {
        this.store.db.prepare("UPDATE jobs SET status = 'accepted' WHERE id = ?").run(id);
        this.store.putStep(id, this.store.steps(id).length, { key: "recovery", label: "Resumed after a restart", status: "info", detail: "The service stopped while this operation ran. Each of its steps checks the chain before acting, so it is completed now without repeating anything already done.", at: this.iso() });
        this.dispatch(id, kind);
        continue;
      }
      const out = await (this.recoverers.get(kind) ?? (async () => null))(r).catch(() => null);
      const seqN = this.store.steps(id).length;
      if (out) {
        this.store.putStep(id, seqN, { key: "recovery", label: "Recovered by lookup after a restart", status: "ok", detail: "The service stopped while this operation ran. Its transaction was found on the restored chain; nothing was sent again.", at: this.iso() });
        // R7-036: done once its transaction has its confirmations, as for any job
        const mined = this.store.sharedMined(id).length > 0, d = mined ? await this.depth(id, true).catch(() => null) : null;
        if (mined) this.store.setDepth(id, { have: d && !d.missing.length ? d.have : 0, need: this.cfg.confirmations, block: d?.block ?? null });
        this.store.finishJob(id, mined && (!d || d.missing.length || d.have < d.need) ? "confirming" : "done", this.iso(), out, null, "Recovered by lookup after a restart; nothing was re-sent.");
      } else {
        this.store.putStep(id, seqN, { key: "recovery", label: "Interrupted by a restart", status: "info", detail: "The service stopped while this operation ran. The restored chain holds no transaction for it, so nothing moved. It was not sent again.", at: this.iso() });
        this.store.finishJob(id, "interrupted", this.iso(), null, "The service stopped during this operation and the restored chain does not contain it.", "Nothing moved. If you still want this, prepare and confirm a new request; the old one will not run.");
        this.store.appendHistory({ at: this.iso(), kind: String(kind), title: `${kind} was interrupted by a restart; nothing was mined and nothing was re-sent`, outcome: "no-action", jobId: id });
      }
      if (this.store.job(id)?.status !== "confirming") this.settle(id);
    }
    for (const r of this.store.jobsByStatus("accepted")) this.dispatch(r.id as string, r.kind as JobKind);
  }
  /** Per-kind lookup of an interrupted job on the restored chain. Returns its result, or null if nothing was mined. */
  readonly recoverers = new Map<JobKind, (job: Row) => Promise<OpResult | null>>([["convert", (job) => this.lookupTrade(job, "conversion")]]);
  /**
   * Did this job's trade happen on the restored chain? Decided from the certificate's single-use intent id, which
   * was journaled before submission: the vault marks it used, and QEDExecution indexed it in BestExecution.
   */
  async lookupTrade(job: Row, historyKind: string): Promise<OpResult | null> {
    const found: any[] = [];
    for (const a of this.store.attempts(job.id as string)) {
      if (!a.intent_id || a.purpose !== "trade") continue;
      if (!((await this.read(this.a.vault, this.v.abi.QEDVaultAbi, "intentUsed", [a.intent_id])) as boolean)) { this.store.updateAttempt(Number(a.id), { status: "absent", at: this.iso() }); continue; }
      const logs = await this.pub.getContractEvents({ address: this.a.exec, abi: this.v.abi.QEDExecutionAbi, eventName: "BestExecution", args: { intentId: a.intent_id }, fromBlock: BigInt(this.a.deployBlock) });
      if (!logs.length) continue;
      const r = await this.pub.getTransactionReceipt({ hash: logs[0].transactionHash });
      const tx = this.c.toResult(r, a.sender);
      this.store.updateAttempt(Number(a.id), { status: "mined-success", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), at: this.iso() });
      this.saveReceipt(job.id as string, tx);
      found.push({ tx, args: logs[0].args });
    }
    if (!found.length) return null;
    const last = found[found.length - 1], amountIn = BigInt(last.args.amountIn), out = BigInt(last.args.amountOut), bound = BigInt(last.args.bound);
    const summary = `Converted ${this.fmt(amountIn)} ${this.asset.symbol} → ${this.fmtR(out)} ${this.reserveAsset.symbol}; bound ${this.fmtR(bound)} (found on the restored chain after a restart; not sent again).`;
    // The job may have written its own history line before the service stopped: one conversion, one line.
    const known = this.store.historyForJob(job.id as string).some((h) => parse<TxBrief>(h.tx)?.hash === last.tx.hash);
    if (!known) this.store.appendHistory({ at: this.iso(), kind: historyKind, title: summary, outcome: "executed", tx: this.txBrief(last.tx), trade: { amountIn: amountIn.toString(), amountOut: out.toString(), bound: bound.toString(), gapPpm: ppm(out, bound), hops: Number(last.args.hops), venues: [] }, jobId: job.id as string });
    return { outcome: "executed", summary, tx: this.txBrief(last.tx), evidence: { recovered: true, minedTrades: found.length, amountIn: amountIn.toString(), amountOut: out.toString(), bound: bound.toString() } };
  }
  /**
   * Did this job's decisive transaction happen on the restored chain? Decided from the attempt journal: the hash is
   * written at broadcast, before the receipt is awaited, so a transaction the restored chain holds is always found
   * and one it does not hold was never part of the durable state. `purpose` names the attempt that moves the money.
   */
  async lookupSent(job: Row, purpose: string, historyKind: string, what: string): Promise<OpResult | null> {
    for (const a of this.store.attempts(job.id as string).reverse()) {
      if (a.purpose !== purpose || !a.tx_hash) continue;
      const r = await this.pub.getTransactionReceipt({ hash: a.tx_hash }).catch(() => null);
      if (!r) { this.store.updateAttempt(Number(a.id), { status: "absent", at: this.iso() }); continue; }
      if (r.status !== "success") continue;
      const tx = this.c.toResult(r, a.sender);
      this.store.updateAttempt(Number(a.id), { status: "mined-success", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), at: this.iso() });
      this.saveReceipt(job.id as string, tx);
      const summary = `${what}: transaction ${tx.hash} was found on the restored chain after a restart; it was not sent again.`;
      const known = this.store.historyForJob(job.id as string).some((h) => parse<TxBrief>(h.tx)?.hash === tx.hash);
      if (!known) this.store.appendHistory({ at: this.iso(), kind: historyKind, title: summary, outcome: "executed", tx: this.txBrief(tx), jobId: job.id as string });
      return { outcome: "executed", summary, tx: this.txBrief(tx), evidence: { recovered: true } };
    }
    return null;
  }

  // ───────────────────────────── journaled sending ─────────────────────────────
  txBrief = (tx: any): TxBrief => ({ hash: tx.hash, status: tx.status, block: tx.blockNumber.toString(), gasUsed: tx.gasUsed.toString(), ...(tx.error ? { error: tx.error.name } : {}) });
  txData = (tx: any) => ser({ hash: tx.hash, status: tx.status, block: tx.blockNumber, gasUsed: tx.gasUsed, from: tx.from, to: tx.to, error: tx.error?.name ?? null, errorArgs: tx.error?.args ?? null, events: tx.events.map((e: any) => ({ name: e.name, args: e.args })) });
  /** `network` names an ephemeral chain for a receipt that is not on the shared chain (null: the shared chain). */
  saveReceipt(jobId: string | null, tx: any, network: string | null = null) {
    this.store.insertReceipt({ txHash: tx.hash, jobId, status: tx.status, blockNumber: tx.blockNumber.toString(), gasUsed: tx.gasUsed.toString(), sender: tx.from, target: tx.to, errorName: tx.error?.name ?? null, errorArgs: ser(tx.error?.args ?? null), events: ser(tx.events.map((e: any) => ({ name: e.name, address: e.address, args: e.args }))), at: this.iso(), network });
  }
  /**
   * Sends one transaction with a durable attempt record written BEFORE submission and a terminal state after
   * (baseline W-21). `expectRevert` mines a transaction that must revert, with a fixed gas limit.
   */
  async send(ctx: Ctx, purpose: string, account: LocalAccount, to: Address, data: Hex, opts: { intentId?: Hex; expectRevertGas?: bigint; onBroadcast?: (hash: Hex) => void } = {}): Promise<any> {
    ctx.clock = await this.align();
    const fromBlock = (await this.pub.getBlockNumber()).toString();
    const attempt = this.store.insertAttempt({ jobId: ctx.jobId, purpose, intentId: opts.intentId ?? null, sender: account.address, target: to, dataHash: keccak256(data), fromBlock, at: this.iso() });
    try {
      let tx: any;
      if (opts.expectRevertGas) tx = await this.c.sendExpectingRevert(account, to, data, opts.expectRevertGas);
      else tx = await this.c.send(account, to, data, { onBroadcast: (hash: Hex) => { this.store.updateAttempt(attempt, { status: "broadcast", txHash: hash, at: this.iso() }); this.fault("after-broadcast", ctx.kind); opts.onBroadcast?.(hash); } });
      this.store.updateAttempt(attempt, { status: tx.status === "success" ? "mined-success" : "mined-revert", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), errorName: tx.error?.name ?? null, at: this.iso() });
      this.saveReceipt(ctx.jobId, tx);
      return tx;
    } catch (e) {
      const m = /transaction (0x[0-9a-f]{64}) reverted unexpectedly/i.exec(String((e as Error).message));
      if (m) {
        const r = await this.pub.getTransactionReceipt({ hash: m[1] });
        const tx = this.c.toResult(r, account.address);
        tx.error = await this.c.simulateError(account.address, to, data, r.blockNumber);
        this.store.updateAttempt(attempt, { status: "mined-revert", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), errorName: tx.error?.name ?? "reverted", at: this.iso() });
        this.saveReceipt(ctx.jobId, tx);
        throw new RailError("mined_revert", `The transaction was mined as a revert (${tx.error?.name ?? "unknown reason"}). Nothing moved; inspect the receipt before trying again.`, 409, { tx: this.txBrief(tx) });
      }
      // A revert at gas estimation: the contract refused before anything was broadcast. Name the error it gave.
      const dec = this.v.chain.decodeRevert(e);
      if (dec.name !== "UnknownRevert" && dec.name !== "UndecodedRevert") {
        this.store.updateAttempt(attempt, { status: "failed", errorName: dec.name, at: this.iso() });
        throw new RailError("preflight_reverted", `The contract refused this transaction before it was broadcast: ${dec.name}(${dec.args.map((x: unknown) => String(x)).join(", ")}). Nothing was sent.`, 409, { error: dec.name, args: ser(dec.args) });
      }
      this.store.updateAttempt(attempt, { status: "failed", errorName: publicError(e).slice(0, 120), at: this.iso() });
      throw e;
    }
  }
  private sentBatches = new Set<string>();
  /**
   * An owner transaction, taken from the approved terms. The development owner encodes and sends the one action. A
   * passkey account sends the whole approved batch as ONE QEDOwnerAccount.execute, relayed by the workspace's relayer
   * key, after the account accepted the passkey assertions in a simulation; the journal names the batch's decisive
   * (last) action, and asking for another index of the same batch returns that same transaction.
   */
  async ownerSend(ctx: Ctx, index: number, abi: unknown, decodeArgs?: (args: unknown[]) => unknown[]): Promise<any> {
    const actions = ctx.terms.actions as OwnerAction[];
    const action = actions[index];
    const batch = this.owner.kind === "passkey-account";
    const named = batch ? actions[actions.length - 1] : action;
    let tx: any;
    try {
      ({ tx } = await this.owner.sendAction(ctx.terms, index, ctx.approval, ctx.window, abi as never, { send: (account, to, data) => this.send(ctx, `owner:${named.contract}.${named.function}`, account, to, data) }, decodeArgs));
    } catch (e) {
      if (e instanceof OwnerAuthorityError) throw new RailError(e.code, e.message, e.http, e.details);
      throw e;
    }
    if (batch && this.sentBatches.has(tx.hash)) return tx;
    if (batch) this.sentBatches.add(tx.hash);
    const execute = batch ? (ctx.terms.toSign as ToSign[]).find((t) => t.kind === "execute") : undefined;
    this.store.appendDecision({ at: this.iso(), kind: `owner-${ctx.kind}`, jobId: ctx.jobId, verdict: "SENT", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: batch ? { account: this.owner.address, actions, execute: execute ? { nonce: execute.nonce, deadline: execute.deadline, digest: execute.digest } : null, relayer: this.relayer?.address ?? null, tx: this.txBrief(tx) } : { action, tx: this.txBrief(tx) } });
    return tx;
  }
  /** How the owner's authority was exercised, in words, for job steps. */
  ownerWords(what: string): string {
    return this.owner.kind === "passkey-account" ? `The owner's passkey signed ${what} as one batch for the owner account (QEDOwnerAccount.execute), checked on chain; the rail relays it and pays its gas, and holds no key that could sign it.` : `The rail's development owner key sends ${what} and nothing else.`;
  }
  get reserveName() { return this.isBaseline ? "euro reserve" : CHAIN_TOKENS[this.currencies.reserve].reserveWords; }
  record(ctx: Ctx | null, e: { kind: string; title: string; outcome: OpResult["outcome"]; tx?: TxBrief; trade?: unknown }) {
    this.store.appendHistory({ at: this.iso(), kind: e.kind, title: e.title, outcome: e.outcome, tx: e.tx, trade: e.trade, jobId: ctx?.jobId ?? null });
  }

  // ───────────────────────────── provision ─────────────────────────────
  private async proposeProvision(_p: Record<string, unknown>) {
    if (this.provisioned) throw new RailError("already_provisioned", "The contracts are already wired.", 409);
    if (this.owner.kind === "passkey-account") return this.proposeAcceptance();
    const E = this.venueDefs;
    const actions: OwnerAction[] = [
      { to: this.a.vault, contract: "QEDVault (treasury)", function: "setAgent", args: [this.a.exec] },
      { to: this.a.exec, contract: "QEDExecution", function: "setVenues", args: [this.a.pools, E.map((x: any) => x.feeBps)] },
    ];
    const s = await this.snap(this.a.vault);
    const terms = {
      kind: "provision", chainId: CHAIN_ID, genesisId: this.genesisId, release: RELEASE_ID,
      owner: this.owner.address, operator: this.K.OPERATOR.address, cosigner: s.cosigner, guardian: s.guardian,
      contracts: { treasuryVault: this.a.vault, reserveVault: this.a.reserve, execution: this.a.exec, lens: this.a.lens, tUSD: this.a.usd, tEUR: this.a.eur, tETH: this.a.eth, ...(this.isBaseline ? {} : { asset: this.a.asset, ownerAccount: this.a.ownerAccount }) },
      treasuryDailyCap: s.dailyCap.toString(), reserveDailyCap: "0",
      venues: E.map((x: any, i: number) => ({ label: x.label, pool: this.a.pools[i], feeBps: x.feeBps })),
      actions,
    };
    return { terms, summary: "Wire the deployed contracts: make QEDExecution the treasury vault's agent and name the five venues it may trade on.", allowed: true, checks: [], replaces: ["provision"] as ProposalKind[] };
  }
  private async runProvision(ctx: Ctx): Promise<OpResult> {
    if (this.owner.kind === "passkey-account") return this.runAcceptance(ctx);
    const A = this.v.abi;
    ctx.push({ key: "owner", label: "Owner approves the provisioning terms", status: "ok", detail: `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms: ${ctx.proposal!.termsHash}. ${this.ownerWords("two transactions")}`, data: { termsHash: ctx.proposal!.termsHash } });
    let last: any = null;
    if (getAddress((await this.read(this.a.vault, A.QEDVaultAbi, "agent")) as Address) !== this.a.exec) {
      last = await this.ownerSend(ctx, 0, A.QEDVaultAbi);
      ctx.push({ key: "receipt", label: "QEDVault.setAgent mined", status: "ok", detail: `QEDExecution is now the treasury vault's agent (block ${last.blockNumber}).`, data: this.txData(last) });
    } else ctx.push({ key: "receipt", label: "QEDVault.setAgent already done", status: "info", detail: "The vault's agent is already the execution module; not sent again." });
    const venueHash = (await this.read(this.a.exec, A.QEDExecutionAbi, "venueSetHash")) as Hex;
    if (/^0x0+$/.test(venueHash)) {
      last = await this.ownerSend(ctx, 1, A.QEDExecutionAbi);
      ctx.push({ key: "receipt", label: "QEDExecution.setVenues mined", status: "ok", detail: `Five owner-approved venues named (block ${last.blockNumber}).`, data: this.txData(last) });
    } else ctx.push({ key: "receipt", label: "QEDExecution.setVenues already done", status: "info", detail: "The venue set is already named; not sent again." });
    this.store.setMeta("provisioned", true);
    const summary = "Contracts wired by the owner: QEDExecution is the treasury vault's agent; five venues named. No mandate is signed yet.";
    this.record(ctx, { kind: "provision", title: summary, outcome: "executed", tx: last ? this.txBrief(last) : undefined });
    return { outcome: "executed", summary, tx: last ? this.txBrief(last) : undefined };
  }

  /**
   * A passkey workspace's first approval (D-B as amended): the owner accepts ownership of a vault set that the
   * workspace's deployer key configured while it held nothing. The terms show that configuration, read from the chain.
   */
  private async proposeAcceptance() {
    const A = this.v.abi, s = await this.snap(this.a.vault);
    const named = await this.v.trader.readVenues(this.pub, this.a.exec);
    const actions: OwnerAction[] = [
      { to: this.a.vault, contract: "QEDVault (treasury)", function: "acceptOwnership", args: [] },
      { to: this.a.reserve, contract: `QEDVault (${this.reserveName})`, function: "acceptOwnership", args: [] },
    ];
    const pending = await Promise.all([this.a.vault, this.a.reserve].map(async (v) => getAddress((await this.read(v, A.QEDVaultAbi, "pendingOwner")) as Address)));
    const terms = {
      kind: "provision", chainId: CHAIN_ID, genesisId: this.genesisId, release: RELEASE_ID, workspace: this.id, ownerAccount: this.owner.address,
      configuration: {
        treasuryVault: this.a.vault, reserveVault: this.a.reserve, execution: this.a.exec, treasuryPolicy: this.a.treasuryPolicy, lens: this.a.lens,
        asset: this.a.asset, reserveAsset: this.a.reserveAsset, agent: getAddress(s.agent), operator: this.K.OPERATOR.address, cosigner: getAddress(s.cosigner), guardian: getAddress(s.guardian),
        treasuryDailyCap: BigInt(s.dailyCap).toString(), venues: named.map((x: any) => ({ label: this.venueLabel(x.pool), pool: x.pool, feeBps: x.feeBps })),
        pendingOwner: pending, guards: this.summary.guards,
      },
      grantAfterAcceptance: { token: this.asset.symbol, vault: this.summary.grant?.vault ?? null, note: `The opening grant of valueless test ${this.asset.symbol} is minted only after the owner account owns both vaults.` },
      // S5: a set other than the default is named here too, with the digest the owner's passkeys signed at setup
      ...(this.defaultSet ? {} : { currencies: { ...this.currencies, digest: this.summary.currencies?.digest ?? null, tokens: [this.asset.symbol, this.reserveAsset.symbol, this.summary.routeAsset?.symbol ?? null] } }),
      actions,
    };
    return { terms, summary: `Accept ownership of this workspace's vault set, configured as shown: QEDExecution is the treasury vault's agent, ${named.length} venues are named, the daily cap is ${this.fmt(BigInt(s.dailyCap))} ${this.asset.symbol}.${this.defaultSet ? "" : ` The vaults hold test ${this.asset.symbol} and test ${this.reserveAsset.symbol}, the currency set you signed at setup; valueless test tokens, not money.`} Only after this acceptance does the opening grant of test ${this.asset.symbol} arrive.`, allowed: pending.every((x) => x === this.owner.address), checks: [], replaces: ["provision"] as ProposalKind[] };
  }
  private async runAcceptance(ctx: Ctx): Promise<OpResult> {
    const A = this.v.abi, me = this.owner.address;
    ctx.push({ key: "owner", label: "Owner accepts the vault set", status: "ok", detail: `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms: ${ctx.proposal!.termsHash}. ${this.ownerWords("acceptOwnership on both vaults")}`, data: { termsHash: ctx.proposal!.termsHash } });
    const owners = async () => Promise.all([this.a.vault, this.a.reserve].map(async (v) => getAddress((await this.read(v, A.QEDVaultAbi, "owner")) as Address)));
    let tx: any = null;
    if ((await owners()).some((o) => o !== me)) {
      tx = await this.ownerSend(ctx, 0, A.QEDVaultAbi);
      ctx.push({ key: "receipt", label: "QEDVault.acceptOwnership mined (both vaults)", status: "ok", detail: `The owner account owns both vaults from block ${tx.blockNumber}, and through them the execution module and the treasury policy. The deployer key that configured them has no role left.`, data: this.txData(tx) });
    } else ctx.push({ key: "receipt", label: "Ownership already accepted", status: "info", detail: "Both vaults are already owned by the owner account; not sent again." });
    if ((await owners()).some((o) => o !== me)) throw new RailError("ownership_not_accepted", "The vaults are not owned by the owner account after the acceptance. Nothing was granted.", 409);
    const grant = await this.host.grant(this);
    const T = this.asset.symbol, many = CHAIN_TOKENS[this.currencies.treasury].many;
    ctx.push({ key: "grant", label: `Opening grant of test ${T}`, status: "ok", detail: `After the acceptance, the test faucet minted ${this.fmt(BigInt(grant.vault))} ${T} into the treasury vault and ${this.fmt(BigInt(grant.ownerAccount))} ${T} into the owner account (valueless ${many}, not money).`, data: grant });
    this.store.setMeta("provisioned", true);
    this.summary.status = "ready";
    this.store.appendDecision({ at: this.iso(), kind: "faucet-grant", jobId: ctx.jobId, verdict: "GRANTED", clock: ctx.clock ?? (await this.clock()), record: grant });
    const summary = `The owner account accepted ownership of the treasury and reserve vaults; the opening grant of ${this.fmt(BigInt(grant.vault))} test ${T} arrived in the vault. No mandate is signed yet.`;
    this.record(ctx, { kind: "provision", title: summary, outcome: "executed", tx: tx ? this.txBrief(tx) : undefined });
    return { outcome: "executed", summary, tx: tx ? this.txBrief(tx) : undefined, evidence: { owner: me, grant } };
  }

  // ───────────────────────────── changes scheduled behind the owner account's delay ─────────────────────────────
  /** What to do when a scheduled change is applied, by the kind of proposal that scheduled it. Returns a sentence for the record. */
  readonly applyHooks = new Map<string, (ctx: Ctx, data: any) => Promise<string>>();
  /** The schedule of an approved passkey batch, when some of its actions are guarded calls. */
  scheduleOf(terms: Record<string, unknown>): NonNullable<Extract<ToSign, { kind: "execute" }>["schedule"]> | null {
    const e = (terms.toSign as ToSign[] | undefined)?.find((t) => t.kind === "execute") as Extract<ToSign, { kind: "execute" }> | undefined;
    return e?.schedule ?? null;
  }
  isScheduled = (terms: Record<string, unknown>, index: number) => this.scheduleOf(terms)?.actions.includes(index) ?? false;
  /** After the batch ran: records the change it scheduled, from the account's own event, and says so in the job. */
  async recordScheduled(ctx: Ctx, tx: any, hook: { kind: string; summary: string; data?: Record<string, unknown> }): Promise<{ changeId: Hex; readyAt: number }> {
    const sch = this.scheduleOf(ctx.terms)!;
    const found = await (this.owner as PasskeyAccountOwner).scheduledIn(tx.hash);
    if (!found) throw new RailError("schedule_not_found", `Transaction ${tx.hash} did not schedule the change. Inspect its receipt.`, 409);
    this.store.insertScheduled({ changeId: found.changeId, kind: hook.kind, summary: hook.summary, calls: sch.calls, readyAt: found.readyAt, hook: { kind: hook.kind, data: hook.data ?? {} }, proposalId: ctx.proposal!.id, jobId: ctx.jobId, at: this.iso() });
    this.store.appendDecision({ at: this.iso(), kind: "owner-scheduled", jobId: ctx.jobId, verdict: "SCHEDULED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { changeId: found.changeId, readyAt: found.readyAt, calls: sch.calls, kind: hook.kind } });
    ctx.push({ key: "scheduled", label: "Scheduled behind the owner account's delay", status: "info", detail: `${hook.summary}: the owner account accepted it but runs it only from ${new Date(found.readyAt * 1000).toISOString()} (a delay of ${sch.delaySeconds} s). Until then any one member can cancel it with a passkey (proposal kind cancel-change); after it, anyone may apply it (POST /workspaces/${this.id}/scheduled/${found.changeId}/apply). Nothing changed yet.`, data: { changeId: found.changeId, readyAt: found.readyAt, calls: sch.calls } });
    return found;
  }
  scheduledOutcome(ctx: Ctx, tx: any, summary: string, sch: { changeId: Hex; readyAt: number }): OpResult {
    const s = `${summary} Scheduled: it takes effect from ${new Date(sch.readyAt * 1000).toISOString()}, after the owner account's delay; any member can cancel it until then.`;
    this.record(ctx, { kind: "scheduled", title: s, outcome: "scheduled", tx: this.txBrief(tx) });
    return { outcome: "scheduled", summary: s, tx: this.txBrief(tx), evidence: { changeId: sch.changeId, readyAt: sch.readyAt } };
  }
  async scheduled(): Promise<ScheduledChange[]> {
    this.requireReady();
    const now = await this.chainNow();
    return this.store.scheduledAll().map((r) => ({ changeId: r.change_id as Hex, kind: r.kind as string, summary: r.summary as string, status: r.status as ScheduledChange["status"], calls: parse<ScheduledChange["calls"]>(r.calls) ?? [], readyAt: Number(r.ready_at), readyTime: new Date(Number(r.ready_at) * 1000).toISOString(), ready: r.status === "pending" && now >= BigInt(r.ready_at as number), proposalId: r.proposal_id as string, jobId: r.job_id as string, appliedJobId: (r.applied_job as string) ?? null, cancelledJobId: (r.cancelled_job as string) ?? null, createdAt: r.created_at as string }));
  }
  private pendingChange(id: unknown): Row {
    if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new RailError("invalid_params", "A scheduled change is named by its changeId: 0x followed by 64 hexadecimal characters.", 422);
    const r = this.store.scheduled(id.toLowerCase()) ?? this.store.scheduled(id);
    if (!r) throw new RailError("unknown_change", "This workspace has no such scheduled change.", 404);
    return r;
  }
  applyParams = (id: unknown) => ({ changeId: this.pendingChange(id).change_id as string });
  /** Scheduled kinds that are changes of the account itself (applyChange), and recoveries (finishRecovery); the rest are guarded batches (applyCalls). */
  static readonly ACCOUNT_CHANGES = new Set(["remove-signers", "set-thresholds", "set-guardian", "set-time-lock"]);
  /** Does the owner account still hold this change or recovery as pending? */
  async heldOnChain(kind: string, id: Hex): Promise<boolean> {
    const o = this.owner as PasskeyAccountOwner;
    return kind === "recovery" ? (await o.recovery(id)).readyAt !== 0 : (await o.change(id)).readyAt !== 0;
  }
  private async proposeCancelChange(p: Record<string, unknown>) {
    if (this.owner.kind !== "passkey-account") throw new RailError("unsupported_proposal", "Only a passkey owner account schedules and cancels changes.", 422);
    if (Object.keys(p).length !== 1) throw new RailError("invalid_params", "cancel-change takes { changeId }.", 422);
    const r = this.pendingChange(p.changeId);
    if (r.status !== "pending") throw new RailError("change_not_pending", `This change is ${r.status}; there is nothing to cancel.`, 409);
    // a removal names the keys it removes: none of them can sign its cancellation (the account refuses CannotCancelOwnRemoval)
    const hook = parse<{ data?: { keys?: { signerId: string; x: string; y: string }[] } }>(r.hook);
    const targets = r.kind === "remove-signers" ? (hook?.data?.keys ?? []).map((k) => ({ signerId: k.signerId, x: k.x, y: k.y })) : [];
    const terms = { kind: "cancel-change", chainId: CHAIN_ID, genesisId: this.genesisId, account: this.owner.address, cancel: { changeId: r.change_id }, change: { kind: r.kind, summary: r.summary, calls: parse(r.calls), readyAt: Number(r.ready_at), ...(targets.length ? { targets } : {}) }, effect: targets.length ? "The owner account drops the scheduled removal. One member's passkey is enough, but not one of the passkeys it removes." : "The owner account drops the scheduled change: none of its calls will ever run. One member's passkey is enough." };
    return { terms, summary: `Cancel the scheduled change: ${r.summary}.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  }
  private async runCancelChange(ctx: Ctx): Promise<OpResult> {
    const id = ctx.terms.cancel.changeId as Hex;
    const r = this.store.scheduled(id)!;
    if (r.status !== "pending") { const summary = `The change was already ${r.status}: nothing to cancel.`; this.record(ctx, { kind: "cancel-change", title: summary, outcome: "no-action" }); return { outcome: "no-action", summary }; }
    if (!(await this.heldOnChain(r.kind as string, id))) {
      this.store.finishScheduled(id, "cancelled", ctx.jobId, this.iso());
      const summary = "The owner account no longer holds this change; it is recorded as cancelled. Nothing was sent.";
      this.record(ctx, { kind: "cancel-change", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary };
    }
    let tx: any;
    try { ({ tx } = await (this.owner as PasskeyAccountOwner).sendCancel(ctx.terms, ctx.approval, ctx.window, { send: (account, to, data) => this.send(ctx, "owner:QEDOwnerAccount.cancel", account, to, data) })); }
    catch (e) { if (e instanceof OwnerAuthorityError) throw new RailError(e.code, e.message, e.http, e.details); throw e; }
    this.store.finishScheduled(id, "cancelled", ctx.jobId, this.iso());
    this.store.appendDecision({ at: this.iso(), kind: "owner-cancel-change", jobId: ctx.jobId, verdict: "CANCELLED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { changeId: id, tx: this.txBrief(tx) } });
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.cancel mined", status: "ok", detail: `The scheduled change is dropped in block ${tx.blockNumber}; none of its calls will run.`, data: this.txData(tx) });
    const summary = `Cancelled the scheduled change: ${r.summary}.`;
    this.record(ctx, { kind: "cancel-change", title: summary, outcome: "executed", tx: this.txBrief(tx) });
    return { outcome: "executed", summary, tx: this.txBrief(tx), evidence: { changeId: id } };
  }
  private async runApplyChange(ctx: Ctx): Promise<OpResult> {
    const id = ctx.request.changeId as Hex;
    const r = this.store.scheduled(id)!;
    if (r.status !== "pending") { const summary = `The change was already ${r.status}: nothing to apply.`; this.record(ctx, { kind: "apply-change", title: summary, outcome: "no-action" }); return { outcome: "no-action", summary }; }
    const hook = parse<{ kind: string; data: any }>(r.hook)!;
    const kind = r.kind as string;
    let tx: any = null;
    if (await this.heldOnChain(kind, id)) {
      if ((await this.chainNow()) < BigInt(r.ready_at as number)) {
        const summary = `This change can be applied from ${new Date(Number(r.ready_at) * 1000).toISOString()}, after the owner account's delay; not yet. Nothing was sent.`;
        ctx.push({ key: "change", label: "Not ready yet", status: "refused", detail: summary });
        this.record(ctx, { kind: "apply-change", title: summary, outcome: "refused" });
        return { outcome: "refused", summary };
      }
      ctx.clock = await this.align(); // the next block carries the rail's clock, which the simulation must see
      const o = this.owner as PasskeyAccountOwner;
      const fn = kind === "recovery" ? "finishRecovery" : RailService.ACCOUNT_CHANGES.has(kind) ? "applyChange" : "applyCalls";
      const via = { send: (account: LocalAccount, to: Address, data: Hex) => this.send(ctx, `apply:QEDOwnerAccount.${fn}`, account, to, data) };
      try { tx = fn === "finishRecovery" ? await o.sendFinishRecovery(id, via) : fn === "applyChange" ? await o.sendApplyChange(id, via) : await o.sendApply(id, parse(r.calls) as never, via); }
      catch (e) { if (e instanceof OwnerAuthorityError) throw new RailError(e.code, e.message, e.http, e.details); throw e; }
      ctx.push({ key: "receipt", label: `QEDOwnerAccount.${fn} mined`, status: "ok", detail: `The delay has passed: ${fn === "applyCalls" ? "the scheduled calls ran" : fn === "applyChange" ? "the account applied the change to itself" : "the recovery finished and the new passkey is a member"} in block ${tx.blockNumber}. Anyone may apply a change once it is due; the rail's relayer did.`, data: this.txData(tx) });
    } else ctx.push({ key: "receipt", label: "Already applied on chain", status: "info", detail: "The owner account no longer holds it as pending; not sent again." });
    const said = await (this.applyHooks.get(hook.kind) ?? (async () => ""))(ctx, hook.data);
    this.store.finishScheduled(id, "applied", ctx.jobId, this.iso());
    this.store.appendDecision({ at: this.iso(), kind: "owner-apply-change", jobId: ctx.jobId, verdict: "APPLIED", clock: ctx.clock ?? (await this.clock()), record: { changeId: id, kind: hook.kind, tx: tx ? this.txBrief(tx) : null } });
    const summary = `Applied the scheduled change: ${r.summary}.${said ? ` ${said}` : ""}`;
    this.record(ctx, { kind: "apply-change", title: summary, outcome: "executed", tx: tx ? this.txBrief(tx) : undefined });
    return { outcome: "executed", summary, tx: tx ? this.txBrief(tx) : undefined, evidence: { changeId: id, kind: hook.kind } };
  }

  // ───────────────────────────── mandate ─────────────────────────────
  private async proposeMandate(p: Record<string, unknown>) {
    const allowed = ["maxPerPayment", "maxPerPeriod", "maxTotal", "validDays"];
    if (Object.keys(p).some((k) => !allowed.includes(k))) throw new RailError("invalid_params", "Mandate parameters: maxPerPayment (required), and optionally maxPerPeriod, maxTotal, validDays.", 422);
    const perPayment = this.raw(p.maxPerPayment, "Per-conversion limit");
    const s = await this.snap(this.a.vault);
    const one = 10n ** BigInt(this.asset.decimals), cap = BigInt(s.dailyCap), S = this.asset.symbol;
    if (perPayment < one || perPayment > cap) throw new RailError("invalid_params", `The owner may sign a per-conversion limit between 1 and ${this.whole(cap)} ${S} (the vault's on-chain daily cap is ${this.whole(cap)}).`, 422);
    const perPeriod = p.maxPerPeriod === undefined ? cap : this.raw(p.maxPerPeriod, "Per-day limit");
    const total = p.maxTotal === undefined ? 2n * cap : this.raw(p.maxTotal, "Lifetime limit");
    const days = p.validDays === undefined ? 7 : Number(p.validDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new RailError("invalid_params", "validDays must be a whole number from 1 to 30.", 422);
    if (perPeriod < perPayment || perPeriod > 10n * cap || total < perPeriod || total > 1000n * cap) throw new RailError("invalid_params", `Limits must satisfy: per conversion ≤ per day ≤ ${this.whole(10n * cap)} ${S}, and per day ≤ lifetime ≤ ${this.whole(1000n * cap)} ${S}.`, 422);
    const now = await this.chainNow();
    const prev = this.activeMandate();
    const version = this.store.lastMandateVersion() + 1;
    const mandate: MandateFields = {
      vault: this.a.vault, agent: this.a.exec, payees: [this.a.exec, this.a.reserve, this.K.CLOUDCO.address],
      maxPerPayment: perPayment.toString(), maxPerPeriod: perPeriod.toString(), period: "86400", maxTotal: total.toString(),
      validFrom: (now - 60n).toString(), validUntil: (now + BigInt(days) * 86_400n).toString(), epoch: BigInt(s.epoch).toString(), requireCosign: true,
      purpose: keccak256(toHex(this.mandatePurpose)), salt: keccak256(toHex(`qed-rail-mandate-${this.genesisId}-${this.isBaseline ? "" : `${this.id}-`}${version}`)),
    };
    const mandateHash = this.v.eip712.mandateHash(this.toMandate(mandate) as never);
    const actions: OwnerAction[] = prev ? [{ to: this.a.vault, contract: "QEDVault (treasury)", function: "revokeMandate", args: [prev.hash] }] : [];
    const terms = { kind: "mandate", chainId: CHAIN_ID, genesisId: this.genesisId, version, mandate, mandateHash, payeeLabels: this.payeeLabels, purposeText: this.mandatePurpose, supersedes: prev ? { version: prev.version, hash: prev.hash } : null, actions };
    const was = prev ? ` (was ${this.fmt(prev.mandate.maxPerPayment)})` : "";
    return { terms, summary: `Mandate v${version}: ≤ ${this.fmt(perPayment)} ${S} per conversion${was}, ≤ ${this.fmt(perPeriod)} a day, ≤ ${this.fmt(total)} in total, valid ${days} days, co-signature required${prev ? `; revokes mandate v${prev.version} on-chain` : ""}.`, allowed: true, checks: [], replaces: ["mandate"] as ProposalKind[] };
  }
  private async runMandate(ctx: Ctx): Promise<OpResult> {
    const t = ctx.terms;
    const A = this.v.abi;
    const existing = this.store.mandateByHash(t.mandateHash);
    const current = this.activeMandate();
    if (!existing && (t.version !== this.store.lastMandateVersion() + 1 || (t.supersedes?.hash ?? null) !== (current?.hash ?? null))) {
      throw new RailError("mandate_changed", "Another mandate was signed or ended after these terms were prepared. Nothing was signed; prepare the mandate again.", 409);
    }
    let revokeTx: any = null;
    if (t.supersedes) {
      const [, , , revoked] = (await this.read(this.a.vault, A.QEDVaultAbi, "mandateState", [t.supersedes.hash])) as [bigint, bigint, bigint, boolean];
      if (!revoked) {
        revokeTx = await this.ownerSend(ctx, 0, A.QEDVaultAbi);
        ctx.push({ key: "revoke", label: `Mandate v${t.supersedes.version} revoked on-chain`, status: "ok", detail: `QEDVault.revokeMandate mined in block ${revokeTx.blockNumber}. The vault now rejects the previous mandate (MandateIsRevoked), whoever holds the hot keys.`, data: this.txData(revokeTx) });
      } else ctx.push({ key: "revoke", label: `Mandate v${t.supersedes.version} already revoked on-chain`, status: "info", detail: "Not sent again." });
    }
    const { signature } = await this.owner.signMandate(t, ctx.approval, ctx.window, this.v.eip712.signMandate as never, this.toMandate);
    if (!existing) {
      this.store.tx(() => {
        if (t.supersedes) this.store.endMandate(t.supersedes.version, "superseded", this.iso(), revokeTx?.hash ?? null);
        this.store.insertMandate({ version: t.version, hash: t.mandateHash, mandate: t.mandate, ownerSig: signature, signedAt: this.iso(), approvalId: ctx.approval!.approvalId, purposeText: t.purposeText });
      });
      this.store.appendDecision({ at: this.iso(), kind: "owner-mandate", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await this.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { version: t.version, mandateHash: t.mandateHash, mandate: t.mandate, supersedes: t.supersedes, revokeTx: revokeTx ? this.txBrief(revokeTx) : null } });
    }
    ctx.push({ key: "owner", label: "Owner signs mandate (EIP-712)", status: "ok", detail: this.owner.kind === "passkey-account" ? `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these thirteen fields. Signed by the owner's passkey for the owner account ${this.owner.address.slice(0, 10)}… (ERC-1271, accepted by the account on chain before it was stored); the rail holds no key that could sign it. The AI can never do this.` : `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these thirteen fields. Signed with the rail's development owner key ${this.owner.address.slice(0, 10)}…; in production the owner signs in their own wallet. The AI can never do this.`, data: { mandateHash: t.mandateHash, version: t.version, termsHash: ctx.proposal!.termsHash } });
    const was = t.supersedes ? ` (was ${this.fmt(parse<MandateFields>(this.store.mandateByHash(t.supersedes.hash)?.mandate)?.maxPerPayment ?? "0")})` : "";
    const title = `Owner signed mandate v${t.version}: ≤ ${this.fmt(t.mandate.maxPerPayment)} ${this.asset.symbol} per conversion${was}, ≤ ${this.fmt(t.mandate.maxPerPeriod)} a day, payees unchanged${t.supersedes ? `; v${t.supersedes.version} revoked on-chain` : ""}`;
    this.record(ctx, { kind: "mandate", title, outcome: "executed", tx: revokeTx ? this.txBrief(revokeTx) : undefined });
    return { outcome: "executed", summary: title, tx: revokeTx ? this.txBrief(revokeTx) : undefined, evidence: { mandateHash: t.mandateHash, version: t.version, signedOffChain: true } };
  }

  // ───────────────────────────── conversion: the eight steps ─────────────────────────────
  nextNonce = () => `rail-${this.genesisId!.slice(0, 8)}-${this.isBaseline ? "" : `${this.id}-`}${this.store.next("nonce")}`;
  private conversionTerms(amountIn: bigint, humanAmount: string, am: NonNullable<ReturnType<RailService["activeMandate"]>>, extra: Record<string, unknown> = {}) {
    const nonce = this.nextNonce();
    return {
      chainId: CHAIN_ID, genesisId: this.genesisId, vault: this.a.vault, tokenIn: this.a.asset, tokenOut: this.a.reserveAsset, recipient: this.a.reserve,
      amount: humanAmount, amountIn: amountIn.toString(), nonce, instruction: this.isBaseline ? `Convert ${humanAmount} tUSD to tEUR` : `Convert ${humanAmount} ${this.asset.symbol} into the ${this.reserveName} (${this.reserveAsset.symbol})`,
      message: this.v.cosigner.ownerTradeMessage(this.a.vault, amountIn, this.a.asset!, this.a.reserveAsset!, this.a.reserve, nonce),
      mandateVersion: am.version, mandateHash: am.hash, ...extra,
    };
  }
  private async proposeConvert(p: Record<string, unknown>) {
    const input = this.validateTool("convert", p);
    const amountIn = this.raw(input.amount);
    const am = this.activeMandate();
    if (!am) throw new RailError("no_mandate", "No active mandate: the owner must sign one before a conversion can be proposed.", 409);
    await this.requireDirectPath();
    const lim = await this.checkLimits(amountIn);
    const terms = { kind: "convert", ...this.conversionTerms(amountIn, input.amount, am) };
    return { terms, summary: `Convert ${this.fmt(amountIn)} ${this.asset.symbol} into the ${this.reserveName} (${this.reserveAsset.symbol}), under mandate v${am.version}, with the co-signer's floor and the on-chain best-execution bound.`, allowed: lim.allowed, checks: lim.checks };
  }
  /** While the policy contract is QEDExecution's operator, the hot key can trade only through it (baseline W-12). */
  async requireDirectPath() {
    const operator = getAddress((await this.read(this.a.exec, this.v.abi.QEDExecutionAbi, "operator")) as Address);
    if (operator !== this.K.OPERATOR.address) throw new RailError("policy_contract_wired", "The treasury policy contract is the execution module's operator: conversions happen only through the standing policy. End the contract-enforced policy to use direct conversions and the Security Lab again.", 409, { operator });
  }
  validateTool(name: string, input: unknown): any {
    try { return this.v.capabilities.validateCapability(name, input); } catch (e) { throw new RailError("invalid_tool_input", (e as Error).message, 422); }
  }
  async chatContext() {
    const s = await this.snap(this.a.vault);
    const book = [
      this.isBaseline ? { label: "Euro reserve", aliases: ["euro reserve", "eur reserve", "reserve", "euro", "teur", "eur"], address: this.a.reserve, approved: true }
        : this.defaultSet ? { label: "Dollar reserve", aliases: ["dollar reserve", "usd reserve", "reserve", "dollar", "tusd", "usd"], address: this.a.reserve, approved: true }
        // S5: the reserve of another currency set, by its own words
        : { label: this.reserveLabel, aliases: [this.reserveName.toLowerCase(), `${this.currencies.reserve.toLowerCase()} reserve`, "reserve", ...CHAIN_TOKENS[this.currencies.reserve].aliases], address: this.a.reserve, approved: true },
      { label: "CloudCo", aliases: ["cloudco", "cloud co"], address: this.K.CLOUDCO.address, approved: true },
    ];
    return { balance: s.balance, protectedBalance: s.protectedBalance, free: s.freeBalance, blastRadius24h: s.blastRadius24h, dailyCap: s.dailyCap, spentInWindow: s.spentInWindow, paused: s.paused, payees: book };
  }
  /** Stores the co-signer's record after checking that its hash is the one the certificate commits to (W-29). */
  keepDecision(ctx: Ctx, kind: string, r: any) {
    const rec = JSON.parse(r.record) as { core: unknown; canonical: string; evidenceHash: string; certificate: { evidenceHash: string } | null };
    const hashOk = keccak256(toHex(rec.canonical)) === r.evidenceHash && rec.evidenceHash === r.evidenceHash && (!r.approved || r.certificate?.evidenceHash === r.evidenceHash);
    if (!hashOk) throw new RailError("decision_record_mismatch", "The co-signer's decision record does not hash to the evidence hash in its certificate. Nothing was sent.", 409);
    this.store.appendDecision({ at: this.iso(), kind, jobId: ctx.jobId, verdict: r.approved ? "APPROVED" : "REFUSED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal?.termsHash ?? null, record: rec.core, evidenceHash: r.evidenceHash });
  }
  private async runConvert(ctx: Ctx): Promise<OpResult> {
    const t = ctx.terms, A = this.v.abi, T = this.v.trader, fmt = this.fmt, fmtR = this.fmtR;
    // usd and eur name the conversion's input and output: the treasury's asset and the reserve's (tUSD and tEUR in the
    // baseline, tINR and tUSD in a workspace)
    const { reserve, exec, vault } = this.a;
    const usd = this.a.asset!, eur = this.a.reserveAsset!, S = this.asset.symbol, R = this.reserveAsset.symbol;
    const scale = 10n ** BigInt(6 - this.asset.decimals);
    const refuse = (summary: string): OpResult => { this.record(ctx, { kind: "refusal", title: summary, outcome: "refused" }); return { outcome: "refused", summary }; };
    const instruction: string = t.instruction;
    const am = this.activeMandate();

    // 1 · language layer (the release's labelled offline parser and guard on the canonical instruction)
    await this.requireDirectPath();
    const numerical = this.v.amounts.scanAmount(instruction);
    if (numerical.kind === "invalid" || numerical.kind === "ambiguous") {
      ctx.push({ key: "interpret", label: "Invalid monetary amount", status: "refused", detail: "An ambiguous, malformed, or explicitly signed numeric amount cannot be used for a conversion. Nothing was signed or sent." });
      return refuse("The instruction contains an invalid or ambiguous numeric amount. Please specify one exact positive tUSD amount. No transaction was sent.");
    }
    const cc = await this.chatContext();
    const { result, transcript } = await this.brain.interpret(instruction, cc, "owner");
    const g = this.v.guard.guard(instruction, result, cc as never, am ? am.mandate.maxPerPayment * scale : 0n);
    const p: any = g.proposal;
    // the release's lexer reads micro-units; an amount of a 2-decimal asset is a whole number of its own units
    const explicit = numerical.kind === "valid" && numerical.raw % scale === 0n ? numerical.raw / scale : undefined;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reserveWords = this.isBaseline ? /\b(t?eur|euros?|reserve)\b/i : this.defaultSet ? new RegExp(`\\b(reserve|dollars?|usd|${R})\\b`, "i") : new RegExp(`\\b(reserve|${[...CHAIN_TOKENS[this.currencies.reserve].aliases, R].map(esc).join("|")})\\b`, "i");
    const toReserve = (p && p.kind === "pay" && p.payee && getAddress(p.payee) === reserve) || (explicit !== undefined && /\b(convert|move|swap|exchange|top ?up|put)\b/i.test(instruction) && reserveWords.test(instruction));
    const amountIn: bigint | undefined = explicit ?? (p && p.kind === "pay" && BigInt(p.amount) % scale === 0n ? BigInt(p.amount) / scale : undefined);
    const dangerous = (g.flags || []).filter((f: string) => ["privilege_escalation", "data_extraction", "prompt_injection", "induced_transfer"].includes(f));
    const sameAsApproved = amountIn !== undefined && amountIn === BigInt(t.amountIn);
    const isConversion = !!toReserve && !!amountIn && amountIn > 0n && dangerous.length === 0 && sameAsApproved;
    ctx.push({ key: "interpret", label: "AI interprets the instruction", status: isConversion ? "ok" : "refused", detail: isConversion ? `${transcript.engine} reads: convert ${fmt(amountIn!)} ${S} into the ${this.reserveName} (an approved payee from the owner's book). It proposes; it cannot sign.` : `${transcript.engine} did not produce an acceptable conversion into the ${this.reserveName}${dangerous.length ? ` (flagged: ${dangerous.join(", ")})` : ""}${amountIn !== undefined && !sameAsApproved ? " (the amount read differs from the approved terms)" : ""}: ${g.reply}`, data: { engine: transcript.engine, intent: g.intent, flags: g.flags, proposedBy: ctx.request?.proposedBy ?? null } });
    if (!isConversion) return refuse(`No conversion: ${g.reply}`);

    // 2 · signed limits
    const lim = await this.checkLimits(amountIn!);
    const mandateOk = lim.allowed && !!am && am.hash === t.mandateHash;
    ctx.push({ key: "mandate", label: "Signed mandate and vault limits", status: mandateOk ? "ok" : "refused", detail: mandateOk ? `Within the owner's mandate v${am!.version}: ≤ ${fmt(am!.mandate.maxPerPayment)} ${S} per conversion, the mandate's period and lifetime totals, today's vault window and the free balance.` : !lim.allowed ? lim.checks.filter((c) => !c.pass).map((c) => `${c.rule}${c.remaining !== null ? `: ${fmt(amountIn!)} > ${fmt(c.remaining)} ${S}` : c.detail ? `: ${c.detail}` : ""}`).join("; ") + ". The AI cannot raise a limit; only the owner can sign a new mandate." : "The mandate changed after these terms were prepared. Prepare the conversion again under the current mandate.", data: { checks: lim.checks } });
    if (!mandateOk) return refuse(`Refused before signing: ${fmt(amountIn!)} ${S} breaks the signed limits. No transaction was sent.`);

    // 3 · owner confirms this exact conversion
    ctx.clock = await this.align();
    const { signature: instructionSig } = await this.owner.signMessage(t, ctx.approval, ctx.window);
    ctx.push({ key: "owner", label: "Owner confirms the exact conversion", status: "ok", detail: this.owner.kind === "passkey-account" ? `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The owner's passkey signed “${fmt(amountIn!)} ${S} → ${R} into the ${this.reserveName}” for the owner account (ERC-1271 over the EIP-191 text, nonce ${t.nonce}), accepted by the account on chain.` : `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The rail's development owner key signs “${fmt(amountIn!)} tUSD → tEUR into the euro reserve” (EIP-191, nonce ${t.nonce}).`, data: { signer: this.owner.address, termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });

    // 4 · independent co-signer
    const r = await this.cosigner.evaluateTrade({ mandate: am!.mandate, ownerSig: am!.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn: amountIn!, instruction, nonce: t.nonce, instructionSig, brainEngine: transcript.engine });
    this.keepDecision(ctx, "cosigner-trade", r);
    ctx.push({ key: "cosigner", label: "Independent co-signer re-derives and signs", status: r.approved ? "ok" : "refused", detail: r.approved ? `${r.checks.length} checks passed. Its own optimal quote: ${fmtR(r.quote!.amountOut)} ${R}. It signs an order with floor ${fmtR(r.order!.minOut)} ${R} and tolerance τ = ${r.order!.tolerancePpm} ppm; the route is left to the agent.` : `Refused: ${notMet(r.reasons)}`, data: ser({ checks: r.checks, reasons: r.reasons, floor: r.order?.minOut, quote: r.quote?.amountOut, tolerancePpm: r.order?.tolerancePpm, orderHash: r.order ? T.hashOrder(r.order) : null, evidenceHash: r.evidenceHash, isolation: this.cosigner.isolation, engine: r.engine ?? "release" }) });
    if (!r.approved) return refuse(`The co-signer refused: ${notMet(r.reasons)}. No transaction was sent.`);

    // 4b · the executable quote, kept apart from the indicative one and from the fill (rail/quote-kinds.ts). Its certificate's window is
    // enforced by the vault contract; the rail checks it before it sends, against the later of its own clock and the chain's, so an
    // expired quote is shown as expired and nothing is broadcast.
    const executable = executableQuote(r.certificate!, r.order!);
    const verdict = expiryVerdict(executable, Math.floor(this.now() / 1000), Number((await this.pub.getBlock()).timestamp));
    ctx.push({ key: "executable", label: "Executable quote", status: verdict.state === "valid" ? "ok" : "refused", detail: verdict.state === "valid" ? `Floor ${fmtR(r.order!.minOut)} ${R}, valid until ${new Date(executable.expiresAt * 1000).toISOString()}. The wallet's contract refuses the certificate outside that window.` : verdict.state === "expired" ? expiredText(verdict) : `The executable quote is not valid before ${verdict.at}. Nothing was sent.`, data: ser(executable) });
    if (verdict.state === "expired") return refuse(expiredText(verdict));
    if (verdict.state === "not-yet") return refuse(`The executable quote is not valid before ${verdict.at}. Nothing was sent.`);

    // 5 · route and proof
    const tp = await T.planTrade(this.pub, exec, usd, eur, amountIn!);
    const d = T.decide(tp, r.order!);
    ctx.push({ key: "plan", label: "Agent routes and builds the proof", status: d.submit ? "ok" : "refused", detail: `${tp.plan.route.filter((h: any) => h.amountIn > 0n).length} hops over ${new Set(tp.plan.route.map((h: any) => h.venue)).size} venues, expected ${fmtR(tp.plan.sim.amountOut)} ${R}. Dual prices give an upper bound of ${fmtR(tp.onchainBound)} ${R} on what any route over the five venues could return (gap ${tp.plan.gapPpm.toFixed(3)} ppm). ${d.submit ? "Pre-flighted against the contract." : d.reasons.join("; ")}`, data: this.planData(tp) as never });
    if (!d.submit) return refuse(`The agent declined to submit: ${d.reasons.join("; ")}`);

    // 6 · submit → receipt
    const before = { reserve: await this.bal(eur, reserve), vault: await this.bal(usd, vault) };
    const submitSeq = ctx.push({ key: "submit", label: "Preflight and broadcast", status: "pending", detail: "Checking gas estimation before any transaction is broadcast. No hash exists yet." });
    const data = this.v.chain.fn(A.QEDExecutionAbi, "trade", [am!.mandate, am!.ownerSig, r.certificate, r.signature, r.order, T.hopsForChain(tp.plan.route), T.pricesForChain(tp.plan.prices)]);
    const tx = await this.send(ctx, "trade", this.K.OPERATOR, exec, data, { intentId: r.certificate!.intentId, onBroadcast: (hash) => ctx.replace(submitSeq, { key: "submit", label: "Transaction broadcast", status: "ok", detail: `Broadcast acknowledged. Transaction ${hash}; awaiting mined receipt.`, data: { hash } }) });
    const be = tx.events.find((e: any) => e.name === "BestExecution")!.args as any;
    const out = BigInt(be.amountOut), bound = BigInt(be.bound);
    ctx.push({ key: "receipt", label: "Mined: the chain checked the proof", status: "ok", detail: `Status success in block ${tx.blockNumber}, ${tx.gasUsed.toLocaleString("en-US")} gas. BestExecution: ${fmt(amountIn!)} ${S} → ${fmtR(out)} ${R}, on-chain bound ${fmtR(bound)} (${ppm(out, bound).toFixed(3)} ppm below the bound; accepted only within τ = ${r.order!.tolerancePpm} ppm).`, data: this.txData(tx) });

    // 7 · reconcile
    const after = { reserve: await this.bal(eur, reserve), vault: await this.bal(usd, vault) };
    const ok = after.reserve - before.reserve === out && before.vault - after.vault === amountIn && (await this.bal(eur, exec)) === 0n && (await this.bal(usd, exec)) === 0n;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: ok ? "ok" : "refused", detail: ok ? `Treasury ${fmt(before.vault)} → ${fmt(after.vault)} ${S}; ${this.reserveName} ${fmtR(before.reserve)} → ${fmtR(after.reserve)} ${R}. The module holds nothing.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    if (!ok) {
      const summary = `Transaction ${tx.hash} mined, but balance reconciliation failed. Do not retry; inspect the receipt.`;
      this.record(ctx, { kind: "conversion", title: summary, outcome: "error", tx: this.txBrief(tx) });
      return { outcome: "error", summary, tx: this.txBrief(tx), doNotRetry: true };
    }
    const hops = tp.plan.route.filter((h: any) => h.amountIn > 0n).length, venues = [...new Set(tp.plan.route.map((h: any) => h.venue))];
    this.store.setMeta("lastTrade", ser({ at: this.iso(), instruction: `Convert ${fmt(amountIn!)} ${S} to ${R}`, amountIn, amountOut: out, bound, gapPpm: ppm(out, bound), floor: r.order!.minOut, tolerancePpm: r.order!.tolerancePpm, hash: tx.hash, block: tx.blockNumber, gasUsed: tx.gasUsed, plan: this.planData(tp), cosignerChecks: r.checks.length, engine: transcript.engine, jobId: ctx.jobId, executable, fill: { kind: "fill", amountOut: out, bound, hash: tx.hash, block: tx.blockNumber } }));
    const summary = `Converted ${fmt(amountIn!)} ${S} → ${fmtR(out)} ${R}; bound ${fmtR(bound)}; reserve now ${fmtR(after.reserve)} ${R}.`;
    this.record(ctx, { kind: "conversion", title: summary, outcome: "executed", tx: this.txBrief(tx), trade: { amountIn: amountIn!.toString(), amountOut: out.toString(), bound: bound.toString(), gapPpm: ppm(out, bound), hops, venues } });
    return { outcome: "executed", summary, tx: this.txBrief(tx), evidence: ser({ amountIn, amountOut: out, bound, gapPpm: ppm(out, bound), floor: r.order!.minOut, tolerancePpm: r.order!.tolerancePpm, evidenceHash: r.evidenceHash }) };
  }
}
